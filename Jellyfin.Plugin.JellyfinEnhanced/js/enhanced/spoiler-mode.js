/**
 * @file Spoiler Mode — per-user, per-item spoiler protection for Jellyfin Enhanced.
 *
 * Prevents spoiler leaks by redacting unwatched episode titles, thumbnails,
 * overviews, and chapter names across all rendering surfaces (detail pages,
 * home sections, search, player overlay, calendar).
 *
 * Core concepts:
 * - Per-user, per-show/movie spoiler rules stored in `spoiler-mode.json`
 * - "Spoiler boundary" = last fully watched episode; everything after is redacted
 * - Reveal controls (tap-to-reveal, press-and-hold, 30s reveal-all)
 * - Presets: Balanced (blur artwork) and Strict (generic tiles, hide runtime/air date)
 */
(function (JE) {
    'use strict';

    // ============================================================
    // Constants
    // ============================================================

    /** Debounce interval for persisting spoiler mode data. */
    const SAVE_DEBOUNCE_MS = 500;

    /** How long a tap-to-reveal stays visible (ms). */
    const DEFAULT_REVEAL_DURATION = 10000;

    /** How long "Reveal All" keeps everything visible (ms). */
    const REVEAL_ALL_DURATION = 30000;

    /** CSS blur radius for spoiler-protected thumbnails. */
    const BLUR_RADIUS = '30px';

    /** Cache TTL for boundary data (5 minutes). */
    const BOUNDARY_CACHE_TTL = 5 * 60 * 1000;

    /** Debounce interval for the MutationObserver card filter. */
    const FILTER_DEBOUNCE_MS = 50;

    /** Initial filter delay after module initialization. */
    const INIT_FILTER_DELAY_MS = 200;

    /** Delay for detail page re-scans (async episode loading). */
    const DETAIL_RESCAN_DELAY_MS = 500;

    /** Final detail page re-scan delay. */
    const DETAIL_FINAL_RESCAN_DELAY_MS = 1500;

    /** Delay after toggling spoiler mode before re-scanning the page. */
    const TOGGLE_RESCAN_DELAY_MS = 300;

    /** Long-press threshold for mobile tap-to-reveal (ms). */
    const LONG_PRESS_THRESHOLD_MS = 300;

    /** Delay before redacting player OSD after navigation (ms). */
    const PLAYER_OSD_DELAY_MS = 500;

    /** Debounce interval for player OSD redaction on mutations (ms). */
    const OSD_MUTATION_DEBOUNCE_MS = 200;

    /** Maximum entries in each cache before LRU eviction. */
    const MAX_CACHE_SIZE = 50;

    /** Maximum concurrent boundary API requests. */
    const MAX_CONCURRENT_BOUNDARY_REQUESTS = 4;

    /** Data attribute marking a card as already processed by spoiler mode. */
    const PROCESSED_ATTR = 'data-je-spoiler-checked';

    /** Data attribute set when async processing is fully complete (prevents spoiler flash). */
    const SCANNED_ATTR = 'data-je-spoiler-scanned';

    /** Data attribute marking a card as spoiler-redacted. */
    const REDACTED_ATTR = 'data-je-spoiler-redacted';

    /** Selector for any spoiler-processable card/list-item. */
    const CARD_SEL = '.card[data-id], .card[data-itemid], .listItem[data-id]';

    /** Selector for not-yet-scanned cards. */
    const CARD_SEL_NEW = '.card[data-id]:not([data-je-spoiler-checked]), .card[data-itemid]:not([data-je-spoiler-checked]), .listItem[data-id]:not([data-je-spoiler-checked])';

    /** GUID format validation for Jellyfin item IDs. */
    const GUID_RE = /^[0-9a-f]{32}$/i;

    /** Preset configurations. */
    const PRESETS = {
        balanced: {
            artworkPolicy: 'blur',
            protectHome: true,
            protectSearch: true,
            protectOverlay: true,
            protectCalendar: true,
            protectRecentlyAdded: true,
            hideRuntime: false,
            hideAirDate: false,
            hideGuestStars: false,
            showSeriesOverview: false,
            revealDuration: DEFAULT_REVEAL_DURATION
        },
        strict: {
            artworkPolicy: 'generic',
            protectHome: true,
            protectSearch: true,
            protectOverlay: true,
            protectCalendar: true,
            protectRecentlyAdded: true,
            hideRuntime: true,
            hideAirDate: true,
            hideGuestStars: true,
            showSeriesOverview: false,
            revealDuration: DEFAULT_REVEAL_DURATION
        }
    };

    /** Selectors for finding the detail page button container. */
    const BUTTON_CONTAINER_SELECTORS = [
        '.detailButtons',
        '.itemActionsBottom',
        '.mainDetailButtons',
        '.detailButtonsContainer'
    ];

    // ============================================================
    // State
    // ============================================================

    /** The in-memory spoiler mode data object. */
    let spoilerData = null;

    /** Save debounce timer. */
    let saveTimeout = null;

    /**
     * LRU cache for spoiler boundary data per series.
     * Map<seriesId, { boundary: { season, episode }, ts: number }>
     */
    const boundaryCache = new Map();

    /**
     * In-flight boundary requests to prevent duplicate fetches.
     * Map<seriesId, Promise>
     */
    const boundaryRequestMap = new Map();

    /** Number of currently active boundary API requests (for throttling). */
    let activeBoundaryRequests = 0;

    /** Queue of resolve callbacks waiting for a boundary request slot. */
    const boundaryQueue = [];

    /**
     * Set of series/movie IDs that have spoiler mode enabled.
     * Used for fast lookups during card filtering.
     */
    const protectedIdSet = new Set();

    /**
     * LRU cache of parent series ID lookups for episode/season cards.
     * Map<itemId, seriesId|null>
     */
    const parentSeriesCache = new Map();

    /** In-flight parent series requests. Map<itemId, Promise> */
    const parentSeriesRequestMap = new Map();

    /** Whether "Reveal All" is currently active. */
    let revealAllActive = false;

    /** Timer for "Reveal All" auto-hide. */
    let revealAllTimer = null;

    /** Interval for "Reveal All" countdown banner. */
    let revealAllCountdownInterval = null;

    /**
     * WeakMap caching surface context for DOM sections.
     * @type {WeakMap<HTMLElement, string|null>}
     */
    const sectionSurfaceCache = new WeakMap();

    /** The single unified MutationObserver for all DOM watching. */
    let unifiedObserver = null;

    /** Guard variables for detail page observer (declared before use). */
    let lastDetailPageItemId = null;
    let detailPageProcessing = false;

    // ============================================================
    // Internal helpers
    // ============================================================

    /**
     * Validates that a string is a valid Jellyfin GUID.
     * @param {string} id The ID to validate.
     * @returns {boolean}
     */
    function isValidId(id) {
        return typeof id === 'string' && GUID_RE.test(id);
    }

    /**
     * Evicts the oldest entry from a Map if it exceeds maxSize (LRU eviction).
     * @param {Map} cache The cache map.
     * @param {number} maxSize Maximum allowed entries.
     */
    function evictIfNeeded(cache, maxSize) {
        if (cache.size <= maxSize) return;
        const firstKey = cache.keys().next().value;
        cache.delete(firstKey);
    }

    /**
     * Escapes a string for safe insertion into HTML contexts.
     * @param {string} str The string to escape.
     * @returns {string} HTML-safe string.
     */
    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    /**
     * Finds the button container element on a detail page.
     * @param {HTMLElement} visiblePage The visible detail page element.
     * @returns {HTMLElement|null} The button container or null.
     */
    function findButtonContainer(visiblePage) {
        for (const sel of BUTTON_CONTAINER_SELECTORS) {
            const found = visiblePage.querySelector(sel);
            if (found) return found;
        }
        return null;
    }

    /**
     * Returns the in-memory spoiler mode data object, lazily initialised
     * from `JE.userConfig.spoilerMode`.
     * @returns {{ rules: Object, settings: Object, tagAutoEnable: string[], autoEnableOnFirstPlay: boolean }}
     */
    function getSpoilerData() {
        if (!spoilerData) {
            spoilerData = JE.userConfig?.spoilerMode || {
                rules: {},
                settings: {},
                tagAutoEnable: [],
                autoEnableOnFirstPlay: false
            };
        }
        return spoilerData;
    }

    /**
     * Returns the merged settings object (defaults + user overrides + preset).
     * @returns {Object} Merged settings.
     */
    function getSettings() {
        const data = getSpoilerData();
        const userPreset = data.settings?.preset || 'balanced';
        const presetDefaults = Object.prototype.hasOwnProperty.call(PRESETS, userPreset)
            ? PRESETS[userPreset]
            : PRESETS.balanced;

        return {
            preset: userPreset,
            watchedThreshold: 'played',
            boundaryRule: 'showOnlyWatched',
            ...presetDefaults,
            ...data.settings
        };
    }

    /**
     * Rebuilds the in-memory ID set from the current spoiler rules.
     * Must be called after any mutation to `spoilerData.rules`.
     */
    function rebuildSets() {
        protectedIdSet.clear();
        const data = getSpoilerData();
        const rules = data.rules || {};
        for (const key of Object.keys(rules)) {
            const rule = rules[key];
            if (rule.enabled) {
                protectedIdSet.add(rule.itemId);
            }
        }
        // Toggle pre-hide CSS on body and observer state
        if (protectedIdSet.size > 0) {
            document.body?.classList?.add('je-spoiler-active');
            connectObserver();
        } else {
            document.body?.classList?.remove('je-spoiler-active');
            disconnectObserver();
        }
    }

    /**
     * Persists the spoiler mode data to the server after a debounce.
     */
    function debouncedSave() {
        if (saveTimeout) clearTimeout(saveTimeout);
        saveTimeout = setTimeout(function () {
            saveTimeout = null;
            const data = getSpoilerData();
            JE.saveUserSettings('spoiler-mode.json', data);
        }, SAVE_DEBOUNCE_MS);
    }

    /**
     * Dispatches a `je-spoiler-mode-changed` CustomEvent on `window`.
     */
    function emitChange() {
        try {
            window.dispatchEvent(new CustomEvent('je-spoiler-mode-changed'));
        } catch (e) {
            console.warn('🪼 Jellyfin Enhanced: Failed to emit spoiler-mode-changed event');
        }
    }

    /**
     * Checks whether an item (series or movie) has spoiler mode enabled.
     * @param {string} itemId The Jellyfin item ID.
     * @returns {boolean}
     */
    function isProtected(itemId) {
        if (!itemId) return false;
        return protectedIdSet.has(itemId);
    }

    /**
     * Returns the spoiler rule for an item, or null if none exists.
     * @param {string} itemId The Jellyfin item ID.
     * @returns {Object|null} The spoiler rule or null.
     */
    function getRule(itemId) {
        if (!itemId) return null;
        const data = getSpoilerData();
        return data.rules?.[itemId] || null;
    }

    /**
     * Enables or disables spoiler mode for an item.
     * @param {Object} params Item data.
     * @param {string} params.itemId Jellyfin item ID.
     * @param {string} params.itemName Display name.
     * @param {string} params.itemType Item type (Series, Movie).
     * @param {boolean} params.enabled Whether to enable or disable.
     * @param {string} [params.preset] Preset to use (balanced, strict, custom).
     */
    function setRule({ itemId, itemName, itemType, enabled, preset }) {
        const data = getSpoilerData();
        if (enabled) {
            const existingRule = data.rules?.[itemId];
            const newRule = {
                itemId,
                itemName: itemName || existingRule?.itemName || '',
                itemType: itemType || existingRule?.itemType || '',
                enabled: true,
                preset: preset || existingRule?.preset || getSettings().preset || 'balanced',
                boundaryOverride: existingRule?.boundaryOverride || null,
                enabledAt: existingRule?.enabledAt || new Date().toISOString()
            };
            spoilerData = {
                ...data,
                rules: { ...data.rules, [itemId]: newRule }
            };
        } else {
            const newRules = { ...data.rules };
            delete newRules[itemId];
            spoilerData = { ...data, rules: newRules };
        }
        JE.userConfig.spoilerMode = spoilerData;
        rebuildSets();
        debouncedSave();
        emitChange();

        // Invalidate boundary cache for this item
        boundaryCache.delete(itemId);
    }

    /**
     * Updates global spoiler mode settings (immutable pattern).
     * @param {Object} partial Key-value pairs to merge into settings.
     */
    function updateSettings(partial) {
        const data = getSpoilerData();
        spoilerData = {
            ...data,
            settings: { ...data.settings, ...partial }
        };
        JE.userConfig.spoilerMode = spoilerData;
        debouncedSave();
        emitChange();
    }

    /**
     * Updates the autoEnableOnFirstPlay top-level flag (immutable pattern).
     * @param {boolean} enabled Whether auto-enable on first play is active.
     */
    function setAutoEnableOnFirstPlay(enabled) {
        const data = getSpoilerData();
        spoilerData = { ...data, autoEnableOnFirstPlay: !!enabled };
        JE.userConfig.spoilerMode = spoilerData;
        debouncedSave();
        emitChange();
    }

    // ============================================================
    // Boundary computation
    // ============================================================

    /**
     * Acquires a slot for a boundary API request, throttling to MAX_CONCURRENT_BOUNDARY_REQUESTS.
     * @returns {Promise<void>}
     */
    async function acquireBoundarySlot() {
        if (activeBoundaryRequests < MAX_CONCURRENT_BOUNDARY_REQUESTS) {
            activeBoundaryRequests++;
            return;
        }
        await new Promise(function (resolve) { boundaryQueue.push(resolve); });
        activeBoundaryRequests++;
    }

    /**
     * Releases a boundary API request slot.
     */
    function releaseBoundarySlot() {
        activeBoundaryRequests--;
        if (boundaryQueue.length > 0) {
            boundaryQueue.shift()();
        }
    }

    /**
     * Fetches and computes the spoiler boundary for a series.
     * The boundary is the last fully watched episode.
     *
     * @param {string} seriesId The series Jellyfin ID.
     * @returns {Promise<{ season: number, episode: number, episodeId: string }|null>}
     *   The boundary (last watched ep), or null if nothing watched.
     */
    async function computeBoundary(seriesId) {
        if (!seriesId) return null;

        // Check cache first
        const cached = boundaryCache.get(seriesId);
        if (cached && (Date.now() - cached.ts) < BOUNDARY_CACHE_TTL) {
            return cached.boundary;
        }

        // De-duplicate in-flight requests
        if (boundaryRequestMap.has(seriesId)) {
            return boundaryRequestMap.get(seriesId);
        }

        const request = (async function () {
            await acquireBoundarySlot();
            try {
                const userId = ApiClient.getCurrentUserId();
                const settings = getSettings();
                const threshold = settings.watchedThreshold;

                if (!isValidId(seriesId)) return null;

                // Fetch all episodes for the series with UserData
                const response = await ApiClient.ajax({
                    type: 'GET',
                    url: ApiClient.getUrl('/Shows/' + seriesId + '/Episodes', {
                        UserId: userId,
                        Fields: 'UserData',
                        SortBy: 'SortName',
                        SortOrder: 'Ascending'
                    }),
                    dataType: 'json'
                });

                const episodes = response?.Items || [];
                if (episodes.length === 0) return null;

                // Find the furthest watched episode by season/episode number.
                // Skip specials (season 0) — they are checked individually.
                let lastWatched = null;
                for (const ep of episodes) {
                    const userData = ep.UserData;
                    if (!userData) continue;

                    // Skip specials — boundary only applies to regular seasons
                    const epSeason = ep.ParentIndexNumber;
                    if (epSeason == null || epSeason === 0) continue;

                    let isWatched = false;
                    if (threshold === 'played') {
                        isWatched = userData.Played === true;
                    } else {
                        // 90% threshold
                        isWatched = userData.Played === true ||
                            (userData.PlayedPercentage && userData.PlayedPercentage >= 90);
                    }

                    if (isWatched) {
                        const epNum = ep.IndexNumber || 0;
                        // Keep the episode with the highest season/episode number
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

                // Cache the result (boundary only, not the full episodes array)
                evictIfNeeded(boundaryCache, MAX_CACHE_SIZE);
                boundaryCache.set(seriesId, {
                    boundary: lastWatched,
                    ts: Date.now()
                });

                return lastWatched;
            } catch (e) {
                console.warn('🪼 Jellyfin Enhanced: Error computing spoiler boundary');
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
     * Checks if an episode is past the spoiler boundary.
     * Specials (season 0) are not covered by boundary logic —
     * they must be checked individually via shouldRedactEpisode().
     * @param {string} seriesId The series ID.
     * @param {number} seasonNumber The season number.
     * @param {number} episodeNumber The episode number.
     * @returns {Promise<boolean|null>} True if past boundary, false if not, null if indeterminate (specials).
     */
    async function isEpisodePastBoundary(seriesId, seasonNumber, episodeNumber) {
        // Specials (season 0) are outside boundary scope — caller must check individually
        if (seasonNumber === 0) return null;

        const boundary = await computeBoundary(seriesId);
        if (!boundary) {
            // Nothing watched in regular seasons — everything is past boundary
            return true;
        }

        // Compare: season first, then episode number
        if (seasonNumber > boundary.season) return true;
        if (seasonNumber === boundary.season && episodeNumber > boundary.episode) return true;
        return false;
    }

    /**
     * Checks if an individual episode should be redacted based on its UserData.
     * Uses the episode's own Played status rather than the boundary for efficiency.
     * @param {Object} episode Jellyfin episode item with UserData.
     * @returns {boolean} True if the episode should be redacted.
     */
    function shouldRedactEpisode(episode) {
        if (!episode?.UserData) return true;
        const settings = getSettings();
        if (settings.watchedThreshold === 'played') {
            return !episode.UserData.Played;
        }
        // 90% threshold
        return !episode.UserData.Played &&
            !(episode.UserData.PlayedPercentage && episode.UserData.PlayedPercentage >= 90);
    }

    // ============================================================
    // Redaction formatting
    // ============================================================

    /**
     * Formats a redacted episode title.
     * @param {number|null} seasonNumber Season number (ParentIndexNumber).
     * @param {number|null} episodeNumber Episode number (IndexNumber).
     * @param {number|null} endEpisodeNumber End episode number for multi-ep files.
     * @param {boolean} isSpecial Whether this is a special/extra.
     * @returns {string} Redacted title like "S02E03 — Click to reveal" or "Special 01 — Click to reveal".
     */
    function formatRedactedTitle(seasonNumber, episodeNumber, endEpisodeNumber, isSpecial) {
        if (isSpecial || seasonNumber === 0) {
            const num = episodeNumber != null ? String(episodeNumber).padStart(2, '0') : '01';
            return 'Special ' + num + ' \u2014 Click to reveal';
        }
        const s = seasonNumber != null ? String(seasonNumber).padStart(2, '0') : '00';
        const e = episodeNumber != null ? String(episodeNumber).padStart(2, '0') : '00';

        const hint = ' \u2014 Click to reveal';
        if (endEpisodeNumber != null && endEpisodeNumber !== episodeNumber) {
            const eEnd = String(endEpisodeNumber).padStart(2, '0');
            return 'S' + s + 'E' + e + '\u2013E' + eEnd + hint;
        }
        return 'S' + s + 'E' + e + hint;
    }

    /**
     * Formats a short redacted title for home sections (no "Episode" prefix).
     * @param {number|null} seasonNumber Season number.
     * @param {number|null} episodeNumber Episode number.
     * @returns {string} Short title like "S2E3".
     */
    function formatShortRedactedTitle(seasonNumber, episodeNumber) {
        const s = seasonNumber != null ? seasonNumber : 0;
        const e = episodeNumber != null ? episodeNumber : 0;
        return 'S' + s + 'E' + e;
    }

    // ============================================================
    // Parent series lookup
    // ============================================================

    /**
     * Fetches the parent series ID for an episode/season item from the API.
     * Results are cached with LRU eviction; in-flight requests are de-duplicated.
     * @param {string} itemId Jellyfin item ID (episode or season).
     * @returns {Promise<string|null>} The series ID, or null.
     */
    async function getParentSeriesId(itemId) {
        if (parentSeriesCache.has(itemId)) {
            return parentSeriesCache.get(itemId);
        }
        if (parentSeriesRequestMap.has(itemId)) {
            return parentSeriesRequestMap.get(itemId);
        }
        const request = (async function () {
            try {
                if (!isValidId(itemId)) return null;

                const userId = ApiClient.getCurrentUserId();
                const item = await ApiClient.ajax({
                    type: 'GET',
                    url: ApiClient.getUrl('/Users/' + userId + '/Items/' + itemId, {
                        Fields: 'SeriesId,ParentIndexNumber,IndexNumber,UserData'
                    }),
                    dataType: 'json'
                });
                const seriesId = item?.SeriesId || null;
                evictIfNeeded(parentSeriesCache, MAX_CACHE_SIZE);
                parentSeriesCache.set(itemId, seriesId);
                return seriesId;
            } catch (e) {
                console.warn('🪼 Jellyfin Enhanced: Failed to fetch parent series for spoiler check');
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
    // CSS injection
    // ============================================================

    /**
     * Injects the CSS rules used by spoiler mode for blur effects,
     * redaction overlays, reveal controls, and the toggle button.
     */
    function injectCSS() {
        if (!JE.helpers?.addCSS) return;

        const css = `
/* ===== Pre-hide: blur unscanned EPISODE cards to prevent spoiler flash ===== */
body.je-spoiler-active .card[data-type="Episode"]:not([${SCANNED_ATTR}]) .cardScalable,
body.je-spoiler-active .listItem[data-id]:not([${SCANNED_ATTR}]) .listItem-content {
  overflow: hidden;
}
body.je-spoiler-active .card[data-type="Episode"]:not([${SCANNED_ATTR}]) .cardScalable > .cardImageContainer,
body.je-spoiler-active .listItem[data-id]:not([${SCANNED_ATTR}]) .listItemImage {
  filter: blur(${BLUR_RADIUS});
  transform: scale(1.05);
}
body.je-spoiler-active .card[data-type="Episode"]:not([${SCANNED_ATTR}]) .cardText-secondary,
body.je-spoiler-active .listItem[data-id]:not([${SCANNED_ATTR}]) .listItem-overview,
body.je-spoiler-active .listItem[data-id]:not([${SCANNED_ATTR}]) .listItem-bottomoverview,
body.je-spoiler-active .listItem[data-id]:not([${SCANNED_ATTR}]) .listItemBody {
  visibility: hidden;
}

/* ===== Spoiler blur: applied to confirmed-spoiler cards ===== */
.je-spoiler-blur .cardScalable,
.je-spoiler-generic .cardScalable {
  overflow: hidden;
}

.je-spoiler-blur .cardScalable > .cardImageContainer,
.je-spoiler-blur .cardImage,
.je-spoiler-blur .listItemImage {
  filter: blur(${BLUR_RADIUS});
  transform: scale(1.05);
  transition: filter 0.3s ease;
}

.je-spoiler-generic .cardScalable > .cardImageContainer,
.je-spoiler-generic .cardImage,
.je-spoiler-generic .listItemImage {
  filter: blur(${BLUR_RADIUS}) brightness(0.5) saturate(0.3);
  transform: scale(1.05);
  transition: filter 0.3s ease;
}

.je-spoiler-blur .cardText-secondary,
.je-spoiler-blur .listItem-overview,
.je-spoiler-blur .listItem-bottomoverview,
.je-spoiler-generic .cardText-secondary,
.je-spoiler-generic .listItem-overview,
.je-spoiler-generic .listItem-bottomoverview {
  visibility: hidden !important;
}

.je-spoiler-badge {
  position: absolute;
  top: 50%; left: 50%;
  transform: translate(-50%, -50%);
  z-index: 5;
  background: rgba(0,0,0,0.75);
  color: rgba(255,255,255,0.9);
  padding: 4px 10px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  pointer-events: none;
  white-space: nowrap;
}

.je-spoiler-text-redacted {
  color: rgba(255,255,255,0.5) !important;
  font-style: italic !important;
}

.je-spoiler-blur .je-spoiler-text-redacted,
.je-spoiler-generic .je-spoiler-text-redacted {
  visibility: visible !important;
  cursor: pointer;
}

.je-spoiler-overview-hidden {
  color: rgba(255,255,255,0.3) !important;
  font-style: italic !important;
  cursor: pointer;
}

.je-spoiler-revealing .cardScalable > .cardImageContainer,
.je-spoiler-revealing .cardImage,
.je-spoiler-revealing .listItemImage {
  filter: none !important;
  transform: scale(1) !important;
  transition: filter 0.5s ease, transform 0.5s ease !important;
}
.je-spoiler-revealing .je-spoiler-badge { display: none !important; }
.je-spoiler-revealing .cardText-secondary,
.je-spoiler-revealing .listItem-overview,
.je-spoiler-revealing .listItem-bottomoverview,
.je-spoiler-revealing .listItemBody {
  visibility: visible !important;
}

.je-spoiler-toggle-btn { transition: background 0.2s ease, opacity 0.2s ease; }
.je-spoiler-toggle-btn.je-spoiler-active { opacity: 1; }
.je-spoiler-toggle-btn.je-spoiler-active .detailButton-icon { color: #ff9800; }

.je-spoiler-reveal-banner {
  position: fixed; top: 0; left: 0; right: 0; z-index: 99998;
  background: linear-gradient(135deg, rgba(255,152,0,0.9), rgba(255,87,34,0.9));
  color: #fff; padding: 8px 16px; text-align: center;
  font-size: 13px; font-weight: 600;
  display: flex; align-items: center; justify-content: center; gap: 12px;
  backdrop-filter: blur(10px); box-shadow: 0 2px 10px rgba(0,0,0,0.3);
}
.je-spoiler-reveal-banner button {
  background: rgba(255,255,255,0.2); border: 1px solid rgba(255,255,255,0.3);
  color: #fff; padding: 4px 12px; border-radius: 4px;
  cursor: pointer; font-size: 12px; font-weight: 600;
}
.je-spoiler-reveal-banner button:hover { background: rgba(255,255,255,0.3); }

.je-spoiler-revealable { cursor: pointer; }

.je-spoiler-lock-icon {
  display: inline-flex; align-items: center;
  margin-left: 6px; opacity: 0.6; font-size: 14px;
}

.je-spoiler-osd-redacted {
  color: rgba(255,255,255,0.5) !important;
  font-style: italic !important;
}`;

        JE.helpers.addCSS('je-spoiler-mode', css);
    }

    // ============================================================
    // Detail page toggle button
    // ============================================================

    /**
     * Adds a "Spoiler Mode" toggle button to the item detail page action buttons.
     * @param {string} itemId The item's Jellyfin ID.
     * @param {string} itemType The item type (Series, Movie).
     * @param {HTMLElement} visiblePage The visible detail page element.
     */
    function addSpoilerToggleButton(itemId, itemType, visiblePage) {
        // Only show for Series and Movies
        if (itemType !== 'Series' && itemType !== 'Movie') return;

        // Don't add duplicate
        if (visiblePage.querySelector('.je-spoiler-toggle-btn')) return;

        const buttonContainer = findButtonContainer(visiblePage);
        if (!buttonContainer) return;

        const button = document.createElement('button');
        button.setAttribute('is', 'emby-button');
        button.className = 'button-flat detailButton emby-button je-spoiler-toggle-btn';
        button.type = 'button';

        const content = document.createElement('div');
        content.className = 'detailButton-content';
        button.appendChild(content);

        /**
         * Renders the button icon and label using safe DOM methods.
         * @param {string} iconName Material icon name.
         * @param {boolean} isActive Whether spoiler mode is active.
         */
        function renderContent(iconName, isActive) {
            content.replaceChildren();
            const icon = document.createElement('span');
            icon.className = 'material-icons detailButton-icon';
            icon.setAttribute('aria-hidden', 'true');
            icon.textContent = iconName;
            content.appendChild(icon);

            const textSpan = document.createElement('span');
            textSpan.className = 'detailButton-icon-text';
            textSpan.textContent = isActive
                ? (JE.t('spoiler_mode_active') !== 'spoiler_mode_active' ? JE.t('spoiler_mode_active') : 'Spoiler On')
                : (JE.t('spoiler_mode_off') !== 'spoiler_mode_off' ? JE.t('spoiler_mode_off') : 'Spoiler Off');
            content.appendChild(textSpan);
        }

        /**
         * Updates the button state based on current spoiler rule.
         */
        function updateState() {
            const rule = getRule(itemId);
            const active = rule?.enabled === true;

            if (active) {
                button.classList.add('je-spoiler-active');
                button.title = JE.t('spoiler_mode_disable_tooltip') !== 'spoiler_mode_disable_tooltip'
                    ? JE.t('spoiler_mode_disable_tooltip')
                    : 'Click to disable Spoiler Mode';
                renderContent('shield', true);
            } else {
                button.classList.remove('je-spoiler-active');
                button.title = JE.t('spoiler_mode_enable_tooltip') !== 'spoiler_mode_enable_tooltip'
                    ? JE.t('spoiler_mode_enable_tooltip')
                    : 'Click to enable Spoiler Mode';
                renderContent('shield_outlined', false);
            }
        }

        button.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();

            const rule = getRule(itemId);
            const isCurrentlyActive = rule?.enabled === true;

            // Get item name from the page title
            const nameEl = visiblePage.querySelector('.itemName, h1, h2, [class*="itemName"]');
            const itemName = nameEl?.textContent?.trim() || 'Unknown';

            setRule({
                itemId,
                itemName,
                itemType,
                enabled: !isCurrentlyActive
            });

            updateState();

            // Show toast notification using safe text
            const statusText = !isCurrentlyActive
                ? (JE.t('spoiler_mode_enabled_toast') !== 'spoiler_mode_enabled_toast'
                    ? JE.t('spoiler_mode_enabled_toast')
                    : 'Spoiler Mode enabled')
                : (JE.t('spoiler_mode_disabled_toast') !== 'spoiler_mode_disabled_toast'
                    ? JE.t('spoiler_mode_disabled_toast')
                    : 'Spoiler Mode disabled');
            JE.toast(JE.icon(JE.IconName.SHIELD) + ' ' + statusText);

            // Trigger re-scan of current page
            setTimeout(function () { processCurrentPage(); }, TOGGLE_RESCAN_DELAY_MS);
        });

        updateState();

        // Insert before the overflow menu (three-dots) button
        const moreButton = buttonContainer.querySelector('.btnMoreCommands');
        if (moreButton) {
            buttonContainer.insertBefore(button, moreButton);
        } else {
            buttonContainer.appendChild(button);
        }

        // Also add reveal-all button if spoiler mode is active
        addRevealAllButton(itemId, visiblePage);
    }

    /**
     * Adds a "Reveal All Spoilers (30s)" button to the detail page.
     * @param {string} itemId The item's Jellyfin ID.
     * @param {HTMLElement} visiblePage The visible detail page element.
     */
    function addRevealAllButton(itemId, visiblePage) {
        // Only show if spoiler mode is active for this item
        if (!isProtected(itemId)) {
            visiblePage.querySelector('.je-spoiler-reveal-all-btn')?.remove();
            return;
        }

        // Don't add duplicate
        if (visiblePage.querySelector('.je-spoiler-reveal-all-btn')) return;

        const buttonContainer = findButtonContainer(visiblePage);
        if (!buttonContainer) return;

        const button = document.createElement('button');
        button.setAttribute('is', 'emby-button');
        button.className = 'button-flat detailButton emby-button je-spoiler-reveal-all-btn';
        button.type = 'button';
        button.title = JE.t('spoiler_mode_reveal_all_tooltip') !== 'spoiler_mode_reveal_all_tooltip'
            ? JE.t('spoiler_mode_reveal_all_tooltip')
            : 'Reveal all spoilers on this page for 30 seconds';

        const content = document.createElement('div');
        content.className = 'detailButton-content';

        const icon = document.createElement('span');
        icon.className = 'material-icons detailButton-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = 'visibility';
        content.appendChild(icon);

        const textSpan = document.createElement('span');
        textSpan.className = 'detailButton-icon-text';
        textSpan.textContent = JE.t('spoiler_mode_reveal_all') !== 'spoiler_mode_reveal_all'
            ? JE.t('spoiler_mode_reveal_all')
            : 'Reveal (30s)';
        content.appendChild(textSpan);
        button.appendChild(content);

        button.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            activateRevealAll();
        });

        // Insert after the spoiler toggle
        const spoilerToggle = buttonContainer.querySelector('.je-spoiler-toggle-btn');
        if (spoilerToggle?.nextSibling) {
            buttonContainer.insertBefore(button, spoilerToggle.nextSibling);
        } else {
            const moreButton = buttonContainer.querySelector('.btnMoreCommands');
            if (moreButton) {
                buttonContainer.insertBefore(button, moreButton);
            } else {
                buttonContainer.appendChild(button);
            }
        }
    }

    // ============================================================
    // Reveal controls
    // ============================================================

    /**
     * Activates "Reveal All" mode for the configured duration.
     * Shows all spoiler-redacted content and displays a countdown banner.
     */
    function activateRevealAll() {
        revealAllActive = true;

        // Remove existing banner
        document.querySelector('.je-spoiler-reveal-banner')?.remove();

        // Build banner using safe DOM methods
        const banner = document.createElement('div');
        banner.className = 'je-spoiler-reveal-banner';

        const duration = REVEAL_ALL_DURATION;
        let remaining = Math.ceil(duration / 1000);

        const text = document.createElement('span');
        text.textContent = 'Spoilers revealed \u2014 ' + remaining + 's remaining';
        banner.appendChild(text);

        const hideBtn = document.createElement('button');
        hideBtn.textContent = 'Hide Now';
        hideBtn.addEventListener('click', function () { deactivateRevealAll(); });
        banner.appendChild(hideBtn);

        document.body.appendChild(banner);

        // Update countdown (module-level so deactivateRevealAll can clear it)
        if (revealAllCountdownInterval) clearInterval(revealAllCountdownInterval);
        revealAllCountdownInterval = setInterval(function () {
            remaining--;
            if (remaining <= 0) {
                clearInterval(revealAllCountdownInterval);
                revealAllCountdownInterval = null;
                return;
            }
            text.textContent = 'Spoilers revealed \u2014 ' + remaining + 's remaining';
        }, 1000);

        // Remove all redaction classes
        document.querySelectorAll('.je-spoiler-blur, .je-spoiler-generic').forEach(function (el) {
            el.classList.add('je-spoiler-revealing');
        });

        // Restore redacted text
        document.querySelectorAll('.je-spoiler-text-redacted').forEach(function (el) {
            if (el.dataset.jeSpoilerOriginal) {
                el.textContent = el.dataset.jeSpoilerOriginal;
                el.classList.remove('je-spoiler-text-redacted');
            }
        });

        // Restore hidden overviews
        document.querySelectorAll('.je-spoiler-overview-hidden').forEach(function (el) {
            if (el.dataset.jeSpoilerOriginal) {
                el.textContent = el.dataset.jeSpoilerOriginal;
                el.classList.remove('je-spoiler-overview-hidden');
            }
        });

        // Set auto-hide timer
        if (revealAllTimer) clearTimeout(revealAllTimer);
        revealAllTimer = setTimeout(function () {
            clearInterval(revealAllCountdownInterval);
            revealAllCountdownInterval = null;
            deactivateRevealAll();
        }, duration);
    }

    /**
     * Deactivates "Reveal All" mode and re-applies redaction.
     */
    function deactivateRevealAll() {
        revealAllActive = false;

        // Remove banner
        document.querySelector('.je-spoiler-reveal-banner')?.remove();

        // Clear timers
        if (revealAllTimer) {
            clearTimeout(revealAllTimer);
            revealAllTimer = null;
        }
        if (revealAllCountdownInterval) {
            clearInterval(revealAllCountdownInterval);
            revealAllCountdownInterval = null;
        }

        // Remove revealing class
        document.querySelectorAll('.je-spoiler-revealing').forEach(function (el) {
            el.classList.remove('je-spoiler-revealing');
        });

        // Re-scan page to re-apply redaction
        processCurrentPage();
    }

    /**
     * Reveals all spoiler-redacted content for a card: image, title,
     * description, time, etc.
     * @param {HTMLElement} card The top-level card or listItem element.
     */
    function revealCard(card) {
        const cardBox = card.querySelector('.cardBox') || card;
        cardBox.classList.add('je-spoiler-revealing');

        // Restore ALL text elements to original content
        card.querySelectorAll('.je-spoiler-text-redacted').forEach(function (el) {
            if (el.dataset.jeSpoilerOriginal) {
                el.textContent = el.dataset.jeSpoilerOriginal;
                el.classList.remove('je-spoiler-text-redacted');
            }
        });
    }

    /**
     * Re-hides all spoiler content for a card after reveal.
     * @param {HTMLElement} card The top-level card or listItem element.
     */
    function hideCard(card) {
        const cardBox = card.querySelector('.cardBox') || card;
        cardBox.classList.remove('je-spoiler-revealing');

        // Re-redact ALL text elements
        card.querySelectorAll('[data-je-spoiler-redacted]').forEach(function (el) {
            el.textContent = el.dataset.jeSpoilerRedacted;
            el.classList.add('je-spoiler-text-redacted');
        });
    }

    /**
     * Binds reveal/hide handlers to a spoiler-redacted card.
     *
     * Desktop: click redacted text to reveal; mouseleave the card area to hide.
     * Mobile:  long-press (touchstart + 300ms) to reveal; touchend to hide.
     *
     * @param {HTMLElement} card The top-level card or listItem element.
     */
    function bindCardReveal(card) {
        if (card.dataset.jeSpoilerRevealBound) return;
        card.dataset.jeSpoilerRevealBound = '1';

        const cardBox = card.querySelector('.cardBox') || card;
        let revealed = false;
        let longPressTimer = null;

        function doReveal() {
            if (revealAllActive || revealed) return;
            revealed = true;
            revealCard(card);
        }

        function doHide() {
            if (!revealed) return;
            revealed = false;
            hideCard(card);
        }

        // Desktop: click on any redacted text to reveal
        card.addEventListener('click', function (e) {
            const target = e.target;
            // Only trigger when clicking redacted/revealable text (not overlay links/buttons)
            if (target.closest('.je-spoiler-revealable') || target.closest('.je-spoiler-text-redacted')) {
                e.preventDefault();
                e.stopPropagation();
                doReveal();
            }
        });

        // Desktop: mouseleave the entire card to hide
        cardBox.addEventListener('mouseleave', function () {
            if (revealed) doHide();
        });

        // Mobile: long-press to reveal, touchend to hide
        card.addEventListener('touchstart', function () {
            if (revealed) return;
            longPressTimer = setTimeout(function () {
                longPressTimer = null;
                doReveal();
            }, LONG_PRESS_THRESHOLD_MS);
        }, { passive: true });

        card.addEventListener('touchend', function () {
            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
            if (revealed) doHide();
        }, { passive: true });

        card.addEventListener('touchcancel', function () {
            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
            if (revealed) doHide();
        }, { passive: true });
    }

    // ============================================================
    // Card redaction engine
    // ============================================================

    /**
     * Extracts the Jellyfin item ID from a card element.
     * @param {HTMLElement} el The card element.
     * @returns {string|null}
     */
    function getCardItemId(el) {
        return el.dataset?.id || el.dataset?.itemid || null;
    }

    /**
     * Detects the surface context of a card by checking parent section headers.
     * @param {HTMLElement} card The card element.
     * @returns {string|null} The detected surface or null.
     */
    function getCardSurface(card) {
        const section = card.closest('.section, .verticalSection, .homeSection');
        if (!section) return null;
        if (sectionSurfaceCache.has(section)) return sectionSurfaceCache.get(section);

        const titleEl = section.querySelector('.sectionTitle, h2, .headerText, .sectionTitle-sectionTitle');
        const title = (titleEl?.textContent || '').toLowerCase();
        let surface = null;
        if (title.includes('next up')) surface = 'nextup';
        else if (title.includes('continue watching')) surface = 'continuewatching';
        else if (title.includes('recently added')) surface = 'recentlyadded';
        else if (title.includes('upcoming')) surface = 'upcoming';
        sectionSurfaceCache.set(section, surface);
        return surface;
    }

    /**
     * Determines the current Jellyfin surface from the URL hash.
     * @returns {string} The current surface name.
     */
    function getCurrentSurface() {
        const hash = (window.location.hash || '').toLowerCase();
        if (hash.indexOf('/details') !== -1) return 'details';
        if (hash.indexOf('/search') !== -1) return 'search';
        if (hash.indexOf('/video') !== -1) return 'player';
        return 'home';
    }

    /**
     * Checks if spoiler protection should be applied on a given surface.
     * @param {string} surface The surface name.
     * @returns {boolean}
     */
    function shouldProtectSurface(surface) {
        const settings = getSettings();
        switch (surface) {
            case 'home':
            case 'nextup':
            case 'continuewatching':
                return settings.protectHome;
            case 'recentlyadded':
            case 'upcoming':
                return settings.protectHome && settings.protectRecentlyAdded !== false;
            case 'search':
                return settings.protectSearch;
            case 'player':
                return settings.protectOverlay;
            case 'details':
                return true; // Always protect detail pages
            default:
                return true;
        }
    }

    /**
     * Applies spoiler redaction to a single card element.
     * Replaces title, blurs image, and hides overview for unwatched episodes.
     * Uses only safe DOM methods (no innerHTML).
     * @param {HTMLElement} card The card element.
     * @param {Object} itemData Item metadata (Type, IndexNumber, etc).
     */
    function redactCard(card, itemData) {
        if (revealAllActive) return;

        // Don't re-redact a card that is already redacted or currently revealed
        if (card.hasAttribute(REDACTED_ATTR)) return;
        const cardBox0 = card.querySelector('.cardBox') || card;
        if (cardBox0.classList.contains('je-spoiler-revealing')) return;

        const settings = getSettings();
        const artworkPolicy = settings.artworkPolicy || 'blur';

        // Find the card's image container and apply blur/generic
        const cardBox = card.querySelector('.cardBox') || card;
        if (artworkPolicy === 'blur') {
            cardBox.classList.add('je-spoiler-blur');
            cardBox.classList.remove('je-spoiler-generic');
        } else {
            cardBox.classList.add('je-spoiler-generic');
            cardBox.classList.remove('je-spoiler-blur');
        }

        // Add spoiler badge if not already present (using safe DOM methods)
        const imageContainer = card.querySelector('.cardImageContainer') || card.querySelector('.cardImage') || card.querySelector('.listItemImage');
        if (imageContainer && !imageContainer.querySelector('.je-spoiler-badge')) {
            const badge = document.createElement('div');
            badge.className = 'je-spoiler-badge';
            badge.textContent = JE.t('spoiler_mode_hidden_badge') !== 'spoiler_mode_hidden_badge'
                ? JE.t('spoiler_mode_hidden_badge')
                : 'SPOILER';
            imageContainer.appendChild(badge);
        }

        // Redact card text elements — keep series name visible when a secondary text exists
        const titleElements = card.querySelectorAll('.cardText, .listItemBodyText');
        const hasSecondaryText = !!card.querySelector('.cardText-secondary');
        const redactedTitle = formatRedactedTitle(
            itemData.ParentIndexNumber,
            itemData.IndexNumber,
            itemData.IndexNumberEnd,
            itemData.ParentIndexNumber === 0
        );
        let isFirstRedactable = true;
        for (const titleEl of titleElements) {
            if (titleEl.classList.contains('je-spoiler-text-redacted')) continue;

            // If the card has both primary + secondary text (e.g. home page),
            // the first text is the series name — keep it visible.
            if (hasSecondaryText && titleEl.classList.contains('cardText-first')) continue;

            // Store original text for reveal
            if (!titleEl.dataset.jeSpoilerOriginal) {
                titleEl.dataset.jeSpoilerOriginal = titleEl.textContent;
            }

            // First redactable text gets the formatted title; others get cleared
            const replacement = isFirstRedactable ? redactedTitle : '';
            titleEl.dataset.jeSpoilerRedacted = replacement;
            titleEl.textContent = replacement;
            titleEl.classList.add('je-spoiler-text-redacted');

            // Mark the first redactable text as the click target for reveal
            if (isFirstRedactable) {
                titleEl.classList.add('je-spoiler-revealable');
            }

            isFirstRedactable = false;
        }

        // Bind hover/touch reveal handlers to the whole card
        bindCardReveal(card);

        card.setAttribute(REDACTED_ATTR, '1');
    }

    /**
     * Blurs a season card poster without redacting the title text.
     * @param {HTMLElement} card The season card element.
     */
    function blurSeasonCard(card) {
        if (card.hasAttribute(REDACTED_ATTR)) return;

        const settings = getSettings();
        const artworkPolicy = settings.artworkPolicy || 'blur';
        const cardBox = card.querySelector('.cardBox') || card;

        if (artworkPolicy === 'blur') {
            cardBox.classList.add('je-spoiler-blur');
            cardBox.classList.remove('je-spoiler-generic');
        } else {
            cardBox.classList.add('je-spoiler-generic');
            cardBox.classList.remove('je-spoiler-blur');
        }

        const imageContainer = card.querySelector('.cardImageContainer') || card.querySelector('.cardImage');
        if (imageContainer && !imageContainer.querySelector('.je-spoiler-badge')) {
            const badge = document.createElement('div');
            badge.className = 'je-spoiler-badge';
            badge.textContent = JE.t('spoiler_mode_hidden_badge') !== 'spoiler_mode_hidden_badge'
                ? JE.t('spoiler_mode_hidden_badge')
                : 'SPOILER';
            imageContainer.appendChild(badge);
        }

        card.setAttribute(REDACTED_ATTR, '1');
    }

    /**
     * Removes spoiler redaction from a card element.
     * @param {HTMLElement} card The card element.
     */
    function unredactCard(card) {
        const cardBox = card.querySelector('.cardBox') || card;
        cardBox.classList.remove('je-spoiler-blur', 'je-spoiler-generic', 'je-spoiler-revealing');

        // Remove badge
        card.querySelectorAll('.je-spoiler-badge').forEach(function (b) { b.remove(); });

        // Restore titles
        card.querySelectorAll('.je-spoiler-text-redacted').forEach(function (el) {
            if (el.dataset.jeSpoilerOriginal) {
                el.textContent = el.dataset.jeSpoilerOriginal;
                delete el.dataset.jeSpoilerOriginal;
                delete el.dataset.jeSpoilerRedacted;
            }
            el.classList.remove('je-spoiler-text-redacted', 'je-spoiler-revealable');
        });

        card.removeAttribute(REDACTED_ATTR);
    }

    // ============================================================
    // Card filtering (MutationObserver-based)
    // ============================================================

    /**
     * Fetches episode data from the API and redacts if needed (special episodes).
     * @param {HTMLElement} card The card element.
     * @param {string} itemId The item ID.
     * @param {string} seriesId The parent series ID.
     * @param {number} seasonNum The season number.
     * @param {number} epNum The episode number.
     */
    async function processSpecialEpisode(card, itemId, seriesId, seasonNum, epNum) {
        if (!isValidId(itemId)) return;

        const userId = ApiClient.getCurrentUserId();
        try {
            const item = await ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl('/Users/' + userId + '/Items/' + itemId, {
                    Fields: 'UserData,ParentIndexNumber,IndexNumber,IndexNumberEnd'
                }),
                dataType: 'json'
            });
            if (item && shouldRedactEpisode(item)) {
                redactCard(card, item);
            }
        } catch (e) {
            // If we can't fetch data, redact to be safe
            redactCard(card, {
                Id: itemId,
                ParentIndexNumber: seasonNum,
                IndexNumber: epNum,
                IndexNumberEnd: null
            });
        }
    }

    /**
     * Fetches episode data from the API when no season/episode numbers are on the card.
     * @param {HTMLElement} card The card element.
     * @param {string} itemId The item ID.
     * @param {string} seriesId The parent series ID.
     */
    async function processEpisodeWithoutNumbers(card, itemId, seriesId) {
        if (!isValidId(itemId)) return;

        const userId = ApiClient.getCurrentUserId();
        try {
            const item = await ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl('/Users/' + userId + '/Items/' + itemId, {
                    Fields: 'UserData,ParentIndexNumber,IndexNumber,IndexNumberEnd'
                }),
                dataType: 'json'
            });
            if (!item) return;

            const itemSeason = item.ParentIndexNumber;
            // For specials or when boundary returns null, check individually
            if (itemSeason === 0 || itemSeason == null) {
                if (shouldRedactEpisode(item)) {
                    redactCard(card, item);
                }
            } else {
                const bp = await isEpisodePastBoundary(seriesId, itemSeason, item.IndexNumber || 0);
                if (bp) {
                    redactCard(card, item);
                }
            }
        } catch (e) {
            console.warn('🪼 Jellyfin Enhanced: Failed to fetch episode data for spoiler check');
        }
    }

    /**
     * Processes a season card to determine if it should be blurred.
     * @param {HTMLElement} card The card element.
     * @param {string} itemId The season item ID.
     */
    async function processSeasonCard(card, itemId) {
        if (!isValidId(itemId)) return;

        const userId = ApiClient.getCurrentUserId();
        try {
            const seasonItem = await ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl('/Users/' + userId + '/Items/' + itemId, {
                    Fields: 'SeriesId,IndexNumber'
                }),
                dataType: 'json'
            });

            if (!seasonItem) return;

            const seasonSeriesId = seasonItem.SeriesId;
            const seasonNum = seasonItem.IndexNumber;

            if (!seasonSeriesId || !isProtected(seasonSeriesId) || seasonNum == null) return;

            const boundary = await computeBoundary(seasonSeriesId);
            // Blur seasons beyond the boundary season, or all if nothing watched
            if ((boundary && seasonNum > boundary.season) || !boundary) {
                blurSeasonCard(card);
            }
        } catch (e) {
            // Ignore errors for season cards
        }
    }

    /**
     * Processes a single card to determine if it needs spoiler redaction.
     * For episode/season cards, checks if their parent series is protected
     * and whether the episode is past the boundary.
     * @param {HTMLElement} card The card element.
     */
    async function processCard(card) {
        try {
            if (card.hasAttribute('data-imagetype')) return; // Skip image editor cards

            const itemId = getCardItemId(card);
            if (!itemId) return;

            const cardType = (card.dataset.type || '').toLowerCase();
            const surface = getCardSurface(card) || getCurrentSurface();

            if (!shouldProtectSurface(surface)) return;

            // For a series/movie card on the home page, don't redact the series card itself
            if (isProtected(itemId) && (cardType === 'series' || cardType === 'movie')) {
                return;
            }

            // Episode or unknown-type card from a protected series
            if (cardType === 'episode' || cardType === '') {
                let seriesId = card.dataset.seriesid || null;
                if (!seriesId) {
                    seriesId = await getParentSeriesId(itemId);
                }

                if (!seriesId || !isProtected(seriesId)) return;

                const rawSeason = card.dataset.parentindexnumber || card.dataset.season;
                const rawEp = card.dataset.indexnumber || card.dataset.episode;
                const hasNumbers = rawSeason != null || rawEp != null;
                const seasonNum = parseInt(rawSeason || '0', 10);
                const epNum = parseInt(rawEp || '0', 10);

                if (hasNumbers) {
                    const pastBoundary = await isEpisodePastBoundary(seriesId, seasonNum, epNum);

                    if (pastBoundary === null) {
                        // Specials (season 0) — check individual UserData
                        await processSpecialEpisode(card, itemId, seriesId, seasonNum, epNum);
                    } else if (pastBoundary) {
                        redactCard(card, {
                            Id: itemId,
                            ParentIndexNumber: seasonNum,
                            IndexNumber: epNum,
                            IndexNumberEnd: null
                        });
                    }
                } else {
                    await processEpisodeWithoutNumbers(card, itemId, seriesId);
                }
            }

            // Season card from a protected series
            if (cardType === 'season') {
                await processSeasonCard(card, itemId);
            }
        } finally {
            // Mark card as fully scanned — removes the pre-hide CSS blur
            card.setAttribute(SCANNED_ATTR, '1');
        }
    }

    /**
     * Processes all new (unscanned) cards on the page.
     */
    function filterNewCards() {
        if (protectedIdSet.size === 0) return;

        const cards = document.querySelectorAll(CARD_SEL_NEW);
        for (const card of cards) {
            card.setAttribute(PROCESSED_ATTR, '1');
            processCard(card);
        }
    }

    /**
     * Re-processes all cards on the page (including previously scanned ones).
     */
    function filterAllCards() {
        const cards = document.querySelectorAll(CARD_SEL);
        for (const card of cards) {
            card.setAttribute(PROCESSED_ATTR, '1');

            // First unredact, then re-check
            if (card.hasAttribute(REDACTED_ATTR)) {
                unredactCard(card);
            }
            processCard(card);
        }
    }

    /**
     * Processes the current page: re-scans cards and applies redaction.
     */
    function processCurrentPage() {
        if (protectedIdSet.size === 0) return;

        // Reset processed and scanned flags so all cards get re-checked
        document.querySelectorAll('[' + PROCESSED_ATTR + '], [' + SCANNED_ATTR + ']').forEach(function (el) {
            el.removeAttribute(PROCESSED_ATTR);
            el.removeAttribute(SCANNED_ATTR);
        });

        filterAllCards();
    }

    // ============================================================
    // Detail page episode list redaction
    // ============================================================

    /**
     * Scans the episode list on a series/season detail page and applies
     * spoiler redaction to unwatched episodes.
     * @param {string} itemId The series or season ID.
     * @param {HTMLElement} visiblePage The visible detail page element.
     */
    async function redactEpisodeList(itemId, visiblePage) {
        if (revealAllActive) return;

        let seriesId = itemId;
        const userId = ApiClient.getCurrentUserId();

        try {
            const item = await ApiClient.getItem(userId, itemId);
            if (item?.Type === 'Season') {
                seriesId = item.SeriesId || itemId;
            } else if (item?.Type !== 'Series') {
                return;
            }
        } catch (e) {
            return;
        }

        if (!isProtected(seriesId)) return;

        const settings = getSettings();

        // Redact the series/movie overview if configured (using textContent)
        if (!settings.showSeriesOverview) {
            const overviewEl = visiblePage.querySelector('.overview, .itemOverview');
            if (overviewEl && !overviewEl.classList.contains('je-spoiler-overview-hidden')) {
                overviewEl.dataset.jeSpoilerOriginal = overviewEl.textContent;
                const hiddenText = JE.t('spoiler_mode_hidden_overview') !== 'spoiler_mode_hidden_overview'
                    ? JE.t('spoiler_mode_hidden_overview')
                    : 'Overview hidden \u2014 tap to reveal';
                overviewEl.textContent = hiddenText;
                overviewEl.classList.add('je-spoiler-overview-hidden');
                overviewEl.addEventListener('click', function () {
                    if (overviewEl.classList.contains('je-spoiler-overview-hidden')) {
                        overviewEl.textContent = overviewEl.dataset.jeSpoilerOriginal;
                        overviewEl.classList.remove('je-spoiler-overview-hidden');
                        // Auto-hide after reveal duration
                        setTimeout(function () {
                            if (!revealAllActive) {
                                overviewEl.textContent = hiddenText;
                                overviewEl.classList.add('je-spoiler-overview-hidden');
                            }
                        }, settings.revealDuration || DEFAULT_REVEAL_DURATION);
                    }
                });
            }
        }

        // Blur the series backdrop if strict mode
        if (settings.artworkPolicy === 'generic' || settings.hideGuestStars) {
            const backdropEl = visiblePage.querySelector('.backdropImage, .detailImageContainer img');
            if (backdropEl) {
                backdropEl.style.filter = 'blur(' + BLUR_RADIUS + ')';
                backdropEl.style.transition = 'filter 0.3s ease';
            }
        }

        // Process episode cards on the detail page in parallel
        const episodeCards = visiblePage.querySelectorAll('.card[data-id], .listItem[data-id]');
        const promises = [];
        for (const card of episodeCards) {
            card.setAttribute(PROCESSED_ATTR, '1');
            promises.push(processCard(card));
        }
        await Promise.all(promises);
    }

    // ============================================================
    // Search result redaction
    // ============================================================

    /**
     * Redacts episode results in search that belong to protected series.
     */
    function redactSearchResults() {
        const settings = getSettings();
        if (!settings.protectSearch) return;
        if (protectedIdSet.size === 0) return;
        filterNewCards();
    }

    // ============================================================
    // Player overlay redaction
    // ============================================================

    /**
     * Redacts episode title and chapter names in the player OSD.
     * @param {string} itemId The currently playing item ID.
     */
    async function redactPlayerOverlay(itemId) {
        if (!itemId) return;
        if (revealAllActive) return;

        const settings = getSettings();
        if (!settings.protectOverlay) return;

        const seriesId = await getParentSeriesId(itemId);
        if (!seriesId || !isProtected(seriesId)) return;

        try {
            if (!isValidId(itemId)) return;

            const userId = ApiClient.getCurrentUserId();
            const item = await ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl('/Users/' + userId + '/Items/' + itemId, {
                    Fields: 'UserData,ParentIndexNumber,IndexNumber'
                }),
                dataType: 'json'
            });

            if (!item || !shouldRedactEpisode(item)) return;

            const redactedTitle = formatRedactedTitle(
                item.ParentIndexNumber,
                item.IndexNumber,
                item.IndexNumberEnd,
                item.ParentIndexNumber === 0
            );

            // Redact OSD title using textContent
            const titleSelectors = [
                '.osdTitle',
                '.videoOsdTitle',
                '.osd-title',
                '.mediaInfoPrimaryContainer h3',
                '.nowPlayingPageTitle'
            ];

            for (const sel of titleSelectors) {
                const el = document.querySelector(sel);
                if (el && el.textContent && !el.classList.contains('je-spoiler-osd-redacted')) {
                    el.dataset.jeSpoilerOriginal = el.textContent;
                    el.textContent = (item.SeriesName || '') + ' \u2014 ' + redactedTitle;
                    el.classList.add('je-spoiler-osd-redacted');
                }
            }

            // Redact chapter names
            const chapterElements = document.querySelectorAll('.chapterCard .chapterCardText, [data-chapter-name]');
            let chapterIndex = 1;
            for (const chapterEl of chapterElements) {
                if (!chapterEl.classList.contains('je-spoiler-osd-redacted')) {
                    chapterEl.dataset.jeSpoilerOriginal = chapterEl.textContent;
                    chapterEl.textContent = 'Chapter ' + chapterIndex;
                    chapterEl.classList.add('je-spoiler-osd-redacted');
                }
                chapterIndex++;
            }

            // Blur chapter thumbnail previews
            const chapterImages = document.querySelectorAll('.chapterCard img, .chapterCardImage');
            for (const img of chapterImages) {
                img.style.filter = 'blur(' + BLUR_RADIUS + ')';
                img.style.transition = 'filter 0.3s ease';
            }

        } catch (e) {
            console.warn('🪼 Jellyfin Enhanced: Error redacting player overlay');
        }
    }

    // ============================================================
    // Calendar event redaction
    // ============================================================

    /**
     * Filters calendar events to redact episode titles for protected series.
     * @param {Array} events Array of calendar event objects.
     * @returns {Array} Events with redacted titles where applicable.
     */
    function filterCalendarEvents(events) {
        const settings = getSettings();
        if (!settings.protectCalendar) return events;
        if (!Array.isArray(events) || protectedIdSet.size === 0) return events;

        return events.map(function (event) {
            const seriesId = event.seriesId || event.SeriesId;
            if (!seriesId || !isProtected(seriesId)) return event;

            const seasonNum = event.seasonNumber || event.ParentIndexNumber || 0;
            const epNum = event.episodeNumber || event.IndexNumber || 0;
            const redactedTitle = formatShortRedactedTitle(seasonNum, epNum);

            return {
                ...event,
                title: (event.seriesName || event.SeriesName || '') + ' \u2014 ' + redactedTitle,
                overview: ''
            };
        });
    }

    // ============================================================
    // Auto-enable features
    // ============================================================

    /**
     * Checks if an item should be auto-enabled via tag matching.
     * @param {Object} item Jellyfin item with Tags array.
     * @returns {boolean} True if any tag matches the auto-enable list.
     */
    function shouldAutoEnableByTag(item) {
        const data = getSpoilerData();
        const tags = data.tagAutoEnable || [];
        if (tags.length === 0) return false;
        if (!item?.Tags || !Array.isArray(item.Tags)) return false;

        const lowerTags = tags.map(function (t) { return t.toLowerCase(); });
        return item.Tags.some(function (t) { return lowerTags.includes(t.toLowerCase()); });
    }

    /**
     * Handles auto-enable on first play. Called when playback starts.
     * @param {string} itemId The item being played.
     */
    async function handleAutoEnableOnFirstPlay(itemId) {
        const data = getSpoilerData();
        const enableOnFirst = data.autoEnableOnFirstPlay;
        const hasTagRules = (data.tagAutoEnable || []).length > 0;

        // Skip if neither auto-enable method is active
        if (!enableOnFirst && !hasTagRules) return;

        try {
            if (!isValidId(itemId)) return;

            const userId = ApiClient.getCurrentUserId();
            const item = await ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl('/Users/' + userId + '/Items/' + itemId, {
                    Fields: 'SeriesId,ParentIndexNumber,IndexNumber,Tags'
                }),
                dataType: 'json'
            });

            if (!item) return;

            const seriesId = item.SeriesId;
            if (!seriesId) return;

            // Check if this is Episode 1 (first play of a new series)
            if (enableOnFirst) {
                const isFirstEpisode = (item.ParentIndexNumber === 1 || item.ParentIndexNumber === 0) &&
                    (item.IndexNumber === 1);

                if (isFirstEpisode && !isProtected(seriesId)) {
                    const seriesName = item.SeriesName || '';
                    setRule({
                        itemId: seriesId,
                        itemName: seriesName,
                        itemType: 'Series',
                        enabled: true
                    });

                    JE.toast(JE.icon(JE.IconName.SHIELD) + ' Spoiler Mode auto-enabled for ' + escapeHtml(seriesName));
                    return; // Already enabled, no need to check tags
                }
            }

            // Check tags on the series (need to fetch series data for tags)
            if (hasTagRules && !isProtected(seriesId)) {
                try {
                    const series = await ApiClient.getItem(userId, seriesId);
                    if (series) {
                        checkAndAutoEnableByTag(seriesId, series);
                    }
                } catch (e) {
                    // Ignore — tag check is best-effort
                }
            }
        } catch (e) {
            console.warn('🪼 Jellyfin Enhanced: Error in auto-enable on first play');
        }
    }

    /**
     * Checks tags on a series/movie and auto-enables spoiler mode if matched.
     * @param {string} itemId The item ID.
     * @param {Object} item The item data (must include Tags).
     */
    function checkAndAutoEnableByTag(itemId, item) {
        if (!item || isProtected(itemId)) return;
        if (shouldAutoEnableByTag(item)) {
            setRule({
                itemId,
                itemName: item.Name || item.SeriesName || '',
                itemType: item.Type || 'Series',
                enabled: true
            });
        }
    }

    // ============================================================
    // Unified observer
    // ============================================================

    /** Debounced card filter function. */
    const debouncedFilter = JE.helpers?.debounce
        ? JE.helpers.debounce(function () { requestAnimationFrame(filterNewCards); }, FILTER_DEBOUNCE_MS)
        : filterNewCards;

    /** Debounced detail page handler. */
    const debouncedDetailPageHandler = JE.helpers?.debounce
        ? JE.helpers.debounce(handleDetailPageMutation, TOGGLE_RESCAN_DELAY_MS)
        : handleDetailPageMutation;

    /** OSD handler function (shared between debounced and fallback paths). */
    function handleOsdMutation() {
        if (getCurrentSurface() !== 'player') return;
        if (protectedIdSet.size === 0) return;
        const itemId = getPlayerItemId();
        if (itemId) {
            redactPlayerOverlay(itemId);
        }
    }

    /** Debounced OSD handler. */
    const debouncedOsdHandler = JE.helpers?.debounce
        ? JE.helpers.debounce(handleOsdMutation, OSD_MUTATION_DEBOUNCE_MS)
        : handleOsdMutation;

    /**
     * Gets the current playing item ID from OSD or URL hash.
     * @returns {string|null}
     */
    function getPlayerItemId() {
        // Primary: OSD favorite button (most reliable)
        const favBtn = document.querySelector('.videoOsdBottom .btnUserRating[data-id]');
        if (favBtn?.dataset?.id) return favBtn.dataset.id;
        // Fallback: URL hash
        const hash = window.location.hash || '';
        const params = new URLSearchParams(hash.split('?')[1]);
        return params.get('id') || null;
    }

    /**
     * Handles detail page mutations (adding toggle button, redacting episodes).
     */
    function handleDetailPageMutation() {
        if (detailPageProcessing) return;

        const visiblePage = document.querySelector('#itemDetailPage:not(.hide)');
        if (!visiblePage) return;

        try {
            const hashParams = new URLSearchParams(window.location.hash.split('?')[1]);
            const itemId = hashParams.get('id');
            if (!itemId || !isValidId(itemId)) return;

            // Skip if we already processed this item
            if (itemId === lastDetailPageItemId && visiblePage.querySelector('.je-spoiler-toggle-btn')) return;
            lastDetailPageItemId = itemId;
            detailPageProcessing = true;

            const userId = ApiClient.getCurrentUserId();
            ApiClient.getItem(userId, itemId).then(function (item) {
                if (!item) { detailPageProcessing = false; return; }

                // Add spoiler toggle for Series and Movies
                if (item.Type === 'Series' || item.Type === 'Movie') {
                    addSpoilerToggleButton(itemId, item.Type, visiblePage);
                    checkAndAutoEnableByTag(itemId, item);
                }

                // Redact episode list if on a protected series/season page
                if (item.Type === 'Series' || item.Type === 'Season') {
                    redactEpisodeList(itemId, visiblePage).then(function () {
                        detailPageProcessing = false;
                    }).catch(function () {
                        detailPageProcessing = false;
                    });
                } else {
                    detailPageProcessing = false;
                }
            }).catch(function () { detailPageProcessing = false; });
        } catch (e) {
            detailPageProcessing = false;
            console.warn('🪼 Jellyfin Enhanced: Error in spoiler detail page observer');
        }
    }

    /**
     * Unified MutationObserver callback handling card filtering, detail page,
     * and player OSD — all in a single observer.
     * @param {MutationRecord[]} mutations The mutation records.
     */
    function handleMutations(mutations) {
        if (protectedIdSet.size === 0) return;

        let hasNewCards = false;
        for (let i = 0; i < mutations.length; i++) {
            const addedNodes = mutations[i].addedNodes;
            for (let j = 0; j < addedNodes.length; j++) {
                const node = addedNodes[j];
                if (node.nodeType === 1 && (
                    node.classList?.contains('card') ||
                    node.classList?.contains('listItem') ||
                    node.querySelector?.('.card[data-id], .listItem[data-id]')
                )) {
                    hasNewCards = true;
                    break;
                }
            }
            if (hasNewCards) break;
        }

        if (hasNewCards) {
            debouncedFilter();
        }

        // Only invoke surface-specific handlers when on their respective surface
        const surface = getCurrentSurface();

        // Detail page handling
        if (surface === 'details') {
            debouncedDetailPageHandler();
        }

        // Player OSD handling
        if (surface === 'player') {
            debouncedOsdHandler();
        }
    }

    /**
     * Connects the unified MutationObserver to document.body.
     * No-op if already connected.
     */
    function connectObserver() {
        if (unifiedObserver || typeof MutationObserver === 'undefined') return;
        unifiedObserver = new MutationObserver(handleMutations);
        unifiedObserver.observe(document.body, { childList: true, subtree: true });
    }

    /**
     * Disconnects the unified MutationObserver.
     */
    function disconnectObserver() {
        if (!unifiedObserver) return;
        unifiedObserver.disconnect();
        unifiedObserver = null;
    }

    /**
     * Sets up page-navigation hooks to trigger spoiler redaction.
     */
    function setupObservers() {
        // Page navigation hook
        if (JE.helpers?.onViewPage) {
            JE.helpers.onViewPage(function () {
                // Reset detail page guard on navigation
                lastDetailPageItemId = null;
                detailPageProcessing = false;

                const surface = getCurrentSurface();

                if (surface === 'details') {
                    setTimeout(function () {
                        if (protectedIdSet.size > 0) filterNewCards();
                    }, DETAIL_RESCAN_DELAY_MS);
                } else if (surface === 'search') {
                    setTimeout(function () { redactSearchResults(); }, DETAIL_RESCAN_DELAY_MS);
                    setTimeout(function () { redactSearchResults(); }, DETAIL_FINAL_RESCAN_DELAY_MS);
                } else if (surface === 'home') {
                    setTimeout(function () { filterNewCards(); }, DETAIL_RESCAN_DELAY_MS);
                    setTimeout(function () { filterNewCards(); }, DETAIL_FINAL_RESCAN_DELAY_MS);
                } else if (surface === 'player') {
                    setTimeout(function () {
                        const playerItemId = getPlayerItemId();
                        if (playerItemId) {
                            redactPlayerOverlay(playerItemId);
                            handleAutoEnableOnFirstPlay(playerItemId);
                        }
                    }, PLAYER_OSD_DELAY_MS);
                }
            });
        }

        // Connect the unified observer if there are protected items
        if (protectedIdSet.size > 0) {
            connectObserver();
        }
    }

    // ============================================================
    // Public API & Initialization
    // ============================================================

    /**
     * Initializes the Spoiler Mode module: loads data, rebuilds lookup sets,
     * injects CSS, sets up observers, and exposes the public API.
     */
    JE.initializeSpoilerMode = function () {
        spoilerData = JE.userConfig?.spoilerMode || {
            rules: {},
            settings: {},
            tagAutoEnable: [],
            autoEnableOnFirstPlay: false
        };
        rebuildSets();

        // Activate pre-hide CSS immediately so cards are blurred before they render
        if (protectedIdSet.size > 0) {
            document.body.classList.add('je-spoiler-active');
        } else {
            document.body.classList.remove('je-spoiler-active');
        }

        injectCSS();
        setupObservers();

        // Initial filter after a short delay (for async page rendering)
        if (protectedIdSet.size > 0) {
            setTimeout(filterAllCards, INIT_FILTER_DELAY_MS);
        }

        // Expose public API
        JE.spoilerMode = {
            isProtected,
            getRule,
            setRule,
            getSettings,
            updateSettings,
            setAutoEnableOnFirstPlay,
            computeBoundary,
            isEpisodePastBoundary,
            shouldRedactEpisode,
            formatRedactedTitle,
            formatShortRedactedTitle,
            filterCalendarEvents,
            activateRevealAll,
            deactivateRevealAll,
            revealCard,
            hideCard,
            processCurrentPage,
            redactSearchResults,
            redactPlayerOverlay,
            handleAutoEnableOnFirstPlay,
            checkAndAutoEnableByTag,
            getSpoilerData,
            rebuildSets
        };
    };

})(window.JellyfinEnhanced);
