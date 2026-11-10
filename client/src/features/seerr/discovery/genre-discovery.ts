// /js/jellyseerr/discovery/genre-discovery.js
// "More [Genre]" on genre list pages. This module keeps the Jellyfin-genre → TMDB-genre resolution.
import { baseOf, discoveryHost, filterOf, identityKey, translate, type SeerrDiscoveryHost } from '../host-discovery';
import { buildGenreMap, decodeNamedInfo, isNamedTmdbInfo, isUserActive, resolveGenreIds, throwIfAborted } from './domain';
import { managedFetch, tolerant } from './lookups';
import type { FeedIds, GenreListEntry, NamedTmdbInfo, ResolveContext, ResolvedFeeds } from './types';

function start(JE: SeerrDiscoveryHost): void {
    const filter = filterOf(JE);
    const base = baseOf(JE);
    const fetchManaged = managedFetch(JE, 'genre');
    // Kept for the tab, per user.
    const genreInfoCache = filter.createSessionCache('genre-info', isNamedTmdbInfo);
    // The merged id map, for one identity, and only once both lists actually held genres: a failed
    // list must not leave an empty map behind for the rest of the session.
    let genreMap: { readonly identity: string; readonly map: ReadonlyMap<string, FeedIds> } | null = null;

    async function fetchTmdbGenres(signal: AbortSignal): Promise<ReadonlyMap<string, FeedIds>> {
        const identity = identityKey(JE);
        if (genreMap?.identity === identity) return genreMap.map;
        const list = (kind: 'tv' | 'movie'): Promise<GenreListEntry[] | null> =>
            filter.fetchTmdbGenreList(kind, { signal }).catch(() => null);
        const [tv, movies] = await Promise.all([list('tv'), list('movie')]);
        throwIfAborted(signal);
        const map = buildGenreMap(tv ?? [], movies ?? []);
        if (tv?.length && movies?.length && identityKey(JE) === identity) genreMap = { identity, map };
        return map;
    }
    function getGenreInfo(genreId: string, signal: AbortSignal): Promise<NamedTmdbInfo | null> {
        const cache = genreInfoCache.scope();
        const cached = cache.get(genreId);
        if (cached) return Promise.resolve(cached);
        return tolerant(signal, async () => {
            const info = decodeNamedInfo(await fetchManaged(`/JellyfinEnhanced/genre/${genreId}`, { signal }));
            if (info && !signal.aborted) cache.set(genreId, info);
            return info;
        });
    }
    async function resolveFeeds({ id: genreId, signal }: ResolveContext): Promise<ResolvedFeeds | null> {
        const [genreInfo, status, genres] = await Promise.all([
            getGenreInfo(genreId, signal), JE.jellyseerrAPI?.checkUserStatus?.(), fetchTmdbGenres(signal)
        ]);
        if (signal.aborted) return null;
        if (!isUserActive(status) || !genreInfo?.name) return null;
        const ids = resolveGenreIds(genres, genreInfo.name);
        if (!ids) return null;
        return {
            tvId: ids.tv,
            movieId: ids.movie,
            title: translate(JE, 'discovery_more_with_genre', { genre: genreInfo.name })
        };
    }
    base.createDiscovery({
        key: 'genre',
        mode: 'dual-feed',
        logLabel: 'Genre Discovery',
        configKey: 'JellyseerrShowGenreDiscovery',
        getIdFromUrl: base.idFromListParam('genreId'),
        resolveFeeds,
        buildDiscoverPath: (kind, id) => kind === 'tv'
            ? `/JellyfinEnhanced/jellyseerr/discover/tv/genre/${id}`
            : `/JellyfinEnhanced/jellyseerr/discover/movies/genre/${id}`
    }).start();
}
(function () {
    'use strict';
    start(discoveryHost().JE);
})();
