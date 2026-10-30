using Jellyfin.Plugin.JellyfinEnhanced.Services;

namespace JE.Tests;

public class IntegrationStatusTagsSeriesTests
{
    private sealed class IntegrationClock : TimeProvider
    {
        private DateTimeOffset _now = DateTimeOffset.UtcNow;
        public override DateTimeOffset GetUtcNow() => _now;
        public void Advance(TimeSpan elapsed) => _now += elapsed;
    }

    private const string Show = """
        {"id":100,"status":"Returning Series",
         "last_episode_to_air":{"air_date":"2026-10-28","season_number":2,"episode_number":10,"episode_type":"finale"},
         "next_episode_to_air":{"air_date":"2027-03-01","season_number":3,"episode_number":1,"episode_type":"standard"}}
        """;

    private static string TmdbId(HttpRequestMessage request) => request.RequestUri!.AbsolutePath.Split('/').Last();

    [Theory]
    [InlineData(429)]
    [InlineData(503)]
    [InlineData(0)]
    public async Task TransientUpstreamFailuresCarryARetryMarker(int status)
    {
        using var env = new IntegrationEnvironment();
        using var transport = new IntegrationTransport((_, _) => status == 0
            ? Task.FromException<HttpResponseMessage>(new HttpRequestException("offline"))
            : Task.FromResult(IntegrationTransport.Response("{}", status)));
        using var cache = new TmdbResponseCache(transport, TimeProvider.System);
        var service = new StatusTagsSeriesService(cache, env.Logger);
        var result = await service.GetAsync("key", new Dictionary<string, string> { ["item"] = "100" }, CancellationToken.None);
        Assert.True(result.ContainsKey("item"), "Transient failures must differ from authoritative missing data");
        Assert.True((bool?)result["item"].GetType().GetProperty("Retry")?.GetValue(result["item"]));
    }

    [Fact]
    public void ParsesStatusLastAndNextAiredWithTheEpisodeType()
    {
        var schedule = StatusTagsSeriesService.Parse(Show);
        Assert.NotNull(schedule);
        Assert.Equal("Returning Series", schedule.Status);
        Assert.Equal(new SeriesEpisodeRef("2026-10-28", 2, 10, "finale"), schedule.LastAired);
        // Only the last aired episode carries its type.
        Assert.Equal(new SeriesEpisodeRef("2027-03-01", 3, 1, null), schedule.NextAired);
    }

    [Theory]
    [InlineData("""{"status":"Ended","last_episode_to_air":{"air_date":"2020-01-05","season_number":5,"episode_number":16},"next_episode_to_air":null}""", "Ended", true, false)]
    [InlineData("""{"status":"Canceled","last_episode_to_air":{"air_date":"","season_number":1,"episode_number":2}}""", "Canceled", false, false)]
    [InlineData("""{"status":"Returning Series","next_episode_to_air":{"air_date":"not a date"}}""", "Returning Series", false, false)]
    public void EpisodesWithoutAUsableAirDateAreLeftOut(string json, string status, bool hasLast, bool hasNext)
    {
        var schedule = StatusTagsSeriesService.Parse(json);
        Assert.NotNull(schedule);
        Assert.Equal(status, schedule.Status);
        Assert.Equal(hasLast, schedule.LastAired != null);
        Assert.Equal(hasNext, schedule.NextAired != null);
        if (hasLast) Assert.Null(schedule.LastAired!.Type); // no episode_type: null, not "standard"
    }

    [Theory]
    [InlineData("[]")]
    [InlineData("{}")]
    [InlineData("not json")]
    public void UnreadableAnswersHaveNoSchedule(string json) => Assert.Null(StatusTagsSeriesService.Parse(json));

    [Fact]
    public async Task NoApiKeyAsksNothing()
    {
        using var env = new IntegrationEnvironment();
        using var transport = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response(Show)));
        using var tmdbCache = new TmdbResponseCache(transport, TimeProvider.System);
        var service = new StatusTagsSeriesService(tmdbCache, env.Logger);
        Assert.Empty(await service.GetAsync(null, new Dictionary<string, string> { ["a"] = "100" }, CancellationToken.None));
        Assert.Empty(await service.GetAsync("", new Dictionary<string, string> { ["a"] = "100" }, CancellationToken.None));
        Assert.Equal(0, transport.Calls);
    }

    [Fact]
    public async Task OneLookupPerTmdbIdIsSharedByItsItemsAndCachedForTheNextRequest()
    {
        using var env = new IntegrationEnvironment();
        var asked = new List<string>();
        using var transport = new IntegrationTransport((request, _) =>
        {
            lock (asked) asked.Add(TmdbId(request));
            return Task.FromResult(TmdbId(request) == "404" ? IntegrationTransport.Response("{}", 404) : IntegrationTransport.Response(Show));
        });
        using var tmdbCache = new TmdbResponseCache(transport, TimeProvider.System);
        var service = new StatusTagsSeriesService(tmdbCache, env.Logger);
        var ids = new Dictionary<string, string> { ["a"] = "100", ["b"] = "100", ["c"] = "404" };

        var first = await service.GetAsync("key", ids, CancellationToken.None);
        Assert.Equal(["a", "b"], first.Keys.Order());
        Assert.Equal("finale", first["a"].LastAired!.Type);
        Assert.Equal(["100", "404"], asked.Order());

        // Within the response cache's TTL (6 hours for a title lookup) nothing goes upstream again.
        var second = await service.GetAsync("key", ids, CancellationToken.None);
        Assert.Equal(first["b"], second["b"]);
        Assert.Equal(2, asked.Count);
    }

    [Fact]
    public async Task NoMoreThanFourLookupsRunAtOnce()
    {
        using var env = new IntegrationEnvironment();
        var running = 0;
        var peak = 0;
        using var transport = new IntegrationTransport(async (_, token) =>
        {
            var now = Interlocked.Increment(ref running);
            InterlockedMax(ref peak, now);
            await Task.Delay(30, token);
            Interlocked.Decrement(ref running);
            return IntegrationTransport.Response(Show);
        });
        using var tmdbCache = new TmdbResponseCache(transport, TimeProvider.System);
        var service = new StatusTagsSeriesService(tmdbCache, env.Logger);
        var ids = Enumerable.Range(1, 20).ToDictionary(i => "item" + i, i => i.ToString());

        var result = await service.GetAsync("key", ids, CancellationToken.None);
        Assert.Equal(20, result.Count);
        Assert.Equal(StatusTagsSeriesService.MaxInFlight, peak);
    }

    [Fact]
    public async Task UpstreamLookupsBeyondTheWindowShareWaitForItToMoveOn()
    {
        using var env = new IntegrationEnvironment();
        var started = new List<DateTimeOffset>();
        using var transport = new IntegrationTransport(async (_, token) =>
        {
            lock (started) started.Add(DateTimeOffset.UtcNow);
            await Task.Delay(5, token);
            return IntegrationTransport.Response(Show);
        });
        using var tmdbCache = new TmdbResponseCache(transport, TimeProvider.System);
        // Three upstream lookups per 300 ms window.
        var service = new StatusTagsSeriesService(tmdbCache, env.Logger, TimeProvider.System, maxInFlight: 4, perWindow: 3, window: TimeSpan.FromMilliseconds(300));
        var ids = Enumerable.Range(1, 6).ToDictionary(i => "item" + i, i => i.ToString());

        var result = await service.GetAsync("key", ids, CancellationToken.None);
        Assert.Equal(6, result.Count);
        var ordered = started.Order().ToList();
        Assert.True(ordered[3] - ordered[0] >= TimeSpan.FromMilliseconds(250), $"the fourth lookup started {(ordered[3] - ordered[0]).TotalMilliseconds} ms after the first");

        // Answers already in the response cache do not count against the window.
        var timer = System.Diagnostics.Stopwatch.StartNew();
        Assert.Equal(6, (await service.GetAsync("key", ids, CancellationToken.None)).Count);
        Assert.True(timer.Elapsed < TimeSpan.FromMilliseconds(250));
        Assert.Equal(6, started.Count);
    }

    [Fact]
    public async Task MissingEpisodeTypeIsEnrichedFromTheSeasonAndBothAnswersExpireAfterSixHours()
    {
        using var env = new IntegrationEnvironment();
        var clock = new IntegrationClock();
        using var transport = new IntegrationTransport((request, _) => Task.FromResult(IntegrationTransport.Response(
            request.RequestUri!.AbsolutePath.EndsWith("/season/2", StringComparison.Ordinal)
                ? """{"episodes":[{"episode_number":10,"episode_type":"finale"}]}"""
                : """{"status":"Returning Series","last_episode_to_air":{"air_date":"2026-10-28","season_number":2,"episode_number":10}}""")));
        using var cache = new TmdbResponseCache(transport, clock);
        var service = new StatusTagsSeriesService(cache, env.Logger);
        var ids = new Dictionary<string, string> { ["item"] = "100" };
        Assert.Equal("finale", (await service.GetAsync("key", ids, CancellationToken.None))["item"].LastAired!.Type);
        Assert.Equal(2, transport.Calls);
        clock.Advance(TimeSpan.FromHours(5));
        await service.GetAsync("key", ids, CancellationToken.None);
        Assert.Equal(2, transport.Calls);
        clock.Advance(TimeSpan.FromHours(2));
        await service.GetAsync("key", ids, CancellationToken.None);
        Assert.Equal(4, transport.Calls);
    }

    [Fact]
    public async Task ANewerSpecialKeepsItsScheduleAndEnrichesTheLastAiredRegularEpisode()
    {
        using var env = new IntegrationEnvironment();
        var asked = new List<string>();
        using var transport = new IntegrationTransport((request, _) =>
        {
            var path = request.RequestUri!.AbsolutePath;
            asked.Add(path);
            return Task.FromResult(IntegrationTransport.Response(path.EndsWith("/season/1", StringComparison.Ordinal)
                ? """{"episodes":[{"air_date":"2020-01-01","season_number":1,"episode_number":9},{"air_date":"2020-01-02","season_number":1,"episode_number":10,"episode_type":"finale"},{"air_date":"2099-01-01","season_number":1,"episode_number":11},{"air_date":"2020-01-03","season_number":0,"episode_number":8}]}"""
                : """{"status":"Ended","last_episode_to_air":{"air_date":"2020-01-03","season_number":0,"episode_number":8,"episode_type":"standard"},"seasons":[{"season_number":0,"air_date":"2020-01-03"},{"season_number":1,"air_date":"2020-01-01"},{"season_number":2,"air_date":"2099-01-01"}]}"""));
        });
        using var cache = new TmdbResponseCache(transport, TimeProvider.System);
        var service = new StatusTagsSeriesService(cache, env.Logger);
        var ids = new Dictionary<string, string> { ["item"] = "100" };
        var schedule = (await service.GetAsync("key", ids, CancellationToken.None))["item"];
        Assert.Equal(0, schedule.LastAired!.Season);
        Assert.Equal(new SeriesEpisodeRef("2020-01-02", 1, 10, "finale"),
            schedule.GetType().GetProperty("LastRegularAired")?.GetValue(schedule));
        Assert.Equal(2, asked.Count);
        Assert.EndsWith("/season/1", asked[1]);
        Assert.Equal(schedule, (await service.GetAsync("key", ids, CancellationToken.None))["item"]);
        Assert.Equal(2, asked.Count);
    }

    [Fact]
    public async Task SynchronousUpstreamResponsesAlsoConsumeTheRateWindow()
    {
        using var env = new IntegrationEnvironment();
        using var transport = new IntegrationTransport((_, _) => Task.FromResult(IntegrationTransport.Response(Show)));
        using var cache = new TmdbResponseCache(transport, TimeProvider.System);
        var service = new StatusTagsSeriesService(cache, env.Logger, TimeProvider.System, 4, 2, TimeSpan.FromMilliseconds(150));
        var timer = System.Diagnostics.Stopwatch.StartNew();
        await service.GetAsync("key", Enumerable.Range(1, 3).ToDictionary(i => "item" + i, i => i.ToString()), CancellationToken.None);
        Assert.True(timer.Elapsed >= TimeSpan.FromMilliseconds(140));
        Assert.Equal(3, transport.Calls);
    }

    [Fact]
    public async Task AbandonedCallersDoNotReleaseSlotsWhileSharedUpstreamRequestsStillRun()
    {
        using var env = new IntegrationEnvironment();
        var running = 0;
        var peak = 0;
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var finish = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var transport = new IntegrationTransport(async (_, _) =>
        {
            var count = Interlocked.Increment(ref running);
            InterlockedMax(ref peak, count);
            if (count == 4) started.TrySetResult();
            await finish.Task;
            Interlocked.Decrement(ref running);
            return IntegrationTransport.Response(Show);
        });
        using var cache = new TmdbResponseCache(transport, TimeProvider.System);
        var service = new StatusTagsSeriesService(cache, env.Logger);
        using var caller = new CancellationTokenSource();
        var first = service.GetAsync("key", Enumerable.Range(1, 4).ToDictionary(i => "item" + i, i => i.ToString()), caller.Token);
        await started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        caller.Cancel();
        var next = service.GetAsync("key", new Dictionary<string, string> { ["next"] = "5" }, CancellationToken.None);
        await Task.Delay(30);
        Assert.Equal(4, transport.Calls);
        finish.TrySetResult();
        await Task.WhenAll(first, next);
        Assert.Equal(4, peak);
    }

    private static void InterlockedMax(ref int target, int value)
    {
        int current;
        while ((current = Volatile.Read(ref target)) < value && Interlocked.CompareExchange(ref target, value, current) != current)
        {
        }
    }
}
