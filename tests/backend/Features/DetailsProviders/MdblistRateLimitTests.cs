using System.Net;
using Jellyfin.Plugin.JellyfinEnhanced.Features.DetailsProviders.Services;

namespace JE.Tests.Features.DetailsProviders;

/// <summary>
/// MDBList's own answer about the quota (upstream 3d72710d): a 429 pauses every lookup for its Retry-After, and the
/// X-RateLimit-* headers of any answer replace the locally counted quota.
/// </summary>
[Collection("Plugin singleton")]
public class MdblistRateLimitTests
{
    private const string Ratings = "{\"ratings\":[{\"source\":\"imdb\",\"value\":7.1,\"score\":71}]}";

    private static (ApiPluginFixture Plugin, IntegrationTransport Transport, MdblistService Service, List<string> Lookups) Lab(Func<string, HttpResponseMessage> title)
    {
        var plugin = new ApiPluginFixture();
        plugin.Plugin.Configuration.MdblistApiKey = "admin-key";
        var lookups = new List<string>();
        var transport = new IntegrationTransport((request, _) =>
        {
            var path = request.RequestUri!.AbsolutePath;
            if (path == "/user") return Task.FromResult(IntegrationTransport.Response("{\"rate_limit\":1000,\"rate_limit_remaining\":900,\"rate_limit_reset\":4102444800}"));
            lock (lookups) lookups.Add(path);
            return Task.FromResult(title(path));
        });
        return (plugin, transport, new MdblistService(transport, plugin.Core.Paths.Object, plugin.Core.Logger), lookups);
    }

    [Fact]
    public async Task A429PausesLookupsForItsRetryAfter()
    {
        var (plugin, transport, service, lookups) = Lab(path =>
        {
            if (path != "/tmdb/movie/1") return IntegrationTransport.Response(Ratings);
            var limited = IntegrationTransport.Response("{}", 429);
            limited.Headers.RetryAfter = new System.Net.Http.Headers.RetryConditionHeaderValue(TimeSpan.FromMinutes(10));
            return limited;
        });
        using (plugin)
        using (transport)
        using (service)
        {
            var first = await service.GetRatingsAsync("movie", "1", default);
            Assert.False(first.Found);
            Assert.False(first.Confirmed);

            // Within Retry-After no lookup reaches MDBList, for any title; the miss is retried later, not trusted.
            var second = await service.GetRatingsAsync("movie", "2", default);
            Assert.False(second.Found);
            Assert.False(second.Confirmed);
            Assert.Equal(new[] { "/tmdb/movie/1" }, lookups);
        }
    }

    [Fact]
    public async Task RateLimitHeadersReplaceTheCountedQuota()
    {
        var (plugin, transport, service, lookups) = Lab(_ =>
        {
            var ok = IntegrationTransport.Response(Ratings);
            ok.Headers.Add("X-RateLimit-Limit", "1000");
            ok.Headers.Add("X-RateLimit-Remaining", "3");
            ok.Headers.Add("X-RateLimit-Reset", "4102444800");
            return ok;
        });
        using (plugin)
        using (transport)
        using (service)
        {
            Assert.True((await service.GetRatingsAsync("movie", "1", default)).Found);
            // /user said 900 left; MDBList's answer says 3, which is under the safety margin: the next title waits.
            Assert.Equal(3, service.RemainingQuota());
            Assert.False((await service.GetRatingsAsync("movie", "2", default)).Found);
            Assert.Equal(new[] { "/tmdb/movie/1" }, lookups);
        }
    }
}
