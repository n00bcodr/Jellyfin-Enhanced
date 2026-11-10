import type { RenderExtras } from './contract';
import { idText, isRecord, type JsonRecord, memberRecord, members, normalizeItemId, record } from './dto';
import { isMediaType, logPrefix, type PipelineFns, type PipelineState, type QueuedCard } from './state';
import type { TagRuntimeBridge } from './tag-pipeline';

const FETCH_DEBOUNCE_MS = 150; // Debounce only the batch API call, not the scan
// Separate, much larger threshold for yielding during batch render (see processBatch).
const RENDER_YIELD_CHUNK = 40;
// ── Queue Processing ───────────────────────────────────────────────

const SERVER_BATCH_LIMIT = 200;

/**
 * The fetch queue: debounced scheduling and the batched /tag-data requests that render queued cards.
 * @param s - The pipeline's shared mutable state (state.ts).
 * @param JE - The tag runtime bridge.
 * @param deps - The other pipeline modules' functions, filled in by createTagPipeline before any of them runs.
 */
export function createQueue(s: PipelineState, JE: TagRuntimeBridge, deps: PipelineFns) {
    /**
     * Debounce a drain of the request queue. No-op while a drain is running:
     * that drain picks the queued cards up itself, or, when it was cancelled
     * by a generation bump, schedules the next one as it exits.
     * */
    function scheduleFetch(): void {
        if (s.requestQueue.length === 0 || s.isProcessing) return;
        if (s.fetchTimer) clearTimeout(s.fetchTimer);
        s.fetchTimer = setTimeout(() => {
            s.fetchTimer = null;
            processQueue();
        }, FETCH_DEBOUNCE_MS);
    }


    /**
     * Drain the request queue in SERVER_BATCH_LIMIT-sized chunks.
     * */
    async function processQueue(): Promise<void> {
        if (s.isProcessing || s.requestQueue.length === 0) return;
        s.isProcessing = true;
        let cancel: () => void = () => {};
        const cancelled = new Promise<void>(resolve => { cancel = resolve; });
        s.cancelBatchWait = cancel;

        try {
            const myGeneration = s.batchGeneration;

            // Chunk into batches of SERVER_BATCH_LIMIT to avoid 400 errors
            while (s.requestQueue.length > 0) {
                if (myGeneration !== s.batchGeneration) break; // navigation happened
                const batch = s.requestQueue.splice(0, SERVER_BATCH_LIMIT)
                    // Drop cards removed from the DOM since they were queued (e.g. a
                    // page like search re-renders its whole result set on every
                    // keystroke, on the same generation). Skipping them here avoids
                    // fetching and rendering tag data nobody will ever see.
                    .filter((entry) => entry.el.isConnected);
                if (batch.length === 0) continue;
                s.activeBatch = batch;
                // The transport can finish in the background, but a retired
                // generation must not hold fresh guard/user work behind it.
                // processBatch checks its generation after every await and before writes.
                await Promise.race([processBatch(batch, myGeneration), cancelled]);
                if (myGeneration !== s.batchGeneration) break;
                s.activeBatch = [];
                // Cards still waiting for item data the batch didn't bring
                // (failed, or no such item) show their tags without it.
                for (const entry of batch) {
                    if (entry.awaiting) JE.core.tagLayout?.releaseCardContext?.(entry.renderTarget, entry.awaiting);
                }
            }
        } finally {
            if (s.cancelBatchWait === cancel) s.cancelBatchWait = null;
            s.activeBatch = [];
            s.isProcessing = false;
            // Cancelled by a generation bump (a reinitialize or navigation
            // while a batch was in flight): the scan that followed queued its
            // cache misses but could not start a drain while this one ran.
            scheduleFetch();
        }
    }


    /**
     * Fetch item data for a batch of cards and fan out to all enabled renderers.
     * @param batch - Queued card entries.
     * @param generation - Batch generation counter to detect stale navigations.
     * */
    async function processBatch(batch: QueuedCard[], generation: number): Promise<void> {
        const userId = deps.apiClient().getCurrentUserId();
        if (!userId) return;
        const epoch = JE.session?.getEpoch?.();
        /** @returns This batch still belongs to the active navigation and session. */
        const isCurrent = (): boolean => generation === s.batchGeneration
            && userId === deps.apiClient().getCurrentUserId() && epoch === JE.session?.getEpoch?.();

        // Use arrays per ID to handle duplicate items (same movie in multiple rows)
        const elMap = new Map<string, QueuedCard[]>();
        for (const b of batch) {
            const sameItem = elMap.get(b.itemId);
            if (sameItem) sameItem.push(b);
            else elMap.set(b.itemId, [b]);
        }
        const ids = [...elMap.keys()];

        // Series/Season "latest episode added" costs the server a query per
        // container, so it is only asked for when an enabled renderer reads it.
        let needsLatestEpisode = false;
        for (const [, r] of s.renderers) {
            if (r.isEnabled() && r.needsLatestEpisode) { needsLatestEpisode = true; break; }
        }

        try {
            // Single API call for ALL cache-miss items via POST (no URL length limit)
            const response = record(await deps.apiClient().ajax({
                type: 'POST',
                url: deps.apiClient().getUrl(`/JellyfinEnhanced/tag-data/${userId}`, needsLatestEpisode ? { latestEpisode: true } : undefined),
                data: JSON.stringify(ids),
                contentType: 'application/json',
                dataType: 'json'
            }));

            const answered = members(response.Items);

            // Abort if navigation happened while we were waiting for the API response
            if (!isCurrent()) return;
            if (needsLatestEpisode) answered.forEach(item => deps.rememberItemFacts(memberRecord(item)));
            const items = answered.map(memberRecord);
            const stripRevision = typeof response.StripRevision === 'string' ? response.StripRevision : null;
            s.tagStripRevision = stripRevision;

            // Build parent series lookup for rating fallback
            const parentSeriesNeeded = new Set<string>();
            for (const item of items) {
                const seriesId = idText(item.SeriesId);
                if ((item.Type === 'Season' || item.Type === 'Episode') && seriesId &&
                    !item.CommunityRating && !item.CriticRating) {
                    parentSeriesNeeded.add(seriesId);
                }
                // Genre also needs parent series for Season items
                if (item.Type === 'Season' && seriesId) {
                    parentSeriesNeeded.add(seriesId);
                }
            }

            // Batch-fetch any parent series items we need (these are likely already in the same response)
            const parentSeriesMap = new Map<string, JsonRecord>();
            for (const item of items) {
                // An item without an id fails the batch here: nothing in it could be matched to a card.
                if (item.Id === undefined || item.Id === null) throw new TypeError('A tag-data item has no id');
                parentSeriesMap.set(normalizeItemId(item.Id), item);
            }
            // For parent series not in this batch, fetch individually
            for (const seriesId of parentSeriesNeeded) {
                const normalizedId = normalizeItemId(seriesId);
                if (!parentSeriesMap.has(normalizedId)) {
                    try {
                        const parent = await deps.getParentSeries(userId, seriesId);
                        if (!isCurrent()) return;
                        if (parent) parentSeriesMap.set(normalizedId, parent);
                    } catch {}
                }
            }

            // Render each item as soon as its data is ready.
            // Items that DON'T need first-episode data (Movies, Episodes) render immediately.
            // Items that DO (Series, Season) render after their first-episode fetch completes.
            // This way a slow first-episode lookup doesn't block everything else.

            // Hosts rendered since the last corner-stacking pass: measured once
            // per yield chunk (below) rather than once per card.
            let pendingHosts: HTMLElement[] = [];
            const stackPendingHosts = () => {
                if (pendingHosts.length === 0) return;
                JE.core.tagRenderer.applyCornerStacking(pendingHosts);
                pendingHosts = [];
            };

            const renderItem = (item: JsonRecord, firstEpisode: JsonRecord | null): void => {
                // Re-check per render: first-episode/parent-series awaits can
                // span a navigation OR a user switch (clearProcessed bumps the
                // generation) — stale data must not be rendered or persisted.
                if (!isCurrent()) return;
                const itemId = normalizeItemId(item.Id);
                const batchEntries = elMap.get(itemId);
                if (!batchEntries || batchEntries.length === 0) return;
                if (!isMediaType(item.Type)) return;
                deps.rememberLookFacts(itemId, item);

                let parentSeries: JsonRecord | null = null;
                let ratingParentSeries: JsonRecord | null = null;
                if (item.SeriesId) {
                    const parentId = normalizeItemId(item.SeriesId);
                    parentSeries = parentSeriesMap.get(parentId) || null;
                    if ((item.Type === 'Season' || item.Type === 'Episode') &&
                        !item.CommunityRating && !item.CriticRating) {
                        ratingParentSeries = parentSeries;
                    }
                }

                // Render to ALL cards with this ID (same item can appear in multiple rows)
                for (const entry of batchEntries) {
                    let { el, renderTarget } = entry;
                    if (!deps.stillShows(entry)) continue; // the card now shows another item
                    // The queued renderTarget can go stale between scan and render
                    // (Series/Season wait on a first-episode fetch first, giving
                    // Jellyfin time to rebuild the card's subtree). Re-resolve from
                    // the still-tracked card element rather than dropping the tag —
                    // resolveRenderTarget is a couple of cheap DOM queries, not a fetch.
                    if (!renderTarget.isConnected) {
                        if (!el.isConnected) continue; // card itself is gone
                        renderTarget = deps.resolveRenderTarget(el);
                    }
                    const extras: RenderExtras = { firstEpisode, parentSeries, ratingParentSeries, renderTarget, stripRevision };
                    // Dropped by the layout when the card shows another item by now.
                    if (JE.core.tagLayout?.setCardContext?.(renderTarget, item, itemId, entry.cardId) === false) continue;
                    for (const [name, renderer] of s.renderers) {
                        if (!renderer.isEnabled()) continue;
                        try {
                            renderer.render(renderTarget, item, extras);
                        } catch (err) {
                            console.warn(`${logPrefix} Renderer "${name}" failed for item ${itemId}:`, err);
                        }
                    }
                    pendingHosts.push(renderTarget);
                }
            };

            // Check if ANY enabled renderer actually needs first-episode data
            let anyNeedsFirstEp = false;
            for (const [, r] of s.renderers) {
                if (r.isEnabled() && r.needsFirstEpisode) { anyNeedsFirstEp = true; break; }
            }

            // Process all items: render immediately what we can, fetch first episodes in parallel.
            // Yield every RENDER_YIELD_CHUNK items so a large batch (e.g. a
            // broad search) can't block the main thread in one long synchronous stretch.
            const pendingFirstEps: Promise<void>[] = [];
            let renderedSinceYield = 0;
            for (const item of items) {
                const firstEpisode = isRecord(item.FirstEpisode) ? item.FirstEpisode : null;
                if (anyNeedsFirstEp && firstEpisode?.NeedsStreamFetch) {
                    // Series/Season: fetch first episode in background, render when ready.
                    // These land one at a time, so their hosts are stacked in one
                    // batched frame rather than measured individually.
                    pendingFirstEps.push(
                        deps.getFirstEpisode(userId, String(item.Id), idText(firstEpisode.Id))
                            .then(ep => renderItem(item, ep))
                            .catch(() => renderItem(item, null))
                            .then(() => {
                                for (const host of pendingHosts) JE.core.tagRenderer.scheduleCornerStacking(host);
                                pendingHosts = [];
                            })
                    );
                } else {
                    // Movies, Episodes, etc: render immediately (no extra fetch needed)
                    renderItem(item, firstEpisode);
                    if (++renderedSinceYield >= RENDER_YIELD_CHUNK) {
                        renderedSinceYield = 0;
                        stackPendingHosts();
                        await deps.idleYield();
                        if (!isCurrent()) return; // navigation or user switch while yielded
                    }
                }
            }
            stackPendingHosts();

            // Wait for all first-episode renders to complete before marking batch done
            if (pendingFirstEps.length > 0) {
                await Promise.all(pendingFirstEps);
            }
        } catch (err) {
            if (!isCurrent()) return;
            console.warn(`${logPrefix} Batch fetch failed, falling back to individual fetches:`, err);
            // Fallback: process items individually
            for (const queued of batch) {
                const { el, renderTarget: queuedRenderTarget, itemId, cardId } = queued;
                if (!isCurrent()) break; // navigation or user switch
                try {
                    const item = JE.helpers?.getItemCached
                        ? await JE.helpers.getItemCached(itemId, { userId })
                        : await deps.apiClient().getItem(userId, itemId);
                    if (!isCurrent()) return;
                    if (!isRecord(item) || !isMediaType(item.Type)) continue;
                    deps.rememberLookFacts(itemId, item, 'item');

                    const firstEpisode = (item.Type === 'Series' || item.Type === 'Season')
                        ? await deps.getFirstEpisode(userId, String(item.Id)) : null;
                    if (!isCurrent()) break; // switched during the awaits above
                    if (!deps.stillShows(queued)) continue; // the card now shows another item
                    let renderTarget = queuedRenderTarget;
                    if (!renderTarget.isConnected) {
                        if (!el.isConnected) continue; // card itself is gone
                        renderTarget = deps.resolveRenderTarget(el);
                    }
                    const extras: RenderExtras = { firstEpisode, parentSeries: null, ratingParentSeries: null, renderTarget, stripRevision: null };
                    const layout = JE.core.tagLayout;
                    if (layout?.cardIdentity && layout.cardIdentity(renderTarget) !== cardId) continue;
                    if (!deps.needsLibraryFacts() && layout?.setCardContext?.(renderTarget, item, itemId, cardId) === false) continue;

                    for (const [, renderer] of s.renderers) {
                        if (!renderer.isEnabled()) continue;
                        try { renderer.render(renderTarget, item, extras); } catch {}
                    }
                    JE.core.tagRenderer.applyCornerStacking(renderTarget);
                } catch {}
            }
        }
    }

    return { scheduleFetch };
}
