using System;
using System.Collections.Generic;
using MediaBrowser.Controller.Library;

namespace Jellyfin.Plugin.JellyfinEnhanced.Shared.Library
{
    /// <summary>Library lookups shared by several features (restructure S2.0b, moved verbatim from JellyfinEnhancedController).</summary>
    public sealed class LibraryItemLookup
    {
        private readonly ILibraryManager _libraryManager;
        private readonly Logger _logger;

        public LibraryItemLookup(ILibraryManager libraryManager, Logger logger)
        {
            _libraryManager = libraryManager;
            _logger = logger;
        }

        // Returns the library item matching the TMDB id + media type, filtered by
        // the user's access (null when not found/accessible). Uses HasAnyProviderId
        // so the DB does the matching (indexed) rather than scanning client-side.
        public MediaBrowser.Controller.Entities.BaseItem? FindLibraryItemByTmdb(
            Jellyfin.Database.Implementations.Entities.User user,
            string mediaType,
            string tmdbId)
        {
            var kind = mediaType == "movie"
                ? Jellyfin.Data.Enums.BaseItemKind.Movie
                : Jellyfin.Data.Enums.BaseItemKind.Series;
            try
            {
                var query = new MediaBrowser.Controller.Entities.InternalItemsQuery(user)
                {
                    IncludeItemTypes = new[] { kind },
                    HasAnyProviderId = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
                    {
                        { "Tmdb", tmdbId },
                    },
                    Recursive = true,
                    Limit = 1,
                };
                var items = _libraryManager.GetItemList(query);
                if (items != null && items.Count > 0)
                {
                    return items[0];
                }
            }
            catch (Exception ex)
            {
                _logger.Warning($"FindLibraryItemByTmdb({mediaType}, {tmdbId}) threw {ex.GetType().Name}: {ex.Message}");
            }
            return null;
        }
    }
}
