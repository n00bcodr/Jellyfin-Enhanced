// /js/jellyseerr/seamless-scroll.js
// Seamless infinite scroll utility: buffer-fill loading, deduplication,
// retry with backoff and batched rendering.
//
// Model: instead of "load one page when the sentinel scrolls into view", the
// engine keeps a *buffer* of already-rendered content ahead of the viewer
// (CONFIG.bufferViewports viewport heights, or CONFIG.bufferRowWidths row
// widths for horizontal rows). Whenever the buffer is short it calls
// loadMoreFn with a hint describing the deficit, and keeps calling it until
// the buffer is full or the feed is exhausted. A page that renders no cards
// (everything on it was filtered out) therefore never stalls the feed — the
// next page is requested straight away — and consumers use the hint to fetch
// several pages in parallel and prefetch the pages after that, so a load is
// normally served from cache before the viewer gets anywhere near the end.
(function(JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced: Seamless Scroll:';

    // ============================================================================
    // CONFIGURATION
    // ============================================================================
    const CONFIG = {
        // Vertical grids: keep at least this much rendered content below the
        // bottom of the viewport (whichever of the two is larger).
        bufferViewports: 3,
        minBufferPx: 2400,

        // Horizontal rows: keep at least this many visible-row-widths of cards
        // to the right of the visible area once the viewer has interacted with
        // the row (scrolled, wheeled, touched, focused it)...
        bufferRowWidths: 4,
        // ...and only this many before that, so a search result row that is
        // merely displayed (typeahead) costs one page, not five.
        idleRowWidths: 1.5,

        // Horizontal rows scrolled by transforms (emby-scroller) emit no scroll
        // events, so also poll the geometry at this interval while set up.
        horizontalPollMs: 400,

        // Safety valve against hammering Seerr/TMDB: after this many
        // consecutive *pages* that rendered no cards (every item filtered out
        // as hidden / already in the library) the automatic loop pauses and
        // shows a "Keep looking" button. Pages are never skipped — pressing it
        // resumes exactly where the feed left off. 40 pages ≈ 800 items.
        maxConsecutiveEmptyPages: 40,

        // Retry configuration
        retry: {
            maxAttempts: 3,
            baseDelayMs: 1000,
            maxDelayMs: 8000,
            jitterFactor: 0.25
        }
    };

    // ============================================================================
    // UTILITY FUNCTIONS
    // ============================================================================

    /**
     * @param {number} ms
     * @returns {Promise<void>}
     */
    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Exponential backoff with jitter for load retries.
     * @param {number} attempt - 1-based retry number
     * @returns {number} Delay in milliseconds
     */
    function calculateBackoff(attempt) {
        const { baseDelayMs, maxDelayMs, jitterFactor } = CONFIG.retry;
        const exponentialDelay = baseDelayMs * Math.pow(2, attempt - 1);
        const clampedDelay = Math.min(exponentialDelay, maxDelayMs);
        const jitter = clampedDelay * jitterFactor * (Math.random() * 2 - 1);
        return Math.max(0, Math.round(clampedDelay + jitter));
    }

    /**
     * How much rendered content a vertical grid keeps below the viewport.
     * @returns {number} Pixels
     */
    function verticalBufferPx() {
        return Math.max(window.innerHeight * CONFIG.bufferViewports, CONFIG.minBufferPx);
    }

    /**
     * Estimates how many cards are needed to fill a pixel deficit, from the
     * geometry of the cards already in the container.
     * @param {HTMLElement|null} container - Element holding the .card elements
     * @param {{deficitPx: number, horizontal?: boolean}|null|undefined} hint - Hint passed to loadMoreFn
     * @param {number} [fallback=40]
     * @returns {number}
     */
    function cardsNeeded(container, hint, fallback = 40) {
        if (!container || !hint || !(hint.deficitPx > 0)) return fallback;
        // Never plan a batch smaller than ~one screen of cards: right after the
        // first render the deficit is tiny, and a one-page batch loses the race
        // against a fast reader.
        const targetPx = Math.max(hint.deficitPx, (hint.spanPx || 0) * 0.75);
        const cards = container.querySelectorAll('.card');
        let first = null;
        for (let i = 0; i < cards.length && i < 60; i++) {
            // Skip cards hidden by the CSS media-type filter.
            if (cards[i].offsetParent !== null) { first = cards[i]; break; }
        }
        if (!first) return fallback;
        const rect = first.getBoundingClientRect();
        if (hint.horizontal) {
            const width = rect.width || 150;
            return Math.ceil(targetPx / width) + 2;
        }
        const rowHeight = rect.height || 250;
        let perRow = 1;
        for (let i = 1; i < cards.length && i < 80 && perRow < 40; i++) {
            const card = cards[i];
            if (card.offsetParent === null) continue;
            if (Math.abs(card.getBoundingClientRect().top - rect.top) < 2) perRow++;
            else break;
        }
        return Math.ceil(targetPx / rowHeight) * perRow + perRow;
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
                const initialCount = items.length;
                const filtered = items.filter(item => this.add(item, getKey));
                const duplicateCount = initialCount - filtered.length;
                if (duplicateCount > 0) {
                    console.debug(`${logPrefix} Filtered out ${duplicateCount} duplicate(s) from ${initialCount} items`);
                }
                return filtered;
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
    // INFINITE SCROLL
    // ============================================================================

    /**
     * Buffer-fill infinite scroll with parallel-load hints, retry and deduplication.
     * @param {object} state - State object with activeScrollObserver property
     * @param {string} sectionSelector - CSS selector for the section
     * @param {Function} loadMoreFn - Called with a hint {deficitPx, aheadPx, spanPx, horizontal, engaged, pageBudget}
     *   whenever more content is needed. Should append content and resolve when done;
     *   may resolve to {pages, rendered} (pages fetched / cards appended) so the
     *   empty-page budget is exact, otherwise content growth is used.
     * @param {Function} hasMoreCheck - Function that returns whether more pages exist
     * @param {Function} isLoadingCheck - Function that returns whether currently loading
     * @param {object} [options] - Additional options
     * @param {boolean} [options.horizontal=false] - The content is a horizontal row.
     * @param {string} [options.trackSelector='.itemsContainer'] - horizontal: element holding the cards.
     * @param {string} [options.scrollerSelector='.emby-scroller'] - horizontal: the visible scroll window.
     */
    function setupInfiniteScroll(state, sectionSelector, loadMoreFn, hasMoreCheck, isLoadingCheck, options = {}) {
        console.debug(`${logPrefix} Setting up infinite scroll for ${sectionSelector}`);

        // Clean up everything from a previous call on this state object (observer,
        // scroll listener, sentinel, retry row) before creating new ones, or the old
        // scroll listener leaks — it stays on window forever, holding a closure over
        // a stale query and a detached sentinel.
        cleanupInfiniteScroll(state);

        const section = document.querySelector(sectionSelector);
        if (!section) return;

        const horizontal = options.horizontal === true;
        const trackSelector = options.trackSelector || '.itemsContainer';
        const scrollerSelector = options.scrollerSelector || '.emby-scroller';

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
        let destroyed = false;
        let filling = false;
        let emptyPages = 0;   // consecutive fetched pages that rendered nothing
        let paused = false;   // after max retries / empty-page budget: wait for the button
        let engaged = !horizontal; // horizontal rows start in the idle (small buffer) state

        const removeRetryRow = () => {
            if (retryRow) {
                retryRow.remove();
                retryRow = null;
            }
        };

        /**
         * Shows an action row (retry after failures, or "keep looking" once the
         * empty-page budget is spent). In a horizontal row it sits inline at the
         * end of the track so it is where the viewer is looking.
         * @param {string} label
         */
        const showRetryRow = (label = '⟳ Tap to retry') => {
            if (retryRow) return;

            retryRow = document.createElement('div');
            retryRow.className = 'je-retry-row';
            retryRow.style.cssText = horizontal ? `
                display: inline-flex;
                justify-content: center;
                align-items: center;
                vertical-align: middle;
                padding: 1em 1.5em;
                box-sizing: border-box;
            ` : `
                display: flex;
                justify-content: center;
                align-items: center;
                padding: 1.5em;
                width: 100%;
                box-sizing: border-box;
            `;

            const retryButton = document.createElement('button');
            retryButton.type = 'button';
            retryButton.textContent = label;
            retryButton.style.cssText = `
                padding: 0.8em 1.5em;
                border-radius: 4px;
                background: rgba(255,255,255,0.1);
                color: rgba(255,255,255,0.8);
                border: 1px solid rgba(255,255,255,0.2);
                cursor: pointer;
                font-size: 1em;
            `;

            retryButton.addEventListener('click', () => {
                retryCount = 0;
                emptyPages = 0;
                paused = false;
                engaged = true;
                removeRetryRow();
                fill();
            });

            retryRow.appendChild(retryButton);
            const track = horizontal ? section.querySelector(trackSelector) : null;
            if (track) track.appendChild(retryRow);
            else sentinel.parentNode.insertBefore(retryRow, sentinel);
        };

        /**
         * Measures how much rendered content is still ahead of the viewer.
         * @returns {{ahead: number, target: number, span: number, inRange: boolean}}
         */
        // A section that is detached or display:none measures as all zeros, which
        // would read as "infinitely short" and start a fill storm into a page
        // nobody can see (e.g. Back pressed before page 1 landed). Not in range.
        const isDisplayed = () => section.isConnected && section.getClientRects().length > 0;

        const measure = () => {
            if (!isDisplayed()) {
                return { ahead: 0, target: 0, span: 0, inRange: false };
            }
            if (horizontal) {
                const track = section.querySelector(trackSelector);
                const scroller = section.querySelector(scrollerSelector) || section;
                const sectionRect = section.getBoundingClientRect();
                const vBuffer = verticalBufferPx();
                // Only fill a row that is on (or near) the screen vertically.
                const inRange = sectionRect.bottom > -vBuffer && sectionRect.top < window.innerHeight + vBuffer;
                if (!track) return { ahead: 0, target: 0, span: 0, inRange };
                // The track box does not grow with its overflowing cards, so
                // measure the real end of the content: the last card's right edge.
                const cards = track.querySelectorAll('.card');
                const last = cards.length ? cards[cards.length - 1] : track;
                const endRight = last.getBoundingClientRect().right;
                const scrollerRect = scroller.getBoundingClientRect();
                const visibleRight = Math.min(scrollerRect.right, window.innerWidth);
                const span = Math.max(scrollerRect.width || window.innerWidth, 400);
                const widths = engaged ? CONFIG.bufferRowWidths : CONFIG.idleRowWidths;
                return { ahead: endRight - visibleRight, target: span * widths, span, inRange };
            }
            const rect = sentinel.getBoundingClientRect();
            const target = verticalBufferPx();
            return { ahead: rect.top - window.innerHeight, target, span: window.innerHeight, inRange: rect.top - window.innerHeight < target };
        };

        // Document-space position of the end of the content: comparing it before
        // and after a load tells whether the load actually added anything.
        const contentEnd = () => {
            if (horizontal) {
                const track = section.querySelector(trackSelector);
                const cards = track ? track.querySelectorAll('.card') : [];
                if (!cards.length) return 0;
                return cards[cards.length - 1].getBoundingClientRect().right - track.getBoundingClientRect().left;
            }
            return sentinel.getBoundingClientRect().top + window.scrollY;
        };

        // Wrap loadMoreFn with retry logic. Resolves true when the load succeeded.
        const wrappedLoad = async (hint) => {
            if (!hasMoreCheck() || isLoadingCheck()) return false;

            removeRetryRow();
            console.debug(`${logPrefix} Loading more items (attempt ${retryCount + 1}, deficit ${Math.round(hint.deficitPx)}px)`);

            try {
                const result = await loadMoreFn(hint);
                retryCount = 0;
                return result && typeof result === 'object' ? result : true;
            } catch (error) {
                if (error.name === 'AbortError') return false;

                retryCount++;
                console.warn(`${logPrefix} Load failed (attempt ${retryCount}/${CONFIG.retry.maxAttempts}):`, error.message);

                if (retryCount >= CONFIG.retry.maxAttempts) {
                    console.warn(`${logPrefix} Max retry attempts reached, showing retry UI`);
                    paused = true;
                    showRetryRow();
                    return false;
                }

                // Auto-retry with backoff
                const delay = calculateBackoff(retryCount);
                console.debug(`${logPrefix} Retrying in ${delay}ms...`);
                await sleep(delay);
                if (destroyed || !sentinel.isConnected) return false;
                return wrappedLoad(hint);
            }
        };

        /**
         * Keeps loading until the content buffer ahead of the viewer is full,
         * the feed is exhausted, or a load fails permanently.
         */
        const fill = async () => {
            if (filling || destroyed || paused) return;
            filling = true;
            try {
                while (!destroyed && !paused && sentinel.isConnected && hasMoreCheck() && !isLoadingCheck()) {
                    const g = measure();
                    if (!g.inRange) break;
                    const deficit = g.target - g.ahead;
                    if (deficit <= 0) break;
                    if (emptyPages >= CONFIG.maxConsecutiveEmptyPages) {
                        console.debug(`${logPrefix} ${emptyPages} consecutive pages rendered nothing; pausing until "Keep looking" is pressed`);
                        paused = true;
                        showRetryRow('⟳ Keep looking');
                        break;
                    }

                    const before = contentEnd();
                    // pageBudget: how many more pages may be fetched before the
                    // empty-page valve trips; consumers clamp batch + prefetch to it.
                    const pageBudget = CONFIG.maxConsecutiveEmptyPages - emptyPages;
                    const result = await wrappedLoad({ deficitPx: deficit, aheadPx: g.ahead, spanPx: g.span, horizontal, engaged, pageBudget });
                    if (!result) break;
                    if (typeof result === 'object' && typeof result.pages === 'number') {
                        // A load that fetched nothing and rendered nothing made no
                        // progress (a consumer's guard return): stop rather than spin.
                        if (result.pages === 0 && !(result.rendered > 0)) break;
                        emptyPages = result.rendered > 0 ? 0 : emptyPages + result.pages;
                    } else {
                        const after = contentEnd();
                        emptyPages = after > before + 1 ? 0 : emptyPages + 1;
                    }
                }
            } finally {
                filling = false;
            }
        };

        // Observer: wakes the fill loop when the sentinel (or, for rows, the
        // section) comes within the buffer distance of the viewport.
        state.activeScrollObserver = new IntersectionObserver(
            (entries) => {
                if (entries.some(e => e.isIntersecting)) fill();
            },
            { rootMargin: `${Math.round(verticalBufferPx())}px` }
        );
        state.activeScrollObserver.observe(horizontal ? section : sentinel);

        // Scroll / resize / row-scroll fallbacks (use JE.helpers.throttle if available, otherwise inline)
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
        const onUserScroll = throttleFn(() => {
            if (!sentinel.isConnected) {
                // Sentinel was removed from the DOM (e.g. user navigated away) without
                // cleanupInfiniteScroll being called. Self-heal so this listener doesn't
                // keep firing requests forever from other pages.
                teardown();
                return;
            }
            fill();
        }, 100);
        // Interaction with a horizontal row switches it from the idle buffer to
        // the full read-ahead buffer.
        const onEngage = () => {
            if (!engaged) { engaged = true; fill(); }
        };

        const listeners = [];
        const listen = (target, type, handler, opts) => {
            target.addEventListener(type, handler, opts);
            listeners.push(() => target.removeEventListener(type, handler, opts));
        };
        listen(window, 'scroll', onUserScroll, { passive: true });
        listen(window, 'resize', onUserScroll, { passive: true });
        let pollTimer = null;
        if (horizontal) {
            // emby-scroller scrolls an inner element (native) or translates the
            // track (transform); catch both plus the input that drives them.
            listen(section, 'scroll', onUserScroll, { passive: true, capture: true });
            listen(section, 'wheel', onUserScroll, { passive: true });
            listen(section, 'touchmove', onUserScroll, { passive: true });
            listen(section, 'keydown', onUserScroll, { passive: true });
            listen(section, 'focusin', onUserScroll, { passive: true });
            ['scroll', 'wheel', 'touchstart', 'keydown', 'focusin', 'pointerdown'].forEach(type =>
                listen(section, type, onEngage, { passive: true, capture: true }));
            pollTimer = setInterval(() => {
                if (!sentinel.isConnected) { teardown(); return; }
                fill();
            }, CONFIG.horizontalPollMs);
        }

        const teardown = () => {
            destroyed = true;
            listeners.splice(0).forEach(off => off());
            if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
            if (state.activeScrollObserver) {
                state.activeScrollObserver.disconnect();
                state.activeScrollObserver = null;
            }
            // A self-healed (sentinel gone) engine must not leave a dead fill()
            // behind for callers to poke; only clear it if it is still ours.
            if (state.fill === fill) state.fill = null;
        };

        // Store for cleanup
        state._teardown = teardown;
        state._sentinel = sentinel;
        state._removeRetryRow = removeRetryRow;
        state.fill = fill;

        // Fill the buffer straight away — the first page rarely covers three viewports.
        fill();
    }

    /**
     * Cleanup infinite scroll
     * @param {object} state - State object
     */
    function cleanupInfiniteScroll(state) {
        if (state._teardown) {
            state._teardown();
            state._teardown = null;
        }

        if (state.activeScrollObserver) {
            state.activeScrollObserver.disconnect();
            state.activeScrollObserver = null;
        }

        if (state._sentinel) {
            state._sentinel.remove();
            state._sentinel = null;
        }

        if (state._removeRetryRow) {
            state._removeRetryRow();
            state._removeRetryRow = null;
        }

        state.fill = null;
    }

    // ============================================================================
    // EXPOSE API
    // ============================================================================

    JE.seamlessScroll = {
        // Helpers
        createDeduplicator,
        cardsNeeded,

        // Simple API (backward compatible)
        setupInfiniteScroll,
        cleanupInfiniteScroll,

        // Configuration (can be modified at runtime)
        CONFIG
    };

})(window.JellyfinEnhanced || (window.JellyfinEnhanced = {}));
