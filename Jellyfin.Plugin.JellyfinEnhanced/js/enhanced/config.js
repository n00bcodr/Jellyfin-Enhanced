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

    // Per-file cache of the last JSON string successfully sent to the server.
    const _lastSavedJson = {};
    // Per-file chain of in-flight saves. Every control posts the whole object,
    // so two quick changes must reach the server in call order or the earlier
    // (smaller) snapshot can land last and drop the newer change.
    const _saveChain = {};
    // Whether the "settings could not be loaded" warning was already logged this page load.
    let _warnedSettingsUnavailable = false;
    // When the last "couldn't save" toast was shown; a burst of failed saves shows one.
    let _lastSaveFailedToastAt = 0;
    const SAVE_FAILED_TOAST_INTERVAL_MS = 3000;
    // English text for a locale file that does not have the key yet (JE.t returns the key on a miss).
    const SAVE_FAILED_FALLBACK = "Couldn't save your settings. Check your connection, then try again.";

    /**
     * Shows the translated "couldn't save" message, at most once per SAVE_FAILED_TOAST_INTERVAL_MS:
     * inside the settings panel while it is open (a toast would sit under it), else as a toast.
     */
    function toastSaveFailed() {
        const now = Date.now();
        if (now - _lastSaveFailedToastAt < SAVE_FAILED_TOAST_INTERVAL_MS) return;
        _lastSaveFailedToastAt = now;
        const translated = typeof JE.t === 'function' ? JE.t('toast_settings_save_failed') : '';
        const message = translated && translated !== 'toast_settings_save_failed' ? translated : SAVE_FAILED_FALLBACK;
        if (JE.internals?.enhancedUi?.showPanelSaveError?.(message)) return;
        if (typeof JE.toast === 'function') JE.toast(message);
    }

    // The per-key state of the signed-in user's settings from the server (Following, Chosen,
    // Defaults, ...; camelCase names, see plugin.js camelCaseSettingsMeta), or null without one.
    Object.defineProperty(JE, 'settingsMeta', {
        configurable: true, enumerable: true,
        get: () => JE.userConfig?.settingsMeta || null
    });

    JE.settings = JE.settings || {};
    /**
     * Whether an administrator locks the setting for the signed-in user (Meta.Locked): the server
     * serves the admin value and refuses writes, so callers show the value read-only and do not save.
     * @param {string} key The setting, in camelCase ('watchProgressMode') or PascalCase.
     * @returns {boolean}
     */
    JE.settings.isLocked = (key) => {
        const locked = JE.settingsMeta?.locked;
        if (!Array.isArray(locked) || typeof key !== 'string' || !key) return false;
        const camel = key.charAt(0).toLowerCase() + key.slice(1);
        return locked.includes(camel);
    };

    // JE.settings.onChange handlers: camelCase key → handlers, in registration order.
    const _changeHandlers = new Map();

    /**
     * Registers a live-apply handler for one setting. It runs when the key's value changes from
     * outside this page's own edits: another device or tab, an administrator (both noticed by the
     * focus check or a save answer), or a save the server refused. JE.currentSettings already holds
     * the new value; the `je:settings-changed` event follows the handlers. Changes the user makes on
     * this page are applied by the code that makes them, which does not call the handler.
     * @param {string} key The setting, in camelCase ('qualityTagsEnabled') or PascalCase.
     * @param {(value: *, key: string, detail: object) => void} fn Called with the new value, the
     *   camelCase key and the event detail ({ keys, rejected, meta?, config? }).
     * @returns {() => void} Removes the handler again.
     */
    JE.settings.onChange = (key, fn) => {
        if (typeof key !== 'string' || !key || typeof fn !== 'function') return () => {};
        const camel = key.charAt(0).toLowerCase() + key.slice(1);
        if (!_changeHandlers.has(camel)) _changeHandlers.set(camel, []);
        _changeHandlers.get(camel).push(fn);
        return () => {
            const handlers = _changeHandlers.get(camel) || [];
            const index = handlers.indexOf(fn);
            if (index >= 0) handlers.splice(index, 1);
        };
    };

    /**
     * Announces settings that changed from outside this page's own edits: runs the JE.settings.onChange
     * handlers of every changed key (a throwing handler is logged and the others still run), then
     * dispatches `je:settings-changed` on document with the same detail.
     * @param {{keys: string[], rejected: Array<{key: string, reason: string}>, meta?: boolean, config?: string[]}} detail
     *   keys: camelCase settings whose value changed; meta: the per-key state (locks, gates,
     *   following, ...) changed; config: admin config fields that changed.
     */
    function announceSettingsChanged(detail) {
        for (const key of detail.keys) {
            for (const fn of (_changeHandlers.get(key) || []).slice()) {
                try {
                    fn(JE.currentSettings?.[key], key, detail);
                } catch (e) {
                    console.error(`🪼 Jellyfin Enhanced: A settings change handler for ${key} failed:`, e);
                }
            }
        }
        document.dispatchEvent(new CustomEvent('je:settings-changed', { detail }));
    }

    // ---- Key-level settings.json saves (POST settings.json/patch) ----
    // A save sends only the keys that differ from the last values the server confirmed (the
    // baseline), so two devices or tabs no longer revert each other's unrelated settings, and an
    // unrelated save no longer writes the defaults back as choices. Deltas made within
    // PATCH_WINDOW_MS go out as one request. Servers without the route (no 'settingsPatch' in the
    // bootstrap Capabilities, or a 404/405 from it) get the whole document as before. Without a
    // bootstrap (JE.serverCapabilities null) the route is tried, so the 404/405 decides.
    const PATCH_WINDOW_MS = 250;
    // Keys of the served document that are never written: the caller's admin flag, and the panel's
    // last section (device-local since A7).
    const NEVER_PATCHED = new Set(['isAdmin', 'lastOpenedTab']);
    // Set once the server answered 404/405 to /patch (rolled back under an open tab).
    let _patchUnsupported = false;
    // Per user id: { baseline, baselineSource, generation, acks, pending, failed, seq, batch, timer, chain }.
    // pending: camelCase key → { value, seq } for edits (and Follows) not yet confirmed; seq numbers every
    // queued edit, so a finished request settles only the edits it carried (A-B-A safe).
    // generation counts the fresh server documents taken as the baseline from elsewhere; acks counts
    // the save answers taken into the baseline. failed: camelCase key → the value a failed request
    // carried, which the page still shows until the next refresh restores the server's.
    const _sync = {};

    /**
     * Whether this server takes key-level saves: it advertises them, or its capabilities are
     * unknown (null: the bootstrap failed) and /patch has not answered 404/405 yet. Only the
     * key-level route can change a setting that follows the server default.
     * @returns {boolean}
     */
    function patchSupported() {
        if (_patchUnsupported) return false;
        if (JE.serverCapabilities === null) return true;
        return Array.isArray(JE.serverCapabilities) && JE.serverCapabilities.includes('settingsPatch');
    }

    /**
     * A flat copy of a settings object with every key's first letter upper- or lower-cased.
     * @param {object} object Flat settings object.
     * @param {boolean} upper PascalCase (for the server) or camelCase (from it).
     * @returns {object}
     */
    function recase(object, upper) {
        const result = {};
        for (const [key, value] of Object.entries(object)) {
            result[(upper ? key.charAt(0).toUpperCase() : key.charAt(0).toLowerCase()) + key.slice(1)] = value;
        }
        return result;
    }

    /**
     * Whether two settings values are the same (null and undefined count as one).
     * @param {*} a
     * @param {*} b
     * @returns {boolean}
     */
    function sameValue(a, b) {
        return a === b || (a == null && b == null);
    }

    /**
     * The sync state of the signed-in user (created on first use). Its baseline is a copy of
     * JE.userConfig.settings, taken again whenever that object is replaced by a fresh server
     * document (bootstrap, user switch, the panel's refresh), so local edits to the object itself
     * never count as confirmed. Each such document bumps the state's generation.
     * @returns {object|null} The state, or null without a signed-in user.
     */
    function syncState() {
        const userId = typeof ApiClient !== 'undefined' && ApiClient.getCurrentUserId ? ApiClient.getCurrentUserId() : null;
        if (!userId) return null;
        const state = _sync[userId] = _sync[userId]
            || { userId, baseline: {}, baselineSource: null, generation: 0, acks: 0, pending: {}, failed: {}, seq: 0, batch: null, timer: null, chain: Promise.resolve() };
        const source = JE.userConfig?.settings;
        if (source && source !== state.baselineSource) {
            state.baselineSource = source;
            state.baseline = { ...source };
            state.generation++;
        }
        return state;
    }

    /**
     * The keys of a whole settings object that differ from what the server last confirmed
     * (merged with the defaults exactly as loadSettings shows it), or from an edit still pending.
     * Keys the server document does not have are not sent.
     * @param {object} state Sync state.
     * @param {object} settings camelCase settings (normally JE.currentSettings).
     * @returns {object} camelCase key → value to send.
     */
    function settingsDelta(state, settings) {
        const shown = mergeSettings(state.baseline, JE.pluginConfig || {});
        const delta = {};
        for (const key of Object.keys(state.baseline)) {
            if (NEVER_PATCHED.has(key) || !Object.prototype.hasOwnProperty.call(settings, key)) continue;
            const expected = Object.prototype.hasOwnProperty.call(state.pending, key) ? state.pending[key].value : shown[key];
            if (!sameValue(settings[key], expected)) delta[key] = settings[key];
        }
        return delta;
    }

    /**
     * Queues a delta for the user's next patch request and returns when that request is done.
     * @param {object} state Sync state.
     * @param {object} delta camelCase key → value.
     * @returns {Promise<{rejected: Array<{key: string, reason: string}>}>} Resolves with the
     *   rejections of this caller's keys; rejects when the request failed.
     */
    function queuePatch(state, delta, follow = []) {
        if (!state.batch) state.batch = { set: {}, seqs: {}, follow: [], waiters: [] };
        const batch = state.batch;
        for (const [key, value] of Object.entries(delta)) {
            const seq = ++state.seq;
            state.pending[key] = { value, seq };
            delete state.failed[key];
            batch.set[key] = value;
            batch.seqs[key] = seq;
            // The later request wins: a value set after "use the server default" in the same window.
            batch.follow = batch.follow.filter(name => name !== key);
        }
        for (const key of follow) {
            // ...and "use the server default" after a value set in the same window replaces it.
            delete batch.set[key];
            delete state.failed[key];
            // Until the answer, a whole-document save compares the key with the value shown now
            // (it may be the dropped Set's), so an unrelated save does not turn it back into a Set
            // that cancels this Follow. The answer settles it and shows the default.
            const seq = ++state.seq;
            state.pending[key] = { value: JE.currentSettings?.[key], seq };
            batch.seqs[key] = seq;
            if (!batch.follow.includes(key)) batch.follow.push(key);
        }
        const done = new Promise((resolve, reject) => batch.waiters.push({ keys: Object.keys(delta).concat(follow), resolve, reject }));
        if (!state.timer) state.timer = setTimeout(() => sendBatch(state), PATCH_WINDOW_MS);
        return done;
    }

    /**
     * Sends the user's open batch now (after the earlier requests, in order).
     * @param {object} state Sync state.
     * @param {boolean} [keepalive] The page is being hidden or unloaded: send it so that the
     *   browser finishes the request after the page is gone (see postPatch).
     */
    function sendBatch(state, keepalive) {
        if (state.timer) { clearTimeout(state.timer); state.timer = null; }
        const batch = state.batch;
        if (!batch) return;
        state.batch = null;
        state.chain = state.chain.then(() => postBatch(state, batch, keepalive === true)).catch(() => {});
    }

    /**
     * Posts a /patch body. While the page is being hidden or unloaded it goes out as a keepalive
     * fetch, which the browser completes after the page is gone (the request ApiClient.ajax makes
     * is cancelled with the page), signed like ApiClient's own requests; otherwise, or when the
     * client cannot sign it, through ApiClient.ajax.
     * @param {string} userId The user whose settings are saved.
     * @param {string} body The JSON body.
     * @param {boolean} keepalive Whether the page is going away.
     * @returns {Promise<object>} The answer; rejects with an error carrying `status` on failure.
     */
    async function postPatch(userId, body, keepalive) {
        const url = ApiClient.getUrl(`/JellyfinEnhanced/user-settings/${userId}/settings.json/patch`);
        if (keepalive && typeof fetch === 'function' && typeof ApiClient.setRequestHeaders === 'function') {
            const headers = { 'Content-Type': 'application/json', accept: 'application/json' };
            ApiClient.setRequestHeaders(headers);
            // Unloaded before the answer (or its body) arrived: the browser still delivers the
            // request, so nothing to report.
            const cutOff = (e) => _pageUnloading
                ? Object.assign(new Error('The page was unloaded before the settings save was answered'), { unanswered: true })
                : e;
            let answer;
            try {
                answer = await fetch(url, { method: 'POST', headers, body, keepalive: true, credentials: 'same-origin' });
            } catch (e) {
                throw cutOff(e);
            }
            if (!answer.ok) throw Object.assign(new Error(`Settings save failed: ${answer.status}`), { status: answer.status });
            try {
                return await answer.json();
            } catch (e) {
                throw cutOff(e);
            }
        }
        return ApiClient.ajax({ type: 'POST', url, data: body, contentType: 'application/json', dataType: 'json' });
    }

    /**
     * Drops the pending edits a finished request carried. An edit of the same key queued after
     * it stays pending, even when it holds the same value (A-B-A across three requests).
     * @param {object} state Sync state.
     * @param {{seqs: object}} batch The finished batch (camelCase key → edit seq it carried).
     */
    function settlePending(state, batch) {
        for (const [key, seq] of Object.entries(batch.seqs)) {
            if (state.pending[key]?.seq === seq) delete state.pending[key];
        }
    }

    /**
     * Posts one batch to /patch (or, on a server without it, the whole document to the old route)
     * and settles its callers.
     * @param {object} state Sync state.
     * @param {{set: object, seqs: object, waiters: Array}} batch The merged deltas and their callers.
     * @param {boolean} [keepalive] The page is being hidden or unloaded (see postPatch).
     * @returns {Promise<void>}
     */
    async function postBatch(state, batch, keepalive = false) {
        const fail = (error) => {
            // The page keeps showing these values: the next refresh puts the server's back.
            for (const [key, value] of Object.entries(batch.set)) {
                if (state.pending[key]?.seq === batch.seqs[key]) state.failed[key] = value;
            }
            settlePending(state, batch);
            batch.waiters.forEach(w => w.reject(error));
        };
        // The user changed since these edits were made: they belong to the previous user.
        if (ApiClient.getCurrentUserId() !== state.userId) {
            state.pending = {};
            batch.waiters.forEach(w => w.resolve({ rejected: [] }));
            return;
        }
        if (!patchSupported()) {
            await postWholeDocument(state, batch).catch(fail);
            return;
        }
        // A fresh document taken after this point may be newer or older than the answer.
        const generation = state.generation;
        let response;
        try {
            response = await postPatch(state.userId, JSON.stringify(batch.follow.length
                ? { Set: recase(batch.set, true), Follow: batch.follow.map(key => key.charAt(0).toUpperCase() + key.slice(1)) }
                : { Set: recase(batch.set, true) }), keepalive);
        } catch (e) {
            if (e?.status === 404 || e?.status === 405) {
                // The server was rolled back under this tab: use the whole-document route from now on.
                _patchUnsupported = true;
                await postWholeDocument(state, batch).catch(fail);
                return;
            }
            fail(e);
            return;
        }
        try {
            applyPatchResponse(state, batch, response, generation);
        } catch (e) {
            // The save itself went through; only taking the answer in failed.
            console.error('🪼 Jellyfin Enhanced: Could not apply the settings save answer:', e);
            settlePending(state, batch);
            batch.waiters.forEach(w => w.resolve({ rejected: [] }));
        }
    }

    /**
     * The fallback for a server without /patch: saves the whole current document the old way.
     * Posts nothing once another user is signed in (a /patch answered 404/405 after a switch):
     * JE.currentSettings is then that user's document.
     * @param {object} state Sync state.
     * @param {{set: object, seqs: object, waiters: Array}} batch The batch being sent.
     * @returns {Promise<void>}
     */
    async function postWholeDocument(state, batch) {
        if (ApiClient.getCurrentUserId() !== state.userId) {
            state.pending = {};
            batch.waiters.forEach(w => w.resolve({ rejected: [] }));
            return;
        }
        await postLegacy('settings.json', JE.currentSettings, state.userId);
        settlePending(state, batch);
        // The old route has no "use the server default": those keys are reported as not applied.
        const notFollowed = (batch.follow || []).map(key => ({ key, reason: 'unsupported' }));
        batch.waiters.forEach(w => w.resolve({ rejected: notFollowed.filter(r => w.keys.includes(r.key)) }));
    }

    /**
     * The parts of a settings Meta the panel rows show (locked keys, closed gates, and each key's
     * state against the server default: following, chosen, set by an administrator, differing,
     * and the defaults themselves), as a stable string.
     * @param {object|null|undefined} meta Camel-cased settings Meta.
     * @returns {string}
     */
    function metaGates(meta) {
        const list = name => (Array.isArray(meta?.[name]) ? meta[name].slice().sort() : []);
        const map = (name) => {
            const value = meta?.[name] && typeof meta[name] === 'object' ? meta[name] : {};
            return Object.keys(value).sort().map(key => [key, value[key]]);
        };
        return JSON.stringify([list('locked'), map('unavailable'), list('following'), list('chosen'),
            list('changedByAdmin'), list('differs'), map('defaults')]);
    }

    /**
     * Takes a /patch answer as the new baseline: keys another device or the admin changed land in
     * JE.currentSettings (beneath edits still pending, and edits made on the page and not saved
     * yet), rejected keys go back to the server's value,
     * and both are announced with a `je:settings-changed` event ({ keys, rejected }). A new Meta
     * whose locks or closed gates differ from the previous one is announced the same way (with
     * `meta: true`), even when no value changed, so open views can disable or re-enable rows.
     * When a fresh document was taken while the request was in flight (its generation differs),
     * the two cannot be ordered, so that document stays the baseline: only the keys this request
     * wrote or made follow the default take the answer's values, rejected keys go back to that
     * document's values, and the other keys and the Meta are left as they are.
     * @param {object} state Sync state.
     * @param {{set: object, seqs: object, waiters: Array}} batch The batch that was sent.
     * @param {object} response The /patch answer.
     * @param {number} generation The state's generation when the request was sent.
     */
    function applyPatchResponse(state, batch, response, generation) {
        const camel = key => key.charAt(0).toLowerCase() + key.slice(1);
        const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
        const rejected = Array.isArray(response?.Rejected)
            ? response.Rejected.filter(r => r && typeof r.Key === 'string').map(r => ({ key: camel(r.Key), reason: r.Reason }))
            : [];
        const rejectedKeys = new Set(rejected.map(r => r.key));
        // Sent values are settled whether applied or rejected; a newer edit of the same key stays pending.
        settlePending(state, batch);

        const settings = response?.Settings && typeof response.Settings === 'object' && !Array.isArray(response.Settings) ? recase(response.Settings, false) : null;
        const changed = [];
        let metaChanged = false;
        if (settings && ApiClient.getCurrentUserId() === state.userId && JE.userConfig) {
            // Also counts a document installed without a loadSettings call yet.
            syncState();
            // A refresh fetched before this answer may be older than it (applyRefresh drops it).
            state.acks++;
            if (state.generation !== generation) {
                const fresh = JE.userConfig.settings === state.baselineSource ? JE.userConfig.settings : null;
                const followed = new Set(batch.follow || []);
                for (const key of Object.keys(batch.set).concat(Array.from(followed))) {
                    if (rejectedKeys.has(key) || !has(settings, key)) continue;
                    state.baseline[key] = settings[key];
                    if (fresh) fresh[key] = settings[key];
                    // A key made to follow the default now shows the default the server answered.
                    if (followed.has(key) && !has(state.pending, key) && JE.currentSettings && !sameValue(JE.currentSettings[key], settings[key])) {
                        JE.currentSettings[key] = mergeSettings(state.baseline, JE.pluginConfig || {})[key];
                        changed.push(key);
                    }
                }
                const shown = mergeSettings(state.baseline, JE.pluginConfig || {});
                for (const key of rejectedKeys) {
                    if (NEVER_PATCHED.has(key) || has(state.pending, key) || !has(state.baseline, key)) continue;
                    if (JE.currentSettings && !sameValue(JE.currentSettings[key], shown[key])) {
                        JE.currentSettings[key] = shown[key];
                        changed.push(key);
                    }
                }
            } else {
                const previous = state.baseline;
                const shown = mergeSettings(settings, JE.pluginConfig || {});
                const shownBefore = mergeSettings(previous, JE.pluginConfig || {});
                // A followed key shows the answer's value even when the baseline already had it
                // (a Set of it earlier in the same window showed another value).
                const followed = new Set(batch.follow || []);
                for (const key of Object.keys(settings)) {
                    if (NEVER_PATCHED.has(key) || has(state.pending, key)) continue;
                    const serverChanged = !has(batch.set, key) && !sameValue(previous[key], settings[key]);
                    // An edit made on the page and not queued yet (a colour still in its save delay)
                    // stays on top, as in applyRefresh; its own save sends it. A value a failed
                    // save left on the page is not such an edit.
                    const unsavedEdit = serverChanged && !followed.has(key) && !rejectedKeys.has(key) && JE.currentSettings
                        && !sameValue(JE.currentSettings[key], shownBefore[key])
                        && !(has(state.failed, key) && sameValue(JE.currentSettings[key], state.failed[key]));
                    if (unsavedEdit) continue;
                    if ((serverChanged || followed.has(key) || rejectedKeys.has(key)) && JE.currentSettings && !sameValue(JE.currentSettings[key], shown[key])) {
                        JE.currentSettings[key] = shown[key];
                        changed.push(key);
                    }
                }
                JE.userConfig.settings = settings;
                state.baselineSource = settings;
                state.baseline = { ...settings };
                if (response.Meta && typeof JE.camelCaseSettingsMeta === 'function') {
                    const before = metaGates(JE.userConfig.settingsMeta);
                    JE.userConfig.settingsMeta = JE.camelCaseSettingsMeta(response.Meta);
                    metaChanged = metaGates(JE.userConfig.settingsMeta) !== before;
                }
            }
        }
        if (changed.length || rejected.length || metaChanged) {
            if (rejected.length) console.warn('🪼 Jellyfin Enhanced: The server did not accept some settings:', rejected);
            announceSettingsChanged(metaChanged ? { keys: changed, rejected, meta: true } : { keys: changed, rejected });
        }
        batch.waiters.forEach(w => w.resolve({ rejected: rejected.filter(r => w.keys.includes(r.key)) }));
    }

    /**
     * Marks the point a refresh is fetched from, for applyRefresh's `since`.
     * @returns {{userId: string, generation: number, acks: number}|null} Null without a signed-in user.
     */
    function refreshMark() {
        const state = syncState();
        return state ? { userId: state.userId, generation: state.generation, acks: state.acks } : null;
    }

    /**
     * Whether a save of the signed-in user failed and the page still shows the value it carried
     * (no later edit of the key), so a refresh is due even when the server's revision is unchanged.
     * @returns {boolean}
     */
    function hasFailedEdits() {
        const state = syncState();
        if (!state) return false;
        for (const [key, value] of Object.entries(state.failed)) {
            if (!Object.prototype.hasOwnProperty.call(state.pending, key) && sameValue(JE.currentSettings?.[key], value)) return true;
        }
        return false;
    }

    /**
     * Takes a settings document fetched again from the server (the focus check in plugin.js,
     * design 6.3) as the new baseline. A key lands in JE.currentSettings only where this page
     * still shows what the server last confirmed or the value of a save that failed: an edit still
     * pending, or one made on the page and not saved yet, stays on top. Locks, gates and the other
     * per-key state come with the new Meta. Changed keys, a changed Meta and changed admin config
     * fields are announced through announceSettingsChanged. A document the server reports
     * unavailable is ignored (the page keeps what it has); one that loads after an unavailable one
     * makes the settings writable again. When a save answer or another fresh document was taken
     * after `since`, the document may be older than it, so its settings and Meta are dropped
     * (`stale`); the config fields are still announced.
     * @param {{settings: object, settingsStatus: string, settingsMeta?: object}} fresh userConfig
     *   built from the bootstrap.
     * @param {{previousConfig?: object, configKeys?: string[], since?: object|null}} [options]
     *   previousConfig: the plugin config before the same refresh replaced it (what the page's
     *   values were merged with); configKeys: the config fields it changed; since: refreshMark()
     *   from before the document was fetched.
     * @returns {{changed: string[], stale: boolean}} changed: the camelCase settings keys whose
     *   value changed; stale: the settings were dropped (fetch them again).
     */
    function applyRefresh(fresh, options = {}) {
        const userConfig = JE.userConfig;
        const configKeys = Array.isArray(options.configKeys) ? options.configKeys : [];
        if (!userConfig || !fresh || userConfig.settingsStatus === 'loading') return { changed: [], stale: false };
        const state = syncState();
        if (!state) return { changed: [], stale: false };
        const since = options.since;
        const stale = !!since && (since.userId !== state.userId || since.generation !== state.generation || since.acks !== state.acks);
        const changed = [];
        let metaChanged = false;
        if (!stale && fresh.settingsStatus === 'ok' && fresh.settings && typeof fresh.settings === 'object') {
            // What the page showed until now: the last confirmed values merged with the config of
            // that time, pending edits on top. Nothing to compare with while the settings were unavailable.
            const wasLoaded = userConfig.settingsStatus === 'ok';
            const before = mergeSettings(wasLoaded ? state.baseline : {}, options.previousConfig || JE.pluginConfig || {});
            for (const [key, edit] of Object.entries(state.pending)) before[key] = edit.value;
            const metaBefore = metaGates(userConfig.settingsMeta);
            const failed = state.failed;
            state.failed = {};
            userConfig.settings = fresh.settings;
            userConfig.settingsStatus = 'ok';
            if (fresh.settingsMeta) userConfig.settingsMeta = fresh.settingsMeta;
            else delete userConfig.settingsMeta;
            // Takes the new baseline (a patch answer in flight then only settles its own keys).
            const after = JE.loadSettings();
            const current = JE.currentSettings || (JE.currentSettings = {});
            for (const key of new Set(Object.keys(before).concat(Object.keys(after)))) {
                // A value a failed save left on the page is not an edit to keep.
                const failedValue = Object.prototype.hasOwnProperty.call(failed, key)
                    && !Object.prototype.hasOwnProperty.call(state.pending, key) && sameValue(current[key], failed[key]);
                if (key === 'lastOpenedTab' || (!failedValue && !sameValue(current[key], before[key])) || sameValue(current[key], after[key])) continue;
                current[key] = after[key];
                changed.push(key);
            }
            metaChanged = metaGates(userConfig.settingsMeta) !== metaBefore;
        }
        if (changed.length || metaChanged || configKeys.length) {
            const detail = { keys: changed, rejected: [] };
            if (metaChanged) detail.meta = true;
            if (configKeys.length) detail.config = configKeys.slice();
            announceSettingsChanged(detail);
        }
        return { changed, stale };
    }

    // A batch still waiting for its window would be lost with the page: send it now, as a
    // request the browser finishes after the page is gone.
    const flushAllBatches = () => Object.values(_sync).forEach(state => sendBatch(state, true));

    JE.internals = JE.internals || {};
    // flush: sends every batch still waiting for its window now, for a caller saving while the page
    // is hidden or unloaded (after this module's own pagehide flush already ran).
    JE.internals.settingsSync = { applyRefresh, refreshMark, hasFailedEdits, flush: flushAllBatches };

    /**
     * Makes settings follow the server default again ("Use server default"): a Follow operation in
     * the user's next /patch request, never today's default written as a choice. Locked keys and
     * keys without a server default are refused by the server and reported back.
     * @param {string[]} keys Settings in camelCase or PascalCase.
     * @returns {Promise<{rejected: Array<{key: string, reason: string}>}>} Resolves once the
     *   request is done, with the keys it did not apply; rejects when it failed, when the settings
     *   are not loaded, or when the server cannot take key-level saves.
     */
    JE.settings.follow = async (keys) => {
        const names = (Array.isArray(keys) ? keys : [])
            .filter(key => typeof key === 'string' && key)
            .map(key => key.charAt(0).toLowerCase() + key.slice(1));
        if (!names.length) return { rejected: [] };
        const status = JE.userConfig?.settingsStatus;
        if (status === 'loading' || status === 'unavailable') throw new Error('Settings are not loaded; not saving');
        if (!patchSupported()) throw new Error('This server cannot make settings follow its defaults');
        const state = syncState();
        if (!state) throw new Error('User ID not available');
        return queuePatch(state, {}, Array.from(new Set(names)));
    };

    // Set from pagehide until the page is shown again (back/forward cache): see postPatch.
    let _pageUnloading = false;
    window.addEventListener('pagehide', () => { _pageUnloading = true; });
    window.addEventListener('pageshow', () => { _pageUnloading = false; });
    window.addEventListener('pagehide', flushAllBatches);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flushAllBatches();
    });

    /**
     * Saves user settings to the server.
     * settings.json goes out key by key when the server supports it (see above): only what
     * differs from the server's last confirmed values, merged with other saves made within
     * PATCH_WINDOW_MS; the promise resolves once that request is done.
     * Skips the POST if the data is identical to the last value saved this session
     * (prevents redundant writes). The first save per session for a given file is
     * always allowed through since the cache starts empty.
     * Never saves settings.json while the stored document failed to load
     * (JE.userConfig.settingsStatus 'unavailable') or is still loading after a
     * user switch ('loading'): the in-memory values are then fallback defaults
     * and would overwrite the user's real preferences.
     * Failures are logged and swallowed unless the caller opts in to them.
     * @param {string} fileName Per-user settings file, e.g. 'settings.json'.
     * @param {object} settings The whole document to save.
     * @param {{throwOnError?: boolean, notifyOnError?: boolean}} [options] throwOnError: reject
     *   (without logging) when nothing was saved, so a caller can roll back its own optimistic
     *   change. notifyOnError: when the server request fails, also show a "couldn't save" toast
     *   (the control is not reverted; the next refresh shows the stored value). Refusals while
     *   the settings are loading or unavailable are not toasted: the panel shows those itself.
     * @returns {Promise<void>}
     */
    JE.saveUserSettings = async (fileName, settings, options = {}) => {
        const throwOnError = options?.throwOnError === true;
        const notifyOnError = options?.notifyOnError === true;
        if (fileName === 'settings.json' && JE.userConfig?.settingsStatus === 'loading') {
            if (throwOnError) throw new Error('Settings are still loading; not saving');
            return;
        }
        if (fileName === 'settings.json' && JE.userConfig?.settingsStatus === 'unavailable') {
            if (throwOnError) throw new Error('Settings could not be loaded; not saving');
            if (!_warnedSettingsUnavailable) {
                _warnedSettingsUnavailable = true;
                console.warn('🪼 Jellyfin Enhanced: Your settings could not be loaded, so changes are not saved until they load.');
            }
            return;
        }
        if (typeof ApiClient === 'undefined' || !ApiClient.getCurrentUserId) {
            if (throwOnError) throw new Error('ApiClient not available');
            console.error("🪼 Jellyfin Enhanced: ApiClient not available");
            return;
        }
        try {
            const userId = ApiClient.getCurrentUserId();
            if (!userId) {
                if (throwOnError) throw new Error('User ID not available');
                console.error("🪼 Jellyfin Enhanced: User ID not available");
                return;
            }

            if (fileName === 'settings.json' && patchSupported()) {
                const state = syncState();
                const delta = settingsDelta(state, settings || {});
                if (!Object.keys(delta).length) return; // nothing differs from the server or a pending edit
                const { rejected } = await queuePatch(state, delta);
                if (rejected.length && throwOnError) {
                    throw new Error(`The server did not accept: ${rejected.map(r => `${r.key} (${r.reason})`).join(', ')}`);
                }
                return;
            }
            await postLegacy(fileName, settings, userId);
        } catch (e) {
            if (e?.unanswered) {
                // Sent as the page was unloaded (see postPatch): not a failure the user can act on.
                if (throwOnError) throw e;
                return;
            }
            if (notifyOnError) toastSaveFailed();
            if (throwOnError) throw e;
            console.error(`🪼 Jellyfin Enhanced: Failed to save ${fileName}:`, e);
        }
    };

    /**
     * Posts a whole per-user document (the original save path): skipped when identical to the
     * last document saved this page load, and chained per file so saves reach the server in order.
     * @param {string} fileName Per-user settings file.
     * @param {object} settings The whole document (camelCase for settings.json and bookmark.json).
     * @param {string} userId The user the document belongs to.
     * @returns {Promise<void>} Rejects when the request failed.
     */
    async function postLegacy(fileName, settings, userId) {
        // Convert data back to PascalCase for server C# deserialization
        let dataToSave = settings;
        // currentSettings carries the resolved native-poster value (on). Leave it
        // unset on disk until the user explicitly switches it in the panel.
        if (fileName === 'settings.json' && settings === JE.currentSettings
            && JE.userConfig?.settings?.useNativePosterTags == null) {
            dataToSave = { ...settings, useNativePosterTags: null };
        }
        if ((fileName === 'bookmark.json' || fileName === 'settings.json') && typeof window.JellyfinEnhanced?.toPascalCase === 'function') {
            dataToSave = window.JellyfinEnhanced.toPascalCase(dataToSave);
        }

        const serialized = JSON.stringify(dataToSave);
        const cacheKey = `${userId}:${fileName}`;

        const post = async () => {
            // Skip the POST if nothing has changed since the last save this session.
            if (_lastSavedJson[cacheKey] === serialized) {
                return; // no-op — identical to last save
            }

            await ApiClient.ajax({
                type: 'POST',
                url: ApiClient.getUrl(`/JellyfinEnhanced/user-settings/${userId}/${fileName}`),
                data: serialized,
                contentType: 'application/json'
            });

            // Update the cache on success so subsequent identical saves are skipped
            _lastSavedJson[cacheKey] = serialized;
        };
        const save = (_saveChain[cacheKey] || Promise.resolve()).then(post);
        _saveChain[cacheKey] = save.catch(() => {});
        await save;
    }

    /**
     * Merges a settings document with the plugin defaults and the hardcoded fallbacks: what the
     * client uses for each key (the document's value, else the admin default, else the fallback).
     * @param {object} userSettings camelCase settings document (may be empty).
     * @param {object} pluginDefaults The public plugin config.
     * @returns {object} The merged settings.
     */
    function mergeSettings(userSettings, pluginDefaults) {
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

        // Per-user defaults the server builds from its settings registry (the values a new user is
        // seeded with, by settings.json key), sent to signed-in users in the public config. When the
        // block is there it is the only source of admin defaults for the keys below.
        const userSettingDefaults = pluginDefaults.UserSettingDefaults
            && typeof pluginDefaults.UserSettingDefaults === 'object'
            && !Array.isArray(pluginDefaults.UserSettingDefaults)
            ? pluginDefaults.UserSettingDefaults
            : null;

        // Public-config fields read by name instead, even with the block: the block leaves out the
        // free-form display language, and disableAllShortcuts is a client-only key (no registry entry).
        const plainAdminFields = {
            displayLanguage: 'DefaultLanguage',
            disableAllShortcuts: 'DisableAllShortcuts'
        };

        // Admin fields whose name differs from the client key. Only used without the block: a newer
        // bundle talking to a server from before UserSettingDefaults (for example after a rollback).
        const legacyPluginDefaultAliases = {
            selectedStylePresetIndex: 'DefaultSubtitleStyle',
            selectedFontSizePresetIndex: 'DefaultSubtitleSize',
            selectedFontFamilyPresetIndex: 'DefaultSubtitleFont',
            selectedTextEffectPresetIndex: 'DefaultSubtitleTextEffect',
            displayLanguage: 'DefaultLanguage',
            watchProgressMode: 'WatchProgressDefaultMode'
        };

        /**
         * Resolves the admin default for a camelCase settings key: UserSettingDefaults when the
         * server sends it, else the same-named or aliased public-config field.
         * @param {string} key camelCase settings key.
         * @returns {*} The default, or undefined when there is none (hardcodedDefaults applies).
         */
        const getPluginDefault = (key) => {
            const pascalKey = key.charAt(0).toUpperCase() + key.slice(1);
            let candidates;
            if (!userSettingDefaults) {
                candidates = [key, pascalKey];
                if (legacyPluginDefaultAliases[key]) candidates.push(legacyPluginDefaultAliases[key]);
            } else if (Object.prototype.hasOwnProperty.call(plainAdminFields, key)) {
                candidates = [plainAdminFields[key]];
            } else {
                const value = Object.prototype.hasOwnProperty.call(userSettingDefaults, pascalKey) ? userSettingDefaults[pascalKey] : undefined;
                return value !== null && value !== undefined ? value : undefined;
            }

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
    }

    /**
     * Loads and merges settings from user config, plugin defaults, and hardcoded fallbacks.
     * Edits not yet confirmed by the server (key-level saves in flight or waiting to be sent) stay
     * on top, so a refresh never undoes a change the user just made.
     * @returns {object} The settings for JE.currentSettings.
     */
    JE.loadSettings = () => {
        const merged = mergeSettings(JE.userConfig?.settings || {}, JE.pluginConfig || {});
        // Also takes the baseline from a freshly loaded document, before any control edits it.
        const state = syncState();
        if (state) {
            for (const [key, edit] of Object.entries(state.pending)) merged[key] = edit.value;
        }
        return merged;
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
