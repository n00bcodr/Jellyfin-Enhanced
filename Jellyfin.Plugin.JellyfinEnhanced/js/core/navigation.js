// @ts-check
// /js/core/navigation.js
//
// Single owner of SPA navigation detection for the whole plugin.
//
// Jellyfin navigates four different ways (pushState, replaceState, hash
// change, history pop) and shows views via a 'viewshow' DOM event plus an
// Emby.Page.onViewShow router callback. Before this module existed, ~36 call
// sites wired their own hashchange/viewshow listeners, double-firing on hash
// navs and missing pushState navs entirely. This module patches history once,
// listens once, dedupes, and fans out to registered callbacks.
//
// Public surface: JE.core.navigation { onNavigate, offNavigate, onViewPage,
// getCurrentView }. JE.helpers keeps thin aliases for unmigrated callers.
(function(JE) {
    'use strict';

    JE.core = JE.core || {};

    const logPrefix = '🪼 Jellyfin Enhanced: Navigation:';

    // ── Navigation events (URL changes) ─────────────────────────────────────

    /** @type {Set<Function>} */
    const navCallbacks = new Set();

    // Dedup guard: a hash navigation fires BOTH popstate and hashchange for
    // the same URL change. Only dispatch when the URL actually moved.
    let lastDispatchedHref = null;

    /**
     * Patch history.pushState / history.replaceState to emit a 'je:navigate'
     * event. Jellyfin's SPA router calls pushState for some transitions
     * without changing location.hash, so hashchange/popstate are never fired
     * for those navigations. This single patch lets all modules listen to one
     * synthetic event instead of polling.
     */
    function patchNavigationEvents() {
        if (history.__jePushed) return; // only patch once
        history.__jePushed = true;

        const _push = history.pushState.bind(history);
        const _replace = history.replaceState.bind(history);

        // Some host pages (e.g. third-party custom-tabs plugins reacting to DOM
        // mutations) call pushState repeatedly for a URL that hasn't changed.
        // Skip the synthetic event in that case so we don't re-trigger our own
        // navigation-driven rescans, which would mutate the DOM and risk feeding
        // back into whatever observer caused the redundant pushState in the first place.
        history.pushState = function(...args) {
            const before = window.location.href;
            _push(...args);
            if (window.location.href !== before) {
                window.dispatchEvent(new Event('je:navigate'));
            }
        };
        history.replaceState = function(...args) {
            const before = window.location.href;
            _replace(...args);
            if (window.location.href !== before) {
                window.dispatchEvent(new Event('je:navigate'));
            }
        };
    }

    /**
     * Fan a navigation event out to all subscribers, at most once per URL
     * change (popstate + hashchange pairs collapse to one dispatch).
     * @param {Event} [event]
     */
    function dispatchNavigate(event) {
        if (window.location.href === lastDispatchedHref) return;
        lastDispatchedHref = window.location.href;
        for (const callback of navCallbacks) {
            try {
                callback(event);
            } catch (err) {
                console.error(`${logPrefix} Error in onNavigate callback:`, err);
            }
        }
    }

    /**
     * Subscribe to all navigation events: pushState, replaceState, hashchange,
     * popstate — deduplicated so each URL change notifies exactly once.
     * @param {Function} callback - Called on every navigation.
     * @returns {Function} Unsubscribe function.
     */
    function onNavigate(callback) {
        navCallbacks.add(callback);
        return () => offNavigate(callback);
    }

    /**
     * Remove a previously registered navigation callback.
     * @param {Function} callback
     * @returns {boolean} True if it was registered.
     */
    function offNavigate(callback) {
        return navCallbacks.delete(callback);
    }

    // ── View events (viewshow / Emby.Page.onViewShow) ────────────────────────

    /** @type {Array<{callback: Function, options: {pages: string[]|null, fetchItem: boolean, immediate: boolean}}>} */
    const viewHandlers = [];

    // Whether the Emby.Page.onViewShow override is installed. When it is, the
    // host router's own document-level 'viewshow' listener forwards every view
    // show into our hook, so our fallback document listener must stay silent
    // to avoid double-firing handlers.
    let embyHookInstalled = false;
    let originalOnViewShow = null;

    // The most recent raw 'viewshow' event, captured in the capture phase so
    // it is available by the time the router's bubble-phase listener invokes
    // our Emby.Page.onViewShow hook. Cleared after each notification so
    // router-internal onViewShow() calls (same-path resolves) don't see a
    // stale event from the previous view.
    /** @type {CustomEvent|null} */
    let lastViewShowEvent = null;

    /**
     * Get item from URL hash (cached via JE.helpers when available).
     * @param {string} hash - The URL hash
     * @returns {Promise<object|null>}
     */
    async function getItemFromHash(hash) {
        try {
            const params = new URLSearchParams(String(hash || '').split('?')[1]);
            const itemId = params.get('id');
            if (!itemId) return null;

            if (typeof JE.helpers?.getItemCached === 'function') {
                return await JE.helpers.getItemCached(itemId);
            }
            return await ApiClient.getItem(ApiClient.getCurrentUserId(), itemId);
        } catch (err) {
            console.error(`${logPrefix} Error fetching item:`, err);
            return null;
        }
    }

    /**
     * Notify all registered view handlers about a view change.
     * @param {string|undefined} view - The view name
     * @param {HTMLElement|undefined|null} element - The view element
     * @param {string|undefined} hash - The URL hash
     * @param {CustomEvent|null} rawEvent - The raw 'viewshow' DOM event, when one triggered this.
     */
    function notifyViewHandlers(view, element, hash, rawEvent) {
        viewHandlers.forEach(handlerConfig => {
            try {
                const { callback, options } = handlerConfig;

                // Check if this handler should be called for this page
                if (options.pages && !options.pages.includes(view)) {
                    return;
                }

                // Get item promise if needed
                let itemPromise = null;
                if (options.fetchItem) {
                    itemPromise = getItemFromHash(hash);
                }

                // Call the handler
                callback(view, element, hash, itemPromise, rawEvent);
            } catch (err) {
                console.error(`${logPrefix} Error in view handler:`, err);
            }
        });
    }

    /**
     * Register a callback to be called when a page view is shown.
     * @param {Function} callback - Called with (view, element, hash, itemPromise, rawEvent)
     * @param {Object} [options] - Options for the handler
     * @param {string[]} [options.pages] - Array of page names to trigger on
     * @param {boolean} [options.fetchItem] - Whether to fetch item from hash (default: false)
     * @param {boolean} [options.immediate] - Whether to call immediately if on matching page (default: false)
     * @returns {Function} Unregister function
     */
    function onViewPage(callback, options = {}) {
        const handlerConfig = {
            callback,
            options: {
                pages: options.pages || null,
                fetchItem: options.fetchItem || false,
                immediate: options.immediate || false
            }
        };

        viewHandlers.push(handlerConfig);

        // Call immediately if requested and we're on a matching page
        if (options.immediate) {
            try {
                const currentView = getCurrentView();
                const currentHash = window.location.hash;

                if (!options.pages || options.pages.includes(currentView)) {
                    const element = document.querySelector('.libraryPage:not(.hide)');
                    let itemPromise = null;
                    if (options.fetchItem) {
                        itemPromise = getItemFromHash(currentHash);
                    }
                    callback(currentView, element, currentHash, itemPromise, null);
                }
            } catch (err) {
                console.error(`${logPrefix} Error in immediate handler call:`, err);
            }
        }

        // Return unregister function
        return () => {
            const index = viewHandlers.indexOf(handlerConfig);
            if (index !== -1) {
                viewHandlers.splice(index, 1);
            }
        };
    }

    /**
     * Get current view name.
     * @returns {string|null}
     */
    function getCurrentView() {
        const visiblePage = document.querySelector('.libraryPage:not(.hide)');
        if (!visiblePage) return null;

        // Try to get view from data attributes or id
        return (/** @type {HTMLElement} */ (visiblePage)).dataset.type ||
               visiblePage.id ||
               visiblePage.getAttribute('data-role') ||
               null;
    }

    /**
     * Hook into Emby.Page.onViewShow. Retries until the host router exists.
     */
    function installEmbyHook() {
        if (!window.Emby?.Page) {
            setTimeout(installEmbyHook, 100);
            return;
        }

        originalOnViewShow = window.Emby.Page.onViewShow;

        window.Emby.Page.onViewShow = function(view, element, hash) {
            // Call original handler first
            if (originalOnViewShow) {
                try {
                    originalOnViewShow.call(this, view, element, hash);
                } catch (err) {
                    console.warn(`${logPrefix} Error in original onViewShow:`, err);
                }
            }

            const rawEvent = lastViewShowEvent;
            lastViewShowEvent = null;
            notifyViewHandlers(view, element, hash, rawEvent);
        };

        embyHookInstalled = true;
        console.log(`${logPrefix} Hooked into Emby.Page.onViewShow`);
    }

    function initialize() {
        // Capture the raw viewshow event before the router's bubble-phase
        // listener forwards the show into our Emby.Page hook.
        document.addEventListener('viewshow', (e) => {
            lastViewShowEvent = /** @type {CustomEvent} */ (e);
        }, true);

        // Fallback for hosts where Emby.Page never appears: drive view
        // handlers straight from the DOM event. Silent while the hook is
        // installed — the router already forwards those into the hook.
        document.addEventListener('viewshow', (e) => {
            if (embyHookInstalled) return;
            const rawEvent = /** @type {CustomEvent} */ (e);
            lastViewShowEvent = null;
            // jellyfin-web dispatches viewshow ON the view element and its detail carries
            // { type, properties, params, isRestored, state, options } — there is no
            // detail.view, so the element must come from the event target.
            const viewEl = /** @type {HTMLElement|null} */ (rawEvent.target);
            notifyViewHandlers(getCurrentView() || undefined, viewEl, window.location.hash, rawEvent);
        });

        // Navigation sources → single deduplicated dispatch
        window.addEventListener('je:navigate', dispatchNavigate);
        window.addEventListener('hashchange', dispatchNavigate);
        window.addEventListener('popstate', dispatchNavigate);

        patchNavigationEvents();
        installEmbyHook();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize);
    } else {
        initialize();
    }

    JE.core.navigation = {
        onNavigate,
        offNavigate,
        onViewPage,
        getCurrentView,
        /** @returns {number} Number of registered onViewPage handlers. */
        getViewHandlerCount: () => viewHandlers.length,
        /** @returns {number} Number of registered onNavigate callbacks. */
        getNavCallbackCount: () => navCallbacks.size
    };

    console.log(`${logPrefix} initialized`);

})(window.JellyfinEnhanced);
