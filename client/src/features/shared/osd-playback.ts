/**
 * @file Playback position and seeking through jellyfin-web's video OSD, for players that have no `<video>`
 * element.
 *
 * Jellyfin Desktop and Jellyfin Media Player play video with mpv through their own jellyfin-web player
 * plugin, so the player page has an empty `.videoPlayerContainer` and nothing JE can read a time from.
 * jellyfin-web's OSD still shows the playback manager's position and duration (its onTimeUpdate writes them
 * whenever the player reports time, whether or not the OSD is visible) and its position slider seeks through
 * the playback manager. Reading and driving those controls works for any player jellyfin-web plays with.
 *
 * Stateless: every call reads the page. The player publishes it as JE.internals.osdPlayback (playback.ts);
 * bookmarks imports it.
 */

/** What identifies the item an OSD reading is of. */
export interface OsdItem {
    /** The item id the OSD's rating button carries ('' while it carries none). */
    key: string;
    /** The duration the OSD shows, seconds. */
    duration: number;
}

/** The video OSD page that is showing; jellyfin-web keeps hidden copies of earlier views. */
function activeOsdPage(): HTMLElement | null {
    return Array.from(document.querySelectorAll<HTMLElement>('#videoOsdPage')).find(page => !page.classList.contains('hide')) || null;
}

/** An element of the showing OSD page. */
function osdElement<T extends HTMLElement = HTMLElement>(selector: string): T | null {
    const page = activeOsdPage();
    return page ? page.querySelector<T>(selector) : null;
}

/**
 * Parses jellyfin-web's running time ("1:02:03", "2:03", "-21:48") into seconds.
 * @returns Seconds (negative for a leading '-'), or null if it is not a time.
 */
function parseRunningTime(text: unknown): number | null {
    const s = String(text == null ? '' : text).replace(/\s+/g, '');
    const match = /^(-)?(\d+(?::\d{1,2}){1,2})$/.exec(s);
    if (!match || !match[2]) return null;
    const seconds = match[2].split(':').reduce((total, part) => total * 60 + Number(part), 0);
    return match[1] ? -seconds : seconds;
}

/**
 * The playback position the OSD shows, in seconds of the item.
 * @returns Null when the OSD shows no time position (no OSD, live TV, not started).
 */
function positionSeconds(): number | null {
    const el = osdElement('.osdPositionText');
    if (!el || el.classList.contains('hide')) return null;
    const seconds = parseRunningTime(el.textContent);
    return seconds !== null && seconds >= 0 ? seconds : null;
}

/**
 * The item's duration as the OSD shows it: its total, or position + remaining when the user has jellyfin-web
 * show the remaining time.
 */
function durationSeconds(): number | null {
    const el = osdElement('.osdDurationText');
    if (!el || el.classList.contains('hide')) return null;
    const shown = parseRunningTime(el.textContent);
    if (shown === null) return null;
    if (shown >= 0) return shown > 0 ? shown : null;
    const position = positionSeconds();
    return position === null ? null : position - shown;
}

/**
 * The id of the item the OSD shows (its rating button carries it; it can lag briefly when the next item
 * starts, so callers also compare durations).
 * @returns Null while the OSD shows no duration (nothing playing, live TV).
 */
function itemKey(): string | null {
    if (durationSeconds() === null) return null;
    const btn = osdElement('.btnUserRating[data-id]');
    return (btn && btn.getAttribute('data-id')) || '';
}

/**
 * Whether two OSD readings are of the same item: same item id and durations within a few seconds (the
 * duration is position + remaining time, each shown in whole seconds).
 */
function sameItem(a: OsdItem | null | undefined, b: OsdItem | null | undefined): boolean {
    return !!a && !!b && a.key === b.key && Math.abs(a.duration - b.duration) <= 3;
}

/**
 * Whether the OSD shows playback paused: its play/pause button shows the play icon then.
 * @returns Null when the OSD shows neither icon.
 */
function isPaused(): boolean | null {
    const icon = osdElement('.btnPause .material-icons');
    if (!icon) return null;
    if (icon.classList.contains('play_arrow')) return true;
    if (icon.classList.contains('pause')) return false;
    return null;
}

/**
 * Seeks to a share of the item through the OSD's position slider, which calls the playback manager's
 * seekPercent.
 * @param percent 0–100.
 * @returns False when the OSD has no usable slider.
 */
function seekToPercent(percent: number): boolean {
    const slider = osdElement<HTMLInputElement>('.osdPositionSlider');
    if (!slider || slider.disabled || !Number.isFinite(percent) || durationSeconds() === null) return false;
    slider.value = String(Math.min(100, Math.max(0, percent)));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
}

/**
 * Seeks through the OSD's position slider.
 * @param seconds Target position in seconds of the item.
 * @returns False when the OSD has no slider or no duration to place the target on.
 */
function seekTo(seconds: number): boolean {
    const slider = osdElement<HTMLInputElement>('.osdPositionSlider');
    const duration = durationSeconds();
    if (!slider || slider.disabled || !duration || !Number.isFinite(seconds)) return false;
    return seekToPercent((Math.max(0, seconds) / duration) * 100);
}

export const osdPlayback = { activeOsdPage, parseRunningTime, positionSeconds, durationSeconds, itemKey, sameItem, isPaused, seekTo, seekToPercent };
export type OsdPlayback = typeof osdPlayback;
