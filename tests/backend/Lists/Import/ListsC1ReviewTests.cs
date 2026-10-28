using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Import;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Sources;
using Jellyfin.Database.Implementations.Entities;
using Moq;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class ListsC1ReviewTests
{
    private const string Show = """
        {"id":1399,"name":"Show","first_air_date":"2011-04-17","status":"Returning Series","in_production":true,
         "external_ids":{"imdb_id":"tt0944947","tvdb_id":121361},"poster_path":null,"overview":"Show.",
         "last_episode_to_air":{"season_number":1,"episode_number":2,"air_date":"2011-04-24"},"next_episode_to_air":null,
         "seasons":[{"season_number":1,"episode_count":8,"air_date":"2011-04-17","name":"Season 1"}]}
        """;
    private const string Season = """
        {"season_number":1,"air_date":"2011-04-17","poster_path":null,"episodes":[
         {"episode_number":1,"season_number":1,"show_id":1399,"name":"One","air_date":"2011-04-17"},
         {"episode_number":2,"season_number":1,"show_id":1399,"name":"Two","air_date":"2011-04-24"}]}
        """;
    private const string Page = "{\"page\":1,\"total_pages\":1,\"total_results\":0,\"results\":[]}";
    private sealed class Clock : TimeProvider
    {
        public DateTimeOffset Now = DateTimeOffset.UtcNow - TimeSpan.FromHours(5);
        public override DateTimeOffset GetUtcNow() => Now;
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task IncompleteTmdbSeasonNeverCompletesTheTwoKnownEpisodes(bool undated)
    {
        using var h = new ListsHarness();
        var config = h.Plugin.Plugin.Configuration;
        config.ArrRequestBackend = "je";
        config.TMDB_API_KEY = "test";
        var show = undated ? Show.Replace("\"episode_count\":8", "\"episode_count\":2", StringComparison.Ordinal) : Show;
        using var transport = new IntegrationTransport((request, _) => Task.FromResult(IntegrationTransport.Response(
            request.RequestUri!.AbsolutePath.EndsWith("/season/1", StringComparison.Ordinal)
                ? undated ? Season.Replace("\"2011-04-24\"", "null", StringComparison.Ordinal) : Season : show)));
        using var cache = new TmdbResponseCache(transport, TimeProvider.System);
        var source = new TmdbListMetadataSource(cache, h.Plugin.Core.Logger);
        var p = ListsHarness.Ph("{\"kind\":\"season\",\"tmdbId\":1399,\"seasonNumber\":1,\"title\":\"Show\"}");
        var facts = await source.FetchAsync(p, TimeSpan.Zero, DateTime.UtcNow, default);
        Assert.NotNull(facts);
        Assert.True(facts.Partial);
        ListMetadataService.Apply(p, facts);
        p.Filled.AddRange(new[] { 1, 2 }.Select(e => new FilledEpisode { S = 1, E = e, ItemId = Guid.NewGuid().ToString("N") }));
        Assert.False(PlaceholderProgress.IsComplete(p, DateTime.UtcNow));
        Assert.Empty(p.Expected);
        var owner = h.NewUser("owner");
        var access = h.AccessFor(h.Host.AddPlaylist(owner), owner);
        var doc = h.Store.LoadForUpdate(access.ListIdN, ListKinds.Playlist);
        doc.Items.Add(p);
        doc.Order.Add(ListsHarness.P(p.Id));
        h.Store.Save(doc);
        using var swap = new ListSwapService(h.Store, h.Host, h.Users.Object, h.Resolver, new BufferedMetadata(facts), h.Plugin.Core.Logger);
        var pass = await swap.RunListPassAsync(access.ListIdN, null, MetadataMode.New, default);
        Assert.Equal(0, pass.Retired);
        Assert.Single(h.Store.Load(access.ListIdN)!.Items);
    }

    [Fact]
    public async Task CachedTmdbMetadataRetainsTheOldestUnderlyingFetchTime()
    {
        using var h = new ListsHarness();
        h.Plugin.Plugin.Configuration.ArrRequestBackend = "je";
        h.Plugin.Plugin.Configuration.TMDB_API_KEY = "test";
        var clock = new Clock();
        using var transport = new IntegrationTransport((r, _) => Task.FromResult(IntegrationTransport.Response(
            r.RequestUri!.AbsolutePath.EndsWith("/season/1", StringComparison.Ordinal) ? Season : Show.Replace("\"episode_count\":8", "\"episode_count\":2", StringComparison.Ordinal))));
        using var cache = new TmdbResponseCache(transport, clock);
        await cache.GetListMetadataAsync("tv/1399", "?append_to_response=external_ids", "test", default, refresh: false);
        var oldest = clock.Now.UtcDateTime;
        clock.Now += TimeSpan.FromMinutes(5);
        await cache.GetListMetadataAsync("tv/1399/season/1", "", "test", default, refresh: false);
        clock.Now = DateTimeOffset.UtcNow;
        var source = new TmdbListMetadataSource(cache, h.Plugin.Core.Logger);
        var p = new Placeholder { Kind = PlaceholderKinds.Season, TmdbId = 1399, SeasonNumber = 1 };
        var facts = await source.FetchAsync(p, TimeSpan.FromHours(12), DateTime.UtcNow, default);
        Assert.NotNull(facts);
        Assert.Equal(oldest, facts.FetchedAtUtc);
        Assert.True(DateTime.UtcNow - facts.FetchedAtUtc > ListSwapService.CompletionMetadataMaxAge);
        Assert.Equal(2, transport.Calls);
        var owner = h.NewUser("owner");
        var access = h.AccessFor(h.Host.AddPlaylist(owner), owner);
        var series = h.Host.AddSeries(tmdb: 1399);
        h.Host.AddEpisode(series, 1, 1);
        h.Host.AddEpisode(series, 1, 2);
        p = ListsHarness.Ph("{\"kind\":\"season\",\"tmdbId\":1399,\"seasonNumber\":1,\"title\":\"Show\"}");
        var doc = h.Store.LoadForUpdate(access.ListIdN, ListKinds.Playlist);
        doc.Items.Add(p);
        doc.Order.Add(ListsHarness.P(p.Id));
        h.Store.Save(doc);
        await h.Consent(access);
        using var swap = new ListSwapService(h.Store, h.Host, h.Users.Object, h.Resolver, new BufferedMetadata(facts), h.Plugin.Core.Logger,
            preferences: h.Preferences, access: h.Access);
        var pass = await swap.RunListPassAsync(access.ListIdN, null, MetadataMode.New, default);
        Assert.Equal(0, pass.Retired);
        Assert.Single(h.Store.Load(access.ListIdN)!.Items);
        var refreshed = await source.FetchAsync(p, TimeSpan.Zero, DateTime.UtcNow, default);
        Assert.True(refreshed!.FetchedAtUtc > oldest);
        Assert.Equal(4, transport.Calls);
    }

    [Theory]
    [InlineData("https://www.themoviedb.org/tv/upcoming", "discover/tv")]
    [InlineData("https://www.themoviedb.org/movie/upcoming", "movie/upcoming")]
    [InlineData("https://www.themoviedb.org/trending/tv/week", "trending/tv/week")]
    [InlineData("https://www.themoviedb.org/collection/1", "collection/1")]
    [InlineData("https://www.themoviedb.org/list/1", "list/1")]
    public async Task JeSourcesChooseTmdbIncludingUpcomingTv(string url, string path)
    {
        using var h = new ListsHarness(seerr: true);
        var c = h.Plugin.Plugin.Configuration;
        ImportTestFlags.AllOn(c);
        c.ArrRequestBackend = "je";
        c.TMDB_API_KEY = "test";
        using var transport = new IntegrationTransport((r, _) =>
        {
            Assert.Equal("api.themoviedb.org", r.RequestUri!.Host);
            Assert.Equal("/3/" + path, r.RequestUri.AbsolutePath);
            if (path == "discover/tv") Assert.Contains("first_air_date.gte=", r.RequestUri.Query, StringComparison.Ordinal);
            var json = path == "collection/1" ? "{\"id\":1,\"name\":\"Collection\",\"parts\":[]}"
                : path == "list/1" ? "{\"id\":1,\"name\":\"List\",\"page\":1,\"total_pages\":1,\"item_count\":0,\"items\":[]}" : Page;
            return Task.FromResult(IntegrationTransport.Response(json));
        });
        using var cache = new TmdbResponseCache(transport, TimeProvider.System);
        var fetcher = new ListSourceFetcher(transport, cache, null, new MetadataCallLimiter(4, TimeSpan.Zero, TimeProvider.System), h.Plugin.Core.Logger, null, null);
        Assert.True(ListSourceUrl.TryParse(url, out var source, out _));
        var result = await fetcher.FetchAsync(source!, new SourceFetchOptions(), default);
        Assert.True(result.Ok, result.ErrorCode);
        Assert.Equal("tmdb", result.Provider);
        c.TMDB_API_KEY = "";
        result = await fetcher.FetchAsync(source!, new SourceFetchOptions { Fresh = true }, default);
        Assert.False(result.Ok);
        Assert.DoesNotContain("or Seerr", result.Message ?? "", StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("metadata")]
    [InlineData("import")]
    [InlineData("source")]
    public async Task SeerrReplyAfterSwitchIsDroppedAndCannotPoisonTheCache(string reader)
    {
        using var h = new ListsHarness(seerr: true);
        var c = h.Plugin.Plugin.Configuration;
        ImportTestFlags.AllOn(c);
        c.ArrRequestBackend = "seerr";
        c.TMDB_API_KEY = "";
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var delayed = true;
        using var transport = new IntegrationTransport(async (r, ct) =>
        {
            if (delayed) { entered.TrySetResult(); await release.Task.WaitAsync(ct); }
            return IntegrationTransport.Response(reader == "metadata"
                ? "{\"id\":1,\"title\":\"Movie\",\"releaseDate\":\"2020-01-01\",\"posterPath\":null,\"overview\":\"Movie\",\"externalIds\":{\"imdbId\":null}}"
                : "{\"page\":1,\"totalPages\":1,\"totalResults\":1,\"results\":[{\"id\":1,\"mediaType\":\"movie\",\"title\":\"Movie\"}]}");
        });
        using var cache = new TmdbResponseCache(transport, TimeProvider.System);
        var limiter = new MetadataCallLimiter(4, TimeSpan.Zero, TimeProvider.System);
        var metadata = new ListMetadataService(transport, h.Plugin.Core.Logger);
        var lookup = new SeerrImportLookup(transport, limiter, cache, h.Plugin.Core.Logger);
        var sources = new ListSourceFetcher(transport, cache, null, limiter, h.Plugin.Core.Logger, null, null);
        Assert.True(ListSourceUrl.TryParse("https://www.themoviedb.org/trending/movie/week", out var source, out _));
        var p = new Placeholder { Kind = PlaceholderKinds.Movie, TmdbId = 1 };
        async Task<bool> Read() => reader == "metadata" ? await metadata.FetchAsync(p, TimeSpan.FromHours(12), DateTime.UtcNow, default) != null
            : reader == "import" ? (await lookup.SearchAsync("Movie", new ImportCallContext("test", false), default)).Status == LookupStatus.Ok
            : (await sources.FetchAsync(source!, new SourceFetchOptions { Provider = "seerr" }, default)).Ok;
        var pending = Read();
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        c.ArrRequestBackend = "je";
        release.SetResult();
        Assert.False(await pending.WaitAsync(TimeSpan.FromSeconds(5)));
        c.ArrRequestBackend = "seerr";
        delayed = false;
        Assert.True(await Read());
        Assert.Equal(2, transport.Calls);
    }

    private sealed class BufferedMetadata(PlaceholderMetadata facts) : IListMetadataSource
    {
        public TaskCompletionSource Read { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public bool Available => true;
        public bool PostersAvailable => false;
        public Task<PlaceholderMetadata?> FetchAsync(Placeholder p, TimeSpan age, DateTime today, CancellationToken ct)
        {
            Read.TrySetResult();
            return Task.FromResult<PlaceholderMetadata?>(facts);
        }
        public Task<string?> FetchTmdbPosterAsync(Placeholder p, CancellationToken ct) => Task.FromResult<string?>(null);
        public Task<(string? Poster, bool Answered)> ReadTmdbPosterAsync(Placeholder p, CancellationToken ct) => Task.FromResult<(string?, bool)>((null, false));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task CompositionDropsBufferedProviderResultsAfterSwitch(bool sourcePreview)
    {
        using var h = new ImportHarness();
        h.Plugin.Plugin.Configuration.ArrRequestBackend = "seerr";
        var caller = h.NewUser("owner");
        h.Lookup.AddSearch("Movie", FakeImportLookup.Movie(1, "Movie", "2020-01-01"));
        var viewer = new Mock<IImportViewerPolicy>();
        viewer.Setup(v => v.For(It.IsAny<User>())).Returns(() =>
        {
            h.Plugin.Plugin.Configuration.ArrRequestBackend = "je";
            return ImportViewer.None;
        });
        if (sourcePreview)
        {
            h.Fetcher.Provider = "seerr";
            var preview = new ListSourcePreview(h.Fetcher, h.ImportResolver, h.Access, h.Plugin.Core.Logger, viewer.Object);
            var result = await preview.FetchAsync(caller, "https://www.themoviedb.org/trending/movie/week", default);
            Assert.IsType<ListErrorDto>(result.Value);
            Assert.Equal("configuration_changed", ((ListErrorDto)result.Value!).Code);
        }
        else
        {
            var resolver = new ListImportResolver(h.Lookup, h.Library, h.Access, h.Limiter, h.Plugin.Core.Logger, viewer.Object);
            var result = await resolver.ResolveAsync(new[] { new ImportEntryDto { Title = "Movie" } },
                new ImportResolveOptions { Caller = caller, LibraryUsers = new[] { caller }, Context = new ImportCallContext("test", false) }, default);
            Assert.Equal("transient", Assert.Single(result.Response.Results).State);
            Assert.Null(result.Response.Results[0].Match);
            Assert.False(result.Response.Complete);
            Assert.Equal("", result.Response.MetadataProvider);
        }
    }

    [Fact]
    public async Task SavedBackendRoundTripInvalidatesAlreadyBufferedMetadata()
    {
        using var h = new ListsHarness(seerr: true);
        var c = h.Plugin.Plugin.Configuration;
        c.ArrRequestBackend = "seerr";
        h.MovieDetails[1] = "{\"id\":1,\"title\":\"Movie\",\"releaseDate\":\"2020-01-01\",\"posterPath\":null,\"overview\":\"Movie\",\"externalIds\":{\"imdbId\":null}}";
        var p = ListsHarness.Movie(1);
        var facts = await h.Metadata.FetchAsync(p, TimeSpan.Zero, DateTime.UtcNow, default);
        Assert.NotNull(facts);
        c.ArrRequestBackend = "je";
        h.Plugin.Plugin.SaveConfiguration(c);
        c.ArrRequestBackend = "seerr";
        h.Plugin.Plugin.SaveConfiguration(c);
        Assert.False(ListMetadataService.Apply(p, facts));
        Assert.Null(p.ReleaseDate);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task StandaloneApplyAndLinkRejectMetadataConvertedBeforeWaitingForTheLock(bool link)
    {
        using var h = new ListsHarness(seerr: true);
        h.Plugin.Plugin.Configuration.ArrRequestBackend = "seerr";
        var owner = h.NewUser("owner");
        var access = h.AccessFor(h.Host.AddPlaylist(owner), owner);
        var p = ListsHarness.Movie(1);
        h.MovieDetails[1] = "{\"id\":1,\"title\":\"Movie\",\"releaseDate\":\"2020-01-01\",\"posterPath\":\"/server.jpg\",\"overview\":\"Movie\",\"externalIds\":{\"imdbId\":null}}";
        Assert.NotNull(await h.Metadata.FetchAsync(p, TimeSpan.Zero, DateTime.UtcNow, default));
        var custom = ListsHarness.Ph("{\"kind\":\"custom\",\"title\":\"Custom\"}");
        var doc = h.Store.LoadForUpdate(access.ListIdN, ListKinds.Playlist);
        if (link) { doc.Items.Add(custom); doc.Order.Add(ListsHarness.P(custom.Id)); }
        h.Store.Save(doc);
        var rev = h.Store.Load(access.ListIdN)!.Rev;
        Task<ListOutcome> pending;
        using (await h.Store.LockAsync(access.ListIdN))
        {
            pending = link ? h.Service.PatchAsync(access, custom.Id, rev, null, p, null, default)
                : h.Service.AddPlaceholdersAsync(access, new[] { p }, null, null, null, default);
            // Warm metadata is converted synchronously before the lock wait, rather than arriving after the switch.
            Assert.Equal("/server.jpg", p.PosterPath);
            Assert.False(pending.IsCompleted);
            h.Plugin.Plugin.Configuration.ArrRequestBackend = "je";
        }
        var result = await pending.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(409, result.StatusCode);
        var stored = h.Store.Load(access.ListIdN)!;
        if (link) Assert.Equal(PlaceholderKinds.Custom, Assert.Single(stored.Items).Kind);
        else Assert.Empty(stored.Items);
    }

    [Fact]
    public async Task SeerrFactsBufferedAtTheListLockAreNotAppliedAfterSwitch()
    {
        using var h = new ListsHarness(seerr: true);
        h.Plugin.Plugin.Configuration.ArrRequestBackend = "seerr";
        var owner = h.NewUser("owner");
        var access = h.AccessFor(h.Host.AddPlaylist(owner), owner);
        var p = ListsHarness.Movie(1);
        var doc = h.Store.LoadForUpdate(access.ListIdN, ListKinds.Playlist);
        doc.Items.Add(p);
        doc.Order.Add(ListsHarness.P(p.Id));
        h.Store.Save(doc);
        h.MovieDetails[1] = "{\"id\":1,\"title\":\"Movie\",\"releaseDate\":\"2020-01-01\",\"posterPath\":null,\"overview\":\"Movie\",\"externalIds\":{\"imdbId\":null}}";
        var facts = await h.Metadata.FetchAsync(p, TimeSpan.Zero, DateTime.UtcNow, default);
        Assert.NotNull(facts);
        var buffered = new BufferedMetadata(facts);
        using var swap = new ListSwapService(h.Store, h.Host, h.Users.Object, h.Resolver, buffered, h.Plugin.Core.Logger);
        Task<SwapPassResult> pending;
        using (await h.Store.LockAsync(access.ListIdN))
        {
            pending = swap.RunListPassAsync(access.ListIdN, null, MetadataMode.New, default);
            await buffered.Read.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.False(pending.IsCompleted);
            h.Plugin.Plugin.Configuration.ArrRequestBackend = "je";
        }
        await pending.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Null(Assert.Single(h.Store.Load(access.ListIdN)!.Items).ReleaseDate);
        Assert.False(ListMetadataService.Apply(p, facts));
    }
    [Theory]
    [InlineData("season", "last")]
    [InlineData("series", "last")]
    [InlineData("season", "next")]
    [InlineData("series", "next")]
    [InlineData("series", "later")]
    [InlineData("season", "overlap")]
    [InlineData("series", "overlap")]
    [InlineData("season", "special")]
    [InlineData("season", "partial")]
    [InlineData("season", "future")]
    public async Task CrossCheckedEvidenceNeverCompletesAnOmittedKnownEpisode(string kind, string scenario)
    {
        using var h = new ListsHarness();
        h.Plugin.Plugin.Configuration.ArrRequestBackend = "je";
        h.Plugin.Plugin.Configuration.TMDB_API_KEY = "test";
        var show = Show.Replace("\"episode_count\":8", "\"episode_count\":2", StringComparison.Ordinal);
        var season = Season;
        var number = 1;
        if (scenario == "last") show = show.Replace("\"episode_number\":2", "\"episode_number\":8", StringComparison.Ordinal);
        if (scenario == "next") show = show.Replace("\"next_episode_to_air\":null", "\"next_episode_to_air\":{\"season_number\":1,\"episode_number\":8,\"air_date\":\"2099-01-01\"}", StringComparison.Ordinal);
        if (scenario == "overlap") show = show.Replace("\"next_episode_to_air\":null", "\"next_episode_to_air\":{\"season_number\":1,\"episode_number\":1,\"air_date\":\"2099-01-01\"}", StringComparison.Ordinal);
        if (scenario == "later")
        {
            show = show.Replace("\"season_number\":1,\"episode_number\":2", "\"season_number\":2,\"episode_number\":8", StringComparison.Ordinal)
                .Replace("\"name\":\"Season 1\"}", "\"name\":\"Season 1\"},{\"season_number\":2,\"episode_count\":2,\"air_date\":\"2011-04-17\"}", StringComparison.Ordinal);
        }
        if (scenario == "special")
        {
            number = 0;
            show = show.Replace("\"season_number\":1", "\"season_number\":0", StringComparison.Ordinal).Replace("\"episode_number\":2", "\"episode_number\":8", StringComparison.Ordinal);
            season = season.Replace("\"season_number\":1", "\"season_number\":0", StringComparison.Ordinal);
        }
        if (scenario == "partial") season = season.Replace("\"episode_number\":2", "\"episode_number\":3", StringComparison.Ordinal);
        if (scenario == "future") season = season.Replace("2011-04-24", "2099-01-01", StringComparison.Ordinal);
        if (kind == "series") show = show.Replace("Returning Series", "Ended", StringComparison.Ordinal);
        using var transport = new IntegrationTransport((r, _) => Task.FromResult(IntegrationTransport.Response(
            r.RequestUri!.AbsolutePath.Contains("/season/", StringComparison.Ordinal) ? season : show)));
        using var cache = new TmdbResponseCache(transport, TimeProvider.System);
        var source = new TmdbListMetadataSource(cache, h.Plugin.Core.Logger);
        var coordinate = kind == "series" ? "" : $",\"seasonNumber\":{number}";
        var p = ListsHarness.Ph($"{{\"kind\":\"{kind}\",\"tmdbId\":1399{coordinate},\"title\":\"Show\"}}");
        var facts = await source.FetchAsync(p, TimeSpan.Zero, DateTime.UtcNow, default);
        Assert.NotNull(facts);
        Assert.True(facts.Partial);
        Assert.Null(facts.Expected);
        p.Expected = new[] { 1, 2 }.Select(e => new PlaceholderEpisode { S = number, E = e, AirDate = "2011-04-24" }).ToList();
        p.InProduction = false;
        ListMetadataService.Apply(p, facts);
        p.Filled.AddRange(new[] { 1, 2 }.Select(e => new FilledEpisode { S = number, E = e, ItemId = Guid.NewGuid().ToString("N") }));
        Assert.False(PlaceholderProgress.IsComplete(p, DateTime.UtcNow));
        var owner = h.NewUser("owner");
        var access = h.AccessFor(h.Host.AddPlaylist(owner), owner);
        var doc = h.Store.LoadForUpdate(access.ListIdN, ListKinds.Playlist);
        doc.Items.Add(p); doc.Order.Add(ListsHarness.P(p.Id)); h.Store.Save(doc);
        Assert.False(PlaceholderProgress.IsComplete(Assert.Single(h.Store.Load(access.ListIdN)!.Items), DateTime.UtcNow));
        if (kind == "series") Assert.Null(ListRules.RequestInput(p));
        using var swap = new ListSwapService(h.Store, h.Host, h.Users.Object, h.Resolver, new BufferedMetadata(facts), h.Plugin.Core.Logger);
        var pass = await swap.RunListPassAsync(access.ListIdN, null, MetadataMode.New, default);
        Assert.Equal(0, pass.Retired);
        Assert.Single(h.Store.Load(access.ListIdN)!.Items);
    }

    // These bounded waits deliberately keep a Monitor owned: awaiting would release the simulated commit ordering.
#pragma warning disable xUnit1031
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task BufferedMutationSharesTheConfigurationCommitBoundary(bool continuation)
    {
        using var h = new ListsHarness(seerr: true);
        var c = h.Plugin.Plugin.Configuration;
        c.ArrRequestBackend = "seerr";
        h.MovieDetails[1] = "{\"id\":1,\"releaseDate\":\"2020-01-01\",\"posterPath\":null,\"imdbId\":null}";
        var p = ListsHarness.Movie(1);
        var facts = await h.Metadata.FetchAsync(p, TimeSpan.Zero, DateTime.UtcNow, default);
        Assert.NotNull(facts);
        using var flow = continuation ? new ListContinuation(h.Store, () => null) : null;
        Task<bool> work;
        bool escaped;
        lock (Jellyfin.Plugin.JellyfinEnhanced.JellyfinEnhanced.ConfigurationLock)
        {
            work = Task.Run(() =>
            {
                try { return continuation ? ListContinuation.Write(() => { p.ReleaseDate = "2020-01-01"; return true; }) : ListMetadataService.Apply(p, facts); }
                catch (ListAccessLostException) { return false; }
            });
            escaped = work.Wait(TimeSpan.FromMilliseconds(250));
            c.ArrRequestBackend = "je";
            h.Plugin.Plugin.SaveConfiguration(c);
        }
        Assert.False(await work.WaitAsync(TimeSpan.FromSeconds(5)));
        Assert.False(escaped);
        Assert.Null(p.ReleaseDate);
    }

    [Theory]
    [InlineData("metadata")]
    [InlineData("je-metadata")]
    [InlineData("import")]
    [InlineData("je-import")]
    [InlineData("source")]
    [InlineData("je-source")]
    [InlineData("poster")]
    [InlineData("poster-string")]
    [InlineData("find")]
    [InlineData("je-find")]
    public async Task ProviderReplyCannotPublishInsideAConfigurationCommit(string reader)
    {
        using var h = new ListsHarness(seerr: true);
        var c = h.Plugin.Plugin.Configuration;
        ImportTestFlags.AllOn(c);
        c.ArrRequestBackend = reader.StartsWith("je-", StringComparison.Ordinal) || reader == "poster" ? "je" : "seerr";
        c.TMDB_API_KEY = "test";
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var transport = new IntegrationTransport(async (_, ct) =>
        {
            entered.TrySetResult(); await release.Task.WaitAsync(ct);
            return IntegrationTransport.Response(reader == "metadata" ? "{\"id\":1,\"releaseDate\":\"2020-01-01\",\"posterPath\":null,\"imdbId\":null}"
                : reader == "je-metadata" ? "{\"id\":1,\"release_date\":\"2020-01-01\",\"poster_path\":null,\"external_ids\":{\"imdb_id\":null}}"
                : reader is "poster" or "poster-string" ? "{\"id\":1,\"poster_path\":\"/server.jpg\"}"
                : reader is "find" or "je-find" ? "{\"tv_episode_results\":[{\"show_id\":1396,\"season_number\":1,\"episode_number\":1,\"name\":\"Pilot\",\"air_date\":\"2008-01-20\"}]}"
                : reader is "je-import" or "je-source" ? "{\"page\":1,\"total_pages\":1,\"total_results\":1,\"results\":[{\"id\":1,\"media_type\":\"movie\",\"title\":\"Movie\"}]}"
                : "{\"page\":1,\"totalPages\":1,\"totalResults\":1,\"results\":[{\"id\":1,\"mediaType\":\"movie\",\"title\":\"Movie\"}]}");
        });
        using var cache = new TmdbResponseCache(transport, TimeProvider.System);
        var limiter = new MetadataCallLimiter(4, TimeSpan.Zero, TimeProvider.System);
        var metadata = new ListMetadataService(transport, h.Plugin.Core.Logger);
        var je = new TmdbListMetadataSource(cache, h.Plugin.Core.Logger);
        IImportLookup lookup = reader.StartsWith("je-", StringComparison.Ordinal) ? new TmdbImportLookup(cache, limiter, h.Plugin.Core.Logger) : new SeerrImportLookup(transport, limiter, cache, h.Plugin.Core.Logger);
        var sources = new ListSourceFetcher(transport, cache, null, limiter, h.Plugin.Core.Logger, null, null);
        Assert.True(ListSourceUrl.TryParse("https://www.themoviedb.org/trending/movie/week", out var source, out _));
        async Task<bool> Read() => reader == "metadata" ? await metadata.FetchAsync(ListsHarness.Movie(1), TimeSpan.Zero, DateTime.UtcNow, default) != null
            : reader == "je-metadata" ? await je.FetchAsync(ListsHarness.Movie(1), TimeSpan.Zero, DateTime.UtcNow, default) != null
            : reader.Contains("import", StringComparison.Ordinal) ? (await lookup.SearchAsync("Movie", new ImportCallContext("test", false), default)).Status == LookupStatus.Ok
            : reader is "find" or "je-find" ? (await lookup.FindImdbEpisodeAsync("tt0959621", new ImportCallContext("test", false), default)).Status == LookupStatus.Ok
            : reader == "poster-string" ? await metadata.FetchTmdbPosterAsync(ListsHarness.Movie(1), default) != null
            : reader == "poster" ? (await metadata.ReadTmdbPosterAsync(ListsHarness.Movie(1), default)).Answered
            : (await sources.FetchAsync(source!, new SourceFetchOptions { Provider = reader == "je-source" ? "tmdb" : "seerr" }, default)).Ok;
        var work = Read();
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        lock (Jellyfin.Plugin.JellyfinEnhanced.JellyfinEnhanced.ConfigurationLock)
        {
            release.SetResult();
            // The response can finish its transport, but cannot cross publication while this commit owns the boundary.
            _ = work.Wait(TimeSpan.FromMilliseconds(250));
            c.ArrRequestBackend = c.ArrRequestBackend == "je" ? "seerr" : "je";
            h.Plugin.Plugin.SaveConfiguration(c);
        }
        Assert.False(await work.WaitAsync(TimeSpan.FromSeconds(5)));
    }

    [Theory]
    [InlineData("metadata")]
    [InlineData("je-metadata")]
    [InlineData("import")]
    [InlineData("je-import")]
    [InlineData("source")]
    [InlineData("poster")]
    [InlineData("poster-string")]
    [InlineData("find")]
    [InlineData("je-find")]
    [InlineData("je-source")]
    public async Task WarmCacheCannotPublishWhileConfigurationCommitOwnsTheBoundary(string reader)
    {
        using var h = new ListsHarness(seerr: true);
        var c = h.Plugin.Plugin.Configuration;
        ImportTestFlags.AllOn(c); c.ArrRequestBackend = reader.StartsWith("je-", StringComparison.Ordinal) ? "je" : "seerr"; c.TMDB_API_KEY = "test";
        using var transport = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response(
            reader == "metadata" ? "{\"id\":1,\"releaseDate\":\"2020-01-01\",\"posterPath\":null,\"imdbId\":null}"
            : reader == "je-metadata" ? "{\"id\":1,\"release_date\":\"2020-01-01\",\"poster_path\":null,\"external_ids\":{\"imdb_id\":null}}"
            : reader is "poster" or "poster-string" ? "{\"id\":1,\"poster_path\":\"/server.jpg\"}"
                : reader is "find" or "je-find" ? "{\"tv_episode_results\":[{\"show_id\":1396,\"season_number\":1,\"episode_number\":1,\"name\":\"Pilot\",\"air_date\":\"2008-01-20\"}]}"
            : reader is "je-import" or "je-source" ? "{\"page\":1,\"total_pages\":1,\"total_results\":1,\"results\":[{\"id\":1,\"media_type\":\"movie\",\"title\":\"Movie\"}]}"
            : "{\"page\":1,\"totalPages\":1,\"totalResults\":1,\"results\":[{\"id\":1,\"mediaType\":\"movie\",\"title\":\"Movie\"}]}")));
        using var cache = new TmdbResponseCache(transport, TimeProvider.System);
        var limiter = new MetadataCallLimiter(4, TimeSpan.Zero, TimeProvider.System);
        var metadata = new ListMetadataService(transport, h.Plugin.Core.Logger);
        var je = new TmdbListMetadataSource(cache, h.Plugin.Core.Logger);
        IImportLookup lookup = reader.StartsWith("je-", StringComparison.Ordinal) ? new TmdbImportLookup(cache, limiter, h.Plugin.Core.Logger) : new SeerrImportLookup(transport, limiter, cache, h.Plugin.Core.Logger);
        var sources = new ListSourceFetcher(transport, cache, null, limiter, h.Plugin.Core.Logger, null, null);
        Assert.True(ListSourceUrl.TryParse("https://www.themoviedb.org/trending/movie/week", out var source, out _));
        async Task<bool> Read() => reader == "metadata" ? await metadata.FetchAsync(ListsHarness.Movie(1), TimeSpan.FromHours(12), DateTime.UtcNow, default) != null
            : reader == "je-metadata" ? await je.FetchAsync(ListsHarness.Movie(1), TimeSpan.FromHours(12), DateTime.UtcNow, default) != null
            : reader.Contains("import", StringComparison.Ordinal) ? (await lookup.SearchAsync("Movie", new ImportCallContext("test", false), default)).Status == LookupStatus.Ok
            : reader is "find" or "je-find" ? (await lookup.FindImdbEpisodeAsync("tt0959621", new ImportCallContext("test", false), default)).Status == LookupStatus.Ok
            : reader == "poster-string" ? await metadata.FetchTmdbPosterAsync(ListsHarness.Movie(1), default) != null
            : reader == "poster" ? (await metadata.ReadTmdbPosterAsync(ListsHarness.Movie(1), default)).Answered
            : (await sources.FetchAsync(source!, new SourceFetchOptions { Provider = reader == "je-source" ? "tmdb" : "seerr" }, default)).Ok;
        Assert.True(await Read());
        var calls = transport.Calls;
        using var started = new ManualResetEventSlim();
        Task<bool> work;
        bool escaped;
        lock (Jellyfin.Plugin.JellyfinEnhanced.JellyfinEnhanced.ConfigurationLock)
        {
            work = Task.Run(async () => { started.Set(); return await Read(); });
            Assert.True(started.Wait(TimeSpan.FromSeconds(5)));
            escaped = work.Wait(TimeSpan.FromMilliseconds(250));
        }
        Assert.True(await work.WaitAsync(TimeSpan.FromSeconds(5)));
        Assert.False(escaped);
        Assert.Equal(calls, transport.Calls);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ComposedResponseCannotPublishInsideAConfigurationCommit(bool preview)
    {
        using var h = new ImportHarness();
        h.Plugin.Plugin.Configuration.ArrRequestBackend = "seerr";
        var caller = h.NewUser("owner");
        h.Lookup.AddSearch("Movie", FakeImportLookup.Movie(1, "Movie", "2020-01-01"));
        using var entered = new ManualResetEventSlim();
        using var release = new ManualResetEventSlim();
        var viewer = new Mock<IImportViewerPolicy>();
        viewer.Setup(v => v.For(It.IsAny<User>())).Returns(() =>
        {
            entered.Set(); Assert.True(release.Wait(TimeSpan.FromSeconds(5))); return ImportViewer.None;
        });
        var work = Task.Run(async () =>
        {
            if (preview)
            {
                h.Fetcher.Provider = "seerr";
                var result = await new ListSourcePreview(h.Fetcher, h.ImportResolver, h.Access, h.Plugin.Core.Logger, viewer.Object)
                    .FetchAsync(caller, "https://www.themoviedb.org/trending/movie/week", default);
                return result.StatusCode == 200;
            }
            var outcome = await new ListImportResolver(h.Lookup, h.Library, h.Access, h.Limiter, h.Plugin.Core.Logger, viewer.Object)
                .ResolveAsync(new[] { new ImportEntryDto { Title = "Movie" } }, new ImportResolveOptions { Caller = caller, LibraryUsers = new[] { caller }, Context = new ImportCallContext("test", false) }, default);
            return outcome.Response.Complete;
        });
        Assert.True(entered.Wait(TimeSpan.FromSeconds(5)));
        lock (Jellyfin.Plugin.JellyfinEnhanced.JellyfinEnhanced.ConfigurationLock)
        {
            release.Set(); _ = work.Wait(TimeSpan.FromMilliseconds(250));
            h.Plugin.Plugin.Configuration.ArrRequestBackend = "je";
            h.Plugin.Plugin.SaveConfiguration(h.Plugin.Plugin.Configuration);
        }
        Assert.False(await work.WaitAsync(TimeSpan.FromSeconds(5)));
    }


    [Theory]
    [InlineData("swap")]
    [InlineData("add")]
    [InlineData("link")]
    public async Task LockedListConsumerCannotCommitBufferedFactsDuringBackendTransition(string consumer)
    {
        using var h = new ListsHarness(seerr: true);
        var c = h.Plugin.Plugin.Configuration; c.ArrRequestBackend = "seerr";
        var owner = h.NewUser("owner");
        var access = h.AccessFor(h.Host.AddPlaylist(owner), owner);
        var p = ListsHarness.Movie(1);
        h.MovieDetails[1] = "{\"id\":1,\"title\":\"Movie\",\"releaseDate\":\"2020-01-01\",\"posterPath\":\"/server.jpg\",\"overview\":\"Movie\",\"externalIds\":{\"imdbId\":null}}";
        var facts = await h.Metadata.FetchAsync(p, TimeSpan.Zero, DateTime.UtcNow, default);
        Assert.NotNull(facts);
        var buffered = new BufferedMetadata(facts);
        var custom = ListsHarness.Ph("{\"kind\":\"custom\",\"title\":\"Custom\"}");
        var doc = h.Store.LoadForUpdate(access.ListIdN, ListKinds.Playlist);
        if (consumer != "add")
        {
            var stored = consumer == "swap" ? p : custom;
            doc.Items.Add(stored); doc.Order.Add(ListsHarness.P(stored.Id));
        }
        h.Store.Save(doc);
        using var swap = new ListSwapService(h.Store, h.Host, h.Users.Object, h.Resolver, buffered, h.Plugin.Core.Logger);
        var held = await h.Store.LockAsync(access.ListIdN);
        Task work;
        Task<ListOutcome>? mutation = null;
        try
        {
            if (consumer == "swap")
            {
                work = swap.RunListPassAsync(access.ListIdN, null, MetadataMode.New, default);
                await buffered.Read.Task.WaitAsync(TimeSpan.FromSeconds(5));
            }
            else
            {
                mutation = consumer == "add" ? h.Service.AddPlaceholdersAsync(access, new[] { p }, null, null, null, default)
                    : h.Service.PatchAsync(access, custom.Id, doc.Rev, null, p, null, default);
                work = mutation;
            }
            Assert.False(work.IsCompleted);
            lock (Jellyfin.Plugin.JellyfinEnhanced.JellyfinEnhanced.ConfigurationLock)
            {
                held.Dispose();
                _ = work.Wait(TimeSpan.FromMilliseconds(250));
                c.ArrRequestBackend = "je";
                h.Plugin.Plugin.SaveConfiguration(c);
            }
            await work.WaitAsync(TimeSpan.FromSeconds(5));
            if (mutation != null) Assert.Equal(409, (await mutation).StatusCode);
            var saved = h.Store.Load(access.ListIdN)!;
            if (consumer == "add") Assert.Empty(saved.Items);
            else if (consumer == "link") Assert.Equal(PlaceholderKinds.Custom, Assert.Single(saved.Items).Kind);
            else Assert.Null(Assert.Single(saved.Items).ReleaseDate);
        }
        finally { held.Dispose(); }
    }

#pragma warning restore xUnit1031

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task CoherentSpecialsAndFutureEpisodesKeepTheirScope(bool specials)
    {
        using var h = new ListsHarness();
        h.Plugin.Plugin.Configuration.ArrRequestBackend = "je";
        h.Plugin.Plugin.Configuration.TMDB_API_KEY = "test";
        var show = Show.Replace("\"episode_count\":8", "\"episode_count\":2", StringComparison.Ordinal);
        var season = Season;
        if (specials)
        {
            show = show.Replace("\"season_number\":1", "\"season_number\":0", StringComparison.Ordinal);
            season = season.Replace("\"season_number\":1", "\"season_number\":0", StringComparison.Ordinal);
        }
        else
        {
            show = show.Replace("\"episode_number\":2", "\"episode_number\":1", StringComparison.Ordinal).Replace("2011-04-24", "2011-04-17", StringComparison.Ordinal)
                .Replace("\"next_episode_to_air\":null", "\"next_episode_to_air\":{\"season_number\":1,\"episode_number\":2,\"air_date\":\"2099-01-01\"}", StringComparison.Ordinal);
            season = season.Replace("2011-04-24", "2099-01-01", StringComparison.Ordinal);
        }
        using var transport = new IntegrationTransport((r, _) => Task.FromResult(IntegrationTransport.Response(
            r.RequestUri!.AbsolutePath.Contains("/season/", StringComparison.Ordinal) ? season : show)));
        using var cache = new TmdbResponseCache(transport, TimeProvider.System);
        var p = ListsHarness.Ph($"{{\"kind\":\"season\",\"tmdbId\":1399,\"seasonNumber\":{(specials ? 0 : 1)},\"title\":\"Show\"}}");
        var facts = await new TmdbListMetadataSource(cache, h.Plugin.Core.Logger).FetchAsync(p, TimeSpan.Zero, DateTime.UtcNow, default);
        Assert.NotNull(facts); Assert.False(facts.Partial); Assert.Equal(2, facts.Expected!.Count);
        ListMetadataService.Apply(p, facts);
        p.Filled.AddRange(new[] { 1, 2 }.Select(e => new FilledEpisode { S = specials ? 0 : 1, E = e, ItemId = Guid.NewGuid().ToString("N") }));
        Assert.Equal(specials, PlaceholderProgress.IsComplete(p, DateTime.UtcNow));
        Assert.Equal(specials ? "2011-04-24" : "2099-01-01", p.Expected[1].AirDate);
    }

    [Fact]
    public async Task LinkingPreservesTheCrossCheckedCompletionAuthority()
    {
        using var h = new ListsHarness();
        h.Plugin.Plugin.Configuration.ArrRequestBackend = "je";
        h.Plugin.Plugin.Configuration.TMDB_API_KEY = "test";
        var show = Show.Replace("\"episode_count\":8", "\"episode_count\":2", StringComparison.Ordinal)
            .Replace("\"episode_number\":2", "\"episode_number\":8", StringComparison.Ordinal);
        using var transport = new IntegrationTransport((r, _) => Task.FromResult(IntegrationTransport.Response(
            r.RequestUri!.AbsolutePath.Contains("/season/", StringComparison.Ordinal) ? Season : show)));
        using var cache = new TmdbResponseCache(transport, TimeProvider.System);
        var p = ListsHarness.Ph("{\"kind\":\"season\",\"tmdbId\":1399,\"seasonNumber\":1,\"title\":\"Show\"}");
        p.Expected = new[] { 1, 2 }.Select(e => new PlaceholderEpisode { S = 1, E = e, AirDate = "2011-04-24" }).ToList();
        p.InProduction = false;
        var facts = await new TmdbListMetadataSource(cache, h.Plugin.Core.Logger).FetchAsync(p, TimeSpan.Zero, DateTime.UtcNow, default);
        Assert.NotNull(facts);
        ListMetadataService.Apply(p, facts);
        var owner = h.NewUser("owner");
        var access = h.AccessFor(h.Host.AddPlaylist(owner), owner);
        var custom = ListsHarness.Ph("{\"kind\":\"custom\",\"title\":\"Custom\"}");
        var doc = h.Store.LoadForUpdate(access.ListIdN, ListKinds.Playlist);
        doc.Items.Add(custom); doc.Order.Add(ListsHarness.P(custom.Id)); h.Store.Save(doc);
        var result = await h.Service.PatchAsync(access, custom.Id, doc.Rev, null, p, null, default);
        Assert.Equal(200, result.StatusCode);
        var linked = Assert.Single(h.Store.LoadForUpdate(access.ListIdN, ListKinds.Playlist).Items);
        linked.Filled.AddRange(new[] { 1, 2 }.Select(e => new FilledEpisode { S = 1, E = e, ItemId = Guid.NewGuid().ToString("N") }));
        Assert.False(PlaceholderProgress.IsComplete(linked, DateTime.UtcNow));
    }

    [Fact]
    public async Task ConfigurationCommitCannotInterleaveAfterTheListEffectAdmissionCheck()
    {
        using var h = new ListsHarness(seerr: true);
        var c = h.Plugin.Plugin.Configuration; c.ArrRequestBackend = "seerr";
        var p = ListsHarness.Movie(1);
        using var execution = new ListContinuation(h.Store, () => null);
        using var release = new ManualResetEventSlim();
        var effectEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var commitAttempted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var backendChanged = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var effect = Task.Run(() => ListContinuation.Write(() =>
        {
            // The production boundary has passed its FINAL admission check; its actual synchronous effect is paused.
            effectEntered.SetResult();
            Assert.True(release.Wait(TimeSpan.FromSeconds(5)));
            p.ReleaseDate = "2020-01-01";
            return true;
        }));
        await effectEntered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var commit = Task.Run(() =>
        {
            commitAttempted.SetResult();
            lock (Jellyfin.Plugin.JellyfinEnhanced.JellyfinEnhanced.ConfigurationLock)
            {
                c.ArrRequestBackend = "je";
                backendChanged.SetResult();
                h.Plugin.Plugin.SaveConfiguration(c);
            }
        });
        await commitAttempted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        bool committedBeforeEffect;
        try { committedBeforeEffect = await Task.WhenAny(backendChanged.Task, Task.Delay(250)) == backendChanged.Task; }
        finally { release.Set(); }
        Assert.True(await effect.WaitAsync(TimeSpan.FromSeconds(5)));
        await commit.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.False(committedBeforeEffect);
        Assert.Equal("2020-01-01", p.ReleaseDate);
        Assert.Equal("je", c.ArrRequestBackend);
    }

}
