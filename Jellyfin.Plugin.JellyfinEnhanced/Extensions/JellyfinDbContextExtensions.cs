using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Microsoft.EntityFrameworkCore;

namespace Jellyfin.Plugin.JellyfinEnhanced.Extensions
{
    public static class JellyfinDbExtension 
    {
        public static async Task<Dictionary<(string Provider, string Value), Guid>> 
            GetItemIdsByProvidersBatchAsync(
                this IDbContextFactory<JellyfinDbContext> dbContextFactory,
                IReadOnlyCollection<(string Provider, string Value)> providers,
                CancellationToken ct = default)
        {
            if (providers.Count == 0)
                return new Dictionary<(string, string), Guid>();

            await using var db = await dbContextFactory.CreateDbContextAsync(ct);

            var providerGroups = providers
                .GroupBy(p => p.Provider)
                .ToDictionary(g => g.Key, g => g.Select(x => x.Value).ToList());

            var results = new List<BaseItemProvider>();

            foreach (var g in providerGroups)
            {
                var provider = g.Key;
                var values = g.Value;
                var items = await db.BaseItemProviders
                    .Where(p => p.ProviderId == provider && values.Contains(p.ProviderValue))
                    .ToListAsync(ct);
                results.AddRange(items);
            }

            return results
                .DistinctBy(p => (p.ProviderId, p.ProviderValue))
                .ToDictionary(p => (p.ProviderId, p.ProviderValue), p => p.ItemId);
        }
    }
}