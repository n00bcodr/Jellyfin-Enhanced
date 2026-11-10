using Jellyfin.Plugin.JellyfinEnhanced.Features.HiddenContent.Events;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.HiddenContent;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.HiddenContent
{
    /// <summary>
    /// Hidden Content's service registrations (restructure S2.9), called where its lines stood in PluginServiceRegistrator.
    /// HiddenContentResponseFilter lives in Shared/HiddenContent (Settings also invalidates its cache) but is still this
    /// feature's filter; its position in the MVC filter order is set in Infrastructure/Hosting/MvcFilterRegistration.
    /// </summary>
    public static class HiddenContentServiceRegistration
    {
        public static IServiceCollection AddJeHiddenContent(this IServiceCollection serviceCollection)
        {
            serviceCollection.AddSingleton<HiddenContentResponseFilter>();
            serviceCollection.AddHostedService<ContinueWatchingLibraryHook>();
            return serviceCollection;
        }
    }
}
