import { asObject, shown, text } from '../domain/config';
import type { PageModules } from './modules';
import { failureDescription } from '../domain/http';
import { shortcutEntries } from '../domain/shortcuts';
import { asControl, asHtml, asInput, needControl, needHtml, needInput } from './dom';
import type { AdminConfig } from '../domain/config';

/** Dependencies this module calls; members are resolved lazily, after every module exists. */
export type LoadDeps = Pick<PageModules, 'context' | 'arr' | 'autoMovie' | 'blockedUsers' | 'customTabs' | 'dependencies' | 'dirty' | 'displayCards' | 'gatedHelp' | 'locales' | 'maintenance' | 'misc' | 'plugins' | 'regions' | 'shortcuts' | 'spoiler'>;

export function createLoad(m: LoadDeps) {
    const { ApiClient, Dashboard, JEAdmin, lifecycle, pluginId } = m.context;

    let loadSequence = 0;
    /** False from the moment a load starts until the form shows the saved settings: a save then would write the empty form over them. */
    let configLoaded = true;
    let everLoaded = false;
    /** The settings the form was filled from; after a save, the form's own values as written (save.ts). */
    let formBase: AdminConfig = {};
    let analyticsConfigured = false;
    const wired = new Set<string>();
    /** Handlers on the page's own controls: the page reloads its settings every time it is shown. */
    function wireOnce(key: string, wire: () => void): void {
        if (wired.has(key)) return;
        wired.add(key);
        wire();
    }

        function loadConfig(): void {
            const sequence = ++loadSequence;
            configLoaded = everLoaded;
            Dashboard.showLoadingMsg();
            m.plugins.checkInstalledPlugins();
            ApiClient.getPluginConfiguration(pluginId).then((config) => {
                // A newer load owns the form; a dropped view has no form to fill.
                if (sequence !== loadSequence) return;
                if (lifecycle.disposed) { Dashboard.hideLoadingMsg(); return; }
                formBase = { ...config };
                m.customTabs.CUSTOM_TAB_MANAGED_ENTRIES.forEach(function(entry) {
                    m.displayCards._jeCustomTabOwnedCache[entry.ownedKey] = config[entry.ownedKey] === true;
                });
                const stored = shortcutEntries(config.Shortcuts);
                const savedShortcuts = stored.length > 0 ? stored : m.shortcuts.defaultShortcuts;
                m.shortcuts.shortcutOverrides = savedShortcuts.filter(saved => {
                    const def = m.shortcuts.defaultShortcuts.find(d => d.Name === saved.Name);
                    return !def || saved.Key !== def.Key;
                });

                m.shortcuts.renderOverrides();
                JEAdmin.load(config);

                // Load all other settings
                needInput(document.querySelector('#maintenanceModeEnabled')).checked = !!config.MaintenanceModeEnabled;
                needHtml(document.querySelector('#maintenanceModeEnabled')).dataset.jeLoaded = String(config.MaintenanceModeEnabled === true);
                needControl(document.querySelector('#maintenanceModeMessage')).value = shown(config.MaintenanceModeMessage || '');
                needControl(document.querySelector('#maintenanceModeNotificationMessage')).value = shown(config.MaintenanceModeNotificationMessage || '');
                needControl(document.querySelector('#maintenanceModeDurationMinutes')).value = shown(config.MaintenanceModeDurationMinutes || 0);
                needInput(document.querySelector('#maintenanceModeRemindOnPlayback')).checked = !!config.MaintenanceModeRemindOnPlayback;
                needInput(document.querySelector('#maintenanceScheduleEnabled')).checked = !!config.MaintenanceScheduleEnabled;
                needHtml(document.querySelector('#maintenanceScheduleEnabled')).closest('fieldset')?.dispatchEvent(new Event('change')); // let JEAdmin re-sync the collapse
                needControl(document.querySelector('#maintenanceScheduleStart')).value = shown(config.MaintenanceScheduleStart || '00:00');
                needControl(document.querySelector('#maintenanceScheduleEnd')).value = shown(config.MaintenanceScheduleEnd || '08:00');
                m.maintenance.updateMaintenanceScheduleWarning();
                m.maintenance.refreshMaintenanceServerTime();
                needControl(document.querySelector('#maintenanceScheduleMessage')).value = shown(config.MaintenanceScheduleMessage || '');
                needControl(document.querySelector('#maintenanceScheduleNotificationMessage')).value = shown(config.MaintenanceScheduleNotificationMessage || '');
                const savedSchedAction = config.MaintenanceScheduleAction || 'none';
                needInput(document.getElementById('mmSchedAction_accounts')).checked = savedSchedAction === 'disable_accounts' || savedSchedAction === 'both';
                needInput(document.getElementById('mmSchedAction_remote')).checked   = savedSchedAction === 'disable_remote'   || savedSchedAction === 'both';
                // Restore action checkboxes
                const savedAction = config.MaintenanceModeAction || 'disable_accounts';
                needInput(document.getElementById('mmAction_accounts')).checked = savedAction === 'disable_accounts' || savedAction === 'both';
                needInput(document.getElementById('mmAction_remote')).checked   = savedAction === 'disable_remote'   || savedAction === 'both';
                // Restore user selection radio + checkboxes
                const savedUsers = config.MaintenanceModeAffectedUsers || 'all';
                if (savedUsers === 'all') {
                    needInput(document.querySelector('#mmUsers_all')).checked = true;
                    needHtml(document.getElementById('je-mm-user-list')).style.display = 'none';
                } else {
                    needInput(document.querySelector('#mmUsers_select')).checked = true;
                    needHtml(document.getElementById('je-mm-user-list')).style.display = '';
                    // Preselected IDs will be applied after the user list loads
                    needHtml(document.getElementById('je-mm-user-list')).dataset.preselect = text(savedUsers);
                }
                m.maintenance.loadMaintenanceUsers();
                needControl(document.querySelector('#TMDB_API_KEY')).value = shown(config.TMDB_API_KEY);
                m.regions.populateRegionSelect(text(config.DEFAULT_REGION));
                needControl(document.querySelector('#jellyseerr_TMDB_API_KEY')).value = shown(config.TMDB_API_KEY);

                // Set up bidirectional sync between TMDB API key fields
                const tmdbKeyField = needControl(document.querySelector('#TMDB_API_KEY'));
                const jellyseerrTmdbKeyField = needControl(document.querySelector('#jellyseerr_TMDB_API_KEY'));

                wireOnce('tmdb-key-sync', () => {
                    tmdbKeyField.addEventListener('input', function() {
                        jellyseerrTmdbKeyField.value = tmdbKeyField.value;
                    });

                    jellyseerrTmdbKeyField.addEventListener('input', function() {
                        tmdbKeyField.value = jellyseerrTmdbKeyField.value;
                    });
                });
                // Media Tags settings live on the Media Tags tab; the card shows a summary.
                m.displayCards.renderMediaTagsCard(config);
                needInput(document.querySelector('#mdblistRatingsEnabled')).checked = !!config.MdblistRatingsEnabled;
                needControl(document.querySelector('#mdblistApiKey')).value = shown(config.MdblistApiKey || '');
                needInput(document.querySelector('#mdblistRatingsShowOnItemDetails')).checked = config.MdblistRatingsShowOnItemDetails !== false;
                needInput(document.querySelector('#mdblistRatingsFetchEnabled')).checked = !!config.MdblistRatingsFetchEnabled;
                needControl(document.querySelector('#mdblistFetchReserve')).value = shown(config.MdblistFetchReserve || 400);
                needInput(document.querySelector('#mdblistRatingsAutoSyncEnabled')).checked = !!config.MdblistRatingsAutoSyncEnabled;
                needInput(document.querySelector('#mdblistRatingsOverwriteExisting')).checked = !!config.MdblistRatingsOverwriteExisting;
                needControl(document.querySelector('#mdblistCommunityRatingSource')).value = shown(config.MdblistCommunityRatingSource || 'tmdb');
                needControl(document.querySelector('#mdblistCriticRatingSource')).value = shown(config.MdblistCriticRatingSource || 'tomatoes');
                needControl(document.querySelector('#mdblistCommunityRatingFallbackSource')).value = shown(config.MdblistCommunityRatingFallbackSource || '');
                needControl(document.querySelector('#mdblistCriticRatingFallbackSource')).value = shown(config.MdblistCriticRatingFallbackSource || '');
                m.displayCards.renderMdblistSourcesAdmin(config);
                needInput(document.querySelector('#mdblistRatingsShowPercentSymbol')).checked = !!config.MdblistRatingsShowPercentSymbol;
                if (config.MdblistApiKey) m.misc.checkMdblistStatus();
                needControl(document.querySelector('#jellyseerrUrls')).value = shown(config.JellyseerrUrls);
                needControl(document.querySelector('#JellyseerrApiKey')).value = shown(config.JellyseerrApiKey);
                needControl(document.querySelector('#jellyseerrUrlMappings')).value = shown(config.JellyseerrUrlMappings || '');
                needControl(document.querySelector('#jellyseerr_TMDB_API_KEY')).value = shown(config.TMDB_API_KEY);
                const triggerType = config.AutoMovieRequestTriggerType || 'OnMinutesWatched';
                needInput(document.querySelector('#autoMovieRequestTriggerOnStart')).checked = (triggerType === 'OnStart' || triggerType === 'Both');
                needInput(document.querySelector('#autoMovieRequestTriggerOnMinutesWatched')).checked = (triggerType === 'OnMinutesWatched' || triggerType === 'Both');
                needControl(document.querySelector('#autoMovieRequestMinutesWatched')).value = shown(config.AutoMovieRequestMinutesWatched || 20);
                if ((config.AutoMovieRequestQualityMode || 'default') === 'custom') {
                    needHtml(document.querySelector('#autoMovieRequestCustomSettings')).style.display = 'block';
                    m.autoMovie.loadAutoMovieRadarrServers(config);
                }
                needControl(document.querySelector('#jellyseerrImportBlockedUsers')).value = shown(config.JellyseerrImportBlockedUsers || '');
                m.blockedUsers.loadBlockedUsersList(text(config.JellyseerrImportBlockedUsers));
                needControl(document.querySelector('#watchlistMemoryRetentionDays')).value = shown(config.WatchlistMemoryRetentionDays || 365);
                needControl(document.querySelector('#seerrScanDebounceSeconds')).value = shown(config.SeerrScanDebounceSeconds || 60);
                needInput(document.querySelector('#bookmarksUsePluginPages')).checked = config.BookmarksUsePluginPages === true;
                needInput(document.querySelector('#bookmarksUseNativeTab')).checked = config.BookmarksUseNativeTab === true;
                needInput(document.querySelector('#bookmarksUseCustomTabs')).checked = config.BookmarksUseCustomTabs === true;
                var __bAuto = asInput(document.querySelector('#bookmarksAutoCreateCustomTab'));
                if (__bAuto) __bAuto.checked = config.BookmarksAutoCreateCustomTab === true;

                // Load multi-instance Sonarr/Radarr
                m.arr.loadArrInstances(config);
                m.locales.showDefaultLanguage(text(config.DefaultLanguage));
                // Tie icon display settings
                if (config.MetadataIconsEnabled) {
                    // Force icon display where applicable
                    const showLbText = asInput(document.querySelector('#showLetterboxdLinkAsText'));
                    const showArrText = asInput(document.querySelector('#showArrLinksAsText'));
                    if (showLbText) showLbText.checked = false;
                    if (showArrText) showArrText.checked = false;
                }

                // Load extras settings

                // Usage Statistics (opt-in analytics)
                (function() {
                    var masterEl = needInput(document.querySelector('#analyticsEnabled'));
                    var subContainer = needHtml(document.getElementById('analyticsSubOptionsContainer'));
                    var flagsEl = needInput(document.querySelector('#analyticsShareFeatureFlags'));
                    var countsEl = needInput(document.querySelector('#analyticsShareUsageCounts'));
                    var sizesEl = needInput(document.querySelector('#analyticsShareDataSizes'));
                    var intervalEl = needControl(document.querySelector('#analyticsReportIntervalDays'));
                    var previewBtn = needControl(document.getElementById('analyticsPreviewBtn'));
                    var previewContainer = needHtml(document.getElementById('analyticsPreviewContainer'));
                    var previewJson = needHtml(document.getElementById('analyticsPreviewJson'));
                    var lastSentEl = needHtml(document.getElementById('analyticsLastSent'));

                    analyticsConfigured = !!config.AnalyticsHasBeenConfigured;
                    masterEl.checked = !!config.AnalyticsEnabled;
                    masterEl.closest('fieldset')?.dispatchEvent(new Event('change')); // let JEAdmin re-sync the collapse
                    flagsEl.checked = config.AnalyticsShareFeatureFlags !== false;
                    countsEl.checked = config.AnalyticsShareUsageCounts !== false;
                    sizesEl.checked = config.AnalyticsShareDataSizes !== false;
                    intervalEl.value = shown(config.AnalyticsReportIntervalDays || 15);
                    subContainer.style.display = masterEl.checked ? '' : 'none';

                    if (config.AnalyticsLastReportedAt) {
                        var d = new Date(text(config.AnalyticsLastReportedAt));
                        lastSentEl.textContent = 'Last report sent: ' + m.misc.formatDateTimeDMY(d);
                    } else {
                        lastSentEl.textContent = 'No report has been sent yet.';
                    }

                    wireOnce('analytics-master', () => masterEl.addEventListener('change', function() {
                        subContainer.style.display = masterEl.checked ? '' : 'none';
                        // Once the admin has turned the master on this session,
                        // the save handler must persist AnalyticsHasBeenConfigured
                        // EVEN IF the master is off again at save time — otherwise
                        // an enable -> uncheck a category -> disable -> save
                        // sequence stores the unchecks with the flag still false,
                        // and the next session's enable re-cascades all three
                        // over a recorded opt-out. dataset (not a closure var)
                        // because the save handler lives outside this IIFE.
                        if (masterEl.checked) masterEl.dataset.jeTouched = '1';
                        // First time the admin ever turns this on, default every
                        // sub-category to shared; after that, leave their choices alone.
                        if (masterEl.checked && !analyticsConfigured) {
                            flagsEl.checked = true;
                            countsEl.checked = true;
                            sizesEl.checked = true;
                            // One-shot: mark configured on the page copy too, or an
                            // off/on toggle in the same session re-forces all three
                            // and silently reverts a deliberate uncheck (the server
                            // copy only updates on save, the closure never does).
                            analyticsConfigured = true;
                            // The programmatic .checked writes above fire no change
                            // events, so refresh an open preview by hand — it must
                            // never show less than what would now be sent.
                            if (previewContainer.style.display !== 'none') runPreview();
                        }
                    }));

                    // Monotonic token: runPreview has several auto-triggers
                    // (button, sub-toggle changes, the first-enable cascade),
                    // and overlapping responses would otherwise race
                    // last-write-wins — the preview could show a payload
                    // contradicting the current checkboxes.
                    var previewSeq = 0;
                    async function runPreview() {
                        var seq = ++previewSeq;
                        previewBtn.disabled = true;
                        try {
                            var res = await ApiClient.ajax({
                                type: 'POST',
                                url: ApiClient.getUrl('/JellyfinEnhanced/usage/preview'),
                                data: JSON.stringify({
                                    shareFeatureFlags: flagsEl.checked,
                                    shareUsageCounts: countsEl.checked,
                                    shareDataSizes: sizesEl.checked
                                }),
                                contentType: 'application/json',
                                dataType: 'json'
                            });
                            if (seq !== previewSeq) return; // superseded by a newer preview
                            previewJson.textContent = JSON.stringify(asObject(res).Payload, null, 2);
                            previewContainer.style.display = '';
                        } catch (err) {
                            if (seq !== previewSeq) return; // superseded by a newer preview
                            // ApiClient.ajax rejects with the fetch Response on a
                            // non-2xx (no .message), so build something readable
                            // instead of "[object Response]".
                            var reason = failureDescription(err, 'check server logs');
                            previewJson.textContent = 'Failed to build preview: ' + reason;
                            previewContainer.style.display = '';
                        } finally {
                            if (seq === previewSeq) previewBtn.disabled = false;
                        }
                    }

                    wireOnce('analytics-preview', () => {
                        previewBtn.addEventListener('click', runPreview);
                        // Re-run automatically once a preview has been shown, so toggling a
                        // sub-option updates it live instead of looking stuck until re-clicked.
                        [flagsEl, countsEl, sizesEl].forEach(function(el) {
                            el.addEventListener('change', function() {
                                if (previewContainer.style.display !== 'none') runPreview();
                            });
                        });
                    });
                })();

                needInput(document.querySelector('#activityFeedUseNativeTab')).checked = config.ActivityFeedUseNativeTab === true;
                needInput(document.querySelector('#activityFeedUsePluginPages')).checked = config.ActivityFeedUsePluginPages === true;
                needInput(document.querySelector('#catchUpUsePluginPages')).checked = config.CatchUpUsePluginPages === true;
                needInput(document.querySelector('#catchUpUseNativeTab')).checked = config.CatchUpUseNativeTab === true;
                needInput(document.querySelector('#catchUpUseCustomTabs')).checked = config.CatchUpUseCustomTabs === true;
                var __cuAuto = asInput(document.querySelector('#catchUpAutoCreateCustomTab'));
                if (__cuAuto) __cuAuto.checked = config.CatchUpAutoCreateCustomTab === true;
                needInput(document.querySelector('#activityFeedUseCustomTabs')).checked = config.ActivityFeedUseCustomTabs === true;
                var __aAuto = asInput(document.querySelector('#activityFeedAutoCreateCustomTab'));
                if (__aAuto) __aAuto.checked = config.ActivityFeedAutoCreateCustomTab === true;

                // Requests Page settings
                needInput(document.querySelector('#downloadsUsePluginPages')).checked = config.DownloadsUsePluginPages !== false;
                needInput(document.querySelector('#downloadsUseNativeTab')).checked = config.DownloadsUseNativeTab === true;
                needInput(document.querySelector('#downloadsUseCustomTabs')).checked = config.DownloadsUseCustomTabs === true;
                var __dAuto = asInput(document.querySelector('#downloadsAutoCreateCustomTab'));
                if (__dAuto) __dAuto.checked = config.DownloadsAutoCreateCustomTab === true;

                // Calendar Page settings
                needInput(document.querySelector('#calendarUseCustomTabs')).checked = config.CalendarUseCustomTabs === true;
                needInput(document.querySelector('#calendarUseNativeTab')).checked = config.CalendarUseNativeTab === true;
                var __cAuto = asInput(document.querySelector('#calendarAutoCreateCustomTab'));
                if (__cAuto) __cAuto.checked = config.CalendarAutoCreateCustomTab === true;
                needInput(document.querySelector('#calendarUsePluginPages')).checked = config.CalendarUsePluginPages !== false;

                // Recommendations Page settings
                needInput(document.querySelector('#recommendationsUseNativeTab')).checked = config.RecommendationsUseNativeTab === true;
                needInput(document.querySelector('#recommendationsUsePluginPages')).checked = config.RecommendationsUsePluginPages === true;
                needInput(document.querySelector('#recommendationsUseCustomTabs')).checked = config.RecommendationsUseCustomTabs === true;
                var __rAuto = asInput(document.querySelector('#recommendationsAutoCreateCustomTab'));
                if (__rAuto) __rAuto.checked = config.RecommendationsAutoCreateCustomTab === true;

                // Hidden Content settings
                needInput(document.querySelector('#hiddenContentUsePluginPages')).checked = config.HiddenContentUsePluginPages === true;
                needInput(document.querySelector('#hiddenContentUseNativeTab')).checked = config.HiddenContentUseNativeTab === true;
                needInput(document.querySelector('#hiddenContentUseCustomTabs')).checked = config.HiddenContentUseCustomTabs === true;
                var __hAuto = asInput(document.querySelector('#hiddenContentAutoCreateCustomTab'));
                if (__hAuto) __hAuto.checked = config.HiddenContentAutoCreateCustomTab === true;

                // Spoiler Guard settings
                needInput(document.querySelector('#spoilerBlurEnabled')).checked = config.SpoilerBlurEnabled === true;
                var __sbSigma = asControl(document.querySelector('#spoilerBlurIntensity'));
                const blurIntensity = config.SpoilerBlurIntensity;
                if (__sbSigma) __sbSigma.value = (typeof blurIntensity === 'number' && blurIntensity >= 5 && blurIntensity <= 100) ? String(blurIntensity) : '40';
                var __sbMode = asControl(document.querySelector('#spoilerBlurMode'));
                if (__sbMode) __sbMode.value = (config.SpoilerBlurMode === 'blur') ? 'blur' : 'hide';
                // Field-strip toggles. Defaults match PluginConfiguration:
                // every hide toggle defaults ON (strictest sensible posture
                // when the admin enables Spoiler Guard); the artwork +
                // auto-enable toggles default OFF.
                const spoilerToggles: ReadonlyArray<readonly [string, string, boolean]> = [
                    // A null value means this config predates the independent
                    // Series switch. Mirror the old episode-overview value on
                    // first load so upgrading does not silently change policy.
                    ['spoilerStripSeriesOverview',  'SpoilerStripSeriesOverview',  config.SpoilerStripOverview !== false],
                    ['spoilerStripOverview',        'SpoilerStripOverview',        true],
                    ['spoilerStripTags',            'SpoilerStripTags',            true],
                    ['spoilerStripChapters',        'SpoilerStripChapters',        true],
                    ['spoilerStripTaglines',        'SpoilerStripTaglines',        true],
                    ['spoilerStripRatings',         'SpoilerStripRatings',         true],
                    ['spoilerStripPremiereDate',    'SpoilerStripPremiereDate',    true],
                    ['spoilerReplaceTitle',         'SpoilerReplaceTitle',         true],
                    ['spoilerStripCast',            'SpoilerStripCast',            true],
                    ['spoilerStripReviews',         'SpoilerStripReviews',         true],
                    ['spoilerBlurArtwork',          'SpoilerBlurArtwork',          false],
                    ['spoilerAutoEnableOnFirstPlay','SpoilerAutoEnableOnFirstPlay',false],
                    ['spoilerAutoEnableOnSeerrRequest','SpoilerAutoEnableOnSeerrRequest',false],
                    ['spoilerAutoEnableOnLibraryAdd','SpoilerAutoEnableOnLibraryAdd',false],
                    // Auto-enable scope defaults to everything so upgrading
                    // doesn't narrow the existing first-play / Seerr modes.
                    ['spoilerAutoEnableSeries',     'SpoilerAutoEnableSeries',     true],
                    ['spoilerAutoEnableMovies',     'SpoilerAutoEnableMovies',     true],
                    ['spoilerBlurStrictRefresh',    'SpoilerBlurStrictRefresh',    false],
                    ['spoilerKeepMoviePosters',     'SpoilerKeepMoviePosters',     true],
                    ['spoilerBlurTrickplay',        'SpoilerBlurTrickplay',        true],
                    // Advanced per-category reveals. The master switch is off
                    // for existing installs; the category masks keep the
                    // strictest posture except the next-episode title, which
                    // is the reveal advanced mode exists for.
                    ['spoilerAdvancedMode',              'SpoilerAdvancedMode',              false],
                    ['spoilerNextEpisodeStripTitle',     'SpoilerNextEpisodeStripTitle',     false],
                    ['spoilerNextEpisodeStripOverview',  'SpoilerNextEpisodeStripOverview',  true],
                    ['spoilerNextEpisodeStripRatings',   'SpoilerNextEpisodeStripRatings',   true],
                    ['spoilerNextEpisodeStripImage',     'SpoilerNextEpisodeStripImage',     true],
                    ['spoilerCurrentSeasonStripTitle',   'SpoilerCurrentSeasonStripTitle',   true],
                    ['spoilerCurrentSeasonStripOverview','SpoilerCurrentSeasonStripOverview',true],
                    ['spoilerCurrentSeasonStripRatings', 'SpoilerCurrentSeasonStripRatings', true],
                ];
                spoilerToggles.forEach(function (t) {
                    var el = asInput(document.querySelector('#' + t[0]));
                    if (!el) return;
                    var v = config[t[1]];
                    el.checked = (v === undefined || v === null) ? t[2] : !!v;
                });
                var __sbCastMode = asControl(document.querySelector('#spoilerStripCastMode'));
                if (__sbCastMode) __sbCastMode.value = shown(config.SpoilerStripCastMode === 'All' ? 'All' : 'GuestStars');
                var __sbPlaceholder = asControl(document.querySelector('#spoilerOverviewPlaceholder'));
                if (__sbPlaceholder) __sbPlaceholder.value = shown(config.SpoilerOverviewPlaceholder || 'Spoiler Guard activated');
                m.spoiler.renderSpoilerAutoEnableLibraries(text(config.SpoilerAutoEnableLibraryIds));


                // The two "don't re-add" rows follow the removal mode and the toggle (dependencies.ts);
                // updateAllDependencies below sets their initial state.
                wireOnce('watchlist-retention', () => {
                    for (const id of ['#preventWatchlistReAddition', '#watchlistRemovalSync']) {
                        needHtml(document.querySelector(id)).addEventListener('change', m.dependencies.updateWatchlistMemoryVisibility);
                    }
                });

                // Update TMDB-dependent settings after config is loaded
                m.gatedHelp.updateAllDependencies();

                // Refresh the Requests Page requirements banner off freshly-
                // rendered instance cards and loaded Seerr fields.
                m.arr.updateRequestsRequirementsBanner();

                configLoaded = true;
                everLoaded = true;
                m.plugins.setProbeWarning('config', null);
                Dashboard.hideLoadingMsg();
                // Delay so late-finishing sub-populations (maintenance users, branding previews) settle first.
                lifecycle.timeout(m.dirty.jeMarkSaved, 500);
            }).catch((err) => {
                if (sequence !== loadSequence) return;
                Dashboard.hideLoadingMsg();
                console.error('🪼 Jellyfin Enhanced: could not read the plugin configuration', err);
                if (lifecycle.disposed || configLoaded) return;
                m.plugins.setProbeWarning('config', "Couldn't read the saved settings, so these controls do not show them and saving is disabled. Retry, or reload this page.");
            });
        }

    /** Runs this module's start-up work, in the page's original order. */
    function wire(): void {

    }

    return {
        wire,
        loadConfig,
        get configLoaded() { return configLoaded; },
        get formBase() { return formBase; },
        set formBase(values: AdminConfig) { formBase = values; },
    };
}
