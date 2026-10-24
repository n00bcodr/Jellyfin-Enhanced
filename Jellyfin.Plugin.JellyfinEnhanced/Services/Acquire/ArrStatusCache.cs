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
        private readonly Dictionary<string, LinkedListNode<(string Key, SeerrFacts.Derived<StatusBody> Body, int Bytes)>> _map = new(StringComparer.Ordinal);
        private readonly LinkedList<(string Key, SeerrFacts.Derived<StatusBody> Body, int Bytes)> _lru = new();
        private readonly int _maxEntries;
        private readonly long _maxBytes;
        private long _bytes;

        /// <summary>A cache of at most <paramref name="maxEntries"/> bodies and <paramref name="maxBytes"/> bytes.</summary>
        public ArrStatusCache(int maxEntries = 4096, long maxBytes = 32L * 1024 * 1024)
        {
            _maxEntries = Math.Max(1, maxEntries);
            _maxBytes = Math.Max(1024, maxBytes);
        }

        /// <summary>Bodies held.</summary>
        public int Count
        {
            get { lock (_lock) return _map.Count; }
        }

        /// <summary>The cached body for a key, or null.</summary>
        public StatusBody? Get(string key)
        {
            SeerrFacts.Derived<StatusBody> held;
            lock (_lock)
            {
                if (!_map.TryGetValue(key, out var node)) return null;
                _lru.Remove(node);
                _lru.AddFirst(node);
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
            var body = new StatusBody(json, ETagFor(key, json));
            var captured = SeerrFacts.Remember(body);
            if (CopyLookupBound.Reached) return captured.Publish();
            lock (_lock)
            {
                if (_map.TryGetValue(key, out var existing))
                {
                    _bytes -= existing.Value.Bytes;
                    _lru.Remove(existing);
                    _map.Remove(key);
                }
                var node = _lru.AddFirst((key, captured, json.Length));
                _map[key] = node;
                _bytes += json.Length;
                while ((_map.Count > _maxEntries || _bytes > _maxBytes) && _lru.Last is { } last && !ReferenceEquals(last, node))
                {
                    _lru.RemoveLast();
                    _map.Remove(last.Value.Key);
                    _bytes -= last.Value.Bytes;
                }
            }
            return captured.Publish();
        }

        /// <summary>Drops everything (configuration saved).</summary>
        public void Clear()
        {
            lock (_lock)
            {
                _map.Clear();
                _lru.Clear();
                _bytes = 0;
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
    }
}
