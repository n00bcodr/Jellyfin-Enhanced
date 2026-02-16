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
    const BLUR_RADIUS = '15px';

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

    /** Data attribute marking a card as already processed by spoiler mode. */
    const PROCESSED_ATTR = 'data-je-spoiler-checked';

    /** Data attribute marking a card as spoiler-redacted. */
    const REDACTED_ATTR = 'data-je-spoiler-redacted';

    /** Selector for any spoiler-processable card/list-item. */
    const CARD_SEL = '.card[data-id], .card[data-itemid], .listItem[data-id]';

    /** Selector for not-yet-scanned cards. */
    const CARD_SEL_NEW = '.card[data-id]:not([data-je-spoiler-checked]), .card[data-itemid]:not([data-je-spoiler-checked]), .listItem[data-id]:not([data-je-spoiler-checked])';

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

    // ============================================================
    // State
    // ============================================================

    /** The in-memory spoiler mode data object. */
    let spoilerData = null;

    /** Save debounce timer. */
    let saveTimeout = null;

    /**
     * Cache for spoiler boundary data per series.
     * Map<seriesId, { boundary: { season, episode }, episodes: Array, ts: number }>
     */
    const boundaryCache = new Map();

    /**
     * In-flight boundary requests to prevent duplicate fetches.
     * Map<seriesId, Promise>
     */
    const boundaryRequestMap = new Map();

    /**
     * Set of series/movie IDs that have spoiler mode enabled.
     * Used for fast lookups during card filtering.
     */
    const protectedIdSet = new Set();

    /**
     * Map of parent series ID lookups for episode/season cards.
     * Map<itemId, seriesId|null>
     */
    const parentSeriesCache = new Map();

    /** In-flight parent series requests. Map<itemId, Promise> */
    const parentSeriesRequestMap = new Map();

    /** Tracks which fields are currently revealed (tap-to-reveal). */
    const revealedFields = new Map();

    /** Whether "Reveal All" is currently active. */
    let revealAllActive = false;

    /** Timer for "Reveal All" auto-hide. */
    let revealAllTimer = null;

    /**
     * WeakMap caching surface context for DOM sections.
     * @type {WeakMap<HTMLElement, string|null>}
     */
    const sectionSurfaceCache = new WeakMap();

    // ============================================================
    // Internal helpers
    // ============================================================

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
        const presetDefaults = PRESETS[userPreset] || PRESETS.balanced;

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
    }

    /**
     * Persists the spoiler mode data to the server after a debounce.
     */
    function debouncedSave() {
        if (saveTimeout) clearTimeout(saveTimeout);
        saveTimeout = setTimeout(() => {
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
            console.warn('🪼 Jellyfin Enhanced: Failed to emit spoiler-mode-changed event', e);
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
     * Updates global spoiler mode settings.
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

    // ============================================================
    // Boundary computation
    // ============================================================

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

        const request = (async () => {
            try {
                const userId = ApiClient.getCurrentUserId();
                const settings = getSettings();
                const threshold = settings.watchedThreshold;

                // Fetch all episodes for the series with UserData
                const response = await ApiClient.ajax({
                    type: 'GET',
                    url: ApiClient.getUrl(`/Shows/${seriesId}/Episodes`, {
                        UserId: userId,
                        Fields: 'UserData',
                        IsSpecialSeason: false,
                        SortBy: 'SortName',
                        SortOrder: 'Ascending'
                    }),
                    dataType: 'json'
                });

                const episodes = response?.Items || [];
                if (episodes.length === 0) return null;

                // Find the last fully watched episode
                let lastWatched = null;
                for (const ep of episodes) {
                    const userData = ep.UserData;
                    if (!userData) continue;

                    let isWatched = false;
                    if (threshold === 'played') {
                        isWatched = userData.Played === true;
                    } else {
                        // 90% threshold
                        isWatched = userData.Played === true ||
                            (userData.PlayedPercentage && userData.PlayedPercentage >= 90);
                    }

                    if (isWatched) {
                        lastWatched = {
                            season: ep.ParentIndexNumber || 0,
                            episode: ep.IndexNumber || 0,
                            episodeId: ep.Id
                        };
                    }
                }

                // Cache the result
                boundaryCache.set(seriesId, {
                    boundary: lastWatched,
                    episodes,
                    ts: Date.now()
                });

                return lastWatched;
            } catch (e) {
                console.error('🪼 Jellyfin Enhanced: Error computing spoiler boundary for', seriesId, e);
                return null;
            } finally {
                boundaryRequestMap.delete(seriesId);
            }
        })();

        boundaryRequestMap.set(seriesId, request);
        return request;
    }

    /**
     * Checks if an episode is past the spoiler boundary.
     * @param {string} seriesId The series ID.
     * @param {number} seasonNumber The season number.
     * @param {number} episodeNumber The episode number.
     * @returns {Promise<boolean>} True if the episode should be redacted.
     */
    async function isEpisodePastBoundary(seriesId, seasonNumber, episodeNumber) {
        const boundary = await computeBoundary(seriesId);
        if (!boundary) {
            // Nothing watched — everything is past boundary
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
     * @returns {string} Redacted title like "S02E03" or "Special 01".
     */
    function formatRedactedTitle(seasonNumber, episodeNumber, endEpisodeNumber, isSpecial) {
        if (isSpecial || seasonNumber === 0) {
            const num = episodeNumber != null ? String(episodeNumber).padStart(2, '0') : '01';
            return 'Special ' + num;
        }
        const s = seasonNumber != null ? String(seasonNumber).padStart(2, '0') : '00';
        const e = episodeNumber != null ? String(episodeNumber).padStart(2, '0') : '00';

        if (endEpisodeNumber != null && endEpisodeNumber !== episodeNumber) {
            const eEnd = String(endEpisodeNumber).padStart(2, '0');
            return 'S' + s + 'E' + e + '\u2013E' + eEnd;
        }
        return 'S' + s + 'E' + e;
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
     * Results are cached; in-flight requests are de-duplicated.
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
        const request = (async () => {
            try {
                const userId = ApiClient.getCurrentUserId();
                const item = await ApiClient.ajax({
                    type: 'GET',
                    url: ApiClient.getUrl('/Users/' + userId + '/Items/' + itemId, {
                        Fields: 'SeriesId,ParentIndexNumber,IndexNumber,UserData'
                    }),
                    dataType: 'json'
                });
                const seriesId = item?.SeriesId || null;
                parentSeriesCache.set(itemId, seriesId);
                return seriesId;
            } catch (e) {
                console.warn('🪼 Jellyfin Enhanced: Failed to fetch parent series for spoiler check', itemId, e);
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
        JE.helpers.addCSS('je-spoiler-mode', [
            /* Spoiler blur for card images */
            '.je-spoiler-blur .cardImageContainer,',
            '.je-spoiler-blur .cardImage,',
            '.je-spoiler-blur .listItemImage {',
            '  filter: blur(' + BLUR_RADIUS + ') brightness(0.7) !important;',
            '  transition: filter 0.3s ease !important;',
            '}',

            /* Generic tile mode */
            '.je-spoiler-generic .cardImageContainer,',
            '.je-spoiler-generic .cardImage,',
            '.je-spoiler-generic .listItemImage {',
            '  filter: brightness(0.15) !important;',
            '  transition: filter 0.3s ease !important;',
            '}',

            /* Spoiler badge overlay on cards */
            '.je-spoiler-badge {',
            '  position: absolute;',
            '  top: 50%; left: 50%;',
            '  transform: translate(-50%, -50%);',
            '  z-index: 5;',
            '  background: rgba(0,0,0,0.75);',
            '  color: rgba(255,255,255,0.9);',
            '  padding: 4px 10px;',
            '  border-radius: 4px;',
            '  font-size: 11px;',
            '  font-weight: 600;',
            '  letter-spacing: 0.5px;',
            '  text-transform: uppercase;',
            '  pointer-events: none;',
            '  white-space: nowrap;',
            '}',

            /* Redacted text styling */
            '.je-spoiler-text-redacted {',
            '  color: rgba(255,255,255,0.5) !important;',
            '  font-style: italic !important;',
            '}',

            /* Hidden overview */
            '.je-spoiler-overview-hidden {',
            '  color: rgba(255,255,255,0.3) !important;',
            '  font-style: italic !important;',
            '  cursor: pointer;',
            '}',

            /* Reveal animation */
            '.je-spoiler-revealing .cardImageContainer,',
            '.je-spoiler-revealing .cardImage,',
            '.je-spoiler-revealing .listItemImage {',
            '  filter: none !important;',
            '  transition: filter 0.5s ease !important;',
            '}',
            '.je-spoiler-revealing .je-spoiler-badge { display: none !important; }',

            /* Spoiler toggle button on detail page */
            '.je-spoiler-toggle-btn { transition: background 0.2s ease, opacity 0.2s ease; }',
            '.je-spoiler-toggle-btn.je-spoiler-active { opacity: 1; }',
            '.je-spoiler-toggle-btn.je-spoiler-active .detailButton-icon { color: #ff9800; }',

            /* Reveal all banner */
            '.je-spoiler-reveal-banner {',
            '  position: fixed; top: 0; left: 0; right: 0; z-index: 99998;',
            '  background: linear-gradient(135deg, rgba(255,152,0,0.9), rgba(255,87,34,0.9));',
            '  color: #fff; padding: 8px 16px; text-align: center;',
            '  font-size: 13px; font-weight: 600;',
            '  display: flex; align-items: center; justify-content: center; gap: 12px;',
            '  backdrop-filter: blur(10px); box-shadow: 0 2px 10px rgba(0,0,0,0.3);',
            '}',
            '.je-spoiler-reveal-banner button {',
            '  background: rgba(255,255,255,0.2); border: 1px solid rgba(255,255,255,0.3);',
            '  color: #fff; padding: 4px 12px; border-radius: 4px;',
            '  cursor: pointer; font-size: 12px; font-weight: 600;',
            '}',
            '.je-spoiler-reveal-banner button:hover { background: rgba(255,255,255,0.3); }',

            /* Tap-to-reveal cursor */
            '.je-spoiler-revealable { cursor: pointer; }',

            /* Lock icon for seasons */
            '.je-spoiler-lock-icon {',
            '  display: inline-flex; align-items: center;',
            '  margin-left: 6px; opacity: 0.6; font-size: 14px;',
            '}',

            /* OSD spoiler redaction */
            '.je-spoiler-osd-redacted {',
            '  color: rgba(255,255,255,0.5) !important;',
            '  font-style: italic !important;',
            '}'
        ].join('\n'));
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

        const selectors = [
            '.detailButtons',
            '.itemActionsBottom',
            '.mainDetailButtons',
            '.detailButtonsContainer'
        ];
        let buttonContainer = null;
        for (const sel of selectors) {
            const found = visiblePage.querySelector(sel);
            if (found) {
                buttonContainer = found;
                break;
            }
        }
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

        button.addEventListener('click', async (e) => {
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
            JE.toast(JE.icon(JE.IconName?.SHIELD || 'shield') + ' ' + statusText);

            // Trigger re-scan of current page
            setTimeout(function () { processCurrentPage(); }, 300);
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

        const selectors = [
            '.detailButtons',
            '.itemActionsBottom',
            '.mainDetailButtons',
            '.detailButtonsContainer'
        ];
        let buttonContainer = null;
        for (const sel of selectors) {
            const found = visiblePage.querySelector(sel);
            if (found) {
                buttonContainer = found;
                break;
            }
        }
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

        // Update countdown
        const countdownInterval = setInterval(function () {
            remaining--;
            if (remaining <= 0) {
                clearInterval(countdownInterval);
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
            clearInterval(countdownInterval);
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

        // Clear timer
        if (revealAllTimer) {
            clearTimeout(revealAllTimer);
            revealAllTimer = null;
        }

        // Remove revealing class
        document.querySelectorAll('.je-spoiler-revealing').forEach(function (el) {
            el.classList.remove('je-spoiler-revealing');
        });

        // Re-scan page to re-apply redaction
        processCurrentPage();
    }

    /**
     * Handles tap-to-reveal on a specific spoiler-redacted element.
     * Reveals the content for the configured duration, then re-hides.
     * @param {HTMLElement} element The element to reveal.
     * @param {string} fieldKey A unique key for tracking reveal state.
     */
    function handleTapReveal(element, fieldKey) {
        if (revealAllActive) return;

        const settings = getSettings();
        const duration = settings.revealDuration || DEFAULT_REVEAL_DURATION;

        // If already revealed, do nothing
        if (revealedFields.has(fieldKey)) return;

        revealedFields.set(fieldKey, true);

        // Reveal the element
        element.classList.add('je-spoiler-revealing');

        // Restore original content if stored
        if (element.dataset.jeSpoilerOriginal) {
            element.textContent = element.dataset.jeSpoilerOriginal;
            element.classList.remove('je-spoiler-text-redacted');
        }

        // Auto-hide after duration
        setTimeout(function () {
            revealedFields.delete(fieldKey);
            element.classList.remove('je-spoiler-revealing');

            // Re-redact if applicable
            if (element.dataset.jeSpoilerRedacted) {
                element.textContent = element.dataset.jeSpoilerRedacted;
                element.classList.add('je-spoiler-text-redacted');
            }
        }, duration);
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
            case 'recentlyadded':
                return settings.protectHome;
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
        const imageContainer = card.querySelector('.cardImageContainer') || card.querySelector('.cardImage');
        if (imageContainer && !imageContainer.querySelector('.je-spoiler-badge')) {
            imageContainer.style.position = 'relative';
            const badge = document.createElement('div');
            badge.className = 'je-spoiler-badge';
            badge.textContent = JE.t('spoiler_mode_hidden_badge') !== 'spoiler_mode_hidden_badge'
                ? JE.t('spoiler_mode_hidden_badge')
                : 'SPOILER';
            imageContainer.appendChild(badge);
        }

        // Redact the card title (using textContent only)
        const titleElements = card.querySelectorAll('.cardText, .listItemBodyText');
        for (const titleEl of titleElements) {
            if (titleEl.classList.contains('je-spoiler-text-redacted')) continue;

            // Store original text for reveal
            if (!titleEl.dataset.jeSpoilerOriginal) {
                titleEl.dataset.jeSpoilerOriginal = titleEl.textContent;
            }

            // Format redacted title
            const redactedTitle = formatRedactedTitle(
                itemData.ParentIndexNumber,
                itemData.IndexNumber,
                itemData.IndexNumberEnd,
                itemData.ParentIndexNumber === 0
            );
            titleEl.dataset.jeSpoilerRedacted = redactedTitle;
            titleEl.textContent = redactedTitle;
            titleEl.classList.add('je-spoiler-text-redacted');

            // Add tap-to-reveal
            const fieldKey = 'title-' + (itemData.Id || getCardItemId(card));
            titleEl.classList.add('je-spoiler-revealable');
            titleEl.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                handleTapReveal(titleEl, fieldKey);
            }, { once: false });

            break; // Only redact the first title
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
     * Processes a single card to determine if it needs spoiler redaction.
     * For episode/season cards, checks if their parent series is protected
     * and whether the episode is past the boundary.
     * @param {HTMLElement} card The card element.
     */
    async function processCard(card) {
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

        // Check if this is an episode or season that belongs to a protected series
        if (cardType === 'episode' || cardType === '') {
            let seriesId = card.dataset.seriesid || null;
            if (!seriesId) {
                seriesId = await getParentSeriesId(itemId);
            }

            if (seriesId && isProtected(seriesId)) {
                const seasonNum = parseInt(card.dataset.parentindexnumber || card.dataset.season || '0', 10);
                const epNum = parseInt(card.dataset.indexnumber || card.dataset.episode || '0', 10);

                if (seasonNum || epNum) {
                    const pastBoundary = await isEpisodePastBoundary(seriesId, seasonNum, epNum);
                    if (pastBoundary) {
                        redactCard(card, {
                            Id: itemId,
                            ParentIndexNumber: seasonNum,
                            IndexNumber: epNum,
                            IndexNumberEnd: null
                        });
                    }
                } else {
                    // Fetch item data to get season/episode numbers
                    try {
                        const userId = ApiClient.getCurrentUserId();
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
                        console.warn('🪼 Jellyfin Enhanced: Failed to fetch episode data for spoiler check', itemId, e);
                    }
                }
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

        // Reset processed flags so all cards get re-checked
        document.querySelectorAll('[' + PROCESSED_ATTR + ']').forEach(function (el) {
            el.removeAttribute(PROCESSED_ATTR);
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

        // Process episode cards on the detail page
        const episodeCards = visiblePage.querySelectorAll('.card[data-id], .listItem[data-id]');
        for (const card of episodeCards) {
            card.setAttribute(PROCESSED_ATTR, '1');
            await processCard(card);
        }
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
            console.warn('🪼 Jellyfin Enhanced: Error redacting player overlay', e);
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
        if (!data.autoEnableOnFirstPlay) return;

        try {
            const userId = ApiClient.getCurrentUserId();
            const item = await ApiClient.ajax({
                type: 'GET',
                url: ApiClient.getUrl('/Users/' + userId + '/Items/' + itemId, {
                    Fields: 'SeriesId,ParentIndexNumber,IndexNumber'
                }),
                dataType: 'json'
            });

            if (!item) return;

            const seriesId = item.SeriesId;
            if (!seriesId) return;

            // Check if this is Episode 1 (first play of a new series)
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

                JE.toast(JE.icon(JE.IconName?.SHIELD || 'shield') + ' Spoiler Mode auto-enabled for ' + seriesName);
            }
        } catch (e) {
            console.warn('🪼 Jellyfin Enhanced: Error in auto-enable on first play', e);
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
    // Observer setup
    // ============================================================

    /** Debounced card filter function. */
    const debouncedFilter = JE.helpers?.debounce
        ? JE.helpers.debounce(function () { requestAnimationFrame(filterNewCards); }, FILTER_DEBOUNCE_MS)
        : filterNewCards;

    /**
     * Sets up MutationObservers and page-navigation hooks to trigger
     * spoiler redaction when new cards appear in the DOM.
     */
    function setupObservers() {
        // Page navigation hook
        if (JE.helpers?.onViewPage) {
            JE.helpers.onViewPage(function () {
                const surface = getCurrentSurface();

                if (surface === 'details') {
                    // Detail pages load episodes asynchronously — staggered re-scans
                    var rescan = function () {
                        if (protectedIdSet.size > 0) {
                            filterAllCards();
                        }
                    };
                    setTimeout(rescan, DETAIL_RESCAN_DELAY_MS);
                    setTimeout(rescan, DETAIL_FINAL_RESCAN_DELAY_MS);
                } else if (surface === 'player') {
                    // Redact player overlay
                    var hash = window.location.hash || '';
                    var params = new URLSearchParams(hash.split('?')[1]);
                    var itemId = params.get('id');
                    if (itemId) {
                        setTimeout(function () { redactPlayerOverlay(itemId); }, 500);
                        handleAutoEnableOnFirstPlay(itemId);
                    }
                }
            });
        }

        // MutationObserver for new cards
        if (typeof MutationObserver !== 'undefined') {
            var cardObserver = new MutationObserver(function (mutations) {
                if (protectedIdSet.size === 0) return;

                var hasNewCards = false;
                for (var i = 0; i < mutations.length; i++) {
                    var addedNodes = mutations[i].addedNodes;
                    for (var j = 0; j < addedNodes.length; j++) {
                        var node = addedNodes[j];
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
            });
            cardObserver.observe(document.body, { childList: true, subtree: true });
        }

        // Listen for detail page changes to add spoiler toggle button
        if (JE.helpers?.createObserver) {
            JE.helpers.createObserver(
                'spoiler-detail-page',
                JE.helpers.debounce(function () {
                    var visiblePage = document.querySelector('#itemDetailPage:not(.hide)');
                    if (!visiblePage) return;

                    try {
                        var hashParams = new URLSearchParams(window.location.hash.split('?')[1]);
                        var itemId = hashParams.get('id');
                        if (!itemId) return;

                        var userId = ApiClient.getCurrentUserId();
                        ApiClient.getItem(userId, itemId).then(function (item) {
                            if (!item) return;

                            // Add spoiler toggle for Series and Movies
                            if (item.Type === 'Series' || item.Type === 'Movie') {
                                addSpoilerToggleButton(itemId, item.Type, visiblePage);
                                checkAndAutoEnableByTag(itemId, item);
                            }

                            // Redact episode list if on a protected series/season page
                            if (item.Type === 'Series' || item.Type === 'Season') {
                                redactEpisodeList(itemId, visiblePage);
                            }
                        }).catch(function () {});
                    } catch (e) {
                        console.warn('🪼 Jellyfin Enhanced: Error in spoiler detail page observer', e);
                    }
                }, 200),
                document.body,
                {
                    childList: true,
                    subtree: true,
                    attributes: true,
                    attributeFilter: ['class', 'style']
                }
            );
        }

        // Listen for player OSD changes
        if (typeof MutationObserver !== 'undefined') {
            var osdCallback = JE.helpers?.debounce
                ? JE.helpers.debounce(function () {
                    if (getCurrentSurface() !== 'player') return;
                    if (protectedIdSet.size === 0) return;
                    var hash = window.location.hash || '';
                    var params = new URLSearchParams(hash.split('?')[1]);
                    var itemId = params.get('id');
                    if (itemId) {
                        redactPlayerOverlay(itemId);
                    }
                }, 200)
                : function () {};

            var osdObserver = new MutationObserver(osdCallback);
            osdObserver.observe(document.body, { childList: true, subtree: true });
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
            computeBoundary,
            isEpisodePastBoundary,
            shouldRedactEpisode,
            formatRedactedTitle,
            formatShortRedactedTitle,
            filterCalendarEvents,
            activateRevealAll,
            deactivateRevealAll,
            handleTapReveal,
            processCurrentPage,
            redactSearchResults,
            redactPlayerOverlay,
            handleAutoEnableOnFirstPlay,
            checkAndAutoEnableByTag,
            getSpoilerData,
            rebuildSets
        };

        console.log('🪼 Jellyfin Enhanced: Spoiler Mode initialized (' + protectedIdSet.size + ' protected items)');
    };

})(window.JellyfinEnhanced);
