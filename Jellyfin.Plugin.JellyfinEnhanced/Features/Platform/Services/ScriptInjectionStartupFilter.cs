using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Primitives;
using Microsoft.Net.Http.Headers;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.Platform.Services
{
    /// <summary>
    /// Injects the Jellyfin Enhanced client &lt;script&gt; tag into jellyfin-web's
    /// index.html at request time, via ASP.NET middleware registered through
    /// <see cref="Microsoft.AspNetCore.Hosting.IStartupFilter"/>.
    ///
    /// Jellyfin 12 serves index.html as a plain static file with no native
    /// script-injection hook, so the plugin injects its own script by running
    /// middleware ahead of the static-file handler. This keeps script injection
    /// self-contained and works on both Jellyfin 10.11 and 12, without writing to
    /// the web folder (the legacy on-disk rewrite needs a writable web folder /
    /// root container and is wiped on every jellyfin-web update).
    ///
    /// The filter is deliberately defensive and additive:
    ///   - only ever touches the web index.html response;
    ///   - idempotent: no-ops if the script tag is already present (e.g. a legacy
    ///     on-disk rewrite already added it);
    ///   - on any error it serves the original response unchanged, never throwing
    ///     into the pipeline;
    ///   - can be disabled via the DisableScriptInjectionMiddleware config flag.
    ///
    /// Compression and validators (canopy K3a). The static handler is asked for the
    /// plain identity file (Accept-Encoding, Range and If-Range removed), so the
    /// rewrite never has to decode a compressed body. The injected page is then
    /// served by the plugin itself, as <see cref="ServedFile"/> does for the bundle:
    /// brotli or gzip by the client's Accept-Encoding, with a strong ETag per
    /// representation (a hash of the bytes sent) and Vary: Accept-Encoding. This
    /// also compresses over HTTPS, where Jellyfin's own response compression is off
    /// by default. The page holds no secret and reflects no request input, so
    /// compressing it is BREACH-safe.
    ///
    /// The injected representations are cached per request path, keyed by the
    /// source's ETag/Last-Modified and the script tag. A warm request turns the
    /// client's conditional request into a validator-only request for the source
    /// (the cached source ETag/Last-Modified), so an unchanged index.html costs the
    /// static handler a bodyless 304 and no rewrite; the client then gets a 304 or
    /// the cached bytes. A changed source answers 200 and replaces the entry. The
    /// ETag derives from the injected bytes alone, so it survives a restart and a
    /// cold cache still answers the client's If-None-Match with a 304.
    ///
    /// Memory is bounded: a source response is captured up to
    /// <see cref="MaxCaptureBytes"/> and streams through unchanged beyond that;
    /// at most <see cref="MaxCachedEntries"/> entries of at most
    /// <see cref="MaxCacheableBytes"/> (identity bytes) are kept.
    /// </summary>
    public class ScriptInjectionStartupFilter : IStartupFilter
    {
        /// <summary>Largest source body captured for rewriting; a larger one streams through un-injected.</summary>
        internal const int MaxCaptureBytes = 2 * 1024 * 1024;

        /// <summary>Largest injected page kept in the cache (jellyfin-web's index.html is about 5 KB).</summary>
        internal const int MaxCacheableBytes = 512 * 1024;

        /// <summary>Most cached entries (one per shell path spelling: /web/, /web/index.html, base-url variants).</summary>
        internal const int MaxCachedEntries = 4;

        // The page is small and rewritten once per source version: the slowest levels cost well under a millisecond.
        private static readonly ServedFile.Levels IndexLevels = new(11, 0, CompressionLevel.SmallestSize);

        private readonly Logger _logger;
        private readonly object _cacheLock = new();
        private readonly Dictionary<string, Entry> _cache = new(StringComparer.Ordinal);
        private long _sequence;
        private int _loggedOnce;
        private int _loggedOverflow;

        public ScriptInjectionStartupFilter(Logger logger)
        {
            _logger = logger;
        }

        /// <summary>One cached injected page and the source validators it was built from.</summary>
        private sealed record Entry(string ScriptTag, string SourceETag, string SourceLastModified, string CacheControl, ServedFile Page)
        {
            internal long Used { get; set; }
        }

        /// <summary>Number of cached entries; for tests.</summary>
        internal int CachedEntryCount
        {
            get { lock (_cacheLock) return _cache.Count; }
        }

        public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next)
        {
            return app =>
            {
                // Registered before the rest of the pipeline (next(app)) so this runs
                // outermost: Jellyfin's response compression runs inside it and, with
                // Accept-Encoding removed below, leaves the source body as plain text.
                app.Use(InvokeAsync);
                next(app);
            };
        }

        private async Task InvokeAsync(HttpContext context, Func<Task> nextMw)
        {
            if (!IsIndexRequest(context.Request.Path.Value))
            {
                await nextMw().ConfigureAwait(false);
                return;
            }

            // Only GET produces a body we can rewrite. HEAD/OPTIONS/etc. must pass
            // straight through so the host emits correct headers (buffering them would
            // compute a bogus Content-Length against an empty downstream body).
            if (!HttpMethods.IsGet(context.Request.Method))
            {
                await nextMw().ConfigureAwait(false);
                return;
            }

            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || config.DisableScriptInjectionMiddleware)
            {
                await nextMw().ConfigureAwait(false);
                return;
            }

            string scriptTag;
            try
            {
                // The config guard above implies the plugin instance is non-null.
                scriptTag = JellyfinEnhanced.Instance!.BuildScriptTag();
            }
            catch (Exception ex)
            {
                // Nothing has been changed yet, so the host serves its own untouched shell.
                _logger.Warning($"Script injection middleware error (serving original HTML): {ex.Message}");
                await nextMw().ConfigureAwait(false);
                return;
            }

            var path = context.Request.Path.Value ?? string.Empty;
            var cached = Lookup(path, scriptTag);
            var headers = context.Request.Headers;
            var saved = new SavedHeaders(headers);

            // Normalize the request so the static handler returns the complete plain-text
            // file: no compression (the plugin encodes the rewritten page itself) and no
            // Range/If-Range (a 206 would otherwise pass through un-injected). The client's
            // validators describe the injected page, not the source file, so they never
            // reach the static handler; a warm entry sends the source validators it was
            // built from instead, which turns an unchanged source into a bodyless 304.
            headers.Remove(HeaderNames.AcceptEncoding);
            headers.Remove(HeaderNames.Range);
            headers.Remove(HeaderNames.IfRange);
            headers.Remove(HeaderNames.IfMatch);
            headers.Remove(HeaderNames.IfUnmodifiedSince);
            SetOrRemove(headers, HeaderNames.IfNoneMatch, cached?.SourceETag);
            SetOrRemove(headers, HeaderNames.IfModifiedSince, cached?.SourceLastModified);

            var originalBody = context.Response.Body;
            using var capture = new CaptureStream(originalBody, MaxCaptureBytes);
            context.Response.Body = capture;
            try
            {
                await nextMw().ConfigureAwait(false);
            }
            finally
            {
                // On a downstream failure the partially captured body is discarded (it
                // never reached the real stream) and the exception propagates: the real
                // response hasn't started, so the host's exception handler can still
                // render a clean error page.
                context.Response.Body = originalBody;
                saved.Restore(headers);
            }

            if (capture.PassedThrough)
            {
                // Too large to rewrite: it already streamed through unchanged.
                if (Interlocked.Exchange(ref _loggedOverflow, 1) == 0)
                {
                    _logger.Warning($"Script injection middleware: index.html is larger than {MaxCaptureBytes} bytes; served it without the script tag.");
                }

                return;
            }

            if (context.RequestAborted.IsCancellationRequested)
            {
                // The client is gone, and a body cut short by the abort must not be cached.
                return;
            }

            var response = context.Response;
            if (response.StatusCode == StatusCodes.Status304NotModified && cached != null)
            {
                // The source is unchanged since the entry was built.
                await ServeAsync(context, cached, saved, originalBody).ConfigureAwait(false);
                return;
            }

            var isHtml = response.StatusCode == StatusCodes.Status200OK
                && (response.ContentType?.Contains("text/html", StringComparison.OrdinalIgnoreCase) ?? false);

            if (!isHtml)
            {
                // Redirects, errors, non-HTML: pass straight through unchanged.
                await capture.CopyCapturedToAsync(originalBody, context.RequestAborted).ConfigureAwait(false);
                return;
            }

            var source = capture.Captured;
            string html;
            try
            {
                html = Inject(source, scriptTag);
            }
            catch (Exception ex)
            {
                // Never break index.html: serve the original response as the host made it.
                _logger.Warning($"Script injection middleware error (serving original HTML): {ex.Message}");
                await capture.CopyCapturedToAsync(originalBody, context.RequestAborted).ConfigureAwait(false);
                return;
            }

            var bytes = Encoding.UTF8.GetBytes(html);
            var entry = new Entry(
                scriptTag,
                response.Headers.ETag.ToString(),
                response.Headers.LastModified.ToString(),
                response.Headers.CacheControl.ToString(),
                new ServedFile(bytes, IndexLevels, upgradeBrotli: false, _logger));

            // Cache only a complete page that can be revalidated: a source validator to
            // ask the static handler with, the length it announced, and a closing body tag.
            var complete = (response.ContentLength is not long announced || announced == source.Length)
                && html.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase) >= 0;
            if (complete
                && bytes.Length <= MaxCacheableBytes
                && (entry.SourceETag.Length > 0 || entry.SourceLastModified.Length > 0))
            {
                Store(path, entry);
            }

            await ServeAsync(context, entry, saved, originalBody).ConfigureAwait(false);
        }

        /// <summary>
        /// The rewrite itself, unchanged by K3a: the tag goes just before the last
        /// &lt;/body&gt; unless the page already loads the plugin's script.
        /// </summary>
        private string Inject(byte[] source, string scriptTag)
        {
            string html;
            using (var reader = new StreamReader(new MemoryStream(source, writable: false), Encoding.UTF8, true, 1024, leaveOpen: false))
            {
                html = reader.ReadToEnd();
            }

            // Idempotency guard keyed on the controller endpoint, so we never
            // double-inject alongside a legacy on-disk tag.
            var alreadyInjected = html.IndexOf("/JellyfinEnhanced/script", StringComparison.OrdinalIgnoreCase) >= 0;
            var bodyClose = html.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);

            if (!alreadyInjected && bodyClose >= 0)
            {
                html = html.Substring(0, bodyClose) + scriptTag + "\n" + html.Substring(bodyClose);

                if (Interlocked.Exchange(ref _loggedOnce, 1) == 0)
                {
                    _logger.Info("Jellyfin Enhanced: injected the client script via request-time middleware (IStartupFilter).");
                }
            }

            return html;
        }

        /// <summary>
        /// Writes the injected page in the client's preferred encoding, or a 304/412
        /// when the client's own validators (for the injected page) say so.
        /// </summary>
        private static async Task ServeAsync(HttpContext context, Entry entry, SavedHeaders client, Stream body)
        {
            var response = context.Response;
            var representation = entry.Page.Select(client.AcceptEncoding);

            response.ContentType = "text/html;charset=utf-8";
            response.Headers.ETag = representation.ETag;
            var vary = response.Headers.Vary.ToString();
            if (vary.IndexOf(HeaderNames.AcceptEncoding, StringComparison.OrdinalIgnoreCase) < 0)
            {
                response.Headers.Vary = vary.Length == 0 ? HeaderNames.AcceptEncoding : vary + ", " + HeaderNames.AcceptEncoding;
            }

            if (entry.CacheControl.Length > 0)
            {
                response.Headers.CacheControl = entry.CacheControl;
            }

            // The source file's timestamp does not describe the injected page (the script
            // tag can change while index.html does not), so only the ETag validates it.
            // Range requests are not supported on the rewritten document.
            response.Headers.Remove(HeaderNames.LastModified);
            response.Headers.Remove(HeaderNames.AcceptRanges);
            response.Headers.Remove(HeaderNames.ContentRange);

            if (client.IfMatch.Count > 0 && !MatchesStrong(client.IfMatch, representation.ETag))
            {
                response.StatusCode = StatusCodes.Status412PreconditionFailed;
                response.Headers.Remove(HeaderNames.ContentEncoding);
                response.ContentLength = 0;
                return;
            }

            if (ServedFile.NotModified(client.IfNoneMatch.ToString(), representation))
            {
                response.StatusCode = StatusCodes.Status304NotModified;
                response.Headers.Remove(HeaderNames.ContentEncoding);
                response.ContentLength = null;
                return;
            }

            response.StatusCode = StatusCodes.Status200OK;
            if (representation.Encoding != null)
            {
                response.Headers.ContentEncoding = representation.Encoding;
            }
            else
            {
                response.Headers.Remove(HeaderNames.ContentEncoding);
            }

            response.ContentLength = representation.Bytes.Length;
            await body.WriteAsync(representation.Bytes.AsMemory(), context.RequestAborted).ConfigureAwait(false);
        }

        /// <summary>If-Match uses the strong comparison (RFC 9110 13.1.1): "*" or the exact strong tag.</summary>
        private static bool MatchesStrong(StringValues ifMatch, string etag)
        {
            foreach (var raw in ifMatch.ToString().Split(','))
            {
                var tag = raw.Trim();
                if (tag == "*" || tag == etag) return true;
            }

            return false;
        }

        private Entry? Lookup(string path, string scriptTag)
        {
            lock (_cacheLock)
            {
                if (_cache.TryGetValue(path, out var entry) && entry.ScriptTag == scriptTag)
                {
                    entry.Used = ++_sequence;
                    return entry;
                }

                return null;
            }
        }

        private void Store(string path, Entry entry)
        {
            lock (_cacheLock)
            {
                if (!_cache.ContainsKey(path) && _cache.Count >= MaxCachedEntries)
                {
                    string? oldest = null;
                    var oldestUse = long.MaxValue;
                    foreach (var (key, value) in _cache)
                    {
                        if (value.Used < oldestUse)
                        {
                            oldest = key;
                            oldestUse = value.Used;
                        }
                    }

                    _cache.Remove(oldest!);
                }

                entry.Used = ++_sequence;
                _cache[path] = entry;
            }
        }

        private static void SetOrRemove(IHeaderDictionary headers, string name, string? value)
        {
            if (string.IsNullOrEmpty(value))
            {
                headers.Remove(name);
            }
            else
            {
                headers[name] = value;
            }
        }

        // Matches the web app shell however it is requested: bare "/web", "/web/"
        // (SPA serve), and explicit "/web/index.html". EndsWith keeps this correct
        // when Jellyfin is hosted under a base-url prefix (e.g. /jellyfin/web/).
        private static bool IsIndexRequest(string? path)
        {
            if (string.IsNullOrEmpty(path))
            {
                return false;
            }

            return path.EndsWith("/web/index.html", StringComparison.OrdinalIgnoreCase)
                || path.EndsWith("/web/", StringComparison.OrdinalIgnoreCase)
                || path.EndsWith("/web", StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>The request headers the filter changes, as the client sent them.</summary>
        private sealed class SavedHeaders
        {
            private static readonly string[] Names =
            {
                HeaderNames.AcceptEncoding, HeaderNames.Range, HeaderNames.IfRange, HeaderNames.IfMatch,
                HeaderNames.IfUnmodifiedSince, HeaderNames.IfNoneMatch, HeaderNames.IfModifiedSince,
            };

            private readonly Dictionary<string, StringValues> _values = new(StringComparer.OrdinalIgnoreCase);

            internal SavedHeaders(IHeaderDictionary headers)
            {
                foreach (var name in Names)
                {
                    if (headers.TryGetValue(name, out var value))
                    {
                        _values[name] = value;
                    }
                }
            }

            internal string? AcceptEncoding => Get(HeaderNames.AcceptEncoding).ToString();

            internal StringValues IfMatch => Get(HeaderNames.IfMatch);

            internal StringValues IfNoneMatch => Get(HeaderNames.IfNoneMatch);

            internal void Restore(IHeaderDictionary headers)
            {
                foreach (var name in Names)
                {
                    if (_values.TryGetValue(name, out var value))
                    {
                        headers[name] = value;
                    }
                    else
                    {
                        headers.Remove(name);
                    }
                }
            }

            private StringValues Get(string name) => _values.TryGetValue(name, out var value) ? value : StringValues.Empty;
        }

        /// <summary>
        /// Captures what the downstream pipeline writes, up to a limit. Past the limit it
        /// writes everything captured so far to the real stream and passes the rest
        /// straight through, so memory per request never exceeds the limit. Flushes are
        /// ignored while capturing, so the response does not start before the rewrite.
        /// </summary>
        internal sealed class CaptureStream : Stream
        {
            private readonly Stream _inner;
            private readonly int _limit;
            private MemoryStream? _buffer = new();

            internal CaptureStream(Stream inner, int limit)
            {
                _inner = inner;
                _limit = limit;
            }

            /// <summary>True once the limit was passed and the body went to the real stream.</summary>
            internal bool PassedThrough => _buffer == null;

            internal byte[] Captured => _buffer?.ToArray() ?? Array.Empty<byte>();

            public override bool CanRead => false;

            public override bool CanSeek => false;

            public override bool CanWrite => true;

            public override long Length => throw new NotSupportedException();

            public override long Position
            {
                get => throw new NotSupportedException();
                set => throw new NotSupportedException();
            }

            internal Task CopyCapturedToAsync(Stream destination, CancellationToken cancellationToken)
                => destination.WriteAsync(Captured.AsMemory(), cancellationToken).AsTask();

            public override void Write(byte[] buffer, int offset, int count) => Write(buffer.AsSpan(offset, count));

            public override void Write(ReadOnlySpan<byte> buffer)
            {
                if (_buffer != null && _buffer.Length + buffer.Length <= _limit)
                {
                    _buffer.Write(buffer);
                    return;
                }

                if (_buffer != null)
                {
                    _inner.Write(_buffer.GetBuffer(), 0, (int)_buffer.Length);
                    _buffer = null;
                }

                _inner.Write(buffer);
            }

            public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
                => WriteAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();

            public override async ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
            {
                if (_buffer != null && _buffer.Length + buffer.Length <= _limit)
                {
                    _buffer.Write(buffer.Span);
                    return;
                }

                if (_buffer != null)
                {
                    var captured = _buffer;
                    _buffer = null;
                    await _inner.WriteAsync(captured.GetBuffer().AsMemory(0, (int)captured.Length), cancellationToken).ConfigureAwait(false);
                }

                await _inner.WriteAsync(buffer, cancellationToken).ConfigureAwait(false);
            }

            public override void Flush()
            {
                if (_buffer == null) _inner.Flush();
            }

            public override Task FlushAsync(CancellationToken cancellationToken)
                => _buffer == null ? _inner.FlushAsync(cancellationToken) : Task.CompletedTask;

            public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();

            public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

            public override void SetLength(long value) => throw new NotSupportedException();
        }
    }
}
