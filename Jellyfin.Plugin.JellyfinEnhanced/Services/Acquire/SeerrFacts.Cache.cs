using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Backends;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire
{
    public sealed partial class SeerrFacts
    {
        /// <summary>A cache handle, never a raw dictionary. Stored epochs and every hit go through Access.</summary>
        internal sealed class Cache<T> : IEnumerable<KeyValuePair<string, T>>, IDictionary
        {
            private readonly Dictionary<string, (long Epoch, UserCacheRegistry.Entry<Derived<T>> Facts)> _entries = new(StringComparer.Ordinal);
            private readonly EffectiveRequestsBackend _owner;
            internal Cache(EffectiveRequestsBackend? owner = null) { _owner = owner ?? EffectiveRequestsBackend.Shared; }
            public bool TryGetValue(string key, out T value)
            {
                EvictOldFacts();
                T found = default!;
                var hit = _owner.Facts.Cached(() =>
                {
                    lock (_entries)
                    {
                        if (!_entries.TryGetValue(key, out var entry) || !UserCacheRegistry.Current(entry.Facts.Ticket) || !_owner.CheckSeerr(SeerrUse.RequestRead, entry.Epoch).Allowed) { _entries.Remove(key); return false; }
                        _owner.Facts.Include(entry.Epoch);
                        if (!entry.Facts.Value.TryRead(out found)) return false;
                        return true;
                    }
                }, false);
                value = found;
                return hit;
            }
            public T this[string key]
            {
                get => TryGetValue(key, out var value) ? value : throw new KeyNotFoundException();
                set
                {
                    var generation = UserCacheRegistry.Begin();
                    var epoch = _owner.CheckSeerr(SeerrUse.RequestRead); epoch.Demand();
                    _owner.Facts.Publish(epoch.Epoch, () => { lock (_entries) if (UserCacheRegistry.Current(generation)) _entries[key] = (epoch.Epoch, UserCacheRegistry.Store(generation, Remember(value))); return true; });
                }
            }
            public T GetOrAdd(string key, Func<string, T> create)
            {
                // Match ConcurrentDictionary: callbacks run outside its lock and may race.
                if (TryGetValue(key, out var value)) return value;
                var generation = UserCacheRegistry.Begin();
                var epoch = _owner.CheckSeerr(SeerrUse.RequestRead); epoch.Demand();
                value = create(key);
                return _owner.Facts.Publish(epoch.Epoch, () =>
                {
                    lock (_entries)
                    {
                        if (TryGetValue(key, out var existing)) return existing;
                        if (UserCacheRegistry.Current(generation)) _entries[key] = (epoch.Epoch, UserCacheRegistry.Store(generation, Remember(value)));
                        return value;
                    }
                });
            }
            public bool Remove(string key) { lock (_entries) return _entries.Remove(key); }
            public bool TryRemove(string key, out T value)
            {
                T removed = default!;
                var result = _owner.Facts.Cached(() => { lock (_entries) { if (!_entries.Remove(key, out var entry) || !_owner.CheckSeerr(SeerrUse.RequestRead, entry.Epoch).Allowed) return false; if (!UserCacheRegistry.Current(entry.Facts.Ticket) || !entry.Facts.Value.TryRead(out removed)) return false; return true; } }, false);
                value = removed; return result;
            }
            public bool TryRemove(KeyValuePair<string, T> pair)
            { lock (_entries) return _entries.TryGetValue(pair.Key, out var entry) && entry.Facts.Value.TryRead(out var value) && EqualityComparer<T>.Default.Equals(pair.Value, value) && _entries.Remove(pair.Key); }
            public void Clear() { lock (_entries) _entries.Clear(); }
            public int Count => Snapshot().Count;
            public IEnumerable<string> Keys => Snapshot().Select(e => e.Key);
            private void EvictOldFacts()
            {
                lock (_entries)
                    foreach (var key in _entries.Where(e => !UserCacheRegistry.Current(e.Value.Facts.Ticket)).Select(e => e.Key).ToArray()) _entries.Remove(key);
            }
            private List<KeyValuePair<string, T>> Snapshot()
            {
                EvictOldFacts();
                return _owner.Facts.Cached(() =>
            {
                lock (_entries) return _entries.Where(e => UserCacheRegistry.Current(e.Value.Facts.Ticket) && _owner.CheckSeerr(SeerrUse.RequestRead, e.Value.Epoch).Allowed).Select(e => new KeyValuePair<string, T>(e.Key, e.Value.Facts.Value.Read(default!))).ToList();
            }, new List<KeyValuePair<string, T>>());
            }
            public IEnumerator<KeyValuePair<string, T>> GetEnumerator() => Snapshot().GetEnumerator();
            IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
            object? IDictionary.this[object key] { get => TryGetValue((string)key, out var value) ? value : null; set => this[(string)key] = (T)value!; }
            bool IDictionary.IsFixedSize => false;
            bool IDictionary.IsReadOnly => false;
            ICollection IDictionary.Keys => Snapshot().Select(e => e.Key).ToArray();
            ICollection IDictionary.Values => Snapshot().Select(e => e.Value).ToArray();
            void IDictionary.Add(object key, object? value) => this[(string)key] = (T)value!;
            bool IDictionary.Contains(object key) => TryGetValue((string)key, out _);
            void IDictionary.Remove(object key) => Remove((string)key);
            IDictionaryEnumerator IDictionary.GetEnumerator() => new DictionaryEnumerator(Snapshot().ToDictionary(e => e.Key, e => e.Value).GetEnumerator());
            void ICollection.CopyTo(Array array, int index) { foreach (var pair in Snapshot()) array.SetValue(new DictionaryEntry(pair.Key, pair.Value), index++); }
            bool ICollection.IsSynchronized => false;
            object ICollection.SyncRoot => this;
            private sealed class DictionaryEnumerator(IEnumerator<KeyValuePair<string, T>> inner) : IDictionaryEnumerator
            {
                public DictionaryEntry Entry => new(inner.Current.Key, inner.Current.Value);
                public object Key => inner.Current.Key;
                public object? Value => inner.Current.Value;
                public object Current => Entry;
                public bool MoveNext() => inner.MoveNext();
                public void Reset() => inner.Reset();
            }
        }
    }
}
