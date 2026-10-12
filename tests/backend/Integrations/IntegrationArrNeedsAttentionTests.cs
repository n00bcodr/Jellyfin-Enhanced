using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;

namespace JE.Tests;

/// <summary>
/// The Needs attention derivation (Requests &amp; downloads, phase 2) as a table: which facts the arrs
/// and Jellyfin state become which row, with which severity and fixes — and what stays quiet
/// (normal downloads, an import in progress, update notices, a live connection still within its
/// grace, imports Jellyfin will pick up soon). Plus how the queue becomes downloads (season packs
/// grouped, sizes counted once, the arr's words kept) and the "OK'd in Seerr, not in any arr" rows.
/// </summary>
public class IntegrationArrNeedsAttentionTests
{
    private static readonly DateTime Now = new(2026, 10, 12, 12, 0, 0, DateTimeKind.Utc);
    private static readonly ArrConnection Radarr = new() { Id = "6d0b7d1c-0000-4000-8000-0000000000b1", Kind = ArrKind.Radarr, Name = "Radarr", Url = "http://radarr.lan:7878" };
    private static readonly ArrConnection Sonarr = new() { Id = "6d0b7d1c-0000-4000-8000-0000000000b3", Kind = ArrKind.Sonarr, Name = "Sonarr", Url = "http://sonarr.lan:8989" };

    private static ArrQueueEntry Row(int id, string status = "downloading", string state = "downloading", string tracked = "ok", string timeLeft = "00:05:00", string[]? messages = null, string? downloadId = null, int? episode = null, double left = 400)
        => new()
        {
            Id = id, DownloadId = downloadId ?? "dl" + id, Status = status, TrackedDownloadState = state, TrackedDownloadStatus = tracked, TimeLeft = timeLeft,
            Size = 1000, SizeLeft = left, MovieId = episode == null ? 7 : null, SeriesId = episode == null ? null : 3, EpisodeId = episode == null ? null : 300 + episode,
            SeasonNumber = episode == null ? null : 2, EpisodeNumber = episode, Title = episode == null ? "Dune" : "Peacemaker", Year = episode == null ? 2021 : null,
            TmdbId = episode == null ? 438631 : null, TvdbId = episode == null ? null : 391153, StatusMessages = messages ?? Array.Empty<string>(),
            Added = Now.AddMinutes(-41), DownloadClient = "Mock SABnzbd",
        };

    private static List<AttentionItem> Derive(ArrConnection instance, ArrQueueSnapshot? queue = null, ArrSystemSnapshot? system = null, ArrHistorySnapshot? history = null, string? error = null, ArrLiveConnectionStatus? live = null, bool silent = false, IReadOnlyList<BridgeMissing>? missing = null, IReadOnlyList<HandoffFact>? handoffs = null)
        => NeedsAttention.Derive(Now, 10, 10, new[]
        {
            new AttentionInstance(instance) { Queue = NeedsAttention.Group(instance, queue, null), System = system, History = history, Error = error, Live = live, WebhookSilent = silent },
        }, missing ?? Array.Empty<BridgeMissing>(), handoffs ?? Array.Empty<HandoffFact>());

    public static TheoryData<string, string?, string?, string?> QueueRows() => new()
    {
        // name, expected code, severity, first fix
        { "downloading normally", null, null, null },
        { "queued in the client", null, null, null },
        { "importing", null, null, null },
        { "import blocked", AttentionCode.ImportBlocked, "error", AttentionFix.OpenInArr },
        { "import pending with the arr's warning", AttentionCode.ImportWaiting, "warning", AttentionFix.RetryImport },
        { "import failed", AttentionCode.ImportWaiting, "warning", AttentionFix.RetryImport },
        { "failed", AttentionCode.DownloadFailed, "error", AttentionFix.SearchNow },
        { "client unavailable", AttentionCode.ClientUnavailable, "error", AttentionFix.OpenSystem },
        { "arr warning (no peers)", AttentionCode.DownloadWarning, "warning", AttentionFix.RemoveSearch },
        { "client reports no time left", AttentionCode.DownloadStalled, "warning", AttentionFix.RemoveSearch },
        { "no time left but nothing left either", null, null, null },
    };

    private static ArrQueueEntry RowFor(string name) => name switch
    {
        "downloading normally" => Row(1),
        "queued in the client" => Row(1, status: "queued", timeLeft: "00:00:00"),
        "importing" => Row(1, status: "completed", state: "importPending", left: 0),
        "import blocked" => Row(1, status: "completed", state: "importBlocked", tracked: "warning", messages: new[] { "Manual Import required." }, left: 0),
        "import pending with the arr's warning" => Row(1, status: "completed", state: "importPending", tracked: "warning", messages: new[] { "Sample" }, left: 0),
        "import failed" => Row(1, status: "completed", state: "importFailed", left: 0),
        "failed" => Row(1, status: "failed", state: "failedPending", tracked: "error"),
        "client unavailable" => Row(1, status: "downloadClientUnavailable"),
        "arr warning (no peers)" => Row(1, status: "warning", tracked: "warning", messages: new[] { "The download client reports no peers" }),
        "client reports no time left" => Row(1, timeLeft: "00:00:00"),
        "no time left but nothing left either" => Row(1, timeLeft: "00:00:00", left: 0),
        _ => throw new ArgumentOutOfRangeException(nameof(name)),
    };

    [Theory]
    [MemberData(nameof(QueueRows))]
    public void QueueStatesTheArrReportsBecomeNeedsAttentionRows(string scenario, string? code, string? severity, string? fix)
    {
        var items = Derive(Radarr, new ArrQueueSnapshot { Records = new[] { RowFor(scenario) } });
        if (code == null)
        {
            Assert.Empty(items);
            return;
        }
        var item = Assert.Single(items);
        Assert.Equal((code, severity, fix), (item.Code, item.Severity, item.Fixes[0]));
        Assert.Equal(("Dune", 2021, "movie:tmdb:438631", "dl1", "Radarr", "/activity/queue"), (item.Title, item.Year, item.Key, item.DownloadId, item.Instance, item.ArrLink));
        // No first-seen clocks given: "since" is now, never the grab time (41 min ago); the grab
        // time is kept apart for the alert keys.
        Assert.Equal((Now, (DateTime?)Now.AddMinutes(-41)), (item.Since!.Value, item.Occurred));
        if (RowFor(scenario).StatusMessages.Count > 0) Assert.Equal(RowFor(scenario).StatusMessages[0], item.Message);
    }

    [Fact]
    public void ASeasonPackIsOneDownloadWithItsEpisodesAndItsSizeCountedOnce()
    {
        var rows = Enumerable.Range(1, 8).Select(e => Row(e, downloadId: "pack", episode: e, tracked: "warning", status: "warning", messages: new[] { "no peers" })).ToArray();
        var group = Assert.Single(NeedsAttention.Group(Sonarr, new ArrQueueSnapshot { Records = rows }, null));
        Assert.Equal(("S02E01–E08", 8, 8, 1000d, 60), (group.Scope, group.Episodes, group.Ids.Count, group.Size!.Value, group.Percent!.Value));
        Assert.Equal("tv:tvdb:391153:s2", group.Key);
        Assert.Equal(new[] { "remove", "remove_with_data", "search" }, group.Actions);
        var item = Assert.Single(Derive(Sonarr, new ArrQueueSnapshot { Records = rows }));
        // The row says how many episodes removing it affects (the Overview has no Activity answer to ask).
        Assert.Equal((AttentionCode.DownloadWarning, "S02E01–E08", "pack", 8), (item.Code, item.Scope, item.DownloadId, item.Episodes));
        Assert.Equal("S02 (2)", NeedsAttention.ScopeText(new[] { (2, 1), (2, 5) }));
        Assert.Equal("S01–S02 (3)", NeedsAttention.ScopeText(new[] { (1, 9), (2, 1), (2, 2) }));
        // Held by a delay profile: nothing to remove from the client.
        var delayed = Assert.Single(NeedsAttention.Group(Radarr, new ArrQueueSnapshot { Records = new[] { Row(1, status: "delay") } }, null));
        Assert.DoesNotContain("remove", delayed.Actions);
        // Retry import only where the arr itself retries.
        Assert.Contains("retry_import", Assert.Single(NeedsAttention.Group(Radarr, new ArrQueueSnapshot { Records = new[] { RowFor("import failed") } }, null)).Actions);
        Assert.DoesNotContain("retry_import", Assert.Single(NeedsAttention.Group(Radarr, new ArrQueueSnapshot { Records = new[] { RowFor("import blocked") } }, null)).Actions);
    }

    [Fact]
    public void HealthDiskAndRootFolderFactsBecomeRowsButUpdateNoticesDoNot()
    {
        var system = new ArrSystemSnapshot
        {
            Health = new[]
            {
                new ArrHealthEntry { Source = "IndexerRssCheck", Type = "error", Message = "No indexers available" },
                new ArrHealthEntry { Source = "DownloadClientCheck", Type = "warning", Message = "Unable to communicate" },
                new ArrHealthEntry { Source = "UpdateCheck", Type = "warning", Message = "New update is available" },
                new ArrHealthEntry { Source = "Something", Type = "notice", Message = "fyi" },
            },
            DiskSpace = new[]
            {
                new ArrDiskEntry { Path = "/", FreeSpace = 500, TotalSpace = 1000 },
                new ArrDiskEntry { Path = "/data/movies4k", FreeSpace = 60, TotalSpace = 1000 },
            },
            RootFolders = new[]
            {
                new ArrDiskEntry { Path = "/data/movies", FreeSpace = 500, Accessible = true },
                new ArrDiskEntry { Path = "/data/movies4k", FreeSpace = 60, Accessible = true },
                new ArrDiskEntry { Path = "/data/gone", Accessible = false },
                new ArrDiskEntry { Path = "/data/critical", FreeSpace = 20, Accessible = true },
            },
        };
        var items = Derive(Radarr, system: system);
        var expected = new[] { (AttentionCode.Health, "error", "IndexerRssCheck"), (AttentionCode.RootMissing, "error", "/data/gone"), (AttentionCode.LowDisk, "error", "/data/critical"), (AttentionCode.Health, "warning", "DownloadClientCheck"), (AttentionCode.LowDisk, "warning", "/data/movies4k") };
        Assert.Equal(expected.OrderBy(x => x.ToString()), items.Select(i => (i.Code, i.Severity, i.Title!)).OrderBy(x => x.ToString()));
        // Errors first.
        Assert.All(items.Take(3), i => Assert.Equal("error", i.Severity));
        var low = items.Single(i => i.Title == "/data/movies4k");
        Assert.Equal(("94", "60"), (low.Params!["used"], low.Params["free"]));
        Assert.Equal((94, 6, 60L, 1000L), NeedsAttention.DiskUse(system.RootFolders[1], system.DiskSpace));
        Assert.Null(NeedsAttention.DiskUse(new ArrDiskEntry { Path = "/x" }, Array.Empty<ArrDiskEntry>()));
    }

    [Fact]
    public void InstancesThatCantBeReadLiveConnectionsDownForLongAndSilentWebhooksAreRows()
    {
        Assert.Equal(AttentionCode.InstanceDown, Assert.Single(Derive(Radarr, error: "Connection refused")).Code);
        var down = new ArrLiveConnectionStatus { State = ArrLiveState.Waiting, Since = new DateTimeOffset(Now.AddMinutes(-11)), LastError = "refused" };
        Assert.Equal((AttentionCode.LiveDown, "refused"), (Assert.Single(Derive(Radarr, live: down)).Code, Assert.Single(Derive(Radarr, live: down)).Message));
        // Within ten minutes, or switched off: quiet.
        Assert.Empty(Derive(Radarr, live: new ArrLiveConnectionStatus { State = ArrLiveState.Waiting, Since = new DateTimeOffset(Now.AddMinutes(-5)) }));
        Assert.Empty(Derive(Radarr, live: new ArrLiveConnectionStatus { State = ArrLiveState.Off, Since = new DateTimeOffset(Now.AddDays(-1)) }));
        Assert.Equal(AttentionCode.WebhookSilent, Assert.Single(Derive(Radarr, silent: true)).Code);
    }

    [Fact]
    public void ImportsJellyfinHasntPickedUpShowAfterTheGraceWithTheRightFix()
    {
        BridgeMissing M(string problem, int minutes) => new()
        {
            InstanceId = Sonarr.Id, Instance = "Sonarr", Kind = "Sonarr", Title = "Severance", Key = "tv:tvdb:371980:s3:e4", Season = 3, Episode = 4,
            ArrPath = "/data/tv/Severance/Season 03/E4.mkv", JellyfinPath = "/media/tv/Severance/Season 03/E4.mkv", ImportedAt = Now.AddMinutes(-minutes), Problem = problem, Library = "Shows",
        };
        var items = Derive(Sonarr, missing: new[] { M("not_scanned", 12), M("not_visible", 30), M("not_scanned", 3) });
        Assert.Equal(2, items.Count);
        var scan = items.Single(i => i.Message == "not_scanned");
        Assert.Equal((AttentionCode.NotInJellyfin, "S03E04", AttentionFix.ScanNow, "/data/tv/Severance/Season 03/E4.mkv"), (scan.Code, scan.Scope, scan.Fixes[0], scan.ArrPath));
        Assert.Equal(new[] { AttentionFix.OpenSystem }, items.Single(i => i.Message == "not_visible").Fixes);
    }

    [Fact]
    public void AFailedDownloadTheArrCouldntReplaceIsARowUntilSomethingHappens()
    {
        ArrHistoryEntry H(int id, string type, int minutes, int episode) => new() { Id = id, EventType = type, Date = Now.AddMinutes(-minutes), SeriesId = 3, EpisodeId = 300 + episode, SeasonNumber = 2, EpisodeNumber = episode, Title = "Peacemaker", TvdbId = 391153, Message = "Aborted", SourceTitle = "Peacemaker.S02E05-GRP" };
        var history = new ArrHistorySnapshot { Records = new[] { H(5, "downloadFailed", 30, 5), H(4, "grabbed", 60, 5), H(3, "downloadFailed", 30, 6), H(2, "downloadFailed", 2000, 7) } };
        // E6 is back in the queue (the arr grabbed another copy): not a row. E7 failed over a day ago: not a row.
        var queue = new ArrQueueSnapshot { Records = new[] { Row(9, episode: 6) } };
        var item = Assert.Single(Derive(Sonarr, queue: queue, history: history));
        Assert.Equal((AttentionCode.DownloadFailed, "S02E05", "tv:tvdb:391153:s2:e5", "Aborted", AttentionFix.SearchNow), (item.Code, item.Scope, item.Key, item.Message, item.Fixes[0]));
        Assert.Null(item.DownloadId);
    }

    [Fact]
    public void OkdSeerrRequestsNoArrHoldsAreRowsAndErrorsComeFirst()
    {
        var items = Derive(Radarr, queue: new ArrQueueSnapshot { Records = new[] { RowFor("import blocked") } }, handoffs: new[] { new HandoffFact("movie:tmdb:27205", "Inception", 2010, true, Now.AddMinutes(-20), "Emma") });
        Assert.Equal(new[] { AttentionCode.ImportBlocked, AttentionCode.ApprovedNotInArr }, items.Select(i => i.Code));
        var h = items[1];
        Assert.Equal(("Inception", "Emma", AttentionFix.OpenSeerr, Now.AddMinutes(-20)), (h.Title, h.Message, h.Fixes[0], h.Since!.Value));
        // Ids are stable across reads.
        Assert.Equal(items.Select(i => i.Id), Derive(Radarr, queue: new ArrQueueSnapshot { Records = new[] { RowFor("import blocked") } }, handoffs: new[] { new HandoffFact("movie:tmdb:27205", "Inception", 2010, true, Now.AddMinutes(-20), "Emma") }).Select(i => i.Id));
    }
}
