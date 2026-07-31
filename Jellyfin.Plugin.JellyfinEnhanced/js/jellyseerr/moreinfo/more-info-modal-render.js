// /js/jellyseerr/moreinfo/more-info-modal-render.js
// Static HTML builders for the more-info modal body (header, panels,
// crew/cast, trailers, keywords, collection card).
(function(JE) {
    'use strict';

    JE.internals = JE.internals || {};
    // Shared state is seeded by more-info-modal-data.js, which plugin.js loads
    // first in this group.
    const internal = JE.internals.moreInfoModal;
    const escapeHtml = JE.escapeHtml;

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
    const budget = data.budget ? internal.formatCurrency(data.budget) : null;
    const revenue = data.revenue ? internal.formatCurrency(data.revenue) : null;

    const backdropUrl = data.backdropPath
        ? `https://image.tmdb.org/t/p/original${data.backdropPath}`
        : '';

    const posterUrl = data.posterPath
        ? `https://image.tmdb.org/t/p/w500${data.posterPath}`
        : '';

    return `
        <div class="modal-overlay">
            <div class="modal-container">
                <button class="modal-refresh" aria-label="Refresh" title="Refresh status">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="23 4 23 10 17 10"></polyline>
                        <polyline points="1 20 1 14 7 14"></polyline>
                        <path d="M3.51 9a9 9 0 0 1 14.85-3.36M20.49 15a9 9 0 0 1-14.85 3.36"></path>
                    </svg>
                </button>
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
                                        <span class="rating-badge">${internal.getContentRating(data, mediaType)}</span>
                                        <span class="runtime">${runtime}</span>
                                        <span class="genres">${data.genres?.map(g => escapeHtml(g.name)).join(', ') || 'N/A'}</span>
                                    </div>
                                    ${data.tagline ? `<p class="tagline">${escapeHtml(data.tagline)}</p>` : ''}
                                    <div class="je-requested-by" data-mount="je-requested-by"></div>
                                    <div class="je-downloads" data-mount="je-downloads"></div>
                                    <div class="je-more-info-actions" data-mount="je-actions"></div>
                                    <div class="je-more-info-secondary-actions" data-mount="je-secondary-actions"></div>
                                </div>
                            </div>

                            ${data.overview ? `
                                <div class="overview-section">
                                    <h3>${JE.t('jellyseerr_modal_overview') || 'Overview'}</h3>
                                    <p>${escapeHtml(data.overview)}</p>
                                </div>
                            ` : ''}

                            ${buildCrewSection(data, mediaType)}

                            ${buildCastSection(data)}

                            ${buildTrailersSection(data)}

                            ${buildKeywordsSection(data)}
                        </div>

                        <div class="modal-right">
                            ${buildRightPanel(data, mediaType, { budget, revenue, releaseDate, tmdbId: data.id })}
                        </div>
                    </div>

                    ${mediaType === 'tv' ? internal.buildSeasonsSection(data) : ''}
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
                ${data.ratings ? internal.buildRatingLogos(data.ratings, data, mediaType, tmdbId) : `
                    <div class="je-more-info-ratings-skeleton">
                        <span class="je-skel-badge"></span>
                        <span class="je-skel-badge" style="width:72px"></span>
                    </div>
                `}
            </div>
            ${mediaType === 'movie' && data.collection ? buildCollectionCard(data.collection) : ''}
            <div class="je-more-info-stats-panel">
                <div class="je-more-info-stat-row">
                    <div class="je-more-info-stat-label">${JE.t('jellyseerr_modal_status')}</div>
                    <div class="je-more-info-stat-value">${escapeHtml(data.status || 'N/A')}</div>
                </div>

                ${mediaType === 'tv' ? `
                    ${data.firstAirDate ? `
                        <div class="je-more-info-stat-row">
                            <div class="je-more-info-stat-label">${JE.t('jellyseerr_modal_first_air_date')}</div>
                            <div class="je-more-info-stat-value">${new Date(data.firstAirDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</div>
                        </div>
                    ` : ''}
                    ${data.lastAirDate ? `
                        <div class="je-more-info-stat-row">
                            <div class="je-more-info-stat-label">${JE.t('jellyseerr_modal_last_air_date')}</div>
                            <div class="je-more-info-stat-value">${new Date(data.lastAirDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</div>
                        </div>
                    ` : ''}
                ` : `
                    ${releaseDate ? `
                        <div class="je-more-info-stat-row">
                            <div class="je-more-info-stat-label">${JE.t('jellyseerr_modal_release_date')}</div>
                            <div class="je-more-info-stat-value">${new Date(releaseDate).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</div>
                        </div>
                    ` : ''}
                `}

                ${revenue ? `
                    <div class="je-more-info-stat-row">
                        <div class="je-more-info-stat-label">${JE.t('jellyseerr_modal_revenue')}</div>
                        <div class="je-more-info-stat-value">${revenue}</div>
                    </div>
                ` : ''}

                ${budget ? `
                    <div class="je-more-info-stat-row">
                        <div class="je-more-info-stat-label">${JE.t('jellyseerr_modal_budget')}</div>
                        <div class="je-more-info-stat-value">${budget}</div>
                    </div>
                ` : ''}

                ${data.originalLanguage ? `
                    <div class="je-more-info-stat-row">
                        <div class="je-more-info-stat-label">${JE.t('jellyseerr_modal_original_language')}</div>
                        <div class="je-more-info-stat-value">${data.originalLanguage.toUpperCase()}</div>
                    </div>
                ` : ''}

                ${data.productionCountries?.length ? `
                    <div class="je-more-info-stat-row">
                        <div class="je-more-info-stat-label">${JE.t('jellyseerr_modal_production_country')}</div>
                        <div class="je-more-info-stat-value">${data.productionCountries.map(c => {
                            const disp = c?.name === 'United States of America' ? 'United States' : (c?.name || '');
                            const code = (c?.iso_3166_1 || '').toLowerCase();
                            return `<div><img src="${JE.cdn.flagPng(code)}" alt="${escapeHtml(disp)}" title="${escapeHtml(disp)}" style="margin-right: 6px; vertical-align: middle;" /> ${escapeHtml(disp)}</div>`;
                        }).join('')}</div>
                    </div>
                ` : ''}

                ${data.productionCompanies?.length ? `
                    <div class="je-more-info-stat-row">
                        <div class="je-more-info-stat-label">${JE.t('jellyseerr_modal_studios')}</div>
                        <div class="je-more-info-stat-value">${data.productionCompanies.slice(0, 3).map(c => escapeHtml(c.name)).join(', ')}</div>
                    </div>
                ` : ''}

                ${buildStreamingProviders(data)}
            </div>
            ${internal.buildMediaFacts(data, mediaType, tmdbId)}
        </div>
    `;
}

/**
 * Build streaming providers section
 */
function buildStreamingProviders(data) {
    // Early exit if TMDB is not configured
    if (!JE?.pluginConfig?.TmdbEnabled) {
        return '';
    }

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
            <div class="je-more-info-stat-label">${JE.t('jellyseerr_modal_streaming')}</div>
            <div class="je-more-info-providers-list">
                ${uniqueProviders.map(p => `<img src="https://image.tmdb.org/t/p/w92${p.logoPath}" alt="${escapeHtml(p.name)}" title="${escapeHtml(p.name)}" />`).join('')}
            </div>
        </div>
    `;
}

/**
 * Build collection card (Jellyseerr-style)
 */
function buildCollectionCard(collection) {
    if (!collection) return '';

    const backdropUrl = collection.backdropPath
        ? `https://image.tmdb.org/t/p/w1440_and_h320_multi_faces/${collection.backdropPath}`
        : 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22400%22 height=%22200%22%3E%3Crect fill=%22%23374151%22 width=%22400%22 height=%22200%22/%3E%3C/svg%3E';

    return `
        <div class="je-collection-card">
            <div class="je-collection-card-backdrop">
                <img src="${escapeHtml(backdropUrl)}" alt="${escapeHtml(collection.name)}" loading="lazy" />
                <div class="je-collection-card-overlay"></div>
            </div>
            <div class="je-collection-card-content">
                <div class="je-collection-card-title">${escapeHtml(collection.name)}</div>
                <button class="je-collection-card-button" data-collection-id="${collection.id}" data-collection-name="${escapeHtml(collection.name)}">
                    ${JE.t('jellyseerr_btn_view_collection') || 'View'}
                </button>
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
            <h3>${JE.t('jellyseerr_modal_keywords') || 'Keywords'}</h3>
            <div class="keywords-grid">
                ${data.keywords.slice(0, 20).map(k => `<span class="keyword">${escapeHtml(k.name)}</span>`).join('')}
            </div>
        </div>
    `;
}

/**
 * Build crew section (director, writers, etc.)
 */
function buildCrewSection(data, mediaType) {
    if (mediaType === 'tv' && data.createdBy?.length) {
        return `
            <div class="creators">
                <h4>${JE.t('jellyseerr_modal_created_by') || 'Created By'}</h4>
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
                    <h4>${JE.t('jellyseerr_modal_director') || 'Director'}</h4>
                    <p>${escapeHtml(director.name)}</p>
                </div>
            `;
        }
        if (writers.length) {
            html += `
                <div class="crew-item">
                    <h4>${JE.t('jellyseerr_modal_writers') || 'Writers'}</h4>
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
            <h3>${JE.t('jellyseerr_modal_trailers')}</h3>
            <div class="trailers-grid">
                ${trailers.map(trailer => {
                    const thumbnailUrl = trailer.site === 'YouTube'
                        ? `https://img.youtube.com/vi/${trailer.key}/mqdefault.jpg`
                        : '';
                    const youtubeIcon = trailer.site === 'YouTube' ? `<img src="${JE.cdn.selfhst('png/youtube.png')}" alt="YouTube" class="trailer-youtube-icon" />` : '';

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
 * Build cast section (horizontal scrollable)
 */
function buildCastSection(data) {
    if (!data.credits?.cast || !data.credits.cast.length) return '';

    const cast = data.credits.cast.slice(0, 20);

    return `
        <div class="cast-section">
            <h3>${JE.t('jellyseerr_modal_cast')}</h3>
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
    internal.buildModalContent = buildModalContent;
    internal.buildRightPanel = buildRightPanel;
    internal.buildStreamingProviders = buildStreamingProviders;
    internal.buildCollectionCard = buildCollectionCard;
    internal.buildKeywordsSection = buildKeywordsSection;
    internal.buildCrewSection = buildCrewSection;
    internal.buildTrailersSection = buildTrailersSection;
    internal.buildCastSection = buildCastSection;
    internal.buildPersonPlaceholder = buildPersonPlaceholder;

})(window.JellyfinEnhanced);
