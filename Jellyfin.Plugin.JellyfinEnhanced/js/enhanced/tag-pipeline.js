/**
 * @file Unified tag pipeline for Jellyfin Enhanced
 * Replaces the 5 independent scan/fetch/queue loops in the tag systems with a single
 * pipeline: ONE scan → ONE batch fetch → shared first-episode/series cache → fan out to renderers.
 *
 * Each tag module (genre, language, quality, rating) registers a pure renderer function.
 * The pipeline handles all scanning, fetching, caching, and scheduling.
 */
(function(JE) {
    'use strict';

    // ── Configuration ──────────────────────────────────────────────────

    const MEDIA_TYPES = new Set(['Movie', 'Episode', 'Series', 'Season', 'BoxSet']);
    const FETCH_DEBOUNCE_MS = 150; // Debounce only the batch API call, not the scan
    const logPrefix = '🪼 Jellyfin Enhanced [TagPipeline]:';

    // ── State ──────────────────────────────────────────────────────────

    const renderers = new Map();        // name → { render, isEnabled, needsFirstEpisode, needsParentSeries }
    let processedCards = new WeakSet(); // let, not const — needs reassignment on reinit
    const firstEpisodeCache = new Map(); // seriesId → Promise<item|null>
    const parentSeriesCache = new Map(); // seriesId → Promise<item|null>
    let fetchTimer = null;
    let isProcessing = false;
    let batchGeneration = 0; // Incremented on navigation to cancel stale in-flight batches
    let requestQueue = [];               // { el, itemId, itemType }

    // ── Renderer Registration ──────────────────────────────────────────

    /**
     * Register a tag renderer with the pipeline.
     * @param {string} name - Unique renderer name (e.g., 'genre', 'quality')
     * @param {Object} config
     * @param {Function} config.render - (el, item, extras) => void. Renders the overlay.
     *   `extras` contains: { firstEpisode, parentSeries }
     * @param {Function} config.isEnabled - () => boolean. Checked before rendering.
     * @param {Function} [config.renderFromCache] - (el, itemId) => boolean. Try to render from
     *   localStorage/hot cache without any API call. Returns true if rendered successfully.
     *   This is called BEFORE any batch fetch to handle revisited pages instantly.
     * @param {boolean} [config.needsFirstEpisode=false] - Whether Series/Season items need first episode data.
     * @param {boolean} [config.needsParentSeries=false] - Whether Season items need parent Series data.
     * @param {Function} [config.injectCss] - Called once on registration to inject styles.
     * @param {Function} [config.cleanup] - Called to clean up old overlays before re-render.
     */
    function registerRenderer(name, config) {
        renderers.set(name, {
            render: config.render,
            renderFromCache: config.renderFromCache || null,
            isEnabled: config.isEnabled,
            needsFirstEpisode: config.needsFirstEpisode || false,
            needsParentSeries: config.needsParentSeries || false,
            injectCss: config.injectCss || null,
            cleanup: config.cleanup || null,
        });
        if (config.injectCss) {
            try { config.injectCss(); } catch (e) {
                console.warn(`${logPrefix} Failed to inject CSS for ${name}:`, e);
            }
        }
        console.log(`${logPrefix} Renderer registered: ${name} (total: ${renderers.size})`);

        // If cards are already on the page (renderer registered after initial scan),
        // clear processed set and rescan so existing cards get this renderer's tags.
        if (processedCards && typeof scheduleScan === 'function') {
            processedCards = new WeakSet();
            scheduleScan();
        }
    }

    // ── Shared Data Fetching ───────────────────────────────────────────

    /**
     * Get the first episode of a series/season (cached, shared across all renderers).
     */
    async function getFirstEpisode(userId, parentId) {
        if (firstEpisodeCache.has(parentId)) return firstEpisodeCache.get(parentId);

        const promise = (async () => {
            try {
                const response = await ApiClient.ajax({
                    type: 'GET',
                    url: ApiClient.getUrl('/Items', {
                        ParentId: parentId,
                        IncludeItemTypes: 'Episode',
                        Recursive: true,
                        SortBy: 'PremiereDate',
                        SortOrder: 'Ascending',
                        Limit: 1,
                        Fields: 'MediaStreams,MediaSources,Genres',
                        userId: userId
                    }),
                    dataType: 'json'
                });
                return response?.Items?.[0] || null;
            } catch {
                return null;
            }
        })();

        firstEpisodeCache.set(parentId, promise);
        return promise;
    }

    /**
     * Get the parent series item (cached, shared across all renderers).
     */
    async function getParentSeries(userId, seriesId) {
        if (parentSeriesCache.has(seriesId)) return parentSeriesCache.get(seriesId);

        const promise = (async () => {
            try {
                return JE.helpers?.getItemCached
                    ? await JE.helpers.getItemCached(seriesId, { userId })
                    : await ApiClient.getItem(userId, seriesId);
            } catch {
                return null;
            }
        })();

        parentSeriesCache.set(seriesId, promise);
        return promise;
    }

    // ── Card Scanning ──────────────────────────────────────────────────

    /**
     * Check whether at least one registered renderer is currently enabled.
     * @returns {boolean} True if any renderer reports enabled.
     */
    function hasAnyEnabledRenderer() {
        for (const [, r] of renderers) {
            if (r.isEnabled()) return true;
        }
        return false;
    }

    let scanScheduled = false;
    const CARDS_PER_CHUNK = 5; // ~2.5ms per card with cache render, 5 cards = ~12ms (under 16ms frame budget)
    let scanGeneration = 0; // Incremented on each new scan to cancel stale chunk chains

    /**
     * Schedule scan. Coalesces multiple mutations into a single scan start.
     */
    // Use requestIdleCallback for all tag work so it never competes with
    // user interactions (hover, scroll, click). Falls back to setTimeout
    // for browsers without requestIdleCallback support.
    const scheduleIdle = typeof requestIdleCallback === 'function'
        ? (fn) => requestIdleCallback(fn, { timeout: 500 })
        : (fn) => setTimeout(fn, 16);

    function scheduleScan() {
        if (scanScheduled) return;
        scanScheduled = true;
        scheduleIdle(() => {
            scanScheduled = false;
            runScan();
        });
    }

    /**
     * Scan all unprocessed cards. Uses chunked processing to avoid jank.
     * Each chunk processes CARDS_PER_CHUNK cards then yields via rAF.
     * A generation counter ensures stale chunk chains from previous scans
     * are cancelled when a new scan starts (e.g., rapid page changes).
     */
    function runScan() {
        if (!hasAnyEnabledRenderer()) return;
        if (typeof ApiClient === 'undefined') return;

        const elements = document.querySelectorAll('.cardImageContainer, div.listItemImage');
        const unprocessed = [];
        for (const el of elements) {
            if (!processedCards.has(el)) unprocessed.push(el);
        }
        if (unprocessed.length === 0) return;

        // Cancel any in-progress chunk chain from a previous scan
        const myGeneration = ++scanGeneration;
        let index = 0;

        function processChunk() {
            // Abort if a newer scan has started
            if (myGeneration !== scanGeneration) return;

            const end = Math.min(index + CARDS_PER_CHUNK, unprocessed.length);

            for (; index < end; index++) {
                const el = unprocessed[index];
                if (processedCards.has(el)) continue;
                // Skip elements no longer in the DOM (page changed)
                if (!document.contains(el)) continue;

                const card = el.closest('.card');
                if (card && card.classList.contains('je-hidden')) continue;
                const listItem = el.closest('.listItem');
                if (listItem && listItem.classList.contains('je-hidden')) continue;

                const itemId = getItemId(el);
                if (!itemId) continue;

                const itemType = getItemType(el);
                if (itemType && !MEDIA_TYPES.has(itemType)) {
                    processedCards.add(el);
                    continue;
                }

                processedCards.add(el);
                // Render into cardScalable but INSERT BEFORE the overlay container
                // so Jellyfin's hover overlay naturally covers tags (DOM order).
                // Don't render into cardImageContainer — it triggers Jellyfin's
                // lazy-load to reset opacity:0, breaking image display.
                const scalable = el.closest('.cardScalable');
                let renderTarget = scalable || el;
                if (scalable) {
                    const overlay = scalable.querySelector('.cardOverlayContainer');
                    if (overlay) {
                        // Create a tag container BEFORE the overlay
                        let tagHost = scalable.querySelector('.je-tag-host');
                        if (!tagHost) {
                            tagHost = document.createElement('div');
                            tagHost.className = 'je-tag-host';
                            scalable.insertBefore(tagHost, overlay);
                        }
                        renderTarget = tagHost;
                    }
                }

                let allCacheHits = true;
                for (const [, renderer] of renderers) {
                    if (!renderer.isEnabled()) continue;
                    if (renderer.renderFromCache) {
                        if (!renderer.renderFromCache(renderTarget, itemId)) allCacheHits = false;
                    } else {
                        allCacheHits = false;
                    }
                }

                if (!allCacheHits) {
                    requestQueue.push({ el, renderTarget, itemId, itemType });
                }
            }

            if (index < unprocessed.length) {
                // More cards to process — yield and continue when browser is idle
                scheduleIdle(processChunk);
            } else {
                // All cards processed — schedule batch fetch for cache misses
                if (requestQueue.length > 0 && !isProcessing) {
                    if (fetchTimer) clearTimeout(fetchTimer);
                    fetchTimer = setTimeout(() => {
                        fetchTimer = null;
                        processQueue();
                    }, FETCH_DEBOUNCE_MS);
                }
            }
        }

        processChunk();
    }

    /**
     * Extract the Jellyfin item ID from a card element.
     * @param {HTMLElement} el - Card image container element.
     * @returns {string|null} The item ID or null if not found.
     */
    function getItemId(el) {
        // From background image URL
        if (el.style?.backgroundImage) {
            const match = el.style.backgroundImage.match(/Items\/([a-f0-9]{32})\//i);
            if (match) return match[1];
        }
        // From parent data-id or data-itemid attribute (normalize to 32-char lowercase hex)
        const parent = el.closest('[data-id]') || el.closest('[data-itemid]');
        const attrId = parent?.getAttribute('data-id') || parent?.getAttribute('data-itemid');
        return attrId ? attrId.replace(/-/g, '').toLowerCase() : null;
    }

    /**
     * Extract the item type from a card element's data-type attribute.
     * @param {HTMLElement} el - Card image container element.
     * @returns {string|null} The item type or null if not found.
     */
    function getItemType(el) {
        const parent = el.closest('[data-type]');
        return parent?.getAttribute('data-type') || null;
    }

    // ── Queue Processing ───────────────────────────────────────────────

    const SERVER_BATCH_LIMIT = 200;

    /**
     * Drain the request queue in SERVER_BATCH_LIMIT-sized chunks.
     * @returns {Promise<void>}
     */
    async function processQueue() {
        if (isProcessing || requestQueue.length === 0) return;
        isProcessing = true;

        try {
            const myGeneration = batchGeneration;

            // Chunk into batches of SERVER_BATCH_LIMIT to avoid 400 errors
            while (requestQueue.length > 0) {
                if (myGeneration !== batchGeneration) break; // navigation happened
                const batch = requestQueue.splice(0, SERVER_BATCH_LIMIT);
                await processBatch(batch, myGeneration);
            }
        } finally {
            isProcessing = false;
        }
    }

    /**
     * Fetch item data for a batch of cards and fan out to all enabled renderers.
     * @param {Array<{el: HTMLElement, renderTarget: HTMLElement, itemId: string, itemType: string}>} batch - Queued card entries.
     * @param {number} generation - Batch generation counter to detect stale navigations.
     * @returns {Promise<void>}
     */
    async function processBatch(batch, generation) {
        const userId = ApiClient.getCurrentUserId();
        if (!userId) return;

        // Use arrays per ID to handle duplicate items (same movie in multiple rows)
        const elMap = new Map();
        for (const b of batch) {
            if (!elMap.has(b.itemId)) elMap.set(b.itemId, []);
            elMap.get(b.itemId).push(b);
        }
        const ids = [...elMap.keys()];

        try {
            // Single API call for ALL cache-miss items via POST (no URL length limit)
            const response = await ApiClient.ajax({
                type: 'POST',
                url: ApiClient.getUrl(`/JellyfinEnhanced/tag-data/${userId}`),
                data: JSON.stringify(ids),
                contentType: 'application/json',
                dataType: 'json'
            });

            const items = response?.Items || [];

            // Abort if navigation happened while we were waiting for the API response
            if (generation !== batchGeneration) return;

            // Build parent series lookup for rating fallback
            const parentSeriesNeeded = new Set();
            for (const item of items) {
                if ((item.Type === 'Season' || item.Type === 'Episode') && item.SeriesId &&
                    !item.CommunityRating && !item.CriticRating) {
                    parentSeriesNeeded.add(item.SeriesId);
                }
                // Genre also needs parent series for Season items
                if (item.Type === 'Season' && item.SeriesId) {
                    parentSeriesNeeded.add(item.SeriesId);
                }
            }

            // Batch-fetch any parent series items we need (these are likely already in the same response)
            const parentSeriesMap = new Map();
            for (const item of items) {
                parentSeriesMap.set(item.Id.toString().replace(/-/g, '').toLowerCase(), item);
            }
            // For parent series not in this batch, fetch individually
            for (const seriesId of parentSeriesNeeded) {
                const normalizedId = seriesId.toString().replace(/-/g, '').toLowerCase();
                if (!parentSeriesMap.has(normalizedId)) {
                    try {
                        const parent = await getParentSeries(userId, seriesId);
                        if (parent) parentSeriesMap.set(normalizedId, parent);
                    } catch {}
                }
            }

            // Render each item as soon as its data is ready.
            // Items that DON'T need first-episode data (Movies, Episodes) render immediately.
            // Items that DO (Series, Season) render after their first-episode fetch completes.
            // This way a slow first-episode lookup doesn't block everything else.

            const renderItem = (item, firstEpisode) => {
                const itemId = item.Id.toString().replace(/-/g, '').toLowerCase();
                const batchEntries = elMap.get(itemId);
                if (!batchEntries || batchEntries.length === 0) return;
                if (!MEDIA_TYPES.has(item.Type)) return;

                let parentSeries = null;
                let ratingParentSeries = null;
                if (item.SeriesId) {
                    const parentId = item.SeriesId.toString().replace(/-/g, '').toLowerCase();
                    parentSeries = parentSeriesMap.get(parentId) || null;
                    if ((item.Type === 'Season' || item.Type === 'Episode') &&
                        !item.CommunityRating && !item.CriticRating) {
                        ratingParentSeries = parentSeries;
                    }
                }

                // Render to ALL cards with this ID (same item can appear in multiple rows)
                for (const entry of batchEntries) {
                    const { renderTarget } = entry;
                    const extras = { firstEpisode, parentSeries, ratingParentSeries, renderTarget };
                    for (const [name, renderer] of renderers) {
                        if (!renderer.isEnabled()) continue;
                        try {
                            renderer.render(renderTarget, item, extras);
                        } catch (err) {
                            console.warn(`${logPrefix} Renderer "${name}" failed for item ${itemId}:`, err);
                        }
                    }
                }
            };

            // Check if ANY enabled renderer actually needs first-episode data
            let anyNeedsFirstEp = false;
            for (const [, r] of renderers) {
                if (r.isEnabled() && r.needsFirstEpisode) { anyNeedsFirstEp = true; break; }
            }

            // Process all items: render immediately what we can, fetch first episodes in parallel
            const pendingFirstEps = [];
            for (const item of items) {
                if (anyNeedsFirstEp && item.FirstEpisode?.NeedsStreamFetch) {
                    // Series/Season: fetch first episode in background, render when ready
                    pendingFirstEps.push(
                        getFirstEpisode(userId, item.Id)
                            .then(ep => renderItem(item, ep))
                            .catch(() => renderItem(item, null))
                    );
                } else {
                    // Movies, Episodes, etc: render immediately (no extra fetch needed)
                    renderItem(item, item.FirstEpisode || null);
                }
            }

            // Wait for all first-episode renders to complete before marking batch done
            if (pendingFirstEps.length > 0) {
                await Promise.all(pendingFirstEps);
            }
        } catch (err) {
            console.warn(`${logPrefix} Batch fetch failed, falling back to individual fetches:`, err);
            // Fallback: process items individually
            for (const { el, renderTarget, itemId } of batch) {
                try {
                    const item = JE.helpers?.getItemCached
                        ? await JE.helpers.getItemCached(itemId, { userId })
                        : await ApiClient.getItem(userId, itemId);
                    if (!item || !MEDIA_TYPES.has(item.Type)) continue;

                    const firstEpisode = (item.Type === 'Series' || item.Type === 'Season')
                        ? await getFirstEpisode(userId, item.Id) : null;
                    const extras = { firstEpisode, parentSeries: null, ratingParentSeries: null, renderTarget };

                    for (const [name, renderer] of renderers) {
                        if (!renderer.isEnabled()) continue;
                        try { renderer.render(renderTarget, item, extras); } catch {}
                    }
                } catch {}
            }
        }
    }

    // ── Lifecycle ──────────────────────────────────────────────────────

    /**
     * Initialize the tag pipeline: register mutation observer, navigation handler, and inject base CSS.
     * @returns {void}
     */
    function initialize() {
        if (!JE.helpers?.onBodyMutation) {
            console.warn(`${logPrefix} helpers.onBodyMutation not available, retrying...`);
            setTimeout(initialize, 100);
            return;
        }

        // Register as body mutation subscriber at priority 0 (after hidden-content and prefetch).
        // Only trigger scans when nodes were actually added to the DOM — ignore attribute
        // changes, text changes, and hover/focus effects which cause jank if we scan on each.
        JE.helpers.onBodyMutation('tag-pipeline', (mutations) => {
            for (let i = 0; i < mutations.length; i++) {
                if (mutations[i].addedNodes.length > 0) {
                    scheduleScan();
                    return;
                }
            }
        }, { priority: 0 });

        // Also trigger on navigation
        if (JE.helpers.onNavigate) {
            JE.helpers.onNavigate(() => {
                // Invalidate any in-flight batch processing (don't reset isProcessing
                // directly — let stale batches finish naturally and discard results)
                batchGeneration++;
                firstEpisodeCache.clear();
                parentSeriesCache.clear();
                requestQueue = [];
                scheduleScan();
            });
        }

        // Inject CSS containment for all tag overlay containers.
        // This tells the browser these elements are independent from the rest of the
        // card layout, so hover transforms don't trigger re-layout/re-paint of overlays.
        // will-change:transform promotes each container to its own compositor layer.
        if (JE.helpers?.addCSS) {
            // Base CSS: tag host and containment
            JE.helpers.addCSS('je-tag-pipeline-perf', `
                .je-tag-host {
                    position: absolute !important;
                    top: 0; left: 0; right: 0; bottom: 0;
                    pointer-events: none;
                    overflow: visible;
                    z-index: 0;
                }
                .je-tag-host .genre-overlay-container,
                .je-tag-host .quality-overlay-container,
                .je-tag-host .language-overlay-container,
                .je-tag-host .rating-overlay-container {
                    contain: layout style;
                    pointer-events: none;
                    z-index: auto !important;
                }
            `);

            // "Hide Tags on Hover" setting: fully hides the tag layer on hover.
            // Without this, Jellyfin's overlay already covers tags (they're behind it).
            // This setting makes them completely invisible for users who want zero clutter.
            JE.helpers.addCSS('je-tag-hover-fade', `
                body.je-tags-hide-on-hover .card:hover .je-tag-host {
                    opacity: 0 !important;
                    transition: opacity 0.15s ease;
                }
            `);
            // Apply the class based on current setting
            if (JE.currentSettings?.tagsHideOnHover) {
                document.body.classList.add('je-tags-hide-on-hover');
            }
        }

        // Initial scan for cards already on the page
        setTimeout(runScan, 500);

        console.log(`${logPrefix} Initialized`);
    }

    // ── Expose API ─────────────────────────────────────────────────────

    JE.tagPipeline = {
        registerRenderer,
        initialize,
        getFirstEpisode,
        getParentSeries,
        /** @param {string} name - Renderer name (e.g. 'quality'). */
        getRenderer(name) { return renderers.get(name); },
        // For reinitialize support
        clearProcessed() {
            processedCards = new WeakSet(); // Create fresh WeakSet so all cards get re-scanned
            requestQueue = [];
            batchGeneration++;
            firstEpisodeCache.clear();
            parentSeriesCache.clear();
        },
        scheduleScan,
    };

    console.log(`${logPrefix} Module loaded`);

})(window.JellyfinEnhanced);
