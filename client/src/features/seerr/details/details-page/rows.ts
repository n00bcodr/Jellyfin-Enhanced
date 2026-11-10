import { SEERR_LOG, seerrDetailsContext, taskScheduler, translator, type SeerrDetailsBridge } from '../../host-details';
import { filled, record, str } from '../domain/json';
import { detailsHref } from '../domain/links';

const logPrefix = `${SEERR_LOG} Seerr Item Details:`;

// When the Seerr data comes back before Jellyfin has rendered the item, the rows are
// built once that render is painted (see deferRows): an empty marker holds their place
// after More Like This until then.
const PENDING_ROWS_CLASS = 'je-seerr-rows-pending';
// Counted from scheduling, for an item Jellyfin never renders (or a paint after its
// render that never comes, see afterPaint).
const NAME_WAIT_MS = 5000;
// A step of the rows' prebuild outside an idle callback (see whenIdle).
const PREBUILD_SLICE_MS = 8;
// Elements that never take up space, wherever they sit.
const NON_RENDERED_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META']);

export interface DetailPage { detailPageContent: Element; moreLikeThisSection: Element }
interface RowSpec { name: 'Recommended' | 'Similar'; results: readonly unknown[]; title: string; total: number }
interface Deadline { timeRemaining(): number }
interface Prebuilt {
    take(spec: RowSpec): { section: HTMLElement | null } | null;
    release(): void;
}
/** One run of the rows: its item, identity, view and what it found. */
export interface RowsRun {
    itemId: string; signal: AbortSignal; sameAccount: () => boolean;
    page: Element | null; detailPageContent: Element; anchor: Element;
    recommended: readonly unknown[]; similar: readonly unknown[];
    prebuilt?: Prebuilt | null;
}

/** Whether the shown view is the page's details content with More Like This. */
export function findDetailPage(): DetailPage | null {
    const activePage = document.querySelector('.libraryPage:not(.hide)');
    if (!activePage) return null;
    // Jellyfin 12 dropped .detailPageContent; #similarCollapsible, the anchor, is still inside.
    const detailPageContent = activePage.querySelector('.detailPageContent') ?? activePage.querySelector('.detailPageSecondaryContainer') ?? activePage;
    const moreLikeThisSection = detailPageContent.querySelector('#similarCollapsible');
    return moreLikeThisSection ? { detailPageContent, moreLikeThisSection } : null;
}

/** The item id of the details page in the URL, or null on any other page. */
export function detailsItemIdFromHash(): string | null {
    const hash = window.location.hash;
    if (!hash.includes('/details?id=')) return null;
    return new URLSearchParams(hash.split('?')[1]).get('id');
}

const jellyfinMediaIdOf = (item: unknown): string | null => filled(record(record(item)?.mediaInfo)?.jellyfinMediaId);

/** Whether two lists hold the same items in the same order. */
function sameItems(first: readonly unknown[], second: readonly unknown[]): boolean {
    return first.length === second.length && first.every((item, index) => item === second[index]);
}

/**
 * Runs `fn` in a task after the browser has painted the current frame: the next
 * animation frame queues the task, which runs after that frame's paint. A hidden
 * document runs no animation frames (and paints nothing), so there, or once it is
 * hidden while it waits, the task is queued at once. Neither queuing the task nor
 * cancelling leaves the frame requested: a hidden document would keep it, and `fn`
 * with what it holds, until it is shown again.
 */
function afterPaint(fn: () => void): () => void {
    let waiting = true;
    let frame: number | null = null;
    let timer: number | undefined;
    const stop = () => {
        waiting = false;
        document.removeEventListener('visibilitychange', onHidden);
        if (frame !== null) cancelAnimationFrame(frame);
        frame = null;
    };
    const queue = () => {
        if (!waiting) return;
        stop();
        timer = window.setTimeout(fn, 0);
    };
    const onHidden = () => {
        if (document.hidden) queue();
    };
    if (document.hidden) {
        queue();
    } else {
        document.addEventListener('visibilitychange', onHidden);
        frame = requestAnimationFrame(() => {
            frame = null;
            queue();
        });
    }
    return () => {
        stop();
        clearTimeout(timer);
    };
}

/**
 * Runs a step of a prebuild when nothing else is waiting: as a background task, else
 * when the browser is idle, else in a task of its own. Outside an idle callback (whose
 * deadline can be 50 ms, long enough to hold up a response) a step gets PREBUILD_SLICE_MS.
 */
function whenIdle(fn: (deadline: Deadline) => void): () => void {
    const sliced = () => {
        const end = performance.now() + PREBUILD_SLICE_MS;
        fn({ timeRemaining: () => Math.max(0, end - performance.now()) });
    };
    const scheduler = taskScheduler();
    if (scheduler) {
        const controller = new AbortController();
        scheduler.postTask(sliced, { priority: 'background', signal: controller.signal }).catch(() => {});
        return () => controller.abort();
    }
    if (typeof requestIdleCallback === 'function') {
        const id = requestIdleCallback(fn);
        return () => cancelIdleCallback(id);
    }
    const id = window.setTimeout(sliced, 0);
    return () => clearTimeout(id);
}

/** Similar and Recommended rows, built around Jellyfin's own render of a details page. */
export function createDetailRows(JE: SeerrDetailsBridge, processedItems: Set<string>, schedule: (itemId: string) => void) {
    const t = translator(JE);
    // The current run's rows waiting on a view (see deferRows), so the shown view's
    // viewshow run can send them there.
    let waitingRows: { itemId: string; retarget: () => void } | null = null;
    // The item each view was shown for, from Jellyfin's viewshow. A view keeps its URL for
    // its life, so a build kept for a view the user left is only ever for that view's item.
    const viewItems = new WeakMap<Element, string>();
    // Markers of the builds kept for a view the user left (see deferRows).
    const leftMarkers = new WeakSet<Element>();

    /** The results a section shows: the exclude-library and Hidden Content filters, read now. */
    function sectionResults(results: readonly unknown[]): readonly unknown[] {
        if (results.length === 0) return [];
        let filtered = results;
        if (JE.pluginConfig?.JellyseerrExcludeLibraryItems === true) filtered = results.filter(item => !jellyfinMediaIdOf(item));
        const hiddenContent = seerrDetailsContext(JE).peer('hiddenContent');
        if (hiddenContent) filtered = hiddenContent.filterJellyseerrResults(filtered, 'recommendations');
        return filtered;
    }

    /** A section without its cards: the title and the row they go in. */
    function createSectionShell(title: string): { section: HTMLElement; itemsContainer: HTMLElement } {
        const section = document.createElement('div');
        section.className = 'verticalSection emby-scroller-container jellyseerr-details-section';
        section.setAttribute('data-jellyseerr-section', 'true');

        const titleElement = document.createElement('h2');
        titleElement.className = 'sectionTitle sectionTitle-cards focuscontainer-x padded-right';
        titleElement.textContent = title || 'Recommended';
        section.appendChild(titleElement);

        const scroller = document.createElement('div');
        scroller.setAttribute('is', 'emby-scroller');
        scroller.className = 'padded-top-focusscale padded-bottom-focusscale no-padding emby-scroller';
        scroller.dataset.horizontal = 'true';
        scroller.dataset.centerfocus = 'card';
        scroller.dataset.scrollModeX = 'custom';
        // Smooth native horizontal touch scrolling (from KefinTweaks).
        scroller.style.scrollSnapType = 'none';
        scroller.style.touchAction = 'auto';
        scroller.style.overscrollBehaviorX = 'contain';
        scroller.style.overscrollBehaviorY = 'auto';
        scroller.style.setProperty('-webkit-overflow-scrolling', 'touch');

        const itemsContainer = document.createElement('div');
        itemsContainer.setAttribute('is', 'emby-itemscontainer');
        itemsContainer.className = 'focuscontainer-x itemsContainer scrollSlider animatedScrollX';
        itemsContainer.style.whiteSpace = 'nowrap';

        scroller.appendChild(itemsContainer);
        section.appendChild(scroller);
        return { section, itemsContainer };
    }

    /** A section's card for one result; a title in the library links there. */
    function createSectionCard(item: unknown): HTMLElement | null {
        const card = JE.jellyseerrUI?.createJellyseerrCard ? JE.jellyseerrUI.createJellyseerrCard(item, true, true) : null;
        if (!card) return card;
        const titleLink = card.querySelector<HTMLAnchorElement>('.cardText-first a');
        const jellyfinMediaId = jellyfinMediaIdOf(item);
        if (jellyfinMediaId) {
            card.setAttribute('data-library-item', 'true');
            card.setAttribute('data-jellyfin-media-id', jellyfinMediaId);
            card.classList.add('jellyseerr-card-in-library');
            if (titleLink) {
                const media = record(item);
                const name = str(media?.title) || str(media?.name) || '';
                titleLink.textContent = name;
                titleLink.title = name;
                titleLink.href = detailsHref(jellyfinMediaId);
                titleLink.removeAttribute('target');
                titleLink.removeAttribute('rel');
            }
        }
        return card;
    }

    function createJellyseerrSection(results: readonly unknown[], title: string): HTMLElement | null {
        const filtered = sectionResults(results);
        if (filtered.length === 0) return null;
        const { section, itemsContainer } = createSectionShell(title);
        const fragment = document.createDocumentFragment();
        for (const item of filtered) {
            const card = createSectionCard(item);
            if (card) fragment.appendChild(card);
        }
        itemsContainer.appendChild(fragment);
        return section;
    }

    /** Whether Jellyfin has rendered the item into this details view. */
    const jellyfinRendered = (page: Element): boolean => !!page.querySelector('.nameContainer .itemName');

    /**
     * Whether nothing that takes up space follows More Like This in the view, so rows
     * built later push nothing down that rows inserted now would not have. A div right
     * after it, even a hidden one, is refused as well: it changes where the immediate
     * insert puts Similar (:last-of-type). Reads no layout.
     */
    function nothingFollows(anchor: Element, page: Element): boolean {
        for (let node: Element | null = anchor; node !== page; node = node.parentElement) {
            if (!node) return false;
            for (let next = node.nextElementSibling; next; next = next.nextElementSibling) {
                if (next.classList.contains(PENDING_ROWS_CLASS)) continue;
                if (node === anchor && next.tagName === 'DIV') return false;
                if (NON_RENDERED_TAGS.has(next.tagName) || (next instanceof HTMLElement && next.hidden) || next.classList.contains('hide')) continue;
                return false;
            }
        }
        return true;
    }

    /** Releases a run's claim on its item so a later viewshow can retry it. */
    function releaseClaim({ itemId, signal }: RowsRun): void {
        // Not after an abort: cleanup cleared the claims and a newer run may hold this one's.
        if (!signal.aborted) processedItems.delete(itemId);
    }

    /** Records the item a view is shown for: Jellyfin dispatches viewshow on the view. */
    function noteViewItem(rawEvent: Event | null): void {
        if (!(rawEvent instanceof CustomEvent)) return;
        const view = rawEvent.target;
        const itemId = filled(record(record(rawEvent.detail)?.params)?.id);
        if (itemId && view instanceof Element) viewItems.set(view, itemId);
    }

    /** Whether a view was shown for another item. Not known before its first viewshow. */
    function shownForOther(page: Element | null, itemId: string): boolean {
        const shownFor = page ? viewItems.get(page) : undefined;
        return shownFor !== undefined && shownFor !== itemId;
    }

    /**
     * Whether the rows can wait: Jellyfin has not rendered the item yet, in a visible view
     * that has no Seerr rows (a restored view is replaced in place at once) and where
     * nothing follows More Like This.
     */
    function canDeferRows(run: RowsRun): run is RowsRun & { page: Element } {
        const { page, detailPageContent, anchor } = run;
        if (!page || !page.isConnected || page.classList.contains('hide') || !page.querySelector('.nameContainer')) return false;
        if (detailPageContent.querySelector('.jellyseerr-details-section')) return false;
        if (jellyfinRendered(page)) return false;
        return nothingFollows(anchor, page);
    }

    /**
     * Inserts a run's rows into its view, when it is still the shown view of the item
     * in the URL for the identity the run started under.
     */
    function commitRows(run: RowsRun, marker: HTMLElement | null): boolean {
        const { itemId, signal, sameAccount, page, anchor } = run;
        if (signal.aborted) return false;
        if (detailsItemIdFromHash() !== itemId) return false;
        if (!sameAccount()) {
            releaseClaim(run);
            return false;
        }
        if (page ? (!page.isConnected || page.classList.contains('hide')) : !anchor.isConnected) {
            // Never into a cached or hidden view. The rows go to the details view that is
            // shown, from this run's data, and a viewshow run for it returns early: a new
            // run would ask again for what is not cached.
            const shown = findDetailPage();
            const shownPage = shown ? shown.moreLikeThisSection.closest('.libraryPage') : null;
            if (shown && shownPage && shownPage !== page) {
                if (placeRows({ ...run, page: shownPage, detailPageContent: shown.detailPageContent, anchor: shown.moreLikeThisSection })) return true;
                releaseClaim(run);
                return false;
            }
            // No details view shown: run again once there is one.
            releaseClaim(run);
            const visible = document.querySelector('.libraryPage:not(.hide)');
            if (visible && visible !== page) schedule(itemId);
            return false;
        }
        insertRows(run, marker);
        return true;
    }

    /**
     * Removes the waiting builds' markers for an item, but `keep`. Another item's build
     * kept for its own view stays. In a view shown for this item, another item's kept
     * build goes too: it was kept before the view's viewshow told whose it is.
     */
    function removeMarkers(page: Element | null, root: Element, itemId: string, keep: Element | null = null): void {
        const own = !!page && viewItems.get(page) === itemId;
        root.querySelectorAll<HTMLElement>(`.${PENDING_ROWS_CLASS}`).forEach(element => {
            if (element === keep) return;
            if (element.dataset.itemId === itemId || (own && leftMarkers.has(element))) element.remove();
        });
    }

    /**
     * Inserts the rows of a build kept for a view the user left: into that view, shown or
     * not, where they were inserted with their data before. Not once the view is gone, a
     * newer build or insert has taken its marker away, it turned out to be another item's
     * view, or another user signed in.
     */
    function commitLeftRows(run: RowsRun & { page: Element }, marker: HTMLElement): void {
        if (!run.page.isConnected || !marker.isConnected || !run.sameAccount()) return;
        if (shownForOther(run.page, run.itemId)) return;
        insertRows(run, marker);
    }

    /** The rows a run inserts, in order, with what each is built from. */
    function rowSpecs({ recommended, similar }: RowsRun): RowSpec[] {
        const rows: RowSpec[] = [];
        if (recommended.length > 0) rows.push({ name: 'Recommended', results: recommended.slice(0, 20), title: t('jellyseerr_recommended_title', 'Recommended'), total: recommended.length });
        if (similar.length > 0) rows.push({ name: 'Similar', results: similar.slice(0, 20), title: t('jellyseerr_similar_title', 'Similar'), total: similar.length });
        return rows;
    }

    /** The section prebuilt for a row when that is what building it now gives, else built now. */
    function rowSection(run: RowsRun, row: RowSpec): HTMLElement | null {
        const prebuilt = run.prebuilt?.take(row);
        return prebuilt ? prebuilt.section : createJellyseerrSection(row.results, row.title);
    }

    /**
     * The only insertion point. Without a marker the rows go after More Like This exactly
     * as they always have; with one, before the marker, which is the same place when
     * nothing followed More Like This at scheduling (see nothingFollows).
     */
    function insertRows(run: RowsRun, marker: HTMLElement | null): void {
        const { itemId, page, detailPageContent, anchor } = run;
        // A build for this item still kept from when the user left the view gives way.
        removeMarkers(page, detailPageContent, itemId, marker);
        // Remove any existing sections (their cards must be unobserved first: lazy posters
        // hold strong references). Prebuilt ones wait in a DocumentFragment, left alone here.
        JE.jellyseerrUI?.releasePosters?.(detailPageContent);
        detailPageContent.querySelectorAll('.jellyseerr-details-section').forEach(element => element.remove());

        const before = marker?.isConnected ? marker : null;
        for (const row of rowSpecs(run)) {
            const section = rowSection(run, row);
            if (!section) continue;
            if (before) {
                before.before(section);
            } else if (row.name === 'Similar') {
                const last = detailPageContent.querySelector('.jellyseerr-details-section:last-of-type');
                if (last) last.after(section);
                else anchor.after(section);
            } else {
                anchor.after(section);
            }
            console.debug(`${logPrefix} Added ${row.name} section with ${row.total} items`);
        }
    }

    /**
     * Builds a waiting run's rows ahead of Jellyfin's render, a few cards at a time when
     * nothing else is waiting (see whenIdle), so that only inserting them is left for after
     * that render. They wait in a DocumentFragment: releasePosters leaves cards there alone,
     * and their posters stay unloaded until they are in the page.
     *
     * A prebuilt row is used only when building it at insertion would give the same: same
     * results, title and filters, and the same card inputs (settings, labels, hidden state,
     * and the results' own fields, which a request changes in place in the cached results),
     * checked at each step and at insertion. Anything else is built at insertion as before;
     * a row part built is finished there. Whatever is not taken is released.
     * Null where cards would load their posters as they are built.
     */
    function prebuildRows(run: RowsRun): Prebuilt | null {
        if (typeof IntersectionObserver !== 'function') return null;
        const holder = document.createDocumentFragment();
        interface Build extends RowSpec { filtered: readonly unknown[] | null; key: unknown; section: HTMLElement | null; itemsContainer: HTMLElement | null; built: number; taken: boolean }
        const rows: Build[] = rowSpecs(run).map(row => ({ ...row, filtered: null, key: undefined, section: null, itemsContainer: null, built: 0, taken: false }));
        const inputsKey = (items: readonly unknown[]): unknown => JE.jellyseerrUI?.cardInputsKey?.(items);
        let usable = true;
        let next = 0;
        let cancelStep: (() => void) | null = null;

        const release = () => {
            usable = false;
            cancelStep?.();
            cancelStep = null;
            if (!holder.firstChild) return;
            JE.jellyseerrUI?.releasePosters?.(holder);
            holder.replaceChildren();
        };
        const buildCard = (row: Build) => {
            const item = row.filtered?.[row.built++];
            const card = createSectionCard(item);
            if (card) row.itemsContainer?.appendChild(card);
        };
        // The next card, or the next row's start; false once all are built.
        const buildNext = (): boolean => {
            const row = rows[next];
            if (!row) return false;
            if (!row.filtered) {
                row.filtered = sectionResults(row.results);
                row.key = inputsKey(row.filtered);
                if (row.filtered.length > 0) {
                    const shell = createSectionShell(row.title);
                    row.section = shell.section;
                    row.itemsContainer = shell.itemsContainer;
                    holder.appendChild(shell.section);
                }
            } else {
                buildCard(row);
            }
            if (row.built === row.filtered.length) next++;
            return true;
        };
        const step = (deadline: Deadline) => {
            cancelStep = null;
            if (!usable) return;
            try {
                if (!run.sameAccount() || rows.some(row => row.filtered && inputsKey(row.filtered) !== row.key)) {
                    release();
                    return;
                }
                do {
                    if (!buildNext()) return;
                } while (deadline.timeRemaining() > 0);
            } catch {
                // Built again at insertion, which reports the failure.
                release();
                return;
            }
            cancelStep = whenIdle(step);
        };
        const take = (spec: RowSpec): { section: HTMLElement | null } | null => {
            const row = usable ? rows.find(entry => entry.name === spec.name) : undefined;
            if (!row || row.taken || !row.filtered || row.title !== spec.title || !sameItems(row.results, spec.results)) return null;
            const filtered = sectionResults(spec.results);
            if (!sameItems(row.filtered, filtered) || inputsKey(filtered) !== row.key) return null;
            while (row.built < row.filtered.length) buildCard(row);
            row.taken = true;
            const { section } = row;
            section?.remove();
            return { section };
        };
        cancelStep = whenIdle(step);
        return { take, release };
    }

    /**
     * Builds the rows once Jellyfin has rendered the item's name, so they are not painted
     * on the empty template and then pushed down by that render; not in that render's task,
     * though, but in one after it has been painted (see afterPaint): styling their cards
     * with it made a long task of a session's first details page. So they appear a frame
     * after Jellyfin's render, after More Like This, which nothing followed when they were
     * scheduled. A page Jellyfin never renders gets them after NAME_WAIT_MS; printing builds
     * them at once. The data and the claim on the item are already there.
     *
     * Leaving the view (the abort) keeps the build for it, so a view restored by Back or
     * Forward has its rows from its first frame. They are built into the left view, hidden
     * or not, unless it is gone, another build has taken it over or another user signed in.
     * Only for the item's own view; a build kept before its viewshow checks again as it builds.
     *
     * Jellyfin adds a new view before it hides the one it leaves, so the run may have found
     * the outgoing view. When that view is hidden while the URL is still this item's and
     * another details view is shown, the rows go there after the next paint. The shown view's
     * viewshow run sends them there at once, from a view removed rather than hidden too.
     *
     * Building the cards takes long enough on a cold page to hold back the render it waits
     * for, so they are built while the rows wait, when the browser is idle (see prebuildRows).
     */
    function deferRows(run: RowsRun & { page: Element }): boolean {
        const { itemId, signal, page, anchor } = run;
        const marker = document.createElement('div');
        marker.className = PENDING_ROWS_CLASS;
        marker.dataset.itemId = itemId;
        marker.setAttribute('aria-hidden', 'true');

        let done = false;
        let left = false;
        let nameObserver: MutationObserver | null = null;
        let nameTimer: number | undefined;
        let cancelPaint: (() => void) | null = null;
        let prebuilt: Prebuilt | null = null;
        // Not before a details view is shown: commitRows would release the item and a new
        // run would ask again for what is not cached.
        const movedOn = () => !left && (!page.isConnected || page.classList.contains('hide')) && detailsItemIdFromHash() === itemId && !!findDetailPage();
        const waiting = { itemId, retarget: () => { if (movedOn()) buildNow(); } };

        // No longer the current run's: its abort and the shown view's viewshow run leave
        // the build alone. Printing still builds it.
        const detach = () => {
            signal.removeEventListener('abort', onAbort);
            if (waitingRows === waiting) waitingRows = null;
        };
        const dispose = () => {
            done = true;
            nameObserver?.disconnect();
            clearTimeout(nameTimer);
            cancelPaint?.();
            window.removeEventListener('beforeprint', buildNow);
            detach();
        };
        const drop = () => {
            dispose();
            marker.remove();
            prebuilt?.release();
        };
        function onAbort(): void {
            if (page.isConnected && run.sameAccount() && !shownForOther(page, itemId)) {
                left = true;
                leftMarkers.add(marker);
                detach();
                return;
            }
            drop();
        }
        function buildNow(): void {
            if (done) return;
            dispose();
            try {
                if (left) commitLeftRows(run, marker);
                else commitRows(run, marker);
            } catch (error) {
                releaseClaim(run);
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
            window.addEventListener('beforeprint', buildNow);
            const observer = new MutationObserver(() => {
                if (!jellyfinRendered(page) && !movedOn()) return;
                // Once this frame is painted. Until then the build stays what it was: an
                // abort, a user switch, printing, a viewshow run or NAME_WAIT_MS act on it as before.
                observer.disconnect();
                cancelPaint = afterPaint(buildNow);
            });
            nameObserver = observer;
            const nameContainer = page.querySelector('.nameContainer');
            if (!nameContainer) throw new Error('Name container gone');
            observer.observe(nameContainer, { childList: true, subtree: true });
            observer.observe(page, { attributes: true, attributeFilter: ['class'] });
            nameTimer = window.setTimeout(buildNow, NAME_WAIT_MS);
            waitingRows = waiting;
        } catch {
            // Insert now, as before.
            drop();
            let placed = false;
            try {
                placed = commitRows(run, null);
            } finally {
                if (!placed) releaseClaim(run);
            }
            return placed;
        }
        try {
            prebuilt = prebuildRows(run);
        } catch {
            // Built at insertion instead.
        }
        // Set even when null: a run sent here from another view's build (commitRows)
        // carries that build's prebuild, released once it ran.
        run.prebuilt = prebuilt;
        return true;
    }

    /**
     * Places a run's rows into its view: at once, or after Jellyfin's render of the item.
     * The item is claimed once they are placed or waiting, so a viewshow run returns early.
     */
    function placeRows(run: RowsRun): boolean {
        if (canDeferRows(run)) {
            // Claimed now, when the rows would otherwise have been inserted. A build that
            // does not happen releases the claim.
            processedItems.add(run.itemId);
            return deferRows(run);
        }
        const placed = commitRows(run, null);
        if (placed) processedItems.add(run.itemId);
        return placed;
    }

    return {
        placeRows, noteViewItem, shownForOther,
        /** Rows still waiting on a view Jellyfin has left go to the shown one now. */
        retargetWaiting(itemId: string): void {
            if (waitingRows?.itemId === itemId) waitingRows.retarget();
        },
        newRun(itemId: string, signal: AbortSignal, found: { page: DetailPage; recommended: readonly unknown[]; similar: readonly unknown[]; sameAccount: () => boolean }): RowsRun {
            const { detailPageContent, moreLikeThisSection } = found.page;
            return {
                itemId, signal, sameAccount: found.sameAccount, page: moreLikeThisSection.closest('.libraryPage'), detailPageContent,
                anchor: moreLikeThisSection, recommended: found.recommended, similar: found.similar,
            };
        },
    };
}
