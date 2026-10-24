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
    // The override saves not answered yet, in order (each a { Set } of preferences), and the preferences' one queue, bound to
    // the signed-in session (core/mutation-queue.js): saves go out one at a time (a change made back while one is out
    // reaches the server after it), the session is checked right before each is sent, and an account switch cancels the
    // previous person's saves unsent. Its revision moves on with every save queued or answered (and the switch), so a state
    // read that began before one doesn't take its Prefs.
    let pendingPrefs = [];
    // The preferences' one session-bound write queue (core/mutation-queue.js): a read began before a save queued or answered
    // since doesn't take its Prefs.
    const prefsQueue = JE.core.mutationQueue('spoiler-prefs');
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
    // Core user-change caches (play edge join): the document revision the state was read under, and whether a newer one was seen.
    let loadedRevision = null;
    let stale = false;

    /** @returns {string|null} The document revision known now. */
    function knownRevision() {
        return JE.core?.revision?.document?.('spoiler-guard') ?? null;
    }

    /** Tell current detail-page consumers to discard topic content after a policy change. */
    function notifyPolicyChanged() {
        window.dispatchEvent(new Event('je:spoiler-changed'));
    }

    function request(path, options) {
        return JE.core.api.plugin(path, options);
    }

    /**
     * Whether a value is an action's origin (JE.core.userWrite.origin()) rather than an owner (a token, a captured action,
     * a node or an event): a caller of the origin-only shape passes it in the owner's place.
     */
    const isOriginArg = value => !!value && typeof value === 'object' && 'epoch' in value && 'userId' in value
        && typeof value.current !== 'function' && !(typeof Node !== 'undefined' && value instanceof Node) && !JE.isOwnerToken?.(value);

    /** An unshared full-state read; a unique signal prevents joining a read submitted before a write. */
    function readState() {
        return request('/spoiler-blur/series', { skipCache: true, signal: new AbortController().signal });
    }

    let mutationQueue = Promise.resolve();
    let generation = 0;

    /**
     * The preferences a state read brought: taken only when no preference save was queued or answered since the read began
     * (`readRevision`: the queue's revision then), else the page keeps the newer ones it has (read again after the save).
     */
    function stateRead(value, readRevision) {
        if (readRevision === prefsQueue.revision && !prefsQueue.pending && !pendingPrefs.length) userPrefs = value.Prefs || {};
    }

    /** Replaces every mirror from the same complete server document; removed copies and mappings disappear. */
    function adoptState(data, readRevision) {
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
        stateRead(value, readRevision);
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

    /** What a write that was never sent resolves with (its owner ended first): it changed nothing, so nothing follows. */
    const UNSENT = internal.UNSENT = Object.freeze({ unsent: true });

    /**
     * All controls share one ordered write, authoritative read and policy notification path. `owner` (required,
     * D46S2-R6): the owner token the control was pressed for (a title action's operation, or the viewer's own gesture;
     * it must still be current right before the write), or the node or press it comes from. Three outcomes (D46S2 audit
     * S3): never sent (its owner ended first) resolves UNSENT and changes nothing; sent and answered, also after its
     * owner ended (accepted), reconciles this session's state from the server (a reread and the policy event) and
     * resolves with the answer; a failure rejects. Page effects are the caller's, only while its owner is current.
     */
    function mutateState(path, options, project, owner, transmit, origin) {
        // The action's origin (JE.core.userWrite): taken when the person acted, carried to the send (checked right there).
        origin = JE.core.userWrite.originOf(origin);
        const action = JE.createSessionAction();
        const submitted = JE.createSessionAction({ owner });
        const task = mutationQueue.catch(() => {}).then(async () => {
            // Sent only while its owner may write (an operation: while current; the viewer's own gesture: its session).
            const bound = submitted.bound();
            if (!action.current() || bound.current() !== true) return UNSENT;
            // The transport checks the owner again right before the bytes go out (after the core queue).
            let response;
            // A document with its own session queue (the preferences) sends through it (transmit).
            try { response = await (transmit ? transmit(bound) : request(path, { ...options, bound, session: origin })); }
            catch (err) {
                const { outcome, answer, sessionChanged } = JE.core.api.writeOutcome?.(err) || { outcome: 'failed' };
                if (outcome === 'unsent') return UNSENT;
                if (outcome !== 'accepted') throw err;
                // Accepted after its owner ended: still this session's change, reconciled below (another session's is not ours).
                if (sessionChanged) return answer;
                response = answer;
            }
            if (!action.current()) return response;
            generation++;
            JE.core.api.manager?.invalidatePresentation?.();
            try {
                const readRevision = prefsQueue.revision;
                const value = await readState();
                if (!action.current()) return response;
                adoptState(value, readRevision);
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
                    notifyPolicyChanged();
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
        // Taken before the read (core user-change caches): the state as read is at least this new.
        const revision = knownRevision();
        const readRevision = prefsQueue.revision;
        const prefetchedState = JE.takePrefetched?.('SpoilerBlurSeries');
        statePromise = (prefetchedState ? Promise.resolve(prefetchedState) : readState())
            .then(function(data) {
                if (!action.current() || requestGeneration !== generation) return;
                adoptState(data, readRevision);
                // A revision that moved while this read ran may or may not be in it: read again on the next use.
                const now = knownRevision();
                loadedRevision = now === revision ? revision : null;
                if (now !== revision) stale = true;
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
        // A state kept under an older document revision (another tab or device saved it) is read again.
        if (statePromise && !stale) return statePromise;
        // A settled failure answers fail-closed until its window passes; the next demand retries.
        if (loaded && !loadOk && Date.now() - failedAt < RETRY_AFTER_MS) return Promise.resolve();
        stale = false;
        return startLoad();
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
        if (loaded && loadOk) {
            // Kept under an older revision: read again (the state shown answers until it is in).
            if (stale) internal.loadState();
            return Promise.resolve();
        }
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

    internal.enableForSeries = function(id, owner, origin) {
        // The toggle's origin (taken at the click, carried through a confirmation): the write and its answer belong to it.
        origin = JE.core.userWrite.originOf(origin);
        const key = internal.normalizeId(id);
        return mutateState(`/spoiler-blur/series/${encodeURIComponent(key)}`, { method: 'POST', skipRetry: true }, () => applyConfirmed('series', key, enabledSeries, true), owner, undefined, origin);
    };
    internal.disableForSeries = function(id, owner, origin) {
        // The toggle's origin (taken at the click, carried through a confirmation): the write and its answer belong to it.
        origin = JE.core.userWrite.originOf(origin);
        const key = internal.normalizeId(id);
        return mutateState(`/spoiler-blur/series/${encodeURIComponent(key)}`, { method: 'DELETE', skipRetry: true }, () => applyConfirmed('series', key, enabledSeries, false), owner, undefined, origin);
    };
    internal.enableForMovie = function(id, name, owner, origin) {
        // The toggle's origin (taken at the click, carried through a confirmation): the write and its answer belong to it.
        origin = JE.core.userWrite.originOf(origin);
        const key = internal.normalizeId(id);
        return mutateState(`/spoiler-blur/movies/${encodeURIComponent(key)}`, { method: 'POST', body: { MovieName: name || '' }, skipRetry: true }, () => applyConfirmed('movie', key, enabledMovies, true), owner, undefined, origin);
    };
    internal.disableForMovie = function(id, owner, origin) {
        // The toggle's origin (taken at the click, carried through a confirmation): the write and its answer belong to it.
        origin = JE.core.userWrite.originOf(origin);
        const key = internal.normalizeId(id);
        return mutateState(`/spoiler-blur/movies/${encodeURIComponent(key)}`, { method: 'DELETE', skipRetry: true }, () => applyConfirmed('movie', key, enabledMovies, false), owner, undefined, origin);
    };
    internal.enableForCollection = function(id, name, owner, origin) {
        // The toggle's origin (taken at the click, carried through a confirmation): the write and its answer belong to it.
        origin = JE.core.userWrite.originOf(origin);
        const key = internal.normalizeId(id);
        return mutateState(`/spoiler-blur/collections/${encodeURIComponent(key)}`, { method: 'POST', body: { CollectionName: name || '' }, skipRetry: true }, () => applyConfirmed('collection', key, enabledCollections, true), owner, undefined, origin);
    };
    internal.disableForCollection = function(id, owner, origin) {
        // The toggle's origin (taken at the click, carried through a confirmation): the write and its answer belong to it.
        origin = JE.core.userWrite.originOf(origin);
        const key = internal.normalizeId(id);
        return mutateState(`/spoiler-blur/collections/${encodeURIComponent(key)}`, { method: 'DELETE', skipRetry: true }, () => applyConfirmed('collection', key, enabledCollections, false), owner, undefined, origin);
    };

    /** True when the mirrors can answer for this title: a loaded state, or an accepted write since. */
    internal.isKnownForKind = function(kind, id) {
        // The toggle's origin (taken at the click, carried through a confirmation): the write and its answer belong to it.
        origin = JE.core.userWrite.originOf(origin);
        return loadOk || confirmed.has(`${kind === 'movie' || kind === 'collection' ? kind : 'series'}:${internal.normalizeId(id)}`);
    };
    internal.isTmdbKnown = function(mediaType, tmdbId) {
        // The toggle's origin (taken at the click, carried through a confirmation): the write and its answer belong to it.
        origin = JE.core.userWrite.originOf(origin);
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

    internal.enableForTmdb = function(mediaType, tmdbId, displayName, owner, origin) {
        // The toggle's origin (taken at the click, carried through a confirmation): the write and its answer belong to it.
        origin = JE.core.userWrite.originOf(origin);
        const type = String(mediaType || '').toLowerCase();
        const id = String(tmdbId || '').trim();
        if (!id || (type !== 'tv' && type !== 'movie')) return Promise.reject(new Error('invalid mediaType/tmdbId'));
        const query = displayName ? `?displayName=${encodeURIComponent(displayName)}` : '';
        return mutateState(`/spoiler-blur/pending/${type}/${encodeURIComponent(id)}${query}`, { method: 'POST', skipRetry: true }, () => applyConfirmed('tmdb', internal.pendingKey(type, id), enabledPendingTmdb, true), owner, undefined, origin);
    };
    internal.disableForTmdb = function(mediaType, tmdbId, owner, origin) {
        // The toggle's origin (taken at the click, carried through a confirmation): the write and its answer belong to it.
        origin = JE.core.userWrite.originOf(origin);
        const type = String(mediaType || '').toLowerCase();
        const id = String(tmdbId || '').trim();
        if (!id || (type !== 'tv' && type !== 'movie')) return Promise.reject(new Error('invalid mediaType/tmdbId'));
        return mutateState(`/spoiler-blur/pending/${type}/${encodeURIComponent(id)}`, { method: 'DELETE', skipRetry: true }, () => applyConfirmed('tmdb', internal.pendingKey(type, id), enabledPendingTmdb, false), owner, undefined, origin);
    };

    internal.getUserPrefs = function() { return Object.assign({}, userPrefs); };
    // The library series and movies the person guards (Jellyfin ids, N form): copies, read-only. Lists (phase 4c3a)
    // map them to TMDB ids to guard entries of the same titles that aren't in the library.
    internal.guardedIds = function() { return { series: Array.from(enabledSeries), movies: Array.from(enabledMovies) }; };
    /** The preferences as the server will hold them once the override saves still out are answered. */
    function expectedPrefs() {
        return Object.assign({}, userPrefs, ...pendingPrefs);
    }

    // Play edge: the rebuild's PATCH (only the preferences that differ from what the server will hold once the saves still
    // out are answered; the server applies them to what it holds then, so a preference changed back while its save is out
    // is sent too) sent through D46's owner-bound mutateState, on the preferences' queue with the change's origin.
    internal.setUserPrefs = function(next, owner, origin) {
        if (origin === undefined && isOriginArg(owner)) { origin = owner; owner = undefined; }
        // The session this change was made in (its origin: taken by the control when the person acted, before any wait):
        // the save goes out, and its answer counts, only while it is the signed-in one (JE.core.userWrite).
        const binding = JE.core.userWrite.originOf(origin);
        const expected = expectedPrefs();
        const set = {};
        for (const [key, value] of Object.entries(next || {})) {
            if (JSON.stringify(value) !== JSON.stringify(expected[key])) set[key] = value;
        }
        if (!Object.keys(set).length) return Promise.resolve(Object.assign({}, userPrefs));
        pendingPrefs.push(set);
        const queue = pendingPrefs;
        const settled = () => { const i = queue.indexOf(set); if (i !== -1) queue.splice(i, 1); };
        // The person this change is made for: an answer that comes after another person signed in is not theirs to show.
        const madeIn = JE.createSessionAction();
        // The server's answer is the preferences it holds now (else this change applied to the ones known).
        function acknowledged(response) {
            settled();
            if (!madeIn.current() || !JE.core.userWrite.isBound(binding)) return;
            userPrefs = response?.prefs && typeof response.prefs === 'object' ? Object.assign({}, response.prefs) : Object.assign({}, userPrefs, set);
        }
        // Sent on the preferences' session queue with the change's origin (never once the person changed), with its
        // owner's binding (both checked again as the bytes go out).
        return mutateState('/spoiler-blur/user-prefs', { method: 'PATCH', body: { Set: set }, skipRetry: true }, acknowledged, owner,
            bound => prefsQueue.send(queued => request('/spoiler-blur/user-prefs', { method: 'PATCH', body: { Set: set }, skipRetry: true, bound, session: queued }), binding)
                .then(response => { acknowledged(response); return response; }), binding)
            .then(result => {
                settled();
                // Never sent (its owner ended first): the caller is told, as for a failed save (the panel puts its box back).
                if (result === UNSENT) throw Object.assign(new Error('Spoiler Guard preferences not sent'), { notSent: true });
                return internal.getUserPrefs();
            }, err => {
                settled();
                // A save the previous person queued, cancelled by the account switch: the page already said it wasn't saved
                // (JE.core.userWrite.notSent).
                if (!err?.sessionChanged) console.error(`${logPrefix} setUserPrefs failed:`, err);
                throw err;
            });
    };

    /**
     * After a preference save whose outcome is uncertain (its answer was lost): ONE read of the person's state says what is
     * stored now. Only for the save's own session (an account change cancels it: nothing is read as the next person), and
     * taken only while no other preference save is out; the save itself is never sent again.
     * @param {any} origin The save's origin.
     * @returns {Promise<object|null>} The stored preferences, or null when they couldn't be read for that session.
     */
    internal.reconcilePrefs = async function(origin) {
        if (!JE.core.userWrite.isBound(origin)) return null;
        const readRevision = prefsQueue.revision;
        let value;
        try { value = await request('/spoiler-blur/series', { skipCache: true }); } catch (_) { return null; }
        if (!JE.core.userWrite.isBound(origin)) return null;
        if (readRevision === prefsQueue.revision && !prefsQueue.pending && !pendingPrefs.length) {
            userPrefs = Object.assign({}, value?.Prefs || {});
            notifyPolicyChanged();
        }
        return Object.assign({}, userPrefs);
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
        loadedRevision = null;
        stale = false;
        enabledSeries.clear();
        enabledMovies.clear();
        enabledCollections.clear();
        enabledPendingTmdb.clear();
        userPrefs = {};
        // The previous person's saves are not this person's (their owners ended with the session: never sent).
        pendingPrefs = [];
        // The outgoing viewer's native toggles show their state; the next page view draws the incoming one.
        document.querySelectorAll('.je-spoiler-blur-btn').forEach(button => button.remove());
        refreshControls();
    });
})(window.JellyfinEnhanced);
