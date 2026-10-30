using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Common.Configuration;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// TMDB data behind the Logos tag group, fetched by the server only.
    /// <para>
    /// Lookups: a title's flat-rate watch providers for one region
    /// (<c>{type}/{id}/watch/providers</c>, parsed by
    /// <see cref="WatchProvidersBatch"/>) or its production companies / networks
    /// (<c>{type}/{id}</c>), read through <see cref="TmdbResponseCache"/> and
    /// kept here as names and logo paths only, for a day (<see cref="LookupTtl"/>;
    /// a failure is retried after <see cref="RetryAfter"/>). The tag cache reads
    /// them without network I/O (<see cref="TryGet"/>) and warms them in
    /// bounded, rate-limited batches (<see cref="WarmAsync"/>). They persist to
    /// <c>tag-logos.json</c> beside the tag cache.
    /// </para>
    /// <para>
    /// Images: the <c>/JellyfinEnhanced/logo/{size}/{file}</c> proxy serves
    /// TMDB logo images from a disk cache under Jellyfin's cache directory
    /// (<c>jellyfin-enhanced/logos</c>), fetching a missing one once. Only the
    /// sizes in <see cref="Sizes"/> and file names this service has seen in a
    /// lookup are served, so the route is not an open TMDB image proxy.
    /// Native Poster Tags read the same files (<see cref="TryReadCached"/>).
    /// </para>
    /// </summary>
    public sealed class TagLogoService : IDisposable
    {
        /// <summary>How long a successful lookup (including "no providers") is kept.</summary>
        public static readonly TimeSpan LookupTtl = TimeSpan.FromDays(1);

        /// <summary>How long a failed lookup waits before it is tried again.</summary>
        public static readonly TimeSpan RetryAfter = TimeSpan.FromHours(1);

        /// <summary>Image sizes the proxy serves (TMDB logo widths).</summary>
        public static readonly IReadOnlyList<string> Sizes = new[] { "w45", "w92" };

        /// <summary>The size web chips and native posters use.</summary>
        public const string DefaultSize = "w92";

        /// <summary>Lookups running at once.</summary>
        public const int MaxInFlight = 4;

        /// <summary>Upstream lookups per <see cref="RateWindow"/> (TMDB allows about 40).</summary>
        public const int UpstreamPerWindow = 35;

        /// <summary>The rate limit's sliding window.</summary>
        public static readonly TimeSpan RateWindow = TimeSpan.FromSeconds(10);

        /// <summary>A warm stops starting lookups after this many failures without a success.</summary>
        internal const int FailFastAfter = 8;

        private const int MaxImageBytes = 256 * 1024;
        private const int MaxNameLength = 120;
        private const int DiskSchemaVersion = 1;
        private static readonly TimeSpan ImageRetryAfter = TimeSpan.FromMinutes(10);
        private static readonly TimeSpan ImageTimeout = TimeSpan.FromSeconds(15);
        private static readonly TimeSpan SaveDebounce = TimeSpan.FromSeconds(30);

        /// <summary>
        /// A TMDB logo file name ("pbpMk2JmcoNnQwx5JGpXngfoWtp.jpg"): no directories, a raster
        /// extension. TMDB's paths are case-sensitive, so the name is matched, allowed, fetched,
        /// stored and keyed exactly as TMDB spelled it; another casing is a different (unknown) file.
        /// </summary>
        private static readonly Regex FilePattern = new(@"^[A-Za-z0-9_\-]{1,80}\.(png|jpg|jpeg|webp)\z", RegexOptions.CultureInvariant);

        /// <summary>What a lookup asks TMDB for.</summary>
        public enum LookupKind
        {
            /// <summary>Flat-rate watch providers in one region.</summary>
            Providers,

            /// <summary>Production companies (movies) or networks (series).</summary>
            Details,
        }

        /// <summary>One provider, company or network: its name and TMDB logo path (null when TMDB has none).</summary>
        public sealed record LogoRef(string Name, string? Logo);

        /// <summary>A stored lookup: when it ran (Unix ms), what it found, and whether it failed.</summary>
        public sealed record Lookup(long Fetched, LogoRef[] Items, bool Failed);

        /// <summary>A cached logo image and its strong validator.</summary>
        public sealed record LogoImage(byte[] Bytes, string ContentType, string ETag);

        private sealed class DiskFormat
        {
            public int V { get; set; }
            public Dictionary<string, Lookup> Lookups { get; set; } = new();
        }

        private readonly IHttpClientFactory _httpClientFactory;
        private readonly TmdbResponseCache _tmdb;
        private readonly Logger? _logger;
        private readonly TimeProvider _time;
        private readonly string? _storePath;
        private readonly string _imageDir;
        private readonly ConcurrentDictionary<string, Lookup> _lookups = new(StringComparer.Ordinal);
        private readonly ConcurrentDictionary<string, byte> _knownFiles = new(StringComparer.Ordinal);
        private readonly ConcurrentDictionary<string, long> _imageFailures = new(StringComparer.Ordinal);
        private readonly ConcurrentDictionary<string, Task<LogoImage?>> _imageFetches = new(StringComparer.Ordinal);
        private readonly SemaphoreSlim _slots;
        private readonly int _perWindow;
        private readonly TimeSpan _window;
        private readonly object _windowLock = new();
        private readonly Queue<DateTimeOffset> _upstreamStarts = new();
        private readonly object _saveLock = new();
        private Timer? _saveTimer;
        private volatile bool _disposed;

        /// <summary>The running instance (DI singleton), for the tag cache and native posters.</summary>
        public static TagLogoService? Instance { get; private set; }

        public TagLogoService(IHttpClientFactory httpClientFactory, TmdbResponseCache tmdb, IApplicationPaths applicationPaths, Logger logger)
            : this(httpClientFactory, tmdb, TimeProvider.System,
                Path.Combine(applicationPaths.PluginsPath, "configurations", "Jellyfin.Plugin.JellyfinEnhanced", "tag-logos.json"),
                Path.Combine(applicationPaths.CachePath, "jellyfin-enhanced", "logos"), logger, MaxInFlight, UpstreamPerWindow, RateWindow)
        {
            Instance = this;
        }

        internal TagLogoService(IHttpClientFactory httpClientFactory, TmdbResponseCache tmdb, TimeProvider time, string? storePath, string imageDir, Logger? logger,
            int maxInFlight = MaxInFlight, int perWindow = UpstreamPerWindow, TimeSpan? window = null)
        {
            _httpClientFactory = httpClientFactory;
            _tmdb = tmdb;
            _time = time;
            _storePath = storePath;
            _imageDir = imageDir;
            _logger = logger;
            _slots = new SemaphoreSlim(maxInFlight, maxInFlight);
            _perWindow = perWindow;
            _window = window ?? RateWindow;
            LoadFromDisk();
        }

        /// <summary>Store key of a lookup: "movie:603|providers|US" or "tv:1399|details".</summary>
        public static string KeyOf(string mediaType, string tmdbId, LookupKind kind, string region) =>
            kind == LookupKind.Providers ? $"{mediaType}:{tmdbId}|providers|{region}" : $"{mediaType}:{tmdbId}|details";

        /// <summary>True for a TMDB id the lookups accept (digits only).</summary>
        public static bool IsValidId(string? tmdbId) => !string.IsNullOrEmpty(tmdbId) && tmdbId.Length <= 9 && tmdbId.All(char.IsAsciiDigit);

        /// <summary>A stored lookup, fresh or not (the tag cache prefers stale data to none). No network I/O.</summary>
        public bool TryGet(string mediaType, string tmdbId, LookupKind kind, string region, out Lookup lookup) =>
            _lookups.TryGetValue(KeyOf(mediaType, tmdbId, kind, region), out lookup!);

        /// <summary>True when the lookup is missing, expired, or failed long enough ago to retry.</summary>
        public bool IsDue(string mediaType, string tmdbId, LookupKind kind, string region)
        {
            if (!_lookups.TryGetValue(KeyOf(mediaType, tmdbId, kind, region), out var lookup)) return true;
            var age = _time.GetUtcNow().ToUnixTimeMilliseconds() - lookup.Fetched;
            return age < 0 || age >= (lookup.Failed ? RetryAfter : LookupTtl).TotalMilliseconds;
        }

        /// <summary>
        /// Fetch every due lookup of the given titles with the TMDB key, within
        /// the concurrency and rate limits. Failures are stored (keeping any
        /// earlier result) and retried after <see cref="RetryAfter"/>; a 404 is an
        /// authoritative empty answer. Returns how many lookups changed.
        /// </summary>
        public async Task<int> WarmAsync(string? apiKey, IEnumerable<(string MediaType, string TmdbId, LookupKind Kind)> titles, string region, CancellationToken cancellationToken)
        {
            if (string.IsNullOrWhiteSpace(apiKey)) return 0;
            var due = titles.Where(t => (t.MediaType is "movie" or "tv") && IsValidId(t.TmdbId))
                .Distinct().Where(t => IsDue(t.MediaType, t.TmdbId, t.Kind, region)).ToArray();
            if (due.Length == 0) return 0;
            var changed = 0;
            var failures = 0;
            var successes = 0;
            // Offline or a bad key: once the first lookups all fail, leave the rest
            // for the next run instead of failing them one by one. Checked once a
            // lookup holds an upstream slot, so queued lookups see earlier failures.
            bool GiveUp() => Volatile.Read(ref successes) == 0 && Volatile.Read(ref failures) >= FailFastAfter;
            var tasks = due.Select(async t =>
            {
                var result = await FetchLookupAsync(apiKey, t.MediaType, t.TmdbId, t.Kind, region, GiveUp, cancellationToken).ConfigureAwait(false);
                if (result == null) return;
                if (result.Failed) Interlocked.Increment(ref failures);
                else Interlocked.Increment(ref successes);
                var key = KeyOf(t.MediaType, t.TmdbId, t.Kind, region);
                var previous = _lookups.TryGetValue(key, out var old) ? old : null;
                var stored = result.Failed && previous != null ? previous with { Fetched = result.Fetched, Failed = true } : result;
                _lookups[key] = stored;
                foreach (var item in stored.Items) Remember(item.Logo);
                if (previous == null || !previous.Items.SequenceEqual(stored.Items)) Interlocked.Increment(ref changed);
            }).ToArray();
            await Task.WhenAll(tasks).ConfigureAwait(false);
            ScheduleSave();
            return changed;
        }

        /// <summary>One lookup; null when it was skipped because <paramref name="giveUp"/> said so.</summary>
        private async Task<Lookup?> FetchLookupAsync(string apiKey, string mediaType, string tmdbId, LookupKind kind, string region, Func<bool> giveUp, CancellationToken cancellationToken)
        {
            var path = kind == LookupKind.Providers ? $"{mediaType}/{tmdbId}/watch/providers" : $"{mediaType}/{tmdbId}";
            var now = _time.GetUtcNow().ToUnixTimeMilliseconds();
            try
            {
                var body = await FetchBodyAsync(apiKey, path, giveUp, cancellationToken).ConfigureAwait(false);
                if (body == null) return new Lookup(now, Array.Empty<LogoRef>(), false);
                var items = kind == LookupKind.Providers ? ParseProviders(body, region) : ParseDetails(body, mediaType);
                return items == null ? new Lookup(now, Array.Empty<LogoRef>(), true) : new Lookup(now, items, false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (WarmSkippedException)
            {
                return null;
            }
            catch (Exception ex)
            {
                _logger?.Debug($"[LogoTags] TMDB lookup {path} failed: {ex.Message}");
                return new Lookup(now, Array.Empty<LogoRef>(), true);
            }
        }

        private sealed class WarmSkippedException : Exception
        {
        }

        /// <summary>Read through the shared response cache with bounded upstream work; null on 404.</summary>
        private async Task<string?> FetchBodyAsync(string apiKey, string apiPath, Func<bool> giveUp, CancellationToken cancellationToken)
        {
            if (_tmdb.TryGetFresh(apiPath, string.Empty, apiKey, out var cached)) return Read(cached);
            await _slots.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                if (_tmdb.TryGetFresh(apiPath, string.Empty, apiKey, out cached)) return Read(cached);
                if (giveUp()) throw new WarmSkippedException();
                await WaitForRateWindowAsync(cancellationToken).ConfigureAwait(false);
                // The response cache owns the upstream timeout; keep the slot until it ends.
                return Read(await _tmdb.GetAsync(apiPath, string.Empty, apiKey, CancellationToken.None).ConfigureAwait(false));
            }
            finally
            {
                _slots.Release();
            }

            static string? Read(TmdbResponseCache.TmdbResponse response)
            {
                if (response.IsSuccess) return response.Content;
                if (response.StatusCode == 404) return null;
                throw new HttpRequestException("TMDB status " + response.StatusCode);
            }
        }

        private async Task WaitForRateWindowAsync(CancellationToken cancellationToken)
        {
            while (true)
            {
                TimeSpan wait;
                lock (_windowLock)
                {
                    var now = _time.GetUtcNow();
                    while (_upstreamStarts.Count > 0 && now - _upstreamStarts.Peek() >= _window) _upstreamStarts.Dequeue();
                    if (_upstreamStarts.Count < _perWindow)
                    {
                        _upstreamStarts.Enqueue(now);
                        return;
                    }

                    wait = _window - (now - _upstreamStarts.Peek());
                }

                await Task.Delay(wait < TimeSpan.FromMilliseconds(10) ? TimeSpan.FromMilliseconds(10) : wait, _time, cancellationToken).ConfigureAwait(false);
            }
        }

        /// <summary>Flat-rate providers of one region in TMDB order; null when the body is unreadable.</summary>
        public static LogoRef[]? ParseProviders(string json, string region) =>
            WatchProvidersBatch.ExtractFlatrate(json, region)?.Select(p => new LogoRef(Trim(p.ProviderName), p.LogoPath)).ToArray();

        /// <summary>
        /// A movie's production companies or a series' networks with their logo
        /// paths, in TMDB order; null when the body is unreadable. Entries without
        /// a usable name are skipped; a malformed logo path becomes null.
        /// </summary>
        public static LogoRef[]? ParseDetails(string json, string mediaType)
        {
            try
            {
                using var doc = JsonDocument.Parse(json);
                if (doc.RootElement.ValueKind != JsonValueKind.Object) return null;
                var list = new List<LogoRef>();
                var property = mediaType == "tv" ? "networks" : "production_companies";
                if (!doc.RootElement.TryGetProperty(property, out var entries) || entries.ValueKind != JsonValueKind.Array) return list.ToArray();
                foreach (var entry in entries.EnumerateArray())
                {
                    if (entry.ValueKind != JsonValueKind.Object || !entry.TryGetProperty("name", out var nameEl) || nameEl.ValueKind != JsonValueKind.String) continue;
                    var name = Trim(nameEl.GetString());
                    if (name.Length == 0) continue;
                    var logo = entry.TryGetProperty("logo_path", out var logoEl) && logoEl.ValueKind == JsonValueKind.String ? logoEl.GetString() : null;
                    list.Add(new LogoRef(name, IsLogoPath(logo) ? logo : null));
                }

                return list.ToArray();
            }
            catch (JsonException)
            {
                return null;
            }
        }

        private static string Trim(string? name)
        {
            var value = (name ?? string.Empty).Trim();
            return value.Length > MaxNameLength ? value[..MaxNameLength] : value;
        }

        /// <summary>True for a TMDB image path the proxy can serve ("/abc.png").</summary>
        public static bool IsLogoPath(string? path) => path != null && path.Length > 1 && path[0] == '/' && FilePattern.IsMatch(path[1..]);

        /// <summary>Allow the proxy to serve this logo path (it came from TMDB through a lookup or a cache entry).</summary>
        public void Remember(string? logoPath)
        {
            if (IsLogoPath(logoPath)) _knownFiles.TryAdd(logoPath![1..], 0);
        }

        /// <summary>True when the proxy may serve this size and file (exactly as a lookup spelled it).</summary>
        public bool IsAllowed(string? size, string? file) =>
            size != null && Sizes.Contains(size, StringComparer.Ordinal) && file != null && FilePattern.IsMatch(file) && _knownFiles.ContainsKey(file);

        private string ImagePath(string size, string file) => Path.Combine(_imageDir, size, file);

        /// <summary>Whether the image is in the disk cache (no read, no network).</summary>
        public bool IsCached(string size, string file) => IsAllowed(size, file) && File.Exists(ImagePath(size, file));

        /// <summary>A cached logo image, without network I/O (native posters); null when not cached or not allowed.</summary>
        public LogoImage? TryReadCached(string size, string file)
        {
            if (!IsAllowed(size, file)) return null;
            try
            {
                var path = ImagePath(size, file);
                if (!File.Exists(path)) return null;
                var bytes = File.ReadAllBytes(path);
                return bytes.Length == 0 ? null : new LogoImage(bytes, ContentTypeOf(file), ETagOf(bytes));
            }
            catch (IOException)
            {
                return null;
            }
            catch (UnauthorizedAccessException)
            {
                return null;
            }
        }

        /// <summary>
        /// The logo image for the proxy: from the disk cache, else fetched once
        /// from TMDB's image server and cached. Null when not allowed (checked
        /// first, so an unknown spelling never reaches a cache or TMDB), or when
        /// the fetch failed (retried after ten minutes).
        /// </summary>
        public Task<LogoImage?> GetImageAsync(string size, string file, CancellationToken cancellationToken)
        {
            if (!IsAllowed(size, file)) return Task.FromResult<LogoImage?>(null);
            if (TryReadCached(size, file) is { } cached) return Task.FromResult<LogoImage?>(cached);
            var key = size + "/" + file;
            if (_imageFailures.TryGetValue(key, out var failedAt)
                && _time.GetUtcNow().ToUnixTimeMilliseconds() - failedAt < ImageRetryAfter.TotalMilliseconds)
                return Task.FromResult<LogoImage?>(null);
            var shared = _imageFetches.GetOrAdd(key, _ => FetchImageAsync(size, file, key));
            // Forget the fetch once it ends (also when it completed before it was stored),
            // so a failure can be retried and a success is read from disk.
            var entry = new KeyValuePair<string, Task<LogoImage?>>(key, shared);
            if (shared.IsCompleted) _imageFetches.TryRemove(entry);
            else _ = shared.ContinueWith(_ => _imageFetches.TryRemove(entry), CancellationToken.None, TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
            return shared.WaitAsync(cancellationToken);
        }

        /// <summary>Fetch the images of these logo paths that are not cached yet (cache builds; native posters read them).</summary>
        public async Task WarmImagesAsync(IEnumerable<string?> logoPaths, CancellationToken cancellationToken)
        {
            var failures = 0;
            foreach (var path in logoPaths.Where(IsLogoPath).Distinct(StringComparer.Ordinal))
            {
                cancellationToken.ThrowIfCancellationRequested();
                Remember(path);
                if (TryReadCached(DefaultSize, path![1..]) != null) continue;
                // Offline: stop after a few failures; the proxy fetches on demand later.
                if (failures >= 3) break;
                if (await GetImageAsync(DefaultSize, path[1..], cancellationToken).ConfigureAwait(false) == null) failures++;
                else failures = 0;
            }
        }

        private async Task<LogoImage?> FetchImageAsync(string size, string file, string key)
        {
            try
            {
                using var cts = new CancellationTokenSource(ImageTimeout);
                var client = _httpClientFactory.CreateClient();
                using var response = await client.GetAsync($"https://image.tmdb.org/t/p/{size}/{file}", HttpCompletionOption.ResponseHeadersRead, cts.Token).ConfigureAwait(false);
                var type = response.Content.Headers.ContentType?.MediaType ?? string.Empty;
                if (!response.IsSuccessStatusCode || !type.StartsWith("image/", StringComparison.OrdinalIgnoreCase)
                    || type.Contains("svg", StringComparison.OrdinalIgnoreCase)
                    || response.Content.Headers.ContentLength > MaxImageBytes)
                    throw new HttpRequestException("logo image status " + (int)response.StatusCode + " " + type);
                await using var stream = await response.Content.ReadAsStreamAsync(cts.Token).ConfigureAwait(false);
                using var buffer = new MemoryStream();
                var chunk = new byte[16 * 1024];
                int read;
                while ((read = await stream.ReadAsync(chunk, cts.Token).ConfigureAwait(false)) > 0)
                {
                    if (buffer.Length + read > MaxImageBytes) throw new HttpRequestException("logo image too large");
                    buffer.Write(chunk, 0, read);
                }

                var bytes = buffer.ToArray();
                if (bytes.Length == 0) throw new HttpRequestException("empty logo image");
                var path = ImagePath(size, file);
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                var temp = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
                await File.WriteAllBytesAsync(temp, bytes, CancellationToken.None).ConfigureAwait(false);
                File.Move(temp, path, overwrite: true);
                _imageFailures.TryRemove(key, out _);
                return new LogoImage(bytes, ContentTypeOf(file), ETagOf(bytes));
            }
            catch (Exception ex) when (ex is HttpRequestException or IOException or OperationCanceledException or UnauthorizedAccessException)
            {
                _imageFailures[key] = _time.GetUtcNow().ToUnixTimeMilliseconds();
                _logger?.Debug($"[LogoTags] logo image {size}/{file} unavailable: {ex.Message}");
                return null;
            }
        }

        private static string ContentTypeOf(string file) => Path.GetExtension(file).ToLowerInvariant() switch
        {
            ".jpg" or ".jpeg" => "image/jpeg",
            ".webp" => "image/webp",
            _ => "image/png",
        };

        /// <summary>Strong ETag of the image bytes.</summary>
        public static string ETagOf(byte[] bytes) => "\"" + Convert.ToHexString(SHA256.HashData(bytes), 0, 16).ToLowerInvariant() + "\"";

        private void LoadFromDisk()
        {
            if (_storePath == null || !File.Exists(_storePath)) return;
            try
            {
                var data = JsonSerializer.Deserialize<DiskFormat>(File.ReadAllText(_storePath));
                if (data?.V != DiskSchemaVersion || data.Lookups == null) return;
                foreach (var (key, lookup) in data.Lookups)
                {
                    if (lookup?.Items == null) continue;
                    var items = lookup.Items.Where(i => i != null && !string.IsNullOrWhiteSpace(i.Name))
                        .Select(i => i with { Name = Trim(i.Name), Logo = IsLogoPath(i.Logo) ? i.Logo : null }).ToArray();
                    _lookups[key] = lookup with { Items = items };
                    foreach (var item in items) Remember(item.Logo);
                }
            }
            catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException)
            {
                _logger?.Warning($"[LogoTags] Could not read {_storePath}: {ex.Message}");
            }
        }

        private void ScheduleSave()
        {
            if (_storePath == null || _disposed) return;
            lock (_saveLock)
            {
                _saveTimer ??= new Timer(_ => SaveToDisk(), null, Timeout.Infinite, Timeout.Infinite);
                _saveTimer.Change(SaveDebounce, Timeout.InfiniteTimeSpan);
            }
        }

        /// <summary>Write the lookups now (tests and shutdown; normally debounced).</summary>
        public void SaveToDisk()
        {
            if (_storePath == null) return;
            lock (_saveLock)
            {
                try
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(_storePath)!);
                    var temp = _storePath + ".tmp";
                    File.WriteAllText(temp, JsonSerializer.Serialize(new DiskFormat { V = DiskSchemaVersion, Lookups = new Dictionary<string, Lookup>(_lookups, StringComparer.Ordinal) }));
                    File.Move(temp, _storePath, overwrite: true);
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    _logger?.Warning($"[LogoTags] Could not write {_storePath}: {ex.Message}");
                }
            }
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            lock (_saveLock)
            {
                _saveTimer?.Dispose();
                _saveTimer = null;
            }

            SaveToDisk();
            _slots.Dispose();
            if (ReferenceEquals(Instance, this)) Instance = null;
        }
    }
}
