import type { BootstrapResponse } from '../../contracts/generated';
import {
    client, readBootstrapValidator, type BootstrapValidator, type LoaderClient, type LoaderNamespace
} from '../../host/bootstrap-pages-host';
import { currentUserId, hostAdministrator, sameUser, type IdentityScope } from './identity';
import { appendScript } from './script-loader';
import { getScriptVersion } from './script-tag';

const PREFETCHED_DEFAULT_MAX_AGE_MS = 10000;

interface PrefetchedAnswers { userId: string; identity: string; receivedAt: number; parts: Record<string, unknown> }

/** All bootstrap request state. plugin.js is one entry, so exactly one instance exists. */
export function createBootstrapClient(JE: LoaderNamespace, identity: IdentityScope) {
    let contractPromise: Promise<BootstrapValidator> | null = null;
    let prefetched: PrefetchedAnswers | null = null;
    // In-flight/settled request shared by the early check and initialize(), so a
    // page load that is already signed in issues one request.
    let bootstrapPromise: Promise<BootstrapResponse> | null = null;
    let bootstrapUserId: string | null = null;
    let bootstrapIdentityKey: string | null = null;

    /** The validator must load before any bootstrap data reaches the legacy globals. */
    function loadBootstrapContract(): Promise<BootstrapValidator> {
        contractPromise ??= new Promise<BootstrapValidator>((resolve, reject) => {
            appendScript(client().getUrl(`/JellyfinEnhanced/js/contracts/bootstrap.js?v=${getScriptVersion()}`), undefined, () => {
                const contract = readBootstrapValidator();
                if (contract) resolve(contract);
                else reject(new Error('Bootstrap validator unavailable'));
            }, () => reject(new Error('Bootstrap validator failed to load')));
        }).catch((error: unknown) => { contractPromise = null; throw error; });
        return contractPromise;
    }

    /** Validate against the host's own identity and administrator policy, for this exact session. */
    async function fetchBootstrap(expectedUserId: string): Promise<BootstrapResponse> {
        const api = client();
        const started = identity.key(api);
        const [contract, hostUser, payload] = await Promise.all([
            loadBootstrapContract(),
            typeof api.getCurrentUser === 'function'
                ? api.getCurrentUser()
                : Promise.reject(new Error('Authenticated host user unavailable')),
            api.ajax({ type: 'GET', url: api.getUrl(`/JellyfinEnhanced/bootstrap?_=${Date.now()}`), dataType: 'json' })
        ]);
        if (api !== client() || started !== identity.key(api)) throw new Error('Bootstrap identity changed');
        const isAdministrator = hostAdministrator(hostUser, expectedUserId, 'Authenticated host user unavailable');
        return contract.parseBootstrap(payload, expectedUserId, isAdministrator);
    }

    /** Keep `Prefetched` for the modules that would otherwise request each part right after load. */
    function storePrefetched(bootstrap: BootstrapResponse, userId: string): void {
        const parts = bootstrap.Prefetched;
        prefetched = parts && typeof parts === 'object'
            ? { userId, identity: identity.key(client()), receivedAt: Date.now(), parts: { ...parts } }
            : null;
    }

    /**
     * Hand out one prefetched startup answer and forget it. Undefined, so the caller
     * requests the endpoint as before, when it is absent, already taken, for another
     * user or session, or older than `maxAgeMs`.
     */
    JE.takePrefetched = (name, maxAgeMs = PREFETCHED_DEFAULT_MAX_AGE_MS) => {
        if (!prefetched || prefetched.identity !== identity.key(client())
            || !Object.prototype.hasOwnProperty.call(prefetched.parts, name)) return undefined;
        const value = prefetched.parts[name];
        delete prefetched.parts[name];
        if (!sameUser(prefetched.userId, currentUserId(client()))) return undefined;
        if (Date.now() - prefetched.receivedAt > maxAgeMs) return undefined;
        return value == null ? undefined : value;
    };

    /** A failed request is not retained, so the next caller retries once before falling back. */
    function getBootstrap(userId: string): Promise<BootstrapResponse> {
        const key = identity.key(client());
        if (bootstrapPromise && bootstrapUserId === userId && bootstrapIdentityKey === key) return bootstrapPromise;
        bootstrapIdentityKey = key;
        bootstrapUserId = userId;
        const promise: Promise<BootstrapResponse> = fetchBootstrap(userId).then(payload => {
            if (!sameUser(payload.UserId, userId)) throw new Error('Bootstrap response is for a different user');
            storePrefetched(payload, userId);
            return payload;
        }).catch((error: unknown) => {
            if (bootstrapPromise === promise) bootstrapPromise = null;
            throw error;
        });
        bootstrapPromise = promise;
        return promise;
    }

    const clearPrefetched = (): void => { prefetched = null; };
    return { loadBootstrapContract, fetchBootstrap, getBootstrap, clearPrefetched };
}
export type BootstrapClient = ReturnType<typeof createBootstrapClient>;

/** True while `client` is still the live host client in the same session. */
export const sessionUnchanged = (api: LoaderClient, identity: IdentityScope, key: string): boolean =>
    api === client() && key === identity.key(api);
