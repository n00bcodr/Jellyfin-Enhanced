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
    /// and people are dropped; every upstream request is a <see cref="TmdbCall"/> (its own turn at the shared
    /// <see cref="MetadataCallLimiter"/>, a 15 s timeout); definitive answers (a whole, valid answer: found, or "not found":
    /// review rounds 5 and 6) are reused with their status for 30 minutes per key identity (a changed key never reuses
    /// another's answers), and a reused answer never waits for the limiter. TMDB's own errors, unreadable or malformed
    /// answers and answers with a row JE can't read are never remembered: "nothing found" needs a valid answer whose every
    /// row was read (review round 6, 4c2-R6-1); a 404 is "not found".
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
            var (status, value) = await CachedAsync("search|" + lower, context, call => SearchUpstreamAsync(normalized, call), cancellationToken).ConfigureAwait(false);
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
            var (status, value) = await CachedAsync("details|" + mediaType + "|" + id, context, call =>
                call.GetAsync(mediaType + "/" + id, "?append_to_response=external_ids", root => ParseDetails(root, mediaType) is { } details ? LookupAnswer.Ok(details) : LookupAnswer.Transient), cancellationToken).ConfigureAwait(false);
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
            var (status, value) = await CachedAsync("season|" + path, context, call =>
                call.GetAsync(path, string.Empty, root => ParseSeason(root, season) is { } episodes ? LookupAnswer.Ok(episodes) : LookupAnswer.Transient), cancellationToken).ConfigureAwait(false);
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
            var (status, value) = await CachedAsync("episode|" + imdbId, context, call =>
                call.GetAsync("find/" + imdbId, "?external_source=imdb_id", ReadEpisodeFind), cancellationToken).ConfigureAwait(false);
            return new LookupResult<ImdbEpisodeFind>(status, status == LookupStatus.Ok ? (ImdbEpisodeFind)value! : null);
        }

        /// <summary>
        /// TMDB's <c>find</c> answer for an IMDb EPISODE id (review round 6, 4c2-R6-1; both lookups read it here): the
        /// episode of its first usable row; NotFound only when <c>tv_episode_results</c> is a valid, empty list; Transient
        /// when the answer isn't an object, the list is missing or not a list, or holds only rows without coordinates.
        /// </summary>
        /// <param name="root">The answer.</param>
        /// <returns>The read answer.</returns>
        internal static LookupAnswer ReadEpisodeFind(JsonElement root)
        {
            if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("tv_episode_results", out var episodes) || episodes.ValueKind != JsonValueKind.Array)
            {
                return LookupAnswer.Transient;
            }

            ImdbEpisodeFind? found = null;
            var unusable = false;
            foreach (var episode in episodes.EnumerateArray())
            {
                var show = episode.ValueKind == JsonValueKind.Object ? Int(episode, "show_id") : null;
                var s = show == null ? null : Int(episode, "season_number");
                var e = show == null ? null : Int(episode, "episode_number");
                if (show > 0 && s >= 0 && e >= 0)
                {
                    found ??= new ImdbEpisodeFind(show!.Value, s!.Value, e!.Value, Str(episode, "name", 200), Date(episode, "air_date"));
                }
                else
                {
                    unusable = true;
                }
            }

            return found != null ? LookupAnswer.Ok(found, !unusable) : unusable ? LookupAnswer.Transient : LookupAnswer.NotFound;
        }

        // ── Search forms ─────────────────────────────────────────────────────

        // Each form's answer is the rows of every request it made (review round 6): a request that failed or answered
        // something that isn't a whole answer makes the search Transient; "no titles" needs every row read (a deliberate
        // drop, an adult title or a person, is read); titles found beside a row that couldn't be read are used, not kept.
        private static async Task<LookupAnswer> SearchUpstreamAsync(string query, TmdbCall call)
        {
            var rows = new HitRows();
            if (query.StartsWith("tmdb:", StringComparison.OrdinalIgnoreCase))
            {
                if (!int.TryParse(query.AsSpan(5), NumberStyles.None, CultureInfo.InvariantCulture, out var id) || id <= 0)
                {
                    return rows.Answer;
                }

                // A bare TMDB id names a movie or a show: both answer (Seerr's tmdb: search does the same), each request
                // with its own turn at the limiter (4c2-R6-4). A 404 is that type's proven "no such id".
                foreach (var type in new[] { "movie", "tv" })
                {
                    var leg = await call.GetAsync(type + "/" + id.ToString(CultureInfo.InvariantCulture), string.Empty, root => HitRows.Of(root, type)).ConfigureAwait(false);
                    if (leg.Status == LookupStatus.Transient)
                    {
                        return LookupAnswer.Transient;
                    }

                    rows.Merge(leg);
                }

                return rows.Answer;
            }

            if (query.StartsWith("imdb:", StringComparison.OrdinalIgnoreCase) || query.StartsWith("tvdb:", StringComparison.OrdinalIgnoreCase))
            {
                var id = query[5..].Trim();
                var imdb = query.StartsWith("imdb:", StringComparison.OrdinalIgnoreCase);
                if (imdb ? !ImdbRegex.IsMatch(id) : !int.TryParse(id, NumberStyles.None, CultureInfo.InvariantCulture, out _))
                {
                    return rows.Answer;
                }

                var found = await call.GetAsync("find/" + id, imdb ? "?external_source=imdb_id" : "?external_source=tvdb_id", root =>
                {
                    // Both result lists must be there, as lists: an answer without them is no proof of "no titles".
                    if (root.ValueKind != JsonValueKind.Object
                        || !root.TryGetProperty("movie_results", out var movies) || movies.ValueKind != JsonValueKind.Array
                        || !root.TryGetProperty("tv_results", out var shows) || shows.ValueKind != JsonValueKind.Array)
                    {
                        return LookupAnswer.Transient;
                    }

                    var read = new HitRows();
                    read.Read(movies, "movie");
                    read.Read(shows, "tv");
                    return read.Leg;
                }).ConfigureAwait(false);
                if (found.Status == LookupStatus.Transient)
                {
                    return found;
                }

                rows.Merge(found); // a 404 of find is "no titles"
                return rows.Answer;
            }

            var year = YearSuffix.Match(query);
            if (year.Success)
            {
                var title = Uri.EscapeDataString(year.Groups["title"].Value);
                var y = year.Groups["year"].Value;
                foreach (var (type, param) in new[] { ("movie", "year"), ("tv", "first_air_date_year") })
                {
                    var leg = await call.GetAsync("search/" + type, "?query=" + title + "&" + param + "=" + y + "&include_adult=false&page=1", root => HitRows.Results(root, type)).ConfigureAwait(false);
                    if (leg.Status != LookupStatus.Ok)
                    {
                        return LookupAnswer.Transient;
                    }

                    rows.Merge(leg);
                }

                return rows.Answer;
            }

            var multi = await call.GetAsync("search/multi", "?query=" + Uri.EscapeDataString(query) + "&include_adult=false&page=1", root => HitRows.Results(root, null)).ConfigureAwait(false);
            if (multi.Status != LookupStatus.Ok)
            {
                return LookupAnswer.Transient; // an answer without its list is an error, never "no titles"
            }

            rows.Merge(multi);
            return rows.Answer;
        }

        // The rows of one or more search answers (review round 6): the titles read, and how many rows couldn't be read.
        private sealed class HitRows
        {
            private readonly List<TitleHit> _hits = new();
            private int _unusable;

            // One answer's rows, kept by the response cache only when every row was read.
            public LookupAnswer Leg => LookupAnswer.Ok(this, _unusable == 0);

            // The search's answer: nothing found and a row unread is no proof of "no titles".
            public LookupAnswer Answer => _hits.Count == 0 && _unusable > 0 ? LookupAnswer.Transient : LookupAnswer.Ok(_hits, _unusable == 0);

            // A title's own answer (tmdb:N): the title, a deliberate drop, or a row that can't be read.
            public static LookupAnswer Of(JsonElement root, string type)
            {
                var rows = new HitRows();
                rows.Add(root, type);
                return rows.Leg;
            }

            // A search answer: its `results` must be a list (else Transient); `type` null reads each row's media_type.
            public static LookupAnswer Results(JsonElement root, string? type)
            {
                if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("results", out var results) || results.ValueKind != JsonValueKind.Array)
                {
                    return LookupAnswer.Transient;
                }

                var rows = new HitRows();
                rows.Read(results, type);
                return rows.Leg;
            }

            public void Read(JsonElement array, string? type)
            {
                foreach (var row in array.EnumerateArray())
                {
                    Add(row, type ?? MediaType(row));
                }
            }

            public void Merge(LookupAnswer leg)
            {
                if (leg.Value is HitRows other)
                {
                    _hits.AddRange(other._hits);
                    _unusable += other._unusable;
                }
            }

            private void Add(JsonElement row, string? type)
            {
                switch (ReadRow(row, type, out var hit))
                {
                    case RowRead.Hit:
                        _hits.Add(hit!);
                        break;
                    case RowRead.Unusable:
                        _unusable++;
                        break;
                }
            }

            // A multi-search row's declared type (null: missing or not a type, so the row can't be read).
            private static string? MediaType(JsonElement row) =>
                row.ValueKind == JsonValueKind.Object && row.TryGetProperty("media_type", out var type) && type.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(type.GetString())
                    ? type.GetString()
                    : null;
        }

        // ── Plumbing ─────────────────────────────────────────────────────────

        private async Task<(LookupStatus Status, object? Value)> CachedAsync(string cacheKey, ImportCallContext context, Func<TmdbCall, Task<LookupAnswer>> fetch, CancellationToken cancellationToken)
        {
            var apiKey = Key; // one key for the whole lookup: its cache identity and every request it sends
            if (apiKey.Length == 0)
            {
                return (LookupStatus.Transient, null);
            }

            // A definitive answer is reused with its status, and without waiting for the limiter (review round 5, 4c2-R5-4:
            // a budgeted review that met the same stale ids again re-spent its budget on them and never got further).
            var key = Fingerprint(apiKey) + "|" + cacheKey;
            if (_cache.TryGetValue(key, out var cached) && cached.ExpiresUtc > DateTime.UtcNow)
            {
                return (cached.Status, cached.Value);
            }

            var answer = await fetch(new TmdbCall(_tmdb, _limiter, _logger, context, apiKey, cancellationToken)).ConfigureAwait(false);
            if (answer.Remembered)
            {
                Remember(key, answer.Status, answer.Value);
            }

            return (answer.Status, answer.Value);
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

        // Null when the answer isn't a whole title (also a season row JE can't read: a season missing from the list would
        // be taken as "no such season").
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
                    var number = season.ValueKind == JsonValueKind.Object ? Int(season, "season_number") : null;
                    if (number is not >= 0)
                    {
                        return null;
                    }

                    if (number <= 500)
                    {
                        seasons.Add(new SeasonFacts(number.Value, Int(season, "episode_count"), Date(season, "air_date"), Str(season, "name", 100)));
                    }
                }
            }

            bool? inProduction = root.TryGetProperty("in_production", out var prod) && prod.ValueKind is JsonValueKind.True or JsonValueKind.False ? prod.GetBoolean() : null;
            return new TitleDetails(hit, imdb, tvdb is > 0 ? tvdb : null, Str(root, "status", 40), inProduction, seasons);
        }

        // Null when the answer has no episode list or an episode row JE can't read (an episode missing from the list would
        // be taken as "no such episode").
        private static IReadOnlyList<EpisodeFacts>? ParseSeason(JsonElement root, int season)
        {
            if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("episodes", out var episodes) || episodes.ValueKind != JsonValueKind.Array)
            {
                return null;
            }

            var list = new List<EpisodeFacts>();
            foreach (var episode in episodes.EnumerateArray())
            {
                var number = episode.ValueKind == JsonValueKind.Object ? Int(episode, "episode_number") : null;
                if (number is not >= 0)
                {
                    return null;
                }

                list.Add(new EpisodeFacts(Int(episode, "season_number") ?? season, number.Value, Str(episode, "name", 200), Date(episode, "air_date")));
            }

            return list;
        }

        // One row of a search or find answer: a title, a deliberate drop (an adult title, a person or another kind that
        // isn't a title), or a row that can't be read (not an object, no type, no id or no title).
        private static RowRead ReadRow(JsonElement element, string? mediaType, out TitleHit? hit)
        {
            hit = null;
            if (element.ValueKind != JsonValueKind.Object || mediaType == null)
            {
                return RowRead.Unusable;
            }

            if (mediaType is not ("movie" or "tv") || (element.TryGetProperty("adult", out var adult) && adult.ValueKind == JsonValueKind.True))
            {
                return RowRead.Dropped;
            }

            hit = ReadHit(element, mediaType);
            return hit == null ? RowRead.Unusable : RowRead.Hit;
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
    /// THE upstream TMDB request of the import lookups (review round 6, D53; <see cref="TmdbImportLookup"/> and the IMDb
    /// episode find of <see cref="SeerrImportLookup"/>). One request is one turn at the shared limiter, counted on the
    /// caller's context, so every search leg and fallback is paced like any other call (4c2-R6-4: two TMDB requests went
    /// out on one turn). An answer TMDB already gave (the response cache, filled by any feature) is used without a request
    /// or a turn when it reads as a whole answer; an answer that doesn't is dropped from the response cache, so the next
    /// read asks TMDB again instead of meeting the same malformed answer for the cache's TTL (4c2-R6-1).
    /// </summary>
    internal sealed class TmdbCall
    {
        private readonly TmdbResponseCache _tmdb;
        private readonly MetadataCallLimiter _limiter;
        private readonly Logger _logger;
        private readonly ImportCallContext _context;
        private readonly string _apiKey;
        private readonly CancellationToken _cancellationToken;

        /// <summary>Creates the call context of one lookup.</summary>
        /// <param name="tmdb">JE's TMDB response cache.</param>
        /// <param name="limiter">Shared metadata limiter.</param>
        /// <param name="logger">JE logger.</param>
        /// <param name="context">The caller (limiter owner and priority; counts the requests).</param>
        /// <param name="apiKey">The TMDB key every request of the lookup carries.</param>
        /// <param name="cancellationToken">Stops the caller waiting.</param>
        public TmdbCall(TmdbResponseCache tmdb, MetadataCallLimiter limiter, Logger logger, ImportCallContext context, string apiKey, CancellationToken cancellationToken)
        {
            _tmdb = tmdb;
            _limiter = limiter;
            _logger = logger;
            _context = context;
            _apiKey = apiKey;
            _cancellationToken = cancellationToken;
        }

        /// <summary>One TMDB read: a 404 is NotFound, an error Transient, and a successful answer is what <paramref name="read"/> makes of it.</summary>
        /// <param name="path">TMDB path.</param>
        /// <param name="query">"" or a query starting with '?', without the key.</param>
        /// <param name="read">Reads a successful answer (Transient when it isn't one).</param>
        /// <returns>The answer.</returns>
        public async Task<LookupAnswer> GetAsync(string path, string query, Func<JsonElement, LookupAnswer> read)
        {
            if (_tmdb.TryGetCached(path, query, _apiKey, out var cached))
            {
                var known = Read(cached, path, read);
                if (known.Definitive)
                {
                    return known;
                }

                _tmdb.Forget(path, query, _apiKey);
            }

            _context.CountCall();
            TmdbResponseCache.TmdbResponse response;
            using (await _limiter.AcquireAsync(_context.Owner, _context.Background, _cancellationToken).ConfigureAwait(false))
            {
                try
                {
                    using var timeout = CancellationTokenSource.CreateLinkedTokenSource(_cancellationToken);
                    timeout.CancelAfter(TmdbImportLookup.CallTimeout);
                    response = await _tmdb.GetAsync(path, query, _apiKey, timeout.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (!_cancellationToken.IsCancellationRequested)
                {
                    return LookupAnswer.Transient;
                }
                catch (System.Net.Http.HttpRequestException ex)
                {
                    _logger.Debug($"[Lists] TMDB lookup {path} failed: {ex.Message}");
                    return LookupAnswer.Transient;
                }
            }

            var answer = Read(response, path, read);
            if (!answer.Definitive && response.IsSuccess)
            {
                _tmdb.Forget(path, query, _apiKey);
            }

            return answer;
        }

        private LookupAnswer Read(TmdbResponseCache.TmdbResponse response, string path, Func<JsonElement, LookupAnswer> read)
        {
            if (response.IsSuccess)
            {
                try
                {
                    using var doc = JsonDocument.Parse(response.Content);
                    return read(doc.RootElement);
                }
                catch (JsonException ex)
                {
                    _logger.Debug($"[Lists] TMDB lookup {path} unreadable: {ex.Message}");
                    return LookupAnswer.Transient;
                }
            }

            if (response.StatusCode == 404)
            {
                return LookupAnswer.NotFound;
            }

            _logger.Debug($"[Lists] TMDB lookup {path} answered {response.StatusCode.ToString(CultureInfo.InvariantCulture)}");
            return LookupAnswer.Transient;
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
