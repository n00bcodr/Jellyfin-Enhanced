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


    /** The season page shown now: { page, status, ctx, access, season } (season: what the page learnt, see owner()). */
    let state = null;
    let observer = null;
    /** True while apply() runs again in its own pass. */
    let reapplying = false;
    /** The polite live region that says which episode a moved focus landed on. */
    let liveRegion = null;
    /** A native missing episode's mark (Jellyfin's "Missing" / "Unaired"). */
    const MISSING = '.missingIndicator, .unairedIndicator, .virtualEpisodeIndicator';
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
     * A library id as one form (no dashes, lower case).
     * @param {string} id Id.
     * @returns {string} Normalised id.
     */
    function norm(id) {
        return String(id || '').replace(/-/g, '').toLowerCase();
    }

    /**
     * True when a status names the episode playable.
     * @param {Object} ep Episode status.
     * @returns {boolean} Ready.
     */
    function isReady(ep) {
        return ep?.stage === 'ready' && ep.reason?.code === 'ready';
    }


    /**
     * What one open concrete season learnt from the person's reads, under one access revision: everything lives here and
     * goes with it (another season or page, leaving it, a user switch, their access moving).
     * - placeholders: the missing items the status named for episodes not playable yet (normalised id → episode numbers);
     * - playable: ids the status named as playable (never a placeholder);
     * - missingItems / orphans / seeded: rows no status named, looked up once in the season's list (missing items of this
     *   season; missing items Jellyfin no longer lists; ids already looked up);
     * - items: the playable items' own answers, read as the viewer (a row is pointed at an item only with its answer);
     * - denied: items Jellyfin refused the viewer; failed: items whose read failed since the last status read;
     * - pending: item reads in flight; rowsByEpisode: the rows bound on the last pass; before: what a row JE pointed at an
     *   item showed before (to undo it).
     * @param {HTMLElement} page Season page.
     * @param {string} itemId The season's item id.
     * @returns {Object} Owner.
     */
    function owner(page, itemId) {
        return {
            page, itemId: norm(itemId), placeholders: new Map(), playable: new Set(), missingItems: new Set(), orphans: new Set(),
            seeded: new Set(), items: new Map(), denied: new Set(), failed: new Set(), pending: new Map(), rowsByEpisode: new Map(),
            before: new WeakMap(),
        };
    }

    /**
     * Ends what a season owner did to its page: rows JE pointed at playable items go back to their missing items and
     * JE's own arrival rows go. Its reads still in flight answer nothing (they belong to it).
     * @param {Object|null} season Owner.
     * @returns {void}
     */
    function dispose(season) {
        if (!season) return;
        season.page.querySelectorAll('.listItem[data-je-arr-was]').forEach(row => unpoint(season, row));
        season.page.querySelectorAll('.listItem[data-je-arr-arrival]').forEach(row => row.remove());
    }

    /**
     * True when the page's status was read under the person's access as it is now: only then does it point, remove or
     * teach anything. A status read before their access moved (or while it moved) is not.
     * @returns {boolean} Trusted.
     */
    function trusted() {
        return !!state && state.access === accessNow();
    }

    /**
     * Records which library item stands for which episode in a status read: playable items, and the missing items
     * of episodes not playable yet (their latest numbers).
     * @param {Object} season Owner.
     * @param {Object} status Season status.
     * @returns {void}
     */
    function learn(season, status) {
        const now = new Map();
        for (const ep of status.episodes || []) {
            if (!ep.row || !ep.itemId) continue;
            const id = norm(ep.itemId);
            if (ep.stage === 'ready') {
                season.playable.add(id);
                season.placeholders.delete(id);
            } else if (!season.playable.has(id)) {
                if (!now.has(id)) now.set(id, new Set());
                now.get(id).add(ep.episode);
            }
        }
        for (const [id, episodes] of now) season.placeholders.set(id, episodes);
    }

    /**
     * The status entry a row stands for: its item named now; else the episode its missing item stood for, or the
     * episode this very row showed on the last pass. Never an episode whose item has a row of its own on the page.
     * @param {Element} row Row.
     * @param {string} id Row's normalised id.
     * @param {{byId: Map<string, Object>, byEpisode: Map<number, Object>, byRow: Map<Element, Object>, live: Set<string>}} index Status and page.
     * @returns {Object|undefined} Episode status.
     */
    function entryOf(row, id, index) {
        const season = state.season;
        const named = index.byId.get(id);
        if (named) return named;
        const episodes = !season.playable.has(id) && season.placeholders.get(id);
        const ep = (episodes && [...episodes].sort((a, b) => a - b).map(n => index.byEpisode.get(n)).find(Boolean)) || index.byRow.get(row);
        return ep && !(ep.itemId && index.live.has(norm(ep.itemId))) ? ep : undefined;
    }

    /**
     * True when a row is an episode's missing item that a playable item replaces: its status named it for the episode
     * (or Jellyfin listed it as missing), and it still is one (Jellyfin's missing mark, or JE retargeted it).
     * @param {Element} row Row.
     * @param {string} id Row's normalised id.
     * @returns {boolean} A missing item's row.
     */
    function missingRow(row, id) {
        const season = state.season;
        if (season.playable.has(id) || !season.placeholders.has(id)) return false;
        return season.missingItems.has(id) || !!row.querySelector(MISSING);
    }

    /**
     * One row per episode: each playable item keeps one row at the place of the first row standing for its episodes
     * (its missing item's, as Jellyfin drew the season). A native row of the playable item is kept with its own
     * controls and moved there; the missing item's row and JE's own rows for it go. Without a native row, the missing
     * item's row is the one kept (pointed at the playable item once its answer is read). Rows of missing items Jellyfin
     * no longer lists go too.
     * @param {Element[]} rows Season rows in page order.
     * @param {Object} status Season status.
     * @returns {Element[]} The rows left.
     */
    function reconcile(rows, status) {
        const season = state.season;
        const covers = new Map();
        const target = new Map();
        for (const ep of status.episodes || []) {
            if (!ep.row || !ep.itemId || !isReady(ep) || season.denied.has(norm(ep.itemId))) continue;
            const id = norm(ep.itemId);
            if (!covers.has(id)) covers.set(id, new Set());
            covers.get(id).add(ep.episode);
            if (!target.has(ep.episode)) target.set(ep.episode, id);
        }
        const gone = [];
        const groups = new Map();
        const join = (id, row) => {
            if (!groups.has(id)) groups.set(id, []);
            groups.get(id).push(row);
        };
        for (const row of rows) {
            const id = norm(row.getAttribute('data-id'));
            if (covers.has(id)) {
                join(id, row);
                continue;
            }
            if (season.orphans.has(id) && row.querySelector(MISSING)) {
                gone.push(row);
                continue;
            }
            if (!covers.size || !missingRow(row, id)) continue;
            for (const n of season.placeholders.get(id)) {
                if (target.has(n)) {
                    join(target.get(n), row);
                    break;
                }
            }
        }
        const removed = new Set(gone);
        for (const [id, group] of groups) {
            if (group.length < 2) continue;
            const own = row => !!(row.dataset.jeArrWas || row.dataset.jeArrArrival);
            const named = group.filter(row => norm(row.getAttribute('data-id')) === id);
            // A missing row stays only while no row of the item is drawn (it is pointed at the item once its answer is read).
            const keeper = named.find(row => !own(row)) || named.find(row => row.dataset.jeArrWas) || named[0];
            if (!keeper) continue;
            const extra = group.filter(row => row !== keeper && (norm(row.getAttribute('data-id')) !== id || own(row)));
            if (!extra.length) continue;
            extra.forEach(row => removed.add(row));
            const anchor = group[0];
            if (anchor !== keeper && removed.has(anchor) && anchor.parentNode) {
                let between = anchor.nextElementSibling;
                while (between && between !== keeper && removed.has(between)) between = between.nextElementSibling;
                if (between !== keeper) {
                    const focused = keeper.contains(document.activeElement) ? document.activeElement : null;
                    anchor.parentNode.insertBefore(keeper, anchor);
                    if (focused?.isConnected) focused.focus({ preventScroll: true });
                }
            }
            const focused = extra.find(row => row.contains(document.activeElement)) ? document.activeElement : null;
            if (focused) {
                // The viewer was on the row that goes: their focus moves to the episode's row that stays first.
                focusable(keeper, focused).focus({ preventScroll: true });
                announce(JE.arrStatus.tr('arr_episode_row_ready', { episode: Math.min(...covers.get(id)) }));
            }
        }
        if (!removed.size) return rows;
        removed.forEach(row => row.remove());
        return rows.filter(row => !removed.has(row));
    }

    /**
     * The control of a row that stays to move the viewer's focus to: the same kind of control as the one they were on,
     * else the row's first control, else the row itself (made focusable from script only).
     * @param {Element} row Row that stays.
     * @param {Element} from Focused element in the row that goes.
     * @returns {HTMLElement} Focus target.
     */
    function focusable(row, from) {
        const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
        if (row.matches(FOCUSABLE)) return row;
        const controls = [...row.querySelectorAll(FOCUSABLE)];
        const kind = el => [el.tagName, el.className, el.getAttribute('data-action'), el.getAttribute('is')].join('|');
        const same = controls.find(el => kind(el) === kind(from));
        if (same || controls[0]) return same || controls[0];
        row.setAttribute('tabindex', '-1');
        return row;
    }

    /**
     * Reads a line out to screen readers through one visually hidden polite live region (the request sheet's
     * pattern): cleared, then set a moment later, so the same words twice are read twice.
     * @param {string} text Plain text.
     * @returns {void}
     */
    function announce(text) {
        if (!text || !document.body) return;
        if (!liveRegion || !liveRegion.isConnected) {
            liveRegion = document.createElement('div');
            liveRegion.className = 'je-arr-episodes-live';
            liveRegion.setAttribute('role', 'status');
            liveRegion.setAttribute('aria-live', 'polite');
            liveRegion.setAttribute('aria-atomic', 'true');
            Object.assign(liveRegion.style, {
                position: 'absolute', width: '1px', height: '1px', margin: '-1px', padding: '0', border: '0',
                overflow: 'hidden', clip: 'rect(0 0 0 0)', clipPath: 'inset(50%)', whiteSpace: 'nowrap'
            });
            document.body.appendChild(liveRegion);
        }
        const region = liveRegion;
        region.textContent = '';
        setTimeout(() => { region.textContent = String(text); }, 50);
    }


    /**
     * True when an element the host added holds a row of a missing item whose episode plays under another item now
     * (Jellyfin's list drawn while it still listed both), or of a missing item it no longer lists.
     * @param {Element} node Added element.
     * @param {Map<number, string>} ready Each ready episode's item (normalised).
     * @returns {boolean} A replaced row.
     */
    function replaced(node, ready) {
        const season = state.season;
        const rows = node.matches('.listItem[data-id]') ? [node] : node.querySelectorAll('.listItem[data-id]');
        for (const row of rows) {
            const id = norm(row.getAttribute('data-id'));
            if (season.orphans.has(id)) return true;
            const slot = !season.playable.has(id) && season.placeholders.get(id);
            if (slot && [...slot].some(n => ready.has(n) && ready.get(n) !== id)) return true;
        }
        return false;
    }

    /**
     * Reads the season's episode list once for rows of missing items no status named (a page drawn while Jellyfin
     * listed a missing item and the file that replaces it): a listed missing item of this season stands for its
     * numbers; one no longer listed is gone, unless an episode not playable yet could be waiting on it. Viewer-authorised
     * list, never titles or positions; its answer belongs to the season owner and access it was asked under.
     * @param {HTMLElement} page Season page.
     * @param {Object} status Season status.
     * @param {string[]} unknown Normalised ids of the unknown missing rows.
     * @returns {void}
     */
    function seed(page, status, unknown) {
        const client = window.ApiClient;
        const season = state.season;
        const seasonId = norm(status.itemId);
        unknown = unknown.filter(id => !season.seeded.has(id));
        if (!unknown.length || !/^[0-9a-f]{32}$/.test(seasonId) || typeof client?.getJSON !== 'function' || typeof client.getUrl !== 'function' || typeof JE.helpers?.getItemCached !== 'function') return;
        unknown.forEach(id => season.seeded.add(id));
        const still = snapshot();
        Promise.resolve().then(() => JE.helpers.getItemCached(status.itemId)).then((item) => {
            if (!item?.SeriesId || norm(item.Id) !== seasonId || !still()) return null;
            // The season's list as jellyfin-web reads it for this page (its Shows/{id}/Episodes read), as the viewer.
            return client.getJSON(client.getUrl(`Shows/${item.SeriesId}/Episodes`, { seasonId: item.Id, userId: client.getCurrentUserId(), EnableImages: false, EnableUserData: false }));
        }).then((result) => {
            if (!Array.isArray(result?.Items) || !still()) return;
            const listed = new Map(result.Items.map(item => [norm(item.Id), item]));
            const live = new Set([...page.querySelectorAll('.listItem[data-id]')].map(row => norm(row.getAttribute('data-id'))));
            // A list that leaves out a playable row the page shows is not this season's list as the page drew it.
            if ((state.status.episodes || []).some(ep => isReady(ep) && ep.itemId && live.has(norm(ep.itemId)) && !listed.has(norm(ep.itemId)))) return;
            const waiting = (state.status.episodes || []).every(ep => !ep.row || !ep.itemId || ep.stage === 'ready' || live.has(norm(ep.itemId)));
            for (const id of unknown) {
                const item = listed.get(id);
                if (item?.LocationType === 'Virtual' && norm(item.SeasonId) === seasonId && Number.isInteger(item.IndexNumber)) {
                    const episodes = new Set();
                    const end = Number.isInteger(item.IndexNumberEnd) && item.IndexNumberEnd >= item.IndexNumber ? Math.min(item.IndexNumberEnd, item.IndexNumber + 200) : item.IndexNumber;
                    for (let n = item.IndexNumber; n <= end; n++) episodes.add(n);
                    if (!season.placeholders.has(id) && !season.playable.has(id)) season.placeholders.set(id, episodes);
                    season.missingItems.add(id);
                } else if (!item && waiting) {
                    season.orphans.add(id);
                }
            }
            apply();
        }).catch(() => { /* the host's next view lists the season afresh */ });
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
            if (ep.row && ep.itemId) byId.set(norm(ep.itemId), ep);
        }
        const byEpisode = new Map((status.episodes || []).map(ep => [ep.episode, ep]));
        // A status from before the person's access moved neither points nor removes rows: it is being read again.
        const season = state.season;
        const all = [...page.querySelectorAll('.listItem[data-id]')];
        const rows = trusted() ? reconcile(all, status) : all;
        const byRow = new Map([...season.rowsByEpisode].filter(([n]) => byEpisode.has(n)).map(([n, row]) => [row, byEpisode.get(n)]));
        const index = { byId, byEpisode, byRow, live: new Set(rows.map(row => norm(row.getAttribute('data-id')))) };
        season.rowsByEpisode = new Map();
        const unknown = [];
        let firstRow = null;
        let pointed = false;
        // All geometry reads happen before the first row write. Existing chips retain their host.
        const writes = [];
        rows.forEach(row => {
            const id = norm(row.getAttribute('data-id'));
            const ep = entryOf(row, id, index);
            if (ep) season.rowsByEpisode.set(ep.episode, row);
            else if (!season.playable.has(id) && !season.orphans.has(id) && row.querySelector(MISSING)) unknown.push(id);
            if (!firstRow && row.getAttribute('data-type') === 'Episode') firstRow = row;
            const existing = row.querySelector('.je-arr-chip');
            const ready = ep?.stage === 'ready' && ep.reason?.code === 'ready';
            if (ready && trusted()) writes.push(() => { if (patchReady(row, ep, index.live)) pointed = true; });
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
        // Rows just pointed at a playable item: a second missing row of the same item (a file covering several episodes)
        // goes in this same pass.
        if (pointed && !reapplying) {
            reapplying = true;
            try {
                apply();
            } finally {
                reapplying = false;
            }
            return;
        }
        if (unknown.length && trusted() && (status.episodes || []).some(ep => ep.row && isReady(ep))) seed(page, status, unknown);
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
     * Points a missing episode's row at its accepted playable item, as one step: only once that item's own answer has
     * been read as the viewer under the season owner and access this status belongs to (read()). Until then, or when
     * the read fails or is refused, the row stays exactly as Jellyfin drew it. Pointing keeps the row, its links and
     * controls under the viewer's finger and draws the item's title, overview and still on it.
     * @param {Element} row Native row.
     * @param {Object} ep Accepted episode availability.
     * @param {Set<string>} live Ids the page's rows have (a row pointed here is added).
     * @returns {boolean} True when the row was pointed now.
     */
    function patchReady(row, ep, live) {
        const season = state.season;
        const id = norm(ep.itemId);
        if (!ep.itemId || season.denied.has(id)) return false;
        const prior = row.getAttribute('data-id');
        if (norm(prior) === id) {
            if (row.dataset.jeArrWas && season.items.has(id)) paint(row, ep, season.items.get(id));
            return false;
        }
        const item = season.items.get(id);
        if (!item) {
            read(ep);
            return false;
        }
        // Another row has the item already (pointed earlier in this pass): this one is a duplicate, reconciled away.
        if (live.has(id)) return false;
        live.add(id);
        const marks = [...row.querySelectorAll('.missingIndicator, .virtualEpisodeIndicator')];
        // What it showed is kept to undo it (the person's access moves, the season is left).
        if (!season.before.has(row)) season.before.set(row, { id: prior, marks: marks.map(node => ({ node, parent: node.parentNode, next: node.nextSibling })), content: content(row) });
        row.setAttribute('data-id', ep.itemId);
        row.dataset.jeArrWas = prior;
        retarget(row, prior, ep.itemId);
        marks.forEach(node => node.remove());
        paint(row, ep, item);
        return true;
    }

    /**
     * Reads a ready episode's playable item as the viewer, once per season owner (again after a failure only with the
     * next status read). The answer is used only under the owner, access and trust it was asked under, and only while
     * the status still names that item ready: then the rows are pointed at it. A refusal (401/403/404) means no row is
     * pointed at it on this visit; any other failure leaves the rows as they are.
     * @param {Object} ep Accepted availability.
     * @returns {void}
     */
    function read(ep) {
        const season = state.season;
        const id = norm(ep.itemId);
        if (season.pending.has(id) || season.failed.has(id) || season.denied.has(id) || typeof JE.helpers?.getItemCached !== 'function') return;
        const still = snapshot();
        const answer = Promise.resolve().then(() => JE.helpers.getItemCached(ep.itemId, { forceRefresh: true }));
        season.pending.set(id, answer);
        answer.then(item => {
            if (!still()) return;
            if (!item || norm(item.Id) !== id) {
                season.failed.add(id);
                return;
            }
            if (!stillReady(ep)) return;
            season.items.set(id, item);
            apply();
        }, err => {
            if (!still()) return;
            ([401, 403, 404].includes(err?.status) ? season.denied : season.failed).add(id);
        }).finally(() => {
            if (season.pending.get(id) === answer) season.pending.delete(id);
        });
    }

    /**
     * Points a row's own ids and links from one item to another.
     * @param {Element} row Row.
     * @param {string} from Item id now.
     * @param {string} to Item id to point at.
     * @returns {void}
     */
    function retarget(row, from, to) {
        row.querySelectorAll('[data-id], a[href]').forEach(node => {
            if (node.getAttribute('data-id') === from) node.setAttribute('data-id', to);
            const href = node.getAttribute('href');
            if (href && from && href.includes(from)) node.setAttribute('href', href.replace(from, to));
        });
    }

    /**
     * The parts of a row the playable item's answer redraws: title, overviews and still.
     * @param {Element} row Row.
     * @returns {{name: Element|null, text: string|null, overviews: Array, image: Element|null, still: string, src: string|null}} Parts.
     */
    function content(row) {
        const title = row.querySelector('.listItemBody .listItemBodyText:not(.secondary):not(.listItem-overview)');
        const name = title && (title.querySelector('bdi') || title);
        const image = row.querySelector('.listItemImage');
        return {
            name: name && !name.children.length ? name : null, text: name ? name.textContent : null,
            overviews: [...row.querySelectorAll('.listItem-overview, .listItem-bottomoverview')].map(node => {
                const text = node.querySelector('bdi') || node;
                return { node, parent: node.parentNode, next: node.nextSibling, text: text.children.length ? null : text, value: text.textContent };
            }),
            image, still: image ? image.style.backgroundImage : '', src: image ? image.getAttribute('data-src') : null,
        };
    }


    /**
     * Undoes JE's pointing of a row at a playable item: its missing item's id, links, marks, title, overview and still.
     * @param {Object} season Owner that pointed it.
     * @param {Element} row Row JE pointed.
     * @returns {void}
     */
    function unpoint(season, row) {
        const was = season.before.get(row);
        const now = row.getAttribute('data-id');
        if (!was) return;
        season.before.delete(row);
        delete row.dataset.jeArrWas;
        row.setAttribute('data-id', was.id);
        retarget(row, now, was.id);
        const { name, text, overviews, image, still, src } = was.content;
        if (name && text != null) name.textContent = text;
        for (const o of overviews) {
            if (!o.node.isConnected && o.parent.isConnected) o.parent.insertBefore(o.node, o.next?.parentNode === o.parent ? o.next : null);
            if (o.text) o.text.textContent = o.value;
        }
        if (image) {
            image.style.backgroundImage = still;
            if (src != null) image.setAttribute('data-src', src);
        }
        for (const m of was.marks) if (!m.node.isConnected && m.parent.isConnected) m.parent.insertBefore(m.node, m.next?.parentNode === m.parent ? m.next : null);
    }

    /**
     * What an asynchronous read must still find to use its answer: the same season owner on the same page shown on the
     * same route, session, user and server, under the same access revision, with a trusted status.
     * @returns {function(): boolean} True while the read's answer may be used.
     */
    function snapshot() {
        const season = state?.season;
        const page = state?.page;
        const epoch = JE.session?.getEpoch?.();
        const user = window.ApiClient?.getCurrentUserId?.();
        const server = window.ApiClient?.serverId?.();
        const route = window.location.hash;
        const access = state?.access;
        return () => !!season && state?.season === season && page.isConnected && !page.classList.contains('hide') && window.location.hash === route
            && epoch === JE.session?.getEpoch?.() && user === window.ApiClient?.getCurrentUserId?.() && server === window.ApiClient?.serverId?.()
            && state.access === access && trusted();
    }

    /**
     * The signed-in person's access revision as JE last saw it (core/access-revision.js), or null.
     * @returns {string|null} Revision.
     */
    function accessNow() {
        try {
            return JE.core?.revision?.access?.() ?? null;
        } catch {
            return null;
        }
    }


    /**
     * The status entry of an episode while it still names the item ready.
     * @param {Object} ep Accepted availability.
     * @returns {boolean} Still ready with that item.
     */
    function stillReady(ep) {
        const current = state?.status.episodes?.find(e => e.episode === ep.episode);
        return current?.stage === 'ready' && norm(current.itemId) === norm(ep.itemId);
    }

    /**
     * Draws a playable item's answer (title, overview, still) on a row JE pointed at it. Spoiler Guard's series keep
     * what the page drew until Jellyfin's next view.
     * @param {Element} row Pointed row.
     * @param {Object} ep Accepted availability.
     * @param {Object} item The item's answer, read as the viewer.
     * @returns {void}
     */
    function paint(row, ep, item) {
        if (JE.spoilerBlur?.isEnabledFor?.(item.SeriesId)) return;
        const { name, overviews, image } = content(row);
        if (name && item.Name) {
            const number = /^\s*\d+(?:\s*-\s*\d+)?\.\s*/.exec(name.textContent);
            const text = (number ? number[0] : '') + item.Name;
            if (name.textContent !== text) name.textContent = text;
        }
        for (const o of overviews) {
            if (!o.text) continue;
            if (!item.Overview) o.node.remove();
            else if (o.text.textContent !== item.Overview) o.text.textContent = item.Overview;
        }
        if (image && item.ImageTags?.Primary && window.ApiClient?.getImageUrl) {
            const still = `url("${window.ApiClient.getImageUrl(ep.itemId, { type: 'Primary', tag: item.ImageTags.Primary, maxWidth: 400 })}")`;
            image.removeAttribute('data-src');
            if (image.style.backgroundImage !== still) image.style.backgroundImage = still;
        }
    }

    /**
     * Adds an episode that had no native row, using viewer-authorized native metadata read under the season owner and
     * access of this status. Existing rows and their event targets are retained; a late answer cannot decorate a
     * departed view.
     * @param {HTMLElement} page Season page.
     * @param {Object[]} arrivals Newly playable episodes.
     * @returns {void}
     */
    function addArrivals(page, arrivals) {
        const season = state.season;
        const still = snapshot();
        for (const ep of arrivals) {
            const id = norm(ep.itemId);
            if (!ep.itemId || season.pending.has(id) || season.denied.has(id) || page.querySelector(`.listItem[data-id="${ep.itemId}"]`)) continue;
            if (typeof JE.helpers?.getItemCached !== 'function') continue;
            const answer = Promise.resolve().then(() => JE.helpers.getItemCached(ep.itemId, { forceRefresh: true }));
            season.pending.set(id, answer);
            answer.then(item => {
                if (!item || norm(item.Id) !== id || !still()) return;
                season.items.set(id, item);
                if (!stillReady(ep) || page.querySelector(`.listItem[data-id="${ep.itemId}"]`)) return;
                const list = page.querySelector('#listChildrenCollapsible .itemsContainer, .itemsContainer');
                if (!list) return;
                const row = arrivalRow(item, ep);
                const after = [...season.rowsByEpisode].filter(([n, r]) => n > ep.episode && r.parentNode === list).sort((a, b) => a[0] - b[0])[0]?.[1];
                list.insertBefore(row, after || null);
                season.rowsByEpisode.set(ep.episode, row);
            }, err => {
                if (still() && [401, 403, 404].includes(err?.status)) season.denied.add(id);
            }).finally(() => {
                if (season.pending.get(id) === answer) season.pending.delete(id);
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
     * Shows a season's episode states on its page (and keeps them on while rows render). A status is used only when it
     * was read under the person's access as it is now (`ctx.access`, stamped by the status read; a status without a
     * stamp counts as read now): an older one points, removes and teaches nothing.
     * @param {HTMLElement} page Season details page.
     * @param {Object} status Season status with episodes.
     * @param {Object} ctx Response context.
     * @returns {void}
     */
    function render(page, status, ctx) {
        // The same concrete season shown on the same page: another season (or page) starts from nothing.
        const same = state?.page === page && state.season.itemId === norm(status.itemId);
        const previous = same ? new Map((state.status.episodes || []).map(ep => [ep.episode, ep])) : null;
        if (!same) {
            dispose(state?.season);
            state = { page, season: owner(page, status.itemId) };
        }
        state.status = status;
        state.ctx = ctx;
        state.access = ctx && Object.prototype.hasOwnProperty.call(ctx, 'access') ? ctx.access : accessNow();
        if (trusted()) {
            // A failed item read is tried again once per status read.
            state.season.failed.clear();
            learn(state.season, status);
        }
        apply();
        if (previous && trusted()) addArrivals(page, (status.episodes || []).filter(ep => ep.row && ep.stage === 'ready'
            && previous.has(ep.episode) && (previous.get(ep.episode).stage !== 'ready' || previous.get(ep.episode).itemId !== ep.itemId)));
        if (!observer && JE.helpers?.onBodyMutation) {
            const schedule = JE.helpers.debounce ? JE.helpers.debounce(apply, 80) : apply;
            // Heard before the frame is painted: a redraw that brings back a row an arrival replaced is put right in it.
            observer = JE.helpers.onBodyMutation('arr-status-episodes', (mutations) => {
                if (!state || state.page.classList.contains('hide')) return;
                let added = false;
                let ready = null;
                for (const m of mutations) {
                    if (!state.page.contains(m.target)) continue;
                    for (const node of m.addedNodes || []) {
                        if (node.nodeType !== 1 || node.hasAttribute('data-je-arr-arrival') || !(node.matches('.listItem[data-id]') || node.querySelector('.listItem[data-id]'))) continue;
                        if (!ready) {
                            ready = new Map();
                            for (const ep of state.status.episodes || []) if (ep.itemId && isReady(ep) && !ready.has(ep.episode)) ready.set(ep.episode, norm(ep.itemId));
                        }
                        if (trusted() && replaced(node, ready)) {
                            apply();
                            return;
                        }
                        added = true;
                    }
                }
                if (added) schedule();
            }, { priority: 1 });
        }
    }

    /**
     * The person's access moved (a library or parental limit changed): the season owner goes (rows JE pointed at
     * playable items go back to their missing items, JE's own arrival rows go, its reads still in flight answer
     * nothing), a new one starts empty, and the status is read again. Until a status read under the new access renders,
     * nothing is pointed, removed or learnt.
     * @returns {void}
     */
    function onAccessRevision() {
        if (!state) return;
        dispose(state.season);
        state.season = owner(state.page, state.season.itemId);
        // The status shown was read under the access that moved: it is not trusted again, whatever it carries.
        state.access = {};
        JE.internals?.arrStatusDetails?.update?.(true);
    }

    /**
     * Jellyfin removed items (LibraryChanged): when one is a row of the season shown (an episode's missing item), its
     * rows are reconciled now. A missing item whose episode is not playable yet keeps its row until the playable item
     * replaces it.
     * @param {string[]} ids Removed item ids.
     * @returns {boolean} True when the season shown had a row for one of them.
     */
    function removed(ids) {
        if (!state || !Array.isArray(ids) || !ids.length || !state.page.isConnected || state.page.classList.contains('hide')) return false;
        const season = state.season;
        const known = ids.map(norm).filter(id => season.placeholders.has(id) || season.missingItems.has(id));
        if (!known.length) return false;
        apply();
        return true;
    }

    /**
     * Removes chips and banner and stops following the season (leaving it, another kind of page, a user switch): the
     * season owner goes with what it did to the page.
     * @returns {void}
     */
    function clear() {
        if (state?.page) {
            state.page.querySelectorAll('.je-arr-chip-row, .je-arr-chip').forEach(n => n.remove());
            state.page.querySelectorAll('.je-arr-banner').forEach(n => n.remove());
            if (extension?.clear) extension.clear(state.page);
        }
        dispose(state?.season);
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
    document.addEventListener('je-access-revision', onAccessRevision);

    JE.internals = JE.internals || {};
    JE.internals.arrStatusEpisodes = { render, clear, apply, bannerEntries, extend, current, removed };
})(window.JellyfinEnhanced);
