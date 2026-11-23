import { apiClient, type TagRuntimeBridge } from '../host';
import { isRecord } from '../pipeline/dto';
import CSS from './leaving-soon-page.css';

// The Leaving soon page (upstream da0ea773, extras/leavingsoon-page.js): everything the removal tool (Maintainerr or
// Reclaimerr, whichever is on) will remove, with the days left, for every user (only items they can see: the server's
// leaving-soon/list leaves the others out). Administrators can also keep an item or change its date from here (the
// item menu's actions, JE.removalMenu), and with Reclaimerr see the pending deletion requests to approve (with a
// Reclaimerr that can schedule: after its grace period, now, or on a chosen day; upstream 1de354c0) or deny; anyone else
// sees their own requests and their state. Cards use the Requests page's layout (upstream 40738412: poster
// left, details right, the leave date and what leaving frees; a request says what it would delete and how an approved
// one ended). JE.leavingSoonPage = { injectStyles, renderForCustomTab,
// stopPolling, chip, daysLeft } so any host container (the native Home tab, a Custom Tabs panel, the Plugin Pages
// page) mounts the same rendering; leaving-soon-custom-tab.ts finds the containers.
//
// The output js/tags/tag-item-menu.js carries this module after the item menu (the bundle's load order is pinned, so
// it has no script of its own; upstream loads it after tags/maintainerr-item-menu.js too).

/** One item of leaving-soon/list. */
export interface LeavingItem {
    id: string;
    name: string;
    detail?: string | null;
    type: string;
    year?: number | null;
    deleteAt?: number | null;
    versionOnly?: boolean;
    /** Bytes leaving frees (the movie's file, the series' episode files, or the one version leaving); absent when unknown. */
    size?: number | null;
}

/** One deletion request of leaving-soon/list. */
export interface LeavingRequest {
    id: number;
    title: string;
    year?: number | null;
    mediaType: string;
    status: string;
    createdAt?: string | null;
    requestedBy?: string | null;
    note?: string | null;
    jellyfinUser?: string | null;
    jellyfinUserId?: string | null;
    itemId?: string | null;
    posterPath?: string | null;
    /** What it would delete: movie, series, season, episode or movie_version. */
    scope?: string | null;
    seasonNumber?: number | null;
    episodeNumber?: number | null;
    versionResolution?: string | null;
    versionSize?: number | null;
    adminNotes?: string | null;
    /** Why an approved deletion failed. */
    executionError?: string | null;
    /** Approved, and held back because it is being watched. */
    deferred?: boolean;
    /** When an approved request is deleted (Reclaimerr's UTC time, sometimes without the zone). */
    scheduledAt?: string | null;
    /** The state of that schedule; failed and blocked show as a failed deletion. */
    scheduleState?: string | null;
}

/** The answer of leaving-soon/list. */
export interface LeavingList {
    provider: string;
    admin: boolean;
    canRequest?: boolean;
    actions: boolean;
    items: LeavingItem[];
    requests: LeavingRequest[];
    mine: LeavingRequest[];
    /** The requests could not be read in time: say so instead of showing none. */
    requestsUnavailable: boolean;
    /** Why they could not be read, in Reclaimerr's words (administrators only; upstream da3d9ee9); null otherwise. */
    requestsError: string | null;
    /** The delay Reclaimerr gives an approval that names no day, in days; null when unknown. */
    graceDays: number | null;
    /** Which Reclaimerr the requests came from (administrators only); every review sends it back. */
    source: string | null;
}

export interface LeavingChip { text: string; level: string }

export interface LeavingSoonPage {
    injectStyles(): void;
    /** Mount into any host element (a Custom Tabs panel, the native Home tab, the Plugin Pages page). */
    renderForCustomTab(host: HTMLElement): void;
    stopPolling(): void;
    chip(deleteAt: number | null | undefined): LeavingChip;
    daysLeft(deleteAt: number | null | undefined): number | null;
}

const LOG = '🪼 Jellyfin Enhanced: Leaving Soon:';
const POLL_MS = 5 * 60 * 1000;
const DAY_MS = 86400000;

type Filter = 'all' | 'movies' | 'shows';

/** The list as the page reads it: unknown fields dropped, a wrong shape is an empty answer of that part. */
function listOf(value: unknown): LeavingList {
    const data = isRecord(value) ? value : {};
    const items = Array.isArray(data.items) ? data.items.filter(isRecord) as unknown as LeavingItem[] : [];
    const rows = (v: unknown): LeavingRequest[] => Array.isArray(v) ? v.filter(isRecord) as unknown as LeavingRequest[] : [];
    return {
        provider: data.provider === 'reclaimerr' ? 'reclaimerr' : 'maintainerr',
        admin: data.admin === true,
        canRequest: data.canRequest === true,
        actions: data.actions === true,
        items,
        requests: rows(data.requests),
        mine: rows(data.mine),
        requestsUnavailable: data.requestsUnavailable === true,
        requestsError: typeof data.requestsError === 'string' && data.requestsError ? data.requestsError : null,
        graceDays: typeof data.graceDays === 'number' && Number.isInteger(data.graceDays) ? data.graceDays : null,
        source: typeof data.source === 'string' && data.source ? data.source : null,
    };
}

/** A day as the Requests page writes older dates: "23 Nov 2026". */
const shortDate = (date: Date): string => date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

/** Reclaimerr writes its times in UTC, sometimes without the zone: read those as UTC. */
const utcDate = (value: string): Date => new Date(/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(value) ? value : `${value}Z`);
const pad2 = (n: number): string => String(n).padStart(2, '0');
/** A Date as the local "YYYY-MM-DDTHH:mm" a datetime-local input takes. */
const localInput = (d: Date): string => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

/** A CSS colour's channels (r, g, b and alpha when given), or null. */
const parseColour = (value: string | null | undefined): number[] | null => {
    const m = String(value || '').match(/[\d.]+/g);
    return m && m.length >= 3 ? m.map(Number) : null;
};
const brightness = (c: readonly number[]): number => 0.299 * (c[0] ?? 0) + 0.587 * (c[1] ?? 0) + 0.114 * (c[2] ?? 0);

/** The first fully opaque background the control sits on (its ancestors, then the page's own backdrop), or null. */
function opaqueSurface(el: HTMLElement): number[] | null {
    const candidates: Element[] = [];
    for (let n = el.parentElement; n; n = n.parentElement) candidates.push(n);
    for (const sel of ['.backgroundContainer', '.skinBody']) { const n = document.querySelector(sel); if (n) candidates.push(n); }
    for (const n of candidates) {
        const c = parseColour(getComputedStyle(n).backgroundColor);
        if (c && (c.length === 3 || (c[3] ?? 0) >= 0.95)) return c;
    }
    return null;
}

/**
 * A native menu draws its own popup, which ignores a translucent background: the theme's light text on a default light popup
 * made the options vanish. Take what the theme gives the page (its text colour, and the opaque surface the control sits on) so
 * the popup matches it on any theme; only when those are missing or too close to read does a plain dark or light pair stand
 * in. The date picker's native popup is given the same light or dark scheme (upstream 1de354c0).
 */
function paintPopups(select: HTMLSelectElement, dateInput: HTMLInputElement | null): void {
    const text = parseColour(getComputedStyle(select).color);
    const light = !!text && brightness(text) > 140;
    const surface = opaqueSurface(select);
    const readable = !!text && !!surface && Math.abs(brightness(text) - brightness(surface)) > 90;
    const bg = readable && surface ? `rgb(${surface[0]}, ${surface[1]}, ${surface[2]})` : (light ? '#2b2b2b' : '#ffffff');
    const fg = readable && text ? `rgb(${text[0]}, ${text[1]}, ${text[2]})` : (light ? '#f2f2f2' : '#1a1a1a');
    for (const el of [select, dateInput]) if (el) el.style.colorScheme = light ? 'dark' : 'light';
    for (const option of select.options) { option.style.backgroundColor = bg; option.style.color = fg; }
}

/** Bytes as the cards show them: "4.1 GB", else "350 MB"; empty when unknown. */
function formatSize(bytes: number | null | undefined): string {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '';
    const gb = bytes / 1073741824;
    return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1048576)} MB`;
}

/**
 * A request's poster when the title is not in the library: TMDB's, from a path or a full address on TMDB's image host.
 * Upstream 40738412 takes any full address Reclaimerr names; another host would be a new request from the browser.
 */
function tmdbPoster(path: string | null | undefined): string | null {
    if (!path) return null;
    if (path.startsWith('https://image.tmdb.org/')) return path;
    return path.startsWith('/') ? `https://image.tmdb.org/t/p/w185${path}` : null;
}

/**
 * An administrator's note as the requester reads it: without the "(Approved by NAME in Jellyfin)" the server adds to every review
 * sent from Jellyfin (Reclaimerr records the API token as the reviewer). Upstream 40738412 hid every note that ends " in Jellyfin",
 * which dropped the note too; upstream da3d9ee9 drops only that part, as here.
 */
function requesterNote(note: string | null | undefined): string {
    const text = (note ?? '').trim();
    if (/^(?:Approved|Denied) by .+ in Jellyfin$/.test(text)) return '';
    return text.replace(/ \((?:Approved|Denied) by [^()]+ in Jellyfin\)$/, '');
}

/** Jellyfin's item page for an item (jellyfin-web's router, else the hash). */
function navigateToItem(itemId: string | null | undefined): void {
    if (!itemId) return;
    try {
        const host: Window & { Emby?: { Page?: { showItem?(id: string): void } } } = window;
        if (host.Emby?.Page?.showItem) { host.Emby.Page.showItem(itemId); return; }
    } catch { /* fall through to the hash */ }
    window.location.hash = `#!/details?id=${itemId}`;
}

export function createLeavingSoonPage(JE: TagRuntimeBridge): LeavingSoonPage | null {
    if (JE.pluginConfig?.LeavingSoonPageEnabled !== true) return null;

    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let mounted: HTMLElement | null = null;
    let filter: Filter = 'all';
    /** Until when the refresh icon spins (the list is redrawn, so the new button carries the animation). */
    let spinUntil = 0;
    let loadTicket = 0;
    /** The host the list was last drawn into (a failed reload keeps that list). */
    let drawnHost: HTMLElement | null = null;
    /** Which Reclaimerr the drawn requests came from (the list's `source`); every review sends it back (upstream da3d9ee9). */
    let requestSource: string | null = null;

    const t = (key: string, params?: Readonly<Record<string, unknown>>): string => {
        try { return JE.t(key, params); } catch { return key; }
    };
    const esc = (value: unknown): string => JE.escapeHtml(String(value ?? ''));

    /** Local calendar days from now to a delete time (a DST day is not 24 hours); null when undated. */
    function daysLeft(deleteAt: number | null | undefined): number | null {
        if (typeof deleteAt !== 'number' || !Number.isFinite(deleteAt)) return null;
        const day = (ms: number): number => { const d = new Date(ms); return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS); };
        return day(deleteAt) - day(Date.now());
    }

    /** How long ago, as the Requests page words it ("3d ago", then "23 Nov 2026" after a month); the same strings. */
    function relativeDate(value: string): string {
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '';
        const diff = Date.now() - date.getTime();
        if (diff < 0) return shortDate(date);
        const minutes = Math.floor(diff / 60000), hours = Math.floor(diff / 3600000), days = Math.floor(diff / DAY_MS);
        if (minutes < 1) return t('requests_just_now');
        if (minutes < 60) return t('requests_minutes_ago').replace('{minutes}', String(minutes));
        if (hours < 24) return t('requests_hours_ago').replace('{hours}', String(hours));
        if (days < 30) return t('requests_days_ago').replace('{days}', String(days));
        return shortDate(date);
    }

    /** The chip for an item's delete time. */
    function chip(deleteAt: number | null | undefined): LeavingChip {
        const d = daysLeft(deleteAt);
        if (d === null) return { text: t('leavingsoon_soon'), level: 'soon' };
        if (d <= 0) return { text: t('leavingsoon_today'), level: 'urgent' };
        if (d === 1) return { text: t('leavingsoon_tomorrow'), level: 'urgent' };
        return { text: t('leavingsoon_in_days', { days: d }), level: d <= 7 ? 'warn' : 'soon' };
    }

    function injectStyles(): void {
        // Greys are rgba(128,128,128) so the page reads on dark and light themes alike; text inherits the theme's colour.
        JE.core.ui?.injectCss?.('je-leavingsoon-styles', CSS);
        try { document.documentElement.style.setProperty('--je-ls-accent', JE.themer?.getThemeVariables?.()?.primaryAccent || '#00a4dc'); } catch { /* default accent */ }
    }

    /** The server's list for the signed-in user. */
    async function load(): Promise<LeavingList> {
        const client = apiClient();
        return listOf(await client.ajax({ type: 'GET', url: client.getUrl('JellyfinEnhanced/leaving-soon/list'), dataType: 'json' }));
    }

    /** The server's reason from a refused request ({error}), or its status. */
    async function reasonOf(err: unknown): Promise<string> {
        const failure = isRecord(err) ? err : {};
        try {
            const body: unknown = typeof failure.json === 'function' ? await (failure.json as () => Promise<unknown>)() : null;
            if (isRecord(body) && typeof body.error === 'string' && body.error) return body.error;
        } catch { /* no body */ }
        return typeof failure.status === 'number' ? String(failure.status) : '';
    }

    /**
     * Approve or deny a request; the optional note goes to Reclaimerr (and the requester), `timing` ({when, date, graceDays}) says
     * when an approval is deleted, and the list's source goes along so the server refuses a card read from another Reclaimerr.
     */
    async function review(id: number, approve: boolean, button: HTMLButtonElement, note?: string, timing?: Readonly<Record<string, string | number>> | null): Promise<void> {
        button.disabled = true;
        try {
            const client = apiClient();
            const source = requestSource;
            await client.ajax({ type: 'POST', url: client.getUrl(`JellyfinEnhanced/reclaimerr/requests/${id}/${approve ? 'approve' : 'deny'}`), data: JSON.stringify({ ...(note ? { note } : {}), ...(timing ?? {}), ...(source ? { source } : {}) }), contentType: 'application/json', dataType: 'json' });
            JE.toast?.(esc(t(approve ? 'leavingsoon_approved' : 'leavingsoon_denied')));
            void refresh();
        } catch (err: unknown) {
            JE.toast?.(esc(t('maintainerr_failed', { error: await reasonOf(err) })), 6000);
            button.disabled = false;
        }
    }

    function iconButton(kind: string, icon: string, label: string): HTMLButtonElement {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `je-ls-icon-btn ${kind}`;
        b.title = label;
        b.setAttribute('aria-label', label);
        b.innerHTML = `<i class="material-icons" aria-hidden="true">${esc(icon)}</i>`;
        return b;
    }

    function linkTo(el: HTMLElement, itemId: string | null | undefined): void {
        for (const target of el.querySelectorAll<HTMLElement>('.je-ls-poster, .je-ls-name')) {
            target.addEventListener('click', () => navigateToItem(itemId));
            target.addEventListener('keydown', (e) => { if (e.key === 'Enter') navigateToItem(itemId); });
        }
    }

    function card(item: LeavingItem, data: LeavingList): HTMLElement {
        const c = chip(item.deleteAt);
        const el = document.createElement('div');
        el.className = 'je-ls-card';
        el.dataset.type = String(item.type ?? '');
        const poster = apiClient().getUrl(`Items/${encodeURIComponent(String(item.id))}/Images/Primary`, { maxHeight: 360, quality: 90 });
        const date = typeof item.deleteAt === 'number' && Number.isFinite(item.deleteAt) ? shortDate(new Date(item.deleteAt)) : '';
        const when = [date ? t('leavingsoon_leaves_on', { date }) : '', formatSize(item.size)].filter(Boolean).join(' · ');
        el.innerHTML = `<div class="je-ls-poster" role="link" tabindex="0"><span class="je-ls-fallback material-icons" aria-hidden="true">${item.type === 'Movie' ? 'movie' : 'tv'}</span>`
            + `<img alt="" loading="lazy" src="${esc(poster)}"/></div>`
            + `<div class="je-ls-info"><div class="je-ls-head"><div class="je-ls-name" role="link" tabindex="0" title="${esc(item.name)}">${esc(item.name)}</div>`
            + (item.year ? `<span class="je-ls-year">(${esc(item.year)})</span>` : '') + '</div>'
            + (item.detail ? `<div class="je-ls-sub">${esc(item.detail)}</div>` : '')
            + `<div class="je-ls-badges"><span class="je-ls-chip ${esc(c.level)}">${esc(c.text)}</span>`
            // One file of a movie kept in several versions is leaving; the title and its other versions stay.
            + (item.versionOnly ? `<span class="je-ls-scope">${esc(t('leavingsoon_one_version'))}</span>` : '') + '</div>'
            + (when ? `<div class="je-ls-sub">${esc(when)}</div>` : '')
            + (data.actions ? '<div class="je-ls-actions"></div>' : '') + '</div>';
        const img = el.querySelector('img');
        img?.addEventListener('error', () => img.remove());
        linkTo(el, item.id);
        const actions = el.querySelector('.je-ls-actions');
        if (actions) {
            const reclaimerr = data.provider === 'reclaimerr';
            const keep = iconButton('keep', 'shield', t('maintainerr_keep'));
            keep.addEventListener('click', () => {
                void (JE.removalMenu ?? JE.maintainerrMenu)?.act?.('unmark', { itemId: item.id }, 'maintainerr_kept', reclaimerr ? null : { path: 'mark', body: { itemId: item.id }, doneKey: 'maintainerr_marked' });
            });
            const when = iconButton('date', 'event', t(reclaimerr ? 'reclaimerr_change_date' : 'maintainerr_postpone'));
            when.addEventListener('click', () => (JE.removalMenu ?? JE.maintainerrMenu)?.postpone?.(item.id, { Marked: true, DeleteAt: item.deleteAt ?? null }, when));
            actions.append(keep, when);
        }
        return el;
    }

    /** The poster for a request: the Jellyfin item's own when it is in the library, else TMDB's. */
    function requestPoster(r: LeavingRequest): string | null {
        if (r.itemId) return apiClient().getUrl(`Items/${encodeURIComponent(r.itemId)}/Images/Primary`, { maxHeight: 360, quality: 90 });
        return tmdbPoster(r.posterPath);
    }

    /** What exactly a request would delete when that is less than the whole title: a season, an episode or one movie version. */
    function scopeLabel(r: LeavingRequest): string {
        if (r.scope === 'season' && r.seasonNumber != null) return t('leavingsoon_scope_season', { season: r.seasonNumber });
        if (r.scope === 'episode' && r.episodeNumber != null && r.seasonNumber != null) return t('leavingsoon_scope_episode', { season: r.seasonNumber, episode: r.episodeNumber });
        if (r.scope === 'movie_version') return [t('leavingsoon_scope_version'), r.versionResolution, formatSize(r.versionSize)].filter(Boolean).join(' · ');
        return '';
    }

    /** The state chip of a request. */
    function requestChip(r: LeavingRequest): LeavingChip {
        if (r.executionError || r.scheduleState === 'failed' || r.scheduleState === 'blocked') return { text: t('leavingsoon_status_failed'), level: 'urgent' };
        if (r.deferred) return { text: t('leavingsoon_status_deferred'), level: 'warn' };
        return { text: t(`leavingsoon_status_${r.status}`) || r.status, level: r.status === 'denied' ? 'urgent' : r.status === 'approved' ? 'ok' : 'warn' };
    }

    /**
     * A deletion request as a card in the Requests page's layout: poster (opens the item), title, state, what it would delete
     * (a season, an episode or one version, when not the whole title), who asked (their Jellyfin name and avatar), their note,
     * why a deletion failed, the day an approved one is deleted, and for administrators the Approve and Deny buttons on a
     * pending one. Approving deletes from the library (after Reclaimerr's grace period, now, or on a chosen day), so it asks
     * first, names the scope, offers when, and takes an optional note.
     */
    function requestCard(r: LeavingRequest, admin: boolean, graceDays: number | null = null): HTMLElement {
        const el = document.createElement('div');
        el.className = 'je-ls-card je-ls-reqcard';
        const when = r.createdAt ? relativeDate(r.createdAt) : '';
        const poster = requestPoster(r);
        const person = r.jellyfinUser || r.requestedBy || '';
        const linked = r.itemId ? ' role="link" tabindex="0"' : '';
        const state = requestChip(r);
        const scope = scopeLabel(r);
        const answer = admin ? '' : requesterNote(r.adminNotes);
        // A cancelled (Keep) or finished schedule keeps its old day in Reclaimerr's answer: it no longer says when the title leaves (upstream da3d9ee9).
        const live = r.scheduleState !== 'canceled' && r.scheduleState !== 'completed';
        const leaves = r.scheduledAt && r.status === 'approved' && live ? utcDate(r.scheduledAt) : null;
        const avatar = r.jellyfinUserId ? `<img alt="" src="${esc(apiClient().getUrl(`Users/${encodeURIComponent(r.jellyfinUserId)}/Images/Primary`, { maxHeight: 48, quality: 90 }))}"/>` : '';
        el.innerHTML = `<div class="je-ls-poster${r.itemId ? '' : ' plain'}"${linked}><span class="je-ls-fallback material-icons" aria-hidden="true">${r.mediaType === 'movie' ? 'movie' : 'tv'}</span>`
            + (poster ? `<img alt="" loading="lazy" src="${esc(poster)}"/>` : '') + '</div>'
            + `<div class="je-ls-info"><div class="je-ls-head"><div class="je-ls-name${r.itemId ? '' : ' plain'}"${linked} title="${esc(r.title)}">${esc(r.title)}</div>`
            + (r.year ? `<span class="je-ls-year">(${esc(r.year)})</span>` : '') + '</div>'
            + `<div class="je-ls-badges"><span class="je-ls-chip ${esc(state.level)}">${esc(state.text)}</span>${scope ? `<span class="je-ls-scope">${esc(scope)}</span>` : ''}</div>`
            + `<div class="je-ls-who"${admin && r.requestedBy ? ` title="${esc(t('leavingsoon_reclaimerr_account', { name: r.requestedBy }))}"` : ''}>`
            + (person ? `<span class="je-ls-avatar" aria-hidden="true">${esc(person.charAt(0).toUpperCase())}${avatar}</span><span>${esc(t('leavingsoon_requested_by', { name: person }))}</span>` : '')
            + '</div>'
            + (when ? `<div class="je-ls-sub">${esc(when)}</div>` : '')
            + (leaves && !Number.isNaN(leaves.getTime()) ? `<div class="je-ls-sub">${esc(t('leavingsoon_leaves_on', { date: shortDate(leaves) }))}</div>` : '')
            + (r.note ? `<div class="je-ls-sub je-ls-note">${esc(r.note)}</div>` : '')
            + (answer ? `<div class="je-ls-sub je-ls-note">${esc(answer)}</div>` : '')
            + (r.executionError ? `<div class="je-ls-err">${esc(r.executionError)}</div>` : '')
            + (admin && r.status === 'pending' ? '<div class="je-ls-reqactions"></div>' : '') + '</div>';
        for (const img of el.querySelectorAll('img')) img.addEventListener('error', () => img.remove());
        if (r.itemId) linkTo(el, r.itemId);
        const actions = el.querySelector<HTMLElement>('.je-ls-reqactions');
        if (actions) {
            const box = actions;
            const showChoice = (): void => {
                box.textContent = '';
                const ok = iconButton('approve', 'check', t('leavingsoon_approve'));
                const no = iconButton('deny', 'close', t('leavingsoon_deny'));
                ok.addEventListener('click', showConfirm);
                no.addEventListener('click', () => { void review(r.id, false, no); });
                box.append(ok, no);
            };
            // Approving removes it from the library (after Reclaimerr's grace period, now, or on a day): one more click, with the
            // words (naming the scope when it is less than the title), the choice of when, and an optional note for the requester.
            const deleteText = scope ? t('leavingsoon_confirm_delete_scope', { scope }) : t('leavingsoon_confirm_delete');
            const showConfirm = (): void => {
                box.textContent = '';
                const warn = document.createElement('div');
                warn.className = 'je-ls-warn';
                warn.textContent = deleteText;
                const note = document.createElement('input');
                note.type = 'text';
                note.className = 'je-ls-note-input';
                note.maxLength = 300;
                note.placeholder = t('leavingsoon_note_placeholder');
                note.setAttribute('aria-label', t('leavingsoon_note_placeholder'));
                const row = document.createElement('div');
                row.className = 'je-ls-confirm';
                const yes = document.createElement('button');
                yes.type = 'button';
                yes.className = 'je-ls-btn danger';
                yes.textContent = t('leavingsoon_approve');
                const cancel = document.createElement('button');
                cancel.type = 'button';
                cancel.className = 'je-ls-btn';
                cancel.textContent = t('maintainerr_cancel');
                const when = document.createElement('select');
                when.className = 'je-ls-note-input';
                when.setAttribute('aria-label', t('reclaimerr_schedule_title'));
                const options = [
                    ['default', graceDays !== null && graceDays > 0 ? t('leavingsoon_when_default_days', { days: graceDays }) : t('leavingsoon_when_default')],
                    ['now', t('leavingsoon_delete_now')],
                    ['date', t('leavingsoon_when_date')],
                ] as const;
                for (const [value, label] of options) {
                    const option = document.createElement('option');
                    option.value = value;
                    option.textContent = label;
                    when.appendChild(option);
                }
                const day = document.createElement('input');
                day.type = 'datetime-local';
                day.className = 'je-ls-note-input';
                day.hidden = true;
                day.min = localInput(new Date(Date.now() + 60000));
                day.value = localInput(new Date(Date.now() + 7 * DAY_MS));
                day.setAttribute('aria-label', t('leavingsoon_when_date'));
                const sync = (): void => {
                    day.hidden = when.value !== 'date';
                    const picked = new Date(day.value);
                    const valid = when.value !== 'date' || (day.value !== '' && !Number.isNaN(picked.getTime()) && picked.getTime() > Date.now());
                    yes.disabled = !valid;
                    warn.textContent = when.value === 'now' ? deleteText
                        : when.value === 'date' ? (valid ? t('leavingsoon_confirm_on', { date: shortDate(picked) }) : '')
                        : graceDays === 0 ? deleteText
                        : graceDays !== null && graceDays > 0 ? t('leavingsoon_confirm_on', { date: shortDate(new Date(Date.now() + graceDays * DAY_MS)) })
                        : t('leavingsoon_confirm_grace');
                };
                when.addEventListener('change', sync);
                day.addEventListener('input', sync);
                sync();
                yes.addEventListener('click', () => {
                    // The grace period this confirm promised goes along: the server refuses when Reclaimerr's setting changed since.
                    const timing = when.value === 'date' ? { when: 'date', date: new Date(day.value).toISOString() }
                        : when.value === 'default' && graceDays !== null ? { when: 'default', graceDays } : { when: when.value };
                    void review(r.id, true, yes, note.value.trim(), timing);
                });
                cancel.addEventListener('click', showChoice);
                row.append(yes, cancel);
                box.append(warn, when, day, note, row);
                paintPopups(when, day);
            };
            showChoice();
        }
        return el;
    }

    function section(icon: string, title: string, rows: readonly LeavingRequest[], admin: boolean, data?: LeavingList): HTMLElement {
        const sec = document.createElement('div');
        sec.className = 'je-ls-section';
        sec.innerHTML = `<h3><span class="material-icons" aria-hidden="true">${esc(icon)}</span>${esc(title)}</h3>`;
        const grid = document.createElement('div');
        grid.className = 'je-ls-grid';
        for (const r of rows) grid.appendChild(requestCard(r, admin, data?.graceDays ?? null));
        sec.appendChild(grid);
        return sec;
    }

    /** A button whose text is a translated label. */
    function textButton(className: string, label: string): HTMLButtonElement {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = className;
        b.textContent = label;
        return b;
    }

    /** The heading row: title and count, the movie/show filter, and Refresh. Built from elements, so nothing is looked up. */
    function topBar(host: HTMLElement, data: LeavingList): HTMLElement {
        const items = data.items;
        const top = document.createElement('div');
        top.className = 'je-ls-top';
        const title = document.createElement('h2');
        title.className = 'je-ls-title';
        title.innerHTML = '<span class="material-icons" aria-hidden="true">auto_delete</span>';
        const heading = document.createElement('span');
        heading.className = 'je-ls-heading';
        heading.textContent = t('leavingsoon_title');
        const count = document.createElement('span');
        count.className = 'je-ls-count';
        count.textContent = `${items.length} ${t(items.length === 1 ? 'leavingsoon_item' : 'leavingsoon_items')}`;
        heading.appendChild(count);
        title.appendChild(heading);
        const spacer = document.createElement('span');
        spacer.className = 'je-ls-spacer';
        const pills = document.createElement('div');
        pills.className = 'je-ls-pills';
        if (items.length) {
            for (const [key, label] of [['all', 'leavingsoon_all'], ['movies', 'leavingsoon_movies'], ['shows', 'leavingsoon_shows']] as const) {
                const b = textButton(`je-ls-pill${filter === key ? ' active' : ''}`, t(label));
                b.addEventListener('click', () => { filter = key; draw(host, data); });
                pills.appendChild(b);
            }
        }
        const refreshButton = document.createElement('button');
        refreshButton.type = 'button';
        refreshButton.className = `je-ls-refresh${Date.now() < spinUntil ? ' spin' : ''}`;
        refreshButton.dataset.refresh = '';
        refreshButton.title = t('leavingsoon_refresh');
        refreshButton.setAttribute('aria-label', t('leavingsoon_refresh'));
        refreshButton.innerHTML = '<i class="material-icons" aria-hidden="true">refresh</i>';
        refreshButton.addEventListener('click', () => { spinUntil = Date.now() + 600; void refresh(); });
        top.append(title, spacer, pills, refreshButton);
        return top;
    }

    function draw(host: HTMLElement, data: LeavingList): void {
        host.textContent = '';
        requestSource = data.source;
        const root = document.createElement('div');
        root.className = 'je-ls';
        const items = data.items;
        const shown = items.filter((i) => filter === 'all' || (filter === 'movies' ? i.type === 'Movie' : i.type !== 'Movie'));
        root.appendChild(topBar(host, data));
        if (!shown.length) {
            const empty = document.createElement('div');
            empty.className = 'je-ls-empty';
            empty.textContent = t(items.length ? 'leavingsoon_none_here' : 'leavingsoon_none');
            root.appendChild(empty);
        } else {
            const grid = document.createElement('div');
            grid.className = 'je-ls-grid';
            for (const item of shown) grid.appendChild(card(item, data));
            root.appendChild(grid);
        }
        if (data.requestsUnavailable) {
            const notice = document.createElement('div');
            notice.className = 'je-ls-notice';
            // Administrators get Reclaimerr's reason instead of the refresh advice (a scope the token lacks is not fixed by
            // refreshing); the server sends it to them only.
            notice.textContent = data.admin && data.requestsError ? t('leavingsoon_requests_unavailable_reason', { reason: data.requestsError }) : t('leavingsoon_requests_unavailable');
            root.appendChild(notice);
        }
        if (data.admin && data.requests.length) root.appendChild(section('inbox', t('leavingsoon_requests_title', { count: data.requests.length }), data.requests, true, data));
        if (!data.admin && data.mine.length) root.appendChild(section('outbox', t('leavingsoon_my_requests'), data.mine, false));
        host.appendChild(root);
        drawnHost = host;
    }

    async function refresh(): Promise<void> {
        if (!mounted) return;
        const ticket = ++loadTicket;
        const lease = JE.session?.createLease?.();
        try {
            const data = await load();
            // A newer load, another mount, or another user signed in meanwhile: this answer is not theirs to draw.
            if (ticket === loadTicket && mounted && (!lease || lease.isCurrent())) draw(mounted, data);
        } catch (err: unknown) {
            console.warn(LOG, 'could not load the list:', err);
            // Unknown is not "nothing": a failed first load says so; a failed reload keeps the last list.
            if (ticket === loadTicket && mounted && drawnHost !== mounted) mounted.textContent = t('leavingsoon_unavailable');
        }
    }

    const onChanged = (): void => { void refresh(); };

    function stopPolling(): void {
        if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
        window.removeEventListener('je-leaving-soon-changed', onChanged);
    }

    function renderForCustomTab(host: HTMLElement): void {
        stopPolling();
        // One poller, one host: the host it leaves (a Plugin Pages page under a Custom Tabs panel) is emptied.
        if (mounted && mounted !== host) mounted.replaceChildren();
        mounted = host;
        drawnHost = null;
        injectStyles();
        host.textContent = t('leavingsoon_loading');
        void refresh();
        // A data poll: what is leaving changes on the server's schedule. Leaving the page stops it (the custom tab, the
        // Plugin Pages page and the navigation hook below call stopPolling).
        pollTimer = setInterval(() => { void refresh(); }, POLL_MS);
        // An action taken here or from the item menu (keep, change date) changes the list.
        window.addEventListener('je-leaving-soon-changed', onChanged);
    }

    // A host that left the document (its view was rebuilt or closed) stops the poller at the next navigation.
    JE.core.navigation?.onNavigate?.(() => { if (mounted && !mounted.isConnected) { stopPolling(); mounted = null; } });

    const page: LeavingSoonPage = { injectStyles, renderForCustomTab, stopPolling, chip, daysLeft };
    JE.leavingSoonPage = page;
    // Another user signed in: the page they open next loads their own list.
    JE.session?.onUserChange?.('leaving-soon-page', () => { loadTicket++; });
    return page;
}
