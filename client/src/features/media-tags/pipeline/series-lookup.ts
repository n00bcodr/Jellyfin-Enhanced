import { isRecord, type JsonRecord, record } from './dto';
import { firstItem, type PipelineFns, type PipelineState } from './state';
import type { TagRuntimeBridge } from './tag-pipeline';

/**
 * First-episode and parent-series lookups, cached per series.
 * @param s - The pipeline's shared mutable state (state.ts).
 * @param JE - The tag runtime bridge.
 * @param deps - The other pipeline modules' functions, filled in by createTagPipeline before any of them runs.
 */
export function createSeriesLookup(s: PipelineState, JE: TagRuntimeBridge, deps: PipelineFns) {
    // ── Shared Data Fetching ───────────────────────────────────────────

    /**
     * Get the first episode of a series/season (cached, shared across all renderers).
     * @param userId The user ID.
     * @param parentId The series or season ID.
     * @param [firstEpisodeId=null] Known first episode ID, when available.
     * @returns The first episode item or null.
     */
    async function getFirstEpisode(userId: string, parentId: string, firstEpisodeId: string|null = null): Promise<JsonRecord|null> {
        const cached = s.firstEpisodeCache.get(parentId);
        if (cached) return cached;

        const promise = (async () => {
            // /tag-data already returns the first episode ID for Series/Season.
            // Use it directly so the normal path stays entirely inside the
            // region-aware Enhanced projection and avoids an extra /Items call.
            if (firstEpisodeId) {
                try {
                    const enriched = record(await deps.apiClient().ajax({
                        type: 'POST',
                        url: deps.apiClient().getUrl(`/JellyfinEnhanced/tag-data/${userId}`),
                        data: JSON.stringify([firstEpisodeId]),
                        contentType: 'application/json',
                        dataType: 'json'
                    }));

                    const episode = firstItem(enriched);
                    if (episode) return episode;
                } catch {
                    // Fall through to the native Jellyfin lookup below.
                }
            }

            try {
                const response = record(await deps.apiClient().ajax({
                    type: 'GET',
                    url: deps.apiClient().getUrl('/Items', {
                        ParentId: parentId,
                        IncludeItemTypes: 'Episode',
                        IsVirtualItem: false,
                        Recursive: true,
                        SortBy: 'PremiereDate',
                        SortOrder: 'Ascending',
                        Limit: 1,
                        Fields: 'MediaStreams,MediaSources,Genres',
                        userId: userId
                    }),
                    dataType: 'json'
                }));

                const episode = firstItem(response);
                if (!episode?.Id) return episode;

                // Native Jellyfin may have reduced an explicit Matroska BCP-47
                // language to its base ISO-639 code. Enrich it when possible.
                try {
                    const enriched = record(await deps.apiClient().ajax({
                        type: 'POST',
                        url: deps.apiClient().getUrl(`/JellyfinEnhanced/tag-data/${userId}`),
                        data: JSON.stringify([episode.Id]),
                        contentType: 'application/json',
                        dataType: 'json'
                    }));

                    return firstItem(enriched) || episode;
                } catch {
                    return episode;
                }
            } catch {
                return null;
            }
        })();

        s.firstEpisodeCache.set(parentId, promise);
        return promise;
    }


    /**
     * Get the parent series item (cached, shared across all renderers).
     */
    async function getParentSeries(userId: string, seriesId: string): Promise<JsonRecord | null> {
        const cached = s.parentSeriesCache.get(seriesId);
        if (cached) return cached;

        const promise = (async () => {
            try {
                const item = JE.helpers?.getItemCached
                    ? await JE.helpers.getItemCached(seriesId, { userId })
                    : await deps.apiClient().getItem(userId, seriesId);
                return isRecord(item) ? item : null;
            } catch {
                return null;
            }
        })();

        s.parentSeriesCache.set(seriesId, promise);
        return promise;
    }

    return { getFirstEpisode, getParentSeries };
}
