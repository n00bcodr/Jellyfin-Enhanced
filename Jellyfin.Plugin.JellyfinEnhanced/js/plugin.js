// /js/plugin.js
(function() {
    'use strict';

    // Create the global namespace immediately with placeholders
    window.JellyfinEnhanced = {
        pluginConfig: {},
        userConfig: { settings: {}, shortcuts: { Shortcuts: [] }, bookmarks: { Bookmarks: {} }, elsewhere: {} },
        translations: {},
        pluginVersion: 'unknown',
        // Stub functions that will be overwritten by modules
        icon: (name) => {
            // Fallback icon function until icons.js loads
            // Returns the token unchanged so t() can keep the placeholder
            return name ? `{{ICON_PENDING:${name}}}` : '';
        },
        IconName: {}, // Will be replaced by icons.js
        state: {
            activeShortcuts: {},
            currentContextItemId: null,
            isContinueWatchingContext: false,
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
            link.href = 'https://cdn.jsdelivr.net/gh/Druidblack/jellyfin-icon-metadata/public-icon.css';
            document.head.appendChild(link);
        } else if (!enabled && existing) {
            existing.remove();
        }
    }

    /**
     * Loads the appropriate language file based on the user's settings.
     * Attempts to fetch from GitHub first (with caching), falls back to bundled translations.
     * @returns {Promise<object>} A promise that resolves to the translations object.
     */
    async function loadTranslations() {
        const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com/n00bcodr/Jellyfin-Enhanced/main/Jellyfin.Plugin.JellyfinEnhanced/js/locales';
        const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

        try {
            // Get plugin version first
            let pluginVersion = window.JellyfinEnhanced?.pluginVersion;
            if (!pluginVersion || pluginVersion === 'unknown') {
                // Fetch version if not loaded yet
                try {
                    const versionResponse = await fetch(ApiClient.getUrl('/JellyfinEnhanced/version'));
                    if (versionResponse.ok) {
                        pluginVersion = await versionResponse.text();
                        if (window.JellyfinEnhanced) {
                            window.JellyfinEnhanced.pluginVersion = pluginVersion;
                        }
                    }
                } catch (e) {
                    console.warn('🪼 Jellyfin Enhanced: Failed to fetch plugin version', e);
                    pluginVersion = 'unknown';
                }
            }

            // Wait briefly for ApiClient user to potentially become available
            let user = ApiClient.getCurrentUser ? ApiClient.getCurrentUser() : null;
            if (user instanceof Promise) {
                user = await user;
            }

            const userId = user?.Id;
            let lang = 'en'; // Default to English

            if (userId) {
                const storageKey = `${userId}-language`;
                const storedLang = localStorage.getItem(storageKey);
                if (storedLang) {
                    lang = storedLang.split('-')[0]; // Use base language code
                }
            }

            // Clean up old translation caches from previous versions
            try {
                for (let i = localStorage.length - 1; i >= 0; i--) {
                    const key = localStorage.key(i);
                    if (key && (key.startsWith('JE_translation_') || key.startsWith('JE_translation_ts_'))) {
                        // Remove if it doesn't match current version
                        if (!key.includes(`_${pluginVersion}`)) {
                            localStorage.removeItem(key);
                            console.log(`🪼 Jellyfin Enhanced: Removed old translation cache: ${key}`);
                        }
                    }
                }
            } catch (e) {
                console.warn('🪼 Jellyfin Enhanced: Failed to clean up old translation caches', e);
            }

            // Check if we have a cached version
            const cacheKey = `JE_translation_${lang}_${pluginVersion}`;
            const timestampKey = `JE_translation_ts_${lang}_${pluginVersion}`;
            const cachedTranslations = localStorage.getItem(cacheKey);
            const cachedTimestamp = localStorage.getItem(timestampKey);

            if (cachedTranslations && cachedTimestamp) {
                const age = Date.now() - parseInt(cachedTimestamp, 10);
                if (age < CACHE_DURATION) {
                    console.log(`🪼 Jellyfin Enhanced: Using cached translations for ${lang} (age: ${Math.round(age / 1000 / 60)} minutes, version: ${pluginVersion})`);
                    try {
                        return JSON.parse(cachedTranslations);
                    } catch (e) {
                        console.warn('🪼 Jellyfin Enhanced: Failed to parse cached translations, will fetch fresh', e);
                    }
                }
            }

            // Try fetching from bundled (local) first, then GitHub
            /* console.log(`🪼 Jellyfin Enhanced: Loading bundled translations for ${lang}...`);
            try {
                const bundledResponse = await fetch(ApiClient.getUrl(`/JellyfinEnhanced/locales/${lang}.json`));
                if (bundledResponse.ok) {
                    const translations = await bundledResponse.json();
                    // Cache the bundled version
                    try {
                        localStorage.setItem(cacheKey, JSON.stringify(translations));
                        localStorage.setItem(timestampKey, Date.now().toString());
                        console.log(`🪼 Jellyfin Enhanced: Successfully loaded and cached bundled translations for ${lang} (version: ${pluginVersion})`);
                    } catch (e) { } // do nothing
                    return translations;
                }
            } catch (bundledError) {
                console.warn(`🪼 Jellyfin Enhanced: Bundled translations failed, falling back to GitHub:`, bundledError.message);
            } */

            // Fallback to GitHub if bundled fails
            try {
                console.log(`🪼 Jellyfin Enhanced: Fetching translations for ${lang} from GitHub...`);
                const githubResponse = await fetch(`${GITHUB_RAW_BASE}/${lang}.json`, {
                    method: 'GET',
                    cache: 'no-cache', // We manage our own cache
                    headers: {
                        'Accept': 'application/json'
                    }
                });

                if (githubResponse.ok) {
                    const translations = await githubResponse.json();

                    // Cache the successful fetch
                    try {
                        localStorage.setItem(cacheKey, JSON.stringify(translations));
                        localStorage.setItem(timestampKey, Date.now().toString());
                        console.log(`🪼 Jellyfin Enhanced: Successfully fetched and cached translations for ${lang} from GitHub (version: ${pluginVersion})`);
                    } catch (storageError) {
                        console.warn('🪼 Jellyfin Enhanced: Failed to cache translations (localStorage full?)', storageError);
                    }

                    return translations;
                }

                // If GitHub fetch failed with 404, might be a language that doesn't exist
                if (githubResponse.status === 404 && lang !== 'en') {
                    console.warn(`🪼 Jellyfin Enhanced: Language ${lang} not found on GitHub, falling back to English`);
                    // Recursively try English from GitHub
                    const englishResponse = await fetch(`${GITHUB_RAW_BASE}/en.json`, {
                        method: 'GET',
                        cache: 'no-cache',
                        headers: { 'Accept': 'application/json' }
                    });

                    if (englishResponse.ok) {
                        const translations = await englishResponse.json();
                        try {
                            const enCacheKey = `JE_translation_en_${pluginVersion}`;
                            const enTimestampKey = `JE_translation_ts_en_${pluginVersion}`;
                            localStorage.setItem(enCacheKey, JSON.stringify(translations));
                            localStorage.setItem(enTimestampKey, Date.now().toString());
                        } catch (e) { /* ignore */ }
                        return translations;
                    }
                }

                // If rate limited (403) or server error (5xx), throw to trigger bundled fallback
                if (githubResponse.status === 403) {
                    console.warn('🪼 Jellyfin Enhanced: GitHub rate limit detected, using bundled fallback');
                } else if (githubResponse.status >= 500) {
                    console.warn(`🪼 Jellyfin Enhanced: GitHub server error (${githubResponse.status}), using bundled fallback`);
                }

                throw new Error(`GitHub fetch failed with status ${githubResponse.status}`);
            } catch (githubError) {
                console.warn('🪼 Jellyfin Enhanced: GitHub fetch failed, falling back to bundled translations:', githubError.message);
            }

            // Fallback to bundled translations served by the plugin
            console.log(`🪼 Jellyfin Enhanced: Loading bundled translations for ${lang}...`);
            let response = await fetch(ApiClient.getUrl(`/JellyfinEnhanced/locales/${lang}.json`));

            if (response.ok) {
                const translations = await response.json();
                // Cache the bundled version too
                try {
                    localStorage.setItem(cacheKey, JSON.stringify(translations));
                    localStorage.setItem(timestampKey, Date.now().toString());
                } catch (e) { /* ignore */ }
                return translations;
            } else {
                // Last resort: English bundled
                console.warn(`🪼 Jellyfin Enhanced: Bundled ${lang} not found, falling back to bundled English`);
                response = await fetch(ApiClient.getUrl('/JellyfinEnhanced/locales/en.json'));
                if (response.ok) {
                    return await response.json();
                } else {
                    throw new Error("Failed to load English fallback translations");
                }
            }
        } catch (error) {
            console.error('🪼 Jellyfin Enhanced: Failed to load translations:', error);
            return {}; // Return empty object on catastrophic failure
        }
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
     * Fetches sensitive configuration from the authenticated endpoint.
     * @returns {Promise<void>}
     */
    async function loadPrivateConfig() {
        try {
            const privateConfig = await ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl('/JellyfinEnhanced/private-config'),
                dataType: 'json'
            });
            // Merge the sensitive keys into the main config object
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
                script.src = ApiClient.getUrl(`${basePath}/${scriptName}?v=${Date.now()}`); // Cache-busting
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
        splashScript.src = ApiClient.getUrl('/JellyfinEnhanced/js/others/splashscreen.js?v=' + Date.now());
        splashScript.onload = () => {
            if (typeof JE.initializeSplashScreen === 'function') {
                JE.initializeSplashScreen(); // Initialize if available
            }
        };
         splashScript.onerror = () => console.error('🪼 Jellyfin Enhanced: Failed to load splash screen script.');
        document.head.appendChild(splashScript);
    }

    /**
     * Loads the login image script early (checks config first).
     */
    function loadLoginImageEarly() {
        if (typeof ApiClient === 'undefined') {
            setTimeout(loadLoginImageEarly, 50);
            return;
        }

        // Fetch the public config to check if login image is enabled
        ApiClient.ajax({
            type: 'GET',
            url: ApiClient.getUrl('/JellyfinEnhanced/public-config'),
            dataType: 'json'
        }).then((config) => {
            // Only load if enabled (default to false)
            if (config?.EnableLoginImage === true) {
                const loginImageScript = document.createElement('script');
                loginImageScript.src = ApiClient.getUrl('/JellyfinEnhanced/js/extras/login-image.js?v=' + Date.now());
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
            const [[config, version], translations] = await Promise.all([
                loadPluginData(),
                loadTranslations() // Load translations first
            ]);

            JE.pluginConfig = config && typeof config === 'object' ? config : {};
            JE.pluginVersion = version || 'unknown';
            JE.translations = translations || {};
            JE.t = window.JellyfinEnhanced.t; // Ensure the real function is assigned
            await loadPrivateConfig();

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
            const userId = ApiClient.getCurrentUserId();

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
                         .catch(e => ({ name: 'elsewhere', status: 'rejected', reason: e }))
            ];
            // Use allSettled to get results even if some fetches fail
            const results = await Promise.allSettled(fetchPromises);

            JE.userConfig = { settings: {}, shortcuts: { Shortcuts: [] }, bookmark: { bookmarks: {} }, elsewhere: {} };
            results.forEach(result => {
                if (result.status === 'fulfilled' && result.value) {
                    const data = result.value;
                    if (data.status === 'fulfilled' && data.value && typeof data.value === 'object') {
                        // *** CONVERT PASCALCASE TO CAMELCASE ***
                        if (data.name === 'settings' || data.name === 'bookmark') {
                            JE.userConfig[data.name] = toCamelCase(data.value);
                        } else {
                            JE.userConfig[data.name] = data.value;
                        }
                    } else if (data.status === 'rejected') {
                        if (data.name === 'shortcuts') JE.userConfig.shortcuts = { Shortcuts: [] };
                        else if (data.name === 'bookmark') JE.userConfig.bookmark = { bookmarks: {} };
                        else if (data.name === 'elsewhere') JE.userConfig.elsewhere = {};
                        else JE.userConfig[data.name] = {};
                    } else {
                        if (data.name === 'shortcuts') JE.userConfig.shortcuts = { Shortcuts: [] };
                        else if (data.name === 'bookmark') JE.userConfig.bookmark = { bookmarks: {} };
                        else if (data.name === 'elsewhere') JE.userConfig.elsewhere = {};
                        else JE.userConfig[data.name] = {};
                    }
                } else {
                    const name = result.value?.name || result.reason?.name || '';
                    if (name === 'shortcuts') JE.userConfig.shortcuts = { Shortcuts: [] };
                    else if (name === 'bookmark') JE.userConfig.bookmark = { bookmarks: {} };
                    else if (name === 'elsewhere') JE.userConfig.elsewhere = {};
                    else if (name) JE.userConfig[name] = {};
                }
            });


            // Initialize splash screen
            if (typeof JE.initializeSplashScreen === 'function') {
                JE.initializeSplashScreen();
            }

            // Stage 3: Load ALL component scripts
            const basePath = '/JellyfinEnhanced/js';
            const allComponentScripts = [
                // enhanced
                'enhanced/config.js',
                'enhanced/helpers.js',
                'enhanced/icons.js',
                'enhanced/features.js',
                'enhanced/events.js',
                'enhanced/playback.js',
                'enhanced/subtitles.js',
                'enhanced/themer.js',
                'enhanced/ui.js',
                'enhanced/bookmarks.js',
                'enhanced/bookmarks-library.js',
                'enhanced/osd-rating.js',
                'enhanced/pausescreen.js',

                // elsewhere
                'elsewhere/elsewhere.js',
                'elsewhere/reviews.js',

                // jellyseerr
                'jellyseerr/api.js',
                'jellyseerr/jellyseerr.js',
                'jellyseerr/request-manager.js',
                'jellyseerr/ui.js',
                'jellyseerr/modal.js',
                'jellyseerr/more-info-modal.js',
                'jellyseerr/item-details.js',
                'jellyseerr/issue-reporter.js',
                'jellyseerr/seamless-scroll.js',
                'jellyseerr/discovery-filter-utils.js',
                'jellyseerr/network-discovery.js',
                'jellyseerr/person-discovery.js',
                'jellyseerr/genre-discovery.js',
                'jellyseerr/tag-discovery.js',

                // tags
                'tags/genretags.js',
                'tags/languagetags.js',
                'tags/peopletags.js',
                'tags/qualitytags.js',
                'tags/ratingtags.js',

                // arr
                'arr/arr-links.js',
                'arr/arr-tag-links.js',
                'arr/requests-page.js',
                'arr/calendar-page.js',
                'arr/requests-custom-tab.js',
                'arr/calendar-custom-tab.js',

                // extras
                'extras/colored-activity-icons.js',
                'extras/colored-ratings.js',
                'extras/plugin-icons.js',
                'extras/theme-selector.js',

                // others
                'others/letterboxd-links.js',
            ];
            await loadScripts(allComponentScripts, basePath);
            console.log('🪼 Jellyfin Enhanced: All component scripts loaded.');

            // Stage 4: Initialize core settings/shortcuts using potentially defined functions
            if (typeof JE.loadSettings === 'function' && typeof JE.initializeShortcuts === 'function') {
                JE.currentSettings = JE.loadSettings(); // This happens AFTER config.js is loaded
                JE.initializeShortcuts();
                // console.log('🪼 Jellyfin Enhanced: Settings MERGED post-load:', JSON.stringify(JE.currentSettings));
                // console.log('🪼 Jellyfin Enhanced: Shortcuts MERGED post-load:', JSON.stringify(JE.state?.activeShortcuts || {}));
            } else {
                 console.error("🪼 Jellyfin Enhanced: FATAL - config.js functions not defined after script loading.");
                 if (typeof JE.hideSplashScreen === 'function') JE.hideSplashScreen();
                 return;
            }

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
            if (typeof JE.initializeJellyseerrScript === 'function' && JE.pluginConfig?.JellyseerrEnabled) JE.initializeJellyseerrScript();
            if (typeof JE.jellyseerrIssueReporter?.initialize === 'function' && JE.pluginConfig?.JellyseerrEnabled) JE.jellyseerrIssueReporter.initialize();
            if (typeof JE.initializePauseScreen === 'function') JE.initializePauseScreen();
            if (typeof JE.initializeBookmarks === 'function') JE.initializeBookmarks();
            if (typeof JE.initializeQualityTags === 'function' && JE.currentSettings?.qualityTagsEnabled) JE.initializeQualityTags();
            if (typeof JE.initializeGenreTags === 'function' && JE.currentSettings?.genreTagsEnabled) JE.initializeGenreTags();
            if (typeof JE.initializeRatingTags === 'function' && JE.currentSettings?.ratingTagsEnabled) JE.initializeRatingTags();
            if (typeof JE.initializeArrLinksScript === 'function' && JE.pluginConfig?.ArrLinksEnabled) JE.initializeArrLinksScript();
            if (typeof JE.initializeArrTagLinksScript === 'function' && JE.pluginConfig?.ArrTagsShowAsLinks) JE.initializeArrTagLinksScript();
            if (typeof JE.initializeLetterboxdLinksScript === 'function' && JE.pluginConfig?.LetterboxdEnabled) JE.initializeLetterboxdLinksScript();
            if (typeof JE.initializeReviewsScript === 'function' && JE.pluginConfig?.ShowReviews) JE.initializeReviewsScript();
            if (typeof JE.initializeLanguageTags === 'function' && JE.currentSettings?.languageTagsEnabled) JE.initializeLanguageTags();
            if (typeof JE.initializePeopleTags === 'function' && JE.currentSettings?.peopleTagsEnabled) JE.initializePeopleTags();
            if (typeof JE.initializeOsdRating === 'function') JE.initializeOsdRating();

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
            if (JE.pluginConfig?.DownloadsPageEnabled && typeof JE.initializeDownloadsPage === 'function') {
                JE.initializeDownloadsPage();
            }
            if (JE.pluginConfig?.CalendarPageEnabled && typeof JE.initializeCalendarPage === 'function') {
                JE.initializeCalendarPage();
            }

            console.log('🪼 Jellyfin Enhanced: All components initialized successfully.');

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
