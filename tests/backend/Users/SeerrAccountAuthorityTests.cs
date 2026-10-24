using System.Reflection;
using System.Security.Claims;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Globalization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Infrastructure;
using Moq;

namespace JE.Tests;

/// <summary>
/// A person's Seerr account authority (the Jellyfin user, the Seerr their configuration points at, and the generation of
/// the account link Seerr was last seen to hold for them) moves on every fresh read that changes or loses the link, even
/// with nothing cached, and every answer worked out for the person under an older one is neither kept nor handed out:
/// the proxy's account lookups and its per-person answers, the request backend's preparations, and the legacy automatic
/// requests. Prepared Seerr settings end on the monotonic clock, from their read. Through the production entry points.
/// </summary>
[Collection("Plugin singleton")]
public class SeerrAccountAuthorityTests
{
    private static void Configure(ApiPluginFixture plugin, string url = "http://seerr.invalid")
    {
        var c = plugin.Plugin.Configuration;
        c.JellyseerrEnabled = true;
        c.JellyseerrAutoImportUsers = false;
        c.JellyseerrUrls = url;
        c.JellyseerrApiKey = "fixture-only";
        JellyfinEnhancedController.ClearAllSeerrCachesOnConfigChange();
    }

    private static string Users(Guid user, int? id)
        => id is int account
            ? JsonSerializer.Serialize(new { results = new[] { new { id = account, jellyfinUserId = user.ToString("N") } } })
            : "{\"results\":[]}";

    private static Func<Task<string?>> ProxyLookup(JellyfinEnhancedController controller, Guid user)
    {
        var read = typeof(JellyfinEnhancedController).GetMethod("GetJellyseerrUserId", BindingFlags.Instance | BindingFlags.NonPublic)!;
        return () => (Task<string?>)read.Invoke(controller, [user.ToString("N")])!;
    }

    [Theory]
    [InlineData(null)]
    [InlineData(38)]
    public async Task AProxyLookupRunningWhenTheAccountIsFoundGoneNeitherReturnsNorKeepsIt(int? now)
    {
        using var plugin = new ApiPluginFixture();
        Configure(plugin);
        var user = Guid.NewGuid();
        var reached = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        int? linked = 9;
        using var transport = new IntegrationTransport(async (_, _) =>
        {
            var body = Users(user, linked);
            if (!reached.Task.IsCompleted) { reached.TrySetResult(); await release.Task; }
            return IntegrationTransport.Response(body);
        });
        var read = ProxyLookup(ApiAssetTests.Controller(plugin.Core, transport), user);
        try
        {
            // Both proxy caches are cold: the lookup below is the only work holding account 9.
            var old = read();
            await reached.Task.WaitAsync(TimeSpan.FromSeconds(5));
            linked = now;
            // What the request backend reports after a fresh read of Seerr finds the link gone (or another account).
            JellyfinEnhancedController.ForgetSeerrAccountOtherThan(user, now);
            release.TrySetResult();
            var expected = now?.ToString(System.Globalization.CultureInfo.InvariantCulture);
            Assert.Equal(expected, await old);
            var calls = transport.Calls;
            Assert.Equal(expected, await read());
            Assert.Equal(expected, await read());
            if (now != null) Assert.Equal(calls, transport.Calls);
        }
        finally
        {
            release.TrySetResult();
            JellyfinEnhancedController.ClearAllSeerrCachesOnConfigChange();
        }
    }

    [Fact]
    public async Task AFreshBackendReadFindingNoAccountEndsAColdProxyLookupRunningThen()
    {
        using var plugin = new ApiPluginFixture();
        var user = Guid.NewGuid();
        var config = plugin.Plugin.Configuration;
        config.ArrIntegrationEnabled = true;
        config.ArrPhase1Enabled = true;
        config.JellyseerrEnabled = true;
        config.JellyseerrAutoImportUsers = false;
        config.JellyseerrUrls = FakeSeerr.Url;
        config.JellyseerrApiKey = FakeSeerr.Key;
        JellyfinEnhancedController.ClearAllSeerrCachesOnConfigChange();
        var reached = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        int? linked = 9;
        using var transport = new IntegrationTransport(async (_, _) =>
        {
            var body = Users(user, linked);
            if (!reached.Task.IsCompleted) { reached.TrySetResult(); await release.Task; }
            return IntegrationTransport.Response(body);
        });
        var read = ProxyLookup(ApiAssetTests.Controller(plugin.Core, transport), user);
        try
        {
            var old = read();
            await reached.Task.WaitAsync(TimeSpan.FromSeconds(5));
            // The request backend reads the same Seerr fresh: no account is linked to the person (now true everywhere).
            linked = null;
            using var seerr = new FakeSeerr();
            var wall = DateTimeOffset.UtcNow;
            using var model = new SeerrRequestReadModel(seerr.Transport, null, null, () => config, () => wall);
            var backend = new SeerrBackend(seerr.Transport, model, null, () => config, () => wall);
            var input = new MutationInput { Key = "movie:tmdb:603", Scope = "movie" };
            await backend.PrepareAsync(user, input, default);
            Assert.True(backend.Binding(user, input).SeerrUnlinked);
            release.TrySetResult();
            Assert.Null(await old);
            Assert.Null(await read());
            Assert.True(transport.Calls >= 2, "the account is looked up again after the fresh read");
        }
        finally
        {
            release.TrySetResult();
            JellyfinEnhancedController.ClearAllSeerrCachesOnConfigChange();
        }
    }

    [Fact]
    public async Task ANewlyConfirmedAccountGetsItsOwnAnswerNotTheOldAccountsCachedOne()
    {
        using var plugin = new ApiPluginFixture();
        Configure(plugin);
        var user = Guid.NewGuid();
        var account = 9;
        var detailCalls = 0;
        using var transport = new IntegrationTransport((r, _) =>
        {
            if (r.RequestUri!.AbsolutePath == "/api/v1/user")
                return Task.FromResult(IntegrationTransport.Response(JsonSerializer.Serialize(new { results = new[] { new { id = account, jellyfinUserId = user.ToString("N"), permissions = 32 } } })));
            detailCalls++;
            return Task.FromResult(IntegrationTransport.Response(JsonSerializer.Serialize(new { id = 603, title = "Movie", accountOnly = r.Headers.GetValues("X-Api-User").Single() })));
        });
        var users = Mock.Of<IUserManager>();
        var filter = new SeerrParentalFilter(transport, users, Mock.Of<ILocalizationManager>(), Mock.Of<IServerConfigurationManager>(), plugin.Core.Logger);
        var controller = ApiAssetTests.Controller(plugin.Core, transport, users, filter);
        controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([new Claim("Jellyfin-UserId", user.ToString())], "test"));
        try
        {
            var old = Assert.IsType<ContentResult>(await controller.GetMovie(603)).Content!;
            Assert.Equal("9", JsonDocument.Parse(old).RootElement.GetProperty("accountOnly").GetString());
            account = 38;
            JellyfinEnhancedController.ForgetSeerrAccountOtherThan(user, account);
            var next = Assert.IsType<ContentResult>(await controller.GetMovie(603)).Content!;
            Assert.Equal("38", JsonDocument.Parse(next).RootElement.GetProperty("accountOnly").GetString());
            Assert.Equal(2, detailCalls);
        }
        finally
        {
            JellyfinEnhancedController.ClearAllSeerrCachesOnConfigChange();
        }
    }

    [Fact]
    public async Task AFreshReadFindingNoAccountEndsAPreparationHeldAtTheQuotaRead()
    {
        var ticks = 0L;
        using var clock = MonotonicClock.Use(() => ticks);
        using var seerr = new FakeSeerr();
        var user = Guid.NewGuid();
        var account = new JsonObject { ["id"] = 9, ["jellyfinUserId"] = user.ToString("N"), ["permissions"] = 32 };
        seerr.Users.Add(account);
        var config = new PluginConfiguration { ArrIntegrationEnabled = true, ArrPhase1Enabled = true, JellyseerrEnabled = true, JellyseerrUrls = FakeSeerr.Url, JellyseerrApiKey = FakeSeerr.Key };
        var epoch = DateTimeOffset.UtcNow;
        DateTimeOffset Now() => epoch.AddTicks(ticks);
        using var model = new SeerrRequestReadModel(seerr.Transport, null, null, () => config, Now);
        var backend = new SeerrBackend(seerr.Transport, model, null, () => config, Now);
        var input = new MutationInput { Key = "movie:tmdb:603", Scope = "movie" };
        await backend.PrepareAsync(user, input, default);
        Assert.Equal(9, backend.Binding(user, input).UserId);
        ticks = TimeSpan.FromSeconds(599).Ticks;
        var reached = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        seerr.BeforeRequest = async uri =>
        {
            if (uri.AbsolutePath.EndsWith("/quota", StringComparison.Ordinal) && !reached.Task.IsCompleted) { reached.TrySetResult(); await release.Task; }
        };
        var older = backend.PrepareAsync(user, input, default);
        try
        {
            await reached.Task.WaitAsync(TimeSpan.FromSeconds(5));
            account["jellyfinUserId"] = Guid.NewGuid().ToString("N");
            ticks = TimeSpan.FromSeconds(601).Ticks;
            await backend.PrepareAsync(user, input, default);
            Assert.True(backend.Binding(user, input).SeerrUnlinked);
            release.TrySetResult();
            await older;
            var binding = backend.Binding(user, input);
            Assert.Null(binding.UserId);
            Assert.False(binding.CanRequest);
            Assert.True(binding.SeerrUnlinked);
        }
        finally
        {
            release.TrySetResult();
            await older;
        }
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-44)]
    [InlineData(3600)]
    public async Task PreparedSeerrSettingsEndFifteenMonotonicSecondsAfterTheirRead(int wallShiftSeconds)
    {
        long ticks = 0;
        using var clock = MonotonicClock.Use(() => ticks);
        using var seerr = new FakeSeerr();
        var user = Guid.NewGuid();
        seerr.Users.Add(new JsonObject { ["id"] = 9, ["jellyfinUserId"] = user.ToString("N"), ["permissions"] = 2 });
        seerr.Settings["movie4kEnabled"] = true;
        var config = new PluginConfiguration { ArrIntegrationEnabled = true, ArrPhase1Enabled = true, JellyseerrEnabled = true, JellyseerrUrls = FakeSeerr.Url, JellyseerrApiKey = FakeSeerr.Key };
        var start = DateTimeOffset.UtcNow;
        var wall = start;
        using var model = new SeerrRequestReadModel(seerr.Transport, null, null, () => config, () => wall);
        var backend = new SeerrBackend(seerr.Transport, model, null, () => config, () => wall);
        var input = new MutationInput { Key = "movie:tmdb:603", Scope = "movie" };
        await backend.PrepareAsync(user, input, default);
        Assert.True(backend.Binding(user, input).FourKEnabled);
        seerr.Settings["movie4kEnabled"] = false;
        // Still inside fifteen seconds of the read, whatever the wall clock says.
        ticks = TimeSpan.FromSeconds(14).Ticks;
        wall = start.AddSeconds(wallShiftSeconds);
        Assert.True(backend.Binding(user, input).FourKEnabled);
        // Past them: the settings aren't known any more, and another preparation reads them again.
        ticks = TimeSpan.FromSeconds(16).Ticks;
        Assert.False(backend.Binding(user, input).FourKEnabled);
        await backend.PrepareAsync(user, input, default);
        Assert.False(backend.Binding(user, input).FourKEnabled);
    }

    [Theory]
    [InlineData(false, true)]
    [InlineData(true, true)]
    [InlineData(false, false)]
    [InlineData(true, false)]
    public async Task ALegacyAutoRequestSendsAsTheAccountOfTheSeerrConfiguredNow(bool season, bool cleared)
    {
        using var plugin = new ApiPluginFixture();
        Configure(plugin);
        plugin.Plugin.Configuration.AutoMovieRequestEnabled = true;
        plugin.Plugin.Configuration.AutoSeasonRequestEnabled = true;
        var user = Guid.NewGuid();
        string? sentAs = null;
        string? sentHost = null;
        using var transport = new IntegrationTransport((r, _) =>
        {
            if (r.Method == HttpMethod.Get) return Task.FromResult(IntegrationTransport.Response(Users(user, r.RequestUri!.Host == "new-seerr.invalid" ? 38 : 9)));
            sentAs = r.Headers.GetValues("X-Api-User").Single();
            sentHost = r.RequestUri!.Host;
            return Task.FromResult(IntegrationTransport.Response("{\"id\":123}"));
        });
        object service = season
            ? new AutoSeasonRequestService(transport, plugin.Core.Logger, Mock.Of<IUserManager>(), Mock.Of<IUserDataManager>(), Mock.Of<ILibraryManager>())
            : new AutoMovieRequestService(transport, plugin.Core.Logger, Mock.Of<IUserManager>(), Mock.Of<ILibraryManager>());
        var lookup = service.GetType().GetMethod("GetJellyseerrUserId", BindingFlags.Instance | BindingFlags.NonPublic)!;
        Assert.Equal("9", await (Task<string?>)lookup.Invoke(service, [user.ToString("N")])!);
        // Another Seerr, where this person is account 38 (with or without the settings save's own clear).
        plugin.Plugin.Configuration.JellyseerrUrls = "http://new-seerr.invalid";
        if (cleared) JellyfinEnhancedController.ClearAllSeerrCachesOnConfigChange();
        var send = service.GetType().GetMethod(season ? "RequestNextSeason" : "RequestMovie", BindingFlags.Instance | BindingFlags.NonPublic)!;
        object?[] args = season ? ["603", 2, user.ToString("N")] : ["603", user.ToString("N"), null];
        try
        {
            var result = await (Task<(bool Sent, string? Stopped)>)send.Invoke(service, args)!;
            Assert.True(result.Sent, result.Stopped);
            Assert.Equal("new-seerr.invalid", sentHost);
            Assert.Equal("38", sentAs);
        }
        finally
        {
            JellyfinEnhancedController.ClearAllSeerrCachesOnConfigChange();
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ALegacyAutoRequestNeverSendsAsAnAccountFoundToBeSomeoneElses(bool season)
    {
        using var plugin = new ApiPluginFixture();
        Configure(plugin);
        plugin.Plugin.Configuration.AutoMovieRequestEnabled = true;
        plugin.Plugin.Configuration.AutoSeasonRequestEnabled = true;
        var user = Guid.NewGuid();
        var account = 9;
        string? sentAs = null;
        var lookups = 0;
        using var transport = new IntegrationTransport((r, _) =>
        {
            if (r.Method == HttpMethod.Get) { lookups++; return Task.FromResult(IntegrationTransport.Response(Users(user, account))); }
            sentAs = r.Headers.GetValues("X-Api-User").Single();
            return Task.FromResult(IntegrationTransport.Response("{\"id\":123}"));
        });
        object service = season
            ? new AutoSeasonRequestService(transport, plugin.Core.Logger, Mock.Of<IUserManager>(), Mock.Of<IUserDataManager>(), Mock.Of<ILibraryManager>())
            : new AutoMovieRequestService(transport, plugin.Core.Logger, Mock.Of<IUserManager>(), Mock.Of<ILibraryManager>());
        var lookup = service.GetType().GetMethod("GetJellyseerrUserId", BindingFlags.Instance | BindingFlags.NonPublic)!;
        Assert.Equal("9", await (Task<string?>)lookup.Invoke(service, [user.ToString("N")])!);
        // Seerr is read fresh elsewhere (the request backend): the person is account 38 now.
        account = 38;
        JellyfinEnhancedController.ForgetSeerrAccountOtherThan(user, 38);
        var send = service.GetType().GetMethod(season ? "RequestNextSeason" : "RequestMovie", BindingFlags.Instance | BindingFlags.NonPublic)!;
        object?[] args = season ? ["603", 2, user.ToString("N")] : ["603", user.ToString("N"), null];
        try
        {
            var result = await (Task<(bool Sent, string? Stopped)>)send.Invoke(service, args)!;
            Assert.True(result.Sent, result.Stopped);
            Assert.Equal("38", sentAs);
            Assert.Equal(2, lookups);
        }
        finally
        {
            JellyfinEnhancedController.ClearAllSeerrCachesOnConfigChange();
        }
    }

    [Fact]
    public async Task ARequestIsNeverPostedAsAnAccountAFreshReadEndedBeforeThePost()
    {
        using var lab = new IntegrationRequestBackendsTests.SeerrLab();
        var bound = 0;
        // Recording the send on its ledger job is the last step before the POST: a fresh read elsewhere finds the person
        // linked to another Seerr account right then.
        var backend = new SeerrBackend(lab.Seerr.Transport, lab.Model, null, () => lab.Config, () => lab.Now, (_, _, _) =>
        {
            bound++;
            JellyfinEnhancedController.ForgetSeerrAccountOtherThan(lab.User, 8);
            return true;
        });
        var input = new MutationInput { Key = "movie:tmdb:22596", Scope = "movie" };
        await backend.PrepareAsync(lab.User, input, default);
        try
        {
            var result = await backend.SendAsync(lab.Job(input), () => null, null, default);
            Assert.Equal(1, bound);
            Assert.Empty(lab.Seerr.Posts);
            Assert.False(result.Confirmed);
        }
        finally
        {
            JellyfinEnhancedController.ClearAllSeerrCachesOnConfigChange();
        }
    }

    [Fact]
    public async Task AQuotaReadWhileTheAccountChangesIsNotAnsweredAsTheOldAccounts()
    {
        using var plugin = new ApiPluginFixture();
        Configure(plugin);
        var user = Guid.NewGuid();
        var account = 9;
        using var transport = new IntegrationTransport((r, _) =>
        {
            var path = r.RequestUri!.AbsolutePath;
            if (path == "/api/v1/user") return Task.FromResult(IntegrationTransport.Response(Users(user, account)));
            if (path.EndsWith("/quota", StringComparison.Ordinal) && account == 9)
            {
                // While account 9's quota is read, Seerr is read fresh elsewhere: the person is account 38 now.
                account = 38;
                JellyfinEnhancedController.ForgetSeerrAccountOtherThan(user, 38);
            }
            return Task.FromResult(IntegrationTransport.Response(JsonSerializer.Serialize(new { movie = new { limit = 5, used = path.Contains("/9/", StringComparison.Ordinal) ? 4 : 0 }, tv = new { limit = 5, used = 0 } })));
        });
        var users = Mock.Of<IUserManager>();
        var filter = new SeerrParentalFilter(transport, users, Mock.Of<ILocalizationManager>(), Mock.Of<IServerConfigurationManager>(), plugin.Core.Logger);
        var controller = ApiAssetTests.Controller(plugin.Core, transport, users, filter);
        controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([new Claim("Jellyfin-UserId", user.ToString())], "test"));
        try
        {
            var answer = await controller.GetJellyseerrQuota();
            // Never account 9's quota (4 of 5 used) answered as the person's: asked to try again.
            if (answer is ContentResult content) Assert.DoesNotContain("\"used\":4", content.Content ?? string.Empty, StringComparison.Ordinal);
            Assert.Equal(503, Assert.IsAssignableFrom<IStatusCodeActionResult>(answer).StatusCode);
        }
        finally
        {
            JellyfinEnhancedController.ClearAllSeerrCachesOnConfigChange();
        }
    }

    [Fact]
    public void ACacheOfThePersonsSeerrAccountWithoutItsAuthorityFails()
    {
        var registry = UserCacheRegistryTests.Registry();
        Assert.DoesNotContain(UserCacheRegistryTests.Problems(WriteGateWalk.Plugin, registry), p => p.Contains("Seerr account", StringComparison.Ordinal));
        // The request backend's mapping listed without its authority rule ...
        var unruled = registry.Select(r => r.Member == "SeerrBackend._ids" ? r with { Rules = string.Empty } : r).ToList();
        Assert.Contains(UserCacheRegistryTests.Problems(WriteGateWalk.Plugin, unruled), p => p.StartsWith("SeerrBackend._ids: depends on the person's Seerr account but names no authority", StringComparison.Ordinal));
        // ... or the proxy's answers no longer keyed by it.
        var unkeyed = WriteGateWalk.Plugin.With("Controllers/JellyfinEnhancedController.cs", s => s.Replace(": $\"{authority.Key}:{apiPath}\";", ": $\"{jellyfinUserId}:{apiPath}\";"));
        Assert.Contains(UserCacheRegistryTests.Problems(unkeyed, registry), p => p.StartsWith("JellyfinEnhancedController._responseCache: its key builder JellyfinEnhancedController.ProxyJellyseerrRequestCore no longer keys by the person's Seerr account authority", StringComparison.Ordinal));
    }

    [Fact]
    public void AWallClockDeadlineInsideACacheOnTheMonotonicClockFails()
    {
        var registry = UserCacheRegistryTests.Registry();
        Assert.DoesNotContain(UserCacheRegistryTests.Problems(WriteGateWalk.Plugin, registry), p => p.Contains("on the wall clock", StringComparison.Ordinal));
        // Prepared facts whose settings deadline is a wall-clock instant (inside the monotonic written-state cache).
        var wall = WriteGateWalk.Plugin.With("Services/Acquire/Requests/SeerrBackend.cs", s => s.Replace("long Until, long SettingsUntil,", "long Until, DateTimeOffset SettingsUntil,"));
        Assert.Contains(UserCacheRegistryTests.Problems(wall, registry), p => p.StartsWith("SeerrBackend._prepared", StringComparison.Ordinal) && p.Contains("SettingsUntil (System.DateTimeOffset) on the wall clock", StringComparison.Ordinal));
    }
}
