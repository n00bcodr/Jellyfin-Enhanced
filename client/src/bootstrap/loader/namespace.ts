import { client, installNamespace, liveNamespace, type LoaderNamespace } from '../../host/bootstrap-pages-host';
import { toCamelCase, toPascalCase } from './keys';
import { getScriptVersion } from './script-tag';
import { createTranslator } from './translate';

/** Default per-user documents before and after any identity reset. */
export const emptyUserConfig = () => ({
    settings: {}, shortcuts: { Shortcuts: [] }, bookmark: { bookmarks: {} }, elsewhere: {}, hiddenContent: { items: {}, settings: {} }
});

/**
 * Create the global namespace immediately, with placeholders later scripts
 * replace. Component scripts reference JE.cdn at eval time, so it lives here.
 */
export function createNamespace(): LoaderNamespace {
    return installNamespace({
        // Populated by js/core/*.js (navigation, lifecycle, dom, api, ui).
        core: {},
        pluginConfig: {},
        userConfig: { settings: {}, shortcuts: { Shortcuts: [] }, bookmarks: { Bookmarks: {} }, elsewhere: {}, hiddenContent: { items: {}, settings: {} } },
        translations: {},
        pluginVersion: 'unknown',
        // Every third-party static asset is served from the plugin's own route
        // (/JellyfinEnhanced/cdn/{source}/{path}), so the client never contacts an external CDN.
        cdn: {
            url(source, path) {
                const clean = String(path == null ? '' : path).replace(/^\/+/, '');
                return client().getUrl(`/JellyfinEnhanced/cdn/${source}/${clean}`);
            },
            selfhst(file) { return this.url('selfhst', file); },
            flagPng(code, size = 'w20') { return this.url('flagcdn', `${size}/${String(code).toLowerCase()}.png`); },
            flagSvg(code) { return this.url('flag-icons', `flags/4x3/${String(code).toLowerCase()}.svg`); },
            // Bundled and served immutable, so the plugin version keys the cache.
            font(name) { return client().getUrl(`/JellyfinEnhanced/fonts/${name}?v=${getScriptVersion()}`); }
        },
        // Until icons.js loads, keep the token so t() can keep its placeholder.
        icon: name => name ? `{{ICON_PENDING:${name}}}` : '',
        IconName: {},
        state: {
            activeShortcuts: {},
            // { itemId, surface, ts } captured on a menu trigger so the action-sheet
            // observer knows which Remove button (if any) to add.
            removeContext: null,
            pauseScreenClickTimer: null
        },
        // Unified cache manager for tag systems.
        _cacheManager: {
            callbacks: new Set(),
            dirty: false,
            scheduleId: null,
            register(saveCallback) { this.callbacks.add(saveCallback); },
            unregister(saveCallback) { this.callbacks.delete(saveCallback); },
            markDirty() {
                this.dirty = true;
                if (!this.scheduleId) {
                    this.scheduleId = typeof requestIdleCallback !== 'undefined'
                        ? requestIdleCallback(() => this._flush(), { timeout: 5000 })
                        : setTimeout(() => this._flush(), 1000);
                }
            },
            _flush() {
                if (this.dirty) {
                    this.callbacks.forEach(callback => {
                        try { callback(); } catch (error) { console.error('Cache save error:', error); }
                    });
                    this.dirty = false;
                }
                this.scheduleId = null;
            },
            forceSave() {
                this.dirty = true;
                this._flush();
            }
        },
        // Bootstrap copy only; replaced by JE.core.ui.escapeHtml when js/core/ui-kit.js loads.
        escapeHtml: value => {
            if (typeof value !== 'string') return String(value ?? '');
            return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
        },
        t: createTranslator(liveNamespace),
        loadSettings: () => { console.warn('🪼 Jellyfin Enhanced: loadSettings called before config.js loaded'); return {}; },
        initializeShortcuts: () => { console.warn('🪼 Jellyfin Enhanced: initializeShortcuts called before config.js loaded'); },
        saveUserSettings: async fileName => { console.warn(`🪼 Jellyfin Enhanced: saveUserSettings(${fileName}) called before config.js loaded`); },
        toPascalCase,
        toCamelCase,
        takePrefetched: () => undefined
    });
}
