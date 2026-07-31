// @ts-check
// Refresh visible images after mark-played / mark-unplayed mutations.
(function(JE) {
    'use strict';

    JE.internals = JE.internals || {};
    /** @type {any} Shared cross-file namespace; each module contributes a focused surface. */
    const internal = JE.internals.spoilerGuard = JE.internals.spoilerGuard || {};
    const logPrefix = '🪼 Jellyfin Enhanced [SpoilerGuard]:';
    const playedRoute = /\/(?:Users\/[a-f0-9-]+\/PlayedItems|UserPlayedItems)\/[a-f0-9-]+/i;

    function maybeRefresh(method, url) {
        if (typeof url !== 'string' || !playedRoute.test(url)) return;
        if (method !== 'POST' && method !== 'DELETE') return;
        if (internal.isStateLoaded() && !internal.hasAnyState()) return;
        setTimeout(function() {
            try { internal.refreshSpoilerableImages(); }
            catch (e) { console.warn(`${logPrefix} watched-state image refresh failed:`, e); }
        }, 200);
    }

    internal.installWatchedRefresh = function() {
        if (window.__je_spoilerBlurWatchedHookInstalled) return;
        window.__je_spoilerBlurWatchedHookInstalled = true;

        try {
            const originalFetch = window.fetch;
            if (typeof originalFetch === 'function') {
                window.fetch = function(input, init) {
                    const url = typeof input === 'string'
                        ? input
                        : input instanceof URL
                            ? input.href
                            : input.url;
                    const method = String(
                        init?.method || (input instanceof Request ? input.method : 'GET')
                    ).toUpperCase();
                    const promise = originalFetch.apply(this, arguments);
                    if (playedRoute.test(url)) {
                        promise.then(response => {
                            if (response?.ok) maybeRefresh(method, url);
                        }).catch(function() {});
                    }
                    return promise;
                };
            }
        } catch (e) {
            console.warn(`${logPrefix} fetch watched-state hook failed:`, e);
        }

        try {
            const originalOpen = XMLHttpRequest.prototype.open;
            const originalSend = XMLHttpRequest.prototype.send;
            XMLHttpRequest.prototype.open = function(method, url) {
                this.__je_spoilerMethod = String(method || '').toUpperCase();
                this.__je_spoilerUrl = typeof url === 'string' ? url : '';
                return originalOpen.apply(this, arguments);
            };
            XMLHttpRequest.prototype.send = function() {
                const request = this;
                const method = request.__je_spoilerMethod;
                const url = request.__je_spoilerUrl;
                if (url && playedRoute.test(url) && (method === 'POST' || method === 'DELETE')) {
                    request.addEventListener('loadend', function() {
                        if (request.status >= 200 && request.status < 300) maybeRefresh(method, url);
                    });
                }
                return originalSend.apply(this, arguments);
            };
        } catch (e) {
            console.warn(`${logPrefix} XHR watched-state hook failed:`, e);
        }
    };
})(window.JellyfinEnhanced);
