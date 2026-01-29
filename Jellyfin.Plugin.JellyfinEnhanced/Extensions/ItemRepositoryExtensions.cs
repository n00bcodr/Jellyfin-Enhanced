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
    }
}