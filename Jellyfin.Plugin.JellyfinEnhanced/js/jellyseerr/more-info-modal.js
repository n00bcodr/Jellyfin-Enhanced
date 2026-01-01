// /js/jellyseerr/more-info-modal.js
(function(JE) {
    'use strict';

    const moreInfoModal = {};
    const logPrefix = '🪼 Jellyfin Enhanced: Jellyseerr More Info:';

    let currentModal = null;

/**
 * Open the more info modal for a movie or TV show
 * @param {number} tmdbId - The TMDB ID
 * @param {string} mediaType - 'movie' or 'tv'
 */
moreInfoModal.open = async function(tmdbId, mediaType) {
    try {
        // Fetch details first so the modal can open immediately
        const data = await fetchMediaDetails(tmdbId, mediaType);
        if (!data) {
            showError('Failed to load media information');
            return;
        }

        // Render modal immediately
        showModal(data, mediaType);

        // Fetch ratings in the background and populate when ready
        fetchRatings(tmdbId, mediaType)
            .then((ratings) => {
                // Modal might have been closed or replaced; ensure we're updating the correct one
                if (!currentModal) return;
                const modalTmdbId = currentModal?.dataset?.tmdbId;
                const modalMediaType = currentModal?.dataset?.mediaType;
                if (String(modalTmdbId) !== String(data.id) || modalMediaType !== mediaType) return;

                data.ratings = ratings;
                const mount = currentModal.querySelector('[data-mount="ratings"]');
                if (mount) {
                    const logos = buildRatingLogos(ratings, data, mediaType, tmdbId);
                    mount.innerHTML = logos || '';
                }
            })
            .catch((error) => {
                console.error(`${logPrefix} Failed to fetch ratings for TMDB ID ${tmdbId}:`, error);
                // Silently fail; modal is already shown without ratings
            });
    } catch (error) {
        console.error('Error opening more info modal:', error);
        showError('Failed to load media information');
    }
}

/**
 * Fetch ratings from Jellyseerr API
 */
async function fetchRatings(tmdbId, mediaType) {
    try {
        const endpoint = mediaType === 'tv'
            ? `/tv/${tmdbId}/ratings`
            : `/movie/${tmdbId}/ratingscombined`;
        const response = await ApiClient.ajax({
            type: 'GET',
            url: ApiClient.getUrl(`/JellyfinEnhanced/jellyseerr${endpoint}`),
            headers: { 'X-Jellyfin-User-Id': ApiClient.getCurrentUserId() },
            dataType: 'json'
        });
        if (mediaType === 'tv') {
            return response ? { rt: response } : null;
        }
        return response;
    } catch (error) {
        console.warn(`${logPrefix} Failed to fetch ratings for ${mediaType} ${tmdbId}:`, error);
        return null;
    }
}

/**
 * Fetch media details from Jellyseerr API via proxy
 */
async function fetchMediaDetails(tmdbId, mediaType) {
    try {
        const endpoint = mediaType === 'movie'
            ? `/movie/${tmdbId}`
            : `/tv/${tmdbId}`;

        const response = await ApiClient.ajax({
            type: 'GET',
            url: ApiClient.getUrl(`/JellyfinEnhanced/jellyseerr${endpoint}`),
            headers: { 'X-Jellyfin-User-Id': ApiClient.getCurrentUserId() },
            dataType: 'json'
        });

        return response;
    } catch (error) {
        console.error(`${logPrefix} Failed to fetch ${mediaType} details for TMDB ID ${tmdbId}:`, error);
        throw error;
    }
}

/**
 * Get content rating for specified region
 */
function getContentRating(data, mediaType) {
    // Resolve region: prefer Elsewhere user setting → plugin fallback → US
    const region = (JE?.userConfig?.elsewhere?.Region || JE?.pluginConfig?.DEFAULT_REGION || 'US')?.toUpperCase();

    if (mediaType === 'movie') {
        // For movies: releases.results[].release_dates[].certification
        const releases = data.releases?.results;
        if (!Array.isArray(releases)) return 'N/A';

        // Find region release
        let regionRelease = releases.find(r => r.iso_3166_1 === region);
        if (!regionRelease) {
            regionRelease = releases.find(r => r.iso_3166_1 === 'US');
        }
        if (!regionRelease && releases.length > 0) {
            regionRelease = releases[0];
        }

        if (!regionRelease?.release_dates?.length) return 'N/A';

        // Get first theatrical release (type 3) with certification
        let release = regionRelease.release_dates.find(rd => rd.type === 3 && rd.certification);
        if (!release) {
            release = regionRelease.release_dates.find(rd => rd.certification);
        }

        return release?.certification || 'N/A';
    } else {
        // For TV: contentRatings.results[].rating
        const results = data.contentRatings?.results;
        if (!Array.isArray(results)) return 'N/A';

        let regionRating = results.find(r => r.iso_3166_1 === region);
        if (!regionRating) {
            regionRating = results.find(r => r.iso_3166_1 === 'US');
        }
        if (!regionRating && results.length > 0) {
            regionRating = results[0];
        }

        return regionRating?.rating || 'N/A';
    }
}

/**
 * Show the modal with media information
 */
function showModal(data, mediaType) {
    // Close existing modal if any
    moreInfoModal.close();

    const modal = document.createElement('div');
    modal.className = 'je-more-info-modal';
    modal.innerHTML = buildModalContent(data, mediaType);
    // Tag modal so async updates only apply to the current item
    modal.dataset.tmdbId = String(data.id || '');
    modal.dataset.mediaType = mediaType;

    // Add event listeners
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            moreInfoModal.close();
        }
    });

    // Close button handler
    const closeBtn = modal.querySelector('.modal-close');
    if (closeBtn) {
        closeBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            moreInfoModal.close();
        });
    }

    // Handle cast/crew image errors
    modal.querySelectorAll('.person-image').forEach(img => {
        img.addEventListener('error', () => {
            img.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"%3E%3Ccircle cx="50" cy="50" r="40" fill="%23555"/%3E%3C/svg%3E';
        });
    });

    document.body.appendChild(modal);
    currentModal = modal;

    // Render action buttons/chips after mount
    renderActions(data, mediaType);

    // Listen for TV season requests to update status
    if (mediaType === 'tv') {
        const handleTvRequest = async (e) => {
            if (!e.detail?.tmdbId || String(e.detail.tmdbId) !== String(data.id)) return;

            try {
                // Refresh details to pull latest status/progress
                const fresh = await fetchMediaDetails(data.id, 'tv');
                if (fresh?.mediaInfo) {
                    data.mediaInfo = fresh.mediaInfo;
                } else {
                    // Fallback: mark requested
                    const mediaInfo = data.mediaInfo || (data.mediaInfo = {});
                    mediaInfo.status = mediaInfo.status || 2;
                }
            } catch (_) {
                const mediaInfo = data.mediaInfo || (data.mediaInfo = {});
                mediaInfo.status = mediaInfo.status || 2;
            }

            renderActions(data, mediaType);
        };
        document.addEventListener('jellyseerr-tv-requested', handleTvRequest);
        modal._cleanupTvListener = () => document.removeEventListener('jellyseerr-tv-requested', handleTvRequest);
    }

    // Trigger animation
    setTimeout(() => modal.classList.add('active'), 10);
}

/**
 * Build the modal content HTML
 */
function buildModalContent(data, mediaType) {
    const title = mediaType === 'movie' ? data.title : data.name;
    const releaseDate = mediaType === 'movie' ? data.releaseDate : data.firstAirDate;
    const runtime = mediaType === 'movie'
        ? `${data.runtime} minutes`
        : data.episodeRunTime?.length ? `${data.episodeRunTime[0]} min episodes` : 'N/A';

    const year = releaseDate ? new Date(releaseDate).getFullYear() : 'N/A';
    const budget = data.budget ? formatCurrency(data.budget) : null;
    const revenue = data.revenue ? formatCurrency(data.revenue) : null;

    const backdropUrl = data.backdropPath
        ? `https://image.tmdb.org/t/p/original${data.backdropPath}`
        : '';

    const posterUrl = data.posterPath
        ? `https://image.tmdb.org/t/p/w500${data.posterPath}`
        : '';

    return `
        <div class="modal-overlay">
            <div class="modal-container">
                <button class="modal-close" aria-label="Close">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                </button>

                <div class="modal-backdrop" style="background-image: url('${backdropUrl}');">
                    <div class="je-modal-backdrop-overlay"></div>
                </div>

                <div class="modal-content">
                    <div class="modal-main">
                        <div class="modal-left">
                            <div class="header-section">
                                <div class="header-poster">
                                    ${posterUrl ? `<img src="${posterUrl}" alt="${title}" />` : ''}
                                </div>
                                <div class="header-info">
                                    <div class="title-row">
                                    <h1 class="title">${escapeHtml(title)} ${year ? `<span class="year">(${year})</span>` : ''}</h1>
                                    <div class="title-chip" data-mount="je-status-chip"></div>
                                    </div>
                                    <div class="meta-info">
                                        <span class="rating-badge">${getContentRating(data, mediaType)}</span>
                                        <span class="runtime">${runtime}</span>
                                        <span class="genres">${data.genres?.map(g => escapeHtml(g.name)).join(', ') || 'N/A'}</span>
                                    </div>
                                    ${data.tagline ? `<p class="tagline">${escapeHtml(data.tagline)}</p>` : ''}
                                    <div class="je-downloads" data-mount="je-downloads"></div>
                                    <div class="je-more-info-actions" data-mount="je-actions"></div>
                                </div>
                            </div>

                            ${data.overview ? `
                                <div class="overview-section">
                                    <h3>Overview</h3>
                                    <p>${escapeHtml(data.overview)}</p>
                                </div>
                            ` : ''}

                            ${buildCrewSection(data, mediaType)}

                            ${buildKeywordsSection(data)}

                            ${buildCastSection(data)}

                            ${buildTrailersSection(data)}
                        </div>

                        <div class="modal-right">
                            ${buildRightPanel(data, mediaType, { budget, revenue, releaseDate, tmdbId: data.id })}
                        </div>
                    </div>

                    ${mediaType === 'tv' ? buildSeasonsSection(data) : ''}
                    ${buildProductionSection(data)}
                </div>
            </div>
        </div>
    `;
}

/**
 * Build right panel with ratings and stats
 */
function buildRightPanel(data, mediaType, { budget, revenue, releaseDate, tmdbId }) {
    return `
        <div class="je-more-info-right-panel">
            <div class="je-more-info-media-ratings" data-mount="ratings">
                ${data.ratings ? buildRatingLogos(data.ratings, data, mediaType, tmdbId) : `
                    <div class="je-more-info-ratings-skeleton">
                        <span class="je-skel-badge"></span>
                        <span class="je-skel-badge" style="width:72px"></span>
                    </div>
                `}
            </div>
            <div class="je-more-info-stats-panel">
                <div class="je-more-info-stat-row">
                    <div class="je-more-info-stat-label">Status</div>
                    <div class="je-more-info-stat-value">${escapeHtml(data.status || 'N/A')}</div>
                </div>

                ${mediaType === 'tv' ? `
                    ${data.firstAirDate ? `
                        <div class="je-more-info-stat-row">
                            <div class="je-more-info-stat-label">First Air Date</div>
                            <div class="je-more-info-stat-value">${new Date(data.firstAirDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</div>
                        </div>
                    ` : ''}
                    ${data.lastAirDate ? `
                        <div class="je-more-info-stat-row">
                            <div class="je-more-info-stat-label">Last Air Date</div>
                            <div class="je-more-info-stat-value">${new Date(data.lastAirDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</div>
                        </div>
                    ` : ''}
                ` : `
                    ${releaseDate ? `
                        <div class="je-more-info-stat-row">
                            <div class="je-more-info-stat-label">Release Date</div>
                            <div class="je-more-info-stat-value">${new Date(releaseDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</div>
                        </div>
                    ` : ''}
                `}

                ${revenue ? `
                    <div class="je-more-info-stat-row">
                        <div class="je-more-info-stat-label">Revenue</div>
                        <div class="je-more-info-stat-value">${revenue}</div>
                    </div>
                ` : ''}

                ${budget ? `
                    <div class="je-more-info-stat-row">
                        <div class="je-more-info-stat-label">Budget</div>
                        <div class="je-more-info-stat-value">${budget}</div>
                    </div>
                ` : ''}

                ${data.originalLanguage ? `
                    <div class="je-more-info-stat-row">
                        <div class="je-more-info-stat-label">Original Language</div>
                        <div class="je-more-info-stat-value">${data.originalLanguage.toUpperCase()}</div>
                    </div>
                ` : ''}

                ${data.productionCountries?.length ? `
                    <div class="je-more-info-stat-row">
                        <div class="je-more-info-stat-label">Production Country</div>
                        <div class="je-more-info-stat-value">${data.productionCountries.map(c => {
                            const disp = c?.name === 'United States of America' ? 'United States' : (c?.name || '');
                            const code = (c?.iso_3166_1 || '').toLowerCase();
                            return `<div><img src="https://flagcdn.com/w20/${code}.png" alt="${escapeHtml(disp)}" title="${escapeHtml(disp)}" style="margin-right: 6px; vertical-align: middle;" /> ${escapeHtml(disp)}</div>`;
                        }).join('')}</div>
                    </div>
                ` : ''}

                ${data.productionCompanies?.length ? `
                    <div class="je-more-info-stat-row">
                        <div class="je-more-info-stat-label">Studios</div>
                        <div class="je-more-info-stat-value">${data.productionCompanies.slice(0, 3).map(c => escapeHtml(c.name)).join(', ')}</div>
                    </div>
                ` : ''}

                ${buildStreamingProviders(data)}
            </div>
            ${buildMediaFacts(data, mediaType, tmdbId)}
        </div>
    `;
}

/**
 * Build streaming providers section
 */
function buildStreamingProviders(data) {
    // Resolve region: prefer Elsewhere user setting → plugin fallback → US
    const region = (JE?.userConfig?.elsewhere?.Region || JE?.pluginConfig?.DEFAULT_REGION || 'US')?.toUpperCase();

    // watchProviders is already the array of region objects
    if (!Array.isArray(data.watchProviders)) return '';

    let regionNode = data.watchProviders.find(r => r.iso_3166_1 === region);
    if (!regionNode) {
        regionNode = data.watchProviders.find(r => r.iso_3166_1 === 'US');
    }
    if (!regionNode && data.watchProviders.length > 0) {
        regionNode = data.watchProviders[0];
    }

    if (!regionNode || !regionNode.flatrate?.length) return '';

    // Only flatrate providers, unique by ID, limit to 6
    const uniqueProviders = [];
    const seenIds = new Set();
    for (const p of regionNode.flatrate) {
        if (!seenIds.has(p.id)) {
            seenIds.add(p.id);
            uniqueProviders.push(p);
            if (uniqueProviders.length >= 6) break;
        }
    }

    if (!uniqueProviders.length) return '';

    return `
        <div class="je-more-info-stat-row">
            <div class="je-more-info-stat-label">Streaming</div>
            <div class="je-more-info-providers-list">
                ${uniqueProviders.map(p => `<img src="https://image.tmdb.org/t/p/w92${p.logoPath}" alt="${escapeHtml(p.name)}" title="${escapeHtml(p.name)}" />`).join('')}
            </div>
        </div>
    `;
}

/**
 * Build keywords section
 */
function buildKeywordsSection(data) {
    if (!data.keywords?.length) return '';

    return `
        <div class="keywords-section">
            <div class="keywords-grid">
                ${data.keywords.slice(0, 20).map(k => `<span class="keyword">${escapeHtml(k.name)}</span>`).join('')}
            </div>
        </div>
    `;
}

/**
 * Build rating logos (for right panel)
 */
function buildRatingLogos(ratings, data, mediaType, tmdbId) {
    const logos = [];

    // Rotten Tomatoes Critics
    if (ratings?.rt?.criticsScore !== undefined) {
        const criticState = ratings.rt.criticsRating ? ratings.rt.criticsRating.toLowerCase() : null;
        const isFresh = criticState ? criticState.includes('fresh') : ratings.rt.criticsScore >= 60;
        const rtLink = (mediaType === 'tv' ? ratings.url : ratings.rt.url) || 'https://www.rottentomatoes.com';
        const rottenSvg = `<svg viewBox="0 0 560 560" xmlns="http://www.w3.org/2000/svg" class="w-6"><path d="M445.185 444.684c-79.369 4.167-95.587-86.652-126.726-86.006-13.268.279-23.726 14.151-19.133 30.32 2.525 8.888 9.53 21.923 13.944 30.011 15.57 28.544-7.447 60.845-34.383 63.577-44.76 4.54-63.433-21.426-62.278-48.007 1.3-29.84 26.6-60.331.65-73.305-27.194-13.597-49.301 39.572-75.325 51.439-23.553 10.741-56.248 2.413-67.872-23.741-8.164-18.379-6.68-53.768 29.67-67.27 22.706-8.433 73.305 11.029 75.9-13.623 2.992-28.416-53.155-30.812-70.06-37.626-29.912-12.055-47.567-37.85-33.734-65.522 10.378-20.757 40.915-29.203 64.223-20.11 27.922 10.892 32.404 39.853 46.71 51.897 12.324 10.38 29.19 11.68 40.22 4.543 8.135-5.265 10.843-16.828 7.774-27.39-4.07-14.023-14.875-22.773-25.415-31.346-18.758-15.249-45.24-28.36-29.222-69.983 13.13-34.11 51.642-35.34 51.642-35.34 15.3-1.72 29.002 2.9 40.167 12.875 14.927 13.335 17.834 31.16 15.336 50.176-2.283 17.358-8.426 32.56-11.63 49.759-3.717 19.966 6.954 40.086 27.249 40.869 26.694 1.031 34.698-19.486 37.964-32.492 4.782-19.028 11.058-36.694 28.718-47.82 25.346-15.97 60.552-12.47 76.886 18.222 12.92 24.284 8.772 57.715-11.047 75.97-8.892 8.188-19.584 11.075-31.148 11.156-16.585.117-33.162-.29-48.556 7.471-10.48 5.281-15.047 13.888-15.045 25.423 0 11.242 5.853 18.585 15.336 23.363 17.86 9.003 37.577 10.843 56.871 14.222 27.98 4.9 52.581 14.755 68.375 40.72.142.228.28.458.415.69 18.139 30.741-.831 75.005-36.476 76.878" fill="#0AC855"></path></svg>`;
        const freshSvg = `<svg viewBox="0 0 560 560" xmlns="http://www.w3.org/2000/svg" class="w-6"><path d="M478.29 296.98c-3.99-63.966-36.52-111.82-85.468-138.58.278 1.56-1.109 3.508-2.688 2.818-32.016-14.006-86.328 31.32-124.28 7.584.285 8.519-1.378 50.072-59.914 52.483-1.382.056-2.142-1.355-1.268-2.354 7.828-8.929 15.732-31.535 4.367-43.586-24.338 21.81-38.472 30.017-85.138 19.186-29.878 31.241-46.809 74-43.485 127.26 6.78 108.74 108.63 170.89 211.19 164.49 102.56-6.395 193.47-80.572 186.68-189.31" fill="#FA320A"></path><path d="M291.375 132.293c21.075-5.023 81.693-.49 101.114 25.274 1.166 1.545-.475 4.468-2.355 3.648-32.016-14.006-86.328 31.32-124.282 7.584.285 8.519-1.378 50.072-59.914 52.483-1.382.056-2.142-1.355-1.268-2.354 7.828-8.929 15.73-31.535 4.367-43.586-26.512 23.758-40.884 31.392-98.426 15.838-1.883-.508-1.241-3.535.762-4.298 10.876-4.157 35.515-22.361 58.824-30.385 4.438-1.526 8.862-2.71 13.18-3.4-25.665-2.293-37.235-5.862-53.559-3.4-1.789.27-3.004-1.813-1.895-3.241 21.995-28.332 62.513-36.888 87.512-21.837-15.41-19.094-27.48-34.321-27.48-34.321l28.601-16.246s11.817 26.4 20.414 45.614c21.275-31.435 60.86-34.336 77.585-12.033.992 1.326-.045 3.21-1.702 3.171-13.612-.331-21.107 12.05-21.675 21.466l.197.023" fill="#00912D"></path></svg>`;

        logos.push(`
            <a is="emby-linkbutton" href="${escapeHtml(rtLink)}" target="_blank" rel="noopener noreferrer" class="je-more-info-rating-badge-item" title="Rotten Tomatoes Tomatometer">
                <span class="je-more-info-rating-icon je-more-info-rt">${isFresh ? freshSvg : rottenSvg}</span>
                <span class="je-more-info-rating-percent">${ratings.rt.criticsScore}%</span>
            </a>
        `);

        if (ratings.rt.audienceScore !== undefined) {
            const audienceState = ratings.rt.audienceRating ? ratings.rt.audienceRating.toLowerCase() : null;
            const audienceFresh = audienceState ? audienceState.includes('upright') : ratings.rt.audienceScore >= 60;
            const popcornFull = `<svg viewBox="0 0 560 560" xmlns="http://www.w3.org/2000/svg" class="w-6"><path fill="#fff" d="m370.57 474.214 23.466-237.956c14.93-4.796 29.498-11.15 40.23-20.262L404.16 446.278c-6.748 10.248-19.863 20.86-33.59 27.936zm-78.197 21.631 2.947-244.528c20.894-.599 47.933-3.43 70.97-8.346l-19.07 241.17c-22.724 7.518-35.934 9.848-54.847 11.704zm-99.694-252.874c23.038 4.916 50.077 7.747 70.971 8.346l2.948 244.528c-18.914-1.856-32.123-4.186-54.847-11.705l-19.072-241.17zm-67.974-26.975c10.732 9.112 25.3 15.466 40.23 20.262l23.464 237.956c-13.726-7.075-26.84-17.688-33.59-27.936l-30.104-230.282z"></path><path fill="gold" d="M118.905 157.445c1.357 28.827 72.771 51.677 160.578 51.176 76.687-.438 140.659-18.546 156.329-42.336a22.976 22.976 0 0 0-14.058-7.426c.06-.7.098-1.406.095-2.122-.065-11.4-8.429-20.788-19.327-22.54.287-1.474.438-2.999.43-4.559-.072-12.696-10.426-22.928-23.124-22.856-.287.001-.568.036-.853.049a22.911 22.911 0 0 0 1.254-7.56c-.074-12.697-10.425-22.93-23.123-22.858a22.914 22.914 0 0 0-8.247 1.6c-3.632-6.835-10.606-11.6-18.737-12.149-1.416-11.4-11.157-20.195-22.93-20.129-7.41.042-13.963 3.6-18.136 9.065-4.233-4.605-10.3-7.494-17.047-7.456-12.698.072-22.932 10.424-22.86 23.118a22.983 22.983 0 0 0 1.115 6.946 22.918 22.918 0 0 0-13.07 7.459c-2.644-9.847-11.637-17.084-22.314-17.024-9.975.057-18.406 6.47-21.537 15.366-8.474 3.426-14.439 11.738-14.383 21.433.012 2.154.342 4.227.907 6.202a22.876 22.876 0 0 0-9.328-1.932c-10.012.058-18.47 6.516-21.574 15.465a22.83 22.83 0 0 0-9.788-2.149c-12.698.072-22.934 10.422-22.86 23.118a22.833 22.833 0 0 0 3.159 11.463c-.202.203-.379.426-.571.636"></path><path fill="#FA320A" d="M404.161 446.278c-6.749 10.248-19.864 20.86-33.59 27.936l23.465-237.956c14.93-4.796 29.498-11.15 40.23-20.262L404.16 446.278zM347.22 484.14c-22.723 7.519-35.934 9.85-54.847 11.705l2.947-244.528c20.894-.599 47.933-3.43 70.973-8.346L347.22 484.14zm-135.47 0-19.07-241.17c23.037 4.917 50.076 7.748 70.97 8.347l2.948 244.528c-18.914-1.856-32.123-4.186-54.847-11.705zm-56.94-37.862-30.105-230.282c10.732 9.112 25.3 15.466 40.23 20.262l23.464 237.956c-13.726-7.075-26.84-17.688-33.588-27.936zm247.668-321.143c.298 1.453.465 2.955.473 4.498a23.018 23.018 0 0 1-.43 4.56c10.9 1.749 19.263 11.137 19.328 22.54a23.59 23.59 0 0 1-.095 2.12 22.976 22.976 0 0 1 14.058 7.425c-15.669 23.792-79.642 41.9-156.327 42.34-87.807.502-159.221-22.346-160.58-51.175.192-.208.37-.433.57-.634-1.355-2.311-2.29-4.887-2.773-7.62-8.408 7.979-13.495 14.412-12.6 23.78.085 1.251 37.196 266.911 37.196 266.911 4.282 42.075 65.391 75.703 138.187 76.12 72.796-.417 133.907-34.045 138.187-76.12 0 0 37.11-265.66 37.197-266.912 1.777-18.736-20.15-35.745-52.39-47.833z"></path></svg>`;
            const popcornSpilled = `<svg viewBox="0 0 560 560" xmlns="http://www.w3.org/2000/svg" class="w-6"><path d="m76.802 407.32 237.94 23.482c4.794 14.937 11.149 29.517 20.259 40.256l-230.27-30.125c-10.248-6.752-20.861-19.877-27.936-33.612zm222.88-75.298c.6 20.906 3.432 47.964 8.346 71.017l-241.15-19.083c-7.518-22.739-9.846-35.959-11.704-54.885l244.51 2.951zm8.346-102.71c-4.914 23.053-7.745 50.111-8.346 71.017l-244.51 2.951c1.858-18.926 4.186-32.146 11.704-54.885l241.15-19.083zm26.973-68.019c-9.11 10.74-15.465 25.318-20.259 40.257l-237.94 23.48c7.075-13.735 17.69-26.859 27.936-33.612l230.27-30.125z" fill="#fff"></path><path d="M336.57 404.67c3.155-7.82 14.337-12.586 22.367-12.028 8.582.596 17.699 9.626 19.292 18.507.296-.322.606-.627.92-.927 2.757-2.636 6.21-4.385 9.988-4.866a22.57 22.57 0 0 1-.32-8.12c1.395-9.9 9.333-17.325 18.421-17.251 5.865.047 11.011 3.05 14.364 7.665.3-.375.63-.719.953-1.07 3.834-19.99 6.264-42.577 6.817-66.546 1.9-82.42-18.993-149.75-46.663-150.39-27.672-.64-51.644 65.656-53.544 148.08 0 0-1.465 30.062 7.405 86.95" fill="#00641E"></path><path d="M523.91 494.8c1.635-2.732 2.55-6.007 2.486-9.487.53-11.245-7.182-21.44-17.913-20.31a22.57 22.57 0 0 0 .592-4.003c.643-11.264-7.119-20.972-17.337-21.682a21.444 21.444 0 0 0-.667-.028 22.33 22.33 0 0 0 1.402-9.223c-.528-9.371-6.985-17.268-15.386-18.822a16.906 16.906 0 0 0-8.671.652c-2.546-6.277-7.891-10.933-14.393-11.916-.515-10.192-7.87-18.58-17.34-19.238-5.955-.413-11.426 2.324-15.085 6.906-3.353-4.614-8.499-7.615-14.364-7.663-9.089-.075-17.027 7.35-18.422 17.252a22.573 22.573 0 0 0 .32 8.119c-3.778.48-7.231 2.23-9.987 4.865-.315.3-.625.604-.92.927-1.594-8.882-10.71-17.91-19.293-18.507-8.029-.558-19.357 4.324-22.367 12.028 1.32 13.434 9.71 50.053 40.055 82.903l.27.019c2.926 2.65 6.746 4.11 10.818 3.746 2.525-.226 4.85-1.13 6.853-2.525l.488.034c2.67 1.855 5.88 2.826 9.27 2.525a13.938 13.938 0 0 0 3.707-.873c2.907 6.014 9.388 9.901 16.622 9.263a17.45 17.45 0 0 0 13.164-7.961l.907.063c2.796 2.774 6.513 4.39 10.522 4.269 3.314 5.019 9.402 8.106 16.12 7.516a18.464 18.464 0 0 0 6.998-2.064c3.514 4.326 9.281 6.899 15.61 6.342 6.255-.549 11.54-4.02 14.413-8.82 2.824 2.27 6.363 3.487 10.12 3.152 3.645-.326 6.884-2.048 9.318-4.654l.406.028a24.5 24.5 0 0 0 1.466-2.453l.028-.05c.06-.11.133-.218.189-.33" fill="gold"></path><path d="m314.75 201.547-237.94 23.48c7.075-13.735 17.689-26.859 27.936-33.612l230.27-30.125c-9.11 10.74-15.465 25.318-20.259 40.257zm20.259 269.51-230.27-30.125c-10.248-6.752-20.861-19.877-27.936-33.611l237.94 23.48c4.794 14.937 11.149 29.517 20.259 40.256zm-268.13-87.102c-7.518-22.739-9.847-35.957-11.704-54.885l244.51 2.951c.6 20.906 3.432 47.964 8.346 71.017l-241.15-19.083zm0-135.56 241.15-19.083c-4.915 23.053-7.746 50.111-8.346 71.019l-244.51 2.95c1.857-18.927 4.186-32.147 11.704-54.886zm344.72-82.679c-15.255-17.778-26.206-26.124-35.587-25.04-1.75.223-266.89 37.222-266.89 37.222-42.074 4.283-75.7 65.432-76.117 138.28.417 72.843 34.043 133.99 76.117 138.28 0 0 265.64 37.135 266.89 37.221a27.043 27.043 0 0 0 6.567-.866 14.721 14.721 0 0 1-5.686-3.214l-.27-.019c-30.345-32.848-38.735-69.47-40.055-82.903.003-.01.01-.02.014-.03l-.014.03c-8.87-56.889-7.404-86.95-7.404-86.95 1.9-82.42 25.872-148.72 53.544-148.08 27.67.639 48.562 67.972 46.663 150.39-.553 23.968-2.984 46.555-6.818 66.546 3.94-4.351 9.223-6.184 14.133-5.837.903.065 1.782.217 2.644.415 16.804-92.03-.813-181.89-27.73-215.44z" fill="#04A53C"></path></svg>`;
            logos.push(`
                <a is="emby-linkbutton" href="${escapeHtml(rtLink)}" target="_blank" rel="noopener noreferrer" class="je-more-info-rating-badge-item" title="Rotten Tomatoes Audience Score">
                    <span class="je-more-info-rating-icon je-more-info-popcorn">${audienceFresh ? popcornFull : popcornSpilled}</span>
                    <span class="je-more-info-rating-percent">${ratings.rt.audienceScore}%</span>
                </a>
            `);
        }
    }

    // IMDb
    if (ratings?.imdb?.criticsScore) {
        const imdbLink = ratings.imdb.url || 'https://www.imdb.com';
        logos.push(`
            <a is="emby-linkbutton" href="${escapeHtml(imdbLink)}" target="_blank" rel="noopener noreferrer" class="je-more-info-rating-badge-item" title="IMDb Rating">
                <span class="je-more-info-rating-icon je-more-info-imdb"><svg viewBox="0 0 575 289.83" xmlns="http://www.w3.org/2000/svg"><path fill="#f6c700" d="M575 24.91C573.44 12.15 563.97 1.98 551.91 0H23.32C10.11 2.17 0 14.16 0 28.61v232.25c0 16 12.37 28.97 27.64 28.97h519.95c14.06 0 25.67-11.01 27.41-25.26V24.91z"/><path stroke="#000" d="M69.35 58.24h45.63v175.65H69.35V58.24zM201.2 139.15c-3.92-26.77-6.1-41.65-6.53-44.62-1.91-14.33-3.73-26.8-5.47-37.44h-59.16v175.65h39.97l.14-115.98 16.82 115.98h28.47l15.95-118.56.15 118.56h39.84V57.09h-59.61l-10.57 82.06zM346.71 93.63c.5 2.24.76 7.32.76 15.26v68.1c0 11.69-.76 18.85-2.27 21.49-1.52 2.64-5.56 3.95-12.11 3.95V87.13c4.97 0 8.36.53 10.16 1.57 1.8 1.05 2.96 2.69 3.46 4.93zm20.61 137.32c5.43-1.19 9.99-3.29 13.69-6.28 3.69-3 6.28-7.15 7.76-12.46 1.49-5.3 2.37-15.83 2.37-31.58v-61.68c0-16.62-.65-27.76-1.66-33.42-1.02-5.67-3.55-10.82-7.6-15.44-4.06-4.62-9.98-7.94-17.76-9.96-7.79-2.02-20.49-3.04-42.58-3.04H287.5v175.65h55.28c12.74-.4 20.92-.99 24.54-1.79zM464.76 204.7c-.84 2.23-4.52 3.36-7.3 3.36-2.72 0-4.53-1.08-5.45-3.25-.92-2.16-1.37-7.09-1.37-14.81v-46.42c0-8 .4-12.99 1.21-14.98.8-1.97 2.56-2.97 5.28-2.97 2.78 0 6.51 1.13 7.47 3.4.95 2.27 1.43 7.12 1.43 14.55v45.01c-.29 9.25-.71 14.62-1.27 16.11zm-58.08 26.51h41.08c1.71-6.71 2.65-10.44 2.84-11.19 3.72 4.5 7.81 7.88 12.3 10.12 4.47 2.25 11.16 3.37 16.34 3.37 7.21 0 13.43-1.89 18.68-5.68 5.24-3.78 8.58-8.26 10-13.41 1.42-5.16 2.13-13 2.13-23.54V141.6c0-10.6-.24-17.52-.71-20.77s-1.87-6.56-4.2-9.95-5.72-6.02-10.16-7.9-9.68-2.82-15.72-2.82c-5.25 0-11.97 1.05-16.45 3.12-4.47 2.07-8.53 5.21-12.17 9.42V55.56h-43.96v175.65z"/></svg></span>
                <span class="je-more-info-rating-score">${ratings.imdb.criticsScore.toFixed(1)}</span>
            </a>
        `);
    }
    // TMDB User Score (after IMDb)
    if (data?.voteAverage && tmdbId && mediaType) {
        const percent = Math.round(data.voteAverage * 10);
        const votes = typeof data.voteCount === 'number' ? data.voteCount : undefined;
        const tmdbLink = `https://www.themoviedb.org/${mediaType}/${tmdbId}`;
        const title = votes !== undefined
            ? `TMDB User Score (${votes.toLocaleString()} votes)`
            : 'TMDB User Score';
        const tmdbSvg = '<svg viewBox="0 0 185.04 133.4" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="tmdb_svg__a" x2="185.04" y1="66.7" y2="66.7" gradientUnits="userSpaceOnUse"><stop stop-color="#90cea1" offset="0"></stop><stop stop-color="#3cbec9" offset="0.56"></stop><stop stop-color="#00b3e5" offset="1"></stop></linearGradient></defs><path d="M51.06 66.7A17.67 17.67 0 0 1 68.73 49h-.1A17.67 17.67 0 0 1 86.3 66.7a17.67 17.67 0 0 1-17.67 17.67h.1A17.67 17.67 0 0 1 51.06 66.7Zm82.67-31.33h32.9A17.67 17.67 0 0 0 184.3 17.7 17.67 17.67 0 0 0 166.63 0h-32.9a17.67 17.67 0 0 0-17.67 17.7 17.67 17.67 0 0 0 17.67 17.67Zm-113 98h63.9a17.67 17.67 0 0 0 17.67-17.67A17.67 17.67 0 0 0 84.63 98h-63.9a17.67 17.67 0 0 0-17.67 17.7 17.67 17.67 0 0 0 17.67 17.67Zm83.92-49h6.25L125.5 49h-8.35l-8.9 23.2h-.1L99.4 49h-8.9Zm32.45 0h7.8V49h-7.8Zm22.2 0h24.95V77.2H167.1V70h15.35v-7.2H167.1v-6.6h16.25V49h-24ZM10.1 35.4h7.8V6.9H28V0H0v6.9h10.1Zm28.9 0h7.8V20.1h15.1v15.3h7.8V0h-7.8v13.2H46.75V0H39Zm41.25 0h25v-7.2H88V21h15.35v-7.2H88V7.2h16.25V0h-24Zm-79 49H9V57.25h.1l9 27.15H24l9.3-27.15h.1V84.4h7.8V49H29.45l-8.2 23.1h-.1L13 49H1.2Zm112.09 49H126a24.59 24.59 0 0 0 7.56-1.15 19.52 19.52 0 0 0 6.35-3.37 16.37 16.37 0 0 0 4.37-5.5 16.91 16.91 0 0 0 1.72-7.58 18.5 18.5 0 0 0-1.68-8.25 15.1 15.1 0 0 0-4.52-5.53 18.55 18.55 0 0 0-6.73-3.02 33.54 33.54 0 0 0-8.07-1h-11.71Zm7.81-28.2h4.6a17.43 17.43 0 0 1 4.67.62 11.68 11.68 0 0 1 3.88 1.88 9 9 0 0 1 2.62 3.18 9.87 9.87 0 0 1 1 4.52 11.92 11.92 0 0 1-1 5.08 8.69 8.69 0 0 1-2.67 3.34 10.87 10.87 0 0 1-4 1.83 21.57 21.57 0 0 1-5 .55h-4.15Zm36.14 28.2h14.5a23.11 23.11 0 0 0 4.73-.5 13.38 13.38 0 0 0 4.27-1.65 9.42 9.42 0 0 0 3.1-3 8.52 8.52 0 0 0 1.2-4.68 9.16 9.16 0 0 0-.55-3.2 7.79 7.79 0 0 0-1.57-2.62 8.38 8.38 0 0 0-2.45-1.85 10 10 0 0 0-3.18-1v-.1a9.28 9.28 0 0 0 4.43-2.82 7.42 7.42 0 0 0 1.67-5 8.34 8.34 0 0 0-1.15-4.65 7.88 7.88 0 0 0-3-2.73 12.9 12.9 0 0 0-4.17-1.3 34.42 34.42 0 0 0-4.63-.32h-13.2Zm7.8-28.8h5.3a10.79 10.79 0 0 1 1.85.17 5.77 5.77 0 0 1 1.7.58 3.33 3.33 0 0 1 1.23 1.13 3.22 3.22 0 0 1 .47 1.82 3.63 3.63 0 0 1-.42 1.8 3.34 3.34 0 0 1-1.13 1.2 4.78 4.78 0 0 1-1.57.65 8.16 8.16 0 0 1-1.78.2H165Zm0 14.15h5.9a15.12 15.12 0 0 1 2.05.15 7.83 7.83 0 0 1 2 .55 4 4 0 0 1 1.58 1.17 3.13 3.13 0 0 1 .62 2 3.71 3.71 0 0 1-.47 1.95 4 4 0 0 1-1.23 1.3 4.78 4.78 0 0 1-1.67.7 8.91 8.91 0 0 1-1.83.2h-7Z" style="fill:url(#tmdb_svg__a)"></path></svg>';
        logos.push(`
            <a is="emby-linkbutton" href="${escapeHtml(tmdbLink)}" target="_blank" rel="noopener noreferrer" class="je-more-info-rating-badge-item" title="${escapeHtml(title)}">
                <span class="je-more-info-rating-icon je-more-info-tmdb">${tmdbSvg}</span>
                <span class="je-more-info-rating-percent">${percent}%</span>
            </a>
        `);
    }

    if (!logos.length) return '';
    return `<div class="je-more-info-ratings-row">${logos.join('')}</div>`;
}

function buildMediaFacts(data, mediaType, tmdbId) {
    if (!tmdbId) return '';

    // Build external links
    const imdbId = data.externalIds?.imdbId || data.imdbId;
    const tvdbId = mediaType === 'tv' ? (data.externalIds?.tvdbId || null) : null;
    const tmdbLink = `https://www.themoviedb.org/${mediaType}/${tmdbId}?language=en`;
    const imdbLink = imdbId ? `https://www.imdb.com/title/${imdbId}` : null;
    const tvdbLink = tvdbId ? `http://www.thetvdb.com/?tab=series&id=${tvdbId}` : null;
    const rtLink = mediaType === 'tv' ? (data.ratings?.url || null) : (data.ratings?.rt?.url || null);
    const traktLink = `https://trakt.tv/search/tmdb/${tmdbId}?id_type=${mediaType === 'movie' ? 'movie' : 'show'}`;
    const letterboxdLink = mediaType === 'movie' ? `https://letterboxd.com/tmdb/${tmdbId}` : null;
    const jellyseerrBaseUrl = (JE?.pluginConfig?.JellyseerrBaseUrl || '').toString().trim().replace(/\/$/, '');
    const jellyseerrLink = jellyseerrBaseUrl ? `${jellyseerrBaseUrl}/${mediaType}/${tmdbId}` : null;

    const links = [
        jellyseerrLink ? {
            href: jellyseerrLink,
            title: 'View on Jellyseerr',
            className: 'je-more-info-fact jellyseerr',
            svg: '<svg xmlns="http://www.w3.org/2000/svg" xml:space="preserve" viewBox="0 0 512 512"><linearGradient id="jellyseerr_svg__a" x1="-2250.684" x2="-2262.794" y1="3541.691" y2="3658.527" gradientTransform="translate(4136.83 -5913.335)scale(1.75)" gradientUnits="userSpaceOnUse"><stop offset="0" style="stop-color:#502d95"/><stop offset=".1" style="stop-color:#6d37ac"/><stop offset=".57" style="stop-color:#6786d1"/></linearGradient><path d="m212.3 276.5-24.2-5.4s-5.6 35.5-7.7 53.4c-3.4 28.8-7.5 68.7-5.9 99.2 1.8 33.6 10.9 65.9 14 65.9s-1.6-20.6.4-65.8c1.3-30.2 6.4-66.4 12.4-99.2 3-16.2 11.6-47.9 11.6-47.9h-.5v-.2z" style="fill:url(#jellyseerr_svg__a)"/><linearGradient id="jellyseerr_svg__b" x1="-2180.472" x2="-2192.582" y1="3548.918" y2="3665.802" gradientTransform="translate(4136.83 -5913.335)scale(1.75)" gradientUnits="userSpaceOnUse"><stop offset="0" style="stop-color:#502d95"/><stop offset=".1" style="stop-color:#6d37ac"/><stop offset=".57" style="stop-color:#6786d1"/></linearGradient><path d="M314.5 274h7.4c10 37.2 11.8 90.7 9.7 131.1-2.3 44.4-14.5 87.2-18.5 87.2-3.9 0 2.2-27.2-.6-87.1-2-39.9-10.4-77.5-11.3-131.2z" style="fill:url(#jellyseerr_svg__b)"/><linearGradient id="jellyseerr_svg__c" x1="-1845.424" x2="-1845.424" y1="3277.037" y2="3383.343" gradientTransform="translate(4254.9 -6660.12)scale(2.12)" gradientUnits="userSpaceOnUse"><stop offset="0" style="stop-color:#763dcd"/><stop offset=".22" style="stop-color:#8d61eb"/><stop offset=".37" style="stop-color:#8c86ec"/><stop offset=".64" style="stop-color:#748ce8"/><stop offset=".9" style="stop-color:#6ba1e6"/></linearGradient><path d="M336.9 157.7h11.9c16 59.4 23.4 145.3 19.9 210-3.8 71.3-23.2 139.7-29.7 139.7s3.4-43.6-1-139.6c-3-64.1-21.1-124.2-22.5-210.2z" style="fill:url(#jellyseerr_svg__c)"/><linearGradient id="jellyseerr_svg__d" x1="-1898.699" x2="-1898.699" y1="3277.037" y2="3383.343" gradientTransform="translate(4254.9 -6660.12)scale(2.12)" gradientUnits="userSpaceOnUse"><stop offset="0" style="stop-color:#763dcd"/><stop offset=".22" style="stop-color:#8d61eb"/><stop offset=".37" style="stop-color:#8c86ec"/><stop offset=".64" style="stop-color:#748ce8"/><stop offset=".9" style="stop-color:#6ba1e6"/></linearGradient><path d="M235.3 156.3h-11.9c-16 59.4-23.4 145.3-19.9 210 3.8 71.3 23.2 139.7 29.7 139.7s-3.4-43.6 1-139.6c3-64.1 21.1-124.2 22.5-210.2z" style="fill:url(#jellyseerr_svg__d)"/><linearGradient id="jellyseerr_svg__e" x1="-1926.378" x2="-1926.378" y1="3277.037" y2="3383.343" gradientTransform="translate(4254.9 -6660.12)scale(2.12)" gradientUnits="userSpaceOnUse"><stop offset="0" style="stop-color:#763dcd"/><stop offset=".22" style="stop-color:#8d61eb"/><stop offset=".37" style="stop-color:#8c86ec"/><stop offset=".64" style="stop-color:#748ce8"/><stop offset=".9" style="stop-color:#6ba1e6"/></linearGradient><path d="m198.5 129.3-27.1-9.7s-10 63.5-13.7 95.3c-6 51.4-17.9 122.6-15 177.1 3.2 60 19.6 117.7 24.9 117.7s-2.9-36.7.9-117.6c2.5-53.9 19-105 24.6-177.2 2.2-28.6 6.6-85.7 6.6-85.7z" style="fill:url(#jellyseerr_svg__e)"/><linearGradient id="jellyseerr_svg__f" x1="-1872.943" x2="-1872.943" y1="3277.037" y2="3383.343" gradientTransform="translate(4254.9 -6660.12)scale(2.12)" gradientUnits="userSpaceOnUse"><stop offset="0" style="stop-color:#763dcd"/><stop offset=".22" style="stop-color:#8d61eb"/><stop offset=".37" style="stop-color:#8c86ec"/><stop offset=".64" style="stop-color:#748ce8"/><stop offset=".9" style="stop-color:#6ba1e6"/></linearGradient><path d="m288.2 157.7-24.5 4.1s3.2 47.6 3.2 74.6c0 43.9 1.7 88.1 1.6 134.2-.2 52.9 8.7 141.4 13.3 141.4s19.5-114 22.6-182.2c2.1-45.5-4.7-85.3-5.8-112.5-1.1-24.2-4.5-56.9-4.5-56.9z" style="fill:url(#jellyseerr_svg__f)"/><linearGradient id="jellyseerr_svg__g" x1="-1732.471" x2="-1599.094" y1="3393.286" y2="3541.455" gradientTransform="translate(3285.26 -5965.385)scale(1.79)" gradientUnits="userSpaceOnUse"><stop offset="0" style="stop-color:#c395fc"/><stop offset="1" style="stop-color:#4f65f5"/></linearGradient><path d="M423.1 172.1c0 61.7-10.5 65.5-27.6 91.6-12.4 18.8 12.7 33.3 2.6 38.5-11.9 6.2-8.2-5-31.9-11.4-10.3-2.7-32.8.3-41.8 2.1-9 1.7-36.4-13.6-43.7-15.5-10.9-3-37.5 11.2-53.8 11.2s-33.2-14.2-54.8-8.3c-25.7 6.9-56.6 23.6-61.3 18.1-9-10.5 19.7-18.5 9-37.2-6.7-11.8-30-43-30.7-74.5C86.8 85.5 170.6 0 260.5 0S423 77.9 423 165" style="fill:url(#jellyseerr_svg__g)"/><linearGradient id="jellyseerr_svg__h" x1="-926.423" x2="-926.423" y1="7284.174" y2="7478.694" gradientTransform="matrix(.51 0 0 .51 663.61 -3677.805)" gradientUnits="userSpaceOnUse"><stop offset="0" style="stop-color:#fff;stop-opacity:.4"/><stop offset="1" style="stop-color:#fff;stop-opacity:0"/></linearGradient><path d="M254.9 32.1c-49.1 0-117.7 50.8-117.7 99.9 0 5.5-4.4 9.9-9.9 9.9s-9.9-4.4-9.9-9.9c0-60 77.4-119.5 137.4-119.5 5.5 0 9.9 4.4 9.9 9.9s-4.4 9.7-9.8 9.7" style="fill-rule:evenodd;clip-rule:evenodd;fill:url(#jellyseerr_svg__h)"/><linearGradient id="jellyseerr_svg__i" x1="-1322.688" x2="-1442.779" y1="4677.401" y2="4765.662" gradientTransform="translate(1658.49 -4637.5)scale(1.02)" gradientUnits="userSpaceOnUse"><stop offset="0" style="stop-color:#f9f9f9"/><stop offset="1" style="stop-color:#f9f9f9;stop-opacity:0"/></linearGradient><path d="M327.5 217.7c-5.2 8.5-12.3 15.3-20.6 20-3.6 2-7.4 3.5-11.3 4.7-11.8 5.3-24.9 8.1-38.2 8.3-45.6.8-83.5-28.4-85-65.3-.7-18.1 10.1-37 18.5-51.4 7.1-12.3 19.3-33.4 35.4-41.8 32.8-17.2 77 1 99.1 40.9 6.4 11.6 10.5 24.2 11.8 36.9 1 4.1 1.6 8.3 1.6 12.6.2 10.9-3.1 21.8-9.2 31.5-.7 1.2-1.3 2.4-2.1 3.6.1 0 0 0 0 0" style="fill:url(#jellyseerr_svg__i)"/><linearGradient id="jellyseerr_svg__j" x1="-1279.521" x2="-1221.462" y1="3874.15" y2="3933.406" gradientTransform="translate(2048.95 -5398.585)scale(1.43)" gradientUnits="userSpaceOnUse"><stop offset="0" style="stop-color:#0043a2"/><stop offset="1" style="stop-color:#00133a"/></linearGradient><path d="M255.4 127c28.4 0 51.4 23.1 51.4 51.4s-23.1 51.4-51.4 51.4-51.4-23-51.4-51.4c0-5.3.8-10.3 2.2-15.2 4 9 13 15.2 23.4 15.2 14.2 0 25.7-11.6 25.7-25.7 0-10.4-6.2-19.5-15.2-23.4 4.9-1.5 10-2.2 15.3-2.3" style="fill:url(#jellyseerr_svg__j)"/></svg>'
        } : null,
        {
            href: tmdbLink,
            title: 'View on TMDB',
            className: 'je-more-info-fact tmdb',
            svg: '<svg viewBox="0 0 185.04 133.4" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="tmdb_svg__a" x2="185.04" y1="66.7" y2="66.7" gradientUnits="userSpaceOnUse"><stop stop-color="#90cea1" offset="0"></stop><stop stop-color="#3cbec9" offset="0.56"></stop><stop stop-color="#00b3e5" offset="1"></stop></linearGradient></defs><path d="M51.06 66.7A17.67 17.67 0 0 1 68.73 49h-.1A17.67 17.67 0 0 1 86.3 66.7a17.67 17.67 0 0 1-17.67 17.67h.1A17.67 17.67 0 0 1 51.06 66.7Zm82.67-31.33h32.9A17.67 17.67 0 0 0 184.3 17.7 17.67 17.67 0 0 0 166.63 0h-32.9a17.67 17.67 0 0 0-17.67 17.7 17.67 17.67 0 0 0 17.67 17.67Zm-113 98h63.9a17.67 17.67 0 0 0 17.67-17.67A17.67 17.67 0 0 0 84.63 98h-63.9a17.67 17.67 0 0 0-17.67 17.7 17.67 17.67 0 0 0 17.67 17.67Zm83.92-49h6.25L125.5 49h-8.35l-8.9 23.2h-.1L99.4 49h-8.9Zm32.45 0h7.8V49h-7.8Zm22.2 0h24.95V77.2H167.1V70h15.35v-7.2H167.1v-6.6h16.25V49h-24ZM10.1 35.4h7.8V6.9H28V0H0v6.9h10.1Zm28.9 0h7.8V20.1h15.1v15.3h7.8V0h-7.8v13.2H46.75V0H39Zm41.25 0h25v-7.2H88V21h15.35v-7.2H88V7.2h16.25V0h-24Zm-79 49H9V57.25h.1l9 27.15H24l9.3-27.15h.1V84.4h7.8V49H29.45l-8.2 23.1h-.1L13 49H1.2Zm112.09 49H126a24.59 24.59 0 0 0 7.56-1.15 19.52 19.52 0 0 0 6.35-3.37 16.37 16.37 0 0 0 4.37-5.5 16.91 16.91 0 0 0 1.72-7.58 18.5 18.5 0 0 0-1.68-8.25 15.1 15.1 0 0 0-4.52-5.53 18.55 18.55 0 0 0-6.73-3.02 33.54 33.54 0 0 0-8.07-1h-11.71Zm7.81-28.2h4.6a17.43 17.43 0 0 1 4.67.62 11.68 11.68 0 0 1 3.88 1.88 9 9 0 0 1 2.62 3.18 9.87 9.87 0 0 1 1 4.52 11.92 11.92 0 0 1-1 5.08 8.69 8.69 0 0 1-2.67 3.34 10.87 10.87 0 0 1-4 1.83 21.57 21.57 0 0 1-5 .55h-4.15Zm36.14 28.2h14.5a23.11 23.11 0 0 0 4.73-.5 13.38 13.38 0 0 0 4.27-1.65 9.42 9.42 0 0 0 3.1-3 8.52 8.52 0 0 0 1.2-4.68 9.16 9.16 0 0 0-.55-3.2 7.79 7.79 0 0 0-1.57-2.62 8.38 8.38 0 0 0-2.45-1.85 10 10 0 0 0-3.18-1v-.1a9.28 9.28 0 0 0 4.43-2.82 7.42 7.42 0 0 0 1.67-5 8.34 8.34 0 0 0-1.15-4.65 7.88 7.88 0 0 0-3-2.73 12.9 12.9 0 0 0-4.17-1.3 34.42 34.42 0 0 0-4.63-.32h-13.2Zm7.8-28.8h5.3a10.79 10.79 0 0 1 1.85.17 5.77 5.77 0 0 1 1.7.58 3.33 3.33 0 0 1 1.23 1.13 3.22 3.22 0 0 1 .47 1.82 3.63 3.63 0 0 1-.42 1.8 3.34 3.34 0 0 1-1.13 1.2 4.78 4.78 0 0 1-1.57.65 8.16 8.16 0 0 1-1.78.2H165Zm0 14.15h5.9a15.12 15.12 0 0 1 2.05.15 7.83 7.83 0 0 1 2 .55 4 4 0 0 1 1.58 1.17 3.13 3.13 0 0 1 .62 2 3.71 3.71 0 0 1-.47 1.95 4 4 0 0 1-1.23 1.3 4.78 4.78 0 0 1-1.67.7 8.91 8.91 0 0 1-1.83.2h-7Z" style="fill:url(#tmdb_svg__a)"></path></svg>'
        },
        tvdbLink ? {
            href: tvdbLink,
            title: 'View on TheTVDB',
            className: 'je-more-info-fact tvdb',
            svg: '<svg viewBox="0 0 49.994 27.765" xmlns="http://www.w3.org/2000/svg"><g transform="translate(-80.836 -134.28)" stroke-width="0.265"><ellipse cx="104.39" cy="140.67" rx="3.04" ry="2.572" fill="#fff"></ellipse><path d="M85.973 162.05c-.278-.009-.767-.122-1.086-.25-.319-.129-.758-.508-.976-.843-.272-.418-.818-4.292-1.735-12.306-.737-6.433-1.34-11.951-1.34-12.263 0-.312.37-.913.823-1.335.558-.522 1.097-.768 1.684-.768.474 0 5.79.655 11.812 1.455 6.022.8 11.395 1.579 11.94 1.73.67.186 1.12.524 1.389 1.046.238.46.398 1.48.398 2.537 0 1.659-.058 1.832-.956 2.826-.526.582-1.255 1.712-1.621 2.51-.56 1.224-.645 1.726-.539 3.209.07.966.336 2.173.592 2.681.256.508.945 1.422 1.531 2.03 1.005 1.042 1.058 1.176.927 2.346-.093.82-.352 1.45-.765 1.858-.57.563-1.524.743-11.099 2.085-5.76.808-10.702 1.461-10.98 1.452zm5.878-7.142c.643.01 1.222-.141 1.408-.366.174-.21.278-.714.23-1.121-.072-.636-.232-.764-1.121-.908-.57-.092-1.2-.39-1.398-.66-.26-.356-.34-1.203-.286-3.012l.075-2.517h3.7l1.722 4.233 1.722 4.234 1.479.078c.98.051 1.567-.038 1.74-.265.145-.188 1.19-2.513 2.322-5.167 1.132-2.653 1.99-5.005 1.905-5.225-.097-.252-.495-.402-1.067-.402-.502 0-1.092.07-1.31.153-.22.084-1.016 1.692-1.77 3.572-.755 1.88-1.47 3.42-1.59 3.42s-.452-.626-.74-1.39c-.287-.764-.837-2.222-1.222-3.24s-.818-1.972-.963-2.117-1.539-.325-3.096-.398l-2.833-.132-.132-1.852-.132-1.852h-2.646l-.132 1.836c-.131 1.819-.141 1.84-1.008 2.062-.814.21-.87.294-.793 1.205.07.858.18.997.875 1.115l.793.135.133 3.221c.112 2.726.217 3.336.686 3.967.305.41.96.888 1.455 1.062s1.393.323 1.994.33zm12.666-11.89c.45 0 .963-.144 1.137-.318.175-.175.318-.643.318-1.04s-.187-.909-.416-1.137c-.229-.23-.696-.416-1.04-.416-.342 0-.81.187-1.039.416s-.415.74-.415 1.137.142.865.317 1.04c.175.174.687.317 1.138.317z" fill="#1b7d3d"></path><path d="M114.46 154.52c-3.027.054-3.738-.012-4.66-.434-.6-.274-1.4-.906-1.78-1.403-.38-.498-.832-1.523-1.007-2.278-.246-1.067-.246-1.68 0-2.746.175-.756.618-1.768.985-2.25.368-.481 1.05-1.073 1.515-1.315.485-.252 1.805-.506 3.095-.595l2.249-.156.132-1.852.133-1.852h2.91v14.817zm-.926-2.374 1.323-.071v-5.821l-1.606-.078c-1.443-.07-1.679-.005-2.315.632-.39.39-.728 1.02-.751 1.4-.023.38-.024.93-.002 1.22.022.292.103.802.181 1.134.078.331.525.84.994 1.13.615.38 1.221.506 2.175.455zm9.715 2.436c-2.594.004-3.548-.082-3.642-.329-.071-.184-.097-3.547-.058-7.474l.07-7.14h2.91l.133 1.852.132 1.852 2.269.156c1.634.112 2.56.319 3.307.74.572.321 1.33 1.025 1.687 1.564.459.694.68 1.456.757 2.607.06.896-.034 2.06-.208 2.587-.174.527-.629 1.33-1.01 1.783-.382.454-1.175 1.044-1.764 1.31-.862.393-1.747.488-4.583.492zm.843-2.375c.65 0 1.487-.116 1.86-.258s.923-.648 1.223-1.125c.416-.663.517-1.173.43-2.173-.087-1.015-.274-1.447-.836-1.93-.62-.533-.96-.612-2.35-.545l-1.625.078-.076 2.627c-.042 1.445-.016 2.784.058 2.976.083.218.58.35 1.316.35z" fill="#fff"></path></g></svg>'
        } : null,
        imdbLink ? {
            href: imdbLink,
            title: 'View on IMDb',
            className: 'je-more-info-fact imdb',
            svg: '<svg viewBox="0 0 575 289.83" xmlns="http://www.w3.org/2000/svg"><path fill="#f6c700" d="M575 24.91C573.44 12.15 563.97 1.98 551.91 0H23.32C10.11 2.17 0 14.16 0 28.61v232.25c0 16 12.37 28.97 27.64 28.97h519.95c14.06 0 25.67-11.01 27.41-25.26V24.91z"></path><path stroke="#000" d="M69.35 58.24h45.63v175.65H69.35V58.24zM201.2 139.15c-3.92-26.77-6.1-41.65-6.53-44.62-1.91-14.33-3.73-26.8-5.47-37.44h-59.16v175.65h39.97l.14-115.98 16.82 115.98h28.47l15.95-118.56.15 118.56h39.84V57.09h-59.61l-10.57 82.06zM346.71 93.63c.5 2.24.76 7.32.76 15.26v68.1c0 11.69-.76 18.85-2.27 21.49-1.52 2.64-5.56 3.95-12.11 3.95V87.13c4.97 0 8.36.53 10.16 1.57 1.8 1.05 2.96 2.69 3.46 4.93zm20.61 137.32c5.43-1.19 9.99-3.29 13.69-6.28 3.69-3 6.28-7.15 7.76-12.46 1.49-5.3 2.37-15.83 2.37-31.58v-61.68c0-16.62-.65-27.76-1.66-33.42-1.02-5.67-3.55-10.82-7.6-15.44-4.06-4.62-9.98-7.94-17.76-9.96-7.79-2.02-20.49-3.04-42.58-3.04H287.5v175.65h55.28c12.74-.4 20.92-.99 24.54-1.79zM464.76 204.7c-.84 2.23-4.52 3.36-7.3 3.36-2.72 0-4.53-1.08-5.45-3.25-.92-2.16-1.37-7.09-1.37-14.81v-46.42c0-8 .4-12.99 1.21-14.98.8-1.97 2.56-2.97 5.28-2.97 2.78 0 6.51 1.13 7.47 3.4.95 2.27 1.43 7.12 1.43 14.55v45.01c-.29 9.25-.71 14.62-1.27 16.11zm-58.08 26.51h41.08c1.71-6.71 2.65-10.44 2.84-11.19 3.72 4.5 7.81 7.88 12.3 10.12 4.47 2.25 11.16 3.37 16.34 3.37 7.21 0 13.43-1.89 18.68-5.68 5.24-3.78 8.58-8.26 10-13.41 1.42-5.16 2.13-13 2.13-23.54V141.6c0-10.6-.24-17.52-.71-20.77s-1.87-6.56-4.2-9.95-5.72-6.02-10.16-7.9-9.68-2.82-15.72-2.82c-5.25 0-11.97 1.05-16.45 3.12-4.47 2.07-8.53 5.21-12.17 9.42V55.56h-43.96v175.65z"></path></svg>'
        } : null,
        {
            href: rtLink,
            title: 'View on Rotten Tomatoes',
            className: 'je-more-info-fact rt',
            svg: '<svg viewBox="0 0 691 197" xmlns="http://www.w3.org/2000/svg"><g fill="#F93208"><path d="m104.8 101.98-8.017-.104V.638h24.186c26.088 0 28.29.125 34.659 1.973 10.334 2.998 18.223 9.496 22.57 18.591 2.114 4.422 2.942 7.959 3.16 13.486.49 12.49-4.809 23.35-14.189 29.082-2.81 1.717-2.94 1.853-2.482 2.58 1.234 1.961 20.736 35.548 20.736 35.713 0 .102-7.443.186-16.54.186h-16.538l-9.6-16.167c-5.28-8.892-9.803-16.445-10.051-16.784-.336-.46-1.193-.668-3.358-.817l-2.906-.199.182 16.983.181 16.983-6.988-.083c-3.843-.045-10.596-.13-15.005-.187v.002zm35.703-56.479c6.767-1.424 10.228-4.667 10.607-9.938.265-3.687-.611-6.202-2.954-8.482-3.104-3.023-7.437-4.07-16.926-4.092l-5.008-.01.234 3.298c.129 1.814.234 7.108.234 11.766v8.467l5.675-.245c3.122-.135 6.784-.479 8.138-.764z"></path><path d="M217.68 103.68c-8.925-1.007-16.797-4.98-23.157-11.686-7.223-7.617-11.109-16.992-11.521-27.797-.221-5.788.216-9.62 1.598-14 5.206-16.508 19.973-26.343 40.714-27.116 3.541-.132 6.66-.043 8.828.25 17.8 2.417 30.89 14.82 34.788 32.96.824 3.837.816 12.629-.014 16.27-3.436 15.074-14.036 25.494-29.983 29.476-6.315 1.577-15.528 2.289-21.255 1.642l.002.001zm9.79-12.053c3.497-1.039 4.937-2.945 4.899-6.487-.013-1.189-.284-2.85-.603-3.693-1.675-4.433-1.661-4.376-1.255-5.267.218-.478.788-1.048 1.267-1.266 1.155-.526 1.845-.073 3.406 2.238 2.216 3.28 6.208 7.01 8.8 8.224 2.078.972 2.662 1.089 4.843.965 2.166-.122 2.733-.314 4.474-1.513 2.286-1.574 2.901-2.856 2.88-5.996-.022-3.146-1.654-5.743-4.899-7.795-1.985-1.256-6.21-2.548-9.285-2.84-3.92-.373-5.304-1.012-5.804-2.684-.487-1.625.025-2.958 1.578-4.107.791-.586 1.76-.783 4.684-.954 2.354-.137 4.09-.429 4.804-.807 5.106-2.702 5.438-11.468.563-14.856-1.364-.948-1.868-1.084-3.964-1.072-4.827.027-8.092 3.187-9.632 9.326-.125.496-.608 1.313-1.075 1.816-.986 1.064-2.84 1.226-4.458.39-1.63-.844-1.84-2.694-.901-7.985 1.167-6.583.533-9.34-2.563-11.154-1.971-1.155-5.475-1.56-7.557-.873-1.836.606-4.227 3.061-4.778 4.905-1.11 3.718-.23 6.074 3.888 10.396 1.73 1.816 3.25 3.635 3.38 4.042.59 1.861-1.654 3.997-3.723 3.543-1.18-.26-2.303-1.403-4.129-4.207-2.934-4.507-7.032-5.946-11.069-3.886-3.473 1.772-4.372 5.775-2.066 9.197 1.338 1.986 3.74 3.31 7.44 4.1 5.358 1.145 6.867 2.308 5.405 4.166-.758.964-.83.98-3.325.708-3.765-.409-5.224-.258-7.315.757-2.18 1.058-3.13 2.228-3.723 4.584-1.19 4.725 2.14 8.911 7.07 8.89 2.596-.012 4.567-1.084 7.862-4.274 3.64-3.525 4.29-3.897 5.465-3.127 1.286.843 1.447 2.092.566 4.395-2.004 5.236-.155 10.68 4.15 12.214 1.804.643 2.5.641 4.7-.012v-.001zm82.26 10.613c-13.527-.865-20.855-4.63-24.882-12.779-2.793-5.653-3.454-10.408-3.796-27.295l-.231-11.44h-1.89c-1.04 0-2.643-.103-3.562-.23l-1.672-.228V25.504h7.567V3.884h29.546v21.62h12.251v25.584H310.81l.001 11.44c.001 10.71.046 11.514.705 12.594 1.23 2.017 2.192 2.27 8.644 2.27h5.783v25.221l-6.035-.054c-3.32-.03-7.9-.173-10.179-.318l.001-.001zm54.85-.37c-15.629-1.51-22.78-7.814-25.148-22.169-.42-2.541-.655-7.163-.82-16.06-.127-6.87-.366-12.627-.531-12.791-.165-.165-1.827-.356-3.694-.425l-3.393-.124V25.147h8.013l-.266-10.81-.266-10.81h29.632v21.98h12.251v25.222H368.07l.108 11.62c.099 10.534.17 11.71.765 12.586 1.407 2.073 2.088 2.266 8.442 2.398l5.855.12v24.8l-7.837-.048c-4.31-.027-9.18-.18-10.823-.338v.003zm59.82-15.484c-12.392-1.561-23.904-7.774-29.557-15.952-5.345-7.732-8.064-16.437-8.07-25.834-.008-13.574 5.91-24.516 17.388-32.154 7.19-4.784 12.745-6.35 23.58-6.65 5.522-.152 6.994-.074 9.91.529 5.732 1.185 10.724 3.54 14.889 7.024 3.71 3.104 7.857 9.221 9.949 14.676 2.507 6.539 3.926 17.032 3.034 22.43l-.224 1.351h-26.076c-14.342 0-26.076.137-26.076.305 0 .167.623 1.267 1.383 2.444 3.325 5.144 8.623 7.708 15.898 7.695 5.447-.01 10.592-1.443 14.27-3.973l1.48-1.019 8.257 7.755a4956.96 4956.96 0 0 1 8.742 8.222c.752.723.057 1.652-3.155 4.222-4.948 3.96-11.022 6.685-18.337 8.23-4.039.853-13.138 1.22-17.284.698l-.001.001zm15.261-50.147c-.597-3.732-2.794-6.524-6.497-8.257-4.053-1.897-9.342-1.732-13.564.422-2.864 1.46-5.53 4.875-6.237 7.985l-.222.976 2.976.122c1.637.067 7.659.154 13.381.195l10.405.073-.242-1.516zm32.579 27.459V24.783h29.186v5.405c0 2.973.122 5.404.27 5.402.149 0 1.081-.988 2.072-2.192 3.332-4.05 8.5-7.667 13.356-9.348 15.184-5.257 31.395 6.568 33.65 24.545.23 1.846.377 12.826.377 28.336v25.322h-29.546v-45.98l-.956-1.92c-1.574-3.157-4.716-4.998-8.593-5.033-4.357-.039-7.609 2.62-9.305 7.61-.746 2.196-.773 2.913-.885 23.974l-.115 21.71h-29.51V63.699l-.001-.001zm10.48 130.792c-8.788-1.23-17.227-5.075-22.84-10.407-6.942-6.595-11.058-16.86-11.058-27.579 0-11.183 5.073-21.063 14.659-28.549 1.667-1.302 2.971-2.426 2.898-2.498-.072-.073-2.839.052-6.147.278-3.308.226-6.11.316-6.225.2-.355-.355 1.922-3.364 3.48-4.598 3.19-2.526 7.199-3.42 11.017-2.46 2.864.722 2.76.012-.53-3.59l-2.936-3.218 1.948-1.665c1.072-.915 2.027-1.664 2.122-1.664.095 0 1.345 1.867 2.778 4.149s2.738 4.23 2.9 4.33c.16.1.881-.706 1.602-1.791 3.104-4.677 7.504-6.781 11.726-5.609 2.828.786 2.828.95.009 4.474-1.401 1.752-2.548 3.213-2.548 3.248 0 .035 2.897-.005 6.438-.089 12.435-.293 20.725 1.609 27.681 6.351 2.383 1.624 5.892 5.185 7.65 7.763 1.36 1.992 5.074 9.644 5.943 12.24 1.872 5.603 2.154 15.51.606 21.324-1.093 4.105-3.901 9.586-6.676 13.032-6.267 7.783-16.447 13.536-27.95 15.794-3.569.7-13.148 1.01-16.548.534h.001zm94.74 1.06c-7.835-.993-14.881-3.57-21.428-7.837-7.49-4.881-13.128-13.98-15.556-25.105-.785-3.595-1.041-10.974-.508-14.619 1.861-12.729 9.63-22.96 22.28-29.339 2.397-1.209 4.443-1.904 7.706-2.617 4.038-.883 5.132-.972 12.01-.973 6.762 0 7.893.087 10.63.826 12.802 3.455 21.615 13.546 24.914 28.527.692 3.142.834 4.852.841 10.089l.008 6.305-26.206.18-26.206.18 1.103 1.931c3.137 5.493 8.726 8.339 16.375 8.339 5.387 0 11.187-1.673 14.461-4.17l1.178-.898 8.854 8.356 8.854 8.356-1.369 1.41c-7.941 8.184-23.91 12.838-37.942 11.06l.001-.001zm15.344-49.787c-.772-4.894-4.58-8.372-10.226-9.34-7.301-1.252-14.551 3.02-16.122 9.502-.235.97-.23.973 2.05 1.102 1.258.07 7.294.16 13.414.198l11.126.07-.242-1.532zm55.816 50.167c-4.146-.47-9.524-1.676-13.109-2.941-5.022-1.772-12.654-5.866-12.654-6.787 0-.3 10.534-18.822 11.044-19.42.071-.084 2.358.992 5.082 2.39 7.474 3.837 10.895 4.86 16.123 4.82 4.207-.033 6.906-.753 8.198-2.187 1.801-2 .976-4.904-1.627-5.729-.641-.203-3.68-.355-6.75-.337-3.905.022-6.358-.14-8.15-.543-10.216-2.29-18.196-8.883-21.45-17.724-.648-1.757-.8-2.961-.822-6.482l-.026-4.324 1.55-3.242c4.486-9.385 13.202-16.08 23.78-18.263 2.902-.6 4.445-.694 9.08-.559 6.014.176 9.605.82 15.15 2.717 5.699 1.95 13.459 5.599 13.42 6.312-.008.163-2.262 4.098-5.008 8.744-3.833 6.486-5.12 8.391-5.54 8.204-2.02-.9-11.14-3.8-13.518-4.3-1.586-.333-4.511-.626-6.501-.65-3.841-.047-4.94.31-6.373 2.073-.98 1.206-.833 3.52.29 4.576.892.838 1.163.878 6.577.973 13.405.235 21.78 3.14 27.71 9.613 3.54 3.862 5.384 8.272 5.743 13.73.511 7.753-2.25 14.496-8.28 20.224-4.138 3.93-5.794 4.937-11.207 6.813-5.89 2.041-15.988 3.062-22.733 2.298l.001.001zm-222.06-2.5c-3.115-.15-8.503-.882-10.832-1.473-10.841-2.75-16.058-8.96-18.094-21.535-.278-1.718-.477-6.2-.685-15.446l-.293-13.025-1.673-.158a47.682 47.682 0 0 0-3.647-.16l-1.975-.002v-25.224h7.878l-.122-9.108c-.068-5.01-.17-9.883-.23-10.828l-.107-1.72h29.78v21.912h12.23v25.478h-12.23l.002 10.892c0 6.814.101 11.252.269 11.855.332 1.197 1.622 2.697 2.711 3.152.61.254 2.32.344 6.565.344h5.74v25.224l-6.815-.049c-3.749-.027-7.56-.085-8.472-.129zm-100.01 2.48c-6.068-.899-12.181-4.26-18.039-9.92-3.615-3.492-5.672-6.254-7.7-10.338-3.03-6.103-4.177-10.835-4.387-18.104-.2-6.972.594-12.343 2.752-18.6 2.233-6.477 4.445-10.212 8.365-14.125 8.465-8.451 18.63-11.802 28.321-9.337 5.607 1.426 10.185 4.096 15.083 8.798l2.23 2.14v-9.5h27.772v76.946h-27.772v-4.84c0-2.663-.075-4.842-.167-4.842-.091 0-1.22 1.06-2.509 2.357-7.064 7.107-15.892 10.559-23.95 9.366l.001-.001zm17.685-28.317c5.786-2.845 9.1-11.159 6.994-17.547-1.157-3.512-4.26-6.42-8.273-7.753-3.876-1.286-6.61-1.145-10.106.524-4.513 2.154-7.192 6.602-7.192 11.943 0 3.888 1.271 7.003 3.95 9.682 4.024 4.024 10.164 5.347 14.627 3.152v-.001zM259.84 188.73c-.092-2.965-.179-11.364-.192-18.663-.013-7.3-.1-15.45-.192-18.113-.19-5.502-.425-6.309-2.411-8.306-2.323-2.336-6.327-3.183-9.46-2.001-2.747 1.036-4.837 3.8-5.47 7.233-.187 1.017-.278 8.578-.278 23.122v21.61h-14.778c-8.128 0-14.801-.03-14.829-.064-.028-.035-.114-10.383-.191-22.995l-.14-22.931-.866-1.597c-.997-1.838-2.242-3.055-4.157-4.062-1.198-.63-1.614-.708-3.767-.709-2.035 0-2.595.093-3.514.583-2.416 1.288-4.24 4.048-5.087 7.696-.406 1.753-.435 3.667-.35 23.122l.092 21.21h-29.53l-.17-22.972c-.092-12.635-.169-30.12-.169-38.855v-15.882h29.286l.071 3.627c.06 3.107.13 3.64.484 3.707.243.047 1.341-.84 2.675-2.162 2.7-2.676 5.053-4.087 9.126-5.475 11.078-3.774 22.042-1.153 30.246 7.23l2.203 2.251.692-1.181c3.247-5.54 12.361-9.526 21.781-9.526 7.805 0 14.775 2.657 19.708 7.512 5.118 5.037 8.184 12.777 8.68 21.916.077 1.401.205 13.239.286 26.307l.146 23.759h-29.758l-.168-5.392.001.001zm-153.06 6.29c-6.093-.998-10.52-2.705-15.396-5.935-11.61-7.69-18.797-22.407-18.135-37.134.81-18.046 12.392-31.634 30.62-35.927 7.981-1.88 17.076-2.158 24.066-.737 12.231 2.488 22.77 10.864 28.179 22.395 5.266 11.228 5.435 24.038.458 34.76-5.597 12.056-17.13 19.866-32.956 22.316-3.758.582-13.917.74-16.834.262h-.002zm13.14-27.525c4.448-.934 8.12-3.694 10.055-7.56 1-1.998 1.029-2.126 1.025-4.637-.004-3.002-.47-5.242-1.543-7.42-3.681-7.48-12.83-10.42-20.566-6.612-3.791 1.866-7.05 6.222-7.762 10.373-1.12 6.54 3.808 14.306 10.256 16.163 1.4.403 5.928.24 8.536-.307h-.001z"></path><path d="M27.559 157.18v-36.689H.807V91.889l40.448.188c22.246.104 40.534.24 40.639.303.105.063.191 6.356.191 13.985v13.87H56.097v73.635H27.561v-36.69h-.002z"></path></g></svg>'
        },
        {
            href: traktLink,
            title: 'View on Trakt',
            className: 'je-more-info-fact trakt',
            svg: '<svg viewBox="0 0 144.8 144.8" xmlns="http://www.w3.org/2000/svg"><circle cx="72.4" cy="72.4" r="72.4" fill="#fff"></circle><path d="M29.5 111.8c10.6 11.6 25.9 18.8 42.9 18.8 8.7 0 16.9-1.9 24.3-5.3L56.3 85l-26.8 26.8z" fill="#ED2224"></path><path d="M56.1 60.6 25.5 91.1 21.4 87l32.2-32.2 37.6-37.6c-5.9-2-12.2-3.1-18.8-3.1-32.2 0-58.3 26.1-58.3 58.3 0 13.1 4.3 25.2 11.7 35l30.5-30.5 2.1 2 43.7 43.7c.9-.5 1.7-1 2.5-1.6L56.3 72.7 27 102l-4.1-4.1 33.4-33.4 2.1 2 51 50.9c.8-.6 1.5-1.3 2.2-1.9l-55-55-.5.1z" fill="#ED2224"></path><path d="M115.7 111.4c9.3-10.3 15-24 15-39 0-23.4-13.8-43.5-33.6-52.8L60.4 56.2l55.3 55.2zM74.5 66.8l-4.1-4.1 28.9-28.9 4.1 4.1-28.9 28.9zm27.4-39.7L68.6 60.4l-4.1-4.1L97.8 23l4.1 4.1z" fill="#ED1C24"></path><path d="M72.4 144.8C32.5 144.8 0 112.3 0 72.4S32.5 0 72.4 0s72.4 32.5 72.4 72.4-32.5 72.4-72.4 72.4zm0-137.5C36.5 7.3 7.3 36.5 7.3 72.4s29.2 65.1 65.1 65.1 65.1-29.2 65.1-65.1S108.3 7.3 72.4 7.3z" fill="#ED2224"></path></svg>'
        },
        letterboxdLink ? {
            href: letterboxdLink,
            title: 'View on Letterboxd',
            className: 'je-more-info-fact letterboxd',
            svg: '<svg viewBox="0 0 250 250" xmlns="http://www.w3.org/2000/svg"><g fill="none" fill-rule="evenodd"><path fill="#202830" d="M0 0h250v250H0z"></path><g transform="translate(48 30)"><ellipse fill="#40BCF4" cx="125.65" cy="28.695" rx="28.596" ry="28.695"></ellipse><ellipse fill="#00E054" cx="77.123" cy="28.695" rx="28.596" ry="28.695"></ellipse><ellipse fill="#FF8000" cx="28.596" cy="28.695" rx="28.596" ry="28.695"></ellipse><path d="M52.86 43.888a28.634 28.634 0 0 1-4.333-15.193c0-5.58 1.587-10.787 4.333-15.193a28.634 28.634 0 0 1 4.332 15.193c0 5.58-1.587 10.787-4.332 15.193ZM101.386 13.502a28.634 28.634 0 0 1 4.333 15.193c0 5.58-1.587 10.787-4.333 15.193a28.634 28.634 0 0 1-4.332-15.193c0-5.58 1.587-10.787 4.332-15.193Z" fill="#FFF"></path></g><path d="m210.383 151.61-11.477 1.442.274-36.554 9.008-1.133 1.487 7.306c1.214-5.82 4.873-8.609 11.29-9.416L223 113l-.091 12.038-4.195.527c-6.54.822-8.162 3.355-8.21 9.847l-.121 16.198ZM194.66 142c-2.031 7.937-7.62 13.488-18.048 14.798-12.402 1.56-18.149-4.77-18.064-16.052l.008-1.071c.088-11.724 7.36-19.752 18.528-21.156 12.648-1.59 17.953 6.117 17.88 16.013l-.033 4.097-25.234 3.172c.522 4.341 2.973 6.427 7.292 5.883 3.147-.396 4.885-1.999 5.764-4.188l11.907-1.495Zm-17.518-14.8c-4.195.528-6.618 3.036-7.39 7.415l14.128-1.776c-.462-4.034-2.542-6.166-6.738-5.638Zm-73.692 26.46c-2.032 7.937-7.622 13.488-18.049 14.799-12.4 1.558-18.147-4.772-18.064-16.054l.008-1.071c.088-11.722 7.361-19.752 18.528-21.156 12.648-1.59 17.953 6.119 17.88 16.014l-.031 4.096-25.235 3.172c.521 4.342 2.973 6.427 7.29 5.884 3.147-.396 4.886-2 5.765-4.187l11.908-1.497Zm-17.518-14.8c-4.196.528-6.62 3.036-7.392 7.415l14.129-1.776c-.462-4.035-2.542-6.166-6.737-5.639Zm44.064-13.471.001-.037c1.358-.17 2.284-.413 3.52-.82 2.285-.602 3.156-1.72 3.549-4.854.197-1.536.299-2.823.372-4.344l9.255-1.163-.07 9.14 8.515-1.07-.075 10.147-8.515 1.069-.066 8.761c-.048 6.303.873 6.88 6.179 6.213l2.284-.287-.08 10.65-5.676.714c-10.798 1.357-13.422-2.28-13.336-13.688l.082-11.03-6.045.761v-.011l-8.423 1.058-.065 8.76c-.047 6.303.872 6.88 6.18 6.213l2.282-.286-.08 10.651-5.676.713c-10.797 1.357-13.421-2.28-13.336-13.688l.084-11.029-6.047.76.07-9.518c1.358-.17 2.285-.412 3.521-.82 2.284-.6 3.157-1.718 3.55-4.853.196-1.535.334-3.505.408-5.025l9.254-1.163-.068 9.139 8.452-1.063Zm-65.394 44.739-30.171 3.791.338-45.188 11.6-1.459-.254 33.909 18.571-2.335-.084 11.282Zm18.198 48.2c-5.54.655-9.09-1.574-10.792-5.467l-.965 5.954L61.035 220l.67-46.439 11.329-1.34-.247 17.068c2.01-4.211 5.694-6.996 10.792-7.6 8.182-.908 14.148 3.746 13.976 15.566l-.015 1.086c-.171 11.88-5.74 18.921-14.74 19.987Zm-3.576-9.15c4.217-.499 6.835-3.398 6.924-9.55l.012-.844c.08-5.549-2.65-7.995-6.615-7.526-4.153.492-7.031 3.903-7.104 9.029l-.012.785c-.088 6.09 2.641 8.597 6.795 8.106Zm40.035 4.836c-11.835 1.4-18.295-3.736-18.127-15.377l.016-1.085c.17-11.88 7.937-18.88 18.7-20.154 10.952-1.297 18.29 4.097 18.121 15.798l-.016 1.085c-.168 11.64-7.554 18.414-18.694 19.733Zm.198-9.476c4.218-.5 7.026-3.54 7.105-9.03l.014-.964c.082-5.73-2.393-8.387-6.799-7.866-4.28.507-7.153 3.676-7.237 9.526l-.014.966c-.078 5.367 2.715 7.867 6.93 7.368Zm43.133 3.445-6.53-9.101-6.815 10.68-13.47 1.593 13.734-19.806-11.97-15.322 12.966-1.534 5.853 8.157 6.107-9.573 12.903-1.527-12.388 18.083 12.701 16.8-13.091 1.55Zm37.464-4.434-.981-5.964c-1.884 4.316-5.574 7.403-11.175 8.066-8.812 1.042-14.264-4.394-14.09-16.396l.014-1.024c.17-11.761 6.29-17.904 14.662-18.895 5.287-.626 8.719 1.076 10.493 4.418l.237-16.464 11.266-1.334-.67 46.44-9.756 1.153Zm-8.245-7.694c4.217-.498 7.028-3.721 7.113-9.632l.01-.784c.078-5.307-2.585-8.003-6.676-7.518-4.28.506-6.838 3.638-6.918 9.127l-.012.784c-.09 6.272 2.58 8.485 6.483 8.023Zm-133.44 5.915L18 206.956l.18-7.617 40.248-5.172-.057 7.603Z" fill="#FFF"></path></g></svg>'
        } : null
    ].filter(Boolean);

    return `
        ${links.length ? `
        <div class="je-more-info-media-facts" aria-label="External links">
            <div class="je-more-info-media-facts-row">
                ${links.map(link => `
                    <a is="emby-linkbutton" class="${link.className}" href="${escapeHtml(link.href)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(link.title)}">
                        ${link.svg}
                    </a>
                `).join('')}
            </div>
        </div>
        ` : ''}
    `;
}

/**
 * Build crew section (director, writers, etc.)
 */
function buildCrewSection(data, mediaType) {
    if (mediaType === 'tv' && data.createdBy?.length) {
        return `
            <div class="creators">
                <h4>Created By</h4>
                <p>${data.createdBy.map(c => escapeHtml(c.name)).join(', ')}</p>
            </div>
        `;
    }

    if (data.credits?.crew) {
        const director = data.credits.crew.find(c => c.job === 'Director');
        const writers = data.credits.crew.filter(c =>
            c.job === 'Screenplay' || c.job === 'Writer' || c.job === 'Story'
        ).slice(0, 3);

        let html = '';
        if (director) {
            html += `
                <div class="crew-item">
                    <h4>Director</h4>
                    <p>${escapeHtml(director.name)}</p>
                </div>
            `;
        }
        if (writers.length) {
            html += `
                <div class="crew-item">
                    <h4>Writers</h4>
                    <p>${writers.map(w => escapeHtml(w.name)).join(', ')}</p>
                </div>
            `;
        }
        return html ? `<div class="crew-section">${html}</div>` : '';
    }

    return '';
}

/**
 * Build trailers section
 */
function buildTrailersSection(data) {
    if (!data.relatedVideos || !data.relatedVideos.length) return '';

    const trailers = data.relatedVideos
        .filter(v => v.type === 'Trailer' || v.type === 'Teaser')
        .slice(0, 6);

    if (!trailers.length) return '';

    return `
        <div class="trailers-section">
            <h3>Trailers & Videos</h3>
            <div class="trailers-grid">
                ${trailers.map(trailer => {
                    const thumbnailUrl = trailer.site === 'YouTube'
                        ? `https://img.youtube.com/vi/${trailer.key}/mqdefault.jpg`
                        : '';
                    const youtubeIcon = trailer.site === 'YouTube' ? '<img src="https://cdn.jsdelivr.net/gh/selfhst/icons@main/png/youtube.png" alt="YouTube" class="trailer-youtube-icon" />' : '';

                    return `
                        <a is="emby-linkbutton" href="${escapeHtml(trailer.url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(trailer.name)}" class="trailer-item">
                            <div class="trailer-thumbnail">
                                ${thumbnailUrl ? `<img src="${thumbnailUrl}" alt="${escapeHtml(trailer.name)}" />` : ''}
                                <div class="je-modal-play-button">
                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
                                        <path d="M8 5v14l11-7z"/>
                                    </svg>
                                </div>
                                ${youtubeIcon}
                            </div>
                            <div class="trailer-info">
                                <div class="trailer-name">${escapeHtml(trailer.name)}</div>
                                <div class="trailer-type">${escapeHtml(trailer.type)}</div>
                            </div>
                        </a>
                    `;
                }).join('')}
            </div>
        </div>
    `;
}

/**
 * Render request/4K actions and download progress inside the modal.
 */
function buildTvActions(data) {
    const mediaInfo = data.mediaInfo || {};
    const status = mediaInfo.status ?? 1;
    const status4k = mediaInfo.status4k ?? 1;

    // Skip rendering if TV show is already requested/processing/available
    if ((status && status !== 1) || (status4k && status4k !== 1)) {
        return null;
    }

    const container = document.createElement('div');
    container.className = 'je-more-info-actions-row';

    const requestButton = document.createElement('button');
    requestButton.className = 'jellyseerr-request-button jellyseerr-button-request';
    requestButton.innerHTML = `${JE.jellyseerrUIIcons?.request || '<span class="material-icons">download</span>'}<span>${JE.t('jellyseerr_btn_request')}</span>`;
    requestButton.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();

        // TV always shows season selection modal
        if (JE.jellyseerrUI?.showSeasonSelectionModal) {
            JE.jellyseerrUI.showSeasonSelectionModal(data.id, 'tv', data.title || data.name, data);
        }
    });

    container.appendChild(requestButton);
    return container;
}

function buildSingle4kButton(data) {
    const button = document.createElement('button');
    button.className = 'jellyseerr-request-button jellyseerr-button-request';
    button.innerHTML = `${JE.jellyseerrUIIcons?.request || '<span class="material-icons">download</span>'}<span>${JE.t('jellyseerr_btn_request_4k') || 'Request in 4K'}</span>`;
    button.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        button.disabled = true;
        button.innerHTML = `<span>${JE.t('jellyseerr_btn_requesting')}</span><span class="jellyseerr-button-spinner"></span>`;
        try {
            await JE.jellyseerrAPI.requestMedia(data.id, 'movie', { is4k: true }, false, data);
            mountRequestedChip(data, 'movie', true);
        } catch (error) {
            const errorMessage = error?.responseJSON?.message || JE.t('jellyseerr_btn_error');
            button.disabled = false;
            button.innerHTML = `<span>${errorMessage}</span>`;
            button.classList.add('jellyseerr-button-error');
        }
    });
    return button;
}

function buildMovieActions(data, actionMount, chipMount, show4kOption) {
    const status = data.mediaInfo ? data.mediaInfo.status : 1;
    const status4k = data.mediaInfo ? data.mediaInfo.status4k : 1;
    const downloads = data.mediaInfo?.downloadStatus || [];
    const downloads4k = data.mediaInfo?.downloadStatus4k || [];

    // If already requested in any format, renderActions will handle chips/downloads
    if ((status && status !== 1) || (status4k && status4k !== 1)) {
        return null;
    }

    const container = document.createElement('div');
    container.className = 'je-more-info-actions-row';

    // Build split button (reuse card styling)
    if (show4kOption) {
        const buttonGroup = document.createElement('div');
        buttonGroup.className = 'jellyseerr-button-group je-more-info-button-group';

        const mainButton = document.createElement('button');
        mainButton.className = 'jellyseerr-request-button jellyseerr-split-main jellyseerr-button-request';
        mainButton.innerHTML = `${JE.jellyseerrUIIcons?.request || '<span class="material-icons">download</span>'}<span>${JE.t('jellyseerr_btn_request')}</span>`;
        mainButton.dataset.tmdbId = data.id;
        mainButton.dataset.mediaType = 'movie';

        const arrowButton = document.createElement('button');
        arrowButton.className = 'jellyseerr-split-arrow';
        arrowButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M12.53 16.28a.75.75 0 01-1.06 0l-7.5-7.5a.75.75 0 011.06-1.06L12 14.69l6.97-6.97a.75.75 0 111.06 1.06l-7.5 7.5z" clip-rule="evenodd" /></svg>';
        arrowButton.title = 'Request in 4K';
        arrowButton.dataset.tmdbId = data.id;
        arrowButton.dataset.toggle4k = 'true';

        mainButton.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (JE.pluginConfig.JellyseerrShowAdvanced) {
                window.JellyfinEnhanced?.jellyseerrUI?.showMovieRequestModal?.(data.id, data.title || data.name, data, false);
                return;
            }
            mainButton.disabled = true;
            mainButton.innerHTML = `<span>${JE.t('jellyseerr_btn_requesting')}</span><span class="jellyseerr-button-spinner"></span>`;
            try {
                await JE.jellyseerrAPI.requestMedia(data.id, 'movie', {}, false, data);
                mountRequestedChip(data, 'movie', false);
            } catch (error) {
                mainButton.disabled = false;
                const errorMessage = error?.responseJSON?.message || JE.t('jellyseerr_btn_error');
                mainButton.innerHTML = `<span>${errorMessage}</span>${JE.jellyseerrUIIcons?.error || ''}`;
                mainButton.classList.add('jellyseerr-button-error');
            }
        });

    // 4K dropdown
    let open4k = null;
    const close4k = () => {
        if (open4k) {
            open4k.remove();
            open4k = null;
            document.removeEventListener('click', handleDocClick, true);
        }
    };
    const handleDocClick = (ev) => {
        if (!open4k) return;
        if (!open4k.contains(ev.target) && !arrowButton.contains(ev.target)) {
            close4k();
        }
    };

        arrowButton.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (open4k) {
            close4k();
            return;
        }
        const menu = document.createElement('div');
        menu.className = 'je-4k-popup';
        const option = document.createElement('button');
        option.className = 'je-4k-popup-item';
        option.textContent = 'Request in 4K';
        option.addEventListener('click', async (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            option.disabled = true;
            option.textContent = JE.t('jellyseerr_btn_requesting');
            try {
                await JE.jellyseerrAPI.requestMedia(data.id, 'movie', { is4k: true }, false, data);
                mountRequestedChip(data, 'movie', true);
                close4k();
            } catch (error) {
                option.disabled = false;
                option.textContent = error?.responseJSON?.message || JE.t('jellyseerr_btn_error');
            }
        });
        menu.appendChild(option);
        document.body.appendChild(menu);
        const rect = arrowButton.getBoundingClientRect();
        menu.style.position = 'fixed';
        menu.style.left = `${rect.left}px`;
        menu.style.top = `${rect.bottom + 6}px`;
        requestAnimationFrame(() => menu.classList.add('show'));
        open4k = menu;
        document.addEventListener('click', handleDocClick, true);
    });

        buttonGroup.appendChild(mainButton);
        buttonGroup.appendChild(arrowButton);
        container.appendChild(buttonGroup);
    } else {
        const requestButton = document.createElement('button');
        requestButton.className = 'jellyseerr-request-button jellyseerr-button-request';
        requestButton.innerHTML = `${JE.jellyseerrUIIcons?.request || '<span class="material-icons">download</span>'}<span>${JE.t('jellyseerr_btn_request')}</span>`;
        requestButton.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            requestButton.disabled = true;
            requestButton.innerHTML = `<span>${JE.t('jellyseerr_btn_requesting')}</span><span class="jellyseerr-button-spinner"></span>`;
            try {
                await JE.jellyseerrAPI.requestMedia(data.id, 'movie', {}, false, data);
                mountRequestedChip(data, 'movie', false);
            } catch (error) {
                requestButton.disabled = false;
                const errorMessage = error?.responseJSON?.message || JE.t('jellyseerr_btn_error');
                requestButton.innerHTML = `<span>${errorMessage}</span>${JE.jellyseerrUIIcons?.error || ''}`;
                requestButton.classList.add('jellyseerr-button-error');
            }
        });
        container.appendChild(requestButton);
    }
    return container;
}

function buildStatusChip(status, status4k, isMovie, downloads = [], downloads4k = []) {
    const chip = document.createElement('div');
    chip.className = 'je-status-chip';
    const { text, className } = resolveStatusLabel(status, status4k, isMovie, downloads, downloads4k);
    chip.textContent = text;
    chip.classList.add(className);
    return chip;
}

function resolveStatusLabel(status, status4k, isMovie, downloads = [], downloads4k = []) {
    const use4k = isMovie && status4k && status4k !== 1;
    const targetStatus = use4k ? status4k : status;
    const hasActiveDownloads = (use4k ? downloads4k : downloads)?.length > 0;
    switch (targetStatus) {
        case 5: return { text: use4k ? '4K Available' : 'Available', className: 'chip-available' };
        case 4: return { text: use4k ? '4K Partially Available' : 'Partially Available', className: 'chip-partial' };
        case 3: return hasActiveDownloads
            ? { text: use4k ? '4K Processing' : 'Processing', className: 'chip-processing' }
            : { text: use4k ? '4K Requested' : 'Requested', className: 'chip-requested' };
        case 2: return { text: use4k ? '4K Requested' : 'Requested', className: 'chip-requested' };
        case 6: return { text: use4k ? '4K Rejected' : 'Rejected', className: 'chip-rejected' };
        default: return { text: 'Requested', className: 'chip-requested' };
    }
}

function buildDownloadBars(downloads = [], downloads4k = []) {
    const all = [...downloads, ...downloads4k];
    if (!all.length) return null;

    const wrapper = document.createElement('div');
    wrapper.className = 'je-download-bars';

    all.forEach(dl => {
        if (typeof dl.size !== 'number' || typeof dl.sizeLeft !== 'number' || dl.size <= 0) return;
        const pct = Math.max(0, Math.min(100, Math.round(100 * (1 - dl.sizeLeft / dl.size))));
        const row = document.createElement('div');
        row.className = 'je-download-row';
        row.innerHTML = `
            <div class="je-download-title">${escapeHtml(dl.title || JE.t('jellyseerr_popover_downloading'))}</div>
            <div class="je-download-progress"><div class="fill" style="width:${pct}%"></div></div>
            <div class="je-download-meta"><span>${pct}%</span><span>${escapeHtml((dl.status || 'Downloading').toString())}</span></div>
        `;
        wrapper.appendChild(row);
    });

    return wrapper;
}

function mountRequestedChip(data, mediaType, is4k) {
    const mediaInfo = data.mediaInfo = data.mediaInfo || {};
    if (mediaType === 'movie') {
        if (is4k) {
            mediaInfo.status4k = 2;
        } else {
            mediaInfo.status = 2;
        }
    } else {
        if (is4k) {
            mediaInfo.status4k = 2;
        } else {
            mediaInfo.status = 2;
        }
    }

    document.dispatchEvent(new CustomEvent('jellyseerr-media-requested', {
        detail: { tmdbId: data.id, mediaType, is4k: !!is4k }
    }));

    renderActions(data, mediaType);
}

function renderActions(data, mediaType) {
    if (!currentModal) return;

    const actionMount = currentModal.querySelector('[data-mount="je-actions"]');
    const chipMount = currentModal.querySelector('[data-mount="je-status-chip"]');
    const downloadsMount = currentModal.querySelector('[data-mount="je-downloads"]');
    if (actionMount) actionMount.innerHTML = '';
    if (chipMount) chipMount.innerHTML = '';
    if (downloadsMount) downloadsMount.innerHTML = '';

    if (mediaType === 'movie') {
        const mediaInfo = data.mediaInfo || {};
        const status = mediaInfo.status ?? 1;
        const status4k = mediaInfo.status4k ?? 1;
        const downloads = mediaInfo.downloadStatus || [];
        const downloads4k = mediaInfo.downloadStatus4k || [];
        const show4k = !!JE.pluginConfig.JellyseerrEnable4KRequests;

        const hasStatus = (status && status !== 1) || (status4k && status4k !== 1);
        if (hasStatus && chipMount) {
            const chip = buildStatusChip(status, status4k, true, downloads, downloads4k);
            if (chip) chipMount.appendChild(chip);
        }

        const bars = buildDownloadBars(downloads, downloads4k);
        if (bars && downloadsMount) downloadsMount.appendChild(bars);

        const alreadyRequested = hasStatus;
        if (alreadyRequested) {
            if (show4k && (!status4k || status4k === 1) && actionMount) {
                const followUp = buildSingle4kButton(data);
                if (followUp) actionMount.appendChild(followUp);
            }
            return;
        }

        const actions = buildMovieActions(data, actionMount, chipMount, show4k);
        if (actions && actionMount) actionMount.appendChild(actions);
    } else {
        const mediaInfo = data.mediaInfo || {};
        const status = mediaInfo.status ?? 1;
        const status4k = mediaInfo.status4k ?? 1;
        const downloads = mediaInfo.downloadStatus || [];
        const downloads4k = mediaInfo.downloadStatus4k || [];

        const hasStatus = (status && status !== 1) || (status4k && status4k !== 1);
        if (hasStatus && chipMount) {
            const chip = buildStatusChip(status, status4k, false, downloads, downloads4k);
            if (chip) chipMount.appendChild(chip);
        }

        const bars = buildDownloadBars(downloads, downloads4k);
        if (bars && downloadsMount) downloadsMount.appendChild(bars);

        if (hasStatus) return;

        const actions = buildTvActions(data);
        if (actions && actionMount) actionMount.appendChild(actions);
    }
}

/**
 * Build cast section (horizontal scrollable)
 */
function buildCastSection(data) {
    if (!data.credits?.cast || !data.credits.cast.length) return '';

    const cast = data.credits.cast.slice(0, 20);

    return `
        <div class="cast-section">
            <h3>Cast</h3>
            <div class="cast-scroll">
                ${cast.map(person => {
                    const imageUrl = person.profilePath
                        ? `https://image.tmdb.org/t/p/w185${person.profilePath}`
                        : '';

                    return `
                        <div class="cast-member">
                            <div class="person-avatar">
                                ${imageUrl ? `<img src="${imageUrl}" alt="${escapeHtml(person.name)}" />` : buildPersonPlaceholder()}
                            </div>
                            <div class="person-name">${escapeHtml(person.name)}</div>
                            <div class="person-character">${escapeHtml(person.character || '')}</div>
                        </div>
                    `;
                }).join('')}
            </div>
        </div>
    `;
}

/**
 * Build production section
 */
function buildProductionSection(data) {
    const items = [];

    if (data.productionCompanies?.length) {
        items.push({
            title: 'Production Companies',
            content: data.productionCompanies.map(c => escapeHtml(c.name)).join(', ')
        });
    }

    if (data.productionCountries?.length) {
        items.push({
            title: 'Production Countries',
            content: data.productionCountries.map(c => escapeHtml(c.name)).join(', ')
        });
    }

    if (data.networks?.length) {
        items.push({
            title: 'Networks',
            content: data.networks.map(n => escapeHtml(n.name)).join(', ')
        });
    }

    if (data.keywords?.length) {
        items.push({
            title: 'Keywords',
            content: data.keywords.slice(0, 10).map(k =>
                `<span class="keyword-tag">${escapeHtml(k.name)}</span>`
            ).join('')
        });
    }

    if (!items.length) return '';

    return `
        <div class="production-section">
            <h3>Production Details</h3>
            ${items.map(item => `
                <div class="production-item">
                    <h4>${item.title}</h4>
                    <div class="production-content">${item.content}</div>
                </div>
            `).join('')}
        </div>
    `;
}

/**
 * Build seasons section (TV shows only)
 */
function buildSeasonsSection(data) {
    if (!data.seasons || !data.seasons.length) return '';

    return `
        <div class="seasons-section">
            <h3>Seasons</h3>
            <div class="seasons-grid">
                ${data.seasons.map(season => {
                    const posterUrl = season.posterPath
                        ? `https://image.tmdb.org/t/p/w185${season.posterPath}`
                        : '';

                    return `
                        <div class="season-card">
                            <div class="season-poster">
                                ${posterUrl ? `<img src="${posterUrl}" alt="${escapeHtml(season.name)}" />` : ''}
                            </div>
                            <div class="season-info">
                                <div class="season-name">${escapeHtml(season.name)}</div>
                                <div class="season-meta">
                                    ${season.episodeCount} Episodes
                                    ${season.airDate ? ` • ${new Date(season.airDate).getFullYear()}` : ''}
                                </div>
                                ${season.overview ? `<div class="season-overview">${escapeHtml(season.overview)}</div>` : ''}
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        </div>
    `;
}

/**
 * Build person placeholder SVG
 */
function buildPersonPlaceholder() {
    return `
        <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
            <rect width="100" height="100" fill="#2a2a2a"/>
            <circle cx="50" cy="40" r="15" fill="#555"/>
            <path d="M 25 75 Q 25 60, 50 60 Q 75 60, 75 75 L 75 100 L 25 100 Z" fill="#555"/>
        </svg>
    `;
}

/**
 * Close the modal
 */
moreInfoModal.close = function() {
    if (currentModal) {
        // Clean up TV request listener if exists
        if (currentModal._cleanupTvListener) {
            currentModal._cleanupTvListener();
        }
        currentModal.classList.remove('active');
        setTimeout(() => {
            currentModal.remove();
            currentModal = null;
        }, 300);
    }
}

/**
 * Show error message
 */
function showError(message) {
    // You can customize this to match your error handling
    console.error(message);
    alert(message);
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Format currency
 */
function formatCurrency(amount) {
    if (!amount || amount === 0) return null;
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 0,
        maximumFractionDigits: 0
    }).format(amount);
}

// Add styles to the page
function injectStyles() {
    if (document.getElementById('je-more-info-modal-styles')) return;

    const style = document.createElement('style');
    style.id = 'je-more-info-modal-styles';
    style.textContent = `
        .je-more-info-modal {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            z-index: 10000;
            display: flex;
            align-items: center;
            justify-content: center;
            background: rgba(0, 0, 0, 0.95);
            opacity: 0;
            transition: opacity 0.3s ease;
            overflow: hidden;
        }

        .je-more-info-modal.active {
            opacity: 1;
        }

        .je-more-info-modal .modal-overlay {
            width: 100%;
            height: 100%;
            overflow: hidden;
        }

        .je-more-info-modal .modal-container {
            position: relative;
            max-width: 1400px;
            max-height: 100%;
            width: 100%;
            height: 100%;
            margin: 0 auto;
            background: #0f172a;
            border-radius: 8px;
            overflow-y: auto;
            overflow-x: hidden;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.9);
            display: flex;
            flex-direction: column;
        }

        .je-more-info-modal .modal-container::-webkit-scrollbar {
            width: 8px;
        }

        .je-more-info-modal .modal-container::-webkit-scrollbar-track {
            background: rgba(255, 255, 255, 0.05);
        }

        .je-more-info-modal .modal-container::-webkit-scrollbar-thumb {
            background: rgba(255, 255, 255, 0.2);
            border-radius: 4px;
        }

        .je-more-info-modal .modal-container::-webkit-scrollbar-thumb:hover {
            background: rgba(255, 255, 255, 0.3);
        }

        .je-more-info-modal .modal-close {
            position: absolute;
            top: 1.5rem;
            right: 1.5rem;
            z-index: 100;
            width: 40px;
            height: 40px;
            background: rgba(0, 0, 0, 0.6);
            border: none;
            border-radius: 50%;
            color: white;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.2s;
        }

        .je-more-info-modal .modal-close:hover {
            background: rgba(0, 0, 0, 0.9);
            transform: scale(1.1);
        }

        .je-more-info-modal .modal-close svg {
            width: 24px;
            height: 24px;
        }

        .je-more-info-modal .modal-backdrop {
            position: relative;
            height: 300px;
            background-size: cover;
            background-position: center calc(-50px);
            flex-shrink: 0;
        }

        .je-more-info-modal .je-modal-backdrop-overlay {
            position: absolute;
            inset: 0;
            background: linear-gradient(to bottom, transparent 0%, #0f172a 100%);
        }

        .je-more-info-modal .modal-content {
            position: relative;
            padding: 0 2rem 1.5rem;
            margin-top: -80px;
            color: white;
            flex: 1;
            overflow-y: auto;
            min-height: 0;
        }

        .je-more-info-modal .modal-main {
            display: grid;
            grid-template-columns: 1fr 380px;
            gap: 2rem;
            margin-bottom: 1rem;
            flex-shrink: 0;
        }

        .je-more-info-modal .modal-left {
            flex: 1;
            min-width: 0;
        }

        .je-more-info-modal .modal-right {
            width: 380px;
        }

        .je-more-info-modal .header-section {
            display: flex;
            gap: 1.5rem;
            margin-bottom: 1.5rem;
        }

        .je-more-info-modal .header-poster {
            width: 120px;
            flex-shrink: 0;
        }

        .je-more-info-modal .header-poster img {
            width: 100%;
            border-radius: 8px;
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
        }

        .je-more-info-modal .header-info {
            flex: 1;
        }

        .je-more-info-modal .title {
            font-size: 2.5rem;
            font-weight: 700;
            margin: 0 0 0.25rem;
            line-height: 1.2;
        }

        .je-more-info-modal .title-row {
            display: flex;
            align-items: center;
            gap: 0.65rem;
            flex-wrap: wrap;
        }

        .je-more-info-modal .title-chip {
            min-height: 32px;
            display: flex;
            align-items: center;
        }

        .je-more-info-modal .year {
            font-weight: 400;
            opacity: 0.7;
            font-size: 2rem;
        }

        .je-more-info-modal .meta-info {
            display: flex;
            gap: 1rem;
            margin-bottom: 1rem;
            margin-top: 1rem;
            font-size: 1rem;
            align-items: center;
        }

        .je-more-info-modal .rating-badge {
            background: rgba(255, 255, 255, 0.1);
            padding: 0.25rem 0.5rem;
            border-radius: 4px;
            font-weight: 600;
        }

        .je-more-info-modal .runtime,
        .je-more-info-modal .genres {
            opacity: 0.8;
        }

        .je-more-info-modal .tagline {
            font-size: 1rem;
            font-style: italic;
            opacity: 0.7;
            margin: 0;
        }

        .je-more-info-modal .je-more-info-actions {
            margin-top: 0.6rem;
            flex-direction: column;
            display: inline-flex;
            width: auto;
            position: relative;
            gap: 0;
            align-items: stretch;
            border-radius: 8px;
            overflow: hidden;
        }

        .je-more-info-modal .je-downloads {
            margin-top: 0.45rem;
        }

        .je-more-info-actions-row {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 0.5rem;
        }

        .je-more-info-actions-column {
            display: flex;
            flex-direction: column;
            gap: 0.35rem;
            align-items: flex-start;
        }

        .je-more-info-button-group {
            display: inline-flex;
            align-items: stretch;
            border-radius: 8px;
            overflow: hidden;
            border: 1px solid rgba(255, 255, 255, 0.12);
            background: rgba(255, 255, 255, 0.04);
        }

        .je-more-info-button-group .jellyseerr-request-button {
            border: none;
            background: transparent;
            padding: 0.5rem 0.9rem;
        }

        .je-more-info-button-group .jellyseerr-split-arrow {
            border: none;
            background: rgba(255, 255, 255, 0.08);
            padding: 0 0.55rem;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .je-status-chip {
            display: inline-flex;
            align-items: center;
            gap: 0.35rem;
            padding: 0.35rem 0.75rem;
            border-radius: 999px;
            font-weight: 700;
            letter-spacing: 0.02em;
            font-size: 0.85rem;
            text-transform: uppercase;
            background: rgba(255, 255, 255, 0.08);
            border: 1px solid rgba(255, 255, 255, 0.12);
        }

        .je-status-chip.chip-available { background: rgba(34, 197, 94, 0.25); color: #f0f9ff; border-color: rgba(34, 197, 94, 0.5); }
        .je-status-chip.chip-partial { background: rgba(234, 179, 8, 0.25); color: #f0f9ff; border-color: rgba(234, 179, 8, 0.5); }
        .je-status-chip.chip-processing { background: rgba(59, 130, 246, 0.25); color: #f0f9ff; border-color: rgba(59, 130, 246, 0.5); }
        .je-status-chip.chip-requested { background: rgba(168, 85, 247, 0.25); color: #f0f9ff; border-color: rgba(168, 85, 247, 0.5); }
        .je-status-chip.chip-rejected { background: rgba(248, 113, 113, 0.25); color: #f0f9ff; border-color: rgba(248, 113, 113, 0.5); }

        .je-download-bars {
            display: flex;
            flex-direction: column;
            gap: 0.35rem;
            width: 100%;
            margin-top: 0.15rem;
            box-sizing: border-box;
            overflow: hidden;
        }

        .je-download-row {
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 8px;
            padding: 0.5rem 0.75rem;
            box-sizing: border-box;
            min-width: 0;
            overflow: hidden;
        }

        .je-download-title {
            font-weight: 600;
            font-size: 0.9rem;
            margin-bottom: 0.2rem;
        }

        .je-download-progress {
            position: relative;
            height: 6px;
            background: rgba(255, 255, 255, 0.08);
            border-radius: 999px;
            overflow: hidden;
        }

        .je-download-progress .fill {
            position: absolute;
            inset: 0;
            background: linear-gradient(90deg, #31bcd1, #4450df);
            border-radius: inherit;
        }

        .je-download-meta {
            display: flex;
            justify-content: space-between;
            font-size: 0.75rem;
            opacity: 0.75;
            margin-top: 0.25rem;
        }

        .je-4k-popup {
            position: fixed;
            z-index: 11000;
            background: #0b1223;
            color: #fff;
            border: 1px solid rgba(255, 255, 255, 0.12);
            border-radius: 8px;
            padding: 0.25rem;
            min-width: 160px;
            box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
            opacity: 0;
            transform: translateY(-4px);
            transition: opacity 0.12s ease, transform 0.12s ease;
        }

        .je-4k-popup.show {
            opacity: 1;
            transform: translateY(0);
        }

        .je-4k-popup-item {
            width: 100%;
            background: transparent;
            border: none;
            color: #fff;
            padding: 0.45rem 0.65rem;
            text-align: left;
            font-weight: 600;
            border-radius: 6px;
            cursor: pointer;
        }

        .je-4k-popup-item:hover {
            background: rgba(255, 255, 255, 0.08);
        }

        .je-more-info-modal .overview-section {
            margin-bottom: 1rem;
        }

        .je-more-info-modal .overview-section h3 {
            font-size: 1.3rem;
            margin: 0 0 0.5rem;
            font-weight: 600;
        }

        .je-more-info-modal .overview-section p {
            line-height: 1.6;
            opacity: 0.85;
            font-size: 1rem;
        }

        .je-more-info-modal .crew-section {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 1rem;
            margin-bottom: 2rem;
        }

        .je-more-info-modal .crew-item,
        .je-more-info-modal .creators {
            margin-bottom: 1rem;
        }

        .je-more-info-modal .crew-item h4,
        .je-more-info-modal .creators h4 {
            font-size: 0.85rem;
            opacity: 0.6;
            margin: 0 0 0.25rem;
            text-transform: uppercase;
            font-weight: 600;
        }

        .je-more-info-modal .crew-item p,
        .je-more-info-modal .creators p {
            margin: 0;
            font-size: 1rem;
            line-height: 1.3;
        }

        .je-more-info-modal .keywords-section {
            margin-bottom: 0.75rem;
            display: none;
        }

        .je-more-info-modal .keywords-grid {
            display: flex;
            flex-wrap: wrap;
            gap: 0.5rem;
        }

        .je-more-info-modal .keyword {
            display: inline-block;
            padding: 0.3rem 0.6rem;
            background: rgba(255, 255, 255, 0.08);
            border: 1px solid rgba(255, 255, 255, 0.2);
            border-radius: 20px;
            font-size: 0.75rem;
        }

        .je-more-info-modal .keyword-tag {
            display: inline-block;
            padding: 0.2rem 0.5rem;
            background: rgba(255, 255, 255, 0.1);
            border-radius: 12px;
            margin: 0 0.4rem 0.4rem 0;
            font-size: 0.8rem;
        }

        .je-more-info-modal .cast-section {
            margin-bottom: 2rem;
            margin-top: 2rem;
        }

        .je-more-info-modal .cast-section h3 {
            font-size: 1.3rem;
            font-weight: 600;
            margin: 0 0 1rem;
        }

        .je-more-info-modal .cast-scroll {
            display: flex;
            gap: 1.5rem;
            overflow-x: auto;
            overflow-y: hidden;
            padding-bottom: 0.75rem;
            margin-bottom: 0;
            width: 100%;
            scrollbar-width: none;
            -webkit-overflow-scrolling: touch;
        }

        .je-more-info-modal .cast-scroll::-webkit-scrollbar {
            display: none;
        }

        .je-more-info-modal .cast-member {
            flex: 0 0 auto;
            text-align: center;
            width: 80px;
        }

        .je-more-info-modal .person-avatar {
            width: 6rem;
            height: 6rem;
            border-radius: 50%;
            overflow: hidden;
            background: rgba(255, 255, 255, 0.1);
            margin: 0 auto 0.4rem;
            border: 1px solid rgba(255, 255, 255, 0.15);
        }

        .je-more-info-modal .person-avatar img {
            width: 100%;
            height: 100%;
            object-fit: cover;
        }

        .je-more-info-modal .person-name {
            font-weight: 600;
            font-size: 0.85rem;
            margin-bottom: 0.15rem;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .je-more-info-modal .person-character {
            font-size: 0.75rem;
            opacity: 0.6;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .je-more-info-modal .trailers-section {
            margin-bottom: 1rem;
        }

        .je-more-info-modal .trailers-section h3 {
            font-size: 1.3rem;
            margin: 0 0 0.75rem;
            font-weight: 600;
        }

        .je-more-info-modal .trailers-grid {
            display: flex;
            gap: 1rem;
            overflow-x: auto;
            overflow-y: hidden;
            padding-bottom: 0.75rem;
            margin-bottom: 0;
            width: 100%;
            scrollbar-width: none;
            -webkit-overflow-scrolling: touch;
        }

        .je-more-info-modal .trailers-grid::-webkit-scrollbar {
            display: none;
        }

        .je-more-info-modal .trailer-item {
            flex: 0 0 auto;
            width: 200px;
            cursor: pointer;
            border-radius: 6px;
            overflow: hidden;
            transition: transform 0.2s;
            background: rgba(0, 0, 0, 0.2);
            border: 1px solid rgba(255, 255, 255, 0.1);
            text-decoration: none;
            display: block;
            color: inherit;
        }

        .je-more-info-modal .trailer-item:hover {
            transform: translateY(-3px);
        }

        .je-more-info-modal .trailer-thumbnail {
            position: relative;
            aspect-ratio: 16/9;
            background: #000;
        }

        .je-more-info-modal .trailer-thumbnail img {
            width: 100%;
            height: 100%;
            object-fit: cover;
        }

        .je-more-info-modal .je-modal-play-button {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            width: 50px;
            height: 50px;
            background: rgba(255, 255, 255, 0.9);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #000;
            transition: transform 0.2s;
        }

        .je-more-info-modal .trailer-item:hover .je-modal-play-button {
            transform: translate(-50%, -50%) scale(1.1);
        }

        .je-more-info-modal .je-modal-play-button svg {
            width: 25px;
            height: 25px;
            margin-left: 2px;
        }

        .je-more-info-modal .trailer-info {
            padding: 0.5rem;
        }

        .je-more-info-modal .trailer-name {
            font-weight: 600;
            font-size: 0.9rem;
            margin-bottom: 0.15rem;
        }

        .je-more-info-modal .trailer-type {
            font-size: 0.8rem;
        }

        .je-more-info-modal .trailer-youtube-icon {
            position: absolute;
            top: 5px;
            right: 5px;
            width: 28px !important;
            height: 28px !important;
            padding: 3px;
            z-index: 10;
            opacity: 0.7;
        }

        .je-more-info-modal .stats-section {
            margin-bottom: 1rem;
        }

        .je-more-info-modal .stats-section h3 {
            font-size: 1rem;
            margin: 0 0 0.75rem;
        }

        .je-more-info-modal .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
            gap: 0.75rem;
        }

        .je-more-info-modal .stat-item {
            background: rgba(255, 255, 255, 0.08);
            padding: 0.75rem;
            border-radius: 6px;
            border: 1px solid rgba(255, 255, 255, 0.1);
        }

        .je-more-info-modal .seasons-section {
            margin-bottom: 2rem;
        }

        .je-more-info-modal .seasons-section h3 {
            font-size: 1.3rem;
            margin: 0 0 0.75rem;
            font-weight: 600;
        }

        .je-more-info-right-panel {
            position: sticky;
            top: 1rem;
            max-height: calc(100vh - 2rem);
            overflow-y: auto;
        }

        .je-more-info-ratings-row {
            display: flex;
            flex-wrap: wrap;
            justify-content: flex-end;
            gap: 1rem;
            padding-bottom: 1rem;
        }

        .je-more-info-rating-badge-item {
            display: flex;
            align-items: center;
            gap: 0.4rem;
            padding: 0.75rem;
            text-align: center;
            text-decoration: none;
            color: white;
            transition: all 0.2s;
        }

        .je-more-info-rating-badge-item:hover {
            transform: translateY(-2px);
        }

        /* Reset emby-linkbutton styling for all external links in the modal */
        .je-more-info-modal a[is="emby-linkbutton"] {
            padding: 0 !important;
            margin: 0 !important;
        }

        .je-more-info-rating-icon {
            display: flex;
            align-items: center;
            justify-content: center;
            width: 2.5rem;
            height: 2.5rem;
            font-size: 0.8rem;
        }
        .je-more-info-rating-percent {
            font-size: .9rem;
            font-weight: 500;
        }

        .je-more-info-rating-score {
            font-size: .9rem;
            font-weight: 500;
        }

        .je-more-info-media-ratings {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 0.9rem;
            flex-wrap: wrap;
        }

        /* Ratings skeleton */
        .je-more-info-ratings-skeleton {
            display: flex;
            width: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 0.9rem;
            flex-wrap: wrap;
        }
        .je-skel-badge {
            display: inline-block;
            height: 28px;
            width: 56px;
            border-radius: 999px;
            background: linear-gradient(90deg, rgba(255,255,255,0.06) 25%, rgba(255,255,255,0.14) 37%, rgba(255,255,255,0.06) 63%);
            background-size: 400% 100%;
            animation: je-skel-shimmer 1.2s ease-in-out infinite;
        }
        @keyframes je-skel-shimmer {
            0% { background-position: 100% 0; }
            100% { background-position: 0 0; }
        }

        .je-more-info-ratings-cell {
            display: flex;
            justify-content: flex-end;
        }

        .je-more-info-media-facts {
            margin-top: 1rem;
        }

        .je-more-info-media-facts-row {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 0.9rem;
            flex-wrap: wrap;
        }

        .je-more-info-media-facts-row a {
            display: flex;
            align-items: center;
            justify-content: center;
            width: 2.5rem;
            height: 2.5rem;
            opacity: 0.75;
            transition: transform 0.15s ease, opacity 0.15s ease, background 0.15s ease, border-color 0.15s ease;
        }

        .je-more-info-media-facts-row a:hover {
            opacity: 1;
            transform: translateY(-2px);
        }

        .je-more-info-media-facts-row svg {
            width: 100%;
            height: 100%;
        }

        .je-more-info-stats-panel {
            background: rgba(255, 255, 255, 0.03);
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 8px;
            padding: 1.5rem;
        }

        .je-more-info-stat-row {
            display: grid;
            align-items: center;
            grid-template-columns: auto 1fr;
            gap: 1rem;
            padding-bottom: .5rem;
            padding-top: .5rem;
            border-bottom: 1px solid rgba(255, 255, 255, 0.06);
        }

        .je-more-info-stat-row:last-child {
            border-bottom: none;
            padding-bottom: 0;
        }

        .je-more-info-stat-label {
            font-size: 0.8rem;
            opacity: 0.6;
            text-transform: uppercase;
            font-weight: 600;
        }

        .je-more-info-stat-value {
            font-size: 1rem;
            line-height: 1.4;
            text-align: end;
        }

        .je-more-info-providers-list {
            display: flex;
            gap: 0.5rem;
            flex-wrap: wrap;
            justify-content: flex-end;
        }

        .je-more-info-providers-list img {
            width: 30px;
            height: 30px;
            border-radius: 4px;
            object-fit: cover;
        }

        .je-more-info-modal .production-section {
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 6px;
            padding: 1rem;
            margin-top: 1rem;
            margin-bottom: 1rem;
        }

        .je-more-info-modal .production-section h3 {
            margin-top: 0;
        }

        .je-more-info-modal .production-item {
            margin-bottom: 2rem;
        }

        .je-more-info-modal .production-item:last-child {
            margin-bottom: 0;
        }

        .je-more-info-modal .production-item h4 {
            font-size: 0.75rem;
            opacity: 0.6;
            margin: 0 0 0.5rem;
            text-transform: uppercase;
            font-weight: 600;
        }

        .je-more-info-modal .production-content {
            line-height: 1.4;
            opacity: 0.9;
            font-size: 0.9rem;
        }

        .je-more-info-modal .seasons-grid {
            display: flex;
            flex-direction: column;
            gap: 1rem;
            margin-top: 1rem;
        }

        .je-more-info-modal .season-card {
            display: flex;
            gap: 1rem;
            background: rgba(0, 0, 0, 0.2);
            border-radius: 6px;
            overflow: hidden;
            border: 1px solid rgba(255, 255, 255, 0.1);
        }

        .je-more-info-modal .season-poster {
            width: 70px;
            flex-shrink: 0;
        }

        .je-more-info-modal .season-poster img {
            width: 100%;
            height: 100%;
            object-fit: cover;
        }

        .je-more-info-modal .season-info {
            padding: 0.75rem;
            flex: 1;
        }

        .je-more-info-modal .season-name {
            font-size: 0.95rem;
            font-weight: 600;
            margin-bottom: 0.35rem;
        }

        .je-more-info-modal .season-meta {
            font-size: 0.8rem;
            opacity: 0.6;
            margin-bottom: 0.5rem;
        }

        .je-more-info-modal .season-overview {
            font-size: 0.85rem;
            line-height: 1.4;
            opacity: 0.8;
        }

        @media (max-width: 1024px) {
            .je-more-info-modal .modal-main {
                grid-template-columns: 1fr;
            }

            .je-more-info-modal .modal-right {
                width: 100%;
            }

            .je-more-info-right-panel {
                position: static;
                max-height: none;
            }
        }

        @media (max-width: 768px) {
            .je-more-info-modal .modal-content {
                padding: 0 1rem 1rem;
            }

            .je-more-info-modal .header-section {
                gap: 1rem;
                margin-bottom: 1.5rem;
            }

            .je-more-info-modal .header-poster {
                width: 120px;
            }

            .je-more-info-modal .title {
                font-size: 1.75rem;
            }

            .je-more-info-modal .crew-section {
                grid-template-columns: 1fr;
                gap: 1rem;
            }

            .je-more-info-modal .trailers-grid {
                gap: 1rem;
            }

            .je-more-info-modal .trailer-item {
                width: 180px;
            }

            .je-more-info-ratings-row {
                justify-content: flex-start;
            }

            /* Mobile optimizations for download bars */
            .je-download-bars {
                gap: 0.25rem;
            }

            .je-download-row {
                padding: 0.4rem 0.6rem;
            }

            .je-download-title {
                font-size: 0.8rem;
            }

            .je-download-meta {
                font-size: 0.65rem;
            }
        }
    `;

    document.head.appendChild(style);
}

    // Inject styles when module loads
    injectStyles();

    // Expose the module on the global JE object
    JE.jellyseerrMoreInfo = moreInfoModal;

})(window.JellyfinEnhanced);