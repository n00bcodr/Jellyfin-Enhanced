using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Import;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Sources;
using MediaBrowser.Common.Configuration;
using Moq;

namespace JE.Tests;

// Track 4c2a's source rules on top of #936's fetchers: every provider has its own switch and is never contacted while
// off (IMDb consent OFF = no network call), Trakt without a client id is typed unavailable, the MDBList API is only an
// administrator's deliberate read behind its own switch, pinned providers never switch, an unofficial empty answer is a
// failure, results are cached per credential identity (not key length), per-provider read budgets refuse with a typed,
// retryable code, snapshots classify partial/truncated/failed/shape-changed/empty-after-nonempty, and the 2026 Chronolists
// page format is read exactly (recorded live pages).
[Collection("Plugin singleton")]
public class ListsImportSourceRulesTests
{
    private sealed class Net : IDisposable
    {
        public ApiPluginFixture Plugin { get; } = new();
        private readonly string _quotaCache = Path.Combine(Path.GetTempPath(), "je-4c2r4-" + Guid.NewGuid().ToString("N"));

        public List<HttpRequestMessage> Requests { get; } = new();
        public Dictionary<string, Func<HttpRequestMessage, HttpResponseMessage>> Routes { get; } = new(StringComparer.Ordinal);
        public IntegrationTransport Transport { get; }
        public TmdbResponseCache Tmdb { get; }
        public MdblistService Quota { get; }
        public ListSourceFetcher Fetcher { get; private set; }

        public Net(SourceReadLimits? limits = null, ISourceReadAdmission? admission = null)
        {
            Transport = new IntegrationTransport((request, _) =>
            {
                lock (Requests)
                {
                    Requests.Add(request);
                }

                var key = request.RequestUri!.GetLeftPart(UriPartial.Path);
                return Task.FromResult(RealProviders.Shape(request, Routes.TryGetValue(key, out var route) ? route(request) : IntegrationTransport.Response("{\"message\":\"not found\"}", 404)));
            });
            Tmdb = new TmdbResponseCache(Transport, TimeProvider.System);
            ImportTestFlags.AllOn(Plugin.Plugin.Configuration);
            // The real MDBList quota: review round 4 never reads the MDBList API without its reservation.
            Quota = new MdblistService(Transport, Mock.Of<IApplicationPaths>(p => p.PluginsPath == _quotaCache), Plugin.Core.Logger);
            Fetcher = new ListSourceFetcher(Transport, Tmdb, Quota, new MetadataCallLimiter(4, TimeSpan.Zero, TimeProvider.System), Plugin.Core.Logger, limits, admission);
        }

        public Task<SourceFetchResult> Fetch(string url, SourceFetchOptions? options = null)
        {
            Assert.True(ListSourceUrl.TryParse(url, out var source, out var error), error);
            return Fetcher.FetchAsync(source!, options ?? new SourceFetchOptions { Fresh = true }, CancellationToken.None);
        }

        public void Dispose()
        {
            Quota.Dispose();
            Tmdb.Dispose();
            Transport.Dispose();
            Plugin.Dispose();
        }
    }

    private static HttpResponseMessage Json(string body, int status = 200) => IntegrationTransport.Response(body, status);

    private const string Mdb = "https://mdblist.com/lists/me/mine";
    private const string MdbJson = "https://mdblist.com/lists/me/mine/json";
    private const string OneMovie = "[{\"id\":49521,\"title\":\"Man of Steel\",\"mediatype\":\"movie\",\"release_year\":2013}]";

    // ── Switches and consent ────────────────────────────────────────────

    [Theory]
    [InlineData("https://mdblist.com/lists/me/mine", nameof(Jellyfin.Plugin.JellyfinEnhanced.Configuration.PluginConfiguration.ArrPhase4ListMdblistEnabled), "provider_disabled")]
    [InlineData("https://www.themoviedb.org/collection/10", nameof(Jellyfin.Plugin.JellyfinEnhanced.Configuration.PluginConfiguration.ArrPhase4ListTmdbEnabled), "provider_disabled")]
    [InlineData("https://chronolists.com/mcu", nameof(Jellyfin.Plugin.JellyfinEnhanced.Configuration.PluginConfiguration.ArrPhase4ListChronolistsEnabled), "provider_disabled")]
    [InlineData("https://trakt.tv/movies/popular", nameof(Jellyfin.Plugin.JellyfinEnhanced.Configuration.PluginConfiguration.ArrPhase4ListTraktEnabled), "provider_disabled")]
    [InlineData("https://www.imdb.com/chart/top/", nameof(Jellyfin.Plugin.JellyfinEnhanced.Configuration.PluginConfiguration.ArrPhase4ListImdbEnabled), "imdb_disabled")]
    [InlineData("https://mdblist.com/lists/me/mine", nameof(Jellyfin.Plugin.JellyfinEnhanced.Configuration.PluginConfiguration.ArrPhase4ListSourcesEnabled), "provider_disabled")]
    [InlineData("https://www.imdb.com/chart/top/", nameof(Jellyfin.Plugin.JellyfinEnhanced.Configuration.PluginConfiguration.ArrPhase4ListImportEnabled), "imdb_disabled")]
    public async Task ASwitchedOffProviderIsNeverContacted(string url, string flag, string code)
    {
        using var net = new Net();
        var config = net.Plugin.Plugin.Configuration;
        config.TMDB_API_KEY = "tmdb-key";
        config.ArrListTraktApiKey = "trakt-client";
        typeof(Jellyfin.Plugin.JellyfinEnhanced.Configuration.PluginConfiguration).GetProperty(flag)!.SetValue(config, false);

        var result = await net.Fetch(url);

        Assert.Equal((false, code), (result.Ok, result.ErrorCode));
        Assert.Empty(net.Requests);
    }

    [Fact]
    public async Task ImdbWithConsentOffMakesNoNetworkCallAndWithConsentIsLabelledUnofficial()
    {
        using var net = new Net();
        net.Plugin.Plugin.Configuration.ArrPhase4ListImdbEnabled = false;
        net.Routes["https://api.graphql.imdb.com/"] = _ => Json("{\"data\":{\"chartTitles\":{\"total\":1,\"edges\":[{\"node\":{\"id\":\"tt0111161\",\"titleText\":{\"text\":\"The Shawshank Redemption\"},\"titleType\":{\"id\":\"movie\"},\"releaseYear\":{\"year\":1994}}}],\"pageInfo\":{\"hasNextPage\":false}}}}");

        foreach (var url in new[] { "https://www.imdb.com/chart/top/", "https://www.imdb.com/list/ls055592025/", "https://www.imdb.com/user/ur12345678/watchlist" })
        {
            Assert.Equal(SourceFailures.ImdbDisabled, (await net.Fetch(url)).ErrorCode);
        }

        Assert.Empty(net.Requests);

        net.Plugin.Plugin.Configuration.ArrPhase4ListImdbEnabled = true;
        var chart = await net.Fetch("https://www.imdb.com/chart/top/");
        Assert.True(chart.Ok, chart.Message);
        Assert.Equal((true, "imdb_unofficial", "imdb"), (chart.Unofficial, chart.Notice, chart.Provider));
        Assert.Equal("imdb|tt0111161||", Assert.Single(chart.Items).Key);
    }

    [Fact]
    public async Task AnEmptyImdbAnswerIsAFailureNeverAnEmptyList()
    {
        using var net = new Net();
        var body = "{\"data\":{\"chartTitles\":{\"total\":0,\"edges\":[],\"pageInfo\":{\"hasNextPage\":false}}}}";
        net.Routes["https://api.graphql.imdb.com/"] = _ => Json(body);
        var empty = await net.Fetch("https://www.imdb.com/chart/top/");
        Assert.Equal((false, SourceFailures.SourceEmpty), (empty.Ok, empty.ErrorCode));

        // Entries are announced but none can be read: IMDb's answers changed shape.
        body = "{\"data\":{\"chartTitles\":{\"total\":250,\"edges\":[{\"node\":{\"titleId\":\"tt0111161\"}}],\"pageInfo\":{\"hasNextPage\":false}}}}";
        var changed = await net.Fetch("https://www.imdb.com/chart/top/");
        Assert.Equal((false, ChronolistsPage.FormatChanged), (changed.Ok, changed.ErrorCode));
        Assert.Equal(SnapshotState.ShapeChanged, SourceSnapshots.Classify(changed, null).State);
    }

    [Fact]
    public async Task TraktWithoutAClientIdIsTypedUnavailableAndNotOffered()
    {
        using var net = new Net();
        var viewer = FakeListHost.MakeUser("viewer", false, false);
        foreach (var url in new[] { "https://trakt.tv/users/justin/lists/dc", "https://trakt.tv/users/justin/watchlist", "https://trakt.tv/movies/trending" })
        {
            var result = await net.Fetch(url);
            Assert.Equal((false, SourceFailures.TraktNotConfigured), (result.Ok, result.ErrorCode));
        }

        Assert.Empty(net.Requests);
        Assert.False(net.Fetcher.Providers(viewer).Trakt);
        net.Plugin.Plugin.Configuration.ArrListTraktApiKey = "trakt-client";
        Assert.True(net.Fetcher.Providers(viewer).Trakt);
    }

    // ── The MDBList API ─────────────────────────────────────────────────

    [Fact]
    public async Task TheMdblistApiNeedsItsSwitchAKeyAndADeliberateRequest()
    {
        using var net = new Net();
        var config = net.Plugin.Plugin.Configuration;
        net.Routes[MdbJson] = _ => Json("{\"error\":\"private\"}", 403);
        net.Routes["https://api.mdblist.com/lists/me/mine/items"] = _ => Json("{\"items\":[{\"ids\":{\"tmdb\":10193},\"title\":\"Toy Story 3\",\"mediatype\":\"movie\"}]}");

        // Switch off: a deliberate request is refused before anything is read.
        config.MdblistApiKey = "mdb-key";
        Assert.Equal(SourceFailures.ProviderDisabled, (await net.Fetch(Mdb, new SourceFetchOptions { AllowMdblistApi = true, Fresh = true })).ErrorCode);
        Assert.Empty(net.Requests);

        // Switch on, no key: refused too.
        config.ArrPhase4ListMdblistApiEnabled = true;
        config.MdblistApiKey = string.Empty;
        Assert.Equal(SourceFailures.ProviderDisabled, (await net.Fetch(Mdb, new SourceFetchOptions { AllowMdblistApi = true, Fresh = true })).ErrorCode);
        Assert.Empty(net.Requests);

        // Switch on and a key, but no deliberate request: the public read only, refused as not public (never the API).
        config.MdblistApiKey = "mdb-key";
        Assert.Equal(SourceFailures.MdblistNotPublic, (await net.Fetch(Mdb)).ErrorCode);
        Assert.DoesNotContain(net.Requests, r => r.RequestUri!.Host == "api.mdblist.com");

        // The deliberate request: the API, labelled, and pinnable.
        var api = await net.Fetch(Mdb, new SourceFetchOptions { AllowMdblistApi = true, Fresh = true });
        Assert.Equal((true, "mdblist-api", "mdblist_api"), (api.Ok, api.Provider, api.Notice));

        // A link pinned to the API whose switch went off fails as pinned, and never reads the public JSON instead.
        config.ArrPhase4ListMdblistApiEnabled = false;
        var before = net.Requests.Count;
        Assert.Equal(SourceFailures.ProviderPinned, (await net.Fetch(Mdb, new SourceFetchOptions { Provider = "mdblist-api", Fresh = true })).ErrorCode);
        Assert.Equal(before, net.Requests.Count);
    }

    [Fact]
    public async Task AdultEntriesOfAnMdblistListAreNeverImported()
    {
        using var net = new Net();
        net.Routes[MdbJson] = _ => Json("[{\"id\":1,\"adult\":0,\"title\":\"A\",\"mediatype\":\"movie\"},{\"id\":2,\"adult\":1,\"title\":\"B\",\"mediatype\":\"movie\"},{\"id\":3,\"adult\":true,\"title\":\"C\",\"mediatype\":\"movie\"}]");

        var result = await net.Fetch(Mdb);

        Assert.Equal(new[] { "movie|1||", null, null }, result.Items.Select(i => i.Key));
    }

    // ── Pinning ─────────────────────────────────────────────────────────

    [Fact]
    public async Task APinnedProviderIsNeverSwitchedSilently()
    {
        using var net = new Net();
        var config = net.Plugin.Plugin.Configuration;
        net.Routes["https://api.themoviedb.org/3/collection/10"] = _ => Json("{\"id\":10,\"name\":\"Star Wars Collection\",\"parts\":[{\"id\":11,\"title\":\"Star Wars\",\"release_date\":\"1977-05-25\"}]}");
        net.Routes["http://seerr.test/api/v1/collection/10"] = _ => Json("{\"id\":10,\"name\":\"Star Wars Collection\",\"parts\":[{\"id\":11,\"mediaType\":\"movie\",\"title\":\"Star Wars\",\"releaseDate\":\"1977-05-25\"}]}");
        config.JellyseerrEnabled = true;
        config.JellyseerrUrls = "http://seerr.test";
        config.JellyseerrApiKey = "seerr-key";

        // Unpinned with a key: TMDB. Pinned to Seerr: Seerr (labelled), although TMDB could answer.
        config.TMDB_API_KEY = "tmdb-key";
        Assert.Equal("tmdb", (await net.Fetch("https://www.themoviedb.org/collection/10")).Provider);
        var seerr = await net.Fetch("https://www.themoviedb.org/collection/10", new SourceFetchOptions { Provider = "seerr", Fresh = true });
        Assert.Equal(("seerr", "seerr_fallback"), (seerr.Provider, seerr.Notice));

        // Pinned to Seerr when Seerr is gone: refused, TMDB is not asked.
        config.JellyseerrEnabled = false;
        var tmdbCalls = net.Requests.Count(r => r.RequestUri!.Host == "api.themoviedb.org");
        Assert.Equal(SourceFailures.ProviderPinned, (await net.Fetch("https://www.themoviedb.org/collection/10", new SourceFetchOptions { Provider = "seerr", Fresh = true })).ErrorCode);
        Assert.Equal(tmdbCalls, net.Requests.Count(r => r.RequestUri!.Host == "api.themoviedb.org"));

        // Pinned to TMDB without a key, Seerr back: refused, Seerr is not asked.
        config.JellyseerrEnabled = true;
        config.TMDB_API_KEY = string.Empty;
        var seerrCalls = net.Requests.Count(r => r.RequestUri!.Host == "seerr.test");
        Assert.Equal(SourceFailures.ProviderPinned, (await net.Fetch("https://www.themoviedb.org/collection/10", new SourceFetchOptions { Provider = "tmdb", Fresh = true })).ErrorCode);
        Assert.Equal(seerrCalls, net.Requests.Count(r => r.RequestUri!.Host == "seerr.test"));

        // A pin of another site's provider: refused.
        Assert.Equal(SourceFailures.ProviderPinned, (await net.Fetch("https://www.themoviedb.org/collection/10", new SourceFetchOptions { Provider = "mdblist", Fresh = true })).ErrorCode);
    }

    // ── Cache identity ──────────────────────────────────────────────────

    [Fact]
    public async Task CachedResultsBelongToTheCredentialsThatReadThemNotToTheKeyLength()
    {
        using var net = new Net();
        var config = net.Plugin.Plugin.Configuration;
        config.TMDB_API_KEY = "aaaaaaaa";
        net.Routes["https://api.themoviedb.org/3/collection/10"] = request => Json("{\"id\":10,\"name\":\"" + (request.RequestUri!.Query.Contains("aaaaaaaa", StringComparison.Ordinal) ? "A" : "B") + "\",\"parts\":[{\"id\":11,\"title\":\"Star Wars\"}]}");

        var first = await net.Fetch("https://www.themoviedb.org/collection/10", new SourceFetchOptions());
        config.TMDB_API_KEY = "bbbbbbbb"; // same length, another key
        var second = await net.Fetch("https://www.themoviedb.org/collection/10", new SourceFetchOptions());

        Assert.Equal(("A", "B"), (first.Title, second.Title));
        config.TMDB_API_KEY = "aaaaaaaa";
        Assert.Equal("A", (await net.Fetch("https://www.themoviedb.org/collection/10", new SourceFetchOptions())).Title); // its own cached answer
    }

    // ── Read budgets ────────────────────────────────────────────────────

    [Fact]
    public async Task APerProviderReadBudgetRefusesWithATypedRetryableCode()
    {
        var now = new DateTime(2026, 10, 18, 12, 0, 0, DateTimeKind.Utc);
        var limits = new SourceReadLimits { PerProviderPerHour = new Dictionary<string, int>(StringComparer.Ordinal) { ["mdblist"] = 2 }, MaxPerCaller = 100 };
        using var net = new Net(limits, new RollingSourceReadAdmission(limits, () => now));
        net.Routes[MdbJson] = _ => Json(OneMovie);

        Assert.True((await net.Fetch(Mdb)).Ok);
        Assert.True((await net.Fetch(Mdb)).Ok);
        var refused = await net.Fetch(Mdb);
        Assert.Equal((false, SourceFailures.ReadBudgetExhausted), (refused.Ok, refused.ErrorCode));
        Assert.Equal(3600, refused.RetryAfterSeconds);
        Assert.Equal(2, net.Requests.Count); // the refused read never went out

        // A cached answer costs nothing; an hour later there is room again.
        Assert.True((await net.Fetch(Mdb, new SourceFetchOptions())).Ok);
        now = now.AddHours(1).AddSeconds(1);
        Assert.True((await net.Fetch(Mdb)).Ok);
        Assert.Equal(3, net.Requests.Count);
    }

    [Fact]
    public void BackgroundReadsLeaveAQuarterOfEachBudgetForPeopleWaiting()
    {
        var limits = new SourceReadLimits { PerProviderPerHour = new Dictionary<string, int>(StringComparer.Ordinal) { ["tmdb"] = 8 } };
        var admission = new RollingSourceReadAdmission(limits, () => new DateTime(2026, 10, 18, 12, 0, 0, DateTimeKind.Utc));

        var background = Enumerable.Range(0, 10).Count(_ => admission.TryAdmit("tmdb", background: true, out _));
        var interactive = Enumerable.Range(0, 10).Count(_ => admission.TryAdmit("tmdb", background: false, out _));

        Assert.Equal((6, 2), (background, interactive));
        Assert.False(admission.TryAdmit("tmdb", false, out var retry));
        Assert.True(retry > 0);
    }

    [Fact]
    public async Task EveryPageOfAListIsOneRead()
    {
        var limits = new SourceReadLimits { PerProviderPerHour = new Dictionary<string, int>(StringComparer.Ordinal) { ["tmdb"] = 2 } };
        using var net = new Net(limits);
        net.Plugin.Plugin.Configuration.TMDB_API_KEY = "tmdb-key";
        net.Routes["https://api.themoviedb.org/3/list/5"] = request =>
        {
            var page = System.Web.HttpUtility.ParseQueryString(request.RequestUri!.Query)["page"];
            return Json("{\"name\":\"L\",\"item_count\":3,\"total_pages\":3,\"items\":[{\"id\":" + page + ",\"media_type\":\"movie\",\"title\":\"M\"}]}");
        };

        var result = await net.Fetch("https://www.themoviedb.org/list/5");

        // Three pages, two reads allowed: a typed failure, never a silently shorter (and "complete") list.
        Assert.Equal((false, SourceFailures.ReadBudgetExhausted), (result.Ok, result.ErrorCode));
    }

    // ── Snapshots ───────────────────────────────────────────────────────

    private static SourceFetchResult Fetched(bool truncated = false, bool partial = false, params string[] keys) => new()
    {
        Ok = true,
        Kind = SourceKinds.Mdblist,
        Provider = "mdblist",
        Truncated = truncated,
        Partial = partial,
        Items = keys.Select(k => new SourceItem("movie", int.Parse(k, System.Globalization.CultureInfo.InvariantCulture), null, null, "M" + k, null, null, null, null)).ToList(),
    };

    [Fact]
    public void SnapshotsThatAreNotCompleteNeverRemoveOrReplace()
    {
        var last = new[] { "movie|1||", "movie|2||" };
        var complete = SourceSnapshots.Classify(Fetched(false, false, "1", "3"), last);
        var truncated = SourceSnapshots.Classify(Fetched(true, false, "1", "3"), last);
        var partial = SourceSnapshots.Classify(Fetched(false, true, "1", "3"), last);
        var emptyAfter = SourceSnapshots.Classify(Fetched(), last);
        var emptyFirst = SourceSnapshots.Classify(Fetched(), null);
        var failed = SourceSnapshots.Classify(new SourceFetchResult { Ok = false, ErrorCode = "rate_limited" }, last);
        var changed = SourceSnapshots.Classify(new SourceFetchResult { Ok = false, ErrorCode = ChronolistsPage.FormatChanged }, last);

        Assert.Equal((SnapshotState.Complete, true, true), (complete.State, complete.MayAdd, complete.MayRemoveAndReplace));
        Assert.Equal((SnapshotState.Truncated, true, false), (truncated.State, truncated.MayAdd, truncated.MayRemoveAndReplace));
        Assert.Equal((SnapshotState.Partial, true, false), (partial.State, partial.MayAdd, partial.MayRemoveAndReplace));
        Assert.Equal((SnapshotState.EmptyAfterNonEmpty, "empty_after_nonempty", false, false), (emptyAfter.State, emptyAfter.Code, emptyAfter.MayAdd, emptyAfter.MayRemoveAndReplace));
        Assert.Equal(SnapshotState.Complete, emptyFirst.State); // nothing to lose yet
        Assert.Equal((SnapshotState.Failed, "rate_limited", false), (failed.State, failed.Code, failed.MayAdd));
        Assert.Equal((SnapshotState.ShapeChanged, false), (changed.State, changed.MayAdd));
    }

    [Fact]
    public void ThePlanAddsInSourceOrderAndOnlyDropsOwnedKeysOfACompleteSnapshot()
    {
        var last = new[] { "movie|1||", "movie|2||", "movie|9||" };
        var present = new HashSet<string>(new[] { "movie|1||", "movie|2||", "movie|9||" }, StringComparer.Ordinal);
        var tombstones = new HashSet<string>(new[] { "movie|4||" }, StringComparer.Ordinal);
        var owned = new HashSet<string>(new[] { "movie|2||" }, StringComparer.Ordinal); // 9 is a manual entry the source also lists
        var fetched = Fetched(false, false, "5", "1", "4", "3");

        var (add, drop) = SourceSnapshots.Plan(fetched, SourceSnapshots.Classify(fetched, last), last, present, tombstones, owned);
        Assert.Equal(new[] { "movie|5||", "movie|3||" }, add); // source order; the editor's removal (4) stays removed
        Assert.Equal(new[] { "movie|2||" }, drop); // never the manual 9

        var partial = Fetched(false, true, "5", "1");
        var (partialAdd, partialDrop) = SourceSnapshots.Plan(partial, SourceSnapshots.Classify(partial, last), last, present, tombstones, owned);
        Assert.Equal(new[] { "movie|5||" }, partialAdd);
        Assert.Empty(partialDrop);

        var empty = Fetched();
        var (emptyAdd, emptyDrop) = SourceSnapshots.Plan(empty, SourceSnapshots.Classify(empty, last), last, present, tombstones, owned);
        Assert.Empty(emptyAdd);
        Assert.Empty(emptyDrop);
    }

    [Fact]
    public void TheSnapshotDigestFollowsMembershipAndOrder()
    {
        var a = SourceSnapshots.Describe(Fetched(false, false, "1", "2"));
        var b = SourceSnapshots.Describe(Fetched(false, false, "2", "1"));
        var c = SourceSnapshots.Describe(Fetched(false, false, "1", "2"));
        var t = SourceSnapshots.Describe(Fetched(true, false, "1", "2"));
        Assert.NotEqual(a.Digest, b.Digest);
        Assert.Equal(a.Digest, c.Digest);
        Assert.Equal(("complete", "truncated"), (a.State, t.State));
    }

    // ── Chronolists, the 2026 page format (recorded live 2026-10-18) ────

    private static ChronolistsList Read(string fixture)
    {
        Assert.True(ChronolistsPage.TryRead(ImportFixtures.Read(fixture), out var list, out var error), error);
        return list!;
    }

    [Fact]
    public void TheColumnFormatMcuPageIsReadInWatchOrderWithExactIds()
    {
        var list = Read("chronolists-mcu-2026-10.html");

        Assert.Equal(("Marvel Cinematic Universe", 580, 0, false), (list.Title, list.Total, list.Unusable, list.Truncated));
        Assert.Equal(41, list.Items.Count(i => i.MediaType == "movie"));
        Assert.Equal(539, list.Items.Count(i => i.MediaType == "tv"));
        Assert.Equal(580, list.Items.Select(i => i.Key).Distinct().Count());
        // Eyes of Wakanda 1x01–1x04 (1260 BC), then Captain America: The First Avenger, then Agent Carter.
        Assert.Equal(new[] { "tv|241388|1|1", "tv|241388|1|2", "tv|241388|1|3", "tv|241388|1|4", "movie|1771||", "tv|61550|1|1" }, list.Items.Take(6).Select(i => i.Key));
        var first = list.Items[0];
        Assert.Equal(("Eyes of Wakanda", "Into the Lion's Den", "2025-08-01", "Miniseries"), (first.Title, first.Details!.EpisodeTitle, first.Details.Date, first.Details.SeasonName));
        var movie = list.Items[4];
        Assert.Equal(("Captain America: The First Avenger", "tt0458339", "2011-07-22", 2011), (movie.Title, movie.ImdbId, movie.Details!.Date, movie.Year));
        Assert.Equal((61550, "tt3475734", 281485), (list.Items[5].TmdbId, list.Items[5].ImdbId, list.Items[5].TvdbId));
    }

    [Fact]
    public void TheColumnFormatArrowversePageGroupsIntoItsSixHundredNinetyNineRuns()
    {
        var list = Read("chronolists-dctv-2026-10.html");
        Assert.Equal(("DC Arrowverse", 827, 0), (list.Title, list.Total, list.Unusable));

        var positioned = list.Items.Select((item, i) => (item, i)).ToList();
        var groups = ListSourceGroups.Group(positioned, ListSourceGroups.Facts(list.Items));

        Assert.Equal(699, groups.Count);
        Assert.Equal(827, groups.Sum(g => g.Keys.Count)); // every episode keeps its own key
        // Arrow S1 (23) and S2 (23) are runs; the crossover era interleaves single episodes of Flash and Arrow.
        Assert.Equal(new[] { ("tv|1412|1|1", 23), ("tv|1412|2|1", 23), ("tv|60735|1|1", 1), ("tv|1412|3|1", 1), ("tv|60735|1|2", 1) }, groups.Take(5).Select(g => (g.Key, g.Keys.Count)));
        // Without TMDB's season counts no run claims a whole season: all of them are episodes entries.
        Assert.All(groups, g => Assert.Equal("episodes", g.Kind));

        // With the counts, the two 23-episode runs that are whole seasons become season entries; nothing else changes.
        var facts = ListSourceGroups.Facts(list.Items);
        facts.SeasonEpisodes[(1412, 1)] = 23;
        facts.SeasonEpisodes[(1412, 2)] = 23;
        facts.SeasonEpisodes[(60735, 1)] = 23;
        var counted = ListSourceGroups.Group(positioned, facts);
        Assert.Equal(new[] { "season", "season", "episodes" }, counted.Take(3).Select(g => g.Kind));
        Assert.Equal(699, counted.Count);
    }

    [Fact]
    public void BothChronolistsFormatsGiveTheSameEntries()
    {
        // The same three entries as rows (until 2026) and as columns (2026): identical items.
        const string Seasons = "\"m\":{\"3697\":{\"n\":\"Arrow\",\"sn\":\"Season 1\",\"i\":\"/a.jpg\",\"id\":1412,\"imdb\":\"tt2193021\",\"tvdb\":257655,\"s\":\"1\"}}";
        var rows = "{\"l\":[{\"t\":\"tv\",\"s\":\"1\",\"e\":\"1\",\"en\":\"Pilot\",\"sid\":3697,\"rd\":\"2012-10-10\"},{\"t\":\"movie\",\"id\":49521,\"n\":\"Man of Steel\",\"rd\":\"2013-06-12\",\"imdb\":\"tt0770828\"},{\"t\":\"tv\",\"s\":\"1\",\"e\":\"2\",\"en\":\"Honor Thy Father\",\"sid\":3697,\"rd\":\"2012-10-17\"}]," + Seasons + "}";
        var columns = "{\"sk\":[3697],\"mi\":[1],\"mv\":[{\"id\":49521,\"n\":\"Man of Steel\",\"rd\":\"2013-06-12\",\"imdb\":\"tt0770828\"}],\"sx\":[0,0],\"e\":[\"1\",\"2\"],\"en\":[\"Pilot\",\"Honor Thy Father\"],\"rd\":[\"2012-10-10\",\"2012-10-17\"]," + Seasons + "}";

        var a = Page(rows);
        var b = Page(columns);

        Assert.Equal(a.Items.Select(i => (i, i.Details)), b.Items.Select(i => (i, i.Details)));
        Assert.Equal(new[] { "tv|1412|1|1", "movie|49521||", "tv|1412|1|2" }, b.Items.Select(i => i.Key));
    }

    [Theory]
    [InlineData("{\"sk\":[3697],\"mi\":[0],\"mv\":[],\"sx\":[0],\"e\":[\"1\"],\"m\":{}}")] // a movie position without a movie
    [InlineData("{\"sk\":[3697],\"mi\":[],\"mv\":[],\"sx\":[0,0],\"e\":[\"1\"],\"m\":{}}")] // episode columns of different lengths
    [InlineData("{\"sk\":[3697],\"mi\":[],\"mv\":[],\"sx\":[0],\"e\":[\"1\"],\"en\":[\"a\",\"b\"],\"m\":{}}")] // a name column of another length
    [InlineData("{\"sk\":[3697],\"mi\":[2,1],\"mv\":[{\"id\":1,\"n\":\"A\"},{\"id\":2,\"n\":\"B\"}],\"sx\":[0],\"e\":[\"1\"],\"m\":{}}")] // positions out of order
    [InlineData("{\"sk\":[3697],\"mi\":[9],\"mv\":[{\"id\":1,\"n\":\"A\"}],\"sx\":[0],\"e\":[\"1\"],\"m\":{}}")] // a position past the end
    [InlineData("{\"sk\":[3697],\"mi\":[],\"mv\":[],\"sx\":[0],\"m\":{}}")] // no episode numbers
    public void ColumnsThatDontLineUpAreAFormatChange(string list)
    {
        var html = "<script id=\"__NEXT_DATA__\" type=\"application/json\">{\"props\":{\"pageProps\":{\"universe\":{\"name\":\"X\",\"list\":" + list + "}}},\"page\":\"/[universe]\"}</script>";
        Assert.False(ChronolistsPage.TryRead(html, out _, out var error));
        Assert.Equal(ChronolistsPage.FormatChanged, error);
    }

    private static ChronolistsList Page(string list)
    {
        var html = "<script id=\"__NEXT_DATA__\" type=\"application/json\">{\"props\":{\"pageProps\":{\"universe\":{\"name\":\"Test\",\"list\":" + list + "}}},\"page\":\"/[universe]\"}</script>";
        Assert.True(ChronolistsPage.TryRead(html, out var parsed, out var error), error);
        return parsed!;
    }
}
