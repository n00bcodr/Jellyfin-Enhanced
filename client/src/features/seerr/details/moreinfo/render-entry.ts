import { bridge, escaper, moreInfoRegistry, seerrDetailsContext, sibling, translator, type MediaType, type TmdbId } from '../../host-details';
import { longDate } from '../domain/dates';
import { filled, idText, isRecord, record, records, str, type JsonRecord } from '../domain/json';
import { safeHttpUrl, tmdbImage } from '../domain/links';
import { crewSummary, headerYear, runtimeText, streamingProviders, titleOf } from '../domain/media';

const JE = bridge();
const seerr = seerrDetailsContext(JE);
const internal = moreInfoRegistry(JE);
const escapeHtml = escaper(JE);
const t = translator(JE);
const label = (key: string, fallback = ''): string => escapeHtml(t(key, fallback));

function statRow(title: string, value: string): string {
    return `
                <div class="je-more-info-stat-row">
                    <div class="je-more-info-stat-label">${title}</div>
                    <div class="je-more-info-stat-value">${value}</div>
                </div>
            `;
}

function dateRow(key: string, value: unknown): string {
    const text = filled(value);
    const date = text ? longDate(text) : undefined;
    return date ? statRow(label(key), escapeHtml(date)) : '';
}

/** The certification badge; coloured like the details-page box with Colored Ratings on. */
function ratingBadge(details: JsonRecord, mediaType: MediaType): string {
    const rating = sibling(internal, 'getContentRating')(details, mediaType);
    if (JE.pluginConfig?.ColoredRatingsEnabled && rating && rating !== 'N/A') {
        return `<span class="rating-badge mediaInfoOfficialRating" rating="${escapeHtml(seerr.peer('normalizeOfficialRating')?.(rating) || rating)}">${escapeHtml(rating)}</span>`;
    }
    return `<span class="rating-badge">${escapeHtml(rating)}</span>`;
}

function buildRightPanel(rawDetails: unknown, mediaType: MediaType, { budget, revenue, releaseDate, tmdbId }: { budget: string | null; revenue: string | null; releaseDate: string | undefined; tmdbId: TmdbId }): string {
    const details = record(rawDetails) ?? {};
    const countries = records(details.productionCountries);
    const companies = records(details.productionCompanies);
    const language = filled(details.originalLanguage);
    const ratings = details.ratings
        ? sibling(internal, 'buildRatingLogos')(details.ratings, details, mediaType, tmdbId)
        : `
                    <div class="je-more-info-ratings-skeleton">
                        <span class="je-skel-badge"></span>
                        <span class="je-skel-badge" style="width:72px"></span>
                    </div>
                `;
    return `
        <div class="je-more-info-right-panel">
            <div class="je-more-info-media-ratings" data-mount="ratings">
                ${ratings}
            </div>
            ${mediaType === 'movie' && details.collection ? buildCollectionCard(details.collection) : ''}
            <div class="je-more-info-stats-panel">
                ${statRow(label('jellyseerr_modal_status'), escapeHtml(filled(details.status) ?? 'N/A'))}
                ${mediaType === 'tv'
                    ? `${dateRow('jellyseerr_modal_first_air_date', details.firstAirDate)}${dateRow('jellyseerr_modal_last_air_date', details.lastAirDate)}`
                    : dateRow('jellyseerr_modal_release_date', releaseDate)}
                ${revenue ? statRow(label('jellyseerr_modal_revenue'), escapeHtml(revenue)) : ''}
                ${budget ? statRow(label('jellyseerr_modal_budget'), escapeHtml(budget)) : ''}
                ${language ? statRow(label('jellyseerr_modal_original_language'), escapeHtml(language.toUpperCase())) : ''}
                ${countries.length ? statRow(label('jellyseerr_modal_production_country'), countries.map(country => {
                    const name = str(country.name) ?? '';
                    const shown = name === 'United States of America' ? 'United States' : name;
                    const flag = JE.cdn?.flagPng((str(country.iso_3166_1) ?? '').toLowerCase()) ?? '';
                    return `<div><img src="${escapeHtml(flag)}" alt="${escapeHtml(shown)}" title="${escapeHtml(shown)}" style="margin-right: 6px; vertical-align: middle;" /> ${escapeHtml(shown)}</div>`;
                }).join('')) : ''}
                ${companies.length ? statRow(label('jellyseerr_modal_studios'), companies.slice(0, 3).map(company => escapeHtml(str(company.name))).join(', ')) : ''}
                ${buildStreamingProviders(details)}
            </div>
            ${sibling(internal, 'buildMediaFacts')(details, mediaType, tmdbId)}
        </div>
    `;
}

function buildStreamingProviders(rawDetails: unknown): string {
    if (!JE.pluginConfig?.TmdbEnabled || !isRecord(rawDetails)) return '';
    const region = (JE.userConfig?.elsewhere?.Region || JE.pluginConfig?.DEFAULT_REGION || 'US').toUpperCase();
    const providers = streamingProviders(rawDetails, region);
    if (!providers.length) return '';
    return `
        <div class="je-more-info-stat-row">
            <div class="je-more-info-stat-label">${label('jellyseerr_modal_streaming')}</div>
            <div class="je-more-info-providers-list">
                ${providers.map(provider => {
                    const name = escapeHtml(str(provider.name));
                    return `<img src="${escapeHtml(tmdbImage('w92', provider.logoPath))}" alt="${name}" title="${name}" />`;
                }).join('')}
            </div>
        </div>
    `;
}

/** A movie's collection, styled after Seerr's own card. */
function buildCollectionCard(raw: unknown): string {
    const collection = record(raw);
    if (!collection) return '';
    const name = escapeHtml(str(collection.name));
    const backdrop = filled(collection.backdropPath);
    const image = backdrop
        ? `https://image.tmdb.org/t/p/w1440_and_h320_multi_faces/${encodeURI(backdrop)}`
        : 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22400%22 height=%22200%22%3E%3Crect fill=%22%23374151%22 width=%22400%22 height=%22200%22/%3E%3C/svg%3E';
    return `
        <div class="je-collection-card">
            <div class="je-collection-card-backdrop">
                <img src="${escapeHtml(image)}" alt="${name}" loading="lazy" />
                <div class="je-collection-card-overlay"></div>
            </div>
            <div class="je-collection-card-content">
                <div class="je-collection-card-title">${name}</div>
                <button class="je-collection-card-button" data-collection-id="${escapeHtml(idText(collection.id))}" data-collection-name="${name}">
                    ${label('jellyseerr_btn_view_collection', 'View')}
                </button>
            </div>
        </div>
    `;
}

function buildKeywordsSection(rawDetails: unknown): string {
    const keywords = records(record(rawDetails)?.keywords);
    if (!keywords.length) return '';
    return `
        <div class="keywords-section">
            <h3>${label('jellyseerr_modal_keywords', 'Keywords')}</h3>
            <div class="keywords-grid">
                ${keywords.slice(0, 20).map(keyword => `<span class="keyword">${escapeHtml(str(keyword.name))}</span>`).join('')}
            </div>
        </div>
    `;
}

function crewItem(title: string, names: string): string {
    return `
                <div class="crew-item">
                    <h4>${title}</h4>
                    <p>${names}</p>
                </div>
            `;
}

/** Creators of a show, otherwise the director and writers. */
function buildCrewSection(rawDetails: unknown, mediaType: MediaType): string {
    const details = record(rawDetails) ?? {};
    const creators = records(details.createdBy);
    if (mediaType === 'tv' && creators.length) {
        return `
            <div class="creators">
                <h4>${label('jellyseerr_modal_created_by', 'Created By')}</h4>
                <p>${creators.map(creator => escapeHtml(str(creator.name))).join(', ')}</p>
            </div>
        `;
    }
    const crew = crewSummary(details);
    if (!crew) return '';
    const parts = [
        crew.director ? crewItem(label('jellyseerr_modal_director', 'Director'), escapeHtml(str(crew.director.name))) : '',
        crew.writers.length ? crewItem(label('jellyseerr_modal_writers', 'Writers'), crew.writers.map(writer => escapeHtml(str(writer.name))).join(', ')) : '',
    ].join('');
    return parts ? `<div class="crew-section">${parts}</div>` : '';
}

function buildTrailerCard(trailer: JsonRecord, href: string): string {
    const name = escapeHtml(str(trailer.name));
    const youtube = trailer.site === 'YouTube';
    const key = filled(trailer.key);
    const thumbnail = youtube && key ? `https://img.youtube.com/vi/${encodeURIComponent(key)}/mqdefault.jpg` : '';
    const icon = youtube ? `<img src="${escapeHtml(JE.cdn?.selfhst('png/youtube.png'))}" alt="YouTube" class="trailer-youtube-icon" />` : '';
    return `
                        <a is="emby-linkbutton" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" title="${name}" class="trailer-item">
                            <div class="trailer-thumbnail">
                                ${thumbnail ? `<img src="${escapeHtml(thumbnail)}" alt="${name}" />` : ''}
                                <div class="je-modal-play-button">
                                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
                                        <path d="M8 5v14l11-7z"/>
                                    </svg>
                                </div>
                                ${icon}
                            </div>
                            <div class="trailer-info">
                                <div class="trailer-name">${name}</div>
                                <div class="trailer-type">${escapeHtml(str(trailer.type))}</div>
                            </div>
                        </a>
                    `;
}

function buildTrailersSection(rawDetails: unknown): string {
    const cards = records(record(rawDetails)?.relatedVideos)
        .filter(video => video.type === 'Trailer' || video.type === 'Teaser')
        .slice(0, 6)
        .flatMap(video => {
            const href = safeHttpUrl(video.url);
            return href ? [buildTrailerCard(video, href)] : [];
        });
    if (!cards.length) return '';
    return `
        <div class="trailers-section">
            <h3>${label('jellyseerr_modal_trailers')}</h3>
            <div class="trailers-grid">
                ${cards.join('')}
            </div>
        </div>
    `;
}

function buildPersonPlaceholder(): string {
    return `
        <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
            <rect width="100" height="100" fill="#2a2a2a"/>
            <circle cx="50" cy="40" r="15" fill="#555"/>
            <path d="M 25 75 Q 25 60, 50 60 Q 75 60, 75 75 L 75 100 L 25 100 Z" fill="#555"/>
        </svg>
    `;
}

function buildCastSection(rawDetails: unknown): string {
    const cast = records(record(record(rawDetails)?.credits)?.cast);
    if (!cast.length) return '';
    return `
        <div class="cast-section">
            <h3>${label('jellyseerr_modal_cast')}</h3>
            <div class="cast-scroll">
                ${cast.slice(0, 20).map(person => {
                    const name = escapeHtml(str(person.name));
                    const character = escapeHtml(str(person.character) ?? '');
                    const image = tmdbImage('w185', person.profilePath);
                    return `
                        <div class="cast-member">
                            <div class="person-avatar">
                                ${image ? `<img src="${escapeHtml(image)}" alt="${name}" />` : buildPersonPlaceholder()}
                            </div>
                            <div class="person-name" title="${name}">${name}</div>
                            <div class="person-character" title="${character}">${character}</div>
                        </div>
                    `;
                }).join('')}
            </div>
        </div>
    `;
}

/** The modal's whole body; the action mounts stay empty until it is attached. */
function buildModalContent(rawDetails: unknown, mediaType: MediaType): string {
    const details = record(rawDetails) ?? {};
    const title = titleOf(details, mediaType);
    const releaseDate = str(mediaType === 'movie' ? details.releaseDate : details.firstAirDate);
    const year = headerYear(details, releaseDate);
    const currency = sibling(internal, 'formatCurrency');
    const budget = details.budget ? currency(details.budget) : null;
    const revenue = details.revenue ? currency(details.revenue) : null;
    const backdrop = tmdbImage('original', details.backdropPath);
    const poster = tmdbImage('w500', details.posterPath);
    const genres = records(details.genres).map(genre => escapeHtml(str(genre.name))).join(', ') || 'N/A';
    const tagline = filled(details.tagline);
    const overview = filled(details.overview);
    const tmdbId = idText(details.id) ?? '';
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

                <div class="modal-backdrop" style="background-image: url('${escapeHtml(backdrop)}');">
                    <div class="je-modal-backdrop-overlay"></div>
                </div>

                <div class="modal-content">
                    <div class="modal-main">
                        <div class="modal-left">
                            <div class="header-section">
                                <div class="header-poster">
                                    ${poster ? `<img src="${escapeHtml(poster)}" alt="${escapeHtml(title)}" />` : ''}
                                </div>
                                <div class="header-info">
                                    <div class="title-row">
                                    <h1 class="title">${escapeHtml(title)} ${year ? `<span class="year">(${escapeHtml(year)})</span>` : ''}</h1>
                                    <div class="title-chip" data-mount="je-status-chip"></div>
                                    </div>
                                    <div class="meta-info">
                                        ${ratingBadge(details, mediaType)}
                                        <span class="runtime">${escapeHtml(runtimeText(details, mediaType))}</span>
                                        <span class="genres">${genres}</span>
                                    </div>
                                    ${tagline ? `<p class="tagline">${escapeHtml(tagline)}</p>` : ''}
                                    <div class="je-requested-by" data-mount="je-requested-by"></div>
                                    <div class="je-downloads" data-mount="je-downloads"></div>
                                    <div class="je-more-info-actions" data-mount="je-actions"></div>
                                    <div class="je-more-info-secondary-actions" data-mount="je-secondary-actions"></div>
                                </div>
                            </div>

                            ${overview ? `
                                <div class="overview-section">
                                    <h3>${label('jellyseerr_modal_overview', 'Overview')}</h3>
                                    <p>${escapeHtml(overview)}</p>
                                </div>
                            ` : ''}

                            ${buildCrewSection(details, mediaType)}

                            ${buildCastSection(details)}

                            ${buildTrailersSection(details)}

                            ${buildKeywordsSection(details)}
                        </div>

                        <div class="modal-right">
                            ${buildRightPanel(details, mediaType, { budget, revenue, releaseDate, tmdbId })}
                        </div>
                    </div>

                    ${mediaType === 'tv' ? sibling(internal, 'buildSeasonsSection')(details) : ''}
                </div>
            </div>
        </div>
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
