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
using Jellyfin.Plugin.JellyfinEnhanced.Model;
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
    /// <item><b>TMDB</b>: user lists and charts need JE's TMDB key (read fresh, over the source transport); collections,
    /// trending and movie "upcoming" may go through Seerr without one, labelled
    /// (<c>seerr_fallback</c>). The provider used is reported and, for linked lists, pinned: a pinned provider that can't be
    /// used is <see cref="SourceFailures.ProviderPinned"/>, never another provider.</item>
    /// <item><b>Trakt</b>: needs the Trakt client id (secrets store); without it <see cref="SourceFailures.TraktNotConfigured"/>.</item>
    /// <item><b>IMDb</b>: only with the administrator's explicit opt-in, through IMDb's unofficial GraphQL API, labelled
    /// (<c>imdb_unofficial</c>). An answer that parses to no entries is a failure, never an empty list.</item>
    /// <item><b>Chronolists</b>: the watch-order page's embedded data (<see cref="ChronolistsPage"/>); exact ids, no key.</item>
    /// <item><b>Letterboxd</b> is never fetched (<see cref="ListSourceUrl"/> answers with guidance).</item>
    /// </list>
    /// Requests go only to fixed hosts built from the parsed parts (SSRF guard). EVERY transmission (each page, each retry,
    /// the MDBList quota's status read, the Seerr fallback) passes one gate, <c>SendAsync</c> (review round 2, D53 rule 3):
    /// the provider's switch and credential re-checked (IMDb's opt-in included), its admission and the MDBList API's daily
    /// quota charged, then <see cref="SourceHttp"/> (never a redirect: a 3xx is <c>source_redirected</c>; only public
    /// addresses checked at connect time, else <c>source_address_blocked</c>) or, for the Seerr fallback, Seerr's own
    /// no-redirect client; a 20 s timeout, an 8 MiB body cap and a 1000-entry cap; a short Retry-After (≤ 5 s) is honoured
    /// once, through the gate again. Completeness is positively established per provider (<see cref="SourceCompleteness"/>,
    /// D53 rule 1): every paging loop reports each page into a <see cref="SourceRead"/>, and a read is complete only when
    /// its explicit end, consistent page and item counts, no empty page and no error all hold; else
    /// <see cref="SourceFetchResult.Partial"/>, or truncated when JE stopped with more left.
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

        private const int MaxListPages = 100;
        private const int TraktPageSize = 100;
        private const int MaxTraktPages = 20;
        private const int MaxImdbPages = 10;
        private const int ChartPages = MaxChartItems / 20;
        private const string MdblistApiProvider = "mdblist-api";
        private const string MdblistStatusProvider = "mdblist-api-status";
        private const string SeerrProvider = "seerr";
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
        /// <param name="mdblist">MDBList service or null (no quota bookkeeping: the MDBList API is never read).</param>
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

        /// <summary>
        /// True when Seerr is enabled and configured (the labelled fallback for some TMDB charts), with its address list in
        /// order (review round 8, 4c2-R8-4: every address, as every Seerr-backed read of the lists area takes it).
        /// </summary>
        internal static bool SeerrConfigured(out string[] urls, out string apiKey) => SeerrAddresses.TryGet(out urls, out apiKey);

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
                // A kept read lives from when it began, not from when the (possibly slow, paged) answer came in.
                var readAt = DateTime.UtcNow;
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
                    _logger.Warning($"[Lists] Couldn't read the list {source.CanonicalUrl}: {UpstreamDiagnostics.Code(ex)}");
                    result = SourceFetchResult.Fail(source, "upstream_error", "The list site returned something JE can't read.");
                }

                // Only a positively complete read is kept (review round 8, 4c2-R8-2): a partial or truncated one is answered but
                // read again next time, so a corrected source is seen at once.
                if (SourceSnapshots.Classify(result, null).State == SnapshotState.Complete)
                {
                    PruneCache(result.Items.Count);
                    _cache[cacheKey] = (readAt + CacheTtl, result);
                }
                else if (!result.Ok)
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

            if (options.Provider == "seerr" && SeerrAddresses.IsJe(config))
            {
                return SourceFetchResult.Fail(source, SourceFailures.ProviderPinned, SeerrAddresses.InactiveSourceMessage);
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
            SeerrConfigured(out var seerrUrls, out var seerrKey);
            var material = string.Join('\n', TmdbKey, MdblistKey, TraktKey, SeerrAddresses.Identity(seerrUrls, seerrKey)); // every address (4c2-R8-4)
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
                var response = await SendAsync(new Transmission("mdblist", "https://mdblist.com" + publicPath), options, cancellationToken).ConfigureAwait(false);
                if (response.Status == 200 && response.Body != null)
                {
                    var read = new SourceRead();
                    var items = MdblistItems(source, response.Body, read);
                    return Done(source, "mdblist", null, items, items.Count, SourceCompleteness.MdblistPublic(read, MdblistMore(response) == true, MaxItems), read);
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
            // Each transmission (a 429 retry too) takes one request of the daily quota first (the gate).
            var api = await SendAsync(new Transmission(MdblistApiProvider, "https://api.mdblist.com" + apiPath + query) { Credential = key }, options, cancellationToken).ConfigureAwait(false);
            if (api.Status == 200 && api.Body != null)
            {
                var read = new SourceRead();
                var items = MdblistItems(source, api.Body, read);
                return WithNotice(Done(source, MdblistApiProvider, null, items, items.Count, SourceCompleteness.MdblistApi(read, MdblistMore(api), MaxItems), read), "mdblist_api");
            }

            // Review round 10 (absence is a positive fact, ProviderAbsence): 404, or 403 ("Permission denied"), with MDBList's error
            // object is "not found"; a 401 is a refused key, and anything else a failure.
            if (ProviderAbsence.MdblistApi(api.Status, api.Body))
            {
                return SourceFetchResult.Fail(source, "not_found", "MDBList didn't return this list, even with the API key (it may be private, or not exist).");
            }

            if (api.Status == 401)
            {
                throw new SourceHttpException("upstream_error", "MDBList refused the MDBList API key saved in Jellyfin Enhanced.");
            }

            throw Upstream(api, "MDBList");
        }

        // The quota's account status for `key` (MDBList's /user, which doesn't count against the quota), read through the gate like
        // every other transmission of a list read (4C2-R2-SEC-01): the switch re-checked, admission charged, over the
        // source transport. A refused or blocked read is a typed failure; an error answer is an unknown status, which the
        // quota treats like the ratings path does (it fails open).
        private async Task<MdblistAccountStatus?> QuotaStatusAsync(string key, SourceFetchOptions options, CancellationToken cancellationToken)
        {
            var response = await SendAsync(new Transmission(MdblistStatusProvider, "https://api.mdblist.com/user?apikey=" + Uri.EscapeDataString(key)) { Credential = key }, options, cancellationToken).ConfigureAwait(false);
            return response.Status == 200 && response.Body != null ? MdblistService.ParseAccountStatus(response.Body) : null;
        }

        // Whether more follow, as the answer itself says (research: X-Has-More, pagination.has_more / next_cursor): true,
        // false, or null when it doesn't say. One API page fills the cap, so more pages only mean "incomplete": never
        // follow them (quota).
        private static bool? MdblistMore(HttpResult response)
        {
            bool? more = null;
            if (response.Headers.TryGetValue("X-Has-More", out var header))
            {
                more = header.Trim().Equals("true", StringComparison.OrdinalIgnoreCase) ? true : header.Trim().Equals("false", StringComparison.OrdinalIgnoreCase) ? false : null;
            }

            try
            {
                using var doc = JsonDocument.Parse(response.Body!);
                if (doc.RootElement.ValueKind == JsonValueKind.Object && doc.RootElement.TryGetProperty("pagination", out var pagination) && pagination.ValueKind == JsonValueKind.Object)
                {
                    if (pagination.TryGetProperty("has_more", out var hasMore) && hasMore.ValueKind is JsonValueKind.True or JsonValueKind.False)
                    {
                        more = more == true || hasMore.ValueKind == JsonValueKind.True;
                    }

                    if (pagination.TryGetProperty("next_cursor", out var cursor) && cursor.ValueKind == JsonValueKind.String && !string.IsNullOrEmpty(cursor.GetString()))
                    {
                        more = true;
                    }
                }
            }
            catch (JsonException)
            {
                // MdblistItems reports unreadable bodies.
            }

            return more;
        }

        // MDBList's row types (its `mediatype`): movies and shows; a person is deliberately unsupported.
        private static string? MdblistMedia(string type) => type switch
        {
            "movie" => "movie",
            "show" or "tv" => "tv",
            _ => null,
        };

        // Every element of the answer is reported into the read as one row (D53 rule 1): an entry, a counted exclusion (an
        // adult title, kept as an id-less gap; a person in a list that mixes types) or a malformed row (not an object, a
        // type JE doesn't know or none, no usable id). Review round 4 (4c2-R4-2): the row's declared type is classified
        // before it is keyed (SourceTypes): an official list of movies or shows fixes the type of rows that don't declare
        // one, and a row declaring another type there is malformed; user and external lists mix types, so a row there
        // must declare its own.
        private static List<SourceItem> MdblistItems(ParsedSourceUrl source, string body, SourceRead read)
        {
            var context = source.Shape == "official" ? (source.Part("media") == "shows" ? "show" : "movie") : null;
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
                    read.Row(SourceRow.Malformed);
                    continue;
                }

                // An adult title is never imported (TMDB lookups drop them too): it holds its place as an id-less gap.
                if (element.TryGetProperty("adult", out var adult) && (adult.ValueKind == JsonValueKind.True || (adult.ValueKind == JsonValueKind.Number && adult.TryGetInt32(out var flag) && flag != 0)))
                {
                    items.Add(read.Row(SourceRow.Excluded(new SourceItem("movie", null, null, null, null, null, null, null, null)))!);
                    continue;
                }

                var (kind, type) = SourceTypes.Classify(Declared(element, "mediatype", "media_type"), context, MdblistMedia, PersonOnly);
                if (kind != SourceRowKind.Usable)
                {
                    read.Row(kind == SourceRowKind.Excluded ? SourceRow.Excluded() : SourceRow.Malformed);
                    continue;
                }

                var mediaType = MdblistMedia(type!)!;
                int? tmdb = Int(element, "id");
                string? imdb = Str(element, "imdb_id");
                int? tvdb = Int(element, "tvdbid") ?? Int(element, "tvdb_id");
                if (element.TryGetProperty("ids", out var ids) && ids.ValueKind == JsonValueKind.Object)
                {
                    tmdb = Int(ids, "tmdb") ?? tmdb;
                    imdb = Str(ids, "imdb") ?? imdb;
                    tvdb = Int(ids, "tvdb") ?? tvdb;
                }

                items.Add(read.Row(SourceRow.Of(new SourceItem(mediaType, tmdb is > 0 ? tmdb : null, ValidImdb(imdb), tvdb is > 0 ? tvdb : null, Str(element, "title"), Year(Int(element, "release_year")), null, null, null)))!);
            }

            return items;
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
                    var read = new SourceRead();
                    Bind(ResponseContract.TmdbCollection, new AnswerRequest(Id: Number(id)), doc.RootElement, read);
                    var parts = ListArray(doc.RootElement, "parts").Select(p => read.Row(TmdbRow(p, "movie", "release_date"))).OfType<SourceItem>().ToList();
                    var ordered = parts.OrderBy(p => p.Year ?? int.MaxValue).ToList();
                    return Done(source, "tmdb", Str(doc.RootElement, "name"), ordered, ordered.Count, SourceCompleteness.Whole(read), read);
                }

                case "list":
                {
                    // Offset pages: an edit while they are read shifts rows between pages. Checked (PageDrift) and read
                    // once more; still inconsistent → Partial, so a sync adds but never removes on this snapshot. Every
                    // page reports into the read; SourceCompleteness.OffsetList decides whether the whole list was read.
                    for (var attempt = 1; ; attempt++)
                    {
                        var drift = new PageDrift();
                        var read = new SourceRead();
                        var items = new List<SourceItem>();
                        string? title = null;
                        var total = 0;
                        for (var page = 1; ; page++)
                        {
                            var json = await TmdbGetAsync("list/" + id, "?page=" + page.ToString(CultureInfo.InvariantCulture), key, options, cancellationToken).ConfigureAwait(false);
                            if (json == null)
                            {
                                return page == 1 ? SourceFetchResult.Fail(source, "not_found", "TMDB has no public list with this id.") : throw new SourceHttpException("upstream_error", "TMDB stopped answering while reading the list.");
                            }

                            using var doc = JsonDocument.Parse(json);
                            // Review round 10 (4c2-R10-1): the page is the list asked for (its `id`) and the page asked for.
                            Bind(ResponseContract.TmdbListPage, new AnswerRequest(Page: page) { ListId = id }, doc.RootElement, read);
                            title ??= Str(doc.RootElement, "name");
                            var itemCount = Int(doc.RootElement, "item_count");
                            var pages = Int(doc.RootElement, "total_pages");
                            drift.Total(itemCount);
                            total = itemCount ?? total;
                            var rows = ListArray(doc.RootElement, "items").ToList();
                            foreach (var row in rows)
                            {
                                var item = read.Row(TmdbRow(row, null, null));
                                drift.Row(Str(row, "media_type") is { } mediaType && Int(row, "id") is { } rowId ? mediaType + "|" + rowId.ToString(CultureInfo.InvariantCulture) : item?.Key);
                                if (item != null)
                                {
                                    items.Add(item);
                                }
                            }

                            read.Page(pages, itemCount, answered: Int(doc.RootElement, "page"));

                            if (pages is int last && last >= 0 && page >= last)
                            {
                                drift.End();
                                read.Stop(SourceReadEnd.Last);
                                break;
                            }

                            if (pages is not >= 0 || rows.Count == 0)
                            {
                                break; // no page count (or a negative one: review round 9), or an empty page before the last one: stalled
                            }

                            if (items.Count >= MaxItems)
                            {
                                read.Stop(SourceReadEnd.Cap);
                                break;
                            }

                            if (page >= MaxListPages)
                            {
                                read.Stop(SourceReadEnd.PageLimit);
                                break;
                            }
                        }

                        if (!drift.Consistent)
                        {
                            read.Drift();
                        }

                        if (drift.Consistent || attempt == 2)
                        {
                            return Done(source, "tmdb", title, items, Math.Max(total, items.Count), SourceCompleteness.OffsetList(read), read);
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
                    var defaultType = media == "all" ? null : media;
                    var read = new SourceRead();
                    var items = new List<SourceItem>();
                    for (var page = 1; ; page++)
                    {
                        var json = await TmdbGetAsync(path, "?page=" + page.ToString(CultureInfo.InvariantCulture), key, options, cancellationToken).ConfigureAwait(false)
                            ?? throw new SourceHttpException("upstream_error", "TMDB didn't return the chart.");
                        using var doc = JsonDocument.Parse(json);
                        Bind(ResponseContract.TmdbChartPage, new AnswerRequest(Page: page), doc.RootElement, read);
                        var rows = ListArray(doc.RootElement, "results").ToList();
                        var pages = Int(doc.RootElement, "total_pages");
                        items.AddRange(rows.Select(p => read.Row(TmdbRow(p, defaultType, null))).OfType<SourceItem>().ToList());
                        read.Page(pages, Int(doc.RootElement, "total_results"), answered: Int(doc.RootElement, "page"));
                        if (ChartPageEnd(read, page, pages, rows.Count, items.Count))
                        {
                            break;
                        }
                    }

                    var chart = items.Take(MaxChartItems).ToList();
                    return Done(source, "tmdb", null, chart, chart.Count, SourceCompleteness.Chart(read), read);
                }
            }
        }

        // A chart's paging loop (TMDB, Seerr): true when it stops, with the reason reported. Charts are endless; JE reads
        // their first pages (the window).
        private static bool ChartPageEnd(SourceRead read, int page, int? pages, int rows, int items)
        {
            if (pages is int last && last >= 0 && page >= last)
            {
                read.Stop(SourceReadEnd.Last);
                return true;
            }

            if (pages is not >= 0 || rows == 0)
            {
                return true; // no page count (or a negative one: review round 9), or an empty page before the last one: stalled
            }

            if (page >= ChartPages || items >= MaxChartItems)
            {
                read.Stop(SourceReadEnd.Window);
                return true;
            }

            return false;
        }

        private async Task<string?> TmdbGetAsync(string path, string query, string key, SourceFetchOptions options, CancellationToken cancellationToken)
        {
            // F17 + 4C2-SEC-03: read upstream every time (never TmdbResponseCache's 6 h copy: a sync must see the list as
            // it is now, and the pages of one snapshot must be of one age) and over the source transport (no redirects,
            // public addresses only). The fetcher's own short result cache keeps preview → apply → link to one read.
            var url = "https://api.themoviedb.org/3/" + path + query + (query.Length == 0 ? "?" : "&") + "api_key=" + Uri.EscapeDataString(key);
            var response = await SendAsync(new Transmission("tmdb", url) { Credential = key }, options, cancellationToken).ConfigureAwait(false);
            if (response.Status == 200 && response.Body != null)
            {
                return response.Body;
            }

            // Review round 10 (ProviderAbsence): "not found" only from TMDB's own 404 (its error object); a proxy's 404 is a failure.
            if (ProviderAbsence.Tmdb(response.Status, response.Body))
            {
                return null;
            }

            return response.Status switch
            {
                401 => throw new SourceHttpException("tmdb_key_invalid", "TMDB refused the API key configured in Jellyfin Enhanced."),
                429 => throw new SourceHttpException("rate_limited", "TMDB is rate limiting; try again shortly.", response.RetryAfter ?? 10),
                _ => throw new SourceHttpException("upstream_error", "TMDB returned an error."),
            };
        }

        // The Seerr fallback: every configured address in order (review round 8, 4c2-R8-4), by THE fallback table of every
        // multi-server read (SeerrFallback, review round 9, 4c2-R9-7). Each address's read is whole on its own (a chart's pages
        // all from one server, never a mix); each of its requests passes the gate (its own admission and turn at the shared
        // metadata limiter). A complete read is used; a partial or truncated one is kept as the fallback (never cached) while
        // the next address is asked; an answer JE can't read (or another collection's, or another page's), an error, a timeout
        // or a 5xx (Seerr's collection route answers 500 for EVERY failure behind it, a missing collection included) proves
        // nothing. Review round 10 (ProviderAbsence): no Seerr answer is "not found" (a 404 is Seerr's unknown-route answer).
        // A refusal of JE's own (the read budget, the switch or Seerr's setup changed meanwhile) stops at once.
        private async Task<SourceFetchResult> TmdbViaSeerrAsync(ParsedSourceUrl source, SourceFetchOptions options, CancellationToken cancellationToken)
        {
            if (!SeerrConfigured(out var urls, out var seerrKey))
            {
                return SourceFetchResult.Fail(source, "tmdb_key_required", "TMDB lists need the TMDB API key or Seerr in Jellyfin Enhanced's settings.");
            }

            var read = await SeerrFallback.ReadAsync<SourceFetchResult>(urls, async (baseUrl, _) =>
            {
                try
                {
                    var result = await TmdbViaSeerrAtAsync(source, baseUrl, seerrKey, options, cancellationToken).ConfigureAwait(false);
                    return SourceSnapshots.Classify(result, null).State == SnapshotState.Complete ? new ServerAnswer<SourceFetchResult>(ServerState.Valid, result)
                        : new ServerAnswer<SourceFetchResult>(ServerState.Partial, result);
                }
                catch (SourceHttpException ex) when (ex.Code is not (SourceFailures.ReadBudgetExhausted or SourceFailures.ProviderDisabled))
                {
                    _logger.Debug($"[Lists] Seerr list read failed on one address: {ex.Code}");
                    return new ServerAnswer<SourceFetchResult>(ServerState.Unavailable, Error: ex);
                }
                catch (Exception ex) when (ex is JsonException or InvalidDataException or FormatException)
                {
                    _logger.Debug($"[Lists] Seerr list read on one address was unreadable: {UpstreamDiagnostics.Code(ex)}");
                    return new ServerAnswer<SourceFetchResult>(ServerState.Malformed, Error: new SourceHttpException("upstream_error", "Seerr returned something JE can't read."));
                }
            }).ConfigureAwait(false);

            return read.State switch
            {
                FallbackState.Valid or FallbackState.Partial => read.Value!,
                _ => throw (read.FirstError as SourceHttpException ?? new SourceHttpException("upstream_error", "Seerr returned an error.")),
            };
        }

        // One Seerr address's read of a TMDB collection or chart.
        private async Task<SourceFetchResult> TmdbViaSeerrAtAsync(ParsedSourceUrl source, string baseUrl, string seerrKey, SourceFetchOptions options, CancellationToken cancellationToken)
        {
            if (source.Shape == "collection")
            {
                var json = await SeerrGetAsync(baseUrl, seerrKey, "/api/v1/collection/" + source.Part("id"), options, cancellationToken).ConfigureAwait(false);
                using var doc = JsonDocument.Parse(json);
                var whole = new SourceRead();
                Bind(ResponseContract.SeerrCollection, new AnswerRequest(Id: Number(source.Part("id"))), doc.RootElement, whole);
                var parts = ListArray(doc.RootElement, "parts").Select(p => whole.Row(SeerrRow(p, "movie"))).OfType<SourceItem>().ToList();
                return Done(source, "seerr", Str(doc.RootElement, "name"), parts, parts.Count, SourceCompleteness.Whole(whole), whole);
            }

            var path = source.Shape == "trending"
                ? $"/api/v1/discover/trending?mediaType={source.Part("media")}&timeWindow={source.Part("period")}"
                : source.Part("media") == "tv" ? "/api/v1/discover/tv/upcoming?" : "/api/v1/discover/movies/upcoming?";
            var defaultType = source.Part("media") is "movie" or "tv" ? source.Part("media") : null;
            var read = new SourceRead();
            var items = new List<SourceItem>();
            for (var page = 1; ; page++)
            {
                var json = await SeerrGetAsync(baseUrl, seerrKey, path + (path.EndsWith('?') ? string.Empty : "&") + "page=" + page.ToString(CultureInfo.InvariantCulture), options, cancellationToken).ConfigureAwait(false);
                using var doc = JsonDocument.Parse(json);
                Bind(ResponseContract.SeerrChartPage, new AnswerRequest(Page: page), doc.RootElement, read);
                var rows = ListArray(doc.RootElement, "results").ToList();
                var pages = Int(doc.RootElement, "totalPages");
                items.AddRange(rows.Select(p => read.Row(SeerrRow(p, defaultType))).OfType<SourceItem>().ToList());
                read.Page(pages, Int(doc.RootElement, "totalResults"), answered: Int(doc.RootElement, "page"));
                if (ChartPageEnd(read, page, pages, rows.Count, items.Count))
                {
                    break;
                }
            }

            var chart = items.Take(MaxChartItems).ToList();
            return Done(source, "seerr", null, chart, chart.Count, SourceCompleteness.Chart(read), read);
        }

        // A Seerr fallback read, through the gate (the TMDB switch and Seerr's setup re-checked, admission charged) over
        // Seerr's own transport. A 500 (Seerr's answer to every failure behind it, an unknown id included) is an error, never an
        // absence (review round 9, 4c2-R9-7); so is a 404, Seerr's unknown-route answer (review round 10, ProviderAbsence).
        private async Task<string> SeerrGetAsync(string baseUrl, string apiKey, string path, SourceFetchOptions options, CancellationToken cancellationToken)
        {
            var response = await SendAsync(new Transmission(SeerrProvider, baseUrl + path) { Credential = apiKey, SeerrBase = baseUrl }, options, cancellationToken).ConfigureAwait(false);
            if (response.Status == 200 && response.Body != null)
            {
                return response.Body;
            }

            return response.Status switch
            {
                404 => throw new SourceHttpException("upstream_error", "Seerr didn't recognise this address (404): check Seerr's address in Jellyfin Enhanced's settings."),
                500 => throw new SourceHttpException("upstream_error", "Seerr couldn't read this from TMDB: the id may not exist, or TMDB failed behind Seerr. Try again later."),
                429 => throw new SourceHttpException("rate_limited", "Seerr is rate limiting; try again shortly.", response.RetryAfter ?? 10),
                _ => throw new SourceHttpException("upstream_error", "Seerr returned an error."),
            };
        }

        // An answer bound to its request by its contract (review round 10, D53 "derived request bindings": ResponseContract.Bind,
        // the one binder): another resource's answer (another list, collection or universe) is an answer JE can't use
        // (upstream_error; through Seerr, the next address); an answer without its echo, or of another page, makes the read
        // partial (never complete, never kept).
        private static void Bind(ResourceSchema contract, AnswerRequest request, JsonElement answer, SourceRead read)
        {
            var bound = contract.Validate(request, answer);
            if (bound.Verdict == ResponseVerdict.Malformed)
            {
                throw new InvalidDataException("the answer isn't the one asked for");
            }

            if (bound.Verdict != ResponseVerdict.Valid)
            {
                read.Violation();
            }
        }

        // A validated id part (digits) as a number, or null.
        private static int? Number(string text) => int.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out var number) ? number : null;

        // The one deliberately unsupported type of TMDB, Seerr, Trakt and MDBList rows.
        private static readonly HashSet<string> PersonOnly = new(StringComparer.Ordinal) { "person" };

        // TMDB's (and Seerr's) row types: movies and shows.
        private static string? TmdbMedia(string type) => type is "movie" or "tv" ? type : null;

        // The class of a row by its declared type (review round 4, 4c2-R4-2), or null when it is a supported type to key.
        private static SourceRow? Unkeyed(SourceRowKind kind) => kind switch
        {
            SourceRowKind.Usable => null,
            SourceRowKind.Excluded => SourceRow.Excluded(),
            _ => SourceRow.Malformed,
        };

        // A TMDB row: a movie or show with its id; an adult title is a counted exclusion, and so is a person where the
        // endpoint mixes types (a list,
        // trending "all"); a row of a chart, trending window or collection of one type takes that type when it doesn't
        // declare one, and any other declared type there is malformed; an unknown type, a missing one where types mix, or
        // a movie or show without an id, is malformed.
        private static SourceRow TmdbRow(JsonElement element, string? context, string? dateField)
        {
            if (element.ValueKind != JsonValueKind.Object)
            {
                return SourceRow.Malformed;
            }

            var (kind, mediaType) = SourceTypes.Classify(Declared(element, "media_type"), context, TmdbMedia, PersonOnly);
            if (Unkeyed(kind) is { } unkeyed)
            {
                return unkeyed;
            }

            // An adult title is never imported (the title lookups drop them too): a counted exclusion, never a key.
            if (element.TryGetProperty("adult", out var adult) && adult.ValueKind == JsonValueKind.True)
            {
                return SourceRow.Excluded();
            }

            var id = Int(element, "id");
            if (id is not > 0)
            {
                return SourceRow.Malformed;
            }

            var title = mediaType == "movie" ? Str(element, "title") : Str(element, "name");
            var date = Str(element, dateField ?? (mediaType == "movie" ? "release_date" : "first_air_date"));
            return SourceRow.Of(new SourceItem(mediaType!, id, null, null, title, YearOf(date), null, null, null));
        }

        // A Seerr row (TMDB's, in Seerr's field names): the same rule.
        private static SourceRow SeerrRow(JsonElement element, string? context)
        {
            if (element.ValueKind != JsonValueKind.Object)
            {
                return SourceRow.Malformed;
            }

            var (kind, mediaType) = SourceTypes.Classify(Declared(element, "mediaType"), context, TmdbMedia, PersonOnly);
            if (Unkeyed(kind) is { } unkeyed)
            {
                return unkeyed;
            }

            // An adult title is never imported (the title lookups drop them too): a counted exclusion, never a key.
            if (element.TryGetProperty("adult", out var adult) && adult.ValueKind == JsonValueKind.True)
            {
                return SourceRow.Excluded();
            }

            var id = Int(element, "id");
            if (id is not > 0)
            {
                return SourceRow.Malformed;
            }

            var title = mediaType == "movie" ? Str(element, "title") : Str(element, "name");
            var date = mediaType == "movie" ? Str(element, "releaseDate") : Str(element, "firstAirDate");
            return SourceRow.Of(new SourceItem(mediaType!, id, null, null, title, YearOf(date), null, null, null));
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
            // Every page reports into the read; SourceCompleteness decides whether the whole list (or chart window) was
            // read. The box office isn't paginated: one answer.
            var chart = source.Shape == "chart";
            var unpaged = chart && source.Part("chart") == "boxoffice";
            var checkDrift = !chart;
            string? RowIdentity(JsonElement row, SourceItem? item) =>
                row.ValueKind == JsonValueKind.Object && row.TryGetProperty("id", out var rowId) && rowId.ValueKind == JsonValueKind.Number ? "id|" + rowId.GetRawText() : item?.Key;
            for (var attempt = 1; ; attempt++)
            {
                var drift = new PageDrift();
                var read = new SourceRead();
                var items = new List<SourceItem>();
                var total = 0;
                var rowsBefore = 0;
                string? lastRow = null;
                for (var page = 1; ; page++)
                {
                    var url = "https://api.trakt.tv" + path + "?page=" + page.ToString(CultureInfo.InvariantCulture) + "&limit=" + TraktPageSize.ToString(CultureInfo.InvariantCulture);
                    var response = await SendAsync(new Transmission("trakt", url) { Headers = headers, Credential = clientId }, options, cancellationToken).ConfigureAwait(false);
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
                    string? pageLast = null;
                    foreach (var row in rows)
                    {
                        var item = read.Row(TraktRow(row, defaultType));
                        // Trakt's list-item id identifies a row; without one, the entry's own key.
                        pageLast = RowIdentity(row, item);
                        drift.Row(pageLast);
                        if (item != null)
                        {
                            items.Add(item);
                        }
                    }

                    if (checkDrift && page > 1 && drift.Consistent)
                    {
                        var probeUrl = "https://api.trakt.tv" + path + "?page=" + rowsBefore.ToString(CultureInfo.InvariantCulture) + "&limit=1";
                        var probe = await SendAsync(new Transmission("trakt", probeUrl) { Headers = headers, Credential = clientId }, options, cancellationToken).ConfigureAwait(false);
                        if (probe.Status != 200 || probe.Body == null)
                        {
                            throw Upstream(probe, "Trakt");
                        }

                        using var probeDoc = JsonDocument.Parse(probe.Body);
                        var probeRow = probeDoc.RootElement.ValueKind == JsonValueKind.Array ? probeDoc.RootElement.EnumerateArray().FirstOrDefault() : default;
                        if (probeRow.ValueKind != JsonValueKind.Object || RowIdentity(probeRow, TraktRow(probeRow, defaultType).Item) != lastRow)
                        {
                            drift.Mismatch();
                        }
                    }

                    rowsBefore += rows.Count;
                    lastRow = pageLast ?? lastRow;
                    int? pageCount = response.Headers.TryGetValue("X-Pagination-Page-Count", out var countText) && int.TryParse(countText, NumberStyles.None, CultureInfo.InvariantCulture, out var count) ? count : null;
                    int? reported = response.Headers.TryGetValue("X-Pagination-Item-Count", out var itemText) && int.TryParse(itemText, NumberStyles.None, CultureInfo.InvariantCulture, out var itemCount) ? itemCount : null;
                    int? answeredPage = response.Headers.TryGetValue("X-Pagination-Page", out var pageText) && int.TryParse(pageText, NumberStyles.None, CultureInfo.InvariantCulture, out var number) ? number : null;
                    // Review round 10: Trakt's page is bound by its pagination header (the body is a bare array of rows).
                    using (var paging = JsonDocument.Parse(answeredPage is int echoed ? "{\"page\":" + echoed.ToString(CultureInfo.InvariantCulture) + "}" : "{}"))
                    {
                        Bind(ResponseContract.TraktPage, new AnswerRequest(Page: unpaged ? null : page), paging.RootElement, read);
                    }

                    read.Page(pageCount, reported, answered: answeredPage);
                    drift.Total(reported);
                    total = reported ?? items.Count;
                    if (unpaged)
                    {
                        read.Stop(SourceReadEnd.Last);
                        break;
                    }

                    if (pageCount is int last && page >= last)
                    {
                        drift.End();
                        read.Stop(SourceReadEnd.Last);
                        break;
                    }

                    if (pageCount == null || rows.Count == 0)
                    {
                        break; // no page count, or an empty page before the last one: stalled
                    }

                    if (items.Count >= cap || page >= MaxTraktPages)
                    {
                        // A chart is its first pages (the window); a list stopped with pages left.
                        read.Stop(chart ? SourceReadEnd.Window : items.Count >= cap ? SourceReadEnd.Cap : SourceReadEnd.PageLimit);
                        break;
                    }
                }

                if (checkDrift && !drift.Consistent)
                {
                    read.Drift();
                }

                if (!checkDrift || drift.Consistent || attempt == 2)
                {
                    var verdict = unpaged ? SourceCompleteness.Whole(read) : chart ? SourceCompleteness.Chart(read) : SourceCompleteness.OffsetList(read);
                    var capped = items.Take(cap).ToList();
                    return Done(source, "trakt", null, capped, Math.Max(total, capped.Count), verdict, read);
                }

                _logger.Debug($"[Lists] Trakt list {path} changed while it was read; reading it again");
            }
        }

        // Trakt's row types: movies, shows, seasons and episodes.
        private static string? TraktMedia(string type) => type switch
        {
            "movie" => "movie",
            "show" or "season" or "episode" => "tv",
            _ => null,
        };

        // A Trakt row: a movie, show, season or episode (malformed without an id JE can key, or without its season or
        // episode number); a person (lists can hold people) is a counted exclusion; any other type is malformed. Review
        // round 4 (4c2-R4-2): list and watchlist rows declare their `type` (none: malformed); a chart's rows declare it by
        // the object they carry (`movie`, `show`…) or are a bare title of the chart's type, and a row of another type
        // there (a show in a movie chart, a person) is malformed.
        private static SourceRow TraktRow(JsonElement element, string? context)
        {
            if (element.ValueKind != JsonValueKind.Object)
            {
                return SourceRow.Malformed;
            }

            // Review round 5 (4c2-R5-3): a `type` field that isn't a type is malformed, never replaced by the object the row
            // carries; in a chart the carried object declares the type only when the row has no `type` field at all, and a
            // carried field that isn't an object declares none.
            var declared = Declared(element, "type");
            if (!declared.Present && context != null)
            {
                var carried = new[] { "episode", "season", "movie", "show", "person" }.FirstOrDefault(name => element.TryGetProperty(name, out _));
                declared = carried == null ? SourceDeclared.Absent
                    : element.GetProperty(carried).ValueKind == JsonValueKind.Object ? SourceDeclared.Of(carried) : SourceDeclared.Invalid;
            }

            var (kind, type) = SourceTypes.Classify(declared, context, TraktMedia, PersonOnly);
            if (Unkeyed(kind) is { } unkeyed)
            {
                return unkeyed;
            }
            var note = Str(element, "notes");
            JsonElement show = default;
            var hasShow = element.TryGetProperty("show", out show) && show.ValueKind == JsonValueKind.Object;
            switch (type)
            {
                case "movie":
                {
                    var movie = element.TryGetProperty("movie", out var m) && m.ValueKind == JsonValueKind.Object ? m : element;
                    var (tmdb, imdb, _) = TraktIds(movie);
                    return SourceRow.Of(new SourceItem("movie", tmdb, imdb, null, Str(movie, "title"), Year(Int(movie, "year")), null, null, note));
                }

                case "show":
                {
                    var target = hasShow ? show : element;
                    var (tmdb, imdb, tvdb) = TraktIds(target);
                    return SourceRow.Of(new SourceItem("tv", tmdb, imdb, tvdb, Str(target, "title"), Year(Int(target, "year")), null, null, note));
                }

                case "season":
                {
                    if (!hasShow || !element.TryGetProperty("season", out var season) || season.ValueKind != JsonValueKind.Object || Int(season, "number") is not int number)
                    {
                        return SourceRow.Malformed;
                    }

                    var (tmdb, imdb, tvdb) = TraktIds(show);
                    return SourceRow.Of(new SourceItem("tv", tmdb, imdb, tvdb, Str(show, "title"), Year(Int(show, "year")), number, null, note));
                }

                case "episode":
                {
                    if (!hasShow || !element.TryGetProperty("episode", out var episode) || episode.ValueKind != JsonValueKind.Object
                        || Int(episode, "season") is not int season || Int(episode, "number") is not int number)
                    {
                        return SourceRow.Malformed;
                    }

                    var (tmdb, imdb, tvdb) = TraktIds(show);
                    return SourceRow.Of(new SourceItem("tv", tmdb, imdb, tvdb, Str(show, "title"), Year(Int(show, "year")), season, number, note));
                }

                default:
                    return SourceRow.Malformed;
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
            // The opt-in is re-checked by the gate before every transmission (each page, each retry), not only here.
            const string titleFields = "id titleText{text} titleType{id} releaseYear{year} series{series{id titleText{text}} displayableEpisodeNumber{displayableSeason{text} episodeNumber{text}}}";
            string query;
            var variables = new Dictionary<string, object?>(StringComparer.Ordinal) { ["first"] = 250, ["after"] = null };
            string[] connectionPath;
            // One read for every query of it (review round 11, 4c2-R11-2: composite reads carry one verdict): the `p.` profile's
            // lookup and every page report their envelope into it, so a partial step anywhere keeps the read from being complete,
            // and from the cache.
            var read = new SourceRead();
            switch (source.Shape)
            {
                case "chart":
                    query = "query($first:Int!,$after:String){chartTitles(chart:{chartType:" + ImdbCharts[source.Part("chart")] + "},first:$first,after:$after){total edges{node{" + titleFields + "}} pageInfo{hasNextPage endCursor}}}";
                    connectionPath = new[] { "chartTitles" };
                    break;
                case "list":
                    query = "query($id:ID!,$first:Int!,$after:ID){list(id:$id){id name{originalText} items(first:$first,after:$after){total edges{node{item{... on Title{" + titleFields + "}}}} pageInfo{hasNextPage endCursor}}}}";
                    variables["id"] = source.Part("id");
                    connectionPath = new[] { "list", "items" };
                    break;
                default:
                    var user = source.Part("user");
                    if (user.StartsWith("p.", StringComparison.Ordinal))
                    {
                        var (profile, _) = await ImdbQueryAsync("query($p:ID!){userProfile(input:{profileId:$p}){userId}}", new Dictionary<string, object?> { ["p"] = user }, "userProfile", read, options, cancellationToken).ConfigureAwait(false);
                        user = profile.TryGetProperty("userProfile", out var up) && up.ValueKind == JsonValueKind.Object ? Str(up, "userId") ?? string.Empty : string.Empty;
                        if (!Regex.IsMatch(user, "^ur[0-9]{5,12}$"))
                        {
                            // Review round 10 (4c2-R10-7): the profile was answered (an absence would have been IMDb's own
                            // error), but not with a user id JE can read.
                            throw new SourceHttpException("upstream_error", "IMDb answered this profile in a way JE can't read (its unofficial API may have changed). Try the MDBList mirror instead.");
                        }
                    }

                    query = "query($u:ID!,$first:Int!,$after:ID){predefinedList(classType:WATCH_LIST,userId:$u){items(first:$first,after:$after){total edges{node{item{... on Title{" + titleFields + "}}}} pageInfo{hasNextPage endCursor}}}}";
                    variables["u"] = user;
                    connectionPath = new[] { "predefinedList", "items" };
                    break;
            }

            // Every page reports into the read (its edges, total, hasNextPage, cursor, GraphQL errors);
            // SourceCompleteness.Cursor decides whether the whole list was read. A chart's titles are of its one type.
            var context = source.Shape == "chart" ? (ImdbCharts[source.Part("chart")].Contains("_TV_", StringComparison.Ordinal) ? "tvSeries" : "movie") : null;
            var (contract, asked) = source.Shape switch
            {
                "list" => (ResponseContract.ImdbListPage, new AnswerRequest { ListId = source.Part("id") }),
                "chart" => (ResponseContract.ImdbChartPage, AnswerRequest.None),
                _ => (ResponseContract.ImdbWatchlistPage, AnswerRequest.None),
            };
            var items = new List<SourceItem>();
            string? title = null;
            var total = 0;
            for (var page = 0; ; page++)
            {
                var (data, errors) = await ImdbQueryAsync(query, variables, connectionPath[0], read, options, cancellationToken).ConfigureAwait(false);
                Bind(contract, asked, data, read); // review round 10 (4c2-R10-1): the list asked for
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
                        // Review round 10 (4c2-R10-7): IMDb's affirmative absence was thrown by ImdbQueryAsync; anything else
                        // without the list (an internal error with data.list null, data {}) is a failure, never "missing".
                        throw new SourceHttpException("upstream_error", "IMDb's unofficial API didn't return this list (it answered with an error; it may have changed). Try again later, or the MDBList mirror.");
                    }
                }

                var reportedTotal = Int(connection, "total");
                total = reportedTotal ?? total;
                var edges = Array(connection, "edges").ToList();
                foreach (var edge in edges)
                {
                    if (edge.ValueKind != JsonValueKind.Object || !edge.TryGetProperty("node", out var node) || node.ValueKind != JsonValueKind.Object)
                    {
                        read.Row(SourceRow.Malformed);
                        continue;
                    }

                    var item = node.TryGetProperty("item", out var inner) ? inner : node;
                    if (read.Row(ImdbRow(item, context)) is { } parsed)
                    {
                        items.Add(parsed);
                    }
                }

                var pageInfo = connection.TryGetProperty("pageInfo", out var info) && info.ValueKind == JsonValueKind.Object ? info : default;
                bool? hasNext = pageInfo.ValueKind == JsonValueKind.Object && pageInfo.TryGetProperty("hasNextPage", out var next) && next.ValueKind is JsonValueKind.True or JsonValueKind.False
                    ? next.ValueKind == JsonValueKind.True
                    : null;
                var cursor = pageInfo.ValueKind == JsonValueKind.Object ? Str(pageInfo, "endCursor") : null;
                read.Page(null, reportedTotal, hasNext, cursor, errors);
                if (hasNext == false)
                {
                    read.Stop(SourceReadEnd.Last);
                    break;
                }

                if (hasNext != true || cursor == null || edges.Count == 0 || read.Drifted)
                {
                    break; // no end marker, no cursor to go on with, an empty page that says more follow, or a cursor read before: stalled
                }

                if (items.Count >= MaxItems)
                {
                    read.Stop(SourceReadEnd.Cap);
                    break;
                }

                if (page + 1 >= MaxImdbPages)
                {
                    read.Stop(SourceReadEnd.PageLimit);
                    break;
                }

                variables["after"] = cursor;
            }

            var verdict = SourceCompleteness.Cursor(read);
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
                Truncated = verdict.Truncated || items.Count > MaxItems || total > MaxItems,
                Partial = verdict.Partial,
                Excluded = read.Excluded,
            };
        }

        // One IMDb query of a read: its data and whether GraphQL reported errors next to it (a partial answer: nulled items are
        // missing), its envelope reported into the read (every step of a read, the `p.` profile's lookup included: review round
        // 11, 4c2-R11-2). The envelope is read by ProviderAbsence.ImdbEnvelope, its one reader: "not found" only from IMDb's
        // affirmative absence on the queried root (4c2-R11-1); a root that is null otherwise, or an envelope JE can't read (errors
        // that aren't a list of error objects, data without the root), is a failure.
        private async Task<(JsonElement Data, bool Partial)> ImdbQueryAsync(string query, Dictionary<string, object?> variables, string root, SourceRead read, SourceFetchOptions options, CancellationToken cancellationToken)
        {
            var body = JsonSerializer.Serialize(new Dictionary<string, object?> { ["query"] = query, ["variables"] = variables });
            var headers = new Dictionary<string, string>(StringComparer.Ordinal) { ["x-imdb-client-name"] = "jellyfin-enhanced" };
            var response = await SendAsync(new Transmission("imdb", ImdbGraphQl) { Method = HttpMethod.Post, Headers = headers, Body = body }, options, cancellationToken).ConfigureAwait(false);
            if (response.Status != 200 || response.Body == null)
            {
                throw Upstream(response, "IMDb");
            }

            using var doc = JsonDocument.Parse(response.Body);
            var answer = doc.RootElement;
            switch (ProviderAbsence.ImdbEnvelope(answer, root))
            {
                case GraphQlVerdict.Absent:
                    throw new SourceHttpException("not_found", "IMDb didn't return this list (private or missing).");
                case GraphQlVerdict.Failed:
                    throw new SourceHttpException("upstream_error", "IMDb's unofficial API didn't return this list (it answered with an error; it may have changed). Try again later, or the MDBList mirror.");
                case GraphQlVerdict.Malformed:
                    throw new SourceHttpException("upstream_error", "IMDb's unofficial API returned an answer JE can't read; it may have changed. Try the MDBList mirror instead.");
                case GraphQlVerdict.Partial:
                    _logger.Warning("[Lists] IMDb answered with errors next to data; the fetch is treated as partial (nothing will be removed).");
                    read.Step(clean: false);
                    return (answer.GetProperty("data").Clone(), true);
                default:
                    read.Step(clean: true);
                    return (answer.GetProperty("data").Clone(), false);
            }
        }

        // IMDb title types JE never imports (counted exclusions): games, music videos, podcasts, pilots.
        private static readonly HashSet<string> ImdbExcludedTypes = new(StringComparer.Ordinal) { "videoGame", "musicVideo", "podcastSeries", "podcastEpisode", "tvPilot" };

        // IMDb's title types JE imports.
        private static string? ImdbMedia(string type) => type switch
        {
            "movie" or "tvMovie" or "short" or "tvShort" or "video" or "tvSpecial" => "movie",
            "tvSeries" or "tvMiniSeries" or "tvEpisode" => "tv",
            _ => null,
        };

        // An IMDb list item: a title of a type JE imports, keyed by its IMDb id (an episode by its show's id, season and
        // number); in a list or watchlist (types mix), a non-title item (a person: the Title fragment matched nothing, so
        // the item is empty) or a title type JE never imports is a counted exclusion; a title without a valid id, of an
        // unknown type or none (IMDb declares every title's type), or an episode without its show, season or number, is
        // malformed. Review round 4 (4c2-R4-2): a chart is of movies or of shows (`context`): a title of another type
        // there, an excluded one included, is malformed.
        private static SourceRow ImdbRow(JsonElement item, string? context)
        {
            if (item.ValueKind != JsonValueKind.Object)
            {
                return SourceRow.Malformed;
            }

            if (!item.EnumerateObject().Any())
            {
                return context == null ? SourceRow.Excluded() : SourceRow.Malformed;
            }

            var id = ValidImdb(Str(item, "id"));
            var declared = !item.TryGetProperty("titleType", out var titleType) ? SourceDeclared.Absent
                : titleType.ValueKind == JsonValueKind.Object ? Declared(titleType, "id") : SourceDeclared.Invalid;
            var (kind, type) = SourceTypes.Classify(declared, context, ImdbMedia, ImdbExcludedTypes, alwaysDeclared: true);
            if (Unkeyed(kind) is { } unkeyed)
            {
                return unkeyed;
            }

            if (id == null)
            {
                return SourceRow.Malformed;
            }

            var title = item.TryGetProperty("titleText", out var text) && text.ValueKind == JsonValueKind.Object ? Str(text, "text") : null;
            var year = item.TryGetProperty("releaseYear", out var release) && release.ValueKind == JsonValueKind.Object ? Year(Int(release, "year")) : null;
            switch (type)
            {
                case "tvSeries" or "tvMiniSeries":
                    return SourceRow.Of(new SourceItem("tv", null, id, null, title, year, null, null, null));
                case "tvEpisode":
                {
                    if (!item.TryGetProperty("series", out var series) || series.ValueKind != JsonValueKind.Object
                        || !series.TryGetProperty("series", out var show) || show.ValueKind != JsonValueKind.Object)
                    {
                        return SourceRow.Malformed;
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

                    return showId == null || !season.HasValue || !episode.HasValue ? SourceRow.Malformed : SourceRow.Of(new SourceItem("tv", null, showId, null, showTitle, null, season, episode, title));
                }

                case "movie" or "tvMovie" or "short" or "tvShort" or "video" or "tvSpecial":
                    return SourceRow.Of(new SourceItem("movie", null, id, null, title, year, null, null, null));
                default:
                    return SourceRow.Malformed; // a title type JE doesn't know
            }
        }

        // ── chronolists ─────────────────────────────────────────────────────

        // No API: the universe page itself (same host only, no redirects, size/time limits like every source), read
        // by ChronolistsPage. The entries carry exact TMDB ids and metadata, so the result is "exact".
        private async Task<SourceFetchResult> ChronolistsAsync(ParsedSourceUrl source, SourceFetchOptions options, CancellationToken cancellationToken)
        {
            var response = await SendAsync(new Transmission("chronolists", "https://chronolists.com/" + Esc(source.Part("slug"))) { Accept = "text/html" }, options, cancellationToken).ConfigureAwait(false);
            if (response.Status == 404)
            {
                return SourceFetchResult.Fail(source, "not_found", "Chronolists has no watch order at this address.");
            }

            if (response.Status != 200 || response.Body == null)
            {
                throw Upstream(response, "Chronolists");
            }

            if (!ChronolistsPage.TryRead(response.Body, source.Part("slug"), out var list, out var error))
            {
                if (error == ChronolistsPage.NotAWatchOrder)
                {
                    return SourceFetchResult.Fail(source, "not_found", "This Chronolists page isn't a watch order.");
                }

                if (error == ChronolistsPage.AnotherUniverse)
                {
                    // Review round 10 (4c2-R10-1): another universe's page is an answer JE can't use, never this watch order.
                    throw new SourceHttpException("upstream_error", "Chronolists answered with another watch order than the one at this address. Nothing was changed; try again later.");
                }

                _logger.Warning($"[Lists] {source.CanonicalUrl} no longer has the watch-order data JE reads, or too many of its entries can't be read; Chronolists may have changed its pages.");
                return SourceFetchResult.Fail(source, ChronolistsPage.FormatChanged, "Chronolists changed how its pages are built, so JE can't read this watch order any more. Nothing was changed; an update of Jellyfin Enhanced is needed.");
            }

            if (list!.Unusable > 0)
            {
                _logger.Info($"[Lists] {source.CanonicalUrl}: {list.Unusable.ToString(CultureInfo.InvariantCulture)} of {list.Total.ToString(CultureInfo.InvariantCulture)} entries couldn't be read; the fetch counts as partial (nothing is removed).");
            }

            // Each entry is one row of the snapshot (an unreadable one is counted in Unusable; a key read twice is drift).
            var read = new SourceRead();
            foreach (var item in list.Items)
            {
                read.Row(SourceRow.Of(item));
            }

            if (list.Unbound)
            {
                read.Violation(); // the page doesn't name its universe: never complete
            }

            var verdict = SourceCompleteness.Chronolists(list, read);
            return new SourceFetchResult
            {
                Ok = true,
                Kind = source.Kind,
                Provider = "chronolists",
                CanonicalUrl = source.CanonicalUrl,
                Title = list.Title,
                Items = list.Items,
                Total = list.Total,
                Truncated = verdict.Truncated,
                Partial = verdict.Partial,
                Exact = true,
                Excluded = read.Excluded,
            };
        }

        // ── HTTP ────────────────────────────────────────────────────────────

        // THE transmission gate of the list-source subsystem (review rounds 2 and 3, D53 rule 3). Every upstream send of a
        // list read passes here and only here: every page, each retry, the MDBList quota's status read and the Seerr
        // fallback. First every wait: the early check (nothing is charged for a site that's off), the provider's admission,
        // for the MDBList API one request of the daily quota (whose status read is itself a transmission through this
        // gate), the Seerr fallback's place in the shared metadata limiter. Then the transport, whose LAST step before the
        // bytes leave is the final check (GateOpen: the switch, IMDb's opt-in and the credential and address the request
        // carries, as they are NOW), with no await in between; and every answer it returns is read by BoundedBody.ReadAsync
        // (streamed, at most its cap: too_large, never a silent cut). A short Retry-After (≤ 5 s) is honoured once;
        // the retry goes through every step again.
        private async Task<HttpResult> SendAsync(Transmission transmission, SourceFetchOptions options, CancellationToken cancellationToken)
        {
            for (var attempt = 0; ; attempt++)
            {
                GateOpen(transmission);
                Admit(transmission.Provider == MdblistStatusProvider ? MdblistApiProvider : transmission.Provider, options);
                // Every MDBList API read reserves its request of the shared daily quota first (review round 4: the one
                // reservation the ratings lookups use too); without the quota's bookkeeping it isn't sent at all. The
                // reservation stays outstanding until this attempt has finished (review round 5), whatever its outcome, and
                // it is the account of the key this request carries, whose status is read with that same key (review
                // round 6: a key replaced meanwhile is another account, and GateOpen refuses the stale one anyway).
                IDisposable? reservation = null;
                if (transmission.Provider == MdblistApiProvider
                    && (_mdblist == null || (reservation = await _mdblist.TryReserveListRequestAsync(transmission.Credential!, ct => QuotaStatusAsync(transmission.Credential!, options, ct), cancellationToken).ConfigureAwait(false)) == null))
                {
                    throw new SourceHttpException("quota_exhausted", "The MDBList API quota for today is used up; try again after it resets.");
                }

                HttpResult result;
                using (reservation)
                {
                    if (transmission.Provider == SeerrProvider)
                    {
                        using var lease = await _limiter.AcquireAsync("source-fetch", false, cancellationToken).ConfigureAwait(false);
                        result = await SeerrOnceAsync(transmission, cancellationToken).ConfigureAwait(false);
                    }
                    else
                    {
                        result = await SendOnceAsync(transmission, cancellationToken).ConfigureAwait(false);
                    }
                }

                if (result.Status == 429 && attempt == 0 && result.RetryAfter is >= 0 and <= MaxRetryWaitSeconds)
                {
                    await Task.Delay(TimeSpan.FromSeconds(Math.Max(1, result.RetryAfter.Value)), cancellationToken).ConfigureAwait(false);
                    continue;
                }

                return result;
            }
        }

        // The provider's switch (IMDb's opt-in, the MDBList API's) and the credential and address the request carries,
        // checked against the configuration as it is now (refused: a typed failure, nothing is sent). A request built
        // with a key that was since cleared or replaced, or for a Seerr address that changed, is never sent.
        private static void GateOpen(Transmission transmission)
        {
            var config = Config;
            switch (transmission.Provider)
            {
                case "imdb" when !ListImportFlags.Provider(config, SourceKinds.Imdb):
                    throw new SourceHttpException(SourceFailures.ImdbDisabled, "IMDb lists were turned off on this server while the list was read. Nothing more was read from IMDb.");
                case "imdb":
                    return;
                case "mdblist" when ListImportFlags.Provider(config, SourceKinds.Mdblist):
                case "chronolists" when ListImportFlags.Provider(config, SourceKinds.Chronolists):
                case MdblistApiProvider or MdblistStatusProvider when ListImportFlags.MdblistApi(config) && Carries(transmission, MdblistKey):
                case "tmdb" when ListImportFlags.Provider(config, SourceKinds.Tmdb) && Carries(transmission, TmdbKey):
                    return;
                case SeerrProvider when ListImportFlags.Provider(config, SourceKinds.Tmdb) && SeerrConfigured(out var seerrUrls, out var seerrKey)
                    && Carries(transmission, seerrKey) && seerrUrls.Contains(transmission.SeerrBase, StringComparer.Ordinal):
                    return;
                case "trakt" when ListImportFlags.Provider(config, SourceKinds.Trakt):
                    if (TraktKey.Length == 0)
                    {
                        throw new SourceHttpException(SourceFailures.TraktNotConfigured, "The Trakt client ID was removed while the list was read.");
                    }

                    if (!Carries(transmission, TraktKey))
                    {
                        throw new SourceHttpException(SourceFailures.ProviderDisabled, "The Trakt client ID changed while the list was read. Nothing more was read from Trakt.");
                    }

                    return;
                default:
                    throw new SourceHttpException(SourceFailures.ProviderDisabled, "This list site was turned off, or its key or address changed, on this server while the list was read. Nothing more was read from it.");
            }
        }

        // The request carries the provider's current credential (a request built without one never matches).
        private static bool Carries(Transmission transmission, string current) =>
            current.Length > 0 && string.Equals(transmission.Credential, current, StringComparison.Ordinal);

        // The list-site transport (SourceHttp): never a redirect, public addresses only. Called by the gate only.
        private async Task<HttpResult> SendOnceAsync(Transmission transmission, CancellationToken cancellationToken)
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(Timeout);
            try
            {
                var client = _httpClientFactory.CreateClient(SourceHttp.ClientName);
                using var request = new HttpRequestMessage(transmission.Method, transmission.Url);
                request.Headers.UserAgent.ParseAdd(SeerrHttpHelper.UserAgent + " (+https://github.com/n00bcodr/Jellyfin-Enhanced)");
                request.Headers.Accept.ParseAdd(transmission.Accept);
                if (transmission.Headers != null)
                {
                    foreach (var (name, value) in transmission.Headers)
                    {
                        request.Headers.TryAddWithoutValidation(name, value);
                    }
                }

                if (transmission.Body != null)
                {
                    request.Content = new StringContent(transmission.Body, Encoding.UTF8, "application/json");
                }

                GateOpen(transmission); // the final check: nothing awaited between it and the send
                using var response = await BoundedBody.SendAsync(client, request, timeout.Token).ConfigureAwait(false);
                var status = (int)response.StatusCode;
                if (status is >= 300 and < 400 && status != 304)
                {
                    throw new SourceHttpException(SourceFailures.Redirected, "The list site answered with a redirect, which Jellyfin Enhanced doesn't follow.");
                }

                var text = status == 200 || status is >= 400 and < 500 ? await BoundedBody.ReadAsync(response, timeout.Token).ConfigureAwait(false) : null; // a 4xx body: its absence signal (review round 10)
                return new HttpResult(status, text, RetryAfterOf(response), HeadersOf(response));
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                throw new SourceHttpException("timeout", "The list site took too long to answer.");
            }
            catch (ResponseTooLargeException)
            {
                throw TooLarge();
            }
            catch (HttpRequestException ex) when (Blocked(ex) is { } blocked)
            {
                _logger.Warning($"[Lists] Refused a list-source connection: {blocked.Message}");
                throw new SourceHttpException(SourceFailures.AddressBlocked, "The list site's address isn't a public one, so Jellyfin Enhanced didn't connect.");
            }
            catch (HttpRequestException ex)
            {
                _logger.Debug($"[Lists] Source request failed: {UpstreamDiagnostics.Code(ex)}");
                throw new SourceHttpException("unreachable", "Can't reach the list site right now.");
            }
            catch (Exception ex) when (ex is not (SourceHttpException or OperationCanceledException or OutOfMemoryException))
            {
                // Review round 7 (4c2-R7-6): any other transport failure becomes a typed one, so its message (which can carry
                // the request URL with its key) never travels further or reaches a log.
                _logger.Debug($"[Lists] Source request failed: {UpstreamDiagnostics.Code(ex)}");
                throw new SourceHttpException("unreachable", "Can't reach the list site right now.");
            }
        }

        // The Seerr fallback's transport: Seerr's own named client (never a redirect; never the unnamed fallback client).
        // The gate holds the shared metadata limiter's lease around it. Called by the gate only.
        private async Task<HttpResult> SeerrOnceAsync(Transmission transmission, CancellationToken cancellationToken)
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(Timeout);
            try
            {
                var client = _httpClientFactory.CreateClient(SeerrHttpHelper.NamedClient);
                using var request = SeerrHttpHelper.BuildRequest(HttpMethod.Get, transmission.Url, transmission.Credential ?? string.Empty);
                GateOpen(transmission); // the final check: nothing awaited between it and the send
                using var response = await BoundedBody.SendAsync(client, request, timeout.Token).ConfigureAwait(false);
                var status = (int)response.StatusCode;
                if (status is >= 300 and < 400 && status != 304)
                {
                    throw new SourceHttpException(SourceFailures.Redirected, "Seerr answered with a redirect, which Jellyfin Enhanced doesn't follow.");
                }

                var json = status == 200 ? await BoundedBody.ReadAsync(response, timeout.Token).ConfigureAwait(false) : null;
                return new HttpResult(status, json, RetryAfterOf(response), HeadersOf(response));
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                throw new SourceHttpException("timeout", "Seerr took too long to answer.");
            }
            catch (ResponseTooLargeException)
            {
                throw TooLarge();
            }
            catch (Exception ex) when (ex is not (SourceHttpException or OperationCanceledException or OutOfMemoryException))
            {
                _logger.Debug($"[Lists] Seerr list request failed: {UpstreamDiagnostics.Code(ex)}");
                throw new SourceHttpException("upstream_error", "Can't reach Seerr right now.");
            }
        }

        // Every answer the gate returns is read by the one bounded reader (BoundedBody: streamed from the headers on, at most
        // its cap); an announced or actual body over the cap is too_large: nothing past the cap is read, nothing is cut silently.
        private static SourceHttpException TooLarge() => new("too_large", "The list is too large to import.");

        private static int? RetryAfterOf(HttpResponseMessage response) => response.Headers.RetryAfter is { } ra
            ? ra.Delta.HasValue ? (int)Math.Ceiling(ra.Delta.Value.TotalSeconds)
                : ra.Date.HasValue ? (int)Math.Max(0, Math.Ceiling((ra.Date.Value - DateTimeOffset.UtcNow).TotalSeconds)) : null
            : null;

        private static Dictionary<string, string> HeadersOf(HttpResponseMessage response)
        {
            var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var header in response.Headers)
            {
                headers[header.Key] = string.Join(',', header.Value);
            }

            return headers;
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
            Excluded = result.Excluded,
        };

        private static SourceFetchResult Done(ParsedSourceUrl source, string provider, string? title, List<SourceItem> items, int total, SourceVerdict verdict, SourceRead read)
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
                Truncated = verdict.Truncated || items.Count > MaxItems,
                Partial = verdict.Partial,
                Excluded = read.Excluded,
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

        // A row's type field (review round 5, 4c2-R5-3: absent ≠ present-but-invalid): absent only when the row has none of
        // the names; a field that isn't a non-empty string (a number, null, "", an object), or two that disagree, is
        // present but invalid, never read as absent.
        private static SourceDeclared Declared(JsonElement element, params string[] names)
        {
            var found = SourceDeclared.Absent;
            foreach (var name in names)
            {
                if (element.ValueKind != JsonValueKind.Object || !element.TryGetProperty(name, out _))
                {
                    continue;
                }

                if (Str(element, name) is not { } type || (found.Present && found.Type != type))
                {
                    return SourceDeclared.Invalid;
                }

                found = SourceDeclared.Of(type);
            }

            return found;
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

        // One upstream request of a list read (what the gate sends). Provider: the gate's key (its switch, admission and,
        // for the MDBList API, quota): mdblist, mdblist-api, mdblist-api-status, tmdb, seerr, trakt, imdb, chronolists.
        private sealed record Transmission(string Provider, string Url)
        {
            public HttpMethod Method { get; init; } = HttpMethod.Get;

            public IReadOnlyDictionary<string, string>? Headers { get; init; }

            public string? Body { get; init; }

            public string Accept { get; init; } = "application/json";

            // The secret the request carries (an API key or client id): the gate's final check compares it with the current one.
            public string? Credential { get; init; }

            // The Seerr address the request was built for (the final check compares it with the configured one).
            public string? SeerrBase { get; init; }
        }

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
