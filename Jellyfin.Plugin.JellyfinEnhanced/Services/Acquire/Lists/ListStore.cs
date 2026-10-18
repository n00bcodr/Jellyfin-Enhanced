using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using MediaBrowser.Common.Configuration;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists
{
    /// <summary>A placeholder found through the reverse index.</summary>
    /// <param name="ListId">List id ("N").</param>
    /// <param name="PlaceholderId">Placeholder id.</param>
    public readonly record struct PlaceholderRef(string ListId, string PlaceholderId);

    /// <summary>
    /// Persists one list document per Jellyfin list under
    /// <c>&lt;PluginsPath&gt;/configurations/Jellyfin.Plugin.JellyfinEnhanced/lists/&lt;listIdN&gt;.json</c> (included in
    /// Jellyfin Enhanced backups). Schema-1 documents of closed PR #936 (<c>list-placeholders/</c>) are never read here;
    /// <c>ExperimentalListImporter</c> imports them.
    /// <list type="bullet">
    /// <item>Strict reads: an empty, unparsable or inconsistent file is never silently replaced (a copy is kept and
    /// mutations fail) — the same rule as the shared activity store.</item>
    /// <item>Atomic writes: temp file + flush to disk + <c>File.Move(overwrite)</c>.</item>
    /// <item>A per-list async lock (<see cref="LockAsync"/>) serialises read-modify-write; cached documents are
    /// treated as immutable (mutators work on <see cref="LoadForUpdate"/> copies) so lock-free readers never see a
    /// half-applied change.</item>
    /// <item>A reverse index (TMDB / TVDB / IMDb id → placeholders) for swap-in and automation.</item>
    /// <item>Retried mutations are answered from durable operations (<see cref="ListOperations"/>), not from memory.</item>
    /// <item>After a restore (<see cref="InvalidateAll"/>) every cached document and the index are read from disk again.</item>
    /// </list>
    /// </summary>
    public sealed class ListStore
    {
        /// <summary>Hard cap of placeholders per list.</summary>
        public const int MaxPlaceholders = 2000;

        /// <summary>The folder of the documents inside Jellyfin Enhanced's data folder.</summary>
        public const string DirectoryName = "lists";

        private static readonly Regex ListIdRegex = new("^[0-9a-f]{32}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
        private static readonly Regex RequestIdRegex = new("^[A-Za-z0-9_-]{1,64}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);

        private static readonly JsonSerializerOptions JsonOptions = new()
        {
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
            WriteIndented = false,
        };

        private readonly string _dir;
        private readonly Logger _logger;
        private readonly ConcurrentDictionary<string, SemaphoreSlim> _locks = new(StringComparer.Ordinal);
        private readonly ConcurrentDictionary<string, ListDoc> _cache = new(StringComparer.Ordinal);
        private readonly ConcurrentDictionary<string, byte> _absent = new(StringComparer.Ordinal);
        private readonly ConcurrentDictionary<string, byte> _backedUp = new(StringComparer.Ordinal);

        // Guards publishing to _cache/_absent: a lock-free cold read only publishes what it read when no Save/Delete
        // of that list happened meanwhile (per-list generation), so it can never put an older revision back.
        private readonly object _cacheLock = new();
        private readonly Dictionary<string, long> _generations = new(StringComparer.Ordinal);

        private readonly object _indexLock = new();
        private Dictionary<string, HashSet<PlaceholderRef>>? _index;
        private Dictionary<string, List<string>>? _indexKeysByList;

        // Lists whose document could not be read while the index was built (a file held by a backup or antivirus tool,
        // wrong permissions): indexed by a later lookup, at most once per IndexRetryDelay, or when the list is saved.
        private readonly HashSet<string> _indexPending = new(StringComparer.Ordinal);
        private DateTime _indexRetryAtUtc;

        /// <summary>Creates the store; the directory is created lazily on first write.</summary>
        /// <param name="appPaths">Jellyfin application paths.</param>
        /// <param name="logger">JE logger.</param>
        public ListStore(IApplicationPaths appPaths, Logger logger)
            : this(Path.Combine(appPaths.PluginsPath, "configurations", "Jellyfin.Plugin.JellyfinEnhanced", DirectoryName), logger)
        {
        }

        /// <summary>Creates the store over a folder (tests, the importer's dry run).</summary>
        /// <param name="directory">Folder of the documents.</param>
        /// <param name="logger">JE logger.</param>
        internal ListStore(string directory, Logger logger)
        {
            _dir = directory;
            _logger = logger;
        }

        /// <summary>The directory holding the documents.</summary>
        public string DirectoryPath => _dir;

        /// <summary>Folder (in <see cref="DirectoryPath"/>) of the collage markers the experimental-list importer copied.</summary>
        public const string LegacyCollagesFolder = "legacy-collages";

        /// <summary>
        /// Raised with the list id after a document was saved or deleted (any change of a list's placeholders). Runs on
        /// the writer's thread, possibly under the list lock: handlers must only queue work and must not throw.
        /// </summary>
        public event Action<string>? Changed;

        /// <summary>True when <paramref name="listIdN"/> is a lowercase 32-hex id usable as a file name.</summary>
        /// <param name="listIdN">Candidate id.</param>
        /// <returns>Whether it is valid.</returns>
        public static bool IsValidListId(string? listIdN) => listIdN != null && ListIdRegex.IsMatch(listIdN);

        /// <summary>True when <paramref name="requestId"/> is an acceptable client request id.</summary>
        /// <param name="requestId">Candidate request id.</param>
        /// <returns>Whether it is valid.</returns>
        public static bool IsValidRequestId(string? requestId) => requestId != null && RequestIdRegex.IsMatch(requestId);

        /// <summary>Takes the per-list lock. Dispose the result to release it.</summary>
        /// <param name="listIdN">List id.</param>
        /// <param name="cancellationToken">Cancels the wait.</param>
        /// <returns>The lock handle.</returns>
        public async Task<IDisposable> LockAsync(string listIdN, CancellationToken cancellationToken = default)
        {
            EnsureValid(listIdN);
            var semaphore = _locks.GetOrAdd(listIdN, _ => new SemaphoreSlim(1, 1));
            await semaphore.WaitAsync(cancellationToken).ConfigureAwait(false);
            return new Releaser(semaphore);
        }

        /// <summary>
        /// Reads a document (cached). Returns null when the list has none. The returned instance is shared: never
        /// mutate it — use <see cref="LoadForUpdate"/> under the lock.
        /// </summary>
        /// <param name="listIdN">List id.</param>
        /// <returns>The document or null.</returns>
        /// <exception cref="InvalidDataException">The file exists but is corrupt (kept intact for recovery).</exception>
        public ListDoc? Load(string listIdN)
        {
            EnsureValid(listIdN);
            while (true)
            {
                long generation;
                lock (_cacheLock)
                {
                    if (_cache.TryGetValue(listIdN, out var cached))
                    {
                        return cached;
                    }

                    if (_absent.ContainsKey(listIdN))
                    {
                        return null;
                    }

                    generation = GenerationUnlocked(listIdN);
                }

                // Disk read outside the lock; published only if no Save/Delete ran meanwhile, else read again.
                var path = PathFor(listIdN);
                var doc = File.Exists(path) ? ReadStrict(path, listIdN) : null;
                AfterColdReadForTest?.Invoke(listIdN);
                lock (_cacheLock)
                {
                    if (GenerationUnlocked(listIdN) != generation)
                    {
                        continue;
                    }

                    if (doc == null)
                    {
                        _absent[listIdN] = 0;
                    }
                    else
                    {
                        _cache[listIdN] = doc;
                    }

                    return doc;
                }
            }
        }

        /// <summary>Test seam: runs after a cold disk read, before its result is published.</summary>
        internal Action<string>? AfterColdReadForTest { get; set; }

        /// <summary>
        /// A private, mutable copy of the document (or a new empty one) for a read-modify-write. Call only while
        /// holding <see cref="LockAsync"/> for the list, then pass it to <see cref="Save"/>.
        /// </summary>
        /// <param name="listIdN">List id.</param>
        /// <param name="listKind">Kind used when the document doesn't exist yet.</param>
        /// <returns>The copy.</returns>
        public ListDoc LoadForUpdate(string listIdN, string listKind)
        {
            var existing = Load(listIdN);
            if (existing == null)
            {
                return new ListDoc { ListId = listIdN, ListKind = listKind };
            }

            return Clone(existing);
        }

        /// <summary>
        /// Persists a changed document: bumps <see cref="ListDoc.Rev"/>, writes atomically, refreshes the cache and the
        /// reverse index. Call only while holding the list lock.
        /// </summary>
        /// <param name="doc">The document (a <see cref="LoadForUpdate"/> copy).</param>
        /// <returns>The saved document (now the shared cached instance).</returns>
        public ListDoc Save(ListDoc doc)
        {
            ArgumentNullException.ThrowIfNull(doc);
            EnsureValid(doc.ListId);
            if (doc.Items.Count > MaxPlaceholders)
            {
                throw new InvalidOperationException($"A list can hold at most {MaxPlaceholders} placeholders.");
            }

            doc.Schema = ListDoc.CurrentSchema;
            doc.Rev++;
            doc.UpdatedAt = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture);
            Directory.CreateDirectory(_dir);
            var path = PathFor(doc.ListId);
            var json = JsonSerializer.Serialize(doc, JsonOptions);
            var temporaryPath = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                using (var stream = new FileStream(temporaryPath, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    using (var writer = new StreamWriter(stream, new UTF8Encoding(false), 4096, leaveOpen: true))
                    {
                        writer.Write(json);
                    }

                    stream.Flush(flushToDisk: true);
                }

                File.Move(temporaryPath, path, overwrite: true);
            }
            catch (Exception ex)
            {
                _logger.Error($"[Lists] Failed to save {doc.ListId}.json: {ex.Message}");
                doc.Rev--;
                throw;
            }
            finally
            {
                try { File.Delete(temporaryPath); }
                catch (IOException ex) { _logger.Warning($"[Lists] Failed to clean up a temporary file: {ex.Message}"); }
                catch (UnauthorizedAccessException ex) { _logger.Warning($"[Lists] Failed to clean up a temporary file: {ex.Message}"); }
            }

            lock (_cacheLock)
            {
                _cache[doc.ListId] = doc;
                _absent.TryRemove(doc.ListId, out _);
                BumpGenerationUnlocked(doc.ListId);
            }

            IndexList(doc);
            RaiseChanged(doc.ListId);
            return doc;
        }

        /// <summary>
        /// Deletes a list's document (list deleted in Jellyfin) and its imported collage marker: Jellyfin gives a list
        /// made again under the same name the same id, and an old marker must not stand for the new list's image. Takes
        /// no lock; callers hold it when racing writers matter.
        /// </summary>
        /// <param name="listIdN">List id.</param>
        /// <returns>True when a document existed.</returns>
        public bool Delete(string listIdN)
        {
            EnsureValid(listIdN);
            var path = PathFor(listIdN);
            var existed = File.Exists(path);
            if (existed)
            {
                File.Delete(path);
            }

            var marker = Path.Combine(_dir, LegacyCollagesFolder, listIdN + ".json");
            if (File.Exists(marker))
            {
                File.Delete(marker);
            }

            lock (_cacheLock)
            {
                _cache.TryRemove(listIdN, out _);
                _absent[listIdN] = 0;
                BumpGenerationUnlocked(listIdN);
            }

            lock (_indexLock)
            {
                _indexPending.Remove(listIdN);
                RemoveFromIndexUnlocked(listIdN);
            }

            RaiseChanged(listIdN);
            return existed;
        }

        /// <summary>Ids of every stored document.</summary>
        /// <returns>List ids ("N").</returns>
        public IReadOnlyList<string> EnumerateListIds()
        {
            if (!Directory.Exists(_dir))
            {
                return Array.Empty<string>();
            }

            return Directory.EnumerateFiles(_dir, "*.json")
                .Select(Path.GetFileNameWithoutExtension)
                .Where(IsValidListId)
                .Select(id => id!)
                .ToList();
        }

        /// <summary>Ids of the lists an imported collage marker is kept for (<see cref="LegacyCollagesFolder"/>).</summary>
        /// <returns>List ids ("N").</returns>
        public IReadOnlyList<string> EnumerateCollageMarkerIds()
        {
            var dir = Path.Combine(_dir, LegacyCollagesFolder);
            if (!Directory.Exists(dir))
            {
                return Array.Empty<string>();
            }

            return Directory.EnumerateFiles(dir, "*.json")
                .Select(Path.GetFileNameWithoutExtension)
                .Where(IsValidListId)
                .Select(id => id!)
                .ToList();
        }

        /// <summary>True when at least one stored list has placeholders (library events are only matched then).</summary>
        /// <returns>Whether any placeholder exists.</returns>
        public bool HasAnyPlaceholders()
        {
            EnsureIndex();
            lock (_indexLock)
            {
                // Every document with at least one placeholder has an entry (possibly with no keys: custom-only).
                // A document that could not be read yet may have some.
                return _indexKeysByList!.Count > 0 || _indexPending.Count > 0;
            }
        }

        /// <summary>Placeholders with this TMDB id and media type.</summary>
        /// <param name="mediaType">"movie" or "tv".</param>
        /// <param name="tmdbId">TMDB id.</param>
        /// <returns>Matching references.</returns>
        public IReadOnlyList<PlaceholderRef> FindByTmdb(string mediaType, int tmdbId) => Find(TmdbKey(mediaType, tmdbId));

        /// <summary>Placeholders with this TVDB id.</summary>
        /// <param name="tvdbId">TVDB id.</param>
        /// <returns>Matching references.</returns>
        public IReadOnlyList<PlaceholderRef> FindByTvdb(int tvdbId) => Find("tvdb:" + tvdbId.ToString(CultureInfo.InvariantCulture));

        /// <summary>Placeholders with this IMDb id.</summary>
        /// <param name="imdbId">IMDb id (tt…).</param>
        /// <returns>Matching references.</returns>
        public IReadOnlyList<PlaceholderRef> FindByImdb(string imdbId) => Find("imdb:" + (imdbId ?? string.Empty).ToLowerInvariant());

        /// <summary>
        /// Forgets every cached document and the reverse index (a restore wrote documents behind the store's back): the
        /// next read of each list comes from disk. Takes no locks; writers that raced the restore save over it as usual.
        /// </summary>
        public void InvalidateAll()
        {
            lock (_cacheLock)
            {
                foreach (var id in _cache.Keys.Concat(_absent.Keys).ToList())
                {
                    BumpGenerationUnlocked(id);
                }

                _cache.Clear();
                _absent.Clear();
            }

            lock (_indexLock)
            {
                _index = null;
                _indexKeysByList = null;
                _indexPending.Clear();
            }

            _backedUp.Clear();
        }

        /// <summary>A deep copy of a document.</summary>
        /// <param name="doc">Document.</param>
        /// <returns>The copy.</returns>
        public static ListDoc Clone(ListDoc doc) =>
            JsonSerializer.Deserialize<ListDoc>(JsonSerializer.Serialize(doc, JsonOptions), JsonOptions)!;

        private void RaiseChanged(string listIdN)
        {
            try
            {
                Changed?.Invoke(listIdN);
            }
            catch (Exception ex)
            {
                _logger.Debug($"[Lists] A document change listener failed: {ex.Message}");
            }
        }

        private static string TmdbKey(string mediaType, int tmdbId) =>
            "tmdb:" + mediaType + ":" + tmdbId.ToString(CultureInfo.InvariantCulture);

        private string PathFor(string listIdN) => Path.Combine(_dir, listIdN + ".json");

        private long GenerationUnlocked(string listIdN) => _generations.TryGetValue(listIdN, out var generation) ? generation : 0;

        private void BumpGenerationUnlocked(string listIdN) => _generations[listIdN] = GenerationUnlocked(listIdN) + 1;

        private static void EnsureValid(string? listIdN)
        {
            if (!IsValidListId(listIdN))
            {
                throw new ArgumentException("List id must be 32 lowercase hex characters.", nameof(listIdN));
            }
        }

        /// <summary>Reads a private administrator summary without caching, seeding or quarantining the document.</summary>
        public ListDoc ReadForAdmin(string listIdN)
        {
            EnsureValid(listIdN);
            return ReadStrict(PathFor(listIdN), listIdN, false);
        }

        private ListDoc ReadStrict(string path, string listIdN, bool quarantine = true)
        {
            try
            {
                var json = File.ReadAllText(path);
                if (string.IsNullOrWhiteSpace(json))
                {
                    throw new InvalidDataException("document is empty");
                }

                var doc = JsonSerializer.Deserialize<ListDoc>(json, JsonOptions) ?? throw new InvalidDataException("document is null");
                Validate(doc, listIdN);
                return doc;
            }
            catch (Exception ex) when (ex is JsonException or InvalidDataException or NotSupportedException)
            {
                _logger.Error($"[Lists] {listIdN}.json is unreadable ({ex.Message}); it is kept as-is and the list is read-only until fixed.");
                if (quarantine) BackupCorrupt(path);
                throw new InvalidDataException($"List document {listIdN} is corrupt.", ex);
            }
        }

        private static void Validate(ListDoc doc, string listIdN)
        {
            if (!string.Equals(doc.ListId, listIdN, StringComparison.Ordinal))
            {
                throw new InvalidDataException("listId does not match the file name");
            }

            if (doc.Schema != ListDoc.CurrentSchema)
            {
                throw new InvalidDataException("unknown schema " + doc.Schema.ToString(CultureInfo.InvariantCulture));
            }

            if (doc.ListKind is not (ListKinds.Playlist or ListKinds.Collection))
            {
                throw new InvalidDataException("unknown listKind");
            }

            if (doc.Items == null || doc.Order == null || doc.Intents == null || doc.Items.Any(i => i == null || string.IsNullOrEmpty(i.Id)))
            {
                throw new InvalidDataException("missing or null collections");
            }

            if (doc.Items.Select(i => i.Id).Distinct(StringComparer.Ordinal).Count() != doc.Items.Count)
            {
                throw new InvalidDataException("duplicate placeholder ids");
            }

            foreach (var item in doc.Items)
            {
                item.Episodes ??= new List<PlaceholderEpisode>();
                item.Expected ??= new List<PlaceholderEpisode>();
                item.Filled ??= new List<FilledEpisode>();
            }
        }

        private void BackupCorrupt(string path)
        {
            // One copy per file per process: repeated reads of a broken file must not pile up backups.
            if (!_backedUp.TryAdd(path, 0))
            {
                return;
            }

            try
            {
                var backup = path + ".corrupt-" + DateTime.UtcNow.ToString("yyyyMMddHHmmss", CultureInfo.InvariantCulture);
                if (!File.Exists(backup))
                {
                    File.Copy(path, backup);
                }
            }
            catch (Exception ex)
            {
                _logger.Warning($"[Lists] Could not back up a corrupt document: {ex.Message}");
            }
        }

        /// <summary>Test seam: how long an index build waits before it reads an unreadable document again.</summary>
        internal TimeSpan IndexRetryDelay { get; set; } = TimeSpan.FromMinutes(1);

        // Loads a document for the index: null when it is absent or corrupt (it has no placeholders that can be
        // used), false when it could not be read right now (an IO or permission error; read again later).
        private bool TryLoadForIndex(string listIdN, out ListDoc? doc)
        {
            try
            {
                doc = Load(listIdN);
                return true;
            }
            catch (InvalidDataException)
            {
                doc = null;
                return true;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                _logger.Warning($"[Lists] Could not read {listIdN}.json for the placeholder index ({ex.Message}); it is read again later.");
                doc = null;
                return false;
            }
        }

        private IReadOnlyList<PlaceholderRef> Find(string key)
        {
            EnsureIndex();
            lock (_indexLock)
            {
                return _index!.TryGetValue(key, out var refs) ? refs.ToList() : (IReadOnlyList<PlaceholderRef>)Array.Empty<PlaceholderRef>();
            }
        }

        private void EnsureIndex()
        {
            lock (_indexLock)
            {
                if (_index != null)
                {
                    RetryPendingUnlocked();
                    return;
                }

                // An unreadable document is skipped (and read again later), and an unexpected failure leaves no index
                // behind: a half-built one would hide every list after it until a restart.
                _index = new Dictionary<string, HashSet<PlaceholderRef>>(StringComparer.Ordinal);
                _indexKeysByList = new Dictionary<string, List<string>>(StringComparer.Ordinal);
                _indexPending.Clear();
                try
                {
                    foreach (var id in EnumerateListIds())
                    {
                        if (!TryLoadForIndex(id, out var doc))
                        {
                            _indexPending.Add(id);
                        }
                        else if (doc != null)
                        {
                            AddToIndexUnlocked(doc);
                        }
                    }
                }
                catch
                {
                    _index = null;
                    _indexKeysByList = null;
                    _indexPending.Clear();
                    throw;
                }

                _indexRetryAtUtc = DateTime.UtcNow + IndexRetryDelay;
            }
        }

        private void RetryPendingUnlocked()
        {
            if (_indexPending.Count == 0 || DateTime.UtcNow < _indexRetryAtUtc)
            {
                return;
            }

            foreach (var id in _indexPending.ToList())
            {
                if (!TryLoadForIndex(id, out var doc))
                {
                    continue;
                }

                _indexPending.Remove(id);
                RemoveFromIndexUnlocked(id);
                if (doc != null)
                {
                    AddToIndexUnlocked(doc);
                }
            }

            _indexRetryAtUtc = DateTime.UtcNow + IndexRetryDelay;
        }

        private void IndexList(ListDoc doc)
        {
            lock (_indexLock)
            {
                if (_index == null)
                {
                    return; // built lazily from disk on first use, which includes this write
                }

                _indexPending.Remove(doc.ListId);
                RemoveFromIndexUnlocked(doc.ListId);
                AddToIndexUnlocked(doc);
            }
        }

        private void RemoveFromIndexUnlocked(string listIdN)
        {
            if (_index == null || _indexKeysByList == null || !_indexKeysByList.Remove(listIdN, out var keys))
            {
                return;
            }

            foreach (var key in keys)
            {
                if (_index.TryGetValue(key, out var refs))
                {
                    refs.RemoveWhere(r => r.ListId == listIdN);
                    if (refs.Count == 0)
                    {
                        _index.Remove(key);
                    }
                }
            }
        }

        private void AddToIndexUnlocked(ListDoc doc)
        {
            if (doc.Items.Count == 0)
            {
                return;
            }

            var keys = new List<string>();
            foreach (var item in doc.Items)
            {
                var reference = new PlaceholderRef(doc.ListId, item.Id);
                if (item.TmdbId is > 0 && item.Kind != PlaceholderKinds.Custom)
                {
                    Add(TmdbKey(item.MediaType, item.TmdbId.Value), reference, keys);
                }

                if (item.TvdbId is > 0)
                {
                    Add("tvdb:" + item.TvdbId.Value.ToString(CultureInfo.InvariantCulture), reference, keys);
                }

                if (!string.IsNullOrEmpty(item.ImdbId))
                {
                    Add("imdb:" + item.ImdbId.ToLowerInvariant(), reference, keys);
                }
            }

            _indexKeysByList![doc.ListId] = keys;
        }

        private void Add(string key, PlaceholderRef reference, List<string> keys)
        {
            if (!_index!.TryGetValue(key, out var refs))
            {
                refs = new HashSet<PlaceholderRef>();
                _index[key] = refs;
            }

            refs.Add(reference);
            keys.Add(key);
        }

        private sealed class Releaser : IDisposable
        {
            private SemaphoreSlim? _semaphore;

            public Releaser(SemaphoreSlim semaphore) => _semaphore = semaphore;

            public void Dispose() => Interlocked.Exchange(ref _semaphore, null)?.Release();
        }
    }
}
