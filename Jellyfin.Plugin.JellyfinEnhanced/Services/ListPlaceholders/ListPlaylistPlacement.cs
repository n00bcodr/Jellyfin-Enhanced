using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Jellyfin.Database.Implementations.Entities;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders
{
    /// <summary>
    /// Puts new real items into a playlist at a placeholder-order position (shared by adds/applies and swap-in).
    /// </summary>
    internal static class ListPlaylistPlacement
    {
        /// <summary>
        /// Puts a contiguous run of new real items into Jellyfin right after <paramref name="anchor"/>, in the coordinate
        /// system the Jellyfin version needs (jf12: one positional insert at the raw index; jf10: append, then move each
        /// into place by the owner's visible-row index), then verifies Jellyfin's actual order (A5): one misplaced item is
        /// fixed with a single move, anything else falls back to Jellyfin's order with placeholders reconciled to their
        /// anchors.
        /// </summary>
        /// <param name="host">Jellyfin seam.</param>
        /// <param name="logger">JE logger.</param>
        /// <param name="listId">Playlist.</param>
        /// <param name="listIdN">Playlist id ("N", for logs).</param>
        /// <param name="owner">Playlist owner (Jellyfin adds/moves run as the owner).</param>
        /// <param name="items">New items, in order.</param>
        /// <param name="anchor">Real token the run goes after (null = start).</param>
        /// <param name="desired">The desired canonical order with the run's tokens inserted.</param>
        /// <param name="inserted">The tokens the new items carry in <paramref name="desired"/>.</param>
        /// <returns>The canonical order after the insert (desired, or Jellyfin's actual order reconciled).</returns>
        public static async Task<List<string>> PlaceAsync(
            IListPlaceholderHost host,
            Logger logger,
            Guid listId,
            string listIdN,
            User owner,
            IReadOnlyList<Guid> items,
            string? anchor,
            List<string> desired,
            IReadOnlyList<string> inserted)
        {
            var ownerVisible = new Dictionary<Guid, bool>();
            bool VisibleToOwner(string token)
            {
                if (!ListPlaceholderOrder.TryParseReal(token, out var itemId, out _))
                {
                    return false;
                }

                if (!ownerVisible.TryGetValue(itemId, out var visible))
                {
                    try
                    {
                        visible = host.IsEntryVisible(itemId, owner);
                    }
                    catch (Exception ex)
                    {
                        logger.Debug($"[ListPlaceholders] Visibility check failed for {itemId:N}: {ex.Message}");
                        visible = false;
                    }

                    ownerVisible[itemId] = visible;
                }

                return visible;
            }

            if (host.SupportsPositionalInsert)
            {
                var position = ListPlaceholderOrder.RawInsertPosition(host.GetRawEntries(listId), anchor);
                await host.AddToPlaylistAsync(listId, items, position, owner.Id).ConfigureAwait(false);
            }
            else
            {
                await host.AddToPlaylistAsync(listId, items, null, owner.Id).ConfigureAwait(false);
                var current = ListPlaceholderOrder.BuildRealTokens(host.GetRawEntries(listId));
                var previous = anchor;
                foreach (var token in inserted)
                {
                    if (!current.Contains(token))
                    {
                        continue; // Jellyfin dropped it; the verification below settles the order
                    }

                    var target = current.Where(t => t != token).ToList();
                    target.Insert(previous == null ? 0 : target.IndexOf(previous) + 1, token);
                    var newIndex = ListPlaceholderOrder.VisibleMoveIndex(target, token, VisibleToOwner);
                    if (newIndex != ListPlaceholderOrder.VisibleMoveIndex(current, token, VisibleToOwner))
                    {
                        ListPlaceholderOrder.TryParseReal(token, out var itemId, out _);
                        await host.MoveInPlaylistAsync(listId, itemId, newIndex, owner.Id).ConfigureAwait(false);
                        current = ListPlaceholderOrder.BuildRealTokens(host.GetRawEntries(listId));
                    }

                    previous = token;
                }
            }

            var actual = ListPlaceholderOrder.BuildRealTokens(host.GetRawEntries(listId));
            var desiredReal = desired.Where(ListPlaceholderOrder.IsReal).ToList();
            if (!actual.SequenceEqual(desiredReal, StringComparer.Ordinal) && items.Count == 1 && actual.Contains(inserted[0])
                && !FollowsAnchor(actual, inserted[0], anchor) && (anchor == null || actual.Contains(anchor)))
            {
                // One misplaced item: move it right after its anchor in Jellyfin's CURRENT rows (a native edit may have
                // landed since the insert, so JE's pre-insert view can't give the index).
                var target = actual.Where(t => t != inserted[0]).ToList();
                target.Insert(anchor == null ? 0 : target.IndexOf(anchor) + 1, inserted[0]);
                var newIndex = ListPlaceholderOrder.VisibleMoveIndex(target, inserted[0], VisibleToOwner);
                await host.MoveInPlaylistAsync(listId, items[0], newIndex, owner.Id).ConfigureAwait(false);
                actual = ListPlaceholderOrder.BuildRealTokens(host.GetRawEntries(listId));
            }

            if (actual.SequenceEqual(desiredReal, StringComparer.Ordinal))
            {
                return desired;
            }

            if (items.Count == 1 && FollowsAnchor(actual, inserted[0], anchor))
            {
                // The item is where asked; the rest of the difference is someone else's edit meanwhile.
                logger.Debug($"[ListPlaceholders] List {listIdN} changed while new entries were placed; keeping Jellyfin's order.");
            }
            else
            {
                logger.Warning($"[ListPlaceholders] Jellyfin placed new entries of list {listIdN} differently than requested; keeping Jellyfin's order.");
            }

            return ListPlaceholderOrder.Reconcile(desired, actual, desired.Select(ListPlaceholderOrder.PlaceholderIdOf).OfType<string>().ToList());
        }

        // Whether `token` directly follows `anchor` in a real-token order (anchor null = first).
        private static bool FollowsAnchor(IReadOnlyList<string> order, string token, string? anchor)
        {
            var index = order.ToList().IndexOf(token);
            return index >= 0 && (anchor == null ? index == 0 : index > 0 && string.Equals(order[index - 1], anchor, StringComparison.Ordinal));
        }
    }
}
