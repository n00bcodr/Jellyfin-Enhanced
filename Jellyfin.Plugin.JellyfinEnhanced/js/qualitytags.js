// /js/qualitytags.js
// Jellyfin Quality Tags
// This is a modified version of the Jellyfin Quality Tags script by by BobHasNoSoul. - https://github.com/BobHasNoSoul/Jellyfin-Qualitytags/

(function (JE) {
    'use strict';

    /**
     * Initializes the Quality Tags feature.
     */
    JE.initializeQualityTags = function() {
        // Exit immediately if the user has disabled this feature in their settings.
        if (!JE.currentSettings.qualityTagsEnabled) {
            console.log('🪼 Jellyfin Enhanced: Quality Tags: Feature is disabled in settings.');
            return;
        }

        // --- CONSTANTS ---
        const logPrefix = '🪼 Jellyfin Enhanced: Quality Tags:';
        const overlayClass = 'quality-overlay-label';
        const containerClass = 'quality-overlay-container';
        // Use plugin version for cache invalidation, so every plugin update force update tags. Will have to figure out a better way to do this.
        const CACHE_KEY = `qualityOverlayCache-${JE.pluginVersion || 'static_fallback'}`;

        // CSS selectors for elements that should NOT have quality tags applied.
        // This is used to ignore certain views like the cast & crew list.
        const IGNORE_SELECTORS = [
            '#itemDetailPage #castCollapsible a.cardImageContainer',
            '#indexPage .verticalSection.MyMedia a.cardImageContainer'
        ];

        // The types of Jellyfin items that are eligible for quality tags.
        const MEDIA_TYPES = new Set(['Movie', 'Episode', 'Series', 'Season']);

        // Sort tags for consistent display order (Resolution > Features)
        const resolutionOrder = ['8K', '4K', '1440p', '1080p', '720p', '480p', 'LOW-RES', 'SD'];
        const videoOrder = ['Dolby Vision', 'HDR10+', 'HDR10', 'HDR', '3D'];
        const audioOrder = ['ATMOS', 'DTS-X', 'TRUEHD', 'DTS', 'Dolby Digital+', '7.1', '5.1'];
        const featureOrder = [...videoOrder, ...audioOrder];

        // Defines resolution tiers and their priority for display.
        const QUALITY_THRESHOLDS = {
            '8K': { width: 7680, priority: 7 },
            '4K': { width: 3500, priority: 6 },
            '1440p': { width: 2560, priority: 5 },
            '1080p': { width: 1920, priority: 4 },
            '720p': { width: 1280, priority: 3 },
            '480p': { width: 720, priority: 2 },
            'SD': { width: 0, priority: 1 }
        };

        // Color definitions for each quality tag.
        const qualityColors = {
            '8K': { bg: 'rgba(220, 20, 60, 0.95)', text: '#ffffff' },
            '4K': { bg: 'rgba(189, 5, 232, 0.95)', text: '#ffffff' },
            '1440p': { bg: 'rgba(255, 20, 147, 0.9)', text: '#ffffff' },
            '1080p': { bg: 'rgba(0, 191, 255, 0.9)', text: '#ffffff' },
            '720p': { bg: 'rgba(255, 165, 0, 0.9)', text: '#000000' },
            '480p': { bg: 'rgba(255, 193, 7, 0.85)', text: '#000000' },
            'SD': { bg: 'rgba(108, 117, 125, 0.85)', text: '#ffffff' },
            'HDR': { bg: 'rgba(255, 215, 0, 0.95)', text: '#000000' },
            'HDR10': { bg: 'rgba(255, 215, 0, 0.95)', text: '#000000' },
            'HDR10+': { bg: 'rgba(255, 215, 0, 0.95)', text: '#000000' },
            'Dolby Vision': { bg: 'rgba(139, 69, 19, 0.95)', text: '#ffffff' },
            'ATMOS': { bg: 'rgba(0, 100, 255, 0.9)', text: '#ffffff' },
            'DTS-X': { bg: 'rgba(255, 100, 0, 0.9)', text: '#ffffff' },
            'DTS': { bg: 'rgba(255, 140, 0, 0.85)', text: '#ffffff' },
            'Dolby Digital+': { bg: 'rgba(0, 150, 136, 0.9)', text: '#ffffff' },
            'TRUEHD': { bg: 'rgba(76, 175, 80, 0.9)', text: '#ffffff' },
            '7.1': { bg: 'rgba(156, 39, 176, 0.9)', text: '#ffffff' },
            '5.1': { bg: 'rgba(103, 58, 183, 0.9)', text: '#ffffff' },
            '3D': { bg: 'rgba(0, 150, 255, 0.9)', text: '#ffffff' }
        };

        // --- STATE VARIABLES ---
        let qualityOverlayCache = JSON.parse(localStorage.getItem(CACHE_KEY)) || {};
        let processedElements = new WeakSet(); // Stores elements that have been processed to avoid re-work.
        let requestQueue = []; // A queue for API requests to avoid server overload.
        let isProcessingQueue = false;
        let mutationDebounceTimer = null;
        let renderDebounceTimer = null;

        // --- CONFIGURATION ---
        const config = {
            MAX_CONCURRENT_REQUESTS: 7,      // Max number of simultaneous API requests.
            QUEUE_PROCESS_INTERVAL: 300,   // Delay between processing batches from the queue.
            MUTATION_DEBOUNCE: 800,        // Delay to wait for DOM changes to settle before processing.
            RENDER_DEBOUNCE: 500,          // Delay for re-rendering tags on navigation.
            CACHE_TTL: 7 * 24 * 60 * 60 * 1000, // Cache entries expire after 7 days.
            REQUEST_TIMEOUT: 8000,           // Timeout for API requests.
            MAX_RETRIES: 2                     // Number of times to retry a failed API request.
        };

        // --- OBSERVERS ---
        // Observes elements to see when they enter the viewport, for lazy-loading tags.
        const visibilityObserver = new IntersectionObserver(handleIntersection, {
            rootMargin: '200px',
            threshold: 0.1
        });

        // --- HELPER FUNCTIONS ---
        /**
         * Retrieves the current user's ID from the ApiClient.
         * @returns {string|null} The user ID or null if not found.
         */
        function getUserId() {
            try {
                return (window.ApiClient?._serverInfo?.UserId) ||
                       (window.Dashboard?.getCurrentUserId?.()) ||
                       null;
            } catch {
                return null;
            }
        }

        /**
         * Saves the quality overlay cache to localStorage after pruning expired entries.
         */
        function saveCache() {
            try {
                const now = Date.now();
                // Prune old entries from cache
                for (const [key, entry] of Object.entries(qualityOverlayCache)) {
                    if (now - entry.timestamp > config.CACHE_TTL) {
                        delete qualityOverlayCache[key];
                    }
                }
                localStorage.setItem(CACHE_KEY, JSON.stringify(qualityOverlayCache));
            } catch (e) {
                console.warn(`${logPrefix} Failed to save cache`, e);
            }
        }
        /**
         * Scans localStorage for any old cache keys from previous plugin versions and removes them.
         */
        function cleanupOldCaches() {
            const currentKey = CACHE_KEY;
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && key.startsWith('qualityOverlayCache-') && key !== currentKey) {
                    console.log(`${logPrefix} Removing old cache: ${key}`);
                    localStorage.removeItem(key);
                }
            }
        }
        /**
         * Creates a single quality tag element.
         * @param {string} label The text for the tag (e.g., "4K", "HDR").
         * @returns {HTMLElement} The created div element for the tag.
         */
        function createResponsiveLabel(label) {
            const badge = document.createElement('div');
            badge.textContent = label;
            badge.className = overlayClass;

            if (resolutionOrder.includes(label)) {
                badge.classList.add('resolution');
            } else if (videoOrder.includes(label)) {
                badge.classList.add('video-codec');
            } else if (audioOrder.includes(label)) {
                badge.classList.add('audio-codec');
            } else {
                badge.classList.add('other-quality');
            }
            badge.dataset.quality = label;
            return badge;
        }

        // --- CORE LOGIC ---
        /**
         * Analyzes media stream and source information to determine quality tags.
         * @param {Array} mediaStreams - The MediaStreams array from the Jellyfin item.
         * @param {Array} mediaSources - The MediaSources array from the Jellyfin item.
         * @returns {Array<string>} A list of detected quality tags.
         */
        function getEnhancedQuality(mediaStreams, mediaSources) {
            if (!mediaStreams && !mediaSources) return [];

            const qualities = new Set();
            let videoStreams = [];
            let audioStreams = [];

            if (mediaStreams) {
                videoStreams = mediaStreams.filter(s => s.Type === 'Video');
                audioStreams = mediaStreams.filter(s => s.Type === 'Audio');
            }

            // Also check within MediaSources, as this can sometimes contain more accurate stream info
            if (mediaSources?.[0]?.MediaStreams) {
                const sourceStreams = mediaSources[0].MediaStreams;
                videoStreams = videoStreams.concat(sourceStreams.filter(s => s.Type === 'Video'));
                audioStreams = audioStreams.concat(sourceStreams.filter(s => s.Type === 'Audio'));
            }


            // Get primary video stream for analysis
            const primaryVideoStream = videoStreams[0];

            // --- VIDEO RESOLUTION LOGIC ---
            let resolutionTag = null;

            if (primaryVideoStream) {
                // Priority 1: DisplayTitle Scan for resolution keywords
                const displayTitle = primaryVideoStream.DisplayTitle || '';
                const resolutionRegex = /\b(4k|2160p|1440p|1080p|720p|480p|360p|404p|384p|520p)\b/i;
                const resolutionMatch = displayTitle.match(resolutionRegex);

                if (resolutionMatch) {
                    const found = resolutionMatch[1].toLowerCase();
                    if (found === '4k' || found === '2160p') {
                        resolutionTag = '4K';
                    } else if (found === '1440p') {
                        resolutionTag = '1440p';
                    } else if (found === '1080p') {
                        resolutionTag = '1080p';
                    } else if (found === '720p') {
                        resolutionTag = '720p';
                    } else if (found === '480p') {
                        resolutionTag = '480p';
                    } else if (['360p', '404p', '384p', '520p'].includes(found)) {
                        // Generic low-res tag for anything below 480p
                        resolutionTag = 'LOW-RES';
                    }
                    qualities.add(resolutionTag);
                } else {
                    // Priority 2: Dimension Fallback
                    const height = primaryVideoStream.Height || 0;
                    if (height >= 1000) {
                        resolutionTag = '1080p';
                    } else if (height >= 700) {
                        resolutionTag = '720p';
                    } else if (height >= 400) {
                        resolutionTag = '480p';
                    } else if (height > 0) {
                        // Any height below 400px gets the generic low-res tag
                        resolutionTag = 'LOW-RES';
                    }

                    if (resolutionTag) {
                        qualities.add(resolutionTag);
                    }
                }
            }

            // --- VIDEO DYNAMIC RANGE LOGIC ---
            let hdrTag = null;

            if (primaryVideoStream) {
                // Priority 1: Dolby Vision Scan
                const displayTitle = primaryVideoStream.DisplayTitle || '';
                const videoRangeType = primaryVideoStream.VideoRangeType || '';
                const dolbyVisionRegex = /dolby\s*vision|dv/i;
                const dolbyVisionMatchTitle = displayTitle.match(dolbyVisionRegex);
                const dolbyVisionMatchRange = videoRangeType.match(dolbyVisionRegex);
                if (dolbyVisionMatchTitle || dolbyVisionMatchRange) {
                    hdrTag = 'Dolby Vision';
                    qualities.add(hdrTag);
                } else {
                    // Priority 2: HDR Fallback
                    const hdr10PlusRegex = /hdr10\+/i;
                    const hdr10Regex = /hdr10/i;
                    const hdrRegex = /\bhdr\b/i;

                    const hdr10PlusMatchTitle = displayTitle.match(hdr10PlusRegex);
                    const hdr10PlusMatchRange = videoRangeType.match(hdr10PlusRegex);


                    if (hdr10PlusMatchTitle || hdr10PlusMatchRange) {
                        hdrTag = 'HDR10+';
                        qualities.add(hdrTag);
                    } else {
                        const hdr10MatchTitle = displayTitle.match(hdr10Regex);
                        const hdr10MatchRange = videoRangeType.match(hdr10Regex);

                        if (hdr10MatchTitle || hdr10MatchRange) {
                            hdrTag = 'HDR10';
                            qualities.add(hdrTag);
                        } else {
                            const hdrMatchTitle = displayTitle.match(hdrRegex);
                            const hdrMatchRange = videoRangeType.match(hdrRegex);

                            if (hdrMatchTitle || hdrMatchRange) {
                                hdrTag = 'HDR';
                                qualities.add(hdrTag);
                            }
                        }
                    }
                }
            }

            // --- AUDIO LOGIC ---
            let audioTag = null;

            for (let i = 0; i < audioStreams.length; i++) {
                const stream = audioStreams[i];

                // Priority 1: DisplayTitle Scan
                const displayTitle = stream.DisplayTitle || '';

                const atmosRegex = /atmos/i;
                const truehd = /truehd/i;
                const dtsxRegex = /dts-x/i;
                const dtsRegex = /\bdts\b/i;
                const ddpRegex = /dolby\s*digital\+/i;

                const atmosMatch = displayTitle.match(atmosRegex);
                const truehdMatch = displayTitle.match(truehd);
                const dtsxMatch = displayTitle.match(dtsxRegex);
                const dtsMatch = displayTitle.match(dtsRegex);
                const ddpMatch = displayTitle.match(ddpRegex);

                if (atmosMatch) {
                    audioTag = 'ATMOS';
                    qualities.add(audioTag);
                    break; // Stop all further audio checks
                } else if (truehdMatch) {
                    audioTag = 'TRUEHD';
                    qualities.add(audioTag);
                    break;
                } else if (dtsxMatch) {
                    audioTag = 'DTS-X';
                    qualities.add(audioTag);
                    break;
                } else if (dtsMatch) {
                    audioTag = 'DTS';
                    qualities.add(audioTag);
                    break;
                } else if (ddpMatch) {
                    audioTag = 'Dolby Digital+';
                    qualities.add(audioTag);
                    break;
                }
            }

            if (!audioTag) {

                // Priority 2: Technical Metadata Fallback
                for (let i = 0; i < audioStreams.length; i++) {
                    const stream = audioStreams[i];
                    const codec = (stream.Codec || '').toLowerCase();
                    const profile = (stream.Profile || '').toLowerCase();

                    if (codec.includes('truehd') || profile.includes('truehd')) {
                        if (codec.includes('atmos') || profile.includes('atmos')) {
                            audioTag = 'ATMOS';
                        } else {
                            audioTag = 'TRUEHD';
                        }
                        qualities.add(audioTag);
                        break;
                    } else if (codec.includes('dts')) {
                        if (codec.includes('x') || profile.includes('x')) {
                            audioTag = 'DTS-X';
                        } else {
                            audioTag = 'DTS';
                        }
                        qualities.add(audioTag);
                        break;
                    } else if (codec.includes('eac3') || codec.includes('ddp')) {
                        audioTag = 'Dolby Digital+';
                        qualities.add(audioTag);
                        break;
                    }
                }
            }

            if (!audioTag) {

                // Priority 3: Channel Layout Fallback
                let maxChannels = 0;
                audioStreams.forEach((stream, index) => {
                    const channels = stream.Channels || 0;
                    if (channels > maxChannels) {
                        maxChannels = channels;
                    }
                });

                if (maxChannels >= 8) {
                    audioTag = '7.1';
                    qualities.add(audioTag);
                } else if (maxChannels === 6) {
                    audioTag = '5.1';
                    qualities.add(audioTag);
                }
            }

            // --- 3D VIDEO LOGIC ---
            if (mediaSources) {
                for (const source of mediaSources) {
                    if (source.Path) {
                        const path = source.Path.toLowerCase();
                        const has3D = path.includes('3d');
                        const has3DFormat = /hsbs|fsbs|htab|ftab|mvc/.test(path);

                        if (has3D && has3DFormat) {
                            qualities.add('3D');
                            break; // Found 3D, no need to check other sources
                        }
                    }
                }
            }

            const finalTags = Array.from(qualities);
            return finalTags;
        }

        /**
         * Fetches quality information for a given item ID from the Jellyfin API.
         * For Series/Seasons, it fetches the first episode to determine quality.
         * @param {string} userId - The current user's ID.
         * @param {string} itemId - The ID of the item to fetch.
         * @returns {Promise<Array<string>|null>} A promise resolving to an array of quality tags or null.
         */
        async function fetchItemQuality(userId, itemId) {
            try {
                // Fetch the item with MediaStreams and MediaSources fields
                const item = await ApiClient.ajax({
                    type: "GET",
                    url: ApiClient.getUrl(`/Users/${userId}/Items/${itemId}`, { Fields: "MediaStreams,MediaSources,Type" }),
                    dataType: "json",
                    timeout: config.REQUEST_TIMEOUT
                });

                if (!item || !MEDIA_TYPES.has(item.Type)) return null;

                let qualities = [];

                if (item.Type === "Series" || item.Type === "Season") {
                    // For a series or season, find the first episode to represent the quality.
                    const episode = await fetchFirstEpisode(userId, item.Id);
                    if (episode) {
                        qualities = getEnhancedQuality(episode.MediaStreams, episode.MediaSources);
                    }
                } else {
                    qualities = getEnhancedQuality(item.MediaStreams, item.MediaSources);
                }

                if (qualities.length > 0) {
                    qualityOverlayCache[itemId] = { qualities, timestamp: Date.now() };
                    saveCache();
                    return qualities;
                }
                return null;
            } catch (error) {
                console.warn(`${logPrefix} API request failed for item ${itemId}`, error);
                throw error; // Propagate error to be handled by the queue processor
            }
        }

        /**
         * Fetches the first episode of a series to determine its quality.
         * @param {string} userId - The current user's ID.
         * @param {string} seriesId - The ID of the series.
         * @returns {Promise<object|null>} The first episode item or null.
         */
        async function fetchFirstEpisode(userId, seriesId) {
            try {
                const response = await ApiClient.ajax({
                    type: "GET",
                    url: ApiClient.getUrl("/Items", {
                        ParentId: seriesId,
                        IncludeItemTypes: "Episode",
                        Recursive: true,
                        SortBy: "PremiereDate",
                        SortOrder: "Ascending",
                        Limit: 1,
                        Fields: "MediaStreams,MediaSources",
                        userId: userId
                    }),
                    dataType: "json"
                });
                return response.Items?.[0] || null;
            } catch {
                return null;
            }
        }

        /**
         * Processes the request queue in batches to avoid overwhelming the server.
         */
        async function processRequestQueue() {
            if (isProcessingQueue || requestQueue.length === 0) return;
            isProcessingQueue = true;

            const batch = requestQueue.splice(0, config.MAX_CONCURRENT_REQUESTS);
            const promises = batch.map(async ({ element, itemId, userId, retryCount = 0 }) => {
                try {
                    const qualities = await fetchItemQuality(userId, itemId);
                    if (qualities) {
                        insertOverlay(element, qualities);
                    }
                } catch (error) {
                    // If the request fails, retry up to MAX_RETRIES times.
                    if (retryCount < config.MAX_RETRIES) {
                        requestQueue.push({ element, itemId, userId, retryCount: retryCount + 1 });
                    }
                }
            });

            await Promise.allSettled(promises);
            isProcessingQueue = false;

            // If there are more items, schedule the next batch.
            if (requestQueue.length > 0) {
                setTimeout(processRequestQueue, config.QUEUE_PROCESS_INTERVAL);
            }
        }

        // --- DOM MANIPULATION ---
        /**
         * Injects the quality tag container into the specified element.
         * @param {HTMLElement} container - The card/poster element to add tags to.
         * @param {Array<string>} qualities - The array of quality strings to display.
         */
        function insertOverlay(container, qualities) {
            if (!container || processedElements.has(container)) return;

            // Remove any old tags before adding new ones
            const existing = container.querySelector(`.${containerClass}`);
            if (existing) existing.remove();

            // Ensure the parent is positioned relatively for absolute positioning of the tags.
            if (getComputedStyle(container).position === 'static') {
                container.style.position = 'relative';
            }

            const qualityContainer = document.createElement('div');
            qualityContainer.className = containerClass;

            // Show only the best resolution tag
            const resolutions = qualities.filter(q => resolutionOrder.includes(q));
            if (resolutions.length > 1) {
                resolutions.sort((a, b) => resolutionOrder.indexOf(a) - resolutionOrder.indexOf(b));
                qualities = qualities.filter(q => !resolutionOrder.includes(q) || q === resolutions[0]);
            }

            const sortedQualities = qualities.sort((a, b) => {
                const aIsRes = resolutionOrder.includes(a);
                const bIsRes = resolutionOrder.includes(b);
                if (aIsRes && !bIsRes) return -1;
                if (!aIsRes && bIsRes) return 1;
                if (aIsRes && bIsRes) return resolutionOrder.indexOf(a) - resolutionOrder.indexOf(b);
                return featureOrder.indexOf(a) - featureOrder.indexOf(b);
            });

            sortedQualities.forEach((quality, index) => {
                const label = createResponsiveLabel(quality);
                label.style.animationDelay = `${index * 0.1}s`; // Staggered animation
                qualityContainer.appendChild(label);
            });

            container.appendChild(qualityContainer);
            processedElements.add(container);
        }

        /**
         * Extracts the Jellyfin item ID from a DOM element.
         * @param {HTMLElement} el - The element to inspect.
         * @returns {string|null} The found item ID or null.
         */
        function getItemIdFromElement(el) {
            // Check href, background-image, and data attributes recursively up the tree.
            if (el.href) {
                const match = el.href.match(/id=([a-f0-9]{32})/i);
                if (match) return match[1];
            }
            if (el.style.backgroundImage) {
                const match = el.style.backgroundImage.match(/\/Items\/([a-f0-9]{32})\//i);
                if (match) return match[1];
            }
            if (el.dataset?.itemid) return el.dataset.itemid;

            let parent = el.closest('[data-itemid]');
            return parent ? parent.dataset.itemid : null;
        }

        /**
         * Checks if an element should be ignored based on the IGNORE_SELECTORS list.
         * @param {HTMLElement} el - The element to check.
         * @returns {boolean} True if the element should be ignored.
         */
        function shouldIgnoreElement(el) {
            return IGNORE_SELECTORS.some(selector => {
                try {
                    return el.closest(selector) !== null;
                } catch {
                    return false; // Silently handle potential errors with complex selectors
                }
            });
        }

        /**
         * Main processing function for a single DOM element.
         * @param {HTMLElement} element - The element to process.
         * @param {boolean} isPriority - Whether to add the request to the front of the queue.
         */
        async function processElement(element, isPriority = false) {
            if (shouldIgnoreElement(element) || processedElements.has(element)) return;

            const itemId = getItemIdFromElement(element);
            if (!itemId) return;

            // 1. Check cache first
            const cached = qualityOverlayCache[itemId];
            if (cached && Date.now() - cached.timestamp < config.CACHE_TTL) {
                insertOverlay(element, cached.qualities);
                return;
            }

            // 2. If not cached, add to the request queue
            const userId = getUserId();
            if (!userId) return;

            const request = { element, itemId, userId };
            if (isPriority) {
                requestQueue.unshift(request); // High priority for visible items
            } else {
                requestQueue.push(request);
            }

            // 3. Trigger queue processing if not already running
            if (!isProcessingQueue) {
                setTimeout(processRequestQueue, isPriority ? 0 : config.QUEUE_PROCESS_INTERVAL);
            }
        }

        // --- EVENT HANDLERS & INITIALIZATION ---
        /**
         * Callback for the IntersectionObserver. Processes visible elements.
         * @param {Array<IntersectionObserverEntry>} entries - The observed entries.
         */
        function handleIntersection(entries) {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const el = entry.target;
                    visibilityObserver.unobserve(el);
                    processElement(el, true); // Prioritize visible elements
                }
            });
        }

        /**
         * A debounced function to scan the DOM for new items to tag.
         */
        function debouncedRender() {
            if (renderDebounceTimer) clearTimeout(renderDebounceTimer);
            renderDebounceTimer = setTimeout(renderVisibleTags, config.RENDER_DEBOUNCE);
        }

        /**
         * Scans the DOM for unprocessed poster/card elements and processes them.
         */
        function renderVisibleTags() {
            const elements = Array.from(document.querySelectorAll(
                'a.cardImageContainer, div.listItemImage'
            ));

            elements.forEach(el => {
                if (processedElements.has(el) || shouldIgnoreElement(el)) return;

                const rect = el.getBoundingClientRect();
                const isVisible = (
                    rect.top <= (window.innerHeight + 100) &&
                    rect.bottom >= -100
                );

                if (isVisible) {
                    processElement(el, true);
                } else {
                    visibilityObserver.observe(el);
                }
            });
        }

        /**
         * Sets up handlers to detect page navigation and trigger a re-scan.
         */
        function setupNavigationHandlers() {
            let currentUrl = window.location.href;
            const handleNavigation = () => {
                // Use a short delay to allow the new page's DOM to settle.
                setTimeout(() => {
                    if (window.location.href !== currentUrl) {
                        currentUrl = window.location.href;
                        processedElements = new WeakSet(); // Reset processed elements on navigation
                        requestQueue.length = 0;
                        debouncedRender();
                    }
                }, 500);
            };

            // Monkey-patch history API to detect SPA navigation
            const originalPushState = history.pushState;
            history.pushState = function (...args) {
                originalPushState.apply(this, args);
                handleNavigation();
            };
            window.addEventListener('popstate', handleNavigation);
        }

        /**
         * Injects the necessary CSS for styling the tags into the document head.
         */
        function addEnhancedStyles() {
            let style = document.getElementById('quality-tag-enhanced-style');
            if (style) style.remove(); // Remove old style to ensure updates are applied

            style = document.createElement('style');
            style.id = 'quality-tag-enhanced-style';

            // Generate CSS rules from the color configuration
            const rules = Object.entries(qualityColors).map(([k, v]) => {
                return `.${containerClass} .${overlayClass}[data-quality="${k}"] {
                    background: ${v.bg} !important;
                    color: ${v.text} !important;
                }`;
            }).join("\n");

            style.textContent = `
                .${containerClass} {
                    position: absolute;
                    top: 6px;
                    left: 6px;
                    display: flex;
                    flex-direction: column;
                    gap: 3px;
                    align-items: flex-start;
                    z-index: 100;
                    max-width: calc(100% - 12px);
                }
                .${overlayClass} {
                    font-weight: bold;
                    border-radius: 6px;
                    padding: 2px 12px;
                    font-size: 0.8rem;
                    user-select: none;
                    pointer-events: none;
                    font-variant-caps: small-caps;
                    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
                    border: 1px solid rgba(255,255,255,0.2);
                    backdrop-filter: blur(4px);
                    opacity: 0;
                    transform: translateY(-4px);
                    animation: qualityTagFadeIn 0.3s ease forwards;
                }
                @keyframes qualityTagFadeIn {
                    to { opacity: 1; transform: translateY(0); }
                }
                /* Generic style for low resolution content */
                .${containerClass} .${overlayClass}[data-quality="LOW-RES"] {
                    background: rgba(128, 128, 128, 0.8) !important;
                    color: #ffffff !important;
                }
                ${rules}
            `;
            document.head.appendChild(style);
        }

        /**
         * Main initialization function for the script.
         */
        function initialize() {
            cleanupOldCaches();
            addEnhancedStyles();
            setupNavigationHandlers();
            setTimeout(renderVisibleTags, 1000); // Initial run after page load

            // Set up the MutationObserver to watch for dynamically added content
            const mutationObserver = new MutationObserver(() => {
                if (mutationDebounceTimer) clearTimeout(mutationDebounceTimer);
                mutationDebounceTimer = setTimeout(debouncedRender, config.MUTATION_DEBOUNCE);
            });
            mutationObserver.observe(document.body, { childList: true, subtree: true });

            // Set up cleanup and cache saving
            window.addEventListener('beforeunload', () => {
                saveCache();
                mutationObserver.disconnect();
                visibilityObserver.disconnect();
            });
            setInterval(saveCache, 120000); // Periodically save cache every 2 minutes
        }

        // --- SCRIPT EXECUTION ---
        initialize();
        console.log(`${logPrefix} Initialized successfully.`);
    };

})(window.JellyfinEnhanced);

