/**
 * @file Spoiler Mode Core — per-user, per-item spoiler protection for Jellyfin Enhanced.
 *
 * This is the core module providing shared state, constants, data management,
 * boundary computation, and cache helpers. Sub-modules (redaction, surfaces,
 * observer) register their functions via JE._spoilerCore.
 *
 * Load order: spoiler-mode.js → spoiler-mode-redaction.js → spoiler-mode-surfaces.js → spoiler-mode-observer.js
 */
(function (JE) {
    'use strict';

    // ============================================================
    // Constants
    // ============================================================

    /** Debounce interval for persisting spoiler mode data. */
    var SAVE_DEBOUNCE_MS = 500;

    /** How long a tap-to-reveal stays visible (ms). */
    var DEFAULT_REVEAL_DURATION = 10000;

    /** How long "Reveal All" keeps everything visible (ms). */
    var REVEAL_ALL_DURATION = 30000;

    /** CSS blur radius for spoiler-protected thumbnails. */
    var BLUR_RADIUS = '30px';

    /** Cache TTL for boundary data (5 minutes). */
    var BOUNDARY_CACHE_TTL = 5 * 60 * 1000;

    /** Debounce interval for the MutationObserver card filter. */
    var FILTER_DEBOUNCE_MS = 50;

    /** Initial filter delay after module initialization. */
    var INIT_FILTER_DELAY_MS = 200;

    /** Delay for detail page re-scans (async episode loading). */
    var DETAIL_RESCAN_DELAY_MS = 500;

    /** Final detail page re-scan delay. */
    var DETAIL_FINAL_RESCAN_DELAY_MS = 1500;

    /** First delayed re-application for late-rendered detail page elements. */
    var LATE_RENDER_FIRST_DELAY_MS = 800;

    /** Final delayed re-application for late-rendered detail page elements. */
    var LATE_RENDER_FINAL_DELAY_MS = 2000;

    /** Delay after toggling spoiler mode before re-scanning the page. */
    var TOGGLE_RESCAN_DELAY_MS = 300;

    /** Long-press threshold for mobile tap-to-reveal (ms). */
    var LONG_PRESS_THRESHOLD_MS = 300;

    /** Delay before redacting player OSD after navigation (ms). */
    var PLAYER_OSD_DELAY_MS = 500;

    /** Debounce interval for player OSD redaction on mutations (ms). */
    var OSD_MUTATION_DEBOUNCE_MS = 200;

    /** Maximum entries in each cache before LRU eviction. */
    var MAX_CACHE_SIZE = 50;

    /** Maximum concurrent boundary API requests. */
    var MAX_CONCURRENT_BOUNDARY_REQUESTS = 4;

    /** Data attribute marking a card as already processed by spoiler mode. */
    var PROCESSED_ATTR = 'data-je-spoiler-checked';

    /** Data attribute set when async processing is fully complete (prevents spoiler flash). */
    var SCANNED_ATTR = 'data-je-spoiler-scanned';

    /** Data attribute marking a card as spoiler-redacted. */
    var REDACTED_ATTR = 'data-je-spoiler-redacted';

    /** Body class toggled while detail-page overview redaction is pending. */
    var DETAIL_OVERVIEW_PENDING_CLASS = 'je-spoiler-detail-pending';

    /** Class marking overview text as manually revealed during spoiler mode. */
    var OVERVIEW_REVEALED_CLASS = 'je-spoiler-overview-revealed';

    /** Selector for any spoiler-processable card/list-item (excludes chapter cards). */
    var CARD_SEL = '.card[data-id]:not(.chapterCard), .card[data-itemid]:not(.chapterCard), .listItem[data-id]';

    /** Selector for not-yet-scanned cards (excludes chapter cards). */
    var CARD_SEL_NEW = '.card[data-id]:not([data-je-spoiler-checked]):not(.chapterCard), .card[data-itemid]:not([data-je-spoiler-checked]):not(.chapterCard), .listItem[data-id]:not([data-je-spoiler-checked])';

    /** GUID format validation for Jellyfin item IDs. */
    var GUID_RE = /^[0-9a-f]{32}$/i;

    /** Default setting values (flat — no presets). */
    var SETTING_DEFAULTS = {
        artworkPolicy: 'blur',
        protectHome: true,
        protectSearch: true,
        protectOverlay: true,
        protectCalendar: true,
        protectRecentlyAdded: true,
        protectEpisodeDetails: true,
        hideRuntime: false,
        hideAirDate: false,
        hideGuestStars: false,
        showSeriesOverview: false,
        revealDuration: DEFAULT_REVEAL_DURATION
    };

    /**
     * Known legacy revealDuration values stored in seconds.
     * These exact values are converted to milliseconds on load.
     */
    var LEGACY_SECOND_VALUES = new Set([5, 10, 15, 30, 60]);

    /** Selectors for finding the detail page button container. */
    var BUTTON_CONTAINER_SELECTORS = [
        '.detailButtons',
        '.itemActionsBottom',
        '.mainDetailButtons',
        '.detailButtonsContainer'
    ];

    // ============================================================
    // State
    // ============================================================

    /** The in-memory spoiler mode data object. */
    var spoilerData = null;

    /** The user ID that owns the current spoilerData (prevents cross-user saves). */
    var spoilerDataOwnerId = null;

    /** Save debounce timer. */
    var saveTimeout = null;

    /** LRU cache for spoiler boundary data per series. */
    var boundaryCache = new Map();

    /** In-flight boundary requests to prevent duplicate fetches. */
    var boundaryRequestMap = new Map();

    /** Number of currently active boundary API requests (for throttling). */
    var activeBoundaryRequests = 0;

    /** Queue of resolve callbacks waiting for a boundary request slot. */
    var boundaryQueue = [];

    /** Set of series/movie IDs that have spoiler mode enabled. */
    var protectedIdSet = new Set();

    /** LRU cache of parent series ID lookups for episode/season cards. */
    var parentSeriesCache = new Map();

    /** In-flight parent series requests. */
    var parentSeriesRequestMap = new Map();

    /** LRU cache for movie watched state. */
    var movieWatchedCache = new Map();

    /** In-flight movie watched requests. */
    var movieWatchedRequestMap = new Map();

    /** LRU cache for season fully-watched state. */
    var seasonWatchedCache = new Map();

    /** In-flight season watched requests. */
    var seasonWatchedRequestMap = new Map();

    /** Cache of episode data by series: seriesId → Map<episodeId, episodeData>. */
    var episodeDataCache = new Map();

    /** LRU cache for collection item listings. */
    var collectionItemsCache = new Map();

    /** In-flight collection items requests. */
    var collectionItemsRequestMap = new Map();

    /** Reverse lookup: movieId → Set<collectionId>. */
    var collectionMemberMap = new Map();

    /** Set of protected BoxSet IDs. */
    var protectedCollectionIds = new Set();

    /** Whether "Reveal All" is currently active. */
    var revealAllActive = false;

    /** Timer for "Reveal All" auto-hide. */
    var revealAllTimer = null;

    /** Interval for "Reveal All" countdown banner. */
    var revealAllCountdownInterval = null;

    /** WeakMap caching surface context for DOM sections. */
    var sectionSurfaceCache = new WeakMap();

    /** The single unified MutationObserver for all DOM watching. */
    var unifiedObserver = null;

    /** Timer IDs from onViewPage navigation callbacks. */
    var navigationTimers = [];

    /** Guard variables for detail page observer. */
    var lastDetailPageItemId = null;
    var detailPageProcessing = false;

    // ============================================================
    // Internal helpers
    // ============================================================

    /**
     * Validates a Jellyfin item ID as a 32-character hex GUID.
     * @param {string} id The ID to validate.
     * @returns {boolean} True if the ID is a valid GUID.
     */
    function isValidId(id) {
        return typeof id === 'string' && GUID_RE.test(id);
    }

    function shouldPrehideDetailOverview() {
        if (revealAllActive) return false;
        if (protectedIdSet.size === 0) return false;
        return !getSettings().showSeriesOverview;
    }

    function shouldSkipDetailOverviewPrehide(visiblePage) {
        if (!visiblePage) return false;
        var overviewEl = visiblePage.querySelector('.overview, .itemOverview');
        if (!overviewEl) return false;

        var hash = window.location.hash || '';
        var params = new URLSearchParams(hash.split('?')[1]);
        var detailItemId = params.get('id') || '';

        if (overviewEl.dataset.jeSpoilerOverviewSafeFor === detailItemId && detailItemId) return true;

        if (detailItemId) {
            var cached = seasonWatchedCache.get(detailItemId);
            if (cached && cached.watched === true && (Date.now() - cached.ts) < BOUNDARY_CACHE_TTL) {
                return true;
            }
        }

        if (overviewEl.classList.contains(OVERVIEW_REVEALED_CLASS)) return true;
        var revealUntil = Number(overviewEl.dataset.jeSpoilerRevealUntil || '0');
        return revealUntil > Date.now();
    }

    function setDetailOverviewPending(pending) {
        if (!document.body?.classList) return;
        if (pending) {
            document.body.classList.add(DETAIL_OVERVIEW_PENDING_CLASS);
        } else {
            document.body.classList.remove(DETAIL_OVERVIEW_PENDING_CLASS);
        }
    }

    /**
     * Evicts the oldest entry from a Map cache if it exceeds maxSize.
     * @param {Map} cache The Map to check.
     * @param {number} maxSize Maximum allowed entries.
     */
    function evictIfNeeded(cache, maxSize) {
        if (cache.size <= maxSize) return;
        var firstKey = cache.keys().next().value;
        cache.delete(firstKey);
    }

    /**
     * Escapes a string for safe insertion into HTML.
     * @param {string} str The string to escape.
     * @returns {string} The HTML-escaped string.
     */
    function escapeHtml(str) {
        var div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    /**
     * Returns a translated string, falling back to the provided default if the
     * translation key is not found.
     * @param {string} key The i18n key.
     * @param {string} fallback The fallback string.
     * @returns {string} The translated or fallback string.
     */
    function tFallback(key, fallback) {
        var translated = JE.t(key);
        return translated !== key ? translated : fallback;
    }

    /**
     * Finds the action button container on a detail page.
     * @param {HTMLElement} visiblePage The visible detail page element.
     * @returns {HTMLElement|null} The button container or null.
     */
    function findButtonContainer(visiblePage) {
        for (var i = 0; i < BUTTON_CONTAINER_SELECTORS.length; i++) {
            var found = visiblePage.querySelector(BUTTON_CONTAINER_SELECTORS[i]);
            if (found) return found;
        }
        return null;
    }

    /**
     * Extracts the Jellyfin item ID from a card element.
     * @param {HTMLElement} el The card element.
     * @returns {string|null} The item ID or null.
     */
    function getCardItemId(el) {
        return el.dataset?.id || el.dataset?.itemid || null;
    }

    /**
     * Applies inline blur filter to a DOM element (for backdrops and posters).
     * Skips if the element already has a filter applied.
     * @param {HTMLElement} el The element to blur.
     */
    function blurElement(el) {
        if (!el || el.style.filter) return;
        el.style.filter = 'blur(' + BLUR_RADIUS + ')';
        el.style.transition = 'filter 0.3s ease';
    }

    // ============================================================
    // Data normalization & persistence
    // ============================================================

    function normalizeRuleEntry(key, entry) {
        var raw = entry || {};
        return {
            itemId: raw.itemId || key,
            itemName: raw.itemName || raw.name || '',
            itemType: raw.itemType || raw.type || '',
            enabled: raw.enabled !== false,
            boundaryOverride: raw.boundaryOverride || null,
            enabledAt: raw.enabledAt || new Date().toISOString()
        };
    }

    function rulesToItems(rules) {
        var result = {};
        var source = rules || {};
        for (var key of Object.keys(source)) {
            var rule = source[key];
            if (!rule || rule.enabled === false) continue;
            result[key] = {
                itemId: rule.itemId || key,
                name: rule.itemName || '',
                type: rule.itemType || '',
                enabledAt: rule.enabledAt || new Date().toISOString()
            };
        }
        return result;
    }

    function rulesToServerRules(rules) {
        var result = {};
        var source = rules || {};
        for (var key of Object.keys(source)) {
            var rule = source[key];
            if (!rule || rule.enabled === false) continue;
            result[key] = {
                itemId: rule.itemId || key,
                itemName: rule.itemName || rule.name || '',
                itemType: rule.itemType || rule.type || '',
                enabled: rule.enabled !== false,
                boundaryOverride: rule.boundaryOverride || null,
                enabledAt: rule.enabledAt || new Date().toISOString()
            };
        }
        return result;
    }

    function normalizeSpoilerData(rawData) {
        var raw = (rawData && typeof rawData === 'object') ? rawData : {};
        var rawSettings = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};

        var sourceRules = raw.rules && typeof raw.rules === 'object'
            ? raw.rules
            : (raw.items && typeof raw.items === 'object' ? raw.items : {});

        var normalizedRules = {};
        for (var key of Object.keys(sourceRules)) {
            var normalized = normalizeRuleEntry(key, sourceRules[key]);
            if (normalized.enabled) {
                normalizedRules[key] = normalized;
            }
        }

        var tagAutoEnable = Array.isArray(raw.tagAutoEnable)
            ? raw.tagAutoEnable
            : (Array.isArray(rawSettings.autoEnableTags) ? rawSettings.autoEnableTags : []);

        var autoEnableOnFirstPlay = typeof raw.autoEnableOnFirstPlay === 'boolean'
            ? raw.autoEnableOnFirstPlay
            : !!rawSettings.autoEnableOnFirstPlay;

        return {
            ...raw,
            rules: normalizedRules,
            settings: { ...rawSettings },
            tagAutoEnable: tagAutoEnable,
            autoEnableOnFirstPlay: autoEnableOnFirstPlay
        };
    }

    function toServerSpoilerData(data) {
        var source = data || getSpoilerData();
        var rules = rulesToServerRules(source.rules);
        var tagAutoEnable = Array.isArray(source.tagAutoEnable) ? source.tagAutoEnable : [];
        var autoEnableOnFirstPlay = !!source.autoEnableOnFirstPlay;
        var settings = {
            ...(source.settings || {}),
            autoEnableTags: tagAutoEnable,
            autoEnableOnFirstPlay: autoEnableOnFirstPlay
        };

        return {
            rules: rules,
            items: rulesToItems(rules),
            settings: settings,
            tagAutoEnable: tagAutoEnable,
            autoEnableOnFirstPlay: autoEnableOnFirstPlay
        };
    }

    function syncUserSpoilerData() {
        var data = getSpoilerData();
        JE.userConfig.spoilerMode = {
            ...data,
            items: rulesToItems(data.rules)
        };
    }

    function getSpoilerData() {
        if (!spoilerData) {
            spoilerData = normalizeSpoilerData(JE.userConfig?.spoilerMode);
            syncUserSpoilerData();
        }
        return spoilerData;
    }

    function getSettings() {
        var data = getSpoilerData();

        var merged = {
            watchedThreshold: 'played',
            boundaryRule: 'showOnlyWatched',
            ...SETTING_DEFAULTS,
            ...data.settings
        };

        // Normalize revealDuration: convert known legacy second values to ms.
        var revealDurationRaw = Number(merged.revealDuration);
        if (!Number.isFinite(revealDurationRaw) || revealDurationRaw <= 0) {
            merged.revealDuration = DEFAULT_REVEAL_DURATION;
        } else if (LEGACY_SECOND_VALUES.has(revealDurationRaw)) {
            merged.revealDuration = revealDurationRaw * 1000;
        } else {
            merged.revealDuration = revealDurationRaw;
        }

        return merged;
    }

    // ============================================================
    // State management
    // ============================================================

    /**
     * Rebuilds the in-memory ID set from the current spoiler rules.
     * Calls connectObserver/disconnectObserver/clearAllRedactions from
     * sub-modules via the core namespace.
     */
    function rebuildSets() {
        protectedIdSet.clear();
        protectedCollectionIds.clear();
        var data = getSpoilerData();
        var rules = data.rules || {};
        for (var key of Object.keys(rules)) {
            var rule = rules[key];
            if (rule.enabled) {
                protectedIdSet.add(rule.itemId);
                if (rule.itemType === 'BoxSet') {
                    protectedCollectionIds.add(rule.itemId);
                }
            }
        }
        // Prune collectionMemberMap entries for collections no longer protected
        for (var [memberId, collectionSet] of collectionMemberMap) {
            for (var cid of collectionSet) {
                if (!protectedCollectionIds.has(cid)) {
                    collectionSet.delete(cid);
                }
            }
            if (collectionSet.size === 0) {
                collectionMemberMap.delete(memberId);
            }
        }

        // Toggle pre-hide CSS on body and observer state
        if (protectedIdSet.size > 0 && getSettings().enabled !== false) {
            document.body?.classList?.add('je-spoiler-active');
            if (core.connectObserver) core.connectObserver();
        } else {
            document.body?.classList?.remove('je-spoiler-active');
            if (core.disconnectObserver) core.disconnectObserver();
            if (core.clearAllRedactions) core.clearAllRedactions();
        }
    }

    function debouncedSave() {
        if (saveTimeout) clearTimeout(saveTimeout);
        saveTimeout = setTimeout(function () {
            saveTimeout = null;
            var currentUserId = typeof ApiClient !== 'undefined' && ApiClient.getCurrentUserId
                ? ApiClient.getCurrentUserId()
                : null;
            if (spoilerDataOwnerId && currentUserId && spoilerDataOwnerId !== currentUserId) {
                console.warn('🪼 Jellyfin Enhanced: Spoiler save skipped — user changed from', spoilerDataOwnerId, 'to', currentUserId);
                return;
            }
            var data = getSpoilerData();
            JE.saveUserSettings('spoiler-mode.json', toServerSpoilerData(data));
        }, SAVE_DEBOUNCE_MS);
    }

    function emitChange() {
        try {
            window.dispatchEvent(new CustomEvent('je-spoiler-mode-changed'));
        } catch (err) {
            console.warn('🪼 Jellyfin Enhanced: Failed to emit spoiler-mode-changed event', err);
        }
    }

    function isProtected(itemId) {
        if (!itemId) return false;
        if (getSettings().enabled === false) return false;
        return protectedIdSet.has(itemId);
    }

    function getRule(itemId) {
        if (!itemId) return null;
        var data = getSpoilerData();
        return data.rules?.[itemId] || null;
    }

    function setRule(params) {
        var itemId = params.itemId;
        var itemName = params.itemName;
        var itemType = params.itemType;
        var enabled = params.enabled;
        var data = getSpoilerData();
        if (enabled) {
            var existingRule = data.rules?.[itemId];
            var newRule = {
                itemId: itemId,
                itemName: itemName || existingRule?.itemName || '',
                itemType: itemType || existingRule?.itemType || '',
                enabled: true,
                boundaryOverride: existingRule?.boundaryOverride || null,
                enabledAt: existingRule?.enabledAt || new Date().toISOString()
            };
            spoilerData = {
                ...data,
                rules: { ...data.rules, [itemId]: newRule }
            };
        } else {
            var newRules = { ...data.rules };
            delete newRules[itemId];
            spoilerData = { ...data, rules: newRules };
        }
        syncUserSpoilerData();
        rebuildSets();
        debouncedSave();
        emitChange();

        boundaryCache.delete(itemId);
        movieWatchedCache.delete(itemId);
        seasonWatchedCache.delete(itemId);
        collectionItemsCache.delete(itemId);

        for (var [memberId, collectionSet] of collectionMemberMap) {
            collectionSet.delete(itemId);
            if (collectionSet.size === 0) {
                collectionMemberMap.delete(memberId);
            }
        }
    }

    function updateSettings(partial) {
        var data = getSpoilerData();
        spoilerData = {
            ...data,
            settings: { ...data.settings, ...partial }
        };
        syncUserSpoilerData();
        debouncedSave();
        emitChange();
    }

    function setAutoEnableOnFirstPlay(enabled) {
        var data = getSpoilerData();
        spoilerData = {
            ...data,
            autoEnableOnFirstPlay: !!enabled,
            settings: { ...data.settings, autoEnableOnFirstPlay: !!enabled }
        };
        syncUserSpoilerData();
        debouncedSave();
        emitChange();
    }

    function setTagAutoEnable(tags) {
        var data = getSpoilerData();
        var cleaned = Array.isArray(tags) ? tags.filter(Boolean) : [];
        spoilerData = {
            ...data,
            tagAutoEnable: cleaned,
            settings: { ...data.settings, autoEnableTags: cleaned }
        };
        syncUserSpoilerData();
        debouncedSave();
        emitChange();
    }

    // ============================================================
    // Boundary computation
    // ============================================================

    async function acquireBoundarySlot() {
        if (activeBoundaryRequests < MAX_CONCURRENT_BOUNDARY_REQUESTS) {
            activeBoundaryRequests++;
            return;
        }
        await new Promise(function (resolve) { boundaryQueue.push(resolve); });
        activeBoundaryRequests++;
    }

    function releaseBoundarySlot() {
        activeBoundaryRequests--;
        if (boundaryQueue.length > 0) {
            boundaryQueue.shift()();
        }
    }

    async function computeBoundary(seriesId) {
        if (!seriesId) return null;

        var cached = boundaryCache.get(seriesId);
        if (cached && (Date.now() - cached.ts) < BOUNDARY_CACHE_TTL) {
            return cached.boundary;
        }

        if (boundaryRequestMap.has(seriesId)) {
            return boundaryRequestMap.get(seriesId);
        }

        var request = (async function () {
            await acquireBoundarySlot();
            try {
                var userId = ApiClient.getCurrentUserId();
                var settings = getSettings();
                var threshold = settings.watchedThreshold;

                if (!isValidId(seriesId)) return null;

                var response = await ApiClient.ajax({
                    type: 'GET',
                    url: ApiClient.getUrl('/Shows/' + seriesId + '/Episodes', {
                        UserId: userId,
                        Fields: 'UserData',
                        SortBy: 'SortName',
                        SortOrder: 'Ascending'
                    }),
                    dataType: 'json'
                });

                var episodes = response?.Items || [];
                if (episodes.length === 0) return null;

                var lastWatched = null;
                for (var ep of episodes) {
                    var userData = ep.UserData;
                    if (!userData) continue;

                    var epSeason = ep.ParentIndexNumber;
                    if (epSeason === null || epSeason === undefined || epSeason === 0) continue;

                    var isWatched = false;
                    if (threshold === 'played') {
                        isWatched = userData.Played === true;
                    } else {
                        isWatched = userData.Played === true ||
                            (userData.PlayedPercentage && userData.PlayedPercentage >= 90);
                    }

                    if (isWatched) {
                        var epNum = ep.IndexNumber || 0;
                        if (!lastWatched ||
                            epSeason > lastWatched.season ||
                            (epSeason === lastWatched.season && epNum > lastWatched.episode)) {
                            lastWatched = {
                                season: epSeason,
                                episode: epNum,
                                episodeId: ep.Id
                            };
                        }
                    }
                }

                evictIfNeeded(boundaryCache, MAX_CACHE_SIZE);
                boundaryCache.set(seriesId, {
                    boundary: lastWatched,
                    ts: Date.now()
                });

                // Cache episode data for fast lookups on detail pages
                var epMap = new Map();
                for (var j = 0; j < episodes.length; j++) {
                    var epItem = episodes[j];
                    if (epItem.Id) {
                        epMap.set(epItem.Id, {
                            Id: epItem.Id,
                            ParentIndexNumber: epItem.ParentIndexNumber,
                            IndexNumber: epItem.IndexNumber,
                            IndexNumberEnd: epItem.IndexNumberEnd,
                            UserData: epItem.UserData
                        });
                    }
                }
                evictIfNeeded(episodeDataCache, MAX_CACHE_SIZE);
                episodeDataCache.set(seriesId, { data: epMap, ts: Date.now() });

                return lastWatched;
            } catch (err) {
                console.warn('🪼 Jellyfin Enhanced: Error computing spoiler boundary', err);
                return null;
            } finally {
                releaseBoundarySlot();
                boundaryRequestMap.delete(seriesId);
            }
        })();

        boundaryRequestMap.set(seriesId, request);
        return request;
    }

    /**
     * Retrieves cached episode data for a specific episode within a series.
     * Call computeBoundary(seriesId) first to populate the cache.
     * @param {string} seriesId The series Jellyfin ID.
     * @param {string} episodeId The episode Jellyfin ID.
     * @returns {Object|null} Episode data with Id, ParentIndexNumber, IndexNumber, UserData, or null.
     */
    function getEpisodeData(seriesId, episodeId) {
        var cached = episodeDataCache.get(seriesId);
        if (!cached || (Date.now() - cached.ts) >= BOUNDARY_CACHE_TTL) return null;
        return cached.data.get(episodeId) || null;
    }

    async function isEpisodePastBoundary(seriesId, seasonNumber, episodeNumber) {
        if (seasonNumber === 0) return null;

        var boundary = await computeBoundary(seriesId);
        if (!boundary) {
            return true;
        }

        if (seasonNumber > boundary.season) return true;
        if (seasonNumber === boundary.season && episodeNumber > boundary.episode) return true;
        return false;
    }

    // ============================================================
    // Movie & collection watch-state helpers
    // ============================================================

    async function isMovieWatched(movieId) {
        if (!movieId) return false;

        var cached = movieWatchedCache.get(movieId);
        if (cached && (Date.now() - cached.ts) < BOUNDARY_CACHE_TTL) {
            return cached.watched;
        }

        if (movieWatchedRequestMap.has(movieId)) {
            return movieWatchedRequestMap.get(movieId);
        }

        var request = (async function () {
            try {
                if (!isValidId(movieId)) return false;

                var item = await ApiClient.ajax({
                    type: 'GET',
                    url: ApiClient.getUrl('/Items/' + movieId, {
                        Fields: 'UserData'
                    }),
                    dataType: 'json'
                });

                var watched = item?.UserData?.Played === true;
                evictIfNeeded(movieWatchedCache, MAX_CACHE_SIZE);
                movieWatchedCache.set(movieId, { watched: watched, ts: Date.now() });
                return watched;
            } catch (err) {
                console.warn('🪼 Jellyfin Enhanced: Error checking movie watched state', err);
                return false;
            } finally {
                movieWatchedRequestMap.delete(movieId);
            }
        })();

        movieWatchedRequestMap.set(movieId, request);
        return request;
    }

    function shouldRedactEpisode(episode) {
        if (!episode?.UserData) return true;
        var settings = getSettings();
        if (settings.watchedThreshold === 'played') {
            return !episode.UserData.Played;
        }
        return !episode.UserData.Played &&
            !(episode.UserData.PlayedPercentage && episode.UserData.PlayedPercentage >= 90);
    }

    async function isSeasonFullyWatched(seasonId) {
        if (!seasonId) return false;

        var cached = seasonWatchedCache.get(seasonId);
        if (cached && (Date.now() - cached.ts) < BOUNDARY_CACHE_TTL) {
            return cached.watched;
        }

        if (seasonWatchedRequestMap.has(seasonId)) {
            return seasonWatchedRequestMap.get(seasonId);
        }

        var request = (async function () {
            try {
                if (!isValidId(seasonId)) return false;

                var response = await ApiClient.ajax({
                    type: 'GET',
                    url: ApiClient.getUrl('/Items', {
                        ParentId: seasonId,
                        IncludeItemTypes: 'Episode',
                        Recursive: true,
                        Fields: 'UserData'
                    }),
                    dataType: 'json'
                });

                var episodes = (response?.Items || []).filter(function (item) {
                    return item?.Type === 'Episode';
                });

                if (episodes.length === 0) {
                    evictIfNeeded(seasonWatchedCache, MAX_CACHE_SIZE);
                    seasonWatchedCache.set(seasonId, { watched: false, ts: Date.now() });
                    return false;
                }

                var watched = episodes.every(function (episode) {
                    return !shouldRedactEpisode(episode);
                });

                evictIfNeeded(seasonWatchedCache, MAX_CACHE_SIZE);
                seasonWatchedCache.set(seasonId, { watched: watched, ts: Date.now() });
                return watched;
            } catch (err) {
                console.warn('🪼 Jellyfin Enhanced: Error checking season watched state', err);
                return false;
            } finally {
                seasonWatchedRequestMap.delete(seasonId);
            }
        })();

        seasonWatchedRequestMap.set(seasonId, request);
        return request;
    }

    async function fetchCollectionItems(collectionId) {
        if (!collectionId) return new Set();

        var cached = collectionItemsCache.get(collectionId);
        if (cached && (Date.now() - cached.ts) < BOUNDARY_CACHE_TTL) {
            return cached.items;
        }

        if (collectionItemsRequestMap.has(collectionId)) {
            return collectionItemsRequestMap.get(collectionId);
        }

        var request = (async function () {
            try {
                if (!isValidId(collectionId)) return new Set();

                var response = await ApiClient.ajax({
                    type: 'GET',
                    url: ApiClient.getUrl('/Items', {
                        ParentId: collectionId
                    }),
                    dataType: 'json'
                });

                var items = response?.Items || [];
                var itemIds = new Set(items.map(function (it) { return it.Id; }));

                evictIfNeeded(collectionItemsCache, MAX_CACHE_SIZE);
                collectionItemsCache.set(collectionId, { items: itemIds, ts: Date.now() });

                // Build reverse map entries with eviction
                for (var id of itemIds) {
                    evictIfNeeded(collectionMemberMap, MAX_CACHE_SIZE);
                    if (!collectionMemberMap.has(id)) {
                        collectionMemberMap.set(id, new Set());
                    }
                    collectionMemberMap.get(id).add(collectionId);
                }

                return itemIds;
            } catch (err) {
                console.warn('🪼 Jellyfin Enhanced: Error fetching collection items', err);
                return new Set();
            } finally {
                collectionItemsRequestMap.delete(collectionId);
            }
        })();

        collectionItemsRequestMap.set(collectionId, request);
        return request;
    }

    async function getProtectedCollectionForMovie(movieId) {
        if (!movieId || protectedCollectionIds.size === 0) return null;

        var knownCollections = collectionMemberMap.get(movieId);
        if (knownCollections) {
            for (var cid of knownCollections) {
                if (protectedCollectionIds.has(cid)) return cid;
            }
        }

        for (var collectionId of protectedCollectionIds) {
            var items = await fetchCollectionItems(collectionId);
            if (items.has(movieId)) return collectionId;
        }

        return null;
    }

    // ============================================================
    // Redaction formatting
    // ============================================================

    function formatRedactedTitle(seasonNumber, episodeNumber, endEpisodeNumber, isSpecial) {
        if (isSpecial || seasonNumber === 0) {
            var num = episodeNumber != null ? String(episodeNumber).padStart(2, '0') : '01';
            return 'Special ' + num + ' \u2014 Click to reveal';
        }
        var s = seasonNumber != null ? String(seasonNumber).padStart(2, '0') : '00';
        var e = episodeNumber != null ? String(episodeNumber).padStart(2, '0') : '00';

        var hint = ' \u2014 Click to reveal';
        if (endEpisodeNumber != null && endEpisodeNumber !== episodeNumber) {
            var eEnd = String(endEpisodeNumber).padStart(2, '0');
            return 'S' + s + 'E' + e + '\u2013E' + eEnd + hint;
        }
        return 'S' + s + 'E' + e + hint;
    }

    function formatShortRedactedTitle(seasonNumber, episodeNumber) {
        var s = seasonNumber != null ? seasonNumber : 0;
        var e = episodeNumber != null ? episodeNumber : 0;
        return 'S' + s + 'E' + e;
    }

    // ============================================================
    // Parent series lookup
    // ============================================================

    async function getParentSeriesId(itemId) {
        if (parentSeriesCache.has(itemId)) {
            return parentSeriesCache.get(itemId);
        }
        if (parentSeriesRequestMap.has(itemId)) {
            return parentSeriesRequestMap.get(itemId);
        }
        var request = (async function () {
            try {
                if (!isValidId(itemId)) return null;

                var item = await ApiClient.ajax({
                    type: 'GET',
                    url: ApiClient.getUrl('/Items/' + itemId, {
                        Fields: 'SeriesId,ParentIndexNumber,IndexNumber,UserData'
                    }),
                    dataType: 'json'
                });
                var seriesId = item?.SeriesId || null;
                evictIfNeeded(parentSeriesCache, MAX_CACHE_SIZE);
                parentSeriesCache.set(itemId, seriesId);
                return seriesId;
            } catch (err) {
                console.warn('🪼 Jellyfin Enhanced: Failed to fetch parent series for spoiler check', err);
                evictIfNeeded(parentSeriesCache, MAX_CACHE_SIZE);
                parentSeriesCache.set(itemId, null);
                return null;
            } finally {
                parentSeriesRequestMap.delete(itemId);
            }
        })();
        parentSeriesRequestMap.set(itemId, request);
        return request;
    }

    // ============================================================
    // Shared internal namespace
    // ============================================================

    /**
     * Internal namespace shared between spoiler mode sub-modules.
     * Sub-modules register their functions here; the core init
     * assembles the public JE.spoilerMode API from them.
     */
    var core = {
        // Constants
        SAVE_DEBOUNCE_MS: SAVE_DEBOUNCE_MS,
        DEFAULT_REVEAL_DURATION: DEFAULT_REVEAL_DURATION,
        REVEAL_ALL_DURATION: REVEAL_ALL_DURATION,
        BLUR_RADIUS: BLUR_RADIUS,
        BOUNDARY_CACHE_TTL: BOUNDARY_CACHE_TTL,
        FILTER_DEBOUNCE_MS: FILTER_DEBOUNCE_MS,
        INIT_FILTER_DELAY_MS: INIT_FILTER_DELAY_MS,
        DETAIL_RESCAN_DELAY_MS: DETAIL_RESCAN_DELAY_MS,
        DETAIL_FINAL_RESCAN_DELAY_MS: DETAIL_FINAL_RESCAN_DELAY_MS,
        LATE_RENDER_FIRST_DELAY_MS: LATE_RENDER_FIRST_DELAY_MS,
        LATE_RENDER_FINAL_DELAY_MS: LATE_RENDER_FINAL_DELAY_MS,
        TOGGLE_RESCAN_DELAY_MS: TOGGLE_RESCAN_DELAY_MS,
        LONG_PRESS_THRESHOLD_MS: LONG_PRESS_THRESHOLD_MS,
        PLAYER_OSD_DELAY_MS: PLAYER_OSD_DELAY_MS,
        OSD_MUTATION_DEBOUNCE_MS: OSD_MUTATION_DEBOUNCE_MS,
        MAX_CACHE_SIZE: MAX_CACHE_SIZE,
        MAX_CONCURRENT_BOUNDARY_REQUESTS: MAX_CONCURRENT_BOUNDARY_REQUESTS,
        PROCESSED_ATTR: PROCESSED_ATTR,
        SCANNED_ATTR: SCANNED_ATTR,
        REDACTED_ATTR: REDACTED_ATTR,
        DETAIL_OVERVIEW_PENDING_CLASS: DETAIL_OVERVIEW_PENDING_CLASS,
        OVERVIEW_REVEALED_CLASS: OVERVIEW_REVEALED_CLASS,
        CARD_SEL: CARD_SEL,
        CARD_SEL_NEW: CARD_SEL_NEW,
        SETTING_DEFAULTS: SETTING_DEFAULTS,
        BUTTON_CONTAINER_SELECTORS: BUTTON_CONTAINER_SELECTORS,

        // State accessors (mutable state exposed as properties for sub-modules)
        get revealAllActive() { return revealAllActive; },
        set revealAllActive(v) { revealAllActive = v; },
        get revealAllTimer() { return revealAllTimer; },
        set revealAllTimer(v) { revealAllTimer = v; },
        get revealAllCountdownInterval() { return revealAllCountdownInterval; },
        set revealAllCountdownInterval(v) { revealAllCountdownInterval = v; },
        get unifiedObserver() { return unifiedObserver; },
        set unifiedObserver(v) { unifiedObserver = v; },
        get navigationTimers() { return navigationTimers; },
        set navigationTimers(v) { navigationTimers = v; },
        get lastDetailPageItemId() { return lastDetailPageItemId; },
        set lastDetailPageItemId(v) { lastDetailPageItemId = v; },
        get detailPageProcessing() { return detailPageProcessing; },
        set detailPageProcessing(v) { detailPageProcessing = v; },

        // Read-only state references
        protectedIdSet: protectedIdSet,
        protectedCollectionIds: protectedCollectionIds,
        sectionSurfaceCache: sectionSurfaceCache,
        boundaryCache: boundaryCache,
        movieWatchedCache: movieWatchedCache,
        seasonWatchedCache: seasonWatchedCache,
        collectionItemsCache: collectionItemsCache,
        collectionMemberMap: collectionMemberMap,

        // Core functions
        isValidId: isValidId,
        evictIfNeeded: evictIfNeeded,
        escapeHtml: escapeHtml,
        tFallback: tFallback,
        findButtonContainer: findButtonContainer,
        getCardItemId: getCardItemId,
        blurElement: blurElement,
        shouldPrehideDetailOverview: shouldPrehideDetailOverview,
        shouldSkipDetailOverviewPrehide: shouldSkipDetailOverviewPrehide,
        setDetailOverviewPending: setDetailOverviewPending,
        getSpoilerData: getSpoilerData,
        getSettings: getSettings,
        isProtected: isProtected,
        getRule: getRule,
        setRule: setRule,
        updateSettings: updateSettings,
        setAutoEnableOnFirstPlay: setAutoEnableOnFirstPlay,
        setTagAutoEnable: setTagAutoEnable,
        rebuildSets: rebuildSets,
        debouncedSave: debouncedSave,
        emitChange: emitChange,
        syncUserSpoilerData: syncUserSpoilerData,
        computeBoundary: computeBoundary,
        isEpisodePastBoundary: isEpisodePastBoundary,
        isMovieWatched: isMovieWatched,
        shouldRedactEpisode: shouldRedactEpisode,
        isSeasonFullyWatched: isSeasonFullyWatched,
        fetchCollectionItems: fetchCollectionItems,
        getProtectedCollectionForMovie: getProtectedCollectionForMovie,
        formatRedactedTitle: formatRedactedTitle,
        formatShortRedactedTitle: formatShortRedactedTitle,
        getParentSeriesId: getParentSeriesId,
        getEpisodeData: getEpisodeData,

        // Placeholders for sub-module functions (registered during their load)
        // Redaction module:
        injectCSS: null,
        redactCard: null,
        blurCardArtwork: null,
        redactChapterCard: null,
        unredactCard: null,
        clearAllRedactions: null,
        activateRevealAll: null,
        deactivateRevealAll: null,
        revealCard: null,
        hideCard: null,
        bindCardReveal: null,
        // Surfaces module:
        addSpoilerToggleButton: null,
        showSpoilerConfirmation: null,
        redactEpisodeList: null,
        redactDetailPageChapters: null,
        redactCollectionPage: null,
        redactMovieDetailPage: null,
        redactEpisodeDetailPage: null,
        redactSearchResults: null,
        redactPlayerOverlay: null,
        filterCalendarEvents: null,
        hideOverviewWithReveal: null,
        // Observer module:
        filterNewCards: null,
        filterAllCards: null,
        processCurrentPage: null,
        processCard: null,
        connectObserver: null,
        disconnectObserver: null,
        setupObservers: null,
        handleAutoEnableOnFirstPlay: null,
        checkAndAutoEnableByTag: null,
        handleDetailPageMutation: null
    };

    JE._spoilerCore = core;

    // ============================================================
    // Public API & Initialization
    // ============================================================

    JE.initializeSpoilerMode = function () {
        spoilerDataOwnerId = typeof ApiClient !== 'undefined' && ApiClient.getCurrentUserId
            ? ApiClient.getCurrentUserId()
            : null;
        spoilerData = normalizeSpoilerData(JE.userConfig?.spoilerMode);
        syncUserSpoilerData();
        rebuildSets();

        if (protectedIdSet.size > 0 && getSettings().enabled !== false) {
            document.body.classList.add('je-spoiler-active');
        } else {
            document.body.classList.remove('je-spoiler-active');
        }

        // Initialize sub-modules
        if (core.injectCSS) core.injectCSS();
        if (core.setupObservers) core.setupObservers();

        // Re-process page when settings change
        window.addEventListener('je-spoiler-mode-changed', function () {
            if (getSettings().enabled === false) {
                document.body.classList.remove('je-spoiler-active');
            } else if (protectedIdSet.size > 0) {
                document.body.classList.add('je-spoiler-active');
            }
            if (core.processCurrentPage) core.processCurrentPage();
        });

        // Initial filter after a short delay
        if (protectedIdSet.size > 0 && core.filterAllCards) {
            setTimeout(core.filterAllCards, INIT_FILTER_DELAY_MS);
        }

        // Expose public API (assembled from core + sub-modules)
        JE.spoilerMode = {
            isProtected: isProtected,
            getRule: getRule,
            setRule: setRule,
            getSettings: getSettings,
            updateSettings: updateSettings,
            setAutoEnableOnFirstPlay: setAutoEnableOnFirstPlay,
            setTagAutoEnable: setTagAutoEnable,
            computeBoundary: computeBoundary,
            isEpisodePastBoundary: isEpisodePastBoundary,
            shouldRedactEpisode: shouldRedactEpisode,
            isMovieWatched: isMovieWatched,
            fetchCollectionItems: fetchCollectionItems,
            getProtectedCollectionForMovie: getProtectedCollectionForMovie,
            formatRedactedTitle: formatRedactedTitle,
            formatShortRedactedTitle: formatShortRedactedTitle,
            filterCalendarEvents: function (events) { return core.filterCalendarEvents ? core.filterCalendarEvents(events) : events; },
            activateRevealAll: function () { if (core.activateRevealAll) core.activateRevealAll(); },
            deactivateRevealAll: function () { if (core.deactivateRevealAll) core.deactivateRevealAll(); },
            revealCard: function (card) { if (core.revealCard) core.revealCard(card); },
            hideCard: function (card) { if (core.hideCard) core.hideCard(card); },
            processCurrentPage: function () { if (core.processCurrentPage) core.processCurrentPage(); },
            redactSearchResults: function () { if (core.redactSearchResults) core.redactSearchResults(); },
            redactPlayerOverlay: function (id) { if (core.redactPlayerOverlay) core.redactPlayerOverlay(id); },
            handleAutoEnableOnFirstPlay: function (id) { if (core.handleAutoEnableOnFirstPlay) core.handleAutoEnableOnFirstPlay(id); },
            checkAndAutoEnableByTag: function (id, item) { if (core.checkAndAutoEnableByTag) core.checkAndAutoEnableByTag(id, item); },
            getSpoilerData: getSpoilerData,
            rebuildSets: rebuildSets
        };
    };

})(window.JellyfinEnhanced);
