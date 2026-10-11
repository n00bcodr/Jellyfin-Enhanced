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
        /// key and to the owning keys of a wider scope (season, series), never to another episode's key; any other item (a
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
                    // Episode keys only take their own episode; scope keys take every episode of their placeholder.
                    var matching = keys.Where(k => SourceKeys.EpisodeOf(k) is not { } c || episodes.Contains(c)).ToList();
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
            var trimmed = new Dictionary<string, int>(StringComparer.Ordinal);
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
                        var done = trimmed.GetValueOrDefault(owned.PhId);
                        if (placeholder.Kind == PlaceholderKinds.Episodes && SourceKeys.EpisodeOf(key) is { } episode
                            && placeholder.Episodes.Any(e => e.S == episode.Season && e.E == episode.Episode) && placeholder.Episodes.Count - done > 1)
                        {
                            plan.Trims.Add((owned.PhId, episode.Season, episode.Episode));
                            trimmed[owned.PhId] = done + 1;
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
