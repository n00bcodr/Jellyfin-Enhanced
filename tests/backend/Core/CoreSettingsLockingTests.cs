using System.Net;
using System.Security.Claims;
using System.Text;
using System.Text.Encodings.Web;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Moq;
using Newtonsoft.Json.Linq;

namespace JE.Tests;

/// <summary>
/// settings.json writers share one per-file lock (the POST, the first-access seed and
/// reset-all), the POST has a 64 KB body cap, and path resolution is pure: reads never create
/// a user directory, writes create it on demand (design items A2 and A4).
/// </summary>
[Collection("Plugin singleton")]
public class CoreSettingsLockingTests
{
    private static readonly Guid UserA = Guid.Parse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    private static readonly TimeSpan Blocked = TimeSpan.FromMilliseconds(300);
    private static readonly TimeSpan Done = TimeSpan.FromSeconds(10);

    private sealed class Endpoints : IDisposable
    {
        public ApiPluginFixture Plugin { get; } = new();
        public UserConfigurationManager Manager => Plugin.Core.Manager;
        public string UserDir(Guid user) => Path.Combine(Plugin.Core.ConfigRoot, user.ToString("N"));
        public string SettingsPath(Guid user) => Path.Combine(UserDir(user), "settings.json");

        /// <summary>A fresh controller signed in as <paramref name="user"/>; one per thread in the concurrent tests.</summary>
        public JellyfinEnhancedController Controller(Guid user, bool admin = false)
        {
            var maintenance = new MaintenanceModeService(Mock.Of<IUserManager>(), Mock.Of<ISessionManager>(), Plugin.Core.Paths.Object, Plugin.Core.Logger);
            var controller = ApiAssetTests.Controller(Plugin.Core, Manager, Mock.Of<IUserManager>(), maintenance);
            controller.HttpContext.User = Principal(user, admin);
            return controller;
        }

        public void Dispose() => Plugin.Dispose();
    }

    private static ClaimsPrincipal Principal(Guid user, bool admin = false) => new(new ClaimsIdentity([
        new Claim("Jellyfin-UserId", user.ToString()), new Claim(ClaimTypes.Role, admin ? "Administrator" : "User")], "test"));

    /// <summary>A document a user would post: the admin defaults with a few keys changed, so it never equals the seed.</summary>
    private static UserSettings Posted(int marker) => new()
    {
        AutoPipEnabled = true,
        SubtitleVerticalPosition = 10 + (marker % 80),
        DisplayLanguage = "posted-" + marker,
    };

    private static JObject Typed(object value) => JObject.Parse(System.Text.Json.JsonSerializer.Serialize(value));

    private static JObject OnDisk(string path) => Typed(Newtonsoft.Json.JsonConvert.DeserializeObject<UserSettings>(File.ReadAllText(path))!);

    private static void AssertOk(IActionResult result) => Assert.IsType<OkObjectResult>(result);

    /// <summary>
    /// Holds a per-file lock on a dedicated thread (Monitor is thread-affine, so an async test
    /// cannot hold it across awaits) until <see cref="Release"/>, optionally running one more
    /// action while still holding it.
    /// </summary>
    private sealed class HeldLock : IDisposable
    {
        private readonly ManualResetEventSlim release = new();
        private readonly Thread thread;
        private Action? whileHeld;
        private Exception? failure;

        public HeldLock(object gate)
        {
            using var entered = new ManualResetEventSlim();
            thread = new Thread(() =>
            {
                Monitor.Enter(gate);
                try
                {
                    entered.Set();
                    release.Wait();
                    whileHeld?.Invoke();
                }
                catch (Exception ex)
                {
                    failure = ex;
                }
                finally
                {
                    Monitor.Exit(gate);
                }
            });
            thread.Start();
            entered.Wait();
        }

        /// <summary>Runs <paramref name="beforeExit"/> under the lock, then releases it.</summary>
        public void Release(Action? beforeExit = null)
        {
            whileHeld = beforeExit;
            release.Set();
            thread.Join();
            if (failure != null) throw new InvalidOperationException("Action under the held lock failed", failure);
        }

        public void Dispose()
        {
            release.Set();
            thread.Join();
            release.Dispose();
        }
    }

    /// <summary>True when <paramref name="task"/> is still running after <see cref="Blocked"/>.</summary>
    private static async Task<bool> StillWaiting(Task task) => await Task.WhenAny(task, Task.Delay(Blocked)) != task;

    [Theory]
    [InlineData("post")]
    [InlineData("seed")]
    [InlineData("reset")]
    public async Task SettingsWritersWaitForThePerFileLock(string writer)
    {
        using var endpoints = new Endpoints();
        var path = endpoints.SettingsPath(UserA);
        if (writer != "seed")
        {
            endpoints.Manager.SaveUserConfiguration(UserA.ToString("N"), "settings.json", Posted(1));
        }
        var before = File.Exists(path) ? File.ReadAllText(path) : null;
        Func<IActionResult> run = writer switch
        {
            "post" => () => endpoints.Controller(UserA).SaveUserSettingsSettings(UserA.ToString(), Posted(2)),
            "seed" => () => endpoints.Controller(UserA).GetUserSettingsSettings(UserA.ToString()),
            _ => () => endpoints.Controller(UserA, admin: true).ResetAllUsersSettings(),
        };

        // Any spelling of the user id maps to the same lock.
        using var held = new HeldLock(endpoints.Manager.GetUserFileLock(UserA.ToString("D").ToUpperInvariant(), "settings.json"));
        var task = Task.Run(run);
        Assert.True(await StillWaiting(task), $"{writer} finished while another writer held the settings.json lock");
        Assert.Equal(before, File.Exists(path) ? File.ReadAllText(path) : null);
        held.Release();

        AssertOk(await task.WaitAsync(Done));
        Assert.NotEqual(before, File.ReadAllText(path));
    }

    [Fact]
    public async Task SeedChecksAgainUnderTheLockAndNeverOverwritesASaveThatWonTheRace()
    {
        using var endpoints = new Endpoints();
        using var held = new HeldLock(endpoints.Manager.GetUserFileLock(UserA.ToString("N"), "settings.json"));
        // The GET finds no file and waits for the lock to seed; a POST lands first.
        var get = Task.Run(() => endpoints.Controller(UserA).GetUserSettingsSettings(UserA.ToString()));
        Assert.True(await StillWaiting(get));
        IActionResult? post = null;
        held.Release(() => post = endpoints.Controller(UserA).SaveUserSettingsSettings(UserA.ToString(), Posted(7)));
        AssertOk(post!);

        var served = Typed(Assert.IsType<OkObjectResult>(await get.WaitAsync(Done)).Value!);
        served.Remove("IsAdmin");
        Assert.True(JToken.DeepEquals(Typed(Posted(7)), served));
        Assert.True(JToken.DeepEquals(Typed(Posted(7)), OnDisk(endpoints.SettingsPath(UserA))));
    }

    [Fact]
    public async Task ConcurrentFirstGetAndPostAlwaysKeepThePost()
    {
        using var endpoints = new Endpoints();
        for (var i = 0; i < 100; i++)
        {
            var user = Guid.NewGuid();
            var getter = endpoints.Controller(user);
            var poster = endpoints.Controller(user);
            var posted = Posted(i);
            using var start = new Barrier(2);
            var get = Task.Run(() => { start.SignalAndWait(); return getter.GetUserSettingsSettings(user.ToString()); });
            var post = Task.Run(() => { start.SignalAndWait(); return poster.SaveUserSettingsSettings(user.ToString(), posted); });
            var results = await Task.WhenAll(get, post).WaitAsync(Done);
            Assert.All(results, AssertOk);
            // Whichever ran first, the user's explicit save is what stays on disk.
            Assert.True(JToken.DeepEquals(Typed(Posted(i)), OnDisk(endpoints.SettingsPath(user))), $"iteration {i}: the seed overwrote the POST");
        }
    }

    [Fact]
    public async Task ConcurrentPostAndResetLeaveOneWholeDocument()
    {
        using var endpoints = new Endpoints();
        var path = endpoints.SettingsPath(UserA);
        var defaults = Typed(UserSettings.FromAdminDefaults(endpoints.Plugin.Plugin.Configuration));
        var poster = endpoints.Controller(UserA);
        var admin = endpoints.Controller(UserA, admin: true);
        for (var i = 0; i < 50; i++)
        {
            endpoints.Manager.SaveUserConfiguration(UserA.ToString("N"), "settings.json", Posted(1000 + i));
            var posted = Posted(i);
            using var start = new Barrier(2);
            var post = Task.Run(() => { start.SignalAndWait(); return poster.SaveUserSettingsSettings(UserA.ToString(), posted); });
            var reset = Task.Run(() => { start.SignalAndWait(); return admin.ResetAllUsersSettings(); });
            var results = await Task.WhenAll(post, reset).WaitAsync(Done);
            AssertOk(results[0]);
            var resetBody = Typed(Assert.IsType<OkObjectResult>(results[1]).Value!);
            Assert.Empty(resetBody["skippedSettingsUserIds"]!);
            var stored = OnDisk(path);
            Assert.True(JToken.DeepEquals(stored, Typed(Posted(i))) || JToken.DeepEquals(stored, defaults), $"iteration {i}: {stored}");
        }
        Assert.Empty(Directory.GetFiles(endpoints.UserDir(UserA), "*.tmp.*"));
    }

    [Fact]
    public void LegacyPostDeclaresThe64KbBodyCap()
    {
        var limit = typeof(JellyfinEnhancedController).GetMethod(nameof(JellyfinEnhancedController.SaveUserSettingsSettings))!
            .GetCustomAttributes(typeof(RequestSizeLimitAttribute), false).Cast<Microsoft.AspNetCore.Http.Metadata.IRequestSizeLimitMetadata>().Single();
        Assert.Equal(64L * 1024, limit.MaxRequestBodySize);
    }

    private sealed class SettingsActivator(Endpoints endpoints) : IControllerActivator
    {
        public object Create(ControllerContext context)
        {
            var controller = endpoints.Controller(UserA);
            controller.ControllerContext = context;
            return controller;
        }
        public void Release(ControllerContext context, object controller) { }
    }

    private sealed class UserAAuthentication(IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger, UrlEncoder encoder)
        : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
    {
        protected override Task<AuthenticateResult> HandleAuthenticateAsync()
            => Task.FromResult(AuthenticateResult.Success(new AuthenticationTicket(Principal(UserA), "test")));
    }

    /// <summary>Real Kestrel on loopback: the size cap is enforced by the server's max-body-size feature.</summary>
    private static async Task<(WebApplication App, HttpClient Client)> Serve(Endpoints endpoints)
    {
        var builder = WebApplication.CreateBuilder();
        builder.WebHost.UseKestrel().UseUrls("http://127.0.0.1:0");
        builder.Logging.ClearProviders();
        builder.Services.AddAuthentication("test").AddScheme<AuthenticationSchemeOptions, UserAAuthentication>("test", _ => { });
        builder.Services.AddAuthorization();
        builder.Services.AddControllers().AddApplicationPart(typeof(JellyfinEnhancedController).Assembly);
        builder.Services.AddSingleton<IControllerActivator>(new SettingsActivator(endpoints));
        var app = builder.Build();
        app.UseRouting();
        app.UseAuthentication();
        app.UseAuthorization();
        app.MapControllers();
        await app.StartAsync();
        var address = app.Urls.First();
        return (app, new HttpClient { BaseAddress = new Uri(address) });
    }

    [Fact]
    public async Task OversizedSettingsPostIsRejectedAndLeavesTheFileAlone()
    {
        using var endpoints = new Endpoints();
        var (app, client) = await Serve(endpoints);
        await using var _ = app;
        using var __ = client;
        var url = $"/JellyfinEnhanced/user-settings/{UserA}/settings.json";

        // A whole document (about 3 KB) is accepted.
        var whole = System.Text.Json.JsonSerializer.Serialize(Posted(3));
        using (var ok = await client.PostAsync(url, new StringContent(whole, Encoding.UTF8, "application/json")))
        {
            Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
        }
        var stored = File.ReadAllText(endpoints.SettingsPath(UserA));

        // Just over 64 KB, as one valid JSON document: rejected while the body is read, before
        // the action runs. Plain Kestrel answers 413; inside Jellyfin, its ExceptionMiddleware
        // turns the same BadHttpRequestException into a 500 (seen in the lab).
        var padded = JObject.Parse(whole);
        padded["DisplayLanguage"] = new string('x', 64 * 1024);
        using (var tooLarge = await client.PostAsync(url, new StringContent(padded.ToString(), Encoding.UTF8, "application/json")))
        {
            Assert.True((int)tooLarge.StatusCode is 400 or 413, $"oversized POST returned {(int)tooLarge.StatusCode}");
        }
        Assert.Equal(stored, File.ReadAllText(endpoints.SettingsPath(UserA)));
    }

    [Fact]
    public void ReadsLeaveNoPhantomUserDirectories()
    {
        using var endpoints = new Endpoints();
        var stranger = Guid.NewGuid();
        var id = stranger.ToString("N");
        var manager = endpoints.Manager;

        Assert.False(manager.UserConfigurationExists(id, "settings.json"));
        Assert.Equal(5, manager.GetUserConfiguration<UserSettings>(id, "settings.json").PauseScreenDelaySeconds);
        Assert.Equal(5, manager.GetUserConfigurationStrict<UserSettings>(id, "settings.json").PauseScreenDelaySeconds);
        Assert.Equal(5, manager.GetUserConfigurationStrict<UserSettings>(id, "settings.json", quarantineCorrupt: false).PauseScreenDelaySeconds);
        Assert.Null(manager.TryReadUserConfigurationText(id, "settings.json"));
        Assert.Empty(manager.GetProcessedWatchlistItems(stranger).Items);
        var controller = endpoints.Controller(stranger);
        AssertOk(controller.GetUserSettingsShortcuts(stranger.ToString()));
        AssertOk(controller.GetUserSettingsElsewhere(stranger.ToString()));

        Assert.False(Directory.Exists(endpoints.UserDir(stranger)));
        Assert.Empty(manager.GetAllUserIds());
        // Reset-all walks user directories, so a reader is never reset (or seeded) as a user.
        var reset = Typed(Assert.IsType<OkObjectResult>(endpoints.Controller(UserA, admin: true).ResetAllUsersSettings()).Value!);
        Assert.Equal(0, reset.Value<int>("totalUsers"));
        Assert.False(Directory.Exists(endpoints.UserDir(stranger)));
    }

    [Fact]
    public void WritesCreateTheUserDirectoryOnDemand()
    {
        using var endpoints = new Endpoints();

        // First POST for a user without a directory.
        var poster = Guid.NewGuid();
        AssertOk(endpoints.Controller(poster).SaveUserSettingsSettings(poster.ToString(), Posted(4)));
        Assert.True(JToken.DeepEquals(Typed(Posted(4)), OnDisk(endpoints.SettingsPath(poster))));

        // First GET seeds the admin defaults.
        var reader = Guid.NewGuid();
        AssertOk(endpoints.Controller(reader).GetUserSettingsSettings(reader.ToString()));
        Assert.True(JToken.DeepEquals(Typed(UserSettings.FromAdminDefaults(endpoints.Plugin.Plugin.Configuration)), OnDisk(endpoints.SettingsPath(reader))));

        // Background writers that never read first: a plain save and a locked read-modify-write.
        var background = Guid.NewGuid();
        endpoints.Manager.SaveProcessedWatchlistItems(background, new ProcessedWatchlistItems());
        Assert.True(File.Exists(Path.Combine(endpoints.UserDir(background), "processed-watchlist-items.json")));
        var watcher = Guid.NewGuid();
        Assert.True(endpoints.Manager.MarkWatchlistItemProcessed(watcher, 603, "movie", "test"));
        Assert.Equal(603, Assert.Single(endpoints.Manager.GetProcessedWatchlistItems(watcher).Items).TmdbId);

        Assert.Equal(
            new[] { poster, reader, background, watcher }.Select(u => u.ToString("N")).OrderBy(u => u),
            endpoints.Manager.GetAllUserIds().OrderBy(u => u));
        foreach (var user in new[] { poster, reader, background, watcher })
        {
            Assert.Empty(Directory.GetFiles(endpoints.UserDir(user), "*.tmp.*"));
        }
    }
}
