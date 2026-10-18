/**
 * @file Requests & downloads, phase 4d: when Home Screen Sections (HSS) draws the home page and the
 * server registered the rows as HSS sections, JE injects no rows of its own. It decorates HSS's three
 * JE sections instead (.verticalSection.JellyfinEnhancedYourRequests / .JellyfinEnhancedComingSoon /
 * .JellyfinEnhancedJustArrived): each .card[data-id] whose id is a card's hssId in the
 * /acquire/home answer gets the same overlay as JE's own cards (download ring, date pill, "New")
 * inside its .cardScalable, plus the second line. HSS may draw late and draw again, so a
 * MutationObserver watches the home container's children and those three sections only, while the
 * home page shows. Exposes JE.internals.arrHome.hss { drawn, decorate, watch, unwatch, clear }.
 */
(function (JE) {
    'use strict';

    const R = (JE.internals = JE.internals || {}).arrHome = JE.internals.arrHome || {};
    /** HSS section id (also its class) → answer row. */
    const SECTIONS = {
        JellyfinEnhancedYourRequests: 'requests',
        JellyfinEnhancedComingSoon: 'soon',
        JellyfinEnhancedJustArrived: 'arrived'
    };
    const DEBOUNCE_MS = 60;

    const state = { observer: null, container: null, sections: new Set(), timer: null, onChange: null };

    /**
     * True when HSS drew this home container (its sections carry data-page, or HSS's page meta is set).
     * @param {HTMLElement|null} container The home sections container.
     * @returns {boolean} Drawn by HSS.
     */
    function drawn(container) {
        if (container && container.querySelector(':scope > [data-page]')) return true;
        return !!window.HssPageMeta && typeof window.HssPageMeta === 'object';
    }

    /**
     * The JE sections HSS drew in a container.
     * @param {HTMLElement} container Container.
     * @returns {Array<{section: HTMLElement, row: string}>} Sections.
     */
    function sectionsIn(container) {
        const out = [];
        for (const [cls, row] of Object.entries(SECTIONS)) {
            container.querySelectorAll(`.verticalSection.${cls}`).forEach(section => out.push({ section, row }));
        }
        return out;
    }

    /**
     * Removes JE's decoration from one HSS card.
     * @param {HTMLElement} card Card.
     * @returns {void}
     */
    function undecorate(card) {
        card.querySelectorAll('.je-home-overlay, .je-home-line').forEach(n => n.remove());
        card.querySelectorAll('.je-home-replaced').forEach(n => n.classList.remove('je-home-replaced'));
        card.classList.remove('je-home-hss-card');
        delete card.dataset.jeHomeSig;
    }

    /**
     * Decorates one HSS card from its answer card (only when what it shows changed).
     * @param {HTMLElement} card HSS card.
     * @param {string} row Row id.
     * @param {Object} entry Answer card.
     * @returns {void}
     */
    function paint(card, row, entry) {
        const over = R.overlay(row, entry, R.freeCorner());
        const line = R.lineText(row, entry);
        const sig = `${row}|${over ? over.outerHTML : ''}|${line}`;
        if (card.dataset.jeHomeSig === sig && card.classList.contains('je-home-hss-card')) return;
        undecorate(card);
        card.classList.add('je-home-hss-card');
        card.dataset.jeHomeSig = sig;
        const scalable = card.querySelector('.cardScalable');
        if (over && scalable) scalable.appendChild(over);
        const box = card.querySelector('.cardBox') || card;
        if (line) {
            const texts = box.querySelectorAll(':scope > .cardText, :scope > .cardFooter .cardText');
            texts.forEach((t, i) => { if (i > 0 && t.classList.contains('cardText-secondary')) t.classList.add('je-home-replaced'); });
            const own = R.el('div', 'cardText cardTextCentered cardText-secondary je-home-line');
            own.appendChild(R.el('bdi', '', line));
            const first = texts[0];
            if (first && first.parentElement) first.parentElement.insertBefore(own, first.nextSibling);
            else box.appendChild(own);
        }
    }

    /**
     * Decorates every card of HSS's JE sections in a container from the answer (by hssId).
     * @param {HTMLElement} container Home container.
     * @param {Object} data Answer (rows filtered for what the person hid).
     * @returns {number} Cards decorated.
     */
    function decorate(container, data) {
        let count = 0;
        for (const { section, row } of sectionsIn(container)) {
            const byId = new Map();
            for (const entry of Array.isArray(data?.[row]) ? data[row] : []) {
                const id = R.normalizeId(entry?.hssId) || R.normalizeId(entry?.itemId);
                if (id && !byId.has(id)) byId.set(id, entry);
            }
            section.querySelectorAll('.card[data-id]').forEach(card => {
                const entry = byId.get(R.normalizeId(card.getAttribute('data-id')));
                if (entry) {
                    paint(card, row, entry);
                    count++;
                } else if (card.classList.contains('je-home-hss-card')) {
                    undecorate(card);
                }
            });
        }
        return count;
    }

    /**
     * Takes JE's decoration off every HSS card.
     * @returns {void}
     */
    function clear() {
        document.querySelectorAll('.je-home-hss-card').forEach(undecorate);
    }

    /**
     * True when a mutation only touched JE's own decoration (no need to look again).
     * @param {MutationRecord} m Mutation.
     * @returns {boolean} Own.
     */
    function ownMutation(m) {
        const nodes = [...m.addedNodes, ...m.removedNodes];
        // JE's decoration, or JE placing its own rows (a move is a removal and an addition; a row block
        // someone else took away is not connected any more and does count).
        const own = n => n.nodeType === 1 && (n.classList.contains('je-home-overlay') || n.classList.contains('je-home-line')
            || (n.classList.contains('je-home-rows') && n.isConnected));
        return nodes.length > 0 && nodes.every(own);
    }

    /**
     * Watches a home container for HSS drawing (or redrawing) its sections: the container's own children
     * and the JE sections' subtrees, nothing else. Calls onChange (debounced) after a change.
     * @param {HTMLElement} container Home container.
     * @param {() => void} onChange Called after HSS changed something.
     * @returns {void}
     */
    function watch(container, onChange) {
        state.onChange = onChange;
        if (typeof MutationObserver === 'undefined') return;
        if (state.container !== container) {
            unwatch();
            state.onChange = onChange;
            state.container = container;
            state.observer = new MutationObserver((records) => {
                if (records.every(ownMutation)) return;
                observeSections();
                if (state.timer) clearTimeout(state.timer);
                state.timer = setTimeout(() => {
                    state.timer = null;
                    state.onChange?.();
                }, DEBOUNCE_MS);
            });
            state.observer.observe(container, { childList: true });
        }
        observeSections();
    }

    /**
     * Adds the JE sections now in the watched container to the observer (each once).
     * @returns {void}
     */
    function observeSections() {
        if (!state.observer || !state.container) return;
        for (const { section } of sectionsIn(state.container)) {
            if (state.sections.has(section)) continue;
            state.sections.add(section);
            state.observer.observe(section, { childList: true, subtree: true });
        }
        for (const section of [...state.sections]) if (!section.isConnected) state.sections.delete(section);
    }

    /**
     * Stops watching.
     * @returns {void}
     */
    function unwatch() {
        if (state.observer) state.observer.disconnect();
        if (state.timer) clearTimeout(state.timer);
        state.observer = null;
        state.container = null;
        state.timer = null;
        state.onChange = null;
        state.sections.clear();
    }

    R.hss = { SECTIONS, drawn, decorate, watch, unwatch, clear, state };
})(window.JellyfinEnhanced);
