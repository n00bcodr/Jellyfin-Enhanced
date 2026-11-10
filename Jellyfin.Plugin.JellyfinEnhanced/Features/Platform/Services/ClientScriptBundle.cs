using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Infrastructure.Assets;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.Platform.Services
{
    /// <summary>
    /// Builds the single-request component bundle served by
    /// GET /JellyfinEnhanced/bundle.js (+ its source map at bundle.js.map).
    ///
    /// plugin.js used to insert one &lt;script async=false&gt; per component module
    /// (150+ tags); even from the HTTP cache that costs hundreds of milliseconds
    /// of per-tag overhead. The bundle concatenates the same embedded files, in the
    /// same order, into one script. Typed entries are built before packaging; the ordered list
    /// lives in the embedded js/component-scripts.json manifest (entries starting
    /// with "//" are notes), which is also what plugin.js uses for dev mode and
    /// for its per-file fallback loader.
    ///
    /// Bundle format: a prologue publishing window.__JE_BUNDLE_TOTAL (module
    /// count) and window.__JE_BUNDLE_PROGRESS = 0, then one array,
    /// window.__JE_BUNDLE_MODULES, holding one function per file:
    ///   /* ---- js/&lt;path&gt; ---- */\n(function () {\n&lt;file content&gt;\n}),\n
    /// Each function is parenthesized because every one of them runs exactly once, at
    /// boot: V8 compiles a parenthesized function expression together with its script
    /// (off the main thread while the script streams in) instead of lazily, on the
    /// main thread, at its first call.
    /// The client runs the functions in order, yielding to the event loop every
    /// few milliseconds, so evaluating 150+ modules never blocks jellyfin-web's
    /// own rendering for one long task (a single flat script would), and a module
    /// that throws at its top level is reported and skipped instead of aborting
    /// everything after it. Wrapping is semantics-preserving because every
    /// component module is a single IIFE expression statement (no top-level
    /// declarations, directives, `this` or `arguments`); the file content keeps
    /// its own lines, so each embedded source map retains its generated offsets.
    ///
    /// The source map is an index map ("sections"). Typed entries retain their
    /// embedded TypeScript mappings and source content; legacy entries use a
    /// line-identity map to their original /JellyfinEnhanced/js/&lt;path&gt; URL.
    ///
    /// Built once per process and cached: the URL carries the plugin's cache key
    /// (version + DLL timestamp), which changes on every deploy. Dev mode
    /// bypasses the cache so edits show up after a restart without a version bump.
    ///
    /// The source map is built on its first request, not with the script: only a
    /// browser with developer tools open asks for it, and building it means parsing
    /// two embedded maps per module and serializing about 11 MB of JSON, which the
    /// first page load after every server start used to wait for and every server
    /// then kept in memory.
    ///
    /// Minified (canopy K1): each module's content is its minified twin
    /// min/js/&lt;path&gt; (scripts/client-build.mjs builds it from the same source),
    /// falling back to the readable js/&lt;path&gt; when a module has no twin. The
    /// twin maps omit sourcesContent; it is copied from the readable map, so
    /// bundle.js.map still carries the TypeScript text. The readable js/** files
    /// are still what the per-file loader, dev tooling and tests read.
    ///
    /// Encoded on the wire (canopy K1): <see cref="ServedFile"/> keeps the bytes
    /// pre-compressed (brotli and gzip, computed once per build) with a strong
    /// ETag per representation, so the endpoint does not depend on Jellyfin's
    /// response compression (off for HTTPS by default, and at its fastest level).
    /// </summary>
    internal static class ClientScriptBundle
    {
        private const string ResourcePrefix = "Jellyfin.Plugin.JellyfinEnhanced.js.";
        // scripts/client-build.mjs `minDirectory`: min/js/<path> holds the minified twin of js/<path>.
        private const string MinResourcePrefix = "Jellyfin.Plugin.JellyfinEnhanced.min.js.";
        private const string ManifestResource = ResourcePrefix + "component-scripts.json";

        // Manifest paths are interpolated into a block comment and a JS string
        // literal, so only plain relative paths are accepted.
        private static readonly Regex SafePath = new(@"^[A-Za-z0-9_][A-Za-z0-9_./-]*\.js$", RegexOptions.Compiled);

        private static readonly object _lock = new();
        private static string[]? _manifest;
        private static (string CacheKey, ServedBundle Bundle)? _cached;

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

            using var stream = PackedResources.Open(Assembly.GetExecutingAssembly(), ManifestResource)
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
            var served = GetServedBundle(cacheKey, rebuild, logger);
            return (served.Script.Identity.Bytes, served.SourceMap.Identity.Bytes);
        }

        /// <summary>
        /// The bundle and its map as served: identity bytes plus their brotli and
        /// gzip encodings (see <see cref="ServedFile"/>). Same caching as
        /// <see cref="GetBundle"/>; a rebuild (dev mode) skips the background
        /// brotli upgrade, because its result would never be reused. The map is
        /// built when <see cref="ServedBundle.SourceMap"/> is first read.
        /// </summary>
        internal static ServedBundle GetServedBundle(string cacheKey, bool rebuild, Logger logger)
        {
            lock (_lock)
            {
                if (!rebuild && _cached.HasValue && _cached.Value.CacheKey == cacheKey)
                {
                    return _cached.Value.Bundle;
                }

                var (script, sections) = BuildScript(cacheKey, logger);
                var bundle = new ServedBundle(
                    new ServedFile(script, ServedFile.ScriptLevels, upgradeBrotli: !rebuild, logger),
                    new Lazy<ServedFile>(() => new ServedFile(BuildSourceMap(cacheKey, sections), ServedFile.MapLevels, upgradeBrotli: false, logger)));
                _cached = (cacheKey, bundle);
                return bundle;
            }
        }

        /// <summary>The bundle built fresh, bypassing (and leaving) the cache; for measurements such as the size budget.</summary>
        internal static (byte[] Script, byte[] SourceMap) BuildUncached(string cacheKey, Logger logger)
        {
            var (script, sections) = BuildScript(cacheKey, logger);
            return (script, BuildSourceMap(cacheKey, sections));
        }

        /// <summary>Where one module's content sits in the bundle; all the source map needs to be built later.</summary>
        private sealed class Section
        {
            public string Path { get; init; } = string.Empty;
            public int Line { get; init; }
            public int LineCount { get; init; }
            public bool Minified { get; init; }
        }

        private static (byte[] Script, IReadOnlyList<Section> Sections) BuildScript(string cacheKey, Logger logger)
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
                var minified = false;
                if (SafePath.IsMatch(path))
                {
                    content = ReadResource(assembly, MinResourcePrefix + path.Replace('/', '.'));
                    minified = content != null;
                    content ??= ReadResource(assembly, ResourcePrefix + path.Replace('/', '.'));
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

                Append($"/* ---- js/{path} ---- */\n(function () {{\n");
                var start = line;
                Append(content);
                if (!content.EndsWith('\n'))
                {
                    Append("\n");
                }
                sections.Add(new Section { Path = path, Line = start, LineCount = line - start, Minified = minified });
                Append("}),\n");
            }

            Append("];\n");
            Append($"//# sourceMappingURL=bundle.js.map?v={cacheKey}\n");

            return (Encoding.UTF8.GetBytes(sb.ToString()), sections);
        }

        /// <summary>The index map for a script built by <see cref="BuildScript"/>, from the embedded per-module maps.</summary>
        private static byte[] BuildSourceMap(string cacheKey, IReadOnlyList<Section> sections)
        {
            var assembly = Assembly.GetExecutingAssembly();
            var map = new
            {
                version = 3,
                file = "bundle.js",
                sections = sections.Select(s => new
                {
                    offset = new { line = s.Line, column = 0 },
                    map = (object?)(s.Minified ? ReadMinifiedSourceMap(assembly, s.Path) : ReadEmbeddedSourceMap(assembly, s.Path)) ?? new
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

            return JsonSerializer.SerializeToUtf8Bytes(map);
        }

        private static string? ReadResource(Assembly assembly, string name)
        {
            using var stream = PackedResources.Open(assembly, name);
            if (stream == null) return null;
            using var reader = new StreamReader(stream, Encoding.UTF8);
            return reader.ReadToEnd();
        }

        /// <summary>
        /// The twin's map, rebased like the readable one (the twin is built at the
        /// readable output's path, so its `sources` are the same relative paths),
        /// with sourcesContent taken from the readable map by source path. Null
        /// (a line-identity map is used instead) when the twin has no map.
        /// </summary>
        private static JsonObject? ReadMinifiedSourceMap(Assembly assembly, string path)
        {
            var map = ReadEmbeddedSourceMap(assembly, path, MinResourcePrefix);
            if (map == null) return null;
            var readable = ReadEmbeddedSourceMap(assembly, path, ResourcePrefix);
            var contents = new Dictionary<string, JsonNode?>(StringComparer.Ordinal);
            if (readable?["sourcesContent"] is JsonArray readableContent && readable["sources"] is JsonArray readableSources)
            {
                for (var i = 0; i < readableSources.Count && i < readableContent.Count; i++)
                {
                    contents[readableSources[i]!.GetValue<string>()] = readableContent[i]?.DeepClone();
                }
            }
            var sourcesContent = new JsonArray();
            foreach (var source in (JsonArray)map["sources"]!)
            {
                sourcesContent.Add(contents.TryGetValue(source!.GetValue<string>(), out var text) ? text : null);
            }
            map["sourcesContent"] = sourcesContent;
            return map;
        }

        private static JsonObject? ReadEmbeddedSourceMap(Assembly assembly, string path, string prefix = ResourcePrefix)
        {
            using var stream = PackedResources.Open(assembly, prefix + path.Replace('/', '.') + ".map");
            if (stream == null) return null;
            var map = JsonNode.Parse(stream) as JsonObject
                ?? throw new InvalidDataException($"Invalid embedded source map for {path}.");
            if (map["version"]?.GetValue<int>() != 3 || map["sources"] is not JsonArray sources
                || map["mappings"] is not JsonValue)
                throw new InvalidDataException($"Unsupported embedded source map for {path}.");

            // Maps move from js/<entry>.map into bundle.js.map. Resolve source paths
            // against their repository location, retaining embedded TypeScript text.
            var mapUri = new Uri("https://jellyfin-enhanced.invalid/Jellyfin.Plugin.JellyfinEnhanced/js/" + path + ".map");
            var sourceRoot = map["sourceRoot"]?.GetValue<string>() ?? "";
            var sourceBase = sourceRoot.Length == 0 ? mapUri : new Uri(mapUri, sourceRoot.TrimEnd('/') + "/");
            var rebased = new JsonArray();
            foreach (var source in sources)
            {
                var resolved = new Uri(sourceBase, source?.GetValue<string>()
                    ?? throw new InvalidDataException($"Missing source path in {path}.map."));
                if (resolved.Scheme != mapUri.Scheme || resolved.Host != mapUri.Host)
                    throw new InvalidDataException($"External source path in embedded map for {path}.");
                rebased.Add(Uri.UnescapeDataString(resolved.AbsolutePath.TrimStart('/')));
            }
            map["sources"] = rebased;
            map.Remove("sourceRoot");
            map["file"] = path;
            return map;
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

    /// <summary>The served bundle script and its source map (built when first read; see <see cref="ClientScriptBundle"/>).</summary>
    internal sealed record ServedBundle(ServedFile Script, Lazy<ServedFile> Map)
    {
        internal ServedFile SourceMap => Map.Value;
    }

    /// <summary>One representation of a <see cref="ServedFile"/>: its bytes, Content-Encoding (null = identity) and strong ETag.</summary>
    internal sealed record EncodedBody(byte[] Bytes, string? Encoding, string ETag);

    /// <summary>
    /// A static response body kept in identity, brotli and gzip form (canopy K1). Each
    /// encoding is computed on first use and kept; its ETag is a hash of the bytes sent,
    /// so every representation has its own strong validator. The script's brotli form is
    /// computed at quality 9 (about 0.1 s for the bundle) and, unless disabled, replaced in
    /// the background by quality 11 (several seconds of CPU, about 9% smaller), so the
    /// first page load never waits for the slow level.
    /// The bodies hold no secret and reflect no request input, so compressing them over
    /// HTTPS is safe (BREACH needs both).
    /// </summary>
    internal sealed class ServedFile
    {
        /// <summary>Brotli quality, final brotli quality (0 = no upgrade) and gzip level.</summary>
        internal readonly record struct Levels(int Brotli, int FinalBrotli, CompressionLevel Gzip);

        internal static readonly Levels ScriptLevels = new(9, 11, CompressionLevel.SmallestSize);
        // The map is fetched only with developer tools open: quick levels, no upgrade.
        internal static readonly Levels MapLevels = new(5, 0, CompressionLevel.Optimal);

        private const int BrotliWindow = 22;
        private readonly object _lock = new();
        private readonly Levels _levels;
        private readonly bool _upgradeBrotli;
        private readonly Logger _logger;
        private EncodedBody? _brotli;
        private EncodedBody? _gzip;

        internal ServedFile(byte[] bytes, Levels levels, bool upgradeBrotli, Logger logger)
        {
            Identity = new EncodedBody(bytes, null, ETagOf(bytes));
            _levels = levels;
            _upgradeBrotli = upgradeBrotli && levels.FinalBrotli > levels.Brotli;
            _logger = logger;
        }

        internal EncodedBody Identity { get; }

        /// <summary>Completes when the background brotli upgrade (if any) has finished; for tests.</summary>
        internal Task BrotliUpgrade { get; private set; } = Task.CompletedTask;

        internal EncodedBody Brotli
        {
            get
            {
                var current = Volatile.Read(ref _brotli);
                if (current != null) return current;
                lock (_lock)
                {
                    if (_brotli != null) return _brotli;
                    var body = Encode(BrotliBytes(Identity.Bytes, _levels.Brotli), "br");
                    Volatile.Write(ref _brotli, body);
                    if (_upgradeBrotli)
                    {
                        BrotliUpgrade = Task.Run(() =>
                        {
                            try
                            {
                                Volatile.Write(ref _brotli, Encode(BrotliBytes(Identity.Bytes, _levels.FinalBrotli), "br"));
                            }
                            catch (Exception ex)
                            {
                                _logger.Warning($"Component bundle: brotli quality {_levels.FinalBrotli} failed, keeping quality {_levels.Brotli}: {ex.Message}");
                            }
                        });
                    }
                    return body;
                }
            }
        }

        internal EncodedBody Gzip
        {
            get
            {
                var current = Volatile.Read(ref _gzip);
                if (current != null) return current;
                lock (_lock)
                {
                    if (_gzip != null) return _gzip;
                    using var output = new MemoryStream(Identity.Bytes.Length / 3);
                    using (var gzip = new GZipStream(output, _levels.Gzip, leaveOpen: true))
                    {
                        gzip.Write(Identity.Bytes);
                    }
                    var body = Encode(output.ToArray(), "gzip");
                    Volatile.Write(ref _gzip, body);
                    return body;
                }
            }
        }

        /// <summary>
        /// The representation for an Accept-Encoding header: brotli when acceptable and
        /// preferred at least as much as gzip, else gzip when acceptable, else identity.
        /// A coding is acceptable when listed (or matched by "*") with a q above 0.
        /// </summary>
        internal EncodedBody Select(string? acceptEncoding)
        {
            if (string.IsNullOrWhiteSpace(acceptEncoding)) return Identity;
            double? br = null, gzip = null, any = null;
            foreach (var part in acceptEncoding.Split(','))
            {
                var pieces = part.Split(';');
                var coding = pieces[0].Trim().ToLowerInvariant();
                var q = 1.0;
                foreach (var parameter in pieces.Skip(1))
                {
                    var pair = parameter.Split('=', 2);
                    if (pair.Length == 2 && pair[0].Trim().Equals("q", StringComparison.OrdinalIgnoreCase)
                        && !double.TryParse(pair[1].Trim(), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out q))
                    {
                        q = 0;
                    }
                }
                switch (coding)
                {
                    case "br": br = q; break;
                    case "gzip": case "x-gzip": gzip = q; break;
                    case "*": any = q; break;
                }
            }
            var brQ = br ?? any ?? 0;
            var gzipQ = gzip ?? any ?? 0;
            if (brQ > 0 && brQ >= gzipQ) return Brotli;
            if (gzipQ > 0) return Gzip;
            return Identity;
        }

        /// <summary>True when an If-None-Match header matches <paramref name="body"/>'s ETag (weak comparison, RFC 9110 13.1.2).</summary>
        internal static bool NotModified(string? ifNoneMatch, EncodedBody body)
        {
            if (string.IsNullOrWhiteSpace(ifNoneMatch)) return false;
            foreach (var raw in ifNoneMatch.Split(','))
            {
                var tag = raw.Trim();
                if (tag == "*") return true;
                if (tag.StartsWith("W/", StringComparison.Ordinal)) tag = tag[2..];
                if (tag == body.ETag) return true;
            }
            return false;
        }

        private static EncodedBody Encode(byte[] bytes, string encoding) => new(bytes, encoding, ETagOf(bytes));

        private static string ETagOf(byte[] bytes) => "\"" + Convert.ToHexString(SHA256.HashData(bytes), 0, 16).ToLowerInvariant() + "\"";

        private static byte[] BrotliBytes(byte[] source, int quality)
        {
            var buffer = new byte[BrotliEncoder.GetMaxCompressedLength(source.Length)];
            if (!BrotliEncoder.TryCompress(source, buffer, out var written, quality, BrotliWindow))
            {
                throw new InvalidOperationException("Brotli compression did not fit its maximum compressed length.");
            }
            return buffer.AsSpan(0, written).ToArray();
        }
    }

}
