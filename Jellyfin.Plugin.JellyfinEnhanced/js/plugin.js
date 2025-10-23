// /js/plugin.js
(function() {
    'use strict';

    // Create the global namespace immediately
    window.JellyfinEnhanced = {};

    /**
     * A simple translation function that will be available globally.
     * It will use the translations object once it's loaded.
     * @param {string} key - The translation key.
     * @param {object} [params={}] - Optional parameters to replace in the string.
     * @returns {string} The translated string.
     */
    window.JellyfinEnhanced.t = function(key, params = {}) {
        const translations = window.JellyfinEnhanced.translations || {};
        let text = translations[key] || key;
        for (const [param, value] of Object.entries(params)) {
            text = text.replace(new RegExp(`{${param}}`, 'g'), value);
        }
        return text;
    };

    /**
     * Loads the appropriate language file based on the user's settings from localStorage.
     * @returns {Promise<object>} A promise that resolves to the translations object.
     */
    async function loadTranslations() {
        try {
            const user = await ApiClient.getCurrentUser();
            if (!user || !user.Id) {
                console.warn("🪼 Jellyfin Enhanced: User ID not found, defaulting to English.");
                const enResponse = await fetch(ApiClient.getUrl('/JellyfinEnhanced/locales/en.json'));
                return await enResponse.json();
            }

            const storageKey = `${user.Id}-language`;
            const storedLang = localStorage.getItem(storageKey);
            const lang = (storedLang || 'en').split('-')[0];

            const response = await fetch(ApiClient.getUrl(`/JellyfinEnhanced/locales/${lang}.json`));

            if (response.ok) {
                console.log(`🪼 Jellyfin Enhanced: Loaded '${lang}' translations.`);
                return await response.json();
            } else {
                console.warn(`🪼 Jellyfin Enhanced: No locale for '${lang}', falling back to English.`);
                const enResponse = await fetch(ApiClient.getUrl('/JellyfinEnhanced/locales/en.json'));
                return await enResponse.json();
            }
        } catch (error) {
            console.error('🪼 Jellyfin Enhanced: Failed to load translations, using empty object.', error);
            return {};
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
        }).catch(() => ({}));

        const versionPromise = ApiClient.ajax({
            type: 'GET',
            url: ApiClient.getUrl('/JellyfinEnhanced/version'),
            dataType: 'text'
        }).catch(() => '...');

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
            Object.assign(window.JellyfinEnhanced.pluginConfig, privateConfig);
            console.log('🪼 Jellyfin Enhanced: Private configuration loaded securely.');
        } catch (error) {
            console.warn('🪼 Jellyfin Enhanced: Could not load private configuration. Some features may be limited.', error);
        }
    }

    /**
     * Loads an array of scripts dynamically.
     * @param {string[]} scripts - Array of script filenames.
     * @param {string} basePath - The base URL path for the scripts.
     * @param {function} callback - Function to execute after all scripts are loaded.
     */
    function loadScripts(scripts, basePath, callback) {
        let loadedCount = 0;
        const totalScripts = scripts.length;
        if (totalScripts === 0) {
            if (callback) callback();
            return;
        }
        scripts.forEach(scriptName => {
            const script = document.createElement('script');
            script.src = ApiClient.getUrl(`${basePath}/${scriptName}?v=${Date.now()}`);// Cache-busting
            script.onload = () => {
                loadedCount++;
                console.log(`🪼 Jellyfin Enhanced: Loaded component '${scriptName}'`);
                if (loadedCount === totalScripts) {
                    if (callback) callback();
                }
            };
            script.onerror = () => {
                console.error(`🪼 Jellyfin Enhanced: Failed to load script '${scriptName}'`);
                loadedCount++; // Increment even on error to not block the callback
                if (loadedCount === totalScripts) {
                    if (callback) callback();
                }
            };
            document.head.appendChild(script);
        });
    }

    /**
     * Loads the splash screen script early to hide media-bar splash
     */
    function loadSplashScreenEarly() {
        if (typeof ApiClient === 'undefined') {
            setTimeout(loadSplashScreenEarly, 50);
            return;
        }

        const splashScript = document.createElement('script');
        splashScript.src = ApiClient.getUrl('/JellyfinEnhanced/js/splashscreen.js?v=' + Date.now());
        splashScript.onload = () => {
            console.log('🪼 Jellyfin Enhanced: Splash screen script loaded early.');
        };
        document.head.appendChild(splashScript);
    }

    /**
     * Main initialization function.
     */
    async function initialize() {
        if (typeof ApiClient === 'undefined' || !ApiClient.getPluginConfiguration || !ApiClient.getCurrentUserId()) {
            setTimeout(initialize, 200);
            return;
        }

        try {
            // Wait for both config and translations to be ready
            const [[config, version], translations] = await Promise.all([
                loadPluginData(),
                loadTranslations()
            ]);

            // Populate the global object
            window.JellyfinEnhanced.pluginConfig = config;
            window.JellyfinEnhanced.pluginVersion = version;
            window.JellyfinEnhanced.translations = translations;
            await loadPrivateConfig();
            console.log('🪼 Jellyfin Enhanced: Configuration and translations loaded.');

            // Initialize splash screen now that config is available
            if (typeof window.JellyfinEnhanced.initializeSplashScreen === 'function') {
                window.JellyfinEnhanced.initializeSplashScreen();
            }

            // Now, load all other feature scripts
            const basePath = '/JellyfinEnhanced/js';
            const allScripts = [
                'enhanced/config.js', 'enhanced/subtitles.js', 'enhanced/ui.js',
                'enhanced/playback.js', 'enhanced/features.js', 'enhanced/events.js',
                'elsewhere.js',
                'jellyseerr/api.js',
                'jellyseerr/modal.js',
                'jellyseerr/ui.js',
                'jellyseerr/jellyseerr.js',
                'pausescreen.js', 'reviews.js',
                'qualitytags.js', 'genretags.js', 'arr-links.js',
                'watchlist/watchlist.js'
            ];

            loadScripts(allScripts, basePath, () => {
                // Initialize all modules now that dependencies are loaded
                if (typeof window.JellyfinEnhanced.initializeEnhancedScript === 'function') {
                    window.JellyfinEnhanced.initializeEnhancedScript();
                }
                if (typeof window.JellyfinEnhanced.initializeElsewhereScript === 'function') {
                    window.JellyfinEnhanced.initializeElsewhereScript();
                }
                if (typeof window.JellyfinEnhanced.initializeJellyseerrScript === 'function') {
                    window.JellyfinEnhanced.initializeJellyseerrScript();
                }
                if (typeof window.JellyfinEnhanced.initializePauseScreen === 'function') {
                    window.JellyfinEnhanced.initializePauseScreen();
                }
                if (typeof window.JellyfinEnhanced.initializeQualityTags === 'function') {
                    window.JellyfinEnhanced.initializeQualityTags();
                }
                if (typeof window.JellyfinEnhanced.initializeGenreTags === 'function') {
                    window.JellyfinEnhanced.initializeGenreTags();
                }
                if (typeof window.JellyfinEnhanced.initializeArrLinksScript === 'function') {
                    window.JellyfinEnhanced.initializeArrLinksScript();
                }
                if (typeof window.JellyfinEnhanced.initializeReviewsScript === 'function') {
                    window.JellyfinEnhanced.initializeReviewsScript();
                }
                if (typeof window.JellyfinEnhanced.initializeWatchlistScript === "function") {
                    window.JellyfinEnhanced.initializeWatchlistScript();
                }
                console.log('🪼 Jellyfin Enhanced: All components loaded and initialized.');

                // Hide the splash screen now that everything is ready
                if (typeof window.JellyfinEnhanced.hideSplashScreen === 'function') {
                    window.JellyfinEnhanced.hideSplashScreen();
                }
            });

        } catch (error) {
            console.error('🪼 Jellyfin Enhanced: Critical initialization failed.', error);
        }
    }

    // Load splash screen immediately (before main initialization)
    loadSplashScreenEarly();

    // Then start main initialization
    initialize();

})();
