using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// Builds the single-request component bundle served by
    /// GET /JellyfinEnhanced/bundle.js (+ its source map at bundle.js.map).
    ///
    /// plugin.js used to insert one &lt;script async=false&gt; per component module
    /// (150+ tags); even from the HTTP cache that costs hundreds of milliseconds
    /// of per-tag overhead. The bundle concatenates the same embedded files, in the
    /// same order, into one script. There is no build toolchain: the ordered list
    /// lives in the embedded js/component-scripts.json manifest (entries starting
    /// with "//" are notes), which is also what plugin.js uses for dev mode and
    /// for its per-file fallback loader.
    ///
    /// Bundle format: a prologue publishing window.__JE_BUNDLE_TOTAL (module
    /// count) and window.__JE_BUNDLE_PROGRESS = 0, then one array,
    /// window.__JE_BUNDLE_MODULES, holding one function per file:
    ///   /* ---- js/&lt;path&gt; ---- */\nfunction () {\n&lt;file content&gt;\n},\n
    /// The client runs the functions in order, yielding to the event loop every
    /// few milliseconds, so evaluating 150+ modules never blocks jellyfin-web's
    /// own rendering for one long task (a single flat script would), and a module
    /// that throws at its top level is reported and skipped instead of aborting
    /// everything after it. Wrapping is semantics-preserving because every
    /// component module is a single IIFE expression statement (no top-level
    /// declarations, directives, `this` or `arguments`); the file content keeps
    /// its own lines, so the line-identity source map still applies.
    ///
    /// The source map is an index map ("sections"), one line-identity section per
    /// file pointing at the original /JellyfinEnhanced/js/&lt;path&gt; URL, so stack
    /// traces and DevTools keep showing the original file names and line numbers.
    ///
    /// Built once per process and cached: the URL carries the plugin's cache key
    /// (version + DLL timestamp), which changes on every deploy. Dev mode
    /// bypasses the cache so edits show up after a restart without a version bump.
    /// </summary>
    internal static class ClientScriptBundle
    {
        private const string ResourcePrefix = "Jellyfin.Plugin.JellyfinEnhanced.js.";
        private const string ManifestResource = ResourcePrefix + "component-scripts.json";

        // Manifest paths are interpolated into a block comment and a JS string
        // literal, so only plain relative paths are accepted.
        private static readonly Regex SafePath = new(@"^[A-Za-z0-9_][A-Za-z0-9_./-]*\.js$", RegexOptions.Compiled);

        private static readonly object _lock = new();
        private static string[]? _manifest;
        private static (string CacheKey, byte[] Script, byte[] SourceMap)? _cached;

        /// <summary>
        /// The ordered component-script paths (relative to js/), with the "//"
        /// note entries removed. Read from the embedded manifest once.
        /// </summary>
        internal static IReadOnlyList<string> GetComponentScripts()
        {
            var manifest = _manifest;
            if (manifest != null)
            {
                return manifest;
            }

            using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(ManifestResource)
                ?? throw new InvalidOperationException("Embedded component-script manifest js/component-scripts.json is missing.");
            var entries = JsonSerializer.Deserialize<string[]>(stream)
                ?? throw new InvalidOperationException("js/component-scripts.json did not deserialize to a string array.");

            manifest = entries
                .Select(e => (e ?? string.Empty).Trim())
                .Where(e => e.Length > 0 && !e.StartsWith("//", StringComparison.Ordinal))
                .ToArray();
            _manifest = manifest;
            return manifest;
        }

        /// <summary>
        /// Returns the bundle script and its source map for the given cache key,
        /// building them on first use. <paramref name="rebuild"/> (dev mode)
        /// bypasses the process-lifetime cache.
        /// </summary>
        internal static (byte[] Script, byte[] SourceMap) GetBundle(string cacheKey, bool rebuild, Logger logger)
        {
            lock (_lock)
            {
                if (!rebuild && _cached.HasValue && _cached.Value.CacheKey == cacheKey)
                {
                    return (_cached.Value.Script, _cached.Value.SourceMap);
                }

                var built = Build(cacheKey, logger);
                _cached = (cacheKey, built.Script, built.SourceMap);
                return built;
            }
        }

        private sealed class Section
        {
            public string Path { get; init; } = string.Empty;
            public int Line { get; init; }
            public int LineCount { get; init; }
        }

        private static (byte[] Script, byte[] SourceMap) Build(string cacheKey, Logger logger)
        {
            var scripts = GetComponentScripts();
            var assembly = Assembly.GetExecutingAssembly();
            var sb = new StringBuilder(2 * 1024 * 1024);
            var sections = new List<Section>(scripts.Count);
            // 0-based index of the line the next append starts on; kept exact so
            // each source-map section's offset matches the generated bundle.
            var line = 0;

            void Append(string text)
            {
                sb.Append(text);
                foreach (var c in text)
                {
                    if (c == '\n') line++;
                }
            }

            Append("/* Jellyfin Enhanced component bundle — generated from js/component-scripts.json */\n");
            Append($"window.__JE_BUNDLE_TOTAL = {scripts.Count};\n");
            Append("window.__JE_BUNDLE_PROGRESS = 0;\n");
            Append("window.__JE_BUNDLE_MODULES = [\n");

            foreach (var path in scripts)
            {
                string? content = null;
                if (SafePath.IsMatch(path))
                {
                    using var stream = assembly.GetManifestResourceStream(ResourcePrefix + path.Replace('/', '.'));
                    if (stream != null)
                    {
                        using var reader = new StreamReader(stream, Encoding.UTF8);
                        content = reader.ReadToEnd();
                    }
                }

                if (content == null)
                {
                    // Mirror the per-file loader, which logs a load error for a
                    // missing script and carries on with the next one.
                    logger.Warning($"Component bundle: '{path}' is listed in js/component-scripts.json but is not an embedded resource; skipping.");
                    Append($"/* ---- js/{path} (missing) ---- */\n");
                    Append($"function () {{ console.error(\"🪼 Jellyfin Enhanced: Failed to load script '{path}' (not found in bundle)\"); }},\n");
                    continue;
                }

                Append($"/* ---- js/{path} ---- */\nfunction () {{\n");
                var start = line;
                Append(content);
                if (!content.EndsWith('\n'))
                {
                    Append("\n");
                }
                sections.Add(new Section { Path = path, Line = start, LineCount = line - start });
                Append("},\n");
            }

            Append("];\n");
            Append($"//# sourceMappingURL=bundle.js.map?v={cacheKey}\n");

            var map = new
            {
                version = 3,
                file = "bundle.js",
                sections = sections.Select(s => new
                {
                    offset = new { line = s.Line, column = 0 },
                    map = new
                    {
                        version = 3,
                        file = s.Path,
                        // Relative to the map's own URL (/JellyfinEnhanced/bundle.js.map),
                        // so it resolves correctly behind a base-URL prefix too.
                        sources = new[] { $"js/{s.Path}?v={cacheKey}" },
                        names = Array.Empty<string>(),
                        mappings = LineIdentityMappings(s.LineCount)
                    }
                }).ToArray()
            };

            return (Encoding.UTF8.GetBytes(sb.ToString()), JsonSerializer.SerializeToUtf8Bytes(map));
        }

        /// <summary>
        /// VLQ mappings for "generated line n, column 0 ⇒ source 0, line n, column 0":
        /// "AAAA" for the first line, then ";AACA" (next line, same source, +1 line)
        /// for every following line.
        /// </summary>
        private static string LineIdentityMappings(int lineCount)
        {
            if (lineCount <= 0)
            {
                return string.Empty;
            }

            var sb = new StringBuilder(4 + 5 * (lineCount - 1));
            sb.Append("AAAA");
            for (var i = 1; i < lineCount; i++)
            {
                sb.Append(";AACA");
            }
            return sb.ToString();
        }
    }
}
