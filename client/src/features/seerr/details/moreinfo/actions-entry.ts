import { bridge, escaper, identityLease, moreInfoRegistry, SEERR_LOG, seerrDetailsContext, sibling, translator, type ActionContext, type MediaType, type MoreInfoModalElement } from '../../host-details';
import { idText, isRecord, num, record, type JsonRecord } from '../domain/json';
import { anyTitle, mediaState, ownMediaInfo, requesters, tmdbIdOf, type MediaState } from '../domain/media';
import { attachFourKPopup, silent, splitButton } from './four-k-popup';
import { createModalScope, detachedContext, isLive } from './scope';

const JE = bridge();
const internal = moreInfoRegistry(JE);
const { state } = internal;
const logPrefix = `${SEERR_LOG} Jellyseerr More Info:`;
const escapeHtml = escaper(JE);
const t = translator(JE);
const DOWNLOAD_ICON = '<span class="material-icons">download</span>';
const requestIcon = (): string => JE.jellyseerrUI?.icons?.request || DOWNLOAD_ICON;
const FOUR_K_LABEL = 'Request in 4K';

/** How a movie request control shows its progress. */
interface RequestView { busy(): void; idle(): void; failed(message: string): void; done?(): void }

function errorMessage(error: unknown): string {
    const message = record(record(error)?.responseJSON)?.message;
    return typeof message === 'string' && message ? message : t('jellyseerr_btn_error');
}

/** Sends a movie request. Whatever it reports goes only to a modal still showing that title. */
async function requestMovie(details: JsonRecord, is4k: boolean, context: ActionContext, view: RequestView): Promise<void> {
    const api = JE.jellyseerrAPI;
    if (!context.current() || !api) return;
    const id = tmdbIdOf(details);
    if (api.shouldShowAdvanced()) {
        JE.jellyseerrUI?.showMovieRequestModal?.(id, anyTitle(details), details, is4k);
        return;
    }
    view.busy();
    const sameAccount = identityLease(JE);
    const scope = context.scope;
    if (scope) scope.requests++;
    try {
        const response = await api.requestMedia(id, 'movie', {}, is4k, details);
        if (!sameAccount()) return;
        mountRequestedChip(details, 'movie', is4k, response, context);
        view.done?.();
    } catch (error) {
        if (!sameAccount()) return;
        // Quota errors get a themed dialog, and the control goes back to idle.
        if (JE.jellyseerrUI?.isQuotaError?.(error)) {
            await JE.jellyseerrUI.showQuotaErrorDialog?.(error, 'movie');
            if (context.current()) view.idle();
            return;
        }
        if (context.current()) view.failed(errorMessage(error));
    } finally {
        if (scope) scope.requests--;
    }
}

function requestButtonView(button: HTMLButtonElement, idleHtml: () => string, failureSuffix: () => string): RequestView {
    return {
        busy() {
            button.disabled = true;
            button.innerHTML = `<span>${escapeHtml(t('jellyseerr_btn_requesting'))}</span><span class="jellyseerr-button-spinner"></span>`;
        },
        idle() {
            button.disabled = false;
            button.innerHTML = idleHtml();
        },
        failed(message) {
            button.disabled = false;
            // An API message is untrusted text.
            button.innerHTML = `<span>${escapeHtml(message)}</span>${failureSuffix()}`;
            button.classList.add('jellyseerr-button-error');
        },
    };
}

function movieRequestButton(details: JsonRecord, label: string, is4k: boolean, context: ActionContext, failureSuffix: () => string, existing?: HTMLButtonElement): HTMLButtonElement {
    const button = existing ?? document.createElement('button');
    const idleHtml = () => `${requestIcon()}<span>${escapeHtml(label)}</span>`;
    if (!existing) {
        button.className = 'jellyseerr-request-button jellyseerr-button-request';
        button.innerHTML = idleHtml();
    }
    button.addEventListener('click', event => {
        silent(event);
        void requestMovie(details, is4k, context, requestButtonView(button, idleHtml, failureSuffix));
    });
    return button;
}

function buildSingle4kButton(rawDetails: unknown, context: ActionContext = detachedContext()): HTMLElement {
    return movieRequestButton(record(rawDetails) ?? {}, t('jellyseerr_btn_request_4k', FOUR_K_LABEL), true, context, () => '');
}

function fillMovie4kOption(option: HTMLButtonElement, details: JsonRecord, status4k: number, context: ActionContext, close: () => void): void {
    const seerrStatus = JE.seerrStatus;
    if (!seerrStatus) return;
    const display = seerrStatus.resolveDisplayStatus(status4k, false);
    const { AVAILABLE, PENDING, PROCESSING, REQUESTED, BLOCKED } = seerrStatus.DISPLAY;
    option.textContent = FOUR_K_LABEL;
    if (display === AVAILABLE) {
        option.disabled = true;
        option.classList.add('je-4k-available');
    } else if (display === PENDING || display === REQUESTED || display === PROCESSING) {
        option.disabled = true;
        option.classList.add(display === PROCESSING ? 'je-4k-processing' : 'je-4k-pending');
    } else if (display === BLOCKED) {
        option.disabled = true;
        option.classList.add('je-4k-blocklisted');
    } else {
        option.classList.add('je-4k-request');
        const view: RequestView = {
            busy() {
                option.disabled = true;
                option.textContent = t('jellyseerr_btn_requesting');
            },
            idle() {
                option.disabled = false;
                option.textContent = FOUR_K_LABEL;
            },
            failed(message) {
                option.disabled = false;
                option.textContent = message;
            },
            done: close,
        };
        option.addEventListener('click', event => {
            silent(event);
            if (JE.jellyseerrAPI?.shouldShowAdvanced()) close();
            void requestMovie(details, true, context, view);
        });
    }
}

/** The request control of a requestable movie, split when 4K requests are on. */
function buildMovieActions(rawDetails: unknown, _actionMount: Element | null, _chipMount: Element | null, show4k: boolean, context: ActionContext = detachedContext()): HTMLElement | null {
    const details = record(rawDetails) ?? {};
    const media = mediaState(details);
    const seerrStatus = JE.seerrStatus;
    // A stale Available (no library item left) is requestable again, as for TV.
    if (!seerrStatus?.isRequestable(seerrStatus.effectiveMediaStatus(media.status, media.jellyfinId))) return null;

    const container = document.createElement('div');
    container.className = 'je-more-info-actions-row';
    const failureIcon = () => JE.jellyseerrUI?.icons?.error ?? '';
    const label = t('jellyseerr_btn_request');
    if (!show4k) {
        container.appendChild(movieRequestButton(details, label, false, context, failureIcon));
        return container;
    }
    const { group, main, arrow } = splitButton(escapeHtml(label), requestIcon(), idText(details.id) ?? '', 'movie', FOUR_K_LABEL);
    movieRequestButton(details, label, false, context, failureIcon, main);
    attachFourKPopup(arrow, context, (option, close) => fillMovie4kOption(option, details, media.status4k, context, close));
    container.appendChild(group);
    return container;
}

/** Records a request on the title and redraws its modal. */
function mountRequestedChip(rawDetails: unknown, mediaType: MediaType, is4k: boolean, response: unknown = null, context: ActionContext = detachedContext()): void {
    const details = record(rawDetails);
    if (!details) return;
    const info = ownMediaInfo(details);
    const media = record(record(response)?.media);
    if (is4k) info.status4k = num(media?.status4k) || 3;
    else info.status = num(media?.status) || 3;
    document.dispatchEvent(new CustomEvent('jellyseerr-media-requested', { detail: { tmdbId: details.id, mediaType, is4k: !!is4k } }));
    if (context.live()) renderActions(details, mediaType, context.modal ?? undefined);
}

let quotaRenderToken = 0;

async function maybeRenderMoreInfoQuotaChip(mount: HTMLElement | null, mediaType: MediaType, context: ActionContext = detachedContext()): Promise<void> {
    if (!mount) return;
    const token = String(++quotaRenderToken);
    mount.dataset.quotaRenderToken = token;
    try {
        const quota = await JE.jellyseerrAPI?.fetchUserQuota?.();
        if (!mount.isConnected || !context.current() || mount.dataset.quotaRenderToken !== token) return;
        const chip = JE.jellyseerrUI?.buildQuotaChip?.(quota, mediaType === 'tv' ? 'tv' : 'movie');
        if (chip instanceof Element) {
            chip.classList.add('je-more-info-quota-chip');
            mount.insertBefore(chip, mount.firstChild);
        }
    } catch (error) {
        console.warn(`${logPrefix} quota chip render failed:`, error);
    }
}

/**
 * The proxy needs the signed-in user, which an <img> cannot send. Kept relative: the
 * avatar loader fetches this exact form with credentials and adds the server base path.
 */
function requesterAvatar(avatar: string | null): string | null {
    if (!avatar) return null;
    return avatar.startsWith('/') ? `/JellyfinEnhanced/proxy/avatar?path=${encodeURIComponent(avatar)}` : avatar;
}

function renderRequestedBy(mount: Element | null, info: unknown): void {
    if (!mount) return;
    const entries = requesters(info);
    if (entries.length === 0) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'je-requested-by-row';
    const label = document.createElement('span');
    label.className = 'je-requested-by-label';
    label.textContent = t('jellyseerr_modal_requested_by', 'Requested by');
    wrapper.appendChild(label);
    for (const entry of entries) {
        const item = document.createElement('span');
        item.className = 'je-requested-by-item';
        const source = requesterAvatar(entry.avatar);
        if (source) {
            const image = document.createElement('img');
            image.className = 'je-request-avatar';
            image.setAttribute('data-avatar-src', source);
            image.alt = '';
            image.loading = 'lazy';
            image.style.display = 'none';
            image.addEventListener('error', () => { image.style.display = 'none'; });
            item.appendChild(image);
        }
        const name = document.createElement('span');
        name.className = 'je-requested-by-name';
        name.textContent = entry.label;
        item.appendChild(name);
        wrapper.appendChild(item);
    }
    mount.appendChild(wrapper);
    JE.helpers?.hydrateAvatarImages?.(mount);
}

function renderChips(mount: Element | null, media: MediaState, isMovie: boolean): void {
    const seerrStatus = JE.seerrStatus;
    if (!mount || !seerrStatus) return;
    const chip = (is4k: boolean) => sibling(internal, 'buildStatusChip')(media.status, media.status4k, isMovie, media.downloads, media.downloads4k, media.jellyfinId, media.jellyfinId4k, is4k);
    const normal = seerrStatus.hasStatus(media.status);
    if (normal) mount.appendChild(chip(false));
    if (seerrStatus.hasStatus(media.status4k)) {
        const chip4k = chip(true);
        if (normal) chip4k.style.marginLeft = '0.5em';
        mount.appendChild(chip4k);
    }
}

/** Each modal's latest render; a new one takes over its mounts and everything it opened. */
const renders = new WeakMap<MoreInfoModalElement, { dispose(): void }>();

function beginRender(modal: MoreInfoModalElement): ActionContext {
    const previous = renders.get(modal);
    previous?.dispose();
    const render = createModalScope();
    renders.set(modal, render);
    const scope = modal._scope ?? null;
    if (!previous) scope?.onDispose(() => renders.get(modal)?.dispose());
    const sameAccount = identityLease(JE);
    const live = () => isLive(state, modal) && sameAccount();
    return {
        live, current: () => live() && !render.signal.aborted,
        signal: render.signal, onDispose: render.onDispose, scope, modal,
    };
}

function renderMovieActions(details: JsonRecord, media: MediaState, mount: HTMLElement | null, context: ActionContext): void {
    const seerrStatus = JE.seerrStatus;
    if (!seerrStatus) return;
    const show4k = !!JE.pluginConfig?.JellyseerrEnable4KRequests;
    const canRequest = seerrStatus.isRequestable(seerrStatus.effectiveMediaStatus(media.status, media.jellyfinId));
    const canRequest4k = seerrStatus.isRequestable(seerrStatus.effectiveMediaStatus(media.status4k, media.jellyfinId4k));
    if (!canRequest) {
        if (show4k && canRequest4k && mount) {
            mount.appendChild(buildSingle4kButton(details, context));
            void maybeRenderMoreInfoQuotaChip(mount, 'movie', context);
        }
        return;
    }
    const actions = buildMovieActions(details, mount, null, show4k, context);
    if (actions && mount) mount.appendChild(actions);
    void maybeRenderMoreInfoQuotaChip(mount, 'movie', context);
}

function renderTvActions(details: JsonRecord, media: MediaState, mount: HTMLElement | null, context: ActionContext): void {
    const seerrStatus = JE.seerrStatus;
    if (!seerrStatus) return;
    const show4k = !!JE.pluginConfig?.JellyseerrEnable4KTvRequests;
    const effective = seerrStatus.effectiveMediaStatus(media.status, media.jellyfinId);
    const effective4k = seerrStatus.effectiveMediaStatus(media.status4k, media.jellyfinId4k);
    const canRequest4k = seerrStatus.isRequestable(effective4k);
    const append = (actions: HTMLElement | null) => {
        if (actions && mount) mount.appendChild(actions);
        void maybeRenderMoreInfoQuotaChip(mount, 'tv', context);
    };
    if (seerrStatus.isRequestable(effective)) {
        append(sibling(internal, 'buildTvActions')(details, show4k, context));
        return;
    }
    if (!seerrStatus.hasStatus(media.status) && !seerrStatus.hasStatus(media.status4k)) {
        append(sibling(internal, 'buildTvActions')(details, false, context));
        return;
    }
    const deleted = seerrStatus.MEDIA.DELETED;
    if ((effective === deleted || effective4k === deleted) && mount) {
        append(sibling(internal, 'buildTvRequestMoreButton')(details, show4k, canRequest4k, context));
        return;
    }
    void sibling(internal, 'checkForUnrequestedSeasons')(details, context.signal).then(unrequested => {
        if (!context.current() || !mount) return;
        if (unrequested) append(sibling(internal, 'buildTvRequestMoreButton')(details, show4k, canRequest4k, context));
        else if (show4k && canRequest4k) append(sibling(internal, 'buildSingleTv4kButton')(details, context));
    });
}

/** Draws a modal's status chips, downloads and actions from its own title's data. */
function renderActions(rawDetails: unknown, mediaType: MediaType, modal: MoreInfoModalElement | null = state.currentModal): void {
    if (!isLive(state, modal) || !modal || !isRecord(rawDetails)) return;
    const mountOf = (name: string) => modal.querySelector<HTMLElement>(`[data-mount="${name}"]`);
    const actions = mountOf('je-actions');
    const chips = mountOf('je-status-chip');
    const downloads = mountOf('je-downloads');
    const secondary = mountOf('je-secondary-actions');
    const requestedBy = mountOf('je-requested-by');
    for (const mount of [actions, chips, downloads, secondary, requestedBy]) if (mount) mount.innerHTML = '';

    const context = beginRender(modal);
    renderRequestedBy(requestedBy, rawDetails.mediaInfo);
    seerrDetailsContext(JE).peer('spoilerBlur')?.appendSeerrToggle?.(secondary, rawDetails, mediaType);

    const media = mediaState(rawDetails);
    renderChips(chips, media, mediaType === 'movie');
    const bars = sibling(internal, 'buildDownloadBars')(media.downloads, media.downloads4k);
    if (bars && downloads) downloads.appendChild(bars);
    if (mediaType === 'movie') renderMovieActions(rawDetails, media, actions, context);
    else renderTvActions(rawDetails, media, actions, context);
}

internal.buildSingle4kButton = buildSingle4kButton;
internal.buildMovieActions = buildMovieActions;
internal.mountRequestedChip = mountRequestedChip;
internal.maybeRenderMoreInfoQuotaChip = maybeRenderMoreInfoQuotaChip;
internal.renderActions = renderActions;
