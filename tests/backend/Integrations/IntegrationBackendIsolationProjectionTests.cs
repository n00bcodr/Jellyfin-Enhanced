using System.Reflection;
using Jellyfin.Data;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Backends;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Moq;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class IntegrationBackendIsolationProjectionTests
{
    [Theory]
    [InlineData("Admin")][InlineData("Manager")][InlineData("Member")][InlineData("Kid")][InlineData("Watcher")]
    public async Task OwnLedgerProjectionFollowsAliasesAndInterestsWithAllSubmissionFlagsOff(string role)
    {
        using var r = new IntegrationRequestLedgerTests.Rig();
        using var arr = new FakeArr();
        var host = arr.Add("sonarr.test", "Sonarr");
        host.Series.Add(new JsonObject { ["id"] = 1, ["tvdbId"] = 78874, ["tmdbId"] = 1437, ["imdbId"] = "tt0303461", ["title"] = "Firefly" });
        arr.Configure(("TV", ArrKind.Sonarr, "http://sonarr.test", "test"));
        using var store = arr.Store();
        Assert.True((await store.RefreshLibraryNowAsync(arr.Instance("TV"), default)).Ok);
        var aliases = new TitleAliases(store, null);
        var user = r.Add(role == "Watcher" ? "Member" : role);
        var created = await r.Create(user, IntegrationRequestLedgerTests.Seasons(1));
        Assert.Equal(201, created.HttpStatus);
        await r.Create(r.Add("Member"), IntegrationRequestLedgerTests.Movie(604));
        var cancelled = await r.Create(user, IntegrationRequestLedgerTests.Movie(605));
        Assert.Equal(200, r.Service.Close(cancelled.RequestId!, user, null).HttpStatus);
        if (role == "Watcher") r.Policy.People[user] = r.Policy.People[user] with { Role = role, CanCreate = false };
        var config = r.Policy.Configuration;
        config.ArrBackendIsolationVersion = 1; config.ArrRequestBackend = "je";
        config.ArrIntegrationEnabled = config.ArrPhase1Enabled = config.ArrPhase3Enabled = false;
        var projection = new RequestedTitlesProjection(r.Ledger, aliases, r.Policy, r.View);
        var result = projection.ForUser(config, user);
        Assert.True(result.Available); Assert.True(result.Complete);
        var title = Assert.Single(result.Titles);
        Assert.Equal(("tv", 1437, "standard", "seasons"), (title.MediaType, title.TmdbId, title.Variant, title.Scope));
        Assert.Equal(new[] { 1 }, title.Seasons);
        Assert.Empty(projection.ForUser(config, r.Add("Watcher")).Titles);
        Assert.False(projection.ForUser(config, Guid.NewGuid()).Available);
        Assert.Contains(TitleKey.Parse("tv:imdb:tt0303461")!, aliases.Of(TitleKey.Parse("tv:tvdb:78874")!));
    }

    [Fact]
    public async Task ProjectionDistinguishesUnresolvedAliasDatabaseFailureEmptyAndVisibilityRevocation()
    {
        using var r = new IntegrationRequestLedgerTests.Rig();
        using var arr = new FakeArr();
        using var store = arr.Store();
        var c = r.Policy.Configuration; c.ArrBackendIsolationVersion = 1;
        var projection = new RequestedTitlesProjection(r.Ledger, new TitleAliases(store, null), r.Policy, r.View);
        Assert.True(projection.ForUser(c, r.Member).Complete);
        Assert.Empty(projection.ForUser(c, r.Member).Titles);
        await r.Create();
        Assert.Single(projection.ForUser(c, r.Member).Titles);
        r.Policy.People[r.Member] = r.Policy.People[r.Member] with { Visible = false };
        Assert.Empty(projection.ForUser(c, r.Member).Titles);
        r.Policy.People[r.Member] = r.Policy.People[r.Member] with { Visible = true };
        await r.Create(input: IntegrationRequestLedgerTests.Seasons(1));
        var unresolved = projection.ForUser(c, r.Member);
        Assert.True(unresolved.Available); Assert.False(unresolved.Complete); Assert.Single(unresolved.Titles);
        var invalidPath = Path.Combine(r.Root, "database-is-a-directory");
        Directory.CreateDirectory(invalidPath);
        using var unavailable = new AcquireDatabase(invalidPath);
        var failed = new RequestedTitlesProjection(new RequestLedger(unavailable), new TitleAliases(store, null), r.Policy, r.View);
        Assert.False(failed.ForUser(c, r.Member).Available);
    }

    [Fact]
    public async Task ReadRouteUsesOnlyTheAuthenticatedPersonAndReturnsUnavailableRatherThanEmptySuccess()
    {
        using var r = new IntegrationRequestLedgerTests.Rig();
        using var arr = new FakeArr();
        using var store = arr.Store();
        var c = arr.Plugin.Plugin.Configuration;
        c.ArrBackendIsolationVersion = 1; c.ArrRequestBackend = "je";
        await r.Create();
        var projection = new RequestedTitlesProjection(r.Ledger, new TitleAliases(store, null), r.Policy, r.View);
        var controller = new RequestsBackendController(projection, r.View) { ControllerContext = new() { HttpContext = new DefaultHttpContext() } };
        controller.HttpContext.User = TestCallers.Principal(r.Member, false);
        var result = Assert.IsType<RequestedTitlesResult>(Assert.IsType<OkObjectResult>(await controller.RequestedTitles()).Value);
        Assert.Single(result.Titles);
        Assert.Equal("private, no-store", controller.Response.Headers.CacheControl);
        controller.HttpContext.User = TestCallers.Principal(r.Manager, false);
        Assert.Empty(Assert.IsType<RequestedTitlesResult>(Assert.IsType<OkObjectResult>(await controller.RequestedTitles()).Value).Titles);
        c.ArrBackendIsolationVersion = 2;
        Assert.Equal(503, Assert.IsType<ObjectResult>(await controller.RequestedTitles()).StatusCode);
        controller.HttpContext.User = TestCallers.Principal(Guid.NewGuid(), false);
        Assert.Equal(403, Assert.IsType<ObjectResult>(await controller.RequestedTitles()).StatusCode);
    }

    [Theory]
    [InlineData(false)][InlineData(true)]
    public async Task BothDownloadsOwnershipAndLazyAskedProofUseLocalProjection(bool filter)
    {
        using var r = new IntegrationRequestLedgerTests.Rig();
        using var arr = new FakeArr();
        using var store = arr.Store();
        var c = arr.Plugin.Plugin.Configuration;
        c.ArrRequestBackend = "je"; c.ArrBackendIsolationVersion = 1; c.DownloadsFilterByUserRequests = filter;
        c.JellyseerrEnabled = true; c.JellyseerrUrls = "http://seerr.test"; c.JellyseerrApiKey = "test";
        await r.Create();
        var projection = new RequestedTitlesProjection(r.Ledger, new TitleAliases(store, null), r.Policy, r.View);
        using var trap = new IntegrationTransport((_, _) => throw new Xunit.Sdk.XunitException("Ownership contacted Seerr"));
        var controller = ApiAssetTests.Controller(arr.Plugin.Core, trap, projection);
        controller.HttpContext.User = TestCallers.Principal(r.Member, false);
        if (filter)
        {
            var method = typeof(JellyfinEnhancedController).GetMethod("GetAllowedRequestsForCurrentUserAsync", BindingFlags.NonPublic | BindingFlags.Instance)!;
            var result = await (Task<(bool Blocked, HashSet<(int, string)>? Allowed)>)method.Invoke(controller, new object[] { c })!;
            Assert.False(result.Blocked); Assert.Contains((603, "movie"), result.Allowed!);
        }
        else
        {
            var method = typeof(JellyfinEnhancedController).GetMethod("GetAskedProofAsync", BindingFlags.NonPublic | BindingFlags.Instance)!;
            var result = await (Task<IReadOnlySet<(int, string)>?>)method.Invoke(controller, new object[] { c, new User("viewer", "default", "default") { Id = r.Member } })!;
            Assert.Contains((603, "movie"), result!);
        }
        Assert.Equal(0, trap.Calls);
    }

    [Theory]
    [InlineData(false)][InlineData(true)]
    public async Task OutboxDoesNotDispatchOrReadBackOldSeerrJobsAndKeepsUncertainty(bool uncertain)
    {
        using var r = new IntegrationRequestLedgerTests.Rig();
        r.Policy.Configuration.ArrRequestBackend = "seerr";
        r.Policy.Adjust = (_, _, facts) => facts with { SeerrSource = "source", SeerrUser = 7, BackendQuota = new QuotaProjection(0, null, null, null, 0) };
        var created = await r.Create();
        if (uncertain)
        {
            r.Backend.Unknown = true;
            await r.Runner().TickAsync(default);
            r.Now += TimeSpan.FromMinutes(10);
        }
        var sends = r.Backend.Sends; var reads = r.Backend.Reads;
        r.Policy.Configuration.ArrBackendIsolationVersion = 1;
        r.Policy.Configuration.ArrRequestBackend = "je";
        await r.Runner().TickAsync(default);
        Assert.Equal(sends, r.Backend.Sends); Assert.Equal(reads, r.Backend.Reads);
        var job = Assert.Single(r.Ledger.ForWant(created.RequestId!));
        Assert.Equal("backend_disabled", job.Reason);
        if (uncertain) { Assert.True(job.Uncertain); Assert.NotEqual("succeeded", job.State); }
        else Assert.Equal("parked", job.State);
    }
    [Fact]
    public async Task ProjectionRetainsProductionLibraryAndEpisodeScopeChecksWithRequestsOff()
    {
        using var r = new IntegrationRequestLedgerTests.Rig();
        using var lab = new IntegrationRequestBackendsTests.Lab();
        var c = lab.Config; c.ArrBackendIsolationVersion = 1;
        var key = TitleKey.Parse("tv:tmdb:1437")!;
        var input = new MutationInput { Key = key.ToString(), Scope = "episodes", Episodes = new[] { new RequestEpisode(1, 2) } };
        await r.Create(input: input);
        var viewer = r.View.Users[r.Member];
        r.View.Users[r.Member] = new StatusViewer { UserId = r.Member, Handle = viewer.Handle, HasParentalLimit = true };
        var series = Guid.NewGuid();
        r.View.AddCopy(key, new JfCopy { ItemId = series, Visible = true });
        r.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 2 });
        var aliases = new TitleAliases(lab.Store, null);
        var policy = new RequestPolicy(r.View, lab.Store, new ArrInstanceLibraries(lab.Store, new FakeLibraryAccess()), aliases, null!, lab.Arr.Factory, new UnavailableRequestBackend());
        var projection = new RequestedTitlesProjection(r.Ledger, aliases, policy, r.View);
        c.ArrIntegrationEnabled = c.ArrPhase1Enabled = c.ArrPhase3Enabled = false;
        Assert.Single(projection.ForUser(c, r.Member).Titles);
        r.View.EpisodesBySeries[series].Clear();
        r.View.AddEpisode(series, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 2, Hidden = true });
        Assert.Empty(projection.ForUser(c, r.Member).Titles);
        r.View.EpisodesBySeries[series].Clear();
        ((User)viewer.Handle!).SetPermission(Jellyfin.Database.Implementations.Enums.PermissionKind.EnableAllFolders, false);
        Assert.Empty(projection.ForUser(c, r.Member).Titles);
    }

    [Theory]
    [InlineData("seerr", 1)][InlineData("je", 2)]
    public async Task IsolatedOppositeOrUnsupportedBackendHoldsJeRequestWrites(string backend, int version)
    {
        using var r = new IntegrationRequestLedgerTests.Rig();
        await r.Create();
        r.Policy.Configuration.ArrRequestBackend = backend;
        r.Policy.Configuration.ArrBackendIsolationVersion = version;
        await r.Runner().TickAsync(default);
        Assert.Equal(0, r.Backend.Sends);
        var job = Assert.Single(r.Ledger.ForWant(Assert.Single(r.Ledger.List(r.Member, false)).Id));
        Assert.Equal("backend_disabled", job.Reason);
    }

    [Fact]
    public async Task FinalRequestGuardRechecksUnsupportedIsolationAfterPreparation()
    {
        using var r = new IntegrationRequestLedgerTests.Rig();
        await r.Create();
        r.Backend.Gate = () => { r.Policy.Configuration.ArrBackendIsolationVersion = 2; return Task.CompletedTask; };
        await r.Runner().TickAsync(default);
        Assert.Equal(0, r.Backend.Sends);
        Assert.Equal("backend_disabled", Assert.Single(r.Ledger.ForWant(Assert.Single(r.Ledger.List(r.Member, false)).Id)).Reason);
    }

    [Fact]
    public async Task FrozenDestinationSurvivesDefaultChangeAndLibraryRevocation()
    {
        using var r = new IntegrationRequestLedgerTests.Rig();
        using var lab = new IntegrationRequestBackendsTests.Lab();
        var access = new FakeLibraryAccess();
        var original = access.AddLibrary("Original", "movies", "/data/movies");
        var next = access.AddLibrary("Next", "movies", "/data/next");
        lab.Edit("Radarr 4K", row => { row["Role"] = "standard"; row["Defaults"] = IntegrationRequestBackendsTests.Lab.Defaults(4, "/data/next"); });
        lab.Edit("Radarr", row => { row["IsDefault"] = true; row["LinkedLibraryIds"] = new JsonArray(original.Id); });
        lab.Edit("Radarr 4K", row => row["LinkedLibraryIds"] = new JsonArray(next.Id));
        var aliases = new TitleAliases(lab.Store, null);
        var policy = new RequestPolicy(r.View, lab.Store, new ArrInstanceLibraries(lab.Store, access), aliases, null!, lab.Arr.Factory, new UnavailableRequestBackend());
        r.Policy.People[r.Member] = r.Policy.People[r.Member] with { InstanceId = lab.Instance("Radarr").Id };
        await r.Create();
        var want = Assert.Single(r.Ledger.List(r.Member, false));
        Assert.Null(want.Input.InstanceId);
        lab.Edit("Radarr", row => row["IsDefault"] = false);
        lab.Edit("Radarr 4K", row => row["IsDefault"] = true);
        lab.Config.ArrBackendIsolationVersion = 1;
        var user = (User)r.View.Users[r.Member].Handle!;
        user.SetPreference(Jellyfin.Database.Implementations.Enums.PreferenceKind.BlockedMediaFolders, new[] { original.Id });
        Assert.True(policy.Evaluate(r.Member, want.Input).Visible);
        Assert.False(policy.Evaluate(r.Member, want.Input, want.TargetKey).Visible);
        var projection = new RequestedTitlesProjection(r.Ledger, aliases, policy, r.View);
        Assert.Empty(projection.ForUser(lab.Config, r.Member).Titles);
        user.SetPreference(Jellyfin.Database.Implementations.Enums.PreferenceKind.BlockedMediaFolders, new[] { next.Id });
        Assert.Single(projection.ForUser(lab.Config, r.Member).Titles);
    }

    [Fact]
    public async Task DurableAliasesSurviveReopenWithoutLiveSourcesIncludingImdbAndAnotherMovie()
    {
        using var r = new IntegrationRequestLedgerTests.Rig();
        using var arr = new FakeArr();
        var host = arr.Add("sonarr.test", "Sonarr");
        host.Series.Add(new JsonObject { ["id"] = 1, ["tvdbId"] = 78874, ["tmdbId"] = 1437, ["imdbId"] = "tt0303461", ["title"] = "Firefly" });
        arr.Configure(("TV", ArrKind.Sonarr, "http://sonarr.test", "test"));
        using var store = arr.Store();
        Assert.True((await store.RefreshLibraryNowAsync(arr.Instance("TV"), default)).Ok);
        var live = new TitleAliases(store, null);
        Assert.Contains(live.Of(TitleKey.Parse("tv:tvdb:78874")!), k => k.Provider == "tmdb");
        await r.Create(input: IntegrationRequestLedgerTests.Seasons(1));
        await r.Create(input: new MutationInput { Key = "movie:imdb:tt0133093" });
        await r.Create(input: IntegrationRequestLedgerTests.Movie(604));
        Assert.NotNull(r.Ledger.Unify(live.Of(TitleKey.Parse("tv:tvdb:78874")!).Select(k => k.ToString()).Append("tv:tvdb:78874"), r.Policy, r.Now));
        Assert.NotNull(r.Ledger.Unify(new[] { "movie:imdb:tt0133093", "movie:tmdb:603" }, r.Policy, r.Now));
        r.Reopen();
        using var coldStore = arr.Store();
        var cold = new TitleAliases(coldStore, null);
        Assert.Empty(cold.Of(TitleKey.Parse("tv:tvdb:78874")!));
        r.Policy.Configuration.ArrBackendIsolationVersion = 1;
        var result = new RequestedTitlesProjection(r.Ledger, cold, r.Policy, r.View).ForUser(r.Policy.Configuration, r.Member);
        Assert.True(result.Complete);
        Assert.Equal(new[] { (603, "movie"), (604, "movie"), (1437, "tv") }, result.Identities().OrderBy(x => x.TmdbId));
    }

    [Theory]
    [InlineData(true)][InlineData(false)]
    public async Task UnknownWantDoesNotEraseOtherOwnershipAndRetryWarmsVisibility(bool filter)
    {
        using var r = new IntegrationRequestLedgerTests.Rig();
        using var arr = new FakeArr();
        using var store = arr.Store();
        var c = arr.Plugin.Plugin.Configuration;
        c.ArrRequestBackend = "je"; c.ArrBackendIsolationVersion = 1; c.DownloadsFilterByUserRequests = filter;
        await r.Create();
        await r.Create(input: IntegrationRequestLedgerTests.Movie(604));
        var warmed = false; var prepares = 0;
        r.Policy.Adjust = (_, input, facts) => input.Key == "movie:tmdb:604" && !warmed ? facts with { Visible = false, VisibilityUnknown = true } : facts;
        r.Policy.Visibility = (_, _) => { prepares++; return Task.CompletedTask; };
        var projection = new RequestedTitlesProjection(r.Ledger, new TitleAliases(store, null), r.Policy, r.View);
        var controller = ApiAssetTests.Controller(arr.Plugin.Core, arr.Factory, projection);
        controller.HttpContext.User = TestCallers.Principal(r.Member, false);
        async Task<IReadOnlySet<(int, string)>?> Proof()
        {
            if (!filter)
                return await (Task<IReadOnlySet<(int, string)>?>)typeof(JellyfinEnhancedController).GetMethod("GetAskedProofAsync", BindingFlags.NonPublic | BindingFlags.Instance)!.Invoke(controller, new object[] { c, new User("viewer", "default", "default") { Id = r.Member } })!;
            var result = await (Task<(bool, HashSet<(int, string)>?)>)typeof(JellyfinEnhancedController).GetMethod("GetAllowedRequestsForCurrentUserAsync", BindingFlags.NonPublic | BindingFlags.Instance)!.Invoke(controller, new object[] { c })!;
            Assert.False(result.Item1); return result.Item2;
        }
        Assert.Contains((603, "movie"), (await Proof())!);
        Assert.DoesNotContain((604, "movie"), (await Proof())!);
        Assert.True(prepares > 0);
        r.Policy.Visibility = (_, _) => { prepares++; warmed = true; return Task.CompletedTask; };
        Assert.Contains((604, "movie"), (await Proof())!);
    }

    [Theory]
    [InlineData(false)][InlineData(true)]
    public async Task ColdProductionVisibilityUsesBoundedPreparationAndRoutesReportUnavailableThenRecover(bool history)
    {
        using var r = new IntegrationRequestLedgerTests.Rig();
        using var lab = new IntegrationRequestBackendsTests.Lab();
        var c = lab.Config; c.ArrBackendIsolationVersion = 1; c.TMDB_API_KEY = "test";
        c.DownloadsPageEnabled = c.ShowDownloadsInRequests = c.DownloadsShowHistory = c.DownloadsFilterByUserRequests = true;
        c.DownloadsHistoryAdminOnly = false;
        r.Policy.People[r.Member] = r.Policy.People[r.Member] with { InstanceId = lab.Instance("Radarr").Id };
        await r.Create(); await r.Create(input: IntegrationRequestLedgerTests.Movie(604));
        var viewer = r.View.Users[r.Member]; var user = (User)viewer.Handle!;
        user.MaxParentalRatingScore = 10;
        r.View.Users[r.Member] = new StatusViewer { UserId = r.Member, Handle = user, HasParentalLimit = true };
        r.View.AddCopy(TitleKey.Parse("movie:tmdb:603")!, new JfCopy { ItemId = Guid.NewGuid(), Visible = true });
        var users = new Mock<MediaBrowser.Controller.Library.IUserManager>(); users.Setup(u => u.GetUserById(r.Member)).Returns(user);
        var localization = new Mock<MediaBrowser.Model.Globalization.ILocalizationManager>();
        localization.Setup(l => l.GetRatingScore("G", "US")).Returns(new MediaBrowser.Model.Entities.ParentalRatingScore(1, null));
        var server = new Mock<MediaBrowser.Controller.Configuration.IServerConfigurationManager>();
        server.SetupGet(s => s.Configuration).Returns(new MediaBrowser.Model.Configuration.ServerConfiguration { MetadataCountryCode = "US" });
        lab.Radarr.Queue.Add(FakeArr.RadarrQueueRow(1, 603, "Known"));
        lab.Radarr.Queue.Add(FakeArr.RadarrQueueRow(2, 604, "Cold"));
        lab.Radarr.History.Add(FakeArr.HistoryRow(1, "downloadFolderImported", lab.Arr.Now.UtcDateTime, "known", 603, "Known"));
        lab.Radarr.History.Add(FakeArr.HistoryRow(2, "downloadFolderImported", lab.Arr.Now.UtcDateTime, "cold", 604, "Cold"));
        var audience = new ApiArrRoutesTests.KeyAudience();
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var metadata = new IntegrationTransport(async (request, ct) =>
        {
            Assert.Equal("api.themoviedb.org", request.RequestUri!.Host);
            await release.Task.WaitAsync(ct);
            return IntegrationTransport.Response(JsonSerializer.Serialize(new { results = new[] { new { iso_3166_1 = "US", release_dates = new[] { new { type = 3, certification = "G" } } } } }));
        });
        var parental = new Jellyfin.Plugin.JellyfinEnhanced.Services.SeerrParentalFilter(metadata, users.Object, localization.Object, server.Object, lab.Arr.Plugin.Core.Logger);
        var aliases = new TitleAliases(lab.Store, null);
        var policy = new RequestPolicy(r.View, lab.Store, new ArrInstanceLibraries(lab.Store, new FakeLibraryAccess()), aliases, parental, lab.Arr.Factory, new UnavailableRequestBackend());
        var projection = new RequestedTitlesProjection(r.Ledger, aliases, policy, r.View);
        Assert.False(projection.ForUser(c, r.Member).Complete);
        JellyfinEnhancedController Make()
        {
            var controller = ApiAssetTests.Controller(lab.Arr.Plugin.Core, lab.Store, projection, users.Object, audience);
            controller.HttpContext.User = TestCallers.Principal(r.Member, false); return controller;
        }
        async Task<IActionResult> Read(JellyfinEnhancedController controller) => history ? await controller.GetDownloadHistory() : await controller.GetDownloadQueue();
        var firstController = Make();
        var first = Assert.IsType<ObjectResult>(await Read(firstController));
        Assert.Equal(503, first.StatusCode);
        Assert.Equal("2", firstController.Response.Headers.RetryAfter);
        var json = JsonSerializer.SerializeToElement(first.Value);
        Assert.Single(json.GetProperty("items").EnumerateArray());
        Assert.False(json.GetProperty("requests").GetProperty("complete").GetBoolean());
        Assert.True(json.GetProperty("requests").GetProperty("retryable").GetBoolean());
        Assert.Contains((603, "movie"), projection.ForUser(c, r.Member).Identities());
        release.TrySetResult();
        var recovered = Assert.IsType<OkObjectResult>(await Read(Make()));
        Assert.Equal(2, JsonSerializer.SerializeToElement(recovered.Value).GetProperty("items").GetArrayLength());
        Assert.True(projection.ForUser(c, r.Member).Complete);
        Assert.True(metadata.Calls > 0);
    }

    private sealed class LateConfirmedBackend(Func<Task> transition) : IRequestBackend
    {
        public Task PrepareAsync(Guid user, MutationInput input, CancellationToken ct) => Task.CompletedTask;
        public RequestBackendBinding Binding(Guid user, MutationInput input) => new();
        public async Task<RequestBackendResult> SendAsync(RequestJob job, Func<string?> guard, CancellationToken ct)
        {
            await transition();
            return new(RequestOutcome.Accepted(job.WantId, "looking", 200), Confirmed: true);
        }
        public Task<RequestBackendResult> ReadBackAsync(RequestJob job, CancellationToken ct) => throw new InvalidOperationException("No readback of a confirmed result");
    }

    [Fact]
    public async Task OutboxFencesAProviderResultReturnedAfterAdoptionBeforeLocalSettlement()
    {
        using var r = new IntegrationRequestLedgerTests.Rig();
        using var arr = new FakeArr();
        var c = arr.Plugin.Plugin.Configuration; c.ArrRequestBackend = "seerr"; c.ArrBackendIsolationVersion = 1;
        r.Policy.Configuration.ArrRequestBackend = "seerr";
        r.Policy.Adjust = (_, _, facts) => facts with { SeerrSource = "source", SeerrUser = 7, BackendQuota = new QuotaProjection(0, null, null, null, 0) };
        var created = await r.Create();
        var backend = new LateConfirmedBackend(() => EffectiveRequestsBackend.Shared.TransitionAsync(() => { c.ArrRequestBackend = "je"; }, default));
        await r.Runner(backend).TickAsync(default);
        var job = Assert.Single(r.Ledger.ForWant(created.RequestId!));
        Assert.NotEqual("succeeded", job.State);
        Assert.True(job.Uncertain);
        Assert.Equal("backend_disabled", job.Reason);
    }

}
