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
    public sealed record ServerCacheEntry(byte[] Bytes, string ContentType, DateTime FetchedAt, DateTime? ExpiresAt)
    {
        /// <summary>The write this entry came from (a removal is checked against it).</summary>
        internal ulong WriteId { get; init; }
    }

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
    /// header (the key, the content type, when it was fetched, the writer's expiry, a random write id) and the
    /// bytes. Every file operation goes through <see cref="CacheFolderAccess"/>, confined to the folder's real path
    /// and never following a symbolic link (anchored handles; Linux only, elsewhere the cache stays off). A folder
    /// is used only once it is the cache's own (new, empty or holding its verified marker), for writes and for every
    /// sweep or Clear alike.
    /// <list type="bullet">
    /// <item><description>Writes go to a temporary file renamed into place under the commit lock, carrying the
    /// generation they started in: Clear, Forget, a change of folder or switching the cache off ends it, and a write from an
    /// earlier generation is refused at its commit, so cleared or forgotten data never comes back.</description></item>
    /// <item><description>A read opens the file once, checks the bounded header (key, sizes, the namespace's largest
    /// entry) before anything is allocated for the body, then reads the body from the same handle. A file that
    /// doesn't read back, or is past its validity, is removed only if it is still the very file that was read (its
    /// write id), never a replacement written meanwhile.</description></item>
    /// <item><description>Validity is the earliest of the writer's expiry (or the namespace's default lifetime), the
    /// reader's own maximum age and the configured age limit, from the fetch time, which a read never renews; the
    /// last access (the file's time, touched at most hourly) orders eviction.</description></item>
    /// <item><description>One size cap covers every namespace, and a namespace may have its own share under it: past
    /// either, the least recently used entries go (down to 90%). Sizes count whole 4 KiB blocks, temporary files
    /// and writes under way included. Running totals are reconciled with each sweep's count without losing a change
    /// made while it counted.</description></item>
    /// <item><description>Disk reads and writes are bounded: a few run at once, a few more may wait, the same entry
    /// is read once for every caller waiting on it, and beyond that a read is a miss and a write is skipped.</description></item>
    /// </list>
    /// File names never come from a request, and the sweeps and Clear only touch files of the store's own shape,
    /// so other files in a shared folder are left alone. The store never fetches anything and decides nothing
    /// about who may see an entry: consumers keep their own admission and checks and store only public data (no
    /// credential, signed URL or user identity).
    /// </summary>
    public sealed class ServerBlobCache
    {
        /// <summary>The default folder's name inside the plugin's data folder.</summary>
        public const string DefaultFolderName = "server-cache";

        /// <summary>Largest entry any namespace may store.</summary>
        public const int MaxEntryBytes = 64 * 1024 * 1024;

        /// <summary>File reads and writes running at once.</summary>
        public const int MaxConcurrentIo = 16;

        /// <summary>File reads and writes running or waiting at once; beyond it a read is a miss and a write is skipped.</summary>
        public const int MaxPendingIo = 64;

        /// <summary>The content type JSON values are stored with.</summary>
        public const string JsonContentType = "application/json";

        private const double LowWatermark = 0.9;
        private const int MaxKeyBytes = 1024;
        private const int MaxContentTypeBytes = 128;
        private const long BlockBytes = 4096;
        // magic (5) | key length (2) | key | type length (1) | type | fetched (8) | expires (8) | write id (8) | body length (4)
        private const int FixedHeaderBytes = 5 + 2 + 1 + 8 + 8 + 8 + 4;
        private const int MaxHeaderBytes = FixedHeaderBytes + MaxKeyBytes + MaxContentTypeBytes;
        private static readonly byte[] Magic = { (byte)'J', (byte)'E', (byte)'B', (byte)'C', 2 };
        private static readonly Regex NamespacePattern = new("^[a-z][a-z0-9]{0,31}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
        private static readonly Regex ShardPattern = new("^[0-9a-f]{2}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
        private static readonly Regex BlobPattern = new("^[0-9a-f]{64}\\.blob$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
        private static readonly Regex TempPattern = new("^[0-9a-f]{64}\\.[0-9a-f]{16}\\.tmp$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
        private static readonly TimeSpan TouchEvery = TimeSpan.FromHours(1);
        private static readonly TimeSpan FolderRetry = TimeSpan.FromMinutes(5);

        private readonly Func<ServerCacheSettings> _settings;
        private readonly ServerCacheLocation _location;
        private readonly Logger? _logger;
        private readonly Func<DateTime> _now;
        private readonly bool _anchored;
        private readonly SemaphoreSlim _sweepLock = new(1, 1);
        private readonly SemaphoreSlim _io = new(MaxConcurrentIo, MaxConcurrentIo);
        private readonly object _lock = new();
        private readonly object _prepareLock = new();
        private readonly Dictionary<string, ServerCacheNamespace> _namespaces = new(StringComparer.Ordinal);
        private readonly Dictionary<string, long> _namespaceBytes = new(StringComparer.Ordinal);
        private readonly Dictionary<string, Task<ServerCacheEntry?>> _reads = new(StringComparer.Ordinal);
        private readonly HashSet<string> _activeTemps = new(StringComparer.Ordinal);
        private ServerCacheSettings? _seen;
        private CacheFolderAccess? _access;
        private string? _folderError;
        private DateTime _folderErrorAt;
        private long _bytes;
        private long _reserved;
        private int _pendingIo;
        // Every end of what a write may land on advances it: a global one (Clear, ForgetAsync, a folder change, switching
        // off) also moves _globalEnd; forgetting one entry records it in _forgotten (bounded: past it, an end is global).
        private long _generation;
        private long _globalEnd;
        private readonly Dictionary<string, long> _forgotten = new(StringComparer.Ordinal);
        private Dictionary<string, (string Ns, long Bytes)?>? _tracker;
        private DateTime _lastSweep = DateTime.MinValue;
        private Task _pendingSweep = Task.CompletedTask;
        private bool _sweepAgain;
        private bool _sweepAgainFull;

        /// <summary>Creates the store.</summary>
        /// <param name="settings">The current settings (read on every call; changes take effect on the next one).</param>
        /// <param name="location">Where the folder may be.</param>
        /// <param name="logger">Logger, if any.</param>
        /// <param name="now">Clock (tests).</param>
        public ServerBlobCache(Func<ServerCacheSettings> settings, ServerCacheLocation location, Logger? logger, Func<DateTime>? now = null)
            : this(settings, location, logger, now, anchored: true)
        {
        }

        /// <summary>Creates the store; <paramref name="anchored"/> false acts as a platform without the confined calls (tests).</summary>
        internal ServerBlobCache(Func<ServerCacheSettings> settings, ServerCacheLocation location, Logger? logger, Func<DateTime>? now, bool anchored)
        {
            _settings = settings;
            _location = location;
            _logger = logger;
            _now = now ?? (() => DateTime.UtcNow);
            _anchored = anchored;
        }

        /// <summary>Where the folder may be.</summary>
        public ServerCacheLocation Location => _location;

        /// <summary>How long after a sweep an over-cap write waits before the next one.</summary>
        internal TimeSpan SweepDebounce { get; set; } = TimeSpan.FromSeconds(30);

        /// <summary>The sweep an over-cap write or a settings change started, if any (tests).</summary>
        internal Task PendingSweep { get { lock (_lock) return _pendingSweep; } }

        /// <summary>Called at fixed points (tests): "read" before a shared read waits for its turn, "commit" inside a write's commit, "counted" when a sweep has counted.</summary>
        internal Action<string>? Hook { get; set; }

        /// <summary>The running total: committed entries plus writes under way (tests).</summary>
        internal long CountedBytes { get { lock (_lock) return _bytes + _reserved; } }

        /// <summary>Whether the folder is used through the anchored (Linux) access (tests).</summary>
        internal bool Anchored => Access(create: false) is LinuxFolderAccess;

        /// <summary>True when the cache is on and its folder can be used (may prepare the folder: not for a request's hot path).</summary>
        public bool Enabled => Current() is { Enabled: true } && Access() != null;

        /// <summary>True when the cache is switched on in the settings; reads only the settings (never the folder), so it never waits on disk.</summary>
        public bool SwitchedOn => Current().Enabled;

        /// <summary>Most entries forgotten one by one (<see cref="ForgetEntryAsync"/>) that are fenced individually.</summary>
        internal const int MaxForgottenEntries = 4096;

        /// <summary>
        /// The current generation. Capture it before reading what an entry is made from and pass it to
        /// <see cref="PutAsync"/>: Clear, Forget, a change of folder or switching the cache off since then refuses the write,
        /// and so does <see cref="ForgetEntryAsync"/> of that entry.
        /// </summary>
        public long Generation
        {
            get
            {
                Current();
                lock (_lock) return _generation;
            }
        }

        /// <summary>True when nothing has ended since <paramref name="generation"/> was captured (Clear, ForgetAsync, a folder change, switching off); forgetting single entries doesn't count.</summary>
        /// <param name="generation">A captured <see cref="Generation"/>.</param>
        /// <returns>Still current.</returns>
        public bool IsCurrent(long generation)
        {
            Current();
            lock (_lock) return generation >= _globalEnd;
        }

        /// <summary>Reads the settings now (a saved configuration): a tightened limit is swept at once, not at the next read or write.</summary>
        public void SettingsChanged() => Current();

        /// <summary>True for a namespace name the store accepts (lower-case letters and digits, starting with a letter).</summary>
        /// <param name="ns">Namespace.</param>
        /// <returns>Valid.</returns>
        public static bool IsNamespace(string? ns) => ns != null && NamespacePattern.IsMatch(ns);

        /// <summary>Registers (or updates) a namespace; reads and writes of an unregistered one are refused. Changed limits are swept at once.</summary>
        /// <param name="ns">The namespace and its limits.</param>
        public void Register(ServerCacheNamespace ns)
        {
            if (!IsNamespace(ns.Name)) throw new ArgumentException("Namespace names are lower-case letters and digits, starting with a letter.", nameof(ns));
            if (ns.MaxEntryBytes is <= 0 or > MaxEntryBytes || ns.MaxBytes < 0) throw new ArgumentOutOfRangeException(nameof(ns));
            bool changed;
            lock (_lock)
            {
                changed = _namespaces.TryGetValue(ns.Name, out var previous) && previous != ns;
                _namespaces[ns.Name] = ns;
                _namespaceBytes.TryAdd(ns.Name, 0);
            }

            if (changed) ScheduleSweep(force: true, full: true);
        }

        /// <summary>
        /// Reads an entry; null when off, missing, past its validity, unreadable, or when the disk is too busy (an
        /// unreadable or expired file is removed; one only older than <paramref name="maxAge"/> is kept for other readers).
        /// Callers asking for the same entry at once share one read.
        /// </summary>
        /// <param name="ns">A registered namespace.</param>
        /// <param name="key">The consumer's canonical key (up to 1 KiB of text; hashed, never used as a path).</param>
        /// <param name="ct">Cancels this caller's wait, not the shared read.</param>
        /// <param name="maxAge">The reader's own, stricter, maximum age.</param>
        /// <returns>The entry, or null.</returns>
        public async Task<ServerCacheEntry?> TryGetAsync(string ns, string key, CancellationToken ct, TimeSpan? maxAge = null)
        {
            var settings = Current();
            if (!settings.Enabled || Options(ns) is not { } options || Access() is not { } access) return null;
            if (Encoding.UTF8.GetByteCount(key) > MaxKeyBytes) return null;
            var id = ns + "\n" + key;
            Task<ServerCacheEntry?> shared;
            lock (_lock)
            {
                // A read under way from before a Forget, Clear or settings change was taken out of _reads by it: a caller
                // arriving afterwards starts its own read and never adopts what the older one read.
                if (!_reads.TryGetValue(id, out shared!))
                {
                    if (_pendingIo >= MaxPendingIo) return null;
                    _pendingIo++;
                    var flight = new TaskCompletionSource<ServerCacheEntry?>(TaskCreationOptions.RunContinuationsAsynchronously);
                    shared = flight.Task;
                    _reads[id] = shared;
                    var own = shared;
                    _ = Task.Run(() => ReadAsync(id, own, flight, access, ns, key, options));
                }
            }

            var entry = await shared.WaitAsync(ct).ConfigureAwait(false);
            if (entry != null && maxAge is { } limit && _now() - entry.FetchedAt >= limit) return null;
            return entry;
        }

        /// <summary>The one read of an entry that every waiting caller shares.</summary>
        private async Task ReadAsync(string id, Task<ServerCacheEntry?> own, TaskCompletionSource<ServerCacheEntry?> flight, CacheFolderAccess access, string ns, string key, ServerCacheNamespace options)
        {
            ServerCacheEntry? result = null;
            try
            {
                result = await ReadOnceAsync(access, ns, key, options).ConfigureAwait(false);
            }
            finally
            {
                lock (_lock)
                {
                    if (_reads.TryGetValue(id, out var current) && ReferenceEquals(current, own)) _reads.Remove(id);
                    _pendingIo--;
                }

                flight.TrySetResult(result);
            }
        }

        private async Task<ServerCacheEntry?> ReadOnceAsync(CacheFolderAccess access, string ns, string key, ServerCacheNamespace options)
        {
            try
            {
                var (shard, name) = Names(ns, key);
                Read read;
                Hook?.Invoke("read");
                await _io.WaitAsync().ConfigureAwait(false);
                try
                {
                    read = ReadEntry(access, ns, shard, name, key, options);
                }
                finally
                {
                    _io.Release();
                }

                if (read.Seen == null) return null;
                var now = _now();
                if (read.Entry == null || Expired(read.Entry.FetchedAt, read.Entry.ExpiresAt, Current(), options, now))
                {
                    RemoveIfSame(access, ns, shard, name, read.Seen.Value.WriteId);
                    return null;
                }

                if (now - read.Seen.Value.Modified >= TouchEvery) Touch(access, ns, shard, name, now);
                return read.Entry;
            }
            catch (Exception)
            {
                return null;
            }
        }

        /// <summary>What a read found: the file (null when there was none) and the entry (null when it didn't read back).</summary>
        private readonly record struct Read(Seen? Seen, ServerCacheEntry? Entry);

        /// <summary>The identity of the file a read or sweep inspected: its write id when its header read, else its size and time.</summary>
        private readonly record struct Seen(long Length, DateTime Modified, ulong? WriteId);

        /// <summary>
        /// Opens an entry once and reads it from that handle: the header (bounded) is checked against the key, the
        /// namespace's largest entry and the file's length before the body is allocated.
        /// </summary>
        private static Read ReadEntry(CacheFolderAccess access, string ns, string shard, string name, string? key, ServerCacheNamespace options)
        {
            using var handle = access.OpenRead(ns, shard, name);
            if (handle == null) return new Read(null, null);
            long length;
            DateTime modified;
            try
            {
                length = RandomAccess.GetLength(handle);
                modified = File.GetLastWriteTimeUtc(handle);
            }
            catch (Exception)
            {
                return new Read(null, null);
            }

            var seen = new Seen(length, modified, null);
            try
            {
                if (length < FixedHeaderBytes || length > MaxHeaderBytes + (long)options.MaxEntryBytes) return new Read(seen, null);
                var head = new byte[(int)Math.Min(length, MaxHeaderBytes)];
                if (ReadFully(handle, head, 0) != head.Length || ReadHeader(head) is not { } header) return new Read(seen, null);
                seen = seen with { WriteId = header.WriteId };
                if ((key != null && !string.Equals(header.Key, key, StringComparison.Ordinal)) || header.Length > options.MaxEntryBytes
                    || length != header.Body + (long)header.Length)
                {
                    return new Read(seen, null);
                }

                var bytes = new byte[header.Length];
                if (ReadFully(handle, bytes, header.Body) != bytes.Length) return new Read(seen, null);
                return new Read(seen, new ServerCacheEntry(bytes, header.Type, header.Fetched, header.Expires) { WriteId = header.WriteId });
            }
            catch (Exception)
            {
                return new Read(seen, null);
            }
        }

        private static int ReadFully(Microsoft.Win32.SafeHandles.SafeFileHandle handle, byte[] buffer, long offset)
        {
            var total = 0;
            while (total < buffer.Length)
            {
                var read = RandomAccess.Read(handle, buffer.AsSpan(total), offset + total);
                if (read <= 0) break;
                total += read;
            }

            return total;
        }

        /// <summary>Stores an entry (replacing one with the same key); nothing happens when off, the folder can't be used or the disk is too busy.</summary>
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
            long started;
            lock (_lock) started = generation ?? _generation;
            if (!settings.Enabled || Options(ns) is not { } options || Access() is not { } access) return false;
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
            var (shard, name) = Names(ns, key);
            var temp = name.Substring(0, 64) + "." + Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(8)) + ".tmp";
            var tempId = ns + "/" + shard + "/" + temp;
            var id = ns + "\n" + key;
            lock (_lock)
            {
                if (_pendingIo >= MaxPendingIo || EndedLocked(id, started)) return false;
                _pendingIo++;
                // The write's space counts from now (a temporary file is disk used too).
                _activeTemps.Add(tempId);
                _reserved += size;
            }

            var committed = false;
            var created = false;
            long total = 0, inNamespace = 0;
            try
            {
                await _io.WaitAsync(ct).ConfigureAwait(false);
                try
                {
                    using (var handle = access.CreateNew(ns, shard, temp))
                    {
                        if (handle == null) return false;
                        created = true;
                        var header = Header(keyBytes, typeBytes, fetched, expires, BitConverter.ToUInt64(RandomNumberGenerator.GetBytes(8)), bytes.Length);
                        await RandomAccess.WriteAsync(handle, header, 0, ct).ConfigureAwait(false);
                        await RandomAccess.WriteAsync(handle, bytes, header.Length, ct).ConfigureAwait(false);
                        File.SetLastWriteTimeUtc(handle, now);
                    }

                    lock (_lock)
                    {
                        // The commit and the generation's end (Clear, Forget, settings) are ordered by this lock: a write
                        // that started before them never lands after them.
                        if (EndedLocked(id, started)) return false;
                        Hook?.Invoke("commit");
                        var previous = access.Stat(ns, shard, name);
                        if (!access.Rename(ns, shard, temp, name)) return false;
                        committed = true;
                        Account(ns + "/" + shard + "/" + name, ns, previous is { } old ? Blocks(old.Length) : 0, size);
                        total = _bytes + _reserved - size;
                        inNamespace = _namespaceBytes.GetValueOrDefault(ns);
                    }
                }
                finally
                {
                    _io.Release();
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                return false;
            }
            finally
            {
                if (created && !committed) access.Delete(ns, shard, temp);
                lock (_lock)
                {
                    _activeTemps.Remove(tempId);
                    _reserved -= size;
                    _pendingIo--;
                }
            }

            if ((settings.MaxBytes > 0 && total > settings.MaxBytes) || (options.MaxBytes > 0 && inNamespace > options.MaxBytes)) ScheduleSweep();
            return true;
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

            // Removed only if it is still that very entry (a replacement written meanwhile stays); no generation ends.
            if (Access() is { } access)
            {
                var (shard, name) = Names(ns, key);
                RemoveIfSame(access, ns, shard, name, entry.WriteId);
            }

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

        /// <summary>Removes one entry (a consumer's invalidation) and ends the current generation, in the same step as a commit could.</summary>
        /// <param name="ns">A registered namespace.</param>
        /// <param name="key">The consumer's canonical key.</param>
        /// <param name="ct">Cancellation.</param>
        /// <returns>True when an entry was removed.</returns>
        public Task<bool> ForgetAsync(string ns, string key, CancellationToken ct)
        {
            Current();
            if (Options(ns) == null || Encoding.UTF8.GetByteCount(key) > MaxKeyBytes) return Task.FromResult(false);
            var access = Access(create: false);
            var (shard, name) = Names(ns, key);
            lock (_lock)
            {
                EndAllLocked();
                if (access == null) return Task.FromResult(false);
                var stat = access.Stat(ns, shard, name);
                if (stat == null || !access.Delete(ns, shard, name)) return Task.FromResult(false);
                Account(ns + "/" + shard + "/" + name, ns, Blocks(stat.Value.Length), 0);
                return Task.FromResult(true);
            }
        }

        /// <summary>
        /// Removes one entry and refuses every write of it that started before (whether or not a file is there yet), in the
        /// same step as a commit could; writes of other entries go on. A read of it under way is no longer joined.
        /// </summary>
        /// <param name="ns">A registered namespace.</param>
        /// <param name="key">The consumer's canonical key.</param>
        /// <param name="ct">Cancellation.</param>
        /// <returns>True when an entry was removed.</returns>
        public Task<bool> ForgetEntryAsync(string ns, string key, CancellationToken ct)
        {
            Current();
            if (Options(ns) == null || Encoding.UTF8.GetByteCount(key) > MaxKeyBytes) return Task.FromResult(false);
            var access = Access(create: false);
            var (shard, name) = Names(ns, key);
            var id = ns + "\n" + key;
            lock (_lock)
            {
                _generation++;
                if (_forgotten.Count >= MaxForgottenEntries) EndAllLocked();
                else _forgotten[id] = _generation;
                _reads.Remove(id);
                if (access == null) return Task.FromResult(false);
                var stat = access.Stat(ns, shard, name);
                if (stat == null || !access.Delete(ns, shard, name)) return Task.FromResult(false);
                Account(ns + "/" + shard + "/" + name, ns, Blocks(stat.Value.Length), 0);
                return Task.FromResult(true);
            }
        }

        // Caller holds _lock. Ends every write under way and every shared read (Clear, ForgetAsync, settings).
        private void EndAllLocked()
        {
            _globalEnd = ++_generation;
            _forgotten.Clear();
            _reads.Clear();
        }

        // Caller holds _lock. A write of entry <paramref name="id"/> that captured <paramref name="started"/> may no longer land.
        private bool EndedLocked(string id, long started)
            => started < _globalEnd || (_forgotten.TryGetValue(id, out var at) && started < at);

        /// <summary>
        /// Removes entries past their validity and, when the folder or a namespace is over its cap, the least
        /// recently used ones (down to 90%), plus temporary files no write of this process is using (left by an
        /// interrupted one). A full sweep also reads each remaining entry's header (startup task, daily task, a
        /// tightened setting); otherwise only last-access times are used.
        /// </summary>
        /// <param name="full">Read every entry's header.</param>
        /// <param name="ct">Cancellation.</param>
        /// <returns>Entries removed.</returns>
        public async Task<int> SweepAsync(bool full, CancellationToken ct)
        {
            var settings = Current();
            // A cache that is off and was never created, or a folder that isn't the cache's, is left alone.
            if (Access(create: false) is not { } access || !access.Intact()) return 0;
            await _sweepLock.WaitAsync(ct).ConfigureAwait(false);
            var snapshot = new Dictionary<string, (string Ns, long Bytes)>(StringComparer.Ordinal);
            var complete = false;
            lock (_lock) _tracker = new Dictionary<string, (string Ns, long Bytes)?>(StringComparer.Ordinal);
            try
            {
                var now = _now();
                var removed = 0;
                var entries = new List<Found>();
                foreach (var found in Enumerate(access))
                {
                    ct.ThrowIfCancellationRequested();
                    if (found.Temp)
                    {
                        // A temporary file that can't be removed is still disk used.
                        if (!RemoveOrphan(access, found)) snapshot[found.Id] = (found.Ns, Blocks(found.Length));
                        continue;
                    }

                    var options = Options(found.Ns) ?? new ServerCacheNamespace(found.Ns);
                    // The last access is never before the fetch, so an entry unused since the cutoff is too old.
                    var stale = settings.MaxAgeDays > 0 && found.Modified < now - TimeSpan.FromDays(settings.MaxAgeDays);
                    ulong? writeId = null;
                    if (stale || full)
                    {
                        var read = ReadHead(access, found, options);
                        if (read.Seen is not { } seen)
                        {
                            // Can't be opened (permissions): it can't be removed either, but it is counted while it is there.
                            if (access.Exists(found.Ns, found.Shard, found.Name)) entries.Add(found);
                            continue;
                        }

                        writeId = seen.WriteId;
                        stale = stale || read.Times is not { } times || Expired(times.Fetched, times.Expires, settings, options, now);
                    }

                    // Removed only if it is still the file looked at; anything else stays, and is counted.
                    if (stale && RemoveIfSame(access, found.Ns, found.Shard, found.Name, writeId))
                    {
                        removed++;
                        continue;
                    }

                    entries.Add(found);
                }

                var kept = new List<Found>();
                foreach (var group in entries.GroupBy(e => e.Ns, StringComparer.Ordinal))
                    removed += Evict(access, group.ToList(), Options(group.Key)?.MaxBytes ?? 0, 0, kept);
                long reserved;
                lock (_lock) reserved = _reserved;
                var survivors = new List<Found>();
                removed += Evict(access, kept, settings.MaxBytes, reserved, survivors);
                foreach (var f in survivors) snapshot[f.Id] = (f.Ns, Blocks(f.Length));
                Hook?.Invoke("counted");
                access.TouchRootFile(ServerCacheLocation.MarkerName, _now());
                lock (_lock) _lastSweep = now;
                if (removed > 0) _logger?.Debug($"[Server cache] Removed {removed} entries.");
                complete = true;
                return removed;
            }
            finally
            {
                // Only a complete count replaces the running totals; an interrupted one leaves them as they were.
                if (complete) Reconcile(snapshot);
                else lock (_lock) _tracker = null;
                _sweepLock.Release();
            }
        }

        /// <summary>Deletes every entry (of one namespace, or all) and the folders the store made for them; ends the generation first.</summary>
        /// <param name="ns">A namespace, or null for all.</param>
        /// <param name="ct">Cancellation.</param>
        /// <returns>Entries removed.</returns>
        public async Task<int> ClearAsync(string? ns, CancellationToken ct)
        {
            if (ns != null && !IsNamespace(ns)) return 0;
            Current();
            // Writes under way from before this point are refused at their commit.
            lock (_lock) EndAllLocked();
            if (Access(create: false) is not { } access || !access.Intact()) return 0;
            await _sweepLock.WaitAsync(ct).ConfigureAwait(false);
            var snapshot = new Dictionary<string, (string Ns, long Bytes)>(StringComparer.Ordinal);
            var complete = false;
            lock (_lock) _tracker = new Dictionary<string, (string Ns, long Bytes)?>(StringComparer.Ordinal);
            try
            {
                var removed = 0;
                var namespaces = new HashSet<(string Ns, string Shard)>();
                foreach (var found in Enumerate(access))
                {
                    if (ns == null || found.Ns == ns)
                    {
                        namespaces.Add((found.Ns, found.Shard));
                        if (found.Temp ? RemoveOrphan(access, found)
                            : ReadHead(access, found, Options(found.Ns) ?? new ServerCacheNamespace(found.Ns)).Seen is { } seen
                              && RemoveIfSame(access, found.Ns, found.Shard, found.Name, seen.WriteId))
                        {
                            if (!found.Temp) removed++;
                            continue;
                        }
                    }

                    // Kept (another namespace, or it couldn't be removed): still counted while it is there.
                    lock (_lock)
                    {
                        if (found.Temp && _activeTemps.Contains(found.Id)) continue;
                    }

                    if (access.Exists(found.Ns, found.Shard, found.Name)) snapshot[found.Id] = (found.Ns, Blocks(found.Length));
                }

                foreach (var (space, shard) in namespaces) access.RemoveEmpty(space, shard);
                foreach (var space in namespaces.Select(n => n.Ns).Distinct(StringComparer.Ordinal)) access.RemoveEmpty(space, null);
                _logger?.Info($"[Server cache] Cleared {removed} entries{(ns == null ? string.Empty : " from " + ns)}.");
                complete = true;
                return removed;
            }
            finally
            {
                if (complete) Reconcile(snapshot);
                else lock (_lock) _tracker = null;
                _sweepLock.Release();
            }
        }

        /// <summary>Counts what the folder holds, temporary files included (it changes no running total).</summary>
        /// <returns>Usage.</returns>
        public ServerCacheUsage Usage()
        {
            var settings = Current();
            var access = settings.Enabled ? Access() : Access(create: false);
            var spaces = new SortedDictionary<string, (long Files, long Bytes)>(StringComparer.Ordinal);
            if (access != null && access.Intact())
            {
                foreach (var found in Enumerate(access))
                {
                    var (files, bytes) = spaces.GetValueOrDefault(found.Ns);
                    spaces[found.Ns] = (files + (found.Temp ? 0 : 1), bytes + Blocks(found.Length));
                }
            }

            string? error;
            Dictionary<string, long> caps;
            lock (_lock)
            {
                error = access == null ? _folderError : null;
                caps = _namespaces.ToDictionary(n => n.Key, n => n.Value.MaxBytes, StringComparer.Ordinal);
            }

            return new ServerCacheUsage(settings.Enabled, access?.Root ?? string.Empty, error, spaces.Values.Sum(s => s.Files), spaces.Values.Sum(s => s.Bytes),
                settings.MaxBytes, settings.MaxAgeDays,
                spaces.Select(s => new ServerCacheNamespaceUsage(s.Key, s.Value.Files, s.Value.Bytes, caps.GetValueOrDefault(s.Key))).ToList());
        }

        /// <summary>
        /// The current settings. A change of folder or switching the cache off ends the generation (and a folder change resets the
        /// running totals); a change sweeps at once, reading headers when it isn't the first look (a lower age limit
        /// applies to entries read recently too).
        /// </summary>
        private ServerCacheSettings Current()
        {
            var settings = _settings();
            bool first;
            lock (_lock)
            {
                if (_seen == settings) return settings;
                first = _seen == null;
                if (_seen == null || _seen.Folder != settings.Folder)
                {
                    _access = null;
                    _folderError = null;
                    _bytes = 0;
                    foreach (var name in _namespaceBytes.Keys.ToList()) _namespaceBytes[name] = 0;
                }

                // Moving the folder or switching the cache off ends the generation. Switching it on doesn't: no write can be
                // under way while it is off, and images fetched meanwhile may still be saved (their generation holds).
                if (_seen != null && (_seen.Folder != settings.Folder || (_seen.Enabled && !settings.Enabled))) EndAllLocked();
                _seen = settings;
            }

            ScheduleSweep(force: true, full: !first);
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

        /// <summary>Applies a committed change to the running totals (under the lock), and to a sweep's count under way.</summary>
        private void Account(string id, string ns, long before, long after)
        {
            _bytes += after - before;
            if (_namespaceBytes.TryGetValue(ns, out var bytes)) _namespaceBytes[ns] = Math.Max(0, bytes + after - before);
            if (_tracker != null) _tracker[id] = after > 0 ? (ns, after) : null;
        }

        /// <summary>Sets the running totals from a sweep's count, with every change committed while it counted applied on top.</summary>
        private void Reconcile(Dictionary<string, (string Ns, long Bytes)> snapshot)
        {
            lock (_lock)
            {
                if (_tracker != null)
                {
                    foreach (var (id, state) in _tracker)
                    {
                        if (state is { } now) snapshot[id] = now;
                        else snapshot.Remove(id);
                    }
                }

                _tracker = null;
                _bytes = snapshot.Values.Sum(v => v.Bytes);
                foreach (var name in _namespaceBytes.Keys.ToList()) _namespaceBytes[name] = 0;
                foreach (var group in snapshot.Values.GroupBy(v => v.Ns, StringComparer.Ordinal))
                {
                    if (_namespaceBytes.ContainsKey(group.Key)) _namespaceBytes[group.Key] = group.Sum(v => v.Bytes);
                }
            }
        }

        /// <summary>
        /// Removes a file only if it is still the one inspected, decided in the same step as a commit could replace it:
        /// one with <paramref name="writeId"/> when its header read, else one whose header still doesn't read (a valid
        /// replacement always has a readable header, so it is never taken for the broken file).
        /// </summary>
        private bool RemoveIfSame(CacheFolderAccess access, string ns, string shard, string name, ulong? writeId)
        {
            lock (_lock)
            {
                var options = Options(ns) ?? new ServerCacheNamespace(ns);
                if (ReadHead(access, new Found(ns, shard, name, 0, default, false), options).Seen is not { } current) return false;
                if (writeId != null ? current.WriteId != writeId : current.WriteId != null) return false;
                if (!access.Delete(ns, shard, name)) return false;
                Account(ns + "/" + shard + "/" + name, ns, Blocks(current.Length), 0);
                return true;
            }
        }

        /// <summary>
        /// Removes a temporary file no write of this process is using; true when it is gone (removed, or renamed into
        /// place by a write that finished since it was listed) or a write still uses it, false when it is still there.
        /// </summary>
        private bool RemoveOrphan(CacheFolderAccess access, Found found)
        {
            lock (_lock)
            {
                return _activeTemps.Contains(found.Id) || access.Delete(found.Ns, found.Shard, found.Name) || !access.Exists(found.Ns, found.Shard, found.Name);
            }
        }

        private static void Touch(CacheFolderAccess access, string ns, string shard, string name, DateTime now)
        {
            try
            {
                using var handle = access.OpenRead(ns, shard, name);
                if (handle != null) File.SetLastWriteTimeUtc(handle, now);
            }
            catch (Exception)
            {
                // A read-only folder still serves what it holds.
            }
        }

        /// <summary>Keeps <paramref name="entries"/> (plus <paramref name="extra"/> bytes) under <paramref name="cap"/>, least recently used first.</summary>
        private int Evict(CacheFolderAccess access, List<Found> entries, long cap, long extra, List<Found> kept)
        {
            var total = entries.Sum(e => Blocks(e.Length)) + extra;
            if (cap <= 0 || total <= cap)
            {
                kept.AddRange(entries);
                return 0;
            }

            var removed = 0;
            var target = (long)(cap * LowWatermark);
            foreach (var entry in entries.OrderBy(e => e.Modified).ThenBy(e => e.Name, StringComparer.Ordinal))
            {
                if (total > target && ReadHead(access, entry, Options(entry.Ns) ?? new ServerCacheNamespace(entry.Ns)).Seen is { } seen
                    && RemoveIfSame(access, entry.Ns, entry.Shard, entry.Name, seen.WriteId))
                {
                    total -= Blocks(entry.Length);
                    removed++;
                }
                else
                {
                    kept.Add(entry);
                }
            }

            return removed;
        }

        /// <summary>
        /// The usable folder's access; null when the setting can't be used. With <paramref name="create"/> (reads and
        /// writes of a cache that is on) the folder is prepared (created, checked writable, marked) once per setting (a
        /// failed check is retried after a few minutes); without it (sweeps, Clear, usage of a cache that is off) it is
        /// used only when it already is the cache's (its verified marker), so maintenance never runs in a foreign folder.
        /// </summary>
        private CacheFolderAccess? Access(bool create = true)
        {
            lock (_lock)
            {
                if (_access != null) return _access;
            }

            // One preparation at a time: the first requests after the cache is switched on don't race to create its folder and marker.
            lock (_prepareLock) return PrepareAccess(create);
        }

        private CacheFolderAccess? PrepareAccess(bool create)
        {
            string configured;
            lock (_lock)
            {
                if (_access != null) return _access;
                if (_folderError != null && _now() - _folderErrorAt < FolderRetry) return null;
                configured = _seen?.Folder ?? string.Empty;
            }

            var error = _location.Resolve(configured, out var full);
            var found = error == null ? CacheFolderAccess.For(full, _anchored) : null;
            if (error == null && found == null) error = ServerCacheLocation.Unsupported;
            else if (error == null && create) error = _location.Prepare(full, _anchored);
            else if (error == null && !(found!.Intact() && found.HasMarker())) return null;
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
                if (create) _access = found;
                return found;
            }
        }

        /// <summary>Starts a sweep (after the debounce unless forced); one asked for while one runs runs after it.</summary>
        private void ScheduleSweep(bool force = false, bool full = false)
        {
            lock (_lock)
            {
                if (!_pendingSweep.IsCompleted)
                {
                    _sweepAgain = true;
                    _sweepAgainFull |= full;
                    return;
                }

                var wait = force ? TimeSpan.Zero : _lastSweep + SweepDebounce - _now();
                _pendingSweep = Task.Run(async () =>
                {
                    try
                    {
                        if (wait > TimeSpan.Zero) await Task.Delay(wait).ConfigureAwait(false);
                        var thisFull = full;
                        while (true)
                        {
                            await SweepAsync(thisFull, CancellationToken.None).ConfigureAwait(false);
                            lock (_lock)
                            {
                                if (!_sweepAgain) break;
                                thisFull = _sweepAgainFull;
                                _sweepAgain = false;
                                _sweepAgainFull = false;
                            }
                        }
                    }
                    catch (Exception ex)
                    {
                        _logger?.Warning($"[Server cache] Sweep failed: {ex.GetType().Name}");
                    }
                });
            }
        }

        /// <summary>A file of the store's own shape: namespace, shard, name, size, last write, and whether it is a temporary file.</summary>
        private readonly record struct Found(string Ns, string Shard, string Name, long Length, DateTime Modified, bool Temp)
        {
            internal string Id => Ns + "/" + Shard + "/" + Name;
        }

        /// <summary>Every entry and temporary file of the store's own shape, listed through the folder's open handle.</summary>
        private static List<Found> Enumerate(CacheFolderAccess access)
            => access.WithRootPath(path => path == null ? new List<Found>() : Enumerate(path).ToList());

        /// <summary>Every entry and temporary file of the store's own shape under <paramref name="folder"/> (links skipped).</summary>
        private static IEnumerable<Found> Enumerate(string folder)
        {
            foreach (var nsDir in SafeDirectories(new DirectoryInfo(folder), NamespacePattern))
            {
                foreach (var shard in SafeDirectories(nsDir, ShardPattern))
                {
                    List<FileInfo> files;
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
                        var temp = TempPattern.IsMatch(file.Name);
                        if (!temp && !BlobPattern.IsMatch(file.Name)) continue;
                        long length;
                        DateTime modified;
                        try
                        {
                            length = file.Length;
                            modified = file.LastWriteTimeUtc;
                        }
                        catch (Exception)
                        {
                            continue;
                        }

                        yield return new Found(nsDir.Name, shard.Name, file.Name, length, modified, temp);
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

        /// <summary>An entry's header times and identity, read through the confined access.</summary>
        private static (Seen? Seen, (DateTime Fetched, DateTime? Expires)? Times) ReadHead(CacheFolderAccess access, Found found, ServerCacheNamespace options)
        {
            using var handle = access.OpenRead(found.Ns, found.Shard, found.Name);
            if (handle == null) return (null, null);
            try
            {
                var length = RandomAccess.GetLength(handle);
                var seen = new Seen(length, File.GetLastWriteTimeUtc(handle), null);
                if (length < FixedHeaderBytes || length > MaxHeaderBytes + (long)options.MaxEntryBytes) return (seen, null);
                var head = new byte[(int)Math.Min(length, MaxHeaderBytes)];
                if (ReadFully(handle, head, 0) != head.Length || ReadHeader(head) is not { } header) return (seen, null);
                seen = seen with { WriteId = header.WriteId };
                if (header.Length > options.MaxEntryBytes || length != header.Body + (long)header.Length) return (seen, null);
                return (seen, (header.Fetched, header.Expires));
            }
            catch (Exception)
            {
                return (null, null);
            }
        }

        private static long Blocks(long length) => Math.Max(1, (length + BlockBytes - 1) / BlockBytes) * BlockBytes;

        private static string Hash(string ns, string key)
            => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(ns + "\n" + key)));

        /// <summary>An entry's shard folder and file name.</summary>
        private static (string Shard, string Name) Names(string ns, string key)
        {
            var hash = Hash(ns, key);
            return (hash.Substring(0, 2), hash + ".blob");
        }

        private static byte[] Header(byte[] key, byte[] type, DateTime fetched, DateTime? expires, ulong writeId, int length)
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
            BinaryPrimitives.WriteUInt64LittleEndian(header.AsSpan(at), writeId);
            at += 8;
            BinaryPrimitives.WriteInt32LittleEndian(header.AsSpan(at), length);
            return header;
        }

        /// <summary>Reads a header: the key, type, times, write id and body offset and length; null when it isn't one.</summary>
        private static (string Key, string Type, DateTime Fetched, DateTime? Expires, ulong WriteId, int Body, int Length)? ReadHeader(ReadOnlySpan<byte> span)
        {
            if (span.Length < FixedHeaderBytes || !span.Slice(0, Magic.Length).SequenceEqual(Magic)) return null;
            var at = Magic.Length;
            int keyLength = BinaryPrimitives.ReadUInt16LittleEndian(span.Slice(at));
            at += 2;
            if (keyLength > MaxKeyBytes || span.Length < at + keyLength + 1) return null;
            var key = Encoding.UTF8.GetString(span.Slice(at, keyLength));
            at += keyLength;
            int typeLength = span[at++];
            if (typeLength > MaxContentTypeBytes || span.Length < at + typeLength + 28) return null;
            var type = Encoding.UTF8.GetString(span.Slice(at, typeLength));
            at += typeLength;
            var fetched = BinaryPrimitives.ReadInt64LittleEndian(span.Slice(at));
            var expires = BinaryPrimitives.ReadInt64LittleEndian(span.Slice(at + 8));
            var writeId = BinaryPrimitives.ReadUInt64LittleEndian(span.Slice(at + 16));
            var length = BinaryPrimitives.ReadInt32LittleEndian(span.Slice(at + 24));
            at += 28;
            if (fetched <= 0 || fetched > DateTime.MaxValue.Ticks || expires < 0 || expires > DateTime.MaxValue.Ticks || length < 0) return null;
            return (key, type, new DateTime(fetched, DateTimeKind.Utc), expires == 0 ? null : new DateTime(expires, DateTimeKind.Utc), writeId, at, length);
        }
    }
}
