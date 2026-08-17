// /js/others/mdblist-ratings.js
// Renders a row of MDBList ratings (TMDB, Rotten Tomatoes, IMDb, Trakt, etc.)
// on the item-details page. Backed by MdblistService's server-side cache via
// GET /JellyfinEnhanced/mdblist-ratings/{mediaType}/{tmdbId}
// Purely a display overlay; the separate MdblistRatingsSyncTask scheduled task is what actually fills in
// Jellyfin's own CommunityRating/CriticRating fields.
(function (JE) {
    'use strict';

    JE.initializeMdblistRatingsScript = function () {
        if (!JE.pluginConfig?.MdblistRatingsEnabled || !JE.pluginConfig?.MdblistRatingsShowOnItemDetails) {
            console.log('🪼 Jellyfin Enhanced: MDBList Ratings feature disabled.');
            return;
        }

        const logPrefix = '🪼 Jellyfin Enhanced: MDBList Ratings:';
        const sectionClass = 'je-mdblist-ratings-section';
        const escapeHtml = (typeof JE.escapeHtml === 'function') ? JE.escapeHtml : (v) => String(v);

        // Safe fallback for helpers.js load-order races (same pattern letterboxd-links.js uses).
        const extLink = JE.helpers?.createExternalLink || ((url, o = {}) => {
            const a = document.createElement('a');
            a.setAttribute('is', 'emby-linkbutton');
            a.href = url;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            if (o.title) a.title = o.title;
            if (o.className) a.className = o.className;
            if (o.text) a.textContent = o.text;
            if (o.resetStyle) a.style.cssText = 'padding:0;background:none;border-radius:0;min-width:0;';
            if (typeof o.setup === 'function') o.setup(a);
            return a;
        });

        // Friendly labels for MDBList's raw source keys. Sources not listed
        // here still render, using the raw key as a fallback label.
        const LABELS = {
            master: 'Master', imdb: 'IMDb', tmdb: 'TMDB', trakt: 'Trakt',
            letterboxd: 'Letterboxd', tomatoes: 'RT Critic', popcorn: 'RT Audience',
            metacritic: 'Metascore', metacriticuser: 'Metacritic User',
            rogerebert: 'Roger Ebert', myanimelist: 'MAL', anilist: 'AniList',
        };

        // Logo filenames served via the "mdblist-logos" CDN source (see CdnAssetService.cs).
        // Sources with no logo here fall back to text-only.
        const LOGOS = {
            master: 'master.png', imdb: 'imdb.png', tmdb: 'tmdb.png', trakt: 'trakt.png',
            letterboxd: 'letterboxd.png', tomatoes: 'rottentomatoes.png', popcorn: 'rottentomatoes_audience.png',
            metacritic: 'metacritic.png', metacriticuser: 'metacritic_audience.png',
            rogerebert: 'rogerebert.png', myanimelist: 'myanimelist.png', anilist: 'anilist.png',
        };

        // Only 'tomatoes' (RT Critic) gets a Fresh/Rotten status from MDBList (r.Fresh).
        // When present, swaps the plain logo for the matching splat, vendored from
        // jellyfin-web's own fresh.svg/rotten.svg.
        const TOMATOES_STATUS_LOGOS = { 1: 'rottentomatoes_fresh.png', 0: 'rottentomatoes_rotten.png' };

        // Default display order when the admin hasn't configured one: the
        // handful of sources most people care about first, anything else
        // in whatever order the API returned it.
        const DEFAULT_ORDER = ['tmdb', 'tomatoes', 'popcorn', 'imdb', 'trakt', 'metacritic'];

        const localSlug = (t) => (t || '').toLowerCase().replace(/'/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

        /**
         * Direct link to a rating's source site, ported from xroguel1ke/jellyfin_ratings'
         * generateLink(). tmdb/imdb/trakt/anilist/myanimelist use the item's
         * cross-provider ids (MdblistCacheEntry.Ids); letterboxd/tomatoes/popcorn/
         * rogerebert use the per-source url MDBList returns (MdblistRatingSource.Url)
         * when it looks usable; metacritic is constructed from the title since
         * MDBList doesn't provide a slug for it. Returns null (render as plain
         * text, not a link) when no usable target exists for that source.
         * @param {string} sourceKey
         * @param {Object} ids - entry.Ids from the server (imdb/tmdb/trakt/mal/anilist/...)
         * @param {string|null|undefined} apiUrl - this rating's Url field, if any
         * @param {string} mediaType - 'movie' or 'tv'
         * @param {string} title
         * @returns {string|null}
         */
        function generateLink(sourceKey, ids, apiUrl, mediaType, title) {
            const sLink = String(apiUrl || '');
            const safeTitle = encodeURIComponent(title || '');
            const safeType = mediaType === 'tv' ? 'tv' : 'movie';
            if (sLink.startsWith('http') && sourceKey !== 'metacriticuser' && sourceKey !== 'rogerebert') return sLink;

            switch (sourceKey) {
                case 'imdb': return ids.imdb ? `https://www.imdb.com/title/${ids.imdb}/` : null;
                case 'tmdb': return ids.tmdb ? `https://www.themoviedb.org/${safeType}/${ids.tmdb}` : null;
                case 'trakt': return ids.trakt ? `https://trakt.tv/${safeType === 'tv' ? 'shows' : 'movies'}/${ids.trakt}` : null;
                case 'letterboxd': return (sLink.includes('/film/') || sLink.includes('/slug/')) ? `https://letterboxd.com${sLink.startsWith('/') ? '' : '/'}${sLink}` : null;
                case 'metacritic':
                case 'metacriticuser': return title ? `https://www.metacritic.com/${safeType}/${localSlug(title)}` : null;
                case 'tomatoes':
                case 'popcorn':
                    if (sLink.startsWith('/')) return `https://www.rottentomatoes.com${sLink}`;
                    return sLink.length > 2 ? `https://www.rottentomatoes.com/m/${sLink}` : null;
                case 'anilist': return ids.anilist ? `https://anilist.co/anime/${ids.anilist}` : (title ? `https://anilist.co/search/anime?search=${safeTitle}` : null);
                case 'myanimelist': return ids.mal ? `https://myanimelist.net/anime/${ids.mal}` : (title ? `https://myanimelist.net/anime.php?q=${safeTitle}` : null);
                case 'rogerebert': return sLink.length > 2 ? `https://www.rogerebert.com/reviews/${sLink}` : (title ? `https://duckduckgo.com/?q=!ducky+site:rogerebert.com/reviews+${safeTitle}` : null);
                default: return null; // e.g. "master" (MDBList's own aggregate) has no source site to link to
            }
        }

        /**
         * Admin-configured source list (MdblistRatingsSources, config page):
         * comma-separated source keys. Empty = show every source MDBList has
         * data for, in DEFAULT_ORDER. Non-empty = show ONLY the listed
         * sources, in exactly that order.
         * @returns {Array<string>}
         */
        function getConfiguredSources() {
            const raw = JE.pluginConfig?.MdblistRatingsSources || '';
            return raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
        }

        function injectCss() {
            const styleId = 'je-mdblist-ratings-styles';
            if (document.getElementById(styleId)) return;

            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                .${sectionClass} {
                    display: flex;
                    flex-wrap: wrap;
                    align-items: center;
                    gap: 5px;
                    margin: 1em 0;
                    font-size: 1.05em;
                }
                .${sectionClass} .je-mdblist-badge {
                    display: inline-flex;
                    align-items: center;
                    gap: 6px;
                    text-decoration: none;
                    color: inherit;
                    font-size: inherit;
                }
                .${sectionClass} a.je-mdblist-badge {
                    cursor: pointer;
                }
                .${sectionClass} a.je-mdblist-badge:hover {
                    text-decoration: underline;
                }
                .${sectionClass} .je-mdblist-badge .je-mdblist-source {
                    opacity: 0.7;
                    font-size: 0.9em;
                }
                .${sectionClass} .je-mdblist-badge .je-mdblist-logo {
                    height: 22px;
                    width: auto;
                    object-fit: contain;
                }
            `;
            document.head.appendChild(style);
        }

        function removeSection(page) {
            try {
                const root = page || document.querySelector('#itemDetailPage:not(.hide)') || document;
                const sec = root.querySelector(`.${sectionClass}`);
                if (sec && sec.parentNode) sec.parentNode.removeChild(sec);
            } catch (e) {
                console.warn(`${logPrefix} removeSection failed:`, e);
            }
        }

        function buildSection(entry, mediaType, title) {
            const wrap = document.createElement('div');
            wrap.className = sectionClass;

            const configuredSources = getConfiguredSources();
            const order = configuredSources.length ? configuredSources : DEFAULT_ORDER;

            const rows = (entry.Ratings || [])
                .filter(r => (r.Score !== null && r.Score !== undefined) || (r.Value !== null && r.Value !== undefined))
                .filter(r => configuredSources.length === 0 || configuredSources.includes((r.Source || '').toLowerCase()))
                .sort((a, b) => {
                    const ai = order.indexOf((a.Source || '').toLowerCase());
                    const bi = order.indexOf((b.Source || '').toLowerCase());
                    return (ai === -1 ? order.length : ai) - (bi === -1 ? order.length : bi);
                });

            const showPercent = !!JE.pluginConfig?.MdblistRatingsShowPercentSymbol;

            rows.forEach(r => {
                // r.Score is MDBList's own 0-100 figure, present only when that
                // source is scored (rogerebert never gets one). Falling back to
                // r.Value is fine, but "%" only makes sense on a true 0-100 Score.
                const hasNormalizedScore = r.Score !== null && r.Score !== undefined;
                const score = hasNormalizedScore ? r.Score : r.Value;
                const sourceKey = (r.Source || '').toLowerCase();
                const label = LABELS[sourceKey] || r.Source;
                const freshLogo = sourceKey === 'tomatoes' ? TOMATOES_STATUS_LOGOS[r.Fresh] : null;
                const logo = freshLogo || LOGOS[sourceKey];
                const link = generateLink(sourceKey, entry.Ids || {}, r.Url, mediaType, title);

                const votesText = r.Votes ? ` (${JE.t('mdblist_ratings_votes', { count: r.Votes })})` : '';
                const badgeTitle = `${label}: ${score}${votesText}`;
                const iconHtml = logo
                    ? `<img class="je-mdblist-logo" src="${JE.cdn.url('mdblist-logos', logo)}" alt="${escapeHtml(label)}" loading="lazy">`
                    : `<span class="je-mdblist-source">${escapeHtml(label)}</span>`;
                // Only round a true 0-100 Score (already whole numbers, so this
                // is a no-op). A raw fallback Value keeps its precision, e.g.
                // rogerebert's 3.5 stays 3.5, not 4.
                const scoreText = hasNormalizedScore
                    ? Math.round(score) + (showPercent ? '%' : '')
                    : String(score);
                const badgeHtml = `${iconHtml}<span>${scoreText}</span>`;

                // is="emby-linkbutton" (via createExternalLink) tells the native
                // app shell to open externally instead of the in-app WebView.
                // resetStyle strips the emby-button chrome so it renders as our
                // own flat badge, not a boxed button.
                const badge = link
                    ? extLink(link, {
                        className: 'je-mdblist-badge',
                        title: badgeTitle,
                        resetStyle: true,
                        setup: (a) => { a.innerHTML = badgeHtml; },
                    })
                    : Object.assign(document.createElement('span'), {
                        className: 'je-mdblist-badge',
                        title: badgeTitle,
                        innerHTML: badgeHtml,
                    });
                wrap.appendChild(badge);
            });

            return wrap;
        }

        // Targets the official-rating chip (e.g. "PG-13"), or failing that a
        // mediaInfoItem that looks like a runtime ("2h 15m"), in the top
        // metadata row. Same element extras/colored-ratings.js targets elsewhere.
        function findInsertionTarget(contextPage) {
            const official = contextPage.querySelector('div.mediaInfoItem.mediaInfoOfficialRating');
            if (official) return official;

            const runtimePattern = /^\d+\s*(?:h(?:ours?)?)?\s*\d*\s*m(?:inutes?)?$/i;
            const items = contextPage.querySelectorAll('div.mediaInfoItem');
            for (const el of items) {
                if (runtimePattern.test(el.textContent.trim())) return el;
            }
            return null;
        }

        function insertSection(contextPage, entry, mediaType, title) {
            removeSection(contextPage);

            if (!entry || !entry.Found || !Array.isArray(entry.Ratings) || entry.Ratings.length === 0) {
                return;
            }

            const section = buildSection(entry, mediaType, title);
            if (section.children.length === 0) return;

            const target = findInsertionTarget(contextPage);
            const scope = (target && (target.closest('.detailRibbon') || target.closest('.mainDetailButtons') || target.closest('.itemMiscInfo'))) || target?.parentNode;
            const extLinks = (scope && scope.querySelector && scope.querySelector('.itemExternalLinks')) || contextPage.querySelector('.itemExternalLinks');

            if (extLinks && extLinks.parentNode) {
                extLinks.insertAdjacentElement('beforebegin', section);
                return;
            }
            if (target && target.parentNode) {
                target.insertAdjacentElement('afterend', section);
                return;
            }

            // Fallback anchor chain for a skin/Jellyfin version without the classes
            // above, same one reviews.js/awards.js use, further down the page.
            const afterAnchor =
                contextPage.querySelector('.je-awards-section') ||
                contextPage.querySelector('.tmdb-reviews-section') ||
                contextPage.querySelector('.streaming-lookup-container') ||
                contextPage.querySelector('.tagline');

            if (afterAnchor && afterAnchor.parentNode) {
                afterAnchor.parentNode.insertBefore(section, afterAnchor.nextSibling);
                return;
            }

            const beforeAnchor = contextPage.querySelector('#similarCollapsible');
            if (beforeAnchor && beforeAnchor.parentNode) {
                beforeAnchor.parentNode.insertBefore(section, beforeAnchor);
                return;
            }

            console.warn(`${logPrefix} Could not find a suitable anchor to insert the ratings row.`);
        }

        async function fetchRatings(tmdbId, apiMediaType) {
            try {
                return await JE.core.api.plugin(`/mdblist-ratings/${apiMediaType}/${tmdbId}`);
            } catch (e) {
                // A ratings row is decoration; never surface a fetch failure to the user.
                console.warn(`${logPrefix} Failed to fetch ratings.`, e);
                return null;
            }
        }

        async function processPage(visiblePage) {
            if (!JE?.pluginConfig?.MdblistRatingsEnabled || !JE?.pluginConfig?.MdblistRatingsShowOnItemDetails) {
                removeSection(visiblePage);
                return;
            }

            try {
                const itemId = new URLSearchParams(window.location.hash.split('?')[1]).get('id');
                const userId = ApiClient.getCurrentUserId();
                if (!itemId || !userId) return;

                const item = JE.helpers?.getItemCached
                    ? await JE.helpers.getItemCached(itemId, { userId })
                    : await ApiClient.getItem(userId, itemId);
                const mediaType = item?.Type;

                let tmdbId = null;
                let apiMediaType;

                if (mediaType === 'Movie') {
                    tmdbId = item?.ProviderIds?.Tmdb;
                    apiMediaType = 'movie';
                } else if (mediaType === 'Series' || mediaType === 'Season' || mediaType === 'Episode') {
                    // Ratings are recorded against the series, not per episode/season
                    // (same TMDB id resolution as reviews.js/awards.js).
                    tmdbId = item?.ProviderIds?.Tmdb || item?.SeriesProviderIds?.Tmdb;
                    if (!tmdbId && item?.SeriesId) {
                        try {
                            const series = await ApiClient.getItem(userId, item.SeriesId);
                            tmdbId = series?.ProviderIds?.Tmdb;
                        } catch (_) { /* fall through to the not-found path below */ }
                    }
                    apiMediaType = 'tv';
                } else {
                    removeSection(visiblePage);
                    return;
                }

                if (!tmdbId) {
                    removeSection(visiblePage);
                    return;
                }

                // Use the series' own title for link generation too (e.g. Metacritic's
                // slug), not the season/episode's.
                const title = (mediaType === 'Season' || mediaType === 'Episode') ? (item?.SeriesName || item?.Name) : item?.Name;

                const entry = await fetchRatings(String(tmdbId), apiMediaType);
                insertSection(visiblePage, entry, apiMediaType, title);
            } catch (error) {
                console.error(`${logPrefix} Error processing page:`, error);
            }
        }

        injectCss();

        const unregister = JE.helpers.onViewPage(async (view, element, hash) => {
            if (!JE?.pluginConfig?.MdblistRatingsEnabled || !JE?.pluginConfig?.MdblistRatingsShowOnItemDetails) {
                unregister();
                return;
            }

            const currentHash = window.location.hash;
            const hasItemId = currentHash.includes('id=') || (hash && hash.includes('id='));
            const isItemDetailElement = element && (
                element.id === 'itemDetailPage' ||
                element.classList?.contains('itemDetailPage')
            );

            if (!hasItemId && !isItemDetailElement) {
                return;
            }

            await new Promise(resolve => setTimeout(resolve, 150));

            const visiblePage = document.querySelector('#itemDetailPage:not(.hide)');
            if (visiblePage) {
                processPage(visiblePage);
            } else {
                setTimeout(() => {
                    const retryPage = document.querySelector('#itemDetailPage:not(.hide)');
                    if (retryPage) processPage(retryPage);
                }, 500);
            }
        }, {
            pages: null,
            fetchItem: false,
            immediate: true
        });
    };
})(window.JellyfinEnhanced);
