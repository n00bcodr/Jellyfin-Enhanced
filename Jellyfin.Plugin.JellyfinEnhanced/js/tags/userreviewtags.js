// /js/tags/userreviewtags.js
// Adds the current user's personal rating (person_heart icon) to the rating
// tag overlay on poster cards. Piggybacks on the ratingTagsEnabled setting —
// no separate toggle needed. Shows X when rated, "—" when not (unless
// ShowUserRatingDash is false in admin config).
(function(JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced: User Review Tags:';

    // Per-session cache: "mediaType:tmdbKey" → rating (1-5 or null). The media
    // type is part of the key because a movie and a series can share a TMDB id.
    const _reviewCache = new Map();
    // In-flight deduplication, same keys
    const _inFlight = new Map();
    // Keys whose batch failed (not aborted) → time (ms) until which they
    // resolve to null without a request. Stops a persistently failing server
    // (e.g. a corrupt reviews.json) from getting a new, transport-retried
    // batch on every tag-pipeline render; after the window they refetch.
    /** @type {Map<string, number>} */
    const _failedUntil = new Map();
    const FAILURE_BACKOFF_MS = 60 * 1000;

    // Ratings are fetched in batches: every key requested within one short
    // window goes out as a single GET /reviews/ratings?keys=… instead of one
    // GET /reviews/{mediaType}/{tmdbKey} per poster card.
    const BATCH_MAX_KEYS = 200; // server-side limit per request
    const BATCH_WINDOW_MS = 30;
    // Same shape the server validates (IsValidTmdbKey); anything else could
    // never have a review, so it resolves to null without a request.
    const TMDB_KEY_RE = /^\d+(:s\d+(:e\d+)?)?$/;
    /** @type {Map<string, {promise: Promise<number|null|undefined>|null, resolve: (value: number|null|undefined) => void}>} Keyed like _reviewCache. */
    const _queue = new Map();
    /** @type {ReturnType<typeof setTimeout>|null} */
    let _flushTimer = null;
    /** @type {Set<AbortController>} */
    const _batchControllers = new Set();

    /**
     * Send every queued key in one request and settle each key's promise.
     * On failure the keys resolve to null (a dash) without being cached and
     * are backed off for FAILURE_BACKOFF_MS before a retry. An abort (user
     * switch, or the low-priority queue dropping the request) resolves them
     * to undefined so nothing is rendered; the next render refetches.
     */
    async function flushQueue() {
        if (_flushTimer !== null) {
            clearTimeout(_flushTimer);
            _flushTimer = null;
        }
        if (_queue.size === 0) return;

        const batch = Array.from(_queue.entries());
        _queue.clear();

        // Ratings are filtered per viewer (hidden/disabled authors, self
        // reviews, admin moderation), so a batch that settles after a user
        // switch must not write into the new user's cache.
        const epoch = JE.session ? JE.session.getEpoch() : 0;
        const isCurrent = () => !JE.session || JE.session.isCurrent(epoch);
        const controller = new AbortController();
        _batchControllers.add(controller);

        /**
         * @param {string} cacheKey - "mediaType:tmdbKey"
         * @param {{promise: Promise<number|null|undefined>|null, resolve: (value: number|null|undefined) => void}} entry
         * @param {number|null|undefined} value
         * @param {boolean} cacheable
         */
        const settle = (cacheKey, entry, value, cacheable) => {
            if (isCurrent()) {
                if (cacheable) {
                    _reviewCache.set(cacheKey, value);
                    _failedUntil.delete(cacheKey);
                }
                if (_inFlight.get(cacheKey) === entry.promise) _inFlight.delete(cacheKey);
            }
            entry.resolve(value);
        };

        try {
            const keys = batch.map(([cacheKey]) => cacheKey).join(',');
            const data = await JE.core.api.plugin(`/reviews/ratings?keys=${encodeURIComponent(keys)}`, {
                signal: controller.signal,
                priority: 'low'
            });
            const ratings = (data && typeof data.ratings === 'object' && data.ratings) || {};
            for (const [cacheKey, entry] of batch) {
                // The response is keyed by the same "mediaType:tmdbKey" strings.
                const hit = Object.prototype.hasOwnProperty.call(ratings, cacheKey) ? ratings[cacheKey] : null;
                // Average across all users, stored as a 1-5 float
                const avg = hit && typeof hit.average === 'number' && Number.isFinite(hit.average)
                    ? hit.average
                    : null;
                settle(cacheKey, entry, avg, true);
            }
        } catch (e) {
            // An abort is not a server failure: no backoff and no chip, so
            // the next render refetches immediately.
            const aborted = /** @type {any} */ (e)?.name === 'AbortError';
            if (!aborted) {
                console.warn(`${logPrefix} rating batch failed; retrying these ratings after ${FAILURE_BACKOFF_MS / 1000}s.`, e);
                if (isCurrent()) {
                    const until = Date.now() + FAILURE_BACKOFF_MS;
                    for (const [cacheKey] of batch) _failedUntil.set(cacheKey, until);
                }
            }
            for (const [cacheKey, entry] of batch) settle(cacheKey, entry, aborted ? undefined : null, false);
        } finally {
            _batchControllers.delete(controller);
        }
    }

    // Visibility is per viewer, so nothing cached or queued for the previous
    // user may be served to the next one.
    JE.session?.onUserChange('user-review-tags', () => {
        for (const controller of _batchControllers) controller.abort();
        _batchControllers.clear();
        if (_flushTimer !== null) {
            clearTimeout(_flushTimer);
            _flushTimer = null;
        }
        const orphaned = Array.from(_queue.values());
        _queue.clear();
        _reviewCache.clear();
        _inFlight.clear();
        _failedUntil.clear();
        // Queued for the previous user: nothing to render.
        for (const entry of orphaned) entry.resolve(undefined);
    });

    /**
     * Fetch the average rating across all users for a given tmdbKey.
     * Returns null if no reviews with ratings exist, undefined when the
     * lookup was aborted (nothing to render).
     * @returns {Promise<number|null|undefined>}
     */
    async function fetchUserRating(tmdbKey, mediaType) {
        if (!JE.pluginConfig?.ShowUserReviews) return null;
        const cacheKey = `${mediaType}:${tmdbKey}`;
        if (_reviewCache.has(cacheKey)) return _reviewCache.get(cacheKey);
        if (_inFlight.has(cacheKey)) return _inFlight.get(cacheKey);
        const failedUntil = _failedUntil.get(cacheKey);
        if (failedUntil !== undefined) {
            if (Date.now() < failedUntil) return null;
            _failedUntil.delete(cacheKey);
        }

        if ((mediaType !== 'movie' && mediaType !== 'tv') || !TMDB_KEY_RE.test(tmdbKey)) {
            _reviewCache.set(cacheKey, null);
            return null;
        }

        /** @type {{promise: Promise<number|null|undefined>|null, resolve: (value: number|null|undefined) => void}} */
        const entry = { promise: null, resolve: () => {} };
        entry.promise = new Promise((resolve) => { entry.resolve = resolve; });
        _queue.set(cacheKey, entry);
        _inFlight.set(cacheKey, entry.promise);

        if (_queue.size >= BATCH_MAX_KEYS) {
            flushQueue(); // never rejects: failures settle the batch to null
        } else if (_flushTimer === null) {
            _flushTimer = setTimeout(flushQueue, BATCH_WINDOW_MS);
        }
        return entry.promise;
    }

    /**
     * Append a person_heart chip to a rating overlay container.
     * Uses the same .rating-tag + .rating-tag-critic structure as the tomato chip,
     * with a material icon instead of the SVG background.
     */
    function appendUserRatingChip(container, rating) {
        container.querySelector('.je-userreview-tag')?.remove();

        const showDash = JE.pluginConfig?.ShowUserRatingDash !== false;
        if (rating === null && !showDash) return;

        // rating is a 1-5 float average — convert to /10, drop trailing .0
        const raw = rating !== null ? rating * 2 : null;
        const displayText = raw !== null
            ? (Number.isInteger(raw) ? `${raw}` : `${raw.toFixed(1)}`)
            : '—';

        const tag = document.createElement('div');
        tag.className = 'rating-tag rating-tag-critic je-userreview-tag';

        const icon = document.createElement('span');
        icon.className = 'je-userreview-icon';
        icon.textContent = 'person_heart';

        const text = document.createElement('span');
        text.className = 'rating-text';
        text.textContent = displayText;

        tag.appendChild(icon);
        tag.appendChild(text);
        container.appendChild(tag);
    }

    /**
     * Resolve the tmdbKey and mediaType for a Jellyfin item.
     * Returns null if the item type is unsupported or TMDB ID is missing.
     * @param {object} item - Jellyfin item from tag pipeline batch response.
     * @param {object} [extras] - Pipeline extras containing parentSeries.
     */
    function resolveTmdbKey(item, extras) {
        const type = item.Type || '';
        if (type === 'Movie') {
            const id = item.ProviderIds?.Tmdb || item.ProviderIds?.tmdb;
            return id ? { tmdbKey: String(id), mediaType: 'movie' } : null;
        }
        if (type === 'Series') {
            const id = item.ProviderIds?.Tmdb || item.ProviderIds?.tmdb;
            return id ? { tmdbKey: String(id), mediaType: 'tv' } : null;
        }
        if (type === 'Season' || type === 'Episode') {
            // SeriesProviderIds is not in the tag-data response — use parentSeries from extras
            const series = extras?.parentSeries;
            const seriesTmdbId = series?.ProviderIds?.Tmdb || series?.ProviderIds?.tmdb;
            if (!seriesTmdbId) return null;

            if (type === 'Season') {
                if (item.IndexNumber == null) return null;
                return { tmdbKey: `${seriesTmdbId}:s${item.IndexNumber}`, mediaType: 'tv' };
            } else {
                if (item.ParentIndexNumber == null || item.IndexNumber == null) return null;
                return { tmdbKey: `${seriesTmdbId}:s${item.ParentIndexNumber}:e${item.IndexNumber}`, mediaType: 'tv' };
            }
        }
        return null;
    }

    JE.initializeUserReviewTags = function() {
        if (!JE.pluginConfig?.ShowUserReviews) {
            console.log(`${logPrefix} User reviews disabled, skipping.`);
            return;
        }
        if (!JE.pluginConfig?.ShowUserRatingOnPosters) {
            console.log(`${logPrefix} User rating on posters disabled, skipping.`);
            return;
        }
        if (!JE.currentSettings?.ratingTagsEnabled) {
            console.log(`${logPrefix} Rating tags disabled, skipping.`);
            return;
        }

        JE.core.ui.injectCss('je-userreview-tags-css', `
            @font-face {
                font-family: 'Material Symbols Rounded';
                font-style: normal;
                font-weight: 100 700;
                font-display: block;
                src: url(${JE.cdn.font('materialsymbolsrounded.woff2')}) format('woff2');
            }
            .je-userreview-tag { color: #e91e8c !important; }
            .je-userreview-icon {
                font-family: 'Material Symbols Rounded';
                font-size: 14px !important;
                font-weight: normal;
                font-style: normal;
                line-height: 1;
                letter-spacing: normal;
                text-transform: none;
                display: inline-block;
                white-space: nowrap;
                word-wrap: normal;
                direction: ltr;
                -webkit-font-feature-settings: 'liga';
                font-feature-settings: 'liga';
                -webkit-font-smoothing: antialiased;
                color: #e91e8c !important;
                vertical-align: middle;
            }
        `);

        console.log(`${logPrefix} Initialized.`);
    };

    /**
     * Called by ratingtags.js after applying a rating overlay, OR directly
     * for items with no TMDB/RT rating. Creates the overlay container if needed.
     * @param {HTMLElement} containerOrEl - .rating-overlay-container or cardImageContainer.
     * @param {object} item - The Jellyfin item object.
     * @param {object} [extras] - Pipeline extras (parentSeries, etc.).
     */
    JE.appendUserRatingToContainer = async function(containerOrEl, item, extras) {
        if (!JE.pluginConfig?.ShowUserReviews) return;
        if (!JE.pluginConfig?.ShowUserRatingOnPosters) return;
        if (!JE.currentSettings?.ratingTagsEnabled) return;

        const resolved = resolveTmdbKey(item, extras);
        if (!resolved) return;

        const { tmdbKey, mediaType } = resolved;
        const rating = await fetchUserRating(tmdbKey, mediaType);
        if (rating === undefined) return; // lookup aborted — render nothing

        if (rating === null && JE.pluginConfig?.ShowUserRatingDash === false) return;

        // Accept either the overlay container itself or the cardImageContainer
        let container = containerOrEl;
        if (!container.classList.contains('rating-overlay-container')) {
            container = containerOrEl.querySelector('.rating-overlay-container');
            if (!container) {
                container = document.createElement('div');
                container.className = 'rating-overlay-container';
                containerOrEl.appendChild(container);
            }
        }

        appendUserRatingChip(container, rating);
    };

    /**
     * Invalidate cache for a specific tmdbKey (called after review save/delete).
     * Callers pass the bare tmdbKey, so both media types for it are dropped.
     * @param {string} [tmdbKey]
     * @param {string} [mediaType] - 'movie' or 'tv' to drop only that entry.
     */
    JE.invalidateUserReviewTagCache = function(tmdbKey, mediaType) {
        if (!tmdbKey) {
            _reviewCache.clear();
            _failedUntil.clear();
            return;
        }
        for (const type of mediaType ? [mediaType] : ['movie', 'tv']) {
            _reviewCache.delete(`${type}:${tmdbKey}`);
            _failedUntil.delete(`${type}:${tmdbKey}`);
        }
    };

})(window.JellyfinEnhanced = window.JellyfinEnhanced || {});
