/** Bitmap/graphical subtitle codecs that never pass through the styled text node. */
export const NON_TEXT_CODECS: ReadonlySet<string> = new Set(['ass', 'ssa', 'pgssub', 'pgs', 'dvdsub', 'dvbsub', 'vobsub']);

const field = (value: unknown, key: string): unknown => value !== null && typeof value === 'object' ? Reflect.get(value, key) : undefined;

/**
 * Whether the user's live playback session shows a bitmap subtitle track
 * (Jellyfin /Sessions response, untrusted). Anything malformed counts as no.
 */
export function activeSubtitleIsBitmap(sessions: unknown): boolean {
    if (!Array.isArray(sessions)) return false;
    const session: unknown = sessions.find((s: unknown) => !!field(s, 'NowPlayingItem'));
    const streams = field(field(session, 'NowPlayingItem'), 'MediaStreams');
    const activeIndex = field(field(session, 'PlayState'), 'SubtitleStreamIndex');
    if (activeIndex == null || !Array.isArray(streams)) return false;
    const active: unknown = streams.find((s: unknown) => field(s, 'Type') === 'Subtitle' && field(s, 'Index') === activeIndex);
    const codec = field(active, 'Codec');
    return !!active && NON_TEXT_CODECS.has((typeof codec === 'string' ? codec : '').toLowerCase());
}

/** `#RRGGBB` + alpha slider (0–255) as `#RRGGBBAA`, the stored custom subtitle colour. */
export function colorWithAlpha(swatch: string, alpha: string): string {
    return swatch + parseInt(alpha).toString(16).padStart(2, '0').toUpperCase();
}

/** Clamp a pause-screen delay entry to 1–60 seconds (5 when unreadable). */
export function clampPauseDelay(raw: string): number {
    return Math.max(1, Math.min(60, parseInt(raw, 10) || 5));
}

/** A subtitle position from the grid, kept 2% inside every edge. */
export function clampPosition(pct: number): number {
    return Math.max(2, Math.min(98, pct));
}
