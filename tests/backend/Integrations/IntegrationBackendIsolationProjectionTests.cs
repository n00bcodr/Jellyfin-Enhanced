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
        var result = Assert.IsType<RequestedTitlesResult>(Assert.IsType<OkObjectResult>(controller.RequestedTitles()).Value);
        Assert.Single(result.Titles);
        Assert.Equal("private, no-store", controller.Response.Headers.CacheControl);
        controller.HttpContext.User = TestCallers.Principal(r.Manager, false);
        Assert.Empty(Assert.IsType<RequestedTitlesResult>(Assert.IsType<OkObjectResult>(controller.RequestedTitles()).Value).Titles);
        c.ArrBackendIsolationVersion = 2;
        Assert.Equal(503, Assert.IsType<ObjectResult>(controller.RequestedTitles()).StatusCode);
        controller.HttpContext.User = TestCallers.Principal(Guid.NewGuid(), false);
        Assert.Equal(403, Assert.IsType<ObjectResult>(controller.RequestedTitles()).StatusCode);
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

}
