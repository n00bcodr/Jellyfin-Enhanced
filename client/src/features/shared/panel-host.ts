/**
 * The settings panels' reads of the browser global (review D3): the panel bridge and Jellyfin's ApiClient. One copy
 * for the settings-panel shell and the panels media-tags and hidden-content own (those panels also load without the
 * shell, in unit and browser tests), re-exported by each one's host. Stateless: each function reads `window` when it
 * is called and keeps nothing. The co-owned registry `JE.internals.enhancedUi` is not here: only a host file of an
 * owning feature may touch it (feature-boundaries rule 3), so each owner keeps its `registry()`.
 */
import type { PanelApiClient, PanelBridge } from '../settings-panel/public-api';

interface BrowserHost { JellyfinEnhanced?: PanelBridge; ApiClient?: PanelApiClient }

/** The facade captured when a module loads (legacy `(function(JE){})(window.JellyfinEnhanced)`). */
export function panelHost(): PanelBridge {
    const host: Window & BrowserHost = window;
    if (!host.JellyfinEnhanced) throw new TypeError('Jellyfin Enhanced must load before the settings panel');
    return host.JellyfinEnhanced;
}

/** Jellyfin's client, read at call time like the legacy bare `ApiClient` global. */
export function apiClient(): PanelApiClient {
    const client = optionalApiClient();
    if (!client) throw new ReferenceError('ApiClient is not defined');
    return client;
}

/** The client when present (legacy `typeof ApiClient !== 'undefined'` checks). */
export function optionalApiClient(): PanelApiClient | undefined {
    const host: Window & BrowserHost = window;
    return host.ApiClient;
}

/** The identity used by legacy per-user browser keys. */
export function currentUserKey(): string {
    return optionalApiClient()?.getCurrentUserId?.() || '';
}
