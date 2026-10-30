using System;
using System.Collections.Generic;
using System.Globalization;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// One server-wide trending list for the Status Tags "#N Today" / "#N This Week"
    /// poster badges: TMDB ids mapped to their 1-based rank. The list holds only
    /// public TMDB ids and ranks (no titles, nothing about the library or a user),
    /// so one copy is shared by every caller and kept for <see cref="CacheTtl"/>.
    /// Clients only use it to decorate items they can already see.
    /// <para>
    /// Source order: TMDB's daily <c>trending/all/day</c> (pages 1-3, through
    /// <see cref="TmdbResponseCache"/>) when a TMDB API key is configured; otherwise,
    /// or when TMDB gives nothing back, Seerr's <c>/api/v1/discover/trending</c>
    /// (TMDB's weekly list) with the server's API key and no user header, so no
    /// per-user parental rewrite applies. A source that answers without a single
    /// rankable title counts as no answer. Neither: an empty list (kept only for
    /// <see cref="EmptyCacheTtl"/>).
    /// </para>
    /// </summary>
    public sealed class StatusTagsTrendingService
    {
        /// <summary>Ranks kept per list (three TMDB pages of 20).</summary>
        public const int MaxRanks = 60;

        private const int Pages = 3;
        private static readonly TimeSpan CacheTtl = TimeSpan.FromMinutes(30);
        // An upstream that answered nothing is retried sooner than a good list
        // expires, but not on every page load.
        private static readonly TimeSpan EmptyCacheTtl = TimeSpan.FromMinutes(5);
        private static readonly TimeSpan SeerrTimeout = TimeSpan.FromSeconds(10);
        private static readonly TimeSpan TmdbTimeout = TimeSpan.FromSeconds(10);

        // Static so a config save (JellyfinEnhanced.UpdateConfiguration) can drop it
        // without resolving the singleton.
        private static readonly object CacheLock = new();
        private static TrendingSnapshot? _cached;
        private static DateTime _cachedUntilUtc;
        private static Task<TrendingSnapshot>? _inFlight;
        private static long _generation;
        // The last list stored was empty: the next fetch asks TMDB again instead
        // of reading the (possibly empty) pages TmdbResponseCache kept for it,
        // which outlive EmptyCacheTtl. Survives Invalidate() on purpose.
        private static bool _lastAnswerWasEmpty;

        private readonly IHttpClientFactory _httpClientFactory;
        private readonly TmdbResponseCache _tmdbResponseCache;
        private readonly Logger _logger;
        private readonly TimeProvider _nativeTime;
        private readonly object _nativeLock = new();
        private Task<TrendingSnapshot>? _nativeFlight;
        private TrendingSnapshot? _nativeCached;
        private DateTime _nativeUntil;
        private PluginConfiguration? _nativeConfig;

        public StatusTagsTrendingService(IHttpClientFactory httpClientFactory, TmdbResponseCache tmdbResponseCache, Logger logger)
            : this(httpClientFactory, tmdbResponseCache, logger, TimeProvider.System)
        {
        }

        internal StatusTagsTrendingService(IHttpClientFactory httpClientFactory, TmdbResponseCache tmdbResponseCache, Logger logger, TimeProvider timeProvider)
        {
            _httpClientFactory = httpClientFactory;
            _tmdbResponseCache = tmdbResponseCache;
            _logger = logger;
            _nativeTime = timeProvider;
        }

        /// <summary>The list served when trending is off or has no source.</summary>
        public static TrendingSnapshot Empty { get; } = new(null, new Dictionary<string, int>(), new Dictionary<string, int>());

        /// <summary>
        /// Drop the cached list (config saved: the TMDB key, Seerr or the switches
        /// may have changed). A fetch already running finishes but is not kept.
        /// </summary>
        public static void Invalidate()
        {
            lock (CacheLock)
            {
                _cached = null;
                _inFlight = null;
                _generation++;
            }
        }

        /// <summary>
        /// The current trending list, from the cache or one shared upstream fetch.
        /// <paramref name="cancellationToken"/> only stops this caller waiting; the
        /// fetch itself completes for the next caller.
        /// </summary>
        public Task<TrendingSnapshot> GetAsync(PluginConfiguration config, CancellationToken cancellationToken)
        {
            Task<TrendingSnapshot> shared;
            lock (CacheLock)
            {
                if (_cached != null && DateTime.UtcNow < _cachedUntilUtc)
                {
                    return Task.FromResult(_cached);
                }

                if (_inFlight == null)
                {
                    var generation = _generation;
                    _inFlight = FetchAndStoreAsync(config, generation, bypassResponseCache: _lastAnswerWasEmpty);
                }

                shared = _inFlight;
            }

            return shared.WaitAsync(cancellationToken);
        }

        /// <summary>Native posters use TMDB daily ranks only. The worker lifetime owns pagination;
        /// a caller's cancellation token only stops its wait, preserving shared HTTP ownership.</summary>
        public Task<TrendingSnapshot> GetNativeAsync(PluginConfiguration config, CancellationToken cancellationToken, CancellationToken workerLifetime = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            workerLifetime.ThrowIfCancellationRequested();
            if (!config.StatusTagsEnabled || !config.StatusTagsTrending || string.IsNullOrWhiteSpace(config.TMDB_API_KEY)) return Task.FromResult(Empty);
            lock (_nativeLock)
            {
                if (!ReferenceEquals(config, _nativeConfig))
                {
                    _nativeConfig = config;
                    _nativeCached = null;
                    _nativeFlight = null;
                }
                if (_nativeCached != null && _nativeTime.GetUtcNow().UtcDateTime < _nativeUntil) return Task.FromResult(_nativeCached);
                _nativeFlight ??= FetchNativeAsync(config, bypassResponseCache: _nativeCached?.Source == null && _nativeCached != null, workerLifetime);
                return _nativeFlight.WaitAsync(cancellationToken);
            }
        }

        /// <summary>Cache-only image lookup. The background worker owns refreshes.</summary>
        public bool TryGetNative(PluginConfiguration config, out TrendingSnapshot snapshot)
        {
            lock (_nativeLock)
            {
                if (ReferenceEquals(config, _nativeConfig) && _nativeCached != null && _nativeTime.GetUtcNow().UtcDateTime < _nativeUntil)
                {
                    snapshot = _nativeCached;
                    return true;
                }
                snapshot = Empty;
                return false;
            }
        }

        private async Task<TrendingSnapshot> FetchNativeAsync(PluginConfiguration config, bool bypassResponseCache, CancellationToken workerLifetime)
        {
            await Task.Yield();
            var day = _nativeTime.GetUtcNow().UtcDateTime.Date;
            try
            {
                TrendingSnapshot answer;
                try
                {
                    answer = await FetchTmdbAsync(config.TMDB_API_KEY, bypassResponseCache,
                        new DateTimeOffset(day, TimeSpan.Zero), workerLifetime).ConfigureAwait(false) ?? Empty;
                }
                catch (OperationCanceledException) when (workerLifetime.IsCancellationRequested) { throw; }
                catch (Exception ex) { _logger.Debug($"[StatusTags] Native trending unavailable: {ex.Message}"); answer = Empty; }
                lock (_nativeLock)
                {
                    workerLifetime.ThrowIfCancellationRequested();
                    if (ReferenceEquals(config, _nativeConfig))
                    {
                        _nativeCached = answer;
                        var now = _nativeTime.GetUtcNow().UtcDateTime;
                        _nativeUntil = answer.Source == null ? now.AddMinutes(5) : day.AddDays(1);
                    }
                }
                return answer;
            }
            finally
            {
                lock (_nativeLock)
                {
                    if (ReferenceEquals(config, _nativeConfig)) _nativeFlight = null;
                }
            }
        }

        private async Task<TrendingSnapshot> FetchAndStoreAsync(PluginConfiguration config, long generation, bool bypassResponseCache)
        {
            // Off the caller's thread: the lock above must not be held across I/O.
            await Task.Yield();
            TrendingSnapshot snapshot;
            try
            {
                snapshot = await FetchAsync(config, bypassResponseCache).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                _logger.Warning($"[StatusTags] Trending fetch failed: {ex.Message}");
                snapshot = Empty;
            }

            lock (CacheLock)
            {
                if (generation == _generation)
                {
                    _lastAnswerWasEmpty = snapshot.Source == null;
                    _cached = snapshot;
                    _cachedUntilUtc = DateTime.UtcNow + (snapshot.Source == null ? EmptyCacheTtl : CacheTtl);
                    _inFlight = null;
                }
            }

            return snapshot;
        }

        private async Task<TrendingSnapshot> FetchAsync(PluginConfiguration config, bool bypassResponseCache)
        {
            if (!string.IsNullOrEmpty(config.TMDB_API_KEY))
            {
                var fromTmdb = await FetchTmdbAsync(config.TMDB_API_KEY, bypassResponseCache).ConfigureAwait(false);
                if (fromTmdb != null) return fromTmdb;
            }

            if (config.JellyseerrEnabled && !string.IsNullOrEmpty(config.JellyseerrUrls) && !string.IsNullOrEmpty(config.JellyseerrApiKey))
            {
                var fromSeerr = await FetchSeerrAsync(config).ConfigureAwait(false);
                if (fromSeerr != null) return fromSeerr;
            }

            return Empty;
        }

        /// <summary>
        /// TMDB daily trending, pages 1-3; null when no ranks could be read.
        /// After an empty answer the pages are asked for again upstream rather
        /// than read from <see cref="TmdbResponseCache"/>, whose copy of an
        /// empty page would otherwise outlive <see cref="EmptyCacheTtl"/> and
        /// keep every retry empty until it expired.
        /// </summary>
        private async Task<TrendingSnapshot?> FetchTmdbAsync(string apiKey, bool bypassResponseCache, DateTimeOffset? notBefore = null, CancellationToken workerLifetime = default)
        {
            var ranks = new RankBuilder();
            for (var page = 1; page <= Pages && !ranks.Full; page++)
            {
                workerLifetime.ThrowIfCancellationRequested();
                TmdbResponseCache.TmdbResponse response;
                try
                {
                    using var timeout = CancellationTokenSource.CreateLinkedTokenSource(workerLifetime);
                    timeout.CancelAfter(TmdbTimeout);
                    response = await _tmdbResponseCache
                        .GetAsync("trending/all/day", "?page=" + page.ToString(CultureInfo.InvariantCulture), apiKey, timeout.Token, bypassCache: bypassResponseCache, notBefore: notBefore)
                        .ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (workerLifetime.IsCancellationRequested) { throw; }
                catch (Exception ex)
                {
                    _logger.Debug($"[StatusTags] TMDB trending page {page} failed: {ex.Message}");
                    break;
                }

                workerLifetime.ThrowIfCancellationRequested();
                if (!response.IsSuccess)
                {
                    _logger.Debug($"[StatusTags] TMDB trending page {page} returned {response.StatusCode}");
                    break;
                }

                ranks.AddResults(response.Content, "media_type");
            }

            // A page that answered with no results (or only people) is not a list:
            // null lets Seerr answer instead, or the empty result's short retry apply.
            return ranks.IsEmpty ? null : ranks.Build("tmdb-day");
        }

        /// <summary>Seerr's trending (TMDB weekly), pages 1-3; null when no ranks could be read.</summary>
        private async Task<TrendingSnapshot?> FetchSeerrAsync(PluginConfiguration config)
        {
            var httpClient = SeerrHttpHelper.CreateClient(_httpClientFactory);
            httpClient.Timeout = SeerrTimeout;
            var urls = config.JellyseerrUrls.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);

            var ranks = new RankBuilder();
            for (var page = 1; page <= Pages && !ranks.Full; page++)
            {
                var pageRead = false;
                foreach (var url in urls)
                {
                    var requestUri = $"{url.Trim().TrimEnd('/')}/api/v1/discover/trending?page={page.ToString(CultureInfo.InvariantCulture)}";
                    try
                    {
                        using var request = SeerrHttpHelper.BuildRequest(HttpMethod.Get, requestUri, config.JellyseerrApiKey);
                        using var response = await httpClient.SendAsync(request).ConfigureAwait(false);
                        var (body, error) = await SeerrHttpHelper.ReadResponseAsync(response, requestUri).ConfigureAwait(false);
                        if (error != null || string.IsNullOrEmpty(body) || !response.IsSuccessStatusCode)
                        {
                            continue;
                        }

                        ranks.AddResults(body, "mediaType");
                        pageRead = true;
                        break;
                    }
                    catch (Exception ex)
                    {
                        _logger.Debug($"[StatusTags] Seerr trending page {page} failed: {SeerrError.SanitizeMessage(ex.Message)}");
                    }
                }

                if (!pageRead) break;
            }

            return ranks.IsEmpty ? null : ranks.Build("seerr-week");
        }

        /// <summary>
        /// Ranks movies and series in list order across pages; people and
        /// anything else in the list are skipped without using up a rank.
        /// </summary>
        private sealed class RankBuilder
        {
            private readonly Dictionary<string, int> _movies = new(StringComparer.Ordinal);
            private readonly Dictionary<string, int> _series = new(StringComparer.Ordinal);
            private int _rank;

            public bool Full => _rank >= MaxRanks;

            public bool IsEmpty => _rank == 0;

            public void AddResults(string json, string mediaTypeProperty)
            {
                using var doc = JsonDocument.Parse(json);
                if (!doc.RootElement.TryGetProperty("results", out var results) || results.ValueKind != JsonValueKind.Array)
                {
                    return;
                }

                foreach (var result in results.EnumerateArray())
                {
                    if (Full) return;
                    if (result.ValueKind != JsonValueKind.Object) continue;
                    if (!result.TryGetProperty("id", out var idElement) || !idElement.TryGetInt64(out var id) || id <= 0) continue;
                    var mediaType = result.TryGetProperty(mediaTypeProperty, out var typeElement) && typeElement.ValueKind == JsonValueKind.String
                        ? typeElement.GetString()
                        : null;
                    var target = mediaType switch
                    {
                        "movie" => _movies,
                        "tv" => _series,
                        _ => null,
                    };
                    if (target == null) continue;

                    var key = id.ToString(CultureInfo.InvariantCulture);
                    _rank++;
                    // A title listed twice (pages shifting between requests) keeps its better rank.
                    target.TryAdd(key, _rank);
                }
            }

            public TrendingSnapshot Build(string source) => new(source, _movies, _series);
        }
    }

    /// <summary>A trending list: its source ("tmdb-day", "seerr-week" or null) and TMDB id → rank maps.</summary>
    public sealed record TrendingSnapshot(string? Source, IReadOnlyDictionary<string, int> Movies, IReadOnlyDictionary<string, int> Series);
}
