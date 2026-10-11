using Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders;

namespace JE.Tests;

// Review round 3: a request that leaves the filter from a page already read while an older one enters it keeps the
// count the same, yet offset paging skips a request that stayed in the filter. Page boundaries catch it.
[Collection("Plugin singleton")]
public class ListPlaceholdersSeerrIndexReviewR3Tests
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
            Plugin.Plugin.Configuration.JellyseerrUrls = "http://seerr-r3.test";
            Plugin.Plugin.Configuration.JellyseerrApiKey = "index-key-r3";
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

    [Fact]
    public async Task ARowSwapThatKeepsTheCountIsDetectedAtThePageBoundary()
    {
        using var f = new Fixture();
        var pending = Enumerable.Range(101, 101).Reverse().ToList(); // ids 201..101 (id DESC)
        var swapped = false;
        f.Reply = request =>
        {
            var query = System.Web.HttpUtility.ParseQueryString(request.RequestUri!.Query);
            if (request.RequestUri.AbsolutePath == "/api/v1/media")
            {
                return Json(Page(new[] { MediaRow(101), MediaRow(1) }, 2));
            }

            if (query["filter"] != "pending")
            {
                return Json(Page(Array.Empty<string>(), 0));
            }

            var skip = int.Parse(query["skip"]!, System.Globalization.CultureInfo.InvariantCulture);
            var take = int.Parse(query["take"]!, System.Globalization.CultureInfo.InvariantCulture);
            string body;
            lock (pending)
            {
                body = Page(pending.Skip(skip).Take(take).Select(Request), pending.Count);
                if (skip == 0 && !swapped)
                {
                    // Between the two page reads: request 201 is approved, and old request 1 becomes pending again.
                    swapped = true;
                    pending.Remove(201);
                    pending.Add(1);
                }
            }

            return Json(body);
        };

        await f.Index.EnsureFreshAsync();

        Assert.True(f.Index.IsReady);
        Assert.Equal(2, f.Index.Lookup("tv", 101).StatusFor(1)); // never left the filter: read on the second pass
        Assert.Equal(2, f.Index.Lookup("tv", 1).StatusFor(1));
        Assert.Equal(4, f.RequestCalls("pending"));
    }

    [Fact]
    public async Task PagesAfterTheFirstStartOneRowEarlyAndThatRowIsNotCountedTwice()
    {
        using var f = new Fixture();
        var pending = Enumerable.Range(1, 250).Reverse().ToList();
        f.Reply = request =>
        {
            var query = System.Web.HttpUtility.ParseQueryString(request.RequestUri!.Query);
            if (request.RequestUri.AbsolutePath == "/api/v1/media")
            {
                return Json(Page(new[] { MediaRow(1), MediaRow(250) }, 2));
            }

            var skip = int.Parse(query["skip"]!, System.Globalization.CultureInfo.InvariantCulture);
            var take = int.Parse(query["take"]!, System.Globalization.CultureInfo.InvariantCulture);
            return Json(query["filter"] == "pending" ? Page(pending.Skip(skip).Take(take).Select(Request), pending.Count) : Page(Array.Empty<string>(), 0));
        };

        await f.Index.EnsureFreshAsync();

        Assert.Equal(2, f.Index.Lookup("tv", 1).StatusFor(1));
        Assert.Equal(2, f.Index.Lookup("tv", 250).StatusFor(1));
        lock (f.Calls)
        {
            var pages = f.Calls.Where(c => c.Contains("filter=pending", StringComparison.Ordinal)).ToList();
            Assert.Equal(3, pages.Count); // a consistent listing is read once
            Assert.Contains("take=101&skip=99&", pages[1], StringComparison.Ordinal);
            Assert.Contains("take=101&skip=199&", pages[2], StringComparison.Ordinal);
        }
    }
}
