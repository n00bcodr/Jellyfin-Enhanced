using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists
{
    /// <summary>One raw <c>LinkedChildren</c> slot of a playlist: its item id, and whether it resolves to a library item.</summary>
    /// <param name="ItemId">The linked item id (null when the link has none).</param>
    /// <param name="Resolved">False for dangling links (item deleted / unresolvable); they occupy a raw slot but get no token.</param>
    public readonly record struct RawEntry(Guid? ItemId, bool Resolved);

    /// <summary>Outcome of <see cref="ListOrder.MergeProjection"/>.</summary>
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
    public static class ListOrder
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

        /// <summary>
        /// Splices a reordered projection back into the canonical order; hidden tokens follow their anchor (the nearest
        /// visible token before them). When that would carry a hidden REAL row along with a placeholder the caller moved
        /// (so the real rows would no longer be in Jellyfin's order), the hidden real rows of that segment only (the run
        /// between two visible real rows) anchor to the segment's leading visible real row (or the start) instead; other
        /// segments keep their anchors.
        /// </summary>
        /// <param name="canonical">Canonical order.</param>
        /// <param name="visible">Tokens of the projection.</param>
        /// <param name="requested">Reordered projection.</param>
        /// <param name="excludeAnchor">A visible token hidden tokens must not anchor to (the moved real row).</param>
        /// <returns>The desired canonical order.</returns>
        public static List<string> Splice(IReadOnlyList<string> canonical, ISet<string> visible, IReadOnlyList<string> requested, string? excludeAnchor)
        {
            var spliced = Splice(canonical, visible, requested, excludeAnchor, null);
            bool Kept(string t) => IsReal(t) && !string.Equals(t, excludeAnchor, StringComparison.Ordinal);
            if (spliced.Where(Kept).SequenceEqual(canonical.Where(Kept), StringComparer.Ordinal))
            {
                return spliced;
            }

            // Segments: the hidden real rows after each visible real row (string.Empty = before the first one).
            var leads = new List<string> { string.Empty };
            var segments = new Dictionary<string, List<string>>(StringComparer.Ordinal);
            foreach (var token in canonical)
            {
                if (visible.Contains(token))
                {
                    if (Kept(token))
                    {
                        leads.Add(token);
                    }
                }
                else if (IsReal(token))
                {
                    GetList(segments, leads[^1]).Add(token);
                }
            }

            var position = new Dictionary<string, int>(StringComparer.Ordinal);
            for (var i = 0; i < spliced.Count; i++)
            {
                position.TryAdd(spliced[i], i);
            }

            // A segment is broken when one of its hidden real rows left the window between its lead and the next visible
            // real row, or the rows are no longer in canonical order.
            var broken = new HashSet<string>(StringComparer.Ordinal);
            for (var i = 0; i < leads.Count; i++)
            {
                if (!segments.TryGetValue(leads[i], out var rows))
                {
                    continue;
                }

                var previous = leads[i].Length == 0 ? -1 : position[leads[i]];
                var end = i + 1 < leads.Count ? position[leads[i + 1]] : spliced.Count;
                foreach (var row in rows)
                {
                    var at = position[row];
                    if (at <= previous || at >= end)
                    {
                        broken.Add(leads[i]);
                        break;
                    }

                    previous = at;
                }
            }

            return Splice(canonical, visible, requested, excludeAnchor, broken);
        }

        private static List<string> Splice(IReadOnlyList<string> canonical, ISet<string> visible, IReadOnlyList<string> requested, string? excludeAnchor, ISet<string>? realAnchored)
        {
            var anchored = new Dictionary<string, List<string>>(StringComparer.Ordinal);
            var last = string.Empty;
            var lastReal = string.Empty;
            foreach (var token in canonical)
            {
                if (visible.Contains(token))
                {
                    if (!string.Equals(token, excludeAnchor, StringComparison.Ordinal))
                    {
                        last = token;
                        if (IsReal(token))
                        {
                            lastReal = token;
                        }
                    }
                }
                else
                {
                    GetList(anchored, realAnchored != null && IsReal(token) && realAnchored.Contains(lastReal) ? lastReal : last).Add(token);
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
        /// Coordinate system of <c>MoveItemAsync</c> (A5): the <c>newIndex</c> values (one move, else two moves of the
        /// same item) that make Jellyfin produce exactly <paramref name="desiredReal"/>, every real row included (also
        /// rows the mover can't see). Jellyfin reads newIndex against the mover's visible rows BEFORE the move, finds the
        /// prior row's index among resolved rows and inserts at that index into the raw array without the moved row, so
        /// once hidden rows or dangling links are involved no closed formula holds and some spots need a detour: the
        /// candidates are replayed against Jellyfin's algorithm (<see cref="SimulateMove"/>).
        /// </summary>
        /// <param name="raw">Fresh raw slots.</param>
        /// <param name="itemId">The item to move (Jellyfin moves its FIRST copy).</param>
        /// <param name="desiredReal">Desired real order after the move(s).</param>
        /// <param name="visibleToMover">Whether an item is visible to the user the move runs as.</param>
        /// <returns>The indexes to pass, in order (empty when already in order), or null when two moves can't get there.</returns>
        public static IReadOnlyList<int>? FindMoves(IReadOnlyList<RawEntry> raw, Guid itemId, IReadOnlyList<string> desiredReal, Func<Guid, bool> visibleToMover)
        {
            var desired = new List<Guid>(desiredReal.Count);
            foreach (var token in desiredReal)
            {
                if (!TryParseReal(token, out var id, out _))
                {
                    return null;
                }

                desired.Add(id);
            }

            if (raw.Where(r => r.Resolved && r.ItemId.HasValue).Select(r => r.ItemId!.Value).SequenceEqual(desired))
            {
                return Array.Empty<int>();
            }

            var single = FindSingleMove(raw, itemId, desired, visibleToMover);
            if (single != null)
            {
                return new[] { single.Value };
            }

            var manageable = raw.Where(r => r.Resolved).ToList();
            var visible = manageable.Where(r => r.ItemId.HasValue && visibleToMover(r.ItemId.Value)).ToList();
            for (var first = 0; first <= visible.Count; first++)
            {
                var detour = SimulateMove(raw, manageable, visible, itemId, first);
                if (detour == null || detour.SequenceEqual(raw))
                {
                    continue;
                }

                var second = FindSingleMove(detour, itemId, desired, visibleToMover);
                if (second != null)
                {
                    return new[] { first, second.Value };
                }
            }

            return null;
        }

        /// <summary>
        /// Replays Jellyfin's <c>PlaylistManager.MoveItemAsync</c> (identical in 12.2 and 10.11.11) on raw slots.
        /// Assumes a resolved slot's <c>LinkedChild.ItemId</c> is the resolved item's id.
        /// </summary>
        /// <param name="raw">Raw slots before the move.</param>
        /// <param name="itemId">The item to move.</param>
        /// <param name="newIndex">The index passed to Jellyfin.</param>
        /// <param name="visibleToMover">Whether an item is visible to the user the move runs as.</param>
        /// <returns>The raw slots after the move, or null when Jellyfin would throw or skip it (item not in the list).</returns>
        public static List<RawEntry>? SimulateMove(IReadOnlyList<RawEntry> raw, Guid itemId, int newIndex, Func<Guid, bool> visibleToMover)
        {
            var manageable = raw.Where(r => r.Resolved).ToList();
            var visible = manageable.Where(r => r.ItemId.HasValue && visibleToMover(r.ItemId.Value)).ToList();
            return SimulateMove(raw, manageable, visible, itemId, newIndex);
        }

        private static List<RawEntry>? SimulateMove(IReadOnlyList<RawEntry> raw, List<RawEntry> manageable, List<RawEntry> visible, Guid itemId, int newIndex)
        {
            var result = raw.ToList();
            if (visible.FindIndex(r => r.ItemId == itemId) == newIndex)
            {
                return result;
            }

            var priorSlot = Math.Max(newIndex - 1, 0);
            if (newIndex < 0 || priorSlot >= visible.Count)
            {
                return null;
            }

            var prior = visible[priorSlot].ItemId;
            var priorIndex = manageable.FindIndex(r => r.ItemId == prior);
            var index = newIndex == 0 ? Math.Max(priorIndex - 1, 0) : priorIndex + 1;
            var first = result.FindIndex(r => r.ItemId == itemId);
            if (first < 0)
            {
                return null;
            }

            var entry = result[first];
            result.RemoveAt(first);
            if (newIndex >= result.Count)
            {
                result.Add(entry);
            }
            else if (index > result.Count)
            {
                return null;
            }
            else
            {
                result.Insert(index, entry);
            }

            return result;
        }

        // One move. Each candidate's outcome is derived in O(1) from Jellyfin's algorithm (as in SimulateMove): the item
        // lands at a real position q of the other rows, and only some q give the desired order. Linear overall.
        private static int? FindSingleMove(IReadOnlyList<RawEntry> raw, Guid itemId, IReadOnlyList<Guid> desired, Func<Guid, bool> visibleToMover)
        {
            var moved = -1;
            for (var i = 0; i < raw.Count && moved < 0; i++)
            {
                if (raw[i].ItemId == itemId)
                {
                    moved = i;
                }
            }

            if (moved < 0 || !raw[moved].Resolved)
            {
                return null;
            }

            // The raw array without the moved slot: its real rows, and how many of them precede each slot.
            var rest = new List<Guid>(raw.Count);
            var realBefore = new int[raw.Count];
            var slot = 0;
            for (var i = 0; i < raw.Count; i++)
            {
                if (i == moved)
                {
                    continue;
                }

                realBefore[slot++] = rest.Count;
                if (raw[i].Resolved && raw[i].ItemId.HasValue)
                {
                    rest.Add(raw[i].ItemId!.Value);
                }
            }

            realBefore[slot] = rest.Count;
            if (desired.Count != rest.Count + 1)
            {
                return null;
            }

            // Inserting the item at q gives `desired` iff desired[q] is the item and the other rows agree before and after q.
            var prefix = 0;
            while (prefix < rest.Count && rest[prefix] == desired[prefix])
            {
                prefix++;
            }

            var suffixStart = rest.Count;
            while (suffixStart > 0 && rest[suffixStart - 1] == desired[suffixStart])
            {
                suffixStart--;
            }

            var manageable = raw.Where(r => r.Resolved).ToList();
            var firstManageable = new Dictionary<Guid, int>();
            for (var i = 0; i < manageable.Count; i++)
            {
                if (manageable[i].ItemId is Guid id)
                {
                    firstManageable.TryAdd(id, i);
                }
            }

            var visible = manageable.Where(r => r.ItemId.HasValue && visibleToMover(r.ItemId.Value)).ToList();
            var visibleIndex = visible.FindIndex(r => r.ItemId == itemId);
            for (var newIndex = 0; newIndex <= visible.Count; newIndex++)
            {
                var priorSlot = Math.Max(newIndex - 1, 0);
                if (newIndex == visibleIndex || priorSlot >= visible.Count)
                {
                    continue;
                }

                var priorIndex = firstManageable[visible[priorSlot].ItemId!.Value];
                var index = newIndex == 0 ? Math.Max(priorIndex - 1, 0) : priorIndex + 1;
                int q;
                if (newIndex >= raw.Count - 1)
                {
                    q = rest.Count;
                }
                else if (index > raw.Count - 1)
                {
                    continue;
                }
                else
                {
                    q = realBefore[index];
                }

                if (q >= suffixStart && q <= prefix && desired[q] == itemId)
                {
                    return newIndex;
                }
            }

            return null;
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
