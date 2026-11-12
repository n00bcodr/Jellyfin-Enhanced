import { discoveryContext, type SeerrDiscoveryHost } from '../host-discovery';
import { mediaInfoOf, selectCardResults } from './domain';
import type { AppendCardsOptions, AppendSliceOptions, SeerrResult } from './types';

// A load can bring 80-160 cards, and building them in one go was one long task. The cards that
// land where the viewer can see them (or within half a screen) are built and appended at once.
// The rest, which the scroll engine renders well below the fold, is built off-document in slices
// with the browser free in between, then appended in one go: every frame changing the page costs a
// share proportional to the whole page, and appending slice by slice would pay that once per slice.
const BUILD_SLICE_MS = 8;

/** Task-queue yield (no timer clamping, no throttling in hidden tabs). */
function createYield(): () => Promise<void> {
    if (typeof MessageChannel === 'undefined') return () => new Promise(resolve => setTimeout(resolve, 0));
    const channel = new MessageChannel();
    const waiters: Array<() => void> = [];
    channel.port1.onmessage = () => waiters.shift()?.();
    return () => new Promise(resolve => { waiters.push(resolve); channel.port2.postMessage(null); });
}
function firstSizedBox(elements: Array<Element | null>): DOMRect | null {
    for (const element of elements) {
        const box = element?.getBoundingClientRect();
        if (box && box.width > 0 && box.height > 0) return box;
    }
    return null;
}

export function createCardRendering(JE: SeerrDiscoveryHost) {
    const yieldToBrowser = createYield();

    /** The results a batch renders cards for: hidden, duplicate and excluded items are dropped. */
    function filterCardResults(results: SeerrResult[]): SeerrResult[] {
        const hiddenContent = discoveryContext(JE).peer('hiddenContent');
        const visible = hiddenContent ? hiddenContent.filterJellyseerrResults(results, 'discovery') : results;
        return selectCardResults(visible, {
            excludeLibrary: JE.pluginConfig?.JellyseerrExcludeLibraryItems === true,
            excludeBlocklisted: JE.pluginConfig?.JellyseerrExcludeBlocklistedItems === true,
            blockedStatus: JE.seerrStatus?.MEDIA.BLOCKED
        });
    }
    /** The shared Seerr card with the section's class, media type and in-library title link. */
    function createDiscoveryCard(item: SeerrResult, cardClass: string): HTMLElement | null {
        const card = JE.jellyseerrUI?.createJellyseerrCard?.(item, true, true);
        if (!card) return null;
        card.classList.remove('portraitCard', 'overflowPortraitCard');
        card.classList.add(cardClass);
        card.setAttribute('data-media-type', String(item.mediaType));
        // On a person's titles: what the person did in this one, on a line of its own under the title.
        JE.discoveryRoles?.decorateCard?.(card, item);
        const mediaId = mediaInfoOf(item)?.jellyfinMediaId;
        if (mediaId) {
            const id = String(mediaId);
            card.setAttribute('data-library-item', 'true');
            card.setAttribute('data-jellyfin-media-id', id);
            card.classList.add('jellyseerr-card-in-library');
            const titleLink = card.querySelector<HTMLAnchorElement>('.cardText-first a');
            if (titleLink) {
                const name = String(item.title || item.name || '');
                titleLink.textContent = name;
                titleLink.title = name;
                titleLink.href = `#!/details?id=${encodeURIComponent(id)}`;
                titleLink.removeAttribute('target');
                titleLink.removeAttribute('rel');
            }
        }
        return card;
    }
    function createCardsFragment(results: SeerrResult[], options: { readonly cardClass?: string } = {}): DocumentFragment {
        const { cardClass = 'portraitCard' } = options;
        const fragment = document.createDocumentFragment();
        for (const item of filterCardResults(results)) {
            const card = createDiscoveryCard(item, cardClass);
            if (card) fragment.appendChild(card);
        }
        return fragment;
    }
    /**
     * How many cards appended to `container` would land within half a screen of view, which must
     * go in at once so nothing pops in where the viewer is looking. May be Infinity: a container in
     * view holding no card to measure takes the whole batch.
     */
    function cardsInView(container: HTMLElement, options: { readonly horizontal?: boolean } = {}): number {
        const scroll = JE.seamlessScroll;
        if (!scroll?.cardsNeeded || !container.isConnected) return 0;
        const rect = container.getBoundingClientRect();
        if (options.horizontal) {
            // An empty track measures zero high while its row is on screen: judge the row instead.
            const row = firstSizedBox([container, container.closest('.emby-scroller'), container.closest('.verticalSection')]);
            if (!row || row.bottom <= 0 || row.top >= window.innerHeight) return 0;
            let last = container.lastElementChild;
            while (last && !last.classList.contains('card')) last = last.previousElementSibling;
            const end = last ? last.getBoundingClientRect().right : rect.left;
            const gapPx = window.innerWidth * 1.5 - end;
            return gapPx > 0 ? scroll.cardsNeeded(container, { deficitPx: gapPx, horizontal: true }, Infinity) : 0;
        }
        const gapPx = window.innerHeight * 1.5 - rect.bottom;
        return gapPx > 0 ? scroll.cardsNeeded(container, { deficitPx: gapPx }, Infinity) : 0;
    }
    /**
     * Appends cards: the first `syncCount` at once, the rest built in slices and appended together.
     * The promise settles once every card is in, so a caller reporting to the scroll engine measures
     * the whole batch. A card that fails to build rejects with the batch taken out again; a dropped
     * batch keeps the cards already appended. Either way posters of cards left out are released.
     */
    async function appendInSlices<T>(container: HTMLElement, items: readonly T[], createCard: (item: T) => HTMLElement | null,
        options: AppendSliceOptions = {}): Promise<number> {
        const { syncCount = 0, isCurrent = () => true } = options;
        const iterator = items[Symbol.iterator]();
        let next = iterator.next();
        const build = (fragment: DocumentFragment, minCount: number, budgetMs: number): number => {
            const start = performance.now();
            let count = 0;
            while (!next.done && (count < minCount || performance.now() - start < budgetMs)) {
                const card = createCard(next.value);
                next = iterator.next();
                if (card) { fragment.appendChild(card); count++; }
            }
            return count;
        };
        let pending = document.createDocumentFragment();
        let syncCards: Element[] = [];
        let settled = false;
        try {
            let appended = 0;
            if (syncCount > 0) {
                appended = build(pending, syncCount, 0);
                if (appended > 0) {
                    syncCards = Array.from(pending.children);
                    container.appendChild(pending);
                }
                pending = document.createDocumentFragment();
            }
            let built = build(pending, 0, BUILD_SLICE_MS);
            while (!next.done) {
                await yieldToBrowser();
                if (!isCurrent()) {
                    settled = true;
                    return appended;
                }
                built += build(pending, 1, BUILD_SLICE_MS);
            }
            if (built > 0) container.appendChild(pending);
            settled = true;
            return appended + built;
        } finally {
            // Stop watching the posters of cards that never made it in.
            if (pending.firstChild) JE.jellyseerrUI?.releasePosters?.(pending);
            if (!settled && syncCards.length > 0) {
                syncCards.forEach(card => card.remove());
                JE.jellyseerrUI?.releasePosters?.();
            }
        }
    }
    /** The same cards as createCardsFragment, with the ones in view appended at once. */
    function appendCards(container: HTMLElement, results: SeerrResult[], options: AppendCardsOptions = {}): Promise<number> {
        const { cardClass = 'portraitCard', isCurrent } = options;
        const items = filterCardResults(results);
        if (items.length === 0) return Promise.resolve(0);
        return appendInSlices(container, items, item => createDiscoveryCard(item, cardClass), {
            syncCount: cardsInView(container), isCurrent
        });
    }
    return { createCardsFragment, appendCards, appendInSlices, cardsInView };
}
