import { type JsonRecord, memberRecord, members, normalizeItemId, record } from './dto';
import { MEMORY_SOFT_CAP, type PipelineFns, type PipelineState } from './state';
import type { TagRuntimeBridge } from './tag-pipeline';

const ITEM_FACTS_TTL_MS = 10 * 60 * 1000;

/**
 * Batch generations and the caller-filtered item facts /tag-data returned (Series/Season aggregates, kept for ITEM_FACTS_TTL_MS).
 * @param s - The pipeline's shared mutable state (state.ts).
 * @param JE - The tag runtime bridge.
 * @param deps - The other pipeline modules' functions, filled in by createTagPipeline before any of them runs.
 */
export function createItemFacts(s: PipelineState, JE: TagRuntimeBridge, deps: PipelineFns) {
    function advanceBatchGeneration() {
        s.batchGeneration++;
        s.cancelBatchWait?.();
    }


    /**
     * Remove a container fact and the season lookup owned by it.
     * @param id - Normalized item id.
     * */
    function forgetItemFacts(id: string): void {
        const saved = s.itemFacts.get(id);
        if (saved?.seasonKey && s.seasonFactIds.get(saved.seasonKey) === id) s.seasonFactIds.delete(saved.seasonKey);
        s.itemFacts.delete(id);
    }


    /**
     * Retain only caller-filtered container projections, including stripped facts.
     * @param entry - A server entry or /tag-data item.
     * @param id - Its item id.
     * @param [fetchedAt] - Original fetch time; cached redraws retain it.
     * */
    function rememberItemFacts(entry: JsonRecord, id: unknown = entry.Id, fetchedAt: number = Date.now()): void {
        if (!id || (entry.Type !== 'Series' && entry.Type !== 'Season')) return;
        const itemId = normalizeItemId(id);
        // A redraw cannot revive an expired fetch or replace newer shared facts.
        if (!Number.isFinite(fetchedAt) || fetchedAt + ITEM_FACTS_TTL_MS <= Date.now()
            || (s.itemFacts.get(itemId)?.fetchedAt ?? -Infinity) > fetchedAt) return;
        forgetItemFacts(itemId);
        const seriesId = entry.SeriesId ? normalizeItemId(entry.SeriesId) : null;
        const seasonKey = entry.Type === 'Season' && seriesId ? `${seriesId}:${entry.SeasonNumber ?? entry.IndexNumber}` : null;
        if (seasonKey) {
            const previousId = s.seasonFactIds.get(seasonKey);
            if (previousId) forgetItemFacts(previousId);
            s.seasonFactIds.set(seasonKey, itemId);
        }
        s.itemFacts.set(itemId, { entry, fetchedAt, expires: fetchedAt + ITEM_FACTS_TTL_MS, seasonKey });
        // Map insertion order implements oldest-first eviction for each store.
        for (const oldest of s.itemFacts.keys()) {
            if (s.itemFacts.size <= MEMORY_SOFT_CAP) break;
            forgetItemFacts(oldest);
        }
        for (const [key, seasonId] of s.seasonFactIds) {
            if (s.seasonFactIds.size <= MEMORY_SOFT_CAP) break;
            s.seasonFactIds.delete(key);
            forgetItemFacts(seasonId);
        }
    }


    /** @param id @returns A fresh, caller-filtered projection. */
    function peekItemFacts(id: string): JsonRecord|null {
        const entry = s.serverCache?.get(id);
        if (entry) return entry;
        const saved = s.itemFacts.get(id);
        if (saved && saved.expires > Date.now()) return saved.entry;
        forgetItemFacts(id);
        return null;
    }


    /**
     * Warm parent facts through the confirmed server cache or the same filtered
     * /tag-data projection used for cards. Native parent DTOs lack these aggregates.
     * @param ids - Normalized parent ids.
     * */
    async function lookupItemFacts(ids: readonly string[]): Promise<void> {
        const generation = s.cacheGeneration;
        const epoch = JE.session ? JE.session.getEpoch() : 0;
        await deps.lookupServerEntries(ids);
        if (generation !== s.cacheGeneration || (JE.session && !JE.session.isCurrent(epoch))) return;
        const missing = [...new Set(ids)].filter(id => !peekItemFacts(id));
        const userId = deps.apiClient().getCurrentUserId();
        if (!userId) return;
        for (let i = 0; i < missing.length; i += 200) {
            try {
                const response = record(await deps.apiClient().ajax({
                    type: 'POST',
                    url: deps.apiClient().getUrl(`/JellyfinEnhanced/tag-data/${userId}`, { latestEpisode: true }),
                    data: JSON.stringify(missing.slice(i, i + 200)),
                    contentType: 'application/json', dataType: 'json'
                }));
                if (generation !== s.cacheGeneration || (JE.session && !JE.session.isCurrent(epoch))) return;
                for (const entry of members(response.Items)) rememberItemFacts(memberRecord(entry));
            } catch { /* Missing or inaccessible parents never supply a fallback. */ }
        }
    }


    /**
     * A season aggregate already fetched for this caller, as a local fallback.
     * @param seriesId @param {number} season
     * */
    function peekSeasonFacts(seriesId: string, season: number): JsonRecord|null {
        const id = s.seasonFactIds.get(`${seriesId}:${season}`);
        return id ? peekItemFacts(id) : null;
    }

    return { advanceBatchGeneration, forgetItemFacts, rememberItemFacts, peekItemFacts, lookupItemFacts, peekSeasonFacts };
}
