using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;

namespace JE.Tests;

/// <summary>
/// Seerr's embedded download rows reach non-admins without release names, download ids or arr ids (C78);
/// the calendar never names an instance on a visible row when that instance's event is hidden (C42).
/// </summary>
public class PrivacySeerrDownloadStatusTests
{
    private static readonly DateTimeOffset Now = new(2026, 10, 14, 12, 0, 0, TimeSpan.Zero);

    internal static JsonObject Row(string title, string downloadId, string status = "downloading", int? season = null, int? episode = null, string? eta = null)
    {
        var row = new JsonObject
        {
            ["externalId"] = 4242, ["mediaType"] = season == null ? "movie" : "tv", ["status"] = status, ["title"] = title, ["downloadId"] = downloadId,
            ["size"] = 4_000_000_000L, ["sizeLeft"] = 1_000_000_000L, ["timeLeft"] = "00:12:00",
            ["estimatedCompletionTime"] = eta ?? Now.AddMinutes(12).ToString("O"),
        };
        if (season != null) row["episode"] = new JsonObject { ["seasonNumber"] = season, ["episodeNumber"] = episode, ["title"] = "Pilot", ["overview"] = "Spoilers", ["id"] = 77 };
        return row;
    }

    internal static string Details() => new JsonObject
    {
        ["id"] = 603, ["title"] = "The Matrix",
        ["mediaInfo"] = new JsonObject
        {
            ["status"] = 3,
            ["serviceId"] = 0, ["externalServiceId"] = 12, ["externalServiceSlug"] = "the-matrix-603",
            ["serviceUrl"] = "http://radarr.lan:7878/movie/the-matrix-603", ["jellyfinMediaId"] = "8f7e6d5c",
            ["downloadStatus"] = new JsonArray(Row("The.Matrix.1999.1080p.BluRay.x264-MOCKHD", "SABnzbd_nzo_abc")),
            ["downloadStatus4k"] = new JsonArray(Row("The.Matrix.1999.2160p.UHD.REMUX-MOCKUHD", "SABnzbd_nzo_4k", status: "Paused", eta: "1999-01-01T00:00:00Z")),
        },
    }.ToJsonString();

    [Fact]
    public void ReleaseDetailsAreReplacedByStatusSizeEtaEpisodeAndAnOpaqueGroup()
    {
        Assert.True(SeerrDownloadStatusProjector.TryProject(Details(), Now, out var body));
        foreach (var secret in new[] { "MOCKHD", "MOCKUHD", "SABnzbd", "nzo_", "externalId", "downloadId", "timeLeft", "4242" })
            Assert.DoesNotContain(secret, body, StringComparison.Ordinal);
        var media = JsonNode.Parse(body)!["mediaInfo"]!;
        var standard = Assert.Single(media["downloadStatus"]!.AsArray())!.AsObject();
        Assert.Equal(new[] { "status", "size", "sizeLeft", "estimatedCompletionTime", "group" }, standard.Select(p => p.Key));
        Assert.Equal(("downloading", 4_000_000_000d, 1_000_000_000d, "g1"), ((string)standard["status"]!, (double)standard["size"]!, (double)standard["sizeLeft"]!, (string)standard["group"]!));
        var fourK = Assert.Single(media["downloadStatus4k"]!.AsArray())!.AsObject();
        Assert.Equal("paused", (string)fourK["status"]!);
        Assert.False(fourK.ContainsKey("estimatedCompletionTime"));       // a stale ETA is dropped
        Assert.Equal("The Matrix", (string)JsonNode.Parse(body)!["title"]!);   // the rest of the answer is untouched
    }

    [Fact]
    public void TheArrLinkOnMediaObjectsIsDroppedEvenWithoutDownloadRows()
    {
        JsonObject Media() => new()
        {
            ["status"] = 3, ["tmdbId"] = 603, ["jellyfinMediaId"] = "8f7e6d5c",
            ["serviceId"] = 0, ["serviceId4k"] = 1, ["externalServiceId"] = 12, ["externalServiceId4k"] = 13,
            ["externalServiceSlug"] = "the-matrix-603", ["externalServiceSlug4k"] = "the-matrix-603-4k",
            ["serviceUrl"] = "http://radarr.lan:7878/movie/the-matrix-603", ["serviceUrl4k"] = "http://radarr4k.lan:7878/movie/the-matrix-603-4k",
        };
        var list = new JsonObject { ["results"] = new JsonArray(new JsonObject { ["id"] = 603, ["mediaInfo"] = Media() }, new JsonObject { ["id"] = 7, ["media"] = Media() }) }.ToJsonString();
        // The same property names written with escapes are the same properties to a JSON reader.
        var escaped = "{\"mediaInfo\":{\"\\u0073erviceUrl\":\"http://radarr.lan:7878/movie/x\",\"status\":3}}";
        foreach (var body in new[] { list, Details(), escaped })
        {
            Assert.True(SeerrDownloadStatusProjector.TryProject(body, Now, out var projected));
            foreach (var secret in new[] { "radarr", "serviceUrl", "serviceId", "externalService", "the-matrix-603" })
                Assert.DoesNotContain(secret, projected, StringComparison.OrdinalIgnoreCase);
            if (body != escaped) Assert.Contains("\"jellyfinMediaId\":\"8f7e6d5c\"", projected, StringComparison.Ordinal);   // what the UI links with stays
        }
    }

    [Fact]
    public void SeasonPackRowsKeepEpisodeNumbersAndShareOneGroupAcrossListsAndRequests()
    {
        var list = new JsonObject
        {
            ["results"] = new JsonArray(
                new JsonObject { ["id"] = 1, ["mediaInfo"] = new JsonObject { ["downloadStatus"] = new JsonArray(Row("Show.S01E01-GRP", "pack", season: 1, episode: 1), Row("Show.S01E02-GRP", "pack", season: 1, episode: 2), Row("Other-GRP", "single", status: "weird")) } },
                new JsonObject { ["id"] = 2, ["media"] = new JsonObject { ["downloadStatus"] = null, ["downloadStatus4k"] = "not an array" } }),
        }.ToJsonString();
        Assert.True(SeerrDownloadStatusProjector.TryProject(list, Now, out var body));
        var rows = JsonNode.Parse(body)!["results"]![0]!["mediaInfo"]!["downloadStatus"]!.AsArray();
        Assert.Equal(3, rows.Count);
        Assert.Equal(("g1", "g1", "g2"), ((string)rows[0]!["group"]!, (string)rows[1]!["group"]!, (string)rows[2]!["group"]!));
        Assert.Equal(new JsonObject { ["seasonNumber"] = 1, ["episodeNumber"] = 2 }.ToJsonString(), rows[1]!["episode"]!.ToJsonString());
        Assert.Equal("unknown", (string)rows[2]!["status"]!);
        var media = JsonNode.Parse(body)!["results"]![1]!["media"]!;
        Assert.Empty(media["downloadStatus"]!.AsArray());                 // malformed relations fail closed to no rows
        Assert.Empty(media["downloadStatus4k"]!.AsArray());
        Assert.DoesNotContain("Pilot", body, StringComparison.Ordinal);
        Assert.DoesNotContain("Spoilers", body, StringComparison.Ordinal);
    }

    [Fact]
    public void BodiesWithoutRowsPassUnparsedAndUnreadableOnesFailClosed()
    {
        const string plain = "{\"results\":[{\"id\":1,\"mediaInfo\":{\"status\":5}}]}";
        Assert.True(SeerrDownloadStatusProjector.TryProject(plain, Now, out var same));
        Assert.Same(plain, same);
        const string empty = "{\"mediaInfo\":{\"downloadStatus\":[],\"downloadStatus4k\":[]}}";
        Assert.True(SeerrDownloadStatusProjector.TryProject(empty, Now, out var unchanged));
        Assert.Equal(JsonNode.Parse(empty)!.ToJsonString(), JsonNode.Parse(unchanged)!.ToJsonString());
        // An escaped property name is the same property.
        var escaped = "{\"mediaInfo\":{\"\\u0064ownloadStatus\":[{\"title\":\"Secret.Release-GRP\",\"status\":\"downloading\"}]}}";
        Assert.True(SeerrDownloadStatusProjector.TryProject(escaped, Now, out var cleaned));
        Assert.DoesNotContain("Secret", cleaned, StringComparison.Ordinal);
        Assert.False(SeerrDownloadStatusProjector.TryProject("{\"downloadStatus\":[{\"title\":\"Secret\"", Now, out _));
    }

    private static ArrItem Event(string instance, int tmdb = 603, bool hasFile = false, string date = "2026-10-20T00:00:00Z")
        => new() { Source = "Radarr", TmdbId = tmdb, Title = "The Matrix", ReleaseType = "digital", ReleaseDate = date, InstanceName = instance, InstanceId = instance, HasFile = hasFile };

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    public void TheCalendarNeverNamesAnInstanceWhoseEventTheCallerCantSee(int order)
    {
        var visible = Event("Movies");
        var hidden = Event("Kids-hidden-4K", hasFile: true);
        var hiddenToo = Event("Private archive", date: "2026-10-20T08:00:00.000Z");
        var events = order switch
        {
            0 => new[] { visible, hidden, hiddenToo },
            1 => new[] { hidden, visible, hiddenToo },
            _ => new[] { hiddenToo, hidden, visible },
        };
        var result = CalendarDedup.Deduplicate(events, e => e.InstanceName == "Movies");
        var row = Assert.Single(result);
        Assert.Same(visible, row);
        Assert.Null(row.AlsoInInstances);
        Assert.DoesNotContain("Kids-hidden-4K", JsonSerializer.Serialize(result), StringComparison.Ordinal);
        Assert.DoesNotContain("Private archive", JsonSerializer.Serialize(result), StringComparison.Ordinal);
    }

    [Fact]
    public void VisibleDuplicatesStillListEachOtherAndAdministratorsSeeEveryInstance()
    {
        var a = Event("Movies");
        var b = Event("Movies 2", hasFile: true);
        var c = Event("Hidden");
        var member = CalendarDedup.Deduplicate(new[] { a, b, c }, e => e.InstanceName != "Hidden");
        Assert.Same(b, Assert.Single(member));            // the copy with the file wins among visible ones
        Assert.Equal(new[] { "Movies" }, b.AlsoInInstances);

        var admin = CalendarDedup.Deduplicate(new[] { Event("Movies"), Event("Movies 2"), Event("Hidden"), Event("Other day", date: "2026-10-21") }, _ => true);
        Assert.Equal(2, admin.Count);
        Assert.Equal(new[] { "Movies 2", "Hidden" }, admin[0].AlsoInInstances);
    }
}
