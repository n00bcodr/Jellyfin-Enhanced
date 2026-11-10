import { tagRulesHost, captureTagSession, lookApiClient } from '../rules-host';
import { createTagLook } from './tag-look';
const bridge = tagRulesHost();
bridge.core ??= {};
bridge.core.tagLook = createTagLook({
    settings: () => bridge.currentSettings || {},
    config: () => bridge.pluginConfig || {},
    normalizeOfficialRating: text => bridge.normalizeOfficialRating?.(text) || text,
    represent: () => { bridge.core?.tagLayout?.invalidateSettings?.(); bridge.reinitializeTagLayout?.(); },
    captureSession: () => captureTagSession(bridge),
    get saveUserSettings() { return bridge.saveUserSettings?.bind(bridge); },
    api: {
        get: () => lookApiClient().getPluginConfiguration('f69e946a-4b3c-4e9a-8f0a-8d7c1b2c4d9b'),
        patch: (changes, expected) => {
            const client = lookApiClient();
            return client.ajax({ type: 'POST', url: client.getUrl('/JellyfinEnhanced/admin/configuration'),
                data: JSON.stringify({ Changes: changes, Expected: expected }), contentType: 'application/json', dataType: 'json' });
        },
    },
});
