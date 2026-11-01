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
// Placement: the six poster groups are handed to the shared layout
// controller (js/core/tag-layout.js), which owns where and how they appear;
// a renderer it does not know keeps the original direct-append behaviour.
//
// Public surface: JE.core.tagRenderer { register, reinitialize, resolvePosition,
// isIgnoredContext, applyCornerStacking, scheduleCornerStacking }.
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
     * @property {Function} [onServerCacheRefresh] - (ctx, updatedIds|null, info?) => void;
     *   info.replaced is true when the pipeline swapped in a replacement cache
     *   under cards it will not re-render itself.
     * @property {Function} [cleanup] - (ctx) => void; release feature resources on reinitialize/teardown.
     * @property {boolean} [needsFirstEpisode]
     * @property {boolean} [needsParentSeries]
     * @property {boolean} [needsLatestEpisode]
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

    /** @type {Map<string, TagSpec>} Base styles available even when a renderer is disabled. */
    const styleSpecs = new Map();

    /** @type {Map<HTMLElement, Set<object>>} Sheets borrowed only by live previews. */
    const previewStyles = new Map();

    /** @type {string|null} STANDARD_IGNORE_SELECTORS (+ search page) joined, per DisableTagsOnSearchPage */
    let standardIgnoreSelector = null;
    let standardIgnoreSearch = null;

    /**
     * Whether a card sits in a context that never shows poster tags (the
     * standard exclusions every renderer but genre uses, plus the search page
     * when DisableTagsOnSearchPage is set). The layout controller asks before
     * reserving caption space for a card no renderer will tag.
     * @param {HTMLElement} el - A render target or anything inside the card.
     * @returns {boolean}
     */
    function isIgnoredContext(el) {
        if (!el) return true;
        const search = JE.pluginConfig?.DisableTagsOnSearchPage === true;
        if (standardIgnoreSelector === null || standardIgnoreSearch !== search) {
            standardIgnoreSearch = search;
            standardIgnoreSelector = STANDARD_IGNORE_SELECTORS
                .concat(search ? ['#searchPage .cardImageContainer'] : [])
                .join(', ');
        }
        const target = el.closest('.cardImageContainer')
            || el.closest('.cardScalable')?.querySelector('.cardImageContainer')
            || el;
        try {
            return target.closest(standardIgnoreSelector) !== null;
        } catch {
            return false;
        }
    }

    /**
     * The layout controller when it manages this renderer's group, else null.
     * @param {string} name - Pipeline renderer name.
     * @returns {any}
     */
    function layoutFor(name) {
        const layout = JE.core.tagLayout;
        return layout && layout.normalizeGroup(name) ? layout : null;
    }

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
     * Takes one host or a whole slice of them: every transform reset comes
     * first, then every measurement, then the new transforms, so a slice of
     * freshly rendered cards costs one layout instead of one per card (a
     * rect read right after a style write forces layout each time).
     * @param {HTMLElement|HTMLElement[]} hostOrHosts - The .je-tag-host element(s).
     */
    function applyCornerStacking(hostOrHosts) {
        const hosts = Array.isArray(hostOrHosts) ? hostOrHosts : [hostOrHosts];
        /** @type {Array<{isTop: boolean, items: HTMLElement[]}>} corners with more than one occupant */
        const stacks = [];
        for (const host of hosts) {
            if (!host) continue;
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
                // Clear first so the rects read below reflect each item's natural
                // (untransformed) CSS position, not a stale offset from a prior pass.
                for (const el of items) el.style.transform = '';
                stacks.push({ isTop: corner.indexOf('top') === 0, items });
            }
        }
        if (stacks.length === 0) return;

        // Every read before any write: transforms don't move an item's natural
        // position, so the rects are the same whether read before or after.
        const rects = stacks.map((stack) => stack.items.map((el) => el.getBoundingClientRect()));
        stacks.forEach(({ isTop, items }, s) => {
            let boundary = null; // trailing edge of the previous item, in viewport coords
            items.forEach((el, i) => {
                const rect = rects[s][i];
                if (boundary === null) {
                    boundary = isTop ? rect.bottom : rect.top;
                    return;
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
            });
        });
    }

    /** @type {Set<HTMLElement>} hosts waiting for the next batched stacking pass */
    const pendingStackHosts = new Set();
    let stackFrame = 0;

    /**
     * Corner-stack a host in the next animation frame, together with every
     * other host queued by then. For overlays that land outside the
     * pipeline's own render slices (the user review chip arrives after an
     * async lookup): measuring each card as its chip arrives would force a
     * layout per card.
     * @param {HTMLElement} host - The .je-tag-host element.
     */
    function scheduleCornerStacking(host) {
        if (!host) return;
        pendingStackHosts.add(host);
        if (stackFrame) return;
        stackFrame = requestAnimationFrame(() => {
            stackFrame = 0;
            const hosts = Array.from(pendingStackHosts).filter((h) => h.isConnected);
            pendingStackHosts.clear();
            applyCornerStacking(hosts);
        });
    }

    /** @type {WeakMap<HTMLElement, HTMLElement|null>} render target → its .card, looked up once */
    const cardByEl = new WeakMap();

    /**
     * The .card containing el, memoised per element (a render target never
     * moves to another card). Every renderer's tagged checks go through here
     * instead of walking up from the same element several times per card.
     * @param {HTMLElement} el
     * @returns {HTMLElement|null}
     */
    function cardOf(el) {
        let card = cardByEl.get(el);
        if (card === undefined) {
            card = el.closest('.card');
            cardByEl.set(el, card);
        }
        return card;
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
            /** @type {string|null} ignoreSelectors joined into one selector list */
            ignoreSelector: null,
            saveRegistered: false,
            unloadRegistered: false,
        };

        // Only the accepted /tag-data callback can authorize a fallback write. Never
        // label /Items, IndexedDB or server-cache projections with mutable page state.
        let writeRevision = null;
        const ENVELOPE_VERSION = 1;
        function revision() {
            try {
                const value = JE.tagPipeline?.tagStripRevision?.();
                return typeof value === 'string' && value.length ? value : null;
            } catch { return null; }
        }
        function dirty() { JE._cacheManager?.markDirty(); }
        function discard(itemId) {
            delete state.cache[itemId];
            state.hot?.delete(itemId);
            dirty();
        }
        function valid(entry, stamp) {
            return !!entry && entry.v === ENVELOPE_VERSION && entry.stripRevision === stamp
                && Object.prototype.hasOwnProperty.call(entry, 'payload')
                && Number.isFinite(entry.timestamp) && Date.now() - entry.timestamp < state.cacheTtl;
        }
        function readFallback(itemId, persistent) {
            const stamp = revision();
            // Bootstrap failure/guard invalidation is unknown, not permission to reuse
            // a copy. Leave it intact until an authoritative answer arrives.
            if (stamp === null) return undefined;
            const entry = persistent ? state.cache[itemId] : state.hot?.get(itemId);
            if (entry === undefined) return undefined;
            if (!valid(entry, stamp) || (persistent && stamp !== 'none')) {
                discard(itemId);
                return undefined;
            }
            return entry.payload;
        }
        function writeFallback(itemId, payload, persistent) {
            if (writeRevision === null || !spec.cache) return;
            const entry = { v: ENVELOPE_VERSION, stripRevision: writeRevision, payload,
                timestamp: Number.isFinite(payload?.timestamp) ? payload.timestamp : Date.now() };
            // Every persistent write also has a page-local copy, including empty facts.
            if (state.hot) state.hot.set(itemId, entry);
            if (writeRevision === 'none' && persistent) state.cache[itemId] = entry;
            else if (writeRevision !== 'none') delete state.cache[itemId];
            dirty();
        }
        // Preserve the module-facing Map vocabulary, but never expose raw hot entries.
        const hot = {
            get: itemId => readFallback(itemId, false),
            set(itemId, payload) { writeFallback(itemId, payload, false); return hot; },
            delete(itemId) { discard(itemId); return true; },
            clear() { state.hot?.clear(); },
            get size() { return state.hot?.size || 0; },
        };
        function invalidateFallback(updatedIds) {
            if (!updatedIds) { state.cache = {}; state.hot?.clear(); dirty(); }
            else for (const id of updatedIds) discard(String(id));
        }

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
            if (state.ignoreSelector === null) state.ignoreSelector = state.ignoreSelectors.join(', ');
            // The shared pipeline renders into `.je-tag-host`, which is a
            // sibling of `.cardImageContainer` inside `.cardScalable`. Resolve
            // back to the image container before applying exclusion selectors.
            const target = el.closest('.cardImageContainer')
                || el.closest('.cardScalable')?.querySelector('.cardImageContainer')
                || el;
            // closest() with the whole list matches the element or any ancestor
            // against every selector in one ancestor walk — what
            // matches()||closest() per selector did in a dozen walks per card.
            try {
                return target.closest(state.ignoreSelector) !== null;
            } catch {
                // One unsupported selector rejects the whole list: fall back to
                // checking them one by one and skipping the bad one.
                return state.ignoreSelectors.some((selector) => {
                    try {
                        if (target.matches(selector)) return true;
                        return target.closest(selector) !== null;
                    } catch {
                        return false; // Silently handle potential errors with complex selectors
                    }
                });
            }
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
            const card = cardOf(el);
            if (!card) return false;
            // Attribute first: the common case (this renderer hasn't tagged the
            // card yet) then costs a dataset read, not a subtree query.
            if (/** @type {HTMLElement} */ (card).dataset?.[TAGGED_ATTR] !== '1') return false;
            // Layout-managed groups: the controller holds what the card shows
            // (a pill or dots carry no wrapper class to look for).
            const layout = layoutFor(name);
            if (layout) return layout.hasGroup(el, name);
            // The overlay is normally a direct child of the render target.
            for (const child of el.children) {
                if (child.classList.contains(containerClass)) return true;
            }
            return !!card.querySelector(`.${containerClass}`);
        }

        /**
         * Mark the card containing el as tagged.
         * @param {HTMLElement} el
         */
        function markTagged(el) {
            const card = cardOf(el);
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
            state.cache = {};
            if (state.localStorageEnabled) {
                try {
                    const cached = JSON.parse(localStorage.getItem(spec.cache.key) || '{}');
                    // Persisted data is an item-id dictionary. Corrupt or obsolete
                    // payloads must not prevent the renderer from registering.
                    if (cached && typeof cached === 'object' && !Array.isArray(cached)) state.cache = cached;
                } catch (e) {
                    console.warn(`${logPrefix} Ignoring unreadable tag cache`, e);
                }
            }
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
                { // Every saved envelope must be authoritative, unstripped and within TTL.
                    for (const [key, entry] of Object.entries(state.cache)) {
                        if (!valid(entry, 'none')) {
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
            // The current key can itself start with a legacy stem (language
            // tags: "…languageTagsCache-v2" vs the old "…languageTagsCache"),
            // so every current-generation key — including the owner sentinel,
            // whose loss would wipe the cache on every reload — is kept.
            const currentKeys = [CACHE_KEY, TIMESTAMP_KEY, `${CACHE_KEY}:identity-owner`];
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
                    !currentKeys.includes(key)) {
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
            const css = spec.buildCss(ctx);
            const text = JE.core.tagLayout?.preserveLegacySizing?.(css) || css;
            const existing = document.getElementById(spec.styleId);
            if (existing && previewStyles.delete(existing)) {
                // A personal renderer takes over the preview's sheet in place.
                // Its lifetime now belongs to the renderer, regardless of previews.
                delete existing.dataset.jeTagPreviewOwned;
                existing.textContent = text;
            } else {
                JE.core.ui.injectCss(spec.styleId, text);
            }
        }

        // ── Context handed to spec callbacks ───────────────────────────

        const ctx = {
            name,
            logPrefix,
            containerClass,
            taggedAttr: TAGGED_ATTR,
            /** @returns {Map<string, any>|null} shared hot cache bucket */
            get hot() { return state.hot ? hot : null; },
            /** @returns {number} cache TTL in ms */
            get cacheTtl() { return state.cacheTtl; },
            /** @returns {boolean} whether localStorage fallback is active */
            get localStorageEnabled() { return state.localStorageEnabled; },
            /**
             * @param {string} itemId
             * @returns {*} the validated, module-defined payload
             */
            getPersistent(itemId) { return readFallback(itemId, true); },
            /** Only called within an authoritative batch render (see writeRevision). */
            setPersistent(itemId, value) { writeFallback(itemId, value, true); },
            deletePersistent: discard,
            clearPersistent() { state.cache = {}; dirty(); },
            isTagged,
            markTagged,
            shouldIgnore,
            injectCss,
            /**
             * Remove an existing overlay container from el, if present.
             * @param {HTMLElement} el
             */
            removeExistingOverlay(el) {
                layoutFor(name)?.removeGroup(el, name);
                const existing = el.querySelector(`.${containerClass}`);
                if (existing) existing.remove();
            },
            /**
             * Hand the overlay to the layout controller (or, for a renderer it
             * does not manage, append it) if it has content, and mark the card
             * tagged. Unmanaged overlays are NOT corner-stacked here: up to 4 renderers can each
             * commit an overlay onto the same host, and re-measuring
             * (getBoundingClientRect) after every single one forces a layout
             * per renderer per card. The pipeline calls
             * JE.core.tagRenderer.applyCornerStacking(host) once after all
             * renderers have committed for a given card instead.
             * @param {HTMLElement} el
             * @param {HTMLElement} overlay
             * @returns {boolean} true if the overlay was attached
             */
            commitOverlay(el, overlay) {
                const layout = layoutFor(name);
                if (layout) {
                    if (!layout.commitGroup(el, name, overlay)) return false;
                    markTagged(el);
                    return true;
                }
                if (spec.position) {
                    const p = resolvePosition(spec.position.userKey, spec.position.pluginKey, spec.position.fallback);
                    overlay.dataset.jeCorner = p.pos;
                }
                if (overlay.children.length === 0) return false;
                el.appendChild(overlay);
                markTagged(el);
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
            state.ignoreSelector = null;
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
                render: (el, item, extras) => {
                    writeRevision = typeof extras?.stripRevision === 'string' && extras.stripRevision.length
                        ? extras.stripRevision : null;
                    try { return p.render(ctx, el, item, extras); }
                    finally { writeRevision = null; }
                },
                renderFromCache: p.renderFromCache
                    ? (el, itemId) => p.renderFromCache(ctx, el, itemId)
                    : undefined,
                renderFromServerCache: p.renderFromServerCache
                    ? (el, entry, itemId) => p.renderFromServerCache(ctx, el, entry, itemId)
                    : undefined,
                onServerCacheRefresh: (updatedIds, info) => {
                    invalidateFallback(updatedIds);
                    p.onServerCacheRefresh?.(ctx, updatedIds, info);
                },
                cleanup: p.cleanup ? () => p.cleanup(ctx) : undefined,
                isEnabled: () => !!JE.currentSettings?.[spec.settingKey],
                needsFirstEpisode: !!p.needsFirstEpisode,
                needsParentSeries: !!p.needsParentSeries,
                needsLatestEpisode: !!p.needsLatestEpisode,
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
            spec.pipeline?.cleanup?.(ctx);

            // Settings (positions, layout) may have changed: re-read them, and
            // drop this group's masters and every representation built from them.
            const layout = layoutFor(name);
            if (layout) {
                layout.invalidateSettings();
                layout.removeGroupEverywhere(name);
            }
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

    /**
     * Make a group's base styles available without activating its renderer,
     * caches, session hooks or network work. Called when its module loads.
     * @param {TagSpec} spec
     */
    function registerStyles(spec) {
        styleSpecs.set(spec.settingKey, spec);
    }

    /**
     * Load missing base sheets for the groups this preview's document enables.
     * Existing sheets stay intact; previewing never reinitializes real cards.
     * @param {Object} settings - The preview source's effective group switches.
     * @param {object} owner - The preview borrowing these sheets.
     */
    function ensureStyles(settings, owner) {
        for (const [key, spec] of styleSpecs) {
            if (!settings?.[key] || !spec.styleId) continue;
            const existing = document.getElementById(spec.styleId);
            if (existing) {
                previewStyles.get(existing)?.add(owner);
                continue;
            }
            if (typeof spec.buildCss !== 'function') continue;
            const css = spec.buildCss();
            JE.core.ui.injectCss(spec.styleId, JE.core.tagLayout?.preserveLegacySizing?.(css) || css);
            const sheet = document.getElementById(spec.styleId);
            if (sheet) {
                sheet.dataset.jeTagPreviewOwned = '';
                previewStyles.set(sheet, new Set([owner]));
            }
        }
    }

    /** Release only sheets still owned exclusively by previews. @param {object} owner */
    function releaseStyles(owner) {
        for (const [sheet, owners] of previewStyles) {
            if (!owners.delete(owner) || owners.size) continue;
            sheet.remove();
            previewStyles.delete(sheet);
        }
    }

    JE.core.tagRenderer = {
        registerStyles,
        ensureStyles,
        releaseStyles,
        register,
        reinitialize,
        resolvePosition,
        isIgnoredContext,
        applyCornerStacking,
        scheduleCornerStacking,
    };

    console.log('🪼 Jellyfin Enhanced: Tag renderer core initialized');

})(window.JellyfinEnhanced);
