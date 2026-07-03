using System.Net.Http;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.EventHandlers;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks;
using MediaBrowser.Controller.Events;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Plugins;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;
using MediaBrowser.Controller;

namespace Jellyfin.Plugin.JellyfinEnhanced
{
    public class PluginServiceRegistrator : IPluginServiceRegistrator
    {
        public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
        {
            serviceCollection.AddSingleton<StartupService>();

            // Request-time injection middlewares (Jellyfin 10.11 & 12):
            //   - ScriptInjectionStartupFilter injects the client <script> into the
            //     web index.html;
            //   - BrandingAssetStartupFilter serves custom logo/banner/favicon images.
            //     Both are kill-switchable via config and no-op safely when there's
            //     nothing to do.
            serviceCollection.AddSingleton<IStartupFilter, ScriptInjectionStartupFilter>();
            serviceCollection.AddSingleton<IStartupFilter, BrandingAssetStartupFilter>();

            serviceCollection.AddHttpClient();

            // a named HttpClient with AllowAutoRedirect=false so
            // forward-auth proxies (Authelia / Pangolin / Authentik) returning
            // 302 to a login URL are detected as `UpstreamRedirect` instead of
            // silently followed and producing a 200 + login HTML body.
            // SeerrHttpHelper.UseClientName(name) selects this for outbound
            // Seerr/TMDB calls.
            serviceCollection.AddHttpClient(Helpers.Jellyseerr.SeerrHttpHelper.NamedClient)
                .ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler
                {
                    AllowAutoRedirect = false
                });
            serviceCollection.AddSingleton<Logger>();
            serviceCollection.AddSingleton<UserConfigurationManager>();
            serviceCollection.AddSingleton<AutoSeasonRequestService>();
            serviceCollection.AddSingleton<AutoSeasonRequestMonitor>();
            serviceCollection.AddSingleton<AutoMovieRequestService>();
            serviceCollection.AddSingleton<AutoMovieRequestMonitor>();
            serviceCollection.AddSingleton<WatchlistMonitor>();
            serviceCollection.AddSingleton<SeerrScanTriggerService>();
            serviceCollection.AddSingleton<TagCacheService>();
            serviceCollection.AddSingleton<TagCacheMonitor>();
            serviceCollection.AddTransient<ArrTagsSyncTask>();
            serviceCollection.AddTransient<BuildTagCacheTask>();
            serviceCollection.AddTransient<JellyseerrWatchlistSyncTask>();
            serviceCollection.AddTransient<JellyfinToSeerrWatchlistSyncTask>();
            serviceCollection.AddTransient<JellyseerrUserImportTask>();
            serviceCollection.AddTransient<ClearTranslationCacheTask>();

            // Hidden Content: server-side filter for every native Jellyfin endpoint that surfaces user-facing item lists
            // (Resume, Items, Latest, NextUp, Upcoming, Suggestions, SearchHints). Same filter handles "Remove from
            // Continue Watching" via HideScope=continuewatching in hidden-content.json.
            serviceCollection.AddSingleton<MaintenanceModeService>();
            serviceCollection.AddSingleton<HiddenContentResponseFilter>();
            serviceCollection.AddScoped<IEventConsumer<PlaybackStartEventArgs>, ContinueWatchingPlaybackConsumer>();
            serviceCollection.AddHostedService<ContinueWatchingLibraryHook>();

            // Spoiler Guard: replaces image bytes for unaired episodes with a Gaussian-blurred
            // version. Runs as an MVC action filter scoped to the Image controller so every
            // client (web/TV/iOS/Android) gets the blurred bytes via the native image API.
            serviceCollection.AddSingleton<ImageBlurService>();
            // Shared user-resolution + state-load helper. One instance, both filters use it
            // so the IPv6 / shared-IP / fail-closed logic stays in ONE place.
            serviceCollection.AddSingleton<SpoilerUserResolver>();
            serviceCollection.AddSingleton<SpoilerBlurImageFilter>();
            // Spoiler Field Strip: removes spoiler-y metadata (Overview, Tags, Chapters,
            // Taglines, ratings, premiere date, episode title, cast) from BaseItemDto
            // responses for unwatched episodes whose series is in the user's spoiler list.
            serviceCollection.AddSingleton<SpoilerFieldStripFilter>();
            // Auto-enable spoiler mode for a series on first play of S1E1.
            // Gated by SpoilerAutoEnableOnFirstPlay; runs on every PlaybackStart.
            serviceCollection.AddScoped<IEventConsumer<PlaybackStartEventArgs>, SpoilerAutoEnableOnFirstPlayConsumer>();

            // Promotes pending pre-acquisition Spoiler Guard entries (PendingTmdb)
            // into real Series/Movies entries when matching library items land.
            serviceCollection.AddHostedService<SpoilerSeerrPendingPromoter>();

            serviceCollection.Configure<MvcOptions>(o =>
            {
                // All three are IAsyncActionFilters that rewrite the response AFTER
                // `await next()`, so their post-processing runs in REVERSE registration
                // order (SpoilerBlur, then SpoilerFieldStrip, then HiddenContent).
                // The composition is order-independent anyway — HC drops whole items
                // while the spoiler filters edit fields of surviving items, and
                // dropping∘stripping ≡ stripping∘dropping — but keep HC registered
                // first so its short-circuit paths run last on the way out.
                o.Filters.AddService<HiddenContentResponseFilter>();
                o.Filters.AddService<SpoilerFieldStripFilter>();
                o.Filters.AddService<SpoilerBlurImageFilter>();
            });
        }
    }
}