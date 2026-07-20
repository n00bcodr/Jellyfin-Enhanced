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
        private volatile bool _disposed;

        // Serializes subscribe/unsubscribe against each other and against
        // Dispose: without it, an EnsureSubscribed that passed the disposed
        // check could re-attach handlers after Dispose already detached them
        // (leaking a live monitor), and two concurrent EnsureSubscribed calls
        // could interleave their -=/+= pairs into a double subscription.
        private readonly object _subscriptionLock = new();

        public TagCacheMonitor(ILibraryManager libraryManager, TagCacheService tagCacheService, Logger logger)
        {
            _libraryManager = libraryManager;
            _tagCacheService = tagCacheService;
            _logger = logger;

            // DI singleton, exposed for the plugin's config-save transition hook
            // (see TagCacheService.Instance for the rationale).
            Instance = this;
        }

        /// <summary>
        /// The running singleton, used by the server-mode transition queue in
        /// <see cref="TagCacheService"/> to re-subscribe on re-enable.
        /// </summary>
        internal static TagCacheMonitor? Instance { get; private set; }

        /// <summary>
        /// Subscribe to library events. Always subscribes regardless of cache state
        /// so no events are missed between startup and first cache build.
        /// </summary>
        public void Initialize()
        {
            // Same idempotent -=/+= as EnsureSubscribed: a bare += here could
            // double-subscribe if a transition's EnsureSubscribed completed
            // during startup's disk-load window (Dispose removes only one
            // occurrence per handler, so a duplicate would outlive teardown).
            EnsureSubscribed();
        }

        /// <summary>
        /// Idempotently (re)attach the library event handlers — the -= before +=
        /// guarantees exactly one subscription no matter how often or from where
        /// this is called (startup, the daily task, re-enable transitions).
        /// </summary>
        public void EnsureSubscribed()
        {
            lock (_subscriptionLock)
            {
                // A queued re-enable transition can land during teardown;
                // subscribing then would leak live handlers on a disposed
                // monitor. Checked under the lock so Dispose can't slip between
                // the check and the re-subscribe.
                if (_disposed) return;

                _libraryManager.ItemAdded -= OnItemChanged;
                _libraryManager.ItemUpdated -= OnItemChanged;
                _libraryManager.ItemRemoved -= OnItemRemoved;

                _libraryManager.ItemAdded += OnItemChanged;
                _libraryManager.ItemUpdated += OnItemChanged;
                _libraryManager.ItemRemoved += OnItemRemoved;
            }

            _logger.Info("[TagCacheMonitor] Event subscriptions active");
        }

        private void OnItemChanged(object? sender, ItemChangeEventArgs e)
        {
            // If the admin disabled the Server-Side Tag Cache after these handlers
            // were subscribed, stop maintaining the cache: it has been released and
            // the endpoint is 404 while the setting is off, so incremental
            // rebuilds/disk saves would be wasted work. The re-enable transition
            // reconciles by item save timestamps, which covers events skipped here.
            if (JellyfinEnhanced.Instance?.Configuration?.TagCacheServerMode != true) return;

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
            // Same gate as OnItemChanged: no cache maintenance while the
            // Server-Side Tag Cache is disabled. Stale removals are swept by the
            // re-enable transition's live-id reconciliation.
            if (JellyfinEnhanced.Instance?.Configuration?.TagCacheServerMode != true) return;

            var item = e.Item;
            if (item == null) return;
            _tagCacheService.EnqueueRemoval(item.Id);

            // Parent Series/Season entries derive data from their first episode
            // (streams, genres, ratings), so removing an episode must requeue the
            // parents just like changing one does — otherwise their cached entries
            // keep reflecting the deleted file until something else touches them.
            if (item is MediaBrowser.Controller.Entities.TV.Episode ep)
            {
                _tagCacheService.EnqueueUpdate(ep.SeriesId);
                _tagCacheService.EnqueueUpdate(ep.SeasonId);
            }
            else if (item is MediaBrowser.Controller.Entities.TV.Season season)
            {
                _tagCacheService.EnqueueUpdate(season.SeriesId);
            }
        }

        public void Dispose()
        {
            lock (_subscriptionLock)
            {
                _disposed = true;

                _libraryManager.ItemAdded -= OnItemChanged;
                _libraryManager.ItemUpdated -= OnItemChanged;
                _libraryManager.ItemRemoved -= OnItemRemoved;
            }

            if (ReferenceEquals(Instance, this))
            {
                Instance = null;
            }
        }
    }
}
