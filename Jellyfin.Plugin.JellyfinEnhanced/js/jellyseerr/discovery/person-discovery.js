// @ts-check
// /js/jellyseerr/discovery/person-discovery.js
// Adds "More from [Actor]" section to person detail pages using Seerr API.
// Client-paged spec over JE.discoveryBase — the base owns the chunked
// pagination, filter/sort controls, infinite scroll and lifecycle wiring;
// this module keeps the TMDB person resolution and the credits fetch.
(function(JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced: Person Discovery:';

    // Cache for person ID mappings (personName -> TMDB personId)
    const personIdCache = new Map();
    const personInfoCache = new Map();

    // Alias for shared utilities
    const fetchWithManagedRequest = (path, options) =>
        JE.discoveryFilter.fetchWithManagedRequest(path, 'person', options);

    /**
     * Gets person information from Jellyfin (with caching)
     * @param {string} personId
     * @param {AbortSignal} [signal]
     */
    async function getPersonInfo(personId, signal) {
        if (personInfoCache.has(personId)) {
            return personInfoCache.get(personId);
        }
        try {
            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }

            const response = await fetchWithManagedRequest(`/JellyfinEnhanced/person/${personId}`, { signal });

            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }

            if (response) {
                personInfoCache.set(personId, response);
            }
            return response;
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            return null;
        }
    }

    /**
     * Check if current page is a Person detail page
     * @param {string} itemId
     * @param {AbortSignal} [signal]
     */
    async function isPersonPage(itemId, signal) {
        try {
            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }

            const item = JE.helpers?.getItemCached
                ? await JE.helpers.getItemCached(itemId)
                : await ApiClient.getItem(ApiClient.getCurrentUserId(), itemId);

            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }

            return item && item.Type === 'Person';
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            return false;
        }
    }

    /**
     * Searches for TMDB person ID by name
     * @param {string} personName
     * @param {AbortSignal} [signal]
     */
    async function searchTmdbPerson(personName, signal) {
        const cacheKey = personName.toLowerCase().trim();
        if (personIdCache.has(cacheKey)) {
            return personIdCache.get(cacheKey);
        }

        try {
            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }

            const response = await fetchWithManagedRequest(
                `/JellyfinEnhanced/tmdb/search/person?query=${encodeURIComponent(personName)}`,
                { signal }
            );

            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }

            if (response?.results?.length > 0) {
                const personResults = response.results.filter(r => r.mediaType === 'person');
                if (personResults.length > 0) {
                    // Filter to exact name matches first
                    const exactMatches = personResults.filter(r =>
                        r.name?.toLowerCase() === personName.toLowerCase()
                    );

                    // Score matches: prefer those with profile images and more known works
                    const scored = (exactMatches.length > 0 ? exactMatches : personResults).map(r => ({
                        ...r,
                        score: (r.profilePath ? 2 : 0) + Math.min(r.knownFor?.length || 0, 3)
                    }));

                    scored.sort((a, b) => b.score - a.score);

                    if (scored.length === 0) return null;
                    const personId = scored[0].id;

                    personIdCache.set(cacheKey, personId);
                    return personId;
                }
            }
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            // Silent fail
        }
        return null;
    }

    /**
     * Fetches person credits from Seerr
     * @param {number} personId
     * @param {AbortSignal} [signal]
     */
    async function fetchPersonCredits(personId, signal) {
        try {
            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }

            const response = await fetchWithManagedRequest(
                `/JellyfinEnhanced/jellyseerr/person/${personId}/combined_credits`,
                { signal }
            );

            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }

            return response || { cast: [], crew: [] };
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            console.error(`${logPrefix} Error fetching credits:`, error);
            return { cast: [], crew: [] };
        }
    }

    /**
     * Resolves the full deduped credits list + section title for the base.
     * @param {{id: string, signal: AbortSignal}} ctx
     * @returns {Promise<{items: Array<any>, title: string}|null>}
     */
    async function resolveItems({ id: itemId, signal }) {
        // Check if this is a person page
        const isPerson = await isPersonPage(itemId, signal);
        if (signal.aborted) return null;
        if (!isPerson) return null;

        const personInfoPromise = getPersonInfo(itemId, signal);
        const statusPromise = JE.jellyseerrAPI?.checkUserStatus();

        const [personInfo, status] = await Promise.all([personInfoPromise, statusPromise]);

        if (signal.aborted) return null;

        if (!status?.active || !personInfo?.name) return null;

        // Get TMDB person ID
        const tmdbPersonId = personInfo.tmdbId
            ? parseInt(personInfo.tmdbId)
            : await searchTmdbPerson(personInfo.name, signal);

        if (signal.aborted) return null;

        if (!tmdbPersonId) return null;

        // Fetch credits
        const credits = await fetchPersonCredits(tmdbPersonId, signal);
        if (signal.aborted) return null;

        const allResults = [...(credits.cast || []), ...(credits.crew || [])];
        const dedupedResults = [];
        const seenItems = new Set();
        for (const item of allResults) {
            const key = `${item?.mediaType}-${item?.id}`;
            if (!item?.id || !item?.mediaType || seenItems.has(key)) continue;
            seenItems.add(key);
            dedupedResults.push(item);
        }

        console.debug(`${logPrefix} Fetched ${dedupedResults.length} credits for ${personInfo.name}`);

        return {
            items: dedupedResults,
            title: JE.t('discovery_more_from_person', { person: personInfo.name })
        };
    }

    const discovery = JE.discoveryBase.createDiscovery({
        key: 'person',
        mode: 'client-paged',
        logLabel: 'Person Discovery',
        configKey: 'JellyseerrShowPersonDiscovery',
        getIdFromUrl: JE.discoveryBase.idFromDetailUrl,
        pageSize: 40,
        resolveItems
    });

    discovery.start();

})(window.JellyfinEnhanced);
