using System.Security.Claims;
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
/// A settings.json that cannot be used is never served or saved as defaults (design item A3).
/// Malformed content (empty, literal null, unparseable) is quarantined and re-seeded from the
/// admin defaults; a file that cannot be read, or whose malformed content cannot be moved aside,
/// is reported unavailable and left exactly as it is. The lenient reader's own behaviour is
/// pinned in <see cref="CorePersistenceTests"/> and stays for its other callers.
/// </summary>
[Collection("Plugin singleton")]
public class CoreSettingsCorruptionTests
{
    private static readonly Guid UserA = Guid.Parse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    private static readonly string User = UserA.ToString("N");

    public static TheoryData<string> Malformed => new() { "", " \n ", "null", " null ", "{broken", "[1,2]", "\"text\"", "{\"AutoPauseEnabled\":\"maybe\"}" };

    private sealed class Endpoints : IDisposable
    {
        public ApiPluginFixture Plugin { get; } = new();
        public UserConfigurationManager Manager => Plugin.Core.Manager;
        public string UserDir => Path.Combine(Plugin.Core.ConfigRoot, User);
        public string SettingsPath => Path.Combine(UserDir, "settings.json");
        public string[] Backups => Directory.Exists(UserDir) ? Directory.GetFiles(UserDir, "settings.json.corrupt-*") : [];

        public Endpoints()
        {
            // Admin defaults that differ from the UserSettings initializers, so a re-seed is
            // distinguishable from serving `new UserSettings()`.
            var config = Plugin.Plugin.Configuration;
            config.AutoPauseEnabled = true;
            config.PauseScreenEnabled = true;
            config.RandomButtonEnabled = true;
            config.DefaultSubtitleSize = 3;
            config.WatchProgressDefaultMode = "time";
        }

        public JellyfinEnhancedController Controller()
        {
            var maintenance = new MaintenanceModeService(Mock.Of<IUserManager>(), Mock.Of<ISessionManager>(), Plugin.Core.Paths.Object, Plugin.Core.Logger);
            var controller = ApiAssetTests.Controller(Plugin.Core, Manager, Mock.Of<IUserManager>(), maintenance);
            controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([
                new Claim("Jellyfin-UserId", UserA.ToString()), new Claim(ClaimTypes.Role, "User")], "test"));
            return controller;
        }

        public IActionResult Get() => Controller().GetUserSettingsSettings(UserA.ToString());

        /// <summary>The bootstrap's UserSettings block.</summary>
        public JObject Bootstrap()
        {
            var body = JObject.Parse(System.Text.Json.JsonSerializer.Serialize(Assert.IsType<JsonResult>(Controller().GetBootstrap()).Value));
            return (JObject)body["UserSettings"]!;
        }

        public JObject Seed => Served(UserSettings.FromAdminDefaults(Plugin.Plugin.Configuration));

        public void Dispose() => Plugin.Dispose();
    }

    /// <summary>A document as GET settings.json serves it for a non-admin caller.</summary>
    private static JObject Served(UserSettings settings)
    {
        var json = Typed(settings);
        json["IsAdmin"] = false;
        return json;
    }

    private static JObject Typed(object value) => JObject.Parse(System.Text.Json.JsonSerializer.Serialize(value));

    private static JObject OkBody(IActionResult result) => Typed(Assert.IsType<OkObjectResult>(result).Value!);

    private static void AssertUnavailable(IActionResult result)
    {
        var error = Assert.IsType<ObjectResult>(result);
        Assert.Equal(503, error.StatusCode);
        Assert.Equal("unavailable", Typed(error.Value!)["status"]!.Value<string>());
    }

    /// <summary>
    /// Holds the file open without sharing. .NET takes an exclusive advisory lock for
    /// FileShare.None on Unix (a sharing violation on Windows), so every other read fails with an
    /// IOException: a portable stand-in for "the disk is there but the file cannot be read".
    /// </summary>
    private static FileStream Unreadable(string path) => new(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None);

    /// <summary>
    /// Restricts a path with Unix permissions; false when that does not stop this process (Windows,
    /// or running as root), in which case the caller has nothing to check.
    /// </summary>
    private static bool Restrict(string path, UnixFileMode mode, Func<bool> stillPermitted)
    {
        if (OperatingSystem.IsWindows()) return false;
        File.SetUnixFileMode(path, mode);
        if (!stillPermitted()) return true;
        File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        return false;
    }

    /// <summary>Gives back the permissions a <see cref="Restrict"/> call took away.</summary>
    private static void Unrestrict(string path, UnixFileMode mode)
    {
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(path, mode);
    }

    private static bool CanRead(string path)
    {
        try { File.ReadAllText(path); return true; }
        catch (UnauthorizedAccessException) { return false; }
    }

    private static bool CanCreateIn(string dir)
    {
        var probe = Path.Combine(dir, "probe-" + Guid.NewGuid().ToString("N"));
        try { File.WriteAllText(probe, ""); File.Delete(probe); return true; }
        catch (UnauthorizedAccessException) { return false; }
    }

    // ── Reader ───────────────────────────────────────────────────────────────

    [Theory]
    [MemberData(nameof(Malformed))]
    public void MalformedContentIsQuarantinedOnceAndNeverDeleted(string content)
    {
        using var f = new CoreFixture();
        var path = f.Write(User, content);
        Assert.Equal(UserDocumentReadStatus.Quarantined, f.Manager.ReadUserConfigurationChecked<UserSettings>(User, "settings.json", out var value));
        Assert.Null(value);
        Assert.False(File.Exists(path));
        Assert.Equal(content, File.ReadAllText(Assert.Single(Directory.GetFiles(Path.GetDirectoryName(path)!, "settings.json.corrupt-*"))));
        // The file is gone now: the next read finds nothing to quarantine.
        Assert.Equal(UserDocumentReadStatus.Missing, f.Manager.ReadUserConfigurationChecked<UserSettings>(User, "settings.json", out _));
    }

    [Fact]
    public void MissingAndUsableFilesAreReadAsTheyAre()
    {
        using var f = new CoreFixture();
        Assert.Equal(UserDocumentReadStatus.Missing, f.Manager.ReadUserConfigurationChecked<UserSettings>(User, "settings.json", out var missing));
        Assert.Null(missing);
        Assert.False(Directory.Exists(Path.Combine(f.ConfigRoot, User)), "a read never creates the user directory");

        // Legacy partial files and bool?-era JSON nulls are usable documents, not corruption.
        var path = f.Write(User, "{\"AutoPauseEnabled\":null,\"DisplayLanguage\":\"fr\"}");
        Assert.Equal(UserDocumentReadStatus.Loaded, f.Manager.ReadUserConfigurationChecked<UserSettings>(User, "settings.json", out var loaded));
        Assert.Equal("fr", loaded!.DisplayLanguage);
        Assert.False(loaded.AutoPauseEnabled);
        f.Write(User, "{}");
        Assert.Equal(UserDocumentReadStatus.Loaded, f.Manager.ReadUserConfigurationChecked<UserSettings>(User, "settings.json", out _));
        Assert.Empty(Directory.GetFiles(Path.GetDirectoryName(path)!, "*.corrupt-*"));
    }

    [Theory]
    [InlineData("{\"DisplayLanguage\":\"fr\"}")]
    [InlineData("{broken")]
    public void AFileThatCannotBeReadIsUnavailableAndLeftInPlace(string content)
    {
        using var f = new CoreFixture();
        var path = f.Write(User, content);
        using (Unreadable(path))
        {
            Assert.Equal(UserDocumentReadStatus.Unavailable, f.Manager.ReadUserConfigurationChecked<UserSettings>(User, "settings.json", out var value));
            Assert.Null(value);
        }
        Assert.Equal(content, File.ReadAllText(path));
        Assert.Empty(Directory.GetFiles(Path.GetDirectoryName(path)!, "*.corrupt-*"));
    }

    [Fact]
    public void APermissionDeniedFileIsUnavailableAndLeftInPlace()
    {
        using var f = new CoreFixture();
        var path = f.Write(User, "{\"DisplayLanguage\":\"fr\"}");
        if (!Restrict(path, UnixFileMode.None, () => CanRead(path))) return;
        try
        {
            Assert.Equal(UserDocumentReadStatus.Unavailable, f.Manager.ReadUserConfigurationChecked<UserSettings>(User, "settings.json", out _));
        }
        finally
        {
            Unrestrict(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }
        Assert.Equal("{\"DisplayLanguage\":\"fr\"}", File.ReadAllText(path));
        Assert.Empty(Directory.GetFiles(Path.GetDirectoryName(path)!, "*.corrupt-*"));
    }

    [Fact]
    public void MalformedContentThatCannotBeMovedAsideIsUnavailableAndNeverDeleted()
    {
        // A name at the file-system limit: the file itself can be written and deleted, but its
        // .corrupt-{ts} backup name is too long, so the move fails while a delete would succeed.
        using var f = new CoreFixture();
        var fileName = new string('s', 245) + ".json";
        var dir = Path.Combine(f.ConfigRoot, User);
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, fileName);
        File.WriteAllText(path, "{broken");
        Assert.Equal(UserDocumentReadStatus.Unavailable, f.Manager.ReadUserConfigurationChecked<UserSettings>(User, fileName, out var value));
        Assert.Null(value);
        Assert.Equal("{broken", File.ReadAllText(path));
        Assert.Single(Directory.GetFiles(dir));
    }

    // ── GET settings.json and bootstrap ──────────────────────────────────────

    [Theory]
    [MemberData(nameof(Malformed))]
    public void MalformedSettingsAreQuarantinedAndReseededFromTheAdminDefaultsExactlyOnce(string content)
    {
        using var endpoints = new Endpoints();
        var seed = endpoints.Seed;
        Assert.False(JToken.DeepEquals(seed, Served(new UserSettings())), "the admin defaults must differ from the initializers");
        endpoints.Plugin.Core.Write(User, content);

        Assert.True(JToken.DeepEquals(seed, OkBody(endpoints.Get())));
        var backup = Assert.Single(endpoints.Backups);
        Assert.Equal(content, File.ReadAllText(backup));
        var stored = Typed(Newtonsoft.Json.JsonConvert.DeserializeObject<UserSettings>(File.ReadAllText(endpoints.SettingsPath))!);
        stored["IsAdmin"] = false;
        Assert.True(JToken.DeepEquals(seed, stored), "the re-seeded file is what was served");

        // No re-seed loop: the next GET and the bootstrap read the seeded file as it is.
        var before = File.ReadAllText(endpoints.SettingsPath);
        Assert.True(JToken.DeepEquals(seed, OkBody(endpoints.Get())));
        var bootstrap = endpoints.Bootstrap();
        Assert.Equal("ok", bootstrap["SettingsStatus"]!.Value<string>());
        Assert.True(JToken.DeepEquals(seed, bootstrap["Settings"]));
        Assert.Equal(before, File.ReadAllText(endpoints.SettingsPath));
        Assert.Single(endpoints.Backups);
    }

    [Fact]
    public void BootstrapReseedsAMalformedFileToo()
    {
        using var endpoints = new Endpoints();
        endpoints.Plugin.Core.Write(User, "null");
        var bootstrap = endpoints.Bootstrap();
        Assert.Equal("ok", bootstrap["SettingsStatus"]!.Value<string>());
        Assert.True(JToken.DeepEquals(endpoints.Seed, bootstrap["Settings"]));
        Assert.Single(endpoints.Backups);
    }

    [Fact]
    public void UnreadableSettingsAreReportedUnavailableAndNeitherServedNorReseeded()
    {
        using var endpoints = new Endpoints();
        var stored = "{\"DisplayLanguage\":\"fr\",\"AutoPauseEnabled\":false}";
        endpoints.Plugin.Core.Write(User, stored);
        using (Unreadable(endpoints.SettingsPath))
        {
            AssertUnavailable(endpoints.Get());
            var bootstrap = endpoints.Bootstrap();
            Assert.Equal("unavailable", bootstrap["SettingsStatus"]!.Value<string>());
            Assert.Equal(JTokenType.Null, bootstrap["Settings"]!.Type);
        }
        Assert.Equal(stored, File.ReadAllText(endpoints.SettingsPath));
        Assert.Empty(endpoints.Backups);

        // Once the file can be read again, the user's own values come back.
        var served = OkBody(endpoints.Get());
        Assert.Equal("fr", served["DisplayLanguage"]!.Value<string>());
        Assert.False(served["AutoPauseEnabled"]!.Value<bool>());
    }

    [Fact]
    public void MalformedSettingsThatCannotBeMovedAsideAreUnavailableAndNotReseeded()
    {
        using var endpoints = new Endpoints();
        endpoints.Plugin.Core.Write(User, "{broken");
        var dir = endpoints.UserDir;
        if (!Restrict(dir, UnixFileMode.UserRead | UnixFileMode.UserExecute, () => CanCreateIn(dir))) return;
        try
        {
            AssertUnavailable(endpoints.Get());
            Assert.Equal("unavailable", endpoints.Bootstrap()["SettingsStatus"]!.Value<string>());
        }
        finally
        {
            Unrestrict(dir, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }
        Assert.Equal("{broken", File.ReadAllText(endpoints.SettingsPath));
        Assert.Empty(endpoints.Backups);
    }

    [Fact]
    public void ASeedThatCannotBeWrittenIsUnavailable()
    {
        using var endpoints = new Endpoints();
        Directory.CreateDirectory(endpoints.UserDir);
        var dir = endpoints.UserDir;
        if (!Restrict(dir, UnixFileMode.UserRead | UnixFileMode.UserExecute, () => CanCreateIn(dir))) return;
        try
        {
            AssertUnavailable(endpoints.Get());
            Assert.Equal("unavailable", endpoints.Bootstrap()["SettingsStatus"]!.Value<string>());
        }
        finally
        {
            Unrestrict(dir, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }
        Assert.False(File.Exists(endpoints.SettingsPath));
        Assert.True(JToken.DeepEquals(endpoints.Seed, OkBody(endpoints.Get())), "a later GET seeds once the directory is writable");
    }

    [Fact]
    public void ANewUserIsStillSeededAndAGoodFileIsServedUnchanged()
    {
        using var endpoints = new Endpoints();
        Assert.True(JToken.DeepEquals(endpoints.Seed, OkBody(endpoints.Get())));
        Assert.True(File.Exists(endpoints.SettingsPath));
        Assert.Equal("ok", endpoints.Bootstrap()["SettingsStatus"]!.Value<string>());

        var stored = "{\"DisplayLanguage\":\"de\"}";
        endpoints.Plugin.Core.Write(User, stored);
        var served = OkBody(endpoints.Get());
        Assert.Equal("de", served["DisplayLanguage"]!.Value<string>());
        Assert.False(served["AutoPauseEnabled"]!.Value<bool>(), "a partial legacy file keeps its initializers (see the B1 goldens)");
        Assert.Equal(stored, File.ReadAllText(endpoints.SettingsPath));
        Assert.Empty(endpoints.Backups);
    }
}
