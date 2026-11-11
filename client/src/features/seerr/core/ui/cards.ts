import { seerrCoreContext, type SeerrCoreHost } from '../../host-core';
import type { SeasonAnalysis, SeerrUiFacade } from '../contract';
import { isMediaItem, isSafeTmdbImagePath } from '../decode';
import { analyzeSeasonStatuses } from '../display';
import { MEDIA, effectiveMediaStatus } from '../status';
import type { SeerrMediaItem } from '../types';
import { LOG_UI, bindViewOrigin, isViewCurrent, escapeWith, firstInstall, groupInternals } from '../runtime';
import { ICONS } from './icon-markup';

interface BatchContext {
    seerrBase: string;
    useMoreInfoModal: boolean;
    moreInfoLoaded: boolean;
    availablePostersLinkToJellyfin: boolean;
    showProviderIcons: boolean;
    posterNotFoundUrl: string;
    seerrIconUrl: string;
    showHideButtons: boolean;
    hiddenLabel: string | null;
    unhideLabel: string | null;
    hideLabel: string | null;
    viewOnJellyseerrLabel(): string;
    mediaBadgeLabel(mediaType: string): string | undefined;
}
interface CardState {
    item: SeerrMediaItem;
    isJellyseerrActive: boolean;
    jellyseerrUserFound: boolean;
    ctx: BatchContext;
    useMoreInfoModal: boolean;
    jellyseerrUrl: string | null;
    jellyfinMediaId: string | null;
    jellyfinHref: string | null;
    linksAvailableToJellyfin: boolean;
    posterOpensModal: boolean;
    navigatesExternally: boolean;
    cardScalable: HTMLElement;
    imageContainer: HTMLElement;
    overview: HTMLElement | null;
    button: HTMLButtonElement | null;
    outsideClick: ((event: MouseEvent) => void) | null;
    /** performance.now() of the tap that navigated to Jellyfin; 0 once its click is seen. */
    tapNavigatedAt: number;
}
interface IconJob {
    container: HTMLElement;
    tmdbId: number;
    mediaType: string;
    visible: boolean;
    started: boolean;
    cancelled: boolean;
    timer: number | null;
    cancelIdle: (() => void) | null;
    controller: AbortController | null;
}

/** A base usable in a link: an http(s) URL or a same-origin path (never another scheme). */
const linkableBase = (base: string): string => /^https?:\/\//i.test(base) || base.startsWith('/') ? base : '';
/** The fixed template position of a card part; the template guarantees it. */
function part(parent: Element | null | undefined, index: number): HTMLElement {
    const element = parent?.children[index];
    if (!(element instanceof HTMLElement)) throw new Error('Seerr card template is missing a part');
    return element;
}

export function installCards(host: SeerrCoreHost): void {
    const { JE, document, window } = host;
    if (!firstInstall(JE, 'ui-cards')) return;
    const ui: Partial<SeerrUiFacade> = JE.jellyseerrUI ||= {};
    const internals = groupInternals(JE);
    const seerr = seerrCoreContext(JE);
    const escapeHtml = escapeWith(JE);
    const isTvLayout = () => JE.core?.ui?.isTvLayout?.() === true;

    // ---- Lazy posters: applied only as a card nears the viewport (one shared observer).
    const POSTER_DATA_KEY = 'jePoster';
    let posterObserver: IntersectionObserver | null = null;
    // IntersectionObserver keeps its targets alive; removed cards are unobserved explicitly.
    const observedPosters = new Set<HTMLElement>();
    const posterReadiness = new WeakMap<HTMLElement, { promise: Promise<void>; resolve(): void }>();
    function getPosterReadiness(el: HTMLElement): { promise: Promise<void>; resolve(): void } {
        let record = posterReadiness.get(el);
        if (!record) {
            let resolve: () => void = () => undefined;
            const promise = new Promise<void>(r => { resolve = r; });
            record = { promise, resolve: () => resolve() };
            posterReadiness.set(el, record);
        }
        return record;
    }
    function applyPoster(el: HTMLElement): void {
        const url = el.dataset[POSTER_DATA_KEY];
        try { posterObserver?.unobserve(el); } catch { /* already gone */ }
        observedPosters.delete(el);
        if (!url) return;
        delete el.dataset[POSTER_DATA_KEY];
        el.style.backgroundImage = `url("${url.replace(/["\\]/g, '\\$&')}")`;
        // A probe for the same URL tells the deferred icon lookup when the poster settled.
        const probe = new Image();
        probe.onload = probe.onerror = () => getPosterReadiness(el).resolve();
        probe.src = url;
    }
    function getPosterObserver(): IntersectionObserver | null {
        if (posterObserver) return posterObserver;
        if (typeof IntersectionObserver === 'undefined') return null;
        try {
            posterObserver = new IntersectionObserver(entries => {
                for (const entry of entries) {
                    if ((entry.isIntersecting || entry.intersectionRatio > 0) && entry.target instanceof HTMLElement) applyPoster(entry.target);
                }
            }, { root: null, rootMargin: '800px', threshold: 0 });
        } catch {
            posterObserver = null;
        }
        return posterObserver;
    }
    function observePoster(el: HTMLElement, url: string): void {
        el.dataset[POSTER_DATA_KEY] = url;
        const observer = getPosterObserver();
        if (!observer) { applyPoster(el); return; }
        try {
            observer.observe(el);
            observedPosters.add(el);
        } catch {
            applyPoster(el);
        }
    }

    // ---- Deferred "Elsewhere" provider icons: once the card is on screen and its
    // poster has settled (bounded), at the next idle moment, at most once per card.
    const ICON_POSTER_WAIT_MS = 3000;
    const ICON_IDLE_TIMEOUT_MS = 1000;
    let iconObserver: IntersectionObserver | null = null;
    const iconJobs = new Map<HTMLElement, IconJob>();
    function runWhenIdle(fn: () => void): () => void {
        if (typeof window.requestIdleCallback === 'function') {
            const id = window.requestIdleCallback(() => fn(), { timeout: ICON_IDLE_TIMEOUT_MS });
            return () => window.cancelIdleCallback(id);
        }
        const id = window.setTimeout(fn, 0);
        return () => window.clearTimeout(id);
    }
    function cancelIconJob(el: HTMLElement, job: IconJob): void {
        job.cancelled = true;
        if (job.timer !== null) window.clearTimeout(job.timer);
        job.cancelIdle?.();
        job.controller?.abort();
        try { iconObserver?.unobserve(el); } catch { /* already gone */ }
        iconJobs.delete(el);
    }
    function startProviderIcons(el: HTMLElement, job: IconJob): void {
        job.started = true;
        const bound = new Promise<void>(resolve => { job.timer = window.setTimeout(resolve, ICON_POSTER_WAIT_MS); });
        void Promise.race([getPosterReadiness(el).promise, bound]).then(() => {
            if (job.timer !== null) window.clearTimeout(job.timer);
            if (job.cancelled) return;
            job.cancelIdle = runWhenIdle(() => {
                job.cancelIdle = null;
                if (job.cancelled) return;
                if (!job.visible || !job.container.isConnected) {
                    job.started = false; // scrolled away while waiting: fire when visible again
                    return;
                }
                try { iconObserver?.unobserve(el); } catch { /* already gone */ }
                const controller = new AbortController();
                job.controller = controller;
                const lookup = internals.fetchProviderIcons?.(job.container, job.tmdbId, job.mediaType, controller.signal) ?? Promise.resolve();
                void lookup.finally(() => { if (iconJobs.get(el) === job) iconJobs.delete(el); });
            });
        });
    }
    function getIconObserver(): IntersectionObserver | null {
        if (iconObserver) return iconObserver;
        if (typeof IntersectionObserver === 'undefined') return null;
        try {
            iconObserver = new IntersectionObserver(entries => {
                for (const entry of entries) {
                    if (!(entry.target instanceof HTMLElement)) continue;
                    const job = iconJobs.get(entry.target);
                    if (!job || job.controller) continue;
                    job.visible = entry.isIntersecting || entry.intersectionRatio > 0;
                    if (job.visible && !job.started) startProviderIcons(entry.target, job);
                }
            }, { root: null, rootMargin: '0px', threshold: 0 });
        } catch {
            iconObserver = null;
        }
        return iconObserver;
    }
    function observeProviderIcons(el: HTMLElement, container: HTMLElement, tmdbId: number, mediaType: string): void {
        const observer = getIconObserver();
        if (!observer) { void internals.fetchProviderIcons?.(container, tmdbId, mediaType); return; }
        iconJobs.set(el, { container, tmdbId, mediaType, visible: false, started: false, cancelled: false, timer: null, cancelIdle: null, controller: null });
        try {
            observer.observe(el);
        } catch {
            iconJobs.delete(el);
            void internals.fetchProviderIcons?.(container, tmdbId, mediaType);
        }
    }

    /**
     * Stops observing posters of removed cards (or those under `root`) and cancels
     * their pending icon lookups. Cards still assembled in a DocumentFragment are
     * kept unless they are under `root`.
     */
    function releasePosters(root?: ParentNode): void {
        const isReleased = (el: HTMLElement) => (!!root && root.contains(el))
            || (!el.isConnected && !(el.getRootNode() instanceof DocumentFragment));
        if (posterObserver) {
            for (const el of [...observedPosters]) {
                if (!isReleased(el)) continue;
                try { posterObserver.unobserve(el); } catch { /* already gone */ }
                observedPosters.delete(el);
            }
        }
        for (const [el, job] of [...iconJobs]) if (isReleased(el)) cancelIconJob(el, job);
    }

    /** Whether the card shows the "in library" state (and links to Jellyfin). */
    function getLibraryAvailability(item: SeerrMediaItem, seasonAnalysis?: SeasonAnalysis | null): { isAvailable: boolean; jellyfinMediaId: string | null } {
        const info = item.mediaInfo;
        const jellyfinMediaId = info?.jellyfinMediaId || info?.jellyfinMediaId4k || null;
        // A stale show-level id is not enough for TV: the seasons decide.
        let effective: number;
        if (item.mediaType === 'tv' && info?.seasons?.length) {
            const analysis = seasonAnalysis || analyzeSeasonStatuses(info.seasons, JE.t);
            effective = analysis.overallStatus;
        } else {
            effective = effectiveMediaStatus(info?.status, jellyfinMediaId);
        }
        const isAvailable = !!jellyfinMediaId && (effective === MEDIA.AVAILABLE || effective === MEDIA.PARTIALLY_AVAILABLE);
        return { isAvailable, jellyfinMediaId };
    }

    // ---- Card construction: one parsed template, per-card state, delegated events.
    const cardStates = new WeakMap<HTMLElement, CardState>();
    const boundContainers = new WeakSet<HTMLElement>();
    let cardTemplate: HTMLElement | null = null;
    let cardTemplateIconUrl: string | null = null;
    function getCardTemplate(seerrIconUrl: string): HTMLElement {
        if (cardTemplate && cardTemplateIconUrl === seerrIconUrl) return cardTemplate;
        const template = document.createElement('template');
        template.innerHTML = '<div class="card overflowPortraitCard card-hoverable card-withuserdata jellyseerr-card">'
            + '<div class="cardBox cardBox-bottompadded">'
            + '<div class="cardScalable">'
            + '<div class="cardPadder cardPadder-overflowPortrait"></div>'
            // tabindex/focusable: keyboard and Jellyfin remote navigation reach the poster.
            + '<div class="cardImageContainer coveredImage cardContent jellyseerr-poster-image focusable" style="cursor: pointer;" tabindex="0">'
            + '<div class="jellyseerr-status-badge"></div>'
            + '<div class="jellyseerr-elsewhere-icons"></div>'
            + '<div class="cardIndicators"></div>'
            + '</div>'
            // No data-action, no pointer events: Jellyfin's own card handling leaves Seerr cards alone.
            + '<div class="cardOverlayContainer" style="pointer-events: none;"></div>'
            + '</div>'
            + '<div class="cardText cardTextCentered cardText-first">'
            // is="emby-linkbutton" routes external URLs through the system browser on iOS/Android.
            + '<a is="emby-linkbutton" class="jellyseerr-more-info-link"><bdi></bdi></a>'
            + '</div>'
            + '<div class="cardText cardTextCentered cardText-secondary jellyseerr-meta">'
            + '<img class="jellyseerr-icon-on-card" alt="Seerr">'
            + '<bdi></bdi>'
            + `<div class="jellyseerr-rating">${(internals.icons ?? ICONS).star}<span></span></div>`
            + '</div>'
            + '</div>'
            + '</div>';
        const root = template.content.firstElementChild;
        if (!(root instanceof HTMLElement)) throw new Error('Seerr card template did not parse');
        root.querySelector('.jellyseerr-icon-on-card')?.setAttribute('src', seerrIconUrl);
        cardTemplate = root;
        cardTemplateIconUrl = seerrIconUrl;
        return root;
    }

    // Per-batch constants, computed on a batch's first card and dropped at the end of the task.
    let batchContext: BatchContext | null = null;
    function getBatchContext(): BatchContext {
        if (batchContext) return batchContext;
        const config = JE.pluginConfig;
        const hiddenSettings = seerr.peer('hiddenContent')?.getSettings?.() ?? null;
        const showHideButtons = !!(hiddenSettings && hiddenSettings.enabled
            && hiddenSettings.showHideButtons !== false && hiddenSettings.showButtonJellyseerr !== false);
        const translatedOr = (key: string, fallback: string) => (JE.t(key) !== key ? JE.t(key) : fallback);
        const mediaBadgeKeys: Readonly<Record<string, string>> = { movie: 'jellyseerr_card_badge_movie', tv: 'jellyseerr_card_badge_series', collection: 'jellyseerr_card_badge_collection' };
        const mediaBadgeLabels = new Map<string, string>();
        let viewLabel: string | null = null;
        const ctx: BatchContext = {
            seerrBase: JE.jellyseerrAPI?.resolveJellyseerrBaseUrl() || '',
            // A TV app has no new window to open Seerr in, so it always uses the modal.
            useMoreInfoModal: !!config?.JellyseerrUseMoreInfoModal || isTvLayout(),
            moreInfoLoaded: !!JE.jellyseerrMoreInfo,
            availablePostersLinkToJellyfin: !!config?.JellyseerrAvailablePosterLinksToJellyfin,
            showProviderIcons: !!(config?.ShowElsewhereOnJellyseerr && config.TmdbEnabled),
            posterNotFoundUrl: JE.cdn?.url?.('ibb', 'fdbkXQdP/jellyseerr-poster-not-found.png') ?? '',
            seerrIconUrl: JE.cdn?.selfhst?.('svg/seerr.svg') ?? '',
            showHideButtons,
            hiddenLabel: showHideButtons ? translatedOr('hidden_content_already_hidden', 'Hidden') : null,
            unhideLabel: showHideButtons ? translatedOr('hidden_content_unhide', 'Unhide') : null,
            hideLabel: showHideButtons ? translatedOr('hidden_content_hide_button', 'Hide') : null,
            viewOnJellyseerrLabel() {
                if (viewLabel === null) viewLabel = JE.t('jellyseerr_card_view_on_jellyseerr') || 'View on Jellyseerr';
                return viewLabel;
            },
            mediaBadgeLabel(mediaType) {
                const key = mediaBadgeKeys[mediaType];
                if (!key) return undefined;
                let label = mediaBadgeLabels.get(mediaType);
                if (label === undefined) { label = JE.t(key); mediaBadgeLabels.set(mediaType, label); }
                return label;
            }
        };
        batchContext = ctx;
        queueMicrotask(() => { if (batchContext === ctx) batchContext = null; });
        return ctx;
    }

    /** The item fields a card is built from, as plain values (cards built with equal inputs are equal). */
    function cardItemInputs(item: SeerrMediaItem): unknown[] {
        const info = item.mediaInfo;
        return [
            item.id, item.mediaType, item.title, item.name, item.posterPath, item.voteAverage,
            item.releaseDate, item.firstAirDate, item.collection ? [item.collection.name] : null,
            info ? [
                info.status, info.jellyfinMediaId, info.jellyfinMediaId4k,
                Array.isArray(info.seasons) ? info.seasons.map(s => [s?.seasonNumber, s?.status]) : !!info.seasons,
                info.downloadStatus?.length, info.downloadStatus4k?.length
            ] : null
        ];
    }
    /** Everything createJellyseerrCard reads, as one string (results change in place, so fields count). */
    function cardInputsKey(items: readonly unknown[]): string {
        const ctx = getBatchContext();
        return JSON.stringify([
            ctx.seerrBase, ctx.useMoreInfoModal, ctx.moreInfoLoaded, ctx.availablePostersLinkToJellyfin,
            ctx.showProviderIcons, ctx.posterNotFoundUrl, ctx.seerrIconUrl,
            ctx.showHideButtons, ctx.hiddenLabel, ctx.unhideLabel, ctx.hideLabel, ctx.viewOnJellyseerrLabel(),
            ctx.mediaBadgeLabel('movie'), ctx.mediaBadgeLabel('tv'), ctx.mediaBadgeLabel('collection'),
            items.map(item => isMediaItem(item) ? cardItemInputs(item) : null),
            ctx.showHideButtons ? items.map(item => isMediaItem(item) ? seerr.peer('hiddenContent')?.isHiddenByTmdbId?.(item.id) ?? false : null) : null
        ]);
    }

    function setHideButtonState(hideBtn: HTMLButtonElement, hidden: boolean, ctx: BatchContext): void {
        hideBtn.className = hidden ? 'je-hide-btn je-already-hidden' : 'je-hide-btn';
        hideBtn.title = (hidden ? ctx.hiddenLabel : ctx.hideLabel) ?? '';
        hideBtn.replaceChildren();
        const icon = document.createElement('span');
        icon.className = 'material-icons';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = hidden ? 'visibility_off' : 'visibility';
        hideBtn.appendChild(icon);
    }

    /** One result card, or null for a value that is not a well-formed result. */
    function createJellyseerrCard(value: unknown, isJellyseerrActive: boolean, jellyseerrUserFound: boolean): HTMLElement | null {
        if (!isMediaItem(value)) {
            console.debug(`${LOG_UI} Skipped a malformed Seerr result`, value);
            return null;
        }
        const item = value;
        const ctx = getBatchContext();
        // Collections have no year or rating: just the Seerr icon instead of N/A.
        const isCollection = item.mediaType === 'collection';
        const year = item.releaseDate?.substring(0, 4) || item.firstAirDate?.substring(0, 4) || (isCollection ? '' : 'N/A');
        // Only a TMDB-shaped path reaches the url() literal.
        const posterUrl = isSafeTmdbImagePath(item.posterPath) ? `https://image.tmdb.org/t/p/w400${item.posterPath}` : ctx.posterNotFoundUrl;
        const rating = item.voteAverage ? item.voteAverage.toFixed(1) : (isCollection ? '' : 'N/A');
        // API-sourced title, set as text and attribute values only.
        const title = String((item.title || item.name) ?? '');
        const base = linkableBase(ctx.seerrBase);
        const jellyseerrUrl = base ? `${base}/${encodeURIComponent(item.mediaType)}/${item.id}` : null;
        const useMoreInfoModal = ctx.useMoreInfoModal;
        const seasons = item.mediaType === 'tv' ? item.mediaInfo?.seasons : null;
        const seasonAnalysis = seasons ? analyzeSeasonStatuses(seasons, JE.t) : null;
        const { isAvailable, jellyfinMediaId } = getLibraryAvailability(item, seasonAnalysis);
        const jellyfinHref = isAvailable ? `#!/details?id=${jellyfinMediaId}` : null;
        // Admin opt-in: an available item's poster goes straight to Jellyfin, like its title link.
        const linksAvailableToJellyfin = isAvailable && item.mediaType !== 'collection' && ctx.availablePostersLinkToJellyfin;

        const card = document.importNode(getCardTemplate(ctx.seerrIconUrl), true);
        bindViewOrigin(host, card);
        if (isAvailable) card.classList.add('jellyseerr-card-in-library');
        const cardBox = part(card, 0);
        const cardScalable = part(cardBox, 0);
        const imageContainer = part(cardScalable, 1);
        const titleLink = part(part(cardBox, 1), 0);
        const meta = part(cardBox, 2);
        if (jellyfinHref) {
            titleLink.setAttribute('href', jellyfinHref);
        } else if (useMoreInfoModal || !jellyseerrUrl) {
            titleLink.setAttribute('href', '#');
        } else {
            titleLink.setAttribute('href', jellyseerrUrl);
            titleLink.setAttribute('target', '_blank');
            titleLink.setAttribute('rel', 'noopener noreferrer');
        }
        titleLink.setAttribute('data-tmdb-id', String(item.id));
        titleLink.setAttribute('data-media-type', item.mediaType);
        titleLink.setAttribute('title', (jellyfinHref || useMoreInfoModal || !jellyseerrUrl) ? title : ctx.viewOnJellyseerrLabel());
        const titleText = titleLink.firstElementChild;
        if (titleText) titleText.textContent = title;
        titleLink.addEventListener('click', onTitleLinkCaptureClick, true);
        // Rating first, so the year keeps its index.
        const ratingElement = part(meta, 2);
        if (rating) { const value = ratingElement.lastElementChild; if (value) value.textContent = rating; }
        else ratingElement.remove();
        const yearElement = part(meta, 1);
        if (year) yearElement.textContent = year;
        else yearElement.remove();

        observePoster(imageContainer, posterUrl);
        internals.setStatusBadge?.(card, item, seasonAnalysis);
        internals.addMediaTypeBadge?.(card, item, imageContainer, ctx.mediaBadgeLabel(item.mediaType));
        internals.addCollectionMembershipBadge?.(card, item, imageContainer);
        if (ctx.showProviderIcons && item.mediaType !== 'collection') observeProviderIcons(imageContainer, part(imageContainer, 1), item.id, item.mediaType);
        if (ctx.showHideButtons) {
            const hideBtn = document.createElement('button');
            setHideButtonState(hideBtn, seerr.peer('hiddenContent')?.isHiddenByTmdbId?.(item.id) ?? false, ctx);
            cardBox.style.position = 'relative';
            cardBox.appendChild(hideBtn);
        }
        cardStates.set(card, {
            item, isJellyseerrActive, jellyseerrUserFound, ctx, useMoreInfoModal, jellyseerrUrl, jellyfinMediaId,
            jellyfinHref, linksAvailableToJellyfin,
            posterOpensModal: useMoreInfoModal && ctx.moreInfoLoaded,
            // Without the modal, an item outside the library links its overview text to Seerr.
            navigatesExternally: !useMoreInfoModal && !jellyfinMediaId && !!jellyseerrUrl && item.mediaType !== 'collection',
            cardScalable, imageContainer, overview: null, button: null, outsideClick: null, tapNavigatedAt: 0
        });
        return card;
    }

    function goToJellyfinItem(state: CardState): void {
        try {
            const page = host.window.Emby?.Page;
            if (page?.showItem && state.jellyfinMediaId) { page.showItem(state.jellyfinMediaId); return; }
        } catch { /* fall through to the hash route */ }
        if (state.jellyfinHref) window.location.hash = state.jellyfinHref;
    }
    const openMoreInfo = (tmdbId: number, mediaType: string) => {
        if (tmdbId && mediaType) void JE.jellyseerrMoreInfo?.open(tmdbId, mediaType);
    };
    /** The hover overview: synopsis plus the request button, configured only now. */
    function createOverview(state: CardState): HTMLElement {
        const item = state.item;
        const overview = document.createElement('div');
        overview.className = 'jellyseerr-overview';
        overview.style.cursor = 'pointer';
        const text = escapeHtml((item.overview || JE.t('jellyseerr_card_no_info')).slice(0, 500));
        // Without the modal, a real link so a tap opens Seerr outside the app.
        const contentHtml = state.navigatesExternally && state.jellyseerrUrl
            ? `<a is="emby-linkbutton" href="${escapeHtml(state.jellyseerrUrl)}" target="_blank" rel="noopener noreferrer" class="content jellyseerr-overview-link" style="text-decoration:none;color:inherit;">${text}</a>`
            : `<div class="content">${text}</div>`;
        overview.innerHTML = `
                    ${contentHtml}
                    <button type="button" class="jellyseerr-request-button" data-tmdb-id="${item.id}" data-media-type="${escapeHtml(item.mediaType)}"></button>
                `;
        state.overview = overview;
        state.cardScalable.appendChild(overview);
        const button = overview.querySelector('.jellyseerr-request-button');
        state.button = button instanceof HTMLButtonElement ? button : null;
        if (state.button) internals.configureRequestButton?.(state.button, item, state.isJellyseerrActive, state.jellyseerrUserFound);
        return overview;
    }
    function removeOverview(state: CardState): void {
        const overview = state.overview;
        if (overview?.parentNode) {
            overview.parentNode.removeChild(overview);
            state.overview = null;
            state.button = null;
        }
        if (state.outsideClick) document.removeEventListener('click', state.outsideClick);
    }
    function closeOverviewOnOutsideClick(card: HTMLElement, state: CardState): void {
        const handler = state.outsideClick ||= (event: MouseEvent) => {
            if (!(event.target instanceof Node) || !card.contains(event.target)) removeOverview(state);
        };
        window.setTimeout(() => {
            // Removed before this ran: nothing to close later.
            if (state.overview) document.addEventListener('click', handler);
        }, 0);
    }

    function cardEventTarget(container: HTMLElement, event: Event): { card: HTMLElement; state: CardState; target: Element } | null {
        const target = event.target;
        if (!(target instanceof Element)) return null;
        const card = target.closest('.jellyseerr-card');
        if (!(card instanceof HTMLElement) || card.parentElement !== container || !isViewCurrent(host, card)) return null;
        const state = cardStates.get(card);
        return state ? { card, state, target } : null;
    }
    function inCard(card: HTMLElement, target: Element, selector: string): HTMLElement | null {
        const el = target.closest(selector);
        return el instanceof HTMLElement && card.contains(el) ? el : null;
    }
    /**
     * Capture-phase click on the title link (kept on the link, not the container,
     * so a stopped click still reaches the link's own emby-linkbutton handler).
     */
    function onTitleLinkCaptureClick(this: HTMLElement, event: MouseEvent): void {
        const link = event.currentTarget instanceof HTMLElement ? event.currentTarget : this;
        const card = link.closest('.jellyseerr-card');
        const state = card instanceof HTMLElement ? cardStates.get(card) : undefined;
        if (!state || !card || !isViewCurrent(host, card)) { event.preventDefault(); event.stopPropagation(); return; }
        const item = state.item;
        const href = link.getAttribute('href');
        if (href && href.startsWith('#!/details?id=')) return;
        if (item.mediaType === 'collection') {
            event.preventDefault();
            event.stopPropagation();
            void ui.showCollectionRequestModal?.(item.id, item.name || item.title || '', item);
            return;
        }
        if (state.useMoreInfoModal && JE.jellyseerrMoreInfo) {
            event.preventDefault();
            event.stopPropagation();
            openMoreInfo(parseInt(link.dataset.tmdbId || '', 10), link.dataset.mediaType || '');
        }
        // An external Seerr link (is="emby-linkbutton") keeps its default behavior.
    }
    function onHideButtonClick(event: MouseEvent, hideBtn: HTMLButtonElement, card: HTMLElement, state: CardState): void {
        const item = state.item;
        event.preventDefault();
        event.stopPropagation();
        if (hideBtn.classList.contains('je-already-hidden')) {
            seerr.peer('hiddenContent')?.unhideItem?.(state.jellyfinMediaId || `tmdb-${item.id}`);
            setHideButtonState(hideBtn, false, state.ctx);
            return;
        }
        seerr.peer('hiddenContent')?.confirmAndHide?.({
            itemId: state.jellyfinMediaId || '',
            name: item.title || item.name || '',
            type: item.mediaType === 'tv' ? 'Series' : 'Movie',
            tmdbId: item.id,
            posterPath: item.posterPath || ''
        }, () => { card.style.display = 'none'; });
    }
    /** A click on the open overview (outside its button / link) acts like the poster. */
    function onOverviewClick(event: MouseEvent, state: CardState): void {
        const item = state.item;
        const target = event.target;
        if (target instanceof Element && (target.closest('.jellyseerr-request-button') || target.closest('.jellyseerr-overview-link'))) return;
        event.preventDefault();
        event.stopPropagation();
        if (state.linksAvailableToJellyfin) goToJellyfinItem(state);
        else if (item.mediaType === 'collection') void ui.showCollectionRequestModal?.(item.id, item.name || item.title || '', item);
        else if (state.useMoreInfoModal && JE.jellyseerrMoreInfo) openMoreInfo(item.id, item.mediaType);
    }
    // How long after a tap that navigated to Jellyfin its synthetic click still belongs to it.
    const TAP_CLICK_FOLLOW_MS = 1000;
    /**
     * Poster click: desktop shows the overview, then the poster goes to Jellyfin
     * or opens More Info. A poster that links to Jellyfin navigates once.
     */
    function onPosterClick(event: MouseEvent, card: HTMLElement, state: CardState): void {
        if (!('ontouchstart' in window)) {
            if (state.linksAvailableToJellyfin) {
                event.preventDefault();
                event.stopPropagation();
                goToJellyfinItem(state);
                return;
            } else if (!state.overview) {
                event.preventDefault();
                event.stopPropagation();
                createOverview(state);
                closeOverviewOnOutsideClick(card, state);
            }
        }
        if (state.linksAvailableToJellyfin) {
            event.preventDefault();
            event.stopPropagation();
            const followsTap = state.tapNavigatedAt > 0 && performance.now() - state.tapNavigatedAt < TAP_CLICK_FOLLOW_MS;
            state.tapNavigatedAt = 0;
            if (!followsTap) goToJellyfinItem(state);
        } else if (state.posterOpensModal) {
            event.preventDefault();
            event.stopPropagation();
            openMoreInfo(state.item.id, state.item.mediaType);
        }
    }
    function onCardClick(container: HTMLElement, event: MouseEvent): void {
        const hit = cardEventTarget(container, event);
        if (!hit) return;
        const { card, state, target } = hit;
        const hideBtn = inCard(card, target, '.je-hide-btn');
        if (hideBtn instanceof HTMLButtonElement) { onHideButtonClick(event, hideBtn, card, state); return; }
        if (inCard(card, target, '.jellyseerr-collection-badge')) {
            const collection = state.item.collection;
            event.preventDefault();
            event.stopPropagation();
            if (collection?.id) void ui.showCollectionRequestModal?.(collection.id, collection.name || '', state.item);
            return;
        }
        if (inCard(card, target, '.jellyseerr-overview')) { onOverviewClick(event, state); return; }
        if (inCard(card, target, '.jellyseerr-poster-image') === state.imageContainer) onPosterClick(event, card, state);
    }
    /** Enter / Space on a focused poster toggles the overview (or goes to Jellyfin). */
    function onCardKeydown(container: HTMLElement, event: KeyboardEvent): void {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const hit = cardEventTarget(container, event);
        if (!hit || inCard(hit.card, hit.target, '.jellyseerr-poster-image') !== hit.state.imageContainer) return;
        const state = hit.state;
        event.preventDefault();
        if (state.linksAvailableToJellyfin) {
            goToJellyfinItem(state);
        } else if (!state.overview) {
            const overview = createOverview(state);
            if (isTvLayout()) overview.querySelector<HTMLElement>('.jellyseerr-request-button')?.focus();
        } else {
            removeOverview(state);
        }
    }
    /**
     * mouseover/mouseout crossing the poster or the hide button: the hover overview, and the hidden item's
     * "Unhide" title. Not mouseenter: Gecko sends it only to a page that had a mouseenter listener before
     * the move, and this container is bound during the first move's mouseover.
     */
    function onCardHoverBoundary(container: HTMLElement, event: MouseEvent, entering: boolean): void {
        const hit = cardEventTarget(container, event);
        if (!hit) return;
        const { state, target } = hit;
        const related = event.relatedTarget instanceof Node ? event.relatedTarget : null;
        const crosses = (element: HTMLElement | null): element is HTMLElement => !!element && element.contains(target) && !(related && element.contains(related));
        if (crosses(state.cardScalable)) {
            // No preview when the poster just links straight to Jellyfin.
            if (!entering) removeOverview(state);
            else if (!state.overview && !state.linksAvailableToJellyfin) createOverview(state);
        }
        const hideButton = inCard(hit.card, target, '.je-hide-btn');
        if (crosses(hideButton) && hideButton.classList.contains('je-already-hidden')) {
            hideButton.title = (entering ? state.ctx.unhideLabel : state.ctx.hiddenLabel) ?? '';
        }
    }
    /** A tap (not a swipe) on the poster shows the overview; preventDefault keeps it from activating at once. */
    function onPosterTap(event: TouchEvent, imageContainer: HTMLElement): void {
        const card = imageContainer.closest('.jellyseerr-card');
        const state = card instanceof HTMLElement ? cardStates.get(card) : undefined;
        if (!card || !(card instanceof HTMLElement) || !state) return;
        const target = event.target;
        if (target instanceof Element && (target.closest('.jellyseerr-overview') || target.closest('.jellyseerr-request-button'))) return;
        if (state.linksAvailableToJellyfin) {
            goToJellyfinItem(state);
            // Its synthetic click still reaches onPosterClick and must not navigate again.
            state.tapNavigatedAt = performance.now();
            return;
        }
        if (!state.overview) {
            event.preventDefault();
            createOverview(state);
            closeOverviewOnOutsideClick(card, state);
        }
    }
    function bindCardContainer(container: HTMLElement): void {
        if (boundContainers.has(container)) return;
        boundContainers.add(container);
        container.addEventListener('click', event => onCardClick(container, event));
        container.addEventListener('keydown', event => onCardKeydown(container, event));
        container.addEventListener('mouseover', event => onCardHoverBoundary(container, event, true));
        container.addEventListener('mouseout', event => onCardHoverBoundary(container, event, false));
        JE.core?.ui?.addDelegatedTouchTapListener?.(container, el => {
            const card = el.closest('.jellyseerr-card');
            const state = card instanceof HTMLElement && card.parentElement === container ? cardStates.get(card) : undefined;
            return state && state.imageContainer.contains(el) ? state.imageContainer : null;
        }, onPosterTap);
    }
    /** Binds a card container at document capture, before the event reaches it (so it handles this event too). */
    function bindCardContainersFrom(event: Event): void {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const card = target.closest('.jellyseerr-card');
        const container = card?.parentElement;
        if (card instanceof HTMLElement && container instanceof HTMLElement && !boundContainers.has(container) && cardStates.has(card)) {
            bindCardContainer(container);
        }
    }
    for (const type of ['mouseover', 'touchstart', 'focusin', 'keydown', 'click']) {
        document.addEventListener(type, bindCardContainersFrom, { capture: true, passive: true });
    }

    ui.releasePosters = releasePosters;
    ui.isInLibrary = (item: unknown) => isMediaItem(item) && getLibraryAvailability(item).isAvailable;
    ui.cardInputsKey = cardInputsKey;
    ui.createJellyseerrCard = createJellyseerrCard;
    internals.createJellyseerrCard = createJellyseerrCard;
}
