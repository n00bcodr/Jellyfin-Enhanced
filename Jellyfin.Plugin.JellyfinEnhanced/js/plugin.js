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
     * Clears the UseCustomTabs / UsePluginPages config flags when the delivery
     * plugin they depend on is not installed. Settings persist after uninstall,
     * which would otherwise make sidebar injection skip even though the
     * delivery plugin is no longer present.
     * @param {boolean} hasCustomTabs - Whether the "Custom Tabs" plugin is installed.
     * @param {boolean} hasPluginPages - Whether the "Plugin Pages" plugin is installed.
     */
    function applyDeliveryPluginFlags(hasCustomTabs, hasPluginPages) {
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
            applyDeliveryPluginFlags(
                installedPlugins.some(p => p.Name === 'Custom Tabs'),
                installedPlugins.some(p => p.Name === 'Plugin Pages')
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

    // Module-runner pacing. Evaluating the 150+ component modules costs ~100 ms
    // of main thread; done as one task, or even as slices competing on equal
    // terms, it lands exactly while jellyfin-web renders its first view and
    // delays it by that much. So each slice runs in idle time (BUNDLE_IDLE_TIMEOUT_MS
    // caps the wait) and is kept short (BUNDLE_RUN_BUDGET_MS) so a task that
    // becomes pending mid-slice — a chunk arriving on a cold load — waits only
    // a few milliseconds.
    const BUNDLE_RUN_BUDGET_MS = 10;
    const BUNDLE_IDLE_TIMEOUT_MS = 100;

    /**
     * Runs the bundle's module functions in manifest order, in short slices
     * scheduled in the browser's idle time (see the pacing notes above). A
     * module that throws at its top level is logged and rethrown asynchronously
     * (so it still surfaces as an uncaught error, exactly like a throwing
     * <script> did) and the run continues with the next module — nothing after
     * it is lost, and it is not re-run. window.__JE_BUNDLE_PROGRESS counts the
     * modules run.
     * @param {Function[]} modules - `window.__JE_BUNDLE_MODULES` from the bundle.
     * @param {unknown} fromBootstrap - `ComponentScripts` from the bootstrap payload (for error messages).
     * @returns {Promise<void>}
     */
    async function runBundleModules(modules, fromBootstrap) {
        const names = filterComponentManifest(fromBootstrap) || [];
        let deadline = await waitForIdle(BUNDLE_IDLE_TIMEOUT_MS);
        let sliceStart = performance.now();
        for (let i = 0; i < modules.length; i++) {
            try {
                modules[i]();
            } catch (e) {
                console.error(`🪼 Jellyfin Enhanced: Module '${names[i] || `#${i + 1}`}' threw while loading; continuing with the next module.`, e);
                setTimeout(() => { throw e; }, 0);
            }
            window.__JE_BUNDLE_PROGRESS = i + 1;
            if (i + 1 >= modules.length) break;
            // End the slice when its budget is spent or the idle period is over.
            // A callback that ran because the timeout expired reports no idle
            // time at all; it gets the full budget so progress is guaranteed.
            const budgetSpent = performance.now() - sliceStart >= BUNDLE_RUN_BUDGET_MS;
            const idleOver = !!deadline && !deadline.didTimeout && deadline.timeRemaining() < 1;
            if (budgetSpent || idleOver) {
                deadline = await waitForIdle(BUNDLE_IDLE_TIMEOUT_MS);
                sliceStart = performance.now();
            }
        }
    }

    /**
     * Loads every component module from the server-side bundle (one request
     * instead of one <script> per module): the bundle defines one function per
     * module in window.__JE_BUNDLE_MODULES, which runBundleModules executes in
     * order. Falls back to the per-file loader for every module when the
     * request fails or nothing was defined (a syntax error aborts the whole
     * script before it defines anything), so only the broken file fails,
     * exactly as before the bundle existed.
     * @param {unknown} fromBootstrap - `ComponentScripts` from the bootstrap payload, if any.
     * @returns {Promise<void>}
     */
    async function loadComponentBundle(fromBootstrap) {
        const url = getComponentBundleUrl();
        // -1 = nothing executed; the bundle's prologue sets 0.
        window.__JE_BUNDLE_PROGRESS = -1;
        window.__JE_BUNDLE_MODULES = undefined;
        // Fetch and parse the bundle only once jellyfin-web is idle, and at low
        // fetch priority. Measured alternatives: an early <link rel="preload">
        // (even at low priority) made jellyfin-web's first content ~200-300 ms
        // later on a cold 20 Mbps load because the 800 KB download shares
        // bandwidth with its own chunks, and inserting the script right away
        // put its 2.8 MB pre-parse in front of the first view's rendering.
        await waitForIdle(BUNDLE_IDLE_TIMEOUT_MS);
        const requestOk = await new Promise((resolve) => {
            const script = document.createElement('script');
            script.src = url;
            script.setAttribute('fetchpriority', 'low');
            script.onload = () => resolve(true);
            script.onerror = () => resolve(false);
            document.head.appendChild(script);
        });
        const modules = window.__JE_BUNDLE_MODULES;
        const total = window.__JE_BUNDLE_TOTAL;
        delete window.__JE_BUNDLE_MODULES; // the functions are only needed once
        if (requestOk && Array.isArray(modules) && modules.length > 0 && modules.length === total) {
            await runBundleModules(modules, fromBootstrap);
            return;
        }

        const scripts = await getComponentScriptList(fromBootstrap);
        if (!requestOk) {
            console.warn('🪼 Jellyfin Enhanced: Component bundle request failed — loading the component scripts individually.');
        } else {
            console.warn('🪼 Jellyfin Enhanced: Component bundle did not define its modules (syntax error?) — loading the component scripts individually.');
        }
        await loadScripts(scripts, COMPONENT_SCRIPTS_BASE_PATH);
    }

    /**
     * Stage-3 entry point: loads all component modules, in manifest order.
     * Dev mode loads the individual files (debuggable one by one, no-store);
     * production loads the bundle with per-file fallback.
     * @param {unknown} fromBootstrap - `ComponentScripts` from the bootstrap payload, if any.
     * @returns {Promise<void>}
     */
    async function loadComponentScripts(fromBootstrap) {
        if (isDevMode()) {
            const scripts = await getComponentScriptList(fromBootstrap);
            await loadScripts(scripts, COMPONENT_SCRIPTS_BASE_PATH);
            return;
        }
        await loadComponentBundle(fromBootstrap);
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
            'padding:10px 16px', 'font-size:14px', 'font-weight:600',
            'letter-spacing:0.02em', 'box-shadow:0 2px 8px rgba(0,0,0,0.4)',
            'font-family:inherit'
        ].join(';');
        banner.textContent = text;
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
            banner.textContent = formatMaintenanceText(message, endsAt);
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

    /**
     * Assembles a fresh userConfig object from the five per-user documents.
     * A document that is missing or failed to load (null/undefined/non-object)
     * keeps its default; settings, bookmark and hidden-content are converted
     * from PascalCase to camelCase. Shared by the per-endpoint loader and the
     * bootstrap payload so both build the object identically.
     * @param {object} documents - Map of document name (settings, shortcuts,
     *   bookmark, elsewhere, hiddenContent) to its parsed JSON, or null.
     * @returns {object} A freshly-built userConfig object.
     */
    function buildUserConfig(documents) {
        const userConfig = { settings: {}, shortcuts: { Shortcuts: [] }, bookmark: { bookmarks: {} }, elsewhere: {}, hiddenContent: { items: {}, settings: {} } };
        for (const name of Object.keys(USER_CONFIG_DOCUMENTS)) {
            const value = documents ? documents[name] : null;
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
     * block (the same five documents the standalone endpoints return).
     * @param {object} userSettings - `UserSettings` from the bootstrap payload.
     * @returns {object} A freshly-built userConfig object.
     */
    function buildUserConfigFromBootstrap(userSettings) {
        const docs = userSettings && typeof userSettings === 'object' ? userSettings : {};
        return buildUserConfig({
            settings: docs.Settings,
            shortcuts: docs.Shortcuts,
            bookmark: docs.Bookmark,
            elsewhere: docs.Elsewhere,
            hiddenContent: docs.HiddenContent
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
     * Loads the signed-in user's scoped data — the userConfig documents and the
     * admin-only private config — and applies both to the globals. One bootstrap
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
            applyPrivateConfig(bootstrap.PrivateConfig);
            return true;
        }
        const userConfig = await fetchUserScopedConfig(userId);
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

            // Stage 3: Load ALL component scripts. The ordered list lives in
            // js/component-scripts.json (see CONTRIBUTING.md); production loads
            // them as one server-side bundle, dev mode as individual files.
            // Modules read JE.pluginConfig / JE.userConfig at eval time, so this
            // must stay after the config is applied.
            await loadComponentScripts(bootstrap ? bootstrap.ComponentScripts : null);
            console.log('🪼 Jellyfin Enhanced: All component scripts loaded.');

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
            if (typeof JE.initializePluginRevisions === 'function') JE.initializePluginRevisions();
            if (typeof JE.initializeEnhancedScript === 'function') JE.initializeEnhancedScript();
            if (typeof JE.initializeElsewhereScript === 'function' && JE.pluginConfig?.ElsewhereEnabled) JE.initializeElsewhereScript();
            if (typeof JE.initializeJellyseerrScript === 'function' && JE.pluginConfig?.JellyseerrEnabled && JE.pluginConfig?.JellyseerrShowSearchResults !== false) JE.initializeJellyseerrScript();
            if (typeof JE.jellyseerrIssueReporter?.initialize === 'function' && JE.pluginConfig?.JellyseerrEnabled && JE.pluginConfig?.JellyseerrShowReportButton) JE.jellyseerrIssueReporter.initialize();
            if (typeof JE.initializePauseScreen === 'function') JE.initializePauseScreen();
            if (typeof JE.initializeBookmarks === 'function') JE.initializeBookmarks();
            if (typeof JE.initializeQualityTags === 'function' && JE.currentSettings?.qualityTagsEnabled) JE.initializeQualityTags();
            if (typeof JE.initializeGenreTags === 'function' && JE.currentSettings?.genreTagsEnabled) JE.initializeGenreTags();
            if (typeof JE.initializeRatingTags === 'function' && JE.currentSettings?.ratingTagsEnabled) JE.initializeRatingTags();
            if (typeof JE.initializeAgeRatingTags === 'function' && JE.currentSettings?.ageRatingTagsEnabled) JE.initializeAgeRatingTags();
            if (typeof JE.initializeUserReviewTags === 'function' && JE.pluginConfig?.ShowUserReviews && JE.pluginConfig?.ShowUserRatingOnPosters && JE.currentSettings?.ratingTagsEnabled) JE.initializeUserReviewTags();
            if (typeof JE.initializeArrLinksScript === 'function' && JE.pluginConfig?.ArrLinksEnabled) JE.initializeArrLinksScript();
            if (typeof JE.initializeArrTagLinksScript === 'function' && JE.pluginConfig?.ArrTagsShowAsLinks) JE.initializeArrTagLinksScript();
            if (typeof JE.initializeSeerrDetailLinkScript === 'function' && JE.pluginConfig?.JellyseerrEnabled && JE.pluginConfig?.JellyseerrShowDetailPageLink) JE.initializeSeerrDetailLinkScript();
            if (typeof JE.initializeLetterboxdLinksScript === 'function' && JE.pluginConfig?.LetterboxdEnabled) JE.initializeLetterboxdLinksScript();
            if (typeof JE.initializeReviewsScript === 'function' && (JE.pluginConfig?.ShowReviews || JE.pluginConfig?.ShowUserReviews)) JE.initializeReviewsScript();
            if (typeof JE.initializeAwardsScript === 'function' && JE.pluginConfig?.ShowAwards) JE.initializeAwardsScript();
            if (typeof JE.initializeMdblistRatingsScript === 'function' && JE.pluginConfig?.MdblistRatingsEnabled && JE.pluginConfig?.MdblistRatingsShowOnItemDetails) JE.initializeMdblistRatingsScript();
            if (typeof JE.initializeLanguageTags === 'function' && JE.currentSettings?.languageTagsEnabled) JE.initializeLanguageTags();
            if (typeof JE.initializePeopleTags === 'function' && JE.currentSettings?.peopleTagsEnabled) JE.initializePeopleTags();
            // Initialize the unified tag pipeline AFTER all tag renderers have registered
            if (typeof JE.tagPipeline?.initialize === 'function') JE.tagPipeline.initialize();
            if (typeof JE.initializeOsdRating === 'function') JE.initializeOsdRating();
            if (typeof JE.initializePlaybackRatingBadge === 'function' && JE.pluginConfig?.ShowPlaybackRatingBadge) JE.initializePlaybackRatingBadge();
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
