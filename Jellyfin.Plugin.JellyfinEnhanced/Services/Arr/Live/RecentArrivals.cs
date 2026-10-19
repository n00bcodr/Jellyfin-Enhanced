using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Arr.Live
{
    /// <summary>
    /// The Jellyfin items added in the last few minutes, whose first metadata updates still count
    /// as part of their arrival (a new movie gets its provider ids, a new episode its numbers, only
    /// when its metadata is read). Bounded: past the cap the entries older than the window go first,
    /// then the oldest tenth, so a busy library scan never drops the newest arrivals all at once.
    /// Safe to use from Jellyfin's scanner threads.
    /// </summary>
    internal sealed class RecentArrivals
    {
        private readonly ConcurrentDictionary<Guid, DateTimeOffset> _added = new();
        private readonly object _evict = new();
        private readonly TimeSpan _window;
        private readonly int _cap;
        private readonly Func<DateTimeOffset> _now;

        /// <summary>How long a new movie or episode stays a fresh arrival (its updates may still be part of it).</summary>
        public static readonly TimeSpan FreshFor = TimeSpan.FromDays(3);

        /// <summary>
        /// A movie or episode Jellyfin created within <see cref="FreshFor"/>: its update can still be part of its
        /// arrival after the window, because Jellyfin can read a file's dimensions (and so a 4K copy's edition) late.
        /// An old item's metadata refresh is not.
        /// </summary>
        /// <param name="item">The updated item.</param>
        /// <param name="now">Now.</param>
        /// <returns>True for a fresh movie or episode.</returns>
        public static bool FreshVideo(MediaBrowser.Controller.Entities.BaseItem? item, DateTimeOffset now)
        {
            if (item is not (MediaBrowser.Controller.Entities.Movies.Movie or MediaBrowser.Controller.Entities.TV.Episode) || item.DateCreated == DateTime.MinValue) return false;
            var created = item.DateCreated.Kind == DateTimeKind.Local ? item.DateCreated.ToUniversalTime() : DateTime.SpecifyKind(item.DateCreated, DateTimeKind.Utc);
            var age = now.UtcDateTime - created;
            return age >= TimeSpan.Zero && age <= FreshFor;
        }

        /// <summary>Creates the tracker.</summary>
        /// <param name="window">How long after being added an item's updates still count.</param>
        /// <param name="cap">Most items held.</param>
        /// <param name="now">The clock.</param>
        public RecentArrivals(TimeSpan window, int cap, Func<DateTimeOffset>? now = null)
        {
            _window = window;
            _cap = Math.Max(10, cap);
            _now = now ?? (() => DateTimeOffset.UtcNow);
        }

        /// <summary>Items held (tests, diagnostics).</summary>
        public int Count => _added.Count;

        /// <summary>Records that an item was just added (making room first when full).</summary>
        public void Add(Guid itemId)
        {
            if (_added.Count >= _cap && !_added.ContainsKey(itemId)) MakeRoom();
            _added[itemId] = _now();
        }

        /// <summary>
        /// True when the item was added within the window: its update is part of its arrival. An
        /// entry found past its window is dropped.
        /// </summary>
        public bool IsRecent(Guid itemId)
        {
            if (!_added.TryGetValue(itemId, out var at)) return false;
            if (_now() - at <= _window) return true;
            _added.TryRemove(new KeyValuePair<Guid, DateTimeOffset>(itemId, at));
            return false;
        }

        /// <summary>Drops the entries past the window; returns how many went.</summary>
        public int Prune()
        {
            var cutoff = _now() - _window;
            var removed = 0;
            foreach (var entry in _added)
            {
                if (entry.Value < cutoff && _added.TryRemove(entry)) removed++;
            }
            return removed;
        }

        // Full: the stale entries first; when every entry is fresh, the oldest tenth.
        private void MakeRoom()
        {
            lock (_evict)
            {
                if (_added.Count < _cap) return;
                Prune();
                if (_added.Count < _cap) return;
                var drop = Math.Max(1, _added.Count / 10);
                foreach (var entry in _added.ToArray().OrderBy(e => e.Value).Take(drop)) _added.TryRemove(entry);
            }
        }
    }
}
