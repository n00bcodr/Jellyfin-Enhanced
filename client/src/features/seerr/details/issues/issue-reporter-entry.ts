import { apiClient, bridge, escaper, identityLease, SEERR_LOG, translator, type MediaType, type SeerrDetailsBridge, type TmdbId } from '../../host-details';
import { filled, idText, list, record, records, str, type JsonRecord } from '../domain/json';
import { backdropSource, currentPosition, groupIssues, inferredSeasons, isResolved, isSeasonOrEpisode, isSpecial, issueDate, itemYear, matchFromImdbSearch, matchFromTitleSearch, personName, reportEpisodes, reportSeasons, seriesIdOf, tmdbIdFromExternalUrls, type ReportSeason } from './issue-model';
import { detailButtonContent, INDICATOR_CSS, reportFormHtml, tvControlsHtml, type IssueType } from './report-markup';

const JE = bridge();
const logPrefix = `${SEERR_LOG} Issue Reporter:`;
const escapeHtml = escaper(JE);
const t = translator(JE);
const label = (key: string, fallback = ''): string => escapeHtml(t(key, fallback));
const toast = (message: string, duration: number): void => JE.toast?.(message, duration);
const BUTTON_CONTAINERS = ['.detailButtons', '.itemActionsBottom', '[class*="ActionButtons"]', '.mainDetailButtons', '.detailButtonsContainer', '[class*="primaryActions"]', '.topBarSecondaryMenus + *'];
const UNAVAILABLE_REASONS: Readonly<Record<string, { aria: string; title: string; toast: string }>> = {
    'no-tmdb': { aria: 'TMDB ID not found', title: 'TMDB ID not found for this item', toast: 'TMDB ID not found for this item' },
    'no-jellyseerr': { aria: 'Jellyseerr unavailable', title: 'Jellyseerr is not available', toast: 'Jellyseerr is not available' },
    'no-both': { aria: 'Reporting services unavailable', title: 'TMDB ID not found and Jellyseerr is not available', toast: 'TMDB ID not found and Jellyseerr is not available' },
    'no-permissions': { aria: 'Not enough permissions', title: 'Not enough permissions to report', toast: 'You do not have permissions to report issues' },
};

export type ReportAvailability = 'available' | 'no-tmdb' | 'no-jellyseerr' | 'no-both';

/** Report dialogs open now; each belongs to the account that opened it. */
const openReports = new Set<() => void>();
JE.session?.onUserChange?.('issue-reporter', () => {
    for (const close of [...openReports]) close();
});

/** Seerr's four core issue types: video, audio, subtitles, other. */
function issueTypes(): IssueType[] {
    const icon = (name: keyof NonNullable<SeerrDetailsBridge['IconName']>): string => {
        const key = JE.IconName?.[name];
        return key ? JE.icon?.(key) ?? '' : '';
    };
    return [
        { value: '1', label: label('jellyseerr_report_issue_type_video'), icon: icon('VIDEO') },
        { value: '2', label: label('jellyseerr_report_issue_type_audio'), icon: icon('AUDIO') },
        { value: '3', label: label('jellyseerr_report_issue_type_subtitles'), icon: icon('SUBTITLES') },
        { value: '4', label: label('jellyseerr_report_issue_type_other'), icon: icon('QUESTION') },
    ];
}

function fetchItem(id: string, userId: string): Promise<unknown> {
    return JE.helpers?.getItemCached ? JE.helpers.getItemCached(id, { userId }) : apiClient().getItem(userId, id);
}

/**
 * The item Seerr knows the media by: it tracks TV by the series' TMDB id, while a Season
 * or Episode carries its own TMDB id, so those resolve to their series.
 */
async function getTmdbSourceItem(item: JsonRecord | null): Promise<JsonRecord | null> {
    if (!item || !isSeasonOrEpisode(item)) return item;
    const seriesId = seriesIdOf(item);
    const userId = apiClient().getCurrentUserId();
    if (!seriesId || !userId) return null;
    try {
        return record(await fetchItem(seriesId, userId));
    } catch (error) {
        console.debug(`${logPrefix} Could not load series ${seriesId} for ${str(item.Name)}:`, error);
        return null;
    }
}

function tmdbOf(item: JsonRecord | null): string | null {
    return idText(record(item?.ProviderIds)?.Tmdb);
}

/** Whether reporting can work; on error, assume so and let the report itself fail. */
async function checkReportingAvailability(item: unknown): Promise<ReportAvailability> {
    try {
        const client = apiClient();
        const status = await client.ajax({ type: 'GET', url: client.getUrl('/JellyfinEnhanced/jellyseerr/status'), dataType: 'json' });
        const active = record(status)?.active === true;
        const hasTmdb = !!tmdbOf(await getTmdbSourceItem(record(item)));
        if (!hasTmdb) return active ? 'no-tmdb' : 'no-both';
        return active ? 'available' : 'no-jellyseerr';
    } catch (error) {
        console.debug(`${logPrefix} Error checking reporting availability:`, error);
        return 'available';
    }
}

function setOptions(select: HTMLSelectElement, options: ReadonlyArray<{ value: number; label: string }>): void {
    select.innerHTML = '';
    for (const option of options) {
        const element = document.createElement('option');
        element.value = String(option.value);
        element.textContent = option.label;
        select.appendChild(element);
    }
}

/** The numbers of the season and episode selectors, or 0 for "all". */
function selectedNumber(modal: HTMLElement, selector: string): number {
    return parseInt(modal.querySelector<HTMLSelectElement>(selector)?.value ?? '', 10) || 0;
}

function issueCard(issue: JsonRecord, statusLabels: Readonly<Record<string, string>>): string {
    const createdBy = escapeHtml(personName(issue.createdBy) || 'Someone');
    const createdAt = issueDate(issue.createdAt);
    // The first comment is the description of an issue with no message of its own.
    const [first, ...rest] = records(issue.comments);
    const comments = rest.map(comment => {
        const who = escapeHtml(personName(comment.user));
        const when = issueDate(comment.createdAt);
        return `<div class="jellyseerr-issue-comment"><div class="jellyseerr-issue-comment-meta">${escapeHtml(when)}${who ? ` • ${who}` : ''}</div><div class="jellyseerr-issue-comment-body">${escapeHtml(str(comment.message) ?? '')}</div></div>`;
    }).join('');
    const message = escapeHtml(filled(issue.message) ?? filled(first?.message) ?? '(No description)');
    const resolved = isResolved(issue.status);
    const statusText = statusLabels[String(issue.status)] || (resolved ? 'Resolved' : 'Open');
    const suffix = resolved ? 'resolved' : 'open';
    const summary = `<span class="jellyseerr-pill pill-number-${suffix}">#${escapeHtml(idText(issue.id))}</span><span class="jellyseerr-pill pill-status-${suffix}">${escapeHtml(statusText)}</span>${createdAt ? ` <span class="jellyseerr-issue-date">${escapeHtml(createdAt)}</span>` : ''}`;
    return `
                                    <div class="jellyseerr-issue-card">
                                        <div class="jellyseerr-issue-summary">${summary}<span class="jellyseerr-issue-reporter"> — ${createdBy}</span></div>
                                        <div class="jellyseerr-issue-message">${message}</div>
                                        ${comments ? `<div class="jellyseerr-issue-comments">${comments}</div>` : ''}
                                    </div>
                                `;
}

function issueSections(issues: readonly JsonRecord[]): string {
    const typeLabels: Readonly<Record<string, string>> = {
        1: t('jellyseerr_report_issue_type_video', 'Video'), 2: t('jellyseerr_report_issue_type_audio', 'Audio'),
        3: t('jellyseerr_report_issue_type_subtitles', 'Subtitles'), 4: t('jellyseerr_report_issue_type_other', 'Other'),
    };
    const statusLabels = { 1: t('jellyseerr_issue_open', 'Open'), 2: t('jellyseerr_issue_resolved', 'Resolved') };
    return groupIssues(issues).map(group => `
                            <div class="jellyseerr-issue-section">
                                <div class="jellyseerr-issue-section-title">${escapeHtml(typeLabels[group.key] ?? 'Other')}</div>
                                ${group.issues.map(issue => issueCard(issue, statusLabels)).join('')}
                            </div>
                        `).join('');
}

/** Lists the title's existing issues in the dialog, if it is still open when they arrive. */
async function loadExistingIssues(modal: HTMLElement, tmdbId: TmdbId, mediaType: MediaType, open: () => boolean): Promise<void> {
    const body = modal.querySelector('#jellyseerr-issues-body');
    const empty = (message: string) => {
        if (body) body.innerHTML = `<div class="jellyseerr-issues-empty">${escapeHtml(message)}</div>`;
    };
    try {
        const api = JE.jellyseerrAPI;
        const reply = await api?.fetchIssuesForMedia(tmdbId, mediaType, { take: 50, filter: 'all' });
        if (!open()) return;
        const issues = records(record(reply)?.results);
        if (!issues.length) {
            empty(t('jellyseerr_no_issues_yet'));
            return;
        }
        // The list omits comments; a failed lookup keeps what the list had.
        const full = await Promise.all(issues.map(async issue => {
            try {
                return record(await api?.fetchIssueById(issue.id)) ?? issue;
            } catch {
                return issue;
            }
        }));
        if (open() && body) body.innerHTML = issueSections(full);
    } catch (error) {
        console.error(`${logPrefix} Failed to load existing issues:`, error);
        if (open()) empty(t('jellyseerr_load_issues_error'));
    }
}

/** The seasons Jellyfin has for this title, each with its episodes, read one season at a time. */
async function serverSeasons(item: JsonRecord | null, open: () => boolean): Promise<ReportSeason[]> {
    const seriesId = item?.Type === 'Series' ? filled(item.Id) : item && isSeasonOrEpisode(item) ? seriesIdOf(item) : null;
    if (!seriesId) return [];
    const client = apiClient();
    const query = (parentId: string, type: string, fields: string) => client.ajax({
        type: 'GET', dataType: 'json',
        url: client.getUrl('/Items', { ParentId: parentId, IncludeItemTypes: type, SortBy: 'IndexNumber', SortOrder: 'Ascending', Fields: fields, userId: client.getCurrentUserId() ?? '' }),
    });
    const seasons = reportSeasons(await query(seriesId, 'Season', 'IndexNumber,SeasonNumber'));
    for (const season of seasons) {
        if (!open()) return seasons;
        if (!season.id) continue;
        try {
            season.episodes = reportEpisodes(await query(season.id, 'Episode', 'IndexNumber,Name'));
        } catch (error) {
            console.debug(`${logPrefix} Failed to fetch episodes for season ${season.seasonNumber}:`, error);
        }
    }
    return seasons;
}

/** Adds the season and episode selectors of a TV title, preset to the page's own position. */
async function buildTvControls(modal: HTMLElement, item: JsonRecord | null, open: () => boolean): Promise<void> {
    const placeholder = modal.querySelector('#jellyseerr-tv-controls-placeholder');
    if (!placeholder) return;
    placeholder.innerHTML = tvControlsHtml(label('jellyseerr_report_issue_season'), label('jellyseerr_report_issue_episode'));
    const seasonSelect = modal.querySelector<HTMLSelectElement>('#issue-season');
    const episodeSelect = modal.querySelector<HTMLSelectElement>('#issue-episode');
    if (!seasonSelect || !episodeSelect) return;
    seasonSelect.disabled = true;
    episodeSelect.disabled = true;

    let seasons: ReportSeason[] = [];
    try {
        seasons = await serverSeasons(item, open);
    } catch (error) {
        console.debug(`${logPrefix} Error fetching seasons/episodes from Jellyfin:`, error);
    }
    if (!open()) return;
    if (seasons.length === 0) seasons = inferredSeasons(item);

    const allEpisodes = [{ value: 0, label: t('jellyseerr_select_all_episodes', 'All episodes') }];
    const allSeasons = { value: 0, label: t('jellyseerr_select_all_seasons', 'All seasons') };
    if (seasons.length === 0) {
        setOptions(seasonSelect, [allSeasons]);
        setOptions(episodeSelect, allEpisodes);
        return;
    }
    setOptions(seasonSelect, [
        ...(seasons.length > 1 ? [allSeasons] : []),
        ...seasons.map(season => ({ value: season.seasonNumber, label: `${t('jellyseerr_report_issue_season', 'Season')} ${season.seasonNumber}` })),
    ]);
    seasonSelect.disabled = false;

    const showAllEpisodes = () => {
        setOptions(episodeSelect, allEpisodes);
        episodeSelect.disabled = true;
    };
    const populateEpisodes = (seasonNumber: number) => {
        const season = seasons.find(entry => entry.seasonNumber === seasonNumber);
        if (!season) {
            showAllEpisodes();
            return;
        }
        setOptions(episodeSelect, [...allEpisodes, ...season.episodes.map(episode => ({
            value: episode.episodeNumber,
            label: `${t('jellyseerr_report_issue_episode', 'Episode')} ${episode.episodeNumber}${episode.title ? ` — ${episode.title}` : ''}`,
        }))]);
        episodeSelect.disabled = false;
    };

    // On a Season or Episode page the report is about that season or episode.
    const position = currentPosition(item);
    if (position.season) {
        const value = String(position.season);
        if (Array.from(seasonSelect.options).some(option => option.value === value)) seasonSelect.value = value;
        if (item?.Type === 'Season') seasonSelect.disabled = true;
        populateEpisodes(position.season);
        if (position.episode) {
            const episode = String(position.episode);
            if (Array.from(episodeSelect.options).some(option => option.value === episode)) episodeSelect.value = episode;
            if (item?.Type === 'Episode') {
                episodeSelect.disabled = true;
                seasonSelect.disabled = true;
            }
        }
    } else if (seasons.length > 1) {
        seasonSelect.value = '0';
        showAllEpisodes();
    } else {
        const only = seasons[0]?.seasonNumber ?? 0;
        seasonSelect.value = String(only);
        populateEpisodes(only);
    }

    seasonSelect.addEventListener('change', () => {
        const value = seasonSelect.value;
        if (!value || value === '0') showAllEpisodes();
        else populateEpisodes(parseInt(value, 10));
    });
}

function reportFailed(error: unknown): void {
    const failure = record(error);
    const status = failure?.status;
    const text = (filled(failure?.message) ?? String(error ?? '')).toLowerCase();
    if (status === 403) toast(t('jellyseerr_err_no_issue_permission'), 4000);
    else if (text.includes('jellyseerr') || text.includes('unavailable') || status === 503 || status === 0) toast('Jellyseerr is not available', 4000);
    else toast(t('jellyseerr_report_issue_error'), 4000);
}

/** Opens the report dialog for a title. `item` presets the selectors on a TV page. */
function showReportModal(tmdbId: TmdbId, itemName: string, mediaType: MediaType, backdropUrl: string | null = null, rawItem: unknown = null): void {
    const modalApi = JE.jellyseerrModal;
    const api = JE.jellyseerrAPI;
    if (!modalApi || !api) return;
    const item = record(rawItem);
    const sameAccount = identityLease(JE);
    let closed = false;
    const open = () => !closed && sameAccount();
    // Stops the report even from a dialog factory that offers no close.
    const leave = () => {
        closed = true;
        openReports.delete(leave);
        handle.close?.();
    };

    const handle = modalApi.create({
        title: t('jellyseerr_report_issue_title'),
        subtitle: itemName,
        bodyHtml: reportFormHtml(issueTypes(), {
            type: label('jellyseerr_report_issue_type_label'), message: label('jellyseerr_report_issue_message'),
            placeholder: label('jellyseerr_report_issue_message_placeholder'), existing: label('jellyseerr_existing_issues'), loading: label('jellyseerr_loading_issues'),
        }),
        backdropUrl,
        buttonText: t('jellyseerr_report_issue_submit'),
        onClose() {
            closed = true;
            openReports.delete(leave);
        },
        async onSave(modal, button, closeModal) {
            if (!open()) return;
            const issueType = modal.querySelector<HTMLInputElement>('input[name="issue-type"]:checked')?.value;
            const message = modal.querySelector<HTMLTextAreaElement>('#issue-message')?.value ?? '';
            // An episode preset on its own page is disabled, and still counts.
            const season = selectedNumber(modal, '#issue-season');
            const episode = selectedNumber(modal, '#issue-episode');
            if (!issueType) {
                toast('Issue Type is required', 3000);
                return;
            }
            try {
                button.disabled = true;
                button.textContent = t('jellyseerr_report_issue_submitting');
                const result = await api.reportIssue(tmdbId, mediaType, issueType, message, season, episode);
                if (!sameAccount()) return;
                if (!result) throw new Error('No response from API');
                toast(t('jellyseerr_report_issue_success'), 3000);
                console.log(`${logPrefix} Issue successfully reported for ${itemName}`);
                closeModal();
            } catch (error) {
                if (!sameAccount()) return;
                console.error(`${logPrefix} Error reporting issue:`, error);
                reportFailed(error);
                if (closed) return;
                button.disabled = false;
                button.textContent = t('jellyseerr_report_issue_submit');
            }
        },
    });
    openReports.add(leave);
    handle.show();

    void loadExistingIssues(handle.modalElement, tmdbId, mediaType, open);
    if (mediaType === 'tv') {
        buildTvControls(handle.modalElement, item, open).catch(error => console.debug(`${logPrefix} Error building tv controls:`, error));
    }
}

function createReportButton(container: Element | null, tmdbId: TmdbId, itemName: string, mediaType: MediaType, backdropUrl: string | null = null, item: unknown = null): HTMLButtonElement | null {
    if (!container) {
        console.warn(`${logPrefix} Container not found for report button`);
        return null;
    }
    const button = document.createElement('button');
    button.setAttribute('is', 'emby-button');
    button.className = 'button-flat detailButton emby-button jellyseerr-report-issue-icon';
    button.type = 'button';
    const title = t('jellyseerr_report_issue_button');
    button.setAttribute('aria-label', title);
    button.title = title;
    button.innerHTML = detailButtonContent('', ' warning');
    button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        showReportModal(tmdbId, itemName, mediaType, backdropUrl, item);
    });
    return button;
}

/**
 * The button shown when reporting is unavailable. It is marked disabled rather than
 * being `disabled`: a disabled button fires no click, and the click explains why.
 */
function createUnavailableButton(container: Element | null, _itemName: string, _mediaType: string, reason = 'unavailable'): HTMLButtonElement | null {
    if (!container) return null;
    const known = UNAVAILABLE_REASONS[reason];
    const button = document.createElement('button');
    button.setAttribute('is', 'emby-button');
    button.className = 'button-flat detailButton emby-button jellyseerr-report-unavailable-icon';
    button.type = 'button';
    button.setAttribute('aria-label', known?.aria ?? t('jellyseerr_report_unavailable_button'));
    button.title = known?.title ?? t('jellyseerr_report_unavailable_button');
    button.setAttribute('aria-disabled', 'true');
    button.style.opacity = '0.5';
    button.style.cursor = 'not-allowed';
    button.innerHTML = detailButtonContent('warning_off');
    button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        toast(known?.toast ?? t('jellyseerr_report_unavailable_toast'), 4000);
    });
    return button;
}

/** Finds a TMDB id from what else the item carries: external links, then a Seerr search. */
async function getTmdbIdFallback(itemName: string, mediaType: MediaType, rawItem: unknown): Promise<string | null> {
    try {
        const item = record(rawItem);
        if (!item) return null;
        console.debug(`${logPrefix} Attempting fallback TMDB lookup for ${itemName}`);
        const fromLinks = tmdbIdFromExternalUrls(item.ExternalUrls);
        if (fromLinks) return fromLinks;
        const search = JE.jellyseerrAPI?.search;
        if (typeof search !== 'function') return null;
        try {
            const imdbId = filled(record(item.ProviderIds)?.Imdb);
            if (imdbId) {
                console.debug(`${logPrefix} Trying Jellyseerr search by IMDB ID: ${imdbId}`);
                const match = matchFromImdbSearch(records(record(await search.call(JE.jellyseerrAPI, imdbId))?.results), mediaType);
                if (match) {
                    console.log(`${logPrefix} Found TMDB ID via Jellyseerr search (IMDB): ${match}`);
                    return match;
                }
            }
            const year = itemYear(item);
            const name = str(item.Name) ?? '';
            const query = `${name}${year ? ` ${year}` : ''}`;
            console.debug(`${logPrefix} Trying Jellyseerr search by title: "${query}"`);
            const match = matchFromTitleSearch(records(record(await search.call(JE.jellyseerrAPI, query))?.results), mediaType, name, year);
            if (match) console.log(`${logPrefix} Found TMDB ID via Jellyseerr search (title): ${match}`);
            return match;
        } catch (error) {
            console.debug(`${logPrefix} Jellyseerr search fallback failed:`, error);
            return null;
        }
    } catch (error) {
        console.debug(`${logPrefix} Fallback lookup failed:`, error);
        return null;
    }
}

/** Marks the button when the title has open issues, with a count. Off unless configured. */
async function applyIssueIndicator(button: HTMLElement, tmdbId: TmdbId, mediaType: MediaType): Promise<void> {
    if (!JE.pluginConfig?.JellyseerrShowIssueIndicator) return;
    const sameAccount = identityLease(JE);
    try {
        const reply = await JE.jellyseerrAPI?.fetchIssuesForMedia(tmdbId, mediaType, { take: 50, filter: 'open' });
        if (!button.isConnected || !sameAccount()) return;
        const count = list(record(reply)?.results).length;
        if (count === 0) return;
        if (!document.getElementById('je-issue-indicator-style')) {
            const style = document.createElement('style');
            style.id = 'je-issue-indicator-style';
            style.textContent = INDICATOR_CSS;
            document.head.appendChild(style);
        }
        button.classList.add('has-open-issues');
        const badge = document.createElement('span');
        badge.className = 'jellyseerr-issue-count-badge';
        badge.textContent = count > 9 ? '9+' : String(count);
        button.appendChild(badge);
        const tooltip = `${count} ${t('jellyseerr_issue_open', 'Open')} ${t('jellyseerr_existing_issues', 'Issues')} - ${t('jellyseerr_report_issue_button', 'Report issue')}`;
        button.title = tooltip;
        button.setAttribute('aria-label', tooltip);
    } catch (error) {
        console.debug(`${logPrefix} applyIssueIndicator failed:`, error);
    }
}

function findButtonContainer(page: Element): Element | null {
    for (const selector of BUTTON_CONTAINERS) {
        const found = page.querySelector(selector);
        if (found) return found;
    }
    const buttons = page.querySelectorAll('button');
    return buttons[buttons.length - 1]?.parentElement ?? null;
}

function placeButton(container: Element, button: HTMLElement): void {
    const more = container.querySelector('.btnMoreCommands');
    if (more) container.insertBefore(button, more);
    else container.appendChild(button);
}

function itemIdFromHash(): string | null {
    return new URLSearchParams(window.location.hash.split('?')[1]).get('id');
}

const hasButton = (page: Element): boolean => !!page.querySelector('.jellyseerr-report-issue-icon, .jellyseerr-report-unavailable-icon');

function backdropUrlOf(item: JsonRecord): string | null {
    const source = backdropSource(item);
    return source ? apiClient().getUrl(`Items/${source.itemId}/Images/Backdrop`, { tag: source.tag, quality: 40 }) : null;
}

/** The checks behind one report button, for one page and one item. */
async function addButton(page: Element, itemId: string, userId: string): Promise<boolean> {
    const sameAccount = identityLease(JE);
    // The page can have moved on, or another run can have finished, at every await.
    const stillWanted = () => sameAccount() && page.isConnected && !page.classList.contains('hide') && itemIdFromHash() === itemId && !hasButton(page);

    const item = record(await fetchItem(itemId, userId));
    if (!item) {
        console.debug(`${logPrefix} Could not fetch item data`);
        return false;
    }
    if (!stillWanted()) return false;

    // Gate on type first: a MusicVideo, Book or BoxSet can never be reported, so a status
    // round trip or a disabled button would be noise for a permanent limitation.
    const isTvLike = item.Type === 'Series' || item.Type === 'Season' || item.Type === 'Episode';
    if (!isTvLike && item.Type !== 'Movie') {
        console.debug(`${logPrefix} Skipping ${str(item.Name)}: unsupported item type (${str(item.Type)}) — not a Movie/Series/Season/Episode`);
        return false;
    }
    if (isSpecial(item)) {
        console.debug(`${logPrefix} Skipping ${str(item.Name)}: special (season 0)`);
        return false;
    }
    const mediaType: MediaType = isTvLike ? 'tv' : 'movie';

    const availability = await checkReportingAvailability(item);
    if (!stillWanted()) return false;
    // An item with no TMDB id is a permanent state, not a transient one: skip it silently
    // rather than clutter the page with a button that always says the same thing.
    if (availability === 'no-tmdb' || availability === 'no-both') {
        console.debug(`${logPrefix} Skipping ${str(item.Name)}: no TMDB ID available, nothing to report against`);
        return false;
    }
    if (availability !== 'available') {
        console.debug(`${logPrefix} Reporting not available: ${availability}`);
        const container = findButtonContainer(page);
        const unavailable = createUnavailableButton(container, '', '', availability);
        if (!container || !unavailable) return false;
        placeButton(container, unavailable);
        console.log(`${logPrefix} Added unavailable report button (${availability})`);
        return true;
    }

    // Season and Episode report against their series: the issue carries the numbers.
    const tmdbItem = await getTmdbSourceItem(item);
    if (!stillWanted()) return false;
    let tmdbId = tmdbOf(tmdbItem);
    console.debug(`${logPrefix} Checking item: ${str(item.Name)} (type=${str(item.Type)}, mediaType=${mediaType}, TMDB: ${tmdbId})`);
    if (!tmdbId) {
        tmdbId = tmdbItem ? await issueReporter.getTmdbIdFallback(str(tmdbItem.Name) ?? '', mediaType, tmdbItem) : null;
        if (!tmdbId) {
            console.debug(`${logPrefix} No TMDB ID could be resolved for ${str(item.Name)} (fallback also failed), skipping button`);
            return false;
        }
        console.log(`${logPrefix} Found TMDB ID via fallback: ${tmdbId}`);
        if (!stillWanted()) return false;
    }

    const container = findButtonContainer(page);
    if (!container) {
        console.debug(`${logPrefix} Could not find button container for ${str(item.Name)}`);
        return false;
    }
    const name = str(item.Name) ?? '';
    const button = createReportButton(container, tmdbId, name, mediaType, backdropUrlOf(item), item);
    if (!button) return false;
    placeButton(container, button);
    console.log(`${logPrefix} ✓ Report issue button added to ${name} (${mediaType}, TMDB: ${tmdbId})`);
    void applyIssueIndicator(button, tmdbId, mediaType);
    return true;
}

/** Runs in flight, by page: viewshow and the startup check can ask for the same button. */
const running = new WeakMap<Element, { itemId: string; run: Promise<boolean> }>();

/** Adds the report button to the shown details page, once. */
async function tryAddButton(): Promise<boolean> {
    const page = document.querySelector('#itemDetailPage:not(.hide)');
    if (!page) return false;
    if (!JE.pluginConfig?.JellyseerrEnabled || !JE.pluginConfig?.JellyseerrShowReportButton) {
        console.debug(`${logPrefix} Jellyseerr integration or report button disabled, skipping`);
        return false;
    }
    if (hasButton(page)) {
        console.debug(`${logPrefix} Report button already exists`);
        return true;
    }
    try {
        const itemId = itemIdFromHash();
        if (!itemId) {
            console.debug(`${logPrefix} No item ID in URL`);
            return false;
        }
        const userId = apiClient().getCurrentUserId();
        if (!userId) {
            console.debug(`${logPrefix} No user ID found`);
            return false;
        }
        const active = running.get(page);
        if (active?.itemId === itemId) return await active.run;
        const run = addButton(page, itemId, userId).finally(() => {
            if (running.get(page)?.run === run) running.delete(page);
        });
        running.set(page, { itemId, run });
        return await run;
    } catch (error) {
        console.warn(`${logPrefix} Error adding button:`, error);
        return false;
    }
}

let initialized = false;

/** Starts the reporter once Seerr answers as active. */
async function initialize(): Promise<void> {
    if (!JE.pluginConfig?.JellyseerrEnabled || !JE.pluginConfig?.JellyseerrShowReportButton) {
        console.debug(`${logPrefix} Jellyseerr integration or report-button feature disabled, skipping initialization`);
        return;
    }
    if (initialized) return;
    JE.jellyseerrUI?.addMainStyles?.();
    console.log(`${logPrefix} Initializing... (verifying Jellyseerr status)`);
    try {
        // The page-load bootstrap carries the cached probe (same body as the endpoint), once.
        const client = apiClient();
        const status = JE.takePrefetched?.('SeerrStatus') || await client.ajax({ type: 'GET', url: client.getUrl('/JellyfinEnhanced/jellyseerr/status'), dataType: 'json' });
        if (!record(status)?.active) {
            console.debug(`${logPrefix} Jellyseerr status check returned inactive, skipping reporter init`);
            return;
        }
    } catch (error) {
        console.warn(`${logPrefix} Failed to verify Jellyseerr status, skipping reporter init:`, error);
        return;
    }
    if (initialized) return;
    initialized = true;

    // A short delay lets Jellyfin finish building the view.
    const handleViewShow = () => {
        setTimeout(() => { void issueReporter.tryAddButton(); }, 100);
    };
    document.addEventListener('viewshow', handleViewShow);
    setTimeout(handleViewShow, 500);
    console.log(`${logPrefix} ✓ Initialized issue reporter with viewshow listener`);
}

const issueReporter = {
    checkReportingAvailability, showReportModal, createReportButton, createUnavailableButton, getTmdbIdFallback,
    applyIssueIndicator, tryAddButton, initialize,
};
JE.jellyseerrIssueReporter = issueReporter;
