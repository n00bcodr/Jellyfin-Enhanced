import { createSession } from '../core/session';
import { coreHost, identityId, readIdentity, type JellyfinClient } from './core-host';

/** Install the global bridge and Jellyfin's synchronous credential setter adapter. */
export function installSession(): void {
    const host = coreHost();
    const je = host.JellyfinEnhanced;
    if (je.session) return;
    const runtime = createSession({
        readIdentity: () => readIdentity(host.ApiClient),
        createAbortController: () => new AbortController(),
        announce: change => document.dispatchEvent(new CustomEvent('je:user-changed', { detail: change })),
        report: (context, error) => console.error(`🪼 Jellyfin Enhanced: Session: ${context}:`, error)
    });
    const wrappers = new WeakSet<NonNullable<JellyfinClient['setAuthenticationInfo']>>();
    function installAuthHook(): void {
        try {
            const client = host.ApiClient;
            const original = client?.setAuthenticationInfo;
            if (!client || typeof original !== 'function' || wrappers.has(original)) return;
            const wrapped: NonNullable<JellyfinClient['setAuthenticationInfo']> = function(token, userId, ...rest) {
                if (this !== host.ApiClient) return original.call(this, token, userId, ...rest);
                const next = { userId: identityId(userId), serverId: readIdentity(this).serverId };
                return runtime.authenticate(next, () => {
                    // A reset may replace the active client. Do not install obsolete credentials.
                    if (this !== host.ApiClient) return undefined;
                    return original.call(this, token, userId, ...rest);
                });
            };
            // Shadow inherited methods without modifying secondary server clients' prototype.
            const descriptor = Object.getOwnPropertyDescriptor(client, 'setAuthenticationInfo');
            if (descriptor && !descriptor.configurable) client.setAuthenticationInfo = wrapped;
            else Object.defineProperty(client, 'setAuthenticationInfo', { value: wrapped, writable: true, configurable: true });
            wrappers.add(wrapped);
        } catch (error) { console.warn('🪼 Jellyfin Enhanced: Session: could not hook setAuthenticationInfo:', error); }
    }
    je.session = runtime.session;
    runtime.session.checkNow('startup');
    installAuthHook();
    je.core?.navigation?.onNavigate(() => {
        installAuthHook();
        runtime.session.checkNow('navigate');
    });
    window.setInterval(() => {
        installAuthHook();
        runtime.session.checkNow('reconcile');
    }, 5000);
}
