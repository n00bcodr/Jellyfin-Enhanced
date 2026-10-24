using System;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.StaticFiles;
using Microsoft.Extensions.Primitives;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// Replaces jellyfin-web's branding assets (logo / banner / favicon / touch icon)
    /// with the admin's uploaded custom images at request time, via ASP.NET middleware
    /// registered through <see cref="Microsoft.AspNetCore.Hosting.IStartupFilter"/>.
    ///
    /// This is the branding counterpart of <see cref="ScriptInjectionStartupFilter"/>.
    /// jellyfin-web serves these assets as plain hashed static files
    /// (e.g. /web/icon-transparent.&lt;hash&gt;.png), so the only interception point is a
    /// plugin middleware ahead of the static-file handler.
    ///
    /// The custom images are uploaded through the plugin's existing controller and
    /// stored under <see cref="JellyfinEnhanced.BrandingDirectory"/> using fixed,
    /// un-hashed names. When a custom file exists this middleware short-circuits the
    /// request and streams those bytes directly (no buffering, no de/recompression —
    /// PNG/ICO are already compressed). When it does not, it calls next() and the
    /// stock asset is served, preserving the original "no custom image = no change"
    /// behaviour. Any error falls through to next(). Disable via
    /// DisableBrandingMiddleware.
    /// </summary>
    public class BrandingAssetStartupFilter : IStartupFilter
    {
        private readonly Logger _logger;
        private int _loggedOnce;

        // Served file name -> fixed on-disk filename under BrandingDirectory.
        // The names match the stable basename and are hash-agnostic, since the webpack
        // content hash changes on every jellyfin-web build. The served basename
        // "touchicon" (in any sized/hashed form) maps to the single upload name
        // "apple-touch-icon.png"; the other four match 1:1.
        //
        // Jellyfin 12 sources its branding images from a separate @jellyfin/ux-web
        // npm package and added a manifest.json (PWA "add to home screen") that
        // references unhashed, sized touch-icon variants copied verbatim into a new
        // /web/favicons/ subdirectory (e.g. favicons/touchicon144.png) - distinct from
        // the older flat, content-hashed /web/touchicon.<hash>.png used by the
        // <link rel="apple-touch-icon"> tag. The touchicon form covers both:
        // an optional size suffix (72/114/144/512) and an optional ".<hash>" segment.
        //
        // Each name is matched in one deterministic pass (no regular expression, no match timeout: a valid asset path
        // always gets the custom image, however long the server takes to schedule the request). Letters match in either
        // case, as the case-insensitive patterns did (the dotted capital I and the Kelvin sign included).
        private static readonly (Func<string, bool> Matches, string OnDiskFileName)[] Map =
        {
            (name => Hashed(name, "icon-transparent.", ".png"), "icon-transparent.png"),
            (name => Hashed(name, "banner-light.", ".png"), "banner-light.png"),
            (name => Hashed(name, "banner-dark.", ".png"), "banner-dark.png"),
            (name => Hashed(name, "favicon.", ".ico"), "favicon.ico"),
            (TouchIcon, "apple-touch-icon.png"),
        };

        // "<prefix><anything but a line feed><suffix>" (the old "^prefix.*suffix$"; a name never ends in a line feed).
        private static bool Hashed(string name, string prefix, string suffix)
            => name.Length >= prefix.Length + suffix.Length
                && Helpers.AsciiGrammar.StartsWithIgnoreCase(name, prefix, culture: true)
                && Helpers.AsciiGrammar.EndsWithIgnoreCase(name, suffix, culture: true)
                && name.IndexOf('\n', StringComparison.Ordinal) < 0;

        // "touchicon", then digits (any script's decimal digits, as \d), then optionally "." and 1+ hex digits, then ".png".
        private static bool TouchIcon(string name)
        {
            const string Prefix = "touchicon";
            if (!Helpers.AsciiGrammar.StartsWithIgnoreCase(name, Prefix, culture: true)) return false;
            var i = Prefix.Length;
            while (i < name.Length && char.IsDigit(name[i])) i++;
            var rest = name.AsSpan(i);
            if (Helpers.AsciiGrammar.EqualsIgnoreCase(rest, ".png")) return true;
            if (rest.Length < 6 || rest[0] != '.') return false;
            var hex = 1;
            while (hex < rest.Length && Helpers.AsciiGrammar.IsHex(rest[hex])) hex++;
            return hex > 1 && Helpers.AsciiGrammar.EqualsIgnoreCase(rest[hex..], ".png");
        }

        public BrandingAssetStartupFilter(Logger logger)
        {
            _logger = logger;
        }

        public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next)
        {
            return app =>
            {
                app.Use(InvokeAsync);
                next(app);
            };
        }

        private async Task InvokeAsync(HttpContext context, Func<Task> nextMw)
        {
            var onDiskFileName = MatchBrandingAsset(context.Request.Path.Value);
            if (onDiskFileName == null)
            {
                await nextMw().ConfigureAwait(false);
                return;
            }

            var config = JellyfinEnhanced.Instance?.Configuration;
            if (config == null || config.DisableBrandingMiddleware)
            {
                await nextMw().ConfigureAwait(false);
                return;
            }

            // Only GET/HEAD serve an asset; let the host handle any other method.
            if (!HttpMethods.IsGet(context.Request.Method) && !HttpMethods.IsHead(context.Request.Method))
            {
                await nextMw().ConfigureAwait(false);
                return;
            }

            try
            {
                var brandingDir = JellyfinEnhanced.BrandingDirectory;
                if (!string.IsNullOrWhiteSpace(brandingDir))
                {
                    // Resolve under BrandingDirectory and confirm the candidate stays
                    // inside it (defence in depth; OnDiskFileName is a constant).
                    var fullDir = Path.GetFullPath(brandingDir);
                    var filePath = Path.GetFullPath(Path.Join(fullDir, onDiskFileName));
                    if (string.Equals(Path.GetDirectoryName(filePath), fullDir, StringComparison.OrdinalIgnoreCase)
                        && File.Exists(filePath))
                    {
                        var fileInfo = new FileInfo(filePath);
                        if (fileInfo.Length > 0)
                        {
                            // Validator from size + mtime so unchanged assets revalidate
                            // cheaply (304, no body). Cache-Control stays no-cache because
                            // the URL hash reflects the stock asset, not the custom file —
                            // so a re-uploaded image (new mtime -> new ETag) is picked up
                            // immediately on the next revalidation.
                            var etag = "\"" + (fileInfo.LastWriteTimeUtc.Ticks ^ fileInfo.Length)
                                .ToString("x", CultureInfo.InvariantCulture) + "\"";
                            var lastModified = fileInfo.LastWriteTimeUtc.ToString("R", CultureInfo.InvariantCulture);

                            if (context.Request.Headers.TryGetValue("If-None-Match", out var inm)
                                && IfNoneMatchSatisfied(inm, etag))
                            {
                                context.Response.StatusCode = 304;
                                context.Response.Headers["Cache-Control"] = "no-cache";
                                context.Response.Headers["ETag"] = etag;
                                context.Response.Headers["Last-Modified"] = lastModified;
                                return;
                            }

                            var provider = new FileExtensionContentTypeProvider();
                            if (!provider.TryGetContentType(filePath, out var contentType))
                            {
                                contentType = "application/octet-stream";
                            }

                            var isHead = HttpMethods.IsHead(context.Request.Method);
                            byte[]? bytes = isHead ? null : await File.ReadAllBytesAsync(filePath).ConfigureAwait(false);
                            var length = isHead ? fileInfo.Length : bytes!.Length;

                            context.Response.StatusCode = 200;
                            context.Response.ContentType = contentType;
                            context.Response.ContentLength = length;
                            context.Response.Headers["Cache-Control"] = "no-cache";
                            context.Response.Headers["ETag"] = etag;
                            context.Response.Headers["Last-Modified"] = lastModified;

                            if (Interlocked.Exchange(ref _loggedOnce, 1) == 0)
                            {
                                _logger.Info("Jellyfin Enhanced: serving custom branding via request-time middleware (IStartupFilter).");
                            }

                            // HEAD: headers only, no body.
                            if (!isHead)
                            {
                                await context.Response.Body.WriteAsync(bytes!, 0, bytes!.Length).ConfigureAwait(false);
                            }

                            return; // short-circuit: do not fall through to the static-file handler
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                // Never break asset serving — fall through to the stock asset below.
                _logger.Warning($"Branding middleware error (serving stock asset): {ex.Message}");
            }

            // No custom image (or an error): let jellyfin-web serve the stock asset.
            await nextMw().ConfigureAwait(false);
        }

        // RFC 9110 If-None-Match: a comma-separated list of entity-tags (or "*"),
        // each optionally weak ("W/..."). Compare weakly (the weakness prefix is
        // ignored) — correct for cache validation of a GET — and accept multi-value
        // and multi-line headers so proxies/browsers actually get their 304.
        private static bool IfNoneMatchSatisfied(StringValues header, string etag)
        {
            var bare = Unweaken(etag);
            foreach (var value in header)
            {
                if (string.IsNullOrEmpty(value))
                {
                    continue;
                }

                foreach (var t in value.Split(',').Select(s => s.Trim()))
                {
                    if (t.Length == 0)
                    {
                        continue;
                    }

                    if (t == "*" || string.Equals(Unweaken(t), bare, StringComparison.Ordinal))
                    {
                        return true;
                    }
                }
            }

            return false;
        }

        private static string Unweaken(string etag) =>
            etag.StartsWith("W/", StringComparison.Ordinal) ? etag.Substring(2) : etag;

        /// <summary>The on-disk branding file a request path asks for (its file name, under a /web/ path), or null.</summary>
        internal static string? MatchBrandingAsset(string? path)
        {
            if (string.IsNullOrEmpty(path) || path.IndexOf("/web/", StringComparison.OrdinalIgnoreCase) < 0)
            {
                return null;
            }

            var fileName = Path.GetFileName(path);
            if (string.IsNullOrEmpty(fileName))
            {
                return null;
            }

            foreach (var (matches, onDiskFileName) in Map)
            {
                if (matches(fileName))
                {
                    return onDiskFileName;
                }
            }

            return null;
        }
    }
}
