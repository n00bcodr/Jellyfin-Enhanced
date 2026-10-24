using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Backends;
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
            string.Join(",", TitleAliases.FromRequest(this)),
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

        /// <summary>
        /// Seerr holds more requests than are read (<see cref="SeerrRequestReadModel.MaxRequests"/>):
        /// the newest are read, older ones keep what was last known of them.
        /// </summary>
        public bool Truncated { get; init; }

        /// <summary>How many requests Seerr said it holds at the last complete read.</summary>
        public int? ReportedTotal { get; init; }

        /// <summary>Most requests read (<see cref="SeerrRequestReadModel.MaxRequests"/>).</summary>
        public int ReadLimit { get; init; } = SeerrFacts.MaxRequests;

        /// <summary>
        /// Why the latest full read was not used (Seerr's list changed while it was read, a page came
        /// back short), or null; the list held is the last complete one.
        /// </summary>
        public string? IncompleteReason { get; init; }
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
    /// over 30 minutes old. A full read is used only when it is complete: Seerr's count stays the
    /// same on every page, the ids come newest first with no repeats, and as many arrive as Seerr
    /// says it holds (up to the cap). A read that isn't (requests added or removed while the pages
    /// were read) changes nothing (no request is taken as gone because of it) and is tried again; only
    /// several in a row show as a problem. The list carries the identity of the Seerr it came from
    /// (<see cref="Source"/>): pointing Jellyfin Enhanced at another Seerr forgets the old list at
    /// once, so another server's request ids are never taken for the old one's.
    /// </summary>
    public sealed partial class SeerrFacts
    {
    private sealed class SeerrRequestReadModel : IArrRequestFacts, IHostedService, IDisposable
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
        private const int IncompleteBeforeError = 3;
        // Every page that doesn't end the read adds at least one new (lower) id, so a read can't
        // take more pages than requests read plus the empty last one, whatever rows a page holds.
        private const int MaxPages = MaxRequests + 1;

        /// <summary>
        /// Most older requests (below the newest <see cref="MaxRequests"/> read) kept from earlier
        /// reads while Seerr holds more than is read. Those beyond it are no longer known: not gone.
        /// </summary>
        internal const int MaxHeldBelowWindow = 3 * MaxRequests;

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
        private int _incompleteRuns;
        private string? _incompleteReason;
        private bool _truncated;
        private int? _reportedTotal;
        // The Seerr the held list came from (null before a read), and the last identity worked out.
        private string? _source;
        private volatile SourceCache? _sourceCache;
        private readonly EffectiveRequestsBackend _backend;
        internal long? FactsEpoch { get; private set; }
        private CancellationTokenSource? _loop;
        private Task? _loopTask;
        private readonly Requests.RequestOutboxEvents? _outboxEvents;

        /// <summary>
        /// The read model for a Jellyfin installation (DI). A request Jellyfin Enhanced sent Seerr (confirmed by the
        /// request outbox) asks for a refresh, so Seerr's own record of it is read about a second later.
        /// </summary>
        public SeerrRequestReadModel(IHttpClientFactory httpClientFactory, ArrChangeFeed feed, Logger logger, Requests.RequestOutboxEvents outboxEvents)
            : this(httpClientFactory, feed, logger, null, null, outboxEvents)
        {
        }

        /// <summary>A read model with explicit configuration and clock (tests).</summary>
        internal SeerrRequestReadModel(IHttpClientFactory httpClientFactory, ArrChangeFeed? feed, Logger? logger, Func<PluginConfiguration?>? config, Func<DateTimeOffset>? now, Requests.RequestOutboxEvents? outboxEvents = null, EffectiveRequestsBackend? owner = null)
        {
            _http = httpClientFactory;
            _feed = feed;
            _logger = logger;
            _config = config ?? (() => JellyfinEnhanced.Instance?.Configuration);
            _backend = owner ?? (config == null ? EffectiveRequestsBackend.Shared : new EffectiveRequestsBackend(_config));
            _now = now ?? (() => DateTimeOffset.UtcNow);
            _outboxEvents = outboxEvents;
            if (_outboxEvents != null) _outboxEvents.Confirmed += OnRequestConfirmed;
        }

        // Seerr mode: Jellyfin Enhanced's own send to Seerr was confirmed; read Seerr's record of it soon.
        private void OnRequestConfirmed(Requests.RequestJob job)
        {
            if (job.Authorization.Backend == "seerr") RequestRefresh();
        }

        /// <inheritdoc />
        public long Revision => Interlocked.Read(ref _revision);

        /// <summary>Most older requests kept below the newest read (<see cref="MaxHeldBelowWindow"/>; tests lower it).</summary>
        internal int HeldBelowWindow { get; set; } = MaxHeldBelowWindow;

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
                        LastReadAt = EffectiveRequestsBackend.AllowsSeerr(_config()) ? _lastRead : null,
                        LastError = EffectiveRequestsBackend.AllowsSeerr(_config()) ? _lastError : null,
                        Requests = EffectiveRequestsBackend.AllowsSeerr(_config()) ? _snapshot.All.Count : 0,
                        Calls = Interlocked.Read(ref _calls),
                        Truncated = _truncated,
                        ReportedTotal = _reportedTotal,
                        IncompleteReason = _incompleteReason,
                    };
                }
            }
        }

        /// <summary>True once a read has succeeded since phase 1 (with Seerr) was last switched on.</summary>
        public bool Loaded
        {
            get
            {
                lock (_lock) return EffectiveRequestsBackend.AllowsSeerr(_config()) && _lastRead != null;
            }
        }

        /// <summary>True when the configuration has the read model reading Seerr (the integration, phase 1 and Seerr on).</summary>
        public static bool IsActive(PluginConfiguration? c)
            => IsActive(c, c != null && !string.IsNullOrWhiteSpace(c.GetJellyseerrApiKey()));

        /// <summary>
        /// <see cref="IsActive(PluginConfiguration?)"/> with whether an API key is stored already read (the key's read
        /// can wait for the secrets store and its file: the automatic-write gate reads it before its decision).
        /// </summary>
        public static bool IsActive(PluginConfiguration? c, bool hasApiKey)
            => EffectiveRequestsBackend.AllowsSeerr(c) && c is { ArrIntegrationEnabled: true, ArrPhase1Enabled: true, JellyseerrEnabled: true }
               && !string.IsNullOrWhiteSpace(c.JellyseerrUrls)
               && hasApiKey;

        /// <summary>The identity of the Seerr the current configuration points at (<see cref="SourceOf"/>), or null.</summary>
        internal string? CurrentSource => SourceOf(_config());

        /// <summary>Every request held, newest first.</summary>
        public IReadOnlyList<SeerrRequestRecord> All => _backend.ReadSeerrCached(() => _snapshot.All, Array.Empty<SeerrRequestRecord>());

        /// <summary>
        /// The identity of the Seerr the held requests came from (a short keyed hash of its addresses
        /// and API key; never the key), or null before the first read. Request ids mean something
        /// only together with it.
        /// </summary>
        public string? Source => _backend.ReadSeerrCached(() => _snapshot.Source, (string?)null);

        /// <summary>
        /// The held requests together with the identity of the Seerr they came from and the lowest
        /// request id they cover (one snapshot). <c>Floor</c> is null when every request Seerr holds is
        /// known; otherwise (Seerr holds more than is read) a request with a lower id that isn't held
        /// is not known, which says nothing about whether it still exists.
        /// </summary>
        public (string? Source, IReadOnlyList<SeerrRequestRecord> All, int? Floor) Current
        {
            get
            {
                return _backend.ReadSeerrCached(() =>
                {
                    var snapshot = _snapshot;
                    return (snapshot.Source, snapshot.All, snapshot.Floor);
                }, ((string?)null, (IReadOnlyList<SeerrRequestRecord>)Array.Empty<SeerrRequestRecord>(), (int?)null));
            }
        }

        /// <summary>
        /// The identity of the Seerr a configuration points at: a keyed hash (HMAC-SHA-256 with the
        /// API key) of its addresses, normalised, sorted and without repeats, so listing them in
        /// another order or failing over between them is the same Seerr, while another address or
        /// another key is another one. Null while Seerr isn't configured.
        /// </summary>
        internal string? SourceOf(PluginConfiguration? config)
        {
            if (!IsActive(config)) return null;
            var urls = Urls(config!).Select(NormaliseUrl).Distinct(StringComparer.Ordinal).OrderBy(u => u, StringComparer.Ordinal).ToList();
            var key = config!.GetJellyseerrApiKey();
            var input = string.Join("\n", urls) + "\n" + key;
            var cached = _sourceCache;
            if (cached != null && cached.Input == input) return cached.Id;
            using var hmac = new System.Security.Cryptography.HMACSHA256(System.Text.Encoding.UTF8.GetBytes(key));
            var id = Convert.ToHexString(hmac.ComputeHash(System.Text.Encoding.UTF8.GetBytes(string.Join("\n", urls))), 0, 8).ToLowerInvariant();
            _sourceCache = new SourceCache(input, id);
            return id;
        }

        // The last identity worked out and what it was worked out from (one reference, read and replaced whole).
        private sealed record SourceCache(string Input, string Id);

        private static List<string> Urls(PluginConfiguration config)
            => config.JellyseerrUrls.Split(new[] { '\r', '\n', ',' }, StringSplitOptions.RemoveEmptyEntries)
                .Select(u => u.Trim().TrimEnd('/'))
                .Where(u => u.Length > 0)
                .ToList();

        // One address as an identity: scheme and host in lower case, no default port, no trailing slash.
        private static string NormaliseUrl(string url)
            => Uri.TryCreate(url, UriKind.Absolute, out var uri) ? uri.GetLeftPart(UriPartial.Path).TrimEnd('/') : url;

        /// <summary>The requests one Jellyfin user made (any state), newest first.</summary>
        public IReadOnlyList<SeerrRequestRecord> ForUser(Guid userId)
            => _backend.ReadSeerrCached(() => _snapshot.ByUser.TryGetValue(userId, out var list) ? list : Array.Empty<SeerrRequestRecord>(), (IReadOnlyList<SeerrRequestRecord>)Array.Empty<SeerrRequestRecord>());

        /// <summary>The requests for a title (movie or series key; a season or episode key counts as its title).</summary>
        public IReadOnlyList<SeerrRequestRecord> ForTitle(TitleKey titleKey)
            => _backend.ReadSeerrCached(() => _snapshot.ByKey.TryGetValue(titleKey.Title.ToString(), out var list) ? list : Array.Empty<SeerrRequestRecord>(), (IReadOnlyList<SeerrRequestRecord>)Array.Empty<SeerrRequestRecord>());

        /// <summary>Title details for a request's title, when read.</summary>
        public SeerrTitleMeta? Meta(bool isMovie, int? tmdbId) => _backend.ReadSeerrCached(() => MetaCore(isMovie, tmdbId), (SeerrTitleMeta?)null);

        private SeerrTitleMeta? MetaCore(bool isMovie, int? tmdbId)
        {
            if (!EffectiveRequestsBackend.AllowsSeerr(_config()) || tmdbId is not > 0) return null;
            lock (_lock) return _meta.TryGetValue((isMovie, tmdbId.Value), out var meta) ? meta : null;
        }

        /// <inheritdoc />
        public RequestFacts? For(TitleKey titleKey, StatusViewer viewer)
            => FactsOf(ForTitle(titleKey), viewer.UserId);

        /// <inheritdoc />
        /// <remarks>Seerr asks for whole seasons: the requests that name the episode's season (or no season, the whole series).</remarks>
        public RequestFacts? ForEpisode(TitleKey seriesKey, int season, int episode, StatusViewer viewer)
            => ForSeason(seriesKey, season, viewer);

        /// <inheritdoc />
        /// <remarks>Seerr asks for whole seasons: the requests that name the season (or no season, the whole series).</remarks>
        public RequestFacts? ForSeason(TitleKey seriesKey, int season, StatusViewer viewer)
            => FactsOf(ForTitle(seriesKey).Where(r => !r.IsMovie && (r.Seasons.Count == 0 || r.Seasons.Contains(season))).ToList(), viewer.UserId);

        /// <inheritdoc />
        /// <remarks>Seerr asks for whole seasons: that edition's requests naming any of the part's seasons (or no season, the whole series).</remarks>
        public RequestFacts? ForPart(TitleKey titleKey, bool fourK, IReadOnlyList<int> seasons, IReadOnlyList<(int Season, int Episode)> episodes, StatusViewer viewer)
        {
            var parts = seasons.Concat(episodes.Select(e => e.Season)).ToHashSet();
            return FactsOf(ForTitle(titleKey).Where(r => r.Is4k == fourK && (r.IsMovie || parts.Count == 0 || r.Seasons.Count == 0 || r.Seasons.Any(parts.Contains))).ToList(), viewer.UserId);
        }

        /// <inheritdoc />
        /// <remarks>That edition's requests naming any of the part's seasons (as <see cref="ForPart"/>), composed as the Requests page composes a row.</remarks>
        public PartAvailability? AvailabilityForPart(TitleKey titleKey, bool fourK, IReadOnlyList<int> seasons, IReadOnlyList<(int Season, int Episode)> episodes, StatusViewer viewer)
        {
            var parts = seasons.Concat(episodes.Select(e => e.Season)).ToHashSet();
            var records = ForTitle(titleKey).Where(r => r.Is4k == fourK && (r.IsMovie || parts.Count == 0 || r.Seasons.Count == 0 || r.Seasons.Any(parts.Contains))).ToList();
            return records.Count == 0 ? null : AvailabilityOf(records);
        }

        /// <summary>
        /// Seerr's word on the edition some requests for one title asked for (the Requests page's row and a list entry
        /// share it): available when an active request's media is available in that edition, since its last change, and
        /// for a 4K-only ask the Jellyfin item Seerr matched the 4K copy to (a hint for Play, used only when the viewer can
        /// open it).
        /// </summary>
        /// <param name="records">Requests for one title (not empty).</param>
        /// <returns>The availability.</returns>
        internal static PartAvailability AvailabilityOf(IReadOnlyList<SeerrRequestRecord> records)
        {
            var asked = records.Where(r => r.Active).DefaultIfEmpty(records[0]).ToList();
            var only4k = asked.All(r => r.Is4k);
            var available = asked.Where(r => r.Active && r.MediaStatus == 5).ToList();
            return new PartAvailability(
                available.Count > 0,
                available.Select(r => r.UpdatedAt ?? r.CreatedAt).Where(d => d.HasValue).DefaultIfEmpty(null).Max(),
                only4k ? asked.OrderByDescending(r => r.UpdatedAt ?? r.CreatedAt).Select(r => r.JellyfinItemId).FirstOrDefault(id => id.HasValue) : null);
        }

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
                // Match the ledger: only this viewer's outstanding standard-season asks suppress
                // the next action. A declined/completed request or somebody else's 4K ask cannot.
                ViewerSeasons = active.Where(r => !r.IsMovie && !r.Is4k && r.RequestedBy == userId && r.Status != SeerrRequestStatus.Completed)
                    .SelectMany(r => r.Seasons).Distinct().OrderBy(s => s).ToArray(),
                Pending = active.Count > 0 && active.All(r => r.Status == SeerrRequestStatus.Pending),
                ApprovedAt = ApprovedOf(approved),
                ApprovedStandardAt = ApprovedOf(approved.Where(r => !r.Is4k).ToList()),
                Approved4kAt = ApprovedOf(approved.Where(r => r.Is4k).ToList()),
                StandardDone = Done(false),
                FourKDone = Done(true),
                Declined = active.Count == 0,
                // OK'd in Seerr and not done yet: Seerr sent it to Sonarr/Radarr then (its last change).
                Sent = active.Where(r => r.Status == SeerrRequestStatus.Approved && (r.UpdatedAt ?? r.CreatedAt).HasValue)
                    .SelectMany(r => r.IsMovie || r.Seasons.Count == 0
                        ? new[] { new RequestSentPart(r.Is4k, null, null, (r.UpdatedAt ?? r.CreatedAt)!.Value) }
                        : r.Seasons.Select(s => new RequestSentPart(r.Is4k, s, null, (r.UpdatedAt ?? r.CreatedAt)!.Value)))
                    .ToArray(),
            };
        }

        /// <inheritdoc />
        public bool AskedBy(TitleKey titleKey, Guid userId)
            => ForTitle(titleKey).Any(r => r.RequestedBy == userId);

        /// <inheritdoc />
        public bool Requested(TitleKey titleKey) => ForTitle(titleKey).Count > 0;

        /// <inheritdoc />
        public bool AskedLatelyBy(TitleKey titleKey, Guid userId) => _backend.ReadSeerrCached(() => AskedLatelyByCore(titleKey, userId), false);

        private bool AskedLatelyByCore(TitleKey titleKey, Guid userId)
        {
            if (AskedBy(titleKey, userId)) return true;
            lock (_lock) return _goneOwners.TryGetValue((titleKey.Title.ToString(), userId), out var until) && _now() < until;
        }

        /// <inheritdoc />
        public bool RequestedLately(TitleKey titleKey) => _backend.ReadSeerrCached(() => RequestedLatelyCore(titleKey), false);

        private bool RequestedLatelyCore(TitleKey titleKey)
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
            foreach (var (key, all) in before.ByKey)
            {
                // A request below what the new list covers is no longer known, not gone.
                var list = after.Floor is int floor ? all.Where(r => r.Id >= floor).ToList() : all;
                if (list.Count == 0) continue;
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
            if (!EffectiveRequestsBackend.AllowsSeerr(_config())) { Clear(); return; }
            lock (_lock) _requestedAt ??= _now();
        }

        /// <summary>
        /// Someone is looking at the Requests page: refresh every 30 s for the next two minutes. The
        /// page renews it with every change-feed poll while it stays open.
        /// </summary>
        public void Touch()
        {
            if (!EffectiveRequestsBackend.AllowsSeerr(_config())) { Clear(); return; }
            lock (_lock) _watchedAt = _now();
        }

        /// <summary>When a refresh was asked for and hasn't run yet (tests).</summary>
        internal DateTimeOffset? RequestedAt
        {
            get
            {
                lock (_lock) return _requestedAt;
            }
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
            _loopTask = Task.Run(() => LoopAsync(token), CancellationToken.None);
            return Task.CompletedTask;
        }

        /// <inheritdoc />
        /// <remarks>Waits for a read in progress to end (it is cancelled), or until Jellyfin stops waiting.</remarks>
        public async Task StopAsync(CancellationToken cancellationToken)
        {
            try
            {
                _loop?.Cancel();
            }
            catch (ObjectDisposedException)
            {
            }
            if (_loopTask is not { } loop) return;
            try
            {
                await loop.WaitAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                // Jellyfin stopped waiting.
            }
        }

        /// <inheritdoc />
        /// <remarks>
        /// Safe to call more than once: the service is registered three times (itself, the hosted
        /// service and <see cref="IArrRequestFacts"/>), so the container disposes it once per registration.
        /// </remarks>
        public void Dispose()
        {
            if (_outboxEvents != null) _outboxEvents.Confirmed -= OnRequestConfirmed;
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
            // Pointed at another Seerr: the list held (and its request ids) belong to the old one.
            var source = SourceOf(config);
            string? held;
            lock (_lock) held = _source;
            if (held != null && held != source)
            {
                _logger?.Info("[Requests] The Seerr settings point at another server: its requests are read afresh.");
                Clear(sourceChanged: true);
                return true;
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
        private void Clear(bool sourceChanged = false)
        {
            if (sourceChanged) Controllers.JellyfinEnhancedController.ClearAllSeerrCachesOnConfigChange();
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
                _source = null;
                _incompleteRuns = 0;
                _incompleteReason = null;
                _truncated = false;
                _reportedTotal = null;
                if (sourceChanged) _meta.Clear();
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
        /// Announces what changed. Returns false when Seerr could not be read, or its list changed
        /// while it was read (the last good list stays).
        /// </summary>
        public async Task<bool> RefreshAsync(CancellationToken cancellationToken)
        {
            if (!IsActive(_config())) { if (!EffectiveRequestsBackend.AllowsSeerr(_config())) Clear(); return false; }
            try { return await _backend.ReadSeerrAsync(SeerrUse.RequestRead, epoch => RefreshCoreAsync(cancellationToken, epoch)).ConfigureAwait(false); }
            catch (BackendDisabledException) { Clear(); return false; }
        }

        private async Task<bool> RefreshCoreAsync(CancellationToken cancellationToken, long epoch)
        {
            var config = _config();
            if (!IsActive(config)) { if (!EffectiveRequestsBackend.AllowsSeerr(config)) Clear(); return false; }
            await _refreshGate.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                if (!IsActive(_config())) { Clear(); return false; }
                var source = SourceOf(config)!;
                string? held;
                lock (_lock) held = _source;
                // Another Seerr than the one the held list came from: forget it first.
                var expiredEpoch = FactsEpoch.HasValue && !_backend.CheckSeerr(SeerrUse.RequestRead, FactsEpoch).Allowed;
                if (expiredEpoch)
                {
                    Clear(sourceChanged: true);
                    lock (_lock) { _goneTitles.Clear(); _goneOwners.Clear(); }
                }
                else if (held != null && held != source) Clear(sourceChanged: true);
                _backend.PublishSeerr(epoch, () => { lock (_lock) FactsEpoch = epoch; return true; });
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
                var key = config!.GetJellyseerrApiKey();
                string? lastError = null;
                foreach (var url in Urls(config))
                {
                    var (outcome, error) = await ReadFromAsync(url, key, source, cancellationToken, epoch).ConfigureAwait(false);
                    if (outcome == ReadOutcome.Ok)
                    {
                        _backend.PublishSeerr(epoch, () =>
                        {
                            lock (_lock)
                            {
                                _lastRead = _now();
                                _lastError = null;
                                _lastAttemptFailed = false;
                                _incompleteRuns = 0;
                                _incompleteReason = null;
                            }
                            AnnounceState(loadedBefore, failedBefore, loaded: true, failed: false);
                            return true;
                        });
                        return true;
                    }
                    if (outcome == ReadOutcome.Abandoned)
                    {
                        // The Seerr settings changed during the read: read again at once (from the new one).
                        lock (_lock) _requestedAt = _now() - RequestedDelay;
                        return false;
                    }
                    if (outcome == ReadOutcome.Incomplete)
                    {
                        // Seerr answered, but its list moved under the pages: nothing is taken from this
                        // read and it is tried again soon; only several in a row are a problem to show.
                        bool failed;
                        lock (_lock)
                        {
                            _incompleteRuns++;
                            _incompleteReason = error;
                            _lastAttemptFailed = true;
                            failed = _incompleteRuns >= IncompleteBeforeError;
                            if (failed) _lastError = "Seerr's request list kept changing while it was read: " + error;
                        }
                        if (failed)
                        {
                            AnnounceState(loadedBefore, failedBefore, loaded: loadedBefore, failed: true);
                            _logger?.Warning($"[Requests] Seerr's request list could not be read completely ({error}).");
                        }
                        return false;
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

        private enum ReadOutcome
        {
            Ok,
            Failed,
            Incomplete,
            Abandoned,
        }

        private async Task<(ReadOutcome Outcome, string? Error)> ReadFromAsync(string url, string apiKey, string source, CancellationToken ct, long epoch)
        {
            var probe = await GetJsonAsync($"{url}/api/v1/request?take={ProbeSize}&skip=0&sort=modified&filter=all", apiKey, ct).ConfigureAwait(false);
            if (probe.Error != null) return (ReadOutcome.Failed, probe.Error);
            var probeSignature = ProbeSignature(probe.Json!.Value);
            FullRead? read = null;
            bool full;
            lock (_lock)
            {
                full = probeSignature != _probeSignature || _lastFullRead == null || _now() - _lastFullRead.Value >= FullReadAtLeast || _source != source;
            }
            if (full)
            {
                read = await ReadAllAsync(url, apiKey, ct).ConfigureAwait(false);
                if (read.Error != null) return (ReadOutcome.Failed, read.Error);
                if (read.Incomplete != null) return (ReadOutcome.Incomplete, read.Incomplete);
            }

            var held = _snapshot;
            var metaChanged = new List<(bool, int)>();
            List<SeerrRequestRecord> current;
            int? floor = null;
            if (read == null)
            {
                current = held.All.ToList();
                floor = held.Floor;
            }
            else
            {
                current = read.Records;
                if (read.Truncated && read.LowestId is int lowest)
                {
                    // Seerr holds more than is read: the older requests keep what was last known of
                    // them (their absence from the window says nothing about them). What isn't held
                    // below the window (none known yet, or more than are kept) is unknown, not gone.
                    floor = lowest;
                    if (held.Source == source)
                    {
                        // The held list covered everything from its own floor up (all of it when null;
                        // request ids only grow, so nothing new appears below a complete list).
                        var below = held.All.Where(r => r.Id < lowest).OrderByDescending(r => r.Id).ToList();
                        floor = held.Floor is int f ? Math.Min(f, lowest) : null;
                        var keep = Math.Max(1, HeldBelowWindow);
                        if (below.Count > keep)
                        {
                            below.RemoveRange(keep, below.Count - keep);
                            floor = below[^1].Id;
                        }
                        current.AddRange(below);
                    }
                }
            }
            await ReadMetaAsync(url, apiKey, source, current, metaChanged, ct, epoch).ConfigureAwait(false);
            if (SourceOf(_config()) != source) return (ReadOutcome.Abandoned, null);
            if (read == null && metaChanged.Count == 0) return (ReadOutcome.Ok, null);

            var next = Snapshot.Build(current.Select(WithMetaIds), source, floor);
            return _backend.PublishSeerr(epoch, () =>
            {
                Snapshot old;
                lock (_lock)
                {
                    // Checked again under the lock Clear holds: a switch-off (or another Seerr) that cleared while this read
                    // ran isn't undone by publishing what it read.
                    if (SourceOf(_config()) != source) return (ReadOutcome.Abandoned, null);
                    old = _snapshot;
                    // A list from another Seerr replaces the old one silently (Clear announced the old one going).
                    var sameSource = old.Source == null || old.Source == source;
                    if (sameSource) RememberGone(old, next);
                    _snapshot = next;
                    FactsEpoch = epoch;
                    _source = source;
                    // Loaded from the moment the list is there: the change-feed announcement below wakes
                    // readers that check it.
                    _lastRead = _now();
                    if (read != null)
                  {
                        _probeSignature = probeSignature;
                        _lastFullRead = _now();
                        _truncated = read.Truncated;
                        _reportedTotal = read.Total;
                    }
                }
                // Another Seerr's list is another list even when both are empty (or the same size): the
                // notification scan must see it to note the new server.
                if (Announce(old, next, metaChanged) || old.All.Count != next.All.Count || old.Source != next.Source) Interlocked.Increment(ref _revision);
                return (ReadOutcome.Ok, (string?)null);
            });
        }

        /// <summary>A full read of Seerr's request list: the requests, or why it failed or isn't complete.</summary>
        private sealed class FullRead
        {
            public List<SeerrRequestRecord> Records { get; } = new();

            /// <summary>Seerr's count (pageInfo.results), the same on every page.</summary>
            public int Total { get; set; }

            /// <summary>Seerr holds more than <see cref="MaxRequests"/>: only the newest were read.</summary>
            public bool Truncated { get; set; }

            /// <summary>The oldest (lowest) request id read.</summary>
            public int? LowestId { get; set; }

            /// <summary>Seerr could not be read (connection, status, body).</summary>
            public string? Error { get; set; }

            /// <summary>Seerr answered, but the pages don't make one complete list.</summary>
            public string? Incomplete { get; set; }
        }

        /// <summary>
        /// Reads every request page by page (newest first, by id), advancing by the rows each page
        /// actually holds. Complete only when Seerr's count is the same on every page, the ids keep
        /// falling with no repeats, and as many distinct requests arrive as Seerr says it holds (or
        /// <see cref="MaxRequests"/> of them). A request added while the pages are read pushes a row
        /// already read onto the next page (a repeat); one removed changes the count.
        /// </summary>
        private async Task<FullRead> ReadAllAsync(string url, string apiKey, CancellationToken ct)
        {
            var read = new FullRead();
            var ids = new HashSet<int>();
            int? total = null;
            int? previous = null;
            var skip = 0;
            for (var pageNumber = 0; pageNumber < MaxPages; pageNumber++)
            {
                var page = await GetJsonAsync($"{url}/api/v1/request?take={PageSize}&skip={skip}&sort=added&filter=all", apiKey, ct).ConfigureAwait(false);
                if (page.Error != null)
                {
                    read.Error = page.Error;
                    return read;
                }
                var json = page.Json!.Value;
                var reported = json.TryGetProperty("pageInfo", out var info) && info.ValueKind == JsonValueKind.Object ? Int(info, "results") : null;
                if (reported is not >= 0)
                {
                    read.Incomplete = "Seerr did not say how many requests it holds.";
                    return read;
                }
                if (total != null && reported != total)
                {
                    read.Incomplete = "The number of requests changed while they were read.";
                    return read;
                }
                total = reported;
                var wanted = Math.Min(total.Value, MaxRequests);
                var rows = json.TryGetProperty("results", out var r) && r.ValueKind == JsonValueKind.Array ? r : default;
                var count = 0;
                if (rows.ValueKind == JsonValueKind.Array)
                {
                    foreach (var item in rows.EnumerateArray())
                    {
                        if (ids.Count >= wanted) break;
                        count++;
                        if (Int(item, "id") is not int id)
                        {
                            read.Incomplete = "A request came without an id.";
                            return read;
                        }
                        if (previous is int last && id >= last)
                        {
                            read.Incomplete = ids.Contains(id) ? "A request was listed twice (one was added while the pages were read)." : "The requests did not come newest first.";
                            return read;
                        }
                        previous = id;
                        ids.Add(id);
                        if (Parse(item) is { } record) read.Records.Add(record);
                    }
                }
                skip += count;
                if (ids.Count >= wanted)
                {
                    read.Total = total.Value;
                    read.Truncated = total.Value > MaxRequests;
                    read.LowestId = previous;
                    return read;
                }
                if (count == 0)
                {
                    read.Incomplete = "The list ended before every request was read (some were removed while the pages were read).";
                    return read;
                }
            }
            read.Incomplete = "The list did not end within the page limit.";
            return read;
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

        private async Task ReadMetaAsync(string url, string apiKey, string source, IReadOnlyList<SeerrRequestRecord> records, List<(bool, int)> changed, CancellationToken ct, long epoch)
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
                _backend.PublishSeerr(epoch, () =>
                {
                    SeerrTitleMeta? before;
                    lock (_lock)
                    {
                        // Another Seerr since this read began (Clear dropped its details): not kept.
                        if (SourceOf(_config()) != source) return false;
                        if (_meta.Count >= MaxMeta) _meta.Clear();
                        _meta.TryGetValue((movie, tmdb), out before);
                        _meta[(movie, tmdb)] = meta;
                    }
                    // Nothing known before counts as "no details" (a title Seerr can't describe changes nothing shown).
                    if (!meta.SameAs(before ?? new SeerrTitleMeta())) changed.Add((movie, tmdb));
                    return true;
                });
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
            try { return await _backend.ReadSeerrAsync(SeerrUse.RequestRead, _ => GetJsonCoreAsync(uri, apiKey, ct)).ConfigureAwait(false); }
            catch (BackendDisabledException) { return (null, "backend_disabled", false); }
        }

        private async Task<(JsonElement? Json, string? Error, bool NotFound)> GetJsonCoreAsync(string uri, string apiKey, CancellationToken ct)
        {
            if (!EffectiveRequestsBackend.AllowsSeerr(_config())) return (null, "backend_disabled", false);
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
            public static readonly Snapshot Empty = Build(Array.Empty<SeerrRequestRecord>(), null, null);

            public IReadOnlyList<SeerrRequestRecord> All { get; private init; } = Array.Empty<SeerrRequestRecord>();

            /// <summary>The Seerr the requests came from (<see cref="SeerrRequestReadModel.SourceOf"/>), or null when empty.</summary>
            public string? Source { get; private init; }

            /// <summary>
            /// The lowest request id covered, or null when every request Seerr holds is: a request
            /// below it that isn't held is not known (Seerr holds more than is read).
            /// </summary>
            public int? Floor { get; private init; }

            public Dictionary<int, SeerrRequestRecord> ById { get; } = new();

            public Dictionary<string, List<SeerrRequestRecord>> ByKey { get; } = new(StringComparer.Ordinal);

            public Dictionary<Guid, List<SeerrRequestRecord>> ByUser { get; } = new();

            public static Snapshot Build(IEnumerable<SeerrRequestRecord> records, string? source, int? floor)
            {
                var all = records.GroupBy(r => r.Id).Select(g => g.First())
                    .OrderByDescending(r => r.CreatedAt ?? DateTime.MinValue).ThenByDescending(r => r.Id).ToList();
                var snapshot = new Snapshot { All = all, Source = source, Floor = floor };
                foreach (var r in all)
                {
                    snapshot.ById[r.Id] = r;
                    foreach (var key in TitleAliases.FromRequest(r))
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
        }
    }
    }
}
