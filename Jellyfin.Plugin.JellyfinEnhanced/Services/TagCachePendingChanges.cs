using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services
{
    /// <summary>
    /// Thread-safe, coalescing set of pending tag-cache changes.
    ///
    /// Jellyfin raises ItemAdded/ItemUpdated/ItemRemoved synchronously on the
    /// library-scan thread, once per item — and, for episodes, the monitor also
    /// targets the parent Series and Season — so a single TV scan can name the
    /// same parent id hundreds of times. Recording is O(1) and last-write-wins per
    /// id, so a burst collapses to one entry per id; <see cref="Drain"/> then hands
    /// the background worker exactly one unit of work per distinct id instead of one
    /// per event. This is what keeps the heavy per-item rebuild off the scan thread.
    /// </summary>
    internal sealed class TagCachePendingChanges
    {
        // id -> true when the last observed change was a removal, false for an add/update.
        private readonly ConcurrentDictionary<Guid, bool> _pending = new();

        /// <summary>
        /// Record the latest intent for an id. Last write wins, so a removal that
        /// follows an update (or vice-versa) within one window replaces it. Empty
        /// guids (e.g. an episode with no SeasonId) are ignored.
        /// </summary>
        public void Record(Guid id, bool removed)
        {
            if (id == Guid.Empty) return;
            _pending[id] = removed;
        }

        public bool IsEmpty => _pending.IsEmpty;

        public int Count => _pending.Count;

        /// <summary>
        /// Atomically remove and return every pending change. Ids recorded after the
        /// drain begins are left in the set for the next drain (their Record call
        /// re-arms the worker), so no change is lost.
        /// </summary>
        public IReadOnlyList<(Guid Id, bool Removed)> Drain()
        {
            var batch = new List<(Guid, bool)>(_pending.Count);
            foreach (var id in _pending.Keys.ToList())
            {
                if (_pending.TryRemove(id, out var removed))
                {
                    batch.Add((id, removed));
                }
            }

            return batch;
        }
    }
}
