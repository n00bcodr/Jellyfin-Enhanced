// /js/plugin.js
(function() {
    'use strict';

    // Create the global namespace immediately with placeholders
    window.JellyfinEnhanced = {
        pluginConfig: {},
        userConfig: { settings: {}, shortcuts: { Shortcuts: [] }, bookmarks: { Bookmarks: {} }, elsewhere: {} },
        translations: {},
        pluginVersion: 'unknown',
        state: {
            activeShortcuts: {},
            currentContextItemId: null,
            isContinueWatchingContext: false,
            skipToastShown: false,
            pauseScreenClickTimer: null
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

    /**
     * Loads the appropriate language file based on the user's settings.
     * @returns {Promise<object>} A promise that resolves to the translations object.
     */
    async function loadTranslations() {
        try {
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

            let response = await fetch(ApiClient.getUrl(`/JellyfinEnhanced/locales/${lang}.json`));

            if (response.ok) {
                return await response.json();
            } else {
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
        splashScript.src = ApiClient.getUrl('/JellyfinEnhanced/js/splashscreen.js?v=' + Date.now());
        splashScript.onload = () => {
            if (typeof JE.initializeSplashScreen === 'function') {
                JE.initializeSplashScreen(); // Initialize if available
            }
        };
         splashScript.onerror = () => console.error('🪼 Jellyfin Enhanced: Failed to load splash screen script.');
        document.head.appendChild(splashScript);
    }

    /**
     * Main initialization function.
     */
    async function initialize() {
        // Ensure ApiClient exists and user is logged in
        if (typeof ApiClient === 'undefined' || !ApiClient.getCurrentUserId?.()) {
            setTimeout(initialize, 300); // Increased retry delay slightly
            return;
        }

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

            // Stage 2: Fetch user-specific settings
            const userId = ApiClient.getCurrentUserId();

            const fetchPromises = [
                ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl(`/JellyfinEnhanced/user-settings/${userId}/settings.json`), dataType: 'json' })
                         .then(data => ({ name: 'settings', status: 'fulfilled', value: data }))
                         .catch(e => ({ name: 'settings', status: 'rejected', reason: e })),
                ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl(`/JellyfinEnhanced/user-settings/${userId}/shortcuts.json`), dataType: 'json' })
                         .then(data => ({ name: 'shortcuts', status: 'fulfilled', value: data }))
                         .catch(e => ({ name: 'shortcuts', status: 'rejected', reason: e })),
                ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl(`/JellyfinEnhanced/user-settings/${userId}/bookmarks.json`), dataType: 'json' })
                         .then(data => ({ name: 'bookmarks', status: 'fulfilled', value: data }))
                         .catch(e => ({ name: 'bookmarks', status: 'rejected', reason: e })),
                ApiClient.ajax({ type: 'GET', url: ApiClient.getUrl(`/JellyfinEnhanced/user-settings/${userId}/elsewhere.json`), dataType: 'json' })
                         .then(data => ({ name: 'elsewhere', status: 'fulfilled', value: data }))
                         .catch(e => ({ name: 'elsewhere', status: 'rejected', reason: e }))
            ];
            // Use allSettled to get results even if some fetches fail
            const results = await Promise.allSettled(fetchPromises);

            JE.userConfig = { settings: {}, shortcuts: { Shortcuts: [] }, bookmarks: { Bookmarks: {} }, elsewhere: {} };
            results.forEach(result => {
                if (result.status === 'fulfilled' && result.value) {
                    const data = result.value;
                    if (data.status === 'fulfilled' && data.value && typeof data.value === 'object') {
                        // *** CONVERT PASCALCASE TO CAMELCASE ***
                        if (data.name === 'settings') {
                            JE.userConfig[data.name] = toCamelCase(data.value);
                        } else {
                            JE.userConfig[data.name] = data.value;
                        }
                    } else if (data.status === 'rejected') {
                        if (data.name === 'shortcuts') JE.userConfig.shortcuts = { Shortcuts: [] };
                        else if (data.name === 'bookmarks') JE.userConfig.bookmarks = { Bookmarks: {} };
                        else if (data.name === 'elsewhere') JE.userConfig.elsewhere = {};
                        else JE.userConfig[data.name] = {};
                    } else {
                        if (data.name === 'shortcuts') JE.userConfig.shortcuts = { Shortcuts: [] };
                        else if (data.name === 'bookmarks') JE.userConfig.bookmarks = { Bookmarks: {} };
                        else if (data.name === 'elsewhere') JE.userConfig.elsewhere = {};
                        else JE.userConfig[data.name] = {};
                    }
                } else {
                    const name = result.value?.name || result.reason?.name || '';
                    if (name === 'shortcuts') JE.userConfig.shortcuts = { Shortcuts: [] };
                    else if (name === 'bookmarks') JE.userConfig.bookmarks = { Bookmarks: {} };
                    else if (name === 'elsewhere') JE.userConfig.elsewhere = {};
                    else if (name) JE.userConfig[name] = {};
                }
            });
            // console.log('🪼 Jellyfin Enhanced: User configuration FETCHED (Raw Results):', JSON.stringify(JE.userConfig));


            // Initialize splash screen
            if (typeof JE.initializeSplashScreen === 'function') {
                JE.initializeSplashScreen();
            }

            // Stage 3: Load ALL component scripts
            const basePath = '/JellyfinEnhanced/js';
            const allComponentScripts = [
                'enhanced/config.js', 'enhanced/themer.js', 'enhanced/subtitles.js', 'enhanced/ui.js',
                'enhanced/playback.js', 'enhanced/features.js', 'enhanced/events.js',
                'migrate.js',
                'elsewhere.js',
                'jellyseerr/api.js',
                'jellyseerr/modal.js',
                'jellyseerr/ui.js',
                'jellyseerr/jellyseerr.js',
                'pausescreen.js', 'reviews.js',
                'qualitytags.js', 'genretags.js', 'languagetags.js', 'arr-links.js', 'arr-tag-links.js',
                'letterboxd-links.js'
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

            // Stage 6: Initialize feature modules
            if (typeof JE.initializeEnhancedScript === 'function') JE.initializeEnhancedScript();
            if (typeof JE.initializeMigration === 'function') JE.initializeMigration();
            if (typeof JE.initializeElsewhereScript === 'function') JE.initializeElsewhereScript();
            if (typeof JE.initializeJellyseerrScript === 'function') JE.initializeJellyseerrScript();
            if (typeof JE.initializePauseScreen === 'function') JE.initializePauseScreen();
            if (typeof JE.initializeQualityTags === 'function') JE.initializeQualityTags();
            if (typeof JE.initializeGenreTags === 'function') JE.initializeGenreTags();
            if (typeof JE.initializeArrLinksScript === 'function') JE.initializeArrLinksScript();
            if (typeof JE.initializeArrTagLinksScript === 'function') JE.initializeArrTagLinksScript();
            if (typeof JE.initializeLetterboxdLinksScript === 'function') JE.initializeLetterboxdLinksScript();
            if (typeof JE.initializeReviewsScript === 'function') JE.initializeReviewsScript();
            if (typeof JE.initializeLanguageTags === 'function') JE.initializeLanguageTags();

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

    // Then start main initialization
    initialize();

})();
