using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire
{
    /// <summary>Needs-attention codes (Phase 2: only facts the arrs and Jellyfin state themselves).</summary>
    public static class AttentionCode
    {
        /// <summary>The arr says the download needs a manual import.</summary>
        public const string ImportBlocked = "import_blocked";
        /// <summary>Downloaded; the arr is waiting to import it and warns why.</summary>
        public const string ImportWaiting = "import_waiting";
        /// <summary>The download failed.</summary>
        public const string DownloadFailed = "download_failed";
        /// <summary>The arr warns about a download (no peers, stalled, …).</summary>
        public const string DownloadWarning = "download_warning";
        /// <summary>The download client reports no time left while data is still missing (no progress).</summary>
        public const string DownloadStalled = "download_stalled";
        /// <summary>The download client can't be reached.</summary>
        public const string ClientUnavailable = "client_unavailable";
        /// <summary>A root folder's disk is nearly full.</summary>
        public const string LowDisk = "low_disk";
        /// <summary>A root folder can't be reached by the arr.</summary>
        public const string RootMissing = "root_missing";
        /// <summary>One of the arr's own health checks.</summary>
        public const string Health = "health";
        /// <summary>The instance can't be read.</summary>
        public const string InstanceDown = "instance_down";
        /// <summary>The live connection to the instance has been down for a while.</summary>
        public const string LiveDown = "live_down";
        /// <summary>The webhook was set up but nothing arrived although the arr imported things.</summary>
        public const string WebhookSilent = "webhook_silent";
        /// <summary>Imported by the arr; Jellyfin has no item for the file.</summary>
        public const string NotInJellyfin = "not_in_jellyfin";
        /// <summary>Seerr OK'd a request a while ago; no Sonarr/Radarr has it.</summary>
        public const string ApprovedNotInArr = StatusReasonCode.ApprovedNotInArr;
    }

    /// <summary>Fixes a needs-attention row offers.</summary>
    public static class AttentionFix
    {
        /// <summary>Open the item (or queue, or system page) in the arr's own UI.</summary>
        public const string OpenInArr = "open_in_arr";
        /// <summary>Search now (the arr's own search command).</summary>
        public const string SearchNow = "search_now";
        /// <summary>Remove the download from the queue (keeping its data), blocklist it and search again.</summary>
        public const string RemoveSearch = "remove_search";
        /// <summary>Ask the arr to check its finished downloads again (its own command).</summary>
        public const string RetryImport = "retry_import";
        /// <summary>Refresh the Jellyfin folder of the file.</summary>
        public const string ScanNow = "scan_now";
        /// <summary>Open the System tab.</summary>
        public const string OpenSystem = "open_system";
        /// <summary>Check Seerr's own Sonarr/Radarr settings.</summary>
        public const string OpenSeerr = "open_seerr";
    }

    /// <summary>A download in the queue: the rows of one download id (a season pack is one download).</summary>
    public sealed class QueueGroup
    {
        /// <summary>Instance id.</summary>
        public string InstanceId { get; init; } = string.Empty;

        /// <summary>Instance name.</summary>
        public string Instance { get; init; } = string.Empty;

        /// <summary>Sonarr or Radarr.</summary>
        public string Kind { get; init; } = string.Empty;

        /// <summary>The download client's id (or "row:{id}" when the arr has none).</summary>
        public string DownloadId { get; init; } = string.Empty;

        /// <summary>The arr's queue row ids (change as rows change: not kept).</summary>
        public IReadOnlyList<int> Ids { get; init; } = Array.Empty<int>();

        /// <summary>Title.</summary>
        public string? Title { get; init; }

        /// <summary>Year (movies).</summary>
        public int? Year { get; init; }

        /// <summary>Title key (movie, or the episode / season in scope).</summary>
        public string? Key { get; init; }

        /// <summary>The arr's id of the movie or series.</summary>
        public int? ArrId { get; init; }

        /// <summary>TMDB id.</summary>
        public int? TmdbId { get; init; }

        /// <summary>TVDB id.</summary>
        public int? TvdbId { get; init; }

        /// <summary>Sonarr's title slug (its page address).</summary>
        public string? TitleSlug { get; init; }

        /// <summary>Episodes covered ("S02E05", "S02E01–E08").</summary>
        public string? Scope { get; init; }

        /// <summary>Number of episodes covered (series).</summary>
        public int Episodes { get; init; }

        /// <summary>Sonarr episode ids covered.</summary>
        public IReadOnlyList<int> EpisodeIds { get; init; } = Array.Empty<int>();

        /// <summary>Download client status (downloading, queued, paused, completed, failed, warning, delay, …).</summary>
        public string? Status { get; init; }

        /// <summary>The arr's pipeline state (downloading, importPending, importBlocked, …).</summary>
        public string? State { get; init; }

        /// <summary>ok, warning or error.</summary>
        public string? Health { get; init; }

        /// <summary>Percent done.</summary>
        public int? Percent { get; init; }

        /// <summary>Size (bytes).</summary>
        public double? Size { get; init; }

        /// <summary>Left (bytes).</summary>
        public double? SizeLeft { get; init; }

        /// <summary>Estimated completion (UTC).</summary>
        public DateTime? Eta { get; init; }

        /// <summary>Download client.</summary>
        public string? Client { get; init; }

        /// <summary>Quality.</summary>
        public string? Quality { get; init; }

        /// <summary>usenet or torrent.</summary>
        public string? Protocol { get; init; }

        /// <summary>Release name.</summary>
        public string? Release { get; init; }

        /// <summary>The arr's own messages (capped).</summary>
        public IReadOnlyList<string> Messages { get; init; } = Array.Empty<string>();

        /// <summary>When the arr added it.</summary>
        public DateTime? Added { get; init; }

        /// <summary>
        /// Since when (UTC) it has needed attention, as Jellyfin Enhanced first saw it (null: no
        /// problem, or no clock). After a restart it may be late, never early.
        /// </summary>
        public DateTime? AttentionSince { get; init; }

        /// <summary>What needs attention (<see cref="AttentionCode"/>), or null.</summary>
        public string? Problem { get; init; }

        /// <summary>Actions offered: remove, remove_with_data, search, retry_import.</summary>
        public IReadOnlyList<string> Actions { get; init; } = Array.Empty<string>();
    }

    /// <summary>One "needs attention" row.</summary>
    public sealed class AttentionItem
    {
        /// <summary>Stable id (code + instance + subject).</summary>
        public string Id { get; init; } = string.Empty;

        /// <summary><see cref="AttentionCode"/>.</summary>
        public string Code { get; init; } = string.Empty;

        /// <summary>error or warning.</summary>
        public string Severity { get; init; } = "warning";

        /// <summary>Instance id.</summary>
        public string? InstanceId { get; init; }

        /// <summary>Instance name.</summary>
        public string? Instance { get; init; }

        /// <summary>Title (or a root folder / health source).</summary>
        public string? Title { get; init; }

        /// <summary>Year.</summary>
        public int? Year { get; init; }

        /// <summary>Title key (Search now, Manage).</summary>
        public string? Key { get; init; }

        /// <summary>Episodes in scope.</summary>
        public string? Scope { get; init; }

        /// <summary>How many episodes the download covers (a season pack: the blast radius of removing it).</summary>
        public int Episodes { get; init; }

        /// <summary>Since when (UTC).</summary>
        public DateTime? Since { get; init; }

        /// <summary>
        /// When the subject began (a download: when the arr added it; otherwise <see cref="Since"/>):
        /// identifies one occurrence for the administrators' alerts. Not sent.
        /// </summary>
        [System.Text.Json.Serialization.JsonIgnore]
        public DateTime? Occurred { get; init; }

        /// <summary>The arr's (or Jellyfin's) own words.</summary>
        public string? Message { get; init; }

        /// <summary>Extra words (paths, percentages).</summary>
        public string? Detail { get; init; }

        /// <summary>Numbers for the texts (free percent, free bytes, …).</summary>
        public IReadOnlyDictionary<string, string>? Params { get; init; }

        /// <summary>Fixes (<see cref="AttentionFix"/>), first is the main one.</summary>
        public IReadOnlyList<string> Fixes { get; init; } = Array.Empty<string>();

        /// <summary>Page in the arr's UI for Open in Sonarr/Radarr ("/activity/queue", "/movie/603", …).</summary>
        public string? ArrLink { get; init; }

        /// <summary>The download (queue actions).</summary>
        public string? DownloadId { get; init; }

        /// <summary>The file or folder the arr imported (Scan now).</summary>
        public string? ArrPath { get; init; }
    }

    /// <summary>What one instance contributes to the derivation.</summary>
    internal sealed class AttentionInstance
    {
        public AttentionInstance(ArrConnection instance)
        {
            Instance = instance;
        }

        public ArrConnection Instance { get; }

        public ArrLibrarySnapshot? Library { get; init; }

        public IReadOnlyList<QueueGroup> Queue { get; init; } = Array.Empty<QueueGroup>();

        public ArrSystemSnapshot? System { get; init; }

        /// <summary>Recent history (failed downloads the arr couldn't replace).</summary>
        public ArrHistorySnapshot? History { get; init; }

        /// <summary>Why it can't be read (null: readable).</summary>
        public string? Error { get; init; }

        /// <summary>
        /// The queue or history is past its longest serve time and can't be read: their rows say
        /// nothing about now, so no download row comes from them (the instance's own row does).
        /// </summary>
        public bool QueueExpired { get; init; }

        /// <summary>The live connection (null: live updates not expected).</summary>
        public ArrLiveConnectionStatus? Live { get; init; }

        public bool WebhookSilent { get; init; }
    }

    /// <summary>An OK'd Seerr request no arr holds (<paramref name="FourK"/>: a 4K movie request no 4K Radarr holds).</summary>
    internal sealed record HandoffFact(string Key, string? Title, int? Year, bool IsMovie, DateTime ApprovedAt, string? RequestedBy, bool FourK = false);

    /// <summary>
    /// Derives the hub's Needs attention list (Phase 2 sources only: the arrs' health, queue states
    /// and disk figures, imports Jellyfin hasn't picked up, unreachable instances and silent live
    /// paths, and Seerr OK's no arr holds). Pure: the caller gathers the facts from memory.
    /// </summary>
    internal static class NeedsAttention
    {
        private static readonly TimeSpan LiveDownAfter = TimeSpan.FromMinutes(10);

        /// <summary>The rows, errors first, then oldest first.</summary>
        public static List<AttentionItem> Derive(DateTime now, int lowDiskPercent, int pendingMinutes, IReadOnlyList<AttentionInstance> instances, IReadOnlyList<BridgeMissing> notInJellyfin, IReadOnlyList<HandoffFact> handoffs)
        {
            var items = new List<AttentionItem>();
            foreach (var i in instances)
            {
                var c = i.Instance;
                if (i.Error != null)
                {
                    items.Add(new AttentionItem
                    {
                        Id = Id(AttentionCode.InstanceDown, c.Id), Code = AttentionCode.InstanceDown, Severity = "error", InstanceId = c.Id, Instance = c.Name,
                        Title = c.Name, Message = i.Error, Fixes = new[] { AttentionFix.OpenSystem, AttentionFix.OpenInArr }, ArrLink = "/system/status",
                    });
                }
                if (i.Live is { } live && live.State != ArrLiveState.Off && live.State != ArrLiveState.Connected && live.Since is DateTimeOffset since && now - since.UtcDateTime >= LiveDownAfter)
                {
                    items.Add(new AttentionItem
                    {
                        Id = Id(AttentionCode.LiveDown, c.Id), Code = AttentionCode.LiveDown, InstanceId = c.Id, Instance = c.Name, Title = c.Name,
                        Since = since.UtcDateTime, Message = live.LastError, Fixes = new[] { AttentionFix.OpenSystem },
                    });
                }
                if (i.WebhookSilent)
                {
                    items.Add(new AttentionItem
                    {
                        Id = Id(AttentionCode.WebhookSilent, c.Id), Code = AttentionCode.WebhookSilent, InstanceId = c.Id, Instance = c.Name, Title = c.Name,
                        Fixes = new[] { AttentionFix.OpenSystem },
                    });
                }
                foreach (var g in i.QueueExpired ? Array.Empty<QueueGroup>() : i.Queue)
                {
                    if (g.Problem == null) continue;
                    var fixes = g.Problem switch
                    {
                        AttentionCode.ImportBlocked => new[] { AttentionFix.OpenInArr, AttentionFix.RemoveSearch },
                        AttentionCode.ImportWaiting => new[] { AttentionFix.RetryImport, AttentionFix.OpenInArr, AttentionFix.RemoveSearch },
                        AttentionCode.DownloadFailed => new[] { AttentionFix.SearchNow, AttentionFix.OpenInArr },
                        AttentionCode.DownloadStalled => new[] { AttentionFix.RemoveSearch, AttentionFix.OpenInArr },
                        AttentionCode.ClientUnavailable => new[] { AttentionFix.OpenSystem, AttentionFix.OpenInArr },
                        _ => new[] { AttentionFix.RemoveSearch, AttentionFix.OpenInArr },
                    };
                    items.Add(new AttentionItem
                    {
                        Id = Id(g.Problem, c.Id, g.DownloadId),
                        Code = g.Problem,
                        Severity = g.Problem is AttentionCode.ImportBlocked or AttentionCode.DownloadFailed or AttentionCode.ClientUnavailable ? "error" : "warning",
                        InstanceId = c.Id, Instance = c.Name, Title = g.Title, Year = g.Year, Key = g.Key, Scope = g.Scope, Episodes = g.Episodes,
                        // "Since" is when JE first saw the problem; never the grab time (unknown: now).
                        Since = g.AttentionSince ?? now, Occurred = g.Added ?? g.AttentionSince,
                        Message = g.Messages.FirstOrDefault(), Detail = g.Messages.Count > 1 ? string.Join(" — ", g.Messages.Skip(1)) : null,
                        Fixes = fixes, ArrLink = "/activity/queue", DownloadId = g.DownloadId,
                        Params = g.Percent is int pct ? new Dictionary<string, string> { ["pct"] = pct.ToString(CultureInfo.InvariantCulture) } : null,
                    });
                }
                foreach (var f in i.QueueExpired ? Enumerable.Empty<AttentionItem>() : RecentFailures(c, i.History, i.Queue, now))
                {
                    items.Add(f);
                }
                if (i.System is { } system)
                {
                    foreach (var h in system.Health)
                    {
                        var type = (h.Type ?? string.Empty).ToLowerInvariant();
                        if (type is not ("warning" or "error")) continue;
                        // Update notices are the arr's own business; they show on the System tab.
                        if (string.Equals(h.Source, "UpdateCheck", StringComparison.OrdinalIgnoreCase)) continue;
                        items.Add(new AttentionItem
                        {
                            Id = Id(AttentionCode.Health, c.Id, h.Source ?? string.Empty, h.Message ?? string.Empty), Code = AttentionCode.Health,
                            Severity = type == "error" ? "error" : "warning", InstanceId = c.Id, Instance = c.Name, Title = h.Source,
                            Message = h.Message, Fixes = new[] { AttentionFix.OpenInArr, AttentionFix.OpenSystem }, ArrLink = "/system/status",
                        });
                    }
                    foreach (var root in system.RootFolders)
                    {
                        if (string.IsNullOrWhiteSpace(root.Path)) continue;
                        if (root.Accessible == false)
                        {
                            items.Add(new AttentionItem
                            {
                                Id = Id(AttentionCode.RootMissing, c.Id, root.Path), Code = AttentionCode.RootMissing, Severity = "error", InstanceId = c.Id, Instance = c.Name,
                                Title = root.Path, Fixes = new[] { AttentionFix.OpenInArr, AttentionFix.OpenSystem }, ArrLink = "/settings/mediamanagement",
                            });
                            continue;
                        }
                        if (DiskUse(root, system.DiskSpace) is not { } use || use.FreePercent >= lowDiskPercent) continue;
                        items.Add(new AttentionItem
                        {
                            Id = Id(AttentionCode.LowDisk, c.Id, root.Path), Code = AttentionCode.LowDisk,
                            Severity = use.FreePercent < lowDiskPercent / 2.0 ? "error" : "warning",
                            InstanceId = c.Id, Instance = c.Name, Title = root.Path,
                            Params = new Dictionary<string, string>
                            {
                                ["used"] = use.UsedPercent.ToString(CultureInfo.InvariantCulture),
                                ["free"] = use.Free.ToString(CultureInfo.InvariantCulture),
                            },
                            Fixes = new[] { AttentionFix.OpenSystem },
                        });
                    }
                }
            }

            foreach (var m in notInJellyfin)
            {
                if (now - m.ImportedAt < TimeSpan.FromMinutes(pendingMinutes)) continue;
                var scope = m.Season is int s ? "S" + s.ToString("00", CultureInfo.InvariantCulture) + (m.Episode is int e ? "E" + e.ToString("00", CultureInfo.InvariantCulture) : string.Empty) : null;
                items.Add(new AttentionItem
                {
                    Id = Id(AttentionCode.NotInJellyfin, m.InstanceId, m.ArrPath), Code = AttentionCode.NotInJellyfin,
                    InstanceId = m.InstanceId, Instance = m.Instance, Title = m.Title, Year = m.Year, Key = m.Key, Scope = scope, Since = m.ImportedAt,
                    Message = m.Problem, Detail = m.JellyfinPath,
                    Fixes = m.Problem == "not_scanned" ? new[] { AttentionFix.ScanNow, AttentionFix.OpenSystem } : new[] { AttentionFix.OpenSystem },
                    ArrPath = m.ArrPath,
                    Params = m.Library != null ? new Dictionary<string, string> { ["library"] = m.Library } : null,
                });
            }

            foreach (var h in handoffs)
            {
                items.Add(new AttentionItem
                {
                    Id = Id(AttentionCode.ApprovedNotInArr, h.FourK ? h.Key + "|4k" : h.Key), Code = AttentionCode.ApprovedNotInArr, Title = h.Title, Year = h.Year, Key = h.Key,
                    Since = h.ApprovedAt, Message = h.RequestedBy, Fixes = new[] { AttentionFix.OpenSeerr },
                    Params = h.FourK ? new Dictionary<string, string> { ["variant"] = "4k" } : null,
                });
            }

            return items
                .OrderBy(x => x.Severity == "error" ? 0 : 1)
                .ThenBy(x => x.Since ?? DateTime.MaxValue)
                .ThenBy(x => x.Id, StringComparer.Ordinal)
                .ToList();
        }

        /// <summary>
        /// Downloads the arr marked failed in the last day whose movie/episode has had nothing since
        /// (no new grab or import) and isn't in the queue again: the arr's own re-search found nothing.
        /// </summary>
        internal static IEnumerable<AttentionItem> RecentFailures(ArrConnection c, ArrHistorySnapshot? history, IReadOnlyList<QueueGroup> queue, DateTime now)
        {
            if (history == null) yield break;
            var queued = new HashSet<int>(queue.SelectMany(g => g.EpisodeIds));
            var queuedTitles = new HashSet<int>(queue.Where(g => g.EpisodeIds.Count == 0 && g.ArrId.HasValue).Select(g => g.ArrId!.Value));
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var h in history.Records)
            {
                var subject = h.EpisodeId is int e ? "e" + e.ToString(CultureInfo.InvariantCulture)
                    : h.MovieId is int m ? "m" + m.ToString(CultureInfo.InvariantCulture) : null;
                if (subject == null || !seen.Add(subject)) continue;
                if (!string.Equals(h.EventType, "downloadFailed", StringComparison.OrdinalIgnoreCase) || h.Date is not DateTime at || now - at > TimeSpan.FromDays(1)) continue;
                if (h.EpisodeId is int ep ? queued.Contains(ep) : h.MovieId is int mv && queuedTitles.Contains(mv)) continue;
                var scope = h.SeasonNumber is int s && h.EpisodeNumber is int n ? ScopeText(new[] { (s, n) }) : null;
                yield return new AttentionItem
                {
                    Id = Id(AttentionCode.DownloadFailed, c.Id, subject),
                    Code = AttentionCode.DownloadFailed,
                    Severity = "error",
                    InstanceId = c.Id, Instance = c.Name, Title = h.Title, Year = h.Year,
                    Key = JellyfinBridge.KeyOf(c.Kind, h.TmdbId, h.TvdbId, h.SeasonNumber, h.EpisodeNumber),
                    Scope = scope, Since = at, Message = h.Message, Detail = h.SourceTitle,
                    Fixes = new[] { AttentionFix.SearchNow, AttentionFix.OpenInArr }, ArrLink = "/activity/history",
                };
            }
        }

        /// <summary>A root folder's use of its disk: the free space the arr reports for the root, against the size of the mount that holds it.</summary>
        internal static (int UsedPercent, int FreePercent, long Free, long Total)? DiskUse(ArrDiskEntry root, IReadOnlyList<ArrDiskEntry> disks)
        {
            if (root.Path == null) return null;
            ArrDiskEntry? mount = null;
            foreach (var d in disks)
            {
                if (d.Path == null || d.TotalSpace is not > 0 || !BridgePaths.IsUnder(root.Path, d.Path)) continue;
                if (mount == null || BridgePaths.Norm(d.Path).Length > BridgePaths.Norm(mount.Path!).Length) mount = d;
            }
            if (mount == null) return null;
            var total = mount.TotalSpace!.Value;
            var free = root.FreeSpace ?? mount.FreeSpace ?? 0;
            var freePct = (int)Math.Floor(Math.Clamp(free * 100.0 / total, 0, 100));
            return (100 - freePct, freePct, free, total);
        }

        /// <summary>
        /// The queue as downloads: rows grouped by download id (a season pack is one download), each
        /// with its covered episodes, progress, the arr's words, what needs attention and the actions
        /// offered. <paramref name="seen"/>: JE's first-seen clocks of the rows (a problem's
        /// "since" is when JE first saw its earliest problem row; without clocks: now, never the grab time).
        /// <paramref name="actionable"/> false (a queue too old to act on): no actions are offered.
        /// </summary>
        internal static List<QueueGroup> Group(ArrConnection instance, ArrQueueSnapshot? queue, ArrLibrarySnapshot? library, Func<ArrQueueEntry, ArrQueueSeen?>? seen = null, bool actionable = true, IReadOnlyList<ArrQueueEntry>? retained = null)
        {
            var result = new List<QueueGroup>();
            if (queue == null) return result;
            var currentIds = queue.Records.Select(r => r.Id).ToHashSet();
            var missing = (retained ?? Array.Empty<ArrQueueEntry>()).Where(r => !currentIds.Contains(r.Id)).ToList();
            var missingIds = missing.Select(r => r.Id).ToHashSet();
            foreach (var rows in queue.Records.Concat(missing).GroupBy(r => string.IsNullOrEmpty(r.DownloadId) ? "row:" + r.Id.ToString(CultureInfo.InvariantCulture) : r.DownloadId!))
            {
                var list = rows.ToList();
                var first = list[0];
                var statusOnly = list.Any(r => missingIds.Contains(r.Id));
                var size = list.Sum(r => r.Size ?? 0);
                var left = list.Sum(r => r.SizeLeft ?? 0);
                // A season pack repeats the same size on every episode row: count the download once.
                if (list.Count > 1 && list.All(r => r.Size == first.Size && r.SizeLeft == first.SizeLeft))
                {
                    size = first.Size ?? 0;
                    left = first.SizeLeft ?? 0;
                }
                var episodes = list.Where(r => r.SeasonNumber.HasValue && r.EpisodeNumber.HasValue).Select(r => (S: r.SeasonNumber!.Value, E: r.EpisodeNumber!.Value)).Distinct().OrderBy(x => x.S).ThenBy(x => x.E).ToList();
                var state = Worst(list.Select(r => r.TrackedDownloadState), new[] { "importBlocked", "failed", "failedPending", "importFailed", "importPending", "importing", "downloading" });
                var health = Worst(list.Select(r => r.TrackedDownloadStatus), new[] { "error", "warning", "ok" });
                var status = Worst(list.Select(r => r.Status), new[] { "failed", "downloadClientUnavailable", "warning", "paused", "queued", "delay", "completed", "downloading" });
                var messages = list.SelectMany(r => r.StatusMessages.Concat(string.IsNullOrWhiteSpace(r.ErrorMessage) ? Array.Empty<string>() : new[] { r.ErrorMessage! })).Distinct(StringComparer.Ordinal).Take(5).ToList();
                var problem = ProblemOf(state, health, status);
                // The client itself says no time is left while data is still missing: no progress (the
                // same table's Stalled class, so the store's first-seen clock times it).
                if (problem == null && left > 0 && list.All(r => ArrQueueStates.Classify(r) == ArrQueueClass.Stalled))
                    problem = AttentionCode.DownloadStalled;
                var movie = instance.Kind == ArrKind.Radarr;
                var series = !movie && first.SeriesId is int sid ? library?.SeriesById(sid) : null;
                var actions = new List<string>();
                if (status != "delay")
                {
                    actions.Add("remove");
                    actions.Add("remove_with_data");
                }
                actions.Add("search");
                // A finished download the arr warns about (waiting to import) is offered the arr's own
                // re-check of finished downloads, whatever pipeline state it reports.
                if (state is "importPending" or "importFailed" || problem == AttentionCode.ImportWaiting) actions.Add("retry_import");
                result.Add(new QueueGroup
                {
                    InstanceId = instance.Id,
                    Instance = instance.Name,
                    Kind = instance.Kind.ToString(),
                    DownloadId = rows.Key,
                    Ids = list.Select(r => r.Id).ToList(),
                    Title = first.Title,
                    Year = first.Year,
                    Key = movie
                        ? JellyfinBridge.KeyOf(ArrKind.Radarr, first.TmdbId, null, null, null)
                        : JellyfinBridge.KeyOf(ArrKind.Sonarr, null, first.TvdbId, episodes.Select(x => (int?)x.S).Distinct().Count() == 1 ? episodes.FirstOrDefault().S : null, episodes.Count == 1 ? episodes[0].E : null),
                    ArrId = first.MovieId ?? first.SeriesId,
                    TmdbId = first.TmdbId,
                    TvdbId = first.TvdbId,
                    TitleSlug = series?.TitleSlug,
                    Scope = ScopeText(episodes),
                    Episodes = episodes.Count,
                    EpisodeIds = list.Where(r => r.EpisodeId.HasValue).Select(r => r.EpisodeId!.Value).Distinct().ToList(),
                    Status = status,
                    State = state,
                    Health = health,
                    Percent = size > 0 ? (int)Math.Clamp(Math.Floor((size - left) * 100 / size), 0, 100) : null,
                    Size = size > 0 ? size : null,
                    SizeLeft = size > 0 ? left : null,
                    Eta = statusOnly ? null : list.Select(r => r.EstimatedCompletionTime).Where(d => d.HasValue).DefaultIfEmpty(null).Max(),
                    Client = first.DownloadClient,
                    Quality = first.Quality,
                    Protocol = first.Protocol,
                    Release = first.ReleaseTitle,
                    Messages = messages,
                    Added = list.Select(r => r.Added).Where(d => d.HasValue).DefaultIfEmpty(null).Min(),
                    AttentionSince = problem == null || seen == null ? null
                        : list.Select(r => seen(r)?.AttentionSince).Where(d => d.HasValue).DefaultIfEmpty(null).Min(),
                    Problem = problem,
                    Actions = actionable && !statusOnly ? actions : Array.Empty<string>(),
                });
            }
            return result.OrderBy(g => g.Problem == null ? 1 : 0).ThenBy(g => g.Added ?? DateTime.MaxValue).ToList();
        }

        /// <summary>
        /// What needs attention about a download, from the arr's own states (null: nothing), by the
        /// same precedence table the status composer uses (<see cref="ArrQueueStates"/>): a finished
        /// download with a warning is waiting to import, not "downloading with a warning".
        /// </summary>
        internal static string? ProblemOf(string? state, string? health, string? status) => ArrQueueStates.Classify(status, state, health) switch
        {
            ArrQueueClass.Failed => AttentionCode.DownloadFailed,
            ArrQueueClass.ImportBlocked => AttentionCode.ImportBlocked,
            ArrQueueClass.ImportWarned => AttentionCode.ImportWaiting,
            ArrQueueClass.ClientUnavailable => AttentionCode.ClientUnavailable,
            ArrQueueClass.Warned => AttentionCode.DownloadWarning,
            _ => null,
        };

        /// <summary>"S02E05", "S02E01–E08", "S02 (5)" (5 episodes, not in a row), "S01–S02 (12)".</summary>
        internal static string? ScopeText(IReadOnlyList<(int S, int E)> episodes)
        {
            if (episodes.Count == 0) return null;
            string Pad(int n) => n.ToString("00", CultureInfo.InvariantCulture);
            if (episodes.Count == 1) return $"S{Pad(episodes[0].S)}E{Pad(episodes[0].E)}";
            var seasons = episodes.Select(x => x.S).Distinct().ToList();
            if (seasons.Count == 1)
            {
                var numbers = episodes.Select(x => x.E).ToList();
                var contiguous = numbers.Zip(numbers.Skip(1)).All(p => p.Second == p.First + 1);
                return contiguous
                    ? $"S{Pad(seasons[0])}E{Pad(numbers[0])}–E{Pad(numbers[^1])}"
                    : $"S{Pad(seasons[0])} ({episodes.Count.ToString(CultureInfo.InvariantCulture)})";
            }
            return $"S{Pad(seasons.Min())}–S{Pad(seasons.Max())} ({episodes.Count.ToString(CultureInfo.InvariantCulture)})";
        }

        private static string? Worst(IEnumerable<string?> values, string[] order)
        {
            var set = values.Where(v => !string.IsNullOrEmpty(v)).Select(v => v!).ToList();
            foreach (var o in order)
            {
                if (set.Any(v => string.Equals(v, o, StringComparison.OrdinalIgnoreCase))) return o;
            }
            return set.FirstOrDefault();
        }

        private static string Id(params string[] parts)
        {
            var raw = string.Join("\n", parts);
            return Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw)), 0, 8).ToLowerInvariant();
        }
    }
}
