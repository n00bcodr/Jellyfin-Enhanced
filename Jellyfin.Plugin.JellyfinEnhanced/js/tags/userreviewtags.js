// /js/tags/userreviewtags.js
// Adds the current user's personal rating (person_heart icon) to the rating
// tag overlay on poster cards. Piggybacks on the ratingTagsEnabled setting —
// no separate toggle needed. Shows X when rated, "—" when not (unless
// ShowUserRatingDash is false in admin config).
//
// Where the ratings come from: with the server-side tag cache on, the average
// for every item with a visible rated review rides on the tag-cache payload
// (JE.tagPipeline.getReviewRatings — full loads and deltas alike), so a page
// of cards needs no request at all; otherwise every key requested within one
// short window goes out as a single GET /reviews/ratings?keys=… (the batch
// path below), which also answers for a key the viewer just re-rated until the
// next refresh of the averages.
(function(JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced: User Review Tags:';

    // Per-session cache: "mediaType:tmdbKey" → rating (1-5 or null). The media
    // type is part of the key because a movie and a series can share a TMDB id.
    // Filled by the batch path only; the server cache's averages are read live
    // so a refreshed map is used as soon as it lands.
    const _reviewCache = new Map();
    // performance.now() when the request behind each _reviewCache value
    // started: a server-cache averages map requested later supersedes it (see
    // hasFreshCached), whether or not the key's card is on screen.
    const _reviewCacheAt = new Map();
    // In-flight deduplication, same keys
    const _inFlight = new Map();
    // Keys whose batch failed (not aborted) → time (ms) until which they
    // resolve to null without a request. Stops a persistently failing server
    // (e.g. a corrupt reviews.json) from getting a new, transport-retried
    // batch on every tag-pipeline render; after the window they refetch.
    /** @type {Map<string, number>} */
    const _failedUntil = new Map();
    const FAILURE_BACKOFF_MS = 60 * 1000;
    // Keys whose value in the server cache's averages must not be trusted
    // until averages requested after the edit arrive: the viewer just saved or
    // deleted their own review. Maps key → performance.now() of the edit; a map
    // whose request started later (a navigation's delta) is trusted again.
    /** @type {Map<string, number>} */
    const _staleInMap = new Map();
    let _staleAllAt = -1;           // performance.now() of an invalidate-all: maps requested before it are stale for every key

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
        const requestedAt = performance.now();

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
                    _reviewCacheAt.set(cacheKey, requestedAt);
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
        _reviewCacheAt.clear();
        _inFlight.clear();
        _failedUntil.clear();
        _staleInMap.clear();
        _staleAllAt = -1;
        // Queued for the previous user: nothing to render.
        for (const entry of orphaned) entry.resolve(undefined);
    });

    /**
     * The server cache's review averages, when they are loaded and may be
     * used for this key: not for a key the viewer edited a review of until a
     * map whose request STARTED after the edit arrives (an older request can
     * still land after the edit, carrying the old average).
     * @param {string} cacheKey - "mediaType:tmdbKey"
     * @returns {Map<string, number>|null}
     */
    /**
     * Whether this session's looked-up value for a key may be used: it exists
     * and no usable server-cache averages map was requested after it (the map
     * would then be the fresher answer, so the value is dropped).
     * @param {string} cacheKey - "mediaType:tmdbKey"
     * @returns {boolean}
     */
    function hasFreshCached(cacheKey) {
        if (!_reviewCache.has(cacheKey)) return false;
        const pipeline = JE.tagPipeline;
        if (usableRatingMap(cacheKey)
            && typeof pipeline?.getReviewRatingsRequestedAt === 'function'
            && pipeline.getReviewRatingsRequestedAt() > (_reviewCacheAt.get(cacheKey) ?? 0)) {
            _reviewCache.delete(cacheKey);
            _reviewCacheAt.delete(cacheKey);
            return false;
        }
        return true;
    }

    function usableRatingMap(cacheKey) {
        const pipeline = JE.tagPipeline;
        if (!pipeline || typeof pipeline.peekReviewRatings !== 'function') return null;
        const map = pipeline.peekReviewRatings();
        if (!map) return null;
        const requestedAt = pipeline.getReviewRatingsRequestedAt();
        const staleAt = _staleInMap.get(cacheKey);
        if (requestedAt <= _staleAllAt || (staleAt !== undefined && requestedAt <= staleAt)) return null;
        return map;
    }

    /**
     * The rating for a key without waiting: from the session cache, or from
     * the server cache's averages when they are loaded (an absent key there
     * means no visible rated review). `undefined` when it has to be looked up
     * (see fetchUserRating).
     * @param {string} tmdbKey
     * @param {string} mediaType - 'movie' or 'tv'
     * @returns {number|null|undefined}
     */
    function peekUserRating(tmdbKey, mediaType) {
        if (!JE.pluginConfig?.ShowUserReviews) return null;
        const cacheKey = `${mediaType}:${tmdbKey}`;
        if (hasFreshCached(cacheKey)) return _reviewCache.get(cacheKey);
        if ((mediaType !== 'movie' && mediaType !== 'tv') || !TMDB_KEY_RE.test(tmdbKey)) return null;
        const map = usableRatingMap(cacheKey);
        if (map) return map.has(cacheKey) ? map.get(cacheKey) : null;
        return undefined;
    }

    /**
     * Fetch the average rating across all users for a given tmdbKey: from
     * the server cache's averages once the load in flight settles, else via
     * the batched /reviews/ratings request.
     * Returns null if no reviews with ratings exist, undefined when the
     * lookup was aborted (nothing to render).
     * @returns {Promise<number|null|undefined>}
     */
    async function fetchUserRating(tmdbKey, mediaType) {
        if (!JE.pluginConfig?.ShowUserReviews) return null;
        const cacheKey = `${mediaType}:${tmdbKey}`;
        if (hasFreshCached(cacheKey)) return _reviewCache.get(cacheKey);
        if (_inFlight.has(cacheKey)) return _inFlight.get(cacheKey);
        const failedUntil = _failedUntil.get(cacheKey);
        if (failedUntil !== undefined) {
            if (Date.now() < failedUntil) return null;
            _failedUntil.delete(cacheKey);
        }

        if ((mediaType !== 'movie' && mediaType !== 'tv') || !TMDB_KEY_RE.test(tmdbKey)) {
            _reviewCache.set(cacheKey, null);
            _reviewCacheAt.set(cacheKey, Infinity); // never in the averages map
            return null;
        }

        // Server cache path: the averages arrive with the tag cache (a page
        // load's restore + delta, or the full download). Wait for that rather
        // than send a request the answer to which is already on its way.
        if (typeof JE.tagPipeline?.getReviewRatings === 'function') {
            const epoch = JE.session ? JE.session.getEpoch() : 0;
            try {
                await JE.tagPipeline.getReviewRatings();
            } catch {
                // Fall through to the batch path.
            }
            if (JE.session && !JE.session.isCurrent(epoch)) return undefined;
            const map = usableRatingMap(cacheKey);
            if (map) return map.has(cacheKey) ? map.get(cacheKey) : null;
            // A batch may have settled or started this key while waiting.
            if (hasFreshCached(cacheKey)) return _reviewCache.get(cacheKey);
            if (_inFlight.has(cacheKey)) return _inFlight.get(cacheKey);
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
     * Put the chip for a resolved rating on a card, creating the rating
     * overlay container when the card has no TMDB/RT rating of its own.
     * @param {HTMLElement} containerOrEl - .rating-overlay-container or the render target.
     * @param {number|null} rating
     * @param {boolean} restack - true when the chip lands after the pipeline's
     *   corner-stacking pass for this card (an async lookup): the
     *   bottom-anchored container grows upward as the chip is added, so any
     *   overlay sharing the corner (e.g. the age rating badge) is re-measured
     *   — in one batched frame with every other late chip. Not needed when the
     *   chip is added during the render itself; the pipeline stacks afterwards.
     */
    function applyChip(containerOrEl, rating, restack) {
        if (!containerOrEl.isConnected) return; // card gone while the rating was looked up
        if (rating === null && JE.pluginConfig?.ShowUserRatingDash === false) {
            // No chip for "no rating"; drop one an earlier value left behind.
            const stale = containerOrEl.classList.contains('je-userreview-tag')
                ? containerOrEl
                : containerOrEl.querySelector('.je-userreview-tag');
            stale?.remove();
            return;
        }

        // Accept either the overlay container itself or the cardImageContainer
        let container = containerOrEl;
        if (!container.classList.contains('rating-overlay-container')) {
            container = containerOrEl.querySelector('.rating-overlay-container');
            if (!container) {
                container = document.createElement('div');
                container.className = 'rating-overlay-container';
                // Same corner marker commitOverlay() sets, so corner stacking
                // treats a review-only container like any other rating overlay.
                const pos = JE.core?.tagRenderer?.resolvePosition?.('ratingTagsPosition', 'RatingTagsPosition', 'bottom-right');
                if (pos) container.dataset.jeCorner = pos.pos;
                containerOrEl.appendChild(container);
            }
        }

        appendUserRatingChip(container, rating);

        if (restack) {
            const host = container.parentElement;
            if (host && typeof JE.core?.tagRenderer?.scheduleCornerStacking === 'function') {
                JE.core.tagRenderer.scheduleCornerStacking(host);
            }
        }
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

        if (!_listening && typeof JE.tagPipeline?.onReviewRatingsChanged === 'function') {
            _listening = true;
            JE.tagPipeline.onReviewRatingsChanged(refreshChangedChips);
        }

        console.log(`${logPrefix} Initialized.`);
    };

    let _listening = false;

    /**
     * Update chips already on cards when the server cache's averages change
     * (a navigation's delta, another viewer's review): cards rendered before
     * the change would otherwise keep the old value until they are rebuilt.
     * Only cards whose key changed are touched, and their corners re-stack in
     * one batched frame.
     * @param {Set<string>|null} changed - Changed "mediaType:tmdbKey" keys, or null for all.
     */
    function refreshChangedChips(changed) {
        // Same gates as rendering: with the chips (or rating tags) switched
        // off there is nothing to update, and nothing may be re-created.
        if (!JE.pluginConfig?.ShowUserReviews || !JE.pluginConfig?.ShowUserRatingOnPosters || !JE.currentSettings?.ratingTagsEnabled) return;
        const hosts = document.querySelectorAll('[data-je-review-key]');
        for (const host of hosts) {
            const key = host.dataset.jeReviewKey;
            if (changed && !changed.has(key)) continue;
            const sep = key.indexOf(':');
            const rating = peekUserRating(key.slice(sep + 1), key.slice(0, sep));
            if (rating === undefined) continue;
            applyChip(host, rating, true);
        }
    }

    /**
     * Called by ratingtags.js after applying a rating overlay, OR directly
     * for items with no TMDB/RT rating. Creates the overlay container if needed.
     * Adds the chip synchronously when the rating is already known (the
     * server cache's averages, or the session cache) so it takes part in the
     * pipeline's corner-stacking pass for the card; otherwise looks it up and
     * adds it when it arrives.
     * @param {HTMLElement} containerOrEl - .rating-overlay-container or cardImageContainer.
     * @param {object} item - The Jellyfin item object.
     * @param {object} [extras] - Pipeline extras (parentSeries, etc.).
     */
    JE.appendUserRatingToContainer = function(containerOrEl, item, extras) {
        if (!JE.pluginConfig?.ShowUserReviews) return;
        if (!JE.pluginConfig?.ShowUserRatingOnPosters) return;
        if (!JE.currentSettings?.ratingTagsEnabled) return;

        const resolved = resolveTmdbKey(item, extras);
        if (!resolved) return;

        const { tmdbKey, mediaType } = resolved;
        // Remember the key on the card so a later change to the averages can
        // update this chip in place (see refreshChangedChips).
        containerOrEl.dataset.jeReviewKey = `${mediaType}:${tmdbKey}`;
        const known = peekUserRating(tmdbKey, mediaType);
        if (known !== undefined) {
            applyChip(containerOrEl, known, false);
            return;
        }

        fetchUserRating(tmdbKey, mediaType).then((rating) => {
            if (rating === undefined) return; // lookup aborted — render nothing
            // Averages that arrived while this lookup was out are newer than
            // its answer (and may already be on the chip): resolve again.
            const current = peekUserRating(tmdbKey, mediaType);
            applyChip(containerOrEl, current !== undefined ? current : rating, true);
        });
    };

    /**
     * Invalidate cache for a specific tmdbKey (called after review save/delete).
     * Callers pass the bare tmdbKey, so both media types for it are dropped.
     * The server cache's averages still hold the old value for the key until
     * their next refresh, so the key is answered by the batch path meanwhile.
     * @param {string} [tmdbKey]
     * @param {string} [mediaType] - 'movie' or 'tv' to drop only that entry.
     */
    JE.invalidateUserReviewTagCache = function(tmdbKey, mediaType) {
        const now = performance.now();
        if (!tmdbKey) {
            _reviewCache.clear();
            _reviewCacheAt.clear();
            _failedUntil.clear();
            _staleAllAt = now;
            return;
        }
        for (const type of mediaType ? [mediaType] : ['movie', 'tv']) {
            _reviewCache.delete(`${type}:${tmdbKey}`);
            _reviewCacheAt.delete(`${type}:${tmdbKey}`);
            _failedUntil.delete(`${type}:${tmdbKey}`);
            _staleInMap.set(`${type}:${tmdbKey}`, now);
        }
    };

})(window.JellyfinEnhanced = window.JellyfinEnhanced || {});
