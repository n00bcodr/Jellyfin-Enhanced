import type { JsonRecord, LoaderClient } from '../../host/bootstrap-pages-host';
import { isRecord } from './keys';

/** Jellyfin ids appear dashed and undashed by source, so only the hex digits compare. */
export function sameUser(left: unknown, right: unknown): boolean {
    const normalize = (id: unknown) => String(id || '').replace(/-/g, '').toLowerCase();
    const expected = normalize(left);
    return !!expected && expected === normalize(right);
}

/** The signed-in user id as a usable string, else null. */
export function currentUserId(client: LoaderClient): string | null {
    const id = client.getCurrentUserId?.();
    return typeof id === 'string' && id ? id : null;
}

/**
 * Authority comes from the host's own user record, never from a response. Throws
 * `message` unless that record is `userId` with a boolean administrator policy.
 */
export function hostAdministrator(user: unknown, userId: string, message: string): boolean {
    const policy = isRecord(user) && sameUser(user.Id, userId) ? user.Policy : null;
    const administrator = isRecord(policy) ? policy.IsAdministrator : null;
    if (typeof administrator !== 'boolean') throw new Error(message);
    return administrator;
}

export interface IdentityScope {
    /** Host-derived key; changes with account, server, URL, token or an announced switch. */
    key(client: LoaderClient): string;
}

/**
 * Include the server URL and token so a same-user login on another server or
 * session cannot reuse a settled promise.
 */
export function createIdentityScope(target: Pick<Document, 'addEventListener'>): IdentityScope {
    let epoch = 0;
    target.addEventListener('je:user-changed', () => { epoch++; });
    return {
        key: client => JSON.stringify([
            epoch,
            client.getCurrentUserId?.(),
            typeof client.serverId === 'function' ? client.serverId() : client.serverId,
            client.getUrl('/'),
            client.accessToken?.()
        ])
    };
}

export const requireObject = (value: unknown): JsonRecord | null => isRecord(value) ? value : null;
