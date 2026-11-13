/**
 * @file Hidden Content — debounced persistence, the bounded retry ladder,
 * and the admin cross-user endpoints.
 * Split from hidden-content.js (code motion; bodies verbatim).
 */
(function (JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const internal = JE.internals.hiddenContent = JE.internals.hiddenContent || {};

    const { getHiddenData, isLoaded, rebaseOnto } = internal;

    let saveTimeout = null;

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
        const scheduledGeneration = saveGeneration;
        saveTimeout = setTimeout(async () => {
            saveTimeout = null;
            if (scheduledGeneration !== saveGeneration) return; // user switched since scheduling
            try {
                // Route through directSaveHiddenContent (not JE.saveUserSettings) so a successful save can
                // reconcile against any in-flight retry and a failure can re-enter the retry ladder.
                // JE.saveUserSettings swallows errors, which would leave a pending retry firing later and
                // clobbering server state.
                const sent = await directSaveHiddenContent();
                reconcileAfterSave(sent, scheduledGeneration);
            } catch (e) {
                console.warn('🪼 Jellyfin Enhanced: debouncedSave failed; scheduling background retry', e);
                if (pendingRetryHandle == null) scheduleFlushRetry(0, scheduledGeneration);
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
            const hc = internal.withPlainNames((typeof JE.toCamelCase === 'function')
                ? JE.toCamelCase(res && res.hiddenContent)
                : (res && res.hiddenContent));
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

    // Saves run one at a time: each reads the stored list and writes it back with this session's
    // changes, so two in flight at once could each write a list without the other's changes.
    let saveQueue = Promise.resolve();
    // The last save queued, until it settles, so flushPendingSave can wait for it and report its failure.
    let lastSave = null;

    // Later saves and a Continue Watching / Next Up removal wait for the save in flight, and ApiClient.ajax
    // only gives up on a request when asked to, so a read or write that never gets an answer fails after this
    // long and the save is retried like any other failure.
    const SAVE_REQUEST_TIMEOUT_MS = 30000;

    async function requestWithTimeout(request) {
        let timer = null;
        const timedOut = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('hidden-content request timed out')), SAVE_REQUEST_TIMEOUT_MS);
        });
        try {
            return await Promise.race([ApiClient.ajax(request), timedOut]);
        } finally {
            clearTimeout(timer);
        }
    }

    // Direct bypass of JE.saveUserSettings (which swallows errors) so callers can react to failure.
    // Returns the saved list, as the session holds it, as JSON so the caller can compare it to current state and decide
    // whether the success acknowledgement still represents the latest local intent.
    function directSaveHiddenContent() {
        const save = saveQueue.then(saveOnce);
        saveQueue = save.catch(() => {});
        lastSave = save;
        const settled = () => { if (lastSave === save) lastSave = null; };
        save.then(settled, settled);
        return save;
    }

    // The list is saved whole, but other devices, an administrator and the server (Continue Watching
    // hides dropped on playback, removed items) change it too. So each save reads the stored list first
    // and writes it with only this session's changes applied, never the copy the page loaded.
    async function saveOnce() {
        // Never write a list that did not load: it would replace the stored one.
        if (!isLoaded()) throw new Error('hidden-content list not loaded');
        const userId = ApiClient.getCurrentUserId();
        if (!userId) throw new Error('no current user');
        const generation = saveGeneration;
        const fresh = await requestWithTimeout({
            type: 'GET',
            url: ApiClient.getUrl(`/JellyfinEnhanced/user-settings/${userId}/hidden-content.json?_=${Date.now()}`),
            dataType: 'json'
        });
        if (generation !== saveGeneration || ApiClient.getCurrentUserId() !== userId) throw new Error('user changed during save');
        const stored = (typeof JE.toCamelCase === 'function') ? JE.toCamelCase(fresh) : fresh;
        if (!stored || typeof stored !== 'object' || (stored.items != null && typeof stored.items !== 'object')) {
            throw new Error('invalid hidden-content response');
        }
        const { list, saved } = rebaseOnto(stored);
        const snapshot = JSON.stringify(list);
        // Nothing of this session's to write (e.g. a hide undone before the save ran).
        if (snapshot !== JSON.stringify(stored)) {
            await requestWithTimeout({
                type: 'POST',
                url: ApiClient.getUrl(`/JellyfinEnhanced/user-settings/${userId}/hidden-content.json`),
                data: snapshot,
                contentType: 'application/json'
            });
        }
        // What the session now holds unchanged (names read as plain text), for reconcileAfterSave.
        return JSON.stringify(saved());
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
    function reconcileAfterSave(snapshotSent, generation) {
        if (generation !== saveGeneration) return;
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

    function scheduleFlushRetry(attempt, generation) {
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
        pendingRetryHandle = setTimeout(async () => {
            if (generation !== saveGeneration) { pendingRetryHandle = null; return; } // user switched since scheduling
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
                reconcileAfterSave(sent, generation);
            } catch (err) {
                console.warn(`🪼 Jellyfin Enhanced: hidden-content save retry ${attempt + 1} failed`, err);
                scheduleFlushRetry(attempt + 1, generation);
            }
        }, FLUSH_RETRY_DELAYS_MS[attempt]);
    }

    // Flush pending debouncedSave so a following server-direct write sees the latest local state.
    // On failure: re-throw so the caller aborts, AND start a bounded background retry so the local mutation isn't lost.
    // With nothing pending, wait for a save already in flight: it read the list before the server-direct
    // write and would otherwise write that read back over it. If it fails (or times out, when its write may
    // still land), re-throw as well; whoever started it has already scheduled its retry.
    async function flushPendingSave() {
        if (!saveTimeout) {
            if (lastSave) await lastSave;
            return;
        }
        clearTimeout(saveTimeout);
        saveTimeout = null;
        const generation = saveGeneration;
        try {
            const sent = await directSaveHiddenContent();
            reconcileAfterSave(sent, generation);
        } catch (e) {
            console.warn('🪼 Jellyfin Enhanced: flushPendingSave failed; scheduling background retry', e);
            if (pendingRetryHandle == null) scheduleFlushRetry(0, generation);
            throw e;
        }
    }

    // Cancel pending retries on tab teardown.
    // Only pagehide — visibilitychange fires on backgrounded tabs the user may return to within the retry window.
    // Only the page's own (its target is the document, or window when scripted): jellyfin-web dispatches a
    // bubbling `pagehide` on each view it leaves, and a back/forward-cache hide (persisted) may be shown again
    // with the retry still due.
    try {
        window.addEventListener('pagehide', (event) => {
            if ((event.target === window || event.target === document) && !event.persisted) cancelPendingRetry();
        });
    } catch (_) { /* non-browser env, harmless */ }

    // Invalidate every scheduled save/retry on a user switch (the generation
    // guard in the timer bodies covers the in-flight sentinel this
    // cancellation cannot reach).
    window.JellyfinEnhanced.session?.onUserChange('hidden-content-save', () => {
        saveGeneration++;
        if (saveTimeout) { clearTimeout(saveTimeout); saveTimeout = null; }
        cancelPendingRetry();
    });

    Object.assign(internal, {
        debouncedSave,
        flushPendingSave,
        fetchHiddenContentUsers,
        fetchUserHiddenItemsForAdmin,
        adminUnhideForUser,
        adminHideForUser,
    });

})(window.JellyfinEnhanced);
