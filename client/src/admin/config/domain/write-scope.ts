/** Who a piece of work runs as: the client object and everything that decides whose request it sends. */
export interface WriteOrigin {
    client: object | null;
    serverAddress: string | null;
    serverId: string | null;
    userId: string | null;
    token: string | null;
}

/** Ownership of one running write; callers check after every await and before every effect. */
export interface WriteScope {
    isCurrent(): boolean;
    /** Throws an AbortError once the write no longer belongs to the account that started it. */
    throwIfStale(): void;
}

export function sameWriteOrigin(a: WriteOrigin, b: WriteOrigin): boolean {
    return a.client === b.client && a.serverAddress === b.serverAddress && a.serverId === b.serverId
        && a.userId === b.userId && a.token === b.token;
}

function abortError(message: string): Error {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
}

/**
 * A scope for work started as `origin`. It expires when the client now reads as anyone else, when the
 * Media Tags tab's own scope does, and once `finish` runs.
 * @param origin Read before any waiting, so queued work keeps the account that asked for it.
 * @param read The client's identity now.
 * @param held The Media Tags tab's scope, when its save store ran this work.
 */
export function createWriteScope(origin: WriteOrigin, read: () => WriteOrigin, held?: WriteScope): WriteScope & { finish(): void } {
    let active = true;
    const isCurrent = (): boolean => active && sameWriteOrigin(origin, read()) && (!held || held.isCurrent());
    return {
        isCurrent,
        throwIfStale() {
            held?.throwIfStale();
            if (!active) throw abortError('This settings write has already finished');
            if (!isCurrent()) throw abortError('This settings write belongs to a previous session');
        },
        finish() {
            active = false;
        },
    };
}
