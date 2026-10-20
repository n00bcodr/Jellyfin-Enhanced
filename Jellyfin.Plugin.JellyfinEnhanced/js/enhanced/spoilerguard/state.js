// @ts-check
// In-memory Spoiler Guard state and server API operations.
(function(JE) {
    'use strict';

    JE.internals = JE.internals || {};
    /** @type {any} Shared cross-file namespace; each module contributes a focused surface. */
    const internal = JE.internals.spoilerGuard = JE.internals.spoilerGuard || {};
    const logPrefix = '🪼 Jellyfin Enhanced [SpoilerGuard]:';

    const enabledSeries = new Set();
    const enabledMovies = new Set();
    const enabledCollections = new Set();
    const enabledPendingTmdb = new Set();

    let userPrefs = {};
    let loaded = false;
    let loadOk = false;
    let statePromise = null;
    // A failed read settles fail-closed but stays retryable: a few timed recoveries, then
    // on-demand reloads at most once per window. Both belong to the session that failed.
    const RECOVERY_DELAYS_MS = [2000, 10000, 30000];
    const RETRY_AFTER_MS = 5000;
    let failedAt = 0;
    let recoveryAttempt = 0;
    let recoveryTimer = null;
    // Titles whose state an accepted write established while the full state is unavailable.
    const confirmed = new Map();

    function request(path, options) {
        return JE.core.api.plugin(path, options);
    }

    /** An unshared full-state read; a unique signal prevents joining a read submitted before a write. */
    function readState() {
        return request('/spoiler-blur/series', { skipCache: true, signal: new AbortController().signal });
    }

    let mutationQueue = Promise.resolve();
    let generation = 0;

    /** Replaces every mirror from the same complete server document; removed copies and mappings disappear. */
    function adoptState(data) {
        const value = data || {};
        enabledSeries.clear();
        enabledMovies.clear();
        enabledCollections.clear();
        enabledPendingTmdb.clear();
        Object.keys(value.Series || {}).forEach(key => enabledSeries.add(internal.normalizeId(key)));
        Object.keys(value.Movies || {}).forEach(key => enabledMovies.add(internal.normalizeId(key)));
        Object.keys(value.Collections || {}).forEach(key => enabledCollections.add(internal.normalizeId(key)));
        Object.keys(value.ProviderTitles || {}).forEach(key => enabledPendingTmdb.add(String(key).replace(':tmdb:', ':').toLowerCase()));
        Object.keys(value.PendingTmdb || {}).forEach(key => enabledPendingTmdb.add(String(key).toLowerCase()));
        userPrefs = value.Prefs || {};
        loaded = true;
        loadOk = true;
        recoveryAttempt = 0;
        clearTimeout(recoveryTimer);
        recoveryTimer = null;
        confirmed.clear();
    }

    /** Applies an accepted write's own effect when its authoritative reread failed. */
    function applyConfirmed(kind, key, set, enabled) {
        if (enabled) set.add(key);
        else set.delete(key);
        confirmed.set(`${kind}:${key}`, enabled);
    }

    /** Subscribes a mounted view to state settlement without retaining detached views in global listeners. */
    internal.bindStateView = function(node, refresh) {
        const action = JE.createSessionAction();
        node.classList.add('je-spoiler-state-view');
        node.jeSpoilerRefresh = function() {
            if (action.current()) refresh();
            else {
                // An outgoing preferences section must never adopt the incoming viewer's values.
                node.querySelectorAll('input, button').forEach(control => { control.disabled = true; });
                if (node.tagName === 'BUTTON') node.disabled = true;
            }
        };
        node.addEventListener('je-spoiler-state-changed', node.jeSpoilerRefresh);
    };

    /** State settlement is an event for every mounted, session-bound privacy view. */
    function refreshControls() {
        document.querySelectorAll('.je-spoiler-state-view').forEach(node => {
            node.dispatchEvent(new CustomEvent('je-spoiler-state-changed'));
        });
    }

    /** Settles a failed read fail-closed and schedules the next bounded, session-bound recovery read. */
    function settleFailed() {
        loaded = true;
        loadOk = false;
        statePromise = null;
        failedAt = Date.now();
        if (recoveryTimer || recoveryAttempt >= RECOVERY_DELAYS_MS.length) return;
        const action = JE.createSessionAction();
        recoveryTimer = setTimeout(function() {
            recoveryTimer = null;
            // A load already in flight settles (and reschedules) on its own.
            if (!action.current() || loadOk || statePromise) return;
            recoveryAttempt++;
            void startLoad();
        }, RECOVERY_DELAYS_MS[recoveryAttempt]);
    }

    /** All controls share one ordered write, authoritative read and policy notification path. */
    function mutateState(path, options, project) {
        const action = JE.createSessionAction();
        // A submitted operation (a title action press) must still be current right before the write;
        // what follows an accepted write stays bound to the session only.
        const submitted = JE.createSessionAction({ submitted: true });
        const task = mutationQueue.catch(() => {}).then(async () => {
            if (!action.current() || !submitted.current()) return;
            // The transport checks the operation (if any) again right before the bytes go out (after the core queue).
            let response;
            try { response = await request(path, { ...options, bound: submitted.operationBound() }); }
            catch (err) { if (err?.name === 'AbortError' && !submitted.current()) return; throw err; }
            if (!action.current()) return response;
            generation++;
            JE.core.api.manager?.invalidatePresentation?.();
            try {
                const value = await readState();
                if (!action.current()) return response;
                adoptState(value);
                statePromise = Promise.resolve();
            } catch (err) {
                if (!action.current()) return response;
                // The write was accepted: show its own effect, keep consumers fail-closed, and reconcile later.
                console.warn(`${logPrefix} state reread failed after an accepted change; recovering:`, err);
                project();
                recoveryAttempt = 0;
                settleFailed();
            } finally {
                if (action.current()) {
                    window.dispatchEvent(new CustomEvent('je-spoiler-policy-changed', { detail: { userId: ApiClient.getCurrentUserId() } }));
                    refreshControls();
                    internal.refreshSpoilerableImages?.();
                    void JE.tagPipeline?.invalidateServerCache?.();
                    JE.tagPipeline?.clearProcessed?.();
                    JE.tagPipeline?.scheduleScan?.();
                }
            }
            return response;
        });
        mutationQueue = task.catch(() => {});
        return task;
    }

    /** Reads this viewer's state; a late reply from another session or an older generation is dropped. */
    function startLoad() {
        // A response resolving after a user switch must not populate the
        // (already reset) state with the previous user's data.
        const action = JE.createSessionAction();
        // The page-load bootstrap carries this user's state (same body as the
        // endpoint); it is handed out once, so later loads ask the server.
        const requestGeneration = generation;
        const prefetchedState = JE.takePrefetched?.('SpoilerBlurSeries');
        statePromise = (prefetchedState ? Promise.resolve(prefetchedState) : readState())
            .then(function(data) {
                if (!action.current() || requestGeneration !== generation) return;
                adoptState(data);
                refreshControls();
                // If tag renderers already ran fail-closed while this request was
                // in flight, give them one authoritative pass now.
                try {
                    JE.tagPipeline?.clearProcessed?.();
                    JE.tagPipeline?.scheduleScan?.();
                } catch (e) {
                    console.warn(`${logPrefix} post-load tag rescan failed:`, e);
                }
            })
            .catch(function(err) {
                if (!action.current() || requestGeneration !== generation) return;
                console.error(`${logPrefix} state load failed; downstream consumers will fail closed:`, err);
                settleFailed();
                refreshControls();
                // Tag renderers held back on cards while this was in flight
                // (e.g. user-review chips, see ratingtags.js): with the state
                // settled — failed, so ratings stay suppressed — give them
                // their final pass too.
                try {
                    JE.tagPipeline?.clearProcessed?.();
                    JE.tagPipeline?.scheduleScan?.();
                } catch (e) {
                    console.warn(`${logPrefix} post-failure tag rescan failed:`, e);
                }
            });
        return statePromise;
    }

    internal.loadState = function() {
        if (statePromise) return statePromise;
        // A settled failure answers fail-closed until its window passes; the next demand retries.
        if (loaded && !loadOk && Date.now() - failedAt < RETRY_AFTER_MS) return Promise.resolve();
        return startLoad();
    };

    internal.whenLoaded = function() {
        if (JE.pluginConfig?.SpoilerBlurEnabled !== true) return Promise.resolve();
        if (loaded && loadOk) return Promise.resolve();
        return internal.loadState();
    };

    internal.isStateLoaded = function() { return loaded; };
    internal.isLoadOk = function() { return loadOk; };
    // True once a state request has settled (successfully or not).
    internal.isLoaded = function() { return loaded; };
    internal.isEnabledFor = function(id) { return enabledSeries.has(internal.normalizeId(id)); };
    internal.isMovieEnabledFor = function(id) { return enabledMovies.has(internal.normalizeId(id)); };
    internal.isCollectionEnabledFor = function(id) { return enabledCollections.has(internal.normalizeId(id)); };
    internal.hasAnyState = function() {
        return enabledSeries.size > 0 || enabledMovies.size > 0 || enabledCollections.size > 0 || enabledPendingTmdb.size > 0;
    };

    internal.isEnabledForKind = function(kind, id) {
        if (kind === 'movie') return internal.isMovieEnabledFor(id);
        if (kind === 'collection') return internal.isCollectionEnabledFor(id);
        return internal.isEnabledFor(id);
    };

    internal.enableForSeries = function(id) {
        const key = internal.normalizeId(id);
        return mutateState(`/spoiler-blur/series/${encodeURIComponent(key)}`, { method: 'POST', skipRetry: true }, () => applyConfirmed('series', key, enabledSeries, true));
    };
    internal.disableForSeries = function(id) {
        const key = internal.normalizeId(id);
        return mutateState(`/spoiler-blur/series/${encodeURIComponent(key)}`, { method: 'DELETE', skipRetry: true }, () => applyConfirmed('series', key, enabledSeries, false));
    };
    internal.enableForMovie = function(id, name) {
        const key = internal.normalizeId(id);
        return mutateState(`/spoiler-blur/movies/${encodeURIComponent(key)}`, { method: 'POST', body: { MovieName: name || '' }, skipRetry: true }, () => applyConfirmed('movie', key, enabledMovies, true));
    };
    internal.disableForMovie = function(id) {
        const key = internal.normalizeId(id);
        return mutateState(`/spoiler-blur/movies/${encodeURIComponent(key)}`, { method: 'DELETE', skipRetry: true }, () => applyConfirmed('movie', key, enabledMovies, false));
    };
    internal.enableForCollection = function(id, name) {
        const key = internal.normalizeId(id);
        return mutateState(`/spoiler-blur/collections/${encodeURIComponent(key)}`, { method: 'POST', body: { CollectionName: name || '' }, skipRetry: true }, () => applyConfirmed('collection', key, enabledCollections, true));
    };
    internal.disableForCollection = function(id) {
        const key = internal.normalizeId(id);
        return mutateState(`/spoiler-blur/collections/${encodeURIComponent(key)}`, { method: 'DELETE', skipRetry: true }, () => applyConfirmed('collection', key, enabledCollections, false));
    };

    /** True when the mirrors can answer for this title: a loaded state, or an accepted write since. */
    internal.isKnownForKind = function(kind, id) {
        return loadOk || confirmed.has(`${kind === 'movie' || kind === 'collection' ? kind : 'series'}:${internal.normalizeId(id)}`);
    };
    internal.isTmdbKnown = function(mediaType, tmdbId) {
        return loadOk || confirmed.has(`tmdb:${internal.pendingKey(mediaType, tmdbId)}`);
    };

    internal.isTmdbEnabled = function(mediaType, tmdbId, jellyfinMediaId) {
        const key = internal.pendingKey(mediaType, tmdbId);
        // A confirmed disable must win over stale Movies/Series fallback until a full read reconciles it.
        if (confirmed.has(`tmdb:${key}`)) return confirmed.get(`tmdb:${key}`);
        if (key && enabledPendingTmdb.has(key)) return true;
        const jellyfinId = jellyfinMediaId;
        if (!jellyfinId) return false;
        if (mediaType === 'movie') return internal.isMovieEnabledFor(jellyfinId);
        if (mediaType === 'tv') return internal.isEnabledFor(jellyfinId);
        return false;
    };

    internal.enableForTmdb = function(mediaType, tmdbId, displayName) {
        const type = String(mediaType || '').toLowerCase();
        const id = String(tmdbId || '').trim();
        if (!id || (type !== 'tv' && type !== 'movie')) return Promise.reject(new Error('invalid mediaType/tmdbId'));
        const query = displayName ? `?displayName=${encodeURIComponent(displayName)}` : '';
        return mutateState(`/spoiler-blur/pending/${type}/${encodeURIComponent(id)}${query}`, { method: 'POST', skipRetry: true }, () => applyConfirmed('tmdb', internal.pendingKey(type, id), enabledPendingTmdb, true));
    };
    internal.disableForTmdb = function(mediaType, tmdbId) {
        const type = String(mediaType || '').toLowerCase();
        const id = String(tmdbId || '').trim();
        if (!id || (type !== 'tv' && type !== 'movie')) return Promise.reject(new Error('invalid mediaType/tmdbId'));
        return mutateState(`/spoiler-blur/pending/${type}/${encodeURIComponent(id)}`, { method: 'DELETE', skipRetry: true }, () => applyConfirmed('tmdb', internal.pendingKey(type, id), enabledPendingTmdb, false));
    };

    internal.getUserPrefs = function() { return Object.assign({}, userPrefs); };
    // The library series and movies the person guards (Jellyfin ids, N form): copies, read-only. Lists (phase 4c3a)
    // map them to TMDB ids to guard entries of the same titles that aren't in the library.
    internal.guardedIds = function() { return { series: Array.from(enabledSeries), movies: Array.from(enabledMovies) }; };
    internal.setUserPrefs = function(next) {
        return mutateState('/spoiler-blur/user-prefs', { method: 'POST', body: next || {}, skipRetry: true }, () => { userPrefs = { ...(next || {}) }; })
            .then(() => internal.getUserPrefs());
    };

    // Spoiler Guard state (enabled series/movies/collections, prefs) is
    // per-user and memoized for the whole SPA session via statePromise.
    // Drop it on a user switch so the next whenLoaded() fetches the new
    // user's state instead of serving the previous user's.
    JE.session?.onUserChange('spoilerguard-state', () => {
        generation++;
        mutationQueue = Promise.resolve();
        statePromise = null;
        clearTimeout(recoveryTimer);
        recoveryTimer = null;
        recoveryAttempt = 0;
        failedAt = 0;
        confirmed.clear();
        loaded = false;
        loadOk = false;
        enabledSeries.clear();
        enabledMovies.clear();
        enabledCollections.clear();
        enabledPendingTmdb.clear();
        userPrefs = {};
        // The outgoing viewer's native toggles show their state; the next page view draws the incoming one.
        document.querySelectorAll('.je-spoiler-blur-btn').forEach(button => button.remove());
        refreshControls();
    });
})(window.JellyfinEnhanced);
