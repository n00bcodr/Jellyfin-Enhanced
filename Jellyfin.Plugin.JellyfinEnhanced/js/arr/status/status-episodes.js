/**
 * @file Requests & downloads, phase 1: episode chips and the "Not in the library yet" banner on
 * season pages. Episodes the user has a row for (real ones, and missing ones when they show
 * missing episodes) get a chip on their row; the others are listed in the banner above the list,
 * never both. Uses the season status the details surface already fetched (no request of its own)
 * and re-applies the chips when Jellyfin renders the episode rows after the status arrived.
 * Phase 3 (ask-episodes.js) plugs in through extend(): it can word a chip differently (a request's
 * state), take episodes out of the banner because it draws rows for them, and decorate the page.
 */
(function (JE) {
    'use strict';

    let state = null; // { page, status, ctx }
    let observer = null;
    /** Phase-3 extension: { chip?(ep), drawn?(status), decorate?(page, status, ctx, parts), clear?(page) }. */
    let extension = null;

    /**
     * Banner entries: episodes without a row that are not simply ready (the next upcoming one only).
     * @param {Object} status Season status.
     * @param {Set<number>} [drawn] Episodes another surface shows as rows (left out).
     * @returns {{missing: Object[], other: Object[]}} Entries.
     */
    function bannerEntries(status, drawn) {
        const missing = [];
        const other = [];
        let upcoming = false;
        for (const ep of status.episodes || []) {
            if (ep.row || ep.stage === 'ready' || ep.stage === 'none') continue;
            if (drawn && drawn.has(ep.episode)) continue;
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
     * @param {Set<number>} [drawn] Episodes shown as rows by another surface.
     * @returns {HTMLElement|null} Banner.
     */
    function buildBanner(status, drawn) {
        const { missing, other } = bannerEntries(status, drawn);
        if (!missing.length && !other.length) return null;
        const S = JE.arrStatus;
        const banner = S.el('div', 'je-arr-banner');
        banner.dataset.jeArrKey = status.key || '';
        banner.setAttribute('role', 'status');
        banner.appendChild(S.icon('playlist_remove', 'je-arr-banner-icon'));
        const body = S.el('div', 'je-arr-banner-body');
        if (missing.length) {
            // Episodes another copy the viewer can open plays are this copy's gaps: listed as such, never as the title's.
            const plain = missing.filter(ep => !ep.copyGap);
            const gaps = missing.filter(ep => ep.copyGap);
            if (plain.length) body.appendChild(S.el('span', 'je-arr-banner-title', S.tr('arr_banner_missing', { list: plain.map(ep => `E${ep.episode}`).join(', ') })));
            if (gaps.length) {
                const list = gaps.map(ep => `E${ep.episode}`).join(', ');
                body.appendChild(S.el('span', 'je-arr-banner-title je-arr-banner-copy', S.tr('arr_banner_missing_in_copy', { copy: S.copyPhrase(gaps[0].copyGap), list })));
            }
        } else {
            body.appendChild(S.el('span', 'je-arr-banner-title', S.tr('arr_banner_not_yet')));
        }
        for (const ep of other) {
            const chip = buildChip(ep);
            chip.textContent = `E${ep.episode} · ${chip.textContent}`;
            body.appendChild(chip);
        }
        banner.appendChild(body);
        // What this banner says on its own: phase-3 controls added to it later don't count as a change.
        banner.dataset.jeArrBase = banner.textContent;
        return banner;
    }

    /**
     * One episode chip.
     * @param {Object} ep Episode status.
     * @returns {HTMLElement} Chip.
     */
    function buildChip(ep) {
        const S = JE.arrStatus;
        const override = extension?.chip ? extension.chip(ep) : null;
        const tone = override?.tone || (ep.attention ? 'attention' : ep.stage);
        const chip = S.el('span', `je-arr-chip je-arr-tone-${tone}`, override?.text || S.chipText(ep));
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
            // D95: an episode that is ready shows nothing from JE (a better copy on its way still says so).
            if (!ep || (ep.stage === 'ready' && ep.reason?.code === 'ready')) {
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
        // A season without any episode row of Jellyfin's own still has its (empty) list once
        // jellyfin-web has rendered the season's children.
        const list = firstRow ? firstRow.closest('.itemsContainer') : page.querySelector('#listChildrenCollapsible:not(.hide) .itemsContainer');
        const drawn = extension?.drawn ? extension.drawn(status, { page, list }) : null;
        const old = page.querySelector('.je-arr-banner');
        const banner = buildBanner(status, drawn);
        let shownBanner = old;
        if (!banner) {
            if (old) old.remove();
            shownBanner = null;
        } else if (!old || old.dataset.jeArrBase !== banner.dataset.jeArrBase) {
            if (old) old.remove();
            shownBanner = banner;
            if (list && list.parentNode) list.parentNode.insertBefore(banner, list);
            else {
                const anchor = JE.internals?.arrStatusDetails?.anchorOf(page);
                if (anchor) anchor.appendChild(banner);
                else shownBanner = null;
            }
        }
        if (extension?.decorate) extension.decorate(page, status, state.ctx, { banner: shownBanner, list, drawn });
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
            if (extension?.clear) extension.clear(state.page);
        }
        state = null;
    }

    /**
     * Plugs a phase-3 extension in (one at a time).
     * @param {{chip?: Function, drawn?: Function, decorate?: Function, clear?: Function}|null} ext Extension.
     * @returns {void}
     */
    function extend(ext) {
        extension = ext || null;
    }

    /**
     * The season page shown now ({page, status, ctx}) or null.
     * @returns {Object|null} State.
     */
    function current() {
        return state;
    }

    JE.session?.onUserChange?.('arr-status-episodes', clear);

    JE.internals = JE.internals || {};
    JE.internals.arrStatusEpisodes = { render, clear, apply, bannerEntries, extend, current };
})(window.JellyfinEnhanced);
