using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// TMDB schedule facts for the Status Tags series badges (Airing Today,
    /// Airs / Returns {date}, Season / Series Finale, Returning / Ended /
    /// Cancelled): a series' <c>status</c>, <c>last_episode_to_air</c> and
    /// <c>next_episode_to_air</c> from TMDB's <c>tv/{id}</c>, read through
    /// <see cref="TmdbResponseCache"/> (a title lookup, kept for 6 hours and
    /// shared with every other TMDB caller). Only public TMDB data is returned
    /// and nothing is stored per user; the controller decides which series a
    /// caller may ask about.
    /// <para>
    /// Lookups are rate-limited for TMDB's ~40 requests per 10 seconds: at most
    /// <see cref="MaxInFlight"/> run at once, and once
    /// <see cref="UpstreamPerWindow"/> lookups in the last
    /// <see cref="RateWindow"/> went upstream, the next one waits for the
    /// window to move on. Answers still fresh in the response cache skip both.
    /// </para>
    /// </summary>
    public sealed class StatusTagsSeriesService
    {
        /// <summary>Most series ids one request may ask about.</summary>
        public const int MaxIds = 50;

        /// <summary>Lookups running at once, across every request.</summary>
        public const int MaxInFlight = 4;

        /// <summary>Upstream lookups allowed per <see cref="RateWindow"/> (TMDB allows about 40).</summary>
        public const int UpstreamPerWindow = 35;

        /// <summary>The rate limit's sliding window.</summary>
        public static readonly TimeSpan RateWindow = TimeSpan.FromSeconds(10);

        private readonly TmdbResponseCache _tmdbResponseCache;
        private readonly Logger _logger;
        private readonly TimeProvider _timeProvider;
        private readonly SemaphoreSlim _slots;
        private readonly int _perWindow;
        private readonly TimeSpan _window;
        private readonly object _windowLock = new();
        // Start times of the lookups that went upstream, oldest first.
        private readonly Queue<DateTimeOffset> _upstreamStarts = new();

        public StatusTagsSeriesService(TmdbResponseCache tmdbResponseCache, Logger logger)
            : this(tmdbResponseCache, logger, TimeProvider.System, MaxInFlight, UpstreamPerWindow, RateWindow)
        {
        }

        internal StatusTagsSeriesService(TmdbResponseCache tmdbResponseCache, Logger logger, TimeProvider timeProvider, int maxInFlight, int perWindow, TimeSpan window)
        {
            _tmdbResponseCache = tmdbResponseCache;
            _logger = logger;
            _timeProvider = timeProvider;
            _slots = new SemaphoreSlim(maxInFlight, maxInFlight);
            _perWindow = perWindow;
            _window = window;
        }

        /// <summary>
        /// Schedule facts per caller key, for the TMDB series ids given
        /// (<c>key → tmdbId</c>). Keys whose series TMDB does not know, or whose
        /// lookup fails, are left out. No API key: empty.
        /// </summary>
        public async Task<Dictionary<string, SeriesSchedule>> GetAsync(string? apiKey, IReadOnlyDictionary<string, string> tmdbIdsByKey, CancellationToken cancellationToken)
        {
            var result = new Dictionary<string, SeriesSchedule>(StringComparer.Ordinal);
            if (string.IsNullOrEmpty(apiKey) || tmdbIdsByKey.Count == 0) return result;

            // One lookup per distinct TMDB id (two library items can share one).
            var lookups = tmdbIdsByKey.Values.Distinct(StringComparer.Ordinal)
                .ToDictionary(id => id, id => LookupAsync(apiKey, id, cancellationToken), StringComparer.Ordinal);
            await Task.WhenAll(lookups.Values).ConfigureAwait(false);
            foreach (var (key, tmdbId) in tmdbIdsByKey)
            {
                if (lookups[tmdbId].Result is { } schedule) result[key] = schedule;
            }

            return result;
        }

        /// <summary>Read the series, enriching a missing episode type from its season.</summary>
        private async Task<SeriesSchedule?> LookupAsync(string apiKey, string tmdbId, CancellationToken cancellationToken)
        {
            var body = await FetchBodyAsync(apiKey, "tv/" + tmdbId, cancellationToken).ConfigureAwait(false);
            var schedule = body == null ? null : Parse(body);
            if (schedule?.LastAired is not { Type: null, Season: { } season, Episode: { } episode } last) return schedule;
            var seasonBody = await FetchBodyAsync(apiKey, $"tv/{tmdbId}/season/{season}", cancellationToken).ConfigureAwait(false);
            if (seasonBody == null) return schedule;
            try
            {
                using var doc = JsonDocument.Parse(seasonBody);
                if (doc.RootElement.ValueKind == JsonValueKind.Object
                    && doc.RootElement.TryGetProperty("episodes", out var episodes) && episodes.ValueKind == JsonValueKind.Array)
                {
                    foreach (var ep in episodes.EnumerateArray())
                    {
                        if (ep.ValueKind == JsonValueKind.Object
                            && ep.TryGetProperty("episode_number", out var n) && n.ValueKind == JsonValueKind.Number && n.TryGetInt32(out var number) && number == episode
                            && ep.TryGetProperty("episode_type", out var type) && type.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(type.GetString()))
                            return schedule with { LastAired = last with { Type = type.GetString() } };
                    }
                }
            }
            catch (JsonException) { /* Keep the usable series facts. */ }
            return schedule;
        }

        /// <summary>Read through the shared six-hour cache, with bounded upstream work.</summary>
        private async Task<string?> FetchBodyAsync(string apiKey, string apiPath, CancellationToken cancellationToken)
        {
            if (_tmdbResponseCache.TryGetFresh(apiPath, string.Empty, apiKey, out var cached))
                return cached.IsSuccess ? cached.Content : null;
            await _slots.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                if (_tmdbResponseCache.TryGetFresh(apiPath, string.Empty, apiKey, out cached))
                    return cached.IsSuccess ? cached.Content : null;
                await WaitForRateWindowAsync(cancellationToken).ConfigureAwait(false);
                // TmdbResponseCache owns a 30-second upstream timeout. Caller
                // cancellation must not free this slot while its shared HTTP
                // request is still running, or subsequent callers can exceed four.
                var response = await _tmdbResponseCache.GetAsync(apiPath, string.Empty, apiKey, CancellationToken.None).ConfigureAwait(false);
                return response.IsSuccess ? response.Content : null;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { throw; }
            catch (Exception ex)
            {
                _logger.Debug($"[StatusTags] TMDB series lookup {apiPath} failed: {ex.Message}");
                return null;
            }
            finally { _slots.Release(); }
        }

        /// <summary>Wait while the window already holds its share of upstream lookups.</summary>
        private async Task WaitForRateWindowAsync(CancellationToken cancellationToken)
        {
            while (true)
            {
                TimeSpan wait;
                lock (_windowLock)
                {
                    var now = _timeProvider.GetUtcNow();
                    while (_upstreamStarts.Count > 0 && now - _upstreamStarts.Peek() >= _window) _upstreamStarts.Dequeue();
                    if (_upstreamStarts.Count < _perWindow)
                    {
                        _upstreamStarts.Enqueue(now);
                        return;
                    }
                    wait = _window - (now - _upstreamStarts.Peek());
                }

                await Task.Delay(wait < TimeSpan.FromMilliseconds(10) ? TimeSpan.FromMilliseconds(10) : wait, _timeProvider, cancellationToken).ConfigureAwait(false);
            }
        }

        /// <summary>
        /// The schedule facts of a TMDB <c>tv/{id}</c> body, or null when it is
        /// not a readable series. Episode objects without a usable air date are
        /// treated as absent.
        /// </summary>
        public static SeriesSchedule? Parse(string json)
        {
            try
            {
                using var doc = JsonDocument.Parse(json);
                var root = doc.RootElement;
                if (root.ValueKind != JsonValueKind.Object) return null;
                var status = root.TryGetProperty("status", out var s) && s.ValueKind == JsonValueKind.String ? s.GetString() : null;
                var last = ReadEpisode(root, "last_episode_to_air", withType: true);
                var next = ReadEpisode(root, "next_episode_to_air", withType: false);
                if (status == null && last == null && next == null) return null;
                return new SeriesSchedule(string.IsNullOrWhiteSpace(status) ? null : status, last, next);
            }
            catch (JsonException)
            {
                return null;
            }
        }

        private static SeriesEpisodeRef? ReadEpisode(JsonElement root, string property, bool withType)
        {
            if (!root.TryGetProperty(property, out var ep) || ep.ValueKind != JsonValueKind.Object) return null;
            var date = ep.TryGetProperty("air_date", out var d) && d.ValueKind == JsonValueKind.String ? d.GetString() : null;
            // TMDB dates are plain calendar dates; anything else is unusable.
            if (date == null || !DateOnly.TryParseExact(date, "yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.None, out _)) return null;
            int? season = ep.TryGetProperty("season_number", out var sn) && sn.ValueKind == JsonValueKind.Number && sn.TryGetInt32(out var snv) ? snv : null;
            int? episode = ep.TryGetProperty("episode_number", out var en) && en.ValueKind == JsonValueKind.Number && en.TryGetInt32(out var env) ? env : null;
            string? type = withType && ep.TryGetProperty("episode_type", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() : null;
            return new SeriesEpisodeRef(date, season, episode, string.IsNullOrWhiteSpace(type) ? null : type);
        }
    }

    /// <summary>
    /// A series' TMDB schedule: <see cref="Status"/> as TMDB names it ("Returning
    /// Series", "Ended", "Canceled", "In Production", "Planned", "Pilot"), its
    /// newest aired episode and its next scheduled one.
    /// </summary>
    public sealed record SeriesSchedule(string? Status, SeriesEpisodeRef? LastAired, SeriesEpisodeRef? NextAired);

    /// <summary>
    /// One TMDB episode reference: air date as TMDB's calendar date
    /// (yyyy-MM-dd), numbers, and (last aired only) TMDB's <c>episode_type</c>
    /// ("standard", "finale", "mid_season"; null when TMDB has none).
    /// </summary>
    public sealed record SeriesEpisodeRef(string Date, int? Season, int? Episode, string? Type);
}
