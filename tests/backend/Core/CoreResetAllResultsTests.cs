using System.Security.Claims;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using Microsoft.AspNetCore.Mvc;
using Moq;
using Newtonsoft.Json.Linq;

namespace JE.Tests;

/// <summary>
/// Reset-all reports what it did per user and per document (settings, hidden content, Spoiler
/// Guard) with a partial status, names users through the GetAllUsers shim and keeps the old
/// response fields (design item A8a).
/// </summary>
[Collection("Plugin singleton")]
public class CoreResetAllResultsTests
{
    private const string SpoilerFile = "spoilerblur.json";

    private sealed class Server : IDisposable
    {
        public ApiPluginFixture Plugin { get; } = new();
        public Mock<IUserManager> Users { get; } = new();
        public UserConfigurationManager Manager => Plugin.Core.Manager;

        public string Dir(Guid user) => Path.Combine(Plugin.Core.ConfigRoot, user.ToString("N"));

        /// <summary>Registers live Jellyfin users the way the shim reads them on this target.</summary>
        public void Live(params User[] users)
        {
#if NET9_0
            Users.SetupGet(x => x.Users).Returns(users);
#else
            Users.Setup(x => x.GetUsers()).Returns(users);
#endif
        }

        /// <summary>Writes a raw file into a user's directory.</summary>
        public string File(Guid user, string name, string text)
        {
            Directory.CreateDirectory(Dir(user));
            var path = Path.Combine(Dir(user), name);
            System.IO.File.WriteAllText(path, text);
            return path;
        }

        public JObject Reset()
        {
            var maintenance = new MaintenanceModeService(Users.Object, Mock.Of<ISessionManager>(), Plugin.Core.Paths.Object, Plugin.Core.Logger);
            var controller = ApiAssetTests.Controller(Plugin.Core, Manager, Users.Object, maintenance);
            controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([
                new Claim("Jellyfin-UserId", Guid.NewGuid().ToString()), new Claim(ClaimTypes.Role, "Administrator")], "test"));
            var ok = Assert.IsType<OkObjectResult>(controller.ResetAllUsersSettings());
            return JObject.Parse(System.Text.Json.JsonSerializer.Serialize(ok.Value));
        }

        public void Dispose() => Plugin.Dispose();
    }

    private static User Person(string name) => new(name, "default", "default") { Id = Guid.NewGuid() };

    private static JObject For(JObject body, Guid user) =>
        (JObject)body["users"]!.Single(u => u.Value<string>("userId") == user.ToString("N"));

    private static string[] Ids(JObject body, string field) => body[field]!.Values<string>().ToArray()!;

    private const string SpoilerWithData = """{"Series":{"abc":{"SeriesId":"abc","EnabledAt":"2026-01-01T00:00:00Z"}},"Prefs":{"HideCast":false}}""";

    [Fact]
    public void AFailingSpoilerFileIsReportedByNameAndTheRestStillResets()
    {
        using var server = new Server();
        var alice = Person("alice");
        var bob = Person("bob");
        server.Live(alice, bob);
        server.File(alice.Id, "settings.json", "{}");
        server.File(alice.Id, SpoilerFile, SpoilerWithData);
        server.File(bob.Id, "settings.json", "{}");
        var bobSpoiler = server.File(bob.Id, SpoilerFile, "{ not json");

        var body = server.Reset();

        // Old fields, same meaning as before.
        Assert.True(body.Value<bool>("success"));
        Assert.Equal(2, body.Value<int>("userCount"));
        Assert.Equal(2, body.Value<int>("totalUsers"));
        Assert.Empty(Ids(body, "skippedSettingsUserIds"));
        Assert.Empty(Ids(body, "skippedHcUserIds"));
        // New fields: Spoiler Guard failures used to be logged only.
        Assert.Equal("partial", body.Value<string>("status"));
        Assert.Equal(1, body.Value<int>("failedUserCount"));
        Assert.Equal([bob.Id.ToString("N")], Ids(body, "skippedSpoilerUserIds"));

        var bobResult = For(body, bob.Id);
        Assert.Equal("bob", bobResult.Value<string>("name"));
        Assert.Equal("reset", bobResult.Value<string>("settings"));
        Assert.Equal("reset", bobResult.Value<string>("hiddenContent"));
        Assert.Equal("failed", bobResult.Value<string>("spoilerGuard"));
        var failure = Assert.Single(bobResult["failures"]!);
        Assert.Equal("spoilerGuard", failure.Value<string>("document"));
        Assert.Equal("corrupt", failure.Value<string>("reason"));
        // The strict reader moved the broken file aside, as it did before.
        Assert.False(System.IO.File.Exists(bobSpoiler));

        var aliceResult = For(body, alice.Id);
        Assert.Equal("alice", aliceResult.Value<string>("name"));
        Assert.Equal("reset", aliceResult.Value<string>("spoilerGuard"));
        Assert.Empty(aliceResult["failures"]!);
        // Prefs reset, the Spoiler list kept.
        var spoiler = JObject.Parse(System.IO.File.ReadAllText(Path.Combine(server.Dir(alice.Id), SpoilerFile)));
        Assert.NotNull(spoiler["Series"]!["abc"]);
        Assert.Null(spoiler["Prefs"]!["HideCast"]?.Value<bool?>());
    }

    [Fact]
    public void AnUnwritableSettingsFileAndAnOrphanDirectoryAreReported()
    {
        using var server = new Server();
        var alice = Person("alice");
        server.Live(alice);
        server.File(alice.Id, "settings.json", "{}");
        // A user directory with no live Jellyfin user, whose settings.json cannot be replaced.
        var orphan = Guid.NewGuid();
        Directory.CreateDirectory(Path.Combine(server.Dir(orphan), "settings.json"));

        var body = server.Reset();

        Assert.Equal(1, body.Value<int>("userCount"));
        Assert.Equal(2, body.Value<int>("totalUsers"));
        Assert.Equal([orphan.ToString("N")], Ids(body, "skippedSettingsUserIds"));
        Assert.Equal("partial", body.Value<string>("status"));
        var orphanResult = For(body, orphan);
        Assert.Equal(JTokenType.Null, orphanResult["name"]!.Type);
        Assert.Equal("failed", orphanResult.Value<string>("settings"));
        Assert.Equal("reset", orphanResult.Value<string>("hiddenContent"));
        // No Spoiler Guard file: nothing to reset and nothing created.
        Assert.Equal("none", orphanResult.Value<string>("spoilerGuard"));
        Assert.False(System.IO.File.Exists(Path.Combine(server.Dir(orphan), SpoilerFile)));
        var failure = Assert.Single(orphanResult["failures"]!);
        Assert.Equal("settings", failure.Value<string>("document"));
        Assert.Equal("unavailable", failure.Value<string>("reason"));
    }

    [Fact]
    public void EverythingResetIsCompleteAndNothingResetIsFailed()
    {
        using (var server = new Server())
        {
            var alice = Person("alice");
            server.Live(alice);
            server.File(alice.Id, "settings.json", "{}");
            var body = server.Reset();
            Assert.Equal("complete", body.Value<string>("status"));
            Assert.Equal(0, body.Value<int>("failedUserCount"));
            Assert.Empty(Ids(body, "skippedSpoilerUserIds"));
        }

        using (var server = new Server())
        {
            var alice = Person("alice");
            server.Live(alice);
            Directory.CreateDirectory(Path.Combine(server.Dir(alice.Id), "settings.json"));
            server.File(alice.Id, "hidden-content.json", "garbage");
            var body = server.Reset();
            Assert.Equal("failed", body.Value<string>("status"));
            Assert.Equal(0, body.Value<int>("userCount"));
            Assert.Equal([alice.Id.ToString("N")], Ids(body, "skippedHcUserIds"));
            Assert.Equal(["settings", "hiddenContent"], For(body, alice.Id)["failures"]!.Select(f => f.Value<string>("document")!).ToArray());
        }
    }

    [Fact]
    public void AConfigRootThatCannotBeListedIsAFailureNotAnEmptySuccess()
    {
        using var server = new Server();
        var alice = Person("alice");
        server.Live(alice);
        server.File(alice.Id, "settings.json", "{\"DisplayLanguage\":\"fr\"}");
        var root = server.Plugin.Core.ConfigRoot;
        // Traversable but not listable. Root (or Windows) is not stopped by this: nothing to check.
        if (OperatingSystem.IsWindows()) return;
        File.SetUnixFileMode(root, UnixFileMode.UserExecute);
        JObject body;
        try
        {
            if (CanList(root)) return;
            Assert.False(server.Manager.TryGetAllUserIds(out var ids));
            Assert.Empty(ids);
            Assert.Empty(server.Manager.GetAllUserIds());
            body = server.Reset();
        }
        finally
        {
            File.SetUnixFileMode(root, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }

        Assert.False(body.Value<bool>("success"));
        Assert.Equal("failed", body.Value<string>("status"));
        Assert.Equal("user-folders-unreadable", body.Value<string>("error"));
        Assert.Equal(0, body.Value<int>("userCount"));
        Assert.Equal(0, body.Value<int>("totalUsers"));
        Assert.Empty(body["users"]!);
        Assert.Equal("{\"DisplayLanguage\":\"fr\"}", System.IO.File.ReadAllText(Path.Combine(server.Dir(alice.Id), "settings.json")));

        // With the permission back, the same root lists its user again.
        Assert.True(server.Manager.TryGetAllUserIds(out var listed));
        Assert.Single(listed);
    }

    [Fact]
    public void NoUserFoldersIsACompleteRunWithNothingToReset()
    {
        using var server = new Server();
        server.Live(Person("alice"));

        var body = server.Reset();

        Assert.True(body.Value<bool>("success"));
        Assert.Equal("complete", body.Value<string>("status"));
        Assert.Equal(0, body.Value<int>("totalUsers"));
        Assert.Null(body["error"]);
    }

    private static bool CanList(string dir)
    {
        try { Directory.GetDirectories(dir); return true; }
        catch (UnauthorizedAccessException) { return false; }
    }

    [Fact]
    public void AFailingUserListOnlyCostsTheNames()
    {
        using var server = new Server();
#if NET9_0
        server.Users.SetupGet(x => x.Users).Throws(new InvalidOperationException("user store down"));
#else
        server.Users.Setup(x => x.GetUsers()).Throws(new InvalidOperationException("user store down"));
#endif
        var user = Guid.NewGuid();
        server.File(user, "settings.json", "{}");

        var body = server.Reset();

        Assert.Equal("complete", body.Value<string>("status"));
        Assert.Equal(1, body.Value<int>("userCount"));
        Assert.Equal(JTokenType.Null, For(body, user)["name"]!.Type);
        Assert.Equal("reset", For(body, user).Value<string>("settings"));
    }
}
