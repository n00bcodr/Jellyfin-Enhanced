using System.Security.Claims;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Controllers;
using Microsoft.AspNetCore.Mvc;

namespace JE.Tests;

/// <summary>
/// Stage 1 fix round 9: every route that replaces a per-user document whole (the POST routes kept for older pages and API
/// clients) replaces it only as a change of the revision the writer read: the read routes hand the revision out (ETag),
/// the write sends it back (If-Match), and the server compares it with the stored document's under the file lock. A write
/// without one goes ahead only where it can't lose anything (no document stored yet, or the same document); otherwise
/// nothing is written and the writer is told (409 revision_conflict, with the current revision). Before, an older open tab
/// or an API client's stale document replaced a newer one (RBS1-R9-2).
/// </summary>
[Collection("Plugin singleton")]
public class ApiUserDocumentRevisionTests
{
    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement.Clone();

    internal static JellyfinEnhancedController Controller(ApiPluginFixture f, Guid caller, string? ifMatch = null, bool admin = false)
    {
        var c = ApiAssetTests.Controller(f.Core, f.Core.Manager);
        c.HttpContext.User = new ClaimsPrincipal(new ClaimsIdentity(
            new[] { new Claim("Jellyfin-UserId", caller.ToString()), new Claim(ClaimTypes.Role, admin ? "Administrator" : "User") }, "test"));
        if (ifMatch != null) c.HttpContext.Request.Headers.IfMatch = ifMatch;
        return c;
    }

    /// <summary>The revision a read route handed out (its ETag), as a client sends it back.</summary>
    internal static string ETag(JellyfinEnhancedController c, IActionResult read)
    {
        Assert.IsType<OkObjectResult>(read);
        var tag = c.HttpContext.Response.Headers.ETag.ToString();
        Assert.False(string.IsNullOrEmpty(tag), "the read hands out the document's revision");
        return tag;
    }

    private static int Status(IActionResult result) => result switch
    {
        ObjectResult o => o.StatusCode ?? 200,
        StatusCodeResult s => s.StatusCode,
        _ => 0,
    };

    /// <summary>
    /// One whole-document route: the stored document (seed), its read, another tab's change (an operation), this writer's
    /// own change made on a document (`own(doc)`), and what each change leaves in the stored document.
    /// </summary>
    public sealed record Route(
        string Name,
        Action<UserConfigurationManager, string> Seed,
        Func<JellyfinEnhancedController, string, IActionResult> Read,
        Action<JellyfinEnhancedController, string> OtherTab,
        Func<UserConfigurationManager, string, object> Document,
        Action<object> Own,
        Func<JellyfinEnhancedController, string, object, IActionResult> Write,
        Func<UserConfigurationManager, string, bool> HasOther,
        Func<UserConfigurationManager, string, bool> HasOwn);

    private static readonly string SpoilerFile = Jellyfin.Plugin.JellyfinEnhanced.Services.SpoilerBlurImageFilter.SpoilerBlurFileName;

    private static readonly Route[] Routes =
    {
        new("settings.json",
            (m, id) => m.SaveUserConfiguration(id, "settings.json", new JellyfinEnhancedUserSettings { PauseScreenDelaySeconds = 5, ShowFileSizes = false }),
            (c, id) => c.GetUserSettingsSettings(id),
            (c, id) => c.PatchUserSettingsSettings(id, new() { Set = new() { ["PauseScreenDelaySeconds"] = Json("12") } }),
            (m, id) => m.GetUserConfiguration<JellyfinEnhancedUserSettings>(id, "settings.json"),
            d => ((JellyfinEnhancedUserSettings)d).ShowFileSizes = true,
            (c, id, d) => c.SaveUserSettingsSettings(id, (JellyfinEnhancedUserSettings)d),
            (m, id) => m.GetUserConfiguration<JellyfinEnhancedUserSettings>(id, "settings.json").PauseScreenDelaySeconds == 12,
            (m, id) => m.GetUserConfiguration<JellyfinEnhancedUserSettings>(id, "settings.json").ShowFileSizes == true),
        new("shortcuts.json",
            (m, id) => m.SaveUserConfiguration(id, "shortcuts.json", new UserShortcuts { Shortcuts = { new Shortcut { Name = "A", Key = "1" } } }),
            (c, id) => c.GetUserSettingsShortcuts(id),
            (c, id) => c.PatchUserSettingsShortcuts(id, new() { Upsert = new() { ["B"] = Json("""{"Key":"2"}""") } }),
            (m, id) => m.GetUserConfiguration<UserShortcuts>(id, "shortcuts.json"),
            d => ((UserShortcuts)d).Shortcuts.Add(new Shortcut { Name = "C", Key = "3" }),
            (c, id, d) => c.SaveUserSettingsShortcuts(id, (UserShortcuts)d),
            (m, id) => m.GetUserConfiguration<UserShortcuts>(id, "shortcuts.json").Shortcuts.Any(s => s.Name == "B"),
            (m, id) => m.GetUserConfiguration<UserShortcuts>(id, "shortcuts.json").Shortcuts.Any(s => s.Name == "C")),
        new("bookmark.json",
            (m, id) => m.SaveUserConfiguration(id, "bookmark.json", new UserBookmark { Bookmarks = { ["a"] = new BookmarkItem { ItemId = "a" } } }),
            (c, id) => c.GetUserBookmark(id),
            (c, id) => c.PatchUserBookmark(id, new() { Upsert = new() { ["b"] = Json("""{"ItemId":"b"}""") } }),
            (m, id) => m.GetUserConfiguration<UserBookmark>(id, "bookmark.json"),
            d => ((UserBookmark)d).Bookmarks["c"] = new BookmarkItem { ItemId = "c" },
            (c, id, d) => c.SaveUserBookmark(id, (UserBookmark)d),
            (m, id) => m.GetUserConfiguration<UserBookmark>(id, "bookmark.json").Bookmarks.ContainsKey("b"),
            (m, id) => m.GetUserConfiguration<UserBookmark>(id, "bookmark.json").Bookmarks.ContainsKey("c")),
        new("elsewhere.json",
            (m, id) => m.SaveUserConfiguration(id, "elsewhere.json", new ElsewhereSettings { Region = "US" }),
            (c, id) => c.GetUserSettingsElsewhere(id),
            (c, id) => c.PatchUserSettingsElsewhere(id, new() { Set = new() { ["Services"] = Json("""["Other tab"]""") } }),
            (m, id) => m.GetUserConfiguration<ElsewhereSettings>(id, "elsewhere.json"),
            d => ((ElsewhereSettings)d).Region = "DE",
            (c, id, d) => c.SaveUserSettingsElsewhere(id, (ElsewhereSettings)d),
            (m, id) => m.GetUserConfiguration<ElsewhereSettings>(id, "elsewhere.json").Services.Contains("Other tab"),
            (m, id) => m.GetUserConfiguration<ElsewhereSettings>(id, "elsewhere.json").Region == "DE"),
        new("ddd-triggers.json",
            (m, id) => m.SaveUserConfiguration(id, "ddd-triggers.json", new DddSettings { Triggers = { 1 } }),
            (c, id) => c.GetUserSettingsDdd(id),
            (c, id) => c.PatchUserSettingsDdd(id, new() { Add = new() { Json("2") } }),
            (m, id) => m.GetUserConfiguration<DddSettings>(id, "ddd-triggers.json"),
            d => ((DddSettings)d).Triggers.Add(3),
            (c, id, d) => c.SaveUserSettingsDdd(id, (DddSettings)d),
            (m, id) => m.GetUserConfiguration<DddSettings>(id, "ddd-triggers.json").Triggers.Contains(2),
            (m, id) => m.GetUserConfiguration<DddSettings>(id, "ddd-triggers.json").Triggers.Contains(3)),
        new("hidden-content.json",
            (m, id) => m.SaveUserConfiguration(id, "hidden-content.json", new UserHiddenContent { Items = { ["a"] = new HiddenContentItem { ItemId = "a" } } }),
            (c, id) => c.GetUserHiddenContent(id),
            (c, id) => c.PatchUserHiddenContent(id, new() { Upsert = new() { ["b"] = Json("""{"ItemId":"b"}""") } }),
            (m, id) => m.GetUserConfiguration<UserHiddenContent>(id, "hidden-content.json"),
            d => ((UserHiddenContent)d).Items["c"] = new HiddenContentItem { ItemId = "c" },
            (c, id, d) => c.SaveUserHiddenContent(id, (UserHiddenContent)d),
            (m, id) => m.GetUserConfiguration<UserHiddenContent>(id, "hidden-content.json").Items.ContainsKey("b"),
            (m, id) => m.GetUserConfiguration<UserHiddenContent>(id, "hidden-content.json").Items.ContainsKey("c")),
        new("spoilerblur.json",
            (m, id) => m.SaveUserConfiguration(id, SpoilerFile, new UserSpoilerBlur { Prefs = new SpoilerBlurUserPrefs { HideCast = null } }),
            (c, id) => c.GetUserSpoilerBlur(id),
            (c, id) => c.PatchSpoilerBlurUserPrefs(new() { Set = new() { ["HideTags"] = Json("false") } }),
            (m, id) => m.GetUserConfiguration<UserSpoilerBlur>(id, SpoilerFile),
            d => ((UserSpoilerBlur)d).Prefs.HideCast = false,
            (c, id, d) => c.SaveUserSpoilerBlur(id, (UserSpoilerBlur)d),
            (m, id) => m.GetUserConfiguration<UserSpoilerBlur>(id, SpoilerFile).Prefs.HideTags == false,
            (m, id) => m.GetUserConfiguration<UserSpoilerBlur>(id, SpoilerFile).Prefs.HideCast == false),
        new("spoiler-blur/user-prefs",
            (m, id) => m.SaveUserConfiguration(id, SpoilerFile, new UserSpoilerBlur { Prefs = new SpoilerBlurUserPrefs { HideCast = null } }),
            (c, id) => c.GetSpoilerBlurUserPrefs(),
            (c, id) => c.PatchSpoilerBlurUserPrefs(new() { Set = new() { ["HideTags"] = Json("false") } }),
            (m, id) => m.GetUserConfiguration<UserSpoilerBlur>(id, SpoilerFile).Prefs,
            d => ((SpoilerBlurUserPrefs)d).HideCast = false,
            (c, id, d) => c.SetSpoilerBlurUserPrefs((SpoilerBlurUserPrefs)d),
            (m, id) => m.GetUserConfiguration<UserSpoilerBlur>(id, SpoilerFile).Prefs.HideTags == false,
            (m, id) => m.GetUserConfiguration<UserSpoilerBlur>(id, SpoilerFile).Prefs.HideCast == false),
    };

    public static IEnumerable<object[]> RouteNames() => Routes.Select(r => new object[] { r.Name });

    private static Route Find(string name) => Routes.Single(r => r.Name == name);

    // RBS1-R9-2: an older open tab or an API client read the document, another tab changed it (PATCH), and the older one
    // posts its whole document: refused, the newer change stays, whether it sends no revision or the one it read.
    [Theory]
    [MemberData(nameof(RouteNames))]
    public void AStaleWholeDocumentIsRefusedAndTheNewerChangeStays(string name)
    {
        var route = Find(name);
        using var f = new ApiPluginFixture();
        var person = Guid.NewGuid();
        var id = person.ToString("N");
        var m = f.Core.Manager;
        route.Seed(m, id);
        var reader = Controller(f, person);
        var read = ETag(reader, route.Read(reader, id));
        var stale = route.Document(m, id);
        route.Own(stale);
        route.OtherTab(Controller(f, person), id);
        Assert.True(route.HasOther(m, id));

        foreach (var revision in new string?[] { null, read })
        {
            var writer = Controller(f, person, revision);
            var result = route.Write(writer, id, stale);
            Assert.Equal(409, Status(result));
            Assert.Contains("revision_conflict", JsonSerializer.Serialize(((ObjectResult)result).Value), StringComparison.Ordinal);
            Assert.False(string.IsNullOrEmpty(writer.HttpContext.Response.Headers.ETag.ToString()), "the conflict says what the revision is now");
            Assert.True(route.HasOther(m, id), "the newer change stays");
            Assert.False(route.HasOwn(m, id), "nothing of the refused document is written");
        }
    }

    // The same writer, having read again: its document (with the other tab's change) is stored, and the next read hands
    // out a new revision that a later write must send.
    [Theory]
    [MemberData(nameof(RouteNames))]
    public void AWholeDocumentSentWithTheRevisionItReadIsStored(string name)
    {
        var route = Find(name);
        using var f = new ApiPluginFixture();
        var person = Guid.NewGuid();
        var id = person.ToString("N");
        var m = f.Core.Manager;
        route.Seed(m, id);
        var first = Controller(f, person);
        var spent = ETag(first, route.Read(first, id));
        var older = route.Document(m, id);
        route.Own(older);
        route.OtherTab(Controller(f, person), id);
        var reader = Controller(f, person);
        var revision = ETag(reader, route.Read(reader, id));
        Assert.NotEqual(spent, revision);
        var fresh = route.Document(m, id);
        route.Own(fresh);
        var writer = Controller(f, person, revision);
        Assert.Equal(200, Status(route.Write(writer, id, fresh)));
        Assert.True(route.HasOwn(m, id));
        Assert.True(route.HasOther(m, id));
        var after = writer.HttpContext.Response.Headers.ETag.ToString();
        Assert.NotEqual(revision, after);
        var again = Controller(f, person);
        Assert.Equal(after, ETag(again, route.Read(again, id)));
        // A revision read before a later change is spent: a document built on it is refused.
        Assert.Equal(409, Status(route.Write(Controller(f, person, revision), id, older)));
        Assert.Equal(409, Status(route.Write(Controller(f, person, spent), id, older)));
        Assert.True(route.HasOther(m, id));
    }

    // Safe without a revision: nothing stored yet, or the document as stored.
    [Theory]
    [MemberData(nameof(RouteNames))]
    public void AWriteWithoutARevisionGoesAheadOnlyWhereNothingCanBeLost(string name)
    {
        var route = Find(name);
        using var f = new ApiPluginFixture();
        var person = Guid.NewGuid();
        var id = person.ToString("N");
        var m = f.Core.Manager;
        route.Seed(m, id);
        var same = route.Document(m, id);
        var before = JsonSerializer.Serialize(route.Document(m, id), same.GetType());
        Assert.Equal(200, Status(route.Write(Controller(f, person), id, same)));
        Assert.Equal(before, JsonSerializer.Serialize(route.Document(m, id), same.GetType()));

        var fresh = Guid.NewGuid();
        var freshId = fresh.ToString("N");
        var created = route.Document(m, freshId);
        route.Own(created);
        Assert.Equal(200, Status(route.Write(Controller(f, fresh), freshId, created)));
        Assert.True(route.HasOwn(m, freshId), "a first document is stored");
    }

    // If-Match is read as HTTP entity tags (round 10, RBS1-R10-9): the quoted current revision, alone or in a list, is
    // accepted; a weak tag, an unquoted value and "*" name no revision.
    [Fact]
    public void OnlyTheQuotedCurrentRevisionIsAcceptedAndAWildcardIsNotARevision()
    {
        var route = Find("hidden-content.json");
        using var f = new ApiPluginFixture();
        var person = Guid.NewGuid();
        var id = person.ToString("N");
        var m = f.Core.Manager;
        route.Seed(m, id);
        var reader = Controller(f, person);
        var tag = ETag(reader, route.Read(reader, id));
        var bare = tag.Trim('"');

        var star = route.Document(m, id);
        route.Own(star);
        foreach (var refused in new[] { "*", "W/" + tag, bare })
        {
            Assert.Equal(409, Status(route.Write(Controller(f, person, refused), id, star)));
            Assert.False(route.HasOwn(m, id));
        }

        Assert.Equal(200, Status(route.Write(Controller(f, person, "\"older\", " + tag), id, star)));
        var next = route.Document(m, id);
        ((UserHiddenContent)next).Items["d"] = new HiddenContentItem { ItemId = "d" };
        var reread = Controller(f, person);
        var current = ETag(reread, route.Read(reread, id));
        Assert.NotEqual(tag, current);
        Assert.Equal(200, Status(route.Write(Controller(f, person, current), id, next)));
        Assert.True(m.GetUserConfiguration<UserHiddenContent>(id, "hidden-content.json").Items.ContainsKey("d"));
    }

    // An administrator's whole save of another person's settings is fenced the same way.
    [Fact]
    public void AnAdministratorsStaleWholeSaveOfAnotherPersonIsRefused()
    {
        using var f = new ApiPluginFixture();
        var person = Guid.NewGuid();
        var admin = Guid.NewGuid();
        var id = person.ToString("N");
        var m = f.Core.Manager;
        m.SaveUserConfiguration(id, "settings.json", new JellyfinEnhancedUserSettings { PauseScreenDelaySeconds = 5 });
        var stale = m.GetUserConfiguration<JellyfinEnhancedUserSettings>(id, "settings.json");
        stale.ShowFileSizes = true;
        Controller(f, person).PatchUserSettingsSettings(id, new() { Set = new() { ["PauseScreenDelaySeconds"] = Json("12") } });
        Assert.Equal(409, Status(Controller(f, admin, admin: true).SaveUserSettingsSettings(id, stale)));
        Assert.Equal(12, m.GetUserConfiguration<JellyfinEnhancedUserSettings>(id, "settings.json").PauseScreenDelaySeconds);
    }
}
