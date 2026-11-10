import type { JsonValue } from '../../contracts/generated';
import { featureContext, type FeatureContext, type SaveOptions, type SettingsDocument } from '../../host/context';
// Declared in host/context.ts (the core settings service's types, frontend.md §2.3); re-exported for this feature.
export type { SaveOptions, SettingsDocument };
interface Shortcut { Name: string; Key: string }
export interface SettingsBridge {
    CONFIG: { readonly TOAST_DURATION: JsonValue; readonly HELP_PANEL_AUTOCLOSE_DELAY: JsonValue };
    state: { activeShortcuts: Record<string, string>; removeContext: unknown; pauseScreenClickTimer: number | null };
    pluginConfig?: SettingsDocument & { Shortcuts?: Shortcut[] };
    userConfig?: { settings?: SettingsDocument; settingsRevision?: string | null; shortcuts?: { Shortcuts?: Shortcut[] }; bookmark?: SettingsDocument; elsewhere?: SettingsDocument; hiddenContent?: SettingsDocument };
    currentSettings?: SettingsDocument;
    core?: { mediaLanguage?: { priorityList(value: unknown): string[] | null } };
    ratingSources?: { normalizeSources(value: unknown): string[] | null; settings(user: SettingsDocument, plugin?: SettingsDocument): { minimum: number; color: boolean } };
    toast?(message: string): void;
    toPascalCase?(value: SettingsDocument): SettingsDocument;
    inheritedSettingKeys: readonly string[];
    isSettingInherited(settings: SettingsDocument, key: string): boolean;
    setSettingInherited(settings: SettingsDocument, key: string, inherit: boolean): boolean;
    inheritedSettingDefault(settings: SettingsDocument, key: string): JsonValue | undefined;
    loadSettings(): SettingsDocument;
    getSettingsSaveState?(): { version: number; pending: number };
    saveUserSettings(file: string, settings: SettingsDocument, options?: SaveOptions): Promise<void>;
    keyCombo(event: KeyboardEvent): string;
    normalizeShortcutKey(key: string): string;
    initializeShortcuts(): void;
}
export interface SettingsClient {
    getCurrentUserId(): string;
    getUrl(path: string): string;
    accessToken?(): string;
    serverId?: string | (() => string);
    ajax(request: { type: string; url: string; data?: string; contentType?: string; dataType?: string }): Promise<unknown>;
}
/** settings converts no own slot: the settings service it installs (loadSettings, saveUserSettings, …) is the injected core bridge. */
export type SettingsOwn = Record<never, never>;
/** Other features' facades settings reads, read at call time (media-tags' status tags may load later or not at all). */
export interface SettingsPeers { getStatusDateContext(): { locale: string; timeZone: string } }
export type SettingsContext = FeatureContext<SettingsOwn, SettingsPeers, SettingsBridge>;
export function settingsHost(): { JE: SettingsBridge; ctx: SettingsContext; apiClient(): SettingsClient | undefined } {
    const host: Window & { JellyfinEnhanced?: SettingsBridge; ApiClient?: SettingsClient } = window;
    const JE = host.JellyfinEnhanced;
    if (!JE) throw new Error('Settings require Jellyfin Enhanced');
    const ctx: SettingsContext = featureContext<SettingsOwn, SettingsPeers, SettingsBridge>('settings', JE, {});
    return { JE, ctx, apiClient: () => host.ApiClient };
}
