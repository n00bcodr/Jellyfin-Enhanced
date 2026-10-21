using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Threading;

namespace Jellyfin.Plugin.JellyfinEnhanced.Helpers
{
    /// <summary>
    /// The ticket protocol every cache that is invalidated on a write uses (<see cref="UserAccessCache{TKey, TValue}"/>,
    /// <see cref="WrittenStateCache{TKey, TValue}"/>): a computation takes <see cref="Begin"/> BEFORE it reads what it is
    /// computed from, a writer calls <see cref="Invalidate"/> after it writes, and a value whose ticket predates an
    /// invalidation of its key is never served (even if it is stored after). The records and the floor are one immutable
    /// epoch, replaced whole by a compare-and-swap that succeeds only for the very epoch it read (identity, never
    /// contents: another invalidation can publish an epoch equal to it); a rollover drops only the records it saw, and its
    /// floor covers each of them.
    /// </summary>
    /// <typeparam name="TRecord">What an invalidation names.</typeparam>
    internal sealed class InvalidationLedger<TRecord>
        where TRecord : notnull
    {
        private readonly int _maxRecords;
        private readonly Action<string>? _step;
        private long _clock;
        private Epoch _epoch;

        /// <summary>Creates the ledger.</summary>
        /// <param name="maxRecords">How many records are kept before a rollover ends every ticket begun before it instead.</param>
        /// <param name="comparer">How records are compared.</param>
        /// <param name="step">Called at each point another thread can interleave ("invalidate", "swap"; tests).</param>
        public InvalidationLedger(int maxRecords, IEqualityComparer<TRecord>? comparer = null, Action<string>? step = null)
        {
            _maxRecords = Math.Max(1, maxRecords);
            _step = step;
            _epoch = new Epoch(0, ImmutableDictionary.Create<TRecord, long>(comparer), 0);
        }

        /// <summary>The records and the floor as of now (one moment, for every check of one entry).</summary>
        public Epoch Current => Volatile.Read(ref _epoch);

        /// <summary>A ticket: take it BEFORE reading what the value is computed from.</summary>
        /// <returns>The clock now.</returns>
        public long Begin() => Interlocked.Read(ref _clock);

        /// <summary>Ends every ticket of <paramref name="record"/> begun before now.</summary>
        /// <param name="record">What was written.</param>
        /// <returns>True when the records rolled over (every ticket begun before now ended): the caller drops its entries.</returns>
        public bool Invalidate(TRecord record)
        {
            var at = Interlocked.Increment(ref _clock);
            _step?.Invoke("invalidate");
            while (true)
            {
                var was = Volatile.Read(ref _epoch);
                // Too many records: every ticket begun before any of them (or this one) ends instead.
                var rolled = was.Records.Count >= _maxRecords;
                var next = rolled ? was.Rolled(at) : was.With(record, at);
                _step?.Invoke("swap");
                // Published only if the epoch it read is still the one in place (by identity).
                if (ReferenceEquals(Interlocked.CompareExchange(ref _epoch, next, was), was)) return rolled;
            }
        }

        /// <summary>Ends every ticket begun before now.</summary>
        public void InvalidateAll()
        {
            var at = Interlocked.Increment(ref _clock);
            _step?.Invoke("invalidate");
            while (true)
            {
                var was = Volatile.Read(ref _epoch);
                var next = was.Rolled(at);
                _step?.Invoke("swap");
                if (ReferenceEquals(Interlocked.CompareExchange(ref _epoch, next, was), was)) return;
            }
        }

        /// <summary>
        /// The records ((record) → the clock of its last invalidation) and the floor (tickets begun before it are ended),
        /// from one moment. A class, so two epochs are never mistaken for each other however alike they are.
        /// </summary>
        internal sealed class Epoch
        {
            internal Epoch(long floor, ImmutableDictionary<TRecord, long> records, long newest)
            {
                Floor = floor;
                Records = records;
                Newest = newest;
            }

            /// <summary>Tickets begun before it are ended.</summary>
            public long Floor { get; }

            /// <summary>The clock of each record's last invalidation.</summary>
            public ImmutableDictionary<TRecord, long> Records { get; }

            // The latest record, which a rollover's floor must cover.
            private long Newest { get; }

            /// <summary>True when a ticket begun at <paramref name="clock"/> is past the floor.</summary>
            /// <param name="clock">The ticket.</param>
            /// <returns>Whether the floor leaves it.</returns>
            public bool Admits(long clock) => clock >= Floor;

            /// <summary>True when <paramref name="record"/> was invalidated after a ticket begun at <paramref name="clock"/>.</summary>
            /// <param name="record">The record.</param>
            /// <param name="clock">The ticket.</param>
            /// <returns>Whether it ended.</returns>
            public bool Ended(TRecord record, long clock) => Records.TryGetValue(record, out var at) && at > clock;

            internal Epoch With(TRecord record, long at)
                => new(Floor, Records.SetItem(record, Math.Max(Records.GetValueOrDefault(record), at)), Math.Max(Newest, at));

            // Every record dropped, ended instead by a floor at or past each of them and past `at`.
            internal Epoch Rolled(long at) => new(Math.Max(Math.Max(Floor, Newest), at), Records.Clear(), 0);
        }
    }
}
