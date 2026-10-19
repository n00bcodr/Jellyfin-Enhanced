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
        /// <summary>
        /// Every Jellyfin item each (provider, value) key matches, best match first: the same title can be
        /// in more than one library (a 4K or kids' copy), and each copy is its own item. Callers that only
        /// want one id take the first; callers deciding per user can look for the copy that user may open.
        /// </summary>
        /// <param name="dbContextFactory">Jellyfin's database.</param>
        /// <param name="providers">The keys to look up.</param>
        /// <param name="libraryManager">Used to put a series/movie ahead of episodes and seasons sharing a key.</param>
        /// <param name="ct">Cancellation.</param>
        /// <returns>Each matched key with its distinct item ids (never empty), best match first.</returns>
        public static async Task<Dictionary<(string Provider, string Value), List<Guid>>>
            GetItemIdCandidatesByProvidersBatchAsync(
                this IDbContextFactory<JellyfinDbContext> dbContextFactory,
                IReadOnlyCollection<(string Provider, string Value)> providers,
                ILibraryManager? libraryManager = null,
                CancellationToken ct = default)
        {
            if (providers.Count == 0)
                return new Dictionary<(string, string), List<Guid>>();

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
                .ToDictionary(g => g.Key, g =>
                {
                    var distinctIds = g.Select(p => p.ItemId).Distinct().ToList();
                    var best = ResolveBestMatch(distinctIds, libraryManager);
                    distinctIds.Remove(best);
                    distinctIds.Insert(0, best);
                    return distinctIds;
                });
        }

        private static Guid ResolveBestMatch(List<Guid> distinctIds, ILibraryManager? libraryManager)
        {
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