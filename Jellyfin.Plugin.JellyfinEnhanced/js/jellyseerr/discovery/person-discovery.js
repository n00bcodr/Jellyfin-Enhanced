// @ts-check
// /js/jellyseerr/discovery/person-discovery.js
// Adds "More from [Actor]" section to person detail pages using Seerr API.
// Client-paged spec over JE.discoveryBase — the base owns the chunked
// pagination, filter/sort controls, infinite scroll and lifecycle wiring;
// this module keeps the TMDB person resolution and the credits fetch.
// On the person page of someone the library doesn't have (native details,
// a synthetic person id) the row is the page's filmography: it renders
// whatever the person-discovery switch says, most popular titles first. It
// comes from the server's filmography route, filtered there for the viewer
// (library copies they can open, absent titles whose page would open for
// them; no Seerr account needed), and keeps its library titles whatever the
// exclude-library-items setting says.
(function(JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced: Person Discovery:';

    // Cache for person ID mappings (personName -> TMDB personId) and for the
    // Jellyfin person's name and TMDB id (personId -> {name, tmdbId}); both
    // kept for the tab, per user (see JE.discoveryFilter.createSessionCache:
    // the person search is answered by Seerr for the signed-in user).
    const personIdCache = JE.discoveryFilter.createSessionCache('person-id',
        (v) => Number.isInteger(v) && v > 0);
    const personInfoCache = JE.discoveryFilter.createSessionCache('person-info',
        (v) => !!v && typeof v === 'object' && typeof v.name === 'string'
            && (v.tmdbId === null || v.tmdbId === undefined || typeof v.tmdbId === 'string'));

    // Alias for shared utilities
    const fetchWithManagedRequest = (path, options) =>
        JE.discoveryFilter.fetchWithManagedRequest(path, 'person', options);

    /**
     * Gets person information from Jellyfin (with caching)
     * @param {string} personId
     * @param {AbortSignal} [signal]
     */
    async function getPersonInfo(personId, signal) {
        const cache = personInfoCache.scope();
        if (cache.has(personId)) {
            return cache.get(personId);
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
                // Only the name and TMDB id are used here (and kept for the tab).
                cache.set(personId, { name: response.name, tmdbId: response.tmdbId ?? null });
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
        const cache = personIdCache.scope();
        if (cache.has(cacheKey)) {
            return cache.get(cacheKey);
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

                    cache.set(cacheKey, personId);
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
     * The TMDB id of a person page made for someone the library doesn't have
     * (a synthetic person id, see js/jellyseerr/nativedetails), or 0.
     * @param {string} itemId
     * @returns {number}
     */
    function syntheticPersonTmdb(itemId) {
        const parts = JE.titleDetails?.parse?.(itemId);
        return parts && parts.kind === 'person' ? parts.tmdbId : 0;
    }

    /**
     * The name and TMDB id of a synthetic person page: the id carries the TMDB id
     * and the page's own item the name (JE's person route knows library people only).
     * @param {string} itemId
     * @param {number} tmdbId
     * @param {AbortSignal} [signal]
     * @returns {Promise<{name: string, tmdbId: string}|null>}
     */
    async function syntheticPersonInfo(itemId, tmdbId, signal) {
        const item = JE.helpers?.getItemCached
            ? await JE.helpers.getItemCached(itemId)
            : await ApiClient.getItem(ApiClient.getCurrentUserId(), itemId);
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        return item?.Name ? { name: item.Name, tmdbId: String(tmdbId) } : null;
    }

    /**
     * 1 for an appearance rather than a role (a talk show, news or reality series, or playing
     * themselves), else 0.
     * @param {any} credit
     * @returns {number}
     */
    function appearance(credit) {
        const genres = Array.isArray(credit?.genreIds) ? credit.genreIds : [];
        if (genres.some(g => g === 10767 || g === 10763 || g === 10764)) return 1;
        return /^(self|himself|herself|themselves)\b/i.test(String(credit?.character || '')) ? 1 : 0;
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
            // In particular, parental_pending is not an empty filmography.
            // Let the discovery base offer a retry once automatic retries end.
            throw error;
        }
    }

    /**
     * The filmography of someone the library doesn't have, from the server's
     * native-details route (filtered there for the viewer: library copies
     * carry the Jellyfin id the viewer can open). Null when the person isn't
     * for this viewer (404): no section rather than a retry that can't help.
     * Other failures throw, so the discovery base offers a retry.
     * @param {number} tmdbId
     * @param {AbortSignal} [signal]
     * @returns {Promise<Array<any>|null>}
     */
    async function fetchFilmography(tmdbId, signal) {
        try {
            const response = await fetchWithManagedRequest(`/JellyfinEnhanced/native-details/person/${tmdbId}/filmography`, { signal });
            if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
            return Array.isArray(response?.results) ? response.results : [];
        } catch (error) {
            if (error?.name === 'AbortError') throw error;
            if (error?.status === 404) return null;
            throw error;
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

        const synthetic = syntheticPersonTmdb(itemId);
        if (synthetic) {
            // The server decides who gets this list (no Seerr account needed in
            // Jellyfin Enhanced request mode) and which of its titles they see.
            const [personInfo, results] = await Promise.all([
                syntheticPersonInfo(itemId, synthetic, signal).catch((error) => { if (error?.name === 'AbortError') throw error; return null; }),
                fetchFilmography(synthetic, signal)
            ]);
            if (signal.aborted || !personInfo?.name || !results) return null;
            console.debug(`${logPrefix} Filmography of ${personInfo.name}: ${results.length} titles`);
            // What they are known for first (most voted), talk shows, news, reality and appearances
            // as themselves after their roles (the server's order; kept if it is ever missing).
            const ordered = results.filter(item => item?.id && item?.mediaType)
                .sort((a, b) => (appearance(a) - appearance(b)) || ((Number(b?.voteCount) || 0) - (Number(a?.voteCount) || 0)));
            return { items: ordered, title: JE.t('native_details_filmography') };
        }

        const personInfoPromise = getPersonInfo(itemId, signal);
        const statusPromise = JE.jellyseerrAPI?.checkUserStatus();

        const [personInfo, status] = await Promise.all([personInfoPromise, statusPromise]);

        if (signal.aborted) return null;

        if (!status?.active || !personInfo?.name) return null;

        // No Seerr account (Jellyfin Enhanced request mode): the server's filmography, filtered there
        // for the viewer. The person's TMDB id comes from the library (searching needs Seerr).
        if (status.userFound === false) {
            const tmdb = parseInt(personInfo.tmdbId, 10);
            if (!JE.discoveryFilter.useNativeFeeds?.(status) || !(tmdb > 0)) return null;
            const results = await fetchFilmography(tmdb, signal);
            if (signal.aborted || !results) return null;
            return {
                items: results.filter(item => item?.id && item?.mediaType),
                title: JE.t('discovery_more_from_person', { person: personInfo.name })
            };
        }

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
        // A synthetic person page has no other titles: its filmography is this row,
        // library titles included.
        enabledFor: (id) => syntheticPersonTmdb(id) > 0,
        keepLibraryItems: (id) => syntheticPersonTmdb(id) > 0,
        // Its order (roles before appearances, best known first) holds when movies and series mix.
        keepListOrder: (id) => syntheticPersonTmdb(id) > 0,
        pageSize: 40,
        resolveItems
    });

    discovery.start();

})(window.JellyfinEnhanced);
