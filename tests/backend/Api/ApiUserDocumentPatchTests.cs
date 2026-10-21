using System.Security.Claims;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Microsoft.AspNetCore.Mvc;

namespace JE.Tests;

/// <summary>
/// Stage 1 fix round 7: the settings store sends a per-user document's changes, never the document
/// (PATCH user-settings/{id}/{file}). The server applies them to the document it holds then, under the file's lock: a
/// change another tab or device saved meanwhile stays unless this one changed it too; bookmarks, shortcuts and trigger
/// picks change item by item.
/// </summary>
[Collection("Plugin singleton")]
public class ApiUserDocumentPatchTests
{
    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement.Clone();

    private static JellyfinEnhancedController Controller(ApiPluginFixture f, Guid caller, bool admin = false)
    {
        var c = ApiAssetTests.Controller(f.Core, f.Core.Manager);
        c.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity(
            new[] { new Claim("Jellyfin-UserId", caller.ToString()), new Claim(ClaimTypes.Role, admin ? "Administrator" : "User") }, "test"));
        return c;
    }

    private static JsonNode Document(IActionResult result)
        => JsonNode.Parse(JsonSerializer.Serialize(Assert.IsType<OkObjectResult>(result).Value))!["document"]!;

    private static JellyfinEnhancedController.UserDocumentPatch Set(params (string Field, string Raw)[] fields)
        => new() { Set = fields.ToDictionary(f => f.Field, f => Json(f.Raw)) };

    // RBS1-R7-4: another tab's PauseScreenDelaySeconds=12 survives a field-scoped panel change.
    [Fact]
    public void ASettingsChangeKeepsWhatAnotherTabSavedMeanwhile()
    {
        using var f = new ApiPluginFixture();
        var person = Guid.NewGuid();
        var id = person.ToString("N");
        f.Core.Manager.SaveUserConfiguration(id, "settings.json", new JellyfinEnhancedUserSettings { PauseScreenDelaySeconds = 5, DisplayLanguage = "de", AutoPauseEnabled = false });
        // Another tab saves a delay of 12 after this one read the document.
        var other = f.Core.Manager.GetUserConfiguration<JellyfinEnhancedUserSettings>(id, "settings.json");
        other.PauseScreenDelaySeconds = 12;
        f.Core.Manager.SaveUserConfiguration(id, "settings.json", other);

        var answer = Controller(f, person).PatchUserSettingsSettings(id, Set(("AutoPauseEnabled", "true")));

        var stored = f.Core.Manager.GetUserConfiguration<JellyfinEnhancedUserSettings>(id, "settings.json");
        Assert.True(stored.AutoPauseEnabled);
        Assert.Equal(12, stored.PauseScreenDelaySeconds);
        Assert.Equal("de", stored.DisplayLanguage);
        // The answer is the stored document, as the read hands it out.
        var document = Document(answer);
        Assert.Equal(12, (int)document["PauseScreenDelaySeconds"]!);
        Assert.False((bool)document["IsAdmin"]!);
    }

    [Fact]
    public void FieldNamesInAnyCaseAreReadAConsentIsNeverChangedAndTheLanguagePassesTheGate()
    {
        using var f = new ApiPluginFixture();
        var person = Guid.NewGuid();
        var id = person.ToString("N");
        f.Core.Manager.SaveUserConfiguration(id, "settings.json", new JellyfinEnhancedUserSettings { ListSwapIn = false });
        Controller(f, person).PatchUserSettingsSettings(id, Set(("showFileSizes", "true"), ("ListSwapIn", "true"), ("displayLanguage", "\"undefined\""), ("NoSuchField", "1")));
        var stored = f.Core.Manager.GetUserConfiguration<JellyfinEnhancedUserSettings>(id, "settings.json");
        Assert.True(stored.ShowFileSizes);
        Assert.False(stored.ListSwapIn);
        Assert.Equal(string.Empty, stored.DisplayLanguage);
    }

    [Fact]
    public void APersonWithoutSettingsGetsTheDefaultsTheFirstReadWouldStorePlusTheChange()
    {
        using var f = new ApiPluginFixture();
        f.Plugin.Configuration.PauseScreenDelaySeconds = 9;
        var person = Guid.NewGuid();
        var id = person.ToString("N");
        Controller(f, person).PatchUserSettingsSettings(id, Set(("ShowFileSizes", "true")));
        var stored = f.Core.Manager.GetUserConfiguration<JellyfinEnhancedUserSettings>(id, "settings.json");
        Assert.True(stored.ShowFileSizes);
        Assert.Equal(UserSettingsDefaults.Create(f.Plugin.Configuration).PauseScreenDelaySeconds, stored.PauseScreenDelaySeconds);
    }

    [Fact]
    public void AValueOfTheWrongTypeIsRefusedAndNothingIsSaved()
    {
        using var f = new ApiPluginFixture();
        var person = Guid.NewGuid();
        var id = person.ToString("N");
        f.Core.Manager.SaveUserConfiguration(id, "settings.json", new JellyfinEnhancedUserSettings { PauseScreenDelaySeconds = 5 });
        Assert.IsType<BadRequestObjectResult>(Controller(f, person).PatchUserSettingsSettings(id, Set(("PauseScreenDelaySeconds", "\"soon\""))));
        Assert.Equal(5, f.Core.Manager.GetUserConfiguration<JellyfinEnhancedUserSettings>(id, "settings.json").PauseScreenDelaySeconds);
    }

    [Fact]
    public void AnotherPersonsDocumentsAreOnlyForAdministrators()
    {
        using var f = new ApiPluginFixture();
        var owner = Guid.NewGuid().ToString("N");
        Assert.IsNotType<OkObjectResult>(Controller(f, Guid.NewGuid()).PatchUserSettingsSettings(owner, Set(("ShowFileSizes", "true"))));
        Assert.IsNotType<OkObjectResult>(Controller(f, Guid.NewGuid()).PatchUserBookmark(owner, new() { Upsert = new() { ["Bm_1"] = Json("{}") } }));
        Assert.IsType<OkObjectResult>(Controller(f, Guid.NewGuid(), admin: true).PatchUserSettingsSettings(owner, Set(("ShowFileSizes", "true"))));
    }

    // RBS1-R7-6 (server side): bookmarks change one by one; one another tab added stays.
    [Fact]
    public void BookmarksAreAddedReplacedAndRemovedByIdKeepingTheRest()
    {
        using var f = new ApiPluginFixture();
        var person = Guid.NewGuid();
        var id = person.ToString("N");
        f.Core.Manager.SaveUserConfiguration(id, "bookmark.json", new UserBookmark
        {
            Bookmarks = { ["Bm_1"] = new BookmarkItem { ItemId = "a", Label = "one" }, ["Bm_2"] = new BookmarkItem { ItemId = "b" }, ["Bm_other"] = new BookmarkItem { ItemId = "c" } },
        });
        var answer = Controller(f, person).PatchUserBookmark(id, new()
        {
            Upsert = new() { ["Bm_1"] = Json("""{"ItemId":"a","Label":"edited","Timestamp":5}"""), ["Bm_3"] = Json("""{"itemId":"d"}""") },
            Remove = new() { Json("\"Bm_2\""), Json("\"Bm_gone\"") },
        });
        var stored = f.Core.Manager.GetUserConfiguration<UserBookmark>(id, "bookmark.json").Bookmarks;
        Assert.Equal(new[] { "Bm_1", "Bm_3", "Bm_other" }, stored.Keys.OrderBy(k => k, StringComparer.Ordinal));
        Assert.Equal("edited", stored["Bm_1"].Label);
        Assert.Equal("d", stored["Bm_3"].ItemId);
        Assert.Equal("c", (string?)Document(answer)["Bookmarks"]!["Bm_other"]!["ItemId"]);
    }

    [Fact]
    public void TriggerPicksAreAddedAndRemovedOneByOne()
    {
        using var f = new ApiPluginFixture();
        var person = Guid.NewGuid();
        var id = person.ToString("N");
        f.Core.Manager.SaveUserConfiguration(id, "ddd-triggers.json", new DddSettings { Triggers = { 1, 4 } });
        Controller(f, person).PatchUserSettingsDdd(id, new() { Add = new() { Json("2"), Json("1") }, Remove = new() { Json("4"), Json("9") } });
        Assert.Equal(new[] { 1, 2 }, f.Core.Manager.GetUserConfiguration<DddSettings>(id, "ddd-triggers.json").Triggers);
        Assert.IsType<BadRequestObjectResult>(Controller(f, person).PatchUserSettingsDdd(id, new() { Add = new() { Json("\"x\"") } }));
        Assert.Equal(new[] { 1, 2 }, f.Core.Manager.GetUserConfiguration<DddSettings>(id, "ddd-triggers.json").Triggers);
    }

    [Fact]
    public void ShortcutsChangeByNameAndElsewhereByField()
    {
        using var f = new ApiPluginFixture();
        var person = Guid.NewGuid();
        var id = person.ToString("N");
        f.Core.Manager.SaveUserConfiguration(id, "shortcuts.json", new UserShortcuts { Shortcuts = { new Shortcut { Name = "OpenSearch", Key = "/" }, new Shortcut { Name = "GoToHome", Key = "H" } } });
        Controller(f, person).PatchUserSettingsShortcuts(id, new()
        {
            Upsert = new() { ["OpenSearch"] = Json("""{"Key":"S"}"""), ["QuickConnect"] = Json("""{"Name":"ignored","Key":"Q"}""") },
            Remove = new() { Json("\"GoToHome\"") },
        });
        var shortcuts = f.Core.Manager.GetUserConfiguration<UserShortcuts>(id, "shortcuts.json").Shortcuts;
        Assert.Equal(new[] { "OpenSearch:S", "QuickConnect:Q" }, shortcuts.Select(s => s.Name + ":" + s.Key));

        f.Core.Manager.SaveUserConfiguration(id, "elsewhere.json", new ElsewhereSettings { Region = "NZ", Services = { "Netflix" } });
        Controller(f, person).PatchUserSettingsElsewhere(id, Set(("Regions", "[\"AU\"]")));
        var elsewhere = f.Core.Manager.GetUserConfiguration<ElsewhereSettings>(id, "elsewhere.json");
        Assert.Equal("NZ", elsewhere.Region);
        Assert.Equal(new[] { "Netflix" }, elsewhere.Services);
        Assert.Equal(new[] { "AU" }, elsewhere.Regions);
    }
}
