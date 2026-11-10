import type { SeerrCoreHost } from '../../host-core';
import type { SeasonAnalysis, SeerrUiFacade } from '../contract';
import { isMediaItem } from '../decode';
import { analyzeSeasonStatuses, hasDownloads } from '../display';
import { DISPLAY, MEDIA, getButtonConfig, resolveDisplayStatus } from '../status';
import type { SeerrMediaItem } from '../types';
import {
    bindViewOrigin, isViewCurrent, captureOrigin, classifyFailure, errorBody, escapeWith, firstInstall, groupInternals, uncertainMessage
} from '../runtime';
import { ICONS } from './icon-markup';

const ARROW_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M12.53 16.28a.75.75 0 01-1.06 0l-7.5-7.5a.75.75 0 011.06-1.06L12 14.69l6.97-6.97a.75.75 0 111.06 1.06l-7.5 7.5z" clip-rule="evenodd" /></svg>';

/** Request-button configuration for movie, TV and collection cards. */
export function installButtons(host: SeerrCoreHost): void {
    const { JE, document } = host;
    if (!firstInstall(JE, 'ui-buttons')) return;
    const ui: Partial<SeerrUiFacade> = JE.jellyseerrUI ||= {};
    const internals = groupInternals(JE);
    const state = internals.state;
    const escapeHtml = escapeWith(JE);
    const icons = () => internals.icons ?? ICONS;
    // The live submission handler of each button: a reconfigured button drops the old one,
    // so one click cannot submit twice or with stale media, and a late answer is ignored.
    const requestHandlers = new WeakMap<HTMLButtonElement, (event: MouseEvent) => Promise<void>>();

    function configureRequestButton(button: HTMLButtonElement, value: unknown, isJellyseerrActive: boolean, jellyseerrUserFound: boolean): void {
        const previous = requestHandlers.get(button);
        if (previous) {
            button.removeEventListener('click', previous);
            requestHandlers.delete(button);
        }
        internals.clearDownloadProgressHover?.(button);
        if (!isJellyseerrActive) {
            button.innerHTML = `<span>${JE.t('jellyseerr_btn_offline')}</span>${icons().cloud_off}`;
            button.disabled = true;
            button.classList.add('jellyseerr-button-offline');
            return;
        }
        if (!jellyseerrUserFound) {
            button.innerHTML = `<span>${JE.t('jellyseerr_btn_user_not_found')}</span>${icons().person_off}`;
            button.disabled = true;
            button.classList.add('jellyseerr-button-no-user');
            return;
        }
        if (!isMediaItem(value)) {
            // Not a result this button can request: an error state, never a request.
            button.innerHTML = `<span>${JE.t('jellyseerr_btn_error')}</span>${icons().error}`;
            button.disabled = true;
            return;
        }
        const item = value;
        if (item.mediaType === 'collection') {
            configureCollectionButton(button, item);
        } else if (item.mediaType === 'tv') {
            button.dataset.searchResultItem = JSON.stringify(item);
            button.classList.add('jellyseerr-button-tv');
            if (item.mediaInfo) button.dataset.mediaInfo = JSON.stringify(item.mediaInfo);
            const analysis = item.mediaInfo?.seasons ? analyzeSeasonStatuses(item.mediaInfo.seasons, JE.t) : null;
            const overall = analysis ? analysis.overallStatus : (item.mediaInfo ? item.mediaInfo.status : 1);
            configureTvShowButton(button, overall, analysis, item);
        } else {
            configureMovieButton(button, item);
        }
    }

    function configureCollectionButton(button: HTMLButtonElement, item: SeerrMediaItem): void {
        bindViewOrigin(host, button);
        button.dataset.searchResultItem = JSON.stringify(item);
        button.dataset.mediaType = 'collection';
        button.dataset.collectionId = String(item.id);
        button.innerHTML = `${icons().request}<span>${JE.t('jellyseerr_modal_request_collection')}</span>`;
        button.className = 'jellyseerr-request-button jellyseerr-button-request jellyseerr-button-collection';
        button.disabled = false;
    }

    /** The 4K arrow's state from the item's 4K status. */
    function decorateArrow(arrow: HTMLButtonElement, item: SeerrMediaItem): void {
        const display4k = resolveDisplayStatus(item.mediaInfo ? item.mediaInfo.status4k : 1, false);
        if (display4k === DISPLAY.AVAILABLE) {
            arrow.disabled = true;
            arrow.classList.add('jellyseerr-split-arrow-disabled', 'jellyseerr-4k-available');
            arrow.title = '4K Available';
        } else if (display4k === DISPLAY.PENDING || display4k === DISPLAY.REQUESTED || display4k === DISPLAY.PROCESSING) {
            arrow.classList.add('jellyseerr-4k-pending');
            arrow.title = '4K Requested';
        } else {
            arrow.title = JE.t('jellyseerr_btn_request_4k');
        }
    }
    function arrowButton(item: SeerrMediaItem, group: HTMLElement): HTMLButtonElement {
        const arrow = document.createElement('button');
        bindViewOrigin(host, arrow);
        arrow.className = 'jellyseerr-split-arrow';
        arrow.innerHTML = ARROW_SVG;
        arrow.dataset.tmdbId = String(item.id);
        arrow.dataset.toggle4k = 'true';
        decorateArrow(arrow, item);
        arrow.addEventListener('click', event => {
            event.stopPropagation();
            if (!isViewCurrent(host, arrow)) return;
            if (state.active4KPopup && state.active4KPopup.parentElement === group) internals.hide4KPopup?.();
            else internals.show4KPopup?.(group, item);
        });
        return arrow;
    }

    function configureTvShowButton(button: HTMLButtonElement, overallStatus: number | null | undefined, seasonAnalysis: SeasonAnalysis | null, item: SeerrMediaItem): void {
        bindViewOrigin(host, button);
        const setButton = (text: string, icon: string, className: string, disabled = false, summary: string | null | undefined = seasonAnalysis?.statusSummary) => {
            button.innerHTML = `${icon || ''}<span>${text}</span>`;
            if (summary) button.innerHTML += `<div class="jellyseerr-season-summary">${summary}</div>`;
            button.disabled = disabled;
            button.className = `jellyseerr-request-button jellyseerr-button-tv ${className}`;
        };
        const total = seasonAnalysis?.total ?? 0;
        switch (overallStatus) {
            case MEDIA.PENDING: setButton(JE.t('jellyseerr_btn_pending'), icons().pending, 'jellyseerr-button-pending'); break;
            case MEDIA.PROCESSING: setButton(JE.t('jellyseerr_btn_request'), icons().request, 'jellyseerr-button-request'); break;
            case MEDIA.DELETED:
                setButton(JE.t((seasonAnalysis?.availableCount ?? 0) > 0 ? 'jellyseerr_btn_request_more' : 'jellyseerr_btn_request'), icons().request, 'jellyseerr-button-request');
                break;
            case MEDIA.PARTIALLY_AVAILABLE:
                setButton(JE.t('jellyseerr_btn_request_missing'), icons().request, 'jellyseerr-button-partially-available');
                if (hasDownloads(item)) internals.addDownloadProgressHover?.(button, item);
                break;
            case MEDIA.AVAILABLE:
                setButton(JE.t('jellyseerr_btn_available'), icons().available, 'jellyseerr-button-available', true,
                    total > 1 ? JE.t('jellyseerr_all_seasons', { count: total }) : null);
                break;
            case MEDIA.BLOCKED: setButton(JE.t('jellyseerr_btn_blocklisted'), icons().cancel, 'jellyseerr-button-blocklisted', true); break;
            default:
                setButton(JE.t('jellyseerr_btn_request'), icons().request, 'jellyseerr-button-request', false,
                    total > 1 ? JE.t('jellyseerr_seasons_available', { count: total }) : null);
        }
        if (JE.pluginConfig?.JellyseerrEnable4KTvRequests && !button.closest('.jellyseerr-button-group')) {
            const group = document.createElement('div');
            group.className = 'jellyseerr-button-group';
            const main = button.cloneNode(true);
            if (!(main instanceof HTMLButtonElement)) return;
            bindViewOrigin(host, main);
            main.classList.add('jellyseerr-split-main');
            main.dataset.tmdbId = String(item.id);
            main.dataset.mediaType = 'tv';
            main.dataset.searchResultItem = JSON.stringify(item);
            group.appendChild(main);
            group.appendChild(arrowButton(item, group));
            button.replaceWith(group);
        }
    }

    const idleRequestHtml = () => `${icons().request}<span>${JE.t('jellyseerr_btn_request')}</span>`;
    /** The message for a definite rejection, as the card has always shown it. */
    function rejectionMessage(error: unknown, kind: ReturnType<typeof classifyFailure>): string {
        if (kind === 'user-not-found') return JE.t('jellyseerr_btn_user_not_found');
        const { code, message } = errorBody(error);
        if (kind === 'permission') {
            return JE.t(code ? `jellyseerr_err_${code}` : 'jellyseerr_err_no_request_permission') || JE.t('jellyseerr_err_no_request_permission');
        }
        if (kind === 'uncertain') return uncertainMessage(JE);
        return message || JE.t('jellyseerr_btn_error');
    }
    /**
     * One movie submission from a card button. The account it started under
     * owns the answer: a late answer for another account, or for a button that
     * has been reconfigured since, changes nothing on screen.
     */
    function movieRequestHandler(target: HTMLButtonElement, item: SeerrMediaItem, preventDefault: boolean): (event: MouseEvent) => Promise<void> {
        const handler = async (event: MouseEvent) => {
            if (preventDefault) event.preventDefault();
            event.stopPropagation();
            const api = JE.jellyseerrAPI;
            if (!api || !isViewCurrent(host, target)) return;
            if (api.shouldShowAdvanced()) {
                void ui.showMovieRequestModal?.(item.id, item.title || item.name || '', item, false);
                return;
            }
            const origin = captureOrigin(host);
            target.disabled = true;
            target.innerHTML = `<span>${JE.t('jellyseerr_btn_requesting')}</span><span class="jellyseerr-button-spinner"></span>`;
            const live = () => requestHandlers.get(target) === handler;
            try {
                await api.requestMedia(item.id, 'movie', {}, false, item);
                if (!live()) return;
                if (!origin.current()) { target.disabled = false; target.innerHTML = idleRequestHtml(); return; }
                // The cached result itself records the request, so a rebuilt card shows it.
                if (!item.mediaInfo) item.mediaInfo = {};
                item.mediaInfo.status = MEDIA.PROCESSING;
                target.innerHTML = `<span>${JE.t('jellyseerr_btn_requested')}</span>${icons().requested}`;
                target.classList.remove('jellyseerr-button-request');
                target.classList.add('jellyseerr-button-pending');
            } catch (error) {
                if (!live()) return;
                target.disabled = false;
                if (!origin.current()) { target.innerHTML = idleRequestHtml(); return; }
                if (ui.isQuotaError?.(error)) {
                    await ui.showQuotaErrorDialog?.(error, 'movie');
                    if (!live()) return;
                    target.innerHTML = idleRequestHtml();
                    return;
                }
                const kind = classifyFailure(error, JE.pluginConfig?.JellyseerrShowQuotaInfo !== false);
                target.innerHTML = `<span>${escapeHtml(rejectionMessage(error, kind))}</span>${icons().error}`;
                target.classList.add('jellyseerr-button-error');
            }
        };
        return handler;
    }

    function configureMovieButton(button: HTMLButtonElement, item: SeerrMediaItem): void {
        bindViewOrigin(host, button);
        button.dataset.searchResultItem = JSON.stringify(item);
        const status = item.mediaInfo ? item.mediaInfo.status : 1;
        const downloads = hasDownloads(item);
        if (JE.pluginConfig?.JellyseerrEnable4KRequests && !button.closest('.jellyseerr-button-group')) {
            const group = document.createElement('div');
            group.className = 'jellyseerr-button-group';
            const config = getButtonConfig(resolveDisplayStatus(status, downloads));
            const main = document.createElement('button');
            bindViewOrigin(host, main);
            main.className = `jellyseerr-request-button jellyseerr-split-main ${config.cssClass}`;
            main.disabled = config.disabled;
            main.innerHTML = `${config.iconKey ? icons()[config.iconKey] : ''}<span>${JE.t(config.labelKey)}</span>${config.showSpinner ? '<span class="jellyseerr-button-spinner"></span>' : ''}`;
            main.dataset.tmdbId = String(item.id);
            main.dataset.mediaType = 'movie';
            main.dataset.searchResultItem = JSON.stringify(item);
            if (downloads && config.disabled) internals.addDownloadProgressHover?.(main, item);
            group.appendChild(main);
            group.appendChild(arrowButton(item, group));
            button.replaceWith(group);
            if (!config.disabled) {
                const handler = movieRequestHandler(main, item, false);
                requestHandlers.set(main, handler);
                main.addEventListener('click', handler);
            }
            return;
        }
        const config = getButtonConfig(resolveDisplayStatus(status, downloads));
        const icon = config.iconKey ? icons()[config.iconKey] : '';
        if (config.showSpinner) {
            button.innerHTML = `${icon}<span>${JE.t(config.labelKey)}</span><span class="jellyseerr-button-spinner"></span>`;
            button.disabled = true;
            button.className = `jellyseerr-request-button ${config.cssClass}`;
            if (downloads) internals.addDownloadProgressHover?.(button, item);
        } else {
            button.innerHTML = `${icon}<span>${JE.t(config.labelKey)}</span>`;
            button.disabled = config.disabled;
            button.className = `jellyseerr-request-button ${config.cssClass}`;
        }
        if (!button.disabled && !button.closest('.jellyseerr-button-group')) {
            const handler = movieRequestHandler(button, item, true);
            requestHandlers.set(button, handler);
            button.addEventListener('click', handler);
        }
    }

    ui.configureRequestButton = configureRequestButton;
    internals.configureRequestButton = configureRequestButton;
    internals.configureCollectionButton = configureCollectionButton;
    internals.configureTvShowButton = configureTvShowButton;
    internals.configureMovieButton = configureMovieButton;
}
