/**
 * @file Centralized helper utilities for Jellyfin Enhanced
 * Provides standardized functionality for hooking into page views and managing MutationObservers
 */
(function(JE) {
    'use strict';

    console.log('🪼 Jellyfin Enhanced: Initializing helpers module');

    // Store the original onViewShow function
    let originalOnViewShow = null;

    // Array to store registered handlers
    const handlers = [];

    // Active observers registry for lifecycle management
    const activeObservers = new Map();

    // Cache for current view information
    let cachedItem = null;
    let cachedItemId = null;
    let fetchInProgress = null;

    /**
     * Initialize the utils by hooking into Emby.Page.onViewShow
     */
    function initialize() {
        if (!window.Emby?.Page) {
            console.warn('🪼 Jellyfin Enhanced: Emby.Page not available, retrying in 100ms');
            setTimeout(initialize, 100);
            return;
        }

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

            // Return cached item if same ID
            if (cachedItemId === itemId && cachedItem) {
                return cachedItem;
            }

            // If fetch is in progress for this item, reuse it
            if (fetchInProgress && cachedItemId === itemId) {
                return fetchInProgress;
            }

            const userId = ApiClient.getCurrentUserId();
            cachedItemId = itemId;
            
            fetchInProgress = ApiClient.getItem(userId, itemId);
            const item = await fetchInProgress;
            
            cachedItem = item;
            fetchInProgress = null;
            
            return item;
        } catch (err) {
            console.error('🪼 Jellyfin Enhanced: Error fetching item:', err);
            cachedItem = null;
            fetchInProgress = null;
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
     * Create a managed MutationObserver that can be properly cleaned up
     * @param {string} id - Unique identifier for this observer
     * @param {Function} callback - The mutation callback
     * @param {HTMLElement} target - The element to observe
     * @param {MutationObserverInit} config - The observer configuration
     * @returns {MutationObserver}
     */
    function createObserver(id, callback, target, config) {
        // Disconnect existing observer with same ID
        if (activeObservers.has(id)) {
            const existing = activeObservers.get(id);
            existing.disconnect();
            console.warn(`🪼 Jellyfin Enhanced: Replacing existing observer: ${id}`);
        }

        const observer = new MutationObserver(callback);
        observer.observe(target, config);

        activeObservers.set(id, observer);
        console.log(`🪼 Jellyfin Enhanced: Created observer: ${id} (total: ${activeObservers.size})`);

        return observer;
    }

    /**
     * Disconnect and remove a managed observer
     * @param {string} id - The observer ID
     * @returns {boolean} True if observer was found and disconnected
     */
    function disconnectObserver(id) {
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
     * Disconnect all managed observers
     */
    function disconnectAllObservers() {
        activeObservers.forEach((observer, id) => {
            observer.disconnect();
            console.log(`🪼 Jellyfin Enhanced: Disconnected observer: ${id}`);
        });
        activeObservers.clear();
        console.log('🪼 Jellyfin Enhanced: All observers disconnected');
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

            const observer = new MutationObserver((mutations) => {
                const element = document.querySelector(selector);
                if (element) {
                    if (timeoutId) clearTimeout(timeoutId);
                    disconnectObserver(observerId);
                    resolve(element);
                }
            });

            activeObservers.set(observerId, observer);
            observer.observe(document.body, {
                childList: true,
                subtree: true
            });

            // Set timeout
            timeoutId = setTimeout(() => {
                disconnectObserver(observerId);
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
        getCurrentView,
        createObserver,
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
        getObserverCount: () => activeObservers.size
    };

    console.log('🪼 Jellyfin Enhanced: Helpers initialized successfully');
    console.log('🪼 Jellyfin Enhanced: Available at JellyfinEnhanced.helpers');

})(window.JellyfinEnhanced);
