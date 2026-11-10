using System.Net;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Seerr;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Seerr.Services;

namespace JE.Tests.Features.Seerr;

public class SeerrCsrfHandlerTests
{
    private sealed class Fake : HttpMessageHandler
    {
        public List<HttpRequestMessage> Seen { get; } = new();
        public List<string?> Bodies { get; } = new();
        public Func<HttpRequestMessage, HttpResponseMessage> Respond { get; set; } = _ => new HttpResponseMessage(HttpStatusCode.OK);

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Seen.Add(request);
            Bodies.Add(request.Content == null ? null : await request.Content.ReadAsStringAsync(ct));
            return Respond(request);
        }
    }

    private static HttpResponseMessage Status(bool csrf)
    {
        var r = new HttpResponseMessage(HttpStatusCode.OK);
        if (csrf)
        {
            r.Headers.Add("Set-Cookie", "_csrf=secret123; Path=/; HttpOnly; Secure; SameSite=Strict");
            r.Headers.Add("Set-Cookie", "XSRF-TOKEN=tok%2Ben%3D; Path=/; Secure; SameSite=Strict");
        }
        return r;
    }

    private static (HttpClient Client, Fake Fake) Make(Func<HttpRequestMessage, HttpResponseMessage> respond)
    {
        var fake = new Fake { Respond = respond };
        return (new HttpClient(new SeerrCsrfHandler { InnerHandler = fake }), fake);
    }

    private static HttpRequestMessage Post(string baseUrl) =>
        SeerrHttpHelper.BuildRequest(HttpMethod.Post, baseUrl + "/api/v1/request", "key", "7", "{\"a\":1}");

    [Fact]
    public async Task PostGetsCookieAndDecodedTokenWhenSeerrUsesCsrf()
    {
        var url = "http://csrf-on-" + Guid.NewGuid().ToString("N");
        var (client, fake) = Make(r => r.RequestUri!.AbsolutePath.EndsWith("/status") ? Status(true) : new HttpResponseMessage(HttpStatusCode.OK));
        var res = await client.SendAsync(Post(url));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal(2, fake.Seen.Count);
        var post = fake.Seen[1];
        Assert.Equal("_csrf=secret123", post.Headers.GetValues("Cookie").Single());
        Assert.Equal("tok+en=", post.Headers.GetValues("X-XSRF-TOKEN").Single());
        Assert.Equal("{\"a\":1}", fake.Bodies[1]);
        // The pair is cached: a second write does not probe again.
        await client.SendAsync(Post(url));
        Assert.Equal(3, fake.Seen.Count);
    }

    [Fact]
    public async Task PostIsUntouchedWhenSeerrSetsNoCsrfCookies()
    {
        var url = "http://csrf-off-" + Guid.NewGuid().ToString("N");
        var (client, fake) = Make(r => r.RequestUri!.AbsolutePath.EndsWith("/status") ? Status(false) : new HttpResponseMessage(HttpStatusCode.OK));
        await client.SendAsync(Post(url));
        Assert.False(fake.Seen[1].Headers.Contains("Cookie"));
        Assert.False(fake.Seen[1].Headers.Contains("X-XSRF-TOKEN"));
        await client.SendAsync(Post(url));
        Assert.Equal(3, fake.Seen.Count); // "off" is cached too, so no second probe
    }

    [Fact]
    public async Task GetPassesThroughWithoutProbe()
    {
        var (client, fake) = Make(_ => new HttpResponseMessage(HttpStatusCode.OK));
        await client.SendAsync(SeerrHttpHelper.BuildRequest(HttpMethod.Get, "http://x-" + Guid.NewGuid().ToString("N") + "/api/v1/search", "key"));
        Assert.Single(fake.Seen);
    }

    [Fact]
    public async Task CsrfRejectionRefreshesThePairAndRetriesOnce()
    {
        var url = "http://csrf-retry-" + Guid.NewGuid().ToString("N");
        var posts = 0;
        var (client, fake) = Make(r =>
        {
            if (r.RequestUri!.AbsolutePath.EndsWith("/status")) return Status(true);
            return ++posts == 1
                ? new HttpResponseMessage(HttpStatusCode.Forbidden) { Content = new StringContent("{\"message\":\"invalid csrf token\"}") }
                : new HttpResponseMessage(HttpStatusCode.OK);
        });
        var res = await client.SendAsync(Post(url));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        Assert.Equal(4, fake.Seen.Count); // status, post, status, post
        Assert.Equal("{\"a\":1}", fake.Bodies[3]);
    }

    [Fact]
    public async Task NonCsrfForbiddenIsReturnedWithoutRetry()
    {
        var url = "http://csrf-403-" + Guid.NewGuid().ToString("N");
        var (client, fake) = Make(r => r.RequestUri!.AbsolutePath.EndsWith("/status")
            ? Status(false)
            : new HttpResponseMessage(HttpStatusCode.Forbidden) { Content = new StringContent("{\"message\":\"no permission\"}") });
        var res = await client.SendAsync(Post(url));
        Assert.Equal(HttpStatusCode.Forbidden, res.StatusCode);
        Assert.Equal("{\"message\":\"no permission\"}", await res.Content.ReadAsStringAsync());
        Assert.Equal(2, fake.Seen.Count);
    }
}
