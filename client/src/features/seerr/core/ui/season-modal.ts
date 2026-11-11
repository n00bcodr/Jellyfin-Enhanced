import type { SeerrCoreHost } from '../../host-core';
import type { SeerrUiFacade } from '../contract';
import { decodeTvDetails, isNumber, isRecord, isString } from '../decode';
import { MEDIA, REQUEST, effectiveMediaStatus, getDisplayInfo, isRequestable } from '../status';
import type { TvDetailsView, TvSeason } from '../types';
import { LOG_UI, captureOrigin, classifyFailure, errorStatus, escapeWith, firstInstall, groupInternals, hashQuery } from '../runtime';

const isValidDate = (value: unknown): value is string => isString(value) && /^\d{4}-\d{2}-\d{2}/.test(value);
type SeasonMap = Readonly<Record<number, boolean>>;

/** The TVDB id typed or picked in the match block: a positive 32-bit integer, else null. */
export function readManualTvdbId(root: ParentNode): number | null {
    const input = root.querySelector('#jellyseerr-tvdb-id');
    const raw = String(input instanceof HTMLInputElement ? input.value : '').trim();
    if (!/^\d+$/.test(raw)) return null;
    const id = parseInt(raw, 10);
    // Seerr stores tvdbId in a 32-bit integer column.
    return id > 0 && id <= 0x7fffffff ? id : null;
}
/** A season's display name: TheTVDB's bare numbers become "Season N" (or Specials). */
export function seasonDisplayName(season: TvSeason, t: (key: string, params?: Readonly<Record<string, string | number>>) => string): string {
    const trimmed = (season.name || '').trim();
    const numericOnly = trimmed === String(season.seasonNumber) || /^0*\d+$/.test(trimmed);
    if (trimmed && !numericOnly) return trimmed;
    return season.seasonNumber === 0 ? t('jellyseerr_season_specials') : t('jellyseerr_season_name', { number: season.seasonNumber });
}

/** The season-selection request modal for TV shows. */
export function installSeasonModal(host: SeerrCoreHost): void {
    const { JE, document, window } = host;
    if (!firstInstall(JE, 'ui-season-modal')) return;
    const ui: Partial<SeerrUiFacade> = JE.jellyseerrUI ||= {};
    const internals = groupInternals(JE);
    const escapeHtml = escapeWith(JE);
    // One open season modal polls at a time.
    let refreshModalInterval: number | undefined;
    const stopPolling = () => {
        if (refreshModalInterval !== undefined) window.clearInterval(refreshModalInterval);
        refreshModalInterval = undefined;
    };

    function updateSeasonList(seasonListElement: Element | null, value: unknown, partialRequestsEnabled = true,
        enableSpecialEpisodes = false, is4kMode = false, jellyfinSeasonMap: SeasonMap | null = null): void {
        const details: TvDetailsView | null = isTvView(value) ? value : decodeTvDetails(value);
        if (!seasonListElement || !details) return;
        const showJellyfinId = is4kMode ? (details.mediaInfo?.jellyfinMediaId4k || null) : (details.mediaInfo?.jellyfinMediaId || null);
        const statusBySeason = new Map<number, number>();
        for (const season of details.mediaInfo?.seasons || []) {
            const status = is4kMode ? season.status4k : season.status;
            if (status !== undefined && status !== null && isNumber(season.seasonNumber)) statusBySeason.set(season.seasonNumber,
                effectiveMediaStatus(status, showJellyfinId, jellyfinSeasonMap, season.seasonNumber));
        }
        for (const request of details.mediaInfo?.requests || []) {
            if (!!request.is4k !== !!is4kMode) continue;
            for (const season of request.seasons || []) {
                if (!isNumber(season.seasonNumber)) continue;
                // Request rows use a different enum from media seasons. Only active
                // requests can fill missing media state; historical declined/failed/
                // completed requests must not replace the current library state.
                const active = season.status === REQUEST.PENDING ? MEDIA.PENDING
                    : season.status === REQUEST.APPROVED ? MEDIA.PROCESSING : null;
                const media = statusBySeason.get(season.seasonNumber);
                if (active !== null && (isRequestable(media) || (media === MEDIA.PENDING && active === MEDIA.PROCESSING))) {
                    statusBySeason.set(season.seasonNumber, active);
                }
            }
        }
        // Seasons with episodes; Specials only when Seerr allows requesting them.
        const seasons = details.seasons
            .filter(s => !!s.episodeCount && s.episodeCount > 0)
            .filter(s => s.seasonNumber !== 0 || enableSpecialEpisodes)
            .slice()
            .sort((a, b) => (a.seasonNumber || 0) - (b.seasonNumber || 0));
        const downloads = (is4kMode ? details.mediaInfo?.downloadStatus4k : details.mediaInfo?.downloadStatus) || [];
        for (const season of seasons) {
            const seasonNumber = season.seasonNumber;
            let item = seasonListElement.querySelector(`.jellyseerr-season-item[data-season-number="${seasonNumber}"]`);
            if (!(item instanceof HTMLElement)) {
                const created = document.createElement('div');
                created.className = 'jellyseerr-season-item';
                created.dataset.seasonNumber = String(seasonNumber);
                seasonListElement.appendChild(created);
                item = created;
            }
            const seasonItem = item;
            // Seerr can keep "Available" after the library lost the season: Jellyfin decides.
            const effective = statusBySeason.get(seasonNumber) ?? MEDIA.UNKNOWN;
            const canRequest = isRequestable(effective);
            const seasonDownloads = downloads.filter(download => download.episode?.seasonNumber === seasonNumber);
            const { labelKey, cssClass } = getDisplayInfo(effective, seasonDownloads.length > 0);
            const existing = seasonItem.querySelector('.jellyseerr-season-checkbox');
            const wasChecked = existing instanceof HTMLInputElement ? existing.checked : false;
            const disabled = !partialRequestsEnabled || !canRequest;
            const episodes = season.episodeCount || 0;
            seasonItem.innerHTML = `
                <input type="checkbox" class="jellyseerr-season-checkbox" data-season-number="${escapeHtml(seasonNumber)}" ${disabled ? 'disabled' : ''} style="${!partialRequestsEnabled ? 'cursor: not-allowed;' : ''}">
                <div class="jellyseerr-season-info">
                    <div class="jellyseerr-season-name">${escapeHtml(seasonDisplayName(season, JE.t))}</div>
                    <div class="jellyseerr-season-meta">${escapeHtml((season.airDate || season.jeYear || '').substring(0, 4))}<span class="jellyseerr-meta-eps"> &middot; ${escapeHtml(JE.t('jellyseerr_season_episode_count', { count: episodes }))}</span></div>
                </div>
                <div class="jellyseerr-season-episodes">${escapeHtml(JE.t('jellyseerr_season_episode_count', { count: episodes }))}</div>
                <div class="jellyseerr-season-status jellyseerr-season-status-${escapeHtml(cssClass)}">${escapeHtml(JE.t(labelKey))}</div>
            `;
            if (existing instanceof HTMLInputElement) {
                const checkbox = seasonItem.querySelector('.jellyseerr-season-checkbox');
                if (checkbox instanceof HTMLInputElement) checkbox.checked = wasChecked && !disabled;
            }
            seasonItem.classList.toggle('disabled', !canRequest);
            seasonItem.querySelector('.jellyseerr-inline-progress')?.remove();
            if (seasonDownloads.length > 0) {
                const size = seasonDownloads.reduce((sum, d) => sum + (d.size || 0), 0);
                const sizeLeft = seasonDownloads.reduce((sum, d) => sum + (d.sizeLeft || 0), 0);
                if (size > 0) {
                    const progress = internals.createInlineProgress?.({ size, sizeLeft, status: JE.t('jellyseerr_season_episodes_downloading', { count: seasonDownloads.length }) });
                    if (progress) seasonItem.appendChild(progress);
                }
            }
        }
    }
    function isTvView(value: unknown): value is TvDetailsView {
        return isRecord(value) && Array.isArray(value.seasons) && 'externalTvdbId' in value && 'mediaInfo' in value;
    }

    function buildTvdbMatchHTML(): string {
        return `
            <div class="jellyseerr-tvdb-match">
                <div class="jellyseerr-tvdb-match-notice">${JE.t('jellyseerr_tvdb_match_notice')}</div>
                <div class="jellyseerr-tvdb-match-results"><div class="jellyseerr-tvdb-match-hint">${JE.t('jellyseerr_tvdb_match_searching')}</div></div>
                <div class="jellyseerr-form-group">
                    <label for="jellyseerr-tvdb-id">${JE.t('jellyseerr_tvdb_id_label')}</label>
                    <input type="number" id="jellyseerr-tvdb-id" inputmode="numeric" min="1" step="1" autocomplete="off" placeholder="${escapeHtml(JE.t('jellyseerr_tvdb_id_placeholder'))}">
                </div>
            </div>`;
    }
    /**
     * Sonarr candidates for a show TMDB has no TVDB id for. A picked candidate
     * writes its id into the manual input, the single value read on submit.
     */
    async function populateTvdbMatches(modalEl: HTMLElement, tmdbId: number | string): Promise<void> {
        const resultsEl = modalEl.querySelector('.jellyseerr-tvdb-match-results');
        const input = modalEl.querySelector('#jellyseerr-tvdb-id');
        const api = JE.jellyseerrAPI;
        if (!(resultsEl instanceof HTMLElement) || !(input instanceof HTMLInputElement) || !api) return;
        let candidates: { tvdbId: number; title?: string | null; year?: number | string | null; overview?: string | null; remotePoster?: string | null }[] = [];
        // 404: Seerr has no Sonarr, so "no matches" is accurate; other failures get their own hint.
        let hintKey = 'jellyseerr_tvdb_match_none';
        try {
            candidates = (await api.fetchSonarrLookup(tmdbId)).filter(c => Number.isInteger(c.tvdbId) && c.tvdbId > 0).slice(0, 6);
        } catch (error) {
            if (errorStatus(error) !== 404) {
                hintKey = 'jellyseerr_tvdb_match_failed';
                console.warn(`${LOG_UI} Sonarr lookup failed for TMDB ID ${tmdbId}:`, error);
            }
        }
        if (!document.body.contains(modalEl)) return;
        if (candidates.length === 0) {
            resultsEl.innerHTML = `<div class="jellyseerr-tvdb-match-hint">${JE.t(hintKey)}</div>`;
            return;
        }
        const fallbackPoster = JE.cdn?.url?.('ibb', 'fdbkXQdP/jellyseerr-poster-not-found.png') ?? '';
        resultsEl.innerHTML = candidates.map(c => {
            const poster = /^https?:\/\//i.test(c.remotePoster || '') && c.remotePoster ? c.remotePoster : fallbackPoster;
            const year = c.year ?? '';
            return `
                <button type="button" class="jellyseerr-tvdb-match-row" data-tvdb-id="${escapeHtml(c.tvdbId)}">
                    <img src="${escapeHtml(poster)}" alt="" loading="lazy">
                    <div>
                        <div class="title">${escapeHtml(c.title || '')}</div>
                        <div class="meta">${escapeHtml(year)}${year ? ' · ' : ''}TVDB ${escapeHtml(c.tvdbId)}</div>
                        ${c.overview ? `<div class="overview">${escapeHtml(c.overview)}</div>` : ''}
                    </div>
                </button>`;
        }).join('');
        // A broken poster falls back once (a listener rather than an inline handler).
        for (const img of resultsEl.querySelectorAll('img')) {
            img.addEventListener('error', () => { if (img.getAttribute('src') !== fallbackPoster) img.src = fallbackPoster; }, { once: true });
        }
        const syncSelection = () => {
            const current = String(input.value || '').trim();
            for (const row of resultsEl.querySelectorAll<HTMLElement>('.jellyseerr-tvdb-match-row')) row.classList.toggle('selected', row.dataset.tvdbId === current);
        };
        resultsEl.addEventListener('click', event => {
            const row = event.target instanceof Element ? event.target.closest('.jellyseerr-tvdb-match-row') : null;
            if (!(row instanceof HTMLElement)) return;
            input.value = row.dataset.tvdbId || '';
            syncSelection();
        });
        input.addEventListener('input', syncSelection);
        syncSelection();
    }

    /** Which of the show's seasons Jellyfin actually has (season numbers), or null when unknown. */
    async function jellyfinSeasons(seriesId: string): Promise<SeasonMap | null> {
        const client = host.apiClient();
        const userId = client?.getCurrentUserId?.();
        if (!client?.ajax || !isString(userId) || !userId) return null;
        try {
            const response = await client.ajax({
                type: 'GET',
                url: client.getUrl(`/Users/${userId}/Items`, { ParentId: seriesId, IncludeItemTypes: 'Season', Recursive: false, Fields: 'IndexNumber' }),
                dataType: 'json'
            });
            const map: Record<number, boolean> = {};
            const items = isRecord(response) && Array.isArray(response.Items) ? response.Items : [];
            for (const season of items) {
                const index = isRecord(season) ? Number(season.IndexNumber) : NaN;
                if (Number.isFinite(index) && index >= 0) map[index] = true;
            }
            return map;
        } catch {
            return null;
        }
    }

    async function showSeasonSelectionModal(tmdbId: number | string, mediaType: string, showTitle: string, searchResultItem: unknown = null, is4k = false): Promise<void> {
        if (mediaType !== 'tv') return;
        stopPolling();
        const modal = JE.jellyseerrModal;
        const api = JE.jellyseerrAPI;
        if (!modal || !api) return;
        // Everything below (options, statuses, the request) belongs to this account.
        const origin = captureOrigin(host);
        let partialRequestsEnabled = false;
        let enableSpecialEpisodes = false;
        try {
            const settings = await api.fetchRequestSettings();
            partialRequestsEnabled = settings.partialRequestsEnabled;
            enableSpecialEpisodes = settings.enableSpecialEpisodes;
        } catch { /* whole-show requests */ }
        const singleSeasonOnly = partialRequestsEnabled && JE.pluginConfig?.JellyseerrSingleSeasonRequestOnly === true;
        // Uncached, as in More Info, so the requests that follow carry a current Spoiler Guard verdict.
        const rawDetails = await api.fetchTvShowDetails(tmdbId, { skipCache: true });
        const tvDetails = decodeTvDetails(rawDetails);
        if (!origin.current()) return;
        if (!tvDetails) {
            JE.toast?.(JE.t('jellyseerr_toast_no_season_info'), 4000);
            return;
        }
        // Seerr keeps "Available" after a season left the library while the show's id stays set:
        // Jellyfin's own seasons decide.
        const seriesId = (is4k ? tvDetails.mediaInfo?.jellyfinMediaId4k : tvDetails.mediaInfo?.jellyfinMediaId) || null;
        const jellyfinSeasonMap = seriesId ? await jellyfinSeasons(seriesId) : null;
        if (!origin.current()) return;

        const normalizedTitle = String(showTitle || '').trim();
        const genericTitle = ['this show', 'this movie', 'this collection'].includes(normalizedTitle.toLowerCase());
        const fromItem = (key: string): string | null => isRecord(searchResultItem) && isString(searchResultItem[key]) && searchResultItem[key] ? String(searchResultItem[key]) : null;
        const resolvedShowTitle = (!genericTitle && normalizedTitle) || tvDetails.name || tvDetails.title || fromItem('name') || fromItem('title')
            || fromItem('originalName') || fromItem('originalTitle') || normalizedTitle || 'Unknown Show';
        const showAdvanced = api.shouldShowAdvanced();
        // No TVDB id on TMDB (common for anime): Seerr cannot hand the show to Sonarr, so the user
        // picks a match, as Seerr's own modal asks. Not when Seerr already stores one on its media row;
        // that stored id is still sent so it survives a media row deleted since these details.
        const storedTvdbId = isNumber(tvDetails.mediaInfo?.tvdbId) && Number.isInteger(tvDetails.mediaInfo.tvdbId) && tvDetails.mediaInfo.tvdbId > 0
            ? tvDetails.mediaInfo.tvdbId : null;
        const needsTvdbMatch = !tvDetails.externalTvdbId && !storedTvdbId;
        const resetLabel = () => is4k ? (JE.t('jellyseerr_btn_request_4k') || 'Request in 4K')
            : (partialRequestsEnabled ? JE.t('jellyseerr_modal_request_selected') : JE.t('jellyseerr_modal_request'));
        const bodyHtml = `${needsTvdbMatch ? buildTvdbMatchHTML() : ''}<div class="jellyseerr-season-list">
            ${partialRequestsEnabled && !singleSeasonOnly ? '<div class="jellyseerr-season-header-row"><input type="checkbox" class="jellyseerr-season-checkbox" id="jellyseerr-select-all-seasons"><label class="jellyseerr-season-header-label" for="jellyseerr-select-all-seasons">' + JE.t('jellyseerr_select_all_seasons') + '</label><div></div><div></div></div>' : ''}
        </div>${showAdvanced ? modal.createAdvancedOptionsHTML('tv') : ''}`;
        // The newest details: a backfill started from older ones renders these (a newer guard verdict).
        let latestDetails: TvDetailsView = tvDetails;
        // Server options that failed to load: the request goes without them, to Seerr's default server.
        let optionsFailed = false;
        const instance = modal.create({
            title: is4k ? `${JE.t('jellyseerr_modal_title')} - 4K` : JE.t('jellyseerr_modal_title'),
            subtitle: resolvedShowTitle,
            bodyHtml,
            backdropPath: tvDetails.backdropPath,
            buttonText: is4k ? (JE.t('jellyseerr_btn_request_4k') || 'Request in 4K') : undefined,
            onClose: stopPolling,
            onSave: async (modalEl, requestBtn, closeFn) => {
                if (!origin.current()) { closeFn(); return; }
                requestBtn.disabled = true;
                requestBtn.innerHTML = `${JE.t('jellyseerr_modal_requesting')}<span class="jellyseerr-button-spinner"></span>`;
                const restore = () => { requestBtn.disabled = false; requestBtn.textContent = resetLabel(); };
                // The match is mandatory without a TVDB id: Seerr would accept the request and Sonarr drop it.
                let manualTvdbId = tvDetails.externalTvdbId ? null : storedTvdbId;
                if (needsTvdbMatch) {
                    manualTvdbId = readManualTvdbId(modalEl);
                    if (!manualTvdbId) {
                        JE.toast?.(JE.t('jellyseerr_modal_toast_tvdb_required'), 4000);
                        restore();
                        const input = modalEl.querySelector('#jellyseerr-tvdb-id');
                        if (input instanceof HTMLElement) input.focus();
                        return;
                    }
                }
                let settings = {};
                if (showAdvanced && !optionsFailed) {
                    const value = (id: string) => { const el = modalEl.querySelector(`#${id}`); return el instanceof HTMLSelectElement ? el.value : ''; };
                    const server = value('tv-server');
                    const quality = value('tv-quality');
                    const folder = value('tv-folder');
                    if (!server || !quality || !folder) {
                        JE.toast?.(JE.t('jellyseerr_modal_toast_options_missing'), 3000);
                        restore();
                        return;
                    }
                    settings = { serverId: parseInt(server, 10), profileId: parseInt(quality, 10), rootFolder: folder, tags: [] };
                }
                try {
                    if (partialRequestsEnabled) {
                        const selected = Array.from(modalEl.querySelectorAll<HTMLInputElement>('.jellyseerr-season-item .jellyseerr-season-checkbox:checked:not(:disabled)'))
                            .map(checkbox => parseInt(checkbox.dataset.seasonNumber || '', 10));
                        if (selected.length === 0) {
                            JE.toast?.(JE.t('jellyseerr_modal_toast_select_season'), 3000);
                            requestBtn.disabled = false;
                            requestBtn.textContent = is4k ? (JE.t('jellyseerr_btn_request_4k') || 'Request in 4K') : JE.t('jellyseerr_modal_request_selected');
                            return;
                        }
                        await api.requestTvSeasons(tmdbId, [...new Set(selected)], settings, searchResultItem, is4k, manualTvdbId);
                        if (!origin.current()) { closeFn(); return; }
                        JE.toast?.(JE.t('jellyseerr_modal_toast_request_success', { count: new Set(selected).size, title: escapeHtml(resolvedShowTitle) }), 4000);
                    } else {
                        // Whole show: every regular season, so Specials are never locked.
                        const all = tvDetails.seasons.map(s => s.seasonNumber).filter(n => Number.isFinite(n) && n > 0);
                        if (all.length > 0) await api.requestTvSeasons(tmdbId, all, settings, searchResultItem, is4k, manualTvdbId);
                        else await api.requestMedia(tmdbId, 'tv', settings, is4k, searchResultItem, manualTvdbId);
                        if (!origin.current()) { closeFn(); return; }
                        JE.toast?.(JE.t('jellyseerr_modal_toast_request_success', { count: 'all', title: escapeHtml(resolvedShowTitle) }), 4000);
                    }
                    host.document.dispatchEvent(new CustomEvent('jellyseerr-tv-requested', { detail: { tmdbId, mediaType: 'tv', is4k } }));
                    host.document.dispatchEvent(new CustomEvent('jellyseerr-media-requested', { detail: { tmdbId, mediaType: 'tv', is4k } }));
                    internals.markCardRequested?.(String(tmdbId), 'tv', is4k);
                    closeFn();
                    const query = hashQuery(window.location);
                    window.setTimeout(() => {
                        if (query && origin.current()) void JE.jellyseerr?.fetchAndRenderResults(query, { skipCache: true });
                    }, 1000);
                } catch (error) {
                    if (!origin.current() || classifyFailure(error, true) === 'not-sent') { closeFn(); return; }
                    await internals.handleRequestError?.(error, 'tv', requestBtn, resetLabel());
                }
            }
        });
        const seasonList = instance.modalElement.querySelector('.jellyseerr-season-list');
        updateSeasonList(seasonList, tvDetails, partialRequestsEnabled, enableSpecialEpisodes, is4k, jellyfinSeasonMap);
        instance.show();
        if (needsTvdbMatch) void populateTvdbMatches(instance.modalElement, tmdbId);
        const body = instance.modalElement.querySelector('.jellyseerr-modal-body');
        if (body) {
            api.fetchUserQuota().then(quota => {
                const chip = internals.buildQuotaChip?.(quota, 'tv') ?? null;
                if (chip && document.body.contains(instance.modalElement)) body.insertBefore(chip, body.firstChild);
            }).catch(error => console.warn(`${LOG_UI} Quota chip render failed:`, error));
        }

        // Air dates found once, applied on every render (including refreshes).
        const airDateCache = new Map<number, string>();
        // Names of started seasons on a protected title, which only their own responses can prove.
        const seasonNameCache = new Map<number, string>();
        const applyBackfill = (details: TvDetailsView): TvDetailsView => ({
            ...details,
            seasons: details.seasons.map(s => ({
                ...s,
                airDate: s.airDate || airDateCache.get(s.seasonNumber) || null,
                // Only while protected: without a guard the details carry the real name.
                name: (details.jeSpoilerGuard && seasonNameCache.get(s.seasonNumber)) || s.name || null
            }))
        });
        const render = (details: TvDetailsView) => {
            // A modal closed meanwhile is not rendered into.
            if (!origin.current() || !seasonList?.isConnected) return;
            updateSeasonList(seasonList, applyBackfill(details), partialRequestsEnabled, enableSpecialEpisodes, is4k, jellyfinSeasonMap);
        };
        const followUp = api.followUpOptions(rawDetails);
        const needingDates = tvDetails.seasons.filter(s => (s.episodeCount ?? 0) > 0
            && ((!s.airDate && !s.jeYear) || (tvDetails.jeSpoilerGuard && s.seasonNumber > 1)));
        if (needingDates.length > 0) {
            // First episode air dates per season (Seerr/TheTVDB has them), TMDB as a fallback for gaps.
            const seasonFetches = needingDates.map(season => api.fetchTvSeasonDetails(tmdbId, season.seasonNumber, followUp).then(detail => {
                const first = isRecord(detail) && Array.isArray(detail.episodes) ? detail.episodes[0] : undefined;
                // Only the year is shown, which is what Spoiler Guard leaves of a date.
                const date = isRecord(first) ? (isValidDate(first.airDate) ? first.airDate : isString(first.jeYear) ? first.jeYear : null) : null;
                if (date) airDateCache.set(season.seasonNumber, date);
                if (tvDetails.jeSpoilerGuard && isRecord(detail) && isString(detail.name) && detail.name) seasonNameCache.set(season.seasonNumber, detail.name);
            }).catch(() => undefined));
            const tmdbFetch = JE.pluginConfig?.TmdbEnabled
                ? api.fetchTmdbTvDetails(tmdbId, followUp).then(tmdb => {
                    if (!isRecord(tmdb) || !Array.isArray(tmdb.seasons)) return;
                    for (const s of tmdb.seasons) {
                        if (!isRecord(s) || !isNumber(s.season_number)) continue;
                        const date = isValidDate(s.air_date) ? s.air_date : isString(s.jeYear) ? s.jeYear : null;
                        if (date && !airDateCache.has(s.season_number)) airDateCache.set(s.season_number, date);
                    }
                }).catch(() => undefined)
                : Promise.resolve();
            void Promise.all([...seasonFetches, tmdbFetch]).then(() => render(latestDetails));
        }
        if (singleSeasonOnly && seasonList) {
            seasonList.addEventListener('change', event => {
                const target = event.target;
                if (!(target instanceof HTMLInputElement) || !target.classList.contains('jellyseerr-season-checkbox') || !target.checked) return;
                for (const box of seasonList.querySelectorAll<HTMLInputElement>('.jellyseerr-season-checkbox:checked')) if (box !== target) box.checked = false;
            });
        }
        let updateSelectAllState: (() => void) | null = null;
        const selectAll = instance.modalElement.querySelector('#jellyseerr-select-all-seasons');
        if (partialRequestsEnabled && seasonList && selectAll instanceof HTMLInputElement) {
            // Regular seasons only: Select All never ticks Specials.
            const regular = '.jellyseerr-season-item:not([data-season-number="0"]) .jellyseerr-season-checkbox:not(:disabled)';
            const update = () => {
                const all = seasonList.querySelectorAll(regular).length;
                const checked = seasonList.querySelectorAll(`${regular}:checked`).length;
                selectAll.checked = checked > 0 && checked === all;
                selectAll.indeterminate = checked > 0 && checked < all;
            };
            selectAll.addEventListener('change', () => { for (const box of seasonList.querySelectorAll<HTMLInputElement>(regular)) box.checked = selectAll.checked; });
            seasonList.addEventListener('change', event => {
                const target = event.target;
                if (target instanceof HTMLElement && target.classList.contains('jellyseerr-season-checkbox') && target.id !== 'jellyseerr-select-all-seasons') update();
            });
            update();
            updateSelectAllState = update;
        }
        // Refresh while open. Uncached as well: an answer from before a guard would undo the protected one.
        refreshModalInterval = window.setInterval(async () => {
            if (!origin.current()) {
                // Another account now: this modal's view and request are no longer its to show.
                stopPolling();
                instance.close?.();
                return;
            }
            const fresh = decodeTvDetails(await api.fetchTvShowDetails(tmdbId, { skipCache: true }));
            if (!fresh || !origin.current()) return;
            latestDetails = fresh;
            render(fresh);
            updateSelectAllState?.();
        }, 10000);
        if (showAdvanced) {
            try {
                const data = await api.fetchAdvancedRequestData('tv');
                if (origin.current()) modal.populateAdvancedOptions(instance.modalElement, data, 'tv', is4k);
            } catch (error) {
                optionsFailed = true;
                console.error(`${LOG_UI} Failed to load TV advanced options:`, error);
                JE.toast?.(JE.t('jellyseerr_err_load_server_options'), 3000);
            }
        }
    }

    ui.showSeasonSelectionModal = showSeasonSelectionModal;
    internals.updateSeasonList = updateSeasonList;
}
