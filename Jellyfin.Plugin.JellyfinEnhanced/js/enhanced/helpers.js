/**
 * @file Centralized helper utilities for Jellyfin Enhanced
 * Provides standardized functionality for hooking into page views and managing MutationObservers
 */
(function(JE) {
    'use strict';

    // Store the original onViewShow function
    let originalOnViewShow = null;

    // Array to store registered handlers
    const handlers = [];

    // Active observers registry for lifecycle management (non-body targets only)
    const activeObservers = new Map();

    // --- Multiplexed Body Observer ---
    // Single MutationObserver on document.body that dispatches to all registered subscribers.
    // This replaces the previous pattern of N separate observers on document.body,
    // reducing browser overhead from cloning MutationRecord lists N times and scheduling
    // N separate microtask callbacks down to a single observer + single dispatch loop.
    const bodySubscribers = new Map();
    let bodyObserver = null;

    function ensureBodyObserver() {
        if (bodyObserver) return;
        bodyObserver = new MutationObserver((mutations) => {
            // Fast-path: skip dispatch entirely if no nodes were added or removed.
            // This filters out attribute changes, text changes, hover effects, focus
            // changes, etc. that fire frequently but never add new content.
            let hasStructuralChange = false;
            for (let i = 0; i < mutations.length; i++) {
                if (mutations[i].addedNodes.length > 0 || mutations[i].removedNodes.length > 0) {
                    hasStructuralChange = true;
                    break;
                }
            }
            if (!hasStructuralChange) return;

            // NOTE: Callbacks may call unsubscribe()/disconnect(), deleting from this Map
            // during iteration. ES spec guarantees Map iteration handles concurrent deletion.
            for (const [id, sub] of bodySubscribers) {
                try {
                    sub.callback(mutations);
                } catch (err) {
                    console.error(`🪼 Jellyfin Enhanced: Error in body observer subscriber "${id}":`, err);
                }
            }
        });
        bodyObserver.observe(document.body, { childList: true, subtree: true });
        console.log('🪼 Jellyfin Enhanced: Shared body observer started');
    }

    function stopBodyObserverIfEmpty() {
        if (bodyObserver && bodySubscribers.size === 0) {
            bodyObserver.disconnect();
            bodyObserver = null;
            console.log('🪼 Jellyfin Enhanced: Shared body observer stopped (no subscribers)');
        }
    }

    /**
     * Re-sort bodySubscribers Map by priority (highest first).
     * Called when a subscriber with non-default priority is added.
     */
    function resortBodySubscribers() {
        const sorted = [...bodySubscribers.entries()].sort((a, b) => b[1].priority - a[1].priority);
        bodySubscribers.clear();
        for (const [id, sub] of sorted) {
            bodySubscribers.set(id, sub);
        }
    }

    /**
     * Register a callback with the shared body MutationObserver.
     * All subscribers share a single observer on document.body with { childList: true, subtree: true }.
     * @param {string} id - Unique identifier for this subscriber
     * @param {Function} callback - Called with (mutations) on each body mutation batch
     * @param {Object} [options] - Options
     * @param {number} [options.priority=0] - Execution priority. Higher values run first.
     *   Use priority > 0 for subscribers that should filter/hide content before others process it.
     * @returns {{ unsubscribe: Function, disconnect: Function }} Handle to remove this subscriber.
     *   Both unsubscribe() and disconnect() do the same thing -- provided so callers can use
     *   either the subscription convention or the MutationObserver convention consistently.
     */
    function onBodyMutation(id, callback, options) {
        const priority = (options && typeof options.priority === 'number') ? options.priority : 0;
        if (bodySubscribers.has(id)) {
            console.warn(`🪼 Jellyfin Enhanced: Replacing body observer subscriber: ${id}`);
        }
        bodySubscribers.set(id, { callback, priority });
        if (priority !== 0) {
            resortBodySubscribers();
        }
        ensureBodyObserver();
        console.log(`🪼 Jellyfin Enhanced: Body subscriber registered: ${id} (priority: ${priority}, total: ${bodySubscribers.size})`);
        const cleanup = () => {
            if (!bodySubscribers.has(id)) return;
            bodySubscribers.delete(id);
            console.log(`🪼 Jellyfin Enhanced: Body subscriber removed: ${id} (remaining: ${bodySubscribers.size})`);
            stopBodyObserverIfEmpty();
        };
        return { unsubscribe: cleanup, disconnect: cleanup };
    }

    /**
     * Remove a subscriber from the shared body observer.
     * @param {string} id - The subscriber ID
     * @returns {boolean} True if found and removed
     */
    function removeBodySubscriber(id) {
        const removed = bodySubscribers.delete(id);
        if (removed) {
            console.log(`🪼 Jellyfin Enhanced: Body subscriber removed: ${id} (remaining: ${bodySubscribers.size})`);
            stopBodyObserverIfEmpty();
        }
        return removed;
    }

    // Shared cache for item payloads to deduplicate cross-module ApiClient.getItem calls
    const itemCache = new Map();
    const ITEM_CACHE_TTL_MS = 30000; // 30s -- long enough for batch prefetch to warm cache before tag systems scan

    /**
     * Deduplicated item fetch with short TTL cache.
     * Prevents multiple modules from requesting the same item concurrently on detail page navigation.
     * @param {string} itemId
     * @param {Object} [options]
     * @param {string} [options.userId]
     * @param {number} [options.ttlMs]
     * @param {boolean} [options.forceRefresh]
     * @returns {Promise<object|null>}
     */
    async function getItemCached(itemId, options = {}) {
        if (!itemId) return null;

        const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : ITEM_CACHE_TTL_MS;
        const userId = options.userId || ApiClient.getCurrentUserId();
        const key = `${userId}:${itemId}`;
        const now = Date.now();
        const entry = itemCache.get(key);

        if (!options.forceRefresh && entry) {
            if (entry.promise) {
                return entry.promise;
            }
            if (entry.item && (now - entry.ts) < ttlMs) {
                return entry.item;
            }
        }

        const promise = ApiClient.getItem(userId, itemId)
            .then((item) => {
                itemCache.set(key, { item, ts: Date.now(), promise: null });
                return item;
            })
            .catch((err) => {
                itemCache.delete(key);
                throw err;
            });

        itemCache.set(key, { item: null, ts: now, promise });
        return promise;
    }


    /**
     * Patch history.pushState / history.replaceState to emit a 'je:navigate' event.
     * Jellyfin's SPA router calls pushState for some transitions without changing
     * location.hash, so hashchange/popstate are never fired for those navigations.
     * This single patch lets all modules listen to one synthetic event instead of polling.
     */
    function patchNavigationEvents() {
        if (history.__jePushed) return; // only patch once
        history.__jePushed = true;

        const _push = history.pushState.bind(history);
        const _replace = history.replaceState.bind(history);

        history.pushState = function(...args) {
            _push(...args);
            window.dispatchEvent(new Event('je:navigate'));
        };
        history.replaceState = function(...args) {
            _replace(...args);
            window.dispatchEvent(new Event('je:navigate'));
        };
    }

    /**
     * Subscribe to all navigation events: pushState, replaceState, hashchange, popstate.
     * @param {Function} callback - Called on every navigation.
     * @returns {Function} Unsubscribe function.
     */
    function onNavigate(callback) {
        window.addEventListener('je:navigate', callback);
        window.addEventListener('hashchange', callback);
        window.addEventListener('popstate', callback);
        return () => {
            window.removeEventListener('je:navigate', callback);
            window.removeEventListener('hashchange', callback);
            window.removeEventListener('popstate', callback);
        };
    }

    /**
     * Initialize the utils by hooking into Emby.Page.onViewShow
     */
    function initialize() {
        if (!window.Emby?.Page) {
            console.warn('🪼 Jellyfin Enhanced: Emby.Page not available, retrying in 100ms');
            setTimeout(initialize, 100);
            return;
        }

        // Patch navigation history methods so pushState fires je:navigate
        patchNavigationEvents();

        // Store original onViewShow if it exists
        originalOnViewShow = window.Emby.Page.onViewShow;

        // Override onViewShow to intercept page view changes
        window.Emby.Page.onViewShow = function(view, element, hash) {
            // Call original handler first
            if (originalOnViewShow) {
                try {
                    originalOnViewShow.call(this, view, element, hash);
                } catch (err) {
                    console.warn('🪼 Jellyfin Enhanced: Error in original onViewShow:', err);
                }
            }

            // Notify all registered handlers
            notifyHandlers(view, element, hash);
        };

        console.log('🪼 Jellyfin Enhanced: Successfully hooked into Emby.Page.onViewShow');
    }

    /**
     * Notify all registered handlers about a view change
     * @param {string} view - The view name
     * @param {HTMLElement} element - The view element
     * @param {string} hash - The URL hash
     */
    function notifyHandlers(view, element, hash) {
        handlers.forEach(handlerConfig => {
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
                callback(view, element, hash, itemPromise);
            } catch (err) {
                console.error('🪼 Jellyfin Enhanced: Error in handler:', err);
            }
        });
    }

    /**
     * Get item from URL hash (cached)
     * @param {string} hash - The URL hash
     * @returns {Promise<object|null>}
     */
    async function getItemFromHash(hash) {
        try {
            const params = new URLSearchParams(hash.split('?')[1]);
            const itemId = params.get('id');

            if (!itemId) return null;
            return await getItemCached(itemId);
        } catch (err) {
            console.error('🪼 Jellyfin Enhanced: Error fetching item:', err);
            return null;
        }
    }

    /**
     * Register a callback to be called when page view changes
     * @param {Function} callback - Function to call when page view changes
     * @param {Object} options - Options for the handler
     * @param {string[]} options.pages - Array of page names to trigger on (optional)
     * @param {boolean} options.fetchItem - Whether to fetch item from hash (default: false)
     * @param {boolean} options.immediate - Whether to call immediately if on matching page (default: false)
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

        handlers.push(handlerConfig);
        console.log(`🪼 Jellyfin Enhanced: Registered onViewPage handler (total: ${handlers.length})`);

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
                    callback(currentView, element, currentHash, itemPromise);
                }
            } catch (err) {
                console.error('🪼 Jellyfin Enhanced: Error in immediate handler call:', err);
            }
        }

        // Return unregister function
        return () => {
            const index = handlers.indexOf(handlerConfig);
            if (index !== -1) {
                handlers.splice(index, 1);
                console.log(`🪼 Jellyfin Enhanced: Unregistered onViewPage handler (remaining: ${handlers.length})`);
            }
        };
    }

    /**
     * Get current view name
     * @returns {string|null}
     */
    function getCurrentView() {
        const visiblePage = document.querySelector('.libraryPage:not(.hide)');
        if (!visiblePage) return null;

        // Try to get view from data attributes or id
        return visiblePage.dataset.type || 
               visiblePage.id || 
               visiblePage.getAttribute('data-role') || 
               null;
    }

    /**
     * Create a managed MutationObserver that can be properly cleaned up.
     * If target is document.body with { childList: true, subtree: true }, the callback
     * is automatically routed to the shared multiplexed body observer instead of
     * creating a separate MutationObserver instance.
     * @param {string} id - Unique identifier for this observer
     * @param {Function} callback - The mutation callback
     * @param {HTMLElement} target - The element to observe
     * @param {MutationObserverInit} config - The observer configuration
     * @returns {MutationObserver|{ disconnect: Function }} Observer handle
     */
    function createObserver(id, callback, target, config) {
        // Route body observers to the shared multiplexed observer
        const isBodyTarget = target === document.body || target === document.documentElement || target === document;
        const isSubtreeWatch = config && config.childList && config.subtree;

        if (isBodyTarget && isSubtreeWatch && !config.attributes && !config.attributeFilter && !config.characterData) {
            // Use shared body observer
            const handle = onBodyMutation(id, callback);
            // Return a duck-typed object compatible with both MutationObserver and subscription conventions
            const cleanup = () => handle.disconnect();
            const proxy = {
                disconnect: cleanup,
                unsubscribe: cleanup,
                observe() { /* no-op, already observing via shared observer */ },
                takeRecords() { return []; }
            };
            activeObservers.set(id, proxy);
            return proxy;
        }

        // For non-body targets or complex configs (attributes, characterData),
        // create a dedicated observer as before
        if (activeObservers.has(id)) {
            const existing = activeObservers.get(id);
            existing.disconnect();
            console.warn(`🪼 Jellyfin Enhanced: Replacing existing observer: ${id}`);
        }

        const observer = new MutationObserver(callback);
        observer.observe(target, config);

        activeObservers.set(id, observer);
        console.log(`🪼 Jellyfin Enhanced: Created dedicated observer: ${id} (total: ${activeObservers.size})`);

        return observer;
    }

    /**
     * Disconnect and remove a managed observer (or body subscriber)
     * @param {string} id - The observer ID
     * @returns {boolean} True if observer was found and disconnected
     */
    function disconnectObserver(id) {
        // Check body subscribers first
        if (bodySubscribers.has(id)) {
            removeBodySubscriber(id);
            activeObservers.delete(id);
            return true;
        }
        if (activeObservers.has(id)) {
            const observer = activeObservers.get(id);
            observer.disconnect();
            activeObservers.delete(id);
            console.log(`🪼 Jellyfin Enhanced: Disconnected observer: ${id} (remaining: ${activeObservers.size})`);
            return true;
        }
        return false;
    }

    /**
     * Disconnect all managed observers and body subscribers
     */
    function disconnectAllObservers() {
        activeObservers.forEach((observer, id) => {
            observer.disconnect();
        });
        activeObservers.clear();
        bodySubscribers.clear();
        if (bodyObserver) {
            bodyObserver.disconnect();
            bodyObserver = null;
        }
        console.log('🪼 Jellyfin Enhanced: All observers and body subscribers disconnected');
    }

    /**
     * Wait for an element to appear in the DOM
     * @param {string} selector - CSS selector
     * @param {number} timeout - Maximum wait time in ms (default: 10000)
     * @returns {Promise<HTMLElement|null>}
     */
    function waitForElement(selector, timeout = 10000) {
        return new Promise((resolve) => {
            const existing = document.querySelector(selector);
            if (existing) {
                resolve(existing);
                return;
            }

            const observerId = `wait-${selector}-${Date.now()}`;
            let timeoutId = null;

            const handle = onBodyMutation(observerId, () => {
                const element = document.querySelector(selector);
                if (element) {
                    if (timeoutId) clearTimeout(timeoutId);
                    handle.unsubscribe();
                    resolve(element);
                }
            });

            // Set timeout
            timeoutId = setTimeout(() => {
                handle.unsubscribe();
                console.warn(`🪼 Jellyfin Enhanced: Timeout waiting for element: ${selector}`);
                resolve(null);
            }, timeout);
        });
    }

    /**
     * Debounce a function call
     * @param {Function} func - The function to debounce
     * @param {number} wait - Wait time in ms
     * @returns {Function}
     */
    function debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }

    /**
     * Throttle a function call
     * @param {Function} func - The function to throttle
     * @param {number} limit - Time limit in ms
     * @returns {Function}
     */
    function throttle(func, limit) {
        let inThrottle;
        return function(...args) {
            if (!inThrottle) {
                func.apply(this, args);
                inThrottle = true;
                setTimeout(() => inThrottle = false, limit);
            }
        };
    }

    /**
     * Retry a function with exponential backoff
     * @param {Function} fn - The async function to retry
     * @param {number} maxAttempts - Maximum retry attempts (default: 5)
     * @param {number} baseDelay - Base delay in ms (default: 1000)
     * @returns {Promise<any>}
     */
    async function retry(fn, maxAttempts = 5, baseDelay = 1000) {
        let lastError;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                return await fn();
            } catch (error) {
                lastError = error;

                if (attempt === maxAttempts) {
                    console.error(`🪼 Jellyfin Enhanced: Failed after ${maxAttempts} attempts:`, error);
                    throw error;
                }

                const delay = baseDelay * Math.pow(2, attempt - 1);
                console.warn(`🪼 Jellyfin Enhanced: Attempt ${attempt}/${maxAttempts} failed, retrying in ${delay}ms...`, error);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }

        throw lastError;
    }

    /**
     * Check if an element is visible in the viewport
     * @param {HTMLElement} element - The element to check
     * @returns {boolean}
     */
    function isElementVisible(element) {
        if (!element) return false;

        const rect = element.getBoundingClientRect();
        return (
            rect.top >= 0 &&
            rect.left >= 0 &&
            rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
            rect.right <= (window.innerWidth || document.documentElement.clientWidth)
        );
    }

    /**
     * Wait for a condition to be true
     * @param {Function} condition - Function that returns boolean
     * @param {number} timeout - Maximum wait time in ms (default: 5000)
     * @param {number} interval - Check interval in ms (default: 100)
     * @returns {Promise<boolean>}
     */
    function waitForCondition(condition, timeout = 5000, interval = 100) {
        return new Promise((resolve) => {
            const startTime = Date.now();

            const checkCondition = () => {
                if (condition()) {
                    resolve(true);
                    return;
                }

                if (Date.now() - startTime >= timeout) {
                    console.warn('🪼 Jellyfin Enhanced: Timeout waiting for condition');
                    resolve(false);
                    return;
                }

                setTimeout(checkCondition, interval);
            };

            checkCondition();
        });
    }

    /**
     * Add custom CSS to the page
     * @param {string} id - Unique ID for the style element
     * @param {string} css - The CSS content
     */
    function addCSS(id, css) {
        // Remove existing style with same ID
        const existing = document.getElementById(id);
        if (existing) {
            existing.remove();
        }

        const style = document.createElement('style');
        style.id = id;
        style.textContent = css;
        document.head.appendChild(style);

        console.log(`🪼 Jellyfin Enhanced: Added CSS: ${id}`);
    }

    /**
     * Remove CSS by ID
     * @param {string} id - The style element ID
     * @returns {boolean} True if removed
     */
    function removeCSS(id) {
        const existing = document.getElementById(id);
        if (existing) {
            existing.remove();
            console.log(`🪼 Jellyfin Enhanced: Removed CSS: ${id}`);
            return true;
        }
        return false;
    }

    // Initialize on load
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize);
    } else {
        initialize();
    }

    // Cleanup on page unload
    window.addEventListener('beforeunload', () => {
        disconnectAllObservers();
    });

    // Expose helpers
    JE.helpers = {
        onViewPage,
        onNavigate,
        getItemCached,
        getCurrentView,
        createObserver,
        onBodyMutation,
        removeBodySubscriber,
        disconnectObserver,
        disconnectAllObservers,
        waitForElement,
        waitForCondition,
        debounce,
        throttle,
        retry,
        isElementVisible,
        addCSS,
        removeCSS,
        getHandlerCount: () => handlers.length,
        getObserverCount: () => activeObservers.size,
        getBodySubscriberCount: () => bodySubscribers.size
    };

    console.log('🪼 Jellyfin Enhanced: Helpers initialized successfully');

})(window.JellyfinEnhanced);
