import { bridge, escaper, moreInfoRegistry, translator, type MediaType, type TmdbId } from '../../host-details';
import { filled, num, record, str, type JsonRecord } from '../domain/json';
import { detailsHref, safeHttpUrl, seerrPage } from '../domain/links';
import { downloadPercent, uniqueDownloads } from '../domain/media';
import { FRESH_SVG, IMDB_BADGE_SVG, IMDB_FACT_SVG, JELLYFIN_4K_SVG, JELLYFIN_SVG, LETTERBOXD_SVG, POPCORN_FULL_SVG, POPCORN_SPILLED_SVG, ROTTEN_SVG, RT_SVG, SEERR_SVG, SIMKL_SVG, TMDB_FACT_SVG, tmdbSvg, TRAKT_SVG, TVDB_SVG } from './badge-icons';

const JE = bridge();
const internal = moreInfoRegistry(JE);
const escapeHtml = escaper(JE);
const t = translator(JE);

function badge(href: string, title: string, iconClass: string, icon: string, valueClass: string, value: string): string {
    return `
                <a is="emby-linkbutton" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" class="je-more-info-rating-badge-item" title="${escapeHtml(title)}">
                    <span class="je-more-info-rating-icon ${iconClass}">${icon}</span>
                    <span class="${valueClass}">${escapeHtml(value)}</span>
                </a>
            `;
}

/** Rotten Tomatoes' page for a title. Both reply shapes keep it on the RT record. */
function rottenTomatoesUrl(ratings: JsonRecord | null): string | null {
    return safeHttpUrl(record(ratings?.rt)?.url) ?? safeHttpUrl(ratings?.url);
}

/** Rating logos for the right panel: RT critics and audience, IMDb, then the TMDB user score. */
function buildRatingLogos(rawRatings: unknown, details: unknown, mediaType: MediaType, tmdbId: TmdbId): string {
    const logos: string[] = [];
    const ratings = record(rawRatings);
    const rt = record(ratings?.rt);
    const critics = num(rt?.criticsScore);
    if (critics !== undefined) {
        const criticState = filled(rt?.criticsRating)?.toLowerCase();
        const fresh = criticState ? criticState.includes('fresh') : critics >= 60;
        const link = rottenTomatoesUrl(ratings) ?? 'https://www.rottentomatoes.com';
        logos.push(badge(link, 'Rotten Tomatoes Tomatometer', 'je-more-info-rt', fresh ? FRESH_SVG : ROTTEN_SVG, 'je-more-info-rating-percent', `${critics}%`));
        const audience = num(rt?.audienceScore);
        if (audience !== undefined) {
            const audienceState = filled(rt?.audienceRating)?.toLowerCase();
            const upright = audienceState ? audienceState.includes('upright') : audience >= 60;
            logos.push(badge(link, 'Rotten Tomatoes Audience Score', 'je-more-info-popcorn', upright ? POPCORN_FULL_SVG : POPCORN_SPILLED_SVG, 'je-more-info-rating-percent', `${audience}%`));
        }
    }

    const imdb = record(ratings?.imdb);
    const imdbScore = num(imdb?.criticsScore);
    if (imdbScore) {
        logos.push(badge(safeHttpUrl(imdb?.url) ?? 'https://www.imdb.com', 'IMDb Rating', 'je-more-info-imdb', IMDB_BADGE_SVG, 'je-more-info-rating-score', imdbScore.toFixed(1)));
    }

    const media = record(details);
    const average = num(media?.voteAverage);
    if (average && tmdbId && mediaType) {
        const votes = num(media?.voteCount);
        const title = votes !== undefined ? `TMDB User Score (${votes.toLocaleString()} votes)` : 'TMDB User Score';
        const icon = tmdbSvg(escapeHtml(`tmdb_grad_${tmdbId}`));
        logos.push(badge(`https://www.themoviedb.org/${mediaType}/${tmdbId}`, title, 'je-more-info-tmdb', icon, 'je-more-info-rating-percent', `${Math.round(average * 10)}%`));
    }
    return logos.length ? `<div class="je-more-info-ratings-row">${logos.join('')}</div>` : '';
}

interface FactLink { href: string; title: string; className: string; svg: string; internal?: boolean }

/** The links to this title elsewhere. Each appears only when the title has that target. */
function buildMediaFacts(rawDetails: unknown, mediaType: MediaType, tmdbId: TmdbId): string {
    if (!tmdbId) return '';
    const details = record(rawDetails) ?? {};
    const externalIds = record(details.externalIds);
    const info = record(details.mediaInfo);
    const ratings = record(details.ratings);

    const imdbId = filled(externalIds?.imdbId) ?? filled(details.imdbId);
    const tvdbId = mediaType === 'tv' ? num(externalIds?.tvdbId) ?? filled(externalIds?.tvdbId) : null;
    const seerrBase = JE.jellyseerrAPI?.resolveJellyseerrBaseUrl?.() ?? '';
    const rtLink = rottenTomatoesUrl(ratings);

    // A 4K deep link needs genuine 4K availability and a library item of its own.
    const jellyfinId = filled(info?.jellyfinMediaId);
    const candidate4k = info?.status4k === JE.seerrStatus?.MEDIA.AVAILABLE ? filled(info?.jellyfinMediaId4k) : null;
    const jellyfinId4k = candidate4k && candidate4k !== jellyfinId ? candidate4k : null;

    const links: Array<FactLink | null> = [
        jellyfinId ? { href: detailsHref(jellyfinId), title: 'Open in Jellyfin', className: 'je-more-info-fact jellyfin', svg: JELLYFIN_SVG, internal: true } : null,
        jellyfinId4k ? { href: detailsHref(jellyfinId4k), title: 'Open 4K version in Jellyfin', className: 'je-more-info-fact jellyfin jellyfin-4k', svg: JELLYFIN_4K_SVG, internal: true } : null,
        seerrBase ? { href: seerrPage(seerrBase, mediaType, tmdbId), title: 'View on Seerr', className: 'je-more-info-fact jellyseerr', svg: SEERR_SVG } : null,
        { href: `https://www.themoviedb.org/${mediaType}/${tmdbId}?language=en`, title: 'View on TMDB', className: 'je-more-info-fact tmdb', svg: TMDB_FACT_SVG },
        tvdbId ? { href: `http://www.thetvdb.com/?tab=series&id=${tvdbId}`, title: 'View on TheTVDB', className: 'je-more-info-fact tvdb', svg: TVDB_SVG } : null,
        imdbId ? { href: `https://www.imdb.com/title/${encodeURIComponent(imdbId)}`, title: 'View on IMDb', className: 'je-more-info-fact imdb', svg: IMDB_FACT_SVG } : null,
        rtLink ? { href: rtLink, title: 'View on Rotten Tomatoes', className: 'je-more-info-fact rt', svg: RT_SVG } : null,
        { href: `https://trakt.tv/search/tmdb/${tmdbId}?id_type=${mediaType === 'movie' ? 'movie' : 'show'}`, title: 'View on Trakt', className: 'je-more-info-fact trakt', svg: TRAKT_SVG },
        mediaType === 'movie' ? { href: `https://letterboxd.com/tmdb/${tmdbId}`, title: 'View on Letterboxd', className: 'je-more-info-fact letterboxd', svg: LETTERBOXD_SVG } : null,
        imdbId ? { href: `https://api.simkl.com/redirect?to=Simkl&imdb=${encodeURIComponent(imdbId)}`, title: 'View on SIMKL', className: 'je-more-info-fact simkl', svg: SIMKL_SVG } : null,
    ];
    const shown = links.filter((link): link is FactLink => link !== null);
    return `
        <div class="je-more-info-media-facts" aria-label="External links">
            <div class="je-more-info-media-facts-row">
                ${shown.map(link => `
                    <a is="emby-linkbutton" class="${link.className}" href="${escapeHtml(link.href)}" ${link.internal ? '' : 'target="_blank" rel="noopener noreferrer"'} title="${escapeHtml(link.title)}">
                        ${link.svg}
                    </a>
                `).join('')}
            </div>
        </div>
    `;
}

function resolveStatusLabel(status: number, status4k: number, _isMovie: boolean, downloads: readonly unknown[] = [], downloads4k: readonly unknown[] = [], is4kChip = false) {
    const seerrStatus = JE.seerrStatus;
    if (!seerrStatus) throw new Error('Seerr status unavailable');
    const active = (is4kChip ? downloads4k : downloads).length > 0;
    const { labelKey, cssClass } = seerrStatus.getChipConfig(seerrStatus.resolveDisplayStatus(is4kChip ? status4k : status, active));
    const text = t(labelKey, labelKey);
    return { text: is4kChip ? `4K ${text}` : text, className: cssClass };
}

function buildStatusChip(status: number, status4k: number, isMovie: boolean, downloads: readonly unknown[] = [], downloads4k: readonly unknown[] = [],
    jellyfinId: string | null = null, jellyfinId4k: string | null = null, is4kChip = false): HTMLElement {
    const chip = document.createElement('div');
    chip.className = 'je-status-chip';
    const { text, className } = resolveStatusLabel(status, status4k, isMovie, downloads, downloads4k, is4kChip);
    // In the library, the chip links to the item.
    const itemId = is4kChip ? jellyfinId4k : jellyfinId;
    if (itemId) {
        const link = document.createElement('a');
        link.href = detailsHref(itemId);
        link.textContent = text;
        link.style.cssText = 'color: inherit; text-decoration: none; cursor: pointer;';
        chip.appendChild(link);
    } else {
        chip.textContent = text;
    }
    chip.classList.add(className);
    return chip;
}

function buildDownloadBars(downloads: readonly unknown[] = [], downloads4k: readonly unknown[] = []): HTMLElement | null {
    const all = uniqueDownloads(downloads, downloads4k);
    if (!all.length) return null;
    const wrapper = document.createElement('div');
    wrapper.className = 'je-download-bars';
    for (const download of all) {
        const percent = downloadPercent(download);
        if (percent === null) continue;
        const eta = JE.jellyseerrUI?.formatEtaText?.(download);
        const row = document.createElement('div');
        row.className = 'je-download-row';
        row.innerHTML = `
            <div class="je-download-title">${escapeHtml(str(download.title) || t('jellyseerr_popover_downloading'))}</div>
            <div class="je-download-progress"><div class="fill" style="width:${percent}%"></div></div>
            <div class="je-download-meta">
                <span>${percent}%</span>
                <span>${escapeHtml(str(download.status) || 'Downloading')}</span>
                ${eta ? `<span class="je-download-eta">${escapeHtml(eta)}</span>` : ''}
            </div>
        `;
        wrapper.appendChild(row);
    }
    return wrapper;
}

internal.buildRatingLogos = buildRatingLogos;
internal.buildMediaFacts = buildMediaFacts;
internal.buildStatusChip = buildStatusChip;
internal.resolveStatusLabel = resolveStatusLabel;
internal.buildDownloadBars = buildDownloadBars;
