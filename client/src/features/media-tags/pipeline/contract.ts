import type { JsonRecord } from './dto';

export interface TagHot {
    get(itemId: string): unknown;
    set(itemId: string, payload: unknown): TagHot;
    delete(itemId: string): boolean;
    clear(): void;
    readonly size: number;
}
/** What one renderer receives from the factory; payloads stay unknown until the renderer narrows them. */
export interface TagCtx {
    readonly name: string;
    readonly logPrefix: string;
    readonly containerClass: string;
    readonly taggedAttr: string;
    readonly hot: TagHot | null;
    readonly cacheTtl: number;
    readonly localStorageEnabled: boolean;
    getPersistent(itemId: string): unknown;
    setPersistent(itemId: string, value: unknown): void;
    deletePersistent(itemId: string): void;
    clearPersistent(): void;
    isTagged(el: HTMLElement): boolean;
    markTagged(el: HTMLElement): void;
    shouldIgnore(el: HTMLElement): boolean;
    injectCss(): void;
    removeExistingOverlay(el: HTMLElement): void;
    commitOverlay(el: HTMLElement, overlay: HTMLElement): boolean;
}
export interface TagCacheSpec {
    key: string;
    legacyPrefix: string | readonly string[];
    hotBucket?: string;
    pruneOnSave?: boolean;
    saveOnUnload?: boolean;
}
export interface RenderExtras {
    firstEpisode?: JsonRecord | null;
    parentSeries?: JsonRecord | null;
    ratingParentSeries?: JsonRecord | null;
    renderTarget?: HTMLElement;
    stripRevision?: string | null;
}
export interface RefreshInfo { replaced?: boolean }
export interface TagPipelineSpec {
    render(ctx: TagCtx, el: HTMLElement, item: JsonRecord, extras: RenderExtras): void;
    renderFromCache?(ctx: TagCtx, el: HTMLElement, itemId: string): boolean;
    renderFromServerCache?(ctx: TagCtx, el: HTMLElement, entry: JsonRecord, itemId: string): void;
    onServerCacheRefresh?(ctx: TagCtx, updatedIds: readonly string[] | null, info?: RefreshInfo): void;
    cleanup?(ctx: TagCtx): void;
    needsFirstEpisode?: boolean;
    needsParentSeries?: boolean;
    needsLatestEpisode?: boolean;
}
export interface TagPositionSpec { userKey: string; pluginKey: string; fallback: string }
export interface TagSpec {
    logPrefix: string;
    settingKey: string;
    containerClass: string;
    taggedAttr: string;
    styleId?: string;
    buildCss?(ctx?: TagCtx): string;
    position?: TagPositionSpec;
    cache?: TagCacheSpec;
    ignoreSelectors?: readonly string[];
    searchPageIgnoreSelector?: string;
    shouldIgnore?(el: HTMLElement, defaultMatcher: (el: HTMLElement) => boolean): boolean;
    pipeline?: TagPipelineSpec;
}
/** The renderer as the pipeline drives it. */
export interface PipelineRendererConfig {
    render(el: HTMLElement, item: JsonRecord, extras: RenderExtras): void;
    renderFromCache?: ((el: HTMLElement, itemId: string) => boolean) | undefined;
    renderFromServerCache?: ((el: HTMLElement, entry: JsonRecord, itemId: string) => void) | undefined;
    onServerCacheRefresh?: ((updatedIds: readonly string[] | null, info?: RefreshInfo) => void) | undefined;
    cleanup?: (() => void) | undefined;
    isEnabled(): boolean;
    needsFirstEpisode?: boolean;
    needsParentSeries?: boolean;
    needsLatestEpisode?: boolean;
    injectCss?: (() => void) | undefined;
}
export interface PipelineRenderer {
    render: PipelineRendererConfig['render'];
    renderFromCache: ((el: HTMLElement, itemId: string) => boolean) | null;
    renderFromServerCache: ((el: HTMLElement, entry: JsonRecord, itemId: string) => void) | null;
    onServerCacheRefresh: ((updatedIds: readonly string[] | null, info?: RefreshInfo) => void) | null;
    isEnabled(): boolean;
    needsFirstEpisode: boolean;
    needsParentSeries: boolean;
    needsLatestEpisode: boolean;
    injectCss: (() => void) | null;
    cleanup: (() => void) | null;
}
export interface PipelineApi {
    registerRenderer(name: string, config: PipelineRendererConfig): void;
    initialize(): void;
    getFirstEpisode(userId: string, parentId: string, firstEpisodeId?: string | null): Promise<JsonRecord | null>;
    getParentSeries(userId: string, seriesId: string): Promise<JsonRecord | null>;
    lookupServerEntries(ids: readonly string[]): Map<string, JsonRecord> | Promise<Map<string, JsonRecord>>;
    rememberItemFacts(entry: JsonRecord, id?: unknown, fetchedAt?: number): void;
    peekItemFacts(id: string): JsonRecord | null;
    lookupItemFacts(ids: readonly string[]): Promise<void>;
    peekSeasonFacts(seriesId: string, season: number): JsonRecord | null;
    peekServerEntry(itemId: string): JsonRecord | null;
    getRenderer(name: string): PipelineRenderer | undefined;
    itemLookFacts(itemId: string): Promise<JsonRecord | null>;
    serverEntries(): Iterable<JsonRecord>;
    waitForServerCache(ready: (entries: Iterable<JsonRecord>) => boolean, options?: { delays?: readonly number[] }): Promise<boolean>;
    stopWaitingForServerCache(): void;
    getReviewRatings(): Promise<Map<string, number> | null>;
    peekReviewRatings(): Map<string, number> | null;
    getReviewRatingsRequestedAt(): number;
    tagStripRevision(): string | null;
    onReviewRatingsChanged(listener: (changed: Set<string> | null) => void): void;
    clearProcessed(): void;
    invalidateServerCache(options?: { reuseStored?: boolean }): Promise<void>;
    scheduleScan(): void;
}
export interface RendererApi {
    chipBaseCss(selector: string, code?: boolean): string;
    registerStyles(spec: TagSpec): void;
    ensureStyles(settings: unknown, owner: object): void;
    releaseStyles(owner: object): void;
    register(name: string, spec: TagSpec): TagCtx;
    reinitialize(name: string, spec?: TagSpec): void;
    resolvePosition(userKey: string, pluginKey: string, fallback: string): ResolvedPosition;
    isIgnoredContext(el: HTMLElement | null | undefined): boolean;
    applyCornerStacking(hostOrHosts: HTMLElement | readonly HTMLElement[]): void;
    scheduleCornerStacking(host: HTMLElement | null | undefined): void;
}
export interface ResolvedPosition {
    pos: string;
    isTop: boolean;
    isLeft: boolean;
    topVal: string;
    bottomVal: string;
    leftVal: string;
    rightVal: string;
    needsTopRightOffset: boolean;
}
export interface DirectPlayResult {
    directPlay: boolean;
    remux: boolean;
    reasons: string[];
    container: string | null;
    video: string | null;
    audio: string | null;
}
