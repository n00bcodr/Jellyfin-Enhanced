// /js/tags/ageratingtags.js
// Jellyfin Age Rating Tags - Display the item's parental / age rating (PG-13,
// TV-MA, FSK 12, ...) as a colour-coded badge on posters.
// A spec over the core tag-renderer factory (js/core/tag-renderer-base.js),
// which owns the cache/ignore/tagged/CSS/reinitialize plumbing. This module
// supplies only the age-rating-specific parts: reading OfficialRating, the
// badge markup, and the per-rating colour table shared with Colored Ratings.
//
// Not Spoiler-Guarded on purpose: an age rating says nothing about the plot,
// and Jellyfin already shows it in the details-page header of guarded items.
(function(JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced: Age Rating Tags:';
    const containerClass = 'age-rating-overlay-container';
    const tagClass = 'age-rating-tag';
    // Per-rating colour rules derived from css/ratings.css (the Colored Ratings
    // stylesheet), injected once under this id.
    const colourStyleId = 'jellyfin-enhanced-age-rating-colours-css';
    /** @type {Promise<void>|null} in-flight / completed colour stylesheet load */
    let colourCssPromise = null;

    /**
     * Normalize a raw OfficialRating to the key the colour table uses. Delegates
     * to the Colored Ratings normalizer (DE-12 → FSK-12, "Not Rated" → NR, ...)
     * when it is loaded, so the poster badge and the details-page box always
     * agree on both text and colour; otherwise just collapses whitespace.
     * @param {*} raw - OfficialRating as stored by Jellyfin.
     * @returns {string|null} Normalized rating or null when empty.
     */
    function normalizeRating(raw) {
        if (raw === null || raw === undefined) return null;
        const text = String(raw).replace(/\s+/g, ' ').trim();
        if (!text) return null;
        const shared = JE.normalizeOfficialRating;
        return (typeof shared === 'function' ? shared(text) : text) || null;
    }

    /**
     * Extract only the `[rating=...]` colour rules from the Colored Ratings
     * stylesheet and re-target them at the poster badge class. The sheet's base
     * `.mediaInfoOfficialRating` rule (sizing, hover transform, !important
     * resets) and its @media blocks are dropped so nothing leaks onto the
     * details page when Colored Ratings itself is off. The sheet's `!important`
     * flags are dropped too: the attribute selector already outranks the
     * badge's base rule, and this style element lands after Jellyfin's Custom
     * CSS, so keeping them would make a user's own `.age-rating-tag[rating=…]`
     * override unreachable.
     * @param {string} cssText - Raw css/ratings.css contents.
     * @returns {string} Scoped colour rules for `.age-rating-tag[rating=...]`.
     */
    function scopeRatingColours(cssText) {
        const withoutComments = cssText.replace(/\/\*[\s\S]*?\*\//g, '');
        const rules = [];
        const blockRe = /([^{}]+)\{([^{}]*)\}/g;
        let match;
        while ((match = blockRe.exec(withoutComments)) !== null) {
            const selectors = match[1].split(',')
                .map((s) => s.trim())
                .filter((s) => s.startsWith('.mediaInfoOfficialRating[rating='))
                .map((s) => s.replace('.mediaInfoOfficialRating', `.${tagClass}`));
            if (selectors.length === 0) continue;
            const declarations = match[2].replace(/\s*!important/g, '').trim();
            rules.push(`${selectors.join(',\n')} { ${declarations} }`);
        }
        return rules.join('\n');
    }

    /**
     * Load css/ratings.css through the plugin's local CDN route (same asset
     * Colored Ratings uses) and inject the scoped colour rules once. Badges
     * fall back to the neutral blue-grey until this resolves, or permanently if
     * the asset cannot be fetched — the rating text is still shown.
     * @returns {Promise<void>}
     */
    function ensureColourCss() {
        if (colourCssPromise) return colourCssPromise;
        if (document.getElementById(colourStyleId)) return (colourCssPromise = Promise.resolve());
        colourCssPromise = (async () => {
            try {
                const response = await fetch(JE.cdn.url('je-css', 'ratings.css'));
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const scoped = scopeRatingColours(await response.text());
                if (!scoped) throw new Error('no [rating=] rules found');
                JE.core.ui.injectCss(colourStyleId, scoped);
            } catch (e) {
                console.warn(`${logPrefix} Could not load rating colours, badges will use the default colour.`, e);
                colourCssPromise = null; // allow a retry on the next (re)initialize
            }
        })();
        return colourCssPromise;
    }

    /**
     * Retrieve a cached entry from localStorage or hot cache.
     * @param {Object} ctx - Factory context.
     * @param {string} itemId - Jellyfin item ID.
     * @returns {{rating: string|null}|null} Cached entry or null when unknown.
     */
    function getCachedEntry(ctx, itemId) {
        const entry = ctx.getPersistent(itemId) ?? ctx.hot?.get(itemId);
        if (!entry || typeof entry !== 'object') return null;
        return { rating: entry.rating ?? null };
    }

    /**
     * Store an entry in both localStorage cache and hot cache. A null rating is
     * cached too, so items without one are not re-fetched on every visit.
     * @param {Object} ctx - Factory context.
     * @param {string} itemId - Jellyfin item ID.
     * @param {string|null} rating - Normalized rating.
     * @returns {void}
     */
    function setCachedEntry(ctx, itemId, rating) {
        const entry = { rating };
        ctx.setPersistent(itemId, entry);
        ctx.hot?.set(itemId, entry);
    }

    /**
     * Create and append the age rating badge to a card.
     * @param {Object} ctx - Factory context.
     * @param {HTMLElement} el - The card container to receive the overlay.
     * @param {string|null} rating - Normalized rating text (also the colour key).
     * @returns {void}
     */
    function applyAgeRatingTag(ctx, el, rating) {
        if (!rating) return;

        ctx.removeExistingOverlay(el);

        const container = document.createElement('div');
        container.className = containerClass;

        const tag = document.createElement('div');
        tag.className = tagClass;
        // Same attribute Colored Ratings sets on .mediaInfoOfficialRating, so
        // the scoped [rating=...] colour rules match verbatim.
        tag.setAttribute('rating', rating);
        tag.textContent = rating;
        container.appendChild(tag);

        ctx.commitOverlay(el, container);
    }

    /** @type {Object} Factory spec — everything age-rating-specific lives here. */
    const spec = {
        logPrefix,
        settingKey: 'ageRatingTagsEnabled',
        containerClass,
        taggedAttr: 'jeAgeRatingTagged',
        styleId: 'jellyfin-enhanced-age-rating-tags-css',
        position: { userKey: 'ageRatingTagsPosition', pluginKey: 'AgeRatingTagsPosition', fallback: 'bottom-right' },
        cache: {
            key: 'JellyfinEnhanced-ageRatingTagsCache',
            legacyPrefix: 'ageRatingTagsCache',
            hotBucket: 'ageRating',
            saveOnUnload: false,
        },
        buildCss() {
            const pos = JE.core.tagRenderer.resolvePosition('ageRatingTagsPosition', 'AgeRatingTagsPosition', 'bottom-right');
            return `
                .${containerClass} {
                    position: absolute;
                    top: ${pos.topVal};
                    right: ${pos.rightVal};
                    bottom: ${pos.bottomVal};
                    left: ${pos.leftVal};
                    display: flex;
                    flex-direction: column;
                    align-items: ${pos.isLeft ? 'flex-start' : 'flex-end'};
                    z-index: 10;
                    pointer-events: none;
                    max-width: calc(100% - 12px);
                }

                ${pos.needsTopRightOffset ? `.cardImageContainer .cardIndicators ~ .${containerClass} { margin-top: clamp(20px, 3vw, 30px); }` : ''}
                .${tagClass} {
                    display: inline-flex;
                    align-items: center;
                    padding: 4px 8px;
                    /* Neutral fallback, same as the Colored Ratings default, until a
                       [rating=...] rule matches (or if the colour sheet fails to load). */
                    background-color: #607D8B;
                    color: #ffffff;
                    border: 1px solid rgba(255, 255, 255, 0.25);
                    border-radius: 4px;
                    font-size: 13px;
                    font-weight: 700;
                    line-height: 1;
                    letter-spacing: 0.02em;
                    text-transform: uppercase;
                    text-shadow: 0 0 2px rgba(0, 0, 0, 0.6);
                    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.3);
                    white-space: nowrap;
                    pointer-events: none;
                }

                /* Card-width sizing, matching the rating tag rules in tag-pipeline.js */
                @supports (container-type: inline-size) {
                    html:not(.layout-mobile) .je-tag-host .${tagClass} {
                        font-size: clamp(9px, 6.8cqw, 13px);
                        padding: clamp(2px, 2cqw, 4px) clamp(4px, 4.5cqw, 8px);
                    }
                }

                .layout-mobile .${tagClass} {
                    padding: 2px 6px;
                    font-size: 11px;
                    border-radius: 3px;
                }

                @media (max-width: 768px) {
                    .${tagClass} { padding: 3px 6px; font-size: 12px; }
                }

                @media (max-width: 480px) {
                    .${containerClass} { top: ${pos.isTop ? '4px' : 'auto'}; bottom: ${pos.isTop ? 'auto' : '4px'}; left: ${pos.isLeft ? '4px' : 'auto'}; right: ${pos.isLeft ? 'auto' : '4px'}; }
                    .${tagClass} { padding: 2px 4px; font-size: clamp(10px, 2vw, 11px); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.4); }
                }
            `;
        },
        pipeline: {
            needsFirstEpisode: false,
            needsParentSeries: false,
            render(ctx, el, item, extras) {
                if (ctx.shouldIgnore(el)) return;
                if (ctx.isTagged(el)) return;
                if (el.closest('.je-hidden')) return;

                const itemId = item.Id;
                const cached = getCachedEntry(ctx, itemId);
                if (cached) {
                    applyAgeRatingTag(ctx, el, cached.rating);
                    return;
                }

                // /tag-data resolves the Season/Episode → Series fallback server-side;
                // the parent series handed over by the pipeline (when another renderer
                // asked for it) only covers the raw /Items fallback path.
                const rating = normalizeRating(item.OfficialRating)
                    ?? normalizeRating(extras?.parentSeries?.OfficialRating);
                setCachedEntry(ctx, itemId, rating);
                applyAgeRatingTag(ctx, el, rating);
            },
            renderFromCache(ctx, el, itemId) {
                if (ctx.isTagged(el)) return true;
                if (ctx.shouldIgnore(el)) return true;
                if (el.closest('.je-hidden')) return true;
                const cached = getCachedEntry(ctx, itemId);
                if (!cached) return false;
                applyAgeRatingTag(ctx, el, cached.rating);
                // A cached "no rating" is still a cache hit — nothing to fetch.
                return true;
            },
            renderFromServerCache(ctx, el, entry) {
                if (ctx.isTagged(el)) return;
                if (ctx.shouldIgnore(el)) return;
                applyAgeRatingTag(ctx, el, normalizeRating(entry.OfficialRating));
            },
        },
    };

    JE.initializeAgeRatingTags = function() {
        console.log(`${logPrefix} Starting...`);

        const ctx = JE.core.tagRenderer.register('agerating', spec);
        ctx.injectCss();
        ensureColourCss();

        console.log(`${logPrefix} Initialized successfully.`);
    };

    JE.reinitializeAgeRatingTags = function() {
        JE.core.tagRenderer.reinitialize('agerating', spec);
        ensureColourCss();
    };

})(window.JellyfinEnhanced);
