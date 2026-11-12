// /js/jellyseerr/discovery/person-discovery.js
// "More from [Actor]" on person detail pages. This module keeps the TMDB person resolution and the
// credits fetch; the base owns chunked pagination, filter/sort controls and lifecycle wiring.
import { baseOf, discoveryHost, filterOf, translate, type SeerrDiscoveryHost } from '../host-discovery';
import {
    decodeCredits, decodeNamedInfo, isAbortError, isNamedTmdbInfo, isPositiveInt, isUserActive, pickPerson, positiveInt,
    throwIfAborted
} from './domain';
import { isItemType, managedFetch, tolerant } from './lookups';
import type { NamedTmdbInfo, ResolveContext, ResolvedItems, SeerrResult } from './types';

const logPrefix = '🪼 Jellyfin Enhanced: Person Discovery:';

function start(JE: SeerrDiscoveryHost): void {
    const filter = filterOf(JE);
    const base = baseOf(JE);
    const fetchManaged = managedFetch(JE, 'person');
    // Kept for the tab, per user: the person search is answered by Seerr for the signed-in user.
    const personIdCache = filter.createSessionCache('person-id', isPositiveInt);
    const personInfoCache = filter.createSessionCache('person-info', isNamedTmdbInfo);

    function getPersonInfo(personId: string, signal: AbortSignal): Promise<NamedTmdbInfo | null> {
        const cache = personInfoCache.scope();
        const cached = cache.get(personId);
        if (cached) return Promise.resolve(cached);
        return tolerant(signal, async () => {
            const info = decodeNamedInfo(await fetchManaged(`/JellyfinEnhanced/person/${personId}`, { signal }));
            if (info && !signal.aborted) cache.set(personId, info);
            return info;
        });
    }
    function searchTmdbPerson(name: string, signal: AbortSignal): Promise<number | null> {
        const cacheKey = name.toLowerCase().trim();
        const cache = personIdCache.scope();
        const cached = cache.get(cacheKey);
        if (cached) return Promise.resolve(cached);
        return tolerant(signal, async () => {
            const response = await fetchManaged(`/JellyfinEnhanced/tmdb/search/person?query=${encodeURIComponent(name)}`, { signal });
            const personId = pickPerson(response, name);
            if (personId === undefined) return null;
            if (!signal.aborted) cache.set(cacheKey, personId);
            return personId;
        });
    }
    /** parental_pending is not an empty filmography: a failure reaches the base, which offers a retry. */
    async function fetchPersonCredits(personId: number, signal: AbortSignal): Promise<SeerrResult[]> {
        try {
            throwIfAborted(signal);
            const credits = decodeCredits(await fetchManaged(`/JellyfinEnhanced/jellyseerr/person/${personId}/combined_credits`, { signal }));
            throwIfAborted(signal);
            return credits;
        } catch (error) {
            if (!isAbortError(error)) console.error(`${logPrefix} Error fetching credits:`, error);
            throw error;
        }
    }
    async function resolveItems({ id: itemId, signal }: ResolveContext): Promise<ResolvedItems | null> {
        const isPerson = await isItemType(JE, itemId, 'Person', signal);
        if (signal.aborted || !isPerson) return null;
        const [personInfo, status] = await Promise.all([getPersonInfo(itemId, signal), JE.jellyseerrAPI?.checkUserStatus?.()]);
        if (signal.aborted) return null;
        if (!isUserActive(status) || !personInfo?.name) return null;
        const tmdbPersonId = positiveInt(personInfo.tmdbId) ?? await searchTmdbPerson(personInfo.name, signal);
        if (signal.aborted || !tmdbPersonId) return null;
        const items = await fetchPersonCredits(tmdbPersonId, signal);
        if (signal.aborted) return null;
        console.debug(`${logPrefix} Fetched ${items.length} credits for ${personInfo.name}`);
        return { items, title: translate(JE, 'discovery_more_from_person', { person: personInfo.name }), name: personInfo.name };
    }
    base.createDiscovery({
        key: 'person',
        mode: 'client-paged',
        logLabel: 'Person Discovery',
        configKey: 'JellyseerrShowPersonDiscovery',
        getIdFromUrl: base.idFromDetailUrl,
        pageSize: 40,
        resolveItems
    }).start();
}
(function () {
    'use strict';
    start(discoveryHost().JE);
})();
