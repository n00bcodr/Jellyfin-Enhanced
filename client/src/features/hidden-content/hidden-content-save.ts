import { installOnce, onDispose, selectionLease, enqueueWrite, pendingWrites } from './host';
import { lease } from './host';
import { decodeDocument, decodeUsers, record, type HiddenItem } from './model';
import { host, registry, type HiddenHost } from './host';
/**
 * @file Hidden Content — debounced persistence, the bounded retry ladder,
 * and the admin cross-user endpoints.
 * Split from hidden-content.js (code motion; bodies verbatim).
 */
(function (JE: HiddenHost) {
    if(!installOnce(JE,'hidden-content-save'))return;
    'use strict';
    const internal = registry(JE, 'hiddenContent');

    const { getHiddenData, assertWritable } = internal;
    function decodeAdded(value: unknown): number {
        const added=record(value).added;
        if (typeof added!=='number' || !Number.isInteger(added) || added<0) throw new Error('Invalid hidden-content mutation response');
        return added;
    }

    let saveTimeout: ReturnType<typeof setTimeout> | null = null;

    /** Debounce interval for persisting hidden-content data. */
    const SAVE_DEBOUNCE_MS = 500;

    /**
     * Persists the hidden-content data to the server after a debounce.
     * Coalesces rapid writes (e.g. bulk-unhide) into a single save.
     */
    // Bumped on every user switch: a save/retry timer scheduled under the
    // previous user must not fire under the new one — it would serialize the
    // reset (empty) store to the NEW user's file and erase their data.
    let saveGeneration = 0;

    function debouncedSave() {
        if (saveTimeout) clearTimeout(saveTimeout);
        const identity=lease(JE);
        const scheduledGeneration = saveGeneration;
        saveTimeout = setTimeout(async () => {
            saveTimeout = null;
            if (scheduledGeneration !== saveGeneration || !identity.current()) return; // user switched since scheduling
            try {
                // Route through directSaveHiddenContent (not JE.saveUserSettings) so a successful save can
                // reconcile against any in-flight retry and a failure can re-enter the retry ladder.
                // JE.saveUserSettings swallows errors, which would leave a pending retry firing later and
                // clobbering server state.
                const sent = await directSaveHiddenContent();
                reconcileAfterSave(sent, scheduledGeneration, identity);
            } catch (e) {
                console.warn('🪼 Jellyfin Enhanced: debouncedSave failed; scheduling background retry', e);
                if (scheduledGeneration === saveGeneration && identity.current() && pendingRetryHandle == null) scheduleFlushRetry(0, scheduledGeneration);
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
        const token=lease(JE), api=token.api;
        try {
            const res = await api.ajax({
                type: 'GET',
                url: api.getUrl('/JellyfinEnhanced/admin/hidden-content-users'),
                dataType: 'json'
            });
            return token.current() ? decodeUsers(res) : null;
        } catch (e) {
            if (e instanceof Object && 'status' in e && e.status === 403) console.warn('🪼 Jellyfin Enhanced: Hidden Content admin user-list denied (not an admin).');
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
    async function fetchUserHiddenItemsForAdmin(targetUserId: string) {
        const token=lease(JE), api=token.api;
        if (!targetUserId) return [];
        try {
            const res = await api.ajax({
                type: 'GET',
                url: api.getUrl(`/JellyfinEnhanced/admin/hidden-content/${targetUserId}`),
                dataType: 'json'
            });
            // The server returns PascalCase ({ Items, Settings }); reuse the shared converter so the
            // items match locally-loaded ones (toCamelCase is idempotent and recurses into Items).
            if (!token.current()) return null;
            const hc = decodeDocument(record(res).hiddenContent);
            const items = hc.items;
            return Object.entries(items).map(([key, item]) => ({ ...item, _key: key }));
        } catch (e) {
            if (e instanceof Object && 'status' in e && e.status === 403) console.warn('🪼 Jellyfin Enhanced: Hidden Content admin read denied (not an admin).');
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
    async function adminUnhideForUser(targetUserId: string, keys: string[]) {
        if (!targetUserId || !Array.isArray(keys) || keys.length === 0) return false;
        const api=lease(JE).api;
        try {
            await api.ajax({
                type: 'POST',
                url: api.getUrl(`/JellyfinEnhanced/admin/hidden-content/${targetUserId}/unhide`),
                data: JSON.stringify(keys),
                contentType: 'application/json'
            });
            return true;
        } catch (e) {
            if (e instanceof Object && 'status' in e && e.status === 403) console.warn('🪼 Jellyfin Enhanced: Hidden Content admin unhide denied (not an admin).');
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
    async function adminHideForUser(targetUserId: string, items: HiddenItem[]) {
        if (!targetUserId || !Array.isArray(items) || items.length === 0) return false;
        const api=lease(JE).api;
        try {
            const res = await api.ajax({
                type: 'POST',
                url: api.getUrl(`/JellyfinEnhanced/admin/hidden-content/${targetUserId}/hide`),
                data: JSON.stringify(items),
                contentType: 'application/json'
            });
            return decodeAdded(res);
        } catch (e) {
            if (e instanceof Object && 'status' in e && e.status === 403) console.warn('🪼 Jellyfin Enhanced: Hidden Content admin hide denied (not an admin / disabled).');
            return false;
        }
    }

    // Direct bypass of JE.saveUserSettings (which swallows errors) so callers can react to failure.
    // Returns the JSON snapshot that was sent so the caller can compare it to current state and decide
    // whether the success acknowledgement still represents the latest local intent.
    function directSaveHiddenContent() {
        return enqueueWrite(JE,async(api)=>{
        assertWritable();
        const userId = api.getCurrentUserId();
        if (!userId) throw new Error('no current user');
        const snapshot = JSON.stringify(getHiddenData());
        await api.ajax({
            type: 'POST',
            url: api.getUrl(`/JellyfinEnhanced/user-settings/${userId}/hidden-content.json`),
            data: snapshot,
            contentType: 'application/json'
        });
        return snapshot;
        });
    }

    // After a successful save, decide whether the server is caught up.
    // - Match: cancel any pending (non-in-flight) retry — server has the latest.
    // - Mismatch: state moved during the await; schedule another save.
    // The retry-timer body explicitly clears RETRY_INFLIGHT before calling this so a same-state mismatch
    // doesn't leave the sentinel stuck; cancelPendingRetry refuses to clear an in-flight retry from another path.
    // `generation` is the saveGeneration captured BEFORE the POST that
    // produced `snapshotSent` — a save spanning a user switch must not
    // reschedule itself under the new user (it would serialize the reset
    // store to the incoming user's file).
    function reconcileAfterSave(snapshotSent: string, generation: number, identity:ReturnType<typeof lease>) {
        if (generation !== saveGeneration || !identity.current()) return;
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
    let pendingRetryHandle: ReturnType<typeof setTimeout> | null = null;

    function cancelPendingRetry() {
        // Don't unset RETRY_INFLIGHT — the timer body whose POST is in flight needs to manage its own
        // lifecycle. Clearing it here would let a follow-up debouncedSave failure spawn a parallel ladder.
        if (pendingRetryHandle === RETRY_INFLIGHT) return;
        if (pendingRetryHandle != null) clearTimeout(pendingRetryHandle);
        pendingRetryHandle = null;
    }

    function scheduleFlushRetry(attempt: number, generation: number) {
        if (generation !== saveGeneration) return;
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
        if (generation !== saveGeneration) return; // save chain belongs to a previous user
        const identity=lease(JE);
        pendingRetryHandle = setTimeout(async () => {
            if (generation !== saveGeneration || !identity.current()) {pendingRetryHandle=null;return;} // user switched since scheduling
            pendingRetryHandle = RETRY_INFLIGHT; // mark in-flight so a concurrent debouncedSave failure doesn't spawn a parallel ladder
            try {
                const sent = await directSaveHiddenContent();
                // Retry succeeded — clear the in-flight sentinel BEFORE reconcile so a state-mismatch
                // reschedule via debouncedSave doesn't leave the sentinel stuck (cancelPendingRetry from
                // other code paths intentionally refuses to clear RETRY_INFLIGHT).
                if (generation === saveGeneration && pendingRetryHandle === RETRY_INFLIGHT) pendingRetryHandle = null;
                reconcileAfterSave(sent, generation, identity);
            } catch (err) {
                console.warn(`🪼 Jellyfin Enhanced: hidden-content save retry ${attempt + 1} failed`, err);
                if(identity.current())scheduleFlushRetry(attempt + 1, generation);else pendingRetryHandle=null;
            }
        }, FLUSH_RETRY_DELAYS_MS[attempt]);
    }

    // Flush pending debouncedSave so a following server-direct write sees the latest local state.
    // On failure: re-throw so the caller aborts, AND start a bounded background retry so the local mutation isn't lost.
    async function flushPendingSave() {
        if (!saveTimeout) { await pendingWrites(JE); return; }
        clearTimeout(saveTimeout);
        saveTimeout = null;
        const identity=lease(JE), generation = saveGeneration;
        try {
            const sent = await directSaveHiddenContent();
            reconcileAfterSave(sent, generation, identity);
        } catch (e) {
            console.warn('🪼 Jellyfin Enhanced: flushPendingSave failed; scheduling background retry', e);
            if (identity.current() && pendingRetryHandle == null) scheduleFlushRetry(0, generation);
            throw e;
        }
    }

    // Cancel pending retries on tab teardown so a stale snapshot can't overwrite server state after navigation.
    // Only pagehide — visibilitychange fires on backgrounded tabs the user may return to within the retry window.
    try {
        window.addEventListener('pagehide', cancelPendingRetry);
    } catch (_) { /* non-browser env, harmless */ }

    // Invalidate every scheduled save/retry on a user switch (the generation
    // guard in the timer bodies covers the in-flight sentinel this
    // cancellation cannot reach).
    host.JellyfinEnhanced.session?.onUserChange('hidden-content-save', () => {
        saveGeneration++;
        if (saveTimeout) { clearTimeout(saveTimeout); saveTimeout = null; }
        cancelPendingRetry();
        pendingRetryHandle = null;
    });

    Object.assign(internal, {
        debouncedSave,
        flushPendingSave,
        fetchHiddenContentUsers,
        fetchUserHiddenItemsForAdmin,
        adminUnhideForUser,
        adminHideForUser,
    });

})(host.JellyfinEnhanced);
