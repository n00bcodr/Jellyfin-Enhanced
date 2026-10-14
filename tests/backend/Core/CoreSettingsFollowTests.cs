using System.Security.Claims;
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
/// Following the server default (design item C3): a Following key tracks the admin default on the
/// web and in the native poster settings, Set takes it out, an Incidental key set back to the default
/// follows again, a stale whole-document post cannot pin an old default, Meta reports which keys
/// differ from the default, and NewUsersFollowDefaults decides how a new user is seeded. Legacy
/// files keep resolving to exactly what they store.
/// </summary>
[Collection("Plugin singleton")]
public class CoreSettingsFollowTests : IDisposable
{
    private static readonly Guid UserA = Guid.Parse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    private static readonly Guid UserB = Guid.Parse("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");

    public CoreSettingsFollowTests() => RecentlyUnlockedSettings.Clear();

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
            var next = StjSerializer.Deserialize<PluginConfiguration>(StjSerializer.Serialize(Config, JsonDefaults.Options), JsonDefaults.Options)!;
            change(next);
            Plugin.Plugin.UpdateConfiguration(next);
        }

        public JObject Patch(string body, Guid? user = null)
            => Body(Controller(user ?? UserA).PatchUserSettingsSettings((user ?? UserA).ToString(), Json(body)));

        public JObject Post(string body, Guid? user = null)
            => Body(Controller(user ?? UserA).SaveUserSettingsSettings((user ?? UserA).ToString(), Json(body)));

        public JObject Get(Guid? user = null) => Body(Controller(user ?? UserA).GetUserSettingsSettings((user ?? UserA).ToString()));

        public (JObject Settings, JObject Meta) GetWithMeta(Guid? user = null)
        {
            var body = Body(Controller(user ?? UserA).GetUserSettingsSettings((user ?? UserA).ToString(), meta: true));
            return ((JObject)body["Settings"]!, (JObject)body["Meta"]!);
        }

        public JObject OnDisk(Guid? user = null) => JObject.Parse(File.ReadAllText(SettingsPath(user ?? UserA)));

        public void Write(UserSettings settings, Guid? user = null) => Manager.SaveUserConfiguration((user ?? UserA).ToString("N"), "settings.json", settings);

        public void Dispose() => Plugin.Dispose();
    }

    private static System.Text.Json.JsonElement Json(string json)
    {
        using var document = System.Text.Json.JsonDocument.Parse(json);
        return document.RootElement.Clone();
    }

    private static JObject Body(IActionResult result) => JObject.Parse(StjSerializer.Serialize(Assert.IsAssignableFrom<ObjectResult>(result).Value));

    private static Dictionary<string, string> Rejections(JObject body)
        => ((JArray)body["Rejected"]!).ToDictionary(r => r.Value<string>("Key")!, r => r.Value<string>("Reason")!);

    private static string[] Strings(JToken? array) => array!.Values<string>().Select(v => v!).ToArray();

    private static string[] FollowableKeys() => UserSettingsRegistry.All.Where(UserSettingsRegistry.CanFollow).Select(d => d.Key).ToArray();

    // ---- legacy files

    [Fact]
    public void ALegacyFileResolvesToExactlyWhatItStoresAndIsNeverRewrittenByReads()
    {
        using var endpoints = new Endpoints();
        endpoints.Save(c => { c.AutoPipEnabled = true; c.QualityTagsEnabled = true; c.WatchProgressDefaultMode = "time"; c.ResolutionTagOrder = 5; c.NewUsersFollowDefaults = true; });
        // A partial file from an older release (no "_je"), values unlike the admin defaults, sentinels included.
        var legacy = "{\"AutoPipEnabled\":false,\"QualityTagsEnabled\":false,\"WatchProgressMode\":\"remaining\",\"ResolutionTagOrder\":null,\"QualityTagsPosition\":\"\",\"SubtitleVerticalPosition\":40}";
        var path = endpoints.Plugin.Core.Write(UserA.ToString("N"), legacy);
        var bytes = File.ReadAllBytes(path);

        var stored = endpoints.Manager.GetUserConfiguration<UserSettings>(UserA.ToString("N"), "settings.json");
        var expected = JObject.Parse(StjSerializer.Serialize(stored));
        expected["IsAdmin"] = false;
        var (settings, meta) = endpoints.GetWithMeta();
        Assert.True(JToken.DeepEquals(expected, settings), settings.ToString());
        Assert.True(JToken.DeepEquals(expected, endpoints.Get()));
        Assert.Equal(expected.ToString(), JObject.Parse(StjSerializer.Serialize(endpoints.Controller(UserA).GetBootstrap() is JsonResult json ? json.Value : null))["UserSettings"]!["Settings"]!.ToString());
        Assert.Equal(bytes, File.ReadAllBytes(path));

        // All Existing: nothing follows (NewUsersFollowDefaults only seeds new users).
        Assert.Empty(Strings(meta["Following"]));
        Assert.Empty(Strings(meta["Chosen"]));
        // Differs names the values that are not the default; the sentinels count as the default.
        var differs = Strings(meta["Differs"]);
        Assert.Contains("AutoPipEnabled", differs);
        Assert.Contains("QualityTagsEnabled", differs);
        Assert.Contains("WatchProgressMode", differs);
        Assert.DoesNotContain("ResolutionTagOrder", differs);
        Assert.DoesNotContain("QualityTagsPosition", differs);
        Assert.DoesNotContain("SubtitleVerticalPosition", differs); // no server default

        // The native poster path reads the same values.
        Assert.False(PosterTagSettings.FromSettingsJson(legacy, endpoints.Config).QualityTagsEnabled);
    }

    [Fact]
    public void DiffersListsOnlyKeysThatCanFollowAreNotLockedAndAreNotTheDefault()
    {
        using var endpoints = new Endpoints();
        endpoints.Save(c => { c.AutoPipEnabled = false; c.AutoPauseEnabled = true; c.AutoResumeEnabled = false; c.LockedUserSettings = ["AutoResumeEnabled"]; });
        endpoints.Write(new UserSettings { AutoPipEnabled = true, AutoPauseEnabled = true, AutoResumeEnabled = true, ShowFileSizes = true });
        endpoints.Patch("{\"Set\":{\"LongPress2xEnabled\":true},\"Follow\":[\"ShowFileSizes\"]}");
        var differs = Strings(endpoints.GetWithMeta().Meta["Differs"]);
        Assert.Contains("AutoPipEnabled", differs); // Existing, not the default
        Assert.Contains("LongPress2xEnabled", differs); // Chosen, not the default
        Assert.DoesNotContain("AutoPauseEnabled", differs); // equal to the default
        Assert.DoesNotContain("AutoResumeEnabled", differs); // locked
        Assert.DoesNotContain("ShowFileSizes", differs); // following
        Assert.All(differs, key => Assert.True(UserSettingsRegistry.TryGet(key, out var d) && UserSettingsRegistry.CanFollow(d), key));
    }

    // ---- following tracks the default, on the web and in the poster path

    [Fact]
    public void AFollowingKeyTracksAdminDefaultChangesOnTheWebAndInPosterTagSettings()
    {
        using var endpoints = new Endpoints();
        endpoints.Save(c => { c.NativePosterTagsEnabled = true; c.QualityTagsEnabled = false; c.QualityTagsPosition = "top-left"; c.ResolutionTagOrder = 1; c.ShowSourceTag = true; });
        endpoints.Write(new UserSettings { QualityTagsEnabled = true, QualityTagsPosition = "bottom-right", ResolutionTagOrder = 3, ShowSourceTag = false, GenreTagsEnabled = true });
        using var provider = new PosterTagSettingsProvider(endpoints.Manager, new PosterTagUserCache(Mock.Of<IUserManager>()));

        var followed = endpoints.Patch("{\"Follow\":[\"QualityTagsEnabled\",\"QualityTagsPosition\",\"ResolutionTagOrder\",\"ShowSourceTag\"]}");
        Assert.Empty(Rejections(followed));

        foreach (var (enabled, position, order, source) in new[] { (true, "bottom-left", 4, false), (false, "top-right", 2, true) })
        {
            endpoints.Save(c => { c.QualityTagsEnabled = enabled; c.QualityTagsPosition = position; c.ResolutionTagOrder = order; c.ShowSourceTag = source; });
            var web = endpoints.Get();
            Assert.Equal(enabled, web.Value<bool>("QualityTagsEnabled"));
            Assert.Equal(position, web.Value<string>("QualityTagsPosition"));
            Assert.Equal(order, web.Value<int>("ResolutionTagOrder"));
            Assert.Equal(source, web.Value<bool>("ShowSourceTag"));
            Assert.True(web.Value<bool>("GenreTagsEnabled"), "a key that does not follow keeps the user's value");

            var poster = provider.Get(UserA);
            Assert.Equal(web.Value<bool>("QualityTagsEnabled"), poster.QualityTagsEnabled);
            Assert.Equal(web.Value<string>("QualityTagsPosition"), poster.QualityTagsPosition);
            Assert.Equal(web.Value<int>("ResolutionTagOrder"), poster.ResolutionTagOrder);
            Assert.Equal(web.Value<bool>("ShowSourceTag"), poster.ShowSourceTag);
            Assert.Equal(web.Value<bool>("GenreTagsEnabled"), poster.GenreTagsEnabled);
            // Same images as a user who stores those values outright.
            var explicitValues = (JObject)web.DeepClone();
            explicitValues.Remove("IsAdmin");
            Assert.Equal(PosterTagSettings.FromSettingsJson(explicitValues.ToString(), endpoints.Config).Digest, poster.Digest);
            Assert.Equal(poster.Digest, PosterTagSettings.FromSettingsJson(File.ReadAllText(endpoints.SettingsPath(UserA)), endpoints.Config).Digest);
        }
    }

    [Fact]
    public void SetTakesAKeyOutOfFollowingEvenWhenTheValueEqualsTheDefault()
    {
        using var endpoints = new Endpoints();
        endpoints.Save(c => c.AutoPipEnabled = false);
        endpoints.Write(new UserSettings());
        endpoints.Patch("{\"Follow\":[\"AutoPipEnabled\",\"AutoPauseEnabled\"]}");

        var body = endpoints.Patch("{\"Set\":{\"AutoPipEnabled\":false}}");
        Assert.Equal(["AutoPipEnabled"], Strings(body["Applied"]));
        Assert.Equal(["AutoPauseEnabled"], Strings(body["Meta"]!["Following"]));
        Assert.Equal(["AutoPipEnabled"], Strings(body["Meta"]!["Chosen"]));

        // A chosen value equal to today's default is not adopted: it stays put when the default moves.
        endpoints.Save(c => { c.AutoPipEnabled = true; c.AutoPauseEnabled = false; });
        var served = endpoints.Get();
        Assert.False(served.Value<bool>("AutoPipEnabled"));
        Assert.False(served.Value<bool>("AutoPauseEnabled"), "the other key still follows");
        Assert.Equal(["AutoPipEnabled"], Strings(endpoints.OnDisk()["_je"]!["Chosen"]));
    }

    // ---- incidental keys

    [Theory]
    [InlineData("WatchProgressMode", "\"time\"", "\"percentage\"")]
    [InlineData("ReviewsExpandedByDefault", "true", "false")]
    public void AnIncidentalSetEqualToTheDefaultRestoresFollowing(string key, string other, string defaultValue)
    {
        using var endpoints = new Endpoints();
        endpoints.Save(c => { c.WatchProgressDefaultMode = "percentage"; c.ReviewsExpandedByDefault = false; });
        endpoints.Write(new UserSettings());

        // Browsing away from the default makes it a choice...
        var body = endpoints.Patch($"{{\"Set\":{{\"{key}\":{other}}}}}");
        Assert.Equal([key], Strings(body["Meta"]!["Chosen"]));
        Assert.Empty(Strings(body["Meta"]!["Following"]));

        // ...and coming back to it follows the default again.
        body = endpoints.Patch($"{{\"Set\":{{\"{key}\":{defaultValue}}}}}");
        Assert.Equal([key], Strings(body["Applied"]));
        Assert.Equal([key], Strings(body["Meta"]!["Following"]));
        Assert.Empty(Strings(body["Meta"]!["Chosen"]));
        Assert.Equal([key], Strings(endpoints.OnDisk()["_je"]!["Following"]));

        endpoints.Save(c => { c.WatchProgressDefaultMode = "remaining"; c.ReviewsExpandedByDefault = true; });
        var served = endpoints.Get();
        Assert.Equal(key == "WatchProgressMode" ? "remaining" : "True", served[key]!.ToString());
    }

    [Fact]
    public void TheIncidentalRuleUsesTheResolvedDefaultAndLeavesOtherKeysAndLocksAlone()
    {
        using var endpoints = new Endpoints();
        // A blank admin mode resolves to the initializer: "percentage" is the default.
        endpoints.Save(c => { c.WatchProgressDefaultMode = " "; c.AutoPipEnabled = false; c.ReviewsExpandedByDefault = false; c.LockedUserSettings = ["ReviewsExpandedByDefault"]; });
        endpoints.Write(new UserSettings { WatchProgressMode = "time" });

        var body = endpoints.Patch("{\"Set\":{\"WatchProgressMode\":\"percentage\",\"AutoPipEnabled\":false,\"ReviewsExpandedByDefault\":false}}");
        Assert.Equal(new Dictionary<string, string> { ["ReviewsExpandedByDefault"] = "locked" }, Rejections(body));
        Assert.Equal(["WatchProgressMode"], Strings(body["Meta"]!["Following"]));
        // Not incidental: a Set equal to the default is a choice like any other.
        Assert.Equal(["AutoPipEnabled"], Strings(body["Meta"]!["Chosen"]));

        // Another value than the default is a choice.
        body = endpoints.Patch("{\"Set\":{\"WatchProgressMode\":\"remaining\"}}");
        Assert.Equal(["AutoPipEnabled", "WatchProgressMode"], Strings(body["Meta"]!["Chosen"]));
    }

    [Fact]
    public void TheLegacyPostNeverTurnsAnIncidentalValueIntoFollowing()
    {
        // Design 7.5: whole-document posts store a changed value as a choice; only /patch follows.
        using var endpoints = new Endpoints();
        endpoints.Save(c => c.WatchProgressDefaultMode = "percentage");
        endpoints.Write(new UserSettings { WatchProgressMode = "time" });
        Assert.Empty(Rejections(endpoints.Post("{\"WatchProgressMode\":\"percentage\"}")));
        var disk = endpoints.OnDisk();
        Assert.Equal("percentage", disk.Value<string>("WatchProgressMode"));
        Assert.Equal(["WatchProgressMode"], Strings(disk["_je"]!["Chosen"]));
    }

    // ---- stale tabs

    [Fact]
    public void AStaleTabAfterAdoptionAndADefaultChangeCannotPinTheOldDefault()
    {
        using var endpoints = new Endpoints();
        endpoints.Save(c => { c.AutoPipEnabled = false; c.WatchProgressDefaultMode = "percentage"; });
        endpoints.Write(new UserSettings { AutoPipEnabled = false, WatchProgressMode = "percentage" });
        var staleTab = endpoints.Get(); // a tab that loaded before the keys started following

        // The user (another tab or device) makes both keys follow the default; then the admin changes it.
        Assert.Empty(Rejections(endpoints.Patch("{\"Follow\":[\"AutoPipEnabled\",\"WatchProgressMode\"]}")));
        endpoints.Save(c => { c.AutoPipEnabled = true; c.WatchProgressDefaultMode = "time"; });

        // The stale tab saves its whole document (old defaults included) after an unrelated change.
        staleTab["AutoResumeEnabled"] = true;
        var post = endpoints.Post(staleTab.ToString());
        Assert.Equal(new Dictionary<string, string> { ["AutoPipEnabled"] = "following", ["WatchProgressMode"] = "following" }, Rejections(post));

        var served = endpoints.Get();
        Assert.True(served.Value<bool>("AutoPipEnabled"));
        Assert.Equal("time", served.Value<string>("WatchProgressMode"));
        Assert.True(served.Value<bool>("AutoResumeEnabled"));
        // The write refreshed the cached copies to the current defaults.
        var disk = endpoints.OnDisk();
        Assert.True(disk.Value<bool>("AutoPipEnabled"));
        Assert.Equal("time", disk.Value<string>("WatchProgressMode"));
        Assert.Equal(["AutoPipEnabled", "WatchProgressMode"], Strings(disk["_je"]!["Following"]));

        // The default moves again: still following.
        endpoints.Save(c => c.AutoPipEnabled = false);
        Assert.False(endpoints.Get().Value<bool>("AutoPipEnabled"));
    }

    // ---- new users

    [Fact]
    public void NewUsersAreSeededAsBeforeWhileNewUsersFollowDefaultsIsOff()
    {
        using var endpoints = new Endpoints();
        Assert.False(new PluginConfiguration().NewUsersFollowDefaults);
        endpoints.Save(c => c.AutoPipEnabled = true);
        var served = endpoints.Get();
        var disk = endpoints.OnDisk();
        Assert.Null(disk["_je"]);
        Assert.True(served.Value<bool>("AutoPipEnabled"));
        Assert.Empty(Strings(endpoints.GetWithMeta().Meta["Following"]));

        // A copy, not a link: the default moving later does not move the user's value.
        endpoints.Save(c => c.AutoPipEnabled = false);
        Assert.True(endpoints.Get().Value<bool>("AutoPipEnabled"));
    }

    [Fact]
    public void WithNewUsersFollowDefaultsOnANewUserFollowsEveryInheritableKey()
    {
        using var endpoints = new Endpoints();
        endpoints.Save(c => { c.NewUsersFollowDefaults = true; c.AutoPipEnabled = true; c.WatchProgressDefaultMode = "time"; c.QualityTagsEnabled = true; c.NativePosterTagsEnabled = true; });
        endpoints.Write(new UserSettings { AutoPipEnabled = false }, UserB); // an existing user

        var (settings, meta) = endpoints.GetWithMeta();
        Assert.Equal(FollowableKeys(), Strings(meta["Following"]));
        Assert.Empty(Strings(meta["Differs"]));
        Assert.True(settings.Value<bool>("AutoPipEnabled"));
        var disk = endpoints.OnDisk();
        Assert.Equal(FollowableKeys(), Strings(disk["_je"]!["Following"]));
        // The file is complete: every value is cached, exactly as the copy seed would write it.
        var copy = JObject.Parse(Newtonsoft.Json.JsonConvert.SerializeObject(UserSettingsRegistry.BuildDefaults(endpoints.Config)));
        var values = (JObject)disk.DeepClone();
        values.Remove("_je");
        Assert.True(JToken.DeepEquals(copy, values));

        endpoints.Save(c => { c.AutoPipEnabled = false; c.WatchProgressDefaultMode = "remaining"; c.QualityTagsEnabled = false; });
        var served = endpoints.Get();
        Assert.False(served.Value<bool>("AutoPipEnabled"));
        Assert.Equal("remaining", served.Value<string>("WatchProgressMode"));
        using var provider = new PosterTagSettingsProvider(endpoints.Manager, new PosterTagUserCache(Mock.Of<IUserManager>()));
        Assert.False(provider.Get(UserA).QualityTagsEnabled);

        // The existing user is untouched; user-only keys keep their initializers and never follow.
        Assert.False(endpoints.GetWithMeta(UserB).Settings.Value<bool>("AutoPipEnabled"));
        Assert.Null(endpoints.OnDisk(UserB)["_je"]);
        Assert.DoesNotContain("SubtitleVerticalPosition", FollowableKeys());
        Assert.DoesNotContain("UseNativePosterTags", FollowableKeys());
    }

    [Fact]
    public void AReSeedAfterAQuarantineIsACopyEvenWithNewUsersFollowDefaultsOn()
    {
        using var endpoints = new Endpoints();
        endpoints.Save(c => c.NewUsersFollowDefaults = true);
        endpoints.Plugin.Core.Write(UserA.ToString("N"), "null");
        endpoints.Get();
        Assert.Null(endpoints.OnDisk()["_je"]);
    }

    [Fact]
    public void NewUsersFollowDefaultsIsAddOnlyInTheAdminXml()
    {
        var serializer = new XmlSerializer(typeof(PluginConfiguration));
        string ToXml(PluginConfiguration config)
        {
            using var writer = new StringWriter();
            serializer.Serialize(writer, config);
            return writer.ToString();
        }

        PluginConfiguration FromXml(string xml)
        {
            using var reader = XmlReader.Create(new StringReader(xml));
            return (PluginConfiguration)serializer.Deserialize(reader)!;
        }

        var golden = ToXml(new PluginConfiguration());
        Assert.Contains("<NewUsersFollowDefaults>false</NewUsersFollowDefaults>", golden);
        // A config written by a release without the option reads as off.
        var old = golden.Replace("<NewUsersFollowDefaults>false</NewUsersFollowDefaults>", string.Empty);
        Assert.False(FromXml(old).NewUsersFollowDefaults);
        Assert.True(FromXml(ToXml(new PluginConfiguration { NewUsersFollowDefaults = true })).NewUsersFollowDefaults);
    }
}
