using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders
{
    /// <summary>One raw <c>LinkedChildren</c> slot of a playlist: its item id, and whether it resolves to a library item.</summary>
    /// <param name="ItemId">The linked item id (null when the link has none).</param>
    /// <param name="Resolved">False for dangling links (item deleted / unresolvable); they occupy a raw slot but get no token.</param>
    public readonly record struct RawEntry(Guid? ItemId, bool Resolved);

    /// <summary>Outcome of <see cref="ListPlaceholderOrder.MergeProjection"/>.</summary>
    /// <param name="Ok">True when the requested order is acceptable.</param>
    /// <param name="Error">Machine error code when not ok.</param>
    /// <param name="Desired">The desired canonical order (projection spliced back; hidden tokens keep their anchors).</param>
    /// <param name="RealMoved">True when a real row changed position (the server must move it in Jellyfin).</param>
    public sealed record OrderMergeResult(bool Ok, string? Error, IReadOnlyList<string> Desired, bool RealMoved);

    /// <summary>One new entry of an insert run: a real item, or a placeholder token.</summary>
    /// <param name="ItemId">The real item, or null.</param>
    /// <param name="PlaceholderToken">The placeholder token, or null.</param>
    public readonly record struct NewEntry(Guid? ItemId, string? PlaceholderToken);

    /// <summary>
    /// Pure order algebra for playlist placeholders (design §3 + amendments A1–A5, A7).
    /// <para>
    /// Jellyfin has no per-entry id in a playlist (<c>PlaylistItemId</c> is the item id; duplicates share it), so a real
    /// entry is identified by <c>e:&lt;itemIdN&gt;:&lt;k&gt;</c> = the k-th occurrence (0-based, in current playlist
    /// order) of that item. A placeholder is <c>p:&lt;phId&gt;</c>. The canonical order holds every real entry of the
    /// playlist's resolved <c>LinkedChildren</c> plus every placeholder; callers only ever see a projection of it.
    /// </para>
    /// Two index systems exist for Jellyfin mutations: the RAW <c>LinkedChildren</c> index (jf12
    /// <c>AddItemToPlaylistAsync(position)</c>, includes dangling links) and the VISIBLE-row index of
    /// <c>MoveItemAsync</c> (rows visible to the user passed to it).
    /// </summary>
    public static class ListPlaceholderOrder
    {
        /// <summary>Prefix of real-entry tokens.</summary>
        public const string RealPrefix = "e:";

        /// <summary>Prefix of placeholder tokens.</summary>
        public const string PlaceholderPrefix = "p:";

        /// <summary>Builds the token of the k-th occurrence of an item.</summary>
        /// <param name="itemId">Library item id.</param>
        /// <param name="occurrence">0-based occurrence.</param>
        /// <returns>The token.</returns>
        public static string RealToken(Guid itemId, int occurrence) =>
            RealPrefix + itemId.ToString("N", CultureInfo.InvariantCulture) + ":" + occurrence.ToString(CultureInfo.InvariantCulture);

        /// <summary>Builds a placeholder token.</summary>
        /// <param name="placeholderId">Placeholder id.</param>
        /// <returns>The token.</returns>
        public static string PlaceholderToken(string placeholderId) => PlaceholderPrefix + placeholderId;

        /// <summary>True for a syntactically valid real token.</summary>
        /// <param name="token">Token.</param>
        /// <returns>Whether it is a real token.</returns>
        public static bool IsReal(string? token) => TryParseReal(token, out _, out _);

        /// <summary>True for a placeholder token.</summary>
        /// <param name="token">Token.</param>
        /// <returns>Whether it is a placeholder token.</returns>
        public static bool IsPlaceholder(string? token) =>
            token != null && token.Length > PlaceholderPrefix.Length && token.StartsWith(PlaceholderPrefix, StringComparison.Ordinal);

        /// <summary>The placeholder id of a placeholder token, else null.</summary>
        /// <param name="token">Token.</param>
        /// <returns>The id or null.</returns>
        public static string? PlaceholderIdOf(string? token) => IsPlaceholder(token) ? token![PlaceholderPrefix.Length..] : null;

        /// <summary>Parses <c>e:&lt;32 hex&gt;:&lt;k&gt;</c>.</summary>
        /// <param name="token">Token.</param>
        /// <param name="itemId">Parsed item id.</param>
        /// <param name="occurrence">Parsed occurrence.</param>
        /// <returns>Whether the token is a valid real token.</returns>
        public static bool TryParseReal(string? token, out Guid itemId, out int occurrence)
        {
            itemId = Guid.Empty;
            occurrence = -1;
            if (token == null || token.Length < RealPrefix.Length + 34 || !token.StartsWith(RealPrefix, StringComparison.Ordinal))
            {
                return false;
            }

            var idPart = token.Substring(RealPrefix.Length, 32);
            if (token[RealPrefix.Length + 32] != ':'
                || !Guid.TryParseExact(idPart, "N", out itemId)
                || !int.TryParse(token.AsSpan(RealPrefix.Length + 33), NumberStyles.None, CultureInfo.InvariantCulture, out occurrence)
                || occurrence < 0)
            {
                itemId = Guid.Empty;
                occurrence = -1;
                return false;
            }

            // Canonical form only (lowercase id, no leading zeros) so string equality == token equality.
            return string.Equals(token, RealToken(itemId, occurrence), StringComparison.Ordinal);
        }

        /// <summary>Real tokens for the resolved entries of a playlist, in playlist order.</summary>
        /// <param name="resolvedItemIds">Item ids of the resolved entries, in raw order.</param>
        /// <returns>One token per entry, occurrences numbered by appearance.</returns>
        public static List<string> BuildRealTokens(IEnumerable<Guid> resolvedItemIds)
        {
            var counts = new Dictionary<Guid, int>();
            var tokens = new List<string>();
            foreach (var id in resolvedItemIds)
            {
                counts.TryGetValue(id, out var k);
                tokens.Add(RealToken(id, k));
                counts[id] = k + 1;
            }

            return tokens;
        }

        /// <summary>Real tokens of the resolved raw entries.</summary>
        /// <param name="raw">Raw LinkedChildren slots.</param>
        /// <returns>Tokens in order.</returns>
        public static List<string> BuildRealTokens(IEnumerable<RawEntry> raw) =>
            BuildRealTokens(raw.Where(r => r.Resolved && r.ItemId.HasValue).Select(r => r.ItemId!.Value));

        /// <summary>
        /// Reconciles a stored order with the playlist's current real entries (design §3):
        /// every placeholder anchors to the nearest PRECEDING stored real token that still exists (none = start);
        /// placeholders missing from the stored order go to the end; deleted placeholders and real tokens are dropped;
        /// real tokens always follow the current playlist order.
        /// </summary>
        /// <param name="stored">The stored (possibly stale) order.</param>
        /// <param name="currentReal">The current real tokens in playlist order.</param>
        /// <param name="placeholderIds">Ids of all current placeholders (stored order of the document).</param>
        /// <returns>The reconciled canonical order.</returns>
        public static List<string> Reconcile(IReadOnlyList<string> stored, IReadOnlyList<string> currentReal, IReadOnlyList<string> placeholderIds)
        {
            var currentSet = new HashSet<string>(currentReal, StringComparer.Ordinal);
            var phTokens = new HashSet<string>(placeholderIds.Select(PlaceholderToken), StringComparer.Ordinal);
            var anchored = new Dictionary<string, List<string>>(StringComparer.Ordinal);
            var seen = new HashSet<string>(StringComparer.Ordinal);
            var last = string.Empty;

            foreach (var token in stored)
            {
                if (IsReal(token))
                {
                    if (currentSet.Contains(token))
                    {
                        last = token;
                    }
                }
                else if (phTokens.Contains(token) && seen.Add(token))
                {
                    GetList(anchored, last).Add(token);
                }
            }

            var result = new List<string>(currentReal.Count + phTokens.Count);
            if (anchored.TryGetValue(string.Empty, out var head))
            {
                result.AddRange(head);
            }

            var emitted = new HashSet<string>(StringComparer.Ordinal);
            foreach (var real in currentReal)
            {
                result.Add(real);
                if (emitted.Add(real) && anchored.TryGetValue(real, out var after))
                {
                    result.AddRange(after);
                }
            }

            foreach (var id in placeholderIds)
            {
                var token = PlaceholderToken(id);
                if (!seen.Contains(token) && seen.Add(token))
                {
                    result.Add(token);
                }
            }

            return result;
        }

        /// <summary>Renumbers the occurrence of every real token by order of appearance (A7 renumbering).</summary>
        /// <param name="order">An order whose real tokens may carry stale occurrence numbers.</param>
        /// <returns>The relabelled order (placeholders untouched).</returns>
        public static List<string> Relabel(IEnumerable<string> order)
        {
            var counts = new Dictionary<Guid, int>();
            var result = new List<string>();
            foreach (var token in order)
            {
                if (TryParseReal(token, out var id, out _))
                {
                    counts.TryGetValue(id, out var k);
                    result.Add(RealToken(id, k));
                    counts[id] = k + 1;
                }
                else
                {
                    result.Add(token);
                }
            }

            return result;
        }

        /// <summary>The caller's projection: canonical order filtered to the tokens the caller may see (A2).</summary>
        /// <param name="canonical">Canonical order.</param>
        /// <param name="isVisible">Visibility predicate per token.</param>
        /// <returns>The projected order.</returns>
        public static List<string> Project(IReadOnlyList<string> canonical, Func<string, bool> isVisible) =>
            canonical.Where(isVisible).ToList();

        /// <summary>
        /// Validates a client's reordered projection and splices it back into the canonical order (A4).
        /// The request must be a permutation of the caller's current projection; real tokens may only differ from the
        /// current real order by the single <paramref name="moved"/> token. A non-first copy of a duplicated item can't be
        /// moved (Jellyfin always moves the first copy). Hidden tokens keep their anchors (the nearest preceding visible
        /// token, ignoring the moved real token so hidden rows don't travel with it).
        /// </summary>
        /// <param name="canonical">Canonical order.</param>
        /// <param name="projection">The caller's current projection of <paramref name="canonical"/>.</param>
        /// <param name="requested">The caller's requested projection.</param>
        /// <param name="moved">The real token that moved, if any.</param>
        /// <returns>The merge result.</returns>
        public static OrderMergeResult MergeProjection(IReadOnlyList<string> canonical, IReadOnlyList<string> projection, IReadOnlyList<string> requested, string? moved)
        {
            var empty = Array.Empty<string>();
            var requestedSet = new HashSet<string>(requested, StringComparer.Ordinal);
            if (requestedSet.Count != requested.Count
                || requested.Count != projection.Count
                || !projection.All(requestedSet.Contains))
            {
                return new OrderMergeResult(false, "not_permutation", empty, false);
            }

            var realProjection = projection.Where(IsReal).ToList();
            var realRequested = requested.Where(IsReal).ToList();
            var realMoved = false;
            if (moved != null)
            {
                if (!IsReal(moved) || !requestedSet.Contains(moved))
                {
                    return new OrderMergeResult(false, "moved_invalid", empty, false);
                }

                if (!realProjection.SequenceEqual(realRequested, StringComparer.Ordinal))
                {
                    var without = realProjection.Where(t => t != moved).ToList();
                    if (!without.SequenceEqual(realRequested.Where(t => t != moved), StringComparer.Ordinal))
                    {
                        return new OrderMergeResult(false, "real_order_changed", empty, false);
                    }

                    realMoved = true;
                }
            }
            else if (!realProjection.SequenceEqual(realRequested, StringComparer.Ordinal))
            {
                return new OrderMergeResult(false, "real_order_changed", empty, false);
            }

            if (realMoved)
            {
                TryParseReal(moved, out _, out var occurrence);
                if (occurrence > 0)
                {
                    return new OrderMergeResult(false, "duplicate_copy", empty, false);
                }
            }

            var desired = Splice(canonical, new HashSet<string>(projection, StringComparer.Ordinal), requested, realMoved ? moved : null);
            return new OrderMergeResult(true, null, desired, realMoved);
        }

        /// <summary>Splices a reordered projection back into the canonical order; hidden tokens follow their anchor.</summary>
        /// <param name="canonical">Canonical order.</param>
        /// <param name="visible">Tokens of the projection.</param>
        /// <param name="requested">Reordered projection.</param>
        /// <param name="excludeAnchor">A visible token hidden tokens must not anchor to (the moved real row).</param>
        /// <returns>The desired canonical order.</returns>
        public static List<string> Splice(IReadOnlyList<string> canonical, ISet<string> visible, IReadOnlyList<string> requested, string? excludeAnchor)
        {
            var anchored = new Dictionary<string, List<string>>(StringComparer.Ordinal);
            var last = string.Empty;
            foreach (var token in canonical)
            {
                if (visible.Contains(token))
                {
                    if (!string.Equals(token, excludeAnchor, StringComparison.Ordinal))
                    {
                        last = token;
                    }
                }
                else
                {
                    GetList(anchored, last).Add(token);
                }
            }

            var result = new List<string>(canonical.Count);
            if (anchored.TryGetValue(string.Empty, out var head))
            {
                result.AddRange(head);
            }

            foreach (var token in requested)
            {
                result.Add(token);
                if (anchored.TryGetValue(token, out var after))
                {
                    result.AddRange(after);
                }
            }

            return result;
        }

        /// <summary>
        /// Inserts new real entries for <paramref name="itemIds"/> at <paramref name="index"/> of an order and renumbers
        /// occurrences (A7): later copies of the same items shift to k+1.
        /// </summary>
        /// <param name="order">Canonical order (real tokens numbered by appearance).</param>
        /// <param name="index">Insert position in <paramref name="order"/> (0 = start, Count = end).</param>
        /// <param name="itemIds">Items in insertion order.</param>
        /// <returns>The new order and the tokens the inserted entries now carry.</returns>
        public static (List<string> Order, List<string> Inserted) InsertRealItems(IReadOnlyList<string> order, int index, IReadOnlyList<Guid> itemIds) =>
            InsertEntries(order, index, itemIds.Select(id => new NewEntry(id, null)).ToList());

        /// <summary>
        /// Inserts a run of new entries — real items and placeholder tokens, in the given order — at
        /// <paramref name="index"/> and renumbers real occurrences (A7). New real items end up contiguous in Jellyfin's
        /// raw order (placeholders occupy no raw slot), so one Jellyfin insert covers the whole run.
        /// </summary>
        /// <param name="order">Canonical order.</param>
        /// <param name="index">Insert position (0 = start, Count = end).</param>
        /// <param name="entries">New entries in order.</param>
        /// <returns>The new order and the tokens of the inserted REAL entries, in order.</returns>
        public static (List<string> Order, List<string> Inserted) InsertEntries(IReadOnlyList<string> order, int index, IReadOnlyList<NewEntry> entries)
        {
            index = Math.Clamp(index, 0, order.Count);
            const string Marker = "\u0000new";
            var working = new List<string>(order.Count + entries.Count);
            working.AddRange(order.Take(index));
            var itemIds = new List<Guid>();
            foreach (var entry in entries)
            {
                if (entry.ItemId.HasValue)
                {
                    working.Add(Marker + itemIds.Count.ToString(CultureInfo.InvariantCulture));
                    itemIds.Add(entry.ItemId.Value);
                }
                else if (entry.PlaceholderToken != null)
                {
                    working.Add(entry.PlaceholderToken);
                }
            }

            working.AddRange(order.Skip(index));

            var counts = new Dictionary<Guid, int>();
            var inserted = new string[itemIds.Count];
            var result = new List<string>(working.Count);
            foreach (var token in working)
            {
                Guid id;
                var markerIndex = -1;
                if (token.StartsWith(Marker, StringComparison.Ordinal))
                {
                    markerIndex = int.Parse(token.AsSpan(Marker.Length), NumberStyles.None, CultureInfo.InvariantCulture);
                    id = itemIds[markerIndex];
                }
                else if (!TryParseReal(token, out id, out _))
                {
                    result.Add(token);
                    continue;
                }

                counts.TryGetValue(id, out var k);
                var relabelled = RealToken(id, k);
                counts[id] = k + 1;
                result.Add(relabelled);
                if (markerIndex >= 0)
                {
                    inserted[markerIndex] = relabelled;
                }
            }

            return (result, inserted.ToList());
        }

        /// <summary>The nearest real token strictly before <paramref name="index"/> in an order (null = none).</summary>
        /// <param name="order">Order.</param>
        /// <param name="index">Exclusive end.</param>
        /// <returns>The anchor real token or null.</returns>
        public static string? RealAnchorBefore(IReadOnlyList<string> order, int index)
        {
            for (var i = Math.Min(index, order.Count) - 1; i >= 0; i--)
            {
                if (IsReal(order[i]))
                {
                    return order[i];
                }
            }

            return null;
        }

        /// <summary>
        /// jf12 coordinate system (A5): the RAW <c>LinkedChildren</c> insert position right after the anchor's k-th
        /// resolved occurrence (0 when there is no anchor). Dangling links count as raw slots.
        /// </summary>
        /// <param name="raw">Fresh raw slots.</param>
        /// <param name="anchor">Real token the new entries go after, or null for the start.</param>
        /// <returns>The raw position, or null when the anchor no longer exists.</returns>
        public static int? RawInsertPosition(IReadOnlyList<RawEntry> raw, string? anchor)
        {
            if (anchor == null)
            {
                return 0;
            }

            if (!TryParseReal(anchor, out var id, out var k))
            {
                return null;
            }

            var seen = 0;
            for (var i = 0; i < raw.Count; i++)
            {
                if (raw[i].Resolved && raw[i].ItemId == id)
                {
                    if (seen == k)
                    {
                        return i + 1;
                    }

                    seen++;
                }
            }

            return null;
        }

        /// <summary>
        /// Visible-row coordinate system of <c>MoveItemAsync</c> (A5): the index the moved entry must have in the
        /// mover's visible rows of the desired real order. Rows the mover can't see are skipped.
        /// </summary>
        /// <param name="desiredReal">Desired real order (contains <paramref name="moved"/>).</param>
        /// <param name="moved">The moved real token.</param>
        /// <param name="visibleToMover">Whether a real token is visible to the user the move runs as.</param>
        /// <returns>The new index, or -1 when <paramref name="moved"/> isn't in the order.</returns>
        public static int VisibleMoveIndex(IReadOnlyList<string> desiredReal, string moved, Func<string, bool> visibleToMover)
        {
            var index = 0;
            foreach (var token in desiredReal)
            {
                if (string.Equals(token, moved, StringComparison.Ordinal))
                {
                    return index;
                }

                if (IsReal(token) && visibleToMover(token))
                {
                    index++;
                }
            }

            return -1;
        }

        /// <summary>
        /// Collections have no stored order: placeholders show by release date ascending, TBA last, then by title.
        /// </summary>
        /// <param name="items">Placeholders.</param>
        /// <returns>Sorted placeholders.</returns>
        public static List<Placeholder> SortForCollection(IEnumerable<Placeholder> items) =>
            items
                .OrderBy(p => string.IsNullOrEmpty(p.ReleaseDate) ? 1 : 0)
                .ThenBy(p => p.ReleaseDate ?? string.Empty, StringComparer.Ordinal)
                .ThenBy(p => p.Title, StringComparer.OrdinalIgnoreCase)
                .ThenBy(p => p.Id, StringComparer.Ordinal)
                .ToList();

        private static List<string> GetList(Dictionary<string, List<string>> map, string key)
        {
            if (!map.TryGetValue(key, out var list))
            {
                list = new List<string>();
                map[key] = list;
            }

            return list;
        }
    }
}
