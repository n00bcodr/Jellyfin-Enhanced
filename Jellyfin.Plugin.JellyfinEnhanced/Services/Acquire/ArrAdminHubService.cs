using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire
{
    /// <summary>One disk bar (a root folder on its mount).</summary>
    public sealed class AdminDisk
    {
        /// <summary>The root folder (the arr's path).</summary>
        public string Path { get; init; } = string.Empty;

        /// <summary>Percent used (null when the mount's size isn't known).</summary>
        public int? UsedPercent { get; init; }

        /// <summary>Free bytes.</summary>
        public long? Free { get; init; }

        /// <summary>Size of the mount (bytes).</summary>
        public long? Total { get; init; }

        /// <summary>Below the low-disk threshold.</summary>
        public bool Low { get; init; }

        /// <summary>The arr can reach it.</summary>
        public bool Accessible { get; init; } = true;
    }

    /// <summary>The live connection and webhook of an instance, in short.</summary>
    public sealed class AdminLive
    {
        /// <summary>Live updates are expected (phase 1 on, the instance set to "auto").</summary>
        public bool Expected { get; init; }

        /// <summary>The SignalR connection.</summary>
        public ArrLiveConnectionStatus? Connection { get; init; }

        /// <summary>A webhook secret exists (JE's webhook is set up).</summary>
        public bool Webhook { get; init; }

        /// <summary>The webhook has been silent while the arr imported things.</summary>
        public bool WebhookSilent { get; init; }

        /// <summary>The last webhook event (UTC).</summary>
        public DateTimeOffset? WebhookLastEventAt { get; init; }

        /// <summary>Its type.</summary>
        public string? WebhookLastEventType { get; init; }

        /// <summary>Webhook calls accepted and refused since start.</summary>
        public long WebhookAccepted { get; init; }

        /// <summary>Refused.</summary>
        public long WebhookRefused { get; init; }
    }

    /// <summary>An instance card of the Overview (and the head of its System entry).</summary>
    public sealed class AdminInstanceCard
    {
        /// <summary>Instance id.</summary>
        public string Id { get; init; } = string.Empty;

        /// <summary>Name.</summary>
        public string Name { get; init; } = string.Empty;

        /// <summary>Sonarr or Radarr.</summary>
        public string Kind { get; init; } = string.Empty;

        /// <summary>Role (standard, 4k, anime, custom).</summary>
        public string Role { get; init; } = string.Empty;

        /// <summary>Address (Open in Sonarr/Radarr).</summary>
        public string Url { get; init; } = string.Empty;

        /// <summary>URL mappings (applied in the browser like the arr links).</summary>
        public string UrlMappings { get; init; } = string.Empty;

        /// <summary>The app's version.</summary>
        public string? Version { get; init; }

        /// <summary>Why it can't be read (null: readable).</summary>
        public string? Error { get; init; }

        /// <summary>Live connection and webhook.</summary>
        public AdminLive Live { get; init; } = new();

        /// <summary>Downloads in the queue.</summary>
        public int Queue { get; init; }

        /// <summary>Downloads needing attention.</summary>
        public int QueueAttention { get; init; }

        /// <summary>
        /// When the queue shown was read (UTC), only when it is older than its freshness target
        /// (the latest read failed or is on its way): the tabs say "as of {time}".
        /// </summary>
        public DateTimeOffset? QueueAsOf { get; init; }

        /// <summary>The queue or history is past its longest serve time and can't be read: what it shows is not live.</summary>
        public bool QueueExpired { get; init; }

        /// <summary>The worst health check (ok when none).</summary>
        public string Health { get; init; } = "ok";

        /// <summary>Health warnings and errors.</summary>
        public int HealthIssues { get; init; }

        /// <summary>Disk bars per root folder.</summary>
        public IReadOnlyList<AdminDisk> Disks { get; init; } = Array.Empty<AdminDisk>();
    }

    /// <summary>Something airing or released in the next 24 hours.</summary>
    public sealed class AdminUpcoming
    {
        /// <summary>Title.</summary>
        public string Title { get; init; } = string.Empty;

        /// <summary>Season.</summary>
        public int? Season { get; init; }

        /// <summary>Episode.</summary>
        public int? Episode { get; init; }

        /// <summary>When (UTC).</summary>
        public DateTime At { get; init; }

        /// <summary>Instance name.</summary>
        public string Instance { get; init; } = string.Empty;

        /// <summary>Monitored.</summary>
        public bool Monitored { get; init; }

        /// <summary>Already has a file.</summary>
        public bool HasFile { get; init; }

        /// <summary>Release type for movies (DigitalRelease, …).</summary>
        public string? Release { get; init; }
    }

    /// <summary>Grabs and imports of one day.</summary>
    public sealed class AdminDay
    {
        /// <summary>The day (UTC, yyyy-MM-dd).</summary>
        public string Date { get; init; } = string.Empty;

        /// <summary>Grabs.</summary>
        public int Grabs { get; init; }

        /// <summary>Imports.</summary>
        public int Imports { get; init; }
    }

    /// <summary>The Overview tab.</summary>
    public sealed class AdminOverview
    {
        /// <summary>Instance cards.</summary>
        public IReadOnlyList<AdminInstanceCard> Instances { get; init; } = Array.Empty<AdminInstanceCard>();

        /// <summary>Needs attention, errors first.</summary>
        public IReadOnlyList<AttentionItem> NeedsAttention { get; init; } = Array.Empty<AttentionItem>();

        /// <summary>Next 24 hours.</summary>
        public IReadOnlyList<AdminUpcoming> Next24h { get; init; } = Array.Empty<AdminUpcoming>();

        /// <summary>Downloads in all queues.</summary>
        public int Downloading { get; init; }

        /// <summary>Seerr requests waiting for an OK.</summary>
        public int WaitingForOk { get; init; }

        /// <summary>Grabs and imports per day, last 14 days (from the history held in memory).</summary>
        public IReadOnlyList<AdminDay> Days { get; init; } = Array.Empty<AdminDay>();

        /// <summary>The oldest history record held (the 14 days may start later on busy servers).</summary>
        public DateTime? HistoryFrom { get; init; }

        /// <summary>Seerr is set up (Open in Seerr).</summary>
        public bool Seerr { get; init; }
    }

    /// <summary>One history event on the Activity tab.</summary>
    public sealed class AdminHistoryRow
    {
        /// <summary>Instance id.</summary>
        public string InstanceId { get; init; } = string.Empty;

        /// <summary>Instance name.</summary>
        public string Instance { get; init; } = string.Empty;

        /// <summary>grabbed, downloadFolderImported, downloadFailed, …</summary>
        public string Event { get; init; } = string.Empty;

        /// <summary>Title.</summary>
        public string? Title { get; init; }

        /// <summary>Year.</summary>
        public int? Year { get; init; }

        /// <summary>Season.</summary>
        public int? Season { get; init; }

        /// <summary>Episode.</summary>
        public int? Episode { get; init; }

        /// <summary>When (UTC).</summary>
        public DateTime? Date { get; init; }

        /// <summary>Quality.</summary>
        public string? Quality { get; init; }

        /// <summary>Release name.</summary>
        public string? Release { get; init; }

        /// <summary>Title key.</summary>
        public string? Key { get; init; }
    }

    /// <summary>The Activity tab: downloads (grouped) and recent history.</summary>
    public sealed class AdminActivity
    {
        /// <summary>Instances (for Open in links).</summary>
        public IReadOnlyList<AdminInstanceCard> Instances { get; init; } = Array.Empty<AdminInstanceCard>();

        /// <summary>Downloads, problems first.</summary>
        public IReadOnlyList<QueueGroup> Queue { get; init; } = Array.Empty<QueueGroup>();

        /// <summary>Recent history, newest first.</summary>
        public IReadOnlyList<AdminHistoryRow> History { get; init; } = Array.Empty<AdminHistoryRow>();

        /// <summary>A queue was cut at the read cap.</summary>
        public bool Truncated { get; init; }
    }

    /// <summary>One instance on the System tab.</summary>
    public sealed class AdminSystemInstance
    {
        /// <summary>The card (name, live, disks, …).</summary>
        public AdminInstanceCard Card { get; init; } = new();

        /// <summary>App name the instance reports.</summary>
        public string? AppName { get; init; }

        /// <summary>Every health check.</summary>
        public IReadOnlyList<ArrHealthEntry> Health { get; init; } = Array.Empty<ArrHealthEntry>();

        /// <summary>Every mount the arr sees.</summary>
        public IReadOnlyList<ArrDiskEntry> DiskSpace { get; init; } = Array.Empty<ArrDiskEntry>();

        /// <summary>Scheduled tasks.</summary>
        public IReadOnlyList<ArrTaskEntry> Tasks { get; init; } = Array.Empty<ArrTaskEntry>();

        /// <summary>When each snapshot was read (UTC) and its last error.</summary>
        public IReadOnlyDictionary<string, string?> Snapshots { get; init; } = new Dictionary<string, string?>();
    }

    /// <summary>The Jellyfin bridge on the System tab.</summary>
    public sealed class AdminBridge
    {
        /// <summary>Targeted refresh after imports is on.</summary>
        public bool TargetedRefresh { get; init; }

        /// <summary>Refreshes run since start.</summary>
        public long Refreshes { get; init; }

        /// <summary>Of those, how many found their file afterwards.</summary>
        public long Found { get; init; }

        /// <summary>The newest decisions.</summary>
        public IReadOnlyList<BridgeRefresh> Recent { get; init; } = Array.Empty<BridgeRefresh>();

        /// <summary>Recent imports Jellyfin has no item for.</summary>
        public IReadOnlyList<BridgeMissing> NotInJellyfin { get; init; } = Array.Empty<BridgeMissing>();

        /// <summary>Titles with files Jellyfin doesn't list at all.</summary>
        public BridgeMissingTitles MissingTitles { get; init; } = new();

        /// <summary>The path doctor.</summary>
        public IReadOnlyList<PathDoctorInstance> PathDoctor { get; init; } = Array.Empty<PathDoctorInstance>();
    }

    /// <summary>The System tab.</summary>
    public sealed class AdminSystem
    {
        /// <summary>Per instance.</summary>
        public IReadOnlyList<AdminSystemInstance> Instances { get; init; } = Array.Empty<AdminSystemInstance>();

        /// <summary>Seerr's request list (the read model's state), null when Seerr isn't set up.</summary>
        public SeerrReadModelState? Seerr { get; init; }

        /// <summary>Seerr requests held.</summary>
        public int SeerrRequests { get; init; }

        /// <summary>The Jellyfin bridge.</summary>
        public AdminBridge Bridge { get; init; } = new();

        /// <summary>The thresholds in use (minutes / percent).</summary>
        public IReadOnlyDictionary<string, int> Settings { get; init; } = new Dictionary<string, int>();
    }

    /// <summary>
    /// The administrator's tabs of the Requests page (Requests &amp; downloads, phase 2): Overview
    /// (instance cards, Needs attention, next 24 hours, two weeks of grabs and imports), Activity
    /// (downloads grouped per download id with their actions, recent history) and System (health,
    /// disks, tasks, versions, live connection and webhook, Seerr's request list, the Jellyfin
    /// bridge and the path doctor). Everything is read from the arr snapshots in memory (a cold
    /// snapshot is loaded in the background and waited for, bounded), Jellyfin and the request read
    /// model; nothing here writes. Administrators only (the controller checks).
    /// </summary>
    public sealed class ArrAdminHubService
    {
        private const int HistoryRows = 100;
        private static readonly TimeSpan Upcoming = TimeSpan.FromHours(24);

        private readonly ArrStateStore _store;
        private readonly JellyfinBridge _bridge;
        private readonly SeerrRequestReadModel? _requests;
        private readonly ArrLiveService? _live;
        private readonly ArrWebhookReceiver? _webhooks;
        private readonly Func<PluginConfiguration?> _config;
        private readonly Func<DateTimeOffset> _now;

        /// <summary>The service (DI).</summary>
        public ArrAdminHubService(ArrStateStore store, JellyfinBridge bridge, SeerrRequestReadModel requests, ArrLiveService live, ArrWebhookReceiver webhooks)
            : this(store, bridge, requests, live, webhooks, null, null)
        {
        }

        /// <summary>The service with explicit parts (tests).</summary>
        internal ArrAdminHubService(ArrStateStore store, JellyfinBridge bridge, SeerrRequestReadModel? requests, ArrLiveService? live, ArrWebhookReceiver? webhooks, Func<PluginConfiguration?>? config, Func<DateTimeOffset>? now)
        {
            _store = store;
            _bridge = bridge;
            _requests = requests;
            _live = live;
            _webhooks = webhooks;
            _config = config ?? (() => JellyfinEnhanced.Instance?.Configuration);
            _now = now ?? (() => DateTimeOffset.UtcNow);
        }

        /// <summary>The arr state store (request counter).</summary>
        public ArrStateStore Store => _store;

        /// <summary>True when "Requests &amp; downloads" phases 1 and 2 are on.</summary>
        public bool Enabled => JellyfinBridge.Phase2(_config());

        /// <summary>The Overview tab.</summary>
        public async Task<AdminOverview> OverviewAsync(CancellationToken cancellationToken)
        {
            var config = _config();
            var now = _now().UtcDateTime;
            var cards = new List<AdminInstanceCard>();
            var facts = new List<AttentionInstance>();
            var upcoming = new List<AdminUpcoming>();
            var downloading = 0;
            foreach (var instance in Usable())
            {
                var read = await ReadAsync(instance, cancellationToken).ConfigureAwait(false);
                var groups = NeedsAttention.Group(instance, read.Queue.Value, read.Library.Value, row => _store.QueueSeen(instance, row));
                downloading += groups.Count;
                var live = Live(instance, read.History.Value);
                cards.Add(Card(instance, read, groups, live, config));
                facts.Add(Facts(instance, read, groups, live));
                var calendar = await _store.GetCalendarAsync(instance, now, now + Upcoming, cancellationToken).ConfigureAwait(false);
                upcoming.AddRange(UpcomingFrom(instance, calendar.Value, now));
            }

            var items = Derive(now, config, facts);
            var (days, from) = Days(now);
            return new AdminOverview
            {
                Instances = cards,
                NeedsAttention = items,
                Next24h = upcoming.OrderBy(u => u.At).Take(12).ToList(),
                Downloading = downloading,
                WaitingForOk = _requests?.Active == true ? _requests.All.Count(r => r.Status == SeerrRequestStatus.Pending) : 0,
                Days = days,
                HistoryFrom = from,
                Seerr = _requests?.Active == true,
            };
        }

        /// <summary>
        /// The Needs attention rows alone, as the Overview lists them (administrators' alerts read
        /// them every minute: manual imports needed, requests Seerr OK'd that no Sonarr/Radarr has,
        /// instances that can't be read, low disk, and the stuck digest).
        /// </summary>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <param name="background">
        /// True for the administrators' 1-minute alert check: the snapshots are read as a background
        /// reader (<see cref="ArrStateStore.ReadInBackgroundAsync"/>), so the check alone never holds
        /// the queue and history at the Downloads page's pace.
        /// </param>
        public async Task<IReadOnlyList<AttentionItem>> NeedsAttentionAsync(CancellationToken cancellationToken, bool background = false)
        {
            var config = _config();
            var now = _now().UtcDateTime;
            var facts = new List<AttentionInstance>();
            foreach (var instance in Usable())
            {
                var read = background ? await BackgroundReadAsync(instance, cancellationToken).ConfigureAwait(false) : await ReadAsync(instance, cancellationToken).ConfigureAwait(false);
                facts.Add(Facts(instance, read, NeedsAttention.Group(instance, read.Queue.Value, read.Library.Value, row => _store.QueueSeen(instance, row)), Live(instance, read.History.Value)));
            }
            return Derive(now, config, facts);
        }

        private static AttentionInstance Facts(ArrConnection instance, Read read, IReadOnlyList<QueueGroup> groups, AdminLive live) => new(instance)
        {
            Library = read.Library.Value,
            Queue = groups,
            System = read.System.Value,
            History = read.History.Value,
            Error = read.Error,
            QueueExpired = read.Queue.Expired || read.History.Expired,
            Live = live.Expected ? live.Connection : null,
            WebhookSilent = live.WebhookSilent,
        };

        private List<AttentionItem> Derive(DateTime now, PluginConfiguration? config, IReadOnlyList<AttentionInstance> facts)
            => NeedsAttention.Derive(
                now,
                LowDiskPercent(config),
                Math.Clamp(config?.ArrLibraryPendingMinutes ?? 10, 1, 1440),
                facts,
                _bridge.NotInJellyfin(),
                Handoffs(now, ArrStatusService.HandoffGrace(config)));

        /// <summary>The low-disk threshold (percent free) the Overview, System and the administrators' alert share.</summary>
        internal static int LowDiskPercent(PluginConfiguration? config) => Math.Clamp(config?.ArrLowDiskPercent ?? 10, 1, 50);

        /// <summary>The Activity tab.</summary>
        public async Task<AdminActivity> ActivityAsync(CancellationToken cancellationToken)
        {
            var config = _config();
            var cards = new List<AdminInstanceCard>();
            var queue = new List<QueueGroup>();
            var history = new List<AdminHistoryRow>();
            var truncated = false;
            foreach (var instance in Usable())
            {
                var read = await ReadAsync(instance, cancellationToken).ConfigureAwait(false);
                // A queue that can't be read any more is listed as last read, with no actions on it.
                var groups = NeedsAttention.Group(instance, read.Queue.Value, read.Library.Value, row => _store.QueueSeen(instance, row), actionable: !read.Queue.Expired);
                truncated |= read.Queue.Value?.Truncated == true;
                queue.AddRange(groups);
                cards.Add(Card(instance, read, groups, Live(instance, read.History.Value), config));
                foreach (var h in (read.History.Value?.Records ?? Array.Empty<ArrHistoryEntry>()).Take(HistoryRows))
                {
                    history.Add(new AdminHistoryRow
                    {
                        InstanceId = instance.Id, Instance = instance.Name, Event = h.EventType ?? "unknown", Title = h.Title, Year = h.Year,
                        Season = h.SeasonNumber, Episode = h.EpisodeNumber, Date = h.Date, Quality = h.Quality, Release = h.SourceTitle,
                        Key = JellyfinBridge.KeyOf(instance.Kind, h.TmdbId, h.TvdbId, h.SeasonNumber, h.EpisodeNumber),
                    });
                }
            }
            return new AdminActivity
            {
                Instances = cards,
                Queue = queue.OrderBy(g => g.Problem == null ? 1 : 0).ThenBy(g => g.Added ?? DateTime.MaxValue).ToList(),
                History = history.OrderByDescending(h => h.Date ?? DateTime.MinValue).Take(HistoryRows).ToList(),
                Truncated = truncated,
            };
        }

        /// <summary>The System tab.</summary>
        public async Task<AdminSystem> SystemAsync(CancellationToken cancellationToken)
        {
            var config = _config();
            var list = new List<AdminSystemInstance>();
            foreach (var instance in Usable())
            {
                var read = await ReadAsync(instance, cancellationToken).ConfigureAwait(false);
                var groups = NeedsAttention.Group(instance, read.Queue.Value, read.Library.Value, row => _store.QueueSeen(instance, row));
                var system = read.System.Value;
                list.Add(new AdminSystemInstance
                {
                    Card = Card(instance, read, groups, Live(instance, read.History.Value), config),
                    AppName = system?.AppName,
                    Health = system?.Health ?? Array.Empty<ArrHealthEntry>(),
                    DiskSpace = system?.DiskSpace ?? Array.Empty<ArrDiskEntry>(),
                    Tasks = system?.Tasks ?? Array.Empty<ArrTaskEntry>(),
                    Snapshots = new Dictionary<string, string?>
                    {
                        ["library"] = Stamp(read.Library.LoadedAt, read.Library.Error),
                        ["queue"] = Stamp(read.Queue.LoadedAt, read.Queue.Error),
                        ["history"] = Stamp(read.History.LoadedAt, read.History.Error),
                        ["system"] = Stamp(read.System.LoadedAt, read.System.Error),
                    },
                });
            }
            var (refreshes, found) = _bridge.Stats;
            return new AdminSystem
            {
                Instances = list,
                Seerr = _requests?.Active == true ? _requests.State : null,
                SeerrRequests = _requests?.Active == true ? _requests.All.Count : 0,
                Bridge = new AdminBridge
                {
                    TargetedRefresh = _bridge.RefreshEnabled,
                    Refreshes = refreshes,
                    Found = found,
                    Recent = _bridge.Recent(),
                    NotInJellyfin = _bridge.NotInJellyfin(),
                    MissingTitles = _bridge.MissingTitles(),
                    PathDoctor = _bridge.PathDoctor(),
                },
                Settings = new Dictionary<string, int>
                {
                    ["lowDiskPercent"] = LowDiskPercent(config),
                    ["libraryPendingMinutes"] = Math.Clamp(config?.ArrLibraryPendingMinutes ?? 10, 1, 1440),
                    ["seerrHandoffGraceMinutes"] = Math.Clamp(config?.ArrSeerrHandoffGraceMinutes ?? 15, 1, 1440),
                },
            };
        }

        /// <summary>
        /// Seerr requests OK'd longer than <paramref name="grace"/> ago (still OK'd or failed in Seerr,
        /// not available) for titles no usable Sonarr/Radarr of their kind holds — judged only when
        /// every such instance's library is in memory. Per variant: a title's 4K requests are judged
        /// on the 4K Radarr/Sonarr instances alone and its other requests on the other instances, as
        /// its status is (none of that variant set up: never listed; the request is all there is),
        /// so a finished standard request never hides a stuck 4K one. Empty when phase 2 or Seerr is off.
        /// </summary>
        internal IReadOnlyList<HandoffFact> Handoffs(DateTime now, TimeSpan? grace)
        {
            if (grace is not TimeSpan wait || _requests is not { Active: true } model) return Array.Empty<HandoffFact>();
            var result = new List<HandoffFact>();
            foreach (var records in model.All.Where(r => r.Key != null).GroupBy(r => (Key: r.Key!.ToString(), FourK: r.Is4k)))
            {
                var fourK = records.Key.FourK;
                var list = records.ToList();
                if (list.Any(r => r.MediaStatus is 4 or 5 || r.Status == SeerrRequestStatus.Completed)) continue;
                var approved = list.Where(r => r.Status is SeerrRequestStatus.Approved or SeerrRequestStatus.Failed).ToList();
                if (approved.Count == 0) continue;
                var at = approved.Select(r => r.UpdatedAt ?? r.CreatedAt).Where(d => d.HasValue).DefaultIfEmpty(null).Min();
                if (at is not DateTime approvedAt || now - approvedAt < wait) continue;
                var key = list[0].Key!;
                if (HeldByAnArr(key, fourK) != false) continue;
                var meta = model.Meta(list[0].IsMovie, list[0].TmdbId);
                result.Add(new HandoffFact(key.ToString(), meta?.Title, meta?.Year, list[0].IsMovie, approvedAt, approved[0].RequestedByName, fourK));
            }
            return result;
        }

        /// <summary>
        /// True when an instance of the title's kind and the request's variant holds it (<paramref name="fourK"/>:
        /// a 4K Radarr/Sonarr; otherwise any other role: standard, anime, custom); false when none does;
        /// null when that can't be said: JE watches no instance of that variant, one has no library in
        /// memory, or its latest library read failed (the index held is from before, so it says nothing
        /// about a title added since).
        /// </summary>
        private bool? HeldByAnArr(TitleKey key, bool fourK)
        {
            var kind = key.IsMovie ? ArrKind.Radarr : ArrKind.Sonarr;
            var instances = _store.Registry.Usable(kind).Where(i => (i.Role == "4k") == fourK).ToList();
            if (instances.Count == 0) return null;
            var unknown = false;
            foreach (var instance in instances)
            {
                var (library, error) = _store.PeekLibraryState(instance.Id);
                if (library == null)
                {
                    unknown = true;
                    continue;
                }
                var held = key.IsMovie
                    ? (key.Provider == "tmdb" && key.NumericId is int tmdb ? library.MovieByTmdb(tmdb) : library.MovieByImdb(key.Id)) != null
                    : key.Provider switch
                    {
                        "tvdb" when key.NumericId is int tvdb => library.SeriesByTvdb(tvdb) != null,
                        "tmdb" when key.NumericId is int seriesTmdb => library.SeriesByTmdb(seriesTmdb) != null,
                        "imdb" => library.SeriesByImdb(key.Id) != null,
                        _ => false,
                    };
                if (held) return true;
                if (error != null) unknown = true;
            }
            return unknown ? null : false;
        }

        private IEnumerable<ArrConnection> Usable() => _store.Registry.All().Where(c => c.Usable);

        private async Task<Read> ReadAsync(ArrConnection instance, CancellationToken cancellationToken)
        {
            var library = await _store.GetLibraryAsync(instance, cancellationToken).ConfigureAwait(false);
            var queue = await _store.GetQueueAsync(instance, cancellationToken).ConfigureAwait(false);
            var history = await _store.GetHistoryAsync(instance, cancellationToken).ConfigureAwait(false);
            var system = await _store.GetSystemAsync(instance, cancellationToken).ConfigureAwait(false);
            // The instance is "down" when its latest system or queue read failed.
            var error = system.Error ?? queue.Error;
            return new Read(library, queue, history, system, error?.Message);
        }

        private async Task<Read> BackgroundReadAsync(ArrConnection instance, CancellationToken cancellationToken)
        {
            var read = await _store.ReadInBackgroundAsync(instance, cancellationToken).ConfigureAwait(false);
            var error = read.System.Error ?? read.Queue.Error;
            return new Read(read.Library, read.Queue, read.History, read.System, error?.Message);
        }

                private AdminLive Live(ArrConnection instance, ArrHistorySnapshot? history)
        {
            var expected = ArrLiveFlags.Enabled(_config()) && !string.Equals(instance.LiveUpdates, "off", StringComparison.OrdinalIgnoreCase);
            var stats = _webhooks?.Stats(instance.Id);
            var hasSecret = _webhooks?.HasSecret(instance.Id) == true;
            return new AdminLive
            {
                Expected = expected,
                Connection = _live?.ConnectionStatus(instance.Id),
                Webhook = hasSecret,
                WebhookSilent = _webhooks?.IsSilent(instance.Id, history, _now()) == true,
                WebhookLastEventAt = stats?.LastEventAt,
                WebhookLastEventType = stats?.LastEventType,
                WebhookAccepted = stats?.Accepted ?? 0,
                WebhookRefused = stats?.Refused ?? 0,
            };
        }

        private static AdminInstanceCard Card(ArrConnection instance, Read read, IReadOnlyList<QueueGroup> groups, AdminLive live, PluginConfiguration? config)
        {
            var system = read.System.Value;
            // Update notices are the arr's own business (listed on the System tab, not counted here).
            var issues = (system?.Health ?? Array.Empty<ArrHealthEntry>())
                .Where(h => (h.Type ?? string.Empty).ToLowerInvariant() is "warning" or "error" && !string.Equals(h.Source, "UpdateCheck", StringComparison.OrdinalIgnoreCase))
                .ToList();
            var low = LowDiskPercent(config);
            return new AdminInstanceCard
            {
                Id = instance.Id,
                Name = instance.Name,
                Kind = instance.Kind.ToString(),
                Role = instance.Role,
                Url = instance.Url,
                UrlMappings = instance.UrlMappings,
                Version = system?.Version,
                Error = read.Error,
                Live = live,
                Queue = groups.Count,
                QueueAttention = groups.Count(g => g.Problem != null),
                QueueAsOf = read.Queue.Stale || read.Queue.Expired ? read.Queue.LoadedAt : null,
                QueueExpired = read.Queue.Expired || read.History.Expired,
                Health = issues.Any(h => string.Equals(h.Type, "error", StringComparison.OrdinalIgnoreCase)) ? "error" : issues.Count > 0 ? "warning" : "ok",
                HealthIssues = issues.Count,
                Disks = (system?.RootFolders ?? Array.Empty<ArrDiskEntry>()).Where(r => !string.IsNullOrWhiteSpace(r.Path)).Select(r =>
                {
                    var use = NeedsAttention.DiskUse(r, system!.DiskSpace);
                    return new AdminDisk
                    {
                        Path = r.Path!,
                        UsedPercent = use?.UsedPercent,
                        Free = use?.Free ?? r.FreeSpace,
                        Total = use?.Total,
                        Low = use is { } u && u.FreePercent < low,
                        Accessible = r.Accessible != false,
                    };
                }).ToList(),
            };
        }

        private static IEnumerable<AdminUpcoming> UpcomingFrom(ArrConnection instance, ArrCalendarSnapshot? calendar, DateTime now)
        {
            foreach (var e in calendar?.Entries ?? Array.Empty<ArrCalendarEntry>())
            {
                if (instance.Kind == ArrKind.Sonarr)
                {
                    if (e.AirDateUtc is DateTime air && air >= now && air - now <= Upcoming)
                        yield return new AdminUpcoming { Title = e.Title, Season = e.SeasonNumber, Episode = e.EpisodeNumber, At = air, Instance = instance.Name, Monitored = e.Monitored, HasFile = e.HasFile };
                    continue;
                }
                foreach (var (type, at) in e.Releases)
                {
                    if (at >= now && at - now <= Upcoming)
                        yield return new AdminUpcoming { Title = e.Title, At = at, Instance = instance.Name, Monitored = e.Monitored, HasFile = e.HasFile, Release = type };
                }
            }
        }

        /// <summary>Grabs and imports per UTC day over the last 14 days, from every instance's history in memory.</summary>
        private (IReadOnlyList<AdminDay> Days, DateTime? From) Days(DateTime now)
        {
            var start = now.Date.AddDays(-13);
            var grabs = new int[14];
            var imports = new int[14];
            DateTime? from = null;
            foreach (var instance in Usable())
            {
                var history = _store.PeekHistory(instance.Id);
                if (history == null) continue;
                foreach (var h in history.Records)
                {
                    if (h.Date is not DateTime d) continue;
                    if (from == null || d < from) from = d;
                    var i = (int)(d.Date - start).TotalDays;
                    if (i < 0 || i > 13) continue;
                    if (string.Equals(h.EventType, "grabbed", StringComparison.OrdinalIgnoreCase)) grabs[i]++;
                    else if (h.EventType != null && h.EventType.EndsWith("Imported", StringComparison.OrdinalIgnoreCase)) imports[i]++;
                }
            }
            var days = Enumerable.Range(0, 14).Select(i => new AdminDay
            {
                Date = start.AddDays(i).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
                Grabs = grabs[i],
                Imports = imports[i],
            }).ToList();
            return (days, from);
        }

        private static string? Stamp(DateTimeOffset? at, ArrError? error)
            => error != null ? "error: " + error.Message : at?.UtcDateTime.ToString("o", CultureInfo.InvariantCulture);

        private sealed record Read(
            ArrSnapshotRead<ArrLibrarySnapshot> Library,
            ArrSnapshotRead<ArrQueueSnapshot> Queue,
            ArrSnapshotRead<ArrHistorySnapshot> History,
            ArrSnapshotRead<ArrSystemSnapshot> System,
            string? Error);
    }
}
