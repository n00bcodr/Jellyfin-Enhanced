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
            flagSvg(code) { return this.url('flag-icons', `flags/4x3/${String(code).toLowerCase()}.svg`); }
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
            skipToastShown: false,
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
            if (params) {
                for (const [param, value] of Object.entries(params)) {
                    text = text.replace(new RegExp(`{${param}}`, 'g'), value);
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

    // Keys merged into JE.pluginConfig from /private-config. Tracked so the
    // user-switch reset can strip them again: the endpoint is admin-gated, so
    // an admin's private config (arr instance URLs etc.) must not survive
    // into a non-admin's session.
    let privateConfigKeys = [];

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
     * Injects a maintenance banner at the top of the page.
     */
    function injectMaintenanceBanner(message) {
        if (document.getElementById('je-maintenance-banner')) return;
        const text = (message || '').trim() || 'This server is currently undergoing maintenance. Please try again later.';
        const banner = document.createElement('div');
        banner.id = 'je-maintenance-banner';
        banner.style.cssText = [
            'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:99999',
            'background:#b71c1c', 'color:#fff', 'text-align:center',
            'padding:10px 16px', 'font-size:14px', 'font-weight:600',
            'letter-spacing:0.02em', 'box-shadow:0 2px 8px rgba(0,0,0,0.4)',
            'font-family:inherit'
        ].join(';');
        banner.textContent = text;
        document.body.appendChild(banner);
        // Inject a stylesheet that shifts Jellyfin's fixed header + body down by the banner height.
        // We use a <style> tag so the rule applies even if Jellyfin re-renders its header.
        requestAnimationFrame(function() {
            const h = banner.offsetHeight;
            if (h <= 0) return;
            const existing = document.getElementById('je-maintenance-banner-style');
            if (existing) return;
            const style = document.createElement('style');
            style.id = 'je-maintenance-banner-style';
            style.textContent = [
                'body { padding-top: ' + h + 'px !important; }',
                '.skinHeader { top: ' + h + 'px !important; }',
                '.mainDrawer { top: ' + h + 'px !important; }',
                '.videoOsdBottom { bottom: 0 !important; }'
            ].join('\n');
            document.head.appendChild(style);
        });
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

        // Fetch the public config to check if login image / maintenance banner is needed
        ApiClient.ajax({
            type: 'GET',
            url: ApiClient.getUrl('/JellyfinEnhanced/public-config'),
            dataType: 'json'
        }).then((config) => {
            // Show maintenance banner for all users (admins can dismiss it mentally)
            if (config?.MaintenanceModeEnabled === true) {
                injectMaintenanceBanner(config.MaintenanceModeMessage);
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
    const MAX_MISMATCH_RETRIES = 100; // ~30s at 300ms intervals

    /**
     * Fetches the five per-user config files (settings, shortcuts, bookmark,
     * elsewhere, hidden-content) and assembles a fresh userConfig object.
     * Shared by first boot and by the user-switch re-bootstrap so both paths
     * build the object identically.
     * @param {string} userId - The user to load config for.
     * @returns {Promise<object>} A freshly-built userConfig object.
     */
    async function fetchUserScopedConfig(userId) {
        const fetchPromises = [
            ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl(`/JellyfinEnhanced/user-settings/${userId}/settings.json?_=${Date.now()}`), dataType: 'json' })
                     .then(data => ({ name: 'settings', status: 'fulfilled', value: data }))
                     .catch(e => ({ name: 'settings', status: 'rejected', reason: e })),
            ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl(`/JellyfinEnhanced/user-settings/${userId}/shortcuts.json?_=${Date.now()}`), dataType: 'json' })
                     .then(data => ({ name: 'shortcuts', status: 'fulfilled', value: data }))
                     .catch(e => ({ name: 'shortcuts', status: 'rejected', reason: e })),
            ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl(`/JellyfinEnhanced/user-settings/${userId}/bookmark.json?_=${Date.now()}`), dataType: 'json' })
                     .then(data => ({ name: 'bookmark', status: 'fulfilled', value: data }))
                     .catch(e => ({ name: 'bookmark', status: 'rejected', reason: e })),
            ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl(`/JellyfinEnhanced/user-settings/${userId}/elsewhere.json?_=${Date.now()}`), dataType: 'json' })
                     .then(data => ({ name: 'elsewhere', status: 'fulfilled', value: data }))
                     .catch(e => ({ name: 'elsewhere', status: 'rejected', reason: e })),
            ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl(`/JellyfinEnhanced/user-settings/${userId}/hidden-content.json?_=${Date.now()}`), dataType: 'json' })
                     .then(data => ({ name: 'hiddenContent', status: 'fulfilled', value: data }))
                     .catch(e => ({ name: 'hiddenContent', status: 'rejected', reason: e }))
        ];
        // Use allSettled to get results even if some fetches fail
        const results = await Promise.allSettled(fetchPromises);

        const userConfig = { settings: {}, shortcuts: { Shortcuts: [] }, bookmark: { bookmarks: {} }, elsewhere: {}, hiddenContent: { items: {}, settings: {} } };
        results.forEach(result => {
            if (result.status === 'fulfilled' && result.value) {
                const data = result.value;
                if (data.status === 'fulfilled' && data.value && typeof data.value === 'object') {
                    // *** CONVERT PASCALCASE TO CAMELCASE ***
                    if (data.name === 'settings' || data.name === 'bookmark' || data.name === 'hiddenContent') {
                        userConfig[data.name] = toCamelCase(data.value);
                    } else {
                        userConfig[data.name] = data.value;
                    }
                } else if (data.status === 'rejected') {
                    if (data.name === 'shortcuts') userConfig.shortcuts = { Shortcuts: [] };
                    else if (data.name === 'bookmark') userConfig.bookmark = { bookmarks: {} };
                    else if (data.name === 'elsewhere') userConfig.elsewhere = {};
                    else if (data.name === 'hiddenContent') userConfig.hiddenContent = { items: {}, settings: {} };
                    else userConfig[data.name] = {};
                } else {
                    if (data.name === 'shortcuts') userConfig.shortcuts = { Shortcuts: [] };
                    else if (data.name === 'bookmark') userConfig.bookmark = { bookmarks: {} };
                    else if (data.name === 'elsewhere') userConfig.elsewhere = {};
                    else if (data.name === 'hiddenContent') userConfig.hiddenContent = { items: {}, settings: {} };
                    else userConfig[data.name] = {};
                }
            } else {
                const name = result.value?.name || result.reason?.name || '';
                if (name === 'shortcuts') userConfig.shortcuts = { Shortcuts: [] };
                else if (name === 'bookmark') userConfig.bookmark = { bookmarks: {} };
                else if (name === 'elsewhere') userConfig.elsewhere = {};
                else if (name === 'hiddenContent') userConfig.hiddenContent = { items: {}, settings: {} };
                else if (name) userConfig[name] = {};
            }
        });
        return userConfig;
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
            JE.currentUser = null;
            JE.currentSettings = {};
            // Cleared (not merged over) so user A's extra shortcuts don't
            // survive into user B's session — initializeShortcuts() merges.
            JE.state.activeShortcuts = {};
            // Strip the admin-only private config; re-fetched (admins only)
            // during the re-bootstrap below.
            for (const key of privateConfigKeys) delete JE.pluginConfig[key];
            privateConfigKeys = [];
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
                    const userConfig = await fetchUserScopedConfig(userId);
                    if (!JE.session.isCurrent(epoch)) return; // stale result — drop it
                    JE.userConfig = userConfig;

                    // Refresh the cached full user object (admin checks etc.).
                    try {
                        const user = await ApiClient.getCurrentUser();
                        if (JE.session.isCurrent(epoch)) JE.currentUser = user;
                    } catch (_) { /* non-fatal — consumers null-check */ }
                    if (!JE.session.isCurrent(epoch)) return;

                    // Re-fetch the admin-only private config for the incoming
                    // user (the reset stripped the previous user's copy; the
                    // server rejects non-admins, leaving the keys absent).
                    await loadPrivateConfig();
                    if (!JE.session.isCurrent(epoch)) return;

                    JE.currentSettings = JE.loadSettings();
                    JE.initializeShortcuts();
                    seedDisplayLanguage(userId);

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
                    if (JE.currentSettings?.languageTagsEnabled && typeof JE.initializeLanguageTags === 'function') JE.initializeLanguageTags();

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
            setTimeout(initialize, 300);
            return;
        }

        // Normal retry logic (no mismatch)
        if (typeof ApiClient === 'undefined' || !ApiClient.getCurrentUserId?.()) {
            setTimeout(initialize, 300);
            return;
        }

        // Reset mismatch counter on success
        mismatchRetryCount = 0;

        try {
            // Stage 1: Load base configs and translations
            await loadTranslationsModule();
            const [[config, version], translations] = await Promise.all([
                loadPluginData(),
                loadTranslations() // Load translations first
            ]);

            JE.pluginConfig = config && typeof config === 'object' ? config : {};
            JE.pluginVersion = version || 'unknown';
            JE.translations = translations || {};
            JE.t = window.JellyfinEnhanced.t; // Ensure the real function is assigned
            await loadPrivateConfig();

            // Clear stale UseCustomTabs / UsePluginPages config flags when those
            // plugins are not installed.  Settings persist after uninstall, which
            // causes sidebar injection to be skipped even though the delivery
            // plugin is no longer present.
            try {
                const installedPlugins = await ApiClient.ajax({
                    type: 'GET', url: ApiClient.getUrl('/Plugins'), dataType: 'json'
                });
                if (!Array.isArray(installedPlugins)) throw new Error('Unexpected /Plugins response');
                const hasCustomTabs = installedPlugins.some(p => p.Name === 'Custom Tabs');
                const hasPluginPages = installedPlugins.some(p => p.Name === 'Plugin Pages');
                if (!hasCustomTabs) {
                    JE.pluginConfig.BookmarksUseCustomTabs = false;
                    JE.pluginConfig.CalendarUseCustomTabs = false;
                    JE.pluginConfig.HiddenContentUseCustomTabs = false;
                    JE.pluginConfig.DownloadsUseCustomTabs = false;
                }
                if (!hasPluginPages) {
                    JE.pluginConfig.BookmarksUsePluginPages = false;
                    JE.pluginConfig.HiddenContentUsePluginPages = false;
                    JE.pluginConfig.DownloadsUsePluginPages = false;
                    JE.pluginConfig.CalendarUsePluginPages = false;
                }
            } catch (e) {
                console.warn('🪼 Jellyfin Enhanced: Could not verify installed plugins:', e);
            }

            // Check if server has triggered a translation cache clear
            const serverTranslationClearTs = JE.pluginConfig.ClearTranslationCacheTimestamp || 0;
            const localTranslationClearTs = parseInt(localStorage.getItem('JE_translation_clear_ts') || '0', 10);
            if (serverTranslationClearTs > localTranslationClearTs) {
                console.log(`🪼 Jellyfin Enhanced: Server-triggered translation cache clear (${new Date(serverTranslationClearTs).toISOString()})`);
                for (let i = localStorage.length - 1; i >= 0; i--) {
                    const key = localStorage.key(i);
                    if (key && (key.startsWith('JE_translation_') || key.startsWith('JE_translation_ts_'))) {
                        localStorage.removeItem(key);
                    }
                }
                localStorage.setItem('JE_translation_clear_ts', serverTranslationClearTs.toString());
                // Reload translations with fresh data
                JE.translations = await loadTranslations() || {};
                JE.t = window.JellyfinEnhanced.t;
            }

            // Inject metadata icons CSS if enabled
            try {
                injectMetadataIcons(!!JE.pluginConfig?.MetadataIconsEnabled);
            } catch (e) {
                console.warn('🪼 Jellyfin Enhanced: Failed to inject Metadata icons CSS', e);
            }

            // Stage 2: Fetch user-specific settings
            let userId = ApiClient.getCurrentUserId();

            // Prefetch full user object once (needed for admin check in arr-links etc.)
            // Fire-and-forget alongside stage-2 network calls; result available as
            // JE.currentUser. Guarded so a resolution landing after a mid-boot user
            // switch can't overwrite the new user's object.
            ApiClient.getCurrentUser().then(u => {
                if (u?.Id === ApiClient.getCurrentUserId()) JE.currentUser = u;
            }).catch(() => {});

            JE.userConfig = await fetchUserScopedConfig(userId);

            // Initialize splash screen
            if (typeof JE.initializeSplashScreen === 'function') {
                JE.initializeSplashScreen();
            }

            // Stage 3: Load ALL component scripts
            const basePath = '/JellyfinEnhanced/js';
            const allComponentScripts = [
                // core — MUST load first: owns navigation detection, the
                // lifecycle registry, the shared body observer, the fetch
                // layer and base UI primitives that everything else builds on.
                'core/navigation.js',
                // session.js must load before every module that registers a
                // per-user reset handler (JE.session.onUserChange) at eval time.
                'core/session.js',
                'core/lifecycle.js',
                'core/dom-observer.js',
                'core/ui-kit.js',
                'core/api-client.js',
                'core/tag-renderer-base.js',

                // enhanced
                'enhanced/config.js',
                'enhanced/helpers.js',
                'enhanced/native-tabs.js',
                'tags/tag-pipeline.js',
                'enhanced/icons.js',
                // Spoiler Guard modules. Dependency order is maintained by hand —
                // nothing validates this array, and a module placed before one
                // whose exports it reads at load time binds `undefined` silently.
                // index.js publishes the public JE.spoilerBlur facade only after
                // every implementation piece.
                'enhanced/spoilerguard/ids.js',
                'enhanced/spoilerguard/state.js',
                'enhanced/spoilerguard/image-refresh.js',
                'enhanced/spoilerguard/snooze.js',
                'enhanced/spoilerguard/dialog.js',
                'enhanced/spoilerguard/identity.js',
                'enhanced/spoilerguard/styles.js',
                'enhanced/spoilerguard/settings-tab.js',
                'enhanced/spoilerguard/seerr-toggle.js',
                'enhanced/spoilerguard/detail-button.js',
                'enhanced/spoilerguard/watched-refresh.js',
                'enhanced/spoilerguard/index.js',
                // features modules — order matters: -details-media-info.js and
                // -release-dates.js publish the chip renderers that
                // -details-page.js consumes via JE.internals.features, and
                // -remove-home.js publishes the action-sheet/remove helpers
                // that -remove-multiselect.js consumes.
                'enhanced/features-random-button.js',
                'enhanced/itemdetails/features-details-media-info.js',
                'enhanced/itemdetails/features-release-dates.js',
                'enhanced/itemdetails/features-details-page.js',
                'enhanced/homeremoval/features-remove-home.js',
                'enhanced/homeremoval/features-remove-multiselect.js',
                'enhanced/events.js',
                'enhanced/player/playback.js',
                // hidden-content modules — order matters: -data.js owns the
                // store + lookup sets that the later files consume via
                // JE.internals.hiddenContent; -init.js exposes the frozen
                // JE.initializeHiddenContent / JE.hiddenContent surface last.
                'enhanced/hiddencontent/hidden-content-data.js',
                'enhanced/hiddencontent/hidden-content-save.js',
                'enhanced/hiddencontent/hidden-content-styles.js',
                'enhanced/hiddencontent/hidden-content-dialogs.js',
                'enhanced/hiddencontent/hidden-content-panel.js',
                'enhanced/hiddencontent/hidden-content-filter.js',
                'enhanced/hiddencontent/hidden-content-buttons.js',
                'enhanced/hiddencontent/hidden-content-init.js',
                // hidden-content-page modules — order matters: -state.js owns
                // the shared page state read by the later files via
                // JE.internals.hiddenContentPage; -init.js exposes the frozen
                // JE.hiddenContentPage / JE.initializeHiddenContentPage last.
                'enhanced/hiddencontent/hidden-content-page-state.js',
                'enhanced/hiddencontent/hidden-content-page-styles.js',
                'enhanced/hiddencontent/hidden-content-page-admin.js',
                'enhanced/hiddencontent/hidden-content-page-cards.js',
                'enhanced/hiddencontent/hidden-content-page-render.js',
                'enhanced/hiddencontent/hidden-content-page-nav.js',
                'enhanced/hiddencontent/hidden-content-page-init.js',
                'enhanced/hiddencontent/hidden-content-custom-tab.js',
                'enhanced/player/subtitles.js',
                'enhanced/themer.js',
                // ui modules — order matters: -release-notes.js publishes
                // GITHUB_REPO + the release-notes panel that the template and
                // settings wiring consume via JE.internals.enhancedUi;
                // ui-panel.js hosts JE.showEnhancedPanel and orchestrates the
                // buildPanelHtml/wire* pieces last.
                'enhanced/ui-styles.js',
                'enhanced/settingspanel/ui-entry-points.js',
                'enhanced/settingspanel/ui-release-notes.js',
                'enhanced/settingspanel/ui-panel-template.js',
                'enhanced/settingspanel/ui-panel-shortcut-editor.js',
                'enhanced/settingspanel/ui-panel-settings.js',
                'enhanced/settingspanel/ui-panel-hidden-content.js',
                'enhanced/settingspanel/ui-panel-language.js',
                'enhanced/settingspanel/ui-panel.js',
                'enhanced/bookmarks/bookmarks.js',
                // bookmarks-library modules — order matters: styles/page/render
                // publish JE.internals.bookmarksLibrary pieces that the later
                // files consume; -init.js boots last.
                'enhanced/bookmarks/bookmarks-library-styles.js',
                'enhanced/bookmarks/bookmarks-library-page.js',
                'enhanced/bookmarks/bookmarks-library-render.js',
                'enhanced/bookmarks/bookmarks-library-items.js',
                'enhanced/bookmarks/bookmarks-library-modals.js',
                'enhanced/bookmarks/bookmarks-library-replacements.js',
                'enhanced/bookmarks/bookmarks-library-init.js',
                'enhanced/player/osd-rating.js',
                'enhanced/player/pausescreen.js',

                // elsewhere
                'elsewhere/elsewhere.js',
                'elsewhere/reviews.js',

                // awards
                'awards/awards.js',

                // jellyseerr
                'jellyseerr/seerr-status.js',
                'jellyseerr/request-manager.js',
                'jellyseerr/api.js',
                'jellyseerr/jellyseerr.js',
                'jellyseerr/ui/ui-icons.js',
                'jellyseerr/ui/ui-styles.js',
                'jellyseerr/ui/ui-popover.js',
                'jellyseerr/ui/ui-badges.js',
                'jellyseerr/ui/ui-cards.js',
                'jellyseerr/ui/ui-buttons.js',
                'jellyseerr/ui/ui-quota.js',
                'jellyseerr/ui/ui-results.js',
                'jellyseerr/ui/ui-request-modals.js',
                'jellyseerr/ui/ui-season-modal.js',
                'jellyseerr/modal.js',
                'jellyseerr/moreinfo/more-info-modal-styles.js',
                'jellyseerr/moreinfo/more-info-modal-data.js',
                'jellyseerr/moreinfo/more-info-modal-seasons.js',
                'jellyseerr/moreinfo/more-info-modal-badges.js',
                'jellyseerr/moreinfo/more-info-modal-render.js',
                'jellyseerr/moreinfo/more-info-modal-actions-tv.js',
                'jellyseerr/moreinfo/more-info-modal-actions.js',
                'jellyseerr/moreinfo/more-info-modal-init.js',
                'jellyseerr/seerr-detail-link.js',
                'jellyseerr/hss-discovery-handler.js',
                'jellyseerr/item-details.js',
                'jellyseerr/issue-reporter.js',
                'jellyseerr/seamless-scroll.js',
                'jellyseerr/discovery/discovery-filter-utils.js',
                'jellyseerr/discovery/discovery-base.js',
                'jellyseerr/discovery/network-discovery.js',
                'jellyseerr/discovery/person-discovery.js',
                'jellyseerr/discovery/genre-discovery.js',
                'jellyseerr/discovery/tag-discovery.js',
                'jellyseerr/discovery/collection-discovery.js',
                'jellyseerr/recommendations/recommendations-styles.js',
                'jellyseerr/recommendations/recommendations-catalog.js',
                'jellyseerr/recommendations/recommendations-data.js',
                'jellyseerr/recommendations/recommendations-render.js',
                'jellyseerr/recommendations/recommendations-page.js',
                'jellyseerr/recommendations/recommendations-category.js',
                'jellyseerr/recommendations/recommendations-init.js',
                'jellyseerr/recommendations/recommendations-custom-tab.js',

                // tags
                'tags/genretags.js',
                'tags/languagetags.js',
                'tags/peopletags.js',
                'tags/qualitytags.js',
                'tags/ratingtags.js',
                'tags/userreviewtags.js',

                // arr
                'arr/arr-links.js',
                'arr/arr-tag-links.js',
                'arr/requests/requests-page-styles.js',
                'arr/requests/requests-page-data.js',
                'arr/requests/requests-page-render-helpers.js',
                'arr/requests/requests-page-render-cards.js',
                'arr/requests/requests-page-render.js',
                'arr/requests/requests-page-actions.js',
                'arr/requests/requests-page-init.js',
                'arr/calendar/calendar-page-styles.js',
                'arr/calendar/calendar-page-data.js',
                'arr/calendar/calendar-page-render-events.js',
                'arr/calendar/calendar-page-render-views.js',
                'arr/calendar/calendar-page-actions.js',
                'arr/calendar/calendar-page-init.js',
                'arr/requests/requests-custom-tab.js',
                'arr/calendar/calendar-custom-tab.js',

                // extras
                'extras/colored-activity-icons.js',
                'extras/colored-ratings.js',
                'extras/plugin-icons.js',
                'extras/theme-selector.js',
                'extras/active-streams.js',

                // others
                'others/letterboxd-links.js',
            ];
            await loadScripts(allComponentScripts, basePath);
            console.log('🪼 Jellyfin Enhanced: All component scripts loaded.');

            // Wire user-switch detection → global reset → re-bootstrap.
            // Must happen after loadScripts so JE.session exists.
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
                const recoveredConfig = await fetchUserScopedConfig(liveUserId);
                if (recoveryCurrent()) {
                    JE.userConfig = recoveredConfig;
                    // The stage-2 prefetch may have resolved BEFORE the
                    // switch, leaving the previous user's object (and admin
                    // flag) behind.
                    JE.currentUser = null;
                    try {
                        const liveUser = await ApiClient.getCurrentUser();
                        if (recoveryCurrent() && liveUser?.Id === ApiClient.getCurrentUserId()) JE.currentUser = liveUser;
                    } catch (_) { /* non-fatal — consumers null-check */ }
                    // Same for the admin-only private config fetched in stage 1.
                    for (const key of privateConfigKeys) delete JE.pluginConfig[key];
                    privateConfigKeys = [];
                    await loadPrivateConfig(); // internally epoch-guarded
                }
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

            // Stage 5: Initialize theme system first
            if (typeof JE.themer?.init === 'function') {
                JE.themer.init();
                console.log('🪼 Jellyfin Enhanced: Theme system initialized.');
            }

            // Register unified cache save on page unload
            window.addEventListener('beforeunload', () => {
                JE._cacheManager.forceSave();
            });

            // Stage 6: Initialize feature modules
            if (typeof JE.initializeEnhancedScript === 'function') JE.initializeEnhancedScript();
            if (typeof JE.initializeElsewhereScript === 'function' && JE.pluginConfig?.ElsewhereEnabled) JE.initializeElsewhereScript();
            if (typeof JE.initializeJellyseerrScript === 'function' && JE.pluginConfig?.JellyseerrEnabled && JE.pluginConfig?.JellyseerrShowSearchResults !== false) JE.initializeJellyseerrScript();
            if (typeof JE.jellyseerrIssueReporter?.initialize === 'function' && JE.pluginConfig?.JellyseerrEnabled && JE.pluginConfig?.JellyseerrShowReportButton) JE.jellyseerrIssueReporter.initialize();
            if (typeof JE.initializePauseScreen === 'function') JE.initializePauseScreen();
            if (typeof JE.initializeBookmarks === 'function') JE.initializeBookmarks();
            if (typeof JE.initializeQualityTags === 'function' && JE.currentSettings?.qualityTagsEnabled) JE.initializeQualityTags();
            if (typeof JE.initializeGenreTags === 'function' && JE.currentSettings?.genreTagsEnabled) JE.initializeGenreTags();
            if (typeof JE.initializeRatingTags === 'function' && JE.currentSettings?.ratingTagsEnabled) JE.initializeRatingTags();
            if (typeof JE.initializeUserReviewTags === 'function' && JE.pluginConfig?.ShowUserReviews && JE.pluginConfig?.ShowUserRatingOnPosters && JE.currentSettings?.ratingTagsEnabled) JE.initializeUserReviewTags();
            if (typeof JE.initializeArrLinksScript === 'function' && JE.pluginConfig?.ArrLinksEnabled) JE.initializeArrLinksScript();
            if (typeof JE.initializeArrTagLinksScript === 'function' && JE.pluginConfig?.ArrTagsShowAsLinks) JE.initializeArrTagLinksScript();
            if (typeof JE.initializeSeerrDetailLinkScript === 'function' && JE.pluginConfig?.JellyseerrEnabled && JE.pluginConfig?.JellyseerrShowDetailPageLink) JE.initializeSeerrDetailLinkScript();
            if (typeof JE.initializeLetterboxdLinksScript === 'function' && JE.pluginConfig?.LetterboxdEnabled) JE.initializeLetterboxdLinksScript();
            if (typeof JE.initializeReviewsScript === 'function' && (JE.pluginConfig?.ShowReviews || JE.pluginConfig?.ShowUserReviews)) JE.initializeReviewsScript();
            if (typeof JE.initializeAwardsScript === 'function' && JE.pluginConfig?.ShowAwards) JE.initializeAwardsScript();
            if (typeof JE.initializeLanguageTags === 'function' && JE.currentSettings?.languageTagsEnabled) JE.initializeLanguageTags();
            if (typeof JE.initializePeopleTags === 'function' && JE.currentSettings?.peopleTagsEnabled) JE.initializePeopleTags();
            // Initialize the unified tag pipeline AFTER all tag renderers have registered
            if (typeof JE.tagPipeline?.initialize === 'function') JE.tagPipeline.initialize();
            if (typeof JE.initializeOsdRating === 'function') JE.initializeOsdRating();
            // Skip hidden content initialization when feature is disabled server-wide — JE.hiddenContent stays undefined, safely disabling all downstream consumers
            if (typeof JE.initializeHiddenContent === 'function' && JE.pluginConfig?.HiddenContentEnabled) JE.initializeHiddenContent();
            // Spoiler Guard loads its per-user enabled-series list once at startup. The toggle button on series detail pages reads from that cache.
            if (JE.pluginConfig?.SpoilerBlurEnabled && typeof JE.spoilerBlur?.init === 'function') JE.spoilerBlur.init();

            if (JE.pluginConfig?.ColoredRatingsEnabled && typeof JE.initializeColoredRatings === 'function') {
                JE.initializeColoredRatings();
            }
            if (JE.pluginConfig?.ThemeSelectorEnabled && typeof JE.initializeThemeSelector === 'function') {
                JE.initializeThemeSelector();
            }
            if (JE.pluginConfig?.ColoredActivityIconsEnabled && typeof JE.initializeActivityIcons === 'function') {
                JE.initializeActivityIcons();
            }
            if (JE.pluginConfig?.PluginIconsEnabled && typeof JE.initializePluginIcons === 'function') {
                JE.initializePluginIcons();
            }
            if (JE.pluginConfig?.ActiveStreamsEnabled && typeof JE.activeStreams?.initialize === 'function') {
                JE.activeStreams.initialize();
            }
            if (JE.pluginConfig?.DownloadsPageEnabled && typeof JE.initializeDownloadsPage === 'function') {
                JE.initializeDownloadsPage();
            }
            if (JE.pluginConfig?.CalendarPageEnabled && typeof JE.initializeCalendarPage === 'function') {
                JE.initializeCalendarPage();
            }
            if (JE.pluginConfig?.HiddenContentEnabled && typeof JE.initializeHiddenContentPage === 'function') {
                JE.initializeHiddenContentPage();
            }

            console.log('🪼 Jellyfin Enhanced: All components initialized successfully.');

            // Programmatic boot-complete marker: every component script has executed
            // and every enabled initializeX() has run. Automation (E2E) waits on this
            // instead of racing individual JE.* properties that appear mid-boot.
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
