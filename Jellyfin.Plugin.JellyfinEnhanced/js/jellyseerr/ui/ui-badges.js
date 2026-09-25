// /js/jellyseerr/ui/ui-badges.js
// Card badge helpers: status badge, media-type/collection badges and
// streaming-provider icons.
(function(JE) {
    'use strict';

    const ui = JE.jellyseerrUI = JE.jellyseerrUI || {};
    JE.internals = JE.internals || {};
    // Shared state is seeded by ui-icons.js, which plugin.js loads first
    // in this group.
    const internal = JE.internals.jellyseerrUi;
    const escapeHtml = JE.escapeHtml;
    const DisplayStatus = JE.seerrStatus.DISPLAY;
    const logPrefix = '🪼 Jellyfin Enhanced: Seerr UI:';

    /**
     * True for a TMDB image path safe to append to an image.tmdb.org URL (and to
     * interpolate into a CSS url()): a leading-slash file name of a known image
     * type, as TMDB always returns (e.g. "/abc.jpg").
     * @param {*} p
     * @returns {boolean}
     */
    const isSafeTmdbImagePath = (p) => typeof p === 'string'
        && /^\/[A-Za-z0-9_\-\.]+\.(jpg|jpeg|png|webp|avif)$/i.test(p);

    /**
     * Sets the status badge icon based on the item's media status.
     * @param {HTMLElement} card - The card element.
     * @param {Object} item - The search result item.
     */
    function setStatusBadge(card, item) {
        const badge = card.querySelector('.jellyseerr-status-badge');
        if (!badge || !item.mediaInfo) {
            if (badge) badge.style.display = 'none';
            return;
        }

        // Determine status based on media type
        let status;
        if (item.mediaType === 'tv' && item.mediaInfo.seasons) {
            const seasonAnalysis = internal.analyzeSeasonStatuses(item.mediaInfo.seasons);
            status = seasonAnalysis ? seasonAnalysis.overallStatus : item.mediaInfo.status;
        } else {
            status = item.mediaInfo.status || 1;
        }

        const hasDownloads = (item.mediaInfo?.downloadStatus?.length > 0 || item.mediaInfo?.downloadStatus4k?.length > 0);
        const displayStatus = JE.seerrStatus.resolveDisplayStatus(status, hasDownloads);
        const badgeConfig = JE.seerrStatus.getBadgeConfig(displayStatus);

        if (!badgeConfig) {
            badge.style.display = 'none';
            return;
        }

        badge.innerHTML = badgeConfig.icon;
        badge.className = `jellyseerr-status-badge ${badgeConfig.cssClass}`;
        badge.style.display = 'flex';

        if (displayStatus === DisplayStatus.PARTIAL && item.mediaType === 'tv' && hasDownloads) {
            badge.style.cursor = 'pointer';
            internal.addDownloadProgressHover(badge, item);
        }
    }

    // ---- Batched watch-provider lookups ---------------------------------------
    // Cards used to call /tmdb/{type}/{id}/watch/providers one by one, and each
    // response carried every region's providers (~5-20 KB). Lookups that fire
    // close together (a screenful of cards becoming visible) are instead queued
    // for PROVIDER_BATCH_DELAY_MS and sent as one /watch-providers request that
    // returns only the region's flat-rate list per title. Each title's list is
    // kept in the core API cache (providers:{region}:{type}:{id}), so re-renders
    // don't refetch. Every card waits on its own AbortSignal: a released card
    // just stops waiting, and a batch request is aborted only once no card is
    // waiting on any of its titles.
    const PROVIDER_BATCH_DELAY_MS = 50;
    const PROVIDER_BATCH_MAX = 100; // server limit per request
    // "{region}:{type}:{id}" -> { lookupKey, region, key, cacheKey, waiters, batch }
    const providerLookups = new Map();
    let queuedLookups = [];
    let providerFlushTimer = null;

    /**
     * The admin's DEFAULT_REGION as a two-letter upper-case code (or 'US').
     * @returns {string}
     */
    function providerRegion() {
        const region = String(JE.pluginConfig?.DEFAULT_REGION || 'US').trim().toUpperCase();
        return /^[A-Z]{2}$/.test(region) ? region : 'US';
    }

    /**
     * @returns {Error} An AbortError, as fetch() would reject with.
     */
    function providerAbortError() {
        const error = new Error('Request aborted');
        error.name = 'AbortError';
        return error;
    }

    /**
     * Keeps only well-formed provider entries from a batch result.
     * @param {*} list - One title's entry from the batch response.
     * @returns {Array<Object>|null} The providers, or null when unavailable.
     */
    function sanitizeProviders(list) {
        if (!Array.isArray(list)) return null;
        return list.filter(p => p && typeof p.provider_name === 'string' && isSafeTmdbImagePath(p.logo_path));
    }

    /**
     * Resolves or rejects every card still waiting on a lookup and forgets it.
     * @param {Object} lookup
     * @param {Function} settle - Called with each waiter.
     */
    function settleLookup(lookup, settle) {
        if (providerLookups.get(lookup.lookupKey) === lookup) providerLookups.delete(lookup.lookupKey);
        for (const waiter of [...lookup.waiters]) {
            lookup.waiters.delete(waiter);
            waiter.detach();
            settle(waiter);
        }
    }

    /**
     * Called when a card stops waiting: drops a queued lookup nobody wants, and
     * aborts a batch request once none of its titles has a waiting card.
     * @param {Object} lookup
     */
    function releaseLookup(lookup) {
        if (lookup.waiters.size > 0) return;
        const batch = lookup.batch;
        if (!batch) {
            providerLookups.delete(lookup.lookupKey);
            queuedLookups = queuedLookups.filter(l => l !== lookup);
            return;
        }
        if (batch.lookups.some(l => l.waiters.size > 0)) return;
        batch.lookups.forEach(l => {
            if (providerLookups.get(l.lookupKey) === l) providerLookups.delete(l.lookupKey);
        });
        batch.controller.abort();
    }

    /**
     * Sends queued lookups (one region, at most PROVIDER_BATCH_MAX titles) as
     * one request and fans the per-title results out to the waiting cards.
     */
    function flushProviderBatch() {
        clearTimeout(providerFlushTimer);
        providerFlushTimer = null;
        if (queuedLookups.length === 0) return;
        const region = queuedLookups[0].region;
        const lookups = [];
        const rest = [];
        for (const lookup of queuedLookups) {
            (lookup.region === region && lookups.length < PROVIDER_BATCH_MAX ? lookups : rest).push(lookup);
        }
        queuedLookups = rest;
        if (rest.length > 0) providerFlushTimer = setTimeout(flushProviderBatch, PROVIDER_BATCH_DELAY_MS);

        const batch = { controller: new AbortController(), lookups };
        lookups.forEach(l => { l.batch = batch; });
        // Identity epoch at request start: a response that lands after a user
        // switch is still handed to the cards that asked, but not cached.
        const epoch = JE.session?.getEpoch?.();
        const items = lookups.map(l => l.key).join(',');
        JE.core.api.plugin(`/watch-providers?items=${items}&region=${region}`, { signal: batch.controller.signal, priority: 'low' })
            .then((data) => {
                const results = (data && typeof data.results === 'object' && data.results) || {};
                const cacheable = !JE.session?.isCurrent || JE.session.isCurrent(epoch);
                for (const lookup of lookups) {
                    const providers = sanitizeProviders(results[lookup.key]);
                    if (providers && cacheable) JE.core.api.manager?.setCache?.(lookup.cacheKey, providers);
                    settleLookup(lookup, w => w.resolve(providers));
                }
            }, (error) => {
                // Aborted because every card left: nobody is waiting, nothing to report.
                if (batch.controller.signal.aborted) return;
                // Dropped by the transport (user switch, low-priority queue full):
                // expected, so no warning; the waiting cards just stay without icons.
                // Anything else is a failure, logged once per batch.
                if (error?.name !== 'AbortError') {
                    console.warn(`${logPrefix} Could not fetch provider icons for ${lookups.length} title(s):`, error);
                }
                lookups.forEach(lookup => settleLookup(lookup, w => w.resolve(null)));
            });
    }

    /**
     * One title's flat-rate providers for the admin's region, from the client
     * cache or the next batch request.
     * @param {string} mediaType - 'movie' or 'tv'
     * @param {string|number} tmdbId
     * @param {AbortSignal} [signal] - Stops this caller waiting (rejects with AbortError).
     * @returns {Promise<Array<Object>|null>} Providers in TMDB order, or null when unavailable.
     */
    function getFlatrateProviders(mediaType, tmdbId, signal) {
        const region = providerRegion();
        const key = `${mediaType}:${tmdbId}`;
        const cacheKey = `providers:${region}:${key}`;
        const cached = JE.core.api.manager?.getCached?.(cacheKey);
        if (cached) return Promise.resolve(cached);
        if (signal?.aborted) return Promise.reject(providerAbortError());

        return new Promise((resolve, reject) => {
            const lookupKey = `${region}:${key}`;
            let lookup = providerLookups.get(lookupKey);
            if (!lookup) {
                lookup = { lookupKey, region, key, cacheKey, waiters: new Set(), batch: null };
                providerLookups.set(lookupKey, lookup);
                queuedLookups.push(lookup);
                if (queuedLookups.length >= PROVIDER_BATCH_MAX) {
                    flushProviderBatch();
                } else if (!providerFlushTimer) {
                    providerFlushTimer = setTimeout(flushProviderBatch, PROVIDER_BATCH_DELAY_MS);
                }
            }
            const onAbort = () => {
                lookup.waiters.delete(waiter);
                reject(providerAbortError());
                releaseLookup(lookup);
            };
            const waiter = {
                resolve,
                reject,
                detach: () => { if (signal) signal.removeEventListener('abort', onAbort); }
            };
            lookup.waiters.add(waiter);
            if (signal) signal.addEventListener('abort', onAbort, { once: true });
        });
    }

    /**
     * Fetches streaming provider icons from the TMDB API and adds them to a specified container element on a Seerr poster.
     * This function is called only if the "Show Elsewhere on Seerr" setting is enabled and a TMDB API key is present.
     * It retrieves the default region's flat-rate providers (batched across cards) and applies the filters configured in the Elsewhere plugin settings.
     *
     * @async
     * @function fetchProviderIcons
     * @param {HTMLElement} container - The DOM element where the provider icons will be appended.
     * @param {string|number} tmdbId - The The Movie Database (TMDB) ID for the movie or TV show.
     * @param {string} mediaType - The type of media, either 'movie' or 'tv'.
     * @param {AbortSignal} [signal] - Cancels the lookup (e.g. when the card is torn down).
     * @returns {Promise<void>} A promise that resolves when the icons have been fetched and added, or if the process fails.
     */
    async function fetchProviderIcons(container, tmdbId, mediaType, signal) {
        if (!container || !tmdbId || !mediaType) return;

        // Early exit if TMDB is not configured - prevents slow/failing API calls
        if (!JE.pluginConfig?.TmdbEnabled) {
            return;
        }

        const DEFAULT_PROVIDERS = JE.pluginConfig.DEFAULT_PROVIDERS ? JE.pluginConfig.DEFAULT_PROVIDERS.replace(/'/g, '').replace(/\n/g, ',').split(',').map(s => s.trim()).filter(s => s) : [];
        const IGNORE_PROVIDERS = JE.pluginConfig.IGNORE_PROVIDERS ? JE.pluginConfig.IGNORE_PROVIDERS.replace(/'/g, '').replace(/\n/g, ',').split(',').map(s => s.trim()).filter(s => s) : [];

        try {
            // Batched with other cards' lookups and cached per title (see
            // getFlatrateProviders); a failed batch is logged there once and
            // resolves to null here, so the card just stays without icons.
            let providers = await getFlatrateProviders(mediaType, tmdbId, signal);
            // A deferred (signalled) lookup only starts for an on-screen card, so a
            // detached container means the card was torn down meanwhile. Unsignalled
            // callers may fetch before the card is attached, so skip the check there.
            if (signal && !container.isConnected) return;

            if (providers && providers.length > 0) {

                // 1. If a default provider list is set, only include providers from that list.
                if (DEFAULT_PROVIDERS.length > 0) {
                    providers = providers.filter(provider => DEFAULT_PROVIDERS.includes(provider.provider_name));
                }

                // 2. If an ignore list is set, exclude any providers that match.
                if (IGNORE_PROVIDERS.length > 0) {
                    try {
                        const ignorePatterns = IGNORE_PROVIDERS.map(pattern => new RegExp(pattern, 'i'));
                        providers = providers.filter(provider =>
                            !ignorePatterns.some(regex => regex.test(provider.provider_name))
                        );
                    } catch (e) {
                        console.error(`${logPrefix} Invalid regex in IGNORE_PROVIDERS setting.`, e);
                    }
                }

                // Only build image URLs from well-formed logo paths.
                providers = providers.filter(provider => isSafeTmdbImagePath(provider.logo_path));

                if (providers.length > 0) {
                    providers.slice(0, 4).forEach(provider => { // Limit to max 4 icons to avoid clutter
                        const img = document.createElement('img');
                        // Decorative, low-priority logos: never compete with posters.
                        // width/height give the (square) w92 logo's aspect ratio so
                        // space is reserved before it loads; CSS sets the rendered size.
                        img.loading = 'lazy';
                        img.decoding = 'async';
                        if ('fetchPriority' in img) img.fetchPriority = 'low';
                        img.width = 92;
                        img.height = 92;
                        img.alt = provider.provider_name || '';
                        img.src = `https://image.tmdb.org/t/p/w92${provider.logo_path}`;
                        img.title = provider.provider_name;
                        // Drop logos that fail to load; hide the strip if none remain.
                        img.onerror = () => {
                            img.remove();
                            if (container.childElementCount === 0) container.classList.remove('has-icons');
                        };
                        container.appendChild(img);
                    });

                    if (container.childElementCount > 0) {
                        container.classList.add('has-icons');
                    }
                }
            }
        } catch (error) {
            // Cancelled by the caller (card released) or dropped from the queue on a
            // user switch: expected, not a failure.
            if ((signal && signal.aborted) || error?.name === 'AbortError') return;
            console.warn(`${logPrefix} Could not fetch provider icons for TMDB ID ${tmdbId}:`, error);
        }
    }

    /**
     * Adds media type badge to card.
     * @param {HTMLElement} card - Card element.
     * @param {Object} item - Media item data.
     */
    function addMediaTypeBadge(card, item) {
        if (item.mediaType === 'movie' || item.mediaType === 'tv' || item.mediaType === 'collection') {
            const imageContainer = card.querySelector('.cardImageContainer');
            if (imageContainer) {
                const badge = document.createElement('div');
                badge.className = 'jellyseerr-media-badge';
                if (item.mediaType === 'movie') {
                    badge.classList.add('jellyseerr-media-badge-movie');
                    badge.textContent = JE.t('jellyseerr_card_badge_movie');
                } else if (item.mediaType === 'tv') {
                    badge.classList.add('jellyseerr-media-badge-series');
                    badge.textContent = JE.t('jellyseerr_card_badge_series');
                } else {
                    badge.classList.add('jellyseerr-media-badge-collection');
                    badge.textContent = JE.t('jellyseerr_card_badge_collection');
                }
                imageContainer.appendChild(badge);
            }
        }
    }

    // Adds a small badge indicating the movie belongs to a collection; clicking opens the request modal
    function addCollectionMembershipBadge(card, item) {
        if (!item.collection || item.mediaType !== 'movie') return;
        const imageContainer = card.querySelector('.cardImageContainer');
        if (!imageContainer) return;
        const badge = document.createElement('div');
        badge.className = 'jellyseerr-collection-badge';
        badge.innerHTML = `<span class="material-icons">collections</span><span>${escapeHtml(item.collection.name) || JE.t('jellyseerr_card_badge_collection')}</span>`; // collection name escaped
        badge.title = `Part of ${item.collection.name || 'collection'}`;
        badge.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            ui.showCollectionRequestModal(item.collection.id, item.collection.name, item);
        });
        imageContainer.appendChild(badge);
    }
    internal.setStatusBadge = setStatusBadge;
    internal.fetchProviderIcons = fetchProviderIcons;
    internal.isSafeTmdbImagePath = isSafeTmdbImagePath;
    internal.addMediaTypeBadge = addMediaTypeBadge;
    internal.addCollectionMembershipBadge = addCollectionMembershipBadge;

})(window.JellyfinEnhanced);
