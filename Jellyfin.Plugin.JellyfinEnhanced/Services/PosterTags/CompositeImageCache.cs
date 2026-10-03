using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Common.Configuration;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags
{
    // Rendered posters, content-addressed: the key is a hash of every input that
    // can change the pixels (base image identity, settings digest, renderer
    // version, flags, tag data, encode quality), so entries never need
    // invalidating — any change produces a new key. A zero-length value means
    // "nothing to draw, serve the original"; it is cached in memory only (a
    // decision, cheap to redo, that must not be able to fill the disk with
    // files).
    //
    //   memory  LRU bounded by bytes, each entry charged its length plus a
    //           fixed overhead so empty values are bounded too (hits cost one
    //           dictionary lookup);
    //   disk    {CachePath}/jellyfin-enhanced/poster-tags/{k[0..2]}/{k}{ext}:
    //           regenerable data outside the config volume and backups,
    //           bounded by a size cap (oldest written first out) on top of
    //           Jellyfin's own 30-day cache-folder cleanup task; every file
    //           is charged at least one filesystem block, so the cap bounds
    //           the file count as well as the bytes;
    //   render  identical concurrent misses share one render (coalescing), and
    //           renders run at most max(1, cores/2) at a time. Renders run
    //           detached from the request that started them, so a client
    //           leaving can't fail the requests waiting on the same key.
    public sealed class CompositeImageCache
    {
        /// <summary>The cached value meaning "serve the original image".</summary>
        public static readonly byte[] Passthrough = Array.Empty<byte>();

        private const long DefaultMemoryBudget = 128L * 1024 * 1024;
        private const long DefaultDiskBudget = 1024L * 1024 * 1024;
        // Key string + list node + dictionary entry.
        private const int EntryOverhead = 256;
        // What a file costs the disk tier at least (one block), whatever its length.
        private const long DiskFileCharge = 4096;
        private static readonly TimeSpan DefaultRenderWait = TimeSpan.FromSeconds(20);

        private readonly string? _diskDirectory;
        private readonly long _memoryBudget;
        private readonly long _diskBudget;
        private readonly TimeSpan _renderWait;
        private readonly Action<string> _warn;
        private readonly SemaphoreSlim _renderSlots;

        private readonly object _lruLock = new();
        private readonly LinkedList<(string Key, byte[] Value)> _lruOrder = new();
        private readonly Dictionary<string, LinkedListNode<(string Key, byte[] Value)>> _lruEntries = new(StringComparer.Ordinal);
        private long _memoryBytes;

        private readonly ConcurrentDictionary<string, Lazy<Task<byte[]>>> _inFlight = new(StringComparer.Ordinal);

        private long _diskBytes = -1; // -1 until the first scan
        private int _diskMaintenanceRunning;

        public CompositeImageCache(IApplicationPaths applicationPaths, Logger logger)
            : this(
                Path.Combine(applicationPaths.CachePath, "jellyfin-enhanced", "poster-tags"),
                DefaultMemoryBudget,
                DefaultDiskBudget,
                Math.Max(1, Environment.ProcessorCount / 2),
                DefaultRenderWait,
                logger.Warning)
        {
        }

        private CompositeImageCache(string? diskDirectory, long memoryBudget, long diskBudget, int maxConcurrentRenders, TimeSpan renderWait, Action<string> warn)
        {
            _diskDirectory = diskDirectory;
            _memoryBudget = Math.Max(0, memoryBudget);
            _diskBudget = Math.Max(0, diskBudget);
            _renderWait = renderWait;
            _warn = warn;
            _renderSlots = new SemaphoreSlim(Math.Max(1, maxConcurrentRenders));
        }

        /// <summary>An instance with explicit limits (test harness). A null directory disables the disk tier.</summary>
        public static CompositeImageCache Create(string? diskDirectory, long memoryBudget, long diskBudget, int maxConcurrentRenders, TimeSpan renderWait, Action<string> warn)
            => new(diskDirectory, memoryBudget, diskBudget, maxConcurrentRenders, renderWait, warn);

        /// <summary>Bytes held in memory (test harness and diagnostics).</summary>
        public long MemoryBytes
        {
            get
            {
                lock (_lruLock) return _memoryBytes;
            }
        }

        /// <summary>Entries held in memory (test harness and diagnostics).</summary>
        public int MemoryCount
        {
            get
            {
                lock (_lruLock) return _lruEntries.Count;
            }
        }

        /// <summary>Memory-tier lookup only (no I/O).</summary>
        public bool TryGetMemory(string key, out byte[] value)
        {
            lock (_lruLock)
            {
                if (_lruEntries.TryGetValue(key, out var node))
                {
                    _lruOrder.Remove(node);
                    _lruOrder.AddFirst(node);
                    value = node.Value.Value;
                    return true;
                }
            }

            value = Passthrough;
            return false;
        }

        /// <summary>
        /// The cached value for <paramref name="key"/>, else the disk copy, else the result of
        /// <paramref name="factory"/> (run once for all concurrent callers of the same key, under the render
        /// concurrency limit). <paramref name="waitToken"/> only stops THIS caller waiting. Exceptions from
        /// the factory (and a render-slot timeout) propagate to every waiter and are not cached.
        /// </summary>
        public async Task<byte[]> GetOrCreateAsync(string key, string extension, Func<Task<byte[]>> factory, CancellationToken waitToken)
        {
            if (TryGetMemory(key, out var hit)) return hit;

            var mine = new Lazy<Task<byte[]>>(() => LoadOrRenderAsync(key, extension, factory), LazyThreadSafetyMode.ExecutionAndPublication);
            var leader = _inFlight.GetOrAdd(key, mine);
            var task = leader.Value;
            if (ReferenceEquals(leader, mine))
            {
                _ = task.ContinueWith(
                    _ => _inFlight.TryRemove(new KeyValuePair<string, Lazy<Task<byte[]>>>(key, mine)),
                    CancellationToken.None,
                    TaskContinuationOptions.ExecuteSynchronously,
                    TaskScheduler.Default);
            }

            return await task.WaitAsync(waitToken).ConfigureAwait(false);
        }

        private async Task<byte[]> LoadOrRenderAsync(string key, string extension, Func<Task<byte[]>> factory)
        {
            var fromDisk = await TryReadDiskAsync(key, extension).ConfigureAwait(false);
            if (fromDisk != null)
            {
                AddToMemory(key, fromDisk);
                return fromDisk;
            }

            if (!await _renderSlots.WaitAsync(_renderWait).ConfigureAwait(false))
            {
                throw new TimeoutException("Timed out waiting for a poster render slot.");
            }

            byte[] value;
            try
            {
                value = await Task.Run(factory).ConfigureAwait(false) ?? Passthrough;
            }
            finally
            {
                _renderSlots.Release();
            }

            AddToMemory(key, value);
            _ = WriteDiskAsync(key, extension, value);
            return value;
        }

        private void AddToMemory(string key, byte[] value)
        {
            var cost = value.LongLength + EntryOverhead;
            if (cost > _memoryBudget) return;
            lock (_lruLock)
            {
                if (_lruEntries.Remove(key, out var existing))
                {
                    _lruOrder.Remove(existing);
                    _memoryBytes -= existing.Value.Value.LongLength + EntryOverhead;
                }

                _lruEntries[key] = _lruOrder.AddFirst((key, value));
                _memoryBytes += cost;
                while (_memoryBytes > _memoryBudget && _lruOrder.Last is { } oldest)
                {
                    _lruOrder.RemoveLast();
                    _lruEntries.Remove(oldest.Value.Key);
                    _memoryBytes -= oldest.Value.Value.LongLength + EntryOverhead;
                }
            }
        }

        private string? DiskPath(string key, string extension)
        {
            if (_diskDirectory == null || _diskBudget == 0 || key.Length < 3) return null;
            return Path.Combine(_diskDirectory, key.Substring(0, 2), key + extension);
        }

        private async Task<byte[]?> TryReadDiskAsync(string key, string extension)
        {
            var path = DiskPath(key, extension);
            if (path == null) return null;
            try
            {
                if (!File.Exists(path)) return null;
                return await File.ReadAllBytesAsync(path).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // A file pruned or replaced under us is just a miss.
                return null;
            }
        }

        // Atomic (temp file + move), so a reader never sees a partial file.
        // Passthrough is never written (TryReadDiskAsync still accepts an
        // existing zero-length file as passthrough).
        private async Task WriteDiskAsync(string key, string extension, byte[] value)
        {
            if (value.Length == 0) return;
            var path = DiskPath(key, extension);
            if (path == null) return;
            var temp = path + ".tmp." + Guid.NewGuid().ToString("N");
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                await File.WriteAllBytesAsync(temp, value).ConfigureAwait(false);
                File.Move(temp, path, overwrite: true);
                if (Interlocked.Read(ref _diskBytes) >= 0) Interlocked.Add(ref _diskBytes, DiskCost(value.LongLength));
                MaybeRunDiskMaintenance();
            }
            catch (Exception ex)
            {
                _warn($"Native poster tags: could not write the poster cache file: {ex.Message}");
                try { if (File.Exists(temp)) File.Delete(temp); }
                catch (Exception) { /* best effort */ }
            }
        }

        // First call measures the folder; afterwards it only runs when the
        // running total crosses the cap. One run at a time, off the request path.
        private void MaybeRunDiskMaintenance()
        {
            var known = Interlocked.Read(ref _diskBytes);
            if (known >= 0 && known <= _diskBudget) return;
            if (Interlocked.CompareExchange(ref _diskMaintenanceRunning, 1, 0) != 0) return;
            _ = Task.Run(() =>
            {
                try
                {
                    TrimDisk();
                }
                catch (Exception ex)
                {
                    _warn($"Native poster tags: poster cache cleanup failed: {ex.Message}");
                }
                finally
                {
                    Interlocked.Exchange(ref _diskMaintenanceRunning, 0);
                }
            });
        }

        private void TrimDisk()
        {
            if (_diskDirectory == null || !Directory.Exists(_diskDirectory)) return;
            var files = new List<FileInfo>();
            long total = 0;
            var staleTemp = DateTime.UtcNow - TimeSpan.FromHours(1);
            foreach (var file in new DirectoryInfo(_diskDirectory).EnumerateFiles("*", SearchOption.AllDirectories))
            {
                if (file.Name.Contains(".tmp.", StringComparison.Ordinal))
                {
                    // Leftover from a crash mid-write.
                    if (file.LastWriteTimeUtc < staleTemp) TryDelete(file);
                    continue;
                }

                files.Add(file);
                total += DiskCost(file.Length);
            }

            if (total > _diskBudget)
            {
                var target = _diskBudget * 8 / 10;
                foreach (var file in files.OrderBy(f => f.LastWriteTimeUtc))
                {
                    if (total <= target) break;
                    var cost = DiskCost(file.Length);
                    if (TryDelete(file)) total -= cost;
                }
            }

            Interlocked.Exchange(ref _diskBytes, total);
        }

        private static long DiskCost(long length) => Math.Max(length, DiskFileCharge);

        private static bool TryDelete(FileInfo file)
        {
            try
            {
                file.Delete();
                return true;
            }
            catch (Exception)
            {
                return false;
            }
        }
    }
}
