using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;

namespace Jellyfin.Plugin.JellyfinEnhanced.Helpers
{
    /// <summary>
    /// A cache of state JE writes itself (a person's Spoiler Guard state, their Hidden Content rules), dropped when it is
    /// written: the ticket protocol of <see cref="InvalidationLedger{TRecord}"/>, the same as <see cref="UserAccessCache{TKey, TValue}"/>'s.
    /// A reader takes <see cref="Begin"/> BEFORE it reads the stored state; a writer calls <see cref="Invalidate"/> after
    /// it writes; a value read before an invalidation of its key is never served, even if it is stored after (a plain
    /// remove-on-write lets a reader that read the old file put it back after the write's remove). Lifetimes are on the
    /// monotonic clock, from the read.
    /// </summary>
    /// <typeparam name="TKey">The key (whose state).</typeparam>
    /// <typeparam name="TValue">The state as read.</typeparam>
    internal sealed class WrittenStateCache<TKey, TValue>
        where TKey : notnull
    {
        private const int MaxInvalidations = 8192;

        private readonly ConcurrentDictionary<TKey, Entry> _entries;
        private readonly InvalidationLedger<TKey> _ledger;
        private readonly TimeSpan _ttl;
        private readonly int _maxEntries;
        private readonly Func<long> _ticks = MonotonicClock.Now;
        private readonly Action<string>? _step;

        /// <summary>Creates the cache.</summary>
        /// <param name="ttl">How long an entry may be served at most, from when it was read.</param>
        /// <param name="maxEntries">How many entries are kept at most.</param>
        /// <param name="comparer">How keys are compared.</param>
        public WrittenStateCache(TimeSpan ttl, int maxEntries, IEqualityComparer<TKey>? comparer = null)
            : this(ttl, maxEntries, comparer, MaxInvalidations, null)
        {
        }

        /// <summary>Creates the cache with a record bound and a hook at each interleaving point (tests).</summary>
        /// <param name="ttl">How long an entry may be served at most, from when it was read.</param>
        /// <param name="maxEntries">How many entries are kept at most.</param>
        /// <param name="comparer">How keys are compared.</param>
        /// <param name="maxInvalidations">How many invalidation records are kept before a rollover.</param>
        /// <param name="step">Called at each interleaving point ("invalidate", "swap", "store").</param>
        internal WrittenStateCache(TimeSpan ttl, int maxEntries, IEqualityComparer<TKey>? comparer, int maxInvalidations, Action<string>? step)
        {
            _ttl = ttl;
            _maxEntries = Math.Max(1, maxEntries);
            _step = step;
            _entries = new ConcurrentDictionary<TKey, Entry>(comparer ?? EqualityComparer<TKey>.Default);
            _ledger = new InvalidationLedger<TKey>(maxInvalidations, comparer, step);
        }

        /// <summary>A read's ticket, taken BEFORE reading the stored state.</summary>
        public readonly struct Ticket
        {
            internal Ticket(long clock, long ticks)
            {
                Clock = clock;
                Ticks = ticks;
            }

            internal long Clock { get; }

            internal long Ticks { get; }
        }

        private sealed record Entry(TValue Value, long ExpiresAt, long Clock);

        /// <summary>Entries held (valid or not yet dropped).</summary>
        public int Count => _entries.Count;

        /// <summary>A ticket: take it before reading the stored state.</summary>
        /// <returns>The ticket.</returns>
        public Ticket Begin() => new(_ledger.Begin(), _ticks());

        /// <summary>The state kept for <paramref name="key"/>, when nothing wrote it since it was read.</summary>
        /// <param name="key">The key.</param>
        /// <param name="value">The state.</param>
        /// <returns>True when served.</returns>
        public bool TryGet(TKey key, out TValue value)
        {
            if (_entries.TryGetValue(key, out var entry) && Serves(key, entry, _ticks()))
            {
                value = entry.Value;
                return true;
            }

            value = default!;
            return false;
        }

        /// <summary>Keeps <paramref name="value"/>, read after <paramref name="ticket"/> was taken (not kept when a write
        /// invalidated it since).</summary>
        /// <param name="key">The key.</param>
        /// <param name="ticket">The ticket taken before the read.</param>
        /// <param name="value">The state as read.</param>
        public void Set(TKey key, in Ticket ticket, TValue value) => Set(key, ticket, value, _ttl);

        /// <summary>Keeps <paramref name="value"/> like <see cref="Set(TKey, in Ticket, TValue)"/>, for at most
        /// <paramref name="life"/> from the ticket (never past the cache's own lifetime): a value worked out from inputs
        /// that end sooner (a source read earlier, a shorter-lived fact) ends with the earliest of them.</summary>
        /// <param name="key">The key.</param>
        /// <param name="ticket">The ticket taken before the read.</param>
        /// <param name="value">The state as read.</param>
        /// <param name="life">How long it may be served, from the ticket.</param>
        public void Set(TKey key, in Ticket ticket, TValue value, TimeSpan life)
        {
            var now = _ticks();
            var entry = new Entry(value, ticket.Ticks + Math.Max(0, Math.Min(_ttl.Ticks, life.Ticks)), ticket.Clock);
            if (!Serves(key, entry, now)) return;
            _step?.Invoke("store");
            if (_entries.Count >= _maxEntries)
            {
                foreach (var held in _entries.ToArray())
                {
                    if (!Serves(held.Key, held.Value, now)) _entries.TryRemove(held.Key, out _);
                }

                if (_entries.Count >= _maxEntries) _entries.Clear();
            }

            _entries[key] = entry;
        }

        /// <summary>The state kept for <paramref name="key"/>, else <paramref name="read"/> kept under a ticket taken
        /// before it ran.</summary>
        /// <param name="key">The key.</param>
        /// <param name="read">Reads the stored state.</param>
        /// <returns>The state.</returns>
        public TValue GetOrRead(TKey key, Func<TValue> read)
        {
            var ticket = Begin();
            if (TryGet(key, out var hit)) return hit;
            var value = read();
            Set(key, ticket, value);
            return value;
        }

        /// <summary>The state of <paramref name="key"/> was written: ends its entry and every read of it running now.</summary>
        /// <param name="key">The key.</param>
        public void Invalidate(TKey key)
        {
            if (_ledger.Invalidate(key)) _entries.Clear();
            else _entries.TryRemove(key, out _);
        }

        /// <summary>Ends every entry, and every read running now.</summary>
        public void InvalidateAll()
        {
            _ledger.InvalidateAll();
            _entries.Clear();
        }

        private bool Serves(TKey key, Entry entry, long now)
        {
            var epoch = _ledger.Current;
            return entry.ExpiresAt > now && epoch.Admits(entry.Clock) && !epoch.Ended(key, entry.Clock);
        }
    }
}
