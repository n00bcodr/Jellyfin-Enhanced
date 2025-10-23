// /js/splashscreen.js
(function() {
    'use strict';

    const CONFIG = {
        loadingCheckInterval: 100,
        fadeOutDuration: 400,         // Duration of fade out animation (ms)
        progressUpdateInterval: 150,  // How often to update progress bar (ms)
        hardTimeout: 20000,           // Max time before force-hiding splash (ms)
        removalInterval: 100,
        removalDuration: 5000
    };

    const READY_SELECTORS = [
        '.manualLoginForm',
        '#mainAnimatedPage',
        '.homeSectionsContainer',
        '.pageContainer',
        '.slides-container',
        '.backdrop-container',
        'customTabButton_0',
        '.editorsChoiceItemBanner'
    ];

    let splashElement = null;
    let styleElement = null;
    let permanentBlockStyle = null;
    let readyObserver = null;
    let mediaBarBlocker = null;
    let progressTimer = null;
    let hardTimeout = null;
    let isHidden = false;

    /**
     * Installs preemptive CSS to hide competing splash screens before rendering
     */
    function installPreemptiveStyles() {
        try {
            const style = document.createElement('style');
            style.id = 'je-preempt-styles';
            style.textContent = `
                html.je-splash-booting .bar-loading,
                html.je-splash-booting #page-loader,
                html.je-splash-booting #splashscreen,
                html.je-splash-booting .splash,
                html.je-splash-booting [data-plugin-splash] {
                    display: none !important;
                }
            `;
            document.documentElement.classList.add('je-splash-booting');
            (document.head || document.documentElement).appendChild(style);
        } catch (error) {
            console.warn('🪼 Jellyfin Enhanced: Failed to install preemptive styles', error);
        }
    }

    /**
     * Installs permanent CSS block for media-bar and other competing splash screens
     */
    function installPermanentBlock() {
        if (permanentBlockStyle) {
            return;
        }

        try {
            permanentBlockStyle = document.createElement('style');
            permanentBlockStyle.id = 'je-permanent-block';
            permanentBlockStyle.textContent = `
                #page-loader,
                .bar-loading:not(.je-loading),
                #splashscreen:not(.je-loading),
                .splash:not(.je-loading),
                [data-plugin-splash]:not(.je-loading) {
                    display: none !important;
                    opacity: 0 !important;
                    visibility: hidden !important;
                    pointer-events: none !important;
                }
            `;
            document.head.appendChild(permanentBlockStyle);
            console.log('🪼 Jellyfin Enhanced: Permanent splash block installed');
        } catch (error) {
            console.warn('🪼 Jellyfin Enhanced: Failed to install permanent block', error);
        }
    }

    /**
     * Removes any media-bar splash elements from the DOM
     */
    function removeMediaBarSplash() {
        const mediaBarElements = document.querySelectorAll('#page-loader, .bar-loading:not(.je-loading)');
        mediaBarElements.forEach(element => {
            if (element && element.parentNode) {
                console.log('🪼 Jellyfin Enhanced: Removing media-bar splash element');
                element.remove();
            }
        });
    }

    /**
     * Starts a MutationObserver to block media-bar injection attempts
     */
    function startMediaBarBlocker() {
        if (mediaBarBlocker) {
            return;
        }

        mediaBarBlocker = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                mutation.addedNodes.forEach((node) => {
                    if (node instanceof HTMLElement) {
                        if (node.id === 'page-loader' ||
                            (node.classList.contains('bar-loading') && !node.classList.contains('je-loading'))) {
                            console.log('🪼 Jellyfin Enhanced: Blocking media-bar splash attempt');
                            node.remove();
                        }
                    }
                });
            });
        });

        mediaBarBlocker.observe(document.body, {
            childList: true,
            subtree: false
        });
    }

    /**
     * Checks if an element is visible
     * @param {Element|null} element
     * @returns {boolean}
     */
    function isElementShown(element) {
        return !!(element && element instanceof HTMLElement && element.offsetParent !== null);
    }

    /**
     * Checks if the Jellyfin UI is ready for interaction
     * @returns {boolean}
     */
    function isUIReady() {
        for (const selector of READY_SELECTORS) {
            const element = document.querySelector(selector);
            if (isElementShown(element) || (element && selector === '#mainAnimatedPage')) {
                return true;
            }
        }
        return false;
    }

    /**
     * Hides the splash screen with animation
     * @param {string} reason - Reason for hiding
     */
    function hideSplashScreen(reason) {
        if (isHidden) {
            return;
        }
        isHidden = true;

        if (progressTimer) {
            clearInterval(progressTimer);
            progressTimer = null;
        }
        if (hardTimeout) {
            clearTimeout(hardTimeout);
            hardTimeout = null;
        }
        if (readyObserver) {
            readyObserver.disconnect();
            readyObserver = null;
        }

        const progressBar = document.getElementById('je-progress-bar');
        const unfilledBar = document.getElementById('je-unfilled-bar');

        const completeRemoval = () => {
            if (splashElement) {
                splashElement.style.opacity = '0';
            }

            setTimeout(() => {
                if (splashElement) {
                    splashElement.remove();
                    splashElement = null;
                }
                if (styleElement) {
                    styleElement.remove();
                    styleElement = null;
                }

                document.body.classList.remove('je-splash-active');

                const removalInterval = setInterval(() => {
                    removeMediaBarSplash();
                }, CONFIG.removalInterval);

                setTimeout(() => {
                    clearInterval(removalInterval);
                }, CONFIG.removalDuration);

                if (reason) {
                    console.log(`🪼 Jellyfin Enhanced: Splash screen hidden → ${reason}`);
                }
            }, CONFIG.fadeOutDuration);
        };

        if (progressBar && unfilledBar) {
            progressBar.style.transition = `width 300ms ease-in-out`;
            progressBar.style.width = '100%';
            unfilledBar.style.width = '0%';
            setTimeout(completeRemoval, 300);
        } else {
            completeRemoval();
        }
    }

    /**
     * Creates and displays the splash screen
     */
    function createSplashScreen() {
        if (splashElement) {
            return;
        }

        installPermanentBlock();
        startMediaBarBlocker();
        removeMediaBarSplash();

        const css = `
            body.je-splash-active .bar-loading:not(.je-loading) { display: none !important; }
            body.je-splash-active #page-loader { display: none !important; }
            .je-loading {
                z-index: 99999999 !important;
                position: fixed;
                inset: 0;
                background: #000;
                display: flex;
                align-items: center;
                justify-content: center;
                opacity: 1;
                transition: opacity 0.4s ease-in-out;
                overflow: hidden;
            }
            .je-loader-content {
                display: flex;
                flex-direction: column;
                align-items: center;
                gap: 20px;
                width: 250px;
            }
            .je-loading h1 {
                width: 250px;
                height: 250px;
                display: flex;
                justify-content: center;
                align-items: center;
                margin: 0;
            }
            .je-loading h1 img {
                width: 250px;
                max-height: 250px;
                object-fit: contain;
                opacity: 1;
                transition: opacity 0.5s ease-in-out;
            }
            .je-progress {
                width: 200px;
                height: 6px;
                display: flex;
                align-items: center;
                position: relative;
            }
            #je-progress-bar {
                height: 5px;
                background: #fff;
                border-radius: 2px;
                width: 0;
            }
            .je-gap {
                width: 6px;
                height: 5px;
                flex-shrink: 0;
            }
            #je-unfilled-bar {
                height: 5px;
                background: #686868;
                border-radius: 2px;
                flex-grow: 1;
            }
        `;

        styleElement = document.createElement('style');
        styleElement.id = 'je-splash-styles';
        styleElement.textContent = css;
        document.head.appendChild(styleElement);

        const pluginConfig = window.JellyfinEnhanced?.pluginConfig || {};
        const imageUrl = pluginConfig.SplashScreenImageUrl || '/web/assets/img/banner-light.png';

        splashElement = document.createElement('div');
        splashElement.className = 'je-loading';
        splashElement.innerHTML = `
            <div class="je-loader-content">
                <h1><img src="${imageUrl}" alt="Server Logo" decoding="async" fetchpriority="high" referrerpolicy="no-referrer"></h1>
                <div class="je-progress">
                    <div id="je-progress-bar"></div>
                    <div class="je-gap"></div>
                    <div id="je-unfilled-bar"></div>
                </div>
            </div>
        `;
        document.body.appendChild(splashElement);

        startProgressAnimation();
        startReadyObserver();

        hardTimeout = setTimeout(() => {
            hideSplashScreen('hard timeout 20s');
        }, CONFIG.hardTimeout);
    }

    /**
     * Starts the progress bar animation
     */
    function startProgressAnimation() {
        const progressBar = document.getElementById('je-progress-bar');
        const unfilledBar = document.getElementById('je-unfilled-bar');

        if (!progressBar || !unfilledBar) {
            return;
        }

        let progress = 0;
        let lastIncrement = 5;

        progressTimer = setInterval(() => {
            if (progress >= 95) {
                return;
            }

            lastIncrement = Math.max(0.5, lastIncrement * 0.98);
            const increment = lastIncrement * (0.8 + Math.random() * 0.4);
            progress = Math.min(95, progress + increment);

            progressBar.style.width = progress + '%';
            unfilledBar.style.width = (100 - progress) + '%';
        }, CONFIG.progressUpdateInterval);
    }

    /**
     * Starts observing the DOM for UI ready state
     */
    function startReadyObserver() {
        if (readyObserver) {
            return;
        }

        if (isUIReady()) {
            hideSplashScreen('UI already ready');
            return;
        }

        readyObserver = new MutationObserver(() => {
            removeMediaBarSplash();

            if (document.querySelector('.bar-loading:not(.je-loading)')) {
                document.body.classList.add('je-splash-active');
            }

            if (isUIReady()) {
                hideSplashScreen('core UI detected');
            }
        });

        readyObserver.observe(document.body, {
            childList: true,
            subtree: true
        });

        window.addEventListener('hashchange', () => {
            if (isUIReady()) {
                hideSplashScreen('hashchange ready');
            }
        });

        document.addEventListener('visibilitychange', () => {
            if (!document.hidden && isUIReady()) {
                hideSplashScreen('visibilitychange ready');
            }
        });
    }

    /**
     * Cleanup function to remove all blocking styles
     */
    function cleanup() {
        document.documentElement.classList.remove('je-splash-booting');

        const preemptStyle = document.getElementById('je-preempt-styles');
        if (preemptStyle) {
            preemptStyle.remove();
        }

        if (permanentBlockStyle) {
            permanentBlockStyle.remove();
            permanentBlockStyle = null;
        }

        if (mediaBarBlocker) {
            mediaBarBlocker.disconnect();
            mediaBarBlocker = null;
        }
    }

    /**
     * Initializes the splash screen
     */
    function initializeSplashScreen() {
        const pluginConfig = window.JellyfinEnhanced?.pluginConfig || {};

        if (!pluginConfig.EnableCustomSplashScreen) {
            cleanup();
            console.log('🪼 Jellyfin Enhanced: Custom splash screen disabled');
            return;
        }

        document.body.classList.add('je-splash-active');
        document.documentElement.classList.remove('je-splash-booting');

        const preemptStyle = document.getElementById('je-preempt-styles');
        if (preemptStyle) {
            preemptStyle.remove();
        }

        installPermanentBlock();
        startMediaBarBlocker();
        removeMediaBarSplash();

        createSplashScreen();

        console.log('🪼 Jellyfin Enhanced: Splash screen initialized');
    }

    /**
     * Hide splash screen
     */
    function publicHideSplashScreen() {
        hideSplashScreen('requested by plugin.js');
    }

    // Install preemptive styles immediately
    installPreemptiveStyles();

    // Export functions to global namespace
    window.JellyfinEnhanced = window.JellyfinEnhanced || {};
    window.JellyfinEnhanced.initializeSplashScreen = initializeSplashScreen;
    window.JellyfinEnhanced.hideSplashScreen = publicHideSplashScreen;

    console.log('🪼 Jellyfin Enhanced: Splash screen module loaded.');

})();