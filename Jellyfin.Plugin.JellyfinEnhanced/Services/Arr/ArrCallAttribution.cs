using System.Threading;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Arr
{
    /// <summary>
    /// Counts upstream arr calls per logical caller. <see cref="ArrClient"/> adds every call it
    /// sends to the counter of the current async flow, so a user request (see
    /// <see cref="ArrRequestScope"/>) can tell whether serving it reached an arr, separately from
    /// the store's own background refreshes.
    /// </summary>
    public sealed class ArrCallCounter
    {
        private long _calls;

        /// <summary>Calls counted so far.</summary>
        public long Calls => Interlocked.Read(ref _calls);

        /// <summary>The counter of the current async flow (null: not attributed).</summary>
        internal static readonly AsyncLocal<ArrCallCounter?> Current = new();

        /// <summary>Adds one call.</summary>
        internal void Increment() => Interlocked.Increment(ref _calls);
    }
}
