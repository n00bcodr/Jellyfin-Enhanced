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
            var wants = Wants(titleKey).Where(w => w.Status != "cancelled").ToArray();
            if (wants.Length == 0) return null;
            var approved = wants.Where(w => w.Status is "queued" or "sent" or "stale" or "fulfilled").ToArray();
            DateTime? At(string? variant) => approved.Where(w => variant == null || w.Input.Variant == variant).Select(w => (DateTime?)w.UpdatedAt.UtcDateTime).Min();
            return new RequestFacts { AskedAt = wants.Min(w => w.CreatedAt).UtcDateTime, AskedByViewer = wants.Any(w => w.UserId == viewer.UserId),
                Pending = wants.Any(w => w.Status == "pending"), ApprovedAt = At(null), ApprovedStandardAt = At("standard"), Approved4kAt = At("4k"),
                Declined = wants.All(w => w.Status == "declined"), StandardDone = wants.Any(w => w.Status == "fulfilled" && w.Input.Variant == "standard"), FourKDone = wants.Any(w => w.Status == "fulfilled" && w.Input.Variant == "4k"),
                Sent = Sent(wants, () => _ledger.Dispatches(Canonical(titleKey))) };
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
}
