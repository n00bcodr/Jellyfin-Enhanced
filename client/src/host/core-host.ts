import type { Lifecycle } from '../core/lifecycle';
import type { Navigation } from '../core/navigation';
import type { Identity, Session } from '../core/session';

/** Only the Jellyfin 12 host APIs consumed by the foundational runtime. */
export interface JellyfinClient {
    getCurrentUserId?(): unknown;
    serverId?: string | (() => unknown);
    _serverInfo?: { Id?: unknown };
    getItem?(userId: string | null, itemId: string): Promise<unknown>;
    setAuthenticationInfo?(this: JellyfinClient, token: unknown, userId: unknown, ...rest: unknown[]): unknown;
}
export interface HostPage {
    onViewShow?(this: HostPage, view?: string, element?: Element | null, hash?: string): unknown;
}
export interface CoreBridge {
    core?: { navigation?: Navigation; lifecycle?: Lifecycle };
    session?: Session;
    helpers?: { getItemCached?(id: string): Promise<unknown> };
}
export interface CoreHost {
    JellyfinEnhanced: CoreBridge;
    ApiClient?: JellyfinClient;
    Emby?: { Page?: HostPage };
}

/** The sole typed assertion at the legacy global boundary; no feature global bag. */
export function coreHost(): Window & CoreHost {
    const host: Window & Partial<CoreHost> = window;
    if (!host.JellyfinEnhanced) throw new Error('Jellyfin Enhanced must be initialized before core modules');
    return host as Window & CoreHost;
}
export function identityId(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}
/** Host getters can throw during sign-out; retain the known user if only server probing fails. */
export function readIdentity(client: JellyfinClient | undefined): Identity {
    try {
        const userId = identityId(client?.getCurrentUserId?.());
        let serverId: string | null = null;
        try {
            serverId = identityId(typeof client?.serverId === 'function' ? client.serverId() : client?.serverId)
                || identityId(client?._serverInfo?.Id);
        } catch { /* A partially torn-down host can lack server metadata. */ }
        return { userId, serverId };
    } catch { return { userId: null, serverId: null }; }
}
