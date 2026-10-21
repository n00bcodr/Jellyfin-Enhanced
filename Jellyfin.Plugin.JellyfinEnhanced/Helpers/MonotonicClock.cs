using System;
using System.Diagnostics;
using System.Threading;

namespace Jellyfin.Plugin.JellyfinEnhanced.Helpers
{
    /// <summary>
    /// The clock every cache lifetime is counted on, in <see cref="TimeSpan"/> ticks from an arbitrary start: monotonic, so
    /// setting the wall clock back or forward never lengthens or shortens a lifetime. A read's instant
    /// (<see cref="UserAuthority.Stamp.ReadAt"/>) and every entry's deadline are on it.
    /// </summary>
    internal static class MonotonicClock
    {
        private static readonly AsyncLocal<Func<long>?> Override = new();

        /// <summary>Now, in ticks.</summary>
        /// <returns>The ticks.</returns>
        public static long Now() => Override.Value?.Invoke() ?? Stopwatch.GetElapsedTime(0).Ticks;

        /// <summary>Replaces the clock for the calling flow until disposed (tests).</summary>
        /// <param name="ticks">The clock.</param>
        /// <returns>Restores the previous clock.</returns>
        internal static IDisposable Use(Func<long> ticks)
        {
            var previous = Override.Value;
            Override.Value = ticks;
            return new Restore(previous);
        }

        private sealed class Restore(Func<long>? previous) : IDisposable
        {
            public void Dispose() => Override.Value = previous;
        }
    }
}
