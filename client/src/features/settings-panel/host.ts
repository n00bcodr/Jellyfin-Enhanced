import type { JsonValue } from '../../contracts/generated';
import { featureContext, type FeatureContext, type SaveOptions, type SettingsDocument } from '../../host/context';
import type { MediaLanguage, PosterColours, RatingSources, TagLayout, TagLook } from '../media-tags/public-api';
import type { EnhancedUi } from './registry';
import type { createIcons } from '../shared/icons';
type Icons = ReturnType<typeof createIcons>;

/**
 * The legacy facade surface the settings panel reads. Each module narrows it
 * with `Pick` to the members it uses; values that come from the server stay
 * JSON-typed (or unknown) until a reader narrows them.
 */
export type { SettingsDocument };
export type Settings = SettingsDocument;
/** Plugin configuration published to the browser: untrusted JSON values. */
export type PluginConfig = { readonly [key: string]: JsonValue | undefined };
export type TranslationParams = Record<string, string | number>;

/** A shortcut entry as stored in shortcuts.json; extra fields from the plugin defaults are kept. */
export interface Shortcut { Name: string; Key: string; Label?: JsonValue; Category?: JsonValue; [extra: string]: JsonValue | undefined }
export interface ShortcutsDocument { Shortcuts: Shortcut[] }
export interface UserConfig {
    settings?: SettingsDocument;
    settingsRevision?: string | null;
    shortcuts: ShortcutsDocument;
}

export interface SubtitlePreset { name: string; previewText: string; textColor: string; bgColor: string }
export interface FontSizePreset { name: string; previewText: string; size: number }
export interface FontFamilyPreset { name: string; previewText: string; family: string }
export interface TextEffectPreset { name: string; previewText: string }
export interface DecodedSubtitleColor { swatch: string; alphaValue: number }

export interface ThemeVariables { [name: string]: string | undefined }

export interface HiddenContentSettingsView {
    enabled?: unknown; showHideButtons?: unknown; showHideConfirmation?: unknown; showButtonJellyseerr?: unknown;
    showButtonLibrary?: unknown; showButtonDetails?: unknown; showButtonCast?: unknown; filterLibrary?: unknown;
    filterDiscovery?: unknown; filterSearch?: unknown; filterCalendar?: unknown; filterUpcoming?: unknown;
    filterRecommendations?: unknown; filterRequests?: unknown; filterNextUp?: unknown; filterContinueWatching?: unknown;
    experimentalHideCollections?: unknown;
}
export type HiddenContentSettingKey = keyof HiddenContentSettingsView;
export interface HiddenContentSurface {
    getSettings(): HiddenContentSettingsView;
    getHiddenCount(): number;
    updateSettings(changes: Partial<Record<HiddenContentSettingKey, boolean>>): void;
    addLibraryHideButtons(): void;
    removeLibraryHideButtons(): void;
    showManagementPanel(): void;
}

/** One rendered fact the tag modules publish for previews (opaque to the panel beyond these fields). */
export interface TagRendererApi {
    applyCornerStacking(host: Element): void;
    /** Load the enabled groups' chip styles for a settings document, owned by `owner` until released. */
    ensureStyles?(settings: SettingsDocument, owner: object): void;
    releaseStyles?(owner: object): void;
    reinitialize?(group: string): void;
}
export interface TagScopesApi {
    readonly SCOPE_IDS: readonly string[];
    allows(group: string, scope: string): boolean;
    scopeOwn(group: string, scope: string): boolean | null;
    setOwn(group: string, scope: string, value: boolean): void;
    follow(group: string): void;
    excludes?(group: string, element: Element): boolean;
}
export interface TagSettingsMatrixApi { offers(surface: string, group: string, control: string): true | string }
export interface LanguageTagSettingsView { audio: boolean; subtitles: boolean; style: string; badge: string }
export interface LanguageTagsApi {
    readSettings(): LanguageTagSettingsView;
    /** The language group wrapper for audio/subtitle codes (null when nothing shows). */
    buildGroup?(data: { audio: string[]; subtitles: string[] }, index: number, flagSrc: (code: string) => string): HTMLElement | null;
}
/** Legacy tag modules the previews draw their sample chips with (outputs are opaque DOM). */
export interface AwardsTagsApi { CSS?: string; resolve(facts: { [key: string]: string | number | boolean }): readonly unknown[] | null | undefined; chip(fact: unknown): Node }
export interface LogoTagsApi { buildChip(logo: { kind: string; name: string; logo: null }, src?: string): HTMLElement | null }
export interface GenreTagsApi { labelFor(name: string): string | null | undefined; iconFor?(name: string): string | null | undefined }
export interface CustomTagRule { id: string; match: string; value: string; label: string; icon: string | null }
export interface CustomTagsApi { currentRules(): { rules: Map<string, CustomTagRule> }; buildChip(rule: CustomTagRule): Node }

export type PanelTagLayout = Pick<TagLayout,
    | 'DEFAULT_ORDER' | 'VOCABULARY_KEYS' | 'LAYOUT_SLOTS' | 'SLOT_TO_POSITION' | 'POSITION_SETTINGS' | 'SHAPES'
    | 'TAG_SCALES' | 'TAG_GAPS' | 'singleChipGroup' | 'normalizeGroup' | 'promoteLegacySettings' | 'readScale'
    | 'readGap' | 'readEdge' | 'invalidateSettings' | 'normalizeSettings' | 'removeGroupEverywhere' | 'sizeLabel'
    | 'fitReveal' | 'isGroup' | 'CONTAINER_CLASS' | 'ensureHost' | 'setCardContext' | 'commitGroup' | 'removeGroup'
    | 'refreshPresentation' | 'resolveLayout' | 'lookSource' | 'describe' | 'clearCard' | 'readShapeOverrides'
    | 'RECOMMENDED_SHAPES' | 'shapesToWire'>;

export interface CoreSurface {
    navigation: { onNavigate(callback: () => void): () => void; onViewPage(callback: () => void): unknown };
    dom: { afterNextPaint(callback: () => void): unknown };
    ui?: { injectCss?(id: string, css: string): unknown; toast?(message: string, duration?: number): unknown };
    tagLayout?: PanelTagLayout;
    tagLook?: TagLook;
    mediaLanguage?: MediaLanguage;
    tagRenderer?: TagRendererApi;
    tagScopes?: TagScopesApi;
    tagSettingsMatrix?: TagSettingsMatrixApi;
    languageTags?: LanguageTagsApi;
}

/** spoiler-guard's settings tab, on its `spoilerBlur` facade (each member undefined until settings-tab.ts loaded). */
export interface SpoilerGuardSettings {
    readonly buildSettingsHtml?: ((ctx: import('./context').PanelContext) => string) | undefined;
    readonly wireSettings?: ((ctx: import('./context').PanelContext) => void) | undefined;
}
export interface Internals {
    enhancedUi?: EnhancedUi;
}

export interface Helpers {
    debounce(callback: () => void, delay: number): () => void;
    getSidebarContainer(): Element | null;
    onBodyMutation(name: string, callback: () => void): unknown;
    isAdmin?(): boolean | null;
}

export interface TagPipeline {
    serverEntries?(): Iterable<unknown>;
    waitForServerCache?(predicate: (entries: Iterable<unknown>) => boolean): Promise<boolean>;
    stopWaitingForServerCache?(): void;
}

/** The facade members the panel and its sections read or provide. */
export interface PanelBridge {
    t(key: string, params?: TranslationParams): string;
    toast(message: string, duration?: number): void;
    icon: Icons['icon'];
    IconName: Icons['IconName'];
    icons: Pick<Icons['icons'], 'wrapEmoji'>;
    escapeHtml(value: unknown): string;
    toCamelCase(value: unknown): unknown;
    pluginVersion?: string;
    pluginConfig: PluginConfig;
    currentSettings: Settings;
    userConfig: UserConfig;
    state: { activeShortcuts: Record<string, string> };
    CONFIG: { readonly HELP_PANEL_AUTOCLOSE_DELAY: JsonValue };
    cdn: { font(name: string): string };
    themer: { getThemeVariables(): ThemeVariables };
    helpers: Helpers;
    core: CoreSurface;
    internals: Internals;
    session?: { getEpoch(): number; onUserChange?(name: string, callback: () => void): unknown };

    loadSettings?(): Settings;
    getSettingsSaveState?(): { version: number; pending: number };
    initializeShortcuts?(): void;
    keyListener: (event: KeyboardEvent) => void;
    keyCombo(event: KeyboardEvent): string;
    saveUserSettings(file: string, settings: Settings | ShortcutsDocument, options?: SaveOptions): Promise<void>;
    isSettingInherited?(settings: Settings, key: string): boolean;
    setSettingInherited?(settings: Settings, key: string, inherit: boolean): boolean;
    inheritedSettingDefault?(settings: Settings, key: string): JsonValue | undefined;
    inheritedSettingKeys?: readonly string[];
    getStatusDateContext?(): { locale: string; timeZone: string };

    subtitlePresets: SubtitlePreset[];
    fontSizePresets: FontSizePreset[];
    fontFamilyPresets: FontFamilyPreset[];
    subtitleTextEffectPresets: TextEffectPreset[];
    decodeSubtitleColor(value: JsonValue | undefined, options: { fallbackSwatch: string; fallbackAlphaValue: number }): DecodedSubtitleColor;
    getSubtitleTextShadow(bgColor: JsonValue | undefined, effectIndex?: number): string;
    applySubtitleStyles(textColor: string, bgColor: string, fontSize: number, fontFamily: string, textShadow: string): void;
    applySubtitlePosition?(): void;
    applySavedStylesWhenReady(): void;
    pauseScreenInstance?: { pauseScreenDelayMs: number } | null;
    addRandomButton(): void;

    hiddenContent?: HiddenContentSurface;
    hiddenContentPage?: { showPage(): void };

    tagPipeline?: TagPipeline;
    awardsTags?: AwardsTagsApi;
    logoTags?: LogoTagsApi;
    genreTags?: GenreTagsApi;
    customTags?: CustomTagsApi;
    tagPosterColours?: Pick<PosterColours, 'normalise' | 'css'>;
    tagItemEditor?: { open(itemId: string, options: { opener: HTMLElement; host?: HTMLElement | undefined }): unknown };
    ratingSources?: RatingSources;
    normalizeOfficialRating?(text: string): unknown;
    initializeQualityTags?(): void; initializeGenreTags?(): void; initializeLanguageTags?(): void;
    initializeRatingTags?(): void; initializeAgeRatingTags?(): void; initializeLogoTags?(): void;
    initializeStatusTags?(): void; initializeAwardsTags?(): void; initializeCustomTags?(): void;
    initializePeopleTags?(): void; initializeTagStyles?(): void;
    reinitializeQualityTags?(): void; reinitializeGenreTags?(): void; reinitializeLanguageTags?(): void;
    reinitializeRatingTags?(): void; reinitializeStatusTags?(): void; reinitializeLogoTags?(): void;
    reinitializeTagLayout?(): void;
    reinitializeAgeRatingTags?(): void; reinitializeAwardsTags?(): void; reinitializeCustomTags?(): void;

    // Provided by this slice (public legacy facade).
    injectGlobalStyles?(): void;
    isVideoPage?(): boolean;
    isDetailsPage?(): boolean;
    addPluginMenuButton?(): void;
    addOsdSettingsButton?(): void;
    addUserMenuLink?(): void;
    addUserPreferencesLink?(): void;
    showEnhancedPanel?(): Promise<void>;
}

/** ApiClient calls used by the panel; responses are unknown until decoded. */
export interface PanelAjax { type: 'GET' | 'POST' | 'DELETE'; url: string; dataType?: 'json'; data?: string; contentType?: string }
export interface PanelApiClient {
    getCurrentUserId(): string | null | undefined;
    getUrl(path: string, query?: Record<string, string | number | boolean>): string;
    ajax(request: PanelAjax): Promise<unknown>;
    serverId?: string | (() => string);
    getItem(userId: string, itemId: string): Promise<unknown>;
    getSessions(query: { ControllableByUserId: string }): Promise<unknown>;
    getCurrentUser?(): unknown;
    accessToken?(): string;
}

/** The panel bridge and ApiClient reads, shared with the panels media-tags and hidden-content own (review D3). */
export { apiClient, currentUserKey, optionalApiClient, panelHost } from '../shared/panel-host';

/** settings-panel's own slot (frontend.md §2.3): the `JE.internals.enhancedUi` registry (internals-owners.json). */
export type SettingsPanelOwn = Pick<Internals, 'enhancedUi'>;
/**
 * Other features' facades the panel shell reads: hidden-content's `hiddenContent` and media-tags' pipeline and
 * (re)initialisers. Their owners' public-api.ts files export no facade types yet, so the structural types above
 * (only the members read here) type them. Step C4 added spoiler-guard's `spoilerBlur` (its settings tab) and chrome's
 * `canonicalCombo` (how the key listener compares bindings), typed the same way.
 */
export type SettingsPanelPeers = Required<Pick<PanelBridge, 'hiddenContent' | 'tagPipeline'
    | 'initializeQualityTags' | 'initializeGenreTags' | 'initializeLanguageTags' | 'initializeRatingTags' | 'initializeAgeRatingTags'
    | 'initializeLogoTags' | 'initializeStatusTags' | 'initializeAwardsTags' | 'initializeCustomTags' | 'initializePeopleTags' | 'initializeTagStyles'
    | 'reinitializeQualityTags' | 'reinitializeRatingTags' | 'reinitializeStatusTags' | 'reinitializeLogoTags' | 'reinitializeTagLayout'>>
    & { spoilerBlur: SpoilerGuardSettings; canonicalCombo(value: string): string };
export type SettingsPanelContext<Core extends Pick<PanelBridge, 'internals'> = PanelBridge> = FeatureContext<SettingsPanelOwn, SettingsPanelPeers, Core>;
/** The context a panel module gets (step C3): `core` is the bridge `panelHost()` returned. */
export function settingsPanelContext<Core extends Pick<PanelBridge, 'internals'>>(JE: Core): SettingsPanelContext<Core> {
    return featureContext<SettingsPanelOwn, SettingsPanelPeers, Core>('settings-panel', JE, {
        internalSlots: ['enhancedUi'],
        internalsObject: () => JE.internals = JE.internals || {},
    });
}

/** The shared panel registry (`JE.internals.enhancedUi`), created on first use like the legacy modules. */
export function registry(JE: Pick<PanelBridge, 'internals'>): EnhancedUi {
    JE.internals = JE.internals || {};
    return JE.internals.enhancedUi = JE.internals.enhancedUi || {};
}

/** The settings-document validator published by the contracts entry (js/contracts/bootstrap.js). */
export interface SettingsDocumentContract {
    /** Throws unless the value is a generated RevisionedSettingsResponse for this caller authority. */
    parseSettingsDocument(value: unknown, isAdmin: boolean): ValidatedSettingsDocument;
}
/** The part of a validated RevisionedSettingsResponse the panel reads. */
export interface ValidatedSettingsDocument { Revision: string; Settings: object }
interface ContractHost { __JE_BOOTSTRAP_CONTRACT__?: { parseSettingsDocument?: unknown } }
/** The loaded validator, or undefined when the contracts entry has not run. */
export function settingsDocumentContract(): SettingsDocumentContract | undefined {
    const host: Window & ContractHost = window;
    const contract = host.__JE_BOOTSTRAP_CONTRACT__;
    const parse = contract?.parseSettingsDocument;
    if (!contract || typeof parse !== 'function') return undefined;
    return {
        parseSettingsDocument(value: unknown, isAdmin: boolean) {
            const result: unknown = Reflect.apply(parse, contract, [value, isAdmin]);
            if (!isRevisioned(result)) throw new TypeError('Settings validator returned an unexpected value');
            return result;
        }
    };
}
/** Exactly the fields the panel reads from the validator's result. */
function isRevisioned(value: unknown): value is ValidatedSettingsDocument {
    if (value === null || typeof value !== 'object') return false;
    const settings: unknown = Reflect.get(value, 'Settings');
    return typeof Reflect.get(value, 'Revision') === 'string' && settings !== null && typeof settings === 'object';
}
