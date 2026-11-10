import { apiClient, bridge, identityLease, SEERR_LOG, translator, type MediaType, type ObserverFacade } from '../host-details';
import { record } from './domain/json';
import { seerrPage } from './domain/links';

const JE = bridge();
const t = translator(JE);
const logPrefix = `${SEERR_LOG} Seerr Detail Link:`;
const STYLE_ID = 'seerr-detail-link-styles';

/** Whether the admin has the link on. Read on every page: the setting can change at runtime. */
function enabled(): boolean {
    return !!JE.pluginConfig?.JellyseerrEnabled && !!JE.pluginConfig?.JellyseerrShowDetailPageLink;
}

function injectStyles(): void {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
                .seerr-link-img {
                    width: 25px;
                    height: 25px;
                    display: block;
                    object-fit: contain;
                }
            `;
    document.head.appendChild(style);
}

/** The id Jellyfin already renders in its themoviedb.org external link, without a lookup of our own. */
function tmdbIdFromLinks(context: Element): string | null {
    for (const link of context.querySelectorAll<HTMLAnchorElement>('.itemExternalLinks a, .externalIdLinks a')) {
        const { href } = link;
        if (href.includes('themoviedb.org/movie/')) return /\/movie\/(\d+)/.exec(href)?.[1] ?? null;
        if (href.includes('themoviedb.org/tv/')) return /\/tv\/(\d+)/.exec(href)?.[1] ?? null;
    }
    return null;
}

function createSeerrLink(tmdbId: string, mediaType: MediaType, iconUrl: string): HTMLAnchorElement | null {
    const useMoreInfoModal = !!JE.pluginConfig?.JellyseerrUseMoreInfoModal || !!JE.core?.ui?.isTvLayout?.();
    const base = JE.jellyseerrAPI?.resolveJellyseerrBaseUrl?.() ?? '';
    const button = document.createElement('a');
    button.setAttribute('is', 'emby-linkbutton');
    button.className = 'button-link emby-button seerr-link';
    if (JE.pluginConfig?.JellyseerrShowDetailPageLinkAsText) {
        button.textContent = 'Seerr';
    } else {
        const image = document.createElement('img');
        image.src = iconUrl;
        image.alt = 'Seerr';
        image.className = 'seerr-link-img';
        const size = JE.helpers?.getExternalLinkIconSize?.() ?? 18;
        image.style.width = `${size}px`;
        image.style.height = `${size}px`;
        button.appendChild(image);
    }
    const title = t('jellyseerr_card_view_on_jellyseerr', 'View on Seerr');
    if (useMoreInfoModal) {
        // The modal has its own "View on Seerr" link for anyone who wants the real page.
        button.href = '#';
        button.title = title;
        button.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            if (typeof JE.jellyseerrMoreInfo?.open === 'function') void JE.jellyseerrMoreInfo.open(tmdbId, mediaType);
            else console.warn(`${logPrefix} more-info modal not available`);
        });
        return button;
    }
    // Nothing to link to and no modal to fall back on: not configured, or not signed in to Seerr.
    if (!base) return null;
    button.href = seerrPage(base, mediaType, tmdbId);
    button.target = '_blank';
    button.rel = 'noopener noreferrer';
    button.title = title;
    return button;
}

/** Drops links left on views that are no longer shown, with the separator before each. */
function removeStaleLinks(): void {
    document.querySelectorAll('#itemDetailPage.hide .seerr-link').forEach(stale => {
        if (stale.previousSibling?.nodeType === Node.TEXT_NODE) stale.previousSibling.remove();
        stale.remove();
    });
}

function initializeSeerrDetailLinkScript(): void {
    if (!enabled()) {
        console.log(`${logPrefix} Disabled in plugin settings.`);
        return;
    }
    console.log(`${logPrefix} Initializing...`);

    const iconUrl = JE.cdn?.selfhst('svg/seerr.svg') ?? '';
    let adding = false;
    // A page that needed the link while an earlier page's lookup held the lock.
    let wanted = false;
    let debounceTimer: number | undefined;
    let observer: ObserverFacade | undefined;
    injectStyles();

    async function addSeerrLink(): Promise<void> {
        if (adding) {
            wanted = true;
            return;
        }
        const visiblePage = document.querySelector('#itemDetailPage:not(.hide)');
        if (!visiblePage) return;
        const anchor = visiblePage.querySelector('.itemExternalLinks');
        removeStaleLinks();
        if (!anchor || anchor.querySelector('.seerr-link')) return;

        const hashAtStart = window.location.hash;
        const sameAccount = identityLease(JE);
        const stillValid = () => document.contains(anchor) && !anchor.closest('#itemDetailPage.hide')
            && window.location.hash === hashAtStart && sameAccount();

        adding = true;
        try {
            const itemId = new URLSearchParams(window.location.hash.split('?')[1]).get('id');
            if (!itemId) return;
            const client = apiClient();
            const item = record(JE.helpers?.getItemCached
                ? await JE.helpers.getItemCached(itemId)
                : await client.getItem(client.getCurrentUserId() ?? '', itemId));
            if (!stillValid() || anchor.querySelector('.seerr-link')) return;
            if (item?.Type !== 'Movie' && item?.Type !== 'Series') return;
            const tmdbId = tmdbIdFromLinks(visiblePage);
            if (!tmdbId) return;
            const link = createSeerrLink(tmdbId, item.Type === 'Movie' ? 'movie' : 'tv', iconUrl);
            if (!link) return;
            anchor.appendChild(document.createTextNode(JE.pluginConfig?.JellyseerrShowDetailPageLinkAsText ? ', ' : ' '));
            anchor.appendChild(link);
        } finally {
            adding = false;
            if (wanted) {
                wanted = false;
                void addSeerrLink();
            }
        }
    }

    observer = JE.helpers?.createObserver?.('seerr-detail-link', () => {
        if (!enabled()) {
            if (observer) {
                observer.disconnect();
                console.log(`${logPrefix} Observer disconnected — feature disabled`);
            }
            return;
        }
        clearTimeout(debounceTimer);
        debounceTimer = window.setTimeout(() => {
            addSeerrLink().catch(error => console.warn(`${logPrefix} Could not add the link:`, error));
        }, 100);
    }, document.body, { childList: true, subtree: true });

    console.log(`${logPrefix} Initialized successfully`);
}

JE.initializeSeerrDetailLinkScript = initializeSeerrDetailLinkScript;
