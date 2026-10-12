// @ts-check
// /js/arr/live/arr-live.js
//
// Live status updates for "Requests & downloads (new)" (phase 1).
//
// Pages that show download status subscribe to the titles they show:
//
//     const off = JE.arr.onStatusChange(['movie:tmdb:45745'], (keys, info) => refresh(keys), { element: pill });
//
// and get called (with the subset of their keys that changed) whenever Sonarr/Radarr or
// Jellyfin's library change something about those titles. `info.reset` means "the server could
// not say exactly what changed (restart, long sleep): re-read everything you show".
//
// One long-poll per tab against /JellyfinEnhanced/acquire/changes (never the arrs), only while
// something is subscribed and the tab is visible; it carries the union of all subscribed keys (or,
// past 500 of them, none: the server then answers for every title the user may see).
// Errors back off (2 s → 60 s); a switched-off feature or a signed-out user stops polling for
// five minutes or until the next navigation or sign-in. Nothing is requested while the module
// loads: the first poll waits for a subscriber (and at least 300 ms).
//
// Title keys: movie:tmdb:<id> | tv:tvdb:<id>[:s<n>[:e<n>]] (see JE.arr.titleKey). A change to
// an episode also reaches subscribers of its season and series.
//
// Public surface: JE.arr.onStatusChange(keys, cb, opts) → unsubscribe, JE.arr.titleKey(parts),
// JE.arr.live { state(), seed(epoch, cursor), position(), prime(), pollNow() } and a 'je:arr-status-change'
// CustomEvent on document ({ keys, reset }).
(function(JE) {
    'use strict';

    JE.arr = JE.arr || {};

    const ROUTE = '/JellyfinEnhanced/acquire/changes';
    const WAIT_SECONDS = 25;
    const MAX_KEYS = 500;
    const FIRST_POLL_DELAY_MS = 300;
    const RESUBSCRIBE_DELAY_MS = 100;
    const BACKOFF_MIN_MS = 2000;
    const BACKOFF_MAX_MS = 60000;
    const DISABLED_RETRY_MS = 5 * 60 * 1000;
    const REQUEST_TIMEOUT_MS = (WAIT_SECONDS + 15) * 1000;
    // Title keys, plus a user's own request-list key (req:u:<user id>; only that user hears about it)
    // and the shared request-list state key (req:state: Seerr first read, failure, recovery).
    const KEY_SHAPE = /^(movie:tmdb:[1-9][0-9]{0,8}|tv:tvdb:[1-9][0-9]{0,8}(:s(0|[1-9][0-9]{0,3})(:e(0|[1-9][0-9]{0,4}))?)?|req:u:[0-9a-f]{32}|req:state)$/;

    /**
     * @typedef {Object} Subscription
     * @property {Set<string>} keys
     * @property {(keys: string[], info: {reset: boolean}) => void} cb
     * @property {Element|null} element
     * @property {boolean} unseeded - Made without a known feed position: called once with a reset
     *   when the tab has one, since changes before it can't be told apart.
     */

    /** @type {Map<number, Subscription>} */
    const subscriptions = new Map();
    let nextId = 1;

    /** @type {string|null} */
    let epoch = null;
    /** @type {number|null} */
    let cursor = null;
    /** @type {AbortController|null} */
    let inflight = null;
    /** @type {*} */
    let timer = null;
    let failures = 0;
    /** 'idle' | 'waiting' | 'polling' | 'backoff' | 'stopped' */
    let status = 'idle';
    let stoppedUntil = 0;
    let identityEpoch = JE.session && typeof JE.session.getEpoch === 'function' ? JE.session.getEpoch() : 0;
    const loadedAt = Date.now();

    /**
     * Builds a title key.
     * @param {{type: 'movie'|'tv'|'series', tmdbId?: number|string, tvdbId?: number|string, season?: number|null, episode?: number|null}} parts
     * @returns {string|null} The key, or null when the ids are missing or invalid.
     */
    function titleKey(parts) {
        if (!parts) return null;
        let key = null;
        if (parts.type === 'movie') {
            key = parts.tmdbId ? 'movie:tmdb:' + String(parts.tmdbId) : null;
        } else if (parts.type === 'tv' || parts.type === 'series') {
            if (!parts.tvdbId) return null;
            key = 'tv:tvdb:' + String(parts.tvdbId);
            if (parts.season !== undefined && parts.season !== null) {
                key += ':s' + String(parts.season);
                if (parts.episode !== undefined && parts.episode !== null) key += ':e' + String(parts.episode);
            }
        }
        return key && KEY_SHAPE.test(key) ? key : null;
    }

    /**
     * Subscribes to status changes of some titles.
     * @param {string[]|string} keys - Title keys (invalid ones are ignored).
     * @param {(keys: string[], info: {reset: boolean}) => void} cb - Called with the changed keys of this subscription.
     * @param {{element?: Element|null, since?: {epoch: string, cursor: number}|null}} [opts] - `element`: drop the
     *   subscription once this element is no longer in the document. `since`: a feed position the caller's data was
     *   read at (changes after it are delivered even if they happened before subscribing); `null` means the data was
     *   read without one. A subscription with `since: null`, or without `since` while the tab has no position yet, is
     *   called once with `{reset: true}` as soon as the tab has a position (a change in between can't be ruled out).
     * @returns {() => void} Unsubscribe.
     */
    function onStatusChange(keys, cb, opts) {
        const list = (Array.isArray(keys) ? keys : [keys]).filter(k => typeof k === 'string' && KEY_SHAPE.test(k));
        if (typeof cb !== 'function' || list.length === 0) return () => {};
        const id = nextId++;
        const added = list.some(k => !isSubscribed(k));
        const since = opts ? opts.since : undefined;
        const unseeded = since === null || (!since && position() === null);
        subscriptions.set(id, { keys: new Set(list), cb, element: (opts && opts.element) || null, unseeded });
        if (since) seed(since.epoch, since.cursor);
        if (unseeded && position()) settleUnseededSoon();
        if (added || !inflight) restartSoon(RESUBSCRIBE_DELAY_MS);
        return () => {
            if (!subscriptions.delete(id)) return;
            if (subscriptions.size === 0) stop('idle');
        };
    }

    /**
     * Moves the feed position back to where a caller's data was read (never forward), so nothing in
     * between is missed. A different epoch is ignored unless the module has none yet.
     * @param {string} seedEpoch
     * @param {number} seedCursor
     */
    function seed(seedEpoch, seedCursor) {
        if (typeof seedEpoch !== 'string' || typeof seedCursor !== 'number' || seedCursor < 0) return;
        if (epoch === null || epoch === seedEpoch) {
            if (epoch === null || cursor === null || seedCursor < cursor) {
                epoch = seedEpoch;
                cursor = seedCursor;
                settleUnseededSoon();
                restartSoon(RESUBSCRIBE_DELAY_MS);
            }
        }
    }

    let unseededQueued = false;

    /** Calls the unseeded subscriptions back (after the current task), once the tab has a position. */
    function settleUnseededSoon() {
        if (unseededQueued) return;
        unseededQueued = true;
        Promise.resolve().then(() => {
            unseededQueued = false;
            settleUnseeded();
        });
    }

    /**
     * Subscriptions made without a known position get one reset each (their caller re-reads, now
     * from a known position), so a change between their read and the tab's first position is not lost.
     */
    function settleUnseeded() {
        if (!position()) return;
        pruneDetached();
        const due = Array.from(subscriptions.values()).filter(sub => sub.unseeded);
        for (const sub of due) sub.unseeded = false;
        for (const sub of due) {
            try {
                sub.cb(Array.from(sub.keys), { reset: true });
            } catch (err) {
                console.warn('🪼 Jellyfin Enhanced: Arr live: a status subscriber failed:', err);
            }
        }
    }

    /**
     * @param {string} key
     * @returns {boolean}
     */
    function isSubscribed(key) {
        for (const sub of subscriptions.values()) if (sub.keys.has(key)) return true;
        return false;
    }

    /**
     * The feed position this tab has reached, or null before the first answer.
     * @returns {{epoch: string, cursor: number}|null}
     */
    function position() {
        return epoch !== null && cursor !== null ? { epoch, cursor } : null;
    }

    /** @type {Promise<{epoch: string, cursor: number}|null>|null} */
    let priming = null;

    /**
     * Makes sure the tab has a feed position before a page reads statuses, so a surface that
     * subscribes after its read (with `since` = this position) hears about every change made after
     * the read. One small request per tab when there is no position yet; nothing when there is one.
     * @returns {Promise<{epoch: string, cursor: number}|null>} The position, or null when the feed can't be reached.
     */
    function prime() {
        const known = position();
        if (known) return Promise.resolve(known);
        if (priming) return priming;
        if (typeof ApiClient === 'undefined' || !ApiClient || Date.now() < stoppedUntil) return Promise.resolve(null);
        const myIdentity = identityEpoch;
        /** @type {Record<string, string>} */
        const headers = Object.assign({}, JE.core && JE.core.api && JE.core.api.authHeaders ? JE.core.api.authHeaders() : {}, { 'Content-Type': 'application/json' });
        priming = (async () => {
            try {
                const response = await fetch(ApiClient.getUrl(ROUTE), { method: 'POST', headers, body: '{}', cache: 'no-store' });
                if (!response.ok) return null;
                const body = await response.json();
                if (myIdentity !== identityEpoch || !body || typeof body.cursor !== 'number' || typeof body.epoch !== 'string') return null;
                if (epoch === null || cursor === null) { epoch = body.epoch; cursor = body.cursor; }
                settleUnseededSoon();
                return position();
            } catch (_) {
                return null;
            } finally {
                priming = null;
            }
        })();
        return priming;
    }

    /** @returns {string[]} The union of all subscribed keys. */
    function allKeys() {
        const all = new Set();
        for (const sub of subscriptions.values()) {
            for (const k of sub.keys) all.add(k);
        }
        return Array.from(all);
    }

    /**
     * The keys to ask the server about: all subscribed keys, or none (= every title the user may
     * see, filtered here) when there are more than one request may carry, so no key is ever dropped.
     * @returns {string[]}
     */
    function requestKeys() {
        const all = allKeys();
        return all.length > MAX_KEYS ? [] : all;
    }

    /** Drops subscriptions whose element left the document. */
    function pruneDetached() {
        for (const [id, sub] of subscriptions) {
            if (sub.element && !sub.element.isConnected) subscriptions.delete(id);
        }
    }

    /**
     * Delivers changed keys to the subscriptions that hold them.
     * @param {string[]} keys
     * @param {boolean} reset
     */
    function deliver(keys, reset) {
        pruneDetached();
        const changed = new Set(keys);
        for (const sub of Array.from(subscriptions.values())) {
            const mine = reset ? Array.from(sub.keys) : Array.from(sub.keys).filter(k => changed.has(k));
            if (mine.length === 0) continue;
            if (reset) sub.unseeded = false;
            try {
                sub.cb(mine, { reset });
            } catch (err) {
                console.warn('🪼 Jellyfin Enhanced: Arr live: a status subscriber failed:', err);
            }
        }
        try {
            document.dispatchEvent(new CustomEvent('je:arr-status-change', { detail: { keys: reset ? allKeys() : keys, reset } }));
        } catch (_) { /* no document */ }
        if (subscriptions.size === 0) stop('idle');
    }

    /** @returns {boolean} */
    function visible() {
        return typeof document === 'undefined' || document.visibilityState !== 'hidden';
    }

    /**
     * @param {string} next
     */
    function stop(next) {
        if (timer) { clearTimeout(timer); timer = null; }
        if (inflight) { const c = inflight; inflight = null; c.abort(); }
        status = next;
    }

    /**
     * Schedules a poll (replacing a pending one and aborting a running one, so a new key set is sent).
     * @param {number} delay
     */
    function restartSoon(delay) {
        if (Date.now() < stoppedUntil) {
            // Still stopped. When nothing waits for the stop to end (everyone had unsubscribed,
            // which cleared its timer), wait for it again, or let becoming visible do that.
            if (subscriptions.size && !timer) {
                if (visible()) armStopped(stoppedUntil - Date.now());
                else status = 'stopped';
            }
            return;
        }
        if (inflight) { const c = inflight; inflight = null; c.abort(); }
        schedule(delay);
    }

    /**
     * @param {number} delay
     */
    function schedule(delay) {
        if (timer) clearTimeout(timer);
        timer = null;
        if (subscriptions.size === 0 || !visible()) { status = subscriptions.size ? 'waiting' : 'idle'; return; }
        const sinceLoad = Date.now() - loadedAt;
        const wait = Math.max(delay, FIRST_POLL_DELAY_MS - sinceLoad, 0);
        status = 'waiting';
        timer = setTimeout(() => { timer = null; poll(); }, wait);
    }

    /** @returns {number} */
    function backoffDelay() {
        const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * Math.pow(2, Math.max(0, failures - 1)));
        return Math.round(base * (0.8 + Math.random() * 0.4));
    }

    /** One long-poll round trip. */
    async function poll() {
        if (inflight || subscriptions.size === 0 || !visible() || typeof ApiClient === 'undefined' || !ApiClient) return;
        if (typeof ApiClient.getCurrentUserId === 'function' && !ApiClient.getCurrentUserId()) { stop('stopped'); return; }
        pruneDetached();
        if (subscriptions.size === 0) { stop('idle'); return; }

        const controller = new AbortController();
        inflight = controller;
        status = 'polling';
        const myIdentity = identityEpoch;
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        const first = epoch === null || cursor === null;
        /** @type {Record<string, string>} */
        const headers = Object.assign({}, JE.core && JE.core.api && JE.core.api.authHeaders ? JE.core.api.authHeaders() : {}, { 'Content-Type': 'application/json' });
        let response = null;
        let body = null;
        try {
            response = await fetch(ApiClient.getUrl(ROUTE), {
                method: 'POST',
                headers,
                body: JSON.stringify(first ? {} : { epoch, cursor, keys: requestKeys(), wait: WAIT_SECONDS }),
                signal: controller.signal,
                cache: 'no-store'
            });
            if (response.ok) body = await response.json();
        } catch (_) {
            response = null;
        } finally {
            clearTimeout(timeout);
        }

        // Superseded (new keys, hidden tab, user switch): whoever aborted it decides what is next.
        if (inflight !== controller || myIdentity !== identityEpoch) return;
        inflight = null;

        if (!response) { fail(); return; }
        if (response.status === 401 || response.status === 403 || response.status === 404) {
            // Signed out, or the feature is off: stop for a while (navigating or signing in retries sooner).
            failures = 0;
            stoppedUntil = Date.now() + DISABLED_RETRY_MS;
            armStopped(DISABLED_RETRY_MS);
            return;
        }
        if (response.status === 429) {
            failures = Math.max(failures, 3);
            const retry = Number(response.headers.get('Retry-After'));
            schedule(retry > 0 ? retry * 1000 : backoffDelay());
            return;
        }
        if (!response.ok || !body || typeof body.cursor !== 'number' || typeof body.epoch !== 'string') { fail(); return; }

        failures = 0;
        // Only subscribed keys (an over-long key list was sent as "everything").
        const keys = Array.isArray(body.keys) ? body.keys.filter(k => typeof k === 'string' && isSubscribed(k)) : [];
        const epochChanged = epoch !== null && epoch !== body.epoch;
        // A first answer never moves past a position set meanwhile (prime, seed): it carries no changes.
        const keepEarlier = first && !epochChanged && cursor !== null && cursor <= body.cursor;
        epoch = body.epoch;
        if (!keepEarlier) cursor = body.cursor;
        if (body.reset || epochChanged) deliver([], true);
        else if (keys.length) deliver(keys, false);
        settleUnseeded();
        schedule(0);
    }

    function fail() {
        failures++;
        status = 'backoff';
        schedule(backoffDelay());
    }

    /**
     * Stays 'stopped' (navigating or signing in retries sooner), then polls again.
     * @param {number} delay - Time left until stoppedUntil.
     */
    function armStopped(delay) {
        if (timer) clearTimeout(timer);
        status = 'stopped';
        timer = setTimeout(() => { timer = null; stoppedUntil = 0; schedule(0); }, Math.max(0, delay));
    }

    /**
     * Hidden: no poll and no timer. Visible again: resumes at once (the cursor is kept; a reset
     * comes only if the server says so), or, while stopped, when the stop ends.
     */
    function onVisibility() {
        if (!visible()) {
            if (status === 'stopped') { if (timer) { clearTimeout(timer); timer = null; } return; }
            if (inflight || timer) stop(subscriptions.size ? 'waiting' : 'idle');
            return;
        }
        if (!subscriptions.size || inflight) return;
        if (status === 'stopped' && Date.now() < stoppedUntil) { armStopped(stoppedUntil - Date.now()); return; }
        stoppedUntil = 0;
        schedule(0);
    }

    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);

    // A different user must never continue the previous user's feed position.
    if (JE.session && typeof JE.session.onUserChange === 'function') {
        JE.session.onUserChange('arr-live', () => {
            identityEpoch++;
            stop('idle');
            epoch = null;
            cursor = null;
            failures = 0;
            stoppedUntil = 0;
            subscriptions.clear();
        });
    }

    // Navigating drops subscriptions whose elements are gone and retries a stopped feed.
    if (JE.core && JE.core.navigation && typeof JE.core.navigation.onNavigate === 'function') {
        JE.core.navigation.onNavigate(() => {
            pruneDetached();
            if (subscriptions.size === 0) { stop('idle'); return; }
            if (status === 'stopped') { stoppedUntil = 0; schedule(0); }
        });
    }

    JE.arr.titleKey = titleKey;
    JE.arr.onStatusChange = onStatusChange;
    JE.arr.live = {
        /** @returns {{status: string, epoch: string|null, cursor: number|null, subscriptions: number, keys: number, failures: number}} */
        state: () => ({ status, epoch, cursor, subscriptions: subscriptions.size, keys: allKeys().length, failures }),
        seed,
        position,
        prime,
        /** Polls at once (diagnostics). */
        pollNow: () => { stoppedUntil = 0; restartSoon(0); }
    };

})(window.JellyfinEnhanced);
