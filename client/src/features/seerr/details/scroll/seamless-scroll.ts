import type { SeerrDetailsBridge } from '../../host-details';
import { SEERR_LOG } from '../../host-details';
import { record } from '../domain/json';

/**
 * Seamless infinite scroll: buffer-fill loading, deduplication, retry with backoff.
 *
 * Instead of "load one page when the sentinel scrolls into view", the engine keeps a
 * buffer of rendered content ahead of the viewer. Whenever the buffer is short it
 * calls the load function with a hint describing the deficit, and keeps calling until
 * the buffer is full or the feed is exhausted. A page that renders no cards therefore
 * never stalls the feed, and consumers use the hint to fetch several pages at once.
 */
const logPrefix = `${SEERR_LOG} Seamless Scroll:`;

/** Exposed on the facade and read on each use: integrations tune it at runtime. */
export const CONFIG = {
    // Vertical grids: keep at least this much rendered content below the viewport.
    bufferViewports: 3,
    minBufferPx: 2400,

    // Horizontal rows: keep this many visible-row-widths of cards to the right once the
    // viewer has interacted with the row (scrolled, wheeled, touched, focused it)...
    bufferRowWidths: 4,
    // ...and only this many before that, so a row that is merely displayed costs one page.
    idleRowWidths: 1.5,

    // Rows scrolled by transforms emit no scroll events, so poll the geometry while set up...
    horizontalPollMs: 400,
    // ...until this many polls in a row found nothing to load. Any scroll, wheel, swipe, key,
    // focus, press or resize, a card hidden or added, and any fill request starts it again.
    horizontalPollIdleLimit: 3,

    // After this many consecutive pages that rendered no cards the loop pauses and shows a
    // "Keep looking" button. Pages are never skipped: pressing it resumes the feed.
    maxConsecutiveEmptyPages: 40,

    // Pause after this many consecutive fills whose measured buffer did not grow, even
    // though pages kept returning results (e.g. mostly duplicates).
    maxStuckFills: 15,

    retry: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 8000, jitterFactor: 0.25 },
};

export interface ScrollHint {
    deficitPx: number; aheadPx?: number; spanPx?: number; horizontal?: boolean; engaged?: boolean; pageBudget?: number;
}
export interface ScrollState {
    activeScrollObserver?: IntersectionObserver | null;
    fill?: (() => Promise<void>) | null;
    _teardown?: (() => void) | null;
    _sentinel?: HTMLElement | null;
    _removeRetryRow?: (() => void) | null;
}
export interface ScrollOptions { horizontal?: boolean; trackSelector?: string; scrollerSelector?: string }
export type LoadResult = { pages?: number; rendered?: number } | void | boolean | null;
export type KeyOf<T> = (item: T) => unknown;

function calculateBackoff(attempt: number): number {
    const { baseDelayMs, maxDelayMs, jitterFactor } = CONFIG.retry;
    const delay = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
    const jitter = delay * jitterFactor * (Math.random() * 2 - 1);
    return Math.max(0, Math.round(delay + jitter));
}

function verticalBufferPx(): number {
    return Math.max(window.innerHeight * CONFIG.bufferViewports, CONFIG.minBufferPx);
}

function errorName(error: unknown): unknown {
    return typeof error === 'object' && error !== null && 'name' in error ? error.name : undefined;
}
function errorText(error: unknown): unknown {
    return typeof error === 'object' && error !== null && 'message' in error ? error.message : error;
}

/** Estimates how many cards fill a pixel deficit, from the cards already in the container. */
export function cardsNeeded(container: Element | null, hint: ScrollHint | null | undefined, fallback = 40): number {
    if (!container || !hint || !(hint.deficitPx > 0)) return fallback;
    // Never plan less than about a screen of cards: right after the first render the
    // deficit is tiny, and a one-page batch loses the race against a fast reader.
    const targetPx = Math.max(hint.deficitPx, (hint.spanPx || 0) * 0.75);
    const cards = container.querySelectorAll<HTMLElement>('.card');
    let first: HTMLElement | null = null;
    for (let index = 0; index < cards.length && index < 60; index++) {
        // Skip cards hidden by the CSS media-type filter.
        const card = cards[index];
        if (card && card.offsetParent !== null) { first = card; break; }
    }
    if (!first) return fallback;
    const rect = first.getBoundingClientRect();
    if (hint.horizontal) return Math.ceil(targetPx / (rect.width || 150)) + 2;
    const rowHeight = rect.height || 250;
    let perRow = 1;
    for (let index = 1; index < cards.length && index < 80 && perRow < 40; index++) {
        const card = cards[index];
        if (!card || card.offsetParent === null) continue;
        if (Math.abs(card.getBoundingClientRect().top - rect.top) < 2) perRow++;
        else break;
    }
    return Math.ceil(targetPx / rowHeight) * perRow + perRow;
}

function defaultKey(item: unknown): string {
    const value = record(item);
    return `${value?.mediaType}-${value?.id}`;
}

/** Tracks seen items across pages. */
export function createDeduplicator() {
    const seen = new Set<unknown>();
    return {
        /** Marks an item as seen; true when it was new. */
        add<T>(item: T, getKey: KeyOf<T> = defaultKey): boolean {
            const key = getKey(item);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        },
        /** The new items of a list, all marked as seen. */
        filter<T>(items: readonly T[], getKey: KeyOf<T> = defaultKey): T[] {
            const filtered = items.filter(item => this.add(item, getKey));
            const duplicates = items.length - filtered.length;
            if (duplicates > 0) console.debug(`${logPrefix} Filtered out ${duplicates} duplicate(s) from ${items.length} items`);
            return filtered;
        },
        clear(): void { seen.clear(); },
        get size(): number { return seen.size; },
    };
}

function inlineThrottle(callback: () => void, wait: number): () => void {
    let lastCall = 0;
    return () => {
        const now = Date.now();
        if (now - lastCall >= wait) {
            lastCall = now;
            callback();
        }
    };
}

const ACTION_ROW_CSS = {
    horizontal: 'display: inline-flex; justify-content: center; align-items: center; vertical-align: middle; padding: 1em 1.5em; box-sizing: border-box;',
    vertical: 'display: flex; justify-content: center; align-items: center; padding: 1.5em; width: 100%; box-sizing: border-box;',
    button: 'padding: 0.8em 1.5em; border-radius: 4px; background: rgba(255,255,255,0.1); color: rgba(255,255,255,0.8); border: 1px solid rgba(255,255,255,0.2); cursor: pointer; font-size: 1em; display: inline-flex; align-items: center; justify-content: center;',
};

export function createScrollEngine(JE: SeerrDetailsBridge) {
    function cleanupInfiniteScroll(state: ScrollState): void {
        if (state._teardown) {
            state._teardown();
            state._teardown = null;
        }
        if (state.activeScrollObserver) {
            state.activeScrollObserver.disconnect();
            state.activeScrollObserver = null;
        }
        if (state._sentinel) {
            state._sentinel.remove();
            state._sentinel = null;
        }
        if (state._removeRetryRow) {
            state._removeRetryRow();
            state._removeRetryRow = null;
        }
        state.fill = null;
    }

    /** Buffer-fill infinite scroll with parallel-load hints, retry and deduplication. */
    function setupInfiniteScroll(state: ScrollState, sectionSelector: string, loadMore: (hint: ScrollHint) => Promise<LoadResult> | LoadResult,
        hasMore: () => boolean, isLoading: () => boolean, options: ScrollOptions = {}): void {
        console.debug(`${logPrefix} Setting up infinite scroll for ${sectionSelector}`);

        // Clean up a previous call on this state first, or its scroll listener stays on
        // window forever, holding a stale query and a detached sentinel.
        cleanupInfiniteScroll(state);

        const section = document.querySelector(sectionSelector);
        if (!section) return;

        const horizontal = options.horizontal === true;
        const trackSelector = options.trackSelector || '.itemsContainer';
        const scrollerSelector = options.scrollerSelector || '.emby-scroller';

        section.querySelectorAll('.jellyseerr-scroll-sentinel, .je-scroll-sentinel').forEach(old => old.remove());
        const sentinel = document.createElement('div');
        sentinel.className = 'je-scroll-sentinel';
        sentinel.style.cssText = 'height:1px;width:100%;pointer-events:none;';
        section.appendChild(sentinel);

        let retryCount = 0;
        let retryRow: HTMLElement | null = null;
        let destroyed = false;
        let filling = false;
        let emptyPages = 0;   // consecutive fetched pages that rendered nothing
        let paused = false;   // after max retries or the empty-page budget: wait for the button
        let engaged = !horizontal; // rows start in the idle (small buffer) state
        let lastMeasuredAhead: number | null = null;
        let stuckFills = 0;
        let cancelBackoff: (() => void) | null = null;
        // A More Info modal covers the page: nobody is reading the row behind it. A fill it
        // stopped resumes when the modal closes; a grid too short to scroll would not ask again.
        let suspendedByModal = false;
        // Compared by the horizontal poll to tell an idle row from a filling one.
        let loadsStarted = 0;
        let pollTimer: number | null = null;
        let idlePolls = 0;

        const removeRetryRow = () => {
            if (retryRow) {
                retryRow.remove();
                retryRow = null;
            }
        };

        /**
         * An action row: retry after failures, or "keep looking" once the empty-page budget
         * is spent. In a horizontal row it sits at the end of the track, where the viewer is.
         * With no label the button is icon-only, which needs no translated string.
         */
        const showRetryRow = (label: string | null = 'Tap to retry', icon: string | null = null) => {
            if (retryRow || destroyed) return;
            const row = document.createElement('div');
            row.className = 'je-retry-row';
            row.style.cssText = horizontal ? ACTION_ROW_CSS.horizontal : ACTION_ROW_CSS.vertical;
            const button = document.createElement('button');
            button.type = 'button';
            if (label) {
                button.title = label;
                button.setAttribute('aria-label', label);
            }
            if (icon) {
                const iconEl = document.createElement('span');
                iconEl.className = 'material-icons';
                iconEl.textContent = icon;
                iconEl.setAttribute('aria-hidden', 'true');
                button.appendChild(iconEl);
            } else {
                button.textContent = label;
            }
            button.style.cssText = ACTION_ROW_CSS.button;
            button.addEventListener('click', () => {
                retryCount = 0;
                emptyPages = 0;
                stuckFills = 0;
                lastMeasuredAhead = null;
                paused = false;
                engaged = true;
                removeRetryRow();
                void fill();
            });
            row.appendChild(button);
            retryRow = row;
            const track = horizontal ? section.querySelector(trackSelector) : null;
            if (track) track.appendChild(row);
            else sentinel.parentNode?.insertBefore(row, sentinel);
        };

        // A detached or display:none section measures as all zeros, which would read as
        // "infinitely short" and start a fill storm into a page nobody can see.
        const isDisplayed = () => section.isConnected && section.getClientRects().length > 0;

        /** How much rendered content is still ahead of the viewer. */
        const measure = (): { ahead: number; target: number; span: number; inRange: boolean } => {
            if (!isDisplayed()) return { ahead: 0, target: 0, span: 0, inRange: false };
            if (horizontal) {
                const track = section.querySelector(trackSelector);
                const scroller = section.querySelector(scrollerSelector) ?? section;
                const sectionRect = section.getBoundingClientRect();
                const vBuffer = verticalBufferPx();
                // Only fill a row that is on (or near) the screen vertically.
                const inRange = sectionRect.bottom > -vBuffer && sectionRect.top < window.innerHeight + vBuffer;
                if (!track) return { ahead: 0, target: 0, span: 0, inRange };
                // The track box does not grow with its overflowing cards: the end of the
                // content is the last card's right edge.
                const cards = track.querySelectorAll('.card');
                const last = cards[cards.length - 1] ?? track;
                const endRight = last.getBoundingClientRect().right;
                const scrollerRect = scroller.getBoundingClientRect();
                const visibleRight = Math.min(scrollerRect.right, window.innerWidth);
                const span = Math.max(scrollerRect.width || window.innerWidth, 400);
                const widths = engaged ? CONFIG.bufferRowWidths : CONFIG.idleRowWidths;
                return { ahead: endRight - visibleRight, target: span * widths, span, inRange };
            }
            const top = sentinel.getBoundingClientRect().top;
            const target = verticalBufferPx();
            return { ahead: top - window.innerHeight, target, span: window.innerHeight, inRange: top - window.innerHeight < target };
        };

        // Document-space position of the end of the content: comparing it around a load
        // tells whether the load added anything.
        const contentEnd = (): number => {
            if (horizontal) {
                const track = section.querySelector(trackSelector);
                const last = track ? track.querySelectorAll('.card') : null;
                const card = last?.[last.length - 1];
                if (!track || !card) return 0;
                return card.getBoundingClientRect().right - track.getBoundingClientRect().left;
            }
            return sentinel.getBoundingClientRect().top + window.scrollY;
        };

        const backoff = (ms: number) => new Promise<void>(resolve => {
            const timer = setTimeout(() => {
                cancelBackoff = null;
                resolve();
            }, ms);
            cancelBackoff = () => {
                clearTimeout(timer);
                cancelBackoff = null;
                resolve();
            };
        });

        /** One load with retries; resolves to its result, or false when nothing was loaded. */
        const wrappedLoad = async (hint: ScrollHint): Promise<LoadResult> => {
            if (!hasMore() || isLoading()) return false;
            removeRetryRow();
            console.debug(`${logPrefix} Loading more items (attempt ${retryCount + 1}, deficit ${Math.round(hint.deficitPx)}px)`);
            try {
                const result = await loadMore(hint);
                retryCount = 0;
                return result && typeof result === 'object' ? result : true;
            } catch (error) {
                // Nothing is left to retry into, and nobody to show a retry button to.
                if (errorName(error) === 'AbortError' || destroyed) return false;
                retryCount++;
                console.warn(`${logPrefix} Load failed (attempt ${retryCount}/${CONFIG.retry.maxAttempts}):`, errorText(error));
                if (retryCount >= CONFIG.retry.maxAttempts) {
                    console.warn(`${logPrefix} Max retry attempts reached, showing retry UI`);
                    paused = true;
                    showRetryRow();
                    return false;
                }
                const delay = calculateBackoff(retryCount);
                console.debug(`${logPrefix} Retrying in ${delay}ms...`);
                await backoff(delay);
                if (destroyed || !sentinel.isConnected) return false;
                return wrappedLoad(hint);
            }
        };

        const modalOpen = () => !!document.querySelector('.je-more-info-modal');

        /** Loads until the buffer is full, the feed is exhausted, or a load fails for good. */
        const runFill = async (): Promise<void> => {
            if (filling || destroyed || paused) return;
            filling = true;
            try {
                while (!destroyed && !paused && sentinel.isConnected && hasMore() && !isLoading()) {
                    if (modalOpen()) { suspendedByModal = true; break; }
                    const geometry = measure();
                    if (!geometry.inRange) break;
                    const deficit = geometry.target - geometry.ahead;
                    if (deficit <= 0) break;
                    if (emptyPages >= CONFIG.maxConsecutiveEmptyPages) {
                        console.debug(`${logPrefix} ${emptyPages} consecutive pages rendered nothing; pausing until "Keep looking" is pressed`);
                        paused = true;
                        showRetryRow(null, 'refresh');
                        break;
                    }
                    if (lastMeasuredAhead !== null && geometry.ahead <= lastMeasuredAhead + 1) {
                        stuckFills++;
                        if (stuckFills >= CONFIG.maxStuckFills) {
                            console.warn(`${logPrefix} Buffer measurement hasn't grown after ${stuckFills} loads despite non-empty pages; pausing to avoid a runaway fetch loop`);
                            paused = true;
                            showRetryRow(null, 'refresh');
                            break;
                        }
                    } else {
                        stuckFills = 0;
                    }
                    lastMeasuredAhead = geometry.ahead;

                    const before = contentEnd();
                    // How many more pages may be fetched before the empty-page valve trips;
                    // consumers clamp batch and prefetch to it.
                    const pageBudget = CONFIG.maxConsecutiveEmptyPages - emptyPages;
                    loadsStarted++;
                    const result = await wrappedLoad({ deficitPx: deficit, aheadPx: geometry.ahead, spanPx: geometry.span, horizontal, engaged, pageBudget });
                    if (!result) break;
                    if (typeof result === 'object' && typeof result.pages === 'number') {
                        const rendered = result.rendered ?? 0;
                        // A load that fetched and rendered nothing made no progress: stop rather than spin.
                        if (result.pages === 0 && !(rendered > 0)) break;
                        emptyPages = rendered > 0 ? 0 : emptyPages + result.pages;
                    } else {
                        emptyPages = contentEnd() > before + 1 ? 0 : emptyPages + 1;
                    }
                }
            } finally {
                filling = false;
            }
        };

        const pollTick = async (): Promise<void> => {
            if (!sentinel.isConnected) { teardown(); return; }
            if (filling) { idlePolls = 0; return; }
            const before = loadsStarted;
            await runFill();
            if (loadsStarted !== before) {
                idlePolls = 0;
            } else if (++idlePolls >= CONFIG.horizontalPollIdleLimit && pollTimer !== null) {
                clearInterval(pollTimer);
                pollTimer = null;
            }
        };
        /** (Re)starts the horizontal poll after something that can move or grow the row. */
        const armPoll = () => {
            if (!horizontal || destroyed) return;
            idlePolls = 0;
            if (pollTimer === null) pollTimer = window.setInterval(() => { void pollTick(); }, CONFIG.horizontalPollMs);
        };

        /** Runs the fill loop on request and re-arms a horizontal row's poll. */
        const fill = (): Promise<void> => {
            armPoll();
            return runFill();
        };

        // Wakes the fill loop when the sentinel (or a row's section) nears the viewport.
        const observer = new IntersectionObserver(entries => {
            if (entries.some(entry => entry.isIntersecting)) void fill();
        }, { rootMargin: `${Math.round(verticalBufferPx())}px` });
        state.activeScrollObserver = observer;
        observer.observe(horizontal ? section : sentinel);

        const throttle = JE.helpers?.throttle ?? inlineThrottle;
        const onUserScroll = throttle(() => {
            if (!sentinel.isConnected) {
                // Removed without cleanup (e.g. the user navigated away). Self-heal so this
                // listener doesn't keep firing requests from other pages.
                teardown();
                return;
            }
            void fill();
        }, 100);

        // Interaction with a row switches it from the idle to the full read-ahead buffer. A
        // press, tap or focus landing on a card is the viewer picking a title, not reading along
        // the row: it must not fetch pages behind the modal it is about to open.
        const CARD_EVENT_TYPES = new Set(['pointerdown', 'touchstart', 'focusin']);
        const onEngage = (event: Event) => {
            if (CARD_EVENT_TYPES.has(event.type) && event.target instanceof Element && event.target.closest('.card')) return;
            if (!engaged) {
                engaged = true;
                void fill();
            }
        };

        const listeners: Array<() => void> = [];
        const listen = (target: EventTarget, type: string, handler: (event: Event) => void, opts?: AddEventListenerOptions) => {
            target.addEventListener(type, handler, opts);
            listeners.push(() => target.removeEventListener(type, handler, opts));
        };
        listen(window, 'scroll', onUserScroll, { passive: true });
        listen(window, 'resize', onUserScroll, { passive: true });
        listen(document, 'jellyseerr-more-info-closed', () => {
            if (!suspendedByModal) return;
            suspendedByModal = false;
            void fill();
        });
        if (horizontal) {
            // emby-scroller scrolls an inner element (native) or translates the track
            // (transform); catch both plus the input that drives them.
            listen(section, 'scroll', onUserScroll, { passive: true, capture: true });
            listen(section, 'wheel', onUserScroll, { passive: true });
            listen(section, 'touchmove', onUserScroll, { passive: true });
            listen(section, 'keydown', onUserScroll, { passive: true });
            listen(section, 'focusin', onUserScroll, { passive: true });
            // A press (e.g. the scroller's own arrow buttons) only re-arms the poll.
            listen(section, 'pointerdown', armPoll, { passive: true, capture: true });
            // The row can shrink with no input on it: a card hidden through the hide dialog,
            // or cards taken out of the track. Re-arm the poll to refill on its next tick.
            listen(window, 'je-hidden-content-changed', armPoll);
            const track = section.querySelector(trackSelector);
            if (track && typeof MutationObserver !== 'undefined') {
                // The track's own children only: no subtree, no attributes.
                const trackObserver = new MutationObserver(() => armPoll());
                trackObserver.observe(track, { childList: true });
                listeners.push(() => trackObserver.disconnect());
            }
            // touchmove: a swipe that starts on a card is still reading the row.
            for (const type of ['scroll', 'wheel', 'touchstart', 'touchmove', 'keydown', 'focusin', 'pointerdown']) {
                listen(section, type, onEngage, { passive: true, capture: true });
            }
            armPoll();
        }

        const teardown = () => {
            if (destroyed) return;
            destroyed = true;
            listeners.splice(0).forEach(off => off());
            cancelBackoff?.();
            if (pollTimer !== null) {
                clearInterval(pollTimer);
                pollTimer = null;
            }
            observer.disconnect();
            if (state.activeScrollObserver === observer) state.activeScrollObserver = null;
            // A self-healed engine must not leave a dead fill() for callers to poke;
            // only clear it if it is still this engine's.
            if (state.fill === fill) state.fill = null;
        };

        state._teardown = teardown;
        state._sentinel = sentinel;
        state._removeRetryRow = removeRetryRow;
        state.fill = fill;

        // Fill straight away: the first page rarely covers three viewports.
        void fill();
    }

    return { setupInfiniteScroll, cleanupInfiniteScroll };
}
