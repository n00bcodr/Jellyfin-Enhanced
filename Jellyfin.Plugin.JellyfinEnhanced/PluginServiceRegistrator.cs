using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks;
using MediaBrowser.Controller.Plugins;
using Microsoft.Extensions.DependencyInjection;
using MediaBrowser.Controller;

namespace Jellyfin.Plugin.JellyfinEnhanced
{
    public class PluginServiceRegistrator : IPluginServiceRegistrator
    {
        public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
        {
            serviceCollection.AddSingleton<StartupService>();
            serviceCollection.AddHttpClient();
            serviceCollection.AddSingleton<Logger>();
            serviceCollection.AddSingleton<UserConfigurationManager>();
            serviceCollection.AddSingleton<AutoSeasonRequestService>();
            serviceCollection.AddSingleton<AutoSeasonRequestMonitor>();
            serviceCollection.AddSingleton<AutoMovieRequestService>();
            serviceCollection.AddSingleton<AutoMovieRequestMonitor>();
            serviceCollection.AddSingleton<WatchlistMonitor>();
            serviceCollection.AddTransient<ArrTagsSyncTask>();
            serviceCollection.AddTransient<JellyseerrWatchlistSyncTask>();
            serviceCollection.AddTransient<ClearTranslationCacheTask>();
        }
    }
}