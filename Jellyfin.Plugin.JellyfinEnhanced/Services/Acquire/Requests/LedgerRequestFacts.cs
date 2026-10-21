using System;
using System.Collections.Generic;
using System.Linq;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Requests
{
    /// <summary>Request facts for the shared status/feed surfaces, selecting the configured authority.</summary>
    public sealed class LedgerRequestFacts : IArrRequestFacts
    {
        private readonly RequestLedger _ledger;
        private readonly SeerrRequestReadModel _seerr;
        private readonly TitleAliases _aliases;
        private readonly Func<DateTimeOffset> _now;
        /// <summary>
        /// How long a request Jellyfin Enhanced sent Seerr counts as held here while Seerr's request list doesn't show it
        /// yet: the list is read about a second after a confirmed send (and again within a minute when a read fails), so
        /// past this the list (or its absence) is what's true. Bounds an ask Seerr later dropped or merged into another.
        /// </summary>
        internal static readonly TimeSpan SentUnseenFor = TimeSpan.FromMinutes(15);
        /// <summary>Creates the authority-selecting reader; it does no network I/O.</summary>
        public LedgerRequestFacts(RequestLedger ledger, SeerrRequestReadModel seerr, TitleAliases aliases)
            : this(ledger, seerr, aliases, null)
        {
        }
        /// <summary>The reader with an explicit clock (tests).</summary>
        internal LedgerRequestFacts(RequestLedger ledger, SeerrRequestReadModel seerr, TitleAliases aliases, Func<DateTimeOffset>? now)
        { _ledger = ledger; _seerr = seerr; _aliases = aliases; _now = now ?? (() => DateTimeOffset.UtcNow); }
        private static bool Direct => ArrInstanceLibraries.AbsentParentalEnabled && JellyfinEnhanced.Instance?.Configuration.ArrRequestBackend == "je";
        // Seerr mode with Jellyfin Enhanced's request flow on: asks go through the ledger to Seerr, so some are held here first.
        private static bool SeerrHeld => ArrInstanceLibraries.AbsentParentalEnabled && JellyfinEnhanced.Instance?.Configuration.ArrRequestBackend == "seerr";
        private string Canonical(TitleKey key) => _aliases.Canonical(key.Title).ToString();
        private RequestWant[] Wants(TitleKey key) => !_ledger.Database.Available ? Array.Empty<RequestWant>() : _ledger.ForTitle(Canonical(key)).ToArray();

        /// <summary>
        /// Seerr mode: the asks for a title Seerr can't know about yet (<see cref="Unseen"/>) on the Seerr Jellyfin
        /// Enhanced points at now. Empty in Jellyfin Enhanced mode, with phase 3 off, or with no Seerr set up.
        /// </summary>
        internal IReadOnlyList<RequestWant> Held(TitleKey key)
        {
            if (!SeerrHeld || _seerr.CurrentSource is not { } source) return Array.Empty<RequestWant>();
            var wants = Wants(key);
            if (wants.Length == 0) return wants;
            var target = RequestLedger.SeerrTargetKey(source);
            var records = _seerr.ForTitle(key);
            var now = _now();
            return wants.Where(w => Unseen(w, target, records, now)).ToArray();
        }

        /// <summary>
        /// True when a ledger ask on <paramref name="target"/> (the current Seerr) isn't in Seerr's list yet: it waits for
        /// an OK here, it is OK'd and waits to be sent (or to be retried), or it was sent less than
        /// <see cref="SentUnseenFor"/> ago and no Seerr request by the same person for the same edition covers what it
        /// asks for yet (Seerr's list is read a moment later).
        /// </summary>
        /// <param name="want">A ledger ask.</param>
        /// <param name="target">The current Seerr target (<see cref="RequestLedger.SeerrTargetKey"/>).</param>
        /// <param name="records">Seerr's requests for the title.</param>
        /// <param name="now">Now.</param>
        internal static bool Unseen(RequestWant want, string target, IReadOnlyList<SeerrRequestRecord> records, DateTimeOffset now)
            => want.TargetKey == target && (want.Status is "pending" or "queued"
                || (want.Status == "sent" && now - want.UpdatedAt < SentUnseenFor && !records.Any(r => Covers(r, want))));

        /// <summary>
        /// True when a Seerr request is the one <paramref name="want"/> became: by the same person, for the same edition,
        /// naming every season the ask names (or the whole series), and still on or changed since the ask (an old
        /// declined request isn't a new ask's).
        /// </summary>
        internal static bool Covers(SeerrRequestRecord record, RequestWant want)
            => record.RequestedBy == want.UserId && record.Is4k == (want.Input.Variant == "4k")
               && (record.IsMovie || record.Seasons.Count == 0 || want.Input.SeasonNumbers.All(s => record.Seasons.Contains(s)))
               && (record.Active || (record.UpdatedAt ?? record.CreatedAt ?? DateTime.MaxValue) >= want.CreatedAt.UtcDateTime);

        /// <summary>
        /// Seerr's facts with the facts of asks Seerr doesn't know about yet: asked when the first was, waiting for an OK
        /// or asked by the viewer when either says so, OK'd (per edition) when the first was, sent parts of both, and
        /// declined or done only when both say so (an edition Seerr has done stays done). Either alone when the other has
        /// none; Seerr's requests that were all declined give way to a new ask (it isn't dated by them).
        /// </summary>
        internal static RequestFacts? Merge(RequestFacts? seerr, RequestFacts? held)
        {
            if (seerr == null || held == null) return seerr ?? held;
            static DateTime? Min(DateTime? a, DateTime? b) => a == null ? b : b == null ? a : a < b ? a : b;
            // Seerr's requests were all declined: the new ask is dated by itself, not by them.
            var fresh = seerr.Declined && !held.Declined;
            return new RequestFacts
            {
                AskedAt = fresh ? held.AskedAt : Min(seerr.AskedAt, held.AskedAt),
                AskedByViewer = seerr.AskedByViewer || held.AskedByViewer,
                Pending = seerr.Pending || held.Pending,
                // Held back at sending only while nothing Seerr holds is simply waiting for an OK.
                HeldReason = seerr.Pending ? null : held.HeldReason,
                ApprovedAt = Min(seerr.ApprovedAt, held.ApprovedAt),
                ApprovedStandardAt = Min(seerr.ApprovedStandardAt, held.ApprovedStandardAt),
                Approved4kAt = Min(seerr.Approved4kAt, held.Approved4kAt),
                StandardDone = seerr.StandardDone || held.StandardDone,
                FourKDone = seerr.FourKDone || held.FourKDone,
                Declined = seerr.Declined && held.Declined,
                Fulfilled = seerr.Fulfilled && held.Fulfilled,
                Sent = seerr.Sent.Concat(held.Sent).Distinct().ToArray(),
                // Held here after its OK only while Seerr has nothing OK'd of its own for it.
                HeldAfterOk = held.HeldAfterOk && seerr.ApprovedAt == null,
            };
        }

        /// <inheritdoc />
        /// <remarks>In Seerr mode both Seerr's list and the ledger's (asks held before they reach Seerr).</remarks>
        public long Revision => Direct ? _ledger.Revision : SeerrHeld ? unchecked((_seerr.Revision * 1_000_000_007L) + _ledger.Revision) : _seerr.Revision;

        /// <inheritdoc />
        /// <remarks>Seerr mode: Seerr's requests together with the asks it doesn't know about yet (<see cref="Held"/>).</remarks>
        public RequestFacts? For(TitleKey titleKey, StatusViewer viewer)
        {
            if (!Direct) return Merge(_seerr.For(titleKey, viewer), HeldFacts(titleKey, Held(titleKey), viewer));
            return FactsOf(Wants(titleKey), viewer.UserId, () => _ledger.Dispatches(Canonical(titleKey)));
        }

        /// <inheritdoc />
        /// <remarks>
        /// The configured authority, as <see cref="For"/>: in Jellyfin Enhanced mode the ledger's asks for the
        /// episode itself or a season that holds it; in Seerr mode Seerr's requests for its season, with the asks for
        /// the episode or its season Seerr doesn't know about yet.
        /// </remarks>
        public RequestFacts? ForEpisode(TitleKey seriesKey, int season, int episode, StatusViewer viewer)
        {
            var part = new RequestEpisode(season, episode);
            if (!Direct) return Merge(_seerr.ForEpisode(seriesKey, season, episode, viewer), HeldFacts(seriesKey, Held(seriesKey).Where(w => w.Input.Covers(part)), viewer));
            return FactsOf(Wants(seriesKey).Where(w => w.Input.Covers(part)), viewer.UserId, () => _ledger.Dispatches(Canonical(seriesKey)));
        }

        /// <inheritdoc />
        /// <remarks>
        /// The configured authority, as <see cref="For"/>: in Jellyfin Enhanced mode the ledger's asks that name
        /// the whole season (an ask for some of its episodes covers those episodes only); in Seerr mode Seerr's
        /// requests for it, with the asks naming it Seerr doesn't know about yet.
        /// </remarks>
        public RequestFacts? ForSeason(TitleKey seriesKey, int season, StatusViewer viewer)
        {
            if (!Direct) return Merge(_seerr.ForSeason(seriesKey, season, viewer), HeldFacts(seriesKey, Held(seriesKey).Where(w => w.Input.Seasons.Contains(season)), viewer));
            return FactsOf(Wants(seriesKey).Where(w => w.Input.Seasons.Contains(season)), viewer.UserId, () => _ledger.Dispatches(Canonical(seriesKey)));
        }

        /// <inheritdoc />
        /// <remarks>The configured authority, as <see cref="For"/>: the asks for that edition covering the part.</remarks>
        public RequestFacts? ForPart(TitleKey titleKey, bool fourK, IReadOnlyList<int> seasons, IReadOnlyList<(int Season, int Episode)> episodes, StatusViewer viewer)
        {
            bool Covers(RequestWant w) => (w.Input.Variant == "4k") == fourK && ((seasons.Count == 0 && episodes.Count == 0)
                || seasons.Any(n => w.Input.Seasons.Contains(n)) || episodes.Any(e => w.Input.Covers(new RequestEpisode(e.Season, e.Episode))));
            if (!Direct) return Merge(_seerr.ForPart(titleKey, fourK, seasons, episodes, viewer), HeldFacts(titleKey, Held(titleKey).Where(Covers), viewer));
            return FactsOf(Wants(titleKey).Where(Covers), viewer.UserId, () => _ledger.Dispatches(Canonical(titleKey)));
        }

        /// <inheritdoc />
        /// <remarks>Seerr mode: Seerr's word (as the Requests page reads it); Jellyfin Enhanced mode judges by the arrs (null).</remarks>
        public PartAvailability? AvailabilityForPart(TitleKey titleKey, bool fourK, IReadOnlyList<int> seasons, IReadOnlyList<(int Season, int Episode)> episodes, StatusViewer viewer)
            => Direct ? null : _seerr.AvailabilityForPart(titleKey, fourK, seasons, episodes, viewer);

        private RequestFacts? HeldFacts(TitleKey key, IEnumerable<RequestWant> held, StatusViewer viewer)
        {
            var list = held as IReadOnlyCollection<RequestWant> ?? held.ToList();
            return list.Count == 0 ? null : FactsOf(list, viewer.UserId, () => _ledger.Dispatches(Canonical(key)));
        }

        /// <summary>
        /// The request facts of some requests for one title (all of a household's, or one person's): asked, waiting
        /// for an OK, OK'd (per edition), declined, done, and the parts that went out with when. Null when none of
        /// them is more than cancelled.
        /// </summary>
        /// <param name="all">Requests for one title.</param>
        /// <param name="viewer">Who is looking (for "asked by you").</param>
        /// <param name="dispatches">What went out for the title (read only when one of them was sent).</param>
        internal static RequestFacts? FactsOf(IEnumerable<RequestWant> all, Guid viewer, Func<IReadOnlyList<RequestDispatch>> dispatches)
        {
            var wants = all.Where(w => w.Status != "cancelled").ToArray();
            if (wants.Length == 0) return null;
            var approved = wants.Where(w => w.Status is "queued" or "sent" or "stale" or "fulfilled").ToArray();
            DateTime? At(string? variant) => approved.Where(w => variant == null || w.Input.Variant == variant).Select(w => (DateTime?)w.UpdatedAt.UtcDateTime).Min();
            // Pending is either waiting for an OK or held back at sending (parked: bad add defaults, a changed
            // instance...); held only when nothing pending is simply waiting for an OK.
            var pending = wants.Where(w => w.Status == "pending").ToArray();
            var held = pending.Length > 0 && pending.All(w => w.Reason is not ("awaiting_approval" or "over_quota") && !string.IsNullOrEmpty(w.Reason)) ? pending[0].Reason : null;
            // The viewer's own whole seasons still asked for: not a fulfilled ask (what arrived is the library's to
            // show, and a season removed again since is offered again), not a declined one.
            var viewerSeasons = wants.Where(w => w.UserId == viewer && w.Status is not ("declined" or "fulfilled") && w.Input.Variant == "standard" && w.Input.Scope is ("seasons" or "next_season"))
                .SelectMany(w => w.Input.Seasons).Distinct().Order().ToArray();
            return new RequestFacts { AskedAt = wants.Min(w => w.CreatedAt).UtcDateTime, AskedByViewer = wants.Any(w => w.UserId == viewer), ViewerSeasons = viewerSeasons,
                Pending = pending.Length > 0, HeldReason = held, ApprovedAt = At(null), ApprovedStandardAt = At("standard"), Approved4kAt = At("4k"),
                Declined = wants.All(w => w.Status == "declined"),
                Fulfilled = wants.Any(w => w.Status == "fulfilled") && wants.All(w => w.Status is "fulfilled" or "declined"),
                StandardDone = wants.Any(w => w.Status == "fulfilled" && w.Input.Variant == "standard"), FourKDone = wants.Any(w => w.Status == "fulfilled" && w.Input.Variant == "4k"),
                Sent = Sent(wants, dispatches),
                NotListed = approved.Length > 0 && approved.All(w => w.Status == "queued" && w.Reason == "not_aired"),
                HeldAfterOk = approved.Length > 0 && approved.All(w => w.Status is "queued" or "sent" or "stale" && RequestHubProjection.StuckReasons.Contains(w.Reason ?? string.Empty)) };
        }

        /// <summary>
        /// The part of a title some requests (one person's, for one title) ask for, as the status service scopes a
        /// title by: the seasons (whole-season, next-season and "keep getting" asks: the season asked for), the single
        /// episodes outside them, whether only the 4K copy was asked for, and those requests' own facts. Cancelled and
        /// declined requests count only when nothing else is left (a row that says "said no").
        /// </summary>
        /// <param name="wants">Requests for one title (not empty).</param>
        /// <param name="viewer">Whose they are.</param>
        /// <param name="dispatches">What went out for the title.</param>
        internal static ArrStatusService.RequestScope ScopeOf(IReadOnlyList<RequestWant> wants, Guid viewer, Func<IReadOnlyList<RequestDispatch>> dispatches)
        {
            var asked = wants.Where(w => w.Status is not ("cancelled" or "declined")).ToList();
            if (asked.Count == 0) asked = wants.ToList();
            var movie = TitleKey.Parse(asked[0].Input.Key)?.IsMovie == true;
            var seasons = new List<int>();
            var episodes = new List<(int Season, int Episode)>();
            if (!movie)
            {
                var all = asked.Where(w => w.Input.Scope != "episodes").SelectMany(w => w.Input.Seasons).Distinct().OrderBy(n => n).ToList();
                // Specials count only when they are all that was asked for (as the Seerr scope).
                seasons = all.Where(n => n > 0).ToList();
                if (seasons.Count == 0 && all.Contains(0)) seasons.Add(0);
                episodes = asked.Where(w => w.Input.Scope == "episodes").SelectMany(w => w.Input.Episodes)
                    .Where(e => !seasons.Contains(e.Season)).Select(e => (e.Season, e.Episode)).Distinct()
                    .OrderBy(e => e.Season).ThenBy(e => e.Episode).ToList();
            }
            return new ArrStatusService.RequestScope(seasons, asked.All(w => w.Input.Variant == "4k"), FactsOf(asked, viewer, dispatches), Episodes: episodes);
        }

        private static readonly string[] OpenStates = { "pending", "queued", "sent", "stale" };

        /// <summary>
        /// One person's requests as the rows their lists show: open requests that ask for some of the same part of one
        /// title edition (<see cref="MutationInput.Overlaps"/>, followed through: A overlaps B overlaps C is one row) are
        /// one row, so a title asked for twice (an ask and the Seerr request it was linked to when requests moved) is
        /// listed and counted once. Asks for different parts (season 1, later season 2; an ask split at the series
        /// threshold) stay rows of their own. The most open state leads (waiting for an OK, then queued, sent, stale); the
        /// row asks for every member's seasons and episodes and was asked for when its first member was. Finished,
        /// declined and cancelled requests stay rows of their own. Rows keep the order of their first member in
        /// <paramref name="wants"/>.
        /// </summary>
        /// <param name="wants">One person's requests, in display order.</param>
        internal static IReadOnlyList<TitleRequests> PerTitle(IEnumerable<RequestWant> wants)
        {
            var groups = new List<List<RequestWant>>();
            foreach (var want in wants)
            {
                if (Array.IndexOf(OpenStates, want.Status) < 0) { groups.Add(new List<RequestWant> { want }); continue; }
                var joined = groups.Where(g => Array.IndexOf(OpenStates, g[0].Status) >= 0
                    && g.Any(w => w.UserId == want.UserId && w.Input.Overlaps(want.Input))).ToList();
                if (joined.Count == 0) { groups.Add(new List<RequestWant> { want }); continue; }
                // The first group listed keeps its place; the others it now bridges join it.
                var into = joined[0];
                foreach (var other in joined.Skip(1))
                {
                    into.AddRange(other);
                    groups.Remove(other);
                }
                into.Add(want);
            }
            return groups.Select(g => g.Count == 1 ? new TitleRequests(g[0], g) : Merge(g)).ToList();
        }

        private static TitleRequests Merge(List<RequestWant> group)
        {
            // Stable: the first member listed leads among equally open ones.
            var members = group.Select((w, i) => (w, i)).OrderBy(x => Array.IndexOf(OpenStates, x.w.Status)).ThenBy(x => x.i).Select(x => x.w).ToList();
            var lead = members[0];
            var input = lead.Input;
            if (input.Scope != "movie")
            {
                var whole = members.Where(w => w.Input.Scope != "episodes").ToList();
                var seasons = whole.SelectMany(w => w.Input.Seasons).Distinct().OrderBy(n => n).ToArray();
                var episodes = members.Where(w => w.Input.Scope == "episodes").SelectMany(w => w.Input.Episodes)
                    .Where(e => !seasons.Contains(e.Season)).Distinct().OrderBy(e => e.Season).ThenBy(e => e.Episode).ToArray();
                var scopes = whole.Select(w => w.Input.Scope).Distinct().ToList();
                var scope = whole.Count == 0 ? "episodes"
                    : scopes.Count == 1 && (scopes[0] == "seasons" || seasons.Length == 1) ? scopes[0] : "seasons";
                input = input with { Scope = scope, Seasons = seasons, Episodes = episodes };
            }
            var row = lead with { Input = input, CreatedAt = members.Min(w => w.CreatedAt), UpdatedAt = members.Max(w => w.UpdatedAt) };
            return new TitleRequests(row, members);
        }

        private static RequestSentPart[] Sent(RequestWant[] wants, Func<IReadOnlyList<RequestDispatch>> dispatches)
        {
            var sent = wants.Where(w => w.Status == "sent").ToArray();
            if (sent.Length == 0) return Array.Empty<RequestSentPart>();
            var went = dispatches();
            return sent.SelectMany(w => SentParts(w, went)).Distinct().ToArray();
        }

        /// <summary>
        /// The parts of the title a sent want covers, each at the latest time something covering it went out to the
        /// want's target (<see cref="RequestLedger.Dispatches"/>): a confirmed send, or a request that was already
        /// processing in Seerr when it moved (from when it was asked for there). Joining scope that was already sent,
        /// an approval of it or a target move restarts nothing; a part nothing went out for has no time.
        /// </summary>
        internal static IEnumerable<RequestSentPart> SentParts(RequestWant want, IReadOnlyList<RequestDispatch> dispatches)
        {
            var fourK = want.Input.Variant == "4k";
            var went = dispatches.Where(d => d.TargetKey == want.TargetKey && d.Input.Key == want.Input.Key && d.Input.Variant == want.Input.Variant).ToArray();
            DateTime? When(Func<MutationInput, bool> covers)
                => went.Where(d => covers(d.Input)).Select(d => (DateTime?)d.At.UtcDateTime).Max();
            if (want.Input.Scope == "episodes")
            {
                foreach (var e in want.Input.Episodes)
                {
                    if (When(i => i.Covers(e)) is DateTime at) yield return new RequestSentPart(fourK, e.Season, e.Episode, at);
                }
            }
            else if (want.Input.Scope == "movie" || want.Input.Seasons.Length == 0)
            {
                if (When(i => i.Scope == want.Input.Scope) is DateTime at) yield return new RequestSentPart(fourK, null, null, at);
            }
            else
            {
                foreach (var s in want.Input.Seasons)
                {
                    if (When(i => i.Seasons.Contains(s)) is DateTime at) yield return new RequestSentPart(fourK, s, null, at);
                }
            }
        }
        /// <inheritdoc />
        public bool AskedBy(TitleKey titleKey, Guid userId) => Direct ? Wants(titleKey).Any(w => w.UserId == userId && w.Status != "cancelled") : _seerr.AskedBy(titleKey, userId) || Held(titleKey).Any(w => w.UserId == userId);
        /// <inheritdoc />
        public bool Requested(TitleKey titleKey) => Direct ? Wants(titleKey).Any(w => w.Status != "cancelled") : _seerr.Requested(titleKey) || Held(titleKey).Count > 0;
        /// <inheritdoc />
        public bool AskedLatelyBy(TitleKey titleKey, Guid userId) => Direct ? Wants(titleKey).Any(w => w.UserId == userId && (w.Status != "cancelled" || w.UpdatedAt > DateTimeOffset.UtcNow.AddMinutes(-10))) : _seerr.AskedLatelyBy(titleKey, userId) || Held(titleKey).Any(w => w.UserId == userId);
        /// <inheritdoc />
        public bool RequestedLately(TitleKey titleKey) => Direct ? Wants(titleKey).Any(w => w.Status != "cancelled" || w.UpdatedAt > DateTimeOffset.UtcNow.AddMinutes(-10)) : _seerr.RequestedLately(titleKey) || Held(titleKey).Count > 0;
    }

    /// <summary>
    /// One row of a person's request list (<see cref="LedgerRequestFacts.PerTitle"/>): the request that leads it, with
    /// every member's seasons and episodes and the first member's ask time, and the requests it stands for (the lead first).
    /// </summary>
    /// <param name="Row">The leading request as the row shows it.</param>
    /// <param name="Members">The requests the row stands for, the lead first.</param>
    internal sealed record TitleRequests(RequestWant Row, IReadOnlyList<RequestWant> Members)
    {
        /// <summary>The members not sent yet (waiting for an OK or queued): the ones Cancel withdraws.</summary>
        public IEnumerable<RequestWant> Unsent => Members.Where(w => w.Status is "pending" or "queued");
    }
}
