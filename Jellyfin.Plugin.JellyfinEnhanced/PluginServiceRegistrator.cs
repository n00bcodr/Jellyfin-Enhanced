using System.Net.Http;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.EventHandlers;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags;
using Jellyfin.Plugin.JellyfinEnhanced.Services.PosterTags.Rendering;
using Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks;
using MediaBrowser.Controller.Events;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Plugins;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
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
            // Sonarr/Radarr transport: no redirects, no proxy, target address checked and pinned
            // at connect time (see ArrHttp). Per-call budgets live in ArrClient, so no HttpClient timeout.
            serviceCollection.AddHttpClient(Services.Arr.ArrHttp.ClientName)
                .ConfigureHttpClient(c => c.Timeout = System.Threading.Timeout.InfiniteTimeSpan)
                .ConfigurePrimaryHttpMessageHandler(Services.Arr.ArrHttp.CreateHandler);
            // "Requests & downloads (new)" foundations: the instance registry (v2), one client per
            // instance, and the audited action runner for direct arr writes.
            serviceCollection.AddSingleton<Services.Arr.ArrInstanceRegistry>();
            serviceCollection.AddSingleton<Services.Arr.ArrClientFactory>();
            serviceCollection.AddSingleton<Services.Arr.ArrAuditLog>();
            serviceCollection.AddSingleton<Services.Arr.ArrConfirmationTokens>();
            serviceCollection.AddSingleton<Services.Arr.ArrActionRunner>();
            // In-memory arr snapshots (library index, queue, history, calendar, system) behind the
            // Downloads/Calendar/link routes, and the loop that keeps the ones in use fresh.
            serviceCollection.AddSingleton<Services.Arr.ArrStateStore>();
            serviceCollection.AddHostedService<Services.Arr.ArrStateReconciler>();
            // Phase 1 status on pages: the Jellyfin side of the status composer, the request facts
            // (Seerr's requests, read in the background by the read model) and the per-user status service.
            serviceCollection.AddSingleton<Services.Acquire.IArrJellyfinView, Services.Acquire.ArrJellyfinView>();
            serviceCollection.AddSingleton<Services.Acquire.SeerrRequestReadModel>();
            serviceCollection.AddHostedService(sp => sp.GetRequiredService<Services.Acquire.SeerrRequestReadModel>());
            serviceCollection.TryAddSingleton<Services.Acquire.IArrRequestFacts, Services.Acquire.Requests.LedgerRequestFacts>();
            serviceCollection.AddSingleton<Services.Acquire.TitleAliases>();
            serviceCollection.AddSingleton<Services.Acquire.ArrStatusService>();
            // Discover rows and the search row for the JE request backend (TMDB, filtered per caller).
            serviceCollection.AddSingleton<Services.Acquire.Requests.DiscoverService>();
            // The Requests page (everyone's own requests) and the administrator's Manage drawer.
            serviceCollection.AddSingleton<Services.Acquire.RequestsHubService>();
            serviceCollection.AddSingleton<Services.Acquire.ArrManageService>();
            // Phase 2 (admin essentials): the hub's admin tabs, queue actions, the Jellyfin bridge
            // (targeted refresh after imports, not-in-Jellyfin list, path doctor) and the activity log mirror.
            serviceCollection.AddSingleton<Services.Acquire.IJellyfinLibraryAccess, Services.Acquire.JellyfinLibraryAccess>();
            serviceCollection.AddSingleton(sp => new Services.Acquire.ArrInstanceLibraries(sp.GetRequiredService<Services.Arr.ArrStateStore>(), sp.GetRequiredService<Services.Acquire.IJellyfinLibraryAccess>()) { Parental = sp.GetRequiredService<Services.SeerrParentalFilter>() });
            serviceCollection.AddSingleton<Services.Acquire.JellyfinBridge>();
            serviceCollection.AddHostedService(sp => sp.GetRequiredService<Services.Acquire.JellyfinBridge>());
            serviceCollection.AddSingleton<Services.Acquire.ArrAdminHubService>();
            serviceCollection.AddSingleton<Services.Acquire.ArrQueueActionService>();
            serviceCollection.AddSingleton<Services.Arr.ArrActivityMirror>();
            serviceCollection.AddHostedService(sp => sp.GetRequiredService<Services.Arr.ArrActivityMirror>());
            serviceCollection.AddSingleton<Services.Acquire.ArrAdminOpsFeed>();
            serviceCollection.AddHostedService(sp => sp.GetRequiredService<Services.Acquire.ArrAdminOpsFeed>());
            // Live updates (phase 1, inert while off): the change feed browsers long-poll, what feeds
            // it (snapshot diffs, Jellyfin library adds/removes), one SignalR connection per arr,
            // the webhook receiver + one-click set-up, and the re-reads live hints trigger.
            serviceCollection.AddSingleton<Services.Arr.Live.ArrChangeFeed>();
            serviceCollection.AddSingleton<Services.Arr.Live.ArrFeedLimits>();
            serviceCollection.AddSingleton<Services.Arr.Live.IArrFeedAudience, Services.Arr.Live.ArrFeedAudience>();
            serviceCollection.AddSingleton<Services.Arr.Live.ArrLiveRouter>();
            serviceCollection.AddSingleton<Services.Arr.Live.ArrChangeTracker>();
            serviceCollection.AddHostedService(sp => sp.GetRequiredService<Services.Arr.Live.ArrChangeTracker>());
            serviceCollection.AddSingleton<Services.Arr.Live.ArrLiveService>();
            serviceCollection.AddHostedService(sp => sp.GetRequiredService<Services.Arr.Live.ArrLiveService>());
            serviceCollection.AddSingleton<Services.Arr.Live.ArrWebhookReceiver>();
            serviceCollection.AddSingleton<Services.Arr.Live.ArrWebhookProvisioner>();
            // Requests & downloads, phase 2 (inert while off): the SQLite database (follows, inbox,
            // deliveries), notifications driven by the change feed, and their delivery to ntfy and
            // e-mail (admin-configured endpoints only; ntfy over the guarded, no-redirect transport).
            serviceCollection.AddHttpClient(Services.Acquire.Notify.NotifyEndpoints.ClientName)
                .ConfigureHttpClient(c => c.Timeout = System.Threading.Timeout.InfiniteTimeSpan)
                .ConfigurePrimaryHttpMessageHandler(Services.Arr.ArrHttp.CreateHandler);
            serviceCollection.AddSingleton<Services.Acquire.Requests.RequestLedger>();
            // Request executors (phase 3): Jellyfin Enhanced's own Sonarr/Radarr writes and Seerr, picked
            // per job by the mode it was authorised in; the signal wakes the outbox when work is queued.
            serviceCollection.AddSingleton<Services.Acquire.Requests.DirectArrBackend>();
            serviceCollection.AddSingleton<Services.Acquire.Requests.SeerrBackend>();
            serviceCollection.AddSingleton<Services.Acquire.Requests.IRequestBackend, Services.Acquire.Requests.RequestBackendRouter>();
            serviceCollection.AddSingleton<Services.Acquire.Requests.RequestOutboxSignal>();
            serviceCollection.AddSingleton<Services.Acquire.Requests.ArrAddService>();
            serviceCollection.AddSingleton<Services.Acquire.Requests.IRequestPolicy, Services.Acquire.Requests.RequestPolicy>();
            serviceCollection.AddSingleton<Services.Acquire.Requests.RequestTitleLocks>();
            // Phase 3c hub: approval cards, own requests, chip bar counts and the Household tab.
            serviceCollection.AddSingleton<Services.Acquire.Requests.IHouseholdDirectory, Services.Acquire.Requests.JellyfinHouseholdDirectory>();
            serviceCollection.AddSingleton<Services.Acquire.Requests.IRequestPlaces, Services.Acquire.Requests.RequestPlaces>();
            serviceCollection.AddSingleton<Services.Acquire.Requests.RequestHubProjection>();
            serviceCollection.AddSingleton<Services.Acquire.Requests.HouseholdService>();
            serviceCollection.AddSingleton<Services.Acquire.Requests.RequestService>();
            // Phase 3c: season request rows (episode metadata + the caller's request states).
            serviceCollection.AddSingleton<Services.Acquire.Requests.SeasonRowsService>();
            // Phase 3c: collection gaps (what the caller has of a collection, what is missing).
            serviceCollection.AddSingleton<Services.Acquire.Requests.CollectionGapsService>();
            serviceCollection.AddHostedService<Services.Acquire.Requests.RequestOutbox>();
            serviceCollection.AddSingleton<Services.Acquire.AcquireDatabase>();
            serviceCollection.AddSingleton<Services.Acquire.Notify.NotifyStore>();
            serviceCollection.AddSingleton<Services.Acquire.Notify.INotifyUsers, Services.Acquire.Notify.JellyfinNotifyUsers>();
            serviceCollection.AddSingleton<Services.Acquire.Notify.NtfySender>();
            serviceCollection.AddSingleton<Services.Acquire.Notify.IMailTransport, Services.Acquire.Notify.SmtpMailTransport>();
            serviceCollection.AddSingleton<Services.Acquire.Notify.EmailSender>();
            serviceCollection.AddSingleton<Services.Acquire.Notify.NotifyDispatcher>();
            serviceCollection.AddHostedService(sp => sp.GetRequiredService<Services.Acquire.Notify.NotifyDispatcher>());
            serviceCollection.AddSingleton<Services.Acquire.Notify.NotificationService>();
            serviceCollection.AddHostedService(sp => sp.GetRequiredService<Services.Acquire.Notify.NotificationService>());
            // JE backup/export/restore (Jellyfin's own backups don't include plugin data).
            serviceCollection.AddSingleton<Services.Backup.JeBackupService>();
            serviceCollection.AddTransient<JeBackupTask>();
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
            serviceCollection.AddSingleton<CatchUpLogService>();
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
            // In-memory, size-bounded cache + single-flight for TMDB passthrough and
            // person lookups -- see TmdbResponseCache for TTLs and why it is account-safe.
            serviceCollection.AddSingleton<TmdbResponseCache>();
            // Size / watch-progress of an item subtree in a handful of queries
            // (details-page media-info chips) -- see ItemStatsService.
            serviceCollection.AddSingleton<ItemStatsService>();
            serviceCollection.AddSingleton<SeerrParentalFilter>();
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
            serviceCollection.AddTransient<AudioLanguageTagsSyncTask>();
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
            // Maintenance Mode extras: a 30s timer that opens/closes the daily scheduled window
            // and expires timed manual windows, plus the per-playback-start reminder popup.
            serviceCollection.AddHostedService<MaintenanceScheduleService>();
            serviceCollection.AddScoped<IEventConsumer<PlaybackStartEventArgs>, MaintenancePlaybackReminderConsumer>();
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
            serviceCollection.AddScoped<IEventConsumer<Jellyfin.Data.Events.Users.UserUpdatedEventArgs>, ReviewAuthorCacheInvalidator>();
            serviceCollection.AddScoped<IEventConsumer<Jellyfin.Data.Events.Users.UserDeletedEventArgs>, ReviewAuthorCacheInvalidator>();
            serviceCollection.AddScoped<IEventConsumer<Jellyfin.Data.Events.Users.UserLockedOutEventArgs>, ReviewAuthorCacheInvalidator>();
            serviceCollection.AddScoped<IEventConsumer<Jellyfin.Data.Events.Users.UserUpdatedEventArgs>, TagCacheAccessInvalidator>();
            serviceCollection.AddScoped<IEventConsumer<Jellyfin.Data.Events.Users.UserDeletedEventArgs>, TagCacheAccessInvalidator>();
            // Requests & downloads: a deleted user's follows, alert settings and inbox go with them
            // (also while notifications are off; never creates the database).
            serviceCollection.AddScoped<IEventConsumer<Jellyfin.Data.Events.Users.UserDeletedEventArgs>, Services.Acquire.Notify.NotifyUserPurge>();

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
            serviceCollection.AddSingleton<SpoilerTagDataStripper>();

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
            serviceCollection.AddSingleton<PosterTagComposer>();
            serviceCollection.AddSingleton<NativePosterTagStamper>();
            serviceCollection.AddSingleton<PosterTagImageFilter>();

            serviceCollection.Configure<MvcOptions>(o =>
            {
                // All are IAsyncActionFilters that rewrite the response after
                // `await next()`, so post-processing runs in REVERSE registration order.
                // Identity-tag stamping must run after field-strip cache-busting so
                // clients echo the final "sb-...-jet...-jeu..." tag on image requests.
                // The poster tag image filter is registered BEFORE the blur filter so
                // it post-processes AFTER it: tags are drawn on Spoiler Guard's output.
                o.Filters.AddService<HiddenContentResponseFilter>();
                o.Filters.AddService<SpoilerIdentityTagFilter>();
                o.Filters.AddService<SpoilerFieldStripFilter>();
                o.Filters.AddService<PosterTagImageFilter>();
                o.Filters.AddService<SpoilerBlurImageFilter>();
            });
        }
    }
}
