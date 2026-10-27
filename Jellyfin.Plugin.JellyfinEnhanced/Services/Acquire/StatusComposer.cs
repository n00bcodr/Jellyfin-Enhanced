using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire
{
    /// <summary>
    /// What one arr instance knows about a title (user-independent; read from the snapshots). A Sonarr copy's facts (its
    /// series and season statistics, episodes, queue and history) can be given but never read back from here (D53, edition
    /// round 14: masked facts by construction): a reader gets them only through <see cref="Through(HiddenParts)"/>, a read that
    /// has already applied the mask of what Jellyfin hides from the viewer in the copy it is bound to. A Radarr copy's are read
    /// through <see cref="Radarr"/> (a movie has no parts Jellyfin hides inside it). What stays readable here names the copy
    /// (instance, folder, monitored seasons) and says nothing about any episode.
    /// </summary>
    internal sealed class ArrCopyFacts
    {
        public ArrCopyFacts(ArrConnection instance)
        {
            Instance = instance;
        }

        /// <summary>The instance.</summary>
        public ArrConnection Instance { get; }

        /// <summary>The movie (Radarr).</summary>
        public ArrMovieEntry? Movie { get; init; }

        /// <summary>The series (Sonarr), with its season statistics: read only through a masked read.</summary>
        public ArrSeriesEntry? Series { private get; init; }

        /// <summary>Queue rows of this title: read only through <see cref="Radarr"/> or a masked read.</summary>
        public IReadOnlyList<ArrQueueEntry> Queue { private get; init; } = Array.Empty<ArrQueueEntry>();

        /// <summary>History of this title, newest first: read only through <see cref="Radarr"/> or a masked read.</summary>
        public IReadOnlyList<ArrHistoryEntry> History { private get; init; } = Array.Empty<ArrHistoryEntry>();

        /// <summary>Episodes (Sonarr), when held in memory: read only through a masked read.</summary>
        public ArrEpisodesSnapshot? Episodes { private get; init; }

        /// <summary>When the library snapshot this copy came from was read (UTC).</summary>
        public DateTime? LibraryLoadedAt { get; init; }

        /// <summary>When the episodes were read (UTC).</summary>
        public DateTime? EpisodesLoadedAt { get; init; }

        /// <summary>When a download of a movie (Radarr id) or episode (Sonarr id) recently left the queue (UTC), if it did.</summary>
        public Func<int?, int?, DateTime?>? LeftQueue { get; init; }

        /// <summary>JE's first-seen clocks of the queue rows (null: the arr's added time is used).</summary>
        public Func<ArrQueueEntry, ArrQueueSeen?>? Seen { get; init; }

        /// <summary>When the queue came from was read (UTC); the arr's "time left" counts from then.</summary>
        public DateTime? QueueLoadedAt { get; init; }

        /// <summary>The queue is past its freshness target (a refresh is on its way): no time left is given.</summary>
        public bool QueueStale { get; init; }

        /// <summary>
        /// The instance's queue or history is past its longest serve time and can't be read: what it
        /// is downloading is unknown (the queue is then empty). Never "looking" or
        /// "downloading": <see cref="StatusReasonCode.ServiceDown"/>, unless the library says the file is there.
        /// </summary>
        public bool QueueUnknown { get; init; }

        /// <summary>A Sonarr copy (it holds a series).</summary>
        public bool IsSeries => Series != null;

        /// <summary>The title's folder in the arr's view of the file system (which Jellyfin copy it owns).</summary>
        public string? Path => Movie?.Path ?? Series?.Path;

        /// <summary>Sonarr's episode list of the series is in memory (whether a read can name episodes; it names none).</summary>
        public bool EpisodesInMemory => Episodes != null;

        /// <summary>The queue has rows (whether the viewer's files are worth reading for it; it names no episode).</summary>
        public bool HasDownloads => Queue.Count > 0;

        /// <summary>The seasons Sonarr monitors (which seasons a whole-series request follows; every follower reads them masked).</summary>
        public IReadOnlyList<int> MonitoredSeasons => Series?.Seasons.Where(s => s.Monitored).Select(s => s.SeasonNumber).ToList() ?? (IReadOnlyList<int>)Array.Empty<int>();

        /// <summary>
        /// The copy may be one in Jellyfin no lookup matched yet: Sonarr has files of it, or imported one in the last 30 days
        /// (who owns which copy; never shown).
        /// </summary>
        public bool MayHoldFiles(DateTime now) => Series?.EpisodeFileCount > 0 || StatusComposer.RecentImportIn(History, now, TimeSpan.FromDays(30)) != null;

        /// <summary>A Radarr copy's facts. A Sonarr copy is only read through a mask (<see cref="Through(HiddenParts)"/>).</summary>
        public ArrCopyRead Radarr()
            => Series == null ? new ArrCopyRead(this, null, null, Queue, History, null) : throw new InvalidOperationException("A Sonarr copy is read through the mask of the copy it is bound to.");

        /// <summary>A Sonarr copy's facts as one viewer may hear them: every one passes <paramref name="mask"/> first.</summary>
        public ArrCopyRead Through(HiddenParts mask) => Through(() => mask);

        /// <summary>
        /// A Sonarr copy's facts as one viewer may hear them, the mask read only when a fact that names a part is asked for (an
        /// empty queue needs none).
        /// </summary>
        public ArrCopyRead Through(Func<HiddenParts?> mask)
            => Series != null ? new ArrCopyRead(this, Series, Episodes, Queue, History, mask) : throw new InvalidOperationException("Not a Sonarr copy.");
    }

    /// <summary>
    /// One arr copy's facts as one viewer may hear them (D53, edition round 14), from <see cref="ArrCopyFacts.Through(HiddenParts)"/>
    /// (Sonarr) or <see cref="ArrCopyFacts.Radarr"/>: for a Sonarr copy every fact has already passed the mask of what Jellyfin
    /// hides from the viewer in the copy it is bound to (<see cref="Mask"/>), so a hidden season has no statistics, a hidden
    /// episode no entry, queue row or history, and every count and date is derived from the visible episodes, never Sonarr's
    /// own minus what is hidden (D53, edition round 15; see <see cref="Series"/>). Each fact is masked once, when it is first
    /// asked for.
    /// </summary>
    internal sealed class ArrCopyRead
    {
        private readonly ArrSeriesEntry? _series;
        private readonly ArrEpisodesSnapshot? _episodes;
        private readonly IReadOnlyList<ArrQueueEntry> _queue;
        private readonly IReadOnlyList<ArrHistoryEntry> _history;
        private readonly Func<HiddenParts?>? _maskOf;
        private HiddenParts? _mask;
        private ArrSeriesEntry? _maskedSeries;
        private ArrEpisodesSnapshot? _maskedEpisodes;
        private IReadOnlyList<ArrQueueEntry>? _maskedQueue;
        private IReadOnlyList<ArrHistoryEntry>? _maskedHistory;
        private HashSet<int>? _unvouched;
        private static readonly IReadOnlySet<int> NoSeasons = new HashSet<int>();

        internal ArrCopyRead(ArrCopyFacts facts, ArrSeriesEntry? series, ArrEpisodesSnapshot? episodes, IReadOnlyList<ArrQueueEntry> queue, IReadOnlyList<ArrHistoryEntry> history, Func<HiddenParts?>? mask)
        {
            Facts = facts;
            _series = series;
            _episodes = episodes;
            _queue = queue;
            _history = history;
            _maskOf = mask;
        }

        /// <summary>The copy read (who it is, which folder it owns).</summary>
        public ArrCopyFacts Facts { get; }

        /// <summary>The instance.</summary>
        public ArrConnection Instance => Facts.Instance;

        /// <summary>What Jellyfin hides from the viewer in the copy this read is bound to (nothing for a Radarr copy).</summary>
        public HiddenParts Mask => _mask ??= _maskOf?.Invoke() ?? HiddenParts.None;

        /// <summary>The movie (Radarr).</summary>
        public ArrMovieEntry? Movie => Facts.Movie;

        /// <summary>
        /// The series (Sonarr) as the viewer may hear it (D53, edition round 15: aggregates derived, never subtracted): no wholly
        /// hidden season, and each other season's statistics only from what the viewer may see: Sonarr's own when no episode of
        /// the season is hidden from them, else derived from the visible episodes of Sonarr's list (when it is in memory), else
        /// not given (no counts, no next airing: the season is <see cref="Unvouched"/>). The series' counts and next airing are
        /// those seasons' together whenever anything is hidden.
        /// </summary>
        public ArrSeriesEntry? Series => _series == null ? null : _maskedSeries ??= Derive(_series, Mask);

        /// <summary>
        /// Seasons whose statistics this read can't vouch for (some episode of them is hidden from the viewer and Sonarr's
        /// episode list isn't in memory): <see cref="Series"/> gives them no counts and no next airing, and nothing may read
        /// them as done.
        /// </summary>
        public IReadOnlySet<int> Unvouched => Series == null ? NoSeasons : _unvouched ?? NoSeasons;

        /// <summary>Episodes (Sonarr), when held in memory: none the mask hides.</summary>
        public ArrEpisodesSnapshot? Episodes => _episodes == null ? null : _maskedEpisodes ??= Hidden ? new ArrEpisodesSnapshot(_episodes.SeriesId, _episodes.Episodes.Where(e => !Mask.Hides(e.SeasonNumber, e.EpisodeNumber)).ToList()) : _episodes;

        /// <summary>Queue rows of this title: none of a hidden part.</summary>
        public IReadOnlyList<ArrQueueEntry> Queue => _queue.Count == 0 ? _queue : _maskedQueue ??= Hidden ? _queue.Where(r => !HidesPart(r.SeasonNumber, r.EpisodeNumber, r.EpisodeId)).ToList() : _queue;

        /// <summary>History of this title, newest first: none of a hidden part.</summary>
        public IReadOnlyList<ArrHistoryEntry> History => _history.Count == 0 ? _history : _maskedHistory ??= Hidden ? _history.Where(h => !HidesPart(h.SeasonNumber, h.EpisodeNumber, h.EpisodeId)).ToList() : _history;

        /// <summary>When the library snapshot this copy came from was read (UTC).</summary>
        public DateTime? LibraryLoadedAt => Facts.LibraryLoadedAt;

        /// <summary>When <see cref="Episodes"/> was read (UTC).</summary>
        public DateTime? EpisodesLoadedAt => Facts.EpisodesLoadedAt;

        /// <summary>When a download of a movie (Radarr id) or episode (Sonarr id) recently left the queue (UTC), if it did.</summary>
        public Func<int?, int?, DateTime?>? LeftQueue => Facts.LeftQueue;

        /// <summary>JE's first-seen clocks of the queue rows.</summary>
        public Func<ArrQueueEntry, ArrQueueSeen?>? Seen => Facts.Seen;

        /// <summary>When the queue was read (UTC).</summary>
        public DateTime? QueueLoadedAt => Facts.QueueLoadedAt;

        /// <summary>The queue is past its freshness target.</summary>
        public bool QueueStale => Facts.QueueStale;

        /// <summary>The instance's downloads can't be known now.</summary>
        public bool QueueUnknown => Facts.QueueUnknown;

        private bool Hidden => _series != null && (Mask.Seasons.Count > 0 || Mask.Episodes.Count > 0);

        /// <summary>A row or event of a hidden part: by its numbers, else by its Sonarr episode id (the unmasked list names it).</summary>
        private bool HidesPart(int? season, int? episode, int? episodeId)
        {
            if (season is int s && Mask.Seasons.Contains(s)) return true;
            if (season is int se && episode is int e) return Mask.Hides(se, e);
            return episodeId is int id && _episodes?.Episodes.FirstOrDefault(x => x.Id == id) is { } known && Mask.Hides(known.SeasonNumber, known.EpisodeNumber);
        }

        /// <summary>
        /// The series' statistics from the episodes the viewer may see (see <see cref="Series"/>): never Sonarr's own count minus
        /// what is hidden, which can't know a hidden episode's file or air date Jellyfin doesn't hold.
        /// </summary>
        private ArrSeriesEntry Derive(ArrSeriesEntry series, HiddenParts mask)
        {
            if (mask.Seasons.Count == 0 && mask.Episodes.Count == 0) return series;
            var unvouched = new HashSet<int>();
            var seasons = new List<ArrSeasonEntry>();
            // An episode had aired when the library was read (a date-only snapshot, no clock of its own): before then, else
            // before Sonarr's own next airing of its season.
            var readAt = Facts.EpisodesLoadedAt ?? Facts.LibraryLoadedAt;
            foreach (var s in series.Seasons)
            {
                if (mask.Seasons.Contains(s.SeasonNumber)) continue;
                if (mask.Episodes.CountInSeason(s.SeasonNumber) == 0)
                {
                    // Nothing hidden in it: Sonarr's own statistics are the viewer's.
                    seasons.Add(s);
                    continue;
                }
                if (_episodes == null)
                {
                    unvouched.Add(s.SeasonNumber);
                    seasons.Add(new ArrSeasonEntry { SeasonNumber = s.SeasonNumber, Monitored = s.Monitored });
                    continue;
                }
                bool Aired(ArrEpisodeEntry e) => e.AirDateUtc is DateTime at && (readAt is DateTime read ? at <= read : s.NextAiring is not DateTime next || at < next);
                var visible = _episodes.Episodes.Where(e => e.SeasonNumber == s.SeasonNumber && !mask.Hides(e.SeasonNumber, e.EpisodeNumber)).ToList();
                seasons.Add(new ArrSeasonEntry
                {
                    SeasonNumber = s.SeasonNumber,
                    Monitored = s.Monitored,
                    EpisodeFileCount = visible.Count(e => e.HasFile),
                    EpisodeCount = visible.Count(e => e.HasFile || (e.Monitored && Aired(e))),
                    TotalEpisodeCount = visible.Count,
                    // Sonarr's next airing of the season is when its next monitored episode airs: the first visible one from then.
                    NextAiring = s.NextAiring is DateTime from ? visible.Where(e => e.Monitored && e.AirDateUtc >= from).Select(e => e.AirDateUtc).Min() : null,
                });
            }
            _unvouched = unvouched;
            return new ArrSeriesEntry
            {
                Id = series.Id,
                TvdbId = series.TvdbId,
                TmdbId = series.TmdbId,
                ImdbId = series.ImdbId,
                Title = series.Title,
                TitleSlug = series.TitleSlug,
                Monitored = series.Monitored,
                Path = series.Path,
                QualityProfileId = series.QualityProfileId,
                Tags = series.Tags,
                EpisodeFileCount = seasons.Sum(x => x.EpisodeFileCount),
                EpisodeCount = seasons.Sum(x => x.EpisodeCount),
                PercentOfEpisodes = series.PercentOfEpisodes,
                SizeOnDisk = series.SizeOnDisk,
                Status = series.Status,
                NextAiring = seasons.Where(x => x.NextAiring.HasValue).Select(x => x.NextAiring).DefaultIfEmpty(null).Min(),
                Added = series.Added,
                Seasons = seasons,
            };
        }
    }

    /// <summary>An instance of a title's kind whose library isn't in memory, and the admin label for it ("name (error kind)").</summary>
    /// <param name="Instance">The instance.</param>
    /// <param name="Label">What the admin block shows.</param>
    internal sealed record UnreadableArr(ArrConnection Instance, string Label);

    /// <summary>Everything the arrs and the request system know about one title.</summary>
    internal sealed class TitleFacts
    {
        public TitleFacts(TitleKey key)
        {
            using var __factsOperation0 = global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.BeginOperation();
            _keyFactsStorage = key;
        }

        /// <summary>The title (movie or series) key.</summary>
        public TitleKey Key { get => _keyFactsOwner.Read(ref _keyFactsStorage, () => default!); }
        /// <summary>One entry per instance holding the title.</summary>
        public List<ArrCopyFacts> Copies { get => _copiesFactsOwner.Read(ref _copiesFactsStorage, () => default!); }
        /// <summary>Instances of the title's kind that could not be read (with "name (kind)" labels).</summary>
        public List<UnreadableArr> Unreadable { get => _unreadableFactsOwner.Read(ref _unreadableFactsStorage, () => default!); }
        /// <summary>
        /// Instances whose library is held from an earlier read but whose latest read failed: what
        /// they hold may have changed since, so "no Sonarr/Radarr has it" can't be said.
        /// </summary>
        public List<ArrConnection> Stale { get => _staleFactsOwner.Read(ref _staleFactsStorage, () => default!); }
        /// <summary>
        /// Instances of the title's kind whose library could be read (holding the title or not). None:
        /// no Sonarr/Radarr of its kind is set up (or none could be read), so "none has it" can't be said.
        /// </summary>
        public List<ArrConnection> Checked { get => _checkedFactsOwner.Read(ref _checkedFactsStorage, () => default!); }
        /// <summary>Request facts (Seerr read model), if any.</summary>
        public RequestFacts? Request { get; set; }

        /// <summary>The key the change feed announces the title under, when an arr copy names it differently (see <see cref="TitleStatus.LiveKey"/>).</summary>
        public TitleKey? LiveKey { get; set; }

        /// <summary>
        /// The viewer's Jellyfin copy lookup for the title couldn't finish (<see cref="CopyLookupOutcome.Incomplete"/>): the
        /// status reads it as not found, but nothing says it is gone because of that (never "since removed" or "declined").
        /// </summary>
        public bool CopiesIncomplete { get; set; }

        /// <summary>
        /// The copies that lookup saw (<see cref="CopyLookup.Seen"/>; every copy when it finished). When it couldn't finish,
        /// which arr copy owns a Jellyfin copy is judged from these alone, never from a default.
        /// </summary>
        public IReadOnlyList<JfCopy> SeenCopies { get; set; } = Array.Empty<JfCopy>();
        private List<ArrCopyFacts> _copiesFactsStorage = new();
        private readonly global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.State<List<ArrCopyFacts>> _copiesFactsOwner = new(prepared: true);
        private List<UnreadableArr> _unreadableFactsStorage = new();
        private readonly global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.State<List<UnreadableArr>> _unreadableFactsOwner = new(prepared: true);
        private List<ArrConnection> _staleFactsStorage = new();
        private readonly global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.State<List<ArrConnection>> _staleFactsOwner = new(prepared: true);
        private List<ArrConnection> _checkedFactsStorage = new();
        private readonly global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.State<List<ArrConnection>> _checkedFactsOwner = new(prepared: true);
        private TitleKey _keyFactsStorage = default!;
        private readonly global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.State<TitleKey> _keyFactsOwner = new(prepared: true);
    }

    /// <summary>
    /// What Jellyfin hides from a viewer inside a series they can open: episode numbers (with or
    /// without a file) and whole seasons. Numbers only, from <see cref="JfEpisode.Hidden"/> and
    /// <see cref="JfSeason.Hidden"/>.
    /// </summary>
    internal sealed class HiddenParts
    {
        public HiddenParts(EpisodeCoverage episodes, EpisodeCoverage withFile, IReadOnlySet<int> seasons)
        {
            Episodes = episodes;
            WithFile = withFile;
            Seasons = seasons;
        }

        /// <summary>Nothing hidden.</summary>
        public static HiddenParts None { get; } = new(new EpisodeCoverage(Array.Empty<JfEpisode>()), new EpisodeCoverage(Array.Empty<JfEpisode>()), new HashSet<int>());

        /// <summary>Hidden episode numbers (the viewer sees no episode with that number).</summary>
        public EpisodeCoverage Episodes { get; }

        /// <summary>The hidden episodes Jellyfin has a file for.</summary>
        public EpisodeCoverage WithFile { get; }

        /// <summary>Seasons Jellyfin hides as a whole.</summary>
        public IReadOnlySet<int> Seasons { get; }

        /// <summary>True when the season, or the episode in it, is hidden.</summary>
        public bool Hides(int? season, int? episode)
            => season is int s && (Seasons.Contains(s) || (episode is int e && Episodes.Contains((s, e))));

        /// <summary>
        /// What either hides (a page's own markers and its binding's own mask, D53 edition round 13): no number one hides
        /// is shown because the other doesn't.
        /// </summary>
        public static HiddenParts? Union(HiddenParts? a, HiddenParts? b)
        {
            if (a == null || ReferenceEquals(a, None)) return b ?? a;
            if (b == null || ReferenceEquals(b, None)) return a;
            var seasons = new HashSet<int>(a.Seasons);
            seasons.UnionWith(b.Seasons);
            return new HiddenParts(
                new EpisodeCoverage(a.Episodes.Ranges().Concat(b.Episodes.Ranges())),
                new EpisodeCoverage(a.WithFile.Ranges().Concat(b.WithFile.Ranges())),
                seasons);
        }
    }

    /// <summary>Viewer, clock and settings for one composition.</summary>
    internal sealed class ComposeContext
    {
        public ComposeContext(StatusViewer viewer, DateTime nowUtc, int lookingHours)
        {
            Viewer = viewer;
            Now = nowUtc;
            LookingHours = Math.Clamp(lookingHours, 1, 720);
        }

        /// <summary>Who is asking.</summary>
        public StatusViewer Viewer { get; }

        /// <summary>Now (UTC).</summary>
        public DateTime Now { get; }

        /// <summary>Hours before "Looking" becomes "Still looking".</summary>
        public int LookingHours { get; }

        /// <summary>
        /// How long after Seerr OK'd a request an administrator is told that no Sonarr/Radarr holds
        /// the title (<see cref="StatusReasonCode.ApprovedNotInArr"/>); null: never (phase 2 off).
        /// Family members are told only after <see cref="LookingHours"/>.
        /// </summary>
        public TimeSpan? HandoffGrace { get; init; }

        /// <summary>
        /// A request that went out restarts the "still looking" clock of the parts it covers (Requests &amp;
        /// downloads phase 3 only; with it off the clock counts from the arr's own dates, as before).
        /// </summary>
        public bool RequestClock { get; init; } = true;

        /// <summary>
        /// One physical series folder as the viewer reads it now (<see cref="IArrJellyfinView.SeriesFolder"/>), read once per
        /// answer and shared by every binding and page of it (D53, edition round 13): <see cref="EpisodesOf"/> and
        /// <see cref="HiddenOf"/> come from it. Null: not known.
        /// </summary>
        public Func<Guid, JfSeriesFolder>? FolderOf { get; init; }

        /// <summary>
        /// The episodes of a Jellyfin series item as the viewer sees them now (no virtual ones; hidden ones marked): what
        /// tells an upgrade (a download of an episode they already play) from a download on the surfaces that read only
        /// the queue. Asked only for a copy whose Sonarr has downloads; null: not known (every row reads as a download).
        /// </summary>
        public Func<Guid, IReadOnlyList<JfEpisode>>? EpisodesOf { get; init; }

        /// <summary>
        /// What Jellyfin hides from a viewer with parental limits inside a series item (from the same folder read as
        /// <see cref="EpisodesOf"/>); null for everyone else (nothing is hidden from them).
        /// </summary>
        public Func<Guid, HiddenParts>? HiddenOf { get; init; }

        /// <summary>
        /// Whether a series item (a copy) plays an episode for the viewer now: the availability predicate
        /// (<see cref="EditionAvailability"/>, <see cref="Edition.Any"/>) over the same folder read as <see cref="EpisodesOf"/>.
        /// A Sonarr copy's line reads "in the library" only then. Null: not known, so nothing is credited.
        /// </summary>
        public Func<Guid, bool>? Holds { get; init; }
    }

    /// <summary>
    /// One Sonarr copy of a series as one viewer reads it (D53, edition round 12): the Jellyfin copy it owns
    /// (<see cref="Jf"/>), from which its files, the parts Jellyfin hides from the viewer and its queue's meaning all
    /// come, and only while the viewer can open that copy now (<see cref="Open"/>). <see cref="Jf"/> is null for a Sonarr
    /// copy Jellyfin has no copy of (where Sonarr has got to, no files), and for an administrator's line of a Sonarr whose
    /// copy can't be told. A Sonarr copy with no binding contributes nothing (see <see cref="StatusComposer.SeriesBindings"/>).
    /// </summary>
    /// <param name="Copy">The Sonarr copy.</param>
    /// <param name="Jf">The Jellyfin copy it owns, if any.</param>
    internal sealed record SeriesBinding(ArrCopyFacts Copy, JfCopy? Jf)
    {
        /// <summary>The viewer can open the copy it owns now: its files and hidden parts are theirs.</summary>
        public bool Open => Jf?.Visible == true;

        /// <summary>
        /// The Sonarr copy's facts through this binding's own mask (D53, edition round 14): what Jellyfin hides from the viewer
        /// in the copy it owns (read only when a fact that names a part is asked for), with <paramref name="also"/> (a page's
        /// own markers) on top. Every status reader of a bound Sonarr copy reads it through here.
        /// </summary>
        public ArrCopyRead Read(ComposeContext c, HiddenParts? also = null)
            => Copy.Through(() => HiddenParts.Union(also, Open ? c.HiddenOf?.Invoke(Jf!.ItemId) : null));
    }

    /// <summary>
    /// Derives a title's status in the one status language from the arr snapshots, Jellyfin and the
    /// request facts. Pure: no I/O, no clock of its own. "Ready" always means a Jellyfin item the
    /// viewer can open. Family members see the best copy they could open (4K copies only when they
    /// can open the 4K item); admins also get every copy with the arr's own words and a fix hint.
    /// </summary>
    internal static class StatusComposer
    {
        private static readonly TimeSpan FailedShownFor = TimeSpan.FromHours(6);
        private static readonly TimeSpan RecentArrival = TimeSpan.FromDays(3);
        private static readonly TimeSpan UpcomingShownWithin = TimeSpan.FromDays(14);
        private const int MaxMessages = 3;

        /// <summary>The state of one copy (or one episode of it).</summary>
        /// <summary>
        /// How long a date-only day (midnight UTC on the wire) is still that day somewhere: until 36
        /// hours after its start (UTC−12). Kept that long as "the" date (Coming soon keeps it too);
        /// the browser shows it in the viewer's own calendar and drops it once their day has passed.
        /// </summary>
        internal static readonly TimeSpan DayLasts = TimeSpan.FromHours(36);

        /// <summary>A date-only day that is still today or later somewhere (see <see cref="DayLasts"/>).</summary>
        internal static bool DayStillAhead(DateTime day, DateTime now) => day.Date + DayLasts > now;

        /// <summary>
        /// A date still to come: an instant after now, or a date-only day still ahead somewhere. The one airing rule of status and
        /// of the season rows' <c>aired</c> (what Pick episodes offers).
        /// </summary>
        internal static bool NotYet(DateTime date, bool isDay, DateTime now) => isDay ? DayStillAhead(date, now) : date > now;

        /// <summary>
        /// An episode has aired: its date is known (<see cref="Valid"/>: Sonarr's 0001-01-01 means unknown) and no longer ahead
        /// (<see cref="NotYet"/>). Unknown is not aired. The season page's status and the season rows' <c>aired</c> (what Pick
        /// episodes offers) both use this one rule.
        /// </summary>
        internal static bool Aired(DateTime? date, bool isDay, DateTime now) => Valid(date) is { } at && !NotYet(at, isDay, now);

        internal sealed record CopyState(string Stage, string Reason, bool Attention = false, StatusProgress? Progress = null, DateTime? Date = null, DateTime? Since = null, ArrQueueEntry? Row = null, IReadOnlyDictionary<string, string>? Params = null, bool DateIsDay = false, DateTime? LastSearch = null)
        {
            /// <summary><see cref="Date"/> as "yyyy-MM-dd" when it is a calendar day only (null otherwise).</summary>
            public string? Day => DateIsDay && Date is DateTime d ? DayOf(d) : null;

            public int Rank => Stage == StatusStage.Ready ? 100 : Math.Max(StatusStage.Rank(Stage), Stage == StatusStage.NotHere ? -2 : -3);
        }

        // ------------------------------------------------------------------ movies

        /// <summary>
        /// A movie: <paramref name="item"/> is the Jellyfin item asked for (null on the key path);
        /// <paramref name="copies"/> every Jellyfin copy of the movie (null: only <paramref name="item"/> is known).
        /// </summary>
        /// <remarks>
        /// <para><paramref name="followEveryRole"/>: a request for one edition (its own instances' facts only): a family
        /// member follows that edition's copies wherever they have got to, 4K ones included (the whole title's status
        /// follows a 4K copy only once its item is visible).</para>
        /// <para>D53, edition round 19 (projection keeps complete ownership): <paramref name="copies"/> are the EVIDENCE of
        /// which Radarr copy is whose (every copy of the title, the ones the viewer can't open included), kept apart from what
        /// plays the edition asked for (<paramref name="qualifying"/>, null: any copy they open). A Radarr copy matched to a
        /// copy they can't open is that hidden copy's, never "nobody's" (its downloads are never theirs to see), and ownership
        /// is judged against every instance holding the title (<paramref name="owners"/>, default the facts' own), so an edition's
        /// instances alone never take a copy by "it is the only Radarr here".</para>
        /// <para>D53, edition round 19 part B (one availability definition): a copy other than the page's own item is in the
        /// library for a Radarr's line, the headline or Play only when it is in <paramref name="qualifying"/>, the copies
        /// <see cref="EditionAvailability.Holding"/> found an accessible playable source of the edition in. Null: none is
        /// (never "visible is enough"). The page's own item is judged by <see cref="EditionAvailability.Plays(JfItemRef)"/>.</para>
        /// </remarks>
        public static TitleStatus Movie(TitleFacts facts, JfItemRef? item, IReadOnlyList<JfCopy>? copies, ComposeContext c, bool detail, bool followEveryRole = false,
            IReadOnlyCollection<Guid>? qualifying = null, IReadOnlyList<ArrCopyFacts>? owners = null)
        {
            using var __factsOperation1 = global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.BeginOperation();
            var self = item != null ? new JfCopy { ItemId = item.ItemId, Visible = true, Path = item.Path, DateCreated = item.DateCreated, LibraryId = item.LibraryId, LibraryName = item.LibraryName } : null;
            var jf = copies ?? (self != null ? new[] { self } : Array.Empty<JfCopy>());
            bool Qualifies(JfCopy x) => qualifying?.Contains(x.ItemId) == true;
            // The page's own item as the viewer opens it now, when the copies don't list it (a lookup that couldn't finish):
            // an arr copy whose folder is exactly its title folder owns it all the same (as SeriesCopyFor).
            var unlisted = self != null && jf.All(x => x.ItemId != self.ItemId) && !string.IsNullOrWhiteSpace(self.Path) ? self : null;
            var variants = new List<(ArrCopyRead Copy, CopyState State, JfCopy? Jf)>();
            var movieCopies = facts.Copies.Where(x => x.Movie != null).ToList();
            var siblings = owners ?? movieCopies;
            // Which Jellyfin copy is whose, for sure; a copy no instance owns for sure is anyone's that may own it (D53, edition
            // round 20: uncertain is not absent).
            var definite = movieCopies.ToDictionary(x => x, x => MovieMatches(x, jf, siblings));
            var owned = new HashSet<Guid>(siblings.SelectMany(o => definite.TryGetValue(o, out var mine) ? mine : MovieMatches(o, jf, siblings)).Select(x => x.ItemId));
            foreach (var arrCopy in movieCopies)
            {
                var matched = definite[arrCopy];
                if (unlisted != null && HoldsFolder(arrCopy, TitleFolder(Norm(unlisted.Path!), movie: true))) matched.Insert(0, unlisted);
                var copy = arrCopy.Radarr();
                var own = item != null ? matched.FirstOrDefault(m => m.ItemId == item.ItemId) : null;
                // The page's own item is a stub (D53, edition round 16: it plays nothing): this copy reads where its Radarr
                // has got to, a download of it included, never Ready.
                var stub = own != null && !EditionAvailability.Plays(item!);
                var visible = stub ? null : own ?? matched.FirstOrDefault(m => m.Visible && Qualifies(m));
                CopyState state;
                if (visible != null)
                {
                    state = copy.Queue.Count > 0
                        ? new CopyState(StatusStage.Ready, StatusReasonCode.Upgrading, Progress: Progress(copy.Queue[0], c, copy), Since: visible.DateCreated, Row: copy.Queue[0])
                        : new CopyState(StatusStage.Ready, StatusReasonCode.Ready, Since: visible.DateCreated);
                }
                else if (stub)
                {
                    state = MovieFromArr(copy, c, facts.Request);
                }
                else if ((matched.FirstOrDefault(m => !m.Visible) ?? MayOwn(arrCopy, jf, siblings, owned).FirstOrDefault(m => !m.Visible)) is { } hidden)
                {
                    // Its copy is one the viewer can't open, or may be (which copy is whose can't be told and one of them is
                    // hidden): never theirs to follow (nor "nobody's"), its downloads never shown to them.
                    state = new CopyState(StatusStage.NotHere, StatusReasonCode.NotVisibleToUser, Since: hidden.DateCreated);
                }
                else
                {
                    // Not in Jellyfin, or only in a copy they open that doesn't play the edition asked for: where its Radarr is.
                    state = MovieFromArr(copy, c, facts.Request);
                }
                variants.Add((copy, state, stub ? own : visible ?? matched.FirstOrDefault(m => !m.Visible) ?? matched.FirstOrDefault()));
            }

            // The headline: the item asked for is ready by definition (the viewer opened it) when Jellyfin plays it; on the key
            // path, the best copy the viewer could open (4K copies only when their item is visible).
            CopyState headline;
            ArrCopyRead? headlineCopy = null;
            if (item != null)
            {
                var ownVariant = variants.FirstOrDefault(v => v.Jf?.ItemId == item.ItemId);
                if (ownVariant.Copy != null)
                {
                    headline = ownVariant.State;
                    headlineCopy = ownVariant.Copy;
                }
                else
                {
                    headline = EditionAvailability.Plays(item) ? new CopyState(StatusStage.Ready, StatusReasonCode.Ready, Since: item.DateCreated) : NothingKnown(facts);
                }
            }
            else if (jf.Any(x => x.Visible && Qualifies(x)))
            {
                var best = variants.Where(v => v.State.Stage == StatusStage.Ready).Select(v => (v.Copy, v.State)).FirstOrDefault();
                headline = best.State ?? new CopyState(StatusStage.Ready, StatusReasonCode.Ready, Since: jf.First(x => x.Visible && Qualifies(x)).DateCreated);
                headlineCopy = best.Copy;
            }
            else
            {
                // Jellyfin has it (in the edition asked for) only in libraries a family member can't open: the copies that are
                // (or may be) those hidden items are left out, so the answer is the one they would get if the hidden copies
                // didn't exist (a title nobody has, when nothing else is left).
                var hiddenCopies = !c.Viewer.IsAdmin && jf.Any(x => !x.Visible);
                var eligible = variants.Where(v => c.Viewer.IsAdmin || ((followEveryRole || FamilyMayFollow(v.Copy, v.State)) && !(hiddenCopies && MayBeHiddenCopy(v.Copy, v.State, c)))).ToList();
                if (eligible.Count > 0)
                {
                    var best = eligible.OrderByDescending(v => v.State.Rank).ThenBy(v => RoleOrder(v.Copy.Instance.Role)).First();
                    headline = best.State;
                    headlineCopy = best.Copy;
                }
                else
                {
                    headline = NothingKnown(facts);
                }
            }
            headline = ApplyRequest(headline, facts.Request, c, facts);

            var recent = headline.Stage == StatusStage.Ready && headlineCopy != null && RecentImport(headlineCopy, c) != null;
            var familyQuiet = headline.Stage == StatusStage.Ready && headline.Reason == StatusReasonCode.Ready && !recent
                || headline.Stage == StatusStage.None;
            var admin = c.Viewer.IsAdmin ? WithTitleHandoff(AdminFor(facts, variants, null), headline, facts, c) : null;
            var adminQuiet = familyQuiet && (admin == null || admin.Variants.All(v => v.Stage == StatusStage.Ready && !v.Attention && v.Reason.Code == StatusReasonCode.Ready));

            return new TitleStatus
            {
                Key = facts.Key.ToString(),
                ItemId = item?.ItemId.ToString("N", CultureInfo.InvariantCulture),
                Kind = "movie",
                Stage = headline.Stage,
                Reason = Reason(headline),
                Attention = headline.Attention,
                Quiet = c.Viewer.IsAdmin ? adminQuiet : familyQuiet,
                Progress = headline.Progress,
                NextDate = headline.Date,
                NextDay = headline.Day,
                Journey = detail ? MovieJourney(headline, headlineCopy, item, jf.Where(Qualifies).ToList(), facts.Request, c) : null,
                Admin = admin,
            };
        }

        /// <summary>
        /// A movie copy that is, or may be, a Jellyfin copy the viewer can't open: matched to one, or
        /// unmatched while it has a file or a recent import.
        /// </summary>
        private static bool MayBeHiddenCopy(ArrCopyRead copy, CopyState state, ComposeContext c)
            => state.Reason == StatusReasonCode.NotVisibleToUser || copy.Movie!.HasFile || RecentImport(copy, c, TimeSpan.FromDays(30)) != null;

        /// <summary>
        /// A movie copy that is not (visibly) in Jellyfin: where the arr has got to. A request that went
        /// out for it (<paramref name="request"/>) restarts the "still looking" clock.
        /// </summary>
        internal static CopyState MovieFromArr(ArrCopyRead copy, ComposeContext c, RequestFacts? request = null)
        {
            var movie = copy.Movie!;
            if (copy.Queue.Count > 0) return FromQueue(BestRow(copy.Queue), c, copy);
            var imported = RecentImport(copy, c, TimeSpan.FromDays(30));
            if (movie.HasFile || imported != null)
                return new CopyState(StatusStage.AlmostReady, StatusReasonCode.LibraryPending, Since: imported);
            // With the downloads unknown, a past failure or departure no longer says where it is now.
            if (!copy.QueueUnknown && RecentFailure(copy.History, null, c) is DateTime failedAt)
                return new CopyState(StatusStage.Looking, StatusReasonCode.Failed, Attention: true, Since: failedAt);
            if (!copy.QueueUnknown && Departed(copy, movie.Id, null, copy.LibraryLoadedAt) is DateTime left)
                return new CopyState(StatusStage.AlmostReady, StatusReasonCode.Importing, Since: left);
            if (!movie.Monitored) return new CopyState(StatusStage.NotHere, StatusReasonCode.Unmonitored);
            if (!movie.IsAvailable)
            {
                // Radarr's cinema, digital and physical releases are calendar days (midnight UTC on
                // the wire): one still ahead somewhere (see DayStillAhead) stays the date to show.
                var future = new[] { movie.DigitalRelease, movie.PhysicalRelease }.Where(d => d.HasValue && DayStillAhead(d.Value, c.Now)).Select(d => d!.Value).OrderBy(d => d).FirstOrDefault();
                var cinema = Valid(movie.InCinemas);
                if (cinema.HasValue && !DayStillAhead(cinema.Value, c.Now))
                    return new CopyState(StatusStage.NotOut, StatusReasonCode.InCinemas, Date: future == default ? null : future, DateIsDay: true);
                var date = cinema.HasValue && DayStillAhead(cinema.Value, c.Now) ? cinema : (future == default ? null : future);
                return new CopyState(StatusStage.NotOut, StatusReasonCode.NotReleased, Date: date, DateIsDay: true);
            }
            if (copy.QueueUnknown) return Unknown();
            var sent = SentFor(request, copy, null, null, c);
            var since = Latest(Latest(Valid(movie.Added), Valid(movie.DigitalRelease) is DateTime d && d <= c.Now ? d : null), sent);
            return Looking(since, c, movie.LastSearchTime, sent.HasValue);
        }

        // ------------------------------------------------------------------ titles that aren't in the library

        /// <summary>
        /// A series page of a title no Sonarr holds (the native details page of an absent title): the
        /// series status by key (asked, OK'd, declined or not here) with one entry per season from public
        /// metadata, so the page can offer "Get Season N". An aired season reads where the asks that
        /// cover that whole season have got to (asked, OK'd, declined), else not here, so a season
        /// already asked for isn't offered again. Nothing is counted as missing or ready: the seasons
        /// are simply not here, and no page id stands for a copy.
        /// </summary>
        /// <param name="facts">Facts of the series (requests applied).</param>
        /// <param name="page">The absent page.</param>
        /// <param name="c">Context.</param>
        /// <param name="seasonRequests">The requests that cover a whole season, by season number (null: none known).</param>
        /// <returns>Status.</returns>
        public static TitleStatus AbsentSeries(TitleFacts facts, AbsentTitle page, ComposeContext c, Func<int, RequestFacts?>? seasonRequests = null)
        {
            using var __factsOperation3 = global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.BeginOperation();
            var state = ApplyRequest(NothingKnown(facts), facts.Request, c, facts);
            var seasons = page.Seasons.Where(s => s.Season > 0).OrderBy(s => s.Season).Select(s => new SeasonStatus
            {
                Season = s.Season,
                ItemId = Id(s.PageId),
                Stage = s.Aired > 0 ? ApplyRequest(NothingKnown(facts), seasonRequests?.Invoke(s.Season), c, facts).Stage : StatusStage.NotOut,
                Summary = new StatusSummary { Aired = s.Aired },
            }).ToList();
            var next = page.Seasons.Where(s => s.Season > 0 && s.Aired == 0 && s.AirDate is DateTime d && d > c.Now).OrderBy(s => s.Season).FirstOrDefault();
            return new TitleStatus
            {
                Key = facts.Key.ToString(),
                ItemId = Id(page.PageId),
                Kind = "series",
                Stage = state.Stage,
                Reason = Reason(state),
                Attention = state.Attention,
                Quiet = state.Stage == StatusStage.None,
                NextDate = next.Season > 0 ? next.AirDate : null,
                Seasons = seasons,
                Admin = c.Viewer.IsAdmin ? WithHandoff(AdminFor(facts, new List<(ArrCopyRead, CopyState, JfCopy?)>(), null), state) : null,
            };
        }

        /// <summary>
        /// A season page of a title no Sonarr holds: every episode from public metadata, aired ones not
        /// here (or where the asks for this whole season have got to), later ones not out yet (the next
        /// one with its date; a date-only air day counts as ahead while it is still that day somewhere,
        /// as on the Sonarr path). Episodes the page lists as rows (the viewer shows missing episodes)
        /// carry their row's page id; the others go to the banner. Asks for single episodes come from
        /// the season rows, and a request for other parts of the series never marks this season as asked.
        /// </summary>
        /// <param name="facts">Facts of the series.</param>
        /// <param name="page">The absent page.</param>
        /// <param name="request">Requests that cover this whole season, or null.</param>
        /// <param name="c">Context.</param>
        /// <returns>Status.</returns>
        public static TitleStatus AbsentSeason(TitleFacts facts, AbsentTitle page, RequestFacts? request, ComposeContext c)
        {
            using var __factsOperation4 = global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.BeginOperation();
            var season = page.Season ?? 0;
            var down = ApplyRequest(NothingKnown(facts), request, c, facts);
            var list = new List<EpisodeStatus>();
            var aired = 0;
            DateTime? nextAir = null;
            int? nextEpisode = null;
            foreach (var e in page.Episodes.Where(e => e.Season == season).OrderBy(e => e.Episode))
            {
                var out_ = e.AirDate is DateTime d && !NotYet(d, isDay: true, c.Now);
                if (out_) aired++;
                else if (e.AirDate is DateTime future && (nextAir == null || future < nextAir))
                {
                    nextAir = future;
                    nextEpisode = e.Episode;
                }

                var state = out_ ? down : new CopyState(StatusStage.NotOut, StatusReasonCode.NotAired, Date: e.AirDate, DateIsDay: true);
                list.Add(new EpisodeStatus
                {
                    Key = facts.Key.WithEpisode(season, e.Episode).ToString(),
                    Season = season,
                    Episode = e.Episode,
                    ItemId = page.Rows ? Id(e.PageId) : null,
                    Row = page.Rows,
                    Stage = state.Stage,
                    Reason = Reason(state),
                    AirDate = e.AirDate,
                });
            }

            var stage = aired > 0 ? down.Stage : StatusStage.NotOut;
            return new TitleStatus
            {
                Key = facts.Key.WithSeason(season).ToString(),
                ItemId = Id(page.PageId),
                Kind = "season",
                Stage = stage,
                Reason = aired > 0 ? Reason(down) : new StatusReason { Code = StatusReasonCode.NotAired },
                Attention = aired > 0 && down.Attention,
                Quiet = stage == StatusStage.None,
                NextDate = nextAir,
                NextDay = nextAir is DateTime day ? DayOf(day) : null,
                Summary = new StatusSummary { Aired = aired, NextAir = nextAir, NextAirIsDay = nextAir != null, NextEpisode = nextEpisode },
                Episodes = list,
                Admin = c.Viewer.IsAdmin ? AdminFor(facts, new List<(ArrCopyRead, CopyState, JfCopy?)>(), null) : null,
            };
        }

        /// <summary>
        /// An episode page of a title no Sonarr holds: not out yet (with its air date) until it airs, as
        /// in its season's rows (a date-only air day is ahead while it is still that day somewhere); after that not here, or where the asks that cover this episode (the
        /// episode itself, or a season that holds it) have got to. A request for other parts of the
        /// series never marks this episode as asked.
        /// </summary>
        /// <param name="facts">Facts of the series.</param>
        /// <param name="page">The absent page.</param>
        /// <param name="item">The page as an item reference (virtual).</param>
        /// <param name="request">Requests that cover this episode, or null.</param>
        /// <param name="c">Context.</param>
        /// <returns>Status.</returns>
        public static TitleStatus AbsentEpisode(TitleFacts facts, AbsentTitle page, JfItemRef item, RequestFacts? request, ComposeContext c)
        {
            using var __factsOperation5 = global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.BeginOperation();
            var season = page.Season ?? 0;
            var number = page.Episode ?? 0;
            var air = page.Episodes.FirstOrDefault(e => e.Season == season && e.Episode == number).AirDate;
            var state = air is DateTime d && !NotYet(d, isDay: true, c.Now)
                ? ApplyRequest(NothingKnown(facts), request, c, facts)
                : new CopyState(StatusStage.NotOut, StatusReasonCode.NotAired, Date: air, DateIsDay: air != null);
            return new TitleStatus
            {
                Key = facts.Key.WithEpisode(season, number).ToString(),
                ItemId = Id(page.PageId),
                Kind = "episode",
                Stage = state.Stage,
                Reason = Reason(state),
                Attention = state.Attention,
                Quiet = state.Stage == StatusStage.None && !(c.Viewer.IsAdmin && state.Attention),
                NextDate = state.Date,
                NextDay = state.Day,
                Journey = EpisodeJourney(state, null, season, number, null, item, c),
                Admin = c.Viewer.IsAdmin ? AdminFor(facts, new List<(ArrCopyRead, CopyState, JfCopy?)>(), null) : null,
            };
        }

        /// <summary>
        /// Spoiler Guard's air-date switch on an absent season or episode page (the page's episode list
        /// names no air dates): takes every air date out of its status, in place. The episodes' and the
        /// next episode's dates, the "airs" date of a reason, and the "looking since it aired" stop of an
        /// episode's journey go; stages stay (an episode not out yet still reads "not aired yet").
        /// </summary>
        /// <param name="status">A freshly composed season or episode status.</param>
        internal static void WithoutAirDates(TitleStatus status)
        {
            status.NextDate = null;
            status.NextDay = null;
            status.Reason = WithoutDate(status.Reason);
            if (status.Summary != null) status.Summary.NextAir = null;
            foreach (var episode in status.Episodes ?? Array.Empty<EpisodeStatus>())
            {
                episode.AirDate = null;
                episode.Reason = WithoutDate(episode.Reason);
            }

            // An episode's Looking stop is reached when it aired.
            if (status.Kind == "episode")
            {
                foreach (var stop in status.Journey ?? Array.Empty<JourneyStop>())
                {
                    if (stop.Stage == StatusStage.Looking) stop.At = null;
                }
            }
        }

        private static StatusReason WithoutDate(StatusReason reason)
        {
            if (reason.Params == null || !reason.Params.ContainsKey("date")) return reason;
            var rest = reason.Params.Where(p => p.Key != "date").ToDictionary(p => p.Key, p => p.Value);
            return new StatusReason { Code = reason.Code, Params = rest.Count > 0 ? rest : null };
        }

        // ------------------------------------------------------------------ series, seasons, episodes

        /// <summary>A series page (or card): per-season summary and the series pill.</summary>
        public static TitleStatus Series(TitleFacts facts, JfItemRef item, IReadOnlyList<JfEpisode>? jfEpisodes, IReadOnlyList<JfSeason>? jfSeasons, ComposeContext c, bool detail, IReadOnlyList<JfCopy>? copies = null, Guid? page = null)
        {
            using var __factsOperation6 = global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.BeginOperation();
            var (visibleEpisodes, pageHidden) = SplitHidden(jfEpisodes, jfSeasons);
            jfEpisodes = visibleEpisodes;
            var copy = PageRead(facts, page, copies, item, c, pageHidden);
            if (copy == null)
            {
                var none = ApplyRequest(NothingKnown(facts), facts.Request, c, facts);
                var hasEpisodes = jfEpisodes?.Any(EditionAvailability.Plays) == true;
                return new TitleStatus
                {
                    Key = facts.Key.ToString(),
                    ItemId = Id(item.ItemId),
                    Kind = "series",
                    Stage = hasEpisodes ? StatusStage.Ready : none.Stage,
                    Reason = Reason(none),
                    Quiet = !none.Attention || hasEpisodes,
                    Attention = none.Attention && !hasEpisodes,
                    Admin = c.Viewer.IsAdmin ? WithHandoff(AdminFor(facts, new List<(ArrCopyRead, CopyState, JfCopy?)>(), null), none) : null,
                };
            }

            var seasons = SeasonNumbers(copy, jfEpisodes).Where(s => s > 0 && !copy.Mask.Seasons.Contains(s)).ToList();
            var perSeason = new List<SeasonStatus>();
            var all = new List<(int Season, CopyState State, ArrEpisodeEntry? Arr, int Episode)>();
            foreach (var s in seasons)
            {
                var episodes = EpisodeStates(copy, s, jfEpisodes, c, facts.Request);
                all.AddRange(episodes.Select(e => (s, e.State, e.Arr, e.Episode)));
                var summary = copy.Episodes != null ? Summarize(episodes.Select(e => (e.State, e.Arr, s, e.Episode)).ToList(), c) : SeasonFromStats(copy, s, jfEpisodes, c);
                perSeason.Add(new SeasonStatus
                {
                    Season = s,
                    ItemId = jfSeasons?.FirstOrDefault(x => x.Season == s && !x.Hidden) is { } js ? Id(js.ItemId) : null,
                    Stage = SummaryStage(summary),
                    Summary = summary,
                });
            }

            var total = copy.Episodes != null
                ? Summarize(all.Select(e => (e.State, e.Arr, e.Season, e.Episode)).ToList(), c)
                : Combine(perSeason.Select(p => p.Summary).ToList());
            total = new StatusSummary
            {
                Aired = total.Aired,
                Ready = total.Ready,
                Downloading = total.Downloading,
                AlmostReady = total.AlmostReady,
                Missing = total.Missing,
                Unknown = total.Unknown,
                Attention = total.Attention,
                LongMissing = total.LongMissing,
                LongMissingSince = total.LongMissingSince,
                LongMissingSent = total.LongMissingSent,
                NextAir = total.NextAir ?? (copy.Series!.NextAiring is DateTime n && n > c.Now ? n : null),
                NextAirIsDay = total.NextAir.HasValue && total.NextAirIsDay,
                NextSeason = total.NextSeason,
                NextEpisode = total.NextEpisode,
                ReadySeasons = perSeason.Where(p => p.Summary.Aired > 0 && p.Summary.Ready >= p.Summary.Aired && p.Summary.Missing == 0).Select(p => p.Season).ToList(),
            };
            var stage = SummaryStage(total);
            var progress = all.Where(e => e.State.Stage == StatusStage.Downloading && e.State.Progress != null).Select(e => e.State.Progress!).ToList();
            var quiet = total.Downloading == 0 && total.AlmostReady == 0 && total.Attention == 0 && total.Missing == 0
                && !(total.NextAir is DateTime next && next - c.Now <= UpcomingShownWithin);
            AdminStatus? admin = null;
            var otherProblems = false;
            if (c.Viewer.IsAdmin)
            {
                var variants = new List<(ArrCopyRead, CopyState, JfCopy?)> { (copy, Overall(stage, total), null) };
                var problems = all.Where(e => e.State.Attention).Select(e => (copy, e.Season, e.Episode, e.State)).ToList();
                otherProblems = AddOtherSeriesCopies(facts, copy.Facts, BindingsOf(facts, copies, c), null, null, c, variants, problems);
                admin = WithTitleHandoff(AdminFor(facts, variants, problems), Overall(stage, total), facts, c);
            }
            return new TitleStatus
            {
                Key = facts.Key.ToString(),
                ItemId = Id(item.ItemId),
                Kind = "series",
                Stage = stage,
                Reason = Reason(Overall(stage, total)),
                Attention = total.Attention > 0 || otherProblems,
                Quiet = quiet && !otherProblems && (!c.Viewer.IsAdmin || facts.Unreadable.Count == 0),
                Progress = progress.Count == 1 ? progress[0] : null,
                NextDate = total.NextAir,
                NextDay = total.NextAirIsDay && total.NextAir is DateTime day ? DayOf(day) : null,
                Summary = total,
                Seasons = detail ? perSeason : null,
                Admin = admin,
            };
        }

        /// <summary>
        /// A season page (or card): summary, and with <paramref name="detail"/> every episode. <paramref name="series"/> is
        /// its series item as the viewer opens it now (null when they can't), see <see cref="SeriesCopyFor"/>.
        /// </summary>
        public static TitleStatus Season(TitleFacts facts, JfItemRef item, IReadOnlyList<JfEpisode>? jfEpisodes, ComposeContext c, bool detail, IReadOnlyList<JfCopy>? copies = null, Guid? page = null, JfItemRef? series = null, Func<EpisodeCoverage>? elsewhere = null, RequestFacts? request = null)
        {
            using var __factsOperation8 = global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.BeginOperation();
            var (visibleEpisodes, pageHidden) = SplitHidden(jfEpisodes, null);
            jfEpisodes = visibleEpisodes;
            var season = item.Season ?? 0;
            var key = facts.Key.WithSeason(season).ToString();
            var copy = PageRead(facts, page, copies, series, c, pageHidden);
            if (copy == null)
            {
                return new TitleStatus
                {
                    Key = key,
                    ItemId = Id(item.ItemId),
                    Kind = "season",
                    Stage = StatusStage.None,
                    Reason = Reason(NothingKnown(facts)),
                    Quiet = true,
                    Admin = c.Viewer.IsAdmin ? AdminFor(facts, new List<(ArrCopyRead, CopyState, JfCopy?)>(), null) : null,
                };
            }
            var episodes = EpisodeStates(copy, season, jfEpisodes, c, facts.Request);
            var summary = copy.Episodes != null ? Summarize(episodes.Select(e => (e.State, e.Arr, season, e.Episode)).ToList(), c) : SeasonFromStats(copy, season, jfEpisodes, c);
            var stage = SummaryStage(summary);
            var progress = episodes.Where(e => e.State.Stage == StatusStage.Downloading && e.State.Progress != null).Select(e => e.State.Progress!).ToList();
            List<EpisodeStatus>? list = null;
            if (detail)
            {
                // A gap of this copy's Sonarr that another copy the viewer can open plays is this copy's gap, never the
                // title's (D53, edition round 14): it names the copy. Those copies are read only when there is a gap.
                var plays = episodes.Any(e => IsGap(e.State)) ? elsewhere?.Invoke() : null;
                list = episodes.Select(e => new EpisodeStatus
                {
                    CopyGap = plays != null && IsGap(e.State) && plays.Contains((season, e.Episode)) ? copy.Instance.Role : null,
                    Key = facts.Key.WithEpisode(season, e.Episode).ToString(),
                    Season = season,
                    Episode = e.Episode,
                    ItemId = e.Row is { } row ? Id(row.ItemId) : null,
                    Row = e.Row != null,
                    Stage = e.State.Stage,
                    Reason = Reason(e.State),
                    Attention = e.State.Attention,
                    Progress = e.State.Progress,
                    AirDate = e.Arr?.AirDateUtc,
                }).ToList();
            }
            // The copy those gaps belong to, which every copy-qualified control acts on (D53, edition round 15: one binding
            // decides wording and action; the service says where its asks and Searches land), and the summary counts them as
            // the rows name them.
            CopyBinding? bound = null;
            if (list != null && list.Any(e => e.CopyGap != null))
            {
                bound = new CopyBinding { Role = copy.Instance.Role, InstanceId = copy.Instance.Id };
                summary.MissingInCopy = episodes.Zip(list).Count(x => x.Second.CopyGap != null && IsLongMissing(x.First.State));
            }
            var headline = Overall(stage, summary);
            if (request != null && stage == StatusStage.None)
            {
                // Nothing of the season monitored, queued or here, but an ask covers it (waiting for an OK, or OK'd and not
                // handed over yet): the ask says where it is, as on the Requests page, not "not fetched".
                var asked = ApplyRequest(new CopyState(StatusStage.NotHere, StatusReasonCode.Unmonitored), request, c, facts);
                if (asked.Stage != StatusStage.NotHere)
                {
                    stage = asked.Stage;
                    headline = asked;
                }
            }

            var quiet = summary.Downloading == 0 && summary.AlmostReady == 0 && summary.Attention == 0 && summary.Missing == 0
                && !(summary.NextAir is DateTime next && next - c.Now <= UpcomingShownWithin);
            AdminStatus? admin = null;
            var otherProblems = false;
            if (c.Viewer.IsAdmin)
            {
                var variants = new List<(ArrCopyRead, CopyState, JfCopy?)> { (copy, Overall(stage, summary), null) };
                var problems = episodes.Where(e => e.State.Attention).Select(e => (copy, season, e.Episode, e.State)).ToList();
                otherProblems = AddOtherSeriesCopies(facts, copy.Facts, BindingsOf(facts, copies, c), season, null, c, variants, problems);
                admin = AdminFor(facts, variants, problems);
            }
            return new TitleStatus
            {
                Key = key,
                ItemId = Id(item.ItemId),
                Kind = "season",
                Stage = stage,
                Reason = Reason(headline),
                Attention = summary.Attention > 0 || otherProblems,
                Quiet = quiet && !otherProblems,
                Progress = progress.Count == 1 ? progress[0] : null,
                NextDate = summary.NextAir,
                NextDay = summary.NextAirIsDay && summary.NextAir is DateTime day ? DayOf(day) : null,
                Summary = summary,
                Episodes = list,
                Copy = bound,
                Admin = admin,
            };
        }

        /// <summary>
        /// An episode page (or card); a virtual episode or a placeholder (<see cref="JfItemRef.Playable"/>) shows where the arr has got to. <paramref name="series"/> is its
        /// series item as the viewer opens it now (null when they can't), see <see cref="SeriesCopyFor"/>.
        /// </summary>
        public static TitleStatus Episode(TitleFacts facts, JfItemRef item, ComposeContext c, bool detail, IReadOnlyList<JfCopy>? copies = null, Guid? page = null, JfItemRef? series = null)
        {
            using var __factsOperation9 = global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.BeginOperation();
            var season = item.Season ?? 0;
            var number = item.Episode ?? 0;
            var copy = PageRead(facts, page, copies, series, c, HiddenParts.None);
            // An episode its binding's own copy hides from the viewer: that Sonarr tells them nothing of it.
            if (copy?.Mask.Hides(season, number) == true) copy = null;
            CopyState state;
            ArrEpisodeEntry? arr = null;
            // One item reference carries every fact (D53, edition round 16): a stub Jellyfin lists reads where its arr has
            // got to, as its season row does; only an episode Jellyfin plays is Ready (and a download of it an upgrade).
            if (EditionAvailability.Plays(item))
            {
                arr = copy?.Episodes?.Find(season, number);
                state = (copy == null ? null : QueuedEpisode(copy, RowsFor(copy, season, number, arr), have: true, item.DateCreated, c))
                    ?? new CopyState(StatusStage.Ready, StatusReasonCode.Ready, Since: item.DateCreated);
            }
            else if (copy == null)
            {
                state = NothingKnown(facts);
            }
            else
            {
                arr = copy.Episodes?.Find(season, number);
                state = EpisodeFromArr(copy, season, number, arr, c, facts.Request);
            }
            var recent = state.Stage == StatusStage.Ready && copy != null && RecentEpisodeImport(copy, season, number, arr, c) != null;
            var quiet = (state.Stage == StatusStage.Ready && state.Reason == StatusReasonCode.Ready && !recent) || state.Stage == StatusStage.None;
            AdminStatus? admin = null;
            var otherProblems = false;
            if (c.Viewer.IsAdmin)
            {
                var variants = new List<(ArrCopyRead, CopyState, JfCopy?)>();
                var problems = new List<(ArrCopyRead, int, int, CopyState)>();
                if (copy != null)
                {
                    variants.Add((copy, state, null));
                    otherProblems = AddOtherSeriesCopies(facts, copy.Facts, BindingsOf(facts, copies, c), season, number, c, variants, problems);
                }
                admin = AdminFor(facts, variants, problems);
            }
            return new TitleStatus
            {
                Key = facts.Key.WithEpisode(season, number).ToString(),
                ItemId = Id(item.ItemId),
                Kind = "episode",
                Stage = state.Stage,
                Reason = Reason(state),
                Attention = state.Attention || otherProblems,
                Quiet = quiet && !(c.Viewer.IsAdmin && (state.Attention || otherProblems)),
                Progress = state.Progress,
                NextDate = state.Date,
                NextDay = state.Day,
                Journey = detail ? EpisodeJourney(state, copy, season, number, arr, item, c) : null,
                Admin = admin,
            };
        }

        /// <summary>
        /// A series poster card: only what the queue says (downloading, almost ready, a problem), so a
        /// library page of series posters costs no per-series Sonarr episode reads. Quiet otherwise.
        /// Queue rows of episodes or seasons Jellyfin hides from the viewer (<paramref name="hidden"/>)
        /// don't count, and a row of an episode the viewer already plays is an upgrade, as on the pages
        /// (<see cref="QueuedEpisodes"/>; the item's episodes are read only when its Sonarr has downloads).
        /// The card is of one series copy (the item, among the title's Jellyfin <paramref name="copies"/>):
        /// it reads only the Sonarr that owns that copy for sure, as its pages do (<see cref="SeriesCopyFor"/>), and the
        /// item's own episodes and hidden parts (one read, <see cref="ComposeContext.HiddenOf"/>, unless
        /// <paramref name="hidden"/> gives them).
        /// </summary>
        public static TitleStatus SeriesCard(TitleFacts facts, JfItemRef item, ComposeContext c, HiddenParts? hidden = null, IReadOnlyList<JfCopy>? copies = null)
        {
            using var __factsOperation10 = global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.BeginOperation();
            // The card's own copy, its facts through what Jellyfin hides from the viewer there (read only when its queue has rows).
            var copy = SeriesCopyFor(facts, item.ItemId, copies, item)?.Through(() => hidden ?? c.HiddenOf?.Invoke(item.ItemId));
            var states = copy == null ? new List<(int Season, int Episode, CopyState State)>() : QueuedEpisodes(copy, copy.Facts.HasDownloads ? c.EpisodesOf?.Invoke(item.ItemId) : null, c);
            int Count(Func<CopyState, bool> f) => states.Count(x => f(x.State));
            var summary = new StatusSummary
            {
                Downloading = Count(s => s.Stage == StatusStage.Downloading),
                AlmostReady = Count(s => s.Stage == StatusStage.AlmostReady),
                Attention = Count(s => s.Attention),
            };
            var stage = summary.Downloading > 0 ? StatusStage.Downloading : summary.AlmostReady > 0 ? StatusStage.AlmostReady : StatusStage.Ready;
            var progress = states.Where(x => x.State.Stage == StatusStage.Downloading && x.State.Progress != null).Select(x => x.State.Progress!).ToList();
            AdminStatus? admin = null;
            var otherProblems = false;
            if (c.Viewer.IsAdmin && copy != null)
            {
                var problems = states.Where(x => x.State.Attention).Select(x => (copy, x.Season, x.Episode, x.State)).ToList();
                var bindings = BindingsOf(facts, copies, c);
                // Other instances (4K, anime): their problems only, as the card reads no Sonarr episodes; each by its own copy's files.
                foreach (var other in OtherSeriesCopies(facts, copy.Facts))
                {
                    var bound = BindingOf(bindings, other);
                    var found = QueueProblems(bound.Read(c), FilesOf(bound, c), null, null, c);
                    otherProblems |= found.Count > 0;
                    problems.AddRange(found);
                }
                admin = AdminFor(facts, new List<(ArrCopyRead, CopyState, JfCopy?)>(), problems);
            }
            return new TitleStatus
            {
                Key = facts.Key.ToString(),
                ItemId = Id(item.ItemId),
                Kind = "series",
                Stage = stage,
                Reason = new StatusReason { Code = stage == StatusStage.Ready ? StatusReasonCode.Ready : SummaryReason(summary) },
                Attention = summary.Attention > 0 || otherProblems,
                // Upgrades only: Ready, as the series page says.
                Quiet = states.All(x => IsUpgrade(x.State)) && !otherProblems,
                Progress = progress.Count == 1 ? progress[0] : null,
                Summary = summary,
                Admin = admin,
            };
        }

        /// <summary>
        /// A series asked for by key (no Jellyfin item given): the viewer's headline binding (<see cref="SeriesHeadline"/>),
        /// read through the copy it is bound to only: its files tell upgrades from downloads, and queue rows of episodes or
        /// seasons Jellyfin hides from the viewer in that copy (<paramref name="hidden"/> when given, else
        /// <see cref="ComposeContext.HiddenOf"/>) don't count. Admins also get a line per Sonarr, each through its own binding.
        /// </summary>
        public static TitleStatus SeriesByKey(TitleFacts facts, IReadOnlyList<JfCopy> copies, ComposeContext c, HiddenParts? hidden = null)
        {
            using var __factsOperation11 = global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.BeginOperation();
            var visible = copies.Any(x => x.Visible);
            // In the library only when a copy the viewer opens plays an episode (D53, edition round 19 part B: the one
            // availability predicate, <see cref="ComposeContext.Holds"/>; not known: none does). A copy that lists only
            // placeholders or missing episodes reads where its Sonarr has got to.
            var plays = copies.Any(x => x.Visible && c.Holds?.Invoke(x.ItemId) == true);
            var bindings = SeriesBindings(facts, copies, c);
            var bound = Headline(bindings);
            var state = bound == null
                ? (plays ? new CopyState(StatusStage.Ready, StatusReasonCode.Ready) : NothingKnown(facts))
                : SeriesCopyState(bound.Read(c, hidden), plays, c, facts.Request, FilesOf(bound, c));
            if (!visible && copies.Count > 0 && c.Viewer.IsAdmin && state.Stage == StatusStage.AlmostReady)
            {
                // An admin is told why.
                state = new CopyState(StatusStage.NotHere, StatusReasonCode.NotVisibleToUser);
            }
            state = ApplyRequest(state, facts.Request, c, facts);
            AdminStatus? admin = null;
            if (c.Viewer.IsAdmin)
            {
                var variants = new List<(ArrCopyRead, CopyState, JfCopy?)>();
                var problems = new List<(ArrCopyRead, int, int, CopyState)>();
                // An administrator's headline is the primary Sonarr copy (every Sonarr copy is bound for them).
                if (bound != null)
                {
                    variants.Add((bound.Read(c), state, bound.Jf));
                    AddOtherSeriesCopies(facts, bound.Copy, bindings, null, null, c, variants, problems);
                }
                admin = WithTitleHandoff(AdminFor(facts, variants, problems), state, facts, c);
            }
            return new TitleStatus
            {
                Key = facts.Key.ToString(),
                Kind = "series",
                Stage = state.Stage,
                Reason = Reason(state),
                Attention = state.Attention,
                Quiet = state.Stage is StatusStage.Ready or StatusStage.None && !state.Attention,
                Progress = state.Progress,
                NextDate = state.Date,
                NextDay = state.Day,
                Admin = admin,
            };
        }

        /// <summary>
        /// Every Sonarr copy of the series that may tell the viewer anything, each bound once to the Jellyfin copy it owns
        /// (D53, edition round 12: one binding per viewer, title and instance; every summarizer reads these). A Sonarr copy
        /// owns a Jellyfin copy whose folder is exactly its own (<see cref="HoldsFolder"/>: its mapped folder, else the same
        /// path), or one the pages' rules give it (<see cref="SeriesCopyFor"/>); Jellyfin listing two items for one folder
        /// (one folder in two libraries) gives the same files either way. In the title's copy order:
        /// <list type="number">
        /// <item><description>it owns a copy the viewer can open now: bound to that copy;</description></item>
        /// <item><description>for an administrator, always (bound to the copy it owns, if one can be told, else none: its
        /// line then reads the Sonarr's own view, with no files);</description></item>
        /// <item><description>for anyone else, unbound (Jellyfin has no copy of it) only when every copy of the title is
        /// known (a finished lookup), it owns none of them, none of them may be its own (a copy no Sonarr owns that its
        /// linked library or path mapping doesn't leave out) and, when the viewer can't open some copy, it has no file and
        /// no recent import (it may be that copy, not yet matched);</description></item>
        /// <item><description>otherwise none: a Sonarr copy that owns, or may own, a copy the viewer can't open contributes
        /// nothing, and no other copy's files, hidden parts or queue stand in for it.</description></item>
        /// </list>
        /// </summary>
        internal static List<SeriesBinding> SeriesBindings(TitleFacts facts, IReadOnlyList<JfCopy>? copies, ComposeContext c)
        {
            var result = new List<SeriesBinding>();
            var siblings = SeriesCopies(facts);
            if (siblings.Count == 0) return result;
            var (known, every) = OwnershipBasis(facts, copies);
            var distinct = known.DistinctBy(x => x.ItemId).ToList();
            // Each known copy's owner by the pages' rules, judged once.
            var owners = distinct.ToDictionary(x => x.ItemId, x => SeriesCopyFor(facts, x.ItemId, copies));
            var hiddenCopies = distinct.Any(x => !x.Visible);
            foreach (var copy in siblings)
            {
                var owned = distinct.Where(x => HoldsFolder(copy, x.Path) || ReferenceEquals(owners[x.ItemId], copy)).ToList();
                if (owned.FirstOrDefault(x => x.Visible) is { } open)
                {
                    result.Add(new SeriesBinding(copy, open));
                    continue;
                }
                if (c.Viewer.IsAdmin)
                {
                    result.Add(new SeriesBinding(copy, owned.FirstOrDefault()));
                    continue;
                }
                if (owned.Count > 0 || !every) continue;
                if (distinct.Any(x => owners[x.ItemId] == null && !Leaves(copy, x, distinct))) continue;
                if (hiddenCopies && copy.MayHoldFiles(c.Now)) continue;
                result.Add(new SeriesBinding(copy, null));
            }
            return result;
        }

        /// <summary>The bindings of the title's Sonarr copies an administrator's lines read (null: the copies aren't known).</summary>
        private static List<SeriesBinding>? BindingsOf(TitleFacts facts, IReadOnlyList<JfCopy>? copies, ComposeContext c)
            => copies == null || !c.Viewer.IsAdmin ? null : SeriesBindings(facts, copies, c);

        /// <summary>The binding of one Sonarr copy among <paramref name="bindings"/>; with none known, the Sonarr's own view (no copy, no files).</summary>
        private static SeriesBinding BindingOf(IReadOnlyList<SeriesBinding>? bindings, ArrCopyFacts copy)
            => bindings?.FirstOrDefault(b => ReferenceEquals(b.Copy, copy)) ?? new SeriesBinding(copy, null);

        /// <summary>
        /// The binding a series read for the whole title follows (by key, a requested part, an absent title's page): of the
        /// Sonarr copies bound for the viewer, the first by role (standard, anime, custom, 4K), as the primary copy is chosen.
        /// </summary>
        private static SeriesBinding? Headline(IReadOnlyList<SeriesBinding> bindings)
            => bindings.OrderBy(b => RoleOrder(b.Copy.Instance.Role)).FirstOrDefault();

        /// <summary>The headline binding of a title for the viewer (<see cref="Headline"/> of <see cref="SeriesBindings"/>).</summary>
        internal static SeriesBinding? SeriesHeadline(TitleFacts facts, IReadOnlyList<JfCopy> copies, ComposeContext c)
            => Headline(SeriesBindings(facts, copies, c));

        /// <summary>
        /// The read of the Sonarr copy a series, season or episode status speaks for: a page's or card's own copy's
        /// (<see cref="SeriesCopyFor"/>; the caller's episodes are that copy's own folder, so <paramref name="pageHidden"/> is its
        /// mask), or, read for the whole title with its copies known (an absent title's page, a scope key), the viewer's headline
        /// binding's (<see cref="SeriesBinding.Read"/>), its own copy's mask and the page's (title-wide) markers together. Every
        /// fact of it has passed that mask (D53, edition rounds 13 and 14).
        /// </summary>
        private static ArrCopyRead? PageRead(TitleFacts facts, Guid? page, IReadOnlyList<JfCopy>? copies, JfItemRef? own, ComposeContext c, HiddenParts pageHidden)
        {
            if (page != null || copies == null) return SeriesCopyFor(facts, page, copies, own)?.Through(pageHidden);
            return Headline(SeriesBindings(facts, copies, c))?.Read(c, pageHidden);
        }

        /// <summary>The viewer's episodes of a binding's copy, for telling its upgrades from its downloads (read only when its queue has rows).</summary>
        private static IReadOnlyList<JfEpisode>? FilesOf(SeriesBinding binding, ComposeContext c)
            => binding.Open && binding.Copy.HasDownloads && c.EpisodesOf != null ? c.EpisodesOf(binding.Jf!.ItemId) : null;

        /// <summary>
        /// The seasons (and single episodes) a request asked for, by key (the Requests page): where those parts have got
        /// to rather than the whole series, so a request for a missing season of a series already in Jellyfin isn't
        /// "Ready". Ready only when every requested season is (Sonarr's monitored episodes of it all in Jellyfin, or,
        /// with no Sonarr copy, at least one of its episodes) and every requested episode is in Jellyfin; otherwise the
        /// parts still to come decide the stage, and the request facts fill in when no arr is working on them. Also
        /// returns when the newest of those episodes arrived. <paramref name="episodes"/> are single episodes asked for
        /// outside the requested seasons (their own state each, from Sonarr's episode list when it is in memory, else
        /// from the queue). <paramref name="series"/> is the whole-series status (its admin block is kept);
        /// <paramref name="copies"/> are the series' Jellyfin copies as the viewer sees them: the parts are read through the
        /// viewer's headline binding (<see cref="SeriesHeadline"/>, as <see cref="SeriesByKey"/>), so a Sonarr copy whose copy
        /// they can't open tells them nothing, and what Jellyfin hides from them in the bound copy goes in with the
        /// hidden markers of <paramref name="jfEpisodes"/> (numbers only; one a copy they can open plays stays theirs).
        /// </summary>
        public static (TitleStatus Status, DateTime? ArrivedAt) RequestedSeasons(TitleFacts facts, TitleStatus series, IReadOnlyList<int> seasons, IReadOnlyList<JfEpisode>? jfEpisodes, IReadOnlyList<JfCopy> copies, ComposeContext c, bool only4k = false, IReadOnlyList<(int Season, int Episode)>? episodes = null)
        {
            var bound = Headline(SeriesBindings(facts, copies, c));
            IReadOnlyList<JfSeason>? boundSeasons = null;
            if (bound is { Open: true } && c.HiddenOf != null && c.EpisodesOf != null)
            {
                jfEpisodes = (jfEpisodes ?? Array.Empty<JfEpisode>()).Concat(c.EpisodesOf(bound.Jf!.ItemId).Where(e => e.Hidden)).ToList();
                boundSeasons = c.FolderOf?.Invoke(bound.Jf!.ItemId).Seasons;
            }
            var (visibleEpisodes, hidden) = SplitHidden(jfEpisodes, boundSeasons);
            var wanted = new HashSet<int>(seasons);
            var all = visibleEpisodes ?? Array.Empty<JfEpisode>();
            var real = all.Where(e => EditionAvailability.Plays(e) && wanted.Contains(e.Season)).ToList();
            // Single episodes outside the requested seasons, with the Jellyfin episode that has each (if any).
            var picked = (episodes ?? Array.Empty<(int Season, int Episode)>()).Where(p => !wanted.Contains(p.Season)).Distinct()
                .Select(p => (Part: p, Have: all.FirstOrDefault(e => EditionAvailability.Plays(e) && e.Season == p.Season && new EpisodeRange(e.Episode, e.EpisodeEnd).Contains(p.Episode))))
                .ToList();
            var arrived = real.Select(e => e.DateCreated).Concat(picked.Where(p => p.Have != null).Select(p => p.Have!.DateCreated))
                .Where(d => d.HasValue).DefaultIfEmpty(null).Max();
            // The bound copy's facts through its own mask and the hidden markers: a part hidden there has no episode, no
            // statistics, no file count and no queue row (masked by construction, D53 edition round 14).
            var copy = bound?.Copy.Through(hidden);
            CopyState state;
            StatusSummary? summary = null;
            if (copy == null)
            {
                state = wanted.All(n => real.Any(e => e.Season == n)) && picked.All(p => p.Have != null)
                    ? new CopyState(StatusStage.Ready, StatusReasonCode.Ready, Since: arrived)
                    : ApplyRequest(NothingKnown(facts), facts.Request, c, facts);
            }
            else
            {
                // Per requested season: its episodes' states (when Sonarr's list is in memory) and their summary.
                var perStates = wanted.OrderBy(n => n).Select(n => copy.Episodes != null
                    ? EpisodeStates(copy, n, visibleEpisodes, c, facts.Request).Select(e => (e.State, e.Arr, Season: n, e.Episode)).ToList()
                    : null).ToList();
                var per = wanted.OrderBy(n => n).Select((n, i) => perStates[i] is { } states ? Summarize(states, c) : SeasonFromStats(copy, n, visibleEpisodes, c)).ToList();
                var singles = picked.Select(p =>
                {
                    // One the bound copy hides from the viewer (and no copy they open plays): its Sonarr says nothing of it
                    // (no entry, no queue row), so the request says where it is, as for a requested season they can't see.
                    var arr = copy.Episodes?.Find(p.Part.Season, p.Part.Episode);
                    var one = p.Have != null
                        ? new CopyState(StatusStage.Ready, StatusReasonCode.Ready, Since: p.Have.DateCreated)
                        : EpisodeFromArr(copy, p.Part.Season, p.Part.Episode, arr, c, facts.Request);
                    return (State: one, Arr: arr, p.Part.Season, p.Part.Episode);
                }).ToList();
                // A season asked for has arrived when every aired episode of it is here: one Sonarr doesn't monitor (yet:
                // Seerr hasn't OK'd the request, or someone unmonitored it) is still to come, not "not wanted".
                // A season whose statistics can't be vouched for (episodes hidden from the viewer, no episode list) is never
                // done on Sonarr's word: the request says where it is (D53, edition round 15).
                var order = wanted.OrderBy(n => n).ToList();
                var waiting = per.Where((x, i) => SummaryStage(x) != StatusStage.Ready || (x.Aired > 0 && x.Ready < x.Aired) || (perStates[i] == null && copy.Unvouched.Contains(order[i]))).ToList();
                var singlesDone = singles.All(x => x.State.Stage == StatusStage.Ready);
                if (!singlesDone) waiting.Add(Summarize(singles.Where(x => x.State.Stage != StatusStage.Ready).ToList(), c));
                if (waiting.Count == 0)
                {
                    summary = Combine(singles.Count > 0 ? per.Append(Summarize(singles, c)).ToList() : per);
                    state = new CopyState(StatusStage.Ready, StatusReasonCode.Ready, Since: arrived);
                }
                else
                {
                    summary = Combine(waiting);
                    var stage = SummaryStage(summary);
                    // One download among the parts asked for: its progress (a single episode asked for reads "Downloading 40%").
                    var downloads = perStates.Where(x => x != null).SelectMany(x => x!).Select(x => x.State).Concat(singles.Select(x => x.State))
                        .Where(x => x.Stage == StatusStage.Downloading && x.Progress != null).Select(x => x.Progress!).ToList();
                    state = stage is StatusStage.None or StatusStage.Ready
                        // Nothing monitored, queued or aired there yet: the request says where it is.
                        ? ApplyRequest(new CopyState(StatusStage.NotHere, StatusReasonCode.Unmonitored), facts.Request, c, facts)
                        : Overall(stage, summary) with
                        {
                            Attention = summary.Attention > 0,
                            Date = summary.NextAir,
                            DateIsDay = summary.NextAirIsDay,
                            Progress = stage == StatusStage.Downloading && downloads.Count == 1 ? downloads[0] : null,
                        };
                }
            }
            var status = new TitleStatus
            {
                Key = series.Key,
                Kind = "series",
                Stage = state.Stage,
                Reason = Reason(state),
                Attention = state.Attention,
                Quiet = state.Stage is StatusStage.Ready or StatusStage.None && !state.Attention,
                Progress = state.Progress,
                NextDate = state.Date,
                NextDay = state.Day,
                Summary = summary,
                Admin = WithHandoff(series.Admin, state, only4k),
            };
            return (status, state.Stage == StatusStage.Ready ? arrived : null);
        }

        /// <summary>
        /// A movie asked for in one edition, by key (the Requests page): Ready only when a copy the viewer can open
        /// holds a playable source of that edition (<paramref name="held"/>, from <see cref="EditionAvailability"/>),
        /// never because an arr of that edition holds the title or shares its folder; otherwise where that edition's
        /// arr copies have got to (4K: the 4K instances; standard: the others), followed by family members too. Also
        /// returns when the edition arrived (the newest qualifying source in <paramref name="hits"/>, else the newest
        /// held copy) and the copy Play opens. <paramref name="movie"/> is the whole-title status (its admin block is kept).
        /// </summary>
        /// <remarks>
        /// <paramref name="everyEdition"/>: a standard request any playable copy satisfies (a 4K one included): every
        /// Radarr's progress counts.
        /// </remarks>
        public static (TitleStatus Status, DateTime? ArrivedAt, JfCopy? Shown) RequestedEdition(TitleFacts facts, TitleStatus movie, IReadOnlyList<JfCopy> held, IReadOnlyList<EditionHit> hits, ComposeContext c, bool fourK, bool everyEdition = false, IReadOnlyList<JfCopy>? copies = null)
        {
            using var __factsOperation12 = global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.BeginOperation();
            // "No 4K Radarr has it" is judged on the edition's instances alone: a standard Radarr that can't be read
            // says nothing about the 4K copy (as the Overview's Needs attention list), and the other way round.
            var edition = everyEdition ? EveryEdition(facts) : fourK ? FourKOnly(facts) : StandardOnly(facts);
            edition.Copies.RemoveAll(x => x.Movie == null);
            var jf = held.Where(x => x.Visible).ToList();
            // What plays the edition (qualifying) and the evidence of whose copy is which (every copy, hidden ones included,
            // judged against every Radarr holding the title) go in apart (D53, edition round 19): a 4K copy the viewer can't
            // open keeps its Radarr copy its own, so that copy's download is never told to them.
            var scoped = Movie(edition, null, copies ?? jf, c, detail: false, followEveryRole: true,
                qualifying: jf.Select(x => x.ItemId).ToHashSet(), owners: facts.Copies.Where(x => x.Movie != null).ToList());
            var status = new TitleStatus
            {
                Key = movie.Key,
                Kind = "movie",
                Stage = scoped.Stage,
                Reason = scoped.Reason,
                Attention = scoped.Attention,
                Quiet = scoped.Quiet,
                Progress = scoped.Progress,
                NextDate = scoped.NextDate,
                NextDay = scoped.NextDay,
                // The whole title's admin block, with the "OK'd in Seerr, but no (4K) Radarr has it" line only when
                // that is why this request is flagged (never the whole title's own line).
                Admin = WithHandoff(movie.Admin, scoped.Reason.Code == StatusReasonCode.ApprovedNotInArr ? scoped.Admin?.ApprovedNotInArrSince : null, fourK),
            };
            DateTime? arrived = null;
            if (scoped.Stage == StatusStage.Ready)
            {
                arrived = hits.Count > 0
                    ? hits.Select(h => h.Source.DateCreated).Where(d => d.HasValue).DefaultIfEmpty(null).Max()
                    : jf.Select(x => x.DateCreated).Where(d => d.HasValue).DefaultIfEmpty(null).Max();
            }
            // The copy with the edition's source (Play opens it, never another edition's copy).
            return (status, arrived, jf.FirstOrDefault());
        }

        /// <summary>A movie asked for in 4K only (see <see cref="RequestedEdition"/>): <paramref name="held"/> are the copies with a 4K source.</summary>
        public static (TitleStatus Status, DateTime? ArrivedAt, JfCopy? Shown) Requested4k(TitleFacts facts, TitleStatus movie, IReadOnlyList<JfCopy> held, ComposeContext c)
            => RequestedEdition(facts, movie, held, Array.Empty<EditionHit>(), c, fourK: true);

        /// <summary>
        /// The part of a title a request asked for when no arr instance set up in Jellyfin Enhanced
        /// can say where it is (a 4K request with no 4K instance): the request alone. Ready only when
        /// Seerr says that variant is available (<paramref name="availableAt"/>: when it said so);
        /// otherwise waiting for an OK, OK'd or said no. Also returns when it arrived.
        /// <paramref name="whole"/> is the whole-title status (its key, kind and admin block are kept).
        /// </summary>
        public static (TitleStatus Status, DateTime? ArrivedAt) RequestedOnly(TitleStatus whole, RequestFacts? request, bool available, DateTime? availableAt, TitleFacts? facts = null)
        {
            var state = available
                ? new CopyState(StatusStage.Ready, StatusReasonCode.Ready, Since: availableAt)
                : ApplyRequest(new CopyState(StatusStage.NotHere, StatusReasonCode.NotInArr), request, facts: facts, admin: whole.Admin != null);
            var status = new TitleStatus
            {
                Key = whole.Key,
                Kind = whole.Kind,
                Stage = state.Stage,
                Reason = Reason(state),
                Attention = state.Attention,
                Quiet = state.Stage is StatusStage.Ready or StatusStage.None && !state.Attention,
                // The request alone can't be overdue here (nothing can say no arr has it): the whole
                // title's "no Sonarr/Radarr has it" line is about the other quality, so it goes.
                Admin = WithHandoff(whole.Admin, state),
            };
            return (status, available ? availableAt : null);
        }

        /// <summary>
        /// Where a series copy has got to as a whole (keys path, admin line); a request that went out restarts the "still
        /// looking" clock. Downloads of episodes the viewer already plays (<paramref name="files"/>, its Jellyfin copy's
        /// episodes) are upgrades, as on its pages: never this copy's download (only upgrades: Ready).
        /// </summary>
        internal static CopyState SeriesCopyState(ArrCopyRead copy, bool inJellyfin, ComposeContext c, RequestFacts? request = null, IReadOnlyList<JfEpisode>? files = null)
        {
            var downloads = QueuedEpisodes(copy, inJellyfin ? files : null, c).Where(x => !IsUpgrade(x.State)).Select(x => x.State).ToList();
            if (downloads.Count > 0)
            {
                // Each episode's state is its best row's (QueuedEpisode): the best of those is the copy's.
                var row = FromQueue(BestRow(downloads.Select(x => x.Row!).ToList()), c, copy);
                return downloads.Count > 1 ? row with { Progress = null, Params = Params(("count", downloads.Count.ToString(CultureInfo.InvariantCulture))) } : row;
            }
            if (inJellyfin) return new CopyState(StatusStage.Ready, StatusReasonCode.Ready);
            var series = copy.Series!;
            if (series.EpisodeFileCount > 0) return new CopyState(StatusStage.AlmostReady, StatusReasonCode.LibraryPending);
            if (!series.Monitored) return new CopyState(StatusStage.NotHere, StatusReasonCode.Unmonitored);
            // "Not out yet" only on counts that cover every season the viewer may see.
            if (series.EpisodeCount == 0 && copy.Unvouched.Count == 0 && series.NextAiring is DateTime next && next > c.Now)
                return new CopyState(StatusStage.NotOut, StatusReasonCode.NotAired, Date: next);
            if (copy.QueueUnknown) return Unknown();
            return Looking(Latest(Valid(series.Added), SentFor(request, copy, null, null, c)), c);
        }

        /// <summary>
        /// Per-episode states of one season: every number Sonarr or Jellyfin knows, except episodes
        /// Jellyfin has but hides from this viewer (the read's mask). Requests that went out
        /// (<paramref name="request"/>) restart the "still looking" clock of the episodes they cover.
        /// </summary>
        internal static List<(int Episode, CopyState State, ArrEpisodeEntry? Arr, JfEpisode? Row)> EpisodeStates(ArrCopyRead copy, int season, IReadOnlyList<JfEpisode>? jfEpisodes, ComposeContext c, RequestFacts? request = null)
        {
            var result = new List<(int, CopyState, ArrEpisodeEntry?, JfEpisode?)>();
            var files = (jfEpisodes ?? Array.Empty<JfEpisode>()).Where(e => e.Season == season && !e.Hidden).ToList();
            // Only synthesize bounded rows from file metadata. Known Sonarr numbers, including the
            // far tail of a combined file, are matched against the full range below.
            var numbers = new SortedSet<int>(files.SelectMany(Covered));
            if (copy.Episodes != null)
                numbers.UnionWith(copy.Episodes.Episodes.Where(e => e.SeasonNumber == season).Select(e => e.EpisodeNumber));
            foreach (var n in numbers)
            {
                if (copy.Mask.Hides(season, n)) continue;
                var have = Have(files, season, n);
                var row = files.FirstOrDefault(e => new EpisodeRange(e.Episode, e.EpisodeEnd).Contains(n));
                var arr = copy.Episodes?.Find(season, n);
                CopyState state;
                if (have != null)
                {
                    state = QueuedEpisode(copy, RowsFor(copy, season, n, arr), have: true, have.DateCreated, c)
                        ?? new CopyState(StatusStage.Ready, StatusReasonCode.Ready, Since: have.DateCreated);
                }
                else if (arr == null && copy.Episodes != null)
                {
                    continue; // a virtual Jellyfin episode Sonarr does not know
                }
                else
                {
                    state = EpisodeFromArr(copy, season, n, arr, c, request);
                }
                result.Add((n, state, arr, row));
            }
            return result;
        }

        /// <summary>
        /// An episode Jellyfin cannot play (yet): where Sonarr has got to. "Nothing grabbed for a long
        /// while" counts from the latest of its air date, the series being added and a request for it
        /// going out (<paramref name="request"/>).
        /// </summary>
        internal static CopyState EpisodeFromArr(ArrCopyRead copy, int season, int episode, ArrEpisodeEntry? arr, ComposeContext c, RequestFacts? request = null)
        {
            if (QueuedEpisode(copy, RowsFor(copy, season, episode, arr), have: false, null, c) is { } queued) return queued;
            if (arr == null) return new CopyState(StatusStage.None, StatusReasonCode.NotInArr);
            if (arr.HasFile) return new CopyState(StatusStage.AlmostReady, StatusReasonCode.LibraryPending, Since: RecentEpisodeImport(copy, season, episode, arr, c));
            if (!copy.QueueUnknown && RecentFailure(copy.History, arr.Id, c) is DateTime failedAt)
                return new CopyState(StatusStage.Looking, StatusReasonCode.Failed, Attention: true, Since: failedAt);
            if (!copy.QueueUnknown && Departed(copy, null, arr.Id, copy.EpisodesLoadedAt) is DateTime left)
                return new CopyState(StatusStage.AlmostReady, StatusReasonCode.Importing, Since: left);
            var air = Valid(arr.AirDateUtc);
            // An air date without a time (a calendar day) has not aired while that day lasts somewhere; an unknown one hasn't.
            if (!Aired(arr.AirDateUtc, arr.AirDateIsDay, c.Now)) return new CopyState(StatusStage.NotOut, StatusReasonCode.NotAired, Date: air, DateIsDay: arr.AirDateIsDay);
            if (!arr.Monitored || copy.Series?.Monitored == false) return new CopyState(StatusStage.NotHere, StatusReasonCode.Unmonitored);
            if (copy.QueueUnknown) return Unknown();
            var sent = SentFor(request, copy, season, episode, c);
            return Looking(Latest(Latest(air, Valid(copy.Series?.Added)), sent), c, arr.LastSearchTime, sent.HasValue);
        }

        // ------------------------------------------------------------------ queue

        /// <summary>
        /// What a queue row means in the status language, by the one precedence table
        /// (<see cref="ArrQueueStates.Classify(ArrQueueEntry)"/>): failed; import blocked, or finished
        /// with a warning (never "downloading", no progress); a warning while downloading; the
        /// download client unavailable; delay; importing; queued; downloading. Anything else is a
        /// neutral "waiting in line" with no progress, never importing or ready. Only an explicit
        /// "downloading" carries progress. <paramref name="copy"/> (the copy the row belongs to) brings
        /// JE's first-seen clocks (problems and importing are timed from when JE first saw them, a
        /// download in line from when the arr added it; without clocks, the arr's added time) and
        /// when the queue was read (the time left is counted from then, and dropped once the queue
        /// is past its freshness target).
        /// </summary>
        internal static CopyState FromQueue(ArrQueueEntry row, ComposeContext c, ArrCopyRead? copy = null)
        {
            var seen = copy?.Seen;
            var cls = ArrQueueStates.Classify(row);
            var added = Valid(row.Added);
            DateTime? Clock()
            {
                if (seen == null) return added;
                var at = seen(row);
                if (at == null || at.Class != cls) return c.Now; // not stamped yet: first seen now
                return ArrQueueStates.IsProblem(cls) ? at.AttentionSince ?? at.ReasonSince : at.ReasonSince;
            }
            var downloading = string.Equals(row.Status, "downloading", StringComparison.OrdinalIgnoreCase);
            return cls switch
            {
                ArrQueueClass.Failed => new CopyState(StatusStage.Looking, StatusReasonCode.Failed, Attention: true, Since: Clock(), Row: row),
                ArrQueueClass.ImportBlocked or ArrQueueClass.ImportWarned => new CopyState(StatusStage.AlmostReady, StatusReasonCode.ImportBlocked, Attention: true, Since: Clock(), Row: row),
                ArrQueueClass.Warned => new CopyState(StatusStage.Downloading, StatusReasonCode.Stalled, Attention: true, Progress: downloading ? Progress(row, c, copy) : null, Since: Clock(), Row: row),
                ArrQueueClass.ClientUnavailable => new CopyState(StatusStage.Downloading, StatusReasonCode.ClientUnavailable, Attention: true, Since: Clock(), Row: row),
                ArrQueueClass.Delayed => new CopyState(StatusStage.Downloading, StatusReasonCode.DelayHeld, Since: added, Row: row),
                ArrQueueClass.Importing => new CopyState(StatusStage.AlmostReady, StatusReasonCode.Importing, Since: Clock(), Row: row),
                ArrQueueClass.Queued => new CopyState(StatusStage.Downloading, StatusReasonCode.Queued, Since: added, Row: row),
                // A stalled download (no time left, data missing) is still "downloading" for the family;
                // Needs attention lists it (timed from JE's first sight).
                ArrQueueClass.Downloading or ArrQueueClass.Stalled => new CopyState(StatusStage.Downloading, StatusReasonCode.Downloading, Progress: Progress(row, c, copy), Since: added, Row: row),
                _ => new CopyState(StatusStage.Downloading, StatusReasonCode.Queued, Since: added, Row: row),
            };
        }

        /// <summary>
        /// Percent done and seconds left of a queue row. The arr's "time left" is counted from when the
        /// queue was read (<see cref="ArrCopyFacts.QueueLoadedAt"/>); no time left is given once the
        /// queue is past its freshness target (<see cref="ArrCopyFacts.QueueStale"/>).
        /// </summary>
        internal static StatusProgress? Progress(ArrQueueEntry row, ComposeContext c, ArrCopyRead? copy = null)
        {
            if (row.Size is not double size || size <= 0) return null;
            var left = Math.Clamp(row.SizeLeft ?? size, 0, size);
            var pct = (int)Math.Clamp(Math.Floor((size - left) / size * 100), 0, 100);
            long? eta = null;
            if (copy?.QueueStale != true)
            {
                if (row.EstimatedCompletionTime is DateTime done)
                {
                    var utc = done.Kind == DateTimeKind.Unspecified ? DateTime.SpecifyKind(done, DateTimeKind.Utc) : done.ToUniversalTime();
                    if (utc > c.Now) eta = (long)(utc - c.Now).TotalSeconds;
                }
                if (eta == null && !string.IsNullOrEmpty(row.TimeLeft) && TimeSpan.TryParse(row.TimeLeft, CultureInfo.InvariantCulture, out var span) && span > TimeSpan.Zero)
                {
                    var elapsed = copy?.QueueLoadedAt is DateTime read && c.Now > read ? c.Now - read : TimeSpan.Zero;
                    if (span > elapsed) eta = (long)(span - elapsed).TotalSeconds;
                }
            }
            // Whole minutes (rounded up) beyond the first: the text says "about N min" anyway, and an
            // ETA that ticks every second would make every response a new body (no 304s).
            if (eta > 60) eta = (eta + 59) / 60 * 60;
            return new StatusProgress { Percent = pct, EtaSeconds = eta };
        }

        private static ArrQueueEntry BestRow(IReadOnlyList<ArrQueueEntry> rows)
        {
            // Problems first (someone should hear about them), then the furthest along, by the same
            // table that classifies the rows.
            return rows.OrderByDescending(r => ArrQueueStates.Rank(ArrQueueStates.Classify(r)))
                .ThenBy(r => r.SizeLeft ?? double.MaxValue)
                .First();
        }

        private static IReadOnlyList<ArrQueueEntry> RowsFor(ArrCopyRead copy, int season, int episode, ArrEpisodeEntry? arr)
        {
            var rows = new List<ArrQueueEntry>();
            foreach (var r in copy.Queue)
            {
                if (arr != null && r.EpisodeId == arr.Id) rows.Add(r);
                else if (r.SeasonNumber == season && r.EpisodeNumber == episode) rows.Add(r);
            }
            return rows;
        }

        /// <summary>
        /// The one reading of an episode's queue rows, on every surface that shows or counts it (D53): for an episode the
        /// viewer already plays (<paramref name="have"/>: a Jellyfin file, since <paramref name="since"/>) an upgrade,
        /// Ready with a better copy coming (never a download or a problem); otherwise its best row by the queue table
        /// (<see cref="FromQueue"/>). Null when it has no rows.
        /// </summary>
        internal static CopyState? QueuedEpisode(ArrCopyRead copy, IReadOnlyList<ArrQueueEntry> rows, bool have, DateTime? since, ComposeContext c)
        {
            if (rows.Count == 0) return null;
            return have
                ? new CopyState(StatusStage.Ready, StatusReasonCode.Upgrading, Progress: Progress(rows[0], c, copy), Since: since, Row: rows[0])
                : FromQueue(BestRow(rows), c, copy);
        }

        /// <summary>
        /// A copy's queue episode by episode, read as its pages read it (<see cref="QueuedEpisode"/>): each episode's rows
        /// together, against the viewer's Jellyfin file of it in <paramref name="files"/> (its Jellyfin copy's episodes;
        /// null: not known, every row reads as a download). Rows of parts Jellyfin hides from the viewer are not in the
        /// read's queue; <paramref name="season"/> keeps one season's.
        /// </summary>
        internal static List<(int Season, int Episode, CopyState State)> QueuedEpisodes(ArrCopyRead copy, IReadOnlyList<JfEpisode>? files, ComposeContext c, int? season = null)
        {
            var result = new List<(int, int, CopyState)>();
            var groups = copy.Queue
                .Where(r => season == null || r.SeasonNumber == season)
                // An episode's rows share its numbers; a row without them stands alone (by its episode id, else its own).
                .GroupBy(r => r.SeasonNumber is int s && r.EpisodeNumber is int e ? (s, e, 0) : (-1, -1, r.EpisodeId ?? r.Id));
            foreach (var group in groups)
            {
                var rows = group.ToList();
                var (s, e) = (rows[0].SeasonNumber ?? 0, rows[0].EpisodeNumber ?? 0);
                var have = rows[0].SeasonNumber.HasValue && rows[0].EpisodeNumber.HasValue ? Have(files, s, e) : null;
                result.Add((s, e, QueuedEpisode(copy, rows, have != null, have?.DateCreated, c)!));
            }
            return result;
        }

        /// <summary>An episode simply not there (nobody fetching it, or looking for it): a gap, as the season page's banner lists it.</summary>
        private static bool IsGap(CopyState state)
            => state.Stage is StatusStage.Looking or StatusStage.NotHere && !state.Attention && state.Reason is not (StatusReasonCode.ServiceDown or StatusReasonCode.Failed);

        /// <summary>An aired episode missing for a long while (monitored, nothing grabbed): "Missing", with a Search button.</summary>
        private static bool IsLongMissing(CopyState state)
            => state.Stage == StatusStage.Looking && state.Reason == StatusReasonCode.NoReleaseYet && !state.Attention;

        /// <summary>A queue state that is an upgrade (see <see cref="QueuedEpisode"/>).</summary>
        private static bool IsUpgrade(CopyState state) => state.Reason == StatusReasonCode.Upgrading;

        /// <summary>The Jellyfin episode the viewer plays an episode number from (a combined file covers its range; never a placeholder), if any.</summary>
        private static JfEpisode? Have(IReadOnlyList<JfEpisode>? files, int season, int episode)
            => files?.FirstOrDefault(x => x.Season == season && EditionAvailability.Plays(x) && new EpisodeRange(x.Episode, x.EpisodeEnd).Contains(episode));

        // ------------------------------------------------------------------ summaries

        private static StatusSummary Summarize(List<(CopyState State, ArrEpisodeEntry? Arr, int Season, int Episode)> episodes, ComposeContext c)
        {
            int aired = 0, ready = 0, downloading = 0, almost = 0, missing = 0, attention = 0, unknown = 0, longMissing = 0, longSent = 0;
            DateTime? next = null, longSince = null;
            var nextIsDay = false;
            int? nextSeason = null, nextEpisode = null;
            foreach (var (state, arr, season, episode) in episodes)
            {
                var air = Valid(arr?.AirDateUtc);
                var isDay = arr?.AirDateIsDay == true;
                var hasAired = state.Stage != StatusStage.NotOut || (air.HasValue && !NotYet(air.Value, isDay, c.Now));
                if (state.Stage == StatusStage.NotOut && air.HasValue && NotYet(air.Value, isDay, c.Now) && (next == null || air.Value < next))
                {
                    next = air;
                    nextIsDay = isDay;
                    nextSeason = season;
                    nextEpisode = episode;
                }
                if (state.Stage == StatusStage.None) continue;
                if (hasAired) aired++;
                if (state.Attention) attention++;
                switch (state.Stage)
                {
                    case StatusStage.Ready: ready++; break;
                    case StatusStage.Downloading: downloading++; break;
                    case StatusStage.AlmostReady: almost++; break;
                    case StatusStage.Looking:
                        // Wanted and not here. Episodes nobody monitors are not "missing" (a season
                        // the household never wanted would otherwise count against the series).
                        if (hasAired)
                        {
                            missing++;
                            // Its downloads can't be checked now: not known to be missing.
                            if (state.Reason == StatusReasonCode.ServiceDown) unknown++;
                            // Missing for a long while (shown as Missing with a Search button).
                            if (IsLongMissing(state))
                            {
                                longMissing++;
                                if (state.Since is DateTime since && (longSince == null || since < longSince)) longSince = since;
                                if (state.Params?.TryGetValue("sent", out var sent) == true && sent == "1") longSent++;
                            }
                        }
                        break;
                }
            }
            return new StatusSummary { Aired = aired, Ready = ready, Downloading = downloading, AlmostReady = almost, Missing = missing, Unknown = unknown, Attention = attention, LongMissing = longMissing, LongMissingSince = longSince, LongMissingSent = longSent, NextAir = next, NextAirIsDay = next.HasValue && nextIsDay, NextSeason = nextSeason, NextEpisode = nextEpisode };
        }

        /// <summary>
        /// A season from Sonarr's statistics (when its episodes are not in memory: poster cards, the Requests page). The read's
        /// statistics are the viewer's own (<see cref="ArrCopyRead.Series"/>): a season Jellyfin hides from them has none, and
        /// one with hidden episodes has no counts or next airing (<see cref="ArrCopyRead.Unvouched"/>): it reads only what
        /// Jellyfin plays for them and its visible queue.
        /// </summary>
        private static StatusSummary SeasonFromStats(ArrCopyRead copy, int season, IReadOnlyList<JfEpisode>? jfEpisodes, ComposeContext c)
        {
            var stats = copy.Series?.Seasons.FirstOrDefault(s => s.SeasonNumber == season);
            // Sonarr counts episodes with a file, not files: a two-part file covers two episodes.
            var coverage = new EpisodeCoverage((jfEpisodes ?? Array.Empty<JfEpisode>()).Where(EditionAvailability.Plays));
            var ready = (int)Math.Min(int.MaxValue, coverage.CountInSeason(season));
            // The queue as the season's page reads it: a download of an episode the viewer plays is an upgrade (ready).
            var queued = QueuedEpisodes(copy, jfEpisodes, c, season);
            var downloading = queued.Count(x => x.State.Stage == StatusStage.Downloading);
            var almost = queued.Count(x => x.State.Stage == StatusStage.AlmostReady);
            var attention = queued.Count(x => x.State.Attention);
            // A season whose statistics can't be vouched for: what is visibly here or on its way, nothing more.
            var aired = copy.Unvouched.Contains(season) ? ready + downloading + almost : Math.Max(stats?.EpisodeCount ?? 0, ready);
            var files = stats?.EpisodeFileCount ?? 0;
            // D53, edition round 19 part B (disjoint identities): Sonarr's file count names no episodes, so its overlap with the
            // queue (an importing episode has its file already; a download of an episode Sonarr has a file for Jellyfin hasn't
            // read yet) can't be told. Both are bounded from below: a file Jellyfin doesn't play yet counts as on its way only past
            // what the queue already names, and an episode counts as missing only when it can be none of those files or rows.
            // No episode is counted twice, and the parts never add up to more than the season's aired episodes.
            var unread = Math.Max(0, files - ready);
            var pending = Math.Max(0, unread - downloading - almost);
            var missing = Math.Max(0, aired - ready - unread - downloading - almost);
            var next = stats?.NextAiring is DateTime n && n > c.Now ? n : (DateTime?)null;
            return new StatusSummary { Aired = aired, Ready = ready, Downloading = downloading, AlmostReady = almost + pending, Missing = missing, Unknown = copy.QueueUnknown ? missing : 0, Attention = attention, NextAir = next, NextSeason = next.HasValue ? season : null };
        }

        private static StatusSummary Combine(List<StatusSummary> seasons)
        {
            var next = seasons.Where(s => s.NextAir.HasValue).OrderBy(s => s.NextAir).FirstOrDefault();
            return new StatusSummary
            {
                Aired = seasons.Sum(s => s.Aired),
                Ready = seasons.Sum(s => s.Ready),
                Downloading = seasons.Sum(s => s.Downloading),
                AlmostReady = seasons.Sum(s => s.AlmostReady),
                Missing = seasons.Sum(s => s.Missing),
                Unknown = seasons.Sum(s => s.Unknown),
                Attention = seasons.Sum(s => s.Attention),
                LongMissing = seasons.Sum(s => s.LongMissing),
                LongMissingSent = seasons.Sum(s => s.LongMissingSent),
                LongMissingSince = seasons.Where(s => s.LongMissingSince.HasValue).Select(s => s.LongMissingSince).DefaultIfEmpty(null).Min(),
                NextAir = next?.NextAir,
                NextAirIsDay = next?.NextAirIsDay == true,
                NextSeason = next?.NextSeason,
                NextEpisode = next?.NextEpisode,
            };
        }

        private static string SummaryStage(StatusSummary s)
        {
            if (s.Downloading > 0) return StatusStage.Downloading;
            if (s.AlmostReady > 0) return StatusStage.AlmostReady;
            if (s.Missing > 0) return StatusStage.Looking;
            if (s.Aired > 0 && s.Ready >= s.Aired) return StatusStage.Ready;
            if (s.Aired == 0 && s.NextAir.HasValue) return StatusStage.NotOut;
            return s.Ready > 0 ? StatusStage.Ready : StatusStage.None;
        }

        /// <summary>
        /// The overall state of a series or season (its headline, and the copy-level admin line: problems get their own
        /// lines). Missing for a long while carries the earliest "missing since" and, when a request already sent every
        /// one of those episodes, <c>sent</c> (as an episode's own state does).
        /// </summary>
        private static CopyState Overall(string stage, StatusSummary s)
        {
            var reason = SummaryReason(s);
            if (reason != StatusReasonCode.NoReleaseYet) return new CopyState(stage, reason);
            return new CopyState(stage, reason, Since: s.LongMissingSince, Params: s.LongMissingSent >= s.LongMissing ? Params(("sent", "1")) : null);
        }

        private static string SummaryReason(StatusSummary s)
        {
            if (s.Downloading > 0) return StatusReasonCode.Downloading;
            if (s.AlmostReady > 0) return StatusReasonCode.LibraryPending;
            // Every episode still to come is on an instance whose downloads can't be checked now.
            if (s.Missing > 0 && s.Unknown >= s.Missing) return StatusReasonCode.ServiceDown;
            // "Some episodes here" only when some are (also when the rest is missing for a long while: the scope as a
            // whole isn't missing, and its seasons and episodes say which parts are).
            if (s.Missing > 0 && s.Ready > 0) return StatusReasonCode.Partial;
            // Every episode still to come is missing for a long while: "Missing", with a Search button.
            if (s.Missing > 0 && s.LongMissing >= s.Missing) return StatusReasonCode.NoReleaseYet;
            if (s.Missing > 0) return StatusReasonCode.Looking;
            if (s.Aired == 0 && s.NextAir.HasValue) return StatusReasonCode.NotAired;
            // Aired episodes, none here and none being looked for (all unmonitored): not "Ready" (the stage is None).
            if (s.Aired > 0 && s.Ready == 0) return StatusReasonCode.Unmonitored;
            return StatusReasonCode.Ready;
        }

        private static IEnumerable<int> SeasonNumbers(ArrCopyRead copy, IReadOnlyList<JfEpisode>? jfEpisodes)
        {
            var numbers = new SortedSet<int>();
            foreach (var s in copy.Series?.Seasons ?? Array.Empty<ArrSeasonEntry>())
            {
                if (s.TotalEpisodeCount > 0 || s.EpisodeFileCount > 0 || s.Monitored) numbers.Add(s.SeasonNumber);
            }
            foreach (var e in jfEpisodes ?? Array.Empty<JfEpisode>())
            {
                if (!e.Virtual) numbers.Add(e.Season);
            }
            return numbers;
        }

        // ------------------------------------------------------------------ journey

        private static List<JourneyStop> MovieJourney(CopyState headline, ArrCopyRead? copy, JfItemRef? item, IReadOnlyList<JfCopy> jf, RequestFacts? request, ComposeContext c)
        {
            var dates = new Dictionary<string, DateTime?>();
            if (request?.AskedAt != null || request?.Pending == true) dates[StatusStage.Asked] = request!.AskedAt;
            if (request?.ApprovedAt != null) dates[StatusStage.Approved] = request.ApprovedAt;
            if (copy?.Movie != null)
            {
                dates[StatusStage.Looking] = Valid(copy.Movie.Added);
                var grab = Newest(copy.History, null, IsGrab) ?? copy.Queue.Select(r => Valid(r.Added)).Where(d => d.HasValue).Min();
                if (grab != null) dates[StatusStage.Downloading] = grab;
                if (RecentImport(copy, c, TimeSpan.FromDays(365)) is DateTime imported) dates[StatusStage.AlmostReady] = imported;
            }
            // Added and grabbed within minutes: it was never really "looking".
            if (dates.TryGetValue(StatusStage.Looking, out var lookingAt) && dates.TryGetValue(StatusStage.Downloading, out var grabbedAt)
                && lookingAt.HasValue && grabbedAt.HasValue && grabbedAt.Value - lookingAt.Value < TimeSpan.FromMinutes(10))
                dates.Remove(StatusStage.Looking);
            var readyAt = item?.DateCreated ?? jf.Where(x => x.Visible).Select(x => x.DateCreated).FirstOrDefault();
            if (headline.Stage == StatusStage.Ready) dates[StatusStage.Ready] = readyAt;
            return Journey(headline.Stage, dates, request);
        }

        private static List<JourneyStop> EpisodeJourney(CopyState state, ArrCopyRead? copy, int season, int episode, ArrEpisodeEntry? arr, JfItemRef item, ComposeContext c)
        {
            var dates = new Dictionary<string, DateTime?>();
            if (copy != null)
            {
                if (state.Stage == StatusStage.NotOut) dates[StatusStage.NotOut] = null;
                var air = Valid(arr?.AirDateUtc);
                if (air.HasValue && air.Value <= c.Now) dates[StatusStage.Looking] = air;
                var grab = Newest(copy.History, arr?.Id, IsGrab, season, episode);
                if (grab != null) dates[StatusStage.Downloading] = grab;
                var imported = RecentEpisodeImport(copy, season, episode, arr, c, TimeSpan.FromDays(365));
                if (imported != null) dates[StatusStage.AlmostReady] = imported;
            }
            if (state.Stage == StatusStage.Ready) dates[StatusStage.Ready] = item.DateCreated;
            return Journey(state.Stage, dates, null);
        }

        /// <summary>Done stops (only those that happened), the current one, then what is still to come.</summary>
        private static List<JourneyStop> Journey(string current, Dictionary<string, DateTime?> dates, RequestFacts? request)
        {
            var stops = new List<JourneyStop>();
            var currentRank = StatusStage.Rank(current);
            if (currentRank < 0) return stops;
            for (var i = 0; i < StatusStage.Journey.Count; i++)
            {
                var stage = StatusStage.Journey[i];
                bool? byYou = stage == StatusStage.Asked && request != null ? request.AskedByViewer : null;
                if (i < currentRank)
                {
                    if (!dates.TryGetValue(stage, out var at)) continue;
                    stops.Add(new JourneyStop { Stage = stage, At = at, State = "done", ByYou = byYou });
                }
                else if (i == currentRank)
                {
                    dates.TryGetValue(stage, out var at);
                    stops.Add(new JourneyStop { Stage = stage, At = at, State = "current", ByYou = byYou });
                }
                else if (stage is StatusStage.Downloading or StatusStage.AlmostReady or StatusStage.Ready
                         || (stage == StatusStage.Looking && current != StatusStage.NotOut && currentRank < StatusStage.Rank(StatusStage.Looking)))
                {
                    stops.Add(new JourneyStop { Stage = stage, State = "next" });
                }
            }
            return stops;
        }

        // ------------------------------------------------------------------ admin

        private static AdminStatus AdminFor(TitleFacts facts, List<(ArrCopyRead Copy, CopyState State, JfCopy? Jf)> variants, List<(ArrCopyRead Copy, int Season, int Episode, CopyState State)>? problems)
        {
            using var __factsOperation13 = global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.BeginOperation();
            var list = new List<AdminVariant>();
            foreach (var (copy, state, jf) in variants)
            {
                list.Add(Variant(copy, state, jf, null));
            }
            foreach (var (copy, season, episode, state) in (problems ?? new List<(ArrCopyRead, int, int, CopyState)>()).Take(20))
            {
                list.Add(Variant(copy, state, null, "S" + season.ToString("00", CultureInfo.InvariantCulture) + "E" + episode.ToString("00", CultureInfo.InvariantCulture)));
            }
            return new AdminStatus { Variants = list, Unreadable = facts.Unreadable.Count > 0 ? facts.Unreadable.Select(u => u.Label).ToList() : null };
        }

        /// <summary>The series copies other than the primary one (a 4K or anime Sonarr holding the same series).</summary>
        private static IEnumerable<ArrCopyFacts> OtherSeriesCopies(TitleFacts facts, ArrCopyFacts primary)
        {
            using var __factsOperation14 = global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.BeginOperation();
            return facts.Copies.Where(x => x.IsSeries && !ReferenceEquals(x, primary)).OrderBy(x => RoleOrder(x.Instance.Role));
        }
        /// <summary>Every Sonarr copy of the series (the siblings <see cref="MatchCopies"/> tells apart).</summary>
        internal static List<ArrCopyFacts> SeriesCopies(TitleFacts facts)
        {
            using var __factsOperation15 = global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.BeginOperation();
            return facts.Copies.Where(x => x.IsSeries).ToList();
        }
        /// <summary>
        /// Admin lines for the other Sonarr instances holding the series: one line per instance (where
        /// it has got to as a whole, through its own binding: the Jellyfin copy it owns, when
        /// <paramref name="bindings"/> are known) and one per queue problem (only this season's or episode's when given).
        /// Episode pages only list instances with a download of that episode. True when any problem was found.
        /// </summary>
        private static bool AddOtherSeriesCopies(TitleFacts facts, ArrCopyFacts primary, IReadOnlyList<SeriesBinding>? bindings, int? season, int? episode, ComposeContext c, List<(ArrCopyRead, CopyState, JfCopy?)> variants, List<(ArrCopyRead, int, int, CopyState)> problems)
        {
            var any = false;
            foreach (var otherCopy in OtherSeriesCopies(facts, primary))
            {
                // Its own Jellyfin copy's episodes tell its upgrades from its downloads, as that copy's pages do; its facts pass
                // its own binding's mask.
                var bound = BindingOf(bindings, otherCopy);
                var other = bound.Read(c);
                var files = FilesOf(bound, c);
                var found = QueueProblems(other, files, season, episode, c);
                any |= found.Count > 0;
                if (episode.HasValue)
                {
                    var rows = RowsFor(other, season ?? 0, episode.Value, other.Episodes?.Find(season ?? 0, episode.Value));
                    var have = Have(files, season ?? 0, episode.Value);
                    if (QueuedEpisode(other, rows, have != null, have?.DateCreated, c) is { } state) variants.Add((other, state, null));
                    continue;
                }
                // In the library for this line only when its own copy plays an episode for the viewer (the availability
                // predicate, D53 edition round 19 part B): a copy that lists only placeholders reads where its Sonarr is.
                variants.Add((other, SeriesCopyState(other, bound.Open && c.Holds?.Invoke(bound.Jf!.ItemId) == true, c, facts.Request, files), bound.Jf));
                problems.AddRange(found);
            }
            return any;
        }

        /// <summary>
        /// The episodes of a series copy whose downloads need someone (import blocked, stalled, failed), one per episode,
        /// read as its pages read them (<see cref="QueuedEpisodes"/>: an upgrade of an episode in <paramref name="files"/>
        /// is none).
        /// </summary>
        private static List<(ArrCopyRead, int, int, CopyState)> QueueProblems(ArrCopyRead copy, IReadOnlyList<JfEpisode>? files, int? season, int? episode, ComposeContext c)
            => QueuedEpisodes(copy, files, c, season: season)
                .Where(x => x.State.Attention && (episode == null || x.Episode == episode))
                .Select(x => (copy, x.Season, x.Episode, x.State))
                .ToList();

        /// <summary>
        /// The Jellyfin viewer's episodes without the hidden ones, and what is hidden: episode numbers no
        /// visible episode covers, and the seasons Jellyfin itself reports hidden (never guessed from
        /// episodes: a visible season whose only imported episode is hidden stays).
        /// </summary>
        internal static (IReadOnlyList<JfEpisode>? Visible, HiddenParts Hidden) SplitHidden(IReadOnlyList<JfEpisode>? jf, IReadOnlyList<JfSeason>? seasons)
        {
            var hiddenSeasons = new HashSet<int>(seasons?.Where(s => s.Hidden).Select(s => s.Season) ?? Array.Empty<int>());
            hiddenSeasons.ExceptWith(seasons?.Where(s => !s.Hidden).Select(s => s.Season) ?? Array.Empty<int>());
            if ((jf == null || !jf.Any(e => e.Hidden)) && hiddenSeasons.Count == 0) return (jf, HiddenParts.None);
            var visible = jf?.Where(e => !e.Hidden).ToList();
            var unseen = jf?.Where(e => e.Hidden) ?? Enumerable.Empty<JfEpisode>();
            var hidden = new EpisodeCoverage(unseen, visible);
            var withFile = new EpisodeCoverage(unseen.Where(e => !e.Virtual), visible);
            return (visible, new HiddenParts(hidden, withFile, hiddenSeasons));
        }

        /// <summary>
        /// Bounded synthetic rows when Jellyfin alone supplies the numbers. Never used for privacy
        /// or matching: those check full-range membership, including numbers beyond this limit.
        /// </summary>
        private static IEnumerable<int> Covered(JfEpisode e)
            => new EpisodeRange(e.Episode, e.EpisodeEnd).Numbers(EpisodeRange.MaxSyntheticEpisodes);

        private static AdminVariant Variant(ArrCopyRead copy, CopyState state, JfCopy? jf, string? scope)
        {
            var row = state.Row;
            var messages = new List<string>();
            if (row != null)
            {
                foreach (var m in row.StatusMessages)
                {
                    if (messages.Count < MaxMessages) messages.Add(m);
                }
                if (!string.IsNullOrWhiteSpace(row.ErrorMessage) && messages.Count < MaxMessages) messages.Add(row.ErrorMessage!);
            }
            return new AdminVariant
            {
                Instance = copy.Instance.Name,
                InstanceId = copy.Instance.Id,
                Kind = copy.Instance.Kind.ToString(),
                Role = copy.Instance.Role,
                Stage = state.Stage,
                Reason = Reason(state),
                Attention = state.Attention,
                Progress = state.Progress,
                Monitored = copy.Movie?.Monitored ?? copy.Series?.Monitored,
                HasFile = copy.Movie?.HasFile ?? (copy.Series != null ? copy.Series.EpisodeFileCount > 0 : null),
                MinimumAvailability = copy.Movie?.MinimumAvailability,
                Library = jf?.LibraryName,
                ItemId = jf != null ? Id(jf.ItemId) : null,
                VisibleToViewer = jf?.Visible,
                Messages = messages.Count > 0 ? messages : null,
                ArrState = row?.TrackedDownloadState ?? row?.Status,
                Client = row?.DownloadClient,
                Quality = row?.Quality,
                CustomFormatScore = row?.CustomFormatScore,
                Path = copy.Facts.Path,
                Since = state.Since,
                Fix = FixFor(state.Reason),
                Scope = scope,
                LastSearch = state.LastSearch,
            };
        }

        /// <summary>The admin fix hint for a reason code (null: nothing to fix).</summary>
        internal static string? FixFor(string reason) => reason switch
        {
            StatusReasonCode.NotReleased or StatusReasonCode.InCinemas => StatusFix.ChangeMinAvailability,
            StatusReasonCode.Looking or StatusReasonCode.NoReleaseYet => StatusFix.SearchNow,
            StatusReasonCode.DelayHeld => StatusFix.GrabNow,
            StatusReasonCode.Stalled => StatusFix.RemoveAndSearch,
            StatusReasonCode.Failed => StatusFix.Research,
            StatusReasonCode.ImportBlocked => StatusFix.ManualImport,
            StatusReasonCode.LibraryPending => StatusFix.ScanNow,
            StatusReasonCode.NotVisibleToUser => StatusFix.GrantAccess,
            StatusReasonCode.Unmonitored => StatusFix.MonitorAndSearch,
            StatusReasonCode.ServiceDown => StatusFix.Health,
            StatusReasonCode.ClientUnavailable => StatusFix.CheckClient,
            _ => null,
        };

        // ------------------------------------------------------------------ helpers

        /// <summary>
        /// The Jellyfin copies an arr copy corresponds to. <paramref name="siblings"/> are every arr
        /// copy of the title of the same kind (the copy itself included).
        /// <list type="number">
        /// <item><description>The instance's linked libraries: final.</description></item>
        /// <item><description>Its path mappings (the longest whose arr side contains the copy's folder):
        /// the Jellyfin copies inside the mapped folder (a folder boundary, so "/movies" never matches
        /// "/movies4k"); once a mapping applies its answer is final, even when empty.</description></item>
        /// <item><description>Otherwise, over the Jellyfin copies no sibling claimed by rule 1 or 2:
        /// the same folder, else the last two folder names (root folder + title folder, which tells
        /// "movies/Dune (2024)" from "movies4k/Dune (2024)"); but nothing when a sibling's folder ends
        /// the same way (two instances on different hosts both rooted at /movies: which Jellyfin copy
        /// is whose can't be told).</description></item>
        /// <item><description>When only one instance holds the title: every copy, unless
        /// <paramref name="soleFallback"/> is false (a 4K scope: a copy not positively matched to the
        /// 4K instance may well be the standard one, so it is never taken for the 4K copy).</description></item>
        /// </list>
        /// </summary>
        internal static List<JfCopy> MatchCopies(ArrCopyFacts copy, IReadOnlyList<JfCopy> jf, IReadOnlyList<ArrCopyFacts> siblings, bool soleFallback = true, bool possible = false)
        {
            if (jf.Count == 0) return new List<JfCopy>();
            if (Claimed(copy, jf) is { } strong) return strong;
            var arrPath = ArrPathOf(copy);
            if (!string.IsNullOrWhiteSpace(arrPath) && Tail(Norm(arrPath), 2) is { } tail)
            {
                var others = siblings.Where(x => !ReferenceEquals(x, copy) && x.Instance.Id != copy.Instance.Id).ToList();
                var ambiguous = others.Any(o => ArrPathOf(o) is { } p && !string.IsNullOrWhiteSpace(p) && string.Equals(Tail(Norm(p), 2), tail, StringComparison.OrdinalIgnoreCase));
                if (!ambiguous || possible)
                {
                    var claimed = new HashSet<Guid>(others.SelectMany(o => Claimed(o, jf) ?? new List<JfCopy>()).Select(x => x.ItemId));
                    var free = jf.Where(x => !claimed.Contains(x.ItemId) && x.Path != null).ToList();
                    var same = free.Where(x => BridgePaths.IsUnder(x.Path!, arrPath)).ToList();
                    if (same.Count > 0) return same;
                    var hits = free.Where(x => Tail(TitleFolder(Norm(x.Path!), copy.Movie != null), 2) is { } t && string.Equals(t, tail, StringComparison.OrdinalIgnoreCase)).ToList();
                    if (hits.Count > 0) return hits;
                }
            }
            // What it may own when that can't be told (possible): any copy nobody claims for sure.
            if (possible) return jf.Where(x => !siblings.Where(o => o.Instance.Id != copy.Instance.Id).Any(o => Claimed(o, jf)?.Any(y => y.ItemId == x.ItemId) == true)).ToList();
            return soleFallback && siblings.Count <= 1 ? jf.ToList() : new List<JfCopy>();
        }

        /// <summary>
        /// The Jellyfin copies of a movie an arr copy MAY own although no instance owns them for sure (D53, edition round 20:
        /// uncertain is not absent): several instances' linked libraries or mappings claim them alike, two instances' folders
        /// end the same way, or its folder tells nothing. A copy the viewer can't open among them keeps that instance's facts
        /// (its downloads, its readiness) from them. <paramref name="owned"/>: the copies some instance owns for sure.
        /// </summary>
        internal static List<JfCopy> MayOwn(ArrCopyFacts copy, IReadOnlyList<JfCopy> jf, IReadOnlyList<ArrCopyFacts> siblings, IReadOnlySet<Guid> owned)
            => MatchCopies(copy, jf.Where(x => !owned.Contains(x.ItemId)).ToList(), siblings, soleFallback: false, possible: true);

        /// <summary>
        /// The Jellyfin copies of a movie one Radarr copy owns (D53, edition round 19: movies get the series' per-instance
        /// binding): a copy whose title folder is exactly one or more Radarr copies' folders is theirs and nobody else's
        /// (exact-folder precedence, whatever the libraries say); otherwise <see cref="MatchCopies"/>'s match, except a copy that
        /// several instances' linked libraries or path mappings claim alike: a library several Radarrs link proves nothing
        /// about which one's copy it is (conservative ambiguity). <paramref name="siblings"/> are every instance's copies of
        /// the title (never only one edition's).
        /// </summary>
        internal static List<JfCopy> MovieMatches(ArrCopyFacts copy, IReadOnlyList<JfCopy> jf, IReadOnlyList<ArrCopyFacts> siblings)
        {
            var result = new List<JfCopy>();
            if (jf.Count == 0) return result;
            var matched = MatchCopies(copy, jf, siblings);
            var claims = siblings.Where(o => o.Instance.Id != copy.Instance.Id).Select(o => Claimed(o, jf)).Where(x => x != null).ToList();
            var mine = Claimed(copy, jf);
            foreach (var x in jf.DistinctBy(x => x.ItemId))
            {
                var folder = string.IsNullOrWhiteSpace(x.Path) ? null : TitleFolder(Norm(x.Path!), movie: true);
                var folderOwners = folder == null ? new List<ArrCopyFacts>() : siblings.Where(o => HoldsFolder(o, folder)).ToList();
                if (folderOwners.Count > 0)
                {
                    if (folderOwners.Any(o => ReferenceEquals(o, copy) || o.Instance.Id == copy.Instance.Id)) result.Add(x);
                    continue;
                }
                if (!matched.Any(m => m.ItemId == x.ItemId)) continue;
                if (mine?.Any(y => y.ItemId == x.ItemId) == true && claims.Any(other => other!.Any(y => y.ItemId == x.ItemId))) continue;
                result.Add(x);
            }
            return result;
        }

        /// <summary>
        /// The Jellyfin copies an arr copy's instance claims for sure: by its linked libraries, or by the
        /// path mapping that applies to the copy's folder (even when none is there). Null when neither applies.
        /// </summary>
        private static List<JfCopy>? Claimed(ArrCopyFacts copy, IReadOnlyList<JfCopy> jf)
        {
            var linked = copy.Instance.LinkedLibraryIds;
            if (linked.Count > 0)
            {
                var set = new HashSet<string>(linked.Select(NormalizeId), StringComparer.OrdinalIgnoreCase);
                return jf.Where(x => x.LibraryId != null && set.Contains(NormalizeId(x.LibraryId))).ToList();
            }
            var arrPath = ArrPathOf(copy);
            if (string.IsNullOrWhiteSpace(arrPath)) return null;
            var (mapped, mapping) = BridgePaths.Map(arrPath, copy.Instance.PathMappings.ToList());
            if (mapping == null) return null;
            return jf.Where(x => x.Path != null && BridgePaths.IsUnder(x.Path, mapped)).ToList();
        }

        private static string? ArrPathOf(ArrCopyFacts copy) => copy.Path;

        private static string NormalizeId(string id) => id.Replace("-", string.Empty, StringComparison.Ordinal);

        private static string Norm(string path) => path.Replace('\\', '/').TrimEnd('/');

        private static string TitleFolder(string path, bool movie)
        {
            // A movie item's path is its video file (or a disc folder); the title folder is the parent of a file.
            if (!movie) return path;
            var last = path.LastIndexOf('/');
            var name = last >= 0 ? path[(last + 1)..] : path;
            return name.Contains('.', StringComparison.Ordinal) && last > 0 ? path[..last] : path;
        }

        private static string? Tail(string path, int segments)
        {
            var parts = path.Split('/', StringSplitOptions.RemoveEmptyEntries);
            return parts.Length < segments ? null : string.Join('/', parts[^segments..]);
        }

        private static bool FamilyMayFollow(ArrCopyRead copy, CopyState state)
            => copy.Instance.Role != "4k" || state.Stage == StatusStage.Ready;

        private static int RoleOrder(string role) => role switch { "standard" => 0, "anime" => 1, "custom" => 2, _ => 3 };

        private static ArrCopyFacts? PrimarySeriesCopy(TitleFacts facts)
        {
            using var __factsOperation16 = global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.BeginOperation();
            return facts.Copies.Where(c => c.IsSeries).OrderBy(c => RoleOrder(c.Instance.Role)).FirstOrDefault();
        }
        /// <summary>
        /// The Sonarr copy a page or card of one Jellyfin series copy (<paramref name="page"/>, the series item a
        /// series, season or episode is in) reads its arr facts from: only one that owns that copy's folder for sure,
        /// so a 4K copy reads the 4K Sonarr and never another instance's files, downloads or upgrades. In order:
        /// <list type="number">
        /// <item><description>a Sonarr whose series folder is the copy's folder exactly: by its path mapping, else
        /// the same path; two that share the folder: the standard one first;</description></item>
        /// <item><description>else the one Sonarr matched to this copy and to no other copy of the title (a linked
        /// library or path mapping that claims every copy in a shared library tells nothing);</description></item>
        /// <item><description>else by the root and title folder names, only when they pair the copy with one Sonarr
        /// unambiguously: one unmapped Sonarr whose folder ends like this copy's, and no other copy's that way (a
        /// standard and a 4K copy both under ".../TV/Firefly" with no mapping: nobody's);</description></item>
        /// <item><description>else, when it is the title's only Jellyfin copy and only Sonarr copy, that one, unless
        /// its linked library or path mapping leaves the copy out (however its folders are named).</description></item>
        /// </list>
        /// The first rule also holds for the page's own series item as the viewer opens it now (<paramref name="own"/>,
        /// resolved for them: the series page or card itself, or a season's or episode's series), whatever the title's copy
        /// lookup saw: that copy, its access and its folder don't depend on the lookup.
        /// None (null) when ownership can't be established, never a default: also when the copy is unknown (not among the
        /// copies given, or none given) and its own item doesn't sit exactly in a Sonarr's folder, and when the lookup
        /// couldn't finish unless the first rule holds (the others compare the copy with every other copy of the title). A
        /// read of the whole title (no <paramref name="page"/>) follows the primary copy.
        /// </summary>
        internal static ArrCopyFacts? SeriesCopyFor(TitleFacts facts, Guid? page, IReadOnlyList<JfCopy>? copies, JfItemRef? own = null, bool soleFallback = true)
        {
            using var __factsOperation17 = global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.BeginOperation();
            var primary = PrimarySeriesCopy(facts);
            if (primary == null || page is not Guid id) return primary;
            var siblings = SeriesCopies(facts);
            if (own is { Kind: "series", Key: { } ownKey } && own.ItemId == id && ownKey.Title.Equals(facts.Key) && FolderOwner(siblings, own.Path) is { } pinned) return pinned;
            var (known, every) = OwnershipBasis(facts, copies);
            if (known.FirstOrDefault(x => x.ItemId == id) is not { } shown) return null;
            if (FolderOwner(siblings, shown.Path) is { } owner) return owner;
            if (!every) return null;
            var only = siblings.Where(x => MatchCopies(x, known, siblings, soleFallback: false) is var m && m.Any(c => c.ItemId == id) && m.All(c => c.ItemId == id)).ToList();
            if (only.Count == 1) return only[0];
            var named = siblings.Where(x => !Leaves(x, shown, known) && EndsLike(x, shown)).ToList();
            if (named.Count == 1 && !known.Any(c => c.ItemId != id && EndsLike(named[0], c))) return named[0];
            var sole = soleFallback && known.All(x => x.ItemId == id) && siblings.Count == 1;
            return sole && !Leaves(siblings[0], shown, known) ? siblings[0] : null;
        }

        /// <summary>
        /// The Jellyfin copies of a series the 4K Sonarr copies own, by the bindings' ownership rules (D53, edition round 13;
        /// <see cref="SeriesBindings"/>): a copy whose folder is exactly one of theirs (<see cref="HoldsFolder"/>), or one the
        /// pages' rules give a 4K Sonarr (<see cref="SeriesCopyFor"/>), positive matches only (the only copy there is may well
        /// be the standard one). Never every copy of a linked library the 4K Sonarr shares with the standard one.
        /// </summary>
        internal static List<JfCopy> FourKOwnedCopies(TitleFacts facts, IReadOnlyList<JfCopy> copies)
        {
            var fourK = SeriesCopies(facts).Where(x => x.Instance.Role == "4k").ToList();
            if (fourK.Count == 0) return new List<JfCopy>();
            return copies.DistinctBy(x => x.ItemId)
                .Where(x => fourK.Any(f => HoldsFolder(f, x.Path)) || SeriesCopyFor(facts, x.ItemId, copies, soleFallback: false) is { Instance.Role: "4k" })
                .ToList();
        }

        /// <summary>True when an arr copy's linked library or path mapping leaves a Jellyfin copy out (it claims others, or none).</summary>
        private static bool Leaves(ArrCopyFacts copy, JfCopy jf, IReadOnlyList<JfCopy> known)
            => Claimed(copy, known) is { } claim && claim.All(y => y.ItemId != jf.ItemId);

        /// <summary>
        /// The Jellyfin copies which arr copy owns a copy is judged from, and whether they are every copy of the title: the
        /// given ones (a finished lookup's) or, when the lookup couldn't finish, only the ones it saw.
        /// </summary>
        private static (IReadOnlyList<JfCopy> Known, bool Every) OwnershipBasis(TitleFacts facts, IReadOnlyList<JfCopy>? copies)
            => facts.CopiesIncomplete ? (facts.SeenCopies, false) : (copies ?? Array.Empty<JfCopy>(), copies != null);

        /// <summary>The Sonarr copy whose own folder is exactly <paramref name="path"/> (<see cref="HoldsFolder"/>); of two, the standard one.</summary>
        private static ArrCopyFacts? FolderOwner(IReadOnlyList<ArrCopyFacts> siblings, string? path)
            => siblings.Where(x => HoldsFolder(x, path)).OrderBy(x => RoleOrder(x.Instance.Role)).FirstOrDefault();

        /// <summary>
        /// True when an arr copy's own folder is exactly a Jellyfin copy's folder (<paramref name="path"/>): the mapped
        /// folder when the instance's path mapping applies to it, else the same path.
        /// </summary>
        private static bool HoldsFolder(ArrCopyFacts copy, string? path)
        {
            var arrPath = ArrPathOf(copy);
            if (string.IsNullOrWhiteSpace(arrPath) || string.IsNullOrWhiteSpace(path)) return false;
            var (mapped, mapping) = BridgePaths.Map(arrPath, copy.Instance.PathMappings.ToList());
            return BridgePaths.SamePath(mapping != null ? mapped : arrPath, path);
        }

        /// <summary>
        /// True when an arr copy with no path mapping for its folder (one that applies says where it is for sure) has
        /// a folder whose last two names (root folder and title folder) are the Jellyfin copy's.
        /// </summary>
        private static bool EndsLike(ArrCopyFacts copy, JfCopy jf)
        {
            var arrPath = ArrPathOf(copy);
            if (string.IsNullOrWhiteSpace(arrPath) || string.IsNullOrWhiteSpace(jf.Path)) return false;
            if (BridgePaths.Map(arrPath, copy.Instance.PathMappings.ToList()).Mapping != null) return false;
            return Tail(Norm(arrPath), 2) is { } tail && string.Equals(Tail(Norm(jf.Path), 2), tail, StringComparison.OrdinalIgnoreCase);
        }

        private static CopyState NothingKnown(TitleFacts facts)
        {
            using var __factsOperation18 = global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.BeginOperation();
            return facts.Unreadable.Count > 0
                            ? new CopyState(StatusStage.None, StatusReasonCode.ServiceDown)
                            : new CopyState(StatusStage.NotHere, StatusReasonCode.NotInArr);
        }
        private static CopyState ApplyRequest(CopyState state, RequestFacts? request, ComposeContext? c = null, TitleFacts? facts = null, bool? admin = null)
        {
            if (request == null) return state;
            // "Not here" from a Jellyfin lookup that couldn't finish is no proof: it is never read as gone or said no to.
            var proven = facts?.CopiesIncomplete != true;
            // Everything asked for arrived once: no "OK'd! Getting started" again. Gone from Jellyfin and every arr
            // since, it says so; otherwise the copy's own state stands (not being fetched, service down, ...).
            if (request.Fulfilled)
                return proven && state.Stage == StatusStage.NotHere && state.Reason == StatusReasonCode.NotInArr ? new CopyState(StatusStage.NotHere, StatusReasonCode.Removed) : state;
            if (state.Stage is StatusStage.NotHere or StatusStage.None)
            {
                if (request.Declined) return proven ? new CopyState(StatusStage.NotHere, StatusReasonCode.Declined) : state;
                if (request.Pending)
                {
                    // An administrator is the one it waits for: held back at sending, it says why (not "waiting for you").
                    return (admin ?? c?.Viewer.IsAdmin) == true && request.HeldReason is { } held
                        ? new CopyState(StatusStage.Asked, StatusReasonCode.AwaitingApproval, Attention: true, Since: request.AskedAt, Params: Params(("held", held)))
                        : new CopyState(StatusStage.Asked, StatusReasonCode.AwaitingApproval, Since: request.AskedAt);
                }
                if (request.ApprovedAt is DateTime approved)
                {
                    // Sonarr doesn't list what was asked for yet: nothing can be fetched before it does.
                    if (request.NotListed) return new CopyState(StatusStage.Approved, StatusReasonCode.NotAired, Since: approved);
                    // Held after its OK until a person sorts it out: taking longer than usual (the Approvals card says why).
                    if (request.HeldAfterOk) return new CopyState(StatusStage.Approved, StatusReasonCode.ApprovedNotInArr, Attention: true, Since: approved);
                    return HandoffOverdueSince(state, request, c, facts) is DateTime overdue
                        ? new CopyState(StatusStage.Approved, StatusReasonCode.ApprovedNotInArr, Attention: true, Since: overdue)
                        : new CopyState(StatusStage.Approved, StatusReasonCode.Approved, Since: approved);
                }
            }
            return state;
        }

        /// <summary>
        /// When an OK'd request has waited too long for any Sonarr/Radarr to hold the title (the OK of
        /// the overdue variant), else null. Judged per variant: a 4K request on the 4K instances, a
        /// standard one on the others; a variant counts only when JE watches at least one instance of
        /// it, every one of those could be read and none failed its latest read (<see cref="TitleFacts.Stale"/>),
        /// none holds the title (<paramref name="state"/> is "not in any arr"), and the grace period for
        /// this viewer has passed (administrators: the configured grace; everyone else: the "still
        /// looking" hours). Request facts that don't say which variant was OK'd are judged on every
        /// instance. Phase 2 only.
        /// </summary>
        internal static DateTime? HandoffOverdueSince(CopyState state, RequestFacts request, ComposeContext? c, TitleFacts? facts)
        {
            if (state.Reason != StatusReasonCode.NotInArr) return null;
            return OverdueVariant(request, c, facts)?.At;
        }

        /// <summary>
        /// The earliest overdue variant of an OK'd request (when it was OK'd, and whether it is the
        /// 4K one), each variant judged on its own instances whatever the others hold (see
        /// <see cref="HandoffOverdueSince"/>); null when none is.
        /// </summary>
        private static (DateTime At, bool FourK)? OverdueVariant(RequestFacts? request, ComposeContext? c, TitleFacts? facts)
        {
            using var __factsOperation19 = global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.BeginOperation();
            if (request == null || c?.HandoffGrace is not TimeSpan grace) return null;
            if (facts == null || facts.Checked.Count == 0) return null;
            var wait = c.Viewer.IsAdmin ? grace : TimeSpan.FromHours(c.LookingHours);
            var variants = request.ApprovedStandardAt == null && request.Approved4kAt == null
                ? new[] { (At: request.ApprovedAt, FourK: false, Of: (Func<ArrConnection, bool>)(_ => true)) }
                : new[]
                {
                    // A variant Seerr says is done (completed, or available) is never overdue.
                    (At: request.StandardDone ? null : request.ApprovedStandardAt, FourK: false, Of: (Func<ArrConnection, bool>)(i => i.Role != "4k")),
                    (At: request.FourKDone ? null : request.Approved4kAt, FourK: true, Of: (Func<ArrConnection, bool>)(i => i.Role == "4k")),
                };
            (DateTime At, bool FourK)? overdue = null;
            foreach (var (at, fourK, of) in variants)
            {
                if (at is not DateTime approvedAt || c.Now - approvedAt < wait) continue;
                if (!facts.Checked.Any(of) || facts.Stale.Any(of) || facts.Unreadable.Any(u => of(u.Instance)) || facts.Copies.Any(x => of(x.Instance))) continue;
                if (overdue == null || approvedAt < overdue.Value.At) overdue = (approvedAt, fourK);
            }
            return overdue;
        }

        /// <summary>
        /// A whole title's admin block with the "OK'd in Seerr, but none of the Sonarr/Radarr JE
        /// watches has it" line: for the headline when that is its reason, otherwise for any
        /// variant that is overdue on its own while another variant's copy drives the headline
        /// (the 4K copy held, the standard one never handed over: one variant never hides the other).
        /// </summary>
        private static AdminStatus? WithTitleHandoff(AdminStatus? admin, CopyState headline, TitleFacts facts, ComposeContext c)
        {
            var overdue = OverdueVariant(facts.Request, c, facts);
            // The headline's own line keeps which variant it is about (a 4K request's wording).
            if (headline.Reason == StatusReasonCode.ApprovedNotInArr) return WithHandoff(admin, headline, overdue?.FourK == true);
            if (facts.Request is { } request && (request.ApprovedStandardAt != null || request.Approved4kAt != null) && overdue is { } other)
                return WithHandoff(admin, other.At, other.FourK);
            return WithHandoff(admin, headline);
        }

        /// <summary>
        /// The admin block with the "OK'd in Seerr, but no Sonarr/Radarr has it" line when that is the
        /// headline reason, and without one it inherited otherwise (a scoped status keeps the whole
        /// title's block, whose line may be about another part). <paramref name="fourK"/>: about a
        /// 4K request, judged on the 4K instances.
        /// </summary>
        private static AdminStatus? WithHandoff(AdminStatus? admin, CopyState headline, bool fourK = false)
            => WithHandoff(admin, headline.Reason == StatusReasonCode.ApprovedNotInArr ? headline.Since : null, fourK);

        private static AdminStatus? WithHandoff(AdminStatus? admin, DateTime? handoffSince, bool fourK)
        {
            if (admin == null || (handoffSince == null && admin.ApprovedNotInArrSince == null && admin.ApprovedNotIn4k == null)) return admin;
            return new AdminStatus
            {
                Variants = admin.Variants,
                Unreadable = admin.Unreadable,
                ApprovedNotInArrSince = handoffSince,
                ApprovedNotIn4k = handoffSince != null && fourK ? true : null,
            };
        }

        /// <summary>
        /// The facts as the 4K instances alone know them: their copies, and which of them were read,
        /// couldn't be read or failed their latest read. A 4K request is judged on these, as the
        /// Overview's Needs attention list judges it.
        /// </summary>
        internal static TitleFacts FourKOnly(TitleFacts facts)
        {
            using var __factsOperation20 = global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.BeginOperation();
            var fourK = new TitleFacts(facts.Key) { Request = facts.Request, LiveKey = facts.LiveKey, CopiesIncomplete = facts.CopiesIncomplete, SeenCopies = facts.SeenCopies };
            fourK.Copies.AddRange(facts.Copies.Where(x => x.Instance.Role == "4k"));
            fourK.Unreadable.AddRange(facts.Unreadable.Where(u => u.Instance.Role == "4k"));
            fourK.Stale.AddRange(facts.Stale.Where(i => i.Role == "4k"));
            fourK.Checked.AddRange(facts.Checked.Where(i => i.Role == "4k"));
            return fourK;
        }

        /// <summary>A copy of the facts (every instance's), for an edition any copy satisfies (see <see cref="RequestedEdition"/>).</summary>
        internal static TitleFacts EveryEdition(TitleFacts facts)
        {
            using var __factsOperation22 = global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.BeginOperation();
            var every = new TitleFacts(facts.Key) { Request = facts.Request, LiveKey = facts.LiveKey, CopiesIncomplete = facts.CopiesIncomplete, SeenCopies = facts.SeenCopies };
            every.Copies.AddRange(facts.Copies);
            every.Unreadable.AddRange(facts.Unreadable);
            every.Stale.AddRange(facts.Stale);
            every.Checked.AddRange(facts.Checked);
            return every;
        }

        /// <summary>
        /// The facts as the standard (every non-4K) instance knows them: a standard request needing a non-4K copy is
        /// judged on these (see <see cref="FourKOnly"/>).
        /// </summary>
        internal static TitleFacts StandardOnly(TitleFacts facts)
        {
            using var __factsOperation24 = global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.BeginOperation();
            var standard = new TitleFacts(facts.Key) { Request = facts.Request, LiveKey = facts.LiveKey, CopiesIncomplete = facts.CopiesIncomplete, SeenCopies = facts.SeenCopies };
            standard.Copies.AddRange(facts.Copies.Where(x => x.Instance.Role != "4k"));
            standard.Unreadable.AddRange(facts.Unreadable.Where(u => u.Instance.Role != "4k"));
            standard.Stale.AddRange(facts.Stale.Where(i => i.Role != "4k"));
            standard.Checked.AddRange(facts.Checked.Where(i => i.Role != "4k"));
            return standard;
        }

        /// <summary>
        /// A copy whose instance's downloads can't be known now (its queue or history expired): not
        /// "looking", not "downloading". Counted as not here yet (a series isn't "Ready" for it).
        /// </summary>
        private static CopyState Unknown() => new(StatusStage.Looking, StatusReasonCode.ServiceDown);

        /// <summary>
        /// Monitored, out, no file and nothing under way: "looking" while it is fresh, "no release yet"
        /// (shown as Missing with a Search button) once nothing was grabbed for longer than LookingHours.
        /// <paramref name="lastSearch"/> is when the arr last searched for it (admin line), if it says.
        /// <paramref name="sent"/>: a request covering it already went out, so a household Search runs without a new
        /// request (and so without a new OK): the missing state then says so in its <c>sent</c> parameter and the Search
        /// buttons read plain "Search".
        /// </summary>
        private static CopyState Looking(DateTime? since, ComposeContext c, DateTime? lastSearch = null, bool sent = false)
        {
            var longer = since.HasValue && c.Now - since.Value > TimeSpan.FromHours(c.LookingHours);
            return new CopyState(StatusStage.Looking, longer ? StatusReasonCode.NoReleaseYet : StatusReasonCode.Looking, Since: since, LastSearch: Valid(lastSearch),
                Params: longer && sent ? Params(("sent", "1")) : null);
        }

        /// <summary>
        /// The moment a download of this movie/episode left the queue, while the snapshot that says
        /// "no file" is older than that moment (the import is most likely happening); else null.
        /// </summary>
        private static DateTime? Departed(ArrCopyRead copy, int? movieId, int? episodeId, DateTime? snapshotAt)
        {
            if (copy.LeftQueue?.Invoke(movieId, episodeId) is not DateTime left) return null;
            return snapshotAt == null || snapshotAt.Value <= left ? left : null;
        }

        private static bool IsGrab(ArrHistoryEntry h) => string.Equals(h.EventType, "grabbed", StringComparison.OrdinalIgnoreCase);

        private static bool IsImport(ArrHistoryEntry h) => h.EventType != null && h.EventType.EndsWith("Imported", StringComparison.OrdinalIgnoreCase);

        private static bool IsFileGone(ArrHistoryEntry h) => h.EventType != null && h.EventType.EndsWith("FileDeleted", StringComparison.OrdinalIgnoreCase);

        private static DateTime? Newest(IReadOnlyList<ArrHistoryEntry> history, int? episodeId, Func<ArrHistoryEntry, bool> match, int? season = null, int? episode = null)
        {
            foreach (var h in history)
            {
                if (episodeId.HasValue && h.EpisodeId != episodeId && !(h.EpisodeId == null && h.SeasonNumber == season && h.EpisodeNumber == episode)) continue;
                if (!episodeId.HasValue && season.HasValue && !(h.SeasonNumber == season && h.EpisodeNumber == episode)) continue;
                if (match(h)) return h.Date;
            }
            return null;
        }

        /// <summary>The newest import of the title when no later grab or file deletion followed it (within <paramref name="window"/>).</summary>
        private static DateTime? RecentImport(ArrCopyRead copy, ComposeContext c, TimeSpan? window = null)
            => RecentImportIn(copy.History, c.Now, window ?? RecentArrival);

        /// <summary>The newest import in a history (newest first) when no later grab or file deletion followed it, within <paramref name="window"/> of <paramref name="now"/>.</summary>
        internal static DateTime? RecentImportIn(IReadOnlyList<ArrHistoryEntry> history, DateTime now, TimeSpan window)
        {
            foreach (var h in history)
            {
                if (IsImport(h)) return h.Date is DateTime d && now - d <= window ? d : null;
                if (IsGrab(h) || IsFileGone(h)) return null;
            }
            return null;
        }

        private static DateTime? RecentEpisodeImport(ArrCopyRead copy, int season, int episode, ArrEpisodeEntry? arr, ComposeContext c, TimeSpan? window = null)
        {
            foreach (var h in copy.History)
            {
                var same = arr != null ? h.EpisodeId == arr.Id : h.SeasonNumber == season && h.EpisodeNumber == episode;
                if (!same) continue;
                if (IsImport(h)) return h.Date is DateTime d && c.Now - d <= (window ?? RecentArrival) ? d : null;
                if (IsGrab(h) || IsFileGone(h)) return null;
            }
            return null;
        }

        private static DateTime? RecentFailure(IReadOnlyList<ArrHistoryEntry> history, int? episodeId, ComposeContext c)
        {
            foreach (var h in history)
            {
                if (episodeId.HasValue && h.EpisodeId != episodeId) continue;
                if (string.Equals(h.EventType, "downloadFailed", StringComparison.OrdinalIgnoreCase))
                    return h.Date is DateTime d && c.Now - d <= FailedShownFor ? d : null;
                if (IsGrab(h) || IsImport(h)) return null;
            }
            return null;
        }

        private static StatusReason Reason(CopyState state)
        {
            var p = state.Params != null ? new Dictionary<string, string>(state.Params) : new Dictionary<string, string>();
            if (state.Date is DateTime date) p["date"] = state.DateIsDay ? DayOf(date) : Iso(date);
            if (state.Since is DateTime since && state.Reason is StatusReasonCode.NoReleaseYet or StatusReasonCode.Looking or StatusReasonCode.LibraryPending or StatusReasonCode.ImportBlocked or StatusReasonCode.Stalled)
                p["since"] = Iso(since);
            return new StatusReason { Code = state.Reason, Params = p.Count > 0 ? p : null };
        }

        private static IReadOnlyDictionary<string, string> Params(params (string Key, string Value)[] pairs)
            => pairs.ToDictionary(p => p.Key, p => p.Value);

        private static string Iso(DateTime d) => DateTime.SpecifyKind(d.Kind == DateTimeKind.Local ? d.ToUniversalTime() : d, DateTimeKind.Utc).ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture);

        private static string Id(Guid id) => id.ToString("N", CultureInfo.InvariantCulture);

        /// <summary>A calendar day as "yyyy-MM-dd" (the UTC date of a date-only value).</summary>
        internal static string DayOf(DateTime d) => (d.Kind == DateTimeKind.Local ? d.ToUniversalTime() : d).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

        internal static DateTime? Valid(DateTime? d) => d.HasValue && d.Value.Year > 1900 ? d : null;

        private static DateTime? Latest(DateTime? a, DateTime? b) => a == null ? b : b == null ? a : (a > b ? a : b);

        /// <summary>When a request covering this part of the copy's edition (4K instance or not) last went out, or null.</summary>
        private static DateTime? SentFor(RequestFacts? request, ArrCopyRead copy, int? season, int? episode, ComposeContext c)
            => c.RequestClock ? Valid(request?.SentFor(copy.Instance.Role == "4k", season, episode)) : null;
    }
}
