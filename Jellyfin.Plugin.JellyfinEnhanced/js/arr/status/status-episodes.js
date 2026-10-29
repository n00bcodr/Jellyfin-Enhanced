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
    /** The season list's rows by the episode they show, bound afresh on each pass (never a row Jellyfin replaced). */
    let rowsByEpisode = new Map();
    /**
     * Library ids the page's status named for an episode Jellyfin could not play yet (its missing item), with the
     * episodes each stood for, kept while the season page is open: a row Jellyfin draws again with that id is still
     * that episode's, after the episode's playable item has a different id (normalised id → episode numbers).
     */
    let placeholders = new Map();
    /** Ids the page's status named as playable: never an episode's placeholder. */
    let playable = new Set();
    /** Rows the status never named that the season list gave as missing items of this season. */
    let missingItems = new Set();
    /** Missing rows whose item Jellyfin no longer lists for the viewer, while every pending episode keeps its own row. */
    let orphans = new Set();
    /** Unknown missing rows the season list was read for (each once). */
    let seeded = new Set();
    /** The playable items' own answers read as the viewer, for every row JE points at them (normalised id → item). */
    let hydrated = new Map();
    /** Playable items Jellyfin refused the viewer: no row is pointed at them. */
    let denied = new Set();
    /** Bumped whenever what the page learnt is dropped: an answer read before it is not used. */
    let generation = 0;
    /** The status the page had when the person's access moved: nothing is pointed or removed on its word again. */
    let distrusted = null;
    /** What a row JE pointed at a playable item showed before (its id, marks, title, overview, still), to undo it. */
    const before = new WeakMap();
    /** Read each newly playable item once while its native row is being prepared. */
    const pendingRows = new Map();
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
     * Records which library item stands for which episode in a status read: playable items, and the missing items
     * of episodes not playable yet (their latest numbers).
     * @param {Object} status Season status.
     * @returns {void}
     */
    function learn(status) {
        const now = new Map();
        for (const ep of status.episodes || []) {
            if (!ep.row || !ep.itemId) continue;
            const id = norm(ep.itemId);
            if (ep.stage === 'ready') {
                playable.add(id);
                placeholders.delete(id);
            } else if (!playable.has(id)) {
                if (!now.has(id)) now.set(id, new Set());
                now.get(id).add(ep.episode);
            }
        }
        for (const [id, episodes] of now) placeholders.set(id, episodes);
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
        const named = index.byId.get(id);
        if (named) return named;
        const episodes = !playable.has(id) && placeholders.get(id);
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
        if (playable.has(id) || !placeholders.has(id)) return false;
        return missingItems.has(id) || !!row.querySelector(MISSING);
    }

    /**
     * One row per episode: each playable item keeps one row at the place of the first row standing for its episodes
     * (its missing item's, as Jellyfin drew the season). A native row of the playable item is kept with its own
     * controls and moved there; the missing item's row and JE's own rows for it go. Without a native row, the missing
     * item's row is the one kept (retargeted and refreshed when it is the playable one). Rows of missing items Jellyfin
     * no longer lists go too.
     * @param {Element[]} rows Season rows in page order.
     * @param {Object} status Season status.
     * @returns {Element[]} The rows left.
     */
    function reconcile(rows, status) {
        const covers = new Map();
        const target = new Map();
        for (const ep of status.episodes || []) {
            if (!ep.row || !ep.itemId || !isReady(ep) || denied.has(norm(ep.itemId))) continue;
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
            if (orphans.has(id) && row.querySelector(MISSING)) {
                gone.push(row);
                continue;
            }
            if (!covers.size || !missingRow(row, id)) continue;
            for (const n of placeholders.get(id)) {
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
            const keeper = named.find(row => !own(row)) || named.find(row => row.dataset.jeArrWas) || named[0] || group[0];
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
        const rows = node.matches('.listItem[data-id]') ? [node] : node.querySelectorAll('.listItem[data-id]');
        for (const row of rows) {
            const id = norm(row.getAttribute('data-id'));
            if (orphans.has(id)) return true;
            const slot = !playable.has(id) && placeholders.get(id);
            if (slot && [...slot].some(n => ready.has(n) && ready.get(n) !== id)) return true;
        }
        return false;
    }

    /**
     * Reads the season's episode list once for rows of missing items no status named (a page drawn while Jellyfin
     * listed a missing item and the file that replaces it): a listed missing item of this season stands for its
     * numbers; one no longer listed is gone, unless an episode not playable yet could be waiting on it. Viewer-authorised
     * list, never titles or positions.
     * @param {HTMLElement} page Season page.
     * @param {Object} status Season status.
     * @param {string[]} unknown Normalised ids of the unknown missing rows.
     * @returns {void}
     */
    function seed(page, status, unknown) {
        const client = window.ApiClient;
        const season = norm(status.itemId);
        unknown = unknown.filter(id => !seeded.has(id));
        if (!unknown.length || !state?.trusted || !/^[0-9a-f]{32}$/.test(season) || typeof client?.getJSON !== 'function' || typeof client.getUrl !== 'function' || typeof JE.helpers?.getItemCached !== 'function') return;
        unknown.forEach(id => seeded.add(id));
        const still = snapshot(page);
        Promise.resolve().then(() => JE.helpers.getItemCached(status.itemId)).then((item) => {
            if (!item?.SeriesId || norm(item.Id) !== season || !still()) return null;
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
                if (item?.LocationType === 'Virtual' && norm(item.SeasonId) === season && Number.isInteger(item.IndexNumber)) {
                    const episodes = new Set();
                    const end = Number.isInteger(item.IndexNumberEnd) && item.IndexNumberEnd >= item.IndexNumber ? Math.min(item.IndexNumberEnd, item.IndexNumber + 200) : item.IndexNumber;
                    for (let n = item.IndexNumber; n <= end; n++) episodes.add(n);
                    if (!placeholders.has(id) && !playable.has(id)) placeholders.set(id, episodes);
                    missingItems.add(id);
                } else if (!item && waiting) {
                    orphans.add(id);
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
        const all = [...page.querySelectorAll('.listItem[data-id]')];
        const rows = state.trusted ? reconcile(all, status) : all;
        const byRow = new Map([...rowsByEpisode].filter(([n]) => byEpisode.has(n)).map(([n, row]) => [row, byEpisode.get(n)]));
        const index = { byId, byEpisode, byRow, live: new Set(rows.map(row => norm(row.getAttribute('data-id')))) };
        rowsByEpisode = new Map();
        const unknown = [];
        let firstRow = null;
        // All geometry reads happen before the first row write. Existing chips retain their host.
        const writes = [];
        rows.forEach(row => {
            const id = norm(row.getAttribute('data-id'));
            const ep = entryOf(row, id, index);
            if (ep) rowsByEpisode.set(ep.episode, row);
            else if (!playable.has(id) && !orphans.has(id) && row.querySelector(MISSING)) unknown.push(id);
            if (!firstRow && row.getAttribute('data-type') === 'Episode') firstRow = row;
            const existing = row.querySelector('.je-arr-chip');
            const ready = ep?.stage === 'ready' && ep.reason?.code === 'ready';
            if (ready && state.trusted) writes.push(() => patchReady(row, ep));
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
        if (unknown.length && state.trusted && (status.episodes || []).some(ep => ep.row && isReady(ep))) seed(page, status, unknown);
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
        if (denied.has(norm(ep.itemId))) return;
        const prior = row.getAttribute('data-id');
        const marks = [...row.querySelectorAll('.missingIndicator, .virtualEpisodeIndicator')];
        if (ep.itemId && prior !== ep.itemId) {
            // What it showed is kept to undo it (the person's access moves, Jellyfin refuses them the item).
            if (!before.has(row)) before.set(row, { id: prior, marks: marks.map(node => ({ node, parent: node.parentNode, next: node.nextSibling })), content: content(row) });
            row.setAttribute('data-id', ep.itemId);
            row.dataset.jeArrWas = prior;
            retarget(row, prior, ep.itemId);
            // Still the missing item's title, still and overview: the playable item's are drawn on it (read once).
            hydrate(ep);
        }
        marks.forEach(node => node.remove());
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
     * @param {Element} row Row JE pointed.
     * @returns {void}
     */
    function unpoint(row) {
        const was = before.get(row);
        const now = row.getAttribute('data-id');
        if (!was) return;
        before.delete(row);
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
     * What an asynchronous read must still find to write into the page: the same page shown on the same route, session,
     * user and server.
     * @param {HTMLElement} page Season page.
     * @returns {function(): boolean} True while the read's answer may be used.
     */
    function snapshot(page) {
        const epoch = JE.session?.getEpoch?.();
        const user = window.ApiClient?.getCurrentUserId?.();
        const server = window.ApiClient?.serverId?.();
        const route = window.location.hash;
        const learnt = generation;
        const access = accessNow();
        return () => state?.page === page && page.isConnected && !page.classList.contains('hide') && window.location.hash === route
            && epoch === JE.session?.getEpoch?.() && user === window.ApiClient?.getCurrentUserId?.() && server === window.ApiClient?.serverId?.()
            && learnt === generation && access === accessNow() && !!state.trusted;
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
     * Rows JE pointed at a playable item get that item's title, overview and still, read as the viewer once per page
     * (Spoiler Guard's series keep what the page drew until Jellyfin's next view). Every row pointed at it gets them:
     * the one waiting when the answer comes, and any Jellyfin draws again later (drawn from the answer at once). An
     * item Jellyfin refuses them is never pointed at: rows pointed at it go back to their missing item.
     * @param {Object} ep Accepted availability.
     * @returns {void}
     */
    function hydrate(ep) {
        const page = state?.page;
        const id = norm(ep.itemId);
        if (!page) return;
        if (hydrated.has(id)) {
            paint(page, ep, hydrated.get(id));
            return;
        }
        if (pendingRows.has(ep.itemId) || typeof JE.helpers?.getItemCached !== 'function') return;
        const still = snapshot(page);
        const read = Promise.resolve().then(() => JE.helpers.getItemCached(ep.itemId, { forceRefresh: true }));
        pendingRows.set(ep.itemId, read);
        read.then(item => {
            if (!item || norm(item.Id) !== id || !still() || !stillReady(ep)) return;
            hydrated.set(id, item);
            paint(page, ep, item);
        }, err => {
            if (!still() || ![401, 403, 404].includes(err?.status)) return;
            denied.add(id);
            page.querySelectorAll('.listItem[data-je-arr-was]').forEach(row => { if (norm(row.getAttribute('data-id')) === id) unpoint(row); });
        }).finally(() => {
            if (pendingRows.get(ep.itemId) === read) pendingRows.delete(ep.itemId);
        });
    }

    /**
     * Draws a playable item's answer on every row of the page JE pointed at it.
     * @param {HTMLElement} page Season page.
     * @param {Object} ep Accepted availability.
     * @param {Object} item The item's answer, read as the viewer.
     * @returns {void}
     */
    function paint(page, ep, item) {
        if (JE.spoilerBlur?.isEnabledFor?.(item.SeriesId)) return;
        const id = norm(ep.itemId);
        page.querySelectorAll('.listItem[data-je-arr-was]').forEach(row => {
            if (norm(row.getAttribute('data-id')) !== id) return;
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
                image.removeAttribute('data-src');
                image.style.backgroundImage = `url("${window.ApiClient.getImageUrl(ep.itemId, { type: 'Primary', tag: item.ImageTags.Primary, maxWidth: 400 })}")`;
            }
        });
    }

    /**
     * Adds an episode that had no native row, using viewer-authorized native metadata.
     * Existing rows and their event targets are retained; a late answer cannot decorate a departed view.
     * @param {HTMLElement} page Season page.
     * @param {Object[]} arrivals Newly playable episodes.
     * @returns {void}
     */
    function addArrivals(page, arrivals) {
        const still = snapshot(page);
        for (const ep of arrivals) {
            if (!ep.itemId || pendingRows.has(ep.itemId) || page.querySelector(`.listItem[data-id="${ep.itemId}"]`)) continue;
            if (typeof JE.helpers?.getItemCached !== 'function') continue;
            const read = Promise.resolve().then(() => JE.helpers.getItemCached(ep.itemId, { forceRefresh: true }));
            pendingRows.set(ep.itemId, read);
            read.then(item => {
                if (!item || norm(item.Id) !== norm(ep.itemId) || !still()) return;
                if (!stillReady(ep) || page.querySelector(`.listItem[data-id="${ep.itemId}"]`)) return;
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
        // The same concrete season shown on the same page: another season (or page) starts from nothing.
        const same = state?.page === page && norm(state.status.itemId) === norm(status.itemId);
        const previous = same ? new Map((state.status.episodes || []).map(ep => [ep.episode, ep])) : null;
        const regained = same && !state.trusted;
        if (!same) forget();
        state = { page, status, ctx, trusted: !(same && status === distrusted) };
        if (state.trusted) {
            distrusted = null;
            learn(status);
        }
        apply();
        if (previous && state.trusted) addArrivals(page, (status.episodes || []).filter(ep => ep.row && ep.stage === 'ready'
            && (regained || (previous.has(ep.episode) && (previous.get(ep.episode).stage !== 'ready' || previous.get(ep.episode).itemId !== ep.itemId)))));
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
                        if (state.trusted && replaced(node, ready)) {
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
     * Drops what the page learnt about its rows (another page, or none).
     * @returns {void}
     */
    function forget() {
        generation++;
        rowsByEpisode = new Map();
        placeholders = new Map();
        playable = new Set();
        missingItems = new Set();
        orphans = new Set();
        seeded = new Set();
        hydrated = new Map();
        denied = new Set();
    }

    /**
     * The person's access moved (a library or parental limit changed): what the page learnt from their earlier reads
     * goes, rows JE pointed at playable items go back to their missing items and JE's own arrival rows go, and the
     * status is read again. Until that answer nothing is pointed or removed on the old one.
     * @returns {void}
     */
    function onAccessRevision() {
        forget();
        if (!state) return;
        distrusted = state.status;
        state.trusted = false;
        const page = state.page;
        page.querySelectorAll('.listItem[data-je-arr-was]').forEach(unpoint);
        page.querySelectorAll('.listItem[data-je-arr-arrival]').forEach(row => row.remove());
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
        const known = ids.map(norm).filter(id => placeholders.has(id) || missingItems.has(id));
        if (!known.length) return false;
        apply();
        return true;
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
        distrusted = null;
        forget();
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
    // What the page learnt from the person's status and season reads is theirs under their access: their next reads
    // teach it again once their access revision moves.
    document.addEventListener('je-access-revision', onAccessRevision);

    JE.internals = JE.internals || {};
    JE.internals.arrStatusEpisodes = { render, clear, apply, bannerEntries, extend, current, removed };
})(window.JellyfinEnhanced);
