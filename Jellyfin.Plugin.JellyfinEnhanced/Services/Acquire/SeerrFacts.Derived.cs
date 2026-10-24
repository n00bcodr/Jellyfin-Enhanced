using System;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Backends;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire
{
    public sealed partial class SeerrFacts
    {
        /// <summary>Stores a composed cache answer with the epochs of the facts actually used to build it.</summary>
        internal static Derived<T> Remember<T>(T value) => Derived<T>.Capture(value);
        internal static Derived<T> Derive<T>(Func<T> build)
        {
            using var publication = BeginPublication();
            var value = build();
            return Remember(value);
        }
        internal sealed class Derived<T> : IDerived
        {
            private readonly T _value;
            private readonly Helpers.UserCacheRegistry.Ticket _generation;
            public bool Tainted { get; }
            private readonly KeyValuePair<EffectiveRequestsBackend, long>[] _dependencies;
            private readonly KeyValuePair<EffectiveRequestsBackend, long>[] _effective;
            private Derived(T value, KeyValuePair<EffectiveRequestsBackend, long>[] dependencies, KeyValuePair<EffectiveRequestsBackend, long>[] effective) { _value = value; _dependencies = dependencies; _effective = effective; _generation = Helpers.UserCacheRegistry.Begin(); Tainted = IsTainted(value) || dependencies.Length > 0; }
            internal static Derived<T> Capture(T value) => new(value, Pending.Value?.Dependencies() ?? Array.Empty<KeyValuePair<EffectiveRequestsBackend, long>>(), Pending.Value?.EffectiveDependencies() ?? Array.Empty<KeyValuePair<EffectiveRequestsBackend, long>>());
            internal T Publish()
            {
                Helpers.UserCacheRegistry.Use(_generation, Tainted);
                if (Tainted) Pending.Value?.MarkTainted();
                T Check(int index) => index == _dependencies.Length ? _value
                    : _dependencies[index].Key.Facts.Publish(_dependencies[index].Value, () => Check(index + 1));
                T Effective(int index)
                {
                    if (index == _effective.Length) return Check(0);
                    var pair = _effective[index];
                    pair.Key.CommitEffective(pair.Value, () => true);
                    Pending.Value?.IncludeEffective(pair.Key, pair.Value);
                    return pair.Key.CommitEffective(pair.Value, () => Effective(index + 1));
                }
                return Effective(0);
            }
            internal T Read(T inactive)
            {
                try { return Publish(); }
                catch (BackendDisabledException) { return inactive; }
            }
            internal bool TryRead(out T value)
            {
                try { value = Publish(); return true; }
                catch (BackendDisabledException) { value = default!; return false; }
            }
        }
    }
}
