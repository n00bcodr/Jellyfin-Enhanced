import type { BootstrapResponse } from '../../contracts/generated';
import { client, type JsonRecord, type LoaderClient, type LoaderNamespace } from '../../host/bootstrap-pages-host';
import { sessionUnchanged, type BootstrapClient } from './bootstrap-client';
import type { IdentityScope } from './identity';
import { requireObject } from './identity';
import { isRecord } from './keys';
import { emptyUserConfig } from './namespace';
import { buildUserConfigFromBootstrap, fetchUserScopedConfig } from './user-config';

/** Per-caller public config fields; item looks are projected to what that user can see. */
const USER_SCOPED_PUBLIC_KEYS = ['TagLookItemOverrides'];
const CUSTOM_TAB_FLAGS = ['BookmarksUseCustomTabs', 'CalendarUseCustomTabs', 'HiddenContentUseCustomTabs',
    'DownloadsUseCustomTabs', 'RecommendationsUseCustomTabs', 'ActivityFeedUseCustomTabs', 'CatchUpUseCustomTabs'];
const PLUGIN_PAGE_FLAGS = ['BookmarksUsePluginPages', 'HiddenContentUsePluginPages', 'DownloadsUsePluginPages', 'CalendarUsePluginPages'];
const NOT_RUNNING = ['Disabled', 'NotSupported', 'Malfunctioned'];

/** Owns which config keys are admin-only, so an identity reset can strip exactly those. */
export function createConfigLoader(JE: LoaderNamespace, contracts: BootstrapClient, identity: IdentityScope) {
    // Admin-gated, so an admin's private config (arr URLs etc.) must never survive
    // into a non-admin's session.
    let privateConfigKeys: string[] = [];

    function stripPrivateConfig(): void {
        for (const key of privateConfigKeys) delete JE.pluginConfig[key];
        privateConfigKeys = [];
    }
    /** Replace whatever private keys were merged before; null leaves none behind. */
    function applyPrivateConfig(privateConfig: object | null | undefined): void {
        stripPrivateConfig();
        const value = requireObject(privateConfig) ?? {};
        privateConfigKeys = Object.keys(value);
        Object.assign(JE.pluginConfig, value);
    }
    function applyUserPublicConfig(publicConfig: object | null): void {
        const value: JsonRecord | null = requireObject(publicConfig);
        for (const key of USER_SCOPED_PUBLIC_KEYS) JE.pluginConfig[key] = value ? (value[key] ?? null) : null;
    }
    /** Wipe every per-user global the moment an identity ends. */
    function resetUserScopedGlobals(): void {
        JE.userConfig = emptyUserConfig();
        JE.currentSettings = {};
        // Cleared rather than merged over, so A's extra shortcuts don't survive into B's session.
        JE.state.activeShortcuts = {};
        stripPrivateConfig();
        applyUserPublicConfig(null); // Item looks were projected for the previous user's access.
        contracts.clearPrefetched();
    }

    async function loadUserPublicConfig(api: LoaderClient, isCurrent: () => boolean): Promise<void> {
        try {
            const config = await api.ajax({ type: 'GET', url: api.getUrl(`/JellyfinEnhanced/public-config?_=${Date.now()}`), dataType: 'json' });
            if (isCurrent()) applyUserPublicConfig(requireObject(config));
        } catch (error) {
            // Left cleared: the user's per-item looks wait for the next load.
            console.warn('🪼 Jellyfin Enhanced: Could not reload the per-user public configuration.', error);
        }
    }

    /**
     * Settings persist after uninstall, which would otherwise leave sidebar
     * injection skipped when the delivery plugin is gone.
     */
    function applyDeliveryPluginFlags(hasCustomTabs: boolean, hasPluginPages: boolean): void {
        JE.hasCustomTabs = hasCustomTabs;
        if (!hasCustomTabs) for (const flag of CUSTOM_TAB_FLAGS) JE.pluginConfig[flag] = false;
        if (!hasPluginPages) for (const flag of PLUGIN_PAGE_FLAGS) JE.pluginConfig[flag] = false;
    }

    /** Fallback for a failed bootstrap: derive the delivery flags from /Plugins. */
    async function loadDeliveryPluginFlags(): Promise<void> {
        try {
            const api = client();
            const installed = await api.ajax({ type: 'GET', url: api.getUrl('/Plugins'), dataType: 'json' });
            if (!Array.isArray(installed)) throw new Error('Unexpected /Plugins response');
            // Approximates "running right now" (the bootstrap checks that directly). "Disabled"
            // appears only once a restart unloads the plugin; until then it shows "Restart" and
            // keeps serving, as does one deleted or superseded but not yet restarted.
            const running = (name: string) => installed.some(plugin => isRecord(plugin) && plugin.Name === name
                && !NOT_RUNNING.includes(String(plugin.Status)));
            applyDeliveryPluginFlags(running('Custom Tabs'), running('Plugin Pages'));
        } catch (error) {
            console.warn('🪼 Jellyfin Enhanced: Could not verify installed plugins:', error);
        }
    }

    /**
     * Fallback private config. A response resolving after a switch was authorized as
     * the PREVIOUS user; merging it would leak admin config into the next session.
     */
    async function loadPrivateConfig(): Promise<void> {
        const api = client();
        const started = identity.key(api);
        const requestEpoch = JE.session?.getEpoch() ?? 0;
        try {
            const privateConfig = await api.ajax({ type: 'GET', url: api.getUrl('/JellyfinEnhanced/private-config'), dataType: 'json' });
            if (!sessionUnchanged(api, identity, started) || (JE.session && !JE.session.isCurrent(requestEpoch))) return;
            privateConfigKeys = Object.keys(requireObject(privateConfig) ?? {});
            Object.assign(JE.pluginConfig, privateConfig);
        } catch (error) {
            console.warn('🪼 Jellyfin Enhanced: Could not load private configuration. Some features may be limited.', error);
        }
    }

    function applyBootstrapUserScope(bootstrap: BootstrapResponse): void {
        JE.userConfig = buildUserConfigFromBootstrap(bootstrap.UserSettings);
        applyUserPublicConfig(bootstrap.PublicConfig);
        applyPrivateConfig(bootstrap.PrivateConfig);
    }

    /**
     * Load the signed-in user's scoped data, by one bootstrap request when possible,
     * else per endpoint. `isCurrent` is consulted before every write, so a result
     * arriving after another switch is dropped. True when the globals were updated.
     */
    async function reloadUserScopedData(userId: string, callerIsCurrent: () => boolean): Promise<boolean> {
        const api = client();
        const started = identity.key(api);
        const isCurrent = () => callerIsCurrent() && sessionUnchanged(api, identity, started);
        const bootstrap = await contracts.fetchBootstrap(userId).catch((error: unknown) => {
            console.warn('🪼 Jellyfin Enhanced: Bootstrap request failed, reloading user data per endpoint.', error);
            return null;
        });
        if (!isCurrent()) return false;
        if (bootstrap) {
            applyBootstrapUserScope(bootstrap);
            return true;
        }
        const [userConfig] = await Promise.all([fetchUserScopedConfig(userId, contracts, identity), loadUserPublicConfig(api, isCurrent)]);
        if (!isCurrent() || !userConfig) return false;
        JE.userConfig = userConfig;
        await loadPrivateConfig(); // Internally identity- and epoch-guarded.
        return isCurrent();
    }

    return { applyPrivateConfig, applyDeliveryPluginFlags, loadDeliveryPluginFlags, loadPrivateConfig, reloadUserScopedData, resetUserScopedGlobals };
}
export type ConfigLoader = ReturnType<typeof createConfigLoader>;
