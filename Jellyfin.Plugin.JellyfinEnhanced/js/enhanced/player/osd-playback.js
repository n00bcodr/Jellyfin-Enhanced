/**
 * @file Playback position and seeking through jellyfin-web's video OSD, for players that have no
 * `<video>` element.
 *
 * Jellyfin Desktop and Jellyfin Media Player play video with mpv through their own jellyfin-web
 * player plugin, so the player page has an empty `.videoPlayerContainer` and nothing JE can read a
 * time from. jellyfin-web's OSD still shows the playback manager's position and duration (its
 * onTimeUpdate writes them whenever the player reports time, whether or not the OSD is visible) and
 * its position slider seeks through the playback manager. Reading and driving those controls works
 * for any player jellyfin-web plays with.
 */
(function(JE) {
    'use strict';

    /**
     * The video OSD page that is showing; jellyfin-web keeps hidden copies of earlier views.
     * @returns {HTMLElement|null}
     */
    function activeOsdPage() {
        return Array.from(document.querySelectorAll('#videoOsdPage'))
            .find(page => !page.classList.contains('hide')) || null;
    }

    /**
     * An element of the showing OSD page.
     * @param {string} selector
     * @returns {HTMLElement|null}
     */
    function osdElement(selector) {
        const page = activeOsdPage();
        return page ? page.querySelector(selector) : null;
    }

    /**
     * Parses jellyfin-web's running time ("1:02:03", "2:03", "-21:48") into seconds.
     * @param {*} text
     * @returns {number|null} Seconds (negative for a leading '-'), or null if it is not a time.
     */
    function parseRunningTime(text) {
        const s = String(text == null ? '' : text).replace(/\s+/g, '');
        const match = /^(-)?(\d+(?::\d{1,2}){1,2})$/.exec(s);
        if (!match) return null;
        const seconds = match[2].split(':').reduce((total, part) => total * 60 + Number(part), 0);
        return match[1] ? -seconds : seconds;
    }

    /**
     * The playback position the OSD shows, in seconds of the item.
     * @returns {number|null} Null when the OSD shows no time position (no OSD, live TV, not started).
     */
    function positionSeconds() {
        const el = osdElement('.osdPositionText');
        if (!el || el.classList.contains('hide')) return null;
        const seconds = parseRunningTime(el.textContent);
        return seconds !== null && seconds >= 0 ? seconds : null;
    }

    /**
     * The item's duration as the OSD shows it: its total, or position + remaining when the user has
     * jellyfin-web show the remaining time.
     * @returns {number|null}
     */
    function durationSeconds() {
        const el = osdElement('.osdDurationText');
        if (!el || el.classList.contains('hide')) return null;
        const shown = parseRunningTime(el.textContent);
        if (shown === null) return null;
        if (shown >= 0) return shown > 0 ? shown : null;
        const position = positionSeconds();
        return position === null ? null : position - shown;
    }

    /**
     * The id of the item the OSD shows (its rating button carries it; it can lag briefly when the next
     * item starts, so callers also compare durations).
     * @returns {string|null} Null while the OSD shows no duration (nothing playing, live TV).
     */
    function itemKey() {
        if (durationSeconds() === null) return null;
        const btn = osdElement('.btnUserRating[data-id]');
        return (btn && btn.getAttribute('data-id')) || '';
    }

    /**
     * Whether two OSD readings are of the same item: same item id and durations within a few seconds
     * (the duration is position + remaining time, each shown in whole seconds).
     * @param {{key: string, duration: number}|null} a
     * @param {{key: string, duration: number}|null} b
     * @returns {boolean}
     */
    function sameItem(a, b) {
        return !!a && !!b && a.key === b.key && Math.abs(a.duration - b.duration) <= 3;
    }

    /**
     * Seeks through the OSD's position slider, which calls the playback manager's seekPercent.
     * @param {number} seconds Target position in seconds of the item.
     * @returns {boolean} False when the OSD has no slider or no duration to place the target on.
     */
    function seekTo(seconds) {
        const slider = osdElement('.osdPositionSlider');
        const duration = durationSeconds();
        if (!slider || slider.disabled || !duration || !Number.isFinite(seconds)) return false;
        return seekToPercent((Math.max(0, seconds) / duration) * 100);
    }

    /**
     * Seeks to a share of the item through the OSD's position slider.
     * @param {number} percent 0–100.
     * @returns {boolean} False when the OSD has no usable slider.
     */
    function seekToPercent(percent) {
        const slider = osdElement('.osdPositionSlider');
        if (!slider || slider.disabled || !Number.isFinite(percent) || durationSeconds() === null) return false;
        slider.value = String(Math.min(100, Math.max(0, percent)));
        slider.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    }

    JE.internals = JE.internals || {};
    JE.internals.osdPlayback = {
        activeOsdPage,
        parseRunningTime,
        positionSeconds,
        durationSeconds,
        itemKey,
        sameItem,
        seekTo,
        seekToPercent,
    };
})(window.JellyfinEnhanced);
