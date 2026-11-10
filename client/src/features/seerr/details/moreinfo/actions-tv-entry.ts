import { bridge, escaper, moreInfoRegistry, translator, type ActionContext } from '../../host-details';
import { idText, record } from '../domain/json';
import { anyTitle, mediaState, tmdbIdOf } from '../domain/media';
import { attachFourKPopup, silent, splitButton } from './four-k-popup';
import { detachedContext } from './scope';

const JE = bridge();
const internal = moreInfoRegistry(JE);
const t = translator(JE);
const escapeHtml = escaper(JE);
const DOWNLOAD_ICON = '<span class="material-icons">download</span>';
const requestIcon = (): string => JE.jellyseerrUI?.icons?.request || DOWNLOAD_ICON;

/** Every TV request goes through the season picker, for the normal or the 4K version. */
function openSeasonPicker(details: unknown, context: ActionContext, is4k?: boolean): void {
    if (!context.current()) return;
    const media = record(details) ?? {};
    const show = JE.jellyseerrUI?.showSeasonSelectionModal;
    if (!show) return;
    const id = tmdbIdOf(media);
    if (is4k === undefined) show(id, 'tv', anyTitle(media), details);
    else show(id, 'tv', anyTitle(media), details, is4k);
}

function plainButton(labelText: string, details: unknown, context: ActionContext, is4k?: boolean): HTMLButtonElement {
    const button = document.createElement('button');
    button.className = 'jellyseerr-request-button jellyseerr-button-request';
    button.innerHTML = `${requestIcon()}<span>${escapeHtml(labelText)}</span>`;
    button.addEventListener('click', event => {
        silent(event);
        openSeasonPicker(details, context, is4k);
    });
    return button;
}

function row(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'je-more-info-actions-row';
    return container;
}

/** The request control of a show with nothing requested yet. */
function buildTvActions(details: unknown, show4k = false, context: ActionContext = detachedContext()): HTMLElement | null {
    const media = record(details) ?? {};
    const state = mediaState(media);
    const seerrStatus = JE.seerrStatus;
    // Seerr reporting Available with no Jellyfin id means the library was wiped: requestable again.
    if (!seerrStatus?.isRequestable(seerrStatus.effectiveMediaStatus(state.status, state.jellyfinId))) return null;

    const container = row();
    const requestLabel = t('jellyseerr_btn_request');
    if (!show4k) {
        container.appendChild(plainButton(requestLabel, details, context));
        return container;
    }
    const { group, main, arrow } = splitButton(escapeHtml(requestLabel), requestIcon(), idText(media.id) ?? '', 'tv', t('jellyseerr_btn_request_4k', 'Request in 4K'));
    main.addEventListener('click', event => {
        silent(event);
        openSeasonPicker(details, context, false);
    });
    attachFourKPopup(arrow, context, (option, close) => {
        const display = seerrStatus.resolveDisplayStatus(state.status4k, false);
        const { AVAILABLE, PENDING, PROCESSING, REQUESTED, BLOCKED } = seerrStatus.DISPLAY;
        if (display === AVAILABLE) {
            option.textContent = `4K ${t('jellyseerr_btn_available', 'Available')}`;
            option.disabled = true;
            option.classList.add('je-4k-available');
        } else if (display === PENDING || display === REQUESTED || display === PROCESSING) {
            option.textContent = `4K ${t('jellyseerr_btn_requested', 'Requested')}`;
            option.disabled = true;
            option.classList.add(display === PROCESSING ? 'je-4k-processing' : 'je-4k-pending');
        } else if (display === BLOCKED) {
            option.textContent = `4K ${t('jellyseerr_btn_blocklisted', 'Blocklisted')}`;
            option.disabled = true;
            option.classList.add('je-4k-blocklisted');
        } else {
            option.textContent = t('jellyseerr_btn_request_4k', 'Request in 4K');
            option.classList.add('je-4k-request');
            option.addEventListener('click', event => {
                silent(event);
                close();
                openSeasonPicker(details, context, true);
            });
        }
    });
    container.appendChild(group);
    return container;
}

function buildSingleTv4kButton(details: unknown, context: ActionContext = detachedContext()): HTMLElement {
    return plainButton(t('jellyseerr_btn_request_4k', 'Request in 4K'), details, context, true);
}

/** "Request More", for a show with some seasons already requested. */
function buildTvRequestMoreButton(details: unknown, show4k = false, canRequest4k = false, context: ActionContext = detachedContext()): HTMLElement {
    const container = row();
    const labelText = t('jellyseerr_btn_request_more', 'Request More');
    if (!show4k) {
        container.appendChild(plainButton(labelText, details, context));
        return container;
    }
    const { group, main, arrow } = splitButton(escapeHtml(labelText), requestIcon(), idText(record(details)?.id) ?? '', 'tv', t('jellyseerr_btn_request_4k', 'Request in 4K'), false);
    main.addEventListener('click', event => {
        silent(event);
        openSeasonPicker(details, context, false);
    });
    attachFourKPopup(arrow, context, (option, close) => {
        option.textContent = t('jellyseerr_btn_request_4k', 'Request in 4K');
        if (!canRequest4k) {
            option.disabled = true;
            option.textContent = `4K ${t('jellyseerr_btn_requested', 'Requested')}`;
            option.classList.add('je-4k-pending');
            return;
        }
        option.classList.add('je-4k-request');
        option.addEventListener('click', event => {
            silent(event);
            close();
            openSeasonPicker(details, context, true);
        });
    });
    container.appendChild(group);
    return container;
}

internal.buildTvActions = buildTvActions;
internal.buildSingleTv4kButton = buildSingleTv4kButton;
internal.buildTvRequestMoreButton = buildTvRequestMoreButton;
