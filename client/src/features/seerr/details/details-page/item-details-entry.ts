import { apiClient, bridge, identityLease, SEERR_LOG, translator, type MediaType, type UnrequestedSeasonsCheck } from '../../host-details';
import { filled, idText, isRecord, record, records, str, type JsonRecord } from '../domain/json';
import { anyTitle, tmdbIdOf } from '../domain/media';
import { createDetailRows, detailsItemIdFromHash, findDetailPage, type DetailPage } from './rows';

/**
 * Adds the Similar and Recommended rows to item details pages, and a "Request More"
 * button by the Seasons heading of a Series with unrequested seasons in Seerr.
 */
const JE = bridge();
const t = translator(JE);
const logPrefix = `${SEERR_LOG} Seerr Item Details:`;
const requestMoreLogPrefix = `${SEERR_LOG} Series Request More:`;
const REQUEST_MORE_BTN_CLASS = 'je-series-request-more-btn';

// Processed items, to avoid duplicate renders.
const processedItems = new Set<string>();
const processedRequestMoreItems = new Set<string>();
// Request More checks in flight, by item id. onNavigate and onViewPage both start one for
// the same page; the second joins the first instead of aborting it and repeating its lookups.
const requestMoreInFlight = new Map<string, Promise<void>>();
// Separate controllers keep the slower rows fetch and the Request More check from
// cancelling each other when the user moves between detail pages.
let currentAbortController: AbortController | null = null;
let requestMoreAbortController: AbortController | null = null;

const rows = createDetailRows(JE, processedItems, scheduleSimilarAndRecommended);

function abortError(): DOMException {
    return new DOMException('Aborted', 'AbortError');
}
function isAbort(error: unknown): boolean {
    return record(error)?.name === 'AbortError' || (error instanceof DOMException && error.name === 'AbortError');
}

/** The TMDB id and media type of a Jellyfin item, or nulls for anything else. */
async function getTmdbIdFromItem(itemId: string, signal: AbortSignal): Promise<{ tmdbId: number | null; type: MediaType | null }> {
    const none = { tmdbId: null, type: null };
    try {
        if (signal.aborted) throw abortError();
        const client = apiClient();
        const userId = client.getCurrentUserId() ?? '';
        const item = record(JE.helpers?.getItemCached ? await JE.helpers.getItemCached(itemId, { userId }) : await client.getItem(userId, itemId));
        if (signal.aborted) throw abortError();
        if (!item) {
            console.warn(`${logPrefix} Item not found:`, itemId);
            return none;
        }
        if (item.Type !== 'Movie' && item.Type !== 'Series') return none;
        const tmdbId = idText(record(item.ProviderIds)?.Tmdb);
        if (!tmdbId) {
            console.warn(`${logPrefix} No TMDB ID found for item:`, str(item.Name));
            return none;
        }
        return { tmdbId: parseInt(tmdbId, 10), type: item.Type === 'Movie' ? 'movie' : 'tv' };
    } catch (error) {
        if (isAbort(error)) throw error;
        console.error(`${logPrefix} Error getting TMDB ID:`, error);
        return none;
    }
}

/** Waits up to 3 seconds for the details content, or null when cancelled or not there. */
function waitForDetailPageReady(signal: AbortSignal): Promise<DetailPage | null> {
    return new Promise(resolve => {
        if (signal.aborted) {
            resolve(null);
            return;
        }
        const immediate = findDetailPage();
        if (immediate) {
            resolve(immediate);
            return;
        }
        let subscription: { unsubscribe(): void } | null | undefined = null;
        let timer: number | undefined;
        const cleanup = () => {
            subscription?.unsubscribe();
            subscription = null;
            clearTimeout(timer);
        };
        signal.addEventListener('abort', () => {
            cleanup();
            resolve(null);
        }, { once: true });
        subscription = JE.helpers?.onBodyMutation?.('jellyseerr-item-details-page-detect', () => {
            const found = findDetailPage();
            if (found) {
                cleanup();
                resolve(found);
            }
        });
        timer = window.setTimeout(() => {
            cleanup();
            resolve(findDetailPage());
        }, 3000);
    });
}

/**
 * Starts the rows for an item in the next frame, unless the URL has moved on by then:
 * cleanup has already run for that navigation, so nothing would stop this run.
 */
function scheduleSimilarAndRecommended(itemId: string): void {
    requestAnimationFrame(() => {
        if (detailsItemIdFromHash() === itemId) void renderSimilarAndRecommended(itemId);
    });
}

async function renderSimilarAndRecommended(itemId: string): Promise<void> {
    // Rows still waiting on a view Jellyfin has since left go to the shown one now.
    if (processedItems.has(itemId)) {
        rows.retargetWaiting(itemId);
        return;
    }
    currentAbortController?.abort();
    const controller = new AbortController();
    currentAbortController = controller;
    const { signal } = controller;
    // The rows are not inserted for a user who signed in meanwhile.
    const sameAccount = identityLease(JE);
    const metrics = JE.requestManager;
    if (metrics?.metrics?.enabled) metrics.startMeasurement?.('similar-recommended');

    try {
        const showSimilar = JE.pluginConfig?.JellyseerrShowSimilar === true;
        const showRecommended = JE.pluginConfig?.JellyseerrShowRecommended === true;
        if (!showSimilar && !showRecommended) {
            console.debug(`${logPrefix} Both similar and recommended sections are disabled in settings`);
            return;
        }
        const api = JE.jellyseerrAPI;
        if (!api) return;
        const status = record(await api.checkUserStatus());
        if (signal.aborted) return;
        if (!status?.active) {
            console.debug(`${logPrefix} Jellyseerr is not active, skipping`);
            return;
        }
        const { tmdbId, type } = await getTmdbIdFromItem(itemId, signal);
        if (signal.aborted) return;
        if (!tmdbId || !type) {
            console.debug(`${logPrefix} No valid TMDB ID found for item, skipping`);
            return;
        }
        console.debug(`${logPrefix} Fetching similar and recommended content for TMDB ID ${tmdbId} (${type})`);

        // Only what is enabled, in parallel with the page becoming ready.
        const options = { signal };
        const empty = Promise.resolve({ results: [] });
        const [similarData, recommendedData, pageReady] = await Promise.all([
            showSimilar ? (type === 'movie' ? api.fetchSimilarMovies(tmdbId, options) : api.fetchSimilarTvShows(tmdbId, options)) : empty,
            showRecommended ? (type === 'movie' ? api.fetchRecommendedMovies(tmdbId, options) : api.fetchRecommendedTvShows(tmdbId, options)) : empty,
            waitForDetailPageReady(signal),
        ]);
        if (signal.aborted) return;

        const similarResults: readonly unknown[] = records(record(similarData)?.results);
        const recommendedResults: readonly unknown[] = records(record(recommendedData)?.results);
        if (similarResults.length === 0 && recommendedResults.length === 0) {
            console.debug(`${logPrefix} No similar or recommended content to display`);
            return;
        }
        if (!pageReady) {
            console.warn(`${logPrefix} Page not ready for insertion`);
            return;
        }

        // Library and blocklisted titles leave the rows when the admin says so.
        const excludeLibrary = JE.pluginConfig?.JellyseerrExcludeLibraryItems === true;
        const excludeBlocklisted = JE.pluginConfig?.JellyseerrExcludeBlocklistedItems === true;
        const blocked = JE.seerrStatus?.MEDIA.BLOCKED;
        const keep = (item: unknown): boolean => {
            const info = record(record(item)?.mediaInfo);
            if (excludeLibrary && filled(info?.jellyfinMediaId)) return false;
            return !(excludeBlocklisted && blocked !== undefined && info?.status === blocked);
        };
        const similar = similarResults.filter(keep);
        const recommended = recommendedResults.filter(keep);
        if (similar.length === 0 && recommended.length === 0) {
            console.debug(`${logPrefix} No content to display after filtering library items`);
            return;
        }
        if (signal.aborted) return;

        const placed = rows.placeRows(rows.newRun(itemId, signal, { page: pageReady, recommended, similar, sameAccount }));
        // The data is ready and the rows placed or scheduled.
        if (placed && metrics?.metrics?.enabled) metrics.endMeasurement?.('similar-recommended');
    } catch (error) {
        // Not marked as processed, so a retry is possible.
        if (isAbort(error)) {
            console.debug(`${logPrefix} Request aborted for item ${itemId}`);
            return;
        }
        console.error(`${logPrefix} Error rendering similar and recommended sections:`, error);
    }
}

/**
 * Polls until `predicate` is truthy, the signal fires or the timeout passes. For conditions
 * that depend on attribute or text changes, which the shared body observer does not report.
 */
function pollUntil<T>(predicate: () => T | null, signal: AbortSignal, intervalMs: number, timeoutMs: number): Promise<T | null> {
    return new Promise(resolve => {
        if (signal.aborted) {
            resolve(null);
            return;
        }
        const immediate = predicate();
        if (immediate) {
            resolve(immediate);
            return;
        }
        const deadline = Date.now() + timeoutMs;
        let timer: number | undefined;
        const finish = (value: T | null) => {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            resolve(value);
        };
        const onAbort = () => finish(null);
        signal.addEventListener('abort', onAbort, { once: true });
        const tick = () => {
            if (signal.aborted) {
                finish(null);
                return;
            }
            const result = predicate();
            if (result) {
                finish(result);
                return;
            }
            if (Date.now() >= deadline) {
                finish(null);
                return;
            }
            timer = window.setTimeout(tick, intervalMs);
        };
        timer = window.setTimeout(tick, intervalMs);
    });
}

/**
 * The Seasons heading of the shown Series page, once visible. Jellyfin renders the list in
 * #listChildrenCollapsible; its h2 holds an initially empty span. A view still shown for
 * another item is not this item's: Jellyfin adds a new view before hiding the old one.
 */
function waitForSeasonsHeading(itemId: string, signal: AbortSignal): Promise<HTMLElement | null> {
    return pollUntil(() => {
        const activePage = document.querySelector('.libraryPage:not(.hide)');
        if (!activePage || rows.shownForOther(activePage, itemId)) return null;
        const collapsible = activePage.querySelector('#listChildrenCollapsible');
        if (!collapsible || collapsible.classList.contains('hide')) return null;
        const heading = collapsible.querySelector<HTMLElement>('h2.sectionTitle.sectionTitle-cards');
        if (!heading || heading.classList.contains('hide')) return null;
        return heading.querySelector('span')?.textContent?.trim() ? heading : null;
    }, signal, 100, 5000);
}

/** The season check, which can load after this script: scripts load one by one. */
function waitForChecker(signal: AbortSignal): Promise<UnrequestedSeasonsCheck | null> {
    return pollUntil(() => {
        const check = JE.jellyseerrMoreInfo?.checkForUnrequestedSeasons;
        return typeof check === 'function' ? check : null;
    }, signal, 50, 3000);
}

function buildSeriesRequestMoreButton(tvDetails: JsonRecord, stale: () => boolean): HTMLButtonElement {
    const label = t('jellyseerr_btn_request_more', 'Request More');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `jellyseerr-request-button jellyseerr-button-request ${REQUEST_MORE_BTN_CLASS}`;
    button.title = label;
    // So the button sits next to the h2 text without its font size or block layout.
    button.style.display = 'inline-flex';
    button.style.alignItems = 'center';
    button.style.verticalAlign = 'middle';
    button.style.fontSize = '0.85rem';
    button.style.padding = '0.4em 0.9em';
    button.style.marginLeft = '1em';

    const icon = document.createElement('span');
    icon.className = 'material-icons';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = 'download';
    icon.style.marginRight = '0.4em';
    icon.style.fontSize = '1.1em';
    const text = document.createElement('span');
    text.textContent = label;
    button.appendChild(icon);
    button.appendChild(text);

    button.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        if (stale()) return;
        JE.jellyseerrUI?.showSeasonSelectionModal?.(tmdbIdOf(tvDetails), 'tv', filled(tvDetails.name) ?? anyTitle(tvDetails), tvDetails);
    });
    return button;
}

/** The Request More check itself; see renderSeriesRequestMoreButton. */
async function runSeriesRequestMoreCheck(itemId: string): Promise<void> {
    requestMoreAbortController?.abort();
    const controller = new AbortController();
    requestMoreAbortController = controller;
    const { signal } = controller;
    const sameAccount = identityLease(JE);
    const stale = () => signal.aborted || !sameAccount();
    try {
        if (!JE.pluginConfig?.JellyseerrEnabled || JE.pluginConfig.JellyseerrShowRequestMoreOnSeries === false) return;
        const api = JE.jellyseerrAPI;
        if (!api) return;
        const status = record(await api.checkUserStatus());
        if (stale() || !status?.active) return;
        const { tmdbId, type } = await getTmdbIdFromItem(itemId, signal);
        if (stale() || !tmdbId || type !== 'tv') return;
        const tvDetails = await api.fetchTvShowDetails(tmdbId);
        if (stale() || !isRecord(tvDetails)) return;

        // The check lives in a script that can still be loading on a cold start.
        const checker = await waitForChecker(signal);
        if (stale()) return;
        if (!checker) {
            console.warn(`${requestMoreLogPrefix} checkForUnrequestedSeasons unavailable after 3s, skipping`);
            return;
        }
        const hasUnrequested = await checker(tvDetails, signal);
        if (stale()) return;
        const name = filled(tvDetails.name) ?? anyTitle(tvDetails);
        if (!hasUnrequested) {
            // Negative results count too: each check costs a request to Seerr, and a
            // viewshow for this item would repeat it. Navigation clears this set.
            processedRequestMoreItems.add(itemId);
            console.debug(`${requestMoreLogPrefix} No unrequested seasons for "${name}"`);
            return;
        }
        const heading = await waitForSeasonsHeading(itemId, signal);
        if (stale()) return;
        if (!heading) {
            console.debug(`${requestMoreLogPrefix} Seasons heading not found, skipping`);
            return;
        }
        if (heading.querySelector(`.${REQUEST_MORE_BTN_CLASS}`)) {
            processedRequestMoreItems.add(itemId);
            return;
        }
        // A class rather than heading.style: discoverable in CSS, and Jellyfin's inline
        // display value on the heading stays as it was.
        heading.classList.add('je-series-request-more-heading');
        heading.appendChild(buildSeriesRequestMoreButton(tvDetails, () => !sameAccount()));
        processedRequestMoreItems.add(itemId);
        console.debug(`${requestMoreLogPrefix} Added Request More button for "${name}"`);
    } catch (error) {
        if (isAbort(error)) {
            console.debug(`${requestMoreLogPrefix} Aborted for item ${itemId}`);
            return;
        }
        console.error(`${requestMoreLogPrefix} Error rendering button:`, error);
    }
}

/** Renders the button when a show has unrequested seasons, once per page. */
function renderSeriesRequestMoreButton(itemId: string): Promise<void> {
    if (processedRequestMoreItems.has(itemId)) return Promise.resolve();
    // Already being checked for this page: share it rather than abort and repeat its lookups.
    const inFlight = requestMoreInFlight.get(itemId);
    if (inFlight) return inFlight;
    const run: Promise<void> = runSeriesRequestMoreCheck(itemId).finally(() => {
        if (requestMoreInFlight.get(itemId) === run) requestMoreInFlight.delete(itemId);
    });
    requestMoreInFlight.set(itemId, run);
    return run;
}

function handleItemDetailsPage(): void {
    const itemId = detailsItemIdFromHash();
    if (!itemId) return;
    // In sync with the rendering cycle rather than after a fixed delay.
    requestAnimationFrame(() => {
        // Not for an item the user has already left: cleanup ran for that navigation before this frame.
        if (detailsItemIdFromHash() !== itemId) return;
        void renderSimilarAndRecommended(itemId);
        void renderSeriesRequestMoreButton(itemId);
    });
}

/** Stops the page's work. A pending row build is kept for the view being left (see deferRows). */
function cleanup(): void {
    currentAbortController?.abort();
    currentAbortController = null;
    requestMoreAbortController?.abort();
    requestMoreAbortController = null;
    processedItems.clear();
    processedRequestMoreItems.clear();
    // The aborted check would otherwise be joined by a run for the same item started before it unwound.
    requestMoreInFlight.clear();
}

function injectRequestMoreStyles(): void {
    if (document.getElementById('je-series-request-more-styles')) return;
    const style = document.createElement('style');
    style.id = 'je-series-request-more-styles';
    style.textContent = `
            h2.sectionTitle.sectionTitle-cards.je-series-request-more-heading {
                display: flex;
                align-items: center;
                flex-wrap: wrap;
            }
        `;
    document.head.appendChild(style);
}

function initialize(): void {
    console.debug(`${logPrefix} Initializing Recommendations and Similar sections`);
    injectRequestMoreStyles();
    const core = JE.core;
    if (!core?.lifecycle || !core.navigation) return;

    // Teardown runs on every navigation, hashchange, popstate and pushState alike, and is
    // wired first so cleanup always runs before handleItemDetailsPage.
    const lifecycle = core.lifecycle.register('jellyseerr-item-details');
    lifecycle.onTeardown(cleanup);
    lifecycle.teardownOn('navigate');
    // Everything in flight belongs to the account that started it.
    JE.session?.onUserChange?.('jellyseerr-item-details', cleanup);
    core.navigation.onNavigate(() => handleItemDetailsPage());

    handleItemDetailsPage();

    core.navigation.onViewPage((_view, _element, _hash, _item, rawEvent) => {
        rows.noteViewItem(rawEvent);
        handleItemDetailsPage();
    });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize);
else initialize();
