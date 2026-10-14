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
        private RequestWant[] Wants(TitleKey key) => !_ledger.Database.Available ? Array.Empty<RequestWant>() : _ledger.ForTitle(_aliases.Canonical(key.Title).ToString()).ToArray();
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
                Sent = wants.Where(w => w.Status == "sent").SelectMany(SentParts).ToArray() };
        }

        /// <summary>
        /// The parts of the title a sent want covers, at the time it was last sent (its last change). A request
        /// moved from Seerr went out in Seerr long before the move: it counts from when it was asked for there.
        /// </summary>
        internal static IEnumerable<RequestSentPart> SentParts(RequestWant want)
        {
            var fourK = want.Input.Variant == "4k";
            var at = (want.OriginKind == RequestOrigin.SeerrImportKind ? want.CreatedAt : want.UpdatedAt).UtcDateTime;
            if (want.Input.Scope == "episodes")
                return want.Input.Episodes.Select(e => new RequestSentPart(fourK, e.Season, e.Episode, at));
            if (want.Input.Scope == "movie" || want.Input.Seasons.Length == 0)
                return new[] { new RequestSentPart(fourK, null, null, at) };
            return want.Input.Seasons.Select(s => new RequestSentPart(fourK, s, null, at));
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
