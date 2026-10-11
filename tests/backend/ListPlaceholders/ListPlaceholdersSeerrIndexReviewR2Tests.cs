using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders;
using static Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders.SeerrMediaIndex;

namespace JE.Tests;

// Review round 2: offset paging over Seerr's filtered request listing that lost a row to a request leaving the filter
// mid-scan is read again, and never published as a complete listing.
[Collection("Plugin singleton")]
public class ListPlaceholdersSeerrIndexReviewR2Tests
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
            Plugin.Plugin.Configuration.JellyseerrUrls = "http://seerr-r2.test";
            Plugin.Plugin.Configuration.JellyseerrApiKey = "index-key-r2";
            Transport = new IntegrationTransport(async (request, _) =>
            {
                lock (Calls)
                {
                    Calls.Add(request.RequestUri!.PathAndQuery);
                }

                return await Reply(request);
            });
            Index = new SeerrMediaIndex(Transport, Plugin.Core.Logger);
        }

        public int RequestCalls(string filter)
        {
            lock (Calls)
            {
                return Calls.Count(c => c.StartsWith("/api/v1/request?", StringComparison.Ordinal) && c.Contains("filter=" + filter, StringComparison.Ordinal));
            }
        }

        public void Dispose()
        {
            Transport.Dispose();
            Plugin.Dispose();
        }
    }

    private static string Request(int tmdb) =>
        $"{{\"id\":{tmdb},\"status\":1,\"type\":\"tv\",\"is4k\":false,\"updatedAt\":\"2026-10-10T05:00:05.000Z\",\"media\":{{\"mediaType\":\"tv\",\"tmdbId\":{tmdb},\"status\":2,\"status4k\":1,\"seasons\":[]}},\"seasons\":[{{\"seasonNumber\":1,\"status\":1}}]}}";

    private static string Page(IEnumerable<string> rows, int total) =>
        "{\"pageInfo\":{\"results\":" + total + "},\"results\":[" + string.Join(',', rows) + "]}";

    private static string MediaRow(int id) => $"{{\"mediaType\":\"tv\",\"tmdbId\":{id},\"status\":2,\"status4k\":1,\"seasons\":[]}}";

    private static Task<HttpResponseMessage> Json(string body) => Task.FromResult(IntegrationTransport.Response(body));

    // 101 pending requests (id DESC). Request 50 is approved after the first page was read, so the pending listing
    // shrinks to 100 and skip=100 comes back empty: request 1 was never read. The scan must notice and read again.
    private static Func<HttpRequestMessage, Task<HttpResponseMessage>> Shrinking(List<int> pending, Func<bool> approveAfterEveryFirstPage)
    {
        return request =>
        {
            var query = System.Web.HttpUtility.ParseQueryString(request.RequestUri!.Query);
            if (request.RequestUri.AbsolutePath == "/api/v1/media")
            {
                return Json(Page(new[] { MediaRow(1), MediaRow(50), MediaRow(120) }, 3));
            }

            if (query["filter"] != "pending")
            {
                return Json(Page(Array.Empty<string>(), 0));
            }

            var skip = int.Parse(query["skip"]!);
            var take = int.Parse(query["take"]!);
            string body;
            lock (pending)
            {
                body = Page(pending.Skip(skip).Take(take).Select(Request), pending.Count);
                if (skip == 0 && approveAfterEveryFirstPage())
                {
                    pending.Remove(pending[pending.Count / 2]);
                }
            }

            return Json(body);
        };
    }

    [Fact]
    public async Task ARequestLeavingTheFilterMidScanIsDetectedAndTheScanRepeated()
    {
        using var f = new Fixture();
        var pending = Enumerable.Range(1, 101).Reverse().ToList();
        var firstPages = 0;
        f.Reply = Shrinking(pending, () => ++firstPages == 1);
        await f.Index.EnsureFreshAsync();

        Assert.True(f.Index.IsReady);
        Assert.Equal(2, f.Index.Lookup("tv", 1).StatusFor(1)); // the oldest pending request was read on the second pass
        Assert.Equal(4, f.RequestCalls("pending")); // skip=0, skip=100, then once more from the start
    }

    [Fact]
    public async Task ARequestListingThatKeepsChangingIsNotPublishedAsComplete()
    {
        using var f = new Fixture();
        var pending = Enumerable.Range(1, 120).Reverse().ToList();
        f.Reply = Shrinking(pending, () => true);
        await f.Index.EnsureFreshAsync();

        Assert.True(f.Index.IsReady);
        Assert.Equal(2, f.Index.Lookup("tv", 120).StatusFor(1)); // read
        Assert.Null(f.Index.Lookup("tv", 1).StatusFor(1)); // never read: unknown, not "not requested"
    }
}
