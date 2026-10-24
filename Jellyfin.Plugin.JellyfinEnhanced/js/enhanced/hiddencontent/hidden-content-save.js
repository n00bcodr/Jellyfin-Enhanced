/**
 * @file Hidden Content — saving changes (item and settings operations through
 * the settings store) and the admin cross-user endpoints.
 * Split from hidden-content.js (code motion; bodies verbatim).
 */
(function (JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const internal = JE.internals.hiddenContent = JE.internals.hiddenContent || {};

    // Every change is an item or settings operation on the person's hidden-content.json, queued in the settings store:
    // the server applies it to the document it holds then (PATCH, under the person's file lock) and answers the document,
    // so what another tab or device hid, unhid or changed meanwhile stays. The store shows the change at once; a change the
    // server refuses is shown undone, and said so.

    // Bumped on every user switch: an answer for the previous person is not reported to the next one.
    let saveGeneration = 0;

    /**
     * Saves one change to the person's hidden content.
     * @param {{upsert?: Object, remove?: string[], set?: Object}} operation Items by key to add or replace, item keys to
     *   remove, settings to set.
     * @param {any} origin JE.core.userWrite.origin() when the person acted (required: without it nothing is sent).
     * @returns {Promise<boolean>} Whether the server stored it.
     */
    function persist(operation, origin) {
        const generation = saveGeneration;
        // reportsFailure: a refusal is said here (an account change is said once by the page for all cancelled changes).
        const sent = JE.patchUserSettings('hidden-content.json', operation, { throwOnError: true, reportsFailure: true, origin });
        // A revision seen while this change was out is read once every change of this tab is answered.
        sent.finally(() => internal.readAfterSave?.()).catch(() => {});
        return sent.then(() => {
            // The server now answers with these rules: what was asked for before it had them (card tags) is asked again
            // ('je-hidden-content-changed' fired when the rules changed locally, before this save) (D46 r26).
            if (generation === saveGeneration) {
                try { window.dispatchEvent(new CustomEvent('je-hidden-content-saved')); } catch (_) { /* no listeners */ }
            }
            return true;
        }, error => {
            if (generation !== saveGeneration || error?.sessionChanged) return false;
            // A change refused because the document couldn't be read was already reported by the store.
            if (!error?.settingsNotRead) {
                // An answer that was lost doesn't prove it wasn't saved: the store reads the document again and says.
                if (JE.core.userWrite.outcome(error) === 'uncertain') {
                    JE.core.userWrite.reportUncertain(error);
                } else {
                    console.warn('🪼 Jellyfin Enhanced: hidden-content change not saved', error);
                    try { JE.toast?.(JE.t('hidden_content_save_failed_persistent'), 5000); } catch (_) { /* best effort */ }
                }
            }
            return false;
        });
    }

    /**
     * Whether a change of this tab to the person's hidden content is still out (queued or sent, not yet answered): a rules
     * read started now must not be taken over it (it is read again after it).
     * @returns {boolean}
     */
    function hasPendingSave() {
        return JE.internals.userDocumentPending ? JE.internals.userDocumentPending('hidden-content.json') : false;
    }

    /** Settles once every hidden-content change queued so far has been answered (before a server-side hide write). */
    function flushPendingSave() {
        return JE.internals.userDocumentSettled ? JE.internals.userDocumentSettled('hidden-content.json') : Promise.resolve();
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
            const res = await JE.core.api.ajax({
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
            const res = await JE.core.api.ajax({
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
     * @param {any} origin JE.core.userWrite.origin() when the administrator acted.
     * @returns {Promise<boolean|'uncertain'>} true on success; 'uncertain' when the answer was lost (it may be stored).
     */
    async function adminUnhideForUser(targetUserId, keys, origin) {
        if (!targetUserId || !Array.isArray(keys) || keys.length === 0) return false;
        try {
            await JE.core.api.ajax({
                session: origin,
                type: 'POST',
                url: ApiClient.getUrl(`/JellyfinEnhanced/admin/hidden-content/${targetUserId}/unhide`),
                data: JSON.stringify(keys),
                contentType: 'application/json'
            });
            return true;
        } catch (e) {
            if (e && e.status === 403) console.warn('🪼 Jellyfin Enhanced: Hidden Content admin unhide denied (not an admin).');
            return JE.core.userWrite.outcome(e) === 'uncertain' && !e?.sessionChanged ? 'uncertain' : false;
        }
    }

    /**
     * Admin-only: hides items on behalf of another user (admin adding). Server enforces
     * admin + the HiddenContentAdmin toggle. Fails soft (returns false) so a denied/transient error never throws.
     * @param {string} targetUserId Jellyfin user ID in N format (no dashes).
     * @param {Array<Object>} items Hidden-content item objects to add (same shape as getAllHiddenItems).
     * @param {any} origin JE.core.userWrite.origin() when the administrator acted.
     * @returns {Promise<number|boolean|'uncertain'>} Count newly added, or false on failure; 'uncertain' when the answer
     *   was lost (it may be stored).
     */
    async function adminHideForUser(targetUserId, items, origin) {
        if (!targetUserId || !Array.isArray(items) || items.length === 0) return false;
        try {
            const res = await JE.core.api.ajax({
                session: origin,
                type: 'POST',
                url: ApiClient.getUrl(`/JellyfinEnhanced/admin/hidden-content/${targetUserId}/hide`),
                data: JSON.stringify(items),
                contentType: 'application/json'
            });
            return (res && typeof res.added === 'number') ? res.added : true;
        } catch (e) {
            if (e && e.status === 403) console.warn('🪼 Jellyfin Enhanced: Hidden Content admin hide denied (not an admin / disabled).');
            return JE.core.userWrite.outcome(e) === 'uncertain' && !e?.sessionChanged ? 'uncertain' : false;
        }
    }

    window.JellyfinEnhanced.session?.onUserChange('hidden-content-save', () => { saveGeneration++; });

    Object.assign(internal, {
        persist,
        hasPendingSave,
        flushPendingSave,
        fetchHiddenContentUsers,
        fetchUserHiddenItemsForAdmin,
        adminUnhideForUser,
        adminHideForUser,
    });

})(window.JellyfinEnhanced);
