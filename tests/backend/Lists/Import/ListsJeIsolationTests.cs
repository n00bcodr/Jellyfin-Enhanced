using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Import;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Sources;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class ListsJeIsolationTests
{
    private sealed class Net : IDisposable, IHttpClientFactory
    {
        public ApiPluginFixture Plugin { get; } = new();
        public IntegrationTransport Transport { get; }
        public TmdbResponseCache Tmdb { get; }
        public MetadataCallLimiter Limiter { get; } = new(4, TimeSpan.Zero, TimeProvider.System);
        public List<string> Hosts { get; } = new();
        public Action? CreatingClient { get; set; }
        public bool FailSeason { get; set; }
        public ListMetadataSources Metadata { get; }
        public SeerrImportLookup SeerrLookup { get; }
        public MetadataImportLookup Lookup { get; }
        public ListSourceFetcher Sources { get; }

        public Net()
        {
            var config = Plugin.Plugin.Configuration;
            ImportTestFlags.AllOn(config);
            config.ArrRequestBackend = "je";
            config.ArrPhase4ListJeMetadataEnabled = false;
            config.TMDB_API_KEY = "tmdb-test";
            config.JellyseerrEnabled = true;
            config.JellyseerrUrls = "http://seerr.test";
            config.JellyseerrApiKey = "seerr-test";
            Transport = new IntegrationTransport((request, _) =>
            {
                Hosts.Add(request.RequestUri!.Host);
                Assert.Equal("api.themoviedb.org", request.RequestUri.Host); // Seerr call trap
                var path = request.RequestUri.AbsolutePath;
                if (FailSeason && path.EndsWith("/season/1", StringComparison.Ordinal))
                    return Task.FromResult(IntegrationTransport.Response("{}", 503));
                var body = path.EndsWith("/season/1", StringComparison.Ordinal) ? SeasonJson
                    : path.Contains("/search/", StringComparison.Ordinal) ? "{\"page\":1,\"total_pages\":1,\"total_results\":0,\"results\":[]}"
                    : path.Contains("/trending/", StringComparison.Ordinal) ? "{\"page\":1,\"total_pages\":1,\"total_results\":0,\"results\":[]}"
                    : ShowJson;
                return Task.FromResult(RealProviders.Shape(request, IntegrationTransport.Response(body)));
            });
            Tmdb = new TmdbResponseCache(this, TimeProvider.System);
            var seerr = new ListMetadataService(this, Plugin.Core.Logger);
            Metadata = new ListMetadataSources(seerr, new TmdbListMetadataSource(Tmdb, Plugin.Core.Logger));
            SeerrLookup = new SeerrImportLookup(this, Limiter, Tmdb, Plugin.Core.Logger);
            Lookup = new MetadataImportLookup(new TmdbImportLookup(Tmdb, Limiter, Plugin.Core.Logger), SeerrLookup);
            Sources = new ListSourceFetcher(this, Tmdb, null, Limiter, Plugin.Core.Logger, null, null);
        }

        public HttpClient CreateClient(string name)
        {
            CreatingClient?.Invoke();
            return Transport.CreateClient(name);
        }

        public async Task<SourceFetchResult> FetchSource(string? provider)
        {
            Assert.True(ListSourceUrl.TryParse("https://www.themoviedb.org/trending/movie/week", out var source, out _));
            return await Sources.FetchAsync(source!, new SourceFetchOptions { Provider = provider }, CancellationToken.None);
        }

        public void Dispose() { Tmdb.Dispose(); Transport.Dispose(); Plugin.Dispose(); }
    }

    private const string ShowJson = """
        {"id":1399,"name":"Game of Thrones","first_air_date":"2011-04-17","status":"Ended","in_production":false,
         "external_ids":{"imdb_id":"tt0944947","tvdb_id":121361},"poster_path":null,"overview":"A show.",
         "last_episode_to_air":{"season_number":1,"episode_number":2,"air_date":"2011-04-24"},"next_episode_to_air":null,
         "seasons":[{"season_number":1,"episode_count":2,"air_date":"2011-04-17","name":"Season 1"}]}
        """;
    private const string SeasonJson = """
        {"id":1,"season_number":1,"air_date":"2011-04-17","poster_path":null,"episodes":[
         {"episode_number":1,"season_number":1,"show_id":1399,"name":"One","air_date":"2011-04-17"},
         {"episode_number":2,"season_number":1,"show_id":1399,"name":"Two","air_date":"2011-04-24"}]}
        """;

    private static Placeholder Season() => new() { Kind = PlaceholderKinds.Season, MediaType = "tv", TmdbId = 1399, SeasonNumber = 1 };

    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public async Task JeListsUseExistingTmdbAdapterRegardlessOfSeerrAndLegacyMetadataOptIn(bool seerrOn, bool legacyOptIn)
    {
        using var net = new Net();
        var config = net.Plugin.Plugin.Configuration;
        config.JellyseerrEnabled = seerrOn;
        config.ArrPhase4ListJeMetadataEnabled = legacyOptIn;
        Assert.True(net.Metadata.Available);
        var p = Season();
        var metadata = await net.Metadata.FetchAsync(p, TimeSpan.Zero, DateTime.UtcNow.Date, CancellationToken.None);
        Assert.NotNull(metadata);
        Assert.False(metadata.Partial);
        ListMetadataService.Apply(p, metadata);
        Assert.Equal(2, p.Expected.Count);
        Assert.Equal("2011-04-24", p.Expected[1].AirDate);
        Assert.False(p.InProduction);
        Assert.Equal(121361, p.TvdbId);
        Assert.All(net.Hosts, host => Assert.Equal("api.themoviedb.org", host));
        Assert.Equal(2, net.Hosts.Count);
    }

    [Fact]
    public async Task JeMissingTmdbKeyLeavesMetadataAndImportUnknownWithoutSeerrFallback()
    {
        using var net = new Net();
        net.Plugin.Plugin.Configuration.TMDB_API_KEY = string.Empty;
        Assert.False(net.Metadata.Available);
        Assert.False(net.Lookup.IsConfigured);
        Assert.Equal(string.Empty, net.Lookup.Provider);
        Assert.Null(await net.Metadata.FetchAsync(Season(), TimeSpan.Zero, DateTime.UtcNow, CancellationToken.None));
        await net.Lookup.SearchAsync("test", new ImportCallContext("test", false), CancellationToken.None);
        Assert.False(PlaceholderProgress.IsComplete(Season(), DateTime.UtcNow));
        Assert.Empty(net.Hosts);
    }

    [Theory]
    [InlineData("je", "tmdb")]
    [InlineData("seerr", "seerr")]
    public void MetadataBackendSelectionPreservesSeerrMode(string backend, string expected)
    {
        using var net = new Net();
        net.Plugin.Plugin.Configuration.ArrRequestBackend = backend;
        net.Plugin.Plugin.Configuration.TMDB_API_KEY = string.Empty;
        Assert.Equal(expected == "seerr", net.Metadata.Available);
        Assert.Equal(expected == "seerr", net.SeerrLookup.IsConfigured);
    }

    [Theory]
    [InlineData("metadata")]
    [InlineData("import")]
    [InlineData("source")]
    public async Task SwitchingToJeAtClientCreationBlocksAlreadyAdmittedSeerrSend(string entryPoint)
    {
        using var net = new Net();
        net.Plugin.Plugin.Configuration.ArrRequestBackend = "seerr";
        net.CreatingClient = () => net.Plugin.Plugin.Configuration.ArrRequestBackend = "je";
        if (entryPoint == "metadata")
            Assert.Null(await net.Metadata.FetchAsync(Season(), TimeSpan.Zero, DateTime.UtcNow, CancellationToken.None));
        else if (entryPoint == "import")
            await net.SeerrLookup.SearchAsync("test", new ImportCallContext("test", false), CancellationToken.None);
        else
            Assert.False((await net.FetchSource("seerr")).Ok);
        Assert.Empty(net.Hosts);
    }

    [Fact]
    public async Task PinnedSeerrSourceIsInactiveAndCannotDeleteExistingMembers()
    {
        using var net = new Net();
        var result = await net.FetchSource("seerr");
        Assert.False(result.Ok);
        Assert.Equal(SourceFailures.ProviderPinned, result.ErrorCode);
        var keys = new[] { "movie|1||" };
        var plan = SourceSnapshots.Plan(result, SourceSnapshots.Classify(result, keys), keys, keys.ToHashSet(), new HashSet<string>(), keys.ToHashSet());
        Assert.Empty(plan.Add);
        Assert.Empty(plan.Drop);
        Assert.Empty(net.Hosts);
    }

    [Fact]
    public async Task JeSourceWithoutTmdbDoesNotFallBackToConfiguredSeerr()
    {
        using var net = new Net();
        net.Plugin.Plugin.Configuration.TMDB_API_KEY = string.Empty;
        Assert.False((await net.FetchSource(null)).Ok);
        Assert.Empty(net.Hosts);
    }

    [Fact]
    public async Task ListsOffStillDisablesTmdbPlaceholderMetadata()
    {
        using var net = new Net();
        net.Plugin.Plugin.Configuration.ArrPhase4ListPlaceholdersEnabled = false;
        Assert.False(net.Metadata.Available);
        Assert.Null(await net.Metadata.FetchAsync(Season(), TimeSpan.Zero, DateTime.UtcNow, CancellationToken.None));
        Assert.Empty(net.Hosts);
    }

    [Fact]
    public async Task FailedJeSeasonReadCannotInventCompletion()
    {
        using var net = new Net { FailSeason = true };
        var p = Season();
        var metadata = await net.Metadata.FetchAsync(p, TimeSpan.Zero, DateTime.UtcNow, CancellationToken.None);
        Assert.NotNull(metadata);
        Assert.True(metadata.Partial);
        ListMetadataService.Apply(p, metadata);
        Assert.Empty(p.Expected);
        Assert.False(PlaceholderProgress.IsComplete(p, DateTime.UtcNow));
    }

    [Fact]
    public async Task WholeSeriesRequestSelectionReadsTheTmdbExpectedEpisodes()
    {
        using var net = new Net();
        var p = new Placeholder { Kind = PlaceholderKinds.Series, MediaType = "tv", TmdbId = 1399 };
        Assert.Null(ListRules.RequestInput(p));
        var metadata = await net.Metadata.FetchAsync(p, TimeSpan.Zero, DateTime.UtcNow, CancellationToken.None);
        Assert.NotNull(metadata);
        ListMetadataService.Apply(p, metadata);
        Assert.Equal(new[] { 1 }, ListRules.RequestInput(p)!.Seasons);
        Assert.Equal(2, p.Expected.Count);
        Assert.False(p.InProduction);
    }

    [Fact]
    public async Task SavedSeerrPinIsProjectedInactiveWithoutChangingStoredMembersOrConsent()
    {
        using var h = new ListsHarness();
        h.Plugin.Plugin.Configuration.ArrRequestBackend = "je";
        var owner = h.NewUser("owner");
        var access = h.AccessFor(h.Host.AddPlaylist(owner), owner);
        var doc = h.Store.LoadForUpdate(access.ListIdN, ListKinds.Playlist);
        var placeholder = ListsHarness.Movie(9);
        doc.Items.Add(placeholder);
        doc.Source = new ListSource { Kind = "tmdb", Provider = "seerr", Url = "https://www.themoviedb.org/list/1", SyncEnabled = true, RemoveDropped = true };
        h.Store.Save(doc);
        var view = await h.Service.ViewAsync(access, CancellationToken.None);
        Assert.NotNull(view);
        Assert.Equal(SourceFailures.ProviderPinned, view.Source!.PausedCode);
        Assert.False(view.Source.SyncEnabled);
        Assert.Contains("inactive", view.Source.PausedReason, StringComparison.Ordinal);
        var stored = h.Store.Load(access.ListIdN)!;
        Assert.Equal(placeholder.Id, Assert.Single(stored.Items).Id);
        Assert.Equal("seerr", stored.Source!.Provider);
        Assert.True(stored.Source.SyncEnabled);
        Assert.Null(stored.Source.PausedCode);
    }
}
