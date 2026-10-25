using System;
using System.Collections.Generic;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Backends;

// Immutable original read dependencies, without a provider reader or an admission lifetime.
// The HTTP owner retains this stamp after the composition scope has disposed its admissions.
internal sealed record BackendPublicationStamp(
    KeyValuePair<EffectiveRequestsBackend, long>[] Seerr,
    KeyValuePair<EffectiveRequestsBackend, long>[] Effective,
    long Facts, bool LegacySend)
{
    internal bool HasDependencies => Seerr.Length != 0 || Effective.Length != 0 || Facts != 0;

    internal void DemandCurrent()
    {
        foreach (var dependency in Seerr) dependency.Key.CommitSeerr(dependency.Value, () => true);
        foreach (var dependency in Effective) dependency.Key.CommitEffective(dependency.Value, () => true);
        if (Facts != 0 && !(LegacySend && EffectiveRequestsBackend.Shared.Current.IsolationVersion == 0)
            && (Facts != UserCacheRegistry.FactsGeneration || EffectiveRequestsBackend.Shared.FactsFenced))
            throw new BackendDisabledException("configuration_changed");
    }
}
