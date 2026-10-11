/**
 * @file Requests & downloads, phase 1: status badges on poster cards (library grids, home rows,
 * season cards on series pages). Cards are looked up only once they come near the viewport
 * (IntersectionObserver), batched into one request per burst (up to 100 ids), at low priority;
 * answers are kept a minute per item so scrolling back or returning to a page costs nothing.
 * Quiet statuses draw nothing. A change event for a title re-fetches the cards showing it.
 */
(function (JE) {
    'use strict';

    const CARD_TYPES = new Set(['Movie', 'Series', 'Season', 'Episode']);
    const BATCH = 100;
    const FLUSH_MS = 300;
    const TTL_MS = 60000;

    /** @type {Map<string, {status: Object|null, at: number}>} item id -> last answer */
    const cache = new Map();
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
     * Draws (or removes) a card's badge for a status.
     * @param {Element} card Card element.
     * @param {Object|null} status Status (null: nothing known).
     * @returns {void}
     */
    function paint(card, status) {
        const host = card.querySelector('.cardScalable') || card.querySelector('.cardBox') || card;
        const old = host.querySelector(':scope > .je-arr-badge');
        const badge = status ? JE.arrStatus.buildBadge(status) : null;
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
            if (id && ids.has(id)) paint(card, cache.get(id)?.status || null);
        });
    }

    /**
     * Sends the queued ids (in batches), caches and paints the answers.
     * @returns {Promise<void>}
     */
    async function flush() {
        flushTimer = null;
        if (!JE.arrStatus?.enabled()) return;
        const ids = [...queued].filter(id => !inFlight.has(id));
        queued.clear();
        for (let i = 0; i < ids.length; i += BATCH) {
            const batch = ids.slice(i, i + BATCH);
            batch.forEach(id => inFlight.add(id));
            const epoch = JE.session ? JE.session.getEpoch() : 0;
            let data = null;
            try {
                data = await JE.arrStatus.fetchBatch(batch, []);
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
            if (!data) {
                // Failed (a re-fetch after a change, or a first look): ask again for the cards
                // still shown after a pause, so a badge doesn't stay at what it showed before.
                retryLater(batch);
                continue;
            }
            failures = 0;
            noteSince(data.since);
            for (const id of batch) cache.set(id, { status: answered.get(id) || null, at: now });
            paintAll(new Set(batch));
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
            paint(card, entry.status);
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
            cache.delete(id);
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
                cache.delete(id);
                // Only cards still shown are asked for again; the rest come back fresh when seen.
                if (onPage.has(id)) queued.add(id);
            });
        }
        prune(onPage);
        if (queued.size && !flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
    }

    /**
     * Starts the poster-badge surface (behind the status and poster-badge flags).
     * @returns {void}
     */
    function initialize() {
        if (started || !JE.arrStatus?.enabled() || JE.pluginConfig?.ArrStatusPosterBadges !== true) return;
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
        setTimeout(scan, 400);
    }

    JE.session?.onUserChange?.('arr-status-cards', () => {
        cache.clear();
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
        }
    });

    JE.internals = JE.internals || {};
    JE.internals.arrStatusCards = { scan, flush, paint, refreshKeys, prune, badgeCorner, cache, idsByKey };
    JE.initializeArrStatusCards = initialize;
})(window.JellyfinEnhanced);
