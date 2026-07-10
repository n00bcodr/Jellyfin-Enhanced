using System;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Library;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// Monitors library item changes and updates the tag cache incrementally.
    /// Hooks ILibraryManager.ItemAdded, ItemUpdated, and ItemRemoved events.
    /// </summary>
    public class TagCacheMonitor : IDisposable
    {
        private readonly ILibraryManager _libraryManager;
        private readonly TagCacheService _tagCacheService;
        private readonly Logger _logger;

        public TagCacheMonitor(ILibraryManager libraryManager, TagCacheService tagCacheService, Logger logger)
        {
            _libraryManager = libraryManager;
            _tagCacheService = tagCacheService;
            _logger = logger;
        }

        /// <summary>
        /// Subscribe to library events. Always subscribes regardless of cache state
        /// so no events are missed between startup and first cache build.
        /// </summary>
        public void Initialize()
        {
            _libraryManager.ItemAdded += OnItemChanged;
            _libraryManager.ItemUpdated += OnItemChanged;
            _libraryManager.ItemRemoved += OnItemRemoved;
            _logger.Info("[TagCacheMonitor] Subscribed to ItemAdded, ItemUpdated, and ItemRemoved events");
        }

        /// <summary>
        /// Re-subscribe after a full cache rebuild (ensures no double-subscription).
        /// </summary>
        public void EnsureSubscribed()
        {
            _libraryManager.ItemAdded -= OnItemChanged;
            _libraryManager.ItemUpdated -= OnItemChanged;
            _libraryManager.ItemRemoved -= OnItemRemoved;

            _libraryManager.ItemAdded += OnItemChanged;
            _libraryManager.ItemUpdated += OnItemChanged;
            _libraryManager.ItemRemoved += OnItemRemoved;
            _logger.Info("[TagCacheMonitor] Event subscriptions active");
        }

        private void OnItemChanged(object? sender, ItemChangeEventArgs e)
        {
            var item = e.Item;
            if (item == null) return;

            var kind = item.GetBaseItemKind();
            if (!TagCacheService.TaggableTypes.Contains(kind)) return;

            // Only record ids here — no DB query, no media probe. Jellyfin raises
            // these events synchronously on the library-scan thread (once per item, many times
            // during a scan), so the heavy BuildEntryForItem work is coalesced and run
            // off-thread by the service. See TagCacheService.EnqueueUpdate.
            _tagCacheService.EnqueueUpdate(item.Id);

            // An episode change can alter its parent Series/Season derived data
            // (first-episode genres/streams/ratings), so queue those too. SeriesId and
            // SeasonId are in-memory properties, so reading them costs nothing and never
            // touches the database. Empty guids are ignored by EnqueueUpdate.
            if (kind == BaseItemKind.Episode && item is MediaBrowser.Controller.Entities.TV.Episode ep)
            {
                _tagCacheService.EnqueueUpdate(ep.SeriesId);
                _tagCacheService.EnqueueUpdate(ep.SeasonId);
            }
        }

        private void OnItemRemoved(object? sender, ItemChangeEventArgs e)
        {
            if (e.Item == null) return;
            _tagCacheService.EnqueueRemoval(e.Item.Id);
        }

        public void Dispose()
        {
            _libraryManager.ItemAdded -= OnItemChanged;
            _libraryManager.ItemUpdated -= OnItemChanged;
            _libraryManager.ItemRemoved -= OnItemRemoved;
        }
    }
}
