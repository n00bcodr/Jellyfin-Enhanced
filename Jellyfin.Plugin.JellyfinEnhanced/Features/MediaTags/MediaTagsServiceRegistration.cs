using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.PosterTags.Rendering;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags.Services;
using Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags
{
    /// <summary>
    /// Media Tags' service registrations (restructure S2.11), called where its first line stood in
    /// PluginServiceRegistrator; the lines keep their original relative order. The event consumer stays in
    /// EventConsumerRegistration and the image filter's MVC position in MvcFilterRegistration.
    /// </summary>
    public static class MediaTagsServiceRegistration
    {
        public static IServiceCollection AddJeMediaTags(this IServiceCollection serviceCollection)
        {
                // Matroska track languages per file (size + mtime), so tag-cache
                // rebuilds and tag-data requests don't reopen unchanged media files
                // -- see MatroskaLanguageCache for why that matters on network mounts.
                serviceCollection.AddSingleton<MatroskaLanguageCache>();
                serviceCollection.AddSingleton<TagCacheService>();
                serviceCollection.AddSingleton<TagCacheMonitor>();
                serviceCollection.AddSingleton<AwardTagsService>();
                // Leaving soon facts (Maintainerr API or collection names), refreshed by RefreshLeavingSoonTagsTask.
                // Its Maintainerr client never follows redirects (the API key must not reach another origin).
                LeavingSoonService.AddHttpClient(serviceCollection);
                serviceCollection.AddSingleton<LeavingSoonService>();
                // Administrators' Maintainerr actions (mark, keep, postpone) over the same client.
                serviceCollection.AddSingleton<MaintainerrActions>();
                // Server-wide trending list for the Status Tags poster badges (30-minute cache).
                serviceCollection.AddSingleton<StatusTagsTrendingService>();
                // TMDB schedule facts for the Status Tags series badges (rate-limited lookups).
                serviceCollection.AddSingleton<StatusTagsSeriesService>();
                serviceCollection.AddSingleton<NativeStatusRefreshService>();
                serviceCollection.AddHostedService(sp => sp.GetRequiredService<NativeStatusRefreshService>());
                // Logos tag group: daily TMDB provider/network/studio lookups and the logo image proxy cache.
                serviceCollection.AddSingleton<TagLogoService>();
                serviceCollection.AddSingleton<StatusTagsScenesService>();
                serviceCollection.AddTransient<ArrTagsSyncTask>();
                serviceCollection.AddTransient<AudioLanguageTagsSyncTask>();
                serviceCollection.AddTransient<BuildTagCacheTask>();
                serviceCollection.AddTransient<RefreshAwardTagsTask>();
                // Native Poster Tags (experimental, NativePosterTagsEnabled): JE's
                // card tags drawn into Primary images for clients that don't run
                // the web overlays. SpoilerIdentityTagFilter stamps a "-jet"
                // variant token into eligible image tags (NativePosterTagStamper);
                // PosterTagImageFilter draws the composite on matching image
                // requests. Every service is inert while the master switch is off.
                serviceCollection.AddSingleton<NativeClientPolicy>();
                serviceCollection.AddSingleton<PosterTagSettingsProvider>();
                // Short TTL in front of IUserManager.GetUserById (a DB transaction
                // per call on Jellyfin 12) for the viewer and review-author lookups.
                serviceCollection.AddSingleton<PosterTagUserCache>();
                serviceCollection.AddSingleton<PosterTagVariantToken>();
                serviceCollection.AddSingleton<PosterTagReviewRatings>();
                serviceCollection.AddSingleton<PosterTagDataProvider>();
                serviceCollection.AddSingleton<CompositeImageCache>();
                serviceCollection.AddSingleton<PosterTagRenderer>();
                serviceCollection.AddSingleton<PosterTagStatusProvider>();
                serviceCollection.AddSingleton<PosterTagComposer>();
                serviceCollection.AddSingleton<NativePosterTagStamper>();
                serviceCollection.AddSingleton<PosterTagImageFilter>();
            return serviceCollection;
        }

        /// <summary>
        /// Media Tags' hosted services that start after every other one: called last in PluginServiceRegistrator, so
        /// the hosted services registered before them keep their start order.
        /// </summary>
        public static IServiceCollection AddJeMediaTagsLateHostedServices(this IServiceCollection serviceCollection)
        {
            // The "Leaving soon" Home Screen Sections row (upstream 481a10ee): registered with HSS by reflection once it
            // has loaded; its state reaches the admin status through LeavingSoonService.
            serviceCollection.AddHostedService<LeavingSoonHomeSection>();
            return serviceCollection;
        }
    }
}
