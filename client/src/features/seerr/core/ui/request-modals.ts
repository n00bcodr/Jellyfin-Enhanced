import type { SeerrCoreHost } from '../../host-core';
import type { SeerrUiFacade } from '../contract';
import { decodeCollectionParts, isRecord, isSafeTmdbImagePath, isString } from '../decode';
import { MEDIA } from '../status';
import {
    LOG_UI, captureOrigin, classifyFailure, escapeWith, firstInstall, groupInternals, hashQuery, translated
} from '../runtime';
import { ICONS } from './icon-markup';

const select = (root: ParentNode, id: string): HTMLSelectElement | null => {
    const element = root.querySelector(`#${id}`);
    return element instanceof HTMLSelectElement ? element : null;
};
/** The advanced options a modal submits, or null when one of them is unset. */
function chosenSettings(root: ParentNode, prefix: string): { serverId: number; profileId: number; rootFolder: string; tags: number[] } | null {
    const server = select(root, `${prefix}-server`)?.value;
    const quality = select(root, `${prefix}-quality`)?.value;
    const folder = select(root, `${prefix}-folder`)?.value;
    if (!server || !quality || !folder) return null;
    return { serverId: parseInt(server, 10), profileId: parseInt(quality, 10), rootFolder: folder, tags: [] };
}

/** The advanced movie request modal and the collection request modal. */
export function installRequestModals(host: SeerrCoreHost): void {
    const { JE, document, window } = host;
    if (!firstInstall(JE, 'ui-request-modals')) return;
    const ui: Partial<SeerrUiFacade> = JE.jellyseerrUI ||= {};
    const internals = groupInternals(JE);
    const escapeHtml = escapeWith(JE);
    const icons = () => internals.icons ?? ICONS;
    const posterNotFound = () => JE.cdn?.url?.('ibb', 'fdbkXQdP/jellyseerr-poster-not-found.png') ?? '';

    /** The page's card buttons for a requested movie show "Requested". */
    function showMovieRequested(tmdbId: number | string): void {
        const id = String(tmdbId);
        if (!/^\d+$/.test(id)) return;
        for (const button of document.querySelectorAll<HTMLButtonElement>(`.jellyseerr-request-button[data-tmdb-id="${id}"]`)) {
            if (button.dataset.mediaType && button.dataset.mediaType !== 'movie') continue;
            button.innerHTML = `<span>${JE.t('jellyseerr_btn_requested')}</span>${icons().requested}`;
            button.classList.remove('jellyseerr-button-request');
            button.classList.add('jellyseerr-button-pending');
        }
    }
    function addQuotaChip(modalElement: HTMLElement, mediaType: 'movie' | 'tv'): void {
        const body = modalElement.querySelector('.jellyseerr-modal-body');
        const api = JE.jellyseerrAPI;
        if (!body || !api) return;
        api.fetchUserQuota().then(quota => {
            const chip = internals.buildQuotaChip?.(quota, mediaType) ?? null;
            if (chip && document.body.contains(modalElement)) body.insertBefore(chip, body.firstChild);
        }).catch(error => console.warn(`${LOG_UI} Quota chip render failed:`, error));
    }

    async function showMovieRequestModal(tmdbId: number | string, title: string, searchResultItem: unknown, is4k = false): Promise<void> {
        const modal = JE.jellyseerrModal;
        const api = JE.jellyseerrAPI;
        if (!modal || !api) return;
        // The account the options were loaded for is the one that may submit them.
        const origin = captureOrigin(host);
        const backdropPath = isRecord(searchResultItem) && isString(searchResultItem.backdropPath) ? searchResultItem.backdropPath : null;
        // Server options that failed to load: the request goes without them, to Seerr's default server.
        let optionsFailed = false;
        const { modalElement, show } = modal.create({
            title: JE.t('jellyseerr_modal_title_movie'),
            subtitle: title,
            bodyHtml: modal.createAdvancedOptionsHTML('movie'),
            backdropPath,
            onSave: async (modalEl, requestBtn, closeFn) => {
                const settings = optionsFailed ? {} : chosenSettings(modalEl, 'movie');
                if (!settings) {
                    JE.toast?.(JE.t('jellyseerr_modal_toast_options_missing'), 3000);
                    return;
                }
                if (!origin.current()) { closeFn(); return; }
                requestBtn.disabled = true;
                requestBtn.innerHTML = `${JE.t('jellyseerr_modal_requesting')}<span class="jellyseerr-button-spinner"></span>`;
                try {
                    await api.requestMedia(tmdbId, 'movie', settings, is4k, searchResultItem);
                    if (!origin.current()) { closeFn(); return; }
                    showMovieRequested(tmdbId);
                    closeFn();
                } catch (error) {
                    if (!origin.current() || classifyFailure(error, true) === 'not-sent') { closeFn(); return; }
                    await internals.handleRequestError?.(error, 'movie', requestBtn, JE.t('jellyseerr_modal_request'));
                }
            }
        });
        show();
        addQuotaChip(modalElement, 'movie');
        try {
            const data = await api.fetchAdvancedRequestData('movie');
            if (origin.current()) modal.populateAdvancedOptions(modalElement, data, 'movie', is4k);
        } catch (error) {
            optionsFailed = true;
            console.error(`${LOG_UI} Failed to load advanced options:`, error);
            JE.toast?.(JE.t('jellyseerr_err_load_server_options'), 3000);
        }
    }

    /** Requests the chosen movies of a TMDB collection, one at a time, stopping at the quota. */
    async function showCollectionRequestModal(collectionId: number | string, collectionName: string, searchResultItem: unknown = null): Promise<void> {
        const modal = JE.jellyseerrModal;
        const api = JE.jellyseerrAPI;
        if (!modal || !api) return;
        const origin = captureOrigin(host);
        let details: unknown;
        try {
            details = await api.fetchCollectionDetails(collectionId);
        } catch {
            details = null;
        }
        if (!origin.current()) return;
        // null is a failed lookup; a collection without movies is a different message.
        if (!isRecord(details)) {
            JE.toast?.(JE.t('jellyseerr_toast_collection_fetch_failed'), 4000);
            return;
        }
        const parts = decodeCollectionParts(details);
        if (parts.length === 0) {
            JE.toast?.(JE.t('jellyseerr_toast_no_movies_in_collection'), 4000);
            return;
        }
        const showAdvanced = api.shouldShowAdvanced();
        const label = (key: string, fallback: string) => JE.t(key) || fallback;
        const rows = parts.map(movie => {
            const status = movie.mediaInfo?.status || MEDIA.UNKNOWN;
            const hasActiveDownloads = (movie.mediaInfo?.downloadStatus?.length ?? 0) > 0;
            const isDisabled = status === MEDIA.AVAILABLE || status === MEDIA.PENDING || status === MEDIA.PROCESSING;
            let statusClass = 'not-requested';
            let statusText = label('jellyseerr_season_status_not_requested', 'Not Requested');
            if (status === MEDIA.AVAILABLE) {
                statusClass = 'available';
                statusText = label('jellyseerr_btn_available', 'Available');
            } else if (status === MEDIA.PARTIALLY_AVAILABLE) {
                statusClass = 'partially-available';
                statusText = label('jellyseerr_btn_partially_available', 'Partially Available');
            } else if (status === MEDIA.PROCESSING) {
                statusClass = hasActiveDownloads ? 'processing' : 'pending';
                statusText = hasActiveDownloads ? label('jellyseerr_btn_processing', 'Processing') : label('jellyseerr_btn_requested', 'Requested');
            } else if (status === MEDIA.PENDING) {
                statusClass = 'pending';
                statusText = label('jellyseerr_btn_pending', 'Pending');
            }
            const year = movie.releaseDate ? new Date(movie.releaseDate).getFullYear() : NaN;
            const poster = isSafeTmdbImagePath(movie.posterPath) ? `https://image.tmdb.org/t/p/w92${movie.posterPath}` : posterNotFound();
            return `
                <div class="jellyseerr-collection-movie-row">
                    <input type="checkbox"
                           class="jellyseerr-collection-checkbox"
                           id="movie-${escapeHtml(movie.id)}"
                           data-tmdb-id="${escapeHtml(movie.id)}"
                           ${isDisabled ? 'disabled' : 'checked'}>
                    <img src="${escapeHtml(poster)}" alt="${escapeHtml(movie.title ?? '')}" class="jellyseerr-collection-movie-poster">
                    <div class="jellyseerr-collection-movie-details">
                        <div class="title">${escapeHtml(movie.title ?? '')}</div>
                        <div class="year">${escapeHtml(Number.isNaN(year) ? '' : year)}</div>
                    </div>
                    <div class="jellyseerr-season-status jellyseerr-season-status-${escapeHtml(statusClass)}">${escapeHtml(statusText)}</div>
                </div>
            `;
        }).join('');
        const bodyHtml = `
            <div class="jellyseerr-collection-list" style="max-height: 600px; overflow-y: auto;">
                <div class="jellyseerr-collection-header-row">
                    <input type="checkbox" class="jellyseerr-collection-checkbox" id="jellyseerr-select-all-movies">
                    <label class="jellyseerr-collection-header-label" for="jellyseerr-select-all-movies">${label('jellyseerr_select_all_movies', 'Select All')}</label>
                    <div></div>
                    <div></div>
                </div>
                ${rows}
            </div>
            ${showAdvanced ? modal.createAdvancedOptionsHTML('movie') : ''}
        `;
        const buttonText = label('jellyseerr_modal_request_selected_movies', 'Request Selected Movies');
        // Server options that failed to load: the requests go without them, to Seerr's default server.
        let optionsFailed = false;
        const backdrop = isString(details.backdrop_path) && details.backdrop_path ? details.backdrop_path
            : isString(details.backdropPath) ? details.backdropPath : null;
        const instance = modal.create({
            title: label('jellyseerr_modal_request_collection', 'Request Collection'),
            subtitle: collectionName,
            bodyHtml,
            backdropPath: backdrop,
            buttonText,
            onSave: async (modalEl, requestBtn, closeFn) => {
                const restore = () => { requestBtn.disabled = false; requestBtn.textContent = buttonText; };
                if (!origin.current()) { closeFn(); return; }
                requestBtn.disabled = true;
                requestBtn.innerHTML = `${label('jellyseerr_modal_requesting', 'Requesting')}<span class="jellyseerr-button-spinner"></span>`;
                let settings = {};
                if (showAdvanced && !optionsFailed) {
                    const chosen = chosenSettings(modalEl, 'movie');
                    if (!chosen) {
                        JE.toast?.(label('jellyseerr_modal_toast_options_missing', 'Please select all options'), 3000);
                        restore();
                        return;
                    }
                    settings = chosen;
                }
                try {
                    // One request per distinct movie, in list order.
                    const selected = [...new Set(Array.from(modalEl.querySelectorAll<HTMLInputElement>('.jellyseerr-collection-movie-row .jellyseerr-collection-checkbox:checked:not(:disabled)'))
                        .map(checkbox => parseInt(checkbox.dataset.tmdbId || '', 10)).filter(id => Number.isInteger(id) && id > 0))];
                    if (selected.length === 0) {
                        JE.toast?.(label('jellyseerr_modal_toast_select_movie', 'Please select at least one movie'), 3000);
                        restore();
                        return;
                    }
                    let successCount = 0;
                    let failures = 0;
                    let uncertain = 0;
                    let quotaHitError: unknown = null;
                    for (const id of selected) {
                        // The account changed mid-batch: the rest is not sent.
                        if (!origin.current()) break;
                        try {
                            await api.requestMedia(id, 'movie', settings, false, searchResultItem);
                            successCount++;
                        } catch (error) {
                            // Once the quota is hit every remaining request fails too.
                            if (ui.isQuotaError?.(error)) { quotaHitError = error; break; }
                            const kind = classifyFailure(error, true);
                            if (kind === 'not-sent' && !origin.current()) break;
                            if (kind === 'uncertain') uncertain++;
                            else failures++;
                            console.error(`Failed to request movie ${id}:`, error);
                        }
                    }
                    if (!origin.current()) { closeFn(); return; }
                    let toastText = `${label('jellyseerr_toast_collection_requested', 'Requested')} ${successCount} of ${selected.length} ${label('jellyseerr_toast_movies', 'movies')}`;
                    if (failures > 0) toastText += ' ' + JE.t('jellyseerr_toast_collection_failed_count', { count: failures });
                    if (uncertain > 0) {
                        toastText += ' ' + translated(JE, 'jellyseerr_toast_collection_uncertain_count', `${uncertain} with unknown status (check Seerr before requesting again)`, { count: uncertain });
                    }
                    JE.toast?.(toastText, 4000);
                    if (quotaHitError) await ui.showQuotaErrorDialog?.(quotaHitError, 'movie');
                    closeFn();
                    const query = hashQuery(window.location);
                    window.setTimeout(() => {
                        if (query && origin.current()) void JE.jellyseerr?.fetchAndRenderResults(query);
                    }, 1000);
                } catch {
                    JE.toast?.(label('jellyseerr_modal_toast_request_fail', 'Request failed'), 4000);
                    restore();
                }
            }
        });
        if (showAdvanced) {
            try {
                const data = await api.fetchAdvancedRequestData('movie');
                modal.populateAdvancedOptions(instance.modalElement, data, 'movie', false);
            } catch (error) {
                optionsFailed = true;
                console.error('Failed to load advanced options:', error);
                JE.toast?.(JE.t('jellyseerr_err_load_server_options'), 3000);
            }
        }
        if (!origin.current()) return;
        instance.show();
        const selectAll = instance.modalElement.querySelector('#jellyseerr-select-all-movies');
        const list = instance.modalElement.querySelector('.jellyseerr-collection-list');
        if (!(selectAll instanceof HTMLInputElement) || !list) return;
        const rowBoxes = (checked: boolean) => list.querySelectorAll<HTMLInputElement>(`.jellyseerr-collection-movie-row .jellyseerr-collection-checkbox:not(:disabled)${checked ? ':checked' : ''}`);
        const updateSelectAllState = () => {
            const all = rowBoxes(false).length;
            const checked = rowBoxes(true).length;
            selectAll.checked = checked > 0 && checked === all;
            selectAll.indeterminate = checked > 0 && checked < all;
        };
        selectAll.addEventListener('change', () => { for (const box of rowBoxes(false)) box.checked = selectAll.checked; });
        list.addEventListener('change', event => {
            const target = event.target;
            if (target instanceof HTMLElement && target.classList.contains('jellyseerr-collection-checkbox') && target.id !== 'jellyseerr-select-all-movies') updateSelectAllState();
        });
        updateSelectAllState();
    }

    ui.showMovieRequestModal = showMovieRequestModal;
    ui.showCollectionRequestModal = showCollectionRequestModal;
}
