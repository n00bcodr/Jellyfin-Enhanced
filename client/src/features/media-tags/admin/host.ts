/**
 * @file The host surface the Media Tags admin tab (js/enhanced/admintags/*)
 * reads: the members of the JE facade other modules publish (narrowed with
 * Pick to what the tab calls), Jellyfin's ApiClient and Dashboard, and the
 * configuration page's CDN route. Everything is read when it is used, as the
 * legacy scripts read their globals, so a module loaded later still counts.
 */
import type { SaveOptions, SettingsDocument } from '../../../host/context';
import type { TagLayout } from '../layout/tag-layout';
import type { TagLook } from '../layout/tag-look';
import type { TagScopes, TagSettingsMatrix } from '../pipeline/scopes';
import type { TagStyles } from '../layout/tag-styles';
import type { RatingSources } from '../types/ratings/rating-sources';
import type { PosterColours } from '../layout/poster-colours';
import type { ItemEditorOptions } from '../editor/tag-item-editor';
import type { EnhancedUi } from '../../settings-panel/public-api';
import type { AdminTagsApi, AdminTagsFacade } from './types';
// The settings registry read (step C4), for the page and its sections.
export { settingsUi } from '../host';

/** The layout controller members the tab reads (core/tag-layout.js). */
export type AdminTagLayout = Pick<TagLayout,
    | 'GROUPS' | 'DEFAULT_ORDER' | 'LAYOUT_SLOTS' | 'MAX_CAP' | 'DEFAULT_CAPS' | 'DEFAULT_PROFILES' | 'RECOMMENDED_SHAPES'
    | 'POSITION_SETTINGS' | 'POSITION_TO_SLOT' | 'SLOT_TO_POSITION' | 'normalizeGroup' | 'normalizeSettings' | 'singleChipGroup'
    | 'readShapeOverrides' | 'TAG_KINDS' | 'KIND_LOOK_LIMITS' | 'readKindLooks' | 'kindLooksToWire'>;
/** The look rules members the tab reads (core/tag-look.js). */
export type AdminTagLook = Pick<TagLook,
    'MAX_CONDITIONS' | 'newRuleId' | 'normalizeItemOverrides' | 'itemOverridesToWire' | 'itemOverrideMutation' | 'itemOverridesWith' | 'restoreItemOverrides'>;

export interface AdminTagsCoreSurface {
    tagLayout?: AdminTagLayout;
    tagLook?: AdminTagLook;
    tagScopes?: Pick<TagScopes, 'SCOPE_IDS' | 'SCOPED_GROUPS' | 'scopeDefault'>;
    tagSettingsMatrix?: Pick<TagSettingsMatrix, 'offers'>;
    ui: { injectCss(id: string, css: string): unknown; removeCss(id: string): unknown };
    mediaLanguage?: { uiLocale?(): string | null | undefined };
}

/** Who signs in next, as JE.session reports a change. */
export interface SessionChangeView { serverId?: string | null; userId?: string | null }

/** The JE facade members the tab reads, and the facade it provides. */
export interface AdminTagsBridge {
    adminTags?: AdminTagsFacade;
    escapeHtml(value: unknown): string;
    core: AdminTagsCoreSurface;
    internals?: { enhancedUi?: Pick<EnhancedUi, 'createTagPreview' | 'tagGroupEditorData' | 'tagPortable'> };
    tagStyles?: Pick<TagStyles, 'SCOPE_ATTR' | 'buildCss'>;
    ratingSources?: Pick<RatingSources, 'name' | 'chip'>;
    tagPosterColours?: Pick<PosterColours, 'normalise'>;
    tagItemEditor?: { open(itemId: string, options: ItemEditorOptions): unknown };
    session?: { onUserChange?(name: string, callback: (change: SessionChangeView | null | undefined) => void): unknown };
    saveUserSettings?(file: string, settings: SettingsDocument, options?: SaveOptions): Promise<void>;
    currentSettings?: SettingsDocument;
}

/** An ApiClient request the tab sends; answers are unknown until decoded. */
export interface AdminAjax { type: 'GET' | 'POST'; url: string; dataType?: 'json'; data?: string; contentType?: string }
export type QueryValue = string | number | boolean | null | undefined;
/** The ApiClient members the tab calls. */
export interface AdminApiClient {
    getUrl(path: string, query?: Readonly<Record<string, QueryValue>>): string;
    ajax(request: AdminAjax): Promise<unknown>;
    getJSON(url: string): Promise<unknown>;
    getPluginConfiguration(pluginId: string): Promise<unknown>;
    getCurrentUserId?(): string | null | undefined;
    accessToken?(): string | null | undefined;
    serverId?: string | null | (() => string | null | undefined);
    _serverInfo?: { Id?: string | null } | null;
}
/** The dashboard's dialogs and loading indicator. */
export interface AdminDashboard {
    confirm?(html: string, title: string, callback: (ok: boolean) => void): void;
    showLoadingMsg?(): void;
    hideLoadingMsg?(): void;
}

interface AdminHostWindow {
    JellyfinEnhanced?: AdminTagsBridge;
    ApiClient?: AdminApiClient;
    Dashboard?: AdminDashboard;
    jeCdnUrl?: (path: string) => string;
}
const host = (): Window & AdminHostWindow => window;

/** The JE facade, as the legacy `(function(JE) {…})(window.JellyfinEnhanced)` captured it. */
export function adminBridge(): AdminTagsBridge {
    const JE = host().JellyfinEnhanced;
    if (!JE) throw new TypeError('Jellyfin Enhanced must load before the Media Tags admin tab');
    return JE;
}

/**
 * The installed facade once admin-tags.js ran (a section module loaded without it does nothing).
 * admin-tags.ts installs every core member at once, so its registry marks the whole core.
 * @param JE
 * @returns {AdminTagsApi|null}
 */
export function adminTagsApi(JE: AdminTagsBridge): AdminTagsApi | null {
    const facade = JE.adminTags;
    return facade && isCore(facade) ? facade : null;
}
function isCore(facade: AdminTagsFacade): facade is AdminTagsApi {
    return typeof facade.registerSection === 'function' && typeof facade.fmt === 'function' && Array.isArray(facade.sections);
}

/** Jellyfin's client, read at call time like the legacy bare `ApiClient` global. */
export function apiClient(): AdminApiClient {
    const client = host().ApiClient;
    if (!client) throw new ReferenceError('ApiClient is not defined');
    return client;
}
/** The client when present (legacy `typeof ApiClient !== 'undefined'` checks). */
export function optionalApiClient(): AdminApiClient | undefined {
    return host().ApiClient;
}
/** The signed-in user's id as the legacy code wrote it into URLs. */
export function currentUserId(client: AdminApiClient): string {
    return String(client.getCurrentUserId?.());
}
/** The dashboard, when present. */
export function dashboard(): AdminDashboard | undefined {
    return host().Dashboard;
}
/** The configuration page's local CDN route (flags, service logos). */
export function cdnUrl(path: string): string {
    const route = host().jeCdnUrl;
    if (typeof route !== 'function') throw new ReferenceError('jeCdnUrl is not defined');
    return route(path);
}
