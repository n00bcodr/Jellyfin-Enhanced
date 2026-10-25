using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Backends;

// Backend-neutral half of Publication.EnlistEffective. Public TMDB/local list reads enlist
// their original epoch without acquiring a provider reader, permission or a current replacement epoch.
internal sealed class EffectiveReadScope : IDisposable
{
    private static readonly AsyncLocal<EffectiveReadScope?> Pending = new();
    private readonly EffectiveReadScope? _parent;
    private readonly Dictionary<EffectiveRequestsBackend, long> _dependencies = new();
    internal EffectiveReadScope() { _parent = Pending.Value; Pending.Value = this; }
    internal static void Enlist(EffectiveRequestsBackend owner, long epoch) => Pending.Value?.Include(owner, epoch);
    internal void Include(EffectiveRequestsBackend owner, long epoch)
    {
        _parent?.Include(owner, epoch);
        lock (_dependencies) _dependencies.TryAdd(owner, epoch);
    }
    internal KeyValuePair<EffectiveRequestsBackend, long>[] Dependencies()
    {
        lock (_dependencies) return _dependencies.Concat(_parent?.Dependencies() ?? []).Distinct().ToArray();
    }
    public void Dispose() { if (Pending.Value == this) Pending.Value = _parent; }
}
