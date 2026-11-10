using Jellyfin.Plugin.JellyfinEnhanced.Features.Platform.Services;
using Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.Platform
{
    /// <summary>
    /// Platform's service registrations (restructure S2.15), called where its first line stood in PluginServiceRegistrator,
    /// in the lines' original relative order. ScriptInjectionStartupFilter still comes before Chrome's
    /// BrandingAssetStartupFilter (AddJeChrome runs later), so the IStartupFilter order is unchanged (backend.md §2 DI,
    /// item 1); every other type here is registered once. HostCompatibilityService and UsageEventCounterService are Shared
    /// services and stay registered where they were (backend.md §7.7). StartupService keeps its original namespace because
    /// it is a scheduled task (backend.md §7.8).
    /// </summary>
    public static class PlatformServiceRegistration
    {
        public static IServiceCollection AddJePlatform(this IServiceCollection serviceCollection)
        {
            serviceCollection.AddSingleton<StartupService>();
            // Request-time injection middleware: injects the client <script> into the web index.html.
            serviceCollection.AddSingleton<IStartupFilter, ScriptInjectionStartupFilter>();
            // Local CDN subsystem: serves every third-party static asset (icons, fonts,
            // theme sheets, flags, remote locales) from the plugin's own route, backed by
            // an on-disk cache that the RefreshCdnAssetsTask warms/refreshes every 24h.
            serviceCollection.AddSingleton<CdnAssetService>();
            serviceCollection.AddSingleton<AnalyticsReportingService>();
            serviceCollection.AddTransient<AnalyticsReportTask>();
            serviceCollection.AddTransient<RefreshCdnAssetsTask>();
            return serviceCollection;
        }
    }
}
