/** Letterboxd links for movies (via IMDb id) and people (via name slug) on item details. */
import { bridge } from './host';
import type { LetterboxdBridge, ObserverHandleLike } from './host';
import { hashItemId, lookupItem, sessionLease, visibleDetailPage } from './page';
import { externalLink, pathSegment } from './links';
import { decodeDetailsItem } from './wire';

const JE = bridge<LetterboxdBridge>('Letterboxd links');

/**
 * Letterboxd has no IMDb/TMDB lookup for people, only a name-based slug
 * (e.g. https://letterboxd.com/actor/tommy-lee-jones/), derived as Letterboxd does.
 */
export function personSlug(name: string | undefined): string | null {
    if (!name) return null;
    const slug = name.toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return slug || null;
}

JE.initializeLetterboxdLinksScript = async function initializeLetterboxdLinksScript() {
    const logPrefix = '🪼 Jellyfin Enhanced: Letterboxd Links:';
    if (!JE.pluginConfig?.LetterboxdEnabled) {
        console.log(`${logPrefix} Integration disabled in plugin settings.`);
        return;
    }
    console.log(`${logPrefix} Initializing...`);

    let isAddingLinks = false; // Lock to prevent concurrent runs
    let rescan = false; // a scan dropped by the lock runs once the lookup finishes
    // Only "unsupported" verdicts (wrong type, no IMDb id), never success:
    // Jellyfin can spawn a fresh #itemDetailPage for an already-processed
    // item, and the DOM check owns that case.
    const processedItemIds = new Set<string>();
    let lastVisibleItemId: string | null = null;
    JE.session?.onUserChange('letterboxd-links', () => {
        processedItemIds.clear();
        lastVisibleItemId = null;
    });

    const LETTERBOXD_ICON_URL = JE.cdn.selfhst('svg/letterboxd.svg');
    const styleId = 'letterboxd-links-styles';
    if (!document.getElementById(styleId)) {
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = `
                .letterboxd-link-icon::before {
                    content: "";
                    display: inline-block;
                    width: var(--je-icon-size, 25px);
                    height: var(--je-icon-size, 25px);
                    background-image: url(${LETTERBOXD_ICON_URL});
                    background-size: contain;
                    background-repeat: no-repeat;
                    vertical-align: middle;
                    margin-right: 5px;
                }
            `;
        document.head.appendChild(style);
    }

    function createLinkButton(label: string, url: string): HTMLAnchorElement {
        const button = externalLink(JE.helpers, url, { title: label });
        if (JE.pluginConfig?.ShowLetterboxdLinkAsText) {
            button.textContent = label;
            button.className = 'button-link emby-button letterboxd-link';
        } else {
            button.className = 'button-link emby-button letterboxd-link letterboxd-link-icon';
            button.style.setProperty('--je-icon-size', `${JE.helpers.getExternalLinkIconSize()}px`);
        }
        return button;
    }

    async function addLetterboxdLinks(): Promise<void> {
        if (isAddingLinks) {
            rescan = true;
            return;
        }
        const visiblePage = visibleDetailPage();
        if (!visiblePage) return;
        const itemId = hashItemId();
        if (!itemId) return;
        if (processedItemIds.has(itemId)) return;
        // A different item allows reprocessing.
        if (lastVisibleItemId && lastVisibleItemId !== itemId) processedItemIds.clear();
        lastVisibleItemId = itemId;

        const anchorElement = visiblePage.querySelector('.itemExternalLinks');
        // Clean up stale links on non-visible pages to prevent conflicts
        document.querySelectorAll('#itemDetailPage.hide .letterboxd-link').forEach(staleLink => {
            if (staleLink.previousSibling?.nodeType === Node.TEXT_NODE) staleLink.previousSibling.remove();
            staleLink.remove();
        });
        if (!anchorElement || anchorElement.querySelector('.letterboxd-link')) return;

        isAddingLinks = true;
        const session = sessionLease(JE.session);
        try {
            const item = decodeDetailsItem(await lookupItem(JE.helpers, itemId, false));
            // The SPA can reuse this detail DOM while the lookup is pending:
            // never attach the previous item's link to the new route/page.
            if (hashItemId() !== itemId || !anchorElement.isConnected || visibleDetailPage() !== visiblePage || !session()) return;
            // A cancelled shared lookup returns null. Absence is not an
            // authoritative unsupported-type verdict; a later scan can retry.
            if (!item?.Type) return;
            // Letterboxd does not support TV shows (add 'Series' if it ever does).
            if (item.Type !== 'Movie' && item.Type !== 'Person') {
                console.log(`${logPrefix} Skipping ${item.Type} - Letterboxd links not supported.`);
                processedItemIds.add(itemId);
                return;
            }
            let letterboxdUrl: string;
            if (item.Type === 'Person') {
                const slug = personSlug(item.Name);
                if (!slug) {
                    console.log(`${logPrefix} Could not derive a Letterboxd slug for ${item.Name}.`);
                    processedItemIds.add(itemId);
                    return;
                }
                letterboxdUrl = `https://letterboxd.com/actor/${slug}`;
            } else {
                const imdbId = item.ProviderIds.Imdb;
                if (!imdbId) {
                    console.log(`${logPrefix} No IMDb ID found for ${item.Type}.`);
                    processedItemIds.add(itemId);
                    return;
                }
                letterboxdUrl = `https://letterboxd.com/imdb/${pathSegment(imdbId)}`;
            }
            anchorElement.appendChild(document.createTextNode(' '));
            anchorElement.appendChild(createLinkButton('Letterboxd', letterboxdUrl));
        } catch (err) {
            console.error(`${logPrefix} Error adding Letterboxd link:`, err);
        } finally {
            isAddingLinks = false;
            if (rescan) {
                rescan = false;
                scheduleLetterboxdLinks();
            }
        }
    }

    let processingLetterboxd = false;
    let letterboxdObserver: ObserverHandleLike | undefined | void;
    function scheduleLetterboxdLinks(): void {
        if (!JE.pluginConfig?.LetterboxdEnabled) {
            letterboxdObserver?.disconnect();
            console.log(`${logPrefix} Stopped - feature disabled`);
            return;
        }
        if (processingLetterboxd) return;
        processingLetterboxd = true;
        const run = () => {
            void addLetterboxdLinks();
            processingLetterboxd = false;
        };
        if (typeof requestIdleCallback !== 'undefined') requestIdleCallback(run, { timeout: 500 });
        else setTimeout(run, 100);
    }
    // childList-only routes this through the shared body observer; a cached
    // detail page re-shown by a class toggle is covered by the view-show hook.
    letterboxdObserver = JE.helpers.createObserver('letterboxd-links', scheduleLetterboxdLinks, document.body, { childList: true, subtree: true });
    JE.helpers.onViewPage(scheduleLetterboxdLinks);

    // Initial check
    // (The callback returns the scan's promise, as before, for callers that await it.)
    if (typeof requestIdleCallback !== 'undefined') requestIdleCallback(() => addLetterboxdLinks(), { timeout: 1000 });
    else setTimeout(() => addLetterboxdLinks(), 500);
    console.log(`${logPrefix} Letterboxd links integration initialized successfully.`);
};
