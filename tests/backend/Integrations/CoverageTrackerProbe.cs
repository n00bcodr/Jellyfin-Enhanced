namespace Coverlet.Core.Instrumentation.Tracker;

/// <summary>
/// Stands in for the hit tracker coverlet adds to an instrumented module (same namespace and probe method), so
/// IntegrationLockOrderArchitectureTests can show that its IL scan reads an instrumented body like an uninstrumented one.
/// </summary>
internal static class Probes
{
    public static void RecordHit(int hitLocationIndex) => _ = hitLocationIndex;
}
