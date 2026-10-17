/**
 * @file Requests & downloads, phase 1: status badges on poster cards (library grids, home rows,
 * season cards on series pages). Cards are looked up only once they come near the viewport
 * (IntersectionObserver), batched into one request per burst (up to 100 ids), at low priority;
 * answers are kept a minute per item so scrolling back or returning to a page costs nothing.
 * Quiet statuses draw nothing. A change event for a title re-fetches the cards showing it.
 * Phase 4e: with acquisition badges on, the same batches also read each card's stamp (Upgraded,
 * New for you, 4K) in parallel, painted when no in-progress badge takes the card; the person's
 * own watch state changing (Jellyfin's UserDataChanged) re-reads those cards.
 */
(function (JE) {
    'use strict';

    const CARD_TYPES = new Set(['Movie', 'Series', 'Season', 'Episode']);
    const BATCH = 100;
    const FLUSH_MS = 300;
    const TTL_MS = 60000;

    /** @type {Map<string, {status: Object|null, stamp: string|null, at: number}>} item id -> last answer */
    const cache = new Map();
    /** @type {Map<string, {status: Object|null, stamp: string|null}>} what was shown before an entry was dropped for a re-read */
    const stale = new Map();
    /** Stops listening to Jellyfin's UserDataChanged messages (phase 4e), or null. */
    let stopUserData = null;
    /** @type {Map<string, Set<string>>} title key -> item ids shown with it */
    const idsByKey = new Map();
    const queued = new Set();
    const inFlight = new Set();
    let seen = new WeakSet();
    let io = null;
    let flushTimer = null;
    let started = false;
    let unsubscribe = null;
    let subscribedKeys = '';
    /** @type {{epoch: string, cursor: number}|null} the oldest feed position of answers not yet followed */
    let followSince = null;
    /** An answer painted since the last subscription was read without a feed position. */
    let followUnknown = false;
    let resubscribeTimer = null;
    /** Failed batches in a row (their ids are asked again after a growing pause). */
    let failures = 0;
    let retryTimer = null;
    /** @type {Set<string>} ids of failed batches waiting for the retry */
    const retryIds = new Set();
    const RETRY_MS = [5000, 15000, 60000];

    /** JE poster tags and their default corners (tag-pipeline's own defaults). */
    const TAG_CORNERS = [['quality', 'top-left'], ['genre', 'top-right'], ['language', 'bottom-left'], ['rating', 'bottom-right'], ['ageRating', 'bottom-right']];
    /** Corners a badge may take, best first (Jellyfin's own played/count indicator sits top-right). */
    const CORNERS = ['bottom-left', 'bottom-right', 'top-left', 'top-right'];

    /**
     * The poster corner for status badges: the first one no enabled JE poster tag (quality, genre,
     * language, rating, age rating) is configured for, read like the tag pipeline reads them (the
     * user's setting, else the admin default). With every corner taken, bottom-left raised above
     * whatever sits there.
     * @returns {string} A CORNERS value, or 'bottom-left raised'.
     */
    function badgeCorner() {
        const used = new Set();
        for (const [name, fallback] of TAG_CORNERS) {
            if (!JE.currentSettings?.[`${name}TagsEnabled`]) continue;
            const plugin = `${name.charAt(0).toUpperCase()}${name.slice(1)}TagsPosition`;
            used.add(JE.currentSettings?.[`${name}TagsPosition`] || JE.pluginConfig?.[plugin] || fallback);
        }
        return CORNERS.find(c => !used.has(c)) || 'bottom-left raised';
    }

    /**
     * Normalised item id of a card (32 hex, lower case), or null.
     * @param {Element} card Card.
     * @returns {string|null} Id.
     */
    function cardId(card) {
        const raw = card.getAttribute('data-id');
        return raw ? raw.replace(/-/g, '').toLowerCase() : null;
    }

    /**
     * True when the phase-1 status badges are on (status feature and its poster-badge switch).
     * @returns {boolean} On.
     */
    function statusBadgesOn() {
        return JE.arrStatus?.enabled() === true && JE.pluginConfig?.ArrStatusPosterBadges === true;
    }

    /**
     * True when acquisition badges (phase 4e) are on for this person.
     * @returns {boolean} On.
     */
    function stampsOn() {
        return JE.arrStatus?.stampsEnabled?.() === true;
    }

    /**
     * Draws (or removes) a card's badge for a status and an acquisition stamp.
     * @param {Element} card Card element.
     * @param {Object|null} status Status (null: nothing known).
     * @param {string|null} [stamp] Acquisition stamp (phase 4e).
     * @returns {void}
     */
    function paint(card, status, stamp) {
        const host = card.querySelector('.cardScalable') || card.querySelector('.cardBox') || card;
        const old = host.querySelector(':scope > .je-arr-badge');
        const badge = status || stamp ? JE.arrStatus.buildBadge(status || null, stamp || null) : null;
        if (!badge) {
            if (old) old.remove();
            return;
        }
        for (const part of badgeCorner().split(' ')) badge.classList.add(`je-arr-badge-${part}`);
        if (old && old.outerHTML === badge.outerHTML) return;
        if (old) old.remove();
        host.appendChild(badge);
    }

    /**
     * Paints every card on the page that shows one of these items (one DOM walk).
     * @param {Set<string>} ids Item ids.
     * @returns {void}
     */
    function paintAll(ids) {
        document.querySelectorAll('.card[data-id]').forEach(card => {
            const id = cardId(card);
            if (!id || !ids.has(id)) return;
            const entry = cache.get(id);
            paint(card, entry?.status || null, entry?.stamp || null);
        });
    }

    /**
     * Sends the queued ids (in batches), caches and paints the answers.
     * @returns {Promise<void>}
     */
    async function flush() {
        flushTimer = null;
        const withStatus = statusBadgesOn();
        const withStamps = stampsOn();
        if (!withStatus && !withStamps) return;
        const ids = [...queued].filter(id => !inFlight.has(id));
        queued.clear();
        for (let i = 0; i < ids.length; i += BATCH) {
            const batch = ids.slice(i, i + BATCH);
            batch.forEach(id => inFlight.add(id));
            const epoch = JE.session ? JE.session.getEpoch() : 0;
            let data = null;
            let stampData = null;
            try {
                // Statuses and stamps are separate reads, sent together; either may fail alone.
                [data, stampData] = await Promise.all([
                    withStatus ? JE.arrStatus.fetchBatch(batch, []) : null,
                    withStamps ? JE.arrStatus.fetchStamps(batch) : null
                ]);
            } finally {
                batch.forEach(id => inFlight.delete(id));
            }
            if (JE.session && !JE.session.isCurrent(epoch)) return;
            const now = Date.now();
            const answered = new Map();
            for (const status of data?.items || []) {
                if (!status.itemId) continue;
                const id = status.itemId.toLowerCase();
                answered.set(id, status);
                if (status.key) follow(status.key, id);
                if (status.liveKey) follow(status.liveKey, id);
            }
            const stamps = new Map();
            for (const item of stampData?.items || []) {
                if (item?.itemId && typeof item.stamp === 'string') stamps.set(item.itemId.replace(/-/g, '').toLowerCase(), item.stamp);
            }
            // A stamps read refused because the feature is off (403) is no failure: stamps just stop.
            const statusFailed = withStatus && !data;
            const stampsFailed = withStamps && !stampData && stampsOn();
            if (!data && !stampData && (statusFailed || stampsFailed)) {
                // Failed (a re-fetch after a change, or a first look): ask again for the cards
                // still shown after a pause, so a badge doesn't stay at what it showed before.
                retryLater(batch);
                continue;
            }
            if (data) noteSince(data.since);
            for (const id of batch) {
                // The half that failed keeps what the card showed; the retry below reads it again.
                const before = cache.get(id) || stale.get(id);
                stale.delete(id);
                cache.set(id, {
                    status: data ? answered.get(id) || null : statusFailed ? before?.status || null : null,
                    stamp: stampData ? stamps.get(id) || null : stampsFailed ? before?.stamp || null : null,
                    at: now
                });
            }
            paintAll(new Set(batch));
            if (statusFailed || stampsFailed) retryLater(batch);
            else failures = 0;
        }
        prune();
    }

    /**
     * Item ids of the cards in the document now (one DOM walk).
     * @returns {Set<string>} Ids.
     */
    function idsOnPage() {
        const ids = new Set();
        document.querySelectorAll('.card[data-id]').forEach(card => {
            const id = cardId(card);
            if (id) ids.add(id);
        });
        return ids;
    }

    /**
     * Forgets titles whose cards are gone (navigation, re-rendered lists) and follows only the
     * titles still shown, so the change-feed subscription and the re-fetches stay as small as the
     * page. Answers for cards no longer on the page, and expired answers, are dropped too: the
     * cache stays the size of the page, and a card that comes back later is asked for afresh
     * (a change it missed while gone can't be painted from an old answer).
     * @param {Set<string>} [onPage] Ids on the page (computed when omitted).
     * @returns {void}
     */
    function prune(onPage) {
        const present = onPage || idsOnPage();
        for (const [key, ids] of idsByKey) {
            for (const id of ids) if (!present.has(id)) ids.delete(id);
            if (!ids.size) idsByKey.delete(key);
        }
        const now = Date.now();
        for (const [id, entry] of cache) {
            if (!present.has(id) || now - entry.at >= TTL_MS) cache.delete(id);
        }
        for (const id of stale.keys()) if (!present.has(id)) stale.delete(id);
        resubscribe();
    }

    /**
     * Records that a card shows an item with this title key (for refreshes and the change feed).
     * @param {string} key Title key.
     * @param {string} id Item id.
     * @returns {boolean} True when the id was not followed yet.
     */
    function follow(key, id) {
        if (!idsByKey.has(key)) idsByKey.set(key, new Set());
        const ids = idsByKey.get(key);
        if (ids.has(id)) return false;
        ids.add(id);
        return true;
    }

    /**
     * Queues a card's item for the next batch (or paints it from a fresh answer).
     * @param {Element} card Card.
     * @param {string} id Item id.
     * @returns {void}
     */
    function want(card, id) {
        const entry = cache.get(id);
        if (entry && Date.now() - entry.at < TTL_MS) {
            paint(card, entry.status, entry.stamp);
            // Painted from the cache: follow the title again (a prune may have dropped it), once per burst.
            const followed = [entry.status?.key, entry.status?.liveKey].filter(Boolean).map(key => follow(key, id)).some(Boolean);
            if (followed && !resubscribeTimer) {
                resubscribeTimer = setTimeout(() => {
                    resubscribeTimer = null;
                    resubscribe();
                }, 0);
            }
            return;
        }
        queued.add(id);
        if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
    }

    /**
     * Starts watching cards that appeared since the last scan.
     * @returns {void}
     */
    function scan() {
        if (!io) return;
        document.querySelectorAll('.card[data-id][data-type]').forEach(card => {
            if (seen.has(card)) return;
            seen.add(card);
            if (!CARD_TYPES.has(card.getAttribute('data-type'))) return;
            io.observe(card);
        });
    }

    /**
     * Follows the titles on screen through the change feed / JE.arrStatus.refresh.
     * @returns {void}
     */
    function resubscribe() {
        const keys = [...idsByKey.keys()].sort();
        const joined = keys.join(',');
        const since = followSince;
        const unknown = followUnknown;
        followSince = null;
        followUnknown = false;
        if (joined === subscribedKeys && (unsubscribe || !keys.length) && !(unknown && keys.length)) {
            // Same titles: the feed still moves back to where the newest answers were read.
            if (since && unsubscribe) JE.arr?.live?.seed?.(since.epoch, since.cursor);
            return;
        }
        if (typeof unsubscribe === 'function') unsubscribe();
        subscribedKeys = joined;
        // An answer read without a feed position: the new subscription is called back once the
        // feed has one (the cards are asked again from there).
        unsubscribe = keys.length ? JE.arrStatus.subscribe(keys, refreshKeys, { since: unknown ? null : since || undefined }) : null;
    }

    /**
     * Asks again, after a pause that grows with failures in a row, for the ids of a failed batch
     * whose cards are still on the page.
     * @param {string[]} ids Item ids of the failed batch.
     * @returns {void}
     */
    function retryLater(ids) {
        failures++;
        ids.forEach(id => {
            forget(id);
            retryIds.add(id);
        });
        if (retryTimer) return;
        retryTimer = setTimeout(() => {
            retryTimer = null;
            const onPage = idsOnPage();
            for (const id of retryIds) if (onPage.has(id) && !cache.has(id)) queued.add(id);
            retryIds.clear();
            if (queued.size && !flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
        }, RETRY_MS[Math.min(failures, RETRY_MS.length) - 1]);
    }

    /**
     * Remembers the oldest feed position of the answers painted since the last subscription, so
     * changes made after those reads reach the cards (see JE.arrStatus.subscribe). An answer read
     * without a position marks the next subscription as made without one.
     * @param {{epoch: string, cursor: number}|null|undefined} since Position from before a read.
     * @returns {void}
     */
    function noteSince(since) {
        if (!since || typeof since.cursor !== 'number') {
            followUnknown = true;
            return;
        }
        if (!followSince || followSince.epoch !== since.epoch || since.cursor < followSince.cursor) followSince = since;
    }

    /**
     * Re-fetches the cards showing changed titles.
     * @param {string[]} keys Changed title keys.
     * @returns {void}
     */
    function refreshKeys(keys) {
        const wanted = new Set(keys);
        const onPage = idsOnPage();
        for (const [key, ids] of idsByKey) {
            if (!wanted.has(key) && !wanted.has(key.replace(/:s\d+(:e\d+)?$/, ''))) continue;
            ids.forEach(id => {
                forget(id);
                // Only cards still shown are asked for again; the rest come back fresh when seen.
                if (onPage.has(id)) queued.add(id);
            });
        }
        prune(onPage);
        if (queued.size && !flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
    }

    /**
     * Drops an item's answer so the next look reads it again, remembering what its card shows
     * (a read that half fails keeps that half on screen).
     * @param {string} id Item id.
     * @returns {void}
     */
    function forget(id) {
        const entry = cache.get(id);
        if (entry) stale.set(id, { status: entry.status, stamp: entry.stamp || null });
        cache.delete(id);
    }

    /**
     * Jellyfin says the person's own watch state of these items changed (UserDataChanged): their
     * answers are dropped and the cards on the page asked for again, so a title just watched loses
     * its New/Upgraded badge without a reload. A watched episode can also end the stamp of its
     * season or series: on a "played" change, stamped Season/Series cards on the page are asked
     * for again too.
     * @param {Object} data The message's Data ({UserId, UserDataList: [{ItemId, Played, ...}]}).
     * @returns {void}
     */
    function onUserData(data) {
        if (!stampsOn()) return;
        const list = Array.isArray(data?.UserDataList) ? data.UserDataList : [];
        if (!list.length) return;
        const changed = new Set(list.map(u => (typeof u?.ItemId === 'string' ? u.ItemId.replace(/-/g, '').toLowerCase() : '')).filter(Boolean));
        const played = list.some(u => u?.Played === true);
        let any = false;
        document.querySelectorAll('.card[data-id]').forEach(card => {
            const id = cardId(card);
            if (!id) return;
            const type = card.getAttribute('data-type');
            const parent = played && (type === 'Series' || type === 'Season') && !!cache.get(id)?.stamp;
            if (!changed.has(id) && !parent) return;
            forget(id);
            queued.add(id);
            any = true;
        });
        for (const id of changed) if (cache.has(id)) forget(id);
        if (any && !flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
    }

    /**
     * Listens to Jellyfin's own UserDataChanged messages through jellyfin-web's ApiClient (no socket
     * of JE's own): `ApiClient.subscribe` on Jellyfin 12, else jellyfin-web's global `Events` on the
     * ApiClient's 'message' event (10.11). Only with acquisition badges on.
     * @returns {void}
     */
    function listenUserData() {
        if (typeof stopUserData === 'function') stopUserData();
        stopUserData = null;
        if (!stampsOn()) return;
        const client = window.ApiClient;
        if (!client) return;
        try {
            if (typeof client.subscribe === 'function') {
                const off = client.subscribe(['UserDataChanged'], (msg) => onUserData(msg?.Data));
                stopUserData = typeof off === 'function' ? off : null;
                return;
            }
            const events = window.Events;
            if (typeof events?.on !== 'function') return;
            const handler = (_e, msg) => {
                if (msg?.MessageType === 'UserDataChanged') onUserData(msg.Data);
            };
            events.on(client, 'message', handler);
            stopUserData = () => events.off?.(client, 'message', handler);
        } catch (err) {
            console.warn('🪼 Jellyfin Enhanced: Status: watch-state listener failed', err);
        }
    }

    /**
     * Forgets every answer, followed title and badge, and looks at the cards on the page again
     * (a user switch).
     * @returns {void}
     */
    function clearAll() {
        cache.clear();
        stale.clear();
        idsByKey.clear();
        queued.clear();
        retryIds.clear();
        failures = 0;
        followSince = null;
        followUnknown = false;
        seen = new WeakSet();
        if (typeof unsubscribe === 'function') unsubscribe();
        unsubscribe = null;
        subscribedKeys = '';
        document.querySelectorAll('.je-arr-badge').forEach(n => n.remove());
        if (io) {
            io.disconnect();
            setTimeout(scan, 0);
            // The next person may not want acquisition badges (or may).
            listenUserData();
        }
    }

    /**
     * The person changed their acquisition-badge preference (settings panel): every card is
     * looked at afresh, and the surface starts if it wasn't running and now should.
     * @returns {void}
     */
    function reset() {
        clearAll();
        if (!started) initialize();
    }

    /**
     * Starts the poster-badge surface: behind the status and poster-badge flags, or the
     * acquisition-badge flag (phase 4e).
     * @returns {void}
     */
    function initialize() {
        if (started || (!statusBadgesOn() && !stampsOn())) return;
        if (typeof IntersectionObserver !== 'function') return;
        started = true;
        io = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                io.unobserve(entry.target);
                const id = cardId(entry.target);
                if (id) want(entry.target, id);
            }
        }, { rootMargin: '600px 0px' });
        const lifecycle = JE.core?.lifecycle?.register('arr-status-cards');
        const schedule = JE.helpers?.debounce ? JE.helpers.debounce(scan, 150) : scan;
        const handle = JE.helpers?.onBodyMutation?.('arr-status-cards', (mutations) => {
            for (const m of mutations) {
                if (m.addedNodes && m.addedNodes.length) {
                    schedule();
                    return;
                }
            }
        });
        if (lifecycle && handle) lifecycle.track(handle);
        // Leaving a page drops the titles only it showed (after the new page has rendered its cards).
        const onNav = JE.core?.navigation?.onNavigate?.(() => setTimeout(() => prune(), 1000));
        if (lifecycle && onNav) lifecycle.track(onNav);
        listenUserData();
        setTimeout(scan, 400);
    }

    JE.session?.onUserChange?.('arr-status-cards', clearAll);

    JE.internals = JE.internals || {};
    JE.internals.arrStatusCards = { scan, flush, paint, refreshKeys, prune, badgeCorner, reset, onUserData, cache, idsByKey };
    JE.initializeArrStatusCards = initialize;
})(window.JellyfinEnhanced);
