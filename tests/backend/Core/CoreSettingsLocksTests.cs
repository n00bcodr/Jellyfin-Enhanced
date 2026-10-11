using System.Runtime.CompilerServices;
using System.Security.Claims;
using System.Text;
using System.Xml;
using System.Xml.Serialization;
using Jellyfin.Extensions.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using Microsoft.AspNetCore.Mvc;
using Moq;
using Newtonsoft.Json.Linq;
using StjSerializer = System.Text.Json.JsonSerializer;

namespace JE.Tests;

/// <summary>
/// Admin locks (design item C2): PluginConfiguration.LockedUserSettings read through one null-safe
/// accessor, enforced on every read and write path (GET, bootstrap, /patch, the legacy POST and the
/// native poster settings), the recently-unlocked guard for stale whole-document posts, the admin
/// registry route, and the XML/JSON round trips that must never wipe the admin config.
/// </summary>
[Collection("Plugin singleton")]
public class CoreSettingsLocksTests : IDisposable
{
    private static readonly Guid UserA = Guid.Parse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    private static readonly Guid AdminUser = Guid.Parse("cccccccc-cccc-cccc-cccc-cccccccccccc");

    public CoreSettingsLocksTests() => RecentlyUnlockedSettings.Clear();

    public void Dispose() => RecentlyUnlockedSettings.Clear();

    private sealed class Endpoints : IDisposable
    {
        public ApiPluginFixture Plugin { get; } = new();
        public UserConfigurationManager Manager => Plugin.Core.Manager;
        public PluginConfiguration Config => Plugin.Plugin.Configuration;
        public string SettingsPath(Guid user) => Path.Combine(Plugin.Core.ConfigRoot, user.ToString("N"), "settings.json");

        public JellyfinEnhancedController Controller(Guid user, bool admin = false)
        {
            var maintenance = new MaintenanceModeService(Mock.Of<IUserManager>(), Mock.Of<ISessionManager>(), Plugin.Core.Paths.Object, Plugin.Core.Logger);
            var controller = ApiAssetTests.Controller(Plugin.Core, Manager, Mock.Of<IUserManager>(), maintenance);
            controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([
                new Claim("Jellyfin-UserId", user.ToString()), new Claim(ClaimTypes.Role, admin ? "Administrator" : "User")], "test"));
            return controller;
        }

        /// <summary>Saves a new admin configuration the way Jellyfin does (UpdateConfiguration).</summary>
        public void Save(Action<PluginConfiguration> change)
        {
            var next = Clone(Config);
            change(next);
            Plugin.Plugin.UpdateConfiguration(next);
        }

        public JObject Patch(string body) => Body(Controller(UserA).PatchUserSettingsSettings(UserA.ToString(), Json(body)));

        public JObject Post(string body) => Body(Controller(UserA).SaveUserSettingsSettings(UserA.ToString(), Json(body)));

        public JObject Get() => Body(Controller(UserA).GetUserSettingsSettings(UserA.ToString()));

        public (JObject Settings, JObject Meta) GetWithMeta()
        {
            var body = Body(Controller(UserA).GetUserSettingsSettings(UserA.ToString(), meta: true));
            return ((JObject)body["Settings"]!, (JObject)body["Meta"]!);
        }

        public JObject Bootstrap() => JObject.Parse(StjSerializer.Serialize(Assert.IsType<JsonResult>(Controller(UserA).GetBootstrap()).Value));

        public JObject OnDisk() => JObject.Parse(File.ReadAllText(SettingsPath(UserA)));

        public void Write(UserSettings settings) => Manager.SaveUserConfiguration(UserA.ToString("N"), "settings.json", settings);

        public void Dispose() => Plugin.Dispose();
    }

    private static PluginConfiguration Clone(PluginConfiguration config)
        => StjSerializer.Deserialize<PluginConfiguration>(StjSerializer.Serialize(config, JsonDefaults.Options), JsonDefaults.Options)!;

    private static System.Text.Json.JsonElement Json(string json)
    {
        using var document = System.Text.Json.JsonDocument.Parse(json);
        return document.RootElement.Clone();
    }

    private static JObject Body(IActionResult result) => JObject.Parse(StjSerializer.Serialize(Assert.IsAssignableFrom<ObjectResult>(result).Value));

    private static Dictionary<string, string> Rejections(JObject body)
        => ((body["Rejected"] as JArray) ?? throw new Xunit.Sdk.XunitException("no Rejected in " + body.ToString(Newtonsoft.Json.Formatting.None))).ToDictionary(r => r.Value<string>("Key")!, r => r.Value<string>("Reason")!);

    private static string[] Strings(JToken? array) => array!.Values<string>().Select(v => v!).ToArray();

    /// <summary>real-viewer's situation in the design's worked example: chose AutoPip On and quality tags Off.</summary>
    private static Endpoints WithChoices()
    {
        var endpoints = new Endpoints();
        endpoints.Save(c => { c.AutoPipEnabled = false; c.QualityTagsEnabled = true; c.NativePosterTagsEnabled = true; });
        endpoints.Write(new UserSettings { AutoPipEnabled = true, QualityTagsEnabled = false, AutoPauseEnabled = false });
        return endpoints;
    }

    // ---- the accessor

    [Fact]
    public void LockedKeysIsNullSafeAndKeepsOnlyLockableRegistryKeysOnceInRegistryOrder()
    {
        Assert.Empty(UserSettingsResolver.LockedKeys(null));
        Assert.Empty(UserSettingsResolver.LockedKeys(new PluginConfiguration { LockedUserSettings = null! }));
        Assert.Empty(new PluginConfiguration().LockedUserSettings);
        var config = new PluginConfiguration
        {
            LockedUserSettings = ["qualitytagsenabled", "AutoPipEnabled", "AUTOPIPENABLED", "NotASetting", null!, "",
                "PauseScreenDelaySeconds", "SubtitleVerticalPosition", "LastOpenedTab", "IsAdmin"],
        };
        Assert.Equal(["AutoPipEnabled", "QualityTagsEnabled"], UserSettingsResolver.LockedKeys(config));
        Assert.Equal(["NotASetting", "(null)", "", "PauseScreenDelaySeconds", "SubtitleVerticalPosition", "LastOpenedTab", "IsAdmin"],
            UserSettingsResolver.IgnoredLockEntries(config));
    }

    [Fact]
    public void ALockedKeyResolvesToTheAdminDefaultAsTheSeedWouldWriteIt()
    {
        var config = new PluginConfiguration
        {
            WatchProgressDefaultMode = " ", QualityTagsPreferredAudioLanguage = "fra", ResolutionTagOrder = 4,
            LockedUserSettings = ["WatchProgressMode", "QualityTagsPreferredAudioLanguage", "ResolutionTagOrder"],
        };
        var stored = new UserSettings { WatchProgressMode = "remaining", QualityTagsPreferredAudioLanguage = "jpn", ResolutionTagOrder = 1 };
        var resolved = UserSettingsResolver.Resolve(stored, config);
        // A blank admin mode gives the initializer, the audio language its "use the server default" sentinel.
        Assert.Equal("percentage", resolved.Values.WatchProgressMode);
        Assert.Equal(string.Empty, resolved.Values.QualityTagsPreferredAudioLanguage);
        Assert.Equal(4, resolved.Values.ResolutionTagOrder);
        Assert.Equal("remaining", stored.WatchProgressMode);
    }

    // ---- every path

    [Fact]
    public void GetAndBootstrapServeTheAdminValueAndReportTheSavedChoice()
    {
        using var endpoints = WithChoices();
        endpoints.Save(c => c.LockedUserSettings = ["AutoPipEnabled", "QualityTagsEnabled"]);

        var plain = endpoints.Get();
        Assert.False(plain.Value<bool>("AutoPipEnabled"));
        Assert.True(plain.Value<bool>("QualityTagsEnabled"));
        Assert.False(plain.Value<bool>("AutoPauseEnabled"), "unlocked keys keep the user's value");
        Assert.Null(plain["Meta"]);

        var (settings, meta) = endpoints.GetWithMeta();
        Assert.Equal(plain.ToString(), settings.ToString());
        Assert.Equal(["AutoPipEnabled", "QualityTagsEnabled"], Strings(meta["Locked"]));
        Assert.Equal(JObject.Parse("{\"AutoPipEnabled\":true,\"QualityTagsEnabled\":false}").ToString(), meta["Saved"]!.ToString());
        Assert.Equal("Both", meta["Reach"]!.Value<string>("QualityTagsEnabled"));

        var bootstrap = endpoints.Bootstrap();
        Assert.False(bootstrap["UserSettings"]!["Settings"]!.Value<bool>("AutoPipEnabled"));
        Assert.True(bootstrap["UserSettings"]!["Settings"]!.Value<bool>("QualityTagsEnabled"));
        Assert.Equal(["AutoPipEnabled", "QualityTagsEnabled"], Strings(bootstrap["UserSettings"]!["SettingsMeta"]!["Locked"]));

        // The user's choice stays on disk.
        Assert.True(endpoints.OnDisk().Value<bool>("AutoPipEnabled"));
    }

    [Fact]
    public void PatchAndTheLegacyPostRefuseLockedKeysAndKeepTheChoice()
    {
        using var endpoints = WithChoices();
        endpoints.Save(c => c.LockedUserSettings = ["AutoPipEnabled", "QualityTagsEnabled"]);
        var patch = endpoints.Patch("{\"Set\":{\"AutoPipEnabled\":false,\"qualityTagsEnabled\":true,\"AutoPauseEnabled\":true}}");
        Assert.Equal(new Dictionary<string, string> { ["AutoPipEnabled"] = "locked", ["QualityTagsEnabled"] = "locked" }, Rejections(patch));
        Assert.Equal(["AutoPauseEnabled"], Strings(patch["Applied"]));
        Assert.False(patch["Settings"]!.Value<bool>("AutoPipEnabled"));
        Assert.Equal(new Dictionary<string, string> { ["AutoPipEnabled"] = "locked" }, Rejections(endpoints.Patch("{\"Follow\":[\"AutoPipEnabled\"]}")));

        var post = endpoints.Post("{\"AutoPipEnabled\":false,\"QualityTagsEnabled\":false,\"AutoResumeEnabled\":true}");
        Assert.Equal(new Dictionary<string, string> { ["QualityTagsEnabled"] = "locked" }, Rejections(post));

        // Re-posting the served (enforced) document is a no-op for the locked keys.
        var served = endpoints.Get();
        Assert.Empty(Rejections(endpoints.Post(served.ToString())));

        var disk = endpoints.OnDisk();
        Assert.True(disk.Value<bool>("AutoPipEnabled"));
        Assert.False(disk.Value<bool>("QualityTagsEnabled"));
        Assert.True(disk.Value<bool>("AutoPauseEnabled"));
        Assert.True(disk.Value<bool>("AutoResumeEnabled"));
    }

    [Fact]
    public void LocksApplyToAnAdministratorsOwnSettingsToo()
    {
        using var endpoints = WithChoices();
        endpoints.Save(c => c.LockedUserSettings = ["AutoPipEnabled"]);
        endpoints.Manager.SaveUserConfiguration(AdminUser.ToString("N"), "settings.json", new UserSettings { AutoPipEnabled = true });
        var own = Body(endpoints.Controller(AdminUser, admin: true).GetUserSettingsSettings(AdminUser.ToString()));
        Assert.False(own.Value<bool>("AutoPipEnabled"));
        var patch = Body(endpoints.Controller(AdminUser, admin: true).PatchUserSettingsSettings(AdminUser.ToString(), Json("{\"Set\":{\"AutoPipEnabled\":true}}")));
        Assert.Equal("locked", Rejections(patch)["AutoPipEnabled"]);
    }

    [Fact]
    public void TheNativePosterPathServesTheLockedValueAndItsDigestFollowsTheLock()
    {
        using var endpoints = WithChoices();
        using var provider = new PosterTagSettingsProvider(endpoints.Manager, new PosterTagUserCache(Mock.Of<IUserManager>()));
        var text = File.ReadAllText(endpoints.SettingsPath(UserA));
        var unlocked = provider.Get(UserA);
        Assert.False(unlocked.QualityTagsEnabled);
        Assert.Equal(unlocked.Digest, PosterTagSettings.FromSettingsJson(text, endpoints.Config).Digest);

        endpoints.Save(c => c.LockedUserSettings = ["QualityTagsEnabled"]);
        var locked = provider.Get(UserA);
        Assert.True(locked.QualityTagsEnabled);
        Assert.NotEqual(unlocked.Digest, locked.Digest);
        // Same digest as a user who stores the admin value: the lock changes effective values only.
        var asAdmin = JObject.Parse(text);
        asAdmin["QualityTagsEnabled"] = true;
        Assert.Equal(PosterTagSettings.FromSettingsJson(asAdmin.ToString(), endpoints.Config).Digest, locked.Digest);
        Assert.Equal(locked.Digest, PosterTagSettings.FromSettingsJson(text, endpoints.Config).Digest);

        endpoints.Save(c => c.LockedUserSettings = []);
        Assert.Equal(unlocked.Digest, provider.Get(UserA).Digest);
    }

    // ---- recently unlocked

    [Fact]
    public void AStaleTabCannotWriteTheEnforcedValueOverTheChoiceAfterAnUnlock()
    {
        using var endpoints = WithChoices();
        endpoints.Save(c => c.LockedUserSettings = ["AutoPipEnabled", "QualityTagsEnabled"]);
        var staleDocument = endpoints.Get(); // what a tab loaded while the keys were locked
        endpoints.Save(c => c.LockedUserSettings = ["QualityTagsEnabled"]);
        Assert.Equal(["AutoPipEnabled"], RecentlyUnlockedSettings.Keys);

        Assert.True(endpoints.Get().Value<bool>("AutoPipEnabled"), "the choice is back after the unlock");
        var post = endpoints.Post(staleDocument.ToString());
        Assert.Equal(new Dictionary<string, string> { ["AutoPipEnabled"] = "stale" }, Rejections(post));
        Assert.True(endpoints.OnDisk().Value<bool>("AutoPipEnabled"));

        // A deliberate change through /patch still works, and a value other than the enforced one goes through the old route.
        Assert.Equal(["AutoPipEnabled"], Strings(endpoints.Patch("{\"Set\":{\"AutoPipEnabled\":false}}")["Applied"]));
        Assert.Empty(Rejections(endpoints.Post("{\"AutoPipEnabled\":true}")));
        Assert.True(endpoints.OnDisk().Value<bool>("AutoPipEnabled"));

        // Locking the key again forgets it.
        endpoints.Save(c => c.LockedUserSettings = ["AutoPipEnabled", "QualityTagsEnabled"]);
        Assert.Empty(RecentlyUnlockedSettings.Keys);
    }

    // ---- admin registry route

    [Fact]
    public void TheRegistryRouteIsAdminOnlyAndDescribesEveryKeyWithAnAdminDefault()
    {
        using var endpoints = WithChoices();
        endpoints.Save(c => c.LockedUserSettings = ["qualitytagsenabled", "Bogus"]);
        Assert.IsType<ForbidResult>(endpoints.Controller(UserA).GetUserSettingsRegistry());

        var entries = JArray.Parse(StjSerializer.Serialize(Assert.IsType<OkObjectResult>(endpoints.Controller(AdminUser, admin: true).GetUserSettingsRegistry()).Value));
        Assert.Equal(UserSettingsRegistry.All.Count(d => d.AdminProperty != null), entries.Count);
        var byKey = entries.ToDictionary(e => e.Value<string>("Key")!);
        Assert.Equal(["QualityTagsEnabled"], byKey.Values.Where(e => e.Value<bool>("Locked")).Select(e => e.Value<string>("Key")!));
        Assert.Equal("Both", byKey["QualityTagsEnabled"].Value<string>("EffectiveReach"));
        Assert.Equal("Web", byKey["AutoPipEnabled"].Value<string>("EffectiveReach"));
        Assert.Equal("autoPipEnabled", byKey["AutoPipEnabled"].Value<string>("ControlId"));
        Assert.Equal("DefaultSubtitleStyle", byKey["SelectedStylePresetIndex"].Value<string>("ControlId"));
        Assert.Equal("ResolutionTagOrder", byKey["ResolutionTagOrder"].Value<string>("RowKey"));
        Assert.Equal("WatchProgressDefaultMode", byKey["WatchProgressMode"].Value<string>("AdminKey"));
        Assert.False(byKey["PauseScreenDelaySeconds"].Value<bool>("Lockable"));
        Assert.Null(byKey["PauseScreenDelaySeconds"]["ControlId"]);
        Assert.False(byKey["AutoPipEnabled"].Value<bool>("AdminValue"));

        endpoints.Save(c => c.NativePosterTagsEnabled = false);
        entries = JArray.Parse(StjSerializer.Serialize(Assert.IsType<OkObjectResult>(endpoints.Controller(AdminUser, admin: true).GetUserSettingsRegistry()).Value));
        Assert.Equal("Web", entries.First(e => e.Value<string>("Key") == "QualityTagsEnabled").Value<string>("EffectiveReach"));
    }

    /// <summary>
    /// The registry route's answer for a fresh install, which the admin-page tests feed to the policy
    /// script (tests/frontend/pages/pages-admin-policy.test.mjs); regenerate with JE_UPDATE_GOLDENS=1.
    /// </summary>
    [Fact]
    public void TheRegistryRouteAnswerForAFreshInstallMatchesTheFrontendFixture()
    {
        using var endpoints = new Endpoints();
        endpoints.Plugin.Plugin.UpdateConfiguration(new PluginConfiguration());
        var actual = JArray.Parse(StjSerializer.Serialize(Assert.IsType<OkObjectResult>(endpoints.Controller(AdminUser, admin: true).GetUserSettingsRegistry()).Value));
        var path = Path.Combine(FixtureDirectory(), "admin-registry-default.json");
        if (Environment.GetEnvironmentVariable("JE_UPDATE_GOLDENS") == "1")
        {
            File.WriteAllText(path, actual.ToString(Newtonsoft.Json.Formatting.Indented) + "\n");
            return;
        }
        Assert.Equal(JArray.Parse(File.ReadAllText(path)).ToString(), actual.ToString());
    }

    /// <summary>
    /// The policy table and the panel rows are keyed by the registry; this golden list is what the
    /// frontend tests check the rendered panel against.
    /// </summary>
    [Fact]
    public void TheLockableKeyListMatchesTheFrontendFixture()
    {
        var path = Path.Combine(FixtureDirectory(), "lockable-keys.json");
        var actual = new JArray(UserSettingsRegistry.All.Where(d => d.Setting.Lockable).Select(d => d.Key));
        if (Environment.GetEnvironmentVariable("JE_UPDATE_GOLDENS") == "1")
        {
            File.WriteAllText(path, actual.ToString(Newtonsoft.Json.Formatting.Indented) + "\n");
            return;
        }
        Assert.Equal(JArray.Parse(File.ReadAllText(path)).ToString(), actual.ToString());
    }

    // ---- configuration round trips

    [Fact]
    public void AJsonNullFromTheAdminPageIsNormalisedAndNeverBreaksAPath()
    {
        using var endpoints = WithChoices();
        foreach (var options in new[] { JsonDefaults.Options, JsonDefaults.PascalCaseOptions })
        {
            var body = JObject.Parse(StjSerializer.Serialize(endpoints.Config, options));
            var name = body.Properties().First(p => string.Equals(p.Name, "LockedUserSettings", StringComparison.OrdinalIgnoreCase)).Name;
            body[name] = null;
            var incoming = StjSerializer.Deserialize<PluginConfiguration>(body.ToString(), options)!;
            Assert.Null(incoming.LockedUserSettings);
            endpoints.Plugin.Plugin.UpdateConfiguration(incoming);
            Assert.NotNull(endpoints.Config.LockedUserSettings);
            Assert.Empty(endpoints.Config.LockedUserSettings);
            Assert.True(endpoints.Get().Value<bool>("AutoPipEnabled"));
        }

        // A config object that is null anyway (set in code) is read as no locks.
        endpoints.Config.LockedUserSettings = null!;
        Assert.True(endpoints.GetWithMeta().Settings.Value<bool>("AutoPipEnabled"));
        Assert.Empty(Strings(endpoints.GetWithMeta().Meta["Locked"]));
    }

    private static string FixtureDirectory([CallerFilePath] string source = "")
        => Path.GetFullPath(Path.Combine(Path.GetDirectoryName(source)!, "..", "..", "fixtures", "settings"));

    private static string ToXml(PluginConfiguration config)
    {
        var serializer = new XmlSerializer(typeof(PluginConfiguration));
        var output = new StringBuilder();
        using (var writer = XmlWriter.Create(output, new XmlWriterSettings { Indent = true, Encoding = Encoding.UTF8 }))
        {
            serializer.Serialize(writer, config);
        }

        return output.ToString().Replace("\r\n", "\n");
    }

    /// <summary>
    /// XmlSerializer appends the stored Shortcuts to the constructor's list (the plugin dedupes them
    /// at startup, JellyfinEnhanced.BackfillMissingDefaultShortcuts), so round trips compare the rest.
    /// </summary>
    private static string WithoutShortcuts(string xml)
        => System.Text.RegularExpressions.Regex.Replace(xml, "  <Shortcuts>.*?</Shortcuts>\n", string.Empty, System.Text.RegularExpressions.RegexOptions.Singleline);

    private static PluginConfiguration FromXml(string xml)
    {
        using var reader = XmlReader.Create(new StringReader(xml));
        return (PluginConfiguration)new XmlSerializer(typeof(PluginConfiguration)).Deserialize(reader)!;
    }

    /// <summary>
    /// The XML a fresh install writes. Jellyfin replaces the whole admin config with defaults when
    /// the XML cannot be read, so any change here must be add-only; regenerate with JE_UPDATE_GOLDENS=1.
    /// </summary>
    [Fact]
    public void ADefaultConfigurationSerialisesToTheGoldenXml()
    {
        var path = Path.Combine(FixtureDirectory(), "plugin-configuration-default.xml");
        var actual = ToXml(new PluginConfiguration());
        if (Environment.GetEnvironmentVariable("JE_UPDATE_GOLDENS") == "1")
        {
            File.WriteAllText(path, actual + "\n");
            return;
        }
        Assert.Equal(File.ReadAllText(path).TrimEnd('\n'), actual);
        Assert.Contains("<LockedUserSettings />", actual);
    }

    [Fact]
    public void XmlFromBeforeLocksAndXmlWithLocksRoundTrip()
    {
        var golden = ToXml(new PluginConfiguration());
        // A config written by a release without LockedUserSettings.
        var old = golden.Replace("  <LockedUserSettings />\n", string.Empty);
        Assert.DoesNotContain("LockedUserSettings", old);
        var fromOld = FromXml(old);
        Assert.NotNull(fromOld.LockedUserSettings);
        Assert.Empty(fromOld.LockedUserSettings);
        Assert.Equal(WithoutShortcuts(golden), WithoutShortcuts(ToXml(fromOld)));

        var locked = new PluginConfiguration { LockedUserSettings = ["AutoPipEnabled", "NotASetting"], AutoPipEnabled = true };
        var xml = ToXml(locked);
        Assert.Contains("<string>AutoPipEnabled</string>", xml);
        var back = FromXml(xml);
        Assert.Equal(["AutoPipEnabled", "NotASetting"], back.LockedUserSettings);
        Assert.Equal(["AutoPipEnabled"], UserSettingsResolver.LockedKeys(back));
        Assert.Equal(WithoutShortcuts(xml), WithoutShortcuts(ToXml(back)));
        // Reading it again never appends (an array, not an initialised list).
        Assert.Equal(["AutoPipEnabled", "NotASetting"], FromXml(ToXml(back)).LockedUserSettings);

        // An explicit nil reads as an empty array.
        var nil = FromXml(golden.Replace("<LockedUserSettings />", "<LockedUserSettings xsi:nil=\"true\" />"));
        Assert.Empty(UserSettingsResolver.LockedKeys(nil));

        // A null that reaches UpdateConfiguration any other way is normalised.
        using var plugin = new ApiPluginFixture();
        plugin.Plugin.UpdateConfiguration(new PluginConfiguration { LockedUserSettings = null! });
        Assert.NotNull(plugin.Plugin.Configuration.LockedUserSettings);
        Assert.Empty(plugin.Plugin.Configuration.LockedUserSettings);
    }
}
