import { featureContext, type FeatureContext } from '../../host/context';
import type { HomeRemovalFacade } from '../hidden-content/public-api';
import type { Dom } from '../../core/dom/runtime';
import type { Lifecycle } from '../../core/lifecycle';
import type { Navigation } from '../../core/navigation';
import type { Session } from '../../core/session';
import type { CoreApi } from '../../core/api/api';
import type { ToastOptions, Ui } from '../../core/ui/runtime';
import type { MediaLanguage } from './types/language/media-language';
import type { RatingSources } from './types/ratings/rating-sources';
import type { PosterColours } from './layout/poster-colours';
import type { TagLayout } from './layout/tag-layout';
import type { TagLook } from './layout/tag-look';
import type { statusVocabulary } from './types/status/status-vocabulary';
import type { PipelineApi, RendererApi } from './pipeline/contract';
import type { TagScopes, TagSettingsMatrix } from './pipeline/scopes';
import type { TagCacheStore } from './pipeline/tag-cache-store';
import type { DirectPlay } from './types/direct-play/tag-direct-play';
import type { ItemEditor } from './editor/tag-item-editor';
import type { MaintainerrMenu } from './editor/maintainerr-item-menu';
import type { JsonRecord } from './pipeline/dto';

/** Mutable settings documents with dynamic group keys; values stay unknown until read. */
export type SettingsDocument = Record<string, unknown>;
export interface HotCacheBuckets { ttl: number; [bucket: string]: number | Map<string, unknown> }
export interface CacheManager { register(save: () => void): void; markDirty(): void }
export interface AjaxRequest {
    type: 'GET' | 'POST';
    url: string;
    dataType: 'json';
    data?: string;
    contentType?: string;
}
export type UrlParams = Readonly<Record<string, string | number | boolean>>;
/** Only the ApiClient members Media Tags reads; responses remain unknown. */
export interface TagApiClient {
    getCurrentUserId(): string | null | undefined;
    getUrl(path: string, params?: UrlParams): string;
    ajax(request: AjaxRequest): Promise<unknown>;
    getItem(userId: string | null | undefined, itemId: string): Promise<unknown>;
    getUser(userId: string): Promise<unknown>;
    getCurrentUser(): Promise<unknown>;
    getScaledImageUrl(itemId: string, options: { type: string; maxHeight: number; tag: string }): string;
    serverId?(): string;
    appVersion?(): string;
    appName?(): string;
    deviceName?(): string;
    deviceId?(): string;
    accessToken?(): string;
    getSavedEndpointInfo?(): { IsInNetwork?: unknown } | null | undefined;
    setRequestHeaders?(headers: Record<string, string>): void;
}
export interface SpoilerGuardFacade {
    isLoaded?(): boolean;
    isLoadOk?(): boolean;
    isEnabledFor?(id: unknown): boolean;
    getUserPrefs?(): { HideRatings?: boolean } | null | undefined;
}
export interface TagPreviewInteraction { dispose(): void }
export interface TagRuntimeInternals {
    enhancedUi?: {
        bindTagPreviewInteraction(cards: readonly (Element | null)[], view: Element | null, options: { change(active: boolean): void }): TagPreviewInteraction;
    };
    peopleTags?: {
        prefetch(itemId: string, item: JsonRecord, view: Element, epoch: number): void;
        leave(itemId: string): void;
    };
}
export interface TagRuntimeCore {
    ui: Pick<Ui, 'injectCss' | 'removeCss'>;
    dom?: Pick<Dom, 'createObserver' | 'onBodyMutation'>;
    api: Pick<CoreApi, 'plugin'>;
    navigation?: Pick<Navigation, 'onNavigate'>;
    lifecycle: Pick<Lifecycle, 'register'>;
    mediaLanguage: MediaLanguage;
    tagLayout?: TagLayout & { buildFlushStyles?: (scope?: string) => string };
    tagLook?: TagLook;
    tagRenderer: RendererApi;
    tagScopes?: TagScopes;
    tagSettingsMatrix?: TagSettingsMatrix;
    languageTags?: import('./types/language/languagetags').LanguageTagsApi;
}
export interface TagRuntimeHelpers {
    getItemCached?(id: string, options?: { userId: string }): Promise<unknown>;
    onBodyMutation?(id: string, callback: (mutations: MutationRecord[]) => void, options?: { priority?: number }): unknown;
    onNavigate?(callback: () => void): unknown;
    addCSS?(id: string, css: string): unknown;
    createObserver?: Dom['createObserver'];
    debounce<A extends unknown[]>(callback: (...args: A) => void, wait: number): (...args: A) => void;
}
/** The legacy global surface this slice reads and installs, and nothing else. */
export interface TagRuntimeBridge {
    core: TagRuntimeCore;
    session?: Session;
    currentSettings?: SettingsDocument;
    pluginConfig?: SettingsDocument;
    helpers?: TagRuntimeHelpers;
    internals?: TagRuntimeInternals;
    spoilerBlur?: SpoilerGuardFacade;
    /** media-tags' facade for the details page's visits: the object in `JE.internals.peopleTags` (step C4). */
    peopleTags?: TagRuntimeInternals['peopleTags'];
    cdn: { url(bucket: string, file: string): string; flagPng(code: string): string };
    t(key: string, values?: Readonly<Record<string, unknown>>): string;
    toast?(message: string, duration?: number, options?: ToastOptions): unknown;
    escapeHtml(value: string): string;
    takePrefetched?(name: string): unknown;
    detectCardRowSurface?(el: Element): string;
    normalizeOfficialRating?(text: string): unknown;
    reinitializeTagLayout?(): unknown;
    _hotCache?: HotCacheBuckets;
    _cacheManager?: CacheManager;
    statusVocabulary: typeof statusVocabulary;
    ratingSources: RatingSources;
    tagPosterColours?: Pick<PosterColours, 'setActive'>;
    tagCacheStore?: TagCacheStore;
    tagPipeline?: PipelineApi;
    tagDirectPlay?: DirectPlay;
    tagItemEditor?: ItemEditor;
    tagItemMenu?: { inject(): Promise<void>; DATA_ID: string };
    maintainerrMenu?: MaintainerrMenu;
    tagStyles?: import('./layout/tag-styles').TagStyles;
    genreTags?: { iconFor(name: string): string; labelFor(name: string): string };
    logoTags?: import('./types/logo/logotags').LogoTags;
    customTags?: import('./types/custom/customtags').CustomTags;
    awardsTags?: import('./types/awards/awardstags').AwardsTags;
    selectedMediaSource?(itemId: unknown): string;
    isRatingTagExcludedByScope?(el: HTMLElement, type: unknown): boolean;
    appendUserRatingToContainer?(el: HTMLElement, item: JsonRecord, extras?: import('./pipeline/contract').RenderExtras | null): void;
    invalidateUserReviewTagCache?(tmdbKey?: string, mediaType?: string): void;
    getStatusDateContext?(): { locale: string; timeZone: string };
    initializeGenreTags?(): void;
    reinitializeGenreTags?(): void;
    initializeLanguageTags?(): void;
    reinitializeLanguageTags?(): void;
    initializePeopleTags?(): void;
    initializeQualityTags?(): void;
    reinitializeQualityTags?(): void;
    initializeRatingTags?(): void;
    reinitializeRatingTags?(): void;
    initializeAgeRatingTags?(): void;
    reinitializeAgeRatingTags?(): void;
    initializeAwardsTags?(): void;
    reinitializeAwardsTags?(): void;
    initializeStatusTags?(): void;
    reinitializeStatusTags?(): void;
    initializeLogoTags?(): void;
    reinitializeLogoTags?(): void;
    initializeCustomTags?(): void;
    reinitializeCustomTags?(): void;
    initializeTagStyles?(): Promise<void>;
    initializeUserReviewTags?(): void;
}
/** The one typed assertion at the legacy global: later loader entries fill the optional members. */
export function tagRuntimeHost(): TagRuntimeBridge {
    const host: Window & { JellyfinEnhanced?: object } = window;
    const bridge = (host.JellyfinEnhanced ??= {}) as TagRuntimeBridge;
    bridge.core ??= {} as TagRuntimeCore;
    return bridge;
}
/** media-tags' own slots (frontend.md §2.3): its owner-only `JE.internals` slot (internals-owners.json). */
export type MediaTagsOwn = Pick<TagRuntimeInternals, 'peopleTags'>;
/**
 * Other features' facades media-tags reads. `spoilerBlur` is spoiler-guard's; its public-api.ts exports no type
 * for it yet, so the structural `SpoilerGuardFacade` above (only the members read here) types it. `homeRemoval` is
 * hidden-content's (step C4; the item menu's row builder).
 */
export interface MediaTagsPeers { spoilerBlur: SpoilerGuardFacade; homeRemoval: HomeRemovalFacade }
export type MediaTagsContext = FeatureContext<MediaTagsOwn, MediaTagsPeers, TagRuntimeBridge>;
/** The context the tag runtime modules get (step C3): `core` is the bridge `tagRuntimeHost()` returns. */
export function mediaTagsContext(JE: TagRuntimeBridge = tagRuntimeHost()): MediaTagsContext {
    return featureContext<MediaTagsOwn, MediaTagsPeers, TagRuntimeBridge>('media-tags', JE, {
        internalSlots: ['peopleTags'],
        // Same expression the modules used before (`JE.internals = JE.internals || {}`).
        internalsObject: () => JE.internals = JE.internals || {},
    });
}
/**
 * media-tags' read of the settings registry `JE.internals.enhancedUi` (co-owned with settings-panel and
 * hidden-content: internals-owners.json, step C4), the same expression its admin page, admin sections and item
 * editor used (`JE.internals?.enhancedUi`).
 */
export function settingsUi<T>(JE: { internals?: { enhancedUi?: T } | undefined }): T | undefined {
    return JE.internals?.enhancedUi;
}
/** ApiClient, resolved at each call: jellyfin-web replaces it on a server switch. */
export function hasApiClient(): boolean {
    const host: Window & { ApiClient?: TagApiClient } = window;
    return host.ApiClient !== undefined && host.ApiClient !== null;
}
export function apiClient(): TagApiClient {
    const host: Window & { ApiClient?: TagApiClient } = window;
    if (!host.ApiClient) throw new Error('Jellyfin ApiClient unavailable');
    return host.ApiClient;
}
