import type { JsonRecord } from './dto';
import { type CardWait, isMediaType, type PipelineFns, type PipelineState, type ScannedCard } from './state';
import type { TagRuntimeBridge } from './tag-pipeline';

// Cards per idle slice are sized from the measured render cost so a slice
// stays around CHUNK_BUDGET_MS on this device: a fast desktop renders
// dozens per slice, a slow phone a handful. The first slice assumes the
// pre-measurement cost.
const CHUNK_BUDGET_MS = 8;
const CHUNK_MIN_CARDS = 4;
const CHUNK_MAX_CARDS = 40;
/** Card images whose item id lives on an ancestor's data-id / data-itemid. */
const CARD_IMAGE_SELECTOR = '.cardImageContainer, div.listItemImage';

/**
 * Card scanning and rendering: idle scheduling, the scan loop, render targets and card identity.
 * @param s - The pipeline's shared mutable state (state.ts).
 * @param JE - The tag runtime bridge.
 * @param deps - The other pipeline modules' functions, filled in by createTagPipeline before any of them runs.
 */
export function createScan(s: PipelineState, JE: TagRuntimeBridge, deps: PipelineFns) {
    /**
     * Schedule scan. Coalesces multiple mutations into a single scan start.
     */
    // Use requestIdleCallback for all tag work so it never competes with
    // user interactions (hover, scroll, click). Falls back to setTimeout
    // for browsers without requestIdleCallback support.
    const scheduleIdle = typeof requestIdleCallback === 'function'
        ? (fn: () => void) => requestIdleCallback(fn, { timeout: 500 })
        : (fn: () => void) => setTimeout(fn, 16);


    /**
     * Resolves on the next idle slot. Used to break up long synchronous
     * render loops (e.g. a batch fetch response covering many search
     * results) so they don't block the main thread in one tick.
     * */
    function idleYield(): Promise<void> {
        return new Promise((resolve) => scheduleIdle(resolve));
    }


    function scheduleScan() {
        if (s.scanScheduled) return;
        s.scanScheduled = true;
        scheduleIdle(() => {
            s.scanScheduled = false;
            runScan();
        });
    }


    /**
     * Fold a measured per-card render cost into the running estimate that
     * sizes the next slice.
     */
    function recordRenderCost(elapsedMs: number, cards: number) {
        if (cards <= 0) return;
        s.msPerCard = s.msPerCard * 0.5 + (elapsedMs / cards) * 0.5;
    }


    /**
     * Render one classified card from its server entry, or from the local
     * caches with a batch-fetch fallback. The host is collected for one
     * corner-stacking pass over the whole slice instead of a layout per card.
     */
    function renderCard(card: ScannedCard, serverEntry: JsonRecord | undefined, hosts: HTMLElement[]): void {
        const { el, itemId, itemType } = card;
        const renderTarget = resolveRenderTarget(el);
        const layout = JE.core.tagLayout;
        // Tag look rules match on the item data (library, genres, age
        // rating, series): the server entry, else what an earlier fetch
        // said. Without either, a card a rule or lock could restyle waits
        // for the batch fetch below before showing its tags.
        const cardId = layout?.cardIdentity?.(renderTarget) ?? '';
        const remembered = deps.lookFactsMap().get(itemId);
        const known = serverEntry || (!deps.needsLibraryFacts() || deps.enrichedLookFacts(remembered) ? remembered : null);
        let awaiting: CardWait = false;
        if (known) layout?.setCardContext?.(renderTarget, known, itemId, cardId);
        else awaiting = layout?.awaitCardContext?.(renderTarget, cardId, itemType);
        // Caption layout: reserve the strip below the image now, before the
        // tag data (possibly a batch fetch away) arrives.
        JE.core.tagLayout?.prepareCard(renderTarget);

        // Server cache first (all tag data pre-computed in one object)
        if (serverEntry) {
            for (const [, renderer] of s.renderers) {
                if (!renderer.isEnabled()) continue;
                if (renderer.renderFromServerCache) {
                    try { renderer.renderFromServerCache(renderTarget, serverEntry, itemId); } catch {}
                }
            }
            hosts.push(renderTarget);
            return; // Fully rendered from server cache, skip queue
        }

        // Fall back to localStorage/hot cache, then batch fetch for misses
        let allCacheHits = true;
        for (const [, renderer] of s.renderers) {
            if (!renderer.isEnabled()) continue;
            if (renderer.renderFromCache) {
                if (!renderer.renderFromCache(renderTarget, itemId)) allCacheHits = false;
            } else {
                allCacheHits = false;
            }
        }
        hosts.push(renderTarget);

        if (!allCacheHits || awaiting) {
            s.requestQueue.push({ el, renderTarget, itemId, itemType, cardId, awaiting, reuse: card.reuse });
        }
    }

    /**
     * Scan all unprocessed cards. Uses chunked processing to avoid jank:
     * each idle slice classifies a chunk of cards (cheap DOM reads), looks up
     * their server entries (synchronously from memory, or from the stored copy)
     * and renders them, then yields. A generation counter ensures stale chunk
     * chains from previous scans are cancelled when a new scan starts (e.g.,
     * rapid page changes); a chain cancelled while waiting for the stored copy
     * releases its cards so the newer scan picks them up.
     */
    function runScan() {
        // While a server-cache invalidation is in flight (after a Spoiler Guard
        // toggle), suppress concurrent scans so cards aren't processed against a
        // half-loaded cache and marked done before the fresh data arrives.
        if (s.isInvalidating) return;
        if (!deps.hasAnyEnabledRenderer()) return;
        if (!deps.hasApiClient()) return;

        const elements = document.querySelectorAll<HTMLElement>('.cardImageContainer, div.listItemImage');
        const unprocessed: HTMLElement[] = [];
        for (const el of elements) {
            if (!s.processedCards.has(el)) unprocessed.push(el);
            else JE.core.tagLayout?.resumePresentation?.(el.closest<HTMLElement>('.cardScalable') || el);
        }
        if (unprocessed.length === 0) return;

        // Cancel any in-progress chunk chain from a previous scan
        const myGeneration = ++s.scanGeneration;
        let index = 0;

        /** Continue with the next slice, or schedule the batch fetch once every card is done. */
        function continueScan() {
            if (index < unprocessed.length) {
                // More cards to process — yield and continue when browser is idle
                scheduleIdle(processChunk);
            } else {
                // All cards processed — schedule batch fetch for cache misses
                deps.scheduleFetch();
            }
        }

        /**
         * Render a classified chunk from the looked-up entries.
         */
        function renderChunk(chunk: ScannedCard[], entries: Map<string, JsonRecord>): void {
            const started = performance.now();
            const hosts: HTMLElement[] = [];
            for (const card of chunk) {
                // Gone since classification (page changed): release it in case
                // it comes back, exactly like a card skipped before marking.
                if (!card.el.isConnected) {
                    s.processedCards.delete(card.el);
                    continue;
                }
                // Reused for another item while its entry was looked up: it was
                // released then, and the next scan renders the new item.
                if (!stillShows(card)) continue;
                renderCard(card, entries.get(card.itemId), hosts);
            }
            // One coalesced layout pass for the slice instead of one per card.
            JE.core.tagRenderer.applyCornerStacking(hosts);
            recordRenderCost(performance.now() - started, chunk.length);
            continueScan();
        }

        function processChunk() {
            // Abort if a newer scan has started
            if (myGeneration !== s.scanGeneration) return;

            const limit = Math.max(CHUNK_MIN_CARDS, Math.min(CHUNK_MAX_CARDS, Math.floor(CHUNK_BUDGET_MS / Math.max(s.msPerCard, 0.05))));
            const chunk: ScannedCard[] = [];
            const ids: string[] = [];

            for (; index < unprocessed.length && chunk.length < limit; index++) {
                const el = unprocessed[index];
                if (!el || s.processedCards.has(el)) continue;
                // Skip elements no longer in the DOM (page changed)
                if (!el.isConnected) continue;

                const card = el.closest('.card');
                if (card && card.classList.contains('je-hidden')) continue;
                const listItem = el.closest('.listItem');
                if (listItem && listItem.classList.contains('je-hidden')) continue;

                // Skip contexts that should never have tags
                if (deps.shouldSkipElement(el)) {
                    s.processedCards.add(el);
                    continue;
                }

                const itemId = getItemId(el);
                if (!itemId) continue;

                const itemType = getItemType(el);
                if (itemType && !isMediaType(itemType)) {
                    s.processedCards.add(el);
                    continue;
                }

                s.processedCards.add(el);
                chunk.push({ el, itemId, itemType, reuse: s.cardReuse.get(el) || 0 });
                ids.push(itemId);
            }

            if (chunk.length === 0) {
                continueScan();
                return;
            }

            const lookup = deps.lookupServerEntries(ids);
            if (lookup instanceof Map) {
                renderChunk(chunk, lookup);
                return;
            }
            lookup.then((entries) => {
                if (myGeneration !== s.scanGeneration) {
                    // Superseded while waiting: release the cards and scan again.
                    // The newer scan took its snapshot while these were still
                    // marked processed, so it won't pick them up by itself.
                    // Cards since invalidated by reuse or metadata have a new owner.
                    for (const card of chunk) if (stillShows(card)) s.processedCards.delete(card.el);
                    scheduleScan();
                    return;
                }
                renderChunk(chunk, entries);
            });
        }

        processChunk();
    }


    /**
     * Resolves the element tags should render into for a given card: a
     * `.je-tag-host` div inserted before the card's hover-overlay container
     * (so Jellyfin's own overlay naturally covers tags in DOM order), falling
     * back to `.cardScalable` or the card element itself when no overlay
     * container exists. Never render into `.cardImageContainer` directly —
     * it triggers Jellyfin's lazy-load to reset opacity:0, breaking the image.
     * Cheap (a couple of DOM queries) and idempotent, so it's safe to call
     * again later to re-resolve a card whose subtree Jellyfin rebuilt.
     * @param el - Card image container element.
     * @returns The element to render tags into.
     */
    function resolveRenderTarget(el: HTMLElement): HTMLElement {
        const scalable = el.closest<HTMLElement>('.cardScalable');
        if (!scalable) return el;
        const overlay = scalable.querySelector('.cardOverlayContainer');
        if (!overlay) return scalable;
        let tagHost = scalable.querySelector<HTMLElement>('.je-tag-host');
        if (!tagHost) {
            tagHost = document.createElement('div');
            tagHost.className = 'je-tag-host';
            scalable.insertBefore(tagHost, overlay);
        }
        return tagHost;
    }


    /**
     * Whether a scanned or queued card still belongs to the item and metadata
     * it was scanned for (neither reuse nor a cache refresh invalidated it).
     * */
    function stillShows(card: {el: HTMLElement, reuse: number}): boolean {
        return (s.cardReuse.get(card.el) || 0) === card.reuse;
    }


    /**
     * The item id in an image URL (".../Items/<id>/Images/..."), or ''.
     * @param text - A style attribute or background-image value.
     * */
    function imageItemId(text: string | null | undefined): string {
        const match = text ? /Items\/([a-f0-9]{32})\//i.exec(text) : null;
        return match?.[1] ? match[1].toLowerCase() : '';
    }


    /**
     * Whether an attribute record says a card now shows another item: its
     * data-id / data-itemid changed, or the artwork of a card image or list
     * row image (a list row can be reused with only its artwork rewritten)
     * moved from one item's image to another's. The artwork's first load
     * (from no image) is not a change: the scan may have read the id from
     * data-id before it, and the artwork can name the series of an episode
     * card.
     * */
    function isIdentityChange(record: MutationRecord): boolean {
        const target = record.target;
        if (!(target instanceof Element) || !record.attributeName) return false;
        if (record.attributeName === 'style') {
            if (!target.matches(CARD_IMAGE_SELECTOR)) return false;
            const before = imageItemId(record.oldValue);
            const after = imageItemId(target.getAttribute('style'));
            return !!before && !!after && before !== after;
        }
        const norm = (value: string | null) => (value || '').replace(/-/g, '').toLowerCase();
        return norm(target.getAttribute(record.attributeName)) !== norm(record.oldValue);
    }


    /**
     * A virtualised list reuses a card for another item by rewriting it in
     * place: no node is added, so the body subscriber never hears of it and
     * the card stays processed with the previous item's tags. Release every
     * scanned card under a changed identity (its layout controller, slots,
     * caption outlet and review key go with it, and lookups still in flight
     * for it are dropped by stillShows), then scan again so the new item
     * renders.
     * @param mutations - Attribute records with old values.
     */
    function releaseReusedCards(mutations: MutationRecord[]) {
        let released = false;
        for (const record of mutations) {
            if (!isIdentityChange(record)) continue;
            const target = record.target;
            if (!(target instanceof HTMLElement)) continue;
            const images = target.matches(CARD_IMAGE_SELECTOR)
                ? [target]
                : Array.from(target.querySelectorAll<HTMLElement>(CARD_IMAGE_SELECTOR));
            for (const el of images) {
                const owner = el.closest<HTMLElement>('.cardScalable') || el;
                const hasHost = Array.from(owner.children).some((c) => c.classList.contains('je-tag-host'));
                if (!s.processedCards.has(el) && !hasHost) continue;
                s.processedCards.delete(el);
                s.cardReuse.set(el, (s.cardReuse.get(el) || 0) + 1);
                JE.core.tagLayout?.clearCard(owner);
                released = true;
            }
        }
        if (released) scheduleScan();
    }


    /**
     * Metadata updates invalidate both cached facts and the cards already drawn
     * from them. Releasing only affected cards keeps unrelated overlays intact;
     * advancing their reuse stamp also rejects an older batch still in flight.
     * A card whose item left the cache is released like an updated one: the
     * batch lookup, which enforces access, draws whatever the server still has
     * for it (an item in a library excluded from the tag cache keeps its tags).
     * @param updatedIds - null means the server cache was replaced.
     * @param hiddenIds - Items the user can no longer see: cleared, never looked up.
     */
    function refreshVisibleCards(updatedIds: readonly string[] | null = null, hiddenIds: readonly string[] = []): void {
        const changed = updatedIds ? new Set(updatedIds) : null;
        const hidden = new Set(hiddenIds);
        let released = false;
        for (const el of document.querySelectorAll<HTMLElement>(CARD_IMAGE_SELECTOR)) {
            const itemId = getItemId(el);
            if (!itemId || (changed && !changed.has(itemId))) continue;
            s.cardReuse.set(el, (s.cardReuse.get(el) || 0) + 1);
            JE.core.tagLayout?.clearCard(el.closest<HTMLElement>('.cardScalable') || el);
            if (hidden.has(itemId)) s.processedCards.add(el);
            else {
                s.processedCards.delete(el);
                released = true;
            }
        }
        if (released) scheduleScan();
    }


    /**
     * Extract the Jellyfin item ID from a card element.
     * @param el - Card image container element.
     * @returns The item ID or null if not found.
     */
    function getItemId(el: HTMLElement): string|null {
        // The card identifies the item; an episode can borrow a season or
        // series poster. Keep that identity stable as lazy artwork loads.
        const parent = el.closest('[data-id]') || el.closest('[data-itemid]');
        const attrId = parent?.getAttribute('data-id') || parent?.getAttribute('data-itemid');
        const itemId = attrId ? attrId.replace(/-/g, '').toLowerCase() : null;
        if (itemId && /^[a-f0-9]{32}$/.test(itemId)) return itemId;
        // Cards without a valid item attribute can still identify their artwork.
        return imageItemId(el.style?.backgroundImage) || itemId;
    }


    /**
     * Extract the item type from a card element's data-type attribute.
     * @param el - Card image container element.
     * @returns The item type or null if not found.
     */
    function getItemType(el: HTMLElement): string|null {
        const parent = el.closest('[data-type]');
        return parent?.getAttribute('data-type') || null;
    }

    return { idleYield, scheduleScan, runScan, resolveRenderTarget, stillShows, releaseReusedCards, refreshVisibleCards };
}
