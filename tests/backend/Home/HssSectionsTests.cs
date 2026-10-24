using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Home;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;
using Moq;
using Newtonsoft.Json.Linq;

namespace JE.Tests;

/// <summary>
/// Phase 4d: the home rows as Home Screen Sections sections (registration payloads HSS reads by name, results only for
/// the signed-in person HSS asks for) and the home routes (own rows, administrators' strip).
/// </summary>
[Collection("Plugin singleton")]
public class HssSectionsTests
{
    [Fact]
    public async Task MissingOrRefusingRegistrationFallsBackAndOnlyAllThreeSuccessfulRowsCount()
    {
        var c = new Jellyfin.Plugin.JellyfinEnhanced.Configuration.PluginConfiguration
        {
            ArrIntegrationEnabled = true, ArrPhase1Enabled = true, ArrPhase3Enabled = true, ArrPhase4Enabled = true,
            ArrPhase4HomeRowsEnabled = true, ArrPhase4HssSectionsEnabled = true, NativeAbsentDetailsEnabled = true,
            JellyseerrEnabled = true, JellyseerrUrls = "http://seerr.test", JellyseerrApiKey = "lab-key",
        };
        var missing = new HssSectionsAdapter(null, () => c, () => null);
        missing.RegisterIfOn();
        Assert.False(missing.Registered);
        var calls = 0;
        var failing = new HssSectionsAdapter(null, () => c, () => _ => { calls++; throw new InvalidOperationException("HSS unavailable"); });
        failing.RegisterIfOn();
        Assert.False(failing.Registered);
        Assert.False(HssSectionsAdapter.Present);
        var success = new HssSectionsAdapter(null, () => c, () => _ => calls++);
        calls = 0;
        success.RegisterIfOn();
#if NET9_0
        Assert.Equal(0, calls);
        Assert.False(success.Registered);
#else
        Assert.Equal(3, calls);
        Assert.True(success.Registered);
        Assert.True(HssSectionsAdapter.Present);
        success.RegisterIfOn();
        Assert.Equal(3, calls);
#endif
        await success.StopAsync(default);
        Assert.False(HssSectionsAdapter.Present);
    }

    [Fact]
    public void TheRegistrationNamesAResultsMethodHssCanCallWithItsPayload()
    {
        var payloads = HssSectionsAdapter.Payloads();
        Assert.Equal(new[] { "JellyfinEnhancedYourRequests", "JellyfinEnhancedComingSoon", "JellyfinEnhancedJustArrived" }, payloads.Select(p => (string)p["id"]!));
        Assert.Equal(new[] { "requests", "soon", "arrived" }, payloads.Select(p => (string)p["additionalData"]!));
        foreach (var p in payloads)
        {
            // HSS finds the class by its assembly's full name and type name, then the method by name, and converts its
            // own payload (UserId, AdditionalData) to the method's single parameter.
            var type = AppDomain.CurrentDomain.GetAssemblies().Single(a => a.FullName == (string)p["resultsAssembly"]!).GetType((string)p["resultsClass"]!)!;
            var method = type.GetMethod((string)p["resultsMethod"]!)!;
            var parameter = Assert.Single(method.GetParameters()).ParameterType;
            var converted = (HssSectionPayload)JObject.FromObject(new { UserId = Guid.Parse("c799f011-678d-4423-bd7c-07d24c672de8"), AdditionalData = "soon" }).ToObject(parameter)!;
            Assert.Equal((Guid.Parse("c799f011678d4423bd7c07d24c672de8"), "soon"), (converted.UserId, converted.AdditionalData));
            Assert.Equal(typeof(MediaBrowser.Model.Querying.QueryResult<MediaBrowser.Model.Dto.BaseItemDto>), method.ReturnType);
        }
        Assert.False(HssSectionsAdapter.Present);   // not installed in the tests: nothing registers
    }

    [Fact]
    public async Task ARowOnlyAnswersTheSignedInPersonHssAsksFor()
    {
        using var lab = new IntegrationRequestArrivalsTests.Lab();
        var c = lab.Config;
        c.ArrPhase4Enabled = true;
        c.ArrPhase4HomeRowsEnabled = true;
        c.ArrPhase4HssSectionsEnabled = true;
        c.NativeAbsentDetailsEnabled = true;
        c.JellyseerrEnabled = true;
        c.JellyseerrUrls = "http://seerr.test";
        c.JellyseerrApiKey = "lab-key";
        c.TMDB_API_KEY = "lab-tmdb"; // A1: the lab runs Jellyfin Enhanced mode, whose native pages read TMDB
        await lab.Warm();
        await lab.Ask(lab.Emma, new MutationInput { Key = "movie:tmdb:603" });
        await lab.Ask(lab.Kid, new MutationInput { Key = "tv:tvdb:78874", Scope = "seasons", Seasons = new[] { 2 } });
        await lab.Outbox.TickAsync(default);
        var home = HomeRowsTests.Projection(lab.Hub, null, lab.Db, () => lab.Config);
        var users = new Mock<IUserManager>();
        var http = new HttpContextAccessor { HttpContext = new DefaultHttpContext() };
        var services = new ServiceCollection().AddSingleton(home).AddSingleton<IHttpContextAccessor>(http).AddSingleton(users.Object).AddSingleton(new Mock<ILibraryManager>().Object).AddSingleton(new Mock<MediaBrowser.Controller.Dto.IDtoService>().Object).BuildServiceProvider();
        var results = new HssSectionResults(services);

        // HSS takes the user from its query string: someone else (the Kid, who has a row of their own) asking for Emma's
        // row gets nothing, neither hers nor theirs (nothing is read).
        http.HttpContext!.User = TestCallers.Principal(lab.Kid.UserId, admin: false);
        Assert.Empty(results.GetResults(new HssSectionPayload { UserId = lab.Emma.UserId, AdditionalData = "requests" }).Items);
        http.HttpContext.User = TestCallers.ApiKey();
        Assert.Empty(results.GetResults(new HssSectionPayload { UserId = lab.Emma.UserId, AdditionalData = "requests" }).Items);
        users.Verify(u => u.GetUserById(It.IsAny<Guid>()), Times.Never);

        // Emma herself gets to her cards (the item lookup is the next step), an unknown row nothing.
        http.HttpContext.User = TestCallers.Principal(lab.Emma.UserId, admin: false);
        Assert.Empty(results.GetResults(new HssSectionPayload { UserId = lab.Emma.UserId, AdditionalData = "nope" }).Items);
        users.Verify(u => u.GetUserById(It.IsAny<Guid>()), Times.Never);
        results.GetResults(new HssSectionPayload { UserId = lab.Emma.UserId, AdditionalData = "requests" });
#if NET9_0
        users.Verify(u => u.GetUserById(It.IsAny<Guid>()), Times.Never);       // 10.11: never on (no native pages)
#else
        users.Verify(u => u.GetUserById(lab.Emma.UserId), Times.AtLeastOnce());

        // Switched off: nothing, even for her.
        users.Invocations.Clear();
        c.ArrPhase4HssSectionsEnabled = false;
        Assert.Empty(results.GetResults(new HssSectionPayload { UserId = lab.Emma.UserId, AdditionalData = "requests" }).Items);
        users.Verify(u => u.GetUserById(It.IsAny<Guid>()), Times.Never);
#endif
    }

    [Fact]
    public async Task TheHomeRouteIsAPersonsOwnAndOffUnlessTheRowsAreOn()
    {
        using var lab = new IntegrationRequestArrivalsTests.Lab();
        await lab.Warm();
        var home = HomeRowsTests.Projection(lab.Hub, null, lab.Db, () => lab.Config);
        AcquireHomeController Controller(System.Security.Claims.ClaimsPrincipal who)
        {
            var controller = new AcquireHomeController(home, null!) { ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() } };
            controller.HttpContext.User = who;
            return controller;
        }
        Assert.Equal(403, ((ObjectResult)await Controller(TestCallers.ApiKey()).GetHome(default)).StatusCode);
        Assert.Equal(404, ((ObjectResult)await Controller(TestCallers.Principal(lab.Emma.UserId, false)).GetHome(default)).StatusCode);
        lab.Config.ArrPhase4Enabled = true;
        lab.Config.ArrPhase4HomeRowsEnabled = true;
        var ok = Controller(TestCallers.Principal(lab.Emma.UserId, false));
        Assert.IsType<FileContentResult>(await ok.GetHome(default));
        Assert.Equal("private, no-cache", ok.Response.Headers.CacheControl.ToString());
        var etag = ok.Response.Headers.ETag.ToString();
        var again = Controller(TestCallers.Principal(lab.Emma.UserId, false));
        again.Request.Headers.IfNoneMatch = etag;
        Assert.Equal(304, ((StatusCodeResult)await again.GetHome(default)).StatusCode);
        // The strip: a member is refused before anything else; an administrator gets 404 while it's off.
        Assert.IsType<ForbidResult>(await Controller(TestCallers.Principal(lab.Emma.UserId, false)).GetOps(default));
        Assert.Equal(404, ((ObjectResult)await Controller(TestCallers.Principal(lab.Admin.UserId, true)).GetOps(default)).StatusCode);
    }

    [Theory]
    [InlineData("demoted")]
    [InlineData("deleted")]
    [InlineData("preference")]
    [InlineData("flag")]
    public async Task TheOpsStripRechecksItsViewerAndDisplayChoiceAfterTheOverviewWait(string change)
    {
        using var lab = new IntegrationRequestArrivalsTests.Lab();
        lab.Config.ArrPhase2Enabled = true;
        lab.Config.ArrPhase4Enabled = true;
        lab.Config.ArrPhase4HomeRowsEnabled = true;
        lab.Config.ArrPhase4HomeOpsStripEnabled = true;
        var prefs = new HomeRowsTests.Prefs();
        var home = HomeRowsTests.Projection(lab.Hub, null, lab.Db, () => lab.Config, prefs);
        using var bridge = new JellyfinBridge(lab.Store, new FakeLibraryAccess(), null, () => lab.Config, () => lab.Arr.Now, null);
        var admin = new ArrAdminHubService(lab.Store, bridge, lab.Model, null, null, () => lab.Config, () => lab.Arr.Now);
        var changed = false;
        foreach (var host in lab.Arr.Hosts.Values) host.Before = async (path, ct) =>
        {
            await Task.Yield();
            if (changed || !path.EndsWith("/diskspace", StringComparison.Ordinal)) return;
            changed = true;
            if (change == "demoted") lab.View.Users[lab.Admin.UserId] = new StatusViewer { UserId = lab.Admin.UserId, PolicyRevision = "member" };
            if (change == "deleted") lab.View.Users.Remove(lab.Admin.UserId);
            if (change == "preference") prefs.By[lab.Admin.UserId] = new HomePreferences(null, null, null, false);
            if (change == "flag") lab.Config.ArrPhase4HomeOpsStripEnabled = false;
        };
        var controller = new AcquireHomeController(home, admin) { ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext() } };
        controller.HttpContext.User = TestCallers.Principal(lab.Admin.UserId, true);
        var result = await controller.GetOps(default);
        Assert.True(changed);
        if (change is "demoted" or "deleted") Assert.IsType<ForbidResult>(result);
        else Assert.Equal(404, Assert.IsAssignableFrom<ObjectResult>(result).StatusCode);
    }

    [Fact]
    public void TheStripIsActionableOnlyWhenSomethingNeedsDoing()
    {
        static System.Text.Json.JsonElement Counts(AdminOverview o) => System.Text.Json.JsonSerializer.SerializeToElement(AcquireHomeController.Ops(o));
        var quiet = Counts(new AdminOverview { Downloading = 6 });
        Assert.Equal((false, 6), (quiet.GetProperty("actionable").GetBoolean(), quiet.GetProperty("downloading").GetInt32()));
        var blocked = Counts(new AdminOverview
        {
            Downloading = 2,
            NeedsAttention = new[] { new AttentionItem { Code = AttentionCode.ImportBlocked }, new AttentionItem { Code = AttentionCode.DownloadWarning } },
        });
        Assert.Equal((true, 1, 2), (blocked.GetProperty("actionable").GetBoolean(), blocked.GetProperty("importBlocked").GetInt32(), blocked.GetProperty("attention").GetInt32()));
        var disks = Counts(new AdminOverview
        {
            Instances = new[]
            {
                new AdminInstanceCard { Disks = new[] { new AdminDisk { Path = "/movies4k", UsedPercent = 94, Low = true }, new AdminDisk { Path = "/movies", UsedPercent = 40 } } },
                new AdminInstanceCard { Disks = new[] { new AdminDisk { Path = "/movies4k", UsedPercent = 94, Low = true }, new AdminDisk { Path = "/gone", UsedPercent = 99, Low = true, Accessible = false } } },
            },
        });
        Assert.True(disks.GetProperty("actionable").GetBoolean());
        var disk = Assert.Single(disks.GetProperty("disks").EnumerateArray());
        Assert.Equal(("/movies4k", 94), (disk.GetProperty("name").GetString(), disk.GetProperty("usedPercent").GetInt32()));
    }
}
