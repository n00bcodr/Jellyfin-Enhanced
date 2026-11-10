import type {
    DiscoveryBaseFacade, DiscoveryConfigKey, DiscoveryFilterFacade, FeedKind, LoadMore, ScrollHint,
    ScrollOptions, ScrollState, SeerrResult
} from './discovery/types';
import type { RecommendationsFacade, RecommendationsStage } from './recommendations/types';
import { featureContext, type FeatureContext } from '../../host/context';

type DiscoverySwitches = { readonly [K in DiscoveryConfigKey]?: boolean };
export interface DiscoveryConfig extends DiscoverySwitches {
    readonly JellyseerrExcludeLibraryItems?: boolean;
    readonly JellyseerrExcludeBlocklistedItems?: boolean;
    readonly TmdbEnabled?: boolean;
    readonly RecommendationsPageEnabled?: boolean;
    readonly RecommendationsUsePluginPages?: boolean;
    readonly RecommendationsUseCustomTabs?: boolean;
    readonly RecommendationsUseNativeTab?: boolean;
}
export interface DiscoveryLease { readonly signal: AbortSignal; isCurrent(): boolean }
export interface DiscoverySession {
    getEpoch(): number;
    isCurrent(epoch: number): boolean;
    getUserId?(): string | null;
    getServerId?(): string | null;
    onUserChange(name: string, callback: () => void): (() => void) | void;
    createLease?(): DiscoveryLease;
}
export interface DiscoveryRequestManager {
    getCached(key: string): unknown;
    setCache(key: string, data: unknown, requestedAt?: number): void;
    cacheStamp?(): number;
    fetchWithRetry(url: string, options: RequestInit): Promise<Response>;
    deduplicatedFetch(key: string, fetcher: () => Promise<unknown>, signal?: AbortSignal): Promise<unknown>;
    withConcurrencyLimit<T>(work: () => Promise<T>): Promise<T>;
    metrics?: { readonly enabled: boolean };
    startMeasurement?(name: string): void;
    endMeasurement?(name: string): void;
}
export interface DiscoveryApi {
    checkUserStatus?(): Promise<unknown>;
    fetchCollectionDetails?(collectionId: number): Promise<unknown>;
    fetchGenreSlider?(mediaType: FeedKind): Promise<unknown>;
}
export interface DiscoveryCardUi {
    createJellyseerrCard?(item: SeerrResult, active: boolean, userFound: boolean): HTMLElement | null;
    releasePosters?(root?: HTMLElement | DocumentFragment): void;
}
export interface DiscoveryScrollEngine {
    cardsNeeded?(container: HTMLElement | null, hint: ScrollHint | null | undefined, fallback?: number): number;
    setupInfiniteScroll(state: ScrollState, sectionSelector: string, loadMore: LoadMore, hasMore: () => boolean,
        isLoading: () => boolean, options?: ScrollOptions): void;
    cleanupInfiniteScroll(state: ScrollState): void;
}
export interface BodySubscription { unsubscribe(): void }
export interface DiscoveryHelpers {
    getItemCached?(itemId: string): unknown;
    onBodyMutation?(id: string, callback: () => void): BodySubscription;
    onSidebarRebuilt?(id: string, selector: string, inject: () => void): () => void;
    onNavigate?(callback: () => void): () => void;
    getHeaderElement?(): Element | null;
    getHeaderBottom?(): number;
    isActiveTabContainer?(element: HTMLElement): boolean;
    observeTabContainers?(id: string, selector: string, callback: () => void): { teardown(): void };
}
export interface DiscoveryLifecycle {
    onTeardown(callback: () => void): unknown;
    teardownOn(event: 'navigate'): () => void;
}
export type ViewListener = (view: string | null | undefined, element: Element | null | undefined) => void;
export interface DiscoveryCore {
    lifecycle?: { register(name: string): DiscoveryLifecycle };
    navigation?: { onNavigate(callback: () => void): () => void; onViewPage(callback: ViewListener): () => void };
    ui?: { createSkeletonRows(titles: Array<string | null>): HTMLElement };
}
export interface SeerrDiscoveryHost {
    pluginConfig?: DiscoveryConfig;
    t?(key: string, params?: Record<string, string | number>): string;
    session?: DiscoverySession;
    requestManager?: DiscoveryRequestManager;
    jellyseerrAPI?: DiscoveryApi;
    jellyseerrUI?: DiscoveryCardUi;
    seerrStatus?: { readonly MEDIA: { readonly BLOCKED: number } };
    seamlessScroll?: DiscoveryScrollEngine;
    helpers?: DiscoveryHelpers;
    core?: DiscoveryCore;
    cdn?: { selfhst(file: string): string };
    nativeTabs?: { register(id: string, title: string, mount: (panel: HTMLElement) => void, icon: string): void };
    discoveryFilter?: DiscoveryFilterFacade;
    discoveryBase?: DiscoveryBaseFacade;
    recommendationsPage?: RecommendationsFacade;
    internals?: { recommendationsPage?: RecommendationsStage };
}
export interface DiscoveryApiClient {
    getUrl(path: string): string;
    getCurrentUserId(): string;
    accessToken(): string;
    getItem?(userId: string, itemId: string): Promise<unknown>;
    ajax?(request: { type: string; url: string; headers: Record<string, string>; dataType: string }): Promise<unknown>;
}
interface DiscoveryWindow extends Window {
    JellyfinEnhanced?: SeerrDiscoveryHost;
    ApiClient?: DiscoveryApiClient;
}

/** Only this adapter touches the legacy namespace; each entry reads what it declares above. */
export function discoveryHost(): { JE: SeerrDiscoveryHost; api(): DiscoveryApiClient | undefined } {
    const host: DiscoveryWindow = window;
    const JE = host.JellyfinEnhanced ?? (host.JellyfinEnhanced = {});
    return { JE, api: () => host.ApiClient };
}

/** The discovery group's own `JE.internals` slot (frontend.md §2.3). Its `JE.<name>` facades stay on the typed bridge. */
export type SeerrDiscoveryOwn = { recommendationsPage?: RecommendationsStage };
/** Other features' facades the discovery group reads (published by their owners; optional, they may load later). */
export interface SeerrDiscoveryPeers { hiddenContent: { filterJellyseerrResults(results: SeerrResult[], surface: string): SeerrResult[] } }
export type SeerrDiscoveryContext = FeatureContext<SeerrDiscoveryOwn, SeerrDiscoveryPeers, SeerrDiscoveryHost>;
const discoveryContexts = new WeakMap<SeerrDiscoveryHost, SeerrDiscoveryContext>();
/** The feature context around a discovery-group bridge, one per bridge object. */
export function discoveryContext(JE: SeerrDiscoveryHost): SeerrDiscoveryContext {
    let ctx = discoveryContexts.get(JE);
    if (!ctx) {
        ctx = featureContext<SeerrDiscoveryOwn, SeerrDiscoveryPeers, SeerrDiscoveryHost>('seerr', JE, {
            internalSlots: ['recommendationsPage'],
            internalsObject: () => JE.internals ?? (JE.internals = {}),
        });
        discoveryContexts.set(JE, ctx);
    }
    return ctx;
}

/** Consumers read the facade at call time: it is the published owner, and it may be replaced. */
export function filterOf(JE: SeerrDiscoveryHost): DiscoveryFilterFacade {
    if (!JE.discoveryFilter) throw new Error('Discovery filter utilities are not loaded');
    return JE.discoveryFilter;
}
export function baseOf(JE: SeerrDiscoveryHost): DiscoveryBaseFacade {
    if (!JE.discoveryBase) throw new Error('Discovery base is not loaded');
    return JE.discoveryBase;
}
export function translate(JE: SeerrDiscoveryHost, key: string, params?: Record<string, string | number>): string {
    return JE.t?.(key, params) ?? key;
}
/** Cancels `controller` with the session epoch it was created in, including silent adoption. */
export function bindToSession(JE: SeerrDiscoveryHost, controller: AbortController): void {
    const lease = JE.session?.createLease?.();
    if (!lease) return;
    if (lease.signal.aborted) { controller.abort(); return; }
    lease.signal.addEventListener('abort', () => controller.abort(), { once: true, signal: controller.signal });
}
/** The identity a cache entry belongs to. Empty only on a host without a session. */
export function identityKey(JE: SeerrDiscoveryHost): string {
    const session = JE.session;
    if (!session) return '';
    return `${session.getServerId?.() ?? ''}:${session.getUserId?.() ?? ''}:${session.getEpoch()}`;
}
