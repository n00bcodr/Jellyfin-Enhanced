using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Import
{
    /// <summary>
    /// <see cref="IImportLookup"/> over TMDB with Jellyfin Enhanced's own TMDB key (through <see cref="TmdbResponseCache"/>),
    /// so imports work in a household without Seerr (JE mode). It answers the same query language as Seerr's search: plain
    /// titles (<c>search/multi</c>), <c>title year:YYYY</c> (<c>search/movie</c> + <c>search/tv</c> with the year),
    /// <c>tmdb:N</c> (the movie and the show with that id), <c>imdb:tt…</c> and <c>tvdb:N</c> (<c>find</c>). Adult titles
    /// and people are dropped; every upstream call goes through the shared <see cref="MetadataCallLimiter"/> with a 15 s
    /// timeout; definitive answers (a parsed answer, and "not found": review round 5, 4c2-R5-4) are reused with their status
    /// for 30 minutes per key identity (a changed key never reuses another's answers), and a reused answer never waits for
    /// the limiter. TMDB's own errors and unreadable answers are transient (never cached, retried); a 404 is "not found".
    /// </summary>
    public sealed class TmdbImportLookup : IImportLookup
    {
        /// <summary>How long a definitive answer (found or not found) is reused.</summary>
        public static readonly TimeSpan CacheTtl = TimeSpan.FromMinutes(30);

        /// <summary>Per upstream call timeout.</summary>
        public static readonly TimeSpan CallTimeout = TimeSpan.FromSeconds(15);

        private const int MaxCacheEntries = 5000;
        private const int MaxOverview = 300;
        private static readonly Regex PosterRegex = new("^/[A-Za-z0-9_-]+\\.(jpg|png)$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
        private static readonly Regex DateRegex = new("^\\d{4}-\\d{2}-\\d{2}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
        private static readonly Regex ImdbRegex = new("^tt[0-9]{5,10}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
        private static readonly Regex YearSuffix = new("^(?<title>.+?)\\s+year:(?<year>\\d{4})$", RegexOptions.Compiled | RegexOptions.CultureInvariant);

        private readonly TmdbResponseCache _tmdb;
        private readonly MetadataCallLimiter _limiter;
        private readonly Logger _logger;
        private readonly ConcurrentDictionary<string, (DateTime ExpiresUtc, LookupStatus Status, object? Value)> _cache = new(StringComparer.Ordinal);

        /// <summary>Creates the lookup (singleton).</summary>
        /// <param name="tmdb">JE's TMDB response cache.</param>
        /// <param name="limiter">Shared metadata limiter.</param>
        /// <param name="logger">JE logger.</param>
        public TmdbImportLookup(TmdbResponseCache tmdb, MetadataCallLimiter limiter, Logger logger)
        {
            _tmdb = tmdb;
            _limiter = limiter;
            _logger = logger;
        }

        private static string Key => JellyfinEnhanced.Instance?.Configuration?.GetTmdbApiKey()?.Trim() ?? string.Empty;

        /// <inheritdoc />
        public bool IsConfigured => Key.Length > 0;

        /// <inheritdoc />
        public string Provider => "tmdb";

        /// <inheritdoc />
        public bool CanFindImdbEpisodes => IsConfigured;

        /// <inheritdoc />
        public async Task<LookupResult<IReadOnlyList<TitleHit>>> SearchAsync(string query, ImportCallContext context, CancellationToken cancellationToken)
        {
            var normalized = string.Join(' ', (query ?? string.Empty).Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
            if (normalized.Length == 0)
            {
                return new LookupResult<IReadOnlyList<TitleHit>>(LookupStatus.Ok, System.Array.Empty<TitleHit>());
            }

            var lower = normalized.ToLowerInvariant();
            var (status, value) = await CachedAsync("search|" + lower, context, () => SearchUpstreamAsync(normalized, cancellationToken), cancellationToken).ConfigureAwait(false);
            return new LookupResult<IReadOnlyList<TitleHit>>(status, status == LookupStatus.Ok ? (IReadOnlyList<TitleHit>)value! : null);
        }

        /// <inheritdoc />
        public async Task<LookupResult<TitleDetails>> GetDetailsAsync(string mediaType, int tmdbId, ImportCallContext context, CancellationToken cancellationToken)
        {
            if (mediaType is not ("movie" or "tv") || tmdbId <= 0)
            {
                return LookupResult<TitleDetails>.NotFound;
            }

            var id = tmdbId.ToString(CultureInfo.InvariantCulture);
            var (status, value) = await CachedAsync("details|" + mediaType + "|" + id, context, async () =>
            {
                var (code, json) = await GetJsonAsync(mediaType + "/" + id, "?append_to_response=external_ids", cancellationToken).ConfigureAwait(false);
                return code == LookupStatus.Ok ? Parse(json!, root => ParseDetails(root, mediaType)) : (code, null);
            }, cancellationToken).ConfigureAwait(false);
            return new LookupResult<TitleDetails>(status, status == LookupStatus.Ok ? (TitleDetails)value! : null);
        }

        /// <inheritdoc />
        public async Task<LookupResult<IReadOnlyList<EpisodeFacts>>> GetSeasonAsync(int tvTmdbId, int season, ImportCallContext context, CancellationToken cancellationToken)
        {
            if (tvTmdbId <= 0 || season < 0)
            {
                return LookupResult<IReadOnlyList<EpisodeFacts>>.NotFound;
            }

            var path = "tv/" + tvTmdbId.ToString(CultureInfo.InvariantCulture) + "/season/" + season.ToString(CultureInfo.InvariantCulture);
            var (status, value) = await CachedAsync("season|" + path, context, async () =>
            {
                var (code, json) = await GetJsonAsync(path, string.Empty, cancellationToken).ConfigureAwait(false);
                return code == LookupStatus.Ok ? Parse(json!, root => (object?)ParseSeason(root, season)) : (code, null);
            }, cancellationToken).ConfigureAwait(false);
            return new LookupResult<IReadOnlyList<EpisodeFacts>>(status, status == LookupStatus.Ok ? (IReadOnlyList<EpisodeFacts>)value! : null);
        }

        /// <inheritdoc />
        public async Task<LookupResult<ImdbEpisodeFind>> FindImdbEpisodeAsync(string imdbId, ImportCallContext context, CancellationToken cancellationToken)
        {
            if (!IsConfigured || !ImdbRegex.IsMatch(imdbId ?? string.Empty))
            {
                return LookupResult<ImdbEpisodeFind>.NotFound;
            }

            // Review round 5: through the shared limiter and the cache like every other lookup (it had neither).
            var (status, value) = await CachedAsync("episode|" + imdbId, context, async () =>
            {
                var (code, json) = await GetJsonAsync("find/" + imdbId, "?external_source=imdb_id", cancellationToken).ConfigureAwait(false);
                return code == LookupStatus.Ok ? FindEpisode(json!) : (code, null);
            }, cancellationToken).ConfigureAwait(false);
            return new LookupResult<ImdbEpisodeFind>(status, status == LookupStatus.Ok ? (ImdbEpisodeFind)value! : null);
        }

        // The first usable episode of a TMDB find answer (NotFound: none).
        private static (LookupStatus, object?) FindEpisode(string json)
        {
            using var doc = JsonDocument.Parse(json);
            foreach (var episode in Array(doc.RootElement, "tv_episode_results"))
            {
                var show = Int(episode, "show_id");
                var s = Int(episode, "season_number");
                var e = Int(episode, "episode_number");
                if (show > 0 && s >= 0 && e >= 0)
                {
                    return (LookupStatus.Ok, new ImdbEpisodeFind(show!.Value, s!.Value, e!.Value, Str(episode, "name", 200), Date(episode, "air_date")));
                }
            }

            return (LookupStatus.NotFound, null);
        }

        // ── Search forms ─────────────────────────────────────────────────────

        private async Task<(LookupStatus, object?)> SearchUpstreamAsync(string query, CancellationToken cancellationToken)
        {
            var hits = new List<TitleHit>();
            if (query.StartsWith("tmdb:", StringComparison.OrdinalIgnoreCase))
            {
                if (!int.TryParse(query.AsSpan(5), NumberStyles.None, CultureInfo.InvariantCulture, out var id) || id <= 0)
                {
                    return (LookupStatus.Ok, hits);
                }

                // A bare TMDB id names a movie or a show: both answer (Seerr's tmdb: search does the same).
                foreach (var type in new[] { "movie", "tv" })
                {
                    var (code, json) = await GetJsonAsync(type + "/" + id.ToString(CultureInfo.InvariantCulture), string.Empty, cancellationToken).ConfigureAwait(false);
                    if (code == LookupStatus.Transient)
                    {
                        return (code, null);
                    }

                    if (code == LookupStatus.Ok && Parse(json!, root => ReadHit(root, type)).Item2 is TitleHit hit)
                    {
                        hits.Add(hit);
                    }
                }

                return (LookupStatus.Ok, hits);
            }

            if (query.StartsWith("imdb:", StringComparison.OrdinalIgnoreCase) || query.StartsWith("tvdb:", StringComparison.OrdinalIgnoreCase))
            {
                var id = query[5..].Trim();
                var imdb = query.StartsWith("imdb:", StringComparison.OrdinalIgnoreCase);
                if (imdb ? !ImdbRegex.IsMatch(id) : !int.TryParse(id, NumberStyles.None, CultureInfo.InvariantCulture, out _))
                {
                    return (LookupStatus.Ok, hits);
                }

                var (code, json) = await GetJsonAsync("find/" + id, imdb ? "?external_source=imdb_id" : "?external_source=tvdb_id", cancellationToken).ConfigureAwait(false);
                if (code != LookupStatus.Ok)
                {
                    return code == LookupStatus.NotFound ? (LookupStatus.Ok, hits) : (code, null);
                }

                using var doc = JsonDocument.Parse(json!);
                hits.AddRange(Array(doc.RootElement, "movie_results").Select(r => ReadHit(r, "movie")).OfType<TitleHit>());
                hits.AddRange(Array(doc.RootElement, "tv_results").Select(r => ReadHit(r, "tv")).OfType<TitleHit>());
                return (LookupStatus.Ok, hits);
            }

            var year = YearSuffix.Match(query);
            if (year.Success)
            {
                var title = Uri.EscapeDataString(year.Groups["title"].Value);
                var y = year.Groups["year"].Value;
                foreach (var (type, param) in new[] { ("movie", "year"), ("tv", "first_air_date_year") })
                {
                    var (code, json) = await GetJsonAsync("search/" + type, "?query=" + title + "&" + param + "=" + y + "&include_adult=false&page=1", cancellationToken).ConfigureAwait(false);
                    if (code != LookupStatus.Ok)
                    {
                        return (LookupStatus.Transient, null);
                    }

                    using var doc = JsonDocument.Parse(json!);
                    if (!doc.RootElement.TryGetProperty("results", out var results) || results.ValueKind != JsonValueKind.Array)
                    {
                        return (LookupStatus.Transient, null);
                    }

                    hits.AddRange(results.EnumerateArray().Select(r => ReadHit(r, type)).OfType<TitleHit>());
                }

                return (LookupStatus.Ok, hits);
            }

            var (multiCode, multi) = await GetJsonAsync("search/multi", "?query=" + Uri.EscapeDataString(query) + "&include_adult=false&page=1", cancellationToken).ConfigureAwait(false);
            if (multiCode != LookupStatus.Ok)
            {
                return (LookupStatus.Transient, null);
            }

            using (var doc = JsonDocument.Parse(multi!))
            {
                if (!doc.RootElement.TryGetProperty("results", out var results) || results.ValueKind != JsonValueKind.Array)
                {
                    return (LookupStatus.Transient, null); // an answer without its list is an error, never "no titles"
                }

                hits.AddRange(results.EnumerateArray().Select(r => ReadHit(r, Str(r, "media_type", 10))).OfType<TitleHit>());
            }

            return (LookupStatus.Ok, hits);
        }

        // ── Plumbing ─────────────────────────────────────────────────────────

        private async Task<(LookupStatus Status, object? Value)> CachedAsync(string cacheKey, ImportCallContext context, Func<Task<(LookupStatus, object?)>> fetch, CancellationToken cancellationToken)
        {
            var key = Fingerprint(Key) + "|" + cacheKey;
            if (!IsConfigured)
            {
                return (LookupStatus.Transient, null);
            }

            // A definitive answer is reused with its status, and without waiting for the limiter (review round 5, 4c2-R5-4:
            // a budgeted review that met the same stale ids again re-spent its budget on them and never got further).
            if (_cache.TryGetValue(key, out var cached) && cached.ExpiresUtc > DateTime.UtcNow)
            {
                return (cached.Status, cached.Value);
            }

            context.CountCall();
            (LookupStatus Status, object? Value) result;
            using (await _limiter.AcquireAsync(context.Owner, context.Background, cancellationToken).ConfigureAwait(false))
            {
                try
                {
                    result = await fetch().ConfigureAwait(false);
                }
                catch (JsonException ex)
                {
                    _logger.Debug($"[Lists] TMDB lookup {cacheKey} unreadable: {ex.Message}");
                    result = (LookupStatus.Transient, null);
                }
            }

            if ((result.Status == LookupStatus.Ok && result.Value != null) || result.Status == LookupStatus.NotFound)
            {
                Remember(key, result.Status, result.Value);
            }

            return result;
        }

        private async Task<(LookupStatus Status, string? Json)> GetJsonAsync(string path, string query, CancellationToken cancellationToken)
        {
            var key = Key;
            if (key.Length == 0)
            {
                return (LookupStatus.Transient, null);
            }

            try
            {
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                timeout.CancelAfter(CallTimeout);
                var response = await _tmdb.GetAsync(path, query, key, timeout.Token).ConfigureAwait(false);
                if (response.IsSuccess)
                {
                    return (LookupStatus.Ok, response.Content);
                }

                if (response.StatusCode != 404)
                {
                    _logger.Debug($"[Lists] TMDB lookup {path} answered {response.StatusCode.ToString(CultureInfo.InvariantCulture)}");
                }

                return (response.StatusCode == 404 ? LookupStatus.NotFound : LookupStatus.Transient, null);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                return (LookupStatus.Transient, null);
            }
            catch (System.Net.Http.HttpRequestException ex)
            {
                _logger.Debug($"[Lists] TMDB lookup {path} failed: {ex.Message}");
                return (LookupStatus.Transient, null);
            }
        }

        private static (LookupStatus, object?) Parse(string json, Func<JsonElement, object?> parse)
        {
            using var doc = JsonDocument.Parse(json);
            var value = parse(doc.RootElement);
            return value == null ? (LookupStatus.Transient, null) : (LookupStatus.Ok, value);
        }

        private void Remember(string key, LookupStatus status, object? value)
        {
            if (_cache.Count >= MaxCacheEntries)
            {
                var now = DateTime.UtcNow;
                foreach (var entry in _cache.Where(e => e.Value.ExpiresUtc <= now).Select(e => e.Key).ToList())
                {
                    _cache.TryRemove(entry, out _);
                }

                if (_cache.Count >= MaxCacheEntries)
                {
                    foreach (var entry in _cache.OrderBy(e => e.Value.ExpiresUtc).Take(MaxCacheEntries / 5).Select(e => e.Key).ToList())
                    {
                        _cache.TryRemove(entry, out _);
                    }
                }
            }

            _cache[key] = (DateTime.UtcNow + CacheTtl, status, value);
        }

        // Key identity (a hash, never the key or its length): another key never reuses this one's answers.
        private static string Fingerprint(string key) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(key)), 0, 8);

        // ── TMDB shapes (snake_case) ─────────────────────────────────────────

        private static TitleDetails? ParseDetails(JsonElement root, string mediaType)
        {
            var hit = ReadHit(root, mediaType);
            if (hit == null)
            {
                return null;
            }

            var imdb = Str(root, "imdb_id", 12);
            int? tvdb = null;
            if (root.TryGetProperty("external_ids", out var external) && external.ValueKind == JsonValueKind.Object)
            {
                imdb ??= Str(external, "imdb_id", 12);
                tvdb = Int(external, "tvdb_id");
            }

            if (imdb != null && !ImdbRegex.IsMatch(imdb))
            {
                imdb = null;
            }

            var seasons = new List<SeasonFacts>();
            if (mediaType == "tv")
            {
                foreach (var season in Array(root, "seasons"))
                {
                    var number = Int(season, "season_number");
                    if (number is >= 0 and <= 500)
                    {
                        seasons.Add(new SeasonFacts(number.Value, Int(season, "episode_count"), Date(season, "air_date"), Str(season, "name", 100)));
                    }
                }
            }

            bool? inProduction = root.TryGetProperty("in_production", out var prod) && prod.ValueKind is JsonValueKind.True or JsonValueKind.False ? prod.GetBoolean() : null;
            return new TitleDetails(hit, imdb, tvdb is > 0 ? tvdb : null, Str(root, "status", 40), inProduction, seasons);
        }

        private static IReadOnlyList<EpisodeFacts>? ParseSeason(JsonElement root, int season)
        {
            if (!root.TryGetProperty("episodes", out var episodes) || episodes.ValueKind != JsonValueKind.Array)
            {
                return null;
            }

            var list = new List<EpisodeFacts>();
            foreach (var episode in episodes.EnumerateArray())
            {
                var number = Int(episode, "episode_number");
                if (number is >= 0)
                {
                    list.Add(new EpisodeFacts(Int(episode, "season_number") ?? season, number.Value, Str(episode, "name", 200), Date(episode, "air_date")));
                }
            }

            return list;
        }

        private static TitleHit? ReadHit(JsonElement element, string? mediaType)
        {
            if (mediaType is not ("movie" or "tv") || element.ValueKind != JsonValueKind.Object)
            {
                return null;
            }

            if (element.TryGetProperty("adult", out var adult) && adult.ValueKind == JsonValueKind.True)
            {
                return null;
            }

            var id = Int(element, "id");
            var title = mediaType == "movie" ? Str(element, "title", 200) : Str(element, "name", 200);
            if (id is not > 0 || string.IsNullOrWhiteSpace(title))
            {
                return null;
            }

            var original = mediaType == "movie" ? Str(element, "original_title", 200) : Str(element, "original_name", 200);
            var date = mediaType == "movie" ? Date(element, "release_date") : Date(element, "first_air_date");
            var poster = Str(element, "poster_path", 100);
            if (poster != null && !PosterRegex.IsMatch(poster))
            {
                poster = null;
            }

            var popularity = element.TryGetProperty("popularity", out var pop) && pop.ValueKind == JsonValueKind.Number && pop.TryGetDouble(out var p) ? p : 0;
            var votes = Int(element, "vote_count") ?? 0;
            return new TitleHit(mediaType, id.Value, title.Trim(), original, date, poster, Str(element, "overview", MaxOverview), popularity, votes);
        }

        private static IEnumerable<JsonElement> Array(JsonElement element, string name) =>
            element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var array) && array.ValueKind == JsonValueKind.Array ? array.EnumerateArray() : Enumerable.Empty<JsonElement>();

        private static int? Int(JsonElement element, string name) =>
            element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out var result) ? result : null;

        private static string? Str(JsonElement element, string name, int max)
        {
            if (!element.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.String)
            {
                return null;
            }

            var text = ListRules.CleanText(value.GetString());
            if (text.Length == 0)
            {
                return null;
            }

            return text.Length > max ? text[..max] : text;
        }

        private static string? Date(JsonElement element, string name)
        {
            var value = Str(element, name, 10);
            return value != null && DateRegex.IsMatch(value) && ListRules.TryParseDate(value, out _) ? value : null;
        }
    }

    /// <summary>
    /// The import title lookup in use (the metadata adapter for imports): TMDB with Jellyfin Enhanced's key when one is
    /// saved (works without Seerr), otherwise Seerr when it is set up (the allowed, labelled fallback; responses name the
    /// provider). Decided per call from the configuration, never switched mid-call.
    /// </summary>
    public sealed class MetadataImportLookup : IImportLookup
    {
        private readonly TmdbImportLookup _tmdb;
        private readonly SeerrImportLookup _seerr;

        /// <summary>Creates the chooser (DI).</summary>
        /// <param name="tmdb">TMDB lookup.</param>
        /// <param name="seerr">Seerr lookup.</param>
        public MetadataImportLookup(TmdbImportLookup tmdb, SeerrImportLookup seerr)
        {
            _tmdb = tmdb;
            _seerr = seerr;
        }

        private IImportLookup Current => _tmdb.IsConfigured ? _tmdb : _seerr;

        /// <inheritdoc />
        public bool IsConfigured => _tmdb.IsConfigured || _seerr.IsConfigured;

        /// <inheritdoc />
        public string Provider => _tmdb.IsConfigured ? "tmdb" : _seerr.IsConfigured ? "seerr" : string.Empty;

        /// <inheritdoc />
        public bool CanFindImdbEpisodes => Current.CanFindImdbEpisodes;

        /// <inheritdoc />
        public Task<LookupResult<IReadOnlyList<TitleHit>>> SearchAsync(string query, ImportCallContext context, CancellationToken cancellationToken) =>
            Current.SearchAsync(query, context, cancellationToken);

        /// <inheritdoc />
        public Task<LookupResult<TitleDetails>> GetDetailsAsync(string mediaType, int tmdbId, ImportCallContext context, CancellationToken cancellationToken) =>
            Current.GetDetailsAsync(mediaType, tmdbId, context, cancellationToken);

        /// <inheritdoc />
        public Task<LookupResult<IReadOnlyList<EpisodeFacts>>> GetSeasonAsync(int tvTmdbId, int season, ImportCallContext context, CancellationToken cancellationToken) =>
            Current.GetSeasonAsync(tvTmdbId, season, context, cancellationToken);

        /// <inheritdoc />
        public Task<LookupResult<ImdbEpisodeFind>> FindImdbEpisodeAsync(string imdbId, ImportCallContext context, CancellationToken cancellationToken) =>
            Current.FindImdbEpisodeAsync(imdbId, context, cancellationToken);
    }
}
