using Jellyfin.Plugin.JellyfinEnhanced.Features.Activity.Services;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.Activity
{
    /// <summary>Activity's service registrations (restructure S2.2), called where its lines stood in PluginServiceRegistrator.</summary>
    public static class ActivityServiceRegistration
    {
        public static IServiceCollection AddJeActivity(this IServiceCollection serviceCollection)
        {
            serviceCollection.AddSingleton<ActivityService>();
            serviceCollection.AddSingleton<ActivityFavoriteMonitor>();
            return serviceCollection;
        }
    }
}
