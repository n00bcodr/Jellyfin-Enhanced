import { apiClient, hasApiClient, type TagApiClient, type TagRuntimeBridge, type UrlParams } from '../host';
import type { PipelineApi } from './contract';
import { createDeltaSync } from './delta-sync';
import type { JsonRecord } from './dto';
import { createItemFacts } from './item-facts';
import { createLookFacts } from './look-facts';
import { createQueue } from './queue';
import { createRenderers } from './renderers';
import { createScan } from './scan';
import { createSeriesLookup } from './series-lookup';
import { createServerCache } from './server-cache';
import { createPipelineState, logPrefix, type PipelineFns } from './state';

// The pipeline modules reach the feature host (../host.ts) only through this file: they import these types from
// here and get apiClient/hasApiClient through `deps` (feature-boundaries rule 1).
export type { TagApiClient, TagRuntimeBridge, UrlParams };

/**
 * @file Unified tag pipeline for Jellyfin Enhanced
 * Replaces the 5 independent scan/fetch/queue loops in the tag systems with a single
 * pipeline: ONE scan → ONE batch fetch → shared first-episode/series cache → fan out to renderers.
 *
 * Each tag module (genre, language, quality, rating) registers a pure renderer function.
 * The pipeline handles all scanning, fetching, caching, and scheduling.
 *
 * The pipeline is split by concern (frontend.md §1b): state.ts holds the shared mutable state and
 * constants; item-facts, renderers, series-lookup, server-cache, delta-sync, look-facts, scan and queue are
 * `create*(s, JE, deps)` factories over that state. A call into another module goes through `deps`, which
 * createTagPipeline fills before any of them runs, so the modules never import each other.
 * @param JE - The tag runtime bridge.
 */
export function createTagPipeline(JE: TagRuntimeBridge) {
    const s = createPipelineState(JE);
    const deps = {} as PipelineFns;
    Object.assign(deps,
        { apiClient, hasApiClient },
        createItemFacts(s, JE, deps),
        createRenderers(s, JE, deps),
        createSeriesLookup(s, JE, deps),
        createServerCache(s, JE, deps),
        createDeltaSync(s, JE, deps),
        createLookFacts(s, JE, deps),
        createScan(s, JE, deps),
        createQueue(s, JE, deps),
    );

    // ── Lifecycle ──────────────────────────────────────────────────────

    /**
     * Initialize the tag pipeline: register mutation observer, navigation handler, and inject base CSS.
     * */
    function initialize(): void {
        if (!JE.helpers?.onBodyMutation) {
            console.warn(`${logPrefix} helpers.onBodyMutation not available, retrying...`);
            setTimeout(initialize, 100);
            return;
        }
        if (s.pipelineStarted) return;
        // No tag type is enabled, so nothing would ever be drawn: don't download
        // the server cache, store it, or refresh it on every navigation. Turning
        // a tag type on later registers its renderer, which starts the pipeline.
        if (!deps.anyTagTypeEnabled()) {
            s.startWhenRendererRegisters = true;
            console.log(`${logPrefix} No tag renderers enabled; idle until one is`);
            return;
        }
        s.startWhenRendererRegisters = false;
        s.pipelineStarted = true;

        // Register as body mutation subscriber at priority 0 (after hidden-content and prefetch).
        // Only trigger scans when nodes were actually added to the DOM — ignore attribute
        // changes, text changes, and hover/focus effects which cause jank if we scan on each.
        JE.helpers.onBodyMutation('tag-pipeline', (mutations) => {
            for (let i = 0; i < mutations.length; i++) {
                if (mutations[i]?.addedNodes.length) {
                    deps.scheduleScan();
                    return;
                }
            }
        }, { priority: 0 });

        // Cards reused in place for another item (see releaseReusedCards):
        // one attribute observer for the page, never one per card.
        const createObserver = JE.core?.dom?.createObserver || JE.helpers?.createObserver;
        if (typeof createObserver === 'function') {
            createObserver('tag-pipeline-card-identity', deps.releaseReusedCards, document.body, {
                subtree: true, attributes: true, attributeFilter: ['data-id', 'data-itemid', 'style'], attributeOldValue: true,
            });
        }

        // Also trigger on navigation
        if (JE.helpers.onNavigate) {
            s.lastNavigationRoute = deps.navigationRoute();
            JE.helpers.onNavigate(() => {
                // jellyfin-web rewrites the URL's `query` parameter on every
                // keystroke in the search box (#/search?query=a → ?query=ab),
                // which the navigation layer reports like any other navigation.
                // Nothing below is needed for that: the page is the same, its
                // new result cards reach the scan through the body observer,
                // and the batch in flight for cards still on screen may as well
                // finish. Anything else (another path, another item id) is a
                // real page change.
                const route = deps.navigationRoute();
                if (route === s.lastNavigationRoute) return;
                s.lastNavigationRoute = route;
                // Invalidate any in-flight batch processing (don't reset isProcessing
                // directly — let stale batches finish naturally and discard results)
                deps.advanceBatchGeneration();
                s.scanGeneration++;
                // Cancelled work is not processed: surviving/re-attached cards
                // must be eligible for the scan scheduled below.
                for (const entry of [...s.requestQueue, ...s.activeBatch]) s.processedCards.delete(entry.el);
                s.firstEpisodeCache.clear();
                s.parentSeriesCache.clear();
                s.requestQueue = [];
                // The discarded queue must not leave a debounce behind. The
                // next scan schedules a fresh fetch for its released cards.
                if (s.fetchTimer) clearTimeout(s.fetchTimer);
                s.fetchTimer = null;
                // Pick up any new items added since last load
                deps.scheduleNavigationRefresh();
                deps.scheduleScan();
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
                .je-tag-host .rating-overlay-container,
                .je-tag-host .age-rating-overlay-container,
                .je-tag-host .status-overlay-container,
                .je-tag-host .logo-overlay-container {
                    contain: layout style;
                    pointer-events: none;
                    z-index: auto !important;
                }
                /* The top-right indicator offset (unwatched count, played check) is a
                   stable slot rule in tags/tag-layout-styles.js. */
            `);

            // Card-width sizing; mobile layout and browsers without container queries keep the per-tag rules.
            const scaleCss = `
                @supports (container-type: inline-size) {
                    .je-tag-host { container-type: inline-size; }
                    html:not(.layout-mobile) .je-tag-host .quality-overlay-container { gap: calc(clamp(1px, 1.8cqw, 4px) * var(--je-tag-scale, 1) * var(--je-tag-gap, 1)); }
                    html:not(.layout-mobile) .je-tag-host :is(.quality-overlay-label, .language-chip) {
                        font-size: calc(clamp(9px, 6.6cqw, 13.6px) * var(--je-tag-scale, 1));
                        padding: calc(clamp(0px, 0.6cqw, 2px) * var(--je-tag-scale, 1)) calc(clamp(4px, 4.2cqw, 10px) * var(--je-tag-scale, 1));
                        border-radius: calc(clamp(2px, 2.4cqw, 5px) * var(--je-tag-scale, 1));
                    }
                    html:not(.layout-mobile) .je-tag-host .language-overlay-container { gap: calc(clamp(1px, 1.8cqw, 3px) * var(--je-tag-scale, 1) * var(--je-tag-gap, 1)); }
                    html:not(.layout-mobile) .je-tag-host .language-flag { width: calc(clamp(16px, 15cqw, 32px) * var(--je-tag-scale, 1)); }
                    html:not(.layout-mobile) .je-tag-host .rating-overlay-container { gap: calc(clamp(2px, 1.8cqw, 3px) * var(--je-tag-scale, 1) * var(--je-tag-gap, 1)); }
                    html:not(.layout-mobile) .je-tag-host .rating-tag {
                        font-size: calc(clamp(9px, 6.8cqw, 13px) * var(--je-tag-scale, 1));
                        padding: calc(clamp(2px, 2cqw, 4px) * var(--je-tag-scale, 1)) calc(clamp(4px, 4.5cqw, 8px) * var(--je-tag-scale, 1));
                        gap: calc(clamp(2px, 2.2cqw, 4px) * var(--je-tag-scale, 1));
                    }
                    html:not(.layout-mobile) .je-tag-host .rating-star-icon { font-size: calc(clamp(9px, 7cqw, 14px) * var(--je-tag-scale, 1)) !important; }
                    html:not(.layout-mobile) .je-tag-host .rating-tomato-icon { width: calc(clamp(9px, 7cqw, 14px) * var(--je-tag-scale, 1)); height: calc(clamp(9px, 7cqw, 14px) * var(--je-tag-scale, 1)); }
                    html:not(.layout-mobile) .je-tag-host .genre-overlay-container { gap: calc(clamp(2px, 1.8cqw, 4px) * var(--je-tag-scale, 1) * var(--je-tag-gap, 1)); }
                    html:not(.layout-mobile) .je-tag-host .genre-tag {
                        width: calc(clamp(18px, 15cqw, 30px) * var(--je-tag-scale, 1));
                        height: calc(clamp(18px, 15cqw, 30px) * var(--je-tag-scale, 1));
                        min-width: calc(clamp(18px, 15cqw, 30px) * var(--je-tag-scale, 1));
                    }
                    html:not(.layout-mobile) .je-tag-host .genre-tag .je-msym-outlined { font-size: calc(clamp(11px, 9.5cqw, 20px) * var(--je-tag-scale, 1)); }
                }
            `;
            JE.helpers.addCSS('je-tag-card-scale', JE.core.tagLayout?.preserveLegacySizing?.(scaleCss) || scaleCss);

            // "Hide Tags on Hover" setting: fully hides the tag layer on hover.
            // Without this, Jellyfin's overlay already covers tags (they're behind it).
            // This setting makes them completely invisible for users who want zero clutter.
            // Summary and minimal reveal their full chips on hover instead, so
            // there it hides every slot but that reveal (tag-layout-styles.js).
            JE.helpers.addCSS('je-tag-hover-fade', `
                body.je-tags-hide-on-hover .card:hover .je-tag-host:not([data-je-layout="summary"]):not([data-je-layout="minimal"]) {
                    opacity: 0 !important;
                    transition: opacity 0.15s ease;
                }
            `);
            // Apply the class based on current setting
            if (JE.currentSettings?.tagsHideOnHover) {
                document.body.classList.add('je-tags-hide-on-hover');
            }
        }

        // Load server cache then do initial scan.
        // Cards may have been processed during the async load (via mutation observer),
        // so clear processedCards after load to rescan with the server cache available.
        deps.loadServerCache().then(() => {
            s.processedCards = new WeakSet();
            deps.runScan();
        });

        console.log(`${logPrefix} Initialized`);
    }


    // ── Expose API ─────────────────────────────────────────────────────

    const api: PipelineApi = {
        registerRenderer: deps.registerRenderer,
        initialize,
        getFirstEpisode: deps.getFirstEpisode,
        getParentSeries: deps.getParentSeries,
        lookupServerEntries: deps.lookupServerEntries,
        rememberItemFacts: deps.rememberItemFacts,
        peekItemFacts: deps.peekItemFacts,
        lookupItemFacts: deps.lookupItemFacts,
        peekSeasonFacts: deps.peekSeasonFacts,
        /**
         * The caller-filtered server tag-cache entry already in memory for an
         * item, without fetching (the status renderer reads parent facts, the
         * tag look lock reads an item's library and genres). The shared entry
         * is read-only; a memory miss is null.
         * @param itemId - Normalised item id.
         * */
        peekServerEntry(itemId: string): JsonRecord|null { return s.serverCache?.get(itemId) || null; },
        /** @param name - Renderer name (e.g. 'quality'). */
        getRenderer(name: string) { return s.renderers.get(name); },
        /** The item data an item's cards are matched on by tag look rules (server entry, remembered, else fetched). */
        itemLookFacts: deps.itemLookFacts,
        /**
         * Every server tag-cache entry in memory (empty without one).
         * */
        serverEntries(): Iterable<JsonRecord> { return s.serverCache ? s.serverCache.values() : []; },
        waitForServerCache: deps.waitForServerCache,
        /** End the running waitForServerCache() (it resolves false). */
        stopWaitingForServerCache() { s.serverCacheWait++; },
        /**
         * Review rating averages that came with the server cache, once the
         * load or refresh in flight has settled: Map<"mediaType:tmdbKey",
         * average>, or null when the server cache (or the poster chips) is
         * off — the user review tags then ask /reviews/ratings themselves.
         * */
        getReviewRatings(): Promise<Map<string, number>|null> {
            return (s.loadInFlight || s.refreshInFlight || Promise.resolve()).then(() => s.reviewRatings);
        },
        /**
         * The review rating averages already at hand, without waiting.
         * */
        peekReviewRatings(): Map<string, number>|null { return s.reviewRatings; },
        /** @returns Bumped each time the review rating averages are replaced. */
        /** @returns performance.now() when the request behind the current review averages started (0 = none). */
        getReviewRatingsRequestedAt(): number { return s.reviewRatingsRequestedAt; },
        /**
         * What Spoiler Guard's Hide tags strips from this user's /tag-data
         * answers: "none" for nothing, another string for a guard set, null
         * while unknown (before the first answer when the bootstrap did not
         * say, and after a user switch or Spoiler Guard change).
         * */
        tagStripRevision(): string|null { return s.tagStripRevision; },
        /**
         * Subscribe to accepted review averages maps.
         * @param listener - Receives the "mediaType:tmdbKey" keys whose value changed (possibly none), or null for all.
         */
        onReviewRatingsChanged(listener: (changed: Set<string>|null) => void) { s.reviewRatingsListeners.add(listener); },
        // For reinitialize support
        clearProcessed() {
            s.processedCards = new WeakSet(); // Create fresh WeakSet so all cards get re-scanned
            s.requestQueue = [];
            deps.advanceBatchGeneration();
            s.scanGeneration++; // a scan chain waiting on the stored copy would render into the old set
            s.firstEpisodeCache.clear();
            s.parentSeriesCache.clear();
        },
        // Bust the server cache so the next scan re-fetches everything through the
        // spoiler-strip pipeline. Used after toggling Spoiler Guard so newly-eligible
        // items lose their cached unstripped tag data.
        /**
         * @param [options] - reuseStored keeps the
         *   browser's stored copy as the source (a user switch: the incoming
         *   user's own copy is still theirs); by default the copy is dropped
         *   and rewritten from a full download, because its per-user strip is
         *   what a Spoiler Guard toggle just changed.
         */
        async invalidateServerCache(options?: {reuseStored?: boolean}) {
            // Not started (no tag type enabled): no cache or overlays to replace.
            s.tagStripRevision = null;
            if (!s.pipelineStarted) return;
            // Hold a flag for the duration of the reload so concurrent scheduleScan()
            // calls (from the body MutationObserver during the await) no-op instead of
            // processing cards against the empty cache. processedCards is reset a
            // SECOND time after load so cards partially marked during await re-scan.
            s.isInvalidating = true;
            try {
                deps.dropServerCache();
                s.tagStripRevision = null;
                s.processedCards = new WeakSet();
                s.requestQueue = [];
                deps.advanceBatchGeneration();
                s.scanGeneration++;
                s.firstEpisodeCache.clear();
                s.parentSeriesCache.clear();
                // Clear each renderer's derived cache (e.g. quality's serverQualityCache)
                // so it recomputes from the refreshed, spoiler-stripped server data.
                for (const [, renderer] of s.renderers) {
                    if (renderer.onServerCacheRefresh) {
                        try { renderer.onServerCacheRefresh(null); } catch {}
                    }
                }
                // Remove overlays ALREADY in the DOM and clear the per-card "tagged"
                // markers. Without this the re-scan skips cards it considers processed,
                // so genre/quality/rating overlays inserted BEFORE Spoiler Guard was
                // enabled linger on unwatched-episode cards until a full page reload.
                // Mirrors what each feature's own reinitialize does.
                try {
                    document.querySelectorAll(
                        '.quality-overlay-container, .rating-overlay-container, '
                        + '.genre-overlay-container, .language-overlay-container, '
                        + '.age-rating-overlay-container, .status-overlay-container, .awards-overlay-container, .logo-overlay-container, .custom-overlay-container'
                    ).forEach(function (el) { el.remove(); });
                    document.querySelectorAll<HTMLElement>(
                        '[data-je-quality-tagged], [data-je-rating-tagged], '
                        + '[data-je-genre-tagged], [data-je-language-tagged], '
                        + '[data-je-age-rating-tagged], [data-je-status-tagged], [data-je-awards-tagged], [data-je-logo-tagged], [data-je-custom-tagged]'
                    ).forEach(function (el) {
                        delete el.dataset.jeQualityTagged;
                        delete el.dataset.jeRatingTagged;
                        delete el.dataset.jeGenreTagged;
                        delete el.dataset.jeLanguageTagged;
                        delete el.dataset.jeAgeRatingTagged;
                        delete el.dataset.jeStatusTagged;
                        delete el.dataset.jeAwardsTagged;
                        delete el.dataset.jeLogoTagged;
                        delete el.dataset.jeCustomTagged;
                    });
                    // Pills, dots, hover copies and caption outlets carry no
                    // group wrapper class: the layout controller drops them.
                    JE.core.tagLayout?.clearAll();
                } catch (domErr) {
                    console.warn(`${logPrefix} overlay cleanup during invalidate failed:`, domErr);
                }
                const forceDownload = !options?.reuseStored;
                if (deps.anyTagTypeEnabled()) {
                    s.deferredLoad = null;
                    await deps.loadServerCache({ forceDownload });
                    s.processedCards = new WeakSet();
                } else {
                    // Every tag type is off: load when one is turned on (registerRenderer),
                    // still as a fresh download if any skipped reload needed one.
                    s.deferredLoad = { forceDownload: forceDownload || !!s.deferredLoad?.forceDownload };
                }
            } catch (e) {
                console.warn(`${logPrefix} invalidateServerCache failed:`, e);
            } finally {
                s.isInvalidating = false;
            }
            try {
                deps.runScan();
            } catch (e) {
                console.warn(`${logPrefix} post-invalidate scan failed:`, e);
            }
        },
        scheduleScan: deps.scheduleScan,
    };

    Object.assign(deps, { initialize, api });
    JE.tagPipeline = api;


    // The server tag cache is fetched per user (spoiler-stripped for that
    // user), so it must not survive a user switch. Reset synchronously here;
    // the full invalidate-and-reload (which also strips stale DOM overlays)
    // runs once the new user's data is live — reloading at reset time would
    // race the credential swap. The stored copy is per user as well: the
    // outgoing user's is deleted when the incoming user's opens.
    JE.session?.onUserChange('tag-pipeline', () => {
        deps.dropServerCache();
        s.tagStripRevision = null;
        // The outgoing user's remembered tag look facts; the incoming user's
        // stored copy loads (owner checked) on first use.
        s.lookFacts = null;
        s.reviewRatings = null;
        s.reviewRatingsRequestedAt = 0;
        s.skipStoreThisSession = false;
        s.perCardThisSession = false;
        api.clearProcessed();
    });

    document.addEventListener('je:user-data-loaded', () => {
        // The incoming user's layout, density and hide-on-hover choice.
        JE.reinitializeTagLayout?.();
        // The incoming user's tag types registered during the switch and
        // already started loading their cache: don't drop it and load again.
        const startedThisSwitch = s.loadStartedForEpoch !== null && s.loadStartedForEpoch === JE.session?.getEpoch?.();
        s.loadStartedForEpoch = null;
        if (startedThisSwitch) return;
        api.invalidateServerCache({ reuseStored: true }).catch(() => {});
    });


    console.log(`${logPrefix} Module loaded`);
}
