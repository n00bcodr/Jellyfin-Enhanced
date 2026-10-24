using System.Diagnostics;
using System.Globalization;
using System.Threading.Channels;
using Moq;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Import;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists.Sources;
using Xunit.Abstractions;
using static JE.Tests.ListsImportReviewR2FixTests;
using static JE.Tests.ListsSourceReviewR3FixTests;

namespace JE.Tests;

// Track 4c2a review round 4 (D53, each round-3 rule closed over its whole class). Rule 1: every transmission that spends
// the MDBList quota reserves first, atomically, through the one reservation: list reads AND the ratings lookups, single
// and batch (4c2-R4-1: a ratings lookup checked the balance, sent, and charged after its answer, so an import reserving
// meanwhile left 6 remaining at 4 under a margin of 5). Rule 2 (rows classified by their declared type before keying) is
// the per-provider row table in ListsSourceReviewR3FixTests. Rule 3 (Q-4C2AFIX4-1): a preview's identity completion runs
// with bounded concurrency through the shared limiter under one overall budget, and an entry it couldn't complete in
// time is left out with counts hidden (4c2-R4-3: serial, unbounded).
[Collection("Plugin singleton")]
public class ListsSourceReviewR4FixTests(ITestOutputHelper output)
{
    private static readonly CancellationToken None = CancellationToken.None;

    // ── Rule 1: every quota spender reserves before it sends ──────────

    private const string SingleRoute = "https://api.mdblist.com/tmdb/movie/42";
    private const string BatchRoute = "https://api.mdblist.com/tmdb/movie/";

    private static Task Ratings(Net net, string kind) => kind == "single"
        ? net.Quota.GetRatingsAsync("movie", "42", None)
        : (Task)net.Quota.GetMediaBatchAsync("movie", new[] { "42" }, None);

    // 6 remaining (margin 5) as MDBList counts them: every request that reached a counted endpoint comes off.
    private static (Net Net, Func<int> Counted) QuotaAtSix()
    {
        var counted = 0;
        var net = MdblistApiNet(() => MdblistService.SafetyMargin + 1 - Volatile.Read(ref counted));
        foreach (var route in new[] { SingleRoute, BatchRoute, "https://api.mdblist.com/lists/me/a/items" })
        {
            Func<HttpRequestMessage, HttpResponseMessage> answer = net.Routes.TryGetValue(route, out var listAnswer) ? listAnswer : _ => Json(route == BatchRoute ? "[]" : "{\"ratings\":[],\"ids\":{\"tmdb\":42}}");
            net.Routes[route] = r => { Interlocked.Increment(ref counted); return answer(r); };
        }

        return (net, () => Volatile.Read(ref counted));
    }

    [Theory]
    [InlineData("single")]
    [InlineData("batch")]
    public async Task ARatingsLookupInFlightNeverLetsAnImportSpendPastTheSafetyMargin(string kind)
    {
        var (net, counted) = QuotaAtSix();
        using var _ = net;
        Assert.Equal(MdblistService.SafetyMargin + 1, (await net.Quota.GetAccountStatusAsync(None))!.RateLimitRemaining);
        var route = kind == "single" ? SingleRoute : BatchRoute;
        var answer = net.Routes[route];
        var arrived = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        net.AsyncRoutes[route] = async (r, ct) =>
        {
            arrived.SetResult();
            await release.Task.WaitAsync(ct); // keep the answer in flight while the import reserves
            return answer(r);
        };

        var ratings = Ratings(net, kind);
        await arrived.Task.WaitAsync(TimeSpan.FromSeconds(30));
        var import = await net.Fetch("https://mdblist.com/lists/me/a", ApiRead);
        release.SetResult();
        await ratings;

        Assert.Equal((false, "quota_exhausted"), (import.Ok, import.ErrorCode));
        Assert.Equal(0, net.Sent("https://api.mdblist.com/lists/"));
        Assert.Equal(1, counted()); // 6 → 5: the ratings lookup only
        Assert.Equal(MdblistService.SafetyMargin, net.Quota.RemainingQuota());
    }

    [Theory]
    [InlineData("single")]
    [InlineData("batch")]
    public async Task AnImportReservationInFlightRefusesARatingsLookupAtTheSafetyMargin(string kind)
    {
        var (net, counted) = QuotaAtSix();
        using var _ = net;
        var list = net.Routes["https://api.mdblist.com/lists/me/a/items"];
        var arrived = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        net.AsyncRoutes["https://api.mdblist.com/lists/me/a/items"] = async (r, ct) =>
        {
            arrived.SetResult();
            await release.Task.WaitAsync(ct);
            return list(r);
        };

        var import = net.Fetch("https://mdblist.com/lists/me/a", ApiRead);
        await arrived.Task.WaitAsync(TimeSpan.FromSeconds(30));
        await Ratings(net, kind);
        release.SetResult();

        Assert.True((await import).Ok);
        Assert.Equal(0, net.Sent(kind == "single" ? SingleRoute : BatchRoute));
        Assert.Equal(1, counted());
        Assert.Equal(MdblistService.SafetyMargin, net.Quota.RemainingQuota());
    }

    [Fact]
    public async Task AFetcherWithoutTheQuotaNeverSendsAnMdblistApiRead()
    {
        using var net = MdblistApiNet(() => 900);
        var fetcher = new ListSourceFetcher(net.Factory, net.Tmdb, null, new MetadataCallLimiter(4, TimeSpan.Zero, TimeProvider.System), net.Plugin.Core.Logger, null, net.Admission);
        Assert.True(ListSourceUrl.TryParse("https://mdblist.com/lists/me/a", out var source, out _));

        var result = await fetcher.FetchAsync(source!, ApiRead, None);

        Assert.Equal((false, "quota_exhausted"), (result.Ok, result.ErrorCode));
        Assert.Equal(0, net.Sent("https://api.mdblist.com/"));
    }

    [Fact] // r4-after (new API)
    public async Task AMediaBatchNeverSpendsPastTheReserveItWasAskedToKeep()
    {
        var (net, counted) = QuotaAtSix(); // 6 remaining; the scheduled fetch keeps a reserve of 5 + 0, then of 6
        using var _ = net;

        Assert.Null(await net.Quota.GetMediaBatchAsync("movie", new[] { "42" }, None, reserve: MdblistService.SafetyMargin + 1));
        Assert.Equal(0, counted());
        Assert.NotNull(await net.Quota.GetMediaBatchAsync("movie", new[] { "42" }, None, reserve: 0)); // the margin still holds: 6 → 5
        Assert.Null(await net.Quota.GetMediaBatchAsync("movie", new[] { "42" }, None, reserve: 0));
        Assert.Equal(1, counted());
    }

    // ── Rule 3 (Q-4C2AFIX4-1): completion under a budget, bounded through the limiter ──

    /// <summary>The library holds copies no source id can find, so every entry's identity goes through the lookup.</summary>
    internal sealed class CopiesBeyondEveryId : IImportPhysicalTitles
    {
        public ImportPhysical Read(User viewer, CompletedIdentity identity, int? season) => ImportPhysical.None;

        public bool HoldsCopiesBeyond(ImportIdentity identity) => true;
    }

    /// <summary>
    /// The production preview, resolver and TMDB title lookup (through the shared limiter and JE's TMDB cache) over a
    /// TMDB whose details answers take <see cref="Latency"/>, or wait until <see cref="Release"/> for the held ids.
    /// </summary>
    internal sealed class CompletionWorld : IDisposable
    {
        private int _inFlight;
        private readonly Channel<int> _arrivals = Channel.CreateUnbounded<int>();
        private readonly Channel<int> _completed = Channel.CreateUnbounded<int>();
        private readonly TimeProvider _time;

        public CompletionWorld(int entries, MetadataCallLimiter limiter, TimeProvider? time = null)
        {
            _time = time ?? TimeProvider.System;
            H.Plugin.Plugin.Configuration.TMDB_API_KEY = "tmdb-key";
            Transport = new IntegrationTransport(async (request, ct) =>
            {
                var id = int.Parse(request.RequestUri!.AbsolutePath.Split('/').Last(), CultureInfo.InvariantCulture);
                var now = Interlocked.Increment(ref _inFlight);
                lock (Starts)
                {
                    Peak = Math.Max(Peak, now);
                    Starts.Add(id);
                }

                try
                {
                    // Register the wait before publishing the start: the controller can now advance time safely.
                    var wait = Held.Contains(id) ? Release.Task.WaitAsync(ct) : Task.Delay(Latency, _time, ct);
                    _arrivals.Writer.TryWrite(id);
                    await wait;

                    if (Answer(id) is var status and not 200)
                    {
                        return IntegrationTransport.Response("{\"status_code\":34,\"status_message\":\"The resource you requested could not be found.\"}", status);
                    }

                    return IntegrationTransport.Response("{\"id\":" + id + ",\"title\":\"M" + id + "\",\"release_date\":\"2001-01-01\",\"imdb_id\":\"tt" + (1000000 + id) + "\",\"external_ids\":{\"imdb_id\":\"tt" + (1000000 + id) + "\"}}");
                }
                finally
                {
                    Interlocked.Decrement(ref _inFlight);
                }
            });
            Tmdb = new TmdbResponseCache(Transport, _time);
            var logger = H.Plugin.Core.Logger;
            var lookup = new TmdbImportLookup(Tmdb, limiter, logger);
            // Observe completed real lookups, including parsing/cache publication, rather than guessing from HTTP starts.
            var observed = new Mock<IImportLookup>(MockBehavior.Strict);
            observed.SetupGet(l => l.IsConfigured).Returns(true);
            observed.SetupGet(l => l.Provider).Returns("tmdb");
            observed.Setup(l => l.GetDetailsAsync(It.IsAny<string>(), It.IsAny<int>(), It.IsAny<ImportCallContext>(), It.IsAny<CancellationToken>()))
                .Returns(async (string type, int id, ImportCallContext context, CancellationToken ct) =>
                {
                    using var combined = CancellationTokenSource.CreateLinkedTokenSource(ct, CompletionCancellation);
                    var result = await lookup.GetDetailsAsync(type, id, context, combined.Token);
                    _completed.Writer.TryWrite(id);
                    return result;
                });
            var physical = new CopiesBeyondEveryId();
            var resolver = new ListImportResolver(observed.Object, H.Library, H.Access, limiter, logger, H.Viewer, physical);
            Preview = new ListSourcePreview(H.Fetcher, resolver, H.Access, logger, H.Viewer, physical);
            H.Fetcher.Items = Enumerable.Range(1, entries).Select(i => new SourceItem("movie", i, null, null, "M" + i, 2001, null, null, null)).ToList();
            Admin = H.NewUser("admin", admin: true);
        }

        public ImportHarness H { get; } = new();
        public IntegrationTransport Transport { get; }
        public TmdbResponseCache Tmdb { get; }
        public ListSourcePreview Preview { get; }
        public User Admin { get; }
        public TimeSpan Latency { get; set; } = TimeSpan.FromMilliseconds(10);
        public Func<int, int> Answer { get; set; } = _ => 200; // r5: TMDB's status per id (404: a stale id, 5xx: transient)
        public HashSet<int> Held { get; } = new();
        public CancellationToken CompletionCancellation { get; set; }
        public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public List<int> Starts { get; } = new();
        public int Peak { get; private set; }

        // These bounds detect deadlocks only; behavioral assertions use the controlled clock and completion signals.
        public async Task<int[]> Arrivals(int count) => await Read(_arrivals, count);
        public async Task<int[]> Completed(int count) => await Read(_completed, count);

        private static async Task<int[]> Read(Channel<int> channel, int count)
        {
            using var watchdog = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            var ids = new List<int>();
            while (ids.Count < count)
            {
                ids.Add(await channel.Reader.ReadAsync(watchdog.Token));
            }

            return ids.ToArray();
        }

        public async Task<(SourceFetchResponse Response, TimeSpan Took)> Fetch()
        {
            var clock = Stopwatch.StartNew();
            var start = _time.GetUtcNow();
            var outcome = await Preview.FetchAsync(Admin, "https://mdblist.com/lists/me/mine", None);
            return (ImportHarness.Ok<SourceFetchResponse>(outcome), _time == TimeProvider.System ? clock.Elapsed : _time.GetUtcNow() - start);
        }

        public void Dispose()
        {
            Release.TrySetResult();
            Tmdb.Dispose();
            H.Dispose();
        }
    }

    [Fact]
    public async Task AThousandEntriesCompleteConcurrentlyThroughTheSharedLimiter()
    {
        var clock = new ListsImportScoringTests.ManualClock();
        var limiter = new MetadataCallLimiter(4, TimeSpan.Zero, clock);
        using var w = new CompletionWorld(1000, limiter, clock);
        w.Preview.CompletionBudget = Timeout.InfiniteTimeSpan; // throughput is measured independently of budget expiry

        var fetch = w.Fetch();
        for (var done = 0; done < 1000; done += limiter.MaxConcurrent)
        {
            // A serial implementation cannot fill a batch. No clock tick is spent waiting for the host to schedule it.
            await w.Arrivals(limiter.MaxConcurrent);
            Assert.NotNull(clock.NextDue);
            clock.AdvanceTo(clock.NextDue!.Value);
            await w.Completed(limiter.MaxConcurrent);
        }

        var (response, took) = await fetch.WaitAsync(TimeSpan.FromSeconds(30));
        var serial = w.Latency * 1000;
        output.WriteLine($"1000 completions: {took.TotalMilliseconds:0} controlled ms (serial: {serial.TotalMilliseconds:0} ms), peak {w.Peak}, limiter {limiter.Stats()}");
        Assert.Equal(1000, response.Entries.Count);
        Assert.NotEqual(true, response.CountsHidden);
        Assert.Equal(1000, w.Starts.Count);
        Assert.Equal(1000, w.Starts.Distinct().Count()); // exactly one completion per identity
        Assert.InRange(w.Peak, 2, limiter.MaxConcurrent); // concurrent, and never past the shared limiter
        Assert.Equal(serial / limiter.MaxConcurrent, took);
        Assert.True(took < serial * 0.6); // the original strict 6 s / 10 s bound, in controlled time
        Assert.Equal(0, clock.Pending);
    }

    [Fact]
    public async Task EntriesNotCompletedWithinTheBudgetAreLeftOutWithCountsHiddenAndARetryCompletesThem()
    {
        var clock = new ListsImportScoringTests.ManualClock();
        var limiter = new MetadataCallLimiter(4, TimeSpan.Zero, clock);
        using var w = new CompletionWorld(6, limiter, clock);
        // Drive the lookup cancellation boundary on a manual clock. Caller cancellation aborts the whole request,
        // whereas completion-budget cancellation omits unfinished entries. Inject at the lookup, keeping the caller
        // live. The next test independently verifies CancelAfter(CompletionBudget) with real zero/positive budgets.
        w.Preview.CompletionBudget = Timeout.InfiniteTimeSpan;
        w.Held.UnionWith(new[] { 5, 6 });
        var start = clock.GetUtcNow();
        var duration = TimeSpan.FromMilliseconds(500);
        using var budget = new CancellationTokenSource(duration, clock);
        w.CompletionCancellation = budget.Token;

        var fetch = w.Fetch();
        Assert.Equal(new[] { 1, 2, 3, 4 }, (await w.Arrivals(4)).OrderBy(id => id));
        clock.AdvanceTo(clock.NextDue!.Value);
        Assert.Equal(new[] { 1, 2, 3, 4 }, (await w.Completed(4)).OrderBy(id => id));
        Assert.Equal(new[] { 5, 6 }, (await w.Arrivals(2)).OrderBy(id => id));
        Assert.False(fetch.IsCompleted); // unfinished lookups really hold the preview open before cancellation
        clock.AdvanceTo(start + duration);
        var (first, took) = await fetch.WaitAsync(TimeSpan.FromSeconds(30));
        Assert.Equal(duration, took);

        Assert.Equal(new[] { 1, 2, 3, 4 }, first.Entries.Select(e => e.Ids!.Tmdb!.Value).ToArray());
        Assert.True(first.CountsHidden);
        Assert.Null(first.Snapshot);
        Assert.Equal(0, first.Total);
        Assert.Equal(0, first.Dropped);
        Assert.Equal(6, w.Starts.Count);
        Assert.InRange(w.Peak, 2, limiter.MaxConcurrent);

        // Completed ids stay cached; unfinished ids remain retryable after the held answers become available.
        w.Release.SetResult();
        w.CompletionCancellation = None;
        var (second, _) = await w.Fetch().WaitAsync(TimeSpan.FromSeconds(30));

        Assert.Equal(Enumerable.Range(1, 6), second.Entries.Select(e => e.Ids!.Tmdb!.Value));
        Assert.NotEqual(true, second.CountsHidden);
        Assert.NotNull(second.Snapshot);
        Assert.Equal(4, w.Starts.Count(id => id <= 4)); // retry never asks for a completed identity again
        Assert.All(new[] { 5, 6 }, id => Assert.InRange(w.Starts.Count(start => start == id), 1, 2));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(400)]
    public async Task ABudgetThatExpiresWhileEveryLookupIsQueuedAtTheLimiterFailsClosedInTime(int milliseconds)
    {
        // Hold every slot until AFTER the preview returns: only its own completion budget can end these waits.
        var limiter = new MetadataCallLimiter(2, TimeSpan.Zero, TimeProvider.System);
        using var w = new CompletionWorld(3, limiter);
        w.Preview.CompletionBudget = TimeSpan.FromMilliseconds(milliseconds);
        using var a = await limiter.AcquireAsync("someone else", false, None);
        using var b = await limiter.AcquireAsync("someone else", false, None);

        var (response, _) = await w.Fetch().WaitAsync(TimeSpan.FromSeconds(30));

        Assert.Empty(response.Entries);
        Assert.True(response.CountsHidden);
        Assert.Null(response.Snapshot);
        Assert.Equal(0, response.Total);
        Assert.Equal(0, response.Dropped);
        Assert.Empty(w.Starts); // neither the timer nor a cancelled queue waiter can send past the limiter
        Assert.Equal(2, limiter.Stats().Total);

        a.Dispose();
        b.Dispose();
        w.Preview.CompletionBudget = Timeout.InfiniteTimeSpan;
        w.Latency = TimeSpan.Zero;
        var (retry, _) = await w.Fetch().WaitAsync(TimeSpan.FromSeconds(30));
        Assert.Equal(Enumerable.Range(1, 3), retry.Entries.Select(e => e.Ids!.Tmdb!.Value));
        Assert.NotEqual(true, retry.CountsHidden);
        Assert.NotNull(retry.Snapshot);
        Assert.Equal(3, w.Starts.Count);
        Assert.Equal(3, w.Starts.Distinct().Count());
        Assert.Equal(5, limiter.Stats().Total); // the three cancelled waiters never take a slot on release
    }

    [Fact] // r4-after (new API)
    public void TheCompletionBudgetLeavesTheWholePreviewUnderAProxyTimeout()
    {
        // Completion runs at the shared limiter's pace (about 10 lookups a second): the budget decides how many entries
        // one review completes, and a large paged read (up to 10 s measured) plus the budget must stay under 60 s.
        Assert.InRange(ListSourcePreview.DefaultCompletionBudget, TimeSpan.FromSeconds(10), TimeSpan.FromSeconds(40));
        Assert.True(ListSourcePreview.DefaultCompletionBudget.TotalSeconds * 1000 / MetadataCallLimiter.DefaultSpacing.TotalMilliseconds >= 250, "a 250-entry TMDB list completes in one review");
    }
}
