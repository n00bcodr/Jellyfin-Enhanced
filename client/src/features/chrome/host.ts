/**
 * Narrow host adapters for the header/chrome feature group. Each feature declares
 * the exact legacy facade members it consumes; nothing here is an aggregate bag.
 */
import { createFeatureContext, featureContext, type FeatureContext } from '../../host/context';
import type { BookmarkApi } from '../bookmarks/public-api';
import type { EventsBridge } from './events';

/** Identity-reset subscription of the JE session runtime (client/src/core/session.ts). */
export interface ChromeSession {
    getUserId(): string | null;
    getServerId?(): string | null;
    getEpoch?(): number;
    isCurrent?(epoch: number): boolean;
    onUserChange(name: string, callback: () => void): unknown;
}
export interface Unsubscribe { unsubscribe(): void }
export type BodyMutationCallback = (records: MutationRecord[]) => void;
/** One lifetime from JE.core.lifecycle; tracked resources are disposed by teardown(). */
export interface ChromeLifecycle {
    track<T>(resource: T): T;
    teardown(): void;
}
export interface ChromeCore {
    lifecycle: { register(name: string): ChromeLifecycle };
    navigation: { onNavigate(callback: () => void): () => void };
    dom: { onBodyMutation(id: string, callback: BodyMutationCallback, options?: { priority?: number }): Unsubscribe };
}

/** The Jellyfin ApiClient members read by identity snapshots. */
export interface IdentityClient {
    getCurrentUserId?(): unknown;
    accessToken?(): unknown;
    getUrl?(path: string): unknown;
    serverId?: unknown;
    _serverInfo?: { Id?: unknown };
}

interface HostWindow extends Window { JellyfinEnhanced?: object; ApiClient?: object }

/** The stateful peer facades chrome reads (frontend.md §2.3), typed by their owners' public-api.ts. */
export interface ChromePeers { bookmarks: BookmarkApi }
/** A chrome entry's context (frontend.md §2.3): `core` is the entry's typed bridge, `own` the facades it publishes. */
export type ChromeContext<Bridge extends object, Own extends object> = FeatureContext<Own, ChromePeers, Bridge>;
/** The context of an entry that publishes `facades` on the bridge it read (chromeBridge, ensureBridge or optionalBridge). */
export function chromeContext<Bridge extends object, F extends keyof Bridge & string>(JE: Bridge, facades: readonly F[]): ChromeContext<Bridge, Pick<Bridge, F>> {
    return featureContext<Pick<Bridge, F>, ChromePeers, Bridge>('chrome', JE, { facades });
}
/**
 * chromeContext for the pre-login scripts (splash, login image). They load before the component bundle, so
 * core/ui-kit.js has not published the shared featureContext yet; they build theirs with the implementation itself.
 */
export function preLoginChromeContext<Bridge extends object, F extends keyof Bridge & string>(JE: Bridge, facades: readonly F[]): ChromeContext<Bridge, Pick<Bridge, F>> {
    return createFeatureContext<Pick<Bridge, F>, ChromePeers, Bridge>('chrome', JE, { facades });
}
/** The events entry's own slots: its two facades and chrome's owner-only `JE.internals.canonicalCombo` slot. */
export type EventsOwn = Pick<EventsBridge, 'keyListener' | 'initializeEnhancedScript'> & NonNullable<EventsBridge['internals']>;
export type EventsContext = ChromeContext<EventsBridge, EventsOwn>;
export function eventsContext(JE: EventsBridge): EventsContext {
    return featureContext<EventsOwn, ChromePeers, EventsBridge>('chrome', JE, {
        facades: ['keyListener', 'initializeEnhancedScript'],
        internalSlots: ['canonicalCombo'],
        internalsObject: () => JE.internals ||= {},
    });
}

/** The legacy JE global, typed by the caller's finite contract. The sole assertion at this boundary. */
export function chromeBridge<T extends object>(): T {
    const host: HostWindow = window;
    if (!host.JellyfinEnhanced) throw new Error('Jellyfin Enhanced must initialize before chrome modules');
    return host.JellyfinEnhanced as T;
}
/** Pre-login scripts (splash, login image) may run before plugin.js has filled the global. */
export function ensureBridge<T extends object>(): T {
    const host: HostWindow = window;
    if (!host.JellyfinEnhanced) host.JellyfinEnhanced = {};
    return host.JellyfinEnhanced as T;
}
/** The live Jellyfin ApiClient, re-read on every call: a server switch replaces it. */
export function hostClient<T extends object>(): T | undefined {
    const host: HostWindow = window;
    return host.ApiClient as T | undefined;
}

function idString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}
export interface IdentitySnapshot { readonly userId: string | null; readonly serverId: string | null; readonly epoch: number | null; readonly client: IdentityClient | undefined; readonly credentialsCurrent: () => boolean }

/** Read the signed-in user/server from the live client; getters can throw during sign-out. */
export function readClientIdentity(client: IdentityClient | undefined): { userId: string | null; serverId: string | null } {
    let userId: string | null = null;
    let serverId: string | null = null;
    try { userId = idString(client?.getCurrentUserId?.()); } catch { /* signed out */ }
    try {
        const raw = client?.serverId;
        serverId = idString(typeof raw === 'function' ? raw.call(client) : raw) || idString(client?._serverInfo?.Id);
    } catch { /* partially torn-down client */ }
    return { userId, serverId };
}

/**
 * Snapshot the identity that owns asynchronous work. Prefers the session epoch,
 * which advances on every user/server transition (including a return to the same
 * account), and always also compares the live client's user and server.
 */
export function captureIdentity(session: ChromeSession | undefined, client: IdentityClient | undefined): IdentitySnapshot {
    const live = readClientIdentity(client);
    let epoch: number | null = null;
    try { epoch = typeof session?.getEpoch === 'function' ? session.getEpoch() : null; } catch { epoch = null; }
    const read = (get: () => unknown): string | null => { try { return idString(get()); } catch { return null; } };
    const token = read(() => client?.accessToken?.());
    const root = read(() => client?.getUrl?.('/'));
    // Credential bytes stay in the closure, never in diagnostic snapshots.
    return { userId: live.userId, serverId: live.serverId, epoch, client,
        credentialsCurrent: () => read(() => client?.accessToken?.()) === token && read(() => client?.getUrl?.('/')) === root };
}
export function isSameIdentity(owner: IdentitySnapshot, current: IdentitySnapshot): boolean {
    return owner.client === current.client && owner.credentialsCurrent() && current.credentialsCurrent()
        && owner.userId === current.userId && owner.serverId === current.serverId && owner.epoch === current.epoch;
}
/** The current JE global if any; standalone early scripts re-read it per call. */
export function optionalBridge<T extends object>(): T | undefined {
    const host: HostWindow = window;
    return host.JellyfinEnhanced as T | undefined;
}
