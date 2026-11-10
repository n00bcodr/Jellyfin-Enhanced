using Jellyfin.Plugin.JellyfinEnhanced.Features.Chrome.Services;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.Chrome
{
    /// <summary>Chrome's service registrations (restructure S2.6), called where its line stood in PluginServiceRegistrator.</summary>
    public static class ChromeServiceRegistration
    {
        public static IServiceCollection AddJeChrome(this IServiceCollection serviceCollection)
        {
            serviceCollection.AddSingleton<IStartupFilter, BrandingAssetStartupFilter>();
            return serviceCollection;
        }
    }
}
