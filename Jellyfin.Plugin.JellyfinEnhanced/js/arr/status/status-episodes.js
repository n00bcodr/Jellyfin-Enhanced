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
    /** Native rows retained when Jellyfin replaces a missing episode's library id. */
    let rowsByEpisode = new Map();
    /** Read each newly playable item once while its native row is being prepared. */
    const pendingRows = new Map();
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
        const byRow = new Map((status.episodes || []).map(ep => [rowsByEpisode.get(ep.episode), ep]));
        let firstRow = null;
        // All geometry reads happen before the first row write. Existing chips retain their host.
        const writes = [];
        page.querySelectorAll('.listItem[data-id]').forEach(row => {
            const id = (row.getAttribute('data-id') || '').replace(/-/g, '').toLowerCase();
            const ep = byId.get(id) || byRow.get(row);
            if (ep) rowsByEpisode.set(ep.episode, row);
            if (!firstRow && row.getAttribute('data-type') === 'Episode') firstRow = row;
            const existing = row.querySelector('.je-arr-chip');
            const ready = ep?.stage === 'ready' && ep.reason?.code === 'ready';
            if (ready) writes.push(() => patchReady(row, ep));
            if (!ep || ready) {
                if (existing) writes.push(() => remove(existing));
                return;
            }
            const override = extension?.chip ? extension.chip(ep) : null;
            const text = override?.text || JE.arrStatus.chipText(ep);
            const className = `je-arr-chip je-arr-tone-${override?.tone || (ep.attention ? 'attention' : ep.stage)}`;
            if (existing) {
                if (existing.textContent !== text || existing.className.replace(' je-arr-chip-overlay', '') !== className) {
                    writes.push(() => {
                        existing.textContent = text;
                        existing.className = className + (existing.classList.contains('je-arr-chip-overlay') ? ' je-arr-chip-overlay' : '');
                    });
                }
                return;
            }
            const line = row.querySelector('.listItemMediaInfo') || row.querySelector('.listItemBody');
            const below = row.querySelector('.listItem-bottomoverview');
            const image = row.querySelector('.listItemImage');
            const inline = line && (shown(line, row) || (!below && !image));
            writes.push(() => {
                const chip = JE.arrStatus.el('span', className, text);
                if (inline) line.appendChild(chip);
                else if (below) {
                    const holder = document.createElement('div');
                    holder.className = 'je-arr-chip-row';
                    holder.appendChild(chip);
                    below.parentNode.insertBefore(holder, below);
                } else if (image) {
                    chip.classList.add('je-arr-chip-overlay');
                    image.appendChild(chip);
                }
            });
        });
        for (const write of writes) write();
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
     * Makes an existing native episode row point at its accepted playable library item.
     * Links and the row stay under the viewer's finger even when Jellyfin changed the item id.
     * @param {Element} row Native row.
     * @param {Object} ep Accepted episode availability.
     * @returns {void}
     */
    function patchReady(row, ep) {
        const prior = row.getAttribute('data-id');
        if (ep.itemId && prior !== ep.itemId) {
            row.setAttribute('data-id', ep.itemId);
            row.querySelectorAll('[data-id], a[href]').forEach(node => {
                if (node.getAttribute('data-id') === prior) node.setAttribute('data-id', ep.itemId);
                const href = node.getAttribute('href');
                if (href && prior && href.includes(prior)) node.setAttribute('href', href.replace(prior, ep.itemId));
            });
        }
        row.querySelectorAll('.missingIndicator, .virtualEpisodeIndicator').forEach(node => node.remove());
    }

    /**
     * Adds an episode that had no native row, using viewer-authorized native metadata.
     * Existing rows and their event targets are retained; a late answer cannot decorate a departed view.
     * @param {HTMLElement} page Season page.
     * @param {Object[]} arrivals Newly playable episodes.
     * @returns {void}
     */
    function addArrivals(page, arrivals) {
        const epoch = JE.session?.getEpoch?.();
        const user = window.ApiClient?.getCurrentUserId?.();
        const server = window.ApiClient?.serverId?.();
        const route = window.location.hash;
        for (const ep of arrivals) {
            if (!ep.itemId || pendingRows.has(ep.itemId) || page.querySelector(`.listItem[data-id="${ep.itemId}"]`)) continue;
            if (typeof JE.helpers?.getItemCached !== 'function') continue;
            const read = Promise.resolve().then(() => JE.helpers.getItemCached(ep.itemId, { forceRefresh: true }));
            pendingRows.set(ep.itemId, read);
            read.then(item => {
                if (!item || String(item.Id || '').replace(/-/g, '').toLowerCase() !== ep.itemId.replace(/-/g, '').toLowerCase() || state?.page !== page || !page.isConnected || page.classList.contains('hide') || window.location.hash !== route
                    || epoch !== JE.session?.getEpoch?.() || user !== window.ApiClient?.getCurrentUserId?.() || server !== window.ApiClient?.serverId?.()) return;
                const current = state.status.episodes?.find(e => e.episode === ep.episode);
                if (current?.stage !== 'ready' || current.itemId !== ep.itemId || page.querySelector(`.listItem[data-id="${ep.itemId}"]`)) return;
                const list = page.querySelector('#listChildrenCollapsible .itemsContainer, .itemsContainer');
                if (!list) return;
                const row = arrivalRow(item, ep);
                const after = [...rowsByEpisode].filter(([n, r]) => n > ep.episode && r.parentNode === list).sort((a, b) => a[0] - b[0])[0]?.[1];
                list.insertBefore(row, after || null);
                rowsByEpisode.set(ep.episode, row);
            }).catch(() => { /* the host's next view can read a temporarily unavailable item */ }).finally(() => {
                if (pendingRows.get(ep.itemId) === read) pendingRows.delete(ep.itemId);
            });
        }
    }

    /**
     * A native episode link for an arrival the host did not list yet. Native data and safe DOM text
     * provide the title; spoiler preferences withhold the still and overview until the native next view.
     * @param {Object} item Viewer-authorized native episode.
     * @param {Object} ep Accepted availability.
     * @returns {HTMLElement} Episode row.
     */
    function arrivalRow(item, ep) {
        const S = JE.arrStatus;
        const row = S.el('div', 'listItem listItem-largeImage listItem-withContentWrapper');
        row.dataset.id = ep.itemId;
        row.dataset.type = 'Episode';
        row.dataset.action = 'link';
        row.dataset.isfolder = 'false';
        const serverId = window.ApiClient?.serverId?.();
        if (serverId) row.dataset.serverid = serverId;
        row.dataset.jeArrArrival = 'true';
        row.dataset.mediatype = 'Video';
        const content = S.el('div', 'listItem-content');
        const image = S.el('a', 'listItemImage listItemImage-large');
        const link = S.el('a', 'listItemBodyText');
        const params = new URLSearchParams({ id: ep.itemId });
        const server = window.ApiClient?.serverId?.();
        if (server) params.set('serverId', server);
        for (const target of [image, link]) {
            target.href = `#/details?${params}`;
            target.classList.add('itemAction');
            target.dataset.action = 'link';
        }
        link.textContent = `${ep.episode}. ${item.Name || ''}`;
        const spoiler = JE.spoilerBlur?.isEnabledFor?.(item.SeriesId);
        if (!spoiler && item.ImageTags?.Primary && window.ApiClient?.getImageUrl) {
            image.style.backgroundImage = `url("${window.ApiClient.getImageUrl(ep.itemId, { type: 'Primary', tag: item.ImageTags.Primary, maxWidth: 400 })}")`;
        }
        const body = S.el('div', 'listItemBody');
        body.appendChild(link);
        if (!spoiler && item.Overview) body.appendChild(S.el('div', 'secondary listItem-overview listItemBodyText', item.Overview));
        content.append(image, body);
        row.appendChild(content);
        return row;
    }

    /**
     * Shows a season's episode states on its page (and keeps them on while rows render).
     * @param {HTMLElement} page Season details page.
     * @param {Object} status Season status with episodes.
     * @param {Object} ctx Response context.
     * @returns {void}
     */
    function render(page, status, ctx) {
        const previous = state?.page === page ? new Map((state.status.episodes || []).map(ep => [ep.episode, ep])) : null;
        if (state?.page !== page) rowsByEpisode = new Map();
        state = { page, status, ctx };
        apply();
        if (previous) addArrivals(page, (status.episodes || []).filter(ep => ep.row && ep.stage === 'ready'
            && previous.has(ep.episode) && (previous.get(ep.episode).stage !== 'ready' || previous.get(ep.episode).itemId !== ep.itemId)));
        if (!observer && JE.helpers?.onBodyMutation) {
            const schedule = JE.helpers.debounce ? JE.helpers.debounce(apply, 80) : apply;
            observer = JE.helpers.onBodyMutation('arr-status-episodes', (mutations) => {
                if (!state || state.page.classList.contains('hide')) return;
                for (const m of mutations) {
                    if (!state.page.contains(m.target)) continue;
                    if ([...(m.addedNodes || [])].some(node => node.nodeType === 1 && !node.hasAttribute('data-je-arr-arrival') &&
                        (node.matches('.listItem[data-id]') || node.querySelector('.listItem[data-id]')))) {
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
        rowsByEpisode.clear();
        pendingRows.clear();
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
