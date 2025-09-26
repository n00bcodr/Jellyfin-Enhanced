// /js/jellyseerr/api.js
(function(JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced: Jellyseerr API:';
    const api = {};

    /**
     * Performs a GET request to the Jellyseerr proxy endpoint.
     * @param {string} path - The API path (e.g., '/search?query=...').
     * @returns {Promise<any>} - The JSON response from the server.
     */
    async function get(path) {
        return ApiClient.ajax({
            type: 'GET',
            url: ApiClient.getUrl(`/JellyfinEnhanced/jellyseerr${path}`),
            headers: { 'X-Jellyfin-User-Id': ApiClient.getCurrentUserId() },
            dataType: 'json'
        });
    }

    /**
     * Performs a POST request to the Jellyseerr proxy endpoint.
     * @param {string} path - The API path (e.g., '/request').
     * @param {object} body - The JSON body to send with the request.
     * @returns {Promise<any>} - The server's response.
     */
    async function post(path, body) {
        return ApiClient.ajax({
            type: 'POST',
            url: ApiClient.getUrl(`/JellyfinEnhanced/jellyseerr${path}`),
            data: JSON.stringify(body),
            contentType: 'application/json',
            headers: { 'X-Jellyfin-User-Id': ApiClient.getCurrentUserId() }
        });
    }

    /**
     * Checks if the Jellyseerr server is active and if the current user is linked.
     * @returns {Promise<{active: boolean, userFound: boolean}>}
     */
    api.checkUserStatus = async function() {
        try {
            return await get('/user-status');
        } catch (error) {
            console.warn(`${logPrefix} Status check failed:`, error);
            return { active: false, userFound: false };
        }
    };

    /**
     * Performs a search against the Jellyseerr API.
     * @param {string} query - The search term.
     * @returns {Promise<{results: Array}>}
     */
    api.search = async function(query) {
        try {
            const data = await get(`/search?query=${encodeURIComponent(query)}`);

            // Filter out people results before returning
            if (data.results) {
                data.results = data.results.filter(result => result.mediaType !== 'person');
                // Update the totalResults count to reflect filtered results
                data.totalResults = data.results.length;
            }

            return data;
        } catch (error) {
            console.error(`${logPrefix} Search failed for query "${query}":`, error);
            return { results: [] };
        }
    };

    /**
     * Fetches detailed information for a specific TV show from Jellyseerr.
     * @param {number} tmdbId - The TMDB ID of the TV show.
     * @returns {Promise<object|null>}
     */
    api.fetchTvShowDetails = async function(tmdbId) {
        try {
            return await get(`/tv/${tmdbId}`);
        } catch (error) {
            console.error(`${logPrefix} Failed to fetch TV show details for TMDB ID ${tmdbId}:`, error);
            return null;
        }
    };

    /**
     * Submits a request for a movie or an entire TV series.
     * @param {number} tmdbId - The TMDB ID of the media.
     * @param {string} mediaType - 'movie' or 'tv'.
     * @param {object} [advancedSettings={}] - Optional advanced settings (server, quality, folder).
     * @returns {Promise<any>}
     */
    api.requestMedia = async function(tmdbId, mediaType, advancedSettings = {}) {
        const body = { mediaType, mediaId: parseInt(tmdbId), ...advancedSettings };
        if (mediaType === 'tv') body.seasons = "all";
        return post('/request', body);
    };

    /**
     * Submits a request for specific seasons of a TV series.
     * @param {number} tmdbId - The TMDB ID of the TV show.
     * @param {number[]} seasonNumbers - An array of season numbers to request.
     * @param {object} [advancedSettings={}] - Optional advanced settings (server, quality, folder).
     * @returns {Promise<any>}
     */
    api.requestTvSeasons = async function(tmdbId, seasonNumbers, advancedSettings = {}) {
        const body = { mediaType: 'tv', mediaId: parseInt(tmdbId), seasons: seasonNumbers, ...advancedSettings };
        return post('/request', body);
    };

    /**
     * Fetches the necessary data for advanced request options (servers, profiles, folders).
     * @param {string} mediaType - 'movie' for Radarr, 'tv' for Sonarr.
     * @returns {Promise<{servers: Array, tags: Array}>}
     */
    api.fetchAdvancedRequestData = async function(mediaType) {
        const serverType = mediaType === 'movie' ? 'radarr' : 'sonarr';
        try {
            const servers = await get(`/${serverType}`);
            const serverList = Array.isArray(servers) ? servers : [servers];
            const validServers = [];

            for (const server of serverList) {
                if (!server || typeof server.id !== 'number') continue;
                try {
                    const details = await get(`/${serverType}/${server.id}`);
                    server.qualityProfiles = details.profiles || [];
                    server.rootFolders = details.rootFolders || [];
                    validServers.push(server);
                } catch (e) {
                    console.error(`${logPrefix} Could not fetch details for ${serverType} server ID ${server.id}:`, e);
                    server.qualityProfiles = [];
                    server.rootFolders = [];
                    validServers.push(server);
                }
            }
            return { servers: validServers, tags: [] };
        } catch (error) {
            console.error(`${logPrefix} Failed to fetch ${serverType} servers:`, error);
            return { servers: [], tags: [] };
        }
    };

    // Expose the API module on the global JE object
    JE.jellyseerrAPI = api;

})(window.JellyfinEnhanced);