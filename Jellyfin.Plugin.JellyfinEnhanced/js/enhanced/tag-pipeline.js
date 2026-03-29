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
    const SCAN_DEBOUNCE_MS = 250;
    const BATCH_SIZE = 40;
    const QUEUE_PROCESS_INTERVAL = 50;
    const logPrefix = '🪼 Jellyfin Enhanced [TagPipeline]:';

    // ── State ──────────────────────────────────────────────────────────

    const renderers = new Map();        // name → { render, isEnabled, needsFirstEpisode, needsParentSeries }
    const processedCards = new WeakSet();
    const firstEpisodeCache = new Map(); // seriesId → Promise<item|null>
    const parentSeriesCache = new Map(); // seriesId → Promise<item|null>
    let scanTimer = null;
    let isProcessing = false;
    let requestQueue = [];               // { el, itemId, itemType }

    // ── Renderer Registration ──────────────────────────────────────────

    /**
     * Register a tag renderer with the pipeline.
     * @param {string} name - Unique renderer name (e.g., 'genre', 'quality')
     * @param {Object} config
     * @param {Function} config.render - (el, item, extras) => void. Renders the overlay.
     *   `extras` contains: { firstEpisode, parentSeries }
     * @param {Function} config.isEnabled - () => boolean. Checked before rendering.
     * @param {boolean} [config.needsFirstEpisode=false] - Whether Series/Season items need first episode data.
     * @param {boolean} [config.needsParentSeries=false] - Whether Season items need parent Series data.
     * @param {Function} [config.injectCss] - Called once on registration to inject styles.
     * @param {Function} [config.cleanup] - Called to clean up old overlays before re-render.
     */
    function registerRenderer(name, config) {
        renderers.set(name, {
            render: config.render,
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

    function hasAnyEnabledRenderer() {
        for (const [, r] of renderers) {
            if (r.isEnabled()) return true;
        }
        return false;
    }

    function scheduleScan() {
        if (scanTimer) clearTimeout(scanTimer);
        scanTimer = setTimeout(scanCards, SCAN_DEBOUNCE_MS);
    }

    function scanCards() {
        if (!hasAnyEnabledRenderer()) return;
        if (typeof ApiClient === 'undefined') return;

        // Single querySelectorAll for all tag systems
        const elements = document.querySelectorAll('.cardImageContainer, div.listItemImage');

        for (const el of elements) {
            if (processedCards.has(el)) continue;

            // Skip hidden cards
            const card = el.closest('.card');
            if (card && card.classList.contains('je-hidden')) continue;
            const listItem = el.closest('.listItem');
            if (listItem && listItem.classList.contains('je-hidden')) continue;

            // Get item ID
            const itemId = getItemId(el);
            if (!itemId) continue;

            // Get item type
            const itemType = getItemType(el);
            if (itemType && !MEDIA_TYPES.has(itemType)) {
                processedCards.add(el);
                continue;
            }

            processedCards.add(el);

            // cardImageContainer can have opacity:0 during lazy-load, making child
            // overlays invisible. Use cardScalable (always visible, position:relative)
            // as the render target instead.
            const renderTarget = el.closest('.cardScalable') || el;

            requestQueue.push({ el, renderTarget, itemId, itemType });
        }

        if (requestQueue.length > 0 && !isProcessing) {
            processQueue();
        }
    }

    function getItemId(el) {
        // From background image URL
        if (el.style?.backgroundImage) {
            const match = el.style.backgroundImage.match(/Items\/([a-f0-9]{32})\//i);
            if (match) return match[1];
        }
        // From parent data-id attribute
        const parent = el.closest('[data-id]');
        return parent?.getAttribute('data-id') || null;
    }

    function getItemType(el) {
        const parent = el.closest('[data-type]');
        return parent?.getAttribute('data-type') || null;
    }

    // ── Queue Processing ───────────────────────────────────────────────

    async function processQueue() {
        if (isProcessing || requestQueue.length === 0) return;
        isProcessing = true;

        while (requestQueue.length > 0) {
            const batch = requestQueue.splice(0, BATCH_SIZE);
            await processBatch(batch);
        }

        isProcessing = false;
    }

    async function processBatch(batch) {
        const userId = ApiClient.getCurrentUserId();
        if (!userId) return;

        const ids = batch.map(b => b.itemId);
        const elMap = new Map();
        for (const b of batch) elMap.set(b.itemId, b);

        try {
            // Single batch API call — returns items + first episode data for Series/Season
            const response = await ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl(`/JellyfinEnhanced/tag-data/${userId}`, {
                    ids: ids.join(',')
                }),
                dataType: 'json'
            });

            const items = response?.Items || [];

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

            // Process each item
            for (const item of items) {
                const itemId = item.Id.toString().replace(/-/g, '').toLowerCase();
                const batchEntry = elMap.get(itemId);
                if (!batchEntry) continue;

                const { renderTarget } = batchEntry;
                if (!MEDIA_TYPES.has(item.Type)) continue;

                // Build extras from the batch response
                const firstEpisode = item.FirstEpisode || null;
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

                const extras = { firstEpisode, parentSeries, ratingParentSeries, renderTarget };

                // Fan out to all enabled renderers
                for (const [name, renderer] of renderers) {
                    if (!renderer.isEnabled()) continue;
                    try {
                        renderer.render(renderTarget, item, extras);
                    } catch (err) {
                        console.warn(`${logPrefix} Renderer "${name}" failed for item ${itemId}:`, err);
                    }
                }
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

    function initialize() {
        if (!JE.helpers?.onBodyMutation) {
            console.warn(`${logPrefix} helpers.onBodyMutation not available, retrying...`);
            setTimeout(initialize, 100);
            return;
        }

        // Register as body mutation subscriber at priority 0 (after hidden-content and prefetch)
        JE.helpers.onBodyMutation('tag-pipeline', scheduleScan, { priority: 0 });

        // Also trigger on navigation
        if (JE.helpers.onNavigate) {
            JE.helpers.onNavigate(() => {
                // Clear caches on navigation
                firstEpisodeCache.clear();
                parentSeriesCache.clear();
                requestQueue = [];
                isProcessing = false;
                scheduleScan();
            });
        }

        // Initial scan for cards already on the page
        setTimeout(scanCards, 500);

        console.log(`${logPrefix} Initialized`);
    }

    // ── Expose API ─────────────────────────────────────────────────────

    JE.tagPipeline = {
        registerRenderer,
        initialize,
        getFirstEpisode,
        getParentSeries,
        // For reinitialize support
        clearProcessed() {
            // WeakSet can't be cleared, create fresh reference
            // Modules needing reinit should call scheduleScan after this
            requestQueue = [];
            isProcessing = false;
            firstEpisodeCache.clear();
            parentSeriesCache.clear();
        },
        scheduleScan,
    };

    console.log(`${logPrefix} Module loaded`);

})(window.JellyfinEnhanced);
