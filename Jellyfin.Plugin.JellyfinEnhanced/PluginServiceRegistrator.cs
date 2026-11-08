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
            // Build-target vs host-version check; logged at startup and surfaced
            // on the config page so a jf10 zip on a Jellyfin 12 host is not silent.

            // Request-time injection middlewares (Jellyfin 10.11 & 12):
            //   - ScriptInjectionStartupFilter injects the client <script> into the
            //     web index.html;
            //   - BrandingAssetStartupFilter serves custom logo/banner/favicon images.
            //     Both are kill-switchable via config and no-op safely when there's
            //     nothing to do.

            serviceCollection.AddHttpClient();

            // a named HttpClient with AllowAutoRedirect=false so
            // forward-auth proxies (Authelia / Pangolin / Authentik) returning
            // 302 to a login URL are detected as `UpstreamRedirect` instead of
            // silently followed and producing a 200 + login HTML body.
            // SeerrHttpHelper.UseClientName(name) selects this for outbound
            // Seerr/TMDB calls.
            serviceCollection.AddSingleton<Logger>();
            serviceCollection.AddSingleton<UserConfigurationManager>();
            // Auto-detects newly added config-page settings by diffing the
            // embedded configPage.html against a snapshot from the previous
            // startup -- see StartupService.
            // Matroska track languages per file (size + mtime), so tag-cache
            // rebuilds and tag-data requests don't reopen unchanged media files
            // -- see MatroskaLanguageCache for why that matters on network mounts.
            serviceCollection.AddSingleton<Helpers.MatroskaLanguageCache>();
            // Local CDN subsystem: serves every third-party static asset (icons, fonts,
            // theme sheets, flags, remote locales) from the plugin's own route, backed by
            // an on-disk cache that the RefreshCdnAssetsTask warms/refreshes every 24h.
            // Awards lookup: on-demand per-title fetch from Wikidata's public SPARQL
            // endpoint (no API key), cached to disk indefinitely for hits / with a TTL
            // for misses — see WikidataAwardsService for details.
            // Leaving soon facts (Maintainerr API or collection names), refreshed by RefreshLeavingSoonTagsTask.
            // Its Maintainerr client never follows redirects (the API key must not reach another origin).
            // In-memory, size-bounded cache + single-flight for TMDB passthrough and
            // person lookups -- see TmdbResponseCache for TTLs and why it is account-safe.
            // Server-wide trending list for the Status Tags poster badges (30-minute cache).
            // TMDB schedule facts for the Status Tags series badges (rate-limited lookups).
            // Logos tag group: daily TMDB provider/network/studio lookups and the logo image proxy cache.
            // Size / watch-progress of an item subtree in a handful of queries
            // (details-page media-info chips) -- see ItemStatsService.
            // Opt-in anonymous usage reporting: UsageEventCounterService holds the
            // current period's counters (debounced disk persistence, same pattern
            // as WikidataAwardsService); AnalyticsReportingService builds/sends the
            // payload on AnalyticsReportTask's cadence. See AnalyticsReportingService
            // for what's collected and why it's safe to ship the anon key in-client.

            // Hidden Content: server-side filter for every native Jellyfin endpoint that surfaces user-facing item lists
            // (Resume, Items, Latest, NextUp, Upcoming, Suggestions, SearchHints), plus the Home Screen Sections
            // plugin's own section-content endpoint, which replaces those native lists on an HSS home screen. Same
            // filter handles "Remove from Continue Watching" via HideScope=continuewatching in hidden-content.json.
            // Maintenance Mode extras: a 30s timer that opens/closes the daily scheduled window
            // and expires timed manual windows, plus the per-playback-start reminder popup.

            // Activity Feed: recently watched / favorited / reviewed, gated by
            // ActivityFeedEnabled. ActivityFavoriteMonitor is a Singleton that
            // self-subscribes to IUserDataManager.UserDataSaved in its own
            // constructor (see StartupService, which forces its construction).

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
            // The same policy for the Seerr, TMDB and MDBList data JE shows itself.
            serviceCollection.AddSingleton<SpoilerSeerrRedactor>();
            // Auto-enable spoiler mode for a series on first play of S1E1.
            // Gated by SpoilerAutoEnableOnFirstPlay; runs on every PlaybackStart.
            serviceCollection.AddScoped<IEventConsumer<PlaybackStartEventArgs>, SpoilerAutoEnableOnFirstPlayConsumer>();

            // Promotes pending pre-acquisition Spoiler Guard entries (PendingTmdb)
            // into real Series/Movies entries when matching library items land.
            serviceCollection.AddHostedService<SpoilerSeerrPendingPromoter>();
            // Auto-enable Spoiler Guard for every user the moment a new
            // Series/Movie lands in the library (SpoilerAutoEnableOnLibraryAdd);
            // batches a scan's ItemAdded burst into one write per user.
            serviceCollection.AddHostedService<SpoilerLibraryAddAutoEnabler>();
            // Admin-triggered "apply to existing titles": the same scope and
            // write path for titles that were already in the library. Run by
            // SpoilerApplyExistingTitlesTask; previewed by the config page.
            serviceCollection.AddSingleton<SpoilerExistingTitlesApplier>();
            // Spoiler Guard's tag-data strip, shared by GET /tag-cache, POST
            // /tag-data and native poster tags.

            serviceCollection.Configure<MvcOptions>(o =>
            {
                // All are IAsyncActionFilters that rewrite the response after
                // `await next()`, so post-processing runs in REVERSE registration order.
                // Identity-tag stamping must run after field-strip cache-busting so
                // clients echo the final "sb-...-jet...-jeu..." tag on image requests.
                // The poster tag image filter is registered BEFORE the blur filter so
                // it post-processes AFTER it: tags are drawn on Spoiler Guard's output.
                o.Filters.AddService<SpoilerIdentityTagFilter>();
                o.Filters.AddService<SpoilerFieldStripFilter>();
                o.Filters.AddService<SpoilerBlurImageFilter>();
            });
        }
    }
}
