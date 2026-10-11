using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders;
using static Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders.SeerrMediaIndex;

namespace JE.Tests;

// Review round 1 (a1): season request state that could not be read stays unknown, offset paging that lost rows to a
// mid-scan delete is never published as complete, and an advisory refresh never overwrites newer statuses.
[Collection("Plugin singleton")]
public class ListPlaceholdersSeerrIndexReviewR1a1Tests
{
    private sealed class Fixture : IDisposable
    {
        public ApiPluginFixture Plugin { get; } = new();
        public List<string> Calls { get; } = new();
        public Func<HttpRequestMessage, Task<HttpResponseMessage>> Reply { get; set; } = _ => Task.FromResult(IntegrationTransport.Response("{\"results\":[]}"));
        public IntegrationTransport Transport { get; }
        public SeerrMediaIndex Index { get; }

        public Fixture()
        {
            Plugin.Plugin.Configuration.JellyseerrEnabled = true;
            Plugin.Plugin.Configuration.JellyseerrUrls = "http://seerr-a.test";
            Plugin.Plugin.Configuration.JellyseerrApiKey = "index-key";
            Transport = new IntegrationTransport(async (request, _) =>
            {
                lock (Calls)
                {
                    Calls.Add(request.RequestUri!.Host + request.RequestUri.PathAndQuery);
                }

                return await Reply(request);
            });
            Index = new SeerrMediaIndex(Transport, Plugin.Core.Logger);
        }

        public bool Called(string fragment)
        {
            lock (Calls)
            {
                return Calls.Any(c => c.Contains(fragment, StringComparison.Ordinal));
            }
        }

        public List<string> MediaCalls()
        {
            lock (Calls)
            {
                return Calls.Where(c => c.Contains("/api/v1/media", StringComparison.Ordinal)).ToList();
            }
        }

        public void Dispose()
        {
            Transport.Dispose();
            Plugin.Dispose();
        }
    }

    private static string Request(int tmdb, int status, string seasons, string updatedAt = "2026-10-10T05:00:05.000Z") =>
        $"{{\"id\":{tmdb},\"status\":{status},\"type\":\"tv\",\"is4k\":false,\"updatedAt\":\"{updatedAt}\",\"media\":{{\"mediaType\":\"tv\",\"tmdbId\":{tmdb},\"status\":2,\"status4k\":1,\"seasons\":[]}},\"seasons\":[{seasons}]}}";

    private static string Page(IEnumerable<string> rows, int? total = null) =>
        "{\"pageInfo\":{" + (total.HasValue ? "\"results\":" + total.Value : string.Empty) + "},\"results\":[" + string.Join(',', rows) + "]}";

    private static string Row(string type, int id, int status, string updatedAt = "2026-10-10T05:00:05.000Z") =>
        $"{{\"mediaType\":\"{type}\",\"tmdbId\":{id},\"status\":{status},\"status4k\":1,\"updatedAt\":\"{updatedAt}\"}}";

    private static Task<HttpResponseMessage> Json(string body) => Task.FromResult(IntegrationTransport.Response(body));

    private static async Task WaitUntil(Func<bool> condition)
    {
        for (var i = 0; i < 500 && !condition(); i++)
        {
            await Task.Delay(10);
        }

        Assert.True(condition());
    }

    // F1: Peacemaker (110492) is requested (media row pending, no availability season rows). When Seerr's request listing
    // can't be read, its seasons are unknown — never "not requested" with a Request button.
    [Fact]
    public async Task SeasonsStayUnknownWhenTheRequestScanFails()
    {
        using var f = new Fixture();
        f.Reply = request => request.RequestUri!.AbsolutePath == "/api/v1/request"
            ? Json("<html>bad gateway</html>")
            : Json(Page(new[] { Row("tv", 110492, 2), Row("tv", 1399, 4).Replace("}", ",\"seasons\":[{\"seasonNumber\":1,\"status\":5}]}", StringComparison.Ordinal) }));
        await f.Index.EnsureFreshAsync();

        Assert.True(f.Index.IsReady); // the media table itself was read completely
        Assert.Equal(2, f.Index.Lookup("tv", 110492).StatusFor(null));
        Assert.Null(f.Index.Lookup("tv", 110492).StatusFor(1));
        Assert.Equal(5, f.Index.Lookup("tv", 1399).StatusFor(1)); // availability rows still answer
        Assert.Null(f.Index.Lookup("tv", 1399).StatusFor(2));
        Assert.Equal(1, f.Index.Lookup("tv", 5555).StatusFor(1)); // no media row: nothing was ever requested

        // A later rebuild that reads the requests completely makes an unrequested season "not requested" again.
        f.Reply = request => Json(Page(request.RequestUri!.AbsolutePath == "/api/v1/request" ? Array.Empty<string>() : new[] { Row("tv", 110492, 2) }));
        await f.Index.ForceRebuildAsync();
        Assert.Equal(1, f.Index.Lookup("tv", 110492).StatusFor(1));
    }

    // F1: more active TV requests than the scan reads (50 full pages per filter) leave the rest unknown.
    [Fact]
    public async Task SeasonsStayUnknownWhenTheRequestScanIsCutOff()
    {
        using var f = new Fixture();
        f.Reply = request =>
        {
            var query = System.Web.HttpUtility.ParseQueryString(request.RequestUri!.Query);
            if (request.RequestUri.AbsolutePath == "/api/v1/media")
            {
                return Json(Page(new[] { Row("tv", 900_001, 2), Row("tv", 1, 2) }));
            }

            var skip = int.Parse(query["skip"]!);
            var take = int.Parse(query["take"]!); // pages after the first overlap the previous one by a row
            return Json(Page(query["filter"] == "pending"
                ? Enumerable.Range(skip + 1, take).Select(id => Request(id, 1, "{\"seasonNumber\":1,\"status\":1}"))
                : Array.Empty<string>()));
        };
        await f.Index.EnsureFreshAsync();

        Assert.True(f.Index.IsReady);
        Assert.Equal(2, f.Index.Lookup("tv", 1).StatusFor(1)); // read: pending
        Assert.Null(f.Index.Lookup("tv", 900_001).StatusFor(1)); // beyond the scanned pages: unknown, not 1
    }

    // F1: a failed request scan keeps what the previous snapshot and JE's own requests already knew.
    [Fact]
    public async Task AFailedRequestScanKeepsTheKnownRequestState()
    {
        using var f = new Fixture();
        f.Reply = request =>
        {
            var query = System.Web.HttpUtility.ParseQueryString(request.RequestUri!.Query);
            if (request.RequestUri.AbsolutePath == "/api/v1/media")
            {
                return Json(Page(new[] { Row("tv", 1399, 2) }));
            }

            return Json(Page(query["filter"] == "pending" ? new[] { Request(1399, 1, "{\"seasonNumber\":2,\"status\":1}") } : Array.Empty<string>()));
        };
        await f.Index.EnsureFreshAsync();
        Assert.Equal((2, 1), (f.Index.Lookup("tv", 1399).StatusFor(2)!.Value, f.Index.Lookup("tv", 1399).StatusFor(4)!.Value));
        f.Index.RecordRequestResponse(Request(1399, 1, "{\"seasonNumber\":4,\"status\":1}"));

        f.Reply = request => request.RequestUri!.AbsolutePath == "/api/v1/request"
            ? throw new HttpRequestException("timeout")
            : Json(Page(new[] { Row("tv", 1399, 2) }));
        await Task.Delay(5);
        await f.Index.ForceRebuildAsync();

        var got = f.Index.Lookup("tv", 1399);
        Assert.Equal(2, got.StatusFor(2)); // from the previous snapshot
        Assert.Equal(2, got.StatusFor(4)); // JE's own request, written before this rebuild started
        Assert.Null(got.StatusFor(3));
    }

    // F3: Seerr deletes the newest media row between two pages; offset paging then skips the oldest row. The index must
    // notice (pageInfo.results shrank) and re-read instead of publishing that row as "never requested".
    [Fact]
    public async Task AMidScanDeleteIsDetectedAndTheScanRepeated()
    {
        using var f = new Fixture();
        var table = Enumerable.Range(1, 501).Reverse().ToList(); // id DESC
        var mediaPages = 0;
        f.Reply = request =>
        {
            if (request.RequestUri!.AbsolutePath != "/api/v1/media")
            {
                return Json(Page(Array.Empty<string>(), 0));
            }

            var query = System.Web.HttpUtility.ParseQueryString(request.RequestUri.Query);
            var skip = int.Parse(query["skip"]!);
            var take = int.Parse(query["take"]!);
            string body;
            lock (table)
            {
                body = Page(table.Skip(skip).Take(take).Select(id => Row("movie", id, 5)), table.Count);
                if (++mediaPages == 1)
                {
                    table.Remove(501);
                }
            }

            return Json(body);
        };
        await f.Index.EnsureFreshAsync();

        Assert.True(f.Index.IsReady);
        Assert.Equal(5, f.Index.Lookup("movie", 1).StatusFor(null));
        Assert.Equal(LookupState.Absent, f.Index.Lookup("movie", 501).State);
        Assert.Equal(4, f.MediaCalls().Count); // skip=0, skip=500, then once more from the start
    }

    // F3: if Seerr's own row count can't be matched even on the second pass, the rebuild fails (unknown) instead of
    // publishing missing rows as absent.
    [Fact]
    public async Task APagingResultThatNeverMatchesSeerrsTotalIsNotPublished()
    {
        using var f = new Fixture();
        f.Reply = request => Json(request.RequestUri!.AbsolutePath == "/api/v1/media"
            ? Page(new[] { Row("movie", 3, 5), Row("movie", 2, 5), Row("movie", 1, 5) }, 600)
            : Page(Array.Empty<string>(), 0));
        await f.Index.EnsureFreshAsync();

        Assert.False(f.Index.IsReady);
        Assert.True(f.Index.LastRebuildFailed);
        Assert.Equal(LookupState.Unknown, f.Index.Lookup("movie", 4).State);
        Assert.Equal(2, f.MediaCalls().Count);
    }

    // F3: rows inserted while paging only shift rows down (re-read, never skipped): no rescan needed.
    [Fact]
    public async Task InsertsWhilePagingDoNotForceARescan()
    {
        using var f = new Fixture();
        var table = Enumerable.Range(1, 600).Reverse().ToList();
        f.Reply = request =>
        {
            if (request.RequestUri!.AbsolutePath != "/api/v1/media")
            {
                return Json(Page(Array.Empty<string>(), 0));
            }

            var query = System.Web.HttpUtility.ParseQueryString(request.RequestUri.Query);
            string body;
            lock (table)
            {
                body = Page(table.Skip(int.Parse(query["skip"]!)).Take(int.Parse(query["take"]!)).Select(id => Row("movie", id, 5)), table.Count);
                table.Insert(0, table[0] + 1);
            }

            return Json(body);
        };
        await f.Index.EnsureFreshAsync();

        Assert.True(f.Index.IsReady);
        Assert.Equal(2, f.MediaCalls().Count);
        Assert.Equal(5, f.Index.Lookup("movie", 1).StatusFor(null));
    }

    // F4: an advisory page read before JE's own request must not overwrite the status that request recorded.
    [Fact]
    public async Task AnAdvisoryPageReadBeforeJesRequestDoesNotOverwriteIt()
    {
        using var f = new Fixture();
        await f.Index.EnsureFreshAsync();
        Assert.Equal(LookupState.Absent, f.Index.Lookup("movie", 603).State);

        var release = new TaskCompletionSource();
        var older = DateTime.UtcNow.AddSeconds(-1).ToString("o");
        f.Reply = async request =>
        {
            if (request.RequestUri!.AbsolutePath == "/api/v1/media")
            {
                await release.Task;
                return IntegrationTransport.Response(Page(new[] { Row("movie", 603, 1, older) }));
            }

            return IntegrationTransport.Response(Page(Array.Empty<string>()));
        };
        await f.Index.EnsureFreshAsync(); // fresh snapshot: starts the advisory refresh
        await WaitUntil(() => f.Called("sort=modified"));

        f.Index.RecordRequestResponse($"{{\"id\":31,\"media\":{{\"tmdbId\":603,\"mediaType\":\"movie\",\"status\":2,\"status4k\":1,\"updatedAt\":\"{DateTime.UtcNow:o}\"}}}}");
        release.SetResult();
        await WaitUntil(() => f.Called("/api/v1/request?")); // media rows are written before the request listing is read

        Assert.Equal(2, f.Index.Lookup("movie", 603).StatusFor(null));
    }

    // F4: an advisory page read before a full rebuild started must not override that rebuild's newer snapshot.
    [Fact]
    public async Task AnAdvisoryPageReadBeforeARebuildDoesNotOverrideIt()
    {
        using var f = new Fixture();
        await f.Index.EnsureFreshAsync();

        var release = new TaskCompletionSource();
        var older = DateTime.UtcNow.AddSeconds(-1).ToString("o");
        f.Reply = async request =>
        {
            var uri = request.RequestUri!;
            if (uri.AbsolutePath == "/api/v1/media" && uri.Query.Contains("sort=modified", StringComparison.Ordinal))
            {
                await release.Task;
                return IntegrationTransport.Response(Page(new[] { Row("movie", 604, 1, older) }));
            }

            return IntegrationTransport.Response(Page(uri.AbsolutePath == "/api/v1/media" ? new[] { Row("movie", 604, 2) } : Array.Empty<string>()));
        };
        await f.Index.EnsureFreshAsync();
        await WaitUntil(() => f.Called("/api/v1/media?take=100&skip=0&sort=modified"));
        await Task.Delay(5);
        await f.Index.ForceRebuildAsync();
        Assert.Equal(2, f.Index.Lookup("movie", 604).StatusFor(null));

        release.SetResult();
        await WaitUntil(() => f.Called("/api/v1/request?take=100&skip=0&sort=modified"));
        Assert.Equal(2, f.Index.Lookup("movie", 604).StatusFor(null));
    }

    // F4: the same for season requests: an older declined request read by the advisory refresh must not clear the
    // season JE just requested.
    [Fact]
    public async Task AnAdvisoryRequestPageReadBeforeJesRequestDoesNotClearIt()
    {
        using var f = new Fixture();
        await f.Index.EnsureFreshAsync();

        var release = new TaskCompletionSource();
        var now = DateTime.UtcNow;
        f.Reply = async request =>
        {
            if (request.RequestUri!.AbsolutePath == "/api/v1/request")
            {
                await release.Task;
                return IntegrationTransport.Response(Page(new[]
                {
                    Request(777, 2, "{\"seasonNumber\":1,\"status\":2}", now.ToString("o")), // processed last: completion marker
                    Request(1399, 3, "{\"seasonNumber\":2,\"status\":3}", now.AddSeconds(-1).ToString("o")),
                }));
            }

            return IntegrationTransport.Response(Page(Array.Empty<string>()));
        };
        await f.Index.EnsureFreshAsync();
        await WaitUntil(() => f.Called("/api/v1/request?take=100&skip=0&sort=modified"));

        f.Index.RecordRequestResponse(Request(1399, 1, "{\"seasonNumber\":2,\"status\":1}", DateTime.UtcNow.ToString("o")));
        Assert.Equal(2, f.Index.Lookup("tv", 1399).StatusFor(2));
        release.SetResult();
        await WaitUntil(() => f.Index.Lookup("tv", 777).StatusFor(1) == 3);

        Assert.Equal(2, f.Index.Lookup("tv", 1399).StatusFor(2));
    }
}
