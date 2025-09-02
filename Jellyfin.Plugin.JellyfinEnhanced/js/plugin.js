// /js/plugin.js
(function() {
    'use strict';

    /**
     * Loads the appropriate language file based on the user's settings from localStorage.
     * @returns {Promise<object>} A promise that resolves to the translations object.
     */
    async function loadTranslations() {
        try {
            // First, get the current user's ID
            const user = await ApiClient.getCurrentUser();
            if (!user || !user.Id) {
                console.warn("🪼 Jellyfin Enhanced: User ID not found, defaulting to English.");
                const enResponse = await fetch(ApiClient.getUrl('/JellyfinEnhanced/locales/en.json'));
                return await enResponse.json();
            }

            // Construct the localStorage key and get the language
            const storageKey = `${user.Id}-language`;
            const storedLang = localStorage.getItem(storageKey);

            // Use the stored language, or default to 'en'. Take the base language code (e.g., 'en' from 'en-us').
            const lang = (storedLang || 'en').split('-')[0];

            const response = await fetch(ApiClient.getUrl(`/JellyfinEnhanced/locales/${lang}.json`));

            if (response.ok) {
                console.log(`🪼 Jellyfin Enhanced: Loaded '${lang}' translations from localStorage.`);
                return await response.json();
            } else {
                // Fallback to English if the user's language file isn't found
                console.warn(`🪼 Jellyfin Enhanced: No locale for '${lang}', falling back to English.`);
                const enResponse = await fetch(ApiClient.getUrl('/JellyfinEnhanced/locales/en.json'));
                return await enResponse.json();
            }
        } catch (error) {
            console.error('🪼 Jellyfin Enhanced: Failed to load translations, using empty object.', error);
            return {}; // Return empty object on error to prevent crashes
        }
    }

    /**
     * A simple translation function.
     * @param {string} key - The translation key.
     * @param {object} [params={}] - Optional parameters to replace in the string.
     * @returns {string} The translated string.
     */
    function translate(key, params = {}) {
        let text = window.JellyfinEnhanced.translations[key] || key;
        for (const [param, value] of Object.entries(params)) {
            text = text.replace(new RegExp(`{${param}}`, 'g'), value);
        }
        return text;
    }
    /**
     * Loads an array of scripts dynamically into the document head.
     * @param {string[]} scripts - Array of script filenames to load.
     * @param {string} basePath - The base URL path for the scripts.
     * @param {function} callback - Function to execute after all scripts have loaded.
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
            script.src = `${basePath}/${scriptName}?v=${Date.now()}`; // Cache-busting
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
     * Fetches plugin configuration and version from the server.
     * @returns {Promise<[object, string, object]>} A promise that resolves when all data is fetched.
     */
    function loadPluginData() {
            const configPromise = ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl('/JellyfinEnhanced/public-config'),
                dataType: 'json'
            }).then(publicConfig => {
                console.log('🪼 Jellyfin Enhanced: Public configuration loaded.');
                if (publicConfig && publicConfig.Shortcuts && Array.isArray(publicConfig.Shortcuts)) {
                    const shortcutMap = new Map();
                    for (const shortcut of publicConfig.Shortcuts) {
                        if (shortcut.Name) {
                            shortcutMap.set(shortcut.Name, shortcut);
                        }
                    }
                    publicConfig.Shortcuts = Array.from(shortcutMap.values());
                }
                return publicConfig || {};
            }).catch(err => {
                console.error('🪼 Jellyfin Enhanced: Could not load public plugin configuration. Features will be degraded.', err);
                return {};
            });

            const versionPromise = ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl('/JellyfinEnhanced/version'),
                dataType: 'text'
            }).then(version => {
                console.log('🪼 Jellyfin Enhanced: Plugin version loaded:', version);
                return version;
            }).catch(err => {
                console.warn('🪼 Jellyfin Enhanced: Could not load plugin version.', err);
                return '...';
            });

            return Promise.all([configPromise, versionPromise]);
        }

    /**
     * Waits for the Jellyfin API client to be ready, then loads all plugin scripts and initializes them.
     */
    function waitForApiClientAndInitialize() {
        if (typeof ApiClient !== 'undefined' && ApiClient.getPluginConfiguration) {
            loadPluginData().then(([config, version]) => {
                // Assign fetched data to the global namespace
                window.JellyfinEnhanced.pluginConfig = config;
                window.JellyfinEnhanced.pluginVersion = version;

                const basePath = '/JellyfinEnhanced/js';
                const allScripts = [
                    'enhanced/config.js',
                    'enhanced/subtitles.js',
                    'enhanced/ui.js',
                    'enhanced/playback.js',
                    'enhanced/features.js',
                    'enhanced/events.js',
                    'elsewhere.js',
                    'jellyseerr.js',
                    'pausescreen.js',
                    'qualitytags.js',
                    'arr-links.js'
                ];

                // Load all script modules
                loadScripts(allScripts, basePath, () => {
                    // This callback runs only after all scripts have finished loading
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
                    if (typeof window.JellyfinEnhanced.initializeArrLinksScript === 'function') {
                        window.JellyfinEnhanced.initializeArrLinksScript();
                    }
                    console.log('🪼 Jellyfin Enhanced: All components loaded and initialized.');
                });
            });
        } else {
            setTimeout(waitForApiClientAndInitialize, 200);
        }
    }

    // Create the global namespace and start the initialization process
    window.JellyfinEnhanced = {};
    waitForApiClientAndInitialize();

})();
