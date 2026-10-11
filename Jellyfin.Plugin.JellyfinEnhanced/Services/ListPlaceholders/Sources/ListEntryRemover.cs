using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Model.ListPlaceholders;
using MediaBrowser.Controller.Collections;
using MediaBrowser.Controller.Playlists;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.ListPlaceholders.Sources
{
    /// <summary>Removes real entries from a list (linked-list sync, removeDropped). Seam for tests.</summary>
    public interface IListEntryRemover
    {
        /// <summary>
        /// Removes items from a playlist (every copy of each id — callers only pass single-copy items) or a collection.
        /// Jellyfin rewrites a playlist from the entries it can resolve, so its unresolved entries go too: callers don't
        /// remove from a playlist that has any (<see cref="ListSourceProvenance.RecheckItemDrops"/>).
        /// </summary>
        /// <param name="list">The list.</param>
        /// <param name="itemIds">Items.</param>
        /// <returns>A task.</returns>
        Task RemoveAsync(ListInfo list, IReadOnlyList<Guid> itemIds);
    }

    /// <summary>Production remover over Jellyfin's playlist and collection managers (same API on 10.11 and 12).</summary>
    public sealed class JellyfinListEntryRemover : IListEntryRemover
    {
        private readonly IPlaylistManager _playlistManager;
        private readonly ICollectionManager _collectionManager;

        /// <summary>Creates the remover.</summary>
        /// <param name="playlistManager">Playlist manager.</param>
        /// <param name="collectionManager">Collection manager.</param>
        public JellyfinListEntryRemover(IPlaylistManager playlistManager, ICollectionManager collectionManager)
        {
            _playlistManager = playlistManager;
            _collectionManager = collectionManager;
        }

        /// <inheritdoc />
        public Task RemoveAsync(ListInfo list, IReadOnlyList<Guid> itemIds)
        {
            if (itemIds.Count == 0)
            {
                return Task.CompletedTask;
            }

            // A playlist entry id is the item id ("N"); removing it removes every copy of that item.
            return list.Kind == ListKinds.Playlist
                ? _playlistManager.RemoveItemFromPlaylistAsync(list.Id.ToString("N", CultureInfo.InvariantCulture), itemIds.Select(id => id.ToString("N", CultureInfo.InvariantCulture)).ToList())
                : _collectionManager.RemoveFromCollectionAsync(list.Id, itemIds.ToList());
        }
    }
}
