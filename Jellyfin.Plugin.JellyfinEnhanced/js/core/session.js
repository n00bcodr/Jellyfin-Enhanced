// @ts-check
// /js/core/session.js
//
// Single owner of the "who is signed in" question for the whole plugin.
//
// Jellyfin's web client is an SPA: logging out and logging back in as a
// DIFFERENT user is just a route change — index.html is NOT reloaded, so
// every module-level snapshot taken at boot (JE.userConfig, JE.currentUser,
// JE.currentSettings, per-feature in-memory caches) silently keeps the
// previous user's data until a hard refresh. This module detects identity
// transitions and fans them out so every per-user cache can reset itself.
//
// Detection is belt-and-braces, because no single signal is reliable across
// Jellyfin 10.11 and 12:
//   1. A wrapper around ApiClient.setAuthenticationInfo — the one call every
//      login/logout path goes through — so the reset runs the moment
//      credentials change, even when no navigation happens.
//   2. The shared je:navigate pipeline (login/logout always navigates), which
//      also covers hosts where the wrapper could not be installed.
//   3. A 'storage' listener on 'jellyfin_credentials' for sign-ins that
//      happen in another tab of the same browser profile.
//   4. A slow reconcile interval that re-installs the wrapper if the host
//      ever replaces window.ApiClient wholesale (multi-server switching).
//
// Transitions are numbered with a monotonically increasing "epoch". Async
// work that loads per-user data must capture the epoch before awaiting and
// drop its result if the epoch moved on — that closes the race where user A's
// slow fetch resolves after user B has already signed in.
//
// Public surface: JE.session { getUserId, getServerId, getEpoch,
// onUserChange(name, fn), isCurrent(epoch), checkNow(reason) }.
// Transition order: reset handlers run synchronously (registration order),
// then a 'je:user-changed' CustomEvent is dispatched on document.
(function(JE) {
    'use strict';

    JE.core = JE.core || {};

    const logPrefix = '🪼 Jellyfin Enhanced: Session:';

    // Monotonic identity generation. 0 = pre-adoption (never seen a user).
    let epoch = 0;
    /** @type {string|null} */
    let currentUserId = null;
    /** @type {string|null} */
    let currentServerId = null;
    // First read adopts silently (boot is already loading this user's data);
    // only LATER changes are real transitions that must reset state.
    let adopted = false;

    /** @type {Map<string, Function>} Reset handlers, keyed by feature name (insertion order preserved). */
    const resetHandlers = new Map();

    /**
     * Read the signed-in identity from the host ApiClient. Never throws.
     * ApiClient.serverId is a function on 10.11/12 apiclients but has been a
     * bare property on older builds, so both shapes are probed.
     * @returns {{userId: string|null, serverId: string|null}}
     */
    function readIdentity() {
        try {
            if (typeof ApiClient === 'undefined' || !ApiClient) return { userId: null, serverId: null };
            const userId = (typeof ApiClient.getCurrentUserId === 'function' ? ApiClient.getCurrentUserId() : null) || null;
            let serverId = null;
            try {
                serverId = (typeof ApiClient.serverId === 'function' ? ApiClient.serverId() : ApiClient.serverId)
                    || ApiClient._serverInfo?.Id
                    || null;
            } catch (_) { serverId = null; }
            return { userId, serverId };
        } catch (_) {
            return { userId: null, serverId: null };
        }
    }

    /**
     * Register a reset handler that runs synchronously on every identity
     * transition (user switch, logout, server switch). Handlers must only
     * CLEAR state — reloading data for the new user belongs in a
     * 'je:user-changed' / 'je:user-data-loaded' listener, because at reset
     * time the new credentials may not be installed yet.
     * Registering again under the same name replaces the previous handler
     * (safe for modules that re-run).
     * @param {string} name - Feature identifier, used for error logging.
     * @param {(change: {userId: string|null, serverId: string|null, epoch: number, previousUserId: string|null, reason: string}) => void} fn
     * @returns {Function} Unregister function.
     */
    function onUserChange(name, fn) {
        resetHandlers.set(name, fn);
        return () => { resetHandlers.delete(name); };
    }

    /**
     * Run an identity transition: bump the epoch, run every reset handler,
     * then announce the change. Synchronous so no stale-data window exists
     * between the credential swap and the cache clears.
     * @param {string|null} userId
     * @param {string|null} serverId
     * @param {string} reason - Which detector fired (for logging).
     * @returns {boolean} True if a transition actually happened.
     */
    function transition(userId, serverId, reason) {
        if (userId === currentUserId && serverId === currentServerId) return false;

        // First sighting of a user: adopt without resetting. Boot (plugin.js)
        // is fetching this same user's data right now — a reset here would
        // wipe state that was never another user's.
        if (!adopted && currentUserId === null && userId !== null) {
            adopted = true;
            epoch++;
            currentUserId = userId;
            currentServerId = serverId;
            return false;
        }

        const previousUserId = currentUserId;
        epoch++;
        const myEpoch = epoch;
        currentUserId = userId;
        currentServerId = serverId;
        console.log(`${logPrefix} identity transition (${reason}): ${previousUserId || 'none'} → ${userId || 'none'} (epoch ${myEpoch})`);

        const change = { userId, serverId, epoch: myEpoch, previousUserId, reason };
        for (const [name, fn] of resetHandlers) {
            // A reset handler may itself trigger a nested transition (it
            // shouldn't, but never loop on it) — stop applying a stale change.
            if (epoch !== myEpoch) break;
            try {
                fn(change);
            } catch (err) {
                console.error(`${logPrefix} reset handler "${name}" failed:`, err);
            }
        }

        if (epoch === myEpoch) {
            try {
                document.dispatchEvent(new CustomEvent('je:user-changed', { detail: change }));
            } catch (err) {
                console.error(`${logPrefix} je:user-changed dispatch failed:`, err);
            }
        }
        return true;
    }

    /**
     * Compare the live ApiClient identity against the last known one and
     * transition if they differ. Cheap (two property reads) — safe to call
     * from every navigation.
     * @param {string} reason
     */
    function checkNow(reason) {
        const { userId, serverId } = readIdentity();
        transition(userId, serverId, reason);
    }

    /**
     * Wrap ApiClient.setAuthenticationInfo so the identity transition runs
     * the moment credentials change. The wrapper transitions BEFORE calling
     * through for a *different* user (previous user's caches are cleared
     * before the new token exists — no window where B's token can read A's
     * snapshot) and re-checks after, covering logout (null user).
     * Walks the prototype chain: the method usually lives on
     * ApiClient's prototype, not the instance.
     * @param {object} client - The ApiClient instance to hook.
     * @returns {boolean} True when the hook is (already) installed.
     */
    function installAuthHook(client) {
        try {
            if (!client) return false;
            /** @type {object|null} */
            let owner = client;
            while (owner && !Object.prototype.hasOwnProperty.call(owner, 'setAuthenticationInfo')) {
                owner = Object.getPrototypeOf(owner);
            }
            if (!owner) return false;
            const original = owner.setAuthenticationInfo;
            if (typeof original !== 'function') return false;
            if (original.__jeSessionWrapped) return true;

            const wrapped = function(/** @type {any} */ accessKey, /** @type {any} */ userId) {
                // Clear the old user's state before the host installs the new
                // credentials; serverId is unchanged by this call.
                try {
                    const nextUserId = userId || null;
                    if (adopted && nextUserId !== currentUserId) {
                        transition(nextUserId, currentServerId, 'authentication');
                    }
                } catch (err) {
                    console.error(`${logPrefix} pre-auth transition failed:`, err);
                }
                const result = original.apply(this, arguments);
                // Post-check picks up anything the pre-check couldn't know
                // (first adoption, serverId changes surfaced by the client).
                try { checkNow('authentication'); } catch (_) { /* logged in transition */ }
                return result;
            };
            wrapped.__jeSessionWrapped = true;
            try {
                owner.setAuthenticationInfo = wrapped;
            } catch (_) {
                // Prototype property not writable — fall back to shadowing on
                // the instance itself.
                client.setAuthenticationInfo = wrapped;
            }
            return true;
        } catch (err) {
            console.warn(`${logPrefix} could not hook setAuthenticationInfo:`, err);
            return false;
        }
    }

    function initialize() {
        // Adopt whoever is signed in right now (component scripts only load
        // after login, so this normally lands the first epoch immediately).
        checkNow('startup');
        installAuthHook(typeof ApiClient !== 'undefined' ? ApiClient : null);

        // Every login/logout navigates, so this alone would eventually catch
        // all transitions even if the auth hook failed to install.
        JE.core.navigation.onNavigate(() => checkNow('navigate'));

        // Credentials changed by ANOTHER tab of the same browser profile.
        window.addEventListener('storage', (e) => {
            if (e.key === 'jellyfin_credentials') checkNow('storage');
        });

        // Slow reconcile: catches window.ApiClient being replaced wholesale
        // (multi-server switching creates a fresh client our wrapper isn't
        // on) and any path none of the event-driven detectors saw. Two
        // property reads per tick — no observable cost.
        setInterval(() => {
            installAuthHook(typeof ApiClient !== 'undefined' ? ApiClient : null);
            checkNow('reconcile');
        }, 1000);
    }

    JE.session = {
        /** @returns {string|null} The signed-in user id (null on the login screen). */
        getUserId: () => currentUserId,
        /** @returns {string|null} The current server id, when the client exposes one. */
        getServerId: () => currentServerId,
        /** @returns {number} The current identity epoch (bumps on every transition). */
        getEpoch: () => epoch,
        /**
         * Whether a captured epoch is still the live one. Async loaders use
         * this to drop results that finished after a user switch.
         * @param {number} capturedEpoch
         */
        isCurrent: (capturedEpoch) => capturedEpoch === epoch,
        onUserChange,
        checkNow
    };

    initialize();

    console.log(`${logPrefix} initialized`);

})(window.JellyfinEnhanced);
