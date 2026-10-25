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
    /// <see cref="MetadataCallLimiter"/>, held until the request has ended); every answer is read by its resource's
    /// contract (<see cref="ResponseContract"/>, review round 7): Valid answers (found, or "not found": review rounds 5 and 6)
    /// are reused with their status for 30 minutes per key identity (a changed key never reuses another's answers), and a
    /// reused answer never waits for the limiter. Partial answers are used but never kept and never prove an absence;
    /// TMDB's own errors and Malformed answers are transient: "nothing found" needs a Valid answer whose every row was read
    /// (review round 6, 4c2-R6-1); a 404 is "not found".
    /// </summary>
    public sealed class TmdbImportLookup : IImportLookup
    {
        /// <summary>How long a definitive answer (found or not found) is reused.</summary>
        public static readonly TimeSpan CacheTtl = TimeSpan.FromMinutes(30);

        /// <summary>
        /// How long a caller waits for its request (review round 7, 4c2-R7-5: aligned with the TMDB cache's own upstream
        /// timeout, so a caller never gives up on a request that is still running; giving up releases nothing either way).
        /// </summary>
        public static readonly TimeSpan CallTimeout = TmdbResponseCache.UpstreamTimeout + TimeSpan.FromSeconds(2);

        private const int MaxCacheEntries = 5000;
        private static readonly Regex ImdbRegex = new("^tt[0-9]{5,10}$", RegexOptions.Compiled | RegexOptions.CultureInvariant);
        private static readonly Regex YearSuffix = new("^(?<title>.+?)\\s+year:(?<year>\\d{4})$", RegexOptions.Compiled | RegexOptions.CultureInvariant);

        private readonly TmdbResponseCache _tmdb;
        private readonly MetadataCallLimiter _limiter;
        private readonly Logger _logger;
        private ConcurrentDictionary<string, (DateTime ExpiresUtc, LookupStatus Status, object? Value)> _cache = new(StringComparer.Ordinal);
        private readonly global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.State<ConcurrentDictionary<string, (DateTime ExpiresUtc, LookupStatus Status, object? Value)>> _cacheFactsOwner = new();
        private ConcurrentDictionary<string, (DateTime ExpiresUtc, LookupStatus Status, object? Value)> _cacheFacts { get => _cacheFactsOwner.Read(ref _cache, () => new(StringComparer.Ordinal)); }


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
            var epoch = ListMetadataEpoch.Capture();
            var normalized = string.Join(' ', (query ?? string.Empty).Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));
            if (normalized.Length == 0)
            {
                return new LookupResult<IReadOnlyList<TitleHit>>(LookupStatus.Ok, System.Array.Empty<TitleHit>());
            }

            var lower = normalized.ToLowerInvariant();
            var answer = await CachedAsync("search|" + lower, context, call => SearchUpstreamAsync(normalized, call), cancellationToken).ConfigureAwait(false);
            return epoch.Publish(() => answer.Result<IReadOnlyList<TitleHit>>(), () => LookupResult<IReadOnlyList<TitleHit>>.Transient);
        }

        /// <inheritdoc />
        public async Task<LookupResult<TitleDetails>> GetDetailsAsync(string mediaType, int tmdbId, ImportCallContext context, CancellationToken cancellationToken)
        {
            var epoch = ListMetadataEpoch.Capture();
            if (mediaType is not ("movie" or "tv") || tmdbId <= 0)
            {
                return LookupResult<TitleDetails>.NotFound;
            }

            var id = tmdbId.ToString(CultureInfo.InvariantCulture);
            var answer = await CachedAsync("details|" + mediaType + "|" + id, context, call =>
                call.GetAsync(mediaType + "/" + id, "?append_to_response=external_ids", root => ParseDetails(root, mediaType, tmdbId)), cancellationToken).ConfigureAwait(false);
            return epoch.Publish(() => answer.Result<TitleDetails>(), () => LookupResult<TitleDetails>.Transient);
        }

        /// <inheritdoc />
        public async Task<LookupResult<IReadOnlyList<EpisodeFacts>>> GetSeasonAsync(int tvTmdbId, int season, ImportCallContext context, CancellationToken cancellationToken)
        {
            var epoch = ListMetadataEpoch.Capture();
            if (tvTmdbId <= 0 || season < 0)
            {
                return LookupResult<IReadOnlyList<EpisodeFacts>>.NotFound;
            }

            var path = "tv/" + tvTmdbId.ToString(CultureInfo.InvariantCulture) + "/season/" + season.ToString(CultureInfo.InvariantCulture);
            var answer = await CachedAsync("season|" + path, context, call =>
                call.GetAsync(path, string.Empty, root => ParseSeason(root, tvTmdbId, season)), cancellationToken).ConfigureAwait(false);
            return epoch.Publish(() => answer.Result<IReadOnlyList<EpisodeFacts>>(), () => LookupResult<IReadOnlyList<EpisodeFacts>>.Transient);
        }

        /// <inheritdoc />
        public async Task<LookupResult<ImdbEpisodeFind>> FindImdbEpisodeAsync(string imdbId, ImportCallContext context, CancellationToken cancellationToken)
        {
            var epoch = ListMetadataEpoch.Capture();
            if (!IsConfigured || !ImdbRegex.IsMatch(imdbId ?? string.Empty))
            {
                return LookupResult<ImdbEpisodeFind>.NotFound;
            }

            // Review round 5: through the shared limiter and the cache like every other lookup (it had neither).
            var answer = await CachedAsync("episode|" + imdbId, context, call =>
                call.GetAsync("find/" + imdbId, "?external_source=imdb_id", ReadEpisodeFind), cancellationToken).ConfigureAwait(false);
            return epoch.Publish(() => answer.Result<ImdbEpisodeFind>(), () => LookupResult<ImdbEpisodeFind>.Transient);
        }

        /// <summary>
        /// TMDB's <c>find</c> answer for an IMDb EPISODE id (review round 6, 4c2-R6-1; both lookups read it here), by its
        /// contract (<see cref="ResponseContract.TmdbEpisodeFind"/>, review round 7): the episode of its first usable row;
        /// NotFound only when <c>tv_episode_results</c> is a valid, empty list; Transient when the answer is Malformed (not
        /// an object, the list missing or not a list, or only rows without coordinates); Partial (used, never kept) when a
        /// row couldn't be read beside a usable one or a row's display field is unreadable.
        /// </summary>
        /// <param name="root">The answer.</param>
        /// <returns>The read answer.</returns>
        internal static LookupAnswer ReadEpisodeFind(JsonElement root)
        {
            var read = ResponseContract.TmdbEpisodeFind.Read(root);
            if (read.Verdict == ResponseVerdict.Malformed)
            {
                return LookupAnswer.Transient;
            }

            // The contract's usable rows (each has its show, season and episode: required) as typed values (review round 8).
            var episode = read.Rows("tv_episode_results").FirstOrDefault();
            return episode == null
                ? LookupAnswer.NotFound // a Valid, empty list
                : LookupAnswer.Ok(new ImdbEpisodeFind(episode.Int("show_id")!.Value, episode.Int("season_number")!.Value, episode.Int("episode_number")!.Value, TypedTitles.Clip(episode.Text("name"), 200), episode.Date("air_date")), read.Verdict);
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
                    var leg = await call.GetAsync(type + "/" + id.ToString(CultureInfo.InvariantCulture), string.Empty, root => HitRows.Of(root, type, new AnswerRequest(id, type))).ConfigureAwait(false);
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
                    // Both result lists must be there, as lists (ResponseContract.TmdbFind): an answer without them is no
                    // proof of "no titles".
                    if (ResponseContract.TmdbFind.Read(root).Verdict == ResponseVerdict.Malformed)
                    {
                        return LookupAnswer.Transient;
                    }

                    var read = new HitRows();
                    read.Read(root.GetProperty("movie_results"), "movie");
                    read.Read(root.GetProperty("tv_results"), "tv");
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

        // The rows of one or more search answers (review rounds 6 and 7): the titles read, how many rows couldn't be read,
        // and the worst verdict of the rows read (a row's unreadable display field makes the answer Partial).
        private sealed class HitRows
        {
            private readonly List<TitleHit> _hits = new();
            private int _unusable;
            private ResponseVerdict _rows = ResponseVerdict.Valid;

            private ResponseVerdict Verdict => _unusable > 0 ? ResponseVerdict.Partial : _rows;

            // One answer's rows, kept by the response cache only when the answer is Valid.
            public LookupAnswer Leg => new(LookupStatus.Ok, this, Verdict);

            // The search's answer: nothing found is "no titles" only from a Valid answer (review round 10, 4c2-R10-5: absence is a
            // positive fact; a row unread, or an empty page whose total says otherwise, proves nothing).
            public LookupAnswer Answer => _hits.Count == 0 && Verdict != ResponseVerdict.Valid ? LookupAnswer.Transient : LookupAnswer.Ok(_hits, Verdict);

            // A title's own answer (tmdb:N): the title asked for (review round 9: another id is a row JE can't read), a
            // deliberate drop, or a row that can't be read.
            public static LookupAnswer Of(JsonElement root, string type, AnswerRequest request)
            {
                var rows = new HitRows();
                rows.Add(root, type, request);
                return rows.Leg;
            }

            // A search answer: its `results` must be a list (ResponseContract.TmdbSearch, else Transient) and its paging
            // fields within their domain (review round 9: else Partial); `type` null reads each row's media_type.
            public static LookupAnswer Results(JsonElement root, string? type)
            {
                var page = ResponseContract.TmdbSearch.Validate(new AnswerRequest(Page: 1), root);
                if (page.Verdict == ResponseVerdict.Malformed)
                {
                    return LookupAnswer.Transient;
                }

                var rows = new HitRows { _rows = page.Verdict };
                rows.Read(root.GetProperty("results"), type);
                return rows.Leg;
            }

            public void Read(JsonElement array, string? type)
            {
                foreach (var row in array.EnumerateArray())
                {
                    Add(row, type ?? MediaType(row), AnswerRequest.None);
                }
            }

            public void Merge(LookupAnswer leg)
            {
                if (leg.Value is HitRows other)
                {
                    _hits.AddRange(other._hits);
                    _unusable += other._unusable;
                    _rows = ResponseContract.Worst(_rows, other._rows);
                }
            }

            private void Add(JsonElement row, string? type, AnswerRequest request)
            {
                switch (ReadRow(row, type, request, out var hit, out var verdict))
                {
                    case RowRead.Hit:
                        _hits.Add(hit!);
                        _rows = ResponseContract.Worst(_rows, verdict);
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

        private async Task<LookupAnswer> CachedAsync(string cacheKey, ImportCallContext context, Func<TmdbCall, Task<LookupAnswer>> fetch, CancellationToken cancellationToken)
        {
            var epoch = ListMetadataEpoch.Capture();
            var apiKey = Key; // one key for the whole lookup: its cache identity and every request it sends
            if (apiKey.Length == 0)
            {
                return LookupAnswer.Transient;
            }

            // A definitive answer is reused with its status, and without waiting for the limiter (review round 5, 4c2-R5-4:
            // a budgeted review that met the same stale ids again re-spent its budget on them and never got further).
            var key = Fingerprint(apiKey) + "|" + cacheKey + "|" + epoch.Generation;
            if (_cacheFacts.TryGetValue(key, out var cached) && cached.ExpiresUtc > DateTime.UtcNow)
            {
                return epoch.Publish(() => new LookupAnswer(cached.Status, cached.Value, ResponseVerdict.Valid), () => LookupAnswer.Transient);
            }

            var answer = await fetch(new TmdbCall(_tmdb, _limiter, _logger, context, apiKey, cancellationToken)).ConfigureAwait(false);
            return epoch.Publish(() =>
            {
                if (answer.Remembered) Remember(key, answer.Status, answer.Value);
                return answer;
            }, () => LookupAnswer.Transient);
        }

        private void Remember(string key, LookupStatus status, object? value)
        {
            if (_cacheFacts.Count >= MaxCacheEntries)
            {
                var now = DateTime.UtcNow;
                foreach (var entry in _cacheFacts.Where(e => e.Value.ExpiresUtc <= now).Select(e => e.Key).ToList())
                {
                    _cacheFacts.TryRemove(entry, out _);
                }

                if (_cacheFacts.Count >= MaxCacheEntries)
                {
                    foreach (var entry in _cacheFacts.OrderBy(e => e.Value.ExpiresUtc).Take(MaxCacheEntries / 5).Select(e => e.Key).ToList())
                    {
                        _cacheFacts.TryRemove(entry, out _);
                    }
                }
            }

            _cacheFacts[key] = (DateTime.UtcNow + CacheTtl, status, value);
        }

        // Key identity (a hash, never the key or its length): another key never reuses this one's answers.
        private static string Fingerprint(string key) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(key)), 0, 8);

        // ── TMDB shapes (snake_case) ─────────────────────────────────────────

        // Movie or TV details by their contract (ResponseContract.TmdbMovieDetails / TmdbTvDetails, review round 7):
        // Malformed is transient (a season row JE can't read too: a season missing from the list would be taken as "no such
        // season"); Partial details (an external id or the season list unknown, or a field JE can't use: review round 8) are
        // used, never kept, and never prove an id absent or a season missing (4c2-R7-1/2). Typed values only (review round 8).
        // Review round 9 (4c2-R9-1): the details of the title asked for (its id), else Malformed.
        private static LookupAnswer ParseDetails(JsonElement root, string mediaType, int tmdbId)
        {
            var read = (mediaType == "movie" ? ResponseContract.TmdbMovieDetails : ResponseContract.TmdbTvDetails).Validate(new AnswerRequest(tmdbId, mediaType), root);
            return read.Verdict == ResponseVerdict.Malformed ? LookupAnswer.Transient : TypedTitles.Details(read, mediaType, camel: false);
        }

        // A season by its contract (ResponseContract.TmdbSeason): an episode row JE can't read makes it Malformed (an
        // episode missing from the list would be taken as "no such episode").
        // Review round 9 (4c2-R9-2): every episode of the season (and show) asked for, each listed once.
        private static LookupAnswer ParseSeason(JsonElement root, int show, int season)
        {
            var read = ResponseContract.TmdbSeason.Validate(new AnswerRequest(Season: season, Show: show), root);
            return read.Verdict == ResponseVerdict.Malformed ? LookupAnswer.Transient : LookupAnswer.Ok(TypedTitles.Episodes(read, season, camel: false), read.Verdict);
        }

        // One row of a search or find answer: a title, a deliberate drop (an adult title, a person or another kind that
        // isn't a title), or a row that can't be read (not an object, no type, or not a title row by its contract).
        // Review round 9 (4c2-R9-6): the declared type by a closed allowlist (an unknown one is a row JE can't read, never a
        // deliberate drop), and a title's own answer is the one asked for.
        private static RowRead ReadRow(JsonElement element, string? mediaType, AnswerRequest request, out TitleHit? hit, out ResponseVerdict verdict)
        {
            hit = null;
            verdict = ResponseVerdict.Valid;
            if (element.ValueKind != JsonValueKind.Object || mediaType == null)
            {
                return RowRead.Unusable;
            }

            if (TitleTypes.Classify(mediaType, TitleTypes.TmdbExcluded) is { } unkeyed)
            {
                return unkeyed;
            }

            if (element.TryGetProperty("adult", out var adult) && adult.ValueKind == JsonValueKind.True)
            {
                return RowRead.Dropped;
            }

            var read = (mediaType == "movie" ? ResponseContract.TmdbMovieRow : ResponseContract.TmdbTvRow).Validate(request, element);
            verdict = read.Verdict;
            hit = verdict == ResponseVerdict.Malformed ? null : TypedTitles.Hit(read, mediaType, camel: false);
            return hit == null ? RowRead.Unusable : RowRead.Hit;
        }
    }

    /// <summary>
    /// THE upstream TMDB request of the import lookups (review round 6, D53; <see cref="TmdbImportLookup"/> and the IMDb
    /// episode find of <see cref="SeerrImportLookup"/>). One request is one turn at the shared limiter, counted on the
    /// caller's context, so every search leg and fallback is paced like any other call (4c2-R6-4: two TMDB requests went
    /// out on one turn). The turn belongs to the request (review round 7, 4c2-R7-5): it is held until the upstream call has
    /// ended, whoever still waits for it; a caller that gives up (its cancellation, or its wait timing out) releases
    /// nothing, and a caller that joins an answer TMDB already gave or a call already in flight takes no turn
    /// (<see cref="TmdbResponseCache.GetAdmittedAsync"/>). A cached answer that doesn't read as Valid is dropped from the
    /// response cache, so the next read asks TMDB again instead of meeting the same malformed answer for the cache's TTL
    /// (4c2-R6-1). Failures are logged as bounded codes only (4c2-R7-6).
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
        /// <param name="read">Reads a successful answer by its resource's contract (Transient when it is Malformed).</param>
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

            TmdbResponseCache.TmdbResponse response;
            try
            {
                using var wait = CancellationTokenSource.CreateLinkedTokenSource(_cancellationToken);
                wait.CancelAfter(TmdbImportLookup.CallTimeout);
                response = await _tmdb.GetAdmittedAsync(path, query, _apiKey, async token =>
                {
                    var lease = await _limiter.AcquireAsync(_context.Owner, _context.Background, token).ConfigureAwait(false);
                    _context.CountCall(); // admitted: a real request of this caller
                    return lease;
                }, wait.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (_cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex) when (ex is not OutOfMemoryException)
            {
                // The upstream call failed or timed out (any failure: a handler's own exception too).
                _logger.Debug($"[Lists] TMDB lookup {path} failed: {UpstreamDiagnostics.Code(ex)}");
                return LookupAnswer.Transient;
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
                catch (Exception ex) when (ex is JsonException or InvalidOperationException or KeyNotFoundException)
                {
                    _logger.Debug($"[Lists] TMDB lookup {path} unreadable: {UpstreamDiagnostics.Code(ex)}");
                    return LookupAnswer.Transient;
                }
            }

            // Review round 10 (ProviderAbsence.Tmdb): "no such id" only from TMDB's own 404 (its error object), never a proxy's.
            if (ProviderAbsence.Tmdb(response.StatusCode, response.Content))
            {
                return LookupAnswer.NotFound;
            }

            _logger.Debug($"[Lists] TMDB lookup {path} answered {response.StatusCode.ToString(CultureInfo.InvariantCulture)}");
            return LookupAnswer.Transient;
        }
    }

    /// <summary>
    /// The import title lookup in use (the metadata adapter for imports): TMDB with Jellyfin Enhanced's key when one is
    /// saved (works without Seerr), otherwise Seerr only outside JE mode when it is set up (the allowed, labelled fallback; responses name the
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

        private IImportLookup Current => SeerrAddresses.IsJe(JellyfinEnhanced.Instance?.Configuration) || _tmdb.IsConfigured ? _tmdb : _seerr;

        /// <inheritdoc />
        public bool IsConfigured => Current.IsConfigured;

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
