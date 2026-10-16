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
        /// <summary>Creates the authority-selecting reader; it does no network I/O.</summary>
        public LedgerRequestFacts(RequestLedger ledger, SeerrRequestReadModel seerr, TitleAliases aliases)
        { _ledger = ledger; _seerr = seerr; _aliases = aliases; }
        private static bool Direct => ArrInstanceLibraries.AbsentParentalEnabled && JellyfinEnhanced.Instance?.Configuration.ArrRequestBackend == "je";
        private string Canonical(TitleKey key) => _aliases.Canonical(key.Title).ToString();
        private RequestWant[] Wants(TitleKey key) => !_ledger.Database.Available ? Array.Empty<RequestWant>() : _ledger.ForTitle(Canonical(key)).ToArray();
        /// <inheritdoc />
        public long Revision => Direct ? _ledger.Revision : _seerr.Revision;
        /// <inheritdoc />
        public RequestFacts? For(TitleKey titleKey, StatusViewer viewer)
        {
            if (!Direct) return _seerr.For(titleKey, viewer);
            return FactsOf(Wants(titleKey), viewer.UserId, () => _ledger.Dispatches(Canonical(titleKey)));
        }

        /// <inheritdoc />
        /// <remarks>
        /// The configured authority, as <see cref="For"/>: in Jellyfin Enhanced mode the ledger's asks for the
        /// episode itself or a season that holds it; in Seerr mode Seerr's requests for its season.
        /// </remarks>
        public RequestFacts? ForEpisode(TitleKey seriesKey, int season, int episode, StatusViewer viewer)
        {
            if (!Direct) return _seerr.ForEpisode(seriesKey, season, episode, viewer);
            var part = new RequestEpisode(season, episode);
            return FactsOf(Wants(seriesKey).Where(w => w.Input.Covers(part)), viewer.UserId, () => _ledger.Dispatches(Canonical(seriesKey)));
        }

        /// <inheritdoc />
        /// <remarks>
        /// The configured authority, as <see cref="For"/>: in Jellyfin Enhanced mode the ledger's asks that name
        /// the whole season (an ask for some of its episodes covers those episodes only); in Seerr mode Seerr's
        /// requests for it.
        /// </remarks>
        public RequestFacts? ForSeason(TitleKey seriesKey, int season, StatusViewer viewer)
        {
            if (!Direct) return _seerr.ForSeason(seriesKey, season, viewer);
            return FactsOf(Wants(seriesKey).Where(w => w.Input.Seasons.Contains(season)), viewer.UserId, () => _ledger.Dispatches(Canonical(seriesKey)));
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
            return new RequestFacts { AskedAt = wants.Min(w => w.CreatedAt).UtcDateTime, AskedByViewer = wants.Any(w => w.UserId == viewer),
                Pending = wants.Any(w => w.Status == "pending"), ApprovedAt = At(null), ApprovedStandardAt = At("standard"), Approved4kAt = At("4k"),
                Declined = wants.All(w => w.Status == "declined"),
                Fulfilled = wants.Any(w => w.Status == "fulfilled") && wants.All(w => w.Status is "fulfilled" or "declined"),
                StandardDone = wants.Any(w => w.Status == "fulfilled" && w.Input.Variant == "standard"), FourKDone = wants.Any(w => w.Status == "fulfilled" && w.Input.Variant == "4k"),
                Sent = Sent(wants, dispatches),
                NotListed = approved.Length > 0 && approved.All(w => w.Status == "queued" && w.Reason == "not_aired") };
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

        /// <summary>
        /// The requests (one person's, for one title) that one status follows: one edition at a time, as each edition is
        /// its own copy. The edition still waited for (the standard copy first when both are), else the one that arrived
        /// last; cancelled and declined requests only when nothing else is left. So a 4K ask after the standard copy
        /// arrived is judged by the 4K copy, not shown Ready by the standard one.
        /// </summary>
        /// <param name="wants">Requests for one title.</param>
        internal static IReadOnlyList<RequestWant> EditionOf(IReadOnlyList<RequestWant> wants)
        {
            var asked = wants.Where(w => w.Status is not ("cancelled" or "declined")).ToList();
            if (asked.Count == 0) return wants;
            var open = asked.Where(w => w.Status is "pending" or "queued" or "sent" or "stale").ToList();
            var fourK = open.Count > 0 ? open.All(w => w.Input.Variant == "4k") : asked.MaxBy(w => w.UpdatedAt)!.Input.Variant == "4k";
            return asked.Where(w => (w.Input.Variant == "4k") == fourK).ToList();
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
        public bool AskedBy(TitleKey titleKey, Guid userId) => Direct ? Wants(titleKey).Any(w => w.UserId == userId && w.Status != "cancelled") : _seerr.AskedBy(titleKey, userId);
        /// <inheritdoc />
        public bool Requested(TitleKey titleKey) => Direct ? Wants(titleKey).Any(w => w.Status != "cancelled") : _seerr.Requested(titleKey);
        /// <inheritdoc />
        public bool AskedLatelyBy(TitleKey titleKey, Guid userId) => Direct ? Wants(titleKey).Any(w => w.UserId == userId && (w.Status != "cancelled" || w.UpdatedAt > DateTimeOffset.UtcNow.AddMinutes(-10))) : _seerr.AskedLatelyBy(titleKey, userId);
        /// <inheritdoc />
        public bool RequestedLately(TitleKey titleKey) => Direct ? Wants(titleKey).Any(w => w.Status != "cancelled" || w.UpdatedAt > DateTimeOffset.UtcNow.AddMinutes(-10)) : _seerr.RequestedLately(titleKey);
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
