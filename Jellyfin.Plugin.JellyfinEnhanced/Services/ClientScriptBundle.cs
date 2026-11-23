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
    ///
    /// Groups: js/component-groups.json assigns manifest modules to named groups
    /// (every module it does not list belongs to the implicit "core" group), so
    /// the client downloads and runs only the groups a page needs.
    /// GET /JellyfinEnhanced/bundle.js?g=a,b serves those groups in one script:
    /// one statement per group,
    ///   (window.__JE_BUNDLES = window.__JE_BUNDLES || {})["a"] = { total: n, modules: [ ...same function wrappers... ] };
    /// in the groups file's order ("core" first), each group's modules in
    /// manifest order. Without <c>g</c> the route serves the whole manifest in
    /// the single-array format above, unchanged.
    /// </summary>
    internal static class ClientScriptBundle
    {
        private const string ResourcePrefix = "Jellyfin.Plugin.JellyfinEnhanced.js.";
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
        private static ComponentGroup[]? _groups;
        private static (string CacheKey, byte[] Script, byte[] SourceMap)? _cached;
        private static string? _groupCacheKey;
        private static readonly Dictionary<string, GroupPiece> _groupPieces = new(StringComparer.Ordinal);
        private static readonly Dictionary<string, (byte[] Script, byte[] SourceMap)> _groupCombinations = new(StringComparer.Ordinal);

        /// <summary>
        /// One component group: its id, the groups whose modules must have run
        /// before its own, and its module paths (relative to js/) in manifest order.
        /// </summary>
        internal sealed record ComponentGroup(string Id, IReadOnlyList<string> After, IReadOnlyList<string> Scripts);

        /// <summary>One group's statement, built once: its bytes, line count and per-module map sections.</summary>
        private sealed class GroupPiece
        {
            public byte[] Script { get; init; } = Array.Empty<byte>();
            public int LineCount { get; init; }
            public List<Section> Sections { get; init; } = new();
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

            using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(GroupsResource)
                ?? throw new InvalidOperationException("Embedded component-group file js/component-groups.json is missing.");
            using var document = JsonDocument.Parse(stream);
            groups = ResolveGroups(GetComponentScripts(), document.RootElement);
            _groups = groups;
            return groups;
        }

        /// <summary>
        /// The <c>groups</c> array of js/component-groups.json exactly as written
        /// (ids, <c>after</c> and module lists), for the bootstrap payload: the
        /// client resolves it against the manifest the same way this class does.
        /// Validated first, so a file this class rejects is never handed out.
        /// </summary>
        internal static JsonElement GetComponentGroupsDocument()
        {
            GetComponentGroups();
            using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(GroupsResource)
                ?? throw new InvalidOperationException("Embedded component-group file js/component-groups.json is missing.");
            using var document = JsonDocument.Parse(stream);
            return document.RootElement.GetProperty("groups").Clone();
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
        /// Returns one script holding the given groups, and its source map. The ids
        /// must come from <see cref="ParseGroupRequest"/>. Each group's statement is
        /// built once per cache key; a combination is assembled from those pieces
        /// and the most recent few are kept. <paramref name="rebuild"/> (dev mode)
        /// bypasses both caches.
        /// </summary>
        internal static (byte[] Script, byte[] SourceMap) GetGroupBundle(string cacheKey, IReadOnlyList<string> groupIds, bool rebuild, Logger logger)
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

                var built = Assemble(cacheKey, combination, pieces);
                if (_groupCombinations.Count >= MaxCachedCombinations)
                {
                    _groupCombinations.Clear();
                }

                _groupCombinations[combination] = built;
                return built;
            }
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
            /// Appends one manifest module wrapped in a function (an array element),
            /// recording its source-map section. A path that is not an embedded
            /// resource becomes a function that reports the load error, mirroring
            /// the per-file loader, which logs it and carries on with the next one.
            /// </summary>
            public void AppendModule(Assembly assembly, string path, Logger logger)
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
                    logger.Warning($"Component bundle: '{path}' is listed in js/component-scripts.json but is not an embedded resource; skipping.");
                    Append($"/* ---- js/{path} (missing) ---- */\n");
                    Append($"function () {{ console.error(\"🪼 Jellyfin Enhanced: Failed to load script '{path}' (not found in bundle)\"); }},\n");
                    return;
                }

                Append($"/* ---- js/{path} ---- */\nfunction () {{\n");
                var start = Line;
                Append(content);
                if (!content.EndsWith('\n'))
                {
                    Append("\n");
                }

                Sections.Add(new Section { Path = path, Line = start, LineCount = Line - start });
                Append("},\n");
            }

            public byte[] ToBytes() => Encoding.UTF8.GetBytes(_text.ToString());
        }

        private static (byte[] Script, byte[] SourceMap) Build(string cacheKey, Logger logger)
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

            return (writer.ToBytes(), SerializeSourceMap(cacheKey, writer.Sections));
        }

        /// <summary>
        /// Builds one group's statement. Its sections' lines are relative to the
        /// statement's first line; <see cref="Assemble"/> shifts them.
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
            return new GroupPiece { Script = writer.ToBytes(), LineCount = writer.Line, Sections = writer.Sections };
        }

        /// <summary>
        /// Joins group statements into one script (a header line, the statements,
        /// the sourceMappingURL line) and builds the matching index source map.
        /// </summary>
        private static (byte[] Script, byte[] SourceMap) Assemble(string cacheKey, string combination, List<GroupPiece> pieces)
        {
            var header = Encoding.UTF8.GetBytes($"/* Jellyfin Enhanced component groups {combination} — generated from js/component-scripts.json and js/component-groups.json */\n");
            var trailer = Encoding.UTF8.GetBytes($"//# sourceMappingURL=bundle.js.map?g={combination}&v={cacheKey}\n");
            var script = new byte[header.Length + pieces.Sum(piece => piece.Script.Length) + trailer.Length];
            var offset = 0;

            void Copy(byte[] bytes)
            {
                Buffer.BlockCopy(bytes, 0, script, offset, bytes.Length);
                offset += bytes.Length;
            }

            Copy(header);
            var sections = new List<Section>();
            var line = 1; // the header is one line
            foreach (var piece in pieces)
            {
                Copy(piece.Script);
                sections.AddRange(piece.Sections.Select(section => new Section { Path = section.Path, Line = line + section.Line, LineCount = section.LineCount }));
                line += piece.LineCount;
            }

            Copy(trailer);
            return (script, SerializeSourceMap(cacheKey, sections));
        }

        /// <summary>
        /// The index source map ("sections") for a generated script: one
        /// line-identity section per module, pointing at its original file.
        /// </summary>
        private static byte[] SerializeSourceMap(string cacheKey, List<Section> sections)
        {
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

            return JsonSerializer.SerializeToUtf8Bytes(map);
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
