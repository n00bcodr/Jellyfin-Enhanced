// /js/tags/qualitytags.js
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
        const TAGGED_ATTR = 'jeQualityTagged';
        // Use static cache key (not version-based) to persist across plugin updates
        const CACHE_KEY = 'JellyfinEnhanced-qualityTagsCache';
        const CACHE_TIMESTAMP_KEY = 'JellyfinEnhanced-qualityTagsCacheTimestamp';

        // CSS selectors for elements that should NOT have quality tags applied.
        // This is used to ignore certain views like the cast & crew list.
        const IGNORE_SELECTORS = [
            '#itemDetailPage .infoWrapper .cardImageContainer',
            '#itemDetailPage #castCollapsible .cardImageContainer',
            '#indexPage .verticalSection.MyMedia .cardImageContainer',
            '.formDialog .cardImageContainer',
            '#itemDetailPage .chapterCardImageContainer',
            // Admin/dashboard pages
            '#pluginsPage .cardImageContainer',
            '#pluginsPage .card',
            '#pluginCatalogPage .cardImageContainer',
            '#pluginCatalogPage .card',
            '#devicesPage .cardImageContainer',
            '#devicesPage .card',
            '#mediaLibraryPage .cardImageContainer',
            '#mediaLibraryPage .card'
        ];

        // Add search page to ignore list if configured (Gelato compatibility)
        if (JE.pluginConfig?.DisableTagsOnSearchPage === true) {
            IGNORE_SELECTORS.push('#searchPage .cardImageContainer');
        }

        // The types of Jellyfin items that are eligible for quality tags.
        const MEDIA_TYPES = new Set(['Movie', 'Episode', 'Series', 'Season']);

        // Sort tags for consistent display order (Resolution > Codec > Features)
        const resolutionOrder = ['8K', '4K', '1440p', '1080p', '720p', '480p', 'LOW-RES', 'SD'];
        const codecOrder = ['AV1', 'HEVC', 'H265', 'VP9', 'H264', 'VP8', 'XVID', 'DIVX', 'WMV', 'MPEG2', 'MPEG4', 'MJPEG', 'THEORA'];
        const videoOrder = ['IMAX', 'Dolby Vision', 'HDR10+', 'HDR10', 'HDR', '3D'];
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
            'IMAX': { bg: 'rgba(0, 114, 206, 0.9)', text: '#ffffff' },
            'ATMOS': { bg: 'rgba(0, 100, 255, 0.9)', text: '#ffffff' },
            'DTS-X': { bg: 'rgba(255, 100, 0, 0.9)', text: '#ffffff' },
            'DTS': { bg: 'rgba(255, 140, 0, 0.85)', text: '#ffffff' },
            'Dolby Digital+': { bg: 'rgba(0, 150, 136, 0.9)', text: '#ffffff' },
            'TRUEHD': { bg: 'rgba(76, 175, 80, 0.9)', text: '#ffffff' },
            '7.1': { bg: 'rgba(156, 39, 176, 0.9)', text: '#ffffff' },
            '5.1': { bg: 'rgba(103, 58, 183, 0.9)', text: '#ffffff' },
            '3D': { bg: 'rgba(0, 150, 255, 0.9)', text: '#ffffff' },
            'AV1': { bg: 'rgba(255, 87, 34, 0.95)', text: '#ffffff' },
            'HEVC': { bg: 'rgba(33, 150, 243, 0.9)', text: '#ffffff' },
            'H265': { bg: 'rgba(63, 81, 181, 0.9)', text: '#ffffff' },
            'VP9': { bg: 'rgba(156, 39, 176, 0.9)', text: '#ffffff' },
            'H264': { bg: 'rgba(76, 175, 80, 0.9)', text: '#ffffff' },
            'VP8': { bg: 'rgba(121, 85, 72, 0.9)', text: '#ffffff' },
            'XVID': { bg: 'rgba(255, 152, 0, 0.9)', text: '#ffffff' },
            'DIVX': { bg: 'rgba(255, 193, 7, 0.9)', text: '#000000' },
            'WMV': { bg: 'rgba(0, 188, 212, 0.9)', text: '#ffffff' },
            'MPEG2': { bg: 'rgba(96, 125, 139, 0.9)', text: '#ffffff' },
            'MPEG4': { bg: 'rgba(158, 158, 158, 0.9)', text: '#ffffff' },
            'MJPEG': { bg: 'rgba(233, 30, 99, 0.9)', text: '#ffffff' },
            'THEORA': { bg: 'rgba(139, 195, 74, 0.9)', text: '#ffffff' }
        };

        // --- CONFIGURATION ---
        const config = {
            MAX_CONCURRENT_REQUESTS: 4,      // Max number of simultaneous API requests.
            QUEUE_PROCESS_INTERVAL: 400,   // Delay between processing batches from the queue.
            MUTATION_DEBOUNCE: 600,        // Delay to wait for DOM changes to settle before processing.
            RENDER_DEBOUNCE: 400,          // Delay for re-rendering tags on navigation.
            CACHE_TTL: (JE.pluginConfig?.TagsCacheTtlDays || 30) * 24 * 60 * 60 * 1000, // Cache TTL from server config (default 30 days)
            REQUEST_TIMEOUT: 8000,           // Timeout for API requests.
            MAX_RETRIES: 2                     // Number of times to retry a failed API request.
        };

        // --- STATE VARIABLES ---
        let qualityOverlayCache = JSON.parse(localStorage.getItem(CACHE_KEY)) || {};
        // Hot, in-memory cache shared across modules to avoid repeated deserialization and cold reads
        const Hot = (JE._hotCache = JE._hotCache || {
            ttl: config.CACHE_TTL,
            quality: new Map(),
            genre: new Map()
        });
        let processedElements = new WeakSet(); // Stores elements that have been processed to avoid re-work.
        let requestQueue = []; // A queue for API requests to avoid server overload.
        let isProcessingQueue = false;
        const queuedItemIds = new Set(); // De-duplicate queued requests per itemId
        let mutationDebounceTimer = null;
        let renderDebounceTimer = null;

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
         * Also checks if server has triggered a cache clear.
         */
        function cleanupOldCaches() {
            // Remove old version-based cache keys and legacy cache keys
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && (key.startsWith('qualityOverlayCache-') || key === 'qualityOverlayCache' || key === 'qualityOverlayCacheTimestamp') && key !== CACHE_KEY && key !== CACHE_TIMESTAMP_KEY) {
                    console.log(`${logPrefix} Removing old cache: ${key}`);
                    localStorage.removeItem(key);
                }
            }

            // Check if server has triggered a cache clear
            const serverClearTimestamp = JE.pluginConfig?.ClearLocalStorageTimestamp || 0;
            const localCacheTimestamp = parseInt(localStorage.getItem(CACHE_TIMESTAMP_KEY) || '0', 10);

            if (serverClearTimestamp > localCacheTimestamp) {
                console.log(`${logPrefix} Server triggered cache clear (${new Date(serverClearTimestamp).toISOString()})`);
                localStorage.removeItem(CACHE_KEY);
                localStorage.setItem(CACHE_TIMESTAMP_KEY, serverClearTimestamp.toString());
                qualityOverlayCache = {};
                // Clear hot cache too
                if (JE._hotCache?.quality) JE._hotCache.quality.clear();
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
            } else if (codecOrder.includes(label)) {
                badge.classList.add('video-format');
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
         * @param {Object} [itemData] - Optional item metadata for filename/title signals.
         * @returns {Array<string>} A list of detected quality tags.
         */
        function getEnhancedQuality(mediaStreams, mediaSources, itemData = null) {
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

            // --- IMAX TAG LOGIC ---
            // Pattern sources:
            // - TRaSH Guides IMAX CF regex (NON-IMAX exclusion + IMAX token)
            // - Dictionarry-Hub IMAX / IMAX Enhanced patterns
            // We gather multiple title/name/path signals since IMAX often appears in file names.
            const imaxSignals = [];
            if (itemData) {
                imaxSignals.push(
                    itemData.Name || '',
                    itemData.OriginalTitle || '',
                    itemData.SortName || '',
                    itemData.EditionTitle || '',
                    itemData.ForcedSortName || ''
                );
            }
            if (Array.isArray(mediaSources)) {
                mediaSources.forEach((source) => {
                    imaxSignals.push(source?.Path || '', source?.Name || '');
                });
            }
            if (Array.isArray(mediaStreams)) {
                mediaStreams.forEach((stream) => {
                    imaxSignals.push(stream?.DisplayTitle || '', stream?.Title || '');
                });
            }

            const imaxContext = imaxSignals.filter(Boolean).join(' | ');
            const nonImaxRegex = /\bNON[ ._-]?IMAX\b/i;
            const imaxRegex = /\bIMAX(?:[ ._-]?ENHANCED)?\b/i;
            if (imaxContext && imaxRegex.test(imaxContext) && !nonImaxRegex.test(imaxContext)) {
                qualities.add('IMAX');
            }

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

            // --- VIDEO CODEC LOGIC ---
            // Map codec to standard names and add to qualities
            if (primaryVideoStream) {
                const codec = (primaryVideoStream.Codec || '').toLowerCase();
                const codecTag = (primaryVideoStream.CodecTag || '').toLowerCase();
                let detectedCodec = null;

                // Priority 1: Check actual codec field
                if (codec.includes('hevc')) {
                    detectedCodec = 'HEVC';
                } else if (codec.includes('h265')) {
                    detectedCodec = 'H265';
                } else if (codec.includes('h264') || codec.includes('avc') || codecTag.includes('avc')) {
                    detectedCodec = 'H264';
                } else if (codec.includes('av1')) {
                    detectedCodec = 'AV1';
                } else if (codec.includes('vp9')) {
                    detectedCodec = 'VP9';
                } else if (codec.includes('vp8')) {
                    detectedCodec = 'VP8';
                } else if (codec.includes('xvid')) {
                    detectedCodec = 'XVID';
                } else if (codec.includes('divx')) {
                    detectedCodec = 'DIVX';
                } else if (codec.includes('wmv') || codec.includes('vc1')) {
                    detectedCodec = 'WMV';
                } else if (codec.includes('mpeg2')) {
                    detectedCodec = 'MPEG2';
                } else if (codec.includes('mpeg4')) {
                    detectedCodec = 'MPEG4';
                } else if (codec.includes('mjpeg')) {
                    detectedCodec = 'MJPEG';
                } else if (codec.includes('theora')) {
                    detectedCodec = 'THEORA';
                }

                // Priority 2: Fallback to display title if codec field didn't match
                if (!detectedCodec) {
                    const displayTitle = (primaryVideoStream.DisplayTitle || '').toLowerCase();
                    if (displayTitle.includes('hevc')) {
                        detectedCodec = 'HEVC';
                    } else if (displayTitle.includes('h265')) {
                        detectedCodec = 'H265';
                    } else if (displayTitle.includes('h264') || displayTitle.includes('avc')) {
                        detectedCodec = 'H264';
                    } else if (displayTitle.includes('av1')) {
                        detectedCodec = 'AV1';
                    } else if (displayTitle.includes('vp9')) {
                        detectedCodec = 'VP9';
                    } else if (displayTitle.includes('vp8')) {
                        detectedCodec = 'VP8';
                    } else if (displayTitle.includes('xvid')) {
                        detectedCodec = 'XVID';
                    } else if (displayTitle.includes('divx')) {
                        detectedCodec = 'DIVX';
                    } else if (displayTitle.includes('wmv') || displayTitle.includes('vc1')) {
                        detectedCodec = 'WMV';
                    } else if (displayTitle.includes('mpeg2')) {
                        detectedCodec = 'MPEG2';
                    } else if (displayTitle.includes('mpeg4')) {
                        detectedCodec = 'MPEG4';
                    } else if (displayTitle.includes('mjpeg')) {
                        detectedCodec = 'MJPEG';
                    } else if (displayTitle.includes('theora')) {
                        detectedCodec = 'THEORA';
                    }
                }

                if (detectedCodec) {
                    qualities.add(detectedCodec);
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
                    const hdr10PlusRegex = /hdr10plus/i;
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

            return Array.from(qualities);
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
                    url: ApiClient.getUrl(`/Users/${userId}/Items/${itemId}`, { Fields: "MediaStreams,MediaSources,Type,Genres" }),
                    dataType: "json",
                    timeout: config.REQUEST_TIMEOUT
                });

                if (!item || !MEDIA_TYPES.has(item.Type)) return null;

                let qualities = [];

                if (item.Type === "Series" || item.Type === "Season") {
                    // For a series or season, find the first episode to represent the quality.
                    const episode = await fetchFirstEpisode(userId, item.Id);
                    if (episode) {
                        qualities = getEnhancedQuality(episode.MediaStreams, episode.MediaSources, episode);
                    }
                } else {
                    qualities = getEnhancedQuality(item.MediaStreams, item.MediaSources, item);
                }

                if (qualities.length > 0) {
                    qualityOverlayCache[itemId] = { qualities, timestamp: Date.now() };
                    // Seed hot cache
                    Hot.quality.set(itemId, { qualities, timestamp: Date.now() });
                    if (JE._cacheManager) JE._cacheManager.markDirty();
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
                        queuedItemIds.delete(itemId);
                    }
                } catch (error) {
                    // If the request fails, retry up to MAX_RETRIES times.
                    if (retryCount < config.MAX_RETRIES) {
                        requestQueue.push({ element, itemId, userId, retryCount: retryCount + 1 });
                    } else {
                        // Give up after final retry
                        queuedItemIds.delete(itemId);
                    }
                }
            });

            await Promise.allSettled(promises);
            isProcessingQueue = false;

            // If there are more items, schedule the next batch with deferred execution
            if (requestQueue.length > 0) {
                if (typeof requestIdleCallback !== 'undefined') {
                    requestIdleCallback(() => processRequestQueue(), { timeout: config.QUEUE_PROCESS_INTERVAL });
                } else {
                    setTimeout(processRequestQueue, config.QUEUE_PROCESS_INTERVAL);
                }
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
                const aIsCodec = codecOrder.includes(a);
                const bIsCodec = codecOrder.includes(b);
                const aIsFeat = featureOrder.includes(a);
                const bIsFeat = featureOrder.includes(b);

                // Resolution first
                if (aIsRes && !bIsRes) return -1;
                if (!aIsRes && bIsRes) return 1;
                if (aIsRes && bIsRes) return resolutionOrder.indexOf(a) - resolutionOrder.indexOf(b);

                // Codec second
                if (aIsCodec && !bIsCodec) return -1;
                if (!aIsCodec && bIsCodec) return 1;
                if (aIsCodec && bIsCodec) return codecOrder.indexOf(a) - codecOrder.indexOf(b);

                // Features last
                return featureOrder.indexOf(a) - featureOrder.indexOf(b);
            });

            sortedQualities.forEach((quality) => {
                const label = createResponsiveLabel(quality);
                qualityContainer.appendChild(label);
            });

            container.appendChild(qualityContainer);
            markCardTagged(container);
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
                    if (el.matches(selector)) return true;
                    return el.closest(selector) !== null;
                } catch {
                    return false; // Silently handle potential errors with complex selectors
                }
            });
        }

        function isCardAlreadyTagged(el) {
            const card = el.closest('.card');
            if (!card) return false;
            const hasAttr = card.dataset?.[TAGGED_ATTR] === '1';
            const hasOverlay = !!card.querySelector(`.${containerClass}`);
            return hasAttr && hasOverlay;
        }

        function markCardTagged(el) {
            const card = el.closest('.card');
            if (card) card.dataset[TAGGED_ATTR] = '1';
        }

        /**
         * Main processing function for a single DOM element.
         * @param {HTMLElement} element - The element to process.
         * @param {boolean} isPriority - Whether to add the request to the front of the queue.
         */
        async function processElement(element, isPriority = false) {
            if (shouldIgnoreElement(element) || processedElements.has(element)) return;

            // Skip if this card already has quality tags attached (prevents hover-duplication)
            if (isCardAlreadyTagged(element)) {
                processedElements.add(element);
                return;
            }

            const itemId = getItemIdFromElement(element);
            if (!itemId) return;

            // 1. Check cache first
            // Hot cache first
            const hot = Hot.quality.get(itemId);
            if (hot && (Date.now() - hot.timestamp) < config.CACHE_TTL) {
                insertOverlay(element, hot.qualities);
                return;
            }
            // Fallback to persisted cache if present
            const cached = qualityOverlayCache[itemId];
            if (cached && Date.now() - cached.timestamp < config.CACHE_TTL) {
                Hot.quality.set(itemId, cached);
                insertOverlay(element, cached.qualities);
                return;
            }

            // 2. If not cached, add to the request queue
            const userId = getUserId();
            if (!userId) return;

            // Avoid enqueuing duplicate work for the same itemId
            if (queuedItemIds.has(itemId)) return;
            queuedItemIds.add(itemId);

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
                '.cardImageContainer, div.listItemImage'
            ));

            elements.forEach(el => {
                if (processedElements.has(el) || shouldIgnoreElement(el)) return;
                // Rely on IntersectionObserver to trigger when elements scroll into view
                visibilityObserver.observe(el);
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
                        // Check if feature is still enabled before processing
                        if (!JE.currentSettings?.qualityTagsEnabled) {
                            return;
                        }
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

            const pos = (window.JellyfinEnhanced?.currentSettings?.qualityTagsPosition || window.JellyfinEnhanced?.pluginConfig?.QualityTagsPosition || 'top-left');
            const isTop = pos.includes('top');
            const isLeft = pos.includes('left');
            const topVal = isTop ? '6px' : 'auto';
            const bottomVal = isTop ? 'auto' : '6px';
            const leftVal = isLeft ? '6px' : 'auto';
            const rightVal = isLeft ? 'auto' : '6px';
            const needsTopRightOffset = isTop && !isLeft; // top-right

            style.textContent = `
                .${containerClass} {
                    position: absolute;
                    top: ${topVal};
                    right: ${rightVal};
                    bottom: ${bottomVal};
                    left: ${leftVal};
                    display: flex;
                    flex-direction: column;
                    gap: 4px;
                    align-items: ${isLeft ? 'flex-start' : 'flex-end'};
                    z-index: 100;
                    max-width: calc(100% - 12px);
                    max-height: 90%;
                    overflow: hidden;
                    pointer-events: none;
                }
                ${needsTopRightOffset ? `.cardImageContainer .cardIndicators ~ .${containerClass} { margin-top: clamp(20px, 3vw, 30px); }` : ''}
                .${overlayClass} {
                    font-weight: bold;
                    border-radius: 5px;
                    padding: 2px 10px;
                    font-size: clamp(0.65rem, 2vw, 0.85rem);
                    user-select: none;
                    pointer-events: none;
                    font-variant-caps: small-caps;
                    box-shadow: 0 1px 4px rgba(0,0,0,0.4);
                    border: 1px solid rgba(255,255,255,0.15);
                    backdrop-filter: blur(4px);
                    opacity: 1;
                    transform: translateY(0);
                    white-space: nowrap;
                    flex-shrink: 0;
                    line-height: 1.2;
                }
                .layout-mobile .${overlayClass} {
                    padding: 0px 6px;
                    font-size: 0.65rem;
                    border-radius: 3px;
                }
                .layout-mobile .${containerClass} {
                    gap: 2px;
                }
                @media (min-width: 1440px) {
                    .${overlayClass} {
                        padding: 3px 12px;
                        font-size: 0.9rem;
                        border-radius: 6px;
                    }
                    .${containerClass} {
                        gap: 6px;
                    }
                }
                @media (max-width: 768px) {
                    .${overlayClass} {
                        padding: 0px 6px;
                        font-size: 0.65rem;
                        border-radius: 3px;
                    }
                    .${containerClass} {
                        gap: 1px;
                    }
                }
                @media (max-width: 480px) {
                    .${overlayClass} {
                        padding: 0px 5px;
                        font-size: 0.6rem;
                        border-radius: 2px;
                        box-shadow: 0 1px 3px rgba(0,0,0,0.4);
                    }
                    .${containerClass} {
                        gap: 1px;
                        max-height: 85%;
                    }
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

            // Use centralized observer management from helpers
            if (JE.helpers?.createObserver) {
                JE.helpers.createObserver('quality-tags-mutations', () => {
                    if (!JE.currentSettings?.qualityTagsEnabled) return;
                    debouncedRender();
                }, document.body, { childList: true, subtree: true });
            } else {
                // Fallback for older versions
                const mutationObserver = new MutationObserver(() => {
                    if (!JE.currentSettings?.qualityTagsEnabled) return;
                    debouncedRender();
                });
                mutationObserver.observe(document.body, { childList: true, subtree: true });
                window.addEventListener('beforeunload', () => mutationObserver.disconnect());
            }

            // Set up cleanup and cache saving
            window.addEventListener('beforeunload', () => {
                saveCache();
                visibilityObserver.disconnect();
                if (JE.helpers?.disconnectObserver) {
                    JE.helpers.disconnectObserver('quality-tags-mutations');
                }
            });
            // Register with unified cache manager instead of setInterval
            if (JE._cacheManager) {
                JE._cacheManager.register(saveCache);
            }
        }

        // --- SCRIPT EXECUTION ---
        initialize();
        console.log(`${logPrefix} Initialized successfully.`);
    };

    /**
     * Re-initializes the Quality Tags feature
     * Cleans up existing state and re-applies tags.
     */
    JE.reinitializeQualityTags = function() {
        const logPrefix = '🪼 Jellyfin Enhanced: Quality Tags:';
        console.log(`${logPrefix} Re-initializing...`);

        // Always remove existing tags first
        document.querySelectorAll('.quality-overlay-container').forEach(el => el.remove());

        if (!JE.currentSettings.qualityTagsEnabled) {
            console.log(`${logPrefix} Feature is disabled after reinit.`);
            return;
        }

        // Trigger a fresh initialization which will set up everything with current settings
        JE.initializeQualityTags();
    };

})(window.JellyfinEnhanced);
