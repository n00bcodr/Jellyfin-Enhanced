import { discoveryHost, filterOf, type SeerrDiscoveryHost } from '../host-discovery';
import { hasItemType, isAbortError, throwIfAborted } from './domain';
import type { ManagedFetchOptions } from './types';

/** A discovery module's managed fetch, with its section key as the cache prefix. */
export function managedFetch(JE: SeerrDiscoveryHost, prefix: string) {
    return (path: string, options?: ManagedFetchOptions) => filterOf(JE).fetchWithManagedRequest(path, prefix, options);
}
/** Whether the item is of `type`; a failed lookup counts as no, an abort does not. */
export async function isItemType(JE: SeerrDiscoveryHost, itemId: string, type: string, signal: AbortSignal): Promise<boolean> {
    try {
        throwIfAborted(signal);
        const client = discoveryHost().api();
        const item: unknown = JE.helpers?.getItemCached
            ? await JE.helpers.getItemCached(itemId)
            : await client?.getItem?.(client.getCurrentUserId(), itemId);
        throwIfAborted(signal);
        return hasItemType(item, type);
    } catch (error) {
        if (isAbortError(error)) throw error;
        return false;
    }
}
/** A lookup whose failure means "unknown": only an abort propagates. */
export async function tolerant<T>(signal: AbortSignal, fetch: () => Promise<T | null>): Promise<T | null> {
    try {
        throwIfAborted(signal);
        const value = await fetch();
        throwIfAborted(signal);
        return value;
    } catch (error) {
        if (isAbortError(error)) throw error;
        return null;
    }
}
