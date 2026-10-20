using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.Json;
using Jellyfin.Data.Enums;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists
{
    /// <summary>
    /// The host composes the playlist and collection library tiles from list images and keeps a tile for days, so a tile
    /// built while a list was a collage holds the collage's pixels after the list's image is replaced, and after a
    /// restart. JE's record (one small JSON file of its own; never an image or a marker) of when each kind of tile can be
    /// clean, and of the tiles proven to hold a collage:
    /// <list type="bullet">
    /// <item>While any list of the kind is withheld, every tile of that kind is (the view's live rule).</item>
    /// <item>Otherwise a tile waits until the host has regenerated it after <c>cleanFrom</c>: the moment JE saw the kind's
    /// lists clean after a withheld period, after any change to a list of that kind that had a marker, or the first time
    /// it looked at a kind with markers and no record (history unknown). That wait is temporary: it never makes a tile's
    /// content suspect, so a regenerated tile is served even when its bytes are the old ones.</item>
    /// <item>Proven contamination is permanent: a tile content the host wrote while a list of its kind was proven to be a
    /// collage (seen then, written no earlier than the collage) stays withheld whatever its time (a copy put back). This evidence is never evicted: at capacity every tile of
    /// both kinds is withheld from then on (logged).</item>
    /// <item>The record is read strictly (every field present and well formed, nothing else); anything less is unknown
    /// history for both kinds, keeping whatever proof of contamination it still holds. A record that exists but can't be
    /// opened is never overwritten (read again shortly).</item>
    /// </list>
    /// </summary>
    internal sealed class LegacyCollageTiles
    {
        /// <summary>How much later than <c>cleanFrom</c> a tile must have been written to count as regenerated (covers a
        /// composition straddling the moment JE looked, and coarse file times).</summary>
        public static readonly TimeSpan RegenerationMargin = TimeSpan.FromMinutes(1);

        /// <summary>How much earlier than a collage a tile may have been written and still count as written while it was
        /// there (coarse file times).</summary>
        public static readonly TimeSpan FileTimeSlack = TimeSpan.FromSeconds(2);

        /// <summary>Most tile contents the record keeps as proven contaminated; past that every tile is withheld.</summary>
        internal const int MaxTileHashes = 4096;

        /// <summary>Most marked lists the record keeps the identity of; past that every tile is withheld.</summary>
        internal const int MaxLists = 4096;

        private const long MaxRecordBytes = 4 * 1024 * 1024;
        private const int CurrentVersion = 2;
        private static readonly TimeSpan RetryUnopenable = TimeSpan.FromSeconds(5);
        private static readonly BaseItemKind[] Kinds = { BaseItemKind.Playlist, BaseItemKind.BoxSet };

        private readonly string _path;
        private readonly Func<DateTime> _utcNow;
        private readonly Action<string>? _warn;
        private readonly object _lock = new();
        private State? _record;
        private long? _unopenableAt;
        private readonly HashSet<string> _warned = new(StringComparer.Ordinal);

        public LegacyCollageTiles(string path, Func<DateTime> utcNow, Action<string>? warn)
        {
            _path = path;
            _utcNow = utcNow;
            _warn = warn;
        }

        /// <summary>True when some kind of tile has a record (then tiles need judging even with no marker left).</summary>
        public bool HasHistory
        {
            get
            {
                lock (_lock)
                {
                    var record = Load();
                    return record.Kinds.Count > 0 || record.Tiles.Count > 0 || record.Saturated;
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

        /// <summary>
        /// Records what the lists of a kind look like now and returns the moment from which a tile of that kind can be clean
        /// (null: no list of that kind ever had a marker, tiles are the host's business).
        /// </summary>
        /// <param name="kind">Playlist or BoxSet.</param>
        /// <param name="withheldNow">Whether a list of that kind is withheld now (then the returned value isn't used).</param>
        /// <param name="lists">Each marked list of that kind (and each marked id no longer in the library): its identity now.</param>
        /// <returns>The moment, or null.</returns>
        public DateTime? Observe(BaseItemKind kind, bool withheldNow, IReadOnlyDictionary<string, string> lists)
        {
            lock (_lock)
            {
                var record = Load();
                var key = kind.ToString();
                var prefix = key + "|";
                var changed = false;
                if (lists.Count > MaxLists)
                {
                    changed |= Saturate(record, "more marked lists than it can keep");
                }

                var known = record.Lists.Where(p => p.Key.StartsWith(prefix, StringComparison.Ordinal)).ToDictionary(p => p.Key[prefix.Length..], p => p.Value, StringComparer.Ordinal);
                var listsChanged = known.Count != lists.Count || lists.Any(p => !known.TryGetValue(p.Key, out var was) || !string.Equals(was, p.Value, StringComparison.Ordinal));
                record.Kinds.TryGetValue(key, out var state);
                if (withheldNow)
                {
                    if (state is not { Dirty: true })
                    {
                        record.Kinds[key] = new KindRecord(true, state?.CleanFrom);
                        changed = true;
                    }
                }
                else if (state == null ? lists.Count > 0 : state.Dirty || listsChanged)
                {
                    record.Kinds[key] = new KindRecord(false, _utcNow());
                    changed = true;
                }

                if (listsChanged && lists.Count <= MaxLists)
                {
                    foreach (var stale in known.Keys)
                    {
                        record.Lists.Remove(prefix + stale);
                    }

                    foreach (var (id, identity) in lists)
                    {
                        record.Lists[prefix + id] = identity;
                    }

                    changed = true;
                }

                if (changed)
                {
                    Save(record);
                }

                return withheldNow ? null : record.Kinds.GetValueOrDefault(key)?.CleanFrom;
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
                    // Nothing proven is ever dropped to make room: from here on every tile is withheld.
                    if (Saturate(record, "more contaminated tiles than it can keep"))
                    {
                        Save(record);
                    }

                    return;
                }

                record.Tiles.Add(sha);
                Save(record);
            }
        }

        /// <summary>True when a tile with this content was proven to hold a collage (or the record is past capacity).</summary>
        /// <param name="sha">The tile file's SHA-256.</param>
        /// <returns>Whether it was.</returns>
        public bool Contaminated(string sha)
        {
            lock (_lock)
            {
                var record = Load();
                return record.Saturated || record.Tiles.Contains(sha);
            }
        }

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
                    Adopt(Unknown("too large", Array.Empty<byte>()), opened: false);
                    return _record!;
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
                var unknown = Unknown(ex.GetType().Name, Array.Empty<byte>());
                Adopt(unknown, opened: false);
                return _record!;
            }

            return Adopt(Parse(bytes) ?? Unknown("not understood", bytes), opened: true);
        }

        // Takes a state read now as the record. What this process already knows is never dropped for it: proof of
        // contamination and capacity are kept, and each kind keeps the later of the two moments it can be clean from.
        private State Adopt(State read, bool opened)
        {
            _unopenableAt = opened ? null : Environment.TickCount64;
            if (_record == null)
            {
                return _record = read;
            }

            var known = _record;
            known.Saturated |= read.Saturated;
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

            foreach (var (kind, state) in read.Kinds)
            {
                known.Kinds[kind] = known.Kinds.TryGetValue(kind, out var mine) ? KindRecord.Later(mine, state) : state;
            }

            foreach (var (id, identity) in read.Lists)
            {
                known.Lists.TryAdd(id, identity);
            }

            return known;
        }

        // History unknown: every tile of either kind waits for the host to regenerate it. Whatever proof of contamination
        // the bytes still hold is kept (it can only withhold more).
        private State Unknown(string why, byte[] bytes)
        {
            Warn("read", $"[Lists] The record of library tiles built from legacy collages couldn't be read ({why}); playlist and collection library tiles are withheld until regenerated.");
            var now = _utcNow();
            var record = new State();
            foreach (var kind in Kinds)
            {
                record.Kinds[kind.ToString()] = new KindRecord(false, now);
            }

            Salvage(bytes, record);
            return record;
        }

        private static void Salvage(byte[] bytes, State record)
        {
            try
            {
                using var doc = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 8 });
                if (doc.RootElement.ValueKind != JsonValueKind.Object)
                {
                    return;
                }

                foreach (var property in doc.RootElement.EnumerateObject())
                {
                    if (property.NameEquals("saturated") && property.Value.ValueKind == JsonValueKind.True)
                    {
                        record.Saturated = true;
                    }
                    else if (property.NameEquals("tiles") && property.Value.ValueKind == JsonValueKind.Array)
                    {
                        foreach (var tile in property.Value.EnumerateArray())
                        {
                            if (tile.ValueKind == JsonValueKind.String && tile.GetString() is { } sha && LegacyCollageWithhold.IsHash(sha))
                            {
                                if (record.Tiles.Count >= MaxTileHashes)
                                {
                                    record.Saturated = true;
                                    break;
                                }

                                record.Tiles.Add(sha);
                            }
                        }
                    }
                }
            }
            catch (Exception ex) when (ex is JsonException or InvalidOperationException or ArgumentException)
            {
                // Nothing salvageable.
            }
        }

        /// <summary>
        /// The record, read strictly: one JSON object with exactly <c>version</c> (1, or 2 with <c>saturated</c>),
        /// <c>kinds</c>, <c>lists</c> and <c>tiles</c>, each present once and well formed; anything else is null.
        /// </summary>
        /// <param name="bytes">The file's bytes.</param>
        /// <returns>The record, or null.</returns>
        internal static State? Parse(byte[] bytes)
        {
            try
            {
                using var doc = JsonDocument.Parse(bytes, new JsonDocumentOptions { MaxDepth = 8 });
                var root = doc.RootElement;
                if (root.ValueKind != JsonValueKind.Object || Members(root) is not { } members
                    || !members.TryGetValue("version", out var version) || version.ValueKind != JsonValueKind.Number || !version.TryGetInt32(out var v)
                    || (v, members.Count) is not ((1, 4) or (CurrentVersion, 5)))
                {
                    return null;
                }

                var record = new State();
                if (v == CurrentVersion)
                {
                    if (!members.TryGetValue("saturated", out var saturated) || saturated.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                    {
                        return null;
                    }

                    record.Saturated = saturated.GetBoolean();
                }

                if (!members.TryGetValue("kinds", out var kinds) || !members.TryGetValue("lists", out var lists) || !members.TryGetValue("tiles", out var tiles)
                    || kinds.ValueKind != JsonValueKind.Object || lists.ValueKind != JsonValueKind.Object || tiles.ValueKind != JsonValueKind.Array
                    || Members(kinds) is not { } kindMembers || Members(lists) is not { } listMembers)
                {
                    return null;
                }

                foreach (var (name, value) in kindMembers)
                {
                    if (!Kinds.Any(k => string.Equals(k.ToString(), name, StringComparison.Ordinal)) || ReadKind(value) is not { } state)
                    {
                        return null;
                    }

                    record.Kinds[name] = state;
                }

                if (listMembers.Count > MaxLists)
                {
                    return null;
                }

                foreach (var (name, value) in listMembers)
                {
                    var bar = name.IndexOf('|', StringComparison.Ordinal);
                    if (bar < 0 || !Kinds.Any(k => string.Equals(k.ToString(), name[..bar], StringComparison.Ordinal))
                        || LegacyCollageWithhold.MarkerId(name[(bar + 1)..] + ".json") == null
                        || value.ValueKind != JsonValueKind.String || value.GetString() is not { Length: > 0 and <= 4096 } identity)
                    {
                        return null;
                    }

                    record.Lists[name] = identity;
                }

                foreach (var tile in tiles.EnumerateArray())
                {
                    if (tile.ValueKind != JsonValueKind.String || tile.GetString() is not { } sha || !LegacyCollageWithhold.IsHash(sha) || !record.Tiles.Add(sha)
                        || record.Tiles.Count > MaxTileHashes)
                    {
                        return null;
                    }
                }

                return record;
            }
            catch (Exception ex) when (ex is JsonException or InvalidOperationException or ArgumentException or FormatException)
            {
                return null;
            }
        }

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

        private static KindRecord? ReadKind(JsonElement value)
        {
            if (value.ValueKind != JsonValueKind.Object || Members(value) is not { Count: 2 } members
                || !members.TryGetValue("dirty", out var dirty) || dirty.ValueKind is not (JsonValueKind.True or JsonValueKind.False)
                || !members.TryGetValue("cleanFrom", out var cleanFrom))
            {
                return null;
            }

            DateTime? moment = null;
            if (cleanFrom.ValueKind == JsonValueKind.String)
            {
                if (!DateTime.TryParseExact(cleanFrom.GetString(), "O", CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var parsed) || parsed.Kind != DateTimeKind.Utc)
                {
                    return null;
                }

                moment = parsed;
            }
            else if (cleanFrom.ValueKind != JsonValueKind.Null)
            {
                return null;
            }

            // A clean kind always has its moment.
            return !dirty.GetBoolean() && moment == null ? null : new KindRecord(dirty.GetBoolean(), moment);
        }

        internal static byte[] Serialize(State record)
        {
            using var stream = new MemoryStream();
            using (var writer = new Utf8JsonWriter(stream))
            {
                writer.WriteStartObject();
                writer.WriteNumber("version", CurrentVersion);
                writer.WriteStartObject("kinds");
                foreach (var (kind, state) in record.Kinds.OrderBy(p => p.Key, StringComparer.Ordinal))
                {
                    writer.WriteStartObject(kind);
                    writer.WriteBoolean("dirty", state.Dirty);
                    if (state.CleanFrom is { } cleanFrom)
                    {
                        writer.WriteString("cleanFrom", cleanFrom.ToString("O", CultureInfo.InvariantCulture));
                    }
                    else
                    {
                        writer.WriteNull("cleanFrom");
                    }

                    writer.WriteEndObject();
                }

                writer.WriteEndObject();
                writer.WriteStartObject("lists");
                foreach (var (id, identity) in record.Lists.OrderBy(p => p.Key, StringComparer.Ordinal))
                {
                    writer.WriteString(id, identity);
                }

                writer.WriteEndObject();
                writer.WriteStartArray("tiles");
                foreach (var sha in record.Tiles.OrderBy(t => t, StringComparer.Ordinal))
                {
                    writer.WriteStringValue(sha);
                }

                writer.WriteEndArray();
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
            public Dictionary<string, KindRecord> Kinds { get; } = new(StringComparer.Ordinal);

            public Dictionary<string, string> Lists { get; } = new(StringComparer.Ordinal);

            public HashSet<string> Tiles { get; } = new(StringComparer.Ordinal);

            public bool Saturated { get; set; }
        }

        /// <summary>One kind of library tile: withheld now (dirty), and the moment from which a tile of it can be clean.</summary>
        internal sealed record KindRecord(bool Dirty, DateTime? CleanFrom)
        {
            // The more cautious of two: dirty if either is, clean only from the later moment.
            public static KindRecord Later(KindRecord a, KindRecord b)
                => new(a.Dirty || b.Dirty, a.CleanFrom is { } x && b.CleanFrom is { } y ? (x > y ? x : y) : a.CleanFrom ?? b.CleanFrom);
        }
    }
}
