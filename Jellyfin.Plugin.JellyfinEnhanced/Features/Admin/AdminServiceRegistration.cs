using Jellyfin.Plugin.JellyfinEnhanced.Features.Admin.Services;
using Microsoft.Extensions.DependencyInjection;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Maintenance;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.Admin
{
    /// <summary>
    /// Admin's service registrations (restructure S2.7), called where its first line stood in PluginServiceRegistrator.
    /// <c>AddHostedService&lt;MaintenanceScheduleService&gt;()</c> stays in PluginServiceRegistrator at its own place, because
    /// moving it here would change the registration order of IHostedService (backend.md §2 DI, item 4).
    /// </summary>
    public static class AdminServiceRegistration
    {
        public static IServiceCollection AddJeAdmin(this IServiceCollection serviceCollection)
        {
            serviceCollection.AddSingleton<WhatsNewService>();
            serviceCollection.AddSingleton<MaintenanceModeService>();
            return serviceCollection;
        }
    }
}
