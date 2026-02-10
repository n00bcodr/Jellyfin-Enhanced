/**
 * @file Hidden Content — per-user content hiding for Jellyfin Enhanced.
 *
 * Allows users to hide specific movies, series, episodes, and seasons from all
 * rendering surfaces (library, discovery, search, calendar, etc.).  Hidden state
 * is stored server-side per-user via `hidden-content.json`.
 *
 * Supports scoped hides (Next Up / Continue Watching only), parent-series
 * cascading, TMDB-based cross-surface filtering, and an inline undo toast.
 */
(function (JE) {
    'use strict';

    // ============================================================
    // State
    // ============================================================

    const hiddenIdSet = new Set();
    const hiddenTmdbIdSet = new Set();
    const parentSeriesCache = new Map();
    const parentSeriesRequestMap = new Map();
    const sectionSurfaceCache = new WeakMap();
    let hiddenData = null;
    let saveTimeout = null;

    /** Debounce interval for persisting hidden-content data. */
    const SAVE_DEBOUNCE_MS = 500;
    /** How long the undo toast stays visible. */
    const UNDO_TOAST_DURATION = 8000;
    /** How long the "don't ask again" suppression lasts (15 minutes). */
    const SUPPRESS_DURATION_MS = 15 * 60 * 1000;
    /** Max poster width when loading images from TMDB / Jellyfin. */
    const POSTER_MAX_WIDTH = 300;
    /** Delay for first detail-page rescan (async episode loading). */
    const DETAIL_RESCAN_DELAY_MS = 500;
    /** Delay for final detail-page rescan. */
    const DETAIL_FINAL_RESCAN_DELAY_MS = 1200;
    /** Debounce interval for the MutationObserver card filter. */
    const NATIVE_FILTER_DEBOUNCE_MS = 50;
    /** Initial filter delay after module initialization. */
    const INIT_FILTER_DELAY_MS = 150;

    /** Data attribute marking a card as already scanned. */
    const PROCESSED_ATTR = 'data-je-hidden-checked';
    /** Data attribute storing the parent series ID that caused hiding. */
    const HIDDEN_PARENT_ATTR = 'data-je-hidden-parent-series-id';
    /** Data attribute marking a directly-hidden card. */
    const HIDDEN_DIRECT_ATTR = 'data-je-hidden-direct';
    /** Selector for any hideable card/list-item. */
    const CARD_SEL = '.card[data-id], .card[data-itemid], .listItem[data-id]';
    /** Selector for not-yet-scanned cards only. */
    const CARD_SEL_NEW = '.card[data-id]:not([data-je-hidden-checked]), .card[data-itemid]:not([data-je-hidden-checked]), .listItem[data-id]:not([data-je-hidden-checked])';

    /** LocalStorage key for "don't ask again" suppression timestamp. */
    const SUPPRESS_STORAGE_KEY = 'je_hide_confirm_suppressed_until';

    // ============================================================
    // Internal helpers
    // ============================================================

    /**
     * Returns the in-memory hidden-content data object, lazily initialised
     * from `JE.userConfig.hiddenContent`.
     * @returns {{ items: Object, settings: Object }}
     */
    function getHiddenData() {
        if (!hiddenData) {
            hiddenData = JE.userConfig?.hiddenContent || { items: {}, settings: {} };
        }
        return hiddenData;
    }

    /**
     * Returns the merged settings object (defaults + user overrides).
     * @returns {Object} Merged settings with boolean flags for every filter surface.
     */
    function getSettings() {
        const data = getHiddenData();
        return {
            enabled: true,
            filterLibrary: true,
            filterDiscovery: true,
            filterUpcoming: true,
            filterCalendar: true,
            filterSearch: false,
            filterRecommendations: true,
            filterRequests: true,
            filterNextUp: true,
            filterContinueWatching: true,
            showHideConfirmation: true,
            showHideButtons: true,
            showButtonJellyseerr: true,
            showButtonLibrary: false,
            showButtonDetails: true,
            experimentalHideCollections: false,
            ...data.settings
        };
    }

    /**
     * Rebuilds the in-memory ID Sets from the current hidden-data items map.
     * Must be called after any mutation to `hiddenData.items`.
     */
    function rebuildSets() {
        hiddenIdSet.clear();
        hiddenTmdbIdSet.clear();
        const data = getHiddenData();
        const items = data.items || {};
        for (const key of Object.keys(items)) {
            const item = items[key];
            const scope = item.hideScope || 'global';
            if (scope !== 'global') continue;
            if (item.itemId) hiddenIdSet.add(item.itemId);
            if (item.tmdbId) hiddenTmdbIdSet.add(String(item.tmdbId));
        }
    }

    /**
     * Persists the hidden-content data to the server after a debounce.
     * Coalesces rapid writes (e.g. bulk-unhide) into a single save.
     */
    function debouncedSave() {
        if (saveTimeout) clearTimeout(saveTimeout);
        saveTimeout = setTimeout(() => {
            saveTimeout = null;
            const data = getHiddenData();
            JE.saveUserSettings('hidden-content.json', data);
        }, SAVE_DEBOUNCE_MS);
    }

    /**
     * Checks whether filtering is enabled for a given surface.
     * @param {string} surface One of 'library', 'details', 'discovery', 'search',
     *   'upcoming', 'calendar', 'recommendations', 'requests', 'nextup',
     *   'continuewatching'.
     * @returns {boolean} `true` if hidden items should be filtered on this surface.
     */
    function shouldFilterSurface(surface) {
        const settings = getSettings();
        if (!settings.enabled) return false;
        switch (surface) {
            case 'details': return settings.filterLibrary;
            case 'library': return settings.filterLibrary;
            case 'discovery': return settings.filterDiscovery;
            case 'search': return settings.filterSearch;
            case 'upcoming': return settings.filterUpcoming;
            case 'calendar': return settings.filterCalendar;
            case 'recommendations': return settings.filterRecommendations;
            case 'requests': return settings.filterRequests;
            case 'nextup': return settings.filterNextUp;
            case 'continuewatching': return settings.filterContinueWatching;
            default: return true;
        }
    }

    /**
     * Fetches the parent series ID for an episode/season item from the API.
     * Results are cached in `parentSeriesCache`; in-flight requests are
     * de-duplicated via `parentSeriesRequestMap`.
     * @param {string} itemId Jellyfin item ID (episode or season).
     * @returns {Promise<string|null>} The series ID, or `null` if unavailable.
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
                    url: ApiClient.getUrl(`/Users/${userId}/Items/${itemId}`, { Fields: 'SeriesId' }),
                    dataType: 'json'
                });
                const seriesId = item?.SeriesId || null;
                parentSeriesCache.set(itemId, seriesId);
                return seriesId;
            } catch (e) {
                console.warn('🪼 Jellyfin Enhanced: Failed to fetch parent series for', itemId, e);
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
     * Injects the CSS rules used by hide buttons, undo toast, management panel,
     * and confirmation dialog.  No-ops if the stylesheet is already present.
     */
    function injectCSS() {
        if (!JE.helpers?.addCSS) return;
        JE.helpers.addCSS('je-hidden-content', `
            .je-hidden { display: none !important; }
            .je-hide-btn {
                --je-danger-rgb: 220, 50, 50;
                position: absolute;
                top: 6px;
                right: 6px;
                z-index: 10;
                width: 28px;
                height: 28px;
                border-radius: 50%;
                background: rgba(0,0,0,0.7);
                border: 1px solid rgba(255,255,255,0.2);
                color: #fff;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                opacity: 0;
                transition: opacity 0.2s ease, background 0.2s ease;
                padding: 0;
                font-size: 16px;
                line-height: 1;
            }
            .je-hide-btn .material-icons {
                font-size: 16px;
            }
            .cardBox:hover .je-hide-btn,
            .je-hide-btn:focus {
                opacity: 1;
            }
            .je-hide-btn:hover {
                background: rgba(var(--je-danger-rgb, 220, 50, 50), 0.85);
                border-color: rgba(255,255,255,0.4);
            }
            .je-hide-btn.je-already-hidden {
                opacity: 0;
                background: rgba(0,0,0,0.7);
                border-color: rgba(255,255,255,0.2);
                cursor: pointer;
                pointer-events: auto;
                font-size: 16px;
                width: 28px;
                border-radius: 50%;
                padding: 0;
                height: 28px;
                line-height: 1;
            }
            .cardBox:hover .je-hide-btn.je-already-hidden {
                opacity: 0.85;
            }
            .je-hide-btn.je-already-hidden:hover {
                background: rgba(0,0,0,0.82);
                border-color: rgba(255,255,255,0.28);
            }
            .je-detail-hide-btn.je-already-hidden {
                opacity: 0.85;
                pointer-events: auto;
                transition: background 0.2s ease, opacity 0.2s ease;
            }
            .je-detail-hide-btn.je-already-hidden:hover {
                opacity: 1;
                background: rgba(255,255,255,0.08);
            }

            .je-undo-toast {
                position: fixed;
                bottom: 20px;
                right: 20px;
                color: #fff;
                padding: 12px 16px;
                border-radius: 8px;
                z-index: 99999;
                font-size: clamp(13px, 2vw, 16px);
                font-weight: 500;
                text-shadow: -1px -1px 10px black;
                box-shadow: 0 4px 20px rgba(0,0,0,0.3);
                display: flex;
                align-items: center;
                gap: 12px;
                transform: translateX(100%);
                transition: transform 0.3s ease-out;
                max-width: 380px;
            }
            .je-undo-toast.je-visible {
                transform: translateX(0);
            }
            .je-undo-toast-text {
                flex: 1;
            }
            .je-undo-btn {
                background: rgba(255,255,255,0.15);
                border: 1px solid rgba(255,255,255,0.25);
                color: #fff;
                padding: 4px 12px;
                border-radius: 4px;
                cursor: pointer;
                font-size: 13px;
                font-weight: 600;
                white-space: nowrap;
                transition: background 0.2s ease, border-color 0.2s ease;
            }
            .je-undo-btn:hover {
                filter: brightness(1.3);
            }

            .je-hidden-management-overlay {
                position: fixed;
                inset: 0;
                z-index: 100000;
                background: rgba(0,0,0,0.85);
                backdrop-filter: blur(10px);
                display: flex;
                flex-direction: column;
                align-items: center;
                padding: 40px 20px;
                overflow-y: auto;
            }
            .je-hidden-management-panel {
                width: 100%;
                max-width: 900px;
                background: linear-gradient(135deg, rgba(30,30,35,0.98), rgba(20,20,25,0.98));
                border-radius: 12px;
                border: 1px solid rgba(255,255,255,0.1);
                overflow: hidden;
            }
            .je-hidden-management-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 20px 24px;
                border-bottom: 1px solid rgba(255,255,255,0.1);
            }
            .je-hidden-management-header h2 {
                margin: 0;
                font-size: 20px;
                font-weight: 600;
                color: #fff;
            }
            .je-hidden-management-close {
                background: rgba(255,255,255,0.1);
                border: 1px solid rgba(255,255,255,0.15);
                color: #fff;
                width: 32px;
                height: 32px;
                border-radius: 50%;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 18px;
                transition: background 0.2s ease;
            }
            .je-hidden-management-close:hover {
                background: rgba(255,80,80,0.4);
            }
            .je-hidden-management-toolbar {
                display: flex;
                align-items: center;
                gap: 12px;
                padding: 16px 24px;
                border-bottom: 1px solid rgba(255,255,255,0.06);
            }
            .je-hidden-management-search {
                flex: 1;
                background: rgba(255,255,255,0.08);
                border: 1px solid rgba(255,255,255,0.12);
                border-radius: 6px;
                color: #fff;
                padding: 8px 12px;
                font-size: 14px;
                outline: none;
            }
            .je-hidden-management-search::placeholder {
                color: rgba(255,255,255,0.4);
            }
            .je-hidden-management-search:focus {
                border-color: rgba(255,255,255,0.3);
            }
            .je-hidden-management-unhide-all {
                background: rgba(220,50,50,0.3);
                border: 1px solid rgba(220,50,50,0.5);
                color: #fff;
                padding: 8px 16px;
                border-radius: 6px;
                cursor: pointer;
                font-size: 13px;
                font-weight: 500;
                white-space: nowrap;
                transition: background 0.2s ease;
            }
            .je-hidden-management-unhide-all:hover {
                background: rgba(220,50,50,0.5);
            }
            .je-hidden-management-grid {
                display: grid;
                grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
                gap: 16px;
                padding: 24px;
            }
            .je-hidden-management-empty {
                text-align: center;
                padding: 60px 24px;
                color: rgba(255,255,255,0.4);
                font-size: 15px;
            }
            .je-hidden-item-card {
                background: rgba(255,255,255,0.05);
                border-radius: 8px;
                overflow: hidden;
                border: 1px solid rgba(255,255,255,0.08);
                transition: border-color 0.2s ease, transform 0.2s ease;
            }
            .je-hidden-item-card:hover {
                border-color: rgba(255,255,255,0.2);
            }
            .je-hidden-item-poster-link {
                display: block;
                cursor: pointer;
                text-decoration: none;
            }
            .je-hidden-item-poster {
                width: 100%;
                aspect-ratio: 2/3;
                object-fit: cover;
                background: rgba(255,255,255,0.05);
                display: block;
                transition: opacity 0.2s ease;
            }
            .je-hidden-item-poster-link:hover .je-hidden-item-poster {
                opacity: 0.8;
            }
            .je-hidden-item-info {
                padding: 10px;
            }
            .je-hidden-item-name {
                font-size: 13px;
                font-weight: 500;
                color: #fff;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                margin-bottom: 4px;
                text-decoration: none;
                display: block;
            }
            .je-hidden-item-name:hover {
                text-decoration: underline;
                color: #fff;
            }
            .je-hidden-item-meta {
                font-size: 11px;
                color: rgba(255,255,255,0.4);
                margin-bottom: 8px;
            }
            .je-hidden-item-unhide {
                width: 100%;
                background: rgba(255,255,255,0.1);
                border: 1px solid rgba(255,255,255,0.15);
                color: #fff;
                padding: 6px;
                border-radius: 4px;
                cursor: pointer;
                font-size: 12px;
                font-weight: 500;
                transition: background 0.2s ease;
            }
            .je-hidden-item-unhide:hover {
                background: rgba(100,200,100,0.3);
                border-color: rgba(100,200,100,0.5);
            }
            .je-hidden-item-removing {
                animation: je-hidden-fadeout 0.3s ease forwards;
            }
            @keyframes je-hidden-fadeout {
                to { opacity: 0; transform: scale(0.9); }
            }

            .je-hide-confirm-overlay {
                position: fixed;
                inset: 0;
                z-index: 100001;
                background: rgba(0,0,0,0.75);
                backdrop-filter: blur(6px);
                display: flex;
                align-items: center;
                justify-content: center;
            }
            .je-hide-confirm-dialog {
                background: linear-gradient(135deg, rgba(30,30,35,0.98), rgba(20,20,25,0.98));
                border: 1px solid rgba(255,255,255,0.12);
                border-radius: 12px;
                padding: 24px;
                max-width: 420px;
                width: 90%;
                color: #fff;
            }
            .je-hide-confirm-dialog h3 {
                margin: 0 0 12px 0;
                font-size: 18px;
                font-weight: 600;
            }
            .je-hide-confirm-dialog p {
                margin: 0 0 16px 0;
                font-size: 14px;
                color: rgba(255,255,255,0.7);
                line-height: 1.5;
            }
            .je-hide-confirm-options {
                display: flex;
                flex-direction: column;
                gap: 8px;
                margin-bottom: 20px;
            }
            .je-hide-confirm-options label {
                display: flex;
                align-items: center;
                gap: 8px;
                font-size: 13px;
                color: rgba(255,255,255,0.6);
                cursor: pointer;
            }
            .je-hide-confirm-options input[type="checkbox"] {
                width: 16px;
                height: 16px;
                accent-color: #e0e0e0;
                cursor: pointer;
            }
            .je-hide-confirm-buttons {
                display: flex;
                justify-content: flex-end;
                gap: 10px;
            }
            .je-hide-confirm-cancel {
                background: rgba(255,255,255,0.1);
                border: 1px solid rgba(255,255,255,0.15);
                color: #fff;
                padding: 8px 20px;
                border-radius: 6px;
                cursor: pointer;
                font-size: 14px;
                font-weight: 500;
                transition: background 0.2s ease;
            }
            .je-hide-confirm-cancel:hover {
                background: rgba(255,255,255,0.2);
            }
            .je-hide-confirm-hide {
                background: rgba(220,50,50,0.6);
                border: 1px solid rgba(220,50,50,0.7);
                color: #fff;
                padding: 8px 20px;
                border-radius: 6px;
                cursor: pointer;
                font-size: 14px;
                font-weight: 600;
                transition: background 0.2s ease;
            }
            .je-hide-confirm-hide:hover {
                background: rgba(220,50,50,0.8);
            }
        `);
    }

    // ============================================================
    // Undo toast
    // ============================================================

    /**
     * Shows a slide-in toast with an "Undo" button after hiding an item.
     * Automatically dismisses after {@link UNDO_TOAST_DURATION}.
     * @param {string} itemName Display name of the hidden item.
     * @param {string} itemId Storage key used to unhide if the user clicks Undo.
     */
    function showUndoToast(itemName, itemId) {
        document.querySelectorAll('.je-undo-toast').forEach(el => el.remove());

        const themeVars = JE.themer?.getThemeVariables() || {};
        const toastBg = themeVars.secondaryBg || 'linear-gradient(135deg, rgba(0,0,0,0.9), rgba(40,40,40,0.9))';
        const toastBorder = `1px solid ${themeVars.primaryAccent || 'rgba(255,255,255,0.1)'}`;
        const blurValue = themeVars.blur || '30px';

        const toast = document.createElement('div');
        toast.className = 'je-undo-toast';
        Object.assign(toast.style, {
            background: toastBg,
            border: toastBorder,
            backdropFilter: `blur(${blurValue})`
        });

        const textSpan = document.createElement('span');
        textSpan.className = 'je-undo-toast-text';
        textSpan.textContent = JE.t('hidden_content_item_hidden', { name: itemName });
        toast.appendChild(textSpan);

        const accentColor = themeVars.primaryAccent || 'rgba(255,255,255,0.15)';

        const undoBtn = document.createElement('button');
        undoBtn.className = 'je-undo-btn';
        Object.assign(undoBtn.style, {
            background: `color-mix(in srgb, ${accentColor} 25%, transparent)`,
            borderColor: accentColor
        });
        undoBtn.textContent = JE.t('hidden_content_undo');
        undoBtn.addEventListener('click', () => {
            unhideItem(itemId);
            toast.classList.remove('je-visible');
            setTimeout(() => toast.remove(), 300);
        });
        toast.appendChild(undoBtn);

        document.body.appendChild(toast);
        requestAnimationFrame(() => toast.classList.add('je-visible'));

        setTimeout(() => {
            if (toast.parentNode) {
                toast.classList.remove('je-visible');
                setTimeout(() => toast.remove(), 300);
            }
        }, UNDO_TOAST_DURATION);
    }

    // ============================================================
    // Hide confirmation dialog
    // ============================================================

    /**
     * Checks whether the hide confirmation dialog is currently suppressed
     * (either permanently via settings or temporarily via the 15-minute timer).
     * @returns {boolean} `true` if the confirmation should be skipped.
     */
    function isConfirmationSuppressed() {
        const settings = getSettings();
        if (settings.showHideConfirmation === false) return true;
        const until = localStorage.getItem(SUPPRESS_STORAGE_KEY);
        if (until && new Date(until) > new Date()) return true;
        return false;
    }

    /**
     * Creates a column-layout button container with full-width buttons for
     * surface-specific (Next Up / Continue Watching) confirmation dialogs.
     * @param {Function} closeDialog Closes the overlay.
     * @param {Function} onConfirm Default confirm callback (hide everywhere).
     * @param {Object} dialogOptions Dialog customisation options.
     * @returns {HTMLElement} The buttons container element.
     */
    function createSurfaceDialogButtons(closeDialog, onConfirm, dialogOptions) {
        const choiceButtons = document.createElement('div');
        choiceButtons.className = 'je-hide-confirm-buttons';
        choiceButtons.style.flexDirection = 'column';
        choiceButtons.style.gap = '8px';

        const hasEpisodeChoice = !!dialogOptions.showEpisodeChoice;

        // Option 1: Hide from this surface only (scoped)
        const scopedBtn = document.createElement('button');
        scopedBtn.className = 'je-hide-confirm-hide';
        scopedBtn.style.width = '100%';
        scopedBtn.textContent = JE.t('hidden_content_confirm_hide_scoped');
        scopedBtn.addEventListener('click', () => {
            closeDialog();
            if (dialogOptions.onChooseScoped) dialogOptions.onChooseScoped();
        });
        choiceButtons.appendChild(scopedBtn);

        // Option 2: Hide this episode everywhere (only if episode choice available)
        if (hasEpisodeChoice) {
            const episodeBtn = document.createElement('button');
            episodeBtn.className = 'je-hide-confirm-hide';
            episodeBtn.style.width = '100%';
            episodeBtn.style.background = 'rgba(160, 80, 60, 0.6)';
            episodeBtn.style.borderColor = 'rgba(160, 80, 60, 0.7)';
            episodeBtn.textContent = JE.t('hidden_content_confirm_hide_episode');
            episodeBtn.addEventListener('click', () => {
                closeDialog();
                onConfirm();
            });
            choiceButtons.appendChild(episodeBtn);
        }

        // Option 3: Hide entire show (only if episode choice available)
        if (hasEpisodeChoice && dialogOptions.onChooseShow) {
            const showBtn = document.createElement('button');
            showBtn.className = 'je-hide-confirm-hide';
            showBtn.style.width = '100%';
            showBtn.style.background = 'rgba(180, 50, 50, 0.6)';
            showBtn.style.borderColor = 'rgba(180, 50, 50, 0.7)';
            showBtn.textContent = JE.t('hidden_content_confirm_hide_show');
            showBtn.addEventListener('click', () => {
                closeDialog();
                dialogOptions.onChooseShow();
            });
            choiceButtons.appendChild(showBtn);
        }

        // If no episode choice, add a "Hide everywhere" option as alternative to scoped
        if (!hasEpisodeChoice) {
            const everywhereBtn = document.createElement('button');
            everywhereBtn.className = 'je-hide-confirm-hide';
            everywhereBtn.style.width = '100%';
            everywhereBtn.style.background = 'rgba(180, 50, 50, 0.6)';
            everywhereBtn.style.borderColor = 'rgba(180, 50, 50, 0.7)';
            everywhereBtn.textContent = JE.t('hidden_content_confirm_hide');
            everywhereBtn.addEventListener('click', () => {
                closeDialog();
                onConfirm();
            });
            choiceButtons.appendChild(everywhereBtn);
        }

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'je-hide-confirm-cancel';
        cancelBtn.style.width = '100%';
        cancelBtn.textContent = JE.t('hidden_content_confirm_cancel');
        cancelBtn.addEventListener('click', closeDialog);
        choiceButtons.appendChild(cancelBtn);

        return choiceButtons;
    }

    /**
     * Creates a column-layout button container for the episode/show choice
     * dialog (not triggered from a scoped surface).
     * @param {Function} closeDialog Closes the overlay.
     * @param {Function} onConfirm Default confirm callback (hide episode everywhere).
     * @param {Object} dialogOptions Dialog customisation options.
     * @returns {HTMLElement} The buttons container element.
     */
    function createEpisodeChoiceButtons(closeDialog, onConfirm, dialogOptions) {
        const choiceButtons = document.createElement('div');
        choiceButtons.className = 'je-hide-confirm-buttons';
        choiceButtons.style.flexDirection = 'column';
        choiceButtons.style.gap = '8px';

        const episodeBtn = document.createElement('button');
        episodeBtn.className = 'je-hide-confirm-hide';
        episodeBtn.style.width = '100%';
        episodeBtn.textContent = JE.t('hidden_content_confirm_hide_episode');
        episodeBtn.addEventListener('click', () => {
            closeDialog();
            onConfirm();
        });
        choiceButtons.appendChild(episodeBtn);

        if (dialogOptions.onChooseShow) {
            const showBtn = document.createElement('button');
            showBtn.className = 'je-hide-confirm-hide';
            showBtn.style.width = '100%';
            showBtn.style.background = 'rgba(180, 80, 50, 0.6)';
            showBtn.style.borderColor = 'rgba(180, 80, 50, 0.7)';
            showBtn.textContent = JE.t('hidden_content_confirm_hide_show');
            showBtn.addEventListener('click', () => {
                closeDialog();
                dialogOptions.onChooseShow();
            });
            choiceButtons.appendChild(showBtn);
        }

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'je-hide-confirm-cancel';
        cancelBtn.style.width = '100%';
        cancelBtn.textContent = JE.t('hidden_content_confirm_cancel');
        cancelBtn.addEventListener('click', closeDialog);
        choiceButtons.appendChild(cancelBtn);

        return choiceButtons;
    }

    /**
     * Creates the standard confirm/cancel button pair with an optional
     * "don't ask again for 15 minutes" checkbox.
     * @param {Function} closeDialog Closes the overlay.
     * @param {Function} onConfirm Called when the user confirms hiding.
     * @returns {HTMLElement} A document fragment containing the options and buttons.
     */
    function createStandardConfirmButtons(closeDialog, onConfirm) {
        const fragment = document.createDocumentFragment();

        const options = document.createElement('div');
        options.className = 'je-hide-confirm-options';

        const suppress15Label = document.createElement('label');
        const suppress15Check = document.createElement('input');
        suppress15Check.type = 'checkbox';
        suppress15Label.appendChild(suppress15Check);
        suppress15Label.appendChild(document.createTextNode(JE.t('hidden_content_confirm_suppress_15m')));
        options.appendChild(suppress15Label);
        fragment.appendChild(options);

        const buttons = document.createElement('div');
        buttons.className = 'je-hide-confirm-buttons';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'je-hide-confirm-cancel';
        cancelBtn.textContent = JE.t('hidden_content_confirm_cancel');
        cancelBtn.addEventListener('click', closeDialog);
        buttons.appendChild(cancelBtn);

        const hideBtn = document.createElement('button');
        hideBtn.className = 'je-hide-confirm-hide';
        hideBtn.textContent = JE.t('hidden_content_confirm_hide');
        hideBtn.addEventListener('click', () => {
            if (suppress15Check.checked) {
                const until = new Date(Date.now() + SUPPRESS_DURATION_MS).toISOString();
                localStorage.setItem(SUPPRESS_STORAGE_KEY, until);
            }
            closeDialog();
            onConfirm();
        });
        buttons.appendChild(hideBtn);
        fragment.appendChild(buttons);

        return fragment;
    }

    /**
     * Shows the hide confirmation dialog.  The dialog variant depends on the
     * options: surface-scoped, episode-choice, or standard.
     * @param {string} itemName Display name of the item.
     * @param {Function} onConfirm Called when user confirms hiding (episode-level or default).
     * @param {Object} [dialogOptions] Options to customize the dialog.
     * @param {string} [dialogOptions.surface] 'nextup', 'continuewatching', or 'homesections' for scoped wording.
     * @param {boolean} [dialogOptions.showEpisodeChoice] If true, shows "Hide episode" vs "Hide show" choice.
     * @param {Function} [dialogOptions.onChooseShow] Called if user picks "Hide entire show".
     * @param {Function} [dialogOptions.onChooseScoped] Called if user picks "Hide from [surface] only".
     */
    function showHideConfirmation(itemName, onConfirm, dialogOptions = {}) {
        document.querySelector('.je-hide-confirm-overlay')?.remove();

        const overlay = document.createElement('div');
        overlay.className = 'je-hide-confirm-overlay';

        const dialog = document.createElement('div');
        dialog.className = 'je-hide-confirm-dialog';

        const title = document.createElement('h3');
        const body = document.createElement('p');

        const hasSurface = dialogOptions.surface === 'nextup' || dialogOptions.surface === 'continuewatching' || dialogOptions.surface === 'homesections';
        const hasEpisodeChoice = !!dialogOptions.showEpisodeChoice;

        if (hasSurface) {
            title.textContent = JE.t('hidden_content_confirm_surface_title');
            body.textContent = JE.t('hidden_content_confirm_surface_body');
        } else if (hasEpisodeChoice) {
            title.textContent = JE.t('hidden_content_episode_choice_title');
            body.textContent = JE.t('hidden_content_episode_choice_body');
        } else {
            title.textContent = JE.t('hidden_content_confirm_title', { name: itemName });
            body.textContent = JE.t('hidden_content_confirm_body');
        }
        dialog.appendChild(title);
        dialog.appendChild(body);

        const closeDialog = () => {
            overlay.remove();
            document.removeEventListener('keydown', escHandler);
        };

        if (hasSurface) {
            dialog.appendChild(createSurfaceDialogButtons(closeDialog, onConfirm, dialogOptions));
        } else if (hasEpisodeChoice) {
            dialog.appendChild(createEpisodeChoiceButtons(closeDialog, onConfirm, dialogOptions));
        } else {
            dialog.appendChild(createStandardConfirmButtons(closeDialog, onConfirm));
        }

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

    /**
     * Shows confirmation dialog (or skips if suppressed) then hides the item.
     * Episode-choice and surface-scoped dialogs always show (never suppressed).
     * @param {Object} itemData Data for the item to hide.
     * @param {Function} onHidden Callback after hiding.
     * @param {Object} [dialogOptions] Options passed to showHideConfirmation.
     */
    function confirmAndHide(itemData, onHidden, dialogOptions = {}) {
        if (!dialogOptions.showEpisodeChoice && !dialogOptions.surface && isConfirmationSuppressed()) {
            hideItem(itemData);
            if (onHidden) onHidden();
            return;
        }
        showHideConfirmation(itemData.name || 'Item', () => {
            hideItem(itemData);
            if (onHidden) onHidden();
        }, dialogOptions);
    }

    // ============================================================
    // Management panel (overlay)
    // ============================================================

    /**
     * Creates the header bar for the management panel overlay.
     * @param {number} count Current number of hidden items.
     * @returns {HTMLElement} The header element with title and close button.
     */
    function createManagementHeader(count) {
        const header = document.createElement('div');
        header.className = 'je-hidden-management-header';
        const h2 = document.createElement('h2');
        h2.textContent = `${JE.t('hidden_content_manage_title')} (${count})`;
        header.appendChild(h2);
        const closeBtn = document.createElement('button');
        closeBtn.className = 'je-hidden-management-close';
        closeBtn.textContent = '\u00D7';
        header.appendChild(closeBtn);
        return header;
    }

    /**
     * Creates a card element for a single hidden item in the management panel.
     * Includes poster, name link, type/date metadata, and an Unhide button.
     * @param {Object} item Hidden item data object.
     * @param {Function} [onNavigate] Callback when the user clicks to navigate (closes the panel).
     * @returns {HTMLElement} The card element.
     */
    function createItemCard(item, onNavigate) {
        const card = document.createElement('div');
        card.className = 'je-hidden-item-card';
        card.dataset.itemId = item.itemId;

        const hasJellyfinId = !!item.itemId;
        const hasTmdbId = !!item.tmdbId;
        const mediaType = item.type === 'Series' ? 'tv' : 'movie';

        // Clickable poster area that navigates to item detail
        const posterLink = document.createElement('a');
        posterLink.className = 'je-hidden-item-poster-link';
        if (hasJellyfinId) {
            posterLink.href = `#/details?id=${item.itemId}`;
        } else if (hasTmdbId) {
            posterLink.href = '#';
            posterLink.dataset.tmdbId = item.tmdbId;
            posterLink.dataset.mediaType = mediaType;
        }

        if (item.posterPath) {
            const img = document.createElement('img');
            img.className = 'je-hidden-item-poster';
            img.src = `https://image.tmdb.org/t/p/w${POSTER_MAX_WIDTH}${item.posterPath}`;
            img.alt = '';
            img.loading = 'lazy';
            posterLink.appendChild(img);
        } else if (hasJellyfinId) {
            const img = document.createElement('img');
            img.className = 'je-hidden-item-poster';
            img.src = `${ApiClient.getUrl('/Items/' + item.itemId + '/Images/Primary', { maxWidth: POSTER_MAX_WIDTH })}`;
            img.alt = '';
            img.loading = 'lazy';
            img.onerror = function() { this.style.display = 'none'; };
            posterLink.appendChild(img);
        } else {
            const placeholder = document.createElement('div');
            placeholder.className = 'je-hidden-item-poster';
            posterLink.appendChild(placeholder);
        }
        card.appendChild(posterLink);

        const info = document.createElement('div');
        info.className = 'je-hidden-item-info';

        const nameLink = document.createElement('a');
        nameLink.className = 'je-hidden-item-name';
        nameLink.title = item.name || '';
        nameLink.textContent = item.name || 'Unknown';
        if (hasJellyfinId) {
            nameLink.href = `#/details?id=${item.itemId}`;
        } else if (hasTmdbId) {
            nameLink.href = '#';
            nameLink.dataset.tmdbId = item.tmdbId;
            nameLink.dataset.mediaType = mediaType;
        }
        info.appendChild(nameLink);

        // Attach navigation click handlers
        const navigableLinks = [posterLink, nameLink];
        for (const link of navigableLinks) {
            link.addEventListener('click', (e) => {
                if (hasJellyfinId) {
                    if (onNavigate) onNavigate();
                } else if (hasTmdbId && JE.jellyseerrMoreInfo) {
                    e.preventDefault();
                    JE.jellyseerrMoreInfo.open(parseInt(item.tmdbId, 10), mediaType);
                    if (onNavigate) onNavigate();
                } else if (!hasJellyfinId) {
                    e.preventDefault();
                }
            });
        }

        const metaDiv = document.createElement('div');
        metaDiv.className = 'je-hidden-item-meta';
        const hiddenDate = item.hiddenAt ? new Date(item.hiddenAt).toLocaleDateString() : '';
        metaDiv.textContent = [item.type, hiddenDate].filter(Boolean).join(' \u00B7 ');
        info.appendChild(metaDiv);

        const unhideBtn = document.createElement('button');
        unhideBtn.className = 'je-hidden-item-unhide';
        unhideBtn.textContent = JE.t('hidden_content_unhide');
        info.appendChild(unhideBtn);

        card.appendChild(info);
        return card;
    }

    /**
     * Creates and displays the management panel overlay.
     * Shows all hidden items in a searchable grid with unhide actions.
     */
    function showManagementPanel() {
        document.querySelector('.je-hidden-management-overlay')?.remove();

        const data = getHiddenData();
        const items = Object.entries(data.items || {}).map(([key, item]) => ({ ...item, _key: key }));

        const overlay = document.createElement('div');
        overlay.className = 'je-hidden-management-overlay';

        const panel = document.createElement('div');
        panel.className = 'je-hidden-management-panel';

        const header = createManagementHeader(items.length);
        const closeOverlay = () => {
            overlay.remove();
            document.removeEventListener('keydown', escHandler);
        };
        header.querySelector('.je-hidden-management-close').addEventListener('click', closeOverlay);
        panel.appendChild(header);

        const toolbar = createManagementToolbar();
        panel.appendChild(toolbar.element);

        const gridContainer = document.createElement('div');
        panel.appendChild(gridContainer);

        /**
         * Renders the item grid, optionally filtered by search text.
         * @param {string} [filter] Search text to filter by name.
         */
        function renderGrid(filter) {
            const filtered = filter
                ? items.filter(i => i.name?.toLowerCase().includes(filter.toLowerCase()))
                : items;

            filtered.sort((a, b) => {
                const da = a.hiddenAt ? new Date(a.hiddenAt).getTime() : 0;
                const db = b.hiddenAt ? new Date(b.hiddenAt).getTime() : 0;
                return db - da;
            });

            if (filtered.length === 0) {
                const emptyDiv = document.createElement('div');
                emptyDiv.className = 'je-hidden-management-empty';
                emptyDiv.textContent = JE.t('hidden_content_manage_empty');
                gridContainer.replaceChildren(emptyDiv);
                return;
            }

            const grid = document.createElement('div');
            grid.className = 'je-hidden-management-grid';

            for (const item of filtered) {
                const card = createItemCard(item, () => overlay.remove());

                card.querySelector('.je-hidden-item-unhide').addEventListener('click', () => {
                    card.classList.add('je-hidden-item-removing');
                    setTimeout(() => {
                        unhideItem(item._key || item.itemId);
                        card.remove();
                        const remaining = gridContainer.querySelectorAll('.je-hidden-item-card').length;
                        header.querySelector('h2').textContent = `${JE.t('hidden_content_manage_title')} (${remaining})`;
                        if (remaining === 0) {
                            const emptyDiv = document.createElement('div');
                            emptyDiv.className = 'je-hidden-management-empty';
                            emptyDiv.textContent = JE.t('hidden_content_manage_empty');
                            gridContainer.replaceChildren(emptyDiv);
                        }
                    }, 300);
                });

                grid.appendChild(card);
            }

            gridContainer.replaceChildren(grid);
        }

        renderGrid();

        toolbar.searchInput.addEventListener('input', () => renderGrid(toolbar.searchInput.value));

        toolbar.unhideAllBtn.addEventListener('click', () => {
            if (!confirm(JE.t('hidden_content_clear_confirm'))) return;
            unhideAll();
            const emptyDiv = document.createElement('div');
            emptyDiv.className = 'je-hidden-management-empty';
            emptyDiv.textContent = JE.t('hidden_content_manage_empty');
            gridContainer.replaceChildren(emptyDiv);
            header.querySelector('h2').textContent = `${JE.t('hidden_content_manage_title')} (0)`;
        });

        overlay.appendChild(panel);

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeOverlay();
        });

        const escHandler = (e) => {
            if (e.key === 'Escape') closeOverlay();
        };
        document.addEventListener('keydown', escHandler);

        document.body.appendChild(overlay);
    }

    /**
     * Creates the toolbar (search + unhide-all button) for the management panel.
     * @returns {{ element: HTMLElement, searchInput: HTMLInputElement, unhideAllBtn: HTMLButtonElement }}
     */
    function createManagementToolbar() {
        const toolbar = document.createElement('div');
        toolbar.className = 'je-hidden-management-toolbar';

        const searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.className = 'je-hidden-management-search';
        searchInput.placeholder = JE.t('hidden_content_manage_search') || 'Search hidden items...';
        toolbar.appendChild(searchInput);

        const unhideAllBtn = document.createElement('button');
        unhideAllBtn.className = 'je-hidden-management-unhide-all';
        unhideAllBtn.textContent = JE.t('hidden_content_clear_all');
        toolbar.appendChild(unhideAllBtn);

        return { element: toolbar, searchInput, unhideAllBtn };
    }

    // ============================================================
    // Scope-aware filtering
    // ============================================================

    /**
     * Detects the surface context of a card by checking parent section headers.
     * @param {HTMLElement} card The card element to check.
     * @returns {'nextup'|'continuewatching'|null} The detected surface or null.
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
        sectionSurfaceCache.set(section, surface);
        return surface;
    }

    /**
     * Checks if an item should be hidden on a specific surface, respecting hide scope.
     * Items with scope 'global' are hidden everywhere.
     * Items with scope 'nextup' or 'continuewatching' are only hidden on their respective surfaces.
     * The 'homesections' scope matches both 'nextup' and 'continuewatching'.
     * @param {string} itemId The Jellyfin item ID.
     * @param {string} surface The surface to check ('nextup', 'continuewatching', or 'library').
     * @returns {boolean} `true` if the item is hidden on this surface.
     */
    function isHiddenOnSurface(itemId, surface) {
        if (!itemId) return false;
        const settings = getSettings();
        if (!settings.enabled) return false;

        const data = getHiddenData();
        const items = data.items || {};

        for (const key of Object.keys(items)) {
            const item = items[key];
            if (item.itemId !== itemId) continue;
            const scope = item.hideScope || 'global';
            if (scope === 'global') return true;
            if (scope === surface) return true;
            if (scope === 'homesections' && (surface === 'nextup' || surface === 'continuewatching')) return true;
        }
        return false;
    }

    // ============================================================
    // Native card filtering
    // ============================================================

    /**
     * Extracts the Jellyfin item ID from a card or list-item element.
     * @param {HTMLElement} el The card element.
     * @returns {string|null} The item ID, or null if not found.
     */
    function getCardItemId(el) {
        if (el.dataset && el.dataset.id) return el.dataset.id;
        if (el.dataset && el.dataset.itemid) return el.dataset.itemid;
        return null;
    }

    /**
     * Determines the current native Jellyfin surface from the URL hash.
     * @returns {'details'|'search'|'upcoming'|'library'} The current surface name.
     */
    function getCurrentNativeSurface() {
        const hash = (window.location.hash || '').toLowerCase();
        if (hash.indexOf('/details') !== -1) return 'details';
        if (hash.indexOf('/search') !== -1) return 'search';
        if (hash.indexOf('/upcoming') !== -1) return 'upcoming';
        return 'library';
    }

    /**
     * Asynchronously checks whether a card's parent series is hidden and,
     * if so, hides the card.  Used for episode/season cards in library views.
     * @param {HTMLElement} card The card element.
     * @param {string} itemId The episode/season's Jellyfin item ID.
     */
    function checkAndHideByParentSeries(card, itemId) {
        if (!card || !itemId) return;
        if (!getSettings().enabled || !shouldFilterSurface(getCurrentNativeSurface())) return;
        if (hiddenIdSet.size === 0) return;

        getParentSeriesId(itemId).then((seriesId) => {
            if (!seriesId) return;
            if (!card.isConnected) return;
            if (!getSettings().enabled || !shouldFilterSurface(getCurrentNativeSurface())) return;

            if (hiddenIdSet.has(seriesId)) {
                card.classList.add('je-hidden');
                card.setAttribute(HIDDEN_PARENT_ATTR, seriesId);
                card.removeAttribute(HIDDEN_DIRECT_ATTR);
            } else if (card.getAttribute(HIDDEN_PARENT_ATTR) === seriesId && card.classList.contains('je-hidden')) {
                card.classList.remove('je-hidden');
                card.removeAttribute(HIDDEN_PARENT_ATTR);
            }
        }).catch((e) => {
            console.warn('🪼 Jellyfin Enhanced: Parent series check failed for', itemId, e);
        });
    }

    /**
     * Batch-checks parent series IDs for multiple cards in a single API call.
     * Cards whose parent series is in `hiddenIdSet` are hidden; others are left alone.
     * @param {Array<{card: HTMLElement, itemId: string}>} cardEntries Cards needing lookup.
     */
    async function batchCheckParentSeries(cardEntries) {
        if (!cardEntries || cardEntries.length === 0) return;
        if (!getSettings().enabled || !shouldFilterSurface(getCurrentNativeSurface())) return;
        if (hiddenIdSet.size === 0) return;

        // Separate cached from uncached
        const cached = [];
        const uncached = [];
        for (let i = 0; i < cardEntries.length; i++) {
            const entry = cardEntries[i];
            if (parentSeriesCache.has(entry.itemId)) {
                cached.push({ ...entry, seriesId: parentSeriesCache.get(entry.itemId) });
            } else {
                uncached.push(entry);
            }
        }

        // Process cached entries immediately
        if (cached.length > 0) {
            requestAnimationFrame(() => {
                for (let i = 0; i < cached.length; i++) {
                    const { card, seriesId } = cached[i];
                    if (!card.isConnected || !seriesId) continue;
                    if (hiddenIdSet.has(seriesId)) {
                        card.classList.add('je-hidden');
                        card.setAttribute(HIDDEN_PARENT_ATTR, seriesId);
                        card.removeAttribute(HIDDEN_DIRECT_ATTR);
                    }
                }
            });
        }

        // Fetch uncached entries in batches of 50
        if (uncached.length === 0) return;

        const BATCH_SIZE = 50;
        const userId = ApiClient.getCurrentUserId();

        for (let start = 0; start < uncached.length; start += BATCH_SIZE) {
            const chunk = uncached.slice(start, start + BATCH_SIZE);
            const ids = chunk.map(e => e.itemId).join(',');

            try {
                const result = await ApiClient.ajax({
                    type: 'GET',
                    url: ApiClient.getUrl(`/Users/${userId}/Items`, { Ids: ids, Fields: 'SeriesId' }),
                    dataType: 'json'
                });

                const itemsById = new Map();
                const responseItems = result?.Items || [];
                for (let i = 0; i < responseItems.length; i++) {
                    const item = responseItems[i];
                    itemsById.set(item.Id, item.SeriesId || null);
                    parentSeriesCache.set(item.Id, item.SeriesId || null);
                }

                // Also cache items that weren't in the response (deleted, etc.)
                for (let i = 0; i < chunk.length; i++) {
                    if (!itemsById.has(chunk[i].itemId)) {
                        parentSeriesCache.set(chunk[i].itemId, null);
                    }
                }

                // Batch apply hiding
                requestAnimationFrame(() => {
                    for (let i = 0; i < chunk.length; i++) {
                        const { card, itemId } = chunk[i];
                        if (!card.isConnected) continue;
                        const seriesId = parentSeriesCache.get(itemId);
                        if (seriesId && hiddenIdSet.has(seriesId)) {
                            card.classList.add('je-hidden');
                            card.setAttribute(HIDDEN_PARENT_ATTR, seriesId);
                            card.removeAttribute(HIDDEN_DIRECT_ATTR);
                        }
                    }
                });
            } catch (e) {
                console.warn('🪼 Jellyfin Enhanced: Batch parent series check failed', e);
                // Fall back to individual lookups for this chunk
                for (let i = 0; i < chunk.length; i++) {
                    checkAndHideByParentSeries(chunk[i].card, chunk[i].itemId);
                }
            }
        }
    }

    /**
     * Restores visibility for cards matching a set of item IDs.
     * Used when un-hiding items to immediately show them again.
     * @param {Set<string>} idsToRestore Set of item IDs to restore.
     */
    function restoreNativeCardsForIds(idsToRestore) {
        if (!idsToRestore || idsToRestore.size === 0) return;
        document.querySelectorAll(CARD_SEL).forEach((card) => {
            card.removeAttribute(PROCESSED_ATTR);
            const cardId = getCardItemId(card);
            const hiddenBySeriesId = card.getAttribute(HIDDEN_PARENT_ATTR);
            if (hiddenBySeriesId && idsToRestore.has(hiddenBySeriesId) && card.classList.contains('je-hidden')) {
                card.classList.remove('je-hidden');
                card.removeAttribute(HIDDEN_PARENT_ATTR);
                card.removeAttribute(HIDDEN_DIRECT_ATTR);
            } else if ((cardId && idsToRestore.has(cardId)) || card.getAttribute(HIDDEN_DIRECT_ATTR) === '1') {
                card.classList.remove('je-hidden');
                card.removeAttribute(HIDDEN_DIRECT_ATTR);
            }
        });
    }

    /**
     * Triggers a full re-filter of all native cards.  If filtering is disabled,
     * restores any previously-hidden cards instead.
     */
    function refreshNativeCardVisibility() {
        if (!getSettings().enabled || !shouldFilterSurface(getCurrentNativeSurface())) {
            restoreNativeCardsForIds(hiddenIdSet);
            return;
        }
        requestAnimationFrame(filterAllNativeCards);
    }

    /**
     * Filters only newly-added (not yet scanned) native cards.
     * Called by the debounced MutationObserver callback.
     */
    function filterNativeCards() {
        const nativeSurface = getCurrentNativeSurface();
        if (!shouldFilterSurface(nativeSurface)) return;
        const settings = getSettings();
        if (!settings.enabled) return;
        if (hiddenIdSet.size === 0) return;
        const isDetailPage = nativeSurface === 'details';

        const toHide = [];
        const toShow = [];
        const pendingParentChecks = [];
        const cards = document.querySelectorAll(CARD_SEL_NEW);
        for (let i = 0; i < cards.length; i++) {
            const card = cards[i];
            const itemId = getCardItemId(card);
            card.setAttribute(PROCESSED_ATTR, '1');
            card.removeAttribute(HIDDEN_PARENT_ATTR);
            if (!itemId) continue;

            // Check scope-aware hiding for cards in Next Up / Continue Watching sections
            const cardSurface = getCardSurface(card);
            if (cardSurface) {
                if (shouldFilterSurface(cardSurface) && isHiddenOnSurface(itemId, cardSurface)) {
                    toHide.push(card);
                    card.setAttribute(HIDDEN_DIRECT_ATTR, '1');
                    continue;
                }
            }

            if (hiddenIdSet.has(itemId)) {
                toHide.push(card);
                card.setAttribute(HIDDEN_DIRECT_ATTR, '1');
            } else {
                if (card.getAttribute(HIDDEN_DIRECT_ATTR) === '1' && card.classList.contains('je-hidden')) {
                    toShow.push(card);
                    card.removeAttribute(HIDDEN_DIRECT_ATTR);
                }
                if (!isDetailPage) {
                    const cardType = card.dataset.type || '';
                    if (cardType === 'Episode' || cardType === 'Season') {
                        pendingParentChecks.push({ card, itemId });
                    }
                }
            }
        }

        // Batch apply visibility changes
        if (toHide.length > 0 || toShow.length > 0) {
            requestAnimationFrame(() => {
                for (let i = 0; i < toHide.length; i++) toHide[i].classList.add('je-hidden');
                for (let i = 0; i < toShow.length; i++) toShow[i].classList.remove('je-hidden');
            });
        }

        // Batch parent series checks
        if (pendingParentChecks.length > 0) {
            batchCheckParentSeries(pendingParentChecks);
        }
    }

    /**
     * Filters ALL native cards on the page (including previously scanned ones).
     * Used after settings changes or when the hidden-items set has been modified.
     */
    function filterAllNativeCards() {
        const nativeSurface = getCurrentNativeSurface();
        if (!shouldFilterSurface(nativeSurface)) return;
        const settings = getSettings();
        if (!settings.enabled) return;
        const isDetailPage = nativeSurface === 'details';

        const toHide = [];
        const toShow = [];
        const pendingParentChecks = [];
        const cards = document.querySelectorAll(CARD_SEL);
        for (let i = 0; i < cards.length; i++) {
            const card = cards[i];
            const itemId = getCardItemId(card);
            card.setAttribute(PROCESSED_ATTR, '1');
            card.removeAttribute(HIDDEN_PARENT_ATTR);
            if (!itemId) continue;

            const cardSurface = getCardSurface(card);
            let hiddenByScope = false;
            if (cardSurface && shouldFilterSurface(cardSurface) && isHiddenOnSurface(itemId, cardSurface)) {
                toHide.push(card);
                card.setAttribute(HIDDEN_DIRECT_ATTR, '1');
                hiddenByScope = true;
            }

            if (!hiddenByScope) {
                if (hiddenIdSet.has(itemId)) {
                    toHide.push(card);
                    card.setAttribute(HIDDEN_DIRECT_ATTR, '1');
                } else {
                    if (card.classList.contains('je-hidden')) {
                        toShow.push(card);
                        card.removeAttribute(HIDDEN_DIRECT_ATTR);
                    }
                    if (!isDetailPage) {
                        const cardType = card.dataset.type || '';
                        if (cardType === 'Episode' || cardType === 'Season') {
                            pendingParentChecks.push({ card, itemId });
                        }
                    }
                }
            }
        }

        // Batch apply visibility changes
        if (toHide.length > 0 || toShow.length > 0) {
            requestAnimationFrame(() => {
                for (let i = 0; i < toHide.length; i++) toHide[i].classList.add('je-hidden');
                for (let i = 0; i < toShow.length; i++) toShow[i].classList.remove('je-hidden');
            });
        }

        // Batch parent series checks
        if (pendingParentChecks.length > 0) {
            batchCheckParentSeries(pendingParentChecks);
        }
    }

    // ============================================================
    // Library hide buttons
    // ============================================================

    /**
     * Creates and attaches a hide/unhide toggle button to a single library card.
     * Captures per-card references in a closure for state management.
     * @param {HTMLElement} cardBox The `.cardBox` element to attach the button to.
     * @param {HTMLElement} card The parent `.card` element.
     * @param {string} itemId The Jellyfin item ID.
     */
    function createLibraryHideButton(cardBox, card, itemId) {
        cardBox.style.position = 'relative';
        const btn = document.createElement('button');

        const hideLabel = JE.t('hidden_content_hide_button') !== 'hidden_content_hide_button' ? JE.t('hidden_content_hide_button') : 'Hide';
        const hiddenLabel = JE.t('hidden_content_already_hidden') !== 'hidden_content_already_hidden' ? JE.t('hidden_content_already_hidden') : 'Hidden';
        const unhideLabel = JE.t('hidden_content_unhide') !== 'hidden_content_unhide' ? JE.t('hidden_content_unhide') : 'Unhide';

        /**
         * Renders a material icon inside the button.
         * @param {string} iconName Material icon name.
         */
        function renderIcon(iconName) {
            btn.replaceChildren();
            const icon = document.createElement('span');
            icon.className = 'material-icons';
            icon.setAttribute('aria-hidden', 'true');
            icon.textContent = iconName || 'visibility';
            btn.appendChild(icon);
        }

        /** Configures the button for "already hidden" state — click to unhide. */
        function setHiddenState() {
            btn.className = 'je-hide-btn je-already-hidden';
            btn.title = hiddenLabel;
            renderIcon('visibility_off');
            btn.onmouseenter = () => { btn.title = unhideLabel; };
            btn.onmouseleave = () => { btn.title = hiddenLabel; };
            btn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                unhideItem(itemId);
                setHideState();
            };
        }

        /** Configures the button for "visible" state — click to hide. */
        function setHideState() {
            btn.className = 'je-hide-btn';
            btn.title = hideLabel;
            renderIcon('visibility');
            btn.onmouseenter = null;
            btn.onmouseleave = null;
            btn.onclick = async (e) => {
                e.preventDefault();
                e.stopPropagation();

                const cardName = card.querySelector('.cardText')?.textContent || '';
                const surface = getCardSurface(card);

                if (surface === 'nextup' || surface === 'continuewatching') {
                    await handleScopedCardHide(card, itemId, cardName, surface, setHiddenState);
                } else {
                    confirmAndHide({ itemId, name: cardName }, () => {
                        card.classList.add('je-hidden');
                    });
                }
            };
        }

        if (hiddenIdSet.has(itemId)) {
            setHiddenState();
        } else {
            setHideState();
        }
        cardBox.appendChild(btn);
    }

    /**
     * Handles the hide flow for a card in a scoped surface (Next Up / Continue Watching).
     * Fetches item metadata to determine if episode-choice should be offered.
     * @param {HTMLElement} card The card element to hide.
     * @param {string} itemId The Jellyfin item ID.
     * @param {string} cardName Display name from the card text.
     * @param {string} surface The detected surface ('nextup' or 'continuewatching').
     * @param {Function} setHiddenState Callback to switch the button to "hidden" state.
     */
    async function handleScopedCardHide(card, itemId, cardName, surface, setHiddenState) {
        const itemData = { itemId, name: cardName };
        const dialogOpts = { surface: 'homesections' };

        try {
            const userId = ApiClient.getCurrentUserId();
            const item = await ApiClient.getItem(userId, itemId);
            const itemType = item?.Type || '';
            const seriesId = item?.SeriesId || '';
            const seriesName = item?.SeriesName || '';

            itemData.type = itemType;
            itemData.name = item?.Name || cardName;
            itemData.seriesId = seriesId;
            itemData.seriesName = seriesName;
            itemData.seasonNumber = item?.ParentIndexNumber != null ? item.ParentIndexNumber : null;
            itemData.episodeNumber = item?.IndexNumber != null ? item.IndexNumber : null;
            itemData.tmdbId = item?.ProviderIds?.Tmdb || '';

            if ((itemType === 'Episode' || itemType === 'Season') && seriesId) {
                dialogOpts.showEpisodeChoice = true;
                dialogOpts.onChooseScoped = () => {
                    hideItem({ ...itemData, hideScope: 'homesections' });
                    card.classList.add('je-hidden');
                };
                dialogOpts.onChooseShow = async () => {
                    let seriesTmdbId = '';
                    try {
                        const series = await ApiClient.getItem(userId, seriesId);
                        seriesTmdbId = series?.ProviderIds?.Tmdb || '';
                    } catch (err) {
                        console.warn('🪼 Jellyfin Enhanced: Failed to fetch series TMDB ID', err);
                    }
                    hideItem({
                        itemId: seriesId,
                        name: seriesName || cardName,
                        type: 'Series',
                        tmdbId: seriesTmdbId
                    });
                    card.classList.add('je-hidden');
                };
            } else {
                dialogOpts.onChooseScoped = () => {
                    hideItem({ ...itemData, hideScope: 'homesections' });
                    card.classList.add('je-hidden');
                };
            }
        } catch (err) {
            console.warn('🪼 Jellyfin Enhanced: Failed to fetch item data for scoped hide', err);
            dialogOpts.onChooseScoped = () => {
                hideItem({ itemId, name: cardName, hideScope: 'homesections' });
                card.classList.add('je-hidden');
            };
        }

        confirmAndHide(itemData, () => {
            card.classList.add('je-hidden');
        }, dialogOpts);
    }

    /**
     * Adds hide/unhide toggle buttons to native Jellyfin library cards.
     * Only runs when the `showButtonLibrary` setting is enabled.
     * Skips cards that already have a `.je-hide-btn` to avoid duplicates.
     */
    function addLibraryHideButtons() {
        const s = getSettings();
        if (!s.enabled || !s.showHideButtons || !s.showButtonLibrary) return;

        const skipCollections = !s.experimentalHideCollections;

        const cards = document.querySelectorAll('.card[data-id] .cardBox, .card[data-itemid] .cardBox');
        for (let i = 0; i < cards.length; i++) {
            const cardBox = cards[i];
            if (cardBox.querySelector('.je-hide-btn')) continue;

            const card = cardBox.closest('.card');
            if (!card) continue;
            const itemId = getCardItemId(card);
            if (!itemId) continue;

            if (skipCollections) {
                const cardType = (card.dataset.type || '').toLowerCase();
                if (cardType === 'collectionfolder' || cardType === 'userview' || cardType === 'boxset' || cardType === 'playlist' || cardType === 'channel') continue;
                const section = card.closest('.section, .verticalSection, .homeSection');
                if (section) {
                    const sTitle = (section.querySelector('.sectionTitle, h2, .headerText, .sectionTitle-sectionTitle')?.textContent || '').toLowerCase();
                    if (sTitle.includes('my media') || sTitle.includes('collections')) continue;
                }
            }

            createLibraryHideButton(cardBox, card, itemId);
        }
    }

    /**
     * Removes all hide buttons from native Jellyfin library cards.
     * Called when the `showButtonLibrary` setting is toggled off.
     */
    function removeLibraryHideButtons() {
        const btns = document.querySelectorAll('.card[data-id] .je-hide-btn, .card[data-itemid] .je-hide-btn');
        for (let i = 0; i < btns.length; i++) {
            btns[i].remove();
        }
    }

    // ============================================================
    // Native observer setup
    // ============================================================

    const debouncedFilterNative = JE.helpers?.debounce
        ? JE.helpers.debounce(() => { requestAnimationFrame(filterNativeCards); }, NATIVE_FILTER_DEBOUNCE_MS)
        : filterNativeCards;

    /**
     * Sets up page-navigation and MutationObserver hooks to trigger card
     * filtering and button injection when new cards appear in the DOM.
     */
    function setupNativeObserver() {
        // Use onViewPage for page navigation — much cheaper than a body MutationObserver
        if (JE.helpers?.onViewPage) {
            JE.helpers.onViewPage(() => {
                // Detail pages load episodes asynchronously — staggered re-scans catch late-rendered cards
                if (getCurrentNativeSurface() === 'details') {
                    const rescan = () => {
                        refreshNativeCardVisibility();
                        if (getSettings().showButtonLibrary) addLibraryHideButtons();
                    };
                    setTimeout(rescan, DETAIL_RESCAN_DELAY_MS);
                    setTimeout(rescan, DETAIL_FINAL_RESCAN_DELAY_MS);
                }
            });
        }

        // Lightweight observer for card/list containers
        if (typeof MutationObserver !== 'undefined') {
            const observer = new MutationObserver((mutations) => {
                if (!getSettings().enabled || hiddenIdSet.size === 0) return;
                let hasNewItems = false;
                for (let i = 0; i < mutations.length; i++) {
                    const added = mutations[i].addedNodes;
                    for (let j = 0; j < added.length; j++) {
                        const node = added[j];
                        if (node.nodeType === 1 && (
                            node.classList?.contains('card') ||
                            node.classList?.contains('listItem') ||
                            node.querySelector?.('.card[data-id], .listItem[data-id]')
                        )) {
                            hasNewItems = true;
                            break;
                        }
                    }
                    if (hasNewItems) break;
                }
                if (hasNewItems) {
                    debouncedFilterNative();
                    if (getSettings().showButtonLibrary) addLibraryHideButtons();
                }
            });
            observer.observe(document.body, { childList: true, subtree: true });
        }
    }

    // ============================================================
    // Event emission
    // ============================================================

    /**
     * Dispatches a `je-hidden-content-changed` CustomEvent on `window`.
     * Other modules (e.g. the management page) listen for this to re-render.
     */
    function emitChange() {
        try {
            window.dispatchEvent(new CustomEvent('je-hidden-content-changed'));
        } catch (e) {
            console.warn('🪼 Jellyfin Enhanced: Failed to emit hidden-content-changed event', e);
        }
    }

    // ============================================================
    // Public API
    // ============================================================

    /**
     * Checks if an item is hidden by its Jellyfin ID.
     * @param {string} jellyfinItemId The Jellyfin item ID.
     * @returns {boolean} `true` if the item is hidden.
     */
    function isHidden(jellyfinItemId) {
        if (!jellyfinItemId) return false;
        const settings = getSettings();
        if (!settings.enabled) return false;
        return hiddenIdSet.has(jellyfinItemId);
    }

    /**
     * Checks if an item is hidden by its TMDB ID.
     * @param {string|number} tmdbId The TMDB ID.
     * @returns {boolean} `true` if the item is hidden.
     */
    function isHiddenByTmdbId(tmdbId) {
        if (!tmdbId) return false;
        const settings = getSettings();
        if (!settings.enabled) return false;
        return hiddenTmdbIdSet.has(String(tmdbId));
    }

    /**
     * Hides an item by adding it to the hidden-content data store.
     * Rebuilds lookup sets, schedules a save, emits a change event,
     * shows an undo toast, and refreshes native card visibility.
     * @param {Object} params Item data to hide.
     * @param {string} [params.itemId] Jellyfin item ID.
     * @param {string} [params.name] Display name.
     * @param {string} [params.type] Item type (Movie, Series, Episode, etc.).
     * @param {string|number} [params.tmdbId] TMDB ID.
     * @param {string} [params.posterPath] TMDB poster path.
     * @param {string} [params.seriesId] Parent series Jellyfin ID.
     * @param {string} [params.seriesName] Parent series name.
     * @param {number|null} [params.seasonNumber] Season number.
     * @param {number|null} [params.episodeNumber] Episode number.
     * @param {string} [params.hideScope] Scope: 'global', 'nextup', 'continuewatching', or 'homesections'.
     */
    function hideItem({ itemId, name, type, tmdbId, posterPath, seriesId, seriesName, seasonNumber, episodeNumber, hideScope }) {
        const data = getHiddenData();
        const key = itemId || `tmdb-${tmdbId}`;
        const newItem = {
            itemId: itemId || '',
            name: name || '',
            type: type || '',
            tmdbId: tmdbId ? String(tmdbId) : '',
            hiddenAt: new Date().toISOString(),
            posterPath: posterPath || '',
            seriesId: seriesId || '',
            seriesName: seriesName || '',
            seasonNumber: seasonNumber != null ? seasonNumber : null,
            episodeNumber: episodeNumber != null ? episodeNumber : null,
            hideScope: hideScope || 'global'
        };

        hiddenData = {
            ...data,
            items: { ...data.items, [key]: newItem }
        };
        JE.userConfig.hiddenContent = hiddenData;
        rebuildSets();
        debouncedSave();
        emitChange();
        showUndoToast(name || 'Item', key);
        refreshNativeCardVisibility();
    }

    /**
     * Unhides an item by removing it from the hidden-content data store.
     * Restores visibility for the item's native cards.
     * @param {string} itemId The storage key or Jellyfin item ID to unhide.
     */
    function unhideItem(itemId) {
        const data = getHiddenData();
        const newItems = { ...data.items };
        let restoredJellyfinId = '';

        // Try direct key match first (covers storage keys like "tmdb-12345")
        if (newItems[itemId]) {
            restoredJellyfinId = newItems[itemId].itemId || '';
            delete newItems[itemId];
        } else {
            // Fallback: itemId might be a Jellyfin ID — find the matching storage key
            const matchingKey = Object.keys(newItems).find(k => newItems[k].itemId === itemId);
            if (matchingKey) {
                restoredJellyfinId = newItems[matchingKey].itemId || itemId || '';
                delete newItems[matchingKey];
            }
        }

        hiddenData = { ...data, items: newItems };
        JE.userConfig.hiddenContent = hiddenData;
        rebuildSets();
        debouncedSave();
        emitChange();

        const idsToRestore = new Set();
        if (restoredJellyfinId) idsToRestore.add(restoredJellyfinId);
        else if (itemId && !String(itemId).startsWith('tmdb-')) idsToRestore.add(itemId);
        restoreNativeCardsForIds(idsToRestore);
        refreshNativeCardVisibility();
    }

    /**
     * Merges partial settings into the hidden-content settings.
     * Triggers a save, change event, and native card re-filter.
     * @param {Object} partial Key-value pairs to merge into settings.
     */
    function updateSettings(partial) {
        const data = getHiddenData();
        hiddenData = {
            ...data,
            settings: { ...data.settings, ...partial }
        };
        JE.userConfig.hiddenContent = hiddenData;
        debouncedSave();
        emitChange();
        refreshNativeCardVisibility();
    }

    /**
     * Returns all hidden items as an array with `_key` attached.
     * @returns {Array<Object>} Array of hidden item objects.
     */
    function getAllHiddenItems() {
        const data = getHiddenData();
        const items = data.items || {};
        return Object.entries(items).map(([key, item]) => ({ ...item, _key: key }));
    }

    /**
     * Returns the number of hidden items.
     * @returns {number} Count of hidden items.
     */
    function getHiddenCount() {
        const data = getHiddenData();
        return Object.keys(data.items || {}).length;
    }

    /**
     * Filters Jellyseerr discovery/search results, removing hidden items by TMDB ID.
     * @param {Array} results Array of Jellyseerr result objects.
     * @param {string} surface The surface name (e.g. 'discovery', 'search').
     * @returns {Array} Filtered array.
     */
    function filterJellyseerrResults(results, surface) {
        if (!shouldFilterSurface(surface)) return results;
        if (!Array.isArray(results)) return results;
        return results.filter((item) => {
            const tmdbId = item.id || item.tmdbId;
            return !hiddenTmdbIdSet.has(String(tmdbId));
        });
    }

    /**
     * Filters calendar events, removing hidden items by TMDB ID, Jellyfin ID,
     * or normalised name match (for Sonarr events without TMDB IDs).
     * @param {Array} events Array of calendar event objects.
     * @returns {Array} Filtered array.
     */
    function filterCalendarEvents(events) {
        if (!shouldFilterSurface('calendar')) return events;
        if (!Array.isArray(events)) return events;

        // Build a set of normalised hidden-item names for fuzzy matching
        const hiddenNames = new Set();
        const items = (getHiddenData().items) || {};
        for (const key of Object.keys(items)) {
            const name = items[key].name;
            if (name) {
                const lower = name.toLowerCase();
                hiddenNames.add(lower);
                // Also store without trailing parenthetical qualifier
                // so "Hell's Kitchen (US)" matches "Hell's Kitchen" and vice-versa.
                const stripped = lower.replace(/\s*\([^)]*\)\s*$/, '');
                if (stripped !== lower) hiddenNames.add(stripped);
            }
        }

        return events.filter((event) => {
            if (event.tmdbId && hiddenTmdbIdSet.has(String(event.tmdbId))) return false;
            if (event.itemId && hiddenIdSet.has(event.itemId)) return false;
            if (event.title && hiddenNames.has(event.title.toLowerCase())) return false;
            return true;
        });
    }

    /**
     * Filters request items, removing hidden items by TMDB ID or Jellyfin media ID.
     * @param {Array} items Array of request item objects.
     * @returns {Array} Filtered array.
     */
    function filterRequestItems(items) {
        if (!shouldFilterSurface('requests')) return items;
        if (!Array.isArray(items)) return items;
        return items.filter((item) => {
            const tmdbId = item.tmdbId || item.id;
            if (tmdbId && hiddenTmdbIdSet.has(String(tmdbId))) return false;
            if (item.jellyfinMediaId && hiddenIdSet.has(item.jellyfinMediaId)) return false;
            return true;
        });
    }

    /**
     * Unhides all items, restoring full visibility.  Clears the entire items map.
     */
    function unhideAll() {
        const oldHiddenIds = new Set(hiddenIdSet);
        const data = getHiddenData();
        hiddenData = { ...data, items: {} };
        JE.userConfig.hiddenContent = hiddenData;
        rebuildSets();
        debouncedSave();
        emitChange();
        restoreNativeCardsForIds(oldHiddenIds);
        refreshNativeCardVisibility();
    }

    // ============================================================
    // Initialization
    // ============================================================

    /**
     * Initializes the hidden content module: loads data, rebuilds lookup sets,
     * injects CSS, sets up the MutationObserver, and exposes the public API.
     */
    JE.initializeHiddenContent = function () {
        hiddenData = JE.userConfig?.hiddenContent || { items: {}, settings: {} };
        rebuildSets();
        injectCSS();
        setupNativeObserver();

        if (hiddenIdSet.size > 0) {
            setTimeout(filterAllNativeCards, INIT_FILTER_DELAY_MS);
        }

        // Expose public API
        JE.hiddenContent = {
            isHidden,
            isHiddenByTmdbId,
            isHiddenOnSurface,
            hideItem,
            unhideItem,
            confirmAndHide,
            getSettings,
            updateSettings,
            getAllHiddenItems,
            getHiddenCount,
            filterJellyseerrResults,
            filterCalendarEvents,
            filterRequestItems,
            filterNativeCards,
            showUndoToast,
            showManagementPanel,
            createItemCard,
            unhideAll,
            addLibraryHideButtons,
            removeLibraryHideButtons
        };

        console.log(`🪼 Jellyfin Enhanced: Hidden Content initialized (${getHiddenCount()} items hidden)`);
    };

})(window.JellyfinEnhanced);
