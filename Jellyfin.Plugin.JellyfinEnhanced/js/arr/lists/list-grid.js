/**
 * @file Requests & downloads, phase 4c3a: playlists (and collections) on Jellyfin's grids that still have entries not in
 * the library are marked as incomplete instead of with Jellyfin's "played" check.
 *
 * Why the check: Jellyfin counts a playlist as played when none of its items is unplayed, so a playlist with no real
 * items (only entries JE draws) is "played" (UserData.Played true, UnplayedItemCount 0). JE never changes the played
 * state; it hides that check on the card (a class, removed again when the list has no visible entry left) and shows
 * its own "N not in your library" mark.
 *
 * Bounded: the ids of the cards that appear are batched (one call per burst, at most MAX_IDS per call) to the cheap
 * summary route (no statuses or metadata); answers are kept per person for a minute and dropped when a list changes.
 * A card that Jellyfin re-uses for another list (a new data-id) is re-decorated. Lists the person can't see or with no
 * entry they can see aren't answered, so the mark never reveals a hidden entry.
 */
(function (JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const lp = JE.internals.arrListPages = JE.internals.arrListPages || {};
    const logPrefix = '🪼 Jellyfin Enhanced: Lists:';

    const MAX_IDS = 200;
    const BATCH_MS = 120;
    const TTL_MS = 60000;
    const PENDING_RETRY_MS = 4000;
    const PENDING_RETRIES = 2;
    const OBSERVER_ID = 'arr-list-grid';
    const CARD_SELECTOR = '.card[data-id][data-type="Playlist"], .card[data-id][data-type="BoxSet"]';

    /** @type {Map<string, {missing: number, at: number}>} list id → summary (missing 0 = none to show) */
    const known = new Map();
    /** @type {Set<string>} ids waiting for the next call */
    const queue = new Set();
    /** @type {Set<string>} ids asked for and not answered yet */
    const inflight = new Set();
    /** @type {Map<string, number>} pending retries per id */
    const retries = new Map();
    let timer = null;
    let observing = false;
    let generation = 0;

    /**
     * Whether a kind's mark is on for this person (admin switch and their preferences).
     * @param {string} type Jellyfin item type (Playlist / BoxSet).
     * @returns {boolean} On.
     */
    function shownFor(type) {
        return lp.pages?.uiOn?.(type === 'BoxSet' ? 'collection' : 'playlist') === true;
    }

    /**
     * Whether a card is decorated as incomplete for its current list.
     * @param {HTMLElement} card Card.
     * @param {string} id List id.
     * @param {number} missing Entries not in the library.
     */
    function decorate(card, id, missing) {
        const tr = lp.render.tr;
        let mark = card.querySelector(':scope .je-list-grid-indicator');
        if (!(missing > 0)) {
            card.classList.remove('je-list-incomplete');
            mark?.remove();
            card.removeAttribute('data-je-list-grid');
            return;
        }
        lp.render.ensureStyles();
        card.classList.add('je-list-incomplete');
        card.dataset.jeListGrid = id;
        const host = card.querySelector('.cardIndicators') || (() => {
            const image = card.querySelector('.cardImageContainer');
            if (!image) return null;
            const box = lp.render.el('div', 'cardIndicators');
            image.appendChild(box);
            return box;
        })();
        if (!host) return;
        if (!mark) {
            mark = lp.render.el('div', 'indicator je-list-grid-indicator');
            mark.setAttribute('role', 'img');
            mark.appendChild(lp.render.icon('pending'));
            mark.appendChild(lp.render.el('span', 'je-list-grid-count'));
            host.appendChild(mark);
        }
        const text = lp.render.tn('arr_lists_grid_missing', { count: missing });
        mark.querySelector('.je-list-grid-count').textContent = String(missing);
        mark.title = text;
        mark.setAttribute('aria-label', text);
    }

    /**
     * Brings one card in line with what is known of its list.
     * @param {HTMLElement} card Card.
     * @returns {string|null} The id still to ask about, or null.
     */
    function apply(card) {
        const id = lp.render.normalizeId(card.getAttribute('data-id'));
        const type = card.getAttribute('data-type');
        if (!id || !shownFor(type)) {
            if (card.dataset.jeListGrid) decorate(card, '', 0);
            return null;
        }
        if (card.dataset.jeListGrid && card.dataset.jeListGrid !== id) decorate(card, '', 0);
        const entry = known.get(id);
        if (entry && Date.now() - entry.at < TTL_MS) {
            decorate(card, id, entry.missing);
            return null;
        }
        if (entry) decorate(card, id, entry.missing);
        return id;
    }

    /**
     * Looks at cards (all on the shown page, or the given ones) and asks about lists not known yet.
     * @param {Iterable<Element>} [cards] Cards.
     */
    function scan(cards) {
        if (!lp.pages?.uiOn?.('playlist') && !lp.pages?.uiOn?.('collection')) return;
        const list = cards ? [...cards] : [...document.querySelectorAll(CARD_SELECTOR)];
        for (const card of list) {
            const id = apply(/** @type {HTMLElement} */ (card));
            if (id && !inflight.has(id)) queue.add(id);
        }
        if (queue.size && !timer) timer = setTimeout(flush, BATCH_MS);
    }

    /** Sends the queued ids (MAX_IDS per call) and decorates every card of an answered list. */
    async function flush() {
        timer = null;
        if (!queue.size) return;
        const ids = [...queue].slice(0, MAX_IDS);
        ids.forEach((id) => { queue.delete(id); inflight.add(id); });
        if (queue.size) timer = setTimeout(flush, BATCH_MS);
        const started = generation;
        const epoch = JE.session?.getEpoch ? JE.session.getEpoch() : 0;
        let answer = null;
        try {
            const response = await fetch(ApiClient.getUrl('/JellyfinEnhanced/acquire/lists/summaries'), {
                method: 'POST',
                headers: { 'Authorization': `MediaBrowser Token="${ApiClient.accessToken()}"`, 'Accept': 'application/json', 'Content-Type': 'application/json' },
                body: JSON.stringify({ listIds: ids }),
                cache: 'no-store'
            });
            answer = response.ok ? await response.json() : null;
        } catch (err) {
            console.warn(`${logPrefix} list summaries failed`, err?.message || err);
        } finally {
            ids.forEach(id => inflight.delete(id));
        }
        if (started !== generation || (JE.session?.getEpoch ? JE.session.getEpoch() : 0) !== epoch || !answer) return;
        const now = Date.now();
        const pending = new Set((answer.pending || []).map(lp.render.normalizeId).filter(Boolean));
        const missing = new Map((answer.lists || []).map(s => [lp.render.normalizeId(s.listId), Number(s.missing) || 0]));
        for (const id of ids) {
            if (pending.has(id)) {
                const tries = (retries.get(id) || 0) + 1;
                retries.set(id, tries);
                if (tries <= PENDING_RETRIES) setTimeout(() => { if (started === generation) { queue.add(id); if (!timer) timer = setTimeout(flush, BATCH_MS); } }, PENDING_RETRY_MS);
                continue;
            }
            retries.delete(id);
            known.set(id, { missing: missing.get(id) || 0, at: now });
        }
        for (const card of document.querySelectorAll(CARD_SELECTOR)) {
            const id = lp.render.normalizeId(card.getAttribute('data-id'));
            if (id && known.has(id) && ids.includes(id)) apply(/** @type {HTMLElement} */ (card));
        }
    }

    /**
     * New nodes on the page: cards (or containers holding cards) that appeared.
     * @param {MutationRecord[]} records Records.
     */
    function onMutations(records) {
        const cards = new Set();
        for (const record of records || []) {
            for (const node of record.addedNodes || []) {
                if (node.nodeType !== 1) continue;
                const element = /** @type {Element} */ (node);
                if (element.matches?.(CARD_SELECTOR)) cards.add(element);
                else if (element.firstElementChild && element.querySelectorAll) element.querySelectorAll(CARD_SELECTOR).forEach(c => cards.add(c));
            }
        }
        if (cards.size) scan(cards);
    }

    /** Starts watching grids (once). */
    function start() {
        if (observing) return;
        observing = true;
        // Priority: runs before the next paint, so a list already known never shows Jellyfin's check first.
        if (JE.core?.dom?.onBodyMutation) JE.core.dom.onBodyMutation(OBSERVER_ID, onMutations, { priority: 1 });
        scan();
    }

    /** Stops watching and removes every mark. */
    function stop() {
        observing = false;
        JE.core?.dom?.removeBodySubscriber?.(OBSERVER_ID);
        reset();
        document.querySelectorAll('.card[data-je-list-grid]').forEach(card => decorate(/** @type {HTMLElement} */ (card), '', 0));
    }

    /** Forgets everything known (another person, settings changed). */
    function reset() {
        generation++;
        known.clear();
        queue.clear();
        inflight.clear();
        retries.clear();
        clearTimeout(timer);
        timer = null;
    }

    /**
     * A list changed (its entries or who sees them): ask about it again next time its card is looked at.
     * @param {string} listId List id.
     */
    function invalidate(listId) {
        const id = lp.render.normalizeId(listId);
        if (id) known.delete(id);
    }

    lp.grid = { start, stop, scan, reset, invalidate, decorate, onMutations, known, MAX_IDS };
})(window.JellyfinEnhanced);
