using System.Text.Json;
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
        Assert.Contains(arr.Calls, c => c.Contains("/history/since?date=2026-10-12T11%3A55"));
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
        Assert.Equal("1", Assert.Single(events).Id);       // filtered to the range server-side
        Assert.Equal("S01E01 - Ep 1", events[0].Subtitle);
        Assert.Equal("/data/tv", events[0].RootFolderPath);
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

        Assert.Equal(new[] { "7-CinemaRelease", "7-DigitalRelease" }, items.Select(i => i.Id));
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
}
