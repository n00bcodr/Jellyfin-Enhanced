using System.Diagnostics;
using System.Globalization;
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
        var arrived = false;
        using var release = new ManualResetEventSlim();
        net.Routes[route] = r =>
        {
            Volatile.Write(ref arrived, true);
            release.Wait(TimeSpan.FromSeconds(10)); // the ratings answer is still on its way while the import reserves
            return answer(r);
        };

        var ratings = Task.Run(() => Ratings(net, kind));
        await WaitUntil(() => Volatile.Read(ref arrived));
        var import = await net.Fetch("https://mdblist.com/lists/me/a", ApiRead);
        release.Set();
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
        var arrived = false;
        using var release = new ManualResetEventSlim();
        net.Routes["https://api.mdblist.com/lists/me/a/items"] = r =>
        {
            Volatile.Write(ref arrived, true);
            release.Wait(TimeSpan.FromSeconds(10));
            return list(r);
        };

        var import = Task.Run(() => net.Fetch("https://mdblist.com/lists/me/a", ApiRead));
        await WaitUntil(() => Volatile.Read(ref arrived));
        await Ratings(net, kind);
        release.Set();

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

        public CompletionWorld(int entries, MetadataCallLimiter limiter)
        {
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
                    if (Held.Contains(id))
                    {
                        await Task.WhenAny(Task.Delay(Timeout.Infinite, ct), Task.Run(() => Release.Wait(TimeSpan.FromSeconds(30)), CancellationToken.None));
                        ct.ThrowIfCancellationRequested();
                    }
                    else
                    {
                        await Task.Delay(Latency, ct);
                    }

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
            Tmdb = new TmdbResponseCache(Transport, TimeProvider.System);
            var logger = H.Plugin.Core.Logger;
            var lookup = new TmdbImportLookup(Tmdb, limiter, logger);
            var physical = new CopiesBeyondEveryId();
            var resolver = new ListImportResolver(lookup, H.Library, H.Access, limiter, logger, H.Viewer, physical);
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
        public ManualResetEventSlim Release { get; } = new();
        public List<int> Starts { get; } = new();
        public int Peak { get; private set; }

        public async Task<(SourceFetchResponse Response, TimeSpan Took)> Fetch()
        {
            var clock = Stopwatch.StartNew();
            var outcome = await Preview.FetchAsync(Admin, "https://mdblist.com/lists/me/mine", None);
            return (ImportHarness.Ok<SourceFetchResponse>(outcome), clock.Elapsed);
        }

        public void Dispose()
        {
            Release.Set();
            Tmdb.Dispose();
            H.Dispose();
        }
    }

    [Fact]
    public async Task AThousandEntriesCompleteConcurrentlyThroughTheSharedLimiter()
    {
        var limiter = new MetadataCallLimiter(4, TimeSpan.Zero, TimeProvider.System);
        using var w = new CompletionWorld(1000, limiter);

        var (response, took) = await w.Fetch();

        output.WriteLine($"1000 completions at {w.Latency.TotalMilliseconds} ms each: {took.TotalMilliseconds:0} ms, peak {w.Peak} in flight, limiter {limiter.Stats()}");
        Assert.Equal(1000, response.Entries.Count);
        Assert.NotEqual(true, response.CountsHidden);
        Assert.Equal(1000, w.Starts.Distinct().Count()); // one completion per identity
        Assert.InRange(w.Peak, 2, limiter.MaxConcurrent); // concurrent, and never past the shared limiter
        Assert.True(took < TimeSpan.FromSeconds(6), $"1000 completions took {took.TotalMilliseconds:0} ms (serially: ≥ 10 s)");
    }

    [Fact]
    public async Task EntriesNotCompletedWithinTheBudgetAreLeftOutWithCountsHiddenAndARetryCompletesThem()
    {
        var limiter = new MetadataCallLimiter(4, TimeSpan.Zero, TimeProvider.System);
        using var w = new CompletionWorld(6, limiter);
        w.Preview.CompletionBudget = TimeSpan.FromMilliseconds(500); // r4-seam
        w.Held.UnionWith(new[] { 5, 6 }); // TMDB doesn't answer these two in time

        var (first, took) = await w.Fetch();

        output.WriteLine($"budget expiry: {took.TotalMilliseconds:0} ms");
        Assert.True(took < TimeSpan.FromSeconds(3), $"the preview waited {took.TotalMilliseconds:0} ms past a 500 ms budget");
        Assert.Equal(new[] { 1, 2, 3, 4 }, first.Entries.Select(e => e.Ids!.Tmdb!.Value).ToArray());
        Assert.True(first.CountsHidden);
        Assert.Null(first.Snapshot);
        Assert.Equal(0, first.Total);

        // Retryable: the completed ids are cached, and once TMDB answers the held two, the next preview has them all.
        w.Held.Clear();
        w.Release.Set();
        var (second, _) = await w.Fetch();

        Assert.Equal(6, second.Entries.Count);
        Assert.NotEqual(true, second.CountsHidden);
        Assert.NotNull(second.Snapshot);
    }

    [Fact]
    public async Task ABudgetThatExpiresWhileEveryLookupIsQueuedAtTheLimiterFailsClosedInTime()
    {
        // Another user's calls hold every slot of the shared limiter: the preview's lookups queue, and the budget ends them.
        var limiter = new MetadataCallLimiter(2, TimeSpan.Zero, TimeProvider.System);
        using var w = new CompletionWorld(3, limiter);
        w.Preview.CompletionBudget = TimeSpan.FromMilliseconds(400); // r4-seam
        var a = await limiter.AcquireAsync("someone else", false, None);
        var b = await limiter.AcquireAsync("someone else", false, None);

        var fetch = w.Fetch();
        var inTime = await Task.WhenAny(fetch, Task.Delay(TimeSpan.FromSeconds(5))) == fetch;
        a.Dispose();
        b.Dispose();
        Assert.True(inTime, "the preview was still waiting at the full limiter after 5 s");
        var (response, took) = await fetch;

        Assert.True(took < TimeSpan.FromSeconds(3), $"the preview waited {took.TotalMilliseconds:0} ms at a full limiter");
        Assert.Empty(response.Entries);
        Assert.True(response.CountsHidden);
        Assert.Empty(w.Starts); // nothing was sent past the limiter
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
