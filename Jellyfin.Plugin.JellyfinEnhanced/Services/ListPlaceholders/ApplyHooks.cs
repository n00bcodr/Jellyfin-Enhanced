using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders
{
    /// <summary>
    /// Extension points of <see cref="ListPlaceholderService.ApplyAsync"/> that run INSIDE its locked write, so a linked
    /// source's provenance (F1) and a sync's precondition/removals (F2–F3) are atomic with the entries they describe.
    /// </summary>
    public sealed class ApplyHooks
    {
        /// <summary>
        /// Checked on the freshly loaded document under the list lock, before anything is applied. Return an error
        /// code to abort with 409 (e.g. the linked source changed generation since the sync started), or null.
        /// </summary>
        public Func<ListDoc, string?>? Precondition { get; init; }

        /// <summary>
        /// Runs after the entries were applied (Jellyfin updated, <see cref="ApplyResultDto"/> final except its view) and
        /// before the document is saved. May mutate the document (and remove real entries in Jellyfin); return true
        /// when it changed anything so the document is saved and the playlist order re-reconciled. The third argument
        /// is the entries as applied, after C1 expansion: an in-library movie became its item, a TV scope its present
        /// episodes (or a collection's Season / Series item) plus the placeholder; every entry keeps its request index.
        /// </summary>
        public Func<ListDoc, ApplyResultDto, IReadOnlyList<ApplyEntry>, Task<bool>>? AfterApplyAsync { get; init; }

        /// <summary>
        /// Runs when Jellyfin failed part-way through the apply, before the partial document is saved, with an
        /// <see cref="ApplyResultDto"/> that lists only what is in the list now (the placeholders that are saved anyway
        /// and the real items Jellyfin did add). Records their provenance in the same write, so a retry or the next sync
        /// sees them as imported rather than hand-added. Must not call Jellyfin; return true when it changed the document.
        /// The third argument is the entries as applied (see <see cref="AfterApplyAsync"/>).
        /// </summary>
        public Func<ListDoc, ApplyResultDto, IReadOnlyList<ApplyEntry>, bool>? AfterFailedApply { get; init; }
    }
}
