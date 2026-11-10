import { normalizeId, pendingKey } from './ids-logic';
import type { Prefs } from './host';
import type { RequestOptions } from '../../core/api/types';
import { decodeState, decodeMutation, decodePrefs, record } from './wire';
import { own } from './ownership';
import { spoilerHost } from './host';
const { JE, internal, ctx } = spoilerHost();
const owner = own(JE, 'state', false);
    const logPrefix = '🪼 Jellyfin Enhanced [SpoilerGuard]:';

    const enabledSeries = new Set<string>();
    const enabledMovies = new Set<string>();
    const enabledCollections = new Set<string>();
    const enabledPendingTmdb = new Set<string>();
    // A pending enable can be promoted immediately. Keep the returned Jellyfin
    // id so a Seerr payload without jellyfinMediaId still renders the live state.
    const tmdbToJellyfin = new Map<string, string>();

    let userPrefs: Prefs = {};
    let loaded = false;
    let loadOk = false;
    let statePromise: Promise<void> | null = null;

    function invalidateGuardedResponses() {
        const manager = JE.core.api.manager;
        ['jellyseerr', 'tmdb', 'mdblist-ratings'].forEach(pattern => manager?.clearCacheMatching?.(pattern));
        window.dispatchEvent(new CustomEvent('je:spoiler-state-changed'));
    }

    function request(path: string, options?: RequestOptions) {
        const token = owner.lease();
        token.check();
        const response = JE.core.api.plugin(path, { ...options, signal: token.signal });
        if (!options?.method || options.method === 'GET') return response;
        return response.then(function(result) {
            if (token.current()) invalidateGuardedResponses();
            return result;
        });
    }

    internal.loadState = function() {
        if (statePromise) return statePromise;
        // A response resolving after a user switch must not populate the
        // (already reset) state with the previous user's data.
        const requestToken = owner.lease();
        // The page-load bootstrap carries this user's state (same body as the
        // endpoint); it is handed out once, so later loads ask the server.
        const prefetchedState = JE.takePrefetched?.('SpoilerBlurSeries');
        statePromise = (prefetchedState ? Promise.resolve(prefetchedState) : request('/spoiler-blur/series'))
            .then(function(data) {
                if (!requestToken.current()) return;
                const value = decodeState(data);
                enabledSeries.clear();
                enabledMovies.clear();
                enabledCollections.clear();
                enabledPendingTmdb.clear();
                tmdbToJellyfin.clear();
                Object.keys(value.Series || {}).forEach(key => enabledSeries.add(normalizeId(key)));
                Object.keys(value.Movies || {}).forEach(key => enabledMovies.add(normalizeId(key)));
                Object.keys(value.Collections || {}).forEach(key => enabledCollections.add(normalizeId(key)));
                Object.keys(value.PendingTmdb || {}).forEach(key => enabledPendingTmdb.add(String(key).toLowerCase()));
                userPrefs = value.Prefs || {};
                loaded = true;
                loadOk = true;
                // If tag renderers already ran fail-closed while this request was
                // in flight, give them one authoritative pass now.
                try {
                    ctx.peer('tagPipeline')?.clearProcessed?.();
                    ctx.peer('tagPipeline')?.scheduleScan?.();
                } catch (e) {
                    console.warn(`${logPrefix} post-load tag rescan failed:`, e);
                }
            })
            .catch(function(err) {
                if (!requestToken.current()) return;
                console.error(`${logPrefix} state load failed; downstream consumers will fail closed:`, err);
                loaded = true;
                loadOk = false;
                // Tag renderers held back on cards while this was in flight
                // (e.g. user-review chips, see ratingtags.js): with the state
                // settled — failed, so ratings stay suppressed — give them
                // their final pass too.
                try {
                    ctx.peer('tagPipeline')?.clearProcessed?.();
                    ctx.peer('tagPipeline')?.scheduleScan?.();
                } catch (e) {
                    console.warn(`${logPrefix} post-failure tag rescan failed:`, e);
                }
            });
        return statePromise;
    };

    internal.whenLoaded = function() {
        if (JE.pluginConfig?.SpoilerBlurEnabled !== true) return Promise.resolve();
        if (loaded) return Promise.resolve();
        return statePromise || internal.loadState();
    };

    internal.isStateLoaded = function() { return loaded; };
    internal.isLoadOk = function() { return loadOk; };
    // True once the initial state request has settled (successfully or not).
    internal.isLoaded = function() { return loaded; };
    internal.isEnabledFor = function(id) { return enabledSeries.has(normalizeId(id)); };
    internal.isMovieEnabledFor = function(id) { return enabledMovies.has(normalizeId(id)); };
    internal.isCollectionEnabledFor = function(id) { return enabledCollections.has(normalizeId(id)); };

    internal.isMovieInScope = async function(id) {
        const scopeToken = owner.lease();
        await internal.whenLoaded();
        scopeToken.check();
        if (!internal.isLoadOk()) throw new Error('Spoiler Guard state unavailable');
        if (internal.isMovieEnabledFor(id)) return true;
        if (enabledCollections.size === 0) return false;
        const token = owner.lease();
        const result = await request(`/spoiler-blur/movies/${encodeURIComponent(normalizeId(id))}/in-scope`);
        token.check();
        const value = record(result);
        if (typeof value.inScope !== 'boolean') throw new Error('Invalid scope verdict');
        return value.inScope;
    };
    internal.hasAnyState = function() {
        return enabledSeries.size > 0 || enabledMovies.size > 0 || enabledCollections.size > 0 || enabledPendingTmdb.size > 0;
    };

    internal.isEnabledForKind = function(kind, id) {
        if (kind === 'movie') return internal.isMovieEnabledFor(id);
        if (kind === 'collection') return internal.isCollectionEnabledFor(id);
        return internal.isEnabledFor(id);
    };

    internal.enableForSeries = function(id) {
        const requestToken = owner.lease();
        const normalized = normalizeId(id);
        return request(`/spoiler-blur/series/${encodeURIComponent(normalized)}`, { method: 'POST', skipRetry: true })
            .then(function() {
                if (!requestToken.current()) return;
                enabledSeries.add(normalized);
            });
    };

    internal.disableForSeries = function(id) {
        const requestToken = owner.lease();
        const normalized = normalizeId(id);
        return request(`/spoiler-blur/series/${encodeURIComponent(normalized)}`, { method: 'DELETE', skipRetry: true })
            .then(function() {
                if (!requestToken.current()) return;
                enabledSeries.delete(normalized);
            });
    };

    internal.enableForMovie = function(id, name) {
        const requestToken = owner.lease();
        const normalized = normalizeId(id);
        return request(`/spoiler-blur/movies/${encodeURIComponent(normalized)}`, {
            method: 'POST', body: { MovieName: name || '' }, skipRetry: true
        }).then(function() {
                if (!requestToken.current()) return;
                enabledMovies.add(normalized);
            });
    };

    internal.disableForMovie = function(id) {
        const requestToken = owner.lease();
        const normalized = normalizeId(id);
        return request(`/spoiler-blur/movies/${encodeURIComponent(normalized)}`, { method: 'DELETE', skipRetry: true })
            .then(function() {
                if (!requestToken.current()) return;
                enabledMovies.delete(normalized);
            });
    };

    internal.enableForCollection = function(id, name) {
        const requestToken = owner.lease();
        const normalized = normalizeId(id);
        return request(`/spoiler-blur/collections/${encodeURIComponent(normalized)}`, {
            method: 'POST', body: { CollectionName: name || '' }, skipRetry: true
        }).then(function() {
                if (!requestToken.current()) return;
                enabledCollections.add(normalized);
            });
    };

    internal.disableForCollection = function(id) {
        const requestToken = owner.lease();
        const normalized = normalizeId(id);
        return request(`/spoiler-blur/collections/${encodeURIComponent(normalized)}`, { method: 'DELETE', skipRetry: true })
            .then(function() {
                if (!requestToken.current()) return;
                enabledCollections.delete(normalized);
            });
    };

    internal.isTmdbPending = function(mediaType, tmdbId) {
        const key = pendingKey(mediaType, tmdbId);
        return !!key && enabledPendingTmdb.has(key);
    };

    internal.isTmdbEnabled = function(mediaType, tmdbId, jellyfinMediaId) {
        const key = pendingKey(mediaType, tmdbId);
        if (key && enabledPendingTmdb.has(key)) return true;
        const jellyfinId = jellyfinMediaId || (key ? tmdbToJellyfin.get(key) : null);
        if (!jellyfinId) return false;
        if (mediaType === 'movie') return internal.isMovieEnabledFor(jellyfinId);
        if (mediaType === 'tv') return internal.isEnabledFor(jellyfinId);
        return false;
    };

    internal.enableForTmdb = function(mediaType, tmdbId, displayName) {
        const requestToken = owner.lease();
        const type = String(mediaType || '').toLowerCase();
        const id = String(tmdbId || '').trim();
        if (!id || (type !== 'tv' && type !== 'movie')) return Promise.reject(new Error('invalid mediaType/tmdbId'));
        const query = displayName ? `?displayName=${encodeURIComponent(displayName)}` : '';
        return request(`/spoiler-blur/pending/${type}/${encodeURIComponent(id)}${query}`, { method: 'POST', skipRetry: true })
            .then(function(raw) {
                const response = decodeMutation(raw);
                if (!requestToken.current()) return response;
                const key = pendingKey(type, id);
                if (response?.promoted === 'pending') {
                    if (key) enabledPendingTmdb.add(key);
                } else if (response?.promoted === 'series' && response.jellyfinId) {
                    const jellyfinId = normalizeId(response.jellyfinId);
                    enabledSeries.add(jellyfinId);
                    if (key) { enabledPendingTmdb.delete(key); tmdbToJellyfin.set(key, jellyfinId); }
                    } else if (response?.promoted === 'movie' && response.jellyfinId) {
                    const jellyfinId = normalizeId(response.jellyfinId);
                    enabledMovies.add(jellyfinId);
                    if (key) { enabledPendingTmdb.delete(key); tmdbToJellyfin.set(key, jellyfinId); }
                    }
                return response;
            });
    };

    internal.disableForTmdb = function(mediaType, tmdbId) {
        const requestToken = owner.lease();
        const type = String(mediaType || '').toLowerCase();
        const id = String(tmdbId || '').trim();
        if (!id || (type !== 'tv' && type !== 'movie')) return Promise.reject(new Error('invalid mediaType/tmdbId'));
        return request(`/spoiler-blur/pending/${type}/${encodeURIComponent(id)}`, { method: 'DELETE', skipRetry: true })
            .then(function(raw) {
                const response = decodeMutation(raw);
                if (!requestToken.current()) return response;
                const key = pendingKey(type, id);
                if (key) { enabledPendingTmdb.delete(key); tmdbToJellyfin.delete(key); }
                if (response?.removedFrom === 'series' && response.jellyfinId) {
                    enabledSeries.delete(normalizeId(response.jellyfinId));
                    } else if (response?.removedFrom === 'movie' && response.jellyfinId) {
                    enabledMovies.delete(normalizeId(response.jellyfinId));
                    }
                return response;
            });
    };

    internal.getUserPrefs = function() { return Object.assign({}, userPrefs); };
    internal.setUserPrefs = function(next) {
        const requestToken = owner.lease();
        const payload = decodePrefs(next || {});
        return request('/spoiler-blur/user-prefs', { method: 'POST', body: payload, skipRetry: true })
            .then(function(raw) {
                const response = decodeMutation(raw);
                if (!requestToken.current()) return {};
                userPrefs = Object.assign({}, response.prefs || payload);
                return response?.prefs || userPrefs;
            })
            .catch(function(err) {
                if (requestToken.current()) console.error(`${logPrefix} setUserPrefs failed:`, err);
                throw err;
            });
    };

    // Spoiler Guard state (enabled series/movies/collections, prefs) is
    // per-user and memoized for the whole SPA session via statePromise.
    // Drop it on a user switch so the next whenLoaded() fetches the new
    // user's state instead of serving the previous user's.
    function resetState() {
        statePromise = null;
        loaded = false;
        loadOk = false;
        enabledSeries.clear();
        enabledMovies.clear();
        enabledCollections.clear();
        enabledPendingTmdb.clear();
        tmdbToJellyfin.clear();
        userPrefs = {};
    }
    JE.session?.onUserChange('spoilerguard-state', resetState);
    JE.core?.lifecycle?.register('spoiler-guard-state').onTeardown(resetState);
