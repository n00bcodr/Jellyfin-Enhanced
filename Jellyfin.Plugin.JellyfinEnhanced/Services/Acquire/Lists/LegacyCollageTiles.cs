using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using Jellyfin.Data.Enums;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists
{
    /// <summary>
    /// The host composes the playlist and collection library tiles from list images and keeps a tile for days, so a tile
    /// built while a list was a collage holds the collage's pixels after the list's image is replaced, and after a
    /// restart. JE's record (one small JSON file of its own; never an image or a marker) of when each kind of tile can be
    /// clean:
    /// <list type="bullet">
    /// <item>While any list of the kind is withheld, every tile of that kind is (the view's live rule).</item>
    /// <item>Otherwise a tile is served only when its file was written more than <see cref="RegenerationMargin"/> after
    /// <c>cleanFrom</c>: the moment JE saw the kind's lists clean after a withheld period, after any change to a list of
    /// that kind that had a marker (its image, its verdict, its marker, the list itself), or the first time it looked
    /// at a kind with markers and no record (history unknown).</item>
    /// <item>A tile whose content JE saw while it was withheld stays withheld whatever its time (a copy put back).</item>
    /// </list>
    /// A record that can't be read counts as unknown history for both kinds; one that can't be written keeps working in
    /// memory (and after a restart, unknown history again: fail closed).
    /// </summary>
    internal sealed class LegacyCollageTiles
    {
        /// <summary>How much later than <c>cleanFrom</c> a tile must have been written to count as regenerated (covers a
        /// composition straddling the moment JE looked, and coarse file times).</summary>
        public static readonly TimeSpan RegenerationMargin = TimeSpan.FromMinutes(1);

        private const int MaxTileHashes = 512;
        private const int MaxLists = 4096;
        private const long MaxRecordBytes = 1024 * 1024;

        private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = false, DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull };
        private static readonly BaseItemKind[] Kinds = { BaseItemKind.Playlist, BaseItemKind.BoxSet };

        private readonly string _path;
        private readonly Func<DateTime> _utcNow;
        private readonly Action<string>? _warn;
        private readonly object _lock = new();
        private State? _record;
        private bool _warnedRead;
        private bool _warnedWrite;

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
                    return Load().Kinds.Count > 0;
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
                var known = record.Lists.Where(p => p.Key.StartsWith(prefix, StringComparison.Ordinal)).ToDictionary(p => p.Key[prefix.Length..], p => p.Value, StringComparer.Ordinal);
                var listsChanged = known.Count != lists.Count || lists.Any(p => !known.TryGetValue(p.Key, out var was) || !string.Equals(was, p.Value, StringComparison.Ordinal));
                record.Kinds.TryGetValue(key, out var state);
                var changed = false;
                if (withheldNow)
                {
                    if (state is not { Dirty: true })
                    {
                        record.Kinds[key] = new KindRecord { Dirty = true, CleanFrom = state?.CleanFrom };
                        changed = true;
                    }
                }
                else if (state == null ? lists.Count > 0 : state.Dirty || listsChanged)
                {
                    record.Kinds[key] = new KindRecord { Dirty = false, CleanFrom = _utcNow() };
                    changed = true;
                }

                if (listsChanged)
                {
                    foreach (var stale in known.Keys)
                    {
                        record.Lists.Remove(prefix + stale);
                    }

                    foreach (var (id, identity) in lists.Take(MaxLists))
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

        /// <summary>Remembers a tile content seen while it was (or could be) built from a collage.</summary>
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
                if (record.Tiles.Contains(sha, StringComparer.Ordinal))
                {
                    return;
                }

                record.Tiles.Add(sha);
                if (record.Tiles.Count > MaxTileHashes)
                {
                    record.Tiles.RemoveRange(0, record.Tiles.Count - MaxTileHashes);
                }

                Save(record);
            }
        }

        /// <summary>True when a tile with this content was seen while it was (or could be) built from a collage.</summary>
        /// <param name="sha">The tile file's SHA-256.</param>
        /// <returns>Whether it was.</returns>
        public bool Contaminated(string sha)
        {
            lock (_lock)
            {
                return Load().Tiles.Contains(sha, StringComparer.Ordinal);
            }
        }

        private State Load()
        {
            if (_record != null)
            {
                return _record;
            }

            try
            {
                using var stream = new FileStream(_path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                if (stream.Length > MaxRecordBytes)
                {
                    return _record = Unknown("too large");
                }

                var bytes = new byte[stream.Length];
                stream.ReadExactly(bytes);
                return _record = Parse(bytes) ?? Unknown("not understood");
            }
            catch (Exception ex) when (ex is FileNotFoundException or DirectoryNotFoundException && LegacyCollageWithhold.ShownAbsent(_path, LegacyCollageWithhold.ListNow))
            {
                return _record = new State();
            }
            catch (Exception ex) when (LegacyCollageWithhold.IsFileError(ex) || ex is EndOfStreamException)
            {
                return _record = Unknown(ex.GetType().Name);
            }
        }

        // History unknown: every tile of either kind waits for the host to regenerate it.
        private State Unknown(string why)
        {
            if (!_warnedRead)
            {
                _warnedRead = true;
                _warn?.Invoke($"[Lists] The record of library tiles built from legacy collages couldn't be read ({why}); playlist and collection library tiles are withheld until regenerated.");
            }

            var now = _utcNow();
            var record = new State();
            foreach (var kind in Kinds)
            {
                record.Kinds[kind.ToString()] = new KindRecord { Dirty = false, CleanFrom = now };
            }

            return record;
        }

        private static State? Parse(byte[] bytes)
        {
            try
            {
                var record = JsonSerializer.Deserialize<State>(bytes, JsonOptions);
                if (record is not { Version: State.CurrentVersion } || record.Kinds == null || record.Lists == null || record.Tiles == null
                    || record.Kinds.Any(p => !Kinds.Any(k => string.Equals(k.ToString(), p.Key, StringComparison.Ordinal)) || p.Value == null || (!p.Value.Dirty && p.Value.CleanFrom == null))
                    || record.Tiles.Any(t => !LegacyCollageWithhold.IsHash(t)))
                {
                    return null;
                }

                return record;
            }
            catch (Exception ex) when (ex is JsonException or NotSupportedException or ArgumentException or InvalidOperationException)
            {
                return null;
            }
        }

        private void Save(State record)
        {
            var temporary = _path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
                using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    stream.Write(JsonSerializer.SerializeToUtf8Bytes(record, JsonOptions));
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

                if (!_warnedWrite)
                {
                    _warnedWrite = true;
                    _warn?.Invoke($"[Lists] Could not save the record of library tiles built from legacy collages ({ex.GetType().Name}: {ex.Message}); kept in memory, and after a restart those tiles wait to be regenerated.");
                }
            }
        }

        private sealed class State
        {
            public const int CurrentVersion = 1;

            [JsonPropertyName("version")]
            public int Version { get; set; } = CurrentVersion;

            [JsonPropertyName("kinds")]
            public Dictionary<string, KindRecord> Kinds { get; set; } = new(StringComparer.Ordinal);

            [JsonPropertyName("lists")]
            public Dictionary<string, string> Lists { get; set; } = new(StringComparer.Ordinal);

            [JsonPropertyName("tiles")]
            public List<string> Tiles { get; set; } = new();
        }

        private sealed class KindRecord
        {
            [JsonPropertyName("dirty")]
            public bool Dirty { get; set; }

            [JsonPropertyName("cleanFrom")]
            public DateTime? CleanFrom { get; set; }
        }
    }
}
