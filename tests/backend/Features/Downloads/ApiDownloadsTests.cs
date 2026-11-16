using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Downloads;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Seerr;
using Microsoft.AspNetCore.Mvc;
using static JE.Tests.Features.Seerr.ApiSeerrTests;

namespace JE.Tests.Features.Downloads;

// The Downloads routes (arr/queue, arr/history, arr/requests on JeDownloadsController) under Spoiler Guard, moved
// verbatim from tests/backend/Features/Seerr/ApiSeerrTests.cs (round 13), and the Remove request route; they share its Seerr fixture.
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

    // Upstream 6916b31b (#1050): DELETE arr/requests/{requestId}, the Requests page's Remove request button.
    // Seerr request 5 belongs to Seerr user 27 (f.UserId); request 6 to user 38 (f.OtherUserId).
    private static Func<HttpRequestMessage, HttpResponseMessage> RequestOwners(int getStatus = 200, int deleteStatus = 204) => request =>
    {
        if (request.Method == HttpMethod.Delete) return new HttpResponseMessage((System.Net.HttpStatusCode)deleteStatus);
        if (getStatus != 200) return IntegrationTransport.Response("{\"message\":\"Request not found.\"}", getStatus);
        var owner = request.RequestUri!.AbsolutePath.EndsWith("/5") ? 27 : 38;
        return IntegrationTransport.Response(JsonSerializer.Serialize(new { id = 1, status = 2, requestedBy = new { id = owner } }));
    };

    private static int Status(IActionResult result) => result switch
    {
        OkObjectResult => 200,
        ObjectResult o => o.StatusCode ?? 200,
        StatusCodeResult s => s.StatusCode,
        _ => 0
    };

    [Fact]
    public async Task ARequesterRemovesTheirOwnApprovedRequestWithoutManagePermission()
    {
        using var f = new SeerrFixture { Permissions = JellyseerrPermission.REQUEST, Reply = RequestOwners() };
        Assert.Equal(200, Status(await f.Downloads().RemoveRequest(5)));
        var delete = Assert.Single(f.Calls, c => c.Method == "DELETE");
        Assert.Equal("/api/v1/request/5", delete.Path);
        // Sent as the Seerr admin: Seerr itself would refuse an owner's approved request.
        Assert.Null(delete.User);
    }

    [Fact]
    public async Task SomeoneElsesRequestNeedsManagePermission()
    {
        using var f = new SeerrFixture { Permissions = JellyseerrPermission.REQUEST, Reply = RequestOwners() };
        Assert.Equal(403, Status(await f.Downloads().RemoveRequest(6)));
        Assert.DoesNotContain(f.Calls, c => c.Method == "DELETE");

        f.Permissions = JellyseerrPermission.REQUEST | JellyseerrPermission.MANAGE_REQUESTS;
        SeerrCaches.ClearAllSeerrCachesOnConfigChange();
        Assert.Equal(200, Status(await f.Downloads().RemoveRequest(6)));
        Assert.Single(f.Calls, c => c.Method == "DELETE" && c.Path == "/api/v1/request/6");
    }

    [Fact]
    public async Task AJellyfinAdminRemovesAnyRequest()
    {
        using var f = new SeerrFixture { Permissions = JellyseerrPermission.NONE, Reply = RequestOwners() };
        f.SetUser(f.UserId, admin: true);
        Assert.Equal(200, Status(await f.Downloads().RemoveRequest(6)));
        Assert.Single(f.Calls, c => c.Method == "DELETE");
    }

    [Fact]
    public async Task ARequestDeletedBetweenTheReadAndTheDeleteCountsAsRemoved()
    {
        using var f = new SeerrFixture { Permissions = JellyseerrPermission.REQUEST, Reply = RequestOwners(deleteStatus: 404) };
        Assert.Equal(200, Status(await f.Downloads().RemoveRequest(5)));
    }

    [Fact]
    public async Task AMissingRequestCountsAsRemovedForManagersOnly()
    {
        using var f = new SeerrFixture { Permissions = JellyseerrPermission.REQUEST | JellyseerrPermission.MANAGE_REQUESTS, Reply = RequestOwners(getStatus: 404) };
        Assert.Equal(200, Status(await f.Downloads().RemoveRequest(5)));

        // A plain user gets the answer they would get for someone else's request, so the ids
        // of existing requests cannot be probed.
        f.Permissions = JellyseerrPermission.REQUEST;
        SeerrCaches.ClearAllSeerrCachesOnConfigChange();
        Assert.Equal(403, Status(await f.Downloads().RemoveRequest(5)));
        Assert.DoesNotContain(f.Calls, c => c.Method == "DELETE");
    }

    [Fact]
    public async Task AFailedDeleteIsReported()
    {
        using var f = new SeerrFixture { Reply = RequestOwners(deleteStatus: 500) };
        Assert.NotEqual(200, Status(await f.Downloads().RemoveRequest(5)));
    }

    [Fact]
    public async Task AnUnlinkedUserCannotRemoveRequests()
    {
        using var f = new SeerrFixture { Reply = RequestOwners() };
        f.SetUser(Guid.NewGuid());
        Assert.Equal(404, Status(await f.Downloads().RemoveRequest(5)));
        Assert.DoesNotContain(f.Calls, c => c.Method == "DELETE");
    }

    [Theory]
    [InlineData(JellyseerrPermission.REQUEST, false, true, false)]
    [InlineData(JellyseerrPermission.REQUEST | JellyseerrPermission.MANAGE_REQUESTS, false, true, true)]
    [InlineData(JellyseerrPermission.NONE, true, true, true)]
    public async Task RequestRowsSayWhichRequestsTheCallerMayRemove(JellyseerrPermission permissions, bool admin, bool own, bool others)
    {
        using var f = GuardedSeerr(out _);
        f.Permissions = permissions;
        const string Requests = "{\"pageInfo\":{\"results\":2},\"results\":["
            + "{\"id\":5,\"type\":\"movie\",\"status\":2,\"media\":{\"tmdbId\":603,\"status\":5},\"requestedBy\":{\"id\":27,\"displayName\":\"Me\"}},"
            + "{\"id\":6,\"type\":\"movie\",\"status\":2,\"media\":{\"tmdbId\":604,\"status\":5},\"requestedBy\":{\"id\":38,\"displayName\":\"Them\"}}]}";
        const string Film = "{\"id\":603,\"title\":\"Film\",\"overview\":\"Secret plot\"}";
        f.Reply = request => IntegrationTransport.Response(request.RequestUri!.AbsolutePath == "/api/v1/request" ? Requests : Film);
        f.SetUser(f.UserId, admin);
        var rows = Rows(await f.Downloads().GetRequests(), "requests").EnumerateArray().ToList();
        Assert.Equal(own, rows.Single(r => r.GetProperty("id").GetInt32() == 5).GetProperty("canRemove").GetBoolean());
        Assert.Equal(others, rows.Single(r => r.GetProperty("id").GetInt32() == 6).GetProperty("canRemove").GetBoolean());
    }
}
