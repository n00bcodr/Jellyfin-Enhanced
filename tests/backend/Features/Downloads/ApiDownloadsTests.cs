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

    // A failed instance is reported with the history, as with the queue, instead of reading as "no history".
    [Fact]
    public async Task HistoryNamesTheInstanceThatFailed()
    {
        using var f = GuardedSeerr(out _);
        f.Plugin.Plugin.Configuration.DownloadsShowHistory = true;
        f.Reply = _ => IntegrationTransport.Response("{}", 500);
        f.SetUser(f.UserId, admin: true);
        var body = JsonSerializer.SerializeToElement(Assert.IsType<OkObjectResult>(await f.Downloads().GetDownloadHistory()).Value);
        Assert.Empty(body.GetProperty("items").EnumerateArray());
        Assert.Equal("Sonarr", Assert.Single(body.GetProperty("errors").EnumerateArray()).GetProperty("instanceName").GetString());
    }

    // A non-administrator's rows are filtered by their Seerr requests: when that lookup fails, the
    // queue and history fail too, while "no requests" stays an empty list.
    [Fact]
    public async Task NonAdminQueueAndHistoryFailWhenTheSeerrRequestLookupFails()
    {
        using var f = GuardedSeerr(out _);
        f.Plugin.Plugin.Configuration.DownloadsShowHistory = true;
        var seerrDown = true;
        f.Reply = request => request.RequestUri!.AbsolutePath == "/api/v1/request"
            ? (seerrDown ? IntegrationTransport.Response("{}", 500) : IntegrationTransport.Response("{\"results\":[]}"))
            : IntegrationTransport.Response("{\"records\":[]}");
        f.SetUser(f.UserId);
        Assert.Equal(502, Assert.IsType<ObjectResult>(await f.Downloads().GetDownloadQueue()).StatusCode);
        Assert.Equal(502, Assert.IsType<ObjectResult>(await f.Downloads().GetDownloadHistory()).StatusCode);
        seerrDown = false;
        Assert.Empty(Rows(await f.Downloads().GetDownloadQueue(), "items").EnumerateArray());
        Assert.Empty(Rows(await f.Downloads().GetDownloadHistory(), "items").EnumerateArray());
    }

    // The page polls arr/queue and arr/history together: a non-administrator's Seerr request list is
    // read once for both (and for the next poll inside the poll interval), and per Seerr user.
    [Fact]
    public async Task NonAdminQueueAndHistoryShareOneSeerrRequestRead()
    {
        using var f = GuardedSeerr(out _);
        f.Plugin.Plugin.Configuration.DownloadsShowHistory = true;
        f.Plugin.Plugin.Configuration.DownloadsPollIntervalSeconds = 300;
        f.Reply = request => request.RequestUri!.AbsolutePath == "/api/v1/request"
            ? IntegrationTransport.Response("{\"results\":[{\"requestedBy\":{\"id\":27},\"media\":{\"tmdbId\":1433,\"mediaType\":\"tv\"}}]}")
            : IntegrationTransport.Response("{\"records\":[]}");
        f.SetUser(f.UserId);
        await Task.WhenAll(f.Downloads().GetDownloadQueue(), f.Downloads().GetDownloadHistory());
        await f.Downloads().GetDownloadQueue();
        Assert.Single(f.Calls, c => c.Path.StartsWith("/api/v1/request?"));
        f.SetUser(f.OtherUserId);
        await f.Downloads().GetDownloadQueue();
        Assert.Equal(2, f.Calls.Count(c => c.Path.StartsWith("/api/v1/request?")));
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
