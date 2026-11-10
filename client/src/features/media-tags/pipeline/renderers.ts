import type { PipelineRendererConfig } from './contract';
import { logPrefix, type PipelineFns, type PipelineState } from './state';
import type { TagRuntimeBridge } from './tag-pipeline';

const TAG_SETTING_KEYS = ['qualityTagsEnabled', 'genreTagsEnabled', 'ratingTagsEnabled', 'ageRatingTagsEnabled', 'statusTagsEnabled', 'languageTagsEnabled', 'awardsTagsEnabled', 'logoTagsEnabled', 'customTagsEnabled']; // entries kept in memory on the stored-copy path before it is reset
// ── Pipeline-level exclusions ─────────────────────────────────────
// Elements matching these selectors are skipped before any renderer runs.
// This catches contexts where tags should never appear regardless of which
// renderers are enabled, and avoids the cardScalable vs cardImageContainer
// mismatch that can cause renderer-level shouldIgnoreElement to miss.
const PIPELINE_SKIP_SELECTORS = [
    '.chapterCardImageContainer',           // Scenes / chapters
    '#indexPage .verticalSection.MyMedia .cardImageContainer', // My Media row
    '.formDialog .cardImageContainer',       // Modal dialogs
    '#pluginsPage .cardImageContainer',      // Admin pages
    '#pluginCatalogPage .cardImageContainer',
    '#devicesPage .cardImageContainer',
    '#mediaLibraryPage .cardImageContainer',
    '.listItemImage:not(.listItemImage-large)', // Small list rows (Playlists, Albums); listItemImage-large (e.g. episode lists) is big enough for overlays
    '.jellyseerr-card .cardImageContainer',  // Seerr cards (search, discovery, recommendations): TMDB posters, no Jellyfin item id, so they can never get tags — mark them processed instead of re-walking them on every scan
];
// One ancestor walk per card: closest() with a selector list matches the
// element itself or any ancestor against every selector in one pass, which
// is what matches()||closest() per selector did in eight passes.
const PIPELINE_SKIP_SELECTOR = PIPELINE_SKIP_SELECTORS.join(', ');

/**
 * The registered tag renderers: which cards to skip, registration, and whether any tag type is on.
 * @param s - The pipeline's shared mutable state (state.ts).
 * @param JE - The tag runtime bridge.
 * @param deps - The other pipeline modules' functions, filled in by createTagPipeline before any of them runs.
 */
export function createRenderers(s: PipelineState, JE: TagRuntimeBridge, deps: PipelineFns) {
    /**
     * Check if an element should be skipped by the pipeline entirely.
     * @param el - The cardImageContainer element.
     * */
    function shouldSkipElement(el: HTMLElement): boolean {
        return el.closest(PIPELINE_SKIP_SELECTOR) !== null;
    }


    // ── Renderer Registration ──────────────────────────────────────────

    /**
     * Register a tag renderer with the pipeline.
     * @param name - Unique renderer name (e.g., 'genre', 'quality')
     * @param config.render - (el, item, extras) => void. Renders the overlay.
     *   `extras` contains: { firstEpisode, parentSeries, ratingParentSeries, renderTarget,
     *   stripRevision } (stripRevision: the answer's Spoiler Guard tag strip revision, null
     *   when the item did not come from /tag-data)
     * @param config.isEnabled - () => boolean. Checked before rendering.
     * @param [config.renderFromCache] - (el, itemId) => boolean. Try to render from
     *   localStorage/hot cache without any API call. Returns true if rendered successfully.
     *   This is called BEFORE any batch fetch to handle revisited pages instantly.
     * @param [config.needsFirstEpisode=false] - Whether Series/Season items need first episode data.
     * @param [config.needsParentSeries=false] - Whether Season items need parent Series data.
     * @param [config.needsLatestEpisode=false] - Whether the /tag-data batch should resolve
     *   Series/Season LatestEpisodeAdded (one extra server query per container, so only on request).
     * @param [config.injectCss] - Called once on registration to inject styles.
     * @param [config.cleanup] - Called to clean up old overlays before re-render.
     */
    function registerRenderer(name: string, config: PipelineRendererConfig) {
        s.renderers.set(name, {
            render: config.render,
            renderFromCache: config.renderFromCache || null,
            renderFromServerCache: config.renderFromServerCache || null,
            onServerCacheRefresh: config.onServerCacheRefresh || null,
            isEnabled: config.isEnabled,
            needsFirstEpisode: config.needsFirstEpisode || false,
            needsParentSeries: config.needsParentSeries || false,
            needsLatestEpisode: config.needsLatestEpisode || false,
            injectCss: config.injectCss || null,
            cleanup: config.cleanup || null,
        });
        if (config.injectCss) {
            try { config.injectCss(); } catch (e) {
                console.warn(`${logPrefix} Failed to inject CSS for ${name}:`, e);
            }
        }
        console.log(`${logPrefix} Renderer registered: ${name} (total: ${s.renderers.size})`);
        // Starting now: initialize() scans once the server cache is loaded.
        // (A renderer can register late, after its user switched to one with
        // every tag type off: then there is still nothing to start.)
        if (s.startWhenRendererRegisters && anyTagTypeEnabled()) {
            s.loadStartedForEpoch = JE.session?.getEpoch?.() ?? null;
            deps.initialize();
            return;
        }
        // The last invalidation skipped its reload while every tag type was off:
        // run it now, as that invalidation (scans held, fresh download if needed).
        if (s.deferredLoad && anyTagTypeEnabled()) {
            const { forceDownload } = s.deferredLoad;
            s.deferredLoad = null;
            s.loadStartedForEpoch = JE.session?.getEpoch?.() ?? null;
            deps.api.invalidateServerCache({ reuseStored: !forceDownload }).catch(() => {});
            return;
        }

        // If cards are already on the page (renderer registered after initial scan),
        // clear processed set and rescan so existing cards get this renderer's tags.
        s.processedCards = new WeakSet();
        deps.scheduleScan();
    }


    // ── Card Scanning ──────────────────────────────────────────────────

    /**
     * Check whether at least one registered renderer is currently enabled.
     * @returns True if any renderer reports enabled.
     */
    /**
     * Whether the user has any poster tag type on. Read from the settings as
     * well as the registered renderers, because a renderer can register after
     * the pipeline starts (quality tags wait for Jellyfin's audio preference).
     * */
    function anyTagTypeEnabled(): boolean {
        return TAG_SETTING_KEYS.some((key) => !!JE.currentSettings?.[key]) || hasAnyEnabledRenderer();
    }


    function hasAnyEnabledRenderer() {
        for (const [, r] of s.renderers) {
            if (r.isEnabled()) return true;
        }
        return false;
    }

    return { shouldSkipElement, registerRenderer, anyTagTypeEnabled, hasAnyEnabledRenderer };
}
