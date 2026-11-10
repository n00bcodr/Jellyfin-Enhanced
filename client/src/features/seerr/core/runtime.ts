import { seerrCoreContext, type SeerrCoreBridge, type SeerrCoreHost } from '../host-core';
import type { RequestOutcome, SeerrUiInternals } from './contract';
import { isNumber, isRecord, isString } from './decode';

export const LOG_UI = '🪼 Jellyfin Enhanced: Seerr UI:';

/**
 * The group's shared internals object (one per page, whichever entry runs
 * first creates it). The default literal lives only here, so no sibling can
 * seed a diverging shape.
 */
export function groupInternals(JE: SeerrCoreBridge): SeerrUiInternals {
    const own = seerrCoreContext(JE).own;
    return own.jellyseerrUi ||= { state: { jellyseerrHoverPopover: null, jellyseerrHoverLock: false, active4KPopup: null } };
}
/** True the first time an entry installs on this page; a re-evaluated bundle installs nothing twice. */
export function firstInstall(JE: SeerrCoreBridge, name: string): boolean {
    const internals = groupInternals(JE);
    const installed = internals.installed ||= new Set<string>();
    if (installed.has(name)) return false;
    installed.add(name);
    return true;
}

const ENTITIES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
/** JE.escapeHtml at call time, with the legacy local fallback when it is not installed. */
export function escapeWith(JE: SeerrCoreBridge): (value: unknown) => string {
    return value => {
        const escape = JE.escapeHtml;
        if (typeof escape === 'function') return escape(value);
        return String(value ?? '').replace(/[&<>"']/g, c => ENTITIES[c] ?? c);
    };
}
/** A translation, or the English fallback when the key has no translation. */
export function translated(JE: SeerrCoreBridge, key: string, fallback: string, params?: Readonly<Record<string, string | number>>): string {
    const text = params ? JE.t(key, params) : JE.t(key);
    return text && text !== key ? text : fallback;
}
export function toast(JE: SeerrCoreBridge, message: string, duration: number): void {
    JE.toast?.(message, duration);
}

function text(read: () => unknown): string | null {
    try {
        const value = read();
        return isString(value) && value ? value : null;
    } catch {
        return null;
    }
}
/**
 * The account and server a piece of work started under. `current()` is false
 * once the session epoch moved or the host's ApiClient now reports another
 * user/server, even if the session has not noticed yet.
 */
export interface Origin { readonly epoch: number | null; current(): boolean }
export function captureOrigin(host: SeerrCoreHost): Origin {
    const session = host.JE.session;
    const epoch = session ? session.getEpoch() : null;
    const user = () => text(() => host.apiClient()?.getCurrentUserId?.());
    const server = () => text(() => {
        const client = host.apiClient();
        const id = client?.serverId;
        return typeof id === 'function' ? Reflect.apply(id, client, []) : id;
    });
    const startClient = host.apiClient();
    const root = () => text(() => host.apiClient()?.getUrl('/'));
    const token = () => text(() => host.apiClient()?.accessToken?.());
    const startRoot = root();
    const startToken = token();
    const startUser = user();
    const startServer = server();
    return {
        epoch,
        current: () => host.apiClient() === startClient && root() === startRoot && token() === startToken
            && (!session || epoch === null || session.isCurrent(epoch)) && user() === startUser && server() === startServer
    };
}

// Kept in the shared facade registry because classic-script bundles have separate module copies.
export function bindViewOrigin(host: SeerrCoreHost, element: Element): void {
    const internals = groupInternals(host.JE);
    const owners = internals.viewOrigins ||= new WeakMap<Element, Origin>();
    owners.set(element, captureOrigin(host));
}
export function isViewCurrent(host: SeerrCoreHost, element: Element): boolean {
    const owners = groupInternals(host.JE).viewOrigins;
    for (let node: Element | null = element; node; node = node.parentElement) {
        if (owners?.get(node)?.current() === false) return false;
    }
    return true;
}

/** A property of a thrown value (an Error or a plain rejection object), unknown until checked. */
function thrownProperty(error: unknown, key: string): unknown {
    if (typeof error !== 'object' || error === null) return undefined;
    const value: unknown = Reflect.get(error, key);
    return value;
}
export function isAbortError(error: unknown): boolean {
    return thrownProperty(error, 'name') === 'AbortError';
}
export function errorStatus(error: unknown): number | null {
    const status = thrownProperty(error, 'status');
    return isNumber(status) ? status : null;
}
/** The server's JSON error body ({ message, code }) as the core client attached it. */
export function errorBody(error: unknown): { message: string | null; code: string | null; requestOutcome: 'unknown' | 'rejected' | 'not_sent' | null } {
    const body = thrownProperty(error, 'responseJSON');
    if (!isRecord(body)) return { message: null, code: null, requestOutcome: null };
    return {
        message: isString(body.message) && body.message ? body.message : null,
        code: isString(body.code) && body.code ? body.code : null,
        requestOutcome: body.requestOutcome === 'unknown' || body.requestOutcome === 'rejected' || body.requestOutcome === 'not_sent' ? body.requestOutcome : null
    };
}

/**
 * How a request write failed, from the client's point of view. A response
 * from the proxy may carry an uncertain upstream outcome even with an HTTP
 * status. Transport loss, a timeout or an unreadable success leaves it unknown:
 * the request may have been applied and must not be retried automatically.
 */
export type FailureKind = 'not-sent' | 'quota' | 'permission' | 'user-not-found' | 'rejected' | 'uncertain';
export class RequestNotSentError extends Error {
    override readonly name = 'SeerrRequestNotSent';
    constructor(readonly reason: 'identity-changed' | 'invalid-input', detail: string) { super(detail); }
}
export function classifyFailure(error: unknown, quotaEnabled: boolean): FailureKind {
    if (error instanceof RequestNotSentError || (error instanceof Error && error.name === 'SeerrRequestNotSent')) return 'not-sent';
    const status = errorStatus(error);
    const { message, requestOutcome } = errorBody(error);
    if (requestOutcome === 'unknown') return 'uncertain';
    if (requestOutcome === 'not_sent') return 'not-sent';
    if (status === null || (status >= 500 && requestOutcome !== 'rejected')) return 'uncertain';
    if (status === 403 && quotaEnabled && /quota\s+exceeded/i.test(message || '')) return 'quota';
    if (status === 404) return 'user-not-found';
    if (status === 403) return 'permission';
    return 'rejected';
}
/** Shown when a sent request's outcome is unknown; no automatic retry follows. */
export function uncertainMessage(JE: SeerrCoreBridge): string {
    return translated(JE, 'jellyseerr_request_outcome_unknown', 'Request status unknown. Check Seerr before requesting again.');
}

const OUTCOME_LIMIT = 50;
/** Bounded in-memory journal of request writes (diagnostics; never replayed). */
export function recordOutcome(JE: SeerrCoreBridge, outcome: RequestOutcome): void {
    const internals = groupInternals(JE);
    const outcomes = internals.outcomes ||= [];
    outcomes.push(outcome);
    if (outcomes.length > OUTCOME_LIMIT) outcomes.splice(0, outcomes.length - OUTCOME_LIMIT);
}

/** The query in the current hash route (#/search?query=…), as the legacy refresh read it. */
export function hashQuery(location: Location): string | null {
    const query = location.hash.split('?')[1];
    return new URLSearchParams(query).get('query');
}
