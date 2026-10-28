using System.Threading;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.ServerCache
{
    /// <summary>
    /// A lock-free gate for disk changes that must not happen once their owner has shut down. One integer holds the
    /// changes under way and a closed bit, changed only with interlocked operations, so a change and the shutdown never
    /// wait on each other: a change either entered before the gate closed, or never starts. Every rename, delete, file
    /// creation or write of the server-side cache and of the TMDB cache's snapshot goes through one.
    /// </summary>
    internal static class CommitGate
    {
        /// <summary>The closed bit (far above any number of changes under way).</summary>
        internal const int Closed = 1 << 30;

        /// <summary>Enters <paramref name="gate"/> right before a change; false once it is closed or <paramref name="ct"/> is cancelled.</summary>
        /// <param name="gate">The gate.</param>
        /// <param name="ct">The caller's own shutdown, checked inside the gate.</param>
        /// <returns>True when the change may start (then <see cref="Exit"/> after it).</returns>
        internal static bool TryEnter(ref int gate, CancellationToken ct)
        {
            while (true)
            {
                var state = Volatile.Read(ref gate);
                if ((state & Closed) != 0) return false;
                if (Interlocked.CompareExchange(ref gate, state + 1, state) != state) continue;
                // Checked inside the gate: an owner that cancels and then waits for the gate to drain either sees this
                // change finish or finds it never started.
                if (!ct.IsCancellationRequested) return true;
                Exit(ref gate);
                return false;
            }
        }

        /// <summary>Leaves <paramref name="gate"/> after a change.</summary>
        /// <param name="gate">The gate.</param>
        internal static void Exit(ref int gate) => Interlocked.Decrement(ref gate);

        /// <summary>Closes <paramref name="gate"/> (never waits): no change starts afterwards.</summary>
        /// <param name="gate">The gate.</param>
        internal static void Close(ref int gate)
        {
            int state;
            do state = Volatile.Read(ref gate);
            while ((state & Closed) == 0 && Interlocked.CompareExchange(ref gate, state | Closed, state) != state);
        }

        /// <summary>True when no change is under way.</summary>
        /// <param name="gate">The gate.</param>
        /// <returns>Drained.</returns>
        internal static bool Drained(ref int gate) => (Volatile.Read(ref gate) & ~Closed) == 0;
    }
}
