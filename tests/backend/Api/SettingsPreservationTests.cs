using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Transport;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Admin.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Settings;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Settings;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.MediaTags;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Maintenance;

namespace JE.Tests;

[Collection("Plugin singleton")]
public class SettingsPreservationTests
{
    private const string User = "abcdefabcdefabcdefabcdefabcdefab";
    private const string Item = "abcdefabcdefabcdefabcdefabcdefab";
    private const string Other = "11111111111111111111111111111111";

    private static JsonDocument Save(CoreFixture fixture, Action<JellyfinEnhancedUserSettings>? edit = null)
    {
        var service = new SettingsDocumentService(fixture.Manager);
        var loaded = service.Read(User, () => new(), false);
        loaded.Settings.AutoPauseEnabled = !loaded.Settings.AutoPauseEnabled;
        edit?.Invoke(loaded.Settings);
        Assert.True(MediaTagsPortable.TryNormalizeUser(loaded.Settings, out var error), error);
        Assert.True(service.TrySave(User, new RevisionedSettingsRequest { Revision = loaded.Revision, Settings = loaded.Settings }, false, out _));
        return JsonDocument.Parse(File.ReadAllText(Path.Combine(fixture.ConfigRoot, User, "settings.json")));
    }

    [Fact]
    public void UnrelatedSaveRetainsUnknownMembersThroughoutKnownObjectsAndSlots()
    {
        using var f = new CoreFixture();
        f.Write(User, """
            {"TagGroupCaps":{"Quality":2,"FutureCap":1e400},
             "TagGroupScopes":{"Quality":{"Movies":false,"FutureScope":{"Keep":true}},"FutureGroup":7},
             "TagLayouts":{"Corners":{"FutureProfile":true,"Groups":[{"Group":"QUALITY","Slot":"tl","FutureSlot":9}]},"FutureLayout":{"Keep":3}},
             "TagShapeOverrides":{"Landscape":{"Layout":"corners","FutureShape":true,"Caps":{"Quality":3,"FutureCap":1e-400},"Slots":[{"Group":"quality","Slot":"tr","FutureSlot":4}]}}}
            """);
        using var saved = Save(f);
        var root = saved.RootElement;
        Assert.Equal("1e400", root.GetProperty("TagGroupCaps").GetProperty("FutureCap").GetRawText());
        Assert.True(root.GetProperty("TagGroupScopes").GetProperty("Quality").GetProperty("FutureScope").GetProperty("Keep").GetBoolean());
        Assert.Equal(7, root.GetProperty("TagGroupScopes").GetProperty("FutureGroup").GetInt32());
        var layouts = root.GetProperty("TagLayouts");
        Assert.Equal(3, layouts.GetProperty("FutureLayout").GetProperty("Keep").GetInt32());
        Assert.True(layouts.GetProperty("Corners").GetProperty("FutureProfile").GetBoolean());
        Assert.Equal(9, layouts.GetProperty("Corners").GetProperty("Groups")[0].GetProperty("FutureSlot").GetInt32());
        var shape = root.GetProperty("TagShapeOverrides").GetProperty("Landscape");
        Assert.True(shape.GetProperty("FutureShape").GetBoolean());
        Assert.Equal("1e-400", shape.GetProperty("Caps").GetProperty("FutureCap").GetRawText());
        Assert.Equal(4, shape.GetProperty("Slots")[0].GetProperty("FutureSlot").GetInt32());
    }

    [Fact]
    public void RuleAndConditionReorderingPreservesIdentityWithoutResurrectingDeletedEntries()
    {
        using var f = new CoreFixture();
        f.Write(User, """
            {"TagLookRules":[
              {"Id":"first","FutureRule":"one","When":[{"Field":"type","Value":"Movie","FutureCondition":"movie"},{"Field":"genre","Value":"Action","FutureCondition":"action"}],"Slots":[{"Group":"quality","Slot":"tl","FutureSlot":"quality"},{"Group":"genre","Slot":"tr","FutureSlot":"genre"}]},
              {"Id":"second","FutureRule":"two","When":[{"Field":"type","Value":"Series","FutureCondition":"series"}]},
              {"Id":"deleted","FutureRule":"remove","When":[{"Field":"type","Value":"Movie"}]}]}
            """);
        using var saved = Save(f, settings =>
        {
            var rules = settings.TagLookRules!;
            rules[0].When.Reverse();
            rules[0].Slots!.RemoveAt(0);
            rules[0].Slots![0].Slot = "br";
            settings.TagLookRules = [rules[1], rules[0], new TagLookRule { Id = "new", When = [new() { Field = "type", Value = "Movie" }] }];
        });
        var rules = saved.RootElement.GetProperty("TagLookRules");
        Assert.Equal(3, rules.GetArrayLength());
        Assert.Equal("two", rules[0].GetProperty("FutureRule").GetString());
        Assert.Equal("one", rules[1].GetProperty("FutureRule").GetString());
        Assert.Equal("action", rules[1].GetProperty("When")[0].GetProperty("FutureCondition").GetString());
        Assert.Equal("movie", rules[1].GetProperty("When")[1].GetProperty("FutureCondition").GetString());
        Assert.Single(rules[1].GetProperty("Slots").EnumerateArray());
        Assert.Equal("genre", rules[1].GetProperty("Slots")[0].GetProperty("FutureSlot").GetString());
        Assert.Equal("br", rules[1].GetProperty("Slots")[0].GetProperty("Slot").GetString());
        Assert.False(rules[2].TryGetProperty("FutureRule", out _));
        Assert.DoesNotContain(rules.EnumerateArray(), rule => rule.GetProperty("Id").GetString() == "deleted");
    }

    [Fact]
    public void LockKeysNormalizeAndDeletionDoesNotResurrectOldOverrides()
    {
        using var f = new CoreFixture();
        f.Write(User, """
            {"TagLayoutLocks":{
              "ABCDEFAB-CDEF-ABCD-EFAB-CDEFABCDEFAB":{"FutureLock":"keep","Caps":{"Quality":2,"FutureCap":7}},
              "11111111111111111111111111111111":{"FutureLock":"remove"}}}
            """);
        using var saved = Save(f, settings =>
        {
            settings.TagLayoutLocks!.Remove(Other);
            settings.TagLayoutLocks["22222222222222222222222222222222"] = new TagLayoutLock();
        });
        var locks = saved.RootElement.GetProperty("TagLayoutLocks");
        Assert.Equal(2, locks.EnumerateObject().Count());
        Assert.Equal("keep", locks.GetProperty(Item).GetProperty("FutureLock").GetString());
        Assert.Equal(7, locks.GetProperty(Item).GetProperty("Caps").GetProperty("FutureCap").GetInt32());
        Assert.False(locks.TryGetProperty(Other, out _));
        Assert.False(locks.GetProperty("22222222222222222222222222222222").TryGetProperty("FutureLock", out _));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ExplicitNullAndEmptyCollectionsStillResetOrDelete(bool inherit)
    {
        using var f = new CoreFixture();
        f.Write(User, """
            {"TagGroupCaps":{"Quality":2,"FutureCap":7},
             "TagLookRules":[{"Id":"first","FutureRule":true,"When":[{"Field":"type","Value":"Movie"}]}],
             "TagLayoutLocks":{"abcdefabcdefabcdefabcdefabcdefab":{"FutureLock":true}},
             "TagShapeOverrides":{"Landscape":{"Layout":"corners","FutureShape":true},"FutureShapeKind":true}}
            """);
        using var saved = Save(f, settings =>
        {
            settings.TagGroupCaps = null;
            settings.TagShapeOverrides!.Landscape = null;
            settings.TagLookRules = inherit ? null : [];
            settings.TagLayoutLocks = inherit ? null : [];
        });
        var root = saved.RootElement;
        Assert.Equal(JsonValueKind.Null, root.GetProperty("TagGroupCaps").ValueKind);
        Assert.Equal(JsonValueKind.Null, root.GetProperty("TagShapeOverrides").GetProperty("Landscape").ValueKind);
        Assert.True(root.GetProperty("TagShapeOverrides").GetProperty("FutureShapeKind").GetBoolean());
        Assert.Equal(inherit ? "null" : "[]", root.GetProperty("TagLookRules").GetRawText().Replace(" ", "").Replace("\n", "").Replace("\r", ""));
        Assert.Equal(inherit ? "null" : "{}", root.GetProperty("TagLayoutLocks").GetRawText().Replace(" ", "").Replace("\n", "").Replace("\r", ""));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void RepairedRuleIdsKeepTheirOriginsAcrossUnrelatedSavesAndReordering(bool reorder)
    {
        using var f = new CoreFixture();
        f.Write(User, """{"TagLookRules":[{"Id":"","When":[{"Field":"type","Value":"Movie"}],"FutureRule":"first"},{"Id":"rule-1","When":[{"Field":"type","Value":"Series"}],"FutureRule":"second"}]}""");
        using var saved = Save(f, settings => { if (reorder) settings.TagLookRules!.Reverse(); });
        var rules = saved.RootElement.GetProperty("TagLookRules").EnumerateArray().ToArray();
        Assert.Equal("first", rules.Single(rule => rule.GetProperty("When")[0].GetProperty("Value").GetString() == "Movie").GetProperty("FutureRule").GetString());
        Assert.Equal("second", rules.Single(rule => rule.GetProperty("When")[0].GetProperty("Value").GetString() == "Series").GetProperty("FutureRule").GetString());
        Assert.Equal(reorder ? "Series" : "Movie", rules[0].GetProperty("When")[0].GetProperty("Value").GetString());
    }

    [Theory]
    [InlineData("TagLayouts", "{\"Corners\":{\"Groups\":[{\"Group\":\"quality\",\"Slot\":\"invalid\",\"FutureSlot\":\"discarded\"},{\"Group\":\"quality\",\"Slot\":\"tl\",\"FutureSlot\":\"survivor\"}]}}", "Corners", "Groups")]
    [InlineData("TagShapeOverrides", "{\"Landscape\":{\"Slots\":[{\"Group\":\"genre\",\"Slot\":\"dots\",\"FutureSlot\":\"discarded\"},{\"Group\":\"genre\",\"Slot\":\"tl\",\"FutureSlot\":\"survivor\"}]}}", "Landscape", "Slots")]
    public void RetainedSlotsKeepMetadataFromTheValidatedCandidate(string field, string value, string profile, string slots)
    {
        using var f = new CoreFixture();
        f.Write(User, "{\"" + field + "\":" + value + "}");
        using var saved = Save(f);
        var entries = saved.RootElement.GetProperty(field).GetProperty(profile).GetProperty(slots);
        Assert.Single(entries.EnumerateArray());
        Assert.Equal("survivor", entries[0].GetProperty("FutureSlot").GetString());
    }

    [Theory]
    [InlineData("corners", 1, "invalid", 2)]
    [InlineData("corners", -2, "bands", -1)]
    public void LockWinnerUsesTheNormalizersValidationAndClampedTimestamps(string firstLayout, int firstTime, string nextLayout, int nextTime)
    {
        using var f = new CoreFixture();
        f.Write(User, JsonSerializer.Serialize(new { TagLayoutLocks = new Dictionary<string, object>
        {
            [Item] = new { Layout = firstLayout, LockedAt = firstTime, FutureLock = "survivor" },
            [Guid.ParseExact(Item, "N").ToString("D").ToUpperInvariant()] = new { Layout = nextLayout, LockedAt = nextTime, FutureLock = "discarded" },
        }}));
        using var saved = Save(f);
        var retained = saved.RootElement.GetProperty("TagLayoutLocks").GetProperty(Item);
        Assert.Equal("corners", retained.GetProperty("Layout").GetString());
        Assert.Equal("survivor", retained.GetProperty("FutureLock").GetString());
    }

    [Fact]
    public void GuardedControllerPreservesNestedDataWhileUpdatingKnownCaseAliases()
    {
        using var f = new ApiPluginFixture();
        var user = Guid.ParseExact(User, "N");
        f.Core.Write(User, """{"taggroupcaps":{"quality":2,"FutureCap":7},"ISADMIN":true}""");
        var maintenance = new MaintenanceModeService(Moq.Mock.Of<MediaBrowser.Controller.Library.IUserManager>(), Moq.Mock.Of<MediaBrowser.Controller.Session.ISessionManager>(), f.Core.Paths.Object, f.Core.Logger);
        var controller = (JeSettingsController)ApiAssetTests.Controller(typeof(JeSettingsController), f.Core, maintenance, f.Core.Manager);
        controller.HttpContext.User = global::JE.Tests.Features.SpoilerGuard.PrivacyPolicyTests.Principal(user, false);
        var loaded = Assert.IsType<RevisionedSettingsResponse>(Assert.IsType<Microsoft.AspNetCore.Mvc.JsonResult>(controller.GetRevisionedSettings(User)).Value);
        loaded.Settings.TagGroupCaps!.Quality = 4;
        Assert.IsType<Microsoft.AspNetCore.Mvc.JsonResult>(controller.SaveRevisionedSettings(User, new() { Revision = loaded.Revision, Settings = loaded.Settings }));
        using var saved = JsonDocument.Parse(File.ReadAllText(Path.Combine(f.Core.ConfigRoot, User, "settings.json")));
        Assert.False(saved.RootElement.TryGetProperty("taggroupcaps", out _));
        var caps = saved.RootElement.GetProperty("TagGroupCaps");
        Assert.False(caps.TryGetProperty("quality", out _));
        Assert.Equal(4, caps.GetProperty("Quality").GetInt32());
        Assert.Equal(7, caps.GetProperty("FutureCap").GetInt32());
        Assert.DoesNotContain(saved.RootElement.EnumerateObject(), property => property.Name.Equals("IsAdmin", StringComparison.OrdinalIgnoreCase));
    }
}
