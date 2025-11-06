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
     * Fetches override rules from Jellyseerr.
     * @returns {Promise<Array>}
     */
    api.fetchOverrideRules = async function() {
        try {
            const rules = await get('/overrideRule');
            return Array.isArray(rules) ? rules : [];
        } catch (error) {
            console.error(`${logPrefix} Failed to fetch override rules:`, error);
            return [];
        }
    };

    /**
     * Gets the current Jellyseerr user ID from the user status.
     * @returns {Promise<string|null>} - Jellyseerr user ID or null if not found.
     */
    api.getCurrentJellyseerrUserId = async function() {
        try {
            // We can get this from the existing user-status endpoint
            const status = await get('/user-status');
            if (status && status.userFound) {
                // We need to fetch the actual user ID - let's get it from the users endpoint
                const users = await get('/user?take=1000');
                if (users && users.results) {
                    const jellyfinUserId = ApiClient.getCurrentUserId();
                    const matchingUser = users.results.find(u => u.jellyfinUserId === jellyfinUserId);
                    return matchingUser ? matchingUser.id.toString() : null;
                }
            }
            return null;
        } catch (error) {
            console.warn(`${logPrefix} Failed to get current Jellyseerr user ID:`, error);
            return null;
        }
    };

    /**
     * Evaluates override rules against media metadata and returns matching rule settings.
     * @param {object} mediaData - Media object with originalLanguage, genres, etc.
     * @param {string} mediaType - 'movie' or 'tv'.
     * @param {boolean} is4k - Whether this is a 4K request.
     * @returns {Promise<object|null>} - Rule settings to apply or null if no match.
     */
    api.evaluateOverrideRules = async function(mediaData, mediaType, is4k = false) {
        try {
            const rules = await api.fetchOverrideRules();
            if (!rules || rules.length === 0) {
                console.debug(`${logPrefix} No override rules configured`);
                return null;
            }

            const serviceIdKey = mediaType === 'movie' ? 'radarrServiceId' : 'sonarrServiceId';
            const applicableRules = rules.filter(rule => {
                // Filter by service type (movie uses radarr, tv uses sonarr)
                if (rule[serviceIdKey] === null || rule[serviceIdKey] === undefined) {
                    return false;
                }
                return true;
            });

            if (applicableRules.length === 0) {
                console.debug(`${logPrefix} No applicable rules for ${mediaType}`);
                return null;
            }

            // Find the first matching rule
            for (const rule of applicableRules) {
                let matches = true;

                // Check language condition (pipe-separated ISO codes)
                if (rule.language && mediaData.originalLanguage) {
                    const allowedLanguages = rule.language.split('|').map(l => l.trim().toLowerCase());
                    if (!allowedLanguages.includes(mediaData.originalLanguage.toLowerCase())) {
                        matches = false;
                        continue;
                    }
                }

                // Check genre condition (pipe-separated genre IDs or names)
                if (rule.genre && mediaData.genreIds) {
                    const ruleGenres = rule.genre.split('|').map(g => g.trim().toLowerCase());
                    const mediaGenreNames = (mediaData.genres || []).map(g => g.name.toLowerCase());
                    const mediaGenreIds = (mediaData.genreIds || []).map(id => id.toString());

                    const hasMatchingGenre = ruleGenres.some(ruleGenre =>
                        mediaGenreNames.includes(ruleGenre) || mediaGenreIds.includes(ruleGenre)
                    );

                    if (!hasMatchingGenre) {
                        matches = false;
                        continue;
                    }
                }

                // Check keywords condition
                if (rule.keywords && mediaData.keywords) {
                    const ruleKeywords = rule.keywords.split('|').map(k => k.trim().toLowerCase());
                    const mediaKeywordNames = (mediaData.keywords || []).map(k => k.name?.toLowerCase() || '');

                    const hasMatchingKeyword = ruleKeywords.some(ruleKeyword =>
                        mediaKeywordNames.includes(ruleKeyword)
                    );

                    if (!hasMatchingKeyword) {
                        matches = false;
                        continue;
                    }
                }

                // Check user condition
                if (rule.users) {
                    const currentUserId = await api.getCurrentJellyseerrUserId();
                    if (currentUserId) {
                        const allowedUsers = rule.users.split(',').map(u => u.trim());
                        if (!allowedUsers.includes(currentUserId)) {
                            matches = false;
                            continue;
                        }
                    } else {
                        // If we can't determine the user ID, skip this rule
                        matches = false;
                        continue;
                    }
                }

                if (matches) {
                    console.log(`${logPrefix} Matched override rule ${rule.id}:`, {
                        language: rule.language,
                        genre: rule.genre,
                        profileId: rule.profileId,
                        rootFolder: rule.rootFolder
                    });

                    // Return the settings to apply
                    const settings = {};
                    if (rule.profileId !== null && rule.profileId !== undefined) {
                        settings.profileId = rule.profileId;
                    }
                    if (rule.rootFolder) {
                        settings.rootFolder = rule.rootFolder;
                    }
                    if (rule.tags) {
                        // Convert tags to array format that Jellyseerr expects
                        if (Array.isArray(rule.tags)) {
                            settings.tags = rule.tags;
                        } else if (typeof rule.tags === 'string') {
                            // Handle pipe-separated string or single value
                            settings.tags = rule.tags.split('|').map(t => parseInt(t.trim())).filter(t => !isNaN(t));
                        } else if (typeof rule.tags === 'number') {
                            settings.tags = [rule.tags];
                        }
                    }
                    if (rule[serviceIdKey] !== null && rule[serviceIdKey] !== undefined) {
                        settings.serverId = rule[serviceIdKey];
                    }

                    return settings;
                }
            }

            console.debug(`${logPrefix} No matching override rules found`);
            return null;
        } catch (error) {
            console.error(`${logPrefix} Error evaluating override rules:`, error);
            return null;
        }
    };

    /**
     * Submits a request for a movie or an entire TV series.
     * @param {number} tmdbId - The TMDB ID of the media.
     * @param {string} mediaType - 'movie' or 'tv'.
     * @param {object} [advancedSettings={}] - Optional advanced settings (server, quality, folder).
     * @param {boolean} [is4k=false] - Whether this is a 4K request.
     * @param {object} [mediaData=null] - Optional media data for override rule evaluation.
     * @returns {Promise<any>}
     */
    api.requestMedia = async function(tmdbId, mediaType, advancedSettings = {}, is4k = false, mediaData = null) {
        // Apply override rules if no advanced settings are provided and media data is available
        if (Object.keys(advancedSettings).length === 0 && mediaData) {
            const overrideSettings = await api.evaluateOverrideRules(mediaData, mediaType, is4k);
            if (overrideSettings) {
                console.log(`${logPrefix} Applying override rule settings:`, overrideSettings);
                advancedSettings = { ...overrideSettings };
            }
        }

        const body = { mediaType, mediaId: parseInt(tmdbId), ...advancedSettings };
        if (mediaType === 'tv') body.seasons = "all";
        if (is4k) body.is4k = true;
        return post('/request', body);
    };

    /**
     * Submits a request for specific seasons of a TV series.
     * @param {number} tmdbId - The TMDB ID of the TV show.
     * @param {number[]} seasonNumbers - An array of season numbers to request.
     * @param {object} [advancedSettings={}] - Optional advanced settings (server, quality, folder).
     * @param {object} [mediaData=null] - Optional media data for override rule evaluation.
     * @returns {Promise<any>}
     */
    api.requestTvSeasons = async function(tmdbId, seasonNumbers, advancedSettings = {}, mediaData = null) {
        // Apply override rules if no advanced settings are provided and media data is available
        if (Object.keys(advancedSettings).length === 0 && mediaData) {
            const overrideSettings = await api.evaluateOverrideRules(mediaData, 'tv', false);
            if (overrideSettings) {
                console.log(`${logPrefix} Applying override rule settings for TV seasons:`, overrideSettings);
                advancedSettings = { ...overrideSettings };
            }
        }

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


    /**
     * Checks if partial series requests are enabled in Jellyseerr settings.
     * @returns {Promise<boolean>} - True if partial requests are enabled, false otherwise.
     */
    api.isPartialRequestsEnabled = async function() {
        try {
            const result = await get('/settings/partial-requests');
            return !!(result && result.partialRequestsEnabled);
        } catch (error) {
            console.warn(`${logPrefix} Failed to fetch partial requests setting:`, error);
            return false;
        }
    };

    // Expose the API module on the global JE object
    JE.jellyseerrAPI = api;

})(window.JellyfinEnhanced);