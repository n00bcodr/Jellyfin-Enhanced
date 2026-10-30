// Ordinary code that looks like coverlet's tracker (its namespace, a name sharing its prefix, its probe's name and
// signature) and waits for the configuration lock: IntegrationLockOrderArchitectureTests must keep seeing it.
namespace Coverlet.Core.Instrumentation.Tracker
{
    internal static class RealCode
    {
        internal static int AcquireConfiguration() { lock (Jellyfin.Plugin.JellyfinEnhanced.JellyfinEnhanced.ConfigurationLock) return 1; }
    }

    internal static class Probes
    {
        public static void RecordHit(int hitLocationIndex) { lock (Jellyfin.Plugin.JellyfinEnhanced.JellyfinEnhanced.ConfigurationLock) _ = hitLocationIndex; }
    }
}

namespace Coverlet.Core.Instrumentation.TrackerLikePlugin
{
    internal static class RealCode
    {
        internal static int AcquireConfiguration() { lock (Jellyfin.Plugin.JellyfinEnhanced.JellyfinEnhanced.ConfigurationLock) return 1; }
    }
}
