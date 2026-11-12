import type { SeerrDiscoveryHost } from '../host-discovery';
import type { PageReadyOptions } from './types';

const LIST_GRACE_MS = 1500;
const DETAIL_GRACE_MS = 3000;
const OVERALL_WAIT_MS = 30000;
const POLL_MS = 100;
const VISIBLE_DETAIL = '.itemDetailPage:not(.hide)';

/** Jellyfin 12 dropped the .detailPageContent wrapper; fall back to the secondary container, then the page. */
function detailAnchor(page: HTMLElement): HTMLElement {
    return page.querySelector<HTMLElement>('.detailPageContent') ??
        page.querySelector<HTMLElement>('.detailPageSecondaryContainer') ?? page;
}

export function createPageReady(JE: SeerrDiscoveryHost) {
    // Unique id per wait: two modules can wait on one page at once (person + collection).
    let sequence = 0;
    function findDetail(options: PageReadyOptions, allowStale: boolean): HTMLElement | null {
        const view = options.getView?.();
        if (view?.matches(VISIBLE_DETAIL)) return detailAnchor(view);
        let staleFallback: HTMLElement | null = null;
        for (const page of document.querySelectorAll<HTMLElement>(VISIBLE_DETAIL)) {
            if (!options.isStalePage?.(page)) return detailAnchor(page);
            if (allowStale) staleFallback ??= page;
        }
        return staleFallback && detailAnchor(staleFallback);
    }
    /**
     * List page: prefer the view the router just showed. Otherwise take the visible list container,
     * but during a transition that is still the OLD page, so a page already visible when the
     * navigation started is stale until a new one appears. The container merely existing is enough.
     */
    function findList(options: PageReadyOptions, allowStale: boolean): HTMLElement | null {
        const viewContainer = options.getView?.()?.querySelector<HTMLElement>('.itemsContainer');
        if (viewContainer) return viewContainer;
        const candidates = document.querySelectorAll<HTMLElement>('.page:not(.hide) .itemsContainer, .libraryPage:not(.hide) .itemsContainer');
        let staleFallback: HTMLElement | null = null;
        for (const candidate of candidates) {
            if (!options.isStalePage?.(candidate.closest('.page, .libraryPage'))) return candidate;
            // The same element reused for the new route: accept it once it holds items.
            if (allowStale && candidate.children.length > 0) staleFallback ??= candidate;
        }
        return staleFallback;
    }
    return function waitForPageReady(signal?: AbortSignal, options: PageReadyOptions = {}): Promise<HTMLElement | null> {
        const type = options.type ?? 'list';
        const find = (allowStale: boolean) => type === 'detail' ? findDetail(options, allowStale) : findList(options, allowStale);
        return new Promise(resolve => {
            if (signal?.aborted) { resolve(null); return; }
            const immediate = find(false);
            if (immediate) { resolve(immediate); return; }

            let allowStale = false;
            let timeoutId: ReturnType<typeof setTimeout> | undefined;
            let pollId: ReturnType<typeof setInterval> | undefined;
            let subscription: { unsubscribe(): void } | undefined;
            let finished = false;
            const finish = (result: HTMLElement | null) => {
                if (finished) return;
                finished = true;
                subscription?.unsubscribe();
                clearInterval(pollId);
                clearTimeout(timeoutId);
                signal?.removeEventListener('abort', abort);
                resolve(result);
            };
            const abort = () => finish(null);
            const recheck = () => {
                const found = find(allowStale);
                if (found) finish(found);
            };
            signal?.addEventListener('abort', abort, { once: true });
            subscription = JE.helpers?.onBodyMutation?.(`jellyseerr-discovery-container-detect-${++sequence}`, recheck);
            // The router hides the old page by toggling a class, which the body observer does not report.
            pollId = setInterval(recheck, POLL_MS);
            // Past the grace period a stale-looking visible page is accepted if it holds items. When NO
            // page is visible, the router is still loading the new one, which a cold list query can hold
            // for seconds: keep waiting. Giving up here left the section off the page for good, because
            // the render still in progress swallows the re-entry the router's later 'viewshow' triggers.
            timeoutId = setTimeout(() => {
                allowStale = true;
                recheck();
                if (!finished) timeoutId = setTimeout(() => finish(find(true)), OVERALL_WAIT_MS);
            }, type === 'list' ? LIST_GRACE_MS : DETAIL_GRACE_MS);
        });
    };
}

/** Cheap signature of what a list shows; React may reuse child nodes, so compare content, not identity. */
export function listSignature(page: Element | null): string {
    const container = page?.querySelector('.itemsContainer');
    if (!container) return '';
    const first = container.firstElementChild;
    const label = first?.getAttribute('data-id') || first?.getAttribute('data-index') ||
        first?.textContent?.trim().slice(0, 40) || '';
    return `${container.childElementCount}|${label}`;
}
