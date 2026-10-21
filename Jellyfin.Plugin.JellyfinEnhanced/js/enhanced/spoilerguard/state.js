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
    // A pending enable can be promoted immediately. Keep the returned Jellyfin
    // id so a Seerr payload without jellyfinMediaId still renders the live state.
    const tmdbToJellyfin = new Map();

    let userPrefs = {};
    let loaded = false;
    let loadOk = false;
    let statePromise = null;
    // The document revision (core/access-revision.js) the state was read under, taken BEFORE the read; null: unknown.
    // Another tab or device saving the person's Spoiler Guard state moves it: the state is read again, in place.
    let loadedRevision = null;
    // A newer revision than the one the state was read under has been seen: the next use reads it again.
    let stale = false;
    // Changes made from this tab (each bumps it): a read that ran across one doesn't replace what it changed.
    let localEdits = 0;

    /** @returns {string|null} The document revision known now. */
    function knownRevision() {
        return JE.core?.revision?.document?.('spoiler-guard') ?? null;
    }

    /**
     * Puts a state read in place: only when it differs from what is shown are consumers told (no flicker).
     * @param {any} value - The state as read.
     * @returns {boolean} True when anything changed.
     */
    function applyState(value) {
        const ids = (map) => Object.keys(map || {}).map(key => internal.normalizeId(key)).sort().join(',');
        const pending = (map) => Object.keys(map || {}).map(key => String(key).toLowerCase()).sort().join(',');
        const changed = !loaded || !loadOk
            || ids(value.Series) !== [...enabledSeries].sort().join(',')
            || ids(value.Movies) !== [...enabledMovies].sort().join(',')
            || ids(value.Collections) !== [...enabledCollections].sort().join(',')
            || pending(value.PendingTmdb) !== [...enabledPendingTmdb].sort().join(',')
            || JSON.stringify(value.Prefs || {}) !== JSON.stringify(userPrefs);
        if (!changed) return false;
        enabledSeries.clear();
        enabledMovies.clear();
        enabledCollections.clear();
        enabledPendingTmdb.clear();
        tmdbToJellyfin.clear();
        Object.keys(value.Series || {}).forEach(key => enabledSeries.add(internal.normalizeId(key)));
        Object.keys(value.Movies || {}).forEach(key => enabledMovies.add(internal.normalizeId(key)));
        Object.keys(value.Collections || {}).forEach(key => enabledCollections.add(internal.normalizeId(key)));
        Object.keys(value.PendingTmdb || {}).forEach(key => enabledPendingTmdb.add(String(key).toLowerCase()));
        userPrefs = value.Prefs || {};
        return true;
    }

    /** Tell current detail-page consumers to discard topic content after a policy change. */
    function notifyPolicyChanged() {
        window.dispatchEvent(new Event('je:spoiler-changed'));
    }

    function request(path, options) {
        return JE.core.api.plugin(path, options);
    }

    internal.loadState = function() {
        if (statePromise && !stale) return statePromise;
        stale = false;
        // A response resolving after a user switch must not populate the
        // (already reset) state with the previous user's data.
        const requestEpoch = JE.session ? JE.session.getEpoch() : 0;
        // Taken before the read: the state as read is at least this new.
        const revision = knownRevision();
        const edits = localEdits;
        const first = !loaded;
        // The page-load bootstrap carries this user's state (same body as the
        // endpoint); it is handed out once, so later loads ask the server.
        const prefetchedState = JE.takePrefetched?.('SpoilerBlurSeries');
        const promise = (prefetchedState ? Promise.resolve(prefetchedState) : request('/spoiler-blur/series'))
            .then(function(data) {
                if (JE.session && !JE.session.isCurrent(requestEpoch)) return;
                if (statePromise !== promise) return;
                // Changed from this tab while the read ran: what it changed stays; read again on the next use.
                if (!first && localEdits !== edits) { stale = true; return; }
                const changed = applyState(data || {});
                // A revision that moved while this read ran may or may not be in it: read again on the next use.
                const now = knownRevision();
                loadedRevision = now === revision ? revision : null;
                if (now !== revision) stale = true;
                loaded = true;
                loadOk = true;
                if (!changed && !first) return;
                if (!first) notifyPolicyChanged();
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
                if (JE.session && !JE.session.isCurrent(requestEpoch)) return;
                if (statePromise !== promise) return;
                // A read again after a revision that failed: the state shown stays (read again on the next use).
                if (!first && loadOk) { stale = true; return; }
                console.error(`${logPrefix} state load failed; downstream consumers will fail closed:`, err);
                loaded = true;
                loadOk = false;
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
        statePromise = promise;
        return promise;
    };

    // Another tab or device saved this person's Spoiler Guard state (its document revision moved): read it again now
    // when it is in use, else on the next use. The state shown stays until the new one is in (only changes are drawn).
    document.addEventListener('je-document-revision', function(e) {
        const detail = e.detail || {};
        if (detail.document !== 'spoiler-guard' || detail.revision === loadedRevision) return;
        stale = true;
        if (loaded && JE.pluginConfig?.SpoilerBlurEnabled === true) internal.loadState();
    });

    internal.whenLoaded = function() {
        if (JE.pluginConfig?.SpoilerBlurEnabled !== true) return Promise.resolve();
        if (loaded) {
            // Kept under an older revision: read again (the state shown answers until it is in).
            if (stale) internal.loadState();
            return Promise.resolve();
        }
        return statePromise || internal.loadState();
    };

    internal.isStateLoaded = function() { return loaded; };
    internal.isLoadOk = function() { return loadOk; };
    // True once the initial state request has settled (successfully or not).
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
        const requestEpoch = JE.session ? JE.session.getEpoch() : 0;
        const normalized = internal.normalizeId(id);
        return request(`/spoiler-blur/series/${encodeURIComponent(normalized)}`, { method: 'POST', skipRetry: true })
            .then(function() {
                if (JE.session && !JE.session.isCurrent(requestEpoch)) return;
                localEdits++;
                enabledSeries.add(normalized);
                notifyPolicyChanged();
            });
    };

    internal.disableForSeries = function(id) {
        const requestEpoch = JE.session ? JE.session.getEpoch() : 0;
        const normalized = internal.normalizeId(id);
        return request(`/spoiler-blur/series/${encodeURIComponent(normalized)}`, { method: 'DELETE', skipRetry: true })
            .then(function() {
                if (JE.session && !JE.session.isCurrent(requestEpoch)) return;
                localEdits++;
                enabledSeries.delete(normalized);
                notifyPolicyChanged();
            });
    };

    internal.enableForMovie = function(id, name) {
        const requestEpoch = JE.session ? JE.session.getEpoch() : 0;
        const normalized = internal.normalizeId(id);
        return request(`/spoiler-blur/movies/${encodeURIComponent(normalized)}`, {
            method: 'POST', body: { MovieName: name || '' }, skipRetry: true
        }).then(function() {
                if (JE.session && !JE.session.isCurrent(requestEpoch)) return;
                localEdits++;
                enabledMovies.add(normalized);
                notifyPolicyChanged();
            });
    };

    internal.disableForMovie = function(id) {
        const requestEpoch = JE.session ? JE.session.getEpoch() : 0;
        const normalized = internal.normalizeId(id);
        return request(`/spoiler-blur/movies/${encodeURIComponent(normalized)}`, { method: 'DELETE', skipRetry: true })
            .then(function() {
                if (JE.session && !JE.session.isCurrent(requestEpoch)) return;
                localEdits++;
                enabledMovies.delete(normalized);
                notifyPolicyChanged();
            });
    };

    internal.enableForCollection = function(id, name) {
        const requestEpoch = JE.session ? JE.session.getEpoch() : 0;
        const normalized = internal.normalizeId(id);
        return request(`/spoiler-blur/collections/${encodeURIComponent(normalized)}`, {
            method: 'POST', body: { CollectionName: name || '' }, skipRetry: true
        }).then(function() {
                if (JE.session && !JE.session.isCurrent(requestEpoch)) return;
                localEdits++;
                enabledCollections.add(normalized);
                notifyPolicyChanged();
            });
    };

    internal.disableForCollection = function(id) {
        const requestEpoch = JE.session ? JE.session.getEpoch() : 0;
        const normalized = internal.normalizeId(id);
        return request(`/spoiler-blur/collections/${encodeURIComponent(normalized)}`, { method: 'DELETE', skipRetry: true })
            .then(function() {
                if (JE.session && !JE.session.isCurrent(requestEpoch)) return;
                localEdits++;
                enabledCollections.delete(normalized);
                notifyPolicyChanged();
            });
    };

    internal.isTmdbEnabled = function(mediaType, tmdbId, jellyfinMediaId) {
        const key = internal.pendingKey(mediaType, tmdbId);
        if (key && enabledPendingTmdb.has(key)) return true;
        const jellyfinId = jellyfinMediaId || (key ? tmdbToJellyfin.get(key) : null);
        if (!jellyfinId) return false;
        if (mediaType === 'movie') return internal.isMovieEnabledFor(jellyfinId);
        if (mediaType === 'tv') return internal.isEnabledFor(jellyfinId);
        return false;
    };

    internal.enableForTmdb = function(mediaType, tmdbId, displayName) {
        const requestEpoch = JE.session ? JE.session.getEpoch() : 0;
        const type = String(mediaType || '').toLowerCase();
        const id = String(tmdbId || '').trim();
        if (!id || (type !== 'tv' && type !== 'movie')) return Promise.reject(new Error('invalid mediaType/tmdbId'));
        const query = displayName ? `?displayName=${encodeURIComponent(displayName)}` : '';
        return request(`/spoiler-blur/pending/${type}/${encodeURIComponent(id)}${query}`, { method: 'POST', skipRetry: true })
            .then(function(response) {
                if (JE.session && !JE.session.isCurrent(requestEpoch)) return response;
                localEdits++;
                const key = internal.pendingKey(type, id);
                if (response?.promoted === 'pending') {
                    if (key) enabledPendingTmdb.add(key);
                } else if (response?.promoted === 'series' && response.jellyfinId) {
                    const jellyfinId = internal.normalizeId(response.jellyfinId);
                    enabledSeries.add(jellyfinId);
                    if (key) { enabledPendingTmdb.delete(key); tmdbToJellyfin.set(key, jellyfinId); }
                } else if (response?.promoted === 'movie' && response.jellyfinId) {
                    const jellyfinId = internal.normalizeId(response.jellyfinId);
                    enabledMovies.add(jellyfinId);
                    if (key) { enabledPendingTmdb.delete(key); tmdbToJellyfin.set(key, jellyfinId); }
                }
                notifyPolicyChanged();
                return response;
            });
    };

    internal.disableForTmdb = function(mediaType, tmdbId) {
        const requestEpoch = JE.session ? JE.session.getEpoch() : 0;
        const type = String(mediaType || '').toLowerCase();
        const id = String(tmdbId || '').trim();
        if (!id || (type !== 'tv' && type !== 'movie')) return Promise.reject(new Error('invalid mediaType/tmdbId'));
        return request(`/spoiler-blur/pending/${type}/${encodeURIComponent(id)}`, { method: 'DELETE', skipRetry: true })
            .then(function(response) {
                if (JE.session && !JE.session.isCurrent(requestEpoch)) return response;
                localEdits++;
                const key = internal.pendingKey(type, id);
                if (key) { enabledPendingTmdb.delete(key); tmdbToJellyfin.delete(key); }
                if (response?.removedFrom === 'series' && response.jellyfinId) {
                    enabledSeries.delete(internal.normalizeId(response.jellyfinId));
                } else if (response?.removedFrom === 'movie' && response.jellyfinId) {
                    enabledMovies.delete(internal.normalizeId(response.jellyfinId));
                }
                notifyPolicyChanged();
                return response;
            });
    };

    internal.getUserPrefs = function() { return Object.assign({}, userPrefs); };
    // The library series and movies the person guards (Jellyfin ids, N form): copies, read-only. Lists (phase 4c3a)
    // map them to TMDB ids to guard entries of the same titles that aren't in the library.
    internal.guardedIds = function() { return { series: Array.from(enabledSeries), movies: Array.from(enabledMovies) }; };
    internal.setUserPrefs = function(next) {
        const requestEpoch = JE.session ? JE.session.getEpoch() : 0;
        const payload = next || {};
        return request('/spoiler-blur/user-prefs', { method: 'POST', body: payload, skipRetry: true })
            .then(function(response) {
                if (JE.session && !JE.session.isCurrent(requestEpoch)) return response;
                localEdits++;
                userPrefs = Object.assign({}, payload);
                notifyPolicyChanged();
                return response?.prefs || userPrefs;
            })
            .catch(function(err) {
                console.error(`${logPrefix} setUserPrefs failed:`, err);
                throw err;
            });
    };

    // Spoiler Guard state (enabled series/movies/collections, prefs) is
    // per-user and memoized for the whole SPA session via statePromise.
    // Drop it on a user switch so the next whenLoaded() fetches the new
    // user's state instead of serving the previous user's.
    JE.session?.onUserChange('spoilerguard-state', () => {
        statePromise = null;
        loaded = false;
        loadOk = false;
        loadedRevision = null;
        stale = false;
        enabledSeries.clear();
        enabledMovies.clear();
        enabledCollections.clear();
        enabledPendingTmdb.clear();
        tmdbToJellyfin.clear();
        userPrefs = {};
    });
})(window.JellyfinEnhanced);
