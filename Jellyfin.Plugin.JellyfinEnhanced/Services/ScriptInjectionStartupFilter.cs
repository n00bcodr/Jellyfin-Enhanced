using System;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// Injects the Jellyfin Enhanced client &lt;script&gt; tag into jellyfin-web's
    /// index.html at request time, via ASP.NET middleware registered through
    /// <see cref="Microsoft.AspNetCore.Hosting.IStartupFilter"/>.
    ///
    /// This is what lets the plugin work WITHOUT the File Transformation plugin.
    /// Jellyfin 12 provides no native script-injection hook and serves index.html
    /// as a plain static file, so the only supported interception point is a
    /// plugin-registered middleware that runs ahead of the static-file handler.
    /// File Transformation's own rewrite uses the same technique; this keeps the
    /// behaviour self-contained in the plugin and avoids both the Harmony patching
    /// (unsupported on the .NET 10 runtime used by Jellyfin 12) and the on-disk
    /// index.html rewrite (which needs a writable web folder / root container and
    /// is wiped on every jellyfin-web update).
    ///
    /// The filter is deliberately defensive and additive:
    ///   - only ever touches the web index.html response;
    ///   - idempotent: no-ops if the script tag is already present (e.g. a legacy
    ///     on-disk rewrite, or a future File Transformation build, already added it);
    ///   - on any error it serves the original response unchanged, never throwing
    ///     into the pipeline;
    ///   - can be disabled via the DisableScriptInjectionMiddleware config flag.
    /// </summary>
    public class ScriptInjectionStartupFilter : IStartupFilter
    {
        private readonly Logger _logger;
        private int _loggedOnce;

        public ScriptInjectionStartupFilter(Logger logger)
        {
            _logger = logger;
        }

        public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next)
        {
            return app =>
            {
                // Registered before the rest of the pipeline (next(app)) so this runs
                // outermost — stripping Accept-Encoding below then reliably yields an
                // uncompressed response we can read and rewrite.
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

            // Normalize the request so the static handler returns a complete, plain-text
            // 200 we can rewrite: drop Accept-Encoding (no compression) and Range/If-Range
            // (a 206 partial response would otherwise pass through un-injected with a wrong
            // total length).
            context.Request.Headers.Remove("Accept-Encoding");
            context.Request.Headers.Remove("Range");
            context.Request.Headers.Remove("If-Range");

            var originalBody = context.Response.Body;
            using var buffer = new MemoryStream();
            context.Response.Body = buffer;
            try
            {
                await nextMw().ConfigureAwait(false);
            }
            catch
            {
                // A downstream failure is not ours to swallow. Discard the partially
                // buffered body (it was never written to the real stream) and rethrow:
                // the real response hasn't started, so the host's exception handler can
                // still render a clean error page. Flushing the partial buffer here would
                // commit a truncated, 200-looking response.
                context.Response.Body = originalBody;
                throw;
            }

            context.Response.Body = originalBody;
            buffer.Seek(0, SeekOrigin.Begin);

            var isHtml = context.Response.StatusCode == 200
                && (context.Response.ContentType?.Contains("text/html", StringComparison.OrdinalIgnoreCase) ?? false);

            if (!isHtml)
            {
                // 304, redirects, non-HTML — pass straight through unchanged.
                await buffer.CopyToAsync(originalBody).ConfigureAwait(false);
                return;
            }

            string html;
            using (var reader = new StreamReader(buffer, Encoding.UTF8, true, 1024, leaveOpen: true))
            {
                html = await reader.ReadToEndAsync().ConfigureAwait(false);
            }

            try
            {
                // The config guard above (config != null) already implies the plugin
                // instance is non-null; the enclosing try/catch covers the impossible
                // case where it isn't.
                var plugin = JellyfinEnhanced.Instance!;
                // Idempotency guard keyed on the controller endpoint, so we never
                // double-inject alongside a legacy on-disk tag or a future FT build.
                var alreadyInjected = html.IndexOf("/JellyfinEnhanced/script", StringComparison.OrdinalIgnoreCase) >= 0;
                var bodyClose = html.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);

                if (!alreadyInjected && bodyClose >= 0)
                {
                    var tag = plugin.BuildScriptTag();
                    html = html.Substring(0, bodyClose) + tag + "\n" + html.Substring(bodyClose);

                    if (System.Threading.Interlocked.Exchange(ref _loggedOnce, 1) == 0)
                    {
                        _logger.Info("Injected Jellyfin Enhanced script via request-time middleware (IStartupFilter). File Transformation is not required.");
                    }
                }
            }
            catch (Exception ex)
            {
                // Never break index.html — serve whatever we have.
                _logger.Warning($"Script injection middleware error (serving original HTML): {ex.Message}");
            }

            var bytes = Encoding.UTF8.GetBytes(html);
            context.Response.ContentType = "text/html;charset=utf-8";
            context.Response.ContentLength = bytes.Length;
            // The body changed, so any validators set by the static-file handler are
            // no longer valid; and we don't support range requests on the rewritten
            // document (Range requests are already stripped on the way in).
            context.Response.Headers.Remove("ETag");
            context.Response.Headers.Remove("Last-Modified");
            context.Response.Headers.Remove("Accept-Ranges");
            await originalBody.WriteAsync(bytes, 0, bytes.Length).ConfigureAwait(false);
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
                || path.Equals("/web", StringComparison.OrdinalIgnoreCase);
        }
    }
}
