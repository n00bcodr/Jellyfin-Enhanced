import type { PageModules } from './modules';
import { isAbortError } from '../domain/http';
import type { WriteScope } from '../domain/write-scope';
import { autoMovieTrigger, clampedInt, httpUrls, lines, maintenanceAction } from '../domain/config-values';
import { asObject, stringList, text } from '../domain/config';
import { shortcutsToJson } from '../domain/shortcuts';
import { asControl, asHtml, asInput, eventDetail, needControl, needHtml, needInput } from './dom';
import type { AdminConfig } from '../domain/config';
import type { CustomTabsSyncResult } from './types';

/** Dependencies this module calls; members are resolved lazily, after every module exists. */
export type SaveDeps = Pick<PageModules, 'context' | 'arr' | 'blockedUsers' | 'customTabs' | 'dirty' | 'displayCards' | 'gatedHelp' | 'maintenance' | 'mediaTagsTab' | 'shortcuts' | 'spoiler' | 'load'>;

export function createSave(m: SaveDeps) {
    const { ApiClient, Dashboard, JEAdmin, lifecycle, pluginId } = m.context;

            const resetAllUserSettingsBtn = asHtml(document.querySelector('#resetAllUserSettingsBtn'));

        /** The form's own values in each configuration buildConfigFromForm returned, before the merge. */
        const formValues = new WeakMap<AdminConfig, AdminConfig>();
        /** Whether maintenance mode was on in the configuration the last build read, before the form's value. */
        let maintenanceWasOn = false;

        async function buildConfigFromForm(scope: WriteScope) : Promise<AdminConfig> {
            if (!m.load.configLoaded) throw new Error('the saved settings have not been read');
            scope.throwIfStale();
            const config = await ApiClient.getPluginConfiguration(pluginId);
            scope.throwIfStale();
            const stored = { ...config };
            maintenanceWasOn = config.MaintenanceModeEnabled === true;
            const finalShortcuts = [...m.shortcuts.defaultShortcuts];
            m.shortcuts.shortcutOverrides.forEach(override => {
                const index = finalShortcuts.findIndex(s => s.Name === override.Name);
                if (index !== -1) finalShortcuts[index] = override;
            });
            config.Shortcuts = shortcutsToJson(finalShortcuts);
            JEAdmin.collect(config);
            // A timed window switches maintenance off by itself (and another admin or the API can
            // flip it) while this page is open. When the toggle was not touched since it was loaded,
            // keep the server's current value so saving unrelated settings never quietly starts a
            // new window or ends someone else's.
            const mmToggle = needInput(document.querySelector('#maintenanceModeEnabled'));
            const mmServerEnabled = String(config.MaintenanceModeEnabled === true);
            if (String(mmToggle.checked) === mmToggle.dataset.jeLoaded && mmServerEnabled !== mmToggle.dataset.jeLoaded) {
                mmToggle.checked = config.MaintenanceModeEnabled === true;
            }
            mmToggle.dataset.jeLoaded = String(mmToggle.checked);
            config.MaintenanceModeEnabled = mmToggle.checked;
            config.MaintenanceModeMessage = needControl(document.querySelector('#maintenanceModeMessage')).value;
            config.MaintenanceModeNotificationMessage = needControl(document.querySelector('#maintenanceModeNotificationMessage')).value;
            // Clamped (0 .. one year): a value past int range would fail the whole config save.
            config.MaintenanceModeDurationMinutes = Math.min(525600, Math.max(0, parseInt(needControl(document.querySelector('#maintenanceModeDurationMinutes')).value, 10) || 0));
            config.MaintenanceModeRemindOnPlayback = needInput(document.querySelector('#maintenanceModeRemindOnPlayback')).checked;
            config.MaintenanceScheduleEnabled = needInput(document.querySelector('#maintenanceScheduleEnabled')).checked;
            config.MaintenanceScheduleStart = needControl(document.querySelector('#maintenanceScheduleStart')).value || '00:00';
            config.MaintenanceScheduleEnd = needControl(document.querySelector('#maintenanceScheduleEnd')).value || '08:00';
            config.MaintenanceScheduleMessage = needControl(document.querySelector('#maintenanceScheduleMessage')).value;
            config.MaintenanceScheduleNotificationMessage = needControl(document.querySelector('#maintenanceScheduleNotificationMessage')).value;
            const mmSchedAccounts = needInput(document.getElementById('mmSchedAction_accounts')).checked;
            const mmSchedRemote   = needInput(document.getElementById('mmSchedAction_remote')).checked;
            config.MaintenanceScheduleAction = maintenanceAction(mmSchedAccounts, mmSchedRemote);
            const mmAccounts = needInput(document.getElementById('mmAction_accounts')).checked;
            const mmRemote   = needInput(document.getElementById('mmAction_remote')).checked;
            config.MaintenanceModeAction = maintenanceAction(mmAccounts, mmRemote);
            const mmUsersMode = (asControl(document.querySelector('input[name="maintenanceModeUsers"]:checked')) || {}).value || 'all';
            // Until the user list has loaded there are no boxes to read, and "[]" would mean every non-admin
            // user: the fresh read above then keeps the stored selection.
            if (mmUsersMode === 'all') {
                config.MaintenanceModeAffectedUsers = 'all';
            } else if (m.maintenance.usersLoaded) {
                const checked = Array.from(document.querySelectorAll<HTMLInputElement>('.je-mm-user-cb:checked')).map(cb => cb.value);
                config.MaintenanceModeAffectedUsers = JSON.stringify(checked);
            }
            config.TMDB_API_KEY = needControl(document.querySelector('#TMDB_API_KEY')).value;
            config.DEFAULT_REGION = needControl(document.querySelector('#DEFAULT_REGION')).value;
            // Media Tags settings are saved by the Media Tags tab, one field at a time: the
            // fresh configuration read above keeps them as they are.
            config.MdblistRatingsEnabled = needInput(document.querySelector('#mdblistRatingsEnabled')).checked;
            config.MdblistApiKey = needControl(document.querySelector('#mdblistApiKey')).value.trim();
            config.MdblistRatingsShowOnItemDetails = needInput(document.querySelector('#mdblistRatingsShowOnItemDetails')).checked;
            config.MdblistRatingsFetchEnabled = needInput(document.querySelector('#mdblistRatingsFetchEnabled')).checked;
            config.MdblistFetchReserve = parseInt(needControl(document.querySelector('#mdblistFetchReserve')).value, 10) || 400;
            config.MdblistRatingsAutoSyncEnabled = needInput(document.querySelector('#mdblistRatingsAutoSyncEnabled')).checked;
            config.MdblistRatingsOverwriteExisting = needInput(document.querySelector('#mdblistRatingsOverwriteExisting')).checked;
            config.MdblistCommunityRatingSource = needControl(document.querySelector('#mdblistCommunityRatingSource')).value;
            config.MdblistCriticRatingSource = needControl(document.querySelector('#mdblistCriticRatingSource')).value;
            config.MdblistCommunityRatingFallbackSource = needControl(document.querySelector('#mdblistCommunityRatingFallbackSource')).value;
            config.MdblistCriticRatingFallbackSource = needControl(document.querySelector('#mdblistCriticRatingFallbackSource')).value;
            config.MdblistRatingsSources = m.displayCards.computeMdblistRatingsSources();
            config.MdblistRatingsShowPercentSymbol = needInput(document.querySelector('#mdblistRatingsShowPercentSymbol')).checked;
            // validate scheme on save. Lines that don't parse as
            // http(s) are dropped with a warning so we never persist garbage
            // like "seerr.local" (no scheme) — which downstream string-concats
            // produce malformed URIs and a confusing UriFormatException buried
            // in logs. Empty textarea remains valid (Seerr can be disabled).
            const seerrUrls = httpUrls(lines(needControl(document.querySelector('#jellyseerrUrls')).value));
            const invalid = seerrUrls.invalid;
            if (invalid.length > 0) {
                    console.warn('Jellyfin Enhanced: dropping invalid Seerr URL(s) on save (must start with http:// or https://):', invalid);
                    if (Dashboard.alert) {
                        Dashboard.alert({
                            title: 'Invalid Seerr URL(s)',
                            message: 'These lines were dropped because they do not start with http:// or https://:\n\n' + invalid.join('\n')
                        });
                    }
                }
            config.JellyseerrUrls = seerrUrls.valid.join('\n');
            config.JellyseerrApiKey = (needControl(document.querySelector('#JellyseerrApiKey')).value || '').replace(/\s/g, '');
            config.JellyseerrUrlMappings = (needControl(document.querySelector('#jellyseerrUrlMappings')).value || '').split('\n').map(u => u.trim()).filter(Boolean).join('\n');
            config.TMDB_API_KEY = needControl(document.querySelector('#jellyseerr_TMDB_API_KEY')).value;
            const onStart = needInput(document.querySelector('#autoMovieRequestTriggerOnStart')).checked;
            const onMinutes = needInput(document.querySelector('#autoMovieRequestTriggerOnMinutesWatched')).checked;
            config.AutoMovieRequestTriggerType = autoMovieTrigger(onStart, onMinutes);
            config.AutoMovieRequestMinutesWatched = clampedInt(needControl(document.querySelector('#autoMovieRequestMinutesWatched')).value, 20, 1, 180);
            // These selects hold a placeholder until Seerr's list for them is in (Seerr down or slow, or the mode
            // not "Custom"): the fresh read above then keeps the stored values. The stored profile and folder
            // belong to the stored server, so for another server the selects' values are saved.
            const serverSelect = needControl(document.querySelector('#autoMovieRequestServer'));
            const profileSelect = needControl(document.querySelector('#autoMovieRequestProfile'));
            if (serverSelect.dataset.jeLoaded) {
                const storedServerId = config.AutoMovieRequestCustomServerId;
                var serverVal = parseInt(serverSelect.value);
                config.AutoMovieRequestCustomServerId = (!isNaN(serverVal) && serverVal >= 0) ? serverVal : -1;
                if (profileSelect.dataset.jeLoaded || config.AutoMovieRequestCustomServerId !== storedServerId) {
                    var profileVal = parseInt(profileSelect.value);
                    config.AutoMovieRequestCustomProfileId = (!isNaN(profileVal) && profileVal > 0) ? profileVal : 0;
                    config.AutoMovieRequestCustomRootFolder = needControl(document.querySelector('#autoMovieRequestRootFolder')).value || '';
                }
            }
            m.blockedUsers.syncBlockedUsersToHiddenInput();
            config.JellyseerrImportBlockedUsers = needControl(document.querySelector('#jellyseerrImportBlockedUsers')).value || '';
            const retentionDays = parseInt(needControl(document.querySelector('#watchlistMemoryRetentionDays')).value);
            config.WatchlistMemoryRetentionDays = isNaN(retentionDays) || retentionDays < 1 ? 365 : Math.min(retentionDays, 3650);
            const seerrScanDebounce = parseInt(needControl(document.querySelector('#seerrScanDebounceSeconds')).value);
            config.SeerrScanDebounceSeconds = isNaN(seerrScanDebounce) || seerrScanDebounce < 5 ? 60 : Math.min(seerrScanDebounce, 3600);
            config.BookmarksUsePluginPages = needInput(document.querySelector('#bookmarksUsePluginPages')).checked;
            config.BookmarksUseNativeTab = needInput(document.querySelector('#bookmarksUseNativeTab')).checked;
            config.BookmarksUseCustomTabs = needInput(document.querySelector('#bookmarksUseCustomTabs')).checked;
            var __bAutoSave = asInput(document.querySelector('#bookmarksAutoCreateCustomTab'));
            config.BookmarksAutoCreateCustomTab = !!(__bAutoSave && __bAutoSave.checked);


            // Save multi-instance Sonarr/Radarr
            var arrIncompleteWarnings = m.arr.saveArrInstances(config);
            if (arrIncompleteWarnings.length > 0) {
                // Surface each incomplete-card warning to the admin before the save completes.
                arrIncompleteWarnings.forEach(function(msg) {
                    Dashboard.alert({ title: '⚠ Incomplete *arr instance', message: msg });
                });
            }
            config.DefaultLanguage = needControl(document.querySelector('#DefaultLanguage')).value || '';
            config.MetadataIconsEnabled = !!needInput(document.querySelector('#metadataIconsEnabled')).checked;
            // If metadata icons are enabled, ensure icons are shown for Letterboxd and *arr links
            if (config.MetadataIconsEnabled) {
                config.ShowLetterboxdLinkAsText = false;
                config.ShowArrLinksAsText = false;
            }

            // Extras settings

            // Usage Statistics
            config.AnalyticsEnabled = needInput(document.querySelector('#analyticsEnabled')).checked;
            config.AnalyticsShareFeatureFlags = needInput(document.querySelector('#analyticsShareFeatureFlags')).checked;
            config.AnalyticsShareUsageCounts = needInput(document.querySelector('#analyticsShareUsageCounts')).checked;
            config.AnalyticsShareDataSizes = needInput(document.querySelector('#analyticsShareDataSizes')).checked;
            var analyticsIntervalRaw = parseInt(needControl(document.querySelector('#analyticsReportIntervalDays')).value, 10);
            config.AnalyticsReportIntervalDays = isNaN(analyticsIntervalRaw) ? 15 : Math.min(30, Math.max(7, analyticsIntervalRaw));
            // Persist "configured" when saving with the master ON, and also
            // when the admin turned it on at any point this session (dataset
            // flag set by the master toggle handler) even if it's off again
            // now — their sub-category choices from that interaction are being
            // saved and must not be re-cascaded over on the next enable.
            if (config.AnalyticsEnabled || needHtml(document.querySelector('#analyticsEnabled')).dataset.jeTouched === '1') {
                config.AnalyticsHasBeenConfigured = true;
            }

            config.ActivityFeedUseNativeTab = needInput(document.querySelector('#activityFeedUseNativeTab')).checked;
            config.ActivityFeedUsePluginPages = needInput(document.querySelector('#activityFeedUsePluginPages')).checked;
            config.CatchUpUsePluginPages = needInput(document.querySelector('#catchUpUsePluginPages')).checked;
            config.CatchUpUseNativeTab = needInput(document.querySelector('#catchUpUseNativeTab')).checked;
            config.CatchUpUseCustomTabs = needInput(document.querySelector('#catchUpUseCustomTabs')).checked;
            var __cuAutoSave = asInput(document.querySelector('#catchUpAutoCreateCustomTab'));
            config.CatchUpAutoCreateCustomTab = !!(__cuAutoSave && __cuAutoSave.checked);
            config.ActivityFeedUseCustomTabs = needInput(document.querySelector('#activityFeedUseCustomTabs')).checked;
            var __aAutoSave = asInput(document.querySelector('#activityFeedAutoCreateCustomTab'));
            config.ActivityFeedAutoCreateCustomTab = !!(__aAutoSave && __aAutoSave.checked);

            // Requests Page settings
            config.DownloadsUsePluginPages = needInput(document.querySelector('#downloadsUsePluginPages')).checked;
            config.DownloadsUseCustomTabs = needInput(document.querySelector('#downloadsUseCustomTabs')).checked;
            config.DownloadsUseNativeTab = needInput(document.querySelector('#downloadsUseNativeTab')).checked;
            var __dAutoSave = asInput(document.querySelector('#downloadsAutoCreateCustomTab'));
            config.DownloadsAutoCreateCustomTab = !!(__dAutoSave && __dAutoSave.checked);

            // Calendar Page settings
            config.CalendarUseCustomTabs = needInput(document.querySelector('#calendarUseCustomTabs')).checked;
            config.CalendarUseNativeTab = needInput(document.querySelector('#calendarUseNativeTab')).checked;
            var __cAutoSave = asInput(document.querySelector('#calendarAutoCreateCustomTab'));
            config.CalendarAutoCreateCustomTab = !!(__cAutoSave && __cAutoSave.checked);
            config.CalendarUsePluginPages = needInput(document.querySelector('#calendarUsePluginPages')).checked;

            // Recommendations Page settings
            config.RecommendationsUseNativeTab = needInput(document.querySelector('#recommendationsUseNativeTab')).checked;
            config.RecommendationsUsePluginPages = needInput(document.querySelector('#recommendationsUsePluginPages')).checked;
            config.RecommendationsUseCustomTabs = needInput(document.querySelector('#recommendationsUseCustomTabs')).checked;
            var __rAutoSave = asInput(document.querySelector('#recommendationsAutoCreateCustomTab'));
            config.RecommendationsAutoCreateCustomTab = !!(__rAutoSave && __rAutoSave.checked);

            // Hidden Content settings
            config.HiddenContentUsePluginPages = needInput(document.querySelector('#hiddenContentUsePluginPages')).checked;
            config.HiddenContentUseNativeTab = needInput(document.querySelector('#hiddenContentUseNativeTab')).checked;
            config.HiddenContentUseCustomTabs = needInput(document.querySelector('#hiddenContentUseCustomTabs')).checked;
            var __hAutoSave = asInput(document.querySelector('#hiddenContentAutoCreateCustomTab'));
            config.HiddenContentAutoCreateCustomTab = !!(__hAutoSave && __hAutoSave.checked);

            // Spoiler Guard settings
            config.SpoilerBlurEnabled = needInput(document.querySelector('#spoilerBlurEnabled')).checked;
            var __sbSigmaSave = asControl(document.querySelector('#spoilerBlurIntensity'));
            if (__sbSigmaSave) {
                var __sbSigmaVal = parseInt(__sbSigmaSave.value, 10);
                if (!isFinite(__sbSigmaVal) || __sbSigmaVal < 5) __sbSigmaVal = 5;
                if (__sbSigmaVal > 100) __sbSigmaVal = 100;
                config.SpoilerBlurIntensity = __sbSigmaVal;
            }
            // Field-strip toggles
            [
                'spoilerStripSeriesOverview', 'spoilerStripOverview',
                'spoilerStripTags', 'spoilerStripChapters',
                'spoilerStripTaglines', 'spoilerStripRatings',
                'spoilerStripPremiereDate',
                'spoilerReplaceTitle', 'spoilerStripCast', 'spoilerStripReviews',
                'spoilerBlurArtwork', 'spoilerAutoEnableOnFirstPlay',
                'spoilerAutoEnableOnSeerrRequest', 'spoilerAutoEnableOnLibraryAdd',
                'spoilerAutoEnableSeries', 'spoilerAutoEnableMovies',
                'spoilerBlurStrictRefresh',
                'spoilerKeepMoviePosters',
                'spoilerBlurTrickplay',
                'spoilerAdvancedMode',
                'spoilerNextEpisodeStripTitle', 'spoilerNextEpisodeStripOverview',
                'spoilerNextEpisodeStripRatings', 'spoilerNextEpisodeStripImage',
                'spoilerCurrentSeasonStripTitle', 'spoilerCurrentSeasonStripOverview',
                'spoilerCurrentSeasonStripRatings',
            ].forEach(function (id) {
                var el = asInput(document.querySelector('#' + id));
                if (!el) return;
                var pascal = id.charAt(0).toUpperCase() + id.slice(1);
                config[pascal] = !!el.checked;
            });
            config.SpoilerAutoEnableLibraryIds = m.spoiler.collectSpoilerAutoEnableLibraries();
            var __sbCastModeSave = asControl(document.querySelector('#spoilerStripCastMode'));
            config.SpoilerStripCastMode = (__sbCastModeSave && __sbCastModeSave.value === 'All') ? 'All' : 'GuestStars';
            var __sbModeSave = asControl(document.querySelector('#spoilerBlurMode'));
            config.SpoilerBlurMode = (__sbModeSave && __sbModeSave.value === 'blur') ? 'blur' : 'hide';
            var __sbPlaceholderSave = asControl(document.querySelector('#spoilerOverviewPlaceholder'));
            if (__sbPlaceholderSave) {
                // Remove every character that could open a tag, attribute or
                // template context so this stored placeholder can't become markup
                // in a JE consumer that uses innerHTML on Overview (the server
                // inserts it into BaseItemDto.Overview; defense-in-depth). A single
                // character-class strip is complete — unlike a tag-shaped regex it
                // can't be bypassed by nested or split tags.
                var __raw = (__sbPlaceholderSave.value || 'Spoiler Guard activated').slice(0, 200);
                __raw = __raw.replace(/[<>"'`]/g, '');
                config.SpoilerOverviewPlaceholder = __raw || 'Spoiler Guard activated';
            }


            // Carry the cached "JE owns this Custom Tabs entry" flags through any
            // round-trip; sync may overwrite specific keys after computing actions.
            m.customTabs.CUSTOM_TAB_MANAGED_ENTRIES.forEach(function(entry) {
                config[entry.ownedKey] = m.displayCards._jeCustomTabOwnedCache[entry.ownedKey] === true;
            });

            // Another tab or administrator may have saved since this form was filled. A setting the form still
            // holds as it was filled keeps the value just read, so only what was changed here is written over it.
            formValues.set(config, { ...config });
            const base = m.load.formBase;
            Object.keys(config).forEach(function(key) {
                if (JSON.stringify(config[key]) === JSON.stringify(base[key])) config[key] = stored[key];
            });
            return config;
        }

        /** Writes a configuration from buildConfigFromForm; the form's values in it are then what the form was saved from. */
        async function writeFormConfig(config: AdminConfig) : Promise<unknown> {
            const result = await ApiClient.updatePluginConfiguration(pluginId, config);
            m.load.formBase = formValues.get(config) ?? m.load.formBase;
            return result;
        }

        /**
         * Run sync, then if any owned-flag updates were produced, persist them
         * back to JE config in a second write so future saves see the new state.
         * Returns the (possibly downgraded) sync result so the caller can surface
         * any failure to the admin.
         *
         * Cache discipline: `_jeCustomTabOwnedCache` is mutated ONLY after the
         * server confirms the owned-flag write. On failure we re-read the live
         * config and restore the cache to ground truth — otherwise a partial
         * write would leave the in-memory cache disagreeing with what the next
         * page-load will see, causing JE to silently orphan its own tabs on
         * future cleanup. The downgraded result tells `saveConfig` to surface
         * the partial-success to the admin.
         */
        async function runCustomTabsSync(config: AdminConfig, scope: WriteScope) : Promise<CustomTabsSyncResult> {
            scope.throwIfStale();
            const syncResult = await m.customTabs.syncAllManagedCustomTabs(config, scope);
            scope.throwIfStale();
            if (!syncResult || !Array.isArray(syncResult.ownedUpdates) || syncResult.ownedUpdates.length === 0) {
                return syncResult;
            }
            // Detect changes against the cache, but DO NOT mutate the cache yet.
            const pendingUpdates = syncResult.ownedUpdates.filter(function(u) {
                return m.displayCards._jeCustomTabOwnedCache[u.ownedKey] !== u.value;
            });
            if (pendingUpdates.length === 0) {
                return syncResult;
            }
            // Narrow second-write: fetch the latest config from the server first,
            // then apply ONLY the owned-flag delta. This minimizes the race window
            // where an interleaving save (double-click, "Apply to all users", or
            // a concurrent admin in another browser tab) would otherwise be lost
            // if we replayed the form's stale snapshot on top. Any unrelated
            // fields the other save wrote are preserved because we only mutate
            // the `*CustomTabJeOwned` keys on the fresh copy.
            let fresh;
            try {
                fresh = await ApiClient.getPluginConfiguration(pluginId);
            } catch (fetchErr) {
                console.error('[JE] Could not re-fetch config for owned-flag persist:', fetchErr);
                fresh = null;
            }
            scope.throwIfStale();
            const target = fresh || config; // fall back to form state if fetch fails
            pendingUpdates.forEach(function(u) { target[u.ownedKey] = u.value; });
            scope.throwIfStale();
            try {
                await ApiClient.updatePluginConfiguration(pluginId, target);
                scope.throwIfStale();
                // Server confirmed — commit cache.
                pendingUpdates.forEach(function(u) {
                    m.displayCards._jeCustomTabOwnedCache[u.ownedKey] = u.value;
                });
                return syncResult;
            } catch (persistErr) {
                if (isAbortError(persistErr)) throw persistErr;
                scope.throwIfStale();
                console.error('[JE] Failed to persist Custom Tabs owned-flag updates:', persistErr);
                // Roll cache back to ground truth so the next save's plan
                // computes against the actual server state, not a poisoned cache.
                try {
                    const fresh = await ApiClient.getPluginConfiguration(pluginId);
                    scope.throwIfStale();
                    m.customTabs.CUSTOM_TAB_MANAGED_ENTRIES.forEach(function(entry) {
                        m.displayCards._jeCustomTabOwnedCache[entry.ownedKey] = fresh[entry.ownedKey] === true;
                    });
                } catch (reloadErr) {
                    if (isAbortError(reloadErr)) throw reloadErr;
                    console.error('[JE] Cache rollback after owned-flag persist failure also failed:', reloadErr);
                }
                // Downgrade the result so saveConfig's check surfaces the partial.
                // The recovery message has to be specific because the trivial "re-save"
                // path does not actually repair the state: post-rollback the cache and
                // server agree on owned=false, the CT entry exists, and the next sync's
                // shouldExist+entry-exists branch will preserve owned=false (no second
                // write fires). Real recovery is to delete the CT entry from the
                // Custom Tabs plugin UI and then re-save here so the next sync ADDs
                // a fresh entry and stamps it owned=true.
                return Object.assign({}, syncResult, {
                    ok: false,
                    status: 'partial',
                    detail: (syncResult.detail ? syncResult.detail + ': ' : '') +
                            "Custom Tabs has the new entry, but Jellyfin Enhanced could not save its ownership record. " +
                            "JE will not be able to clean this entry up on a later toggle change. " +
                            "To restore JE management: open the Custom Tabs plugin, delete the JE-managed entry there, then save this page again; JE will recreate it and record ownership properly."
                });
            }
        }

        // Re-entrancy guard. `Dashboard.showLoadingMsg()` provides only a visual
        // overlay, not an input block, so two rapid Enter presses or a second
        // click on the save dock can still fire saveConfig in parallel — the
        // second one's `buildConfigFromForm` reads a server state that the
        // first one has already mutated, and Save#1's deferred owned-flag write
        // (step 2) can land after Save#2 and silently revert the admin's
        // between-save form changes. Treat saves as serial.
        var _jeSaveInFlight = false;

        /**
         * Save the form (submit, the save dock, Seerr's user import). Inside jeHoldMediaTags: Media Tags
         * changes not saved yet go first, and the ones made meanwhile wait until this write is done.
         * @param {Event} e
         * @returns {Promise<boolean>}
         */
        function saveConfig(e: Event): Promise<void> {
            e.preventDefault();
            return m.mediaTagsTab.jeHoldMediaTags((scope) => saveConfigNow(e, scope));
        }

        async function saveConfigNow(e: Event, scope: WriteScope) : Promise<void> {
            e.preventDefault();
            if (_jeSaveInFlight) return;
            if (!m.load.configLoaded) {
                Dashboard.alert({ title: 'Settings not loaded', message: 'The saved settings could not be read, so nothing was saved. Retry from the banner at the top of this page, or reload it.' });
                return;
            }
            _jeSaveInFlight = true;
            m.gatedHelp.enforceTabExclusivity();
            Dashboard.showLoadingMsg();
            var saveBtns = document.querySelectorAll<HTMLButtonElement>('.je-save-dock-btn');
            saveBtns.forEach(function(b) { b.disabled = true; });

            try {
                const config = await buildConfigFromForm(scope);
                const wasOn = maintenanceWasOn;
                scope.throwIfStale();
                const result = await writeFormConfig(config);
                scope.throwIfStale();
                // After JE config is persisted, sync any managed Custom Tabs entries.
                // We surface non-OK results to the admin via Dashboard.alert so a
                // partial failure doesn't hide behind the green "saved" toast.
                const syncResult = await runCustomTabsSync(config, scope);
                scope.throwIfStale();

                // Apply maintenance mode: enable/disable users to match the toggle
                try {
                    if (config.MaintenanceModeEnabled) {
                        const affectedIds = config.MaintenanceModeAffectedUsers === 'all'
                            ? []
                            : JSON.parse(text(config.MaintenanceModeAffectedUsers) || '[]');
                        await ApiClient.ajax({
                            type: 'POST',
                            url: ApiClient.getUrl('/JellyfinEnhanced/MaintenanceMode/Enable'),
                            contentType: 'application/json',
                            data: JSON.stringify({
                                message: config.MaintenanceModeMessage || '',
                                notificationMessage: config.MaintenanceModeNotificationMessage || '',
                                durationMinutes: config.MaintenanceModeDurationMinutes || 0,
                                action: config.MaintenanceModeAction || 'disable_accounts',
                                affectedUserIds: affectedIds
                            })
                        });
                        // Broadcast a native Jellyfin message to all active sessions
                        // (reaches non-web clients like TV apps too — works regardless of Active Streams setting).
                        // Only when this save turns maintenance on: Enable above is re-sent on every save, and a
                        // window already running was announced when it started.
                        const mmMsg = text(config.MaintenanceModeNotificationMessage).trim()
                            || text(config.MaintenanceModeMessage).trim()
                            || 'Server maintenance is starting. Please finish up and try again later.';
                        scope.throwIfStale();
                        if (!wasOn) {
                            try {
                                await ApiClient.ajax({
                                    type: 'POST',
                                    url: ApiClient.getUrl('/JellyfinEnhanced/MaintenanceMode/Broadcast'),
                                    contentType: 'application/json',
                                    data: JSON.stringify({
                                        header: 'Server Maintenance',
                                        text: mmMsg,
                                        timeoutMs: 30000
                                    })
                                });
                            } catch (bcErr) {
                                console.warn('[JE] Maintenance broadcast failed (no active sessions?):', bcErr);
                            }
                        }
                    } else {
                        // With the daily schedule on, "manual off" must leave a scheduled window running;
                        // with it off, nothing should be active, so end a scheduled window right away too.
                        await ApiClient.ajax({
                            type: 'POST',
                            url: ApiClient.getUrl('/JellyfinEnhanced/MaintenanceMode/Disable', {
                                includeScheduled: !config.MaintenanceScheduleEnabled
                            })
                        });
                    }
                } catch (mmErr) {
                    if (isAbortError(mmErr)) throw mmErr;
                    console.warn('[JE] Maintenance mode apply failed:', mmErr);
                }

                scope.throwIfStale();
                Dashboard.processPluginConfigurationUpdateResult(result);
                // The form now is the just-saved state, so re-snapshot immediately.
                m.dirty.jeMarkSaved();
                if (syncResult && syncResult.ok === false) {
                    try {
                        Dashboard.alert({
                            title: 'Custom Tabs sync issue',
                            message: 'Your Jellyfin Enhanced settings were saved, but the Custom Tabs entry could not be updated.\n\n' +
                                     (syncResult.detail || 'See browser console for details.')
                        });
                    } catch (alertErr) { console.warn('[JE] Dashboard.alert threw:', alertErr); }
                }
            } catch (saveErr) {
                Dashboard.hideLoadingMsg();
                if (isAbortError(saveErr)) throw saveErr;
                console.error('[JE] saveConfig failed:', saveErr);
                try {
                    Dashboard.alert({
                        title: 'Save failed',
                        message: 'Could not save Jellyfin Enhanced settings. Check the browser console and server logs, then try again.'
                    });
                } catch (alertErr) { console.warn('[JE] Dashboard.alert threw:', alertErr); }
            } finally {
                _jeSaveInFlight = false;
                saveBtns.forEach(function(b) { b.disabled = false; });
            }
        }

        /** The form's submit and the save dock. A caller that continues after saving uses saveConfig. */
        function saveFromForm(e: Event): Promise<void> {
            e.preventDefault();
            return m.mediaTagsTab.jeRunHeldWrite((scope) => saveConfigNow(e, scope));
        }

        // Saves current config and applies it to all users (inside jeHoldMediaTags, as Save).
        function resetAllUserSettings(): Promise<unknown> {
            return m.mediaTagsTab.jeRunHeldWrite(resetAllUserSettingsNow);
        }

        async function resetAllUserSettingsNow(scope: WriteScope) : Promise<void> {
            if (await JEAdmin.confirm("Are you sure?\n\nThis saves the current configuration, then copies these Display/Playback/etc. values into every user's Enhanced Panel settings, replacing anything they've customized for themselves. This cannot be undone per-user; each user would have to re-apply their own preferences afterward.")) {
                scope.throwIfStale();
                Dashboard.showLoadingMsg();
                try {
                    // First, save the current configuration
                    const config = await buildConfigFromForm(scope);
                    scope.throwIfStale();
                    await writeFormConfig(config);
                    scope.throwIfStale();
                    m.dirty.jeMarkSaved();

                    // Sync managed Custom Tabs entries — same flow as a normal save,
                    // so "Apply to all users" doesn't silently skip the side-effect.
                    const syncResult = await runCustomTabsSync(config, scope);

                    // Then reset all user settings to match the saved config
                    scope.throwIfStale();
                    await ApiClient.ajax({
                        type: 'POST',
                        url: ApiClient.getUrl('/JellyfinEnhanced/reset-all-users-settings'),
                        dataType: 'json'
                    });

                    scope.throwIfStale();
                    JEAdmin.markApplied();
                    Dashboard.hideLoadingMsg();
                    let msg = 'Configuration saved and applied to all users successfully!\n\nSettings will take effect after users refresh their browsers.';
                    if (syncResult && syncResult.ok === false) {
                        msg += '\n\n(Custom Tabs sync did not complete: ' + (syncResult.detail || 'see console') + ')';
                    }
                    Dashboard.alert({ title: 'Success', message: msg });
                } catch (e) {
                    Dashboard.hideLoadingMsg();
                    if (isAbortError(e)) throw e;
                    console.error('Failed to save and apply settings:', e);
                    Dashboard.alert({
                        title: 'Error',
                        message: 'Failed to save and apply settings to all users. Check server logs for details.'
                    });
                }
            }
        }

    /** Runs this module's start-up work, in the page's original order. */
    function wire(): void {
        // Apply only the changed per-user settings to every user (backend copies just those properties).
        document.addEventListener('jea-apply-selected', (e) => m.mediaTagsTab.jeRunHeldWrite(async (scope) => {
            const detail = eventDetail(e);
            const props = stringList(detail.props);
            const labels = stringList(detail.labels);
            if (!props.length) return;
            const ok = await JEAdmin.confirm('Apply these settings to every user?\n\n<ul>' + labels.map((l) => '<li>' + l.replace(/</g, '&lt;') + '</li>').join('') + '</ul>\nThis saves your configuration first. Only these settings change; every other personal setting stays as it is.', 'Apply to all users');
            scope.throwIfStale();
            if (!ok) return;
            Dashboard.showLoadingMsg();
            try {
                const config = await buildConfigFromForm(scope);
                scope.throwIfStale();
                await writeFormConfig(config);
                scope.throwIfStale();
                m.dirty.jeMarkSaved();
                await runCustomTabsSync(config, scope);
                scope.throwIfStale();
                const r = asObject(await ApiClient.ajax({
                    type: 'POST',
                    url: ApiClient.getUrl('/JellyfinEnhanced/apply-user-settings'),
                    contentType: 'application/json',
                    dataType: 'json',
                    data: JSON.stringify({ properties: props })
                }));
                scope.throwIfStale();
                Dashboard.hideLoadingMsg();
                JEAdmin.markApplied();
                let msg = 'Applied ' + r.applied + ' setting(s) to ' + r.userCount + ' user(s). Users see the change after they refresh.';
                const unsupported = stringList(r.unsupported);
                if (unsupported.length) msg += '\n\nNot applied (no personal copy exists): ' + unsupported.join(', ');
                Dashboard.alert({ title: 'Applied', message: msg });
            } catch (err) {
                Dashboard.hideLoadingMsg();
                if (isAbortError(err)) throw err;
                console.error('[JE] apply-user-settings failed:', err);
                Dashboard.alert({ title: 'Error', message: 'Could not apply the settings to all users. Check the server logs for details.' });
            }
        }), { signal: lifecycle.signal });
    }

    return {
        wire,
        resetAllUserSettings,
        resetAllUserSettingsBtn,
        saveConfig,
        saveFromForm,
    };
}
