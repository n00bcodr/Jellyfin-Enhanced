using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.ServerCache
{
    /// <summary>One entry read back from the server-side cache.</summary>
    /// <param name="Bytes">The stored bytes.</param>
    /// <param name="ContentType">The content type stored with them (the consumer decides what it accepts).</param>
    /// <param name="FetchedAt">When the bytes were fetched from their source (UTC); a read never changes it.</param>
    /// <param name="ExpiresAt">The consumer's own expiry, if it gave one (UTC).</param>
    public sealed record ServerCacheEntry(byte[] Bytes, string ContentType, DateTime FetchedAt, DateTime? ExpiresAt);

    /// <summary>A JSON value read back from the server-side cache.</summary>
    /// <typeparam name="T">The value's type.</typeparam>
    /// <param name="Value">The value.</param>
    /// <param name="FetchedAt">When it was fetched from its source (UTC).</param>
    /// <param name="ExpiresAt">The consumer's own expiry, if any (UTC).</param>
    public sealed record ServerCacheJson<T>(T Value, DateTime FetchedAt, DateTime? ExpiresAt);

    /// <summary>A namespace a consumer registers before it reads or writes.</summary>
    /// <param name="Name">Lower-case letters and digits, starting with a letter.</param>
    /// <param name="MaxBytes">The namespace's own share of the folder (0: only the overall cap applies).</param>
    /// <param name="DefaultTtl">How long an entry is valid after its fetch when the writer gives no expiry (null: until the overall age limit).</param>
    /// <param name="MaxEntryBytes">Largest entry (bigger files are refused before they are read).</param>
    public sealed record ServerCacheNamespace(string Name, long MaxBytes = 0, TimeSpan? DefaultTtl = null, int MaxEntryBytes = ServerBlobCache.MaxEntryBytes);

    /// <summary>Files and bytes one namespace holds.</summary>
    /// <param name="Name">Namespace.</param>
    /// <param name="Files">Entries.</param>
    /// <param name="Bytes">Bytes on disk (whole file-system blocks).</param>
    /// <param name="MaxBytes">The namespace's own share (0: none).</param>
    public sealed record ServerCacheNamespaceUsage(
        [property: JsonPropertyName("name")] string Name,
        [property: JsonPropertyName("files")] long Files,
        [property: JsonPropertyName("bytes")] long Bytes,
        [property: JsonPropertyName("maxBytes")] long MaxBytes);

    /// <summary>What the cache folder holds, for the admin page.</summary>
    /// <param name="Enabled">Whether the cache is on.</param>
    /// <param name="Folder">The resolved folder (empty when the setting is invalid).</param>
    /// <param name="FolderError">Why the folder can't be used, if it can't.</param>
    /// <param name="Files">Entries.</param>
    /// <param name="Bytes">Bytes on disk (whole file-system blocks).</param>
    /// <param name="MaxBytes">The size cap (0 = unlimited).</param>
    /// <param name="MaxAgeDays">The age limit (0 = none).</param>
    /// <param name="Namespaces">Per-namespace usage.</param>
    public sealed record ServerCacheUsage(
        [property: JsonPropertyName("enabled")] bool Enabled,
        [property: JsonPropertyName("folder")] string Folder,
        [property: JsonPropertyName("folderError")] string? FolderError,
        [property: JsonPropertyName("files")] long Files,
        [property: JsonPropertyName("bytes")] long Bytes,
        [property: JsonPropertyName("maxBytes")] long MaxBytes,
        [property: JsonPropertyName("maxAgeDays")] int MaxAgeDays,
        [property: JsonPropertyName("namespaces")] IReadOnlyList<ServerCacheNamespaceUsage> Namespaces);

    /// <summary>
    /// A namespaced on-disk store for public data JE fetches from elsewhere (TMDB artwork first), so a
    /// repeat request or a restart doesn't fetch it again. Each entry is one file,
    /// <c>&lt;folder&gt;/&lt;namespace&gt;/&lt;2 hex&gt;/&lt;SHA-256 of namespace and key&gt;.blob</c>, holding a small
    /// header (the key, the content type, when it was fetched, the writer's expiry) and the bytes; it is
    /// written to a temporary file and renamed into place, and a file that doesn't read back (truncated,
    /// another key, too large) is deleted and counts as a miss. A file's modification time is its last
    /// access (touched at most hourly on a hit); the fetch time in the header is its age, and a read never
    /// renews it. An entry is valid until the earliest of the writer's expiry (or the namespace's default
    /// lifetime), the reader's own maximum age and the configured age limit. One size cap covers every
    /// namespace, and a namespace may have its own share under it: past either, the least recently used
    /// entries go (down to 90%); sizes count whole file-system blocks. A write carries the generation it
    /// started in, and Clear or a change of folder or switch ends that generation, so a write that was
    /// under way never brings cleared data back. File names never come from a request, and the sweeps and
    /// Clear only touch files of that exact shape, never following a symbolic link, so other files in a
    /// shared folder are left alone. File reads and writes run a few at a time. The store never fetches
    /// anything and decides nothing about who may see an entry: consumers keep their own admission and
    /// checks and store only public data (no credential, signed URL or user identity).
    /// </summary>
    public sealed class ServerBlobCache
    {
        /// <summary>The default folder's name inside the plugin's data folder.</summary>
        public const string DefaultFolderName = "server-cache";

        /// <summary>Largest entry any namespace may store.</summary>
        public const int MaxEntryBytes = 64 * 1024 * 1024;

        /// <summary>File reads and writes running at once (the rest wait their turn).</summary>
        public const int MaxConcurrentIo = 16;

        private const double LowWatermark = 0.9;
        private const int MaxKeyBytes = 1024;
        private const int MaxContentTypeBytes = 128;
        private const long BlockBytes = 4096;
        private const int FixedHeaderBytes = 5 + 2 + 1 + 8 + 8 + 4;
        private static readonly byte[] Magic = { (byte)'J', (byte)'E', (byte)'B', (byte)'C', 1 };
        private static readonly Regex NamespacePattern = new("^[a-z][a-z0-9]{0,31}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
        private static readonly Regex ShardPattern = new("^[0-9a-f]{2}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
        private static readonly Regex BlobPattern = new("^[0-9a-f]{64}\\.blob$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
        private static readonly Regex TempPattern = new("^[0-9a-f]{64}\\.[0-9a-f]{16}\\.tmp$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
        private static readonly TimeSpan TouchEvery = TimeSpan.FromHours(1);
        private static readonly TimeSpan TempLifetime = TimeSpan.FromHours(1);
        private static readonly TimeSpan FolderRetry = TimeSpan.FromMinutes(5);

        private readonly Func<ServerCacheSettings> _settings;
        private readonly ServerCacheLocation _location;
        private readonly Logger? _logger;
        private readonly Func<DateTime> _now;
        private readonly SemaphoreSlim _sweepLock = new(1, 1);
        private readonly SemaphoreSlim _io = new(MaxConcurrentIo, MaxConcurrentIo);
        private readonly object _lock = new();
        private readonly Dictionary<string, ServerCacheNamespace> _namespaces = new(StringComparer.Ordinal);
        private readonly Dictionary<string, long> _namespaceBytes = new(StringComparer.Ordinal);
        private ServerCacheSettings? _seen;
        private string? _folder;
        private string? _folderError;
        private DateTime _folderErrorAt;
        private long _bytes;
        private long _generation;
        private DateTime _lastSweep = DateTime.MinValue;
        private Task _pendingSweep = Task.CompletedTask;
        private bool _sweepAgain;

        /// <summary>Creates the store.</summary>
        /// <param name="settings">The current settings (read on every call; changes take effect on the next one).</param>
        /// <param name="location">Where the folder may be.</param>
        /// <param name="logger">Logger, if any.</param>
        /// <param name="now">Clock (tests).</param>
        public ServerBlobCache(Func<ServerCacheSettings> settings, ServerCacheLocation location, Logger? logger, Func<DateTime>? now = null)
        {
            _settings = settings;
            _location = location;
            _logger = logger;
            _now = now ?? (() => DateTime.UtcNow);
        }

        /// <summary>Where the folder may be.</summary>
        public ServerCacheLocation Location => _location;

        /// <summary>How long after a sweep an over-cap write waits before the next one.</summary>
        internal TimeSpan SweepDebounce { get; set; } = TimeSpan.FromSeconds(30);

        /// <summary>The sweep an over-cap write or a settings change started, if any (tests).</summary>
        internal Task PendingSweep { get { lock (_lock) return _pendingSweep; } }

        /// <summary>True when the cache is on and its folder can be used.</summary>
        public bool Enabled => Current() is { Enabled: true } && Folder() != null;

        /// <summary>
        /// The current generation. Capture it before reading what an entry is made from and pass it to
        /// <see cref="PutAsync"/>: Clear, or a change of folder or switch since, refuses the write.
        /// </summary>
        public long Generation
        {
            get
            {
                Current();
                return Interlocked.Read(ref _generation);
            }
        }

        /// <summary>Reads the settings now (a saved configuration): a lowered limit is swept at once, not at the next read or write.</summary>
        public void SettingsChanged() => Current();

        /// <summary>True for a namespace name the store accepts (lower-case letters and digits, starting with a letter).</summary>
        /// <param name="ns">Namespace.</param>
        /// <returns>Valid.</returns>
        public static bool IsNamespace(string? ns) => ns != null && NamespacePattern.IsMatch(ns);

        /// <summary>Registers (or updates) a namespace; reads and writes of an unregistered one are refused.</summary>
        /// <param name="ns">The namespace and its limits.</param>
        public void Register(ServerCacheNamespace ns)
        {
            if (!IsNamespace(ns.Name)) throw new ArgumentException("Namespace names are lower-case letters and digits, starting with a letter.", nameof(ns));
            if (ns.MaxEntryBytes is <= 0 or > MaxEntryBytes || ns.MaxBytes < 0) throw new ArgumentOutOfRangeException(nameof(ns));
            lock (_lock)
            {
                _namespaces[ns.Name] = ns;
                _namespaceBytes.TryAdd(ns.Name, 0);
            }
        }

        /// <summary>
        /// Reads an entry; null when off, missing, past its validity or unreadable (an unreadable or
        /// expired file is removed; one only older than <paramref name="maxAge"/> is kept for other readers).
        /// </summary>
        /// <param name="ns">A registered namespace.</param>
        /// <param name="key">The consumer's canonical key (up to 1 KiB of text; hashed, never used as a path).</param>
        /// <param name="ct">Cancellation.</param>
        /// <param name="maxAge">The reader's own, stricter, maximum age.</param>
        /// <returns>The entry, or null.</returns>
        public async Task<ServerCacheEntry?> TryGetAsync(string ns, string key, CancellationToken ct, TimeSpan? maxAge = null)
        {
            var settings = Current();
            if (!settings.Enabled || Options(ns) is not { } options || Folder() is not { } folder) return null;
            var path = EntryPath(folder, ns, key);
            FileInfo info;
            ServerCacheEntry? entry;
            await _io.WaitAsync(ct).ConfigureAwait(false);
            try
            {
                info = new FileInfo(path);
                if (!info.Exists || info.LinkTarget != null) return null;
                // Refused before anything is allocated for it.
                if (info.Length > options.MaxEntryBytes + FixedHeaderBytes + MaxKeyBytes + MaxContentTypeBytes)
                {
                    Remove(info, ns);
                    return null;
                }

                entry = Parse(await File.ReadAllBytesAsync(path, ct).ConfigureAwait(false), key);
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception)
            {
                return null;
            }
            finally
            {
                _io.Release();
            }

            var now = _now();
            if (entry == null || Expired(entry.FetchedAt, entry.ExpiresAt, settings, options, now))
            {
                Remove(info, ns);
                return null;
            }

            if (maxAge is { } limit && now - entry.FetchedAt >= limit) return null;
            try
            {
                // The last access only: the fetch time in the header stays as it was.
                if (now - info.LastWriteTimeUtc >= TouchEvery) File.SetLastWriteTimeUtc(path, now);
            }
            catch (Exception)
            {
                // A read-only folder still serves what it holds.
            }

            return entry;
        }

        /// <summary>Stores an entry (replacing one with the same key); nothing happens when off or the folder can't be used.</summary>
        /// <param name="ns">A registered namespace.</param>
        /// <param name="key">The consumer's canonical key.</param>
        /// <param name="bytes">Bytes (at most the namespace's largest entry).</param>
        /// <param name="contentType">Content type kept with them.</param>
        /// <param name="ct">Cancellation.</param>
        /// <param name="generation">The <see cref="Generation"/> captured before the bytes' inputs were read (null: now).</param>
        /// <param name="expiresAt">The consumer's own expiry (null: the namespace's default lifetime, if any).</param>
        /// <param name="fetchedAt">When the bytes were fetched (null: now); never later than now.</param>
        /// <returns>True when stored.</returns>
        public async Task<bool> PutAsync(string ns, string key, byte[] bytes, string contentType, CancellationToken ct,
            long? generation = null, DateTime? expiresAt = null, DateTime? fetchedAt = null)
        {
            var settings = Current();
            var started = generation ?? Interlocked.Read(ref _generation);
            if (!settings.Enabled || Options(ns) is not { } options || Folder() is not { } folder) return false;
            var keyBytes = Encoding.UTF8.GetBytes(key);
            var typeBytes = Encoding.UTF8.GetBytes(contentType ?? string.Empty);
            if (bytes.Length > options.MaxEntryBytes || keyBytes.Length > MaxKeyBytes || typeBytes.Length > MaxContentTypeBytes) return false;
            var now = _now();
            var fetched = fetchedAt is { } given && given < now ? given.ToUniversalTime() : now;
            var expires = expiresAt?.ToUniversalTime();
            if (options.DefaultTtl is { } ttl && (expires == null || fetched + ttl < expires)) expires = fetched + ttl;
            if (Expired(fetched, expires, settings, options, now)) return false;
            var size = Blocks(FixedHeaderBytes + keyBytes.Length + typeBytes.Length + bytes.Length);
            if ((settings.MaxBytes > 0 && size > settings.MaxBytes) || (options.MaxBytes > 0 && size > options.MaxBytes)) return false;
            var hash = Hash(ns, key);
            var nsFolder = Path.Combine(folder, ns);
            var shard = Path.Combine(nsFolder, hash.Substring(0, 2));
            var final = Path.Combine(shard, hash + ".blob");
            var temp = Path.Combine(shard, hash + "." + Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(8)) + ".tmp");
            await _io.WaitAsync(ct).ConfigureAwait(false);
            try
            {
                if (Interlocked.Read(ref _generation) != started) return false;
                Directory.CreateDirectory(shard);
                // Never write through a link someone put in the folder.
                if (new DirectoryInfo(nsFolder).LinkTarget != null || new DirectoryInfo(shard).LinkTarget != null) return false;
                await using (var file = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None, 81920, FileOptions.Asynchronous))
                {
                    await file.WriteAsync(Header(keyBytes, typeBytes, fetched, expires, bytes.Length), ct).ConfigureAwait(false);
                    await file.WriteAsync(bytes, ct).ConfigureAwait(false);
                }

                File.SetLastWriteTimeUtc(temp, now);
                long total, inNamespace;
                lock (_lock)
                {
                    // The commit and Clear's new generation are ordered: a write that started before a Clear never lands after it.
                    if (_generation != started)
                    {
                        TryDelete(temp);
                        return false;
                    }

                    var previous = new FileInfo(final);
                    var replaced = previous.Exists && previous.LinkTarget == null ? Blocks(previous.Length) : 0;
                    File.Move(temp, final, overwrite: true);
                    total = Interlocked.Add(ref _bytes, size - replaced);
                    inNamespace = _namespaceBytes[ns] = _namespaceBytes.GetValueOrDefault(ns) + size - replaced;
                }

                if ((settings.MaxBytes > 0 && total > settings.MaxBytes) || (options.MaxBytes > 0 && inNamespace > options.MaxBytes)) ScheduleSweep();
                return true;
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                TryDelete(temp);
                return false;
            }
            catch (OperationCanceledException)
            {
                TryDelete(temp);
                throw;
            }
            finally
            {
                _io.Release();
            }
        }

        /// <summary>Reads a JSON value (see <see cref="TryGetAsync"/>); one that doesn't deserialize is removed.</summary>
        /// <typeparam name="T">The value's type.</typeparam>
        /// <param name="ns">A registered namespace.</param>
        /// <param name="key">The consumer's canonical key.</param>
        /// <param name="options">Serializer options, if any.</param>
        /// <param name="ct">Cancellation.</param>
        /// <param name="maxAge">The reader's own maximum age.</param>
        /// <returns>The value, or null.</returns>
        public async Task<ServerCacheJson<T>?> TryGetJsonAsync<T>(string ns, string key, JsonSerializerOptions? options, CancellationToken ct, TimeSpan? maxAge = null)
        {
            if (await TryGetAsync(ns, key, ct, maxAge).ConfigureAwait(false) is not { } entry) return null;
            try
            {
                if (entry.ContentType == JsonContentType && JsonSerializer.Deserialize<T>(entry.Bytes, options) is { } value)
                    return new ServerCacheJson<T>(value, entry.FetchedAt, entry.ExpiresAt);
            }
            catch (JsonException)
            {
                // Removed below, like any entry that doesn't read back.
            }

            await ForgetAsync(ns, key, ct).ConfigureAwait(false);
            return null;
        }

        /// <summary>Stores a JSON value (see <see cref="PutAsync"/>).</summary>
        /// <typeparam name="T">The value's type.</typeparam>
        /// <param name="ns">A registered namespace.</param>
        /// <param name="key">The consumer's canonical key.</param>
        /// <param name="value">The value (public data only).</param>
        /// <param name="options">Serializer options, if any.</param>
        /// <param name="ct">Cancellation.</param>
        /// <param name="generation">The generation captured before the value's inputs were read.</param>
        /// <param name="expiresAt">The consumer's own expiry.</param>
        /// <param name="fetchedAt">When the value was fetched.</param>
        /// <returns>True when stored.</returns>
        public Task<bool> PutJsonAsync<T>(string ns, string key, T value, JsonSerializerOptions? options, CancellationToken ct,
            long? generation = null, DateTime? expiresAt = null, DateTime? fetchedAt = null)
            => PutAsync(ns, key, JsonSerializer.SerializeToUtf8Bytes(value, options), JsonContentType, ct, generation, expiresAt, fetchedAt);

        /// <summary>The content type JSON values are stored with.</summary>
        public const string JsonContentType = "application/json";

        /// <summary>Removes one entry (a consumer's invalidation); it also ends the current generation.</summary>
        /// <param name="ns">A registered namespace.</param>
        /// <param name="key">The consumer's canonical key.</param>
        /// <param name="ct">Cancellation.</param>
        /// <returns>True when an entry was removed.</returns>
        public Task<bool> ForgetAsync(string ns, string key, CancellationToken ct)
        {
            Current();
            if (Options(ns) == null || Folder(create: false) is not { } folder) return Task.FromResult(false);
            Interlocked.Increment(ref _generation);
            var info = new FileInfo(EntryPath(folder, ns, key));
            return Task.FromResult(info.Exists && info.LinkTarget == null && Remove(info, ns));
        }

        /// <summary>
        /// Removes entries past their validity and, when the folder or a namespace is over its cap, the least
        /// recently used ones (down to 90%), plus temporary files an interrupted write left. A full sweep also
        /// reads each remaining entry's header (the scheduled task); otherwise only last-access times are used.
        /// </summary>
        /// <param name="full">Read every entry's header.</param>
        /// <param name="ct">Cancellation.</param>
        /// <returns>Entries removed.</returns>
        public async Task<int> SweepAsync(bool full, CancellationToken ct)
        {
            var settings = Current();
            // A cache that is off and was never created is left alone.
            if (Folder(create: false) is not { } folder || !Directory.Exists(folder)) return 0;
            await _sweepLock.WaitAsync(ct).ConfigureAwait(false);
            try
            {
                var now = _now();
                var removed = 0;
                var entries = new List<(FileInfo File, string Ns)>();
                foreach (var (file, ns, temp) in Enumerate(folder))
                {
                    ct.ThrowIfCancellationRequested();
                    if (temp)
                    {
                        // A temporary file's time is the file system's own (a write in progress never set it).
                        if (DateTime.UtcNow - file.LastWriteTimeUtc >= TempLifetime) TryDelete(file.FullName);
                        continue;
                    }

                    var options = Options(ns) ?? new ServerCacheNamespace(ns);
                    // The last access is never before the fetch, so an entry unused since the cutoff is too old.
                    var stale = settings.MaxAgeDays > 0 && file.LastWriteTimeUtc < now - TimeSpan.FromDays(settings.MaxAgeDays);
                    if (!stale && full)
                    {
                        var times = Times(file);
                        stale = times == null || Expired(times.Value.Fetched, times.Value.Expires, settings, options, now);
                    }

                    if (stale)
                    {
                        if (TryDelete(file.FullName)) removed++;
                        continue;
                    }

                    entries.Add((file, ns));
                }

                var kept = new List<(FileInfo File, string Ns)>();
                foreach (var group in entries.GroupBy(e => e.Ns, StringComparer.Ordinal))
                {
                    var cap = Options(group.Key)?.MaxBytes ?? 0;
                    removed += Evict(group.ToList(), cap, kept);
                }

                var survivors = new List<(FileInfo File, string Ns)>();
                removed += Evict(kept, settings.MaxBytes, survivors);
                lock (_lock)
                {
                    Interlocked.Exchange(ref _bytes, survivors.Sum(e => Blocks(e.File.Length)));
                    foreach (var name in _namespaceBytes.Keys.ToList()) _namespaceBytes[name] = 0;
                    foreach (var group in survivors.GroupBy(e => e.Ns, StringComparer.Ordinal))
                    {
                        if (_namespaceBytes.ContainsKey(group.Key)) _namespaceBytes[group.Key] = group.Sum(e => Blocks(e.File.Length));
                    }

                    _lastSweep = now;
                }

                if (removed > 0) _logger?.Debug($"[Server cache] Removed {removed} entries; {Interlocked.Read(ref _bytes) / (1024 * 1024)} MiB kept.");
                return removed;
            }
            finally
            {
                _sweepLock.Release();
            }
        }

        /// <summary>Deletes every entry (of one namespace, or all) and the folders the store made for them.</summary>
        /// <param name="ns">A namespace, or null for all.</param>
        /// <param name="ct">Cancellation.</param>
        /// <returns>Entries removed.</returns>
        public async Task<int> ClearAsync(string? ns, CancellationToken ct)
        {
            if (ns != null && !IsNamespace(ns)) return 0;
            Current();
            // Writes under way from before this point are refused at their commit.
            lock (_lock) _generation++;
            if (Folder(create: false) is not { } folder || !Directory.Exists(folder)) return 0;
            await _sweepLock.WaitAsync(ct).ConfigureAwait(false);
            try
            {
                var removed = 0;
                foreach (var (file, fileNs, temp) in Enumerate(folder))
                {
                    if (ns != null && fileNs != ns) continue;
                    if (TryDelete(file.FullName) && !temp) removed++;
                }

                foreach (var nsDir in SafeDirectories(new DirectoryInfo(folder), NamespacePattern))
                {
                    if (ns != null && nsDir.Name != ns) continue;
                    foreach (var shard in SafeDirectories(nsDir, ShardPattern)) TryDeleteEmpty(shard.FullName);
                    TryDeleteEmpty(nsDir.FullName);
                }

                Recount(folder);
                _logger?.Info($"[Server cache] Cleared {removed} entries{(ns == null ? string.Empty : " from " + ns)}.");
                return removed;
            }
            finally
            {
                _sweepLock.Release();
            }
        }

        /// <summary>Counts what the folder holds (and refreshes the running totals).</summary>
        /// <returns>Usage.</returns>
        public ServerCacheUsage Usage()
        {
            var settings = Current();
            var folder = Folder(create: settings.Enabled);
            var spaces = new SortedDictionary<string, (long Files, long Bytes)>(StringComparer.Ordinal);
            if (folder != null && Directory.Exists(folder))
            {
                foreach (var (ns, files, bytes) in Recount(folder)) spaces[ns] = (files, bytes);
            }

            string? error;
            Dictionary<string, long> caps;
            lock (_lock)
            {
                error = _folderError;
                caps = _namespaces.ToDictionary(n => n.Key, n => n.Value.MaxBytes, StringComparer.Ordinal);
            }

            return new ServerCacheUsage(settings.Enabled, folder ?? string.Empty, error, spaces.Values.Sum(s => s.Files), spaces.Values.Sum(s => s.Bytes),
                settings.MaxBytes, settings.MaxAgeDays,
                spaces.Select(s => new ServerCacheNamespaceUsage(s.Key, s.Value.Files, s.Value.Bytes, caps.GetValueOrDefault(s.Key))).ToList());
        }

        /// <summary>
        /// The current settings. A change of folder or switch ends the generation (and a folder change resets
        /// the running totals); any change starts a sweep, so a lowered limit applies without waiting for a write.
        /// </summary>
        private ServerCacheSettings Current()
        {
            var settings = _settings();
            lock (_lock)
            {
                if (_seen == settings) return settings;
                if (_seen == null || _seen.Folder != settings.Folder)
                {
                    _folder = null;
                    _folderError = null;
                    Interlocked.Exchange(ref _bytes, 0);
                    foreach (var name in _namespaceBytes.Keys.ToList()) _namespaceBytes[name] = 0;
                }

                if (_seen != null && (_seen.Folder != settings.Folder || _seen.Enabled != settings.Enabled)) _generation++;
                _seen = settings;
            }

            ScheduleSweep(force: true);
            return settings;
        }

        private ServerCacheNamespace? Options(string ns)
        {
            lock (_lock) return _namespaces.GetValueOrDefault(ns);
        }

        /// <summary>The earliest of the writer's expiry, the namespace's default lifetime and the configured age limit has passed.</summary>
        private static bool Expired(DateTime fetched, DateTime? expires, ServerCacheSettings settings, ServerCacheNamespace options, DateTime now)
            => fetched > now.AddDays(1)
               || (expires is { } at && now >= at)
               || (options.DefaultTtl is { } ttl && now - fetched >= ttl)
               || (settings.MaxAgeDays > 0 && now - fetched >= TimeSpan.FromDays(settings.MaxAgeDays));

        /// <summary>Keeps <paramref name="entries"/> under <paramref name="cap"/> (0: no cap), least recently used first; the rest go to <paramref name="kept"/>.</summary>
        private static int Evict(List<(FileInfo File, string Ns)> entries, long cap, List<(FileInfo File, string Ns)> kept)
        {
            var total = entries.Sum(e => Blocks(e.File.Length));
            if (cap <= 0 || total <= cap)
            {
                kept.AddRange(entries);
                return 0;
            }

            var removed = 0;
            var target = (long)(cap * LowWatermark);
            foreach (var entry in entries.OrderBy(e => e.File.LastWriteTimeUtc).ThenBy(e => e.File.Name, StringComparer.Ordinal))
            {
                if (total > target && TryDelete(entry.File.FullName))
                {
                    total -= Blocks(entry.File.Length);
                    removed++;
                }
                else
                {
                    kept.Add(entry);
                }
            }

            return removed;
        }

        /// <summary>Counts the folder per namespace and sets the running totals from it.</summary>
        private List<(string Ns, long Files, long Bytes)> Recount(string folder)
        {
            var counted = Enumerate(folder).Where(e => !e.Temp).GroupBy(e => e.Ns, StringComparer.Ordinal)
                .Select(g => (Ns: g.Key, Files: (long)g.Count(), Bytes: g.Sum(e => Blocks(e.File.Length)))).ToList();
            lock (_lock)
            {
                Interlocked.Exchange(ref _bytes, counted.Sum(c => c.Bytes));
                foreach (var name in _namespaceBytes.Keys.ToList()) _namespaceBytes[name] = counted.FirstOrDefault(c => c.Ns == name).Bytes;
            }

            return counted;
        }

        /// <summary>
        /// The resolved folder; null when the setting can't be used. With <paramref name="create"/> (reads and
        /// writes of a cache that is on) the folder is created and checked writable once per setting (a failed
        /// check is retried after a few minutes); without it, the folder is only resolved (sweeps, Clear, usage).
        /// </summary>
        private string? Folder(bool create = true)
        {
            string configured;
            lock (_lock)
            {
                if (_folder != null) return _folder;
                if (_folderError != null && _now() - _folderErrorAt < FolderRetry) return null;
                configured = _seen?.Folder ?? string.Empty;
            }

            var error = _location.Resolve(configured, out var full);
            if (error == null && create) error = ServerCacheLocation.CheckWritable(full);
            lock (_lock)
            {
                if ((_seen?.Folder ?? string.Empty) != configured) return null;
                if (error != null)
                {
                    if (_folderError != error) _logger?.Warning($"[Server cache] The cache folder can't be used, so nothing is cached on disk: {error}");
                    _folderError = error;
                    _folderErrorAt = _now();
                    return null;
                }

                _folderError = null;
                if (create) _folder = full;
                return full;
            }
        }

        /// <summary>Starts a sweep (after the debounce unless forced); one asked for while one runs runs after it.</summary>
        private void ScheduleSweep(bool force = false)
        {
            lock (_lock)
            {
                if (!_pendingSweep.IsCompleted)
                {
                    _sweepAgain = true;
                    return;
                }

                var wait = force ? TimeSpan.Zero : _lastSweep + SweepDebounce - _now();
                _pendingSweep = Task.Run(async () =>
                {
                    try
                    {
                        if (wait > TimeSpan.Zero) await Task.Delay(wait).ConfigureAwait(false);
                        bool again;
                        do
                        {
                            lock (_lock) _sweepAgain = false;
                            await SweepAsync(full: false, CancellationToken.None).ConfigureAwait(false);
                            lock (_lock) again = _sweepAgain;
                        }
                        while (again);
                    }
                    catch (Exception ex)
                    {
                        _logger?.Warning($"[Server cache] Sweep failed: {ex.GetType().Name}");
                    }
                });
            }
        }

        /// <summary>Every entry and temporary file of the store's own shape under <paramref name="folder"/> (links skipped).</summary>
        private static IEnumerable<(FileInfo File, string Ns, bool Temp)> Enumerate(string folder)
        {
            foreach (var nsDir in SafeDirectories(new DirectoryInfo(folder), NamespacePattern))
            {
                foreach (var shard in SafeDirectories(nsDir, ShardPattern))
                {
                    IEnumerable<FileInfo> files;
                    try
                    {
                        files = shard.EnumerateFiles().ToList();
                    }
                    catch (Exception)
                    {
                        continue;
                    }

                    foreach (var file in files)
                    {
                        if (file.LinkTarget != null) continue;
                        if (BlobPattern.IsMatch(file.Name)) yield return (file, nsDir.Name, false);
                        else if (TempPattern.IsMatch(file.Name)) yield return (file, nsDir.Name, true);
                    }
                }
            }
        }

        private static IEnumerable<DirectoryInfo> SafeDirectories(DirectoryInfo parent, Regex name)
        {
            try
            {
                return parent.EnumerateDirectories().Where(d => d.LinkTarget == null && name.IsMatch(d.Name)).ToList();
            }
            catch (Exception)
            {
                return Array.Empty<DirectoryInfo>();
            }
        }

        private bool Remove(FileInfo file, string ns)
        {
            if (!TryDelete(file.FullName)) return false;
            var size = Blocks(file.Length);
            Interlocked.Add(ref _bytes, -size);
            lock (_lock)
            {
                if (_namespaceBytes.TryGetValue(ns, out var bytes)) _namespaceBytes[ns] = Math.Max(0, bytes - size);
            }

            return true;
        }

        private static long Blocks(long length) => Math.Max(1, (length + BlockBytes - 1) / BlockBytes) * BlockBytes;

        private static bool TryDelete(string path)
        {
            try
            {
                File.Delete(path);
                return true;
            }
            catch (Exception)
            {
                return false;
            }
        }

        private static void TryDeleteEmpty(string folder)
        {
            try
            {
                if (!Directory.EnumerateFileSystemEntries(folder).Any()) Directory.Delete(folder);
            }
            catch (Exception)
            {
                // Something else is in there; it stays.
            }
        }

        private static string Hash(string ns, string key)
            => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(ns + "\n" + key)));

        private static string EntryPath(string folder, string ns, string key)
        {
            var hash = Hash(ns, key);
            return Path.Combine(folder, ns, hash.Substring(0, 2), hash + ".blob");
        }

        // Layout: magic (5) | key length (2) | key | type length (1) | type | fetched ticks (8) | expiry ticks, 0 = none (8) | body length (4) | body.
        private static byte[] Header(byte[] key, byte[] type, DateTime fetched, DateTime? expires, int length)
        {
            var header = new byte[FixedHeaderBytes + key.Length + type.Length];
            var at = 0;
            Magic.CopyTo(header, at);
            at += Magic.Length;
            BinaryPrimitives.WriteUInt16LittleEndian(header.AsSpan(at), (ushort)key.Length);
            at += 2;
            key.CopyTo(header, at);
            at += key.Length;
            header[at++] = (byte)type.Length;
            type.CopyTo(header, at);
            at += type.Length;
            BinaryPrimitives.WriteInt64LittleEndian(header.AsSpan(at), fetched.Ticks);
            at += 8;
            BinaryPrimitives.WriteInt64LittleEndian(header.AsSpan(at), expires?.Ticks ?? 0);
            at += 8;
            BinaryPrimitives.WriteInt32LittleEndian(header.AsSpan(at), length);
            return header;
        }

        /// <summary>Reads a header: the key, type, times and body offset and length; null when it isn't one.</summary>
        private static (string Key, string Type, DateTime Fetched, DateTime? Expires, int Body, int Length)? ReadHeader(ReadOnlySpan<byte> span)
        {
            if (span.Length < Magic.Length + 2 || !span.Slice(0, Magic.Length).SequenceEqual(Magic)) return null;
            var at = Magic.Length;
            int keyLength = BinaryPrimitives.ReadUInt16LittleEndian(span.Slice(at));
            at += 2;
            if (keyLength > MaxKeyBytes || span.Length < at + keyLength + 1) return null;
            var key = Encoding.UTF8.GetString(span.Slice(at, keyLength));
            at += keyLength;
            int typeLength = span[at++];
            if (typeLength > MaxContentTypeBytes || span.Length < at + typeLength + 20) return null;
            var type = Encoding.UTF8.GetString(span.Slice(at, typeLength));
            at += typeLength;
            var fetched = BinaryPrimitives.ReadInt64LittleEndian(span.Slice(at));
            var expires = BinaryPrimitives.ReadInt64LittleEndian(span.Slice(at + 8));
            var length = BinaryPrimitives.ReadInt32LittleEndian(span.Slice(at + 16));
            at += 20;
            if (fetched <= 0 || fetched > DateTime.MaxValue.Ticks || expires < 0 || expires > DateTime.MaxValue.Ticks || length < 0) return null;
            return (key, type, new DateTime(fetched, DateTimeKind.Utc), expires == 0 ? null : new DateTime(expires, DateTimeKind.Utc), at, length);
        }

        /// <summary>Reads a file's bytes back; null unless it is a whole entry for <paramref name="key"/>.</summary>
        private static ServerCacheEntry? Parse(byte[] data, string key)
        {
            if (ReadHeader(data) is not { } header || !string.Equals(header.Key, key, StringComparison.Ordinal) || data.Length - header.Body != header.Length) return null;
            return new ServerCacheEntry(data.AsSpan(header.Body).ToArray(), header.Type, header.Fetched, header.Expires);
        }

        /// <summary>An entry's fetch time and expiry from its header; null when it isn't a whole entry.</summary>
        private static (DateTime Fetched, DateTime? Expires)? Times(FileInfo file)
        {
            try
            {
                using var stream = new FileStream(file.FullName, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                var head = new byte[FixedHeaderBytes + MaxKeyBytes + MaxContentTypeBytes];
                var read = stream.ReadAtLeast(head, head.Length, throwOnEndOfStream: false);
                if (ReadHeader(head.AsSpan(0, read)) is not { } header || file.Length != header.Body + (long)header.Length) return null;
                return (header.Fetched, header.Expires);
            }
            catch (Exception)
            {
                return null;
            }
        }
    }
}
