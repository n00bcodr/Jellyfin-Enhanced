using System;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Entities;
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

            try
            {
                _tagCacheService.UpdateItem(item);

                // If an episode changed, update its parent Series and Season too
                // (first-episode data may have changed)
                if (kind == BaseItemKind.Episode && item is MediaBrowser.Controller.Entities.TV.Episode ep)
                {
                    if (ep.SeriesId != Guid.Empty)
                    {
                        var series = _libraryManager.GetItemById<BaseItem>(ep.SeriesId);
                        if (series != null) _tagCacheService.UpdateItem(series);
                    }
                    if (ep.SeasonId != Guid.Empty)
                    {
                        var season = _libraryManager.GetItemById<BaseItem>(ep.SeasonId);
                        if (season != null) _tagCacheService.UpdateItem(season);
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.Warning($"[TagCacheMonitor] Error updating cache for {item.Id}: {ex.Message}");
            }
        }

        private void OnItemRemoved(object? sender, ItemChangeEventArgs e)
        {
            if (e.Item == null) return;
            try
            {
                _tagCacheService.RemoveItem(e.Item.Id);
            }
            catch (Exception ex)
            {
                _logger.Warning($"[TagCacheMonitor] Error removing {e.Item.Id} from cache: {ex.Message}");
            }
        }

        public void Dispose()
        {
            _libraryManager.ItemAdded -= OnItemChanged;
            _libraryManager.ItemUpdated -= OnItemChanged;
            _libraryManager.ItemRemoved -= OnItemRemoved;
        }
    }
}
