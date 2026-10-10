using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders.Sources
{
    /// <summary>What a sync's removeDropped step will do.</summary>
    public sealed class DropPlan
    {
        /// <summary>Sync-owned placeholders whose source entry left the list.</summary>
        public List<string> PlaceholderIds { get; } = new();

        /// <summary>Sync-owned real items that occur exactly once and whose source entry left the list.</summary>
        public List<Guid> ItemIds { get; } = new();

        /// <summary>Entries that left the source but stay: not added by sync, or a sync-owned item that occurs more than once.</summary>
        public int Kept { get; set; }

        /// <summary>
        /// Ownership a leaving key gives up without removing anything: placeholders and items that a key still in the
        /// source also owns (overlapping scopes). <see cref="ListSourceProvenance.ApplyDrops"/> strips them from the key.
        /// </summary>
        public List<(string Key, string? PlaceholderId, string? ItemId)> Released { get; } = new();

        /// <summary>Whether anything is removed.</summary>
        public bool Any => PlaceholderIds.Count > 0 || ItemIds.Count > 0;
    }

    /// <summary>
    /// The provenance rules of linked lists (design F1–F2), as pure functions over a <see cref="ListDoc"/>:
    /// <list type="bullet">
    /// <item>Provenance is by source key (<c>type|id|season|episode</c>), never by rank. <see cref="ListSource.Owned"/>
    /// maps a key to what the import/sync itself ADDED (a placeholder and/or real items); an entry that was already in
    /// the list is only "present" — never owned, never removed by sync.</item>
    /// <item>Swap-in moves ownership from the placeholder to the real items that replaced it
    /// (<see cref="OnSwapped"/>, called by the swap service in the same locked write).</item>
    /// <item>An editor deleting a sync-owned entry tombstones its key (<see cref="ListSource.UserRemovedKeys"/>,
    /// 90 days / 2× the item cap) so sync never adds it back.</item>
    /// <item>Add = in the snapshot, not handled by the previous complete snapshot, not owned, not tombstoned.</item>
    /// <item>removeDropped removes owned placeholders always and owned real items only when the item occurs exactly
    /// once (Jellyfin removes every copy of an item id); it never acts on a partial or failed fetch. Several keys can
    /// own the same entry (overlapping scopes such as a season and one of its episodes): it goes only when none of
    /// them is in the source any more.</item>
    /// </list>
    /// </summary>
    public static class ListSourceProvenance
    {
        /// <summary>How long a tombstone keeps a removed entry from being re-added.</summary>
        public static readonly TimeSpan UserRemovedRetention = TimeSpan.FromDays(90);

        /// <summary>Tombstone cap (2× the source item cap); the oldest go first.</summary>
        public const int MaxUserRemovedKeys = 2 * ListSourceFetcher.MaxItems;

        /// <summary>
        /// Swap-in hook (phase 3): <paramref name="itemIds"/> ("N") replaced or partly filled <paramref name="placeholder"/>.
        /// When the placeholder was sync-owned, the items become owned under its key; once the placeholder is no longer
        /// in <c>doc.Items</c> (retired) the key owns only the items. Call it AFTER updating <c>doc.Items</c>, in the same
        /// locked write. A placeholder that was only "present" (not added by sync) stays unowned.
        /// </summary>
        /// <param name="doc">The list document being written.</param>
        /// <param name="placeholder">The placeholder that was swapped in (or filled).</param>
        /// <param name="itemIds">Real item ids inserted for it.</param>
        /// <returns>True when ownership changed.</returns>
        public static bool OnSwapped(ListDoc doc, Placeholder placeholder, IReadOnlyCollection<string> itemIds)
        {
            var source = doc.Source;
            if (source == null)
            {
                return false;
            }

            var ids = itemIds.Select(raw => Guid.TryParse(raw, out var id) ? id.ToString("N", CultureInfo.InvariantCulture) : null).OfType<string>().ToList();
            var retired = !doc.Items.Any(p => p.Id == placeholder.Id);
            var changed = false;
            // Every key that owns the placeholder (usually its SourceKey; more when overlapping keys share it).
            foreach (var owned in source.Owned.Values.Where(o => o.PhId == placeholder.Id))
            {
                foreach (var itemId in ids.Where(id => !owned.ItemIds.Contains(id, StringComparer.Ordinal)))
                {
                    owned.ItemIds.Add(itemId);
                    changed = true;
                }

                if (retired)
                {
                    owned.PhId = null;
                    changed = true;
                }
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

        /// <summary>Tombstones keys an editor declined while reviewing an import (skipped rows).</summary>
        /// <param name="source">Linked source.</param>
        /// <param name="keys">Declined keys.</param>
        /// <param name="nowUtc">Now.</param>
        public static void Decline(ListSource source, IEnumerable<string> keys, DateTime nowUtc)
        {
            foreach (var key in keys)
            {
                if (!source.Owned.ContainsKey(key))
                {
                    source.UserRemovedKeys[key] = nowUtc.ToString("o", CultureInfo.InvariantCulture);
                }
            }
        }

        /// <summary>Records what an import or sync added: placeholders and real items it created become owned.</summary>
        /// <param name="source">Linked source.</param>
        /// <param name="key">Source key.</param>
        /// <param name="placeholderId">The placeholder it added, if any.</param>
        /// <param name="itemId">The real item ("N") it added, if any.</param>
        public static void RecordAdded(ListSource source, string key, string? placeholderId, string? itemId)
        {
            if (placeholderId == null && itemId == null)
            {
                return;
            }

            if (!source.Owned.TryGetValue(key, out var owned))
            {
                source.Owned[key] = owned = new SourceOwnership();
            }

            if (placeholderId != null)
            {
                owned.PhId = placeholderId;
            }

            if (itemId != null && !owned.ItemIds.Contains(itemId, StringComparer.Ordinal))
            {
                owned.ItemIds.Add(itemId);
            }

            source.UserRemovedKeys.Remove(key);
        }

        /// <summary>
        /// Finds sync-owned entries an editor removed since the last sync (the placeholder is gone and none of the owned
        /// items is in the list any more) and tombstones them. Missing items of a partly present key are forgotten.
        /// </summary>
        /// <param name="doc">Document.</param>
        /// <param name="realOccurrences">Real entries of the list: item id ("N") → occurrences.</param>
        /// <param name="nowUtc">Now.</param>
        /// <returns>Number of tombstoned keys.</returns>
        public static int DetectUserRemovals(ListDoc doc, IReadOnlyDictionary<string, int> realOccurrences, DateTime nowUtc)
        {
            var source = doc.Source;
            if (source == null)
            {
                return 0;
            }

            var placeholders = new HashSet<string>(doc.Items.Select(p => p.Id), StringComparer.Ordinal);
            var removed = 0;
            foreach (var (key, owned) in source.Owned.ToList())
            {
                if (owned.PhId != null && !placeholders.Contains(owned.PhId))
                {
                    owned.PhId = null;
                }

                owned.ItemIds.RemoveAll(id => !realOccurrences.ContainsKey(id));
                if (owned.PhId == null && owned.ItemIds.Count == 0)
                {
                    OnUserRemoved(source, key, nowUtc);
                    removed++;
                }
            }

            return removed;
        }

        /// <summary>Keys to try adding: in the snapshot, not handled by the previous snapshot, not owned, not tombstoned.</summary>
        /// <param name="source">Linked source.</param>
        /// <param name="snapshotKeys">The fetched keys in source order.</param>
        /// <returns>Keys, in source order, without duplicates.</returns>
        public static List<string> KeysToAdd(ListSource source, IReadOnlyList<string> snapshotKeys)
        {
            var handled = new HashSet<string>(source.LastSnapshotKeys, StringComparer.Ordinal);
            var seen = new HashSet<string>(StringComparer.Ordinal);
            return snapshotKeys.Where(key => seen.Add(key) && !handled.Contains(key) && !source.Owned.ContainsKey(key) && !source.UserRemovedKeys.ContainsKey(key)).ToList();
        }

        /// <summary>Plans removeDropped: owned entries whose key left a COMPLETE snapshot.</summary>
        /// <param name="doc">Document.</param>
        /// <param name="snapshotKeys">The complete snapshot.</param>
        /// <param name="realOccurrences">Real entries: item id ("N") → occurrences.</param>
        /// <returns>The plan (nothing when removeDropped is off).</returns>
        public static DropPlan PlanDrops(ListDoc doc, IReadOnlyCollection<string> snapshotKeys, IReadOnlyDictionary<string, int> realOccurrences)
        {
            var plan = new DropPlan();
            var source = doc.Source;
            if (source == null)
            {
                return plan;
            }

            var current = new HashSet<string>(snapshotKeys, StringComparer.Ordinal);
            // Entries that only were "present" (added by hand) and left the source: kept, and reported.
            plan.Kept += source.LastSnapshotKeys.Count(k => !current.Contains(k) && !source.Owned.ContainsKey(k));
            if (!source.RemoveDropped)
            {
                plan.Kept += source.Owned.Keys.Count(k => !current.Contains(k));
                return plan;
            }

            var placeholders = new HashSet<string>(doc.Items.Select(p => p.Id), StringComparer.Ordinal);
            // What keys still in the source own stays, whichever other key also owns it.
            var heldPlaceholders = new HashSet<string>(StringComparer.Ordinal);
            var heldItems = new HashSet<string>(StringComparer.Ordinal);
            foreach (var owned in source.Owned.Where(o => current.Contains(o.Key)).Select(o => o.Value))
            {
                if (owned.PhId != null)
                {
                    heldPlaceholders.Add(owned.PhId);
                }

                heldItems.UnionWith(owned.ItemIds);
            }

            var plannedPlaceholders = new HashSet<string>(StringComparer.Ordinal);
            var plannedItems = new HashSet<Guid>();
            foreach (var (key, owned) in source.Owned)
            {
                if (current.Contains(key))
                {
                    continue;
                }

                if (owned.PhId != null && heldPlaceholders.Contains(owned.PhId))
                {
                    plan.Released.Add((key, owned.PhId, null));
                }
                else if (owned.PhId != null && placeholders.Contains(owned.PhId) && plannedPlaceholders.Add(owned.PhId))
                {
                    plan.PlaceholderIds.Add(owned.PhId);
                }

                foreach (var itemId in owned.ItemIds)
                {
                    if (heldItems.Contains(itemId))
                    {
                        plan.Released.Add((key, null, itemId));
                    }
                    else if (realOccurrences.TryGetValue(itemId, out var count) && count == 1 && Guid.TryParse(itemId, out var guid))
                    {
                        if (plannedItems.Add(guid))
                        {
                            plan.ItemIds.Add(guid);
                        }
                    }
                    else if (count > 1)
                    {
                        plan.Kept++;
                    }
                }
            }

            return plan;
        }

        /// <summary>Applies a drop plan to the document (the caller removes the real items from Jellyfin).</summary>
        /// <param name="doc">Document.</param>
        /// <param name="plan">Plan.</param>
        /// <param name="removedItemIds">Real items Jellyfin actually removed ("N").</param>
        /// <returns>Removed entry count.</returns>
        public static int ApplyDrops(ListDoc doc, DropPlan plan, IReadOnlyCollection<string> removedItemIds)
        {
            var source = doc.Source;
            if (source == null)
            {
                return 0;
            }

            var dropIds = new HashSet<string>(plan.PlaceholderIds, StringComparer.Ordinal);
            var removed = doc.Items.RemoveAll(p => dropIds.Contains(p.Id));
            var removedItems = new HashSet<string>(removedItemIds, StringComparer.Ordinal);
            removed += removedItems.Count;
            foreach (var (key, placeholderId, itemId) in plan.Released)
            {
                if (source.Owned.TryGetValue(key, out var leaving))
                {
                    if (placeholderId != null && leaving.PhId == placeholderId)
                    {
                        leaving.PhId = null;
                    }

                    if (itemId != null)
                    {
                        leaving.ItemIds.Remove(itemId);
                    }
                }
            }

            foreach (var (key, owned) in source.Owned.ToList())
            {
                if (owned.PhId != null && dropIds.Contains(owned.PhId))
                {
                    owned.PhId = null;
                }

                owned.ItemIds.RemoveAll(removedItems.Contains);
                if (owned.PhId == null && owned.ItemIds.Count == 0)
                {
                    // Gone because it left the source: no tombstone, so it comes back if the source re-adds it.
                    source.Owned.Remove(key);
                }
            }

            return removed;
        }

        /// <summary>Drops tombstones older than 90 days, then the oldest beyond the cap.</summary>
        /// <param name="source">Linked source.</param>
        /// <param name="nowUtc">Now.</param>
        public static void Prune(ListSource source, DateTime nowUtc)
        {
            var cutoff = nowUtc - UserRemovedRetention;
            var entries = source.UserRemovedKeys
                .Select(e => (e.Key, When: DateTime.TryParse(e.Value, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out var when) ? when.ToUniversalTime() : DateTime.MinValue))
                .ToList();
            foreach (var (key, when) in entries.Where(e => e.When < cutoff))
            {
                source.UserRemovedKeys.Remove(key);
            }

            var excess = source.UserRemovedKeys.Count - MaxUserRemovedKeys;
            if (excess > 0)
            {
                foreach (var (key, _) in entries.Where(e => e.When >= cutoff).OrderBy(e => e.When).Take(excess))
                {
                    source.UserRemovedKeys.Remove(key);
                }
            }
        }

        /// <summary>Counts real entries of a list by item id ("N").</summary>
        /// <param name="raw">Raw entries.</param>
        /// <returns>Occurrences per item.</returns>
        public static Dictionary<string, int> Occurrences(IEnumerable<RawEntry> raw)
        {
            var counts = new Dictionary<string, int>(StringComparer.Ordinal);
            foreach (var entry in raw.Where(r => r.Resolved && r.ItemId.HasValue))
            {
                var id = entry.ItemId!.Value.ToString("N", CultureInfo.InvariantCulture);
                counts[id] = counts.TryGetValue(id, out var n) ? n + 1 : 1;
            }

            return counts;
        }
    }
}
