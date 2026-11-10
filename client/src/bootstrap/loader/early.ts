import { client, optionalClient, type LoaderNamespace } from '../../host/bootstrap-pages-host';
import type { BootstrapClient } from './bootstrap-client';
import { hasServerIdMismatch } from './boot';
import { currentUserId, type IdentityScope } from './identity';
import { isRecord } from './keys';
import { injectMaintenanceBanner } from './maintenance';
import { appendScript } from './script-loader';
import { getScriptVersion } from './script-tag';

const HOST_POLL_MS = 50;

/** Load the splash screen as soon as the host client exists. */
export function loadSplashScreenEarly(JE: LoaderNamespace): void {
    const api = optionalClient();
    if (!api) { setTimeout(() => loadSplashScreenEarly(JE), HOST_POLL_MS); return; }
    appendScript(api.getUrl(`/JellyfinEnhanced/js/others/splashscreen.js?v=${getScriptVersion()}`), undefined,
        () => { if (typeof JE.initializeSplashScreen === 'function') JE.initializeSplashScreen(); },
        () => console.error('🪼 Jellyfin Enhanced: Failed to load splash screen script.'));
}

/**
 * Load the login image (checking config first) and show the maintenance banner
 * when active. A signed-in load shares the bootstrap initialize() needs anyway;
 * pre-login there is no token, so the anonymous endpoint is used.
 */
export function loadLoginImageEarly(contracts: BootstrapClient, identity: IdentityScope): void {
    const api = optionalClient();
    if (!api) { setTimeout(() => loadLoginImageEarly(contracts, identity), HOST_POLL_MS); return; }
    const fetchPublicConfig = () => api.ajax({ type: 'GET', url: api.getUrl('/JellyfinEnhanced/public-config'), dataType: 'json' });
    const userId = currentUserId(api);
    const earlyIdentity = identity.key(api);
    const configPromise: Promise<unknown> = userId && !hasServerIdMismatch()
        ? contracts.getBootstrap(userId).then(bootstrap => bootstrap.PublicConfig).catch(() => fetchPublicConfig())
        : fetchPublicConfig();
    configPromise.then(config => {
        if (earlyIdentity !== identity.key(client()) || !isRecord(config)) return;
        if (config.MaintenanceModeEnabled === true) {
            const message = config.MaintenanceModeMessage;
            const endsAt = config.MaintenanceModeEndsAt;
            injectMaintenanceBanner(typeof message === 'string' ? message : '', typeof endsAt === 'string' && endsAt ? endsAt : null);
        }
        // Only load the login image if enabled (default false).
        if (config.EnableLoginImage === true) {
            appendScript(client().getUrl(`/JellyfinEnhanced/js/extras/login-image.js?v=${getScriptVersion()}`), undefined, undefined,
                () => console.error('🪼 Jellyfin Enhanced: Failed to load login image script.'));
        }
    }).catch(() => {
        console.warn('🪼 Jellyfin Enhanced: Could not fetch config for login image, skipping.');
    });
}
