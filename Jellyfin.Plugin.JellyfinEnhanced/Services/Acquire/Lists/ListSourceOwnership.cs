using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists
{
    /// <summary>
    /// The part of a linked source's provenance that list core maintains in the same locked write as its own changes:
    /// a swap-in transfers what a source key owns from the entry to the real items that replaced (or partly filled) it,
    /// and an editor removing a source-owned entry tombstones its key so a sync never adds it back. Fetching, syncing,
    /// drops and narrowing belong to the import/source track, which extends this class's rules, never duplicates them.
    /// </summary>
    public static class ListSourceOwnership
    {
        /// <summary>
        /// Swap-in hook (phase 3): <paramref name="itemIds"/> ("N") replaced or partly filled <paramref name="placeholder"/>.
        /// Every key that owns the placeholder (one per episode for grouped sources, or overlapping keys that share it)
        /// takes the items it stands for: an item the placeholder recorded as filled for an episode goes to that episode's
        /// key and to the owning keys of a wider scope that contains it (its season's key, a series key), never to another
        /// episode's or season's key; any other item (a
        /// movie, a collection's Season item) goes to every owning key. Once the placeholder is no longer in <c>doc.Items</c> (retired)
        /// the keys own only the items. Call it AFTER updating <c>doc.Items</c> and <c>Filled</c>, in the same locked
        /// write. A placeholder that was only "present" (not added by sync) stays unowned.
        /// </summary>
        /// <param name="doc">The list document being written.</param>
        /// <param name="placeholder">The placeholder that was swapped in (or filled).</param>
        /// <param name="itemIds">Real item ids inserted for it.</param>
        /// <returns>True when ownership changed.</returns>
        public static bool OnSwapped(ListDoc doc, Placeholder placeholder, IReadOnlyCollection<string> itemIds) =>
            OnSwapped(doc, placeholder, itemIds, retired: !doc.Items.Any(p => p.Id == placeholder.Id));

        /// <summary>
        /// Swap-in hook with an explicit retirement flag (for callers that record ownership before they remove a retired
        /// placeholder). See <see cref="OnSwapped(ListDoc, Placeholder, IReadOnlyCollection{string})"/>.
        /// </summary>
        /// <param name="doc">The list document being written.</param>
        /// <param name="placeholder">The placeholder that was swapped in (or filled).</param>
        /// <param name="itemIds">Real item ids ("N") that entered the list for it.</param>
        /// <param name="retired">True when the placeholder is retired (complete).</param>
        /// <returns>True when ownership changed.</returns>
        public static bool OnSwapped(ListDoc doc, Placeholder placeholder, IReadOnlyCollection<string> itemIds, bool retired)
        {
            var source = doc.Source;
            if (source == null || string.IsNullOrEmpty(placeholder.Id))
            {
                return false;
            }

            var keys = source.Owned.Where(e => e.Value.PhId == placeholder.Id).Select(e => e.Key).ToList();
            if (keys.Count == 0)
            {
                return false;
            }

            // Which episodes each item filled (the swap records them before calling this).
            var filled = new Dictionary<string, HashSet<(int, int)>>(StringComparer.Ordinal);
            foreach (var fill in placeholder.Filled)
            {
                if (Guid.TryParse(fill.ItemId, out var fillId))
                {
                    var n = fillId.ToString("N", CultureInfo.InvariantCulture);
                    if (!filled.TryGetValue(n, out var coords))
                    {
                        filled[n] = coords = new HashSet<(int, int)>();
                    }

                    coords.Add((fill.S, fill.E));
                }
            }

            var changed = false;
            foreach (var raw in itemIds)
            {
                if (!Guid.TryParse(raw, out var id))
                {
                    continue;
                }

                var itemId = id.ToString("N", CultureInfo.InvariantCulture);
                var targets = keys;
                if (filled.TryGetValue(itemId, out var episodes))
                {
                    // Each key takes the fills of its own scope: a series key every episode, a season key its season's,
                    // an episode key its episode (as AttachCovered does).
                    var matching = keys.Where(k => KeyCovers(k, episodes)).ToList();
                    if (matching.Count > 0)
                    {
                        targets = matching;
                    }
                }

                foreach (var key in targets)
                {
                    var owned = source.Owned[key];
                    if (!owned.ItemIds.Contains(itemId, StringComparer.Ordinal))
                    {
                        owned.ItemIds.Add(itemId);
                        changed = true;
                    }
                }
            }

            if (retired)
            {
                foreach (var key in keys)
                {
                    source.Owned[key].PhId = null;
                }

                changed = true;
            }

            return changed;
        }

        /// <summary>
        /// An editor removed a sync-owned entry (placeholder deleted, or its real items removed from the list): forget
        /// the ownership and tombstone the key.
        /// </summary>
        /// <param name="source">Linked source.</param>
        /// <param name="sourceKey">Key.</param>
        /// <param name="nowUtc">Now.</param>
        /// <returns>True when the key was owned.</returns>
        public static bool OnUserRemoved(ListSource source, string sourceKey, DateTime nowUtc)
        {
            if (!source.Owned.Remove(sourceKey))
            {
                return false;
            }

            source.UserRemovedKeys[sourceKey] = nowUtc.ToString("o", CultureInfo.InvariantCulture);
            return true;
        }

        // Whether a key's scope takes any of these filled episodes: a series key (no season, or a key of another shape)
        // all of them, a season key those of its season, an episode key its own episode.
        private static bool KeyCovers(string key, HashSet<(int, int)> episodes)
        {
            var parts = key.Split('|');
            if (parts.Length != 4 || parts[2].Length == 0 || !int.TryParse(parts[2], NumberStyles.None, CultureInfo.InvariantCulture, out var season))
            {
                return true;
            }

            if (parts[3].Length == 0)
            {
                return episodes.Any(c => c.Item1 == season);
            }

            return int.TryParse(parts[3], NumberStyles.None, CultureInfo.InvariantCulture, out var episode) && episodes.Contains((season, episode));
        }
    }
}
