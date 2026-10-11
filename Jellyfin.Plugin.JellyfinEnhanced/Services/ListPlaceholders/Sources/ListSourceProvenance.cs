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

        /// <summary>
        /// Entries that left the source but stay: not added by sync, a sync-owned item that occurs more than once, or one
        /// held back while its playlist has an unresolved entry (<see cref="ListSourceProvenance.RecheckItemDrops"/>).
        /// </summary>
        public int Kept { get; set; }

        /// <summary>
        /// Episodes to take out of a run placeholder (<c>episodes</c> kind) whose other episodes are still in the source:
        /// one placeholder stands for many per-episode keys (grouped sources), and only this episode left.
        /// </summary>
        public List<(string PhId, int Season, int Episode)> Trims { get; } = new();

        /// <summary>
        /// Keys that left the source but share their placeholder or items with keys that are still in it: their ownership
        /// is released (the shared entry stays for the other keys).
        /// </summary>
        public List<string> Released { get; } = new();

        /// <summary>Real items that keys still in the source own (a released key gives them up; it keeps the rest).</summary>
        public HashSet<string> SharedItemIds { get; } = new(StringComparer.Ordinal);

        /// <summary>
        /// Season placeholders of a playlist that, after some of their keys left, only episode keys still stand for: they
        /// become <c>episodes</c> placeholders over those episodes, so swap-in no longer brings back an episode that left
        /// the source (a season placeholder fills with any episode of its season).
        /// </summary>
        public List<SeasonNarrowing> Narrowings { get; } = new();

        /// <summary>Whether anything is removed.</summary>
        public bool Any => PlaceholderIds.Count > 0 || ItemIds.Count > 0 || Trims.Count > 0 || Narrowings.Count > 0;
    }

    /// <summary>A season placeholder narrowed to the episodes whose keys are still in the source (see <see cref="DropPlan.Narrowings"/>).</summary>
    /// <param name="PhId">The season placeholder.</param>
    /// <param name="Episodes">The episodes that stay, in episode order (title and air date from the source when known).</param>
    /// <param name="Keys">Episode (season, episode) → the staying keys that stand for it.</param>
    /// <param name="Left">How many of its keys left the source.</param>
    public sealed record SeasonNarrowing(string PhId, List<PlaceholderEpisode> Episodes, Dictionary<(int Season, int Episode), List<string>> Keys, int Left);

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
    /// <item>Grouped sources (chronolists) key every episode on its own, and all keys of a run own the run's one
    /// placeholder: an entry is removed only when every key that owns it left the source; a single episode that left
    /// is taken out of its run placeholder instead.</item>
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
        /// A new key that a sync-owned placeholder already stands for (F1 coverage, e.g. a new episode of a season that is
        /// in the list as a season placeholder): the key shares that placeholder and the real items it was already filled
        /// with for the key's scope (an episode key: that episode; a season key: that season), as far as the placeholder's
        /// other owners own them. So the entry stays while either key is in the source, and goes once both left.
        /// </summary>
        /// <param name="source">Linked source.</param>
        /// <param name="key">The covered key.</param>
        /// <param name="covering">The sync-owned placeholder that covers it (<see cref="Covering(ListDoc, string)"/>).</param>
        public static void AttachCovered(ListSource source, string key, Placeholder covering)
        {
            var owners = source.Owned.Where(o => !string.Equals(o.Key, key, StringComparison.Ordinal) && o.Value.PhId == covering.Id).Select(o => o.Value).ToList();
            RecordAdded(source, key, covering.Id, null);
            var parts = key.Split('|');
            int? season = parts.Length == 4 && int.TryParse(parts[2], NumberStyles.None, CultureInfo.InvariantCulture, out var s) ? s : null;
            int? episode = parts.Length == 4 && int.TryParse(parts[3], NumberStyles.None, CultureInfo.InvariantCulture, out var e) ? e : null;
            foreach (var fill in covering.Filled.Where(f => (season == null || f.S == season) && (episode == null || f.E == episode)))
            {
                if (Guid.TryParse(fill.ItemId, out var id))
                {
                    var itemId = id.ToString("N", CultureInfo.InvariantCulture);
                    if (owners.Any(o => o.ItemIds.Contains(itemId, StringComparer.Ordinal)))
                    {
                        RecordAdded(source, key, null, itemId);
                    }
                }
            }
        }

        /// <summary>
        /// Finds sync-owned entries an editor removed since the last sync (the placeholder is gone and none of the owned
        /// items is in the list any more) and tombstones them. Missing items of a partly present key are forgotten. An item
        /// whose entry is in the list but doesn't resolve right now (its file is offline) is still there: pass every linked
        /// entry (<see cref="Linked"/>), not only the resolved ones.
        /// </summary>
        /// <param name="doc">Document.</param>
        /// <param name="realOccurrences">Real entries of the list, resolved or not: item id ("N") → occurrences.</param>
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
        /// <param name="items">The fetched entries by key, for the titles and air dates of a narrowed season's episodes (optional).</param>
        /// <returns>The plan (nothing when removeDropped is off).</returns>
        public static DropPlan PlanDrops(ListDoc doc, IReadOnlyCollection<string> snapshotKeys, IReadOnlyDictionary<string, int> realOccurrences, IReadOnlyDictionary<string, SourceItem>? items = null)
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

            // What keys that are still in the source own: never removed for a key that left (grouped runs share them).
            var stayingPlaceholders = new HashSet<string>(StringComparer.Ordinal);
            var stayingItems = new HashSet<string>(StringComparer.Ordinal);
            foreach (var (key, owned) in source.Owned.Where(e => current.Contains(e.Key)))
            {
                if (owned.PhId != null)
                {
                    stayingPlaceholders.Add(owned.PhId);
                }

                stayingItems.UnionWith(owned.ItemIds);
            }

            plan.SharedItemIds.UnionWith(stayingItems);
            var placeholders = doc.Items.ToDictionary(p => p.Id, StringComparer.Ordinal);
            var dropPlaceholders = new HashSet<string>(StringComparer.Ordinal);
            var dropItems = new HashSet<Guid>();
            // Episodes planned out of each placeholder: distinct episodes, since two departing keys can be the same
            // episode under different ids (tv|… and tvdb|…).
            var trimmed = new Dictionary<string, HashSet<(int, int)>>(StringComparer.Ordinal);
            var leftShared = new Dictionary<string, int>(StringComparer.Ordinal);
            foreach (var (key, owned) in source.Owned)
            {
                if (current.Contains(key))
                {
                    continue;
                }

                var shared = false;
                if (owned.PhId != null && placeholders.TryGetValue(owned.PhId, out var placeholder))
                {
                    if (stayingPlaceholders.Contains(owned.PhId))
                    {
                        shared = true;
                        leftShared[owned.PhId] = leftShared.GetValueOrDefault(owned.PhId) + 1;
                        if (!trimmed.TryGetValue(owned.PhId, out var done))
                        {
                            done = new HashSet<(int, int)>();
                            trimmed[owned.PhId] = done;
                        }

                        // Only an episode no staying key still lists (a series or season key of the show, or the same
                        // episode under another id) leaves the run; else the key is just released.
                        if (placeholder.Kind == PlaceholderKinds.Episodes && SourceKeys.EpisodeOf(key) is { } episode
                            && !done.Contains((episode.Season, episode.Episode))
                            && placeholder.Episodes.Any(e => e.S == episode.Season && e.E == episode.Episode) && placeholder.Episodes.Count - done.Count > 1
                            && !CoveredByStayingKey(source, current, owned.PhId, episode.Season, episode.Episode))
                        {
                            plan.Trims.Add((owned.PhId, episode.Season, episode.Episode));
                            done.Add((episode.Season, episode.Episode));
                        }
                    }
                    else if (dropPlaceholders.Add(owned.PhId))
                    {
                        plan.PlaceholderIds.Add(owned.PhId);
                    }
                }

                foreach (var itemId in owned.ItemIds)
                {
                    if (stayingItems.Contains(itemId))
                    {
                        shared = true;
                    }
                    else if (realOccurrences.TryGetValue(itemId, out var count) && count == 1 && Guid.TryParse(itemId, out var guid))
                    {
                        if (dropItems.Add(guid))
                        {
                            plan.ItemIds.Add(guid);
                        }
                    }
                    else if (count > 1)
                    {
                        plan.Kept++;
                    }
                }

                if (shared)
                {
                    plan.Released.Add(key);
                }
            }

            if (doc.ListKind == ListKinds.Playlist)
            {
                // A split season adds placeholders: never past the cap (the save would fail after Jellyfin was changed).
                // Without room the season stays whole and what left it is kept (reported).
                var room = ListPlaceholderStore.MaxPlaceholders - doc.Items.Count + plan.PlaceholderIds.Count;
                foreach (var (phId, left) in leftShared)
                {
                    if (Narrow(source, placeholders[phId], current, left, items) is { } narrowing)
                    {
                        var extra = (narrowing.Episodes.Count - 1) / PlaceholderRules.MaxEpisodes;
                        if (extra > room)
                        {
                            plan.Kept += left;
                            continue;
                        }

                        room -= extra;
                        plan.Narrowings.Add(narrowing);
                    }
                }
            }

            return plan;
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

        // Whether a key still in the source that owns the placeholder covers this episode: a series key (no season), a key
        // of its season (no episode) or a key of the same episode (whatever its id: tv, tvdb or imdb).
        private static bool CoveredByStayingKey(ListSource source, HashSet<string> current, string phId, int season, int episode)
        {
            foreach (var (key, owned) in source.Owned)
            {
                if (owned.PhId != phId || !current.Contains(key))
                {
                    continue;
                }

                var parts = key.Split('|');
                if (parts.Length != 4 || parts[2].Length == 0)
                {
                    return true; // a series key (or one of another shape): the whole show is still listed
                }

                if (!int.TryParse(parts[2], NumberStyles.None, CultureInfo.InvariantCulture, out var keySeason) || keySeason != season)
                {
                    continue;
                }

                if (parts[3].Length == 0
                    || (int.TryParse(parts[3], NumberStyles.None, CultureInfo.InvariantCulture, out var keyEpisode) && keyEpisode == episode))
                {
                    return true;
                }
            }

            return false;
        }

        // A season placeholder that only episode keys of its season still own: the episodes those keys stand for. Null when
        // a season or series key (or a key of another shape) still owns it — then the whole season is still listed. Not for
        // collections: there a season is one Season item that stands for every episode of it anyway.
        private static SeasonNarrowing? Narrow(ListSource source, Placeholder placeholder, HashSet<string> current, int left, IReadOnlyDictionary<string, SourceItem>? items)
        {
            if (placeholder.Kind != PlaceholderKinds.Season || placeholder.SeasonNumber is not { } season)
            {
                return null;
            }

            var keys = new SortedDictionary<(int Season, int Episode), List<string>>();
            foreach (var (key, owned) in source.Owned)
            {
                if (owned.PhId != placeholder.Id || !current.Contains(key))
                {
                    continue;
                }

                if (SourceKeys.EpisodeOf(key) is not { } coord || coord.Season != season)
                {
                    return null;
                }

                if (!keys.TryGetValue(coord, out var list))
                {
                    keys[coord] = list = new List<string>();
                }

                list.Add(key);
            }

            if (keys.Count == 0)
            {
                return null;
            }

            var expected = placeholder.Expected.Where(e => e.S == season).GroupBy(e => e.E).ToDictionary(g => g.Key, g => g.First());
            var episodes = new List<PlaceholderEpisode>();
            foreach (var (coord, coordKeys) in keys)
            {
                var details = items != null && items.TryGetValue(coordKeys[0], out var item) ? item.Details : null;
                var known = expected.GetValueOrDefault(coord.Episode);
                var airDate = details?.Date is { } date && DateTime.TryParseExact(date, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out _) ? date : known?.AirDate;
                episodes.Add(new PlaceholderEpisode { S = coord.Season, E = coord.Episode, Title = details?.EpisodeTitle ?? known?.Title, AirDate = airDate });
            }

            return new SeasonNarrowing(placeholder.Id, episodes, new Dictionary<(int Season, int Episode), List<string>>(keys), left);
        }

        /// <summary>Applies a drop plan to the document (the caller removes the real items from Jellyfin).</summary>
        /// <param name="doc">Document.</param>
        /// <param name="plan">Plan.</param>
        /// <param name="removedItemIds">Real items Jellyfin actually removed ("N").</param>
        /// <returns>Removed entry count (an episode taken out of a run placeholder counts as one).</returns>
        public static int ApplyDrops(ListDoc doc, DropPlan plan, IReadOnlyCollection<string> removedItemIds)
        {
            var source = doc.Source;
            if (source == null)
            {
                return 0;
            }

            var dropIds = new HashSet<string>(plan.PlaceholderIds, StringComparer.Ordinal);
            var removed = doc.Items.RemoveAll(p => dropIds.Contains(p.Id));
            foreach (var (phId, season, episode) in plan.Trims)
            {
                var placeholder = doc.Items.FirstOrDefault(p => p.Id == phId);
                if (placeholder == null || placeholder.Episodes.Count < 2 || placeholder.Episodes.RemoveAll(e => e.S == season && e.E == episode) == 0)
                {
                    continue;
                }

                placeholder.Filled.RemoveAll(f => f.S == season && f.E == episode);
                placeholder.ReleaseDate = placeholder.Episodes[0].AirDate ?? placeholder.ReleaseDate;
                removed++;
            }

            foreach (var narrowing in plan.Narrowings)
            {
                removed += ApplyNarrowing(doc, source, narrowing);
            }

            var removedItems = new HashSet<string>(removedItemIds, StringComparer.Ordinal);
            removed += removedItems.Count;
            var released = new HashSet<string>(plan.Released, StringComparer.Ordinal);
            foreach (var (key, owned) in source.Owned.ToList())
            {
                if (owned.PhId != null && dropIds.Contains(owned.PhId))
                {
                    owned.PhId = null;
                }

                owned.ItemIds.RemoveAll(removedItems.Contains);
                if (released.Contains(key))
                {
                    // It lets go of what it shares with keys still in the source, and keeps its own real items that
                    // Jellyfin didn't remove (a failed removal is retried by the next sync).
                    owned.PhId = null;
                    owned.ItemIds.RemoveAll(plan.SharedItemIds.Contains);
                }

                if (owned.PhId == null && owned.ItemIds.Count == 0)
                {
                    // Gone because it left the source: no tombstone, so it comes back if the source re-adds it.
                    source.Owned.Remove(key);
                }
            }

            return removed;
        }

        // Turns a season placeholder into episodes placeholders over the episodes that stay (split at the per-placeholder
        // limit; the extra ones go right after it in the order and their keys move to them), carrying their fills over.
        private static int ApplyNarrowing(ListDoc doc, ListSource source, SeasonNarrowing narrowing)
        {
            var placeholder = doc.Items.FirstOrDefault(p => p.Id == narrowing.PhId);
            if (placeholder == null || placeholder.Kind != PlaceholderKinds.Season || narrowing.Episodes.Count == 0)
            {
                return 0;
            }

            var filled = placeholder.Filled.ToList();
            var token = ListPlaceholderOrder.PlaceholderToken(placeholder.Id);
            var at = doc.Order.IndexOf(token);
            var target = placeholder;
            for (var start = 0; start < narrowing.Episodes.Count; start += PlaceholderRules.MaxEpisodes)
            {
                var chunk = narrowing.Episodes.Skip(start).Take(PlaceholderRules.MaxEpisodes).ToList();
                if (start > 0)
                {
                    target = Copy(placeholder);
                    doc.Items.Insert(doc.Items.IndexOf(placeholder) + (start / PlaceholderRules.MaxEpisodes), target);
                    if (at >= 0)
                    {
                        doc.Order.Insert(at + (start / PlaceholderRules.MaxEpisodes), ListPlaceholderOrder.PlaceholderToken(target.Id));
                    }
                }

                var coords = chunk.Select(e => (e.S, e.E)).ToHashSet();
                target.Kind = PlaceholderKinds.Episodes;
                target.Episodes = chunk;
                target.EpisodeTotal = null;
                target.Expected = new List<PlaceholderEpisode>();
                target.InProduction = null;
                target.Filled = filled.Where(f => coords.Contains((f.S, f.E))).ToList();
                target.ReleaseDate = chunk[0].AirDate ?? placeholder.ReleaseDate;
                var chunkKeys = chunk.SelectMany(e => narrowing.Keys.GetValueOrDefault((e.S, e.E)) ?? new List<string>()).ToList();
                target.SourceKey = chunkKeys.FirstOrDefault() ?? target.SourceKey;
                foreach (var key in chunkKeys)
                {
                    if (source.Owned.TryGetValue(key, out var owned) && owned.PhId == placeholder.Id)
                    {
                        owned.PhId = target.Id;
                    }
                }
            }

            return narrowing.Left;
        }

        /// <summary>
        /// Ordered sync, playlists (under the list lock, before the new entries are placed): a new source entry whose
        /// nearest preceding and following source entries in the list are two not-yet-filled episodes of the SAME run
        /// placeholder (an <c>episodes</c> placeholder, or a whole-season one that only episode keys own) falls inside that
        /// run. The run is split at that boundary into two <c>episodes</c> placeholders (fills, keys and the source key
        /// follow each episode; the second half's token goes right after the first's in <paramref name="order"/>), so the
        /// entry can be anchored after the first half instead of after the whole run. A filled episode of the second half
        /// that sits before the run's token (swap-in puts fills there) moves the first half's token to just before it.
        /// Nothing is split when the list has no room for another placeholder, or when a filled episode of the first half
        /// would come after the first half's token: the entry then goes after the whole run, as before.
        /// </summary>
        /// <param name="doc">Fresh document.</param>
        /// <param name="order">The playlist's canonical order (the new tokens are inserted into it).</param>
        /// <param name="sourceKeys">Every key of the fetched source, in source order.</param>
        /// <param name="newPositions">Positions in <paramref name="sourceKeys"/> of the keys being added now.</param>
        /// <returns>Whether a placeholder was split.</returns>
        public static bool SplitRunsAround(ListDoc doc, List<string> order, IReadOnlyList<string> sourceKeys, IEnumerable<int> newPositions)
        {
            var source = doc.Source;
            if (source == null)
            {
                return false;
            }

            var fresh = newPositions.Where(p => p >= 0 && p < sourceKeys.Count).ToHashSet();
            var split = false;
            foreach (var position in fresh.OrderBy(p => p))
            {
                string? before = null;
                for (var i = position - 1; i >= 0 && before == null; i--)
                {
                    if (!fresh.Contains(i) && source.Owned.ContainsKey(sourceKeys[i]))
                    {
                        before = sourceKeys[i];
                    }
                }

                string? after = null;
                for (var i = position + 1; i < sourceKeys.Count && after == null; i++)
                {
                    if (!fresh.Contains(i) && source.Owned.ContainsKey(sourceKeys[i]))
                    {
                        after = sourceKeys[i];
                    }
                }

                if (before == null || after == null)
                {
                    continue;
                }

                var previous = source.Owned[before];
                var next = source.Owned[after];
                // A filled preceding episode is in the list as its own real item: the entry already goes right after it.
                if (previous.PhId == null || previous.PhId != next.PhId || previous.ItemIds.Count > 0
                    || SourceKeys.EpisodeOf(before) is not { } from || SourceKeys.EpisodeOf(after) is not { } to)
                {
                    continue;
                }

                var placeholder = doc.Items.FirstOrDefault(p => p.Id == previous.PhId);
                var token = placeholder == null ? null : ListPlaceholderOrder.PlaceholderToken(placeholder.Id);
                var at = token == null ? -1 : order.IndexOf(token);
                if (placeholder == null || at < 0 || doc.Items.Count >= ListPlaceholderStore.MaxPlaceholders)
                {
                    continue;
                }

                var episodes = RunEpisodes(source, placeholder);
                var cut = episodes?.FindIndex(e => e.S == from.Season && e.E == from.Episode) ?? -1;
                var resume = episodes?.FindIndex(e => e.S == to.Season && e.E == to.Episode) ?? -1;
                if (episodes == null || cut < 0 || resume <= cut)
                {
                    continue;
                }

                // Swap-in puts a run's arrived episodes before its token, so a filled episode of the second half can sit
                // ahead of the token the first half keeps; later arrivals of the second half go before that fill. The
                // first half's token then moves to just before the earliest such fill (canonical order only: no real
                // item moves), so the new entry lands between the halves' real episodes too. When a filled episode of
                // the first half would end up after that spot, the halves can't be ordered without moving real items:
                // no split (the entry goes after the whole run, as before).
                var firstCoords = episodes.Take(cut + 1).Select(e => (e.S, e.E)).ToHashSet();
                var firstFills = placeholder.Filled.Where(f => firstCoords.Contains((f.S, f.E))).Select(f => f.ItemId).ToHashSet(StringComparer.OrdinalIgnoreCase);
                var secondCoords = episodes.Skip(cut + 1).Select(e => (e.S, e.E)).ToHashSet();
                var secondFills = placeholder.Filled.Where(f => secondCoords.Contains((f.S, f.E))).Select(f => f.ItemId).ToHashSet(StringComparer.OrdinalIgnoreCase);
                var firstAt = at;
                var lastFirstFill = -1;
                for (var i = 0; i < order.Count; i++)
                {
                    if (!ListPlaceholderOrder.TryParseReal(order[i], out var itemId, out _))
                    {
                        continue;
                    }

                    var n = itemId.ToString("N", CultureInfo.InvariantCulture);
                    if (i < at && secondFills.Contains(n))
                    {
                        firstAt = Math.Min(firstAt, i);
                    }

                    if (firstFills.Contains(n))
                    {
                        lastFirstFill = i;
                    }
                }

                if (lastFirstFill > firstAt)
                {
                    continue;
                }

                var filled = placeholder.Filled.ToList();
                var releaseDate = placeholder.ReleaseDate;
                var second = Copy(placeholder);
                Reshape(placeholder, episodes.Take(cut + 1).ToList());
                Reshape(second, episodes.Skip(cut + 1).ToList());
                doc.Items.Insert(doc.Items.IndexOf(placeholder) + 1, second);
                if (firstAt < at)
                {
                    order.RemoveAt(at);
                    order.Insert(firstAt, token!);
                }

                // The second half keeps the run's old spot (after its filled episodes).
                order.Insert(at + 1, ListPlaceholderOrder.PlaceholderToken(second.Id));
                split = true;

                void Reshape(Placeholder target, List<PlaceholderEpisode> chunk)
                {
                    var coords = chunk.Select(e => (e.S, e.E)).ToHashSet();
                    target.Kind = PlaceholderKinds.Episodes;
                    target.Episodes = chunk;
                    target.EpisodeTotal = null;
                    target.Expected = new List<PlaceholderEpisode>();
                    target.InProduction = null;
                    target.Filled = filled.Where(f => coords.Contains((f.S, f.E))).ToList();
                    target.ReleaseDate = chunk[0].AirDate ?? releaseDate;
                    string? firstKey = null;
                    foreach (var (key, owned) in source.Owned.Where(o => o.Value.PhId == placeholder.Id || o.Value.PhId == target.Id).ToList())
                    {
                        if (SourceKeys.EpisodeOf(key) is { } coord && coords.Contains((coord.Season, coord.Episode)))
                        {
                            owned.PhId = target.Id;
                            if (coord.Season == chunk[0].S && coord.Episode == chunk[0].E)
                            {
                                firstKey ??= key;
                            }
                        }
                    }

                    target.SourceKey = firstKey ?? target.SourceKey;
                }
            }

            return split;
        }

        // The episodes of a run placeholder in order: an episodes placeholder's own list; a whole-season placeholder that
        // only episode keys of its season own, those episodes (else null: the season itself is one source entry).
        private static List<PlaceholderEpisode>? RunEpisodes(ListSource source, Placeholder placeholder)
        {
            if (placeholder.Kind == PlaceholderKinds.Episodes)
            {
                return placeholder.Episodes.Count >= 2 ? placeholder.Episodes.ToList() : null;
            }

            if (placeholder.Kind != PlaceholderKinds.Season || placeholder.SeasonNumber is not { } season)
            {
                return null;
            }

            var coords = new SortedSet<(int Season, int Episode)>();
            foreach (var (key, owned) in source.Owned)
            {
                if (owned.PhId != placeholder.Id)
                {
                    continue;
                }

                if (SourceKeys.EpisodeOf(key) is not { } coord || coord.Season != season)
                {
                    return null;
                }

                coords.Add(coord);
            }

            var expected = placeholder.Expected.Where(e => e.S == season).GroupBy(e => e.E).ToDictionary(g => g.Key, g => g.First());
            return coords.Count < 2 ? null : coords.Select(c => new PlaceholderEpisode
            {
                S = c.Season,
                E = c.Episode,
                Title = expected.GetValueOrDefault(c.Episode)?.Title,
                AirDate = expected.GetValueOrDefault(c.Episode)?.AirDate,
            }).ToList();
        }

        private static Placeholder Copy(Placeholder p) => new()
        {
            Id = Guid.NewGuid().ToString("N", CultureInfo.InvariantCulture),
            Kind = p.Kind,
            MediaType = p.MediaType,
            TmdbId = p.TmdbId,
            TvdbId = p.TvdbId,
            ImdbId = p.ImdbId,
            Title = p.Title,
            Year = p.Year,
            ReleaseDate = p.ReleaseDate,
            PosterPath = p.PosterPath,
            PosterUnverified = p.PosterUnverified,
            Overview = p.Overview,
            SeasonNumber = p.SeasonNumber,
            Note = p.Note,
            AddedBy = p.AddedBy,
            AddedAt = p.AddedAt,
            SourceKey = p.SourceKey,
        };

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

        /// <summary>
        /// A placeholder already in the list that stands for a source key (F1 "an equivalent placeholder already
        /// existed"): the same movie / series, or for a season or episode key a placeholder of that season (or the whole
        /// series), or an <c>episodes</c> placeholder that lists the episode. Adding the key again would duplicate it.
        /// </summary>
        /// <param name="doc">Document.</param>
        /// <param name="key">Source key.</param>
        /// <returns>The covering placeholder, or null.</returns>
        public static Placeholder? Covering(ListDoc doc, string key) => Covering(doc.Items, key);

        /// <summary>The covering placeholder among <paramref name="placeholders"/> (see <see cref="Covering(ListDoc, string)"/>).</summary>
        /// <param name="placeholders">Candidates (e.g. the placeholders of one TMDB id).</param>
        /// <param name="key">Source key.</param>
        /// <returns>The covering placeholder, or null.</returns>
        public static Placeholder? Covering(IEnumerable<Placeholder> placeholders, string key)
        {
            var parts = key.Split('|');
            if (parts.Length != 4 || parts[0] is not ("movie" or "tv") || !int.TryParse(parts[1], NumberStyles.None, CultureInfo.InvariantCulture, out var tmdb))
            {
                return null;
            }

            int? season = int.TryParse(parts[2], NumberStyles.None, CultureInfo.InvariantCulture, out var s) ? s : null;
            int? episode = int.TryParse(parts[3], NumberStyles.None, CultureInfo.InvariantCulture, out var e) ? e : null;
            foreach (var placeholder in placeholders)
            {
                if (placeholder.TmdbId != tmdb || placeholder.MediaType != (parts[0] == "movie" ? "movie" : "tv") || placeholder.Kind == PlaceholderKinds.Custom)
                {
                    continue;
                }

                var covers = placeholder.Kind switch
                {
                    PlaceholderKinds.Movie => true,
                    PlaceholderKinds.Series => true,
                    PlaceholderKinds.Season => season.HasValue && placeholder.SeasonNumber == season,
                    PlaceholderKinds.Episodes => season.HasValue && episode.HasValue && placeholder.Episodes.Any(x => x.S == season && x.E == episode),
                    _ => false,
                };
                if (covers)
                {
                    return placeholder;
                }
            }

            return null;
        }

        /// <summary>Counts every entry of a list that names an item, resolved or not, by item id ("N").</summary>
        /// <param name="raw">Raw entries.</param>
        /// <returns>Occurrences per item.</returns>
        public static Dictionary<string, int> Linked(IEnumerable<RawEntry> raw) => Occurrences(raw.Where(r => r.ItemId.HasValue).Select(r => r with { Resolved = true }));

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

        /// <summary>
        /// Re-checks a drop plan's real items against the list as Jellyfin has it right before they are removed (native
        /// edits don't take JE's list lock). Jellyfin removes every copy of an item, so an item that no longer occurs
        /// exactly once is kept. And Jellyfin rebuilds a playlist from the entries it can resolve when it removes from it,
        /// so while a playlist has an unresolved entry (e.g. its file is on a drive that isn't mounted) nothing is removed:
        /// that entry would be lost. Kept items count in <see cref="DropPlan.Kept"/> and stay owned (a later sync retries);
        /// an item that is already gone is left out silently.
        /// </summary>
        /// <param name="plan">The plan; its <see cref="DropPlan.ItemIds"/> shrink to what is safe to remove.</param>
        /// <param name="raw">The list's raw entries, read just now.</param>
        /// <param name="isPlaylist">Whether the list is a playlist (a collection removes only the given ids).</param>
        public static void RecheckItemDrops(DropPlan plan, IReadOnlyList<RawEntry> raw, bool isPlaylist)
        {
            if (plan.ItemIds.Count == 0)
            {
                return;
            }

            var occurrences = Occurrences(raw);
            var unresolved = isPlaylist && raw.Any(r => !r.Resolved);
            plan.ItemIds.RemoveAll(id =>
            {
                var count = occurrences.GetValueOrDefault(id.ToString("N", CultureInfo.InvariantCulture));
                if (count == 1 && !unresolved)
                {
                    return false;
                }

                if (count > 0)
                {
                    plan.Kept++;
                }

                return true;
            });
        }
    }
}
