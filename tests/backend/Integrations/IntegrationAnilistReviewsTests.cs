using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Services;

namespace JE.Tests;

public class IntegrationAnilistReviewsTests
{
    private sealed class Clock : TimeProvider
    {
        internal DateTimeOffset Now = DateTimeOffset.Parse("2026-11-09T12:00:00Z");
        public override DateTimeOffset GetUtcNow() => Now;
    }

    private static HttpResponseMessage Refused(int status, Action<HttpResponseHeaders>? headers = null)
    {
        var response = IntegrationTransport.Response("{\"errors\":[{\"message\":\"Too Many Requests.\",\"status\":429}]}", status);
        headers?.Invoke(response.Headers);
        return response;
    }
    private static string Media(string body = "Great. ~!Hidden twist!~ Done. img(https://x/y.png)") => JsonSerializer.Serialize(new
    {
        data = new
        {
            Media = new
            {
                siteUrl = "https://anilist.co/anime/1",
                                reviews = new { nodes = new[] { new { summary = "Sum", score = 85, rating = 3, ratingAmount = 4, createdAt = 1540043261, siteUrl = "https://anilist.co/review/1", user = new { name = "Ann" }, body } } },
            },
        },
    });

    [Fact]
    public async Task IdLookupReturnsCleanedReviewsAndIsCached()
    {
        using var env = new IntegrationEnvironment();
        using var transport = new IntegrationTransport((request, _) =>
        {
            Assert.Contains("Media(id:$v", request.Content!.ReadAsStringAsync().Result);
            return Task.FromResult(IntegrationTransport.Response(Media()));
        });
        var service = new AnilistReviewsService(transport, env.Logger);
        var result = await service.GetReviewsAsync(269, default);
        var review = Assert.Single(result.Reviews);
        Assert.Equal("Ann", review.Author);
        Assert.Equal(85, review.Score);
        Assert.Equal("Great. [spoiler hidden] Done.", review.Content);
        Assert.Same(result, await service.GetReviewsAsync(269, default));
        Assert.Equal(1, transport.Calls);
    }

    [Fact]
    public async Task NotFoundIsAnEmptyResultAndServerErrorsThrow()
    {
        using var env = new IntegrationEnvironment();
        using var missing = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response("{}", 404)));
        Assert.Empty((await new AnilistReviewsService(missing, env.Logger).GetReviewsAsync(1, default)).Reviews);
        using var down = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response("{}", 503)));
        await Assert.ThrowsAsync<HttpRequestException>(() => new AnilistReviewsService(down, env.Logger).GetReviewsAsync(1, default));
    }

    [Fact]
    public async Task TooManyRequestsHonoursRetryAfterForThatIdAndPausesOtherIds()
    {
        using var env = new IntegrationEnvironment();
        var clock = new Clock();
        var limited = true;
        using var transport = new IntegrationTransport((_, _) => Task.FromResult(limited
            ? Refused(429, h => h.RetryAfter = new RetryConditionHeaderValue(TimeSpan.FromSeconds(120)))
            : IntegrationTransport.Response(Media())));
        var service = new AnilistReviewsService(transport, env.Logger, clock);

        var first = await Assert.ThrowsAsync<HttpRequestException>(() => service.GetReviewsAsync(1, default));
        Assert.Equal(HttpStatusCode.TooManyRequests, first.StatusCode);
        Assert.Equal(1, transport.Calls);

        clock.Now = clock.Now.AddSeconds(119);
        limited = false;
        var again = await Assert.ThrowsAsync<HttpRequestException>(() => service.GetReviewsAsync(1, default));
        Assert.Equal(HttpStatusCode.TooManyRequests, again.StatusCode);
        await Assert.ThrowsAsync<HttpRequestException>(() => service.GetReviewsAsync(2, default));
        Assert.Equal(1, transport.Calls);

        clock.Now = clock.Now.AddSeconds(2);
        Assert.Single((await service.GetReviewsAsync(1, default)).Reviews);
        Assert.Single((await service.GetReviewsAsync(2, default)).Reviews);
        Assert.Equal(3, transport.Calls);
        Assert.Single(File.ReadAllLines(env.Logger.CurrentLogFilePath), l => l.Contains("[WARN] [AniList] 429", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData(null, 60)]        // no header: default window
    [InlineData("date:90", 90)]   // HTTP-date form
    [InlineData("3600", 600)]     // capped at ten minutes
    [InlineData("0", 60)]         // a non-positive wait falls back to the default
    public async Task RetryAfterFormsDefaultAndCap(string? retryAfter, int windowSeconds)
    {
        using var env = new IntegrationEnvironment();
        var clock = new Clock();
        using var transport = new IntegrationTransport((_, _) => Task.FromResult(Refused(429, h =>
        {
            if (retryAfter == null) return;
            h.RetryAfter = retryAfter.StartsWith("date:", StringComparison.Ordinal)
                ? new RetryConditionHeaderValue(clock.Now.AddSeconds(int.Parse(retryAfter[5..])))
                : new RetryConditionHeaderValue(TimeSpan.FromSeconds(int.Parse(retryAfter)));
        })));
        var service = new AnilistReviewsService(transport, env.Logger, clock);
        var start = clock.Now;

        await Assert.ThrowsAsync<HttpRequestException>(() => service.GetReviewsAsync(5, default));
        clock.Now = start.AddSeconds(windowSeconds - 1);
        await Assert.ThrowsAsync<HttpRequestException>(() => service.GetReviewsAsync(5, default));
        Assert.Equal(1, transport.Calls);
        clock.Now = start.AddSeconds(windowSeconds + 1);
        await Assert.ThrowsAsync<HttpRequestException>(() => service.GetReviewsAsync(5, default));
        Assert.Equal(2, transport.Calls);
    }

    [Fact]
    public async Task ForbiddenIsRememberedForThatIdLikeTooManyRequests()
    {
        using var env = new IntegrationEnvironment();
        var clock = new Clock();
        var forbidden = true;
        using var transport = new IntegrationTransport((request, _) => Task.FromResult(
            forbidden && request.Content!.ReadAsStringAsync().Result.Contains("\"v\":7", StringComparison.Ordinal)
                ? Refused(403)
                : IntegrationTransport.Response(Media())));
        var service = new AnilistReviewsService(transport, env.Logger, clock);

        var refused = await Assert.ThrowsAsync<HttpRequestException>(() => service.GetReviewsAsync(7, default));
        Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
        clock.Now = clock.Now.AddSeconds(30);
        await Assert.ThrowsAsync<HttpRequestException>(() => service.GetReviewsAsync(7, default));
        Assert.Equal(1, transport.Calls);

        // The service-wide pause follows 429s only; another id still reaches AniList.
        Assert.Single((await service.GetReviewsAsync(8, default)).Reviews);
        Assert.Equal(2, transport.Calls);

        forbidden = false;
        clock.Now = clock.Now.AddSeconds(31);
        Assert.Single((await service.GetReviewsAsync(7, default)).Reviews);
        Assert.Equal(3, transport.Calls);
    }

    [Fact]
    public async Task ConcurrentRequestsForTheSameIdShareOneUpstreamCall()
    {
        using var env = new IntegrationEnvironment();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var transport = new IntegrationTransport(async (_, token) =>
        {
            entered.TrySetResult();
            await release.Task.WaitAsync(token);
            return IntegrationTransport.Response(Media());
        });
        var service = new AnilistReviewsService(transport, env.Logger);
        using var leaving = new CancellationTokenSource();

        var first = service.GetReviewsAsync(9, default);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var second = service.GetReviewsAsync(9, default);
        var abandoned = service.GetReviewsAsync(9, leaving.Token);
        leaving.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => abandoned);
        release.SetResult();

        var results = await Task.WhenAll(first, second).WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Same(results[0], results[1]);
        Assert.Single(results[0].Reviews);
        Assert.Equal(1, transport.Calls);
        Assert.Same(results[0], await service.GetReviewsAsync(9, default));
        Assert.Equal(1, transport.Calls);
    }

    [Fact]
    public async Task AShorterRetryAfterNeverCutsALongerPauseShort()
    {
        using var env = new IntegrationEnvironment();
        var clock = new Clock();
        var gates = new Dictionary<int, TaskCompletionSource>
        {
            [1] = new(TaskCreationOptions.RunContinuationsAsynchronously),
            [2] = new(TaskCreationOptions.RunContinuationsAsynchronously),
        };
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var waiting = 0;
        using var transport = new IntegrationTransport(async (request, token) =>
        {
            var body = await request.Content!.ReadAsStringAsync(token);
            var id = body.Contains("\"v\":1", StringComparison.Ordinal) ? 1 : body.Contains("\"v\":2", StringComparison.Ordinal) ? 2 : 0;
            if (id == 0) return IntegrationTransport.Response(Media());
            if (Interlocked.Increment(ref waiting) == 2) entered.TrySetResult();
            await gates[id].Task.WaitAsync(token);
            return Refused(429, h => h.RetryAfter = new RetryConditionHeaderValue(TimeSpan.FromSeconds(id == 1 ? 300 : 60)));
        });
        var service = new AnilistReviewsService(transport, env.Logger, clock);

        // Both ids are already in flight when the first 429 (300 s) lands; the second 429 (60 s) comes after.
        var longer = service.GetReviewsAsync(1, default);
        var shorter = service.GetReviewsAsync(2, default);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        gates[1].SetResult();
        await Assert.ThrowsAsync<HttpRequestException>(() => longer);
        gates[2].SetResult();
        await Assert.ThrowsAsync<HttpRequestException>(() => shorter);
        Assert.Equal(2, transport.Calls);

        clock.Now = clock.Now.AddSeconds(61);
        var paused = await Assert.ThrowsAsync<HttpRequestException>(() => service.GetReviewsAsync(3, default));
        Assert.Equal(HttpStatusCode.TooManyRequests, paused.StatusCode);
        Assert.Equal(2, transport.Calls);

        clock.Now = clock.Now.AddSeconds(240);
        Assert.Single((await service.GetReviewsAsync(3, default)).Reviews);
        Assert.Equal(3, transport.Calls);
    }

    [Fact]
    public async Task SharedRequestFailureReachesEveryWaiterAndTheNextCallRetries()
    {
        using var env = new IntegrationEnvironment();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var failing = true;
        using var transport = new IntegrationTransport(async (_, token) =>
        {
            if (!Volatile.Read(ref failing)) return IntegrationTransport.Response(Media());
            entered.TrySetResult();
            await release.Task.WaitAsync(token);
            return IntegrationTransport.Response("{}", 500);
        });
        var service = new AnilistReviewsService(transport, env.Logger);

        var first = service.GetReviewsAsync(12, default);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var second = service.GetReviewsAsync(12, default);
        var third = service.GetReviewsAsync(12, default);
        release.SetResult();
        foreach (var waiter in new[] { first, second, third })
        {
            var error = await Assert.ThrowsAsync<HttpRequestException>(() => waiter.WaitAsync(TimeSpan.FromSeconds(5)));
            Assert.Equal(HttpStatusCode.InternalServerError, error.StatusCode);
        }

        Assert.Equal(1, transport.Calls);

        // A 500 is neither cached nor a rate limit: the next call goes upstream again.
        Volatile.Write(ref failing, false);
        Assert.Single((await service.GetReviewsAsync(12, default)).Reviews);
        Assert.Equal(2, transport.Calls);
    }

    [Fact]
    public async Task ExhaustedRemainingHeaderKeepsTheResultAndLogsOnce()
    {
        using var env = new IntegrationEnvironment();
        using var transport = new IntegrationTransport((_, _) =>
        {
            var response = IntegrationTransport.Response(Media());
            response.Headers.Add("x-ratelimit-limit", "30");
            response.Headers.Add("x-ratelimit-remaining", "0");
            return Task.FromResult(response);
        });
        var service = new AnilistReviewsService(transport, env.Logger);
        var result = await service.GetReviewsAsync(10, default);
        Assert.Single(result.Reviews);
        Assert.Same(result, await service.GetReviewsAsync(10, default));
        await service.GetReviewsAsync(11, default);
        Assert.Equal(2, transport.Calls);
        Assert.Single(File.ReadAllLines(env.Logger.CurrentLogFilePath), l => l.Contains("[DEBUG] [AniList] x-ratelimit-remaining reached 0", StringComparison.Ordinal));
    }
}
