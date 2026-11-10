import { currentUserId, api, hasApi } from './host';
import type { DetailsSession, ItemCacheHelper, ViewHook } from './host';
import { decodeDetailsItem } from './wire';
import type { DetailsItem } from './wire';

/** The `id` query parameter of the current SPA route, or null. */
export function hashItemId(hash: string = window.location.hash): string | null {
    try {
        return new URLSearchParams(hash.split('?')[1] ?? '').get('id');
    } catch {
        return null;
    }
}
/** Jellyfin keeps hidden, cached detail views in the DOM; only one is visible. */
export function visibleDetailPage(): HTMLElement | null {
    return document.querySelector<HTMLElement>('#itemDetailPage:not(.hide)');
}

/**
 * Looks an item up through the shared short-TTL cache (one request per item
 * for every details module) or, before helpers load, straight from Jellyfin.
 * `withUser` preserves which legacy call sites passed `{ userId }`.
 */
export function lookupItem(helpers: ItemCacheHelper | undefined, itemId: string, withUser: boolean, userId: string | null = currentUserId()): Promise<unknown> {
    if (helpers?.getItemCached) {
        return withUser ? helpers.getItemCached(itemId, { userId }) : helpers.getItemCached(itemId);
    }
    return api().getItem(userId, itemId);
}
export async function lookupDetailsItem(helpers: ItemCacheHelper | undefined, itemId: string, withUser: boolean, userId: string | null = currentUserId()): Promise<DetailsItem | null> {
    return decodeDetailsItem(await lookupItem(helpers, itemId, withUser, userId));
}

/**
 * Whether asynchronous work started for one details visit may still write.
 * Jellyfin can reuse one view element for the next item and swaps signed-in
 * users without reloading, so a result is applied only while the route still
 * names the same item, the same page is the visible one, and neither the
 * session epoch nor the signed-in user changed.
 */
export interface DetailsLease { readonly itemId: string; readonly page: Element; current(): boolean }
export function detailsLease(session: DetailsSession | undefined, itemId: string, page: Element): DetailsLease {
    const sameSession = sessionLease(session);
    return {
        itemId, page,
        current: () => sameSession()
            && hashItemId() === itemId
            && page.isConnected
            && visibleDetailPage() === page
    };
}
/** Session-only lease, for work that is not tied to one page. */
export function sessionLease(session: DetailsSession | undefined): () => boolean {
    const epoch = session?.getEpoch();
    const userId = currentUserId();
    const client = api();
    const root = client.getUrl('/');
    const token = client.accessToken();
    return () => hasApi() && api() === client && client.getUrl('/') === root && client.accessToken() === token
        && (!session || epoch === undefined || session.isCurrent(epoch)) && currentUserId() === userId;
}

export function isDetailHook(element: Element | null | undefined, hash: string | undefined): boolean {
    const hasItemId = window.location.hash.includes('id=') || (typeof hash === 'string' && hash.includes('id='));
    const isItemDetailElement = !!element && (element.id === 'itemDetailPage' || element.classList.contains('itemDetailPage'));
    return hasItemId || isItemDetailElement;
}
/**
 * The view-show hook the details sections share: wait for the visible page
 * (Jellyfin applies `.hide` during the transition), retrying once later when
 * `retry` is set, then process it.
 */
export function detailPageHook(enabled: () => boolean, unregister: () => void, process: (page: HTMLElement) => void, retry: boolean): ViewHook {
    return async (_view, element, hash) => {
        if (!enabled()) {
            unregister();
            return;
        }
        if (!isDetailHook(element, hash)) return;
        await new Promise<void>(resolve => setTimeout(resolve, 150));
        const page = visibleDetailPage();
        if (page) {
            process(page);
        } else if (retry) {
            setTimeout(() => {
                const retryPage = visibleDetailPage();
                if (retryPage) process(retryPage);
            }, 500);
        }
    };
}

/** Inserts `node` directly after `anchor`. */
export function insertAfter(anchor: Node, node: Node): boolean {
    const parent = anchor.parentNode;
    if (!parent) return false;
    parent.insertBefore(node, anchor.nextSibling);
    return true;
}
export function insertBefore(anchor: Node, node: Node): boolean {
    const parent = anchor.parentNode;
    if (!parent) return false;
    parent.insertBefore(node, anchor);
    return true;
}
/** First match, in order, of several selectors within a root. */
export function firstMatch(root: ParentNode, selectors: readonly string[]): Element | null {
    for (const selector of selectors) {
        const found = root.querySelector(selector);
        if (found) return found;
    }
    return null;
}
/** Removes the first matching section in the page (or visible page / document). */
export function removeFirst(page: ParentNode | null | undefined, selector: string): void {
    const root: ParentNode = page || visibleDetailPage() || document;
    const section = root.querySelector(selector);
    section?.parentNode?.removeChild(section);
}
