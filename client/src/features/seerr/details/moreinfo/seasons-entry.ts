import { apiClient, bridge, escaper, moreInfoRegistry, SEERR_LOG, translator, type FollowUpOptions, type MoreInfoModalElement, type TmdbId } from '../../host-details';
import { calendarYear, isIsoDate } from '../domain/dates';
import { filled, idText, isRecord, num, record, records, str, type JsonRecord } from '../domain/json';
import { detailsHref, isPosterPath, tmdbImage } from '../domain/links';
import { jellyfinSeasonMap, mergeSeasonStatuses, requestableSeasons, seasonDisplayName, seasonJellyfinId, seasonNumberOf, seasonPresence, seasonStatus, seasonYear } from '../domain/seasons';
import { isLive } from './scope';

const JE = bridge();
const internal = moreInfoRegistry(JE);
const { state } = internal;
const logPrefix = `${SEERR_LOG} Jellyseerr More Info:`;
const escapeHtml = escaper(JE);
const t = translator(JE);

/** One row of the season maps a lookup returned; each source has its own field names. */
interface SeasonLookup { seasonNumber: number; firstEpDate: string; firstEpYear: string; detail: unknown }

async function lookupSeason(tmdbId: TmdbId, seasonNumber: number, options: FollowUpOptions | undefined): Promise<SeasonLookup> {
    try {
        const detail = await JE.jellyseerrAPI?.fetchTvSeasonDetails?.(tmdbId, seasonNumber, options);
        const first = records(record(detail)?.episodes)[0];
        return { seasonNumber, firstEpDate: filled(first?.airDate) ?? '', firstEpYear: idText(first?.jeYear) ?? '', detail };
    } catch {
        return { seasonNumber, firstEpDate: '', firstEpYear: '', detail: undefined };
    }
}

/** Fills one card from what the lookups found. TMDB's fields are snake_case, Seerr's are not. */
function backfillCard(card: Element, season: JsonRecord, details: JsonRecord, tmdbSeason: JsonRecord | undefined,
    own: JsonRecord | null, episode: SeasonLookup | undefined): void {
    // On a protected title a started season can come back whole here, through an id the
    // details don't carry. The server has decided, so what it sent can show.
    const ownName = filled(own?.name);
    if (ownName && ownName !== season.name) {
        season.name = ownName;
        const nameEl = card.querySelector('.season-name');
        if (nameEl) nameEl.textContent = ownName;
    }

    // Validated, so a reply cannot point the poster anywhere else. Season art first, then the show's.
    if (!season.posterPath) {
        const candidate = filled(tmdbSeason?.poster_path) ?? filled(own?.posterPath);
        const fallback = isPosterPath(candidate) ? candidate : details.posterPath;
        if (isPosterPath(fallback)) {
            season.posterPath = fallback;
            const posterEl = card.querySelector('.season-poster');
            if (posterEl) {
                const source = tmdbImage('w185', fallback);
                const existing = posterEl.querySelector('img');
                if (existing) {
                    if (existing.src !== source) existing.src = source;
                } else {
                    const image = document.createElement('img');
                    image.src = source;
                    image.alt = card.querySelector('.season-name')?.textContent ?? '';
                    posterEl.appendChild(image);
                }
            }
        }
    }

    const overview = filled(tmdbSeason?.overview) ?? filled(own?.overview);
    if (!season.overview && overview) {
        season.overview = overview;
        const infoEl = card.querySelector('.season-info');
        if (infoEl && !infoEl.querySelector('.season-overview')) {
            const overviewEl = document.createElement('div');
            overviewEl.className = 'season-overview';
            overviewEl.textContent = overview;
            infoEl.appendChild(overviewEl);
        }
    }

    // The first episode's date, then TMDB's. Spoiler Guard leaves only the year of a date it hides.
    if (!season.airDate) {
        const episodeDate = episode?.firstEpDate && isIsoDate(episode.firstEpDate) ? episode.firstEpDate : '';
        const tmdbDate = filled(tmdbSeason?.air_date) ?? '';
        const best = episodeDate || (isIsoDate(tmdbDate) ? tmdbDate : '');
        const year = best ? calendarYear(best) : idText(season.jeYear) ?? (episode?.firstEpYear || idText(tmdbSeason?.jeYear));
        if (best) season.airDate = best;
        if (year) {
            const metaEl = card.querySelector('.season-meta');
            if (metaEl && !(metaEl.textContent ?? '').includes(String(year))) {
                metaEl.textContent = `${num(season.episodeCount) ?? 0} Episodes • ${year}`;
            }
        }
    }
}

/** Fills in seasons Seerr left bare from TMDB and each season's episodes, then updates their cards. */
async function backfillSeasonMetadata(tmdbId: TmdbId, details: unknown): Promise<void> {
    try {
        const modal = state.currentModal;
        if (!modal || !isRecord(details) || !Array.isArray(details.seasons)) return;
        const api = JE.jellyseerrAPI;
        const followUp = api?.followUpOptions?.(details);
        const seasons = records(details.seasons);
        const missing = seasons.filter(season => (num(season.episodeCount) ?? 0) > 0 && (!season.airDate || !season.posterPath || !season.overview));
        if (missing.length === 0) return;

        const tmdbLookup: Promise<unknown> = JE.pluginConfig?.TmdbEnabled && api?.fetchTmdbTvDetails
            ? api.fetchTmdbTvDetails(tmdbId, followUp).catch(() => null)
            : Promise.resolve(null);
        const episodeLookups = api?.fetchTvSeasonDetails
            ? missing.map(season => lookupSeason(tmdbId, seasonNumberOf(season) ?? 0, followUp))
            : [];
        const [tmdbData, episodes] = await Promise.all([tmdbLookup, Promise.all(episodeLookups)]);

        // A modal closed, replaced or reopened on another title has different cards.
        if (state.currentModal !== modal || modal._isClosing || String(modal.dataset?.tmdbId) !== String(tmdbId)) return;

        const tmdbSeasons = new Map<number, JsonRecord>();
        for (const season of records(record(tmdbData)?.seasons)) {
            const number = num(season.season_number);
            if (number !== undefined) tmdbSeasons.set(number, season);
        }
        const episodesBySeason = new Map(episodes.map(result => [result.seasonNumber, result]));
        for (const season of seasons) {
            const number = seasonNumberOf(season);
            if (number === undefined) continue;
            const card = modal.querySelector(`.season-card[data-season-number="${CSS.escape(String(number))}"]`);
            if (!card) continue;
            const episode = episodesBySeason.get(number);
            backfillCard(card, season, details, tmdbSeasons.get(number), details.jeSpoilerGuard ? record(episode?.detail) : null, episode);
        }
    } catch (error) {
        console.debug(`${logPrefix} Failed to backfill season metadata:`, error);
    }
}

function linkChip(className: string, itemId: string, label: string): string {
    return `<a is="emby-linkbutton" class="season-link-chip ${className}" href="${escapeHtml(detailsHref(itemId))}">${label}</a>`;
}

/**
 * A season is available only if Seerr says so and a Jellyfin id backs it up: a
 * status of 5 with no id means the library entry was deleted and Seerr is stale.
 */
function buildSeasonAvailabilityLinks(season: JsonRecord | null, seasonId: string | null = null, seasonId4k: string | null = null): string {
    const media = JE.seerrStatus?.MEDIA;
    const status = num(season?.status);
    const status4k = num(season?.status4k);
    const available = (status === media?.AVAILABLE && !!seasonId) || status === media?.PARTIALLY_AVAILABLE || (!status && !!seasonId);
    const available4k = (status4k === media?.AVAILABLE && !!seasonId4k) || status4k === media?.PARTIALLY_AVAILABLE || (!status4k && !!seasonId4k);
    const pills: string[] = [];
    if (available) pills.push(seasonId ? linkChip('available', seasonId, 'Available') : '<span class="season-link-chip available">Available</span>');
    if (available4k) {
        const target = seasonId4k ?? seasonId;
        pills.push(target ? linkChip('available-4k', target, '4K Available') : '<span class="season-link-chip available-4k">4K Available</span>');
    }
    return pills.length ? `<div class="season-links">${pills.join('')}</div>` : '';
}

async function fetchJellyfinSeasonMap(seriesId: string): Promise<Record<number, { id: string; name: string | null }>> {
    const client = apiClient();
    const userId = client.getCurrentUserId();
    if (!userId || !seriesId) return {};
    try {
        const reply = await client.ajax({
            type: 'GET', dataType: 'json',
            url: client.getUrl(`/Users/${userId}/Items`, { ParentId: seriesId, IncludeItemTypes: 'Season', Recursive: false, Fields: 'ParentIndexNumber,IndexNumber,Name' }),
        });
        return jellyfinSeasonMap(reply);
    } catch (error) {
        console.debug(`${logPrefix} Could not load Jellyfin season links:`, error);
        return {};
    }
}

/** Per details object: a refresh of the same title asks again, and a failed lookup is never kept. */
const seasonMaps = new WeakMap<object, Record<number, { id: string; name: string | null }>>();

async function enrichSeasonCardsWithJellyfinLinks(details: unknown, modal: MoreInfoModalElement | null = state.currentModal, options: { refresh?: boolean } = {}): Promise<void> {
    if (!modal || !isRecord(details) || details.mediaType === 'movie') return;
    const seriesId = filled(record(details.mediaInfo)?.jellyfinMediaId);
    if (!seriesId || !modal.querySelector('[data-season-number]')) return;

    let known = options.refresh ? undefined : seasonMaps.get(details);
    if (!known) {
        known = await fetchJellyfinSeasonMap(seriesId);
        if (Object.keys(known).length > 0) seasonMaps.set(details, known);
        else seasonMaps.delete(details);
        if (!isLive(state, modal)) return;
    }
    const map = known;

    modal.querySelectorAll<HTMLElement>('[data-season-number]').forEach(card => {
        const number = Number(card.dataset.seasonNumber);
        const mount = card.querySelector('[data-season-links]');
        if (!mount || !Number.isFinite(number)) return;
        const season = seasonStatus(details, number);
        const entry = map[number];
        mount.innerHTML = buildSeasonAvailabilityLinks(season, entry?.id ?? seasonJellyfinId(season), seasonJellyfinId(season, true));
        // Jellyfin's own name, so TVDB subtitles like "Beast Hunters" read "Season 3".
        if (entry?.name) {
            const nameEl = card.querySelector('.season-name');
            if (nameEl) nameEl.textContent = entry.name;
        }
    });
}

/** Whether a show has seasons left to request; false as well when the signal cancelled the check. */
async function checkForUnrequestedSeasons(details: unknown, signal?: AbortSignal): Promise<boolean> {
    if (!isRecord(details)) return false;
    const seasons = requestableSeasons(details);
    if (seasons.length === 0) return false;
    const seerrStatus = JE.seerrStatus;
    const coreApi = JE.core?.api;
    try {
        if (!seerrStatus || !coreApi) throw new Error('Seerr status or core API unavailable');
        const signalOption = signal ? { signal } : {};
        // Through the core client (one attempt, like ApiClient.ajax) so the signal cancels the request itself.
        const reply = await coreApi.plugin('/jellyseerr/request?take=500&skip=0&filter=all', { skipRetry: true, ...signalOption });
        const mediaInfo = record(details.mediaInfo);
        const statuses = mergeSeasonStatuses(records(record(reply)?.results), details.id, mediaInfo?.seasons);

        // Available can be stale: Seerr keeps a season available after it left the library, and the
        // show-level id only catches a whole show going. Ask Jellyfin which seasons really exist.
        const jellyfinMediaId = filled(mediaInfo?.jellyfinMediaId);
        let presence: Record<number, boolean> | null = null;
        if (jellyfinMediaId) {
            try {
                const client = apiClient();
                const userId = client.getCurrentUserId();
                if (userId) {
                    presence = seasonPresence(await coreApi.fetch(client.getUrl(`/Users/${userId}/Items`, {
                        ParentId: jellyfinMediaId, IncludeItemTypes: 'Season', Recursive: false, Fields: 'IndexNumber',
                    }), { skipRetry: true, ...signalOption }));
                }
            } catch {
                // Without presence data the show-level id decides, as for any other title.
            }
        }
        return seasons.some(number => seerrStatus.isRequestable(seerrStatus.effectiveMediaStatus(statuses.get(number), jellyfinMediaId, presence, number)));
    } catch (error) {
        if (signal?.aborted) return false;
        console.error('[More Info Modal] Error checking unrequested seasons:', error);
        return false;
    }
}

function buildSeasonCard(details: JsonRecord, season: JsonRecord): string {
    const number = seasonNumberOf(season) ?? 0;
    const status = seasonStatus(details, number);
    const poster = filled(season.posterPath) ?? (isPosterPath(details.posterPath) ? details.posterPath : null);
    const posterUrl = poster ? tmdbImage('w185', poster) : '';
    const name = seasonDisplayName(season, t('jellyseerr_season_specials'), value => t('jellyseerr_season_name', '', { number: value }));
    const year = seasonYear(season);
    return `
                        <div class="season-card" data-season-number="${escapeHtml(String(number))}">
                            <div class="season-poster">
                                ${posterUrl ? `<img src="${escapeHtml(posterUrl)}" alt="${escapeHtml(name)}" />` : ''}
                            </div>
                            <div class="season-info">
                                <div class="season-name">${escapeHtml(name)}</div>
                                <div class="season-meta">
                                    ${escapeHtml(num(season.episodeCount) ?? 0)} Episodes
                                    ${year ? ` • ${escapeHtml(year)}` : ''}
                                </div>
                                <div data-season-links>${buildSeasonAvailabilityLinks(status, seasonJellyfinId(status), seasonJellyfinId(status, true))}</div>
                                ${season.overview ? `<div class="season-overview">${escapeHtml(str(season.overview))}</div>` : ''}
                            </div>
                        </div>
                    `;
}

/** The seasons grid of a TV show. */
function buildSeasonsSection(details: unknown): string {
    if (!isRecord(details)) return '';
    const seasons = records(details.seasons);
    if (!seasons.length) return '';
    return `
        <div class="seasons-section">
            <h3>Seasons</h3>
            <div class="seasons-grid">
                ${seasons.map(season => buildSeasonCard(details, season)).join('')}
            </div>
        </div>
    `;
}

internal.backfillSeasonMetadata = backfillSeasonMetadata;
internal.getSeasonStatusInfo = seasonStatus;
internal.getSeasonJellyfinId = seasonJellyfinId;
internal.buildSeasonAvailabilityLinks = buildSeasonAvailabilityLinks;
internal.fetchJellyfinSeasonMap = fetchJellyfinSeasonMap;
internal.enrichSeasonCardsWithJellyfinLinks = enrichSeasonCardsWithJellyfinLinks;
internal.checkForUnrequestedSeasons = checkForUnrequestedSeasons;
internal.buildSeasonsSection = buildSeasonsSection;
