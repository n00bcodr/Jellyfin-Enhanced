// /js/jellyseerr/seamless-scroll.js
// Seamless infinite scroll utility with prefetch, deduplication, retry, and batched rendering
(function(JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced: Seamless Scroll:';

    // ============================================================================
    // CONFIGURATION
    // ============================================================================
    const CONFIG = {
        // Prefetch when user is within this many pixels of the end
        // ~2 viewport heights provides smooth experience
        prefetchThresholdPx: Math.max(window.innerHeight * 2, 1200),

        // Retry configuration
        retry: {
            maxAttempts: 3,
            baseDelayMs: 1000,
            maxDelayMs: 8000,
            jitterFactor: 0.25
        },

        // Debug/metrics mode (can be enabled via JE.requestManager.metrics.enabled)
        debug: false
    };

    // ============================================================================
    // UTILITY FUNCTIONS
    // ============================================================================

    function debug(...args) {
        if (CONFIG.debug || JE.requestManager?.metrics?.enabled) {
            console.debug(logPrefix, ...args);
        }
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function calculateBackoff(attempt) {
        const { baseDelayMs, maxDelayMs, jitterFactor } = CONFIG.retry;
        const exponentialDelay = baseDelayMs * Math.pow(2, attempt - 1);
        const clampedDelay = Math.min(exponentialDelay, maxDelayMs);
        const jitter = clampedDelay * jitterFactor * (Math.random() * 2 - 1);
        return Math.max(0, Math.round(clampedDelay + jitter));
    }

    // ============================================================================
    // DEDUPLICATION HELPER
    // ============================================================================

    /**
     * Creates a deduplication tracker for managing seen items across pages
     * @returns {object} Deduplication tracker
     */
    function createDeduplicator() {
        const seen = new Set();

        return {
            /**
             * Checks if item has been seen and marks it as seen
             * @param {object} item - Item to check
             * @param {Function} [getKey] - Custom key function
             * @returns {boolean} True if item is new (not a duplicate)
             */
            add(item, getKey = (i) => `${i.mediaType}-${i.id}`) {
                const key = getKey(item);
                if (seen.has(key)) {
                    return false;
                }
                seen.add(key);
                return true;
            },

            /**
             * Filters array to only include new items
             * @param {Array} items - Items to filter
             * @param {Function} [getKey] - Custom key function
             * @returns {Array} Filtered items
             */
            filter(items, getKey = (i) => `${i.mediaType}-${i.id}`) {
                return items.filter(item => this.add(item, getKey));
            },

            /**
             * Clears all seen items
             */
            clear() {
                seen.clear();
            },

            /**
             * Gets count of seen items
             * @returns {number}
             */
            get size() {
                return seen.size;
            }
        };
    }

    // ============================================================================
    // SIMPLE INFINITE SCROLL (backward compatible)
    // ============================================================================

    /**
     * Simplified infinite scroll setup that replaces the old implementation
     * Uses the full controller internally but provides simpler API
     * @param {object} state - State object with activeScrollObserver property
     * @param {string} sectionSelector - CSS selector for the section
     * @param {Function} loadMoreFn - Function to call when more items needed
     * @param {Function} hasMoreCheck - Function that returns whether more pages exist
     * @param {Function} isLoadingCheck - Function that returns whether currently loading
     * @param {object} [options] - Additional options
     */
    function setupInfiniteScroll(state, sectionSelector, loadMoreFn, hasMoreCheck, isLoadingCheck, options = {}) {
        // Clean up previous observer
        if (state.activeScrollObserver) {
            state.activeScrollObserver.disconnect();
            state.activeScrollObserver = null;
        }

        // Also clean up any legacy sentinel
        if (state.scrollController) {
            state.scrollController.destroy();
            state.scrollController = null;
        }

        const section = document.querySelector(sectionSelector);
        if (!section) return;

        // Remove old sentinels
        const oldSentinels = section.querySelectorAll('.jellyseerr-scroll-sentinel, .je-scroll-sentinel');
        oldSentinels.forEach(s => s.remove());

        // Create new sentinel
        const sentinel = document.createElement('div');
        sentinel.className = 'je-scroll-sentinel';
        sentinel.style.cssText = 'height:1px;width:100%;pointer-events:none;';
        section.appendChild(sentinel);

        // Track state for retry UI
        let retryCount = 0;
        let retryRow = null;

        const removeRetryRow = () => {
            if (retryRow) {
                retryRow.remove();
                retryRow = null;
            }
        };

        const showRetryRow = () => {
            if (retryRow) return;

            retryRow = document.createElement('div');
            retryRow.className = 'je-retry-row';
            retryRow.style.cssText = `
                display: flex;
                justify-content: center;
                align-items: center;
                padding: 1.5em;
                width: 100%;
                box-sizing: border-box;
            `;

            const retryButton = document.createElement('button');
            retryButton.type = 'button';
            retryButton.textContent = '⟳ Tap to retry';
            retryButton.style.cssText = `
                padding: 0.8em 1.5em;
                border-radius: 4px;
                background: rgba(255,255,255,0.1);
                color: rgba(255,255,255,0.8);
                border: 1px solid rgba(255,255,255,0.2);
                cursor: pointer;
                font-size: 1em;
            `;

            retryButton.addEventListener('click', async () => {
                retryCount = 0;
                removeRetryRow();
                await wrappedLoad();
            });

            retryRow.appendChild(retryButton);
            sentinel.parentNode.insertBefore(retryRow, sentinel);
        };

        // Wrap loadMoreFn with retry logic
        const wrappedLoad = async () => {
            if (!hasMoreCheck() || isLoadingCheck()) return;

            removeRetryRow();

            try {
                await loadMoreFn();
                retryCount = 0;
            } catch (error) {
                if (error.name === 'AbortError') return;

                retryCount++;
                if (retryCount >= CONFIG.retry.maxAttempts) {
                    showRetryRow();
                } else {
                    // Auto-retry with backoff
                    const delay = calculateBackoff(retryCount);
                    await sleep(delay);
                    if (hasMoreCheck() && !isLoadingCheck()) {
                        await wrappedLoad();
                    }
                }
            }
        };

        // Create observer with prefetch threshold
        state.activeScrollObserver = new IntersectionObserver(
            (entries) => {
                if (entries[0].isIntersecting && hasMoreCheck() && !isLoadingCheck()) {
                    wrappedLoad();
                }
            },
            { rootMargin: `${CONFIG.prefetchThresholdPx}px` }
        );

        state.activeScrollObserver.observe(sentinel);

        // Scroll event fallback (use JE.helpers.throttle if available, otherwise inline)
        const throttleFn = JE.helpers?.throttle || ((fn, wait) => {
            let lastCall = 0;
            return (...args) => {
                const now = Date.now();
                if (now - lastCall >= wait) {
                    lastCall = now;
                    fn(...args);
                }
            };
        });
        const scrollHandler = throttleFn(() => {
            if (!hasMoreCheck() || isLoadingCheck()) return;

            const rect = sentinel.getBoundingClientRect();
            const distanceFromBottom = rect.top - window.innerHeight;

            if (distanceFromBottom < CONFIG.prefetchThresholdPx) {
                wrappedLoad();
            }
        }, 150);

        // Store for cleanup
        state._scrollHandler = scrollHandler;
        state._sentinel = sentinel;
        state._removeRetryRow = removeRetryRow;

        window.addEventListener('scroll', scrollHandler, { passive: true });
    }

    /**
     * Cleanup infinite scroll
     * @param {object} state - State object
     */
    function cleanupInfiniteScroll(state) {
        if (state.activeScrollObserver) {
            state.activeScrollObserver.disconnect();
            state.activeScrollObserver = null;
        }

        if (state.scrollController) {
            state.scrollController.destroy();
            state.scrollController = null;
        }

        if (state._scrollHandler) {
            window.removeEventListener('scroll', state._scrollHandler);
            state._scrollHandler = null;
        }

        if (state._sentinel) {
            state._sentinel.remove();
            state._sentinel = null;
        }

        if (state._removeRetryRow) {
            state._removeRetryRow();
            state._removeRetryRow = null;
        }
    }

    // ============================================================================
    // EXPOSE API
    // ============================================================================

    JE.seamlessScroll = {
        // Helpers
        createDeduplicator,

        // Simple API (backward compatible)
        setupInfiniteScroll,
        cleanupInfiniteScroll,

        // Configuration (can be modified at runtime)
        CONFIG
    };

})(window.JellyfinEnhanced || (window.JellyfinEnhanced = {}));
