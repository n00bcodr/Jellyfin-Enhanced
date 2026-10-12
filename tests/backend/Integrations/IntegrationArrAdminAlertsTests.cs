using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Notify;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;

namespace JE.Tests;

/// <summary>
/// Phase 2's two halves together: the admin tools' Needs attention list feeds the administrators'
/// alerts (manual import needed, a request Seerr OK'd that no Sonarr/Radarr has, outages, low disk at
/// the admin tools' threshold, the stuck digest), and the Jellyfin bridge's targeted refresh brings a
/// requested title to "Ready" (and its alert) without a library scan or Jellyfin's metadata events.
/// </summary>
[Collection("Plugin singleton")]
public class IntegrationArrAdminAlertsTests
{
    private const string Dune = "movie:tmdb:693134";

    private static Dictionary<string, string> Params(string payload) => JsonSerializer.Deserialize<Dictionary<string, string>>(payload)!;

    private static async Task Until(Func<bool> check, int ms = 5000)
    {
        var end = DateTime.UtcNow.AddMilliseconds(ms);
        while (!check() && DateTime.UtcNow < end) await Task.Delay(10);
    }

    [Fact]
    public async Task AnImportTheBridgeRefreshesIntoJellyfinTellsTheRequesterWithoutALibraryScan()
    {
        using var rig = await IntegrationNotificationsTests.Started(r => r.Request(1, 693134, r.Emma));
        rig.Phones(rig.Emma);
        rig.Service.SubscribeBridge();
        rig.Bridge.Subscribe();
        var radarr = rig.Arr.Instance("RadarrZ");
        // The history is in memory before the import (the bridge never replays the first read).
        await rig.Store.GetHistoryAsync(radarr, default);
        await rig.Step(Dune);
        Assert.Empty(rig.Inbox(rig.Emma));

        // Radarr imports the file. Jellyfin's library has the movie folder's parent; the refresh of
        // that folder adds the movie (Jellyfin's item events would carry no provider ids yet).
        rig.Library.AddLibrary("Movies", "movies", "/data/movies");
        const string File = "/data/movies/Dune Part Two (2024)/Dune.Part.Two.mkv";
        rig.Library.AddFile(File, indexed: false, kind: "movie");
        Guid? item = null;
        rig.Library.DuringRefresh = _ =>
        {
            item = rig.Arrive(Dune);
            return Task.CompletedTask;
        };
        var import = FakeArr.HistoryRow(50, "downloadFolderImported", rig.Arr.Now.UtcDateTime, "dl50", 693134, "Dune Part Two");
        import["movieId"] = 2;
        import["data"] = new JsonObject { ["importedPath"] = File };
        rig.Radarr.History.Insert(0, import);
        await rig.Store.RefreshForEventAsync(radarr.Id, ArrSnapshotKind.History, force: true);
        await Until(() => rig.Bridge.Recent().Any(r => r.Found));
        var refresh = Assert.Single(rig.Library.Refreshes);
        Assert.Contains("/data/movies/Dune Part Two (2024)", refresh.Paths);

        // No explicit look at the title: the bridge's "indexed" made it due for the next round.
        await rig.Service.TickAsync(default, force: true);
        rig.Service.FlushBatches(rig.Arr.Now);
        await rig.Dispatcher.RunOnceAsync(default);
        var ready = Assert.Single(rig.Inbox(rig.Emma));
        Assert.Equal(("ready", item!.Value.ToString("N")), (ready.Kind, ready.ItemId));
        Assert.Single(rig.Pushes);
        Assert.Single(rig.Mail.Sent);
        // Once only: a second refresh of the same file tells nothing new.
        rig.Service.OnIndexed(Dune);
        await rig.Service.TickAsync(default, force: true);
        Assert.Single(rig.Inbox(rig.Emma));
    }

    [Fact]
    public async Task ATitleTheBridgeMarksWhileARoundTakesTheDueOnesKeepsItsTimer()
    {
        using var rig = await IntegrationNotificationsTests.Started(r => r.Request(1, 693134, r.Emma));
        var title = ArrTitleKey.TitleOf(Dune)!;
        rig.Service.OnIndexed(Dune);
        Task? bridge = null;
        rig.Service.AfterTake = () =>
        {
            rig.Service.AfterTake = null;
            // The bridge finds another import of the title on its refresh thread just as the round
            // has taken the last due title and is about to clear the timers.
            bridge = Task.Run(() => rig.Service.OnIndexed(Dune));
            bridge.Wait(300);
        };
        await rig.Service.TickAsync(default, force: true);
        await bridge!;
        // Still due with its timer running: the next round looks at it within seconds, not at the sweep.
        Assert.True(rig.Service.HasDirty(title));
    }

    [Fact]
    public async Task WithTheTargetedRefreshOffNothingIsRefreshedAndNothingIsAnnounced()
    {
        using var rig = await IntegrationNotificationsTests.Started(r => r.Request(1, 693134, r.Emma));
        rig.Config.ArrTargetedRefreshEnabled = false;
        rig.Service.SubscribeBridge();
        rig.Bridge.Subscribe();
        var radarr = rig.Arr.Instance("RadarrZ");
        await rig.Store.GetHistoryAsync(radarr, default);
        rig.Library.AddLibrary("Movies", "movies", "/data/movies");
        rig.Library.AddFile("/data/movies/Dune/Dune.mkv", indexed: false, kind: "movie");
        var import = FakeArr.HistoryRow(51, "downloadFolderImported", rig.Arr.Now.UtcDateTime, "dl51", 693134, "Dune Part Two");
        import["data"] = new JsonObject { ["importedPath"] = "/data/movies/Dune/Dune.mkv" };
        rig.Radarr.History.Insert(0, import);
        await rig.Store.RefreshForEventAsync(radarr.Id, ArrSnapshotKind.History, force: true);
        await Task.Delay(200);
        Assert.Empty(rig.Library.Refreshes);
        await rig.Service.TickAsync(default, force: true);
        Assert.Empty(rig.Inbox(rig.Emma));
    }

    [Fact]
    public async Task TheMinuteAdminCheckLeavesAnIdleQueueAtTheFiveMinutePaceNotTheDownloadsPagePace()
    {
        using var rig = await IntegrationNotificationsTests.Started();
        await rig.Service.AdminChecksAsync(default);
        // From here on nobody has a page open and the queue is empty: only the 1-minute admin check
        // and the reconciler (ticking every 10 seconds) run, for half an hour.
        var queue = rig.Arr.CallCount("radarr.lan", "/api/v3/queue");
        var history = rig.Arr.CallCount("radarr.lan", "/api/v3/history");
        var system = rig.Arr.CallCount("radarr.lan", "/api/v3/health");
        for (var second = 10; second <= 30 * 60; second += 10)
        {
            rig.Arr.Now = rig.Arr.Now.AddSeconds(10);
            await Task.WhenAll(rig.Store.Tick());
            if (second % 60 == 0) await rig.Service.AdminChecksAsync(default);
        }
        // Every 5 minutes (about 6 reads), not at the page's 30 seconds (about 60), and still kept
        // current (the check's interest keeps them refreshing at the idle pace).
        Assert.InRange(rig.Arr.CallCount("radarr.lan", "/api/v3/queue") - queue, 5, 7);
        Assert.InRange(rig.Arr.CallCount("radarr.lan", "/api/v3/history") - history, 5, 7);
        Assert.InRange(rig.Arr.CallCount("radarr.lan", "/api/v3/health") - system, 5, 7);

        // A page reading the queue brings it back to the page's pace.
        var before = rig.Arr.CallCount("radarr.lan", "/api/v3/queue");
        for (var second = 10; second <= 5 * 60; second += 10)
        {
            rig.Arr.Now = rig.Arr.Now.AddSeconds(10);
            if (second % 30 == 0) await rig.Store.GetQueueAsync(rig.Arr.Instance("RadarrZ"), default);
            await Task.WhenAll(rig.Store.Tick());
        }
        Assert.True(rig.Arr.CallCount("radarr.lan", "/api/v3/queue") - before >= 8);
    }

    [Fact]
    public async Task AManualImportNeededTellsAdministratorsOnceLinkedToTheOverviewAndNobodyElse()
    {
        using var rig = await IntegrationNotificationsTests.Started();
        rig.Phones(rig.Admin, rig.Emma);
        var radarr = rig.Arr.Instance("RadarrZ").Id;
        // Already blocked when the alerts start (an upgrade, or notifications just switched on): the
        // Overview lists it, nobody gets an alert for it.
        var old = FakeArr.RadarrQueueRow(5, 4343, "Old Film", state: "importBlocked", status: "warning");
        old["added"] = rig.Arr.Now.UtcDateTime.AddHours(-2).ToString("o");
        rig.Radarr.Queue.Add(old);
        await rig.Store.RefreshForEventAsync(radarr, ArrSnapshotKind.Queue, force: true);
        await rig.Service.AdminChecksAsync(default);
        Assert.Contains(await rig.Hub.NeedsAttentionAsync(default), a => a.Code == AttentionCode.ImportBlocked && a.Title == "Old Film");
        Assert.DoesNotContain(rig.Inbox(rig.Admin), n => n.Kind == NotifyKind.Attention);

        rig.Arr.Now = rig.Arr.Now.AddMinutes(1);
        var blocked = FakeArr.RadarrQueueRow(2, 693134, "Dune Part Two", state: "importBlocked", status: "warning");
        blocked["added"] = rig.Arr.Now.UtcDateTime.ToString("o");
        blocked["statusMessages"] = new JsonArray(new JsonObject { ["title"] = "Dune.Part.Two.mkv", ["messages"] = new JsonArray("Manual Import required") });
        rig.Radarr.Queue.Add(blocked);
        await rig.Store.RefreshForEventAsync(radarr, ArrSnapshotKind.Queue, force: true);

        // The Overview lists it; the alert says the same.
        var rows = await rig.Hub.NeedsAttentionAsync(default);
        var row = Assert.Single(rows, a => a.Code == AttentionCode.ImportBlocked && a.Title == "Dune Part Two");
        await rig.Service.AdminChecksAsync(default);
        await rig.Service.AdminChecksAsync(default);
        var alert = Assert.Single(rig.Inbox(rig.Admin), n => n.Kind == NotifyKind.Attention);
        var p = Params(alert.Payload);
        Assert.Equal((AttentionCode.ImportBlocked, "Dune Part Two", "RadarrZ", "Manual Import required"), (p["code"], p["title"], p["instance"], p["message"]));
        Assert.Equal(row.Key, alert.Key);
        Assert.Empty(rig.Inbox(rig.Emma));
        Assert.Equal("#/requests?tab=overview", NotifyDispatcher.InAppLink(null, NotifyKind.Attention));
        await rig.Dispatcher.RunOnceAsync(default);
        var push = Assert.Single(rig.Pushes);
        Assert.Equal("Dune Part Two needs a manual import", (string)push.Body["title"]!);
        Assert.Equal("https://jf.example/web/#/requests?tab=overview", (string)push.Body["click"]!);

        // A later download of the same title that is blocked again is a new occurrence.
        rig.Radarr.Queue.Clear();
        var again = FakeArr.RadarrQueueRow(3, 693134, "Dune Part Two", state: "importBlocked", status: "warning");
        rig.Arr.Now = rig.Arr.Now.AddMinutes(1);
        again["added"] = rig.Arr.Now.UtcDateTime.ToString("o");
        rig.Radarr.Queue.Add(again);
        await rig.Store.RefreshForEventAsync(radarr, ArrSnapshotKind.Queue, force: true);
        await rig.Service.AdminChecksAsync(default);
        Assert.Equal(2, rig.Inbox(rig.Admin).Count(n => n.Kind == NotifyKind.Attention));
        // A plain download warning is the Overview's business, not an alert.
        rig.Radarr.Queue.Clear();
        rig.Radarr.Queue.Add(FakeArr.RadarrQueueRow(4, 1, "Other Film", state: "downloading", status: "warning"));
        await rig.Store.RefreshForEventAsync(radarr, ArrSnapshotKind.Queue, force: true);
        Assert.Contains(await rig.Hub.NeedsAttentionAsync(default), a => a.Code == AttentionCode.DownloadWarning);
        await rig.Service.AdminChecksAsync(default);
        Assert.Equal(2, rig.Inbox(rig.Admin).Count(n => n.Kind == NotifyKind.Attention));
    }

    /// <summary>Adds an import-blocked download of a movie that started now and refreshes the queue.</summary>
    private static async Task Blocked(IntegrationNotificationsTests.Rig rig, int id, int tmdb, string title)
    {
        var row = FakeArr.RadarrQueueRow(id, tmdb, title, state: "importBlocked", status: "warning");
        row["added"] = rig.Arr.Now.UtcDateTime.ToString("o");
        rig.Radarr.Queue.Add(row);
        await rig.Store.RefreshForEventAsync(rig.Arr.Instance("RadarrZ").Id, ArrSnapshotKind.Queue, force: true);
    }

    private static int Attention(IntegrationNotificationsTests.Rig rig) => rig.Inbox(rig.Admin).Count(n => n.Kind == NotifyKind.Attention);

    [Fact]
    public async Task ARowStillListedIsNeverAlertedAgainAfterHousekeepingRemovedItsAlert()
    {
        using var rig = await IntegrationNotificationsTests.Started();
        await rig.Service.AdminChecksAsync(default);
        rig.Arr.Now = rig.Arr.Now.AddMinutes(1);
        await Blocked(rig, 2, 693134, "Dune Part Two");
        await rig.Service.AdminChecksAsync(default);
        Assert.Equal(1, Attention(rig));

        // Still blocked three months later: the inbox's housekeeping (90 days) removes the alert,
        // and the next checks don't send it again.
        rig.Arr.Now = rig.Arr.Now.AddDays(91);
        Assert.True(rig.NotifyStore.Purge(rig.Arr.Now, _ => true) > 0);
        Assert.Equal(0, Attention(rig));
        await rig.Store.RefreshForEventAsync(rig.Arr.Instance("RadarrZ").Id, ArrSnapshotKind.Queue, force: true);
        await rig.Service.AdminChecksAsync(default);
        Assert.Equal(0, Attention(rig));
        // Nor past the marks' own retention (400 days) while the row stays listed.
        for (var day = 0; day < 420; day += 30)
        {
            rig.Arr.Now = rig.Arr.Now.AddDays(30);
            rig.NotifyStore.Purge(rig.Arr.Now, _ => true);
            await rig.Store.RefreshForEventAsync(rig.Arr.Instance("RadarrZ").Id, ArrSnapshotKind.Queue, force: true);
            await rig.Service.AdminChecksAsync(default);
        }
        Assert.Equal(0, Attention(rig));
    }

    [Fact]
    public async Task SwitchingTheAlertsBackOnSendsNothingForRowsThatStartedWhileOffButARestartKeepsTheBaseline()
    {
        using var rig = await IntegrationNotificationsTests.Started();
        await rig.Service.AdminChecksAsync(default);

        // Switched off (the loop notices), downloads get blocked meanwhile, switched on again later.
        rig.Config.ArrNotificationsEnabled = false;
        await rig.Service.TickAsync(default);
        rig.Arr.Now = rig.Arr.Now.AddDays(14);
        await Blocked(rig, 2, 693134, "Dune Part Two");
        rig.Arr.Now = rig.Arr.Now.AddHours(1);
        await Blocked(rig, 3, 4343, "Old Film");
        // Jellyfin restarts while they are off: still counts as off.
        rig.Open();
        await rig.Service.TickAsync(default);
        rig.Config.ArrNotificationsEnabled = true;
        rig.Arr.Now = rig.Arr.Now.AddMinutes(5);
        await rig.Service.AdminChecksAsync(default);
        Assert.Equal(0, Attention(rig));
        Assert.Equal(2, (await rig.Hub.NeedsAttentionAsync(default)).Count(a => a.Code == AttentionCode.ImportBlocked));

        // From then on a new row alerts as before...
        rig.Arr.Now = rig.Arr.Now.AddMinutes(1);
        await Blocked(rig, 4, 5555, "New Film");
        await rig.Service.AdminChecksAsync(default);
        Assert.Equal(1, Attention(rig));
        // ...and a plain restart with the alerts on keeps the baseline: a row that started while
        // Jellyfin was down is told.
        rig.Arr.Now = rig.Arr.Now.AddMinutes(1);
        await Blocked(rig, 5, 6666, "Down Film");
        rig.Open();
        rig.Arr.Now = rig.Arr.Now.AddMinutes(2);
        await rig.Service.TickAsync(default);
        await rig.Service.AdminChecksAsync(default);
        Assert.Equal(2, Attention(rig));
    }

    [Fact]
    public async Task ARequestSeerrOkdThatNoArrHoldsAlertsAdministratorsAfterTheGraceOnce()
    {
        // An old request Seerr OK'd days ago that no Radarr holds is already listed when the alerts start.
        using var rig = await IntegrationNotificationsTests.Started(r =>
        {
            r.Request(6, 4141, r.Sam, status: 2, created: r.Arr.Now.UtcDateTime.AddDays(-2));
            r.Seerr.Movies[4242] = new JsonObject { ["title"] = "Lost Film", ["releaseDate"] = "2020-01-01" };
        });
        rig.Prefs(rig.Admin, p => p.HideTitles = true);
        rig.Phones(rig.Admin);
        await rig.Store.GetLibraryAsync(rig.Arr.Instance("RadarrZ"), default);
        await rig.Service.AdminChecksAsync(default);
        Assert.Contains(await rig.Hub.NeedsAttentionAsync(default), a => a.Code == AttentionCode.ApprovedNotInArr && a.Key == "movie:tmdb:4141");
        Assert.DoesNotContain(rig.Inbox(rig.Admin), n => n.Kind == NotifyKind.Attention);

        // Seerr OKs a new request for a movie Radarr doesn't have (Seerr's own Radarr settings wrong).
        rig.Arr.Now = rig.Arr.Now.AddMinutes(1);
        rig.Request(7, 4242, rig.Emma, status: 2, created: rig.Arr.Now.UtcDateTime);
        await rig.Requests.RefreshAsync(default);
        await rig.Service.AdminChecksAsync(default);
        Assert.DoesNotContain(rig.Inbox(rig.Admin), n => n.Kind == NotifyKind.Attention);

        rig.Arr.Now = rig.Arr.Now.AddMinutes(20);
        Assert.Contains(await rig.Hub.NeedsAttentionAsync(default), a => a.Code == AttentionCode.ApprovedNotInArr && a.Key == "movie:tmdb:4242");
        await rig.Service.AdminChecksAsync(default);
        await rig.Service.AdminChecksAsync(default);
        var alert = Assert.Single(rig.Inbox(rig.Admin), n => n.Kind == NotifyKind.Attention);
        var p = Params(alert.Payload);
        Assert.Equal((AttentionCode.ApprovedNotInArr, "movie:tmdb:4242"), (p["code"], alert.Key));
        Assert.DoesNotContain(rig.Inbox(rig.Emma), n => n.Kind == NotifyKind.Attention);
        // "Hide titles": the push says what happened, not which title or who asked.
        await rig.Dispatcher.RunOnceAsync(default);
        var push = Assert.Single(rig.Pushes);
        Assert.Equal("A request OK'd in Seerr reached no Sonarr/Radarr", (string)push.Body["title"]!);
        Assert.DoesNotContain("Lost Film", push.Body.ToJsonString(), StringComparison.Ordinal);
        Assert.DoesNotContain("Emma", push.Body.ToJsonString(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task LowDiskAlertsAtTheAdminToolsThresholdSoTheAlertAndTheOverviewAgree()
    {
        const long Gb = 1024L * 1024 * 1024;
        using var rig = await IntegrationNotificationsTests.Started(r =>
        {
            r.Radarr.DiskSpace.Add(new JsonObject { ["path"] = "/data", ["freeSpace"] = 15 * Gb, ["totalSpace"] = 100 * Gb });
            r.Radarr.RootFolders.Add(new JsonObject { ["path"] = "/data/movies", ["freeSpace"] = 15 * Gb, ["accessible"] = true });
        });
        // 15 % free: fine at the default 10 %.
        await rig.Service.AdminChecksAsync(default);
        await rig.Service.AdminChecksAsync(default);
        Assert.DoesNotContain(await rig.Hub.NeedsAttentionAsync(default), a => a.Code == AttentionCode.LowDisk);
        Assert.DoesNotContain(rig.Inbox(rig.Admin), n => n.Kind == NotifyKind.LowDisk);
        // One setting moves both.
        rig.Config.ArrLowDiskPercent = 20;
        Assert.Contains(await rig.Hub.NeedsAttentionAsync(default), a => a.Code == AttentionCode.LowDisk && a.Title == "/data/movies");
        await rig.Service.AdminChecksAsync(default);
        var disk = Assert.Single(rig.Inbox(rig.Admin), n => n.Kind == NotifyKind.LowDisk);
        Assert.Equal(("/data/movies", "15", "15 GB"), (Params(disk.Payload)["path"], Params(disk.Payload)["percent"], Params(disk.Payload)["free"]));
        Assert.Equal("#/requests?tab=system", NotifyDispatcher.InAppLink(null, NotifyKind.LowDisk));
    }

    [Fact]
    public async Task WithoutTheAdminToolsTheAdministratorsChecksReadNothing()
    {
        using var rig = await IntegrationNotificationsTests.Started();
        var radarr = rig.Arr.Hosts["radarr.lan"];
        radarr.FailWith = 503;
        var service = new NotificationService(rig.NotifyStore, rig.Status, rig.Requests, rig.View, rig.Feed, rig.Store, rig.Users, rig.Dispatcher, null, null, () => rig.Config, () => rig.Arr.Now);
        var calls = rig.Arr.Calls.Count;
        rig.Arr.Now = rig.Arr.Now.AddMinutes(30);
        await service.AdminChecksAsync(default);
        await service.AdminChecksAsync(default);
        Assert.Equal(calls, rig.Arr.Calls.Count);
        Assert.Empty(rig.Inbox(rig.Admin));
        service.Dispose();
    }

    [Fact]
    public void AttentionTextsNameTheTitleOnlyWithoutHideTitles()
    {
        var blocked = new Dictionary<string, string> { ["code"] = AttentionCode.ImportBlocked, ["title"] = "Severance", ["scope"] = "S02E05", ["instance"] = "Sonarr", ["message"] = "Episode file already imported" };
        var shown = NotifyTexts.Render(NotifyKind.Attention, blocked, hideTitles: false);
        Assert.Equal("Severance S02E05 needs a manual import", shown.Title);
        Assert.Equal("Sonarr can't import it on its own. It says: Episode file already imported", shown.Body);
        var hidden = NotifyTexts.Render(NotifyKind.Attention, blocked, hideTitles: true);
        Assert.Equal(("A download needs a manual import", "Sonarr can't import it on its own."), (hidden.Title, hidden.Body));
        var handoff = new Dictionary<string, string> { ["code"] = AttentionCode.ApprovedNotInArr, ["title"] = "Dune", ["user"] = "Emma", ["variant"] = "4k" };
        var h = NotifyTexts.Render(NotifyKind.Attention, handoff, hideTitles: false);
        Assert.Equal(("Dune was OK'd in Seerr, but no 4K Sonarr/Radarr has it", "Asked for by Emma. Check Seerr's Sonarr/Radarr settings."), (h.Title, h.Body));
        Assert.True(NotifyKind.IsAdminKind(NotifyKind.Attention));
        Assert.Contains(NotifyKind.Attention, NotifyKind.AdminKinds);
        Assert.Equal("#/details?id=" + new string('a', 32), NotifyDispatcher.InAppLink(new string('a', 32), NotifyKind.Attention));
    }
}
