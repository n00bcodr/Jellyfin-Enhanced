using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Features.HiddenContent;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Platform;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Settings;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Maintenance;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using Microsoft.AspNetCore.Mvc;
using Moq;

namespace JE.Tests.Features.Platform;

// The client saves hidden-content.json and shortcuts.json whole, so whatever the bootstrap or the
// standalone GET answers becomes the next save. A stored list that cannot be read must be reported
// as failed (null in the bootstrap, an error from the endpoint), never as an empty list.
// Upstream: tests/backend/Api/ApiUserDocumentReadTests.cs (n00bcodr/Jellyfin-Enhanced 7649dda9).
[Collection("Plugin singleton")]
public class ApiUserDocumentReadTests
{
    private const string Kept = "{\"Items\":{\"kept\":{\"ItemId\":\"kept\",\"Name\":\"Kept\"}},\"Settings\":{\"FilterSearch\":true}}";
    private const string Broken = "{\"Items\":{\"kept\":";

    private sealed record Controllers(JePlatformController Platform, JeHiddenContentController Hidden, JeSettingsController Settings, string User);

    private static Controllers Build(ApiPluginFixture f, Guid user)
    {
        var maintenance = new MaintenanceModeService(Mock.Of<IUserManager>(), Mock.Of<ISessionManager>(), f.Core.Paths.Object, f.Core.Logger);
        var platform = ApiAssetTests.Controller(f.Core, maintenance, f.Core.Manager);
        platform.HttpContext.User = global::JE.Tests.Features.SpoilerGuard.PrivacyPolicyTests.Principal(user, false);
        return new Controllers(platform,
            ApiAssetTests.Sibling<JeHiddenContentController>(platform, f.Core, f.Core.Manager, Mock.Of<IUserManager>()),
            ApiAssetTests.Sibling<JeSettingsController>(platform, f.Core, f.Core.Manager),
            user.ToString("N"));
    }

    private static string Store(ApiPluginFixture f, Guid user, string file, string text)
    {
        var directory = Path.Combine(f.Core.ConfigRoot, user.ToString("N"));
        Directory.CreateDirectory(directory);
        var path = Path.Combine(directory, file);
        File.WriteAllText(path, text);
        return path;
    }

    private static JsonElement UserSettings(Controllers c)
    {
        var body = Assert.IsType<JsonResult>(c.Platform.GetBootstrap()).Value;
        return JsonDocument.Parse(JsonSerializer.Serialize(body)).RootElement.GetProperty("UserSettings");
    }

    private static IActionResult Get(Controllers c, string file)
        => file == "shortcuts.json" ? c.Settings.GetUserSettingsShortcuts(c.User) : c.Hidden.GetUserHiddenContent(c.User);

    [Theory]
    [InlineData("hidden-content.json", "HiddenContent")]
    [InlineData("shortcuts.json", "Shortcuts")]
    public void ReadErrorIsReportedAndLeavesTheStoredListAlone(string file, string bootstrapKey)
    {
        using var f = new ApiPluginFixture();
        var user = Guid.NewGuid();
        var path = Store(f, user, file, Kept);
        var c = Build(f, user);

        // Held exclusively, as an antivirus scan or a network share can hold it: the read fails.
        using (new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None))
        {
            Assert.Equal(JsonValueKind.Null, UserSettings(c).GetProperty(bootstrapKey).ValueKind);
            Assert.Equal(500, Assert.IsAssignableFrom<ObjectResult>(Get(c, file)).StatusCode);
        }

        // A read error can pass: the file stays where it is, as it was.
        Assert.Equal(Kept, File.ReadAllText(path));
        Assert.Empty(Directory.GetFiles(Path.GetDirectoryName(path)!, file + ".corrupt-*"));
        Assert.NotEqual(JsonValueKind.Null, UserSettings(c).GetProperty(bootstrapKey).ValueKind);
    }

    [Theory]
    [InlineData("hidden-content.json", "HiddenContent")]
    [InlineData("shortcuts.json", "Shortcuts")]
    public void UnparseableListIsReportedOnceThenSetAsideLikeASaveDoes(string file, string bootstrapKey)
    {
        using var f = new ApiPluginFixture();
        var user = Guid.NewGuid();
        var path = Store(f, user, file, Broken);
        var c = Build(f, user);

        Assert.Equal(JsonValueKind.Null, UserSettings(c).GetProperty(bootstrapKey).ValueKind);

        // Content that does not parse never will: it is kept aside, as the save path already does,
        // so the next read starts from the defaults instead of failing on every page load.
        Assert.False(File.Exists(path));
        Assert.Equal(Broken, File.ReadAllText(Assert.Single(Directory.GetFiles(Path.GetDirectoryName(path)!, file + ".corrupt-*"))));
        Assert.IsType<OkObjectResult>(Get(c, file));
    }

    // Here the strict read takes the file's lock before it reads (upstream reads once without it and again under
    // it), so what is moved aside is always what that read found. A read that waited for the lock while the file was
    // replaced, and then cannot open it, says nothing about its content and leaves it where it is.
    [Theory]
    [InlineData("hidden-content.json")]
    [InlineData("shortcuts.json")]
    public void AReadThatWaitedForTheLockAndCannotOpenTheFileLeavesItWhereItIs(string file)
    {
        using var f = new ApiPluginFixture();
        var user = Guid.NewGuid();
        var path = Store(f, user, file, Broken);
        var c = Build(f, user);
        IActionResult? answer = null;
        var reader = new Thread(() => answer = Get(c, file));
        var fileLock = f.Core.Manager.GetUserFileLock(c.User, file);
        FileStream? held = null;
        Monitor.Enter(fileLock);
        try
        {
            reader.Start();
            Assert.True(SpinWait.SpinUntil(() => (reader.ThreadState & ThreadState.WaitSleepJoin) != 0, TimeSpan.FromSeconds(10)));
            // Meanwhile the file holds a good list again, and something holds it open (an antivirus scan).
            File.WriteAllText(path, Kept);
            held = new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None);
        }
        finally
        {
            Monitor.Exit(fileLock);
        }
        try
        {
            Assert.True(reader.Join(TimeSpan.FromSeconds(10)));
        }
        finally
        {
            held?.Dispose();
        }

        Assert.Equal(500, Assert.IsAssignableFrom<ObjectResult>(answer).StatusCode);
        Assert.Equal(Kept, File.ReadAllText(path));
        Assert.Empty(Directory.GetFiles(Path.GetDirectoryName(path)!, file + ".corrupt-*"));
    }

    // The read and moving the file aside happen under the file's lock, so a save that replaces the file in
    // between could have its list moved aside. Every writer of the two files takes the lock.
    [Fact]
    public void ShortcutsSaveWaitsForTheFileLock()
    {
        using var f = new ApiPluginFixture();
        var user = Guid.NewGuid();
        var c = Build(f, user);
        var shortcuts = new UserShortcuts();
        shortcuts.Shortcuts.Add(new Shortcut { Name = "GoToHome", Key = "Q" });
        IActionResult? answer = null;
        var saver = new Thread(() => answer = c.Settings.SaveUserSettingsShortcuts(c.User, shortcuts));
        lock (f.Core.Manager.GetUserFileLock(c.User, "shortcuts.json"))
        {
            saver.Start();
            Assert.False(saver.Join(TimeSpan.FromMilliseconds(500)), "the save waits while the lock is held");
            Assert.False(File.Exists(Path.Combine(f.Core.ConfigRoot, c.User, "shortcuts.json")));
        }
        Assert.True(saver.Join(TimeSpan.FromSeconds(10)));
        Assert.IsType<OkObjectResult>(answer);
        Assert.Contains("\"Q\"", File.ReadAllText(Path.Combine(f.Core.ConfigRoot, c.User, "shortcuts.json")), StringComparison.Ordinal);
    }

    [Fact]
    public void StandaloneHiddenContentReadReportsAnUnparseableList()
    {
        using var f = new ApiPluginFixture();
        var user = Guid.NewGuid();
        Store(f, user, "hidden-content.json", "not json");
        Assert.Equal(500, Assert.IsAssignableFrom<ObjectResult>(Build(f, user).Hidden.GetUserHiddenContent(user.ToString("N"))).StatusCode);
    }

    [Fact]
    public void ReadableListsAreAnsweredAsStored()
    {
        using var f = new ApiPluginFixture();
        var user = Guid.NewGuid();
        Store(f, user, "hidden-content.json", Kept);
        Store(f, user, "shortcuts.json", "{\"Shortcuts\":[{\"Name\":\"GoToHome\",\"Key\":\"Q\"}]}");
        var c = Build(f, user);

        var settings = UserSettings(c);
        Assert.Equal("Kept", settings.GetProperty("HiddenContent").GetProperty("Items").GetProperty("kept").GetProperty("Name").GetString());
        Assert.True(settings.GetProperty("HiddenContent").GetProperty("Settings").GetProperty("FilterSearch").GetBoolean());
        Assert.Equal("Q", settings.GetProperty("Shortcuts").GetProperty("Shortcuts")[0].GetProperty("Key").GetString());
        var hidden = Assert.IsType<UserHiddenContent>(Assert.IsType<OkObjectResult>(c.Hidden.GetUserHiddenContent(c.User)).Value);
        Assert.Equal("Kept", hidden.Items["kept"].Name);
        var shortcuts = Assert.IsType<UserShortcuts>(Assert.IsType<OkObjectResult>(c.Settings.GetUserSettingsShortcuts(c.User)).Value);
        Assert.Equal("Q", Assert.Single(shortcuts.Shortcuts).Key);
    }

    [Fact]
    public void NewUserStillGetsSeededDefaults()
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.HiddenContentDefaultFilterSearch = true;
        var user = Guid.NewGuid();
        var c = Build(f, user);
        var hidden = Assert.IsType<UserHiddenContent>(Assert.IsType<OkObjectResult>(c.Hidden.GetUserHiddenContent(c.User)).Value);
        Assert.Empty(hidden.Items);
        Assert.True(hidden.Settings.FilterSearch);
        var shortcuts = Assert.IsType<UserShortcuts>(Assert.IsType<OkObjectResult>(c.Settings.GetUserSettingsShortcuts(c.User)).Value);
        Assert.Empty(shortcuts.Shortcuts);
    }
}
