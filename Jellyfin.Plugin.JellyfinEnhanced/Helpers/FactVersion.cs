using System;
using System.Collections.Concurrent;
using System.Threading;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinEnhanced.Helpers
{
    /// <summary>
    /// The version of a fact the automatic-write check reads (a seqlock): every change to the fact runs inside
    /// <see cref="Mutate(Action)"/>, which moves the version to ODD before the change can be seen and back to EVEN after it,
    /// in a <c>finally</c>, so a change that throws still finishes the bracket and leaves the version moved (a reader then
    /// reads again: the safe answer). A reader samples it before reading the fact and again when it decides: a sample
    /// that isn't <see cref="Settled"/> (a change in flight), or two samples that differ, mean what was read may already
    /// be stale. Changes that overlap are counted too: the sample isn't settled while any of them is in flight (two
    /// overlapping changes leave the parity even, the in-flight count doesn't). Memory only, never waits.
    /// </summary>
    public sealed class FactVersion
    {
        // The low 40 bits count bracket edges (odd while one change is in flight); the bits above count changes in flight.
        private const long InFlight = 1L << 40;

        private long _value;

        /// <summary>The version now, for <see cref="Settled"/> and comparison.</summary>
        public long Sample() => Interlocked.Read(ref _value);

        /// <summary>True when no change was in flight as <paramref name="sample"/> was taken (even, nothing counted in flight).</summary>
        /// <param name="sample">A sample.</param>
        public static bool Settled(long sample) => (sample & 1) == 0 && sample < InFlight;

        /// <summary>
        /// Several versions read as one sample: unsettled (-1) while any is, else their sum. A settled version only moves
        /// up (each finished change adds 2), so a settled sum that is the same twice means none of them moved.
        /// </summary>
        /// <param name="first">One version's sample.</param>
        /// <param name="second">The other's.</param>
        public static long Combine(long first, long second) => Settled(first) && Settled(second) ? first + second : -1;

        /// <summary>Makes <paramref name="change"/> inside the bracket.</summary>
        /// <param name="change">The change (whatever makes it visible: a commit, a file move, a published reference).</param>
        public void Mutate(Action change)
        {
            Begin();
            try
            {
                change();
            }
            finally
            {
                End();
            }
        }

        /// <summary>Makes <paramref name="change"/> inside the bracket and returns its result.</summary>
        /// <typeparam name="T">Result type.</typeparam>
        /// <param name="change">The change.</param>
        public T Mutate<T>(Func<T> change)
        {
            Begin();
            try
            {
                return change();
            }
            finally
            {
                End();
            }
        }

        /// <summary>Makes an asynchronous <paramref name="change"/> inside the bracket (odd until it completes).</summary>
        /// <param name="change">The change.</param>
        public async Task MutateAsync(Func<Task> change)
        {
            Begin();
            try
            {
                await change().ConfigureAwait(false);
            }
            finally
            {
                End();
            }
        }

        private void Begin() => Interlocked.Add(ref _value, InFlight + 1);

        private void End() => Interlocked.Add(ref _value, 1 - InFlight);
    }

    /// <summary>A <see cref="FactVersion"/> per key (a person, a Jellyfin user), made on first use.</summary>
    public sealed class FactVersions
    {
        private readonly ConcurrentDictionary<string, FactVersion> _versions = new(StringComparer.Ordinal);

        /// <summary>The version of <paramref name="key"/>.</summary>
        /// <param name="key">The key (normalized by the caller).</param>
        public FactVersion For(string key) => _versions.GetOrAdd(key, _ => new FactVersion());

        /// <summary>The version of <paramref name="key"/> now (0 when it never changed).</summary>
        /// <param name="key">The key.</param>
        public long Sample(string key) => _versions.TryGetValue(key, out var version) ? version.Sample() : 0;
    }
}
