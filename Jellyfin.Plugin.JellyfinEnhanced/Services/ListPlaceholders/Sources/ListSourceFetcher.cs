using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders.Import;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders.Sources
{
    /// <summary>One entry of a fetched list, in list order, with whatever ids the source provides.</summary>
    /// <param name="MediaType">"movie" or "tv".</param>
    /// <param name="TmdbId">TMDB id (movie, or the show for TV entries).</param>
    /// <param name="ImdbId">IMDb id (movie, or the show for TV entries).</param>
    /// <param name="TvdbId">TVDB id of the show.</param>
    /// <param name="Title">Title (the show's for season/episode entries).</param>
    /// <param name="Year">Year.</param>
    /// <param name="Season">Season (season/episode entries).</param>
    /// <param name="Episode">Episode (episode entries).</param>
    /// <param name="Note">The list's note for the entry.</param>
    public sealed record SourceItem(string MediaType, int? TmdbId, string? ImdbId, int? TvdbId, string? Title, int? Year, int? Season, int? Episode, string? Note)
    {
        /// <summary>The provenance key (F1), or null when the entry has no usable id.</summary>
        public string? Key => SourceKeys.For(this);

        /// <summary>Exact metadata from sources that publish it (chronolists), so entries are built without a lookup.</summary>
        public SourceItemDetails? Details { get; init; }
    }

    /// <summary>Metadata a source publishes next to the ids (all optional, already validated).</summary>
    /// <param name="EpisodeTitle">Episode title (episode entries).</param>
    /// <param name="Date">Release date (movie) or air date (episode), yyyy-MM-dd.</param>
    /// <param name="PosterPath">TMDB poster path (the movie's, or the season's for episode entries).</param>
    /// <param name="Overview">Overview (movies).</param>
    /// <param name="SeasonName">Season name (episode entries).</param>
    public sealed record SourceItemDetails(string? EpisodeTitle, string? Date, string? PosterPath, string? Overview, string? SeasonName);

    /// <summary>Outcome of fetching one list.</summary>
    public sealed class SourceFetchResult
    {
        /// <summary>Whether the fetch completed (all pages read up to the cap).</summary>
        public bool Ok { get; init; }

        /// <summary>Machine error code when not Ok.</summary>
        public string? ErrorCode { get; init; }

        /// <summary>Human message when not Ok.</summary>
        public string? Message { get; init; }

        /// <summary>Upstream asked to retry after this many seconds.</summary>
        public int? RetryAfterSeconds { get; init; }

        /// <summary>Source kind.</summary>
        public string Kind { get; init; } = string.Empty;

        /// <summary>The upstream used (mdblist, mdblist-api, tmdb, seerr, trakt, imdb).</summary>
        public string Provider { get; init; } = string.Empty;

        /// <summary>Canonical URL.</summary>
        public string CanonicalUrl { get; init; } = string.Empty;

        /// <summary>List title.</summary>
        public string? Title { get; init; }

        /// <summary>Unofficial access path (IMDb).</summary>
        public bool Unofficial { get; init; }

        /// <summary>Entries in list order (≤ <see cref="ListSourceFetcher.MaxItems"/>; exact sources ≤ <see cref="ChronolistsPage.MaxItems"/>).</summary>
        public IReadOnlyList<SourceItem> Items { get; init; } = Array.Empty<SourceItem>();

        /// <summary>Entries the source has (when known).</summary>
        public int Total { get; init; }

        /// <summary>More than the cap: the snapshot is incomplete (sync then never removes anything).</summary>
        public bool Truncated { get; init; }

        /// <summary>
        /// The upstream answered only partly (e.g. IMDb GraphQL errors next to data): entries may be missing anywhere in
        /// the list, so — like <see cref="Truncated"/> — sync adds but never removes or replaces its snapshot (F2).
        /// </summary>
        public bool Partial { get; init; }

        /// <summary>
        /// Every entry carries exact TMDB ids and the metadata a placeholder needs (<see cref="SourceItem.Details"/>):
        /// entries are grouped (runs of episodes) and built without Seerr lookups (chronolists).
        /// </summary>
        public bool Exact { get; init; }

        /// <summary>An error result.</summary>
        /// <param name="source">Source.</param>
        /// <param name="code">Code.</param>
        /// <param name="message">Message.</param>
        /// <param name="retryAfter">Retry-After seconds.</param>
        /// <returns>The result.</returns>
        public static SourceFetchResult Fail(ParsedSourceUrl source, string code, string message, int? retryAfter = null) =>
            new() { Ok = false, ErrorCode = code, Message = message, RetryAfterSeconds = retryAfter, Kind = source.Kind, CanonicalUrl = source.CanonicalUrl };
    }

    /// <summary>Provenance keys of source entries (F1): <c>type|id|season|episode</c>, never the list rank.</summary>
    public static class SourceKeys
    {
        private static readonly Regex KeyRegex = new(@"^(?:(?:movie|tv)\|[0-9]{1,9}|imdb\|tt[0-9]{5,10}|tvdb\|[0-9]{1,9})\|(?:[0-9]{1,3})?\|(?:[0-9]{1,4})?$", RegexOptions.Compiled | RegexOptions.CultureInvariant);

        /// <summary>Key of an entry: TMDB first, else IMDb, else TVDB; null without an id.</summary>
        /// <param name="item">Entry.</param>
        /// <returns>Key or null.</returns>
        public static string? For(SourceItem item)
        {
            string head;
            if (item.TmdbId is > 0)
            {
                head = item.MediaType + "|" + item.TmdbId.Value.ToString(CultureInfo.InvariantCulture);
            }
            else if (!string.IsNullOrEmpty(item.ImdbId))
            {
                head = "imdb|" + item.ImdbId;
            }
            else if (item.TvdbId is > 0 && item.MediaType == "tv")
            {
                head = "tvdb|" + item.TvdbId.Value.ToString(CultureInfo.InvariantCulture);
            }
            else
            {
                return null;
            }

            var key = head + "|" + item.Season?.ToString(CultureInfo.InvariantCulture) + "|" + item.Episode?.ToString(CultureInfo.InvariantCulture);
            return IsValid(key) ? key : null;
        }

        /// <summary>Whether a client-supplied key has the key format.</summary>
        /// <param name="key">Key.</param>
        /// <returns>Valid.</returns>
        public static bool IsValid(string? key) => key != null && key.Length <= 40 && KeyRegex.IsMatch(key);

        /// <summary>The season and episode of an episode key (<c>…|season|episode</c>), else null.</summary>
        /// <param name="key">Key.</param>
        /// <returns>The coordinate or null.</returns>
        public static (int Season, int Episode)? EpisodeOf(string key)
        {
            var parts = key.Split('|');
            return parts.Length == 4
                && int.TryParse(parts[2], NumberStyles.None, CultureInfo.InvariantCulture, out var season)
                && int.TryParse(parts[3], NumberStyles.None, CultureInfo.InvariantCulture, out var episode)
                ? (season, episode)
                : null;
        }
    }

    /// <summary>Fetch options.</summary>
    public sealed class SourceFetchOptions
    {
        /// <summary>MDBList API fallback (private lists through JE's key) — administrators only.</summary>
        public bool AllowMdblistApi { get; init; }

        /// <summary>Linked sources: the provider stored at link time; never switched silently (F4).</summary>
        public string? Provider { get; init; }

        /// <summary>Skip the short result cache (sync).</summary>
        public bool Fresh { get; init; }

        /// <summary>
        /// The user an interactive fetch is for ("N"): fetches that miss the result cache are limited per caller
        /// (<see cref="ListSourceFetcher.MaxFetchesPerCaller"/>). Null for the sync, which runs once per list at a time.
        /// </summary>
        public string? Caller { get; init; }
    }

    /// <summary>Fetches list URLs (5b). Production: <see cref="ListSourceFetcher"/>.</summary>
    public interface IListSourceFetcher
    {
        /// <summary>Fetches a recognised list.</summary>
        /// <param name="source">Parsed URL.</param>
        /// <param name="options">Options.</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>The result.</returns>
        Task<SourceFetchResult> FetchAsync(ParsedSourceUrl source, SourceFetchOptions options, CancellationToken cancellationToken);

        /// <summary>Which providers can work with the current configuration.</summary>
        /// <returns>Capabilities (no secrets).</returns>
        SourceProvidersDto Providers();
    }

    /// <summary>
    /// Server-side list fetching (design §8, F4–F6; research/list-sources.md):
    /// <list type="bullet">
    /// <item><b>MDBList</b>: public <c>/json</c> first (no key); the API (<c>unified=true</c>) only for administrators when
    /// the public JSON is refused, charged to <see cref="MdblistService"/>'s quota bookkeeping.</item>
    /// <item><b>TMDB</b>: user lists and exact charts need JE's TMDB key (through <see cref="TmdbResponseCache"/>);
    /// collections, trending and movie "upcoming" fall back to Seerr without one. The provider used is reported and,
    /// for linked lists, pinned.</item>
    /// <item><b>Trakt</b>: needs the admin's <c>TraktClientId</c>; public lists, watchlists, official lists and charts with
    /// season/episode granularity.</item>
    /// <item><b>IMDb</b>: only with <c>ListPlaceholdersImdbEnabled</c>, through IMDb's unofficial GraphQL API.</item>
    /// <item><b>chronolists</b>: the watch-order page's embedded data (<see cref="ChronolistsPage"/>); exact ids, no key.</item>
    /// </list>
    /// Requests go only to fixed hosts built from the parsed parts (SSRF guard), without redirects, with a 20 s timeout,
    /// an 8 MiB body cap and a 1000-entry cap; a short Retry-After (≤ 5 s) is honoured once, longer ones are reported.
    /// An answer without the list array it should have is an error, never an empty list. Successful fetches are cached
    /// for 5 minutes (bounded, oldest first) so preview → apply → link doesn't fetch twice; TMDB pages are always read
    /// fresh (never from <see cref="TmdbResponseCache"/>'s longer-lived copy), so every page of a snapshot is current.
    /// Interactive callers get a few upstream fetches at a time and per window (<see cref="MaxFetchesPerCaller"/>).
    /// </summary>
    public sealed class ListSourceFetcher : IListSourceFetcher
    {
        /// <summary>Entry cap per list.</summary>
        public const int MaxItems = 1000;

        /// <summary>Entries read from a chart (charts are endless).</summary>
        public const int MaxChartItems = 100;

        /// <summary>Result cache lifetime.</summary>
        public static readonly TimeSpan CacheTtl = TimeSpan.FromMinutes(5);

        /// <summary>Fetches one caller may send upstream (result cache misses) within <see cref="CallerWindow"/>.</summary>
        public const int MaxFetchesPerCaller = 10;

        /// <summary>Upstream fetches one caller may have running at the same time.</summary>
        public const int MaxConcurrentFetchesPerCaller = 2;

        /// <summary>The window of <see cref="MaxFetchesPerCaller"/>.</summary>
        public static readonly TimeSpan CallerWindow = TimeSpan.FromMinutes(5);

        /// <summary>Results kept in the result cache (oldest go first).</summary>
        internal const int MaxCacheEntries = 100;

        /// <summary>List entries kept in the result cache over all results (oldest go first).</summary>
        internal const int MaxCachedItems = 20_000;

        private const int MaxBodyBytes = 8 * 1024 * 1024;
        private const int MaxRetryWaitSeconds = 5;
        private const string ImdbGraphQl = "https://api.graphql.imdb.com/";
        private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(20);

        private static readonly Dictionary<string, string> ImdbCharts = new(StringComparer.Ordinal)
        {
            ["top"] = "TOP_RATED_MOVIES",
            ["toptv"] = "TOP_RATED_TV_SHOWS",
            ["moviemeter"] = "MOST_POPULAR_MOVIES",
            ["tvmeter"] = "MOST_POPULAR_TV_SHOWS",
            ["bottom"] = "LOWEST_RATED_MOVIES",
            ["top-english-movies"] = "TOP_RATED_ENGLISH_MOVIES",
        };

        private readonly IHttpClientFactory _httpClientFactory;
        private readonly TmdbResponseCache? _tmdb;
        private readonly MdblistService? _mdblist;
        private readonly SeerrCallLimiter _limiter;
        private readonly Logger _logger;
        private readonly SemaphoreSlim _gate = new(3, 3);
        private readonly ConcurrentDictionary<string, (DateTime ExpiresUtc, SourceFetchResult Result)> _cache = new(StringComparer.Ordinal);
        private readonly ConcurrentDictionary<string, CallerBudget> _callers = new(StringComparer.Ordinal);

        /// <summary>Creates the fetcher (singleton).</summary>
        /// <param name="httpClientFactory">HTTP client factory.</param>
        /// <param name="tmdb">TMDB response cache.</param>
        /// <param name="mdblist">MDBList service (quota bookkeeping).</param>
        /// <param name="limiter">Shared Seerr limiter (Seerr fallbacks).</param>
        /// <param name="logger">JE logger.</param>
        public ListSourceFetcher(IHttpClientFactory httpClientFactory, TmdbResponseCache tmdb, MdblistService mdblist, SeerrCallLimiter limiter, Logger logger)
        {
            _httpClientFactory = httpClientFactory;
            _tmdb = tmdb;
            _mdblist = mdblist;
            _limiter = limiter;
            _logger = logger;
        }

        /// <summary>Test constructor (TMDB calls go through the given cache; no MDBList quota service).</summary>
        /// <param name="httpClientFactory">HTTP client factory.</param>
        /// <param name="tmdb">TMDB cache or null.</param>
        /// <param name="limiter">Limiter.</param>
        /// <param name="logger">Logger.</param>
        internal ListSourceFetcher(IHttpClientFactory httpClientFactory, TmdbResponseCache? tmdb, SeerrCallLimiter limiter, Logger logger)
        {
            _httpClientFactory = httpClientFactory;
            _tmdb = tmdb;
            _limiter = limiter;
            _logger = logger;
        }

        private static Configuration.PluginConfiguration? Config => JellyfinEnhanced.Instance?.Configuration;

        private static string TmdbKey => Config?.TMDB_API_KEY?.Trim() ?? string.Empty;

        /// <inheritdoc />
        public SourceProvidersDto Providers()
        {
            var config = Config;
            var seerr = config != null && config.JellyseerrEnabled && !string.IsNullOrWhiteSpace(config.JellyseerrUrls) && !string.IsNullOrWhiteSpace(config.JellyseerrApiKey);
            return new SourceProvidersDto
            {
                Mdblist = true,
                TmdbLists = TmdbKey.Length > 0 && _tmdb != null,
                TmdbCharts = (TmdbKey.Length > 0 && _tmdb != null) || seerr,
                Trakt = !string.IsNullOrWhiteSpace(config?.TraktClientId),
                Imdb = config?.ListPlaceholdersImdbEnabled == true,
                Chronolists = true,
                SyncEnabled = config?.ListPlaceholdersSyncEnabled == true,
                MaxItems = MaxItems,
            };
        }

        /// <inheritdoc />
        public async Task<SourceFetchResult> FetchAsync(ParsedSourceUrl source, SourceFetchOptions options, CancellationToken cancellationToken)
        {
            // Provider switches are checked before the cache: a source the admin just turned off stops working at once.
            if (Unavailable(source) is { } unavailable)
            {
                return unavailable;
            }

            var cacheKey = source.CanonicalUrl + "|" + options.AllowMdblistApi + "|" + options.Provider + "|" + TmdbKey.Length.ToString(CultureInfo.InvariantCulture);
            if (!options.Fresh && _cache.TryGetValue(cacheKey, out var cached) && cached.ExpiresUtc > DateTime.UtcNow)
            {
                return cached.Result;
            }

            // F29: a user's fetches that miss the cache go upstream only a few at a time and a bounded number per window.
            var retryAfter = 0;
            using var admission = options.Caller == null ? null : TryAdmit(options.Caller, out retryAfter);
            if (options.Caller != null && admission == null)
            {
                return SourceFetchResult.Fail(source, "fetch_limited", "You've read a lot of lists in a short time; try again in a little while.", retryAfter);
            }

            await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                SourceFetchResult result;
                try
                {
                    result = source.Kind switch
                    {
                        SourceKinds.Mdblist => await MdblistAsync(source, options, cancellationToken).ConfigureAwait(false),
                        SourceKinds.Tmdb => await TmdbAsync(source, options, cancellationToken).ConfigureAwait(false),
                        SourceKinds.Trakt => await TraktAsync(source, cancellationToken).ConfigureAwait(false),
                        SourceKinds.Imdb => await ImdbAsync(source, cancellationToken).ConfigureAwait(false),
                        SourceKinds.Chronolists => await ChronolistsAsync(source, cancellationToken).ConfigureAwait(false),
                        _ => SourceFetchResult.Fail(source, ListSourceUrl.UnsupportedUrl, "This list URL isn't supported."),
                    };
                }
                catch (SourceHttpException ex)
                {
                    result = SourceFetchResult.Fail(source, ex.Code, ex.Message, ex.RetryAfter);
                }
                catch (Exception ex) when (ex is JsonException or InvalidDataException or FormatException)
                {
                    _logger.Warning($"[ListPlaceholders] Couldn't read the list {source.CanonicalUrl}: {ex.Message}");
                    result = SourceFetchResult.Fail(source, "upstream_error", "The list site returned something JE can't read.");
                }

                if (result.Ok)
                {
                    PruneCache(result.Items.Count);
                    _cache[cacheKey] = (DateTime.UtcNow + CacheTtl, result);
                }
                else
                {
                    _logger.Info($"[ListPlaceholders] Fetching {source.CanonicalUrl} failed: {result.ErrorCode}");
                }

                return result;
            }
            finally
            {
                _gate.Release();
            }
        }

        // Configuration gates of providers that need an admin switch or credential (no request is made without them).
        private static SourceFetchResult? Unavailable(ParsedSourceUrl source) => source.Kind switch
        {
            SourceKinds.Imdb when Config?.ListPlaceholdersImdbEnabled != true =>
                SourceFetchResult.Fail(source, "imdb_disabled", "IMDb lists are turned off on this server. Mirror the list on MDBList and import that URL, or paste an IMDb CSV export."),
            SourceKinds.Trakt when string.IsNullOrWhiteSpace(Config?.TraktClientId) =>
                SourceFetchResult.Fail(source, "trakt_not_configured", "Trakt lists need a Trakt client ID in Jellyfin Enhanced's settings."),
            _ => null,
        };

        // ── MDBList ─────────────────────────────────────────────────────────

        private async Task<SourceFetchResult> MdblistAsync(ParsedSourceUrl source, SourceFetchOptions options, CancellationToken cancellationToken)
        {
            var publicPath = source.Shape switch
            {
                "external" => $"/lists/{Esc(source.Part("user"))}/external/{source.Part("id")}/json",
                "official" => $"/lists/official/{source.Part("media")}/{Esc(source.Part("slug"))}/json",
                _ => $"/lists/{Esc(source.Part("user"))}/{Esc(source.Part("slug"))}/json",
            };

            if (options.Provider != "mdblist-api")
            {
                var response = await SendAsync(HttpMethod.Get, "https://mdblist.com" + publicPath, null, null, cancellationToken).ConfigureAwait(false);
                if (response.Status == 200 && response.Body != null)
                {
                    return MdblistItems(source, "mdblist", response.Body, false);
                }

                if (response.Status is not (401 or 403 or 404))
                {
                    throw Upstream(response, "MDBList");
                }

                // F4: a link pinned to the public JSON never switches to the API (the admin's key and quota) silently.
                if (options.Provider == "mdblist")
                {
                    return SourceFetchResult.Fail(source, "not_found", "MDBList no longer serves this list publicly (it may have been made private or deleted). Link it again to read it through the MDBList API.");
                }
            }

            var key = Config?.MdblistApiKey?.Trim();
            if (!options.AllowMdblistApi || string.IsNullOrEmpty(key))
            {
                return SourceFetchResult.Fail(source, "not_found", "MDBList didn't return this list. Check that it exists and is public.");
            }

            if (_mdblist != null && !await _mdblist.TryReserveListRequestAsync(cancellationToken).ConfigureAwait(false))
            {
                return SourceFetchResult.Fail(source, "quota_exhausted", "The MDBList API quota for today is used up; try again after it resets.");
            }

            var apiPath = source.Shape switch
            {
                "external" => $"/external/lists/{source.Part("id")}/items",
                "official" => $"/lists/official/{Esc(source.Part("slug"))}/items",
                _ => $"/lists/{Esc(source.Part("user"))}/{Esc(source.Part("slug"))}/items",
            };
            var query = "?apikey=" + Uri.EscapeDataString(key) + "&limit=" + MaxItems.ToString(CultureInfo.InvariantCulture) + "&unified=true"
                + (source.Shape == "official" ? "&mediatype=" + (source.Part("media") == "shows" ? "show" : "movie") : string.Empty);
            var api = await SendAsync(HttpMethod.Get, "https://api.mdblist.com" + apiPath + query, null, null, cancellationToken).ConfigureAwait(false);
            if (api.Status == 200 && api.Body != null)
            {
                return MdblistItems(source, "mdblist-api", api.Body, MdblistHasMore(api));
            }

            if (api.Status is 401 or 403 or 404)
            {
                return SourceFetchResult.Fail(source, "not_found", "MDBList didn't return this list, even with the API key.");
            }

            throw Upstream(api, "MDBList");
        }

        // The API pages with a cursor (research: next_cursor / X-Has-More, at most 1000 per page). One page fills the
        // cap, so more pages only mean "incomplete": never follow them (quota), just never treat the snapshot as complete.
        private static bool MdblistHasMore(HttpResult response)
        {
            if (response.Headers.TryGetValue("X-Has-More", out var header) && header.Trim().Equals("true", StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }

            try
            {
                using var doc = JsonDocument.Parse(response.Body!);
                if (doc.RootElement.ValueKind == JsonValueKind.Object && doc.RootElement.TryGetProperty("pagination", out var pagination) && pagination.ValueKind == JsonValueKind.Object)
                {
                    if (pagination.TryGetProperty("has_more", out var hasMore) && hasMore.ValueKind == JsonValueKind.True)
                    {
                        return true;
                    }

                    if (pagination.TryGetProperty("next_cursor", out var cursor) && cursor.ValueKind == JsonValueKind.String && !string.IsNullOrEmpty(cursor.GetString()))
                    {
                        return true;
                    }
                }
            }
            catch (JsonException)
            {
                // MdblistItems reports unreadable bodies.
            }

            return false;
        }

        private static SourceFetchResult MdblistItems(ParsedSourceUrl source, string provider, string body, bool hasMore)
        {
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;
            var elements = new List<JsonElement>();
            if (root.ValueKind == JsonValueKind.Array)
            {
                elements.AddRange(root.EnumerateArray());
            }
            else if (root.ValueKind == JsonValueKind.Object)
            {
                var found = false;
                foreach (var name in new[] { "items", "movies", "shows" })
                {
                    if (root.TryGetProperty(name, out var array) && array.ValueKind == JsonValueKind.Array)
                    {
                        found = true;
                        elements.AddRange(array.EnumerateArray());
                    }
                }

                // An error object ({"error": …}) is not an empty list: a sync would remove everything (F16).
                if (!found)
                {
                    throw new InvalidDataException("MDBList JSON without a list");
                }
            }
            else
            {
                throw new InvalidDataException("unexpected MDBList JSON");
            }

            var items = new List<SourceItem>();
            foreach (var element in elements)
            {
                if (element.ValueKind != JsonValueKind.Object)
                {
                    continue;
                }

                var media = Str(element, "mediatype") ?? Str(element, "media_type");
                var mediaType = media is "show" or "tv" ? "tv" : media == "movie" ? "movie" : source.Part("media") == "shows" ? "tv" : "movie";
                int? tmdb = Int(element, "id");
                string? imdb = Str(element, "imdb_id");
                int? tvdb = Int(element, "tvdbid") ?? Int(element, "tvdb_id");
                if (element.TryGetProperty("ids", out var ids) && ids.ValueKind == JsonValueKind.Object)
                {
                    tmdb = Int(ids, "tmdb") ?? tmdb;
                    imdb = Str(ids, "imdb") ?? imdb;
                    tvdb = Int(ids, "tvdb") ?? tvdb;
                }

                items.Add(new SourceItem(mediaType, tmdb is > 0 ? tmdb : null, ValidImdb(imdb), tvdb is > 0 ? tvdb : null, Str(element, "title"), Year(Int(element, "release_year")), null, null, null));
            }

            // A full page without pagination facts is treated as possibly incomplete too (never remove on a guess).
            var truncated = hasMore || (provider == "mdblist-api" && items.Count >= MaxItems);
            return Done(source, provider, null, items, items.Count, truncated);
        }

        // ── TMDB ────────────────────────────────────────────────────────────

        private async Task<SourceFetchResult> TmdbAsync(ParsedSourceUrl source, SourceFetchOptions options, CancellationToken cancellationToken)
        {
            var hasKey = TmdbKey.Length > 0 && _tmdb != null;
            var seerrAllowed = source.Shape is "collection" or "trending" || (source.Shape == "chart" && source.Part("chart") == "upcoming");
            string provider;
            if (options.Provider == "tmdb")
            {
                if (!hasKey)
                {
                    return SourceFetchResult.Fail(source, "tmdb_key_required", "This list was linked through TMDB, but the TMDB API key is no longer set.");
                }

                provider = "tmdb";
            }
            else if (options.Provider == "seerr")
            {
                provider = "seerr";
            }
            else
            {
                provider = hasKey && !(source.Shape == "chart" && source.Part("media") == "tv" && source.Part("chart") == "upcoming") ? "tmdb" : "seerr";
            }

            if (provider == "seerr" && !seerrAllowed)
            {
                return SourceFetchResult.Fail(source, "tmdb_key_required", "TMDB lists and charts like this one need the TMDB API key in Jellyfin Enhanced's settings.");
            }

            return provider == "tmdb"
                ? await TmdbDirectAsync(source, cancellationToken).ConfigureAwait(false)
                : await TmdbViaSeerrAsync(source, cancellationToken).ConfigureAwait(false);
        }

        private async Task<SourceFetchResult> TmdbDirectAsync(ParsedSourceUrl source, CancellationToken cancellationToken)
        {
            var key = TmdbKey;
            var id = source.Part("id");
            switch (source.Shape)
            {
                case "collection":
                {
                    var json = await TmdbGetAsync("collection/" + id, string.Empty, key, cancellationToken).ConfigureAwait(false);
                    if (json == null)
                    {
                        return SourceFetchResult.Fail(source, "not_found", "TMDB has no collection with this id.");
                    }

                    using var doc = JsonDocument.Parse(json);
                    var parts = ListArray(doc.RootElement, "parts").Select(p => TmdbItem(p, "movie", "release_date")).OfType<SourceItem>();
                    var ordered = parts.OrderBy(p => p.Year ?? int.MaxValue).ToList();
                    return Done(source, "tmdb", Str(doc.RootElement, "name"), ordered, ordered.Count, false);
                }

                case "list":
                {
                    var items = new List<SourceItem>();
                    string? title = null;
                    var total = 0;
                    var truncated = false;
                    for (var page = 1; page <= 100; page++)
                    {
                        var json = await TmdbGetAsync("list/" + id, "?page=" + page.ToString(CultureInfo.InvariantCulture), key, cancellationToken).ConfigureAwait(false);
                        if (json == null)
                        {
                            return page == 1 ? SourceFetchResult.Fail(source, "not_found", "TMDB has no public list with this id.") : throw new SourceHttpException("upstream_error", "TMDB stopped answering while reading the list.");
                        }

                        using var doc = JsonDocument.Parse(json);
                        title ??= Str(doc.RootElement, "name");
                        total = Int(doc.RootElement, "item_count") ?? total;
                        var pageItems = ListArray(doc.RootElement, "items").Select(p => TmdbItem(p, null, null)).OfType<SourceItem>().ToList();
                        items.AddRange(pageItems);
                        var pages = Int(doc.RootElement, "total_pages") ?? 1;
                        if (items.Count >= MaxItems)
                        {
                            truncated = items.Count > MaxItems || page < pages;
                            break;
                        }

                        if (page >= pages || pageItems.Count == 0)
                        {
                            break;
                        }
                    }

                    return Done(source, "tmdb", title, items, Math.Max(total, items.Count), truncated);
                }

                default:
                {
                    var media = source.Part("media");
                    var path = source.Shape == "trending"
                        ? $"trending/{media}/{source.Part("period")}"
                        : $"{media}/{source.Part("chart").Replace('-', '_')}";
                    var items = new List<SourceItem>();
                    for (var page = 1; page <= MaxChartItems / 20 && items.Count < MaxChartItems; page++)
                    {
                        var json = await TmdbGetAsync(path, "?page=" + page.ToString(CultureInfo.InvariantCulture), key, cancellationToken).ConfigureAwait(false)
                            ?? throw new SourceHttpException("upstream_error", "TMDB didn't return the chart.");
                        using var doc = JsonDocument.Parse(json);
                        var defaultType = media == "all" ? null : media;
                        items.AddRange(ListArray(doc.RootElement, "results").Select(p => TmdbItem(p, defaultType, null)).OfType<SourceItem>());
                        if (page >= (Int(doc.RootElement, "total_pages") ?? 1))
                        {
                            break;
                        }
                    }

                    var chart = items.Take(MaxChartItems).ToList();
                    return Done(source, "tmdb", null, chart, chart.Count, false);
                }
            }
        }

        private async Task<string?> TmdbGetAsync(string path, string query, string key, CancellationToken cancellationToken)
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(Timeout);
            TmdbResponseCache.TmdbResponse response;
            try
            {
                // F17: never the cached copy (6 h for lists and collections): a sync must see the list as it is now,
                // and the pages of one snapshot must not be of different ages. The fetcher's own short result cache
                // keeps preview → apply → link to one read.
                response = await _tmdb!.GetAsync(path, query, key, timeout.Token, refresh: true).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                throw new SourceHttpException("timeout", "TMDB took too long to answer.");
            }

            if (response.IsSuccess)
            {
                return response.Content;
            }

            return response.StatusCode switch
            {
                404 => null,
                401 => throw new SourceHttpException("tmdb_key_invalid", "TMDB refused the API key configured in Jellyfin Enhanced."),
                429 => throw new SourceHttpException("rate_limited", "TMDB is rate limiting; try again shortly.", 10),
                _ => throw new SourceHttpException("upstream_error", "TMDB returned an error."),
            };
        }

        private async Task<SourceFetchResult> TmdbViaSeerrAsync(ParsedSourceUrl source, CancellationToken cancellationToken)
        {
            var config = Config;
            if (config == null || !config.JellyseerrEnabled || string.IsNullOrWhiteSpace(config.JellyseerrUrls) || string.IsNullOrWhiteSpace(config.JellyseerrApiKey))
            {
                return SourceFetchResult.Fail(source, "tmdb_key_required", "TMDB lists need the TMDB API key or Seerr in Jellyfin Enhanced's settings.");
            }

            var baseUrl = config.JellyseerrUrls.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries).Select(u => u.Trim().TrimEnd('/')).First(u => u.Length > 0);
            if (source.Shape == "collection")
            {
                var json = await SeerrGetAsync(baseUrl, config.JellyseerrApiKey, "/api/v1/collection/" + source.Part("id"), cancellationToken).ConfigureAwait(false);
                if (json == null)
                {
                    return SourceFetchResult.Fail(source, "not_found", "Seerr couldn't find this TMDB collection.");
                }

                using var doc = JsonDocument.Parse(json);
                var parts = ListArray(doc.RootElement, "parts").Select(p => SeerrItem(p, "movie")).OfType<SourceItem>().ToList();
                return Done(source, "seerr", Str(doc.RootElement, "name"), parts, parts.Count, false);
            }

            var path = source.Shape == "trending"
                ? $"/api/v1/discover/trending?mediaType={source.Part("media")}&timeWindow={source.Part("period")}"
                : source.Part("media") == "tv" ? "/api/v1/discover/tv/upcoming?" : "/api/v1/discover/movies/upcoming?";
            var items = new List<SourceItem>();
            for (var page = 1; page <= MaxChartItems / 20 && items.Count < MaxChartItems; page++)
            {
                var json = await SeerrGetAsync(baseUrl, config.JellyseerrApiKey, path + (path.EndsWith('?') ? string.Empty : "&") + "page=" + page.ToString(CultureInfo.InvariantCulture), cancellationToken).ConfigureAwait(false)
                    ?? throw new SourceHttpException("upstream_error", "Seerr didn't return the chart.");
                using var doc = JsonDocument.Parse(json);
                var defaultType = source.Part("media") is "movie" or "tv" ? source.Part("media") : null;
                items.AddRange(ListArray(doc.RootElement, "results").Select(p => SeerrItem(p, defaultType)).OfType<SourceItem>());
                if (page >= (Int(doc.RootElement, "totalPages") ?? 1))
                {
                    break;
                }
            }

            var chart = items.Take(MaxChartItems).ToList();
            return Done(source, "seerr", null, chart, chart.Count, false);
        }

        private async Task<string?> SeerrGetAsync(string baseUrl, string apiKey, string path, CancellationToken cancellationToken)
        {
            using var lease = await _limiter.AcquireAsync("source-fetch", false, cancellationToken).ConfigureAwait(false);
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(Timeout);
            var url = baseUrl + path;
            try
            {
                var client = SeerrHttpHelper.CreateClient(_httpClientFactory);
                using var request = SeerrHttpHelper.BuildRequest(HttpMethod.Get, url, apiKey);
                using var response = await client.SendAsync(request, timeout.Token).ConfigureAwait(false);
                var (json, error) = await SeerrHttpHelper.ReadResponseAsync(response, url, timeout.Token).ConfigureAwait(false);
                if (json != null)
                {
                    return json;
                }

                if (response.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.InternalServerError)
                {
                    return null;
                }

                throw new SourceHttpException("upstream_error", error?.UserMessage ?? "Seerr returned an error.");
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                throw new SourceHttpException("timeout", "Seerr took too long to answer.");
            }
            catch (HttpRequestException)
            {
                throw new SourceHttpException("upstream_error", "Can't reach Seerr right now.");
            }
        }

        private static SourceItem? TmdbItem(JsonElement element, string? defaultType, string? dateField)
        {
            var mediaType = Str(element, "media_type") ?? defaultType;
            if (mediaType is not ("movie" or "tv"))
            {
                return null;
            }

            var id = Int(element, "id");
            if (id is not > 0)
            {
                return null;
            }

            var title = mediaType == "movie" ? Str(element, "title") : Str(element, "name");
            var date = Str(element, dateField ?? (mediaType == "movie" ? "release_date" : "first_air_date"));
            return new SourceItem(mediaType, id, null, null, title, YearOf(date), null, null, null);
        }

        private static SourceItem? SeerrItem(JsonElement element, string? defaultType)
        {
            var mediaType = Str(element, "mediaType") ?? defaultType;
            if (mediaType is not ("movie" or "tv"))
            {
                return null;
            }

            var id = Int(element, "id");
            if (id is not > 0)
            {
                return null;
            }

            var title = mediaType == "movie" ? Str(element, "title") : Str(element, "name");
            var date = mediaType == "movie" ? Str(element, "releaseDate") : Str(element, "firstAirDate");
            return new SourceItem(mediaType, id, null, null, title, YearOf(date), null, null, null);
        }

        // ── Trakt ───────────────────────────────────────────────────────────

        private async Task<SourceFetchResult> TraktAsync(ParsedSourceUrl source, CancellationToken cancellationToken)
        {
            var clientId = Config?.TraktClientId?.Trim();
            if (string.IsNullOrEmpty(clientId))
            {
                return SourceFetchResult.Fail(source, "trakt_not_configured", "Trakt lists need a Trakt client ID in Jellyfin Enhanced's settings.");
            }

            var headers = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["trakt-api-version"] = "2",
                ["trakt-api-key"] = clientId,
            };
            string path;
            string? defaultType = null;
            var cap = MaxItems;
            switch (source.Shape)
            {
                case "list":
                    path = $"/users/{Esc(source.Part("user"))}/lists/{Esc(source.Part("list"))}/items/movie,show,season,episode";
                    break;
                case "watchlist":
                    path = $"/users/{Esc(source.Part("user"))}/watchlist";
                    break;
                case "listid":
                    path = $"/lists/{Esc(source.Part("list"))}/items/movie,show,season,episode";
                    break;
                default:
                    var media = source.Part("media");
                    defaultType = media == "shows" ? "show" : "movie";
                    path = $"/{media}/{source.Part("chart")}" + (source.Part("period").Length > 0 ? "/" + source.Part("period") : string.Empty);
                    cap = MaxChartItems;
                    break;
            }

            var items = new List<SourceItem>();
            var truncated = false;
            var total = 0;
            for (var page = 1; page <= 20; page++)
            {
                var url = "https://api.trakt.tv" + path + "?page=" + page.ToString(CultureInfo.InvariantCulture) + "&limit=100";
                var response = await SendAsync(HttpMethod.Get, url, headers, null, cancellationToken).ConfigureAwait(false);
                if (response.Status == 404)
                {
                    return page == 1 ? SourceFetchResult.Fail(source, "not_found", "Trakt didn't find this list (only public lists can be imported).") : throw new SourceHttpException("upstream_error", "Trakt stopped answering while reading the list.");
                }

                if (response.Status is 401 or 403)
                {
                    return SourceFetchResult.Fail(source, "trakt_unauthorized", "Trakt refused the request: check the Trakt client ID, and that the list is public.");
                }

                if (response.Status != 200 || response.Body == null)
                {
                    throw Upstream(response, "Trakt");
                }

                using var doc = JsonDocument.Parse(response.Body);
                if (doc.RootElement.ValueKind != JsonValueKind.Array)
                {
                    throw new InvalidDataException("unexpected Trakt JSON");
                }

                var pageItems = doc.RootElement.EnumerateArray().Select(e => TraktItem(e, defaultType)).OfType<SourceItem>().ToList();
                items.AddRange(pageItems);
                var pages = response.Headers.TryGetValue("X-Pagination-Page-Count", out var countText) && int.TryParse(countText, NumberStyles.None, CultureInfo.InvariantCulture, out var count) ? count : 1;
                total = response.Headers.TryGetValue("X-Pagination-Item-Count", out var itemText) && int.TryParse(itemText, NumberStyles.None, CultureInfo.InvariantCulture, out var itemCount) ? itemCount : items.Count;
                if (items.Count >= cap)
                {
                    truncated = source.Shape != "chart" && (items.Count > cap || page < pages);
                    break;
                }

                if (page >= pages || pageItems.Count == 0)
                {
                    break;
                }
            }

            var capped = items.Take(cap).ToList();
            return Done(source, "trakt", null, capped, Math.Max(total, capped.Count), truncated);
        }

        private static SourceItem? TraktItem(JsonElement element, string? defaultType)
        {
            if (element.ValueKind != JsonValueKind.Object)
            {
                return null;
            }

            var type = Str(element, "type") ?? (element.TryGetProperty("episode", out _) ? "episode" : element.TryGetProperty("season", out _) ? "season"
                : element.TryGetProperty("movie", out _) ? "movie" : element.TryGetProperty("show", out _) ? "show" : defaultType);
            var note = Str(element, "notes");
            JsonElement show = default;
            var hasShow = element.TryGetProperty("show", out show) && show.ValueKind == JsonValueKind.Object;
            switch (type)
            {
                case "movie":
                {
                    var movie = element.TryGetProperty("movie", out var m) && m.ValueKind == JsonValueKind.Object ? m : element;
                    var (tmdb, imdb, _) = TraktIds(movie);
                    return new SourceItem("movie", tmdb, imdb, null, Str(movie, "title"), Year(Int(movie, "year")), null, null, note);
                }

                case "show":
                {
                    var target = hasShow ? show : element;
                    var (tmdb, imdb, tvdb) = TraktIds(target);
                    return new SourceItem("tv", tmdb, imdb, tvdb, Str(target, "title"), Year(Int(target, "year")), null, null, note);
                }

                case "season":
                {
                    if (!hasShow || !element.TryGetProperty("season", out var season) || season.ValueKind != JsonValueKind.Object)
                    {
                        return null;
                    }

                    var (tmdb, imdb, tvdb) = TraktIds(show);
                    return new SourceItem("tv", tmdb, imdb, tvdb, Str(show, "title"), Year(Int(show, "year")), Int(season, "number"), null, note);
                }

                case "episode":
                {
                    if (!hasShow || !element.TryGetProperty("episode", out var episode) || episode.ValueKind != JsonValueKind.Object)
                    {
                        return null;
                    }

                    var (tmdb, imdb, tvdb) = TraktIds(show);
                    return new SourceItem("tv", tmdb, imdb, tvdb, Str(show, "title"), Year(Int(show, "year")), Int(episode, "season"), Int(episode, "number"), note);
                }

                default:
                    return null;
            }
        }

        private static (int? Tmdb, string? Imdb, int? Tvdb) TraktIds(JsonElement element)
        {
            if (!element.TryGetProperty("ids", out var ids) || ids.ValueKind != JsonValueKind.Object)
            {
                return (null, null, null);
            }

            var tmdb = Int(ids, "tmdb");
            var tvdb = Int(ids, "tvdb");
            return (tmdb is > 0 ? tmdb : null, ValidImdb(Str(ids, "imdb")), tvdb is > 0 ? tvdb : null);
        }

        // ── IMDb (unofficial) ───────────────────────────────────────────────

        private async Task<SourceFetchResult> ImdbAsync(ParsedSourceUrl source, CancellationToken cancellationToken)
        {
            if (Config?.ListPlaceholdersImdbEnabled != true)
            {
                return SourceFetchResult.Fail(source, "imdb_disabled", "IMDb lists are turned off on this server. Mirror the list on MDBList and import that URL, or paste an IMDb CSV export.");
            }

            var partial = false;

            const string titleFields = "id titleText{text} titleType{id} releaseYear{year} series{series{id titleText{text}} displayableEpisodeNumber{displayableSeason{text} episodeNumber{text}}}";
            string query;
            var variables = new Dictionary<string, object?>(StringComparer.Ordinal) { ["first"] = 250, ["after"] = null };
            string[] connectionPath;
            switch (source.Shape)
            {
                case "chart":
                    query = "query($first:Int!,$after:String){chartTitles(chart:{chartType:" + ImdbCharts[source.Part("chart")] + "},first:$first,after:$after){total edges{node{" + titleFields + "}} pageInfo{hasNextPage endCursor}}}";
                    connectionPath = new[] { "chartTitles" };
                    break;
                case "list":
                    query = "query($id:ID!,$first:Int!,$after:ID){list(id:$id){name{originalText} items(first:$first,after:$after){total edges{node{item{... on Title{" + titleFields + "}}}} pageInfo{hasNextPage endCursor}}}}";
                    variables["id"] = source.Part("id");
                    connectionPath = new[] { "list", "items" };
                    break;
                default:
                    var user = source.Part("user");
                    if (user.StartsWith("p.", StringComparison.Ordinal))
                    {
                        var (profile, _) = await ImdbQueryAsync("query($p:ID!){userProfile(input:{profileId:$p}){userId}}", new Dictionary<string, object?> { ["p"] = user }, cancellationToken).ConfigureAwait(false);
                        user = profile.TryGetProperty("userProfile", out var up) && up.ValueKind == JsonValueKind.Object ? Str(up, "userId") ?? string.Empty : string.Empty;
                        if (!Regex.IsMatch(user, "^ur[0-9]{5,12}$"))
                        {
                            return SourceFetchResult.Fail(source, "not_found", "IMDb didn't find this watchlist (only public watchlists can be imported).");
                        }
                    }

                    query = "query($u:ID!,$first:Int!,$after:ID){predefinedList(classType:WATCH_LIST,userId:$u){items(first:$first,after:$after){total edges{node{item{... on Title{" + titleFields + "}}}} pageInfo{hasNextPage endCursor}}}}";
                    variables["u"] = user;
                    connectionPath = new[] { "predefinedList", "items" };
                    break;
            }

            var items = new List<SourceItem>();
            string? title = null;
            var total = 0;
            var truncated = false;
            for (var page = 0; page < 10; page++)
            {
                var (data, pagePartial) = await ImdbQueryAsync(query, variables, cancellationToken).ConfigureAwait(false);
                partial |= pagePartial;
                if (source.Shape == "list" && data.TryGetProperty("list", out var list) && list.ValueKind == JsonValueKind.Object
                    && list.TryGetProperty("name", out var name) && name.ValueKind == JsonValueKind.Object)
                {
                    title ??= Str(name, "originalText");
                }

                var connection = data;
                foreach (var segment in connectionPath)
                {
                    if (!connection.TryGetProperty(segment, out connection) || connection.ValueKind != JsonValueKind.Object)
                    {
                        return SourceFetchResult.Fail(source, "not_found", "IMDb didn't return this list (private or missing).");
                    }
                }

                total = Int(connection, "total") ?? total;
                foreach (var edge in Array(connection, "edges"))
                {
                    if (!edge.TryGetProperty("node", out var node))
                    {
                        continue;
                    }

                    var item = node.TryGetProperty("item", out var inner) ? inner : node;
                    var parsed = ImdbItem(item);
                    if (parsed != null)
                    {
                        items.Add(parsed);
                    }
                }

                if (items.Count >= MaxItems)
                {
                    truncated = true;
                    break;
                }

                if (!connection.TryGetProperty("pageInfo", out var pageInfo) || !pageInfo.TryGetProperty("hasNextPage", out var next) || next.ValueKind != JsonValueKind.True)
                {
                    break;
                }

                variables["after"] = Str(pageInfo, "endCursor");
                if (variables["after"] == null)
                {
                    break;
                }
            }

            var capped = items.Take(MaxItems).ToList();
            return new SourceFetchResult
            {
                Ok = true,
                Kind = source.Kind,
                Provider = "imdb",
                CanonicalUrl = source.CanonicalUrl,
                Title = title,
                Unofficial = true,
                Items = capped,
                Total = Math.Max(total, capped.Count),
                Truncated = truncated || total > MaxItems,
                Partial = partial,
            };
        }

        // Returns the data and whether GraphQL reported errors next to it (a partial answer: nulled items are missing).
        private async Task<(JsonElement Data, bool Partial)> ImdbQueryAsync(string query, Dictionary<string, object?> variables, CancellationToken cancellationToken)
        {
            var body = JsonSerializer.Serialize(new Dictionary<string, object?> { ["query"] = query, ["variables"] = variables });
            var headers = new Dictionary<string, string>(StringComparer.Ordinal) { ["x-imdb-client-name"] = "jellyfin-enhanced" };
            var response = await SendAsync(HttpMethod.Post, ImdbGraphQl, headers, body, cancellationToken).ConfigureAwait(false);
            if (response.Status != 200 || response.Body == null)
            {
                throw Upstream(response, "IMDb");
            }

            using var doc = JsonDocument.Parse(response.Body);
            var root = doc.RootElement;
            var partial = false;
            if (root.TryGetProperty("errors", out var errors) && errors.ValueKind == JsonValueKind.Array && errors.GetArrayLength() > 0)
            {
                partial = true;
                var code = errors[0].TryGetProperty("extensions", out var ext) ? Str(ext, "code") : null;
                if (code is "FORBIDDEN" or "RESOURCE_NOT_FOUND" or "NOT_FOUND")
                {
                    throw new SourceHttpException("not_found", "IMDb didn't return this list (private or missing).");
                }
            }

            if (!root.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Object)
            {
                throw new SourceHttpException("upstream_error", "IMDb's unofficial API returned an error; it may have changed. Try the MDBList mirror instead.");
            }

            if (partial)
            {
                _logger.Warning("[ListPlaceholders] IMDb answered with errors next to data; the fetch is treated as partial (nothing will be removed).");
            }

            return (data.Clone(), partial);
        }

        private static SourceItem? ImdbItem(JsonElement item)
        {
            var id = ValidImdb(Str(item, "id"));
            if (id == null)
            {
                return null;
            }

            var type = item.TryGetProperty("titleType", out var titleType) && titleType.ValueKind == JsonValueKind.Object ? Str(titleType, "id") : null;
            var title = item.TryGetProperty("titleText", out var text) && text.ValueKind == JsonValueKind.Object ? Str(text, "text") : null;
            var year = item.TryGetProperty("releaseYear", out var release) && release.ValueKind == JsonValueKind.Object ? Year(Int(release, "year")) : null;
            switch (type)
            {
                case "tvSeries" or "tvMiniSeries":
                    return new SourceItem("tv", null, id, null, title, year, null, null, null);
                case "tvEpisode":
                {
                    if (!item.TryGetProperty("series", out var series) || series.ValueKind != JsonValueKind.Object
                        || !series.TryGetProperty("series", out var show) || show.ValueKind != JsonValueKind.Object)
                    {
                        return null;
                    }

                    var showId = ValidImdb(Str(show, "id"));
                    var showTitle = show.TryGetProperty("titleText", out var st) && st.ValueKind == JsonValueKind.Object ? Str(st, "text") : null;
                    int? season = null;
                    int? episode = null;
                    if (series.TryGetProperty("displayableEpisodeNumber", out var number) && number.ValueKind == JsonValueKind.Object)
                    {
                        if (number.TryGetProperty("displayableSeason", out var s) && s.ValueKind == JsonValueKind.Object && int.TryParse(Str(s, "text"), NumberStyles.None, CultureInfo.InvariantCulture, out var sn))
                        {
                            season = sn;
                        }

                        if (number.TryGetProperty("episodeNumber", out var e) && e.ValueKind == JsonValueKind.Object && int.TryParse(Str(e, "text"), NumberStyles.None, CultureInfo.InvariantCulture, out var en))
                        {
                            episode = en;
                        }
                    }

                    return showId == null || !season.HasValue || !episode.HasValue ? null : new SourceItem("tv", null, showId, null, showTitle, null, season, episode, title);
                }

                case "movie" or "tvMovie" or "short" or "tvShort" or "video" or "tvSpecial":
                    return new SourceItem("movie", null, id, null, title, year, null, null, null);
                default:
                    return null; // games, podcasts, music videos, people
            }
        }

        // ── chronolists ─────────────────────────────────────────────────────

        // No API: the universe page itself (same host only, no redirects, size/time limits like every source), read
        // by ChronolistsPage. The entries carry exact TMDB ids and metadata, so the result is "exact".
        private async Task<SourceFetchResult> ChronolistsAsync(ParsedSourceUrl source, CancellationToken cancellationToken)
        {
            var response = await SendAsync(HttpMethod.Get, "https://chronolists.com/" + Esc(source.Part("slug")), null, null, cancellationToken, "text/html").ConfigureAwait(false);
            if (response.Status == 404)
            {
                return SourceFetchResult.Fail(source, "not_found", "chronolists.com has no watch order at this address.");
            }

            if (response.Status != 200 || response.Body == null)
            {
                throw Upstream(response, "chronolists.com");
            }

            if (!ChronolistsPage.TryRead(response.Body, out var list, out var error))
            {
                if (error == ChronolistsPage.NotAWatchOrder)
                {
                    return SourceFetchResult.Fail(source, "not_found", "This chronolists.com page isn't a watch order.");
                }

                _logger.Warning($"[ListPlaceholders] {source.CanonicalUrl} no longer has the watch-order data JE reads, or too many of its entries can't be read; chronolists.com may have changed its pages.");
                return SourceFetchResult.Fail(source, ChronolistsPage.FormatChanged, "chronolists.com changed how its pages are built, so JE can't read this watch order any more. Nothing was changed; an update of Jellyfin Enhanced is needed.");
            }

            if (list!.Unusable > 0)
            {
                _logger.Info($"[ListPlaceholders] {source.CanonicalUrl}: {list.Unusable.ToString(CultureInfo.InvariantCulture)} of {list.Total.ToString(CultureInfo.InvariantCulture)} entries couldn't be read; the fetch counts as partial (nothing is removed).");
            }

            return new SourceFetchResult
            {
                Ok = true,
                Kind = source.Kind,
                Provider = "chronolists",
                CanonicalUrl = source.CanonicalUrl,
                Title = list.Title,
                Items = list.Items,
                Total = list.Total,
                Truncated = list.Truncated,
                Partial = list.Unusable > 0,
                Exact = true,
            };
        }

        // ── HTTP ────────────────────────────────────────────────────────────

        private async Task<HttpResult> SendAsync(HttpMethod method, string url, IReadOnlyDictionary<string, string>? headers, string? body, CancellationToken cancellationToken, string accept = "application/json")
        {
            for (var attempt = 0; ; attempt++)
            {
                var result = await SendOnceAsync(method, url, headers, body, accept, cancellationToken).ConfigureAwait(false);
                if (result.Status == 429 && attempt == 0 && result.RetryAfter is >= 0 and <= MaxRetryWaitSeconds)
                {
                    await Task.Delay(TimeSpan.FromSeconds(Math.Max(1, result.RetryAfter.Value)), cancellationToken).ConfigureAwait(false);
                    continue;
                }

                return result;
            }
        }

        private async Task<HttpResult> SendOnceAsync(HttpMethod method, string url, IReadOnlyDictionary<string, string>? headers, string? body, string accept, CancellationToken cancellationToken)
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(Timeout);
            try
            {
                // The no-redirect client: a source must answer from the fixed host, never send JE elsewhere.
                var client = SeerrHttpHelper.CreateClient(_httpClientFactory);
                using var request = new HttpRequestMessage(method, url);
                request.Headers.UserAgent.ParseAdd(SeerrHttpHelper.UserAgent + " (+https://github.com/n00bcodr/Jellyfin-Enhanced)");
                request.Headers.Accept.ParseAdd(accept);
                if (headers != null)
                {
                    foreach (var (name, value) in headers)
                    {
                        request.Headers.TryAddWithoutValidation(name, value);
                    }
                }

                if (body != null)
                {
                    request.Content = new StringContent(body, Encoding.UTF8, "application/json");
                }

                using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token).ConfigureAwait(false);
                var status = (int)response.StatusCode;
                int? retryAfter = null;
                if (response.Headers.RetryAfter is { } ra)
                {
                    retryAfter = ra.Delta.HasValue ? (int)Math.Ceiling(ra.Delta.Value.TotalSeconds)
                        : ra.Date.HasValue ? (int)Math.Max(0, Math.Ceiling((ra.Date.Value - DateTimeOffset.UtcNow).TotalSeconds)) : null;
                }

                var responseHeaders = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                foreach (var header in response.Headers)
                {
                    responseHeaders[header.Key] = string.Join(',', header.Value);
                }

                string? text = null;
                if (status == 200)
                {
                    if (response.Content.Headers.ContentLength > MaxBodyBytes)
                    {
                        throw new SourceHttpException("too_large", "The list is too large to import.");
                    }

                    await using var stream = await response.Content.ReadAsStreamAsync(timeout.Token).ConfigureAwait(false);
                    using var buffer = new MemoryStream();
                    var chunk = new byte[81920];
                    int read;
                    while ((read = await stream.ReadAsync(chunk, timeout.Token).ConfigureAwait(false)) > 0)
                    {
                        if (buffer.Length + read > MaxBodyBytes)
                        {
                            throw new SourceHttpException("too_large", "The list is too large to import.");
                        }

                        buffer.Write(chunk, 0, read);
                    }

                    text = Encoding.UTF8.GetString(buffer.GetBuffer(), 0, (int)buffer.Length);
                }

                return new HttpResult(status, text, retryAfter, responseHeaders);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                throw new SourceHttpException("timeout", "The list site took too long to answer.");
            }
            catch (HttpRequestException ex)
            {
                _logger.Debug($"[ListPlaceholders] Source request failed: {ex.Message}");
                throw new SourceHttpException("unreachable", "Can't reach the list site right now.");
            }
        }

        private static SourceHttpException Upstream(HttpResult response, string site) => response.Status == 429
            ? new SourceHttpException("rate_limited", $"{site} is rate limiting; try again later.", response.RetryAfter)
            : new SourceHttpException("upstream_error", $"{site} returned an error ({response.Status.ToString(CultureInfo.InvariantCulture)}).");

        // ── Helpers ─────────────────────────────────────────────────────────

        private static SourceFetchResult Done(ParsedSourceUrl source, string provider, string? title, List<SourceItem> items, int total, bool truncated)
        {
            var capped = items.Count > MaxItems ? items.Take(MaxItems).ToList() : items;
            return new SourceFetchResult
            {
                Ok = true,
                Kind = source.Kind,
                Provider = provider,
                CanonicalUrl = source.CanonicalUrl,
                Title = title == null ? null : PlaceholderRules.CleanText(title) is var t && t.Length > PlaceholderRules.MaxTitle ? t[..PlaceholderRules.MaxTitle] : PlaceholderRules.CleanText(title),
                Items = capped,
                Total = Math.Max(total, capped.Count),
                Truncated = truncated || items.Count > MaxItems,
            };
        }

        // Makes room for a result of `incoming` entries: expired results go, then the oldest until both the result and
        // the entry budgets hold (F29: a stream of distinct URLs can't grow the cache without bound).
        private void PruneCache(int incoming)
        {
            var now = DateTime.UtcNow;
            var count = 0;
            var items = incoming;
            var live = new List<KeyValuePair<string, (DateTime ExpiresUtc, SourceFetchResult Result)>>();
            foreach (var entry in _cache)
            {
                if (entry.Value.ExpiresUtc <= now)
                {
                    _cache.TryRemove(entry.Key, out _);
                    continue;
                }

                live.Add(entry);
                count++;
                items += entry.Value.Result.Items.Count;
            }

            foreach (var entry in live.OrderBy(e => e.Value.ExpiresUtc))
            {
                if (count < MaxCacheEntries && items <= MaxCachedItems)
                {
                    break;
                }

                if (_cache.TryRemove(entry.Key, out var removed))
                {
                    count--;
                    items -= removed.Result.Items.Count;
                }
            }
        }

        // Admits one upstream fetch of `caller`, or returns null with the seconds until one is allowed again.
        private IDisposable? TryAdmit(string caller, out int retryAfter)
        {
            var budget = _callers.GetOrAdd(caller, _ => new CallerBudget());
            lock (budget)
            {
                var now = DateTime.UtcNow;
                while (budget.Recent.Count > 0 && budget.Recent.Peek() <= now - CallerWindow)
                {
                    budget.Recent.Dequeue();
                }

                if (budget.Active >= MaxConcurrentFetchesPerCaller)
                {
                    retryAfter = 2;
                    return null;
                }

                if (budget.Recent.Count >= MaxFetchesPerCaller)
                {
                    retryAfter = Math.Max(1, (int)Math.Ceiling((budget.Recent.Peek() + CallerWindow - now).TotalSeconds));
                    return null;
                }

                budget.Active++;
                budget.Recent.Enqueue(now);
                retryAfter = 0;
                return new Admission(budget);
            }
        }

        // An array the answer must have: a missing one means an error answer, not an empty list (F16).
        private static IEnumerable<JsonElement> ListArray(JsonElement element, string name) =>
            element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var array) && array.ValueKind == JsonValueKind.Array
                ? array.EnumerateArray()
                : throw new InvalidDataException("the answer has no \"" + name + "\" list");

        private static IEnumerable<JsonElement> Array(JsonElement element, string name) =>
            element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var array) && array.ValueKind == JsonValueKind.Array ? array.EnumerateArray() : Enumerable.Empty<JsonElement>();

        private static string Esc(string value) => Uri.EscapeDataString(value);

        private static int? Int(JsonElement element, string name)
        {
            if (element.ValueKind != JsonValueKind.Object || !element.TryGetProperty(name, out var value))
            {
                return null;
            }

            return value.ValueKind switch
            {
                JsonValueKind.Number when value.TryGetInt32(out var number) => number,
                JsonValueKind.String when int.TryParse(value.GetString(), NumberStyles.None, CultureInfo.InvariantCulture, out var parsed) => parsed,
                _ => null,
            };
        }

        private static string? Str(JsonElement element, string name)
        {
            if (element.ValueKind != JsonValueKind.Object || !element.TryGetProperty(name, out var value) || value.ValueKind != JsonValueKind.String)
            {
                return null;
            }

            var text = PlaceholderRules.CleanText(value.GetString());
            return text.Length == 0 ? null : text.Length > 300 ? text[..300] : text;
        }

        private static string? ValidImdb(string? value) => value != null && Regex.IsMatch(value, "^tt[0-9]{5,10}$") ? value : null;

        private static int? Year(int? year) => year is >= 1870 and <= 2100 ? year : null;

        private static int? YearOf(string? date) =>
            date != null && date.Length >= 4 && int.TryParse(date.AsSpan(0, 4), NumberStyles.None, CultureInfo.InvariantCulture, out var year) ? Year(year) : null;

        private sealed record HttpResult(int Status, string? Body, int? RetryAfter, IReadOnlyDictionary<string, string> Headers);

        // One caller's running upstream fetches and the start times within the window (guarded by locking the instance).
        private sealed class CallerBudget
        {
            public int Active { get; set; }

            public Queue<DateTime> Recent { get; } = new();
        }

        private sealed class Admission(CallerBudget budget) : IDisposable
        {
            private int _disposed;

            public void Dispose()
            {
                if (Interlocked.Exchange(ref _disposed, 1) == 0)
                {
                    lock (budget)
                    {
                        budget.Active--;
                    }
                }
            }
        }

        private sealed class SourceHttpException(string code, string message, int? retryAfter = null) : Exception(message)
        {
            public string Code { get; } = code;

            public int? RetryAfter { get; } = retryAfter;
        }
    }
}
