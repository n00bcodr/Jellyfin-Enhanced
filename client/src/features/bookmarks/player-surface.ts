/**
 * @file The player a bookmark is placed on and jumped to: its `<video>` element, or jellyfin-web's OSD for a
 * player without one. Jellyfin Desktop and Jellyfin Media Player play through mpv and have no `<video>`: their
 * position, duration and seeking go through jellyfin-web's OSD (shared/osd-playback.ts).
 */
import { osdPlayback } from '../shared/osd-playback';

/** The player's `<video>` element; null for a player without one. */
export const playerVideo = (): HTMLVideoElement | null => document.querySelector<HTMLVideoElement>('.videoPlayerContainer video');

/**
 * The player's position in seconds.
 * @returns Null when a player without a `<video>` shows no position.
 */
export function playerPositionSeconds(video: HTMLVideoElement | null): number | null {
    return video ? video.currentTime || 0 : osdPlayback.positionSeconds();
}

/** The playing item's duration in seconds. */
export function playerDurationSeconds(video: HTMLVideoElement | null): number | null {
    return video ? video.duration : osdPlayback.durationSeconds();
}

/**
 * Seeks the player.
 * @returns False when a player without a `<video>` could not be sought.
 */
export function seekPlayer(video: HTMLVideoElement | null, seconds: number): boolean {
    if (!video) return osdPlayback.seekTo(seconds);
    video.currentTime = seconds;
    return true;
}

/**
 * What the OSD's markers and button were injected for: the element's source, or the item the OSD shows for a
 * player without a `<video>` (null until its OSD shows the item's duration).
 */
export function osdKey(): string | null {
    const video = playerVideo();
    if (video) return video.currentSrc || video.src || window.location.href;
    const osdItem = osdPlayback.itemKey();
    return osdItem === null ? null : `${window.location.href}|${osdItem}`;
}
