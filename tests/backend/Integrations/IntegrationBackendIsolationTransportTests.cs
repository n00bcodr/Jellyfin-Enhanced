using System.Reflection;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Jellyseerr;
using Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Backends;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Import;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Sources;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.NativeDetails;
using MediaBrowser.Controller.Library;
using Moq;
using Newtonsoft.Json.Linq;

namespace JE.Tests;

/// <summary>
/// Appendix H's physical Seerr helper dispatches, called directly to bypass their normal public entry
/// guards. The terminal is a trap, including the named list client. Public Seerr actions and tasks have
/// separate entry-gate tests; non-Seerr controls and transition races exercise the real handler chain.
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationBackendIsolationTransportTests
{
    private static async Task Call(object owner, string method, params object?[] args)
    {
        if (owner is SeerrFacts) owner = owner.GetType().GetField(method == "Get" ? "_migration" : "_model", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(owner)!;
        var type = owner as Type ?? owner.GetType();
        var member = type.GetMethod(method, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static)!;
        Assert.NotNull(member);
        try
        {
            var task = Assert.IsAssignableFrom<Task>(member.Invoke(owner is Type ? null : owner, args));
            await task.WaitAsync(TimeSpan.FromSeconds(15));
        }
        catch (TargetInvocationException ex) when (ex.InnerException is BackendDisabledException) { }
        catch (BackendDisabledException) { }
        // The list owner's transport deliberately maps all non-network failures to its typed source refusal.
        catch (Exception ex) when (ex.GetType().Name == "SourceHttpException") { }
    }

    [Fact]
    public async Task PhysicalDispatchHelpersCannotBypassIsolationEvenWhenCalledDirectly()
    {
        using var f = new ApiPluginFixture();
        var c = f.Plugin.Configuration;
        c.ArrBackendIsolationVersion = 1; c.ArrRequestBackend = "je";
        c.JellyseerrEnabled = c.JellyseerrEnable4KRequests = c.ArrRequest4kMoviesEnabled = true;
        c.JellyseerrUrls = "http://seerr.test\nhttp://failover.test"; c.JellyseerrApiKey = "test";
        c.JellyseerrDisableCache = true;
        using var transport = new IntegrationTransport((_, _) => throw new Xunit.Sdk.XunitException("Appendix H dispatch reached the Seerr terminal"));
        using var http = transport.CreateClient("");
        var controller = ApiAssetTests.Controller(f.Core, transport);
        controller.HttpContext.User = TestCallers.Principal(Guid.NewGuid(), true);
        var user = Guid.NewGuid().ToString("N");
        await Call(controller, "GetJellyseerrUserRead", user, false, true);
        await Call(controller, "TryAutoImportJellyseerrUser", user, new[] { "http://seerr.test" }, http);
        await Call(controller, "LegacyCanRequest4kAsync", c, true, JellyseerrPermission.ADMIN);
        await Call(controller, "ProxyJellyseerrRequestCore", "/api/v1/search", HttpMethod.Get, null, null);
        await Call(controller, "ProbeJellyseerrStatusAsync");
        await Call(controller, "ComputeNextResetAsync", JObject.Parse("{\"movie\":{\"limit\":1,\"used\":1,\"days\":7}}"), "movie", "7", c);
        await Call(controller, "GetJellyseerrRequestsForUser", "7");
        await Call(controller, "EnrichWithTmdbData", http, 603, "movie", "http://seerr.test", "test", 0L, DateTime.UtcNow);
        await Call(controller, "IdentifyUrl", "http://seerr.test");
        await Call(controller, "ProxyAvatar", "/avatar.png");
        var users = Mock.Of<IUserManager>(); var library = Mock.Of<ILibraryManager>(); var data = Mock.Of<IUserDataManager>();
        var parts = new object[] { users, library, data, transport, f.Core.Logger, f.Core.Manager };
        var inbound = Wiring.Make<JellyseerrWatchlistSyncTask>(parts);
        await Call(inbound, "GetJellyseerrUserMap", http, "http://seerr.test", "test", CancellationToken.None);
        await Call(inbound, "GetJellyseerrWatchlist", http, "http://seerr.test", "7", "test", CancellationToken.None);
        await Call(inbound, "GetJellyseerrRequests", http, "http://seerr.test", "7", "test", CancellationToken.None);
        var outbound = Wiring.Make<JellyfinToSeerrWatchlistSyncTask>(parts);
        await Call(outbound, "GetJellyseerrUserMap", http, "http://seerr.test", "test");
        await Call(outbound, "GetSeerrWatchlist", http, "http://seerr.test", "7", "test");
        await Call(outbound, "AddToSeerrWatchlist", http, "http://seerr.test", "7", "test", 603, "movie", "Title");
        var movies = new AutoMovieRequestService(transport, f.Core.Logger, users, library);
        await Call(movies, "GetNextMovieInCollectionAsync", 1, "603", false);
        await Call(movies, "GetOriginalMovieQualityProfileAsync", "603");
        await Call(movies, "GetJellyseerrUserId", user);
        await Call(movies, "RequestMovie", "603", user, null);
        var seasons = new AutoSeasonRequestService(transport, f.Core.Logger, users, data, library);
        await Call(seasons, "GetSeriesDetailsJsonAsync", "1437");
        await Call(seasons, "GetSeasonStatusFromJellyseerr", "1437", 1);
        await Call(seasons, "GetJellyseerrUserId", user);
        await Call(seasons, "RequestNextSeason", "1437", 1, user);
        using var scan = new SeerrScanTriggerService(library, transport, f.Core.Logger);
        await Call(scan, "IsRunningAsync", "http://seerr.test", "test", SeerrScanTriggerService.ScanJobId);
        await Call(scan, "PostScanTrigger", "http://seerr.test", "test", SeerrScanTriggerService.ScanJobId);
        using var monitor = new WatchlistMonitor(library, users, data, transport, f.Core.Manager, f.Core.Logger);
        await Call(monitor, "SeerrTitleRequestersAsync", c, 603, "movie");
        await Call(monitor, "GetAllJellyseerrRequests", http, "http://seerr.test", "test");
        using var model = new SeerrFacts(transport, null, null, () => c, () => DateTimeOffset.UtcNow);
        await Call(model, "GetJsonAsync", "http://seerr.test/api/v1/request", "test", CancellationToken.None);
        var backend = new SeerrBackend(transport, model, null, () => c, () => DateTimeOffset.UtcNow);
        await Call(backend, "RawAsync", HttpMethod.Get, "http://seerr.test/api/v1/request", "test", null, null, TimeSpan.FromSeconds(5), CancellationToken.None);
        await Call(backend, "RawAsync", HttpMethod.Post, "http://seerr.test/api/v1/request", "test", 7, "{}", TimeSpan.FromSeconds(5), CancellationToken.None);
        await Call(new SeerrFacts(transport), "Get", http, "http://seerr.test/api/v1/request", "test", CancellationToken.None);
        await Call(typeof(HouseholdRulesService), "SeerrAsync", transport, CancellationToken.None);
        var native = new SeerrNativeDetailsSource(transport, null!, f.Core.Logger);
        await Call(native, "FetchAsync", "/api/v1/movie/603", CancellationToken.None);
        // The A2 provider owns this physical path now; an old captured Seerr source still cannot send in JE.
        using var parentalCache = new TmdbResponseCache(transport, TimeProvider.System);
        var parentalType = typeof(TitleParentalEvidenceProvider).GetNestedType("Seerr", BindingFlags.NonPublic)!;
        var parental = (ITitleParentalEvidence)Activator.CreateInstance(parentalType, transport, parentalCache, string.Empty, "http://seerr.test", "test")!;
        Assert.Null(await parental.ReadAsync("movie", 603, "US", true, CancellationToken.None));
        var metadata = new ListMetadataService(transport, f.Core.Logger);
        await Call(metadata, "FetchFromSeerrAsync", new[] { "http://seerr.test" }, "test", "/api/v1/movie/603", null, "scope", ListMetadataEpoch.Capture(), CancellationToken.None);
        var limiter = new MetadataCallLimiter(1, TimeSpan.Zero, TimeProvider.System);
        var lookup = new SeerrImportLookup(transport, limiter, f.Core.Logger);
        await lookup.SearchAsync("title", new ImportCallContext(user, false), default);
        var source = new ListSourceFetcher(transport, null!, null!, limiter, f.Core.Logger);
        var transmissionType = typeof(ListSourceFetcher).GetNestedType("Transmission", BindingFlags.NonPublic)!;
        var transmission = Activator.CreateInstance(transmissionType, "seerr", "http://seerr.test/api/v1/movie/603")!;
        await Call(source, "SeerrOnceAsync", transmission, CancellationToken.None);
        Assert.Equal(0, transport.Calls);
    }

    [Theory]
    [InlineData(false)][InlineData(true)]
    public async Task StrictJeAutomaticMovieKeepsTheTmdbLedgerBranchEvenWithSeerrRetained(bool submissionOff)
    {
        using var a = new IntegrationAutoRequestLedgerTests.Auto(seerr: true);
        var c = a.F.Plugin.Configuration; c.ArrBackendIsolationVersion = 1;
        c.ArrPhase3Enabled = !submissionOff;
        a.Answer = request => IntegrationAutoRequestLedgerTests.Collection(request);
        var person = a.Person("Member");
        await a.Movies().CheckMovieForCollectionRequestAsync(IntegrationAutoRequestLedgerTests.Watched(), person);
        Assert.DoesNotContain(a.Urls, u => u.Contains("/api/v1/", StringComparison.Ordinal));
        if (!submissionOff) { Assert.NotEmpty(a.Urls); Assert.Single(a.R.Ledger.ForTitle("movie:tmdb:124")); }
        else { Assert.Empty(a.Urls); Assert.Empty(a.R.Ledger.ForTitle("movie:tmdb:124")); }
    }
    [Fact]
    public async Task StrictJeAutomaticSeasonsKeepDirectTmdbWithSeerrRetained()
    {
        using var a = new IntegrationAutoRequestLedgerTests.Auto(seerr: true);
        a.F.Plugin.Configuration.ArrBackendIsolationVersion = 1;
        var show = new MediaBrowser.Controller.Entities.TV.Series { Id = Guid.NewGuid(), ProviderIds = new() { ["Tmdb"] = "42", ["Tvdb"] = "4242" } };
        var episode = new MediaBrowser.Controller.Entities.TV.Episode { Id = Guid.NewGuid(), SeriesId = show.Id, ParentIndexNumber = 1, IndexNumber = 9 };
        var library = new Mock<ILibraryManager>(); library.Setup(l => l.GetItemById(show.Id)).Returns(show);
        a.Answer = request => request.RequestUri!.AbsolutePath == "/3/tv/42"
            ? IntegrationTransport.Response("{\"number_of_seasons\":2,\"seasons\":[{\"season_number\":1,\"episode_count\":10},{\"season_number\":2,\"episode_count\":10}]}") : null;
        var previous = MediaBrowser.Controller.Entities.BaseItem.LibraryManager;
        MediaBrowser.Controller.Entities.BaseItem.LibraryManager = library.Object;
        try
        {
            var service = new AutoSeasonRequestService(a.Transport, a.F.Core.Logger, a.Users.Object, null!, library.Object, a.Recorder);
            await service.CheckEpisodeCompletionAsync(episode, a.Person("Member"));
            Assert.Single(a.R.Ledger.ForTitle("tv:tvdb:4242"));
            Assert.DoesNotContain(a.Urls, u => u.Contains("/api/v1/", StringComparison.Ordinal));
        }
        finally { MediaBrowser.Controller.Entities.BaseItem.LibraryManager = previous; }
    }

    [Fact]
    public async Task LegacyNegativeControlReachesTheSameRealProbeThatStrictJeStops()
    {
        using var f = new ApiPluginFixture();
        var c = f.Plugin.Configuration;
        c.ArrRequestBackend = "je"; c.JellyseerrEnabled = true;
        c.JellyseerrUrls = "http://seerr.test"; c.JellyseerrApiKey = "test";
        using var transport = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response()));
        var controller = ApiAssetTests.Controller(f.Core, transport);
        await Call(controller, "ProbeJellyseerrStatusAsync");
        Assert.True(transport.Calls > 0);
        var baseline = transport.Calls;
        c.ArrBackendIsolationVersion = 1;
        await Call(controller, "ProbeJellyseerrStatusAsync");
        Assert.Equal(baseline, transport.Calls);
    }

}
