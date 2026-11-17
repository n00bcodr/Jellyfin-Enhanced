import { apiClient, type TagRuntimeBridge } from '../host';
import { isRecord } from '../pipeline/dto';
import CSS from './leaving-soon-page.css';

// The Leaving soon page (upstream da0ea773, extras/leavingsoon-page.js): everything the removal tool (Maintainerr or
// Reclaimerr, whichever is on) will remove, with the days left, for every user (only items they can see: the server's
// leaving-soon/list leaves the others out). Administrators can also keep an item or change its date from here (the
// item menu's actions, JE.removalMenu), and with Reclaimerr see the pending deletion requests to approve or deny;
// anyone else sees their own requests and their state. JE.leavingSoonPage = { injectStyles, renderForCustomTab,
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
    };
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

    /** The chip for an item's delete time. */
    function chip(deleteAt: number | null | undefined): LeavingChip {
        const d = daysLeft(deleteAt);
        if (d === null) return { text: t('leavingsoon_soon'), level: 'soon' };
        if (d <= 0) return { text: t('leavingsoon_today'), level: 'urgent' };
        if (d === 1) return { text: t('leavingsoon_tomorrow'), level: 'urgent' };
        return { text: t('leavingsoon_in_days', { days: d }), level: d <= 7 ? 'warn' : 'soon' };
    }

    function injectStyles(): void {
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

    async function review(id: number, approve: boolean, button: HTMLButtonElement): Promise<void> {
        button.disabled = true;
        try {
            const client = apiClient();
            await client.ajax({ type: 'POST', url: client.getUrl(`JellyfinEnhanced/reclaimerr/requests/${id}/${approve ? 'approve' : 'deny'}`), data: JSON.stringify({}), contentType: 'application/json', dataType: 'json' });
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
        // One file of a movie kept in several versions is leaving; the title and its other versions stay.
        const sub = [item.detail, item.year, item.versionOnly ? t('leavingsoon_one_version') : null].filter(Boolean).join(' · ');
        const poster = apiClient().getUrl(`Items/${encodeURIComponent(String(item.id))}/Images/Primary`, { maxHeight: 420, quality: 90 });
        el.innerHTML = '<div class="je-ls-poster" role="link" tabindex="0"><span class="je-ls-fallback material-icons" aria-hidden="true">movie</span>'
            + `<img alt="" loading="lazy" src="${esc(poster)}"/>`
            + `<span class="je-ls-chip ${esc(c.level)}">${esc(c.text)}</span></div>`
            + `<div class="je-ls-name" role="link" tabindex="0">${esc(item.name)}</div>`
            + (sub ? `<div class="je-ls-sub">${esc(sub)}</div>` : '')
            + (data.actions ? '<div class="je-ls-actions"></div>' : '');
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
        if (r.itemId) return apiClient().getUrl(`Items/${encodeURIComponent(r.itemId)}/Images/Primary`, { maxHeight: 220, quality: 90 });
        return r.posterPath ? `https://image.tmdb.org/t/p/w185${r.posterPath}` : null;
    }

    /**
     * A deletion request as a card like the leaving cards: poster (opens the item), title, who asked (their Jellyfin
     * name and avatar), their note, and for administrators the Approve and Deny buttons. Approving deletes the title
     * from the library at once (Reclaimerr acts on approval), so it asks first.
     */
    function requestCard(r: LeavingRequest, admin: boolean): HTMLElement {
        const el = document.createElement('div');
        el.className = 'je-ls-card je-ls-reqcard';
        const when = r.createdAt ? new Date(r.createdAt).toLocaleDateString() : '';
        const poster = requestPoster(r);
        const person = r.jellyfinUser || r.requestedBy || '';
        const linked = r.itemId ? ' role="link" tabindex="0"' : '';
        const statusText = t(`leavingsoon_status_${r.status}`);
        const avatar = r.jellyfinUserId ? `<img alt="" src="${esc(apiClient().getUrl(`Users/${encodeURIComponent(r.jellyfinUserId)}/Images/Primary`, { maxHeight: 48, quality: 90 }))}"/>` : '';
        el.innerHTML = `<div class="je-ls-poster${r.itemId ? '' : ' plain'}"${linked}><span class="je-ls-fallback material-icons" aria-hidden="true">${r.mediaType === 'movie' ? 'movie' : 'tv'}</span>`
            + (poster ? `<img alt="" loading="lazy" src="${esc(poster)}"/>` : '')
            + (admin ? '' : `<span class="je-ls-chip ${r.status === 'denied' ? 'urgent' : r.status === 'approved' ? 'ok' : 'warn'}">${esc(statusText || r.status)}</span>`) + '</div>'
            + `<div class="je-ls-name${r.itemId ? '' : ' plain'}"${linked}>${esc(r.title)}</div>`
            + (r.year ? `<div class="je-ls-sub">${esc(r.year)}</div>` : '')
            + `<div class="je-ls-who"${admin && r.requestedBy ? ` title="${esc(t('leavingsoon_reclaimerr_account', { name: r.requestedBy }))}"` : ''}>`
            + (person ? `<span class="je-ls-avatar" aria-hidden="true">${esc(person.charAt(0).toUpperCase())}${avatar}</span><span>${esc(t('leavingsoon_requested_by', { name: person }))}</span>` : '')
            + '</div>'
            + (when ? `<div class="je-ls-sub">${esc(when)}</div>` : '')
            + (r.note ? `<div class="je-ls-sub je-ls-note">${esc(r.note)}</div>` : '')
            + (admin ? '<div class="je-ls-reqactions"></div>' : '');
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
            // Approving removes the title from the library now: one more click, with the words.
            const showConfirm = (): void => {
                box.textContent = '';
                const warn = document.createElement('div');
                warn.className = 'je-ls-warn';
                warn.textContent = t('leavingsoon_confirm_delete');
                const row = document.createElement('div');
                row.className = 'je-ls-confirm';
                const yes = document.createElement('button');
                yes.type = 'button';
                yes.className = 'je-ls-btn danger';
                yes.textContent = t('leavingsoon_delete_now');
                const cancel = document.createElement('button');
                cancel.type = 'button';
                cancel.className = 'je-ls-btn';
                cancel.textContent = t('maintainerr_cancel');
                yes.addEventListener('click', () => { void review(r.id, true, yes); });
                cancel.addEventListener('click', showChoice);
                row.append(yes, cancel);
                box.append(warn, row);
            };
            showChoice();
        }
        return el;
    }

    function section(icon: string, title: string, rows: readonly LeavingRequest[], admin: boolean): HTMLElement {
        const sec = document.createElement('div');
        sec.className = 'je-ls-section';
        sec.innerHTML = `<h3><span class="material-icons" aria-hidden="true">${esc(icon)}</span>${esc(title)}</h3>`;
        const grid = document.createElement('div');
        grid.className = 'je-ls-grid';
        for (const r of rows) grid.appendChild(requestCard(r, admin));
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
        if (data.admin && data.requests.length) root.appendChild(section('inbox', t('leavingsoon_requests_title', { count: data.requests.length }), data.requests, true));
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
