using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails
{
    /// <summary>
    /// The native details source in Jellyfin Enhanced request mode (Requests &amp; downloads, A1): TMDB
    /// through Jellyfin Enhanced's own key and the shared TMDB cache, answered in Seerr's shape
    /// (<see cref="TmdbNativeShape"/>) so every reader is unchanged. It never contacts Seerr. A series or
    /// movie TMDB doesn't link to TVDB or IMDb gets those ids from the arr libraries and the library
    /// (<see cref="TitleAliases"/>, memory only), so its page carries the same identity the status and
    /// requests use. Seerr-only extras (Seerr's Rotten Tomatoes/IMDb ratings, its request state) have no
    /// TMDB counterpart and are left out: ratings answer "none". Bounded like the Seerr source: mapped
    /// answers are cached (<see cref="MaxEntries"/>, <see cref="Ttl"/>; failures briefly), one read per
    /// path runs at a time, and the reads a viewer can name without end come out of the viewer's feed
    /// budget and the server-wide feed queue (<see cref="SeerrNativeDetailsSource.FeedBurst"/> and the
    /// rest of its limits).
    /// </summary>
    public sealed class TmdbNativeDetailsSource : INativeDetailsSource
    {
        private const int MaxEntries = 400;
        private static readonly TimeSpan Ttl = TimeSpan.FromMinutes(15);
        private static readonly TimeSpan FailureTtl = TimeSpan.FromSeconds(30);

        private readonly TmdbResponseCache _tmdb;
        private readonly Func<TitleKey, IReadOnlyList<TitleKey>>? _aliases;
        private readonly Logger _logger;
        private readonly Func<string?> _key;
        private ConcurrentDictionary<string, (SourceAnswer Value, DateTime At)> _cache = new(StringComparer.Ordinal);
    private readonly global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.State<ConcurrentDictionary<string, (SourceAnswer Value, DateTime At)>> _cacheFactsOwner = new();
    private ConcurrentDictionary<string, (SourceAnswer Value, DateTime At)> _cacheFacts => _cacheFactsOwner.Read(ref _cache, () => new(StringComparer.Ordinal));
        private readonly ViewerMetadataAdmission _admission;
        private readonly ViewerBudget _feedBudget;

        /// <summary>Creates the source.</summary>
        /// <param name="tmdb">The shared TMDB cache (its own upstream bound and disk copy).</param>
        /// <param name="aliases">The ids the arr libraries and the library know a title by (null: TMDB's own only).</param>
        /// <param name="logger">Logger.</param>
        /// <param name="admission">The server singleton shared with parental evidence.</param>
        public TmdbNativeDetailsSource(TmdbResponseCache tmdb, TitleAliases? aliases, Logger logger, ViewerMetadataAdmission? admission = null)
            : this(tmdb, aliases == null ? null : aliases.Of, logger, () => JellyfinEnhanced.Instance?.Configuration?.GetTmdbApiKey(), () => DateTime.UtcNow, admission)
        {
        }

        /// <summary>Creates the source with its alias lookup, key reader and clock (tests).</summary>
        internal TmdbNativeDetailsSource(TmdbResponseCache tmdb, Func<TitleKey, IReadOnlyList<TitleKey>>? aliases, Logger logger, Func<string?> key, Func<DateTime> now, ViewerMetadataAdmission? admission = null)
        {
            _tmdb = tmdb;
            _admission = admission ?? tmdb.MetadataAdmission;
            _aliases = aliases;
            _logger = logger;
            _key = key;
            _feedBudget = new ViewerBudget(SeerrNativeDetailsSource.FeedBurst, SeerrNativeDetailsSource.FeedPerSecond, now);
        }

        /// <summary>How long a page's own metadata read waits for room in the viewer's budget before it answers busy.</summary>
        internal TimeSpan PageReadWait { get; set; } = TimeSpan.FromSeconds(3);

        /// <summary>Upstream reads still running (for tests: none may outlive its read).</summary>
        internal int InFlightCount => _admission.Count("native:");

        internal int MetadataTaskCount => _admission.Count();

        // Compatibility reads without a viewer share one bounded owner. All HTTP readers pass the
        // effective viewer explicitly; no new distinct source task can bypass FeedAsync admission.
        /// <inheritdoc />
        public Task<SourceAnswer> MovieAsync(int tmdb, CancellationToken ct) => Budgeted(MoviePath(tmdb), () => MovieFetch(tmdb), Guid.Empty, ct);

        /// <inheritdoc />
        public Task<SourceAnswer> SeriesAsync(int tmdb, CancellationToken ct) => Budgeted(SeriesPath(tmdb), () => SeriesFetch(tmdb), Guid.Empty, ct);

        /// <inheritdoc />
        public Task<SourceAnswer> SeasonAsync(int tmdb, int season, CancellationToken ct) => Budgeted(SeasonPath(tmdb, season), () => SeasonFetch(tmdb, season), Guid.Empty, ct);

        /// <inheritdoc />
        public Task<SourceAnswer> PersonAsync(int tmdb, CancellationToken ct) => Budgeted(PersonPath(tmdb), () => PersonFetch(tmdb), Guid.Empty, ct);

        /// <inheritdoc />
        public Task<SourceAnswer> GenresAsync(bool movie, CancellationToken ct) => GenresAsync(movie, Guid.Empty, ct);

        /// <inheritdoc />
        public Task<SourceAnswer> GenresAsync(bool movie, Guid viewer, CancellationToken ct)
        {
            var path = "genre/" + (movie ? "movie" : "tv") + "/list";
            return Budgeted(path, () => Fetch(path, string.Empty, body => TmdbNativeShape.Genres(body)), viewer, ct);
        }

        /// <inheritdoc />
        public Task<SourceAnswer> StudioAsync(int tmdb, CancellationToken ct) => Budgeted(StudioPath(tmdb), () => CompanyFetch(StudioPath(tmdb)), Guid.Empty, ct);

        /// <inheritdoc />
        public Task<SourceAnswer> NetworkAsync(int tmdb, CancellationToken ct) => Budgeted(NetworkPath(tmdb), () => CompanyFetch(NetworkPath(tmdb)), Guid.Empty, ct);

        /// <inheritdoc />
        public Task<SourceAnswer> MovieAsync(int tmdb, Guid viewer, CancellationToken ct) => Budgeted(MoviePath(tmdb), () => MovieFetch(tmdb), viewer, ct);

        /// <inheritdoc />
        public Task<SourceAnswer> SeriesAsync(int tmdb, Guid viewer, CancellationToken ct) => Budgeted(SeriesPath(tmdb), () => SeriesFetch(tmdb), viewer, ct);

        /// <inheritdoc />
        public Task<SourceAnswer> SeasonAsync(int tmdb, int season, Guid viewer, CancellationToken ct) => Budgeted(SeasonPath(tmdb, season), () => SeasonFetch(tmdb, season), viewer, ct);

        /// <inheritdoc />
        public Task<SourceAnswer> PersonAsync(int tmdb, Guid viewer, CancellationToken ct) => Budgeted(PersonPath(tmdb), () => PersonFetch(tmdb), viewer, ct);

        /// <inheritdoc />
        public Task<SourceAnswer> StudioAsync(int tmdb, Guid viewer, CancellationToken ct) => Budgeted(StudioPath(tmdb), () => CompanyFetch(StudioPath(tmdb)), viewer, ct);

        /// <inheritdoc />
        public Task<SourceAnswer> NetworkAsync(int tmdb, Guid viewer, CancellationToken ct) => Budgeted(NetworkPath(tmdb), () => CompanyFetch(NetworkPath(tmdb)), viewer, ct);

        /// <inheritdoc />
        public Task<SourceAnswer> PersonCreditsAsync(int tmdb, Guid viewer, CancellationToken ct)
        {
            if (tmdb <= 0) return Task.FromResult(SourceAnswer.Missing);
            var path = PersonPath(tmdb) + "/combined_credits";
            return FeedAsync(path, viewer, () => Fetch(path, string.Empty, body => TmdbNativeShape.PersonCredits(body)), ct);
        }

        /// <inheritdoc />
        public Task<SourceAnswer> DiscoverAsync(bool movie, string filter, int id, int page, string? sortBy, Guid viewer, CancellationToken ct)
        {
            // Seerr's filters are TMDB's discover filters: genre, studio (a company; movies), network (series), keywords.
            var param = (filter, movie) switch
            {
                ("genre", _) => "with_genres",
                ("studio", true) => "with_companies",
                ("network", false) => "with_networks",
                ("keywords", _) => "with_keywords",
                _ => null,
            };
            if (param == null || id <= 0 || page is < 1 or > 500) return Task.FromResult(SourceAnswer.Missing);
            var query = "?" + param + "=" + id.ToString(CultureInfo.InvariantCulture) + "&page=" + page.ToString(CultureInfo.InvariantCulture);
            if (!string.IsNullOrEmpty(sortBy)) query += "&sort_by=" + Uri.EscapeDataString(sortBy);
            var kind = movie ? "movie" : "tv";
            var path = "discover/" + kind;
            return FeedAsync(path + query, viewer, () => Fetch(path, query, body => TmdbNativeShape.Page(body, kind)), ct);
        }

        /// <inheritdoc />
        public Task<SourceAnswer> CompanySeriesAsync(int company, int page, string? sortBy, Guid viewer, CancellationToken ct)
        {
            if (company <= 0 || page is < 1 or > 500) return Task.FromResult(SourceAnswer.Missing);
            var query = "?with_companies=" + company.ToString(CultureInfo.InvariantCulture) + "&page=" + page.ToString(CultureInfo.InvariantCulture);
            if (TmdbCompanyTvDiscover.IsValidSort(sortBy)) query += "&sort_by=" + sortBy;
            return FeedAsync("discover/tv" + query, viewer, () => Fetch("discover/tv", query, body => TmdbNativeShape.Page(body, "tv")), ct);
        }

        /// <inheritdoc />
        public Task<SourceAnswer> RatingsAsync(bool movie, int tmdb, Guid viewer, CancellationToken ct)
            // Seerr's own ratings (Rotten Tomatoes, IMDb): none in this mode. "None" is an answer, not an outage.
            => Task.FromResult(SourceAnswer.Missing);

        /// <inheritdoc />
        public Task<SourceAnswer> RelatedAsync(bool movie, int tmdb, string relation, int page, Guid viewer, CancellationToken ct)
        {
            if (tmdb <= 0 || relation is not ("similar" or "recommendations") || page is < 1 or > 500) return Task.FromResult(SourceAnswer.Missing);
            var kind = movie ? "movie" : "tv";
            var path = kind + "/" + tmdb.ToString(CultureInfo.InvariantCulture) + "/" + relation;
            var query = "?page=" + page.ToString(CultureInfo.InvariantCulture);
            return FeedAsync(path + query, viewer, () => Fetch(path, query, body => TmdbNativeShape.Page(body, kind)), ct);
        }

        /// <inheritdoc />
        public Task<SourceAnswer> CollectionAsync(int collection, Guid viewer, CancellationToken ct)
        {
            if (collection <= 0) return Task.FromResult(SourceAnswer.Missing);
            var path = "collection/" + collection.ToString(CultureInfo.InvariantCulture);
            return Budgeted(path, () => Fetch(path, string.Empty, body => TmdbNativeShape.Collection(body)), viewer, ct);
        }

        /// <inheritdoc />
        public Task<SourceAnswer> KeywordsAsync(string query, Guid viewer, CancellationToken ct)
        {
            if (string.IsNullOrWhiteSpace(query) || query.Length > 100) return Task.FromResult(SourceAnswer.Missing);
            var q = "?query=" + Uri.EscapeDataString(query.Trim().ToLowerInvariant());
            return FeedAsync("search/keyword" + q, viewer, () => Fetch("search/keyword", q, body => TmdbNativeShape.KeywordPage(body)), ct);
        }

        /// <inheritdoc />
        public Task<JsonElement?> RecommendationsAsync(bool movie, int tmdb, CancellationToken ct)
            => RecommendationsAsync(movie, tmdb, Guid.Empty, ct);

        /// <inheritdoc />
        public async Task<JsonElement?> RecommendationsAsync(bool movie, int tmdb, Guid viewer, CancellationToken ct)
            => (await RelatedAsync(movie, tmdb, "recommendations", 1, viewer, ct).ConfigureAwait(false)).Data;

        /// <inheritdoc />
        public Task<string?> LogoPathAsync(bool movie, int tmdb, CancellationToken ct)
            => LogoPathAsync(movie, tmdb, Guid.Empty, ct);

        /// <inheritdoc />
        public async Task<string?> LogoPathAsync(bool movie, int tmdb, Guid viewer, CancellationToken ct)
        {
            if (tmdb <= 0) return null;
            var path = (movie ? "movie/" : "tv/") + tmdb.ToString(CultureInfo.InvariantCulture) + "/images";
            var answer = await Budgeted(path, () => LogoFetch(path), viewer, ct).ConfigureAwait(false);
            if (answer.Data is not { } data || !data.TryGetProperty("logos", out var logos) || logos.ValueKind != JsonValueKind.Array) return null;
            string? fallback = null;
            foreach (var logo in logos.EnumerateArray())
            {
                if (logo.ValueKind != JsonValueKind.Object) return null;
                var file = logo.TryGetProperty("file_path", out var p) && p.ValueKind == JsonValueKind.String ? p.GetString() : null;
                if (!ProviderMetadata.SafeArtwork(file)) continue;
                var lang = logo.TryGetProperty("iso_639_1", out var l) && l.ValueKind == JsonValueKind.String ? l.GetString() : null;
                if (lang == "en") return file;
                fallback ??= file;
            }

            return fallback;
        }

        /// <summary>The logo lookup and its one transient-failure retry share one admitted place and their own timeouts.</summary>
        private async Task<SourceAnswer> LogoFetch(string path)
        {
            var answer = await Fetch(path, "?include_image_language=en,null", body => JsonNode.Parse(body.GetRawText())!).ConfigureAwait(false);
            if (answer.Data == null && !answer.NotFound)
            {
                answer = await Fetch(path, "?include_image_language=en,null", body => JsonNode.Parse(body.GetRawText())!).ConfigureAwait(false);
            }

            return answer;
        }

        /// <summary>Provider-key resolution in JE mode uses the same admission owner as page metadata.</summary>
        internal Task<SourceAnswer> FindAsync(TitleKey title, Guid viewer, CancellationToken ct)
        {
            var provider = title.Provider switch { "tvdb" => "tvdb_id", "imdb" => "imdb_id", _ => null };
            if (provider == null) return Task.FromResult(SourceAnswer.Missing);
            var path = "find/" + Uri.EscapeDataString(title.Id);
            var query = "?external_source=" + provider;
            return Budgeted(path + query, () => Fetch(path, query, body => JsonNode.Parse(body.GetRawText())!), viewer, ct);
        }

        /// <inheritdoc />
        /// <remarks>Never asked in this mode (the policy admits Jellyfin Enhanced mode without a Seerr account); never contacts Seerr.</remarks>
        public Task<bool?> IsSeerrLinkedAsync(Guid userId, CancellationToken ct) => Task.FromResult<bool?>(false);

        private static string MoviePath(int tmdb) => "movie/" + tmdb.ToString(CultureInfo.InvariantCulture);

        private static string SeriesPath(int tmdb) => "tv/" + tmdb.ToString(CultureInfo.InvariantCulture);

        private static string SeasonPath(int tmdb, int season) => SeriesPath(tmdb) + "/season/" + season.ToString(CultureInfo.InvariantCulture);

        private static string PersonPath(int tmdb) => "person/" + tmdb.ToString(CultureInfo.InvariantCulture);

        private static string StudioPath(int tmdb) => "company/" + tmdb.ToString(CultureInfo.InvariantCulture);

        private static string NetworkPath(int tmdb) => "network/" + tmdb.ToString(CultureInfo.InvariantCulture);

        private Task<SourceAnswer> MovieFetch(int tmdb)
            => tmdb <= 0 ? Task.FromResult(SourceAnswer.Missing)
                : Fetch(MoviePath(tmdb), "?append_to_response=" + TmdbNativeShape.MovieAppend, body => TmdbNativeShape.Movie(body, Alias(true, tmdb, "imdb")));

        private Task<SourceAnswer> SeriesFetch(int tmdb)
        {
            if (tmdb <= 0) return Task.FromResult(SourceAnswer.Missing);
            return Fetch(SeriesPath(tmdb), "?append_to_response=" + TmdbNativeShape.SeriesAppend, body =>
            {
                var tvdb = Alias(false, tmdb, "tvdb") is { } t && int.TryParse(t, NumberStyles.None, CultureInfo.InvariantCulture, out var n) && n > 0 ? n : (int?)null;
                return TmdbNativeShape.Series(body, tvdb, Alias(false, tmdb, "imdb"));
            });
        }

        private Task<SourceAnswer> SeasonFetch(int tmdb, int season)
            => tmdb <= 0 || season is < 0 or > 65535 ? Task.FromResult(SourceAnswer.Missing)
                : Fetch(SeasonPath(tmdb, season), string.Empty, body => TmdbNativeShape.Season(body));

        private Task<SourceAnswer> PersonFetch(int tmdb)
            => tmdb <= 0 ? Task.FromResult(SourceAnswer.Missing) : Fetch(PersonPath(tmdb), string.Empty, body => TmdbNativeShape.Person(body));

        private Task<SourceAnswer> CompanyFetch(string path) => Fetch(path, string.Empty, body => TmdbNativeShape.Company(body));

        /// <summary>
        /// The id of <paramref name="provider"/> (tvdb, imdb) the arr libraries or Seerr's request records in memory know
        /// the title by, used when TMDB itself gives none. Memory only: no arr or Seerr call.
        /// </summary>
        private string? Alias(bool movie, int tmdb, string provider)
        {
            if (_aliases == null) return null;
            try
            {
                var key = TitleKey.Parse((movie ? "movie" : "tv") + ":tmdb:" + tmdb.ToString(CultureInfo.InvariantCulture));
                return key == null ? null : _aliases(key).FirstOrDefault(k => k.Provider == provider && k.IsMovie == movie)?.Id;
            }
            catch (Exception)
            {
                return null;
            }
        }

        /// <summary>
        /// One TMDB read mapped to Seerr's shape: TMDB's 404 is "no such title"; no key, an outage, a timeout or
        /// an unreadable body is "can't answer now". Not tied to a caller (one navigating away doesn't fail it for
        /// the others); runs on its own timeout.
        /// </summary>
        private async Task<SourceAnswer> Fetch(string path, string query, Func<JsonElement, JsonNode> map)
        {
            var key = _key();
            if (string.IsNullOrWhiteSpace(key)) return SourceAnswer.Unavailable;
            try
            {
                // The raw cache owns a 30-second timeout. Keep this admission until its task
                // actually ends; cancelling a cache waiter would leave its work unowned.
                var response = await _tmdb.GetAsync(path, query, key, CancellationToken.None).ConfigureAwait(false);
                if (!response.IsSuccess) return response.StatusCode == 404 ? SourceAnswer.Missing : SourceAnswer.Unavailable;
                using var doc = JsonDocument.Parse(response.Content);
                if (doc.RootElement.ValueKind != JsonValueKind.Object) return SourceAnswer.Unavailable;
                using var mapped = JsonDocument.Parse(map(doc.RootElement).ToJsonString());
                return SourceAnswer.Of(mapped.RootElement.Clone());
            }
            catch (Exception ex)
            {
                _logger.Debug($"Native details (TMDB): {path} failed: {ex.Message}");
                return SourceAnswer.Unavailable;
            }
        }

        /// <summary>
        /// A page's metadata read: cached or running reads are free, a new one comes out of the viewer's feed budget,
        /// waiting a little for a token before it answers busy (as the Seerr source does).
        /// </summary>
        private async Task<SourceAnswer> Budgeted(string path, Func<Task<SourceAnswer>> fetch, Guid viewer, CancellationToken ct)
        {
            var until = DateTime.UtcNow + PageReadWait;
            while (true)
            {
                var answer = await FeedAsync(path, viewer, fetch, ct).ConfigureAwait(false);
                if (!answer.Busy || DateTime.UtcNow >= until) return answer;
                await Task.Delay(250, ct).ConfigureAwait(false);
            }
        }

        private bool TryCached(string path, out SourceAnswer value)
        {
            value = default;
            if (!_cacheFacts.TryGetValue(path, out var hit) || DateTime.UtcNow - hit.At >= (hit.Value.Data.HasValue ? Ttl : FailureTtl)) return false;
            value = hit.Value;
            return true;
        }

        /// <summary>
        /// A feed read: free from the cache or a running read of the same path; else started only when the server's
        /// queue, the viewer's share of it and the viewer's budget have room (else <see cref="SourceAnswer.Throttled"/>).
        /// The place and the upstream slot are held by the read itself, not by the caller.
        /// </summary>
        private Task<SourceAnswer> FeedAsync(string path, Guid viewer, Func<Task<SourceAnswer>> fetch, CancellationToken ct)
        {
            if (TryCached(path, out var hit)) return Task.FromResult(hit);
            return KnownThenAdmittedAsync(path, viewer, fetch, ct);
        }

        /// <summary>
        /// Raw TMDB answers already in memory or saved on disk (the server-side cache) are mapped without a place in the
        /// queue or a budget token; only a read that needs TMDB takes them (<see cref="ViewerMetadataAdmission"/>).
        /// </summary>
        private async Task<SourceAnswer> KnownThenAdmittedAsync(string path, Guid viewer, Func<Task<SourceAnswer>> fetch, CancellationToken ct)
        {
            var known = await TmdbResponseCache.CachedOnlyAsync(fetch).ConfigureAwait(false);
            if (known.Hit && !known.Value.Busy) return Store(path, known.Value);
            return await _admission.Read("native:" + path, viewer,
                () => (TryCached(path, out var hit), hit),
                async () => Store(path, await fetch().ConfigureAwait(false)),
                SourceAnswer.Throttled, ct, _feedBudget).ConfigureAwait(false);
        }

        private SourceAnswer Store(string path, SourceAnswer value)
        {
            // A busy answer was never read: nothing to remember.
            if (value.Busy) return value;
            if (_cacheFacts.Count >= MaxEntries)
            {
                foreach (var old in _cacheFacts.OrderBy(e => e.Value.At).Take(MaxEntries / 10).ToList())
                {
                    _cacheFacts.TryRemove(old.Key, out _);
                }
            }

            _cacheFacts[path] = (value, DateTime.UtcNow);
            return value;
        }
    }
}
