import { createApi, type CoreApi } from '../core/api/api';
import { abortError, type IdentityLease } from '../core/api/types';
import type { Session, SessionLease } from '../core/session';
interface ApiClientHost {
    getCurrentUserId(): unknown;
    accessToken(): unknown;
    getUrl(path: string): string;
    serverId?: string | (() => unknown);
    _serverInfo?: { Id?: unknown };
}
interface ApiBridge {
    core?: { api?: CoreApi; navigation?: { onNavigate(callback: () => void): unknown } };
    session?: Session;
    requestManager?: CoreApi['manager'];
}
interface ApiWindow { JellyfinEnhanced?: ApiBridge; ApiClient?: ApiClientHost }
interface Snapshot {
    client: ApiClientHost | undefined; user: string; token: string; server: string; base: string;
}
const text = (value: unknown): string => typeof value === 'string' ? value : '';
/** Narrow host boundary; only the named Jellyfin methods are consumed here. */
export function installApi(): void {
    const host: Window & ApiWindow = window;
    const je = host.JellyfinEnhanced;
    if (!je) throw new Error('Jellyfin Enhanced must be initialized before API');
    if (je.core?.api) return;
    let snapshot: Snapshot | undefined;
    let generation = new AbortController();
    const handlers = new Set<() => void>();
    function read(): Snapshot {
        const client = host.ApiClient;
        try {
            return { client, user: text(client?.getCurrentUserId()), token: text(client?.accessToken()),
                server: text(typeof client?.serverId === 'function' ? client.serverId() : client?.serverId) || text(client?._serverInfo?.Id),
                base: client?.getUrl('/') || '' };
        } catch { return { client, user: '', token: '', server: '', base: '' }; }
    }
    function invalidate(): void {
        const old = generation; generation = new AbortController();
        old.abort();
        for (const handler of handlers) handler();
    }
    function synchronize(): Snapshot {
        je?.session?.checkNow('api');
        const current = read();
        if (snapshot && (snapshot.client !== current.client || snapshot.user !== current.user || snapshot.server !== current.server ||
            snapshot.base !== current.base || snapshot.token !== current.token)) {
            snapshot = current; invalidate();
        } else snapshot = current;
        return current;
    }
    je.session?.onUserChange('core-api', () => { snapshot = undefined; invalidate(); });
    function acquireLease(): IdentityLease {
        const current = synchronize();
        const signal = generation.signal;
        const session: SessionLease | undefined = je?.session?.createLease();
        function throwIfStale(): void {
            synchronize();
            session?.throwIfStale();
            if (signal.aborted) throw abortError();
        }
        return { signal, headers: {
            'X-Jellyfin-User-Id': current.user, Authorization: `MediaBrowser Token="${current.token}"`,
            'X-Emby-Token': current.token, Accept: 'application/json'
        }, throwIfStale,
        resolve(path) {
            throwIfStale();
            if (!current.client) throw new Error('Jellyfin ApiClient is unavailable');
            return current.client.getUrl(path);
        } };
    }
    const api = createApi({ acquireLease, onIdentityChange: callback => { handlers.add(callback); },
        onNavigate: callback => { je.core?.navigation?.onNavigate(() => { synchronize(); callback(); }); },
        fetch: (url, options) => window.fetch(url, options), controller: () => new AbortController(),
        combineSignals: signals => AbortSignal.any(signals),
        now: () => performance.now(), wallNow: () => Date.now(), random: () => Math.random(),
        setTimer: (callback, ms) => window.setTimeout(callback, ms), clearTimer: timer => window.clearTimeout(timer),
        clone: value => structuredClone(value), debug: (...values) => console.debug(...values)
    });
    je.core = je.core || {}; je.core.api = api;
    // The old request-manager script subsequently assigns this same object.
    je.requestManager = api.manager;
    // A client replacement need not emit a session event. Request/response checks are synchronous;
    // reconciliation additionally cancels idle queues and cache entries on a silent host change.
    window.setInterval(synchronize, 5000);
}
