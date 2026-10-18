using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Import;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Sources;
using Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using Microsoft.Extensions.DependencyInjection;
using Moq;
using static JE.Tests.FakeImportLookup;

namespace JE.Tests;

// Track 4c2a review round 1: the physical-title projection (4C2-SEC-02: a title, season or episode the library holds but
// the caller can't open is never offered as absent, in candidates, alternatives, source entries and keys; the same answer
// with Seerr on or off and across account switches; a library that can't be read hides) and the source transport
// (4C2-SEC-04: provider hosts are connected to only at checked public addresses; a configured proxy keeps working).
[Collection("Plugin singleton")]
public class ListsImportPhysicalAndTransportTests
{
    private static readonly CancellationToken None = CancellationToken.None;

    private static ImportEntryDto E(string title, int? year = null, string? type = null, int? season = null, params (int S, int E)[] episodes) => new()
    {
        Title = title,
        Year = year,
        TypeHint = type,
        Season = season,
        Episodes = episodes.Length == 0 ? null : episodes.Select(e => new ImportEpisodeDto { S = e.S, E = e.E }).ToList(),
    };

    private static async Task<ResolveResponse> Resolve(ImportHarness h, User user, params ImportEntryDto[] entries) =>
        (await h.ImportResolver.ResolveAsync(entries, new ImportResolveOptions
        {
            Caller = user,
            LibraryUsers = new[] { user },
            Context = new ImportCallContext(user.Id.ToString("N"), false),
            EmptyRetryDelay = TimeSpan.FromMilliseconds(1),
        }, None)).Response;

    // ── SEC-02: resolve ─────────────────────────────────────────────────

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ATitleHeldOnlyInALibraryTheViewerCantOpenIsNeverACandidateWithSeerrOnOrOffAndAcrossSwitches(bool seerr)
    {
        using var h = new ImportHarness(seerr: seerr);
        var viewer = h.NewUser("viewer");
        var admin = h.NewUser("admin", admin: true);
        h.Lookup.AddSearch("Man of Steel", Movie(49521, "Man of Steel", "2013-06-12", 16680));
        h.Physical.HideTitle(viewer, movie: true, 49521);

        var forAdmin = await Resolve(h, admin, E("Man of Steel", 2013, "movie"));
        var forViewer = await Resolve(h, viewer, E("Man of Steel", 2013, "movie"));
        var adminAgain = await Resolve(h, admin, E("Man of Steel", 2013, "movie"));

        Assert.Equal(49521, forAdmin.Results[0].Match!.TmdbId);
        Assert.Null(forViewer.Results[0].Match);
        Assert.Empty(forViewer.Results[0].Candidates);
        Assert.Equal(ImportScoring.Levels.None, forViewer.Results[0].Confidence);
        Assert.Contains("noMatch", forViewer.Results[0].Reasons);
        Assert.DoesNotContain("49521", JsonSerializer.Serialize(forViewer), StringComparison.Ordinal);
        Assert.Equal(49521, adminAgain.Results[0].Match!.TmdbId); // the viewer's projection stuck to nothing shared
    }

    [Fact]
    public async Task AHiddenAlternativeIsLeftOutAndTheOtherStays()
    {
        using var h = new ImportHarness();
        var viewer = h.NewUser("viewer");
        h.Lookup.AddSearch("Deadpool", Movie(293660, "Deadpool", "2016-02-09", 30000));
        h.Lookup.AddSearch("Deadpool: No Good Deed", Movie(558144, "Deadpool: No Good Deed", "2017-03-03", 200));
        h.Physical.HideTitle(viewer, movie: true, 293660);
        var line = E("Deadpool or Deadpool: No Good Deed", 2016, "movie");
        line.Alternatives = new List<ImportAlternativeDto> { new() { Title = "Deadpool", Year = 2016 }, new() { Title = "Deadpool: No Good Deed", Year = 2017 } };

        var response = await Resolve(h, viewer, line);

        Assert.Equal(new[] { 558144 }, response.Results[0].Candidates.Select(c => c.TmdbId).Distinct());
        Assert.DoesNotContain("293660", JsonSerializer.Serialize(response), StringComparison.Ordinal);
    }

    [Fact]
    public async Task HiddenSeasonsAndEpisodesAreNeverOfferedAsAbsent()
    {
        using var h = new ImportHarness();
        var viewer = h.NewUser("viewer");
        var other = h.NewUser("other");
        var arrow = Tv(1412, "Arrow", "2012-10-10", 5000);
        h.Lookup.AddSearch("Arrow", arrow);
        h.Lookup.AddShow(arrow, new SeasonFacts(1, 23, "2012-10-10", "Season 1"), new SeasonFacts(2, 23, "2013-10-09", "Season 2"));
        h.Lookup.Seasons[(1412, 1)] = Enumerable.Range(1, 23).Select(e => new EpisodeFacts(1, e, "Ep " + e, "2012-11-01")).ToList();
        h.Physical.HideSeason(viewer, 1412, 2);
        h.Physical.HideEpisode(viewer, 1412, 1, 5);
        var lines = new[] { E("Arrow", null, "tv", season: 2), E("Arrow", null, "tv", season: 1), E("Arrow", null, "tv", 1, (1, 5)), E("Arrow", null, "tv", 1, (1, 4)) };

        var forViewer = await Resolve(h, viewer, lines);
        var forOther = await Resolve(h, other, lines);

        Assert.Equal(new[] { false, true, false, true }, forViewer.Results.Select(r => r.Candidates.Any(c => c.TmdbId == 1412)));
        Assert.All(forOther.Results, r => Assert.Equal(1412, r.Match!.TmdbId));
    }

    [Fact]
    public async Task ALibraryThatCantBeReadHidesEveryCandidate()
    {
        using var h = new ImportHarness();
        var viewer = h.NewUser("viewer");
        h.Lookup.AddSearch("Man of Steel", Movie(49521, "Man of Steel", "2013-06-12", 16680));
        h.Physical.Unreadable = true;

        var response = await Resolve(h, viewer, E("Man of Steel", 2013, "movie"));

        Assert.Empty(response.Results[0].Candidates);
    }

    // ── SEC-02: source entries ──────────────────────────────────────────

    [Fact]
    public async Task AFetchedListLeavesOutTitlesTheViewerCantOpenWithTheirKeysAndCounts()
    {
        using var h = new ImportHarness();
        var viewer = h.NewUser("viewer");
        var admin = h.NewUser("admin", admin: true);
        h.Physical.HideTitle(viewer, movie: true, 1);
        h.Fetcher.Items = new List<SourceItem> { new("movie", 1, null, null, "One", 2001, null, null, null), new("movie", 2, null, null, "Two", 2002, null, null, null) };

        var forViewer = ImportHarness.Ok<SourceFetchResponse>(await h.Sources.FetchAsync(viewer, "https://mdblist.com/lists/a/b", None));
        var forAdmin = ImportHarness.Ok<SourceFetchResponse>(await h.Sources.FetchAsync(admin, "https://mdblist.com/lists/a/b", None));

        Assert.Equal(new[] { 2 }, forViewer.Entries.Select(e => e.Ids!.Tmdb!.Value));
        Assert.True(forViewer.CountsHidden);
        Assert.Equal((0, 0, (SourceSnapshotDto?)null), (forViewer.Total, forViewer.Dropped, forViewer.Snapshot));
        Assert.DoesNotContain("movie|1||", JsonSerializer.Serialize(forViewer), StringComparison.Ordinal);
        Assert.Equal(new[] { 1, 2 }, forAdmin.Entries.Select(e => e.Ids!.Tmdb!.Value));
        Assert.Equal("complete", forAdmin.Snapshot!.State);
    }

    [Fact]
    public async Task AWatchOrderNeverStandsForAnEpisodeTheViewerCantOpen()
    {
        using var h = new ImportHarness();
        var viewer = h.NewUser("viewer");
        h.Fetcher.Exact = true;
        h.Fetcher.Provider = "chronolists";
        SourceItem Ep(int e) => new("tv", 1412, "tt2193021", 257655, "Arrow", 2012, 1, e, null) { Details = new SourceItemDetails("E" + e, "2012-10-1" + e, "/a.jpg", null, "Season 1") };
        h.Lookup.AddShow(Tv(1412, "Arrow", "2012-10-10"), new SeasonFacts(1, 3, "2012-10-10", "Season 1"));
        h.Fetcher.Items = new List<SourceItem> { Ep(1), Ep(2), Ep(3) };
        h.Physical.HideEpisode(viewer, 1412, 1, 2);

        var response = ImportHarness.Ok<SourceFetchResponse>(await h.Sources.FetchAsync(viewer, "https://chronolists.com/dctv", None));

        Assert.Equal(new[] { "tv|1412|1|1", "tv|1412|1|3" }, response.SnapshotKeys);
        Assert.DoesNotContain(response.Entries, e => e.Prepared?.Kind == "season"); // a whole season would stand for E2
        Assert.DoesNotContain("tv|1412|1|2", JsonSerializer.Serialize(response), StringComparison.Ordinal);
        Assert.True(response.CountsHidden);
    }

    // ── SEC-02: the production reader (NativeDetailsLibrary; NativeDetailsPolicy on 12) ──

    [Fact]
    public void TheProductionReaderHidesACopyTheViewerCantOpenAndFailsClosed()
    {
        using var plugin = new ApiPluginFixture();
        var viewer = FakeListHost.MakeUser("viewer");
        var admin = FakeListHost.MakeUser("admin", admin: true);
        var copy = new MediaBrowser.Controller.Entities.Movies.Movie { Id = Guid.NewGuid(), Name = "Man of Steel" };
        var library = new Mock<ILibraryManager>();
        library.Setup(l => l.GetItemList(It.Is<InternalItemsQuery>(q => q.User == null && q.IncludeItemTypes.Contains(BaseItemKind.Movie) && q.HasAnyProviderId != null && q.HasAnyProviderId.ContainsKey("Tmdb") && q.HasAnyProviderId["Tmdb"] == "49521")))
            .Returns(new List<BaseItem> { copy });
        library.Setup(l => l.GetItemList(It.Is<InternalItemsQuery>(q => !(q.HasAnyProviderId != null && q.HasAnyProviderId.ContainsKey("Tmdb") && q.HasAnyProviderId["Tmdb"] == "49521")))).Returns(new List<BaseItem>());
        library.Setup(l => l.GetItemById<BaseItem>(copy.Id, viewer)).Returns((BaseItem?)null);
        library.Setup(l => l.GetItemById<BaseItem>(copy.Id, admin)).Returns(copy);
        var reader = Reader(plugin, library.Object);

        Assert.True(reader.Read(viewer, true, 49521, null).Hidden);
        Assert.False(reader.Read(admin, true, 49521, null).Hidden);
        Assert.False(reader.Read(viewer, true, 1, null).Hidden); // no copy anywhere: absent is fine

        var broken = new Mock<ILibraryManager>();
        broken.Setup(l => l.GetItemList(It.IsAny<InternalItemsQuery>())).Throws(new InvalidOperationException("db"));
        Assert.True(Reader(plugin, broken.Object).Read(viewer, true, 49521, null).Hidden);
    }

    private static IImportPhysicalTitles Reader(ApiPluginFixture plugin, ILibraryManager library)
    {
        var physical = new NativeDetailsLibrary(library, null, null);
#if !NET9_0
        var users = new Mock<IUserManager>();
        var parental = new Jellyfin.Plugin.JellyfinEnhanced.Services.SeerrParentalFilter(new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response("{}", 404))),
            users.Object, Mock.Of<MediaBrowser.Model.Globalization.ILocalizationManager>(), Mock.Of<MediaBrowser.Controller.Configuration.IServerConfigurationManager>(), plugin.Core.Logger);
        var policy = new NativeDetailsPolicy(parental, Mock.Of<INativeDetailsSource>(), Mock.Of<Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.IJellyfinLibraryAccess>(), null, null, physical);
        return new LibraryImportPhysicalTitles(policy);
#else
        _ = plugin;
        return new LibraryImportPhysicalTitles(physical, Mock.Of<Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.IArrJellyfinView>());
#endif
    }

    [Fact]
    public void ThePluginRegistersTheProjectionAndTheSourceTransport()
    {
        var registered = new ServiceCollection();
        new Jellyfin.Plugin.JellyfinEnhanced.PluginServiceRegistrator().RegisterServices(registered, Mock.Of<MediaBrowser.Controller.IServerApplicationHost>());
        Assert.Contains(registered, d => d.ServiceType == typeof(IImportPhysicalTitles) && d.Lifetime == ServiceLifetime.Singleton);
        registered.AddLogging();
        using var provider = registered.BuildServiceProvider();
        HttpMessageHandler handler = provider.GetRequiredService<IHttpMessageHandlerFactory>().CreateHandler(SourceHttp.ClientName);
        while (handler is DelegatingHandler delegating)
        {
            handler = delegating.InnerHandler!;
        }

        var primary = Assert.IsType<SocketsHttpHandler>(handler);
        Assert.False(primary.AllowAutoRedirect);
        Assert.False(primary.UseCookies);
        Assert.True(primary.UseProxy); // the system proxy, like every other Jellyfin request
        Assert.NotNull(primary.ConnectCallback);
    }

    // ── SEC-04: the source transport ────────────────────────────────────

    [Theory]
    [InlineData("127.0.0.1")]
    [InlineData("10.1.2.3")]
    [InlineData("172.16.0.1")]
    [InlineData("172.31.255.255")]
    [InlineData("192.168.1.20")]
    [InlineData("169.254.169.254")]
    [InlineData("100.64.0.1")]
    [InlineData("0.0.0.0")]
    [InlineData("224.0.0.1")]
    [InlineData("255.255.255.255")]
    [InlineData("198.18.0.1")]
    [InlineData("192.0.2.1")]
    [InlineData("::1")]
    [InlineData("::")]
    [InlineData("fe80::1")]
    [InlineData("fc00::1")]
    [InlineData("fd12:3456::1")]
    [InlineData("ff02::1")]
    [InlineData("::ffff:127.0.0.1")]
    [InlineData("::ffff:10.0.0.1")]
    [InlineData("64:ff9b::a00:1")]
    [InlineData("2002:c0a8:1::1")]
    [InlineData("2001:db8::1")]
    [InlineData("::127.0.0.1")]
    public void NonPublicAddressesAreRefused(string address) => Assert.False(SourceHttp.IsPublic(IPAddress.Parse(address)));

    [Theory]
    [InlineData("1.1.1.1")]
    [InlineData("8.8.8.8")]
    [InlineData("172.15.0.1")]
    [InlineData("100.63.255.255")]
    [InlineData("2606:4700:4700::1111")]
    [InlineData("::ffff:1.1.1.1")]
    [InlineData("64:ff9b::808:808")]
    public void PublicAddressesAreAllowed(string address) => Assert.True(SourceHttp.IsPublic(IPAddress.Parse(address)));

    private static ValueTask<IPAddress[]> Loopback(string host, CancellationToken ct) => ValueTask.FromResult(new[] { IPAddress.Loopback });

    [Fact]
    public async Task AProviderHostResolvingToTheServersOwnNetworkIsNeverConnectedTo()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        try
        {
            var port = ((IPEndPoint)listener.LocalEndpoint).Port;
            using var handler = SourceHttp.CreateHandler(Loopback, new WebProxy()); // no proxy
            using var client = new HttpClient(handler);
            var error = await Assert.ThrowsAsync<HttpRequestException>(() => client.GetAsync($"http://api.themoviedb.org:{port}/3/list/1"));
            Assert.IsType<SourceAddressBlockedException>(error.InnerException);
            Assert.False(listener.Pending()); // nothing ever connected
        }
        finally
        {
            listener.Stop();
        }
    }

    [Fact]
    public async Task TheFetcherAnswersABlockedAddressWithATypedFailure()
    {
        using var plugin = new ApiPluginFixture();
        ImportTestFlags.AllOn(plugin.Plugin.Configuration);
        using var handler = SourceHttp.CreateHandler(Loopback, new WebProxy());
        var factory = new Mock<IHttpClientFactory>();
        factory.Setup(f => f.CreateClient(SourceHttp.ClientName)).Returns(() => new HttpClient(handler, false));
        var fetcher = new ListSourceFetcher(factory.Object, null, null, new MetadataCallLimiter(4, TimeSpan.Zero, TimeProvider.System), plugin.Core.Logger, null, null);
        Assert.True(ListSourceUrl.TryParse("https://mdblist.com/lists/me/mine", out var source, out _));

        var result = await fetcher.FetchAsync(source!, new SourceFetchOptions { Fresh = true }, None);

        Assert.Equal((false, SourceFailures.AddressBlocked), (result.Ok, result.ErrorCode));
        Assert.Equal(502, SourceOutcomes.FetchFailure(result).StatusCode);
        factory.Verify(f => f.CreateClient(It.Is<string>(n => n != SourceHttp.ClientName)), Times.Never());
    }

    [Fact]
    public async Task AConfiguredProxyOnTheLanKeepsWorkingAndABypassedHostIsCheckedAgain()
    {
        var proxy = new TcpListener(IPAddress.Loopback, 0);
        proxy.Start();
        try
        {
            var port = ((IPEndPoint)proxy.LocalEndpoint).Port;
            var seen = new TaskCompletionSource<string>();
            var serve = Task.Run(async () =>
            {
                using var socket = await proxy.AcceptTcpClientAsync();
                var stream = socket.GetStream();
                var buffer = new byte[4096];
                var read = await stream.ReadAsync(buffer);
                seen.TrySetResult(Encoding.ASCII.GetString(buffer, 0, read));
                var reply = Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n[]");
                await stream.WriteAsync(reply);
            });

            // Never resolved: the proxy (an IP literal on the LAN or loopback) is the administrator's own setting.
            using var handler = SourceHttp.CreateHandler((_, _) => throw new InvalidOperationException("the target is resolved by the proxy"), new WebProxy($"http://127.0.0.1:{port}"));
            using var client = new HttpClient(handler);
            using var response = await client.GetAsync("http://mdblist.com/lists/me/mine/json");
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.StartsWith("GET http://mdblist.com/lists/me/mine/json", await seen.Task, StringComparison.Ordinal);
            await serve;

            // A host the proxy bypasses is connected to directly: checked like any other.
            using var bypassing = SourceHttp.CreateHandler(Loopback, new WebProxy($"http://127.0.0.1:{port}", true, new[] { "mdblist\\.com" }));
            using var direct = new HttpClient(bypassing);
            var error = await Assert.ThrowsAsync<HttpRequestException>(() => direct.GetAsync("http://mdblist.com/lists/me/mine/json"));
            Assert.IsType<SourceAddressBlockedException>(error.InnerException);
        }
        finally
        {
            proxy.Stop();
        }
    }
}
