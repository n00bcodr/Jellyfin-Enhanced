using System.Security.Claims;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Microsoft.AspNetCore.Mvc;

namespace JE.Tests;

/// <summary>
/// Stage 1 fix round 8: Hidden Content and Spoiler Guard's panel overrides were the last per-user documents written whole
/// (the server replaced what it held with what a tab sent). They are now changed item by item and setting by setting
/// (PATCH), applied to the document the server holds then under its file lock, so another tab's or device's change stays.
/// </summary>
[Collection("Plugin singleton")]
public class ApiHiddenContentPatchTests
{
    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement.Clone();

    private static JellyfinEnhancedController Controller(ApiPluginFixture f, Guid caller)
    {
        var c = ApiAssetTests.Controller(f.Core, f.Core.Manager);
        c.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity(
            new[] { new Claim("Jellyfin-UserId", caller.ToString()), new Claim(ClaimTypes.Role, "User") }, "test"));
        return c;
    }

    private static JsonNode Answer(IActionResult result) => JsonNode.Parse(JsonSerializer.Serialize(Assert.IsType<OkObjectResult>(result).Value))!;

    private static HiddenContentItem Item(string id, string scope = "global") => new() { ItemId = id, Name = id, HideScope = scope };

    // RBS1-R8-3: two tabs hide different items; each tab's change is an operation, so both stay.
    [Fact]
    public void ItemsHiddenInTwoTabsAreBothKept()
    {
        using var f = new ApiPluginFixture();
        var person = Guid.NewGuid();
        var id = person.ToString("N");
        f.Core.Manager.SaveUserConfiguration(id, "hidden-content.json", new UserHiddenContent());
        var c = Controller(f, person);
        c.PatchUserHiddenContent(id, new() { Upsert = new() { ["aaaa"] = Json("""{"itemId":"aaaa","name":"A","hideScope":"global"}""") } });
        var answer = Answer(c.PatchUserHiddenContent(id, new() { Upsert = new() { ["bbbb"] = Json("""{"ItemId":"bbbb","Name":"B"}""") } }));
        var stored = f.Core.Manager.GetUserConfiguration<UserHiddenContent>(id, "hidden-content.json");
        Assert.Equal(new[] { "aaaa", "bbbb" }, stored.Items.Keys.OrderBy(k => k));
        Assert.Equal("A", stored.Items["aaaa"].Name);
        Assert.Equal(2, answer["document"]!["Items"]!.AsObject().Count);
    }

    [Fact]
    public void ARemovalTakesTheItemUnderAnySpellingOfItsIdAndKeepsTheRest()
    {
        using var f = new ApiPluginFixture();
        var person = Guid.NewGuid();
        var id = person.ToString("N");
        var dashed = "0123abcd-0000-4000-8000-0000000000ff";
        f.Core.Manager.SaveUserConfiguration(id, "hidden-content.json", new UserHiddenContent
        {
            Items = new() { [dashed] = Item(dashed, "continuewatching"), ["keep"] = Item("keep"), ["tmdb-42"] = new HiddenContentItem { TmdbId = "42" } },
        });
        Controller(f, person).PatchUserHiddenContent(id, new() { Remove = new() { Json("\"0123ABCD0000400080000000000000ff\""), Json("\"tmdb-42\"") } });
        var stored = f.Core.Manager.GetUserConfiguration<UserHiddenContent>(id, "hidden-content.json");
        Assert.Equal(new[] { "keep" }, stored.Items.Keys);
    }

    [Fact]
    public void ASettingChangeKeepsTheOtherSettingsAndEveryItem()
    {
        using var f = new ApiPluginFixture();
        var person = Guid.NewGuid();
        var id = person.ToString("N");
        f.Core.Manager.SaveUserConfiguration(id, "hidden-content.json", new UserHiddenContent
        {
            Items = new() { ["keep"] = Item("keep") },
            Settings = new HiddenContentSettings { FilterSearch = false, ShowButtonCast = true },
        });
        Controller(f, person).PatchUserHiddenContent(id, new() { Set = new() { ["filterSearch"] = Json("true") } });
        var stored = f.Core.Manager.GetUserConfiguration<UserHiddenContent>(id, "hidden-content.json");
        Assert.True(stored.Settings.FilterSearch);
        Assert.True(stored.Settings.ShowButtonCast);
        Assert.Equal(new[] { "keep" }, stored.Items.Keys);
    }

    [Fact]
    public void ABadItemIsRefusedAndNothingIsSaved()
    {
        using var f = new ApiPluginFixture();
        var person = Guid.NewGuid();
        var id = person.ToString("N");
        f.Core.Manager.SaveUserConfiguration(id, "hidden-content.json", new UserHiddenContent { Items = new() { ["keep"] = Item("keep") } });
        var bad = Controller(f, person).PatchUserHiddenContent(id, new() { Upsert = new() { [new string('x', 300)] = Json("{}"), ["ok"] = Json("{}") } });
        Assert.IsType<BadRequestObjectResult>(bad);
        Assert.Equal(new[] { "keep" }, f.Core.Manager.GetUserConfiguration<UserHiddenContent>(id, "hidden-content.json").Items.Keys);
    }

    [Fact]
    public void AnotherPersonsHiddenContentCantBePatched()
    {
        using var f = new ApiPluginFixture();
        var person = Guid.NewGuid();
        var other = Guid.NewGuid().ToString("N");
        f.Core.Manager.SaveUserConfiguration(other, "hidden-content.json", new UserHiddenContent());
        var result = Controller(f, person).PatchUserHiddenContent(other, new() { Upsert = new() { ["x"] = Json("{}") } });
        Assert.IsNotType<OkObjectResult>(result);
        Assert.Empty(f.Core.Manager.GetUserConfiguration<UserHiddenContent>(other, "hidden-content.json").Items);
    }

    // Found by round 8's whole-document writer scan: the panel's Spoiler Guard overrides were posted whole.
    [Fact]
    public void SpoilerGuardOverridesChangedInTwoTabsAreBothKept()
    {
        using var f = new ApiPluginFixture();
        var person = Guid.NewGuid();
        var id = person.ToString("N");
        var file = Jellyfin.Plugin.JellyfinEnhanced.Services.SpoilerBlurImageFilter.SpoilerBlurFileName;
        f.Core.Manager.SaveUserConfiguration(id, file, new UserSpoilerBlur { Prefs = new SpoilerBlurUserPrefs { HideCast = null, SkipDisableConfirm = true } });
        var c = Controller(f, person);
        c.PatchSpoilerBlurUserPrefs(new() { Set = new() { ["HideTags"] = Json("false") } });
        var answer = Answer(c.PatchSpoilerBlurUserPrefs(new() { Set = new() { ["HideCast"] = Json("false") } }));
        var stored = f.Core.Manager.GetUserConfiguration<UserSpoilerBlur>(id, file).Prefs;
        Assert.False(stored.HideTags);
        Assert.False(stored.HideCast);
        Assert.True(stored.SkipDisableConfirm);
        Assert.False((bool)answer["prefs"]!["HideTags"]!);
    }
}
