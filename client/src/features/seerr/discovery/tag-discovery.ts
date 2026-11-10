// /js/jellyseerr/discovery/tag-discovery.js
// "More [Tag]" on tag list pages. This module keeps the tag → TMDB-keyword resolution; both feeds
// share the same keyword id.
import { baseOf, discoveryHost, filterOf, translate, type SeerrDiscoveryHost } from '../host-discovery';
import { isPositiveInt, isUserActive, parseTagName, pickKeyword } from './domain';
import { managedFetch, tolerant } from './lookups';
import type { ResolveContext, ResolvedFeeds } from './types';

function start(JE: SeerrDiscoveryHost): void {
    const filter = filterOf(JE);
    const base = baseOf(JE);
    const fetchManaged = managedFetch(JE, 'tag');
    const keywordCache = filter.createSessionCache('keyword-id', isPositiveInt);

    function searchTmdbKeyword(tagName: string, signal: AbortSignal): Promise<number | null> {
        const cacheKey = tagName.toLowerCase().trim();
        const cache = keywordCache.scope();
        const cached = cache.get(cacheKey);
        if (cached) return Promise.resolve(cached);
        return tolerant(signal, async () => {
            const response = await fetchManaged(`/JellyfinEnhanced/tmdb/search/keyword?query=${encodeURIComponent(tagName)}`, { signal });
            const keywordId = pickKeyword(response, tagName);
            if (keywordId === undefined) return null;
            if (!signal.aborted) cache.set(cacheKey, keywordId);
            return keywordId;
        });
    }
    async function resolveFeeds({ id: tagName, signal }: ResolveContext): Promise<ResolvedFeeds | null> {
        const status = await JE.jellyseerrAPI?.checkUserStatus?.();
        if (signal.aborted || !isUserActive(status)) return null;
        const keywordId = await searchTmdbKeyword(tagName, signal);
        if (signal.aborted || !keywordId) return null;
        return { tvId: keywordId, movieId: keywordId, title: translate(JE, 'discovery_more_with_tag', { tag: tagName }) };
    }
    base.createDiscovery({
        key: 'tag',
        mode: 'dual-feed',
        logLabel: 'Tag Discovery',
        configKey: 'JellyseerrShowTagDiscovery',
        getIdFromUrl: () => parseTagName(window.location.hash),
        resolveFeeds,
        buildDiscoverPath: (kind, id) => kind === 'tv'
            ? `/JellyfinEnhanced/jellyseerr/discover/tv/keyword/${id}`
            : `/JellyfinEnhanced/jellyseerr/discover/movies/keyword/${id}`
    }).start();
}
(function () {
    'use strict';
    start(discoveryHost().JE);
})();
