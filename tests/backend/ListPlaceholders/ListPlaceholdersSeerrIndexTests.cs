using System.Text;
using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders;
using static Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders.SeerrMediaIndex;

namespace JE.Tests;

// The shared Seerr /api/v1/media status index: paging, atomic swap, tri-state lookups, write-through and config changes.
[Collection("Plugin singleton")]
public class ListPlaceholdersSeerrIndexTests
{
    private sealed class Fixture : IDisposable
    {
        public ApiPluginFixture Plugin { get; } = new();
        public List<string> Calls { get; } = new();
        public Func<HttpRequestMessage, Task<HttpResponseMessage>> Reply { get; set; } = _ => Task.FromResult(IntegrationTransport.Response("{\"results\":[]}"));
        public IntegrationTransport Transport { get; }
        public SeerrMediaIndex Index { get; }

        public Fixture(string urls = "http://seerr-a.test")
        {
            Plugin.Plugin.Configuration.JellyseerrEnabled = true;
            Plugin.Plugin.Configuration.JellyseerrUrls = urls;
            Plugin.Plugin.Configuration.JellyseerrApiKey = "index-key";
            Transport = new IntegrationTransport(async (request, _) =>
            {
                Assert.Equal("index-key", Assert.Single(request.Headers.GetValues("X-Api-Key")));
                Assert.False(request.Headers.Contains("X-Api-User"));
                lock (Calls)
                {
                    Calls.Add(request.RequestUri!.Host + request.RequestUri.PathAndQuery);
                }

                return await Reply(request);
            });
            Index = new SeerrMediaIndex(Transport, Plugin.Core.Logger);
        }

        public void Dispose()
        {
            Transport.Dispose();
            Plugin.Dispose();
        }
    }

    private static List<string> MediaCalls(Fixture f) => f.Calls.Where(c => c.Contains("/api/v1/media", StringComparison.Ordinal)).ToList();

    // A Seerr MediaRequest as /api/v1/request and POST /api/v1/request return it: seasons on the REQUEST, media.seasons
    // (availability rows) empty until a scan.
    private static string Request(int tmdb, int status, string seasons, bool is4k = false, string updatedAt = "2026-10-10T05:00:05.000Z") =>
        $"{{\"id\":{tmdb},\"status\":{status},\"type\":\"tv\",\"is4k\":{(is4k ? "true" : "false")},\"updatedAt\":\"{updatedAt}\",\"media\":{{\"mediaType\":\"tv\",\"tmdbId\":{tmdb},\"status\":2,\"status4k\":1,\"seasons\":[]}},\"seasons\":[{seasons}]}}";

    private static string Page(IEnumerable<string> rows) => "{\"pageInfo\":{},\"results\":[" + string.Join(',', rows) + "]}";

    private static string Row(string type, int id, int status, string seasons = "") =>
        $"{{\"mediaType\":\"{type}\",\"tmdbId\":{id},\"status\":{status},\"status4k\":1,\"updatedAt\":\"2026-10-10T05:00:05.000Z\"{(seasons.Length > 0 ? ",\"seasons\":[" + seasons + "]" : string.Empty)}}}";

    [Fact]
    public async Task AFullRebuildPagesUntilAShortPageAndThenAnswersTriState()
    {
        using var f = new Fixture();
        f.Reply = request =>
        {
            var skip = int.Parse(System.Web.HttpUtility.ParseQueryString(request.RequestUri!.Query)["skip"]!);
            var count = skip < 1000 ? PageSize : 3;
            var rows = Enumerable.Range(skip + 1, count).Select(i => Row(i % 2 == 0 ? "tv" : "movie", i, 5));
            return Task.FromResult(IntegrationTransport.Response(Page(rows)));
        };

        Assert.Equal(LookupState.Unknown, f.Index.Lookup("movie", 1).State);
        Assert.False(f.Index.IsReady);
        await f.Index.EnsureFreshAsync();

        Assert.Equal(
            new[] { "seerr-a.test/api/v1/media?take=500&skip=0", "seerr-a.test/api/v1/media?take=500&skip=500", "seerr-a.test/api/v1/media?take=500&skip=1000" },
            MediaCalls(f));
        Assert.True(f.Index.IsReady);
        Assert.Equal(1003, f.Index.Count);
        Assert.Equal(LookupState.Indexed, f.Index.Lookup("movie", 1003).State);
        Assert.Equal(LookupState.Absent, f.Index.Lookup("movie", 2).State); // 2 is a tv row
        Assert.Equal(1, f.Index.Lookup("movie", 2).StatusFor(null));
        Assert.Equal(LookupState.Absent, f.Index.Lookup("movie", 5000).State);

        // Fresh snapshot: no second rebuild within the interval (only an advisory refresh may run).
        f.Calls.Clear();
        await f.Index.EnsureFreshAsync();
        Assert.DoesNotContain(f.Calls, c => c.Contains("skip=500", StringComparison.Ordinal));
    }

    [Fact]
    public async Task SeasonStatusesAndUnparseableRowsAreHandled()
    {
        using var f = new Fixture();
        f.Reply = _ => Task.FromResult(IntegrationTransport.Response(Page(new[]
        {
            Row("tv", 7, 4, "{\"seasonNumber\":1,\"status\":5,\"status4k\":1},{\"seasonNumber\":2,\"status\":2}"),
            "{\"mediaType\":\"person\",\"tmdbId\":1}",
            "{\"mediaType\":\"movie\",\"tmdbId\":\"x\"}",
            "42",
        })));
        await f.Index.EnsureFreshAsync();

        var tv = f.Index.Lookup("tv", 7);
        Assert.Equal((4, 5, 2, 1), (tv.StatusFor(null)!.Value, tv.StatusFor(1)!.Value, tv.StatusFor(2)!.Value, tv.StatusFor(3)!.Value));
        Assert.Equal(1, f.Index.Count);
        Assert.Null(new LookupResult(LookupState.Unknown, null).StatusFor(1));
    }

    [Fact]
    public async Task TheOldSnapshotKeepsServingUntilANewOneIsComplete()
    {
        using var f = new Fixture();
        f.Reply = _ => Task.FromResult(IntegrationTransport.Response(Page(new[] { Row("movie", 1, 3) })));
        await f.Index.EnsureFreshAsync();
        Assert.Equal(3, f.Index.Lookup("movie", 1).StatusFor(null));

        // While the next rebuild is still paging, and after it fails half-way, the previous snapshot keeps serving.
        var page = 0;
        var secondPage = new TaskCompletionSource();
        f.Reply = async _ =>
        {
            if (page++ == 0)
            {
                return IntegrationTransport.Response(Page(Enumerable.Range(1, PageSize).Select(i => Row("movie", i, 5))));
            }

            await secondPage.Task;
            return IntegrationTransport.Response("<html>login</html>", 200, "text/html");
        };
        var rebuild = f.Index.ForceRebuildAsync();
        while (page < 2)
        {
            await Task.Delay(10);
        }

        Assert.Equal(3, f.Index.Lookup("movie", 1).StatusFor(null));
        secondPage.SetResult();
        await rebuild;
        Assert.True(f.Index.IsReady);
        Assert.Equal(3, f.Index.Lookup("movie", 1).StatusFor(null));
        Assert.Equal(LookupState.Absent, f.Index.Lookup("movie", 2).State);

        f.Index.Invalidate();
        Assert.Equal(LookupState.Unknown, f.Index.Lookup("movie", 1).State);
    }

    [Fact]
    public async Task ARebuildFailsOverToTheNextConfiguredUrl()
    {
        using var f = new Fixture("http://down.test\nhttp://up.test");
        f.Reply = request => request.RequestUri!.Host == "down.test"
            ? throw new HttpRequestException("refused")
            : Task.FromResult(IntegrationTransport.Response(Page(new[] { Row("movie", 9, 2) })));
        await f.Index.EnsureFreshAsync();
        Assert.Equal(2, f.Index.Lookup("movie", 9).StatusFor(null));
        Assert.Equal(new[] { "down.test/api/v1/media?take=500&skip=0", "up.test/api/v1/media?take=500&skip=0" }, MediaCalls(f));
    }

    [Fact]
    public async Task RecordsFromJeRequestsWinUntilTheNextRebuild()
    {
        using var f = new Fixture();
        await f.Index.EnsureFreshAsync();
        Assert.Equal(LookupState.Absent, f.Index.Lookup("movie", 49521).State);

        f.Index.RecordRequestResponse("{\"id\":31,\"media\":{\"id\":486,\"tmdbId\":49521,\"mediaType\":\"movie\",\"status\":2,\"status4k\":1}}");
        f.Index.RecordRequestResponse("{\"media\":{\"tmdbId\":110492,\"mediaType\":\"tv\",\"status\":2,\"seasons\":[{\"seasonNumber\":1,\"status\":2}]}}");
        f.Index.RecordRequestResponse("not json");
        f.Index.RecordRequestResponse("{\"message\":\"No seasons available to request\"}");
        f.Index.Record("person", 1, new MediaStatusEntry(5, 1, new Dictionary<int, SeasonStatus>(), null));

        Assert.Equal(2, f.Index.Lookup("movie", 49521).StatusFor(null));
        Assert.Equal(2, f.Index.Lookup("tv", 110492).StatusFor(1));
        Assert.Equal(1, f.Index.Lookup("tv", 110492).StatusFor(2));
    }

    [Fact]
    public async Task NothingRunsWhileSeerrIsOffAndAConfigChangeDropsTheSnapshot()
    {
        using var f = new Fixture();
        f.Plugin.Plugin.Configuration.JellyseerrEnabled = false;
        await f.Index.EnsureFreshAsync();
        Assert.Empty(f.Calls);
        Assert.Equal(LookupState.Unknown, f.Index.Lookup("movie", 1).State);

        f.Plugin.Plugin.Configuration.JellyseerrEnabled = true;
        f.Reply = _ => Task.FromResult(IntegrationTransport.Response(Page(new[] { Row("movie", 1, 5) })));
        await f.Index.EnsureFreshAsync();
        Assert.True(f.Index.IsReady);

        f.Plugin.Plugin.Configuration.JellyseerrApiKey = "rotated";
        Assert.False(f.Index.IsReady);
        Assert.Equal(LookupState.Unknown, f.Index.Lookup("movie", 1).State);
    }

    [Fact]
    public async Task ConcurrentCallersShareOneRebuild()
    {
        using var f = new Fixture();
        var gate = new TaskCompletionSource();
        f.Reply = async _ =>
        {
            await gate.Task;
            return IntegrationTransport.Response(Page(Array.Empty<string>()));
        };
        var first = f.Index.EnsureFreshAsync();
        var second = f.Index.EnsureFreshAsync();
        Assert.Same(first, second);
        gate.SetResult();
        await Task.WhenAll(first, second);
        Assert.Single(MediaCalls(f));
        Assert.True(f.Index.IsReady);
    }

    [Fact]
    public void RowsWithoutUsableIdsAreIgnored()
    {
        using var document = System.Text.Json.JsonDocument.Parse(Encoding.UTF8.GetBytes("{\"mediaType\":\"movie\",\"tmdbId\":0}"));
        Assert.False(TryParseRow(document.RootElement, out _, out _, out _));
    }

    [Fact]
    public async Task SeasonRequestsComeFromSeerrsRequestsNotTheMediaRowsSeasons()
    {
        using var f = new Fixture();
        f.Reply = request =>
        {
            var uri = request.RequestUri!;
            var query = System.Web.HttpUtility.ParseQueryString(uri.Query);
            if (uri.AbsolutePath == "/api/v1/media")
            {
                // GoT: S1 available (scanner row); S2 has no availability row at all.
                return Task.FromResult(IntegrationTransport.Response(Page(new[] { Row("tv", 1399, 4, "{\"seasonNumber\":1,\"status\":5,\"status4k\":1}"), Row("tv", 82856, 2) })));
            }

            Assert.Equal("/api/v1/request", uri.AbsolutePath);
            Assert.Equal("tv", query["mediaType"]);
            return Task.FromResult(IntegrationTransport.Response(Page(query["filter"] switch
            {
                "pending" when query["skip"] == "0" => new[] { Request(1399, 1, "{\"seasonNumber\":2,\"status\":1}"), Request(82856, 1, "{\"seasonNumber\":1,\"status\":1}", is4k: true) },
                "approved" when query["skip"] == "0" => new[] { Request(82856, 2, "{\"seasonNumber\":2,\"status\":2}") },
                _ => Array.Empty<string>(),
            })));
        };
        await f.Index.EnsureFreshAsync();

        Assert.Contains("seerr-a.test/api/v1/request?take=100&skip=0&filter=pending&mediaType=tv", f.Calls);
        Assert.Contains("seerr-a.test/api/v1/request?take=100&skip=0&filter=approved&mediaType=tv", f.Calls);
        var got = f.Index.Lookup("tv", 1399);
        Assert.Equal((4, 5, 2, 1), (got.StatusFor(null)!.Value, got.StatusFor(1)!.Value, got.StatusFor(2)!.Value, got.StatusFor(3)!.Value));
        var mando = f.Index.Lookup("tv", 82856);
        Assert.Equal(1, mando.StatusFor(1)); // only a 4K request for S1
        Assert.Equal(2, mando.Entry!.Seasons[1].Status4k);
        Assert.Equal(3, mando.StatusFor(2)); // approved
    }

    [Fact]
    public async Task JesOwnSeasonRequestShowsAsPendingAndADeclineClearsIt()
    {
        using var f = new Fixture();
        await f.Index.EnsureFreshAsync();
        Assert.Equal(1, f.Index.Lookup("tv", 1399).StatusFor(2));

        // Seerr's real 201 body for POST /api/v1/request {mediaType:"tv", mediaId:1399, seasons:[2]}.
        f.Index.RecordRequestResponse(Request(1399, 1, "{\"id\":77,\"seasonNumber\":2,\"status\":1}"));
        Assert.Equal((2, 2, 1), (f.Index.Lookup("tv", 1399).StatusFor(null)!.Value, f.Index.Lookup("tv", 1399).StatusFor(2)!.Value, f.Index.Lookup("tv", 1399).StatusFor(1)!.Value));
        f.Index.RecordRequestResponse(Request(1399, 1, "{\"seasonNumber\":3,\"status\":1}"));
        Assert.Equal((2, 2), (f.Index.Lookup("tv", 1399).StatusFor(2)!.Value, f.Index.Lookup("tv", 1399).StatusFor(3)!.Value));

        // The advisory refresh sees the S2 request declined (newer) and the S3 one approved.
        f.Reply = request => Task.FromResult(IntegrationTransport.Response(Page(request.RequestUri!.AbsolutePath == "/api/v1/request"
            ? new[]
            {
                Request(1399, 3, "{\"seasonNumber\":2,\"status\":3}", updatedAt: DateTime.UtcNow.AddSeconds(5).ToString("o")),
                Request(1399, 2, "{\"seasonNumber\":3,\"status\":2}", updatedAt: DateTime.UtcNow.ToString("o")),
                Request(1399, 1, "{\"seasonNumber\":2,\"status\":1}", updatedAt: DateTime.UtcNow.AddSeconds(-5).ToString("o")),
            }
            : Array.Empty<string>())));
        f.Calls.Clear();
        await f.Index.EnsureFreshAsync(); // fresh snapshot: starts the advisory refresh only
        for (var i = 0; i < 200 && f.Index.Lookup("tv", 1399).StatusFor(3) != 3; i++)
        {
            await Task.Delay(10);
        }

        Assert.Contains(f.Calls, c => c.Contains("/api/v1/request?take=100&skip=0&sort=modified&mediaType=tv", StringComparison.Ordinal));
        Assert.Equal((1, 3), (f.Index.Lookup("tv", 1399).StatusFor(2)!.Value, f.Index.Lookup("tv", 1399).StatusFor(3)!.Value));
    }

    [Fact]
    public async Task AFailedRebuildBacksOffInsteadOfRetryingOnEveryView()
    {
        using var f = new Fixture();
        f.Reply = _ => throw new HttpRequestException("connect timeout");
        Assert.False(f.Index.LastRebuildFailed);
        await f.Index.EnsureFreshAsync();
        Assert.Single(f.Calls);
        Assert.False(f.Index.IsReady);
        Assert.True(f.Index.LastRebuildFailed);

        // Within the backoff window: no new rebuild and nothing to wait on.
        var next = f.Index.EnsureFreshAsync();
        Assert.True(next.IsCompleted);
        await f.Index.EnsureFreshAsync();
        Assert.Single(f.Calls);

        // A configuration change (or an explicit rebuild) is not held back.
        f.Reply = _ => Task.FromResult(IntegrationTransport.Response(Page(new[] { Row("movie", 1, 5) })));
        f.Plugin.Plugin.Configuration.JellyseerrUrls = "http://seerr-b.test";
        Assert.False(f.Index.LastRebuildFailed);
        await f.Index.EnsureFreshAsync();
        Assert.True(f.Index.IsReady);
        Assert.Equal(5, f.Index.Lookup("movie", 1).StatusFor(null));
    }
}
