import { bridge, moreInfoRegistry, SEERR_LOG, sibling, type MediaType, type ModalScope, type MoreInfoFacade, type MoreInfoModalElement, type TmdbId } from '../../host-details';
import { detailOf, isRecord, type JsonRecord } from '../domain/json';
import { ownMediaInfo, parseMediaType, replaceDetails, tmdbIdOf } from '../domain/media';
import { createModalScope, isLive } from './scope';

const JE = bridge();
const internal = moreInfoRegistry(JE);
const { state } = internal;
const logPrefix = `${SEERR_LOG} Jellyseerr More Info:`;
const moreInfoModal: MoreInfoFacade = JE.jellyseerrMoreInfo ?? (JE.jellyseerrMoreInfo = {});
const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
const DIALOG_OPEN_CLASS = 'jellyseerr-modal-is-open';
const EXIT_MS = 300;
const LOAD_FAILED = 'Failed to load media information';

let openGeneration = 0;
// Back (B on a TV controller) has to close the modal instead of leaving the page
// behind it, so an open modal owns one history entry that Back pops.
let historyEntryActive = false;
let popPending = false;
// Marks the history entry the modal pushed, so a dialog on top popping back to it is told apart from leaving it.
const HISTORY_KEY = 'jeMoreInfo';
let historyToken = '';

const dialogOpen = (): boolean => document.body.classList.contains(DIALOG_OPEN_CLASS);
/** The key of an event; a TV shell can send one that is not a KeyboardEvent. */
const keyOf = (event: Event): unknown => ('key' in event ? event.key : undefined);

/** Open the modal for a title. Each open supersedes the last; a stale answer is dropped. */
async function open(tmdbId: TmdbId, rawType: string): Promise<void> {
    const generation = ++openGeneration;
    const mediaType = parseMediaType(rawType);
    if (!mediaType) {
        console.warn(`${logPrefix} Unknown media type ${rawType} for TMDB ID ${tmdbId}`);
        sibling(internal, 'showError')(LOAD_FAILED);
        return;
    }
    try {
        const data = await sibling(internal, 'fetchMediaDetails')(tmdbId, mediaType);
        if (generation !== openGeneration) return;
        if (!isRecord(data)) {
            sibling(internal, 'showError')(LOAD_FAILED);
            return;
        }
        const modal = showModal(data, mediaType);

        // Seerr in TVDB mode sends seasons with no poster or date.
        if (mediaType === 'tv' && Array.isArray(data.seasons) && data.seasons.some(season => isRecord(season) && Number(season.episodeCount) > 0 && (!season.airDate || !season.posterPath))) {
            void sibling(internal, 'backfillSeasonMetadata')(tmdbId, data);
        }

        // Ratings arrive after the modal does and fill their own mounts.
        sibling(internal, 'fetchRatings')(tmdbId, mediaType, data, modal._scope?.signal)
            .then(ratings => {
                if (!isLive(state, modal)) return;
                if (String(modal.dataset.tmdbId) !== String(data.id) || modal.dataset.mediaType !== mediaType) return;
                data.ratings = ratings;
                const mount = modal.querySelector('[data-mount="ratings"]');
                if (mount) mount.innerHTML = sibling(internal, 'buildRatingLogos')(ratings, data, mediaType, tmdbId) || '';
                // The facts panel links to Rotten Tomatoes once its page is known.
                const facts = modal.querySelector('.je-more-info-media-facts');
                if (facts && ratings && internal.buildMediaFacts) facts.outerHTML = internal.buildMediaFacts(data, mediaType, tmdbId);
            })
            .catch(error => console.error(`${logPrefix} Failed to fetch ratings for TMDB ID ${tmdbId}:`, error));
    } catch (error) {
        if (generation !== openGeneration) return;
        console.error('Error opening more info modal:', error);
        sibling(internal, 'showError')(LOAD_FAILED);
    }
}

/** Re-read a title and redraw what can have changed since it was opened. */
async function refreshModalData(data: JsonRecord, mediaType: MediaType, modal: MoreInfoModalElement, button: HTMLButtonElement): Promise<void> {
    if (!isLive(state, modal)) return;
    const idle = () => {
        button.classList.remove('loading');
        button.disabled = false;
    };
    try {
        button.classList.add('loading');
        button.disabled = true;
        const fresh = await sibling(internal, 'fetchMediaDetails')(tmdbIdOf(data), mediaType);
        if (!isLive(state, modal)) return;
        if (!isRecord(fresh)) {
            sibling(internal, 'showError')('Failed to refresh media information');
            idle();
            return;
        }
        replaceDetails(data, fresh);
        sibling(internal, 'renderActions')(data, mediaType, modal);
        if (mediaType === 'tv') void sibling(internal, 'enrichSeasonCardsWithJellyfinLinks')(data, modal, { refresh: true });
        idle();
    } catch (error) {
        if (!isLive(state, modal)) return;
        console.error('Error refreshing modal data:', error);
        sibling(internal, 'showError')('Failed to refresh modal data');
        idle();
    }
}

function refreshAfterRequest(data: JsonRecord, mediaType: MediaType, modal: MoreInfoModalElement) {
    const markRequested = () => {
        const info = ownMediaInfo(data);
        info.status = info.status || 2;
    };
    return async (event: Event): Promise<void> => {
        const detail = detailOf(event);
        if (!detail?.tmdbId || String(detail.tmdbId) !== String(data.id)) return;
        if (mediaType === 'movie' && (detail.mediaType !== 'movie' || (modal._scope?.requests ?? 0) > 0)) return;
        try {
            // The latest status and progress.
            const fresh = await sibling(internal, 'fetchMediaDetails')(tmdbIdOf(data), mediaType);
            if (!isLive(state, modal)) return;
            if (isRecord(fresh) && fresh.mediaInfo) data.mediaInfo = fresh.mediaInfo;
            else markRequested();
        } catch {
            if (!isLive(state, modal)) return;
            markRequested();
        }
        sibling(internal, 'renderActions')(data, mediaType, modal);
        if (mediaType === 'tv') void sibling(internal, 'enrichSeasonCardsWithJellyfinLinks')(data, modal);
    };
}

function wireButtons(modal: MoreInfoModalElement, data: JsonRecord, mediaType: MediaType): void {
    modal.addEventListener('click', event => {
        if (event.target === modal || (event.target instanceof Element && event.target.classList.contains('modal-overlay'))) dismissModal();
    });
    const silent = (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
    };
    const refreshButton = modal.querySelector<HTMLButtonElement>('.modal-refresh');
    refreshButton?.addEventListener('click', event => {
        silent(event);
        void refreshModalData(data, mediaType, modal, refreshButton);
    });
    modal.querySelector('.modal-close')?.addEventListener('click', event => {
        silent(event);
        dismissModal();
    });
    const collectionButton = modal.querySelector<HTMLButtonElement>('.je-collection-card-button');
    collectionButton?.addEventListener('click', event => {
        silent(event);
        if (!isLive(state, modal)) return;
        const id = parseInt(collectionButton.dataset.collectionId ?? '', 10);
        const name = collectionButton.dataset.collectionName;
        if (id && name) JE.jellyseerrUI?.showCollectionRequestModal?.(id, name);
    });
}

/** Document listeners belong to the modal and leave with it. */
function listen(scope: ModalScope, type: string, listener: (event: Event) => void, capture = false): void {
    document.addEventListener(type, listener, capture);
    scope.onDispose(() => document.removeEventListener(type, listener, capture));
}

function showModal(data: JsonRecord, mediaType: MediaType): MoreInfoModalElement {
    // Replace the current modal without cancelling this open.
    closeCurrentModal();

    const modal: MoreInfoModalElement = document.createElement('div');
    const scope = createModalScope();
    modal._scope = scope;
    modal.className = 'je-more-info-modal';
    modal.innerHTML = sibling(internal, 'buildModalContent')(data, mediaType);
    // Tag the modal so asynchronous updates apply only to their own title.
    modal.dataset.tmdbId = String(data.id ?? '');
    modal.dataset.mediaType = mediaType;
    wireButtons(modal, data, mediaType);

    document.body.appendChild(modal);
    state.currentModal = modal;
    if (!historyEntryActive) {
        historyToken = `${Date.now()}:${openGeneration}`;
        history.pushState({ [HISTORY_KEY]: historyToken }, '', location.href);
        historyEntryActive = true;
    }

    listen(scope, 'keydown', event => {
        // A dialog on top owns Escape, and pops its own history entry.
        if (keyOf(event) === 'Escape' && !dialogOpen()) dismissModal();
    });
    // Capture phase, so Jellyfin's focus manager never sees the D-pad while the modal
    // is open; otherwise focus walks out to the page behind it.
    listen(scope, 'keydown', event => trapDirectionalFocus(event, modal), true);

    sibling(internal, 'renderActions')(data, mediaType, modal);
    if (mediaType === 'tv') void sibling(internal, 'enrichSeasonCardsWithJellyfinLinks')(data, modal);

    const onRequested = refreshAfterRequest(data, mediaType, modal);
    listen(scope, mediaType === 'tv' ? 'jellyseerr-tv-requested' : 'jellyseerr-media-requested', event => { void onRequested(event); });

    // The next task, so the transition starts from the attached state.
    setTimeout(() => {
        if (isLive(state, modal)) modal.classList.add('active');
    }, 10);
    if (JE.core?.ui?.isTvLayout?.()) {
        setTimeout(() => {
            if (!isLive(state, modal)) return;
            const first = modal.querySelector<HTMLElement>('.je-more-info-actions button:not([disabled])') ?? modal.querySelector<HTMLElement>('.modal-close');
            first?.focus();
        }, 60);
    }
    return modal;
}

/** Close from a user action. Going through history consumes the entry open pushed. */
function dismissModal(): void {
    if (!historyEntryActive) {
        close();
        return;
    }
    if (popPending) return;
    popPending = true;
    history.back();
}

const DIRECTIONS: Readonly<Record<string, 'up' | 'down' | 'left' | 'right'>> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

/** Keep D-pad and arrow navigation inside the modal. */
function trapDirectionalFocus(event: Event, modal: MoreInfoModalElement): void {
    const key = keyOf(event);
    const direction = typeof key === 'string' ? DIRECTIONS[key] : undefined;
    if (!direction || !isLive(state, modal)) return;
    // Another dialog (e.g. the season request modal) is on top and owns focus.
    if (dialogOpen()) return;
    const active = document.activeElement;
    if (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return;

    event.preventDefault();
    event.stopPropagation();

    const items = Array.from(modal.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(element => element.getClientRects().length > 0);
    if (!items.length) return;
    if (!active || !modal.contains(active)) {
        items[0]?.focus();
        return;
    }
    const from = active.getBoundingClientRect();
    const fromX = from.left + from.width / 2;
    const fromY = from.top + from.height / 2;
    let best: HTMLElement | null = null;
    let bestScore = Infinity;
    for (const element of items) {
        if (element === active) continue;
        const rect = element.getBoundingClientRect();
        const dx = rect.left + rect.width / 2 - fromX;
        const dy = rect.top + rect.height / 2 - fromY;
        const along = direction === 'up' ? -dy : direction === 'down' ? dy : direction === 'left' ? -dx : dx;
        if (along <= 1) continue;
        const across = direction === 'up' || direction === 'down' ? Math.abs(dx) : Math.abs(dy);
        const score = along + across * 2;
        if (score < bestScore) {
            bestScore = score;
            best = element;
        }
    }
    best?.focus();
}

function closeCurrentModal(): void {
    const closing = state.currentModal;
    if (!closing || closing._isClosing) return;
    closing._isClosing = true;
    closing._scope?.dispose();
    closing.classList.remove('active');
    // A replacement can open during the exit animation; remove only this modal.
    setTimeout(() => {
        closing.remove();
        if (state.currentModal === closing) state.currentModal = null;
        // Work held back while the modal covered the page (the seamless-scroll fill) resumes on this.
        document.dispatchEvent(new CustomEvent('jellyseerr-more-info-closed'));
    }, EXIT_MS);
}

function close(): void {
    openGeneration++;
    historyEntryActive = false;
    popPending = false;
    closeCurrentModal();
}

moreInfoModal.open = open;
moreInfoModal.close = close;

window.addEventListener('popstate', event => {
    if (!historyEntryActive) return;
    // A dialog stacked above the modal closes first and keeps this entry.
    if (dialogOpen()) return;
    // A closed dialog's own history.back() lands on this modal's entry: stay open.
    const landed: unknown = event.state;
    if (isRecord(landed) && landed[HISTORY_KEY] === historyToken) return;
    close();
});

// Request permissions and details belong to the active account: invalidate pending
// opens as soon as the identity changes, before any navigation arrives.
JE.session?.onUserChange?.('jellyseerr-more-info', close);

// Close on page navigation.
document.addEventListener('viewshow', close);

// Exposed for the Series page "Request More" button, so the check lives in one place.
if (internal.checkForUnrequestedSeasons) moreInfoModal.checkForUnrequestedSeasons = internal.checkForUnrequestedSeasons;
