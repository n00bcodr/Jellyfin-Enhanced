using System.Net.Http;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Infrastructure.Identity;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Activity;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Admin;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Admin.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Catchup;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Chrome;
using Jellyfin.Plugin.JellyfinEnhanced.Features.DetailsProviders;
using Jellyfin.Plugin.JellyfinEnhanced.Features.HiddenContent;
using Jellyfin.Plugin.JellyfinEnhanced.Features.MediaTags;
using Jellyfin.Plugin.JellyfinEnhanced.Features.SpoilerGuard;
using Jellyfin.Plugin.JellyfinEnhanced.Infrastructure.Hosting;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks;
using MediaBrowser.Controller.Events;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Plugins;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;
using MediaBrowser.Controller;
using Jellyfin.Plugin.JellyfinEnhanced.Features.DetailsProviders.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Parental;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Seerr;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Seerr;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Tmdb;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Seerr.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Host;
using Jellyfin.Plugin.JellyfinEnhanced.Features.Platform;
using Jellyfin.Plugin.JellyfinEnhanced.Shared.Analytics;

namespace Jellyfin.Plugin.JellyfinEnhanced
{
    public class PluginServiceRegistrator : IPluginServiceRegistrator
    {
        public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
        {
            serviceCollection.AddJePlatform();
            // Build-target vs host-version check; logged at startup and surfaced
            // on the config page so unsupported host majors are not silent.
            serviceCollection.AddSingleton<HostCompatibilityService>();

            // Request-time injection middlewares (Jellyfin 12):
            //   - ScriptInjectionStartupFilter injects the client <script> into the
            //     web index.html;
            //   - BrandingAssetStartupFilter serves custom logo/banner/favicon images.
            //     Both are kill-switchable via config and no-op safely when there's
            //     nothing to do.
            serviceCollection.AddJeChrome();

            serviceCollection.AddHttpClient();

            // a named HttpClient with AllowAutoRedirect=false so
            // forward-auth proxies (Authelia / Pangolin / Authentik) returning
            // 302 to a login URL are detected as `UpstreamRedirect` instead of
            // silently followed and producing a 200 + login HTML body.
            // SeerrHttpHelper.UseClientName(name) selects this for outbound
            // Seerr/TMDB calls.
            serviceCollection.AddHttpClient(Shared.Seerr.SeerrHttpHelper.NamedClient)
                .ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler
                {
                    AllowAutoRedirect = false,
                    UseCookies = false
                })
                .AddHttpMessageHandler(() => new Features.Seerr.Services.SeerrCsrfHandler());
            serviceCollection.AddSingleton<Logger>();
            serviceCollection.AddSingleton<UserConfigurationManager>();
            // Auto-detects newly added config-page settings by diffing the
            // embedded configPage.html against a snapshot from the previous
            // startup -- see StartupService.
            serviceCollection.AddJeAdmin();
            serviceCollection.AddJeSeerr();
            serviceCollection.AddJeCatchup();
            serviceCollection.AddJeMediaTags();
            serviceCollection.AddJeDetailsProviders();
            // In-memory, size-bounded cache + single-flight for TMDB passthrough and
            // person lookups -- see TmdbResponseCache for TTLs and why it is account-safe.
            serviceCollection.AddSingleton<TmdbResponseCache>();
            serviceCollection.AddSingleton<SeerrParentalFilter>();
            // Opt-in anonymous usage reporting: UsageEventCounterService holds the
            // current period's counters (debounced disk persistence, same pattern
            // as WikidataAwardsService); AnalyticsReportingService builds/sends the
            // payload on AnalyticsReportTask's cadence. See AnalyticsReportingService
            // for what's collected and why it's safe to ship the anon key in-client.
            serviceCollection.AddSingleton<UsageEventCounterService>();

            // Hidden Content: server-side filter for every native Jellyfin endpoint that surfaces user-facing item lists
            // (Resume, Items, Latest, NextUp, Upcoming, Suggestions, SearchHints), plus the Home Screen Sections
            // plugin's own section-content endpoint, which replaces those native lists on an HSS home screen. Same
            // filter handles "Remove from Continue Watching" via HideScope=continuewatching in hidden-content.json.
            // Maintenance Mode extras: a 30s timer that opens/closes the daily scheduled window
            // and expires timed manual windows, plus the per-playback-start reminder popup.
            serviceCollection.AddHostedService<MaintenanceScheduleService>();
            serviceCollection.AddJeEventConsumers();
            serviceCollection.AddJeHiddenContent();

            // Activity Feed: recently watched / favorited / reviewed, gated by
            // ActivityFeedEnabled. ActivityFavoriteMonitor is a Singleton that
            // self-subscribes to IUserDataManager.UserDataSaved in its own
            // constructor (see StartupService, which forces its construction).
            serviceCollection.AddJeActivity();

            serviceCollection.AddJeSpoilerGuard();
            // Request identity for the spoiler and poster-tag filters (Infrastructure); it was registered
            // between SpoilerIdentityService and SpoilerIdentityTagFilter before AddJeSpoilerGuard() (S2.13).
            serviceCollection.AddSingleton<RequestIdentityService>();

            serviceCollection.AddJeMvcFilters();
            // Last: the earlier hosted services keep their start order.
            serviceCollection.AddJeMediaTagsLateHostedServices();
        }
    }
}
