import { apiClient, hasApiClient, type TagRuntimeBridge } from '../host';
import { finite, isRecord, text as nonEmptyText } from './dto';
import type { PipelineRendererConfig, RendererApi, ResolvedPosition, TagCtx, TagHot, TagSpec } from './contract';
import { createSettingsMatrix, createTagScopes } from './scopes';

/** The shared envelope around every fallback copy. */
interface FallbackEntry { v: number; stripRevision: string; payload: unknown; timestamp: number }
interface TagInstance { ctx: TagCtx; initialize(): void; reinitialize(): void }
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
function isHostList(value: HTMLElement | readonly HTMLElement[]): value is readonly HTMLElement[] { return Array.isArray(value); }

export function createTagRenderer(JE: TagRuntimeBridge) {

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

    /** name → tag instance */
    const tags = new Map<string, TagInstance>();

    /** Base styles available even when a renderer is disabled. */
    const styleSpecs: Map<string, TagSpec> = new Map();

    /** Sheets borrowed only by live previews. */
    const previewStyles = new Map<HTMLElement, Set<object>>();

    /** STANDARD_IGNORE_SELECTORS (+ search page) joined, per DisableTagsOnSearchPage */
    let standardIgnoreSelector: string|null = null;
    let standardIgnoreSearch: boolean | null = null;

    /**
     * Whether a card sits in a context that never shows poster tags (the
     * standard exclusions every renderer but genre uses, plus the search page
     * when DisableTagsOnSearchPage is set). The layout controller asks before
     * reserving caption space for a card no renderer will tag.
     * @param el - A render target or anything inside the card.
     * */
    function isIgnoredContext(el: HTMLElement | null | undefined): boolean {
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
     * @param name - Pipeline renderer name.
     * */
    function layoutFor(name: string) {
        const layout = JE.core.tagLayout;
        return layout && layout.normalizeGroup(name) ? layout : null;
    }

    /**
     * Resolve a tag position setting (user → admin default → hardcoded) into
     * the CSS placement values every tag stylesheet derives from it.
     * @param userKey - Key on JE.currentSettings (e.g. 'genreTagsPosition').
     * @param pluginKey - Key on JE.pluginConfig (e.g. 'GenreTagsPosition').
     * @param fallback - Hardcoded default (e.g. 'top-right').
     * */
    function resolvePosition(userKey: string, pluginKey: string, fallback: string): ResolvedPosition {
        const configured = JE.currentSettings?.[userKey] || JE.pluginConfig?.[pluginKey] || fallback;
        const pos = typeof configured === 'string' ? configured : fallback;
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
     * @param camel - e.g. 'jeGenreTagged'
     * @returns e.g. 'je-genre-tagged'
     */
    function toKebab(camel: string): string {
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
     * @param hostOrHosts - The .je-tag-host element(s).
     */
    function applyCornerStacking(hostOrHosts: HTMLElement | readonly HTMLElement[]) {
        const hosts: readonly (HTMLElement | null | undefined)[] = isHostList(hostOrHosts) ? hostOrHosts : [hostOrHosts];
        /** corners with more than one occupant */
        const stacks: Array<{isTop: boolean, items: HTMLElement[]}> = [];
        for (const host of hosts) {
            if (!host) continue;
            const groups = new Map<string, HTMLElement[]>();
            for (const child of host.children) {
                if (!(child instanceof HTMLElement)) continue;
                const corner = child.dataset.jeCorner;
                if (!corner) continue;
                const list = groups.get(corner);
                if (list) list.push(child);
                else groups.set(corner, [child]);
            }
            for (const [corner, items] of groups) {
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
            let boundary: number | null = null; // trailing edge of the previous item, in viewport coords
            items.forEach((el, i) => {
                const rect = rects[s]?.[i];
                if (!rect) return;
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

    /** hosts waiting for the next batched stacking pass */
    const pendingStackHosts: Set<HTMLElement> = new Set();
    let stackFrame = 0;

    /**
     * Corner-stack a host in the next animation frame, together with every
     * other host queued by then. For overlays that land outside the
     * pipeline's own render slices (the user review chip arrives after an
     * async lookup): measuring each card as its chip arrives would force a
     * layout per card.
     * @param host - The .je-tag-host element.
     */
    function scheduleCornerStacking(host: HTMLElement | null | undefined) {
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

    /** render target → its .card, looked up once */
    const cardByEl: WeakMap<HTMLElement, HTMLElement|null> = new WeakMap();

    /**
     * The .card containing el, memoised per element (a render target never
     * moves to another card). Every renderer's tagged checks go through here
     * instead of walking up from the same element several times per card.
     * */
    function cardOf(el: HTMLElement): HTMLElement|null {
        let card = cardByEl.get(el);
        if (card === undefined) {
            card = el.closest('.card');
            cardByEl.set(el, card);
        }
        return card;
    }

    /**
     * Build a tag instance (state + ctx + lifecycle) for one renderer.
     * @param name - Pipeline renderer name (e.g. 'genre').
     */
    function createTag(name: string, spec: TagSpec) {
        const logPrefix = spec.logPrefix;
        const containerClass = spec.containerClass;
        const TAGGED_ATTR = spec.taggedAttr;

        const state: {
            cache: Record<string, unknown>;
            hot: Map<string, unknown> | null;
            localStorageEnabled: boolean;
            cacheTtl: number;
            ignoreSelectors: string[] | null;
            ignoreSelector: string | null;
            saveRegistered: boolean;
            unloadRegistered: boolean;
        } = {
            // Persistent (localStorage-backed) cache.
            cache: {},
            // Shared hot cache bucket.
            hot: null,
            localStorageEnabled: false,
            cacheTtl: (30) * 24 * 60 * 60 * 1000,
            ignoreSelectors: null,
            // ignoreSelectors joined into one selector list.
            ignoreSelector: null,
            saveRegistered: false,
            unloadRegistered: false,
        };

        // Only the accepted /tag-data callback can authorize a fallback write. Never
        // label /Items, IndexedDB or server-cache projections with mutable page state.
        let writeRevision: string | null = null;
        const ENVELOPE_VERSION = 1;
        function revision(): string | null {
            try {
                return nonEmptyText(JE.tagPipeline?.tagStripRevision?.());
            } catch { return null; }
        }
        function dirty() { JE._cacheManager?.markDirty(); }
        function discard(itemId: string): void {
            delete state.cache[itemId];
            state.hot?.delete(itemId);
            dirty();
        }
        function valid(entry: unknown, stamp: string): entry is FallbackEntry {
            if (!isRecord(entry) || entry.v !== ENVELOPE_VERSION || entry.stripRevision !== stamp
                || !Object.prototype.hasOwnProperty.call(entry, 'payload')) return false;
            const timestamp = finite(entry.timestamp);
            return timestamp !== null && Date.now() - timestamp < state.cacheTtl;
        }
        function readFallback(itemId: string, persistent: boolean): unknown {
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
        function writeFallback(itemId: string, payload: unknown, persistent: boolean): void {
            if (writeRevision === null || !spec.cache) return;
            const entry: FallbackEntry = { v: ENVELOPE_VERSION, stripRevision: writeRevision, payload,
                timestamp: (isRecord(payload) ? finite(payload.timestamp) : null) ?? Date.now() };
            // Every persistent write also has a page-local copy, including empty facts.
            if (state.hot) state.hot.set(itemId, entry);
            if (writeRevision === 'none' && persistent) state.cache[itemId] = entry;
            else if (writeRevision !== 'none') delete state.cache[itemId];
            dirty();
        }
        // Preserve the module-facing Map vocabulary, but never expose raw hot entries.
        const hot: TagHot = {
            get: itemId => readFallback(itemId, false),
            set(itemId, payload) { writeFallback(itemId, payload, false); return hot; },
            delete(itemId) { discard(itemId); return true; },
            clear() { state.hot?.clear(); },
            get size() { return state.hot?.size || 0; },
        };
        function invalidateFallback(updatedIds: readonly string[] | null): void {
            if (!updatedIds) { state.cache = {}; state.hot?.clear(); dirty(); }
            else for (const id of updatedIds) discard(String(id));
        }

        // ── Ignore / tagged helpers ────────────────────────────────────
        function buildIgnoreSelectors(): string[] {
            const list = [...(spec.ignoreSelectors || STANDARD_IGNORE_SELECTORS)];
            if (JE.pluginConfig?.DisableTagsOnSearchPage === true) {
                list.push(spec.searchPageIgnoreSelector || '#searchPage .cardImageContainer');
            }
            return list;
        }

        /**
         * */
        function defaultShouldIgnore(el: HTMLElement): boolean {
            const selectors = state.ignoreSelectors ??= buildIgnoreSelectors();
            const selector = state.ignoreSelector ??= selectors.join(', ');
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
                return target.closest(selector) !== null;
            } catch {
                // One unsupported selector rejects the whole list: fall back to
                // checking them one by one and skipping the bad one.
                return selectors.some((selector) => {
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
         * */
        function shouldIgnore(el: HTMLElement): boolean {
            return spec.shouldIgnore
                ? !!spec.shouldIgnore(el, defaultShouldIgnore)
                : defaultShouldIgnore(el);
        }

        /**
         * Check whether the card containing el already carries this overlay.
         * */
        function isTagged(el: HTMLElement): boolean {
            const card = cardOf(el);
            if (!card) return false;
            // Attribute first: the common case (this renderer hasn't tagged the
            // card yet) then costs a dataset read, not a subtree query.
            if (card.dataset?.[TAGGED_ATTR] !== '1') return false;
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
         */
        function markTagged(el: HTMLElement) {
            const card = cardOf(el);
            if (card) card.dataset[TAGGED_ATTR] = '1';
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
                    || (hasApiClient() ? apiClient().getCurrentUserId?.() : null) || '';
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
            state.cacheTtl = Number(JE.pluginConfig?.TagsCacheTtlDays || 30) * 24 * 60 * 60 * 1000;
            if (!spec.cache) return;
            enforceCacheOwnership();
            state.cache = {};
            if (state.localStorageEnabled) {
                try {
                    const cached = JSON.parse(localStorage.getItem(spec.cache.key) || '{}');
                    // Persisted data is an item-id dictionary. Corrupt or obsolete
                    // payloads must not prevent the renderer from registering.
                    if (isRecord(cached)) state.cache = { ...cached };
                } catch (e) {
                    console.warn(`${logPrefix} Ignoring unreadable tag cache`, e);
                }
            }
            if (spec.cache.hotBucket) {
                const Hot = (JE._hotCache = JE._hotCache || { ttl: state.cacheTtl });
                const bucket = Hot[spec.cache.hotBucket];
                const shared = typeof bucket === 'object' ? bucket : new Map<string, unknown>();
                Hot[spec.cache.hotBucket] = shared;
                state.hot = shared;
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
            const legacyStems = typeof spec.cache.legacyPrefix === 'string'
                ? [spec.cache.legacyPrefix]
                : spec.cache.legacyPrefix;

            const stale: string[] = [];
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

            const serverClearTimestamp = Number(JE.pluginConfig?.ClearLocalStorageTimestamp || 0);
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

        const ctx: TagCtx = {
            name,
            logPrefix,
            containerClass,
            taggedAttr: TAGGED_ATTR,
            /** @returns shared hot cache bucket */
            get hot() { return state.hot ? hot : null; },
            /** @returns cache TTL in ms */
            get cacheTtl() { return state.cacheTtl; },
            /** @returns whether localStorage fallback is active */
            get localStorageEnabled() { return state.localStorageEnabled; },
            /**
             * @returns the validated, module-defined payload
             */
            getPersistent(itemId: string): unknown { return readFallback(itemId, true); },
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
             */
            removeExistingOverlay(el: HTMLElement) {
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
             * @returns true if the overlay was attached
             */
            commitOverlay(el: HTMLElement, overlay: HTMLElement): boolean {
                const layout = layoutFor(name);
                // "Where to show": a group switched off for this card's type or home row is not drawn.
                if (name !== 'rating' && JE.core.tagScopes?.excludes(name, el)) {
                    if (layout) layout.removeGroup(el, name);
                    return false;
                }
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
            const { renderFromCache: fromCache, renderFromServerCache: fromServer, cleanup } = p;
            const config: PipelineRendererConfig = {
                render: (el, item, extras) => {
                    writeRevision = nonEmptyText(extras?.stripRevision);
                    try { return p.render(ctx, el, item, extras); }
                    finally { writeRevision = null; }
                },
                renderFromCache: fromCache ? (el, itemId) => fromCache.call(p, ctx, el, itemId) : undefined,
                renderFromServerCache: fromServer ? (el, entry, itemId) => fromServer.call(p, ctx, el, entry, itemId) : undefined,
                onServerCacheRefresh: (updatedIds, info) => {
                    invalidateFallback(updatedIds);
                    p.onServerCacheRefresh?.(ctx, updatedIds, info);
                },
                cleanup: cleanup ? () => cleanup.call(p, ctx) : undefined,
                isEnabled: () => !!JE.currentSettings?.[spec.settingKey],
                needsFirstEpisode: !!p.needsFirstEpisode,
                needsParentSeries: !!p.needsParentSeries,
                needsLatestEpisode: !!p.needsLatestEpisode,
                injectCss,
            };
            JE.tagPipeline.registerRenderer(name, config);
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
            document.querySelectorAll<HTMLElement>(`[data-${toKebab(TAGGED_ATTR)}]`).forEach((el) => {
                delete el.dataset[TAGGED_ATTR];
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
     */
    function getOrCreate(name: string, spec: TagSpec | undefined): TagInstance {
        let tag = tags.get(name);
        if (!tag) {
            if (!spec) throw new TypeError(`Tag renderer ${name} needs a spec`);
            tag = createTag(name, spec);
            tags.set(name, tag);
        }
        return tag;
    }

    /**
     * Register (or re-register) a tag renderer described by spec.
     * Called from each tag module's JE.initializeXTags.
     * @param name - Pipeline renderer name.
     * @returns the ctx handle (also passed to spec callbacks)
     */
    function register(name: string, spec: TagSpec): TagCtx {
        const tag = getOrCreate(name, spec);
        tag.initialize();
        return tag.ctx;
    }

    /**
     * Run the standard reinitialize sequence for a tag. Works even when the
     * tag was never registered (feature disabled at boot): cleanup and CSS
     * injection fall back to the spec.
     * @param name - Pipeline renderer name.
     */
    function reinitialize(name: string, spec?: TagSpec): void {
        // Nothing to redraw for a renderer that never registered (its group is off).
        if (!spec && !tags.has(name)) return;
        getOrCreate(name, spec).reinitialize();
    }

    /**
     * Make a group's base styles available without activating its renderer,
     * caches, session hooks or network work. Called when its module loads.
     */
    function registerStyles(spec: TagSpec) {
        styleSpecs.set(spec.settingKey, spec);
    }

    /**
     * Load missing base sheets for the groups this preview's document enables.
     * Existing sheets stay intact; previewing never reinitializes real cards.
     * @param settings - The preview source's effective group switches.
     * @param owner - The preview borrowing these sheets.
     */
    function ensureStyles(settings: unknown, owner: object): void {
        for (const [key, spec] of styleSpecs) {
            if (!isRecord(settings) || !settings[key] || !spec.styleId) continue;
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
    function releaseStyles(owner: object): void {
        for (const [sheet, owners] of previewStyles) {
            if (!owners.delete(owner) || owners.size) continue;
            sheet.remove();
            previewStyles.delete(sheet);
        }
    }

    /**
     * Shared quality/language chip box, including responsive fallback and card-width metrics.
     * @param selector Internal chip selector.
     * @param [code=false] Tight padding for a two/three-letter language code.
     * @returns Base CSS; group colours are layered on by the renderers and Tag Styles.
     */
    function chipBaseCss(selector: string, code: boolean = false): string {
        const css = `
                ${selector} {
                    font-weight: bold;
                    border-radius: 5px;
                    padding: calc(2px * var(--je-tag-scale, 1)) calc(${code ? 4 : 10}px * var(--je-tag-scale, 1));
                    font-size: calc(clamp(0.65rem, 2vw, 0.85rem) * var(--je-tag-scale, 1));
                    user-select: none;
                    pointer-events: none;
                    font-variant-caps: small-caps;
                    box-shadow: 0 1px 4px rgba(0,0,0,0.4);
                    border: 1px solid rgba(255,255,255,0.15);
                    /* backdrop-filter removed — blur causes jank during hover animations */
                    opacity: 1;
                    transform: translateY(0);
                    white-space: nowrap;
                    flex-shrink: 0;
                    line-height: 1.2;
                }
                .layout-mobile ${selector} {
                    padding: calc(0px * var(--je-tag-scale, 1)) calc(${code ? 3 : 6}px * var(--je-tag-scale, 1));
                    font-size: calc(0.65rem * var(--je-tag-scale, 1));
                    border-radius: 3px;
                }
                @media (min-width: 1440px) {
                ${selector} {
                        padding: calc(3px * var(--je-tag-scale, 1)) calc(${code ? 4 : 12}px * var(--je-tag-scale, 1));
                        font-size: calc(0.9rem * var(--je-tag-scale, 1));
                        border-radius: 6px;
                    }
                }
                @media (max-width: 768px) {
                ${selector} {
                        padding: calc(0px * var(--je-tag-scale, 1)) calc(${code ? 3 : 6}px * var(--je-tag-scale, 1));
                        font-size: calc(0.65rem * var(--je-tag-scale, 1));
                        border-radius: 3px;
                    }
                }
                @media (max-width: 480px) {
                ${selector} {
                        padding: calc(0px * var(--je-tag-scale, 1)) calc(${code ? 2 : 5}px * var(--je-tag-scale, 1));
                        font-size: calc(0.6rem * var(--je-tag-scale, 1));
                        border-radius: 2px;
                        box-shadow: 0 1px 3px rgba(0,0,0,0.4);
                    }
                }

                @supports (container-type: inline-size) {
                    html:not(.layout-mobile) .je-tag-host ${selector} {
                        font-size: calc(clamp(9px, 6.6cqw, 13.6px) * var(--je-tag-scale, 1));
                        padding: calc(clamp(0px, 0.6cqw, 2px) * var(--je-tag-scale, 1)) calc(clamp(${code ? 2 : 4}px, ${code ? 1.5 : 4.2}cqw, ${code ? 4 : 10}px) * var(--je-tag-scale, 1));
                        border-radius: calc(clamp(2px, 2.4cqw, 5px) * var(--je-tag-scale, 1));
                    }
                }
        `;
        // Code selectors are more specific than the shared chip selector. Only
        // override padding, so they cannot reset partial opacity or preset paint.
        return code ? css.replace(/([^{}]+)\{([^{}]*)\}/g, (_, rule: string, body: string) => {
            const padding = body.split(';').filter(declaration => /^\s*padding\s*:/.test(declaration)).join(';');
            return `${rule}{${padding};}`;
        }) : css;
    }

    JE.core.tagSettingsMatrix = createSettingsMatrix((name) => {
        const layout = JE.core.tagLayout;
        const group = layout?.normalizeGroup(name);
        return group ? layout?.singleChipGroup?.(group) ?? false : false;
    });
    JE.core.tagScopes = createTagScopes({
        settings: () => JE.currentSettings,
        plugin: () => JE.pluginConfig,
        detectRow: () => (typeof JE.detectCardRowSurface === 'function' ? JE.detectCardRowSurface : null),
    });
    const tagRenderer: RendererApi = {
        chipBaseCss,
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
    JE.core.tagRenderer = tagRenderer;

    console.log('🪼 Jellyfin Enhanced: Tag renderer core initialized');
}
