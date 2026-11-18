// /js/plugin.js
(function() {
    'use strict';

    // Create the global namespace immediately with placeholders
    window.JellyfinEnhanced = {
        // Shared core layer, populated by js/core/*.js (navigation, lifecycle,
        // dom, api, ui). Created here so core modules can attach to it.
        core: {},
        pluginConfig: {},
        userConfig: { settings: {}, shortcuts: { Shortcuts: [] }, bookmarks: { Bookmarks: {} }, elsewhere: {}, hiddenContent: { items: {}, settings: {} } },
        translations: {},
        pluginVersion: 'unknown',
        // Local CDN helper. Every third-party static asset (icons, fonts, flags, theme
        // sheets, remote locales) is served from the plugin's own route
        // (/JellyfinEnhanced/cdn/{source}/{path}) — backed by an on-disk cache refreshed
        // every 24h — so the client never contacts an external CDN directly.
        // Defined here (not in a loaded module) because component scripts load in parallel
        // and reference these URLs at eval time, so JE.cdn must exist before they run.
        cdn: {
            // Build a local CDN route URL for an allow-listed {source} + sub-{path}.
            url(source, path) {
                const clean = String(path == null ? '' : path).replace(/^\/+/, '');
                return ApiClient.getUrl(`/JellyfinEnhanced/cdn/${source}/${clean}`);
            },
            // selfhst icon pack, e.g. selfhst('svg/sonarr.svg') or selfhst('png/youtube.png')
            selfhst(file) { return this.url('selfhst', file); },
            // Country flag as a raster PNG (flagcdn), size like 'w20'
            flagPng(code, size = 'w20') { return this.url('flagcdn', `${size}/${String(code).toLowerCase()}.png`); },
            // Country flag as an SVG (cdnjs flag-icons, 4x3)
            flagSvg(code) { return this.url('flag-icons', `flags/4x3/${String(code).toLowerCase()}.svg`); },
            // Material Symbols glyph font, bundled with the plugin (not Google Fonts).
            // Served immutable, so the plugin version keys the cache: the -subset files
            // (scripts/material-symbols/subset.py) change with releases.
            font(name) { return ApiClient.getUrl(`/JellyfinEnhanced/fonts/${name}?v=${getScriptVersion()}`); }
        },
        // Stub functions that will be overwritten by modules
        icon: (name) => {
            // Fallback icon function until icons.js loads
            // Returns the token unchanged so t() can keep the placeholder
            return name ? `{{ICON_PENDING:${name}}}` : '';
        },
        IconName: {}, // Will be replaced by icons.js
        state: {
            activeShortcuts: {},
            // { itemId, surface: 'continuewatching'|'nextup'|null, ts } captured on a menu trigger
            // so the action-sheet observer knows which Remove button (if any) to add.
            removeContext: null,
            pauseScreenClickTimer: null
         },
        // Unified cache manager for tag systems
        _cacheManager: {
            callbacks: new Set(),
            dirty: false,
            scheduleId: null,
            register(saveCallback) {
                this.callbacks.add(saveCallback);
            },
            unregister(saveCallback) {
                this.callbacks.delete(saveCallback);
            },
            markDirty() {
                this.dirty = true;
                if (!this.scheduleId) {
                    // Use requestIdleCallback to defer cache saves
                    if (typeof requestIdleCallback !== 'undefined') {
                        this.scheduleId = requestIdleCallback(() => this._flush(), { timeout: 5000 });
                    } else {
                        this.scheduleId = setTimeout(() => this._flush(), 1000);
                    }
                }
            },
            _flush() {
                if (this.dirty) {
                    this.callbacks.forEach(cb => {
                        try { cb(); } catch (e) { console.error('Cache save error:', e); }
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
        /**
         * Escapes HTML special characters to prevent XSS when interpolating into HTML strings.
         * Bootstrap copy only — replaced by the canonical JE.core.ui.escapeHtml
         * as soon as js/core/ui-kit.js loads.
         * @param {string} str - The value to escape.
         * @returns {string} The escaped string safe for HTML interpolation.
         */
        escapeHtml: (str) => {
            if (typeof str !== 'string') return String(str ?? '');
            return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
        },
        // Placeholder functions
        t: (key, params = {}) => { // Actual implementation defined later
            const translations = window.JellyfinEnhanced?.translations || {};
            let text = translations[key] || key;
            // Plural forms: `${key}_one`, `_few`… by the CLDR category (Intl.PluralRules, English rules for a language it does not know) of the count
            // (`count`, else `days`, else the other counted params) in the language the string is written in,
            // falling back to `${key}_other`, then the key. A form English filled in for a locale is used only
            // where the key itself is English (or the locale is a kind of English), so a translated sentence
            // never turns English for one count.
            const counted = params && ['count', 'days', 'n', 'items', 'hours', 'minutes', 'seconds'].find((name) => typeof params[name] === 'number' && Number.isFinite(params[name]));
            if (counted && translations[key]) {
                const english = window.JellyfinEnhanced?.translationsFromEnglish;
                const ownLang = window.JellyfinEnhanced?.translationsLang || 'en';
                const keyIsEnglish = !!english?.has(key);
                const lang = keyIsEnglish ? 'en' : ownLang;
                const sameSource = (variant) => variant in translations
                    && (!english || keyIsEnglish === english.has(variant) || /^en\b/i.test(ownLang));
                let category = 'other';
                try { category = new Intl.PluralRules([lang, 'en']).select(params[counted]); } catch { /* malformed tag: other */ }
                const variant = [`${key}_${category}`, `${key}_other`].find(sameSource);
                if (variant) text = translations[variant];
            }
            if (params) {
                for (const [param, value] of Object.entries(params)) {
                    // A function, so a value is inserted as written ("$&" or "$$" in a title are not replacement patterns).
                    text = text.replace(new RegExp(`{${param}}`, 'g'), () => String(value));
                }
            }
            // Replace {{icon:name}} tokens with JE.icon() calls
            text = text.replace(/\{\{icon:([a-zA-Z]+)\}\}/g, (match, iconName) => {
                const iconKey = iconName.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
                const iconConstant = window.JellyfinEnhanced.IconName?.[iconKey];

                // If IconName not loaded yet, keep the placeholder
                if (!iconConstant) {
                    console.debug(`[JE.t] IconName.${iconKey} not available yet, keeping placeholder`);
                    return match;
                }

                const iconResult = window.JellyfinEnhanced.icon?.(iconConstant);

                // If icon function returns a pending token, keep original placeholder
                if (iconResult && iconResult.startsWith('{{ICON_PENDING:')) {
                    console.debug(`[JE.t] Icon system not ready, keeping placeholder for ${iconName}`);
                    return match;
                }

                return iconResult || match;
            });

            return text;
        },
        loadSettings: () => { console.warn("🪼 Jellyfin Enhanced: loadSettings called before config.js loaded"); return {}; },
        initializeShortcuts: () => { console.warn("🪼 Jellyfin Enhanced: initializeShortcuts called before config.js loaded"); },
        saveUserSettings: async (fileName) => { console.warn(`🪼 Jellyfin Enhanced: saveUserSettings(${fileName}) called before config.js loaded`); }
    };

    const JE = window.JellyfinEnhanced; // Alias for internal use

    /**
     * Converts PascalCase object keys to camelCase recursively.
     * @param {object} obj - The object to convert.
     * @returns {object} - A new object with camelCase keys.
     */
    function toCamelCase(obj) {
        if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
            return obj; // Return primitives and arrays as-is
        }
        const camelCased = {};
        for (const key in obj) {
            if (obj.hasOwnProperty(key)) {
                const camelKey = key.charAt(0).toLowerCase() + key.slice(1);
                camelCased[camelKey] = toCamelCase(obj[key]); // Recursive for nested objects
            }
        }
        return camelCased;
    }
    JE.toPascalCase = toPascalCase;
    JE.toCamelCase = toCamelCase;
    /**
     * Converts object keys from camelCase to PascalCase (recursively).
     * @param {object} obj - The object to convert.
     * @returns {object} - A new object with PascalCase keys.
     */
    function toPascalCase(obj) {
        if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
            return obj; // Return primitives and arrays as-is
        }
        const pascalCased = {};
        for (const key in obj) {
            if (obj.hasOwnProperty(key)) {
                const pascalKey = key.charAt(0).toUpperCase() + key.slice(1);
                pascalCased[pascalKey] = toPascalCase(obj[key]); // Recursive for nested objects
            }
        }
        return pascalCased;
    }

    /**
     * Injects Druidblack metadata icons CSS.
     * @param {boolean} enabled
     */
    function injectMetadataIcons(enabled) {
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

        // The icon sheet flattens native link buttons by href; ours aren't matched,
        // so flatten them too or they keep the theme's pill. Arr status border stays.
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
     * Returns the plugin version for use as a cache-busting query parameter.
     * Reads synchronously from the injected script tag's version attribute so it
     * is available before the async version fetch resolves. Falls back to
     * JE.pluginVersion when already set (post-init calls), and to Date.now() if
     * neither source is available.
     * @returns {string}
     */
    function getScriptVersion() {
        const scriptEl = document.querySelector('script[plugin="Jellyfin Enhanced"]');
        if (scriptEl?.getAttribute('dev') === 'true') return Date.now();
        // Always prefer the script tag's version attribute, it holds the full
        // cacheKey (version + DLL timestamp) baked in at server startup.
        // JE.pluginVersion is just the bare version number from the API and
        // does not include the timestamp component.
        return scriptEl?.getAttribute('version') || JE.pluginVersion || Date.now();
    }

    /**
     * Whether the server injected the script tag in dev mode (DevMode config).
     * In dev mode the component scripts are loaded as individual files so they
     * stay debuggable one by one; production loads the server-side bundle.
     * @returns {boolean}
     */
    function isDevMode() {
        const scriptEl = document.querySelector('script[plugin="Jellyfin Enhanced"]');
        return scriptEl?.getAttribute('dev') === 'true';
    }

    /**
     * Seeds JE.pluginVersion from the injected script tag before anything is
     * fetched. The tag's version attribute is the server's cache key,
     * `{version}-{dllTimestamp}` (or the bare version when the timestamp is
     * unavailable), and the version part is exactly what /version returns —
     * so translations.js can key its cache without its own /version request.
     * The bootstrap response re-applies the authoritative value afterwards.
     */
    function seedPluginVersionFromScriptTag() {
        if (JE.pluginVersion && JE.pluginVersion !== 'unknown') return;
        const scriptEl = document.querySelector('script[plugin="Jellyfin Enhanced"]');
        const cacheKey = scriptEl?.getAttribute('version') || '';
        const version = cacheKey.split('-')[0];
        if (version) JE.pluginVersion = version;
    }

    /**
     * Returns the component bundle URL (cache-keyed like every other script).
     * @returns {string}
     */
    function getComponentBundleUrl() {
        return ApiClient.getUrl(`/JellyfinEnhanced/bundle.js?v=${getScriptVersion()}`);
    }

    /**
     * Loads the translation module and exposes JE.loadTranslations.
     * @returns {Promise<void>}
     */
    async function loadTranslationsModule() {
        if (typeof JE.loadTranslations === 'function') return;
        await new Promise((resolve) => {
            const script = document.createElement('script');
            script.src = ApiClient.getUrl(`/JellyfinEnhanced/js/enhanced/translations.js?v=${getScriptVersion()}`);
            script.onload = () => resolve();
            script.onerror = (e) => {
                console.error('🪼 Jellyfin Enhanced: Failed to load translations module', e);
                resolve();
            };
            document.head.appendChild(script);
        });
    }

    /**
     * Loads the appropriate language file based on the user's settings.
     * Attempts to fetch from GitHub first (with caching), falls back to bundled translations.
     * @returns {Promise<object>} A promise that resolves to the translations object.
     */
    async function loadTranslations() {
        if (typeof JE.loadTranslations === 'function') {
            return JE.loadTranslations();
        }
        console.warn('🪼 Jellyfin Enhanced: Translations module not loaded, falling back to empty translations');
        return {};
    }

     /**
     * Fetches plugin configuration and version from the server.
     * @returns {Promise<[object, string]>} A promise that resolves with config and version.
     */
     function loadPluginData() {
        const configPromise = ApiClient.ajax({
            type: 'GET',
            url: ApiClient.getUrl('/JellyfinEnhanced/public-config'),
            dataType: 'json'
        }).catch((e) => {
            console.error("🪼 Jellyfin Enhanced: Failed to fetch public config", e);
            return {}; // Return empty object on error
        });

        const versionPromise = ApiClient.ajax({
            type: 'GET',
            url: ApiClient.getUrl('/JellyfinEnhanced/version'),
            dataType: 'text'
        }).catch((e) => {
             console.error("🪼 Jellyfin Enhanced: Failed to fetch version", e);
            return 'unknown'; // Return placeholder on error
        });

        return Promise.all([configPromise, versionPromise]);
    }

    /**
     * Fetches the one-request bootstrap payload for the signed-in user:
     * { Version, UserId, PublicConfig, PrivateConfig (admins only, else null),
     *   HasCustomTabs, HasPluginPages, UserSettings: { Settings, Shortcuts,
     *   Bookmark, Elsewhere, HiddenContent }, ComponentScripts, Prefetched }.
     * Each part has exactly the shape of the standalone endpoint it replaces.
     * Rejects on transport failure or an unexpected shape so callers can fall
     * back to the per-endpoint path.
     * @returns {Promise<object>}
     */
    async function fetchBootstrap() {
        const payload = await ApiClient.ajax({
            type: 'GET',
            url: ApiClient.getUrl(`/JellyfinEnhanced/bootstrap?_=${Date.now()}`),
            dataType: 'json'
        });
        if (!payload || typeof payload !== 'object' || !payload.PublicConfig || typeof payload.PublicConfig !== 'object') {
            throw new Error('Unexpected bootstrap response');
        }
        return payload;
    }

    /**
     * Whether a bootstrap payload belongs to the given user. Jellyfin user ids
     * appear both dashed and undashed depending on the source, so compare the
     * hex digits only.
     * @param {object} bootstrap
     * @param {string} userId
     * @returns {boolean}
     */
    function bootstrapMatchesUser(bootstrap, userId) {
        const normalize = (id) => String(id || '').replace(/-/g, '').toLowerCase();
        const payloadUser = normalize(bootstrap?.UserId);
        return !!payloadUser && payloadUser === normalize(userId);
    }

    // Startup answers carried by the page-load bootstrap (its `Prefetched` block:
    // the bodies of spoiler-blur/series, jellyseerr/user-status, jellyseerr/status
    // and active-streams/sessions), handed out once each by JE.takePrefetched.
    // { userId, receivedAt, parts } or null.
    let prefetched = null;
    const PREFETCHED_DEFAULT_MAX_AGE_MS = 10000;

    /**
     * Keeps the bootstrap's `Prefetched` block for the modules that would
     * otherwise request each part themselves right after the bundle loads.
     * @param {object} bootstrap - A bootstrap payload already matched to `userId`.
     * @param {string} userId - The user the payload belongs to.
     */
    function storePrefetched(bootstrap, userId) {
        const parts = bootstrap?.Prefetched;
        prefetched = parts && typeof parts === 'object'
            ? { userId, receivedAt: Date.now(), parts: Object.assign({}, parts) }
            : null;
    }

    /**
     * Hands out one prefetched startup answer, exactly the body its standalone
     * endpoint returns, and forgets it. Returns undefined — the caller then
     * requests the endpoint as before — when the bootstrap did not carry it
     * (feature off, not permitted, or it would have needed an upstream call),
     * it was already taken, it belongs to another user than the signed-in one,
     * or it is older than `maxAgeMs`, so a module that first asks later than
     * the page load still gets a fresh answer.
     * @param {string} name - Part name (SpoilerBlurSeries, SeerrUserStatus,
     *   SeerrStatus, ActiveStreamSessions).
     * @param {number} [maxAgeMs] - Oldest acceptable answer, from receipt of the bootstrap.
     * @returns {any} The endpoint body, or undefined.
     */
    JE.takePrefetched = function(name, maxAgeMs = PREFETCHED_DEFAULT_MAX_AGE_MS) {
        if (!prefetched || !Object.prototype.hasOwnProperty.call(prefetched.parts, name)) return undefined;
        const value = prefetched.parts[name];
        delete prefetched.parts[name];
        const currentUserId = typeof ApiClient !== 'undefined' ? ApiClient.getCurrentUserId?.() : null;
        if (!bootstrapMatchesUser({ UserId: prefetched.userId }, currentUserId)) return undefined;
        if (Date.now() - prefetched.receivedAt > maxAgeMs) return undefined;
        return value == null ? undefined : value;
    };

    // The in-flight/settled bootstrap request and the user it was started for.
    // Shared between the early login-image/maintenance-banner check and
    // initialize() so a page load that is already signed in issues one request.
    let bootstrapPromise = null;
    let bootstrapUserId = null;

    /**
     * Returns the shared bootstrap promise for `userId`, starting the request
     * when none is in flight for that user. A failed request is not retained,
     * so the next caller retries once before falling back.
     * @param {string} userId - The user the request is being made for.
     * @returns {Promise<object>}
     */
    function getBootstrap(userId) {
        if (bootstrapPromise && bootstrapUserId === userId) return bootstrapPromise;
        bootstrapUserId = userId;
        const promise = fetchBootstrap().then((payload) => {
            if (!bootstrapMatchesUser(payload, userId)) throw new Error('Bootstrap response is for a different user');
            storePrefetched(payload, userId);
            return payload;
        }).catch((e) => {
            if (bootstrapPromise === promise) bootstrapPromise = null;
            throw e;
        });
        bootstrapPromise = promise;
        return promise;
    }

    // Keys merged into JE.pluginConfig from /private-config. Tracked so the
    // user-switch reset can strip them again: the endpoint is admin-gated, so
    // an admin's private config (arr instance URLs etc.) must not survive
    // into a non-admin's session.
    let privateConfigKeys = [];

    /**
     * Merges the admin-only private config (from the bootstrap payload) into
     * JE.pluginConfig, replacing whatever private keys were merged before.
     * null/undefined (non-admin callers) leaves no private keys behind.
     * @param {object|null|undefined} privateConfig
     */
    function applyPrivateConfig(privateConfig) {
        for (const key of privateConfigKeys) delete JE.pluginConfig[key];
        const value = privateConfig && typeof privateConfig === 'object' ? privateConfig : {};
        privateConfigKeys = Object.keys(value);
        Object.assign(JE.pluginConfig, value);
    }

    /**
     * Public config fields the server projects per caller (item looks are
     * filtered to the items that user can see). The rest of the public
     * config is the same for every signed-in user.
     */
    const USER_SCOPED_PUBLIC_KEYS = ['TagLookItemOverrides'];

    /**
     * Applies the per-user part of a public config answered for the incoming
     * user (a same-tab switch keeps every user-independent field as it is).
     * @param {object|null|undefined} publicConfig - null clears them.
     */
    function applyUserPublicConfig(publicConfig) {
        for (const key of USER_SCOPED_PUBLIC_KEYS) {
            JE.pluginConfig[key] = publicConfig && typeof publicConfig === 'object' ? (publicConfig[key] ?? null) : null;
        }
    }

    /**
     * Re-fetches the public config for the signed-in user and applies its
     * per-user fields (the per-endpoint fallback of a user switch).
     * @param {() => boolean} isCurrent - Epoch guard; false means the answer is stale.
     * @returns {Promise<void>}
     */
    async function loadUserPublicConfig(isCurrent) {
        try {
            const config = await ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl(`/JellyfinEnhanced/public-config?_=${Date.now()}`),
                dataType: 'json'
            });
            if (isCurrent()) applyUserPublicConfig(config);
        } catch (e) {
            // Left cleared: the user's per-item looks wait for the next load.
            console.warn('🪼 Jellyfin Enhanced: Could not reload the per-user public configuration.', e);
        }
    }

    /**
     * Clears the UseCustomTabs / UsePluginPages config flags when the delivery
     * plugin they depend on is not installed. Settings persist after uninstall,
     * which would otherwise make sidebar injection skip even though the
     * delivery plugin is no longer present.
     * @param {boolean} hasCustomTabs - Whether the "Custom Tabs" plugin is installed.
     * @param {boolean} hasPluginPages - Whether the "Plugin Pages" plugin is installed.
     */
    function applyDeliveryPluginFlags(hasCustomTabs, hasPluginPages) {
        JE.hasCustomTabs = hasCustomTabs;
        if (!hasCustomTabs) {
            JE.pluginConfig.BookmarksUseCustomTabs = false;
            JE.pluginConfig.CalendarUseCustomTabs = false;
            JE.pluginConfig.HiddenContentUseCustomTabs = false;
            JE.pluginConfig.DownloadsUseCustomTabs = false;
            JE.pluginConfig.RecommendationsUseCustomTabs = false;
            JE.pluginConfig.ActivityFeedUseCustomTabs = false;
            JE.pluginConfig.CatchUpUseCustomTabs = false;
            JE.pluginConfig.LeavingSoonPageUseCustomTabs = false;
        }
        if (!hasPluginPages) {
            JE.pluginConfig.BookmarksUsePluginPages = false;
            JE.pluginConfig.HiddenContentUsePluginPages = false;
            JE.pluginConfig.DownloadsUsePluginPages = false;
            JE.pluginConfig.CalendarUsePluginPages = false;
        }
    }

    /**
     * Fallback for a failed bootstrap: checks the installed plugins via
     * GET /Plugins and clears the stale delivery-plugin flags.
     * @returns {Promise<void>}
     */
    async function loadDeliveryPluginFlags() {
        try {
            const installedPlugins = await ApiClient.ajax({
                type: 'GET', url: ApiClient.getUrl('/Plugins'), dataType: 'json'
            });
            if (!Array.isArray(installedPlugins)) throw new Error('Unexpected /Plugins response');
            // Approximates "running right now" (the bootstrap checks that
            // directly). "Disabled" is reported only once a restart has
            // unloaded the plugin; until then it shows "Restart" and keeps
            // serving, as does one deleted or superseded but not yet restarted.
            // "Restart" can also mean enabled but not loaded yet; that window
            // ends with the restart either way.
            const isRunning = p => !['Disabled', 'NotSupported', 'Malfunctioned'].includes(p.Status);
            applyDeliveryPluginFlags(
                installedPlugins.some(p => p.Name === 'Custom Tabs' && isRunning(p)),
                installedPlugins.some(p => p.Name === 'Plugin Pages' && isRunning(p))
            );
        } catch (e) {
            console.warn('🪼 Jellyfin Enhanced: Could not verify installed plugins:', e);
        }
    }

    /**
     * Fetches sensitive configuration from the authenticated endpoint.
     * @returns {Promise<void>}
     */
    async function loadPrivateConfig() {
        // A response resolving after a user switch was authorized as the
        // PREVIOUS user — merging it would leak admin config into the next
        // session and clobber the strip list the reset relies on.
        const requestEpoch = JE.session ? JE.session.getEpoch() : 0;
        try {
            const privateConfig = await ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl('/JellyfinEnhanced/private-config'),
                dataType: 'json'
            });
            if (JE.session && !JE.session.isCurrent(requestEpoch)) return;
            // Merge the sensitive keys into the main config object
            privateConfigKeys = Object.keys(privateConfig && typeof privateConfig === 'object' ? privateConfig : {});
            Object.assign(JE.pluginConfig, privateConfig);
        } catch (error) {
            console.warn('🪼 Jellyfin Enhanced: Could not load private configuration. Some features may be limited.', error);
            // Don't assign anything if it fails
        }
    }


    /**
     * Loads an array of scripts dynamically.
     * @param {string[]} scripts - Array of script filenames.
     * @param {string} basePath - The base URL path for the scripts.
     * @returns {Promise<void>} - A promise that resolves when all scripts attempt to load.
     */
    function loadScripts(scripts, basePath) {
        const promises = scripts.map(scriptName => {
            return new Promise((resolve) => { // Always resolve so one failure doesn't stop others
                const script = document.createElement('script');
                // Dynamically-inserted scripts are async by default (execute in
                // arrival order). async=false keeps parallel download but forces
                // execution in array order, so js/core/* is guaranteed to run
                // before every module that depends on it.
                script.async = false;
                script.src = ApiClient.getUrl(`${basePath}/${scriptName}?v=${getScriptVersion()}`);
                script.onload = () => {
                    resolve({ status: 'fulfilled', script: scriptName });
                };
                script.onerror = (e) => {
                    console.error(`🪼 Jellyfin Enhanced: Failed to load script '${scriptName}'`, e);
                    resolve({ status: 'rejected', script: scriptName, error: e }); // Resolve even on error
                };
                document.head.appendChild(script);
            });
        });
        // Wait for all promises to settle (either fulfilled or rejected)
        return Promise.allSettled(promises);
    }

    const COMPONENT_SCRIPTS_BASE_PATH = '/JellyfinEnhanced/js';

    /**
     * Drops the "//" note entries from the component-script manifest
     * (js/component-scripts.json), leaving the ordered script paths.
     * @param {unknown} manifest - The raw manifest array.
     * @returns {string[]|null} The paths, or null when the input is not a manifest.
     */
    function filterComponentManifest(manifest) {
        if (!Array.isArray(manifest)) return null;
        const scripts = manifest
            .filter(entry => typeof entry === 'string')
            .map(entry => entry.trim())
            .filter(entry => entry && !entry.startsWith('//'));
        return scripts.length ? scripts : null;
    }

    /**
     * Returns the ordered component-script list: the copy carried by the
     * bootstrap payload when available, otherwise the embedded manifest fetched
     * from the server. Only needed for dev mode and the per-file fallback — the
     * bundle itself does not depend on it.
     * @param {unknown} fromBootstrap - `ComponentScripts` from the bootstrap payload, if any.
     * @returns {Promise<string[]>} Empty when neither source is available.
     */
    async function getComponentScriptList(fromBootstrap) {
        const fromPayload = filterComponentManifest(fromBootstrap);
        if (fromPayload) return fromPayload;
        try {
            const manifest = await ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl(`${COMPONENT_SCRIPTS_BASE_PATH}/component-scripts.json?v=${getScriptVersion()}`),
                dataType: 'json'
            });
            const scripts = filterComponentManifest(manifest);
            if (scripts) return scripts;
            throw new Error('Manifest is empty or malformed');
        } catch (e) {
            console.error('🪼 Jellyfin Enhanced: Could not load the component-script manifest', e);
            return [];
        }
    }

    /**
     * Yields to the event loop as a macrotask that queues BEHIND everything
     * already pending (unlike scheduler.yield, whose continuation jumps the
     * queue), so jellyfin-web's own tasks get their turn between module slices.
     * @returns {Promise<void>}
     */
    function yieldToEventLoop() {
        return new Promise((resolve) => {
            if (typeof MessageChannel === 'function') {
                const channel = new MessageChannel();
                channel.port1.onmessage = () => resolve();
                channel.port2.postMessage(null);
            } else {
                setTimeout(resolve, 0);
            }
        });
    }

    /**
     * Waits for the browser's next idle period (requestIdleCallback), so the
     * caller's work runs only once jellyfin-web has nothing pending — its first
     * view renders at full speed and JE's evaluation fills the gaps (on a cold
     * load, the waits for jellyfin-web's own chunks). Capped by `timeoutMs` so a
     * continuously busy page cannot starve the caller. Resolves with the
     * IdleDeadline, or null where requestIdleCallback is unavailable (plain
     * macrotask yield instead).
     * @param {number} timeoutMs - Longest wait before the callback runs anyway.
     * @returns {Promise<IdleDeadline|null>}
     */
    function waitForIdle(timeoutMs) {
        if (typeof requestIdleCallback === 'function') {
            return new Promise((resolve) => requestIdleCallback(resolve, { timeout: timeoutMs }));
        }
        return yieldToEventLoop().then(() => null);
    }

    // Module-runner pacing. Evaluating component modules costs main-thread time;
    // done as one task, or even as slices competing on equal terms, it lands
    // exactly while jellyfin-web renders its first view and delays it by that
    // much. So at boot each slice runs in idle time (BUNDLE_IDLE_TIMEOUT_MS caps
    // the wait) and is kept short (BUNDLE_RUN_BUDGET_MS) so a task that becomes
    // pending mid-slice — a chunk arriving on a cold load — waits only a few
    // milliseconds. A group loaded later, because the user went somewhere or
    // opened something, keeps the short slices but does not wait for idle time:
    // someone is waiting for it.
    const BUNDLE_RUN_BUDGET_MS = 10;
    const BUNDLE_IDLE_TIMEOUT_MS = 100;

    /**
     * Runs module functions in order, in short slices (see the pacing notes
     * above). A module that throws at its top level is logged and rethrown
     * asynchronously (so it still surfaces as an uncaught error, exactly like a
     * throwing <script> did) and the run continues with the next module —
     * nothing after it is lost, and it is not re-run. window.__JE_BUNDLE_PROGRESS
     * counts the modules run since the page loaded.
     * @param {Function[]} modules - One function per module, in manifest order.
     * @param {string[]} names - The modules' paths (for error messages).
     * @param {boolean} idle - Wait for browser idle time between slices (boot) instead of only yielding.
     * @returns {Promise<void>}
     */
    async function runBundleModules(modules, names, idle) {
        const nextSlice = () => (idle ? waitForIdle(BUNDLE_IDLE_TIMEOUT_MS) : yieldToEventLoop().then(() => null));
        let deadline = await nextSlice();
        let sliceStart = performance.now();
        for (let i = 0; i < modules.length; i++) {
            try {
                modules[i]();
            } catch (e) {
                console.error(`🪼 Jellyfin Enhanced: Module '${names[i] || `#${i + 1}`}' threw while loading; continuing with the next module.`, e);
                setTimeout(() => { throw e; }, 0);
            }
            window.__JE_BUNDLE_PROGRESS = Math.max(0, window.__JE_BUNDLE_PROGRESS || 0) + 1;
            if (i + 1 >= modules.length) break;
            // End the slice when its budget is spent or the idle period is over.
            // A callback that ran because the timeout expired reports no idle
            // time at all; it gets the full budget so progress is guaranteed.
            const budgetSpent = performance.now() - sliceStart >= BUNDLE_RUN_BUDGET_MS;
            const idleOver = !!deadline && !deadline.didTimeout && deadline.timeRemaining() < 1;
            if (budgetSpent || idleOver) {
                deadline = await nextSlice();
                sliceStart = performance.now();
            }
        }
    }

    // ---------------------------------------------------------------------
    // Component groups.
    //
    // js/component-groups.json assigns the manifest's modules to named groups;
    // every module it does not list belongs to the implicit "core" group. The
    // server serves any set of groups as one script (bundle.js?g=a,b). Only the
    // groups a page needs are downloaded and run: "core" always, the others when
    // their feature is enabled and their route, surface or trigger appears (see
    // FEATURE_GROUPS below). A group's modules run in manifest order, after the
    // groups it names in "after", and its stage-6 initializers run right after
    // them. Dev mode, and any group whose bundle request fails, loads that
    // group's files one by one instead — the same files in the same order.
    // ---------------------------------------------------------------------
    const CORE_GROUP = 'core';
    const GROUP_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;

    /**
     * The resolved groups for this page load, set once by setComponentGroups:
     * `order` is the run order ("core" first), `byId` maps a group id to
     * { id, after: string[], scripts: string[] }, and `whole` is true when no
     * usable groups file was available and "core" is the entire manifest.
     * @type {{ order: string[], byId: Object<string, { id: string, after: string[], scripts: string[] }>, whole: boolean }|null}
     */
    let componentGroups = null;
    // Group id -> 'loading' | 'ready'. A group that is absent has not been asked for.
    const groupStates = Object.create(null);
    // Batches run strictly one after another, in the order they were asked for.
    let groupQueue = Promise.resolve();

    /**
     * Resolves the "groups" array of js/component-groups.json against the
     * manifest, exactly as Services/ClientScriptBundle.cs does: ids must be
     * unique and well formed, every listed module must be in the manifest and
     * in one group only, and "after" may only name earlier groups (so the file
     * order is a valid run order). Returns null for anything else.
     * @param {string[]} scripts - The manifest paths, in order.
     * @param {unknown} rawGroups - The file's "groups" array.
     * @returns {{ order: string[], byId: object, whole: boolean }|null}
     */
    function resolveComponentGroups(scripts, rawGroups) {
        if (!Array.isArray(rawGroups)) return null;
        const position = new Map(scripts.map((path, index) => [path, index]));
        const owner = new Map();
        const order = [CORE_GROUP];
        const byId = Object.create(null);
        byId[CORE_GROUP] = { id: CORE_GROUP, after: [], scripts: [] };
        for (const entry of rawGroups) {
            const id = entry && typeof entry.id === 'string' ? entry.id : '';
            if (!GROUP_ID_PATTERN.test(id) || byId[id]) return null;
            const after = [];
            if (entry.after !== undefined) {
                if (!Array.isArray(entry.after)) return null;
                for (const name of entry.after) {
                    if (typeof name !== 'string' || name === id || !byId[name]) return null;
                    if (name !== CORE_GROUP && !after.includes(name)) after.push(name);
                }
            }
            if (!Array.isArray(entry.modules) || entry.modules.length === 0) return null;
            const own = [];
            for (const module of entry.modules) {
                const path = typeof module === 'string' ? module.trim() : '';
                if (!position.has(path) || owner.has(path)) return null;
                owner.set(path, id);
                own.push(path);
            }
            own.sort((x, y) => position.get(x) - position.get(y));
            byId[id] = { id, after, scripts: own };
            order.push(id);
        }
        byId[CORE_GROUP].scripts = scripts.filter(path => !owner.has(path));
        return { order, byId, whole: false };
    }

    /**
     * Sets the page's component groups from the bootstrap payload when it
     * carries them, otherwise from the embedded files. Without a usable groups
     * file every module is "core" and the whole manifest loads as one bundle,
     * as it did before groups existed.
     * @param {object|null} bootstrap - The bootstrap payload, if any.
     * @returns {Promise<void>}
     */
    async function setComponentGroups(bootstrap) {
        const scripts = await getComponentScriptList(bootstrap ? bootstrap.ComponentScripts : null);
        let rawGroups = bootstrap ? bootstrap.ComponentGroups : null;
        if (!Array.isArray(rawGroups) && !bootstrap) {
            try {
                const file = await ApiClient.ajax({
                    type: 'GET',
                    url: ApiClient.getUrl(`${COMPONENT_SCRIPTS_BASE_PATH}/component-groups.json?v=${getScriptVersion()}`),
                    dataType: 'json'
                });
                rawGroups = file && file.groups;
            } catch (e) {
                console.warn('🪼 Jellyfin Enhanced: Could not load the component-group file — loading every component script.', e);
            }
        }
        const resolved = scripts.length ? resolveComponentGroups(scripts, rawGroups) : null;
        if (!resolved && Array.isArray(rawGroups)) {
            console.warn('🪼 Jellyfin Enhanced: The component-group file is not usable — loading every component script.');
        }
        const whole = Object.create(null);
        whole[CORE_GROUP] = { id: CORE_GROUP, after: [], scripts };
        componentGroups = resolved || { order: [CORE_GROUP], byId: whole, whole: true };
    }

    /**
     * The given groups plus "core", everything they are (transitively) "after"
     * and the groups their rules load along with them, in run order. Unknown
     * ids are dropped.
     * @param {string[]} ids
     * @returns {string[]}
     */
    function withRequiredGroups(ids) {
        const wanted = new Set([CORE_GROUP]);
        const add = (id) => {
            const group = componentGroups.byId[id];
            if (!group || wanted.has(id)) return;
            wanted.add(id);
            group.after.forEach(add);
            companionGroups(id).forEach(add);
        };
        ids.forEach(add);
        return componentGroups.order.filter(id => wanted.has(id));
    }

    /**
     * Requests one script holding the given groups and resolves with what it
     * defined: { [id]: { total, modules } }, or null when the request failed
     * (and in dev mode, which never requests bundles).
     * @param {string[]} ids - Group ids, in run order.
     * @param {boolean} idle - Boot: wait for idle time first and fetch at low priority.
     * @returns {Promise<Object<string, { total: number, modules: Function[] }>|null>}
     */
    async function requestGroupBundle(ids, idle) {
        if (isDevMode()) return null;
        // Fetch and parse the boot bundle only once jellyfin-web is idle, and at
        // low fetch priority. Measured alternatives: an early <link rel="preload">
        // (even at low priority) made jellyfin-web's first content ~200-300 ms
        // later on a cold 20 Mbps load because the download shares bandwidth
        // with its own chunks, and inserting the script right away put its
        // pre-parse in front of the first view's rendering.
        if (idle) await waitForIdle(BUNDLE_IDLE_TIMEOUT_MS);
        const whole = componentGroups.whole;
        const url = whole
            ? getComponentBundleUrl()
            : ApiClient.getUrl(`/JellyfinEnhanced/bundle.js?g=${ids.join(',')}&v=${getScriptVersion()}`);
        if (whole) window.__JE_BUNDLE_MODULES = undefined;
        const requestOk = await new Promise((resolve) => {
            const script = document.createElement('script');
            script.src = url;
            if (idle) script.setAttribute('fetchpriority', 'low');
            script.onload = () => resolve(true);
            script.onerror = () => resolve(false);
            document.head.appendChild(script);
        });
        const bundles = Object.create(null);
        if (whole) {
            bundles[CORE_GROUP] = { total: window.__JE_BUNDLE_TOTAL, modules: window.__JE_BUNDLE_MODULES };
            delete window.__JE_BUNDLE_MODULES; // the functions are only needed once
        } else {
            const defined = window.__JE_BUNDLES || {};
            for (const id of ids) {
                bundles[id] = defined[id];
                delete defined[id];
            }
        }
        return requestOk ? bundles : null;
    }

    /**
     * Whether a bundle defined exactly the modules a group lists.
     * @param {{ scripts: string[] }} group
     * @param {{ total: number, modules: Function[] }|undefined} bundle
     * @returns {boolean}
     */
    function isCompleteBundle(group, bundle) {
        return !!bundle && Array.isArray(bundle.modules) && bundle.modules.length > 0
            && bundle.modules.length === bundle.total
            && (componentGroups.whole || bundle.total === group.scripts.length);
    }

    /**
     * Runs one batch of groups, in order: each group's modules from the bundle
     * when the request defined them, otherwise its files one by one (dev mode,
     * a failed request, or a bundle that defined nothing because of a syntax
     * error — then only the broken file fails, as before bundles existed).
     * @param {string[]} ids - Group ids, in run order, all marked 'loading'.
     * @param {Promise<object|null>} pending - The batch's requestGroupBundle result.
     * @param {boolean} idle - Run in idle-time slices (boot).
     * @returns {Promise<void>}
     */
    async function runGroupBatch(ids, pending, idle) {
        const bundles = await pending;
        const complete = (id) => !!bundles && isCompleteBundle(componentGroups.byId[id], bundles[id]);
        if (!isDevMode() && !ids.every(complete)) {
            console.warn(bundles
                ? '🪼 Jellyfin Enhanced: Component bundle did not define its modules (syntax error?) — loading the component scripts individually.'
                : '🪼 Jellyfin Enhanced: Component bundle request failed — loading the component scripts individually.');
        }
        // Consecutive groups that load file by file go in as one ordered set of
        // script tags, so their downloads overlap as they always have.
        let files = [];
        let fileGroups = [];
        const flushFiles = async () => {
            if (!fileGroups.length) return;
            const loading = fileGroups;
            const results = await loadScripts(files, COMPONENT_SCRIPTS_BASE_PATH);
            files = [];
            fileGroups = [];
            // Nothing arrived at all (offline?): leave these groups unasked-for so
            // the next trigger tries again, instead of staying missing until reload.
            const anyLoaded = results.some(result => result.value && result.value.status === 'fulfilled');
            for (const id of loading) {
                if (anyLoaded || id === CORE_GROUP) groupStates[id] = 'ready';
                else delete groupStates[id];
            }
        };
        for (const id of ids) {
            const group = componentGroups.byId[id];
            if (complete(id)) {
                await flushFiles();
                await runBundleModules(bundles[id].modules, group.scripts, idle);
                groupStates[id] = 'ready';
            } else {
                files = files.concat(group.scripts);
                fileGroups.push(id);
            }
            if (id === CORE_GROUP && !componentGroups.whole) {
                // Before any other group's modules run, so the tabs keep one order.
                await flushFiles();
                if (groupStates[CORE_GROUP] === 'ready') registerPageTabs();
            }
        }
        await flushFiles();
    }

    /**
     * Makes sure the given groups (and everything they must load after) have
     * run, loading whichever have not been asked for yet as one request. The
     * returned promise resolves once they, and every batch asked for before
     * them, have run; it never rejects. Groups run in the order they were asked
     * for, so a dependency asked for earlier always runs first.
     * @param {string[]} ids - Group ids.
     * @param {{ idle?: boolean, initialize?: boolean }} [options] - `idle`:
     *   boot pacing. `initialize: false`: the caller runs the groups'
     *   stage-6 initializers itself (boot).
     * @returns {Promise<void>}
     */
    function ensureGroups(ids, options = {}) {
        if (!componentGroups) return Promise.resolve();
        const missing = withRequiredGroups(ids).filter(id => !groupStates[id]);
        if (missing.length) {
            for (const id of missing) groupStates[id] = 'loading';
            const pending = requestGroupBundle(missing, !!options.idle).catch(() => null);
            groupQueue = groupQueue
                .then(() => runGroupBatch(missing, pending, !!options.idle))
                .then(() => {
                    if (options.initialize === false) return;
                    initializeGroupFeatures(missing.filter(id => groupStates[id] === 'ready'));
                    nudgeObservers();
                })
                .catch((e) => {
                    console.error('🪼 Jellyfin Enhanced: Failed to load component groups', missing, e);
                    for (const id of missing) if (groupStates[id] === 'loading') groupStates[id] = 'ready';
                });
        }
        return groupQueue;
    }

    /**
     * The route the address shows, as the group rules read it: `path` is the
     * router path in lower case without a leading slash or ".html"
     * ("home", "details", "video", "dashboard/activity"), `query` what follows it.
     * @returns {{ path: string, query: string }}
     */
    function currentRoute() {
        const hash = String(window.location.hash || '').replace(/^#!?\/?/, '');
        const at = hash.search(/[?#]/);
        const path = (at < 0 ? hash : hash.slice(0, at)).toLowerCase().replace(/\.html$/, '').replace(/\/+$/, '');
        return { path, query: at < 0 ? '' : hash.slice(at + 1) };
    }

    /**
     * A personal boolean setting as JE.loadSettings resolves it: the user's
     * saved value, else the administrator's default, else off. Group rules use
     * it for the first plan, which runs before enhanced/config.js (which owns
     * JE.loadSettings) has been loaded; once JE.currentSettings exists it is
     * read instead, and the plan is made again.
     * @param {string} key - camelCase settings key (e.g. "qualityTagsEnabled").
     * @returns {boolean}
     */
    function userSetting(key) {
        const current = JE.currentSettings;
        if (current && Object.prototype.hasOwnProperty.call(current, key)) return current[key] === true;
        const saved = JE.userConfig && JE.userConfig.settings ? JE.userConfig.settings[key] : undefined;
        if (typeof saved === 'boolean') return saved;
        const config = JE.pluginConfig || {};
        const fallback = config[key] !== null && config[key] !== undefined ? config[key] : config[key.charAt(0).toUpperCase() + key.slice(1)];
        return fallback === true;
    }

    /**
     * Stage 6, as data: [group, initializer, condition]. `group` is the
     * component group whose modules define the initializer (an id that is not
     * in js/component-groups.json means "core"), `initializer` its path on JE,
     * and `condition(config, settings)` — JE.pluginConfig and
     * JE.currentSettings — whether to call it (omitted: always). The order is
     * the order the calls have always run in: at boot every entry of a loaded
     * group runs in this order; a group loaded later runs its own entries, in
     * this order, right after its modules.
     * @type {Array<[string, string, ((config: object, settings: object) => any)?]>}
     */
    const FEATURE_INITIALIZERS = [
        ['dashboard', 'initializePluginRevisions'],
        ['core', 'initializeEnhancedScript'],
        ['elsewhere', 'initializeElsewhereScript', (c) => c.ElsewhereEnabled],
        ['seerr', 'initializeJellyseerrScript', (c) => c.JellyseerrEnabled && c.JellyseerrShowSearchResults !== false],
        ['seerr', 'jellyseerrIssueReporter.initialize', (c) => c.JellyseerrEnabled && c.JellyseerrShowReportButton],
        ['player', 'initializePauseScreen'],
        ['bookmarks', 'initializeBookmarks'],
        ['tags', 'initializeQualityTags', (c, s) => s.qualityTagsEnabled],
        ['tags', 'initializeGenreTags', (c, s) => s.genreTagsEnabled],
        ['tags', 'initializeRatingTags', (c, s) => s.ratingTagsEnabled],
        ['tags', 'initializeAgeRatingTags', (c, s) => s.ageRatingTagsEnabled],
        ['tags', 'initializeStatusTags', (c, s) => s.statusTagsEnabled],
        ['tags', 'initializeAwardsTags', (c, s) => s.awardsTagsEnabled && c.AwardsTagsEnabled !== false],
        ['tags', 'initializeCustomTags', (c, s) => s.customTagsEnabled],
        ['tags', 'initializeTagStyles', (c) => c.TagStyleWebActive],
        ['tags', 'initializeUserReviewTags', (c, s) => c.ShowUserReviews && c.ShowUserRatingOnPosters && s.ratingTagsEnabled],
        ['arr-links', 'initializeArrLinksScript', (c) => c.ArrLinksEnabled],
        ['arr-tag-links', 'initializeArrTagLinksScript', (c) => c.ArrTagsShowAsLinks],
        ['seerr', 'initializeSeerrDetailLinkScript', (c) => c.JellyseerrEnabled && c.JellyseerrShowDetailPageLink],
        ['letterboxd', 'initializeLetterboxdLinksScript', (c) => c.LetterboxdEnabled],
        ['reviews', 'initializeReviewsScript', (c) => c.ShowReviews || c.ShowUserReviews || c.ShowAnilistReviews],
        ['awards', 'initializeAwardsScript', (c) => c.ShowAwards],
        ['content-warnings', 'initializeDoesTheDogDieScript', (c) => c.DoesTheDogDieEnabled],
        ['mdblist', 'initializeMdblistRatingsScript', (c) => c.MdblistRatingsEnabled && c.MdblistRatingsShowOnItemDetails],
        ['tags', 'initializeLanguageTags', (c, s) => s.languageTagsEnabled],
        ['tags', 'initializeLogoTags', (c, s) => s.logoTagsEnabled],
        ['tag-people', 'initializePeopleTags', (c, s) => s.peopleTagsEnabled],
        // The unified tag pipeline starts AFTER all tag renderers have registered.
        ['tags', 'tagPipeline.initialize'],
        ['player', 'initializeOsdRating'],
        ['player-badge', 'initializePlaybackRatingBadge', (c) => c.ShowPlaybackRatingBadge],
        // Hidden Content off server-wide: JE.hiddenContent stays undefined, safely disabling all downstream consumers.
        ['hidden-content', 'initializeHiddenContent', (c) => c.HiddenContentEnabled],
        // Spoiler Guard loads its per-user enabled-series list once at startup. The toggle button on series detail pages reads from that cache.
        ['spoiler-guard', 'spoilerBlur.init', (c) => c.SpoilerBlurEnabled],
        ['core', 'initializeColoredRatings', (c) => c.ColoredRatingsEnabled],
        ['theme-selector', 'initializeThemeSelector', (c) => c.ThemeSelectorEnabled],
        ['dashboard', 'initializeActivityIcons', (c) => c.ColoredActivityIconsEnabled],
        ['dashboard', 'initializePluginIcons', (c) => c.PluginIconsEnabled],
        ['active-streams', 'activeStreams.initialize', (c) => c.ActiveStreamsEnabled],
        ['requests-page', 'initializeDownloadsPage', (c) => c.DownloadsPageEnabled],
        ['calendar-page', 'initializeCalendarPage', (c) => c.CalendarPageEnabled],
        ['hidden-content-page', 'initializeHiddenContentPage', (c) => c.HiddenContentEnabled],
        // Seerr search used to make this check as it started, on every page: it
        // caches the user's Seerr status for the session and shows the one-time
        // "not linked / unreachable" notice. Search now loads on its own pages,
        // so the check is made here, at the same moment as before.
        ['seerr-api', 'jellyseerrAPI.checkUserStatus', (c) => c.JellyseerrEnabled && c.JellyseerrShowSearchResults !== false]
    ];

    /**
     * Whether any stage-6 initializer of a group would run with the current
     * config and settings. A group whose features all start through stage 6
     * has nothing to do while this is false, so it is not loaded.
     * @param {string} id - Group id.
     * @returns {boolean}
     */
    function groupHasEnabledFeature(id) {
        const config = JE.pluginConfig || {};
        const settings = JE.currentSettings || {};
        return FEATURE_INITIALIZERS.some(([group, , condition]) => group === id && (!condition || !!condition(config, settings)));
    }

    const isHomeRoute = (route) => route.path === '' || route.path === 'home';
    const isDetailsRoute = (route) => route.path === 'details';
    const isVideoRoute = (route) => route.path === 'video';
    const isDashboardRoute = (route) => /^(dashboard|configurationpage|settings)(\/|$)/.test(route.path);
    /** Whether the address is the plugin's own admin configuration page (or its old Media Tags address). */
    const isOwnConfigPage = (route) => route.path === 'configurationpage' && /jellyfin[\s+_.-]*enhanced/i.test(safeDecode(route.query));
    const isSeerrRoute = (route) => isDetailsRoute(route) || route.path === 'list' || route.path === 'search';
    /** The nine poster tag types: any of them on means cards carry JE tags. */
    const POSTER_TAG_SETTINGS = ['qualityTagsEnabled', 'genreTagsEnabled', 'ratingTagsEnabled', 'ageRatingTagsEnabled', 'statusTagsEnabled',
        'awardsTagsEnabled', 'customTagsEnabled', 'languageTagsEnabled', 'logoTagsEnabled'];
    const posterTagsOn = () => POSTER_TAG_SETTINGS.some(userSetting);
    // Set once a <video> starts loading or playing anywhere (see watchGroupTriggers):
    // playback can begin before the address changes to the video page.
    let videoSeen = false;
    const playerWanted = (route) => videoSeen || isVideoRoute(route);

    /**
     * decodeURIComponent that returns its input when it is not valid.
     * @param {string} text
     * @returns {string}
     */
    function safeDecode(text) {
        try { return decodeURIComponent(text); } catch (e) { return text; }
    }

    /**
     * JE's own pages. Each can be delivered as a tab on Home (JE's own tab, or
     * one the Custom Tabs plugin provides), by the Plugin Pages plugin, or, for
     * the pages with `routes`, standalone behind a sidebar link at its own
     * address. `tab` is the Home tab JE registers for the page ([id, title key,
     * fallback title, icon]: exactly what the page's own *-custom-tab module
     * registers), `marker` the class of the placeholder a tab holds for it,
     * `pluginPage` the page's Plugin Pages address (lower case). The order is
     * the order the tabs are registered in, which is the order they appear in:
     * the order the pages' own modules register them in the single bundle.
     */
    const FEATURE_PAGES = [
        { group: 'hidden-content-page', flag: 'HiddenContentEnabled', delivery: 'HiddenContent', tab: ['hidden-content', 'hidden_content_manage_title', 'Hidden Content', 'remove_red_eye'], marker: 'jellyfinenhanced hidden-content', routes: ['hidden-content'], pluginPage: 'hiddencontentpage' },
        { group: 'catchup', flag: 'CatchUpEnabled', delivery: 'CatchUp', tab: ['catchup', 'catchup_title', 'Catch Up', 'style'], marker: 'jellyfinenhanced catchup', pluginPage: 'catchuppage' },
        { group: 'recommendations', flag: 'RecommendationsPageEnabled', delivery: 'Recommendations', tab: ['recommendations', 'recommendations_title', undefined, 'auto_awesome'], marker: 'jellyfinenhanced recommendations', routes: ['recommendations'], pluginPage: 'recommendationspage' },
        { group: 'requests-page', flag: 'DownloadsPageEnabled', delivery: 'Downloads', tab: ['requests', 'requests_requests', 'Requests', 'download'], marker: 'jellyfinenhanced requests', routes: ['downloads'], pluginPage: 'downloadspage' },
        { group: 'calendar-page', flag: 'CalendarPageEnabled', delivery: 'Calendar', tab: ['calendar', 'calendar_title', 'Calendar', 'calendar_month'], marker: 'jellyfinenhanced calendar', routes: ['calendar'], pluginPage: 'calendarpage' },
        { group: 'activity-page', flag: 'ActivityFeedEnabled', delivery: 'ActivityFeed', tab: ['activity', 'activity_title', 'Activity', 'history'], marker: 'jellyfinenhanced activity', pluginPage: 'activitypage' },
        { group: 'leavingsoon-page', flag: 'LeavingSoonPageEnabled', delivery: 'LeavingSoonPage', tab: ['leavingsoon', 'leavingsoon_title', 'Leaving Soon', 'auto_delete'], marker: 'jellyfinenhanced leavingsoon', pluginPage: 'leavingsoonpage' },
        // Last: the Bookmarks library registers its tab from a timer once its data is ready, after the others.
        { group: 'bookmarks-library', flag: 'BookmarksEnabled', delivery: 'Bookmarks', tab: ['bookmarks', null, 'Bookmarks', 'location_on'], marker: 'sections bookmarks', routes: ['bookmarks'], pluginPage: 'bookmarkspage' }
    ];
    const markerSelector = (page) => '.' + page.marker.split(' ').join('.');
    /** Whether a page is delivered as a Home tab (JE's own or the Custom Tabs plugin's). */
    const isTabbedPage = (page) => {
        const config = JE.pluginConfig || {};
        return !!(config[`${page.delivery}UseNativeTab`] || config[`${page.delivery}UseCustomTabs`]);
    };

    /**
     * Whether one of JE's pages has to be loaded now: it is enabled and either
     * it is delivered standalone (its own start-up adds the sidebar link and
     * takes over its address, so it loads at boot as it always has), or the
     * address is the page's own, or its Plugin Pages address, or names its Home
     * tab, or the tab holding its placeholder is the active one.
     * @param {typeof FEATURE_PAGES[number]} page
     * @param {{ path: string, query: string }} route
     * @returns {boolean}
     */
    function pageNeeded(page, route) {
        const config = JE.pluginConfig || {};
        if (!config[page.flag]) return false;
        if (page.routes && !isTabbedPage(page)) return true;
        if (page.routes && page.routes.includes(route.path)) return true;
        if (route.path.indexOf('userpluginsettings') === 0) {
            // Plugin Pages shows the page at an address that carries its URL
            // (/JellyfinEnhanced/calendarPage). An address that names none of
            // JE's pages is one this code does not know how to read: load them all.
            const address = safeDecode(route.query).toLowerCase();
            return address.includes('jellyfinenhanced/') ? address.includes(`jellyfinenhanced/${page.pluginPage}`) : true;
        }
        if (isHomeRoute(route)) {
            const query = safeDecode(route.query);
            if (new RegExp(`(^|[?&#])jeTab=${page.tab[0]}(&|#|$)`).test(query)) return true;
            // A Recommendations category opens over Home whichever tab is shown.
            if (page.group === 'recommendations' && /(^|[?&#])jeCategory=/.test(query)) return true;
        }
        const isActive = JE.helpers && JE.helpers.isActiveTabContainer;
        return typeof isActive === 'function'
            && Array.prototype.some.call(document.querySelectorAll(markerSelector(page)), (element) => isActive(element));
    }
    const pageRule = (group) => {
        const page = FEATURE_PAGES.find(entry => entry.group === group);
        return (route) => pageNeeded(page, route);
    };
    /** A group all of whose features start through stage 6, on details pages only. */
    const onDetails = (group) => (route) => isDetailsRoute(route) && groupHasEnabledFeature(group);

    /**
     * When each group is needed, beyond "core" (always):
     *  - `needed(route)` is asked at boot, after every navigation, when a tab or
     *    video appears and after a user switch. The group loads the first time
     *    it answers true, and then stays loaded.
     *  - `with()` lists groups to load along with it that it is not "after" in
     *    js/component-groups.json because the need depends on the config.
     *  - `exports` are JE functions (dotted paths) that load the group when
     *    called before it is loaded, then make the call (installLazyExports).
     * A group in js/component-groups.json without an entry here loads at boot.
     * @type {Object<string, { needed?: (route: { path: string, query: string }) => boolean, with?: () => string[], exports?: string[] }>}
     */
    const FEATURE_GROUPS = {
        // Poster tags are on every card surface, so they load at boot — but
        // only when the user has a tag type on. The settings panel is "after"
        // every tag group, so switching a type on there finds its code loaded.
        'tags': { needed: () => posterTagsOn() },
        'tag-direct-play': { needed: () => posterTagsOn() && userSetting('statusTagsEnabled') && userSetting('statusTagsDirectPlay') },
        'tag-poster-colours': { needed: () => posterTagsOn() && !!(JE.pluginConfig || {}).TagStyleWebActive },
        'tag-people': { needed: (route) => isDetailsRoute(route) && userSetting('peopleTagsEnabled') },
        // Its item-menu hook has to see the first menu that opens.
        'removal-menu': { needed: () => { const c = JE.pluginConfig || {}; return c.MaintainerrActionsAvailable === true || c.RemovalRequestsAvailable === true; } },
        // Both act before content paints, so they are never deferred.
        'spoiler-guard': { needed: () => !!(JE.pluginConfig || {}).SpoilerBlurEnabled },
        'hidden-content': { needed: () => !!(JE.pluginConfig || {}).HiddenContentEnabled },
        'details': { needed: isDetailsRoute },
        'player': {
            needed: playerWanted,
            // The player shortcuts (enhanced/events.js): one pressed while the
            // group is still arriving is carried out when it has.
            exports: ['cycleAspect', 'togglePlaybackInfo', 'cycleSubtitleTrack', 'cycleAudioTrack', 'resetPlaybackSpeed', 'adjustPlaybackSpeed',
                'skipIntroOutro', 'frameStep', 'adjustSubtitleOffset', 'jumpToLastPosition', 'jumpToPercentage', 'toggleSubtitleSync']
        },
        // Listens for the first "playing" event, which can come before the video page.
        'player-badge': { needed: () => !!(JE.pluginConfig || {}).ShowPlaybackRatingBadge },
        'bookmarks': { needed: (route) => !!(JE.pluginConfig || {}).BookmarksEnabled && playerWanted(route) },
        'bookmarks-library': { needed: pageRule('bookmarks-library') },
        'hidden-content-page': { needed: pageRule('hidden-content-page') },
        'catchup': { needed: pageRule('catchup') },
        'settings': {
            // The admin page's Media Tags tab draws with the panel's preview and editors.
            needed: isOwnConfigPage,
            // The panel's "Manage hidden content" asks the page, synchronously, whether it can show itself.
            with: () => ((JE.pluginConfig || {}).HiddenContentEnabled ? ['hidden-content-page'] : []),
            exports: ['showEnhancedPanel']
        },
        'elsewhere': { needed: onDetails('elsewhere') },
        'reviews': { needed: onDetails('reviews') },
        'awards': { needed: onDetails('awards') },
        'mdblist': { needed: onDetails('mdblist') },
        'content-warnings': { needed: onDetails('content-warnings') },
        'letterboxd': { needed: onDetails('letterboxd') },
        'arr-tag-links': { needed: onDetails('arr-tag-links') },
        // Administrators only (its start-up checks), and it reports a broken
        // Sonarr/Radarr setup as it starts, so it keeps starting at boot.
        'arr-links': { needed: () => !!(JE.pluginConfig || {}).ArrLinksEnabled && userSetting('isAdmin') },
        'seerr-api': { needed: () => !!(JE.pluginConfig || {}).JellyseerrEnabled },
        'seerr': {
            needed: (route) => !!(JE.pluginConfig || {}).JellyseerrEnabled && isSeerrRoute(route),
            // Opened from outside its own pages: Home Screen Sections' discover
            // cards and Hidden Content lists (More Info), the Requests page (issues).
            exports: ['jellyseerrMoreInfo.open', 'jellyseerrIssueReporter.showReportModal']
        },
        'recommendations': { needed: pageRule('recommendations') },
        'requests-page': { needed: pageRule('requests-page') },
        'calendar-page': { needed: pageRule('calendar-page') },
        'activity-page': { needed: pageRule('activity-page') },
        'leavingsoon-page': { needed: pageRule('leavingsoon-page') },
        // No flag: plugin revision lists always start, and the configuration
        // page's "Test custom links" uses the plugin-icons module either way.
        'dashboard': { needed: isDashboardRoute },
        'theme-selector': { needed: () => !!(JE.pluginConfig || {}).ThemeSelectorEnabled },
        'active-streams': { needed: () => !!(JE.pluginConfig || {}).ActiveStreamsEnabled }
    };

    /**
     * The groups a group's rule asks to load along with it (`with`).
     * @param {string} id
     * @returns {string[]}
     */
    function companionGroups(id) {
        const rule = FEATURE_GROUPS[id];
        try {
            return rule && rule.with ? rule.with() : [];
        } catch (e) {
            return [];
        }
    }

    /**
     * The groups the current page, config and user need right now.
     * @returns {string[]}
     */
    function neededGroups() {
        if (!componentGroups) return [];
        const route = currentRoute();
        return componentGroups.order.filter((id) => {
            if (id === CORE_GROUP) return true;
            const rule = FEATURE_GROUPS[id];
            if (!rule) return true;
            try {
                return !!rule.needed && !!rule.needed(route);
            } catch (e) {
                console.error(`🪼 Jellyfin Enhanced: Could not decide whether component group '${id}' is needed; loading it.`, e);
                return true;
            }
        });
    }

    /**
     * Reads a dotted path on JE ("jellyseerrIssueReporter.initialize").
     * @param {string} path
     * @returns {{ owner: any, value: any }} The value and the object it sits on.
     */
    function readExport(path) {
        const parts = path.split('.');
        let owner = JE;
        for (let i = 0; i < parts.length - 1 && owner; i++) owner = owner[parts[i]];
        return { owner, value: owner ? owner[parts[parts.length - 1]] : undefined };
    }

    /**
     * Runs the stage-6 initializers of the given groups, in FEATURE_INITIALIZERS
     * order, each under its condition and only when its module defined it.
     * @param {string[]} ids - Groups whose modules have just run.
     */
    function initializeGroupFeatures(ids) {
        const config = JE.pluginConfig || {};
        const settings = JE.currentSettings || {};
        const known = (id) => (componentGroups && componentGroups.byId[id] ? id : CORE_GROUP);
        for (const [group, path, condition] of FEATURE_INITIALIZERS) {
            if (!ids.includes(known(group))) continue;
            if (condition && !condition(config, settings)) continue;
            const { owner, value } = readExport(path);
            if (typeof value === 'function' && !value.jeLazyGroup) value.call(owner);
        }
    }

    /**
     * Gives every `exports` function of a group that is not loaded a stand-in
     * that loads the group and then makes the same call, so a caller anywhere
     * (a shortcut, a header button, another feature) needs no knowledge of
     * groups. The group's module replaces the stand-in when it runs. A
     * stand-in returns a promise for the real call's result, so it only suits
     * calls whose result the caller does not use at once.
     */
    function installLazyExports() {
        for (const id of Object.keys(FEATURE_GROUPS)) {
            const exports = FEATURE_GROUPS[id].exports;
            if (!exports || !componentGroups || !componentGroups.byId[id] || groupStates[id]) continue;
            for (const path of exports) {
                // A dotted export sits on a namespace its module creates; until
                // then an empty one holds the stand-in (the module replaces it).
                const parts = path.split('.');
                let owner = JE;
                for (let i = 0; i < parts.length - 1; i++) {
                    if (owner[parts[i]] === undefined || owner[parts[i]] === null) owner[parts[i]] = {};
                    owner = owner[parts[i]];
                }
                const name = parts[parts.length - 1];
                if (owner[name] !== undefined) continue;
                const standIn = function(...args) {
                    return ensureGroups([id]).then(() => {
                        const real = readExport(path);
                        if (typeof real.value === 'function' && real.value !== standIn) return real.value.apply(real.owner, args);
                        console.error(`🪼 Jellyfin Enhanced: '${path}' is not available (component group '${id}' did not load).`);
                        return undefined;
                    });
                };
                standIn.jeLazyGroup = id;
                owner[name] = standIn;
            }
        }
    }

    /**
     * Loads whatever the current page, config and user need and do not have
     * yet. Called on every navigation, when a Home tab or a video appears and
     * after a user switch; cheap when nothing is missing.
     * @returns {Promise<void>}
     */
    function loadNeededGroups() {
        return ensureGroups(neededGroups());
    }

    /**
     * Registers JE's own Home tabs for the pages delivered that way, in
     * FEATURE_PAGES order, right after "core" has run: a tab has to be in the
     * tab strip from the first Home render, while its page loads only when the
     * tab is shown. Each page's *-custom-tab module registers the same tab when
     * it loads; the registry keeps the first registration of an id.
     */
    function registerPageTabs() {
        const config = JE.pluginConfig || {};
        const register = JE.nativeTabs && JE.nativeTabs.register;
        if (typeof register !== 'function') return;
        for (const page of FEATURE_PAGES) {
            if (!config[page.flag] || !config[`${page.delivery}UseNativeTab`]) continue;
            const [id, titleKey, fallbackTitle, icon] = page.tab;
            const title = titleKey ? (JE.t(titleKey) || fallbackTitle) : fallbackTitle;
            register(id, title, (panel) => {
                const marker = document.createElement('div');
                marker.className = page.marker;
                panel.appendChild(marker);
            }, icon);
        }
    }

    /**
     * Gives the features of groups that loaded after the page was drawn the
     * DOM change they wait for. Many features start their work from the shared
     * body observer and, started at boot, are woken by the page still filling
     * in; started later, on a page that has already settled, nothing would wake
     * them until the user did something. An empty hidden element added to the
     * body and removed again is that wake-up, and changes nothing else.
     */
    function nudgeObservers() {
        if (!document.body) return;
        const marker = document.createElement('span');
        marker.hidden = true;
        document.body.appendChild(marker);
        marker.remove();
    }

    /**
     * Starts loading groups on demand once boot is done:
     *  - on every navigation (JE's own deduplicated navigation hook, which
     *    fires as soon as the address changes, before the new view is shown);
     *  - when a Home tab holding the placeholder of a page that is not loaded
     *    becomes the active one (tab switches do not always change the address);
     *  - when a <video> starts loading or playing (playback can begin before
     *    the address changes to the video page);
     *  - when a switched-in user's data has loaded (done by its own caller).
     */
    function watchGroupTriggers() {
        const onNavigate = JE.core && JE.core.navigation && JE.core.navigation.onNavigate;
        if (typeof onNavigate === 'function') onNavigate(() => { loadNeededGroups(); });
        else window.addEventListener('hashchange', () => { loadNeededGroups(); });

        const tabbed = FEATURE_PAGES.filter(page => componentGroups.byId[page.group] && (JE.pluginConfig || {})[page.flag] && isTabbedPage(page));
        if (tabbed.length && JE.helpers && typeof JE.helpers.observeTabContainers === 'function') {
            const watcher = JE.helpers.observeTabContainers('je-component-groups', tabbed.map(markerSelector).join(', '), () => {
                if (tabbed.every(page => groupStates[page.group])) watcher.teardown();
                else loadNeededGroups();
            });
        }

        if (componentGroups.byId.player && !groupStates.player) {
            const onVideo = (event) => {
                if (!event.target || event.target.nodeName !== 'VIDEO') return;
                videoSeen = true;
                for (const type of ['loadstart', 'play', 'playing']) document.removeEventListener(type, onVideo, true);
                loadNeededGroups();
            };
            for (const type of ['loadstart', 'play', 'playing']) document.addEventListener(type, onVideo, true);
        }

        loadNeededGroups(); // the user may have moved on during boot
    }

    /**
     * The component-group loader, for features and automation.
     * `ensure(ids)` loads groups (resolves when they have run and their
     * features are initialized), `state()` reports each group asked for so far
     * ('loading' or 'ready'), `needed()` lists what the current page needs,
     * `settled()` resolves when nothing is loading, and `catalog()` describes
     * the rules above as data (tests check them against the groups file).
     */
    JE.loader = {
        ensure: (ids) => ensureGroups(Array.isArray(ids) ? ids : [ids]),
        state: () => Object.assign({}, groupStates),
        needed: () => neededGroups(),
        settled: () => groupQueue.then(() => undefined),
        catalog: () => ({
            groups: Object.keys(FEATURE_GROUPS).map(id => ({ id, exports: (FEATURE_GROUPS[id].exports || []).slice() })),
            initializers: FEATURE_INITIALIZERS.map(([group, path]) => ({ group, path })),
            pages: FEATURE_PAGES.map(page => ({ group: page.group, flag: page.flag, delivery: page.delivery, tab: page.tab.slice(), marker: page.marker }))
        })
    };

     /**
     * Loads the splash screen script early.
     */
     function loadSplashScreenEarly() {
        if (typeof ApiClient === 'undefined') {
            setTimeout(loadSplashScreenEarly, 50);
            return;
        }
        const splashScript = document.createElement('script');
        splashScript.src = ApiClient.getUrl('/JellyfinEnhanced/js/others/splashscreen.js?v=' + getScriptVersion());
        splashScript.onload = () => {
            if (typeof JE.initializeSplashScreen === 'function') {
                JE.initializeSplashScreen(); // Initialize if available
            }
        };
         splashScript.onerror = () => console.error('🪼 Jellyfin Enhanced: Failed to load splash screen script.');
        document.head.appendChild(splashScript);
    }

    /**
     * Formats the time left until maintenance ends as a short string ("1h 05m", "12m").
     * Minutes are rounded up so the last minute never reads "0m".
     * @param {number} msRemaining
     * @returns {string}
     */
    function formatMaintenanceCountdown(msRemaining) {
        const totalMinutes = Math.max(0, Math.ceil(msRemaining / 60000));
        const h = Math.floor(totalMinutes / 60);
        const m = totalMinutes % 60;
        return h > 0 ? h + 'h ' + String(m).padStart(2, '0') + 'm' : m + 'm';
    }

    /**
     * Resolves the banner text: replaces the {countdown} (time remaining) and {ends_at}
     * (local end time) tokens, appending the time remaining when an end time is known but
     * the message carries no {countdown} token. Mirrors MaintenanceModeService.FormatMessage.
     * Runs pre-login (no translations loaded yet), hence the literal English fallbacks.
     * @param {string} message
     * @param {Date|null} endsAt
     * @returns {string}
     */
    function formatMaintenanceText(message, endsAt) {
        const text = (message || '').trim() || 'This server is currently undergoing maintenance. Please try again later.';
        if (!endsAt) {
            return text.replace(/\{countdown\}/gi, '').replace(/\{ends_at\}/gi, '').trim();
        }
        const countdown = formatMaintenanceCountdown(endsAt.getTime() - Date.now());
        const endsAtText = endsAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        const hasToken = /\{countdown\}/i.test(text);
        const out = text.replace(/\{countdown\}/gi, countdown).replace(/\{ends_at\}/gi, endsAtText).trim();
        return hasToken ? out : out + ' Time remaining: ' + countdown + '.';
    }

    /**
     * Injects a maintenance banner at the top of the page. With an end time the banner counts
     * down (refreshed every 15s) and removes itself once maintenance is over.
     * @param {string} message
     * @param {string|null} [endsAtIso] UTC ISO timestamp from public-config, or null when open-ended.
     */
    function injectMaintenanceBanner(message, endsAtIso) {
        if (document.getElementById('je-maintenance-banner')) return;
        const endsAt = endsAtIso && !isNaN(Date.parse(endsAtIso)) ? new Date(endsAtIso) : null;
        if (endsAt && endsAt.getTime() <= Date.now()) return;
        const text = formatMaintenanceText(message, endsAt);
        const banner = document.createElement('div');
        banner.id = 'je-maintenance-banner';
        // Above Jellyfin's own chrome (app bar, drawers, dialogs, video player) but below JE's
        // modals (z-index 9999+), so a full-height modal's close button is never hidden under it.
        banner.style.cssText = [
            'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:9990',
            'background:#b71c1c', 'color:#fff', 'text-align:center',
            'padding:10px 48px', 'font-size:14px', 'font-weight:600',
            'letter-spacing:0.02em', 'box-shadow:0 2px 8px rgba(0,0,0,0.4)',
            'font-family:inherit'
        ].join(';');
        banner.textContent = text;
        // Dismiss for this page load only: nothing is stored, so a refresh brings it back.
        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.textContent = '×';
        const translate = window.JellyfinEnhanced && window.JellyfinEnhanced.t;
        const closeLabel = translate ? translate('awards_close') : '';
        closeBtn.setAttribute('aria-label', closeLabel && closeLabel !== 'awards_close' ? closeLabel : 'Close');
        closeBtn.style.cssText = 'position:absolute;top:50%;right:12px;transform:translateY(-50%);background:none;border:0;color:#fff;font-size:22px;line-height:1;cursor:pointer;padding:2px 8px;opacity:0.85';
        closeBtn.addEventListener('click', function() {
            banner.remove();
            if (resizeObserver) resizeObserver.disconnect();
            applyOffset();
        });
        document.body.appendChild(banner);
        // A <style> tag shifts Jellyfin's fixed header, drawers and the body down by the banner
        // height, so the rules survive Jellyfin re-rendering its header. The height is tracked
        // rather than measured once: the countdown text, a narrow viewport or a window resize can
        // change how many lines the banner wraps to.
        let appliedHeight = -1;
        const applyOffset = function() {
            const h = banner.isConnected ? banner.offsetHeight : 0;
            if (h === appliedHeight) return;
            appliedHeight = h;
            let style = document.getElementById('je-maintenance-banner-style');
            if (h <= 0) {
                if (style) style.remove();
                return;
            }
            if (!style) {
                style = document.createElement('style');
                style.id = 'je-maintenance-banner-style';
                document.head.appendChild(style);
            }
            style.textContent = [
                'body { padding-top: ' + h + 'px !important; }',
                '.skinHeader { top: ' + h + 'px !important; }',
                '.mainDrawer { top: ' + h + 'px !important; }',
                // Jellyfin 12 Modern Layout: MUI app bar and side drawers are fixed at top:0 too.
                '.MuiAppBar-positionFixed { top: ' + h + 'px !important; }',
                '.MuiDrawer-paperAnchorLeft, .MuiDrawer-paperAnchorRight { top: ' + h + 'px !important; height: calc(100% - ' + h + 'px) !important; }',
                '.videoOsdBottom { bottom: 0 !important; }'
            ].join('\n');
        };
        requestAnimationFrame(applyOffset);
        const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(applyOffset) : null;
        if (resizeObserver) resizeObserver.observe(banner);
        banner.appendChild(closeBtn);
        if (!endsAt) return;
        const tick = setInterval(function() {
            if (!document.body.contains(banner)) { clearInterval(tick); return; }
            if (endsAt.getTime() <= Date.now()) {
                clearInterval(tick);
                if (resizeObserver) resizeObserver.disconnect();
                banner.remove();
                applyOffset();
                return;
            }
            banner.firstChild.nodeValue = formatMaintenanceText(message, endsAt);
        }, 15000);
    }

    /**
     * Loads the login image script early (checks config first).
     * Also injects a maintenance banner when maintenance mode is active.
     */
    function loadLoginImageEarly() {
        if (typeof ApiClient === 'undefined') {
            setTimeout(loadLoginImageEarly, 50);
            return;
        }

        // Fetch the public config to check if login image / maintenance banner is needed.
        // When the page is already signed in, the bootstrap request (which
        // initialize() is about to need anyway) carries the same public config
        // for the same user, so share it instead of issuing a second request.
        // Pre-login there is no token, so the anonymous endpoint is used as before.
        const fetchPublicConfig = () => ApiClient.ajax({
            type: 'GET',
            url: ApiClient.getUrl('/JellyfinEnhanced/public-config'),
            dataType: 'json'
        });
        const userId = ApiClient.getCurrentUserId?.();
        const configPromise = userId && !hasServerIdMismatch()
            ? getBootstrap(userId).then(bootstrap => bootstrap.PublicConfig).catch(() => fetchPublicConfig())
            : fetchPublicConfig();
        configPromise.then((config) => {
            // Show maintenance banner for all users (admins can dismiss it mentally)
            if (config?.MaintenanceModeEnabled === true) {
                injectMaintenanceBanner(config.MaintenanceModeMessage, config.MaintenanceModeEndsAt || null);
            }

            // Only load login image if enabled (default to false)
            if (config?.EnableLoginImage === true) {
                const loginImageScript = document.createElement('script');
                loginImageScript.src = ApiClient.getUrl('/JellyfinEnhanced/js/extras/login-image.js?v=' + getScriptVersion());
                loginImageScript.onerror = () => console.error('🪼 Jellyfin Enhanced: Failed to load login image script.');
                document.head.appendChild(loginImageScript);
            }
        }).catch(() => {
            console.warn('🪼 Jellyfin Enhanced: Could not fetch config for login image, skipping.');
        });
    }

    /**
     * Checks if there's a server ID mismatch (stale credentials from previous server)
     * @returns {boolean}
     */
    function hasServerIdMismatch() {
        try {
            if (typeof ApiClient === 'undefined') return false;

            const creds = localStorage.getItem('jellyfin_credentials');
            if (!creds) return false;

            const servers = JSON.parse(creds)?.Servers;
            if (!Array.isArray(servers) || servers.length === 0) return false;

            const currentServerId = ApiClient._serverInfo?.Id ||
                (typeof ApiClient.serverId === 'function' ? ApiClient.serverId() : ApiClient.serverId);
            if (!currentServerId) return false;

            // Check if stored server matches current server
            const hasMatch = servers.some(s => s.Id === currentServerId || s.ServerId === currentServerId);
            return !hasMatch;
        } catch (e) {
            return false;
        }
    }

    let mismatchRetryCount = 0;
    const INIT_POLL_INTERVAL_MS = 50;
    const MAX_MISMATCH_RETRIES = 600; // ~30s at 50ms intervals

    // Per-user document name → server file name. Object order is the
    // userConfig key order.
    const USER_CONFIG_DOCUMENTS = {
        settings: 'settings.json',
        shortcuts: 'shortcuts.json',
        bookmark: 'bookmark.json',
        elsewhere: 'elsewhere.json',
        hiddenContent: 'hidden-content.json'
    };

    // Documents the client saves whole. One that failed to load (null) stays
    // null instead of taking the empty default: the next change would
    // otherwise be saved over the user's stored list.
    const SAVED_WHOLE_DOCUMENTS = new Set(['shortcuts', 'hiddenContent']);

    /**
     * Assembles a fresh userConfig object from the five per-user documents.
     * A document that is missing or failed to load (null/undefined/non-object)
     * keeps its default, except that a hidden-content or shortcuts document
     * that failed to load (null) stays null; settings, bookmark and
     * hidden-content are converted from PascalCase to camelCase. Shared by the
     * per-endpoint loader and the bootstrap payload so both build the object
     * identically.
     * @param {object} documents - Map of document name (settings, shortcuts,
     *   bookmark, elsewhere, hiddenContent) to its parsed JSON, or null.
     * @returns {object} A freshly-built userConfig object.
     */
    function buildUserConfig(documents) {
        const userConfig = { settings: {}, shortcuts: { Shortcuts: [] }, bookmark: { bookmarks: {} }, elsewhere: {}, hiddenContent: { items: {}, settings: {} } };
        for (const name of Object.keys(USER_CONFIG_DOCUMENTS)) {
            const value = documents ? documents[name] : null;
            if (value === null && SAVED_WHOLE_DOCUMENTS.has(name)) { userConfig[name] = null; continue; }
            if (!value || typeof value !== 'object') continue; // keep the default
            // *** CONVERT PASCALCASE TO CAMELCASE ***
            if (name === 'settings' || name === 'bookmark' || name === 'hiddenContent') {
                userConfig[name] = toCamelCase(value);
            } else {
                userConfig[name] = value;
            }
        }
        return userConfig;
    }

    /**
     * Builds the userConfig object from the bootstrap payload's UserSettings
     * block (the same five documents the standalone endpoints return). The
     * server answers null for a document it could not load, and Jellyfin's
     * serializer leaves null properties out, so a missing document is one
     * that failed to load.
     * @param {object} userSettings - `UserSettings` from the bootstrap payload.
     * @returns {object} A freshly-built userConfig object.
     */
    function buildUserConfigFromBootstrap(userSettings) {
        const docs = userSettings && typeof userSettings === 'object' ? userSettings : {};
        const doc = key => (Object.prototype.hasOwnProperty.call(docs, key) ? docs[key] : null);
        return buildUserConfig({
            settings: doc('Settings'),
            shortcuts: doc('Shortcuts'),
            bookmark: doc('Bookmark'),
            elsewhere: doc('Elsewhere'),
            hiddenContent: doc('HiddenContent')
        });
    }

    /**
     * Fetches the five per-user config files (settings, shortcuts, bookmark,
     * elsewhere, hidden-content) individually and assembles a fresh userConfig
     * object. The fallback when the bootstrap request is unavailable.
     * @param {string} userId - The user to load config for.
     * @returns {Promise<object>} A freshly-built userConfig object.
     */
    async function fetchUserScopedConfig(userId) {
        const documents = {};
        // Every fetch settles (a failure just leaves that document at its default)
        await Promise.all(Object.entries(USER_CONFIG_DOCUMENTS).map(([name, fileName]) =>
            ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl(`/JellyfinEnhanced/user-settings/${userId}/${fileName}?_=${Date.now()}`), dataType: 'json' })
                     .then(data => { documents[name] = data; })
                     .catch(() => { documents[name] = null; })
        ));
        return buildUserConfig(documents);
    }

    /**
     * Loads the signed-in user's scoped data — the userConfig documents, the
     * per-user public config fields and the admin-only private config — and
     * applies them to the globals. One bootstrap
     * request when possible, otherwise the per-endpoint path. Used by the
     * user-switch re-bootstrap and the boot-time "user changed during boot"
     * recovery; the caller's epoch guard is consulted before every write so a
     * result that arrives after yet another switch is dropped.
     * @param {string} userId - The user to load data for.
     * @param {() => boolean} isCurrent - Epoch guard; false means the result is stale.
     * @returns {Promise<boolean>} true when the globals were updated.
     */
    async function reloadUserScopedData(userId, isCurrent) {
        const bootstrap = await fetchBootstrap().catch((e) => {
            console.warn('🪼 Jellyfin Enhanced: Bootstrap request failed, reloading user data per endpoint.', e);
            return null;
        });
        if (!isCurrent()) return false;
        if (bootstrap && bootstrapMatchesUser(bootstrap, userId)) {
            JE.userConfig = buildUserConfigFromBootstrap(bootstrap.UserSettings);
            applyUserPublicConfig(bootstrap.PublicConfig);
            applyPrivateConfig(bootstrap.PrivateConfig);
            return true;
        }
        const [userConfig] = await Promise.all([fetchUserScopedConfig(userId), loadUserPublicConfig(isCurrent)]);
        if (!isCurrent()) return false;
        JE.userConfig = userConfig;
        await loadPrivateConfig(); // internally epoch-guarded
        return isCurrent();
    }

    /**
     * Seeds the admin's default display language into the per-user
     * `${userId}-language` key — only when the user has no language set yet,
     * so a user's own choice is never overwritten.
     * @param {string} userId
     */
    function seedDisplayLanguage(userId) {
        if (!userId) return;
        const languageKey = `${userId}-language`;
        // Only seed the admin's default language if the user has no language set yet.
        // This prevents overwriting the user's own language choice on every page load.
        if (localStorage.getItem(languageKey) === null) {
            const desiredLanguage = (JE.currentSettings?.displayLanguage || '').trim();
            if (desiredLanguage) {
                const normalizeLangCode = (code) => {
                    if (!code) return '';
                    const parts = code.split('-');
                    if (parts.length === 1) return parts[0].toLowerCase();
                    if (parts.length === 2) return `${parts[0].toLowerCase()}-${parts[1].toUpperCase()}`;
                    return code;
                };
                localStorage.setItem(languageKey, normalizeLangCode(desiredLanguage));
            }
        }
    }

    /**
     * Wires the plugin's own state into the identity-session machinery
     * (js/core/session.js): clears the boot-time per-user globals on any
     * identity transition, and re-loads them for the incoming user after a
     * switch — the SPA never reloads index.html on logout/login, so without
     * this every module keeps serving the previous user's data.
     * Called once, right after the component scripts (including session.js)
     * have loaded.
     */
    function registerSessionIntegration() {
        if (!JE.session) {
            console.error('🪼 Jellyfin Enhanced: session.js missing — user-switch handling disabled.');
            return;
        }

        // Synchronous reset: wipe every boot-time global the moment the
        // identity changes, so nothing can read user A's data under user B.
        JE.session.onUserChange('plugin-globals', () => {
            JE.userConfig = { settings: {}, shortcuts: { Shortcuts: [] }, bookmark: { bookmarks: {} }, elsewhere: {}, hiddenContent: { items: {}, settings: {} } };
            JE.currentSettings = {};
            // Cleared (not merged over) so user A's extra shortcuts don't
            // survive into user B's session — initializeShortcuts() merges.
            JE.state.activeShortcuts = {};
            // Strip the admin-only private config; re-fetched (admins only)
            // during the re-bootstrap below.
            for (const key of privateConfigKeys) delete JE.pluginConfig[key];
            privateConfigKeys = [];
            // Item looks were projected for the previous user's access.
            applyUserPublicConfig(null);
            // Untaken startup answers belong to the previous user.
            prefetched = null;
        });

        // Async re-bootstrap: after a switch to a signed-in user, reload that
        // user's config and re-derive settings/shortcuts/translations.
        document.addEventListener('je:user-changed', (e) => {
            const detail = /** @type {CustomEvent} */ (e).detail || {};
            const { userId, epoch } = detail;
            if (!userId) return; // logged out — stay reset until the next sign-in
            // Defer one macrotask: the transition fires from inside the
            // setAuthenticationInfo wrapper BEFORE the host installs the new
            // token; the fetches below need that token in place.
            setTimeout(async () => {
                if (!JE.session.isCurrent(epoch)) return; // switched again already
                try {
                    // Reload the user documents and re-fetch the admin-only
                    // private config for the incoming user (the reset stripped
                    // the previous user's copy; the server omits it for
                    // non-admins, leaving the keys absent). Stale results
                    // (another switch meanwhile) are dropped.
                    if (!await reloadUserScopedData(userId, () => JE.session.isCurrent(epoch))) return;

                    JE.currentSettings = JE.loadSettings();
                    JE.initializeShortcuts();
                    seedDisplayLanguage(userId);

                    // The incoming user may have features on that the previous
                    // one did not: load their groups (which also runs their
                    // stage-6 initializers) before the re-initialization below.
                    await loadNeededGroups();
                    if (!JE.session.isCurrent(epoch)) return;

                    // Per-user tag toggles can differ between users, and the
                    // boot-time conditional initialization only ran for the
                    // first user. The four base-renderer initializers are
                    // idempotent by design (they re-register with fresh
                    // settings), so re-run whichever the incoming user has
                    // enabled; renderers whose toggle is now off stop via
                    // their isEnabled gate and the pipeline invalidation
                    // removes stale overlays.
                    if (JE.currentSettings?.qualityTagsEnabled && typeof JE.initializeQualityTags === 'function') JE.initializeQualityTags();
                    if (JE.currentSettings?.genreTagsEnabled && typeof JE.initializeGenreTags === 'function') JE.initializeGenreTags();
                    if (JE.currentSettings?.ratingTagsEnabled && typeof JE.initializeRatingTags === 'function') JE.initializeRatingTags();
                    if (JE.currentSettings?.ageRatingTagsEnabled && typeof JE.initializeAgeRatingTags === 'function') JE.initializeAgeRatingTags();
                    if (JE.currentSettings?.statusTagsEnabled && typeof JE.initializeStatusTags === 'function') JE.initializeStatusTags();
                    if (JE.currentSettings?.awardsTagsEnabled && JE.pluginConfig?.AwardsTagsEnabled !== false && typeof JE.initializeAwardsTags === 'function') JE.initializeAwardsTags();
                    if (JE.currentSettings?.customTagsEnabled && typeof JE.initializeCustomTags === 'function') JE.initializeCustomTags();
                    if (JE.currentSettings?.languageTagsEnabled && typeof JE.initializeLanguageTags === 'function') JE.initializeLanguageTags();
                    if (JE.currentSettings?.logoTagsEnabled && typeof JE.initializeLogoTags === 'function') JE.initializeLogoTags();

                    // Translations follow the per-user language choice.
                    try {
                        const translations = await loadTranslations();
                        if (!JE.session.isCurrent(epoch)) return;
                        if (translations) JE.translations = translations;
                    } catch (_) { /* keep previous translations */ }

                    // Announce that the new user's data is live so views
                    // (bookmarks, hidden content, …) can re-render from it.
                    document.dispatchEvent(new CustomEvent('je:user-data-loaded', { detail }));
                    console.log('🪼 Jellyfin Enhanced: Reloaded user-scoped data after user switch.');
                } catch (err) {
                    console.error('🪼 Jellyfin Enhanced: Failed to reload user data after user switch:', err);
                }
            }, 0);
        });
    }

    /**
     * Main initialization function.
     */
    async function initialize() {
        // Check for server ID mismatch - stop retrying if credentials are stale
        if (hasServerIdMismatch()) {
            mismatchRetryCount++;
            if (mismatchRetryCount >= MAX_MISMATCH_RETRIES) {
                console.warn('🪼 Jellyfin Enhanced: Server ID mismatch detected - stopping to allow re-authentication');
                window.JE?.hideSplashScreen?.();
                return;
            }
            setTimeout(initialize, INIT_POLL_INTERVAL_MS);
            return;
        }

        // Normal retry logic (no mismatch)
        if (typeof ApiClient === 'undefined' || !ApiClient.getCurrentUserId?.()) {
            setTimeout(initialize, INIT_POLL_INTERVAL_MS);
            return;
        }

        // Reset mismatch counter on success
        mismatchRetryCount = 0;

        try {
            // Stage 1+2: one bootstrap request (version, public + private config,
            // delivery-plugin flags, the five per-user documents, script list)
            // in parallel with the translations module + locale load. Per-endpoint
            // fallback when the bootstrap fails, so nothing regresses.
            let userId = ApiClient.getCurrentUserId();
            seedPluginVersionFromScriptTag(); // lets translations.js skip its /version fetch
            const [bootstrap, translations] = await Promise.all([
                getBootstrap(userId).catch((e) => {
                    console.warn('🪼 Jellyfin Enhanced: Bootstrap request failed, falling back to individual requests.', e);
                    return null;
                }),
                loadTranslationsModule().then(() => loadTranslations())
            ]);

            if (bootstrap) {
                JE.pluginConfig = bootstrap.PublicConfig;
                JE.pluginVersion = bootstrap.Version || 'unknown';
            } else {
                const [config, version] = await loadPluginData();
                JE.pluginConfig = config && typeof config === 'object' ? config : {};
                JE.pluginVersion = version || 'unknown';
            }
            JE.translations = translations || {};
            JE.t = window.JellyfinEnhanced.t; // Ensure the real function is assigned
            if (bootstrap) {
                applyPrivateConfig(bootstrap.PrivateConfig); // null for non-admins
            } else {
                await loadPrivateConfig();
            }

            // Clear stale UseCustomTabs / UsePluginPages config flags when those
            // plugins are not installed.  Settings persist after uninstall, which
            // causes sidebar injection to be skipped even though the delivery
            // plugin is no longer present.
            if (bootstrap) {
                applyDeliveryPluginFlags(bootstrap.HasCustomTabs === true, bootstrap.HasPluginPages === true);
            } else {
                await loadDeliveryPluginFlags();
            }

            // Check if server has triggered a translation cache clear
            const serverTranslationClearTs = JE.pluginConfig.ClearTranslationCacheTimestamp || 0;
            const localTranslationClearTs = parseInt(localStorage.getItem('JE_translation_clear_ts') || '0', 10);
            if (serverTranslationClearTs > localTranslationClearTs) {
                console.log(`🪼 Jellyfin Enhanced: Server-triggered translation cache clear (${new Date(serverTranslationClearTs).toISOString()})`);
                // Only entries cached BEFORE the server's clear are stale. Entries
                // written after it — e.g. the locale a fresh browser profile (no
                // local marker yet) fetched moments ago — are already current, so
                // they are kept and no second locale fetch is needed.
                let removedAny = false;
                for (let i = localStorage.length - 1; i >= 0; i--) {
                    const key = localStorage.key(i);
                    if (!key || !key.startsWith('JE_translation_')) continue;
                    const tsKey = key.startsWith('JE_translation_ts_') ? key : `JE_translation_ts_${key.slice('JE_translation_'.length)}`;
                    const cachedAt = parseInt(localStorage.getItem(tsKey) || '0', 10);
                    if (cachedAt > serverTranslationClearTs) continue;
                    localStorage.removeItem(key);
                    removedAny = true;
                }
                localStorage.setItem('JE_translation_clear_ts', serverTranslationClearTs.toString());
                if (removedAny) {
                    // Reload translations with fresh data
                    JE.translations = await loadTranslations() || {};
                    JE.t = window.JellyfinEnhanced.t;
                }
            }

            // Inject metadata icons CSS if enabled
            try {
                injectMetadataIcons(!!JE.pluginConfig?.MetadataIconsEnabled);
            } catch (e) {
                console.warn('🪼 Jellyfin Enhanced: Failed to inject Metadata icons CSS', e);
            }

            // User-specific settings (from the bootstrap, else fetched per file)
            JE.userConfig = bootstrap
                ? buildUserConfigFromBootstrap(bootstrap.UserSettings)
                : await fetchUserScopedConfig(userId);

            // Initialize splash screen
            if (typeof JE.initializeSplashScreen === 'function') {
                JE.initializeSplashScreen();
            }

            // Stage 3: Load the component groups this page needs. The ordered
            // module list lives in js/component-scripts.json and its split into
            // groups in js/component-groups.json (see CONTRIBUTING.md);
            // production loads the groups as one server-side bundle, dev mode
            // as individual files. Modules read JE.pluginConfig / JE.userConfig
            // at eval time, so this must stay after the config is applied.
            await setComponentGroups(bootstrap);
            await ensureGroups(neededGroups(), { idle: true, initialize: false });
            console.log('🪼 Jellyfin Enhanced: Component scripts loaded.');

            // Wire user-switch detection → global reset → re-bootstrap.
            // Must happen after the component scripts so JE.session exists.
            registerSessionIntegration();

            // A user switch during the stage-1/2 fetches happens BEFORE the
            // session module exists, so it was adopted silently with no reset
            // — EVERYTHING fetched above belongs to the previous user.
            // Re-fetch it all for whoever is actually signed in now (mirrors
            // the je:user-changed re-bootstrap in registerSessionIntegration).
            const liveUserId = ApiClient.getCurrentUserId();
            if (liveUserId && liveUserId !== userId) {
                console.warn('🪼 Jellyfin Enhanced: User changed during boot — reloading user-scoped data.');
                userId = liveUserId;
                // Session exists now — epoch-guard this recovery too, so yet
                // another switch during these fetches can't restore this
                // user's data over the next user's reset.
                const recoveryEpoch = JE.session ? JE.session.getEpoch() : 0;
                const recoveryCurrent = () => !JE.session || JE.session.isCurrent(recoveryEpoch);
                // Strip the admin-only private config fetched in stage 1 before
                // the reload merges the live user's copy (if any).
                for (const key of privateConfigKeys) delete JE.pluginConfig[key];
                privateConfigKeys = [];
                await reloadUserScopedData(liveUserId, recoveryCurrent);
                // If ANOTHER switch happened during this recovery, the
                // je:user-changed re-bootstrap owns the repair — this stale
                // recovery must not touch the globals further.
            }

            // Stage 4: Initialize core settings/shortcuts using potentially defined functions
            if (typeof JE.loadSettings === 'function' && typeof JE.initializeShortcuts === 'function') {
                JE.currentSettings = JE.loadSettings(); // This happens AFTER config.js is loaded
                JE.initializeShortcuts();
            } else {
                 console.error("🪼 Jellyfin Enhanced: FATAL - config.js functions not defined after script loading.");
                 if (typeof JE.hideSplashScreen === 'function') JE.hideSplashScreen();
                 return;
            }

            seedDisplayLanguage(userId);

            // The first plan read personal settings before enhanced/config.js
            // had resolved them (and the user may have changed since); load
            // whatever the resolved settings and the current page add.
            await ensureGroups(neededGroups(), { idle: true, initialize: false });
            installLazyExports();

            // Stage 5: Initialize theme system first
            if (typeof JE.themer?.init === 'function') {
                JE.themer.init();
                console.log('🪼 Jellyfin Enhanced: Theme system initialized.');
            }

            // Register unified cache save on page unload
            window.addEventListener('beforeunload', () => {
                JE._cacheManager.forceSave();
            });

            // Stage 6: Initialize the feature modules of every group loaded so
            // far, in FEATURE_INITIALIZERS order. Groups loaded later run their
            // own entries right after their modules.
            initializeGroupFeatures(Object.keys(groupStates).filter(id => groupStates[id] === 'ready'));
            watchGroupTriggers();

            console.log('🪼 Jellyfin Enhanced: All components initialized successfully.');

            // Programmatic boot-complete marker: every component script this page
            // needs has executed and every enabled initializeX() of theirs has run.
            // Automation (E2E) waits on this instead of racing individual JE.*
            // properties that appear mid-boot; for a feature that loads on demand,
            // await JE.loader.ensure([group]) or JE.loader.settled().
            JE.initialized = true;

            // Final Stage: Hide splash screen
            if (typeof JE.hideSplashScreen === 'function') {
                JE.hideSplashScreen();
            }

        } catch (error) {
            console.error('🪼 Jellyfin Enhanced: CRITICAL INITIALIZATION FAILURE:', error);
             if (typeof JE.hideSplashScreen === 'function') {
                JE.hideSplashScreen();
            }
        }
    }

    // Load splash screen immediately (before main initialization)
    loadSplashScreenEarly();

    // Load login image immediately (before main initialization)
    loadLoginImageEarly();

    // Then start main initialization
    initialize();

})();
