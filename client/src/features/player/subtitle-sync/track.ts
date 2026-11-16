/**
 * @file Subtitle sync: which subtitle track is playing, and its lines.
 *
 * The track comes from the server's view of this device's session, once that view is known to describe
 * what is on screen, checked against the item the page is playing. The lines come from the server's JSON
 * rendering of the track (`Stream.js`, the request jellyfin-web itself makes for text subtitles), so every
 * text format the server reads works: SRT, ASS/SSA, WebVTT and text tracks inside the file. Image
 * formats (PGS, VobSub, DVB) have no text to list.
 */
import type { PlayerBridge, PlayerFeatureContext, playerHost } from '../host';
import { decodeItem, type PlayingSession, type Stream } from '../wire';
import { normalizeId, parseTrackEvents, TICKS_PER_SECOND, withTimeout, type SubtitleLine } from './lines';
import { videoSrc, type SubtitleWatch } from './watch';

const FETCH_TIMEOUT_MS = 30000;
/**
 * jellyfin-web reports its playback state (subtitle track included) on pause and at least every ten
 * seconds otherwise (playbackManager's progress interval), so the server's answer can be this much older
 * than what is on screen.
 */
const REPORT_INTERVAL_MS = 11000;
/** How close (seconds) a paused report's position must be to the dialog's to be its pause. */
const PAUSE_POSITION_TOLERANCE = 0.25;
/**
 * Waits, in milliseconds (read when used; the tests shorten them): `sessionWait` for the state report the
 * dialog asks for, polled every `sessionPoll`; `lookup` for the item lookup.
 */
export const TIMEOUTS = { sessionWait: 12000, sessionPoll: 250, lookup: 8000 };

/** What a lookup needs to know about the dialog it serves. */
export interface LookupState {
    video: HTMLVideoElement;
    epoch: number;
    /** Media time when the dialog opened, seconds. */
    anchor: number;
    /** Whether the dialog paused playback. */
    pausedByUs: boolean;
    abort: AbortController;
}
export interface TrackRef { itemId: string; mediaSourceId: string; index: number; stream: Stream | null }
export type TrackAnswer = { error: 'session' | 'none'; stream?: undefined } | { error: 'image'; stream: Stream } | TrackRef;

export interface TrackHost {
    JE: PlayerBridge;
    ApiClient: ReturnType<typeof playerHost>['ApiClient'];
    ctx: PlayerFeatureContext;
    watch: SubtitleWatch;
}

export function createTrackLookup({ JE, ApiClient, ctx, watch }: TrackHost, isCurrent: (state: LookupState) => boolean) {
    /** The last track loaded, so reopening on the same track needs no request. */
    let lineCache: { key: string; lines: SubtitleLine[] } | null = null;

    function currentUserId(): string | null {
        try {
            return JE.session?.getUserId?.() || ApiClient.getCurrentUserId() || null;
        } catch {
            return null;
        }
    }

    /** The item the page shows it is playing, when the source URL or the route names it. */
    function itemHint(video: HTMLVideoElement): string | null {
        const fromSrc = ctx.own.autoSkip?.parseItemIdFromVideosSrc?.(videoSrc(video)) ?? null;
        return normalizeId(fromSrc || ctx.own.player?.getCurrentVideoItemId?.());
    }

    /**
     * Whether a session's state is the report of the dialog's own pause: paused at the position the dialog
     * opened at (jellyfin-web reports the position it paused at). An earlier pause's report still on the
     * server would show another position.
     */
    function isPauseReport(session: PlayingSession, state: LookupState): boolean {
        if (session.PlayState.IsPaused !== true) return false;
        const position = Number(session.PlayState.PositionTicks) / TICKS_PER_SECOND;
        return Number.isFinite(position) && Math.abs(position - state.anchor) <= PAUSE_POSITION_TOLERANCE;
    }

    /**
     * This device's session, once it is known to describe what is on screen. jellyfin-web reports its whole
     * state on pause and at least every ten seconds. After a subtitle change on screen in the last
     * REPORT_INTERVAL_MS (a track shown, switched or turned off, see the watch's noteRenderer), before or
     * after the dialog opened, nothing already on the server can be shown to be newer than the change, so
     * the dialog waits for the next report (LastPlaybackCheckIn moves past the first value it sees). Without
     * one, the server's last report came after the last change; when the dialog paused playback it still
     * waits for that pause's report (isPauseReport), which also covers a change it could not see (image
     * subtitles). Null when no current answer came in time.
     */
    async function probeFreshSession(state: LookupState): Promise<PlayingSession | null> {
        const probe = ctx.own.player?.probeOwnSession;
        if (typeof probe !== 'function') return null;
        const deadline = Date.now() + TIMEOUTS.sessionWait;
        const changedAt = watch.changedAt();
        const awaitReport = changedAt > 0 && Date.now() - changedAt < REPORT_INTERVAL_MS;
        /** undefined until a session has been seen. */
        let baseline: string | null | undefined;
        for (;;) {
            const session = await withTimeout<PlayingSession | null>(probe(), Math.max(1, deadline - Date.now()), null);
            if (!isCurrent(state)) return null;
            if (session) {
                const checkIn = session.LastPlaybackCheckIn || null;
                if (awaitReport) {
                    if (baseline === undefined) baseline = checkIn;
                    else if (checkIn !== baseline) return session;
                } else if (state.pausedByUs) {
                    if (isPauseReport(session, state)) return session;
                } else {
                    return session;
                }
            }
            if (Date.now() >= deadline) return null;
            await new Promise(resolve => setTimeout(resolve, TIMEOUTS.sessionPoll));
            if (!isCurrent(state)) return null;
        }
    }

    const subtitleStream = (streams: readonly Stream[], index: number): Stream | null =>
        streams.find(s => s.Type === 'Subtitle' && s.Index === index) || null;

    /**
     * Resolves which subtitle track is playing: the server's view of this device's session, checked against
     * the item the page is playing.
     * @returns null when the dialog is no longer the current one.
     */
    async function resolveTrack(state: LookupState): Promise<TrackAnswer | null> {
        const session = await probeFreshSession(state);
        if (!isCurrent(state)) return null;
        const itemId = session?.NowPlayingItem.Id;
        const hint = itemHint(state.video);
        if (!session || !itemId || (hint && hint !== normalizeId(itemId))) return { error: 'session' };
        const index = typeof session.PlayState.SubtitleStreamIndex === 'number' ? session.PlayState.SubtitleStreamIndex : -1;
        if (index < 0) return { error: 'none' };
        const mediaSourceId = session.PlayState.MediaSourceId || itemId;
        let stream: Stream | null = null;
        try {
            const userId = currentUserId();
            const item = userId ? await withTimeout<unknown>(ApiClient.getItem(userId, itemId), TIMEOUTS.lookup, null) : null;
            if (!isCurrent(state)) return null;
            const source = item ? decodeItem(item).MediaSources.find(s => normalizeId(s.Id) === normalizeId(mediaSourceId)) : undefined;
            stream = source ? subtitleStream(source.MediaStreams, index) : null;
        } catch (err) {
            // The track's description is only for the label and the image check; the lines request below
            // still tells whether the track has text.
            console.warn('🪼 Jellyfin Enhanced: subtitle sync item lookup failed', err);
        }
        if (!isCurrent(state)) return null;
        if (!stream) stream = subtitleStream(session.NowPlayingItem.MediaStreams, index);
        if (stream && stream.IsTextSubtitleStream === false) return { error: 'image', stream };
        return { itemId, mediaSourceId, index, stream };
    }

    /** Fetches the track's lines (or reuses the last track's). */
    async function loadLines(state: LookupState, track: TrackRef): Promise<SubtitleLine[]> {
        const key = [currentUserId(), normalizeId(track.itemId), normalizeId(track.mediaSourceId), track.index].join('|');
        if (lineCache && lineCache.key === key) return lineCache.lines;
        const api = JE.core.api;
        if (!api) throw new Error('The Jellyfin request helper is not available');
        const path = `/Videos/${encodeURIComponent(track.itemId)}/${encodeURIComponent(track.mediaSourceId)}/Subtitles/${track.index}/0/Stream.js`;
        const data = await api.jf(path, { signal: state.abort.signal, timeoutMs: FETCH_TIMEOUT_MS });
        const lines = parseTrackEvents(data);
        if (JE.session ? JE.session.isCurrent(state.epoch) : true) lineCache = { key, lines };
        return lines;
    }

    return { resolveTrack, loadLines, clearCache() { lineCache = null; } };
}

/** A readable name for the subtitle track. */
export function trackLabel(stream: Stream | null | undefined): string {
    if (!stream) return '';
    return String(stream.DisplayTitle || stream.Title || stream.Language || '').trim();
}
