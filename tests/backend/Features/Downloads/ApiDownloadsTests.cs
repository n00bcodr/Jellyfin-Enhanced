using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Downloads;
using Microsoft.AspNetCore.Mvc;
using static JE.Tests.Features.Seerr.ApiSeerrTests;

namespace JE.Tests.Features.Downloads;

// The Downloads routes (arr/queue, arr/history, arr/requests on JeDownloadsController) under Spoiler Guard, moved
// verbatim from tests/backend/Features/Seerr/ApiSeerrTests.cs (round 13); they share its Seerr fixture.
[Collection("Plugin singleton")]
public class ApiDownloadsTests
{
    // The Downloads caches are shared between users, so a guard can only be applied on the way out.
    [Fact]
    public async Task DownloadsHideGuardedEpisodeTitlesPerUserOverTheSharedCache()
    {
        using var f = GuardedSeerr(out _);
        f.Reply = _ => IntegrationTransport.Response("{\"records\":[{\"id\":1,\"series\":{\"title\":\"Show\",\"tvdbId\":71663},\"episode\":{\"seasonNumber\":2,\"episodeNumber\":5,\"title\":\"Secret title\"},\"status\":\"downloading\",\"size\":100,\"sizeleft\":50}]}");
        f.SetUser(f.UserId, admin: true);
        var guarded = Rows(await f.Downloads().GetDownloadQueue(), "items")[0];
        Assert.Equal("S02E05", guarded.GetProperty("subtitle").GetString());
        Assert.Equal("Show", guarded.GetProperty("title").GetString());
        f.SetUser(f.OtherUserId, admin: true);
        Assert.Equal("S02E05 - Secret title", Rows(await f.Downloads().GetDownloadQueue(), "items")[0].GetProperty("subtitle").GetString());
        f.SetUser(f.UserId, admin: true);
        Assert.Equal("S02E05", Rows(await f.Downloads().GetDownloadQueue(), "items")[0].GetProperty("subtitle").GetString());
    }

    [Fact]
    public async Task HistoryHidesGuardedEpisodeTitlesAndLeavesOtherRowsWhole()
    {
        using var f = GuardedSeerr(out _);
        f.Plugin.Plugin.Configuration.DownloadsShowHistory = true;
        f.Reply = _ => IntegrationTransport.Response("{\"records\":["
            + "{\"eventType\":\"downloadFolderImported\",\"date\":\"2026-11-01T00:00:00Z\",\"downloadId\":\"a\",\"series\":{\"title\":\"Show\",\"tvdbId\":71663},\"episode\":{\"seasonNumber\":2,\"episodeNumber\":5,\"title\":\"Secret title\"}},"
            + "{\"eventType\":\"downloadFolderImported\",\"date\":\"2026-10-01T00:00:00Z\",\"downloadId\":\"b\",\"series\":{\"title\":\"Other\",\"tvdbId\":7},\"episode\":{\"seasonNumber\":1,\"episodeNumber\":1,\"title\":\"Open title\"}}]}");
        f.SetUser(f.UserId, admin: true);
        var rows = Rows(await f.Downloads().GetDownloadHistory(), "items");
        Assert.Equal("S02E05", rows[0].GetProperty("subtitle").GetString());
        Assert.Equal("S01E01 - Open title", rows[1].GetProperty("subtitle").GetString());
        Assert.False(string.IsNullOrEmpty(rows[0].GetProperty("date").GetString()));
    }

    [Fact]
    public async Task RequestRowsHideGuardedDatesWhileComingSoonStillWorks()
    {
        using var f = GuardedSeerr(out _);
        const string Requests = "{\"pageInfo\":{\"results\":1},\"results\":[{\"id\":1,\"type\":\"tv\",\"status\":2,\"createdAt\":\"2026-01-01T00:00:00Z\",\"media\":{\"tmdbId\":1433,\"tvdbId\":71663,\"status\":4},\"requestedBy\":{\"displayName\":\"A\"}}]}";
        const string Show = "{\"name\":\"Show\",\"firstAirDate\":\"2005-02-06\",\"posterPath\":\"/p.jpg\",\"nextEpisodeToAir\":{\"airDate\":\"2099-01-01\"}}";
        f.Reply = request => IntegrationTransport.Response(request.RequestUri!.AbsolutePath == "/api/v1/tv/1433" ? Show : Requests);
        f.SetUser(f.UserId, admin: true);
        var row = Rows(await f.Downloads().GetRequests(), "requests")[0];
        Assert.Equal(JsonValueKind.Null, row.GetProperty("nextAirDate").ValueKind);
        Assert.Equal(JsonValueKind.Null, row.GetProperty("initialAirDate").ValueKind);
        Assert.True(row.GetProperty("isComingSoon").GetBoolean());
        Assert.Equal("Show", row.GetProperty("title").GetString());
        f.SetUser(f.OtherUserId, admin: true);
        Assert.Equal("2099-01-01", Rows(await f.Downloads().GetRequests(), "requests")[0].GetProperty("nextAirDate").GetString());
    }
}
