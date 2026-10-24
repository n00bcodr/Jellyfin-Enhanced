using System.Reflection;
using System.Text.Json.Nodes;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Jellyseerr;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Mvc.ModelBinding;
using Microsoft.AspNetCore.Routing;
using Moq;

namespace JE.Tests;

/// <summary>
/// Review round 5 (COREUC-R5-1..3): deadlines and tickets cross cache boundaries. An entry lives from the start of the
/// read of its earliest input and never past any input's deadline (the Seerr account id copied from a held user lookup,
/// prepared facts built from held Seerr settings, a missing mapping); a generation is taken before the first input read;
/// a Seerr account found reassigned ends every preparation running now. Through the production paths.
/// </summary>
[Collection("Plugin singleton")]
public class UserCacheSeerrDeadlineTests
{
    private static PluginConfiguration SeerrConfig() => new()
    {
        ArrIntegrationEnabled = true, ArrPhase1Enabled = true, JellyseerrEnabled = true,
        JellyseerrUrls = FakeSeerr.Url, JellyseerrApiKey = FakeSeerr.Key,
    };

    [Fact]
    public async Task ASeerrAccountIdKeptFromAHeldLookupEndsWithThatLookup()
    {
        var ticks = TimeSpan.FromHours(2).Ticks;
        using var clock = MonotonicClock.Use(() => ticks);
        using var plugin = new ApiPluginFixture();
        var user = Guid.NewGuid().ToString("N");
        var config = plugin.Plugin.Configuration;
        config.JellyseerrEnabled = true;
        config.JellyseerrUrls = FakeSeerr.Url;
        config.JellyseerrApiKey = FakeSeerr.Key;
        config.JellyseerrUserIdCacheTtlMinutes = 30;
        using var transport = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response(
            new JsonObject { ["results"] = new JsonArray(new JsonObject { ["id"] = 38, ["jellyfinUserId"] = user }) }.ToJsonString())));
        var controller = ApiAssetTests.Controller(plugin.Core, transport);
        var type = typeof(JellyfinEnhancedController);
        var users = (Dictionary<string, (JellyseerrUser? User, long ReadAt, SeerrAccountAuthority.Ticket Authority)>)type.GetField("_userCache", BindingFlags.Static | BindingFlags.NonPublic)!.GetValue(null)!;
        var getter = type.GetMethod("GetJellyseerrUserId", BindingFlags.Instance | BindingFlags.NonPublic)!;
        Task<string?> Read() => (Task<string?>)getter.Invoke(controller, [user])!;
        JellyfinEnhancedController.ClearAllSeerrCachesOnConfigChange();
        try
        {
            // The person's Seerr user was looked up 29 minutes ago (the limit is 30): the id is worked out from it now.
            var old = new JellyseerrUser { Id = 27, JellyfinUserId = user };
            users[user] = (old, ticks - TimeSpan.FromMinutes(29).Ticks, SeerrAccountAuthority.Capture(config, user));
            Assert.Equal("27", await Read());
            Assert.Equal(0, transport.Calls);
            // Two minutes on: the lookup is 31 minutes old, and so is the id worked out from it. Seerr now links the person
            // to account 38.
            ticks += TimeSpan.FromMinutes(2).Ticks;
            Assert.Equal("38", await Read());
        }
        finally
        {
            JellyfinEnhancedController.ClearAllSeerrCachesOnConfigChange();
        }
    }

    [Fact]
    public async Task PreparedSeerrSettingsEndWithTheirOwnRead()
    {
        var ticks = 0L;
        using var clock = MonotonicClock.Use(() => ticks);
        using var seerr = new FakeSeerr();
        var user = Guid.NewGuid();
        seerr.Users.Add(new JsonObject { ["id"] = 9, ["jellyfinUserId"] = user.ToString("N"), ["permissions"] = 2 });
        seerr.Settings["movie4kEnabled"] = true;
        var config = SeerrConfig();
        var start = DateTimeOffset.UtcNow;
        DateTimeOffset Now() => start.AddTicks(ticks);
        using var model = new SeerrRequestReadModel(seerr.Transport, null, null, () => config, Now);
        var backend = new SeerrBackend(seerr.Transport, model, null, () => config, Now);
        var input = new MutationInput { Key = "movie:tmdb:603", Scope = "movie" };
        await backend.PrepareAsync(user, input, default);
        Assert.True(backend.Binding(user, input).FourKEnabled);
        seerr.Settings["movie4kEnabled"] = false;
        // 14 s later a new preparation is handed the settings read at 0 s (they count 15 s).
        ticks = TimeSpan.FromSeconds(14).Ticks;
        await backend.PrepareAsync(user, input, default);
        Assert.True(backend.Binding(user, input).FourKEnabled);
        Assert.True(backend.Binding(user, input).CanRequest);
        // Past those settings' own 15 s, nothing says 4K is on any more (the identity facts still count: their read is fresh).
        ticks = TimeSpan.FromSeconds(16).Ticks;
        Assert.False(backend.Binding(user, input).FourKEnabled);
        Assert.True(backend.Binding(user, input).CanRequest);
        ticks = TimeSpan.FromSeconds(610).Ticks;
        Assert.False(backend.Binding(user, input).FourKEnabled);
    }

    [Fact]
    public async Task AnUnlinkedAnswerEndsWithTheMappingItCameFrom()
    {
        var ticks = 0L;
        using var clock = MonotonicClock.Use(() => ticks);
        using var seerr = new FakeSeerr();
        var user = Guid.NewGuid();
        var config = SeerrConfig();
        var start = DateTimeOffset.UtcNow;
        DateTimeOffset Now() => start.AddTicks(ticks);
        using var model = new SeerrRequestReadModel(seerr.Transport, null, null, () => config, Now);
        var backend = new SeerrBackend(seerr.Transport, model, null, () => config, Now);
        var input = new MutationInput { Key = "movie:tmdb:603", Scope = "movie" };
        // Seerr links no account to the person at 0 s (a missing mapping counts 60 s) ...
        await backend.PrepareAsync(user, input, default);
        Assert.True(backend.Binding(user, input).SeerrUnlinked);
        // ... at 50 s a preparation is handed that held answer ...
        ticks = TimeSpan.FromSeconds(50).Ticks;
        await backend.PrepareAsync(user, input, default);
        Assert.True(backend.Binding(user, input).SeerrUnlinked);
        // ... and past the mapping's own minute, nothing says the person has no account (before: ten minutes from 50 s).
        ticks = TimeSpan.FromSeconds(61).Ticks;
        Assert.False(backend.Binding(user, input).SeerrUnlinked);
    }

    [Fact]
    public async Task AReassignedSeerrAccountEndsEveryPreparationRunningNow()
    {
        using var seerr = new FakeSeerr();
        var user = Guid.NewGuid();
        var account = new JsonObject { ["id"] = 9, ["jellyfinUserId"] = user.ToString("N"), ["permissions"] = 32 };
        seerr.Users.Add(account);
        var config = SeerrConfig();
        var now = DateTimeOffset.UtcNow;
        using var model = new SeerrRequestReadModel(seerr.Transport, null, null, () => config, () => now);
        var backend = new SeerrBackend(seerr.Transport, model, null, () => config, () => now);
        var input = new MutationInput { Key = "movie:tmdb:603", Scope = "movie" };
        var reachedQuota = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseQuota = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        seerr.BeforeRequest = async uri =>
        {
            if (uri.AbsolutePath.EndsWith("/quota", StringComparison.Ordinal) && !reachedQuota.Task.IsCompleted)
            {
                reachedQuota.TrySetResult();
                await releaseQuota.Task;
            }
        };
        // A preparation has read the account while it was still the person's, and waits for the quota.
        var older = backend.PrepareAsync(user, input, default);
        await reachedQuota.Task.WaitAsync(TimeSpan.FromSeconds(5));
        // Seerr now links that account to someone else; a newer preparation finds out.
        account["jellyfinUserId"] = Guid.NewGuid().ToString("N");
        await backend.PrepareAsync(user, input, default);
        Assert.False(backend.Binding(user, input).CanRequest);
        Assert.True(backend.Binding(user, input).SeerrUnlinked);
        // The older one finishing can't put the account back.
        releaseQuota.TrySetResult();
        await older;
        Assert.False(backend.Binding(user, input).CanRequest);
        Assert.Null(backend.Binding(user, input).UserId);
    }

    [Fact]
    public async Task AReassignedSeerrAccountAlsoEndsTheProxysAccountLookups()
    {
        using var plugin = new ApiPluginFixture();
        using var seerr = new FakeSeerr();
        var user = Guid.NewGuid();
        var account = new JsonObject { ["id"] = 9, ["jellyfinUserId"] = user.ToString("N"), ["permissions"] = 32 };
        seerr.Users.Add(account);
        var config = SeerrConfig(plugin);
        var now = DateTimeOffset.UtcNow;
        using var model = new SeerrRequestReadModel(seerr.Transport, null, null, () => config, () => now);
        var backend = new SeerrBackend(seerr.Transport, model, null, () => config, () => now);
        var type = typeof(JellyfinEnhancedController);
        var ids = (Dictionary<string, (string JellyseerrUserId, long ReadAt, SeerrAccountAuthority.Ticket Authority)>)type.GetField("_userIdCache", BindingFlags.Static | BindingFlags.NonPublic)!.GetValue(null)!;
        JellyfinEnhancedController.ClearAllSeerrCachesOnConfigChange();
        try
        {
            await backend.PrepareAsync(user, new MutationInput { Key = "movie:tmdb:603", Scope = "movie" }, default);
            // The legacy proxy holds the person's account id (it acts as that account in Seerr) ...
            ids[user.ToString()] = SeerrSeeds.Id(user.ToString(), "9");
            Assert.Equal("9", HeldProxyAccount(user.ToString()));
            account["jellyfinUserId"] = Guid.NewGuid().ToString("N");
            await backend.PrepareAsync(user, new MutationInput { Key = "movie:tmdb:603", Scope = "movie" }, default);
            // ... and stops the moment the account is found to belong to someone else.
            Assert.Null(HeldProxyAccount(user.ToString()));
        }
        finally
        {
            JellyfinEnhancedController.ClearAllSeerrCachesOnConfigChange();
        }
    }

    [Fact]
    public async Task AFreshReadThatFindsNoAccountEndsTheProxysHeldAccount()
    {
        using var plugin = new ApiPluginFixture();
        using var seerr = new FakeSeerr();
        var user = Guid.NewGuid();
        var other = Guid.NewGuid();
        var config = SeerrConfig(plugin);
        var now = DateTimeOffset.UtcNow;
        using var model = new SeerrRequestReadModel(seerr.Transport, null, null, () => config, () => now);
        var backend = new SeerrBackend(seerr.Transport, model, null, () => config, () => now);
        var type = typeof(JellyfinEnhancedController);
        var ids = (Dictionary<string, (string JellyseerrUserId, long ReadAt, SeerrAccountAuthority.Ticket Authority)>)type.GetField("_userIdCache", BindingFlags.Static | BindingFlags.NonPublic)!.GetValue(null)!;
        JellyfinEnhancedController.ClearAllSeerrCachesOnConfigChange();
        try
        {
            // The proxy holds account 9 for the person (and 5 for someone else); Seerr links no account to the person now.
            ids[user.ToString()] = SeerrSeeds.Id(user.ToString(), "9");
            ids[other.ToString()] = SeerrSeeds.Id(other.ToString(), "5");
            await backend.PrepareAsync(user, new MutationInput { Key = "movie:tmdb:603", Scope = "movie" }, default);
            Assert.True(backend.Binding(user, new MutationInput { Key = "movie:tmdb:603", Scope = "movie" }).SeerrUnlinked);
            Assert.Null(HeldProxyAccount(user.ToString()));
            Assert.Equal("5", HeldProxyAccount(other.ToString()));
        }
        finally
        {
            JellyfinEnhancedController.ClearAllSeerrCachesOnConfigChange();
        }
    }

    // The account id the Seerr proxy would act as for the person without reading Seerr (null: none it may use).
    private static string? HeldProxyAccount(string jellyfinUserId)
        => (string?)typeof(JellyfinEnhancedController).GetMethod("TryGetCachedJellyseerrUserId", BindingFlags.Static | BindingFlags.NonPublic)!.Invoke(null, [jellyfinUserId]);

    // The plugin's own configuration, pointed at the fake Seerr: the proxy and the backend read the same one.
    private static PluginConfiguration SeerrConfig(ApiPluginFixture plugin)
    {
        var c = plugin.Plugin.Configuration;
        c.ArrIntegrationEnabled = true;
        c.ArrPhase1Enabled = true;
        c.JellyseerrEnabled = true;
        c.JellyseerrUrls = FakeSeerr.Url;
        c.JellyseerrApiKey = FakeSeerr.Key;
        return c;
    }

    [Fact]
    public async Task AnAskedProofLivesFromWhenItsReadBegan()
    {
        var now = DateTimeOffset.UtcNow;
        var cache = new SeerrAskedProofCache(() => now.UtcTicks, TimeSpan.FromSeconds(5));
        var reads = 0;
        IReadOnlySet<(int, string)> answer = new HashSet<(int, string)> { (603, "movie") };
        Task<IReadOnlySet<(int TmdbId, string MediaType)>?> Read()
        {
            reads++;
            // The reply takes 25 s to arrive.
            now = now.AddSeconds(25);
            return Task.FromResult<IReadOnlySet<(int TmdbId, string MediaType)>?>(answer);
        }

        Assert.NotNull(await cache.GetAsync("u|s", Read));
        Assert.Equal(1, reads);
        // 31 s after the read BEGAN (6 s after the reply): the answer is past its 30 s and is read again.
        now = now.AddSeconds(6);
        Assert.NotNull(await cache.GetAsync("u|s", Read));
        await Task.Delay(50);
        Assert.Equal(2, reads);
    }

    [Fact]
    public void ALateStampOrALateFenceInThePluginsSourceFails()
    {
        // The proxy keeps an answer stamped with the time it came in ...
        var stamped = WriteGateWalk.Plugin.With("Controllers/JellyfinEnhancedController.cs", s => s.Replace(
            "_responseCache[cacheKey] = (json, requestStart);", "_responseCache[cacheKey] = (json, Helpers.MonotonicClock.Now());"));
        Assert.Contains(UserCacheScan.LateStamps(stamped, UserCacheScan.Caches(stamped)), l => l.Cache == "JellyfinEnhancedController._responseCache");
        Assert.DoesNotContain(UserCacheScan.LateStamps(WriteGateWalk.Plugin, UserCacheScan.Caches(WriteGateWalk.Plugin)), l => l.Cache == "JellyfinEnhancedController._responseCache");
        // ... or samples its fence after it read the configuration (round 5's COREUC-R5-3 shape).
        var fenced = WriteGateWalk.Plugin.With("Controllers/JellyfinEnhancedController.cs", s => s.Replace(
            "            var responseGeneration = Interlocked.Read(ref _seerrResponseGeneration);\n            var requestStart = Helpers.MonotonicClock.Now();\n            var config = JellyfinEnhanced.Instance?.Configuration;",
            "            var config = JellyfinEnhanced.Instance?.Configuration;\n            var responseGeneration = Interlocked.Read(ref _seerrResponseGeneration);\n            var requestStart = Helpers.MonotonicClock.Now();"));
        Assert.Contains(UserCacheScan.LateFences(fenced, "JellyfinEnhancedController._responseCache", "_seerrResponseGeneration"), p => p.Contains("ProxyJellyseerrRequestCore", StringComparison.Ordinal));
        Assert.Empty(UserCacheScan.LateFences(WriteGateWalk.Plugin, "JellyfinEnhancedController._responseCache", "_seerrResponseGeneration"));
    }
}

/// <summary>
/// Review round 5 (COREUC-R5-5..7, server side): every JE answer carries the person's access and document revisions,
/// taken before the action reads anything, whatever features are on; the documents' part moves with a write of that
/// document only.
/// </summary>
[Collection("Jellyfin user versions")]
public class AccessRevisionTests
{
    private static User Person(Guid id, string? rating) => UserChange.Read(id, policy: u => { if (rating != null) u.MaxParentalRatingScore = 10; });

    private static async Task<string?> Answer(AccessRevisionFilter filter, Guid user, Action? during = null, string path = "/JellyfinEnhanced/acquire/requests/me")
    {
        var http = new DefaultHttpContext();
        http.Request.Path = path;
        http.User = new System.Security.Claims.ClaimsPrincipal(new System.Security.Claims.ClaimsIdentity([new System.Security.Claims.Claim("Jellyfin-UserId", user.ToString())], "test"));
        UserChange.Request(http);
        try
        {
            var context = new ResourceExecutingContext(new ActionContext(http, new RouteData(), new ActionDescriptor()), new List<IFilterMetadata>(), new List<IValueProviderFactory>());
            await filter.OnResourceExecutionAsync(context, () =>
            {
                during?.Invoke();
                return Task.FromResult(new ResourceExecutedContext(context, context.Filters));
            });
            return http.Response.Headers.TryGetValue(AccessRevision.Header, out var value) ? value.ToString() : null;
        }
        finally
        {
            UserChange.Request(null);
        }
    }

    [Fact]
    public async Task EveryAnswerCarriesTheAccessRevisionTakenBeforeTheActionAndItMovesWithTheAccess()
    {
        var id = Guid.NewGuid();
        var current = Person(id, null);
        var users = new Mock<IUserManager>();
        users.Setup(u => u.GetUserById(id)).Returns(() => current);
        var filter = new AccessRevisionFilter(users.Object);
        var first = await Answer(filter, id);
        Assert.NotNull(first);
        Assert.StartsWith("a=", first, StringComparison.Ordinal);
        Assert.Equal(first, await Answer(filter, id));
        // A parental limit set while an action runs: that answer still carries the revision of the read it began with ...
        var during = await Answer(filter, id, () => current = Person(id, "PG"));
        Assert.Equal(first, during);
        // ... and the next answer the new one.
        var next = await Answer(filter, id);
        Assert.NotEqual(first!.Split(';')[0], next!.Split(';')[0]);
        // Only JE's own API carries it.
        Assert.Null(await Answer(filter, id, path: "/Items"));
    }

    [Fact]
    public async Task TheDocumentPartMovesWithAWriteOfThatDocumentOnly()
    {
        using var core = new CoreFixture();
        var manager = core.Manager;
        var id = Guid.NewGuid();
        var current = Person(id, null);
        var users = new Mock<IUserManager>();
        users.Setup(u => u.GetUserById(id)).Returns(() => current);
        var filter = new AccessRevisionFilter(users.Object);
        string Part(string revision, string name) => revision.Split(';').Single(p => p.StartsWith(name + "=", StringComparison.Ordinal));
        var before = (await Answer(filter, id))!;
        manager.SaveUserConfiguration(id.ToString("N"), "settings.json", new JellyfinEnhancedUserSettings());
        var settings = (await Answer(filter, id))!;
        Assert.Equal(Part(before, "hc"), Part(settings, "hc"));
        Assert.Equal(Part(before, "sg"), Part(settings, "sg"));
        // Another tab hides a title.
        manager.SaveUserConfiguration(id.ToString("N"), AccessRevision.HiddenContentFile, new UserHiddenContent());
        var hidden = (await Answer(filter, id))!;
        Assert.NotEqual(Part(before, "hc"), Part(hidden, "hc"));
        Assert.Equal(Part(before, "sg"), Part(hidden, "sg"));
        Assert.Equal(Part(before, "a"), Part(hidden, "a"));
        // Another device guards a movie.
        manager.SaveUserConfiguration(id.ToString("N"), SpoilerBlurImageFilter.SpoilerBlurFileName, new { Movies = new Dictionary<string, object>() });
        var guarded = (await Answer(filter, id))!;
        Assert.NotEqual(Part(hidden, "sg"), Part(guarded, "sg"));
        Assert.Equal(Part(hidden, "hc"), Part(guarded, "hc"));
        // Another person's write moves nothing of theirs.
        manager.SaveUserConfiguration(Guid.NewGuid().ToString("N"), AccessRevision.HiddenContentFile, new UserHiddenContent());
        Assert.Equal(guarded, await Answer(filter, id));
    }

    [Fact]
    public void TheRevisionEndpointAnswersWhatTheHeaderCarries()
    {
        var id = Guid.NewGuid();
        var users = new Mock<IUserManager>();
        users.Setup(u => u.GetUserById(id)).Returns(Person(id, null));
        var controller = new AccessRevisionController(users.Object);
        var http = new DefaultHttpContext();
        http.User = new System.Security.Claims.ClaimsPrincipal(new System.Security.Claims.ClaimsIdentity([new System.Security.Claims.Claim("Jellyfin-UserId", id.ToString())], "test"));
        controller.ControllerContext = new ControllerContext { HttpContext = http };
        UserChange.Request(http);
        try
        {
            var body = Assert.IsType<OkObjectResult>(controller.GetRevision()).Value!;
            var revision = (string)body.GetType().GetProperty("revision")!.GetValue(body)!;
            Assert.Equal(AccessRevision.For(users.Object, id), revision);
            Assert.Equal(revision, http.Response.Headers[AccessRevision.Header].ToString());
            Assert.Equal("no-store", http.Response.Headers["Cache-Control"].ToString());
        }
        finally
        {
            UserChange.Request(null);
        }
    }
}
