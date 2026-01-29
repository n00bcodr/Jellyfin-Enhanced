using System;
using System.Collections.Generic;
using System.Linq;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Persistence;

namespace Jellyfin.Plugin.JellyfinEnhanced.Extensions {

    public static class ItemRepositoryExtensions
    {
        public static IReadOnlyList<Guid> GetItemIdsByProviders(
            this IItemRepository repository,
            IDictionary<string, string>? providers)
        {
            if (providers == null || providers.Count == 0)
                return Array.Empty<Guid>();

            var query = new InternalItemsQuery
            {
                HasAnyProviderId = new Dictionary<string, string>(providers),
                Recursive = true
            };

            return repository.GetItemIdsList(query);
        }

        public static List<IReadOnlyList<Guid>> GetItemIdsByProviderSets(
            this IItemRepository repository,
            IEnumerable<IDictionary<string, string>> providerSets)
        {
            var results = new List<IReadOnlyList<Guid>>();

            foreach (var providers in providerSets)
            {
                if (providers == null || providers.Count == 0)
                {
                    results.Add(Array.Empty<Guid>());
                    continue;
                }

                var query = new InternalItemsQuery
                {
                    HasAnyProviderId = new Dictionary<string, string>(providers),
                    Recursive = true
                };

                var itemIds = repository.GetItemIdsList(query);
                results.Add(itemIds);
            }

            return results;
        }
    }
}