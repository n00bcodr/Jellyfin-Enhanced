using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using Moq;

namespace JE.Tests;

/// <summary>
/// Requests &amp; downloads, phase 1: the status composer wired to live updates. One title-key
/// format for the status routes and the change feed; cached status bodies follow the feed's
/// per-title revisions (a live patch keeps a snapshot's age, so the snapshot stamps alone would
/// serve the old body); live patches keep the status facts a partial resource leaves out; a
/// series' episode reads reach the feed; file events re-read the episodes someone is looking at.
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationArrLiveStatusTests
{
    private sealed class Rig : IDisposable
    {
        public FakeArr Arr { get; } = new();
        public FakeArr.Host Radarr { get; }
        public FakeArr.Host Sonarr { get; }
        public ArrStateStore Store { get; }
        public ArrChangeFeed Feed { get; } = new();
        public ArrLiveRouter Router { get; }
        public ArrChangeTracker Tracker { get; }
        public FakeJellyfinView View { get; } = new();
        public ArrStatusService Service { get; }
        public StatusViewer Admin { get; }
        public Guid Show { get; } = Guid.NewGuid();
        public Guid Season1 { get; } = Guid.NewGuid();
        public ArrConnection RadarrConn => Arr.Instance("Movies");
        public ArrConnection SonarrConn => Arr.Instance("TV");

        public Rig(bool withFeed = true)
        {
            Radarr = Arr.Add("radarr.lan", "Radarr");
            Sonarr = Arr.Add("sonarr.lan", "Sonarr");
            Radarr.Movies.Add(FakeArr.Movie(1, 101, "Alpha", hasFile: false, path: "/data/movies/Alpha"));
            Sonarr.Series.Add(FakeArr.SeriesRow(7, 700, "Show"));
            Sonarr.Episodes.Add(Episode(71, 1, 1, hasFile: true));
            Sonarr.Episodes.Add(Episode(72, 1, 2, hasFile: false));
            Arr.Configure(("Movies", ArrKind.Radarr, "http://radarr.lan:7878", "RADARR-KEY-0123456789"), ("TV", ArrKind.Sonarr, "http://sonarr.lan:8989", "SONARR-KEY-0123456789"));
            var config = Arr.Plugin.Plugin.Configuration;
            config.ArrIntegrationEnabled = true;
            config.ArrPhase1Enabled = true;
            Arr.Now = DateTimeOffset.UtcNow;
            Store = Arr.Store();
            Router = new ArrLiveRouter(Store, Arr.Plugin.Core.Logger, TimeSpan.FromMilliseconds(10));
            Tracker = new ArrChangeTracker(Store, Feed, Router, null, Arr.Plugin.Core.Logger, () => Arr.Plugin.Plugin.Configuration);
            Tracker.Start();
            Service = new ArrStatusService(Store, View, new NoRequestFacts(), () => Arr.Plugin.Plugin.Configuration, () => Arr.Now, withFeed ? Feed : null);
            Admin = View.AddUser(admin: true);
            var showKey = TitleKey.Parse("tv:tvdb:700")!;
            View.AddItem(new JfItemRef { ItemId = Show, Kind = "series", Key = showKey });
            View.AddItem(new JfItemRef { ItemId = Season1, Kind = "season", Key = showKey.WithSeason(1), SeriesId = Show, Season = 1 });
            View.AddEpisode(Show, new JfEpisode { ItemId = Guid.NewGuid(), Season = 1, Episode = 1 });
        }

        public static JsonObject Episode(int id, int season, int number, bool hasFile)
            => new() { ["id"] = id, ["seriesId"] = 7, ["seasonNumber"] = season, ["episodeNumber"] = number, ["airDateUtc"] = "2020-01-0" + number + "T00:00:00Z", ["hasFile"] = hasFile, ["monitored"] = true };

        /// <summary>The status of a title by key (the movie isn't in Jellyfin yet: the arr facts decide).</summary>
        public async Task<(string Body, string ETag)> KeyAsync(string key)
        {
            var body = await Service.ForBatchAsync(Admin, Array.Empty<Guid>(), new[] { TitleKey.Parse(key)! }, default);
            return (Encoding.UTF8.GetString(body.Json), body.ETag);
        }

        public async Task<(string Body, string ETag)> ItemAsync(Guid id)
        {
            var body = await Service.ForItemAsync(Admin, id, default);
            return (Encoding.UTF8.GetString(body.Json), body.ETag);
        }

        public void Dispose() => Arr.Dispose();
    }

    private static async Task Until(Func<bool> condition, int timeoutMs = 10000)
    {
        var start = DateTime.UtcNow;
        while (!condition())
        {
            if ((DateTime.UtcNow - start).TotalMilliseconds > timeoutMs) throw new TimeoutException("condition not met");
            await Task.Delay(10);
        }
    }

    private static string Stage(string body) => JsonDocument.Parse(body).RootElement.GetProperty("items")[0].GetProperty("stage").GetString()!;

    [Fact]
    public void TheStatusRoutesAndTheChangeFeedNameTitlesTheSameWay()
    {
        Assert.Equal(ArrTitleKey.Movie(603), TitleKey.ForMovie("603", "tt0133093")!.ToString());
        var series = TitleKey.ForSeries("78874", "1437", null)!;
        Assert.Equal(ArrTitleKey.Series(78874), series.ToString());
        Assert.Equal(ArrTitleKey.Season(78874, 2), series.WithSeason(2).ToString());
        Assert.Equal(ArrTitleKey.Episode(78874, 0, 12), series.WithEpisode(0, 12).ToString());
        foreach (var key in new[] { "movie:tmdb:603", "tv:tvdb:78874", "tv:tvdb:78874:s1", "tv:tvdb:78874:s1:e2" })
        {
            Assert.True(ArrTitleKey.IsValid(key), key);
            Assert.Equal(key, TitleKey.Parse(key)!.ToString());
        }
        // Every feed key a season or episode change bumps includes the series key the status cache reads.
        Assert.Contains(series.ToString(), ArrTitleKey.WithParents(78874, 1, 2));
        Assert.Null(TitleKey.Parse("series:tvdb:78874"));
        Assert.Null(TitleKey.Parse("tv:tvdb:78874:s1e2"));
    }

    private static string Code(string body) => JsonDocument.Parse(body).RootElement.GetProperty("items")[0].GetProperty("reason").GetProperty("code").GetString()!;

    private static JsonElement? ProgressOf(string body)
        => JsonDocument.Parse(body).RootElement.GetProperty("items")[0].TryGetProperty("progress", out var p) ? p.Clone() : null;

    // Lets the store's background refreshes finish.
    private static async Task Settle(ArrStateStore store)
    {
        for (var i = 0; i < 300; i++)
        {
            if (store.Describe().Instances.All(x => x.Snapshots.All(s => !s.Refreshing))) return;
            await Task.Delay(10);
        }
        throw new TimeoutException("refreshes did not finish");
    }

    [Fact]
    public async Task AQueuePastItsServingLimitIsUnknownNotLiveAndTheFeedSaysSoAtExpiryAndRecovery()
    {
        using var rig = new Rig();
        var row = FakeArr.RadarrQueueRow(1, 101, "Alpha");
        row["sizeleft"] = 1160.0;                                  // 42 %
        rig.Radarr.Queue.Add(row);
        await rig.KeyAsync("movie:tmdb:101");
        var live = await rig.KeyAsync("movie:tmdb:101");
        Assert.Equal(("downloading", 42), (Code(live.Body), ProgressOf(live.Body)!.Value.GetProperty("percent").GetInt32()));
        Assert.True(ProgressOf(live.Body)!.Value.TryGetProperty("etaSeconds", out _));

        // Radarr stops answering. Within the longest serve time the old queue is still shown, but its
        // time left goes (it would count down from a read that is minutes old).
        rig.Radarr.FailWith = 503;
        rig.Arr.Now = rig.Arr.Now.AddMinutes(9);
        await rig.KeyAsync("movie:tmdb:101");
        await Settle(rig.Store);
        var stale = await rig.KeyAsync("movie:tmdb:101");
        Assert.Equal("downloading", Code(stale.Body));
        Assert.False(ProgressOf(stale.Body)!.Value.TryGetProperty("etaSeconds", out _));
        rig.Store.Tick();
        var before = rig.Feed.Revision("movie:tmdb:101");

        // Past it (10 minutes for the queue) with the latest read failed: unknown, never "Downloading
        // 42 %" frozen, nor "looking" or "not in any arr".
        rig.Arr.Now = rig.Arr.Now.AddMinutes(2);
        await rig.KeyAsync("movie:tmdb:101");
        await Settle(rig.Store);
        var expired = await rig.KeyAsync("movie:tmdb:101");
        Assert.Equal("service_down", Code(expired.Body));
        Assert.Null(ProgressOf(expired.Body));
        Assert.True(rig.Store.PipelineExpired(rig.RadarrConn));
        // The reconciler's next pass announces the expiry (no snapshot changed, yet every title of the
        // instance reads differently now).
        rig.Store.Tick();
        Assert.True(rig.Feed.Revision("movie:tmdb:101") > before);

        // Radarr answers again: live again, and the recovery is announced too.
        rig.Radarr.FailWith = 0;
        rig.Arr.Now = rig.Arr.Now.AddMinutes(6);
        await rig.KeyAsync("movie:tmdb:101");
        await Settle(rig.Store);
        var back = await rig.KeyAsync("movie:tmdb:101");
        Assert.Equal("downloading", Code(back.Body));
        var expiredAt = rig.Feed.Revision("movie:tmdb:101");
        await Task.WhenAll(rig.Store.Tick());
        Assert.False(rig.Store.PipelineExpired(rig.RadarrConn));
        Assert.True(rig.Feed.Revision("movie:tmdb:101") > expiredAt);
    }

    [Fact]
    public async Task AQueueThatWasNeverReadAndCantBeIsUnknownNotLooking()
    {
        using var rig = new Rig();
        // The library is read, the queue never: Radarr's queue route fails from the start.
        await rig.Store.GetLibraryAsync(rig.RadarrConn, default);
        rig.Radarr.Before = (path, ct) => path.Contains("/queue", StringComparison.Ordinal) ? throw new HttpRequestException("boom") : Task.CompletedTask;
        await rig.KeyAsync("movie:tmdb:101");
        await Settle(rig.Store);
        Assert.Equal("service_down", Code((await rig.KeyAsync("movie:tmdb:101")).Body));
        Assert.True(rig.Store.PipelineExpired(rig.RadarrConn));
        rig.Radarr.Before = null;
        rig.Arr.Now = rig.Arr.Now.AddMinutes(1);
        await rig.KeyAsync("movie:tmdb:101");
        await Settle(rig.Store);
        Assert.Equal("looking", Code((await rig.KeyAsync("movie:tmdb:101")).Body));
        Assert.False(rig.Store.PipelineExpired(rig.RadarrConn));
    }

    [Fact]
    public async Task AHistoryReadFailingPastItsThirtyMinutesMakesTheTitleUnknownToo()
    {
        using var rig = new Rig();
        await rig.KeyAsync("movie:tmdb:101");
        Assert.Equal("looking", Stage((await rig.KeyAsync("movie:tmdb:101")).Body));
        // Only the history fails; the queue keeps being read. Under 30 minutes: still looking.
        rig.Radarr.Before = (path, ct) => path.Contains("/history", StringComparison.Ordinal) ? throw new HttpRequestException("boom") : Task.CompletedTask;
        rig.Arr.Now = rig.Arr.Now.AddMinutes(29);
        await rig.KeyAsync("movie:tmdb:101");
        await Settle(rig.Store);
        Assert.Equal("looking", Code((await rig.KeyAsync("movie:tmdb:101")).Body));
        rig.Arr.Now = rig.Arr.Now.AddMinutes(2);
        await rig.KeyAsync("movie:tmdb:101");
        await Settle(rig.Store);
        Assert.Equal("service_down", Code((await rig.KeyAsync("movie:tmdb:101")).Body));
        // The library itself is still served as it was (only the downloads are unknown).
        Assert.NotNull((await rig.Store.GetLibraryAsync(rig.RadarrConn, default)).Value);
    }

    [Fact]
    public async Task AnExpiredHistorysLastFailureNeverDecidesWhereATitleIsNow()
    {
        using var rig = new Rig();
        rig.Radarr.History.Add(FakeArr.HistoryRow(1, "downloadFailed", rig.Arr.Now.UtcDateTime.AddHours(-1), "dl9", 101, "Alpha"));
        await rig.KeyAsync("movie:tmdb:101");
        await Settle(rig.Store);
        Assert.Equal("failed", Code((await rig.KeyAsync("movie:tmdb:101")).Body));
        // The history can't be read for more than 30 minutes: Radarr may have grabbed another copy
        // since, so the old failure says nothing about now.
        rig.Radarr.Before = (path, ct) => path.Contains("/history", StringComparison.Ordinal) ? throw new HttpRequestException("boom") : Task.CompletedTask;
        rig.Arr.Now = rig.Arr.Now.AddMinutes(29);
        await rig.KeyAsync("movie:tmdb:101");
        await Settle(rig.Store);
        rig.Arr.Now = rig.Arr.Now.AddMinutes(2);
        await rig.KeyAsync("movie:tmdb:101");
        await Settle(rig.Store);
        Assert.Equal("service_down", Code((await rig.KeyAsync("movie:tmdb:101")).Body));
    }

    [Fact]
    public async Task AnExpiredHistorysLastImportNeverSaysAlmostReady()
    {
        using var rig = new Rig();
        // Radarr says no file; its history has an import an hour ago: almost ready (the file is on its way).
        rig.Radarr.History.Add(FakeArr.HistoryRow(1, "downloadFolderImported", rig.Arr.Now.UtcDateTime.AddHours(-1), "dl9", 101, "Alpha"));
        await rig.KeyAsync("movie:tmdb:101");
        await Settle(rig.Store);
        Assert.Equal("library_pending", Code((await rig.KeyAsync("movie:tmdb:101")).Body));
        // The history can't be read for more than 30 minutes: that import says nothing about now.
        rig.Radarr.Before = (path, ct) => path.Contains("/history", StringComparison.Ordinal) ? throw new HttpRequestException("boom") : Task.CompletedTask;
        rig.Arr.Now = rig.Arr.Now.AddMinutes(29);
        await rig.KeyAsync("movie:tmdb:101");
        await Settle(rig.Store);
        rig.Arr.Now = rig.Arr.Now.AddMinutes(2);
        await rig.KeyAsync("movie:tmdb:101");
        await Settle(rig.Store);
        Assert.Equal("service_down", Code((await rig.KeyAsync("movie:tmdb:101")).Body));
    }

    [Fact]
    public async Task WithTheQueueUnknownAFreshHistorysFailureDoesNotDecideEither()
    {
        using var rig = new Rig();
        rig.Radarr.History.Add(FakeArr.HistoryRow(1, "downloadFailed", rig.Arr.Now.UtcDateTime.AddHours(-1), "dl9", 101, "Alpha"));
        await rig.KeyAsync("movie:tmdb:101");
        await Settle(rig.Store);
        Assert.Equal("failed", Code((await rig.KeyAsync("movie:tmdb:101")).Body));
        // Only the queue fails, past its 10 minutes: what it is downloading now is unknown.
        rig.Radarr.Before = (path, ct) => path.Contains("/queue", StringComparison.Ordinal) ? throw new HttpRequestException("boom") : Task.CompletedTask;
        rig.Arr.Now = rig.Arr.Now.AddMinutes(11);
        await rig.KeyAsync("movie:tmdb:101");
        await Settle(rig.Store);
        Assert.Equal("service_down", Code((await rig.KeyAsync("movie:tmdb:101")).Body));
    }

    [Fact]
    public async Task AQueueReadFailingInsideItsServingLimitAnnouncesItsDownloads()
    {
        using var rig = new Rig();
        rig.Radarr.Queue.Add(FakeArr.RadarrQueueRow(1, 101, "Alpha"));
        await rig.KeyAsync("movie:tmdb:101");
        await Settle(rig.Store);
        Assert.True(ProgressOf((await rig.KeyAsync("movie:tmdb:101")).Body)!.Value.TryGetProperty("etaSeconds", out _));
        var before = rig.Feed.Revision("movie:tmdb:101");
        // The next queue read fails, well inside the 10 minutes: the queue is still shown, but its
        // time left goes; an open page hears about it at once (not at expiry).
        rig.Radarr.FailWith = 503;
        rig.Arr.Now = rig.Arr.Now.AddMinutes(2);
        await rig.Store.RefreshForEventAsync(rig.RadarrConn.Id, ArrSnapshotKind.Queue, force: true);
        Assert.False(rig.Store.PipelineExpired(rig.RadarrConn));
        var failing = rig.Feed.Revision("movie:tmdb:101");
        Assert.True(failing > before);
        Assert.False(ProgressOf((await rig.KeyAsync("movie:tmdb:101")).Body)!.Value.TryGetProperty("etaSeconds", out _));
        // Read again: announced too (the time left is back, though the queue didn't change).
        rig.Radarr.FailWith = 0;
        rig.Arr.Now = rig.Arr.Now.AddSeconds(30);
        await rig.Store.RefreshForEventAsync(rig.RadarrConn.Id, ArrSnapshotKind.Queue, force: true);
        Assert.True(rig.Feed.Revision("movie:tmdb:101") > failing);
    }

    [Fact]
    public async Task AQueueReadFailingInsideFreshDropsItsEtaAndAnnouncesItsDownloads()
    {
        using var rig = new Rig();
        rig.Radarr.Queue.Add(FakeArr.RadarrQueueRow(1, 101, "Alpha"));
        await rig.KeyAsync("movie:tmdb:101");
        await Settle(rig.Store);
        var good = ProgressOf((await rig.KeyAsync("movie:tmdb:101")).Body)!.Value;
        Assert.Equal(50, good.GetProperty("percent").GetInt32());
        Assert.Equal(120, good.GetProperty("etaSeconds").GetInt64());
        var before = rig.Feed.Revision("movie:tmdb:101");
        // The held queue is still inside Fresh, but the latest read failed: its ETA is unknown.
        rig.Radarr.FailWith = 503;
        rig.Arr.Now = rig.Arr.Now.AddSeconds(10);
        await rig.Store.RefreshForEventAsync(rig.RadarrConn.Id, ArrSnapshotKind.Queue, force: true);
        Assert.False(rig.Store.PipelineExpired(rig.RadarrConn));
        Assert.True(rig.Feed.Revision("movie:tmdb:101") > before);
        var held = ProgressOf((await rig.KeyAsync("movie:tmdb:101")).Body)!.Value;
        Assert.Equal(50, held.GetProperty("percent").GetInt32());
        Assert.False(held.TryGetProperty("etaSeconds", out _));
    }

    [Fact]
    public async Task EveryQueueReadStampsItsClocksInOrderEvenWhenItsThreadIsLate()
    {
        using var rig = new Rig();
        // A blocked import JE has watched for 7 hours.
        var row = FakeArr.RadarrQueueRow(1, 101, "Alpha", state: "importBlocked", status: "warning");
        rig.Radarr.Queue.Add(row);
        await rig.Store.GetQueueAsync(rig.RadarrConn, default);
        rig.Arr.Now = rig.Arr.Now.AddHours(7);
        // Read 2 sees it healthy; its thread is descheduled right after publishing.
        row["trackedDownloadState"] = "importPending";
        row["trackedDownloadStatus"] = "ok";
        using var held = new SemaphoreSlim(0);
        using var entered = new SemaphoreSlim(0);
        var once = 0;
        rig.Store.QueueRefreshedHook = (_, _) =>
        {
            if (Interlocked.Exchange(ref once, 1) != 0) return;
            entered.Release();
            held.Wait(TimeSpan.FromSeconds(10));
        };
        var second = Task.Run(() => rig.Store.RefreshForEventAsync(rig.RadarrConn.Id, ArrSnapshotKind.Queue, force: true));
        Assert.True(await entered.WaitAsync(TimeSpan.FromSeconds(10)));
        // Read 3 (published while read 2's thread still waits) sees it blocked again: a new problem.
        row["trackedDownloadState"] = "importBlocked";
        row["trackedDownloadStatus"] = "warning";
        rig.Arr.Now = rig.Arr.Now.AddMinutes(1);
        var third = rig.Arr.Now.UtcDateTime;
        await rig.Store.RefreshForEventAsync(rig.RadarrConn.Id, ArrSnapshotKind.Queue, force: true);
        held.Release();
        await second;
        // Later on, the new problem is as old as read 3: neither the 7-hour-old clock nor reset by
        // read 2's thread finishing after it.
        rig.Arr.Now = rig.Arr.Now.AddMinutes(5);
        var now = rig.Store.PeekQueue(rig.RadarrConn.Id)!.Records.Single();
        Assert.Equal("importBlocked", now.TrackedDownloadState);
        Assert.Equal(third, rig.Store.QueueSeen(rig.RadarrConn, now).AttentionSince);
    }

    [Fact]
    public async Task QueueRowClocksStartWhenJeFirstSeesThemNotAtTheGrabAndSurviveReads()
    {
        using var rig = new Rig();
        var row = FakeArr.RadarrQueueRow(1, 101, "Alpha", state: "importBlocked", status: "warning");
        row["added"] = rig.Arr.Now.UtcDateTime.AddHours(-7).ToString("o");
        rig.Radarr.Queue.Add(row);
        var first = rig.Arr.Now.UtcDateTime;
        await rig.Store.GetQueueAsync(rig.RadarrConn, default);
        ArrQueueEntry Held() => rig.Store.PeekQueue(rig.RadarrConn.Id)!.Records.Single();
        Assert.Equal(first, rig.Store.QueueSeen(rig.RadarrConn, Held()).AttentionSince);
        // Repeated reads and progress moving don't reset it.
        rig.Arr.Now = rig.Arr.Now.AddHours(1);
        row["sizeleft"] = 10.0;
        await rig.Store.RefreshForEventAsync(rig.RadarrConn.Id, ArrSnapshotKind.Queue, force: true);
        Assert.Equal(first, rig.Store.QueueSeen(rig.RadarrConn, Held()).AttentionSince);
        // Healthy again, then blocked again: a new problem, a new clock.
        row["trackedDownloadState"] = "importPending";
        row["trackedDownloadStatus"] = "ok";
        rig.Arr.Now = rig.Arr.Now.AddHours(1);
        await rig.Store.RefreshForEventAsync(rig.RadarrConn.Id, ArrSnapshotKind.Queue, force: true);
        Assert.Null(rig.Store.QueueSeen(rig.RadarrConn, Held()).AttentionSince);
        row["trackedDownloadState"] = "importBlocked";
        row["trackedDownloadStatus"] = "warning";
        rig.Arr.Now = rig.Arr.Now.AddHours(1);
        await rig.Store.RefreshForEventAsync(rig.RadarrConn.Id, ArrSnapshotKind.Queue, force: true);
        Assert.Equal(rig.Arr.Now.UtcDateTime, rig.Store.QueueSeen(rig.RadarrConn, Held()).AttentionSince);
        // The status says so; a restart (a new store) under-reports, never over-reports.
        var status = await rig.Service.ForBatchAsync(rig.Admin, Array.Empty<Guid>(), new[] { TitleKey.Parse("movie:tmdb:101")! }, default);
        Assert.Contains("\"since\":\"" + rig.Arr.Now.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", System.Globalization.CultureInfo.InvariantCulture) + "\"", Encoding.UTF8.GetString(status.Json));
        var restarted = rig.Arr.Store();
        await restarted.GetQueueAsync(rig.RadarrConn, default);
        rig.Arr.Now = rig.Arr.Now.AddMinutes(5);
        Assert.True(restarted.QueueSeen(rig.RadarrConn, restarted.PeekQueue(rig.RadarrConn.Id)!.Records.Single()).AttentionSince > rig.Arr.Now.UtcDateTime.AddMinutes(-6));
    }

    [Fact]
    public void ASeasonPacksProblemIsTimedFromItsEarliestProblemEpisode()
    {
        var instance = new ArrConnection { Id = "s", Kind = ArrKind.Sonarr, Name = "TV", Url = "http://sonarr.lan" };
        var t0 = new DateTime(2026, 10, 12, 8, 0, 0, DateTimeKind.Utc);
        ArrQueueEntry Ep(int id, string state, string health) => new() { Id = id, DownloadId = "pack", Status = "completed", TrackedDownloadState = state, TrackedDownloadStatus = health, SeriesId = 7, EpisodeId = 70 + id, SeasonNumber = 1, EpisodeNumber = id, Added = t0.AddHours(-9) };
        var queue = new ArrQueueSnapshot { Records = new[] { Ep(1, "importPending", "ok"), Ep(2, "importBlocked", "warning"), Ep(3, "importBlocked", "warning") }, TotalRecords = 3 };
        var seen = new Dictionary<int, ArrQueueSeen>
        {
            [1] = new(ArrQueueClass.Importing, t0, null),
            [2] = new(ArrQueueClass.ImportBlocked, t0.AddHours(2), t0.AddHours(2)),
            [3] = new(ArrQueueClass.ImportBlocked, t0.AddHours(1), t0.AddHours(1)),
        };
        var group = Assert.Single(NeedsAttention.Group(instance, queue, null, r => seen[r.Id]));
        Assert.Equal((AttentionCode.ImportBlocked, t0.AddHours(1)), (group.Problem, group.AttentionSince!.Value));
        var item = Assert.Single(NeedsAttention.Derive(t0.AddHours(3), 10, 10, new[] { new AttentionInstance(instance) { Queue = new[] { group } } }, Array.Empty<BridgeMissing>(), Array.Empty<HandoffFact>()));
        Assert.Equal((t0.AddHours(1), (DateTime?)t0.AddHours(-9)), (item.Since!.Value, item.Occurred));
        // An instance whose queue expired gives no download rows (what it shows isn't now).
        Assert.Empty(NeedsAttention.Derive(t0.AddHours(3), 10, 10, new[] { new AttentionInstance(instance) { Queue = new[] { group }, QueueExpired = true } }, Array.Empty<BridgeMissing>(), Array.Empty<HandoffFact>()));
    }

    [Fact]
    public async Task ALiveLibraryPatchRefreshesTheCachedStatusThroughTheFeedRevision()
    {
        using var rig = new Rig();
        // The first read loads the library cold; its first load announces the titles it holds
        // (that read may have said "loading"), so the read after it composes once more.
        await rig.KeyAsync("movie:tmdb:101");
        var first = await rig.KeyAsync("movie:tmdb:101");
        Assert.Equal("looking", Stage(first.Body));
        Assert.Equal(first.ETag, (await rig.KeyAsync("movie:tmdb:101")).ETag);   // cached
        var loadedAt = (await rig.Store.GetLibraryAsync(rig.RadarrConn, default)).LoadedAt;

        // SignalR: Radarr says the movie is no longer monitored (a partial resource).
        var old = rig.Store.PeekLibrary(rig.RadarrConn.Id)!.MovieById(1)!;
        Assert.True(rig.Store.PatchLibrary(rig.RadarrConn.Id, new[] { ArrStateLoaders.MergeMovie(old, new ArrWireMovie { Id = 1, Monitored = false }) }, Array.Empty<ArrSeriesEntry>(), Array.Empty<int>()));
        Assert.True(rig.Feed.Revision("movie:tmdb:101") > 0);

        var after = await rig.KeyAsync("movie:tmdb:101");
        Assert.NotEqual(first.ETag, after.ETag);
        Assert.Equal("notHere", Stage(after.Body));
        Assert.Equal(loadedAt, (await rig.Store.GetLibraryAsync(rig.RadarrConn, default)).LoadedAt);   // the patch kept the snapshot's age
    }

    [Fact]
    public async Task WithoutTheFeedRevisionAPatchedTitleWouldBeServedFromTheCache()
    {
        // The control for the test above: the snapshot stamps alone don't move on a live patch.
        using var rig = new Rig(withFeed: false);
        var first = await rig.KeyAsync("movie:tmdb:101");
        var old = rig.Store.PeekLibrary(rig.RadarrConn.Id)!.MovieById(1)!;
        rig.Store.PatchLibrary(rig.RadarrConn.Id, new[] { ArrStateLoaders.MergeMovie(old, new ArrWireMovie { Id = 1, Monitored = false }) }, Array.Empty<ArrSeriesEntry>(), Array.Empty<int>());
        Assert.Equal(first.ETag, (await rig.KeyAsync("movie:tmdb:101")).ETag);
    }

    [Fact]
    public void LivePatchesKeepTheStatusFactsAPartialResourceLeavesOutAndSeeTheirChanges()
    {
        var full = ArrStateLoaders.ToMovie(new ArrWireMovie
        {
            Id = 1, TmdbId = 101, Title = "Alpha", Monitored = true, Status = "announced", IsAvailable = false, MinimumAvailability = "released",
            InCinemas = "2026-11-14T00:00:00Z", DigitalRelease = "2027-01-02T00:00:00Z", Added = "2026-10-01T00:00:00Z", LastSearchTime = "2026-10-11T00:00:00Z",
        });
        var partial = ArrStateLoaders.MergeMovie(full, new ArrWireMovie { Id = 1, Monitored = false });
        Assert.Equal("announced", partial.Status);
        Assert.False(partial.IsAvailable);
        Assert.Equal("released", partial.MinimumAvailability);
        Assert.Equal(full.InCinemas, partial.InCinemas);
        Assert.Equal(full.DigitalRelease, partial.DigitalRelease);
        Assert.Equal(full.Added, partial.Added);
        Assert.Equal(full.LastSearchTime, partial.LastSearchTime);
        Assert.Equal(101, partial.TmdbId);

        // The release moved on: the patch changes the facts and the change is seen.
        var released = ArrStateLoaders.MergeMovie(full, new ArrWireMovie { Id = 1, Status = "released", IsAvailable = true });
        Assert.True(released.IsAvailable);
        Assert.False(ArrLibraryFacts.Same(full, released));
        Assert.False(ArrLibraryFacts.Same(full, ArrStateLoaders.MergeMovie(full, new ArrWireMovie { Id = 1, IsAvailable = true })));
        Assert.False(ArrLibraryFacts.Same(full, ArrStateLoaders.MergeMovie(full, new ArrWireMovie { Id = 1, LastSearchTime = "2026-10-12T00:00:00Z" })));
        Assert.True(ArrLibraryFacts.Same(full, ArrStateLoaders.MergeMovie(full, new ArrWireMovie { Id = 1 })));

        var series = ArrStateLoaders.ToSeries(new ArrWireSeries
        {
            Id = 7, TvdbId = 700, Title = "Show", Status = "continuing", NextAiring = "2026-10-20T00:00:00Z",
            Seasons = new List<ArrWireSeason> { new() { SeasonNumber = 1, Monitored = true, Statistics = new ArrWireStatistics { EpisodeFileCount = 1, EpisodeCount = 2, TotalEpisodeCount = 2 } } },
        });
        var seriesPartial = ArrStateLoaders.MergeSeries(series, new ArrWireSeries { Id = 7, Monitored = true });
        Assert.Equal("continuing", seriesPartial.Status);
        Assert.Equal(series.NextAiring, seriesPartial.NextAiring);
        Assert.Equal(1, Assert.Single(seriesPartial.Seasons).EpisodeFileCount);
        var seasonDone = ArrStateLoaders.MergeSeries(series, new ArrWireSeries
        {
            Id = 7,
            Seasons = new List<ArrWireSeason> { new() { SeasonNumber = 1, Monitored = true, Statistics = new ArrWireStatistics { EpisodeFileCount = 2, EpisodeCount = 2, TotalEpisodeCount = 2 } } },
        });
        Assert.Equal(2, Assert.Single(seasonDone.Seasons).EpisodeFileCount);
        Assert.False(ArrLibraryFacts.Same(series, seasonDone));
        Assert.Equal(new[] { "tv:tvdb:700" }, ArrChangeDetector.Library(
            new ArrLibrarySnapshot(Array.Empty<ArrMovieEntry>(), new[] { series }, new Dictionary<int, string>()),
            new ArrLibrarySnapshot(Array.Empty<ArrMovieEntry>(), new[] { seasonDone }, new Dictionary<int, string>())));
    }

    [Fact]
    public async Task ASeriesEpisodeReadReachesTheFeedAndTheSeasonStatus()
    {
        using var rig = new Rig();
        var before = await rig.ItemAsync(rig.Season1);   // loads the library and the series' episodes (baseline)
        Assert.NotNull(rig.Store.PeekEpisodes(rig.SonarrConn, 7));
        var cursor = rig.Feed.Cursor;

        // Sonarr imported S01E02; its file event re-reads the series, and with it the episodes.
        rig.Sonarr.Episodes[1]["hasFile"] = true;
        rig.Sonarr.Series[0]["statistics"]!["episodeFileCount"] = 2;
        Assert.Equal(1, await rig.Store.RefreshTitlesAsync(rig.SonarrConn.Id, new[] { 7 }, default));
        await Until(() => rig.Store.PeekEpisodes(rig.SonarrConn, 7)!.Value!.Find(1, 2)!.HasFile);
        await Until(() => rig.Feed.Revision("tv:tvdb:700:s1:e2") > cursor);
        Assert.True(rig.Feed.Revision("tv:tvdb:700:s1") > cursor);
        Assert.True(rig.Feed.Revision("tv:tvdb:700") > cursor);
        Assert.Equal(0, rig.Feed.Revision("tv:tvdb:700:s1:e1"));   // unchanged episode

        var after = await rig.ItemAsync(rig.Season1);
        Assert.NotEqual(before.ETag, after.ETag);
        Assert.NotEqual(before.Body, after.Body);
    }

    [Fact]
    public void EpisodeChangesNeedTheSeriesInTheIndexAndABaseline()
    {
        var library = new ArrLibrarySnapshot(Array.Empty<ArrMovieEntry>(), new[] { new ArrSeriesEntry { Id = 7, TvdbId = 700, Title = "Show" } }, new Dictionary<int, string>());
        ArrEpisodesSnapshot Snap(params ArrEpisodeEntry[] e) => new(7, e);
        var a = Snap(new ArrEpisodeEntry { Id = 1, SeasonNumber = 1, EpisodeNumber = 1, HasFile = false, Monitored = true });
        Assert.Empty(ArrChangeDetector.Episodes(null, a, library));
        Assert.Empty(ArrChangeDetector.Episodes(a, a, library));
        Assert.Empty(ArrChangeDetector.Episodes(a, Snap(new ArrEpisodeEntry { Id = 1, SeasonNumber = 1, EpisodeNumber = 1, HasFile = true, Monitored = true }), null));
        Assert.Equal(
            new[] { "tv:tvdb:700:s1:e1", "tv:tvdb:700:s1", "tv:tvdb:700", "tv:tvdb:700:s2:e1", "tv:tvdb:700:s2" },
            ArrChangeDetector.Episodes(a, Snap(new ArrEpisodeEntry { Id = 1, SeasonNumber = 1, EpisodeNumber = 1, HasFile = false, Monitored = false }, new ArrEpisodeEntry { Id = 2, SeasonNumber = 2, EpisodeNumber = 1 }), library));
    }

    [Fact]
    public async Task UpdatesOfItemsJellyfinJustAddedAnnounceTheirTitleAgainOlderItemsDoNot()
    {
        // A new episode gets its numbers (and so its "Ready" on the season page) only when its
        // metadata is read, after ItemAdded: that ItemUpdated must reach the feed too.
        using var rig = new Rig();
        Assert.NotNull((await rig.Store.GetLibraryAsync(rig.RadarrConn, default)).Value);
        var library = new Mock<ILibraryManager>();
        var tracker = new ArrChangeTracker(rig.Store, rig.Feed, rig.Router, library.Object, null, () => rig.Arr.Plugin.Plugin.Configuration);
        await tracker.StartAsync(default);
        try
        {
            var fresh = new Movie { Id = Guid.NewGuid() };
            fresh.SetProviderId(MetadataProvider.Tmdb, "101");
            var old = new Movie { Id = Guid.NewGuid() };
            old.SetProviderId(MetadataProvider.Tmdb, "101");

            library.Raise(l => l.ItemUpdated += null, library.Object, new ItemChangeEventArgs { Item = old });
            Assert.Equal(0, tracker.FlushItems());   // an update of an item that was not just added

            library.Raise(l => l.ItemAdded += null, library.Object, new ItemChangeEventArgs { Item = fresh });
            Assert.Equal(1, tracker.FlushItems());
            var added = rig.Feed.Revision("movie:tmdb:101");
            library.Raise(l => l.ItemUpdated += null, library.Object, new ItemChangeEventArgs { Item = fresh });
            Assert.Equal(1, tracker.FlushItems());
            Assert.True(rig.Feed.Revision("movie:tmdb:101") > added);
        }
        finally
        {
            await tracker.StopAsync(default);
            tracker.Dispose();
        }
    }

    [Fact]
    public void AKeysRevisionNeverGoesBackWhenOldRevisionsAreDropped()
    {
        var feed = new ArrChangeFeed();
        feed.Bump(new[] { "movie:tmdb:1" });
        var early = feed.Revision("movie:tmdb:1");
        for (var i = 2; i <= 100_001; i++) feed.Bump(new[] { ArrTitleKey.Movie(i) });
        Assert.True(feed.Revision("movie:tmdb:1") >= early);
        Assert.True(feed.Revision("movie:tmdb:1") > 0);
    }

    // ---------------------------------------------------------------- review round (combined 1a+1b)

    [Fact]
    public async Task ATitleJellyfinKnowsOnlyByImdbFollowsItsArrCopysFeedKey()
    {
        // Jellyfin has Alpha only by IMDb id (tt101); Radarr holds it as tmdb 101, which is what the feed announces.
        using var rig = new Rig();
        var movie = Guid.NewGuid();
        rig.View.AddItem(new JfItemRef { ItemId = movie, Kind = "movie", Key = TitleKey.Parse("movie:imdb:tt101") });
        await rig.ItemAsync(movie);
        var first = await rig.ItemAsync(movie);
        var item = JsonDocument.Parse(first.Body).RootElement.GetProperty("items")[0];
        Assert.Equal("movie:imdb:tt101", item.GetProperty("key").GetString());
        Assert.Equal("movie:tmdb:101", item.GetProperty("liveKey").GetString());
        Assert.Equal(first.ETag, (await rig.ItemAsync(movie)).ETag);   // cached

        // SignalR: Radarr says the movie is no longer monitored (the snapshot keeps its age).
        var old = rig.Store.PeekLibrary(rig.RadarrConn.Id)!.MovieById(1)!;
        Assert.True(rig.Store.PatchLibrary(rig.RadarrConn.Id, new[] { ArrStateLoaders.MergeMovie(old, new ArrWireMovie { Id = 1, Monitored = false }) }, Array.Empty<ArrSeriesEntry>(), Array.Empty<int>()));
        // The title's own key never moves in the feed; its arr copy's key did, so the body is composed again.
        Assert.NotEqual(first.ETag, (await rig.ItemAsync(movie)).ETag);

        // A title already keyed by its feed key carries no second key.
        var byTmdb = JsonDocument.Parse((await rig.KeyAsync("movie:tmdb:101")).Body).RootElement.GetProperty("items")[0];
        Assert.False(byTmdb.TryGetProperty("liveKey", out _));
    }

    [Fact]
    public async Task JellyfinAddsOfTitlesKnownByAnotherIdAnnounceTheArrCopysKey()
    {
        using var rig = new Rig();
        rig.Sonarr.Series[0]["imdbId"] = "tt700";
        Assert.NotNull((await rig.Store.GetLibraryAsync(rig.RadarrConn, default)).Value);
        Assert.NotNull((await rig.Store.GetLibraryAsync(rig.SonarrConn, default)).Value);
        var library = new Mock<ILibraryManager>();
        var tracker = new ArrChangeTracker(rig.Store, rig.Feed, rig.Router, library.Object, null, () => rig.Arr.Plugin.Plugin.Configuration);
        await tracker.StartAsync(default);
        try
        {
            var movieRev = rig.Feed.Revision("movie:tmdb:101");
            var seriesRev = rig.Feed.Revision("tv:tvdb:700");
            var movie = new Movie { Id = Guid.NewGuid() };
            movie.SetProviderId(MetadataProvider.Imdb, "tt101");
            var series = new MediaBrowser.Controller.Entities.TV.Series { Id = Guid.NewGuid() };
            series.SetProviderId(MetadataProvider.Imdb, "tt700");
            library.Raise(l => l.ItemAdded += null, library.Object, new ItemChangeEventArgs { Item = movie });
            library.Raise(l => l.ItemAdded += null, library.Object, new ItemChangeEventArgs { Item = series });
            Assert.Equal(2, tracker.FlushItems());
            Assert.True(rig.Feed.Revision("movie:tmdb:101") > movieRev);
            Assert.True(rig.Feed.Revision("tv:tvdb:700") > seriesRev);
        }
        finally
        {
            await tracker.StopAsync(default);
            tracker.Dispose();
        }
    }

    [Fact]
    public async Task AFileEventDuringARunningEpisodesReadGetsAReadAfterIt()
    {
        using var rig = new Rig();
        await rig.ItemAsync(rig.Season1);   // loads the series' episodes
        Assert.False(rig.Store.PeekEpisodes(rig.SonarrConn, 7)!.Value!.Find(1, 2)!.HasFile);
        var reads = 0;
        var entered = new TaskCompletionSource();
        var release = new TaskCompletionSource();
        rig.Sonarr.Before = async (path, ct) =>
        {
            if (!path.EndsWith("/episode", StringComparison.Ordinal)) return;
            if (Interlocked.Increment(ref reads) == 1)
            {
                // A read already running: it reads the arr before the import below.
                entered.TrySetResult();
                await release.Task.WaitAsync(ct);
            }
            else
            {
                // Sonarr imported S01E02 while that read ran: every later read sees the file.
                rig.Sonarr.Episodes[1]["hasFile"] = true;
            }
        };
        Assert.Equal(1, await rig.Store.RefreshTitlesAsync(rig.SonarrConn.Id, new[] { 7 }, default));
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        // The import's file event re-reads the series while the episodes read still runs.
        Assert.Equal(1, await rig.Store.RefreshTitlesAsync(rig.SonarrConn.Id, new[] { 7 }, default));
        release.SetResult();
        await Until(() => rig.Store.PeekEpisodes(rig.SonarrConn, 7)!.Value!.Find(1, 2)!.HasFile);
        Assert.Equal(2, reads);
        rig.Sonarr.Before = null;
    }

    [Fact]
    public async Task ASeriesEditThatChangesItsSeasonsReReadsItsLoadedEpisodes()
    {
        using var rig = new Rig();
        await rig.ItemAsync(rig.Season1);   // loads the series' episodes
        var cursor = rig.Feed.Cursor;
        var episodeReads = rig.Arr.CallCount("sonarr.lan", "/episode");

        // A series edit that leaves the seasons alone (only the series' own monitored flag): no episode read.
        var old = rig.Store.PeekLibrary(rig.SonarrConn.Id)!.SeriesById(7)!;
        Assert.True(rig.Store.PatchLibrary(rig.SonarrConn.Id, Array.Empty<ArrMovieEntry>(), new[] { ArrStateLoaders.MergeSeries(old, new ArrWireSeries { Id = 7, Monitored = false }) }, Array.Empty<int>()));
        await Task.Delay(200);
        Assert.Equal(episodeReads, rig.Arr.CallCount("sonarr.lan", "/episode"));

        // Sonarr unmonitors season 1 (and with it its episodes) and broadcasts the series.
        foreach (var e in rig.Sonarr.Episodes) e["monitored"] = false;
        old = rig.Store.PeekLibrary(rig.SonarrConn.Id)!.SeriesById(7)!;
        var season = new List<ArrWireSeason> { new() { SeasonNumber = 1, Monitored = false, Statistics = new ArrWireStatistics { EpisodeFileCount = 1, EpisodeCount = 2, TotalEpisodeCount = 2 } } };
        Assert.True(rig.Store.PatchLibrary(rig.SonarrConn.Id, Array.Empty<ArrMovieEntry>(), new[] { ArrStateLoaders.MergeSeries(old, new ArrWireSeries { Id = 7, Seasons = season }) }, Array.Empty<int>()));
        await Until(() => !rig.Store.PeekEpisodes(rig.SonarrConn, 7)!.Value!.Find(1, 1)!.Monitored);
        await Until(() => rig.Feed.Revision("tv:tvdb:700:s1:e1") > cursor);
    }

    [Fact]
    public async Task AFirstLoadAnnouncesWhatItHoldsAndATooWideOneResetsEveryone()
    {
        using var rig = new Rig();
        Assert.Equal(0, rig.Feed.Revision("movie:tmdb:101"));
        Assert.NotNull((await rig.Store.GetLibraryAsync(rig.RadarrConn, default)).Value);
        Assert.True(rig.Feed.Revision("movie:tmdb:101") > 0);   // statuses served while it loaded re-read

        // The first read of a series' episodes announces the series (its seasons and episodes follow it).
        Assert.NotNull((await rig.Store.GetLibraryAsync(rig.SonarrConn, default)).Value);
        var series = rig.Feed.Revision("tv:tvdb:700");
        Assert.NotNull((await rig.Store.GetEpisodesAsync(rig.SonarrConn, 7, default)).Value);
        Assert.True(rig.Feed.Revision("tv:tvdb:700") > series);

        // A first load holding more titles than one feed read may carry: a reset for every client.
        var before = rig.Feed.Cursor;
        var many = Enumerable.Range(1, ArrChangeFeed.MaxKeysPerRead + 1).Select(i => new ArrMovieEntry { Id = i, TmdbId = 5000 + i, Title = "M" + i }).ToArray();
        Assert.Null(ArrChangeDetector.FirstLoad(ArrKind.Radarr, ArrSnapshotKind.Library, new ArrLibrarySnapshot(many, Array.Empty<ArrSeriesEntry>(), new Dictionary<int, string>()), null));
        rig.Tracker.OnSnapshotChanged(new ArrSnapshotChange(rig.RadarrConn, ArrSnapshotKind.Library, null, new ArrLibrarySnapshot(many, Array.Empty<ArrSeriesEntry>(), new Dictionary<int, string>()), null));
        Assert.Equal(0, rig.Feed.Revision("movie:tmdb:5001"));
        Assert.True(rig.Feed.Read(rig.Feed.Epoch, before).Reset);
        var now = rig.Feed.Read(rig.Feed.Epoch, rig.Feed.Cursor);
        Assert.False(now.Reset);
        Assert.Empty(now.Changes);
        // Later changes read normally after it.
        var at = rig.Feed.Cursor;
        rig.Feed.Bump(new[] { "movie:tmdb:9" });
        Assert.Equal(new[] { "movie:tmdb:9" }, rig.Feed.Read(rig.Feed.Epoch, at).Changes.Select(c => c.Key));
    }

    [Fact]
    public async Task LiveWorkWaitingWhenTheFeatureIsSwitchedOffMakesNoArrCalls()
    {
        using var rig = new Rig();
        rig.Sonarr.Series.Add(FakeArr.SeriesRow(8, 800, "Other"));
        Assert.NotNull((await rig.Store.GetLibraryAsync(rig.SonarrConn, default)).Value);
        Assert.NotNull((await rig.Store.GetQueueAsync(rig.SonarrConn, default)).Value);
        var config = rig.Arr.Plugin.Plugin.Configuration;
        var router = new ArrLiveRouter(rig.Store, null, TimeSpan.FromMilliseconds(150), () => config);
        var id = rig.SonarrConn.Id;

        // Hints gathered, then the switch goes off before they are flushed.
        var queueReads = rig.Arr.CallCount("sonarr.lan", "/queue");
        router.Hint(id, ArrLiveKinds.Queue, new[] { 7 });
        config.ArrPhase1Enabled = false;
        await Task.Delay(500);
        Assert.Equal(queueReads, rig.Arr.CallCount("sonarr.lan", "/queue"));
        Assert.Equal(0, rig.Arr.CallCount("sonarr.lan", "/series/7"));

        // Titles being re-read when the switch goes off: the rest of the batch and the next batch are not read.
        config.ArrPhase1Enabled = true;
        var entered = new TaskCompletionSource();
        var release = new TaskCompletionSource();
        rig.Sonarr.Before = async (path, ct) =>
        {
            if (path != "/api/v3/series/7") return;
            entered.TrySetResult();
            await release.Task.WaitAsync(ct);
        };
        router.Hint(id, ArrLiveKinds.None, new[] { 7, 8 });
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        router.Hint(id, ArrLiveKinds.None, new[] { 8 });
        await Task.Delay(300);   // the second hint's flush hands its title to the running reader
        config.ArrPhase1Enabled = false;
        release.SetResult();
        await Task.Delay(500);
        Assert.Equal(0, rig.Arr.CallCount("sonarr.lan", "/series/8"));
        rig.Sonarr.Before = null;
    }
}
