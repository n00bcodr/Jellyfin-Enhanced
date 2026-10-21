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
 * Cards jellyfin-web replaces (sort, filter, next page) are new nodes and are looked at as they come; a card whose
 * identity changes in place (its data-id / data-type: a re-used element) is watched by a small attribute observer and
 * looked at again, and so is a card whose insides were rebuilt (jellyfin-web's user-data update puts the played check
 * back). Lists the person can't see or with no entry they can see aren't answered, so the mark never reveals a hidden
 * entry. A summary is used only while the rule accepts it (the session it was asked in, and no reset since).
 *
 * Marks are painted through the paint gate with the grid's ticket (the session, watching, no reset since; a mark shows
 * a count only, nothing Spoiler Guard hides, so its policy is resolved at once); marks are taken away through erase.
 */
(function (JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const lp = JE.internals.arrListPages = JE.internals.arrListPages || {};
    const logPrefix = '🪼 Jellyfin Enhanced: Lists:';

    const MAX_IDS = 200;
    /** The first call of a page asks about the cards seen first only, so they are marked quickly (the rest follow). */
    const FIRST_IDS = 24;
    const BATCH_MS = 120;
    const TTL_MS = 60000;
    const PENDING_RETRY_MS = 4000;
    const PENDING_RETRIES = 2;
    const OBSERVER_ID = 'arr-list-grid';
    const CARD_SELECTOR = '.card[data-id][data-type="Playlist"], .card[data-id][data-type="BoxSet"]';
    const EMPTY_ID = '0'.repeat(32);

    /** @type {Map<string, {missing: number, at: number}>} list id → summary (missing 0 = none to show) */
    const known = new Map();
    /** @type {Set<string>} ids waiting for the next call */
    const queue = new Set();
    /** @type {Set<string>} ids asked for and not answered yet */
    const inflight = new Set();
    /** @type {Map<string, number>} pending retries per id */
    const retries = new Map();
    /** Invalidations during a request get exactly one subsequent refresh, never the old answer. */
    const dirty = new Set();
    let timer = null;
    let observing = false;
    let generation = 0;
    /** @type {MutationObserver|null} card identity changes (data-id / data-type of an element in place) */
    let identity = null;
    /** @type {Object|null} the grid's paint ticket (one per session and generation) */
    let paintTicket = null;

    /**
     * The grid's ticket for this session and generation (a new one after a reset or a person change).
     * @returns {Object|null} Ticket, or null while not watching.
     */
    function ticket() {
        if (!observing) return null;
        if (!paintTicket || !paintTicket.current()) {
            const started = generation;
            paintTicket = lp.gate.issue(null, () => observing && started === generation, lp.gate.policy(() => false, false));
        }
        return paintTicket;
    }

    /**
     * Whether a kind's mark is on for this person (admin switch and their preferences).
     * @param {string} type Jellyfin item type (Playlist / BoxSet).
     * @returns {boolean} On.
     */
    function shownFor(type) {
        return lp.pages?.uiOn?.(type === 'BoxSet' ? 'collection' : 'playlist') === true;
    }

    /**
     * Takes a card's mark away.
     * @param {HTMLElement} card Card.
     */
    function unmark(card) {
        lp.gate.erase(() => {
            card.classList.remove('je-list-incomplete');
            card.querySelector(':scope .je-list-grid-indicator')?.remove();
            card.removeAttribute('data-je-list-grid');
        });
    }

    /** Takes every mark away (person change, settings changed, stopped). */
    function unmarkAll() {
        document.querySelectorAll('.card[data-je-list-grid]').forEach(card => unmark(/** @type {HTMLElement} */ (card)));
    }

    /**
     * Whether a card is decorated as incomplete for its current list (a mark through the gate, or none).
     * @param {HTMLElement} card Card.
     * @param {string} id List id.
     * @param {number} missing Entries not in the library.
     * @param {Object} [t] The ticket to paint with (the grid's current one by default).
     */
    function decorate(card, id, missing, t) {
        if (!(missing > 0)) {
            unmark(card);
            return;
        }
        lp.gate.paint(t || ticket(), () => mark(card, id, missing), 'grid');
    }

    /**
     * Puts a card's mark in (inside paint()).
     * @param {HTMLElement} card Card.
     * @param {string} id List id.
     * @param {number} missing Entries not in the library.
     */
    function mark(card, id, missing) {
        let badge = card.querySelector(':scope .je-list-grid-indicator');
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
        if (!badge) {
            badge = lp.render.el('div', 'indicator je-list-grid-indicator');
            badge.setAttribute('role', 'img');
            badge.appendChild(lp.render.icon('pending'));
            badge.appendChild(lp.render.el('span', 'je-list-grid-count'));
            host.appendChild(badge);
        }
        const text = lp.render.tn('arr_lists_grid_missing', { count: missing });
        badge.querySelector('.je-list-grid-count').textContent = String(missing);
        badge.title = text;
        badge.setAttribute('aria-label', text);
    }

    /**
     * Brings one card in line with what is known of its list.
     * @param {HTMLElement} card Card.
     * @param {Object} [t] The ticket to paint with.
     * @returns {string|null} The id still to ask about, or null.
     */
    function apply(card, t) {
        const raw = lp.render.normalizeId(card.getAttribute('data-id'));
        // The empty id is no list (and the summary route refuses a batch holding it).
        const id = raw && raw !== EMPTY_ID ? raw : null;
        const type = card.getAttribute('data-type');
        if (!id || !shownFor(type)) {
            if (card.dataset.jeListGrid) unmark(card);
            return null;
        }
        if (card.dataset.jeListGrid && card.dataset.jeListGrid !== id) unmark(card);
        const entry = known.get(id);
        if (entry && Date.now() - entry.at < TTL_MS) {
            decorate(card, id, entry.missing, t);
            return null;
        }
        if (entry) decorate(card, id, entry.missing, t);
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
        const ids = [...queue].slice(0, known.size === 0 && inflight.size === 0 ? FIRST_IDS : MAX_IDS);
        ids.forEach((id) => { queue.delete(id); inflight.add(id); });
        if (queue.size) timer = setTimeout(flush, BATCH_MS);
        const started = generation;
        // The one acceptance rule: the session it was asked in, and nothing reset since (person, settings). Its marks
        // are painted with the grid ticket of that same session and generation.
        const rule = JE.arrLists.ticket(null, () => started === generation);
        const painter = ticket();
        let answer = null;
        try {
            const response = await fetch(ApiClient.getUrl('/JellyfinEnhanced/acquire/lists/summaries'), {
                method: 'POST',
                headers: { 'Authorization': `MediaBrowser Token="${ApiClient.accessToken()}"`, 'Accept': 'application/json', 'Content-Type': 'application/json' },
                body: JSON.stringify({ listIds: ids }),
                cache: 'no-store'
            });
            // The answer carries the person's revisions (core/access-revision.js).
            JE.core?.revision?.noteResponse(response);
            if (!rule.current()) return;
            answer = response.ok ? await response.json() : null;
            if (!rule.current()) return;
        } catch (err) {
            if (rule.current()) console.warn(`${logPrefix} list summaries failed`, err?.message || err);
            return;
        } finally {
            // A reset since cleared what was in flight (and may have asked for the same ids again).
            if (started === generation) {
                ids.forEach(id => inflight.delete(id));
                const again = ids.filter(id => dirty.has(id));
                again.forEach(id => { dirty.delete(id); queue.add(id); });
                // Remove invalidated ids from this response before processing it below.
                again.forEach(id => ids.splice(ids.indexOf(id), 1));
                if (queue.size && !timer) timer = setTimeout(flush, BATCH_MS);
            }
        }
        if (!answer) return;
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
            if (id && known.has(id) && ids.includes(id)) apply(/** @type {HTMLElement} */ (card), painter);
        }
    }

    /**
     * New nodes on the page: cards (or containers holding cards) that appeared, and cards whose insides were rebuilt
     * (their mark goes back in). Our own mark going in is not a change.
     * @param {MutationRecord[]} records Records.
     */
    function onMutations(records) {
        const cards = new Set();
        for (const record of records || []) {
            for (const node of record.addedNodes || []) {
                if (node.nodeType !== 1) continue;
                const element = /** @type {Element} */ (node);
                if (element.matches?.(CARD_SELECTOR)) cards.add(element);
                else if (element.classList?.contains('je-list-grid-indicator')) continue;
                else if (element.firstElementChild && element.querySelector?.(CARD_SELECTOR)) element.querySelectorAll(CARD_SELECTOR).forEach(c => cards.add(c));
                else {
                    const card = element.closest?.(CARD_SELECTOR);
                    if (card) cards.add(card);
                }
            }
        }
        if (cards.size) scan(cards);
    }

    /**
     * A card's identity changed in place (an element re-used for another list): look at the card again.
     * @param {MutationRecord[]} records Attribute records (data-id / data-type).
     */
    function onIdentity(records) {
        const cards = new Set();
        for (const record of records || []) {
            const target = /** @type {Element} */ (record.target);
            const card = target?.closest?.('.card');
            if (!card) continue;
            if (card.matches(CARD_SELECTOR)) cards.add(card);
            // No longer a list card (another kind of item): its mark goes.
            else if (card.getAttribute('data-je-list-grid')) unmark(/** @type {HTMLElement} */ (card));
        }
        if (cards.size) scan(cards);
    }

    /** Starts watching grids (once). */
    function start() {
        if (observing) return;
        observing = true;
        // Priority: runs before the next paint, so a list already known never shows Jellyfin's check first.
        if (JE.core?.dom?.onBodyMutation) JE.core.dom.onBodyMutation(OBSERVER_ID, onMutations, { priority: 1 });
        // The shared body observer hears added and removed nodes only; a card's identity changing in place is an
        // attribute change, watched here for those two attributes alone.
        if (typeof MutationObserver !== 'undefined' && document.body) {
            identity = new MutationObserver(onIdentity);
            identity.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-id', 'data-type'] });
        }
        scan();
    }

    /** Stops watching and removes every mark. */
    function stop() {
        observing = false;
        JE.core?.dom?.removeBodySubscriber?.(OBSERVER_ID);
        identity?.disconnect();
        identity = null;
        reset();
        unmarkAll();
    }

    /** Forgets everything known (another person, settings changed). */
    function reset() {
        generation++;
        known.clear();
        queue.clear();
        inflight.clear();
        retries.clear();
        dirty.clear();
        clearTimeout(timer);
        timer = null;
        paintTicket?.revoke();
        paintTicket = null;
    }

    // The person's access moved (core/access-revision.js): each list's missing count was worked out for the old access,
    // so it is read again. The same person is still signed in: a read running now is fenced (a new generation), each
    // count is kept only to stay on its card until the new answer replaces it (no mark comes off and back on).
    document.addEventListener('je-access-revision', () => {
        if (!observing) return;
        const shown = [...known].map(([id, entry]) => [id, { missing: entry.missing, at: 0 }]);
        reset();
        for (const [id, entry] of shown) known.set(id, entry);
        scan();
    });

    /**
     * A list changed (its entries or who sees them): refresh its visible cards, including changes during a batch.
     * @param {string} listId List id.
     */
    function invalidate(listId) {
        const id = lp.render.normalizeId(listId);
        if (!id) return;
        known.delete(id);
        retries.delete(id);
        if (!observing) return;
        const visible = [...document.querySelectorAll(CARD_SELECTOR)].filter(card => lp.render.normalizeId(card.getAttribute('data-id')) === id);
        if (!visible.length) return;
        visible.forEach(unmark);
        if (inflight.has(id)) dirty.add(id);
        else queue.add(id);
        if (queue.size && !timer) timer = setTimeout(flush, BATCH_MS);
    }

    lp.grid = { start, stop, scan, reset, invalidate, decorate, unmark, unmarkAll, onMutations, onIdentity, known, MAX_IDS };
})(window.JellyfinEnhanced);
