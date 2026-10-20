// /js/enhanced/config.js
/**
 * @file Manages plugin configuration, user settings, and shared state.
 */
(function(JE) {
    'use strict';

    /**
     * Constants derived from the plugin configuration.
     * @type {object}
     */
    JE.CONFIG = {
        // Use getters so values always reflect the latest pluginConfig even if assigned later
        get TOAST_DURATION() { return (JE.pluginConfig && JE.pluginConfig.ToastDuration) || 1500; },
        get HELP_PANEL_AUTOCLOSE_DELAY() { return (JE.pluginConfig && JE.pluginConfig.HelpPanelAutocloseDelay) || 15000; }
    };

    /**
     * Shared state variables used across different components.
     * @type {object}
     */
    JE.state = JE.state || {
        activeShortcuts: {},
        // { itemId, surface: 'continuewatching'|'nextup'|null, ts } captured on a menu trigger.
        removeContext: null,
        pauseScreenClickTimer: null
    };

    // The store belongs to the identity session, never to a panel or its settings objects.
    // Every file has exactly one persisted document, ordered pending documents and derived view.
    const documents = new Map();
    const panelScopes = new Set();
    // Every personal consent (UserConfigurationManager.PersonalConsents): only the consent operation changes one.
    const consentKeys = ['autoSeasonRequests', 'autoMovieRequests', 'listSwapIn'];
    // Consents where null is a choice (follow the administrator), not only "never chosen".
    const followConsentKeys = ['autoSeasonRequests', 'autoMovieRequests'];
    let identity, reloadRequest;
    JE.internals = JE.internals || {};

    /** Copy JSON settings so neither callers nor views can mutate the persisted baseline. */
    const copyDocument = value => JSON.parse(JSON.stringify(value || {}));

    /** Capture identity even in hosts without the session module. */
    const currentIdentity = () => JSON.stringify([
        typeof ApiClient !== 'undefined' ? ApiClient.getCurrentUserId?.() : null,
        JE.session?.getServerId?.(), JE.session?.getEpoch?.()
    ]);

    /** Discard observers, deduplication and unsent work on logout, user or server change. */
    const clearDocuments = () => {
        for (const scope of panelScopes) scope.close();
        clearTimeout(reloadRequest?.timer);
        reloadRequest = undefined;
        documents.clear(); identity = undefined;
    };
    JE.session?.onUserChange?.('settings-store', clearDocuments);

    /** Capture the user/server/epoch for work that may finish after its panel closes. */
    JE.internals.settingsSessionScope = () => {
        const captured = currentIdentity();
        return { isCurrent: () => currentIdentity() === captured };
    };

    /**
     * Bind panel callbacks to their opening identity/epoch and lifetime. Closing cancels gestures
     * and removes every registered listener, including document/window callbacks and detached controls.
     * @param {object} ctx Panel context; panelCleanups is drained on every host close path.
     * @returns {object} View lifetime/listeners/cleanup plus a session scope for submitted save completions.
     */
    JE.internals.settingsPanelScope = ctx => {
        if (ctx.settingsScope) return ctx.settingsScope;
        settingsDocument('settings.json');
        const session = JE.internals.settingsSessionScope(), cleanups = [];
        let closed = false;
        const scope = {
            session,
            isCurrent: () => !closed && session.isCurrent(),
            onCleanup: cleanup => cleanups.push(cleanup),
            close: () => {
                if (closed) return;
                closed = true;
                while (cleanups.length) cleanups.pop()();
                panelScopes.delete(scope);
            },
            listen: (target, type, handler, options) => {
                if (!target || !scope.isCurrent()) return;
                const guarded = event => { if (scope.isCurrent()) return handler(event); };
                target.addEventListener(type, guarded, options);
                cleanups.push(() => target.removeEventListener(type, guarded, options));
            }
        };
        panelScopes.add(scope);
        (ctx.panelCleanups || (ctx.panelCleanups = [])).push(scope.close);
        ctx.settingsScope = scope;
        return scope;
    };

    /** Get the active session's sole state for a file. Object replacement is just a new view. */
    const settingsDocument = fileName => {
        const now = currentIdentity();
        if (identity !== now) { clearDocuments(); identity = now; }
        let state = documents.get(fileName);
        if (!state) {
            const own = JE.userConfig?.[fileName.replace(/\.json$/, '')];
            const persisted = copyDocument(own);
            // Whether this session holds the document as the server last handed it out: the boot read (plugin.js marks the
            // documents it could not read) or a later read. Until then no whole document may be saved.
            const readOk = own !== undefined && !(JE.userConfig?.unreadDocuments || []).includes(fileName);
            state = { fileName, identity, persisted, shown: copyDocument(persisted), pending: [], readOk, recovery: undefined,
                revision: 0, readRevision: 0, serialized: undefined, chain: Promise.resolve(), observers: new Map(), effectWarnings: new Set(),
                mirroredLanguage: undefined };
            documents.set(fileName, state);
        }
        return state;
    };

    /** True only while this document still belongs to the active identity/session. */
    const isActiveDocument = state => currentIdentity() === state.identity && documents.get(state.fileName) === state;

    /** True while any session document has unsent work, an in-flight transport or an unpublished result. */
    const hasPendingSettings = () => [...documents.values()].some(state => state.pending.length > 0);

    /** Re-check identity and all queues at the instant a destructive page effect would run. */
    const runScheduledReload = request => {
        if (reloadRequest !== request) return;
        request.timer = undefined;
        request.ready = true;
        if (!request.session.isCurrent()) { reloadRequest = undefined; return; }
        if (hasPendingSettings()) return; // Queue settlement wakes this request; never poll.
        reloadRequest = undefined;
        window.location.reload();
    };

    /** Wake a due reload after publication, allowing observers and promise completions to enqueue more work. */
    const resumeScheduledReload = () => {
        const request = reloadRequest;
        if (request?.ready && request.timer === undefined && !hasPendingSettings()) {
            request.timer = setTimeout(() => runScheduledReload(request), 0);
        }
    };

    /**
     * Coalesce settings-owned page reloads for the captured session. The initial delay is a minimum;
     * every per-user document queue must be idle before firing, including work queued during the delay.
     * @param {object} session Captured identity scope; panel close does not invalidate it.
     * @param {number} delay Minimum delay in milliseconds.
     */
    JE.internals.scheduleReloadWhenIdle = (session, delay = 1500) => {
        if (!session.isCurrent()) return;
        settingsDocument('settings.json');
        if (reloadRequest) return;
        const request = reloadRequest = { session, ready: false, timer: undefined };
        request.timer = setTimeout(() => runScheduledReload(request), delay);
    };

    /** Isolate one effect, including rejected async work; diagnostics cannot interrupt store settlement. */
    const runEffect = (state, kind, effect) => {
        /** Report each failing kind once in this document/session, retrying the effect on later publications. */
        const warn = error => {
            if (state.effectWarnings.has(kind)) return;
            state.effectWarnings.add(kind);
            try { console.warn(`🪼 Jellyfin Enhanced: Settings effect ${kind} failed; will retry.`, error); } catch { /* Best effort. */ }
        };
        try {
            const result = effect();
            if (result && typeof result.then === 'function') Promise.resolve(result).catch(warn);
        } catch (error) { warn(error); }
    };

    /** Replace a compatibility view in place, including deletion of fields absent from the document. */
    const replaceView = (view, document) => {
        for (const key of Object.keys(view)) if (!Object.hasOwn(document, key)) delete view[key];
        Object.assign(view, copyDocument(document));
    };

    /** Normalize a persisted display-language code for Jellyfin's per-user browser key. */
    const normalizeLanguage = code => {
        const parts = (code || '').split('-');
        return parts.length === 2 ? `${parts[0].toLowerCase()}-${parts[1].toUpperCase()}` : (code || '').toLowerCase();
    };

    // Every independently fallible publication effect has its own registration. Observers use the same isolation.
    // Kept under internals so additional settings surfaces can share the boundary instead of adding handler effects.
    const settingsEffects = JE.internals.settingsDocumentEffects = new Map();
    for (const [key, name, selectors, options] of [
        ['qualityTagsEnabled', 'Quality', '.quality-overlay-container', ['qualityTagsPosition', 'qualityTagsPreferredAudioLanguage',
            'showResolutionTag', 'showSourceTag', 'showDynamicRangeTag', 'showSpecialFormatTag', 'showVideoCodecTag', 'showAudioInfoTag',
            'resolutionTagOrder', 'sourceTagOrder', 'dynamicRangeTagOrder', 'specialFormatTagOrder', 'videoCodecTagOrder', 'audioInfoTagOrder']],
        ['genreTagsEnabled', 'Genre', '.genre-overlay-container', ['genreTagsPosition']],
        ['languageTagsEnabled', 'Language', '.language-overlay-container', ['languageTagsPosition']],
        ['ratingTagsEnabled', 'Rating', '.rating-overlay-container', ['ratingTagsPosition', 'ratingTagsOnMovies', 'ratingTagsOnSeries',
            'ratingTagsOnSeasons', 'ratingTagsOnEpisodes', 'ratingTagsOnContinueWatching', 'ratingTagsOnNextUp']],
        ['ageRatingTagsEnabled', 'AgeRating', '.age-rating-overlay-container', ['ageRatingTagsPosition']],
        ['peopleTagsEnabled', 'People', '.je-people-place-banner, .je-people-age-container', []]
    ]) {
        settingsEffects.set(`tags-${name}`, ({ before, after, changed }) => {
            if (before[key] !== after[key]) {
                if (after[key]) return JE[`initialize${name}Tags`]?.();
                document.querySelectorAll(selectors).forEach(el => el.remove());
                if (name === 'People') document.querySelectorAll('.je-deceased-poster').forEach(el => el.classList.remove('je-deceased-poster'));
            } else if (after[key] && changed(options)) return JE[`reinitialize${name}Tags`]?.();
        });
    }
    settingsEffects.set('tag-stacking', ({ state, before, after }) => {
        if (!['qualityTagsEnabled', 'genreTagsEnabled', 'languageTagsEnabled', 'ratingTagsEnabled', 'ageRatingTagsEnabled', 'peopleTagsEnabled']
            .some(key => before[key] && !after[key])) return;
        const hosts = new Set();
        document.querySelectorAll('[data-je-corner]').forEach(el => { if (el.parentElement) hosts.add(el.parentElement); });
        hosts.forEach(host => runEffect(state, 'tag-stacking-host', () => JE.core?.tagRenderer?.applyCornerStacking?.(host)));
    });
    settingsEffects.set('tag-hover', ({ after, changed }) => {
        if (changed(['tagsHideOnHover'])) document.body.classList.toggle('je-tags-hide-on-hover', !!after.tagsHideOnHover);
    });
    settingsEffects.set('random-button', ({ changed }) => { if (changed(['randomButtonEnabled'])) return JE.addRandomButton?.(); });
    for (const [key, selector] of [['showWatchProgress', '.mediaInfoItem-watchProgress'], ['showFileSizes', '.mediaInfoItem-fileSize'],
        ['showAudioLanguages', '.mediaInfoItem-audioLanguage']]) {
        settingsEffects.set(`details-${key}`, ({ after, changed }) => {
            if (changed([key]) && !after[key]) document.querySelectorAll(selector).forEach(el => el.remove());
        });
    }
    settingsEffects.set('details-refresh', ({ changed }) => {
        if (changed(['showWatchProgress', 'showFileSizes', 'showAudioLanguages', 'watchProgressMode', 'watchProgressTimeFormat'])) {
            return JE.internals.features?.refreshDetailsSettings?.();
        }
    });
    settingsEffects.set('pause-delay', ({ after }) => {
        if (JE.pauseScreenInstance) JE.pauseScreenInstance.pauseScreenDelayMs = after.pauseScreenDelaySeconds * 1000;
    });
    settingsEffects.set('subtitle-styles', ({ changed }) => {
        if (changed(['disableCustomSubtitleStyles', 'customSubtitleTextColor', 'customSubtitleBgColor', 'usingCustomColors',
            'selectedStylePresetIndex', 'selectedFontSizePresetIndex', 'selectedFontFamilyPresetIndex', 'selectedTextEffectPresetIndex'])) {
            return JE.applySavedStylesWhenReady?.();
        }
    });
    settingsEffects.set('subtitle-position', ({ changed }) => {
        if (changed(['subtitleHorizontalPosition', 'subtitleVerticalPosition', 'disableCustomSubtitleStyles'])) return JE.applySubtitlePosition?.();
    });
    settingsEffects.set('acquisition-cards', ({ state, previousShown, previousPersisted, reason }) => {
        // Hide is immediate. Show reads again after persistence; failures restore the surface too.
        const before = previousShown.acquisitionBadges, after = state.shown.acquisitionBadges;
        if ((reason === 'queued' ? after === false && before !== false : before !== after)
            || (reason === 'saved' && state.persisted.acquisitionBadges !== previousPersisted.acquisitionBadges
                && state.persisted.acquisitionBadges === after && after !== false)) return JE.internals.arrStatusCards?.reset?.();
    });
    settingsEffects.set('list-pages', ({ changed }) => {
        // Phase 4c3a: list pages follow a list preference change at once (drawn entries go when hidden).
        if (changed(['listPlaceholders', 'listStatus', 'listPlaylistUi', 'listCollectionUi'])) return JE.arrListPages?.settingsChanged?.();
    });
    settingsEffects.set('home-rows', ({ state, previousPersisted, reason }) => {
        // Phase 4d: the home page reads its rows again once a home-row choice is persisted.
        if (reason !== 'saved') return;
        if (['homeRowRequests', 'homeRowSoon', 'homeRowArrived', 'homeOpsStrip']
            .some(key => (previousPersisted[key] ?? null) !== (state.persisted[key] ?? null))) return JE.arrHome?.refresh?.({ fresh: true });
    });
    settingsEffects.set('language-mirror', ({ state, previousPersisted, reason }) => {
        if (reason !== 'saved' && reason !== 'read') return;
        // What the server stored is mirrored (a save's answer sets it as persisted; reads hand out the gated value). The
        // same rule again here: a stored "undefined" or "null", a malformed value or a language JE ships no bundle for
        // mirrors as Auto (''). Without the translations module's check nothing is written.
        if (typeof JE.supportedLanguageCode !== 'function') return;
        const language = JE.supportedLanguageCode(resolveSettings(state.persisted).displayLanguage);
        // Jellyfin's own Display settings write the same key: JE writes it only when its own display language differs from
        // the one it last mirrored (a save, or a read of another browser's change), so saving any other JE setting never
        // replaces the person's choice there. A failed write is retried at the next publication.
        if (state.mirroredLanguage === undefined) state.mirroredLanguage = JE.supportedLanguageCode(resolveSettings(previousPersisted).displayLanguage);
        if (language === state.mirroredLanguage) return;
        const key = `${ApiClient.getCurrentUserId()}-language`;
        if (localStorage.getItem(key) !== language) localStorage.setItem(key, language);
        state.mirroredLanguage = language;
    });
    for (const [kind, effect] of [
        ['language-toast', () => JE.toast?.(JE.t('toast_language_changed'))],
        ['language-reload', () => JE.internals.scheduleReloadWhenIdle(JE.internals.settingsSessionScope())]
    ]) {
        settingsEffects.set(kind, ({ state, previousPersisted, reason }) => {
            if (reason === 'saved' && normalizeLanguage(resolveSettings(state.persisted).displayLanguage)
                !== normalizeLanguage(resolveSettings(previousPersisted).displayLanguage)) return effect();
        });
    }
    for (const [keys, toastKey] of [
        [['acquisitionBadges', 'nativeAcquisitionStamps'], 'toast_badge_settings_saved'],
        [['listPlaceholders', 'listStatus', 'listSwapIn', 'listPlaylistUi', 'listCollectionUi'], 'toast_list_settings_saved'],
        [['useNativePosterTags'], 'toast_native_poster_tags_saved'],
        [['autoSeasonRequests', 'autoMovieRequests'], 'toast_auto_requests_saved'],
        [['homeRowRequests', 'homeRowSoon', 'homeRowArrived', 'homeOpsStrip'], 'panel_settings_home_saved']
    ]) {
        settingsEffects.set(toastKey, ({ state, previousPersisted, reason }) => {
            if (reason !== 'saved') return;
            const before = resolveSettings(previousPersisted), after = resolveSettings(state.persisted);
            if (keys.some(key => (before[key] ?? null) !== (after[key] ?? null))) return JE.toast?.(JE.t(toastKey));
        });
    }

    /** Run effects only after the derived state and compatibility views agree; isolate every subscriber. */
    const runEffects = (state, previousShown, previousPersisted, reason) => {
        if (state.fileName === 'settings.json') {
            const before = resolveSettings(previousShown), after = resolveSettings(state.shown);
            const context = { state, previousShown, previousPersisted, reason, before, after,
                changed: keys => keys.some(key => before[key] !== after[key]) };
            for (const [kind, effect] of [...settingsEffects]) {
                if (!isActiveDocument(state)) break;
                runEffect(state, kind, () => effect(context));
            }
        }
        for (const [name, observer] of [...state.observers]) {
            if (!isActiveDocument(state)) break;
            runEffect(state, `observer-${name}`, () => observer(copyDocument(state.shown), reason));
        }
        // Queue settlement must wake reloads even when every consumer fails. The timer rechecks identity/work.
        resumeScheduledReload();
    };

    /** Recompute from persisted + pending documents; views never supply rollback snapshots. */
    const publishDocument = (state, previousPersisted = state.persisted, reason = 'settled') => {
        if (!isActiveDocument(state)) return;
        const previousShown = state.shown;
        state.shown = copyDocument(state.pending.filter(entry => !entry.consentKey).at(-1)?.document || state.persisted);
        if (state.fileName === 'settings.json') {
            // Whole documents never carry consent intent. Only explicit pending operations may override it.
            for (const key of consentKeys) {
                if (Object.hasOwn(state.persisted, key)) state.shown[key] = state.persisted[key];
                else delete state.shown[key];
            }
            for (const entry of state.pending) if (entry.consentKey) state.shown[entry.consentKey] = entry.document[entry.consentKey];
        }
        if (state.fileName === 'settings.json') {
            JE.userConfig = JE.userConfig || {};
            JE.userConfig.settings = JE.userConfig.settings || {};
            replaceView(JE.userConfig.settings, state.shown);
            JE.currentSettings = JE.currentSettings || {};
            replaceView(JE.currentSettings, resolveSettings(state.shown));
        }
        runEffects(state, previousShown, previousPersisted, reason);
    };

    /** Subscribe a named pure view; replacement panels replace their observer without replacing state. */
    JE.internals.observeSettingsDocument = (name, observer) => {
        const state = settingsDocument('settings.json');
        state.observers.set(name, observer);
        runEffect(state, `observer-${name}`, () => observer(copyDocument(state.shown)));
    };

    /**
     * Read a server document with a revision fence. A response begun during/before a newer save
     * cannot replace that save's baseline, even if it arrives after the save completes.
     * @param {string} fileName Settings document to read.
     * @returns {Promise<boolean>} Whether the response belongs to the active session.
     */
    JE.readUserSettings = async fileName => {
        const state = settingsDocument(fileName);
        const revision = state.revision, readRevision = ++state.readRevision;
        const hadPending = state.pending.length > 0;
        const userId = ApiClient.getCurrentUserId();
        const response = await ApiClient.ajax({ type: 'GET',
            url: ApiClient.getUrl(`/JellyfinEnhanced/user-settings/${userId}/${fileName}?_=${Date.now()}`), dataType: 'json' });
        if (!isActiveDocument(state)) return false;
        const previousPersisted = state.persisted;
        if (response && !hadPending && !state.pending.length && revision === state.revision && readRevision === state.readRevision) {
            state.persisted = copyDocument(JE.toCamelCase ? JE.toCamelCase(response) : response);
            // A fresh read may reflect another browser's write: invalidate POST deduplication.
            state.serialized = undefined;
            state.readOk = true;
        }
        publishDocument(state, previousPersisted, 'read');
        return true;
    };

    /**
     * A module that reads a per-user document itself (not through readUserSettings) reports the read here, so the store
     * accepts whole-document saves of it.
     * @param {string} fileName Settings document that was read.
     * @param {object} document The document as read.
     */
    JE.internals.noteSettingsRead = (fileName, document) => {
        const state = settingsDocument(fileName);
        if (state.pending.length || !document || typeof document !== 'object') return;
        state.persisted = copyDocument(document);
        state.serialized = undefined;
        state.readOk = true;
        publishDocument(state, state.persisted, 'read');
    };

    /**
     * Refuse a whole-document save of a document this session never read: what it would send is built on defaults and
     * would replace the person's stored settings. Views fall back to the persisted document, the person is told why, and
     * one read is started so a later save can go through.
     * @param {object} state Document state.
     * @returns {Error} The refusal, for callers that reject.
     */
    const refuseUnreadSave = state => {
        publishDocument(state, state.persisted, 'failed');
        // Long enough to read (the default toast is gone in 1.5 s).
        try { JE.toast?.(JE.t?.('settings_save_not_read') || 'Your settings couldn\'t be loaded, so this change wasn\'t saved. Try again in a moment, or reload the page.', 6000); } catch { /* Best effort. */ }
        if (!state.recovery) {
            state.recovery = JE.readUserSettings(state.fileName).catch(() => false).finally(() => { state.recovery = undefined; });
        }
        const error = new Error(`${state.fileName} was not read in this session; nothing was saved`);
        error.settingsNotRead = true;
        return error;
    };

    /** Save a patch through the same whole-document queue as legacy settings writers. */
    JE.updateSettings = (patch, options) => {
        const state = settingsDocument('settings.json');
        return JE.saveUserSettings('settings.json', { ...resolveSettings(state.shown),
            useNativePosterTags: state.shown.useNativePosterTags ?? null, ...patch }, options);
    };

    /** Queue one explicit personal-consent choice; no display document is sent to the server. */
    JE.setPersonalConsent = (field, value, options = {}) => {
        const valid = typeof value === 'boolean' || (value === null && followConsentKeys.includes(field));
        if (!consentKeys.includes(field) || !valid) return Promise.reject(new Error('Invalid personal consent'));
        return JE.saveUserSettings('settings.json', { [field]: value }, { ...options, consentKey: field });
    };

    /**
     * Queue a whole per-user document. Success advances persisted; failure drops only its entry.
     * The last pending document is the shown value, because each POST persists that entire snapshot.
     * @param {string} fileName Per-user settings file.
     * @param {object} settings Whole document to save.
     * @param {{throwOnError?: boolean}} [options] Reject failures for callers that request it.
     * @returns {Promise<void>}
     */
    JE.saveUserSettings = async (fileName, settings, options = {}) => {
        try {
            if (typeof ApiClient === 'undefined' || !ApiClient.getCurrentUserId) throw new Error('ApiClient not available');
            const userId = ApiClient.getCurrentUserId();
            if (!userId) throw new Error('User ID not available');
            const state = settingsDocument(fileName);
            if (!options.consentKey && !state.readOk) throw refuseUnreadSave(state);
            let data = settings;
            if (fileName === 'settings.json' && settings === JE.currentSettings && state.shown.useNativePosterTags == null) {
                data = { ...settings, useNativePosterTags: null };
            }
            const entry = { document: copyDocument(data), consentKey: options.consentKey };
            const wire = (fileName === 'bookmark.json' || fileName === 'settings.json') && typeof JE.toPascalCase === 'function'
                ? JE.toPascalCase(entry.document) : entry.document;
            const serialized = JSON.stringify(wire);
            const client = ApiClient;
            const url = client.getUrl(`/JellyfinEnhanced/user-settings/${userId}/${entry.consentKey ? 'consent' : fileName}`);
            let succeeded = false;
            try {
                state.revision++;
                state.pending.push(entry);
                const save = state.chain.then(async () => {
                    // A queued old-session write must never run under incoming credentials.
                    if (!isActiveDocument(state)) throw new Error('Settings session changed');
                    if (!entry.consentKey && state.serialized === serialized) return;
                    const response = await client.ajax({ type: entry.consentKey ? 'PATCH' : 'POST', url, dataType: 'json',
                        data: entry.consentKey ? JSON.stringify({ Field: entry.consentKey[0].toUpperCase() + entry.consentKey.slice(1), Value: entry.document[entry.consentKey] }) : serialized,
                        contentType: 'application/json' });
                    entry.consents = response?.consents || response?.Consents;
                    // The display language as the server stored it (its gate's answer): what the shared key mirrors.
                    const stored = response?.displayLanguage ?? response?.DisplayLanguage;
                    if (typeof stored === 'string') entry.displayLanguage = stored;
                    if (isActiveDocument(state)) state.serialized = entry.consentKey ? undefined : serialized;
                });
                state.chain = save.catch(() => {});
                publishDocument(state, state.persisted, 'queued');
                await save; succeeded = true;
            }
            finally {
                const index = state.pending.indexOf(entry);
                if (index !== -1) state.pending.splice(index, 1);
                const previousPersisted = state.persisted;
                if (succeeded) {
                    state.persisted = entry.consentKey ? { ...previousPersisted, [entry.consentKey]: entry.document[entry.consentKey] } : entry.document;
                    if (entry.displayLanguage !== undefined) state.persisted.displayLanguage = entry.displayLanguage;
                    for (const key of consentKeys) {
                        const pascal = key[0].toUpperCase() + key.slice(1);
                        const value = entry.consents && Object.hasOwn(entry.consents, pascal) ? entry.consents[pascal] : entry.consents?.[key];
                        if (value !== undefined) state.persisted[key] = value;
                        else if (!entry.consentKey) {
                            if (Object.hasOwn(previousPersisted, key)) state.persisted[key] = previousPersisted[key];
                            else delete state.persisted[key];
                        }
                    }
                }
                publishDocument(state, previousPersisted, succeeded ? 'saved' : 'failed');
            }
        } catch (error) {
            if (options?.throwOnError === true) throw error;
            if (error?.settingsNotRead) console.warn(`🪼 Jellyfin Enhanced: ${error.message}`);
            else console.error(`🪼 Jellyfin Enhanced: Failed to save ${fileName}:`, error);
        }
    };

    /**
     * Loads and merges settings from user config, plugin defaults, and hardcoded fallbacks.
     */
    const resolveSettings = userSettings => {
        const pluginDefaults = JE.pluginConfig || {};

        const hardcodedDefaults = {
            autoPauseEnabled: true, autoResumeEnabled: false, autoPipEnabled: false,
            autoSkipIntro: false, autoSkipOutro: false,
            selectedStylePresetIndex: 0, selectedFontSizePresetIndex: 2, selectedFontFamilyPresetIndex: 0, selectedTextEffectPresetIndex: 0,
            customSubtitleTextColor: '#FFFFFFFF', customSubtitleBgColor: '#00000000',
            usingCustomColors: false,
            disableCustomSubtitleStyles: false,
            subtitleVerticalPosition: 95, subtitleHorizontalPosition: 50,
            randomButtonEnabled: true,
            randomIncludeMovies: true, randomIncludeShows: true, randomUnwatchedOnly: false,
            randomScopeCurrentContainer: false, randomSourceId: '',
            showWatchProgress: false, showFileSizes: false, showAudioLanguages: true, removeContinueWatchingEnabled: false,
            watchProgressMode: 'percentage',
            watchProgressTimeFormat: 'hours',
            pauseScreenEnabled: true,
            pauseScreenDelaySeconds: 5,
            useNativePosterTags: true,
            qualityTagsEnabled: false, genreTagsEnabled: false, languageTagsEnabled: false, ratingTagsEnabled: false, ageRatingTagsEnabled: false, peopleTagsEnabled: false, tagsHideOnHover: false,
            showResolutionTag: true, showSourceTag: true, showDynamicRangeTag: true, showSpecialFormatTag: true, showVideoCodecTag: true, showAudioInfoTag: true,
            resolutionTagOrder: 1, sourceTagOrder: 2, dynamicRangeTagOrder: 3, specialFormatTagOrder: 4, videoCodecTagOrder: 5, audioInfoTagOrder: 6,
            qualityTagsPosition: 'top-left', genreTagsPosition: 'top-right', languageTagsPosition: 'bottom-left', ratingTagsPosition: 'bottom-right', ageRatingTagsPosition: 'bottom-right',
            ratingTagsOnMovies: true, ratingTagsOnSeries: true, ratingTagsOnSeasons: true, ratingTagsOnEpisodes: true, ratingTagsOnContinueWatching: true, ratingTagsOnNextUp: true,
            qualityTagsPreferredAudioLanguage: '',
            showRatingInPlayer: true,
            reviewsExpandedByDefault: false,
            displayLanguage: '',
            calendarDisplayMode: 'list',
            calendarDefaultViewMode: 'agenda',
            disableAllShortcuts: false, longPress2xEnabled: false, lastOpenedTab: 'shortcuts'
        };

        // Aliases mapping camelCase client settings keys to potential server plugin default keys
        const pluginDefaultAliases = {
            selectedStylePresetIndex: ['DefaultSubtitleStyle', 'SelectedStylePresetIndex'],
            selectedFontSizePresetIndex: ['DefaultSubtitleSize', 'SelectedFontSizePresetIndex'],
            selectedFontFamilyPresetIndex: ['DefaultSubtitleFont', 'SelectedFontFamilyPresetIndex'],
            displayLanguage: ['DefaultLanguage', 'DisplayLanguage'],
            watchProgressMode: ['WatchProgressDefaultMode', 'WatchProgressMode'],
            watchProgressTimeFormat: ['WatchProgressTimeFormat'],
            pauseScreenDelaySeconds: ['PauseScreenDelaySeconds']
        };

        /**
         * Resolves a default value from pluginDefaults for a given camelCase key.
         */
        const getPluginDefault = (key) => {
            const aliases = pluginDefaultAliases[key] || [];
            const candidates = [
                key,
                key.charAt(0).toUpperCase() + key.slice(1),
                ...aliases
            ];

            for (const candidate of candidates) {
                const value = pluginDefaults[candidate];
                if (value !== null && value !== undefined) {
                    return value;
                }
            }

            return undefined;
        };

        const mergedSettings = {};
        // Seed with all keys from the stored user settings so that any field not
        // listed in hardcodedDefaults (e.g. fields added in newer plugin versions,
        // or fields the frontend doesn't actively manage) is preserved as-is and
        // not silently dropped when currentSettings is written back to the server.
        for (const key in userSettings) {
            mergedSettings[key] = userSettings[key];
        }
        for (const key in hardcodedDefaults) {
            if (Object.prototype.hasOwnProperty.call(userSettings, key) && userSettings[key] !== null && userSettings[key] !== undefined) {
                // Detect corrupted values (empty arrays or unexpected objects)
                if (typeof userSettings[key] === 'object' && Array.isArray(userSettings[key]) && userSettings[key].length === 0) {
                    const fallback = getPluginDefault(key);
                    mergedSettings[key] = fallback !== undefined ? fallback : hardcodedDefaults[key];
                } else if (typeof userSettings[key] === 'object' && userSettings[key] !== null && !Array.isArray(userSettings[key])) {
                    const fallback = getPluginDefault(key);
                    mergedSettings[key] = fallback !== undefined ? fallback : hardcodedDefaults[key];
                } else {
                    mergedSettings[key] = userSettings[key];
                }
            } else {
                const pluginVal = getPluginDefault(key);
                if (pluginVal !== undefined) {
                    mergedSettings[key] = pluginVal;
                } else {
                    mergedSettings[key] = hardcodedDefaults[key];
                }
            }
        }

        mergedSettings.displayLanguage = Object.prototype.hasOwnProperty.call(userSettings, 'displayLanguage')
            && userSettings.displayLanguage !== null && userSettings.displayLanguage !== undefined
            ? userSettings.displayLanguage
            : (getPluginDefault('displayLanguage') || '');
        mergedSettings.lastOpenedTab = userSettings.lastOpenedTab || 'shortcuts';

        // Admin default → per-user default (handled by getPluginDefault above; preserved for backwards compatibility)
        if (!Object.prototype.hasOwnProperty.call(userSettings, 'removeContinueWatchingEnabled')
            && pluginDefaults.RemoveContinueWatchingEnabled === true) {
            mergedSettings.removeContinueWatchingEnabled = true;
        }

        return mergedSettings;
    };

    /** Derive resolved settings from the store, retaining pending choices across replacement views. */
    JE.loadSettings = () => {
        const state = settingsDocument('settings.json');
        JE.userConfig = JE.userConfig || {};
        JE.userConfig.settings = copyDocument(state.shown);
        return resolveSettings(state.shown);
    };

    /** Shortcut combo for a keydown, e.g. "Ctrl+Shift+A". Shift is dropped for shifted symbols ("+", not "Shift++"). */
    JE.keyCombo = function(e) {
        const key = e.key;
        const isLetter = /^[a-zA-Z]$/.test(key);
        const isShiftedSymbol = key.length === 1 && key !== ' ' && !isLetter;
        return (e.metaKey ? 'Meta+' : '') +
               (e.ctrlKey ? 'Ctrl+' : '') +
               (e.altKey ? 'Alt+' : '') +
               (e.shiftKey && !isShiftedSymbol ? 'Shift+' : '') +
               (isLetter ? key.toUpperCase() : key);
    };

    /** Converts bindings saved before the fix ("Shift++") to the current format. */
    JE.normalizeShortcutKey = function(key) {
        if (typeof key !== 'string') return key;
        return key.replace(/Shift\+([^A-Za-z0-9\s,./;'\[\]\\=`-])$/, '$1');
    };

    /**
     * Initializes keyboard shortcut mappings from plugin and user configurations.
     */
    JE.initializeShortcuts = function() {
        const pluginDefaults = JE.pluginConfig || {};
        const userShortcutsConfig = JE.userConfig?.shortcuts || {};

        const defaultShortcuts = Array.isArray(pluginDefaults.Shortcuts)
            ? pluginDefaults.Shortcuts.reduce((acc, s) => {
                if (s && s.Name && s.Key !== undefined) acc[s.Name] = s.Key;
                return acc;
              }, {})
            : {};

        const userShortcuts = Array.isArray(userShortcutsConfig.Shortcuts)
            ? userShortcutsConfig.Shortcuts.reduce((acc, s) => {
                if (s && s.Name && s.Key !== undefined) acc[s.Name] = s.Key;
                return acc;
              }, {})
            : {};

        JE.state.activeShortcuts = JE.state.activeShortcuts || {};
        Object.assign(JE.state.activeShortcuts, defaultShortcuts, userShortcuts);
        Object.keys(JE.state.activeShortcuts).forEach(function(name) {
            JE.state.activeShortcuts[name] = JE.normalizeShortcutKey(JE.state.activeShortcuts[name]);
        });
    };

})(window.JellyfinEnhanced);
