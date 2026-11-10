using Jellyfin.Plugin.JellyfinEnhanced.Features.DetailsProviders.Services;
using Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.DetailsProviders
{
    /// <summary>
    /// DetailsProviders' service registrations (restructure S2.12), called where its first line stood in
    /// PluginServiceRegistrator; the lines keep their original relative order. Its event consumer stays in
    /// EventConsumerRegistration.
    /// </summary>
    public static class DetailsProvidersServiceRegistration
    {
        public static IServiceCollection AddJeDetailsProviders(this IServiceCollection serviceCollection)
        {
                // Awards lookup: on-demand per-title fetch from Wikidata's public SPARQL
                // endpoint (no API key), cached to disk indefinitely for hits / with a TTL
                // for misses — see WikidataAwardsService for details.
                serviceCollection.AddSingleton<WikidataAwardsService>();
                serviceCollection.AddSingleton<AnilistReviewsService>();
                serviceCollection.AddSingleton<ReviewTranslationService>();
                serviceCollection.AddSingleton<MdblistService>();
                serviceCollection.AddSingleton<DoesTheDogDieService>();
                // Size / watch-progress of an item subtree in a handful of queries
                // (details-page media-info chips) -- see ItemStatsService.
                serviceCollection.AddSingleton<ItemStatsService>();
                serviceCollection.AddTransient<MdblistRatingsFetchTask>();
                serviceCollection.AddTransient<MdblistRatingsSyncTask>();
                serviceCollection.AddTransient<ClearTranslationCacheTask>();
            return serviceCollection;
        }
    }
}
