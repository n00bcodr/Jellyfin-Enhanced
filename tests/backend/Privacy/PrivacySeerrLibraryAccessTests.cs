using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr;

namespace JE.Tests;

/// <summary>
/// Seerr names the Jellyfin item of every title it knows, whichever library holds it: a proxied answer keeps
/// only the library links the caller may open, and a list leaves out titles the library hides from them.
/// </summary>
public class PrivacySeerrLibraryAccessTests
{
    internal static readonly Guid Open = Guid.Parse("11111111111111111111111111111111");
    internal static readonly Guid Hidden = Guid.Parse("22222222222222222222222222222222");
    internal static readonly Guid Hidden4k = Guid.Parse("33333333333333333333333333333333");
    internal static readonly Guid Open4k = Guid.Parse("44444444444444444444444444444444");
    internal static readonly Guid OtherCopy = Guid.Parse("55555555555555555555555555555555");
    internal static readonly Guid Stale = Guid.Parse("66666666666666666666666666666666");

    internal static SeerrLibraryCopy Copy(Guid id)
        => id == Open || id == Open4k || id == OtherCopy ? SeerrLibraryCopy.Visible
            : id == Hidden || id == Hidden4k ? SeerrLibraryCopy.Hidden
            : SeerrLibraryCopy.Missing;

    private static JsonObject Row(int tmdb, string type, Guid? id = null, Guid? id4k = null)
    {
        var info = new JsonObject { ["tmdbId"] = tmdb, ["mediaType"] = type, ["status"] = 5 };
        if (id is { } a) { info["jellyfinMediaId"] = a.ToString("N"); info["mediaUrl"] = "http://jf/web/#/details?id=" + a.ToString("N"); }
        if (id4k is { } b) { info["jellyfinMediaId4k"] = b.ToString("N"); info["mediaUrl4k"] = "http://jf/web/#/details?id=" + b.ToString("N"); }
        return new JsonObject { ["id"] = tmdb, ["mediaType"] = type, ["title"] = "Title " + tmdb, ["mediaInfo"] = info };
    }

    private static string Project(string body, Func<string, int, Guid?>? other = null)
    {
        Assert.True(SeerrLibraryAccessProjector.TryProject(body, Copy, other ?? ((_, _) => null), out var projected));
        return projected;
    }

    [Fact]
    public void AListLeavesOutTitlesTheLibraryHidesFromTheCallerAndKeepsTheRest()
    {
        var body = new JsonObject
        {
            ["page"] = 1,
            ["results"] = new JsonArray(
                Row(1, "movie", Open),
                Row(2, "tv", Hidden),                 // only copy hidden -> out
                Row(3, "movie"),                      // not in the library -> as Seerr sent it
                Row(4, "movie", Hidden, Hidden4k),    // both copies hidden -> out
                Row(5, "movie", Stale)),              // stale Seerr id, no such item -> as Seerr sent it
        }.ToJsonString();
        var projected = JsonNode.Parse(Project(body))!;
        Assert.Equal(new[] { 1, 3, 5 }, projected["results"]!.AsArray().Select(r => (int)r!["id"]!));
        var text = projected.ToJsonString();
        foreach (var secret in new[] { Hidden, Hidden4k })
            Assert.DoesNotContain(secret.ToString("N"), text, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Title 2", text, StringComparison.Ordinal);
        Assert.Contains(Open.ToString("N"), text, StringComparison.Ordinal);
        Assert.Contains(Stale.ToString("N"), text, StringComparison.Ordinal);
    }

    [Fact]
    public void AHiddenStandardCopyGivesWayToACopyTheCallerCanOpen()
    {
        var body = new JsonObject
        {
            ["cast"] = new JsonArray(Row(10, "movie", Hidden, Open4k)),     // the 4K copy is theirs
            ["crew"] = new JsonArray(Row(11, "tv", Hidden)),                // another copy found by TMDB id
        }.ToJsonString();
        var projected = JsonNode.Parse(Project(body, (type, tmdb) => type == "tv" && tmdb == 11 ? OtherCopy : null))!;
        var fourK = projected["cast"]![0]!["mediaInfo"]!;
        Assert.Equal(Open4k.ToString("N"), (string)fourK["jellyfinMediaId"]!);
        Assert.Equal(Open4k.ToString("N"), (string)fourK["jellyfinMediaId4k"]!);
        Assert.Null(fourK["mediaUrl"]);
        var other = projected["crew"]![0]!["mediaInfo"]!;
        Assert.Equal(OtherCopy.ToString("N"), (string)other["jellyfinMediaId"]!);
        Assert.DoesNotContain(Hidden.ToString("N"), projected.ToJsonString(), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void ATitlesOwnDetailsRequestsAndIssuesKeepTheirRowWithoutTheHiddenLinks()
    {
        var details = Row(20, "movie", Hidden, Open4k);
        details["mediaInfo"]!["jellyfinMediaId4k"] = Hidden4k.ToString("N");
        var detail = JsonNode.Parse(Project(details.ToJsonString()))!;
        Assert.Equal("Title 20", (string)detail["title"]!);
        var info = detail["mediaInfo"]!.AsObject();
        Assert.False(info.ContainsKey("jellyfinMediaId") || info.ContainsKey("jellyfinMediaId4k") || info.ContainsKey("mediaUrl") || info.ContainsKey("mediaUrl4k"));
        var requests = new JsonObject
        {
            ["results"] = new JsonArray(new JsonObject { ["id"] = 7, ["media"] = Row(21, "tv", Hidden)["mediaInfo"]!.DeepClone() }),
        }.ToJsonString();
        var list = JsonNode.Parse(Project(requests))!["results"]!.AsArray();
        var media = Assert.Single(list)!["media"]!.AsObject();
        Assert.Equal(21, (int)media["tmdbId"]!);
        Assert.False(media.ContainsKey("jellyfinMediaId"));
    }

    [Fact]
    public void BodiesWithoutLibraryLinksPassUnparsedEscapedNamesAreTheSameAndUnreadableOnesFailClosed()
    {
        const string plain = "{\"results\":[{\"id\":1,\"mediaInfo\":{\"status\":5}}]}";
        Assert.Same(plain, Project(plain));
        var visible = new JsonObject { ["results"] = new JsonArray(Row(1, "movie", Open)) }.ToJsonString();
        Assert.Same(visible, Project(visible));                       // nothing hidden: Seerr's own text
        var escaped = "{\"results\":[{\"id\":2,\"mediaInfo\":{\"\\u006aellyfinMediaId\":\"" + Hidden.ToString("N") + "\"}}]}";
        Assert.Equal("{\"results\":[]}", Project(escaped));
        Assert.False(SeerrLibraryAccessProjector.TryProject("{\"jellyfinMediaId\":\"x\"", Copy, (_, _) => null, out _));
    }

    [Fact]
    public void WithoutACallerEveryItemThatExistsCountsAsHidden()
    {
        // The controller passes "hidden whenever it exists" when no caller resolves.
        var body = new JsonObject { ["results"] = new JsonArray(Row(1, "movie", Open), Row(2, "movie", Stale)) }.ToJsonString();
        Assert.True(SeerrLibraryAccessProjector.TryProject(body, id => id == Stale ? SeerrLibraryCopy.Missing : SeerrLibraryCopy.Hidden, (_, _) => null, out var projected));
        Assert.Equal(new[] { 2 }, JsonNode.Parse(projected)!["results"]!.AsArray().Select(r => (int)r!["id"]!));
    }
}
