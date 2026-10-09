// /js/jellyseerr/item-details.js
// Adds Similar and Recommended sections to item details pages using Jellyseerr API.
// Also adds a "Request More" button next to the Seasons section heading on
// Series detail pages when the show has unrequested seasons in Seerr.
(function(JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced: Seerr Item Details:';
    const requestMoreLogPrefix = '🪼 Jellyfin Enhanced: Series Request More:';

    // Track processed items to avoid duplicate renders
    const processedItems = new Set();
    const processedRequestMoreItems = new Set();
    // Request More checks in flight, by item id. onNavigate and onViewPage
    // both start one for the same page; the second joins the first instead
    // of aborting it and re-issuing its lookups.
    /** @type {Map<string, Promise<void>>} */
    const requestMoreInFlight = new Map();

    // CSS class used to mark and dedupe the injected Request More button
    const REQUEST_MORE_BTN_CLASS = 'je-series-request-more-btn';

    // When the Seerr data comes back before Jellyfin has rendered the item,
    // the rows are built with that render (see deferRows): an empty marker
    // holds their place after More Like This until then.
    const PENDING_ROWS_CLASS = 'je-seerr-rows-pending';
    // Counted from scheduling, for an item Jellyfin never renders.
    const NAME_WAIT_MS = 5000;
    // A step of the rows' prebuild outside an idle callback (see whenIdle).
    const PREBUILD_SLICE_MS = 8;
    // Elements that never take up space, wherever they sit.
    const NON_RENDERED_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META']);

    // Current abort controllers for cancellation. Separate controllers prevent
    // the slower similar/recommended fetch from cancelling the Request More
    // check (and vice versa) when the user navigates between detail pages.
    let currentAbortController = null;
    let requestMoreAbortController = null;
    // The current run's rows waiting on a view (see deferRows), so the shown
    // view's viewshow run can send them there: { itemId, retarget }.
    let waitingRows = null;
    // The item each view was shown for, from Jellyfin's viewshow. A view
    // keeps its URL for its life (Back and Forward restore it, a new visit
    // builds a new one), so a build kept for a view the user left is only
    // ever for that view's own item (see deferRows).
    /** @type {WeakMap<Element, string>} */
    const viewItems = new WeakMap();
    // Markers of the builds kept for a view the user left (see deferRows).
    /** @type {WeakSet<Element>} */
    const leftMarkers = new WeakSet();

    /**
     * Gets the TMDB ID from a Jellyfin item
     * @param {string} itemId - Jellyfin item ID
     * @param {AbortSignal} [signal] - Optional abort signal
     * @returns {Promise<{tmdbId: number|null, type: string|null}>}
     */
    async function getTmdbIdFromItem(itemId, signal) {
        try {
            // Check for abort before making request
            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }

            const userId = ApiClient.getCurrentUserId();
            const item = JE.helpers?.getItemCached
                ? await JE.helpers.getItemCached(itemId, { userId })
                : await ApiClient.getItem(userId, itemId);

            // Check for abort after request
            if (signal?.aborted) {
                throw new DOMException('Aborted', 'AbortError');
            }

            if (!item) {
                console.warn(`${logPrefix} Item not found:`, itemId);
                return { tmdbId: null, type: null };
            }

            // Check if item is Movie or Series
            const itemType = item.Type;
            if (itemType !== 'Movie' && itemType !== 'Series') {
                return { tmdbId: null, type: null };
            }

            // Get TMDB ID from provider IDs
            const tmdbId = item.ProviderIds?.Tmdb;
            if (!tmdbId) {
                console.warn(`${logPrefix} No TMDB ID found for item:`, item.Name);
                return { tmdbId: null, type: null };
            }

            const type = itemType === 'Movie' ? 'movie' : 'tv';
            return { tmdbId: parseInt(tmdbId), type };
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            console.error(`${logPrefix} Error getting TMDB ID:`, error);
            return { tmdbId: null, type: null };
        }
    }

    /**
     * The shown view's details content and More Like This, when it has them.
     * @returns {{detailPageContent: HTMLElement, moreLikeThisSection: HTMLElement}|null}
     */
    function findDetailPage() {
        const activePage = document.querySelector('.libraryPage:not(.hide)');
        if (!activePage) return null;

        // Jellyfin 12 dropped the .detailPageContent wrapper; fall back to
        // .detailPageSecondaryContainer, then the page itself. #similarCollapsible
        // (our insertion anchor) still exists inside it on both lines.
        const detailPageContent = activePage.querySelector('.detailPageContent') ||
                                  activePage.querySelector('.detailPageSecondaryContainer') ||
                                  activePage;
        const moreLikeThisSection = detailPageContent?.querySelector('#similarCollapsible');

        if (detailPageContent && moreLikeThisSection) {
            return { detailPageContent, moreLikeThisSection };
        }
        return null;
    }

    /**
     * Wait for the detail page content to be ready
     * @param {AbortSignal} [signal] - Optional abort signal
     * @returns {Promise<HTMLElement|null>}
     */
    function waitForDetailPageReady(signal) {
        return new Promise((resolve) => {
            // Check for abort
            if (signal?.aborted) {
                resolve(null);
                return;
            }

            // Try immediately
            const immediate = findDetailPage();
            if (immediate) {
                resolve(immediate);
                return;
            }

            // Set up observer
            let observerHandle = null;
            let timeoutId = null;

            const cleanup = () => {
                if (observerHandle) {
                    observerHandle.unsubscribe();
                    observerHandle = null;
                }
                if (timeoutId) {
                    clearTimeout(timeoutId);
                    timeoutId = null;
                }
            };

            // Handle abort
            if (signal) {
                signal.addEventListener('abort', () => {
                    cleanup();
                    resolve(null);
                }, { once: true });
            }

            observerHandle = JE.helpers.onBodyMutation('jellyseerr-item-details-page-detect', () => {
                const result = findDetailPage();
                if (result) {
                    cleanup();
                    resolve(result);
                }
            });

            // Timeout fallback (3 seconds)
            timeoutId = setTimeout(() => {
                cleanup();
                const result = findDetailPage();
                resolve(result);
            }, 3000);
        });
    }

    /**
     * The results a section shows: the exclude-library and Hidden Content
     * filters, read now.
     * @param {Array} results - Array of Jellyseerr items
     * @returns {Array}
     */
    function sectionResults(results) {
        if (!results || results.length === 0) {
            return [];
        }

        // Filter out library items if configured
        const excludeLibraryItems = JE.pluginConfig?.JellyseerrExcludeLibraryItems === true;
        let filteredResults = results;

        if (excludeLibraryItems) {
            filteredResults = results.filter(item => !item.mediaInfo?.jellyfinMediaId);
        }
        if (JE.hiddenContent) {
            filteredResults = JE.hiddenContent.filterJellyseerrResults(filteredResults, 'recommendations');
        }
        return filteredResults;
    }

    /**
     * Creates a Jellyseerr section similar to search results
     * @param {Array} results - Array of Jellyseerr items
     * @param {string} title - Section title (already translated)
     * @returns {HTMLElement} - Section element
     */
    function createJellyseerrSection(results, title) {
        const filteredResults = sectionResults(results);
        if (filteredResults.length === 0) {
            return null;
        }

        const { section, itemsContainer } = createSectionShell(title);

        // Use DocumentFragment for batch DOM insertion
        const fragment = document.createDocumentFragment();

        // Add items to container
        for (const item of filteredResults) {
            const card = createSectionCard(item);
            if (card) fragment.appendChild(card);
        }

        itemsContainer.appendChild(fragment);
        return section;
    }

    /**
     * A section without its cards: the title and the row they go in.
     * @param {string} title - Section title (already translated)
     * @returns {{section: HTMLElement, itemsContainer: HTMLElement}}
     */
    function createSectionShell(title) {
        const section = document.createElement('div');
        section.className = 'verticalSection emby-scroller-container jellyseerr-details-section';
        section.setAttribute('data-jellyseerr-section', 'true');

        const titleElement = document.createElement('h2');
        titleElement.className = 'sectionTitle sectionTitle-cards focuscontainer-x padded-right';
        titleElement.textContent = title || 'Recommended';
        section.appendChild(titleElement);

        const scrollerContainer = document.createElement('div');
        scrollerContainer.setAttribute('is', 'emby-scroller');
        scrollerContainer.className = 'padded-top-focusscale padded-bottom-focusscale no-padding emby-scroller';
        scrollerContainer.dataset.horizontal = "true";
        scrollerContainer.dataset.centerfocus = "card";
        scrollerContainer.dataset.scrollModeX = "custom";

        // Enable smooth native horizontal touch scrolling (from KefinTweaks)
        scrollerContainer.style.scrollSnapType = 'none';
        scrollerContainer.style.touchAction = 'auto';
        scrollerContainer.style.overscrollBehaviorX = 'contain';
        scrollerContainer.style.overscrollBehaviorY = 'auto';
        scrollerContainer.style.webkitOverflowScrolling = 'touch';

        const itemsContainer = document.createElement('div');
        itemsContainer.setAttribute('is', 'emby-itemscontainer');
        itemsContainer.className = 'focuscontainer-x itemsContainer scrollSlider animatedScrollX';
        itemsContainer.style.whiteSpace = 'nowrap';

        scrollerContainer.appendChild(itemsContainer);
        section.appendChild(scrollerContainer);
        return { section, itemsContainer };
    }

    /**
     * A section's card for one result.
     * @param {object} item - A Jellyseerr item
     * @returns {HTMLElement|null}
     */
    function createSectionCard(item) {
        const card = JE.jellyseerrUI && JE.jellyseerrUI.createJellyseerrCard
            ? JE.jellyseerrUI.createJellyseerrCard(item, true, true)
            : null;
        if (card) {
            const titleLink = card.querySelector('.cardText-first a');

            // If item exists in library, link to library item
            const jellyfinMediaId = item.mediaInfo?.jellyfinMediaId;
            if (jellyfinMediaId) {
                card.setAttribute('data-library-item', 'true');
                card.setAttribute('data-jellyfin-media-id', jellyfinMediaId);
                card.classList.add('jellyseerr-card-in-library');
                // Update title link to point to library item
                if (titleLink) {
                    const itemName = item.title || item.name;
                    titleLink.textContent = itemName;
                    titleLink.title = itemName;
                    titleLink.href = `#!/details?id=${jellyfinMediaId}`;
                    titleLink.removeAttribute('target');
                    titleLink.removeAttribute('rel');
                }
            }
        }
        return card;
    }

    /**
     * The item id of the details page in the URL, or null on any other page.
     * @returns {string|null}
     */
    function detailsItemIdFromHash() {
        const hash = window.location.hash;
        if (!hash.includes('/details?id=')) return null;
        return new URLSearchParams(hash.split('?')[1]).get('id');
    }

    /**
     * Starts Similar and Recommended for an item in the next frame, unless
     * the URL has moved on to another item by then: cleanup() has already
     * run for that navigation, so nothing would stop this run.
     * @param {string} itemId - Jellyfin item ID
     */
    function scheduleSimilarAndRecommended(itemId) {
        requestAnimationFrame(() => {
            if (detailsItemIdFromHash() === itemId) renderSimilarAndRecommended(itemId);
        });
    }

    /** Whether Jellyfin has rendered the item into this details view. */
    function jellyfinRendered(page) {
        return !!page.querySelector('.nameContainer .itemName');
    }

    /**
     * Whether nothing that takes up space follows More Like This in the view,
     * so rows built later push nothing down that rows inserted now would not
     * have. A div right after it, even a hidden one, is refused as well: it
     * changes where the immediate insert puts Similar (:last-of-type), and
     * the deferred build would not reproduce that. Reads no layout.
     */
    function nothingFollows(anchor, page) {
        for (let node = anchor; node !== page; node = node.parentElement) {
            if (!node) return false;
            for (let next = node.nextElementSibling; next; next = next.nextElementSibling) {
                if (next.classList.contains(PENDING_ROWS_CLASS)) continue;
                if (node === anchor && next.tagName === 'DIV') return false;
                if (NON_RENDERED_TAGS.has(next.tagName) || next.hidden || next.classList.contains('hide')) continue;
                return false;
            }
        }
        return true;
    }

    /** Releases a run's claim on its item so a later viewshow can retry it. */
    function releaseClaim({ itemId, signal }) {
        // Not after an abort: cleanup() cleared the claims and a newer run
        // may hold this item's by now.
        if (!signal.aborted) processedItems.delete(itemId);
    }

    /**
     * Records the item a view is shown for: Jellyfin dispatches viewshow on
     * the view, with the URL's parameters.
     * @param {CustomEvent|null} rawEvent - The raw viewshow event
     */
    function noteViewItem(rawEvent) {
        const view = rawEvent?.target;
        const itemId = rawEvent?.detail?.params?.id;
        if (itemId && view?.nodeType === 1) viewItems.set(view, itemId);
    }

    /**
     * Whether a view was shown for another item: a run can find the
     * outgoing view, still shown (see deferRows). Not known before the
     * view's first viewshow.
     */
    function shownForOther(page, itemId) {
        const shownFor = page ? viewItems.get(page) : undefined;
        return shownFor !== undefined && shownFor !== itemId;
    }

    /** Whether the identity a run started under is still the signed-in one. */
    function sessionCurrent(epoch) {
        return epoch === undefined || typeof JE.session?.isCurrent !== 'function' || JE.session.isCurrent(epoch);
    }

    /**
     * Whether the rows can wait: Jellyfin has not rendered the item yet, in a
     * visible view that has no Seerr rows (a restored view is replaced in
     * place at once) and where nothing follows More Like This.
     */
    function canDeferRows({ page, detailPageContent, anchor }) {
        if (!page || !page.isConnected || page.classList.contains('hide') || !page.querySelector('.nameContainer')) return false;
        if (detailPageContent.querySelector('.jellyseerr-details-section')) return false;
        if (jellyfinRendered(page)) return false;
        return nothingFollows(anchor, page);
    }

    /**
     * Inserts a run's rows into its view, when it is still the shown view of
     * the item in the URL for the identity the run started under.
     * @param {object} ctx - The run: itemId, signal, epoch, page, detailPageContent, anchor, recommended, similar,
     *   and the deferred build's prebuilt rows, if any (see prebuildRows)
     * @param {HTMLElement|null} marker - The deferred build's placeholder
     * @returns {boolean} Whether the rows were inserted (from a hidden view:
     *   placed in the shown one, see placeRows)
     */
    function commitRows(ctx, marker) {
        const { itemId, signal, epoch, page, anchor } = ctx;
        if (signal.aborted) return false;
        if (detailsItemIdFromHash() !== itemId) return false;
        if (!sessionCurrent(epoch)) {
            releaseClaim(ctx);
            return false;
        }
        if (page ? (!page.isConnected || page.classList.contains('hide')) : !anchor.isConnected) {
            // Never into a cached or hidden view. The rows go to the details
            // view that is shown, from this run's data, and a viewshow run
            // for it returns early: a new run would ask again for what is not
            // cached (an endpoint that failed, an expired item).
            const shown = findDetailPage();
            const shownPage = shown ? shown.moreLikeThisSection.closest('.libraryPage') : null;
            if (shownPage && shownPage !== page) {
                if (placeRows({
                    ...ctx,
                    page: shownPage,
                    detailPageContent: shown.detailPageContent,
                    anchor: shown.moreLikeThisSection
                })) return true;
                releaseClaim(ctx);
                return false;
            }
            // No details view shown: run again once there is one.
            releaseClaim(ctx);
            const visible = document.querySelector('.libraryPage:not(.hide)');
            if (visible && visible !== page) scheduleSimilarAndRecommended(itemId);
            return false;
        }
        insertRows(ctx, marker);
        return true;
    }

    /**
     * Removes the waiting builds' markers for an item (see deferRows), but
     * `keep`. Another item's build kept for its own view stays. In a view
     * shown for this item, another item's kept build goes too: it was kept
     * before the view's viewshow told whose it is.
     */
    function removeMarkers(page, root, itemId, keep = null) {
        const own = !!page && viewItems.get(page) === itemId;
        root.querySelectorAll(`.${PENDING_ROWS_CLASS}`).forEach((el) => {
            if (el === keep) return;
            if (el.dataset.itemId === itemId || (own && leftMarkers.has(el))) el.remove();
        });
    }

    /**
     * Inserts the rows of a build kept for a view the user left (see
     * deferRows): into that view, shown or not, where they were inserted
     * with their data before. Not once the view is gone, a newer build or
     * insert in it has taken its marker away, it turned out to be another
     * item's view, or another user signed in.
     * @param {object} ctx - See commitRows
     * @param {HTMLElement} marker - The build's placeholder
     */
    function commitLeftRows(ctx, marker) {
        if (!ctx.page.isConnected || !marker.isConnected || !sessionCurrent(ctx.epoch)) return;
        if (shownForOther(ctx.page, ctx.itemId)) return;
        insertRows(ctx, marker);
    }

    /**
     * Inserts the Similar and Recommended rows; the only insertion point.
     * Without a marker they go after More Like This exactly as they always
     * have; with one, before the marker, which is the same place when
     * nothing followed More Like This at scheduling (see nothingFollows).
     * @param {object} ctx - See commitRows
     * @param {HTMLElement|null} marker - The deferred build's placeholder
     */
    function insertRows(ctx, marker) {
        const { itemId, page, detailPageContent, anchor } = ctx;
        // A build for this item still kept from when the user left the view
        // gives way.
        removeMarkers(page, detailPageContent, itemId, marker);
        // Remove any existing Jellyseerr sections to avoid duplicates (their
        // cards must be unobserved first: lazy posters hold strong references).
        // Before the new cards exist: detached cards are released too.
        // Prebuilt ones wait in a DocumentFragment, which this leaves alone.
        JE.jellyseerrUI?.releasePosters?.(detailPageContent);
        detailPageContent.querySelectorAll('.jellyseerr-details-section').forEach(el => el.remove());

        const before = marker?.isConnected ? marker : null;

        // Create and insert sections: Recommended, then Similar
        for (const row of rowSpecs(ctx)) {
            const section = rowSection(ctx, row);
            if (!section) continue;
            if (before) {
                before.before(section);
            } else if (row.name === 'Similar') {
                const lastJellyseerrSection = detailPageContent.querySelector('.jellyseerr-details-section:last-of-type');
                if (lastJellyseerrSection) {
                    lastJellyseerrSection.after(section);
                } else {
                    anchor.after(section);
                }
            } else {
                anchor.after(section);
            }
            console.debug(`${logPrefix} Added ${row.name} section with ${row.total} items`);
        }
    }

    /**
     * The rows a run inserts, in order, with what each is built from.
     * @param {object} ctx - See commitRows
     * @returns {Array<{name: string, results: Array, title: string, total: number}>}
     */
    function rowSpecs({ recommended, similar }) {
        const rows = [];
        if (recommended.length > 0) {
            const title = JE.t ? (JE.t('jellyseerr_recommended_title') || 'Recommended') : 'Recommended';
            rows.push({ name: 'Recommended', results: recommended.slice(0, 20), title, total: recommended.length });
        }
        if (similar.length > 0) {
            const title = JE.t ? (JE.t('jellyseerr_similar_title') || 'Similar') : 'Similar';
            rows.push({ name: 'Similar', results: similar.slice(0, 20), title, total: similar.length });
        }
        return rows;
    }

    /**
     * A row's section: the one prebuilt for it (see prebuildRows) when that is
     * what building it now gives, else built now.
     * @param {object} ctx - See commitRows
     * @param {{name: string, results: Array, title: string}} row - See rowSpecs
     * @returns {HTMLElement|null}
     */
    function rowSection(ctx, row) {
        const prebuilt = ctx.prebuilt?.take(row);
        return prebuilt ? prebuilt.section : createJellyseerrSection(row.results, row.title);
    }

    /** Whether two lists hold the same items in the same order. */
    function sameItems(a, b) {
        return a.length === b.length && a.every((item, i) => item === b[i]);
    }

    /**
     * Runs a step of a prebuild when nothing else is waiting to run: as a
     * background task, else when the browser is idle, else in a task of its
     * own. Outside an idle callback (whose deadline can be 50 ms, long enough
     * to hold up a response that lands meanwhile) a step gets
     * PREBUILD_SLICE_MS.
     * @param {function({timeRemaining: function(): number}): void} fn
     * @returns {function(): void} Cancels the step
     */
    function whenIdle(fn) {
        const sliced = () => {
            const end = performance.now() + PREBUILD_SLICE_MS;
            fn({ timeRemaining: () => Math.max(0, end - performance.now()) });
        };
        if (typeof scheduler !== 'undefined' && typeof scheduler?.postTask === 'function') {
            const controller = new AbortController();
            scheduler.postTask(sliced, { priority: 'background', signal: controller.signal }).catch(() => {});
            return () => controller.abort();
        }
        if (typeof requestIdleCallback === 'function') {
            const id = requestIdleCallback(fn);
            return () => cancelIdleCallback(id);
        }
        const id = setTimeout(sliced, 0);
        return () => clearTimeout(id);
    }

    /**
     * Builds a waiting run's rows ahead of Jellyfin's render (see deferRows),
     * a few cards at a time when nothing else is waiting to run (see
     * whenIdle), so that render only has to insert them. They wait in a
     * DocumentFragment: releasePosters leaves cards there alone (insertRows
     * runs it before inserting), and their posters stay unloaded, as the
     * poster observer sees them as off screen until they are in the page,
     * where they then load as they would have.
     *
     * A prebuilt row is used only when building it at insertion would give
     * the same: same results, title and filters (exclude-library, Hidden
     * Content), and the same card inputs (cardInputsKey: settings, labels,
     * hidden state), checked again at each step and at insertion. Anything
     * else, or a row not started by then, is built at insertion as before; a
     * row part built is finished there. Whatever is not taken is released.
     * @param {object} ctx - See commitRows
     * @returns {{take: function(object): ({section: HTMLElement|null}|null), release: function(): void}|null}
     *   null where cards would load their posters as they are built
     */
    function prebuildRows(ctx) {
        if (typeof IntersectionObserver !== 'function') return null;
        const holder = document.createDocumentFragment();
        const rows = rowSpecs(ctx).map(row => ({ ...row, filtered: null, key: undefined, section: null, itemsContainer: null, built: 0, taken: false }));
        const inputsKey = (items) => JE.jellyseerrUI?.cardInputsKey?.(items);
        let usable = true;
        let next = 0;
        let cancelStep = null;

        const release = () => {
            usable = false;
            cancelStep?.();
            cancelStep = null;
            if (!holder.firstChild) return;
            JE.jellyseerrUI?.releasePosters?.(holder);
            holder.replaceChildren();
        };
        const buildCard = (row) => {
            const card = createSectionCard(row.filtered[row.built++]);
            if (card) row.itemsContainer.appendChild(card);
        };
        // The next card, or the next row's start; false once all are built.
        const buildNext = () => {
            const row = rows[next];
            if (!row) return false;
            if (!row.filtered) {
                row.filtered = sectionResults(row.results);
                row.key = inputsKey(row.filtered);
                if (row.filtered.length > 0) {
                    ({ section: row.section, itemsContainer: row.itemsContainer } = createSectionShell(row.title));
                    holder.appendChild(row.section);
                }
            } else {
                buildCard(row);
            }
            if (row.built === row.filtered.length) next++;
            return true;
        };
        const step = (deadline) => {
            cancelStep = null;
            if (!usable) return;
            try {
                if (!sessionCurrent(ctx.epoch) || rows.some(row => row.filtered && inputsKey(row.filtered) !== row.key)) {
                    release();
                    return;
                }
                do {
                    if (!buildNext()) return;
                } while (deadline.timeRemaining() > 0);
            } catch (_) {
                // Built again at insertion, which reports the failure.
                release();
                return;
            }
            cancelStep = whenIdle(step);
        };

        /**
         * The row's section (null: no cards to show), finished now if need
         * be; null when it is to be built at insertion instead.
         * @param {{name: string, results: Array, title: string}} spec - See rowSpecs
         */
        const take = (spec) => {
            const row = usable ? rows.find(r => r.name === spec.name) : null;
            if (!row || row.taken || !row.filtered || row.title !== spec.title || !sameItems(row.results, spec.results)) return null;
            const filtered = sectionResults(spec.results);
            if (!sameItems(row.filtered, filtered) || inputsKey(filtered) !== row.key) return null;
            while (row.built < row.filtered.length) buildCard(row);
            row.taken = true;
            const section = row.section;
            section?.remove();
            return { section };
        };

        cancelStep = whenIdle(step);
        return { take, release };
    }

    /**
     * Builds the rows when Jellyfin renders the item's name, so they are not
     * painted on the empty template and then pushed down by that render.
     * The name observer's callback runs before the next paint, so the rows
     * are already there in the first frame that shows Jellyfin's render: the
     * page never ends at More Like This without them, as it never did when
     * they were inserted with their data. A page Jellyfin never renders gets
     * them after NAME_WAIT_MS; printing builds them at once. The data and
     * the claim on the item are already there.
     *
     * Leaving the view (the abort) keeps the build for it: its rows used to
     * be inserted with their data, so a view restored by Back or Forward had
     * them from its first frame (the run there replaces them in place). They
     * are built into the left view, hidden or not, with Jellyfin's render of
     * it, after NAME_WAIT_MS or for printing (a view restored before its
     * render printed them), unless it is gone, another build has taken it
     * over or another user signed in (see commitLeftRows). Only for the
     * item's own view: a build waiting on another item's view (see below) is
     * dropped, as before, so that item's rows stay. A view's item is known
     * from its viewshow; a build kept before that checks again as it builds.
     *
     * Jellyfin adds a new view before it hides the one it leaves, so the run
     * may have found the outgoing view, still shown. When that view is hidden
     * (or gone) while the URL is still this item's and another details view
     * is shown, the rows go there at once (commitRows), not with the hidden
     * view's render or after NAME_WAIT_MS. So does that view's viewshow run.
     *
     * Building the cards takes long enough on a cold page to hold back the
     * render it waits for, so they are built while the rows wait, when the
     * browser is idle (see prebuildRows): the render's task then only inserts
     * them, at the same moment and in the same place. What has not been
     * built by then, or no longer matches what would be built, is built
     * there as before.
     * @param {object} ctx - See commitRows
     * @returns {boolean} Whether the rows were scheduled (or inserted)
     */
    function deferRows(ctx) {
        const { itemId, signal, page, anchor } = ctx;
        const marker = document.createElement('div');
        marker.className = PENDING_ROWS_CLASS;
        marker.dataset.itemId = itemId;
        marker.setAttribute('aria-hidden', 'true');

        let done = false;
        let left = false;
        let nameObserver = null;
        let nameTimer = null;
        let prebuilt = null;
        // Not before a details view is shown: commitRows would release the
        // item and a new run would ask again for what is not cached.
        const movedOn = () => !left && (!page.isConnected || page.classList.contains('hide'))
            && detailsItemIdFromHash() === itemId && !!findDetailPage();
        const waiting = { itemId, retarget: () => { if (movedOn()) run(); } };

        // No longer the current run's: its abort and the shown view's
        // viewshow run leave the build alone. Printing still builds it.
        const detach = () => {
            signal.removeEventListener('abort', onAbort);
            if (waitingRows === waiting) waitingRows = null;
        };
        const dispose = () => {
            done = true;
            nameObserver?.disconnect();
            clearTimeout(nameTimer);
            window.removeEventListener('beforeprint', run);
            detach();
        };
        const drop = () => {
            dispose();
            marker.remove();
            prebuilt?.release();
        };
        const onAbort = () => {
            if (page.isConnected && sessionCurrent(ctx.epoch) && !shownForOther(page, itemId)) {
                left = true;
                leftMarkers.add(marker);
                detach();
                return;
            }
            drop();
        };

        function run() {
            if (done) return;
            dispose();
            try {
                if (left) commitLeftRows(ctx, marker);
                else commitRows(ctx, marker);
            } catch (error) {
                releaseClaim(ctx);
                console.error(`${logPrefix} Error rendering similar and recommended sections:`, error);
            } finally {
                marker.remove();
                prebuilt?.release();
            }
        }

        try {
            removeMarkers(page, page, itemId);
            anchor.after(marker);
            signal.addEventListener('abort', onAbort, { once: true });
            window.addEventListener('beforeprint', run);
            nameObserver = new MutationObserver(() => {
                if (jellyfinRendered(page) || movedOn()) run();
            });
            nameObserver.observe(page.querySelector('.nameContainer'), { childList: true, subtree: true });
            nameObserver.observe(page, { attributes: true, attributeFilter: ['class'] });
            nameTimer = setTimeout(run, NAME_WAIT_MS);
            waitingRows = waiting;
        } catch (_) {
            // Insert now, as before.
            drop();
            let placed = false;
            try {
                placed = commitRows(ctx, null);
            } finally {
                if (!placed) releaseClaim(ctx);
            }
            return placed;
        }
        try {
            prebuilt = prebuildRows(ctx);
        } catch (_) {
            // Built with the render instead.
        }
        // Set even when null: a run sent here from another view's build
        // (commitRows) carries that build's prebuild, released once it ran.
        ctx.prebuilt = prebuilt;
        return true;
    }

    /**
     * Places a run's rows into its view: at once, or with Jellyfin's render
     * of the item (see deferRows). The item is claimed once they are placed
     * or waiting, so a viewshow run for it returns early.
     * @param {object} ctx - See commitRows
     * @returns {boolean} Whether the rows were placed (or are waiting)
     */
    function placeRows(ctx) {
        if (canDeferRows(ctx)) {
            // Claimed now, when the rows would otherwise have been
            // inserted, so a viewshow run for this page still returns
            // early. A build that does not happen releases the claim.
            processedItems.add(ctx.itemId);
            return deferRows(ctx);
        }
        const placed = commitRows(ctx, null);
        // Mark as successfully processed AFTER successful render
        if (placed) processedItems.add(ctx.itemId);
        return placed;
    }

    /**
     * Renders Similar and Recommended sections for an item
     * @param {string} itemId - Jellyfin item ID
     */
    async function renderSimilarAndRecommended(itemId) {
        // Prevent duplicate renders (check only - add after success)
        if (processedItems.has(itemId)) {
            // Rows still waiting on a view Jellyfin has since left go to the
            // shown one now (see deferRows).
            if (waitingRows?.itemId === itemId) waitingRows.retarget();
            return;
        }

        // Cancel any previous in-flight requests
        if (currentAbortController) {
            currentAbortController.abort();
        }
        currentAbortController = new AbortController();
        const signal = currentAbortController.signal;
        // The rows are not inserted for a user who signed in meanwhile.
        const epoch = typeof JE.session?.getEpoch === 'function' ? JE.session.getEpoch() : undefined;

        // Start metrics if enabled
        if (JE.requestManager?.metrics?.enabled) {
            JE.requestManager.startMeasurement('similar-recommended');
        }

        try {
            // Check configuration settings early
            const showSimilar = JE.pluginConfig?.JellyseerrShowSimilar === true;
            const showRecommended = JE.pluginConfig?.JellyseerrShowRecommended === true;

            if (!showSimilar && !showRecommended) {
                console.debug(`${logPrefix} Both similar and recommended sections are disabled in settings`);
                return;
            }

            // Check if Jellyseerr is active
            const status = await JE.jellyseerrAPI.checkUserStatus();
            if (signal.aborted) return;

            if (!status || !status.active) {
                console.debug(`${logPrefix} Jellyseerr is not active, skipping`);
                return;
            }

            // Get TMDB ID and type
            const { tmdbId, type } = await getTmdbIdFromItem(itemId, signal);
            if (signal.aborted) return;

            if (!tmdbId || !type) {
                console.debug(`${logPrefix} No valid TMDB ID found for item, skipping`);
                return;
            }

            console.debug(`${logPrefix} Fetching similar and recommended content for TMDB ID ${tmdbId} (${type})`);

            // Fetch only the data that's enabled, passing signal for cancellation
            const fetchOptions = { signal };
            const promises = [];

            if (showSimilar) {
                promises.push(
                    type === 'movie'
                        ? JE.jellyseerrAPI.fetchSimilarMovies(tmdbId, fetchOptions)
                        : JE.jellyseerrAPI.fetchSimilarTvShows(tmdbId, fetchOptions)
                );
            } else {
                promises.push(Promise.resolve({ results: [] }));
            }

            if (showRecommended) {
                promises.push(
                    type === 'movie'
                        ? JE.jellyseerrAPI.fetchRecommendedMovies(tmdbId, fetchOptions)
                        : JE.jellyseerrAPI.fetchRecommendedTvShows(tmdbId, fetchOptions)
                );
            } else {
                promises.push(Promise.resolve({ results: [] }));
            }

            // Wait for page to be ready in parallel with data fetch
            const [similarData, recommendedData, pageReady] = await Promise.all([
                ...promises,
                waitForDetailPageReady(signal)
            ]);

            if (signal.aborted) return;

            const similarResults = similarData?.results || [];
            const recommendedResults = recommendedData?.results || [];

            if (similarResults.length === 0 && recommendedResults.length === 0) {
                console.debug(`${logPrefix} No similar or recommended content to display`);
                return;
            }

            // Check page readiness
            if (!pageReady) {
                console.warn(`${logPrefix} Page not ready for insertion`);
                return;
            }

            const { detailPageContent, moreLikeThisSection } = pageReady;

            // Filter items if configured to exclude library items or blocklisted items (status 6)
            const excludeLibraryItems = JE.pluginConfig?.JellyseerrExcludeLibraryItems === true;
            const excludeBlocklistedItems = JE.pluginConfig?.JellyseerrExcludeBlocklistedItems === true;

            const filteredSimilarResults = similarResults.filter(item => {
                if (excludeLibraryItems && item.mediaInfo?.jellyfinMediaId) return false;
                if (excludeBlocklistedItems && item.mediaInfo?.status === JE.seerrStatus.MEDIA.BLOCKED) return false;
                return true;
            });

            const filteredRecommendedResults = recommendedResults.filter(item => {
                if (excludeLibraryItems && item.mediaInfo?.jellyfinMediaId) return false;
                if (excludeBlocklistedItems && item.mediaInfo?.status === JE.seerrStatus.MEDIA.BLOCKED) return false;
                return true;
            });

            if (filteredSimilarResults.length === 0 && filteredRecommendedResults.length === 0) {
                console.debug(`${logPrefix} No content to display after filtering library items`);
                return;
            }

            // Final abort check before DOM manipulation
            if (signal.aborted) return;

            const ctx = {
                itemId, signal, epoch,
                page: moreLikeThisSection.closest('.libraryPage'),
                detailPageContent,
                anchor: moreLikeThisSection,
                recommended: filteredRecommendedResults,
                similar: filteredSimilarResults
            };
            const placed = placeRows(ctx);

            // End metrics: the data is ready and the rows placed or scheduled
            if (placed && JE.requestManager?.metrics?.enabled) {
                JE.requestManager.endMeasurement('similar-recommended');
            }

        } catch (error) {
            // Silently ignore abort errors (don't mark as processed so retry is possible)
            if (error.name === 'AbortError') {
                console.debug(`${logPrefix} Request aborted for item ${itemId}`);
                return;
            }
            console.error(`${logPrefix} Error rendering similar and recommended sections:`, error);
        }
    }

    /**
     * Polls a predicate until it returns a truthy value, the abort signal
     * fires, or the timeout is reached. Returns the truthy value, or null
     * on abort/timeout. Used instead of MutationObserver subscriptions for
     * conditions that depend on attribute/characterData changes — the
     * project's shared body observer only dispatches on childList mutations
     * (helpers.js fast-paths attribute/text mutations at line 38), so an
     * observer-based wait would miss a `classList.remove('hide')` or a
     * `span.textContent = 'Series'` mutation entirely unless some unrelated
     * childList mutation happened to fire around the same time.
     * @param {() => any} predicate - Called repeatedly; truthy return resolves.
     * @param {object} [opts]
     * @param {number} [opts.intervalMs=100]
     * @param {number} [opts.timeoutMs=5000]
     * @param {AbortSignal} [opts.signal]
     * @returns {Promise<any|null>}
     */
    function pollUntil(predicate, opts = {}) {
        const { intervalMs = 100, timeoutMs = 5000, signal } = opts;
        return new Promise((resolve) => {
            if (signal?.aborted) {
                resolve(null);
                return;
            }
            const immediate = predicate();
            if (immediate) {
                resolve(immediate);
                return;
            }
            const deadline = Date.now() + timeoutMs;
            let timerId = null;
            const finish = (value) => {
                if (timerId) clearTimeout(timerId);
                if (signal) signal.removeEventListener('abort', onAbort);
                resolve(value);
            };
            const onAbort = () => finish(null);
            if (signal) signal.addEventListener('abort', onAbort, { once: true });
            const tick = () => {
                if (signal?.aborted) return finish(null);
                const result = predicate();
                if (result) return finish(result);
                if (Date.now() >= deadline) return finish(null);
                timerId = setTimeout(tick, intervalMs);
            };
            timerId = setTimeout(tick, intervalMs);
        });
    }

    /**
     * Waits for the Seasons section heading on a Series detail page to become
     * visible. On a Series page Jellyfin renders the seasons list inside
     * #listChildrenCollapsible (NOT #childrenCollapsible — that variant is
     * used for non-Series item types and stays hidden). The heading inside
     * is an h2.sectionTitle.sectionTitle-cards with a child <span> whose
     * text reads "Series" once Jellyfin has populated it.
     *
     * Uses polling instead of a MutationObserver because the readiness
     * conditions are attribute (`hide` class removal) and characterData
     * (span text set) mutations, which the project's shared body observer
     * does not dispatch on.
     *
     * @param {AbortSignal} [signal]
     * @returns {Promise<HTMLElement|null>}
     */
    function waitForSeasonsHeading(signal) {
        return pollUntil(() => {
            const activePage = document.querySelector('.libraryPage:not(.hide)');
            if (!activePage) return null;
            const collapsible = activePage.querySelector('#listChildrenCollapsible');
            if (!collapsible || collapsible.classList.contains('hide')) return null;
            const heading = collapsible.querySelector('h2.sectionTitle.sectionTitle-cards');
            if (!heading || heading.classList.contains('hide')) return null;
            // Wait until Jellyfin has populated the title span (initially empty)
            const span = heading.querySelector('span');
            if (!span || !span.textContent.trim()) return null;
            return heading;
        }, { intervalMs: 100, timeoutMs: 5000, signal });
    }

    /**
     * Waits for `JE.jellyseerrMoreInfo.checkForUnrequestedSeasons` to become
     * available. The Jellyseerr modules are loaded in parallel by plugin.js
     * via dynamically-inserted <script> tags, so on a cold page load
     * item-details.js may execute before moreinfo/more-info-modal-init.js has finished
     * parsing and attached its API. The checker is required for deciding
     * whether to render the Request More button.
     * @param {AbortSignal} [signal]
     * @returns {Promise<Function|null>}
     */
    function waitForChecker(signal) {
        return pollUntil(
            () => {
                const fn = JE.jellyseerrMoreInfo && JE.jellyseerrMoreInfo.checkForUnrequestedSeasons;
                return typeof fn === 'function' ? fn : null;
            },
            { intervalMs: 50, timeoutMs: 3000, signal }
        );
    }

    /**
     * Builds the Request More button DOM. Reuses the .jellyseerr-request-button
     * styling injected by ui/ui-styles.js so visuals match the rest of Seerr UI.
     * Uses textContent / DOM construction (no innerHTML) for safety.
     * @param {object} tvDetails - TV show details from Seerr
     * @returns {HTMLButtonElement}
     */
    function buildSeriesRequestMoreButton(tvDetails) {
        // Defensive: i18n table may not be initialized yet on first navigation;
        // match the fallback pattern used elsewhere in this file.
        const labelText = (JE.t && JE.t('jellyseerr_btn_request_more')) || 'Request More';

        const button = document.createElement('button');
        button.type = 'button';
        button.className = `jellyseerr-request-button jellyseerr-button-request ${REQUEST_MORE_BTN_CLASS}`;
        button.title = labelText;
        // Inline overrides so the button sits comfortably next to the h2 text
        // without inheriting the heading's font size or block layout.
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

        const labelSpan = document.createElement('span');
        labelSpan.textContent = labelText;

        button.appendChild(icon);
        button.appendChild(labelSpan);

        button.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (JE.jellyseerrUI?.showSeasonSelectionModal) {
                JE.jellyseerrUI.showSeasonSelectionModal(
                    tvDetails.id,
                    'tv',
                    tvDetails.name || tvDetails.title,
                    tvDetails
                );
            }
        });

        return button;
    }

    /**
     * Renders a "Request More" button next to the Seasons section heading on
     * a Series detail page when the show has unrequested seasons in Seerr.
     * Reuses checkForUnrequestedSeasons from moreinfo/more-info-modal-init.js so the
     * detection logic stays in one place.
     * @param {string} itemId - Jellyfin item ID
     * @returns {Promise<void>}
     */
    function renderSeriesRequestMoreButton(itemId) {
        if (processedRequestMoreItems.has(itemId)) return Promise.resolve();
        // Already being checked for this page (onNavigate started it, this is
        // the viewshow run): share it rather than abort and repeat its lookups.
        const inFlight = requestMoreInFlight.get(itemId);
        if (inFlight) return inFlight;
        const run = runSeriesRequestMoreCheck(itemId).finally(() => {
            if (requestMoreInFlight.get(itemId) === run) requestMoreInFlight.delete(itemId);
        });
        requestMoreInFlight.set(itemId, run);
        return run;
    }

    /**
     * The Request More check itself; see renderSeriesRequestMoreButton.
     * @param {string} itemId - Jellyfin item ID
     */
    async function runSeriesRequestMoreCheck(itemId) {
        // Cancel any in-flight Request More check from a previous navigation.
        if (requestMoreAbortController) {
            requestMoreAbortController.abort();
        }
        requestMoreAbortController = new AbortController();
        const signal = requestMoreAbortController.signal;

        try {
            if (!JE.pluginConfig?.JellyseerrEnabled) return;
            if (JE.pluginConfig?.JellyseerrShowRequestMoreOnSeries === false) return;

            const status = await JE.jellyseerrAPI.checkUserStatus();
            if (signal.aborted) return;
            if (!status?.active) return;

            const { tmdbId, type } = await getTmdbIdFromItem(itemId, signal);
            if (signal.aborted) return;
            if (!tmdbId || type !== 'tv') return;

            const tvDetails = await JE.jellyseerrAPI.fetchTvShowDetails(tmdbId);
            if (signal.aborted) return;
            if (!tvDetails) return;

            // Wait for the checker to become available — the Jellyseerr
            // modules load in parallel via dynamically-inserted <script>
            // tags, so moreinfo/more-info-modal-init.js may still be parsing when we get
            // here on a cold load. Polling up to 3s avoids a one-shot race
            // where the button would otherwise never appear until the user
            // navigates away and back.
            const checker = await waitForChecker(signal);
            if (signal.aborted) return;
            if (!checker) {
                console.warn(`${requestMoreLogPrefix} checkForUnrequestedSeasons unavailable after 3s, skipping`);
                return;
            }
            const hasUnrequested = await checker(tvDetails, signal);
            if (signal.aborted) return;
            if (!hasUnrequested) {
                // Dedupe negative results too. Each call to checker() runs an
                // HTTP request to /JellyfinEnhanced/jellyseerr/request, so we
                // don't want to repeat it on every viewshow for the same item.
                // cleanup() clears this set on real navigation.
                processedRequestMoreItems.add(itemId);
                console.debug(`${requestMoreLogPrefix} No unrequested seasons for "${tvDetails.name || tvDetails.title}"`);
                return;
            }

            const heading = await waitForSeasonsHeading(signal);
            if (signal.aborted) return;
            if (!heading) {
                console.debug(`${requestMoreLogPrefix} Seasons heading not found, skipping`);
                return;
            }

            // Dedup: bail if we already injected a button into this heading.
            if (heading.querySelector(`.${REQUEST_MORE_BTN_CLASS}`)) {
                processedRequestMoreItems.add(itemId);
                return;
            }

            // Lay the button out inline next to the heading text via a class
            // (instead of mutating heading.style directly) so the override is
            // discoverable in CSS, easy to remove, and doesn't permanently
            // overwrite Jellyfin's inline display value on the heading.
            heading.classList.add('je-series-request-more-heading');

            const button = buildSeriesRequestMoreButton(tvDetails);
            heading.appendChild(button);

            processedRequestMoreItems.add(itemId);
            console.debug(`${requestMoreLogPrefix} Added Request More button for "${tvDetails.name || tvDetails.title}"`);
        } catch (error) {
            if (error.name === 'AbortError') {
                console.debug(`${requestMoreLogPrefix} Aborted for item ${itemId}`);
                return;
            }
            console.error(`${requestMoreLogPrefix} Error rendering button:`, error);
        }
    }

    /**
     * Handles item details page navigation
     */
    function handleItemDetailsPage() {
        // Get item ID from URL
        const hash = window.location.hash;
        if (!hash.includes('/details?id=')) {
            return;
        }

        try {
            const itemId = detailsItemIdFromHash();
            if (itemId) {
                // Use requestAnimationFrame instead of fixed timeout
                // This ensures we're in sync with the rendering cycle
                requestAnimationFrame(() => {
                    // Not for an item the user has already left: cleanup()
                    // ran for that navigation before this frame.
                    if (detailsItemIdFromHash() === itemId) renderSimilarAndRecommended(itemId);
                    renderSeriesRequestMoreButton(itemId);
                });
            }
        } catch (error) {
            console.error(`${logPrefix} Error parsing item ID from URL:`, error);
        }
    }

    /**
     * Cleanup function for navigation
     */
    function cleanup() {
        // Abort any in-flight requests (a pending row build is kept for the
        // view being left, see deferRows)
        if (currentAbortController) {
            currentAbortController.abort();
            currentAbortController = null;
        }
        if (requestMoreAbortController) {
            requestMoreAbortController.abort();
            requestMoreAbortController = null;
        }
        // Clear processed items caches
        processedItems.clear();
        processedRequestMoreItems.clear();
        // The aborted check above would otherwise be joined by a run for the
        // same item started before it has unwound.
        requestMoreInFlight.clear();
    }

    /**
     * Injects the CSS used by the Series "Request More" button. Kept tiny so
     * it can live alongside the JS module instead of needing a separate file.
     */
    function injectRequestMoreStyles() {
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

    /**
     * Initializes the item details handler
     */
    function initialize() {
        console.debug(`${logPrefix} Initializing Recommendations and Similar sections`);
        injectRequestMoreStyles();

        // Lifecycle: run cleanup() on EVERY navigation — hashchange, popstate
        // AND the pushState transitions the old raw hashchange listener
        // missed. Teardown wiring is registered first so cleanup always runs
        // before handleItemDetailsPage on a navigation.
        const lifecycle = JE.core.lifecycle.register('jellyseerr-item-details');
        lifecycle.onTeardown(cleanup);
        lifecycle.teardownOn('navigate');
        JE.core.navigation.onNavigate(() => handleItemDetailsPage());

        // Check current page on load
        handleItemDetailsPage();

        // Also react to view shows (Jellyfin's custom viewshow event)
        JE.core.navigation.onViewPage((_view, _element, _hash, _itemPromise, rawEvent) => {
            noteViewItem(rawEvent);
            handleItemDetailsPage();
        });
    }

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize);
    } else {
        initialize();
    }

})(window.JellyfinEnhanced);
