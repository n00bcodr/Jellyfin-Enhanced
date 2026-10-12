using System.Security.Claims;
using System.Security.Cryptography;
using Jellyfin.Database.Implementations.Entities;
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
/// "Apply defaults to users" and the policy overview (design item C4): a dry run reports exactly
/// what the run does and never changes a byte; "Follow where nothing changes" leaves every effective
/// value and poster digest as it was; undo is compare-and-swap for every mode (Overwrite included,
/// with hidden-content settings and Spoiler Guard preferences) and keeps anything changed since;
/// inputs are validated (keys, user ids, undo ids, ConfigEpoch); per-user failures are reported;
/// users come from the live user list (on both Jellyfin targets) plus the settings directories.
/// </summary>
[Collection("Plugin singleton")]
public class CoreSettingsApplyDefaultsTests : IDisposable
{
    private const string SpoilerFile = "spoilerblur.json";

    public CoreSettingsApplyDefaultsTests() => RecentlyUnlockedSettings.Clear();

    public void Dispose() => RecentlyUnlockedSettings.Clear();

    private sealed class Server : IDisposable
    {
        public ApiPluginFixture Plugin { get; } = new();
        public Mock<IUserManager> Users { get; } = new();
        public UserConfigurationManager Manager => Plugin.Core.Manager;
        public PluginConfiguration Config => Plugin.Plugin.Configuration;
        public Guid Admin { get; } = Guid.NewGuid();

        public Server() => Live();

        public string Dir(Guid user) => Path.Combine(Plugin.Core.ConfigRoot, user.ToString("N"));

        public string SettingsPath(Guid user) => Path.Combine(Dir(user), "settings.json");

        /// <summary>Registers live Jellyfin users the way the shim reads them on this target.</summary>
        public void Live(params User[] users)
        {
#if NET9_0
            Users.SetupGet(x => x.Users).Returns(users);
#else
            Users.Setup(x => x.GetUsers()).Returns(users);
#endif
        }

        public JellyfinEnhancedController Controller(Guid? user = null, bool admin = true)
        {
            var maintenance = new MaintenanceModeService(Users.Object, Mock.Of<ISessionManager>(), Plugin.Core.Paths.Object, Plugin.Core.Logger);
            var controller = ApiAssetTests.Controller(Plugin.Core, Manager, Users.Object, maintenance);
            controller.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity([
                new Claim("Jellyfin-UserId", (user ?? Admin).ToString()), new Claim(ClaimTypes.Role, admin ? "Administrator" : "User")], "test"));
            return controller;
        }

        /// <summary>Saves a new admin configuration the way Jellyfin does (UpdateConfiguration).</summary>
        public void Save(Action<PluginConfiguration> change)
        {
            var next = StjSerializer.Deserialize<PluginConfiguration>(StjSerializer.Serialize(Config, JsonDefaults.Options), JsonDefaults.Options)!;
            change(next);
            Plugin.Plugin.UpdateConfiguration(next);
        }

        public string Epoch => Plugin.Plugin.ConfigEpoch;

        public void Write(Guid user, UserSettings settings) => Manager.SaveUserConfiguration(user.ToString("N"), "settings.json", settings);

        public string File(Guid user, string name, string text)
        {
            Directory.CreateDirectory(Dir(user));
            var path = Path.Combine(Dir(user), name);
            System.IO.File.WriteAllText(path, text);
            return path;
        }

        public UserSettings Stored(Guid user) => Newtonsoft.Json.JsonConvert.DeserializeObject<UserSettings>(System.IO.File.ReadAllText(SettingsPath(user)))!;

        /// <summary>A dry run or real run; a real run without an epoch uses the current one.</summary>
        public JObject Apply(string mode, string[] keys, bool dryRun, string[]? userIds = null, string? epoch = null)
        {
            var request = new JObject { ["Keys"] = new JArray(keys), ["Mode"] = mode, ["DryRun"] = dryRun, ["UserIds"] = userIds == null ? JValue.CreateNull() : new JArray(userIds) };
            if (!dryRun || epoch != null) request["ConfigEpoch"] = epoch ?? Epoch;
            return Body(Controller().ApplyUserSettingsDefaults(Json(request.ToString())));
        }

        public JObject Undo(string id) => Body(Controller().UndoUserSettingsOperation(id));

        public JObject Overview() => Body(Controller().GetUserSettingsOverview());

        public JObject Overview(string key) => Body(Controller().GetUserSettingsOverviewForKey(key));

        public JObject Patch(Guid user, string body) => Body(Controller(user, admin: false).PatchUserSettingsSettings(user.ToString(), Json(body)));

        public JObject Get(Guid user) => Body(Controller(user, admin: false).GetUserSettingsSettings(user.ToString()));

        public void Dispose() => Plugin.Dispose();
    }

    private static User Person(string name, Guid? id = null) => new(name, "default", "default") { Id = id ?? Guid.NewGuid() };

    private static System.Text.Json.JsonElement Json(string json)
    {
        using var document = System.Text.Json.JsonDocument.Parse(json);
        return document.RootElement.Clone();
    }

    private static JObject Body(IActionResult result)
    {
        var value = Assert.IsAssignableFrom<ObjectResult>(result).Value;
        var body = JObject.Parse(StjSerializer.Serialize(value));
        body["_status"] = (result as ObjectResult)?.StatusCode ?? 200;
        return body;
    }

    private static int Status(JObject body) => body.Value<int>("_status");

    private static string[] Strings(JToken? array) => array!.Values<string>().Select(v => v!).ToArray();

    private static string[] AdminKeys() => UserSettingsRegistry.All.Where(UserSettingsRegistry.CanFollow).Select(d => d.Key).ToArray();

    private static string[] AllKeys() => UserSettingsRegistry.All.Select(d => d.Key).ToArray();

    /// <summary>Every file under the config root with a hash of its bytes.</summary>
    private static SortedDictionary<string, string> Tree(string root)
    {
        var files = new SortedDictionary<string, string>(StringComparer.Ordinal);
        foreach (var path in Directory.GetFiles(root, "*", SearchOption.AllDirectories))
        {
            files[Path.GetRelativePath(root, path)] = Convert.ToHexString(SHA256.HashData(System.IO.File.ReadAllBytes(path)));
        }

        foreach (var dir in Directory.GetDirectories(root, "*", SearchOption.AllDirectories))
        {
            files[Path.GetRelativePath(root, dir) + "/"] = "dir";
        }

        return files;
    }

    /// <summary>The apply answer without what legitimately differs between a dry run and the run.</summary>
    private static JObject Comparable(JObject body)
    {
        var copy = (JObject)body.DeepClone();
        copy.Remove("DryRun");
        copy.Remove("UndoId");
        copy.Remove("_status");
        return copy;
    }

    /// <summary>
    /// A mixed population: a legacy user whose values are copies of the defaults (sentinels
    /// included) with one difference, a user with choices and a following key, a user with a
    /// corrupt file, a live user who never used JE, and an orphan directory.
    /// </summary>
    private static (User Copy, User Chooser, User Broken, User Fresh, Guid Orphan) Population(Server server)
    {
        var copy = Person("blair");
        var chooser = Person("casey");
        var broken = Person("drew");
        var fresh = Person("erin");
        server.Live(copy, chooser, broken, fresh);
        server.Save(c => { c.NativePosterTagsEnabled = true; c.QualityTagsEnabled = true; c.AutoPipEnabled = false; c.ResolutionTagOrder = 2; });

        var legacy = UserSettingsRegistry.BuildDefaults(server.Config);
        legacy.ResolutionTagOrder = null; // sentinel: "use the admin order"
        legacy.QualityTagsPosition = string.Empty; // sentinel: "use the admin position"
        legacy.AutoPauseEnabled = !legacy.AutoPauseEnabled; // differs from the default
        server.Write(copy.Id, legacy);

        server.Write(chooser.Id, UserSettingsRegistry.BuildDefaults(server.Config));
        server.Patch(chooser.Id, "{\"Set\":{\"AutoPipEnabled\":true,\"QualityTagsEnabled\":true},\"Follow\":[\"ShowFileSizes\"]}");

        server.File(broken.Id, "settings.json", "{ not json");
        var orphan = Guid.NewGuid();
        server.Write(orphan, UserSettingsRegistry.BuildDefaults(server.Config));
        return (copy, chooser, broken, fresh, orphan);
    }

    // ---- previews

    [Theory]
    [InlineData("FollowIfUnchanged")]
    [InlineData("FollowAll")]
    [InlineData("Overwrite")]
    public void ADryRunReportsExactlyWhatTheRunDoes(string mode)
    {
        using var server = new Server();
        var (copy, chooser, _, _, _) = Population(server);
        server.Manager.SaveUserConfiguration(copy.Id.ToString("N"), SpoilerFile, new UserSpoilerBlur { Prefs = new SpoilerBlurUserPrefs { HideCast = false } });
        var keys = mode == "Overwrite" ? AllKeys() : AdminKeys();

        var preview = server.Apply(mode, keys, dryRun: true);
        Assert.Equal(200, Status(preview));
        Assert.True(preview.Value<bool>("DryRun"));
        Assert.Equal(server.Epoch, preview.Value<string>("ConfigEpoch"));
        Assert.Equal(JTokenType.Null, preview["UndoId"]!.Type);
        Assert.True(preview.Value<int>("Updated") > 0, preview.ToString());

        var run = server.Apply(mode, keys, dryRun: false, epoch: preview.Value<string>("ConfigEpoch"));
        Assert.Equal(200, Status(run));
        Assert.False(run.Value<bool>("DryRun"));
        Assert.Matches("^[0-9]{17}-[0-9a-f]{8}$", run.Value<string>("UndoId")!);
        Assert.True(JToken.DeepEquals(Comparable(preview), Comparable(run)), $"preview:\n{Comparable(preview)}\nrun:\n{Comparable(run)}");

        // Running it again finds nothing left to do, and writes no undo record.
        var again = server.Apply(mode, keys, dryRun: true);
        Assert.Equal(0, again.Value<int>("KeysChanged"));
        Assert.Equal(JTokenType.Null, server.Apply(mode, keys, dryRun: false)["UndoId"]!.Type);
        if (mode == "FollowIfUnchanged")
        {
            Assert.Equal(["AutoPauseEnabled"], Strings(((JArray)run["PerUser"]!).Single(u => u.Value<string>("Name") == "blair")["Kept"]));
            var caseyKept = Strings(((JArray)run["PerUser"]!).Single(u => u.Value<string>("Name") == "casey")["Kept"]);
            Assert.Contains("AutoPipEnabled", caseyKept); // a choice unlike the default
            Assert.Contains("QualityTagsEnabled", caseyKept); // a choice that equals the default is never adopted
        }
    }

    [Fact]
    public void PreviewsAndOverviewsNeverChangeAByteOnDisk()
    {
        using var server = new Server();
        var (copy, chooser, broken, _, orphan) = Population(server);
        server.File(chooser.Id, "hidden-content.json", "garbage"); // corrupt: a real Overwrite would quarantine it
        server.File(copy.Id, SpoilerFile, "{\"Prefs\":{\"HideCast\":false}}");
        var big = Person("frank");
        server.Live(copy, chooser, broken, big);
        server.File(big.Id, "settings.json", "{\"AutoPipEnabled\":true,\"Padding\":\"" + new string('x', 300 * 1024) + "\"}");
        server.File(orphan, "settings.json.tmp.leftover", "x");
        var root = server.Plugin.Core.ConfigRoot;
        var before = Tree(root);

        Assert.Equal(200, Status(server.Overview()));
        foreach (var key in AdminKeys()) Assert.Equal(200, Status(server.Overview(key)));
        foreach (var mode in new[] { "FollowIfUnchanged", "FollowAll", "Overwrite" })
        {
            var preview = server.Apply(mode, mode == "Overwrite" ? AllKeys() : AdminKeys(), dryRun: true);
            Assert.Equal(200, Status(preview));
            Assert.Contains(preview["Skipped"]!, s => s.Value<string>("Id") == broken.Id.ToString("N") && s.Value<string>("Reason") == "corrupt");
            Assert.Contains(preview["Skipped"]!, s => s.Value<string>("Id") == big.Id.ToString("N") && s.Value<string>("Reason") == "oversized");
            if (mode == "Overwrite")
            {
                Assert.Contains(preview["Failed"]!, f => f.Value<string>("Id") == chooser.Id.ToString("N") && f.Value<string>("Document") == "HiddenContent" && f.Value<string>("Reason") == "corrupt");
            }
        }

        var after = Tree(root);
        Assert.Equal(before, after);
        Assert.False(Directory.Exists(Path.Combine(root, "_operations")));
    }

    [Fact]
    public void FollowWhereNothingChangesKeepsEveryEffectiveValueAndPosterDigest()
    {
        using var server = new Server();
        server.Save(c => { c.NativePosterTagsEnabled = true; c.QualityTagsEnabled = true; c.ResolutionTagOrder = 2; c.QualityTagsPosition = "top-right"; c.GenreTagsEnabled = true; c.WatchProgressDefaultMode = ""; c.LockedUserSettings = ["ShowFileSizes"]; });
        var users = Enumerable.Range(0, 4).Select(i => Person("user" + i)).ToArray();
        server.Live(users);
        // A copy of the defaults with every sentinel; a copy with differences; a file from before
        // most keys existed; a user whose locked key only looks like the default.
        var sentinels = UserSettingsRegistry.BuildDefaults(server.Config);
        foreach (var d in UserSettingsRegistry.All.Where(d => d.Setting.NullInheritsAdmin)) d.Property.SetValue(sentinels, null);
        foreach (var d in UserSettingsRegistry.All.Where(d => d.Setting.EmptyInheritsAdmin)) d.Property.SetValue(sentinels, string.Empty);
        server.Write(users[0].Id, sentinels);
        var mixed = UserSettingsRegistry.BuildDefaults(server.Config);
        mixed.QualityTagsEnabled = false;
        mixed.GenreTagsPosition = "bottom-left";
        mixed.WatchProgressMode = "time";
        server.Write(users[1].Id, mixed);
        server.File(users[2].Id, "settings.json", "{\"QualityTagsEnabled\":true,\"ResolutionTagOrder\":null}");
        server.Write(users[3].Id, new UserSettings { ShowFileSizes = !server.Config.ShowFileSizes });

        var webBefore = users.Select(u => Effective(server, u.Id)).ToArray();
        var digestBefore = users.Select(u => PosterTagSettings.FromSettingsJson(System.IO.File.ReadAllText(server.SettingsPath(u.Id)), server.Config).Digest).ToArray();
        using var provider = new PosterTagSettingsProvider(server.Manager, new PosterTagUserCache(Mock.Of<IUserManager>()));
        var providerBefore = users.Select(u => provider.Get(u.Id).Digest).ToArray();

        var run = server.Apply("FollowIfUnchanged", AdminKeys(), dryRun: false);
        Assert.Equal(0, run.Value<int>("VisibleChanges"));
        Assert.True(run.Value<int>("KeysChanged") > 100, run.ToString());

        for (var i = 0; i < users.Length; i++)
        {
            Assert.True(JToken.DeepEquals(webBefore[i], Effective(server, users[i].Id)), $"user{i}: effective values changed");
            Assert.Equal(digestBefore[i], PosterTagSettings.FromSettingsJson(System.IO.File.ReadAllText(server.SettingsPath(users[i].Id)), server.Config).Digest);
            Assert.Equal(providerBefore[i], provider.Get(users[i].Id).Digest);
        }

        var following = server.Stored(users[1].Id).Meta!.Following;
        Assert.DoesNotContain("QualityTagsEnabled", following);
        Assert.DoesNotContain("GenreTagsPosition", following);
        Assert.DoesNotContain("WatchProgressMode", following);
        Assert.Contains("GenreTagsEnabled", following);
        Assert.Contains("ResolutionTagOrder", server.Stored(users[0].Id).Meta!.Following);
        Assert.DoesNotContain("ShowFileSizes", server.Stored(users[3].Id).Meta!.Following); // only equal because of the lock

        // From now on the adopted keys track the admin's changes.
        server.Save(c => { c.GenreTagsEnabled = false; c.ResolutionTagOrder = 5; });
        Assert.False(server.Get(users[0].Id).Value<bool>("GenreTagsEnabled"));
        Assert.Equal(5, server.Get(users[0].Id).Value<int>("ResolutionTagOrder"));
        Assert.Equal(5, provider.Get(users[2].Id).ResolutionTagOrder);
    }

    /// <summary>
    /// The values a user's clients act on: the served document with each "use the admin value"
    /// sentinel (a null order, an empty position) replaced by the admin value it stands for.
    /// </summary>
    private static JObject Effective(Server server, Guid user)
    {
        var body = Body(server.Controller(user, admin: false).GetUserSettingsSettings(user.ToString(), meta: true));
        var settings = (JObject)body["Settings"]!;
        var defaults = (JObject)body["Meta"]!["Defaults"]!;
        foreach (var descriptor in UserSettingsRegistry.All)
        {
            var value = settings[descriptor.Key];
            var sentinel = (descriptor.Setting.NullInheritsAdmin && value?.Type == JTokenType.Null)
                || (descriptor.Setting.EmptyInheritsAdmin && value?.Type == JTokenType.String && value.Value<string>() == string.Empty);
            if (sentinel) settings[descriptor.Key] = defaults[descriptor.Key]!.DeepClone();
        }

        return settings;
    }

    // ---- undo

    [Fact]
    public void UndoAfterOverwriteRestoresValuesStatesAndTheOtherDocuments()
    {
        using var server = new Server();
        var casey = Person("casey");
        server.Live(casey);
        server.Write(casey.Id, UserSettingsRegistry.BuildDefaults(server.Config));
        server.Patch(casey.Id, "{\"Set\":{\"AutoPipEnabled\":true,\"SubtitleVerticalPosition\":40},\"Follow\":[\"ShowFileSizes\"]}");
        server.Controller(server.Admin).PatchUserSettingsSettings(casey.Id.ToString(), Json("{\"Set\":{\"LongPress2xEnabled\":true}}"));
        var id = casey.Id.ToString("N");
        var hidden = new UserHiddenContent { Items = new() { ["x"] = new HiddenContentItem { ItemId = "x" } }, Settings = new HiddenContentSettings { FilterSearch = true, Enabled = false } };
        server.Manager.SaveUserConfiguration(id, "hidden-content.json", hidden);
        server.Manager.SaveUserConfiguration(id, SpoilerFile, new UserSpoilerBlur { Series = new() { ["s"] = new SpoilerBlurSeriesEntry { SeriesId = "s" } }, Prefs = new SpoilerBlurUserPrefs { HideCast = false, SkipDisableConfirm = true } });
        var valuesBefore = StjSerializer.Serialize(server.Stored(casey.Id));
        var metaBefore = server.Stored(casey.Id).Meta!;
        var hcBefore = JToken.FromObject(server.Manager.GetUserConfigurationStrict<UserHiddenContent>(id, "hidden-content.json").Settings);
        var prefsBefore = JToken.FromObject(server.Manager.GetUserConfigurationStrict<UserSpoilerBlur>(id, SpoilerFile).Prefs);

        // The old reset route, now on the engine: same response fields plus an UndoId.
        var reset = Body(server.Controller().ResetAllUsersSettings());
        Assert.Equal("complete", reset.Value<string>("status"));
        var undoId = reset.Value<string>("UndoId")!;
        Assert.Matches("^[0-9]{17}-[0-9a-f]{8}$", undoId);
        var overwritten = server.Stored(casey.Id);
        Assert.False(overwritten.AutoPipEnabled);
        Assert.Empty(overwritten.Meta!.Following);
        Assert.Empty(overwritten.Meta.Chosen);
        Assert.False(server.Manager.GetUserConfigurationStrict<UserHiddenContent>(id, "hidden-content.json").Settings.FilterSearch);

        var undo = server.Undo(undoId);
        Assert.Equal(200, Status(undo));
        Assert.Equal(0, undo.Value<int>("Kept"));
        var restored = server.Stored(casey.Id);
        // LastOpenedTab is device-local panel state the old reset also wrote; it is not undone.
        var expected = JObject.Parse(valuesBefore);
        var actual = JObject.Parse(StjSerializer.Serialize(restored));
        expected.Remove("LastOpenedTab");
        actual.Remove("LastOpenedTab");
        Assert.True(JToken.DeepEquals(expected, actual), actual.ToString());
        Assert.Equal(metaBefore.Following, restored.Meta!.Following);
        Assert.Equal(metaBefore.Chosen, restored.Meta.Chosen);
        Assert.Equal(metaBefore.ChangedByAdmin, restored.Meta.ChangedByAdmin);
        Assert.Empty(restored.Meta.Ops);
        var hcAfter = server.Manager.GetUserConfigurationStrict<UserHiddenContent>(id, "hidden-content.json");
        Assert.True(JToken.DeepEquals(hcBefore, JToken.FromObject(hcAfter.Settings)));
        Assert.Equal("x", Assert.Single(hcAfter.Items).Key);
        var spoiler = server.Manager.GetUserConfigurationStrict<UserSpoilerBlur>(id, SpoilerFile);
        Assert.True(JToken.DeepEquals(prefsBefore, JToken.FromObject(spoiler.Prefs)));
        Assert.Equal("s", Assert.Single(spoiler.Series).Key);

        // Once only.
        Assert.Equal(409, Status(server.Undo(undoId)));
    }

    [Fact]
    public void UndoKeepsEveryKeyAndDocumentChangedSince()
    {
        using var server = new Server();
        server.Save(c => { c.AutoPipEnabled = true; c.AutoPauseEnabled = true; c.ShowFileSizes = true; c.LongPress2xEnabled = true; });
        var casey = Person("casey");
        server.Live(casey);
        server.Write(casey.Id, new UserSettings { AutoPipEnabled = false, AutoPauseEnabled = false, ShowFileSizes = false, LongPress2xEnabled = false });
        var id = casey.Id.ToString("N");
        server.Manager.SaveUserConfiguration(id, "hidden-content.json", new UserHiddenContent { Settings = new HiddenContentSettings { FilterSearch = true } });

        var run = server.Apply("FollowAll", ["AutoPipEnabled", "AutoPauseEnabled", "ShowFileSizes", "LongPress2xEnabled"], dryRun: false);
        Assert.Equal(4, run.Value<int>("KeysChanged"));
        Assert.Equal(4, run.Value<int>("VisibleChanges"));
        // The user changes one key, follows another themselves (already following), and the admin
        // writes a third for them; the fourth is untouched.
        server.Patch(casey.Id, "{\"Set\":{\"AutoPipEnabled\":true},\"Follow\":[\"AutoPauseEnabled\"]}");
        server.Controller(server.Admin).PatchUserSettingsSettings(casey.Id.ToString(), Json("{\"Set\":{\"ShowFileSizes\":true}}"));
        var undo = server.Undo(run.Value<string>("UndoId")!);
        var user = (JObject)Assert.Single((JArray)undo["PerUser"]!);
        Assert.Equal(["LongPress2xEnabled"], Strings(user["Restored"]));
        Assert.Equal(["AutoPipEnabled", "AutoPauseEnabled", "ShowFileSizes"], Strings(user["Kept"]).OrderBy(k => k == "ShowFileSizes" ? 2 : k == "AutoPauseEnabled" ? 1 : 0).ToArray());
        var stored = server.Stored(casey.Id);
        Assert.False(stored.LongPress2xEnabled);
        Assert.DoesNotContain("LongPress2xEnabled", stored.Meta!.Following);
        Assert.True(stored.AutoPipEnabled);
        Assert.Contains("AutoPipEnabled", stored.Meta.Chosen);
        Assert.Contains("AutoPauseEnabled", stored.Meta.Following);
        Assert.Contains("ShowFileSizes", stored.Meta.ChangedByAdmin);

        // Overwrite then a user edit of the hidden-content settings: the section is kept.
        var overwrite = server.Apply("Overwrite", ["AutoPipEnabled"], dryRun: false);
        Assert.False(server.Manager.GetUserConfigurationStrict<UserHiddenContent>(id, "hidden-content.json").Settings.FilterSearch);
        var edited = server.Manager.GetUserConfigurationStrict<UserHiddenContent>(id, "hidden-content.json");
        edited.Settings.FilterCalendar = !edited.Settings.FilterCalendar;
        server.Manager.SaveUserConfiguration(id, "hidden-content.json", edited);
        var second = server.Undo(overwrite.Value<string>("UndoId")!);
        var secondUser = (JObject)Assert.Single((JArray)second["PerUser"]!);
        Assert.Equal(["AutoPipEnabled"], Strings(secondUser["Restored"]));
        Assert.Equal(["HiddenContent"], Strings(secondUser["Kept"]));
        Assert.Equal(edited.Settings.FilterCalendar, server.Manager.GetUserConfigurationStrict<UserHiddenContent>(id, "hidden-content.json").Settings.FilterCalendar);
    }

    [Fact]
    public void OnlyTheLastTwentyUndoRecordsAreKept()
    {
        using var server = new Server();
        var casey = Person("casey");
        server.Live(casey);
        var ids = new List<string>();
        for (var i = 0; i < 22; i++)
        {
            server.Write(casey.Id, new UserSettings { AutoPipEnabled = true });
            var run = server.Apply("Overwrite", ["AutoPipEnabled"], dryRun: false);
            ids.Add(run.Value<string>("UndoId")!);
            Thread.Sleep(2); // distinct millisecond timestamps
        }

        var records = Directory.GetFiles(Path.Combine(server.Plugin.Core.ConfigRoot, "_operations"), "*.json").Select(Path.GetFileNameWithoutExtension).ToHashSet();
        Assert.Equal(20, records.Count);
        Assert.DoesNotContain(ids[0], records);
        Assert.DoesNotContain(ids[1], records);
        Assert.Equal(404, Status(server.Undo(ids[0])));
        Assert.Equal(200, Status(server.Undo(ids[21])));
        // The operations directory is never a user.
        Assert.DoesNotContain(server.Manager.GetAllUserIds(), id => id.StartsWith('_'));
    }

    // ---- validation and authorization

    [Fact]
    public void UnknownUserIdsAreReportedAndNeverSeeded()
    {
        using var server = new Server();
        var casey = Person("casey");
        var fresh = Person("fresh");
        server.Live(casey, fresh);
        server.Write(casey.Id, new UserSettings { AutoPipEnabled = true });
        var stranger = Guid.NewGuid();

        var run = server.Apply("Overwrite", ["AutoPipEnabled"], dryRun: false, userIds: [casey.Id.ToString(), stranger.ToString("N"), "../../etc", "not-a-guid", fresh.Id.ToString("N").ToUpperInvariant()]);
        Assert.Equal(200, Status(run));
        Assert.Equal(1, run.Value<int>("Updated"));
        var skipped = ((JArray)run["Skipped"]!).ToDictionary(s => s.Value<string>("Id")!, s => s.Value<string>("Reason")!);
        Assert.Equal("unknown", skipped[stranger.ToString("N")]);
        Assert.Equal("unknown", skipped["../../etc"]);
        Assert.Equal("unknown", skipped["not-a-guid"]);
        Assert.Equal("no-settings", skipped[fresh.Id.ToString("N")]); // live, never used JE: nothing to change
        Assert.False(Directory.Exists(server.Dir(stranger)));
        Assert.False(Directory.Exists(server.Dir(fresh.Id)));
        Assert.Equal([casey.Id.ToString("N")], server.Manager.GetAllUserIds());
    }

    [Fact]
    public void MalformedRequestsAreRejected()
    {
        using var server = new Server();
        var casey = Person("casey");
        server.Live(casey);
        server.Write(casey.Id, new UserSettings());

        foreach (var undoId in new[] { "../x", "2026", "20261011200000123-ABCDEF12", "20261011200000123-abcdef12/../..", "20261011200000123-abcdef123", " " })
        {
            Assert.Equal(400, Status(server.Undo(undoId)));
        }

        Assert.Equal(404, Status(server.Undo("20261011200000123-abcdef12")));

        var controller = server.Controller();
        foreach (var body in new[]
        {
            "[]",
            "{\"Mode\":\"FollowAll\"}",
            "{\"Mode\":\"FollowAll\",\"Keys\":[]}",
            "{\"Mode\":\"FollowAll\",\"Keys\":[\"NotASetting\"]}",
            "{\"Mode\":\"FollowAll\",\"Keys\":[\"SubtitleVerticalPosition\"]}", // no server default to follow
            "{\"Mode\":\"Sideways\",\"Keys\":[\"AutoPipEnabled\"]}",
            "{\"Mode\":\"1\",\"Keys\":[\"AutoPipEnabled\"]}",
            "{\"Mode\":\"FollowAll\",\"Keys\":[\"AutoPipEnabled\"],\"UserIds\":\"everyone\"}",
            "{\"Mode\":\"FollowAll\",\"Keys\":[\"AutoPipEnabled\"],\"DryRun\":\"no\"}",
            "{\"Mode\":\"FollowAll\",\"Keys\":[\"AutoPipEnabled\"],\"DryRun\":false}", // no ConfigEpoch
        })
        {
            Assert.Equal(400, Status(Body(controller.ApplyUserSettingsDefaults(Json(body)))));
        }

        Assert.Equal(400, Status(Body(server.Controller().ApplyUserSettingsDefaults(Json("{\"Mode\":\"FollowAll\",\"Keys\":[\"AutoPipEnabled\"],\"UserIds\":[" + string.Join(",", Enumerable.Repeat("\"x\"", 10001)) + "]}")))));
        Assert.Equal(404, Status(server.Overview("NotASetting")));
        Assert.Equal(404, Status(server.Overview("SubtitleVerticalPosition")));
        var apply = typeof(JellyfinEnhancedController).GetMethod(nameof(JellyfinEnhancedController.ApplyUserSettingsDefaults))!;
        var limit = apply.GetCustomAttributes(typeof(RequestSizeLimitAttribute), false).Cast<Microsoft.AspNetCore.Http.Metadata.IRequestSizeLimitMetadata>().Single();
        Assert.Equal(64L * 1024, limit.MaxRequestBodySize);
        Assert.Single(apply.GetCustomAttributes(typeof(RejectOversizedBodyAttribute), false));

        // A preview's epoch goes stale when the admin saves the configuration.
        var preview = server.Apply("FollowAll", ["AutoPipEnabled"], dryRun: true);
        server.Save(c => c.AutoPipEnabled = !c.AutoPipEnabled);
        var stale = server.Apply("FollowAll", ["AutoPipEnabled"], dryRun: false, epoch: preview.Value<string>("ConfigEpoch"));
        Assert.Equal(409, Status(stale));
        Assert.Equal(server.Epoch, stale.Value<string>("ConfigEpoch"));
        Assert.Empty(server.Stored(casey.Id).Meta?.Following ?? []);
    }

    [Fact]
    public void EveryAdminRouteRefusesNonAdmins()
    {
        using var server = new Server();
        var viewer = Guid.NewGuid();
        var controller = server.Controller(viewer, admin: false);
        Assert.IsType<ForbidResult>(controller.GetUserSettingsOverview());
        Assert.IsType<ForbidResult>(controller.GetUserSettingsOverviewForKey("AutoPipEnabled"));
        Assert.IsType<ForbidResult>(controller.ApplyUserSettingsDefaults(Json("{\"Mode\":\"FollowAll\",\"Keys\":[\"AutoPipEnabled\"],\"DryRun\":true}")));
        Assert.IsType<ForbidResult>(controller.UndoUserSettingsOperation("20261011200000123-abcdef12"));
        Assert.IsType<ForbidResult>(controller.GetUserSettingsUpgradeCard());
        Assert.IsType<ForbidResult>(controller.DismissUserSettingsUpgradeCard());
        foreach (var name in new[] { nameof(JellyfinEnhancedController.GetUserSettingsOverview), nameof(JellyfinEnhancedController.GetUserSettingsOverviewForKey), nameof(JellyfinEnhancedController.ApplyUserSettingsDefaults), nameof(JellyfinEnhancedController.UndoUserSettingsOperation), nameof(JellyfinEnhancedController.GetUserSettingsUpgradeCard), nameof(JellyfinEnhancedController.DismissUserSettingsUpgradeCard) })
        {
            Assert.Single(typeof(JellyfinEnhancedController).GetMethod(name)!.GetCustomAttributes(typeof(Microsoft.AspNetCore.Authorization.AuthorizeAttribute), false));
        }
    }

    // ---- per-user failures

    [Fact]
    public void PerUserFailuresAreReportedAndTheRestApplies()
    {
        using var server = new Server();
        var ok = Person("alice");
        var corrupt = Person("bob");
        var unreadable = Person("carol");
        var badHidden = Person("dave");
        server.Live(ok, corrupt, unreadable, badHidden);
        server.Write(ok.Id, new UserSettings { AutoPipEnabled = true });
        var corruptPath = server.File(corrupt.Id, "settings.json", "");
        Directory.CreateDirectory(server.SettingsPath(unreadable.Id)); // a directory where the file should be
        server.Write(badHidden.Id, new UserSettings { AutoPipEnabled = true });
        server.File(badHidden.Id, "hidden-content.json", "{ broken");

        var preview = server.Apply("Overwrite", ["AutoPipEnabled"], dryRun: true);
        var run = server.Apply("Overwrite", ["AutoPipEnabled"], dryRun: false);
        Assert.True(JToken.DeepEquals(Comparable(preview), Comparable(run)), run.ToString());
        Assert.Equal(2, run.Value<int>("Updated"));
        Assert.Contains(run["Skipped"]!, s => s.Value<string>("Name") == "bob" && s.Value<string>("Reason") == "corrupt");
        Assert.Contains(run["Failed"]!, f => f.Value<string>("Name") == "carol" && f.Value<string>("Document") == "Settings" && f.Value<string>("Reason") == "unavailable");
        Assert.Contains(run["Failed"]!, f => f.Value<string>("Name") == "dave" && f.Value<string>("Document") == "HiddenContent" && f.Value<string>("Reason") == "corrupt");
        Assert.Equal(string.Empty, System.IO.File.ReadAllText(corruptPath)); // left untouched
        Assert.False(server.Stored(ok.Id).AutoPipEnabled);
        Assert.False(server.Stored(badHidden.Id).AutoPipEnabled);

        // The legacy route reports the same through its old fields.
        var reset = Body(server.Controller().ResetAllUsersSettings());
        Assert.Equal("partial", reset.Value<string>("status"));
        var users = ((JArray)reset["users"]!).ToDictionary(u => u.Value<string>("name")!, u => (JObject)u);
        Assert.Equal("failed", users["bob"].Value<string>("settings"));
        Assert.Equal("corrupt", users["bob"]["failures"]![0]!.Value<string>("reason"));
        Assert.Equal("failed", users["carol"].Value<string>("settings"));
        Assert.Equal("unavailable", users["carol"]["failures"]![0]!.Value<string>("reason"));
        Assert.Contains(corrupt.Id.ToString("N"), Strings(reset["skippedSettingsUserIds"]));
    }

    // ---- users: live users (both targets) plus directories

    [Fact]
    public void UsersComeFromTheLiveListAndTheSettingsDirectories()
    {
        using var server = new Server();
        var casey = Person("casey");
        var fresh = Person("fresh");
        server.Live(casey, fresh);
        server.Write(casey.Id, new UserSettings { AutoPipEnabled = !server.Config.AutoPipEnabled });
        var orphan = Guid.NewGuid();
        server.Write(orphan, new UserSettings());

        var overview = server.Overview();
        Assert.Equal(3, overview["Users"]!.Value<int>("Total"));
        Assert.Equal(2, overview["Users"]!.Value<int>("WithSettings"));
        Assert.Equal(1, overview["Users"]!.Value<int>("WithoutSettings"));
        Assert.Equal(1, overview["Users"]!.Value<int>("Orphans"));
        Assert.True(overview["Users"]!.Value<bool>("LiveListed"));
        var list = ((JArray)overview["UserList"]!).ToDictionary(u => u.Value<string>("Id")!, u => (JObject)u);
        Assert.Equal("casey", list[casey.Id.ToString("N")].Value<string>("Name"));
        Assert.Equal("none", list[fresh.Id.ToString("N")].Value<string>("Settings"));
        Assert.True(list[orphan.ToString("N")].Value<bool>("Orphan"));

        var perUser = ((JArray)server.Overview("AutoPipEnabled")["Users"]!).ToDictionary(u => u.Value<string>("UserId")!, u => (JObject)u);
        Assert.Equal("NoSettings", perUser[fresh.Id.ToString("N")].Value<string>("State"));
        Assert.Equal("Existing", perUser[casey.Id.ToString("N")].Value<string>("State"));
        Assert.True(perUser[orphan.ToString("N")].Value<bool>("Orphan"));

        // The shim failing costs the names, not the users with files.
#if NET9_0
        server.Users.SetupGet(x => x.Users).Throws(new InvalidOperationException("user store down"));
#else
        server.Users.Setup(x => x.GetUsers()).Throws(new InvalidOperationException("user store down"));
#endif
        var degraded = server.Overview();
        Assert.False(degraded["Users"]!.Value<bool>("LiveListed"));
        Assert.Equal(2, degraded["Users"]!.Value<int>("Total"));
        Assert.Equal(0, degraded["Users"]!.Value<int>("Orphans"));
        Assert.Equal(2, server.Apply("FollowAll", ["AutoPipEnabled"], dryRun: true).Value<int>("Users"));
    }

    // ---- overview counts

    [Fact]
    public void TheOverviewCountsFollowingKeptAndChanged()
    {
        using var server = new Server();
        var (copy, chooser, broken, fresh, orphan) = Population(server);
        var overview = server.Overview();
        var byKey = ((JArray)overview["Settings"]!).ToDictionary(s => s.Value<string>("Key")!, s => (JObject)s);
        Assert.Equal(AdminKeys().Length, byKey.Count);

        // blair: copy (Existing); casey: Chosen On; orphan: copy. Default Off.
        var pip = byKey["AutoPipEnabled"];
        Assert.Equal(0, pip.Value<int>("Following"));
        Assert.Equal(2, pip.Value<int>("Kept"));
        Assert.Equal(1, pip.Value<int>("Changed"));
        Assert.Equal(2, pip.Value<int>("Existing"));
        Assert.Equal(2, pip.Value<int>("ExistingSameAsDefault"));
        Assert.Equal(1, pip.Value<int>("Chosen"));
        Assert.Equal(1, byKey["ShowFileSizes"].Value<int>("Following"));
        Assert.Equal(1, byKey["AutoPauseEnabled"].Value<int>("Changed")); // blair differs
        Assert.Equal(3, byKey["ResolutionTagOrder"].Value<int>("Kept")); // a null order is the default
        Assert.Equal(3, overview["Adoptable"]!.Value<int>("Users"));
        Assert.Equal(broken.Id.ToString("N"), Assert.Single((JArray)overview["Corrupt"]!)!.Value<string>("Id"));

        // After "Follow where nothing changes" only casey's choices and blair's difference stay.
        server.Apply("FollowIfUnchanged", AdminKeys(), dryRun: false);
        var after = ((JArray)server.Overview()["Settings"]!).ToDictionary(s => s.Value<string>("Key")!, s => (JObject)s);
        Assert.Equal(2, after["AutoPipEnabled"].Value<int>("Following"));
        Assert.Equal(0, after["AutoPipEnabled"].Value<int>("Kept"));
        Assert.Equal(1, after["AutoPauseEnabled"].Value<int>("Changed"));
        Assert.Equal(0, server.Overview()["Adoptable"]!.Value<int>("Users"));
    }

    [Fact]
    public void ThePerUserListRevalidatesStringValues()
    {
        using var server = new Server();
        var casey = Person("casey");
        server.Live(casey);
        server.File(casey.Id, "settings.json", "{\"QualityTagsPosition\":\"<img src=x onerror=alert(1)>\",\"DisplayLanguage\":\"" + new string('a', 200) + "\"}");
        var position = (JObject)((JArray)server.Overview("QualityTagsPosition")["Users"]!).Single();
        Assert.Equal(JTokenType.Null, position["Value"]!.Type);
        Assert.True(position.Value<bool>("Invalid"));
        var language = (JObject)((JArray)server.Overview("DisplayLanguage")["Users"]!).Single();
        Assert.Equal(JTokenType.Null, language["Value"]!.Type);
    }

    [Fact]
    public void TheUpgradeCardCanBeDismissedForGood()
    {
        using var server = new Server();
        Assert.False(Body(server.Controller().GetUserSettingsUpgradeCard()).Value<bool>("Dismissed"));
        Assert.True(Body(server.Controller().DismissUserSettingsUpgradeCard()).Value<bool>("Dismissed"));
        Assert.True(Body(server.Controller().GetUserSettingsUpgradeCard()).Value<bool>("Dismissed"));
        Assert.Empty(server.Manager.GetAllUserIds());
    }
}
