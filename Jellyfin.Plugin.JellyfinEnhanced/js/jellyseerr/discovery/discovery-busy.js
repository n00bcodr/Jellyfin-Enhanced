// /js/jellyseerr/discovery/discovery-busy.js
// A section's list while it is being replaced (a new order, a filter): it keeps its height and stays on
// screen, dimmed, until the new cards are in, and a change that takes long shows Jellyfin's own loading
// circle over it.
//
// Public surface: JE.discoveryBusy { circle, hold, release, mark, heldAt, HOLD_LIST_MS }.
(function(JE) {
    'use strict';

    /** How long a list being rebuilt keeps its height at most (ms). */
    const HOLD_LIST_MS = 8000;

    /**
     * Jellyfin's loading circle, in the markup its own loading module draws, so its stylesheet and the
     * active theme draw it. Shown (by the section's stylesheet, after a moment) while a section's list
     * is being replaced: over the list, and in the foot of the Filters menu where that covers the list.
     * @param {string} className - The class of the row that holds the circle
     * @returns {HTMLElement}
     */
    function circle(className) {
        const row = document.createElement('div');
        row.className = className;
        row.setAttribute('aria-hidden', 'true');
        const spinner = document.createElement('div');
        spinner.className = 'mdl-spinner mdlSpinnerActive';
        for (const layer of [1, 2, 3, 4]) {
            const one = document.createElement('div');
            one.className = `mdl-spinner__layer mdl-spinner__layer-${layer}`;
            for (const [side, part] of [['left', 'Left'], ['right', 'Right']]) {
                const clip = document.createElement('div');
                clip.className = `mdl-spinner__circle-clipper mdl-spinner__${side}`;
                const arc = document.createElement('div');
                arc.className = `mdl-spinner__circle mdl-spinner__circle${part}`;
                clip.appendChild(arc);
                one.appendChild(clip);
            }
            spinner.appendChild(one);
        }
        row.appendChild(spinner);
        return row;
    }

    /**
     * Where the page stands when a section's header is held at the top of the screen, just so.
     * @param {HTMLElement} section - The discovery section
     * @param {HTMLElement} header - Its header
     * @returns {number} The page's scroll position
     */
    function heldAt(section, header) {
        const bar = parseFloat(section.style.getPropertyValue('--jellyseerr-sticky-top')) || 0;
        const tuck = parseFloat(header.style.getPropertyValue('--jellyseerr-header-tuck')) || 0;
        return section.getBoundingClientRect().top + window.scrollY - bar + tuck + 2;
    }

    /**
     * For a change that takes long: Jellyfin's own loading circle over the section's list. (The stylesheet shows it, after a moment, while the list is marked busy.)
     * @param {Element|null|undefined} section - The discovery section
     */
    function mark(section) {
        const list = section?.querySelector('.itemsContainer');
        if (section && list && !section.querySelector('.jellyseerr-busy')) list.before(circle('jellyseerr-busy'));
    }

    /**
     * A list about to be rebuilt (a new order, a filter) keeps its height until the new cards are
     * in: emptied, it would let the page fall away under the viewer and move the control just used.
     * Outside a discovery section (the Recommendations page's controls) it does nothing.
     * @param {Element} control - The control just used, inside the section's header
     */
    function hold(control) {
        const section = control?.closest?.('.jellyseerr-discovery-section');
        const list = section?.querySelector('.itemsContainer');
        if (!section || !list) return;
        list.style.minHeight = `${list.offsetHeight}px`;
        list.dataset.held = section.querySelector('.jellyseerr-discovery-header')?.hasAttribute('data-stuck') ? 'stuck' : 'join';
        mark(section);
        // (Should the new cards never come, the height is not kept for ever.)
        setTimeout(() => release(list), HOLD_LIST_MS);
    }

    /**
     * The rebuilt list takes its own height; read under a held header, it starts again right under it.
     * @param {HTMLElement|null|undefined} list - The section's `.itemsContainer`
     */
    function release(list) {
        const held = list?.dataset?.held;
        if (!held) return;
        delete list.dataset.held;
        const section = list.closest('.jellyseerr-discovery-section');
        const header = section?.querySelector('.jellyseerr-discovery-header');
        if (held === 'stuck' && section && header) window.scrollTo({ top: heldAt(section, header) });
        list.style.minHeight = '';
    }

    // ---- Styles: the busy list, its circle, and the circle in the menu's foot ----------------------

    const STYLE_ID = 'jellyseerr-discovery-busy-styles';
    /** Puts this module's stylesheet in the page once. */
    function injectStyles() {
        if (typeof document === 'undefined' || !document.head || document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            /* Where the open menu covers the list (a phone, a narrow window): a change that takes long shows in the menu's foot that it is still being fetched (the same circle, after the same moment). */
            /* (In the middle of the foot: beside "Done" it would read as Done's own, as if closing the menu had to wait.) */
            .jellyseerr-sort-menu .jellyseerr-menu-foot { position: relative; }
            .jellyseerr-menu-busy { display: none; position: absolute; inset-inline-start: max(50%, calc(var(--jellyseerr-clear-end, 0px) + 1.7em)); top: 50%; transform: translate(-50%, -50%); margin: 0; pointer-events: none; }
            html[dir="rtl"] .jellyseerr-menu-busy { transform: translate(50%, -50%); }
            .jellyseerr-menu-busy .mdl-spinner { display: block; width: 1.4em; height: 1.4em; }
            /* Where the menu stands over the list's own circle (data-over-list: a phone, a TV, a narrow window), its foot shows it instead. On a TV at the foot's end (where the rows' values end; "Clear filters" has the remote's ground). */
            html:has(.jellyseerr-discovery-section .itemsContainer[aria-busy="true"]) .jellyseerr-sort-menu[data-over-list] .jellyseerr-menu-busy { display: block; animation: jellyseerr-busy-in 0s linear .8s both; }
            html.layout-tv .jellyseerr-menu-busy, html.layout-tv[dir="rtl"] .jellyseerr-menu-busy { inset-inline: auto 1em; transform: translateY(-50%); }

            /* A list being replaced (a new order, a filter) stays on screen, dimmed, until the new one is in. (After a moment: a quick answer does not flicker.) */
            .jellyseerr-discovery-section .itemsContainer[aria-busy="true"] { opacity: .45; pointer-events: none; transition: opacity .15s linear .2s; }
            /* A change that takes long shows that it is still working: Jellyfin's own loading circle over the list, after
               a moment, in sight wherever the section is read. It takes no room and no presses. */
            /* (Read mid-list it stands in the middle of the screen, as Jellyfin's own does; at the join it rests on the first row's posters, under their pills, so it is not read as one card's mark.) */
            .jellyseerr-busy { display: none; position: sticky; top: calc(50vh - 5.8em); z-index: 2; height: 0; justify-content: center; overflow: visible; pointer-events: none; }
            .jellyseerr-discovery-section:has(.itemsContainer[aria-busy="true"]) .jellyseerr-busy { display: flex; animation: jellyseerr-busy-in 0s linear .8s both; }
            /* A menu standing over any part of it shows the circle in its own foot instead (discovery-menu.js, data-over-list). */
            html:has(.jellyseerr-sort-menu[data-over-list]) .jellyseerr-discovery-section:has(.itemsContainer) .jellyseerr-busy { display: none; }
            @keyframes jellyseerr-busy-in { from { visibility: hidden; } to { visibility: visible; } }
            .jellyseerr-busy .mdl-spinner { flex: none; width: 2.6em; height: 2.6em; margin-top: 4.5em; }
            /* (So does the line that said nothing matched the filters before: it is as old as the list.) */
            .jellyseerr-discovery-section .itemsContainer[aria-busy="true"] ~ .jellyseerr-filters-none { opacity: .45; pointer-events: none; transition: opacity .15s linear .2s; }
            @media (prefers-reduced-motion: reduce) { .jellyseerr-discovery-section .itemsContainer[aria-busy="true"], .jellyseerr-discovery-section .itemsContainer[aria-busy="true"] ~ .jellyseerr-filters-none { transition: none; } }
        `;
        document.head.appendChild(style);
    }

    injectStyles();

    JE.discoveryBusy = { circle, hold, release, mark, heldAt, HOLD_LIST_MS };
})(window.JellyfinEnhanced || (window.JellyfinEnhanced = {}));
