// /js/plugin.js
(function() {
    'use strict';

    // Create the global namespace immediately with placeholders
    window.JellyfinEnhanced = {
        pluginConfig: {},
        userConfig: { settings: {}, shortcuts: { Shortcuts: [] }, bookmarks: { Bookmarks: {} }, elsewhere: {}, hiddenContent: { items: {}, settings: {} }, spoilerMode: { rules: {}, settings: {}, tagAutoEnable: [], autoEnableOnFirstPlay: false } },
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
     * Loads the translation module and exposes JE.loadTranslations.
     * @returns {Promise<void>}
     */
    async function loadTranslationsModule() {
        if (typeof JE.loadTranslations === 'function') return;
        await new Promise((resolve) => {
            const script = document.createElement('script');
            script.src = ApiClient.getUrl(`/JellyfinEnhanced/js/enhanced/translations.js?v=${Date.now()}`);
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
     * Loads a single script dynamically.
     * @param {string} scriptName - Script filename.
     * @param {string} basePath - The base URL path for the script.
     * @returns {Promise<{status: string, script: string}>}
     */
    function loadScript(scriptName, basePath) {
        return new Promise((resolve) => {
            const script = document.createElement('script');
            script.src = ApiClient.getUrl(`${basePath}/${scriptName}?v=${Date.now()}`);
            script.onload = () => {
                resolve({ status: 'fulfilled', script: scriptName });
            };
            script.onerror = (e) => {
                console.error(`🪼 Jellyfin Enhanced: Failed to load script '${scriptName}'`, e);
                resolve({ status: 'rejected', script: scriptName, error: e });
            };
            document.head.appendChild(script);
        });
    }

    /**
     * Loads an array of scripts dynamically.
     * Scripts in ordered chains (e.g. spoiler-mode modules) are loaded
     * sequentially to guarantee execution order; all other scripts load
     * in parallel for speed.
     * @param {string[]} scripts - Array of script filenames.
     * @param {string} basePath - The base URL path for the scripts.
     * @returns {Promise<void>} - A promise that resolves when all scripts attempt to load.
     */
    async function loadScripts(scripts, basePath) {
        // Scripts that must execute in listed order (each depends on the previous)
        const orderedPrefixes = ['enhanced/spoiler-mode'];

        const parallel = [];
        const sequential = [];

        for (const scriptName of scripts) {
            if (orderedPrefixes.some(p => scriptName.startsWith(p))) {
                sequential.push(scriptName);
            } else {
                parallel.push(scriptName);
            }
        }

        // Load independent scripts in parallel
        const parallelPromise = Promise.allSettled(
            parallel.map(s => loadScript(s, basePath))
        );

        // Load ordered scripts sequentially
        for (const scriptName of sequential) {
            await loadScript(scriptName, basePath);
        }

        await parallelPromise;
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
                         .catch(e => ({ name: 'elsewhere', status: 'rejected', reason: e })),
                ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl(`/JellyfinEnhanced/user-settings/${userId}/hidden-content.json?_=${Date.now()}`), dataType: 'json' })
                         .then(data => ({ name: 'hiddenContent', status: 'fulfilled', value: data }))
                         .catch(e => ({ name: 'hiddenContent', status: 'rejected', reason: e })),
                ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl(`/JellyfinEnhanced/user-settings/${userId}/spoiler-mode.json?_=${Date.now()}`), dataType: 'json' })
                         .then(data => ({ name: 'spoilerMode', status: 'fulfilled', value: data }))
                         .catch(e => ({ name: 'spoilerMode', status: 'rejected', reason: e }))
            ];
            // Use allSettled to get results even if some fetches fail
            const results = await Promise.allSettled(fetchPromises);

            JE.userConfig = { settings: {}, shortcuts: { Shortcuts: [] }, bookmark: { bookmarks: {} }, elsewhere: {}, hiddenContent: { items: {}, settings: {} }, spoilerMode: { rules: {}, settings: {}, tagAutoEnable: [], autoEnableOnFirstPlay: false } };
            results.forEach(result => {
                if (result.status === 'fulfilled' && result.value) {
                    const data = result.value;
                    if (data.status === 'fulfilled' && data.value && typeof data.value === 'object') {
                        // *** CONVERT PASCALCASE TO CAMELCASE ***
                        if (data.name === 'settings' || data.name === 'bookmark' || data.name === 'hiddenContent' || data.name === 'spoilerMode') {
                            JE.userConfig[data.name] = toCamelCase(data.value);
                        } else {
                            JE.userConfig[data.name] = data.value;
                        }
                    } else if (data.status === 'rejected') {
                        if (data.name === 'shortcuts') JE.userConfig.shortcuts = { Shortcuts: [] };
                        else if (data.name === 'bookmark') JE.userConfig.bookmark = { bookmarks: {} };
                        else if (data.name === 'elsewhere') JE.userConfig.elsewhere = {};
                        else if (data.name === 'hiddenContent') JE.userConfig.hiddenContent = { items: {}, settings: {} };
                        else if (data.name === 'spoilerMode') JE.userConfig.spoilerMode = { rules: {}, settings: {}, tagAutoEnable: [], autoEnableOnFirstPlay: false };
                        else JE.userConfig[data.name] = {};
                    } else {
                        if (data.name === 'shortcuts') JE.userConfig.shortcuts = { Shortcuts: [] };
                        else if (data.name === 'bookmark') JE.userConfig.bookmark = { bookmarks: {} };
                        else if (data.name === 'elsewhere') JE.userConfig.elsewhere = {};
                        else if (data.name === 'hiddenContent') JE.userConfig.hiddenContent = { items: {}, settings: {} };
                        else if (data.name === 'spoilerMode') JE.userConfig.spoilerMode = { rules: {}, settings: {}, tagAutoEnable: [], autoEnableOnFirstPlay: false };
                        else JE.userConfig[data.name] = {};
                    }
                } else {
                    const name = result.value?.name || result.reason?.name || '';
                    if (name === 'shortcuts') JE.userConfig.shortcuts = { Shortcuts: [] };
                    else if (name === 'bookmark') JE.userConfig.bookmark = { bookmarks: {} };
                    else if (name === 'elsewhere') JE.userConfig.elsewhere = {};
                    else if (name === 'hiddenContent') JE.userConfig.hiddenContent = { items: {}, settings: {} };
                    else if (name === 'spoilerMode') JE.userConfig.spoilerMode = { rules: {}, settings: {}, tagAutoEnable: [], autoEnableOnFirstPlay: false };
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
                'enhanced/hidden-content.js',
                'enhanced/hidden-content-page.js',
                'enhanced/hidden-content-custom-tab.js',
                'enhanced/spoiler-mode.js',
                'enhanced/spoiler-mode-redaction.js',
                'enhanced/spoiler-mode-surfaces.js',
                'enhanced/spoiler-mode-observer.js',
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
                'jellyseerr/hss-discovery-handler.js',
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

            if (userId) {
                const languageKey = `${userId}-language`;
                const storedLanguage = localStorage.getItem(languageKey) || '';
                const desiredLanguage = (JE.currentSettings?.displayLanguage || '').trim();
                const normalizeLangCode = (code) => {
                    if (!code) return '';
                    const parts = code.split('-');
                    if (parts.length === 1) return parts[0].toLowerCase();
                    if (parts.length === 2) return `${parts[0].toLowerCase()}-${parts[1].toUpperCase()}`;
                    return code;
                };
                // Use the language code as-is, no special mapping
                const desiredStorageLanguage = desiredLanguage ? normalizeLangCode(desiredLanguage) : '';

                if (storedLanguage !== desiredStorageLanguage) {
                    localStorage.setItem(languageKey, desiredStorageLanguage);
                }
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
            // Skip hidden content initialization when feature is disabled server-wide — JE.hiddenContent stays undefined, safely disabling all downstream consumers
            if (typeof JE.initializeHiddenContent === 'function' && JE.pluginConfig?.HiddenContentEnabled) JE.initializeHiddenContent();
            // Skip spoiler mode initialization when feature is disabled server-wide — JE.spoilerMode stays undefined, safely disabling all downstream consumers
            if (typeof JE.initializeSpoilerMode === 'function' && JE.pluginConfig?.SpoilerModeEnabled !== false) JE.initializeSpoilerMode();

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
            if (JE.pluginConfig?.HiddenContentEnabled && typeof JE.initializeHiddenContentPage === 'function') {
                JE.initializeHiddenContentPage();
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
