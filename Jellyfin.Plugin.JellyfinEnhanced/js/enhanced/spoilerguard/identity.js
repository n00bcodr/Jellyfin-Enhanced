// @ts-check
// Browser identity hint for anonymous item-image requests.
(function(JE) {
    'use strict';

    JE.internals = JE.internals || {};
    /** @type {any} Shared cross-file namespace; each module contributes a focused surface. */
    const internal = JE.internals.spoilerGuard = JE.internals.spoilerGuard || {};
    const logPrefix = '🪼 Jellyfin Enhanced [SpoilerGuard]:';
    let primed = false;

    internal.setIdentityCookie = function() {
        try {
            const userId = typeof ApiClient?.getCurrentUserId === 'function' ? ApiClient.getCurrentUserId() : null;
            if (userId) document.cookie = `je-spoiler-uid=${encodeURIComponent(userId)}; path=/; SameSite=Lax`;
        } catch (e) {
            console.warn(`${logPrefix} identity cookie set failed:`, e);
        }
    };

    internal.primeIdentityCookie = function() {
        if (primed) return;
        primed = true;
        internal.setIdentityCookie();
        let tries = 0;
        try {
            const timer = setInterval(function() {
                const userId = typeof ApiClient?.getCurrentUserId === 'function' ? ApiClient.getCurrentUserId() : null;
                if (userId) {
                    internal.setIdentityCookie();
                    clearInterval(timer);
                } else if (++tries >= 20) {
                    clearInterval(timer);
                }
            }, 250);
        } catch (_) { /* init() still writes it once */ }
    };

    internal.primeIdentityCookie();

    // The cookie identifies the browser to the server for anonymous <img>
    // requests, so it must follow user switches: rewrite it for the incoming
    // user (the change payload carries the new id — ApiClient may not expose
    // it yet at reset time) and delete it on logout so the server never
    // resolves the previous user's spoiler policy.
    JE.session?.onUserChange('spoilerguard-identity', (change) => {
        try {
            if (change.userId) {
                document.cookie = `je-spoiler-uid=${encodeURIComponent(change.userId)}; path=/; SameSite=Lax`;
            } else {
                document.cookie = 'je-spoiler-uid=; path=/; SameSite=Lax; Max-Age=0';
            }
        } catch (e) {
            console.warn(`${logPrefix} identity cookie update on user switch failed:`, e);
        }
    });
})(window.JellyfinEnhanced);
