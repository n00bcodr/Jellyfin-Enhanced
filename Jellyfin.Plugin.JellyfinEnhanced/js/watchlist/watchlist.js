// /js/watchlist/watchlist.js
(function(JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced: Watchlist Loader:';

    function loadScript(url) {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = url;
            script.onload = () => {
                console.log(`${logPrefix} Successfully loaded ${script.src}`);
                resolve();
            };
            script.onerror = () => reject(new Error(`Failed to load script: ${url}`));
            document.head.appendChild(script);
        });
    }

    function injectCSS(url) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.type = 'text/css';
        link.href = url;
        document.head.appendChild(link);
        console.log(`${logPrefix} Injected CSS: ${url}`);
    }

    JE.initializeWatchlistScript = async function() {
        if (!JE.pluginConfig.WatchlistEnabled) {
            console.log(`${logPrefix} Watchlist feature is disabled in plugin settings. Scripts will not be loaded.`);
            return;
        }

        // Use the configured version, or default to 'master' if empty
        const kefinTweaksVersion = JE.pluginConfig.KefinTweaksVersion || 'master';
        const KEFINTWEAKS_BASE_URL = `https://cdn.jsdelivr.net/gh/ranaldsgift/kefintweaks@${kefinTweaksVersion}/scripts`;

        console.log(`${logPrefix} Watchlist is enabled. Loading scripts from kefinTweaks@${kefinTweaksVersion}...`);

        try {
            const scriptsToLoad = [
                'utils.js',
                'localStorageCache.js',
                'modal.js',
                'cardBuilder.js',
                'watchlist.js'
            ];

            injectCSS(KEFINTWEAKS_BASE_URL + 'watchlist.css');

            for (const scriptFile of scriptsToLoad) {
                await loadScript(KEFINTWEAKS_BASE_URL + scriptFile);
            }

            console.log(`${logPrefix} All kefinTweaks scripts for the watchlist feature were loaded successfully.`);

        } catch (error) {
            console.error(`${logPrefix} A critical error occurred while loading watchlist scripts. The feature may not work correctly.`, error);
        }
    };
})(window.JellyfinEnhanced);
