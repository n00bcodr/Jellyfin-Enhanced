using System;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Persistence;

namespace Jellyfin.Plugin.JellyfinEnhanced.Extensions {

    public static class ItemRepositoryExtensions
    {
        public static IReadOnlyList<Guid> GetItemIdsByProviders(
            this IItemRepository repository,
            IDictionary<string, string>? providers,
            IReadOnlyList<BaseItemKind>? includeItemTypes = null)
        {
            if (providers == null || providers.Count == 0)
                return Array.Empty<Guid>();

            var query = new InternalItemsQuery
            {
                HasAnyProviderId = new Dictionary<string, string>(providers),
                Recursive = true
            };

            // Some external providers (e.g. Shokofin) stamp the same series-level
            // provider ID onto every episode/season under that series, so an
            // unconstrained lookup can non-deterministically return an episode
            // instead of the series. Callers that know what kind of item they
            // want should constrain the search accordingly.
            if (includeItemTypes != null && includeItemTypes.Count > 0)
                query.IncludeItemTypes = includeItemTypes.ToArray();

            return repository.GetItemIdsList(query);
        }
    }
}