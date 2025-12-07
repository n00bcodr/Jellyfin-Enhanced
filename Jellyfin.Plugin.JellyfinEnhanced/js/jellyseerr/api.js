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

        const result = await post('/request', body);

        // Add to watchlist after successful request
        if (result) {
            try {
                await api.addToWatchlist(tmdbId, mediaType);
            } catch (error) {
                // Don't fail the request if watchlist addition fails
                console.warn(`${logPrefix} Failed to add to watchlist:`, error);
            }
        }

        return result;
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
        const result = await post('/request', body);

        // Add to watchlist after successful request
        if (result) {
            try {
                await api.addToWatchlist(tmdbId, 'tv');
            } catch (error) {
                // Don't fail the request if watchlist addition fails
                console.warn(`${logPrefix} Failed to add to watchlist:`, error);
            }
        }

        return result;
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

    /**
     * Adds requested media to the pending watchlist.
     * The item will be automatically added to the watchlist when it appears in the library.
     * @param {number} tmdbId - The TMDB ID of the media.
     * @param {string} mediaType - 'movie' or 'tv'.
     * @returns {Promise<boolean>} - True if successfully queued, false otherwise.
     */
    api.addToWatchlist = async function(tmdbId, mediaType) {
        try {
            // Check if watchlist feature is enabled in plugin config
            const JE = window.JellyfinEnhanced;
            if (!JE || !JE.pluginConfig) {
                console.debug(`${logPrefix} Plugin config not loaded yet`);
                return false;
            }

            if (!JE.pluginConfig.AddRequestedMediaToWatchlist || !JE.pluginConfig.JellyseerrEnabled) {
                console.debug(`${logPrefix} Watchlist auto-add is disabled (AddRequestedMediaToWatchlist: ${JE.pluginConfig.AddRequestedMediaToWatchlist}, JellyseerrEnabled: ${JE.pluginConfig.JellyseerrEnabled})`);
                return false;
            }

            const userId = ApiClient.getCurrentUserId();
            if (!userId) {
                console.warn(`${logPrefix} Could not get current user ID for watchlist`);
                return false;
            }

            // Add to pending watchlist - it will be processed when the item appears in library
            const response = await ApiClient.fetch({
                type: 'POST',
                url: ApiClient.getUrl(`JellyfinEnhanced/user-settings/${userId}/pending-watchlist/add`),
                contentType: 'application/json',
                data: JSON.stringify({
                    TmdbId: tmdbId,
                    MediaType: mediaType
                })
            });

            if (response && response.success) {
                console.log(`${logPrefix} ✓ Queued TMDB ${tmdbId} (${mediaType}) for watchlist - will be added when it appears in library`);
                return true;
            }
            return false;
        } catch (error) {
            console.error(`${logPrefix} Error queuing item for watchlist:`, error);
            return false;
        }
    };

    /**
     * Reports an issue for a media item to Jellyseerr.
     * @param {number} mediaId - The TMDB/TVDB ID of the media.
     * @param {string} mediaType - 'movie' or 'tv'.
     * @param {string} problemType - Type of issue (e.g., 'no_season', 'episode_missing', etc.).
     * @param {string} [message=''] - Optional description of the issue.
     * @returns {Promise<any>} - The response from Jellyseerr.
     */
    /**
     * Maps problem types to Jellyseerr issue types and season/episode info
     * Jellyseerr uses: VIDEO (1), AUDIO (2), SUBTITLES (3), OTHER (4)
     */
    const ISSUE_TYPE_MAP = {
        'wrong_quality': { issueType: 1, label: 'VIDEO' },        // VIDEO
        'wrong_audio': { issueType: 2, label: 'AUDIO' },           // AUDIO
        'wrong_subs': { issueType: 3, label: 'SUBTITLES' },        // SUBTITLES
        'no_season': { issueType: 4, label: 'OTHER' },             // OTHER - TV specific
        'episode_missing': { issueType: 4, label: 'OTHER' },       // OTHER - TV specific
        'episode_wrong_quality': { issueType: 1, label: 'VIDEO' }, // VIDEO - Episode
        'episode_wrong_audio': { issueType: 2, label: 'AUDIO' },   // AUDIO - Episode
        'episode_wrong_subs': { issueType: 3, label: 'SUBTITLES' } // SUBTITLES - Episode
    };

    api.reportIssue = async function(mediaId, mediaType, problemType, message = '') {
        try {
            const mapping = ISSUE_TYPE_MAP[problemType] || { issueType: 4, label: 'OTHER' };

            // Fetch the correct internal media id from Jellyseerr

            let apiResult = null;
            if (mediaType === 'movie') {
                apiResult = await get(`/movie/${mediaId}`);
            } else if (mediaType === 'tv') {
                apiResult = await get(`/tv/${mediaId}`);
            }

            const internalId = apiResult && apiResult.mediaInfo && apiResult.mediaInfo.id;
            if (!internalId) {
                throw new Error(`Could not find Jellyseerr media id (mediaInfo.id) for TMDB id ${mediaId} (${mediaType})`);
            }
            console.log(`${logPrefix} Retrieved internal media id for issue report:`, internalId);

            const body = {
                mediaId: parseInt(internalId),
                issueType: mapping.issueType,
                problemSeason: 0,
                problemEpisode: 0,
                message: message || ''
            };

            console.debug(`${logPrefix} Sending issue report with body:`, body);
            const result = await post('/issue', body);
            console.log(`${logPrefix} Issue reported for Jellyseerr media ID ${internalId} (TMDB ${mediaId}, ${mediaType}): ${problemType}`);
            return result;
        } catch (error) {
            console.error(`${logPrefix} Failed to report issue for TMDB ID ${mediaId}:`, error);
            throw error;
        }
    };

    // Expose the API module on the global JE object
    JE.jellyseerrAPI = api;

})(window.JellyfinEnhanced);