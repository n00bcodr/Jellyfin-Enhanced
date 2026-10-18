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
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Import;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Sources
{
    /// <summary>
    /// Server-side list fetching (design §8, F4–F6), preview and sync alike. Every provider has its own admin switch
    /// (<see cref="ListImportFlags.Provider"/>): a provider that is off, or lacks its credential, is never contacted and
    /// answers a typed failure.
    /// <list type="bullet">
    /// <item><b>MDBList</b>: the public <c>/json</c> (no key). The API (<c>unified=true</c>, JE's MDBList key, charged to
    /// <see cref="MdblistService"/>'s quota bookkeeping) only when an administrator asks for it deliberately
    /// (<see cref="SourceFetchOptions.AllowMdblistApi"/>, its own switch) or a link is pinned to it; a list the public
    /// JSON refuses is <see cref="SourceFailures.MdblistNotPublic"/>, never a silent API read.</item>
    /// <item><b>TMDB</b>: user lists and charts need JE's TMDB key (through <see cref="TmdbResponseCache"/>, always read
    /// fresh); collections, trending and movie "upcoming" may go through Seerr without one, labelled
    /// (<c>seerr_fallback</c>). The provider used is reported and, for linked lists, pinned: a pinned provider that can't be
    /// used is <see cref="SourceFailures.ProviderPinned"/>, never another provider.</item>
    /// <item><b>Trakt</b>: needs the Trakt client id (secrets store); without it <see cref="SourceFailures.TraktNotConfigured"/>.</item>
    /// <item><b>IMDb</b>: only with the administrator's explicit opt-in, through IMDb's unofficial GraphQL API, labelled
    /// (<c>imdb_unofficial</c>). An answer that parses to no entries is a failure, never an empty list.</item>
    /// <item><b>Chronolists</b>: the watch-order page's embedded data (<see cref="ChronolistsPage"/>); exact ids, no key.</item>
    /// <item><b>Letterboxd</b> is never fetched (<see cref="ListSourceUrl"/> answers with guidance).</item>
    /// </list>
    /// Requests go only to fixed hosts built from the parsed parts (SSRF guard), over <see cref="SourceHttp"/> (TMDB
    /// included): never a redirect (a 3xx is <c>source_redirected</c>) and only to public addresses checked at connect time
    /// (else <c>source_address_blocked</c>), with a 20 s timeout, an 8 MiB body cap and a 1000-entry cap; a short
    /// Retry-After (≤ 5 s) is honoured once, longer ones are reported. Every transmission, a 429 retry included, is charged
    /// to the provider's admission (and the MDBList API's daily quota) before it is sent; no reservation, no retry.
    /// Paging never stops early as "complete": a missing continuation, an empty page before the last one or a missing page
    /// count is <see cref="SourceFetchResult.Partial"/>, and a page limit reached with pages left is truncated.
    /// An answer without the list array it should have is an error, never an empty list. Successful fetches are cached
    /// for 5 minutes (bounded, keyed by the credentials' identity) so preview → apply → link doesn't fetch twice.
    /// Reads are bounded by <see cref="SourceReadLimits"/>: at most a few at a time, per caller per window, and per
    /// provider per hour (<see cref="ISourceReadAdmission"/>, one admission per upstream request).
    /// </summary>
    public sealed class ListSourceFetcher : IListSourceFetcher
    {
        /// <summary>Entry cap per list.</summary>
        public const int MaxItems = 1000;

        /// <summary>Entries read from a chart (charts are endless).</summary>
        public const int MaxChartItems = 100;

        /// <summary>Result cache lifetime.</summary>
        public static readonly TimeSpan CacheTtl = TimeSpan.FromMinutes(5);

        /// <summary>Results kept in the result cache (oldest go first).</summary>
        internal const int MaxCacheEntries = 100;

        /// <summary>List entries kept in the result cache over all results (oldest go first).</summary>
        internal const int MaxCachedItems = 20_000;

        private const int MaxBodyBytes = 8 * 1024 * 1024;
        private const int MaxListPages = 100;
        private const int TraktPageSize = 100;
        private const int MaxTraktPages = 20;
        private const int MaxImdbPages = 10;
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
        private readonly MetadataCallLimiter _limiter;
        private readonly Logger _logger;
        private readonly SourceReadLimits _limits;
        private readonly ISourceReadAdmission _admission;
        private readonly SemaphoreSlim _gate;
        private readonly ConcurrentDictionary<string, (DateTime ExpiresUtc, SourceFetchResult Result)> _cache = new(StringComparer.Ordinal);
        private readonly ConcurrentDictionary<string, CallerBudget> _callers = new(StringComparer.Ordinal);

        /// <summary>Creates the fetcher (singleton).</summary>
        /// <param name="httpClientFactory">HTTP client factory.</param>
        /// <param name="tmdb">TMDB response cache.</param>
        /// <param name="mdblist">MDBList service (quota bookkeeping).</param>
        /// <param name="limiter">Shared metadata limiter (Seerr fallbacks).</param>
        /// <param name="logger">JE logger.</param>
        public ListSourceFetcher(IHttpClientFactory httpClientFactory, TmdbResponseCache tmdb, MdblistService mdblist, MetadataCallLimiter limiter, Logger logger)
            : this(httpClientFactory, tmdb, mdblist, limiter, logger, null, null)
        {
        }

        /// <summary>Creates the fetcher with explicit read limits (tests; 4c2b's admission).</summary>
        /// <param name="httpClientFactory">HTTP client factory.</param>
        /// <param name="tmdb">TMDB cache or null.</param>
        /// <param name="mdblist">MDBList service or null (no quota bookkeeping).</param>
        /// <param name="limiter">Limiter.</param>
        /// <param name="logger">Logger.</param>
        /// <param name="limits">Read limits (null: defaults).</param>
        /// <param name="admission">Per-provider admission (null: rolling in-memory budgets of <paramref name="limits"/>).</param>
        internal ListSourceFetcher(IHttpClientFactory httpClientFactory, TmdbResponseCache? tmdb, MdblistService? mdblist, MetadataCallLimiter limiter, Logger logger, SourceReadLimits? limits, ISourceReadAdmission? admission)
        {
            _httpClientFactory = httpClientFactory;
            _tmdb = tmdb;
            _mdblist = mdblist;
            _limiter = limiter;
            _logger = logger;
            _limits = limits ?? new SourceReadLimits();
            _admission = admission ?? new RollingSourceReadAdmission(_limits);
            _gate = new SemaphoreSlim(Math.Max(1, _limits.MaxConcurrent), Math.Max(1, _limits.MaxConcurrent));
        }

        private static Configuration.PluginConfiguration? Config => JellyfinEnhanced.Instance?.Configuration;

        private static string TmdbKey => Config?.GetTmdbApiKey()?.Trim() ?? string.Empty;

        private static string MdblistKey => Config?.GetMdblistApiKey()?.Trim() ?? string.Empty;

        private static string TraktKey => Config?.GetListTraktApiKey()?.Trim() ?? string.Empty;

        /// <summary>True when Seerr is enabled and configured (the labelled fallback for some TMDB charts).</summary>
        internal static bool SeerrConfigured(out string baseUrl, out string apiKey)
        {
            var config = Config;
            baseUrl = string.Empty;
            apiKey = string.Empty;
            if (config == null || !config.JellyseerrEnabled || string.IsNullOrWhiteSpace(config.JellyseerrUrls) || string.IsNullOrWhiteSpace(config.GetJellyseerrApiKey()))
            {
                return false;
            }

            baseUrl = config.JellyseerrUrls.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries).Select(u => u.Trim().TrimEnd('/')).FirstOrDefault(u => u.Length > 0) ?? string.Empty;
            apiKey = config.GetJellyseerrApiKey();
            return baseUrl.Length > 0;
        }

        /// <inheritdoc />
        public SourceProvidersDto Providers(Jellyfin.Database.Implementations.Entities.User caller)
        {
            var config = Config;
            var tmdb = ListImportFlags.Provider(config, SourceKinds.Tmdb);
            var hasKey = TmdbKey.Length > 0 && _tmdb != null;
            return new SourceProvidersDto
            {
                Import = ListImportFlags.Import(config),
                Sources = ListImportFlags.Sources(config),
                Mdblist = ListImportFlags.Provider(config, SourceKinds.Mdblist),
                MdblistApi = ListImportFlags.MdblistApi(config) && MdblistKey.Length > 0 && ListAccessService.IsAdmin(caller),
                TmdbLists = tmdb && hasKey,
                TmdbCharts = tmdb && (hasKey || SeerrConfigured(out _, out _)),
                Trakt = ListImportFlags.Provider(config, SourceKinds.Trakt) && TraktKey.Length > 0,
                Imdb = ListImportFlags.Provider(config, SourceKinds.Imdb),
                Chronolists = ListImportFlags.Provider(config, SourceKinds.Chronolists),
                MaxItems = MaxItems,
            };
        }

        /// <inheritdoc />
        public async Task<SourceFetchResult> FetchAsync(ParsedSourceUrl source, SourceFetchOptions options, CancellationToken cancellationToken)
        {
            // Provider switches and credentials are checked before the cache: a provider the admin just turned off stops
            // working at once, and nothing is sent to it.
            if (Unavailable(source, options) is { } unavailable)
            {
                return unavailable;
            }

            var cacheKey = source.CanonicalUrl + "|" + options.AllowMdblistApi + "|" + options.Provider + "|" + CredentialStamp();
            if (!options.Fresh && _cache.TryGetValue(cacheKey, out var cached) && cached.ExpiresUtc > DateTime.UtcNow)
            {
                return cached.Result;
            }

            // F29: a person's fetches that miss the cache go upstream only a few at a time and a bounded number per window.
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
                        SourceKinds.Trakt => await TraktAsync(source, options, cancellationToken).ConfigureAwait(false),
                        SourceKinds.Imdb => await ImdbAsync(source, options, cancellationToken).ConfigureAwait(false),
                        SourceKinds.Chronolists => await ChronolistsAsync(source, options, cancellationToken).ConfigureAwait(false),
                        _ => SourceFetchResult.Fail(source, ListSourceUrl.UnsupportedUrl, "This list URL isn't supported."),
                    };
                }
                catch (SourceHttpException ex)
                {
                    result = SourceFetchResult.Fail(source, ex.Code, ex.Message, ex.RetryAfter);
                }
                catch (Exception ex) when (ex is JsonException or InvalidDataException or FormatException)
                {
                    _logger.Warning($"[Lists] Couldn't read the list {source.CanonicalUrl}: {ex.Message}");
                    result = SourceFetchResult.Fail(source, "upstream_error", "The list site returned something JE can't read.");
                }

                if (result.Ok)
                {
                    PruneCache(result.Items.Count);
                    _cache[cacheKey] = (DateTime.UtcNow + CacheTtl, result);
                }
                else
                {
                    _logger.Info($"[Lists] Fetching {source.CanonicalUrl} failed: {result.ErrorCode}");
                }

                return result;
            }
            finally
            {
                _gate.Release();
            }
        }

        // Switches and credentials of each provider (no request is made without them).
        private static SourceFetchResult? Unavailable(ParsedSourceUrl source, SourceFetchOptions options)
        {
            var config = Config;
            if (source.Kind == SourceKinds.Imdb && !ListImportFlags.Provider(config, SourceKinds.Imdb))
            {
                return SourceFetchResult.Fail(source, SourceFailures.ImdbDisabled, "IMDb lists are turned off on this server (an unofficial source the administrator opts into). Mirror the list on MDBList and import that URL, or import an IMDb CSV export.");
            }

            if (!ListImportFlags.Provider(config, source.Kind))
            {
                return SourceFetchResult.Fail(source, SourceFailures.ProviderDisabled, "Lists from this site are turned off on this server.");
            }

            if (source.Kind == SourceKinds.Trakt && TraktKey.Length == 0)
            {
                return SourceFetchResult.Fail(source, SourceFailures.TraktNotConfigured, "Trakt lists need a Trakt client ID in Jellyfin Enhanced's settings.");
            }

            if (source.Kind == SourceKinds.Mdblist && (options.AllowMdblistApi || options.Provider == "mdblist-api"))
            {
                if (!ListImportFlags.MdblistApi(config) || MdblistKey.Length == 0)
                {
                    return SourceFetchResult.Fail(source, options.Provider == "mdblist-api" ? SourceFailures.ProviderPinned : SourceFailures.ProviderDisabled, "Reading MDBList lists through the MDBList API is turned off, or no MDBList key is saved.");
                }
            }

            return null;
        }

        // The identity (not the length) of every credential a fetch could use: another key never reuses this one's results.
        private static string CredentialStamp()
        {
            SeerrConfigured(out var seerrUrl, out var seerrKey);
            var material = string.Join('\n', TmdbKey, MdblistKey, TraktKey, seerrUrl, seerrKey);
            return Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(material)), 0, 8);
        }

        // One upstream request of a provider, out of its hourly budget (refused: a typed, retryable failure).
        private void Admit(string provider, SourceFetchOptions options)
        {
            if (!_admission.TryAdmit(provider, options.Background, out var retryAfter))
            {
                throw new SourceHttpException(SourceFailures.ReadBudgetExhausted, "Jellyfin Enhanced has read this list site a lot in the last hour; try again later.", retryAfter);
            }
        }

        // ── MDBList ─────────────────────────────────────────────────────────

        private async Task<SourceFetchResult> MdblistAsync(ParsedSourceUrl source, SourceFetchOptions options, CancellationToken cancellationToken)
        {
            var publicPath = source.Shape switch
            {
                "external" => $"/lists/{Esc(source.Part("user"))}/external/{source.Part("id")}/json",
                "official" => $"/lists/official/{source.Part("media")}/{Esc(source.Part("slug"))}/json",
                _ => $"/lists/{Esc(source.Part("user"))}/{Esc(source.Part("slug"))}/json",
            };

            // F4: the API (the server's key and quota) only on an administrator's deliberate request, or for a link pinned
            // to it; a link pinned to the public JSON never switches to it.
            var useApi = options.Provider == "mdblist-api" || (options.AllowMdblistApi && options.Provider != "mdblist");
            if (!useApi)
            {
                var response = await SendAsync("mdblist", options, HttpMethod.Get, "https://mdblist.com" + publicPath, null, null, cancellationToken).ConfigureAwait(false);
                if (response.Status == 200 && response.Body != null)
                {
                    return MdblistItems(source, "mdblist", response.Body, false);
                }

                if (response.Status is 401 or 403 or 404)
                {
                    return SourceFetchResult.Fail(source, SourceFailures.MdblistNotPublic, "MDBList doesn't serve this list publicly (it may be private, or not exist). An administrator can read a private list through the MDBList API.");
                }

                throw Upstream(response, "MDBList");
            }

            var key = MdblistKey;

            var apiPath = source.Shape switch
            {
                "external" => $"/external/lists/{source.Part("id")}/items",
                "official" => $"/lists/official/{Esc(source.Part("slug"))}/items",
                _ => $"/lists/{Esc(source.Part("user"))}/{Esc(source.Part("slug"))}/items",
            };
            var query = "?apikey=" + Uri.EscapeDataString(key) + "&limit=" + MaxItems.ToString(CultureInfo.InvariantCulture) + "&unified=true"
                + (source.Shape == "official" ? "&mediatype=" + (source.Part("media") == "shows" ? "show" : "movie") : string.Empty);
            // Each transmission (a 429 retry too) takes one request of the daily quota first.
            var api = await SendAsync("mdblist-api", options, HttpMethod.Get, "https://api.mdblist.com" + apiPath + query, null, null, cancellationToken, reserve: _mdblist == null ? null : _mdblist.TryReserveListRequestAsync).ConfigureAwait(false);
            if (api.Status == 200 && api.Body != null)
            {
                return WithNotice(MdblistItems(source, "mdblist-api", api.Body, MdblistHasMore(api)), "mdblist_api");
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

                // An adult title is never imported (TMDB lookups drop them too): it holds its place as an id-less gap.
                if (element.TryGetProperty("adult", out var adult) && (adult.ValueKind == JsonValueKind.True || (adult.ValueKind == JsonValueKind.Number && adult.TryGetInt32(out var flag) && flag != 0)))
                {
                    items.Add(new SourceItem("movie", null, null, null, null, null, null, null, null));
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
            var tvUpcoming = source.Shape == "chart" && source.Part("media") == "tv" && source.Part("chart") == "upcoming";
            string provider;
            if (options.Provider == "tmdb")
            {
                // F4: pinned to TMDB: never Seerr instead, even where Seerr could answer.
                if (!hasKey)
                {
                    return SourceFetchResult.Fail(source, SourceFailures.ProviderPinned, "This list was linked through TMDB, but the TMDB API key is no longer set. Nothing was read through another site.");
                }

                provider = "tmdb";
            }
            else if (options.Provider == "seerr")
            {
                if (!SeerrConfigured(out _, out _))
                {
                    return SourceFetchResult.Fail(source, SourceFailures.ProviderPinned, "This list was linked through Seerr, which isn't set up any more. Nothing was read through another site.");
                }

                provider = "seerr";
            }
            else if (options.Provider != null)
            {
                return SourceFetchResult.Fail(source, SourceFailures.ProviderPinned, "This list was linked through another site. Nothing was read.");
            }
            else
            {
                provider = hasKey && !tvUpcoming ? "tmdb" : "seerr";
            }

            if (provider == "seerr" && !seerrAllowed)
            {
                return SourceFetchResult.Fail(source, "tmdb_key_required", "TMDB lists and charts like this one need the TMDB API key in Jellyfin Enhanced's settings.");
            }

            return provider == "tmdb"
                ? await TmdbDirectAsync(source, options, cancellationToken).ConfigureAwait(false)
                : WithNotice(await TmdbViaSeerrAsync(source, options, cancellationToken).ConfigureAwait(false), "seerr_fallback");
        }

        private async Task<SourceFetchResult> TmdbDirectAsync(ParsedSourceUrl source, SourceFetchOptions options, CancellationToken cancellationToken)
        {
            var key = TmdbKey;
            var id = source.Part("id");
            switch (source.Shape)
            {
                case "collection":
                {
                    var json = await TmdbGetAsync("collection/" + id, string.Empty, key, options, cancellationToken).ConfigureAwait(false);
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
                    // Offset pages: an edit while they are read shifts rows between pages. Checked (PageDrift) and read
                    // once more; still inconsistent → Partial, so a sync adds but never removes on this snapshot.
                    for (var attempt = 1; ; attempt++)
                    {
                        var drift = new PageDrift();
                        var items = new List<SourceItem>();
                        string? title = null;
                        var total = 0;
                        var truncated = false;
                        var unknownEnd = false;
                        for (var page = 1; ; page++)
                        {
                            var json = await TmdbGetAsync("list/" + id, "?page=" + page.ToString(CultureInfo.InvariantCulture), key, options, cancellationToken).ConfigureAwait(false);
                            if (json == null)
                            {
                                return page == 1 ? SourceFetchResult.Fail(source, "not_found", "TMDB has no public list with this id.") : throw new SourceHttpException("upstream_error", "TMDB stopped answering while reading the list.");
                            }

                            using var doc = JsonDocument.Parse(json);
                            title ??= Str(doc.RootElement, "name");
                            var itemCount = Int(doc.RootElement, "item_count");
                            drift.Total(itemCount);
                            total = itemCount ?? total;
                            var rows = ListArray(doc.RootElement, "items").ToList();
                            var pageItems = new List<SourceItem>();
                            foreach (var row in rows)
                            {
                                var item = TmdbItem(row, null, null);
                                drift.Row(Str(row, "media_type") is { } mediaType && Int(row, "id") is { } rowId ? mediaType + "|" + rowId.ToString(CultureInfo.InvariantCulture) : item?.Key);
                                if (item != null)
                                {
                                    pageItems.Add(item);
                                }
                            }

                            items.AddRange(pageItems);
                            // B2: without a page count, whether more pages follow is unknown: never "complete".
                            var reportedPages = Int(doc.RootElement, "total_pages");
                            unknownEnd |= reportedPages == null;
                            var pages = reportedPages ?? 1;
                            if (items.Count >= MaxItems)
                            {
                                truncated = items.Count > MaxItems || page < pages;
                                break;
                            }

                            if (page >= pages)
                            {
                                drift.End();
                                break;
                            }

                            if (rows.Count == 0)
                            {
                                drift.Mismatch(); // an empty page before the last one: rows went missing meanwhile
                                break;
                            }

                            if (page >= MaxListPages)
                            {
                                truncated = true; // the page limit, with pages left
                                break;
                            }
                        }

                        if (drift.Consistent || attempt == 2)
                        {
                            return Done(source, "tmdb", title, items, Math.Max(total, items.Count), truncated, partial: !drift.Consistent || unknownEnd);
                        }

                        _logger.Debug($"[Lists] TMDB list {id} changed while it was read; reading it again");
                    }
                }

                default:
                {
                    var media = source.Part("media");
                    var path = source.Shape == "trending"
                        ? $"trending/{media}/{source.Part("period")}"
                        : $"{media}/{source.Part("chart").Replace('-', '_')}";
                    var items = new List<SourceItem>();
                    var unknownEnd = false;
                    for (var page = 1; page <= MaxChartItems / 20 && items.Count < MaxChartItems; page++)
                    {
                        var json = await TmdbGetAsync(path, "?page=" + page.ToString(CultureInfo.InvariantCulture), key, options, cancellationToken).ConfigureAwait(false)
                            ?? throw new SourceHttpException("upstream_error", "TMDB didn't return the chart.");
                        using var doc = JsonDocument.Parse(json);
                        var defaultType = media == "all" ? null : media;
                        items.AddRange(ListArray(doc.RootElement, "results").Select(p => TmdbItem(p, defaultType, null)).OfType<SourceItem>());
                        var pages = Int(doc.RootElement, "total_pages");
                        if (pages == null || page >= pages)
                        {
                            // A chart is its first pages; without a page count, whether this was all is unknown.
                            unknownEnd = pages == null && page < MaxChartItems / 20;
                            break;
                        }
                    }

                    var chart = items.Take(MaxChartItems).ToList();
                    return Done(source, "tmdb", null, chart, chart.Count, false, partial: unknownEnd);
                }
            }
        }

        private async Task<string?> TmdbGetAsync(string path, string query, string key, SourceFetchOptions options, CancellationToken cancellationToken)
        {
            // F17 + 4C2-SEC-03: read upstream every time (never TmdbResponseCache's 6 h copy: a sync must see the list as
            // it is now, and the pages of one snapshot must be of one age) and over the source transport (no redirects,
            // public addresses only). The fetcher's own short result cache keeps preview → apply → link to one read.
            var url = "https://api.themoviedb.org/3/" + path + query + (query.Length == 0 ? "?" : "&") + "api_key=" + Uri.EscapeDataString(key);
            var response = await SendAsync("tmdb", options, HttpMethod.Get, url, null, null, cancellationToken).ConfigureAwait(false);
            if (response.Status == 200 && response.Body != null)
            {
                return response.Body;
            }

            return response.Status switch
            {
                404 => null,
                401 => throw new SourceHttpException("tmdb_key_invalid", "TMDB refused the API key configured in Jellyfin Enhanced."),
                429 => throw new SourceHttpException("rate_limited", "TMDB is rate limiting; try again shortly.", response.RetryAfter ?? 10),
                _ => throw new SourceHttpException("upstream_error", "TMDB returned an error."),
            };
        }

        private async Task<SourceFetchResult> TmdbViaSeerrAsync(ParsedSourceUrl source, SourceFetchOptions options, CancellationToken cancellationToken)
        {
            if (!SeerrConfigured(out var baseUrl, out var seerrKey))
            {
                return SourceFetchResult.Fail(source, "tmdb_key_required", "TMDB lists need the TMDB API key or Seerr in Jellyfin Enhanced's settings.");
            }

            if (source.Shape == "collection")
            {
                var json = await SeerrGetAsync(baseUrl, seerrKey, "/api/v1/collection/" + source.Part("id"), options, cancellationToken).ConfigureAwait(false);
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
            var unknownEnd = false;
            for (var page = 1; page <= MaxChartItems / 20 && items.Count < MaxChartItems; page++)
            {
                var json = await SeerrGetAsync(baseUrl, seerrKey, path + (path.EndsWith('?') ? string.Empty : "&") + "page=" + page.ToString(CultureInfo.InvariantCulture), options, cancellationToken).ConfigureAwait(false)
                    ?? throw new SourceHttpException("upstream_error", "Seerr didn't return the chart.");
                using var doc = JsonDocument.Parse(json);
                var defaultType = source.Part("media") is "movie" or "tv" ? source.Part("media") : null;
                items.AddRange(ListArray(doc.RootElement, "results").Select(p => SeerrItem(p, defaultType)).OfType<SourceItem>());
                var pages = Int(doc.RootElement, "totalPages");
                if (pages == null || page >= pages)
                {
                    unknownEnd = pages == null && page < MaxChartItems / 20;
                    break;
                }
            }

            var chart = items.Take(MaxChartItems).ToList();
            return Done(source, "seerr", null, chart, chart.Count, false, partial: unknownEnd);
        }

        private async Task<string?> SeerrGetAsync(string baseUrl, string apiKey, string path, SourceFetchOptions options, CancellationToken cancellationToken)
        {
            Admit("seerr", options);
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

        private async Task<SourceFetchResult> TraktAsync(ParsedSourceUrl source, SourceFetchOptions options, CancellationToken cancellationToken)
        {
            var clientId = TraktKey;
            if (clientId.Length == 0)
            {
                return SourceFetchResult.Fail(source, SourceFailures.TraktNotConfigured, "Trakt lists need a Trakt client ID in Jellyfin Enhanced's settings.");
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

            // Offset pages of a list or watchlist: an edit while they are read shifts rows between pages. After each later
            // page, the last row of the page before is read again (limit=1): a different row there, a total that moved,
            // a row read twice or a row count that doesn't match the total mean the list changed meanwhile (PageDrift):
            // read once more, then Partial. Charts change all the time and never remove anything, so they aren't checked.
            var checkDrift = source.Shape != "chart";
            string? RowIdentity(JsonElement row, SourceItem? item) =>
                row.ValueKind == JsonValueKind.Object && row.TryGetProperty("id", out var rowId) && rowId.ValueKind == JsonValueKind.Number ? "id|" + rowId.GetRawText() : item?.Key;
            for (var attempt = 1; ; attempt++)
            {
                var drift = new PageDrift();
                var items = new List<SourceItem>();
                var truncated = false;
                var unknownEnd = false;
                var total = 0;
                var rowsBefore = 0;
                string? lastRow = null;
                for (var page = 1; ; page++)
                {
                    var url = "https://api.trakt.tv" + path + "?page=" + page.ToString(CultureInfo.InvariantCulture) + "&limit=" + TraktPageSize.ToString(CultureInfo.InvariantCulture);
                    var response = await SendAsync("trakt", options, HttpMethod.Get, url, headers, null, cancellationToken).ConfigureAwait(false);
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

                    var rows = doc.RootElement.EnumerateArray().ToList();
                    var pageItems = new List<SourceItem>();
                    string? pageLast = null;
                    foreach (var row in rows)
                    {
                        var item = TraktItem(row, defaultType);
                        // Trakt's list-item id identifies a row; without one, the entry's own key.
                        pageLast = RowIdentity(row, item);
                        drift.Row(pageLast);
                        if (item != null)
                        {
                            pageItems.Add(item);
                        }
                    }

                    if (checkDrift && page > 1 && drift.Consistent)
                    {
                        var probeUrl = "https://api.trakt.tv" + path + "?page=" + rowsBefore.ToString(CultureInfo.InvariantCulture) + "&limit=1";
                        var probe = await SendAsync("trakt", options, HttpMethod.Get, probeUrl, headers, null, cancellationToken).ConfigureAwait(false);
                        if (probe.Status != 200 || probe.Body == null)
                        {
                            throw Upstream(probe, "Trakt");
                        }

                        using var probeDoc = JsonDocument.Parse(probe.Body);
                        var probeRow = probeDoc.RootElement.ValueKind == JsonValueKind.Array ? probeDoc.RootElement.EnumerateArray().FirstOrDefault() : default;
                        if (probeRow.ValueKind != JsonValueKind.Object || RowIdentity(probeRow, TraktItem(probeRow, defaultType)) != lastRow)
                        {
                            drift.Mismatch();
                        }
                    }

                    rowsBefore += rows.Count;
                    lastRow = pageLast ?? lastRow;

                    items.AddRange(pageItems);
                    int? pageCount = response.Headers.TryGetValue("X-Pagination-Page-Count", out var countText) && int.TryParse(countText, NumberStyles.None, CultureInfo.InvariantCulture, out var count) ? count : null;
                    // B2: no page count after a full page: whether more follow is unknown, never "complete".
                    unknownEnd |= pageCount == null && rows.Count >= TraktPageSize;
                    var pages = pageCount ?? 1;
                    int? reported = response.Headers.TryGetValue("X-Pagination-Item-Count", out var itemText) && int.TryParse(itemText, NumberStyles.None, CultureInfo.InvariantCulture, out var itemCount) ? itemCount : null;
                    drift.Total(reported);
                    total = reported ?? items.Count;
                    if (items.Count >= cap)
                    {
                        truncated = source.Shape != "chart" && (items.Count > cap || page < pages);
                        break;
                    }

                    if (page >= pages)
                    {
                        drift.End();
                        break;
                    }

                    if (rows.Count == 0)
                    {
                        // An empty page before the last one: rows went missing meanwhile (charts too).
                        drift.Mismatch();
                        unknownEnd = true;
                        break;
                    }

                    if (page >= MaxTraktPages)
                    {
                        truncated = source.Shape != "chart"; // the page limit, with pages left (a chart is its first pages)
                        break;
                    }
                }

                if (!checkDrift || drift.Consistent || attempt == 2)
                {
                    var capped = items.Take(cap).ToList();
                    return Done(source, "trakt", null, capped, Math.Max(total, capped.Count), truncated, partial: (checkDrift && !drift.Consistent) || unknownEnd);
                }

                _logger.Debug($"[Lists] Trakt list {path} changed while it was read; reading it again");
            }
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

        private async Task<SourceFetchResult> ImdbAsync(ParsedSourceUrl source, SourceFetchOptions options, CancellationToken cancellationToken)
        {
            // Belt and braces: FetchAsync already refused, but the unofficial source is never contacted without the opt-in.
            if (!ListImportFlags.Provider(Config, SourceKinds.Imdb))
            {
                return SourceFetchResult.Fail(source, SourceFailures.ImdbDisabled, "IMDb lists are turned off on this server.");
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
                        var (profile, _) = await ImdbQueryAsync("query($p:ID!){userProfile(input:{profileId:$p}){userId}}", new Dictionary<string, object?> { ["p"] = user }, options, cancellationToken).ConfigureAwait(false);
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
            var edgesRead = 0;
            var continues = false;
            for (var page = 0; page < MaxImdbPages; page++)
            {
                var (data, pagePartial) = await ImdbQueryAsync(query, variables, options, cancellationToken).ConfigureAwait(false);
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
                    edgesRead++;
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

                continues = false;
                if (!connection.TryGetProperty("pageInfo", out var pageInfo) || !pageInfo.TryGetProperty("hasNextPage", out var next) || next.ValueKind != JsonValueKind.True)
                {
                    break;
                }

                // B2: more pages, but no cursor to read them with: the rest is missing (partial), never "complete".
                continues = true;
                variables["after"] = Str(pageInfo, "endCursor");
                if (variables["after"] == null)
                {
                    partial = true;
                    continues = false;
                    break;
                }
            }

            // The page limit with a continuation outstanding is truncated; fewer rows than IMDb's own total, with no page
            // left, means rows went missing (partial).
            truncated |= continues;
            partial |= !truncated && total > edgesRead;

            var capped = items.Take(MaxItems).ToList();
            if (capped.Count == 0)
            {
                // An unofficial source that parses to nothing is never an empty list: IMDb may have changed its answers.
                return total > 0
                    ? SourceFetchResult.Fail(source, ChronolistsPage.FormatChanged, "IMDb answered in a way JE can't read any more (its unofficial API may have changed). Nothing was changed; try the MDBList mirror or an IMDb CSV export.")
                    : SourceFetchResult.Fail(source, SourceFailures.SourceEmpty, "IMDb returned no titles for this list. An empty answer from IMDb's unofficial API isn't trusted as an empty list; try the MDBList mirror or an IMDb CSV export.");
            }

            return new SourceFetchResult
            {
                Ok = true,
                Kind = source.Kind,
                Provider = "imdb",
                Notice = "imdb_unofficial",
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
        private async Task<(JsonElement Data, bool Partial)> ImdbQueryAsync(string query, Dictionary<string, object?> variables, SourceFetchOptions options, CancellationToken cancellationToken)
        {
            var body = JsonSerializer.Serialize(new Dictionary<string, object?> { ["query"] = query, ["variables"] = variables });
            var headers = new Dictionary<string, string>(StringComparer.Ordinal) { ["x-imdb-client-name"] = "jellyfin-enhanced" };
            var response = await SendAsync("imdb", options, HttpMethod.Post, ImdbGraphQl, headers, body, cancellationToken).ConfigureAwait(false);
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
                _logger.Warning("[Lists] IMDb answered with errors next to data; the fetch is treated as partial (nothing will be removed).");
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
        private async Task<SourceFetchResult> ChronolistsAsync(ParsedSourceUrl source, SourceFetchOptions options, CancellationToken cancellationToken)
        {
            var response = await SendAsync("chronolists", options, HttpMethod.Get, "https://chronolists.com/" + Esc(source.Part("slug")), null, null, cancellationToken, "text/html").ConfigureAwait(false);
            if (response.Status == 404)
            {
                return SourceFetchResult.Fail(source, "not_found", "Chronolists has no watch order at this address.");
            }

            if (response.Status != 200 || response.Body == null)
            {
                throw Upstream(response, "Chronolists");
            }

            if (!ChronolistsPage.TryRead(response.Body, out var list, out var error))
            {
                if (error == ChronolistsPage.NotAWatchOrder)
                {
                    return SourceFetchResult.Fail(source, "not_found", "This Chronolists page isn't a watch order.");
                }

                _logger.Warning($"[Lists] {source.CanonicalUrl} no longer has the watch-order data JE reads, or too many of its entries can't be read; Chronolists may have changed its pages.");
                return SourceFetchResult.Fail(source, ChronolistsPage.FormatChanged, "Chronolists changed how its pages are built, so JE can't read this watch order any more. Nothing was changed; an update of Jellyfin Enhanced is needed.");
            }

            if (list!.Unusable > 0)
            {
                _logger.Info($"[Lists] {source.CanonicalUrl}: {list.Unusable.ToString(CultureInfo.InvariantCulture)} of {list.Total.ToString(CultureInfo.InvariantCulture)} entries couldn't be read; the fetch counts as partial (nothing is removed).");
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

        // One upstream request, with at most one retry after a short Retry-After. Every transmission is charged before it
        // is sent (4C2-SEC-06): the provider's admission, and `reserve` (the MDBList API's daily quota) when given; a refusal
        // is a typed failure, so a retry without a reservation never goes out.
        private async Task<HttpResult> SendAsync(string provider, SourceFetchOptions options, HttpMethod method, string url, IReadOnlyDictionary<string, string>? headers, string? body, CancellationToken cancellationToken, string accept = "application/json", Func<CancellationToken, Task<bool>>? reserve = null)
        {
            for (var attempt = 0; ; attempt++)
            {
                Admit(provider, options);
                if (reserve != null && !await reserve(cancellationToken).ConfigureAwait(false))
                {
                    throw new SourceHttpException("quota_exhausted", "The MDBList API quota for today is used up; try again after it resets.");
                }

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
                // The source transport (SourceHttp): never a redirect, public addresses only.
                var client = _httpClientFactory.CreateClient(SourceHttp.ClientName);
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
                if (status is >= 300 and < 400 && status != 304)
                {
                    throw new SourceHttpException(SourceFailures.Redirected, "The list site answered with a redirect, which Jellyfin Enhanced doesn't follow.");
                }

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
            catch (HttpRequestException ex) when (Blocked(ex) is { } blocked)
            {
                _logger.Warning($"[Lists] Refused a list-source connection: {blocked.Message}");
                throw new SourceHttpException(SourceFailures.AddressBlocked, "The list site's address isn't a public one, so Jellyfin Enhanced didn't connect.");
            }
            catch (HttpRequestException ex)
            {
                _logger.Debug($"[Lists] Source request failed: {ex.Message}");
                throw new SourceHttpException("unreachable", "Can't reach the list site right now.");
            }
        }

        private static SourceAddressBlockedException? Blocked(Exception ex)
        {
            for (var inner = ex.InnerException; inner != null; inner = inner.InnerException)
            {
                if (inner is SourceAddressBlockedException blocked)
                {
                    return blocked;
                }
            }

            return null;
        }

        private static SourceHttpException Upstream(HttpResult response, string site) => response.Status == 429
            ? new SourceHttpException("rate_limited", $"{site} is rate limiting; try again later.", response.RetryAfter)
            : new SourceHttpException("upstream_error", $"{site} returned an error ({response.Status.ToString(CultureInfo.InvariantCulture)}).");

        // ── Helpers ─────────────────────────────────────────────────────────

        private static SourceFetchResult WithNotice(SourceFetchResult result, string notice) => !result.Ok ? result : new SourceFetchResult
        {
            Ok = true,
            Kind = result.Kind,
            Provider = result.Provider,
            CanonicalUrl = result.CanonicalUrl,
            Title = result.Title,
            Unofficial = result.Unofficial,
            Notice = notice,
            Items = result.Items,
            Total = result.Total,
            Truncated = result.Truncated,
            Partial = result.Partial,
            Exact = result.Exact,
        };

        private static SourceFetchResult Done(ParsedSourceUrl source, string provider, string? title, List<SourceItem> items, int total, bool truncated, bool partial = false)
        {
            var capped = items.Count > MaxItems ? items.Take(MaxItems).ToList() : items;
            return new SourceFetchResult
            {
                Ok = true,
                Kind = source.Kind,
                Provider = provider,
                CanonicalUrl = source.CanonicalUrl,
                Title = title == null ? null : ListRules.CleanText(title) is var t && t.Length > ListRules.MaxTitle ? t[..ListRules.MaxTitle] : ListRules.CleanText(title),
                Items = capped,
                Total = Math.Max(total, capped.Count),
                Truncated = truncated || items.Count > MaxItems,
                Partial = partial,
            };
        }

        // Signs that an offset-paged list changed while its pages were read (a row added or removed before the page being
        // read shifts later rows across the page boundary: one is then read twice or never): the reported total moved
        // between pages, a row came back on a later page, or a complete read has fewer or more rows than the total.
        private sealed class PageDrift
        {
            private readonly HashSet<string> _rows = new(StringComparer.Ordinal);
            private int? _total;
            private int _count;

            public bool Consistent { get; private set; } = true;

            public void Mismatch() => Consistent = false;

            public void Total(int? reported)
            {
                if (reported is not int value)
                {
                    return;
                }

                if (_total.HasValue && _total.Value != value)
                {
                    Consistent = false;
                }

                _total ??= value;
            }

            public void Row(string? identity)
            {
                _count++;
                if (identity != null && !_rows.Add(identity))
                {
                    Consistent = false;
                }
            }

            // The last page was read: every row of the reported total (when the source reports one) must have been seen.
            public void End()
            {
                if (_total is int value && value != _count)
                {
                    Consistent = false;
                }
            }
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
                while (budget.Recent.Count > 0 && budget.Recent.Peek() <= now - _limits.CallerWindow)
                {
                    budget.Recent.Dequeue();
                }

                if (budget.Active >= _limits.MaxConcurrentPerCaller)
                {
                    retryAfter = 2;
                    return null;
                }

                if (budget.Recent.Count >= _limits.MaxPerCaller)
                {
                    retryAfter = Math.Max(1, (int)Math.Ceiling((budget.Recent.Peek() + _limits.CallerWindow - now).TotalSeconds));
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

            var text = ListRules.CleanText(value.GetString());
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
