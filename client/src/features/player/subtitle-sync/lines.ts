/**
 * @file Subtitle sync: the pure rules (the subtitle lines, their search, the offset arithmetic and what a
 * source URL says about its stream). No player or page state: unit-tested through JE.internals.subtitleSync.
 */
export const TICKS_PER_SECOND = 10000000;
/** jellyfin-web's subtitle sync slider range (subtitlesync.template.html: min -30, max 30). */
export const MAX_OFFSET_SECONDS = 30;
/** Lines with unique text needed before a measured offset is trusted. */
const MIN_OFFSET_MATCHES = 3;

/** One line of the subtitle track. */
export interface SubtitleLine {
    /** Position in the sorted list. */
    index: number;
    /** Start in the subtitle file, seconds. */
    start: number;
    /** End in the subtitle file, seconds. */
    end: number;
    /** Display text. */
    text: string;
    /** searchKey(text). */
    search: string;
}
/** A cue jellyfin-web is showing: its time on screen and searchKey of its clean text. */
export interface CueSample { start: number; key: string }

const member = (value: unknown, key: string): unknown => (typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined);

/**
 * Turns a server track event's text into plain display text: ASS line breaks become new lines, ASS
 * override blocks and HTML-style tags (<i>, <font>) are dropped, and runs of whitespace collapse.
 */
export function cleanLineText(text: unknown): string {
    if (typeof text !== 'string') return '';
    let stripped = text
        .replace(/\\N/gi, '\n')
        .replace(/\\h/g, ' ')
        .replace(/\r/g, '')
        .replace(/\{\\[^}]*\}/g, '');
    // Removing one tag can join its neighbours into a new one ("<<i>b>"), so repeat until nothing
    // changes. The text is only ever shown through textContent.
    let previous: string;
    do {
        previous = stripped;
        stripped = stripped.replace(/<\/?[a-zA-Z][^>]*>/g, '');
    } while (stripped !== previous);
    return stripped
        .split('\n')
        .map(part => part.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join('\n');
}

/** The form of a text that searches compare: lower case, without accents or punctuation, single spaces. */
export function searchKey(text: unknown): string {
    return String(text == null ? '' : text)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, '')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Reads the server's `Stream.js` answer into lines sorted by start. Events without text or with an
 * unusable start are skipped.
 * @param data `{ TrackEvents: [{ Text, StartPositionTicks, EndPositionTicks }] }`
 */
export function parseTrackEvents(data: unknown): SubtitleLine[] {
    const events: unknown = member(data, 'TrackEvents');
    const lines: SubtitleLine[] = [];
    for (const ev of Array.isArray(events) ? events : []) {
        if (!ev) continue;
        const start = Number(member(ev, 'StartPositionTicks')) / TICKS_PER_SECOND;
        const end = Number(member(ev, 'EndPositionTicks')) / TICKS_PER_SECOND;
        const text = cleanLineText(member(ev, 'Text'));
        if (!text || !Number.isFinite(start) || start < 0) continue;
        lines.push({ index: 0, start, end: Number.isFinite(end) && end > start ? end : start, text, search: searchKey(text) });
    }
    lines.sort((a, b) => a.start - b.start);
    lines.forEach((line, i) => { line.index = i; });
    return lines;
}

/** The lines that contain every word of the query (case, accents and punctuation ignored). */
export function filterLines(lines: SubtitleLine[], query: string): SubtitleLine[] {
    const terms = searchKey(query).split(' ').filter(Boolean);
    if (!terms.length) return lines;
    return lines.filter(line => terms.every(term => line.search.includes(term)));
}

/** Rounds an offset to jellyfin-web's slider step (0.1 s). */
export function roundOffset(seconds: number): number {
    const v = Math.round(seconds * 10) / 10;
    return Object.is(v, -0) ? 0 : v;
}

/**
 * The offset that makes a line show at `anchor`: jellyfin-web shows a line at `start - offset`, so the
 * offset is `start - anchor`.
 * @param lineStart Line start in the subtitle file, seconds.
 * @param anchor Media time the line should show at, seconds.
 */
export function syncOffsetFor(lineStart: number, anchor: number): number {
    return roundOffset(lineStart - anchor);
}

/** Whether jellyfin-web can apply an offset (its control stops at ±30 s). */
export function offsetInRange(offset: number): boolean {
    return Number.isFinite(offset) && Math.abs(offset) <= MAX_OFFSET_SECONDS;
}

/**
 * The index of the last line that has started showing by `time` with `offset` applied, or -1 when none has.
 * @param lines Sorted by start.
 * @param time Media time, seconds.
 * @param offset Subtitle offset, seconds.
 */
export function lineIndexAt(lines: readonly SubtitleLine[], time: number, offset: number): number {
    let lo = 0;
    let hi = lines.length - 1;
    let found = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const line = lines[mid];
        if (line && line.start - offset <= time) {
            found = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return found;
}

/**
 * Compares lines from the server with cues jellyfin-web is showing. It is a different track when most
 * cues' text is not among the lines. Otherwise the shift is measured only on texts that occur once in
 * the lines, so a repeated line ("Yes.") can't pair a cue with the wrong occurrence; when most of those
 * agree on one shift, it is the offset jellyfin-web applied (it moves each cue to start - offset).
 * @returns That offset, 'mismatch', or null when it can't tell.
 */
export function measureOffset(lines: readonly SubtitleLine[], sample: readonly CueSample[] | null): number | 'mismatch' | null {
    if (!sample || !sample.length || !lines.length) return null;
    const startsByKey = new Map<string, number[]>();
    for (const line of lines) {
        if (!line.search) continue;
        const starts = startsByKey.get(line.search);
        if (starts) starts.push(line.start);
        else startsByKey.set(line.search, [line.start]);
    }
    const diffs: number[] = [];
    let compared = 0;
    let found = 0;
    for (const cue of sample) {
        if (!cue.key) continue;
        compared++;
        const starts = startsByKey.get(cue.key);
        if (!starts) continue;
        found++;
        const only = starts.length === 1 ? starts[0] : undefined;
        if (only !== undefined) diffs.push(only - cue.start);
    }
    if (!compared) return null;
    if (found < Math.ceil(compared * 0.6)) return 'mismatch';
    if (diffs.length < MIN_OFFSET_MATCHES) return null;
    diffs.sort((a, b) => a - b);
    const median = diffs[diffs.length >> 1] ?? 0;
    const agreeing = diffs.filter(d => Math.abs(d - median) <= 0.05).length;
    return agreeing < Math.ceil(diffs.length * 0.6) ? null : roundOffset(median);
}

/** Formats seconds as m:ss or h:mm:ss. */
export function formatTime(seconds: unknown): string {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = String(total % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/**
 * Whether a source is a progressive transcode: a server stream URL that is neither direct play
 * (Static=true) nor an HLS playlist (hls.js plays from a blob: URL).
 */
export function isProgressiveTranscode(src: string): boolean {
    if (!/^https?:/i.test(src || '')) return false;
    const q = src.indexOf('?');
    const path = (q === -1 ? src : src.slice(0, q)).toLowerCase();
    if (!path.includes('/videos/') || path.endsWith('.m3u8')) return false;
    for (const [name, value] of new URLSearchParams(q === -1 ? '' : src.slice(q + 1))) {
        if (name.toLowerCase() === 'static' && String(value).toLowerCase() === 'true') return false;
    }
    return true;
}

/**
 * Whether the media element can seek to a time (its seekable ranges).
 * @param time Element time, seconds.
 */
export function withinSeekable(video: HTMLVideoElement, time: number): boolean {
    if (!(time >= 0)) return false;
    try {
        const ranges = video.seekable;
        for (let i = 0; ranges && i < ranges.length; i++) {
            if (time >= ranges.start(i) && time <= ranges.end(i)) return true;
        }
    } catch (err) {
        console.warn('🪼 Jellyfin Enhanced: subtitle sync seekable check failed', err);
    }
    return false;
}

/**
 * Resolves with a lookup's answer, or with `fallback` when it fails or `ms` pass without an answer
 * (ApiClient lookups can't be aborted; a late answer is ignored).
 */
export function withTimeout<T>(promise: Promise<T> | T, ms: number, fallback: T): Promise<T> {
    return new Promise(resolve => {
        const timer = setTimeout(() => resolve(fallback), ms);
        Promise.resolve(promise).then(
            value => { clearTimeout(timer); resolve(value); },
            () => { clearTimeout(timer); resolve(fallback); });
    });
}

/** Normalises a Jellyfin id for comparison (no dashes, lower case). */
export function normalizeId(value: unknown): string | null {
    const v = String(value || '').replace(/-/g, '').toLowerCase();
    return v || null;
}
