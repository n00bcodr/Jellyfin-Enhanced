// @ts-check
// Per-user local disable-confirm snooze.
(function(JE) {
    'use strict';

    JE.internals = JE.internals || {};
    /** @type {any} Shared cross-file namespace; each module contributes a focused surface. */
    const internal = JE.internals.spoilerGuard = JE.internals.spoilerGuard || {};
    const logPrefix = '🪼 Jellyfin Enhanced [SpoilerGuard]:';
    const snoozeMs = 15 * 60 * 1000;
    const maxFutureMs = 24 * 60 * 60 * 1000;
    let emptyUidWarned = false;

    function userId() {
        try {
            const id = typeof ApiClient?.getCurrentUserId === 'function' ? ApiClient.getCurrentUserId() : null;
            if (typeof id === 'string' && id.length > 0) return id;
        } catch (_) { /* unavailable during startup/logout */ }
        if (!emptyUidWarned) {
            emptyUidWarned = true;
            console.warn(`${logPrefix} user id unavailable; disable-confirm snooze is disabled for this call`);
        }
        return null;
    }

    function key(id) { return `je-spoiler-disable-snooze:${id}`; }

    internal.isDisableSnoozed = function() {
        const id = userId();
        if (!id) return false;
        try {
            const storageKey = key(id);
            const raw = localStorage.getItem(storageKey);
            if (!raw) return false;
            const expiry = Number(raw);
            if (Number.isFinite(expiry) && expiry > 0 && expiry <= Date.now() + maxFutureMs && Date.now() < expiry) {
                return true;
            }
            localStorage.removeItem(storageKey);
        } catch (e) {
            console.warn(`${logPrefix} snooze read failed:`, e);
        }
        return false;
    };

    internal.setDisableSnooze = function() {
        const id = userId();
        if (!id) return;
        try { localStorage.setItem(key(id), String(Date.now() + snoozeMs)); }
        catch (e) { console.warn(`${logPrefix} snooze persist failed:`, e); }
    };
})(window.JellyfinEnhanced);
