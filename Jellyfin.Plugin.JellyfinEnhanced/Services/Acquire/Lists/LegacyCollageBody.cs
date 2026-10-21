using System;
using System.Buffers;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Common.Configuration;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.Extensions.Primitives;
using Microsoft.Net.Http.Headers;
using Microsoft.Win32.SafeHandles;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists
{
    /// <summary>
    /// The MVC side of <see cref="LegacyCollageProjection"/>, at the byte boundary: whatever result type an action (or a
    /// filter) answers with (an object, <c>JsonResult</c>, <c>ContentResult</c>, a JSON file or stream, a streamed
    /// sequence, a result type nobody has written yet), its body is written through a response body JE owns, and what is
    /// withheld is decided when the bytes are about to be written, never before the action:
    /// <list type="bullet">
    /// <item>At the first byte, with nothing to withhold, the answer passes straight through, and each further write checks
    /// there is still nothing (if evidence appears halfway, the answer is cut off: what was sent was checked).</item>
    /// <item>Otherwise a JSON body (or a text body that is JSON) is held (in memory up to a bound, then in a file of JE's own
    /// next to the host's temporary files, so an answer of any size is checked) and projected with a view taken once it is
    /// complete, in the character set it was written in (unchanged bytes go as they were; a changed body is written in
    /// the same character set). It is written in parts, each after checking the view still holds; if it doesn't, the
    /// rest is projected afresh, or the answer is cut off when the part already sent no longer would be.</item>
    /// <item>Image answers whose withholding the image filter decided before the action (<see cref="Expect"/>) are judged
    /// again at their first byte (or at the end when there is no body: a HEAD or a 304), and answered as the host
    /// answers an item without that image when withheld now.</item>
    /// <item>Any other body (images, scripts, pages) passes straight through. A JSON body that can't be checked is not sent (500).</item>
    /// </list>
    /// </summary>
    public sealed class LegacyCollageBody : IAsyncResourceFilter
    {
        /// <summary>Filter order: outside every other filter, so its body is the last thing written.</summary>
        public const int Order = int.MinValue + 100;

        /// <summary>Largest body held in memory; a larger one is held in a file.</summary>
        internal const int InMemoryBytes = 8 * 1024 * 1024;

        /// <summary>How much of a body is written (or passed through) between two checks of the evidence.</summary>
        internal const int PartBytes = 1024 * 1024;

        private readonly LegacyCollageWithhold _withhold;
        private readonly Logger _logger;
        private readonly string _spool;

        /// <summary>Creates the filter: large bodies are held under the host's temporary folder (DI).</summary>
        /// <param name="withhold">The owner of the legacy collage verdicts.</param>
        /// <param name="logger">JE logger.</param>
        /// <param name="paths">Jellyfin application paths.</param>
        public LegacyCollageBody(LegacyCollageWithhold withhold, Logger logger, IApplicationPaths paths)
            : this(withhold, logger, paths.TempDirectory)
        {
        }

        /// <summary>Creates the filter: large bodies are held under the system's temporary folder.</summary>
        /// <param name="withhold">The owner of the legacy collage verdicts.</param>
        /// <param name="logger">JE logger.</param>
        public LegacyCollageBody(LegacyCollageWithhold withhold, Logger logger)
            : this(withhold, logger, Path.GetTempPath())
        {
        }

        private LegacyCollageBody(LegacyCollageWithhold withhold, Logger logger, string spool)
        {
            _withhold = withhold;
            _logger = logger;
            _spool = Path.Combine(spool, "jellyfin-enhanced-answers");
        }

        /// <summary>How a body with this content type is treated.</summary>
        internal enum Handling
        {
            /// <summary>Not JSON (an image, a script, a page): written straight through.</summary>
            Pass,

            /// <summary>Declared JSON: held and projected; one that isn't JSON is not sent.</summary>
            Json,

            /// <summary>Plain text or no type: held, projected if it is JSON, else sent as it was.</summary>
            Text,
        }

        /// <summary>The handling of a response content type.</summary>
        /// <param name="contentType">The response's content type, if any.</param>
        /// <returns>The handling.</returns>
        internal static Handling HandlingOf(string? contentType)
        {
            if (string.IsNullOrWhiteSpace(contentType))
            {
                return Handling.Text;
            }

            if (!MediaTypeHeaderValue.TryParse(contentType, out var media) || media.MediaType.Value is not { } type)
            {
                // Can't be told apart: held, and projected if it is JSON.
                return Handling.Text;
            }

            if (type.Equals("application/json", StringComparison.OrdinalIgnoreCase) || type.Equals("text/json", StringComparison.OrdinalIgnoreCase)
                || type.EndsWith("+json", StringComparison.OrdinalIgnoreCase) || type.EndsWith("/x-json", StringComparison.OrdinalIgnoreCase))
            {
                return Handling.Json;
            }

            return type.Equals("text/plain", StringComparison.OrdinalIgnoreCase) || type.Equals("*/*", StringComparison.Ordinal) ? Handling.Text : Handling.Pass;
        }

        /// <summary>
        /// The character set a body is written in, by its content type: null for UTF-8 (and US-ASCII, its subset, and no
        /// charset at all, as JSON is); false when it names one this runtime can't read.
        /// </summary>
        /// <param name="contentType">The response's content type, if any.</param>
        /// <param name="encoding">The encoding, or null for UTF-8.</param>
        /// <returns>Whether the body can be read.</returns>
        internal static bool CharsetOf(string? contentType, out Encoding? encoding)
        {
            encoding = null;
            if (string.IsNullOrWhiteSpace(contentType) || !MediaTypeHeaderValue.TryParse(contentType, out var media) || !media.Charset.HasValue)
            {
                return true;
            }

            var name = media.Charset.Value!.Trim('"', ' ');
            if (name.Equals("utf-8", StringComparison.OrdinalIgnoreCase) || name.Equals("utf8", StringComparison.OrdinalIgnoreCase)
                || name.Equals("us-ascii", StringComparison.OrdinalIgnoreCase) || name.Equals("ascii", StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }

            try
            {
                // Text that isn't valid in its character set fails to read instead of being guessed at.
                var named = Encoding.GetEncoding(name, EncoderFallback.ExceptionFallback, DecoderFallback.ExceptionFallback);
                encoding = named.CodePage == Encoding.UTF8.CodePage ? null : named;
                return true;
            }
            catch (ArgumentException)
            {
                return false;
            }
        }

        /// <summary>
        /// Says that an answer was let through before its body because nothing of it was withheld then: at its byte boundary
        /// <paramref name="check"/> is asked again with a view taken there, and the answer it returns (if any) is sent instead.
        /// </summary>
        /// <param name="http">The request.</param>
        /// <param name="check">Returns the answer to send instead when something is withheld now, or null.</param>
        internal static void Expect(HttpContext http, Func<LegacyCollageView, IActionResult?> check)
            => http.Items[typeof(Guard)] = new Guard(check, http.Response.Headers.ToArray());

        /// <inheritdoc />
        public async Task OnResourceExecutionAsync(ResourceExecutingContext context, ResourceExecutionDelegate next)
        {
            var http = context.HttpContext;
            var prior = http.Features.Get<IHttpResponseBodyFeature>();
            if (prior == null)
            {
                await next().ConfigureAwait(false);
                return;
            }

            using var body = new HeldBody(this, http, prior);
            var feature = new StreamResponseBodyFeature(body, prior);
            http.Features.Set<IHttpResponseBodyFeature>(feature);
            ResourceExecutedContext executed;
            try
            {
                executed = await next().ConfigureAwait(false);
                // Whatever is still in the pipe writer reaches the held body.
                await feature.CompleteAsync().ConfigureAwait(false);
            }
            catch (Withdrawn)
            {
                return;
            }
            finally
            {
                http.Features.Set(prior);
            }

            if (executed.Exception is Withdrawn)
            {
                executed.ExceptionHandled = true;
                return;
            }

            if (executed.Exception != null && !executed.ExceptionHandled)
            {
                // The host answers the failure; nothing held is sent.
                return;
            }

            try
            {
                await body.Finish(context).ConfigureAwait(false);
            }
            catch (Withdrawn)
            {
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                // The evidence couldn't be read while the answer was written: not sent, or cut off.
                if (!http.Response.HasStarted)
                {
                    Fail(http.Response, ex.GetType().Name + ": " + ex.Message);
                }
                else
                {
                    _ = Withdraw(http, "its evidence couldn't be read (" + ex.GetType().Name + ")");
                }
            }
        }

        private void Fail(HttpResponse response, string why)
        {
            // Fail closed: an answer that couldn't be checked is not sent. Nothing of it has been written yet.
            _logger.Warning($"[Lists] Could not check an answer for legacy list collages ({why}); answered 500.");
            response.StatusCode = StatusCodes.Status500InternalServerError;
            response.ContentLength = 0;
        }

        private Withdrawn Withdraw(HttpContext http, string why)
        {
            // Part of the answer is out: the rest can't be sent faithfully, so the connection is cut (the client sees a
            // failed request, never a withheld image).
            _logger.Warning($"[Lists] An answer was cut off while it was being sent: {why}.");
            http.Abort();
            return new Withdrawn();
        }

        /// <summary>An answer JE cut off while it was being sent.</summary>
        internal sealed class Withdrawn : OperationCanceledException
        {
            public Withdrawn()
                : base("The answer was withdrawn: legacy list collage evidence changed while it was being sent.")
            {
            }
        }

        /// <summary>An answer decided before its body (see <see cref="Expect"/>), and the headers it had then.</summary>
        internal sealed record Guard(Func<LegacyCollageView, IActionResult?> Check, KeyValuePair<string, StringValues>[] Headers);

        /// <summary>
        /// The response body while an action runs: at its first write (or flush, or start) it looks at the content type and
        /// at the evidence, then passes everything to the real body (checking again as it goes), holds it for the
        /// projection, or swallows it for the answer it is replaced by.
        /// </summary>
        internal sealed class HeldBody : Stream
        {
            private readonly LegacyCollageBody _owner;
            private readonly HttpContext _http;
            private readonly IHttpResponseBodyFeature _prior;
            private Mode _mode;
            private Spool? _spool;
            private Guard? _guard;
            private IActionResult? _replacement;
            private Handling _handling;
            private Encoding? _encoding;
            private long _sinceCheck;

            public HeldBody(LegacyCollageBody owner, HttpContext http, IHttpResponseBodyFeature prior)
            {
                _owner = owner;
                _http = http;
                _prior = prior;
            }

            private enum Mode
            {
                Undecided,

                // Not JSON: straight through.
                Pass,

                // JSON with nothing to withhold at the first byte: straight through while there still is nothing.
                Idle,

                // An image whose withholding was decided before the action: straight through while it still isn't withheld.
                Guarded,

                // JSON while there is something to withhold: held for the projection.
                Held,

                // Withheld at the first byte: swallowed, another answer is sent instead.
                Replaced,
            }

            public override bool CanRead => false;

            public override bool CanSeek => false;

            public override bool CanWrite => true;

            public override long Length => throw new NotSupportedException();

            public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }

            public override void Flush()
            {
                if (Passing(0))
                {
                    _prior.Stream.Flush();
                }
            }

            public override Task FlushAsync(CancellationToken cancellationToken)
                => Passing(0) ? _prior.Stream.FlushAsync(cancellationToken) : Task.CompletedTask;

            public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();

            public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

            public override void SetLength(long value) => throw new NotSupportedException();

            public override void Write(byte[] buffer, int offset, int count) => Write(buffer.AsSpan(offset, count));

            public override void Write(ReadOnlySpan<byte> buffer)
            {
                if (Passing(buffer.Length))
                {
                    _prior.Stream.Write(buffer);
                }
                else if (_mode == Mode.Held)
                {
                    _spool!.Write(buffer);
                }
            }

            public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
                => WriteAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();

            public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
            {
                if (Passing(buffer.Length))
                {
                    return _prior.Stream.WriteAsync(buffer, cancellationToken);
                }

                return _mode == Mode.Held ? _spool!.WriteAsync(buffer, cancellationToken) : ValueTask.CompletedTask;
            }

            protected override void Dispose(bool disposing)
            {
                if (disposing)
                {
                    _spool?.Dispose();
                    _spool = null;
                }

                base.Dispose(disposing);
            }

            // Decides at the first byte; for bytes about to pass straight through, checks the evidence still lets them.
            private bool Passing(int count)
            {
                if (_mode == Mode.Undecided)
                {
                    Decide();
                    return _mode is Mode.Pass or Mode.Idle or Mode.Guarded;
                }

                switch (_mode)
                {
                    case Mode.Pass:
                        return true;
                    case Mode.Idle:
                        if (!_owner._withhold.Idle())
                        {
                            throw _owner.Withdraw(_http, "legacy collage evidence appeared");
                        }

                        return true;
                    case Mode.Guarded:
                        _sinceCheck += count;
                        if (_sinceCheck >= PartBytes)
                        {
                            _sinceCheck = 0;
                            if (_guard!.Check(_owner._withhold.Begin()) != null)
                            {
                                throw _owner.Withdraw(_http, "the image became withheld");
                            }
                        }

                        return true;
                    default:
                        return false;
                }
            }

            private void Decide()
            {
                _handling = HandlingOf(_http.Response.ContentType);
                _guard = _http.Items.TryGetValue(typeof(Guard), out var guard) ? guard as Guard : null;
                if (_guard != null && _guard.Check(_owner._withhold.Begin()) is { } replacement)
                {
                    _replacement = replacement;
                    _mode = Mode.Replaced;
                }
                else if (_handling == Handling.Pass)
                {
                    _mode = _guard != null ? Mode.Guarded : Mode.Pass;
                }
                else if (_owner._withhold.Idle())
                {
                    _mode = Mode.Idle;
                }
                else
                {
                    _spool = new Spool(_owner._spool);
                    _mode = Mode.Held;
                }
            }

            /// <summary>After the action and its result: writes what was held, or the answer that replaces it.</summary>
            /// <param name="context">The action context.</param>
            /// <returns>A task.</returns>
            public async Task Finish(ActionContext context)
            {
                switch (_mode)
                {
                    case Mode.Undecided:
                        // No body at all (HEAD, 304, an empty answer): the boundary is the status line.
                        if (_http.Items.TryGetValue(typeof(Guard), out var guard) && guard is Guard expected
                            && expected.Check(_owner._withhold.Begin()) is { } instead)
                        {
                            await Replace(context, expected, instead).ConfigureAwait(false);
                        }

                        break;
                    case Mode.Replaced:
                        await Replace(context, _guard!, _replacement!).ConfigureAwait(false);
                        break;
                    case Mode.Held:
                        await WriteHeld(context).ConfigureAwait(false);
                        break;
                }
            }

            private async Task Replace(ActionContext context, Guard guard, IActionResult replacement)
            {
                // The answer as the host gives it without that image: the headers it had before the action, then its result.
                var response = _http.Response;
                foreach (var name in response.Headers.Keys.ToList())
                {
                    response.Headers.Remove(name);
                }

                foreach (var (name, value) in guard.Headers)
                {
                    response.Headers[name] = value;
                }

                response.StatusCode = StatusCodes.Status200OK;
                await replacement.ExecuteResultAsync(context).ConfigureAwait(false);
            }

            private async Task WriteHeld(ActionContext context)
            {
                var response = _http.Response;
                var spool = _spool!;
                var view = _owner._withhold.Begin();
                if (_guard?.Check(view) is { } replacement)
                {
                    await Replace(context, _guard, replacement).ConfigureAwait(false);
                    return;
                }

                if (!CharsetOf(response.ContentType, out var encoding))
                {
                    _owner.Fail(response, "an answer in a character set JE can't read");
                    return;
                }

                _encoding = encoding;

                // The body's text as UTF-8 (the projection's positions), read afresh each time.
                Stream Utf8() => encoding == null ? spool.Open() : Encoding.CreateTranscodingStream(spool.Open(), encoding, Encoding.UTF8, leaveOpen: false);

                IReadOnlyList<LegacyCollageEdit>? edits;
                try
                {
                    edits = view.Idle ? Array.Empty<LegacyCollageEdit>() : Decide(Utf8, view);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    _owner.Fail(response, ex.GetType().Name + ": " + ex.Message);
                    return;
                }

                if (edits == null)
                {
                    if (_handling == Handling.Json && spool.Length > 0)
                    {
                        _owner.Fail(response, "a JSON answer that isn't JSON");
                        return;
                    }

                    // Text that isn't JSON holds no item: as it was.
                    await Copy(spool.Open(), _prior.Stream, null, _http.RequestAborted).ConfigureAwait(false);
                    return;
                }

                var ct = _http.RequestAborted;
                if (edits.Count == 0 && encoding != null)
                {
                    // Nothing withheld: the bytes as they were, whatever their character set. Checked before each part; if
                    // something is withheld by then and nothing was sent yet, the body is written projected instead.
                    long sent = 0;
                    var current = view;
                    var changed = await Copy(spool.Open(), _prior.Stream, at =>
                    {
                        if (current.StillCurrent())
                        {
                            return null;
                        }

                        current = _owner._withhold.Begin();
                        var again = Decide(Utf8, current);
                        if (again is { Count: 0 })
                        {
                            return null;
                        }

                        sent = at;
                        return again ?? throw _owner.Withdraw(_http, "the answer could no longer be read");
                    }, ct).ConfigureAwait(false);

                    if (changed == null)
                    {
                        return;
                    }

                    if (sent > 0)
                    {
                        throw _owner.Withdraw(_http, "something in it became withheld");
                    }

                    view = current;
                    edits = changed;
                }

                if (edits.Count > 0 && response.ContentLength != null)
                {
                    response.ContentLength = await ProjectedLength(Utf8, edits, encoding).ConfigureAwait(false);
                }

                if (encoding == null)
                {
                    await Emit(Utf8, _prior.Stream, edits, view, response.ContentLength != null, ct).ConfigureAwait(false);
                    return;
                }

                // A changed body goes in the character set it was written in.
                var written = Encoding.CreateTranscodingStream(_prior.Stream, encoding, Encoding.UTF8, leaveOpen: true);
                await using (written.ConfigureAwait(false))
                {
                    await Emit(Utf8, written, edits, view, response.ContentLength != null, ct).ConfigureAwait(false);
                    await written.FlushAsync(ct).ConfigureAwait(false);
                }
            }

            private IReadOnlyList<LegacyCollageEdit>? Decide(Func<Stream> utf8, LegacyCollageView view)
            {
                using var source = utf8();
                return LegacyCollageProjection.Decide(source, view);
            }

            // Copies a body as it was, in parts; before each part, "stale" may return edits (the copy stops there; nothing of
            // that part is written) or null to go on.
            private static async Task<IReadOnlyList<LegacyCollageEdit>?> Copy(Stream source, Stream destination, Func<long, IReadOnlyList<LegacyCollageEdit>?>? stale, CancellationToken ct)
            {
                await using (source.ConfigureAwait(false))
                {
                    var buffer = ArrayPool<byte>.Shared.Rent(64 * 1024);
                    try
                    {
                        long at = 0;
                        long sinceCheck = PartBytes;
                        while (true)
                        {
                            if (stale != null && sinceCheck >= PartBytes)
                            {
                                sinceCheck = 0;
                                if (stale(at) is { } edits)
                                {
                                    return edits;
                                }
                            }

                            var want = stale == null ? buffer.Length : (int)Math.Min(buffer.Length, PartBytes - sinceCheck);
                            var read = await source.ReadAsync(buffer.AsMemory(0, want), ct).ConfigureAwait(false);
                            if (read == 0)
                            {
                                return null;
                            }

                            await destination.WriteAsync(buffer.AsMemory(0, read), ct).ConfigureAwait(false);
                            at += read;
                            sinceCheck += read;
                        }
                    }
                    finally
                    {
                        ArrayPool<byte>.Shared.Return(buffer);
                    }
                }
            }

            // Writes the projected body in parts. Before each part the view must still hold; if it doesn't, the body is
            // projected afresh: when that withholds nothing more, writing goes on as it was; otherwise it goes on with the
            // fresh projection only if what was already sent is what that one sends too (and no length was declared),
            // and is cut off when not. Each body sent is one projection, whole, never a mix of two.
            private async Task Emit(Func<Stream> utf8, Stream destination, IReadOnlyList<LegacyCollageEdit> edits, LegacyCollageView view, bool fixedLength, CancellationToken ct)
            {
                using var source = utf8();
                var buffer = ArrayPool<byte>.Shared.Rent(64 * 1024);
                try
                {
                    long at = 0;
                    long skipUntil = 0;
                    var next = 0;
                    long sinceCheck = PartBytes;
                    while (true)
                    {
                        if (sinceCheck >= PartBytes)
                        {
                            sinceCheck = 0;
                            if (!view.StillCurrent())
                            {
                                view = _owner._withhold.Begin();
                                var again = Decide(utf8, view) ?? throw _owner.Withdraw(_http, "the answer could no longer be read");
                                if (again.All(edits.Contains))
                                {
                                    // Nothing more is withheld now: the projection being written withholds at least as much.
                                }
                                else if (at == 0 && fixedLength)
                                {
                                    // Nothing sent yet: the declared length follows.
                                    _http.Response.ContentLength = await ProjectedLength(utf8, again, _encoding).ConfigureAwait(false);
                                    edits = again;
                                }
                                else if (SamePrefix(edits, again, at) && !fixedLength)
                                {
                                    // What was sent is what the fresh projection sends too: the rest follows it.
                                    edits = again;
                                }
                                else
                                {
                                    throw _owner.Withdraw(_http, "what was already sent is no longer what may be sent");
                                }

                                next = 0;
                                while (next < edits.Count && edits[next].Start < at)
                                {
                                    next++;
                                }
                            }
                        }

                        var read = await source.ReadAsync(buffer.AsMemory(0, (int)Math.Min(buffer.Length, PartBytes - sinceCheck)), ct).ConfigureAwait(false);
                        if (read == 0)
                        {
                            break;
                        }

                        var i = 0;
                        while (i < read)
                        {
                            var position = at + i;
                            if (position < skipUntil)
                            {
                                i += (int)Math.Min(read - i, skipUntil - position);
                                continue;
                            }

                            if (next < edits.Count && edits[next].Start <= position)
                            {
                                var edit = edits[next++];
                                if (edit.False)
                                {
                                    await destination.WriteAsync("false"u8.ToArray(), ct).ConfigureAwait(false);
                                }

                                skipUntil = edit.End;
                                continue;
                            }

                            var until = next < edits.Count ? edits[next].Start : long.MaxValue;
                            var count = (int)Math.Min(read - i, until - position);
                            await destination.WriteAsync(buffer.AsMemory(i, count), ct).ConfigureAwait(false);
                            i += count;
                        }

                        at += read;
                        sinceCheck += read;
                    }
                }
                finally
                {
                    ArrayPool<byte>.Shared.Return(buffer);
                }
            }

            // The edits before a position are the same in both projections (the part sent stays what may be sent).
            private static bool SamePrefix(IReadOnlyList<LegacyCollageEdit> before, IReadOnlyList<LegacyCollageEdit> after, long at)
                => before.Where(e => e.Start < at).SequenceEqual(after.Where(e => e.Start < at));

            // The projected body's length in its own character set.
            private async Task<long> ProjectedLength(Func<Stream> utf8, IReadOnlyList<LegacyCollageEdit> edits, Encoding? encoding)
            {
                if (encoding == null)
                {
                    return _spool!.Length - edits.Sum(e => e.End - e.Start) + edits.Count(e => e.False) * 5;
                }

                var counter = new Counter();
                var written = Encoding.CreateTranscodingStream(counter, encoding, Encoding.UTF8, leaveOpen: true);
                await using (written.ConfigureAwait(false))
                {
                    await Emit(utf8, written, edits, _owner._withhold.Begin(), false, CancellationToken.None).ConfigureAwait(false);
                    await written.FlushAsync().ConfigureAwait(false);
                }

                return counter.Count;
            }
        }

        /// <summary>A held body: in memory up to <see cref="InMemoryBytes"/>, then in a file of JE's own (gone when closed).</summary>
        internal sealed class Spool : IDisposable
        {
            private readonly string _folder;
            private MemoryStream? _memory = new();
            private SafeFileHandle? _file;

            public Spool(string folder)
            {
                _folder = folder;
            }

            public long Length { get; private set; }

            /// <summary>True once the body is held in a file.</summary>
            public bool InFile => _file != null;

            public void Write(ReadOnlySpan<byte> data)
            {
                if (_memory != null && Length + data.Length > InMemoryBytes)
                {
                    Spill();
                }

                if (_memory != null)
                {
                    _memory.Write(data);
                }
                else
                {
                    RandomAccess.Write(_file!, data, Length);
                }

                Length += data.Length;
            }

            public async ValueTask WriteAsync(ReadOnlyMemory<byte> data, CancellationToken ct)
            {
                if (_memory != null && Length + data.Length > InMemoryBytes)
                {
                    Spill();
                }

                if (_memory != null)
                {
                    _memory.Write(data.Span);
                }
                else
                {
                    await RandomAccess.WriteAsync(_file!, data, Length, ct).ConfigureAwait(false);
                }

                Length += data.Length;
            }

            /// <summary>The body from its first byte (each reader reads on its own).</summary>
            /// <returns>A read-only stream.</returns>
            public Stream Open() => _memory != null
                ? new MemoryStream(_memory.GetBuffer(), 0, (int)Length, writable: false)
                : new Reader(_file!, Length);

            public void Dispose()
            {
                _memory = null;
                _file?.Dispose();
            }

            private void Spill()
            {
                Directory.CreateDirectory(_folder);
                var path = Path.Combine(_folder, Guid.NewGuid().ToString("N") + ".tmp");
                _file = File.OpenHandle(path, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None, FileOptions.DeleteOnClose);
                RandomAccess.Write(_file, _memory!.GetBuffer().AsSpan(0, (int)Length), 0);
                _memory = null;
            }

            private sealed class Reader : Stream
            {
                private readonly SafeFileHandle _file;
                private readonly long _length;
                private long _position;

                public Reader(SafeFileHandle file, long length)
                {
                    _file = file;
                    _length = length;
                }

                public override bool CanRead => true;

                public override bool CanSeek => false;

                public override bool CanWrite => false;

                public override long Length => _length;

                public override long Position { get => _position; set => throw new NotSupportedException(); }

                public override void Flush()
                {
                }

                public override int Read(byte[] buffer, int offset, int count) => Read(buffer.AsSpan(offset, count));

                public override int Read(Span<byte> buffer)
                {
                    var read = RandomAccess.Read(_file, buffer[..(int)Math.Min(buffer.Length, _length - _position)], _position);
                    _position += read;
                    return read;
                }

                public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
                {
                    var read = await RandomAccess.ReadAsync(_file, buffer[..(int)Math.Min(buffer.Length, _length - _position)], _position, cancellationToken).ConfigureAwait(false);
                    _position += read;
                    return read;
                }

                public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

                public override void SetLength(long value) => throw new NotSupportedException();

                public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
            }
        }

        // Counts what is written (a changed body's length in its own character set).
        private sealed class Counter : Stream
        {
            public long Count { get; private set; }

            public override bool CanRead => false;

            public override bool CanSeek => false;

            public override bool CanWrite => true;

            public override long Length => Count;

            public override long Position { get => Count; set => throw new NotSupportedException(); }

            public override void Flush()
            {
            }

            public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();

            public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

            public override void SetLength(long value) => throw new NotSupportedException();

            public override void Write(byte[] buffer, int offset, int count) => Count += count;

            public override void Write(ReadOnlySpan<byte> buffer) => Count += buffer.Length;

            public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
            {
                Count += buffer.Length;
                return ValueTask.CompletedTask;
            }
        }
    }
}
