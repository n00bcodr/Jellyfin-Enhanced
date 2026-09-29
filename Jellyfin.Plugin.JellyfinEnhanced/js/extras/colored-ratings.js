// /js/extras/colored-ratings.js
// Applies color-coded backgrounds to media ratings on item details page

(function() {
    'use strict';

    const CONFIG = {
        targetSelector: '.mediaInfoOfficialRating',
        attributeName: 'rating',
        debounceDelay: 100,
        maxRetries: 3,
        cssUrl: window.JellyfinEnhanced.cdn.url('je-css', 'ratings.css'),
        cssId: 'jellyfin-ratings-style'
    };

    let observer = null;
    let navigationUnsubscribers = [];
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
                        if (normalizedRating.startsWith('FSK-')) {
                            element.textContent = normalizedRating;
                        }
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
            'DE-0': 'FSK-0',
            'DE-6': 'FSK-6',
            'DE-12': 'FSK-12',
            'DE-16': 'FSK-16',
            'DE-18': 'FSK-18',

            'FSK0': 'FSK-0',
            'FSK6': 'FSK-6',
            'FSK12': 'FSK-12',
            'FSK16': 'FSK-16',
            'FSK18': 'FSK-18',

            'FSK 0': 'FSK-0',
            'FSK 6': 'FSK-6',
            'FSK 12': 'FSK-12',
            'FSK 16': 'FSK-16',
            'FSK 18': 'FSK-18',
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
            const JE = window.JellyfinEnhanced;
            // Any added element may be (or contain) a rating box, so the
            // debounced pass — one cheap class query, idempotent — runs for
            // any of them. Inspecting each added node with its own subtree
            // query first cost more than the pass itself on pages that add
            // hundreds of cards (library scroll). Jellyfin writes the rating
            // via textContent, which is a childList mutation on the element
            // itself, so characterData is not needed.
            const callback = (mutations) => {
                for (let i = 0; i < mutations.length; i++) {
                    const mutation = mutations[i];
                    if (mutation.type !== 'childList') continue;
                    const added = mutation.addedNodes;
                    for (let j = 0; j < added.length; j++) {
                        if (added[j].nodeType === Node.ELEMENT_NODE) {
                            debouncedProcess();
                            return;
                        }
                    }
                    const target = mutation.target;
                    if (target.nodeType === Node.ELEMENT_NODE &&
                        (target.matches(CONFIG.targetSelector) || target.closest(CONFIG.targetSelector))) {
                        debouncedProcess();
                        return;
                    }
                }
            };

            // childList + subtree on body routes through the shared multiplexed
            // observer (batched after paint). The previous dedicated observer
            // also watched characterData, which fired for every text change in
            // the document (the player's clock, progress labels...).
            if (JE?.helpers?.createObserver) {
                observer = JE.helpers.createObserver(
                    'colored-ratings',
                    callback,
                    document.body,
                    { childList: true, subtree: true }
                );
            } else {
                observer = new MutationObserver(callback);
                observer.observe(document.body, { childList: true, subtree: true });
            }

            return true;

        } catch (error) {
            console.error('🪼 Jellyfin Enhanced: Failed to setup ratings observer', error);
            return false;
        }
    }

    /**
     * Re-check the page after navigation and after a view is shown: a cached
     * detail page re-shown by a class toggle alone produces no childList
     * mutation. This replaces the 1 s polling interval that used to run for
     * the whole session as a safety net.
     */
    function setupNavigationTriggers() {
        const JE = window.JellyfinEnhanced;
        if (!JE?.helpers?.onNavigate) return;
        const scheduleProcess = () => {
            if (!isFeatureEnabled()) return;
            setTimeout(processRatingElements, 500);
        };
        navigationUnsubscribers.push(JE.helpers.onNavigate(scheduleProcess));
        navigationUnsubscribers.push(JE.helpers.onViewPage(() => {
            if (isFeatureEnabled()) debouncedProcess();
        }));
    }

    /**
     * Kept for pausescreen.js, which pauses the (now removed) polling during
     * playback and resumes it on pause; a resume simply re-checks the page.
     */
    function pausePolling() {}

    function resumePolling() {
        if (isFeatureEnabled()) debouncedProcess();
    }

    function cleanup() {
        if (observer) {
            observer.disconnect();
            observer = null;
        }
        navigationUnsubscribers.forEach((unsubscribe) => {
            try { unsubscribe(); } catch (_) { /* ignore */ }
        });
        navigationUnsubscribers = [];
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
        setupNavigationTriggers();
    }

    if (typeof document.visibilityState !== 'undefined') {
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible' && isFeatureEnabled()) {
                setTimeout(processRatingElements, 100);
            }
        });
    }

    window.addEventListener('beforeunload', cleanup);
    if (window.JellyfinEnhanced) {
        window.JellyfinEnhanced.initializeColoredRatings = initialize;
        // Shared with tags/ageratingtags.js so poster badges pick the same
        // [rating=...] colour key as the details-page rating box.
        window.JellyfinEnhanced.normalizeOfficialRating = normalizeRating;
        // Expose pause/resume functions for pausescreen.js to control
        window.JellyfinEnhanced.pauseRatingsPolling = pausePolling;
        window.JellyfinEnhanced.resumeRatingsPolling = resumePolling;
    }

})();
