using System;
using System.Runtime.CompilerServices;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire
{
    public sealed partial class SeerrFacts
    {
        // Activated by the test assembly only. Production retains no taint table entries.
        private static readonly ConditionalWeakTable<object, TaintMark> TaintedHandouts = new();
        private sealed class TaintMark;
        internal interface IDerived { bool Tainted { get; } }
        internal readonly record struct Handout<T>(T Value, bool Tainted);
        internal static void IncludeCachedGeneration(long generation, bool tainted) => Pending.Value?.IncludeFacts(generation, tainted);
        internal static long? OperationGeneration => Pending.Value?.Generation;
        internal static bool RetainsFacts => Pending.Value?.RetainedGeneration == true;
        internal static bool HasSeerrDependency => Pending.Value?.Dependencies().Length > 0 || Pending.Value?.Tainted == true || UserCacheRegistry.OperationTainted;
        internal static bool IsTainted<T>(T value)
            => value is IDerived derived ? derived.Tainted
                : Pending.Value?.Tainted == true || UserCacheRegistry.OperationTainted
                    || UserCacheRegistry.TaintMode && value is object o && TaintedHandouts.TryGetValue(o, out _);
        internal static void MarkCachedTaint() { Pending.Value?.MarkTainted(); UserCacheRegistry.MarkTainted(); }
        private static Handout<T> Mark<T>(T value)
        {
            MarkCachedTaint();
            if (UserCacheRegistry.TaintMode) System.Threading.Interlocked.Increment(ref UserCacheRegistry.TaintedHandouts);
            if (UserCacheRegistry.TaintMode && value is object o) TaintedHandouts.GetValue(o, _ => new());
            return new(value, UserCacheRegistry.TaintMode);
        }
    }
}
