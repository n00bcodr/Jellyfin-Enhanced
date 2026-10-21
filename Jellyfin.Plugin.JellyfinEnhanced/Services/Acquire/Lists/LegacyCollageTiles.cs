using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using Jellyfin.Data.Enums;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists
{
    /// <summary>What JE knows about the sources of one library tile composition.</summary>
    internal enum LegacyCollageSource
    {
        /// <summary>Proven not to be a collage: its content is no collage a marker recorded and no tile built from one.</summary>
        Clean = 0,

        /// <summary>Couldn't be told (its list's marker couldn't be read, the markers couldn't be listed, or it couldn't be read).</summary>
        Unresolved = 1,

        /// <summary>A collage a marker recorded, or a tile proven or suspected to hold one.</summary>
        Contaminated = 2,
    }

    /// <summary>
    /// The host composes the playlist and collection library tiles from list images and keeps a tile for days, so a tile
    /// built while a list was a collage holds the collage's pixels after the list's image is replaced, and after a
    /// restart. JE's record (one small JSON file of its own; never an image or a marker) of the evidence about tiles:
    /// <list type="bullet">
    /// <item>While any list of the kind is withheld, every tile of that kind is (the view's live rule).</item>
    /// <item>Compositions: for each tile content the host composed while JE watched (<see cref="LegacyCollageCompositions"/>),
    /// the sources it read (each one's content hash and verdict) and the composition's verdict. A tile is released only
    /// when its content is a composition of sources all proven clean; one composed from a collage is contaminated for good.
    /// Time proves nothing: a tile's dates are never evidence.</item>
    /// <item>History: the kinds of list that ever had a marker (or all of them, when the record couldn't be read). A tile of
    /// such a kind with no clean composition is unresolved, and withheld; a kind without history is the host's business.</item>
    /// <item>Suspects: tile contents the host wrote while a list of their kind was proven to be a collage (seen then,
    /// written no earlier than the collage). Withheld whatever their time unless a clean composition proves those very
    /// bytes clean.</item>
    /// <item>Nothing is evicted but clean or unresolved compositions (the oldest first; that only withholds more): past
    /// capacity every tile of both kinds is withheld from then on (logged).</item>
    /// <item>The record is read strictly (every field present and well formed, nothing else); a record that isn't is
    /// recovered entry by entry (every complete entry that can be told for what it is) and history becomes unknown for
    /// both kinds. A record that exists but can't be opened is never overwritten (read again shortly); retrying it adds
    /// no evidence, so nothing it decided changes.</item>
    /// </list>
    /// </summary>
    internal sealed class LegacyCollageTiles
    {
        /// <summary>How much earlier than a collage a tile may have been written and still count as written while it was
        /// there (coarse file times).</summary>
        public static readonly TimeSpan FileTimeSlack = TimeSpan.FromSeconds(2);

        /// <summary>Most tile contents the record keeps as suspects; past that every tile is withheld.</summary>
        internal const int MaxTileHashes = 4096;

        /// <summary>Most compositions the record keeps (clean and unresolved ones make room, oldest first).</summary>
        internal const int MaxCompositions = 1024;

        /// <summary>Most sources kept per composition (its verdict covers every source; the rest are counted).</summary>
        internal const int MaxInputs = 64;

        private const long MaxRecordBytes = 16 * 1024 * 1024;
        private const int CurrentVersion = 3;
        private static readonly TimeSpan RetryUnopenable = TimeSpan.FromSeconds(5);
        private static readonly string[] Kinds = { nameof(BaseItemKind.BoxSet), nameof(BaseItemKind.Playlist) };

        private readonly string _path;
        private readonly Action<string>? _warn;
        private readonly object _lock = new();
        private State? _record;
        private long? _unopenableAt;
        private readonly HashSet<string> _warned = new(StringComparer.Ordinal);

        public LegacyCollageTiles(string path, Action<string>? warn)
        {
            _path = path;
            _warn = warn;
        }

        /// <summary>True when the record holds anything (then tiles need judging even with no marker left).</summary>
        public bool HasHistory
        {
            get
            {
                lock (_lock)
                {
                    var record = Load();
                    return record.History.Count > 0 || record.Tiles.Count > 0 || record.Compositions.Count > 0 || record.Saturated;
                }
            }
        }

        /// <summary>True when the record is past its capacity: every library tile of both kinds is withheld.</summary>
        public bool Saturated
        {
            get
            {
                lock (_lock)
                {
                    return Load().Saturated;
                }
            }
        }

        /// <summary>Records that a list of this kind has (or had) a marker: its tiles need proof from then on.</summary>
        /// <param name="kind">Playlist or BoxSet.</param>
        public void Observe(BaseItemKind kind)
        {
            lock (_lock)
            {
                var record = Load();
                if (record.History.Add(kind.ToString()))
                {
                    Changed(record);
                }
            }
        }

        /// <summary>True when a list of this kind has (or had) a marker, or the record's history is unknown.</summary>
        /// <param name="kind">Playlist or BoxSet.</param>
        /// <returns>Whether it does.</returns>
        public bool HasHistoryFor(BaseItemKind kind)
        {
            lock (_lock)
            {
                return Load().History.Contains(kind.ToString());
            }
        }

        /// <summary>Remembers a tile content written while a list of its kind was proven to be a collage (never forgotten).</summary>
        /// <param name="sha">The tile file's SHA-256.</param>
        public void Record(string sha)
        {
            if (!LegacyCollageWithhold.IsHash(sha))
            {
                return;
            }

            lock (_lock)
            {
                var record = Load();
                if (record.Tiles.Contains(sha))
                {
                    return;
                }

                if (record.Tiles.Count >= MaxTileHashes)
                {
                    // Nothing suspect is ever dropped to make room: from here on every tile is withheld.
                    if (Saturate(record, "more contaminated tiles than it can keep"))
                    {
                        Changed(record);
                    }

                    return;
                }

                record.Tiles.Add(sha);
                Changed(record);
            }
        }

        /// <summary>Records a tile content the host composed while JE watched, with the sources it read.</summary>
        /// <param name="sha">The composed file's SHA-256.</param>
        /// <param name="inputs">Each source in the order the host was given them: its content hash (null when it couldn't be read) and verdict.</param>
        /// <returns>The composition's verdict.</returns>
        public LegacyCollageSource Composed(string sha, IReadOnlyList<(string? Sha, LegacyCollageSource Verdict)> inputs)
        {
            var verdict = inputs.Count == 0 ? LegacyCollageSource.Unresolved : inputs.Max(i => i.Verdict);
            if (!LegacyCollageWithhold.IsHash(sha))
            {
                return verdict;
            }

            var composition = new Composition(verdict, inputs.Take(MaxInputs).ToList(), Math.Max(0, inputs.Count - MaxInputs));
            lock (_lock)
            {
                var record = Load();
                if (Put(record, sha, composition))
                {
                    Changed(record);
                }

                return record.Compositions.TryGetValue(sha, out var kept) ? kept.Verdict : verdict;
            }
        }

        /// <summary>What the record says about a tile content: a composition's verdict, or null when none was seen.</summary>
        /// <param name="sha">The tile file's SHA-256.</param>
        /// <returns>The verdict, or null.</returns>
        public LegacyCollageSource? CompositionOf(string sha)
        {
            lock (_lock)
            {
                return Load().Compositions.TryGetValue(sha, out var composition) ? composition.Verdict : null;
            }
        }

        /// <summary>True when a tile with this content is suspect or composed from a collage (or the record is past capacity).</summary>
        /// <param name="sha">The tile file's SHA-256.</param>
        /// <returns>Whether it is.</returns>
        public bool Contaminated(string sha)
        {
            lock (_lock)
            {
                var record = Load();
                return record.Saturated || record.Tiles.Contains(sha)
                    || (record.Compositions.TryGetValue(sha, out var composition) && composition.Verdict == LegacyCollageSource.Contaminated);
            }
        }

        // Keeps a composition; the same content seen again keeps the strongest evidence: contaminated, then clean, then
        // unresolved. Only clean and unresolved ones make room.
        private bool Put(State record, string sha, Composition composition)
        {
            if (record.Compositions.TryGetValue(sha, out var known))
            {
                if (Stronger(composition.Verdict, known.Verdict))
                {
                    record.Compositions[sha] = composition;
                    return true;
                }

                return false;
            }

            if (record.Compositions.Count >= MaxCompositions)
            {
                var room = record.Compositions.FirstOrDefault(p => p.Value.Verdict != LegacyCollageSource.Contaminated).Key;
                if (room == null)
                {
                    return Saturate(record, "more tiles composed from collages than it can keep");
                }

                record.Compositions.Remove(room);
            }

            record.Compositions.Add(sha, composition);
            return true;
        }

        private static bool Stronger(LegacyCollageSource candidate, LegacyCollageSource known)
            => known != LegacyCollageSource.Contaminated && candidate != known && (candidate == LegacyCollageSource.Contaminated || candidate == LegacyCollageSource.Clean);

        private bool Saturate(State record, string why)
        {
            if (record.Saturated)
            {
                return false;
            }

            record.Saturated = true;
            Warn("full", $"[Lists] The record of library tiles built from legacy collages holds {why}; every playlist and collection library tile is withheld from now on (remove {Path.GetFileName(_path)} to start over).");
            return true;
        }

        private void Changed(State record) => Save(record);

        private State Load()
        {
            if (_record != null && (_unopenableAt is not { } at || Environment.TickCount64 - at < (long)RetryUnopenable.TotalMilliseconds))
            {
                return _record;
            }

            byte[] bytes;
            try
            {
                using var stream = new FileStream(_path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                if (stream.Length > MaxRecordBytes)
                {
                    // Not one JE wrote: kept as it is, like one that can't be opened.
                    return Adopt(Unknown("too large"), opened: false);
                }

                bytes = new byte[stream.Length];
                stream.ReadExactly(bytes);
            }
            catch (Exception ex) when (ex is FileNotFoundException or DirectoryNotFoundException && LegacyCollageWithhold.ShownAbsent(_path, LegacyCollageWithhold.ListNow))
            {
                return Adopt(new State(), opened: true);
            }
            catch (Exception ex) when (LegacyCollageWithhold.IsFileError(ex) || ex is EndOfStreamException)
            {
                // There (or not shown absent) yet not readable now: unknown history, the file left as it is, read again soon.
                return Adopt(Unknown(ex.GetType().Name), opened: false);
            }

            // A record read again after it couldn't be opened: what JE saw meanwhile is written into it at once (a restart
            // before the next change would otherwise lose it).
            var blind = _record != null && _unopenableAt != null;
            State adopted;
            if (Parse(bytes) is { } parsed)
            {
                adopted = Adopt(parsed, opened: true);
            }
            else
            {
                // Opened but not understood: every complete entry it still holds is kept; history is unknown for both kinds.
                var recovered = Unknown(Version(bytes) is { } v && v != CurrentVersion ? "an older format" : "not understood");
                Recover(bytes, recovered);
                adopted = Adopt(recovered, opened: true);
            }

            if (blind)
            {
                Save(adopted);
            }

            return adopted;
        }

        // Takes a state read now as the record. What this process already knows is never dropped for it, and a state read
        // again (an unopenable record retried) adds nothing it didn't hold: sets are joined, the stronger evidence wins.
        private State Adopt(State read, bool opened)
        {
            _unopenableAt = opened ? null : Environment.TickCount64;
            if (_record == null)
            {
                return _record = read;
            }

            var known = _record;
            known.Saturated |= read.Saturated;
            known.History.UnionWith(read.History);
            foreach (var sha in read.Tiles)
            {
                if (!known.Tiles.Contains(sha))
                {
                    if (known.Tiles.Count >= MaxTileHashes)
                    {
                        Saturate(known, "more contaminated tiles than it can keep");
                        break;
                    }

                    known.Tiles.Add(sha);
                }
            }

            foreach (var (sha, composition) in read.Compositions)
            {
                Put(known, sha, composition);
            }

            return known;
        }

        // History unknown: every tile of either kind needs proof. Whatever the bytes still hold is recovered by the caller.
        private State Unknown(string why)
        {
            Warn("read", $"[Lists] The record of library tiles built from legacy collages couldn't be read ({why}); playlist and collection library tiles are withheld until the host regenerates them from clean list images.");
            var record = new State();
            record.History.UnionWith(Kinds);
            return record;
        }

        private static int? Version(byte[] bytes)
        {
            try
            {
                using var doc = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 8 });
                return doc.RootElement.ValueKind == JsonValueKind.Object && doc.RootElement.TryGetProperty("version", out var v) && v.TryGetInt32(out var n) ? n : null;
            }
            catch (JsonException)
            {
                return null;
            }
        }

        // ── strict reading ──────────────────────────────────────────────────

        /// <summary>
        /// The record, read strictly: one JSON object with exactly <c>version</c> (3), <c>history</c>, <c>tiles</c>,
        /// <c>compositions</c> and <c>saturated</c>, each present once and well formed; anything else is null.
        /// </summary>
        /// <param name="bytes">The file's bytes.</param>
        /// <returns>The record, or null.</returns>
        internal static State? Parse(byte[] bytes)
        {
            try
            {
                using var doc = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 8 });
                var root = doc.RootElement;
                if (root.ValueKind != JsonValueKind.Object || Members(root) is not { Count: 5 } members
                    || !members.TryGetValue("version", out var version) || version.ValueKind != JsonValueKind.Number || !version.TryGetInt32(out var v) || v != CurrentVersion
                    || !members.TryGetValue("saturated", out var saturated) || saturated.ValueKind is not (JsonValueKind.True or JsonValueKind.False)
                    || !members.TryGetValue("history", out var history) || history.ValueKind != JsonValueKind.Array
                    || !members.TryGetValue("tiles", out var tiles) || tiles.ValueKind != JsonValueKind.Array
                    || !members.TryGetValue("compositions", out var compositions) || compositions.ValueKind != JsonValueKind.Object
                    || Members(compositions) is not { } entries || entries.Count > MaxCompositions)
                {
                    return null;
                }

                var record = new State { Saturated = saturated.GetBoolean() };
                foreach (var kind in history.EnumerateArray())
                {
                    if (kind.ValueKind != JsonValueKind.String || kind.GetString() is not { } name || !Kinds.Contains(name, StringComparer.Ordinal) || !record.History.Add(name))
                    {
                        return null;
                    }
                }

                foreach (var tile in tiles.EnumerateArray())
                {
                    if (tile.ValueKind != JsonValueKind.String || tile.GetString() is not { } sha || !LegacyCollageWithhold.IsHash(sha) || !record.Tiles.Add(sha)
                        || record.Tiles.Count > MaxTileHashes)
                    {
                        return null;
                    }
                }

                foreach (var (sha, value) in entries)
                {
                    if (!LegacyCollageWithhold.IsHash(sha) || ReadComposition(value) is not { } composition)
                    {
                        return null;
                    }

                    record.Compositions.Add(sha, composition);
                }

                return record;
            }
            catch (Exception ex) when (ex is JsonException or InvalidOperationException or ArgumentException or FormatException)
            {
                return null;
            }
        }

        // One composition: exactly verdict, inputs (each exactly sha and verdict) and omitted, the verdict being the worst of
        // its sources' (omitted ones included, so at least one source when it is clean); anything else is null.
        private static Composition? ReadComposition(JsonElement value)
        {
            if (value.ValueKind != JsonValueKind.Object || Members(value) is not { Count: 3 } members
                || !members.TryGetValue("verdict", out var verdict) || ReadVerdict(verdict) is not { } stated
                || !members.TryGetValue("omitted", out var omitted) || omitted.ValueKind != JsonValueKind.Number || !omitted.TryGetInt32(out var more) || more < 0
                || !members.TryGetValue("inputs", out var inputs) || inputs.ValueKind != JsonValueKind.Array || inputs.GetArrayLength() is 0 or > MaxInputs
                || (more > 0 && inputs.GetArrayLength() != MaxInputs))
            {
                return null;
            }

            var sources = new List<(string? Sha, LegacyCollageSource Verdict)>();
            foreach (var input in inputs.EnumerateArray())
            {
                if (input.ValueKind != JsonValueKind.Object || Members(input) is not { Count: 2 } fields
                    || !fields.TryGetValue("sha", out var sha) || !fields.TryGetValue("verdict", out var source) || ReadVerdict(source) is not { } sourceVerdict)
                {
                    return null;
                }

                string? hash = null;
                if (sha.ValueKind == JsonValueKind.String && sha.GetString() is { } text && LegacyCollageWithhold.IsHash(text))
                {
                    hash = text;
                }
                else if (sha.ValueKind != JsonValueKind.Null || sourceVerdict != LegacyCollageSource.Unresolved)
                {
                    // Only a source that couldn't be read has no hash, and it is unresolved.
                    return null;
                }

                sources.Add((hash, sourceVerdict));
            }

            var worst = sources.Max(s => s.Verdict);
            // The omitted sources' verdicts are folded into the stated one: it can only be the same or worse.
            return stated < worst || (more == 0 && stated != worst) ? null : new Composition(stated, sources, more);
        }

        private static LegacyCollageSource? ReadVerdict(JsonElement value) => value.ValueKind == JsonValueKind.String ? value.GetString() switch
        {
            "clean" => LegacyCollageSource.Clean,
            "unresolved" => LegacyCollageSource.Unresolved,
            "contaminated" => LegacyCollageSource.Contaminated,
            _ => null,
        } : null;

        private static string Name(LegacyCollageSource verdict) => verdict switch
        {
            LegacyCollageSource.Clean => "clean",
            LegacyCollageSource.Unresolved => "unresolved",
            _ => "contaminated",
        };

        // An object's members, or null when a name appears twice.
        private static Dictionary<string, JsonElement>? Members(JsonElement element)
        {
            var members = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
            foreach (var property in element.EnumerateObject())
            {
                if (!members.TryAdd(property.Name, property.Value))
                {
                    return null;
                }
            }

            return members;
        }

        // ── entry-wise recovery ─────────────────────────────────────────────

        /// <summary>
        /// Recovers every complete entry a damaged record still holds that can be told for what it is: a <c>tiles</c> hash
        /// (a quoted hash after <c>[</c> or <c>,</c> and before <c>,</c>, <c>]</c> or the end), a composition (<c>"hash":{…}</c> whose
        /// value is a complete, valid composition) and <c>"saturated":true</c>, wherever they stand in the file. Anything
        /// else (a truncated entry, one cut by damage) is left unresolved.
        /// </summary>
        /// <param name="bytes">The record's bytes.</param>
        /// <param name="record">Where the entries go.</param>
        internal static void Recover(byte[] bytes, State record)
        {
            var span = bytes.AsSpan();
            if (span.IndexOf("\"saturated\":true"u8) >= 0 || span.IndexOf("\"saturated\": true"u8) >= 0)
            {
                record.Saturated = true;
            }

            for (var i = 0; i + 66 <= span.Length; i++)
            {
                if (span[i] != (byte)'"' || span[i + 65] != (byte)'"' || !IsHex(span.Slice(i + 1, 64)))
                {
                    continue;
                }

                var sha = Encoding.ASCII.GetString(span.Slice(i + 1, 64));
                var before = Previous(span, i);
                var after = Next(span, i + 66);
                // A tile hash cut off at the end of the file is complete too (it only ever withholds).
                if (before is (byte)'[' or (byte)',' && after.Byte is (byte)',' or (byte)']' or null)
                {
                    if (record.Tiles.Count >= MaxTileHashes)
                    {
                        record.Saturated = true;
                    }
                    else
                    {
                        record.Tiles.Add(sha);
                    }
                }
                else if (before is (byte)'{' or (byte)',' && after.Byte == (byte)':' && Value(span[(after.At + 1)..]) is { } value
                    && ReadComposition(value) is { } composition && !record.Compositions.ContainsKey(sha) && record.Compositions.Count < MaxCompositions)
                {
                    record.Compositions.Add(sha, composition);
                }

                i += 65;
            }
        }

        private static bool IsHex(ReadOnlySpan<byte> text)
        {
            for (var i = 0; i < text.Length; i++)
            {
                if (text[i] is not ((>= (byte)'0' and <= (byte)'9') or (>= (byte)'a' and <= (byte)'f')))
                {
                    return false;
                }
            }

            return true;
        }

        private static byte? Previous(ReadOnlySpan<byte> span, int at)
        {
            for (var i = at - 1; i >= 0; i--)
            {
                if (span[i] is not ((byte)' ' or (byte)'\t' or (byte)'\r' or (byte)'\n'))
                {
                    return span[i];
                }
            }

            return null;
        }

        private static (byte? Byte, int At) Next(ReadOnlySpan<byte> span, int at)
        {
            for (var i = at; i < span.Length; i++)
            {
                if (span[i] is not ((byte)' ' or (byte)'\t' or (byte)'\r' or (byte)'\n'))
                {
                    return (span[i], i);
                }
            }

            return (null, span.Length);
        }

        // The one complete JSON object at the start of the span (white space first), or null.
        private static JsonElement? Value(ReadOnlySpan<byte> span)
        {
            try
            {
                var reader = new Utf8JsonReader(span, isFinalBlock: false, new JsonReaderState(new JsonReaderOptions { MaxDepth = 8 }));
                if (!reader.Read() || reader.TokenType != JsonTokenType.StartObject)
                {
                    return null;
                }

                var start = (int)reader.TokenStartIndex;
                if (!reader.TrySkip())
                {
                    return null;
                }

                using var doc = JsonDocument.Parse(span[start..((int)reader.TokenStartIndex + 1)].ToArray(), new JsonDocumentOptions { MaxDepth = 8 });
                return doc.RootElement.Clone();
            }
            catch (JsonException)
            {
                return null;
            }
        }

        // ── writing ─────────────────────────────────────────────────────────

        internal static byte[] Serialize(State record)
        {
            using var stream = new MemoryStream();
            using (var writer = new Utf8JsonWriter(stream))
            {
                writer.WriteStartObject();
                writer.WriteNumber("version", CurrentVersion);
                writer.WriteStartArray("history");
                foreach (var kind in record.History.OrderBy(k => k, StringComparer.Ordinal))
                {
                    writer.WriteStringValue(kind);
                }

                writer.WriteEndArray();
                writer.WriteStartArray("tiles");
                foreach (var sha in record.Tiles.OrderBy(t => t, StringComparer.Ordinal))
                {
                    writer.WriteStringValue(sha);
                }

                writer.WriteEndArray();
                writer.WriteStartObject("compositions");
                // In the order they were seen (the oldest clean or unresolved one makes room first).
                foreach (var (sha, composition) in record.Compositions)
                {
                    writer.WriteStartObject(sha);
                    writer.WriteString("verdict", Name(composition.Verdict));
                    writer.WriteStartArray("inputs");
                    foreach (var (input, verdict) in composition.Inputs)
                    {
                        writer.WriteStartObject();
                        if (input == null)
                        {
                            writer.WriteNull("sha");
                        }
                        else
                        {
                            writer.WriteString("sha", input);
                        }

                        writer.WriteString("verdict", Name(verdict));
                        writer.WriteEndObject();
                    }

                    writer.WriteEndArray();
                    writer.WriteNumber("omitted", composition.Omitted);
                    writer.WriteEndObject();
                }

                writer.WriteEndObject();
                writer.WriteBoolean("saturated", record.Saturated);
                writer.WriteEndObject();
            }

            return stream.ToArray();
        }

        private void Save(State record)
        {
            if (_unopenableAt != null)
            {
                // The record on disk couldn't be opened: never overwritten (it may hold proof this process doesn't have).
                Warn("blocked", "[Lists] The record of library tiles built from legacy collages exists but couldn't be opened; it is kept as it is and what JE saw since is kept in memory until it can be read again.");
                return;
            }

            var temporary = _path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
                using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    stream.Write(Serialize(record));
                    stream.Flush(flushToDisk: true);
                }

                File.Move(temporary, _path, overwrite: true);
            }
            catch (Exception ex) when (LegacyCollageWithhold.IsFileError(ex))
            {
                try
                {
                    File.Delete(temporary);
                }
                catch (Exception cleanup) when (LegacyCollageWithhold.IsFileError(cleanup))
                {
                }

                Warn("write", $"[Lists] Could not save the record of library tiles built from legacy collages ({ex.GetType().Name}: {ex.Message}); kept in memory and saved again with the next change.");
            }
        }

        private void Warn(string kind, string message)
        {
            if (_warned.Add(kind))
            {
                _warn?.Invoke(message);
            }
        }

        /// <summary>The record's contents.</summary>
        internal sealed class State
        {
            public HashSet<string> History { get; } = new(StringComparer.Ordinal);

            public HashSet<string> Tiles { get; } = new(StringComparer.Ordinal);

            // Insertion order is kept (and saved): the oldest clean or unresolved composition makes room first.
            public OrderedDictionary<string, Composition> Compositions { get; } = new(StringComparer.Ordinal);

            public bool Saturated { get; set; }
        }

        /// <summary>One composition: its verdict, the sources kept (content hash, verdict) and how many more there were.</summary>
        internal sealed record Composition(LegacyCollageSource Verdict, IReadOnlyList<(string? Sha, LegacyCollageSource Verdict)> Inputs, int Omitted);
    }
}
