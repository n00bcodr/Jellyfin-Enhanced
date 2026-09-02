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
            // Build-target vs host-version check; logged at startup and surfaced
            // on the config page so a jf10 zip on a Jellyfin 12 host is not silent.
            serviceCollection.AddSingleton<HostCompatibilityService>();

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
            // Auto-detects newly added config-page settings by diffing the
            // embedded configPage.html against a snapshot from the previous
            // startup -- see StartupService.
            serviceCollection.AddSingleton<WhatsNewService>();
            serviceCollection.AddSingleton<AutoSeasonRequestService>();
            serviceCollection.AddSingleton<AutoSeasonRequestMonitor>();
            serviceCollection.AddSingleton<AutoMovieRequestService>();
            serviceCollection.AddSingleton<AutoMovieRequestMonitor>();
            serviceCollection.AddSingleton<WatchlistMonitor>();
            serviceCollection.AddSingleton<SeerrScanTriggerService>();
            serviceCollection.AddSingleton<TagCacheService>();
            serviceCollection.AddSingleton<TagCacheMonitor>();
            // Local CDN subsystem: serves every third-party static asset (icons, fonts,
            // theme sheets, flags, remote locales) from the plugin's own route, backed by
            // an on-disk cache that the RefreshCdnAssetsTask warms/refreshes every 24h.
            serviceCollection.AddSingleton<CdnAssetService>();
            // Awards lookup: on-demand per-title fetch from Wikidata's public SPARQL
            // endpoint (no API key), cached to disk indefinitely for hits / with a TTL
            // for misses — see WikidataAwardsService for details.
            serviceCollection.AddSingleton<WikidataAwardsService>();
            serviceCollection.AddSingleton<MdblistService>();
            // Opt-in anonymous usage reporting: UsageEventCounterService holds the
            // current period's counters (debounced disk persistence, same pattern
            // as WikidataAwardsService); AnalyticsReportingService builds/sends the
            // payload on AnalyticsReportTask's cadence. See AnalyticsReportingService
            // for what's collected and why it's safe to ship the anon key in-client.
            serviceCollection.AddSingleton<UsageEventCounterService>();
            serviceCollection.AddSingleton<AnalyticsReportingService>();
            serviceCollection.AddTransient<AnalyticsReportTask>();
            serviceCollection.AddTransient<RefreshCdnAssetsTask>();
            serviceCollection.AddTransient<ArrTagsSyncTask>();
            serviceCollection.AddTransient<MdblistRatingsFetchTask>();
            serviceCollection.AddTransient<MdblistRatingsSyncTask>();
            serviceCollection.AddTransient<BuildTagCacheTask>();
            serviceCollection.AddTransient<JellyseerrWatchlistSyncTask>();
            serviceCollection.AddTransient<JellyfinToSeerrWatchlistSyncTask>();
            serviceCollection.AddTransient<JellyseerrUserImportTask>();
            serviceCollection.AddTransient<ClearTranslationCacheTask>();

            // Hidden Content: server-side filter for every native Jellyfin endpoint that surfaces user-facing item lists
            // (Resume, Items, Latest, NextUp, Upcoming, Suggestions, SearchHints), plus the Home Screen Sections
            // plugin's own section-content endpoint, which replaces those native lists on an HSS home screen. Same
            // filter handles "Remove from Continue Watching" via HideScope=continuewatching in hidden-content.json.
            serviceCollection.AddSingleton<MaintenanceModeService>();
            serviceCollection.AddSingleton<HiddenContentResponseFilter>();
            serviceCollection.AddScoped<IEventConsumer<PlaybackStartEventArgs>, ContinueWatchingPlaybackConsumer>();
            serviceCollection.AddHostedService<ContinueWatchingLibraryHook>();

            // Activity Feed: recently watched / favorited / reviewed, gated by
            // ActivityFeedEnabled. ActivityFavoriteMonitor is a Singleton that
            // self-subscribes to IUserDataManager.UserDataSaved in its own
            // constructor (see StartupService, which forces its construction).
            serviceCollection.AddSingleton<ActivityService>();
            serviceCollection.AddSingleton<ActivityFavoriteMonitor>();
            serviceCollection.AddScoped<IEventConsumer<PlaybackStopEventArgs>, ActivityPlaybackConsumer>();

            // Spoiler Guard: an MVC action filter on the Image controller blurs
            // guarded-episode image bytes, so every client gets them via the native image API.
            serviceCollection.AddSingleton<ImageBlurService>();
            // Shared user-resolution + state-load helper. One instance, both filters use it
            // so the IPv6 / shared-IP / fail-closed logic stays in ONE place.
            serviceCollection.AddSingleton<SpoilerIdentityService>();
            serviceCollection.AddSingleton<RequestIdentityService>();
            serviceCollection.AddSingleton<SpoilerIdentityTagFilter>();
            serviceCollection.AddSingleton<SpoilerUserResolver>();
            serviceCollection.AddSingleton<SpoilerBlurImageFilter>();
            // Per-(user, series) next-unwatched boundary for the advanced
            // category reveals; owns its own bounded cache and evicts on
            // IUserDataManager.UserDataSaved (O(1) on the event thread).
            serviceCollection.AddSingleton<SpoilerNextUnwatchedService>();
            // Spoiler Field Strip: removes spoiler-y metadata (Overview, ratings,
            // title, cast, etc.) from BaseItemDto responses for guarded unwatched episodes.
            serviceCollection.AddSingleton<SpoilerFieldStripFilter>();
            // Auto-enable spoiler mode for a series on first play of S1E1.
            // Gated by SpoilerAutoEnableOnFirstPlay; runs on every PlaybackStart.
            serviceCollection.AddScoped<IEventConsumer<PlaybackStartEventArgs>, SpoilerAutoEnableOnFirstPlayConsumer>();
            serviceCollection.AddScoped<IEventConsumer<Jellyfin.Data.Events.Users.UserCreatedEventArgs>, UserCreatedIdentityInvalidator>();
            serviceCollection.AddScoped<IEventConsumer<Jellyfin.Data.Events.Users.UserDeletedEventArgs>, UserDeletedIdentityInvalidator>();

            // Promotes pending pre-acquisition Spoiler Guard entries (PendingTmdb)
            // into real Series/Movies entries when matching library items land.
            serviceCollection.AddHostedService<SpoilerSeerrPendingPromoter>();

            serviceCollection.Configure<MvcOptions>(o =>
            {
                // All three are IAsyncActionFilters that rewrite the response after
                // `await next()`, so post-processing runs in REVERSE registration order.
                // Identity-tag stamping must run after field-strip cache-busting so
                // clients echo the final "sb-...-jeu..." tag on image requests.
                o.Filters.AddService<HiddenContentResponseFilter>();
                o.Filters.AddService<SpoilerIdentityTagFilter>();
                o.Filters.AddService<SpoilerFieldStripFilter>();
                o.Filters.AddService<SpoilerBlurImageFilter>();
            });
        }
    }
}
