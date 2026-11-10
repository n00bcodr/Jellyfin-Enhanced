import type { Session } from '../../core/session';
import type { Lifecycle } from '../../core/lifecycle';
import type { RequestOptions } from '../../core/api/types';
import type { SpoilerBlurUserPrefs } from '../../contracts/generated';
import { featureContext, type FeatureContext } from '../../host/context';
export type Prefs = Partial<SpoilerBlurUserPrefs> & Record<string, boolean | null | undefined>;
export interface MutationResult { promoted?: string; removedFrom?: string; jellyfinId?: string; removed?: boolean; prefs?: Prefs }
export interface SettingsContext { presetBoxBackground: string; toggleAccentColor: string; help: Element; onClose?(callback: () => void): void; resetAutoCloseTimer(): void }
export interface SpoilerSurface {
    normalizeId: (id: unknown) => string;
    pendingKey: (mediaType: unknown, tmdbId: unknown) => string;
    kindOf: (itemType: unknown) => string;
    loadState: () => Promise<void>;
    whenLoaded: () => Promise<void>;
    isStateLoaded: () => boolean;
    isLoadOk: () => boolean;
    isLoaded: () => boolean;
    hasAnyState: () => boolean;
    isDisableSnoozed: () => boolean;
    isEnabledFor: (id: unknown) => boolean;
    isMovieEnabledFor: (id: unknown) => boolean;
    isCollectionEnabledFor: (id: unknown) => boolean;
    isMovieInScope: (id: unknown) => Promise<boolean>;
    isEnabledForKind: (kind: string, id: unknown) => boolean;
    enableForSeries: (id: unknown, name?: string) => Promise<void>;
    disableForSeries: (id: unknown, name?: string) => Promise<void>;
    enableForMovie: (id: unknown, name?: string) => Promise<void>;
    disableForMovie: (id: unknown, name?: string) => Promise<void>;
    enableForCollection: (id: unknown, name?: string) => Promise<void>;
    disableForCollection: (id: unknown, name?: string) => Promise<void>;
    isTmdbPending: (mediaType: unknown, tmdbId: unknown) => boolean;
    isTmdbEnabled: (mediaType: unknown, tmdbId: unknown, jellyfinMediaId?: unknown) => boolean;
    enableForTmdb: (mediaType: unknown, tmdbId: unknown, displayName?: string) => Promise<MutationResult>;
    disableForTmdb: (mediaType: unknown, tmdbId: unknown) => Promise<MutationResult>;
    getUserPrefs: () => Prefs;
    setUserPrefs: (next: Prefs) => Promise<Prefs>;
    setDisableSnooze: () => void;
    setIdentityCookie: () => void;
    primeIdentityCookie: () => void;
    injectStyles: () => void;
    installWatchedRefresh: () => void;
    refreshSpoilerableImages: () => void;
    scheduleFullReload: () => void;
    bustSpoilerImageUrl: (url: string, cacheBuster: string) => string;
    confirmDisableSpoiler: () => Promise<boolean>;
    addSpoilerBlurButton: (itemId: string, visiblePage: Element, itemType?: string) => void;
    buildSeerrToggle: (data: unknown, mediaType: string) => HTMLButtonElement | null;
    appendSeerrToggle: (mount: Element | null, data: unknown, mediaType: string) => void;
    buildSettingsHtml: (ctx: SettingsContext) => string;
    wireSettings: (ctx: SettingsContext) => void;
}
export interface SpoilerHost {
 internals?: { spoilerGuard?: Partial<SpoilerSurface> };
 session?: Session;
 pluginConfig?: { SpoilerBlurEnabled?: boolean; SpoilerBlurStrictRefresh?: boolean; SpoilerStripReviews?: boolean; SpoilerStripSeriesOverview?: boolean; SpoilerStripOverview?: boolean; SpoilerStripTags?: boolean; SpoilerStripChapters?: boolean; SpoilerStripTaglines?: boolean; SpoilerStripRatings?: boolean; SpoilerStripPremiereDate?: boolean; SpoilerReplaceTitle?: boolean; SpoilerStripCast?: boolean; SpoilerBlurTrickplay?: boolean; SpoilerAdvancedMode?: boolean };
 core: { lifecycle?: Lifecycle; api: { plugin(path: string, options?: RequestOptions): Promise<unknown>; manager?: { clearCacheMatching(pattern: string): void } }; ui: { injectCss(id: string, css: string): void } };
 takePrefetched?(key: 'SpoilerBlurSeries'): unknown;
 t(key: string): string; escapeHtml?(value: string): string; toast?(value: string): void;
 icon(name: string): string; IconName: { BLUR_ON: string };
 spoilerBlur?: Pick<SpoilerSurface, 'addSpoilerBlurButton' | 'isEnabledFor' | 'isMovieEnabledFor' | 'isMovieInScope' | 'isCollectionEnabledFor' | 'enableForSeries' | 'disableForSeries' | 'enableForMovie' | 'disableForMovie' | 'enableForCollection' | 'disableForCollection' | 'isTmdbEnabled' | 'enableForTmdb' | 'disableForTmdb' | 'hasAnyState' | 'whenLoaded' | 'isLoadOk' | 'isLoaded' | 'confirmDisableSpoiler' | 'getUserPrefs' | 'setUserPrefs'> & { init(): void } & SpoilerBlurForwards;
}
/**
 * The `JE.spoilerBlur` members other features call (step C4): read from the `JE.internals.spoilerGuard` registry on
 * each access, so each is undefined until the module that fills it has loaded (seerr-toggle.ts, settings-tab.ts).
 */
export type SpoilerBlurForwards = { readonly [K in 'appendSeerrToggle' | 'buildSettingsHtml' | 'wireSettings']?: SpoilerSurface[K] | undefined };
/** spoiler-guard's own slots (frontend.md §2.3): the facade it publishes on JE and its JE.internals slot. */
export type SpoilerOwn = Pick<SpoilerHost, 'spoilerBlur'> & NonNullable<SpoilerHost['internals']>;
/** Other features' facades spoiler-guard reads, read at call time (their owners load later or not at all). */
export interface SpoilerPeers {
 tagPipeline: { clearProcessed?(): void; scheduleScan?(): void; invalidateServerCache?(): Promise<unknown> | void };
 jellyseerrMoreInfo: { open?(id: string | number, type: string): Promise<unknown> };
}
export type SpoilerContext = FeatureContext<SpoilerOwn, SpoilerPeers, SpoilerHost>;
export function spoilerHost() {
 const host: Window & { JellyfinEnhanced?: SpoilerHost; ApiClient?: { getCurrentUserId(): string | null }; Dashboard?: { confirm(html: string, title: string, callback: (ok: boolean) => void): void } } = window;
 const JE = host.JellyfinEnhanced;
 if (!JE) throw new Error('Spoiler Guard loaded before Jellyfin Enhanced');
 const ctx: SpoilerContext = featureContext<SpoilerOwn, SpoilerPeers, SpoilerHost>('spoiler-guard', JE, {
  facades: ['spoilerBlur'],
  internalSlots: ['spoilerGuard'],
  internalsObject: () => JE.internals ??= {},
 });
 const registry = ctx.own.spoilerGuard ??= {};
 function required<K extends keyof SpoilerSurface>(key: K): NonNullable<Partial<SpoilerSurface>[K]> {
   const value = registry[key];
   if (value == null) throw new Error(`Spoiler Guard loader dependency missing: ${key}`);
   return value;
 }
 const internal: SpoilerSurface = {
  get normalizeId() { return required("normalizeId"); }, set normalizeId(value) { registry.normalizeId = value; },
  get pendingKey() { return required("pendingKey"); }, set pendingKey(value) { registry.pendingKey = value; },
  get kindOf() { return required("kindOf"); }, set kindOf(value) { registry.kindOf = value; },
  get loadState() { return required("loadState"); }, set loadState(value) { registry.loadState = value; },
  get whenLoaded() { return required("whenLoaded"); }, set whenLoaded(value) { registry.whenLoaded = value; },
  get isStateLoaded() { return required("isStateLoaded"); }, set isStateLoaded(value) { registry.isStateLoaded = value; },
  get isLoadOk() { return required("isLoadOk"); }, set isLoadOk(value) { registry.isLoadOk = value; },
  get isLoaded() { return required("isLoaded"); }, set isLoaded(value) { registry.isLoaded = value; },
  get hasAnyState() { return required("hasAnyState"); }, set hasAnyState(value) { registry.hasAnyState = value; },
  get isDisableSnoozed() { return required("isDisableSnoozed"); }, set isDisableSnoozed(value) { registry.isDisableSnoozed = value; },
  get isEnabledFor() { return required("isEnabledFor"); }, set isEnabledFor(value) { registry.isEnabledFor = value; },
  get isMovieEnabledFor() { return required("isMovieEnabledFor"); }, set isMovieEnabledFor(value) { registry.isMovieEnabledFor = value; },
  get isCollectionEnabledFor() { return required("isCollectionEnabledFor"); }, set isCollectionEnabledFor(value) { registry.isCollectionEnabledFor = value; },
  get isMovieInScope() { return required("isMovieInScope"); }, set isMovieInScope(value) { registry.isMovieInScope = value; },
  get isEnabledForKind() { return required("isEnabledForKind"); }, set isEnabledForKind(value) { registry.isEnabledForKind = value; },
  get enableForSeries() { return required("enableForSeries"); }, set enableForSeries(value) { registry.enableForSeries = value; },
  get disableForSeries() { return required("disableForSeries"); }, set disableForSeries(value) { registry.disableForSeries = value; },
  get enableForMovie() { return required("enableForMovie"); }, set enableForMovie(value) { registry.enableForMovie = value; },
  get disableForMovie() { return required("disableForMovie"); }, set disableForMovie(value) { registry.disableForMovie = value; },
  get enableForCollection() { return required("enableForCollection"); }, set enableForCollection(value) { registry.enableForCollection = value; },
  get disableForCollection() { return required("disableForCollection"); }, set disableForCollection(value) { registry.disableForCollection = value; },
  get isTmdbPending() { return required("isTmdbPending"); }, set isTmdbPending(value) { registry.isTmdbPending = value; },
  get isTmdbEnabled() { return required("isTmdbEnabled"); }, set isTmdbEnabled(value) { registry.isTmdbEnabled = value; },
  get enableForTmdb() { return required("enableForTmdb"); }, set enableForTmdb(value) { registry.enableForTmdb = value; },
  get disableForTmdb() { return required("disableForTmdb"); }, set disableForTmdb(value) { registry.disableForTmdb = value; },
  get getUserPrefs() { return required("getUserPrefs"); }, set getUserPrefs(value) { registry.getUserPrefs = value; },
  get setUserPrefs() { return required("setUserPrefs"); }, set setUserPrefs(value) { registry.setUserPrefs = value; },
  get setDisableSnooze() { return required("setDisableSnooze"); }, set setDisableSnooze(value) { registry.setDisableSnooze = value; },
  get setIdentityCookie() { return required("setIdentityCookie"); }, set setIdentityCookie(value) { registry.setIdentityCookie = value; },
  get primeIdentityCookie() { return required("primeIdentityCookie"); }, set primeIdentityCookie(value) { registry.primeIdentityCookie = value; },
  get injectStyles() { return required("injectStyles"); }, set injectStyles(value) { registry.injectStyles = value; },
  get installWatchedRefresh() { return required("installWatchedRefresh"); }, set installWatchedRefresh(value) { registry.installWatchedRefresh = value; },
  get refreshSpoilerableImages() { return required("refreshSpoilerableImages"); }, set refreshSpoilerableImages(value) { registry.refreshSpoilerableImages = value; },
  get scheduleFullReload() { return required("scheduleFullReload"); }, set scheduleFullReload(value) { registry.scheduleFullReload = value; },
  get bustSpoilerImageUrl() { return required("bustSpoilerImageUrl"); }, set bustSpoilerImageUrl(value) { registry.bustSpoilerImageUrl = value; },
  get confirmDisableSpoiler() { return required("confirmDisableSpoiler"); }, set confirmDisableSpoiler(value) { registry.confirmDisableSpoiler = value; },
  get addSpoilerBlurButton() { return required("addSpoilerBlurButton"); }, set addSpoilerBlurButton(value) { registry.addSpoilerBlurButton = value; },
  get buildSeerrToggle() { return required("buildSeerrToggle"); }, set buildSeerrToggle(value) { registry.buildSeerrToggle = value; },
  get appendSeerrToggle() { return required("appendSeerrToggle"); }, set appendSeerrToggle(value) { registry.appendSeerrToggle = value; },
  get buildSettingsHtml() { return required("buildSettingsHtml"); }, set buildSettingsHtml(value) { registry.buildSettingsHtml = value; },
  get wireSettings() { return required("wireSettings"); }, set wireSettings(value) { registry.wireSettings = value; },
 };
 const ApiClient = { getCurrentUserId: () => host.ApiClient?.getCurrentUserId() ?? null };
 return { JE, internal, ApiClient, host, ctx };
}
