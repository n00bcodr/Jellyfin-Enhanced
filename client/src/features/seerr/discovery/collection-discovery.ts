// /js/jellyseerr/discovery/collection-discovery.js
// Shows missing collection movies on BoxSet detail pages with request buttons.
import { baseOf, discoveryHost, filterOf, type SeerrDiscoveryHost } from '../host-discovery';
import { decodeCollection, decodeNamedInfo, isUserActive, positiveInt } from './domain';
import { isItemType, managedFetch, tolerant } from './lookups';
import type { NamedTmdbInfo, OneShotContext } from './types';

const logPrefix = '🪼 Jellyfin Enhanced: Collection Discovery:';
const SECTION_CLASS = 'jellyseerr-collection-discovery-section';

function createSectionContainer(title: string): HTMLElement {
    const section = document.createElement('div');
    section.className = `verticalSection ${SECTION_CLASS}`;
    section.setAttribute('data-jellyseerr-collection-discovery', 'true');
    section.style.cssText = 'margin-top:2em;padding-top:1em;border-top:1px solid rgba(255,255,255,0.1)';
    const heading = document.createElement('h2');
    heading.className = 'sectionTitle sectionTitle-cards padded-left';
    heading.textContent = title;
    heading.style.marginBottom = '0.5em';
    section.appendChild(heading);
    const itemsContainer = document.createElement('div');
    itemsContainer.setAttribute('is', 'emby-itemscontainer');
    itemsContainer.className = 'itemsContainer padded-right vertical-wrap';
    section.appendChild(itemsContainer);
    return section;
}

function start(JE: SeerrDiscoveryHost): void {
    const base = baseOf(JE);
    const fetchManaged = managedFetch(JE, 'collection');
    const boxsetCache = new Map<string, NamedTmdbInfo>();

    function getBoxSetInfo(boxsetId: string, signal: AbortSignal): Promise<NamedTmdbInfo | null> {
        const cached = boxsetCache.get(boxsetId);
        if (cached) return Promise.resolve(cached);
        return tolerant(signal, async () => {
            const info = decodeNamedInfo(await fetchManaged(`/JellyfinEnhanced/boxset/${boxsetId}`, { signal }));
            if (info && !signal.aborted) boxsetCache.set(boxsetId, info);
            return info;
        });
    }
    async function renderMissing({ id: itemId, signal, waitForPageReady }: OneShotContext,
        pageWait: AbortSignal): Promise<boolean | undefined> {
        const isBoxSet = await isItemType(JE, itemId, 'BoxSet', signal);
        if (signal.aborted || !isBoxSet) return undefined;
        // The page wait overlaps the API calls.
        const boxsetPromise = getBoxSetInfo(itemId, signal);
        const statusPromise = JE.jellyseerrAPI?.checkUserStatus?.();
        const pageReadyPromise = waitForPageReady(pageWait);
        const [boxset, status] = await Promise.all([boxsetPromise, statusPromise]);
        if (signal.aborted) return undefined;
        if (!isUserActive(status) || !boxset?.tmdbId) {
            if (!boxset?.tmdbId) console.debug(`${logPrefix} No TMDB collection ID for BoxSet ${itemId}`);
            return undefined;
        }
        const collectionId = positiveInt(boxset.tmdbId);
        if (!collectionId) return undefined;
        const collection = decodeCollection(await JE.jellyseerrAPI?.fetchCollectionDetails?.(collectionId));
        if (signal.aborted) return undefined;
        if (!collection || collection.parts.length === 0) {
            console.debug(`${logPrefix} No parts found in collection ${collectionId}`);
            return undefined;
        }
        const { parts, missing } = collection;
        if (missing.length === 0) {
            console.debug(`${logPrefix} All movies in collection ${boxset.name} are available`);
            return undefined;
        }
        const detailSection = await pageReadyPromise;
        if (signal.aborted) return undefined;
        if (!detailSection) {
            console.debug(`${logPrefix} Could not find detail section to insert into`);
            return undefined;
        }
        document.querySelector(`.${SECTION_CLASS}`)?.remove();
        const available = parts.length - missing.length;
        const section = createSectionContainer(`Missing from ${boxset.name} (${available}/${parts.length})`);
        const fragment = filterOf(JE).createCardsFragment(missing, { cardClass: 'overflowPortraitCard' });
        const itemsContainer = section.querySelector('.itemsContainer');
        if (!itemsContainer || fragment.childNodes.length === 0) {
            console.debug(`${logPrefix} No cards created from missing movies`);
            return undefined;
        }
        itemsContainer.appendChild(fragment);
        detailSection.appendChild(section);
        console.debug(`${logPrefix} Section added with ${missing.length} missing movies from ${boxset.name}`);
        return true;
    }
    /** An early exit must stop the overlapping page wait rather than leave it polling. */
    async function renderCollectionDiscovery(context: OneShotContext): Promise<boolean | undefined> {
        const pageWait = new AbortController();
        context.signal.addEventListener('abort', () => pageWait.abort(), { once: true, signal: pageWait.signal });
        try { return await renderMissing(context, pageWait.signal); }
        finally { pageWait.abort(); }
    }
    base.createDiscovery({
        key: 'collection',
        mode: 'one-shot',
        logLabel: 'Collection Discovery',
        configKey: 'JellyseerrShowCollectionDiscovery',
        getIdFromUrl: base.idFromDetailUrl,
        renderOneShot: renderCollectionDiscovery,
        onCleanup: () => boxsetCache.clear()
    }).start();
}
(function () {
    'use strict';
    start(discoveryHost().JE);
})();
