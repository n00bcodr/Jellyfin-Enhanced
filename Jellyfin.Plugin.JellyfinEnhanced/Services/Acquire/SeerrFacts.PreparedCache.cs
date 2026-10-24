using System;
using System.Collections.Generic;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire.Backends;

namespace Jellyfin.Plugin.JellyfinEnhanced.Services.Acquire
{
    public sealed partial class SeerrFacts
    {
        /// <summary>Retains the identity invalidation ticket AND the backend admission of a prepared answer.</summary>
        internal sealed class PreparedCache<TKey, TValue> where TKey : notnull
        {
            private readonly WrittenStateCache<TKey, (long Epoch, TValue Value)> _cache;
            private readonly EffectiveRequestsBackend _owner = EffectiveRequestsBackend.Shared;
            internal PreparedCache(TimeSpan ttl, int maxEntries, IEqualityComparer<TKey>? comparer = null) { _cache = new(ttl, maxEntries, comparer); }
            internal readonly record struct Ticket(long Epoch, WrittenStateCache<TKey, (long Epoch, TValue Value)>.Ticket State);
            internal Ticket Begin()
            {
                var admission = _owner.CheckSeerr(SeerrUse.Identity); admission.Demand();
                _owner.Facts.Include(admission.Epoch);
                return new(admission.Epoch, _cache.Begin());
            }
            internal bool TryGet(TKey key, out TValue value)
            {
                TValue found = default!;
                var hit = _owner.Facts.Cached(() =>
                {
                    if (!_cache.TryGet(key, out var entry) || !_owner.CheckSeerr(SeerrUse.Identity, entry.Epoch).Allowed) return false;
                    _owner.Facts.Include(entry.Epoch);
                    found = entry.Value; return true;
                }, false);
                value = found; return hit;
            }
            internal void Set(TKey key, Ticket ticket, TValue value, TimeSpan life)
                => _owner.Facts.Publish(ticket.Epoch, () => { _cache.Set(key, ticket.State, (ticket.Epoch, value), life); return true; });
            internal void Invalidate(TKey key) => _cache.Invalidate(key);
            internal void InvalidateAll() => _cache.InvalidateAll();
        }
    }
}
