import type { Session } from '../../core/session';
import type { Lifecycle } from '../../core/lifecycle';
import type { MediaSegment } from './wire';
import { featureContext, type FeatureContext } from '../../host/context';
export interface Subscription { unsubscribe(): void }
export interface PlayerSettings {
    longPress2xEnabled?: boolean; autoSkipIntro?: boolean; autoSkipOutro?: boolean;
    pauseScreenEnabled?: boolean; pauseScreenDelaySeconds?: number;
    disableCustomSubtitleStyles?: boolean; subtitleHorizontalPosition?: number; subtitleVerticalPosition?: number;
    selectedTextEffectPresetIndex?: number; selectedFontSizePresetIndex?: number; selectedFontFamilyPresetIndex?: number;
    customSubtitleTextColor?: string; customSubtitleBgColor?: string;
}
export interface NowPlaying {
    normalizeId(id: unknown): string | null;
    itemIdFromSource(video?: HTMLVideoElement | null): string | null;
    itemIdFromRoute(): string | null;
    itemIdFromSession(video?: HTMLVideoElement | null): Promise<string | null>;
    resolveItemId(video?: HTMLVideoElement | null): Promise<string | null>;
}
export interface AutoSkipDependencies {
    shouldSkipType(type: string | undefined): boolean;
    fetchSegments(itemId: string): Promise<MediaSegment[]>;
    resolveItemId(video: HTMLVideoElement): string | null;
    onSkipped(segment: MediaSegment): void;
    getPositionOffsetTicks(video: HTMLVideoElement): number;
}
export interface ResolverOptions { parseFromSrc(src: string): string | null; fallbackId(): string | null; probeNowPlayingId(): Promise<string | null> }
export interface SkipEngine { attach(video: HTMLVideoElement): void; detach(): void }
export interface PressEvent { button?: number; clientX?: number; clientY?: number; touches?: TouchList; preventDefault(): void; stopPropagation(): void; stopImmediatePropagation(): void }
export interface PlayerBridge {
    currentSettings: PlayerSettings;
    pluginConfig?: { ShowRatingInPlayer?: boolean; ShowPlaybackRatingBadge?: boolean };
    state: { pauseScreenClickTimer?: number | null };
    session?: Session;
    lifecycle?: Lifecycle;
    core: {
        api?: { jf(path: string, options: { skipCache: boolean }): Promise<unknown> };
        navigation?: { onNavigate(callback: () => void): () => void };
        dom: { waitForElement(selector: string, options: { timeout: number; quiet: boolean; predicate(el: Element): boolean; signal?: AbortSignal }): Promise<Element | null> };
        ui: { isTvLayout(): boolean };
    };
    helpers: { onBodyMutation(name: string, callback: (records: MutationRecord[]) => void): Subscription };
    t(key: string, params?: Record<string, string | number>): string;
    toast(text: string): void;
    escapeHtml(text: string): string;
    icons: { wrapEmoji(text: string): string };
    icon(name: string): string;
    IconName: { FAST_FORWARD: string; PLAY: string };
    isVideoPage(): boolean;
    internals: {
        player?: { getVideo(): HTMLVideoElement | null; getCurrentVideoItemId(): string | null };
        nowPlaying: NowPlaying;
        autoSkip?: { TICKS_PER_SECOND: number; MIN_SEGMENT_TICKS: number; createAutoSkipEngine(deps: AutoSkipDependencies): SkipEngine; createSessionItemResolver(options: ResolverOptions): (video: HTMLVideoElement) => string | null; parseTranscodeOffsetTicksFromSrc(src: string): number; parseItemIdFromVideosSrc(src: string): string | null; segmentTypeEnabled(type: string | undefined): boolean };
    };
    openSettings(callback: () => void): void;
    adjustPlaybackSpeed(direction: string): void; resetPlaybackSpeed(): void; jumpToPercentage(percentage: number): void;
    frameStep(direction: string): Promise<void>; attachSeekTracker(video: HTMLVideoElement): void; jumpToLastPosition(): void;
    skipIntroOutro(): void; cycleSubtitleTrack(): void; cycleAudioTrack(): void; cycleAspect(): void; togglePlaybackInfo(): void;
    handleLongPressDown(event: PressEvent): void; handleLongPressUp(event: PressEvent): void; handleLongPressCancel(): void; handleLongPressMove(event: PressEvent): void; handleLongPressClick(event: PressEvent): void;
    initializeAutoSkipObserver(): void; stopAutoSkip(): void;
    subtitlePresets: { name: string; textColor: string; bgColor: string; previewText: string }[];
    fontSizePresets: { name: string; size: number; previewText: string }[];
    fontFamilyPresets: { name: string; family: string; previewText: string }[];
    subtitleTextEffectPresets: { name: string; shadow: string | null; previewText: string }[];
    getSubtitleTextShadow(bgColor: string, presetIndex?: number): string;
    decodeSubtitleColor(input: unknown, fallback: { fallbackSwatch: string; fallbackAlphaValue: number }): { swatch: string; alphaValue: number };
    applySubtitlePosition(): void;
    applySubtitleStyles(textColor: string, bgColor: string, fontSize: number, fontFamily: string, textShadow?: string): void;
    applySavedStylesWhenReady(): void;
    initializeOsdRating(): void; initializePauseScreen(): void; initializePlaybackRatingBadge(): void;
    pauseScreenInstance?: { overlay: HTMLElement; destroy(): void };
}
interface AjaxOptions { type: string; url: string; dataType?: string; contentType?: string; data?: string }
interface PlayerApi {
    getCurrentUserId(): string | null; deviceId?(): string; serverId?: string | (() => string); serverAddress(): string;
    getUrl(path: string, params?: Record<string, string>): string;
    ajax(options: AjaxOptions): Promise<unknown>;
    getItem(userId: string | null, itemId: string): Promise<unknown>;
}
/** player's own `JE.internals` slots (frontend.md §2.3). Its `JE.<name>` facades stay on the typed bridge. */
export type PlayerOwn = PlayerBridge['internals'];
/** Other features' facades player reads (details-providers' colored ratings polling; it may load later or not at all). */
export interface PlayerPeers { resumeRatingsPolling(): void; pauseRatingsPolling(): void }
export type PlayerFeatureContext = FeatureContext<PlayerOwn, PlayerPeers, PlayerBridge>;
/** Structural bridge confined to the fields the player actually consumes. */
export function playerHost() {
    const host: Window & { JellyfinEnhanced?: PlayerBridge; ApiClient?: PlayerApi } = window;
    const JE = host.JellyfinEnhanced;
    if (!JE) throw new Error('Player loaded before Jellyfin Enhanced');
    const ctx: PlayerFeatureContext = featureContext<PlayerOwn, PlayerPeers, PlayerBridge>('player', JE, {
        internalSlots: ['player', 'nowPlaying', 'autoSkip'],
        internalsObject: () => JE.internals = JE.internals || {} as PlayerBridge['internals'],
    });
    // Read the active API for every operation; Jellyfin replaces it on server changes.
    const requireApi = () => { if (!host.ApiClient) throw new Error('Jellyfin API unavailable'); return host.ApiClient; };
    const ApiClient = {
        getCurrentUserId: () => host.ApiClient?.getCurrentUserId() ?? null,
        deviceId: () => host.ApiClient?.deviceId?.() ?? '',
        serverId: () => { const id = host.ApiClient?.serverId; return typeof id === 'function' ? id.call(host.ApiClient) : id ?? ''; },
        serverAddress: () => requireApi().serverAddress(),
        getUrl: (path: string, params?: Record<string, string>) => requireApi().getUrl(path, params),
        ajax: (options: AjaxOptions) => requireApi().ajax(options),
        getItem: (userId: string | null, itemId: string) => requireApi().getItem(userId, itemId)
    };
    return { JE, ApiClient, ctx };
}
