using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Arr;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire
{
    /// <summary>What one arr instance knows about a title (user-independent; read from the snapshots).</summary>
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

        /// <summary>The series (Sonarr).</summary>
        public ArrSeriesEntry? Series { get; init; }

        /// <summary>Queue rows of this title.</summary>
        public IReadOnlyList<ArrQueueEntry> Queue { get; init; } = Array.Empty<ArrQueueEntry>();

        /// <summary>History of this title, newest first.</summary>
        public IReadOnlyList<ArrHistoryEntry> History { get; init; } = Array.Empty<ArrHistoryEntry>();

        /// <summary>Episodes (Sonarr), when held in memory.</summary>
        public ArrEpisodesSnapshot? Episodes { get; init; }

        /// <summary>When the library snapshot this copy came from was read (UTC).</summary>
        public DateTime? LibraryLoadedAt { get; init; }

        /// <summary>When <see cref="Episodes"/> was read (UTC).</summary>
        public DateTime? EpisodesLoadedAt { get; init; }

        /// <summary>When a download of a movie (Radarr id) or episode (Sonarr id) recently left the queue (UTC), if it did.</summary>
        public Func<int?, int?, DateTime?>? LeftQueue { get; init; }

        /// <summary>JE's first-seen clocks of the queue rows (null: the arr's added time is used).</summary>
        public Func<ArrQueueEntry, ArrQueueSeen?>? Seen { get; init; }

        /// <summary>When the queue <see cref="Queue"/> came from was read (UTC); the arr's "time left" counts from then.</summary>
        public DateTime? QueueLoadedAt { get; init; }

        /// <summary>The queue is past its freshness target (a refresh is on its way): no time left is given.</summary>
        public bool QueueStale { get; init; }

        /// <summary>
        /// The instance's queue or history is past its longest serve time and can't be read: what it
        /// is downloading is unknown (<see cref="Queue"/> is then empty). Never "looking" or
        /// "downloading": <see cref="StatusReasonCode.ServiceDown"/>, unless the library says the file is there.
        /// </summary>
        public bool QueueUnknown { get; init; }
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
            Key = key;
        }

        /// <summary>The title (movie or series) key.</summary>
        public TitleKey Key { get; }

        /// <summary>One entry per instance holding the title.</summary>
        public List<ArrCopyFacts> Copies { get; } = new();

        /// <summary>Instances of the title's kind that could not be read (with "name (kind)" labels).</summary>
        public List<UnreadableArr> Unreadable { get; } = new();

        /// <summary>
        /// Instances whose library is held from an earlier read but whose latest read failed: what
        /// they hold may have changed since, so "no Sonarr/Radarr has it" can't be said.
        /// </summary>
        public List<ArrConnection> Stale { get; } = new();

        /// <summary>
        /// Instances of the title's kind whose library could be read (holding the title or not). None:
        /// no Sonarr/Radarr of its kind is set up (or none could be read), so "none has it" can't be said.
        /// </summary>
        public List<ArrConnection> Checked { get; } = new();

        /// <summary>Request facts (Seerr read model), if any.</summary>
        public RequestFacts? Request { get; set; }

        /// <summary>The key the change feed announces the title under, when an arr copy names it differently (see <see cref="TitleStatus.LiveKey"/>).</summary>
        public TitleKey? LiveKey { get; set; }
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

        /// <summary>A date still to come: an instant after now, or a date-only day still ahead somewhere.</summary>
        private static bool NotYet(DateTime date, bool isDay, DateTime now) => isDay ? DayStillAhead(date, now) : date > now;

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
        public static TitleStatus Movie(TitleFacts facts, JfItemRef? item, IReadOnlyList<JfCopy>? copies, ComposeContext c, bool detail)
        {
            var jf = copies ?? (item != null ? new[] { new JfCopy { ItemId = item.ItemId, Visible = true, Path = item.Path, DateCreated = item.DateCreated, LibraryId = item.LibraryId, LibraryName = item.LibraryName } } : Array.Empty<JfCopy>());
            var variants = new List<(ArrCopyFacts Copy, CopyState State, JfCopy? Jf)>();
            var movieCopies = facts.Copies.Where(x => x.Movie != null).ToList();
            foreach (var copy in movieCopies)
            {
                var matched = MatchCopies(copy, jf, movieCopies);
                var own = item != null ? matched.FirstOrDefault(m => m.ItemId == item.ItemId) : null;
                var visible = own ?? matched.FirstOrDefault(m => m.Visible);
                CopyState state;
                if (visible != null)
                {
                    state = copy.Queue.Count > 0
                        ? new CopyState(StatusStage.Ready, StatusReasonCode.Upgrading, Progress: Progress(copy.Queue[0], c, copy), Since: visible.DateCreated, Row: copy.Queue[0])
                        : new CopyState(StatusStage.Ready, StatusReasonCode.Ready, Since: visible.DateCreated);
                }
                else if (matched.Count > 0)
                {
                    state = new CopyState(StatusStage.NotHere, StatusReasonCode.NotVisibleToUser, Since: matched[0].DateCreated);
                }
                else
                {
                    state = MovieFromArr(copy, c, facts.Request);
                }
                variants.Add((copy, state, visible ?? matched.FirstOrDefault()));
            }

            // The headline: the item asked for is ready by definition (the viewer opened it); on the key
            // path, the best copy the viewer could open (4K copies only when their item is visible).
            CopyState headline;
            ArrCopyFacts? headlineCopy = null;
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
                    headline = new CopyState(StatusStage.Ready, StatusReasonCode.Ready, Since: item.DateCreated);
                }
            }
            else if (jf.Any(x => x.Visible))
            {
                var best = variants.Where(v => v.State.Stage == StatusStage.Ready).Select(v => (v.Copy, v.State)).FirstOrDefault();
                headline = best.State ?? new CopyState(StatusStage.Ready, StatusReasonCode.Ready, Since: jf.First(x => x.Visible).DateCreated);
                headlineCopy = best.Copy;
            }
            else
            {
                // Jellyfin has it only in libraries a family member can't open: the copies that are (or
                // may be) those hidden items are left out, so the answer is the one they would get if
                // the hidden copies didn't exist (a title nobody has, when nothing else is left).
                var hiddenCopies = !c.Viewer.IsAdmin && jf.Count > 0;
                var eligible = variants.Where(v => c.Viewer.IsAdmin || (FamilyMayFollow(v.Copy, v.State) && !(hiddenCopies && MayBeHiddenCopy(v.Copy, v.State, c)))).ToList();
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
            var admin = c.Viewer.IsAdmin ? WithTitleHandoff(AdminFor(facts, variants.Select(v => (v.Copy, v.State, v.Jf)).ToList(), null), headline, facts, c) : null;
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
                Journey = detail ? MovieJourney(headline, headlineCopy, item, jf, facts.Request, c) : null,
                Admin = admin,
            };
        }

        /// <summary>
        /// A movie copy that is, or may be, a Jellyfin copy the viewer can't open: matched to one, or
        /// unmatched while it has a file or a recent import.
        /// </summary>
        private static bool MayBeHiddenCopy(ArrCopyFacts copy, CopyState state, ComposeContext c)
            => state.Reason == StatusReasonCode.NotVisibleToUser || copy.Movie!.HasFile || RecentImport(copy, c, TimeSpan.FromDays(30)) != null;

        /// <summary>
        /// A movie copy that is not (visibly) in Jellyfin: where the arr has got to. A request that went
        /// out for it (<paramref name="request"/>) restarts the "still looking" clock.
        /// </summary>
        internal static CopyState MovieFromArr(ArrCopyFacts copy, ComposeContext c, RequestFacts? request = null)
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
                Admin = c.Viewer.IsAdmin ? WithHandoff(AdminFor(facts, new List<(ArrCopyFacts, CopyState, JfCopy?)>(), null), state) : null,
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
                Admin = c.Viewer.IsAdmin ? AdminFor(facts, new List<(ArrCopyFacts, CopyState, JfCopy?)>(), null) : null,
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
                Admin = c.Viewer.IsAdmin ? AdminFor(facts, new List<(ArrCopyFacts, CopyState, JfCopy?)>(), null) : null,
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
        public static TitleStatus Series(TitleFacts facts, JfItemRef item, IReadOnlyList<JfEpisode>? jfEpisodes, IReadOnlyList<JfSeason>? jfSeasons, ComposeContext c, bool detail, IReadOnlyList<JfCopy>? copies = null)
        {
            var (visibleEpisodes, hidden) = SplitHidden(jfEpisodes, jfSeasons);
            jfEpisodes = visibleEpisodes;
            var copy = PrimarySeriesCopy(facts);
            if (copy == null)
            {
                var none = ApplyRequest(NothingKnown(facts), facts.Request, c, facts);
                var hasEpisodes = jfEpisodes?.Any(e => !e.Virtual) == true;
                return new TitleStatus
                {
                    Key = facts.Key.ToString(), ItemId = Id(item.ItemId), Kind = "series",
                    Stage = hasEpisodes ? StatusStage.Ready : none.Stage,
                    Reason = Reason(none), Quiet = !none.Attention || hasEpisodes, Attention = none.Attention && !hasEpisodes,
                    Admin = c.Viewer.IsAdmin ? WithHandoff(AdminFor(facts, new List<(ArrCopyFacts, CopyState, JfCopy?)>(), null), none) : null,
                };
            }

            var seasons = SeasonNumbers(copy, jfEpisodes).Where(s => s > 0 && !hidden.Seasons.Contains(s)).ToList();
            var perSeason = new List<SeasonStatus>();
            var all = new List<(int Season, CopyState State, ArrEpisodeEntry? Arr, int Episode)>();
            foreach (var s in seasons)
            {
                var episodes = EpisodeStates(copy, s, jfEpisodes, c, hidden, facts.Request);
                all.AddRange(episodes.Select(e => (s, e.State, e.Arr, e.Episode)));
                var summary = copy.Episodes != null ? Summarize(episodes.Select(e => (e.State, e.Arr, s, e.Episode)).ToList(), c) : SeasonFromStats(copy, s, jfEpisodes, c, hidden);
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
                Aired = total.Aired, Ready = total.Ready, Downloading = total.Downloading, AlmostReady = total.AlmostReady,
                Missing = total.Missing, Unknown = total.Unknown, Attention = total.Attention,
                LongMissing = total.LongMissing, LongMissingSince = total.LongMissingSince, LongMissingSent = total.LongMissingSent,
                NextAir = total.NextAir ?? (copy.Series!.NextAiring is DateTime n && n > c.Now ? n : null),
                NextAirIsDay = total.NextAir.HasValue && total.NextAirIsDay,
                NextSeason = total.NextSeason, NextEpisode = total.NextEpisode,
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
                var variants = new List<(ArrCopyFacts, CopyState, JfCopy?)> { (copy, Overall(stage, total), null) };
                var problems = all.Where(e => e.State.Attention).Select(e => (copy, e.Season, e.Episode, e.State)).ToList();
                otherProblems = AddOtherSeriesCopies(facts, copy, copies, null, null, c, variants, problems);
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

        /// <summary>A season page (or card): summary, and with <paramref name="detail"/> every episode.</summary>
        public static TitleStatus Season(TitleFacts facts, JfItemRef item, IReadOnlyList<JfEpisode>? jfEpisodes, ComposeContext c, bool detail, IReadOnlyList<JfCopy>? copies = null)
        {
            var (visibleEpisodes, hidden) = SplitHidden(jfEpisodes, null);
            jfEpisodes = visibleEpisodes;
            var season = item.Season ?? 0;
            var key = facts.Key.WithSeason(season).ToString();
            var copy = PrimarySeriesCopy(facts);
            if (copy == null)
            {
                return new TitleStatus
                {
                    Key = key, ItemId = Id(item.ItemId), Kind = "season", Stage = StatusStage.None,
                    Reason = Reason(NothingKnown(facts)), Quiet = true,
                    Admin = c.Viewer.IsAdmin ? AdminFor(facts, new List<(ArrCopyFacts, CopyState, JfCopy?)>(), null) : null,
                };
            }
            var episodes = EpisodeStates(copy, season, jfEpisodes, c, hidden, facts.Request);
            var summary = copy.Episodes != null ? Summarize(episodes.Select(e => (e.State, e.Arr, season, e.Episode)).ToList(), c) : SeasonFromStats(copy, season, jfEpisodes, c, hidden);
            var stage = SummaryStage(summary);
            var progress = episodes.Where(e => e.State.Stage == StatusStage.Downloading && e.State.Progress != null).Select(e => e.State.Progress!).ToList();
            List<EpisodeStatus>? list = null;
            if (detail)
            {
                list = episodes.Select(e => new EpisodeStatus
                {
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
            var quiet = summary.Downloading == 0 && summary.AlmostReady == 0 && summary.Attention == 0 && summary.Missing == 0
                && !(summary.NextAir is DateTime next && next - c.Now <= UpcomingShownWithin);
            AdminStatus? admin = null;
            var otherProblems = false;
            if (c.Viewer.IsAdmin)
            {
                var variants = new List<(ArrCopyFacts, CopyState, JfCopy?)> { (copy, Overall(stage, summary), null) };
                var problems = episodes.Where(e => e.State.Attention).Select(e => (copy, season, e.Episode, e.State)).ToList();
                otherProblems = AddOtherSeriesCopies(facts, copy, copies, season, null, c, variants, problems);
                admin = AdminFor(facts, variants, problems);
            }
            return new TitleStatus
            {
                Key = key,
                ItemId = Id(item.ItemId),
                Kind = "season",
                Stage = stage,
                Reason = Reason(Overall(stage, summary)),
                Attention = summary.Attention > 0 || otherProblems,
                Quiet = quiet && !otherProblems,
                Progress = progress.Count == 1 ? progress[0] : null,
                NextDate = summary.NextAir,
                NextDay = summary.NextAirIsDay && summary.NextAir is DateTime day ? DayOf(day) : null,
                Summary = summary,
                Episodes = list,
                Admin = admin,
            };
        }

        /// <summary>An episode page (or card); a virtual episode shows where the arr has got to.</summary>
        public static TitleStatus Episode(TitleFacts facts, JfItemRef item, ComposeContext c, bool detail, IReadOnlyList<JfCopy>? copies = null)
        {
            var season = item.Season ?? 0;
            var number = item.Episode ?? 0;
            var copy = PrimarySeriesCopy(facts);
            CopyState state;
            ArrEpisodeEntry? arr = null;
            if (!item.Virtual)
            {
                arr = copy?.Episodes?.Find(season, number);
                var rows = copy == null ? Array.Empty<ArrQueueEntry>() : RowsFor(copy, season, number, arr);
                state = rows.Count > 0
                    ? new CopyState(StatusStage.Ready, StatusReasonCode.Upgrading, Progress: Progress(rows[0], c, copy), Since: item.DateCreated, Row: rows[0])
                    : new CopyState(StatusStage.Ready, StatusReasonCode.Ready, Since: item.DateCreated);
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
                var variants = new List<(ArrCopyFacts, CopyState, JfCopy?)>();
                var problems = new List<(ArrCopyFacts, int, int, CopyState)>();
                if (copy != null)
                {
                    variants.Add((copy, state, null));
                    otherProblems = AddOtherSeriesCopies(facts, copy, copies, season, number, c, variants, problems);
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
        /// library page of series posters costs no per-series episode reads. Quiet otherwise.
        /// Queue rows of episodes or seasons Jellyfin hides from the viewer (<paramref name="hidden"/>)
        /// don't count.
        /// </summary>
        public static TitleStatus SeriesCard(TitleFacts facts, JfItemRef item, ComposeContext c, HiddenParts? hidden = null)
        {
            var copy = PrimarySeriesCopy(facts);
            var states = copy?.Queue.Where(r => hidden?.Hides(r.SeasonNumber, r.EpisodeNumber) != true).Select(r => (Row: r, State: FromQueue(r, c, copy))).ToList() ?? new List<(ArrQueueEntry Row, CopyState State)>();
            int Count(Func<CopyState, bool> f) => states.Where(x => f(x.State)).Select(x => x.Row.EpisodeId ?? x.Row.Id).Distinct().Count();
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
                var problems = states.Where(x => x.State.Attention).Select(x => (copy, x.Row.SeasonNumber ?? 0, x.Row.EpisodeNumber ?? 0, x.State)).ToList();
                // Other instances (4K, anime): their problems only, as the card reads no episodes.
                foreach (var other in OtherSeriesCopies(facts, copy))
                {
                    var found = QueueProblems(other, null, null, c);
                    otherProblems |= found.Count > 0;
                    problems.AddRange(found);
                }
                admin = AdminFor(facts, new List<(ArrCopyFacts, CopyState, JfCopy?)>(), problems);
            }
            return new TitleStatus
            {
                Key = facts.Key.ToString(),
                ItemId = Id(item.ItemId),
                Kind = "series",
                Stage = stage,
                Reason = new StatusReason { Code = stage == StatusStage.Ready ? StatusReasonCode.Ready : SummaryReason(summary) },
                Attention = summary.Attention > 0 || otherProblems,
                Quiet = states.Count == 0 && !otherProblems,
                Progress = progress.Count == 1 ? progress[0] : null,
                Summary = summary,
                Admin = admin,
            };
        }

        /// <summary>
        /// A series asked for by key (no Jellyfin item given): the best copy for the viewer. Queue rows
        /// of episodes or seasons Jellyfin hides from the viewer (<paramref name="hidden"/>) don't count.
        /// </summary>
        public static TitleStatus SeriesByKey(TitleFacts facts, IReadOnlyList<JfCopy> copies, ComposeContext c, HiddenParts? hidden = null)
        {
            var visible = copies.Any(x => x.Visible);
            var copy = PrimarySeriesCopy(facts);
            var family = SeriesCopyForViewer(facts, copies, c);
            var state = family == null
                ? (visible ? new CopyState(StatusStage.Ready, StatusReasonCode.Ready) : NothingKnown(facts))
                : SeriesCopyState(WithoutHiddenRows(family, hidden), visible, c, facts.Request);
            if (!visible && copies.Count > 0 && c.Viewer.IsAdmin && state.Stage == StatusStage.AlmostReady)
            {
                // An admin is told why.
                state = new CopyState(StatusStage.NotHere, StatusReasonCode.NotVisibleToUser);
            }
            state = ApplyRequest(state, facts.Request, c, facts);
            AdminStatus? admin = null;
            if (c.Viewer.IsAdmin)
            {
                var variants = new List<(ArrCopyFacts, CopyState, JfCopy?)>();
                var problems = new List<(ArrCopyFacts, int, int, CopyState)>();
                if (copy != null)
                {
                    variants.Add((copy, state, MatchCopies(copy, copies, SeriesCopies(facts)).FirstOrDefault() ?? copies.FirstOrDefault()));
                    AddOtherSeriesCopies(facts, copy, copies, null, null, c, variants, problems);
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
        /// The Sonarr copy a series asked about by key is judged by for this viewer: the primary one,
        /// except for a family member whose only Jellyfin copies are in libraries they can't open.
        /// Then the Sonarr copies that are (or may be) those hidden series are left out, so the answer
        /// is the one they would get if the hidden copies didn't exist (a title nobody has, when
        /// nothing else is left: null).
        /// </summary>
        private static ArrCopyFacts? SeriesCopyForViewer(TitleFacts facts, IReadOnlyList<JfCopy> copies, ComposeContext c)
        {
            if (copies.Count == 0 || copies.Any(x => x.Visible) || c.Viewer.IsAdmin) return PrimarySeriesCopy(facts);
            var siblings = SeriesCopies(facts);
            return siblings
                .Where(x => MatchCopies(x, copies, siblings).Count == 0 && x.Series!.EpisodeFileCount == 0 && RecentImport(x, c, TimeSpan.FromDays(30)) == null)
                .OrderBy(x => RoleOrder(x.Instance.Role))
                .FirstOrDefault();
        }

        /// <summary>
        /// The seasons (and single episodes) a request asked for, by key (the Requests page): where those parts have got
        /// to rather than the whole series, so a request for a missing season of a series already in Jellyfin isn't
        /// "Ready". Ready only when every requested season is (Sonarr's monitored episodes of it all in Jellyfin, or,
        /// with no Sonarr copy, at least one of its episodes) and every requested episode is in Jellyfin; otherwise the
        /// parts still to come decide the stage, and the request facts fill in when no arr is working on them. Also
        /// returns when the newest of those episodes arrived. <paramref name="episodes"/> are single episodes asked for
        /// outside the requested seasons (their own state each, from Sonarr's episode list when it is in memory, else
        /// from the queue). <paramref name="series"/> is the whole-series status (its admin block is kept);
        /// <paramref name="copies"/> are the series' Jellyfin copies as the viewer sees them: a family member whose
        /// copies are all in libraries they can't open learns nothing from the Sonarr copies that are (or may be)
        /// those (as <see cref="SeriesByKey"/>).
        /// </summary>
        public static (TitleStatus Status, DateTime? ArrivedAt) RequestedSeasons(TitleFacts facts, TitleStatus series, IReadOnlyList<int> seasons, IReadOnlyList<JfEpisode>? jfEpisodes, IReadOnlyList<JfCopy> copies, ComposeContext c, bool only4k = false, IReadOnlyList<(int Season, int Episode)>? episodes = null)
        {
            var (visibleEpisodes, hidden) = SplitHidden(jfEpisodes, null);
            var wanted = new HashSet<int>(seasons);
            var all = visibleEpisodes ?? Array.Empty<JfEpisode>();
            var real = all.Where(e => !e.Virtual && wanted.Contains(e.Season)).ToList();
            // Single episodes outside the requested seasons, with the Jellyfin episode that has each (if any).
            var picked = (episodes ?? Array.Empty<(int Season, int Episode)>()).Where(p => !wanted.Contains(p.Season)).Distinct()
                .Select(p => (Part: p, Have: all.FirstOrDefault(e => !e.Virtual && e.Season == p.Season && new EpisodeRange(e.Episode, e.EpisodeEnd).Contains(p.Episode))))
                .ToList();
            var arrived = real.Select(e => e.DateCreated).Concat(picked.Where(p => p.Have != null).Select(p => p.Have!.DateCreated))
                .Where(d => d.HasValue).DefaultIfEmpty(null).Max();
            var copy = SeriesCopyForViewer(facts, copies, c);
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
                    ? EpisodeStates(copy, n, visibleEpisodes, c, hidden, facts.Request).Select(e => (e.State, e.Arr, Season: n, e.Episode)).ToList()
                    : null).ToList();
                var per = wanted.OrderBy(n => n).Select((n, i) => perStates[i] is { } states ? Summarize(states, c) : SeasonFromStats(copy, n, visibleEpisodes, c, hidden)).ToList();
                var singles = picked.Select(p =>
                {
                    var arr = copy.Episodes?.Find(p.Part.Season, p.Part.Episode);
                    var one = p.Have != null
                        ? new CopyState(StatusStage.Ready, StatusReasonCode.Ready, Since: p.Have.DateCreated)
                        : EpisodeFromArr(copy, p.Part.Season, p.Part.Episode, arr, c, facts.Request);
                    return (State: one, Arr: arr, p.Part.Season, p.Part.Episode);
                }).ToList();
                var waiting = per.Where(x => SummaryStage(x) != StatusStage.Ready).ToList();
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
                        ? ApplyRequest(new CopyState(StatusStage.NotHere, StatusReasonCode.Unmonitored), facts.Request)
                        : Overall(stage, summary) with
                        {
                            Attention = summary.Attention > 0, Date = summary.NextAir, DateIsDay = summary.NextAirIsDay,
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
        /// A movie asked for in 4K only, by key (the Requests page): where the 4K copies have got to,
        /// so a 4K request for a movie Jellyfin already has in standard quality isn't "Ready". Also
        /// returns when the 4K copy arrived. <paramref name="movie"/> is the whole-title status (its
        /// admin block is kept).
        /// </summary>
        public static (TitleStatus Status, DateTime? ArrivedAt, JfCopy? Shown) Requested4k(TitleFacts facts, TitleStatus movie, IReadOnlyList<JfCopy> copies, ComposeContext c, JfCopy? seerr4k = null)
        {
            var siblings = facts.Copies.Where(x => x.Movie != null).ToList();
            // "No 4K Radarr has it" is judged on the 4K instances alone: a standard Radarr that can't
            // be read says nothing about the 4K copy (as the Overview's Needs attention list).
            var fourK = FourKOnly(facts);
            fourK.Copies.RemoveAll(x => x.Movie == null);
            // Only copies matched to a 4K instance for sure (never "the only copy there is", which may be
            // the standard one); without one, Seerr's own 4K item when the viewer can open it.
            var jf = fourK.Copies.SelectMany(x => MatchCopies(x, copies, siblings, soleFallback: false)).Distinct().ToList();
            if (jf.Count == 0 && seerr4k is { Visible: true }) jf.Add(seerr4k);
            var scoped = Movie(fourK, null, jf, c, detail: false);
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
                // The whole title's admin block, with the "OK'd in Seerr, but no 4K Radarr has it" line
                // only when that is why this 4K request is flagged (never the whole title's own line).
                Admin = WithHandoff(movie.Admin, scoped.Reason.Code == StatusReasonCode.ApprovedNotInArr ? scoped.Admin?.ApprovedNotInArrSince : null, fourK: true),
            };
            var arrived = scoped.Stage == StatusStage.Ready ? jf.Where(x => x.Visible).Select(x => x.DateCreated).Where(d => d.HasValue).DefaultIfEmpty(null).Max() : null;
            // The 4K copy the viewer can open (Play opens it, not the standard one).
            return (status, arrived, jf.FirstOrDefault(x => x.Visible));
        }

        /// <summary>
        /// The part of a title a request asked for when no arr instance set up in Jellyfin Enhanced
        /// can say where it is (a 4K request with no 4K instance): the request alone. Ready only when
        /// Seerr says that variant is available (<paramref name="availableAt"/>: when it said so);
        /// otherwise waiting for an OK, OK'd or said no. Also returns when it arrived.
        /// <paramref name="whole"/> is the whole-title status (its key, kind and admin block are kept).
        /// </summary>
        public static (TitleStatus Status, DateTime? ArrivedAt) RequestedOnly(TitleStatus whole, RequestFacts? request, bool available, DateTime? availableAt)
        {
            var state = available
                ? new CopyState(StatusStage.Ready, StatusReasonCode.Ready, Since: availableAt)
                : ApplyRequest(new CopyState(StatusStage.NotHere, StatusReasonCode.NotInArr), request);
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

        /// <summary>The copy without the queue rows of episodes or seasons Jellyfin hides from the viewer.</summary>
        private static ArrCopyFacts WithoutHiddenRows(ArrCopyFacts copy, HiddenParts? hidden)
        {
            if (hidden == null || !copy.Queue.Any(r => hidden.Hides(r.SeasonNumber, r.EpisodeNumber))) return copy;
            return new ArrCopyFacts(copy.Instance)
            {
                Movie = copy.Movie,
                Series = copy.Series,
                Queue = copy.Queue.Where(r => !hidden.Hides(r.SeasonNumber, r.EpisodeNumber)).ToList(),
                History = copy.History,
                Episodes = copy.Episodes,
                LibraryLoadedAt = copy.LibraryLoadedAt,
                EpisodesLoadedAt = copy.EpisodesLoadedAt,
                LeftQueue = copy.LeftQueue,
                Seen = copy.Seen,
                QueueLoadedAt = copy.QueueLoadedAt,
                QueueStale = copy.QueueStale,
                QueueUnknown = copy.QueueUnknown,
            };
        }

        /// <summary>Where a series copy has got to as a whole (keys path, admin line); a request that went out restarts the "still looking" clock.</summary>
        internal static CopyState SeriesCopyState(ArrCopyFacts copy, bool inJellyfin, ComposeContext c, RequestFacts? request = null)
        {
            var series = copy.Series!;
            if (copy.Queue.Count > 0)
            {
                var row = FromQueue(BestRow(copy.Queue), c, copy);
                return copy.Queue.Count > 1 ? row with { Progress = null, Params = Params(("count", Distinct(copy.Queue).ToString(CultureInfo.InvariantCulture))) } : row;
            }
            if (inJellyfin) return new CopyState(StatusStage.Ready, StatusReasonCode.Ready);
            if (series.EpisodeFileCount > 0) return new CopyState(StatusStage.AlmostReady, StatusReasonCode.LibraryPending);
            if (!series.Monitored) return new CopyState(StatusStage.NotHere, StatusReasonCode.Unmonitored);
            if (series.EpisodeCount == 0 && series.NextAiring is DateTime next && next > c.Now)
                return new CopyState(StatusStage.NotOut, StatusReasonCode.NotAired, Date: next);
            if (copy.QueueUnknown) return Unknown();
            return Looking(Latest(Valid(series.Added), SentFor(request, copy, null, null, c)), c);
        }

        /// <summary>
        /// Per-episode states of one season: every number Sonarr or Jellyfin knows, except episodes
        /// Jellyfin has but hides from this viewer (<paramref name="hidden"/>). Requests that went out
        /// (<paramref name="request"/>) restart the "still looking" clock of the episodes they cover.
        /// </summary>
        internal static List<(int Episode, CopyState State, ArrEpisodeEntry? Arr, JfEpisode? Row)> EpisodeStates(ArrCopyFacts copy, int season, IReadOnlyList<JfEpisode>? jfEpisodes, ComposeContext c, HiddenParts? hidden = null, RequestFacts? request = null)
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
                if (hidden?.Hides(season, n) == true) continue;
                var have = files.FirstOrDefault(e => !e.Virtual && new EpisodeRange(e.Episode, e.EpisodeEnd).Contains(n));
                var row = files.FirstOrDefault(e => new EpisodeRange(e.Episode, e.EpisodeEnd).Contains(n));
                var arr = copy.Episodes?.Find(season, n);
                CopyState state;
                if (have != null)
                {
                    var queued = RowsFor(copy, season, n, arr);
                    state = queued.Count > 0
                        ? new CopyState(StatusStage.Ready, StatusReasonCode.Upgrading, Progress: Progress(queued[0], c, copy), Since: have.DateCreated, Row: queued[0])
                        : new CopyState(StatusStage.Ready, StatusReasonCode.Ready, Since: have.DateCreated);
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
        internal static CopyState EpisodeFromArr(ArrCopyFacts copy, int season, int episode, ArrEpisodeEntry? arr, ComposeContext c, RequestFacts? request = null)
        {
            var rows = RowsFor(copy, season, episode, arr);
            if (rows.Count > 0) return FromQueue(BestRow(rows), c, copy);
            if (arr == null) return new CopyState(StatusStage.None, StatusReasonCode.NotInArr);
            if (arr.HasFile) return new CopyState(StatusStage.AlmostReady, StatusReasonCode.LibraryPending, Since: RecentEpisodeImport(copy, season, episode, arr, c));
            if (!copy.QueueUnknown && RecentFailure(copy.History, arr.Id, c) is DateTime failedAt)
                return new CopyState(StatusStage.Looking, StatusReasonCode.Failed, Attention: true, Since: failedAt);
            if (!copy.QueueUnknown && Departed(copy, null, arr.Id, copy.EpisodesLoadedAt) is DateTime left)
                return new CopyState(StatusStage.AlmostReady, StatusReasonCode.Importing, Since: left);
            var air = Valid(arr.AirDateUtc);
            // An air date without a time (a calendar day) has not aired while that day lasts somewhere.
            if (air == null || NotYet(air.Value, arr.AirDateIsDay, c.Now)) return new CopyState(StatusStage.NotOut, StatusReasonCode.NotAired, Date: air, DateIsDay: arr.AirDateIsDay);
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
        internal static CopyState FromQueue(ArrQueueEntry row, ComposeContext c, ArrCopyFacts? copy = null)
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
        internal static StatusProgress? Progress(ArrQueueEntry row, ComposeContext c, ArrCopyFacts? copy = null)
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

        private static IReadOnlyList<ArrQueueEntry> RowsFor(ArrCopyFacts copy, int season, int episode, ArrEpisodeEntry? arr)
        {
            var rows = new List<ArrQueueEntry>();
            foreach (var r in copy.Queue)
            {
                if (arr != null && r.EpisodeId == arr.Id) rows.Add(r);
                else if (r.SeasonNumber == season && r.EpisodeNumber == episode) rows.Add(r);
            }
            return rows;
        }

        private static int Distinct(IReadOnlyList<ArrQueueEntry> rows)
            => rows.Select(r => r.EpisodeId ?? r.Id).Distinct().Count();

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
                            if (state.Reason == StatusReasonCode.NoReleaseYet && !state.Attention)
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

        /// <summary>A season from Sonarr's statistics (when its episodes are not in memory: poster cards).</summary>
        private static StatusSummary SeasonFromStats(ArrCopyFacts copy, int season, IReadOnlyList<JfEpisode>? jfEpisodes, ComposeContext c, HiddenParts? hidden = null)
        {
            var stats = copy.Series?.Seasons.FirstOrDefault(s => s.SeasonNumber == season);
            // Sonarr counts episodes with a file, not files: a two-part file covers two episodes.
            var coverage = new EpisodeCoverage((jfEpisodes ?? Array.Empty<JfEpisode>()).Where(e => !e.Hidden && !e.Virtual));
            var ready = (int)Math.Min(int.MaxValue, coverage.CountInSeason(season));
            // Episodes Jellyfin hides from this viewer are neither theirs nor pending.
            var hiddenHere = hidden?.Episodes.CountInSeason(season) ?? 0;
            var hiddenFiles = hidden?.WithFile.CountInSeason(season) ?? 0;
            var rows = copy.Queue.Where(r => r.SeasonNumber == season && hidden?.Hides(season, r.EpisodeNumber) != true).ToList();
            var downloading = rows.Where(r => FromQueue(r, c, copy).Stage == StatusStage.Downloading).Select(r => r.EpisodeId ?? r.Id).Distinct().Count();
            var almost = rows.Where(r => FromQueue(r, c, copy).Stage == StatusStage.AlmostReady).Select(r => r.EpisodeId ?? r.Id).Distinct().Count();
            var attention = rows.Where(r => FromQueue(r, c, copy).Attention).Select(r => r.EpisodeId ?? r.Id).Distinct().Count();
            var aired = (int)Math.Max(Math.Max(0, (stats?.EpisodeCount ?? 0) - hiddenHere), ready);
            var files = (int)Math.Max(0, (stats?.EpisodeFileCount ?? 0) - hiddenFiles);
            var pending = Math.Max(0, files - ready);
            var missing = Math.Max(0, aired - ready - pending - downloading - almost);
            var next = stats?.NextAiring is DateTime n && n > c.Now ? n : (DateTime?)null;
            return new StatusSummary { Aired = aired, Ready = ready, Downloading = downloading, AlmostReady = almost + pending, Missing = missing, Unknown = copy.QueueUnknown ? missing : 0, Attention = attention, NextAir = next, NextSeason = next.HasValue ? season : null };
        }

        private static StatusSummary Combine(List<StatusSummary> seasons)
        {
            var next = seasons.Where(s => s.NextAir.HasValue).OrderBy(s => s.NextAir).FirstOrDefault();
            return new StatusSummary
            {
                Aired = seasons.Sum(s => s.Aired), Ready = seasons.Sum(s => s.Ready), Downloading = seasons.Sum(s => s.Downloading),
                AlmostReady = seasons.Sum(s => s.AlmostReady), Missing = seasons.Sum(s => s.Missing), Unknown = seasons.Sum(s => s.Unknown), Attention = seasons.Sum(s => s.Attention),
                LongMissing = seasons.Sum(s => s.LongMissing), LongMissingSent = seasons.Sum(s => s.LongMissingSent),
                LongMissingSince = seasons.Where(s => s.LongMissingSince.HasValue).Select(s => s.LongMissingSince).DefaultIfEmpty(null).Min(),
                NextAir = next?.NextAir, NextAirIsDay = next?.NextAirIsDay == true, NextSeason = next?.NextSeason, NextEpisode = next?.NextEpisode,
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
            return StatusReasonCode.Ready;
        }

        private static IEnumerable<int> SeasonNumbers(ArrCopyFacts copy, IReadOnlyList<JfEpisode>? jfEpisodes)
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

        private static List<JourneyStop> MovieJourney(CopyState headline, ArrCopyFacts? copy, JfItemRef? item, IReadOnlyList<JfCopy> jf, RequestFacts? request, ComposeContext c)
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

        private static List<JourneyStop> EpisodeJourney(CopyState state, ArrCopyFacts? copy, int season, int episode, ArrEpisodeEntry? arr, JfItemRef item, ComposeContext c)
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

        private static AdminStatus AdminFor(TitleFacts facts, List<(ArrCopyFacts Copy, CopyState State, JfCopy? Jf)> variants, List<(ArrCopyFacts Copy, int Season, int Episode, CopyState State)>? problems)
        {
            var list = new List<AdminVariant>();
            foreach (var (copy, state, jf) in variants)
            {
                list.Add(Variant(copy, state, jf, null));
            }
            foreach (var (copy, season, episode, state) in (problems ?? new List<(ArrCopyFacts, int, int, CopyState)>()).Take(20))
            {
                list.Add(Variant(copy, state, null, "S" + season.ToString("00", CultureInfo.InvariantCulture) + "E" + episode.ToString("00", CultureInfo.InvariantCulture)));
            }
            return new AdminStatus { Variants = list, Unreadable = facts.Unreadable.Count > 0 ? facts.Unreadable.Select(u => u.Label).ToList() : null };
        }

        /// <summary>The series copies other than the primary one (a 4K or anime Sonarr holding the same series).</summary>
        private static IEnumerable<ArrCopyFacts> OtherSeriesCopies(TitleFacts facts, ArrCopyFacts primary)
            => facts.Copies.Where(x => x.Series != null && !ReferenceEquals(x, primary)).OrderBy(x => RoleOrder(x.Instance.Role));

        /// <summary>Every Sonarr copy of the series (the siblings <see cref="MatchCopies"/> tells apart).</summary>
        internal static List<ArrCopyFacts> SeriesCopies(TitleFacts facts) => facts.Copies.Where(x => x.Series != null).ToList();

        /// <summary>
        /// Admin lines for the other Sonarr instances holding the series: one line per instance (where
        /// it has got to as a whole, matched to its Jellyfin copy when <paramref name="copies"/> are
        /// known) and one per queue problem (only this season's or episode's when given). Episode
        /// pages only list instances with a download of that episode. True when any problem was found.
        /// </summary>
        private static bool AddOtherSeriesCopies(TitleFacts facts, ArrCopyFacts primary, IReadOnlyList<JfCopy>? copies, int? season, int? episode, ComposeContext c, List<(ArrCopyFacts, CopyState, JfCopy?)> variants, List<(ArrCopyFacts, int, int, CopyState)> problems)
        {
            var any = false;
            var siblings = SeriesCopies(facts);
            foreach (var other in OtherSeriesCopies(facts, primary))
            {
                var found = QueueProblems(other, season, episode, c);
                any |= found.Count > 0;
                if (episode.HasValue)
                {
                    var rows = RowsFor(other, season ?? 0, episode.Value, other.Episodes?.Find(season ?? 0, episode.Value));
                    if (rows.Count > 0) variants.Add((other, FromQueue(BestRow(rows), c, other), null));
                    continue;
                }
                var matched = copies != null ? MatchCopies(other, copies, siblings) : new List<JfCopy>();
                variants.Add((other, SeriesCopyState(other, matched.Count > 0, c, facts.Request), matched.FirstOrDefault()));
                problems.AddRange(found);
            }
            return any;
        }

        /// <summary>The queue rows of a series copy that need someone (import blocked, stalled, failed), one per episode.</summary>
        private static List<(ArrCopyFacts, int, int, CopyState)> QueueProblems(ArrCopyFacts copy, int? season, int? episode, ComposeContext c)
        {
            var list = new List<(ArrCopyFacts, int, int, CopyState)>();
            var seen = new HashSet<int>();
            foreach (var row in copy.Queue)
            {
                if (season.HasValue && row.SeasonNumber != season) continue;
                if (episode.HasValue && row.EpisodeNumber != episode) continue;
                var state = FromQueue(row, c, copy);
                if (!state.Attention || !seen.Add(row.EpisodeId ?? row.Id)) continue;
                list.Add((copy, row.SeasonNumber ?? 0, row.EpisodeNumber ?? 0, state));
            }
            return list;
        }

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

        private static AdminVariant Variant(ArrCopyFacts copy, CopyState state, JfCopy? jf, string? scope)
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
                Path = copy.Movie?.Path ?? copy.Series?.Path,
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
        internal static List<JfCopy> MatchCopies(ArrCopyFacts copy, IReadOnlyList<JfCopy> jf, IReadOnlyList<ArrCopyFacts> siblings, bool soleFallback = true)
        {
            if (jf.Count == 0) return new List<JfCopy>();
            if (Claimed(copy, jf) is { } strong) return strong;
            var arrPath = ArrPathOf(copy);
            if (!string.IsNullOrWhiteSpace(arrPath) && Tail(Norm(arrPath), 2) is { } tail)
            {
                var others = siblings.Where(x => !ReferenceEquals(x, copy) && x.Instance.Id != copy.Instance.Id).ToList();
                var ambiguous = others.Any(o => ArrPathOf(o) is { } p && !string.IsNullOrWhiteSpace(p) && string.Equals(Tail(Norm(p), 2), tail, StringComparison.OrdinalIgnoreCase));
                if (!ambiguous)
                {
                    var claimed = new HashSet<Guid>(others.SelectMany(o => Claimed(o, jf) ?? new List<JfCopy>()).Select(x => x.ItemId));
                    var free = jf.Where(x => !claimed.Contains(x.ItemId) && x.Path != null).ToList();
                    var same = free.Where(x => BridgePaths.IsUnder(x.Path!, arrPath)).ToList();
                    if (same.Count > 0) return same;
                    var hits = free.Where(x => Tail(TitleFolder(Norm(x.Path!), copy.Movie != null), 2) is { } t && string.Equals(t, tail, StringComparison.OrdinalIgnoreCase)).ToList();
                    if (hits.Count > 0) return hits;
                }
            }
            return soleFallback && siblings.Count <= 1 ? jf.ToList() : new List<JfCopy>();
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

        private static string? ArrPathOf(ArrCopyFacts copy) => copy.Movie?.Path ?? copy.Series?.Path;

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

        private static bool FamilyMayFollow(ArrCopyFacts copy, CopyState state)
            => copy.Instance.Role != "4k" || state.Stage == StatusStage.Ready;

        private static int RoleOrder(string role) => role switch { "standard" => 0, "anime" => 1, "custom" => 2, _ => 3 };

        private static ArrCopyFacts? PrimarySeriesCopy(TitleFacts facts)
            => facts.Copies.Where(c => c.Series != null).OrderBy(c => RoleOrder(c.Instance.Role)).FirstOrDefault();

        private static CopyState NothingKnown(TitleFacts facts)
            => facts.Unreadable.Count > 0
                ? new CopyState(StatusStage.None, StatusReasonCode.ServiceDown)
                : new CopyState(StatusStage.NotHere, StatusReasonCode.NotInArr);

        private static CopyState ApplyRequest(CopyState state, RequestFacts? request, ComposeContext? c = null, TitleFacts? facts = null)
        {
            if (request == null) return state;
            // Everything asked for arrived once: no "OK'd! Getting started" again. Gone from Jellyfin and every arr
            // since, it says so; otherwise the copy's own state stands (not being fetched, service down, ...).
            if (request.Fulfilled)
                return state.Stage == StatusStage.NotHere && state.Reason == StatusReasonCode.NotInArr ? new CopyState(StatusStage.NotHere, StatusReasonCode.Removed) : state;
            if (state.Stage is StatusStage.NotHere or StatusStage.None)
            {
                if (request.Declined) return new CopyState(StatusStage.NotHere, StatusReasonCode.Declined);
                if (request.Pending) return new CopyState(StatusStage.Asked, StatusReasonCode.AwaitingApproval, Since: request.AskedAt);
                if (request.ApprovedAt is DateTime approved)
                {
                    // Sonarr doesn't list what was asked for yet: nothing can be fetched before it does.
                    if (request.NotListed) return new CopyState(StatusStage.Approved, StatusReasonCode.NotAired, Since: approved);
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
            var fourK = new TitleFacts(facts.Key) { Request = facts.Request, LiveKey = facts.LiveKey };
            fourK.Copies.AddRange(facts.Copies.Where(x => x.Instance.Role == "4k"));
            fourK.Unreadable.AddRange(facts.Unreadable.Where(u => u.Instance.Role == "4k"));
            fourK.Stale.AddRange(facts.Stale.Where(i => i.Role == "4k"));
            fourK.Checked.AddRange(facts.Checked.Where(i => i.Role == "4k"));
            return fourK;
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
        private static DateTime? Departed(ArrCopyFacts copy, int? movieId, int? episodeId, DateTime? snapshotAt)
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
        private static DateTime? RecentImport(ArrCopyFacts copy, ComposeContext c, TimeSpan? window = null)
        {
            foreach (var h in copy.History)
            {
                if (IsImport(h)) return h.Date is DateTime d && c.Now - d <= (window ?? RecentArrival) ? d : null;
                if (IsGrab(h) || IsFileGone(h)) return null;
            }
            return null;
        }

        private static DateTime? RecentEpisodeImport(ArrCopyFacts copy, int season, int episode, ArrEpisodeEntry? arr, ComposeContext c, TimeSpan? window = null)
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

        private static DateTime? Valid(DateTime? d) => d.HasValue && d.Value.Year > 1900 ? d : null;

        private static DateTime? Latest(DateTime? a, DateTime? b) => a == null ? b : b == null ? a : (a > b ? a : b);

        /// <summary>When a request covering this part of the copy's edition (4K instance or not) last went out, or null.</summary>
        private static DateTime? SentFor(RequestFacts? request, ArrCopyFacts copy, int? season, int? episode, ComposeContext c)
            => c.RequestClock ? Valid(request?.SentFor(copy.Instance.Role == "4k", season, episode)) : null;
    }
}
