import { captureIdentity, isSameIdentity, type BodyMutationCallback, type ChromeLifecycle, type ChromeSession, type IdentityClient, type IdentitySnapshot, type Unsubscribe } from './host';
import { ACTIVE_STREAMS_CSS } from './active-streams-styles';

/** Live Active Streams counter and sessions panel in the Jellyfin header (and the player OSD bar). */
export interface ActiveStreamsBridge {
    pluginConfig?: { ActiveStreamsEnabled?: unknown; ActiveStreamsAllUsers?: unknown };
    helpers?: {
        isAdmin?(): boolean;
        onBodyMutation?(id: string, callback: BodyMutationCallback): Unsubscribe;
        getHeaderButtonTray?(): HTMLElement | null;
        getHeaderBottom?(): number;
    };
    themer?: { getThemeVariables?(): { primaryAccent?: string } | null | undefined };
    t?: (key: string) => string;
    takePrefetched?: (name: string, maxAgeMs: number) => unknown;
    isVideoPage?: () => boolean;
    session?: ChromeSession;
    core: {
        api: { plugin(path: string, options?: { method?: string; body?: unknown; skipRetry?: boolean }): Promise<unknown> };
        lifecycle: { register(name: string): ChromeLifecycle };
        navigation: { onNavigate(callback: () => void): () => void };
    };
    activeStreams?: { initialize(): void; destroy(): void };
}
export interface ActiveStreamsClient extends IdentityClient {
    getImageUrl(id: string, options: { type: string; tag: string; height: number; quality: number }): string;
    getUrl(path: string): string;
}
interface StreamsWindow extends Window { Emby?: { Page?: { showItem?(id: string): void } } }

/** The server's GET active-streams/sessions projection, validated at the boundary. */
export interface StreamSession {
    UserId?: string | undefined; UserName?: string | undefined; UserHasPrimaryImage?: boolean | undefined; Client?: string | undefined; DeviceName?: string | undefined;
    RemoteEndPoint?: string | undefined;
    NowPlayingItem?: {
        Id?: string | undefined; Name?: string | undefined; SeriesName?: string | undefined; RunTimeTicks?: number | undefined; ProductionYear?: number | undefined;
        ParentIndexNumber?: number | undefined; IndexNumber?: number | undefined; ImageTags?: Record<string, string> | undefined;
        SeriesId?: string | undefined; SeriesPrimaryImageTag?: string | undefined; MediaStreams?: Array<{ Type?: string | undefined; Codec?: string | undefined; BitRate?: number | undefined }> | undefined;
    } | undefined;
    PlayState?: { IsPaused?: boolean | undefined; PositionTicks?: number | undefined; PlayMethod?: string | undefined } | undefined;
    TranscodingInfo?: {
        IsVideoDirect?: boolean | undefined; VideoCodec?: string | undefined; AudioCodec?: string | undefined; Bitrate?: number | undefined; TranscodeReasons?: string[] | undefined;
        CompletionPercentage?: number | undefined; Width?: number | undefined; Height?: number | undefined; Framerate?: number | undefined;
    } | undefined;
}
export interface BroadcastResult { sent: number; skipped: number; errors: string[] }

const LOG = '🪼 Jellyfin Enhanced:';
// The page-load bootstrap's copy is used for the first count only when at most this old.
const PREFETCHED_SESSIONS_MAX_AGE_MS = 5000;

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const num = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const bool = (value: unknown): boolean | undefined => typeof value === 'boolean' ? value : undefined;
function compact<T extends object>(value: T): T {
    for (const key of Object.keys(value) as Array<keyof T>) if (value[key] === undefined) delete value[key];
    return value;
}
function sub<T extends object>(value: unknown, decode: (record: Json) => T): T | undefined {
    return isRecord(value) ? compact(decode(value)) : undefined;
}

/** Decode one session; fields of the wrong type are dropped rather than rendered. */
export function decodeSession(value: unknown): StreamSession | null {
    if (!isRecord(value)) return null;
    return compact<StreamSession>({
        UserId: str(value.UserId), UserName: str(value.UserName), UserHasPrimaryImage: bool(value.UserHasPrimaryImage),
        Client: str(value.Client), DeviceName: str(value.DeviceName), RemoteEndPoint: str(value.RemoteEndPoint),
        NowPlayingItem: sub(value.NowPlayingItem, item => ({
            Id: str(item.Id), Name: str(item.Name), SeriesName: str(item.SeriesName), RunTimeTicks: num(item.RunTimeTicks),
            ProductionYear: num(item.ProductionYear), ParentIndexNumber: num(item.ParentIndexNumber), IndexNumber: num(item.IndexNumber),
            ImageTags: isRecord(item.ImageTags)
                ? Object.fromEntries(Object.entries(item.ImageTags).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
                : undefined,
            SeriesId: str(item.SeriesId), SeriesPrimaryImageTag: str(item.SeriesPrimaryImageTag),
            MediaStreams: Array.isArray(item.MediaStreams)
                ? item.MediaStreams.filter(isRecord).map(stream => compact({ Type: str(stream.Type), Codec: str(stream.Codec), BitRate: num(stream.BitRate) }))
                : undefined
        })),
        PlayState: sub(value.PlayState, state => ({ IsPaused: bool(state.IsPaused), PositionTicks: num(state.PositionTicks), PlayMethod: str(state.PlayMethod) })),
        TranscodingInfo: sub(value.TranscodingInfo, info => ({
            IsVideoDirect: bool(info.IsVideoDirect), VideoCodec: str(info.VideoCodec), AudioCodec: str(info.AudioCodec),
            Bitrate: num(info.Bitrate), CompletionPercentage: num(info.CompletionPercentage),
            TranscodeReasons: Array.isArray(info.TranscodeReasons) ? info.TranscodeReasons.filter((reason): reason is string => typeof reason === 'string') : undefined,
            Width: num(info.Width), Height: num(info.Height), Framerate: num(info.Framerate)
        }))
    });
}
/** A non-array body is a failed read, not "no streams". */
export function decodeSessions(value: unknown): StreamSession[] | null {
    if (!Array.isArray(value)) return null;
    return value.map(decodeSession).filter((session): session is StreamSession => session !== null);
}
export function decodeBroadcast(value: unknown): BroadcastResult {
    if (!isRecord(value)) throw new Error('Invalid broadcast response');
    const sent = num(value.sent), skipped = num(value.skipped);
    if (sent === undefined || skipped === undefined) throw new Error('Invalid broadcast response');
    const errors = Array.isArray(value.errors) ? value.errors.map(String) : [];
    return { sent, skipped, errors };
}

export function ticksToTime(ticks: number | undefined): string {
    if (!ticks) return '0:00';
    const total = Math.floor(ticks / 10000000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
}
const bitrate = (bits: number): string => {
    const kbps = Math.round(bits / 1000);
    return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${kbps} kbps`;
};
/** Badge labels and classes for a session, in display order. */
export function sessionBadges(session: StreamSession): Array<{ label: string; cls: string }> {
    const badges: Array<{ label: string; cls: string }> = [];
    const ts = session.TranscodingInfo;
    const ps = session.PlayState || {};
    if (ts && ts.IsVideoDirect === false) {
        badges.push({ label: 'Transcoding', cls: 'je-as-badge-transcode' });
        if (ts.VideoCodec) badges.push({ label: ts.VideoCodec.toUpperCase(), cls: 'je-as-badge-neutral' });
        if (ts.AudioCodec) badges.push({ label: ts.AudioCodec.toUpperCase(), cls: 'je-as-badge-neutral' });
        if (ts.Bitrate) badges.push({ label: bitrate(ts.Bitrate), cls: 'je-as-badge-neutral' });
        if (ts.Width && ts.Height) badges.push({ label: `${ts.Width}×${ts.Height}`, cls: 'je-as-badge-neutral' });
        if (ts.Framerate) badges.push({ label: `${Math.round(ts.Framerate)}fps`, cls: 'je-as-badge-neutral' });
    } else {
        badges.push({ label: 'Direct Play', cls: 'je-as-badge-direct' });
        const stream = session.NowPlayingItem?.MediaStreams?.find(s => s.Type === 'Video');
        if (stream?.Codec) badges.push({ label: stream.Codec.toUpperCase(), cls: 'je-as-badge-neutral' });
        if (stream?.BitRate) badges.push({ label: bitrate(stream.BitRate), cls: 'je-as-badge-neutral' });
    }
    if (ps.PlayMethod === 'Transcode' && ts?.TranscodeReasons?.length) {
        const streams = session.NowPlayingItem?.MediaStreams || [];
        for (const raw of ts.TranscodeReasons) {
            badges.push({ label: raw.replace(/([A-Z])/g, ' $1').trim(), cls: 'je-as-badge-reason' });
            // A codec conversion arrow for codec-related reasons.
            const pair = raw === 'AudioCodecNotSupported' ? [streams.find(s => s.Type === 'Audio')?.Codec, ts.AudioCodec]
                : raw === 'VideoCodecNotSupported' ? [streams.find(s => s.Type === 'Video')?.Codec, ts.VideoCodec] : null;
            const [source, target] = pair ?? [];
            if (source && target && source.toLowerCase() !== target.toLowerCase()) {
                badges.push({ label: `${source.toUpperCase()} → ${target.toUpperCase()}`, cls: 'je-as-badge-reason' });
            }
        }
    }
    return badges;
}
/** Header counter state for a successful read. */
export function counterState(sessions: StreamSession[]): { icon: string; sup: string; active: boolean; title: string } {
    const playing = sessions.filter(s => s.NowPlayingItem && !s.PlayState?.IsPaused);
    const paused = sessions.filter(s => s.NowPlayingItem && s.PlayState?.IsPaused);
    const total = playing.length + paused.length;
    if (total === 0) return { icon: 'play_circle', sup: '', active: false, title: 'No active streams' };
    if (playing.length === 0) return { icon: 'pause_circle', sup: `${total}`, active: true, title: `${total} stream${total > 1 ? 's' : ''} paused` };
    if (total === 1) return { icon: 'person', sup: '1', active: true, title: '1 active stream' };
    const pausedNote = paused.length ? `, ${paused.length} paused` : '';
    return { icon: 'group', sup: `${total}`, active: true, title: `${playing.length} playing${pausedNote}` };
}
/** The pluralised panel title from the `{count} Active Stream|{count} Active Streams` template. */
export function countTitle(template: string, count: number): string {
    const parts = template.split('|');
    const singular = parts[0] || '{count} Active Stream';
    const plural = parts[1] || parts[0] || '{count} Active Streams';
    return (count === 1 ? singular : plural).replace('{count}', String(count));
}

export function createActiveStreams(JE: ActiveStreamsBridge, readClient: () => ActiveStreamsClient | undefined) {
    const host: StreamsWindow = window;
    let panelOpen = false;
    let observer: Unsubscribe | null = null;
    let lifecycle: ChromeLifecycle | null = null;
    let outsideClickListener: ((event: MouseEvent) => void) | null = null;
    let lastUpdated: Date | null = null;
    let headerPanelTop = '';
    let broadcastFormOpen = false;
    let broadcastCollapseTimer: number | null = null;
    /** Bumped by destroy(): in-flight reads and retries of a torn-down instance must not touch the next one's DOM. */
    let generation = 0;
    /** The account (and its admin view) the current instance was built for (CHR-STREAMS-1). */
    let owner: IdentitySnapshot | null = null;
    let ownerIsAdmin = false;

    const t = (key: string, fallback: string): string => JE.t?.(key) || fallback;
    const currentIdentity = (): IdentitySnapshot => captureIdentity(JE.session, readClient());
    const isAdmin = (): boolean => JE.helpers?.isAdmin?.() === true;
    /** Admins always see it; non-admins only with ActiveStreamsAllUsers. */
    const isVisible = (): boolean => isAdmin() || JE.pluginConfig?.ActiveStreamsAllUsers === true;
    /** The instance still belongs to the signed-in account. */
    const ownerCurrent = (): boolean => owner !== null && isSameIdentity(owner, currentIdentity());

    function accentColor(): string {
        try { return JE.themer?.getThemeVariables?.()?.primaryAccent || '#00a4dc'; }
        catch { return '#00a4dc'; }
    }
    const applyThemeVars = (): void => { document.documentElement.style.setProperty('--je-as-accent', accentColor()); };

    function injectStyles(): void {
        if (document.getElementById('je-active-streams-styles')) return;
        const style = document.createElement('style');
        style.id = 'je-active-streams-styles';
        style.textContent = ACTIVE_STREAMS_CSS;
        document.head.appendChild(style);
    }

    /**
     * The now-playing sessions through the plugin proxy (non-admins need no Sessions permission).
     * Only the initial count accepts the bootstrap's fresh copy; opens and refreshes ask the server.
     */
    async function fetchSessions(usePrefetched: boolean): Promise<StreamSession[] | null> {
        if (usePrefetched) {
            const prefetched = decodeSessions(JE.takePrefetched?.('ActiveStreamSessions', PREFETCHED_SESSIONS_MAX_AGE_MS));
            if (prefetched) return prefetched;
        }
        try { return decodeSessions(await JE.core.api.plugin('/active-streams/sessions')); }
        catch { return null; }
    }

    function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (text !== undefined) element.textContent = text;
        return element;
    }
    function materialIcon(name: string, size?: string): HTMLSpanElement {
        const icon = el('span', 'material-icons', name);
        if (size) icon.style.fontSize = size;
        return icon;
    }

    function showItem(id: string): void {
        try {
            if (host.Emby?.Page?.showItem) host.Emby.Page.showItem(id);
            else window.location.hash = `#!/details?id=${id}`;
        } catch {
            window.location.hash = `#!/details?id=${id}`;
        }
    }

    function buildSessionCard(session: StreamSession, item: NonNullable<StreamSession['NowPlayingItem']>): HTMLElement {
        const client = readClient();
        const ps = session.PlayState || {};
        const title = item.SeriesName || item.Name || 'Unknown';
        const subtitle = item.SeriesName
            ? `S${String(item.ParentIndexNumber || 0).padStart(2, '0')}E${String(item.IndexNumber || 0).padStart(2, '0')} · ${item.Name}`
            : (item.ProductionYear ? String(item.ProductionYear) : '');
        const pos = ps.PositionTicks || 0;
        const dur = item.RunTimeTicks || 0;
        const pct = dur ? Math.min(100, (pos / dur) * 100).toFixed(1) : 0;
        const card = el('div', 'je-as-card je-as-card-with-poster');
        const placeholder = (): HTMLElement => el('div', 'je-as-poster-placeholder');
        // Episodes prefer the series poster over the episode thumbnail.
        const useSeries = !!(item.SeriesId && item.SeriesPrimaryImageTag);
        const posterId = useSeries ? item.SeriesId : item.Id;
        const posterTag = useSeries ? item.SeriesPrimaryImageTag : item.ImageTags?.Primary;
        if (posterTag && posterId && client) {
            const poster = el('img', 'je-as-poster');
            poster.alt = '';
            poster.loading = 'lazy';
            poster.src = client.getImageUrl(posterId, { type: 'Primary', tag: posterTag, height: 120, quality: 80 });
            poster.addEventListener('error', () => { poster.replaceWith(placeholder()); });
            card.appendChild(poster);
        } else {
            card.appendChild(placeholder());
        }
        const main = el('div', 'je-as-card-main');
        const top = el('div', 'je-as-card-top');
        const info = el('div', 'je-as-card-info');
        const titleEl = el('div', 'je-as-card-title');
        const itemId = item.Id;
        if (itemId && client) {
            const link = el('a', 'je-as-card-title-link', title);
            link.href = '#';
            link.addEventListener('click', event => { event.preventDefault(); showItem(itemId); });
            titleEl.appendChild(link);
        } else {
            titleEl.textContent = title;
        }
        info.appendChild(titleEl);
        if (subtitle) info.appendChild(el('div', 'je-as-card-subtitle', subtitle));
        const state = el('span', `je-as-state ${ps.IsPaused ? 'je-as-state-paused' : 'je-as-state-playing'}`,
            ps.IsPaused ? t('downloads_status_paused', 'Paused') : t('toast_playing', 'Playing'));
        top.appendChild(info);
        top.appendChild(state);
        main.appendChild(top);
        const ts = session.TranscodingInfo;
        if (dur) {
            const progressRow = el('div', 'je-as-progress-row');
            const bar = el('div', 'je-as-progress-bar');
            // Transcoding buffer: amber layer behind the playback position.
            if (ts && ts.CompletionPercentage != null) {
                const transcodeFill = el('div', 'je-as-transcode-fill');
                transcodeFill.style.width = `${Math.min(100, ts.CompletionPercentage).toFixed(1)}%`;
                bar.appendChild(transcodeFill);
            }
            const fill = el('div', 'je-as-progress-fill');
            fill.style.width = `${pct}%`;
            bar.appendChild(fill);
            progressRow.appendChild(bar);
            progressRow.appendChild(el('span', 'je-as-progress-time', `${ticksToTime(pos)} / ${ticksToTime(dur)}`));
            main.appendChild(progressRow);
        }
        const badgesRow = el('div', 'je-as-badges');
        for (const badge of sessionBadges(session)) badgesRow.appendChild(el('span', `je-as-badge ${badge.cls}`, badge.label));
        main.appendChild(badgesRow);
        const userRow = el('div', 'je-as-user');
        if (session.UserId && session.UserHasPrimaryImage && client) {
            const img = el('img', 'je-as-avatar');
            img.alt = '';
            img.src = client.getUrl(`Users/${session.UserId}/Images/Primary`) + '?height=20&quality=80';
            const fallback = materialIcon('person');
            fallback.style.display = 'none';
            img.addEventListener('error', () => { img.style.display = 'none'; fallback.style.display = 'inline'; });
            userRow.appendChild(img);
            userRow.appendChild(fallback);
        } else {
            userRow.appendChild(materialIcon('person'));
        }
        userRow.appendChild(el('span', undefined, [session.UserName, session.Client, session.DeviceName].filter(Boolean).join(' · ')));
        main.appendChild(userRow);
        // RemoteEndPoint is null for non-admins (stripped server-side).
        if (session.RemoteEndPoint) {
            const ipRow = el('div', 'je-as-user');
            ipRow.appendChild(materialIcon('router'));
            ipRow.appendChild(el('span', undefined, session.RemoteEndPoint));
            main.appendChild(ipRow);
        }
        card.appendChild(main);
        return card;
    }

    function renderPanel(sessions: StreamSession[] | null): void {
        const panel = document.getElementById('je-active-streams-panel');
        if (!panel) return;
        const active = (sessions || []).filter(s => s.NowPlayingItem);
        const titleEl = panel.querySelector('.je-as-panel-title');
        if (titleEl) {
            titleEl.textContent = sessions === null ? t('active_streams_unavailable', 'Sessions unavailable') : active.length
                ? countTitle(t('active_streams_count', '{count} Active Stream|{count} Active Streams'), active.length)
                : t('active_streams_none', 'No Active Streams');
        }
        const body = panel.querySelector('.je-as-panel-body');
        if (!body) return;
        body.replaceChildren();
        if (sessions === null) {
            body.appendChild(el('div', 'je-as-panel-error', t('active_streams_load_failed', 'Could not load active streams. Try refreshing.')));
        } else if (!active.length) {
            body.appendChild(el('div', 'je-as-panel-empty', t('active_streams_none', 'No active streams')));
        } else {
            for (const session of active) if (session.NowPlayingItem) body.appendChild(buildSessionCard(session, session.NowPlayingItem));
        }
        let footer = panel.querySelector('.je-as-panel-footer');
        if (!footer) {
            footer = el('div', 'je-as-panel-footer');
            panel.appendChild(footer);
        }
        if (sessions === null) footer.textContent = lastUpdated ? t('active_streams_last_success', 'Last successful update: {time}').replace('{time}', lastUpdated.toLocaleTimeString()) : '';
        else if (lastUpdated) footer.textContent = `Updated ${lastUpdated.toLocaleTimeString()}`;
    }

    /** Refresh the header counter, and the panel when open, from one read. */
    async function updateCounter(usePrefetched = false): Promise<void> {
        const startGeneration = generation;
        const sessions = await fetchSessions(usePrefetched);
        // Torn down, re-initialized or signed into another account mid-read.
        if (startGeneration !== generation || !ownerCurrent()) return;
        if (sessions !== null) lastUpdated = new Date();
        const btn = document.getElementById('je-active-streams');
        if (!btn) return;
        const iconEl = btn.querySelector('.je-as-icon');
        const supEl = btn.querySelector('.je-as-sup');
        btn.classList.remove('je-as-active', 'je-as-err');
        if (!sessions) {
            if (iconEl) iconEl.textContent = 'cast';
            if (supEl) supEl.textContent = '';
            btn.classList.add('je-as-err');
            btn.title = 'Failed to fetch sessions';
        } else {
            const state = counterState(sessions);
            if (iconEl) iconEl.textContent = state.icon;
            if (supEl) supEl.textContent = state.sup;
            if (state.active) btn.classList.add('je-as-active');
            btn.title = state.title;
        }
        if (panelOpen) renderPanel(sessions);
    }

    interface BroadcastForm {
        button: HTMLButtonElement; form: HTMLElement; result: HTMLElement;
        text: HTMLTextAreaElement; header: HTMLInputElement; timeout: HTMLInputElement;
    }
    function resetForm(view: BroadcastForm): void {
        view.result.className = 'je-as-broadcast-result';
        view.result.textContent = '';
        view.text.value = '';
        view.header.value = '';
        view.timeout.value = '10';
    }
    function toggleBroadcastForm(view: BroadcastForm): void {
        broadcastFormOpen = !broadcastFormOpen;
        view.button.classList.toggle('je-as-broadcast-active', broadcastFormOpen);
        view.form.classList.toggle('je-as-broadcast-form-open', broadcastFormOpen);
        if (broadcastFormOpen) {
            resetForm(view);
            view.text.focus();
        }
    }
    function collapseBroadcastForm(view: BroadcastForm): void {
        broadcastFormOpen = false;
        view.button.classList.remove('je-as-broadcast-active');
        view.form.classList.remove('je-as-broadcast-form-open');
        resetForm(view);
    }

    async function sendBroadcast(header: string | undefined, text: string, timeoutMs: number, result: HTMLElement, sendGeneration: number): Promise<void> {
        let message: { ok: boolean; text: string };
        try {
            // skipRetry: broadcasting is not idempotent, never auto-repeat it.
            const data = decodeBroadcast(await JE.core.api.plugin('/active-streams/broadcast', {
                method: 'POST', body: { header: header || null, text, timeoutMs }, skipRetry: true
            }));
            const errNote = data.errors.length ? ` (${data.errors.length} error${data.errors.length > 1 ? 's' : ''})` : '';
            message = { ok: true, text: `Sent to ${data.sent} of ${data.sent + data.skipped} sessions${errNote}` };
        } catch (error) {
            const status = isRecord(error) ? error.status : undefined;
            const detail = error instanceof Error ? error.message : String(error);
            // HTTP errors surface the response body; transport failures their message.
            message = status
                ? { ok: false, text: `Error: ${(isRecord(error) ? str(error.responseText) : undefined) || detail}` }
                : { ok: false, text: `Failed: ${detail}` };
        }
        // The result belongs to the admin instance that sent it.
        if (sendGeneration !== generation) return;
        result.className = `je-as-broadcast-result ${message.ok ? 'je-as-broadcast-ok' : 'je-as-broadcast-err'}`;
        result.textContent = message.text;
    }

    function injectBroadcastButton(panel: HTMLElement): void {
        if (panel.querySelector('.je-as-broadcast-btn')) return;
        const header = panel.querySelector('.je-as-panel-header');
        if (!header) return;
        const form = el('div', 'je-as-broadcast-form');
        const headerInput = el('input', 'je-as-broadcast-input');
        headerInput.type = 'text';
        headerInput.placeholder = 'e.g. Server Message';
        headerInput.maxLength = 200;
        const textArea = el('textarea', 'je-as-broadcast-textarea');
        textArea.placeholder = 'e.g. Server shutting down in 10 minutes';
        textArea.maxLength = 1000;
        const timeoutRow = el('div', 'je-as-broadcast-timeout-row');
        const timeoutInput = el('input', 'je-as-broadcast-timeout-input');
        timeoutInput.type = 'number';
        timeoutInput.value = '10';
        timeoutInput.min = '1';
        timeoutInput.max = '3600';
        timeoutRow.appendChild(el('span', 'je-as-broadcast-timeout-label', 'Timeout (s):'));
        timeoutRow.appendChild(timeoutInput);
        const result = el('div', 'je-as-broadcast-result');
        const actions = el('div', 'je-as-broadcast-actions');
        const sendBtn = el('button', 'je-as-broadcast-send', 'Send');
        const cancelBtn = el('button', 'je-as-broadcast-cancel', 'Cancel');
        actions.appendChild(cancelBtn);
        actions.appendChild(sendBtn);
        form.appendChild(el('div', 'je-as-broadcast-field-label', 'Title (optional)'));
        form.appendChild(headerInput);
        form.appendChild(el('div', 'je-as-broadcast-field-label', 'Message (required)'));
        form.appendChild(textArea);
        form.appendChild(el('div', 'je-as-broadcast-field-note', '⚠ Title may not show on all clients (web UI). Message is always visible.'));
        form.appendChild(timeoutRow);
        form.appendChild(result);
        form.appendChild(actions);
        const button = el('button', 'je-as-broadcast-btn');
        button.setAttribute('aria-label', 'Broadcast message to all sessions');
        button.title = 'Broadcast message';
        button.appendChild(materialIcon('campaign', '18px'));
        header.insertBefore(button, header.querySelector('.je-as-panel-close'));
        panel.insertBefore(form, panel.querySelector('.je-as-panel-body'));
        const view: BroadcastForm = { button, form, result, text: textArea, header: headerInput, timeout: timeoutInput };
        button.addEventListener('click', event => { event.stopPropagation(); toggleBroadcastForm(view); });
        cancelBtn.addEventListener('click', event => { event.stopPropagation(); collapseBroadcastForm(view); });
        sendBtn.addEventListener('click', event => {
            event.stopPropagation();
            void (async () => {
                const text = textArea.value.trim();
                if (!text) { textArea.focus(); return; }
                // Only the admin account that opened this form may send from it (CHR-STREAMS-1).
                if (!ownerCurrent() || !ownerIsAdmin || !isAdmin()) {
                    console.warn(`${LOG} Active Streams: broadcast refused, the signed-in account changed.`);
                    destroy();
                    return;
                }
                const sendGeneration = generation;
                const secs = parseFloat(timeoutInput.value) || 10;
                sendBtn.disabled = true;
                result.className = 'je-as-broadcast-result';
                result.textContent = '';
                await sendBroadcast(headerInput.value.trim() || undefined, text, Math.round(secs * 1000), result, sendGeneration);
                if (sendGeneration !== generation) return;
                sendBtn.disabled = false;
                // Auto-collapse after 3 s.
                if (broadcastCollapseTimer !== null) clearTimeout(broadcastCollapseTimer);
                broadcastCollapseTimer = setTimeout(() => { broadcastCollapseTimer = null; collapseBroadcastForm(view); }, 3000);
            })();
        });
    }

    function togglePanel(): void {
        if (!ownerCurrent()) { destroy(); return; }
        const panel = document.getElementById('je-active-streams-panel');
        if (!panel) return;
        panelOpen = !panelOpen;
        if (panelOpen) {
            const btn = document.getElementById('je-active-streams');
            panel.style.top = btn?.closest('.osdHeader, .videoOsd-appBar')
                ? (btn.getBoundingClientRect().bottom + 2) + 'px'
                : headerPanelTop;
        }
        panel.classList.toggle('je-as-panel-open', panelOpen);
        if (panelOpen) void updateCounter();
    }

    function injectPanel(): void {
        if (document.getElementById('je-active-streams-panel')) return;
        const panel = el('div');
        panel.id = 'je-active-streams-panel';
        const header = el('div', 'je-as-panel-header');
        const closeBtn = el('button', 'je-as-panel-close');
        closeBtn.setAttribute('aria-label', 'Close sessions panel');
        closeBtn.appendChild(materialIcon('close', '18px'));
        closeBtn.addEventListener('click', event => {
            event.stopPropagation();
            panelOpen = false;
            panel.classList.remove('je-as-panel-open');
        });
        header.appendChild(el('span', 'je-as-panel-title', 'Sessions'));
        header.appendChild(closeBtn);
        panel.appendChild(header);
        panel.appendChild(el('div', 'je-as-panel-body'));
        document.body.appendChild(panel);
        const headerBottom = JE.helpers?.getHeaderBottom?.() ?? 0;
        if (headerBottom > 0) {
            panel.style.top = (headerBottom + 2) + 'px';
            headerPanelTop = panel.style.top;
        }
        // Refresh: available to everyone who can see the panel.
        const refreshBtn = el('button', 'je-as-refresh-btn');
        refreshBtn.setAttribute('aria-label', 'Refresh sessions');
        refreshBtn.title = 'Refresh';
        refreshBtn.appendChild(materialIcon('refresh', '18px'));
        refreshBtn.addEventListener('click', event => {
            event.stopPropagation();
            refreshBtn.classList.add('je-as-refreshing');
            refreshBtn.addEventListener('animationend', () => refreshBtn.classList.remove('je-as-refreshing'), { once: true });
            void updateCounter();
        });
        header.insertBefore(refreshBtn, closeBtn);
        // The broadcast control exists only in an administrator's panel; the server also enforces it.
        if (ownerIsAdmin) injectBroadcastButton(panel);
        outsideClickListener = event => {
            const btn = document.getElementById('je-active-streams');
            const target = event.target;
            if (panelOpen && target instanceof Node && !panel.contains(target) && btn && !btn.contains(target)) {
                panelOpen = false;
                panel.classList.remove('je-as-panel-open');
            }
        };
        document.addEventListener('click', outsideClickListener);
    }

    function getOsdHeaderContainer(): Element | null {
        const bar = document.querySelector('.videoOsd-appBar');
        if (bar) {
            const menuButtons = [...bar.querySelectorAll<HTMLElement>('[aria-controls="app-sync-play-menu"], [aria-controls="app-remote-play-menu"]')];
            const visible = menuButtons.find(element => element.offsetParent !== null) || menuButtons[0];
            return visible?.parentElement || null;
        }
        return document.querySelector('.skinHeader.osdHeader .headerRight');
    }
    // videoosd.scss hides every .headerButton in the player bar except back/cast/syncplay.
    function syncPlacementClasses(btn: Element): void {
        const inOsd = !!btn.closest('.osdHeader, .videoOsd-appBar');
        btn.classList.toggle('je-as-in-osd', inOsd);
        btn.classList.toggle('headerButton', !inOsd);
        btn.classList.toggle('headerButtonRight', !inOsd);
    }

    function tryInjectHeader(attempts = 0, injectGeneration = generation): void {
        if (injectGeneration !== generation) return; // torn down while retrying
        if (document.getElementById('je-active-streams') || attempts > 20) return;
        const headerRight = JE.isVideoPage?.() ? getOsdHeaderContainer() : (JE.helpers?.getHeaderButtonTray?.() ?? null);
        if (!headerRight) {
            setTimeout(() => tryInjectHeader(attempts + 1, injectGeneration), 500);
            return;
        }
        // The shared tray may have just restored this button after a remount.
        if (document.getElementById('je-active-streams')) return;
        const btn = el('button', 'headerButton headerButtonRight paper-icon-button-light');
        btn.id = 'je-active-streams';
        btn.type = 'button';
        btn.setAttribute('is', 'paper-icon-button-light');
        btn.title = 'No active streams';
        btn.dataset.headerLabel = JE.t?.('activity_section_active_streams') ?? '';
        const icon = el('i', 'material-icons je-as-icon', 'play_circle');
        icon.setAttribute('aria-hidden', 'true');
        const sup = el('span', 'je-as-sup');
        sup.setAttribute('aria-hidden', 'true');
        btn.appendChild(icon);
        btn.appendChild(sup);
        btn.addEventListener('click', event => { event.stopPropagation(); togglePanel(); });
        headerRight.insertBefore(btn, headerRight.firstChild);
        syncPlacementClasses(btn);
        injectPanel();
        applyThemeVars();
        // The initial read only; panel opens, refreshes and navigation drive later updates.
        void updateCounter(true);
    }

    function startObserver(): void {
        if (observer) return;
        const callback = (): void => {
            const btn = document.getElementById('je-active-streams');
            if (!btn) tryInjectHeader(0);
            else syncPlacementClasses(btn);
        };
        if (JE.helpers?.onBodyMutation) {
            observer = JE.helpers.onBodyMutation('active-streams', callback);
        } else {
            const native = new MutationObserver(callback);
            native.observe(document.body, { childList: true, subtree: true });
            observer = { unsubscribe: () => native.disconnect() };
        }
    }

    function initialize(): void {
        if (!JE.pluginConfig?.ActiveStreamsEnabled) return;
        // Idempotent for the same account: boot and the user-data reload may both call this.
        if (owner && ownerCurrent()) return;
        if (owner) destroy();
        if (!isVisible()) {
            console.log(`${LOG} Active Streams: skipping — not visible for this user.`);
            return;
        }
        console.log(`${LOG} Active Streams: initializing.`);
        owner = currentIdentity();
        ownerIsAdmin = isAdmin();
        injectStyles();
        startObserver();
        tryInjectHeader(0);
        // Theme variables and one fresh read per navigation (hashchange, popstate, pushState).
        lifecycle = JE.core.lifecycle.register('active-streams');
        lifecycle.track(JE.core.navigation.onNavigate(() => {
            applyThemeVars();
            if (document.getElementById('je-active-streams')) void updateCounter();
        }));
    }

    function destroy(): void {
        console.log(`${LOG} Active Streams: destroying.`);
        generation++;
        owner = null;
        ownerIsAdmin = false;
        observer?.unsubscribe();
        observer = null;
        if (lifecycle) { lifecycle.teardown(); lifecycle = null; }
        if (outsideClickListener) { document.removeEventListener('click', outsideClickListener); outsideClickListener = null; }
        if (broadcastCollapseTimer !== null) { clearTimeout(broadcastCollapseTimer); broadcastCollapseTimer = null; }
        document.getElementById('je-active-streams')?.remove();
        document.getElementById('je-active-streams-panel')?.remove();
        document.getElementById('je-active-streams-styles')?.remove();
        panelOpen = false;
        broadcastFormOpen = false;
        lastUpdated = null;
    }

    /**
     * The panel shows other users' sessions (admin view) and its visibility was decided
     * for the old account: tear down on every switch, re-initialize once the new account's
     * data (including its admin policy) is loaded, so a non-admin never inherits the admin panel.
     */
    function bindSession(): void {
        JE.session?.onUserChange('active-streams', destroy);
        document.addEventListener('je:user-data-loaded', event => {
            const epoch = event instanceof CustomEvent && isRecord(event.detail) ? num(event.detail.epoch) : undefined;
            // A late announcement for an account that has already been replaced is ignored.
            if (epoch !== undefined && typeof JE.session?.isCurrent === 'function' && !JE.session.isCurrent(epoch)) return;
            initialize();
        });
    }

    return { initialize, destroy, bindSession };
}
