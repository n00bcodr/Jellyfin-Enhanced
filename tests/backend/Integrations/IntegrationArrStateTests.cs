using System.Text.Json;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;

namespace JE.Tests;

/// <summary>
/// ArrStateStore: snapshots served from memory with zero upstream calls per request once warm,
/// paged queue reads, history catch-up, calendar window, appName checks, backoff, the reconciler's
/// interest rules, and the warm-start file.
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationArrStateTests
{
    private static FakeArr Rig(out FakeArr.Host radarr, out FakeArr.Host sonarr)
    {
        var arr = new FakeArr();
        radarr = arr.Add("radarr.lan", "Radarr");
        sonarr = arr.Add("sonarr.lan", "Sonarr");
        arr.Configure(("Movies", ArrKind.Radarr, "http://radarr.lan:7878", "RADARR-KEY-0123456789"), ("TV", ArrKind.Sonarr, "http://sonarr.lan:8989", "SONARR-KEY-0123456789"));
        return arr;
    }

    private static async Task Settle(ArrStateStore store)
    {
        for (var i = 0; i < 200; i++)
        {
            if (store.Describe().Instances.All(x => x.Snapshots.All(s => !s.Refreshing))) return;
            await Task.Delay(10);
        }
        throw new TimeoutException("refreshes did not finish");
    }

    [Fact]
    public async Task PersistentShortReadsRetainAnOmittedDownloadUntilItsOriginalSightingExpires()
    {
        var (arr, sonarr, store, tv) = await QueueOf(501);
        using var lifetime = arr;
        sonarr.Series.Add(FakeArr.SeriesRow(1, 100, "Show"));
        sonarr.Episodes.Add(FakeArr.Episode(501, "2020-01-01T00:00:00Z", tvdb: 100, episode: 501));
        var lastSeen = arr.Now;
        var view = new FakeJellyfinView();
        var admin = view.AddUser(admin: true);
        var episode = Guid.NewGuid();
        view.AddItem(new JfItemRef { ItemId = episode, Kind = "episode", Key = TitleKey.Parse("tv:tvdb:100:s1:e501"), Season = 1, Episode = 501, Virtual = true });
        var status = new ArrStatusService(store, view, new NoRequestFacts(), () => arr.Plugin.Plugin.Configuration, () => arr.Now);
        async Task<JsonElement> Item()
        {
            var body = await status.ForItemAsync(admin, episode, default);
            return JsonDocument.Parse(body.Json).RootElement.GetProperty("items")[0].Clone();
        }
        Assert.Equal("downloading", (await Item()).GetProperty("stage").GetString());
        sonarr.Queue.RemoveAt(500); // The incomplete response persistently omits this still-active row.
        sonarr.ReportedTotal = (path, count) => path == "/api/v3/queue" ? 501 : count;
        arr.Now = lastSeen + ArrStateStore.QueueKeepHeld + TimeSpan.FromSeconds(1);
        await Refresh(arr, store, tv);
        Assert.True(store.PeekQueue(tv.Id)!.Incomplete);
        var held = await Item();
        Assert.Equal("downloading", held.GetProperty("stage").GetString());
        Assert.False(held.GetProperty("progress").TryGetProperty("etaSeconds", out _));
        var group = Assert.Single(NeedsAttention.Group(tv, store.PeekQueue(tv.Id), store.PeekLibrary(tv.Id), retained: store.MissedQueueRows(tv)), g => g.Ids.Contains(501));
        Assert.Equal("downloading", group.Status);
        Assert.Empty(group.Actions);
        Assert.Null(group.Eta);
        Assert.Null(store.LeftQueueAt(tv, null, 501));
        arr.Now = lastSeen + TimeSpan.FromMinutes(10) + TimeSpan.FromSeconds(1);
        await Refresh(arr, store, tv);
        var unknown = await Item();
        Assert.Equal("service_down", unknown.GetProperty("reason").GetProperty("code").GetString());
        Assert.False(unknown.TryGetProperty("progress", out _));
        Assert.DoesNotContain(NeedsAttention.Group(tv, store.PeekQueue(tv.Id), null, retained: store.MissedQueueRows(tv)), g => g.Ids.Contains(501));
        Assert.Null(store.LeftQueueAt(tv, null, 501));
        // Complete paged reads resume without the row: the partial read was not a first miss.
        sonarr.ReportedTotal = null;
        sonarr.Queue.Add(FakeArr.SonarrQueueRow(502, "dl502", 1, 502));
        await Refresh(arr, store, tv);
        Assert.True(store.PeekQueue(tv.Id)!.Paged);
        Assert.False(store.PeekQueue(tv.Id)!.Incomplete);
        Assert.Null(store.LeftQueueAt(tv, null, 501));
        await Refresh(arr, store, tv);
        Assert.NotNull(store.LeftQueueAt(tv, null, 501));

        // A miss already established by a complete read still counts across a partial read.
        var (otherArr, otherSonarr, otherStore, otherTv) = await QueueOf(1001);
        using var otherLifetime = otherArr;
        otherSonarr.Queue.RemoveAll(r => (int)r["id"]! == 501);
        await Refresh(otherArr, otherStore, otherTv);
        Assert.Contains(otherStore.MissedQueueRows(otherTv), r => r.Id == 501);
        Assert.Null(otherStore.LeftQueueAt(otherTv, null, 501));
        otherSonarr.ReportedTotal = (path, count) => path == "/api/v3/queue" ? 1001 : count;
        otherArr.Now += ArrStateStore.QueueKeepHeld + TimeSpan.FromSeconds(1);
        await Refresh(otherArr, otherStore, otherTv);
        Assert.True(otherStore.PeekQueue(otherTv.Id)!.Incomplete);
        Assert.Null(otherStore.LeftQueueAt(otherTv, null, 501));
        otherSonarr.ReportedTotal = null;
        await Refresh(otherArr, otherStore, otherTv);
        Assert.NotNull(otherStore.LeftQueueAt(otherTv, null, 501));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task AnExpiredRetainedEpisodeCannotOverrideAJellyfinFileOrAFinishedImport(bool inJellyfin)
    {
        var (arr, sonarr, store, tv) = await QueueOf(501);
        using var lifetime = arr;
        sonarr.Series.Add(FakeArr.SeriesRow(1, 100, "Show"));
        var episode = FakeArr.Episode(501, "2020-01-01T00:00:00Z", tvdb: 100, episode: 501);
        episode["hasFile"] = true;
        sonarr.Episodes.Add(episode);
        var view = new FakeJellyfinView();
        var viewer = view.AddUser(admin: true);
        var item = Guid.NewGuid();
        view.AddItem(new JfItemRef { ItemId = item, Kind = "episode", Key = TitleKey.Parse("tv:tvdb:100:s1:e501"), Season = 1, Episode = 501, Virtual = !inJellyfin });
        var status = new ArrStatusService(store, view, new NoRequestFacts(), () => arr.Plugin.Plugin.Configuration, () => arr.Now);
        await status.ForItemAsync(viewer, item, default);
        sonarr.Queue.RemoveAt(500);
        sonarr.ReportedTotal = (path, count) => path == "/api/v3/queue" ? 501 : count;
        arr.Now += TimeSpan.FromMinutes(10) + TimeSpan.FromSeconds(1);
        await Refresh(arr, store, tv);
        Assert.Contains(store.MissedQueueState(tv).Expired, r => r.Id == 501);
        var body = await status.ForItemAsync(viewer, item, default);
        var row = Assert.Single(JsonDocument.Parse(body.Json).RootElement.GetProperty("items").EnumerateArray());
        Assert.Equal(inJellyfin ? "ready" : "almostReady", row.GetProperty("stage").GetString());
        Assert.Equal(inJellyfin ? "ready" : "library_pending", row.GetProperty("reason").GetProperty("code").GetString());
        Assert.False(row.TryGetProperty("progress", out _));
        Assert.Null(store.LeftQueueAt(tv, null, 501));
    }

    [Theory]
    [InlineData(true, true)]
    [InlineData(false, true)]
    [InlineData(false, false)]
    public async Task ShortFullHistoryReadsRetryThenPreserveTheRingAndLeaveAFullReadDue(bool recovers, bool seeded)
    {
        using var arr = Rig(out var radarr, out _);
        var now = arr.Now;
        for (var id = 1; id <= 3; id++) radarr.History.Add(FakeArr.HistoryRow(id, "downloadFolderImported", now.UtcDateTime.AddMinutes(-id), "dl" + id, id, "Movie"));
        var previous = seeded ? ArrStateLoaders.BuildHistory(new[] { new ArrHistoryEntry { Id = 99, Date = now.UtcDateTime.AddDays(-1) } }, null, now.AddHours(-2)) : null;
        var attempts = 0;
        radarr.BeforePage = (path, page) => { if (path == "/api/v3/history" && page == 1) attempts++; };
        radarr.ReportedTotal = (path, count) => path == "/api/v3/history" && (!recovers || attempts == 1) ? count + 1 : count;
        var client = arr.Factory.For(arr.Instance("Movies").Id).Value!;
        var result = await ArrStateLoaders.LoadHistoryAsync(client, previous, now, default);
        Assert.True(result.Ok);
        Assert.Equal(2, attempts);
        var history = result.Value!;
        Assert.Equal(recovers ? now : previous?.FullReadAt ?? now, history.FullReadAt);
        Assert.Equal(!recovers, history.FullReadDue);
        Assert.DoesNotContain("0001-01-01", JsonSerializer.Serialize(history), StringComparison.Ordinal);
        Assert.Equal(!recovers && seeded, history.Records.Any(r => r.Id == 99));
        radarr.ReportedTotal = null;
        var next = await ArrStateLoaders.LoadHistoryAsync(client, history, now.AddSeconds(30), default);
        Assert.True(next.Ok);
        Assert.Equal(recovers ? 2 : 3, attempts);
        Assert.Equal(recovers ? now : now.AddSeconds(30), next.Value!.FullReadAt);
        Assert.False(next.Value.FullReadDue);
        Assert.DoesNotContain(next.Value.Records, r => r.Id == 99);
    }

    [Fact]
    public async Task TheQueueIsReadPageByPageSoNoRowIsLostPastTheOldThousandRowLimit()
    {
        using var arr = Rig(out _, out var sonarr);
        for (var i = 1; i <= 1500; i++) sonarr.Queue.Add(FakeArr.SonarrQueueRow(i, "pack" + (i / 100), 1, i));
        var store = arr.Store();

        var read = await store.GetQueueAsync(arr.Instance("TV"), default);

        Assert.Equal(1500, read.Value!.Records.Count);
        Assert.Equal(1500, read.Value.TotalRecords);
        Assert.False(read.Value.Truncated);
        Assert.Equal(1500, read.Value.Records.Select(r => r.Id).Distinct().Count());
        // Explicit page size on every page (the arr's default is 10), three pages of 500.
        Assert.Equal(3, arr.CallCount("sonarr.lan", "/api/v3/queue"));
        Assert.All(arr.Calls.Where(c => c.Contains("/queue")), c => Assert.Contains("pageSize=500", c));
        Assert.Equal(1500, ArrLegacyViews.QueueItems(arr.Instance("TV"), read.Value).Count());
    }

    // C76 helpers: a Sonarr queue of n single-episode rows (one download each, ids = episode ids),
    // read once so the store holds a complete snapshot to compare against.
    private static async Task<(FakeArr Arr, FakeArr.Host Sonarr, ArrStateStore Store, ArrConnection Tv)> QueueOf(int n)
    {
        var arr = Rig(out _, out var sonarr);
        for (var i = 1; i <= n; i++) sonarr.Queue.Add(FakeArr.SonarrQueueRow(i, "dl" + i, 1, i));
        var store = arr.Store();
        var tv = arr.Instance("TV");
        Assert.Equal(Math.Min(n, ArrStateLoaders.QueueMaxRecords), (await store.GetQueueAsync(tv, default)).Value!.Records.Count);
        return (arr, sonarr, store, tv);
    }

    private static async Task Refresh(FakeArr arr, ArrStateStore store, ArrConnection instance)
    {
        store.RequestRefresh(instance.Id, ArrSnapshotKind.Queue);
        arr.Now += TimeSpan.FromSeconds(3);
        await Task.WhenAll(store.Tick());
        await Settle(store);
    }

    // The last row moves to the front (its time left dropped) between page 1 and page 2: page 2
    // starts with a row page 1 already gave, and the moved row is on no page.
    private static void MoveLastToFront(FakeArr.Host host)
    {
        var last = host.Queue[^1];
        host.Queue.RemoveAt(host.Queue.Count - 1);
        host.Queue.Insert(0, last);
    }

    [Fact]
    public async Task ARowMovingAcrossThePageBoundaryIsReadAgainNotTakenForADeparture()
    {
        var (arr, sonarr, store, tv) = await QueueOf(501);
        using var _ = arr;
        var moves = 0;
        sonarr.BeforePage = (path, page) => { if (page == 2 && moves++ == 0) MoveLastToFront(sonarr); };
        var queueCalls = arr.CallCount("sonarr.lan", "/api/v3/queue");

        await Refresh(arr, store, tv);

        var read = await store.GetQueueAsync(tv, default);
        Assert.Null(read.Error);
        Assert.Equal(501, read.Value!.Records.Select(r => r.Id).Distinct().Count());
        Assert.Contains(read.Value.Records, r => r.Id == 501);
        Assert.Null(store.LeftQueueAt(tv, null, 501));
        // The short read (pages 1, 2 and the arr's "past the end" answer) and one more read.
        Assert.True(arr.CallCount("sonarr.lan", "/api/v3/queue") - queueCalls >= 4);
    }

    [Fact]
    public async Task AShortQueuesRetryReadIsOwnedAndCancelledAtShutdown()
    {
        var (arr, sonarr, store, tv) = await QueueOf(501);
        using var rig = arr;
        var complete = store.PeekQueue(tv.Id);
        var pages = 0;
        sonarr.BeforePage = (path, page) => { if (page == 2) MoveLastToFront(sonarr); };
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var cancelled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        sonarr.Before = async (path, ct) =>
        {
            if (path != "/api/v3/queue" || Interlocked.Increment(ref pages) <= 3) return;
            // The first pass stops when page 2 adds no id. Hold page 2 of its retry.
            using var registration = ct.Register(() => cancelled.TrySetResult());
            entered.TrySetResult();
            await Task.Delay(Timeout.Infinite, ct);
        };
        var refresh = store.RefreshForEventAsync(tv.Id, ArrSnapshotKind.Queue, force: true);
        try
        {
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            await store.StopAsync().WaitAsync(TimeSpan.FromSeconds(5));
            await cancelled.Task.WaitAsync(TimeSpan.FromSeconds(5));
            await refresh.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.Same(complete, store.PeekQueue(tv.Id));
            Assert.Null(store.LeftQueueAt(tv, null, 501));
            var reads = pages;
            await store.RefreshForEventAsync(tv.Id, ArrSnapshotKind.Queue, force: true);
            Assert.Equal(reads, pages);
            store.Dispose();
        }
        finally
        {
            await store.StopAsync().WaitAsync(TimeSpan.FromSeconds(5));
        }
    }

    [Fact]
    public async Task APersistentlyShortQueueReadKeepsTheLastCompleteSnapshotQuietlyAndRecordsNoDeparture()
    {
        var (arr, sonarr, store, tv) = await QueueOf(501);
        using var _ = arr;
        var before = await store.GetQueueAsync(tv, default);
        var changes = new List<ArrSnapshotChange>();
        store.SnapshotChanged += c => { if (c.Kind == ArrSnapshotKind.Queue) lock (changes) changes.Add(c); };
        sonarr.BeforePage = (path, page) => { if (page == 2) MoveLastToFront(sonarr); };
        arr.Now += TimeSpan.FromMinutes(1);

        await Refresh(arr, store, tv);

        // The arr answered: no error (no "can't be read" row, no legacy error entry, no admin alert),
        // the complete read is kept with its own age, and nothing changed. A page reading it now
        // doesn't start another read (it was checked just now).
        var calls = arr.CallCount("sonarr.lan", "/api/v3/queue");
        var read = await store.GetQueueAsync(tv, default);
        await Settle(store);
        Assert.Equal(calls, arr.CallCount("sonarr.lan", "/api/v3/queue"));
        Assert.Null(read.Error);
        Assert.Same(before.Value, read.Value);
        Assert.Equal(before.LoadedAt, read.LoadedAt);
        Assert.True(read.Stale);
        Assert.Empty(changes);
        for (var id = 1; id <= 501; id++) Assert.Null(store.LeftQueueAt(tv, null, id));
        var queueSlot = store.Describe().Instances.Single(i => i.Name == "TV").Snapshots.Single(x => x.Kind == ArrSnapshotKind.Queue);
        Assert.Equal((0L, (ArrSlotError?)null), (queueSlot.FailedRefreshes, queueSlot.LastError));
        // Download groups (the admin hub's ids) still come from the complete read.
        var groups = Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.NeedsAttention.Group(tv, store.PeekQueue(tv.Id), null);
        Assert.Equal(501, groups.Sum(g => g.Ids.Count));

        // No backoff, and no re-read at once either: the next read comes at the normal interval.
        await Task.WhenAll(store.Tick());
        Assert.Equal(calls, arr.CallCount("sonarr.lan", "/api/v3/queue"));
        arr.Now += TimeSpan.FromSeconds(31);
        await Task.WhenAll(store.Tick());
        await Settle(store);
        Assert.True(arr.CallCount("sonarr.lan", "/api/v3/queue") > calls);
        Assert.Same(before.Value, store.PeekQueue(tv.Id));

        // Still changing once the kept read is QueueKeepHeld old: the incomplete read is shown (its
        // rows are live), still with no departure, and the baseline still holds every row.
        arr.Now += ArrStateStore.QueueKeepHeld;
        await Refresh(arr, store, tv);
        read = await store.GetQueueAsync(tv, default);
        Assert.Null(read.Error);
        Assert.True(read.Value!.Incomplete);
        Assert.Equal(500, read.Value.Records.Count);
        Assert.NotEmpty(changes);
        for (var id = 1; id <= 501; id++) Assert.Null(store.LeftQueueAt(tv, null, id));
        // A later incomplete read replaces an incomplete one.
        var incomplete = read.Value;
        arr.Now += TimeSpan.FromMinutes(1);
        await Refresh(arr, store, tv);
        Assert.NotSame(incomplete, store.PeekQueue(tv.Id));

        // The queue settles: the next read is complete again; still no row counts as having left.
        sonarr.BeforePage = null;
        arr.Now += TimeSpan.FromMinutes(1);
        await Refresh(arr, store, tv);
        read = await store.GetQueueAsync(tv, default);
        Assert.Null(read.Error);
        Assert.False(read.Value!.Incomplete);
        Assert.Equal(501, read.Value.Records.Count);
        for (var id = 1; id <= 501; id++) Assert.Null(store.LeftQueueAt(tv, null, id));
    }

    [Fact]
    public async Task AColdQueueReadThatStaysShortStillServesItsRowsWithNoError()
    {
        using var arr = Rig(out _, out var sonarr);
        for (var i = 1; i <= 501; i++) sonarr.Queue.Add(FakeArr.SonarrQueueRow(i, "dl" + i, 1, i));
        sonarr.BeforePage = (path, page) => { if (page == 2) MoveLastToFront(sonarr); };
        var store = arr.Store();
        var tv = arr.Instance("TV");

        var read = await store.GetQueueAsync(tv, default);

        Assert.Null(read.Error);
        Assert.True(read.Value!.Incomplete);
        Assert.Equal(500, read.Value.Records.Select(r => r.Id).Distinct().Count());
        // The legacy Downloads route lists them, with no error entry (it adds one only for read.Error).
        Assert.Equal(500, ArrLegacyViews.QueueItems(tv, read.Value).Count());

        // The first complete read after it finds no departure for the row the cold read missed.
        sonarr.BeforePage = null;
        await Refresh(arr, store, tv);
        Assert.False(store.PeekQueue(tv.Id)!.Incomplete);
        for (var id = 1; id <= 501; id++) Assert.Null(store.LeftQueueAt(tv, null, id));
    }

    [Fact]
    public async Task AQueueShrinkingWhileReadRecordsOnlyTheRowThatReallyLeft()
    {
        var (arr, sonarr, store, tv) = await QueueOf(1001);
        using var _ = arr;
        var removed = 0;
        // Row 1 imports between page 1 and page 2: every later row moves up one place, so row 501
        // slips from page 2 onto page 1, which was already read.
        sonarr.BeforePage = (path, page) => { if (page == 2 && removed++ == 0) sonarr.Queue.RemoveAt(0); };

        await Refresh(arr, store, tv);

        var read = await store.GetQueueAsync(tv, default);
        Assert.Null(read.Error);
        Assert.Equal(1000, read.Value!.Records.Count);
        Assert.Equal(1000, read.Value.TotalRecords);
        Assert.Null(store.LeftQueueAt(tv, null, 1));
        Assert.Null(store.LeftQueueAt(tv, null, 501));

        sonarr.BeforePage = null;
        await Refresh(arr, store, tv);
        Assert.NotNull(store.LeftQueueAt(tv, null, 1));
        Assert.Null(store.LeftQueueAt(tv, null, 501));

        // A queue that now fits in one page records departures at once; row 501 still downloads.
        sonarr.Queue.RemoveAll(r => (int)r["id"]! < 992 && (int)r["id"]! != 501);
        await Refresh(arr, store, tv);
        Assert.False(store.PeekQueue(tv.Id)!.Paged);
        Assert.NotNull(store.LeftQueueAt(tv, null, 2));
        Assert.Null(store.LeftQueueAt(tv, null, 501));
        Assert.Null(store.LeftQueueAt(tv, null, 1001));
    }

    [Fact]
    public async Task MoreDistinctRowsThanTheReportedTotalAreAccepted()
    {
        var (arr, sonarr, store, tv) = await QueueOf(600);
        using var _ = arr;
        var added = 0;
        // A grab lands between the pages, but every page still reports 600 rows.
        sonarr.ReportedTotal = (_, _) => 600;
        sonarr.BeforePage = (path, page) => { if (page == 2 && added++ == 0) sonarr.Queue.Add(FakeArr.SonarrQueueRow(601, "dl601", 1, 601)); };

        await Refresh(arr, store, tv);

        var read = await store.GetQueueAsync(tv, default);
        Assert.Null(read.Error);
        Assert.Equal(601, read.Value!.Records.Count);
        Assert.Equal(600, read.Value.TotalRecords);
        Assert.True(read.Value.Records.Count > read.Value.TotalRecords);
        Assert.False(read.Value.Incomplete);
        Assert.False(read.Value.Truncated);
    }

    /// <summary>A count-preserving queue change cannot prove a missed row left the queue.</summary>
    [Fact]
    public async Task ARowMissedWhileTheQueueChurnsBetweenPagesIsNotTakenForADeparture()
    {
        var (arr, sonarr, store, tv) = await QueueOf(1001);
        using var _ = arr;
        var moved = false;
        sonarr.BeforePage = (path, page) =>
        {
            if (path != "/api/v3/queue" || page != 2 || moved) return;
            moved = true;
            sonarr.Queue.RemoveAt(0);
            sonarr.Queue.Add(FakeArr.SonarrQueueRow(1002, "dl1002", 1, 1002));
        };

        await Refresh(arr, store, tv);

        var read = await store.GetQueueAsync(tv, default);
        Assert.Null(read.Error);
        Assert.False(read.Value!.Incomplete);
        Assert.False(read.Value.Truncated);
        Assert.True(read.Value.Paged);
        Assert.Equal(1001, read.Value.TotalRecords);
        Assert.Equal(1001, read.Value.Records.Count);
        Assert.DoesNotContain(read.Value.Records, r => r.Id == 501);
        Assert.Contains(read.Value.Records, r => r.Id == 1);
        Assert.Null(store.LeftQueueAt(tv, null, 501));
        Assert.Null(store.LeftQueueAt(tv, null, 1));

        sonarr.BeforePage = null;
        arr.Now += TimeSpan.FromMinutes(1);
        await Refresh(arr, store, tv);
        Assert.Contains(store.PeekQueue(tv.Id)!.Records, r => r.Id == 501);
        Assert.Null(store.LeftQueueAt(tv, null, 501));
        // Page 1 still held row 1 when it imported, so this is the first read that lacks it.
        Assert.Null(store.LeftQueueAt(tv, null, 1));
        await Refresh(arr, store, tv);
        Assert.Null(store.LeftQueueAt(tv, null, 501));
        Assert.NotNull(store.LeftQueueAt(tv, null, 1));
    }

    [Fact]
    public async Task ARowAKeptShortReadShowedIsNotTakenForADepartureByTheNextChurnedRead()
    {
        var (arr, sonarr, store, tv) = await QueueOf(1001);
        using var _ = arr;
        // Read N: complete by count and paged, but row 501 slid onto page 1 unseen: a suspect.
        var churned = false;
        sonarr.BeforePage = (path, page) =>
        {
            if (path != "/api/v3/queue" || page != 2 || churned) return;
            churned = true;
            sonarr.Queue.RemoveAt(0);
            sonarr.Queue.Add(FakeArr.SonarrQueueRow(1002, "dl1002", 1, 1002));
        };
        await Refresh(arr, store, tv);
        var held = store.PeekQueue(tv.Id)!;
        Assert.True(held.Paged);
        Assert.False(held.Incomplete);
        Assert.DoesNotContain(held.Records, r => r.Id == 501);
        Assert.Equal(new[] { 501 }, store.MissedQueueRows(tv).Select(r => r.Id).ToArray());
        Assert.Null(store.LeftQueueAt(tv, null, 501));

        // Read N+1 (within QueueKeepHeld): short on both attempts, so it is kept behind N and not
        // published. It holds row 501: still in the queue.
        sonarr.BeforePage = (path, page) => { if (page == 2) MoveLastToFront(sonarr); };
        await Refresh(arr, store, tv);
        Assert.Same(held, store.PeekQueue(tv.Id));
        Assert.Null(store.LeftQueueAt(tv, null, 501));

        // Read N+2: complete and paged, and the queue churns at the boundary again so row 501 is
        // missed again. Seen in between, this is a first miss, not the second in a row.
        sonarr.BeforePage = null;
        sonarr.Queue.Sort((a, b) => ((int)a!["id"]!).CompareTo((int)b!["id"]!));
        var e = sonarr.Queue.Single(r => (int)r["id"]! == 501);
        sonarr.Queue.Remove(e);
        sonarr.Queue.Insert(500, e);
        churned = false;
        sonarr.BeforePage = (path, page) =>
        {
            if (path != "/api/v3/queue" || page != 2 || churned) return;
            churned = true;
            sonarr.Queue.RemoveAt(0);
            sonarr.Queue.Add(FakeArr.SonarrQueueRow(1003, "dl1003", 1, 1003));
        };
        await Refresh(arr, store, tv);
        var read = store.PeekQueue(tv.Id)!;
        Assert.NotSame(held, read);
        Assert.True(read.Paged);
        Assert.False(read.Incomplete);
        Assert.DoesNotContain(read.Records, r => r.Id == 501);
        Assert.Null(store.LeftQueueAt(tv, null, 501));
        Assert.Contains(store.MissedQueueRows(tv), r => r.Id == 501);

        // It really leaves: the next complete read lacking it counts it gone.
        sonarr.BeforePage = null;
        sonarr.Queue.Remove(e);
        await Refresh(arr, store, tv);
        Assert.NotNull(store.LeftQueueAt(tv, null, 501));
        Assert.DoesNotContain(store.MissedQueueRows(tv), r => r.Id == 501);
    }

    [Fact]
    public async Task AQueueCutAtTheRowCapRecordsNoDepartures()
    {
        var cap = ArrStateLoaders.QueueMaxRecords;
        var (arr, sonarr, store, tv) = await QueueOf(cap + 1);
        using var _ = arr;
        Assert.True(store.PeekQueue(tv.Id)!.Truncated);

        // The last row the cap let in drops to the end, past the cap: it is still in the queue.
        var row = sonarr.Queue[cap - 1];
        sonarr.Queue.RemoveAt(cap - 1);
        sonarr.Queue.Add(row);
        await Refresh(arr, store, tv);

        Assert.True(store.PeekQueue(tv.Id)!.Truncated);
        Assert.DoesNotContain(store.PeekQueue(tv.Id)!.Records, r => r.Id == cap);
        Assert.Null(store.LeftQueueAt(tv, null, cap));

        // A complete read afterwards may compare against the cut one: what left it really left.
        sonarr.Queue.RemoveRange(0, sonarr.Queue.Count - 10);
        arr.Now += TimeSpan.FromMinutes(1);
        await Refresh(arr, store, tv);
        Assert.False(store.PeekQueue(tv.Id)!.Truncated);
        Assert.NotNull(store.LeftQueueAt(tv, null, 1));
    }

    [Fact]
    public async Task ARowHiddenPastTheRowCapIsStillFoundLeavingByTheNextCompleteRead()
    {
        var cap = ArrStateLoaders.QueueMaxRecords;
        var (arr, sonarr, store, tv) = await QueueOf(cap);
        using var _ = arr;
        Assert.False(store.PeekQueue(tv.Id)!.Truncated);
        var e = sonarr.Queue[^1];
        var eId = (int)e["id"]!;

        // A new download sorts first: E is pushed past the cap, still in the queue.
        sonarr.Queue.Insert(0, FakeArr.SonarrQueueRow(cap + 1, "dl-new", 1, cap + 1));
        await Refresh(arr, store, tv);
        Assert.True(store.PeekQueue(tv.Id)!.Truncated);
        Assert.DoesNotContain(store.PeekQueue(tv.Id)!.Records, r => r.Id == eId);
        Assert.Null(store.LeftQueueAt(tv, null, eId));

        // The queue stays over the cap for more reads: the baseline holds the distinct rows seen
        // (cap + 1), well within its limit, so E is kept rather than the baseline starting over.
        for (var n = 0; n < 3; n++)
        {
            arr.Now += TimeSpan.FromMinutes(1);
            await Refresh(arr, store, tv);
            Assert.True(store.PeekQueue(tv.Id)!.Truncated);
            Assert.Null(store.LeftQueueAt(tv, null, eId));
        }

        // E imports: the queue is back to the cap. Two complete paged reads establish it left.
        sonarr.Queue.Remove(e);
        arr.Now += TimeSpan.FromMinutes(1);
        await Refresh(arr, store, tv);
        Assert.False(store.PeekQueue(tv.Id)!.Truncated);
        Assert.Null(store.LeftQueueAt(tv, null, eId));
        Assert.Null(store.LeftQueueAt(tv, null, cap + 1));
        Assert.Null(store.LeftQueueAt(tv, null, 1));
        await Refresh(arr, store, tv);
        Assert.NotNull(store.LeftQueueAt(tv, null, eId));
        Assert.Null(store.LeftQueueAt(tv, null, cap + 1));
        Assert.Null(store.LeftQueueAt(tv, null, 1));
    }

    [Fact]
    public async Task WarmSnapshotsAreServedWithZeroUpstreamCallsPerRequest()
    {
        using var arr = Rig(out var radarr, out var sonarr);
        radarr.Queue.Add(FakeArr.RadarrQueueRow(1, 45745, "Sintel"));
        sonarr.Queue.Add(FakeArr.SonarrQueueRow(1, "a", 1, 1));
        var store = arr.Store();
        var instances = new[] { arr.Instance("Movies"), arr.Instance("TV") };

        using (var first = store.BeginRequest("arr/queue"))
        {
            foreach (var i in instances) Assert.NotNull((await store.GetQueueAsync(i, default)).Value);
            Assert.Equal(0, first.UpstreamCalls);      // the cold load ran in the background...
            Assert.True(first.Waited);                // ...and the request waited for it
        }

        var callsBefore = arr.Transport.Calls;
        for (var n = 0; n < 20; n++)
        {
            arr.Now = arr.Now.AddSeconds(1);
            using var scope = store.BeginRequest("arr/queue");
            foreach (var i in instances)
            {
                var read = await store.GetQueueAsync(i, default);
                Assert.Single(read.Value!.Records);
                Assert.False(read.Stale);
            }
            Assert.Equal(0, scope.UpstreamCalls);
            Assert.False(scope.Waited);
        }
        Assert.Equal(callsBefore, arr.Transport.Calls);
        var stats = store.Describe().Routes["arr/queue"];
        Assert.Equal(21, stats.Requests);
        Assert.Equal(0, stats.RequestsWithUpstreamCalls);
        Assert.Equal(0, stats.UpstreamCalls);
        Assert.Equal(1, stats.RequestsThatWaitedForALoad);
    }

    [Fact]
    public async Task AStaleSnapshotIsServedAtOnceWhileABackgroundRefreshReplacesIt()
    {
        using var arr = Rig(out var radarr, out _);
        radarr.Queue.Add(FakeArr.RadarrQueueRow(1, 1, "Old"));
        var store = arr.Store();
        var movies = arr.Instance("Movies");
        await store.GetQueueAsync(movies, default);

        radarr.Queue.Clear();
        radarr.Queue.Add(FakeArr.RadarrQueueRow(2, 2, "New"));
        arr.Now = arr.Now.AddSeconds(40);   // past the 30 s poll interval + slack
        using (var scope = store.BeginRequest("arr/queue"))
        {
            var stale = await store.GetQueueAsync(movies, default);
            Assert.True(stale.Stale);
            Assert.Equal("Old", stale.Value!.Records[0].Title);
            Assert.False(scope.Waited);
        }
        await Settle(store);
        var fresh = await store.GetQueueAsync(movies, default);
        Assert.Equal("New", fresh.Value!.Records[0].Title);
        Assert.False(fresh.Stale);
        Assert.Equal(0, store.Describe().Routes["arr/queue"].UpstreamCalls);
        Assert.True(store.BackgroundCalls > 0);
    }

    [Fact]
    public async Task AUrlAnsweringAsTheWrongAppIsReportedInsteadOfParsed()
    {
        using var arr = Rig(out var radarr, out _);
        radarr.App = "Sonarr";     // a Sonarr URL in a Radarr row
        radarr.Queue.Add(FakeArr.SonarrQueueRow(1, "a", 1, 1));
        var store = arr.Store();

        var read = await store.GetQueueAsync(arr.Instance("Movies"), default);

        Assert.Null(read.Value);
        Assert.Equal(ArrErrorKind.WrongApp, read.Error!.Kind);
        Assert.Equal("wrong app at this URL", ArrLegacyViews.ShortReason(read.Error));
        Assert.Equal(0, arr.CallCount("radarr.lan", "/api/v3/queue"));
    }

    [Fact]
    public async Task ARedirectIsNotFollowedAndIsReportedTheSameWayAsTheTestButtonDoes()
    {
        using var arr = Rig(out var radarr, out _);
        radarr.RedirectTo = "http://elsewhere.lan/api/v3/system/status";
        var store = arr.Store();

        var read = await store.GetLibraryAsync(arr.Instance("Movies"), default);

        Assert.Equal(ArrErrorKind.Redirect, read.Error!.Kind);
        Assert.StartsWith("redirect not followed", ArrLegacyViews.ShortReason(read.Error));
        Assert.DoesNotContain(arr.Calls, c => c.StartsWith("elsewhere.lan", StringComparison.Ordinal));
    }

    [Fact]
    public async Task AFailingInstanceBacksOffInsteadOfBeingCalledOnEveryRequest()
    {
        using var arr = Rig(out var radarr, out _);
        radarr.FailWith = 401;
        var store = arr.Store();
        var movies = arr.Instance("Movies");

        var first = await store.GetQueueAsync(movies, default);
        Assert.Equal(ArrErrorKind.Unauthorized, first.Error!.Kind);
        Assert.Equal("authentication failed (401)", ArrLegacyViews.ShortReason(first.Error));
        var calls = arr.CallCount("radarr.lan");
        for (var i = 0; i < 5; i++)
        {
            arr.Now = arr.Now.AddSeconds(1);
            Assert.NotNull((await store.GetQueueAsync(movies, default)).Error);
        }
        Assert.Equal(calls, arr.CallCount("radarr.lan"));   // within the 15 s backoff: no new attempt

        radarr.FailWith = 0;
        arr.Now = arr.Now.AddSeconds(20);
        await Task.WhenAll(store.Tick());
        var recovered = await store.GetQueueAsync(movies, default);
        Assert.Null(recovered.Error);
        Assert.NotNull(recovered.Value);
        // One log line when it started failing and one when it recovered, not one per attempt.
        var log = File.ReadAllText(arr.Plugin.Core.Logger.CurrentLogFilePath);
        Assert.Equal(1, log.Split("Movies queue can't be read (Unauthorized").Length - 1);
        Assert.Equal(1, log.Split("Movies queue can be read again").Length - 1);
    }

    [Fact]
    public async Task ARecordWrittenInTheSameSecondAsTheNewestOneReadIsNotLost()
    {
        using var arr = Rig(out var radarr, out _);
        var t0 = arr.Now.UtcDateTime.AddMinutes(-5);
        radarr.History.Add(FakeArr.HistoryRow(1, "downloadFolderImported", t0, "d1", 10, "Movie A"));
        var store = arr.Store();
        var movies = arr.Instance("Movies");
        await store.GetHistoryAsync(movies, default);
        // A season's episodes are imported in the same second; this one was written after the read.
        radarr.History.Add(FakeArr.HistoryRow(2, "downloadFolderImported", t0, "d2", 11, "Movie B"));
        await store.RefreshForEventAsync(movies.Id, ArrSnapshotKind.History, force: true);
        Assert.Equal(new[] { 1, 2 }, store.PeekHistory(movies.Id)!.Records.Select(r => r.Id).OrderBy(i => i));
    }

    [Fact]
    public async Task HistoryCatchesUpWithHistorySinceAndKeepsAnErrorOnceTheInstanceFails()
    {
        using var arr = Rig(out var radarr, out _);
        var t0 = arr.Now.UtcDateTime;
        radarr.History.Add(FakeArr.HistoryRow(1, "grabbed", t0.AddMinutes(-10), "d1", 10, "Movie A"));
        radarr.History.Add(FakeArr.HistoryRow(2, "downloadFolderImported", t0.AddMinutes(-5), "d1", 10, "Movie A"));
        var store = arr.Store();
        var movies = arr.Instance("Movies");

        var first = await store.GetHistoryAsync(movies, default);
        Assert.Equal(new[] { 2, 1 }, first.Value!.Records.Select(r => r.Id));
        Assert.Equal(1, arr.CallCount("radarr.lan", "/api/v3/history?"));

        radarr.History.Add(FakeArr.HistoryRow(3, "downloadFailed", t0.AddMinutes(1), "d2", 11, "Movie B"));
        arr.Now = arr.Now.AddMinutes(6);    // nothing downloading and no page polling: refreshed every 5 minutes
        await Task.WhenAll(store.Tick());
        var second = await store.GetHistoryAsync(movies, default);
        Assert.Equal(new[] { 3, 2, 1 }, second.Value!.Records.Select(r => r.Id));    // merged, no duplicate of 2
        Assert.Equal(1, arr.CallCount("radarr.lan", "/api/v3/history/since"));
        // From a second before the newest record held (the arrs answer only records strictly after "date").
        Assert.Contains(arr.Calls, c => c.Contains("/history/since?date=2026-10-12T11%3A54%3A59"));
        var items = ArrLegacyViews.HistoryItems(movies, second.Value);
        Assert.Equal(new[] { "failed", "imported" }, items.Select(i => i.EventType));    // grabbed is not shown

        radarr.FailWith = 500;
        arr.Now = arr.Now.AddMinutes(6);
        await Task.WhenAll(store.Tick());
        var failing = await store.GetHistoryAsync(movies, default);
        Assert.NotNull(failing.Value);                 // last good history still there...
        Assert.Equal(ArrErrorKind.Server, failing.Error!.Kind);   // ...with the failure reported
    }

    [Fact]
    public async Task HistoryIsReadInFullAgainEveryHourSoRecordsTheArrDeletedGoAway()
    {
        using var arr = Rig(out var radarr, out _);
        var t0 = arr.Now.UtcDateTime;
        radarr.History.Add(FakeArr.HistoryRow(1, "downloadFolderImported", t0.AddMinutes(-30), "a", 10, "Deleted later"));
        radarr.History.Add(FakeArr.HistoryRow(2, "downloadFolderImported", t0.AddMinutes(-20), "b", 11, "Kept"));
        var store = arr.Store();
        var movies = arr.Instance("Movies");
        Assert.Equal(2, (await store.GetHistoryAsync(movies, default)).Value!.Records.Count);

        radarr.History.RemoveAt(0);          // the title was deleted in Radarr, with its history
        arr.Now = arr.Now.AddMinutes(6);
        await Task.WhenAll(store.Tick());
        Assert.Equal(2, (await store.GetHistoryAsync(movies, default)).Value!.Records.Count);   // since-reads only add

        arr.Now = arr.Now.AddMinutes(60);
        await store.GetHistoryAsync(movies, default);    // read within the interest window keeps it refreshing
        await Task.WhenAll(store.Tick());
        var after = await store.GetHistoryAsync(movies, default);
        Assert.Equal(new[] { 2 }, after.Value!.Records.Select(r => r.Id));
        Assert.Equal(2, arr.CallCount("radarr.lan", "/api/v3/history?"));
    }

    [Fact]
    public void SonarrHistoryRecordsOfOneSeasonPackBecomeOneItem()
    {
        var t = new DateTime(2026, 10, 1, 0, 0, 0, DateTimeKind.Utc);
        var history = ArrStateLoaders.BuildHistory(new[]
        {
            ArrStateLoaders.ToHistoryEntry(JsonSerializer.Deserialize<ArrWireHistoryRecord>(FakeArr.HistoryRow(1, "downloadFolderImported", t, "pack", 5, "Show", 1, 1).ToJsonString(), ArrClient.JsonOptions)!),
            ArrStateLoaders.ToHistoryEntry(JsonSerializer.Deserialize<ArrWireHistoryRecord>(FakeArr.HistoryRow(2, "downloadFolderImported", t.AddSeconds(1), "pack", 5, "Show", 1, 2).ToJsonString(), ArrClient.JsonOptions)!),
            ArrStateLoaders.ToHistoryEntry(JsonSerializer.Deserialize<ArrWireHistoryRecord>(FakeArr.HistoryRow(3, "downloadFailed", t.AddSeconds(2), "pack", 5, "Show", 1, 3).ToJsonString(), ArrClient.JsonOptions)!),
            ArrStateLoaders.ToHistoryEntry(JsonSerializer.Deserialize<ArrWireHistoryRecord>(FakeArr.HistoryRow(4, "downloadFolderImported", t.AddSeconds(3), null, 5, "Show", 2, 7).ToJsonString(), ArrClient.JsonOptions)!),
        }, null, DateTimeOffset.UtcNow);
        var sonarr = new ArrConnection { Id = "x", Kind = ArrKind.Sonarr, Name = "TV" };

        var items = ArrLegacyViews.HistoryItems(sonarr, history);

        Assert.Equal(2, items.Count);
        Assert.Equal("S02E07 - Ep 7", items[0].Subtitle);
        Assert.Null(items[0].EpisodeCount);
        Assert.Equal("partial", items[1].EventType);
        Assert.Equal("S01 · E01-E03", items[1].Subtitle);
        Assert.Equal((3, 2, 1), (items[1].EpisodeCount, items[1].ImportedCount, items[1].FailedCount));
        Assert.DoesNotContain("episodeCount", JsonSerializer.Serialize(items[0]));
    }

    [Fact]
    public async Task CalendarRangesInsideTheWindowNeedNoCallAndOthersAreReadOnceThenKept()
    {
        using var arr = Rig(out _, out var sonarr);
        sonarr.Calendar.Add(FakeArr.Episode(1, "2026-10-20T20:00:00Z"));
        sonarr.Calendar.Add(FakeArr.Episode(2, "2026-11-30T20:00:00Z", episode: 2));
        var store = arr.Store();
        var tv = arr.Instance("TV");
        var start = new DateTime(2026, 10, 12, 0, 0, 0, DateTimeKind.Utc);

        var inWindow = await store.GetCalendarAsync(tv, start, start.AddDays(30), default);
        var events = ArrLegacyViews.CalendarItems(tv, inWindow.Value!, start, start.AddDays(30)).ToList();
        Assert.Equal("sonarr|" + tv.Id + "|1", Assert.Single(events).Id);       // filtered to the range server-side; ids are per instance
        Assert.Equal("S01E01 - Ep 1", events[0].Subtitle);
        Assert.Equal((tv.Id, "/data/tv/Show"), (events[0].InstanceId, events[0].ArrPath));
        var windowCalls = arr.CallCount("sonarr.lan", "/api/v3/calendar");
        // From the day before the first of last month (today − 35 d would be 2026-09-07).
        Assert.Contains(arr.Calls, c => c.Contains("/calendar?") && c.Contains("start=2026-08-31"));

        using (var scope = store.BeginRequest("arr/calendar"))
        {
            for (var i = 0; i < 5; i++) await store.GetCalendarAsync(tv, start.AddDays(i), start.AddDays(i + 7), default);
            Assert.Equal(0, scope.UpstreamCalls);
        }
        Assert.Equal(windowCalls, arr.CallCount("sonarr.lan", "/api/v3/calendar"));

        // The Calendar page's previous month (local midnight on the 1st, up to UTC+14) is in the window.
        using (var scope = store.BeginRequest("arr/calendar"))
        {
            var previous = await store.GetCalendarAsync(tv, new DateTime(2026, 8, 31, 10, 0, 0, DateTimeKind.Utc), new DateTime(2026, 9, 30, 23, 59, 59, DateTimeKind.Utc), default);
            Assert.NotNull(previous.Value);
            Assert.Equal(0, scope.UpstreamCalls);
        }
        Assert.Equal(windowCalls, arr.CallCount("sonarr.lan", "/api/v3/calendar"));

        // A month two years back is outside the window: read once in the background (the request
        // waits for it but makes no call itself), by whole month, then kept.
        var past = new DateTime(2024, 3, 1, 0, 0, 0, DateTimeKind.Utc);
        var background = store.BackgroundCalls;
        using (var scope = store.BeginRequest("arr/calendar"))
        {
            Assert.NotNull((await store.GetCalendarAsync(tv, past.AddDays(3), past.AddDays(10), default)).Value);
            Assert.Equal(0, scope.UpstreamCalls);
            Assert.True(scope.Waited);
        }
        Assert.True(store.BackgroundCalls > background);
        Assert.Contains(arr.Calls, c => c.Contains("/calendar?") && c.Contains("start=2024-03-01") && c.Contains("end=2024-03-31"));
        var pastCalls = arr.CallCount("sonarr.lan", "/api/v3/calendar");
        using (var scope = store.BeginRequest("arr/calendar"))
        {
            await store.GetCalendarAsync(tv, past.AddHours(1), past.AddDays(30), default);
            Assert.Equal(0, scope.UpstreamCalls);
        }
        Assert.Equal(pastCalls, arr.CallCount("sonarr.lan", "/api/v3/calendar"));
    }

    [Fact]
    public async Task MonthsOutsideTheWindowAreBoundedCappedCancelledWhenAbandonedAndBackedOffAfterFailing()
    {
        using var arr = Rig(out _, out var sonarr);
        var store = arr.Store();
        store.RangeWait = TimeSpan.FromMilliseconds(200);
        var tv = arr.Instance("TV");
        var release = new TaskCompletionSource();
        var held = 0;
        var cancelled = 0;
        sonarr.Before = async (path, ct) =>
        {
            if (path != "/api/v3/calendar") return;
            Interlocked.Increment(ref held);
            try
            {
                await release.Task.WaitAsync(ct);
            }
            catch (OperationCanceledException)
            {
                Interlocked.Increment(ref cancelled);
                throw;
            }
        };
        DateTime Month(int year, int month, int day = 1) => new(year, month, day, 0, 0, 0, DateTimeKind.Utc);

        // A hung instance: the request gives up after the bounded wait, the read keeps running.
        var slow = await store.GetCalendarAsync(tv, Month(2024, 1, 10), Month(2024, 1, 20), default);
        Assert.Equal(ArrErrorKind.Timeout, slow.Error!.Kind);
        Assert.Equal(ArrErrorKind.Timeout, (await store.GetCalendarAsync(tv, Month(2024, 1), Month(2024, 1, 31), default)).Error!.Kind);
        Assert.Equal(1, held);                                    // same month: joined, not read again
        await store.GetCalendarAsync(tv, Month(2024, 2), Month(2024, 2, 28), default);
        Assert.Equal(2, held);
        // Two reads per instance at most: a third month is refused instead of queueing another read.
        var busy = await store.GetCalendarAsync(tv, Month(2024, 3), Month(2024, 3, 31), default);
        Assert.Equal(ArrErrorKind.Timeout, busy.Error!.Kind);
        Assert.Equal(2, held);

        release.SetResult();
        Assert.NotNull((await store.GetCalendarAsync(tv, Month(2024, 1), Month(2024, 1, 31), default)).Value);
        Assert.NotNull((await store.GetCalendarAsync(tv, Month(2024, 2), Month(2024, 2, 28), default)).Value);

        // A read whose only request was abandoned is stopped.
        release = new TaskCompletionSource();
        using (var abandon = new CancellationTokenSource())
        {
            var pending = store.GetCalendarAsync(tv, Month(2023, 6), Month(2023, 6, 30), abandon.Token);
            for (var i = 0; i < 200 && held < 3; i++) await Task.Delay(10);
            abandon.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pending);
        }
        for (var i = 0; i < 200 && cancelled == 0; i++) await Task.Delay(10);
        Assert.Equal(1, cancelled);

        // A failed month is not read again on every request.
        release.SetResult();
        sonarr.FailWith = 500;
        var failed = await store.GetCalendarAsync(tv, Month(2023, 5), Month(2023, 5, 31), default);
        Assert.NotNull(failed.Error);
        var calls = arr.CallCount("sonarr.lan");
        Assert.NotNull((await store.GetCalendarAsync(tv, Month(2023, 5), Month(2023, 5, 31), default)).Error);
        Assert.Equal(calls, arr.CallCount("sonarr.lan"));
        arr.Now = arr.Now.AddSeconds(31);
        sonarr.FailWith = 0;
        Assert.NotNull((await store.GetCalendarAsync(tv, Month(2023, 5), Month(2023, 5, 31), default)).Value);
    }

    [Fact]
    public void RadarrCalendarEntriesKeepTheEarliestDateOfEachReleaseTypeAndFilterByRange()
    {
        var wire = JsonSerializer.Deserialize<ArrWireMovie>("""
            {"id":7,"title":"Film","year":2026,"tmdbId":70,"hasFile":false,"monitored":true,"path":"/m/Film",
             "inCinemas":"2026-10-15T00:00:00Z","digitalRelease":"2026-12-01",
             "releases":[{"type":"theatrical","releaseDate":"2026-10-10"},{"isPhysical":true,"date":"2027-02-01"}],
             "images":[{"coverType":"fanart","remoteUrl":"https://f"},{"coverType":"poster","url":"/p"}]}
            """, ArrClient.JsonOptions)!;
        var entry = ArrStateLoaders.ToMovieCalendarEntry(wire)!;
        Assert.Equal(new DateTime(2026, 10, 10, 0, 0, 0, DateTimeKind.Utc), entry.Releases["CinemaRelease"]);
        var radarr = new ArrConnection { Id = "r", Kind = ArrKind.Radarr, Name = "Movies" };
        var snapshot = new ArrCalendarSnapshot { WindowStart = DateTime.MinValue, WindowEnd = DateTime.MaxValue, Entries = new[] { entry } };

        var items = ArrLegacyViews.CalendarItems(radarr, snapshot, new DateTime(2026, 10, 1, 0, 0, 0, DateTimeKind.Utc), new DateTime(2026, 12, 31, 0, 0, 0, DateTimeKind.Utc)).ToList();

        Assert.Equal(new[] { "radarr|r|7-CinemaRelease", "radarr|r|7-DigitalRelease" }, items.Select(i => i.Id));
        Assert.All(items, i => Assert.Equal(("/p", "https://f", "2026"), (i.PosterUrl, i.BackdropUrl, i.Subtitle)));
        Assert.Null(ArrStateLoaders.ToMovieCalendarEntry(new ArrWireMovie { Id = 1 }));
    }

    [Fact]
    public async Task TheReconcilerRefreshesOnlyWhatWasReadRecentlyAndHonoursDebouncedRequests()
    {
        using var arr = Rig(out var radarr, out _);
        radarr.Movies.Add(FakeArr.Movie(1, 45745, "Sintel"));
        var store = arr.Store();
        var movies = arr.Instance("Movies");
        await store.GetLibraryAsync(movies, default);
        await store.GetQueueAsync(movies, default);
        var libraryCalls = arr.CallCount("radarr.lan", "/api/v3/movie");

        arr.Now = arr.Now.AddMinutes(16);   // library interval 15 min, read 16 min ago (interest 2 h)
        var started = store.Tick();
        await Task.WhenAll(started);
        Assert.Equal(libraryCalls + 1, arr.CallCount("radarr.lan", "/api/v3/movie"));
        // The queue was last read 16 minutes ago (interest 15 min): left alone.
        Assert.Equal(1, arr.CallCount("radarr.lan", "/api/v3/queue"));

        arr.Now = arr.Now.AddHours(3);      // nothing read for 3 hours: nothing refreshes
        Assert.Empty(store.Tick());

        Assert.True(store.RequestRefresh(movies.Id, ArrSnapshotKind.Library));
        Assert.True(store.RequestRefresh(movies.Id, ArrSnapshotKind.Library));
        Assert.Empty(store.Tick());          // debounced for two seconds
        arr.Now = arr.Now.AddSeconds(3);
        await Task.WhenAll(store.Tick());
        Assert.Equal(libraryCalls + 2, arr.CallCount("radarr.lan", "/api/v3/movie"));
        Assert.False(store.RequestRefresh("no-such-id", ArrSnapshotKind.Library));
    }

    [Fact]
    public async Task AChangedUrlStartsTheInstanceOverAndRemovedInstancesAreDropped()
    {
        using var arr = Rig(out var radarr, out _);
        radarr.Movies.Add(FakeArr.Movie(1, 1, "Old server"));
        var other = arr.Add("radarr2.lan", "Radarr");
        other.Movies.Add(FakeArr.Movie(1, 2, "New server"));
        var store = arr.Store();
        Assert.NotNull((await store.GetLibraryAsync(arr.Instance("Movies"), default)).Value!.MovieByTmdb(1));

        var config = arr.Plugin.Plugin.Configuration;
        config.RadarrInstances = config.RadarrInstances.Replace("radarr.lan", "radarr2.lan");
        var moved = await store.GetLibraryAsync(arr.Instance("Movies"), default);
        Assert.Null(moved.Value!.MovieByTmdb(1));
        Assert.NotNull(moved.Value.MovieByTmdb(2));

        config.RadarrInstances = "[]";
        store.Tick();
        Assert.DoesNotContain(store.Describe().Instances, i => i.Kind == ArrKind.Radarr);
    }

    [Theory]
    [InlineData("write")]
    [InlineData("loop")]
    public async Task AnExpiredHostDeadlineReturnsWhileAWriteOrLoopIsBlockedAndDisposeDoesNotWaitAgain(string blocked)
    {
        using var arr = Rig(out var radarr, out _);
        radarr.Movies.Add(FakeArr.Movie(1, 45745, "Sintel"));
        var store = arr.Store(Path.Combine(arr.Plugin.Core.Root, "arr-state"));
        store.DisposeWait = TimeSpan.FromMilliseconds(50);
        using var reconciler = new ArrStateReconciler(store, arr.Plugin.Core.Logger) { TickPeriod = TimeSpan.FromMilliseconds(5), DisposeWait = TimeSpan.FromMilliseconds(50) };
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var release = new ManualResetEventSlim();
        void Hold()
        {
            entered.TrySetResult();
            if (!release.Wait(TimeSpan.FromSeconds(10))) throw new TimeoutException("shutdown gate not released");
        }
        if (blocked == "write") store.LibraryCacheWritingHook = Hold;
        else reconciler.BeforeTickHook = Hold;
        await reconciler.StartAsync(default);
        Task? refresh = blocked == "write" ? store.RefreshLibraryNowAsync(arr.Instance("Movies"), default) : null;
        try
        {
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            await reconciler.StopAsync(new CancellationToken(canceled: true)).WaitAsync(TimeSpan.FromSeconds(1));
            // Also cover an ordinary token which fires after waiting started.
            using var deadline = new CancellationTokenSource(TimeSpan.FromMilliseconds(25));
            await reconciler.StopAsync(deadline.Token).WaitAsync(TimeSpan.FromSeconds(1));
            var disposal = Task.Run(() => { reconciler.Dispose(); store.Dispose(); reconciler.Dispose(); store.Dispose(); });
            await disposal.WaitAsync(TimeSpan.FromSeconds(1));
            Assert.Contains("host stop deadline elapsed", File.ReadAllText(arr.Plugin.Core.Logger.CurrentLogFilePath));
        }
        finally
        {
            release.Set();
            await reconciler.StopAsync(default).WaitAsync(TimeSpan.FromSeconds(5));
            if (refresh != null) await refresh.WaitAsync(TimeSpan.FromSeconds(5));
            await store.StopAsync().WaitAsync(TimeSpan.FromSeconds(5));
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task SynchronousDisposalHasAFiniteBudgetForABlockedWriter(bool throughReconciler)
    {
        using var arr = Rig(out var radarr, out _);
        radarr.Movies.Add(FakeArr.Movie(1, 45745, "Sintel"));
        var store = arr.Store(Path.Combine(arr.Plugin.Core.Root, "arr-state"));
        store.DisposeWait = TimeSpan.FromMilliseconds(25);
        using var reconciler = new ArrStateReconciler(store, arr.Plugin.Core.Logger) { DisposeWait = TimeSpan.FromMilliseconds(25) };
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var release = new ManualResetEventSlim();
        store.LibraryCacheWritingHook = () =>
        {
            entered.TrySetResult();
            if (!release.Wait(TimeSpan.FromSeconds(10))) throw new TimeoutException("writer not released");
        };
        var refresh = store.RefreshLibraryNowAsync(arr.Instance("Movies"), default);
        try
        {
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            await Task.Run(() =>
            {
                if (throughReconciler) reconciler.Dispose();
                else store.Dispose();
            }).WaitAsync(TimeSpan.FromSeconds(1));
            Assert.False(store.StopAsync().IsCompleted);
            await Task.Run(() => { reconciler.Dispose(); store.Dispose(); }).WaitAsync(TimeSpan.FromSeconds(1));
        }
        finally
        {
            release.Set();
            await refresh.WaitAsync(TimeSpan.FromSeconds(5));
            await reconciler.StopAsync(default).WaitAsync(TimeSpan.FromSeconds(5));
        }
    }

    [Theory]
    [InlineData("never-started")]
    [InlineData("started")]
    [InlineData("stopped")]
    public async Task RepeatedAndConcurrentShutdownIsSafeWithOrWithoutStartingTheReconciler(string lifecycle)
    {
        using var arr = Rig(out _, out _);
        var store = arr.Store();
        using var reconciler = new ArrStateReconciler(store, arr.Plugin.Core.Logger);
        if (lifecycle != "never-started") await reconciler.StartAsync(default);
        if (lifecycle == "stopped") await reconciler.StopAsync(default).WaitAsync(TimeSpan.FromSeconds(5));
        await Task.WhenAll(Task.Run(reconciler.Dispose), Task.Run(reconciler.Dispose), reconciler.StopAsync(default)).WaitAsync(TimeSpan.FromSeconds(5));
        await reconciler.StopAsync(default).WaitAsync(TimeSpan.FromSeconds(5));
        await Task.WhenAll(Task.Run(store.Dispose), Task.Run(store.Dispose)).WaitAsync(TimeSpan.FromSeconds(5));
        await reconciler.StartAsync(default); // stopped instances never start new work
        await reconciler.StopAsync(default).WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Null((await store.GetLibraryAsync(arr.Instance("Movies"), default)).Value);
        Assert.Equal(0, await store.RefreshTitlesAsync(arr.Instance("Movies").Id, new[] { 1 }, default));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task FaultedOrCancelledOwnedHelpersAreObservedAndNeverFailShutdown(bool cancelled)
    {
        using var arr = Rig(out _, out _);
        var store = arr.Store();
        var gate = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var work = store.StartBackground(() => { entered.TrySetResult(); return gate.Task; }, 0);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var stopping = store.StopAsync();
        if (cancelled) gate.SetCanceled();
        else gate.SetException(new InvalidOperationException("unexpected background failure"));
        await stopping.WaitAsync(TimeSpan.FromSeconds(5));
        if (cancelled) await Assert.ThrowsAnyAsync<OperationCanceledException>(async () => await work);
        else await Assert.ThrowsAsync<InvalidOperationException>(async () => await work);
        Assert.Contains(cancelled ? "background work was cancelled" : "background work failed", File.ReadAllText(arr.Plugin.Core.Logger.CurrentLogFilePath));
        store.Dispose();
        store.Dispose();
        await store.StopAsync(default);
    }

    [Fact]
    public async Task AFaultedReconcilerLoopIsObservedWithoutFailingStopOrDispose()
    {
        using var arr = Rig(out _, out _);
        var store = arr.Store();
        using var reconciler = new ArrStateReconciler(store, arr.Plugin.Core.Logger) { TickPeriod = TimeSpan.Zero };
        await reconciler.StartAsync(default); // invalid timer period faults the scheduled loop
        await reconciler.StopAsync(default).WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Contains("loop failed during shutdown", File.ReadAllText(arr.Plugin.Core.Logger.CurrentLogFilePath));
        reconciler.Dispose();
        store.Dispose();
    }

    [Fact]
    public async Task AKeptReadResetsMissBookkeepingBeforeALaterReadDespiteADelayedObserver()
    {
        var now = DateTimeOffset.UtcNow;
        var seen = false;
        var laterSawReset = false;
        var reads = 0;
        var slot = new ArrSnapshotSlot<ArrQueueSnapshot>(ArrSnapshotKind.Queue, (_, _) =>
        {
            var first = Interlocked.Increment(ref reads) == 1;
            if (!first) laterSawReset = seen;
            return Task.FromResult(ArrResult<ArrQueueSnapshot>.Success(new ArrQueueSnapshot { Incomplete = first }));
        }, q => q.Incomplete, TimeSpan.FromMinutes(2));
        slot.Seed(new ArrQueueSnapshot(), now);
        slot.Kept += _ => seen = true;
        using var entered = new SemaphoreSlim(0);
        using var release = new SemaphoreSlim(0);
        slot.Refreshed += (_, value) =>
        {
            if (value != null) return;
            entered.Release();
            release.Wait(TimeSpan.FromSeconds(5));
        };
        var kept = slot.StartRefresh(new ArrCallCounter(), () => now, default);
        try
        {
            Assert.True(await entered.WaitAsync(TimeSpan.FromSeconds(5)));
            await slot.StartRefresh(new ArrCallCounter(), () => now, default).WaitAsync(TimeSpan.FromSeconds(5));
            Assert.True(laterSawReset);
        }
        finally { release.Release(); }
        await kept.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(2, reads);
    }

    [Fact]
    public async Task ACancelledTokenRemainsSafeForARefreshAfterItsSourceWasDisposed()
    {
        var source = new CancellationTokenSource();
        var token = source.Token;
        source.Cancel();
        source.Dispose();
        var calls = 0;
        var slot = new ArrSnapshotSlot<ArrQueueSnapshot>(ArrSnapshotKind.Queue, (_, _) =>
        {
            calls++;
            return Task.FromResult(ArrResult<ArrQueueSnapshot>.Success(new ArrQueueSnapshot()));
        });
        await slot.StartRefresh(new ArrCallCounter(), () => DateTimeOffset.UtcNow, token);
        Assert.Equal(0, calls);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ShutdownWaitsForACacheWriterEvenAfterItsInstanceStateWasReplaced(bool replaceState)
    {
        using var arr = Rig(out var radarr, out _);
        radarr.Movies.Add(FakeArr.Movie(1, 45745, "Sintel"));
        var dir = Path.Combine(arr.Plugin.Core.Root, "arr-state");
        var store = arr.Store(dir);
        var instance = arr.Instance("Movies");
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var release = new ManualResetEventSlim();
        store.LibraryCacheWritingHook = () =>
        {
            entered.TrySetResult();
            if (!release.Wait(TimeSpan.FromSeconds(10))) throw new TimeoutException("cache writer not released");
        };
        var refresh = store.RefreshLibraryNowAsync(instance, default);
        Task? stopping = null;
        try
        {
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            // Inflight was cleared before the file writer ran. Looking at active slots cannot drain it.
            Assert.False(store.Describe().Instances.Single(i => i.Name == "Movies").Snapshots.Single(s => s.Kind == ArrSnapshotKind.Library).Refreshing);
            if (replaceState)
            {
                arr.Add("replacement.lan", "Radarr");
                var rows = System.Text.Json.Nodes.JsonNode.Parse(arr.Plugin.Plugin.Configuration.RadarrInstances)!;
                rows[0]!["Url"] = "http://replacement.lan:7878";
                arr.Plugin.Plugin.Configuration.RadarrInstances = rows.ToJsonString();
                Assert.NotNull((await store.GetQueueAsync(arr.Instance("Movies"), default)).Value);
                Assert.True(arr.CallCount("replacement.lan") > 0);
            }
            stopping = store.StopAsync();
            Assert.Same(stopping, store.StopAsync());
            Assert.False(stopping.IsCompleted);
        }
        finally
        {
            release.Set();
            await refresh.WaitAsync(TimeSpan.FromSeconds(5));
            if (stopping != null) await stopping.WaitAsync(TimeSpan.FromSeconds(5));
        }
        Assert.True(File.Exists(Path.Combine(dir, instance.Id + ".library.json")));
        Directory.Delete(dir, true); // resources can be removed as soon as shutdown returns
        store.Dispose();
        Assert.False(Directory.Exists(dir));
    }

    [Fact]
    public async Task ShutdownWaitsForQueueObserversAndTheirHealthLogAfterInflightWasCleared()
    {
        using var arr = Rig(out var radarr, out _);
        var store = arr.Store(); // No cache directory: the writer here is the health log.
        var instance = arr.Instance("Movies");
        radarr.FailWith = 503;
        Assert.NotNull((await store.GetQueueAsync(instance, default)).Error);
        radarr.FailWith = 0;
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var release = new ManualResetEventSlim();
        store.QueueRefreshedHook = (_, _) =>
        {
            entered.TrySetResult();
            if (!release.Wait(TimeSpan.FromSeconds(10))) throw new TimeoutException("queue observer not released");
        };
        var refresh = store.RefreshForEventAsync(instance.Id, ArrSnapshotKind.Queue, force: true);
        Task? stopping = null;
        try
        {
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.False(store.Describe().Instances.Single(i => i.Name == "Movies").Snapshots.Single(s => s.Kind == ArrSnapshotKind.Queue).Refreshing);
            stopping = store.StopAsync();
            Assert.False(stopping.IsCompleted);
        }
        finally
        {
            release.Set();
            await refresh.WaitAsync(TimeSpan.FromSeconds(5));
            if (stopping != null) await stopping.WaitAsync(TimeSpan.FromSeconds(5));
        }
        Assert.Contains("queue can be read again", File.ReadAllText(arr.Plugin.Core.Logger.CurrentLogFilePath));
        store.Dispose();
    }

    [Theory]
    [InlineData("library")]
    [InlineData("library-faulty-callback")]
    [InlineData("calendar")]
    [InlineData("titles")]
    public async Task ShutdownCancelsAndDrainsBackgroundReadsAndRefusesNewWork(string kind)
    {
        using var arr = Rig(out var radarr, out _);
        radarr.Movies.Add(FakeArr.Movie(1, 45745, "Sintel"));
        var store = arr.Store();
        var instance = arr.Instance("Movies");
        if (kind == "titles") await store.GetLibraryAsync(instance, default);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var cancelled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        radarr.Before = async (path, ct) =>
        {
            if (path is not ("/api/v3/movie" or "/api/v3/movie/1" or "/api/v3/calendar")) return;
            using var registration = ct.Register(() =>
            {
                cancelled.TrySetResult();
                if (kind == "library-faulty-callback") throw new InvalidOperationException("faulty cancellation callback");
            });
            entered.TrySetResult();
            await Task.Delay(Timeout.Infinite, ct);
        };
        Task read = kind switch
        {
            "library" or "library-faulty-callback" => store.GetLibraryAsync(instance, default),
            "calendar" => store.GetCalendarAsync(instance, new DateTime(2025, 1, 1, 0, 0, 0, DateTimeKind.Utc), new DateTime(2025, 1, 30, 0, 0, 0, DateTimeKind.Utc), default),
            _ => store.RefreshTitlesAsync(instance.Id, new[] { 1 }, default),
        };
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await store.StopAsync().WaitAsync(TimeSpan.FromSeconds(5));
        await cancelled.Task.WaitAsync(TimeSpan.FromSeconds(5));
        await read.WaitAsync(TimeSpan.FromSeconds(5));
        if (kind == "titles") Assert.Equal(0, await (Task<int>)read);
        var calls = arr.CallCount();
        Assert.Null((await store.GetLibraryAsync(instance, default)).Value);
        Assert.Equal(0, await store.RefreshTitlesAsync(instance.Id, new[] { 1 }, default));
        Assert.Empty(store.Tick());
        Assert.Equal(calls, arr.CallCount());
        store.Dispose();
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    [InlineData(true, true)]
    public async Task TitleRereadsKeepCompletedProgressOnShutdownAndPreserveExplicitCallerCancellation(bool series, bool callerCancels)
    {
        using var arr = Rig(out var radarr, out var sonarr);
        arr.Plugin.Plugin.Configuration.ArrIntegrationEnabled = true;
        arr.Plugin.Plugin.Configuration.ArrPhase1Enabled = true;
        var host = series ? sonarr : radarr;
        var rows = series ? host.Series : host.Movies;
        foreach (var id in new[] { 1, 2, 3 })
            rows.Add(series ? FakeArr.SeriesRow(id, 100 + id, "Before " + id) : FakeArr.Movie(id, 100 + id, "Before " + id));
        var store = arr.Store();
        var instance = arr.Instance(series ? "TV" : "Movies");
        await store.GetLibraryAsync(instance, default);
        rows[0]["title"] = "After 1";
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var prefix = series ? "/api/v3/series/" : "/api/v3/movie/";
        host.Before = async (path, ct) =>
        {
            if (path != prefix + "2") return;
            entered.TrySetResult();
            await Task.Delay(Timeout.Infinite, ct);
        };
        using var caller = new CancellationTokenSource();
        var read = store.RefreshTitlesAsync(instance.Id, new[] { 1, 2, 3 }, caller.Token);
        try
        {
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            if (callerCancels)
            {
                caller.Cancel();
                await Assert.ThrowsAnyAsync<OperationCanceledException>(async () => await read.WaitAsync(TimeSpan.FromSeconds(5)));
            }
            else
            {
                await store.StopAsync().WaitAsync(TimeSpan.FromSeconds(5));
                Assert.Equal(1, await read.WaitAsync(TimeSpan.FromSeconds(5)));
            }
            var library = store.PeekLibrary(instance.Id)!;
            Assert.Equal("After 1", series ? library.SeriesById(1)!.Title : library.MovieById(1)!.Title);
            Assert.Equal("Before 2", series ? library.SeriesById(2)!.Title : library.MovieById(2)!.Title);
            Assert.Equal(0, arr.CallCount(series ? "sonarr.lan" : "radarr.lan", prefix + "3"));
        }
        finally
        {
            await store.StopAsync().WaitAsync(TimeSpan.FromSeconds(5));
        }
    }

    [Fact]
    public async Task TheLibraryIndexIsWarmStartedFromItsCacheFileAndRefreshedInTheBackground()
    {
        using var arr = Rig(out var radarr, out var sonarr);
        radarr.Tags[3] = "family";
        radarr.Movies.Add(FakeArr.Movie(1, 45745, "Sintel", tags: new[] { 3 }));
        sonarr.Series.Add(FakeArr.SeriesRow(1, 78874, "Firefly", tmdb: 1437, imdb: "tt0303461"));
        var dir = Path.Combine(arr.Plugin.Core.Root, "arr-state");
        var first = arr.Store(dir);
        await first.GetLibraryAsync(arr.Instance("Movies"), default);
        await first.GetLibraryAsync(arr.Instance("TV"), default);
        var file = Path.Combine(dir, arr.Instance("Movies").Id + ".library.json");
        Assert.True(File.Exists(file));
        if (!OperatingSystem.IsWindows()) Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(file));
        Assert.DoesNotContain("RADARR-KEY", File.ReadAllText(file));

        radarr.FailWith = 503;              // the instance is down after the restart
        arr.Now = arr.Now.AddHours(1);
        var second = arr.Store(dir);
        var read = await second.GetLibraryAsync(arr.Instance("Movies"), default);
        Assert.True(read.Stale);
        Assert.Equal(new[] { "family" }, read.Value!.Labels(read.Value.MovieByTmdb(45745)!.Tags));
        var tv = await second.GetLibraryAsync(arr.Instance("TV"), default);
        Assert.Equal("firefly", tv.Value!.SeriesByImdb("TT0303461")!.TitleSlug);

        // A cache written for another URL is ignored.
        File.WriteAllText(file, File.ReadAllText(file).Replace("radarr.lan", "other.lan"));
        var third = arr.Store(dir);
        Assert.Null((await third.GetLibraryAsync(arr.Instance("Movies"), default)).Value);
        third.PruneCacheFiles();
        Assert.True(File.Exists(file));
        arr.Plugin.Plugin.Configuration.RadarrInstances = "[]";
        third.PruneCacheFiles();
        Assert.False(File.Exists(file));
    }

    [Fact]
    public async Task AWarmStartedLibraryIsReadAgainRightAwayEvenWhenTheFileIsRecent()
    {
        using var arr = Rig(out var radarr, out _);
        arr.Plugin.Plugin.Configuration.ArrIntegrationEnabled = true;
        arr.Plugin.Plugin.Configuration.ArrPhase1Enabled = true;
        radarr.Movies.Add(FakeArr.Movie(1, 45745, "Sintel"));
        var dir = Path.Combine(arr.Plugin.Core.Root, "arr-state");
        await arr.Store(dir).GetLibraryAsync(arr.Instance("Movies"), default);

        // Restarted a minute later; a movie was added in the meantime.
        radarr.Movies.Add(FakeArr.Movie(2, 693134, "Dune Part Two", hasFile: false));
        arr.Now = arr.Now.AddMinutes(1);
        var store = arr.Store(dir);
        var read = await store.GetLibraryAsync(arr.Instance("Movies"), default);
        Assert.False(read.Stale);
        Assert.Null(read.Value!.MovieByTmdb(693134));
        await Task.WhenAll(store.Tick());
        Assert.NotNull((await store.GetLibraryAsync(arr.Instance("Movies"), default)).Value!.MovieByTmdb(693134));
    }

    [Fact]
    public void QueueRowsKeepTheOldShapeAndStatusMapping()
    {
        var radarr = new ArrConnection { Id = "r", Kind = ArrKind.Radarr, Name = "Movies" };
        var rows = new[]
        {
            ArrStateLoaders.ToQueueEntry(JsonSerializer.Deserialize<ArrWireQueueRecord>(FakeArr.RadarrQueueRow(1, 10, "A", "importPending").ToJsonString(), ArrClient.JsonOptions)!),
            ArrStateLoaders.ToQueueEntry(JsonSerializer.Deserialize<ArrWireQueueRecord>(FakeArr.RadarrQueueRow(2, 11, "B", "downloading", "warning").ToJsonString(), ArrClient.JsonOptions)!),
            ArrStateLoaders.ToQueueEntry(JsonSerializer.Deserialize<ArrWireQueueRecord>(FakeArr.RadarrQueueRow(3, 12, "C", "failedPending").ToJsonString(), ArrClient.JsonOptions)!),
        };
        var items = ArrLegacyViews.QueueItems(radarr, new ArrQueueSnapshot { Records = rows }).ToList();
        Assert.Equal(new[] { "importing", "warning", "failed" }, items.Select(i => i.Status));
        Assert.All(items, i => Assert.Equal((50.0, 2000L, 1000L, "2010", "Radarr"), (i.Progress, i.TotalSize!.Value, i.SizeRemaining!.Value, i.Subtitle, i.Source)));
        Assert.Equal(new[] { "Sample" }, rows[0].StatusMessages);
        var json = JsonSerializer.Serialize(items[0]);
        foreach (var field in new[] { "\"id\":\"1\"", "\"instanceName\":\"Movies\"", "\"timeRemaining\"", "\"posterUrl\"", "\"tmdbId\":10", "\"seasonNumber\":null" })
            Assert.Contains(field, json);
        Assert.Equal(0, ArrLegacyViews.CalculateProgress(0, 0));
        Assert.Equal(100, ArrLegacyViews.CalculateProgress(10, null));
    }

    [Fact]
    public async Task WithRequestsAndDownloadsOffAWarmStartAndAQueueDepartureKeepTheOldIntervals()
    {
        using var arr = Rig(out var radarr, out _);
        var config = arr.Plugin.Plugin.Configuration;
        Assert.False(config.ArrIntegrationEnabled || config.ArrPhase1Enabled);
        radarr.Movies.Add(FakeArr.Movie(1, 45745, "Sintel", hasFile: false));
        radarr.Queue.Add(FakeArr.RadarrQueueRow(1, 45745, "Sintel"));
        var dir = Path.Combine(arr.Plugin.Core.Root, "arr-state");
        var movies = arr.Instance("Movies");
        await arr.Store(dir).GetLibraryAsync(movies, default);

        // Restarted: the warm-start file is served and not read again at once.
        arr.Now = arr.Now.AddMinutes(1);
        var store = arr.Store(dir);
        await store.GetLibraryAsync(movies, default);
        await store.GetQueueAsync(movies, default);
        var library = arr.CallCount("radarr.lan", "/api/v3/movie");
        var history = arr.CallCount("radarr.lan", "/api/v3/history");

        // The download leaves the queue (the Downloads page polls it): nothing else is read early.
        radarr.Queue.Clear();
        store.RequestRefresh(movies.Id, ArrSnapshotKind.Queue);
        for (var i = 0; i < 3; i++)
        {
            arr.Now += TimeSpan.FromSeconds(3);
            await Task.WhenAll(store.Tick());
        }
        Assert.Equal((library, history), (arr.CallCount("radarr.lan", "/api/v3/movie"), arr.CallCount("radarr.lan", "/api/v3/history")));

        // Switched on at runtime: the next departure asks for the library and history again.
        config.ArrIntegrationEnabled = true;
        config.ArrPhase1Enabled = true;
        radarr.Queue.Add(FakeArr.RadarrQueueRow(1, 45745, "Sintel"));
        store.RequestRefresh(movies.Id, ArrSnapshotKind.Queue);
        arr.Now += TimeSpan.FromSeconds(3);
        await Task.WhenAll(store.Tick());
        radarr.Queue.Clear();
        store.RequestRefresh(movies.Id, ArrSnapshotKind.Queue);
        for (var i = 0; i < 3; i++)
        {
            arr.Now += TimeSpan.FromSeconds(3);
            await Task.WhenAll(store.Tick());
        }
        Assert.True(arr.CallCount("radarr.lan", "/api/v3/movie") > library);
        Assert.True(arr.CallCount("radarr.lan", "/api/v3/history") > history);
    }

    [Fact]
    public async Task OneEpisodeLeavingTheQueueWhileAnotherOfTheSeriesDownloadsRefreshesItsEpisodes()
    {
        using var arr = Rig(out _, out var sonarr);
        arr.Plugin.Plugin.Configuration.ArrIntegrationEnabled = true;
        arr.Plugin.Plugin.Configuration.ArrPhase1Enabled = true;
        sonarr.Series.Add(FakeArr.SeriesRow(1, 100, "Show"));
        sonarr.Episodes.Add(FakeArr.Episode(11, "2026-01-01T00:00:00Z", season: 1, episode: 1));
        sonarr.Episodes.Add(FakeArr.Episode(12, "2026-01-08T00:00:00Z", season: 1, episode: 2));
        sonarr.Queue.Add(FakeArr.SonarrQueueRow(11, "dl11", 1, 1));
        sonarr.Queue.Add(FakeArr.SonarrQueueRow(12, "dl12", 1, 2));
        var store = arr.Store();
        var tv = arr.Instance("TV");
        await store.GetLibraryAsync(tv, default);
        await store.GetQueueAsync(tv, default);
        await store.GetEpisodesAsync(tv, 1, default);
        var episodes = arr.CallCount("sonarr.lan", "/api/v3/episode");
        var library = arr.CallCount("sonarr.lan", "/api/v3/series");

        // E1 imports; E2 is still downloading, so the series never leaves the queue.
        sonarr.Queue.RemoveAt(0);
        store.RequestRefresh(tv.Id, ArrSnapshotKind.Queue);
        arr.Now += TimeSpan.FromSeconds(3);
        await Task.WhenAll(store.Tick());
        var history = arr.CallCount("sonarr.lan", "/api/v3/history");
        Assert.NotNull(store.LeftQueueAt(tv, null, 11));
        arr.Now += TimeSpan.FromSeconds(3);
        await Task.WhenAll(store.Tick());
        Assert.True(arr.CallCount("sonarr.lan", "/api/v3/episode") > episodes, "episodes re-read");
        Assert.True(arr.CallCount("sonarr.lan", "/api/v3/series") > library, "library re-read");
        Assert.True(arr.CallCount("sonarr.lan", "/api/v3/history") > history, "history re-read");
    }

    /// <summary>A Sonarr with series 1 (TVDB 100) and its two episodes, both monitored; its library and episodes read once.</summary>
    private static async Task<(FakeArr Arr, FakeArr.Host Sonarr, ArrStateStore Store, ArrConnection Tv)> EpisodesRead()
    {
        var arr = Rig(out _, out var sonarr);
        sonarr.Series.Add(FakeArr.SeriesRow(1, 100, "Show"));
        sonarr.Episodes.Add(FakeArr.Episode(11, "2026-01-01T00:00:00Z", season: 1, episode: 1));
        sonarr.Episodes.Add(FakeArr.Episode(12, "2026-01-08T00:00:00Z", season: 1, episode: 2));
        var store = arr.Store();
        var tv = arr.Instance("TV");
        await store.GetLibraryAsync(tv, default);
        Assert.True((await store.GetEpisodesAsync(tv, 1, default)).Value!.Episodes.All(e => e.Monitored));
        return (arr, sonarr, store, tv);
    }

    [Fact]
    public async Task AnEpisodeUnmonitoredInSonarrReachesASeriesPageLeftOpenWithinAMinute()
    {
        var (arr, sonarr, store, tv) = await EpisodesRead();
        using var lifetime = arr;
        var reads = arr.CallCount("sonarr.lan", "/api/v3/episode");
        // Unmonitored in Sonarr's own UI: Sonarr sends no SignalR message and no webhook for it.
        sonarr.Episodes[1]["monitored"] = false;
        // The page stays open: its change-feed poll names the series every 25 seconds (nothing else reads it).
        for (var elapsed = 25; elapsed <= 75; elapsed += 25)
        {
            arr.Now += TimeSpan.FromSeconds(25);
            Assert.Equal(1, store.KeepEpisodesWarm(new[] { 100, 100, 0, 999 }));
            await Task.WhenAll(store.Tick());
        }
        Assert.Equal(reads + 1, arr.CallCount("sonarr.lan", "/api/v3/episode"));
        Assert.False(store.PeekEpisodes(tv, 1)!.Value!.Episodes.Single(e => e.EpisodeNumber == 2).Monitored);
        // Still open: read again once a minute, not more.
        for (var i = 0; i < 4; i++)
        {
            arr.Now += TimeSpan.FromSeconds(15);
            store.KeepEpisodesWarm(new[] { 100 });
            await Task.WhenAll(store.Tick());
        }
        Assert.Equal(reads + 2, arr.CallCount("sonarr.lan", "/api/v3/episode"));
    }

    [Fact]
    public async Task OpeningASeriesPageReReadsEpisodesOlderThanAMinute()
    {
        var (arr, sonarr, store, tv) = await EpisodesRead();
        using var lifetime = arr;
        var reads = arr.CallCount("sonarr.lan", "/api/v3/episode");
        sonarr.Episodes[1]["monitored"] = false;
        arr.Now += TimeSpan.FromSeconds(30);
        Assert.True((await store.GetEpisodesAsync(tv, 1, default)).Value!.Episodes.All(e => e.Monitored));
        Assert.Equal(reads, arr.CallCount("sonarr.lan", "/api/v3/episode"));
        // Opened again a minute and a half later: the held list is shown at once and read again behind it (the change
        // feed then brings the new one to the page).
        arr.Now += TimeSpan.FromSeconds(60);
        var read = await store.GetEpisodesAsync(tv, 1, default);
        Assert.True(read.Stale);
        Assert.True(read.Value!.Episodes.All(e => e.Monitored));
        for (var i = 0; i < 200 && store.PeekEpisodes(tv, 1)!.Value!.Episodes.All(e => e.Monitored); i++) await Task.Delay(10);
        Assert.Equal(reads + 1, arr.CallCount("sonarr.lan", "/api/v3/episode"));
        Assert.False(store.PeekEpisodes(tv, 1)!.Value!.Episodes.Single(e => e.EpisodeNumber == 2).Monitored);
    }

    [Fact]
    public async Task EpisodesNobodyHasOpenKeepTheFiveMinutePaceAndUnreadSeriesAreNeverLoaded()
    {
        var (arr, _, store, tv) = await EpisodesRead();
        using var lifetime = arr;
        var reads = arr.CallCount("sonarr.lan", "/api/v3/episode");
        // A series whose episodes nobody has read isn't loaded by a feed poll naming it.
        Assert.Equal(0, store.KeepEpisodesWarm(new[] { 200 }));
        // Closed after the first read: no re-read for 5 minutes.
        for (var i = 0; i < 9; i++)
        {
            arr.Now += TimeSpan.FromSeconds(30);
            await Task.WhenAll(store.Tick());
        }
        Assert.Equal(reads, arr.CallCount("sonarr.lan", "/api/v3/episode"));
        arr.Now += TimeSpan.FromSeconds(31);
        await Task.WhenAll(store.Tick());
        Assert.Equal(reads + 1, arr.CallCount("sonarr.lan", "/api/v3/episode"));
        Assert.Null(store.PeekEpisodes(tv, 200));
    }

    [Fact]
    public async Task EpisodeSlotsBeingLoadedAreNeverEvictedSoLoadsStayBounded()
    {
        using var arr = Rig(out _, out var sonarr);
        var release = new TaskCompletionSource();
        sonarr.Before = async (path, ct) =>
        {
            if (path == "/api/v3/episode") await release.Task.WaitAsync(ct);
        };
        var store = arr.Store();
        var tv = arr.Instance("TV");
        var pending = Enumerable.Range(1, 64).Select(id => store.GetEpisodesAsync(tv, id, default)).ToList();

        // Every slot is loading: another series is refused at once instead of evicting one of them.
        var started = DateTime.UtcNow;
        var extra = await store.GetEpisodesAsync(tv, 65, default);
        Assert.Equal(ArrErrorKind.Timeout, extra.Error!.Kind);
        Assert.True(DateTime.UtcNow - started < TimeSpan.FromSeconds(5));
        Assert.Equal(64, store.Describe().Instances.Single(i => i.Name == "TV").CachedEpisodeSeries);

        release.SetResult();
        await Task.WhenAll(pending);
        // 64 loads, each read once: none was orphaned and started again.
        await store.GetEpisodesAsync(tv, 1, default);
        Assert.Equal(64, arr.CallCount("sonarr.lan", "/api/v3/episode"));
        // Once idle, the least recently read slot makes room.
        Assert.Null((await store.GetEpisodesAsync(tv, 65, default)).Error);
    }
    [Fact]
    public async Task AnEpisodeSlotPickedByOneReadIsNeverLoadedAfterAnotherReadEvictedIt()
    {
        using var arr = Rig(out _, out var sonarr);
        var release = new TaskCompletionSource();
        sonarr.Before = async (path, ct) =>
        {
            if (path == "/api/v3/episode") await release.Task.WaitAsync(ct);
        };
        var store = arr.Store();
        var tv = arr.Instance("TV");
        var others = new List<Task<ArrSnapshotRead<ArrEpisodesSnapshot>>>();
        // Read 1 picks series 1's new (idle) slot; before it starts the load, 63 other series start
        // loading and a 65th series needs room: the only idle slot is series 1's.
        store.EpisodeSlotPicked = id =>
        {
            if (id != 1) return;
            store.EpisodeSlotPicked = null;
            others.AddRange(Enumerable.Range(2, 63).Select(n => store.GetEpisodesAsync(tv, n, default)));
            others.Add(store.GetEpisodesAsync(tv, 99, default));
        };
        var first = store.GetEpisodesAsync(tv, 1, default);

        // Never more loads than slots: series 1's slot was dropped before read 1 started its load, so
        // read 1 doesn't load it (an unowned 65th load) but answers "still loading".
        release.SetResult();
        await Task.WhenAll(others);
        var read = await first;
        Assert.Equal(ArrErrorKind.Timeout, read.Error!.Kind);
        Assert.Equal(64, arr.CallCount("sonarr.lan", "/api/v3/episode"));
        Assert.Equal(64, store.Describe().Instances.Single(i => i.Name == "TV").CachedEpisodeSeries);
    }
    [Fact]
    public async Task ASeriesPickedForReadingCountsAsJustReadSoItIsNotTheOneEvicted()
    {
        using var arr = Rig(out _, out _);
        var store = arr.Store();
        var tv = arr.Instance("TV");
        await Task.WhenAll(Enumerable.Range(1, 64).Select(n => store.GetEpisodesAsync(tv, n, default)));
        arr.Now += TimeSpan.FromSeconds(1);
        // While a read of series 1 (the oldest) is between picking its slot and reading it, a new
        // series needs room: the least recently read is now series 2, not series 1.
        store.EpisodeSlotPicked = id =>
        {
            if (id != 1) return;
            store.EpisodeSlotPicked = null;
            store.GetEpisodesAsync(tv, 99, default).GetAwaiter().GetResult();
        };
        var read = await store.GetEpisodesAsync(tv, 1, default);
        Assert.Null(read.Error);
        Assert.NotNull(store.PeekEpisodes(tv, 1));
        Assert.Null(store.PeekEpisodes(tv, 2));
        Assert.Equal(65, arr.CallCount("sonarr.lan", "/api/v3/episode"));
    }

    [Fact]
    public void ProviderIdZeroIsMissingEverywhere()
    {
        // The arrs send 0 for a title they couldn't match: never an id.
        Assert.Null(ArrStateLoaders.ToMovie(new ArrWireMovie { Id = 1, TmdbId = 0 }).TmdbId);
        var series = ArrStateLoaders.ToSeries(new ArrWireSeries { Id = 2, TvdbId = 0, TmdbId = 0 });
        Assert.Equal((null, null), (series.TvdbId, series.TmdbId));
        // A live resource with 0 keeps the positive id held.
        Assert.Equal(603, ArrStateLoaders.MergeMovie(new ArrMovieEntry { Id = 1, TmdbId = 603 }, new ArrWireMovie { Id = 1, TmdbId = 0 }).TmdbId);
        Assert.Equal(78874, ArrStateLoaders.MergeSeries(new ArrSeriesEntry { Id = 2, TvdbId = 78874 }, new ArrWireSeries { Id = 2, TvdbId = 0 }).TvdbId);
        var queue = ArrStateLoaders.ToQueueEntry(new ArrWireQueueRecord { Id = 3, Movie = new ArrWireMovie { Id = 1, TmdbId = 0 } });
        Assert.Null(queue.TmdbId);
        Assert.Null(ArrStateLoaders.ToMovieCalendarEntry(new ArrWireMovie { Id = 1, TmdbId = 0, DigitalRelease = "2026-11-14T00:00:00Z" })!.TmdbId);
        var episode = ArrStateLoaders.ToEpisodeEntry(new ArrWireEpisode { Id = 4, TvdbId = 0, SeasonNumber = 1, EpisodeNumber = 1, AirDateUtc = "2026-11-14T02:00:00Z", Series = new ArrWireSeries { Id = 2, TvdbId = 0, TmdbId = 0, Title = "A" } });
        Assert.Equal((null, null, null), (episode!.TvdbId, episode.TmdbId, episode.EpisodeTvdbId));
        // No key from 0 (Needs attention, the bridge, the path doctor).
        Assert.Null(Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.JellyfinBridge.KeyOf(ArrKind.Radarr, 0, null, null, null));
        Assert.Null(Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.JellyfinBridge.KeyOf(ArrKind.Sonarr, null, 0, 1, 2));
        Assert.Equal("tv:tvdb:5:s1:e2", Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.JellyfinBridge.KeyOf(ArrKind.Sonarr, null, 5, 1, 2));
    }

    [Fact]
    public void AnEpisodeWithoutAnAirTimeIsADayOnly()
    {
        Assert.False(Load(new System.Text.Json.Nodes.JsonObject { ["id"] = 1, ["seriesId"] = 7, ["seasonNumber"] = 1, ["episodeNumber"] = 1, ["airDateUtc"] = "2026-11-14T02:00:00Z", ["airDate"] = "2026-11-13" }).AirDateIsDay);
        var day = Load(new System.Text.Json.Nodes.JsonObject { ["id"] = 2, ["seriesId"] = 7, ["seasonNumber"] = 1, ["episodeNumber"] = 2, ["airDate"] = "2026-11-21" });
        Assert.True(day.AirDateIsDay);
        Assert.Equal(new DateTime(2026, 11, 21, 0, 0, 0, DateTimeKind.Utc), day.AirDateUtc);

        static ArrEpisodeEntry Load(System.Text.Json.Nodes.JsonObject episode)
        {
            using var arr = Rig(out _, out var sonarr);
            sonarr.Series.Add(FakeArr.SeriesRow(7, 700, "Show"));
            sonarr.Episodes.Add(episode);
            var store = arr.Store();
            var read = store.GetEpisodesAsync(arr.Instance("TV"), 7, default).GetAwaiter().GetResult();
            return read.Value!.Episodes.Single();
        }
    }
}
