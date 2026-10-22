using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire
{
    /// <summary>One event on a copy's timeline in the Manage drawer.</summary>
    public sealed class ManageEvent
    {
        /// <summary>added, grabbed, downloadFolderImported, downloadFailed, …, or audit (a Jellyfin Enhanced action).</summary>
        public string Event { get; init; } = string.Empty;

        /// <summary>When (UTC).</summary>
        public DateTime? At { get; init; }

        /// <summary>Season (series).</summary>
        public int? Season { get; init; }

        /// <summary>Episode (series).</summary>
        public int? Episode { get; init; }

        /// <summary>Extra words: the audit action and outcome, who did it.</summary>
        public string? Text { get; init; }

        /// <summary>The arr's message of a history event (failures, ignored downloads).</summary>
        public string? Message { get; init; }
    }

    /// <summary>A queue row of the copy in the Manage drawer.</summary>
    public sealed class ManageQueueRow
    {
        /// <summary>Season.</summary>
        public int? Season { get; init; }

        /// <summary>Episode.</summary>
        public int? Episode { get; init; }

        /// <summary>The arr's tracked state (downloading, importPending, importBlocked, …).</summary>
        public string? State { get; init; }

        /// <summary>The arr's status (ok, warning, error).</summary>
        public string? Health { get; init; }

        /// <summary>Percent done.</summary>
        public int? Percent { get; init; }

        /// <summary>Release name.</summary>
        public string? Release { get; init; }

        /// <summary>Download client.</summary>
        public string? Client { get; init; }

        /// <summary>Quality.</summary>
        public string? Quality { get; init; }

        /// <summary>The arr's own messages.</summary>
        public IReadOnlyList<string> Messages { get; init; } = Array.Empty<string>();
    }

    /// <summary>One instance (copy) of the title in the Manage drawer: "Versions across instances".</summary>
    public sealed class ManageInstance
    {
        /// <summary>Instance id.</summary>
        public string Id { get; init; } = string.Empty;

        /// <summary>Instance name.</summary>
        public string Name { get; init; } = string.Empty;

        /// <summary>Sonarr or Radarr.</summary>
        public string Kind { get; init; } = string.Empty;

        /// <summary>Role (standard, 4k, anime, custom).</summary>
        public string Role { get; init; } = string.Empty;

        /// <summary>The instance's address (for Open in Sonarr/Radarr).</summary>
        public string Url { get; init; } = string.Empty;

        /// <summary>The instance's URL mappings (Jellyfin address → arr address), applied in the browser like the arr links.</summary>
        public string UrlMappings { get; init; } = string.Empty;

        /// <summary>The live connection to it is up.</summary>
        public bool Live { get; init; }

        /// <summary>Its library could be read.</summary>
        public bool Readable { get; init; }

        /// <summary>The title is in this instance.</summary>
        public bool InArr { get; init; }

        /// <summary>The arr's id of the title.</summary>
        public int? ArrId { get; init; }

        /// <summary>Sonarr's title slug (its page address).</summary>
        public string? TitleSlug { get; init; }

        /// <summary>Monitored.</summary>
        public bool? Monitored { get; init; }

        /// <summary>The arr has a file (movie) / episode files (series).</summary>
        public bool? HasFile { get; init; }

        /// <summary>Size on disk (bytes).</summary>
        public long? SizeOnDisk { get; init; }

        /// <summary>The title's folder as the arr sees it.</summary>
        public string? Path { get; init; }

        /// <summary>Quality profile name.</summary>
        public string? QualityProfile { get; init; }

        /// <summary>Minimum availability (Radarr).</summary>
        public string? MinimumAvailability { get; init; }

        /// <summary>Last search for it.</summary>
        public DateTime? LastSearch { get; init; }

        /// <summary>A search for it is running (the arr's live messages say so).</summary>
        public bool Searching { get; init; }

        /// <summary>The Jellyfin library its copy is in, when Jellyfin has it.</summary>
        public string? Library { get; init; }

        /// <summary>The Jellyfin item of its copy.</summary>
        public string? ItemId { get; init; }

        /// <summary>When Jellyfin added its copy.</summary>
        public DateTime? InJellyfinAt { get; init; }

        /// <summary>Its downloads (queue rows, at most 50).</summary>
        public IReadOnlyList<ManageQueueRow> Queue { get; init; } = Array.Empty<ManageQueueRow>();

        /// <summary>How many queue rows it has in scope (more than <see cref="Queue"/> lists: "and N more").</summary>
        public int QueueTotal { get; init; }

        /// <summary>How many whole downloads it has in scope (more than <see cref="Downloads"/> lists: "and N more").</summary>
        public int DownloadsTotal { get; init; }

        /// <summary>When the queue shown was read, when that is past its freshness target (null: it is fresh).</summary>
        public DateTimeOffset? QueueAsOf { get; init; }

        /// <summary>
        /// Its queue can't be read and what was last read is too old to say anything about now: no
        /// queue rows or downloads (nor their actions) are given; the drawer says when it was last read.
        /// </summary>
        public bool QueueExpired { get; init; }

        /// <summary>Its timeline (oldest first): added, history events, Jellyfin Enhanced actions.</summary>
        public IReadOnlyList<ManageEvent> Timeline { get; init; } = Array.Empty<ManageEvent>();

        /// <summary>
        /// Its downloads in scope as whole downloads (a season pack is one) with the queue actions
        /// they allow (phase 2 only; empty otherwise): the drawer offers the non-destructive ones.
        /// </summary>
        public IReadOnlyList<QueueGroup> Downloads { get; init; } = Array.Empty<QueueGroup>();
    }

    /// <summary>One Jellyfin copy of the title.</summary>
    public sealed class ManageCopy
    {
        /// <summary>Item id.</summary>
        public string ItemId { get; init; } = string.Empty;

        /// <summary>Library name.</summary>
        public string? Library { get; init; }

        /// <summary>When Jellyfin added it.</summary>
        public DateTime? Added { get; init; }
    }

    /// <summary>One Seerr request for the title (administrators see who asked).</summary>
    public sealed class ManageRequest
    {
        /// <summary>When it was asked for.</summary>
        public DateTime? At { get; init; }

        /// <summary>Seerr's state (pending, approved, declined, failed, available).</summary>
        public string Status { get; init; } = string.Empty;

        /// <summary>Who asked.</summary>
        public string? By { get; init; }

        /// <summary>Who answered.</summary>
        public string? AnsweredBy { get; init; }

        /// <summary>A 4K request.</summary>
        public bool Is4k { get; init; }

        /// <summary>Seasons asked for.</summary>
        public IReadOnlyList<int>? Seasons { get; init; }
    }

    /// <summary>The Manage drawer's Overview (administrators only).</summary>
    public sealed class ManageResponse
    {
        /// <summary>Title key (season/episode keys for a season or episode page).</summary>
        public string Key { get; init; } = string.Empty;

        /// <summary>movie, series, season or episode.</summary>
        public string Kind { get; init; } = string.Empty;

        /// <summary>The Jellyfin item the drawer was opened on, if any.</summary>
        public string? ItemId { get; init; }

        /// <summary>Season in scope.</summary>
        public int? Season { get; init; }

        /// <summary>Episode in scope.</summary>
        public int? Episode { get; init; }

        /// <summary>TMDB id (movies; Open in Radarr).</summary>
        public int? TmdbId { get; init; }

        /// <summary>TVDB id (series).</summary>
        public int? TvdbId { get; init; }

        /// <summary>Title as the arrs (or Seerr) name it.</summary>
        public string? Title { get; init; }

        /// <summary>The status, admin shape (explain: stage, reason, every copy's line and fix).</summary>
        public JsonNode? Status { get; init; }

        /// <summary>Every instance of the title's kind (versions across instances).</summary>
        public IReadOnlyList<ManageInstance> Instances { get; init; } = Array.Empty<ManageInstance>();

        /// <summary>Jellyfin copies.</summary>
        public IReadOnlyList<ManageCopy> Copies { get; init; } = Array.Empty<ManageCopy>();

        /// <summary>Seerr requests for the title.</summary>
        public IReadOnlyList<ManageRequest> Requests { get; init; } = Array.Empty<ManageRequest>();

        /// <summary>
        /// Phase 3 with Jellyfin Enhanced handling requests: "Add to {instance}" adds the title directly
        /// (a sheet with the instance's add defaults) instead of linking to the arr.
        /// </summary>
        public bool AddDirect { get; init; }
    }

    /// <summary>What Search now did.</summary>
    public sealed class ManageSearchResult
    {
        /// <summary>The action outcome (status, message, read-back, audit id).</summary>
        public ArrActionOutcome Outcome { get; init; } = new();

        /// <summary>
        /// True: the arr grabbed a release for the title in scope while the search ran (a "grabbed"
        /// event for it in the arr's history since the search started). False: the search finished
        /// and grabbed nothing. Null: unknown (still running, failed, or the history could not be read).
        /// </summary>
        public bool? Found { get; init; }

        /// <summary>
        /// A press refusal (D53, edition round 19): <c>press_changed</c> or <c>press_unverified</c> when the season page's
        /// control no longer does what it was drawn to do; nothing was searched. Null otherwise.
        /// </summary>
        public string? Refusal { get; init; }
    }

    /// <summary>
    /// The administrator's Manage drawer, Overview only (phase 1): the title's explanation (the
    /// admin-shape status), a timeline per instance (added → history events → Jellyfin Enhanced
    /// actions), its copies across every instance of its kind (versions), Seerr's requests, and
    /// Search now, run through the audited action runner. Everything shown comes from the arr
    /// snapshots, the audit log, the request read model and Jellyfin; only Search now calls an arr.
    /// </summary>
    public sealed class ArrManageService
    {
        private const int MaxEvents = 40;
        private static readonly TimeSpan SearchWatch = TimeSpan.FromSeconds(10);

        private readonly ArrStatusService _status;
        private readonly ArrStateStore _store;
        private readonly ArrClientFactory _clients;
        private readonly ArrActionRunner _runner;
        private readonly ArrAuditLog _audit;
        private readonly IArrRequestFacts _requests;
        private readonly ArrLiveService? _live;
        private readonly ArrChangeFeed? _feed;
        private readonly Func<PluginConfiguration?> _config;
        private readonly Func<TimeSpan, CancellationToken, Task> _delay;

        /// <summary>The service (DI).</summary>
        public ArrManageService(ArrStatusService status, ArrClientFactory clients, ArrActionRunner runner, ArrAuditLog audit, IArrRequestFacts requests, ArrLiveService live, ArrChangeFeed feed)
            : this(status, clients, runner, audit, requests, live, feed, null, null)
        {
        }

        /// <summary>The service with explicit configuration and delay (tests).</summary>
        internal ArrManageService(ArrStatusService status, ArrClientFactory clients, ArrActionRunner runner, ArrAuditLog audit, IArrRequestFacts requests, ArrLiveService? live, ArrChangeFeed? feed, Func<PluginConfiguration?>? config, Func<TimeSpan, CancellationToken, Task>? delay)
        {
            _status = status;
            _store = status.Store;
            _clients = clients;
            _runner = runner;
            _audit = audit;
            _requests = requests;
            _live = live;
            _feed = feed;
            _config = config ?? (() => JellyfinEnhanced.Instance?.Configuration);
            _delay = delay ?? ((t, ct) => Task.Delay(t, ct));
        }

        /// <summary>The status service (viewer lookup).</summary>
        public ArrStatusService Status => _status;

        /// <summary>Phase 1 and the Manage drawer are on.</summary>
        public bool Enabled => _status.Enabled && _config()?.ArrManageDrawerEnabled == true;

        /// <summary>
        /// The key and Jellyfin item the drawer is about: a Jellyfin item the admin can see (its
        /// season/episode key), or a title key (movie, series, season or episode). Null when neither resolves.
        /// </summary>
        public (TitleKey Key, JfItemRef? Item)? Resolve(StatusViewer viewer, Guid? itemId, string? key)
        {
            if (itemId is Guid id)
            {
                return _status.View.Resolve(id, viewer) is { Key: { } k } item ? (k, item) : null;
            }
            if (TitleKey.Parse(key) is not { } parsed) return null;
            // A season or episode key: the Jellyfin item for it when there is one (as if the drawer
            // had been opened on that page), so the explanation is about that season or episode.
            return (parsed, _status.ScopeItem(viewer, parsed));
        }

        /// <summary>The drawer's Overview for a title (administrators only; the caller checks).</summary>
        public async Task<ManageResponse> OverviewAsync(StatusViewer viewer, TitleKey key, JfItemRef? item, CancellationToken cancellationToken)
        {
            var title = key.Title;
            var statusBody = item != null
                ? await _status.ForItemAsync(viewer, item.ItemId, cancellationToken).ConfigureAwait(false)
                : key.Season.HasValue
                    ? await _status.ForScopeKeyAsync(viewer, key, cancellationToken).ConfigureAwait(false)
                    : await _status.ForKeyDetailAsync(viewer, title, cancellationToken).ConfigureAwait(false);
            var status = (JsonNode.Parse(statusBody.Json)?["items"] as JsonArray)?.FirstOrDefault()?.DeepClone();
            // A season or episode Jellyfin doesn't have was composed on a stand-in without an item.
            if (status is JsonObject composed && (string?)composed["itemId"] == Guid.Empty.ToString("N", CultureInfo.InvariantCulture)) composed.Remove("itemId");

            var kind = key.IsMovie ? ArrKind.Radarr : ArrKind.Sonarr;
            var audit = _audit.ReadRecent(500);
            var jfCopies = _status.CopiesOf(title, viewer).Display;
            var holders = new List<(ArrConnection Instance, ArrMovieEntry? Movie, ArrSeriesEntry? Series)>();
            var instances = new List<ManageInstance>();
            string? name = null;
            int? tmdb = key.IsMovie && key.Provider == "tmdb" ? key.NumericId : null;
            int? tvdb = !key.IsMovie && key.Provider == "tvdb" ? key.NumericId : null;
            foreach (var instance in _store.Registry.All().Where(c => c.Kind == kind && c.Usable))
            {
                var library = await _store.GetLibraryAsync(instance, cancellationToken).ConfigureAwait(false);
                var queue = await _store.GetQueueAsync(instance, cancellationToken).ConfigureAwait(false);
                var history = await _store.GetHistoryAsync(instance, cancellationToken).ConfigureAwait(false);
                var system = await _store.GetSystemAsync(instance, cancellationToken).ConfigureAwait(false);
                var live = _live?.ConnectionStatus(instance.Id).State == ArrLiveState.Connected;
                var movie = key.IsMovie ? FindMovie(library.Value, title) : null;
                var series = key.IsMovie ? null : FindSeries(library.Value, title);
                var arrId = movie?.Id ?? series?.Id;
                if (arrId == null)
                {
                    instances.Add(new ManageInstance
                    {
                        Id = instance.Id, Name = instance.Name, Kind = instance.Kind.ToString(), Role = instance.Role,
                        Url = instance.Url, UrlMappings = instance.UrlMappings, Live = live, Readable = library.Value != null,
                    });
                    continue;
                }
                name ??= movie?.Title ?? series?.Title;
                tmdb ??= movie?.TmdbId ?? series?.TmdbId;
                tvdb ??= series?.TvdbId;
                bool InScope(int? season, int? episode)
                    => (key.Season is not int s || season == s) && (key.Episode is not int e || episode == e);
                // An expired queue says nothing about now: no rows, no downloads to act on.
                var retained = queue.Expired ? Array.Empty<ArrQueueEntry>() : _store.MissedQueueRows(instance);
                IReadOnlyList<ArrQueueEntry>? records = queue.Expired ? null : queue.Value?.Records.Concat(retained).DistinctBy(r => r.Id).ToList();
                var scoped = (records ?? Array.Empty<ArrQueueEntry>())
                    .Where(r => (key.IsMovie ? r.MovieId : r.SeriesId) == arrId && InScope(r.SeasonNumber, r.EpisodeNumber))
                    .ToList();
                // Phase 2: the whole downloads those rows belong to, with their actions (a pack's other
                // episodes count: removing it removes them too).
                var scopedIds = new HashSet<int>(scoped.Select(r => r.Id));
                var allDownloads = JellyfinBridge.Phase2(_config()) && scoped.Count > 0
                    ? NeedsAttention.Group(instance, queue.Value, library.Value, row => _store.QueueSeen(instance, row), retained: retained).Where(g => g.ArrId == arrId && g.Ids.Any(scopedIds.Contains)).ToList()
                    : new List<QueueGroup>();
                var downloads = allDownloads.Take(20).ToList();
                var rows = scoped
                    .Take(50)
                    .Select(r => new ManageQueueRow
                    {
                        Season = r.SeasonNumber,
                        Episode = r.EpisodeNumber,
                        State = r.TrackedDownloadState ?? r.Status,
                        Health = r.TrackedDownloadStatus,
                        Percent = r.Size is > 0 && r.SizeLeft is double left ? (int)Math.Clamp(Math.Floor((r.Size.Value - left) * 100 / r.Size.Value), 0, 100) : null,
                        Release = r.ReleaseTitle,
                        Client = r.DownloadClient,
                        Quality = r.Quality,
                        Messages = r.StatusMessages.Concat(string.IsNullOrEmpty(r.ErrorMessage) ? Array.Empty<string>() : new[] { r.ErrorMessage! }).Take(5).ToList(),
                    })
                    .ToList();
                var events = new List<ManageEvent>();
                var added = movie?.Added ?? series?.Added;
                if (added != null) events.Add(new ManageEvent { Event = "added", At = added });
                events.AddRange((history.Value?.Records ?? Array.Empty<ArrHistoryEntry>())
                    .Where(h => (key.IsMovie ? h.MovieId : h.SeriesId) == arrId && InScope(h.SeasonNumber, h.EpisodeNumber))
                    .Select(h => new ManageEvent { Event = h.EventType ?? "unknown", At = h.Date, Season = h.SeasonNumber, Episode = h.EpisodeNumber, Message = h.Message }));
                var targets = Targets(key.IsMovie, arrId.Value);
                events.AddRange(audit
                    .Where(a => string.Equals(a.InstanceId, instance.Id, StringComparison.OrdinalIgnoreCase) && targets.Any(t => a.Target == t || a.Target.StartsWith(t + ":", StringComparison.Ordinal)) && a.Outcome != ArrAuditLog.StartedOutcome)
                    .Select(a => new ManageEvent { Event = "audit", At = a.Time.UtcDateTime, Text = string.Join(" · ", new[] { a.Action, a.Outcome, a.UserName, a.ReadBack }.Where(x => !string.IsNullOrEmpty(x))) }));
                var searching = _live?.ActiveSearches(instance.Id).Any(s => s.TitleIds.Contains(arrId.Value)) == true;
                var profileId = movie?.QualityProfileId ?? series?.QualityProfileId;
                holders.Add((instance, movie, series));
                instances.Add(new ManageInstance
                {
                    Id = instance.Id,
                    Name = instance.Name,
                    Kind = instance.Kind.ToString(),
                    Role = instance.Role,
                    Url = instance.Url,
                    UrlMappings = instance.UrlMappings,
                    Live = live,
                    Readable = true,
                    InArr = true,
                    ArrId = arrId,
                    TitleSlug = series?.TitleSlug,
                    Monitored = movie?.Monitored ?? series?.Monitored,
                    HasFile = movie?.HasFile ?? (series != null ? series.EpisodeFileCount > 0 : null),
                    SizeOnDisk = movie?.SizeOnDisk ?? series?.SizeOnDisk,
                    Path = movie?.Path ?? series?.Path,
                    QualityProfile = system.Value?.QualityProfiles.FirstOrDefault(p => p.Id == profileId)?.Name,
                    MinimumAvailability = movie?.MinimumAvailability,
                    LastSearch = movie?.LastSearchTime,
                    Searching = searching,
                    Queue = rows,
                    QueueTotal = scoped.Count,
                    Downloads = downloads,
                    DownloadsTotal = allDownloads.Count,
                    QueueAsOf = queue.Stale || queue.Expired ? queue.LoadedAt : null,
                    QueueExpired = queue.Expired,
                    Timeline = events.Where(e => e.At != null).OrderBy(e => e.At).TakeLast(MaxEvents).ToList(),
                });
            }

            // Which Jellyfin copy belongs to which instance (linked libraries, path mappings, folder names).
            var arrCopies = holders.Select(h => new ArrCopyFacts(h.Instance) { Movie = h.Movie, Series = h.Series }).ToList();
            for (var i = 0; i < instances.Count; i++)
            {
                var held = arrCopies.FirstOrDefault(h => h.Instance.Id == instances[i].Id);
                if (held == null) continue;
                var match = StatusComposer.MatchCopies(held, jfCopies, arrCopies).FirstOrDefault();
                if (match == null) continue;
                var original = instances[i];
                instances[i] = new ManageInstance
                {
                    Id = original.Id, Name = original.Name, Kind = original.Kind, Role = original.Role, Url = original.Url, UrlMappings = original.UrlMappings,
                    Live = original.Live, Readable = original.Readable, InArr = original.InArr, ArrId = original.ArrId, TitleSlug = original.TitleSlug,
                    Monitored = original.Monitored, HasFile = original.HasFile, SizeOnDisk = original.SizeOnDisk, Path = original.Path,
                    QualityProfile = original.QualityProfile, MinimumAvailability = original.MinimumAvailability, LastSearch = original.LastSearch,
                    Searching = original.Searching, Queue = original.Queue, QueueTotal = original.QueueTotal, Downloads = original.Downloads, DownloadsTotal = original.DownloadsTotal, QueueAsOf = original.QueueAsOf, QueueExpired = original.QueueExpired, Timeline = original.Timeline,
                    Library = match.LibraryName,
                    ItemId = match.ItemId.ToString("N", CultureInfo.InvariantCulture),
                    InJellyfinAt = match.DateCreated,
                };
            }

            var requests = _requests is SeerrRequestReadModel model ? model.ForTitle(title) : Array.Empty<SeerrRequestRecord>();
            name ??= _requests is SeerrRequestReadModel m && requests.FirstOrDefault() is { } first ? m.Meta(first.IsMovie, first.TmdbId)?.Title : null;
            return new ManageResponse
            {
                Key = key.ToString(),
                Kind = key.Kind,
                ItemId = item?.ItemId.ToString("N", CultureInfo.InvariantCulture),
                Season = key.Season,
                Episode = key.Episode,
                TmdbId = tmdb,
                TvdbId = tvdb,
                Title = name,
                Status = status,
                Instances = instances,
                AddDirect = Requests.ArrAddService.DirectOn(_config()),
                Copies = jfCopies.Select(c => new ManageCopy { ItemId = c.ItemId.ToString("N", CultureInfo.InvariantCulture), Library = c.LibraryName, Added = c.DateCreated }).ToList(),
                Requests = requests.Select(r => new ManageRequest
                {
                    At = r.CreatedAt,
                    Status = r.Status switch
                    {
                        SeerrRequestStatus.Pending => "pending",
                        SeerrRequestStatus.Approved => "approved",
                        SeerrRequestStatus.Declined => "declined",
                        SeerrRequestStatus.Failed => "failed",
                        SeerrRequestStatus.Completed => "available",
                        _ => "unknown",
                    },
                    By = r.RequestedByName,
                    AnsweredBy = r.Status is SeerrRequestStatus.Pending ? null : r.ModifiedByName,
                    Is4k = r.Is4k,
                    Seasons = r.IsMovie ? null : r.Seasons,
                }).ToList(),
            };
        }

        private static ArrMovieEntry? FindMovie(ArrLibrarySnapshot? library, TitleKey title)
            => library == null ? null : title.Provider == "tmdb" && title.NumericId is int tmdb ? library.MovieByTmdb(tmdb) : library.MovieByImdb(title.Id);

        private static ArrSeriesEntry? FindSeries(ArrLibrarySnapshot? library, TitleKey title)
            => library == null ? null : title.Provider switch
            {
                "tvdb" when title.NumericId is int tvdb => library.SeriesByTvdb(tvdb),
                "tmdb" when title.NumericId is int tmdb => library.SeriesByTmdb(tmdb),
                "imdb" => library.SeriesByImdb(title.Id),
                _ => null,
            };

        // Audit targets of a title's actions (Search now uses these).
        private static string[] Targets(bool movie, int arrId)
            => movie ? new[] { "movie:" + arrId.ToString(CultureInfo.InvariantCulture) } : new[] { "series:" + arrId.ToString(CultureInfo.InvariantCulture), "episode-of:" + arrId.ToString(CultureInfo.InvariantCulture) };

        /// <summary>
        /// A season page's press refused before anything ran (D53, edition round 20: its request says something else than the
        /// press it was checked for), audited like the runner's refusals.
        /// </summary>
        internal ManageSearchResult RefusePress(StatusViewer viewer, string? userName, string instanceId, TitleKey key, string refusal)
            => new() { Outcome = Refuse(viewer, userName, instanceId, key, refusal, PressChecks.Message(refusal)), Refusal = refusal };

        /// <summary>
        /// The earlier outcome of the identical press under this click's key, as a replay; a conflict when the key was used for
        /// another press; null when none (see <see cref="ArrActionRunner.ReplayPressAsync"/>).
        /// </summary>
        internal Task<ArrActionOutcome?> ReplayPressAsync(Guid user, string idempotencyKey, string fingerprint, CancellationToken cancellationToken)
            => _runner.ReplayPressAsync(user, idempotencyKey, fingerprint, cancellationToken);

        /// <summary>The audited runner: one key namespace and one owner per person's key (see <see cref="ArrActionRunner.SingleFlightAsync{T}"/>).</summary>
        internal ArrActionRunner Runner => _runner;

        /// <summary>A Search now refused before any arr call, written to the audit log (and so to Jellyfin's activity log) like the runner's refusals.</summary>
        private ArrActionOutcome Refuse(StatusViewer viewer, string? userName, string instanceId, TitleKey key, string reason, string message)
        {
            var id = Guid.NewGuid().ToString("N");
            var audited = _audit.Append(new ArrAuditEntry
            {
                Id = id,
                Time = DateTimeOffset.UtcNow,
                UserId = viewer.UserId.ToString("N"),
                UserName = userName,
                Action = key.IsMovie ? "movie.search" : key.Episode != null ? "episode.search" : key.Season != null ? "season.search" : "series.search",
                Tier = (int)ArrActionTier.Safe,
                InstanceId = instanceId,
                Target = "key:" + key,
                Outcome = ArrActionStatus.Rejected.ToString().ToLowerInvariant(),
                Error = reason,
                Message = message,
                Details = new Dictionary<string, string> { ["key"] = key.ToString() },
            });
            return new ArrActionOutcome { Status = ArrActionStatus.Rejected, Message = message, AuditId = audited ? id : string.Empty, Audited = audited, Conflict = reason == PressChecks.Conflict };
        }

        /// <summary>
        /// Search now on one instance for the title in scope (movie, series, season or episode),
        /// through the audited action runner (one idempotency key per click). The read-back follows
        /// the arr's command for up to ten seconds and reports how it ended (or that it is still running).
        /// </summary>
        public async Task<ArrActionOutcome> SearchAsync(StatusViewer viewer, string? userName, string instanceId, TitleKey key, string idempotencyKey, CancellationToken cancellationToken)
            => (await SearchCheckedAsync(viewer, userName, instanceId, key, idempotencyKey, cancellationToken).ConfigureAwait(false)).Outcome;

        /// <summary>
        /// <see cref="SearchAsync"/>, and whether it found a copy: once the arr's search command has
        /// completed, the arr's history of the title in scope is read for a grab since the command
        /// started (<see cref="ManageSearchResult.Found"/>), so the page can say "Found a copy" or
        /// "Nothing found yet" honestly.
        /// </summary>
        public Task<ManageSearchResult> SearchCheckedAsync(StatusViewer viewer, string? userName, string instanceId, TitleKey key, string idempotencyKey, CancellationToken cancellationToken)
            => SearchCoreAsync(viewer, userName, instanceId, key, null, idempotencyKey, cancellationToken);

        /// <summary>
        /// <see cref="SearchCheckedAsync"/> as a press (D53, edition round 19: the server decides every press): a season key with
        /// <paramref name="episodeNumbers"/> searches exactly those episodes of that season (one EpisodeSearch, never the whole
        /// season); <paramref name="recheck"/> works the press out again after the arr reads, right before the command is sent
        /// (a refusal sends nothing: <see cref="ManageSearchResult.Refusal"/>).
        /// </summary>
        /// <param name="viewer">The caller.</param>
        /// <param name="userName">The caller's name for the audit log, if known.</param>
        /// <param name="instanceId">The instance.</param>
        /// <param name="key">The title key in scope.</param>
        /// <param name="episodeNumbers">A season key's episodes to search (null: the key's whole scope).</param>
        /// <param name="idempotencyKey">One per press.</param>
        /// <param name="recheck">The press, worked out again (null: none).</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>The outcome.</returns>
        /// <param name="owned">The caller already owns the person's key (<see cref="ArrActionRunner.SingleFlightAsync{T}"/>).</param>
        /// <param name="identity">The request's identity when the caller describes it (a household Search: its own route and key).</param>
        internal Task<ManageSearchResult> SearchPressAsync(StatusViewer viewer, string? userName, string instanceId, TitleKey key, IReadOnlyList<int>? episodeNumbers, string idempotencyKey, Func<CancellationToken, Task<string?>>? recheck, CancellationToken cancellationToken, bool owned = false, string? identity = null)
            => SearchCoreAsync(viewer, userName, instanceId, key, null, idempotencyKey, cancellationToken, episodeNumbers, recheck, owned, identity);

        /// <summary>
        /// <see cref="SearchCheckedAsync"/> for exactly these episodes of the series (or season) in <paramref name="key"/>:
        /// one EpisodeSearch command with their Sonarr ids (the ones the instance doesn't list are left out; none left:
        /// refused). <see cref="ManageSearchResult.Found"/> is a grab of any of them since the command started.
        /// </summary>
        /// <param name="viewer">The caller.</param>
        /// <param name="userName">The caller's name for the audit log, if known.</param>
        /// <param name="instanceId">The Sonarr instance.</param>
        /// <param name="key">The series or season key in scope (audit, feed).</param>
        /// <param name="episodeIds">Sonarr episode ids to search.</param>
        /// <param name="idempotencyKey">One per press.</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>The outcome and whether the search grabbed one of them.</returns>
        public Task<ManageSearchResult> SearchEpisodesCheckedAsync(StatusViewer viewer, string? userName, string instanceId, TitleKey key, IReadOnlyList<int> episodeIds, string idempotencyKey, CancellationToken cancellationToken)
            => SearchCoreAsync(viewer, userName, instanceId, key, episodeIds, idempotencyKey, cancellationToken);

        /// <summary>
        /// <see cref="SearchEpisodesCheckedAsync"/> with the press worked out again (<paramref name="recheck"/>) after the arr
        /// reads, right before the command is sent (a household Search: its candidates are never used past a change).
        /// </summary>
        /// <param name="owned">The caller already owns the person's key (<see cref="ArrActionRunner.SingleFlightAsync{T}"/>).</param>
        /// <param name="identity">The request's identity when the caller describes it (a household Search: its own route and key).</param>
        internal Task<ManageSearchResult> SearchEpisodesPressAsync(StatusViewer viewer, string? userName, string instanceId, TitleKey key, IReadOnlyList<int> episodeIds, string idempotencyKey, Func<CancellationToken, Task<string?>>? recheck, CancellationToken cancellationToken, bool owned = false, string? identity = null)
            => SearchCoreAsync(viewer, userName, instanceId, key, episodeIds, idempotencyKey, cancellationToken, null, recheck, owned, identity);

        /// <summary>
        /// The identity of a Search without a season page's press (D53, edition round 22: one key namespace per person): what it
        /// searches and where, so the same key reused for anything else (a press, another title, other episodes) is a conflict.
        /// </summary>
        internal static string SearchIdentity(string route, string instanceId, TitleKey key, IReadOnlyList<int>? episodeIds, IReadOnlyList<int>? episodeNumbers)
            => ArrActionRunner.Identity("search:" + route, instanceId, key.ToString(),
                episodeIds == null ? null : "ids:" + string.Join(",", episodeIds.Distinct().OrderBy(x => x)),
                episodeNumbers == null ? null : "numbers:" + string.Join(",", episodeNumbers.Distinct().OrderBy(x => x)));

        private ManageSearchResult Conflict(StatusViewer viewer, string? userName, string instanceId, TitleKey key)
            => new() { Outcome = Refuse(viewer, userName, instanceId, key, PressChecks.Conflict, PressChecks.Message(PressChecks.Conflict)), Refusal = PressChecks.Conflict };

        private async Task<ManageSearchResult> SearchCoreAsync(StatusViewer viewer, string? userName, string instanceId, TitleKey key, IReadOnlyList<int>? episodeIds, string idempotencyKey, CancellationToken cancellationToken,
            IReadOnlyList<int>? episodeNumbers = null, Func<CancellationToken, Task<string?>>? recheck = null, bool owned = false, string? identity = null)
        {
            if (episodeIds != null && (key.IsMovie || key.Episode != null || episodeIds.Count == 0))
                return new ManageSearchResult { Outcome = Refuse(viewer, userName, instanceId, key, "invalid_input", "Choose episodes of a series or season.") };
            if (episodeNumbers != null && (key.IsMovie || key.Season == null || key.Episode != null || episodeNumbers.Count == 0))
                return new ManageSearchResult { Outcome = Refuse(viewer, userName, instanceId, key, "invalid_input", "Choose episodes of a season.") };
            identity ??= SearchIdentity("admin", instanceId, key, episodeIds, episodeNumbers);
            // One owner of the person's key at a time; an identical request meanwhile gets its result (D53, edition round 22).
            if (!owned)
            {
                return await _runner.SingleFlightAsync(viewer.UserId, idempotencyKey, identity,
                    ct => SearchCoreAsync(viewer, userName, instanceId, key, episodeIds, idempotencyKey, ct, episodeNumbers, recheck, owned: true, identity),
                    () => Conflict(viewer, userName, instanceId, key), cancellationToken).ConfigureAwait(false);
            }
            // A retry of a Search that already ran (its answer was lost) gets that outcome before anything is checked again (D53,
            // edition round 20: replay before revalidation); the same key used for anything else is refused (round 22).
            if (await _runner.ReplayPressAsync(viewer.UserId, idempotencyKey, identity, cancellationToken).ConfigureAwait(false) is { } replayed)
                return replayed.Conflict ? Conflict(viewer, userName, instanceId, key) : new ManageSearchResult { Outcome = replayed };
            var instance = _store.Registry.Get(instanceId);
            if (instance == null || !instance.Usable || instance.Kind != (key.IsMovie ? ArrKind.Radarr : ArrKind.Sonarr))
                return new ManageSearchResult { Outcome = Refuse(viewer, userName, instanceId, key, "wrong_instance", "That instance can't search for this title.") };
            // What is searched comes from the instance as it is now (D53, edition round 22: ownership and episode ids are never
            // taken from the index held for pages), and the command goes out on the connection those reads went through.
            var library = await _store.ReadLibraryNowAsync(instance, cancellationToken).ConfigureAwait(false);
            if (library.Value == null || library.Error != null || library.ReadBy is not { } bound)
                return new ManageSearchResult { Outcome = Refuse(viewer, userName, instanceId, key, PressChecks.Unverified, PressChecks.Message(PressChecks.Unverified)), Refusal = PressChecks.Unverified };
            var title = key.Title;
            var arrId = key.IsMovie ? FindMovie(library.Value, title)?.Id : FindSeries(library.Value, title)?.Id;
            if (arrId == null)
                return new ManageSearchResult { Outcome = Refuse(viewer, userName, instance.Id, key, "not_in_arr", $"{instance.Name} doesn't have this title.") };

            object command;
            string action;
            string target;
            IReadOnlyCollection<int>? episodeSet = null;
            int? seasonNumber = key.Season;
            if (key.IsMovie)
            {
                command = new { name = "MoviesSearch", movieIds = new[] { arrId.Value } };
                action = "movie.search";
                target = "movie:" + arrId.Value.ToString(CultureInfo.InvariantCulture);
            }
            else if (episodeIds != null || episodeNumbers != null)
            {
                var episodes = await _store.ReadEpisodesNowAsync(instance, arrId.Value, cancellationToken).ConfigureAwait(false);
                if (Unbound(episodes.ReadBy, episodes.Error)) return Unverified(viewer, userName, instance.Id, key);
                var listed = episodes.Value?.Episodes.Select(e => e.Id).ToHashSet() ?? new HashSet<int>();
                int[] ids;
                if (episodeNumbers != null)
                {
                    // Exactly the episodes the press names (enumerated episodes are never widened to the season): every one of
                    // them, or nothing.
                    var listedHere = (episodes.Value?.Episodes ?? Array.Empty<ArrEpisodeEntry>()).Where(e => e.SeasonNumber == key.Season && episodeNumbers.Contains(e.EpisodeNumber)).ToList();
                    ids = listedHere.Count == episodeNumbers.Distinct().Count() ? listedHere.Select(e => e.Id).Distinct().OrderBy(x => x).ToArray() : Array.Empty<int>();
                }
                else ids = episodeIds!.Where(listed.Contains).Distinct().OrderBy(x => x).ToArray();
                if (ids.Length == 0)
                    return new ManageSearchResult { Outcome = Refuse(viewer, userName, instance.Id, key, "no_such_episode", $"{instance.Name} doesn't list those episodes of this series.") };
                command = new { name = "EpisodeSearch", episodeIds = ids };
                episodeSet = ids;
                action = "episode.search";
                target = "episode-of:" + arrId.Value.ToString(CultureInfo.InvariantCulture) + ":" + string.Join(",", ids.Select(x => x.ToString(CultureInfo.InvariantCulture)));
            }
            else if (key.Episode is int episode && key.Season is int season)
            {
                var episodes = await _store.ReadEpisodesNowAsync(instance, arrId.Value, cancellationToken).ConfigureAwait(false);
                if (Unbound(episodes.ReadBy, episodes.Error)) return Unverified(viewer, userName, instance.Id, key);
                var match = episodes.Value?.Episodes.FirstOrDefault(e => e.SeasonNumber == season && e.EpisodeNumber == episode);
                if (match == null)
                    return new ManageSearchResult { Outcome = Refuse(viewer, userName, instance.Id, key, "no_such_episode", $"{instance.Name} doesn't list S{season:00}E{episode:00} of this series.") };
                command = new { name = "EpisodeSearch", episodeIds = new[] { match.Id } };
                episodeSet = new[] { match.Id };
                action = "episode.search";
                target = "episode-of:" + arrId.Value.ToString(CultureInfo.InvariantCulture) + ":" + match.Id.ToString(CultureInfo.InvariantCulture);
            }
            else if (key.Season is int seasonOnly)
            {
                command = new { name = "SeasonSearch", seriesId = arrId.Value, seasonNumber = seasonOnly };
                action = "season.search";
                target = "series:" + arrId.Value.ToString(CultureInfo.InvariantCulture) + ":s" + seasonOnly.ToString(CultureInfo.InvariantCulture);
            }
            else
            {
                command = new { name = "SeriesSearch", seriesId = arrId.Value };
                action = "series.search";
                target = "series:" + arrId.Value.ToString(CultureInfo.InvariantCulture);
            }

            // The press worked out again after the arr reads (D53, edition round 19); from here to the command no await.
            if (recheck != null && await recheck(cancellationToken).ConfigureAwait(false) is { } refusal)
                return new ManageSearchResult { Outcome = Refuse(viewer, userName, instance.Id, key, refusal, PressChecks.Message(refusal)), Refusal = refusal };

            return await RunSearchAsync(viewer, userName, instance, bound, key, arrId.Value, command, action, target, episodeSet, seasonNumber, idempotencyKey, identity, cancellationToken).ConfigureAwait(false);

            // A read for the Search made through another connection than the library read (the instance was pointed elsewhere).
            bool Unbound(ArrClient? readBy, ArrError? error)
                => error != null || readBy == null || !string.Equals(readBy.Generation, bound.Generation, StringComparison.Ordinal);
        }

        private ManageSearchResult Unverified(StatusViewer viewer, string? userName, string instanceId, TitleKey key)
            => new() { Outcome = Refuse(viewer, userName, instanceId, key, PressChecks.Unverified, PressChecks.Message(PressChecks.Unverified)), Refusal = PressChecks.Unverified };

        /// <summary>
        /// A season page's Search press (D53, edition round 21: the check returns the command that executes): a retry of the
        /// identical press gets its outcome before anything is checked (the same key used for another press is refused,
        /// <see cref="PressChecks.Conflict"/>); else <paramref name="check"/> works the press out against fresh facts and
        /// returns the command, and exactly that command runs (one EpisodeSearch of its Sonarr ids, from the episode list read
        /// at the check, on its instance), under its fingerprint. Nothing chosen before the check is sent.
        /// </summary>
        /// <param name="viewer">The caller.</param>
        /// <param name="userName">The caller's name for the audit log, if known.</param>
        /// <param name="instanceId">The instance the request named (audit of a refusal).</param>
        /// <param name="key">The key the request named (audit of a refusal).</param>
        /// <param name="idempotencyKey">One per press.</param>
        /// <param name="fingerprint">The press as its request describes it (<see cref="PressChecks.RequestFingerprint"/>).</param>
        /// <param name="check">The press, worked out now: a refusal or the command.</param>
        /// <param name="cancellationToken">Cancellation.</param>
        /// <returns>The outcome and whether the search grabbed one of its episodes.</returns>
        /// <param name="owned">The caller already owns the person's key (<see cref="ArrActionRunner.SingleFlightAsync{T}"/>).</param>
        internal async Task<ManageSearchResult> SearchCommandAsync(StatusViewer viewer, string? userName, string instanceId, TitleKey key, string idempotencyKey, string fingerprint, Func<CancellationToken, Task<PressProof>> check, CancellationToken cancellationToken, bool owned = false, string? incomingIdentity = null)
        {
            var identity = incomingIdentity ?? fingerprint;
            // One owner of the person's key before anything is checked (D53, edition round 22).
            if (!owned)
            {
                return await _runner.SingleFlightAsync(viewer.UserId, idempotencyKey, identity,
                    ct => SearchCommandAsync(viewer, userName, instanceId, key, idempotencyKey, fingerprint, check, ct, owned: true, incomingIdentity: identity),
                    () => Conflict(viewer, userName, instanceId, key), cancellationToken).ConfigureAwait(false);
            }
            if (await _runner.ReplayPressAsync(viewer.UserId, idempotencyKey, identity, cancellationToken).ConfigureAwait(false) is { } replayed)
            {
                return replayed.Conflict
                    ? new ManageSearchResult { Outcome = Refuse(viewer, userName, instanceId, key, PressChecks.Conflict, PressChecks.Message(PressChecks.Conflict)), Refusal = PressChecks.Conflict }
                    : new ManageSearchResult { Outcome = replayed };
            }
            var proof = await check(cancellationToken).ConfigureAwait(false);
            var refusal = proof.Refusal
                ?? (proof.Command is { SeriesId: int, Instance: not null, EpisodeIds.Count: > 0 } done && done.Fingerprint == fingerprint ? null : PressChecks.Changed);
            var command = proof.Command!;
            var instance = refusal == null ? _store.Registry.Get(command.Instance!) : null;
            if (refusal == null && (instance == null || !instance.Usable || instance.Kind != ArrKind.Sonarr)) refusal = PressChecks.Changed;
            // Only on the connection the check read it through (D53, edition round 22): a save that pointed the instance elsewhere
            // since sends the checked Sonarr ids nowhere.
            if (refusal == null && (command.Connection is not { } checkedClient || !_clients.Bound(checkedClient).Ok)) refusal = PressChecks.Changed;
            if (refusal != null)
                return new ManageSearchResult { Outcome = Refuse(viewer, userName, instanceId, key, refusal, PressChecks.Message(refusal)), Refusal = refusal };
            // From the check to the command no await but the runner's own: exactly the command, nothing else.
            var ids = command.EpisodeIds.ToArray();
            var seriesId = command.SeriesId!.Value;
            var target = "episode-of:" + seriesId.ToString(CultureInfo.InvariantCulture) + ":" + string.Join(",", ids.Select(x => x.ToString(CultureInfo.InvariantCulture)));
            return await RunSearchAsync(viewer, userName, instance!, command.Connection!, command.Title.Title.WithSeason(command.Season), seriesId, new { name = "EpisodeSearch", episodeIds = ids }, "episode.search", target, ids, command.Season,
                idempotencyKey, identity, cancellationToken).ConfigureAwait(false);
        }

        // Runs one Search command through the audited runner and reads back how it ended (and whether it grabbed something),
        // on the connection its facts were read through (bound): at the send it must still be the instance's connection, and the
        // read-back stays on it (never a replacement's answer for a command id of its own).
        private async Task<ManageSearchResult> RunSearchAsync(StatusViewer viewer, string? userName, ArrConnection instance, ArrClient bound, TitleKey key, int arrId, object command, string action, string target,
            IReadOnlyCollection<int>? episodeSet, int? seasonNumber, string idempotencyKey, string? fingerprint, CancellationToken cancellationToken)
        {
            var title = key.Title;
            bool? found = null;
            int? commandId = null;
            var outcome = await _runner.RunAsync(new ArrActionRequest
            {
                Action = action,
                InstanceId = instance.Id,
                Target = target,
                UserId = viewer.UserId,
                UserName = userName,
                IdempotencyKey = idempotencyKey,
                Tier = ArrActionTier.Safe,
                Details = new Dictionary<string, string> { ["key"] = key.ToString() },
                Timeout = TimeSpan.FromSeconds(30),
                Fingerprint = fingerprint,
                Binding = ArrClientFactory.Tag(bound),
                Execute = async ct =>
                {
                    var client = _clients.Bound(bound);
                    if (!client.Ok) return client.Error;
                    var sent = await client.Value!.SendAsync<ArrCommandWire>(HttpMethod.Post, "command", command, null, ct).ConfigureAwait(false);
                    if (!sent.Ok) return sent.Error;
                    commandId = sent.Value?.Id;
                    return null;
                },
                ReadBack = async ct =>
                {
                    if (commandId is not int id) return new ArrReadBack { Confirmed = null, Summary = "The instance accepted the search." };
                    var client = ArrResult<ArrClient>.Success(bound);
                    var until = DateTimeOffset.UtcNow + SearchWatch;
                    ArrCommandWire? last = null;
                    while (true)
                    {
                        var read = await client.Value!.GetAsync<ArrCommandWire>("command/" + id.ToString(CultureInfo.InvariantCulture), null, ArrCallClass.Read, ct).ConfigureAwait(false);
                        if (read.Ok) last = read.Value;
                        var state = last?.Status?.ToLowerInvariant();
                        if (state is "completed" or "failed" or "aborted" or "cancelled" || DateTimeOffset.UtcNow >= until) break;
                        await _delay(TimeSpan.FromSeconds(1), ct).ConfigureAwait(false);
                    }
                    if (last == null) return new ArrReadBack { Confirmed = null, Summary = "Could not check the search." };
                    var message = string.IsNullOrWhiteSpace(last.Message) ? null : last.Message!.Trim();
                    if (string.Equals(last.Status, "completed", StringComparison.OrdinalIgnoreCase))
                        found = await GrabbedSinceAsync(client.Value!, key.IsMovie, arrId, seasonNumber, episodeSet, ArrDates.Parse(last.Started), ct).ConfigureAwait(false);
                    return (last.Status?.ToLowerInvariant()) switch
                    {
                        "completed" => new ArrReadBack { Confirmed = true, Summary = "Search finished" + (message != null && !string.Equals(message, "Completed", StringComparison.OrdinalIgnoreCase) ? ": " + Cap(message) : ".") },
                        "failed" or "aborted" or "cancelled" => new ArrReadBack { Confirmed = true, Summary = "The search ended without finishing" + (message != null ? ": " + Cap(message) : ".") },
                        _ => new ArrReadBack { Confirmed = true, Summary = "Search started; it is still running." },
                    };
                },
            }, cancellationToken).ConfigureAwait(false);

            if (outcome.Status is ArrActionStatus.Succeeded or ArrActionStatus.Unknown)
            {
                // What the search found shows up in the queue and history; the drawer and pills follow the feed.
                _store.RequestRefresh(instance.Id, ArrSnapshotKind.Queue);
                _store.RequestRefresh(instance.Id, ArrSnapshotKind.History);
                // The title's own "last searched" time (the admin line) moves too.
                if (key.IsMovie) _ = _store.RefreshTitlesAsync(instance.Id, new[] { arrId }, CancellationToken.None);
                else _store.RequestEpisodesRefresh(instance.Id, arrId);
                if (key.IsMovie ? key.Provider == "tmdb" : key.Provider == "tvdb") _feed?.Bump(new[] { title.ToString() }, instance.Id);
            }
            return new ManageSearchResult { Outcome = outcome, Found = outcome.Status == ArrActionStatus.Succeeded ? found : null };
        }

        /// <summary>
        /// True when the arr's history of the movie (or of the series, narrowed to the season or
        /// episodes in scope) holds a grab since <paramref name="since"/> (the search command's start,
        /// as the arr reports it); false when it holds none; null when it can't be read or the start
        /// time is unknown.
        /// </summary>
        private static async Task<bool?> GrabbedSinceAsync(ArrClient client, bool movie, int arrId, int? season, IReadOnlyCollection<int>? episodeIds, DateTime? since, CancellationToken ct)
        {
            if (since is not DateTime start) return null;
            var query = new List<KeyValuePair<string, string?>>
            {
                new(movie ? "movieId" : "seriesId", arrId.ToString(CultureInfo.InvariantCulture)),
            };
            if (!movie && season is int s) query.Add(new("seasonNumber", s.ToString(CultureInfo.InvariantCulture)));
            var read = await client.GetAsync<List<ArrGrabWire>>(movie ? "history/movie" : "history/series", query, ArrCallClass.Read, ct).ConfigureAwait(false);
            if (!read.Ok || read.Value == null) return null;
            // The arrs write whole seconds: a grab in the command's first second counts.
            var from = start.AddSeconds(-1);
            return read.Value.Any(h => string.Equals(h.EventType, "grabbed", StringComparison.OrdinalIgnoreCase)
                && (episodeIds == null || (h.EpisodeId is int id && episodeIds.Contains(id)))
                && ArrDates.Parse(h.Date) is DateTime at && at >= from);
        }

        private static string Cap(string text) => text.Length > 200 ? text[..200] + "…" : text;

        /// <summary>The parts of an arr command resource Search now reads.</summary>
        internal sealed class ArrCommandWire
        {
            /// <summary>Command id.</summary>
            [JsonPropertyName("id")] public int Id { get; set; }

            /// <summary>queued, started, completed, failed, …</summary>
            [JsonPropertyName("status")] public string? Status { get; set; }

            /// <summary>The arr's message.</summary>
            [JsonPropertyName("message")] public string? Message { get; set; }

            /// <summary>When the command started (UTC, as the arr reports it).</summary>
            [JsonPropertyName("started")] public string? Started { get; set; }
        }

        /// <summary>The parts of an arr history record the search check reads.</summary>
        internal sealed class ArrGrabWire
        {
            /// <summary>grabbed, downloadFolderImported, …</summary>
            [JsonPropertyName("eventType")] public string? EventType { get; set; }

            /// <summary>When (UTC).</summary>
            [JsonPropertyName("date")] public string? Date { get; set; }

            /// <summary>Sonarr episode id.</summary>
            [JsonPropertyName("episodeId")] public int? EpisodeId { get; set; }
        }
    }
}
