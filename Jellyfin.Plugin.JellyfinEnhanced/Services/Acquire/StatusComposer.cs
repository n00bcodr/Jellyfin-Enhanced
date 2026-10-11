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
    }

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

        /// <summary>Instances of the title's kind that could not be read ("name (kind)").</summary>
        public List<string> Unreadable { get; } = new();

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
        public HiddenParts(IReadOnlySet<(int Season, int Episode)> episodes, IReadOnlySet<(int Season, int Episode)> withFile, IReadOnlySet<int> seasons)
        {
            Episodes = episodes;
            WithFile = withFile;
            Seasons = seasons;
        }

        /// <summary>Nothing hidden.</summary>
        public static HiddenParts None { get; } = new(new HashSet<(int, int)>(), new HashSet<(int, int)>(), new HashSet<int>());

        /// <summary>Hidden episode numbers (the viewer sees no episode with that number).</summary>
        public IReadOnlySet<(int Season, int Episode)> Episodes { get; }

        /// <summary>The hidden episodes Jellyfin has a file for.</summary>
        public IReadOnlySet<(int Season, int Episode)> WithFile { get; }

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
        internal sealed record CopyState(string Stage, string Reason, bool Attention = false, StatusProgress? Progress = null, DateTime? Date = null, DateTime? Since = null, ArrQueueEntry? Row = null, IReadOnlyDictionary<string, string>? Params = null)
        {
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
            foreach (var copy in facts.Copies.Where(x => x.Movie != null))
            {
                var matched = MatchCopies(copy, jf, facts.Copies.Count(x => x.Movie != null));
                var own = item != null ? matched.FirstOrDefault(m => m.ItemId == item.ItemId) : null;
                var visible = own ?? matched.FirstOrDefault(m => m.Visible);
                CopyState state;
                if (visible != null)
                {
                    state = copy.Queue.Count > 0
                        ? new CopyState(StatusStage.Ready, StatusReasonCode.Upgrading, Progress: Progress(copy.Queue[0], c), Since: visible.DateCreated, Row: copy.Queue[0])
                        : new CopyState(StatusStage.Ready, StatusReasonCode.Ready, Since: visible.DateCreated);
                }
                else if (matched.Count > 0)
                {
                    state = new CopyState(StatusStage.NotHere, StatusReasonCode.NotVisibleToUser, Since: matched[0].DateCreated);
                }
                else
                {
                    state = MovieFromArr(copy, c);
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
            headline = ApplyRequest(headline, facts.Request);

            var recent = headline.Stage == StatusStage.Ready && headlineCopy != null && RecentImport(headlineCopy, c) != null;
            var familyQuiet = headline.Stage == StatusStage.Ready && headline.Reason == StatusReasonCode.Ready && !recent
                || headline.Stage == StatusStage.None;
            var admin = c.Viewer.IsAdmin ? AdminFor(facts, variants.Select(v => (v.Copy, v.State, v.Jf)).ToList(), null) : null;
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

        /// <summary>A movie copy that is not (visibly) in Jellyfin: where the arr has got to.</summary>
        internal static CopyState MovieFromArr(ArrCopyFacts copy, ComposeContext c)
        {
            var movie = copy.Movie!;
            if (copy.Queue.Count > 0) return FromQueue(BestRow(copy.Queue), c);
            var imported = RecentImport(copy, c, TimeSpan.FromDays(30));
            if (movie.HasFile || imported != null)
                return new CopyState(StatusStage.AlmostReady, StatusReasonCode.LibraryPending, Since: imported);
            if (RecentFailure(copy.History, null, c) is DateTime failedAt)
                return new CopyState(StatusStage.Looking, StatusReasonCode.Failed, Attention: true, Since: failedAt);
            if (Departed(copy, movie.Id, null, copy.LibraryLoadedAt) is DateTime left)
                return new CopyState(StatusStage.AlmostReady, StatusReasonCode.Importing, Since: left);
            if (!movie.Monitored) return new CopyState(StatusStage.NotHere, StatusReasonCode.Unmonitored);
            if (!movie.IsAvailable)
            {
                var future = new[] { movie.DigitalRelease, movie.PhysicalRelease }.Where(d => d.HasValue && d.Value > c.Now).Select(d => d!.Value).OrderBy(d => d).FirstOrDefault();
                var cinema = Valid(movie.InCinemas);
                if (cinema.HasValue && cinema.Value <= c.Now)
                    return new CopyState(StatusStage.NotOut, StatusReasonCode.InCinemas, Date: future == default ? null : future);
                var date = cinema.HasValue && cinema.Value > c.Now ? cinema : (future == default ? null : future);
                return new CopyState(StatusStage.NotOut, StatusReasonCode.NotReleased, Date: date);
            }
            var since = Latest(Valid(movie.Added), Valid(movie.DigitalRelease) is DateTime d && d <= c.Now ? d : null);
            return Looking(since, c);
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
                var none = ApplyRequest(NothingKnown(facts), facts.Request);
                return new TitleStatus
                {
                    Key = facts.Key.ToString(), ItemId = Id(item.ItemId), Kind = "series",
                    Stage = jfEpisodes?.Any(e => !e.Virtual) == true ? StatusStage.Ready : none.Stage,
                    Reason = Reason(none), Quiet = true,
                    Admin = c.Viewer.IsAdmin ? AdminFor(facts, new List<(ArrCopyFacts, CopyState, JfCopy?)>(), null) : null,
                };
            }

            var seasons = SeasonNumbers(copy, jfEpisodes).Where(s => s > 0 && !hidden.Seasons.Contains(s)).ToList();
            var perSeason = new List<SeasonStatus>();
            var all = new List<(int Season, CopyState State, ArrEpisodeEntry? Arr, int Episode)>();
            foreach (var s in seasons)
            {
                var episodes = EpisodeStates(copy, s, jfEpisodes, c, hidden);
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
                Missing = total.Missing, Attention = total.Attention,
                NextAir = total.NextAir ?? (copy.Series!.NextAiring is DateTime n && n > c.Now ? n : null),
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
                admin = AdminFor(facts, variants, problems);
            }
            return new TitleStatus
            {
                Key = facts.Key.ToString(),
                ItemId = Id(item.ItemId),
                Kind = "series",
                Stage = stage,
                Reason = new StatusReason { Code = SummaryReason(total) },
                Attention = total.Attention > 0 || otherProblems,
                Quiet = quiet && !otherProblems && (!c.Viewer.IsAdmin || facts.Unreadable.Count == 0),
                Progress = progress.Count == 1 ? progress[0] : null,
                NextDate = total.NextAir,
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
            var episodes = EpisodeStates(copy, season, jfEpisodes, c, hidden);
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
                Reason = new StatusReason { Code = SummaryReason(summary) },
                Attention = summary.Attention > 0 || otherProblems,
                Quiet = quiet && !otherProblems,
                Progress = progress.Count == 1 ? progress[0] : null,
                NextDate = summary.NextAir,
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
                    ? new CopyState(StatusStage.Ready, StatusReasonCode.Upgrading, Progress: Progress(rows[0], c), Since: item.DateCreated, Row: rows[0])
                    : new CopyState(StatusStage.Ready, StatusReasonCode.Ready, Since: item.DateCreated);
            }
            else if (copy == null)
            {
                state = NothingKnown(facts);
            }
            else
            {
                arr = copy.Episodes?.Find(season, number);
                state = EpisodeFromArr(copy, season, number, arr, c);
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
            var states = copy?.Queue.Where(r => hidden?.Hides(r.SeasonNumber, r.EpisodeNumber) != true).Select(r => (Row: r, State: FromQueue(r, c))).ToList() ?? new List<(ArrQueueEntry Row, CopyState State)>();
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
            var family = copy;
            if (!visible && copies.Count > 0 && !c.Viewer.IsAdmin)
            {
                // Only in libraries this family member can't open: the Sonarr copies that are (or may
                // be) those hidden series are left out, so the answer is the one they would get if the
                // hidden copies didn't exist (a title nobody has, when nothing else is left).
                var count = SeriesCopyCount(facts);
                family = facts.Copies.Where(x => x.Series != null)
                    .Where(x => MatchCopies(x, copies, count).Count == 0 && x.Series!.EpisodeFileCount == 0 && RecentImport(x, c, TimeSpan.FromDays(30)) == null)
                    .OrderBy(x => RoleOrder(x.Instance.Role))
                    .FirstOrDefault();
            }
            var state = family == null
                ? (visible ? new CopyState(StatusStage.Ready, StatusReasonCode.Ready) : NothingKnown(facts))
                : SeriesCopyState(WithoutHiddenRows(family, hidden), visible, c);
            if (!visible && copies.Count > 0 && c.Viewer.IsAdmin && state.Stage == StatusStage.AlmostReady)
            {
                // An admin is told why.
                state = new CopyState(StatusStage.NotHere, StatusReasonCode.NotVisibleToUser);
            }
            state = ApplyRequest(state, facts.Request);
            AdminStatus? admin = null;
            if (c.Viewer.IsAdmin)
            {
                var variants = new List<(ArrCopyFacts, CopyState, JfCopy?)>();
                var problems = new List<(ArrCopyFacts, int, int, CopyState)>();
                if (copy != null)
                {
                    variants.Add((copy, state, MatchCopies(copy, copies, SeriesCopyCount(facts)).FirstOrDefault() ?? copies.FirstOrDefault()));
                    AddOtherSeriesCopies(facts, copy, copies, null, null, c, variants, problems);
                }
                admin = AdminFor(facts, variants, problems);
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
                Admin = admin,
            };
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
            };
        }

        /// <summary>Where a series copy has got to as a whole (keys path, admin line).</summary>
        internal static CopyState SeriesCopyState(ArrCopyFacts copy, bool inJellyfin, ComposeContext c)
        {
            var series = copy.Series!;
            if (copy.Queue.Count > 0)
            {
                var row = FromQueue(BestRow(copy.Queue), c);
                return copy.Queue.Count > 1 ? row with { Progress = null, Params = Params(("count", Distinct(copy.Queue).ToString(CultureInfo.InvariantCulture))) } : row;
            }
            if (inJellyfin) return new CopyState(StatusStage.Ready, StatusReasonCode.Ready);
            if (series.EpisodeFileCount > 0) return new CopyState(StatusStage.AlmostReady, StatusReasonCode.LibraryPending);
            if (!series.Monitored) return new CopyState(StatusStage.NotHere, StatusReasonCode.Unmonitored);
            if (series.EpisodeCount == 0 && series.NextAiring is DateTime next && next > c.Now)
                return new CopyState(StatusStage.NotOut, StatusReasonCode.NotAired, Date: next);
            return Looking(Valid(series.Added), c);
        }

        /// <summary>
        /// Per-episode states of one season: every number Sonarr or Jellyfin knows, except episodes
        /// Jellyfin has but hides from this viewer (<paramref name="hidden"/>).
        /// </summary>
        internal static List<(int Episode, CopyState State, ArrEpisodeEntry? Arr, JfEpisode? Row)> EpisodeStates(ArrCopyFacts copy, int season, IReadOnlyList<JfEpisode>? jfEpisodes, ComposeContext c, HiddenParts? hidden = null)
        {
            var result = new List<(int, CopyState, ArrEpisodeEntry?, JfEpisode?)>();
            var real = new Dictionary<int, JfEpisode>();
            var rows = new Dictionary<int, JfEpisode>();
            foreach (var e in jfEpisodes ?? Array.Empty<JfEpisode>())
            {
                if (e.Season != season) continue;
                var end = e.EpisodeEnd is int last && last >= e.Episode && last - e.Episode < 50 ? last : e.Episode;
                for (var n = e.Episode; n <= end; n++)
                {
                    if (!e.Virtual) real.TryAdd(n, e);
                    rows.TryAdd(n, e);
                }
            }
            var numbers = new SortedSet<int>(real.Keys.Concat(rows.Keys));
            if (copy.Episodes != null)
            {
                foreach (var e in copy.Episodes.Episodes)
                {
                    if (e.SeasonNumber == season && hidden?.Episodes.Contains((season, e.EpisodeNumber)) != true) numbers.Add(e.EpisodeNumber);
                }
            }
            foreach (var n in numbers)
            {
                var arr = copy.Episodes?.Find(season, n);
                CopyState state;
                if (real.TryGetValue(n, out var have))
                {
                    var queued = RowsFor(copy, season, n, arr);
                    state = queued.Count > 0
                        ? new CopyState(StatusStage.Ready, StatusReasonCode.Upgrading, Progress: Progress(queued[0], c), Since: have.DateCreated, Row: queued[0])
                        : new CopyState(StatusStage.Ready, StatusReasonCode.Ready, Since: have.DateCreated);
                }
                else if (arr == null && copy.Episodes != null)
                {
                    continue; // a virtual Jellyfin episode Sonarr does not know
                }
                else
                {
                    state = EpisodeFromArr(copy, season, n, arr, c);
                }
                rows.TryGetValue(n, out var row);
                result.Add((n, state, arr, row));
            }
            return result;
        }

        /// <summary>An episode Jellyfin cannot play (yet): where Sonarr has got to.</summary>
        internal static CopyState EpisodeFromArr(ArrCopyFacts copy, int season, int episode, ArrEpisodeEntry? arr, ComposeContext c)
        {
            var rows = RowsFor(copy, season, episode, arr);
            if (rows.Count > 0) return FromQueue(BestRow(rows), c);
            if (arr == null) return new CopyState(StatusStage.None, StatusReasonCode.NotInArr);
            if (arr.HasFile) return new CopyState(StatusStage.AlmostReady, StatusReasonCode.LibraryPending, Since: RecentEpisodeImport(copy, season, episode, arr, c));
            if (RecentFailure(copy.History, arr.Id, c) is DateTime failedAt)
                return new CopyState(StatusStage.Looking, StatusReasonCode.Failed, Attention: true, Since: failedAt);
            if (Departed(copy, null, arr.Id, copy.EpisodesLoadedAt) is DateTime left)
                return new CopyState(StatusStage.AlmostReady, StatusReasonCode.Importing, Since: left);
            var air = Valid(arr.AirDateUtc);
            if (air == null || air.Value > c.Now) return new CopyState(StatusStage.NotOut, StatusReasonCode.NotAired, Date: air);
            if (!arr.Monitored || copy.Series?.Monitored == false) return new CopyState(StatusStage.NotHere, StatusReasonCode.Unmonitored);
            return Looking(Latest(air, Valid(copy.Series?.Added)), c);
        }

        // ------------------------------------------------------------------ queue

        /// <summary>What a queue row means in the status language.</summary>
        internal static CopyState FromQueue(ArrQueueEntry row, ComposeContext c)
        {
            var status = (row.Status ?? string.Empty).ToLowerInvariant();
            var state = row.TrackedDownloadState ?? string.Empty;
            var tracked = (row.TrackedDownloadStatus ?? "ok").ToLowerInvariant();
            var since = Valid(row.Added);
            if (status == "delay")
                return new CopyState(StatusStage.Downloading, StatusReasonCode.DelayHeld, Since: since, Row: row);
            if (string.Equals(state, "importBlocked", StringComparison.OrdinalIgnoreCase))
                return new CopyState(StatusStage.AlmostReady, StatusReasonCode.ImportBlocked, Attention: true, Since: since, Row: row);
            if (string.Equals(state, "importPending", StringComparison.OrdinalIgnoreCase) || string.Equals(state, "importing", StringComparison.OrdinalIgnoreCase))
            {
                return tracked is "warning" or "error"
                    ? new CopyState(StatusStage.AlmostReady, StatusReasonCode.ImportBlocked, Attention: true, Since: since, Row: row)
                    : new CopyState(StatusStage.AlmostReady, StatusReasonCode.Importing, Since: since, Row: row);
            }
            if (string.Equals(state, "failedPending", StringComparison.OrdinalIgnoreCase) || string.Equals(state, "failed", StringComparison.OrdinalIgnoreCase) || status == "failed")
                return new CopyState(StatusStage.Looking, StatusReasonCode.Failed, Attention: true, Since: since, Row: row);
            if (status is "queued" or "paused")
                return new CopyState(StatusStage.Downloading, StatusReasonCode.Queued, Since: since, Row: row);
            if (status == "completed")
                return new CopyState(StatusStage.AlmostReady, StatusReasonCode.Importing, Since: since, Row: row);
            if (tracked is "warning" or "error" || status == "warning")
                return new CopyState(StatusStage.Downloading, StatusReasonCode.Stalled, Attention: true, Progress: Progress(row, c), Since: since, Row: row);
            return new CopyState(StatusStage.Downloading, StatusReasonCode.Downloading, Progress: Progress(row, c), Since: since, Row: row);
        }

        /// <summary>Percent done and seconds left of a queue row.</summary>
        internal static StatusProgress? Progress(ArrQueueEntry row, ComposeContext c)
        {
            if (row.Size is not double size || size <= 0) return null;
            var left = Math.Clamp(row.SizeLeft ?? size, 0, size);
            var pct = (int)Math.Clamp(Math.Floor((size - left) / size * 100), 0, 100);
            long? eta = null;
            if (row.EstimatedCompletionTime is DateTime done)
            {
                var utc = done.Kind == DateTimeKind.Unspecified ? DateTime.SpecifyKind(done, DateTimeKind.Utc) : done.ToUniversalTime();
                if (utc > c.Now) eta = (long)(utc - c.Now).TotalSeconds;
            }
            if (eta == null && !string.IsNullOrEmpty(row.TimeLeft) && TimeSpan.TryParse(row.TimeLeft, CultureInfo.InvariantCulture, out var span) && span > TimeSpan.Zero)
                eta = (long)span.TotalSeconds;
            // Whole minutes (rounded up) beyond the first: the text says "about N min" anyway, and an
            // ETA that ticks every second would make every response a new body (no 304s).
            if (eta > 60) eta = (eta + 59) / 60 * 60;
            return new StatusProgress { Percent = pct, EtaSeconds = eta };
        }

        private static ArrQueueEntry BestRow(IReadOnlyList<ArrQueueEntry> rows)
        {
            // Problems first (someone should hear about them), then the furthest along.
            return rows.OrderByDescending(r => r.TrackedDownloadState is "importBlocked" ? 3 : r.TrackedDownloadStatus is "warning" or "error" ? 2 : 0)
                .ThenByDescending(r => r.TrackedDownloadState is "importPending" or "importing" ? 1 : 0)
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
            int aired = 0, ready = 0, downloading = 0, almost = 0, missing = 0, attention = 0;
            DateTime? next = null;
            int? nextSeason = null, nextEpisode = null;
            foreach (var (state, arr, season, episode) in episodes)
            {
                var air = Valid(arr?.AirDateUtc);
                var hasAired = state.Stage != StatusStage.NotOut || (air.HasValue && air.Value <= c.Now);
                if (state.Stage == StatusStage.NotOut && air.HasValue && air.Value > c.Now && (next == null || air.Value < next))
                {
                    next = air;
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
                        if (hasAired) missing++;
                        break;
                }
            }
            return new StatusSummary { Aired = aired, Ready = ready, Downloading = downloading, AlmostReady = almost, Missing = missing, Attention = attention, NextAir = next, NextSeason = nextSeason, NextEpisode = nextEpisode };
        }

        /// <summary>A season from Sonarr's statistics (when its episodes are not in memory: poster cards).</summary>
        private static StatusSummary SeasonFromStats(ArrCopyFacts copy, int season, IReadOnlyList<JfEpisode>? jfEpisodes, ComposeContext c, HiddenParts? hidden = null)
        {
            var stats = copy.Series?.Seasons.FirstOrDefault(s => s.SeasonNumber == season);
            // Sonarr counts episodes with a file, not files: a two-part file covers two episodes.
            var ready = jfEpisodes?.Where(e => e.Season == season && !e.Virtual).SelectMany(Covered).Distinct().Count() ?? 0;
            // Episodes Jellyfin hides from this viewer are neither theirs nor pending.
            var hiddenHere = hidden?.Episodes.Count(h => h.Season == season) ?? 0;
            var hiddenFiles = hidden?.WithFile.Count(h => h.Season == season) ?? 0;
            var rows = copy.Queue.Where(r => r.SeasonNumber == season && hidden?.Hides(season, r.EpisodeNumber) != true).ToList();
            var downloading = rows.Where(r => FromQueue(r, c).Stage == StatusStage.Downloading).Select(r => r.EpisodeId ?? r.Id).Distinct().Count();
            var almost = rows.Where(r => FromQueue(r, c).Stage == StatusStage.AlmostReady).Select(r => r.EpisodeId ?? r.Id).Distinct().Count();
            var attention = rows.Where(r => FromQueue(r, c).Attention).Select(r => r.EpisodeId ?? r.Id).Distinct().Count();
            var aired = Math.Max(Math.Max(0, (stats?.EpisodeCount ?? 0) - hiddenHere), ready);
            var files = Math.Max(0, (stats?.EpisodeFileCount ?? 0) - hiddenFiles);
            var pending = Math.Max(0, files - ready);
            var missing = Math.Max(0, aired - ready - pending - downloading - almost);
            var next = stats?.NextAiring is DateTime n && n > c.Now ? n : (DateTime?)null;
            return new StatusSummary { Aired = aired, Ready = ready, Downloading = downloading, AlmostReady = almost + pending, Missing = missing, Attention = attention, NextAir = next, NextSeason = next.HasValue ? season : null };
        }

        private static StatusSummary Combine(List<StatusSummary> seasons)
        {
            var next = seasons.Where(s => s.NextAir.HasValue).OrderBy(s => s.NextAir).FirstOrDefault();
            return new StatusSummary
            {
                Aired = seasons.Sum(s => s.Aired), Ready = seasons.Sum(s => s.Ready), Downloading = seasons.Sum(s => s.Downloading),
                AlmostReady = seasons.Sum(s => s.AlmostReady), Missing = seasons.Sum(s => s.Missing), Attention = seasons.Sum(s => s.Attention),
                NextAir = next?.NextAir, NextSeason = next?.NextSeason, NextEpisode = next?.NextEpisode,
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

        /// <summary>The copy-level admin line of a series or season: its overall state (problems get their own lines).</summary>
        private static CopyState Overall(string stage, StatusSummary s) => new(stage, SummaryReason(s));

        private static string SummaryReason(StatusSummary s)
        {
            if (s.Downloading > 0) return StatusReasonCode.Downloading;
            if (s.AlmostReady > 0) return StatusReasonCode.LibraryPending;
            if (s.Missing > 0) return StatusReasonCode.Partial;
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
            return new AdminStatus { Variants = list, Unreadable = facts.Unreadable.Count > 0 ? facts.Unreadable.ToList() : null };
        }

        /// <summary>The series copies other than the primary one (a 4K or anime Sonarr holding the same series).</summary>
        private static IEnumerable<ArrCopyFacts> OtherSeriesCopies(TitleFacts facts, ArrCopyFacts primary)
            => facts.Copies.Where(x => x.Series != null && !ReferenceEquals(x, primary)).OrderBy(x => RoleOrder(x.Instance.Role));

        private static int SeriesCopyCount(TitleFacts facts) => facts.Copies.Count(x => x.Series != null);

        /// <summary>
        /// Admin lines for the other Sonarr instances holding the series: one line per instance (where
        /// it has got to as a whole, matched to its Jellyfin copy when <paramref name="copies"/> are
        /// known) and one per queue problem (only this season's or episode's when given). Episode
        /// pages only list instances with a download of that episode. True when any problem was found.
        /// </summary>
        private static bool AddOtherSeriesCopies(TitleFacts facts, ArrCopyFacts primary, IReadOnlyList<JfCopy>? copies, int? season, int? episode, ComposeContext c, List<(ArrCopyFacts, CopyState, JfCopy?)> variants, List<(ArrCopyFacts, int, int, CopyState)> problems)
        {
            var any = false;
            var count = SeriesCopyCount(facts);
            foreach (var other in OtherSeriesCopies(facts, primary))
            {
                var found = QueueProblems(other, season, episode, c);
                any |= found.Count > 0;
                if (episode.HasValue)
                {
                    var rows = RowsFor(other, season ?? 0, episode.Value, other.Episodes?.Find(season ?? 0, episode.Value));
                    if (rows.Count > 0) variants.Add((other, FromQueue(BestRow(rows), c), null));
                    continue;
                }
                var matched = copies != null ? MatchCopies(other, copies, count) : new List<JfCopy>();
                variants.Add((other, SeriesCopyState(other, matched.Count > 0, c), matched.FirstOrDefault()));
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
                var state = FromQueue(row, c);
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
            var shown = new HashSet<(int, int)>((visible ?? new List<JfEpisode>()).SelectMany(e => Covered(e).Select(n => (e.Season, n))));
            var hidden = new HashSet<(int Season, int Episode)>();
            var withFile = new HashSet<(int Season, int Episode)>();
            foreach (var e in jf?.Where(e => e.Hidden) ?? Enumerable.Empty<JfEpisode>())
            {
                foreach (var n in Covered(e))
                {
                    if (shown.Contains((e.Season, n))) continue;
                    hidden.Add((e.Season, n));
                    if (!e.Virtual) withFile.Add((e.Season, n));
                }
            }
            return (visible, new HiddenParts(hidden, withFile, hiddenSeasons));
        }

        /// <summary>The episode numbers a Jellyfin episode covers (a multi-episode file covers its range, at most 50).</summary>
        private static IEnumerable<int> Covered(JfEpisode e)
        {
            var end = e.EpisodeEnd is int last && last >= e.Episode && last - e.Episode < 50 ? last : e.Episode;
            for (var n = e.Episode; n <= end; n++) yield return n;
        }

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
            _ => null,
        };

        // ------------------------------------------------------------------ helpers

        /// <summary>
        /// The Jellyfin copies an arr copy corresponds to: by the instance's linked libraries, else its
        /// path mappings, else the last two folder names (root folder + title folder, which tells
        /// "movies/Dune (2024)" from "movies4k/Dune (2024)"), else — when only one instance holds the
        /// title — every copy.
        /// </summary>
        internal static List<JfCopy> MatchCopies(ArrCopyFacts copy, IReadOnlyList<JfCopy> jf, int arrCopies)
        {
            if (jf.Count == 0) return new List<JfCopy>();
            var linked = copy.Instance.LinkedLibraryIds;
            if (linked.Count > 0)
            {
                var set = new HashSet<string>(linked.Select(NormalizeId), StringComparer.OrdinalIgnoreCase);
                return jf.Where(x => x.LibraryId != null && set.Contains(NormalizeId(x.LibraryId))).ToList();
            }
            var arrPath = copy.Movie?.Path ?? copy.Series?.Path;
            if (!string.IsNullOrWhiteSpace(arrPath))
            {
                foreach (var map in copy.Instance.PathMappings)
                {
                    if (string.IsNullOrWhiteSpace(map.ArrPath) || string.IsNullOrWhiteSpace(map.JellyfinPath)) continue;
                    var from = Norm(map.ArrPath);
                    var folder = Norm(arrPath);
                    if (!folder.StartsWith(from, StringComparison.OrdinalIgnoreCase)) continue;
                    var mapped = Norm(map.JellyfinPath) + folder[from.Length..];
                    var hits = jf.Where(x => x.Path != null && (Norm(x.Path) + "/").StartsWith(mapped.TrimEnd('/') + "/", StringComparison.OrdinalIgnoreCase)).ToList();
                    if (hits.Count > 0) return hits;
                }
                var tail = Tail(Norm(arrPath), 2);
                if (tail != null)
                {
                    var hits = jf.Where(x => x.Path != null && (Tail(TitleFolder(Norm(x.Path), copy.Movie != null), 2) is { } t) && string.Equals(t, tail, StringComparison.OrdinalIgnoreCase)).ToList();
                    if (hits.Count > 0) return hits;
                }
            }
            return arrCopies == 1 ? jf.ToList() : new List<JfCopy>();
        }

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

        private static CopyState ApplyRequest(CopyState state, RequestFacts? request)
        {
            if (request == null) return state;
            if (state.Stage is StatusStage.NotHere or StatusStage.None)
            {
                if (request.Declined) return new CopyState(StatusStage.NotHere, StatusReasonCode.Declined);
                if (request.Pending) return new CopyState(StatusStage.Asked, StatusReasonCode.AwaitingApproval, Since: request.AskedAt);
                if (request.ApprovedAt != null) return new CopyState(StatusStage.Approved, StatusReasonCode.Approved, Since: request.ApprovedAt);
            }
            return state;
        }

        private static CopyState Looking(DateTime? since, ComposeContext c)
        {
            var longer = since.HasValue && c.Now - since.Value > TimeSpan.FromHours(c.LookingHours);
            return new CopyState(StatusStage.Looking, longer ? StatusReasonCode.NoReleaseYet : StatusReasonCode.Looking, Since: since);
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
            if (state.Date is DateTime date) p["date"] = Iso(date);
            if (state.Since is DateTime since && state.Reason is StatusReasonCode.NoReleaseYet or StatusReasonCode.Looking or StatusReasonCode.LibraryPending or StatusReasonCode.ImportBlocked or StatusReasonCode.Stalled)
                p["since"] = Iso(since);
            return new StatusReason { Code = state.Reason, Params = p.Count > 0 ? p : null };
        }

        private static IReadOnlyDictionary<string, string> Params(params (string Key, string Value)[] pairs)
            => pairs.ToDictionary(p => p.Key, p => p.Value);

        private static string Iso(DateTime d) => DateTime.SpecifyKind(d.Kind == DateTimeKind.Local ? d.ToUniversalTime() : d, DateTimeKind.Utc).ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture);

        private static string Id(Guid id) => id.ToString("N", CultureInfo.InvariantCulture);

        private static DateTime? Valid(DateTime? d) => d.HasValue && d.Value.Year > 1900 ? d : null;

        private static DateTime? Latest(DateTime? a, DateTime? b) => a == null ? b : b == null ? a : (a > b ? a : b);
    }
}
