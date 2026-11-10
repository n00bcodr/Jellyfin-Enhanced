using Jellyfin.Plugin.JellyfinEnhanced.Features.Catchup.Services;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.Catchup
{
    /// <summary>Catch Up's service registrations (restructure S2.1), called where its lines stood in PluginServiceRegistrator.</summary>
    public static class CatchupServiceRegistration
    {
        public static IServiceCollection AddJeCatchup(this IServiceCollection serviceCollection)
        {
            serviceCollection.AddSingleton<CatchUpLogService>();
            return serviceCollection;
        }
    }
}
