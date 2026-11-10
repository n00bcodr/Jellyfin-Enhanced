// /js/jellyseerr/discovery/network-discovery.js
// "More from [Network]" on studio/network list pages. This module keeps the studio → TMDB
// network/company resolution and picks the series feed: Seerr's network feed for a known network,
// the plugin's TMDB-backed series-by-company feed for any other studio.
import { baseOf, discoveryHost, filterOf, translate, type SeerrDiscoveryHost } from '../host-discovery';
import {
    decodeNamedInfo, getKnownNetworkId, isNamedTmdbInfo, isNullablePositiveInt, isUserActive, pickCompany, positiveInt
} from './domain';
import { managedFetch, tolerant } from './lookups';
import type { NamedTmdbInfo, ResolveContext, ResolvedFeeds } from './types';

function start(JE: SeerrDiscoveryHost): void {
    const filter = filterOf(JE);
    const base = baseOf(JE);
    const fetchManaged = managedFetch(JE, 'network');
    // Kept for the tab, per user. A null company id means no safe match.
    const companyCache = filter.createSessionCache('company-id', isNullablePositiveInt);
    const studioCache = filter.createSessionCache('studio-info', isNamedTmdbInfo);

    function getStudioInfo(studioId: string, signal: AbortSignal): Promise<NamedTmdbInfo | null> {
        const cache = studioCache.scope();
        const cached = cache.get(studioId);
        if (cached) return Promise.resolve(cached);
        return tolerant(signal, async () => {
            const info = decodeNamedInfo(await fetchManaged(`/JellyfinEnhanced/studio/${studioId}`, { signal }));
            if (info && !signal.aborted) cache.set(studioId, info);
            return info;
        });
    }
    function searchTmdbCompany(name: string, signal: AbortSignal): Promise<number | null> {
        const cacheKey = name.toLowerCase().trim();
        const cache = companyCache.scope();
        if (cache.has(cacheKey)) return Promise.resolve(cache.get(cacheKey) ?? null);
        return tolerant(signal, async () => {
            const response = await fetchManaged(`/JellyfinEnhanced/tmdb/search/company?query=${encodeURIComponent(name)}`, { signal });
            const companyId = pickCompany(response, name);
            if (companyId !== undefined && !signal.aborted) cache.set(cacheKey, companyId);
            return companyId ?? null;
        });
    }
    /**
     * Both media types are offered whenever an id exists for each: a known network gets its movies
     * from the company of the same name, and a plain studio gets its series from TMDB's company
     * filter (Seerr only filters series by network), so the base can show All / Movies / Series.
     */
    async function resolveFeeds({ id: studioId, signal }: ResolveContext): Promise<ResolvedFeeds | null> {
        const [studioInfo, status] = await Promise.all([getStudioInfo(studioId, signal), JE.jellyseerrAPI?.checkUserStatus?.()]);
        if (signal.aborted) return null;
        if (!isUserActive(status) || !studioInfo?.name) return null;
        // TV network ids differ from company ids in TMDB, so networks always go by name.
        const tvNetworkId = getKnownNetworkId(studioInfo.name);
        const companyId = positiveInt(studioInfo.tmdbId) ?? await searchTmdbCompany(studioInfo.name, signal);
        if (signal.aborted) return null;
        if (!tvNetworkId && !companyId) return null;
        // No network of that name: the series feed is the studio's own productions, from TMDB.
        const tvByCompany = !tvNetworkId && !!companyId && !!JE.pluginConfig?.TmdbEnabled;
        return {
            tvId: tvNetworkId || (tvByCompany ? companyId : null),
            movieId: companyId,
            tvSource: tvNetworkId ? 'network' : 'company',
            title: translate(JE, 'discovery_more_from_studio', { studio: studioInfo.name })
        };
    }
    base.createDiscovery({
        key: 'network',
        mode: 'dual-feed',
        logLabel: 'Network Discovery',
        configKey: 'JellyseerrShowNetworkDiscovery',
        // Unlike the other discovery sections, network discovery is opt-in.
        defaultEnabled: false,
        getIdFromUrl: base.idFromListParam('studioId'),
        // Historical page-key format: no 'network-' prefix.
        pageKey: id => `${id}-${window.location.hash}`,
        resolveFeeds,
        buildDiscoverPath(kind, id, feeds) {
            if (kind !== 'tv') return `/JellyfinEnhanced/jellyseerr/discover/movies/studio/${id}`;
            return feeds.tvSource === 'company'
                ? `/JellyfinEnhanced/jellyseerr/discover/tv/studio/${id}`
                : `/JellyfinEnhanced/jellyseerr/discover/tv/network/${id}`;
        }
    }).start();
}
(function () {
    'use strict';
    start(discoveryHost().JE);
})();
