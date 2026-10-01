using System;
using System.Collections.Generic;
using SkiaSharp;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Rendering
{
    /// <summary>
    /// Byte-bounded LRU of pre-rendered tag tiles (a chip with its blurred shadow, a flag with its clip and outline).
    /// Most posters of one size share their chips, so a warm cache turns every tag into a single blit. Entries are
    /// leased while drawn: eviction never disposes an image another thread is still drawing.
    /// </summary>
    internal sealed class PosterTagTileCache : IDisposable
    {
        // Rough cost of an entry besides its pixels: the node, its LRU link, the map slot and the key strings'
        // object headers (the strings' characters are charged separately).
        private const long EntryOverheadBytes = 256;

        private readonly object _gate = new();
        private readonly Dictionary<PosterTagTileKey, Node> _map = new();
        private readonly LinkedList<Node> _lru = new();
        private readonly long _budgetBytes;
        private long _bytes;
        private bool _disposed;

        public PosterTagTileCache(long budgetBytes)
        {
            _budgetBytes = Math.Max(0, budgetBytes);
        }

        /// <summary>Bytes held by cached tiles (for diagnostics and tests).</summary>
        public long Bytes
        {
            get
            {
                lock (_gate)
                {
                    return _bytes;
                }
            }
        }

        public int Count
        {
            get
            {
                lock (_gate)
                {
                    return _map.Count;
                }
            }
        }

        /// <summary>
        /// Returns a lease on the tile for <paramref name="key"/>, rendering it with <paramref name="factory"/> on a miss.
        /// The lease must be disposed once the image has been drawn. Its image is null when the factory returned null.
        /// </summary>
        public Lease Rent<TState>(in PosterTagTileKey key, TState state, Func<TState, SKImage?> factory)
        {
            lock (_gate)
            {
                ObjectDisposedException.ThrowIf(_disposed, this);
                if (_map.TryGetValue(key, out var hit))
                {
                    hit.Leases++;
                    _lru.Remove(hit.LruNode);
                    _lru.AddFirst(hit.LruNode);
                    return new Lease(this, hit);
                }
            }

            var image = factory(state);
            if (image is null)
            {
                return default;
            }

            long size = ((long)image.Width * image.Height * 4) + EntryOverheadBytes + (2L * (key.Text.Length + key.Style.Length));
            var node = new Node(key, image, size) { Leases = 1 };
            lock (_gate)
            {
                if (_disposed || size > _budgetBytes)
                {
                    // Not cacheable: the lease owns the image and disposes it on release.
                    node.Evicted = true;
                    return new Lease(this, node);
                }

                if (_map.TryGetValue(key, out var raced))
                {
                    // Another thread rendered the same tile meanwhile; use theirs.
                    image.Dispose();
                    raced.Leases++;
                    return new Lease(this, raced);
                }

                node.LruNode = _lru.AddFirst(node);
                _map[key] = node;
                _bytes += size;
                while (_bytes > _budgetBytes && _lru.Last is { } last && last.Value != node)
                {
                    EvictLocked(last.Value);
                }

                return new Lease(this, node);
            }
        }

        /// <summary>Drops every cached tile (tiles still leased are disposed when released).</summary>
        public void Clear()
        {
            lock (_gate)
            {
                while (_lru.Last is { } last)
                {
                    EvictLocked(last.Value);
                }
            }
        }

        public void Dispose()
        {
            lock (_gate)
            {
                if (_disposed)
                {
                    return;
                }

                _disposed = true;
                while (_lru.Last is { } last)
                {
                    EvictLocked(last.Value);
                }
            }
        }

        private void EvictLocked(Node node)
        {
            _lru.Remove(node.LruNode);
            _map.Remove(node.Key);
            _bytes -= node.Bytes;
            node.Evicted = true;
            if (node.Leases == 0)
            {
                node.Image.Dispose();
            }
        }

        private void Release(Node node)
        {
            lock (_gate)
            {
                node.Leases--;
                if (node.Evicted && node.Leases == 0)
                {
                    node.Image.Dispose();
                }
            }
        }

        /// <summary>A leased tile. Dispose exactly once after drawing.</summary>
        public readonly struct Lease : IDisposable
        {
            private readonly PosterTagTileCache? _owner;
            private readonly Node? _node;

            internal Lease(PosterTagTileCache owner, Node node)
            {
                _owner = owner;
                _node = node;
            }

            public SKImage? Image => _node?.Image;

            public void Dispose() => _owner?.Release(_node!);
        }

        internal sealed class Node
        {
            public Node(PosterTagTileKey key, SKImage image, long bytes)
            {
                Key = key;
                Image = image;
                Bytes = bytes;
                LruNode = null!;
            }

            public PosterTagTileKey Key { get; }

            public SKImage Image { get; }

            public long Bytes { get; }

            public int Leases { get; set; }

            public bool Evicted { get; set; }

            public LinkedListNode<Node> LruNode { get; set; }
        }
    }

    /// <summary>
    /// Identity of a rendered tile: what it shows plus every value its pixels depend on (scale, logical card width,
    /// snapped device size, the sub-pixel phase of its content and, for a box reaching past the image, the part of
    /// the tile that was rasterised).
    /// </summary>
    internal readonly record struct PosterTagTileKey(
        PosterTagTileKind Kind,
        string Text,
        string Style,
        float Scale,
        float CardWidth,
        int DeviceWidth,
        int DeviceHeight,
        int PhaseX,
        int PhaseY,
        SKRectI Crop);

    internal enum PosterTagTileKind
    {
        Quality,
        Genre,
        Rating,
        AgeRating,
        Flag,
    }
}
