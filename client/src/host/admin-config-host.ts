import type { AdminConfig, JsonObject } from '../admin/config/domain/config';
import type { AdminEngine, DashboardSource } from '../admin/config/engine/api';
import type { WriteOrigin, WriteScope } from '../admin/config/domain/write-scope';

/** Query values ApiClient.getUrl serializes into the address. */
export type UrlQuery = Readonly<Record<string, string | number | boolean | undefined>>;

/** One ApiClient.ajax request; responses stay unknown until a reader validates them. */
export interface AdminAjaxRequest {
    type: 'GET' | 'POST' | 'PUT' | 'DELETE';
    url: string;
    dataType?: 'json' | 'text';
    contentType?: string;
    data?: string | FormData;
    headers?: Readonly<Record<string, string>>;
}

export interface AdminFetchRequest {
    type?: string;
    url: string;
    dataType?: string;
    headers?: Readonly<Record<string, string>>;
}

/** The members of Jellyfin's ApiClient the administrator page calls. */
export interface AdminApiClient {
    getUrl(path: string, query?: UrlQuery): string;
    ajax(request: AdminAjaxRequest): Promise<unknown>;
    fetch(request: AdminFetchRequest): Promise<unknown>;
    getJSON(url: string): Promise<unknown>;
    getUsers(): Promise<unknown>;
    accessToken(): string;
    getCurrentUserId?(): string | null | undefined;
    serverId?(): string | null | undefined;
    serverAddress?(): string | null | undefined;
    serverVersion?(): string;
    getPluginConfiguration(pluginId: string): Promise<AdminConfig>;
    updatePluginConfiguration(pluginId: string, config: AdminConfig): Promise<unknown>;
}

export type { AlertInput as AlertOptions } from '../admin/config/engine/dialogs';

/** Where the startup script publishes the engine load it began for the current view. */
export interface AdminStartup {
    /** Resolves with the engine, or rejects when it could not be loaded. */
    engine: Promise<AdminEngine>;
    /** The page view this load belongs to. */
    pageShown: boolean;
    /** Starts the load again after a failure. */
    retry(): Promise<AdminEngine>;
}

/** Everything the administrator scripts read from the browser's global scope. */
interface AdminGlobals {
    ApiClient?: AdminApiClient;
    Dashboard?: DashboardSource;
    JEAdmin?: AdminEngine;
    JEAdminStartup?: AdminStartup;
    KefinTweaksConfig?: unknown;
    JellyfinEnhanced?: MediaTagsHostSurface;
    jeCdnUrl?: (subpath: string) => string;
    jeCssVersion?: string | null;
    testCustomPluginLinks?: readonly CustomPluginLink[];
}

export interface CustomPluginLink { name: string; icon: string }

/** JE.adminTags as the page uses it: the tab's own module owns everything else. */
export interface MediaTagsContext { openTab(section: string, options: { group: string | null; focus: boolean }): void }
/** A Media Tags section as its module declares it (drawn or not): what the settings search reads. */
export interface AdminTagsSectionSurface {
    readonly tab: string;
    readonly title?: string;
    readonly hint?: string;
    readonly group?: { readonly id: string };
    readonly fields?: ReadonlyArray<{ readonly id: string; readonly label?: string; readonly desc?: string; readonly descParams?: Readonly<Record<string, unknown>> }>;
}
export interface AdminTagsSurface {
    mountTab?(tab: HTMLElement, version: string): Promise<MediaTagsContext | null>;
    /** Runs work in the tab's save queue; the scope it hands over expires on a session change or on completion. */
    holdSaves?<T>(work: (scope: WriteScope) => Promise<T>): Promise<T>;
    /** The tab as it is drawn now, or null. */
    current?(): MediaTagsContext | null;
    readonly sections?: readonly AdminTagsSectionSurface[];
    /** The tab's text formatter (its English text with parameters filled in). */
    fmt?(text: string, params?: Readonly<Record<string, unknown>>): string;
}
export interface MediaTagsHostSurface {
    t?: unknown;
    core?: { tagLayout?: unknown };
    /** media-tags' facade (features/media-tags/public-api.ts `MediaTagsSettingsUiFacade`, step C4), typed structurally here. */
    mediaTagsSettingsUi?: { readonly registry?: unknown };
    adminTags?: AdminTagsSurface;
    customPlugins?: { refresh?(): void };
}

declare global {
    interface Window {
        /** The settings engine. Spelled out where it is published: the server tests read the served script as text. */
        JEAdmin?: AdminEngine;
    }
}

function globals(): Window & AdminGlobals {
    return window;
}

export function apiClient(): AdminApiClient {
    const client = globals().ApiClient;
    if (!client) throw new Error('Jellyfin ApiClient is not available');
    return client;
}

/** One identity field, or null when this client cannot say. */
function originField(read: () => string | null | undefined): string | null {
    try {
        return read() ?? null;
    } catch {
        return null;
    }
}

/** Who requests sent now would run as. Read from the live global, so a replaced client counts too. */
export function clientOrigin(): WriteOrigin {
    const client = globals().ApiClient;
    return {
        client: client ?? null,
        serverAddress: originField(() => client?.serverAddress?.()),
        serverId: originField(() => client?.serverId?.()),
        userId: originField(() => client?.getCurrentUserId?.()),
        token: originField(() => client?.accessToken?.()),
    };
}

export function hostDashboard(): DashboardSource {
    return globals().Dashboard ?? {};
}

export function engine(): AdminEngine | undefined {
    return globals().JEAdmin;
}

export function publishEngine(value: AdminEngine): void {
    window.JEAdmin = value;
}

export function requireEngine(): AdminEngine {
    const value = engine();
    if (!value) throw new Error('The Jellyfin Enhanced settings engine has not loaded');
    return value;
}

export function startup(): AdminStartup | undefined {
    return globals().JEAdminStartup;
}

export function publishStartup(value: AdminStartup): void {
    globals().JEAdminStartup = value;
}

export function pluginVersion(): string | null {
    return document.querySelector('script[plugin="Jellyfin Enhanced"]')?.getAttribute('version') ?? null;
}

export function assetVersion(): string | null {
    return globals().jeCssVersion ?? null;
}

export function publishAssetVersion(version: string | null): void {
    globals().jeCssVersion = version;
}

export function publishCdnRoute(route: (subpath: string) => string): void {
    globals().jeCdnUrl = route;
}

export function cdnUrl(subpath: string): string {
    const route = globals().jeCdnUrl;
    return route ? route(subpath) : apiClient().getUrl('/JellyfinEnhanced/cdn/' + subpath);
}

export function kefinTweaksConfig(): unknown {
    return globals().KefinTweaksConfig;
}

export function mediaTagsSurface(): MediaTagsHostSurface | undefined {
    return globals().JellyfinEnhanced;
}

export function publishTestedPluginLinks(links: readonly CustomPluginLink[]): void {
    globals().testCustomPluginLinks = links;
}

export type { AdminConfig, JsonObject };
