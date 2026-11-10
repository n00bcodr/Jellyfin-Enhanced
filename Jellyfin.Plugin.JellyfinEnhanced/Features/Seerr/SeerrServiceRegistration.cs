using Jellyfin.Plugin.JellyfinEnhanced.Features.Seerr.Services;
using Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.Seerr
{
    /// <summary>
    /// Seerr's service registrations (restructure S2.14), called where its first line stood in PluginServiceRegistrator,
    /// in the lines' original relative order. Every type here is registered once, so moving the later lines up does not
    /// change any per-ServiceType order (backend.md §2 DI). Left in PluginServiceRegistrator at their own places: the
    /// named Seerr HttpClient (used through Shared/Seerr/SeerrHttpHelper by several features), and TmdbResponseCache and
    /// SeerrParentalFilter, which are Shared services that stay registered where they were (backend.md §7.7).
    /// </summary>
    public static class SeerrServiceRegistration
    {
        public static IServiceCollection AddJeSeerr(this IServiceCollection serviceCollection)
        {
            serviceCollection.AddSingleton<AutoSeasonRequestService>();
            serviceCollection.AddSingleton<AutoSeasonRequestMonitor>();
            serviceCollection.AddSingleton<AutoMovieRequestService>();
            serviceCollection.AddSingleton<AutoMovieRequestMonitor>();
            serviceCollection.AddSingleton<WatchlistMonitor>();
            serviceCollection.AddSingleton<SeerrScanTriggerService>();
            serviceCollection.AddTransient<JellyseerrWatchlistSyncTask>();
            serviceCollection.AddTransient<JellyfinToSeerrWatchlistSyncTask>();
            serviceCollection.AddTransient<WatchlistRemovalSyncTask>();
            serviceCollection.AddTransient<JellyseerrUserImportTask>();
            return serviceCollection;
        }
    }
}
