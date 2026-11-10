using Microsoft.AspNetCore.Mvc;
using System.Reflection;
using Microsoft.AspNetCore.Authorization;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.Platform
{
    public partial class JePlatformController
    {
        [HttpGet("script")]
        public ActionResult GetMainScript() => GetScriptResource("js/plugin.js");
        [HttpGet("js/{**path}")]
        public ActionResult GetScript(string path) => GetScriptResource($"js/{path}");
        [HttpGet("Configuration/jeAdmin.css")]
        public ActionResult GetAdminStylesheet() => ServeConcatenated("jeAdmin.css", ".css", "text/css");

        [HttpGet("Configuration/jeAdmin.js")]
        public ActionResult GetAdminScript() => ServeConcatenated("jeAdmin.js", ".js", "application/javascript");

        // Engine file first, then every embedded Configuration/admin/*<ext> file (sorted), so adding a tab's sections or
        // styles never needs a route or csproj change.
        private ActionResult ServeConcatenated(string engineFile, string ext, string contentType)
        {
            const string prefix = "Jellyfin.Plugin.JellyfinEnhanced.Configuration.";
            var asm = Assembly.GetExecutingAssembly();
            var names = new[] { prefix + engineFile }
                .Concat(asm.GetManifestResourceNames()
                    .Where(n => n.StartsWith(prefix + "admin.", StringComparison.Ordinal) && n.EndsWith(ext, StringComparison.Ordinal))
                    .OrderBy(n => n, StringComparer.Ordinal));
            var sb = new System.Text.StringBuilder();
            foreach (var name in names)
            {
                using var stream = asm.GetManifestResourceStream(name);
                if (stream == null) continue;
                using var reader = new StreamReader(stream);
                sb.Append(reader.ReadToEnd()).Append('\n');
            }

            var devMode = JellyfinEnhanced.Instance?.Configuration?.DevMode == true;
            Response.Headers["Cache-Control"] = devMode ? "no-store" : "public, max-age=31536000, immutable";
            return Content(sb.ToString(), contentType);
        }

        /// <summary>
        /// The concatenated component scripts (see Services/ClientScriptBundle).
        /// Same Cache-Control as GetScriptResource: immutable in production (the URL
        /// carries the cache key), no-store and rebuilt per request in dev mode.
        /// Sent pre-compressed (br, else gzip, per Accept-Encoding; Vary: Accept-Encoding)
        /// with a strong ETag per representation; a matching If-None-Match gets a 304.
        /// A response that already has Content-Encoding is left alone by ASP.NET Core's
        /// response compression, so it is never compressed twice.
        /// </summary>
        [HttpGet("bundle.js")]
        public ActionResult GetScriptBundle() => GetScriptBundleResource(map: false);

        [HttpGet("bundle.js.map")]
        public ActionResult GetScriptBundleMap() => GetScriptBundleResource(map: true);

        private ActionResult GetScriptBundleResource(bool map)
        {
            var plugin = JellyfinEnhanced.Instance;
            if (plugin == null)
            {
                return StatusCode(503);
            }

            var devMode = plugin.Configuration?.DevMode == true;
            Features.Platform.Services.EncodedBody body;
            try
            {
                var bundle = Features.Platform.Services.ClientScriptBundle.GetServedBundle(plugin.ScriptCacheKey, rebuild: devMode, _logger);
                body = (map ? bundle.SourceMap : bundle.Script).Select(Request.Headers.AcceptEncoding.ToString());
            }
            catch (Exception ex)
            {
                // The client falls back to loading the component scripts individually.
                _logger.Error($"Failed to build the component bundle: {ex.Message}");
                return StatusCode(500);
            }

            Response.Headers["Cache-Control"] = devMode ? "no-store" : "public, max-age=31536000, immutable";
            Response.Headers["Vary"] = "Accept-Encoding";
            Response.Headers["ETag"] = body.ETag;
            if (Features.Platform.Services.ServedFile.NotModified(Request.Headers.IfNoneMatch.ToString(), body))
            {
                return StatusCode(304);
            }

            if (body.Encoding != null)
            {
                Response.Headers["Content-Encoding"] = body.Encoding;
            }

            return File(body.Bytes, map ? "application/json" : "application/javascript");
        }

        [HttpGet("locales")]
        [Authorize]
        [ResponseCache(Duration = 86400)]
        public ActionResult GetAvailableLocales()
        {
            var prefix = "Jellyfin.Plugin.JellyfinEnhanced.js.locales.";
            var suffix = ".json";
            var locales = Assembly.GetExecutingAssembly()
                .GetManifestResourceNames()
                .Where(n => n.StartsWith(prefix, StringComparison.Ordinal) && n.EndsWith(suffix, StringComparison.Ordinal))
                .Select(n => n.Substring(prefix.Length, n.Length - prefix.Length - suffix.Length))
                .Where(code => code != "en") // Exclude base English (en-GB and en-US are the usable variants)
                .OrderBy(code => code, StringComparer.OrdinalIgnoreCase)
                .ToArray();

            return Ok(locales);
        }

        /// <summary>
        /// Local CDN route. Serves a third-party static asset (icon, flag, theme
        /// sheet, remote locale, …) from the plugin's on-disk cache, fetching it from the
        /// fixed upstream CDN on a cache miss. This is the ONLY endpoint clients use for
        /// these assets — they never contact an external host directly.
        ///
        /// Anonymous by design: these are public assets loaded via &lt;img&gt;, CSS
        /// @import and &lt;link&gt;, none of which can carry a Jellyfin auth token, and no
        /// user data is exposed. The {source} is validated against a fixed allow-list and
        /// {path} is strictly sanitized in the service, so this cannot be used as an open
        /// proxy.
        /// </summary>
        [HttpGet("cdn/{source}/{**path}")]
        public async Task<IActionResult> GetCdnAsset(string source, string path, CancellationToken cancellationToken)
        {
            if (!_cdnAssetService.IsValidSource(source))
            {
                return NotFound();
            }

            var asset = await _cdnAssetService.GetAsync(source, path ?? string.Empty, forceRefresh: false, cancellationToken).ConfigureAwait(false);
            if (asset == null)
            {
                return NotFound();
            }

            // Long-lived immutable caching: after the first hit the browser serves these
            // from its own cache and rarely re-requests. Conditional requests get a 304.
            Response.Headers["Cache-Control"] = "public, max-age=86400";
            Response.Headers["ETag"] = asset.ETag;
            // Defence in depth for SVG served same-origin: forbid MIME sniffing and, for
            // SVG specifically, sandbox it so an embedded <script> can never execute if it
            // were opened directly.
            Response.Headers["X-Content-Type-Options"] = "nosniff";
            if (asset.ContentType.Equals("image/svg+xml", StringComparison.OrdinalIgnoreCase))
            {
                Response.Headers["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
            }

            if (Request.Headers.TryGetValue("If-None-Match", out var ifNoneMatch)
                && ifNoneMatch.ToString().Contains(asset.ETag, StringComparison.Ordinal))
            {
                return StatusCode(304);
            }

            return File(asset.Content, asset.ContentType);
        }

        // Material Symbols glyph fonts, bundled with the plugin instead of proxied
        // from Google Fonts (see #830). The -subset files hold only the icons the
        // client uses (scripts/material-symbols/subset.py) under JE-private family
        // names; the full fonts back the public family names for themes and custom
        // CSS that rely on JE providing them.
        private static readonly HashSet<string> BundledFontNames = new(StringComparer.OrdinalIgnoreCase)
        {
            "materialsymbolsrounded-subset.woff2",
            "materialsymbolsoutlined-subset.woff2",
            "materialsymbolsrounded.woff2",
            "materialsymbolsoutlined.woff2"
        };

        [HttpGet("fonts/{name}")]
        public IActionResult GetBundledFont(string name)
        {
            var sanitized = Path.GetFileName(name);
            if (!BundledFontNames.Contains(sanitized))
            {
                return NotFound();
            }

            var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream($"Jellyfin.Plugin.JellyfinEnhanced.js.fonts.{sanitized}");
            if (stream == null)
            {
                return NotFound();
            }

            Response.Headers["Cache-Control"] = "public, max-age=31536000, immutable";
            return File(stream, "font/woff2");
        }

        [HttpGet("locales/{lang}.json")]
        public ActionResult GetLocale(string lang)
        {
            var sanitizedLang = Path.GetFileName(lang); // Basic sanitization
            var resourcePath = $"Jellyfin.Plugin.JellyfinEnhanced.js.locales.{sanitizedLang}.json";
            var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(resourcePath);

            if (stream == null && sanitizedLang.Contains('-'))
            {
                // Fall back from regional variant (e.g. de-DE) to the base language (de).
                // Jellyfin reports BCP-47 codes like de-DE when the user picks "Auto" or a
                // regional locale, but the plugin only ships base-language files for most
                // languages. Without this fallback the user gets English instead of German.
                var baseLang = sanitizedLang.Split('-')[0];
                var fallbackPath = $"Jellyfin.Plugin.JellyfinEnhanced.js.locales.{baseLang}.json";
                stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(fallbackPath);
                if (stream != null)
                {
                    _logger.Info($"Locale file not found for {sanitizedLang}, falling back to base language {baseLang}");
                }
            }

            if (stream == null)
            {
                _logger.Warning($"Locale file not found for language: {sanitizedLang}");
                return NotFound();
            }

            return new FileStreamResult(stream, "application/json");
        }

        private ActionResult GetScriptResource(string resourcePath)
        {
            var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream($"Jellyfin.Plugin.JellyfinEnhanced.{resourcePath.Replace('/', '.')}");
            if (stream == null) return NotFound();

            // Pick a content type that matches the requested file. Defaults to JS for the
            // legacy /js/* callers; adds CSS so /css/* doesn't get served as application/javascript
            // (which breaks <link rel="stylesheet"> in strict-MIME browsers).
            string contentType = "application/javascript";
            if (resourcePath.EndsWith(".css", StringComparison.OrdinalIgnoreCase))
                contentType = "text/css";
            else if (resourcePath.EndsWith(".json", StringComparison.OrdinalIgnoreCase))
                contentType = "application/json";
            else if (resourcePath.EndsWith(".html", StringComparison.OrdinalIgnoreCase))
                contentType = "text/html";

            // DevMode: no-cache so the browser always re-fetches after a server restart,
            // useful when iterating on JS without bumping the version number.
            // Production: the script URL includes ?v={version}-{dllTimestamp}, so the URL
            // changes on every build and immutable caching is safe.
            var devMode = JellyfinEnhanced.Instance?.Configuration?.DevMode == true;
            Response.Headers["Cache-Control"] = devMode ? "no-store" : "public, max-age=31536000, immutable";
            // Say it is UTF-8: these files carry characters such as "·" and "★", and a script or stylesheet
            // with no charset is decoded with the page's encoding, which has shown them as "Â·" and "â˜…".
            return new FileStreamResult(stream, contentType + "; charset=utf-8");
        }
    }
}
