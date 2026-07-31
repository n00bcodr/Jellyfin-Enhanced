/**
 * @file Hidden Content — debounced persistence, the bounded retry ladder,
 * and the admin cross-user endpoints.
 * Split from hidden-content.js (code motion; bodies verbatim).
 */
(function (JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const internal = JE.internals.hiddenContent = JE.internals.hiddenContent || {};

    const { getHiddenData } = internal;

    let saveTimeout = null;

    /** Debounce interval for persisting hidden-content data. */
    const SAVE_DEBOUNCE_MS = 500;

    /**
     * Persists the hidden-content data to the server after a debounce.
     * Coalesces rapid writes (e.g. bulk-unhide) into a single save.
     */
    function debouncedSave() {
        if (saveTimeout) clearTimeout(saveTimeout);
        saveTimeout = setTimeout(async () => {
            saveTimeout = null;
            try {
                // Route through directSaveHiddenContent (not JE.saveUserSettings) so a successful save can
                // reconcile against any in-flight retry and a failure can re-enter the retry ladder.
                // JE.saveUserSettings swallows errors, which would leave a pending retry firing later and
                // clobbering server state.
                const sent = await directSaveHiddenContent();
                reconcileAfterSave(sent);
            } catch (e) {
                console.warn('🪼 Jellyfin Enhanced: debouncedSave failed; scheduling background retry', e);
                if (pendingRetryHandle == null) scheduleFlushRetry(0);
            }
        }, SAVE_DEBOUNCE_MS);
    }

    // ── Admin-only cross-user visibility ──
    // The server enforces admin access on these endpoints (IsAdminUser); these helpers fail soft
    // — returning an empty array on a 403 or any transient error — so a non-admin or a hiccup can
    // never throw into the page render path.

    /**
     * Fetches the list of users who have hidden content, for the admin user-filter dropdown.
     * Admin-only server-side. Returns an array on success (possibly empty), or `null` on any
     * error so callers can distinguish a genuine empty list from a transient failure and avoid
     * caching a bad result.
     * @returns {Promise<Array<{userId: string, userName: string, count: number}>|null>}
     */
    async function fetchHiddenContentUsers() {
        try {
            const res = await ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl('/JellyfinEnhanced/admin/hidden-content-users'),
                dataType: 'json'
            });
            return (res && Array.isArray(res.users)) ? res.users : [];
        } catch (e) {
            if (e && e.status === 403) console.warn('🪼 Jellyfin Enhanced: Hidden Content admin user-list denied (not an admin).');
            return null;
        }
    }

    /**
     * Fetches another user's hidden items (admin-only) normalised to the same shape that
     * {@link getAllHiddenItems} produces (camelCase fields plus a `_key`). Returns an array on
     * success (possibly empty), or `null` on any error so callers can show an error state instead
     * of an empty grid. Read-only — callers must not attempt to persist these items.
     * @param {string} targetUserId Jellyfin user ID in N format (no dashes).
     * @returns {Promise<Array<Object>|null>}
     */
    async function fetchUserHiddenItemsForAdmin(targetUserId) {
        if (!targetUserId) return [];
        try {
            const res = await ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl(`/JellyfinEnhanced/admin/hidden-content/${targetUserId}`),
                dataType: 'json'
            });
            // The server returns PascalCase ({ Items, Settings }); reuse the shared converter so the
            // items match locally-loaded ones (toCamelCase is idempotent and recurses into Items).
            const hc = (typeof JE.toCamelCase === 'function')
                ? JE.toCamelCase(res && res.hiddenContent)
                : (res && res.hiddenContent);
            const items = (hc && hc.items) || {};
            return Object.entries(items).map(([key, item]) => ({ ...item, _key: key }));
        } catch (e) {
            if (e && e.status === 403) console.warn('🪼 Jellyfin Enhanced: Hidden Content admin read denied (not an admin).');
            return null;
        }
    }

    /**
     * Admin-only: unhides items from another user's hidden content (admin editing).
     * Server enforces admin access. Fails soft (returns false) so a denied/transient error never
     * throws into the UI.
     * @param {string} targetUserId Jellyfin user ID in N format (no dashes).
     * @param {string[]} keys Keys (item._key) of the items to unhide for that user.
     * @returns {Promise<boolean>} true on success.
     */
    async function adminUnhideForUser(targetUserId, keys) {
        if (!targetUserId || !Array.isArray(keys) || keys.length === 0) return false;
        try {
            await ApiClient.ajax({
                type: 'POST',
                url: ApiClient.getUrl(`/JellyfinEnhanced/admin/hidden-content/${targetUserId}/unhide`),
                data: JSON.stringify(keys),
                contentType: 'application/json'
            });
            return true;
        } catch (e) {
            if (e && e.status === 403) console.warn('🪼 Jellyfin Enhanced: Hidden Content admin unhide denied (not an admin).');
            return false;
        }
    }

    /**
     * Admin-only: hides items on behalf of another user (admin adding). Server enforces
     * admin + the HiddenContentAdmin toggle. Fails soft (returns false) so a denied/transient error never throws.
     * @param {string} targetUserId Jellyfin user ID in N format (no dashes).
     * @param {Array<Object>} items Hidden-content item objects to add (same shape as getAllHiddenItems).
     * @returns {Promise<number|false>} Count newly added, or false on failure.
     */
    async function adminHideForUser(targetUserId, items) {
        if (!targetUserId || !Array.isArray(items) || items.length === 0) return false;
        try {
            const res = await ApiClient.ajax({
                type: 'POST',
                url: ApiClient.getUrl(`/JellyfinEnhanced/admin/hidden-content/${targetUserId}/hide`),
                data: JSON.stringify(items),
                contentType: 'application/json'
            });
            return (res && typeof res.added === 'number') ? res.added : true;
        } catch (e) {
            if (e && e.status === 403) console.warn('🪼 Jellyfin Enhanced: Hidden Content admin hide denied (not an admin / disabled).');
            return false;
        }
    }

    // Direct bypass of JE.saveUserSettings (which swallows errors) so callers can react to failure.
    // Returns the JSON snapshot that was sent so the caller can compare it to current state and decide
    // whether the success acknowledgement still represents the latest local intent.
    async function directSaveHiddenContent() {
        const userId = ApiClient.getCurrentUserId();
        if (!userId) throw new Error('no current user');
        const snapshot = JSON.stringify(getHiddenData());
        await ApiClient.ajax({
            type: 'POST',
            url: ApiClient.getUrl(`/JellyfinEnhanced/user-settings/${userId}/hidden-content.json`),
            data: snapshot,
            contentType: 'application/json'
        });
        return snapshot;
    }

    // After a successful save, decide whether the server is caught up.
    // - Match: cancel any pending (non-in-flight) retry — server has the latest.
    // - Mismatch: state moved during the await; schedule another save.
    // The retry-timer body explicitly clears RETRY_INFLIGHT before calling this so a same-state mismatch
    // doesn't leave the sentinel stuck; cancelPendingRetry refuses to clear an in-flight retry from another path.
    function reconcileAfterSave(snapshotSent) {
        if (snapshotSent === JSON.stringify(getHiddenData())) {
            cancelPendingRetry();
        } else {
            debouncedSave();
        }
    }

    // Bounded background retry of a failed flush. Cancelled on a successful save anywhere else so a
    // server-side auto-clear (PlaybackStart consumer, ItemRemoved hook) isn't overwritten by a stale retry.
    const FLUSH_RETRY_DELAYS_MS = [1000, 5000, 15000];
    const RETRY_INFLIGHT = -1; // sentinel: retry timer fired and POST is in flight (handle no longer cancelable)
    let pendingRetryHandle = null;

    function cancelPendingRetry() {
        // Don't unset RETRY_INFLIGHT — the timer body whose POST is in flight needs to manage its own
        // lifecycle. Clearing it here would let a follow-up debouncedSave failure spawn a parallel ladder.
        if (pendingRetryHandle === RETRY_INFLIGHT) return;
        if (pendingRetryHandle != null) clearTimeout(pendingRetryHandle);
        pendingRetryHandle = null;
    }

    function scheduleFlushRetry(attempt) {
        if (attempt >= FLUSH_RETRY_DELAYS_MS.length) {
            console.error('🪼 Jellyfin Enhanced: hidden-content save retries exhausted; local change may be lost on reload');
            // User-visible toast — the bulk-save endpoint is genuinely down at this point.
            try {
                if (typeof JE?.toast === 'function') {
                    JE.toast(JE.t('hidden_content_save_failed_persistent'), 5000);
                }
            } catch (_) { /* toast helper unavailable, console.error above is best-effort */ }
            pendingRetryHandle = null;
            return;
        }
        pendingRetryHandle = setTimeout(async () => {
            pendingRetryHandle = RETRY_INFLIGHT; // mark in-flight so a concurrent debouncedSave failure doesn't spawn a parallel ladder
            // Guard for ApiClient teardown / signed-out state during the window.
            if (typeof ApiClient === 'undefined' || typeof ApiClient.getCurrentUserId !== 'function' || !ApiClient.getCurrentUserId()) {
                console.error('🪼 Jellyfin Enhanced: abandoning hidden-content retry; ApiClient unavailable');
                pendingRetryHandle = null;
                return;
            }
            try {
                const sent = await directSaveHiddenContent();
                // Retry succeeded — clear the in-flight sentinel BEFORE reconcile so a state-mismatch
                // reschedule via debouncedSave doesn't leave the sentinel stuck (cancelPendingRetry from
                // other code paths intentionally refuses to clear RETRY_INFLIGHT).
                if (pendingRetryHandle === RETRY_INFLIGHT) pendingRetryHandle = null;
                reconcileAfterSave(sent);
            } catch (err) {
                console.warn(`🪼 Jellyfin Enhanced: hidden-content save retry ${attempt + 1} failed`, err);
                scheduleFlushRetry(attempt + 1);
            }
        }, FLUSH_RETRY_DELAYS_MS[attempt]);
    }

    // Flush pending debouncedSave so a following server-direct write sees the latest local state.
    // On failure: re-throw so the caller aborts, AND start a bounded background retry so the local mutation isn't lost.
    async function flushPendingSave() {
        if (!saveTimeout) return;
        clearTimeout(saveTimeout);
        saveTimeout = null;
        try {
            const sent = await directSaveHiddenContent();
            reconcileAfterSave(sent);
        } catch (e) {
            console.warn('🪼 Jellyfin Enhanced: flushPendingSave failed; scheduling background retry', e);
            if (pendingRetryHandle == null) scheduleFlushRetry(0);
            throw e;
        }
    }

    // Cancel pending retries on tab teardown so a stale snapshot can't overwrite server state after navigation.
    // Only pagehide — visibilitychange fires on backgrounded tabs the user may return to within the retry window.
    try {
        window.addEventListener('pagehide', cancelPendingRetry);
    } catch (_) { /* non-browser env, harmless */ }

    Object.assign(internal, {
        debouncedSave,
        flushPendingSave,
        fetchHiddenContentUsers,
        fetchUserHiddenItemsForAdmin,
        adminUnhideForUser,
        adminHideForUser,
    });

})(window.JellyfinEnhanced);
