// /js/tags/userreviewtags.js
// Adds the current user's personal rating (person_heart icon) to the rating
// tag overlay on poster cards. Piggybacks on the ratingTagsEnabled setting —
// no separate toggle needed. Shows X/10 when rated, "—" when not (unless
// ShowUserRatingDash is false in admin config).
(function(JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced: User Review Tags:';

    // Per-session cache: tmdbKey → rating (1-5 or null)
    const _reviewCache = new Map();
    // In-flight deduplication
    const _inFlight = new Map();

    /**
     * Fetch the current user's rating for a given tmdbKey.
     * Returns null if no review exists or reviews are disabled.
     */
    async function fetchUserRating(tmdbKey, mediaType) {
        if (!JE.pluginConfig?.ShowUserReviews) return null;
        if (_reviewCache.has(tmdbKey)) return _reviewCache.get(tmdbKey);
        if (_inFlight.has(tmdbKey)) return _inFlight.get(tmdbKey);

        const promise = (async () => {
            try {
                const url = ApiClient.getUrl(`/JellyfinEnhanced/reviews/${mediaType}/${tmdbKey}`);
                const response = await fetch(url, {
                    headers: { 'X-Emby-Token': ApiClient.accessToken() }
                });
                if (!response.ok) {
                    _reviewCache.set(tmdbKey, null);
                    return null;
                }
                const data = await response.json();
                const currentUserId = (ApiClient.getCurrentUserId() || '').replace(/-/g, '');
                const ownReview = (data.reviews || []).find(r =>
                    (r.userId || '').replace(/-/g, '') === currentUserId
                );
                const rating = ownReview?.rating ?? null;
                _reviewCache.set(tmdbKey, rating);
                return rating;
            } catch (e) {
                _reviewCache.set(tmdbKey, null);
                return null;
            } finally {
                _inFlight.delete(tmdbKey);
            }
        })();

        _inFlight.set(tmdbKey, promise);
        return promise;
    }

    /**
     * Append a person_heart chip to an existing rating overlay container.
     * @param {HTMLElement} container - The .rating-overlay-container element.
     * @param {number|null} rating - 1-5 star rating, or null if unrated.
     */
    function appendUserRatingChip(container, rating) {
        // Remove any existing chip first
        container.querySelector('.je-userreview-tag')?.remove();

        const showDash = JE.pluginConfig?.ShowUserRatingDash !== false; // default true
        if (rating === null && !showDash) return;

        const displayText = rating !== null ? `${rating * 2}/10` : '—';

        const tag = document.createElement('div');
        tag.className = 'rating-tag je-userreview-tag';

        const icon = document.createElement('span');
        icon.className = 'material-icons je-userreview-icon';
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
     */
    function resolveTmdbKey(item) {
        const type = item.Type || '';
        if (type === 'Movie') {
            const id = item.ProviderIds?.Tmdb || item.ProviderIds?.tmdb;
            return id ? { tmdbKey: String(id), mediaType: 'movie' } : null;
        }
        if (type === 'Series') {
            const id = item.ProviderIds?.Tmdb || item.ProviderIds?.tmdb;
            return id ? { tmdbKey: String(id), mediaType: 'tv' } : null;
        }
        if (type === 'Season') {
            const id = item.SeriesProviderIds?.Tmdb || item.SeriesProviderIds?.tmdb;
            return (id && item.IndexNumber != null)
                ? { tmdbKey: `${id}:s${item.IndexNumber}`, mediaType: 'tv' }
                : null;
        }
        if (type === 'Episode') {
            const id = item.SeriesProviderIds?.Tmdb || item.SeriesProviderIds?.tmdb;
            return (id && item.ParentIndexNumber != null && item.IndexNumber != null)
                ? { tmdbKey: `${id}:s${item.ParentIndexNumber}:e${item.IndexNumber}`, mediaType: 'tv' }
                : null;
        }
        return null;
    }

    JE.initializeUserReviewTags = function() {
        if (!JE.pluginConfig?.ShowUserReviews) {
            console.log(`${logPrefix} User reviews disabled, skipping.`);
            return;
        }
        if (!JE.currentSettings?.ratingTagsEnabled) {
            console.log(`${logPrefix} Rating tags disabled, skipping.`);
            return;
        }

        // Inject CSS for the person_heart chip (reuses .rating-tag base styles)
        const styleId = 'je-userreview-tags-css';
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                .je-userreview-tag { color: #e91e8c !important; }
                .je-userreview-icon {
                    font-size: 14px !important;
                    line-height: 1;
                    color: #e91e8c !important;
                }
            `;
            document.head.appendChild(style);
        }

        console.log(`${logPrefix} Initialized.`);
    };

    /**
     * Called by ratingtags.js after it applies a rating overlay to a card.
     * Appends the user rating chip to the existing container.
     * @param {HTMLElement} container - The .rating-overlay-container element.
     * @param {object} item - The Jellyfin item object.
     */
    JE.appendUserRatingToContainer = async function(container, item) {
        if (!JE.pluginConfig?.ShowUserReviews) return;
        if (!JE.currentSettings?.ratingTagsEnabled) return;

        const resolved = resolveTmdbKey(item);
        if (!resolved) return;

        const { tmdbKey, mediaType } = resolved;
        const rating = await fetchUserRating(tmdbKey, mediaType);
        appendUserRatingChip(container, rating);
    };

    /**
     * Invalidate cache for a specific tmdbKey (called after review save/delete).
     */
    JE.invalidateUserReviewTagCache = function(tmdbKey) {
        if (tmdbKey) _reviewCache.delete(tmdbKey);
        else _reviewCache.clear();
    };

})(window.JellyfinEnhanced = window.JellyfinEnhanced || {});
