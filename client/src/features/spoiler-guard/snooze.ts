import { spoilerHost } from './host';
const { JE, internal, ApiClient } = spoilerHost();
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

    function key(id: string) {
        const server = JE.session?.getServerId?.();
        const legacy = `je-spoiler-disable-snooze:${id}`;
        if (!server) return legacy;
        const scoped = `${legacy}:server:${encodeURIComponent(server)}`;
        // Consume the previous unscoped expiry once, retaining its original deadline.
        const old = localStorage.getItem(legacy);
        if (old !== null) {
            if (localStorage.getItem(scoped) === null) localStorage.setItem(scoped, old);
            localStorage.removeItem(legacy);
        }
        return scoped;
    }

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
