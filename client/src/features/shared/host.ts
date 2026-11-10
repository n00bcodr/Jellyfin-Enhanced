import type { Navigation } from '../../core/navigation';
import type { Lifecycle } from '../../core/lifecycle';
import type { Dom } from '../../core/dom/runtime';
import type { Session } from '../../core/session';
import type { createHelpers } from './helpers';
import type { createIcons } from './icons';
export interface SharedCore {
 navigation: Navigation; dom: Dom; lifecycle: Lifecycle;
 ui: { injectCss(id: string, css: string): unknown; removeCss(id: string): unknown; escapeHtml(value: unknown): string };
}
export interface SharedClient {
 getCurrentUserId(): string;
 getCurrentUser?(): unknown | Promise<unknown>;
 serverId?: string | (() => string);
 accessToken?(): string;
 getUrl(path: string): string;
 getItem(user: string, id: string): Promise<unknown>;
 ajax(request: {type: string; url: string; data: string; contentType: string}): Promise<unknown>;
}
export interface HelpersBridge {
 core: SharedCore; session?: Session;
 currentSettings?: {isAdmin?: boolean};
 pluginConfig?: {AnalyticsEnabled?: boolean; AnalyticsShareUsageCounts?: boolean};
 headerActions?: {getTray(): Element | null};
 helpers?: ReturnType<typeof createHelpers>;
}
export interface IconsBridge {
 pluginConfig?: {UseIcons?: boolean; useIcons?: boolean; IconStyle?: string; iconStyle?: string};
 core: Pick<SharedCore, 'ui'>;
 icon?: ReturnType<typeof createIcons>['icon'];
 IconName?: ReturnType<typeof createIcons>['IconName'];
 icons?: ReturnType<typeof createIcons>['icons'];
}
export interface Theme {name: string; uniqueIdentifier: string | null; variables: Record<string, string | null>}
export interface Themer {
 supportedThemes: Record<string, Theme>;
 activeTheme: (Theme & {key: string}) | null;
 detectActiveTheme(): Theme & {key: string};
 getThemeVariable(key: string): string;
 getThemeVariables(): Record<string,string>;
 registerTheme(key: string, theme: Theme): void;
 init(): void;
}
export interface ThemeBridge {cdn: {url(source: string, path: string): string}; themer?: Themer}
export interface TranslationsBridge {
 cdn: ThemeBridge['cdn']; session?: Session;
 pluginVersion?: string;
 translationsLang?: string;
 translationsFromEnglish?: Set<string> | null;
 loadTranslations?: () => Promise<Record<string,string>>;
}
export function bridge<T>(): T {
 // Each entry supplies its own finite facade contract; no aggregate global bag.
 const host: Window & {JellyfinEnhanced?: object} = window;
 if (!host.JellyfinEnhanced) throw new Error('Jellyfin Enhanced must initialize first');
 return host.JellyfinEnhanced as T;
}
export function client(): SharedClient {
 const host: Window & {ApiClient?: SharedClient} = window;
 if (!host.ApiClient) throw new Error('Jellyfin ApiClient unavailable');
 return host.ApiClient;
}
