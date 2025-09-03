// /js/jellyseerr.js
(function(JE) {
    'use strict';

    /**
     * Main initialization function for Jellyseerr search integration
     * Handles search results, request management, and season selection
     */
    JE.initializeJellyseerrScript = function() {
        const logPrefix = '🪼 Jellyfin Enhanced: Jellyseerr Search:';

        // Early exit if Jellyseerr is disabled in plugin settings
        if (!JE.pluginConfig.JellyseerrEnabled) {
            console.log(`${logPrefix} Integration is disabled in plugin settings.`);
            return;
        }

        console.log(`${logPrefix} Initializing....`);

        // ================================
        // STATE MANAGEMENT VARIABLES
        // ================================
        let lastProcessedQuery = null;           // Track last search query to prevent duplicate requests
        let debounceTimeout = null;              // Debounce timer for search requests
        let isJellyseerrActive = false;          // Whether Jellyseerr server is online
        let jellyseerrUserFound = false;         // Whether current user exists in Jellyseerr
        let jellyseerrHoverPopover = null;       // Download progress popover element
        let jellyseerrHoverLock = false;         // Lock popover for mobile interactions
        let isJellyseerrOnlyMode = false;        // Filter mode showing only Jellyseerr results
        let hiddenSections = [];                // Store hidden sections for restoration
        let jellyseerrOriginalPosition = null;  // Store original position marker for filter mode

        // ================================
        // SVG ICONS LIBRARY
        // ================================
        const icons = {
            // Star rating icon (yellow)
            star: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" role="img" style="color:#ffc107;"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"></path></svg>',
            // download_done
            available: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" role="img" style="margin-left:0.5em;"><polygon points="20.13,5.41 18.72,4 9.53,13.19 5.28,8.95 3.87,10.36 9.53,16.02"/><rect height="2" width="14" x="5" y="18"/></svg>',
            //error
            error: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" role="img" style="margin-left:0.5em;"><path d="M12 7c.55 0 1 .45 1 1v4c0 .55-.45 1-1 1s-1-.45-1-1V8c0-.55.45-1 1-1zm-.01-5C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm1-3h-2v-2h2v2z"/></svg>',
            //cloud_off
            cloud_off: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" role="img" style="margin-left:0.5em;"><path d="M19.35 10.04C18.67 6.59 15.64 4 12 4c-1.48 0-2.85.43-4.01 1.17l1.46 1.46C10.21 6.23 11.08 6 12 6c3.04 0 5.5 2.46 5.5 5.5v.5H19c1.66 0 3 1.34 3 3 0 1.13-.64 2.11-1.56 2.62l1.45 1.45C23.16 18.16 24 16.68 24 15c0-2.64-2.05-4.78-4.65-4.96zM3 5.27l2.75 2.74C2.56 8.15 0 10.77 0 14c0 3.31 2.69 6 6 6h11.73l2 2L21 20.73 4.27 4 3 5.27zM7.73 10l8 8H6c-2.21 0-4-1.79-4-4s1.79-4 4-4h1.73z"></path></svg>',
            //person_off
            person_off: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" role="img" style="margin-left:0.5em;"><path d="M8.65,5.82C9.36,4.72,10.6,4,12,4c2.21,0,4,1.79,4,4c0,1.4-0.72,2.64-1.82,3.35L8.65,5.82z M20,17.17 c-0.02-1.1-0.63-2.11-1.61-2.62c-0.54-0.28-1.13-0.54-1.77-0.76L20,17.17z M20.49,20.49L3.51,3.51c-0.39-0.39-1.02-0.39-1.41,0l0,0 c-0.39,0.39-0.39,1.02,0,1.41l8.18,8.18c-1.82,0.23-3.41,0.8-4.7,1.46C4.6,15.08,4,16.11,4,17.22L4,20h13.17l1.9,1.9 c0.39,0.39,1.02,0.39,1.41,0l0,0C20.88,21.51,20.88,20.88,20.49,20.49z"/></svg>',
            //pending
            pending: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" role="img" style="margin-left:0.5em;"><path d="M12,2C6.48,2,2,6.48,2,12c0,5.52,4.48,10,10,10s10-4.48,10-10C22,6.48,17.52,2,12,2z M12,20c-4.42,0-8-3.58-8-8 c0-4.42,3.58-8,8-8s8,3.58,8,8C20,16.42,16.42,20,12,20z"/><circle cx="7" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="17" cy="12" r="1.5"/></svg>',
            //calendar_month
            requested: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" role="img" style="margin-left:0.5em;"><path d="M19 4h-1V2h-2v2H8V2H6v2H5c-1.11 0-1.99.9-1.99 2L3 20c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V10h14v10zM9 14H7v-2h2v2zm4 0h-2v-2h2v2zm4 0h-2v-2h2v2zm-8 4H7v-2h2v2zm4 0h-2v-2h2v2zm4 0h-2v-2h2v2z"></path></svg>',
            //check_circle_outline
            partially_available: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" role="img" style="margin-left:0.5em;"><path d="M9.71 11.29a1 1 0 0 0-1.42 1.42l3 3A1 1 0 0 0 12 16a1 1 0 0 0 .72-.34l7-8a1 1 0 0 0-1.5-1.32L12 13.54z"/><path d="M21 11a1 1 0 0 0-1 1 8 8 0 0 1-8 8A8 8 0 0 1 6.33 6.36 7.93 7.93 0 0 1 12 4a8.79 8.79 0 0 1 1.9.22 1 1 0 1 0 .47-1.94A10.54 10.54 0 0 0 12 2a10 10 0 0 0-7 17.09A9.93 9.93 0 0 0 12 22a10 10 0 0 0 10-10 1 1 0 0 0-1-1z"/></svg>',
            //cancel
            cancel: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" role="img" style="margin-left:0.5em;"><path d="M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z"></path></svg>',

            //download
            request: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" role="img" style="margin-right:0.5em;"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"></path></svg>'
        };

        // ================================
        // DOWNLOAD PROGRESS POPOVER SYSTEM
        // ================================

        /**
         * Creates or returns existing hover popover element
         * Used for showing download progress on hover/focus
         */
        function ensureHoverPopover() {
            if (!jellyseerrHoverPopover) {
                jellyseerrHoverPopover = document.createElement('div');
                jellyseerrHoverPopover.className = 'jellyseerr-hover-popover';
                document.body.appendChild(jellyseerrHoverPopover);
            }
            return jellyseerrHoverPopover;
        }

        /**
         * Fills popover with download progress information
         * @param {Object} item - Media item with download status
         * @returns {HTMLElement|null} - Popover element or null if no download data
         */
        function fillHoverPopover(item) {
            const downloadStatus = item.mediaInfo?.downloadStatus?.[0] || item.mediaInfo?.downloadStatus4k?.[0];

            // Ensure we have valid download data
            if (!downloadStatus ||
                typeof downloadStatus.size !== 'number' ||
                typeof downloadStatus.sizeLeft !== 'number' ||
                downloadStatus.size <= 0) {
                return null;
            }

            // Calculate download percentage
            const percentage = Math.max(0, Math.min(100, Math.round(100 * (1 - downloadStatus.sizeLeft / downloadStatus.size))));
            const popover = ensureHoverPopover();

            popover.innerHTML = `
                <div class="title">${downloadStatus.title || JE.t('jellyseerr_popover_downloading')}</div>
                <div class="jellyseerr-hover-progress">
                    <div class="bar" style="width:${percentage}%;"></div>
                </div>
                <div class="row">
                    <div>${percentage}%</div>
                    <div class="status">${(downloadStatus.status || 'downloading').toString().replace(/^./, c => c.toUpperCase())}</div>
                </div>
            `;
            return popover;
        }

        /**
         * Positions popover to stay within screen bounds
         * @param {HTMLElement} element - Popover element to position
         * @param {number} x - Target X coordinate
         * @param {number} y - Target Y coordinate
         */
        function positionHoverPopover(element, x, y) {
            const padding = 12;
            const rect = element.getBoundingClientRect();

            // Calculate position with screen boundary constraints
            let newX = Math.min(Math.max(x + 14, padding), window.innerWidth - rect.width - padding);
            let newY = Math.min(Math.max(y - rect.height - 14, padding), window.innerHeight - rect.height - padding);

            element.style.transform = `translate(${newX}px, ${newY}px)`;
        }

        /**
         * Hides the hover popover (respects mobile lock)
         */
        function hideHoverPopover() {
            if (jellyseerrHoverPopover && !jellyseerrHoverLock) {
                jellyseerrHoverPopover.classList.remove('show');
            }
        }

        /**
         * Creates inline download progress display for season items
         * @param {Object} downloadStatus - Download status object
         * @returns {HTMLElement} - Progress element
         */
        function createInlineProgress(downloadStatus) {
            if (!downloadStatus ||
                typeof downloadStatus.size !== 'number' ||
                typeof downloadStatus.sizeLeft !== 'number' ||
                downloadStatus.size <= 0) {
                return null;
            }

            const percentage = Math.max(0, Math.min(100, Math.round(100 * (1 - downloadStatus.sizeLeft / downloadStatus.size))));

            const progressContainer = document.createElement('div');
            progressContainer.className = 'jellyseerr-inline-progress';
            progressContainer.innerHTML = `
                <div class="jellyseerr-inline-progress-bar">
                    <div class="jellyseerr-inline-progress-fill" style="width: ${percentage}%"></div>
                </div>
                <div class="jellyseerr-inline-progress-text">${percentage}% • ${(downloadStatus.status || 'downloading').replace(/^./, c => c.toUpperCase())}</div>
            `;

            return progressContainer;
        }

        // ================================
        // STYLING SYSTEM
        // ================================

        /**
         * Adds main CSS styles for Jellyseerr integration
         */
        function addMainStyles() {
            const styleId = 'jellyseerr-styles';
            if (document.getElementById(styleId)) return;

            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                /* =====================================================
                   LAYOUT & ICONS
                   ===================================================== */
                .jellyseerr-section {
                    margin-bottom: 1em;
                }
                .jellyseerr-section .itemsContainer {
                    white-space: nowrap;
                }

                /* Jellyseerr icon in search field */
                #jellyseerr-search-icon {
                    position: absolute;
                    right: 10px;
                    top: 68%;
                    transform: translateY(-50%);
                    user-select: none;
                    z-index: 10;
                    transition: filter .2s, opacity .2s, transform .2s;
                }
                .inputContainer {
                    position: relative !important;
                }
                .jellyseerr-icon {
                    width: 30px;
                    height: 50px;
                    filter: drop-shadow(2px 2px 6px #000);
                }

                /* Icon states */
                #jellyseerr-search-icon.is-active {
                    filter: drop-shadow(2px 2px 6px #000);
                    opacity: 1;
                }
                #jellyseerr-search-icon.is-disabled {
                    filter: grayscale(1);
                    opacity: .8;
                }
                #jellyseerr-search-icon.is-no-user {
                    filter: hue-rotate(125deg) brightness(100%);
                }
                #jellyseerr-search-icon.is-filter-active {
                    filter: drop-shadow(2px 2px 6px #3b82f6) brightness(1.2);
                    transform: translateY(-50%) scale(1.1);
                }
                #jellyseerr-search-icon:hover {
                    transform: translateY(-50%) scale(1.05);
                    transition: transform 0.2s ease;
                }

                /* =====================================================
                   CARDS & BADGES
                   ===================================================== */
                .jellyseerr-card {
                    position: relative;
                }
                .jellyseerr-card .cardScalable {
                    contain: paint;
                }

                /* Jellyseerr logo on card */
                .jellyseerr-icon-on-card {
                    position: absolute;
                    top: 8px;
                    right: 8px;
                    width: 18%;
                    height: auto;
                    z-index: 2;
                    filter: drop-shadow(0 2px 4px rgba(0,0,0,0.8));
                }

                /* Media type badges (Movie/Series) */
                .jellyseerr-media-badge {
                    position: absolute;
                    top: 8px;
                    left: 8px;
                    z-index: 100;
                    color: #fff;
                    padding: 2px 8px;
                    border-radius: 999px;
                    border: 1px solid rgba(0,0,0,0.2);
                    font-size: 1em;
                    font-weight: 500;
                    text-transform: uppercase;
                    letter-spacing: 1.5px;
                    text-shadow: 1px 1px 3px rgba(0, 0, 0, 0.8);
                    box-shadow: 0 4px 4px -1px rgba(0,0,0,0.1), 0 2px 2px -2px rgba(0,0,0,0.1);
                    backdrop-filter: blur(8px);
                    -webkit-backdrop-filter: blur(8px);
                }
                .layout-mobile .jellyseerr-media-badge {
                    font-size: 0.8em !important;
                }
                .jellyseerr-media-badge-movie {
                    background-color: rgba(59, 130, 246, .9);
                    box-shadow: 0 0 0 1px rgba(59,130,246,.35), 0 8px 24px rgba(59,130,246,.25);
                }
                .jellyseerr-media-badge-series {
                    background-color: rgba(243, 51, 214, .9);
                    box-shadow: 0 0 0 1px rgba(236,72,153,.35), 0 8px 24px rgba(236,72,153,.25);
                }

                /* Card overview overlay */
                .jellyseerr-overview {
                    position: absolute;
                    inset: 0;
                    background: linear-gradient(180deg, rgba(0,0,0,0) 30%, rgba(0,0,0,.78) 75%, rgba(0,0,0,.92) 100%);
                    color: #e5e7eb;
                    padding: 12px 12px 14px;
                    line-height: 1.5;
                    opacity: 0;
                    transform: translateY(6px);
                    transition: opacity .18s ease, transform .18s ease;
                    overflow: hidden;
                    display: flex;
                    align-items: flex-end;
                    backdrop-filter: blur(2px);
                    -webkit-backdrop-filter: blur(2px);
                }
                .jellyseerr-overview .content {
                    width: 100%;
                    display: -webkit-box;
                    -webkit-line-clamp: 6;
                    -webkit-box-orient: vertical;
                    overflow: hidden;
                    white-space: normal;
                }

                /* Show overview on hover/focus/touch */
                .jellyseerr-card:focus-within .jellyseerr-overview,
                .jellyseerr-card:hover .jellyseerr-overview,
                .jellyseerr-card.is-touch .jellyseerr-overview {
                    opacity: 1;
                }
                .jellyseerr-overview .title {
                    font-weight: 600;
                    display: block;
                    margin-bottom: .35em;
                }

                /* Card metadata (year, rating) */
                .jellyseerr-meta {
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    gap: 1.5em;
                    padding: 0 .75em;
                }
                .jellyseerr-rating {
                    display: flex;
                    align-items: center;
                    gap: .3em;
                    color: #bdbdbd;
                }

                /* Reset TMDB link styling */
                .cardText-first > a[is="emby-linkbutton"] {
                    padding: 0 !important;
                    margin: 0 !important;
                    color: inherit;
                    text-decoration: none;
                }

                /* =====================================================
                   REQUEST BUTTONS
                   ===================================================== */
                .jellyseerr-request-button {
                    width: 100%;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    white-space: normal;
                    text-align: center;
                    height: 3.5em;
                    padding: 0.2em 0.5em;
                    line-height: 1.2;
                    font-size: 1em;
                    transition: background .2s, border-color .2s, color .2s;
                }
                .jellyseerr-request-button svg {
                    width: 1.5em;
                    height: 1.5em;
                    flex-shrink: 0;
                    vertical-align: middle;
                }
                .layout-mobile .jellyseerr-request-button span {
                    font-size: 0.8em !important;
                }

                /* Button state styles */
                .jellyseerr-request-button.jellyseerr-button-offline,
                .jellyseerr-request-button.jellyseerr-button-no-user {
                    opacity: .6;
                    cursor: not-allowed;
                }
                .jellyseerr-request-button.jellyseerr-button-request {
                    background-color: #4f46e5 !important;
                    color: #fff !important;
                }
                .jellyseerr-request-button.jellyseerr-button-pending {
                    background-color: #b45309 !important;
                    color: #fff !important;
                }
                .jellyseerr-request-button.jellyseerr-button-processing {
                    background-color: #581c87 !important;
                    color: #fff !important;
                }
                .jellyseerr-request-button.jellyseerr-button-rejected {
                    background-color: #8a1c1c !important;
                    color: #fff !important;
                }
                .jellyseerr-request-button.jellyseerr-button-partially-available {
                    background-color: #4ca46c !important;
                    color: #fff !important;
                }
                .jellyseerr-request-button.jellyseerr-button-available {
                    background-color: #16a34a !important;
                    color: #fff !important;
                }
                .jellyseerr-request-button.jellyseerr-button-error {
                    background: #dc3545 !important;
                    color: #fff !important;
                }

                /* Enhanced TV show button styling */
                .jellyseerr-request-button.jellyseerr-button-tv:not(.jellyseerr-button-available):not(.jellyseerr-button-offline):not(.jellyseerr-button-no-user):not(.jellyseerr-button-error) {
                    position: relative;
                }
                .jellyseerr-request-button.jellyseerr-button-tv:not(.jellyseerr-button-available):not(.jellyseerr-button-offline):not(.jellyseerr-button-no-user):not(.jellyseerr-button-error)::after {
                    content: '▼';
                    margin-left: 6px;
                    font-size: 0.7em;
                    opacity: 0.8;
                }

                /* Season summary text in button */
                .jellyseerr-season-summary {
                    font-size: 0.85em;
                    opacity: 0.9;
                    display: block;
                    margin-top: 2px;
                }

                /* =====================================================
                   SPINNERS & LOADERS
                   ===================================================== */
                .jellyseerr-spinner,
                .jellyseerr-loading-spinner,
                .jellyseerr-button-spinner {
                    display: inline-block;
                    border-radius: 50%;
                    animation: jellyseerr-spin 1s linear infinite;
                }
                .jellyseerr-loading-spinner {
                    width: 20px;
                    height: 20px;
                    border: 3px solid rgba(255,255,255,.3);
                    border-top-color: #fff;
                    margin-left: 10px;
                    vertical-align: middle;
                }
                .jellyseerr-button-spinner {
                    width: 1em;
                    height: 1em;
                    border: 2px solid currentColor;
                    border-right-color: transparent;
                    margin-left: .5em;
                    flex-shrink: 0;
                }

                /* =====================================================
                   HOVER POPOVER STYLES
                   ===================================================== */
                .jellyseerr-hover-popover {
                    position: fixed;
                    min-width: 260px;
                    max-width: 340px;
                    padding: 10px 12px;
                    background: #1f2937;
                    color: #e5e7eb;
                    border-radius: 10px;
                    z-index: 9999;
                    box-shadow: 0 10px 30px rgba(0,0,0,.45), 0 0 0 1px rgba(255,255,252, .06);
                    opacity: 0;
                    pointer-events: none;
                    transition: opacity .12s ease, transform .12s ease;
                }
                .jellyseerr-hover-popover.show {
                    opacity: 1;
                }
                .jellyseerr-hover-popover .title {
                    font-weight: 600;
                    font-size: .9rem;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    margin-bottom: 8px;
                }
                .jellyseerr-hover-popover .row {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 8px;
                    margin-top: 6px;
                }
                .jellyseerr-hover-popover .status {
                    display: inline-block;
                    padding: 2px 8px;
                    border-radius: 999px;
                    font-size: .75rem;
                    font-weight: 600;
                    background: #4f46e5;
                    color: #fff;
                }
                .jellyseerr-hover-popover .jellyseerr-hover-progress {
                    height: 7px;
                    width: 100%;
                    background: rgba(255,255,255,.12);
                    border-radius: 999px;
                    overflow: hidden;
                }
                .jellyseerr-hover-popover .jellyseerr-hover-progress .bar {
                    height: 100%;
                    background: linear-gradient(90deg, #3b82f6, #8b5cf6);
                    transition: width .2s ease;
                }

                /* =====================================================
                   UTILITY CLASSES
                   ===================================================== */
                @keyframes jellyseerr-spin {
                    to { transform: rotate(360deg) }
                }
                .section-hidden {
                    display: none !important;
                }
            `;
            document.head.appendChild(style);
        }

        /**
         * Adds enhanced CSS styles for season selection modal
         */
        function addSeasonModalStyles() {
            const seasonStyleId = 'jellyseerr-season-styles';
            if (document.getElementById(seasonStyleId)) return;

            const style = document.createElement('style');
            style.id = seasonStyleId;
            style.textContent = `
                /* =====================================================
                   SEASON SELECTION MODAL (MATCHING JELLYSEERR DESIGN)
                   ===================================================== */
                .jellyseerr-season-modal {
                    position: fixed;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    background: rgba(0, 10, 20, 0.85);
                    backdrop-filter: blur(8px);
                    -webkit-backdrop-filter: blur(8px);
                    z-index: 10000;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    opacity: 0;
                    pointer-events: none;
                    transition: opacity 0.3s ease;
                }
                .jellyseerr-season-modal.show {
                    opacity: 1;
                    pointer-events: all;
                }
                body.jellyseerr-modal-is-open {
                    overflow: hidden;
                }
                /* Modal content container */
                .jellyseerr-season-content {
                    background: linear-gradient(145deg, #1e293b 0%, #0f172a 100%);
                    border: 1px solid rgba(148, 163, 184, 0.1);
                    border-radius: 16px;
                    padding: 0;
                    max-width: 700px;
                    width: 90%;
                    max-height: 80vh;
                    overflow: scroll;
                    box-shadow:
                        0 25px 80px rgba(0,0,0,0.8),
                        0 0 0 1px rgba(148, 163, 184, 0.05),
                        inset 0 1px 0 rgba(148, 163, 184, 0.1);
                    transform: scale(0.95);
                    transition: transform 0.3s ease;
                }
                .jellyseerr-season-modal.show .jellyseerr-season-content {
                    transform: scale(1);
                }

                /* Modal header with backdrop image */
                .jellyseerr-season-header {
                    position: relative;
                    padding: 24px;
                    border-radius: 16px 16px 0 0;
                    overflow: hidden;
                    height: 8em;
                }
                .jellyseerr-season-header::before {
                    content: '';
                    position: absolute;
                    top: 0; left: 0; right: 0; bottom: 0;
                    pointer-events: none;
                    backdrop-filter: blur(2px);
                    background: rgba(0, 0, 0, 0.8);
                }
                .jellyseerr-season-title {
                    position: relative;
                    font-size: 1.8rem;
                    font-weight: 700;
                    margin-bottom: 6px;
                    background: linear-gradient(45deg, #3b82f6, #8b5cf6);
                    -webkit-background-clip: text;
                    -webkit-text-fill-color: transparent;
                }
                .jellyseerr-season-subtitle {
                    position: relative;
                    font-size: 1.4rem;
                    color: rgba(255,255,255,0.9);
                    font-weight: 500;
                }

                /* Modal body */
                .jellyseerr-season-body {
                    padding: 24px;
                    max-height: calc(80vh - 200px);
                    overflow-y: auto;
                }

                /* Season list */
                .jellyseerr-season-list {
                    display: grid;
                    gap: 4px;
                    margin-bottom: 24px;
                }

                /* Individual season item */
                .jellyseerr-season-item {
                    display: grid;
                    grid-template-columns: 40px 1fr auto auto;
                    align-items: center;
                    gap: 16px;
                    padding: 16px 20px;
                    background: rgba(30, 41, 59, 0.4);
                    border: 1px solid rgba(51, 65, 85, 0.3);
                    border-radius: 12px;
                    transition: all 0.2s ease;
                    position: relative;
                }
                .jellyseerr-season-item:hover:not(.disabled) {
                    background: rgba(30, 41, 59, 0.7);
                    border-color: rgba(59, 130, 246, 0.3);
                    transform: translateY(-1px);
                }
                .jellyseerr-season-item.disabled {
                    background: rgba(15, 23, 42, 0.6);
                    opacity: 0.6;
                    border-color: rgba(51, 65, 85, 0.2);
                }

                /* Checkbox styling */
                .jellyseerr-season-checkbox {
                    width: 20px;
                    height: 20px;
                    accent-color: #4f46e5;
                    border-radius: 4px;
                }
                .jellyseerr-season-checkbox:disabled {
                    opacity: 0.4;
                    cursor: not-allowed;
                }

                /* Season information */
                .jellyseerr-season-info {
                    display: flex;
                    flex-direction: column;
                    gap: 4px;
                    min-width: 0;
                }
                .jellyseerr-season-name {
                    font-weight: 600;
                    color: #e2e8f0;
                    font-size: 1rem;
                }
                .jellyseerr-season-meta {
                    font-size: 0.875rem;
                    color: #94a3b8;
                }

                /* Episode count */
                .jellyseerr-season-episodes {
                    font-size: 0.875rem;
                    color: #64748b;
                    text-align: right;
                    min-width: 70px;
                    font-weight: 500;
                }

                /* Status badges */
                .jellyseerr-season-status {
                    padding: 6px 12px;
                    border-radius: 20px;
                    font-size: 0.75rem;
                    font-weight: 700;
                    text-transform: uppercase;
                    min-width: 110px;
                    text-align: center;
                    letter-spacing: 0.5px;
                    border: 1px solid transparent;
                }
                .jellyseerr-season-status-available {
                    background: rgba(34, 197, 94, 0.15);
                    color: #4ade80;
                    border-color: rgba(34, 197, 94, 0.3);
                }
                .jellyseerr-season-status-pending {
                    background: rgba(251, 146, 60, 0.15);
                    color: #fb923c;
                    border-color: rgba(251, 146, 60, 0.3);
                }
                .jellyseerr-season-status-processing {
                    background: rgba(147, 51, 234, 0.15);
                    color: #a855f7;
                    border-color: rgba(147, 51, 234, 0.3);
                }
                .jellyseerr-season-status-partially-available {
                    background: rgba(34, 197, 94, 0.15);
                    color: #4ade80;
                    border-color: rgba(34, 197, 94, 0.3);
                }
                .jellyseerr-season-status-not-requested {
                    background: rgba(99, 102, 241, 0.15);
                    color: #818cf8;
                    border-color: rgba(99, 102, 241, 0.3);
                }

                /* Inline progress for downloading seasons */
                .jellyseerr-inline-progress {
                    grid-column: 1 / -1;
                    padding: 8px 12px;
                    background: rgba(15, 23, 42, 0.5);
                    border-radius: 8px;
                    border: 1px solid rgba(59, 130, 246, 0.2);
                }
                .jellyseerr-inline-progress-bar {
                    height: .5rem;
                    background: rgba(255,255,255,0.1);
                    border-radius: 3px;
                    overflow: hidden;
                    margin-bottom: .5rem;
                }
                .jellyseerr-inline-progress-fill {
                    height: 100%;
                    background: linear-gradient(90deg, #3b82f6, #8b5cf6);
                    transition: width 0.3s ease;
                    border-radius: 3px;
                }
                .jellyseerr-inline-progress-text {
                    font-size: 0.75rem;
                    color: #94a3b8;
                    font-weight: 500;
                }

                /* Modal footer */
                .jellyseerr-modal-footer {
                    padding: 20px 24px;
                    background: rgba(15, 23, 42, 0.3);
                    border-top: 1px solid rgba(51, 65, 85, 0.3);
                    display: flex;
                    gap: 12px;
                    justify-content: flex-end;
                }

                /* Modal buttons */
                .jellyseerr-modal-button {
                    padding: 12px 24px;
                    border-radius: 8px;
                    border: none;
                    cursor: pointer;
                    font-weight: 600;
                    font-size: 0.875rem;
                    transition: all 0.2s ease;
                    min-width: 120px;
                }
                .jellyseerr-modal-button:disabled {
                    opacity: 0.6;
                    cursor: not-allowed;
                }
                .jellyseerr-modal-button-primary {
                    background: linear-gradient(135deg, #4f46e5, #7c3aed);
                    color: white;
                    box-shadow: 0 4px 12px rgba(79, 70, 229, 0.3);
                }
                .jellyseerr-modal-button-primary:hover:not(:disabled) {
                    background: linear-gradient(135deg, #4338ca, #6d28d9);
                    transform: translateY(-1px);
                    box-shadow: 0 6px 20px rgba(79, 70, 229, 0.4);
                }
                .jellyseerr-modal-button-secondary {
                    background: rgba(71, 85, 105, 0.8);
                    color: #e2e8f0;
                    border: 1px solid rgba(148, 163, 184, 0.2);
                }
                .jellyseerr-modal-button-secondary:hover {
                    background: rgba(71, 85, 105, 1);
                    border-color: rgba(148, 163, 184, 0.3);
                }
            `;
            document.head.appendChild(style);
        }

        // ================================
        // API FUNCTIONS
        // ================================

        /**
         * Checks the status of Jellyseerr connection and user authentication
         * Updates global state variables and icon display
         */
        async function checkJellyseerrStatus() {
            try {
                const response = await ApiClient.ajax({
                    type: 'GET',
                    url: ApiClient.getUrl('/JellyfinEnhanced/jellyseerr/user-status'),
                    headers: {
                        'X-Jellyfin-User-Id': ApiClient.getCurrentUserId()
                    },
                    dataType: 'json'
                });

                isJellyseerrActive = !!response.active;
                jellyseerrUserFound = !!response.userFound;

                if (isJellyseerrActive && !jellyseerrUserFound) {
                    console.warn(`${logPrefix} Connection successful, but the current Jellyfin user is not linked to a Jellyseerr account.`);
                }
            } catch (error) {
                const userId = ApiClient.getCurrentUserId();
                console.warn(`${logPrefix} Status check failed for user ${userId}:`, error);
                isJellyseerrActive = false;
                jellyseerrUserFound = false;
            }
            updateJellyseerrIcon();
        }

        /**
         * Fetches search results from Jellyseerr API
         * @param {string} query - Search query string
         */
        async function fetchJellyseerrSearchResults(query) {
            const requestUrl = ApiClient.getUrl(`/JellyfinEnhanced/jellyseerr/search?query=${encodeURIComponent(query)}`);

            try {
                const data = await ApiClient.ajax({
                    type: 'GET',
                    url: requestUrl,
                    dataType: 'json',
                    headers: {
                        'X-Jellyfin-User-Id': ApiClient.getCurrentUserId()
                    }
                });

                if (data.results && data.results.length > 0) {
                    const jellyseerrSection = createJellyseerrSection(false, data.results);
                    renderJellyseerrResults(jellyseerrSection, query);
                } else {
                    console.debug(`${logPrefix} No results found for query: "${query}"`);
                }
            } catch (error) {
                const userId = ApiClient.getCurrentUserId();
                const errorDetails = error.responseJSON || error;
                console.error(`${logPrefix} Error fetching search results for user ${userId}. Query: "${query}". Error:`, errorDetails);
            }
        }

        /**
         * Fetches detailed TV show information including seasons
         * @param {number} tmdbId - TMDB ID of the TV show
         * @returns {Object|null} - TV show details or null on error
         */
        async function fetchTvShowDetails(tmdbId) {
            try {
                const response = await ApiClient.ajax({
                    type: 'GET',
                    url: ApiClient.getUrl(`/JellyfinEnhanced/jellyseerr/tv/${tmdbId}`),
                    headers: {
                        'X-Jellyfin-User-Id': ApiClient.getCurrentUserId()
                    },
                    dataType: 'json'
                });
                return response;
            } catch (error) {
                console.error(`${logPrefix} Failed to fetch TV show details for TMDB ID ${tmdbId}:`, error);
                return null;
            }
        }

        /**
         * Requests media from Jellyseerr (movies or all seasons of TV shows)
         * @param {number} tmdbId - TMDB ID of the media
         * @param {string} mediaType - 'movie' or 'tv'
         * @param {HTMLElement} button - Request button element
         */
        async function requestMedia(tmdbId, mediaType, button) {
            // Update button to show requesting state
            button.disabled = true;
            button.innerHTML = `<span>${JE.t('jellyseerr_btn_requesting')}</span><span class="jellyseerr-button-spinner"></span>`;

            const requestBody = {
                mediaType,
                mediaId: parseInt(tmdbId)
            };

            // For TV shows, request all seasons by default
            if (mediaType === 'tv') {
                requestBody.seasons = "all";
            }

            try {
                await ApiClient.ajax({
                    type: 'POST',
                    url: ApiClient.getUrl('/JellyfinEnhanced/jellyseerr/request'),
                    data: JSON.stringify(requestBody),
                    contentType: 'application/json',
                    headers: {
                        'X-Jellyfin-User-Id': ApiClient.getCurrentUserId()
                    }
                });

                // Update button to show success state
                button.innerHTML = `<span>${JE.t('jellyseerr_btn_requested')} ${icons.requested}</span>`;
                button.classList.remove('jellyseerr-button-request');
                button.classList.add('jellyseerr-button-pending');

            } catch (error) {
                button.disabled = false;
                const userId = ApiClient.getCurrentUserId();
                const errorDetails = error.responseJSON || error;
                console.error(`${logPrefix} Request failed for user ${userId}. Request Body:`, JSON.stringify(requestBody), 'Error:', errorDetails);

                // Determine appropriate error message
                let errorMessage = JE.t('jellyseerr_btn_error');
                if (error.status === 404) {
                    errorMessage = JE.t('jellyseerr_btn_user_not_found');
                } else if (error.responseJSON && error.responseJSON.message) {
                    errorMessage = error.responseJSON.message;
                }

                button.innerHTML = `<span>${errorMessage} ${icons.error}</span>`;
                button.classList.add('jellyseerr-button-error');
            }
        }

        /**
         * Requests specific TV show seasons
         * @param {number} tmdbId - TMDB ID of the TV show
         * @param {number[]} seasonNumbers - Array of season numbers to request
         */
        async function requestTvSeasons(tmdbId, seasonNumbers) {
            const requestBody = {
                mediaType: 'tv',
                mediaId: parseInt(tmdbId),
                seasons: seasonNumbers
            };

            try {
                await ApiClient.ajax({
                    type: 'POST',
                    url: ApiClient.getUrl('/JellyfinEnhanced/jellyseerr/request'),
                    data: JSON.stringify(requestBody),
                    contentType: 'application/json',
                    headers: {
                        'X-Jellyfin-User-Id': ApiClient.getCurrentUserId()
                    }
                });
            } catch (error) {
                const userId = ApiClient.getCurrentUserId();
                const errorDetails = error.responseJSON || error;
                console.error(`${logPrefix} Season request failed for user ${userId}. Request Body:`, JSON.stringify(requestBody), 'Error:', errorDetails);
                throw error;
            }
        }

        // ================================
        // SEASON ANALYSIS & STATUS LOGIC
        // ================================

        /**
         * Analyzes season statuses to determine overall show status
         * @param {Array} seasons - Array of season objects with status information
         * @returns {Object} - Analysis result with overall status and summary
         */
        function analyzeSeasonStatuses(seasons) {
            if (!seasons || seasons.length === 0) {
                return { overallStatus: 1, statusSummary: null, total: 0 };
            }

            // Filter out special seasons (season 0) for analysis
            const regularSeasons = seasons.filter(season => season.seasonNumber > 0);
            const total = regularSeasons.length;

            if (total === 0) {
                return { overallStatus: 1, statusSummary: null, total: 0 };
            }

            // Count seasons by status
            const statusCounts = {
                available: regularSeasons.filter(s => s.status === 5).length,
                pending: regularSeasons.filter(s => s.status === 2).length,
                processing: regularSeasons.filter(s => s.status === 3).length,
                partiallyAvailable: regularSeasons.filter(s => s.status === 4).length,
                notRequested: regularSeasons.filter(s => s.status === 1).length
            };

            const requestedCount = statusCounts.pending + statusCounts.processing;
            const availableCount = statusCounts.available + statusCounts.partiallyAvailable;
            const accountedForCount = requestedCount + availableCount;

            let overallStatus;
            let statusSummary = null;

            // Determine overall status based on season distribution
            if (statusCounts.notRequested === 0) {
                // No seasons left to request
                if (availableCount === total) {
                    overallStatus = 5; // Fully Available
                } else {
                    overallStatus = 7; // Fully Requested/Accounted For
                    statusSummary = JE.t('jellyseerr_seasons_accounted_for', { count: accountedForCount, total });
                }
            } else if (accountedForCount > 0) {
                // Mixed state - some seasons requested/available, others not
                if (availableCount > 0) {
                    overallStatus = 4; // Partially Available
                    statusSummary = JE.t('jellyseerr_seasons_available_count', { count: availableCount, total });
                } else {
                    overallStatus = 3; // Partially Requested
                    statusSummary = JE.t('jellyseerr_seasons_requested_count', { count: requestedCount, total });
                }
            } else {
                // No seasons are requested or available
                overallStatus = 1; // Not Requested
            }

            return { overallStatus, statusSummary, total };
        }

        // ================================
        // FILTER MODE FUNCTIONALITY
        // ================================

        /**
         * Toggles between showing all search results vs only Jellyseerr results
         */
        function toggleJellyseerrOnlyMode() {
            isJellyseerrOnlyMode = !isJellyseerrOnlyMode;

            const searchPage = document.querySelector('#searchPage');
            if (!searchPage) return;

            if (isJellyseerrOnlyMode) {
                // ENABLE FILTER MODE: Hide all non-Jellyseerr sections
                const allSections = searchPage.querySelectorAll('.verticalSection:not(.jellyseerr-section)');
                hiddenSections = Array.from(allSections);

                allSections.forEach(section => {
                    section.classList.add('section-hidden');
                });

                // Move Jellyseerr section to top
                const jellyseerrSection = searchPage.querySelector('.jellyseerr-section');
                if (jellyseerrSection) {
                    // Create placeholder to remember original position
                    jellyseerrOriginalPosition = document.createElement('div');
                    jellyseerrOriginalPosition.id = 'jellyseerr-placeholder';
                    jellyseerrSection.parentNode.insertBefore(jellyseerrOriginalPosition, jellyseerrSection);

                    // Move to top of search results
                    const searchResults = searchPage.querySelector('.searchResults, [class*="searchResults"], .padded-top.padded-bottom-page');
                    if (searchResults) {
                        searchResults.insertBefore(jellyseerrSection, searchResults.firstChild);
                    }
                }

                // Hide "no results" message if present
                const noResultsMessage = searchPage.querySelector('.noItemsMessage');
                if (noResultsMessage) {
                    noResultsMessage.classList.add('section-hidden');
                }

                JE.toast(JE.t('jellyseerr_toast_filter_on'), 3000);
                console.log(`${logPrefix} Switched to Jellyseerr-only mode`);

            } else {
                // DISABLE FILTER MODE: Restore all sections
                hiddenSections.forEach(section => {
                    section.classList.remove('section-hidden');
                });

                // Move Jellyseerr section back to original position
                const jellyseerrSection = searchPage.querySelector('.jellyseerr-section');
                if (jellyseerrSection && jellyseerrOriginalPosition && jellyseerrOriginalPosition.parentNode) {
                    jellyseerrOriginalPosition.parentNode.insertBefore(jellyseerrSection, jellyseerrOriginalPosition);
                    jellyseerrOriginalPosition.remove();
                    jellyseerrOriginalPosition = null;
                }

                // Restore "no results" message
                const noResultsMessage = searchPage.querySelector('.noItemsMessage');
                if (noResultsMessage) {
                    noResultsMessage.classList.remove('section-hidden');
                }

                hiddenSections = [];
                JE.toast(JE.t('jellyseerr_toast_filter_off'), 3000);
                console.log(`${logPrefix} Switched back to all results mode`);
            }

            // Update section title to reflect current mode
            const jellyseerrSection = searchPage.querySelector('.jellyseerr-section');
            if (jellyseerrSection) {
                const titleElement = jellyseerrSection.querySelector('.sectionTitle');
                if (titleElement) {
                    titleElement.textContent = isJellyseerrOnlyMode ? JE.t('jellyseerr_results_title') : JE.t('jellyseerr_discover_title');
                }
            }

            updateJellyseerrIcon();
        }

        // ================================
        // UI MANAGEMENT FUNCTIONS
        // ================================

        /**
         * Updates the Jellyseerr icon in the search field based on current state
         */
        function updateJellyseerrIcon() {
            // Find appropriate container for the icon
            const anchor = document.querySelector('.searchFields .inputContainer') ||
                document.querySelector('#searchPage .searchFields') ||
                document.querySelector('#searchPage');
            if (!anchor) return;

            let icon = document.getElementById('jellyseerr-search-icon');
            if (!icon) {
                // Create icon element
                icon = document.createElement('img');
                icon.id = 'jellyseerr-search-icon';
                icon.className = 'jellyseerr-icon';
                icon.src = 'https://cdn.jsdelivr.net/gh/selfhst/icons/svg/jellyseerr.svg';
                icon.alt = 'Jellyseerr';

                // Double-click/tap detection for filter mode toggle
                let tapCount = 0;
                let tapTimer = null;

                const handleIconInteraction = () => {
                    if (!isJellyseerrActive || !jellyseerrUserFound) return;

                    tapCount++;
                    if (tapCount === 1) {
                        tapTimer = setTimeout(() => {
                            tapCount = 0;
                        }, 300);
                    } else if (tapCount === 2) {
                        clearTimeout(tapTimer);
                        tapCount = 0;
                        toggleJellyseerrOnlyMode();
                    }
                };

                // Event listeners for interaction
                icon.addEventListener('click', handleIconInteraction);
                icon.addEventListener('touchend', (e) => {
                    e.preventDefault();
                    handleIconInteraction();
                }, { passive: false });

                // Keyboard accessibility
                icon.setAttribute('tabindex', '0');
                icon.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        if (!isJellyseerrActive || !jellyseerrUserFound) return;
                        toggleJellyseerrOnlyMode();
                    }
                });

                anchor.appendChild(icon);
            }

            // Reset all state classes
            icon.classList.remove('is-active', 'is-disabled', 'is-no-user', 'is-filter-active');

            // Apply appropriate state class and tooltip
            if (isJellyseerrActive && jellyseerrUserFound) {
                icon.title = JE.t(isJellyseerrOnlyMode ?
                    'jellyseerr_icon_active_filter_tooltip' :
                    'jellyseerr_icon_active_tooltip');
                icon.classList.add('is-active');
                if (isJellyseerrOnlyMode) {
                    icon.classList.add('is-filter-active');
                }
            } else if (isJellyseerrActive && !jellyseerrUserFound) {
                icon.title = JE.t('jellyseerr_icon_no_user_tooltip');
                icon.classList.add('is-no-user');
            } else {
                icon.title = JE.t('jellyseerr_icon_disabled_tooltip');
                icon.classList.add('is-disabled');
            }
        }

        /**
         * Sets up DOM observation for search page changes
         */
        function initializePageObserver() {
            const observer = new MutationObserver(() => {
                updateJellyseerrIcon();

                const isSearchPage = window.location.hash.includes('/search.html');
                const currentQuery = isSearchPage ? new URLSearchParams(window.location.hash.split('?')[1])?.get('query') : null;

                if (isSearchPage && currentQuery && currentQuery.trim() !== '') {
                    // Debounce search requests
                    clearTimeout(debounceTimeout);
                    debounceTimeout = setTimeout(() => {
                        if (!isJellyseerrActive) {
                            // Clean up if Jellyseerr is offline
                            document.querySelectorAll('.jellyseerr-section').forEach(element => element.remove());
                            return;
                        }

                        const latestQuery = new URLSearchParams(window.location.hash.split('?')[1])?.get('query');
                        if (latestQuery === lastProcessedQuery) return; // Avoid duplicate requests

                        // Reset filter mode on new search
                        if (isJellyseerrOnlyMode) {
                            console.log(`${logPrefix} New search detected, resetting filter mode.`);
                            isJellyseerrOnlyMode = false;
                            hiddenSections = [];
                            jellyseerrOriginalPosition = null;
                            updateJellyseerrIcon();
                        }

                        lastProcessedQuery = latestQuery;
                        document.querySelectorAll('.jellyseerr-section').forEach(element => element.remove());
                        fetchJellyseerrSearchResults(latestQuery);
                    }, 1000);
                } else {
                    // Clean up when leaving search page or clearing query
                    clearTimeout(debounceTimeout);
                    lastProcessedQuery = null;
                    isJellyseerrOnlyMode = false; // Reset filter mode
                    document.querySelectorAll('.jellyseerr-section').forEach(element => element.remove());
                }
            });

            observer.observe(document.body, {
                childList: true,
                subtree: true
            });
        }

        // ================================
        // RESULT RENDERING FUNCTIONS
        // ================================

        /**
         * Renders Jellyseerr search results into the search page
         * @param {HTMLElement} sectionToInject - Section element containing results
         * @param {string} query - Search query that generated these results
         */
        function renderJellyseerrResults(sectionToInject, query) {
            console.log(`${logPrefix} Rendering results for query: "${query}"`);

            const searchPage = document.querySelector('#searchPage');
            if (!searchPage) {
                console.warn(`${logPrefix} #searchPage not found. Cannot render results.`);
                return;
            }

            // Remove any existing Jellyseerr section
            const oldSection = searchPage.querySelector('.jellyseerr-section');
            if (oldSection) {
                console.log(`${logPrefix} Removing previous Jellyseerr section`);
                oldSection.remove();
            }

            // Ensure section has proper class for identification
            if (!sectionToInject.classList.contains('jellyseerr-section')) {
                sectionToInject.classList.add('jellyseerr-section');
            }

            // Define section types for intelligent placement
            const primaryTypes = ['movies','filme','filmer','film','film','film','películas','映画','电影','filmes','фильмы','أفلام','shows','shows','program','spettacoli','émissions','shows','series','ショー','节目','programas','сериалы','عروض','episodes','episoden','avsnitt','episodi','épisodes','episoder','episodios','エピソード','集','episódios','эпизоды','الحلقات'];
            const secondaryTypes = ['people','personen','personer','persone','personnes','folk','personas','人々','人','pessoas','люди','الناس','artists','künstler','konstnärer','artisti','artistes','kunstnere','artistas','アーティスト','艺术家','artistas','артисты','فنانون','albums','alben','album','album','albums','albums','álbumes','アルバム','专辑','álbuns','альбомы','ألبومات','songs','lieder','låtar','canzoni','chansons','sange','canciones','曲','歌曲','canções','песни','أغاني','videos','videos','videor','video','vidéos','videoer','videos','ビデオ','视频','vídeos','видео','فيديو','collections','sammlungen','samlingar','collezioni','collections','samlinger','colecciones','コレクション','收藏','coleções','коллекции','مجموعات','playlists','wiedergabelisten','spellistor','playlist','listes de lecture','playlister','listas de reproducción','プレイリスト','播放列表','listas de reprodução','плейлисты','قوائم التشغيل'];


            const allTypes = primaryTypes.concat(secondaryTypes);

            let attempts = 0;
            const maxAttempts = 75; // ~15 seconds at 200ms intervals

            console.log(`${logPrefix} Waiting for Jellyfin content to load...`);

            // Wait for Jellyfin content to load before injecting
            const injectionInterval = setInterval(() => {
                attempts++;

                const noResultsMessage = searchPage.querySelector('.noItemsMessage');
                const sections = Array.from(searchPage.querySelectorAll('.verticalSection'));
                const hasTypedSection = sections.some(section => {
                    const title = section.querySelector('.sectionTitle')?.textContent.trim().toLowerCase() || '';
                    return allTypes.some(type => title.includes(type));
                });

                // Continue waiting unless we have content or timeout
                if (!(hasTypedSection || noResultsMessage) && attempts < maxAttempts) {
                    return; // Keep waiting
                }

                clearInterval(injectionInterval);
                console.log(`${logPrefix} Proceeding with injection (Reason: ${noResultsMessage ? 'No Items Message' : hasTypedSection ? 'Typed Section Found' : 'Timeout'})`);

                // CASE 1: No results from Jellyfin
                if (noResultsMessage) {
                    console.log(`${logPrefix} No Jellyfin results found, injecting after no-results message.`);
                    noResultsMessage.textContent = JE.t('jellyseerr_no_results_jellyfin', { query });
                    noResultsMessage.parentElement.insertBefore(sectionToInject, noResultsMessage.nextSibling);
                    return;
                }

                // CASE 2: Jellyfin has results - use intelligent placement
                const allSections = Array.from(searchPage.querySelectorAll('.verticalSection:not(.jellyseerr-section)'));

                // Find last primary section (movies, shows, etc.)
                let lastPrimarySection = null;
                for (let i = allSections.length - 1; i >= 0; i--) {
                    const title = allSections[i].querySelector('.sectionTitle')?.textContent.trim().toLowerCase() || '';
                    if (primaryTypes.some(type => title.includes(type))) {
                        lastPrimarySection = allSections[i];
                        break;
                    }
                }

                if (lastPrimarySection) {
                    console.log(`${logPrefix} Injecting after last primary section.`);
                    lastPrimarySection.parentElement.insertBefore(sectionToInject, lastPrimarySection.nextSibling);
                    return;
                }

                // Find first secondary section
                const firstSecondarySection = allSections.find(section => {
                    const title = section.querySelector('.sectionTitle')?.textContent.trim().toLowerCase() || '';
                    return secondaryTypes.some(type => title.includes(type));
                });

                if (firstSecondarySection) {
                    console.log(`${logPrefix} No primary sections found. Injecting before first secondary section.`);
                    firstSecondarySection.parentElement.insertBefore(sectionToInject, firstSecondarySection);
                    return;
                }

                // FALLBACK: Append to results container
                console.warn(`${logPrefix} No suitable injection point found. Using fallback method.`);
                const resultsContainer = searchPage.querySelector('.searchResults, [class*="searchResults"], .padded-top.padded-bottom-page');
                if (resultsContainer) {
                    resultsContainer.appendChild(sectionToInject);
                } else {
                    searchPage.appendChild(sectionToInject);
                }
            }, 200);
        }

        /**
         * Creates the main Jellyseerr results section
         * @param {boolean} isLoading - Whether to show loading state
         * @param {Array} results - Array of search result items
         * @returns {HTMLElement} - Section element
         */
        function createJellyseerrSection(isLoading, results = []) {
            const section = document.createElement('div');
            section.className = 'verticalSection emby-scroller-container jellyseerr-section';
            section.setAttribute('data-jellyseerr-section', 'true');

            // Section title with optional loading spinner
            const title = document.createElement('h2');
            title.className = 'sectionTitle sectionTitle-cards focuscontainer-x padded-left padded-right';
            title.textContent = isJellyseerrOnlyMode ? JE.t('jellyseerr_results_title') : JE.t('jellyseerr_discover_title');

            if (isLoading) {
                const spinner = document.createElement('div');
                spinner.className = 'jellyseerr-loading-spinner';
                title.appendChild(spinner);
            }
            section.appendChild(title);

            // Horizontal scroller container
            const scrollerContainer = document.createElement('div');
            scrollerContainer.setAttribute('is', 'emby-scroller');
            scrollerContainer.className = 'padded-top-focusscale padded-bottom-focusscale emby-scroller';
            scrollerContainer.dataset.horizontal = "true";
            scrollerContainer.dataset.centerfocus = "card";

            // Items container
            const itemsContainer = document.createElement('div');
            itemsContainer.setAttribute('is', 'emby-itemscontainer');
            itemsContainer.className = 'focuscontainer-x itemsContainer scrollSlider';

            // Add result cards if not loading
            if (!isLoading) {
                results.forEach(item => {
                    const card = createJellyseerrCard(item);
                    itemsContainer.appendChild(card);
                });
            }

            scrollerContainer.appendChild(itemsContainer);
            section.appendChild(scrollerContainer);
            return section;
        }

        /**
         * Creates an individual Jellyseerr result card
         * @param {Object} item - Search result item from Jellyseerr API
         * @returns {HTMLElement} - Card element
         */
        function createJellyseerrCard(item) {
            // Extract metadata
            const year = item.releaseDate?.substring(0, 4) || item.firstAirDate?.substring(0, 4) || 'N/A';
            const posterUrl = item.posterPath ?
                `https://image.tmdb.org/t/p/w400${item.posterPath}` :
                'https://i.ibb.co/fdbkXQdP/jellyseerr-poster-not-found.png';
            const rating = item.voteAverage ? item.voteAverage.toFixed(1) : 'N/A';
            const titleText = item.title || item.name;
            const tmdbUrl = `https://www.themoviedb.org/${item.mediaType}/${item.id}`;

            // Create card element
            const card = document.createElement('div');
            card.className = 'card overflowPortraitCard card-hoverable card-withuserdata jellyseerr-card';

            card.innerHTML = `
                <div class="cardBox cardBox-bottompadded">
                    <div class="cardScalable">
                        <div class="cardPadder cardPadder-overflowPortrait"></div>
                        <div class="cardImageContainer coveredImage cardContent itemAction" style="background-image: url('${posterUrl}');">
                            <img src="https://cdn.jsdelivr.net/gh/selfhst/icons/svg/jellyseerr.svg" class="jellyseerr-icon-on-card" alt="Jellyseerr"/>
                            <div class="cardIndicators"></div>
                        </div>
                        <div class="cardOverlayContainer" data-action="link"></div>
                        <div class="jellyseerr-overview">
                            <div class="content">${((item.overview || 'No info available.').slice(0, 500))}…</div>
                        </div>
                    </div>
                    <div class="cardText cardTextCentered cardText-first">
                        <a is="emby-linkbutton" href="${tmdbUrl}" target="_blank" rel="noopener noreferrer" title="View on TMDB">
                            <bdi>${titleText}</bdi>
                        </a>
                    </div>
                    <div class="cardText cardTextCentered cardText-secondary jellyseerr-meta">
                        <bdi>${year}</bdi>
                        <div class="jellyseerr-rating">
                            ${icons.star}
                            <span>${rating}</span>
                        </div>
                    </div>
                    <div class="cardFooter" style="padding: 0.5em 1em 1em;">
                        <button is="emby-button" type="button" class="jellyseerr-request-button emby-button" data-tmdb-id="${item.id}" data-media-type="${item.mediaType}"></button>
                    </div>
                </div>
            `;

            // Add touch support for card overview
            const imageContainer = card.querySelector('.cardImageContainer');
            if (imageContainer) {
                imageContainer.addEventListener('touchend', (e) => {
                    e.preventDefault();
                    card.classList.toggle('is-touch');
                }, { passive: false });

                // Keyboard accessibility
                imageContainer.setAttribute('tabindex', '0');
                imageContainer.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        card.classList.toggle('is-touch');
                    }
                });
            }

            // Configure request button based on status and media type
            const button = card.querySelector('.jellyseerr-request-button');
            configureRequestButton(button, item);

            // Add media type badge
            addMediaTypeBadge(card, item);

            return card;
        }

        /**
         * Configures the request button based on item status and type
         * @param {HTMLElement} button - Button element to configure
         * @param {Object} item - Media item data
         */
        function configureRequestButton(button, item) {
            // Check system status first
            if (!isJellyseerrActive) {
                button.innerHTML = `<span>${JE.t('jellyseerr_btn_offline')}</span>${icons.cloud_off}`;
                button.disabled = true;
                button.classList.add('jellyseerr-button-offline');
                return;
            }
            if (!jellyseerrUserFound) {
                button.innerHTML = `<span>${JE.t('jellyseerr_btn_user_not_found')}</span>${icons.person_off}`;
                button.disabled = true;
                button.classList.add('jellyseerr-button-no-user');
                return;
            }

            // Handle TV shows with enhanced season logic
            if (item.mediaType === 'tv') {
                button.dataset.searchResultItem = JSON.stringify(item);
                button.classList.add('jellyseerr-button-tv');
                if (item.mediaInfo) {
                    button.dataset.mediaInfo = JSON.stringify(item.mediaInfo);
                }

                // Analyze season statuses for more accurate display
                let seasonAnalysis = null;
                if (item.mediaInfo && item.mediaInfo.seasons) {
                    seasonAnalysis = analyzeSeasonStatuses(item.mediaInfo.seasons);
                }

                const overallStatus = seasonAnalysis ?
                    seasonAnalysis.overallStatus :
                    (item.mediaInfo ? item.mediaInfo.status : 1);

                configureTvShowButton(button, overallStatus, seasonAnalysis, item);
            } else {
                // Handle movies with existing logic
                configureMovieButton(button, item);
            }
        }

        /**
         * Configures button for TV shows based on season analysis
         * @param {HTMLElement} button - Button element
         * @param {number} overallStatus - Calculated overall status
         * @param {Object} seasonAnalysis - Season analysis results
         * @param {Object} item - TV show item data
         */
        function configureTvShowButton(button, overallStatus, seasonAnalysis, item) {
            const titleText = item.title || item.name;

            switch (overallStatus) {
                case 2: // Pending Approval
                    button.innerHTML = `<span>${JE.t('jellyseerr_btn_pending')}</span>${icons.pending}`;
                    if (seasonAnalysis?.statusSummary) {
                        button.innerHTML += `<div class="jellyseerr-season-summary">${seasonAnalysis.statusSummary}</div>`;
                    }
                    button.disabled = false;
                    button.classList.add('button-submit', 'jellyseerr-button-pending');
                    break;

                case 3: // Partially Requested
                    button.innerHTML = `${icons.request}<span>${JE.t('jellyseerr_btn_request_more')}</span>`;
                    if (seasonAnalysis?.statusSummary) {
                        button.innerHTML += `<div class="jellyseerr-season-summary">${seasonAnalysis.statusSummary}</div>`;
                    }
                    button.disabled = false;
                    button.classList.add('button-submit', 'jellyseerr-button-request');
                    break;

                case 7: // Fully Requested / Accounted For
                    button.innerHTML = `<span>${JE.t('jellyseerr_btn_view_status')}</span>${icons.requested}`;
                    if (seasonAnalysis?.statusSummary) {
                        button.innerHTML += `<div class="jellyseerr-season-summary">${seasonAnalysis.statusSummary}</div>`;
                    }
                    button.disabled = false;
                    button.classList.add('button-submit', 'jellyseerr-button-pending');
                    break;

                case 4: // Partially Available
                    button.innerHTML = `${icons.request}<span>${JE.t('jellyseerr_btn_request_missing')}</span>`;
                    if (seasonAnalysis?.statusSummary) {
                        button.innerHTML += `<div class="jellyseerr-season-summary">${seasonAnalysis.statusSummary}</div>`;
                    }
                    button.disabled = false;
                    button.classList.add('button-submit', 'jellyseerr-button-partially-available');
                    break;

                case 5: // Fully Available
                    button.innerHTML = `<span>${JE.t('jellyseerr_btn_available')}</span>${icons.available}`;
                    if (seasonAnalysis?.total > 1) {
                        button.innerHTML += `<div class="jellyseerr-season-summary">All ${seasonAnalysis.total} seasons</div>`;
                    }
                    button.disabled = true;
                    button.classList.add('button-submit', 'jellyseerr-button-available');
                    break;

                case 6: // Rejected
                    button.innerHTML = `<span>${JE.t('jellyseerr_btn_rejected')}</span>${icons.cancel}`;
                    button.disabled = true;
                    button.classList.add('button-submit', 'jellyseerr-button-rejected');
                    break;

                default: // Not Requested (status 1)
                    button.innerHTML = `${icons.request}<span>${JE.t('jellyseerr_btn_request')}</span>`;
                    if (seasonAnalysis?.total > 1) {
                        button.innerHTML += `<div class="jellyseerr-season-summary">${seasonAnalysis.total} seasons available</div>`;
                    }
                    button.disabled = false;
                    button.classList.add('button-submit', 'jellyseerr-button-request');
                    break;
            }
        }

        /**
         * Configures button for movies
         * @param {HTMLElement} button - Button element
         * @param {Object} item - Movie item data
         */
        function configureMovieButton(button, item) {
            const status = item.mediaInfo ? item.mediaInfo.status : 1;

            switch (status) {
                case 2: // Pending Approval
                    button.innerHTML = `<span>${JE.t('jellyseerr_btn_pending')}</span>${icons.pending}`;
                    button.disabled = true;
                    button.classList.add('button-submit', 'jellyseerr-button-pending');
                    break;

                case 3: // Processing/Requested
                    if (item.mediaInfo?.downloadStatus?.length > 0 || item.mediaInfo?.downloadStatus4k?.length > 0) {
                        // Show processing with download progress capability
                        button.innerHTML = `<span>${JE.t('jellyseerr_btn_processing')}</span><span class="jellyseerr-button-spinner"></span>`;
                        button.disabled = true;
                        button.classList.add('button-submit', 'jellyseerr-button-processing');

                        // Add hover popover for download progress
                        addDownloadProgressHover(button, item);
                    } else {
                        // Just requested, no download data yet
                        button.innerHTML = `<span>${JE.t('jellyseerr_btn_requested')}</span>${icons.requested}`;
                        button.disabled = true;
                        button.classList.add('button-submit', 'jellyseerr-button-pending');
                    }
                    break;

                case 4: // Partially Available
                    button.innerHTML = `<span>${JE.t('jellyseerr_btn_partially_available')}</span>${icons.partially_available}`;
                    button.disabled = true;
                    button.classList.add('button-submit', 'jellyseerr-button-partially-available');
                    break;

                case 5: // Available
                    button.innerHTML = `<span>${JE.t('jellyseerr_btn_available')}</span>${icons.available}`;
                    button.disabled = true;
                    button.classList.add('button-submit', 'jellyseerr-button-available');
                    break;

                case 6: // Rejected
                    button.innerHTML = `<span>${JE.t('jellyseerr_btn_rejected')}</span>${icons.cancel}`;
                    button.disabled = true;
                    button.classList.add('button-submit', 'jellyseerr-button-rejected');
                    break;

                default: // Not Requested
                    button.innerHTML = `${icons.request}<span>${JE.t('jellyseerr_btn_request')}</span>`;
                    button.disabled = false;
                    button.classList.add('button-submit', 'jellyseerr-button-request');
                    break;
            }
        }

        /**
         * Adds download progress hover functionality to a button
         * @param {HTMLElement} button - Button element
         * @param {Object} item - Media item with download status
         */
        function addDownloadProgressHover(button, item) {
            // Desktop hover events
            button.addEventListener('mouseenter', (e) => {
                const popover = fillHoverPopover(item);
                if (!popover) return;
                positionHoverPopover(popover, e.clientX, e.clientY);
                popover.classList.add('show');
            });

            button.addEventListener('mousemove', (e) => {
                if (jellyseerrHoverPopover && jellyseerrHoverPopover.classList.contains('show') && !jellyseerrHoverLock) {
                    positionHoverPopover(jellyseerrHoverPopover, e.clientX, e.clientY);
                }
            });

            button.addEventListener('mouseleave', hideHoverPopover);

            // Keyboard focus events
            button.addEventListener('focus', () => {
                const popover = fillHoverPopover(item);
                if (!popover) return;
                const rect = button.getBoundingClientRect();
                positionHoverPopover(popover, rect.right, rect.top - 8);
                popover.classList.add('show');
            });

            button.addEventListener('blur', () => {
                jellyseerrHoverLock = false;
                hideHoverPopover();
            });

            // Mobile touch events (tap to toggle)
            button.addEventListener('touchstart', (e) => {
                e.preventDefault();
                const popover = fillHoverPopover(item);
                if (!popover) return;

                const rect = button.getBoundingClientRect();
                jellyseerrHoverLock = !jellyseerrHoverLock; // Toggle lock

                if (jellyseerrHoverLock) {
                    positionHoverPopover(popover, rect.left + rect.width / 2, rect.top - 8);
                    popover.classList.add('show');
                } else {
                    popover.classList.remove('show');
                }
            }, { passive: false });
        }

        /**
         * Adds media type badge to card
         * @param {HTMLElement} card - Card element
         * @param {Object} item - Media item data
         */
        function addMediaTypeBadge(card, item) {
            if (item.mediaType === 'movie' || item.mediaType === 'tv') {
                const imageContainer = card.querySelector('.cardImageContainer');
                if (imageContainer) {
                    const badge = document.createElement('div');
                    badge.classList.add('jellyseerr-media-badge');
                    if (item.mediaType === 'movie') {
                        badge.classList.add('jellyseerr-media-badge-movie');
                        badge.textContent = JE.t('jellyseerr_card_badge_movie');
                    } else {
                        badge.classList.add('jellyseerr-media-badge-series');
                        badge.textContent = JE.t('jellyseerr_card_badge_series');
                    }
                    imageContainer.appendChild(badge);
                }
            }
        }

        // ================================
        // SEASON SELECTION MODAL
        // ================================

        /**
         * Shows the enhanced season selection modal for TV shows
         * @param {number} tmdbId - TMDB ID of the TV show
         * @param {string} mediaType - Should be 'tv'
         * @param {string} showTitle - Display title of the show
         * @param {Object} searchResultItem - Original search result data (optional)
         */
        async function showSeasonSelectionModal(tmdbId, mediaType, showTitle, searchResultItem = null) {
            if (mediaType !== 'tv') return;

            // Fetch detailed TV show information
            const tvDetails = await fetchTvShowDetails(tmdbId);
            if (!tvDetails || !tvDetails.seasons) {
                JE.toast(JE.t('jellyseerr_toast_no_season_info'), 4000);
                return;
            }

            // Create season status mapping from API data
            const seasonStatusMap = {};

            // Layer 1: Get base availability from the main seasons array.
            // This tells us if a season is already on Jellyfin (status 5) or not (status 1).
            if (tvDetails.mediaInfo && tvDetails.mediaInfo.seasons) {
                tvDetails.mediaInfo.seasons.forEach(season => {
                    seasonStatusMap[season.seasonNumber] = season.status;
                });
            }

            // Layer 2: Override with more specific statuses from active requests.
            // This is crucial for states like "Pending," "Approved/Downloading" (status 2), etc.
            if (tvDetails.mediaInfo && tvDetails.mediaInfo.requests) {
                tvDetails.mediaInfo.requests.forEach(request => {
                    if (request.seasons) {
                        request.seasons.forEach(seasonRequest => {
                            seasonStatusMap[seasonRequest.seasonNumber] = seasonRequest.status;
                        });
                    }
                });
            }

            // Create modal structure
            const modal = document.createElement('div');
            modal.className = 'jellyseerr-season-modal';
            const backdropImage = tvDetails.backdropPath ?
                `url('https://image.tmdb.org/t/p/w1280${tvDetails.backdropPath}')` :
                'linear-gradient(45deg, #3b82f6, #8b5cf6)';

            modal.innerHTML = `
                <div class="jellyseerr-season-content">
                    <div class="jellyseerr-season-header" style="background: ${backdropImage}; background-size: cover; background-position: center;">
                        <div class="jellyseerr-season-title">${JE.t('jellyseerr_modal_title')}</div>
                        <div class="jellyseerr-season-subtitle">${showTitle}</div>
                    </div>
                    <div class="jellyseerr-season-body">
                          <div class="jellyseerr-season-list"></div>
                    </div>
                    <div class="jellyseerr-modal-footer">
                        <button class="jellyseerr-modal-button jellyseerr-modal-button-secondary">${JE.t('jellyseerr_modal_cancel')}</button>
                        <button class="jellyseerr-modal-button jellyseerr-modal-button-primary">${JE.t('jellyseerr_modal_request')}</button>
                    </div>
                </div>
            `;

            // Populate season list
            const seasonList = modal.querySelector('.jellyseerr-season-list');
            const regularSeasons = tvDetails.seasons.filter(season => season.seasonNumber > 0);

            regularSeasons.forEach(season => {
                const apiStatus = seasonStatusMap[season.seasonNumber];
                // A season can be requested if its status is 1 (Not Available/Requested) or undefined.
                const canRequest = !apiStatus || apiStatus === 1;

                const seasonItem = document.createElement('div');
                seasonItem.className = `jellyseerr-season-item ${canRequest ? '' : 'disabled'}`;

                // Determine status display
                let statusText = JE.t('jellyseerr_season_status_not_requested');
                let statusClass = 'not-requested';

                // This switch now correctly handles statuses from the `mediaInfo.seasons` array
                switch (apiStatus) {
                    case 1: // Not Available / Not Requested
                        statusText = JE.t('jellyseerr_season_status_not_requested');
                        statusClass = 'not-requested';
                        break;
                    case 2: // These statuses are from the request system, showing progress
                    case 3:
                        statusText = JE.t('jellyseerr_season_status_requested');
                        statusClass = 'processing';
                        break;
                    case 4:
                        statusText = JE.t('jellyseerr_season_status_partial');
                        statusClass = 'partially-available';
                        break;
                    case 5:
                        statusText = JE.t('jellyseerr_season_status_available');
                        statusClass = 'available';
                        break;
                }
                const hasActiveDownload = (apiStatus === 2 || apiStatus === 3) &&
                    tvDetails.mediaInfo?.downloadStatus?.some(ds =>
                        ds.episode && ds.episode.seasonNumber === season.seasonNumber
                    );

                if (hasActiveDownload) {
                    statusText = JE.t('jellyseerr_season_status_processing');
                }

                seasonItem.innerHTML = `
                    <input type="checkbox" class="jellyseerr-season-checkbox"
                           data-season-number="${season.seasonNumber}" ${canRequest ? '' : 'disabled'}>
                    <div class="jellyseerr-season-info">
                        <div class="jellyseerr-season-name">${season.name || `Season ${season.seasonNumber}`}</div>
                        <div class="jellyseerr-season-meta">${season.airDate ? season.airDate.substring(0, 4) : ''}</div>
                    </div>
                    <div class="jellyseerr-season-episodes">${season.episodeCount || 0} ep</div>
                    <div class="jellyseerr-season-status jellyseerr-season-status-${statusClass}">${statusText}</div>
                `;

                // Add inline download progress if season is processing and has download data
                if ((apiStatus === 2 || apiStatus === 3) && tvDetails.mediaInfo?.downloadStatus?.length > 0) {
                    // Filter all downloads for the current season
                    const seasonDownloads = tvDetails.mediaInfo.downloadStatus.filter(ds =>
                        ds.episode && ds.episode.seasonNumber === season.seasonNumber
                    );

                    if (seasonDownloads.length > 0) {
                        // Aggregate the progress from all downloading episodes in the season
                        const totalSize = seasonDownloads.reduce((sum, ds) => sum + (ds.size || 0), 0);
                        const totalSizeLeft = seasonDownloads.reduce((sum, ds) => sum + (ds.sizeLeft || 0), 0);

                        if (totalSize > 0) {
                            const aggregatedStatus = {
                                size: totalSize,
                                sizeLeft: totalSizeLeft,
                                status: `${seasonDownloads.length} episode(s) downloading`
                            };
                            const progressElement = createInlineProgress(aggregatedStatus);
                            if (progressElement) {
                                seasonItem.appendChild(progressElement);
                            }
                        }
                    }
                }

                seasonList.appendChild(seasonItem);
            });

            // Modal event handlers
            const closeModal = () => {
                window.removeEventListener('popstate', closeModal);
                modal.classList.remove('show');
                document.body.classList.remove('jellyseerr-modal-is-open');
                setTimeout(() => document.body.removeChild(modal), 300);
            };

            // Cancel button
            modal.querySelector('.jellyseerr-modal-button-secondary').addEventListener('click', () => history.back());

            // Close on backdrop click
            modal.addEventListener('click', (e) => {
                if (e.target === modal) closeModal();
            });

            // Request button
            const requestButton = modal.querySelector('.jellyseerr-modal-button-primary');
            requestButton.addEventListener('click', async () => {
                const selectedSeasons = Array.from(seasonList.querySelectorAll('.jellyseerr-season-checkbox:checked'))
                    .map(checkbox => parseInt(checkbox.dataset.seasonNumber));

                if (selectedSeasons.length === 0) {
                    JE.toast(JE.t('jellyseerr_modal_toast_select_season'), 3000);
                    return;
                }

                // Update button to show requesting state
                requestButton.disabled = true;
                requestButton.innerHTML = `${JE.t('jellyseerr_modal_requesting')}<span class="jellyseerr-button-spinner"></span>`;

                try {
                    await requestTvSeasons(tmdbId, selectedSeasons);
                    JE.toast(JE.t('jellyseerr_modal_toast_request_success', { count: selectedSeasons.length, title: showTitle }), 4000);
                    closeModal();

                    // Refresh search results after successful request
                    setTimeout(() => {
                        const currentQuery = new URLSearchParams(window.location.hash.split('?')[1])?.get('query');
                        if (currentQuery) {
                            document.querySelectorAll('.jellyseerr-section').forEach(element => element.remove());
                            fetchJellyseerrSearchResults(currentQuery);
                        }
                    }, 1000);
                } catch (error) {
                    JE.toast(JE.t('jellyseerr_modal_toast_request_fail'), 4000);
                    requestButton.disabled = false;
                    requestButton.textContent = JE.t('jellyseerr_modal_request_selected');
                }
            });

            // Add modal to DOM and show
            document.body.appendChild(modal);
            document.body.classList.add('jellyseerr-modal-is-open');
            history.pushState(null, '', location.href); // Add a state to the history
            window.addEventListener('popstate', closeModal); // Listen for the back action
            setTimeout(() => modal.classList.add('show'), 10);
        }

        // ================================
        // INITIALIZATION SYSTEM
        // ================================

        /**
         * Waits for user session to be available before initializing
         */
        function waitForUserAndInitialize() {
            const startTime = Date.now();
            const timeout = 20000; // Wait up to 20 seconds for user session

            const checkForUser = () => {
                if (ApiClient.getCurrentUserId()) {
                    console.log(`${logPrefix} User session found. Initializing...`);
                    // User session is available, proceed with initialization
                    checkJellyseerrStatus().then(() => {
                        initializePageObserver();
                    });
                } else if (Date.now() - startTime > timeout) {
                    // Timeout reached, initialize in degraded state
                    console.warn(`${logPrefix} Timed out waiting for user session. Features may be limited.`);
                    checkJellyseerrStatus().then(() => {
                        initializePageObserver();
                    });
                } else {
                    // Continue waiting for user session
                    setTimeout(checkForUser, 300);
                }
            };

            checkForUser();
        }

        // ================================
        // MAIN INITIALIZATION
        // ================================

        // Apply all CSS styles
        addMainStyles();
        addSeasonModalStyles();

        // Wait for user session and then initialize
        waitForUserAndInitialize();

        // ================================
        // GLOBAL EVENT LISTENERS
        // ================================

        // Hide popover when touching outside request buttons
        document.addEventListener('touchstart', (e) => {
            if (!e.target.closest('.jellyseerr-request-button')) {
                jellyseerrHoverLock = false;
                hideHoverPopover();
            }
        }, { passive: true });

        // Hide popover on scroll (unless locked for mobile)
        document.addEventListener('scroll', () => {
            if (!jellyseerrHoverLock) hideHoverPopover();
        }, true);

        // Remove touch overlay when touching outside cards
        document.body.addEventListener('touchstart', (e) => {
            if (!e.target.closest('.jellyseerr-card')) {
                document.querySelectorAll('.jellyseerr-card.is-touch').forEach(card =>
                    card.classList.remove('is-touch')
                );
            }
        }, { passive: true });

        // Main click handler for request buttons
        document.body.addEventListener('click', function(event) {
            const button = event.target.closest('.jellyseerr-request-button');
            if (!button || button.disabled) return;

            const mediaType = button.dataset.mediaType;
            const tmdbId = button.dataset.tmdbId;

            if (mediaType === 'movie') {
                // Direct request for movies
                requestMedia(tmdbId, mediaType, button);
            } else if (mediaType === 'tv') {
                // Show season selection modal for TV shows
                const card = button.closest('.jellyseerr-card');
                const titleText = card?.querySelector('.cardText-first bdi')?.textContent || 'this show';

                // Pass original search result item for enhanced status inference
                const searchResultItem = button.dataset.searchResultItem ?
                    JSON.parse(button.dataset.searchResultItem) : null;

                showSeasonSelectionModal(tmdbId, mediaType, titleText, searchResultItem);
            }
        });

        console.log(`${logPrefix} Initialization complete.`);
    };

})(window.JellyfinEnhanced);
