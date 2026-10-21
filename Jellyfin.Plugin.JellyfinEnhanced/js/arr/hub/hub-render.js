/**
 * @file Requests & downloads, phase 1: renders the Requests page's own tabs from the hub response
 * (GET /JellyfinEnhanced/acquire/hub): My requests (grouped: waiting for an OK, on the way, not out
 * yet, said no), Coming soon (an agenda by day) and Ready. Each row shows the poster, title, when it
 * was asked and the shared status pill (JE.arrStatus), plus Play/Details and, for administrators,
 * Manage. Everything text-like goes in through textContent.
 */
(function (JE) {
    'use strict';

    const H = (JE.internals = JE.internals || {}).arrHub = JE.internals.arrHub || {};
    const GROUPS = [
        { id: 'needsOk', label: 'arr_hub_group_needs_ok' },
        { id: 'onTheWay', label: 'arr_hub_group_on_the_way' },
        { id: 'notOut', label: 'arr_hub_group_not_out' },
        { id: 'removed', label: 'arr_hub_group_removed' },
        { id: 'declined', label: 'arr_hub_group_declined' }
    ];

    /**
     * Translates through the shared status helper.
     * @param {string} key en.json key.
     * @param {Object} [params] Parameters.
     * @returns {string} Text.
     */
    function tr(key, params) {
        return JE.arrStatus ? JE.arrStatus.tr(key, params) : key;
    }

    /**
     * Creates an element.
     * @param {string} tag Tag.
     * @param {string} [cls] Classes.
     * @param {string} [text] Text.
     * @returns {HTMLElement} Element.
     */
    function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }

    /**
     * "Season 2" / "Seasons 1–3" / "Seasons 1, 3".
     * @param {number[]} seasons Season numbers.
     * @returns {string} Text ('' for none).
     */
    function seasonsText(seasons) {
        if (!Array.isArray(seasons) || seasons.length === 0) return '';
        const sorted = [...seasons].sort((a, b) => a - b);
        if (sorted.length === 1) return tr('arr_hub_season', { list: sorted[0] });
        const contiguous = sorted.every((n, i) => i === 0 || n === sorted[i - 1] + 1);
        return tr('arr_hub_seasons', { list: contiguous ? `${sorted[0]}–${sorted[sorted.length - 1]}` : sorted.join(', ') });
    }

    /**
     * A TMDB poster URL for a poster path from the server (validated there; checked again here).
     * @param {string} path Poster path.
     * @returns {string|null} URL.
     */
    function posterUrl(path) {
        return typeof path === 'string' && /^\/[A-Za-z0-9_.-]+$/.test(path) ? `https://image.tmdb.org/t/p/w185${path}` : null;
    }

    /**
     * The Primary image of a Jellyfin item the viewer can open, or null.
     * @param {string|undefined} itemId Item id (32 hex).
     * @returns {string|null} URL.
     */
    function itemImage(itemId) {
        if (typeof itemId !== 'string' || !/^[0-9a-f]{32}$/i.test(itemId)) return null;
        if (typeof ApiClient === 'undefined' || typeof ApiClient.getImageUrl !== 'function') return null;
        return ApiClient.getImageUrl(itemId, { type: 'Primary', maxHeight: 300 });
    }

    /**
     * One request row.
     * @param {Object} entry Hub entry.
     * @param {Object} ctx Response context (contact, admin).
     * @param {{open: Function, play: Function, manage: Function}} actions Callbacks.
     * @param {{arrived?: boolean}} [options] Row options.
     * @returns {HTMLElement} Row.
     */
    function buildRow(entry, ctx, actions, options) {
        const row = el('div', 'je-hub-row');
        row.tabIndex = 0;
        row.setAttribute('role', 'button');
        row.dataset.jeArrKey = entry.key || '';
        // Which control this is, so focus can come back to it after a re-render.
        row.dataset.jeFocus = `row:${entry.key || ''}${entry.is4k ? ':4k' : ''}`;
        row.dataset.jeArrVariant = entry.is4k ? '4k' : 'standard';
        // TMDB's poster, else the Jellyfin item's own image (requests in JE mode name titles Jellyfin has by its item).
        const src = posterUrl(entry.poster) || itemImage(entry.itemId);
        if (src) {
            const img = el('img', 'je-hub-poster');
            img.loading = 'lazy';
            img.alt = '';
            img.src = src;
            row.appendChild(img);
        } else {
            const empty = el('div', 'je-hub-poster je-hub-poster-empty');
            empty.appendChild(JE.arrStatus.icon(entry.kind === 'tv' ? 'tv' : 'movie'));
            row.appendChild(empty);
        }
        const body = el('div', 'je-hub-body');
        const name = el('div', 'je-hub-name', entry.title || tr('arr_hub_untitled'));
        if (entry.year) name.appendChild(el('span', 'je-hub-year', ` (${entry.year})`));
        if (entry.is4k) name.appendChild(el('span', 'je-hub-chip', tr('arr_hub_4k')));
        body.appendChild(name);
        const meta = [];
        if (options?.arrived && entry.readyAt) meta.push(tr('arr_hub_arrived', { date: JE.arrStatus.formatDate(entry.readyAt) }));
        else if (entry.askedAt) meta.push(tr('arr_hub_asked', { date: JE.arrStatus.formatDate(entry.askedAt) }));
        const seasons = seasonsText(entry.seasons);
        if (seasons) meta.push(seasons);
        // Single episodes asked for (JE mode): "S1E3", up to three of them.
        if (Array.isArray(entry.episodes) && entry.episodes.length > 0 && entry.episodes.length <= 3) {
            meta.push(entry.episodes.map(e => tr('arr_approvals_scope_episode', { season: e.season, episode: e.episode })).join(', '));
        }
        if (meta.length) body.appendChild(el('div', 'je-hub-meta', meta.join(' · ')));
        if (entry.status && !(entry.group === 'ready' && entry.status.quiet)) {
            body.appendChild(JE.arrStatus.buildPill(entry.status, ctx));
        }
        row.appendChild(body);

        const buttons = el('div', 'je-hub-actions');
        if (entry.itemId) {
            const play = el('button', 'je-hub-btn je-hub-btn-primary');
            play.type = 'button';
            play.dataset.jeFocus = `play:${entry.key || ''}${entry.is4k ? ':4k' : ''}`;
            play.appendChild(JE.arrStatus.icon('play_arrow'));
            play.appendChild(document.createTextNode(tr('arr_hub_play')));
            play.addEventListener('click', (e) => { e.stopPropagation(); actions.play(entry, JE.ownerOf(e)); });
            buttons.appendChild(play);
        }
        if (ctx.admin && typeof actions.manage === 'function') {
            const manage = el('button', 'je-hub-btn je-hub-manage');
            manage.type = 'button';
            manage.dataset.jeFocus = `manage:${entry.key || ''}${entry.is4k ? ':4k' : ''}`;
            manage.appendChild(JE.arrStatus.icon('tune'));
            manage.appendChild(document.createTextNode(tr('arr_manage_button')));
            manage.addEventListener('click', (e) => { e.stopPropagation(); actions.manage(entry, JE.ownerOf(e)); });
            buttons.appendChild(manage);
        }
        // Phase 2: Following / Notify me (own requests are followed unless muted).
        JE.internals?.arrNotify?.rowButton?.(entry, buttons);
        // Phase 3: Cancel on the caller's own requests that haven't been sent yet (hub-mine-ledger.js).
        H.rowExtras?.(entry, buttons, body);
        const hide = JE.hiddenContent?.buildTitleControl?.({ ...entry, type: entry.kind, name: entry.title }, { surface: 'requests' });
        if (hide) buttons.appendChild(hide);
        row.classList.add('je-hub-entry');
        if (buttons.childNodes.length) row.appendChild(buttons);
        // The press's owner (D46S2-R10-1): the viewer's own click or key, taken at the gesture.
        const open = (e) => actions.open(entry, JE.ownerOf(e));
        row.addEventListener('click', open);
        row.addEventListener('keydown', (e) => {
            if (e.target === row && (e.key === 'Enter' || e.key === ' ')) {
                e.preventDefault();
                open(e);
            }
        });
        return row;
    }

    /**
     * A note above the list (Seerr not set up, out of date, admin error).
     * @param {Object} data Hub response.
     * @returns {HTMLElement|null} Note.
     */
    function buildNotes(data) {
        const box = el('div');
        // In JE mode the requests come from JE's own list: no Seerr is needed to show them.
        if (!data.seerr?.configured && !data.seerr?.ledger) {
            box.appendChild(el('div', 'je-hub-note', tr(data.admin ? 'arr_hub_not_configured_admin' : 'arr_hub_not_configured')));
        } else if (data.seerr?.unavailable) {
            box.appendChild(el('div', 'je-hub-note je-hub-note-warn', data.admin?.seerr?.lastError
                ? tr('arr_hub_admin_seerr_error', { error: data.admin.seerr.lastError })
                : tr('arr_hub_unavailable')));
        }
        if (data.more) box.appendChild(el('div', 'je-hub-note je-hub-more', tr('arr_hub_more')));
        if (data.arr?.unavailable) {
            // A Sonarr/Radarr can't be read: its titles say "taking longer than usual" for now.
            const note = el('div', 'je-hub-note je-hub-note-warn je-hub-arr-unavailable', tr('arr_hub_arr_unavailable'));
            note.setAttribute('role', 'status');
            box.appendChild(note);
        }
        return box.childNodes.length ? box : null;
    }

    /**
     * My requests: groups in order, each with its heading.
     * @param {HTMLElement} panel Target.
     * @param {Object} data Hub response.
     * @param {Object} actions Row callbacks.
     * @returns {void}
     */
    function renderMine(panel, data, actions) {
        const ctx = context(data);
        const entries = data.mine || [];
        if (!entries.length) {
            panel.appendChild(el('div', 'je-hub-empty', tr(data.seerr?.configured && !data.seerr?.loaded ? 'arr_hub_loading' : 'arr_hub_empty_mine')));
            return;
        }
        for (const group of GROUPS) {
            const items = entries.filter(e => e.group === group.id);
            if (!items.length) continue;
            const section = el('section', `je-hub-group je-hub-group-${group.id}`);
            section.appendChild(el('h2', 'je-hub-group-title', tr(group.label, { contact: ctx.contact || tr('arr_contact_default') })));
            const list = el('div', 'je-hub-list');
            items.forEach(entry => list.appendChild(buildRow(entry, ctx, actions)));
            section.appendChild(list);
            panel.appendChild(section);
        }
    }

    /**
     * Coming soon: an agenda by day (soonest first).
     * @param {HTMLElement} panel Target.
     * @param {Object} data Hub response.
     * @param {Object} actions Row callbacks.
     * @returns {void}
     */
    function renderSoon(panel, data, actions) {
        const ctx = context(data);
        // A release date is a calendar day: kept by the server while it is that day anywhere, shown
        // here until the viewer's own day has passed.
        const entries = (data.soon || []).filter(e => !(e.nextDay && JE.arrStatus.dayPassed?.(e.nextDay)));
        if (!entries.length) {
            panel.appendChild(el('div', 'je-hub-empty', tr('arr_hub_empty_soon')));
            return;
        }
        let day = null;
        let list = null;
        for (const entry of entries) {
            const label = JE.arrStatus.formatDate(entry.nextDay || entry.nextDate);
            if (label !== day) {
                day = label;
                panel.appendChild(el('h2', 'je-hub-day', label));
                list = el('div', 'je-hub-list');
                panel.appendChild(list);
            }
            list.appendChild(buildRow(entry, ctx, actions));
        }
    }

    /**
     * Ready: what arrived in the last two weeks, newest first.
     * @param {HTMLElement} panel Target.
     * @param {Object} data Hub response.
     * @param {Object} actions Row callbacks.
     * @returns {void}
     */
    function renderReady(panel, data, actions) {
        const ctx = context(data);
        const entries = data.ready || [];
        if (!entries.length) {
            panel.appendChild(el('div', 'je-hub-empty', tr('arr_hub_empty_ready')));
            return;
        }
        const list = el('div', 'je-hub-list');
        entries.forEach(entry => list.appendChild(buildRow(entry, ctx, actions, { arrived: true })));
        panel.appendChild(list);
    }

    /**
     * The status context rows use (contact name, admin).
     * @param {Object} data Hub response.
     * @returns {{contact: string, lookingHours: number, admin: boolean}} Context.
     */
    function context(data) {
        return { contact: data.contact || '', lookingHours: data.lookingHours, admin: !!data.admin };
    }

    H.renderMine = renderMine;
    H.renderSoon = renderSoon;
    H.renderReady = renderReady;
    H.buildNotes = buildNotes;
    H.buildRow = buildRow;
    H.seasonsText = seasonsText;
})(window.JellyfinEnhanced);
