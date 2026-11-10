import { client, optionalClient, type LoaderNamespace, type Translations, type UserConfigView } from '../../host/bootstrap-pages-host';
import { createBootstrapClient, type BootstrapClient } from './bootstrap-client';
import { loadComponentScripts } from './component-loader';
import { createConfigLoader, type ConfigLoader } from './config-loader';
import { initializeFeatures } from './features';
import { createIdentityScope, currentUserId, type IdentityScope } from './identity';
import { isRecord } from './keys';
import { appendScript } from './script-loader';
import { getScriptVersion, scriptTagVersion } from './script-tag';
import { loadTranslations, registerSessionIntegration } from './session-integration';
import { buildUserConfigFromBootstrap, fetchUserScopedConfig, seedDisplayLanguage } from './user-config';

const INIT_POLL_INTERVAL_MS = 50;
const MAX_MISMATCH_RETRIES = 600; // ~30s at 50ms intervals.

/** Whether the stored credentials belong to another server (stale from a previous one). */
export function hasServerIdMismatch(): boolean {
    try {
        const api = optionalClient();
        if (!api) return false;
        const credentials = localStorage.getItem('jellyfin_credentials');
        if (!credentials) return false;
        const parsed: unknown = JSON.parse(credentials);
        const servers = isRecord(parsed) ? parsed.Servers : null;
        if (!Array.isArray(servers) || servers.length === 0) return false;
        const currentServerId = api._serverInfo?.Id || (typeof api.serverId === 'function' ? api.serverId() : api.serverId);
        if (!currentServerId) return false;
        return !servers.some(server => isRecord(server) && (server.Id === currentServerId || server.ServerId === currentServerId));
    } catch {
        return false;
    }
}

/** Load the translation module, which exposes JE.loadTranslations. */
async function loadTranslationsModule(JE: LoaderNamespace): Promise<void> {
    if (typeof JE.loadTranslations === 'function') return;
    await new Promise<void>(resolve => {
        appendScript(client().getUrl(`/JellyfinEnhanced/js/enhanced/translations.js?v=${getScriptVersion()}`), undefined, resolve, error => {
            console.error('🪼 Jellyfin Enhanced: Failed to load translations module', error);
            resolve();
        });
    });
}

/** Fallback config and version; each failure degrades to its documented default. */
function loadPluginData(): Promise<[unknown, unknown]> {
    const api = client();
    const configPromise = api.ajax({ type: 'GET', url: api.getUrl('/JellyfinEnhanced/public-config'), dataType: 'json' }).catch((error: unknown) => {
        console.error('🪼 Jellyfin Enhanced: Failed to fetch public config', error);
        return {};
    });
    const versionPromise = api.ajax({ type: 'GET', url: api.getUrl('/JellyfinEnhanced/version'), dataType: 'text' }).catch((error: unknown) => {
        console.error('🪼 Jellyfin Enhanced: Failed to fetch version', error);
        return 'unknown';
    });
    return Promise.all([configPromise, versionPromise]);
}

/** Injects the Druidblack metadata icons sheet and flattens JE's own link buttons to match. */
function injectMetadataIcons(JE: LoaderNamespace, enabled: boolean): void {
    const existing = document.getElementById('metadataIconsCss');
    if (enabled && !existing) {
        const link = document.createElement('link');
        link.id = 'metadataIconsCss';
        link.rel = 'stylesheet';
        link.href = JE.cdn.url('icon-metadata', 'public-icon.css');
        document.head.appendChild(link);
    } else if (!enabled && existing) {
        existing.remove();
    }
    // The icon sheet flattens native link buttons by href; ours aren't matched, so flatten
    // them too or they keep the theme's pill. Arr status border stays.
    const flatStyle = document.getElementById('metadataIconsFlatCss');
    if (enabled && !flatStyle) {
        const style = document.createElement('style');
        style.id = 'metadataIconsFlatCss';
        style.textContent = `
                .itemExternalLinks > a.letterboxd-link-icon,
                .itemExternalLinks > a.seerr-link,
                .itemExternalLinks > a.arr-link,
                .itemExternalLinks > a.arr-tag-link {
                    background: none !important;
                    padding: 0 !important;
                    border-radius: 0 !important;
                }
                .itemExternalLinks > a.letterboxd-link-icon::before {
                    margin-right: 0 !important;
                }
            `;
        document.head.appendChild(style);
    } else if (!enabled && flatStyle) {
        flatStyle.remove();
    }
}

/**
 * Only entries cached BEFORE the server's clear are stale. Entries written after it,
 * such as the locale a fresh browser profile fetched moments ago, are already current.
 */
async function applyTranslationCacheClear(JE: LoaderNamespace): Promise<void> {
    const serverClear = Number(JE.pluginConfig.ClearTranslationCacheTimestamp) || 0;
    const localClear = parseInt(localStorage.getItem('JE_translation_clear_ts') || '0', 10);
    if (serverClear <= localClear) return;
    console.log(`🪼 Jellyfin Enhanced: Server-triggered translation cache clear (${new Date(serverClear).toISOString()})`);
    let removedAny = false;
    for (let index = localStorage.length - 1; index >= 0; index--) {
        const key = localStorage.key(index);
        if (!key || !key.startsWith('JE_translation_')) continue;
        const timestampKey = key.startsWith('JE_translation_ts_') ? key : `JE_translation_ts_${key.slice('JE_translation_'.length)}`;
        if (parseInt(localStorage.getItem(timestampKey) || '0', 10) > serverClear) continue;
        localStorage.removeItem(key);
        removedAny = true;
    }
    localStorage.setItem('JE_translation_clear_ts', serverClear.toString());
    if (removedAny) JE.translations = await loadTranslations(JE) || {};
}

export interface BootDependencies {
    JE: LoaderNamespace; identity: IdentityScope; contracts: BootstrapClient; config: ConfigLoader;
}
export function createBootDependencies(JE: LoaderNamespace): BootDependencies {
    const identity = createIdentityScope(document);
    const contracts = createBootstrapClient(JE, identity);
    return { JE, identity, contracts, config: createConfigLoader(JE, contracts, identity) };
}

/**
 * A switch during the early stages happens before the session module exists, so it was
 * adopted silently with no reset: everything fetched belongs to the previous session.
 * Reload for whoever is signed in now; with nobody signed in, keep nothing of theirs.
 */
async function recoverSessionChangedDuringBoot(dependencies: BootDependencies): Promise<string | null> {
    const { JE, config } = dependencies;
    const liveUserId = currentUserId(client());
    console.warn('🪼 Jellyfin Enhanced: User changed during boot — reloading user-scoped data.');
    config.resetUserScopedGlobals();
    if (!liveUserId) return null;
    // The session exists now, so another switch during these fetches can't restore this
    // user's data over the next user's reset. That re-bootstrap then owns the repair.
    const recoveryEpoch = JE.session?.getEpoch() ?? 0;
    await config.reloadUserScopedData(liveUserId, () => !JE.session || JE.session.isCurrent(recoveryEpoch));
    return liveUserId;
}

/** Main initialization, retried until the host has a signed-in client. */
export function createInitializer(dependencies: BootDependencies): () => Promise<void> {
    const { JE, identity, contracts, config } = dependencies;
    let mismatchRetryCount = 0;
    const retry = () => { setTimeout(() => { void initialize(); }, INIT_POLL_INTERVAL_MS); };

    async function initialize(): Promise<void> {
        // Stop retrying once credentials are stale, to allow re-authentication.
        if (hasServerIdMismatch()) {
            mismatchRetryCount++;
            if (mismatchRetryCount >= MAX_MISMATCH_RETRIES) {
                console.warn('🪼 Jellyfin Enhanced: Server ID mismatch detected - stopping to allow re-authentication');
                JE.hideSplashScreen?.();
                return;
            }
            retry();
            return;
        }
        const api = optionalClient();
        let userId = api ? currentUserId(api) : null;
        if (!api || !userId) { retry(); return; }
        mismatchRetryCount = 0;

        try {
            // Stage 1+2: one bootstrap request in parallel with the translations module and
            // locale. Per-endpoint fallback when the bootstrap fails, so nothing regresses.
            const bootIdentity = identity.key(api);
            const unchanged = () => bootIdentity === identity.key(client());
            // Lets translations.js skip its /version fetch.
            if (!JE.pluginVersion || JE.pluginVersion === 'unknown') {
                const version = scriptTagVersion();
                if (version) JE.pluginVersion = version;
            }
            const [bootstrap, translations] = await Promise.all([
                contracts.getBootstrap(userId).catch((error: unknown) => {
                    console.warn('🪼 Jellyfin Enhanced: Bootstrap request failed, falling back to individual requests.', error);
                    return null;
                }),
                loadTranslationsModule(JE).then((): Promise<Translations> => loadTranslations(JE))
            ]);
            if (!unchanged()) { retry(); return; }
            if (bootstrap) {
                JE.pluginConfig = { ...bootstrap.PublicConfig };
                JE.pluginVersion = bootstrap.Version || 'unknown';
            } else {
                const [publicConfig, version] = await loadPluginData();
                if (!unchanged()) { retry(); return; }
                JE.pluginConfig = isRecord(publicConfig) ? publicConfig : {};
                JE.pluginVersion = typeof version === 'string' && version ? version : 'unknown';
            }
            JE.translations = translations || {};
            if (bootstrap) config.applyPrivateConfig(bootstrap.PrivateConfig); // Null for non-admins.
            else await config.loadPrivateConfig();

            // Clear stale delivery flags; settings persist after the plugins are uninstalled.
            if (bootstrap) config.applyDeliveryPluginFlags(bootstrap.HasCustomTabs === true, bootstrap.HasPluginPages === true);
            else await config.loadDeliveryPluginFlags();

            await applyTranslationCacheClear(JE);

            try {
                injectMetadataIcons(JE, !!JE.pluginConfig.MetadataIconsEnabled);
            } catch (error) {
                console.warn('🪼 Jellyfin Enhanced: Failed to inject Metadata icons CSS', error);
            }

            // User-specific settings, from the bootstrap, else fetched per file.
            if (!unchanged()) { retry(); return; }
            const loadedUserConfig: UserConfigView | null = bootstrap
                ? buildUserConfigFromBootstrap(bootstrap.UserSettings)
                : await fetchUserScopedConfig(userId, contracts, identity);
            if (!loadedUserConfig || !unchanged()) { retry(); return; }
            JE.userConfig = loadedUserConfig;

            if (typeof JE.initializeSplashScreen === 'function') JE.initializeSplashScreen();

            // Stage 3: every component script. The list lives in js/component-scripts.json.
            // Modules read JE.pluginConfig/JE.userConfig at eval time, so this stays after config.
            await loadComponentScripts(bootstrap ? bootstrap.ComponentScripts : null);
            console.log('🪼 Jellyfin Enhanced: All component scripts loaded.');

            // User-switch detection needs JE.session, so it must follow the component scripts.
            registerSessionIntegration(JE, config);
            if (!unchanged()) userId = await recoverSessionChangedDuringBoot(dependencies);

            // Stage 4: settings and shortcuts, now that config.js has loaded.
            if (typeof JE.loadSettings !== 'function' || typeof JE.initializeShortcuts !== 'function') {
                console.error('🪼 Jellyfin Enhanced: FATAL - config.js functions not defined after script loading.');
                JE.hideSplashScreen?.();
                return;
            }
            JE.currentSettings = JE.loadSettings();
            JE.initializeShortcuts();
            if (userId) seedDisplayLanguage(JE, userId);

            // Stage 5: the theme system comes first.
            if (typeof JE.themer?.init === 'function') {
                JE.themer.init();
                console.log('🪼 Jellyfin Enhanced: Theme system initialized.');
            }
            window.addEventListener('beforeunload', () => { JE._cacheManager.forceSave(); });

            initializeFeatures(JE);
            console.log('🪼 Jellyfin Enhanced: All components initialized successfully.');

            // Every component script has executed and every enabled initializer has run.
            // Automation waits on this instead of racing individual JE.* properties.
            JE.initialized = true;
            JE.hideSplashScreen?.();
        } catch (error) {
            console.error('🪼 Jellyfin Enhanced: CRITICAL INITIALIZATION FAILURE:', error);
            JE.hideSplashScreen?.();
        }
    }
    return initialize;
}
