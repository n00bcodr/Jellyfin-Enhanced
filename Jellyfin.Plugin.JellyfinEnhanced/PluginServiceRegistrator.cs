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

            // Phase 4a (D41): the transport check of every automatic write, on each client a Sonarr/Radarr or Seerr
            // request can leave through (the arr and Seerr clients below, and the default one Seerr falls back to). It
            // only acts on writes made in an automation context (AutomationTransportContext); everything else passes.
            serviceCollection.AddTransient<Services.Acquire.Automation.AutomationTransportHandler>();
            serviceCollection.AddHttpClient(string.Empty)
                .AddHttpMessageHandler<Services.Acquire.Automation.AutomationTransportHandler>();

            // a named HttpClient with AllowAutoRedirect=false so
            // forward-auth proxies (Authelia / Pangolin / Authentik) returning
            // 302 to a login URL are detected as `UpstreamRedirect` instead of
            // silently followed and producing a 200 + login HTML body.
            // SeerrHttpHelper.UseClientName(name) selects this for outbound
            // Seerr/TMDB calls.
            serviceCollection.AddHttpClient(Helpers.Jellyseerr.SeerrHttpHelper.NamedClient)
                .AddHttpMessageHandler<Services.Acquire.Automation.AutomationTransportHandler>()
                .ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler
                {
                    AllowAutoRedirect = false
                });
            // Sonarr/Radarr transport: no redirects, no proxy, target address checked and pinned
            // at connect time (see ArrHttp). Per-call budgets live in ArrClient, so no HttpClient timeout.
            serviceCollection.AddHttpClient(Services.Arr.ArrHttp.ClientName)
                .AddHttpMessageHandler<Services.Acquire.Automation.AutomationTransportHandler>()
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
            // Edition availability (D44): the status service's own instance, for every surface that asks "is edition E here".
            serviceCollection.AddSingleton(sp => sp.GetRequiredService<Services.Acquire.ArrStatusService>().Editions);
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
            // Phase 4u: native Dashboard user settings.
            serviceCollection.AddSingleton<Services.Acquire.Users.AdminUserSettingsService>();
            serviceCollection.AddSingleton<Services.Acquire.Requests.RequestService>();
            // Search again for what requests already sent, once it has been missing for a long while (family Search).
            serviceCollection.AddSingleton<Services.Acquire.Requests.RequestSearchService>();
            // Phase 3c: season request rows (episode metadata + the caller's request states).
            serviceCollection.AddSingleton<Services.Acquire.Requests.SeasonRowsService>();
            // Phase 3c: collection gaps (what the caller has of a collection, what is missing).
            serviceCollection.AddSingleton<Services.Acquire.Requests.CollectionGapsService>();
            // Seerr to JE authority transfer (admin dry run, complete-or-nothing import, rollback by batch).
            serviceCollection.AddSingleton<Services.Acquire.Requests.SeerrMigrationReader>();
            // Holds JE's own Seerr request writes (proxy, Requests page, outbox) off while a move runs.
            serviceCollection.AddSingleton<Services.Acquire.Requests.SeerrRequestWriteFence>();
            serviceCollection.AddSingleton<Services.Acquire.Requests.SeerrMigration>();
            // Who asked for what, for the watchlist features (ledger or Seerr read model, with completeness).
            serviceCollection.AddSingleton<Services.Acquire.Requests.SharedRequestFacts>();
            serviceCollection.AddSingleton<Services.Acquire.Requests.RequestOutboxEvents>();
            // Phase 4a (inert while off): the automation engine's shared state (recipe modes, durable budgets, decisions,
            // eligibility grants, breakers), the send guard the outbox applies to automatic work, the no-write decision
            // seam, durable batch/confirmation operations, and the one-time migration at start-up (before the outbox).
            serviceCollection.AddSingleton<Services.Acquire.Automation.AutomationStore>();
            serviceCollection.AddSingleton<Services.Acquire.Automation.AutomationBudgets>();
            serviceCollection.AddSingleton<Services.Acquire.Automation.IAutomationTrust, Services.Acquire.Automation.NoAutomationTrust>();
            serviceCollection.AddSingleton<Services.Acquire.Automation.IAutomationConsents, Services.Acquire.Automation.UserSettingsConsents>();
            // Rounds 8-9: the version of each person's Jellyfin permissions (the automatic-write check reads them from Jellyfin's
            // database): bracketed around every Jellyfin action that can change or authenticate a user (deny by default:
            // JellyfinUserActions), and moved by its user events.
            serviceCollection.AddSingleton<Services.Acquire.Automation.JellyfinUserChangeBracket>();
            serviceCollection.Configure<MvcOptions>(o => o.Filters.AddService<Services.Acquire.Automation.JellyfinUserChangeBracket>());
            serviceCollection.AddScoped<IEventConsumer<Jellyfin.Data.Events.Users.UserUpdatedEventArgs>, Services.Acquire.Automation.JellyfinUserChangeVersion>();
            serviceCollection.AddScoped<IEventConsumer<Jellyfin.Data.Events.Users.UserDeletedEventArgs>, Services.Acquire.Automation.JellyfinUserChangeVersion>();
            serviceCollection.AddScoped<IEventConsumer<Jellyfin.Data.Events.Users.UserLockedOutEventArgs>, Services.Acquire.Automation.JellyfinUserChangeVersion>();
            serviceCollection.AddSingleton<Services.Acquire.Automation.AutomationEligibility>();
            serviceCollection.AddSingleton<Services.Acquire.Automation.AutomationDecider>();
            serviceCollection.AddSingleton<Services.Acquire.Automation.AutomationSendGuard>();
            serviceCollection.AddSingleton<Services.Acquire.Requests.RequestOperations>();
            serviceCollection.AddSingleton<Services.Acquire.Automation.AutomationStatusService>();
            serviceCollection.AddHostedService<Services.Acquire.Automation.AutomationStartup>();
            // Phase 4b (inert while off): the title facts household rules read (TMDB through the shared cache), and the
            // Trusted role behind the automation engine's trust seam (replaces 4a's "nobody is Trusted").
            serviceCollection.AddSingleton<Services.Acquire.Requests.IHouseholdRuleFacts, Services.Acquire.Requests.HouseholdRuleFacts>();
            serviceCollection.RemoveAll<Services.Acquire.Automation.IAutomationTrust>();
            serviceCollection.AddSingleton<Services.Acquire.Automation.IAutomationTrust, Services.Acquire.Requests.HouseholdTrust>();
            serviceCollection.AddSingleton<Services.Acquire.Requests.HouseholdRulesService>();

            // ---- Phase 4c1: lists (inert while off). Store, rights, Jellyfin seam, durable operations / request links /
            // swap-in events (acquire.db schema 5), the list service, list requests through the shared request service,
            // swap-in (library events; consent-gated inserts), lifecycle (deleted lists, restore reconciliation, deleted
            // users) and the experimental-list importer (D33, administrators).
            serviceCollection.AddSingleton<Services.Acquire.Lists.ListStore>();
            serviceCollection.AddSingleton<Services.Acquire.Lists.IListHost, Services.Acquire.Lists.JellyfinListHost>();
            serviceCollection.AddSingleton<Services.Acquire.Lists.ListAccessService>();
            serviceCollection.AddSingleton<Services.Acquire.Lists.ListResolver>();
            serviceCollection.AddSingleton<Services.Acquire.Lists.IListMetadataSource, Services.Acquire.Lists.ListMetadataService>();
            serviceCollection.AddSingleton<Services.Acquire.Lists.IListPreferences, Services.Acquire.Lists.UserSettingsListPreferences>();
            serviceCollection.AddSingleton<Services.Acquire.Lists.ListOperations>();
            serviceCollection.AddSingleton<Services.Acquire.Lists.ListLinks>();
            serviceCollection.AddSingleton<Services.Acquire.Lists.ListEventStore>();
            serviceCollection.AddSingleton<Services.Acquire.Lists.IListStatusSource, Services.Acquire.Lists.ArrListStatusSource>();
            serviceCollection.AddSingleton<Services.Acquire.Lists.ListSwapService>(sp => new Services.Acquire.Lists.ListSwapService(
                sp.GetRequiredService<Services.Acquire.Lists.ListStore>(),
                sp.GetRequiredService<Services.Acquire.Lists.IListHost>(),
                sp.GetRequiredService<MediaBrowser.Controller.Library.IUserManager>(),
                sp.GetRequiredService<Services.Acquire.Lists.ListResolver>(),
                sp.GetRequiredService<Services.Acquire.Lists.IListMetadataSource>(),
                sp.GetRequiredService<Logger>(),
                sp.GetRequiredService<Services.Acquire.Lists.ListEventStore>(),
                sp.GetRequiredService<Services.Acquire.Lists.IListPreferences>(),
                sp.GetRequiredService<Services.Acquire.Lists.ListAccessService>()));
            serviceCollection.AddSingleton<Services.Acquire.Lists.ListService>(sp => new Services.Acquire.Lists.ListService(
                sp.GetRequiredService<Services.Acquire.Lists.ListStore>(),
                sp.GetRequiredService<Services.Acquire.Lists.ListAccessService>(),
                sp.GetRequiredService<Services.Acquire.Lists.IListHost>(),
                sp.GetRequiredService<MediaBrowser.Controller.Library.IUserManager>(),
                sp.GetRequiredService<Logger>(),
                sp.GetRequiredService<Services.Acquire.Lists.ListResolver>(),
                sp.GetRequiredService<Services.Acquire.Lists.IListMetadataSource>(),
                sp.GetRequiredService<Services.Acquire.Lists.ListSwapService>(),
                sp.GetRequiredService<Services.Acquire.Lists.ListOperations>(),
                sp.GetRequiredService<Services.Acquire.Lists.IListStatusSource>(),
                sp.GetRequiredService<Services.Acquire.Lists.IListPreferences>(),
                user => sp.GetRequiredService<Services.Acquire.Requests.RequestService>().Me(user)));
            serviceCollection.AddSingleton<Services.Acquire.Lists.ListAcquisition>();
            serviceCollection.AddSingleton<Services.Acquire.Lists.ExperimentalListImporter>();
            serviceCollection.AddSingleton<Services.Acquire.Lists.ListLifecycle>(sp => new Services.Acquire.Lists.ListLifecycle(
                sp.GetRequiredService<MediaBrowser.Controller.Library.ILibraryManager>(),
                sp.GetRequiredService<Services.Acquire.Lists.ListStore>(),
                sp.GetRequiredService<Services.Acquire.Lists.IListHost>(),
                sp.GetRequiredService<Logger>(),
                sp.GetRequiredService<Services.Acquire.Lists.ListLinks>(),
                sp.GetRequiredService<Services.Acquire.Lists.ListOperations>(),
                sp.GetRequiredService<Services.Acquire.Lists.ListEventStore>(),
                sp.GetRequiredService<Services.Acquire.Lists.ListSwapService>()));
            serviceCollection.AddHostedService(sp => sp.GetRequiredService<Services.Acquire.Lists.ListLifecycle>());
            serviceCollection.AddHostedService<Services.Acquire.Lists.ListSwapMonitor>();
            serviceCollection.AddScoped<IEventConsumer<Jellyfin.Data.Events.Users.UserDeletedEventArgs>, Services.Acquire.Lists.ListUserPurge>();
            // ---- end Phase 4c1 ----
            // ---- Phase 4e: acquisition badges and native poster stamps (inert while off). Facts (acquire.db step 7) fed from
            // library events, the ledger / Seerr requests / follows and the arrs' history in memory; the resolver the
            // poster pipeline and GET acquire/stamps read; deleted users' facts removed.
            serviceCollection.AddSingleton<Services.Acquire.Stamps.AcquisitionStampStore>();
            serviceCollection.AddSingleton<Services.Acquire.Stamps.IStampLibrary, Services.Acquire.Stamps.JellyfinStampLibrary>();
            serviceCollection.AddSingleton<Services.Acquire.Stamps.IStampInterests, Services.Acquire.Stamps.StampInterests>();
            serviceCollection.AddSingleton<Services.Acquire.Stamps.IStampUpgrades, Services.Acquire.Stamps.ArrHistoryStampUpgrades>();
            serviceCollection.AddSingleton<Services.Acquire.Stamps.AcquisitionStampResolver>();
            serviceCollection.AddSingleton<Services.Acquire.Stamps.IAcquisitionBadgePreferences, Services.Acquire.Stamps.UserSettingsBadgePreferences>();
            serviceCollection.AddSingleton<Services.Acquire.Stamps.AcquisitionStampFeeder>();
            serviceCollection.AddHostedService(sp => sp.GetRequiredService<Services.Acquire.Stamps.AcquisitionStampFeeder>());
            serviceCollection.AddScoped<IEventConsumer<Jellyfin.Data.Events.Users.UserDeletedEventArgs>, Services.Acquire.Stamps.AcquisitionStampUserPurge>();
            // ---- end Phase 4e ----
            // ---- Phase 4c3a: list pages. Playlists page summaries (which lists have entries not in the library). ----
            serviceCollection.AddSingleton<Services.Acquire.Lists.IListPagePreferences, Services.Acquire.Lists.UserSettingsListPreferences>();
            serviceCollection.AddSingleton<Services.Acquire.Lists.ListSummaryService>();
            // ---- end Phase 4c3a ----
            serviceCollection.AddHostedService<Services.Acquire.Requests.RequestOutbox>();
            // "Keep getting new episodes": charges each new season once when a Sonarr library read shows it started.
            serviceCollection.AddHostedService<Services.Acquire.Requests.FutureSeasonCharges>();
            // Marks requests fulfilled when what they asked for is in Jellyfin (Ready; never stale).
            serviceCollection.AddHostedService<Services.Acquire.Requests.RequestFulfilment>();
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
            // Auto season / auto movie record into the request ledger while "Ask for it" (phase 3) is on.
            serviceCollection.AddSingleton<Services.AutoRequest.AutoRequestRecorder>();
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
            serviceCollection.AddScoped<IEventConsumer<Jellyfin.Data.Events.Users.UserDeletedEventArgs>, UserDeletedSettingsRemover>();
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

#if JF12
            // Native details for titles not in the library (experimental, NativeAbsentDetailsEnabled):
            // answers jellyfin-web's details requests for synthetic ids, no library rows. Inert while off
            // (synthetic ids are then refused; every other request passes straight through).
            serviceCollection.AddSingleton<Services.NativeDetails.INativeDetailsSource, Services.NativeDetails.SeerrNativeDetailsSource>();
            // The grant key is kept in the plugin's data folder, so open pages survive a restart.
            serviceCollection.AddSingleton(sp => new Services.NativeDetails.NativeDetailsArtwork(
                sp.GetRequiredService<System.Net.Http.IHttpClientFactory>(),
                JellyfinEnhanced.Instance?.DataFolderPath));
            serviceCollection.AddSingleton(sp =>
            {
                var policy = new Services.NativeDetails.NativeDetailsPolicy(
                    sp.GetRequiredService<SeerrParentalFilter>(),
                    sp.GetRequiredService<Services.NativeDetails.INativeDetailsSource>(),
                    sp.GetRequiredService<Services.Acquire.IJellyfinLibraryAccess>(),
                    sp.GetRequiredService<Services.Acquire.Requests.IRequestPolicy>(),
                    // Next to the grant key: a sign-out still ends the user's grants after a restart.
                    JellyfinEnhanced.Instance?.DataFolderPath,
                    // What the library itself holds (hidden copies, seasons and episodes are never re-made from public data).
                    new Services.NativeDetails.NativeDetailsLibrary(
                        sp.GetRequiredService<MediaBrowser.Controller.Library.ILibraryManager>(),
                        sp.GetRequiredService<Services.Acquire.TitleAliases>(),
                        () => sp.GetRequiredService<Services.Acquire.IArrJellyfinView>().Revision));
                // A sign-out (or a removed session) ends the user's artwork grants.
                var sessions = sp.GetService<MediaBrowser.Controller.Session.ISessionManager>();
                if (sessions != null) sessions.SessionEnded += (_, e) => policy.Revoke(e.SessionInfo?.UserId ?? Guid.Empty);
                return policy;
            });
            // Where cast, genres, studios and tags on those pages lead (the library's own pages first; read only).
            serviceCollection.AddSingleton(sp => new Services.NativeDetails.NativeDetailsLinks(
                sp.GetRequiredService<MediaBrowser.Controller.Library.ILibraryManager>(),
                sp.GetService<MediaBrowser.Controller.Drawing.IImageProcessor>(),
                () => sp.GetRequiredService<Services.Acquire.IArrJellyfinView>().Revision));
            serviceCollection.AddSingleton<Services.NativeDetails.NativeDetailsFacadeFilter>();
            // The filmographies and discovery feeds of those pages, filtered for the viewer on the server.
            serviceCollection.AddSingleton<Services.NativeDetails.NativeDetailsFeeds>();
            // The Requests & downloads routes (status, season rows) answer for synthetic page ids by key.
            serviceCollection.AddSingleton<Services.Acquire.IAbsentTitlePages, Services.NativeDetails.NativeDetailsPages>();
#endif

            serviceCollection.Configure<MvcOptions>(o =>
            {
                // All are IAsyncActionFilters that rewrite the response after
                // `await next()`, so post-processing runs in REVERSE registration order.
                // Identity-tag stamping must run after field-strip cache-busting so
                // clients echo the final "sb-...-jet...-jeu..." tag on image requests.
                // The poster tag image filter is registered BEFORE the blur filter so
                // it post-processes AFTER it: tags are drawn on Spoiler Guard's output.
#if JF12
                // First: a synthetic-id request is answered (or refused) before any native action or JE filter runs.
                o.Filters.AddService<Services.NativeDetails.NativeDetailsFacadeFilter>(Services.NativeDetails.NativeDetailsFacadeFilter.Order);
#endif
                o.Filters.AddService<HiddenContentResponseFilter>();
                o.Filters.AddService<SpoilerIdentityTagFilter>();
                o.Filters.AddService<SpoilerFieldStripFilter>();
                o.Filters.AddService<PosterTagImageFilter>();
                o.Filters.AddService<SpoilerBlurImageFilter>();
            });
        }
    }
}
