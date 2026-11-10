/** Immutable identity snapshots scope all per-user work, including server switches. */
export interface Identity { readonly userId: string | null; readonly serverId: string | null }
export interface SessionChange extends Identity {
    readonly epoch: number;
    readonly previousUserId: string | null;
    readonly reason: string;
}
/** Pass signal to cancellable work and check isCurrent/throwIfStale after every await.
 * Epoch signals abort on every user/server transition, even a return to the same identity.
 * Leases acquired inside pre-auth reset callbacks are already aborted: reload after the setter.
 */
export interface SessionLease extends Identity {
    readonly epoch: number;
    readonly signal: AbortSignal;
    isCurrent(): boolean;
    throwIfStale(): void;
}
export interface SessionDependencies {
    readIdentity(): Identity;
    createAbortController(): AbortController;
    announce(change: SessionChange): void;
    report(context: string, error: unknown): void;
}
export type ResetHandler = (change: SessionChange) => void;
export interface Session {
    getUserId(): string | null;
    getServerId(): string | null;
    getEpoch(): number;
    isCurrent(epoch: number): boolean;
    userScopedKey(base: string): string;
    onUserChange(name: string, callback: ResetHandler): () => void;
    checkNow(reason: string): void;
    createLease(): SessionLease;
}

/** State machine independent of Jellyfin globals. Resets always precede credential writes. */
export function createSession(deps: SessionDependencies) {
    let identity: Identity = { userId: null, serverId: null };
    let epoch = 0;
    let adopted = false;
    let controller = deps.createAbortController();
    let authenticationDepth = 0;
    let authenticationSerial = 0;
    const handlers = new Map<string, { callback: ResetHandler }>();

    function transition(next: Identity, reason: string): void {
        if (identity.userId === next.userId && identity.serverId === next.serverId) return;
        const silent = !adopted && identity.userId === null && next.userId !== null;
        if (silent) adopted = true;
        const change: SessionChange = Object.freeze({ ...next, previousUserId: identity.userId, epoch: ++epoch, reason });
        identity = { userId: next.userId, serverId: next.serverId };
        const previousController = controller;
        controller = deps.createAbortController();
        // Aborting can itself trigger a transition. Publish the new generation first.
        previousController.abort();
        if (silent || epoch !== change.epoch) return;
        for (const [name, entry] of [...handlers]) {
            if (epoch !== change.epoch) break;
            if (handlers.get(name) !== entry) continue;
            try { entry.callback(change); }
            catch (error) { deps.report(`reset handler "${name}" failed`, error); }
        }
        if (epoch === change.epoch) {
            try { deps.announce(change); }
            catch (error) { deps.report('je:user-changed dispatch failed', error); }
        }
    }

    function checkNow(reason: string): void {
        // During pre-auth callbacks the host still exposes the old credentials.
        if (authenticationDepth === 0) transition(deps.readIdentity(), reason);
    }

    const session: Session = {
        getUserId: () => identity.userId,
        getServerId: () => identity.serverId,
        getEpoch: () => epoch,
        isCurrent: captured => captured === epoch,
        userScopedKey: base => `${base}:${identity.userId || deps.readIdentity().userId || 'anonymous'}`,
        onUserChange(name, callback) {
            const entry = { callback };
            handlers.set(name, entry);
            return () => { if (handlers.get(name) === entry) handlers.delete(name); };
        },
        checkNow,
        createLease() {
            const capturedEpoch = epoch;
            let signal = controller.signal;
            // A lease obtained in a reset must never authorize work using old credentials.
            if (authenticationDepth > 0) {
                const pending = deps.createAbortController();
                pending.abort();
                signal = pending.signal;
            }
            const isCurrent = () => !signal.aborted && capturedEpoch === epoch;
            return Object.freeze({ ...identity, epoch: capturedEpoch, signal, isCurrent,
                throwIfStale() {
                    if (!isCurrent()) {
                        const error = new Error('Session lease is no longer current');
                        error.name = 'AbortError';
                        throw error;
                    }
                }
            });
        }
    };

    return {
        session,
        /** Synchronous Jellyfin 12 setter transaction; a nested setter supersedes its parent. */
        authenticate<T>(next: Identity, install: () => T): T | undefined {
            const serial = ++authenticationSerial;
            authenticationDepth++;
            try {
                transition(next, 'authentication');
                if (serial !== authenticationSerial) return undefined;
                return install();
            } finally {
                authenticationDepth--;
                // Also reconcile when the host setter throws, invalidating speculative leases.
                checkNow('authentication');
            }
        }
    };
}
