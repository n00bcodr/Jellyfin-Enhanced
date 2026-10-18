using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Jellyfin.Database.Implementations.Entities;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Lists
{
    /// <summary>
    /// Puts new real items into a playlist at a placeholder-order position (shared by adds/applies and swap-in).
    /// </summary>
    internal static class ListPlaylistPlacement
    {
        /// <summary>
        /// Puts a contiguous run of new real items into Jellyfin right after <paramref name="anchor"/>, in the coordinate
        /// system the Jellyfin version needs (jf12: one positional insert at the raw index; jf10: append, then move each
        /// into place as the owner with the move(s) that replay to the target order), then verifies Jellyfin's actual
        /// order (A5): one misplaced item is moved again, anything else falls back to Jellyfin's order with placeholders
        /// reconciled to their anchors.
        /// </summary>
        /// <param name="host">Jellyfin seam.</param>
        /// <param name="logger">JE logger.</param>
        /// <param name="listId">Playlist.</param>
        /// <param name="listIdN">Playlist id ("N", for logs).</param>
        /// <param name="owner">Playlist owner (whose rows the moves are computed against).</param>
        /// <param name="items">New items, in order.</param>
        /// <param name="anchor">Real token the run goes after (null = start).</param>
        /// <param name="desired">The desired canonical order with the run's tokens inserted.</param>
        /// <param name="inserted">The tokens the new items carry in <paramref name="desired"/>.</param>
        /// <param name="write">
        /// The gate, asked right before each Jellyfin write (the insert, then every move that places it) for that write's
        /// grant; it throws when the write isn't allowed any more, which stops the placement there.
        /// </param>
        /// <returns>The canonical order after the insert (desired, or Jellyfin's actual order reconciled).</returns>
        public static async Task<List<string>> PlaceAsync(
            IListHost host,
            Logger logger,
            Guid listId,
            string listIdN,
            User owner,
            IReadOnlyList<Guid> items,
            string? anchor,
            List<string> desired,
            IReadOnlyList<string> inserted,
            Func<ListWriteKind, IReadOnlyList<Guid>, ListWrite> write)
        {
            var ownerVisible = new Dictionary<Guid, bool>();
            bool VisibleToOwner(Guid itemId)
            {
                if (!ownerVisible.TryGetValue(itemId, out var visible))
                {
                    try
                    {
                        visible = host.IsEntryVisible(itemId, owner);
                    }
                    catch (Exception ex)
                    {
                        logger.Debug($"[Lists] Visibility check failed for {itemId:N}: {ex.Message}");
                        visible = false;
                    }

                    ownerVisible[itemId] = visible;
                }

                return visible;
            }

            if (host.SupportsPositionalInsert)
            {
                var position = ListOrder.RawInsertPosition(host.GetRawEntries(listId), anchor);
                await ListContinuation.Await(() => host.AddToPlaylistAsync(write(ListWriteKind.Insert, items), items, position)).ConfigureAwait(false);
            }
            else
            {
                await ListContinuation.Await(() => host.AddToPlaylistAsync(write(ListWriteKind.Insert, items), items, null)).ConfigureAwait(false);
                var raw = host.GetRawEntries(listId);
                var current = ListOrder.BuildRealTokens(raw);
                var previous = anchor;
                foreach (var token in inserted)
                {
                    if (!current.Contains(token))
                    {
                        continue; // Jellyfin dropped it; the verification below settles the order
                    }

                    var target = current.Where(t => t != token).ToList();
                    target.Insert(previous == null ? 0 : target.IndexOf(previous) + 1, token);
                    ListOrder.TryParseReal(token, out var itemId, out _);
                    // No move reaching the target (hidden rows / dangling links in the way): the verification settles it.
                    var moves = ListOrder.FindMoves(raw, itemId, target, VisibleToOwner) ?? Array.Empty<int>();
                    foreach (var newIndex in moves)
                    {
                        await ListContinuation.Await(() => host.MoveInPlaylistAsync(write(ListWriteKind.Place, new[] { itemId }), itemId, newIndex)).ConfigureAwait(false);
                    }

                    if (moves.Count > 0)
                    {
                        raw = host.GetRawEntries(listId);
                        current = ListOrder.BuildRealTokens(raw);
                    }

                    previous = token;
                }
            }

            var actualRaw = host.GetRawEntries(listId);
            var actual = ListOrder.BuildRealTokens(actualRaw);
            var desiredReal = desired.Where(ListOrder.IsReal).ToList();
            if (!actual.SequenceEqual(desiredReal, StringComparer.Ordinal) && items.Count == 1 && actual.Contains(inserted[0])
                && !FollowsAnchor(actual, inserted[0], anchor) && (anchor == null || actual.Contains(anchor)))
            {
                // One misplaced item: move it right after its anchor in Jellyfin's CURRENT rows (a native edit may have
                // landed since the insert, so JE's pre-insert view can't give the index).
                var target = actual.Where(t => t != inserted[0]).ToList();
                target.Insert(anchor == null ? 0 : target.IndexOf(anchor) + 1, inserted[0]);
                var moves = ListOrder.FindMoves(actualRaw, items[0], target, VisibleToOwner) ?? Array.Empty<int>();
                foreach (var newIndex in moves)
                {
                    await ListContinuation.Await(() => host.MoveInPlaylistAsync(write(ListWriteKind.Place, new[] { items[0] }), items[0], newIndex)).ConfigureAwait(false);
                }

                if (moves.Count > 0)
                {
                    actual = ListOrder.BuildRealTokens(host.GetRawEntries(listId));
                }
            }

            if (actual.SequenceEqual(desiredReal, StringComparer.Ordinal))
            {
                return desired;
            }

            if (items.Count == 1 && FollowsAnchor(actual, inserted[0], anchor))
            {
                // The item is where asked; the rest of the difference is someone else's edit meanwhile.
                logger.Debug($"[Lists] List {listIdN} changed while new entries were placed; keeping Jellyfin's order.");
            }
            else
            {
                logger.Warning($"[Lists] Jellyfin placed new entries of list {listIdN} differently than requested; keeping Jellyfin's order.");
            }

            return ListOrder.Reconcile(desired, actual, desired.Select(ListOrder.PlaceholderIdOf).OfType<string>().ToList());
        }

        /// <summary>
        /// Moves entries already in the playlist after an interrupted or failed placement to right after
        /// <paramref name="anchor"/>, in order, on either host, using Jellyfin's native move semantics.
        /// </summary>
        /// <param name="host">Jellyfin seam.</param>
        /// <param name="logger">JE logger.</param>
        /// <param name="listId">Playlist.</param>
        /// <param name="owner">Playlist owner (whose rows the moves are computed against).</param>
        /// <param name="anchor">Real token the entries go after (null = start); must still exist.</param>
        /// <param name="tokens">The entries' real tokens, in order.</param>
        /// <param name="write">The gate, asked right before each move for its grant (throws when it isn't allowed).</param>
        /// <returns>Jellyfin's real tokens afterwards.</returns>
        public static async Task<List<string>> MoveAfterAnchorAsync(
            IListHost host,
            Logger logger,
            Guid listId,
            User owner,
            string? anchor,
            IReadOnlyList<string> tokens,
            Func<ListWriteKind, IReadOnlyList<Guid>, ListWrite> write)
        {
            var raw = host.GetRawEntries(listId);
            var current = ListOrder.BuildRealTokens(raw);
            if (anchor != null && !current.Contains(anchor))
            {
                return current;
            }

            var ownerVisible = new Dictionary<Guid, bool>();
            bool VisibleToOwner(Guid itemId)
            {
                if (!ownerVisible.TryGetValue(itemId, out var visible))
                {
                    try
                    {
                        visible = host.IsEntryVisible(itemId, owner);
                    }
                    catch (Exception ex)
                    {
                        logger.Debug($"[Lists] Visibility check failed for {itemId:N}: {ex.Message}");
                        visible = false;
                    }

                    ownerVisible[itemId] = visible;
                }

                return visible;
            }

            var previous = anchor;
            foreach (var token in tokens)
            {
                if (!current.Contains(token))
                {
                    continue;
                }

                var target = current.Where(t => t != token).ToList();
                target.Insert(previous == null ? 0 : target.IndexOf(previous) + 1, token);
                ListOrder.TryParseReal(token, out var itemId, out _);
                // The move(s) that replay Jellyfin's MoveItemAsync to the target; none reachable = leave it.
                var moves = ListOrder.FindMoves(raw, itemId, target, VisibleToOwner) ?? Array.Empty<int>();
                foreach (var newIndex in moves)
                {
                    await ListContinuation.Await(() => host.MoveInPlaylistAsync(write(ListWriteKind.Place, new[] { itemId }), itemId, newIndex)).ConfigureAwait(false);
                }

                if (moves.Count > 0)
                {
                    raw = host.GetRawEntries(listId);
                    current = ListOrder.BuildRealTokens(raw);
                }

                previous = token;
            }

            return current;
        }

        // Whether `token` directly follows `anchor` in a real-token order (anchor null = first).
        private static bool FollowsAnchor(IReadOnlyList<string> order, string token, string? anchor)
        {
            var index = order.ToList().IndexOf(token);
            return index >= 0 && (anchor == null ? index == 0 : index > 0 && string.Equals(order[index - 1], anchor, StringComparison.Ordinal));
        }

        /// <summary>Verifies the entire landed run follows its saved anchor in the current native order.</summary>
        internal static bool RunFollowsAnchor(IReadOnlyList<string> order, IReadOnlyList<string> tokens, string? anchor)
        {
            foreach (var token in tokens)
            {
                if (!FollowsAnchor(order, token, anchor)) return false;
                anchor = token;
            }

            return true;
        }
    }
}
