using System.Collections.Concurrent;
using System.Collections.Generic;

namespace Jellyfin.Plugin.JellyfinEnhanced.Helpers
{
    /// <summary>Registry-owned storage for memoized facts, including prepared values and memory-only peeks.</summary>
    internal sealed class RegisteredCache<TKey, TValue> where TKey : notnull
    {
        private readonly ConcurrentDictionary<TKey, UserCacheRegistry.Entry<TValue>> _entries;
        internal RegisteredCache(IEqualityComparer<TKey>? comparer = null) { _entries = new(comparer ?? EqualityComparer<TKey>.Default); }
        internal UserCacheRegistry.Ticket Begin() => UserCacheRegistry.Begin();
        internal bool TryGetValue(TKey key, out TValue value)
        {
            if (_entries.TryGetValue(key, out var entry))
            {
                if (UserCacheRegistry.TryRead(entry, out value)) return true;
                ((ICollection<KeyValuePair<TKey, UserCacheRegistry.Entry<TValue>>>)_entries).Remove(new(key, entry));
            }
            value = default!;
            return false;
        }
        internal void Set(TKey key, UserCacheRegistry.Ticket ticket, TValue value)
        {
            var entry = UserCacheRegistry.Store(ticket, value);
            if (UserCacheRegistry.Current(ticket)) _entries[key] = entry;
        }
        internal void Clear() => _entries.Clear();
        internal bool TryRemove(TKey key, out TValue value)
        {
            if (_entries.TryRemove(key, out var entry)) return UserCacheRegistry.TryRead(entry, out value);
            value = default!;
            return false;
        }
        internal int Count => _entries.Count;
        internal IEnumerable<KeyValuePair<TKey, TValue>> Snapshot()
        {
            foreach (var key in _entries.Keys) if (TryGetValue(key, out var value)) yield return new(key, value);
        }
    }
}
