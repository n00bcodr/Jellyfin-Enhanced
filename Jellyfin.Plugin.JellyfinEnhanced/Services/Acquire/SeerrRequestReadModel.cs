using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live;
using Microsoft.Extensions.Hosting;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire
{
    /// <summary>Seerr's request states (<c>MediaRequestStatus</c>).</summary>
    public static class SeerrRequestStatus
    {
        /// <summary>Waiting for an OK.</summary>
        public const int Pending = 1;

        /// <summary>OK'd.</summary>
        public const int Approved = 2;

        /// <summary>Declined.</summary>
        public const int Declined = 3;

        /// <summary>Sending it to Sonarr/Radarr failed.</summary>
        public const int Failed = 4;

        /// <summary>Done (the title is available).</summary>
        public const int Completed = 5;
    }

    /// <summary>One Seerr request as the read model keeps it (no URLs, no keys).</summary>
    public sealed class SeerrRequestRecord
    {
        /// <summary>Seerr's request id.</summary>
        public int Id { get; init; }

        /// <summary>A movie request (else a series).</summary>
        public bool IsMovie { get; init; }

        /// <summary>TMDB id.</summary>
        public int? TmdbId { get; init; }

        /// <summary>TVDB id (series).</summary>
        public int? TvdbId { get; init; }

        /// <summary>IMDb id.</summary>
        public string? ImdbId { get; init; }

        /// <summary>A 4K request.</summary>
        public bool Is4k { get; init; }

        /// <summary>Request state (<see cref="SeerrRequestStatus"/>).</summary>
        public int Status { get; init; }

        /// <summary>Seerr's media state for the requested variant (1 unknown … 5 available).</summary>
        public int? MediaStatus { get; init; }

        /// <summary>When it was asked for (UTC).</summary>
        public DateTime? CreatedAt { get; init; }

        /// <summary>When Seerr last changed it (UTC; for an OK'd request, about when it was OK'd).</summary>
        public DateTime? UpdatedAt { get; init; }

        /// <summary>The Jellyfin user who asked, when their Seerr account is linked to one.</summary>
        public Guid? RequestedBy { get; init; }

        /// <summary>Their Seerr display name (administrators only).</summary>
        public string? RequestedByName { get; init; }

        /// <summary>Who last answered it in Seerr (administrators only).</summary>
        public string? ModifiedByName { get; init; }

        /// <summary>Seasons asked for (series).</summary>
        public IReadOnlyList<int> Seasons { get; init; } = Array.Empty<int>();

        /// <summary>
        /// The Jellyfin item Seerr matched the variant asked for to (its media's jellyfinMediaId4k
        /// for a 4K request, jellyfinMediaId otherwise), when it names one. A hint only: used when
        /// it is a copy the viewer can open.
        /// </summary>
        public Guid? JellyfinItemId { get; init; }

        /// <summary>The title key (movie or series) the request is for, or null when it names no usable id.</summary>
        public TitleKey? Key => IsMovie
            ? TitleKey.ForMovie(TmdbId > 0 ? TmdbId.Value.ToString(CultureInfo.InvariantCulture) : null, ImdbId)
            : TitleKey.ForSeries(TvdbId > 0 ? TvdbId.Value.ToString(CultureInfo.InvariantCulture) : null, TmdbId > 0 ? TmdbId.Value.ToString(CultureInfo.InvariantCulture) : null, ImdbId);

        /// <summary>The key the change feed announces the title under (TMDB movie, TVDB series), or null.</summary>
        public string? FeedKey => IsMovie
            ? (TmdbId > 0 ? ArrTitleKey.Movie(TmdbId.Value) : null)
            : (TvdbId > 0 ? ArrTitleKey.Series(TvdbId.Value) : null);

        /// <summary>Still counts as wanted (not declined).</summary>
        public bool Active => Status != SeerrRequestStatus.Declined;

        internal string Signature => string.Join(
            "|",
            Status.ToString(CultureInfo.InvariantCulture),
            MediaStatus?.ToString(CultureInfo.InvariantCulture) ?? "-",
            UpdatedAt?.Ticks.ToString(CultureInfo.InvariantCulture) ?? "-",
            RequestedBy?.ToString("N") ?? "-",
            Key?.ToString() ?? "-",
            Is4k ? "4k" : "std",
            string.Join(",", Seasons),
            RequestedByName ?? string.Empty,
            ModifiedByName ?? string.Empty,
            JellyfinItemId?.ToString("N") ?? "-");
    }

    /// <summary>What Seerr (TMDB) says about a requested title, for the Requests page.</summary>
    public sealed class SeerrTitleMeta
    {
        /// <summary>Title.</summary>
        public string Title { get; init; } = string.Empty;

        /// <summary>Year of release or first airing.</summary>
        public int? Year { get; init; }

        /// <summary>TMDB poster path (<c>/abc.jpg</c>).</summary>
        public string? PosterPath { get; init; }

        /// <summary>TVDB id Seerr knows for a series (fills requests whose media lacks it).</summary>
        public int? TvdbId { get; init; }

        /// <summary>A movie's release date, or a series' next episode air date, as TMDB has it (UTC date).</summary>
        public DateTime? NextDate { get; init; }

        /// <summary>When these details were read.</summary>
        public DateTimeOffset ReadAt { get; init; }

        internal bool SameAs(SeerrTitleMeta? other)
            => other != null && other.Title == Title && other.Year == Year && other.PosterPath == PosterPath && other.TvdbId == TvdbId && other.NextDate == NextDate;
    }

    /// <summary>How the read model is doing (administrators only).</summary>
    public sealed class SeerrReadModelState
    {
        /// <summary>Seerr is configured and phase 1 is on.</summary>
        public bool Active { get; init; }

        /// <summary>The last successful read.</summary>
        public DateTimeOffset? LastReadAt { get; init; }

        /// <summary>The last failed read's error (admin wording), cleared by the next success.</summary>
        public string? LastError { get; init; }

        /// <summary>Requests held.</summary>
        public int Requests { get; init; }

        /// <summary>Calls made to Seerr since start (all in the background).</summary>
        public long Calls { get; init; }
    }

    /// <summary>
    /// Phase 1 "Seerr mode": a read model of Seerr's requests (who asked for what, pending / OK'd /
    /// declined, when), refreshed in the background and never on a request path. It answers the
    /// status composer's request facts (<see cref="IArrRequestFacts"/>), gives the Requests page each
    /// user's own requests, and announces changes on the change feed: the title keys of requests that
    /// changed and each affected user's request-list key (<see cref="ArrTitleKey.UserRequests"/>).
    /// Seerr stays the authority; nothing here writes to it. Refreshes every
    /// <see cref="PluginConfiguration.ArrSeerrRefreshMinutes"/> (every 30 s while someone has the
    /// Requests page open), and about a second after Jellyfin Enhanced itself sends Seerr a request
    /// change. A refresh first reads the 20 most recently changed requests and the total; the full
    /// list (paged, capped) is read only when those differ from the last full read or that read is
    /// over 30 minutes old.
    /// </summary>
    public sealed class SeerrRequestReadModel : IArrRequestFacts, IHostedService, IDisposable
    {
        /// <summary>Most requests read.</summary>
        public const int MaxRequests = 3000;

        /// <summary>Requests per page of the full read.</summary>
        public const int PageSize = 100;

        /// <summary>Most title details read per refresh.</summary>
        public const int MaxMetaPerRefresh = 25;

        private const int ProbeSize = 20;
        private const int MaxMeta = 5000;
        private static readonly TimeSpan WatchedInterval = TimeSpan.FromSeconds(30);
        private static readonly TimeSpan WatchedFor = TimeSpan.FromMinutes(2);
        private static readonly TimeSpan FullReadAtLeast = TimeSpan.FromMinutes(30);
        private static readonly TimeSpan RequestedDelay = TimeSpan.FromSeconds(1);
        private static readonly TimeSpan CallTimeout = TimeSpan.FromSeconds(15);
        private static readonly TimeSpan GoneFor = TimeSpan.FromMinutes(10);
        private const int MaxGone = 10_000;
        private static readonly TimeSpan FailureRetry = TimeSpan.FromSeconds(60);
        private static readonly TimeSpan MetaFreshFor = TimeSpan.FromHours(24);

        private readonly IHttpClientFactory _http;
        private readonly ArrChangeFeed? _feed;
        private readonly Logger? _logger;
        private readonly Func<PluginConfiguration?> _config;
        private readonly Func<DateTimeOffset> _now;
        private readonly object _lock = new();
        private readonly SemaphoreSlim _refreshGate = new(1, 1);
        private readonly Dictionary<(bool Movie, int Tmdb), SeerrTitleMeta> _meta = new();
        // Titles (and title + user) whose last request went away lately, until when they count.
        private readonly Dictionary<string, DateTimeOffset> _goneTitles = new(StringComparer.Ordinal);
        private readonly Dictionary<(string Key, Guid User), DateTimeOffset> _goneOwners = new();
        private volatile Snapshot _snapshot = Snapshot.Empty;
        private long _revision;
        private long _calls;
        private string? _probeSignature;
        private DateTimeOffset? _lastFullRead;
        private DateTimeOffset? _lastAttempt;
        private DateTimeOffset? _lastRead;
        private string? _lastError;
        private bool _lastAttemptFailed;
        private DateTimeOffset? _requestedAt;
        private DateTimeOffset? _watchedAt;
        private bool _wasActive;
        private CancellationTokenSource? _loop;

        /// <summary>The read model for a Jellyfin installation (DI).</summary>
        public SeerrRequestReadModel(IHttpClientFactory httpClientFactory, ArrChangeFeed feed, Logger logger)
            : this(httpClientFactory, feed, logger, null, null)
        {
        }

        /// <summary>A read model with explicit configuration and clock (tests).</summary>
        internal SeerrRequestReadModel(IHttpClientFactory httpClientFactory, ArrChangeFeed? feed, Logger? logger, Func<PluginConfiguration?>? config, Func<DateTimeOffset>? now)
        {
            _http = httpClientFactory;
            _feed = feed;
            _logger = logger;
            _config = config ?? (() => JellyfinEnhanced.Instance?.Configuration);
            _now = now ?? (() => DateTimeOffset.UtcNow);
        }

        /// <inheritdoc />
        public long Revision => Interlocked.Read(ref _revision);

        /// <summary>Phase 1 is on and Seerr is configured (URL and key).</summary>
        public bool Active => IsActive(_config());

        /// <summary>The read model's state for administrators.</summary>
        public SeerrReadModelState State
        {
            get
            {
                lock (_lock)
                {
                    return new SeerrReadModelState
                    {
                        Active = Active,
                        LastReadAt = _lastRead,
                        LastError = _lastError,
                        Requests = _snapshot.All.Count,
                        Calls = Interlocked.Read(ref _calls),
                    };
                }
            }
        }

        /// <summary>True once a read has succeeded since phase 1 (with Seerr) was last switched on.</summary>
        public bool Loaded
        {
            get
            {
                lock (_lock) return _lastRead != null;
            }
        }

        private static bool IsActive(PluginConfiguration? c)
            => c is { ArrIntegrationEnabled: true, ArrPhase1Enabled: true, JellyseerrEnabled: true }
               && !string.IsNullOrWhiteSpace(c.JellyseerrUrls)
               && !string.IsNullOrWhiteSpace(c.GetJellyseerrApiKey());

        /// <summary>Every request held, newest first.</summary>
        public IReadOnlyList<SeerrRequestRecord> All => _snapshot.All;

        /// <summary>The requests one Jellyfin user made (any state), newest first.</summary>
        public IReadOnlyList<SeerrRequestRecord> ForUser(Guid userId)
            => _snapshot.ByUser.TryGetValue(userId, out var list) ? list : Array.Empty<SeerrRequestRecord>();

        /// <summary>The requests for a title (movie or series key; a season or episode key counts as its title).</summary>
        public IReadOnlyList<SeerrRequestRecord> ForTitle(TitleKey titleKey)
            => _snapshot.ByKey.TryGetValue(titleKey.Title.ToString(), out var list) ? list : Array.Empty<SeerrRequestRecord>();

        /// <summary>Title details for a request's title, when read.</summary>
        public SeerrTitleMeta? Meta(bool isMovie, int? tmdbId)
        {
            if (tmdbId is not > 0) return null;
            lock (_lock) return _meta.TryGetValue((isMovie, tmdbId.Value), out var meta) ? meta : null;
        }

        /// <inheritdoc />
        public RequestFacts? For(TitleKey titleKey, StatusViewer viewer)
            => FactsOf(ForTitle(titleKey), viewer.UserId);

        /// <summary>The request facts of some requests (one title's, or the part of it one person asked for), as <paramref name="userId"/> sees them; null when there are none.</summary>
        internal static RequestFacts? FactsOf(IReadOnlyList<SeerrRequestRecord> requests, Guid userId)
        {
            if (requests.Count == 0) return null;
            var active = requests.Where(r => r.Active).ToList();
            var considered = active.Count > 0 ? active : requests.ToList();
            var asked = considered.Where(r => r.CreatedAt.HasValue).Select(r => r.CreatedAt).DefaultIfEmpty(null).Min();
            var approved = active.Where(r => r.Status is SeerrRequestStatus.Approved or SeerrRequestStatus.Completed or SeerrRequestStatus.Failed).ToList();
            DateTime? ApprovedOf(IReadOnlyList<SeerrRequestRecord> list)
                => list.Count > 0 ? list.Select(r => r.UpdatedAt ?? r.CreatedAt).Where(d => d.HasValue).DefaultIfEmpty(null).Min() ?? asked : null;
            // As the Overview's Needs attention judges a handoff: a variant with a completed request or
            // (partly) available media is done, whatever the arrs hold now.
            bool Done(bool fourK) => requests.Any(r => r.Is4k == fourK && (r.MediaStatus is 4 or 5 || r.Status == SeerrRequestStatus.Completed));
            return new RequestFacts
            {
                AskedAt = asked,
                AskedByViewer = considered.Any(r => r.RequestedBy == userId),
                Pending = active.Count > 0 && active.All(r => r.Status == SeerrRequestStatus.Pending),
                ApprovedAt = ApprovedOf(approved),
                ApprovedStandardAt = ApprovedOf(approved.Where(r => !r.Is4k).ToList()),
                Approved4kAt = ApprovedOf(approved.Where(r => r.Is4k).ToList()),
                StandardDone = Done(false),
                FourKDone = Done(true),
                Declined = active.Count == 0,
            };
        }

        /// <inheritdoc />
        public bool AskedBy(TitleKey titleKey, Guid userId)
            => ForTitle(titleKey).Any(r => r.RequestedBy == userId);

        /// <inheritdoc />
        public bool Requested(TitleKey titleKey) => ForTitle(titleKey).Count > 0;

        /// <inheritdoc />
        public bool AskedLatelyBy(TitleKey titleKey, Guid userId)
        {
            if (AskedBy(titleKey, userId)) return true;
            lock (_lock) return _goneOwners.TryGetValue((titleKey.Title.ToString(), userId), out var until) && _now() < until;
        }

        /// <inheritdoc />
        public bool RequestedLately(TitleKey titleKey)
        {
            if (Requested(titleKey)) return true;
            lock (_lock) return _goneTitles.TryGetValue(titleKey.Title.ToString(), out var until) && _now() < until;
        }

        /// <summary>
        /// Remembers, before <paramref name="after"/> replaces <paramref name="before"/>, the titles
        /// whose last request goes away and the users whose last request for a title does, so the
        /// change feed's audience still lets those announcements through (caller holds the lock).
        /// </summary>
        private void RememberGone(Snapshot before, Snapshot after)
        {
            var now = _now();
            var until = now + GoneFor;
            foreach (var (key, list) in before.ByKey)
            {
                after.ByKey.TryGetValue(key, out var still);
                if (still == null || still.Count == 0) _goneTitles[key] = until;
                foreach (var user in list.Where(r => r.RequestedBy.HasValue).Select(r => r.RequestedBy!.Value).Distinct())
                {
                    if (still == null || !still.Any(r => r.RequestedBy == user)) _goneOwners[(key, user)] = until;
                }
            }
            if (_goneTitles.Count > MaxGone || _goneOwners.Count > MaxGone)
            {
                foreach (var key in _goneTitles.Where(x => x.Value <= now).Select(x => x.Key).ToList()) _goneTitles.Remove(key);
                foreach (var key in _goneOwners.Where(x => x.Value <= now).Select(x => x.Key).ToList()) _goneOwners.Remove(key);
                if (_goneTitles.Count > MaxGone) _goneTitles.Clear();
                if (_goneOwners.Count > MaxGone) _goneOwners.Clear();
            }
        }

        /// <summary>
        /// Asks for a refresh about a second from now (Jellyfin Enhanced just sent Seerr a request
        /// change). Calls in a burst make one refresh.
        /// </summary>
        public void RequestRefresh()
        {
            lock (_lock) _requestedAt ??= _now();
        }

        /// <summary>
        /// Someone is looking at the Requests page: refresh every 30 s for the next two minutes. The
        /// page renews it with every change-feed poll while it stays open.
        /// </summary>
        public void Touch()
        {
            lock (_lock) _watchedAt = _now();
        }

        /// <summary>When the Requests page was last seen open (tests).</summary>
        internal DateTimeOffset? WatchedAt
        {
            get
            {
                lock (_lock) return _watchedAt;
            }
        }

        /// <inheritdoc />
        public Task StartAsync(CancellationToken cancellationToken)
        {
            _loop = new CancellationTokenSource();
            var token = _loop.Token;
            _ = Task.Run(() => LoopAsync(token), CancellationToken.None);
            return Task.CompletedTask;
        }

        /// <inheritdoc />
        public Task StopAsync(CancellationToken cancellationToken)
        {
            _loop?.Cancel();
            return Task.CompletedTask;
        }

        /// <inheritdoc />
        /// <remarks>
        /// Safe to call more than once: the service is registered three times (itself, the hosted
        /// service and <see cref="IArrRequestFacts"/>), so the container disposes it once per registration.
        /// </remarks>
        public void Dispose()
        {
            var loop = Interlocked.Exchange(ref _loop, null);
            if (loop != null)
            {
                try
                {
                    loop.Cancel();
                }
                catch (ObjectDisposedException)
                {
                }
                loop.Dispose();
            }
            _refreshGate.Dispose();
        }

        private async Task LoopAsync(CancellationToken token)
        {
            while (!token.IsCancellationRequested)
            {
                try
                {
                    await Task.Delay(TimeSpan.FromSeconds(1), token).ConfigureAwait(false);
                    if (Due()) await RefreshAsync(token).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (token.IsCancellationRequested)
                {
                    return;
                }
                catch (Exception ex)
                {
                    _logger?.Warning($"[Requests] Seerr request read failed: {ex.GetType().Name}");
                }
            }
        }

        /// <summary>True when a refresh is due now (tests call it to step the loop).</summary>
        internal bool Due()
        {
            var config = _config();
            var now = _now();
            if (!IsActive(config))
            {
                if (_wasActive) Clear();
                return false;
            }
            lock (_lock)
            {
                if (!_wasActive || _lastAttempt == null) return true;
                if (_requestedAt is { } asked && now - asked >= RequestedDelay) return true;
                var minutes = Math.Clamp(config!.ArrSeerrRefreshMinutes, 1, 60);
                var interval = _watchedAt is { } w && now - w < WatchedFor ? WatchedInterval : TimeSpan.FromMinutes(minutes);
                if (_lastAttemptFailed && interval > FailureRetry) interval = FailureRetry;
                return now - _lastAttempt.Value >= interval;
            }
        }

        /// <summary>
        /// The first successful read, a failure and the recovery from it change what every Requests
        /// page shows (loading / "couldn't be updated"), whoever's requests changed: announced under
        /// the shared <see cref="ArrTitleKey.RequestsState"/> key every Requests page follows.
        /// </summary>
        private void AnnounceState(bool loadedBefore, bool failedBefore, bool loaded, bool failed)
        {
            if (loadedBefore != loaded || failedBefore != failed) _feed?.Bump(new[] { ArrTitleKey.RequestsState });
        }

        // Phase 1 or Seerr switched off: forget everything (the facts stop at once).
        private void Clear()
        {
            Snapshot old;
            bool loadedBefore, failedBefore;
            lock (_lock)
            {
                loadedBefore = _lastRead != null;
                failedBefore = _lastError != null;
                _wasActive = false;
                old = _snapshot;
                RememberGone(old, Snapshot.Empty);
                _snapshot = Snapshot.Empty;
                _probeSignature = null;
                _lastFullRead = null;
                _lastAttempt = null;
                _lastRead = null;
                _lastError = null;
                _requestedAt = null;
            }
            if (old.All.Count > 0)
            {
                Interlocked.Increment(ref _revision);
                Announce(old, Snapshot.Empty, Array.Empty<(bool, int)>());
            }
            AnnounceState(loadedBefore, failedBefore, loaded: false, failed: false);
        }

        /// <summary>
        /// Reads Seerr now: the most recently changed requests, then (when they or the total differ,
        /// or the last full read is old) every request, then details of titles not seen before.
        /// Announces what changed. Returns false when Seerr could not be read (the last good list stays).
        /// </summary>
        public async Task<bool> RefreshAsync(CancellationToken cancellationToken)
        {
            var config = _config();
            if (!IsActive(config)) return false;
            await _refreshGate.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                var now = _now();
                bool loadedBefore, failedBefore;
                lock (_lock)
                {
                    _wasActive = true;
                    _lastAttempt = now;
                    _requestedAt = null;
                    loadedBefore = _lastRead != null;
                    failedBefore = _lastError != null;
                }
                var urls = config!.JellyseerrUrls.Split(new[] { '\r', '\n', ',' }, StringSplitOptions.RemoveEmptyEntries)
                    .Select(u => u.Trim().TrimEnd('/'))
                    .Where(u => u.Length > 0)
                    .ToList();
                var key = config.GetJellyseerrApiKey();
                string? lastError = null;
                foreach (var url in urls)
                {
                    var (ok, error) = await ReadFromAsync(url, key, cancellationToken).ConfigureAwait(false);
                    if (ok)
                    {
                        lock (_lock)
                        {
                            _lastRead = _now();
                            _lastError = null;
                            _lastAttemptFailed = false;
                        }
                        AnnounceState(loadedBefore, failedBefore, loaded: true, failed: false);
                        return true;
                    }
                    lastError = error;
                }
                lock (_lock)
                {
                    _lastError = lastError ?? "No Seerr address is configured.";
                    _lastAttemptFailed = true;
                }
                AnnounceState(loadedBefore, failedBefore, loaded: loadedBefore, failed: true);
                _logger?.Warning($"[Requests] Could not read Seerr's requests: {lastError}");
                return false;
            }
            finally
            {
                _refreshGate.Release();
            }
        }

        private async Task<(bool Ok, string? Error)> ReadFromAsync(string url, string apiKey, CancellationToken ct)
        {
            var probe = await GetJsonAsync($"{url}/api/v1/request?take={ProbeSize}&skip=0&sort=modified&filter=all", apiKey, ct).ConfigureAwait(false);
            if (probe.Error != null) return (false, probe.Error);
            var probeSignature = ProbeSignature(probe.Json!.Value);
            List<SeerrRequestRecord>? records = null;
            bool full;
            lock (_lock)
            {
                full = probeSignature != _probeSignature || _lastFullRead == null || _now() - _lastFullRead.Value >= FullReadAtLeast;
            }
            if (full)
            {
                records = new List<SeerrRequestRecord>();
                for (var skip = 0; skip < MaxRequests; skip += PageSize)
                {
                    var page = await GetJsonAsync($"{url}/api/v1/request?take={PageSize}&skip={skip}&sort=added&filter=all", apiKey, ct).ConfigureAwait(false);
                    if (page.Error != null) return (false, page.Error);
                    var results = page.Json!.Value.TryGetProperty("results", out var r) && r.ValueKind == JsonValueKind.Array ? r : default;
                    var count = 0;
                    if (results.ValueKind == JsonValueKind.Array)
                    {
                        foreach (var item in results.EnumerateArray())
                        {
                            count++;
                            if (Parse(item) is { } record) records.Add(record);
                        }
                    }
                    if (count < PageSize || records.Count >= MaxRequests) break;
                }
            }

            var metaChanged = new List<(bool, int)>();
            var current = records ?? _snapshot.All.ToList();
            await ReadMetaAsync(url, apiKey, current, metaChanged, ct).ConfigureAwait(false);
            if (records == null && metaChanged.Count == 0) return (true, null);

            var next = Snapshot.Build(current.Select(WithMetaIds));
            Snapshot old;
            lock (_lock)
            {
                old = _snapshot;
                RememberGone(old, next);
                _snapshot = next;
                if (full)
                {
                    _probeSignature = probeSignature;
                    _lastFullRead = _now();
                }
            }
            if (Announce(old, next, metaChanged) || old.All.Count != next.All.Count) Interlocked.Increment(ref _revision);
            return (true, null);
        }

        // A series request whose media lacks a TVDB id gets the one Seerr's details name.
        private SeerrRequestRecord WithMetaIds(SeerrRequestRecord record)
        {
            if (record.IsMovie || record.TvdbId is > 0 || Meta(false, record.TmdbId) is not { TvdbId: > 0 } meta) return record;
            return new SeerrRequestRecord
            {
                Id = record.Id, IsMovie = false, TmdbId = record.TmdbId, TvdbId = meta.TvdbId, ImdbId = record.ImdbId, Is4k = record.Is4k,
                Status = record.Status, MediaStatus = record.MediaStatus, CreatedAt = record.CreatedAt, UpdatedAt = record.UpdatedAt,
                RequestedBy = record.RequestedBy, RequestedByName = record.RequestedByName, ModifiedByName = record.ModifiedByName, Seasons = record.Seasons,
                JellyfinItemId = record.JellyfinItemId,
            };
        }

        private async Task ReadMetaAsync(string url, string apiKey, IReadOnlyList<SeerrRequestRecord> records, List<(bool, int)> changed, CancellationToken ct)
        {
            var wanted = records.Where(r => r.TmdbId > 0).Select(r => (r.IsMovie, r.TmdbId!.Value)).Distinct().ToList();
            List<(bool Movie, int Tmdb)> due;
            var now = _now();
            lock (_lock)
            {
                // Titles never read first, then details older than a day (dates move).
                due = wanted.Where(w => !_meta.ContainsKey(w))
                    .Concat(wanted.Where(w => _meta.TryGetValue(w, out var m) && now - m.ReadAt >= MetaFreshFor))
                    .Take(MaxMetaPerRefresh)
                    .ToList();
            }
            foreach (var (movie, tmdb) in due)
            {
                var read = await GetJsonAsync($"{url}/api/v1/{(movie ? "movie" : "tv")}/{tmdb.ToString(CultureInfo.InvariantCulture)}", apiKey, ct).ConfigureAwait(false);
                // A title Seerr can't describe (removed from TMDB) is remembered as unnamed, not asked for again today.
                var meta = read.Json is { } json ? ParseMeta(json, movie, now) : (read.NotFound ? new SeerrTitleMeta { ReadAt = now } : null);
                if (meta == null) continue;
                SeerrTitleMeta? before;
                lock (_lock)
                {
                    if (_meta.Count >= MaxMeta) _meta.Clear();
                    _meta.TryGetValue((movie, tmdb), out before);
                    _meta[(movie, tmdb)] = meta;
                }
                // Nothing known before counts as "no details" (a title Seerr can't describe changes nothing shown).
                if (!meta.SameAs(before ?? new SeerrTitleMeta())) changed.Add((movie, tmdb));
            }
        }

        private static SeerrTitleMeta ParseMeta(JsonElement json, bool movie, DateTimeOffset now)
        {
            var title = Str(json, movie ? "title" : "name") ?? Str(json, "originalTitle") ?? Str(json, "originalName") ?? string.Empty;
            var date = Str(json, movie ? "releaseDate" : "firstAirDate");
            int? year = date is { Length: >= 4 } && int.TryParse(date.AsSpan(0, 4), NumberStyles.None, CultureInfo.InvariantCulture, out var y) ? y : null;
            int? tvdb = null;
            if (!movie && json.TryGetProperty("externalIds", out var ids) && ids.ValueKind == JsonValueKind.Object) tvdb = Int(ids, "tvdbId");
            var poster = Str(json, "posterPath");
            var next = movie
                ? Date(json, "releaseDate")
                : json.TryGetProperty("nextEpisodeToAir", out var episode) && episode.ValueKind == JsonValueKind.Object ? Date(episode, "airDate") : null;
            return new SeerrTitleMeta
            {
                ReadAt = now,
                NextDate = next,
                Title = title.Length > 300 ? title[..300] : title,
                Year = year,
                PosterPath = poster is { Length: > 1 and < 200 } && poster[0] == '/' && !poster.Contains("..", StringComparison.Ordinal) ? poster : null,
                TvdbId = tvdb > 0 ? tvdb : null,
            };
        }

        private async Task<(JsonElement? Json, string? Error, bool NotFound)> GetJsonAsync(string uri, string apiKey, CancellationToken ct)
        {
            Interlocked.Increment(ref _calls);
            try
            {
                using var budget = CancellationTokenSource.CreateLinkedTokenSource(ct);
                budget.CancelAfter(CallTimeout);
                var client = SeerrHttpHelper.CreateClient(_http);
                using var request = SeerrHttpHelper.BuildRequest(HttpMethod.Get, uri, apiKey);
                using var response = await client.SendAsync(request, budget.Token).ConfigureAwait(false);
                var (body, error) = await SeerrHttpHelper.ReadResponseAsync(response, uri, budget.Token).ConfigureAwait(false);
                if (error != null) return (null, error.Message, error.HttpStatus == 404);
                using var doc = JsonDocument.Parse(body!);
                return (doc.RootElement.Clone(), null, false);
            }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                return (null, "Seerr did not answer in time.", false);
            }
            catch (JsonException)
            {
                return (null, "Seerr's answer could not be read.", false);
            }
            catch (HttpRequestException ex)
            {
                return (null, "Seerr could not be reached: " + ex.Message, false);
            }
        }

        private static string ProbeSignature(JsonElement probe)
        {
            var total = probe.TryGetProperty("pageInfo", out var info) && info.ValueKind == JsonValueKind.Object ? Int(info, "results") ?? -1 : -1;
            var parts = new List<string> { total.ToString(CultureInfo.InvariantCulture) };
            if (probe.TryGetProperty("results", out var results) && results.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in results.EnumerateArray())
                {
                    var media = item.TryGetProperty("media", out var m) && m.ValueKind == JsonValueKind.Object ? m : default;
                    parts.Add(string.Join(
                        ":",
                        Int(item, "id")?.ToString(CultureInfo.InvariantCulture) ?? "-",
                        Int(item, "status")?.ToString(CultureInfo.InvariantCulture) ?? "-",
                        Str(item, "updatedAt") ?? "-",
                        media.ValueKind == JsonValueKind.Object
                            ? (Int(media, "status")?.ToString(CultureInfo.InvariantCulture) ?? "-") + "/" + (Int(media, "status4k")?.ToString(CultureInfo.InvariantCulture) ?? "-")
                                + "/" + (Str(media, "jellyfinMediaId") ?? "-") + "/" + (Str(media, "jellyfinMediaId4k") ?? "-")
                            : "-"));
                }
            }
            return string.Join(",", parts);
        }

        /// <summary>One request from Seerr's JSON, or null when it is not a movie/series request with an id.</summary>
        internal static SeerrRequestRecord? Parse(JsonElement item)
        {
            if (item.ValueKind != JsonValueKind.Object || Int(item, "id") is not int id) return null;
            var type = Str(item, "type");
            if (type is not ("movie" or "tv")) return null;
            var media = item.TryGetProperty("media", out var m) && m.ValueKind == JsonValueKind.Object ? m : default;
            if (media.ValueKind != JsonValueKind.Object) return null;
            var is4k = item.TryGetProperty("is4k", out var k) && k.ValueKind == JsonValueKind.True;
            var seasons = new List<int>();
            if (item.TryGetProperty("seasons", out var s) && s.ValueKind == JsonValueKind.Array)
            {
                foreach (var season in s.EnumerateArray())
                {
                    if (season.ValueKind == JsonValueKind.Object && Int(season, "seasonNumber") is int n && n >= 0 && seasons.Count < 200) seasons.Add(n);
                }
            }
            var record = new SeerrRequestRecord
            {
                Id = id,
                IsMovie = type == "movie",
                TmdbId = Int(media, "tmdbId"),
                TvdbId = Int(media, "tvdbId"),
                ImdbId = Str(media, "imdbId") is { } imdb && System.Text.RegularExpressions.Regex.IsMatch(imdb, "^tt[0-9]{1,10}$", System.Text.RegularExpressions.RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(50)) ? imdb : null,
                Is4k = is4k,
                Status = Int(item, "status") ?? 0,
                MediaStatus = Int(media, is4k ? "status4k" : "status"),
                CreatedAt = Date(item, "createdAt"),
                UpdatedAt = Date(item, "updatedAt"),
                RequestedBy = UserOf(item, "requestedBy"),
                RequestedByName = NameOf(item, "requestedBy"),
                ModifiedByName = NameOf(item, "modifiedBy"),
                Seasons = seasons.Distinct().OrderBy(n => n).ToList(),
                JellyfinItemId = Str(media, is4k ? "jellyfinMediaId4k" : "jellyfinMediaId") is { } jellyfinId && Guid.TryParse(jellyfinId, out var itemId) && itemId != Guid.Empty ? itemId : null,
            };
            return record.Key == null ? null : record;
        }

        private static Guid? UserOf(JsonElement item, string property)
            => item.TryGetProperty(property, out var user) && user.ValueKind == JsonValueKind.Object && Str(user, "jellyfinUserId") is { } raw && Guid.TryParse(raw, out var id) && id != Guid.Empty ? id : null;

        private static string? NameOf(JsonElement item, string property)
        {
            if (!item.TryGetProperty(property, out var user) || user.ValueKind != JsonValueKind.Object) return null;
            var name = Str(user, "displayName") ?? Str(user, "jellyfinUsername") ?? Str(user, "username");
            return name is { Length: > 0 } ? (name.Length > 80 ? name[..80] : name) : null;
        }

        private static string? Str(JsonElement e, string name)
            => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

        private static int? Int(JsonElement e, string name)
            => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var n) ? n : null;

        private static DateTime? Date(JsonElement e, string name)
            => Str(e, name) is { } raw && DateTimeOffset.TryParse(raw, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var d) ? d.UtcDateTime : null;

        /// <summary>
        /// Announces what changed between two snapshots on the change feed: the title keys of added,
        /// removed or changed requests (and of requests whose title details arrived), and the
        /// request-list key of every user whose list changed. A change too wide to list resets every
        /// client. Returns true when anything changed.
        /// </summary>
        private bool Announce(Snapshot before, Snapshot after, IReadOnlyCollection<(bool Movie, int Tmdb)> metaChanged)
        {
            var titles = new HashSet<string>(StringComparer.Ordinal);
            var users = new HashSet<Guid>();
            void Note(SeerrRequestRecord r)
            {
                if (r.FeedKey is { } feedKey) titles.Add(feedKey);
                if (r.RequestedBy is Guid u) users.Add(u);
            }
            foreach (var (id, record) in after.ById)
            {
                if (!before.ById.TryGetValue(id, out var old))
                {
                    Note(record);
                }
                else if (old.Signature != record.Signature)
                {
                    Note(old);
                    Note(record);
                }
            }
            foreach (var (id, record) in before.ById)
            {
                if (!after.ById.ContainsKey(id)) Note(record);
            }
            if (metaChanged.Count > 0)
            {
                var set = metaChanged.ToHashSet();
                foreach (var record in after.All.Where(r => r.TmdbId > 0 && set.Contains((r.IsMovie, r.TmdbId!.Value)))) Note(record);
            }
            if (titles.Count == 0 && users.Count == 0) return false;
            if (_feed != null)
            {
                var keys = titles.Concat(users.Select(ArrTitleKey.UserRequests)).ToList();
                if (keys.Count > ArrChangeFeed.MaxKeysPerRead) _feed.ResetAll();
                else _feed.Bump(keys);
            }
            return true;
        }

        private sealed class Snapshot
        {
            public static readonly Snapshot Empty = Build(Array.Empty<SeerrRequestRecord>());

            public IReadOnlyList<SeerrRequestRecord> All { get; private init; } = Array.Empty<SeerrRequestRecord>();

            public Dictionary<int, SeerrRequestRecord> ById { get; } = new();

            public Dictionary<string, List<SeerrRequestRecord>> ByKey { get; } = new(StringComparer.Ordinal);

            public Dictionary<Guid, List<SeerrRequestRecord>> ByUser { get; } = new();

            public static Snapshot Build(IEnumerable<SeerrRequestRecord> records)
            {
                var all = records.GroupBy(r => r.Id).Select(g => g.First())
                    .OrderByDescending(r => r.CreatedAt ?? DateTime.MinValue).ThenByDescending(r => r.Id).ToList();
                var snapshot = new Snapshot { All = all };
                foreach (var r in all)
                {
                    snapshot.ById[r.Id] = r;
                    foreach (var key in KeysOf(r))
                    {
                        if (!snapshot.ByKey.TryGetValue(key, out var list)) snapshot.ByKey[key] = list = new List<SeerrRequestRecord>();
                        list.Add(r);
                    }
                    if (r.RequestedBy is Guid user)
                    {
                        if (!snapshot.ByUser.TryGetValue(user, out var mine)) snapshot.ByUser[user] = mine = new List<SeerrRequestRecord>();
                        mine.Add(r);
                    }
                }
                return snapshot;
            }

            // Every key the title may be asked about by: TMDB/IMDb for a movie, TVDB/TMDB/IMDb for a series.
            private static IEnumerable<string> KeysOf(SeerrRequestRecord r)
            {
                var keys = new HashSet<string>(StringComparer.Ordinal);
                string? Num(int? n) => n > 0 ? n.Value.ToString(CultureInfo.InvariantCulture) : null;
                if (r.IsMovie)
                {
                    if (TitleKey.ForMovie(Num(r.TmdbId), null) is { } tmdb) keys.Add(tmdb.ToString());
                    if (TitleKey.ForMovie(null, r.ImdbId) is { } imdb) keys.Add(imdb.ToString());
                }
                else
                {
                    if (TitleKey.ForSeries(Num(r.TvdbId), null, null) is { } tvdb) keys.Add(tvdb.ToString());
                    if (TitleKey.ForSeries(null, Num(r.TmdbId), null) is { } tmdb) keys.Add(tmdb.ToString());
                    if (TitleKey.ForSeries(null, null, r.ImdbId) is { } imdb) keys.Add(imdb.ToString());
                }
                return keys;
            }
        }
    }
}
