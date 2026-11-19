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
using Jellyfin.Plugin.JellyfinEnhanced.Transport;

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
    ///
    /// Groups (upstream abcaa16d): js/component-groups.json assigns manifest modules
    /// to named groups (every module it does not list belongs to the implicit "core"
    /// group), so the client downloads and runs only the groups a page needs.
    /// GET /JellyfinEnhanced/bundle.js?g=a,b serves those groups in one script, one
    /// statement per group,
    ///   (window.__JE_BUNDLES = window.__JE_BUNDLES || {})["a"] = { total: n, modules: [ ...the same function wrappers... ] };
    /// in the groups file's order ("core" first), each group's modules in manifest
    /// order, with the matching index map at bundle.js.map?g=a,b. Each group's
    /// statement is built once per cache key and the last few combinations are kept,
    /// served like the whole bundle (pre-compressed, map built on first request).
    /// Without <c>g</c> the route serves the whole manifest in the single-array
    /// format above, unchanged.
    /// </summary>
    internal static class ClientScriptBundle
    {
        private const string ResourcePrefix = "Jellyfin.Plugin.JellyfinEnhanced.js.";
        // scripts/client-build.mjs `minDirectory`: min/js/<path> holds the minified twin of js/<path>.
        private const string MinResourcePrefix = "Jellyfin.Plugin.JellyfinEnhanced.min.js.";
        private const string ManifestResource = ResourcePrefix + "component-scripts.json";
        private const string GroupsResource = ResourcePrefix + "component-groups.json";

        /// <summary>The implicit group holding every manifest module no listed group claims.</summary>
        internal const string CoreGroupId = "core";

        /// <summary>Most group ids one bundle request may name.</summary>
        internal const int MaxGroupsPerRequest = 64;

        // Most distinct group combinations kept assembled; the per-group pieces are always kept.
        private const int MaxCachedCombinations = 24;

        // Group ids are interpolated into a JS string literal and a URL query.
        private static readonly Regex SafeGroupId = new(@"^[a-z][a-z0-9-]{0,39}$", RegexOptions.Compiled);

        // Manifest paths are interpolated into a block comment and a JS string
        // literal, so only plain relative paths are accepted.
        private static readonly Regex SafePath = new(@"^[A-Za-z0-9_][A-Za-z0-9_./-]*\.js$", RegexOptions.Compiled);

        private static readonly object _lock = new();
        private static string[]? _manifest;
        private static (string CacheKey, ServedBundle Bundle)? _cached;
        private static ComponentGroup[]? _groups;
        private static string? _groupCacheKey;
        private static readonly Dictionary<string, GroupPiece> _groupPieces = new(StringComparer.Ordinal);
        private static readonly Dictionary<string, ServedBundle> _groupCombinations = new(StringComparer.Ordinal);

        /// <summary>
        /// One component group: its id, the groups whose modules must have run
        /// before its own, and its module paths (relative to js/) in manifest order.
        /// </summary>
        internal sealed record ComponentGroup(string Id, IReadOnlyList<string> After, IReadOnlyList<string> Scripts);

        /// <summary>One group's statement, built once per cache key: its text, line count and per-module sections.</summary>
        private sealed class GroupPiece
        {
            public string Text { get; init; } = string.Empty;
            public int LineCount { get; init; }
            public IReadOnlyList<Section> Sections { get; init; } = Array.Empty<Section>();
        }

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
        /// The component groups, "core" first and then in the order of
        /// js/component-groups.json. "core" holds every manifest module that no
        /// listed group claims. Throws when the groups file is missing or invalid
        /// (unknown or duplicated module, bad id, an <c>after</c> that does not
        /// name an earlier group); callers then fall back to the whole manifest.
        /// </summary>
        internal static IReadOnlyList<ComponentGroup> GetComponentGroups()
        {
            var groups = _groups;
            if (groups != null)
            {
                return groups;
            }

            using var document = ReadGroupsFile();
            groups = ResolveGroups(GetComponentScripts(), document.RootElement);
            _groups = groups;
            return groups;
        }

        /// <summary>
        /// The <c>groups</c> array of js/component-groups.json as written (ids,
        /// <c>after</c> and module lists, without the notes), for the bootstrap
        /// payload: the client resolves it against the manifest the same way this
        /// class does. Validated first, so a file this class rejects is never handed out.
        /// </summary>
        internal static IReadOnlyList<BootstrapComponentGroup> GetComponentGroupsDocument()
        {
            GetComponentGroups();
            using var document = ReadGroupsFile();
            return document.RootElement.GetProperty("groups").EnumerateArray().Select(entry => new BootstrapComponentGroup
            {
                Id = entry.GetProperty("id").GetString()!,
                After = entry.TryGetProperty("after", out var after) ? after.EnumerateArray().Select(name => name.GetString()!).ToArray() : null,
                Modules = entry.GetProperty("modules").EnumerateArray().Select(module => module.GetString()!).ToArray(),
            }).ToArray();
        }

        private static JsonDocument ReadGroupsFile()
        {
            using var stream = PackedResources.Open(Assembly.GetExecutingAssembly(), GroupsResource)
                ?? throw new InvalidOperationException("Embedded component-group file js/component-groups.json is missing.");
            return JsonDocument.Parse(stream);
        }

        /// <summary>
        /// Resolves a parsed groups file against the manifest. Internal so tests
        /// can feed it malformed files.
        /// </summary>
        internal static ComponentGroup[] ResolveGroups(IReadOnlyList<string> manifest, JsonElement root)
        {
            if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("groups", out var list) || list.ValueKind != JsonValueKind.Array)
            {
                throw new InvalidOperationException("js/component-groups.json must be an object with a \"groups\" array.");
            }

            var position = new Dictionary<string, int>(StringComparer.Ordinal);
            for (var i = 0; i < manifest.Count; i++)
            {
                position[manifest[i]] = i;
            }

            var owner = new Dictionary<string, string>(StringComparer.Ordinal);
            var seen = new HashSet<string>(StringComparer.Ordinal) { CoreGroupId };
            var resolved = new List<ComponentGroup>();
            foreach (var entry in list.EnumerateArray())
            {
                var id = entry.ValueKind == JsonValueKind.Object && entry.TryGetProperty("id", out var idElement) && idElement.ValueKind == JsonValueKind.String
                    ? idElement.GetString() ?? string.Empty
                    : string.Empty;
                if (!SafeGroupId.IsMatch(id))
                {
                    throw new InvalidOperationException($"js/component-groups.json: '{id}' is not a valid group id.");
                }

                if (!seen.Add(id))
                {
                    throw new InvalidOperationException($"js/component-groups.json: group '{id}' is defined twice (\"{CoreGroupId}\" is implicit).");
                }

                var after = new List<string>();
                if (entry.TryGetProperty("after", out var afterElement))
                {
                    if (afterElement.ValueKind != JsonValueKind.Array)
                    {
                        throw new InvalidOperationException($"js/component-groups.json: group '{id}' has an \"after\" that is not an array.");
                    }

                    foreach (var dependency in afterElement.EnumerateArray())
                    {
                        var name = dependency.ValueKind == JsonValueKind.String ? dependency.GetString() ?? string.Empty : string.Empty;
                        // Only earlier groups: the file order is then a valid run order and cannot hold a cycle.
                        if (name == id || !seen.Contains(name))
                        {
                            throw new InvalidOperationException($"js/component-groups.json: group '{id}' is after '{name}', which is not an earlier group.");
                        }

                        if (name != CoreGroupId && !after.Contains(name))
                        {
                            after.Add(name);
                        }
                    }
                }

                if (!entry.TryGetProperty("modules", out var modulesElement) || modulesElement.ValueKind != JsonValueKind.Array)
                {
                    throw new InvalidOperationException($"js/component-groups.json: group '{id}' has no \"modules\" array.");
                }

                var scripts = new List<string>();
                foreach (var module in modulesElement.EnumerateArray())
                {
                    var path = module.ValueKind == JsonValueKind.String ? (module.GetString() ?? string.Empty).Trim() : string.Empty;
                    if (!position.ContainsKey(path))
                    {
                        throw new InvalidOperationException($"js/component-groups.json: group '{id}' lists '{path}', which is not in js/component-scripts.json.");
                    }

                    if (owner.TryGetValue(path, out var other))
                    {
                        throw new InvalidOperationException($"js/component-groups.json: '{path}' is listed in both '{other}' and '{id}'.");
                    }

                    owner[path] = id;
                    scripts.Add(path);
                }

                if (scripts.Count == 0)
                {
                    throw new InvalidOperationException($"js/component-groups.json: group '{id}' lists no modules.");
                }

                scripts.Sort((a, b) => position[a].CompareTo(position[b]));
                resolved.Add(new ComponentGroup(id, after, scripts));
            }

            var core = manifest.Where(path => !owner.ContainsKey(path)).ToArray();
            resolved.Insert(0, new ComponentGroup(CoreGroupId, Array.Empty<string>(), core));
            return resolved.ToArray();
        }

        /// <summary>
        /// Parses the <c>g</c> query value of a bundle request ("a,b,c") into known
        /// group ids in serving order ("core" first, then the groups file's order).
        /// Returns null for anything else: empty, an unknown or repeated id, or
        /// more than <see cref="MaxGroupsPerRequest"/> ids.
        /// </summary>
        internal static IReadOnlyList<string>? ParseGroupRequest(string? value)
        {
            if (string.IsNullOrEmpty(value) || value.Length > 4096)
            {
                return null;
            }

            var requested = value.Split(',');
            if (requested.Length > MaxGroupsPerRequest)
            {
                return null;
            }

            var groups = GetComponentGroups();
            var wanted = new HashSet<string>(StringComparer.Ordinal);
            foreach (var id in requested)
            {
                if (!groups.Any(group => group.Id == id) || !wanted.Add(id))
                {
                    return null;
                }
            }

            return groups.Where(group => wanted.Contains(group.Id)).Select(group => group.Id).ToArray();
        }

        /// <summary>
        /// One script holding the given groups, and its source map (identity bytes).
        /// The ids must come from <see cref="ParseGroupRequest"/>. Same caching as
        /// <see cref="GetServedGroupBundle"/>.
        /// </summary>
        internal static (byte[] Script, byte[] SourceMap) GetGroupBundle(string cacheKey, IReadOnlyList<string> groupIds, bool rebuild, Logger logger)
        {
            var served = GetServedGroupBundle(cacheKey, groupIds, rebuild, logger);
            return (served.Script.Identity.Bytes, served.SourceMap.Identity.Bytes);
        }

        /// <summary>
        /// The groups' script and its map as served (see <see cref="ServedFile"/>).
        /// Each group's statement is built once per cache key; a combination is
        /// assembled from those pieces and the most recent few are kept.
        /// <paramref name="rebuild"/> (dev mode) bypasses both caches.
        /// </summary>
        internal static ServedBundle GetServedGroupBundle(string cacheKey, IReadOnlyList<string> groupIds, bool rebuild, Logger logger)
        {
            var combination = string.Join(',', groupIds);
            lock (_lock)
            {
                if (rebuild || _groupCacheKey != cacheKey)
                {
                    _groupPieces.Clear();
                    _groupCombinations.Clear();
                    _groupCacheKey = cacheKey;
                }

                if (_groupCombinations.TryGetValue(combination, out var assembled))
                {
                    return assembled;
                }

                var groups = GetComponentGroups();
                var pieces = new List<GroupPiece>(groupIds.Count);
                foreach (var id in groupIds)
                {
                    if (!_groupPieces.TryGetValue(id, out var piece))
                    {
                        var group = groups.FirstOrDefault(candidate => candidate.Id == id)
                            ?? throw new InvalidOperationException($"Unknown component group '{id}'.");
                        piece = BuildGroupPiece(group, logger);
                        _groupPieces[id] = piece;
                    }

                    pieces.Add(piece);
                }

                var (script, sections) = AssembleGroups(cacheKey, combination, pieces);
                var bundle = new ServedBundle(
                    new ServedFile(script, ServedFile.ScriptLevels, upgradeBrotli: !rebuild, logger),
                    new Lazy<ServedFile>(() => new ServedFile(BuildSourceMap(cacheKey, sections), ServedFile.MapLevels, upgradeBrotli: false, logger)));
                if (rebuild)
                {
                    return bundle;
                }

                if (_groupCombinations.Count >= MaxCachedCombinations)
                {
                    _groupCombinations.Clear();
                }

                _groupCombinations[combination] = bundle;
                return bundle;
            }
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

        /// <summary>
        /// Accumulates generated script text while keeping the exact 0-based index
        /// of the line the next append starts on, so each source-map section's
        /// offset matches the generated script.
        /// </summary>
        private sealed class ScriptWriter
        {
            private readonly StringBuilder _text;

            public ScriptWriter(int capacity)
            {
                _text = new StringBuilder(capacity);
            }

            public int Line { get; private set; }

            public List<Section> Sections { get; } = new();

            public void Append(string text)
            {
                _text.Append(text);
                foreach (var c in text)
                {
                    if (c == '\n') Line++;
                }
            }

            /// <summary>
            /// Appends one manifest module wrapped in a parenthesized function (an
            /// array element), recording its source-map section: its minified twin
            /// when there is one, else the readable file. A path that is not an
            /// embedded resource becomes a function that reports the load error,
            /// mirroring the per-file loader, which logs it and carries on.
            /// </summary>
            public void AppendModule(Assembly assembly, string path, Logger logger)
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
                    logger.Warning($"Component bundle: '{path}' is listed in js/component-scripts.json but is not an embedded resource; skipping.");
                    Append($"/* ---- js/{path} (missing) ---- */\n");
                    Append($"function () {{ console.error(\"🪼 Jellyfin Enhanced: Failed to load script '{path}' (not found in bundle)\"); }},\n");
                    return;
                }

                Append($"/* ---- js/{path} ---- */\n(function () {{\n");
                var start = Line;
                Append(content);
                if (!content.EndsWith('\n'))
                {
                    Append("\n");
                }

                Sections.Add(new Section { Path = path, Line = start, LineCount = Line - start, Minified = minified });
                Append("}),\n");
            }

            public override string ToString() => _text.ToString();
        }

        private static (byte[] Script, IReadOnlyList<Section> Sections) BuildScript(string cacheKey, Logger logger)
        {
            var scripts = GetComponentScripts();
            var assembly = Assembly.GetExecutingAssembly();
            var writer = new ScriptWriter(2 * 1024 * 1024);

            writer.Append("/* Jellyfin Enhanced component bundle — generated from js/component-scripts.json */\n");
            writer.Append($"window.__JE_BUNDLE_TOTAL = {scripts.Count};\n");
            writer.Append("window.__JE_BUNDLE_PROGRESS = 0;\n");
            writer.Append("window.__JE_BUNDLE_MODULES = [\n");

            foreach (var path in scripts)
            {
                writer.AppendModule(assembly, path, logger);
            }

            writer.Append("];\n");
            writer.Append($"//# sourceMappingURL=bundle.js.map?v={cacheKey}\n");

            return (Encoding.UTF8.GetBytes(writer.ToString()), writer.Sections);
        }

        /// <summary>
        /// Builds one group's statement. Its sections' lines are relative to the
        /// statement's first line; <see cref="AssembleGroups"/> shifts them.
        /// </summary>
        private static GroupPiece BuildGroupPiece(ComponentGroup group, Logger logger)
        {
            var assembly = Assembly.GetExecutingAssembly();
            var writer = new ScriptWriter(256 * 1024);
            writer.Append($"(window.__JE_BUNDLES = window.__JE_BUNDLES || {{}})[\"{group.Id}\"] = {{ total: {group.Scripts.Count}, modules: [\n");
            foreach (var path in group.Scripts)
            {
                writer.AppendModule(assembly, path, logger);
            }

            writer.Append("] };\n");
            return new GroupPiece { Text = writer.ToString(), LineCount = writer.Line, Sections = writer.Sections };
        }

        /// <summary>
        /// Joins group statements into one script (a header line, the statements,
        /// the sourceMappingURL line) and the sections of its index source map.
        /// </summary>
        private static (byte[] Script, IReadOnlyList<Section> Sections) AssembleGroups(string cacheKey, string combination, List<GroupPiece> pieces)
        {
            var text = new StringBuilder(pieces.Sum(piece => piece.Text.Length) + 256);
            text.Append($"/* Jellyfin Enhanced component groups {combination} — generated from js/component-scripts.json and js/component-groups.json */\n");
            var sections = new List<Section>();
            var line = 1; // the header is one line
            foreach (var piece in pieces)
            {
                text.Append(piece.Text);
                sections.AddRange(piece.Sections.Select(section => new Section { Path = section.Path, Line = line + section.Line, LineCount = section.LineCount, Minified = section.Minified }));
                line += piece.LineCount;
            }

            text.Append($"//# sourceMappingURL=bundle.js.map?g={combination}&v={cacheKey}\n");
            return (Encoding.UTF8.GetBytes(text.ToString()), sections);
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
