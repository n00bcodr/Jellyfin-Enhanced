using System.Security.Claims;
using System.Security.Cryptography;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using Microsoft.AspNetCore.Mvc;
using Moq;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Newtonsoft.Json.Serialization;
using StjSerializer = System.Text.Json.JsonSerializer;

namespace JE.Tests;

/// <summary>
/// Key-level settings writes with provenance (design item C1): the "_je" block on disk, Meta as a
/// sibling in GET ?meta=true and bootstrap, POST settings.json/patch with per-key rejections, and the
/// legacy whole-document POST reduced to the registry keys actually present in its body.
/// </summary>
[Collection("Plugin singleton")]
public class CoreSettingsPatchTests
{
    private static readonly Guid UserA = Guid.Parse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    private static readonly Guid UserB = Guid.Parse("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");

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

        /// <summary>POST settings.json/patch as <paramref name="caller"/> for <paramref name="target"/>.</summary>
        public IActionResult Patch(string body, Guid? caller = null, Guid? target = null, bool admin = false)
            => Controller(caller ?? UserA, admin).PatchUserSettingsSettings((target ?? UserA).ToString(), Json(body));

        public IActionResult Post(string body, Guid? caller = null, Guid? target = null, bool admin = false)
            => Controller(caller ?? UserA, admin).SaveUserSettingsSettings((target ?? UserA).ToString(), Json(body));

        /// <summary>GET settings.json?meta=true: (Settings, Meta).</summary>
        public (JObject Settings, JObject Meta) GetWithMeta(Guid? user = null)
        {
            var body = Body(Controller(user ?? UserA).GetUserSettingsSettings((user ?? UserA).ToString(), meta: true));
            return ((JObject)body["Settings"]!, (JObject)body["Meta"]!);
        }

        public JObject Get(Guid? user = null) => Body(Controller(user ?? UserA).GetUserSettingsSettings((user ?? UserA).ToString()));

        /// <summary>The stored file as JSON (with "_je").</summary>
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

    private static JObject Ok(IActionResult result)
    {
        var ok = Assert.IsType<OkObjectResult>(result);
        return JObject.Parse(StjSerializer.Serialize(ok.Value));
    }

    private static int Status(IActionResult result) => result switch
    {
        ObjectResult objectResult => objectResult.StatusCode ?? 200,
        StatusCodeResult code => code.StatusCode,
        ForbidResult => 403,
        _ => throw new InvalidOperationException(result.GetType().Name),
    };

    private static string[] Strings(JToken? array) => array!.Values<string>().Select(v => v!).ToArray();

    private static Dictionary<string, string> Rejections(JObject body)
        => ((JArray)body["Rejected"]!).ToDictionary(r => r.Value<string>("Key")!, r => r.Value<string>("Reason")!);

    private static string Revision(string path)
        => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))).Substring(0, 12).ToLowerInvariant();

    // ---- access

    [Fact]
    public void OnlyTheOwnerOrAnAdminCanReadOrWriteAUsersSettings()
    {
        using var endpoints = new Endpoints();
        endpoints.Write(new UserSettings { AutoPipEnabled = false });
        var before = File.ReadAllText(endpoints.SettingsPath(UserA));

        // Another (non-admin) user is refused on every route, and nothing is written.
        Assert.Equal(403, Status(endpoints.Patch("{\"Set\":{\"AutoPipEnabled\":true}}", caller: UserB)));
        Assert.Equal(403, Status(endpoints.Post("{\"AutoPipEnabled\":true}", caller: UserB)));
        Assert.Equal(403, Status(endpoints.Controller(UserB).GetUserSettingsSettings(UserA.ToString(), meta: true)));
        Assert.Equal(before, File.ReadAllText(endpoints.SettingsPath(UserA)));
        Assert.False(File.Exists(endpoints.SettingsPath(UserB)));

        // An administrator may write it; the value is marked as changed by the admin.
        var body = Ok(endpoints.Patch("{\"Set\":{\"AutoPipEnabled\":true}}", caller: UserB, admin: true));
        Assert.Equal(new[] { "AutoPipEnabled" }, Strings(body["Applied"]));
        Assert.Equal(new[] { "AutoPipEnabled" }, Strings(body["Meta"]!["ChangedByAdmin"]));
        // The owner setting it again takes the admin marker off.
        body = Ok(endpoints.Patch("{\"Set\":{\"AutoPipEnabled\":true}}"));
        Assert.Empty(Strings(body["Meta"]!["ChangedByAdmin"]));
        Assert.Equal(new[] { "AutoPipEnabled" }, Strings(body["Meta"]!["Chosen"]));
    }

    // ---- patch

    [Fact]
    public void PatchSetsKeysAsChosenAndAnswersTheResolvedDocument()
    {
        using var endpoints = new Endpoints();
        endpoints.Write(new UserSettings { SubtitleVerticalPosition = 70, LastOpenedTab = "shortcuts" });

        var body = Ok(endpoints.Patch("{\"Set\":{\"AutoPipEnabled\":true,\"subtitleVerticalPosition\":40,\"WatchProgressMode\":\"time\"}}"));
        Assert.True(body.Value<bool>("success"));
        Assert.Equal(new[] { "AutoPipEnabled", "SubtitleVerticalPosition", "WatchProgressMode" }, Strings(body["Applied"]));
        Assert.Empty((JArray)body["Rejected"]!);

        var disk = endpoints.OnDisk();
        Assert.True(disk.Value<bool>("AutoPipEnabled"));
        Assert.Equal(40, disk.Value<int>("SubtitleVerticalPosition"));
        Assert.Equal("time", disk.Value<string>("WatchProgressMode"));
        Assert.Equal(new[] { "AutoPipEnabled", "SubtitleVerticalPosition", "WatchProgressMode" }, Strings(disk["_je"]!["Chosen"]));
        Assert.Equal(2, disk["_je"]!.Value<int>("Schema"));

        // Revision: the first 12 hex digits of the SHA-256 of the stored bytes.
        Assert.Equal(Revision(endpoints.SettingsPath(UserA)), body.Value<string>("Revision"));
        Assert.Equal(body.Value<string>("Revision"), body["Meta"]!.Value<string>("Revision"));
        // The answer carries the served document (with IsAdmin) and Meta, never "_je".
        var settings = (JObject)body["Settings"]!;
        Assert.False(settings.Value<bool>("IsAdmin"));
        Assert.Null(settings["_je"]);
        Assert.Null(settings["Meta"]);
        Assert.True(JToken.DeepEquals(endpoints.Get(), settings));
    }

    [Fact]
    public void UnknownAndInvalidKeysAreRejectedOneByOneAndTheRestApplies()
    {
        using var endpoints = new Endpoints();
        endpoints.Write(new UserSettings());
        var body = Ok(endpoints.Patch(@"{""Set"":{
            ""AutoPipEnabled"": true,
            ""Bogus"": 1, ""IsAdmin"": true, ""LastOpenedTab"": ""ui"", ""_je"": {""Following"":[""AutoPauseEnabled""]}, ""Meta"": {},
            ""SubtitleVerticalPosition"": 500, ""PauseScreenDelaySeconds"": 0, ""SelectedFontSizePresetIndex"": ""big"",
            ""WatchProgressMode"": ""sometimes"", ""QualityTagsPosition"": ""middle"",
            ""CustomSubtitleTextColor"": ""<img src=x onerror=alert(1)>"", ""RandomSourceId"": """ + new string('x', 65) + @""",
            ""AutoPauseEnabled"": ""yes"", ""ShowFileSizes"": null, ""ResolutionTagOrder"": 9,
            ""DisplayLanguage"": ""de"", ""ResolutionTagOrder "": 1
        }}"));
        Assert.Equal(new[] { "AutoPipEnabled", "DisplayLanguage" }, Strings(body["Applied"]));
        var rejected = Rejections(body);
        foreach (var key in new[] { "Bogus", "IsAdmin", "LastOpenedTab", "_je", "Meta", "ResolutionTagOrder " })
        {
            Assert.Equal("unknown", rejected[key]);
        }
        foreach (var key in new[] { "SubtitleVerticalPosition", "PauseScreenDelaySeconds", "SelectedFontSizePresetIndex", "WatchProgressMode",
            "QualityTagsPosition", "CustomSubtitleTextColor", "RandomSourceId", "AutoPauseEnabled", "ShowFileSizes", "ResolutionTagOrder" })
        {
            Assert.Equal("invalid", rejected[key]);
        }
        Assert.Equal(16, rejected.Count);

        var disk = endpoints.OnDisk();
        Assert.True(disk.Value<bool>("AutoPipEnabled"));
        Assert.Equal("de", disk.Value<string>("DisplayLanguage"));
        Assert.Equal(85, disk.Value<int>("SubtitleVerticalPosition"));
        Assert.Equal("#FFFFFFFF", disk.Value<string>("CustomSubtitleTextColor"));
        Assert.Null(disk["IsAdmin"]);
        Assert.Null(disk["Bogus"]);
        Assert.Equal(string.Empty, disk.Value<string>("LastOpenedTab"));
        Assert.Equal(new[] { "AutoPipEnabled", "DisplayLanguage" }, Strings(disk["_je"]!["Chosen"]));
        Assert.Empty(Strings(disk["_je"]!["Following"]));
    }

    [Fact]
    public void ValuesAreCoercedToTheKeysTypes()
    {
        using var endpoints = new Endpoints();
        endpoints.Write(new UserSettings { ResolutionTagOrder = 2, UseNativePosterTags = false });
        var body = Ok(endpoints.Patch("{\"Set\":{\"PauseScreenDelaySeconds\":\"12\",\"AutoSkipIntro\":\"true\",\"ResolutionTagOrder\":null,\"UseNativePosterTags\":null,\"CustomSubtitleBgColor\":\"#11223344\",\"QualityTagsPosition\":\"\"}}"));
        Assert.Empty((JArray)body["Rejected"]!);
        var disk = endpoints.OnDisk();
        Assert.Equal(12, disk.Value<int>("PauseScreenDelaySeconds"));
        Assert.True(disk.Value<bool>("AutoSkipIntro"));
        Assert.Equal(JTokenType.Null, disk["ResolutionTagOrder"]!.Type);
        Assert.Equal(JTokenType.Null, disk["UseNativePosterTags"]!.Type);
        Assert.Equal("#11223344", disk.Value<string>("CustomSubtitleBgColor"));
        Assert.Equal(string.Empty, disk.Value<string>("QualityTagsPosition"));
    }

    [Fact]
    public void FollowTracksTheAdminDefaultAndSetMakesTheKeyChosenAgain()
    {
        using var endpoints = new Endpoints();
        endpoints.Config.AutoPipEnabled = false;
        endpoints.Config.WatchProgressDefaultMode = "  ";
        endpoints.Write(new UserSettings { AutoPipEnabled = true, WatchProgressMode = "remaining", QualityTagsPreferredAudioLanguage = "fra" });

        var body = Ok(endpoints.Patch("{\"Follow\":[\"AutoPipEnabled\",\"watchProgressMode\",\"QualityTagsPreferredAudioLanguage\",\"SubtitleVerticalPosition\",\"Nope\"]}"));
        Assert.Equal(new[] { "AutoPipEnabled", "WatchProgressMode", "QualityTagsPreferredAudioLanguage" }, Strings(body["Applied"]));
        Assert.Equal(new Dictionary<string, string> { ["SubtitleVerticalPosition"] = "invalid", ["Nope"] = "unknown" }, Rejections(body));
        // Following resolves (and caches on disk) what the seed would write: a blank admin mode gives
        // the initializer, the audio language keeps its "" sentinel.
        var disk = endpoints.OnDisk();
        Assert.False(disk.Value<bool>("AutoPipEnabled"));
        Assert.Equal("percentage", disk.Value<string>("WatchProgressMode"));
        Assert.Equal(string.Empty, disk.Value<string>("QualityTagsPreferredAudioLanguage"));
        Assert.Equal(new[] { "AutoPipEnabled", "WatchProgressMode", "QualityTagsPreferredAudioLanguage" }, Strings(disk["_je"]!["Following"]));

        // The admin changes the default: the served value follows at once, the poster path too.
        endpoints.Config.AutoPipEnabled = true;
        var (settings, meta) = endpoints.GetWithMeta();
        Assert.True(settings.Value<bool>("AutoPipEnabled"));
        Assert.True(meta["Defaults"]!.Value<bool>("AutoPipEnabled"));
        Assert.Equal(new[] { "AutoPipEnabled", "WatchProgressMode", "QualityTagsPreferredAudioLanguage" }, Strings(meta["Following"]));
        Assert.False(endpoints.OnDisk().Value<bool>("AutoPipEnabled"), "a read never writes");

        // The next write of any key refreshes the cached value.
        Ok(endpoints.Patch("{\"Set\":{\"AutoResumeEnabled\":true}}"));
        Assert.True(endpoints.OnDisk().Value<bool>("AutoPipEnabled"));

        // Set takes the key out of Following.
        body = Ok(endpoints.Patch("{\"Set\":{\"AutoPipEnabled\":true}}"));
        Assert.Equal(new[] { "WatchProgressMode", "QualityTagsPreferredAudioLanguage" }, Strings(body["Meta"]!["Following"]));
        Assert.Contains("AutoPipEnabled", Strings(body["Meta"]!["Chosen"]));
        endpoints.Config.AutoPipEnabled = false;
        Assert.True(endpoints.Get().Value<bool>("AutoPipEnabled"), "a chosen value does not follow the default");
    }

    [Fact]
    public void AFollowingKeyReachesNativePosterSettings()
    {
        using var endpoints = new Endpoints();
        endpoints.Config.QualityTagsEnabled = false;
        endpoints.Write(new UserSettings { QualityTagsEnabled = true });
        Ok(endpoints.Patch("{\"Follow\":[\"QualityTagsEnabled\"]}"));
        endpoints.Config.QualityTagsEnabled = true;
        var text = File.ReadAllText(endpoints.SettingsPath(UserA));
        Assert.False(JObject.Parse(text).Value<bool>("QualityTagsEnabled"), "the cache still holds the old default");
        Assert.True(PosterTagSettings.FromSettingsJson(text, endpoints.Config).QualityTagsEnabled);
        endpoints.Config.QualityTagsEnabled = false;
        Assert.False(PosterTagSettings.FromSettingsJson(text, endpoints.Config).QualityTagsEnabled);
    }

    [Fact]
    public void AStaleIfRevisionIsAConflictAndChangesNothing()
    {
        using var endpoints = new Endpoints();
        endpoints.Write(new UserSettings());
        var (_, meta) = endpoints.GetWithMeta();
        var revision = meta.Value<string>("Revision")!;
        Assert.Equal(Revision(endpoints.SettingsPath(UserA)), revision);

        var body = Ok(endpoints.Patch($"{{\"Set\":{{\"AutoPipEnabled\":true}},\"IfRevision\":\"{revision}\"}}"));
        var next = body.Value<string>("Revision")!;
        Assert.NotEqual(revision, next);
        var stored = File.ReadAllText(endpoints.SettingsPath(UserA));

        var conflict = endpoints.Patch($"{{\"Set\":{{\"AutoPauseEnabled\":true}},\"IfRevision\":\"{revision}\"}}");
        Assert.Equal(409, Status(conflict));
        var current = Body(conflict);
        Assert.False(current.Value<bool>("success"));
        Assert.Equal(next, current.Value<string>("Revision"));
        Assert.True(current["Settings"]!.Value<bool>("AutoPipEnabled"));
        Assert.Equal(next, current["Meta"]!.Value<string>("Revision"));
        Assert.Equal(stored, File.ReadAllText(endpoints.SettingsPath(UserA)));

        // A no-op patch keeps the revision (nothing is written).
        Assert.Equal(next, Ok(endpoints.Patch("{\"Set\":{\"AutoPipEnabled\":true}}")).Value<string>("Revision"));
        Assert.Equal(stored, File.ReadAllText(endpoints.SettingsPath(UserA)));
    }

    [Theory]
    [InlineData("[]")]
    [InlineData("\"Set\"")]
    [InlineData("{\"Set\":[\"AutoPipEnabled\"]}")]
    [InlineData("{\"Set\":true}")]
    [InlineData("{\"Follow\":\"AutoPipEnabled\"}")]
    [InlineData("{\"Follow\":[1]}")]
    [InlineData("{\"IfRevision\":12}")]
    public void AMalformedPatchIsABadRequest(string patch)
    {
        using var endpoints = new Endpoints();
        endpoints.Write(new UserSettings());
        var stored = File.ReadAllText(endpoints.SettingsPath(UserA));
        var result = endpoints.Patch(patch);
        Assert.Equal(400, Status(result));
        Assert.False(Body(result).Value<bool>("success"));
        Assert.Equal(stored, File.ReadAllText(endpoints.SettingsPath(UserA)));
    }

    [Fact]
    public void APatchForAUserWithoutAFileStartsFromTheAdminDefaults()
    {
        using var endpoints = new Endpoints();
        endpoints.Config.AutoPauseEnabled = true;
        var body = Ok(endpoints.Patch("{\"Set\":{\"AutoPipEnabled\":true}}"));
        var disk = endpoints.OnDisk();
        Assert.True(disk.Value<bool>("AutoPauseEnabled"));
        Assert.True(disk.Value<bool>("AutoPipEnabled"));
        Assert.Equal("shortcuts", disk.Value<string>("LastOpenedTab"));
        Assert.Equal(new[] { "AutoPipEnabled" }, Strings(body["Meta"]!["Chosen"]));
    }

    [Fact]
    public async Task ConcurrentPatchesOfDifferentKeysAllLand()
    {
        // Two devices change different keys at the same time: each patch is a locked
        // read-modify-write of its own keys, so neither reverts the other (a whole-document
        // POST from either device would have written back its stale copy of the other key).
        using var endpoints = new Endpoints();
        endpoints.Write(new UserSettings());
        for (var i = 0; i < 40; i++)
        {
            var a = endpoints.Controller(UserA);
            var b = endpoints.Controller(UserA);
            using var start = new Barrier(2);
            var position = 10 + i;
            var on = i % 2 == 0;
            var first = Task.Run(() => { start.SignalAndWait(); return a.PatchUserSettingsSettings(UserA.ToString(), Json($"{{\"Set\":{{\"SubtitleVerticalPosition\":{position}}}}}")); });
            var second = Task.Run(() => { start.SignalAndWait(); return b.PatchUserSettingsSettings(UserA.ToString(), Json($"{{\"Set\":{{\"AutoPipEnabled\":{(on ? "true" : "false")}}}}}")); });
            var results = await Task.WhenAll(first, second).WaitAsync(TimeSpan.FromSeconds(10));
            Assert.All(results, result => Assert.IsType<OkObjectResult>(result));
            var disk = endpoints.OnDisk();
            Assert.Equal(position, disk.Value<int>("SubtitleVerticalPosition"));
            Assert.Equal(on, disk.Value<bool>("AutoPipEnabled"));
        }
    }

    // ---- legacy whole-document POST

    [Fact]
    public void AnOldBundlesWholeDocumentChangesOnlyTheKeysThatDiffer()
    {
        using var endpoints = new Endpoints();
        endpoints.Config.AutoPauseEnabled = true;
        // The served document, as an older bundle holds it, posted back unchanged: nothing is written,
        // so re-posting a loaded document never turns defaults into choices.
        var served = endpoints.Get();
        var seeded = File.ReadAllText(endpoints.SettingsPath(UserA));
        var body = Ok(endpoints.Post(served.ToString()));
        Assert.True(body.Value<bool>("success"));
        Assert.Equal("settings.json", body.Value<string>("file"));
        Assert.Empty((JArray)body["Rejected"]!);
        Assert.Equal(seeded, File.ReadAllText(endpoints.SettingsPath(UserA)));

        // One toggle changed in the whole document: only that key is stored and becomes Chosen.
        served["AutoPipEnabled"] = true;
        Ok(endpoints.Post(served.ToString()));
        var disk = endpoints.OnDisk();
        Assert.True(disk.Value<bool>("AutoPipEnabled"));
        Assert.Equal(new[] { "AutoPipEnabled" }, Strings(disk["_je"]!["Chosen"]));
        Assert.Null(disk["IsAdmin"]);
        var (_, meta) = endpoints.GetWithMeta();
        Assert.Equal(new[] { "AutoPipEnabled" }, Strings(meta["Chosen"]));

        // Case-insensitive keys, as the typed binding read them.
        Ok(endpoints.Post("{\"autoPipEnabled\":false}"));
        Assert.False(endpoints.OnDisk().Value<bool>("AutoPipEnabled"));
    }

    [Fact]
    public void ABodyWithoutANewerKeyLeavesItUnchanged()
    {
        // A tab running an older bundle posts a document that does not know the newer keys. The
        // typed binding filled them with their initializers and saved those; now they stay as stored.
        using var endpoints = new Endpoints();
        endpoints.Write(new UserSettings { CalendarDefaultViewMode = "month", QualityTagsPreferredAudioLanguage = "jpn", ReviewsExpandedByDefault = true });
        var older = endpoints.Get();
        foreach (var key in new[] { "CalendarDefaultViewMode", "QualityTagsPreferredAudioLanguage", "ReviewsExpandedByDefault" }) older.Remove(key);
        older["AutoPipEnabled"] = true;
        Ok(endpoints.Post(older.ToString()));
        var disk = endpoints.OnDisk();
        Assert.True(disk.Value<bool>("AutoPipEnabled"));
        Assert.Equal("month", disk.Value<string>("CalendarDefaultViewMode"));
        Assert.Equal("jpn", disk.Value<string>("QualityTagsPreferredAudioLanguage"));
        Assert.True(disk.Value<bool>("ReviewsExpandedByDefault"));
    }

    [Fact]
    public void ClientSentProvenanceAndIsAdminAreIgnored()
    {
        using var endpoints = new Endpoints();
        endpoints.Write(new UserSettings());
        Ok(endpoints.Patch("{\"Follow\":[\"AutoPauseEnabled\"]}"));
        var before = endpoints.OnDisk()["_je"]!.DeepClone();

        Ok(endpoints.Post(@"{""IsAdmin"":true,""_je"":{""Schema"":2,""Following"":[""AutoPipEnabled""],""Chosen"":[""AutoPauseEnabled""]},
            ""JeMeta"":{""Locked"":[""AutoPipEnabled""]},""SettingsMeta"":{""Following"":[]},""Meta"":{""Chosen"":[""AutoPipEnabled""]},""DisableAllShortcuts"":true,""ShowFileSizes"":true}"));
        var disk = endpoints.OnDisk();
        foreach (var key in new[] { "IsAdmin", "JeMeta", "SettingsMeta", "Meta", "DisableAllShortcuts" }) Assert.Null(disk[key]);
        Assert.True(disk.Value<bool>("ShowFileSizes"));
        // "_je" still comes from disk: only the posted ShowFileSizes became Chosen.
        Assert.Equal(Strings(before["Following"]), Strings(disk["_je"]!["Following"]));
        Assert.Equal(new[] { "ShowFileSizes" }, Strings(disk["_je"]!["Chosen"]));

        // The GET never serves "_je"; IsAdmin is the caller's.
        var served = endpoints.Get();
        Assert.Null(served["_je"]);
        Assert.Null(served["Meta"]);
        Assert.False(served.Value<bool>("IsAdmin"));
    }

    [Fact]
    public void TheLegacyPostRefusesFollowingKeysAndInvalidValuesPerKey()
    {
        using var endpoints = new Endpoints();
        endpoints.Config.AutoPipEnabled = false;
        endpoints.Write(new UserSettings());
        Ok(endpoints.Patch("{\"Follow\":[\"AutoPipEnabled\"]}"));

        // The following key's current value is no change, so it is not reported.
        Assert.Empty((JArray)Ok(endpoints.Post("{\"AutoPipEnabled\":false}"))["Rejected"]!);
        // A different value for it is refused (only /patch changes a following key); an invalid
        // value is refused; the valid key in the same body still applies.
        var body = Ok(endpoints.Post("{\"AutoPipEnabled\":true,\"SubtitleVerticalPosition\":-3,\"WatchProgressMode\":\"never\",\"AutoResumeEnabled\":true}"));
        Assert.Equal(new Dictionary<string, string> { ["AutoPipEnabled"] = "following", ["SubtitleVerticalPosition"] = "invalid", ["WatchProgressMode"] = "invalid" }, Rejections(body));
        var disk = endpoints.OnDisk();
        Assert.False(disk.Value<bool>("AutoPipEnabled"));
        Assert.Equal(85, disk.Value<int>("SubtitleVerticalPosition"));
        Assert.True(disk.Value<bool>("AutoResumeEnabled"));
        Assert.Equal(new[] { "AutoPipEnabled" }, Strings(disk["_je"]!["Following"]));
        Assert.Equal(new[] { "AutoResumeEnabled" }, Strings(disk["_je"]!["Chosen"]));
    }

    [Theory]
    [InlineData("[]")]
    [InlineData("true")]
    [InlineData("\"AutoPipEnabled\"")]
    public void TheLegacyPostNeedsAJsonObject(string body)
    {
        using var endpoints = new Endpoints();
        endpoints.Write(new UserSettings());
        var stored = File.ReadAllText(endpoints.SettingsPath(UserA));
        Assert.Equal(400, Status(endpoints.Post(body)));
        Assert.Equal(stored, File.ReadAllText(endpoints.SettingsPath(UserA)));
    }

    // ---- reads, bootstrap, epoch

    [Fact]
    public void ThePlainGetShapeIsUnchangedAndMetaComesAsASibling()
    {
        using var endpoints = new Endpoints();
        endpoints.Config.NativePosterTagsEnabled = false;
        endpoints.Write(new UserSettings { AutoPipEnabled = true, UseNativePosterTags = true });
        var plain = endpoints.Get();
        var typed = JObject.Parse(StjSerializer.Serialize(new UserSettings { AutoPipEnabled = true, UseNativePosterTags = true }));
        typed["IsAdmin"] = false;
        Assert.True(JToken.DeepEquals(typed, plain));

        var (settings, meta) = endpoints.GetWithMeta();
        Assert.True(JToken.DeepEquals(plain, settings));
        Assert.Equal(new[] { "Schema", "Revision", "ConfigEpoch", "Following", "Chosen", "ChangedByAdmin", "Locked", "Saved", "Defaults", "Reach", "Unavailable" },
            meta.Properties().Select(p => p.Name));
        Assert.Equal(2, meta.Value<int>("Schema"));
        Assert.Equal(endpoints.Plugin.Plugin.ConfigEpoch, meta.Value<string>("ConfigEpoch"));
        // A legacy file: no Following/Chosen, nothing locked.
        Assert.Empty(Strings(meta["Following"]));
        Assert.Empty(Strings(meta["Chosen"]));
        Assert.Empty(Strings(meta["Locked"]));
        Assert.Empty((JObject)meta["Saved"]!);
        // Defaults for exactly the keys with an admin default, as the seed writes them.
        var seed = JObject.Parse(StjSerializer.Serialize(UserSettingsRegistry.BuildDefaults(endpoints.Config)));
        var withAdmin = UserSettingsRegistry.All.Where(d => d.AdminProperty != null).Select(d => d.Key).ToArray();
        Assert.Equal(withAdmin, ((JObject)meta["Defaults"]!).Properties().Select(p => p.Name));
        foreach (var key in withAdmin) Assert.True(JToken.DeepEquals(seed[key], meta["Defaults"]![key]), key);
        // Effective reach: native poster tags are off, so nothing reaches native images.
        Assert.Equal("Web", meta["Reach"]!.Value<string>("QualityTagsEnabled"));
        Assert.Equal("Server", meta["Reach"]!.Value<string>("UseNativePosterTags"));
        Assert.Null(meta["Reach"]!["AutoPipEnabled"]);
        Assert.Equal("NativePosterTagsEnabled", meta["Unavailable"]!.Value<string>("UseNativePosterTags"));

        endpoints.Config.NativePosterTagsEnabled = true;
        (_, meta) = endpoints.GetWithMeta();
        Assert.Equal("Both", meta["Reach"]!.Value<string>("QualityTagsEnabled"));
        Assert.Empty((JObject)meta["Unavailable"]!);
    }

    [Fact]
    public void BootstrapAdvertisesThePatchRouteAndCarriesMetaFromTheSameRead()
    {
        using var endpoints = new Endpoints();
        endpoints.Write(new UserSettings());
        Ok(endpoints.Patch("{\"Set\":{\"AutoPipEnabled\":true}}"));
        var bootstrap = JObject.Parse(StjSerializer.Serialize(Assert.IsType<JsonResult>(endpoints.Controller(UserA).GetBootstrap()).Value));
        Assert.Contains("settingsPatch", Strings(bootstrap["Capabilities"]));
        var userSettings = (JObject)bootstrap["UserSettings"]!;
        var (settings, meta) = endpoints.GetWithMeta();
        Assert.True(JToken.DeepEquals(settings, userSettings["Settings"]));
        Assert.True(JToken.DeepEquals(meta, userSettings["SettingsMeta"]));
        Assert.Equal(new[] { "AutoPipEnabled" }, Strings(userSettings["SettingsMeta"]!["Chosen"]));
    }

    [Fact]
    public void TheConfigEpochChangesOnEveryAdminSave()
    {
        using var endpoints = new Endpoints();
        var epoch = endpoints.Plugin.Plugin.ConfigEpoch;
        Assert.Matches("^[0-9a-f]{8}$", epoch);
        endpoints.Plugin.Plugin.UpdateConfiguration(new PluginConfiguration());
        Assert.NotEqual(epoch, endpoints.Plugin.Plugin.ConfigEpoch);
        Assert.Matches("^[0-9a-f]{8}$", endpoints.Plugin.Plugin.ConfigEpoch);
    }

    // ---- storage

    [Fact]
    public void TheProvenanceBlockRoundTripsUnderNewtonsoftAndIsInvisibleToSystemTextJson()
    {
        var settings = new UserSettings
        {
            AutoPipEnabled = true,
            Meta = new UserSettingsMeta { Following = { "AutoPauseEnabled" }, Chosen = { "AutoPipEnabled" }, Ops = { ["AutoPipEnabled"] = "20261011200000123-ab12cd34" }, Updated = new DateTime(2026, 10, 11, 20, 0, 0, DateTimeKind.Utc) },
        };
        var newtonsoft = JObject.FromObject(settings);
        Assert.Null(newtonsoft["Meta"]);
        Assert.Equal(new[] { "AutoPauseEnabled" }, Strings(newtonsoft["_je"]!["Following"]));
        var back = JsonConvert.DeserializeObject<UserSettings>(newtonsoft.ToString())!;
        Assert.Equal(new[] { "AutoPipEnabled" }, back.Meta!.Chosen);
        Assert.Equal("20261011200000123-ab12cd34", back.Meta.Ops["AutoPipEnabled"]);
        Assert.Equal(settings.Meta.Updated, back.Meta.Updated);

        // System.Text.Json (the GET document, model binding) never sees it either way.
        var stj = JObject.Parse(StjSerializer.Serialize(settings));
        Assert.Null(stj["_je"]);
        Assert.Null(stj["Meta"]);
        Assert.Null(StjSerializer.Deserialize<UserSettings>("{\"_je\":{\"Following\":[\"AutoPipEnabled\"]},\"Meta\":{\"Chosen\":[\"AutoPipEnabled\"]}}")!.Meta);

        // A legacy document is written without the block (no "_je": null).
        Assert.Null(JObject.FromObject(new UserSettings())["_je"]);
    }

    [Theory]
    [InlineData("5")]
    [InlineData("\"x\"")]
    [InlineData("[]")]
    [InlineData("{\"Following\":5}")]
    [InlineData("{\"Following\":[{\"a\":1}]}")]
    [InlineData("{\"Updated\":\"not a date\"}")]
    [InlineData("{\"Following\":[\"NoSuchKey\",\"autopipenabled\",\"SubtitleVerticalPosition\"],\"Chosen\":[\"AutoPipEnabled\",\"AutoPauseEnabled\"],\"ChangedByAdmin\":[\"AutoResumeEnabled\",\"AutoPauseEnabled\"]}")]
    public void AnOddProvenanceBlockNeverBreaksTheDocument(string block)
    {
        using var endpoints = new Endpoints();
        var path = endpoints.SettingsPath(UserA);
        endpoints.Plugin.Core.Write(UserA.ToString("N"), "{\"AutoPipEnabled\":true,\"_je\":" + block + "}");
        var (settings, meta) = endpoints.GetWithMeta();
        Assert.Empty(Directory.GetFiles(Path.GetDirectoryName(path)!, "settings.json.corrupt-*"));
        if (block.Contains("autopipenabled", StringComparison.Ordinal))
        {
            Assert.False(settings.Value<bool>("AutoPipEnabled"), "a following key serves the admin default");
            // Normalised: canonical names, unknown and non-inheritable keys dropped, Following wins
            // over Chosen, ChangedByAdmin only for Chosen keys.
            Assert.Equal(new[] { "AutoPipEnabled" }, Strings(meta["Following"]));
            Assert.Equal(new[] { "AutoPauseEnabled" }, Strings(meta["Chosen"]));
            Assert.Equal(new[] { "AutoPauseEnabled" }, Strings(meta["ChangedByAdmin"]));
        }
        else
        {
            Assert.True(settings.Value<bool>("AutoPipEnabled"));
            Assert.Empty(Strings(meta["Following"]));
            Assert.Empty(Strings(meta["Chosen"]));
        }
    }

    [Theory]
    [InlineData("{\"Following\":null}")]
    [InlineData("{\"Chosen\":null}")]
    [InlineData("{\"ChangedByAdmin\":null}")]
    [InlineData("{\"Schema\":2,\"Following\":null,\"Chosen\":null,\"ChangedByAdmin\":null,\"Ops\":null}")]
    public void ABlockWithNullListsStillTakesWritesAndIsRewrittenClean(string block)
    {
        using var endpoints = new Endpoints();
        var file = "{\"AutoPipEnabled\":true,\"_je\":" + block + "}";
        endpoints.Plugin.Core.Write(UserA.ToString("N"), file);
        var (settings, meta) = endpoints.GetWithMeta();
        Assert.True(settings.Value<bool>("AutoPipEnabled"));
        Assert.Empty(Strings(meta["Following"]));

        Ok(endpoints.Patch(@"{""Set"":{""AutoPauseEnabled"":true}}"));
        var disk = endpoints.OnDisk();
        Assert.Equal(new[] { "AutoPauseEnabled" }, Strings(disk["_je"]!["Chosen"]));
        Assert.Empty(Strings(disk["_je"]!["Following"]));
        Assert.Empty(Strings(disk["_je"]!["ChangedByAdmin"]));

        // The legacy POST, even one that changes no value, also writes and rewrites the block.
        endpoints.Plugin.Core.Write(UserA.ToString("N"), file);
        Ok(endpoints.Post(@"{""AutoPipEnabled"":true}"));
        disk = endpoints.OnDisk();
        Assert.True(disk.Value<bool>("AutoPipEnabled"));
        foreach (var list in new[] { "Following", "Chosen", "ChangedByAdmin" })
        {
            Assert.Empty(Strings(disk["_je"]![list]));
        }
    }

    /// <summary>The typed model of a JE release before C1: the same keys, no "_je" member.</summary>
    private sealed class OldTypedModel : DefaultContractResolver
    {
        protected override IList<JsonProperty> CreateProperties(Type type, MemberSerialization memberSerialization)
            => base.CreateProperties(type, memberSerialization).Where(p => p.PropertyName != "_je").ToList();
    }

    /// <summary>What an older JE does on its next write: typed read, typed save (UserConfigurationManager).</summary>
    private static void DowngradeRewrite(string path)
    {
        var old = new JsonSerializerSettings { ContractResolver = new OldTypedModel(), NullValueHandling = NullValueHandling.Ignore };
        var model = JsonConvert.DeserializeObject<UserSettings>(File.ReadAllText(path), old)!;
        File.WriteAllText(path, JsonConvert.SerializeObject(JToken.FromObject(model, JsonSerializer.Create(new JsonSerializerSettings { ContractResolver = new OldTypedModel() })), Formatting.Indented));
    }

    [Fact]
    public void DowngradeDropsProvenanceAndKeepsTheLastCachedValues()
    {
        using var endpoints = new Endpoints();
        endpoints.Config.AutoPipEnabled = false;
        endpoints.Config.AutoPauseEnabled = false;
        endpoints.Write(new UserSettings());
        Ok(endpoints.Patch("{\"Follow\":[\"AutoPipEnabled\",\"AutoPauseEnabled\"],\"Set\":{\"ShowFileSizes\":true}}"));

        // The admin changes both defaults. A write after the first change re-caches it on disk; the
        // second change happens after the user's last write, so only the served value has it.
        endpoints.Config.AutoPipEnabled = true;
        Ok(endpoints.Patch("{\"Set\":{\"AutoResumeEnabled\":true}}"));
        endpoints.Config.AutoPauseEnabled = true;
        var before = endpoints.Get();
        Assert.True(before.Value<bool>("AutoPipEnabled"));
        Assert.True(before.Value<bool>("AutoPauseEnabled"));

        // Downgrade: the older JE rewrites the file through its typed model and drops "_je".
        var path = endpoints.SettingsPath(UserA);
        DowngradeRewrite(path);
        Assert.Null(JObject.Parse(File.ReadAllText(path))["_je"]);
        var typed = JsonConvert.DeserializeObject<UserSettings>(File.ReadAllText(path))!;
        Assert.True(typed.AutoPipEnabled, "the value cached by the last write survives");
        Assert.False(typed.AutoPauseEnabled, "a default changed after the last write falls back to the older cached value");
        Assert.True(typed.ShowFileSizes);
        Assert.True(typed.AutoResumeEnabled);

        // Re-upgrade: the file reads as legacy (all Existing) and resolves to exactly what it stores.
        var (settings, meta) = endpoints.GetWithMeta();
        Assert.True(settings.Value<bool>("AutoPipEnabled"));
        Assert.False(settings.Value<bool>("AutoPauseEnabled"));
        Assert.Empty(Strings(meta["Following"]));
        Assert.Empty(Strings(meta["Chosen"]));
    }
}
