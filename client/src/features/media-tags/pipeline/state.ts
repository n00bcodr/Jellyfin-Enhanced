import type { PipelineApi, PipelineRenderer, PipelineRendererConfig } from './contract';
import { finite, isRecord, record, type JsonRecord } from './dto';
import type { TagApiClient, TagRuntimeBridge } from './tag-pipeline';
import type { SnapshotBase } from './tag-cache-store';

export type EntryPairs = Array<[string, JsonRecord]>;
export interface ItemFacts { entry: JsonRecord; fetchedAt: number; expires: number; seasonKey: string | null }
/** The token a card waits on while its look needs item data. */
export type CardWait = false | undefined | { cardId: string; generation: number };
export interface ScannedCard { el: HTMLElement; itemId: string; itemType: string | null; reuse: number }
export interface QueuedCard extends ScannedCard { renderTarget: HTMLElement; cardId: string; awaiting: CardWait }
export interface StoredStream { scope: string; token: string; count: number }
export type FullLoad = { unbounded: true } | { unbounded?: false; resp: JsonRecord; entries: EntryPairs; pages: number; stored?: { scope: string; servedAt: number; count: number } };
export interface AccessOutcome { applied: boolean; dropped: string[] }

/** Server entries are records keyed by item id; anything else cannot render. */
export function entryPairs(items: unknown): EntryPairs {
    return Object.entries(record(items)).filter((pair): pair is [string, JsonRecord] => isRecord(pair[1]));
}
export const servedAtOf = (resp: JsonRecord): number => (typeof resp.servedAt === 'number' ? resp.servedAt : 0);
export const textOrEmpty = (value: unknown): string => (typeof value === 'string' ? value : '');
export const cursorOf = (resp: JsonRecord): number => finite(resp.timestamp) ?? 0;
/** A response's first item. A later item never stands in for a first one that is not an item. */
export function firstItem(response: JsonRecord): JsonRecord | null {
    const first: unknown = Array.isArray(response.Items) ? response.Items[0] : null;
    return isRecord(first) ? first : null;
}

// ── Configuration ──────────────────────────────────────────────────

export const MEDIA_TYPES = new Set(['Movie', 'Episode', 'Series', 'Season', 'BoxSet', 'Video']);
export const isMediaType = (type: unknown): boolean => typeof type === 'string' && MEDIA_TYPES.has(type);
export const logPrefix = '🪼 Jellyfin Enhanced [TagPipeline]:';
export const MEMORY_SOFT_CAP = 20000;

/** The pipeline's mutable state, shared by every module (one object per createTagPipeline call). */
export interface PipelineState {
    // ── Server cache state ─────────────────────────────────────────────
    //
    // Entries come from the server's pre-computed cache and live in two places:
    // `serverCache` in memory and, when the browser allows it, a per-user copy
    // in IndexedDB (tags/tag-cache-store.js). The first load downloads the
    // whole cache — memory then holds every entry (serverCacheComplete) — and
    // persists it in idle slices. Every later page load restores from the
    // stored copy instead: memory starts empty and fills from IndexedDB as
    // cards ask for entries, while a `?since=` request fetches only what
    // changed. The stored copy is scoped to server + user because the payload
    // is filtered (library access) and spoiler-stripped for the user who
    // fetched it, and it records the filter revision it was made under: a
    // restored copy renders nothing until that first `?since=` answer confirms
    // the revision (and version) still match — access or Spoiler Guard changed
    // (possibly elsewhere) means a full download instead, so a stale filter or
    // strip never reaches a card. Without IndexedDB
    // (private mode, quota, errors) this is exactly the old behaviour: one full
    // download per page load, memory only.
    serverCache: Map<string, JsonRecord> | null; // Map<itemId, TagCacheEntry>; null = not in use (batch fallback)
    serverCacheComplete: boolean; // memory holds every entry the server has for this user
    serverCacheVersion: unknown;
    serverCacheTimestamp: number;
    serverFilterRevision: string | null; // filter revision memory was made under (access + Spoiler Guard, from the server)
    serverFilterBase: string; // the same without access: equal across an access-only change, which a delta can reconcile
    cacheGeneration: number; // bumped whenever memory is replaced or dropped
    storeGate: Promise<void> | null; // Promise while a restored copy awaits confirmation; lookups wait on it
    openStoreGate: (() => void) | null; // resolves storeGate
    readonly deltaIds: Set<string>; // ids memory holds from a delta (newer than the stored copy until persisted)
    deltaInFlight: { epoch: number; generation: number; promise: Promise<void> } | null; // { promise, epoch, generation } of the running fetchDelta(), shared by load and refresh
    storeBaseServedAt: number; // capture time of the stored snapshot this page restored and confirmed
    storeScope: string | null; // `${serverId}:${userId}` while the stored copy backs lookups/writes
    persistGeneration: number; // bumped whenever queued stored-copy writes must stop
    persistChain: Promise<void>; // stored-copy writes run one after another
    readonly storeMisses: Set<string>; // ids the stored copy has no entry for (never ask IndexedDB twice)
    skipStoreThisSession: boolean; // server answered empty or disabled: don't restore a stored copy
    perCardThisSession: boolean; // a full load could not stay bounded (no stored copy for a large library): cards ask per batch
    loadInFlight: Promise<void> | null; // Promise of the running loadServerCache(), shared by concurrent callers
    loadInFlightEpoch: number; // session epoch that load was started for
    refreshInFlight: Promise<void> | null; // Promise of the running refreshServerCache()
    serverCacheWait: number; // bumped to end the running waitForServerCache()
    lastNavigationRoute: string | null; // route key of the last navigation the pipeline acted on (see navigationRoute)
    lastNavRefreshAt: number; // performance.now() of the last navigation-triggered delta
    navRefreshTimer: ReturnType<typeof setTimeout> | null; // trailing delta for navigations that fell inside the minimum interval
    reviewRatings: Map<string, number> | null; // Map<"mediaType:tmdbKey", average> from the payload; null = unavailable
    reviewRatingsRequestedAt: number; // performance.now() when the request behind reviewRatings started
    readonly reviewRatingsListeners: Set<(changed: Set<string> | null) => void>; // called with the changed keys (Set, or null = all) when averages change
    // Shape of the stored entries (the server's tag cache schema they were
    // written under). A stored copy of another shape is dropped on restore and
    // downloaded in full, so new entry fields never wait for a server rebuild
    // that happens to change the cache version. Current schema: Awards, Logos and Custom matches.
    // Use the store identity in the bundle; standalone fallback has the same entry schema.
    readonly STORED_ENTRY_SCHEMA: number;
    // ── State ──────────────────────────────────────────────────────────
    readonly renderers: Map<string, PipelineRenderer>; // name → { render, isEnabled, needsFirstEpisode, needsParentSeries }
    processedCards: WeakSet<Element>; // let, not const — needs reassignment on reinit
    readonly firstEpisodeCache: Map<string, Promise<JsonRecord | null>>; // seriesId → Promise<item|null>
    // Caller-filtered Series/Season facts from /tag-data, shared with server-cache readers.
    readonly seasonFactIds: Map<string, string>; // seriesId:season → normalized season id
    readonly itemFacts: Map<string, ItemFacts>; // normalized id → { entry, fetchedAt, expires, seasonKey }
    readonly parentSeriesCache: Map<string, Promise<JsonRecord | null>>; // seriesId → Promise<item|null>
    fetchTimer: ReturnType<typeof setTimeout> | null;
    pipelineStarted: boolean; // initialize() has wired the observers and loaded the server cache
    startWhenRendererRegisters: boolean; // initialize() ran with no tag type enabled
    deferredLoad: { forceDownload: boolean } | null; // { forceDownload } of an invalidation that skipped its reload (no tag type on)
    loadStartedForEpoch: number | null; // session epoch in which a renderer registration started the load
    isProcessing: boolean;
    batchGeneration: number; // Incremented on navigation to cancel stale in-flight batches
    /** Release a retired drain even if a first-episode request is still pending. */
    cancelBatchWait: (() => void) | null;
    activeBatch: QueuedCard[]; // entries whose request is currently in flight
    requestQueue: QueuedCard[]; // { el, renderTarget, itemId, itemType, cardId, awaiting, reuse }
    readonly cardReuse: WeakMap<Element, number>; // card image → invalidations from reuse or updated metadata (see releaseReusedCards, refreshVisibleCards)
    // The server's effective data-affecting strip policy for /tag-data answers
    // ("none": nothing; SpoilerTagDataStripper.TagStripRevision): the page-load
    // bootstrap's value, then that of the latest batch answer (batches run one
    // at a time, and a cancelled one's answer is dropped). Null while unknown:
    // after a user switch or Spoiler Guard change until the next answer.
    // Renderers keeping /tag-data results across page loads stamp them with it
    // and fetch again when it differs (core/tag-renderer-base.js).
    tagStripRevision: string | null;
    scanScheduled: boolean;
    msPerCard: number;
    scanGeneration: number; // Incremented on each new scan to cancel stale chunk chains
    /** itemId → { Type, SeriesId, LibraryId, Genres, OfficialRating, at }; null = not loaded */
    lookFacts: Map<string, JsonRecord>|null;
    lookFactsSaveRegistered: boolean;
    isInvalidating: boolean;
}

/**
 * The initial state: the same initial values, in the same order, as the variables it replaces.
 * @param JE - The tag runtime bridge.
 */
export function createPipelineState(JE: TagRuntimeBridge): PipelineState {
    const STORED_ENTRY_SCHEMA = JE.tagCacheStore?.ENTRY_SCHEMA ?? 52;
    let prefetchedStripRevision: unknown;
    try { prefetchedStripRevision = JE.takePrefetched?.('TagStripRevision'); } catch { /* Unknown until an authoritative answer. */ }
    return {
        serverCache: null,
        serverCacheComplete: false,
        serverCacheVersion: 0,
        serverCacheTimestamp: 0,
        serverFilterRevision: null,
        serverFilterBase: '',
        cacheGeneration: 0,
        storeGate: null,
        openStoreGate: null,
        deltaIds: new Set<string>(),
        deltaInFlight: null,
        storeBaseServedAt: 0,
        storeScope: null,
        persistGeneration: 0,
        persistChain: Promise.resolve(),
        storeMisses: new Set<string>(),
        skipStoreThisSession: false,
        perCardThisSession: false,
        loadInFlight: null,
        loadInFlightEpoch: 0,
        refreshInFlight: null,
        serverCacheWait: 0,
        lastNavigationRoute: null,
        lastNavRefreshAt: -Infinity,
        navRefreshTimer: null,
        reviewRatings: null,
        reviewRatingsRequestedAt: 0,
        reviewRatingsListeners: new Set<(changed: Set<string> | null) => void>(),
        STORED_ENTRY_SCHEMA,
        renderers: new Map<string, PipelineRenderer>(),
        processedCards: new WeakSet<Element>(),
        firstEpisodeCache: new Map<string, Promise<JsonRecord | null>>(),
        seasonFactIds: new Map<string, string>(),
        itemFacts: new Map<string, ItemFacts>(),
        parentSeriesCache: new Map<string, Promise<JsonRecord | null>>(),
        fetchTimer: null,
        pipelineStarted: false,
        startWhenRendererRegisters: false,
        deferredLoad: null,
        loadStartedForEpoch: null,
        isProcessing: false,
        batchGeneration: 0,
        cancelBatchWait: null,
        activeBatch: [],
        requestQueue: [],
        cardReuse: new WeakMap<Element, number>(),
        tagStripRevision: typeof prefetchedStripRevision === 'string' ? prefetchedStripRevision : null,
        scanScheduled: false,
        msPerCard: 1.5,
        scanGeneration: 0,
        lookFacts: null,
        lookFactsSaveRegistered: false,
        isInvalidating: false,
    };
}

/** The pipeline modules' functions other modules call (through `deps`), the published api and the host's ApiClient readers. */
export interface PipelineFns {
    /** media-tags/host.ts's ApiClient readers, injected by createTagPipeline (the pipeline's only import of host/). */
    apiClient: () => TagApiClient;
    hasApiClient: () => boolean;
    advanceBatchGeneration: () => void;
    anyTagTypeEnabled: () => boolean;
    api: PipelineApi;
    applyReviewRatings: (resp: JsonRecord, requestedAt: number) => void;
    downloadFullCache: (options?: { fresh?: boolean; }) => Promise<boolean>;
    dropServerCache: () => void;
    enrichedLookFacts: (facts: JsonRecord | undefined) => boolean;
    fetchDelta: () => Promise<void>;
    forgetItemFacts: (id: string) => void;
    getFirstEpisode: (userId: string, parentId: string, firstEpisodeId?: string | null) => Promise<JsonRecord | null>;
    getParentSeries: (userId: string, seriesId: string) => Promise<JsonRecord | null>;
    hasAnyEnabledRenderer: () => boolean;
    idleYield: () => Promise<void>;
    initialize: () => void;
    itemLookFacts: (itemId: string) => Promise<JsonRecord | null>;
    loadServerCache: (options?: { forceDownload?: boolean; }) => Promise<void>;
    lookFactsMap: () => Map<string, JsonRecord>;
    lookupItemFacts: (ids: readonly string[]) => Promise<void>;
    lookupServerEntries: (ids: readonly string[]) => Map<string, JsonRecord> | Promise<Map<string, JsonRecord>>;
    navigationRoute: () => string;
    needsLibraryFacts: () => boolean;
    peekItemFacts: (id: string) => JsonRecord | null;
    peekSeasonFacts: (seriesId: string, season: number) => JsonRecord | null;
    persistDelta: (entries: EntryPairs, base: SnapshotBase, timestamp: number, servedAt: number, removed?: readonly string[]) => void;
    queuePersist: (work: () => Promise<void>) => void;
    refreshServerCache: () => Promise<void>;
    refreshVisibleCards: (updatedIds?: readonly string[] | null, hiddenIds?: readonly string[], unchanged?: (id: string) => boolean) => void;
    refreshServerCacheCore: () => Promise<void>;
    registerRenderer: (name: string, config: PipelineRendererConfig) => void;
    releaseReusedCards: (mutations: MutationRecord[]) => void;
    releaseStoreGate: (gate?: Promise<void> | null) => void;
    rememberItemFacts: (entry: JsonRecord, id?: unknown, fetchedAt?: number) => void;
    rememberLookFacts: (itemId: string, item: JsonRecord, source?: "tag-data" | "item") => void;
    resolveRenderTarget: (el: HTMLElement) => HTMLElement;
    runScan: () => void;
    scheduleFetch: () => void;
    scheduleNavigationRefresh: () => void;
    scheduleScan: () => void;
    shouldSkipElement: (el: HTMLElement) => boolean;
    stillShows: (card: { el: HTMLElement; reuse: number; }) => boolean;
    waitForServerCache: (ready: (entries: Iterable<JsonRecord>) => boolean, options?: { delays?: readonly number[]; }) => Promise<boolean>;
}
