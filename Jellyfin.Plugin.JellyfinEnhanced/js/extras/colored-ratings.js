// /js/extras/colored-ratings.js
// Applies color-coded backgrounds to media ratings on item details page

(function() {
    'use strict';

    const CONFIG = {
        targetSelector: '.mediaInfoOfficialRating',
        attributeName: 'rating',
        fallbackInterval: 1000,
        debounceDelay: 100,
        maxRetries: 3,
        cssUrl: 'https://cdn.jsdelivr.net/gh/n00bcodr/Jellyfin-Enhanced@main/css/ratings.css',
        cssId: 'jellyfin-ratings-style'
    };

    let observer = null;
    let fallbackTimer = null;
    let debounceTimer = null;
    let processedElements = new WeakSet();

    function isFeatureEnabled() {
        return Boolean(window?.JellyfinEnhanced?.pluginConfig?.ColoredRatingsEnabled);
    }

    function injectCSS() {
        if (document.getElementById(CONFIG.cssId)) return;

        try {
            const linkElement = document.createElement('link');
            linkElement.id = CONFIG.cssId;
            linkElement.rel = 'stylesheet';
            linkElement.type = 'text/css';
            linkElement.href = CONFIG.cssUrl;
            document.head.appendChild(linkElement);
        } catch (error) {
            console.error('🪼 Jellyfin Enhanced: Failed to inject ratings CSS', error);
        }
    }


    function processRatingElements() {
        try {
            const elements = document.querySelectorAll(CONFIG.targetSelector);
            let processedCount = 0;

            elements.forEach((element, index) => {
                if (processedElements.has(element)) {
                    const currentRating = element.textContent?.trim();
                    const existingRating = element.getAttribute(CONFIG.attributeName);
                    if (currentRating === existingRating) {
                        return;
                    }
                }

                const ratingText = element.textContent?.trim();
                if (ratingText && ratingText.length > 0) {
                    const normalizedRating = normalizeRating(ratingText);

                    if (element.getAttribute(CONFIG.attributeName) !== normalizedRating) {
                        element.setAttribute(CONFIG.attributeName, normalizedRating);
                        processedElements.add(element);
                        processedCount++;

                        if (!element.getAttribute('aria-label')) {
                            element.setAttribute('aria-label', `Content rated ${normalizedRating}`);
                        }
                        if (!element.getAttribute('title')) {
                            element.setAttribute('title', `Rating: ${normalizedRating}`);
                        }
                    }
                }
            });

        } catch (error) {
            console.error('🪼 Jellyfin Enhanced: Error processing rating elements', error);
        }
    }

    function normalizeRating(rating) {
        if (!rating) return '';

        let normalized = rating.replace(/\s+/g, ' ').trim().toUpperCase();

        const ratingMappings = {
            'NOT RATED': 'NR',
            'NOT-RATED': 'NR',
            'UNRATED': 'NR',
            'NO RATING': 'NR',
            'APPROVED': 'APPROVED',
            'PASSED': 'PASSED'
        };

        return ratingMappings[normalized] || rating.trim();
    }

    function debouncedProcess() {
        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }
        debounceTimer = setTimeout(processRatingElements, CONFIG.debounceDelay);
    }

    function setupMutationObserver() {
        if (!window.MutationObserver) return false;

        try {
            observer = new MutationObserver((mutations) => {
                let shouldProcess = false;

                mutations.forEach((mutation) => {
                    if (mutation.type === 'childList') {
                        mutation.addedNodes.forEach((node) => {
                            if (node.nodeType === Node.ELEMENT_NODE) {
                                if (node.matches && node.matches(CONFIG.targetSelector)) {
                                    shouldProcess = true;
                                } else if (node.querySelector && node.querySelector(CONFIG.targetSelector)) {
                                    shouldProcess = true;
                                }
                            }
                        });
                    }

                    if (mutation.type === 'characterData' || mutation.type === 'childList') {
                        const target = mutation.target;
                        if (target.nodeType === Node.ELEMENT_NODE &&
                            (target.matches(CONFIG.targetSelector) || target.closest(CONFIG.targetSelector))) {
                            shouldProcess = true;
                        }
                    }
                });

                if (shouldProcess) {
                    debouncedProcess();
                }
            });

            observer.observe(document.body, {
                childList: true,
                subtree: true,
                characterData: true,
                characterDataOldValue: false
            });

            return true;

        } catch (error) {
            console.error('🪼 Jellyfin Enhanced: Failed to setup ratings observer', error);
            return false;
        }
    }

    function setupFallbackPolling() {
        // Don't start polling if we're actively playing video
        if (isVideoPlaying()) {
            return;
        }
        fallbackTimer = setInterval(processRatingElements, CONFIG.fallbackInterval);
    }

    function isOnVideoPage() {
        // Check if we're on the video player page
        if (typeof window.JellyfinEnhanced?.isVideoPage === 'function') {
            return window.JellyfinEnhanced.isVideoPage();
        }
        // Fallback check
        return window.location.hash.startsWith('#/video') || !!document.querySelector('.videoPlayerContainer');
    }

    function isVideoPlaying() {
        // Check if we're on the video player page AND the video is actively playing
        if (!isOnVideoPage()) {
            return false;
        }

        // Check if pause screen is visible (pause screen has osdInfo visible)
        const pauseScreen = document.querySelector('.videoOsdBottom');
        if (pauseScreen && getComputedStyle(pauseScreen).display !== 'none' && getComputedStyle(pauseScreen).opacity !== '0') {
            // Pause screen is visible - allow polling
            return false;
        }

        // Check if video element exists and is playing
        const video = document.querySelector('video');
        if (!video) {
            return false;
        }

        return !video.paused;
    }

    function pausePolling() {
        if (fallbackTimer) {
            clearInterval(fallbackTimer);
            fallbackTimer = null;
        }
    }

    function resumePolling() {
        if (!fallbackTimer && isFeatureEnabled() && !isVideoPlaying()) {
            fallbackTimer = setInterval(processRatingElements, CONFIG.fallbackInterval);
        }
    }

    function cleanup() {
        if (observer) {
            observer.disconnect();
            observer = null;
        }
        if (fallbackTimer) {
            clearInterval(fallbackTimer);
            fallbackTimer = null;
        }
        if (debounceTimer) {
            clearTimeout(debounceTimer);
            debounceTimer = null;
        }
        processedElements = new WeakSet();
    }

    function initialize() {
        if (!isFeatureEnabled()) {
            cleanup();
            return;
        }
        cleanup();
        injectCSS();
        processRatingElements();
        setupMutationObserver();
        setupFallbackPolling();
    }

    if (typeof document.visibilityState !== 'undefined') {
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible' && isFeatureEnabled()) {
                setTimeout(processRatingElements, 100);
            }
        });
    }

    let lastUrl = location.href;

    new MutationObserver(() => {
        const url = location.href;
        if (url !== lastUrl) {
            lastUrl = url;
            if (isFeatureEnabled()) {
                setTimeout(initialize, 500);
            }
        }
    }).observe(document, { subtree: true, childList: true });

    window.addEventListener('beforeunload', cleanup);
    if (window.JellyfinEnhanced) {
        window.JellyfinEnhanced.initializeColoredRatings = initialize;
        // Expose pause/resume functions for pausescreen.js to control
        window.JellyfinEnhanced.pauseRatingsPolling = pausePolling;
        window.JellyfinEnhanced.resumeRatingsPolling = resumePolling;
    }

})();