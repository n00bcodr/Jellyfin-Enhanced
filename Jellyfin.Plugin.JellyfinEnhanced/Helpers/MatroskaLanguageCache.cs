using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using MediaBrowser.Common.Configuration;

namespace Jellyfin.Plugin.JellyfinEnhanced.Helpers
{
    /// <summary>
    /// Remembers the audio languages <see cref="MatroskaLanguageReader"/> parsed
    /// from each Matroska file, keyed by path and validated by size and
    /// modification time.
    ///
    /// The reader opens the file every time it runs, and it runs for every media
    /// source on every tag-cache rebuild, reconcile and tag-data request. On a
    /// network or cloud mount (rclone VFS and the like) each open can pull tens
    /// or hundreds of MB of read-ahead, so re-reading unchanged files turned a
    /// metadata-only refresh into hundreds of GB of downloads. With the cache, an
    /// unchanged file costs one stat; it is only opened again when its size or
    /// modification time changes. A rewrite that keeps both size and modification
    /// time is not detected; that is the same signature Jellyfin uses to decide
    /// whether to re-probe a file.
    ///
    /// Persisted to matroska-languages.json next to tag-cache.json, so a restart
    /// does not re-read the whole library either.
    /// </summary>
    public sealed class MatroskaLanguageCache : IDisposable
    {
        // Bump whenever MatroskaLanguageReader learns to parse files it used to
        // reject: unparseable files are cached as negatives, and without a bump
        // those would never be re-read until the file itself changes.
        private const int SchemaVersion = 1;
        private const string FileName = "matroska-languages.json";

        // Concurrent misses on one path (build workers, simultaneous tag-data
        // requests) take the same stripe, so the file is opened once.
        private const int MissLockStripes = 64;

        // Same cadence as the tag cache's disk save: 30s after the last change,
        // but never deferred more than 5 minutes past the first unsaved one, so a
        // full build over a cold cache writes a few times rather than never.
        private static readonly TimeSpan DefaultSaveDebounce = TimeSpan.FromSeconds(30);
        private static readonly TimeSpan DefaultSaveMaxWait = TimeSpan.FromMinutes(5);

        // Nulls omitted on write (an unparsed file has no Languages); reading
        // back treats an absent property as null, so default options load it.
        private static readonly JsonSerializerOptions DiskJsonOptions = new()
        {
            WriteIndented = false,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        };

        private readonly IApplicationPaths _applicationPaths;
        private readonly Logger _logger;
        private readonly ConcurrentDictionary<string, FileEntry> _files = new(StringComparer.Ordinal);
        private readonly object _loadLock = new();
        private readonly object _saveLock = new();
        private readonly object[] _missLocks = Enumerable.Range(0, MissLockStripes).Select(_ => new object()).ToArray();
        private readonly Timer _saveTimer;
        private readonly TimeSpan _saveDebounce;
        private readonly TimeSpan _saveMaxWait;
        private volatile bool _loaded;
        private volatile bool _dirty;
        private volatile bool _disposed;
        private long _firstDirtyTicks; // 0 = nothing unsaved since the last disk save
        private int _saveFailures; // consecutive, guarded by _saveLock
        private long _generation;
        private long _reads;
        private long _hits;

        public MatroskaLanguageCache(IApplicationPaths applicationPaths, Logger logger)
            : this(applicationPaths, logger, DefaultSaveDebounce, DefaultSaveMaxWait)
        {
        }

        // Tests use short delays to exercise the save timer.
        internal MatroskaLanguageCache(IApplicationPaths applicationPaths, Logger logger, TimeSpan saveDebounce, TimeSpan saveMaxWait)
        {
            _applicationPaths = applicationPaths;
            _logger = logger;
            _saveDebounce = saveDebounce;
            _saveMaxWait = saveMaxWait;
            _saveTimer = new Timer(_ => OnSaveTimer(), null, Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan);
        }

        /// <summary>Files opened and parsed since startup (cache misses).</summary>
        public long Reads => Interlocked.Read(ref _reads);

        /// <summary>Lookups answered from the cache without opening the file.</summary>
        public long Hits => Interlocked.Read(ref _hits);

        private string CacheFilePath =>
            Path.Combine(_applicationPaths.PluginsPath, "configurations", "Jellyfin.Plugin.JellyfinEnhanced", FileName);

        /// <summary>
        /// Same contract as <see cref="MatroskaLanguageReader.TryReadAudioLanguages(string?, out IReadOnlyList{string?})"/>,
        /// but an unchanged file is answered from the cache: the only file-system
        /// access is then one stat. Unsupported extensions are rejected without
        /// touching the file system at all.
        /// </summary>
        /// <param name="path">Local Matroska/WebM file path.</param>
        /// <param name="languages">Audio languages in track order. Entries may be null.</param>
        /// <returns>True when the file's Tracks element was (or, cached, had been) parsed.</returns>
        public bool TryGetAudioLanguages(string? path, out IReadOnlyList<string?> languages)
        {
            languages = Array.Empty<string?>();

            if (!MatroskaLanguageReader.IsSupportedPath(path))
            {
                return false;
            }

            long size;
            long modifiedTicks;
            try
            {
                var info = new FileInfo(path!);

                // Nothing is stored for a missing file: it may appear later
                // (a mount that is not up yet) and must be read then.
                if (!info.Exists)
                {
                    return false;
                }

                size = info.Length;
                modifiedTicks = info.LastWriteTimeUtc.Ticks;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
            {
                return false;
            }

            EnsureLoaded();
            var generation = Interlocked.Read(ref _generation);

            if (TryGetCached(path!, size, modifiedTicks, generation, out languages, out var cachedParsed))
            {
                return cachedParsed;
            }

            // Single-flight per path: whoever takes the stripe second finds the
            // first one's result instead of opening the file again. Hits above
            // stay lock-free.
            var stripe = (StringComparer.Ordinal.GetHashCode(path!) & int.MaxValue) % MissLockStripes;
            lock (_missLocks[stripe])
            {
                if (TryGetCached(path!, size, modifiedTicks, generation, out languages, out cachedParsed))
                {
                    return cachedParsed;
                }

                return ReadAndStore(path!, size, modifiedTicks, generation, out languages);
            }
        }

        private bool TryGetCached(string path, long size, long modifiedTicks, long generation, out IReadOnlyList<string?> languages, out bool parsed)
        {
            if (_files.TryGetValue(path, out var cached)
                && cached.Size == size
                && cached.Modified == modifiedTicks)
            {
                // Plain write, no lock: a racing sweep can at worst drop an entry
                // that is then read once more.
                if (cached.Generation != generation)
                {
                    cached.Generation = generation;
                }

                Interlocked.Increment(ref _hits);
                languages = cached.Languages ?? Array.Empty<string?>();
                parsed = cached.Parsed;
                return true;
            }

            languages = Array.Empty<string?>();
            parsed = false;
            return false;
        }

        // Test seam: runs just before a file is opened, inside the miss stripe,
        // so a test can hold the first read while other callers queue up on it.
        internal Action? BeforeRead;

        private bool ReadAndStore(string path, long size, long modifiedTicks, long generation, out IReadOnlyList<string?> languages)
        {
            languages = Array.Empty<string?>();
            BeforeRead?.Invoke();
            var parsed = MatroskaLanguageReader.TryReadAudioLanguages(path, out var read, out var transientFailure);
            Interlocked.Increment(ref _reads);

            // An I/O or permission failure (a mount hiccup, a file vanishing
            // mid-read) says nothing about the file's contents, so it is not
            // remembered. A file that opened fine but has no parseable Tracks is:
            // its answer won't change until the file does, and reopening it on
            // every rebuild is exactly the cost this cache exists to avoid.
            if (transientFailure)
            {
                return false;
            }

            var entry = new FileEntry
            {
                Size = size,
                Modified = modifiedTicks,
                Parsed = parsed,
                Languages = parsed ? read.ToArray() : null,
                Generation = generation,
            };
            _files[path] = entry;
            MarkDirty();

            languages = entry.Languages ?? Array.Empty<string?>();
            return parsed;
        }

        /// <summary>
        /// Starts a sweep: entries looked up between this call and
        /// <see cref="EndSweep"/> are known to be current; every other entry is
        /// checked against the file system when the sweep ends. The sweeping
        /// pass need not visit every file (the full tag-cache build skips
        /// excluded libraries and failed items), since only files that are gone
        /// are pruned.
        /// </summary>
        public void BeginSweep()
        {
            // Load first so entries persisted for files the pass never visits
            // (renamed, deleted) are part of what EndSweep can prune.
            EnsureLoaded();
            Interlocked.Increment(ref _generation);
        }

        /// <summary>
        /// Removes entries not looked up since <see cref="BeginSweep"/> whose file
        /// no longer exists, at one stat per such entry; entries for files that
        /// still exist are kept even when the pass did not visit them. Call only
        /// when the sweeping pass ran to completion.
        /// </summary>
        public void EndSweep()
        {
            var generation = Interlocked.Read(ref _generation);
            var removed = 0;
            foreach (var pair in _files)
            {
                if (pair.Value.Generation == generation || FileStillExists(pair.Key))
                {
                    continue;
                }

                // Removes only this exact entry, so one replaced by a concurrent
                // read (which carries the current generation) is kept.
                if (_files.TryRemove(pair))
                {
                    removed++;
                }
            }

            if (removed > 0)
            {
                _logger.Info($"[MatroskaLanguageCache] Pruned {removed} entries for files that no longer exist");
                MarkDirty();
            }
        }

        private static bool FileStillExists(string path)
        {
            try
            {
                return File.Exists(path);
            }
            catch (Exception)
            {
                // Unknown is not gone: keep the entry rather than re-read the file.
                return true;
            }
        }

        /// <summary>Writes unsaved changes synchronously.</summary>
        public void Dispose()
        {
            _disposed = true;
            _saveTimer.Dispose();
            Save();
        }

        private void EnsureLoaded()
        {
            if (_loaded)
            {
                return;
            }

            lock (_loadLock)
            {
                if (_loaded)
                {
                    return;
                }

                Load();
                _loaded = true;
            }
        }

        private void Load()
        {
            var path = CacheFilePath;
            try
            {
                if (!File.Exists(path))
                {
                    return;
                }

                using var stream = File.OpenRead(path);
                var data = JsonSerializer.Deserialize<DiskFormat>(stream);
                if (data?.SchemaVersion != SchemaVersion || data.Files == null)
                {
                    _logger.Warning($"[MatroskaLanguageCache] Ignoring {FileName} with schema {data?.SchemaVersion}; starting empty");
                    return;
                }

                foreach (var (file, entry) in data.Files)
                {
                    if (!string.IsNullOrEmpty(file) && entry != null)
                    {
                        _files.TryAdd(file, entry);
                    }
                }

                _logger.Info($"[MatroskaLanguageCache] Loaded {_files.Count} cached Matroska headers");
            }
            catch (Exception ex)
            {
                // A corrupt or unreadable file only costs one re-read per file.
                _logger.Warning($"[MatroskaLanguageCache] Failed to load {FileName}; starting empty: {ex.Message}");
                _files.Clear();
            }
        }

        private void MarkDirty()
        {
            _dirty = true;
            var now = DateTime.UtcNow.Ticks;
            Interlocked.CompareExchange(ref _firstDirtyTicks, now, 0);
            ArmSave(now);
        }

        private void ArmSave(long nowTicks)
        {
            if (_disposed)
            {
                return;
            }

            var due = _saveDebounce;
            var first = Interlocked.Read(ref _firstDirtyTicks);
            if (first != 0)
            {
                var untilCap = TimeSpan.FromTicks(first + _saveMaxWait.Ticks - nowTicks);
                if (untilCap < due)
                {
                    due = untilCap < TimeSpan.Zero ? TimeSpan.Zero : untilCap;
                }
            }

            try
            {
                _saveTimer.Change(due, Timeout.InfiniteTimeSpan);
            }
            catch (ObjectDisposedException)
            {
                // Dispose raced the change; it saves synchronously itself.
            }
        }

        private void OnSaveTimer()
        {
            if (!_disposed)
            {
                Save();
            }
        }

        private void Save()
        {
            lock (_saveLock)
            {
                if (!_dirty)
                {
                    return;
                }

                // Cleared before the snapshot: a change landing during the write
                // sets the flag again and re-arms, so it is saved next time.
                _dirty = false;
                Interlocked.Exchange(ref _firstDirtyTicks, 0);

                var path = CacheFilePath;
                var temp = path + ".tmp";
                try
                {
                    var data = new DiskFormat
                    {
                        SchemaVersion = SchemaVersion,
                        Files = _files.ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal),
                    };

                    Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                    using (var stream = File.Create(temp))
                    {
                        JsonSerializer.Serialize(stream, data, DiskJsonOptions);
                    }

                    // Atomic replace: a crash mid-write leaves the previous file.
                    File.Move(temp, path, overwrite: true);

                    if (_saveFailures > 0)
                    {
                        _logger.Info($"[MatroskaLanguageCache] Saved {FileName} after {_saveFailures} failed attempts");
                        _saveFailures = 0;
                    }
                }
                catch (Exception ex)
                {
                    _dirty = true;
                    var now = DateTime.UtcNow.Ticks;
                    Interlocked.CompareExchange(ref _firstDirtyTicks, now, 0);

                    // A lasting failure (read-only config directory) retries every
                    // debounce interval; warn once rather than on every attempt.
                    if (++_saveFailures == 1)
                    {
                        _logger.Warning($"[MatroskaLanguageCache] Failed to save {FileName}; retrying: {ex.Message}");
                    }
                    else
                    {
                        _logger.Debug($"[MatroskaLanguageCache] Save attempt {_saveFailures} failed: {ex.Message}");
                    }

                    // Retry on the debounce: otherwise, with only cache hits from
                    // here on, nothing would be saved until Dispose.
                    ArmSave(now);
                }
            }
        }

        internal sealed class DiskFormat
        {
            public int SchemaVersion { get; set; }

            public Dictionary<string, FileEntry>? Files { get; set; }
        }

        internal sealed class FileEntry
        {
            public long Size { get; set; }

            /// <summary>The file's last write time, UTC ticks.</summary>
            public long Modified { get; set; }

            public bool Parsed { get; set; }

            public string?[]? Languages { get; set; }

            // Sweep stamp (see BeginSweep). A field, so serialization skips it.
            [JsonIgnore]
            public long Generation;
        }
    }
}
