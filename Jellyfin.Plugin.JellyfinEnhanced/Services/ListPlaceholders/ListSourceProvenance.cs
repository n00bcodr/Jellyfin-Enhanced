using System;
using System.Collections.Generic;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders
{
    /// <summary>
    /// Keeps a linked source's ownership record (F1, <see cref="ListSource.Owned"/>) in step with swap-in. Called in the
    /// SAME locked write that records the swap, so the list-source sync (phase 5) sees which real entries its own
    /// placeholders turned into and can apply "remove dropped entries" to them.
    /// </summary>
    public static class ListSourceProvenance
    {
        /// <summary>
        /// Records that a placeholder's scope turned into real list entries. Only placeholders the sync itself added are
        /// tracked: when <paramref name="placeholder"/> has a <see cref="Placeholder.SourceKey"/> whose ownership record
        /// still points at it, the item ids are added to that record, and once the placeholder is retired the record no
        /// longer points at a placeholder. Anything else (no source, user-added placeholder, presence-only key) is left
        /// untouched.
        /// </summary>
        /// <param name="doc">The document being written (mutable copy, list lock held).</param>
        /// <param name="placeholder">The placeholder that was (partly) swapped in.</param>
        /// <param name="itemIds">Real item ids ("N") that entered the list for it.</param>
        /// <param name="retired">True when the placeholder was removed (complete).</param>
        /// <returns>True when the ownership record changed.</returns>
        public static bool OnSwapped(ListDoc doc, Placeholder placeholder, IReadOnlyCollection<string> itemIds, bool retired)
        {
            ArgumentNullException.ThrowIfNull(doc);
            ArgumentNullException.ThrowIfNull(placeholder);
            if (doc.Source == null || string.IsNullOrEmpty(placeholder.SourceKey)
                || !doc.Source.Owned.TryGetValue(placeholder.SourceKey, out var owned)
                || !string.Equals(owned.PhId, placeholder.Id, StringComparison.Ordinal))
            {
                return false;
            }

            var changed = false;
            foreach (var itemId in itemIds)
            {
                if (!owned.ItemIds.Contains(itemId))
                {
                    owned.ItemIds.Add(itemId);
                    changed = true;
                }
            }

            if (retired)
            {
                owned.PhId = null;
                changed = true;
            }

            return changed;
        }
    }
}
