// /js/extras/leavingsoon-page.js
// The Leaving soon page: everything the removal tool (Maintainerr or Reclaimerr, whichever is on) will remove,
// with the days left, for every user (only items they can see). Administrators can also keep an item or change
// its date from here (the same actions as the item menu, tags/maintainerr-item-menu.js), and with Reclaimerr see
// the pending deletion requests to approve or deny; anyone else sees their own requests and their state.
// Exposes JE.leavingSoonPage = { injectStyles, renderForCustomTab, stopPolling } so any host container (the native
// Home tab, a Custom Tabs panel, the Plugin Pages standalone page) mounts the same rendering. See
// leavingsoon-custom-tab.js for the container-finding side.
(function (JE) {
    'use strict';

    if (!window.JellyfinEnhanced?.pluginConfig?.LeavingSoonPageEnabled) return;

    const LOG = '🪼 Jellyfin Enhanced: Leaving Soon:';
    const POLL_MS = 5 * 60 * 1000;
    const DAY_MS = 86400000;
    /** @type {number|null} */
    let pollTimer = null;
    /** @type {HTMLElement|null} */
    let mounted = null;
    let filter = 'all';
    /** Until when the refresh icon spins (the list is redrawn, so the new button carries the animation). */
    let spinUntil = 0;

    const t = (key, params) => { try { return JE.t(key, params); } catch { return key; } };
    const esc = (s) => (JE.escapeHtml ? JE.escapeHtml(String(s ?? '')) : String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));

    /** Local calendar days from now to a delete time (a DST day is not 24 hours); null when undated. */
    function daysLeft(deleteAt) {
        if (!Number.isFinite(deleteAt)) return null;
        const day = (ms) => { const d = new Date(ms); return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS); };
        return day(deleteAt) - day(Date.now());
    }

    /** @returns {{text: string, level: string}} The chip for an item's delete time. */
    function chip(deleteAt) {
        const d = daysLeft(deleteAt);
        if (d === null) return { text: t('leavingsoon_soon'), level: 'soon' };
        if (d <= 0) return { text: t('leavingsoon_today'), level: 'urgent' };
        if (d === 1) return { text: t('leavingsoon_tomorrow'), level: 'urgent' };
        return { text: t('leavingsoon_in_days', { days: d }), level: d <= 7 ? 'warn' : 'soon' };
    }

    function navigateToItem(itemId) {
        if (!itemId) return;
        try {
            if (typeof Emby !== 'undefined' && Emby.Page?.showItem) { Emby.Page.showItem(itemId); return; }
        } catch (_) { /* fall through to the hash */ }
        window.location.hash = `#!/details?id=${itemId}`;
    }

    const injectStyles = () => {
        if (document.getElementById('je-leavingsoon-styles')) return;
        const style = document.createElement('style');
        style.id = 'je-leavingsoon-styles';
        style.textContent = `
.je-ls { width: 100%; box-sizing: border-box; padding: 20px 3vw 48px; }
.je-ls-top { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-bottom: 18px; }
.je-ls-title { display: flex; align-items: center; gap: 10px; margin: 0; font-size: 1.6em; font-weight: 500; }
.je-ls-heading { display: inline-flex; align-items: baseline; gap: 10px; }
.je-ls-count { opacity: .65; font-size: .55em; font-weight: 400; }
.je-ls-spacer { flex: 1; }
.je-ls-pills { display: flex; gap: 8px; }
.je-ls-pill, .je-ls-btn { border: 1px solid rgba(128,128,128,.4); background: rgba(128,128,128,.16); color: inherit; border-radius: 999px; padding: 6px 14px; cursor: pointer; font: inherit; font-size: .9em; }
.je-ls-btn { border-radius: 6px; padding: 5px 10px; font-size: .85em; }
.je-ls-pill:hover, .je-ls-btn:hover, .je-ls-pill:focus-visible, .je-ls-btn:focus-visible { background: rgba(128,128,128,.34); outline: none; }
.je-ls-refresh { background: none; border: none; cursor: pointer; color: rgba(255,255,255,.75); padding: 8px; border-radius: 50%; display: flex; align-items: center; justify-content: center; }
.je-ls-refresh:hover, .je-ls-refresh:focus-visible { background: rgba(255,255,255,.08); color: rgba(255,255,255,.95); outline: none; }
.je-ls-refresh .material-icons { font-size: 22px; }
.je-ls-refresh.spin .material-icons { animation: je-ls-spin .6s ease; }
@keyframes je-ls-spin { to { transform: rotate(360deg); } }
.je-ls-icon-btn { width: 36px; height: 36px; box-sizing: border-box; border: 1px solid rgba(128,128,128,.4); border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; color: inherit; background: rgba(128,128,128,.16); padding: 0; flex: none; transition: background .15s, border-color .15s, color .15s; }
.je-ls-icon-btn:hover, .je-ls-icon-btn:focus-visible { background: rgba(128,128,128,.34); outline: none; }
.je-ls-icon-btn[disabled] { opacity: .5; cursor: default; }
.je-ls-icon-btn .material-icons { font-size: 20px; line-height: 1; }
.je-ls-icon-btn.approve, .je-ls-icon-btn.keep { color: #3fbf6a; border-color: rgba(63,191,106,.55); }
.je-ls-icon-btn.deny { color: #ef5350; border-color: rgba(239,83,80,.55); }
.je-ls-icon-btn.date { color: var(--je-ls-accent, #00a4dc); border-color: rgba(0,164,220,.55); }
.je-ls-icon-btn.approve:hover, .je-ls-icon-btn.approve:focus-visible, .je-ls-icon-btn.keep:hover, .je-ls-icon-btn.keep:focus-visible { background: #2e9d4f; border-color: #2e9d4f; color: #fff; }
.je-ls-icon-btn.deny:hover, .je-ls-icon-btn.deny:focus-visible { background: #d03a3a; border-color: #d03a3a; color: #fff; }
.je-ls-icon-btn.date:hover, .je-ls-icon-btn.date:focus-visible { background: var(--je-ls-accent, #00a4dc); border-color: transparent; color: #fff; }
.je-ls-pill.active { background: rgba(128,128,128,.34); border-color: var(--je-ls-accent, #00a4dc); font-weight: 600; }
.je-ls-btn.primary { background: var(--je-ls-accent, #00a4dc); border-color: transparent; color: #fff; }
.je-ls-btn[disabled] { opacity: .5; cursor: default; }
.je-ls-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 18px; }
@media (max-width: 600px) {
  .je-ls-top { gap: 10px; }
  .je-ls-title { flex: 1 0 100%; }
  .je-ls-pills { order: 1; }
  .je-ls-spacer { order: 2; }
  .je-ls-refresh { order: 3; }
  .je-ls-grid { grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); gap: 12px; }
  .je-ls-actions { gap: 8px; }
  .je-ls-name { font-size: .92em; }
}
.je-ls-card { display: flex; flex-direction: column; gap: 8px; }
.je-ls-poster { position: relative; aspect-ratio: 2 / 3; border-radius: 8px; overflow: hidden; background: rgba(255,255,255,.07); cursor: pointer; }
.je-ls-poster img { position: relative; z-index: 1; width: 100%; height: 100%; object-fit: cover; display: block; }
.je-ls-poster .je-ls-fallback { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 3em; opacity: .35; }
.je-ls-chip { position: absolute; z-index: 2; left: 8px; bottom: 8px; padding: 3px 9px; border-radius: 999px; font-size: .8em; font-weight: 600; background: rgba(0,0,0,.72); color: #fff; }
.je-ls-chip.warn { background: #c77c0a; }
.je-ls-chip.urgent { background: #c62828; }
.je-ls-chip.ok { background: #2e7d32; }
.je-ls-name { font-weight: 500; line-height: 1.25; cursor: pointer; }
.je-ls-sub { opacity: .65; font-size: .85em; }
.je-ls-actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: auto; padding-top: 4px; }
.je-ls-section { margin-top: 34px; }
.je-ls-section h3 { margin: 0 0 12px; font-size: 1.15em; font-weight: 500; display: flex; align-items: center; gap: 8px; }
.je-ls-row { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: 8px; background: rgba(255,255,255,.05); margin-bottom: 8px; flex-wrap: wrap; }
.je-ls-row .grow { flex: 1; min-width: 180px; }
.je-ls-reqactions { display: flex; flex-direction: column; gap: 8px; margin-top: 4px; }
.je-ls-reqactions:not(:has(.je-ls-warn)) { flex-direction: row; gap: 10px; }
.je-ls-warn { font-size: .82em; line-height: 1.3; color: #ffb4a8; }
.je-ls-confirm { display: flex; gap: 6px; flex-wrap: wrap; }
.je-ls-btn.danger { background: #d03a3a; border-color: transparent; color: #fff; }
.je-ls-poster.plain { cursor: default; }
.je-ls-req-poster { position: relative; width: 48px; height: 72px; flex: none; border-radius: 6px; overflow: hidden; background: rgba(255,255,255,.08); display: flex; align-items: center; justify-content: center; }
.je-ls-req-poster.linked { cursor: pointer; }
.je-ls-req-poster .material-icons { opacity: .35; font-size: 24px; }
.je-ls-req-poster img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.je-ls-name.plain { cursor: default; }
.je-ls-who { display: flex; align-items: center; gap: 6px; margin-top: 4px; font-size: .88em; opacity: .85; flex-wrap: wrap; }
.je-ls-avatar { position: relative; width: 22px; height: 22px; border-radius: 50%; background: var(--je-ls-accent, #00a4dc); color: #fff; font-size: .75em; font-weight: 600; display: inline-flex; align-items: center; justify-content: center; overflow: hidden; flex: none; }
.je-ls-avatar img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.je-ls-note { margin-top: 3px; font-style: italic; }
.je-ls-status { padding: 2px 9px; border-radius: 999px; font-size: .8em; background: rgba(255,255,255,.12); }
.je-ls-status.approved { background: #2e7d32; } .je-ls-status.denied { background: #8d2b2b; } .je-ls-status.pending { background: #8a6d12; }
.je-ls-empty { opacity: .7; padding: 40px 0; text-align: center; }
`;
        document.head.appendChild(style);
        try { document.documentElement.style.setProperty('--je-ls-accent', JE?.themer?.getThemeVariables?.()?.primaryAccent || '#00a4dc'); } catch (_) { /* default accent */ }
    };

    /** @returns {Promise<any>} The server's list for the signed-in user. */
    function load() {
        return ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('JellyfinEnhanced/leaving-soon/list'), dataType: 'json' });
    }

    async function review(id, approve, button) {
        button.disabled = true;
        try {
            await ApiClient.ajax({ type: 'POST', url: ApiClient.getUrl(`JellyfinEnhanced/leaving-soon/requests/${id}/${approve ? 'approve' : 'deny'}`), data: JSON.stringify({}), contentType: 'application/json', dataType: 'json' });
            JE.toast?.(esc(t(approve ? 'leavingsoon_approved' : 'leavingsoon_denied')));
            refresh();
        } catch (err) {
            let reason = null;
            try { reason = typeof err?.json === 'function' ? (await err.json())?.error : null; } catch { /* no body */ }
            JE.toast?.(esc(t('maintainerr_failed', { error: reason || err?.status || '' })), 6000);
            button.disabled = false;
        }
    }

    function card(item, data) {
        const c = chip(item.deleteAt);
        const el = document.createElement('div');
        el.className = 'je-ls-card';
        el.dataset.type = item.type;
        const sub = [item.detail, item.year].filter(Boolean).join(' · ');
        el.innerHTML = `<div class="je-ls-poster" role="link" tabindex="0"><span class="je-ls-fallback material-icons" aria-hidden="true">movie</span>`
            + `<img alt="" loading="lazy" src="${esc(ApiClient.getUrl(`Items/${item.id}/Images/Primary`, { maxHeight: 420, quality: 90 }))}"/>`
            + `<span class="je-ls-chip ${c.level}">${esc(c.text)}</span></div>`
            + `<div class="je-ls-name" role="link" tabindex="0">${esc(item.name)}</div>`
            + (sub ? `<div class="je-ls-sub">${esc(sub)}</div>` : '')
            + (data.actions ? `<div class="je-ls-actions"></div>` : '');
        const img = el.querySelector('img');
        img?.addEventListener('error', () => img.remove());
        for (const target of el.querySelectorAll('.je-ls-poster, .je-ls-name')) {
            target.addEventListener('click', () => navigateToItem(item.id));
            target.addEventListener('keydown', (e) => { if (e.key === 'Enter') navigateToItem(item.id); });
        }
        const actions = el.querySelector('.je-ls-actions');
        if (actions) {
            const iconButton = (kind, icon, label) => {
                const b = document.createElement('button');
                b.type = 'button'; b.className = `je-ls-icon-btn ${kind}`; b.title = label; b.setAttribute('aria-label', label);
                b.innerHTML = `<i class="material-icons" aria-hidden="true">${icon}</i>`;
                return b;
            };
            const keep = iconButton('keep', 'shield', t('maintainerr_keep'));
            keep.addEventListener('click', () => JE.removalMenu?.act?.('unmark', { itemId: item.id }, 'maintainerr_kept', data.provider === 'reclaimerr' ? null : { path: 'mark', body: { itemId: item.id }, doneKey: 'maintainerr_marked' }));
            const when = iconButton('date', 'event', t(data.provider === 'reclaimerr' ? 'maintainerr_change_date' : 'maintainerr_postpone'));
            when.addEventListener('click', () => JE.removalMenu?.postpone?.(item.id, { Marked: true, DeleteAt: item.deleteAt ?? null }, when));
            actions.append(keep, when);
        }
        return el;
    }

    /** The poster for a request: the Jellyfin item's own when it is in the library, else TMDB's. */
    function requestPoster(r) {
        if (r.itemId) return ApiClient.getUrl(`Items/${r.itemId}/Images/Primary`, { maxHeight: 220, quality: 90 });
        return r.posterPath ? `https://image.tmdb.org/t/p/w185${r.posterPath}` : null;
    }

    /**
     * A deletion request as a card like the leaving cards: poster (opens the item), title, who asked (their Jellyfin
     * name and avatar), their note, and for administrators the Approve and Deny buttons. Approving deletes the title
     * from the library at once (Reclaimerr acts on approval), so it asks first.
     */
    function requestCard(r, admin) {
        const el = document.createElement('div');
        el.className = 'je-ls-card je-ls-reqcard';
        const when = r.createdAt ? new Date(r.createdAt).toLocaleDateString() : '';
        const poster = requestPoster(r);
        const person = r.jellyfinUser || r.requestedBy || '';
        el.innerHTML = `<div class="je-ls-poster${r.itemId ? '' : ' plain'}"${r.itemId ? ' role="link" tabindex="0"' : ''}><span class="je-ls-fallback material-icons" aria-hidden="true">${r.mediaType === 'movie' ? 'movie' : 'tv'}</span>`
            + (poster ? `<img alt="" loading="lazy" src="${esc(poster)}"/>` : '')
            + (admin ? '' : `<span class="je-ls-chip ${r.status === 'denied' ? 'urgent' : r.status === 'approved' ? 'ok' : 'warn'}">${esc(t(`leavingsoon_status_${r.status}`) || r.status)}</span>`) + `</div>`
            + `<div class="je-ls-name${r.itemId ? '' : ' plain'}"${r.itemId ? ' role="link" tabindex="0"' : ''}>${esc(r.title)}</div>`
            + (r.year ? `<div class="je-ls-sub">${esc(r.year)}</div>` : '')
            + `<div class="je-ls-who"${admin && r.requestedBy ? ` title="${esc(t('leavingsoon_reclaimerr_account', { name: r.requestedBy }))}"` : ''}>`
            + (person ? `<span class="je-ls-avatar" aria-hidden="true">${esc(person.charAt(0).toUpperCase())}${r.jellyfinUserId ? `<img alt="" src="${esc(ApiClient.getUrl(`Users/${r.jellyfinUserId}/Images/Primary`, { maxHeight: 48, quality: 90 }))}"/>` : ''}</span><span>${esc(t('leavingsoon_requested_by', { name: person }))}</span>` : '')
            + `</div>`
            + (when ? `<div class="je-ls-sub">${esc(when)}</div>` : '')
            + (r.note ? `<div class="je-ls-sub je-ls-note">${esc(r.note)}</div>` : '')
            + (admin ? `<div class="je-ls-reqactions"></div>` : '');
        for (const img of el.querySelectorAll('img')) img.addEventListener('error', () => img.remove());
        if (r.itemId) {
            for (const target of el.querySelectorAll('.je-ls-poster, .je-ls-name')) {
                target.addEventListener('click', () => navigateToItem(r.itemId));
                target.addEventListener('keydown', (e) => { if (e.key === 'Enter') navigateToItem(r.itemId); });
            }
        }
        const actions = el.querySelector('.je-ls-reqactions');
        if (actions) {
            const iconButton = (kind, icon, label) => {
                const b = document.createElement('button');
                b.type = 'button'; b.className = `je-ls-icon-btn ${kind}`; b.title = label; b.setAttribute('aria-label', label);
                b.innerHTML = `<i class="material-icons" aria-hidden="true">${icon}</i>`;
                return b;
            };
            const showChoice = () => {
                actions.textContent = '';
                const ok = iconButton('approve', 'check', t('leavingsoon_approve'));
                const no = iconButton('deny', 'close', t('leavingsoon_deny'));
                ok.addEventListener('click', showConfirm);
                no.addEventListener('click', () => review(r.id, false, no));
                actions.append(ok, no);
            };
            // Approving removes the title from the library now: one more click, with the words.
            const showConfirm = () => {
                actions.textContent = '';
                const warn = document.createElement('div');
                warn.className = 'je-ls-warn';
                warn.textContent = t('leavingsoon_confirm_delete');
                const row = document.createElement('div');
                row.className = 'je-ls-confirm';
                const yes = document.createElement('button');
                yes.type = 'button'; yes.className = 'je-ls-btn danger'; yes.textContent = t('leavingsoon_delete_now');
                const cancel = document.createElement('button');
                cancel.type = 'button'; cancel.className = 'je-ls-btn'; cancel.textContent = t('maintainerr_cancel');
                yes.addEventListener('click', () => review(r.id, true, yes));
                cancel.addEventListener('click', showChoice);
                row.append(yes, cancel);
                actions.append(warn, row);
            };
            showChoice();
        }
        return el;
    }

    function draw(host, data) {
        host.textContent = '';
        const root = document.createElement('div');
        root.className = 'je-ls';
        const items = data.items || [];
        const shown = items.filter((i) => filter === 'all' || (filter === 'movies' ? i.type === 'Movie' : i.type !== 'Movie'));
        root.innerHTML = `<div class="je-ls-top"><h2 class="je-ls-title"><span class="material-icons" aria-hidden="true">auto_delete</span><span class="je-ls-heading">${esc(t('leavingsoon_title'))}`
            + `<span class="je-ls-count">${esc(`${items.length} ${t(items.length === 1 ? 'leavingsoon_item' : 'leavingsoon_items')}`)}</span></span></h2><span class="je-ls-spacer"></span>`
            + `<div class="je-ls-pills"></div><button type="button" class="je-ls-refresh${Date.now() < spinUntil ? ' spin' : ''}" data-refresh title="${esc(t('leavingsoon_refresh'))}" aria-label="${esc(t('leavingsoon_refresh'))}"><i class="material-icons" aria-hidden="true">refresh</i></button></div>`;
        const pills = root.querySelector('.je-ls-pills');
        if (items.length) {
            for (const [key, label] of [['all', 'leavingsoon_all'], ['movies', 'leavingsoon_movies'], ['shows', 'leavingsoon_shows']]) {
                const b = document.createElement('button');
                b.type = 'button'; b.className = `je-ls-pill${filter === key ? ' active' : ''}`; b.textContent = t(label);
                b.addEventListener('click', () => { filter = key; draw(host, data); });
                pills.appendChild(b);
            }
        }
        root.querySelector('[data-refresh]')?.addEventListener('click', () => { spinUntil = Date.now() + 600; refresh(); });
        if (!shown.length) {
            const empty = document.createElement('div'); empty.className = 'je-ls-empty'; empty.textContent = t(items.length ? 'leavingsoon_none_here' : 'leavingsoon_none');
            root.appendChild(empty);
        } else {
            const grid = document.createElement('div'); grid.className = 'je-ls-grid';
            for (const item of shown) grid.appendChild(card(item, data));
            root.appendChild(grid);
        }
        const pending = data.requests || [];
        if (data.admin && pending.length) {
            const sec = document.createElement('div'); sec.className = 'je-ls-section';
            sec.innerHTML = `<h3><span class="material-icons" aria-hidden="true">inbox</span>${esc(t('leavingsoon_requests_title', { count: pending.length }))}</h3>`;
            const grid = document.createElement('div'); grid.className = 'je-ls-grid';
            for (const r of pending) grid.appendChild(requestCard(r, true));
            sec.appendChild(grid);
            root.appendChild(sec);
        }
        const mine = data.mine || [];
        if (!data.admin && mine.length) {
            const sec = document.createElement('div'); sec.className = 'je-ls-section';
            sec.innerHTML = `<h3><span class="material-icons" aria-hidden="true">outbox</span>${esc(t('leavingsoon_my_requests'))}</h3>`;
            const grid = document.createElement('div'); grid.className = 'je-ls-grid';
            for (const r of mine) grid.appendChild(requestCard(r, false));
            sec.appendChild(grid);
            root.appendChild(sec);
        }
        host.appendChild(root);
    }

    let loadTicket = 0;

    async function refresh() {
        if (!mounted) return;
        const ticket = ++loadTicket;
        try { const data = await load(); if (ticket === loadTicket && mounted) draw(mounted, data); }
        catch (err) {
            console.warn(LOG, 'could not load the list:', err);
            if (mounted && !mounted.querySelector('.je-ls')) mounted.textContent = t('leavingsoon_unavailable');
        }
    }

    function stopPolling() {
        if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
        window.removeEventListener('je-leaving-soon-changed', refresh);
    }

    /** Mount into any host element (a Custom Tabs panel, the native Home tab, the Plugin Pages page). */
    function renderForCustomTab(host) {
        stopPolling();
        mounted = host;
        injectStyles();
        host.textContent = t('leavingsoon_loading');
        refresh();
        pollTimer = setInterval(() => { if (mounted && document.contains(mounted)) refresh(); else stopPolling(); }, POLL_MS);
        // An action taken here or from the item menu (keep, change date) changes the list.
        window.addEventListener('je-leaving-soon-changed', refresh);
    }

    JE.leavingSoonPage = { injectStyles, renderForCustomTab, stopPolling, chip, daysLeft };
})(window.JellyfinEnhanced);
