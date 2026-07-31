// /js/jellyseerr/api.js
(function(JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced: Seerr API:';
    const api = {};

    // Cache for user status (shared across all modules).
    // caching the failure result with no TTL caused discovery
    // sections to disappear for the entire SPA session after a single transient
    // error. Now we keep success results for the SPA session but only cache
    // negatives for 60 seconds so transient blips recover automatically.
    let cachedUserStatus = null;
    let cachedUserStatusAt = 0;
    const NEGATIVE_USER_STATUS_TTL_MS = 60 * 1000;

    // Cache for override rules
    let cachedOverrideRules = null;
    let overrideRulesCachedAt = 0;
    const OVERRIDE_RULES_TTL = 5 * 60 * 1000; // 5 minutes

    /**
     * Internal fetch helper — delegates to the shared core API client, which
     * owns the auth headers, retry/backoff, in-flight dedup, response cache
     * and concurrency limiting (formerly duplicated here).
     * @param {string} url - The fully-qualified URL to fetch.
     * @param {object} [options] - Optional settings (signal, skipCache, skipRetry, cacheKey).
     * @returns {Promise<any>} - The parsed JSON response.
     */
    async function managedFetch(url, options = {}) {
        return JE.core.api.fetch(url, options);
    }

    /**
     * Performs a GET request to the TMDB proxy endpoint.
     * @param {string} path - The TMDB API path (e.g., '/movie/123').
     * @param {object} [options] - Optional settings (signal, skipCache, skipRetry).
     * @returns {Promise<any>} - The JSON response from the server.
     */
    async function tmdbGet(path, options = {}) {
        const url = ApiClient.getUrl(`/JellyfinEnhanced/tmdb${path}`);
        const cacheKey = options.skipCache ? null : `tmdb:${path}`;
        return managedFetch(url, { ...options, cacheKey });
    }

    /**
     * Performs a GET request to the Seerr proxy endpoint.
     * @param {string} path - The API path (e.g., '/search?query=...').
     * @param {object} [options] - Optional settings (signal, skipCache, skipRetry).
     * @returns {Promise<any>} - The JSON response from the server.
     */
    async function get(path, options = {}) {
        const url = ApiClient.getUrl(`/JellyfinEnhanced/jellyseerr${path}`);
        const cacheKey = options.skipCache ? null : `jellyseerr:${path}`;
        return managedFetch(url, { ...options, cacheKey });
    }

    /**
     * Performs a POST request to the Seerr proxy endpoint.
     * @param {string} path - The API path (e.g., '/request').
     * @param {object} body - The JSON body to send with the request.
     * @returns {Promise<any>} - The server's response.
     */
    async function post(path, body) {
        // skipRetry: POSTs are not idempotent — never auto-retry them.
        return JE.core.api.plugin(`/jellyseerr${path}`, { method: 'POST', body, skipRetry: true });
    }

    /**
     * Invalidate Seerr/TMDB caches impacted by a successful request.
     * Keeps UI surfaces in sync without waiting for a hard refresh.
     * @param {number|string} tmdbId
     * @param {'movie'|'tv'} mediaType
     */
    function invalidateRequestCaches(tmdbId, mediaType) {
        if (!JE.requestManager) {
            return;
        }

        const id = String(tmdbId);
        const type = String(mediaType || '').toLowerCase();
        if (!id || (type !== 'movie' && type !== 'tv')) {
            return;
        }

        const patterns = [
            // Item detail responses used by modals/cards.
            `jellyseerr:/${type}/${id}`,
            // Generic result surfaces that may include this media item.
            'jellyseerr:/search?',
            'jellyseerr:/discover/',
            // Request lists and watchlist views can reflect new state.
            'jellyseerr:/request?',
            'jellyseerr:/watchlist?',
            'jellyseerr:/quota'
        ];

        // Movie requests can affect collection rendering.
        if (type === 'movie') {
            patterns.push(`tmdb:/movie/${id}`);
        }

        patterns.forEach(pattern => JE.requestManager.clearCacheMatching(pattern));
    }

    /**
     * Broadcast successful request events so all UI surfaces can update immediately.
     * @param {number|string} tmdbId
     * @param {'movie'|'tv'} mediaType
     * @param {boolean} is4k
     */
    function emitMediaRequested(tmdbId, mediaType, is4k = false) {
        document.dispatchEvent(new CustomEvent('jellyseerr-media-requested', {
            detail: { tmdbId: String(tmdbId), mediaType: String(mediaType || '').toLowerCase(), is4k: !!is4k }
        }));

        if (String(mediaType || '').toLowerCase() === 'tv') {
            document.dispatchEvent(new CustomEvent('jellyseerr-tv-requested', {
                detail: { tmdbId: String(tmdbId), mediaType: 'tv' }
            }));
        }
    }

    /**
     * Checks if the Seerr server is active and if the current user is linked.
     * Caches the result to avoid repeated API calls.
     * @returns {Promise<{active: boolean, userFound: boolean}>}
     */
    api.checkUserStatus = async function() {
        if (cachedUserStatus !== null) {
            // Successful result is sticky for the SPA session.
            if (cachedUserStatus.active && cachedUserStatus.userFound) {
                return cachedUserStatus;
            }
            // Negative result expires after 60s so a transient outage doesn't
            // permanently hide discovery.
            if (Date.now() - cachedUserStatusAt < NEGATIVE_USER_STATUS_TTL_MS) {
                return cachedUserStatus;
            }
        }

        try {
            const status = await get('/user-status', { skipCache: true });
            cachedUserStatus = status;
            cachedUserStatusAt = Date.now();
            // Surface the typed reason as a banner so users aren't left staring
            // at silently-hidden discovery sections.
            api.surfaceUserStatusBanner(status);
            return status;
        } catch (error) {
            console.warn(`${logPrefix} Status check failed:`, error);
            const fallback = {
                active: false,
                userFound: false,
                reason: error?.responseJSON?.code || 'unreachable',
                message: error?.responseJSON?.message
            };
            cachedUserStatus = fallback;
            cachedUserStatusAt = Date.now();
            api.surfaceUserStatusBanner(fallback);
            return fallback;
        }
    };

    /**
     * Surfaces a one-time banner toast describing why Seerr discovery is not
     * available. Skipped on success and on the "disabled" reason (no Seerr
     * configured, nothing to surface).
     */
    api.surfaceUserStatusBanner = function(status) {
        try {
            if (!status || (status.active && status.userFound)) return;
            if (status.reason === 'disabled') return;
            // Don't double-surface within a single session.
            if (window.__JE_userStatusBannerShown === status.reason) return;
            window.__JE_userStatusBannerShown = status.reason;

            const reasons = {
                blocked: 'Your administrator has disabled Seerr for your account.',
                unlinked: 'Your Seerr account isn\'t linked yet. Sign in to Seerr once to enable requests.',
                unreachable: 'Can\'t reach Seerr right now. Please try again in a moment.',
                no_user: 'Couldn\'t load your account. Try signing out and back in.'
            };
            // JE.toast renders via innerHTML. status.message comes
            // from SeerrHttpHelper.ToResponseShape, which uses UserMessage
            // (plain English, no URLs / cf-ray / proxy product names). Still
            // HTML-escape it before insertion as defence-in-depth.
            const rawMsg = status.message || reasons[status.reason] || 'Seerr is unavailable right now.';
            const msg = (typeof JE !== 'undefined' && typeof JE.escapeHtml === 'function')
                ? JE.escapeHtml(rawMsg)
                : String(rawMsg).replace(/[&<>"']/g, function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c];});
            if (typeof JE !== 'undefined' && typeof JE.toast === 'function') {
                JE.toast(`Seerr: ${msg}`, 6000);
            } else {
                console.warn(`${logPrefix} ${rawMsg}`);
            }
        } catch (e) {
            // Banner is best-effort; never break callers.
            console.debug(`${logPrefix} surfaceUserStatusBanner threw:`, e);
        }
    };

    /**
     * Clears the cached user status (called when user logs out or on page refresh).
     * Now also wired to navigation/hashchange so transient SPA-session blips
     * don't outlive the page they happened on.
     */
    api.clearUserStatusCache = function() {
        cachedUserStatus = null;
        cachedUserStatusAt = 0;
    };

    /**
     * Performs a search against the Seerr API.
     * @param {string} query - The search term.
     * @param {number} [page=1] - Page number for pagination.
     * @returns {Promise<{results: Array, page: number, totalPages: number, totalResults: number}>}
     */
    api.search = async function(query, page = 1, options = {}) {
        try {
            const lang = (navigator.language || 'en').split('-')[0];
            const { skipCache = false } = options;
            const data = await get(`/search?query=${encodeURIComponent(query)}&page=${page}&language=${lang}`, { skipCache });

            // Filter out people results before returning (immutable — don't mutate cached response)
            if (data.results) {
                const filteredResults = data.results.filter(result => result.mediaType !== 'person');
                return { ...data, results: filteredResults, totalResults: filteredResults.length };
            }

            return data;
        } catch (error) {
            console.error('%s Search failed for query "%s":', logPrefix, query, error);
            return { results: [] };
        }
    };

    /**
     * Fetches collection information for a movie from TMDB via proxy
     * @param {number} tmdbId
     * @returns {Promise<{id:number,name:string,posterPath?:string,backdropPath?:string}|null>}
     */
    api.fetchMovieCollection = async function(tmdbId) {
        try {
            // Try Seerr movie detail first (includes collection field directly)
            const jellyseerrRes = await get(`/movie/${tmdbId}`);
            if (jellyseerrRes?.collection) {
                const c = jellyseerrRes.collection;
                return {
                    id: c.id,
                    name: c.name,
                    posterPath: c.posterPath,
                    backdropPath: c.backdropPath
                };
            }

            // Fallback to TMDB proxy
            if (JE.pluginConfig?.TmdbEnabled) {
                const res = await tmdbGet(`/movie/${tmdbId}`);
                const belongs = res?.belongs_to_collection || res?.belongsToCollection;
                if (belongs && (belongs.id || belongs.tmdbId)) {
                    return {
                        id: belongs.id || belongs.tmdbId,
                        name: belongs.name,
                        posterPath: belongs.poster_path || belongs.posterPath,
                        backdropPath: belongs.backdrop_path || belongs.backdropPath
                    };
                }
            }
            return null;
        } catch (error) {
            console.debug(`${logPrefix} No collection found for movie ${tmdbId}:`, error);
            return null;
        }
    };

    /**
     * Adds collection membership information to movie items in search results
     * @param {Array} results
     * @returns {Promise<Array>}
     */
    api.addCollections = async function(results) {
        if (!results || results.length === 0) return results;

        return Promise.all(results.map(async (item) => {
            if (item.mediaType !== 'movie') return item;
            try {
                const collection = await api.fetchMovieCollection(item.id);
                if (collection) return { ...item, collection };
            } catch (e) {
                // ignore per-movie errors
            }
            return item;
        }));
    };

    /**
     * Fetches detailed information for a specific TV show from Seerr.
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
     * Fetches season detail with episodes from Seerr.
     * @param {number} tmdbId - The TMDB ID of the TV show.
     * @param {number} seasonNumber - The season number.
     * @returns {Promise<object|null>}
     */
    api.fetchTvSeasonDetails = async function(tmdbId, seasonNumber) {
        try {
            return await get(`/tv/${tmdbId}/season/${seasonNumber}`);
        } catch (error) {
            console.debug(`${logPrefix} Failed to fetch season ${seasonNumber} for TMDB ID ${tmdbId}:`, error);
            return null;
        }
    };

    /**
     * Fetches TV show details from TMDB directly (bypasses Seerr metadata provider).
     * Useful for getting season air dates when Seerr uses TheTVDB (which omits them).
     * @param {number} tmdbId - The TMDB ID of the TV show.
     * @returns {Promise<object|null>}
     */
    api.fetchTmdbTvDetails = async function(tmdbId) {
        try {
            return await tmdbGet(`/tv/${tmdbId}`);
        } catch (error) {
            console.debug(`${logPrefix} Failed to fetch TMDB TV details for ID ${tmdbId}:`, error);
            return null;
        }
    };

    /**
     * Fetches override rules from Seerr.
     * @returns {Promise<Array>}
     */
    api.fetchOverrideRules = async function() {
        if (cachedOverrideRules !== null && Date.now() - overrideRulesCachedAt < OVERRIDE_RULES_TTL) {
            return cachedOverrideRules;
        }
        try {
            const rules = await get('/overrideRule');
            cachedOverrideRules = Array.isArray(rules) ? rules : [];
            overrideRulesCachedAt = Date.now();
            return cachedOverrideRules;
        } catch (error) {
            console.error(`${logPrefix} Failed to fetch override rules:`, error);
            return cachedOverrideRules || [];
        }
    };

    /**
     * Gets the current Seerr user ID from the user status.
     * @returns {Promise<string|null>} - Seerr user ID or null if not found.
     */
    api.getCurrentJellyseerrUserId = async function() {
        try {
            const status = await api.checkUserStatus();
            return (status && status.jellyseerrUserId) ? String(status.jellyseerrUserId) : null;
        } catch (error) {
            console.warn(`${logPrefix} Failed to get current Seerr user ID:`, error);
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
                // Check language condition (pipe-separated ISO codes)
                if (rule.language && mediaData.originalLanguage) {
                    const allowedLanguages = rule.language.split('|').map(l => l.trim().toLowerCase());
                    if (!allowedLanguages.includes(mediaData.originalLanguage.toLowerCase())) {
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
                        continue;
                    }
                }

                // Check user condition
                if (rule.users) {
                    const currentUserId = await api.getCurrentJellyseerrUserId();
                    if (currentUserId) {
                        const allowedUsers = rule.users.split(',').map(u => u.trim());
                        if (!allowedUsers.includes(currentUserId)) {
                            continue;
                        }
                    } else {
                        // If we can't determine the user ID, skip this rule
                        continue;
                    }
                }

                console.debug(`${logPrefix} Matched override rule ${rule.id}:`, {
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
                    // Convert tags to array format that Seerr expects
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
                console.debug(`${logPrefix} Applying override rule settings:`, overrideSettings);
                advancedSettings = { ...overrideSettings };
            }
        }

        const body = {
            mediaType,
            mediaId: parseInt(tmdbId),
            ...advancedSettings,
            ...(mediaType === 'tv' ? { seasons: 'all' } : {}),
            ...(is4k ? { is4k: true } : {})
        };

        const result = await post('/request', body);

        // Add to watchlist after successful request
        if (result) {
            invalidateRequestCaches(tmdbId, mediaType);
            emitMediaRequested(tmdbId, mediaType, is4k);
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
     * @param {boolean} [is4k=false] - Whether this is a 4K request.
     * @returns {Promise<any>}
     */
    api.requestTvSeasons = async function(tmdbId, seasonNumbers, advancedSettings = {}, mediaData = null, is4k = false) {
        // Apply override rules if no advanced settings are provided and media data is available
        if (Object.keys(advancedSettings).length === 0 && mediaData) {
            const overrideSettings = await api.evaluateOverrideRules(mediaData, 'tv', is4k);
            if (overrideSettings) {
                console.debug(`${logPrefix} Applying override rule settings for TV seasons:`, overrideSettings);
                advancedSettings = { ...overrideSettings };
            }
        }

        const body = {
            mediaType: 'tv',
            mediaId: parseInt(tmdbId),
            seasons: seasonNumbers,
            ...advancedSettings,
            ...(is4k ? { is4k: true } : {})
        };
        const result = await post('/request', body);

        // Add to watchlist after successful request
        if (result) {
            invalidateRequestCaches(tmdbId, 'tv');
            emitMediaRequested(tmdbId, 'tv', is4k);
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
     * Fetches existing issues for a Seerr media (by TMDB id + type).
     * @param {number|string} tmdbId
     * @param {'movie'|'tv'} mediaType
     * @param {object} [options]
     * @param {number} [options.take=20]
     * @param {number} [options.skip=0]
     * @param {'open'|'resolved'|'all'} [options.filter='open']
     * @returns {Promise<{pageInfo?: object, results: Array}>}
     */
    api.fetchIssuesForMedia = async function(tmdbId, mediaType, options = {}) {
        const { take = 20, skip = 0, filter = 'open', sort = 'added' } = options;
        try {
            const query = new URLSearchParams({
                take: String(take),
                skip: String(skip),
                filter,
                sort
            });

            const res = await get(`/issue?${query.toString()}`);
            const issues = res && Array.isArray(res.results) ? res.results : [];

            const filtered = issues.filter(issue => {
                const media = issue.media || {};
                const tmdbMatch = media.tmdbId && Number(media.tmdbId) === Number(tmdbId);
                const typeMatch = (media.mediaType || '').toLowerCase() === (mediaType || '').toLowerCase();
                return tmdbMatch && typeMatch;
            });

            return { ...res, results: filtered };
        } catch (error) {
            console.error(`${logPrefix} Failed to fetch issues for ${mediaType} ${tmdbId}:`, error);
            return { results: [] };
        }
    };

    /**
     * Fetch a single issue by ID, including full comment details.
     * @param {number} issueId
     * @returns {Promise<object|null>}
     */
    api.fetchIssueById = async function(issueId) {
        try {
            const res = await get(`/issue/${issueId}`);
            return res || null;
        } catch (error) {
            console.warn(`${logPrefix} Failed to fetch issue ${issueId}:`, error);
            return null;
        }
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

            const validServers = await Promise.all(
                serverList
                    .filter(server => server && typeof server.id === 'number')
                    .map(async (server) => {
                        try {
                            const details = await get(`/${serverType}/${server.id}`);
                            return {
                                ...server,
                                qualityProfiles: details.profiles || [],
                                rootFolders: details.rootFolders || []
                            };
                        } catch (e) {
                            console.error(`${logPrefix} Could not fetch details for ${serverType} server ID ${server.id}:`, e);
                            return { ...server, qualityProfiles: [], rootFolders: [] };
                        }
                    })
            );
            return { servers: validServers, tags: [] };
        } catch (error) {
            console.error(`${logPrefix} Failed to fetch ${serverType} servers:`, error);
            return { servers: [], tags: [] };
        }
    };


    // Returns { movie, tv } quota with nextResetAt, or null when disabled / on failure.
    api.fetchUserQuota = async function(options = {}) {
        if (window.JellyfinEnhanced?.pluginConfig?.JellyseerrShowQuotaInfo === false) {
            return null;
        }
        try {
            return await get('/quota', options);
        } catch (error) {
            // 404 = user not linked, 503 = Seerr disabled — both expected, debug only.
            // Anything else (5xx, network, parse) is unexpected and admins need to see it.
            const expected = error?.status === 404 || error?.status === 503;
            (expected ? console.debug : console.warn)(`${logPrefix} Quota fetch failed:`, error);
            return null;
        }
    };

    /**
     * Fetches Seerr request settings (partial requests + special episodes).
     * @returns {Promise<{partialRequestsEnabled: boolean, enableSpecialEpisodes: boolean}>}
     */
    // keep last-known good settings across a Seerr outage so
    // the request modal doesn't silently flip to whole-season UI when admin
    // had partial requests enabled. The backend now returns 503 on outage
    // (was 200+false). Cache the last successful response in module scope.
    let _lastRequestSettings = null;
    api.fetchRequestSettings = async function() {
        try {
            const result = await get('/settings/partial-requests', { skipCache: true });
            const settings = {
                partialRequestsEnabled: !!(result && result.partialRequestsEnabled),
                enableSpecialEpisodes: !!(result && result.enableSpecialEpisodes)
            };
            _lastRequestSettings = settings;
            return settings;
        } catch (error) {
            console.warn(`${logPrefix} Failed to fetch request settings:`, error);
            // Return last known good if we have one — better than flipping the
            // UI to "no partial requests" when Seerr is briefly unreachable.
            if (_lastRequestSettings) return _lastRequestSettings;
            return { partialRequestsEnabled: false, enableSpecialEpisodes: false };
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

            // WatchlistMonitor service automatically handles adding requested items to watchlist
            console.debug(`${logPrefix} Request tracked - WatchlistMonitor will automatically add TMDB ${tmdbId} (${mediaType}) to watchlist when it appears in library`);
            return true;
        } catch (error) {
            console.error(`${logPrefix} Error queuing item for watchlist:`, error);
            return false;
        }
    };

    /**
     * Reports an issue for a media item to Seerr.
     * @param {number} mediaId - The TMDB/TVDB ID of the media.
     * @param {string} mediaType - 'movie' or 'tv'.
     * @param {string} problemType - Type of issue (e.g., 'no_season', 'episode_missing', etc.).
     * @param {string} [message=''] - Optional description of the issue.
     * @returns {Promise<any>} - The response from Seerr.
     */
    /**
     * Maps problem types to Seerr issue types and season/episode info
     * Seerr uses: VIDEO (1), AUDIO (2), SUBTITLES (3), OTHER (4)
     */
    // NOTE: Previous mappings for textual problem types were removed —
    // the current implementation expects a numeric issueType (1..4)
    // to be provided by the UI. Keep logic in `api.reportIssue` that
    // parses the numeric value and forwards it to Seerr.

    api.reportIssue = async function(mediaId, mediaType, problemType, message = '', problemSeason = 0, problemEpisode = 0) {
        try {
            // problemType is now a numeric issue type (1, 2, 3, or 4) from the form
            const issueType = parseInt(problemType) || 4;

            // Fetch the correct internal media id from Seerr

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
            console.debug(`${logPrefix} Retrieved internal media id for issue report:`, internalId);

            const body = {
                mediaId: parseInt(internalId),
                issueType: issueType,
                problemSeason: parseInt(problemSeason) || 0,
                problemEpisode: parseInt(problemEpisode) || 0,
                message: message || ''
            };

            console.debug(`${logPrefix} Sending issue report with body:`, body);
            const result = await post('/issue', body);
            console.debug(`${logPrefix} Issue reported for Seerr media ID ${internalId} (TMDB ${mediaId}, ${mediaType}): ${problemType}`);
            return result;
        } catch (error) {
            console.error(`${logPrefix} Failed to report issue for TMDB ID ${mediaId}:`, error);
            throw error;
        }
    };

    /**
     * Fetches related media (similar or recommendations) for a given TMDB ID.
     * @param {string} mediaType - 'movie' or 'tv'.
     * @param {number} tmdbId - The TMDB ID.
     * @param {string} relation - 'similar' or 'recommendations'.
     * @param {number|object} [pageOrOptions=1] - Page number or options object with page property.
     * @returns {Promise<{results: Array, page: number, totalPages: number}>}
     */
    async function fetchRelated(mediaType, tmdbId, relation, pageOrOptions = 1) {
        const page = typeof pageOrOptions === 'number' ? pageOrOptions : (pageOrOptions.page || 1);
        const options = typeof pageOrOptions === 'object' ? pageOrOptions : {};
        try {
            return await get(`/${mediaType}/${tmdbId}/${relation}?page=${page}`, options);
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            console.error(`${logPrefix} Failed to fetch ${relation} ${mediaType} for TMDB ID ${tmdbId}:`, error);
            return { results: [], page: 1, totalPages: 0, totalResults: 0 };
        }
    }

    api.fetchSimilarMovies = (tmdbId, pageOrOptions) => fetchRelated('movie', tmdbId, 'similar', pageOrOptions);
    api.fetchRecommendedMovies = (tmdbId, pageOrOptions) => fetchRelated('movie', tmdbId, 'recommendations', pageOrOptions);
    api.fetchSimilarTvShows = (tmdbId, pageOrOptions) => fetchRelated('tv', tmdbId, 'similar', pageOrOptions);
    api.fetchRecommendedTvShows = (tmdbId, pageOrOptions) => fetchRelated('tv', tmdbId, 'recommendations', pageOrOptions);

    /**
     * Fetches detailed information for a specific movie from Seerr.
     * @param {number} tmdbId - The TMDB ID of the movie.
     * @returns {Promise<object|null>}
     */
    api.fetchMovieDetails = async function(tmdbId) {
        try {
            return await get(`/movie/${tmdbId}`);
        } catch (error) {
            console.error(`${logPrefix} Failed to fetch movie details for TMDB ID ${tmdbId}:`, error);
            return null;
        }
    };

    /**
     * Fetches collection details from Seerr.
     * @param {number} collectionId - The TMDB collection ID.
     * @returns {Promise<object|null>}
     */
    api.fetchCollectionDetails = async function(collectionId) {
        try {
            return await get(`/collection/${collectionId}`);
        } catch (error) {
            console.error(`${logPrefix} Failed to fetch collection details for ID ${collectionId}:`, error);
            return null;
        }
    };

    /**
     * Fetches genre slider data (genres with backdrop images) from Seerr.
     * @param {'movie'|'tv'} mediaType
     * @returns {Promise<Array>}
     */
    api.fetchGenreSlider = async function(mediaType) {
        const type = mediaType === 'movie' ? 'movie' : 'tv';
        try {
            return await get(`/discover/genreslider/${type}`);
        } catch (error) {
            console.error(`${logPrefix} Failed to fetch genre slider for ${type}:`, error);
            return [];
        }
    };

    /**
     * Resolves the Seerr base URL based on URL mappings or falls back to the default base URL.
     * This function checks if there are URL mappings configured and matches the current Jellyfin server URL
     * against the mappings to determine the appropriate Seerr URL.
     * @returns {string} - The resolved Seerr base URL (without trailing slash), or empty string if none configured.
     */
    api.resolveJellyseerrBaseUrl = function() {
        let baseUrl = '';

        // Check if URL mappings are configured
        if (JE?.pluginConfig?.JellyseerrUrlMappings) {
            const serverAddress = (typeof ApiClient !== 'undefined' && ApiClient.serverAddress)
                ? ApiClient.serverAddress()
                : window.location.origin;

            const currentUrl = serverAddress.replace(/\/+$/, '').toLowerCase();
            const mappings = JE.pluginConfig.JellyseerrUrlMappings.toString().split('\n').map(line => line.trim()).filter(Boolean);

            for (const mapping of mappings) {
                const [jellyfinUrl, jellyseerrUrl] = mapping.split('|').map(s => s.trim());
                if (!jellyfinUrl || !jellyseerrUrl) continue;

                const normalizedJellyfinUrl = jellyfinUrl.replace(/\/+$/, '').toLowerCase();

                if (currentUrl === normalizedJellyfinUrl) {
                    baseUrl = jellyseerrUrl.replace(/\/$/, '');
                    break;
                }
            }
        }

        // Fallback to the default base URL if no mapping matched
        if (!baseUrl && JE?.pluginConfig?.JellyseerrBaseUrl) {
            baseUrl = JE.pluginConfig.JellyseerrBaseUrl.toString().trim().replace(/\/$/, '');
        }

        return baseUrl;
    };

    // Expose the API module on the global JE object
    JE.jellyseerrAPI = api;

})(window.JellyfinEnhanced);