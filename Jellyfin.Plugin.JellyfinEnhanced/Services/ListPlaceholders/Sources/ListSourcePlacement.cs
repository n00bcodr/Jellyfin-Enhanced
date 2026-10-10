using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders.Sources
{
    /// <summary>
    /// Ordered sync insertion (pure): a new source entry goes right after the nearest PRECEDING source entry that is in
    /// the playlist, else right before the nearest following one, else at the end. Ordered sources such as chronological
    /// watch orders gain entries in the middle (a newly announced episode between two crossovers), so appending would
    /// put them out of order. An entry is "in the list" through what its key owns (the sync-added placeholder, or the
    /// real items it became after swap-in) or, failing that, through an equivalent placeholder or a real item of the same
    /// title that is in the list without being owned (it was there before the import, or an editor added it).
    /// </summary>
    public static class ListSourcePlacement
    {
        /// <summary>Anchors for new entries.</summary>
        /// <param name="doc">The fresh document (under the list lock).</param>
        /// <param name="order">The playlist's canonical order.</param>
        /// <param name="sourceKeys">Every key of the fetched source, in source order.</param>
        /// <param name="entryPositions">Entry index → position of the entry's (first) key in <paramref name="sourceKeys"/>.</param>
        /// <param name="itemKeys">The source keys a library item stands for (<c>movie|id||</c>, <c>tv|show|s|e</c>; a season
        /// <c>tv|show|s|</c>, a series <c>tv|show||</c>), to find entries that are in the list as real items nobody owns.
        /// Asked only for the list's real items, and only once an entry isn't found through ownership.</param>
        /// <returns>Entry index → anchor (entries with no neighbour in the list are left out: they go to the end).</returns>
        public static Dictionary<int, EntryAnchor> Anchors(ListDoc doc, IReadOnlyList<string> order, IReadOnlyList<string> sourceKeys, IReadOnlyDictionary<int, int> entryPositions, Func<Guid, IReadOnlyList<string>>? itemKeys = null)
        {
            var anchors = new Dictionary<int, EntryAnchor>();
            if (entryPositions.Count == 0 || order.Count == 0)
            {
                return anchors;
            }

            var tokenIndex = new Dictionary<string, int>(StringComparer.Ordinal);
            var itemIndexes = new Dictionary<string, List<int>>(StringComparer.Ordinal);
            for (var i = 0; i < order.Count; i++)
            {
                tokenIndex.TryAdd(order[i], i);
                if (ListPlaceholderOrder.TryParseReal(order[i], out var itemId, out _))
                {
                    var n = itemId.ToString("N", CultureInfo.InvariantCulture);
                    if (!itemIndexes.TryGetValue(n, out var list))
                    {
                        itemIndexes[n] = list = new List<int>();
                    }

                    list.Add(i);
                }
            }

            var byTmdb = doc.Items.Where(p => p.TmdbId.HasValue).GroupBy(p => p.TmdbId!.Value).ToDictionary(g => g.Key, g => g.ToList());
            Dictionary<string, List<int>>? byIdentity = null;

            // Positions of the real items that stand for a key (exact, else its season, else its series).
            IEnumerable<int> RealItemsOf(string key)
            {
                if (itemKeys == null || itemIndexes.Count == 0)
                {
                    return Array.Empty<int>();
                }

                if (byIdentity == null)
                {
                    byIdentity = new Dictionary<string, List<int>>(StringComparer.Ordinal);
                    foreach (var (itemId, indexes) in itemIndexes)
                    {
                        foreach (var identity in itemKeys(Guid.ParseExact(itemId, "N")))
                        {
                            if (!byIdentity.TryGetValue(identity, out var list))
                            {
                                byIdentity[identity] = list = new List<int>();
                            }

                            list.AddRange(indexes);
                        }
                    }
                }

                var parts = key.Split('|');
                var patterns = parts.Length != 4 ? new[] { key }
                    : parts[3].Length > 0 ? new[] { key, $"{parts[0]}|{parts[1]}|{parts[2]}|", $"{parts[0]}|{parts[1]}||" }
                    : parts[2].Length > 0 ? new[] { key, $"{parts[0]}|{parts[1]}||" }
                    : new[] { key };
                foreach (var pattern in patterns)
                {
                    if (byIdentity.TryGetValue(pattern, out var found))
                    {
                        return found;
                    }
                }

                return Array.Empty<int>();
            }

            // First and last position in the order of everything that represents a key (null = not in the list).
            (int First, int Last)? Span(string key)
            {
                var first = int.MaxValue;
                var last = -1;
                void Add(int i)
                {
                    first = Math.Min(first, i);
                    last = Math.Max(last, i);
                }

                if (doc.Source != null && doc.Source.Owned.TryGetValue(key, out var owned))
                {
                    foreach (var itemId in owned.ItemIds)
                    {
                        if (itemIndexes.TryGetValue(itemId, out var indexes))
                        {
                            indexes.ForEach(Add);
                        }
                    }

                    // An episode of a run that is in the list as its own real episode is that episode, not the run's
                    // placeholder every key of the run shares (it sits after the run's real episodes, so anchoring on it
                    // would put a new neighbour after the whole run). Wider keys span both.
                    var ownEpisode = last >= 0 && SourceKeys.EpisodeOf(key) != null;
                    if (!ownEpisode && owned.PhId != null && tokenIndex.TryGetValue(ListPlaceholderOrder.PlaceholderToken(owned.PhId), out var at))
                    {
                        Add(at);
                    }
                }

                if (last >= 0)
                {
                    return (first, last);
                }

                // Not owned: an equivalent placeholder, and real items of the title that are in the list anyway.
                if (TmdbOf(key) is { } tmdb && byTmdb.TryGetValue(tmdb, out var candidates)
                    && ListSourceProvenance.Covering(candidates, key) is { } covering
                    && tokenIndex.TryGetValue(ListPlaceholderOrder.PlaceholderToken(covering.Id), out var coveringAt))
                {
                    Add(coveringAt);
                }

                foreach (var at in RealItemsOf(key))
                {
                    Add(at);
                }

                return last < 0 ? null : (first, last);
            }

            var spans = sourceKeys.Select(Span).ToArray();
            var previous = new string?[sourceKeys.Count];
            string? lastSeen = null;
            for (var i = 0; i < spans.Length; i++)
            {
                previous[i] = lastSeen;
                if (spans[i] is { } span)
                {
                    lastSeen = order[span.Last];
                }
            }

            var following = new string?[sourceKeys.Count];
            string? nextSeen = null;
            for (var i = spans.Length - 1; i >= 0; i--)
            {
                following[i] = nextSeen;
                if (spans[i] is { } span)
                {
                    nextSeen = order[span.First];
                }
            }

            foreach (var (entry, position) in entryPositions)
            {
                if (position < 0 || position >= sourceKeys.Count)
                {
                    continue;
                }

                if (previous[position] is { } after)
                {
                    anchors[entry] = new EntryAnchor(after, null);
                }
                else if (following[position] is { } before)
                {
                    anchors[entry] = new EntryAnchor(null, before);
                }
            }

            return anchors;
        }

        /// <summary>The TMDB id of a <c>movie|…</c> or <c>tv|…</c> key, else null.</summary>
        /// <param name="key">Source key.</param>
        /// <returns>The id or null.</returns>
        internal static int? TmdbOf(string key)
        {
            var parts = key.Split('|');
            return parts.Length == 4 && parts[0] is ("movie" or "tv") && int.TryParse(parts[1], NumberStyles.None, CultureInfo.InvariantCulture, out var id) ? id : null;
        }
    }
}
