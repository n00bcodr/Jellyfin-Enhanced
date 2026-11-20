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
    /** Which Reclaimerr the drawn requests came from (the list's `source`); every review sends it back. */
    let requestSource = null;
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

    /** A day as the Requests page writes older dates: "23 Nov 2026". */
    const shortDate = (date) => date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

    /** Reclaimerr writes its times in UTC, sometimes without the zone: read those as UTC. */
    const utcDate = (value) => new Date(/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(String(value)) ? value : `${value}Z`);
    const pad2 = (n) => String(n).padStart(2, '0');
    /** A Date as the local "YYYY-MM-DDTHH:mm" a datetime-local input takes. */
    const localInput = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

    /** How long ago, as the Requests page words it ("3d ago", then "23 Nov 2026" after a month); the same strings. */
    function relativeDate(value) {
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '';
        const diff = Date.now() - date.getTime();
        if (diff < 0) return shortDate(date);
        const minutes = Math.floor(diff / 60000), hours = Math.floor(diff / 3600000), days = Math.floor(diff / DAY_MS);
        if (minutes < 1) return t('requests_just_now');
        if (minutes < 60) return t('requests_minutes_ago').replace('{minutes}', minutes);
        if (hours < 24) return t('requests_hours_ago').replace('{hours}', hours);
        if (days < 30) return t('requests_days_ago').replace('{days}', days);
        return shortDate(date);
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
        // Greys are rgba(128,128,128) so the page reads on dark and light themes alike; text inherits the theme's colour.
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
.je-ls-refresh { background: none; border: none; cursor: pointer; color: inherit; opacity: .75; padding: 8px; border-radius: 50%; display: flex; align-items: center; justify-content: center; }
.je-ls-refresh:hover, .je-ls-refresh:focus-visible { background: rgba(128,128,128,.2); opacity: 1; outline: none; }
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
.je-ls-btn[disabled] { opacity: .5; cursor: default; }
.je-ls-btn.danger { background: #d03a3a; border-color: transparent; color: #fff; }
/* Cards: the Requests page's layout (poster left, details right), one column on a phone. */
.je-ls-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 1.1em; }
.je-ls-card { display: flex; gap: 1em; padding: 1em; border-radius: .5em; background: rgba(128,128,128,.1); min-width: 0; }
.je-ls-poster { position: relative; width: 80px; height: 120px; flex: none; border-radius: .5em; overflow: hidden; background: rgba(128,128,128,.18); cursor: pointer; }
.je-ls-poster.plain { cursor: default; }
.je-ls-poster img { position: absolute; inset: 0; z-index: 1; width: 100%; height: 100%; object-fit: cover; display: block; }
.je-ls-poster .je-ls-fallback { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 2.2em; opacity: .35; }
.je-ls-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: .3em; }
.je-ls-head { display: flex; align-items: baseline; gap: .4em; min-width: 0; }
.je-ls-name { font-weight: 600; line-height: 1.25; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.je-ls-name.plain { cursor: default; }
.je-ls-year { opacity: .65; font-size: .85em; flex: none; }
.je-ls-sub { opacity: .7; font-size: .85em; overflow-wrap: anywhere; }
.je-ls-note { font-style: italic; }
.je-ls-badges { display: flex; gap: .4em; flex-wrap: wrap; align-items: center; }
.je-ls-chip, .je-ls-scope { display: inline-block; padding: .18em .6em; border-radius: 999px; font-size: .68em; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; line-height: 1.4; color: #fff; background: rgba(90,90,90,.85); }
.je-ls-scope { background: rgba(128,128,128,.28); color: inherit; text-transform: none; font-weight: 600; }
.je-ls-chip.warn { background: #c77c0a; }
.je-ls-chip.urgent { background: #c62828; }
.je-ls-chip.ok { background: #2e7d32; }
.je-ls-chip.soon { background: rgba(0,164,220,.85); }
.je-ls-actions, .je-ls-reqactions { margin-top: auto; padding-top: .4em; display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.je-ls-reqactions:has(.je-ls-warn) { flex-direction: column; align-items: stretch; gap: 8px; }
.je-ls-warn { font-size: .82em; line-height: 1.3; color: #ef7a6c; }
.je-ls-confirm { display: flex; gap: 6px; flex-wrap: wrap; }
.je-ls-note-input { width: 100%; box-sizing: border-box; padding: 6px 8px; border-radius: 6px; border: 1px solid rgba(128,128,128,.45); background: rgba(128,128,128,.12); color: inherit; font: inherit; font-size: .85em; }
.je-ls-who { display: flex; align-items: center; gap: 6px; font-size: .88em; opacity: .9; flex-wrap: wrap; }
.je-ls-avatar { position: relative; width: 22px; height: 22px; border-radius: 50%; background: var(--je-ls-accent, #00a4dc); color: #fff; font-size: .75em; font-weight: 600; display: inline-flex; align-items: center; justify-content: center; overflow: hidden; flex: none; }
.je-ls-avatar img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.je-ls-err { font-size: .82em; color: #ef7a6c; overflow-wrap: anywhere; }
.je-ls-section { margin-top: 34px; }
.je-ls-section h3 { margin: 0 0 12px; font-size: 1.15em; font-weight: 500; display: flex; align-items: center; gap: 8px; }
.je-ls-notice { padding: 10px 12px; border-radius: 8px; background: rgba(199,124,10,.18); font-size: .9em; margin-top: 24px; }
.je-ls-empty { opacity: .7; padding: 40px 0; text-align: center; }
@media (max-width: 600px) {
  .je-ls-top { gap: 10px; }
  .je-ls-title { flex: 1 0 100%; }
  .je-ls-pills { order: 1; }
  .je-ls-spacer { order: 2; }
  .je-ls-refresh { order: 3; }
  .je-ls-grid { grid-template-columns: minmax(0, 1fr); gap: .8em; }
  .je-ls-card { padding: .8em; gap: .8em; }
  .je-ls-poster { width: 72px; height: 108px; }
}
`;
        document.head.appendChild(style);
        try { document.documentElement.style.setProperty('--je-ls-accent', JE?.themer?.getThemeVariables?.()?.primaryAccent || '#00a4dc'); } catch (_) { /* default accent */ }
    };

    /** @returns {Promise<any>} The server's list for the signed-in user. */
    function load() {
        return ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl('JellyfinEnhanced/leaving-soon/list'), dataType: 'json' });
    }

    /** Approve or deny a request; the optional note goes to Reclaimerr (and the requester), and `timing` ({when, date}) says when an approval is deleted. */
    async function review(id, approve, button, note, timing) {
        button.disabled = true;
        try {
            await ApiClient.ajax({ type: 'POST', url: ApiClient.getUrl(`JellyfinEnhanced/reclaimerr/requests/${id}/${approve ? 'approve' : 'deny'}`), data: JSON.stringify({ ...(note ? { note } : {}), ...(timing || {}), ...(requestSource ? { source: requestSource } : {}) }), contentType: 'application/json', dataType: 'json' });
            JE.toast?.(esc(t(approve ? 'leavingsoon_approved' : 'leavingsoon_denied')));
            refresh();
        } catch (err) {
            let reason = null;
            try { reason = typeof err?.json === 'function' ? (await err.json())?.error : null; } catch { /* no body */ }
            JE.toast?.(esc(t('maintainerr_failed', { error: reason || err?.status || '' })), 6000);
            button.disabled = false;
        }
    }

    const parseColour = (value) => { const m = String(value || '').match(/[\d.]+/g); return m && m.length >= 3 ? m.map(Number) : null; };
    const brightness = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];

    /** The first fully opaque background the control sits on (its ancestors, then the page's own backdrop), or null. */
    function opaqueSurface(el) {
        const candidates = [];
        for (let n = el.parentElement; n; n = n.parentElement) candidates.push(n);
        for (const sel of ['.backgroundContainer', '.skinBody']) { const n = document.querySelector(sel); if (n) candidates.push(n); }
        for (const n of candidates) {
            const c = parseColour(getComputedStyle(n).backgroundColor);
            if (c && (c.length === 3 || c[3] >= 0.95)) return c;
        }
        return null;
    }

    /**
     * A native menu draws its own popup, which ignores a translucent background: the theme's light text on a default light popup made the
     * options vanish. Take what the theme gives the page (its text colour, and the opaque surface the control sits on) so the popup matches
     * it on any theme; only when those are missing or too close to read does a plain dark or light pair stand in. The date picker's native
     * popup is given the same light or dark scheme.
     */
    function paintPopups(select, dateInput) {
        const text = parseColour(getComputedStyle(select).color);
        const light = !!text && brightness(text) > 140;
        const surface = opaqueSurface(select);
        const readable = !!text && !!surface && Math.abs(brightness(text) - brightness(surface)) > 90;
        const bg = readable ? `rgb(${surface[0]}, ${surface[1]}, ${surface[2]})` : (light ? '#2b2b2b' : '#ffffff');
        const fg = readable ? `rgb(${text[0]}, ${text[1]}, ${text[2]})` : (light ? '#f2f2f2' : '#1a1a1a');
        for (const el of [select, dateInput]) if (el) el.style.colorScheme = light ? 'dark' : 'light';
        for (const option of select.options) { option.style.backgroundColor = bg; option.style.color = fg; }
    }

    function iconButton(kind, icon, label) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = `je-ls-icon-btn ${kind}`; b.title = label; b.setAttribute('aria-label', label);
        b.innerHTML = `<i class="material-icons" aria-hidden="true">${icon}</i>`;
        return b;
    }

    /** Make the poster and title open the Jellyfin item (when there is one). */
    function linkToItem(el, itemId) {
        if (!itemId) return;
        for (const target of el.querySelectorAll('.je-ls-poster, .je-ls-name')) {
            target.addEventListener('click', () => navigateToItem(itemId));
            target.addEventListener('keydown', (e) => { if (e.key === 'Enter') navigateToItem(itemId); });
        }
    }

    const formatSize = (bytes) => {
        if (!Number.isFinite(bytes) || bytes <= 0) return '';
        const gb = bytes / 1073741824;
        return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1048576)} MB`;
    };

    function card(item, data) {
        const c = chip(item.deleteAt);
        const el = document.createElement('div');
        el.className = 'je-ls-card';
        el.dataset.type = item.type;
        // One file of a movie kept in several versions is leaving; the title and its other versions stay.
        const date = Number.isFinite(item.deleteAt) ? shortDate(new Date(item.deleteAt)) : '';
        el.innerHTML = `<div class="je-ls-poster" role="link" tabindex="0"><span class="je-ls-fallback material-icons" aria-hidden="true">${item.type === 'Movie' ? 'movie' : 'tv'}</span>`
            + `<img alt="" loading="lazy" src="${esc(ApiClient.getUrl(`Items/${item.id}/Images/Primary`, { maxHeight: 360, quality: 90 }))}"/></div>`
            + `<div class="je-ls-info"><div class="je-ls-head"><div class="je-ls-name" role="link" tabindex="0" title="${esc(item.name)}">${esc(item.name)}</div>`
            + (item.year ? `<span class="je-ls-year">(${esc(item.year)})</span>` : '') + `</div>`
            + (item.detail ? `<div class="je-ls-sub">${esc(item.detail)}</div>` : '')
            + `<div class="je-ls-badges"><span class="je-ls-chip ${c.level}">${esc(c.text)}</span>`
            + (item.versionOnly ? `<span class="je-ls-scope">${esc(t('leavingsoon_one_version'))}</span>` : '') + `</div>`
            + (date || item.size ? `<div class="je-ls-sub">${esc([date ? t('leavingsoon_leaves_on', { date }) : '', formatSize(item.size)].filter(Boolean).join(' · '))}</div>` : '')
            + (data.actions ? `<div class="je-ls-actions"></div>` : '') + `</div>`;
        const img = el.querySelector('img');
        img?.addEventListener('error', () => img.remove());
        linkToItem(el, item.id);
        const actions = el.querySelector('.je-ls-actions');
        if (actions) {
            const keep = iconButton('keep', 'shield', t('maintainerr_keep'));
            keep.addEventListener('click', () => JE.removalMenu?.act?.('unmark', { itemId: item.id }, 'maintainerr_kept', data.provider === 'reclaimerr' ? null : { path: 'mark', body: { itemId: item.id }, doneKey: 'maintainerr_marked' }));
            const when = iconButton('date', 'event', t(data.provider === 'reclaimerr' ? 'reclaimerr_change_date' : 'maintainerr_postpone'));
            when.addEventListener('click', () => JE.removalMenu?.postpone?.(item.id, { Marked: true, DeleteAt: item.deleteAt ?? null }, when));
            actions.append(keep, when);
        }
        return el;
    }

    /** The poster for a request: the Jellyfin item's own when it is in the library, else TMDB's. */
    function requestPoster(r) {
        if (r.itemId) return ApiClient.getUrl(`Items/${r.itemId}/Images/Primary`, { maxHeight: 360, quality: 90 });
        if (r.posterPath) return /^https?:\/\//.test(r.posterPath) ? r.posterPath : `https://image.tmdb.org/t/p/w185${r.posterPath}`;
        return null;
    }

    /** What exactly a request would delete when that is less than the whole title: a season, an episode or one movie version. */
    function scopeLabel(r) {
        if (r.scope === 'season' && r.seasonNumber != null) return t('leavingsoon_scope_season', { season: r.seasonNumber });
        if (r.scope === 'episode' && r.episodeNumber != null && r.seasonNumber != null) return t('leavingsoon_scope_episode', { season: r.seasonNumber, episode: r.episodeNumber });
        if (r.scope === 'movie_version') return [t('leavingsoon_scope_version'), r.versionResolution, formatSize(r.versionSize)].filter(Boolean).join(' · ');
        return '';
    }

    /** The confirm sentence for approving: it names the scope when that is less than the title, because Reclaimerr deletes on approval. */
    function confirmText(r) {
        const scope = scopeLabel(r);
        return scope ? t('leavingsoon_confirm_delete_scope', { scope }) : t('leavingsoon_confirm_delete');
    }

    /**
     * The administrator's note as the requester reads it: reviews from Jellyfin end with "(Approved by NAME in Jellyfin)", which is for
     * Reclaimerr's record, so only that part is dropped (a note that is nothing else shows nothing).
     * @param {string|null|undefined} notes Reclaimerr's admin_notes.
     * @returns {string} The note to show, or ''.
     */
    function adminNote(notes) {
        return String(notes || '').replace(/\s*\(?(?:Approved|Denied) by [^()]+ in Jellyfin\)?\s*$/, '').trim();
    }

    /** @returns {{text: string, level: string}} The state chip of a request. */
    function requestChip(r) {
        if (r.executionError || r.scheduleState === 'failed' || r.scheduleState === 'blocked') return { text: t('leavingsoon_status_failed'), level: 'urgent' };
        if (r.deferred) return { text: t('leavingsoon_status_deferred'), level: 'warn' };
        return { text: t(`leavingsoon_status_${r.status}`) || r.status, level: r.status === 'denied' ? 'urgent' : r.status === 'approved' ? 'ok' : 'warn' };
    }

    /**
     * A deletion request as a card in the Requests page's layout: poster (opens the item), title, state, what it would delete
     * (a season, an episode or one version, when not the whole title), who asked (their Jellyfin name and avatar), their note,
     * why a deletion failed, and for administrators the Approve and Deny buttons. Approving asks first: when to delete (Reclaimerr's
     * grace period, now, or a day), the scope, and an optional note.
     */
    function requestCard(r, admin, graceDays) {
        const el = document.createElement('div');
        el.className = 'je-ls-card je-ls-reqcard';
        const when = r.createdAt ? relativeDate(r.createdAt) : '';
        const poster = requestPoster(r);
        const person = r.jellyfinUser || r.requestedBy || '';
        const state = requestChip(r);
        const scope = scopeLabel(r);
        const pending = r.status === 'pending';
        el.innerHTML = `<div class="je-ls-poster${r.itemId ? '' : ' plain'}"${r.itemId ? ' role="link" tabindex="0"' : ''}><span class="je-ls-fallback material-icons" aria-hidden="true">${r.mediaType === 'movie' ? 'movie' : 'tv'}</span>`
            + (poster ? `<img alt="" loading="lazy" src="${esc(poster)}"/>` : '') + `</div>`
            + `<div class="je-ls-info"><div class="je-ls-head"><div class="je-ls-name${r.itemId ? '' : ' plain'}"${r.itemId ? ' role="link" tabindex="0"' : ''} title="${esc(r.title)}">${esc(r.title)}</div>`
            + (r.year ? `<span class="je-ls-year">(${esc(r.year)})</span>` : '') + `</div>`
            + `<div class="je-ls-badges"><span class="je-ls-chip ${state.level}">${esc(state.text)}</span>${scope ? `<span class="je-ls-scope">${esc(scope)}</span>` : ''}</div>`
            + `<div class="je-ls-who"${admin && r.requestedBy ? ` title="${esc(t('leavingsoon_reclaimerr_account', { name: r.requestedBy }))}"` : ''}>`
            + (person ? `<span class="je-ls-avatar" aria-hidden="true">${esc(person.charAt(0).toUpperCase())}${r.jellyfinUserId ? `<img alt="" src="${esc(ApiClient.getUrl(`Users/${r.jellyfinUserId}/Images/Primary`, { maxHeight: 48, quality: 90 }))}"/>` : ''}</span><span>${esc(t('leavingsoon_requested_by', { name: person }))}</span>` : '')
            + `</div>`
            + (when ? `<div class="je-ls-sub">${esc(when)}</div>` : '')
            // A cancelled (Keep) or finished schedule keeps its old day in Reclaimerr's answer: it no longer says when the title leaves.
            + (r.scheduledAt && r.status === 'approved' && r.scheduleState !== 'canceled' && r.scheduleState !== 'completed' && !Number.isNaN(utcDate(r.scheduledAt).getTime()) ? `<div class="je-ls-sub">${esc(t('leavingsoon_leaves_on', { date: shortDate(utcDate(r.scheduledAt)) }))}</div>` : '')
            + (r.note ? `<div class="je-ls-sub je-ls-note">${esc(r.note)}</div>` : '')
            + (!admin && adminNote(r.adminNotes) ? `<div class="je-ls-sub je-ls-note">${esc(adminNote(r.adminNotes))}</div>` : '')
            + (r.executionError ? `<div class="je-ls-err">${esc(r.executionError)}</div>` : '')
            + (admin && pending ? `<div class="je-ls-reqactions"></div>` : '') + `</div>`;
        for (const img of el.querySelectorAll('img')) img.addEventListener('error', () => img.remove());
        linkToItem(el, r.itemId);
        const actions = el.querySelector('.je-ls-reqactions');
        if (actions) {
            const showChoice = () => {
                actions.textContent = '';
                const ok = iconButton('approve', 'check', t('leavingsoon_approve'));
                const no = iconButton('deny', 'close', t('leavingsoon_deny'));
                ok.addEventListener('click', showConfirm);
                no.addEventListener('click', () => review(r.id, false, no));
                actions.append(ok, no);
            };
            // Approving removes it from the library (after Reclaimerr's grace period, now, or on a day): one more click, with the
            // words (scope-aware), the choice of when, and an optional note.
            const showConfirm = () => {
                actions.textContent = '';
                const warn = document.createElement('div');
                warn.className = 'je-ls-warn';
                warn.textContent = confirmText(r);
                const note = document.createElement('input');
                note.type = 'text'; note.className = 'je-ls-note-input'; note.maxLength = 300; note.placeholder = t('leavingsoon_note_placeholder');
                note.setAttribute('aria-label', t('leavingsoon_note_placeholder'));
                const row = document.createElement('div');
                row.className = 'je-ls-confirm';
                const yes = document.createElement('button');
                yes.type = 'button'; yes.className = 'je-ls-btn danger'; yes.textContent = t('leavingsoon_approve');
                const cancel = document.createElement('button');
                cancel.type = 'button'; cancel.className = 'je-ls-btn'; cancel.textContent = t('maintainerr_cancel');
                const parts = [warn];
                const when = document.createElement('select');
                when.className = 'je-ls-note-input';
                when.setAttribute('aria-label', t('reclaimerr_schedule_title'));
                for (const [value, label] of [['default', graceDays > 0 ? t('leavingsoon_when_default_days', { days: graceDays }) : t('leavingsoon_when_default')], ['now', t('leavingsoon_delete_now')], ['date', t('leavingsoon_when_date')]]) {
                    const option = document.createElement('option');
                    option.value = value; option.textContent = label;
                    when.appendChild(option);
                }
                const day = document.createElement('input');
                day.type = 'datetime-local'; day.className = 'je-ls-note-input'; day.hidden = true;
                day.min = localInput(new Date(Date.now() + 60000));
                day.value = localInput(new Date(Date.now() + 7 * DAY_MS));
                day.setAttribute('aria-label', t('leavingsoon_when_date'));
                const sync = () => {
                    day.hidden = when.value !== 'date';
                    const picked = new Date(day.value);
                    const valid = when.value !== 'date' || (day.value !== '' && !Number.isNaN(picked.getTime()) && picked.getTime() > Date.now());
                    yes.disabled = !valid;
                    warn.textContent = when.value === 'now' ? confirmText(r)
                        : when.value === 'date' ? (valid ? t('leavingsoon_confirm_on', { date: shortDate(picked) }) : '')
                        : graceDays === 0 ? confirmText(r)
                        : graceDays > 0 ? t('leavingsoon_confirm_on', { date: shortDate(new Date(Date.now() + graceDays * DAY_MS)) })
                        : t('leavingsoon_confirm_grace');
                };
                when.addEventListener('change', sync);
                day.addEventListener('input', sync);
                parts.push(when, day);
                sync();

                yes.addEventListener('click', () => {
                    // The grace period this confirm promised goes along: the server refuses when Reclaimerr's setting changed since.
                    const timing = when.value === 'date' ? { when: 'date', date: new Date(day.value).toISOString() }
                        : when.value === 'default' && Number.isInteger(graceDays) ? { when: 'default', graceDays } : { when: when.value };
                    review(r.id, true, yes, note.value.trim(), timing);
                });
                cancel.addEventListener('click', showChoice);
                row.append(yes, cancel);
                actions.append(...parts, note, row);
                paintPopups(when, day);
            };
            showChoice();
        }
        return el;
    }

    function draw(host, data) {
        host.textContent = '';
        requestSource = data.source || null;
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
        if (data.requestsUnavailable) {
            // Administrators get Reclaimerr's reason instead of the refresh advice (a scope the token lacks is not fixed by refreshing);
            // the server sends it to them only.
            const note = document.createElement('div'); note.className = 'je-ls-notice';
            note.textContent = data.admin && data.requestsError ? t('leavingsoon_requests_unavailable_reason', { reason: data.requestsError }) : t('leavingsoon_requests_unavailable');
            root.appendChild(note);
        }
        if (data.admin && pending.length) {
            const sec = document.createElement('div'); sec.className = 'je-ls-section';
            sec.innerHTML = `<h3><span class="material-icons" aria-hidden="true">inbox</span>${esc(t('leavingsoon_requests_title', { count: pending.length }))}</h3>`;
            const grid = document.createElement('div'); grid.className = 'je-ls-grid';
            for (const r of pending) grid.appendChild(requestCard(r, true, Number.isInteger(data.graceDays) ? data.graceDays : null));
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
