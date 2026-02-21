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

    /** Body class toggled while detail-page overview redaction is pending. */
    const DETAIL_OVERVIEW_PENDING_CLASS = 'je-spoiler-detail-pending';

    /** Class marking overview text as manually revealed during spoiler mode. */
    const OVERVIEW_REVEALED_CLASS = 'je-spoiler-overview-revealed';

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

    /** The user ID that owns the current spoilerData (prevents cross-user saves). */
    let spoilerDataOwnerId = null;

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

    /**
     * LRU cache for movie watched state.
     * Map<movieId, { watched: boolean, ts: number }>
     */
    const movieWatchedCache = new Map();

    /** In-flight movie watched requests. Map<movieId, Promise> */
    const movieWatchedRequestMap = new Map();

    /**
     * LRU cache for season fully-watched state.
     * Map<seasonId, { watched: boolean, ts: number }>
     */
    const seasonWatchedCache = new Map();

    /** In-flight season watched requests. Map<seasonId, Promise> */
    const seasonWatchedRequestMap = new Map();

    /**
     * LRU cache for collection item listings.
     * Map<collectionId, { items: Set<movieId>, ts: number }>
     */
    const collectionItemsCache = new Map();

    /** In-flight collection items requests. Map<collectionId, Promise> */
    const collectionItemsRequestMap = new Map();

    /**
     * Reverse lookup: movieId → Set<collectionId>.
     * Built lazily when collection contents are fetched.
     */
    const collectionMemberMap = new Map();

    /**
     * Set of protected BoxSet IDs (subset of protectedIdSet where itemType === 'BoxSet').
     * Rebuilt by rebuildSets() to avoid iterating all rules during card processing.
     */
    const protectedCollectionIds = new Set();

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

    /** Timer IDs from onViewPage navigation callbacks, cleared on re-navigation. */
    let navigationTimers = [];

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
     * Whether detail overview text should be pre-hidden until redaction completes.
     * @returns {boolean}
     */
    function shouldPrehideDetailOverview() {
        if (revealAllActive) return false;
        if (protectedIdSet.size === 0) return false;
        return !getSettings().showSeriesOverview;
    }

    /**
     * Returns true when detail overview pre-hide should be skipped to avoid flicker.
     * Used for already-safe season pages and active manual reveals.
     * @param {HTMLElement|null} visiblePage The active detail page element.
     * @returns {boolean}
     */
    function shouldSkipDetailOverviewPrehide(visiblePage) {
        if (!visiblePage) return false;
        const overviewEl = visiblePage.querySelector('.overview, .itemOverview');
        if (!overviewEl) return false;

        const hash = window.location.hash || '';
        const params = new URLSearchParams(hash.split('?')[1]);
        const detailItemId = params.get('id') || '';

        if (overviewEl.dataset.jeSpoilerOverviewSafeFor === detailItemId && detailItemId) return true;

        // Fast-path from cache for repeat visits to already-known fully watched seasons.
        if (detailItemId) {
            const cached = seasonWatchedCache.get(detailItemId);
            if (cached && cached.watched === true && (Date.now() - cached.ts) < BOUNDARY_CACHE_TTL) {
                return true;
            }
        }

        if (overviewEl.classList.contains(OVERVIEW_REVEALED_CLASS)) return true;
        const revealUntil = Number(overviewEl.dataset.jeSpoilerRevealUntil || '0');
        return revealUntil > Date.now();
    }

    /**
     * Toggles body-level pre-hide class for detail overview text.
     * @param {boolean} pending Whether detail processing is pending.
     */
    function setDetailOverviewPending(pending) {
        if (!document.body?.classList) return;
        if (pending) {
            document.body.classList.add(DETAIL_OVERVIEW_PENDING_CLASS);
        } else {
            document.body.classList.remove(DETAIL_OVERVIEW_PENDING_CLASS);
        }
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
     * Returns a translated string for the given key, falling back to a default
     * when JE.t() returns the raw key (i.e. no translation is loaded).
     * @param {string} key Translation key.
     * @param {string} fallback Default text when no translation exists.
     * @returns {string}
     */
    function tFallback(key, fallback) {
        var translated = JE.t(key);
        return translated !== key ? translated : fallback;
    }

    /**
     * Normalizes a spoiler rule entry from either legacy `items` schema
     * (name/type) or current `rules` schema (itemName/itemType).
     * @param {string} key Rule key.
     * @param {Object} entry Raw rule/item entry.
     * @param {string} fallbackPreset Preset fallback.
     * @returns {Object} Normalized rule entry.
     */
    function normalizeRuleEntry(key, entry, fallbackPreset) {
        const raw = entry || {};
        return {
            itemId: raw.itemId || key,
            itemName: raw.itemName || raw.name || '',
            itemType: raw.itemType || raw.type || '',
            enabled: raw.enabled !== false,
            preset: raw.preset || fallbackPreset || 'balanced',
            boundaryOverride: raw.boundaryOverride || null,
            enabledAt: raw.enabledAt || new Date().toISOString()
        };
    }

    /**
     * Converts internal `rules` schema to server-compatible `items` schema.
     * @param {Object.<string, Object>} rules Internal rules map.
     * @returns {Object.<string, Object>} Items map.
     */
    function rulesToItems(rules) {
        const result = {};
        const source = rules || {};
        for (const key of Object.keys(source)) {
            const rule = source[key];
            if (!rule || rule.enabled === false) continue;
            result[key] = {
                itemId: rule.itemId || key,
                name: rule.itemName || '',
                type: rule.itemType || '',
                enabledAt: rule.enabledAt || new Date().toISOString(),
                preset: rule.preset || 'balanced'
            };
        }
        return result;
    }

    /**
     * Converts internal rules into the server `Rules` schema.
     * @param {Object.<string, Object>} rules Internal rules map.
     * @returns {Object.<string, Object>} Rules map for persistence.
     */
    function rulesToServerRules(rules) {
        const result = {};
        const source = rules || {};
        for (const key of Object.keys(source)) {
            const rule = source[key];
            if (!rule || rule.enabled === false) continue;
            result[key] = {
                itemId: rule.itemId || key,
                itemName: rule.itemName || rule.name || '',
                itemType: rule.itemType || rule.type || '',
                enabled: rule.enabled !== false,
                preset: rule.preset || 'balanced',
                boundaryOverride: rule.boundaryOverride || null,
                enabledAt: rule.enabledAt || new Date().toISOString()
            };
        }
        return result;
    }

    /**
     * Normalizes spoiler mode payloads from server (`items`) and local (`rules`)
     * into a single internal shape.
     * @param {Object|null|undefined} rawData Raw spoiler mode object.
     * @returns {{ rules: Object, settings: Object, tagAutoEnable: string[], autoEnableOnFirstPlay: boolean }}
     */
    function normalizeSpoilerData(rawData) {
        const raw = (rawData && typeof rawData === 'object') ? rawData : {};
        const rawSettings = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
        const fallbackPreset = rawSettings.defaultPreset || rawSettings.preset || 'balanced';

        const sourceRules = raw.rules && typeof raw.rules === 'object'
            ? raw.rules
            : (raw.items && typeof raw.items === 'object' ? raw.items : {});

        const normalizedRules = {};
        for (const key of Object.keys(sourceRules)) {
            const normalized = normalizeRuleEntry(key, sourceRules[key], fallbackPreset);
            if (normalized.enabled) {
                normalizedRules[key] = normalized;
            }
        }

        const tagAutoEnable = Array.isArray(raw.tagAutoEnable)
            ? raw.tagAutoEnable
            : (Array.isArray(rawSettings.autoEnableTags) ? rawSettings.autoEnableTags : []);

        const autoEnableOnFirstPlay = typeof raw.autoEnableOnFirstPlay === 'boolean'
            ? raw.autoEnableOnFirstPlay
            : !!rawSettings.autoEnableOnFirstPlay;

        return {
            ...raw,
            rules: normalizedRules,
            settings: { ...rawSettings },
            tagAutoEnable,
            autoEnableOnFirstPlay
        };
    }

    /**
     * Builds the payload persisted to spoiler-mode.json (server model compatible).
     * @param {{ rules: Object, settings: Object, tagAutoEnable: string[], autoEnableOnFirstPlay: boolean }} data Internal data.
     * @returns {{ rules: Object, items: Object, settings: Object, tagAutoEnable: string[], autoEnableOnFirstPlay: boolean }} Server-compatible payload.
     */
    function toServerSpoilerData(data) {
        const source = data || getSpoilerData();
        const rules = rulesToServerRules(source.rules);
        const tagAutoEnable = Array.isArray(source.tagAutoEnable) ? source.tagAutoEnable : [];
        const autoEnableOnFirstPlay = !!source.autoEnableOnFirstPlay;
        const settings = {
            ...(source.settings || {}),
            autoEnableTags: tagAutoEnable,
            autoEnableOnFirstPlay,
            defaultPreset: source.settings?.defaultPreset || source.settings?.preset || 'balanced'
        };

        return {
            // Current schema expected by the server type model.
            rules,
            // Legacy compatibility for older clients/loaders.
            items: rulesToItems(rules),
            settings,
            tagAutoEnable,
            autoEnableOnFirstPlay
        };
    }

    /**
     * Mirrors normalized spoiler data into JE.userConfig while preserving legacy
     * `items` shape for compatibility with existing consumers.
     */
    function syncUserSpoilerData() {
        const data = getSpoilerData();
        JE.userConfig.spoilerMode = {
            ...data,
            items: rulesToItems(data.rules)
        };
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
            spoilerData = normalizeSpoilerData(JE.userConfig?.spoilerMode);
            syncUserSpoilerData();
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

        const merged = {
            preset: userPreset,
            watchedThreshold: 'played',
            boundaryRule: 'showOnlyWatched',
            ...presetDefaults,
            ...data.settings
        };

        // Historical payloads store revealDuration in seconds (e.g. 10),
        // while runtime timers expect milliseconds.  The 300 threshold
        // distinguishes seconds from milliseconds: a value <= 300 is
        // treated as seconds (max 5 min reveal), anything above as ms.
        const revealDurationRaw = Number(merged.revealDuration);
        if (!Number.isFinite(revealDurationRaw) || revealDurationRaw <= 0) {
            merged.revealDuration = DEFAULT_REVEAL_DURATION;
        } else if (revealDurationRaw <= 300) {
            merged.revealDuration = revealDurationRaw * 1000;
        } else {
            merged.revealDuration = revealDurationRaw;
        }

        return merged;
    }

    /**
     * Rebuilds the in-memory ID set from the current spoiler rules.
     * Must be called after any mutation to `spoilerData.rules`.
     */
    function rebuildSets() {
        protectedIdSet.clear();
        protectedCollectionIds.clear();
        const data = getSpoilerData();
        const rules = data.rules || {};
        for (const key of Object.keys(rules)) {
            const rule = rules[key];
            if (rule.enabled) {
                protectedIdSet.add(rule.itemId);
                if (rule.itemType === 'BoxSet') {
                    protectedCollectionIds.add(rule.itemId);
                }
            }
        }
        // Prune collectionMemberMap entries for collections no longer protected
        for (const [memberId, collectionSet] of collectionMemberMap) {
            for (const cid of collectionSet) {
                if (!protectedCollectionIds.has(cid)) {
                    collectionSet.delete(cid);
                }
            }
            if (collectionSet.size === 0) {
                collectionMemberMap.delete(memberId);
            }
        }

        // Toggle pre-hide CSS on body and observer state
        if (protectedIdSet.size > 0) {
            document.body?.classList?.add('je-spoiler-active');
            connectObserver();
        } else {
            document.body?.classList?.remove('je-spoiler-active');
            disconnectObserver();
            clearAllRedactions();
        }
    }

    /**
     * Persists the spoiler mode data to the server after a debounce.
     * Refuses to save if the current user differs from the user who loaded
     * the data, preventing cross-user contamination on user switches.
     */
    function debouncedSave() {
        if (saveTimeout) clearTimeout(saveTimeout);
        saveTimeout = setTimeout(function () {
            saveTimeout = null;
            const currentUserId = typeof ApiClient !== 'undefined' && ApiClient.getCurrentUserId
                ? ApiClient.getCurrentUserId()
                : null;
            if (spoilerDataOwnerId && currentUserId && spoilerDataOwnerId !== currentUserId) {
                console.warn('🪼 Jellyfin Enhanced: Spoiler save skipped — user changed from', spoilerDataOwnerId, 'to', currentUserId);
                return;
            }
            const data = getSpoilerData();
            JE.saveUserSettings('spoiler-mode.json', toServerSpoilerData(data));
        }, SAVE_DEBOUNCE_MS);
    }

    /**
     * Dispatches a `je-spoiler-mode-changed` CustomEvent on `window`.
     */
    function emitChange() {
        try {
            window.dispatchEvent(new CustomEvent('je-spoiler-mode-changed'));
        } catch (err) {
            console.warn('🪼 Jellyfin Enhanced: Failed to emit spoiler-mode-changed event', err);
        }
    }

    /**
     * Checks whether an item (series or movie) has spoiler mode enabled.
     * @param {string} itemId The Jellyfin item ID.
     * @returns {boolean}
     */
    function isProtected(itemId) {
        if (!itemId) return false;
        if (getSettings().enabled === false) return false;
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
        syncUserSpoilerData();
        rebuildSets();
        debouncedSave();
        emitChange();

        // Invalidate caches for this item
        boundaryCache.delete(itemId);
        movieWatchedCache.delete(itemId);
        seasonWatchedCache.delete(itemId);
        collectionItemsCache.delete(itemId);

        // Remove stale reverse lookups for this collection's members
        for (const [memberId, collectionSet] of collectionMemberMap) {
            collectionSet.delete(itemId);
            if (collectionSet.size === 0) {
                collectionMemberMap.delete(memberId);
            }
        }
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
        syncUserSpoilerData();
        debouncedSave();
        emitChange();
    }

    /**
     * Updates the autoEnableOnFirstPlay top-level flag (immutable pattern).
     * @param {boolean} enabled Whether auto-enable on first play is active.
     */
    function setAutoEnableOnFirstPlay(enabled) {
        const data = getSpoilerData();
        spoilerData = {
            ...data,
            autoEnableOnFirstPlay: !!enabled,
            settings: { ...data.settings, autoEnableOnFirstPlay: !!enabled }
        };
        syncUserSpoilerData();
        debouncedSave();
        emitChange();
    }

    /**
     * Replaces the tagAutoEnable list (immutable pattern).
     * @param {string[]} tags Array of tag strings.
     */
    function setTagAutoEnable(tags) {
        const data = getSpoilerData();
        const cleaned = Array.isArray(tags) ? tags.filter(Boolean) : [];
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
                    if (epSeason === null || epSeason === undefined || epSeason === 0) continue;

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

    // ============================================================
    // Movie & collection watch-state helpers
    // ============================================================

    /**
     * Checks whether a movie has been watched by the current user.
     * Results are cached with the same TTL as boundary data.
     * In-flight requests are de-duplicated.
     * @param {string} movieId The movie Jellyfin ID.
     * @returns {Promise<boolean>} True if watched.
     */
    async function isMovieWatched(movieId) {
        if (!movieId) return false;

        // Check cache
        const cached = movieWatchedCache.get(movieId);
        if (cached && (Date.now() - cached.ts) < BOUNDARY_CACHE_TTL) {
            return cached.watched;
        }

        // De-duplicate in-flight requests
        if (movieWatchedRequestMap.has(movieId)) {
            return movieWatchedRequestMap.get(movieId);
        }

        const request = (async function () {
            try {
                if (!isValidId(movieId)) return false;

                const userId = ApiClient.getCurrentUserId();
                const item = await ApiClient.ajax({
                    type: 'GET',
                    url: ApiClient.getUrl('/Users/' + userId + '/Items/' + movieId, {
                        Fields: 'UserData'
                    }),
                    dataType: 'json'
                });

                const watched = item?.UserData?.Played === true;
                evictIfNeeded(movieWatchedCache, MAX_CACHE_SIZE);
                movieWatchedCache.set(movieId, { watched, ts: Date.now() });
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

    /**
     * Checks whether every episode in a season is watched by current threshold settings.
     * Results are cached with the same TTL as boundary data.
     * In-flight requests are de-duplicated.
     * @param {string} seasonId The season Jellyfin ID.
     * @returns {Promise<boolean>} True if all episodes are watched.
     */
    async function isSeasonFullyWatched(seasonId) {
        if (!seasonId) return false;

        // Check cache
        const cached = seasonWatchedCache.get(seasonId);
        if (cached && (Date.now() - cached.ts) < BOUNDARY_CACHE_TTL) {
            return cached.watched;
        }

        // De-duplicate in-flight requests
        if (seasonWatchedRequestMap.has(seasonId)) {
            return seasonWatchedRequestMap.get(seasonId);
        }

        const request = (async function () {
            try {
                if (!isValidId(seasonId)) return false;

                const userId = ApiClient.getCurrentUserId();
                const response = await ApiClient.ajax({
                    type: 'GET',
                    url: ApiClient.getUrl('/Users/' + userId + '/Items', {
                        ParentId: seasonId,
                        IncludeItemTypes: 'Episode',
                        Recursive: true,
                        Fields: 'UserData'
                    }),
                    dataType: 'json'
                });

                const episodes = (response?.Items || []).filter(function (item) {
                    return item?.Type === 'Episode';
                });

                if (episodes.length === 0) {
                    evictIfNeeded(seasonWatchedCache, MAX_CACHE_SIZE);
                    seasonWatchedCache.set(seasonId, { watched: false, ts: Date.now() });
                    return false;
                }

                const watched = episodes.every(function (episode) {
                    return !shouldRedactEpisode(episode);
                });

                evictIfNeeded(seasonWatchedCache, MAX_CACHE_SIZE);
                seasonWatchedCache.set(seasonId, { watched, ts: Date.now() });
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

    /**
     * Fetches the items within a collection (BoxSet) and caches the result.
     * Also populates the reverse collectionMemberMap for O(1) lookups.
     * @param {string} collectionId The BoxSet Jellyfin ID.
     * @returns {Promise<Set<string>>} Set of item IDs in the collection.
     */
    async function fetchCollectionItems(collectionId) {
        if (!collectionId) return new Set();

        // Check cache
        const cached = collectionItemsCache.get(collectionId);
        if (cached && (Date.now() - cached.ts) < BOUNDARY_CACHE_TTL) {
            return cached.items;
        }

        // De-duplicate in-flight requests
        if (collectionItemsRequestMap.has(collectionId)) {
            return collectionItemsRequestMap.get(collectionId);
        }

        const request = (async function () {
            try {
                if (!isValidId(collectionId)) return new Set();

                const userId = ApiClient.getCurrentUserId();
                const response = await ApiClient.ajax({
                    type: 'GET',
                    url: ApiClient.getUrl('/Users/' + userId + '/Items', {
                        ParentId: collectionId
                    }),
                    dataType: 'json'
                });

                const items = response?.Items || [];
                const itemIds = new Set(items.map(function (it) { return it.Id; }));

                // Cache the collection contents
                evictIfNeeded(collectionItemsCache, MAX_CACHE_SIZE);
                collectionItemsCache.set(collectionId, { items: itemIds, ts: Date.now() });

                // Build reverse map entries
                for (const id of itemIds) {
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

    /**
     * Checks if a movie belongs to any protected collection (BoxSet).
     * Uses the reverse collectionMemberMap for fast lookups, falling back
     * to fetching collection contents for any not-yet-cached collections.
     * @param {string} movieId The movie Jellyfin ID.
     * @returns {Promise<string|null>} The first matching protected collection ID, or null.
     */
    async function getProtectedCollectionForMovie(movieId) {
        if (!movieId || protectedCollectionIds.size === 0) return null;

        // Fast path: check reverse map
        const knownCollections = collectionMemberMap.get(movieId);
        if (knownCollections) {
            for (const cid of knownCollections) {
                if (protectedCollectionIds.has(cid)) return cid;
            }
        }

        // Slow path: fetch each protected collection's items (if not cached yet)
        for (const collectionId of protectedCollectionIds) {
            const items = await fetchCollectionItems(collectionId);
            if (items.has(movieId)) return collectionId;
        }

        return null;
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
body.je-spoiler-active .card[data-type="Episode"]:not([${SCANNED_ATTR}]) .cardText,
body.je-spoiler-active .card[data-type="Episode"]:not([${SCANNED_ATTR}]) .textActionButton,
body.je-spoiler-active .listItem[data-id]:not([${SCANNED_ATTR}]) .listItemBodyText:not(.secondary),
body.je-spoiler-active .card[data-type="Episode"]:not([${SCANNED_ATTR}]) .cardText-secondary,
body.je-spoiler-active .listItem[data-id]:not([${SCANNED_ATTR}]) .listItem-overview,
body.je-spoiler-active .listItem[data-id]:not([${SCANNED_ATTR}]) .listItem-bottomoverview,
body.je-spoiler-active .listItem[data-id]:not([${SCANNED_ATTR}]) .listItemBody {
  visibility: hidden;
}

/* ===== Detail page pre-hide: avoid overview flash before async redaction ===== */
body.je-spoiler-active.${DETAIL_OVERVIEW_PENDING_CLASS} #itemDetailPage:not(.hide) .overview,
body.je-spoiler-active.${DETAIL_OVERVIEW_PENDING_CLASS} #itemDetailPage:not(.hide) .itemOverview {
  visibility: hidden;
}
body.je-spoiler-active.${DETAIL_OVERVIEW_PENDING_CLASS} #itemDetailPage:not(.hide) .overview.${OVERVIEW_REVEALED_CLASS},
body.je-spoiler-active.${DETAIL_OVERVIEW_PENDING_CLASS} #itemDetailPage:not(.hide) .itemOverview.${OVERVIEW_REVEALED_CLASS} {
  visibility: visible;
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

.je-spoiler-metadata-hidden {
  visibility: hidden !important;
}
.je-spoiler-revealing .je-spoiler-metadata-hidden {
  visibility: visible !important;
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
}

.je-spoiler-confirm-overlay {
  position: fixed; inset: 0; z-index: 100001;
  background: rgba(0,0,0,0.75); backdrop-filter: blur(6px);
  display: flex; align-items: center; justify-content: center;
}
.je-spoiler-confirm-dialog {
  background: linear-gradient(135deg, rgba(30,30,35,0.98), rgba(20,20,25,0.98));
  border: 1px solid rgba(255,255,255,0.12); border-radius: 12px;
  padding: 24px; max-width: 420px; width: 90%; color: #fff;
}
.je-spoiler-confirm-dialog h3 {
  margin: 0 0 12px 0; font-size: 18px; font-weight: 600;
}
.je-spoiler-confirm-dialog p {
  margin: 0 0 20px 0; font-size: 14px;
  color: rgba(255,255,255,0.7); line-height: 1.5;
}
.je-spoiler-confirm-buttons {
  display: flex; flex-direction: column; gap: 8px;
}
.je-spoiler-confirm-btn {
  border: none; color: #fff; padding: 10px 16px;
  border-radius: 6px; cursor: pointer; font-size: 14px;
  font-weight: 500; transition: background 0.2s ease; text-align: center;
}
.je-spoiler-confirm-reveal {
  background: rgba(255,152,0,0.6); border: 1px solid rgba(255,152,0,0.7);
}
.je-spoiler-confirm-reveal:hover { background: rgba(255,152,0,0.8); }
.je-spoiler-confirm-disable {
  background: rgba(220,50,50,0.5); border: 1px solid rgba(220,50,50,0.6);
}
.je-spoiler-confirm-disable:hover { background: rgba(220,50,50,0.7); }
.je-spoiler-confirm-cancel {
  background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.15);
}
.je-spoiler-confirm-cancel:hover { background: rgba(255,255,255,0.2); }`;

        JE.helpers.addCSS('je-spoiler-mode', css);
    }

    // ============================================================
    // Spoiler confirmation dialog
    // ============================================================

    /**
     * Shows a confirmation dialog when the user clicks an active spoiler toggle.
     * Offers: Reveal Temporarily, Disable Protection, or Cancel.
     * @param {string} itemName Display name of the item.
     * @param {Function} onReveal Called when user chooses temporary reveal.
     * @param {Function} onDisable Called when user chooses to disable protection.
     */
    function showSpoilerConfirmation(itemName, onReveal, onDisable) {
        document.querySelector('.je-spoiler-confirm-overlay')?.remove();

        const overlay = document.createElement('div');
        overlay.className = 'je-spoiler-confirm-overlay';

        const dialog = document.createElement('div');
        dialog.className = 'je-spoiler-confirm-dialog';

        const title = document.createElement('h3');
        title.textContent = tFallback('spoiler_mode_confirm_title', 'Spoiler Protection');
        dialog.appendChild(title);

        const body = document.createElement('p');
        body.textContent = tFallback('spoiler_mode_confirm_body', 'What would you like to do with spoiler protection for "{name}"?').replace('{name}', itemName);
        dialog.appendChild(body);

        const buttons = document.createElement('div');
        buttons.className = 'je-spoiler-confirm-buttons';

        const closeDialog = () => {
            overlay.remove();
            document.removeEventListener('keydown', escHandler);
        };

        const revealBtn = document.createElement('button');
        revealBtn.className = 'je-spoiler-confirm-btn je-spoiler-confirm-reveal';
        revealBtn.textContent = tFallback('spoiler_mode_confirm_reveal', 'Reveal Temporarily');
        revealBtn.addEventListener('click', () => { closeDialog(); onReveal(); });
        buttons.appendChild(revealBtn);

        const disableBtn = document.createElement('button');
        disableBtn.className = 'je-spoiler-confirm-btn je-spoiler-confirm-disable';
        disableBtn.textContent = tFallback('spoiler_mode_confirm_disable', 'Disable Protection');
        disableBtn.addEventListener('click', () => { closeDialog(); onDisable(); });
        buttons.appendChild(disableBtn);

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'je-spoiler-confirm-btn je-spoiler-confirm-cancel';
        cancelBtn.textContent = tFallback('spoiler_mode_confirm_cancel', 'Cancel');
        cancelBtn.addEventListener('click', closeDialog);
        buttons.appendChild(cancelBtn);

        dialog.appendChild(buttons);
        overlay.appendChild(dialog);

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeDialog();
        });

        const escHandler = (e) => {
            if (e.key === 'Escape') closeDialog();
        };
        document.addEventListener('keydown', escHandler);

        document.body.appendChild(overlay);
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
        // Only show for Series, Movies, and BoxSets (collections)
        if (itemType !== 'Series' && itemType !== 'Movie' && itemType !== 'BoxSet') return;

        // Respect the enabled and showButtons user settings
        const settings = getSettings();
        if (settings.enabled === false || settings.showButtons === false) return;

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
                ? tFallback('spoiler_mode_active', 'Spoiler On')
                : tFallback('spoiler_mode_off', 'Spoiler Off');
            content.appendChild(textSpan);
        }

        /**
         * Syncs the toggle button's CSS class, tooltip text, and icon
         * with the current spoiler rule for this item.
         */
        function updateState() {
            const rule = getRule(itemId);
            const active = rule?.enabled === true;

            if (active) {
                button.classList.add('je-spoiler-active');
                button.title = tFallback('spoiler_mode_disable_tooltip', 'Click to disable Spoiler Mode');
                renderContent('shield', true);
            } else {
                button.classList.remove('je-spoiler-active');
                button.title = tFallback('spoiler_mode_enable_tooltip', 'Click to enable Spoiler Mode');
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

            // Enabling is always instant
            if (!isCurrentlyActive) {
                setRule({ itemId, itemName, itemType, enabled: true });
                updateState();
                JE.toast(JE.icon(JE.IconName.SHIELD) + ' ' + tFallback('spoiler_mode_enabled_toast', 'Spoiler Mode enabled'));
                setTimeout(function () { processCurrentPage(); }, TOGGLE_RESCAN_DELAY_MS);
                return;
            }

            // Disabling — show confirmation dialog with reveal option
            const settings = getSettings();
            if (settings.showDisableConfirmation !== false) {
                showSpoilerConfirmation(
                    itemName,
                    // Reveal temporarily
                    function () {
                        activateRevealAll();
                    },
                    // Disable protection
                    function () {
                        setRule({ itemId, itemName, itemType, enabled: false });
                        updateState();
                        JE.toast(JE.icon(JE.IconName.SHIELD) + ' ' + tFallback('spoiler_mode_disabled_toast', 'Spoiler Mode disabled'));
                        setTimeout(function () { processCurrentPage(); }, TOGGLE_RESCAN_DELAY_MS);
                    }
                );
            } else {
                setRule({ itemId, itemName, itemType, enabled: false });
                updateState();
                JE.toast(JE.icon(JE.IconName.SHIELD) + ' ' + tFallback('spoiler_mode_disabled_toast', 'Spoiler Mode disabled'));
                setTimeout(function () { processCurrentPage(); }, TOGGLE_RESCAN_DELAY_MS);
            }
        });

        updateState();

        // Insert before the overflow menu (three-dots) button
        const moreButton = buttonContainer.querySelector('.btnMoreCommands');
        if (moreButton) {
            buttonContainer.insertBefore(button, moreButton);
        } else {
            buttonContainer.appendChild(button);
        }

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
        button.title = tFallback('spoiler_mode_reveal_all_tooltip', 'Reveal all spoilers on this page for 30 seconds');

        const content = document.createElement('div');
        content.className = 'detailButton-content';

        const icon = document.createElement('span');
        icon.className = 'material-icons detailButton-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = 'visibility';
        content.appendChild(icon);

        const textSpan = document.createElement('span');
        textSpan.className = 'detailButton-icon-text';
        textSpan.textContent = tFallback('spoiler_mode_reveal_all', 'Reveal (30s)');
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

        // Reveal hidden metadata (runtime, rating, etc.)
        document.querySelectorAll('.je-spoiler-metadata-hidden').forEach(function (el) {
            el.classList.remove('je-spoiler-metadata-hidden');
            el.classList.add('je-spoiler-metadata-revealed');
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

        // Restore title text elements to original content
        card.querySelectorAll('.je-spoiler-text-redacted').forEach(function (el) {
            if (el.dataset.jeSpoilerOriginal) {
                el.textContent = el.dataset.jeSpoilerOriginal;
                el.classList.remove('je-spoiler-text-redacted');
            }
        });

        // Reveal metadata elements (runtime, rating, etc.) — DOM is intact
        card.querySelectorAll('.je-spoiler-metadata-hidden').forEach(function (el) {
            el.classList.remove('je-spoiler-metadata-hidden');
            el.classList.add('je-spoiler-metadata-revealed');
        });
    }

    /**
     * Re-hides all spoiler content for a card after reveal.
     * @param {HTMLElement} card The top-level card or listItem element.
     */
    function hideCard(card) {
        const cardBox = card.querySelector('.cardBox') || card;
        cardBox.classList.remove('je-spoiler-revealing');

        // Re-redact title text elements
        card.querySelectorAll('[data-je-spoiler-redacted]').forEach(function (el) {
            el.textContent = el.dataset.jeSpoilerRedacted;
            el.classList.add('je-spoiler-text-redacted');
        });

        // Re-hide metadata elements
        card.querySelectorAll('.je-spoiler-metadata-revealed').forEach(function (el) {
            el.classList.remove('je-spoiler-metadata-revealed');
            el.classList.add('je-spoiler-metadata-hidden');
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

        /** Shows the card's original content (no-op during reveal-all). */
        function doReveal() {
            if (revealAllActive || revealed) return;
            revealed = true;
            revealCard(card);
        }

        /** Re-hides the card's content after the user stops interacting. */
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
            badge.textContent = tFallback('spoiler_mode_hidden_badge', 'SPOILER');
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
            if (titleEl.classList.contains('je-spoiler-metadata-hidden')) continue;

            // If the card has both primary + secondary text (e.g. home page),
            // the first text is the series name — keep it visible.
            if (hasSecondaryText && titleEl.classList.contains('cardText-first')) continue;

            if (isFirstRedactable) {
                // First redactable text gets the formatted title (textContent is safe here).
                // dataset.jeSpoilerRedacted is the JS camelCase API for the same HTML
                // attribute referenced by REDACTED_ATTR ('data-je-spoiler-redacted').
                // Here it stores the replacement text so reveal/hide can toggle.
                if (!titleEl.dataset.jeSpoilerOriginal) {
                    titleEl.dataset.jeSpoilerOriginal = titleEl.textContent;
                }
                titleEl.dataset.jeSpoilerRedacted = redactedTitle;
                titleEl.textContent = redactedTitle;
                titleEl.classList.add('je-spoiler-text-redacted', 'je-spoiler-revealable');
                isFirstRedactable = false;
            } else {
                // Non-title elements (metadata with runtime/rating/star icons):
                // use CSS visibility to preserve child DOM structure
                titleEl.classList.add('je-spoiler-metadata-hidden');
            }
        }

        // Bind hover/touch reveal handlers to the whole card
        bindCardReveal(card);

        card.setAttribute(REDACTED_ATTR, '1');
    }

    /**
     * Blurs a card poster without redacting the title text.
     * Used for both season cards and movie cards.
     * @param {HTMLElement} card The card element (season or movie).
     */
    function blurCardArtwork(card) {
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
            badge.textContent = tFallback('spoiler_mode_hidden_badge', 'SPOILER');
            imageContainer.appendChild(badge);
        }

        card.setAttribute(REDACTED_ATTR, '1');
    }

    /**
     * Blurs artwork AND redacts title text on a chapter card.
     * @param {HTMLElement} card The chapter card element.
     * @param {number} chapterIndex 1-based chapter number for the replacement text.
     */
    function redactChapterCard(card, chapterIndex) {
        if (card.hasAttribute(REDACTED_ATTR)) return;

        blurCardArtwork(card);

        const titleEl = card.querySelector('.cardText');
        if (titleEl && !titleEl.dataset.jeSpoilerOriginal) {
            const original = titleEl.textContent;
            if (original && original.trim()) {
                titleEl.dataset.jeSpoilerOriginal = original;
                titleEl.dataset.jeSpoilerRedacted = '1';
                titleEl.textContent = 'Chapter ' + chapterIndex;
                titleEl.classList.add('je-spoiler-text-redacted');
            }
        }

        bindCardReveal(card);
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

        // Restore metadata elements (DOM was never modified, just hidden via CSS)
        card.querySelectorAll('.je-spoiler-metadata-hidden, .je-spoiler-metadata-revealed').forEach(function (el) {
            el.classList.remove('je-spoiler-metadata-hidden', 'je-spoiler-metadata-revealed');
        });

        card.removeAttribute(REDACTED_ATTR);
    }

    /**
     * Clears all spoiler redaction artifacts from the current DOM.
     * Used when spoiler mode has no protected items remaining.
     */
    function clearAllRedactions() {
        revealAllActive = false;
        setDetailOverviewPending(false);
        if (revealAllTimer) {
            clearTimeout(revealAllTimer);
            revealAllTimer = null;
        }
        if (revealAllCountdownInterval) {
            clearInterval(revealAllCountdownInterval);
            revealAllCountdownInterval = null;
        }
        document.querySelector('.je-spoiler-reveal-banner')?.remove();

        document.querySelectorAll('.je-spoiler-revealing').forEach(function (el) {
            el.classList.remove('je-spoiler-revealing');
        });

        document.querySelectorAll('[' + REDACTED_ATTR + ']').forEach(function (card) {
            unredactCard(card);
        });

        document.querySelectorAll('[' + PROCESSED_ATTR + '], [' + SCANNED_ATTR + ']').forEach(function (el) {
            el.removeAttribute(PROCESSED_ATTR);
            el.removeAttribute(SCANNED_ATTR);
        });

        document.querySelectorAll('.je-spoiler-overview-hidden, .' + OVERVIEW_REVEALED_CLASS + ', [data-je-spoiler-overview-safe-for]').forEach(function (el) {
            if (el.dataset.jeSpoilerOriginal) {
                el.textContent = el.dataset.jeSpoilerOriginal;
                delete el.dataset.jeSpoilerOriginal;
            }
            delete el.dataset.jeSpoilerRevealUntil;
            delete el.dataset.jeSpoilerOverviewSafeFor;
            delete el.dataset.jeSpoilerOverviewBound;
            el.classList.remove(OVERVIEW_REVEALED_CLASS);
            el.classList.remove('je-spoiler-overview-hidden');
        });

        document.querySelectorAll('.je-spoiler-osd-redacted').forEach(function (el) {
            if (el.dataset.jeSpoilerOriginal) {
                el.textContent = el.dataset.jeSpoilerOriginal;
                delete el.dataset.jeSpoilerOriginal;
            }
            el.classList.remove('je-spoiler-osd-redacted');
        });

        document.querySelectorAll('.backdropImage, .detailImageContainer img').forEach(function (el) {
            if ((el.style?.filter || '').indexOf('blur(' + BLUR_RADIUS + ')') !== -1) {
                el.style.filter = '';
                el.style.transition = '';
            }
        });

        // Catch-all: remove blur/generic classes from any remaining elements
        document.querySelectorAll('.je-spoiler-blur, .je-spoiler-generic').forEach(function (el) {
            el.classList.remove('je-spoiler-blur', 'je-spoiler-generic', 'je-spoiler-revealing');
        });

        // Remove any remaining badges
        document.querySelectorAll('.je-spoiler-badge').forEach(function (b) { b.remove(); });

        // Remove spoiler toggle buttons and reveal buttons from detail pages
        document.querySelectorAll('.je-spoiler-toggle-btn, .je-spoiler-reveal-all-btn').forEach(function (b) { b.remove(); });
    }

    // ============================================================
    // Card filtering (MutationObserver-based)
    // ============================================================

    /**
     * Fetches episode data from the API and redacts if needed (special episodes).
     * @param {HTMLElement} card The card element.
     * @param {string} itemId The item ID.
     * @param {number} seasonNum The season number.
     * @param {number} epNum The episode number.
     */
    async function processSpecialEpisode(card, itemId, seasonNum, epNum) {
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
        } catch {
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
            if (itemSeason === 0 || itemSeason === null || itemSeason === undefined) {
                if (shouldRedactEpisode(item)) {
                    redactCard(card, item);
                }
            } else {
                const bp = await isEpisodePastBoundary(seriesId, itemSeason, item.IndexNumber || 0);
                if (bp) {
                    redactCard(card, item);
                }
            }
        } catch (err) {
            console.warn('🪼 Jellyfin Enhanced: Failed to fetch episode data for spoiler check', err);
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

            if (!seasonSeriesId || !isProtected(seasonSeriesId) || seasonNum === null || seasonNum === undefined) return;

            const boundary = await computeBoundary(seasonSeriesId);
            // Blur seasons beyond the boundary season, or all if nothing watched
            if ((boundary && seasonNum > boundary.season) || !boundary) {
                blurCardArtwork(card);
            }
        } catch {
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
        let failed = false;
        try {
            if (card.hasAttribute('data-imagetype')) return; // Skip image editor cards
            if (card.classList.contains('chapterCard')) return; // Handled by redactDetailPageChapters

            const itemId = getCardItemId(card);
            if (!itemId) return;

            const cardType = (card.dataset.type || '').toLowerCase();
            const surface = getCardSurface(card) || getCurrentSurface();

            if (!shouldProtectSurface(surface)) return;

            // For a series card on the home page, don't redact the series card itself
            if (isProtected(itemId) && cardType === 'series') {
                return;
            }

            // Movie card: directly protected or belongs to a protected collection
            if (cardType === 'movie') {
                const directlyProtected = isProtected(itemId);
                const collectionId = !directlyProtected ? await getProtectedCollectionForMovie(itemId) : null;

                if (directlyProtected || collectionId) {
                    const watched = await isMovieWatched(itemId);
                    if (!watched) {
                        blurCardArtwork(card);
                        bindCardReveal(card);
                    }
                }
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
                        await processSpecialEpisode(card, itemId, seasonNum, epNum);
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
        } catch (err) {
            // API failure: clear processed flag so filterNewCards retries this card
            failed = true;
            card.removeAttribute(PROCESSED_ATTR);
            console.warn('🪼 Jellyfin Enhanced: Error processing card for spoiler check, will retry', err);
        } finally {
            // Mark card as fully scanned — removes the pre-hide CSS blur
            // Skip on failure so filterNewCards can retry
            if (!failed) {
                card.setAttribute(SCANNED_ATTR, '1');
            }
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
        if (getSettings().enabled === false) { clearAllRedactions(); return; }
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
        if (getSettings().enabled === false || protectedIdSet.size === 0) {
            clearAllRedactions();
            return;
        }

        // Reset processed and scanned flags so all cards get re-checked
        document.querySelectorAll('[' + PROCESSED_ATTR + '], [' + SCANNED_ATTR + ']').forEach(function (el) {
            el.removeAttribute(PROCESSED_ATTR);
            el.removeAttribute(SCANNED_ATTR);
        });

        // Reset detail page state so handleDetailPageMutation re-processes
        // (needed for chapter redaction on episode/movie detail pages)
        lastDetailPageItemId = null;

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
        let detailItem = null;
        const userId = ApiClient.getCurrentUserId();

        try {
            detailItem = await ApiClient.getItem(userId, itemId);
            if (detailItem?.Type === 'Season') {
                seriesId = detailItem.SeriesId || itemId;
            } else if (detailItem?.Type !== 'Series') {
                return;
            }
        } catch {
            return;
        }

        if (!isProtected(seriesId)) return;

        const settings = getSettings();
        const isSeasonDetail = detailItem?.Type === 'Season';
        let shouldHideOverview = !settings.showSeriesOverview;
        const overviewEl = visiblePage.querySelector('.overview, .itemOverview');

        // If this is a season detail page and that season is fully watched,
        // there is no spoiler risk in the overview text.
        if (shouldHideOverview && isSeasonDetail) {
            const fullyWatchedSeason = await isSeasonFullyWatched(itemId);
            if (fullyWatchedSeason) {
                shouldHideOverview = false;
                if (overviewEl) {
                    overviewEl.dataset.jeSpoilerOverviewSafeFor = itemId;
                }
                setDetailOverviewPending(false);
            }
        }

        // Redact the series/movie overview if configured (using textContent)
        const hiddenText = tFallback('spoiler_mode_hidden_overview', 'Overview hidden \u2014 click to reveal');
        const restoreOverview = function () {
            if (!overviewEl) return;
            if (overviewEl.dataset.jeSpoilerOriginal) {
                overviewEl.textContent = overviewEl.dataset.jeSpoilerOriginal;
                delete overviewEl.dataset.jeSpoilerOriginal;
            }
            delete overviewEl.dataset.jeSpoilerRevealUntil;
            overviewEl.classList.remove(OVERVIEW_REVEALED_CLASS);
            overviewEl.classList.remove('je-spoiler-overview-hidden');
        };

        if (overviewEl && !overviewEl.dataset.jeSpoilerOverviewBound) {
            overviewEl.dataset.jeSpoilerOverviewBound = '1';
            overviewEl.addEventListener('click', function () {
                if (!overviewEl.classList.contains('je-spoiler-overview-hidden')) return;
                if (!overviewEl.dataset.jeSpoilerOriginal) return;

                const revealDuration = getSettings().revealDuration || DEFAULT_REVEAL_DURATION;
                overviewEl.dataset.jeSpoilerRevealUntil = String(Date.now() + revealDuration);
                overviewEl.textContent = overviewEl.dataset.jeSpoilerOriginal;
                overviewEl.classList.add(OVERVIEW_REVEALED_CLASS);
                overviewEl.classList.remove('je-spoiler-overview-hidden');

                // Auto-hide after reveal duration unless extended by another click.
                setTimeout(function () {
                    const revealUntil = Number(overviewEl.dataset.jeSpoilerRevealUntil || '0');
                    if (revealAllActive || Date.now() < revealUntil) return;
                    overviewEl.textContent = hiddenText;
                    overviewEl.classList.remove(OVERVIEW_REVEALED_CLASS);
                    overviewEl.classList.add('je-spoiler-overview-hidden');
                }, revealDuration);
            });
        }

        if (shouldHideOverview) {
            if (overviewEl) {
                const revealUntil = Number(overviewEl.dataset.jeSpoilerRevealUntil || '0');
                const stillRevealed = revealUntil > Date.now();

                // Keep user reveal state during ongoing detail-page mutations.
                if (stillRevealed) {
                    if (overviewEl.dataset.jeSpoilerOriginal) {
                        overviewEl.textContent = overviewEl.dataset.jeSpoilerOriginal;
                    }
                    overviewEl.classList.add(OVERVIEW_REVEALED_CLASS);
                    overviewEl.classList.remove('je-spoiler-overview-hidden');
                } else if (!overviewEl.classList.contains('je-spoiler-overview-hidden')) {
                    delete overviewEl.dataset.jeSpoilerOverviewSafeFor;
                    overviewEl.dataset.jeSpoilerOriginal = overviewEl.textContent;
                    overviewEl.textContent = hiddenText;
                    overviewEl.classList.remove(OVERVIEW_REVEALED_CLASS);
                    overviewEl.classList.add('je-spoiler-overview-hidden');
                }
            }
        } else if (overviewEl && overviewEl.classList.contains('je-spoiler-overview-hidden')) {
            restoreOverview();
            if (isSeasonDetail) {
                overviewEl.dataset.jeSpoilerOverviewSafeFor = itemId;
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
            if (card.hasAttribute(SCANNED_ATTR)) continue;
            card.setAttribute(PROCESSED_ATTR, '1');
            promises.push(processCard(card));
        }
        await Promise.all(promises);

        // Redact chapter cards if present (episodes can have Scenes sections too)
        await redactDetailPageChapters(itemId, visiblePage);

        // On season-focused views with no redacted episode cards, keep overview visible.
        if (shouldHideOverview && overviewEl && episodeCards.length > 0) {
            const hasRedactedCards = Array.from(episodeCards).some(function (card) {
                return card.hasAttribute(REDACTED_ATTR);
            });
            if (!hasRedactedCards) {
                restoreOverview();
                if (isSeasonDetail) {
                    overviewEl.dataset.jeSpoilerOverviewSafeFor = itemId;
                }
                setDetailOverviewPending(false);
            } else {
                delete overviewEl.dataset.jeSpoilerOverviewSafeFor;
            }
        }
    }

    // ============================================================
    // Detail page chapter redaction
    // ============================================================

    /**
     * Redacts chapter cards on a detail page, skipping chapters the user has
     * already watched (based on PlaybackPositionTicks).
     * @param {string} itemId The movie or episode Jellyfin ID.
     * @param {HTMLElement} visiblePage The visible detail page element.
     */
    async function redactDetailPageChapters(itemId, visiblePage) {
        if (revealAllActive) return;

        const chapterCards = visiblePage.querySelectorAll('.chapterCard[data-positionticks]');
        if (chapterCards.length === 0) return;

        let playbackPositionTicks = 0;
        try {
            if (!isValidId(itemId)) return;

            const userId = ApiClient.getCurrentUserId();
            const item = await ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl('/Users/' + userId + '/Items/' + itemId, {
                    Fields: 'UserData'
                }),
                dataType: 'json'
            });

            playbackPositionTicks = item?.UserData?.PlaybackPositionTicks || 0;
        } catch {
            // If we can't fetch position, redact all chapters to be safe
            playbackPositionTicks = 0;
        }

        let chapterIndex = 0;
        for (const card of chapterCards) {
            chapterIndex++;
            const positionTicks = parseInt(card.dataset.positionticks, 10);
            if (!isNaN(positionTicks) && positionTicks <= playbackPositionTicks) continue;
            redactChapterCard(card, chapterIndex);
        }
    }

    // ============================================================
    // Collection & movie detail page redaction
    // ============================================================

    /**
     * Hides overview text and binds a click-to-reveal handler that auto-hides
     * after the configured reveal duration. Used on collection and movie
     * detail pages where the simpler (non-re-entrant) reveal pattern suffices.
     * @param {HTMLElement} visiblePage The visible detail page element.
     */
    function hideOverviewWithReveal(visiblePage) {
        const overviewEl = visiblePage.querySelector('.overview, .itemOverview');
        if (!overviewEl || overviewEl.classList.contains('je-spoiler-overview-hidden')) return;

        const settings = getSettings();
        overviewEl.dataset.jeSpoilerOriginal = overviewEl.textContent;
        const hiddenText = tFallback('spoiler_mode_hidden_overview', 'Overview hidden \u2014 click to reveal');
        overviewEl.textContent = hiddenText;
        overviewEl.classList.add('je-spoiler-overview-hidden');
        overviewEl.addEventListener('click', function () {
            if (overviewEl.classList.contains('je-spoiler-overview-hidden')) {
                overviewEl.textContent = overviewEl.dataset.jeSpoilerOriginal;
                overviewEl.classList.remove('je-spoiler-overview-hidden');
                setTimeout(function () {
                    if (!revealAllActive) {
                        overviewEl.textContent = hiddenText;
                        overviewEl.classList.add('je-spoiler-overview-hidden');
                    }
                }, settings.revealDuration || DEFAULT_REVEAL_DURATION);
            }
        });
    }

    /**
     * Redacts unwatched movie cards on a BoxSet (collection) detail page.
     * @param {string} collectionId The BoxSet Jellyfin ID.
     * @param {HTMLElement} visiblePage The visible detail page element.
     */
    async function redactCollectionPage(collectionId, visiblePage) {
        if (revealAllActive) return;
        if (!isProtected(collectionId)) return;

        // Fetch collection items to populate cache
        await fetchCollectionItems(collectionId);

        // Hide overview if configured
        if (!getSettings().showSeriesOverview) {
            hideOverviewWithReveal(visiblePage);
        }

        // Process all movie cards on the collection page
        const movieCards = visiblePage.querySelectorAll('.card[data-id], .listItem[data-id]');
        const promises = [];
        for (const card of movieCards) {
            card.setAttribute(PROCESSED_ATTR, '1');
            const movieId = getCardItemId(card);
            if (!movieId) continue;

            promises.push((async function () {
                const watched = await isMovieWatched(movieId);
                if (!watched) {
                    blurCardArtwork(card);
                    bindCardReveal(card);
                }
                card.setAttribute(SCANNED_ATTR, '1');
            })());
        }
        await Promise.all(promises);
    }

    /**
     * Redacts a directly-protected movie's detail page when unwatched.
     * Hides overview and optionally blurs backdrop.
     * @param {string} movieId The movie Jellyfin ID.
     * @param {HTMLElement} visiblePage The visible detail page element.
     */
    async function redactMovieDetailPage(movieId, visiblePage) {
        if (revealAllActive) return;
        if (!isProtected(movieId)) return;

        const watched = await isMovieWatched(movieId);
        if (watched) return;

        // Hide overview
        if (!getSettings().showSeriesOverview) {
            hideOverviewWithReveal(visiblePage);
        }

        // Blur backdrop if strict mode
        const settings = getSettings();
        if (settings.artworkPolicy === 'generic' || settings.hideGuestStars) {
            const backdropEl = visiblePage.querySelector('.backdropImage, .detailImageContainer img');
            if (backdropEl) {
                backdropEl.style.filter = 'blur(' + BLUR_RADIUS + ')';
                backdropEl.style.transition = 'filter 0.3s ease';
            }
        }

        // Redact chapter cards (Scenes section), skipping already-watched chapters
        await redactDetailPageChapters(movieId, visiblePage);
    }

    // ============================================================
    // Search result redaction
    // ============================================================

    /**
     * Redacts episode results in search that belong to protected series.
     */
    function redactSearchResults() {
        const settings = getSettings();
        if (settings.enabled === false) return;
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
        if (settings.enabled === false) return;
        if (!settings.protectOverlay) return;

        const seriesId = await getParentSeriesId(itemId);
        let itemIsProtected = false;
        if (seriesId && isProtected(seriesId)) {
            itemIsProtected = true;
        } else if (isProtected(itemId) || await getProtectedCollectionForMovie(itemId)) {
            itemIsProtected = true;
        }
        if (!itemIsProtected) return;

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

            if (!item) return;

            const isMovie = item.Type === 'Movie';

            // For episodes, check boundary; for movies, check watched state
            if (isMovie) {
                if (item.UserData?.Played) return;
            } else {
                if (!shouldRedactEpisode(item)) return;
            }

            // Redact OSD title using textContent
            if (!isMovie) {
                const redactedTitle = formatRedactedTitle(
                    item.ParentIndexNumber,
                    item.IndexNumber,
                    item.IndexNumberEnd,
                    item.ParentIndexNumber === 0
                );

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
            }

            // Redact chapter names, skipping already-watched chapters
            const playbackTicks = item.UserData?.PlaybackPositionTicks || 0;
            const chapterElements = document.querySelectorAll('.chapterCard .chapterCardText, [data-chapter-name]');
            let chapterIndex = 1;
            for (const chapterEl of chapterElements) {
                const parentCard = chapterEl.closest('.chapterCard');
                const chapterTicks = parentCard ? parseInt(parentCard.dataset.positionticks, 10) : NaN;

                // Skip chapters the user has already watched past
                if (!isNaN(chapterTicks) && chapterTicks <= playbackTicks) {
                    chapterIndex++;
                    continue;
                }

                if (!chapterEl.classList.contains('je-spoiler-osd-redacted')) {
                    chapterEl.dataset.jeSpoilerOriginal = chapterEl.textContent;
                    chapterEl.textContent = 'Chapter ' + chapterIndex;
                    chapterEl.classList.add('je-spoiler-osd-redacted');
                }
                chapterIndex++;
            }

            // Blur chapter thumbnail previews (position-aware)
            const chapterCards = document.querySelectorAll('.chapterCard');
            for (const card of chapterCards) {
                const chapterTicks = parseInt(card.dataset.positionticks, 10);
                if (!isNaN(chapterTicks) && chapterTicks <= playbackTicks) continue;

                const imgs = card.querySelectorAll('img, .chapterCardImage');
                for (const img of imgs) {
                    img.style.filter = 'blur(' + BLUR_RADIUS + ')';
                    img.style.transition = 'filter 0.3s ease';
                }
            }

        } catch (err) {
            console.warn('🪼 Jellyfin Enhanced: Error redacting player overlay', err);
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
        if (settings.enabled === false) return events;
        if (!settings.protectCalendar) return events;
        if (!Array.isArray(events) || protectedIdSet.size === 0) return events;

        /**
         * Checks all GUID format variants (hyphenated, compact, lowercase)
         * because calendar payloads may use a different casing than the
         * protectedIdSet stores.
         * @param {string} itemId Calendar item Jellyfin ID.
         * @returns {boolean}
         */
        function isProtectedCalendarItem(itemId) {
            if (!itemId) return false;
            const raw = String(itemId);
            const compact = raw.replace(/-/g, '');
            const lower = raw.toLowerCase();
            const compactLower = compact.toLowerCase();
            return isProtected(raw) || isProtected(compact) || isProtected(lower) || isProtected(compactLower);
        }

        return events.map(function (event) {
            const releaseType = event.releaseType || event.ReleaseType;
            if (releaseType !== 'Episode') return event;

            // Calendar payload uses Jellyfin itemId/itemEpisodeId; seriesId is Sonarr's numeric ID.
            const protectedItemId = event.itemId || event.ItemId;
            if (!protectedItemId || !isProtectedCalendarItem(protectedItemId)) return event;

            const seasonNum = event.seasonNumber || event.ParentIndexNumber || 0;
            const epNum = event.episodeNumber || event.IndexNumber || 0;
            const redactedTitle = formatShortRedactedTitle(seasonNum, epNum);
            const seriesName = event.seriesName || event.SeriesName || event.title || event.Title || '';

            return {
                ...event,
                title: seriesName,
                subtitle: redactedTitle,
                episodeTitle: '',
                EpisodeTitle: '',
                overview: '',
                Overview: ''
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
                const isFirstEpisode = item.ParentIndexNumber === 1 && item.IndexNumber === 1;

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
                } catch {
                    // Ignore — tag check is best-effort
                }
            }
        } catch (err) {
            console.warn('🪼 Jellyfin Enhanced: Error in auto-enable on first play', err);
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

    /**
     * Handles OSD mutations by redacting player overlay when on the player surface.
     * Shared between debounced and non-debounced code paths.
     */
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
        if (getSettings().enabled === false) return;
        if (detailPageProcessing) return;

        const visiblePage = document.querySelector('#itemDetailPage:not(.hide)');
        if (!visiblePage) {
            setDetailOverviewPending(false);
            return;
        }

        try {
            const hashParams = new URLSearchParams(window.location.hash.split('?')[1]);
            const itemId = hashParams.get('id');
            if (!itemId || !isValidId(itemId)) {
                setDetailOverviewPending(false);
                return;
            }

            // Skip if we already processed this item
            if (itemId === lastDetailPageItemId && visiblePage.querySelector('.je-spoiler-toggle-btn')) {
                setDetailOverviewPending(false);
                return;
            }

            lastDetailPageItemId = itemId;
            detailPageProcessing = true;
            const completeDetailPageProcessing = function () {
                detailPageProcessing = false;
                setDetailOverviewPending(false);
            };

            const userId = ApiClient.getCurrentUserId();
            ApiClient.getItem(userId, itemId).then(function (item) {
                if (!item) {
                    completeDetailPageProcessing();
                    return;
                }

                // Only pre-hide after we know the item type.
                // Skip season pages to avoid overview flicker on fully watched seasons.
                const prehideOverview = shouldPrehideDetailOverview() &&
                    !shouldSkipDetailOverviewPrehide(visiblePage) &&
                    item.Type !== 'Season';
                setDetailOverviewPending(prehideOverview);

                // Add spoiler toggle for Series, Movies, and BoxSets
                if (item.Type === 'Series' || item.Type === 'Movie' || item.Type === 'BoxSet') {
                    addSpoilerToggleButton(itemId, item.Type, visiblePage);
                    checkAndAutoEnableByTag(itemId, item);
                }

                // Redact detail page content based on item type
                if (item.Type === 'Series' || item.Type === 'Season') {
                    redactEpisodeList(itemId, visiblePage).then(function () {
                        completeDetailPageProcessing();
                    }).catch(function () {
                        completeDetailPageProcessing();
                    });
                } else if (item.Type === 'BoxSet') {
                    redactCollectionPage(itemId, visiblePage).then(function () {
                        completeDetailPageProcessing();
                    }).catch(function () {
                        completeDetailPageProcessing();
                    });
                } else if (item.Type === 'Movie' && isProtected(itemId)) {
                    redactMovieDetailPage(itemId, visiblePage).then(function () {
                        completeDetailPageProcessing();
                    }).catch(function () {
                        completeDetailPageProcessing();
                    });
                } else if (item.Type === 'Episode') {
                    // Episode detail pages can have chapter cards (Scenes section)
                    const epSeriesId = item.SeriesId || null;
                    if (epSeriesId && isProtected(epSeriesId)) {
                        redactDetailPageChapters(itemId, visiblePage).then(function () {
                            completeDetailPageProcessing();
                        }).catch(function () {
                            completeDetailPageProcessing();
                        });
                    } else {
                        completeDetailPageProcessing();
                    }
                } else {
                    completeDetailPageProcessing();
                }
            }).catch(function () { completeDetailPageProcessing(); });
        } catch (err) {
            detailPageProcessing = false;
            setDetailOverviewPending(false);
            console.warn('🪼 Jellyfin Enhanced: Error in spoiler detail page observer', err);
        }
    }

    /**
     * Unified MutationObserver callback handling card filtering, detail page,
     * and player OSD — all in a single observer.
     * @param {MutationRecord[]} mutations The mutation records.
     */
    function handleMutations(mutations) {
        if (getSettings().enabled === false || protectedIdSet.size === 0) return;

        // Manual indexed loops with early break for performance (avoid iterating all mutations)
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

                // Cancel pending timers from the previous page to prevent
                // stale callbacks firing after rapid navigation.
                navigationTimers.forEach(clearTimeout);
                navigationTimers = [];

                const surface = getCurrentSurface();

                if (surface === 'details') {
                    const visiblePage = document.querySelector('#itemDetailPage:not(.hide)');
                    const pending = shouldPrehideDetailOverview() && !shouldSkipDetailOverviewPrehide(visiblePage);
                    setDetailOverviewPending(pending);
                    // Always process detail pages so users can enable spoiler mode
                    // even when no items are currently protected.
                    // Two-delay strategy: the first fires after async DOM settles for
                    // quick renders, the second catches slower lazy-loaded sections.
                    navigationTimers.push(setTimeout(function () { handleDetailPageMutation(); }, DETAIL_RESCAN_DELAY_MS));
                    navigationTimers.push(setTimeout(function () { handleDetailPageMutation(); }, DETAIL_FINAL_RESCAN_DELAY_MS));
                    navigationTimers.push(setTimeout(function () {
                        if (protectedIdSet.size > 0) filterNewCards();
                    }, DETAIL_RESCAN_DELAY_MS));
                } else if (surface === 'search') {
                    setDetailOverviewPending(false);
                    navigationTimers.push(setTimeout(function () { redactSearchResults(); }, DETAIL_RESCAN_DELAY_MS));
                    navigationTimers.push(setTimeout(function () { redactSearchResults(); }, DETAIL_FINAL_RESCAN_DELAY_MS));
                } else if (surface === 'home') {
                    setDetailOverviewPending(false);
                    navigationTimers.push(setTimeout(function () { filterNewCards(); }, DETAIL_RESCAN_DELAY_MS));
                    navigationTimers.push(setTimeout(function () { filterNewCards(); }, DETAIL_FINAL_RESCAN_DELAY_MS));
                } else if (surface === 'player') {
                    setDetailOverviewPending(false);
                    navigationTimers.push(setTimeout(function () {
                        const playerItemId = getPlayerItemId();
                        if (playerItemId) {
                            redactPlayerOverlay(playerItemId);
                            handleAutoEnableOnFirstPlay(playerItemId);
                        }
                    }, PLAYER_OSD_DELAY_MS));
                }
                if (surface !== 'details' && surface !== 'search' && surface !== 'home' && surface !== 'player') {
                    setDetailOverviewPending(false);
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
        spoilerDataOwnerId = typeof ApiClient !== 'undefined' && ApiClient.getCurrentUserId
            ? ApiClient.getCurrentUserId()
            : null;
        spoilerData = normalizeSpoilerData(JE.userConfig?.spoilerMode);
        syncUserSpoilerData();
        rebuildSets();

        // Activate pre-hide CSS immediately so cards are blurred before they render
        if (protectedIdSet.size > 0) {
            document.body.classList.add('je-spoiler-active');
        } else {
            document.body.classList.remove('je-spoiler-active');
        }

        injectCSS();
        setupObservers();

        // Re-process page when settings change (e.g. user toggles enabled off)
        window.addEventListener('je-spoiler-mode-changed', function () {
            processCurrentPage();
        });

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
            setTagAutoEnable,
            computeBoundary,
            isEpisodePastBoundary,
            shouldRedactEpisode,
            isMovieWatched,
            fetchCollectionItems,
            getProtectedCollectionForMovie,
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
