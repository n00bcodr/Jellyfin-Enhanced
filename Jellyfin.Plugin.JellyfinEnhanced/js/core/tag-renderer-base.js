// @ts-check
// /js/core/tag-renderer-base.js
//
// Shared factory for the poster tag overlay modules (genre, language,
// rating, quality). Before this existed, each of those modules re-declared
// near-identical plumbing: the versioned localStorage cache with
// server-triggered clears, the ignore-selector matcher, the
// tagged-card bookkeeping, CSS injection, cache-manager registration and
// the reinitialize sequence. The factory owns that plumbing; each tag
// module supplies only what genuinely differs (icon/label mapping, data
// extraction, CSS text, settings keys, cache entry shapes) via a spec.
//
// Frozen surfaces preserved by design:
// - localStorage cache key NAMES (users' caches survive the refactor)
// - rendered DOM (container classes, data-* tagged attributes)
// - the tag-pipeline registerRenderer contract (tags/tag-pipeline.js)
// - JE.reinitializeXTags function names (defined by each tag module,
//   delegating to reinitialize() here)
//
// Public surface: JE.core.tagRenderer { register, reinitialize, resolvePosition }.
(function(JE) {
    'use strict';

    JE.core = JE.core || {};

    /**
     * @typedef {Object} TagCacheSpec
     * @property {string} key - Exact localStorage key (frozen; do not rename).
     * @property {string} legacyPrefix - Legacy key stem removed by cleanup,
     *   e.g. 'genreTagsCache' removes 'genreTagsCache', 'genreTagsCache-*'
     *   and 'genreTagsCacheTimestamp'.
     * @property {string} [hotBucket] - Bucket name on the shared JE._hotCache.
     * @property {boolean} [pruneOnSave] - Drop entries older than the TTL
     *   (by entry.timestamp) before persisting.
     * @property {boolean} [saveOnUnload] - Also save on beforeunload
     *   (default true).
     */

    /**
     * @typedef {Object} TagPipelineSpec
     * @property {Function} render - (ctx, el, item, extras) => void.
     * @property {Function} [renderFromCache] - (ctx, el, itemId) => boolean.
     * @property {Function} [renderFromServerCache] - (ctx, el, entry, itemId) => void.
     * @property {Function} [onServerCacheRefresh] - (ctx, updatedIds|null) => void.
     * @property {boolean} [needsFirstEpisode]
     * @property {boolean} [needsParentSeries]
     */

    /**
     * @typedef {Object} TagSpec
     * @property {string} logPrefix - Console prefix, kept per-module.
     * @property {string} settingKey - JE.currentSettings key gating the renderer.
     * @property {string} containerClass - Overlay container class (frozen DOM).
     * @property {string} taggedAttr - dataset key marking tagged cards (frozen DOM).
     * @property {string} [styleId] - <style> element id (frozen).
     * @property {Function} [buildCss] - (ctx) => css text, re-evaluated on every
     *   injection so position settings are picked up.
     * @property {TagCacheSpec} [cache]
     * @property {string[]} [ignoreSelectors] - Defaults to the standard card list.
     * @property {string} [searchPageIgnoreSelector] - Appended when
     *   DisableTagsOnSearchPage is set (default '#searchPage .cardImageContainer').
     * @property {Function} [shouldIgnore] - (el, defaultMatcher) => boolean override.
     * @property {TagPipelineSpec} [pipeline]
     */

    // Contexts (cards) that should never receive tag overlays. Shared verbatim
    // by the language/rating/quality modules; genre supplies its own list.
    const STANDARD_IGNORE_SELECTORS = [
        '#itemDetailPage .infoWrapper .cardImageContainer',
        '#itemDetailPage #castCollapsible .cardImageContainer',
        '#indexPage .verticalSection.MyMedia .cardImageContainer',
        '.formDialog .cardImageContainer',
        '#itemDetailPage .chapterCardImageContainer',
        // Admin/dashboard pages
        '#pluginsPage .cardImageContainer',
        '#pluginsPage .card',
        '#pluginCatalogPage .cardImageContainer',
        '#pluginCatalogPage .card',
        '#devicesPage .cardImageContainer',
        '#devicesPage .card',
        '#mediaLibraryPage .cardImageContainer',
        '#mediaLibraryPage .card',
    ];

    /** @type {Map<string, any>} name → tag instance */
    const tags = new Map();

    /**
     * Resolve a tag position setting (user → admin default → hardcoded) into
     * the CSS placement values every tag stylesheet derives from it.
     * @param {string} userKey - Key on JE.currentSettings (e.g. 'genreTagsPosition').
     * @param {string} pluginKey - Key on JE.pluginConfig (e.g. 'GenreTagsPosition').
     * @param {string} fallback - Hardcoded default (e.g. 'top-right').
     * @returns {{pos: string, isTop: boolean, isLeft: boolean, topVal: string,
     *   bottomVal: string, leftVal: string, rightVal: string,
     *   needsTopRightOffset: boolean}}
     */
    function resolvePosition(userKey, pluginKey, fallback) {
        const pos = JE.currentSettings?.[userKey] || JE.pluginConfig?.[pluginKey] || fallback;
        const isTop = pos.includes('top');
        const isLeft = pos.includes('left');
        return {
            pos,
            isTop,
            isLeft,
            topVal: isTop ? '6px' : 'auto',
            bottomVal: isTop ? 'auto' : '6px',
            leftVal: isLeft ? '6px' : 'auto',
            rightVal: isLeft ? 'auto' : '6px',
            needsTopRightOffset: isTop && !isLeft,
        };
    }

    /**
     * Convert a dataset camelCase key to its data-* attribute form.
     * @param {string} camel - e.g. 'jeGenreTagged'
     * @returns {string} e.g. 'je-genre-tagged'
     */
    function toKebab(camel) {
        return camel.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
    }

    // Gap (px) between stacked tag containers that share a corner.
    const CORNER_STACK_GAP = 4;

    /**
     * When two tag containers share a corner (data-je-corner, set in
     * commitOverlay), nudge each one after the first just far enough to
     * clear the one before it instead of overlapping. Measures actual
     * rendered edges via getBoundingClientRect so it still works with the
     * top-right corner's indicator-avoidance margin. No-op when a corner
     * has only one occupant, which is the common case.
     * @param {HTMLElement} host - The .je-tag-host element.
     */
    function applyCornerStacking(host) {
        const groups = {};
        for (const child of host.children) {
            const corner = /** @type {HTMLElement} */ (child).dataset?.jeCorner;
            if (!corner) continue;
            (groups[corner] = groups[corner] || []).push(child);
        }
        for (const corner in groups) {
            const items = groups[corner];
            if (items.length <= 1) {
                if (items[0]) items[0].style.transform = '';
                continue;
            }
            const isTop = corner.indexOf('top') === 0;
            // Clear first so the rects read below reflect each item's natural
            // (untransformed) CSS position, not a stale offset from a prior pass.
            for (const el of items) el.style.transform = '';

            let boundary = null; // trailing edge of the previous item, in viewport coords
            for (const el of items) {
                const rect = el.getBoundingClientRect();
                if (boundary === null) {
                    boundary = isTop ? rect.bottom : rect.top;
                    continue;
                }
                const naturalEdge = isTop ? rect.top : rect.bottom;
                const delta = isTop
                    ? (boundary + CORNER_STACK_GAP) - naturalEdge
                    : naturalEdge - (boundary - CORNER_STACK_GAP);
                if (delta > 0) {
                    el.style.transform = `translateY(${isTop ? delta : -delta}px)`;
                    boundary = isTop ? (naturalEdge + delta + rect.height) : (naturalEdge - delta - rect.height);
                } else {
                    // Already clear of the previous item without help (e.g. its
                    // own margin already pushed it far enough) — leave it be.
                    boundary = isTop ? rect.bottom : rect.top;
                }
            }
        }
    }

    /**
     * Build a tag instance (state + ctx + lifecycle) for one renderer.
     * @param {string} name - Pipeline renderer name (e.g. 'genre').
     * @param {TagSpec} spec
     */
    function createTag(name, spec) {
        const logPrefix = spec.logPrefix;
        const containerClass = spec.containerClass;
        const TAGGED_ATTR = spec.taggedAttr;

        const state = {
            /** @type {Object<string, any>} persistent (localStorage-backed) cache */
            cache: {},
            /** @type {Map<string, any>|null} shared hot cache bucket */
            hot: null,
            localStorageEnabled: false,
            cacheTtl: (30) * 24 * 60 * 60 * 1000,
            /** @type {string[]|null} */
            ignoreSelectors: null,
            saveRegistered: false,
            unloadRegistered: false,
        };

        // ── Ignore / tagged helpers ────────────────────────────────────

        /** @returns {string[]} */
        function buildIgnoreSelectors() {
            const list = (spec.ignoreSelectors || STANDARD_IGNORE_SELECTORS).slice();
            if (JE.pluginConfig?.DisableTagsOnSearchPage === true) {
                list.push(spec.searchPageIgnoreSelector || '#searchPage .cardImageContainer');
            }
            return list;
        }

        /**
         * @param {HTMLElement} el
         * @returns {boolean}
         */
        function defaultShouldIgnore(el) {
            if (!state.ignoreSelectors) state.ignoreSelectors = buildIgnoreSelectors();
            // The shared pipeline renders into `.je-tag-host`, which is a
            // sibling of `.cardImageContainer` inside `.cardScalable`. Resolve
            // back to the image container before applying exclusion selectors.
            const target = el.closest('.cardImageContainer')
                || el.closest('.cardScalable')?.querySelector('.cardImageContainer')
                || el;
            return state.ignoreSelectors.some((selector) => {
                try {
                    if (target.matches(selector)) return true;
                    return target.closest(selector) !== null;
                } catch {
                    return false; // Silently handle potential errors with complex selectors
                }
            });
        }

        /**
         * @param {HTMLElement} el
         * @returns {boolean}
         */
        function shouldIgnore(el) {
            return spec.shouldIgnore
                ? !!spec.shouldIgnore(el, defaultShouldIgnore)
                : defaultShouldIgnore(el);
        }

        /**
         * Check whether the card containing el already carries this overlay.
         * @param {HTMLElement} el
         * @returns {boolean}
         */
        function isTagged(el) {
            const card = el.closest('.card');
            if (!card) return false;
            const hasAttr = /** @type {HTMLElement} */ (card).dataset?.[TAGGED_ATTR] === '1';
            const hasOverlay = !!card.querySelector(`.${containerClass}`);
            return hasAttr && hasOverlay;
        }

        /**
         * Mark the card containing el as tagged.
         * @param {HTMLElement} el
         */
        function markTagged(el) {
            const card = el.closest('.card');
            if (card) /** @type {HTMLElement} */ (card).dataset[TAGGED_ATTR] = '1';
        }

        // ── localStorage cache ─────────────────────────────────────────

        /**
         * The persisted payload can contain per-user data (tag entries are
         * spoiler-stripped for the user that fetched them), but the cache key
         * NAME is frozen — renaming it to embed a user id would orphan every
         * existing user's cache. Instead a sibling "<key>:identity-owner"
         * sentinel records which server:user wrote the payload; on mismatch
         * (or a legacy cache with no sentinel, which is untrusted) the payload
         * is dropped before it can be served to the wrong user.
         */
        function enforceCacheOwnership() {
            if (!spec.cache || !state.localStorageEnabled) return;
            try {
                const ownerKey = `${spec.cache.key}:identity-owner`;
                const userId = JE.session?.getUserId()
                    || (typeof ApiClient !== 'undefined' ? ApiClient.getCurrentUserId?.() : null) || '';
                const expected = `${JE.session?.getServerId() || ''}:${userId}`;
                if (localStorage.getItem(ownerKey) !== expected) {
                    localStorage.removeItem(spec.cache.key);
                    localStorage.setItem(ownerKey, expected);
                }
            } catch (e) {
                console.warn(`${logPrefix} cache ownership check failed`, e);
            }
        }

        function loadCacheSettings() {
            state.localStorageEnabled =
                JE.pluginConfig?.TagCacheServerMode === false ||
                JE.pluginConfig?.EnableTagsLocalStorageFallback === true;
            state.cacheTtl = (JE.pluginConfig?.TagsCacheTtlDays || 30) * 24 * 60 * 60 * 1000;
            if (!spec.cache) return;
            enforceCacheOwnership();
            state.cache = state.localStorageEnabled
                ? (JSON.parse(localStorage.getItem(spec.cache.key) || '{}') || {})
                : {};
            if (spec.cache.hotBucket) {
                const Hot = (JE._hotCache = JE._hotCache || { ttl: state.cacheTtl });
                Hot[spec.cache.hotBucket] = Hot[spec.cache.hotBucket] || new Map();
                state.hot = Hot[spec.cache.hotBucket];
            }
        }

        /** Persist the cache to localStorage (registered with JE._cacheManager). */
        function saveCache() {
            if (!spec.cache || !state.localStorageEnabled) return;
            try {
                if (spec.cache.pruneOnSave) {
                    const now = Date.now();
                    for (const [key, entry] of Object.entries(state.cache)) {
                        if (entry && now - entry.timestamp > state.cacheTtl) {
                            delete state.cache[key];
                        }
                    }
                }
                localStorage.setItem(spec.cache.key, JSON.stringify(state.cache));
            } catch (e) {
                console.warn(`${logPrefix} Failed to save cache`, e);
            }
        }

        /**
         * Remove legacy cache keys from previous plugin versions and honor
         * server-triggered cache clears (ClearLocalStorageTimestamp).
         */
        function cleanupOldCaches() {
            if (!spec.cache || !state.localStorageEnabled) return;
            const CACHE_KEY = spec.cache.key;
            const TIMESTAMP_KEY = `${CACHE_KEY}Timestamp`;
            // A renderer can accumulate several generations of dead keys
            // (un-namespaced, then namespaced-v1, …), so accept one stem or a
            // list of them — replacing the stem would orphan the older one.
            const legacyStems = Array.isArray(spec.cache.legacyPrefix)
                ? spec.cache.legacyPrefix
                : [spec.cache.legacyPrefix];

            const stale = [];
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key &&
                    legacyStems.some(legacy => key.startsWith(`${legacy}-`) || key === legacy || key === `${legacy}Timestamp`) &&
                    key !== CACHE_KEY && key !== TIMESTAMP_KEY) {
                    stale.push(key);
                }
            }
            for (const key of stale) {
                console.log(`${logPrefix} Removing old cache: ${key}`);
                localStorage.removeItem(key);
            }

            const serverClearTimestamp = JE.pluginConfig?.ClearLocalStorageTimestamp || 0;
            const localCacheTimestamp = parseInt(localStorage.getItem(TIMESTAMP_KEY) || '0', 10);
            if (serverClearTimestamp > localCacheTimestamp) {
                console.log(`${logPrefix} Server triggered cache clear (${new Date(serverClearTimestamp).toISOString()})`);
                localStorage.removeItem(CACHE_KEY);
                localStorage.setItem(TIMESTAMP_KEY, serverClearTimestamp.toString());
                state.cache = {};
                if (state.hot) state.hot.clear();
            }
        }

        // ── CSS ────────────────────────────────────────────────────────

        /** Inject (or replace) this tag's stylesheet under its frozen style id. */
        function injectCss() {
            if (!spec.styleId || typeof spec.buildCss !== 'function') return;
            JE.core.ui.injectCss(spec.styleId, spec.buildCss(ctx));
        }

        // ── Context handed to spec callbacks ───────────────────────────

        const ctx = {
            name,
            logPrefix,
            containerClass,
            taggedAttr: TAGGED_ATTR,
            /** @returns {Map<string, any>|null} shared hot cache bucket */
            get hot() { return state.hot; },
            /** @returns {number} cache TTL in ms */
            get cacheTtl() { return state.cacheTtl; },
            /** @returns {boolean} whether localStorage fallback is active */
            get localStorageEnabled() { return state.localStorageEnabled; },
            /**
             * @param {string} itemId
             * @returns {*} the persistent cache entry (raw, module-defined shape)
             */
            getPersistent(itemId) { return state.cache[itemId]; },
            /**
             * Store a persistent cache entry and schedule a save.
             * @param {string} itemId
             * @param {*} value
             */
            setPersistent(itemId, value) {
                state.cache[itemId] = value;
                if (JE._cacheManager) JE._cacheManager.markDirty();
            },
            isTagged,
            markTagged,
            shouldIgnore,
            injectCss,
            /**
             * Remove an existing overlay container from el, if present.
             * @param {HTMLElement} el
             */
            removeExistingOverlay(el) {
                const existing = el.querySelector(`.${containerClass}`);
                if (existing) existing.remove();
            },
            /**
             * Append the overlay if it has content and mark the card tagged.
             * @param {HTMLElement} el
             * @param {HTMLElement} overlay
             * @returns {boolean} true if the overlay was attached
             */
            commitOverlay(el, overlay) {
                if (spec.position) {
                    const p = resolvePosition(spec.position.userKey, spec.position.pluginKey, spec.position.fallback);
                    overlay.dataset.jeCorner = p.pos;
                }
                if (overlay.children.length === 0) {
                    applyCornerStacking(el);
                    return false;
                }
                el.appendChild(overlay);
                markTagged(el);
                applyCornerStacking(el);
                return true;
            },
        };

        // Wipe both the in-memory and the persisted cache on a user switch,
        // and stamp the new owner so a later hard reload doesn't wipe the new
        // user's freshly-built cache a second time.
        JE.session?.onUserChange(`tag-cache-${name}`, (change) => {
            state.cache = {};
            if (state.hot) state.hot.clear();
            if (!spec.cache) return;
            try {
                localStorage.removeItem(spec.cache.key);
                localStorage.setItem(
                    `${spec.cache.key}:identity-owner`,
                    `${change.serverId || ''}:${change.userId || ''}`
                );
            } catch (e) {
                console.warn(`${logPrefix} cache clear on user switch failed`, e);
            }
        });

        // ── Lifecycle ──────────────────────────────────────────────────

        /**
         * Initialize: load caches, clean legacy keys, register save hooks and
         * the pipeline renderer. Idempotent — repeated calls re-register the
         * renderer (fresh settings) without duplicating save hooks.
         */
        function initialize() {
            loadCacheSettings();
            state.ignoreSelectors = buildIgnoreSelectors();
            cleanupOldCaches();

            if (spec.cache && state.localStorageEnabled) {
                if (JE._cacheManager && !state.saveRegistered) {
                    JE._cacheManager.register(saveCache);
                    state.saveRegistered = true;
                }
                if (spec.cache.saveOnUnload !== false && !state.unloadRegistered) {
                    window.addEventListener('beforeunload', saveCache);
                    state.unloadRegistered = true;
                }
            }

            const p = spec.pipeline;
            if (!p) return;
            if (!JE.tagPipeline) {
                console.warn(`${logPrefix} Tag pipeline not available, tags will not render.`);
                return;
            }
            JE.tagPipeline.registerRenderer(name, {
                render: (el, item, extras) => p.render(ctx, el, item, extras),
                renderFromCache: p.renderFromCache
                    ? (el, itemId) => p.renderFromCache(ctx, el, itemId)
                    : undefined,
                renderFromServerCache: p.renderFromServerCache
                    ? (el, entry, itemId) => p.renderFromServerCache(ctx, el, entry, itemId)
                    : undefined,
                onServerCacheRefresh: p.onServerCacheRefresh
                    ? (updatedIds) => p.onServerCacheRefresh(ctx, updatedIds)
                    : undefined,
                isEnabled: () => !!JE.currentSettings?.[spec.settingKey],
                needsFirstEpisode: !!p.needsFirstEpisode,
                needsParentSeries: !!p.needsParentSeries,
                injectCss,
            });
            console.log(`${logPrefix} Registered with unified tag pipeline.`);
        }

        /**
         * Reinitialize: remove existing overlays and tagged markers, re-inject
         * CSS (position settings may have changed), then rescan via the
         * pipeline if the feature is still enabled.
         */
        function reinitialize() {
            console.log(`${logPrefix} Re-initializing...`);

            document.querySelectorAll(`.${containerClass}`).forEach((el) => el.remove());
            document.querySelectorAll(`[data-${toKebab(TAGGED_ATTR)}]`).forEach((el) => {
                delete /** @type {HTMLElement} */ (el).dataset[TAGGED_ATTR];
            });

            // Use the pipeline's registered injectCss reference when available
            // (same function — kept for parity with the pre-factory modules).
            const renderer = JE.tagPipeline?.getRenderer?.(name);
            if (renderer?.injectCss) renderer.injectCss();
            else injectCss();

            if (!JE.currentSettings?.[spec.settingKey]) {
                console.log(`${logPrefix} Feature is disabled after reinit.`);
                return;
            }

            JE.tagPipeline?.clearProcessed();
            JE.tagPipeline?.scheduleScan();
        }

        return { ctx, initialize, reinitialize };
    }

    /**
     * Get or lazily create the tag instance for a name.
     * @param {string} name
     * @param {TagSpec} spec
     */
    function getOrCreate(name, spec) {
        let tag = tags.get(name);
        if (!tag) {
            tag = createTag(name, spec);
            tags.set(name, tag);
        }
        return tag;
    }

    /**
     * Register (or re-register) a tag renderer described by spec.
     * Called from each tag module's JE.initializeXTags.
     * @param {string} name - Pipeline renderer name.
     * @param {TagSpec} spec
     * @returns {Object} the ctx handle (also passed to spec callbacks)
     */
    function register(name, spec) {
        const tag = getOrCreate(name, spec);
        tag.initialize();
        return tag.ctx;
    }

    /**
     * Run the standard reinitialize sequence for a tag. Works even when the
     * tag was never registered (feature disabled at boot): cleanup and CSS
     * injection fall back to the spec.
     * @param {string} name - Pipeline renderer name.
     * @param {TagSpec} spec
     */
    function reinitialize(name, spec) {
        getOrCreate(name, spec).reinitialize();
    }

    JE.core.tagRenderer = {
        register,
        reinitialize,
        resolvePosition,
    };

    console.log('🪼 Jellyfin Enhanced: Tag renderer core initialized');

})(window.JellyfinEnhanced);
