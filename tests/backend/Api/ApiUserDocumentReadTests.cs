using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Mvc;
using Moq;

namespace JE.Tests;

// The client saves hidden-content.json and shortcuts.json whole, so whatever the bootstrap or the
// standalone GET answers becomes the next save. A stored list that cannot be read must be reported
// as failed (null in the bootstrap, an error from the endpoint), never as an empty list.
[Collection("Plugin singleton")]
public class ApiUserDocumentReadTests
{
    private const string Kept = "{\"Items\":{\"kept\":{\"ItemId\":\"kept\",\"Name\":\"Kept\"}},\"Settings\":{\"FilterSearch\":true}}";

    private static JellyfinEnhancedController Controller(ApiPluginFixture f, Guid user)
    {
        var maintenance = new MaintenanceModeService(Mock.Of<IUserManager>(), Mock.Of<MediaBrowser.Controller.Session.ISessionManager>(), f.Core.Paths.Object, f.Core.Logger);
        var controller = ApiAssetTests.Controller(f.Core, maintenance, f.Core.Manager, Mock.Of<ILibraryManager>());
        controller.ControllerContext.HttpContext.User = global::JellyfinEnhanced.Tests.PrivacyPolicyTests.Principal(user);
        return controller;
    }

    private static string Store(ApiPluginFixture f, Guid user, string file, string text)
    {
        var directory = Path.Combine(f.Core.ConfigRoot, user.ToString("N"));
        Directory.CreateDirectory(directory);
        var path = Path.Combine(directory, file);
        File.WriteAllText(path, text);
        return path;
    }

    private static JsonElement UserSettings(JellyfinEnhancedController controller)
    {
        var body = Assert.IsType<JsonResult>(controller.GetBootstrap()).Value;
        return JsonDocument.Parse(JsonSerializer.Serialize(body)).RootElement.GetProperty("UserSettings");
    }

    [Theory]
    [InlineData("hidden-content.json", "HiddenContent")]
    [InlineData("shortcuts.json", "Shortcuts")]
    public void ReadErrorIsReportedAndLeavesTheStoredListAlone(string file, string bootstrapKey)
    {
        using var f = new ApiPluginFixture();
        var user = Guid.NewGuid();
        var path = Store(f, user, file, Kept);
        var controller = Controller(f, user);

        // Held exclusively, as an antivirus scan or a network share can hold it: the read fails.
        using (new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None))
        {
            Assert.Equal(JsonValueKind.Null, UserSettings(controller).GetProperty(bootstrapKey).ValueKind);
            var answer = file == "shortcuts.json"
                ? controller.GetUserSettingsShortcuts(user.ToString("N"))
                : controller.GetUserHiddenContent(user.ToString("N"));
            Assert.Equal(500, Assert.IsAssignableFrom<ObjectResult>(answer).StatusCode);
        }

        // A read error can pass: the file stays where it is, as it was.
        Assert.Equal(Kept, File.ReadAllText(path));
        Assert.Empty(Directory.GetFiles(Path.GetDirectoryName(path)!, file + ".corrupt-*"));
        Assert.NotEqual(JsonValueKind.Null, UserSettings(controller).GetProperty(bootstrapKey).ValueKind);
    }

    [Theory]
    [InlineData("hidden-content.json", "HiddenContent")]
    [InlineData("shortcuts.json", "Shortcuts")]
    public void UnparseableListIsReportedOnceThenSetAsideLikeASaveDoes(string file, string bootstrapKey)
    {
        using var f = new ApiPluginFixture();
        var user = Guid.NewGuid();
        const string Broken = "{\"Items\":{\"kept\":";
        var path = Store(f, user, file, Broken);
        var controller = Controller(f, user);

        Assert.Equal(JsonValueKind.Null, UserSettings(controller).GetProperty(bootstrapKey).ValueKind);

        // Content that does not parse never will: it is kept aside, as the save path already does,
        // so the next read starts from the defaults instead of failing on every page load.
        Assert.False(File.Exists(path));
        Assert.Equal(Broken, File.ReadAllText(Assert.Single(Directory.GetFiles(Path.GetDirectoryName(path)!, file + ".corrupt-*"))));
        var answer = file == "shortcuts.json"
            ? controller.GetUserSettingsShortcuts(user.ToString("N"))
            : controller.GetUserHiddenContent(user.ToString("N"));
        Assert.IsType<OkObjectResult>(answer);
    }

    // After a read that does not parse, the list is read again under the file's lock before it is moved
    // aside. That second read can fail to open the file too, which says nothing about its content.
    [Theory]
    [InlineData("hidden-content.json")]
    [InlineData("shortcuts.json")]
    public void SecondReadThatCannotOpenTheFileLeavesItWhereItIs(string file)
    {
        using var f = new ApiPluginFixture();
        var user = Guid.NewGuid();
        var path = Store(f, user, file, "{\"Items\":{\"kept\":");
        var controller = Controller(f, user);
        IActionResult? answer = null;
        var reader = new Thread(() => answer = file == "shortcuts.json"
            ? controller.GetUserSettingsShortcuts(user.ToString("N"))
            : controller.GetUserHiddenContent(user.ToString("N")));
        var fileLock = f.Core.Manager.GetUserFileLock(user.ToString("N"), file);
        FileStream? held = null;
        Monitor.Enter(fileLock);
        try
        {
            reader.Start();
            // The first read found content that does not parse and waits for the lock to read again.
            Assert.True(SpinWait.SpinUntil(() => LogMentions(f, $"Failed to parse '{file}'") && (reader.ThreadState & ThreadState.WaitSleepJoin) != 0, TimeSpan.FromSeconds(10)));
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

    private static bool LogMentions(ApiPluginFixture f, string text)
    {
        try
        {
            return File.Exists(f.Core.Logger.CurrentLogFilePath) && File.ReadAllText(f.Core.Logger.CurrentLogFilePath).Contains(text, StringComparison.Ordinal);
        }
        catch (IOException)
        {
            return false;
        }
    }

    // That second read and moving the file aside happen under the file's lock, so a save that replaces
    // the file in between could have its list moved aside. Every writer of the two files takes the lock.
    [Fact]
    public void ShortcutsSaveWaitsForTheFileLock()
    {
        using var f = new ApiPluginFixture();
        var user = Guid.NewGuid();
        var controller = Controller(f, user);
        var shortcuts = new Jellyfin.Plugin.JellyfinEnhanced.Configuration.UserShortcuts();
        shortcuts.Shortcuts.Add(new Jellyfin.Plugin.JellyfinEnhanced.Configuration.Shortcut { Name = "GoToHome", Key = "Q" });
        IActionResult? answer = null;
        var saver = new Thread(() => answer = controller.SaveUserSettingsShortcuts(user.ToString("N"), shortcuts));
        lock (f.Core.Manager.GetUserFileLock(user.ToString("N"), "shortcuts.json"))
        {
            saver.Start();
            Assert.False(saver.Join(TimeSpan.FromMilliseconds(500)), "the save waits while the lock is held");
            Assert.False(File.Exists(Path.Combine(f.Core.ConfigRoot, user.ToString("N"), "shortcuts.json")));
        }
        Assert.True(saver.Join(TimeSpan.FromSeconds(10)));
        Assert.IsType<OkObjectResult>(answer);
        Assert.Contains("\"Q\"", File.ReadAllText(Path.Combine(f.Core.ConfigRoot, user.ToString("N"), "shortcuts.json")), StringComparison.Ordinal);
    }

    [Fact]
    public void StandaloneHiddenContentReadReportsAnUnparseableList()
    {
        using var f = new ApiPluginFixture();
        var user = Guid.NewGuid();
        Store(f, user, "hidden-content.json", "not json");
        var answer = Controller(f, user).GetUserHiddenContent(user.ToString("N"));
        Assert.Equal(500, Assert.IsAssignableFrom<ObjectResult>(answer).StatusCode);
    }

    [Fact]
    public void ReadableListsAreAnsweredAsStored()
    {
        using var f = new ApiPluginFixture();
        var user = Guid.NewGuid();
        Store(f, user, "hidden-content.json", Kept);
        Store(f, user, "shortcuts.json", "{\"Shortcuts\":[{\"Name\":\"GoToHome\",\"Key\":\"Q\"}]}");
        var controller = Controller(f, user);

        var settings = UserSettings(controller);
        Assert.Equal("Kept", settings.GetProperty("HiddenContent").GetProperty("Items").GetProperty("kept").GetProperty("Name").GetString());
        Assert.True(settings.GetProperty("HiddenContent").GetProperty("Settings").GetProperty("FilterSearch").GetBoolean());
        Assert.Equal("Q", settings.GetProperty("Shortcuts").GetProperty("Shortcuts")[0].GetProperty("Key").GetString());
        var hidden = Assert.IsType<Jellyfin.Plugin.JellyfinEnhanced.Configuration.UserHiddenContent>(Assert.IsType<OkObjectResult>(controller.GetUserHiddenContent(user.ToString("N"))).Value);
        Assert.Equal("Kept", hidden.Items["kept"].Name);
        var shortcuts = Assert.IsType<Jellyfin.Plugin.JellyfinEnhanced.Configuration.UserShortcuts>(Assert.IsType<OkObjectResult>(controller.GetUserSettingsShortcuts(user.ToString("N"))).Value);
        Assert.Equal("Q", Assert.Single(shortcuts.Shortcuts).Key);
    }

    [Fact]
    public void NewUserStillGetsSeededDefaults()
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.HiddenContentDefaultFilterSearch = true;
        var user = Guid.NewGuid();
        var controller = Controller(f, user);
        var hidden = Assert.IsType<Jellyfin.Plugin.JellyfinEnhanced.Configuration.UserHiddenContent>(Assert.IsType<OkObjectResult>(controller.GetUserHiddenContent(user.ToString("N"))).Value);
        Assert.Empty(hidden.Items);
        Assert.True(hidden.Settings.FilterSearch);
        var shortcuts = Assert.IsType<Jellyfin.Plugin.JellyfinEnhanced.Configuration.UserShortcuts>(Assert.IsType<OkObjectResult>(controller.GetUserSettingsShortcuts(user.ToString("N"))).Value);
        Assert.Empty(shortcuts.Shortcuts);
    }
}
