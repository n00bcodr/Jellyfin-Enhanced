/**
 * @file Requests & downloads, phase 1: episode chips and the "Not in the library yet" banner on
 * season pages. Episodes the user has a row for (real ones, and missing ones when they show
 * missing episodes) get a chip on their row; the others are listed in the banner above the list,
 * never both. Uses the season status the details surface already fetched (no request of its own)
 * and re-applies the chips when Jellyfin renders the episode rows after the status arrived.
 */
(function (JE) {
    'use strict';

    let state = null; // { page, status, ctx }
    let observer = null;

    /**
     * Banner entries: episodes without a row that are not simply ready (the next upcoming one only).
     * @param {Object} status Season status.
     * @returns {{missing: Object[], other: Object[]}} Entries.
     */
    function bannerEntries(status) {
        const missing = [];
        const other = [];
        let upcoming = false;
        for (const ep of status.episodes || []) {
            if (ep.row || ep.stage === 'ready' || ep.stage === 'none') continue;
            if (ep.stage === 'notOut') {
                if (upcoming) continue;
                upcoming = true;
                other.push(ep);
            } else if ((ep.stage === 'looking' || ep.stage === 'notHere') && ep.reason?.code !== 'service_down') {
                // An episode whose downloads can't be checked isn't missing: its chip says it takes longer.
                missing.push(ep);
            } else {
                other.push(ep);
            }
        }
        return { missing, other };
    }

    /**
     * Builds the banner, or null when every episode that matters has a row.
     * @param {Object} status Season status.
     * @returns {HTMLElement|null} Banner.
     */
    function buildBanner(status) {
        const { missing, other } = bannerEntries(status);
        if (!missing.length && !other.length) return null;
        const S = JE.arrStatus;
        const banner = S.el('div', 'je-arr-banner');
        banner.dataset.jeArrKey = status.key || '';
        banner.setAttribute('role', 'status');
        banner.appendChild(S.icon('playlist_remove', 'je-arr-banner-icon'));
        const body = S.el('div', 'je-arr-banner-body');
        if (missing.length) {
            const list = missing.map(ep => `E${ep.episode}`).join(', ');
            body.appendChild(S.el('span', 'je-arr-banner-title', S.tr('arr_banner_missing', { list })));
        } else {
            body.appendChild(S.el('span', 'je-arr-banner-title', S.tr('arr_banner_not_yet')));
        }
        for (const ep of other) {
            const chip = buildChip(ep);
            chip.textContent = `E${ep.episode} · ${chip.textContent}`;
            body.appendChild(chip);
        }
        banner.appendChild(body);
        return banner;
    }

    /**
     * One episode chip.
     * @param {Object} ep Episode status.
     * @returns {HTMLElement} Chip.
     */
    function buildChip(ep) {
        const S = JE.arrStatus;
        const tone = ep.attention ? 'attention' : ep.stage;
        const chip = S.el('span', `je-arr-chip je-arr-tone-${tone}`, S.chipText(ep));
        chip.dataset.jeArrKey = ep.key || '';
        return chip;
    }

    /**
     * Removes a chip (and the line holding it on phones).
     * @param {Element} chip Chip.
     * @returns {void}
     */
    function remove(chip) {
        const holder = chip.closest('.je-arr-chip-row');
        (holder || chip).remove();
    }

    /**
     * True unless the element or an ancestor up to the row is display:none.
     * @param {Element} el Element.
     * @param {Element} row Row.
     * @returns {boolean} Shown.
     */
    function shown(el, row) {
        for (let n = el; n && n !== row.parentNode; n = n.parentElement) {
            if (getComputedStyle(n).display === 'none') return false;
        }
        return true;
    }

    /**
     * Puts chips on the episode rows and the banner above the list (idempotent).
     * @returns {void}
     */
    function apply() {
        if (!state) return;
        const { page, status } = state;
        if (!document.contains(page) || page.classList.contains('hide')) return;
        const showReady = !status.quiet;
        const byId = new Map();
        for (const ep of status.episodes || []) {
            if (ep.row && ep.itemId) byId.set(ep.itemId.replace(/-/g, '').toLowerCase(), ep);
        }
        let firstRow = null;
        page.querySelectorAll('.listItem[data-id]').forEach(row => {
            const id = (row.getAttribute('data-id') || '').replace(/-/g, '').toLowerCase();
            const ep = byId.get(id);
            if (!firstRow && (row.getAttribute('data-type') === 'Episode')) firstRow = row;
            const existing = row.querySelector('.je-arr-chip');
            if (!ep || (ep.stage === 'ready' && ep.reason?.code === 'ready' && !showReady)) {
                if (existing) remove(existing);
                return;
            }
            const chip = buildChip(ep);
            if (existing && existing.textContent === chip.textContent && existing.className.replace(' je-arr-chip-overlay', '') === chip.className) return;
            if (existing) remove(existing);
            // The media-info line is hidden in phone layouts: the chip then sits on the thumbnail.
            const line = row.querySelector('.listItemMediaInfo') || row.querySelector('.listItemBody');
            const below = row.querySelector('.listItem-bottomoverview');
            const image = row.querySelector('.listItemImage');
            if (line && (shown(line, row) || (!below && !image))) {
                line.appendChild(chip);
            } else if (below) {
                const holder = document.createElement('div');
                holder.className = 'je-arr-chip-row';
                holder.appendChild(chip);
                below.parentNode.insertBefore(holder, below);
            } else if (image) {
                chip.classList.add('je-arr-chip-overlay');
                image.appendChild(chip);
            }
        });
        const list = firstRow ? firstRow.closest('.itemsContainer') : null;
        const old = page.querySelector('.je-arr-banner');
        const banner = buildBanner(status);
        if (!banner) {
            if (old) old.remove();
            return;
        }
        if (old && old.textContent === banner.textContent) return;
        if (old) old.remove();
        if (list && list.parentNode) list.parentNode.insertBefore(banner, list);
        else {
            const anchor = JE.internals?.arrStatusDetails?.anchorOf(page);
            if (anchor) anchor.appendChild(banner);
        }
    }

    /**
     * Shows a season's episode states on its page (and keeps them on while rows render).
     * @param {HTMLElement} page Season details page.
     * @param {Object} status Season status with episodes.
     * @param {Object} ctx Response context.
     * @returns {void}
     */
    function render(page, status, ctx) {
        state = { page, status, ctx };
        apply();
        if (!observer && JE.helpers?.onBodyMutation) {
            const schedule = JE.helpers.debounce ? JE.helpers.debounce(apply, 80) : apply;
            observer = JE.helpers.onBodyMutation('arr-status-episodes', (mutations) => {
                if (!state) return;
                for (const m of mutations) {
                    if (m.addedNodes && m.addedNodes.length) {
                        schedule();
                        return;
                    }
                }
            });
        }
    }

    /**
     * Removes chips and banner and stops following the season.
     * @returns {void}
     */
    function clear() {
        if (state?.page) {
            state.page.querySelectorAll('.je-arr-chip-row, .je-arr-chip').forEach(n => n.remove());
            state.page.querySelectorAll('.je-arr-banner').forEach(n => n.remove());
        }
        state = null;
    }

    JE.session?.onUserChange?.('arr-status-episodes', clear);

    JE.internals = JE.internals || {};
    JE.internals.arrStatusEpisodes = { render, clear, apply, bannerEntries };
})(window.JellyfinEnhanced);
