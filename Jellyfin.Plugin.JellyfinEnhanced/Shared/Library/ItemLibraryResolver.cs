using System;
using System.Collections.Generic;
using System.Linq;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;

namespace Jellyfin.Plugin.JellyfinEnhanced.Shared.Library
{
    /// <summary>
    /// The library (top-level collection folder / virtual folder) an item sits
    /// in, as the tag look rules match it: the id /UserViews lists for that
    /// library, in N format. Seasons and episodes answer for their series, so
    /// one lookup serves a whole show.
    /// </summary>
    public static class ItemLibraryResolver
    {
        /// <summary>
        /// The library id of an item in N format, or null when it is in none
        /// (or the lookup fails). An item in several libraries (two libraries
        /// sharing a path) takes the first Jellyfin reports.
        /// </summary>
        /// <param name="libraryManager">Jellyfin's library manager.</param>
        /// <param name="item">The item.</param>
        /// <param name="series">The item's series when it is a Season/Episode and the caller already has it.</param>
        /// <param name="memo">Optional per-batch memo keyed by series id (episodes of one show share it).</param>
        public static string? Resolve(ILibraryManager libraryManager, BaseItem item, BaseItem? series = null, IDictionary<Guid, string?>? memo = null)
        {
            ArgumentNullException.ThrowIfNull(libraryManager);
            ArgumentNullException.ThrowIfNull(item);
            try
            {
                var seriesId = item switch
                {
                    MediaBrowser.Controller.Entities.TV.Episode e => e.SeriesId,
                    MediaBrowser.Controller.Entities.TV.Season s => s.SeriesId,
                    _ => Guid.Empty,
                };
                if (seriesId != Guid.Empty && memo != null && memo.TryGetValue(seriesId, out var known))
                {
                    return known;
                }

                var source = item;
                if (seriesId != Guid.Empty)
                {
                    source = series ?? libraryManager.GetItemById<BaseItem>(seriesId) ?? item;
                }

                var folder = libraryManager.GetCollectionFolders(source)?.FirstOrDefault();
                var id = folder == null || folder.Id == Guid.Empty ? null : folder.Id.ToString("N");
                if (seriesId != Guid.Empty && memo != null)
                {
                    memo[seriesId] = id;
                }

                return id;
            }
            catch
            {
                // A library lookup must never fail an entry: rules on the
                // library just don't match it.
                return null;
            }
        }
    }
}
