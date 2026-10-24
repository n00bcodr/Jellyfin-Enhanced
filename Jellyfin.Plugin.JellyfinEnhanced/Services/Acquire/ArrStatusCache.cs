using System;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Text;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire
{
    /// <summary>A serialized status response and its validator.</summary>
    public sealed class StatusBody
    {
        /// <summary>Creates a body.</summary>
        public StatusBody(byte[] json, string etag)
        {
            Json = json;
            ETag = etag;
        }

        /// <summary>UTF-8 JSON.</summary>
        public byte[] Json { get; }

        /// <summary>Quoted strong ETag (hash of the per-user cache key and the body).</summary>
        public string ETag { get; }
    }

    /// <summary>
    /// Per-user cache of composed status bodies. Bodies are never shared between users: the key
    /// always starts with the user id and the user's policy revision (role, library access, parental
    /// settings), and the ETag hashes that key together with the body, so two users with the same
    /// library access but different roles get different ETags even for identical bytes. Bounded
    /// (entries and bytes), least recently used out first.
    /// </summary>
    public sealed class ArrStatusCache
    {
        private readonly object _lock = new();
        private Dictionary<string, LinkedListNode<(string Key, SeerrFacts.Derived<StatusBody> Body, int Bytes)>> _map = new(StringComparer.Ordinal);
        private LinkedList<(string Key, SeerrFacts.Derived<StatusBody> Body, int Bytes)> _lru = new();
        private readonly int _maxEntries;
        private readonly long _maxBytes;
        private long _bytes;
        private readonly Helpers.UserCacheRegistry.State<long> _bytesFactsOwner = new();
        private long _bytesFacts { get => _bytesFactsOwner.Read(ref _bytes, () => 0); set => _bytesFactsOwner.Store(ref _bytes, value); }

        /// <summary>A cache of at most <paramref name="maxEntries"/> bodies and <paramref name="maxBytes"/> bytes.</summary>
        public ArrStatusCache(int maxEntries = 4096, long maxBytes = 32L * 1024 * 1024)
        {
            _maxEntries = Math.Max(1, maxEntries);
            _maxBytes = Math.Max(1024, maxBytes);
        }

        /// <summary>Bodies held.</summary>
        public int Count
        {
            get
            {
                using var __factsOperation0 = global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.BeginOperation();
                lock (_lock) return _mapFacts.Count;
            }
        }

        /// <summary>The cached body for a key, or null.</summary>
        public StatusBody? Get(string key)
        {
            using var __factsOperation1 = global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.BeginOperation();
            SeerrFacts.Derived<StatusBody> held;
            lock (_lock)
            {
                if (!_mapFacts.TryGetValue(key, out var node)) return null;
                _lruFacts.Remove(node);
                _lruFacts.AddFirst(node);
                held = node.Value.Body;
            }
            return held.TryRead(out var body) ? body : null;
        }

        /// <summary>
        /// Stores a body (the ETag is computed from the key and the bytes) and returns it. A body composed from a copy
        /// lookup that reached its scan bound (<see cref="CopyLookupBound"/>) is returned with the same ETag but not kept,
        /// so the next read scans again.
        /// </summary>
        public StatusBody Put(string key, byte[] json)
        {
            using var __factsOperation2 = global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.BeginOperation();
            var body = new StatusBody(json, ETagFor(key, json));
            var captured = SeerrFacts.Remember(body);
            if (CopyLookupBound.Reached) return captured.Publish();
            lock (_lock)
            {
                if (_mapFacts.TryGetValue(key, out var existing))
                {
                    _bytesFacts -= existing.Value.Bytes;
                    _lruFacts.Remove(existing);
                    _mapFacts.Remove(key);
                }
                var node = _lruFacts.AddFirst((key, captured, json.Length));
                _mapFacts[key] = node;
                _bytesFacts += json.Length;
                while ((_mapFacts.Count > _maxEntries || _bytesFacts > _maxBytes) && _lruFacts.Last is { } last && !ReferenceEquals(last, node))
                {
                    _lruFacts.RemoveLast();
                    _mapFacts.Remove(last.Value.Key);
                    _bytesFacts -= last.Value.Bytes;
                }
            }
            return captured.Publish();
        }

        /// <summary>Drops everything (configuration saved).</summary>
        public void Clear()
        {
            using var __factsOperation3 = global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.BeginOperation();
            lock (_lock)
            {
                _mapFacts.Clear();
                _lruFacts.Clear();
                _bytesFacts = 0;
            }
        }

        /// <summary>The ETag of a body under a key.</summary>
        internal static string ETagFor(string key, byte[] json)
        {
            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            hash.AppendData(Encoding.UTF8.GetBytes(key));
            hash.AppendData(new byte[] { 0 });
            hash.AppendData(json);
            return "\"" + Convert.ToHexString(hash.GetHashAndReset(), 0, 16) + "\"";
        }
        private readonly global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.State<Dictionary<string, LinkedListNode<(string Key, SeerrFacts.Derived<StatusBody> Body, int Bytes)>>> _mapFactsOwner = new();
        private Dictionary<string, LinkedListNode<(string Key, SeerrFacts.Derived<StatusBody> Body, int Bytes)>> _mapFacts { get => _mapFactsOwner.Read(ref _map, () => new(StringComparer.Ordinal)); set => _mapFactsOwner.Store(ref _map, value); }
        private readonly global::Jellyfin.Plugin.JellyfinEnhanced.Helpers.UserCacheRegistry.State<LinkedList<(string Key, SeerrFacts.Derived<StatusBody> Body, int Bytes)>> _lruFactsOwner = new();
        private LinkedList<(string Key, SeerrFacts.Derived<StatusBody> Body, int Bytes)> _lruFacts { get => _lruFactsOwner.Read(ref _lru, () => new()); set => _lruFactsOwner.Store(ref _lru, value); }
    }
}
