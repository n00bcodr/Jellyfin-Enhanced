using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Model;
using MediaBrowser.Common.Configuration;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// DoesTheDogDie content-warning votes, cached to ddd-cache.json. The free tier is only
    /// 5,000 requests a month, so titles are cached for weeks and every call is gated by the
    /// API's rate-limit headers.
    /// </summary>
    public class DoesTheDogDieService : IDisposable
    {
        private const string ApiBase = "https://www.doesthedogdie.com/api/v3";
        private const int CurrentSchemaVersion = 1;
        // Stop looking up new titles when this few requests are left this month.
        private const int MonthlyReserve = 100;

        private static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(15);
        private static readonly TimeSpan PositiveTtl = TimeSpan.FromDays(30);
        private static readonly TimeSpan NegativeTtl = TimeSpan.FromDays(14);
        private static readonly TimeSpan RetryTtl = TimeSpan.FromHours(1);
        private static readonly TimeSpan CatalogTtl = TimeSpan.FromDays(30);
        private static readonly TimeSpan SaveDebounce = TimeSpan.FromSeconds(10);

        private readonly IHttpClientFactory _httpClientFactory;
        private readonly IApplicationPaths _applicationPaths;
        private readonly Logger _logger;

        private readonly ConcurrentDictionary<string, DddCacheEntry> _cache = new();
        private readonly ConcurrentDictionary<string, SemaphoreSlim> _inFlight = new();
        private readonly SemaphoreSlim _catalogGate = new(1, 1);
        private readonly object _saveLock = new();
        private DddCatalog? _catalog;
        private Timer? _saveTimer;
        private volatile bool _disposed;

        // Kept up to date from the response headers.
        private int _remainingMonth = int.MaxValue;
        private DateTimeOffset _pausedUntil = DateTimeOffset.MinValue;

        public DoesTheDogDieService(IHttpClientFactory httpClientFactory, IApplicationPaths applicationPaths, Logger logger)
        {
            _httpClientFactory = httpClientFactory;
            _applicationPaths = applicationPaths;
            _logger = logger;
            LoadFromDisk();
        }

        private string CacheFilePath =>
            Path.Combine(_applicationPaths.PluginsPath, "configurations", "Jellyfin.Plugin.JellyfinEnhanced", "ddd-cache.json");

        private static string CacheKey(string mediaType, string tmdbId) => $"{mediaType}-{tmdbId}";

        private static bool IsExpired(DddCacheEntry entry)
        {
            var age = DateTimeOffset.UtcNow - DateTimeOffset.FromUnixTimeMilliseconds(entry.FetchedAtUnixMs);
            if (!entry.Confirmed) return age > RetryTtl;
            return age > (entry.Found ? PositiveTtl : NegativeTtl);
        }

        /// <summary>Warnings for a title, from cache when possible.</summary>
        public async Task<DddCacheEntry> GetWarningsAsync(string mediaType, string tmdbId, CancellationToken ct)
        {
            var key = CacheKey(mediaType, tmdbId);
            if (_cache.TryGetValue(key, out var cached) && !IsExpired(cached)) return cached;

            var gate = _inFlight.GetOrAdd(key, _ => new SemaphoreSlim(1, 1));
            await gate.WaitAsync(ct).ConfigureAwait(false);
            try
            {
                if (_cache.TryGetValue(key, out cached) && !IsExpired(cached)) return cached;

                var fetched = await FetchTitleAsync(mediaType, tmdbId, ct).ConfigureAwait(false);
                _cache[key] = fetched;
                ScheduleSave();
                return fetched;
            }
            finally
            {
                gate.Release();
                if (gate.CurrentCount == 1) _inFlight.TryRemove(key, out _);
            }
        }

        /// <summary>Topic catalogue for the picker, refreshed monthly.</summary>
        public async Task<DddCatalog?> GetCatalogAsync(CancellationToken ct)
        {
            if (_catalog != null && !CatalogExpired(_catalog)) return _catalog;

            await _catalogGate.WaitAsync(ct).ConfigureAwait(false);
            try
            {
                if (_catalog != null && !CatalogExpired(_catalog)) return _catalog;

                var fresh = await FetchCatalogAsync(ct).ConfigureAwait(false);
                if (fresh != null)
                {
                    _catalog = fresh;
                    ScheduleSave();
                }
                // Keep serving the old catalogue if the refresh failed.
                return _catalog;
            }
            finally
            {
                _catalogGate.Release();
            }
        }

        private static bool CatalogExpired(DddCatalog c) =>
            DateTimeOffset.UtcNow - DateTimeOffset.FromUnixTimeMilliseconds(c.FetchedAtUnixMs) > CatalogTtl;

        // False while paused or when the monthly budget is nearly gone.
        private bool CanCall()
        {
            if (DateTimeOffset.UtcNow < _pausedUntil) return false;
            if (_remainingMonth <= MonthlyReserve)
            {
                _logger.Warning($"[DoesTheDogDie] Only {_remainingMonth} requests left this month, skipping lookups");
                return false;
            }
            return true;
        }

        private async Task<(HttpStatusCode Status, string Body)?> GetAsync(string path, CancellationToken ct)
        {
            var apiKey = JellyfinEnhanced.Instance?.Configuration?.DoesTheDogDieApiKey;
            if (string.IsNullOrWhiteSpace(apiKey) || !CanCall()) return null;

            var client = _httpClientFactory.CreateClient();
            client.Timeout = RequestTimeout;
            using var request = new HttpRequestMessage(HttpMethod.Get, ApiBase + path);
            request.Headers.Add("X-API-KEY", apiKey);
            using var response = await client.SendAsync(request, ct).ConfigureAwait(false);

            if (response.Headers.TryGetValues("x-ratelimit-remaining-month", out var month) && int.TryParse(month.FirstOrDefault(), out var m))
            {
                _remainingMonth = m;
            }
            if (response.Headers.TryGetValues("x-ratelimit-remaining-minute", out var minute) && int.TryParse(minute.FirstOrDefault(), out var n) && n <= 1)
            {
                // Out of requests this minute, back off briefly.
                _pausedUntil = DateTimeOffset.UtcNow.AddSeconds(30);
            }
            if (response.StatusCode == HttpStatusCode.TooManyRequests)
            {
                var wait = response.Headers.RetryAfter?.Delta ?? TimeSpan.FromMinutes(1);
                _pausedUntil = DateTimeOffset.UtcNow + wait;
                _logger.Warning($"[DoesTheDogDie] Rate limited, pausing calls for {wait.TotalSeconds:0}s");
            }

            var body = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            return (response.StatusCode, body);
        }

        private async Task<DddCacheEntry> FetchTitleAsync(string mediaType, string tmdbId, CancellationToken ct)
        {
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var unconfirmed = new DddCacheEntry { Found = false, Confirmed = false, FetchedAtUnixMs = now };

            try
            {
                var search = await GetAsync($"/items?tmdb={Uri.EscapeDataString(tmdbId)}", ct).ConfigureAwait(false);
                if (search == null || search.Value.Status != HttpStatusCode.OK) return unconfirmed;

                using var searchDoc = JsonDocument.Parse(search.Value.Body);
                if (searchDoc.RootElement.ValueKind != JsonValueKind.Array) return unconfirmed;

                // One TMDB id can be both a movie and a show.
                var wantedType = mediaType == "tv" ? "tv" : "movie";
                var match = searchDoc.RootElement.EnumerateArray().FirstOrDefault(e =>
                    e.TryGetProperty("itemTypeName", out var t) &&
                    string.Equals(t.GetString(), wantedType, StringComparison.OrdinalIgnoreCase));

                if (match.ValueKind != JsonValueKind.Object || !match.TryGetProperty("id", out var idEl))
                {
                    return new DddCacheEntry { Found = false, Confirmed = true, FetchedAtUnixMs = now };
                }
                var itemId = idEl.GetInt32();

                var detail = await GetAsync($"/items/{itemId}", ct).ConfigureAwait(false);
                if (detail == null || detail.Value.Status != HttpStatusCode.OK) return unconfirmed;

                using var detailDoc = JsonDocument.Parse(detail.Value.Body);
                var root = detailDoc.RootElement;
                var topics = new List<DddTopicStat>();
                if (root.TryGetProperty("topicItemStats", out var stats) && stats.ValueKind == JsonValueKind.Array)
                {
                    foreach (var s in stats.EnumerateArray())
                    {
                        var yes = s.TryGetProperty("yesSum", out var y) && y.TryGetInt32(out var yv) ? yv : 0;
                        var no = s.TryGetProperty("noSum", out var nn) && nn.TryGetInt32(out var nv) ? nv : 0;
                        if (yes + no == 0 || !s.TryGetProperty("topicId", out var tid)) continue;
                        topics.Add(new DddTopicStat
                        {
                            Id = tid.GetInt32(),
                            Name = s.TryGetProperty("topicName", out var tn) ? tn.GetString() ?? string.Empty : string.Empty,
                            Yes = yes,
                            No = no,
                        });
                    }
                }

                return new DddCacheEntry
                {
                    Found = true,
                    Confirmed = true,
                    ItemId = itemId,
                    Name = root.TryGetProperty("name", out var nameEl) ? nameEl.GetString() ?? string.Empty : string.Empty,
                    Topics = topics,
                    FetchedAtUnixMs = now,
                };
            }
            catch (Exception ex)
            {
                // Don't break the page over this; retry in an hour.
                _logger.Warning($"[DoesTheDogDie] Lookup failed for {mediaType}:{tmdbId}: {ex.Message}");
                return unconfirmed;
            }
        }

        private async Task<DddCatalog?> FetchCatalogAsync(CancellationToken ct)
        {
            try
            {
                var topics = await GetAsync("/topics", ct).ConfigureAwait(false);
                var cats = await GetAsync("/topiccategories", ct).ConfigureAwait(false);
                var supers = await GetAsync("/topicsupercategories", ct).ConfigureAwait(false);
                if (topics?.Status != HttpStatusCode.OK || cats?.Status != HttpStatusCode.OK || supers?.Status != HttpStatusCode.OK) return null;

                using var topicsDoc = JsonDocument.Parse(topics.Value.Body);
                using var catsDoc = JsonDocument.Parse(cats.Value.Body);
                using var supersDoc = JsonDocument.Parse(supers.Value.Body);

                var superNames = supersDoc.RootElement.EnumerateArray()
                    .ToDictionary(e => e.GetProperty("id").GetInt32(), e => e.GetProperty("shortName").GetString() ?? string.Empty);
                var categories = catsDoc.RootElement.EnumerateArray()
                    .ToDictionary(
                        e => e.GetProperty("id").GetInt32(),
                        e => (Name: e.GetProperty("name").GetString() ?? string.Empty,
                              Group: superNames.TryGetValue(e.GetProperty("topicSuperCategoryId").GetInt32(), out var g) ? g : string.Empty));

                var result = new DddCatalog { FetchedAtUnixMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() };
                foreach (var t in topicsDoc.RootElement.EnumerateArray())
                {
                    var catId = t.TryGetProperty("topicCategoryId", out var c) && c.ValueKind == JsonValueKind.Number ? c.GetInt32() : -1;
                    categories.TryGetValue(catId, out var cat);
                    result.Topics.Add(new DddCatalogTopic
                    {
                        Id = t.GetProperty("id").GetInt32(),
                        Name = t.GetProperty("name").GetString() ?? string.Empty,
                        Category = cat.Name ?? string.Empty,
                        Group = cat.Group ?? string.Empty,
                    });
                }
                return result;
            }
            catch (Exception ex)
            {
                _logger.Warning($"[DoesTheDogDie] Failed to fetch topic catalogue: {ex.Message}");
                return null;
            }
        }

        private void LoadFromDisk()
        {
            try
            {
                if (!File.Exists(CacheFilePath)) return;
                using var stream = File.OpenRead(CacheFilePath);
                var data = JsonSerializer.Deserialize<DddCacheDiskFormat>(stream);
                if (data == null || data.SchemaVersion != CurrentSchemaVersion) return;

                _catalog = data.Catalog;
                foreach (var kvp in data.Items) _cache[kvp.Key] = kvp.Value;
                _logger.Info($"[DoesTheDogDie] Loaded {_cache.Count} entries from disk");
            }
            catch (Exception ex)
            {
                _logger.Warning($"[DoesTheDogDie] Failed to load cache from disk: {ex.Message}");
            }
        }

        private void SaveToDisk()
        {
            lock (_saveLock)
            {
                try
                {
                    var dir = Path.GetDirectoryName(CacheFilePath);
                    if (dir != null) Directory.CreateDirectory(dir);

                    var data = new DddCacheDiskFormat
                    {
                        SchemaVersion = CurrentSchemaVersion,
                        Catalog = _catalog,
                        Items = new Dictionary<string, DddCacheEntry>(_cache),
                    };
                    var tempPath = CacheFilePath + ".tmp";
                    using (var stream = File.Create(tempPath))
                    {
                        JsonSerializer.Serialize(stream, data);
                    }
                    File.Move(tempPath, CacheFilePath, overwrite: true);
                }
                catch (Exception ex)
                {
                    _logger.Error($"[DoesTheDogDie] Failed to save cache to disk: {ex.Message}");
                }
            }
        }

        // Debounced so a burst of lookups writes once.
        private void ScheduleSave()
        {
            if (_disposed) { SaveToDisk(); return; }
            var timer = _saveTimer;
            if (timer != null)
            {
                try { timer.Change(SaveDebounce, Timeout.InfiniteTimeSpan); return; }
                catch (ObjectDisposedException) { }
            }
            _saveTimer = new Timer(_ => SaveToDisk(), null, SaveDebounce, Timeout.InfiniteTimeSpan);
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            _saveTimer?.Dispose();
            SaveToDisk();
            _catalogGate.Dispose();
        }
    }
}
