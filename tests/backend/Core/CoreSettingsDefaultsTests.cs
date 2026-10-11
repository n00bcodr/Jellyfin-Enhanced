using System.Runtime.CompilerServices;
using System.Security.Claims;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using Microsoft.AspNetCore.Mvc;
using Moq;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace JE.Tests;

/// <summary>
/// Golden per-user settings defaults, read through the real endpoints and the typed reader:
/// (a) what legacy partial files resolve to, (b) the new-user seed written by the first
/// GET settings.json, (c) what reset-all writes, and the public-config input of (d), the
/// client fallback that tests/frontend/core/core-settings-defaults.test.mjs checks. The
/// goldens live in tests/fixtures/settings; a deliberate behaviour change regenerates them
/// with JE_UPDATE_GOLDENS=1 and the diff shows exactly what moved.
/// </summary>
[Collection("Plugin singleton")]
public class CoreSettingsDefaultsTests
{
    private static readonly Guid UserA = Guid.Parse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    private static readonly Guid UserB = Guid.Parse("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");

    // Public-config keys config.js reads under a name that is not a UserSettings property.
    private static readonly string[] AdminDefaultAliases =
    {
        "DefaultSubtitleStyle", "DefaultSubtitleSize", "DefaultSubtitleFont", "DefaultSubtitleTextEffect",
        "DefaultLanguage", "WatchProgressDefaultMode", "DisableAllShortcuts",
    };

    private static string FixtureDirectory([CallerFilePath] string source = "")
        => Path.GetFullPath(Path.Combine(Path.GetDirectoryName(source)!, "..", "..", "fixtures", "settings"));

    private static JObject ReadFixture(string name)
        => JObject.Parse(File.ReadAllText(Path.Combine(FixtureDirectory(), name)));

    /// <summary>Compares with the committed golden, or rewrites it when JE_UPDATE_GOLDENS=1.</summary>
    private static void MatchGolden(string name, JObject actual)
    {
        var path = Path.Combine(FixtureDirectory(), name);
        if (Environment.GetEnvironmentVariable("JE_UPDATE_GOLDENS") == "1")
        {
            File.WriteAllText(path, actual.ToString(Formatting.Indented) + "\n");
            return;
        }
        var differences = new List<string>();
        Diff(JObject.Parse(File.ReadAllText(path)), actual, "", differences);
        Assert.True(differences.Count == 0, $"{name} differs from the golden (JE_UPDATE_GOLDENS=1 regenerates it after a deliberate change):\n" + string.Join("\n", differences));
    }

    private static void Diff(JToken expected, JToken actual, string path, List<string> differences)
    {
        if (expected is JObject e && actual is JObject a)
        {
            foreach (var key in e.Properties().Select(p => p.Name).Union(a.Properties().Select(p => p.Name)))
            {
                if (!a.ContainsKey(key)) differences.Add($"{path}.{key}: missing (golden {e[key]!.ToString(Formatting.None)})");
                else if (!e.ContainsKey(key)) differences.Add($"{path}.{key}: unexpected {a[key]!.ToString(Formatting.None)}");
                else Diff(e[key]!, a[key]!, $"{path}.{key}", differences);
            }
        }
        else if (!JToken.DeepEquals(expected, actual))
        {
            differences.Add($"{path}: golden {expected.ToString(Formatting.None)}, actual {actual.ToString(Formatting.None)}");
        }
    }

    private sealed class Endpoints : IDisposable
    {
        public ApiPluginFixture Plugin { get; } = new();
        public JellyfinEnhancedController Controller { get; }
        public Endpoints(string configName)
        {
            JsonConvert.PopulateObject(ReadFixture("admin-configs.json")[configName]!.ToString(), Plugin.Plugin.Configuration);
            var maintenance = new MaintenanceModeService(Mock.Of<IUserManager>(), Mock.Of<ISessionManager>(), Plugin.Core.Paths.Object, Plugin.Core.Logger);
            Controller = ApiAssetTests.Controller(Plugin.Core, Plugin.Core.Manager, Mock.Of<IUserManager>(), maintenance);
            SignIn(UserA);
        }
        public void SignIn(Guid user, bool admin = false) => Controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([
            new Claim("Jellyfin-UserId", user.ToString()), new Claim(ClaimTypes.Role, admin ? "Administrator" : "User")], "test"));
        public string SettingsPath(Guid user) => Path.Combine(Plugin.Core.ConfigRoot, user.ToString("N"), "settings.json");
        /// <summary>GET settings.json as the signed-in user; the body as JSON plus its IsAdmin flag.</summary>
        public (JObject Settings, bool IsAdmin) GetSettings(Guid user)
        {
            var body = JObject.Parse(System.Text.Json.JsonSerializer.Serialize(Assert.IsType<OkObjectResult>(Controller.GetUserSettingsSettings(user.ToString())).Value));
            var isAdmin = body.Value<bool>("IsAdmin");
            body.Remove("IsAdmin");
            return (body, isAdmin);
        }
        public void Dispose() => Plugin.Dispose();
    }

    /// <summary>A value as System.Text.Json serializes it, the way the endpoints send it.</summary>
    private static JObject Typed<T>(T value) => JObject.Parse(System.Text.Json.JsonSerializer.Serialize(value));

    private static IEnumerable<string> ConfigNames() => ReadFixture("admin-configs.json").Properties().Select(p => p.Name);

    [Fact]
    public void LegacyPartialFilesResolveToGoldenInitializersThroughReaderAndEndpoint()
    {
        using var endpoints = new Endpoints("customised");
        var golden = ReadFixture("legacy-partial-files.json");
        var initializers = Typed(new UserSettings());
        // A missing file read by any server-side consumer is the bare initializers.
        Assert.True(JToken.DeepEquals(initializers, Typed(endpoints.Plugin.Core.Manager.GetUserConfiguration<UserSettings>(UserB.ToString("N"), "settings.json"))));
        var cases = new JObject();
        foreach (var entry in ((JObject)golden["Cases"]!).Properties())
        {
            var stored = entry.Value.Value<string>("Stored")!;
            var path = endpoints.Plugin.Core.Write(UserA.ToString("N"), stored);
            var read = Typed(endpoints.Plugin.Core.Manager.GetUserConfiguration<UserSettings>(UserA.ToString("N"), "settings.json"));
            var (served, isAdmin) = endpoints.GetSettings(UserA);
            // The endpoint serves exactly the typed read, never seeds over an existing file, and
            // takes IsAdmin from the caller, whatever the file says.
            Assert.True(JToken.DeepEquals(read, served), entry.Name);
            Assert.False(isAdmin);
            Assert.Equal(stored, File.ReadAllText(path));
            // Same keys as the initializers, so Initializers overlaid with DiffersFromInitializers is
            // exactly the served document the frontend test feeds through config.js.
            Assert.Equal(initializers.Properties().Select(p => p.Name), served.Properties().Select(p => p.Name));
            var differs = new JObject();
            foreach (var property in read.Properties())
            {
                if (!JToken.DeepEquals(property.Value, initializers[property.Name])) differs[property.Name] = property.Value;
            }
            cases[entry.Name] = new JObject { ["Stored"] = entry.Value["Stored"], ["DiffersFromInitializers"] = differs };
        }
        MatchGolden("legacy-partial-files.json", new JObject { ["Initializers"] = initializers, ["Cases"] = cases });
    }

    /// <summary>The seed the first GET writes for a user without settings.json, per admin config.</summary>
    private static JObject NewUserSeed(string configName)
    {
        using var endpoints = new Endpoints(configName);
        var (served, isAdmin) = endpoints.GetSettings(UserA);
        Assert.False(isAdmin);
        var written = File.ReadAllText(endpoints.SettingsPath(UserA));
        Assert.True(JToken.DeepEquals(served, JObject.Parse(written)), configName);
        // The seed is written once: a later GET serves the same document and leaves the file alone.
        endpoints.SignIn(UserA, admin: true);
        var (again, adminAgain) = endpoints.GetSettings(UserA);
        Assert.True(adminAgain);
        Assert.True(JToken.DeepEquals(served, again), configName);
        Assert.Equal(written, File.ReadAllText(endpoints.SettingsPath(UserA)));
        return served;
    }

    [Fact]
    public void NewUserSeedMatchesGoldenForEachAdminConfig()
    {
        var seeds = new JObject();
        foreach (var name in ConfigNames()) seeds[name] = NewUserSeed(name);
        MatchGolden("new-user-seed.json", seeds);
    }

    /// <summary>What reset-all writes to every user's documents, per admin config.</summary>
    private static JObject ResetAll(string configName)
    {
        using var endpoints = new Endpoints(configName);
        var manager = endpoints.Plugin.Core.Manager;
        string a = UserA.ToString("N"), b = UserB.ToString("N");
        // One user with every field customised, one with a legacy partial file and Spoiler Guard state.
        manager.SaveUserConfiguration(a, "settings.json", new UserSettings { AutoPipEnabled = true, SubtitleVerticalPosition = 40, WatchProgressMode = "remaining", LastOpenedTab = "settings", RandomSourceId = "abc", TagsHideOnHover = true, UseNativePosterTags = false, QualityTagsPreferredAudioLanguage = "eng", ResolutionTagOrder = 9 });
        manager.SaveUserConfiguration(a, "hidden-content.json", new UserHiddenContent { Items = new() { ["x"] = new HiddenContentItem() }, Settings = new HiddenContentSettings { Enabled = false, FilterSearch = true } });
        endpoints.Plugin.Core.Write(b, "{\"AutoPauseEnabled\":true}");
        manager.SaveUserConfiguration(b, SpoilerBlurImageFilter.SpoilerBlurFileName, new UserSpoilerBlur { Series = new() { ["s"] = new SpoilerBlurSeriesEntry { SeriesId = "s" } }, Prefs = new SpoilerBlurUserPrefs { HideCast = false, UseAdvancedCategories = false, SkipDisableConfirm = true } });

        endpoints.SignIn(UserB, admin: true);
        var response = JObject.Parse(System.Text.Json.JsonSerializer.Serialize(Assert.IsType<OkObjectResult>(endpoints.Controller.ResetAllUsersSettings()).Value));
        Assert.True(response.Value<bool>("success"));
        Assert.Equal(2, response.Value<int>("userCount"));
        Assert.Equal(2, response.Value<int>("totalUsers"));
        Assert.Empty(response["skippedSettingsUserIds"]!);
        Assert.Empty(response["skippedHcUserIds"]!);

        var settings = JObject.Parse(File.ReadAllText(endpoints.SettingsPath(UserA)));
        Assert.True(JToken.DeepEquals(settings, JObject.Parse(File.ReadAllText(endpoints.SettingsPath(UserB)))), configName);
        var hiddenA = manager.GetUserConfigurationStrict<UserHiddenContent>(a, "hidden-content.json");
        var hiddenB = manager.GetUserConfigurationStrict<UserHiddenContent>(b, "hidden-content.json");
        Assert.Equal("x", Assert.Single(hiddenA.Items).Key); // items are data and survive the reset
        Assert.True(JToken.DeepEquals(Typed(hiddenA.Settings), Typed(hiddenB.Settings)), configName);
        var spoiler = manager.GetUserConfigurationStrict<UserSpoilerBlur>(b, SpoilerBlurImageFilter.SpoilerBlurFileName);
        Assert.Equal("s", Assert.Single(spoiler.Series).Key);
        // Only an existing Spoiler Guard file is reset; none is created for the other user.
        Assert.False(manager.UserConfigurationExists(a, SpoilerBlurImageFilter.SpoilerBlurFileName));
        return new JObject
        {
            ["Settings"] = settings,
            ["HiddenContentSettings"] = Typed(hiddenA.Settings),
            ["SpoilerPrefs"] = Typed(spoiler.Prefs),
        };
    }

    [Fact]
    public void ResetAllWritesGoldenDefaultsForEachAdminConfig()
    {
        var resets = new JObject();
        foreach (var name in ConfigNames()) resets[name] = ResetAll(name);
        MatchGolden("reset-all.json", resets);
    }

    [Fact]
    public void SeedAndResetDifferOnlyInAllowlistedKeys()
    {
        var allowed = ((JObject)ReadFixture("parity-allowlist.json")["SeedVsReset"]!).Properties().Select(p => p.Name).ToHashSet();
        var seen = new HashSet<string>();
        foreach (var name in ConfigNames())
        {
            var seed = NewUserSeed(name);
            var reset = (JObject)ResetAll(name)["Settings"]!;
            Assert.Equal(seed.Properties().Select(p => p.Name), reset.Properties().Select(p => p.Name));
            foreach (var property in seed.Properties().Where(p => !JToken.DeepEquals(p.Value, reset[p.Name])))
            {
                Assert.True(allowed.Contains(property.Name), $"{name}: seed {property.Value} and reset {reset[property.Name]} differ for {property.Name}, which is not on the SeedVsReset allowlist");
                seen.Add(property.Name);
            }
        }
        // A fixed drift must leave the allowlist with its fix.
        Assert.Empty(allowed.Except(seen));
    }

    [Fact]
    public void PublicConfigUserDefaultsForClientFallbackMatchGolden()
    {
        var names = typeof(UserSettings).GetProperties().Select(p => p.Name).Concat(AdminDefaultAliases).ToHashSet();
        var inputs = new JObject();
        foreach (var name in ConfigNames())
        {
            using var endpoints = new Endpoints(name);
            var publicConfig = JObject.Parse(System.Text.Json.JsonSerializer.Serialize(Assert.IsType<JsonResult>(endpoints.Controller.GetPublicConfig()).Value));
            var subset = new JObject();
            foreach (var property in publicConfig.Properties().Where(p => names.Contains(p.Name))) subset[property.Name] = property.Value;
            foreach (var alias in AdminDefaultAliases) Assert.True(subset.ContainsKey(alias), $"{alias} is no longer in the public config");
            inputs[name] = subset;
        }
        MatchGolden("public-config-user-defaults.json", inputs);
    }
}
