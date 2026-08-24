using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using Microsoft.EntityFrameworkCore;

namespace Jellyfin.Plugin.JellyfinEnhanced.Extensions
{
    public static class JellyfinDbExtension
    {
        public static async Task<Dictionary<(string Provider, string Value), Guid>>
            GetItemIdsByProvidersBatchAsync(
                this IDbContextFactory<JellyfinDbContext> dbContextFactory,
                IReadOnlyCollection<(string Provider, string Value)> providers,
                ILibraryManager? libraryManager = null,
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

            // A (Provider, Value) key can resolve to more than one item; prefer
            // the top-level container so series-level lookups land on the series/movie.
            return results
                .GroupBy(p => (p.ProviderId, p.ProviderValue))
                .ToDictionary(g => g.Key, g => ResolveBestMatch(g, libraryManager));
        }

        private static Guid ResolveBestMatch(
            IGrouping<(string Provider, string Value), BaseItemProvider> candidates,
            ILibraryManager? libraryManager)
        {
            var distinctIds = candidates.Select(p => p.ItemId).Distinct().ToList();
            if (distinctIds.Count == 1 || libraryManager == null)
                return distinctIds[0];

            foreach (var id in distinctIds)
            {
                var kind = libraryManager.GetItemById<BaseItem>(id)?.GetBaseItemKind();
                if (kind is not (BaseItemKind.Episode or BaseItemKind.Season))
                    return id;
            }

            return distinctIds[0];
        }
    }
}