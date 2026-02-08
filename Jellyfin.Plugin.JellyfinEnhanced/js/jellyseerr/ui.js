// /js/jellyseerr/ui.js
(function(JE) {
    'use strict';

    const ui = {};
    const logPrefix = '🪼 Jellyfin Enhanced: Jellyseerr UI:';

    // State variables managed by the main jellyseerr.js, but used by UI functions
    let jellyseerrHoverPopover = null;
    let jellyseerrHoverLock = false;
    let refreshModalInterval = null;
    let active4KPopup = null;


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

    // Keep card buttons in sync when a request is made from other surfaces (e.g., more info modal)
    function markCardRequested(tmdbId, mediaType, is4k = false) {
        const button = document.querySelector(`.jellyseerr-request-button[data-tmdb-id="${tmdbId}"]`);
        if (!button) return;

        const requestedLabel = JE?.t ? JE.t('jellyseerr_btn_requested') : 'Requested';
        const setPending = (target) => {
            target.innerHTML = `${icons.requested}<span>${requestedLabel}</span>`;
            target.classList.remove('jellyseerr-button-request');
            if (!target.classList.contains('jellyseerr-button-pending')) {
                target.classList.add('jellyseerr-button-pending');
            }
            target.disabled = true;
        };

        if (button.classList.contains('jellyseerr-split-main')) {
            setPending(button);
            const arrow = button.parentElement?.querySelector('.jellyseerr-split-arrow');
            if (arrow && is4k) {
                arrow.classList.add('jellyseerr-4k-pending');
                arrow.disabled = true;
            }
        } else {
            setPending(button);
        }

        const card = button.closest('.jellyseerr-card');
        const badge = card?.querySelector('.jellyseerr-status-badge');
        if (badge) {
            badge.innerHTML = icons.requested;
            badge.className = 'jellyseerr-status-badge status-requested';
            badge.style.display = 'flex';
        }
    }

    document.addEventListener('jellyseerr-media-requested', (e) => {
        const { tmdbId, mediaType, is4k } = e.detail || {};
        if (!tmdbId || !mediaType) return;
        markCardRequested(String(tmdbId), mediaType, is4k);
    });

    // ================================
    // DOWNLOAD PROGRESS POPOVER SYSTEM
    // ================================

    /**
     * Creates or returns existing hover popover element.
     * Used for showing download progress on hover/focus.
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
     * Format ETA text for download status.
     * @param {Object} downloadStatus - Download status object with estimatedCompletionTime.
     * @returns {string|null} - Formatted ETA string or null.
     */
    function formatEtaText(downloadStatus) {
        try {
            const rawEta = downloadStatus?.estimatedCompletionTime;
            if (!rawEta) return null;

            const etaTime = new Date(rawEta);
            const now = new Date();
            const timeUntilMs = etaTime.getTime() - now.getTime();
            if (isNaN(timeUntilMs)) return null;
            if (timeUntilMs <= 0) return 'Estimated soon';

            const totalMinutesRemaining = Math.round(timeUntilMs / 60000);
            if (totalMinutesRemaining >= 1440) {
                const daysRemaining = Math.round(totalMinutesRemaining / 1440);
                return `Estimated in ${daysRemaining} day${daysRemaining !== 1 ? 's' : ''}`;
            }
            if (totalMinutesRemaining >= 60) {
                const hoursRemaining = Math.round(totalMinutesRemaining / 60);
                return `Estimated in ${hoursRemaining} hour${hoursRemaining !== 1 ? 's' : ''}`;
            }
            return `Estimated in ${totalMinutesRemaining} min`;
        } catch (_) {
            return null;
        }
    }

    /**
     * Fills popover with download progress information.
     * @param {Object} item - Media item with download status.
     * @returns {HTMLElement|null} - Popover element or null if no download data.
     */
    function fillHoverPopover(item) {

        const allDownloads = [
            ...(item.mediaInfo?.downloadStatus || []),
            ...(item.mediaInfo?.downloadStatus4k || [])
        ];

        if (allDownloads.length === 0) {
            console.debug(`${logPrefix} No download status found`);
            return null;
        }

        const popover = ensureHoverPopover();
        let popoverHTML = '';

        allDownloads.forEach(downloadStatus => {
            const hasValidSizeData = (typeof downloadStatus.size === 'number' &&
                                    typeof downloadStatus.sizeLeft === 'number' &&
                                    downloadStatus.size > 0);

            const isQueued = (downloadStatus.status && downloadStatus.status.toLowerCase() === 'queued');
            const isWarning = (downloadStatus.status && downloadStatus.status.toLowerCase() === 'warning');

            if (!hasValidSizeData && !isQueued && !isWarning) {
                return; // Skip this item
            }

            if (isQueued || downloadStatus.size <= 0) {
                // For queued items, show 0% progress
                popoverHTML += `
                    <div class="jellyseerr-popover-item">
                        <div class="title">${downloadStatus.title || JE.t('jellyseerr_popover_downloading')}</div>
                        <div class="jellyseerr-hover-progress"><div class="bar" style="width:0%;"></div></div>
                        <div class="row">
                            <div>0%</div>
                            <div class="status">Queued</div>
                        </div>
                    </div>`;
            } else {
                // For downloading/warning items, show actual progress
                const percentage = Math.max(0, Math.min(100, Math.round(100 * (1 - downloadStatus.sizeLeft / downloadStatus.size))));
                const statusDisplay = isWarning ? 'Warning' : (downloadStatus.status || 'Downloading').toString().replace(/^./, c => c.toUpperCase());
                const etaText = formatEtaText(downloadStatus);
                popoverHTML += `
                    <div class="jellyseerr-popover-item">
                        <div class="title">${downloadStatus.title || JE.t('jellyseerr_popover_downloading')}</div>
                        <div class="jellyseerr-hover-progress"><div class="bar" style="width:${percentage}%;"></div></div>
                        <div class="row">
                            <div>${percentage}%</div>
                            <div class="status">${statusDisplay}</div>
                            ${etaText ? `<div class="eta">${etaText}</div>` : ''}
                        </div>
                    </div>`;
            }
        });

        popover.innerHTML = popoverHTML;
        console.debug(`${logPrefix} Popover filled for ${allDownloads.length} download item(s)`);
        return popover;
    }

    /**
     * Positions popover to stay within screen bounds.
     * @param {HTMLElement} element - Popover element to position.
     * @param {number} x - Target X coordinate.
     * @param {number} y - Target Y coordinate.
     */
    function positionHoverPopover(element, x, y) {
        const padding = 12;
        const rect = element.getBoundingClientRect();
        let newX = Math.min(Math.max(x + 14, padding), window.innerWidth - rect.width - padding);
        let newY = Math.min(Math.max(y - rect.height - 14, padding), window.innerHeight - rect.height - padding);
        element.style.transform = `translate(${newX}px, ${newY}px)`;
    }

    /**
     * Hides the hover popover (respects mobile lock).
     */
    ui.hideHoverPopover = function() {
        if (jellyseerrHoverPopover && !jellyseerrHoverLock) {
            jellyseerrHoverPopover.classList.remove('show');
            delete jellyseerrHoverPopover.dataset.tmdbId;
            delete jellyseerrHoverPopover.dataset.clientX;
            delete jellyseerrHoverPopover.dataset.clientY;
        }
    };

    /**
     * Toggles the lock state for the hover popover, used for mobile tap interactions.
     * @param {boolean} [lockState] - Optional state to force lock/unlock. Toggles if omitted.
     */
    ui.toggleHoverPopoverLock = function(lockState) {
        jellyseerrHoverLock = typeof lockState === 'boolean' ? lockState : !jellyseerrHoverLock;
    };

    /**
     * Creates inline download progress display for season items.
     * @param {Object} downloadStatus - Download status object.
     * @returns {HTMLElement|null} - Progress element or null.
     */
    function createInlineProgress(downloadStatus) {
        if (!downloadStatus || typeof downloadStatus.size !== 'number' || typeof downloadStatus.sizeLeft !== 'number' || downloadStatus.size <= 0) {
            return null;
        }
        const percentage = Math.max(0, Math.min(100, Math.round(100 * (1 - downloadStatus.sizeLeft / downloadStatus.size))));
        const progressContainer = document.createElement('div');
        progressContainer.className = 'jellyseerr-inline-progress';
        progressContainer.innerHTML = `
            <div class="jellyseerr-inline-progress-bar"><div class="jellyseerr-inline-progress-fill" style="width: ${percentage}%"></div></div>
            <div class="jellyseerr-inline-progress-text">${percentage}% • ${(downloadStatus.status || 'downloading').replace(/^./, c => c.toUpperCase())}</div>`;
        return progressContainer;
    }

    // ================================
    // 4K POPUP MANAGEMENT
    // ================================

    /**
     * Hides any active 4K popup menu.
     */
    function hide4KPopup() {
        if (active4KPopup) {
            active4KPopup.remove();
            active4KPopup = null;
        }
    }

    /**
     * Shows the 4K request popup menu below the button group.
     * @param {HTMLElement} buttonGroup - The split button container.
     * @param {Object} item - Media item data.
     */
    function show4KPopup(buttonGroup, item) {
        hide4KPopup();

        const popup = document.createElement('div');
        popup.className = 'jellyseerr-4k-popup';

        const status4k = item.mediaInfo ? item.mediaInfo.status4k : 1;

        // Create 4K button
        const request4KBtn = document.createElement('button');
        request4KBtn.className = 'jellyseerr-4k-popup-item';

        if (status4k === 5) {
            // 4K is available
            request4KBtn.innerHTML = `<span>4K Available</span>${icons.available}`;
            request4KBtn.disabled = true;
            request4KBtn.classList.add('jellyseerr-4k-available', 'chip-available');
        } else if (status4k === 2 || status4k === 3) {
            // 4K is pending or processing
            request4KBtn.innerHTML = `<span>4K Requested</span>${icons.pending}`;
            request4KBtn.disabled = true;
            request4KBtn.classList.add(status4k === 3 ? 'chip-processing' : 'chip-pending');
        } else {
            // 4K can be requested
            request4KBtn.innerHTML = `<span>${JE.t('jellyseerr_btn_request_4k')}</span>`;
            request4KBtn.dataset.tmdbId = item.id;
            request4KBtn.dataset.action = 'request4k';
            request4KBtn.classList.add('chip-requested');
        }

        popup.appendChild(request4KBtn);
        document.body.appendChild(popup);
        active4KPopup = popup;

        // Position the popup relative to the button group
        const rect = buttonGroup.getBoundingClientRect();
        popup.style.position = 'fixed';
        popup.style.left = `${rect.left}px`;
        popup.style.top = `${rect.bottom + 4}px`;
        popup.style.width = `${rect.width}px`;

        setTimeout(() => {
            popup.classList.add('show');
        }, 10);
    }

    // ================================
    // STYLING SYSTEM
    // ================================

    /**
     * Adds main CSS styles for Jellyseerr integration.
     */
    ui.addMainStyles = function() {
        const styleId = 'jellyseerr-styles';
        if (document.getElementById(styleId)) return;
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = `
            /* LAYOUT & ICONS */
            .jellyseerr-section { margin-bottom: 1em; }
            .jellyseerr-section .itemsContainer { white-space: nowrap; }
            #jellyseerr-search-icon { position: absolute; right: 10px; top: 68%; transform: translateY(-50%); user-select: none; z-index: 10; transition: filter .2s, opacity .2s, transform .2s; }
            .inputContainer { position: relative !important; }
            .jellyseerr-icon { width: 30px; height: 30px; filter: drop-shadow(2px 2px 6px rgba(0,0,0,0.8)); }
            #jellyseerr-search-icon.is-active { filter: drop-shadow(2px 2px 6px rgba(0,0,0,0.8)); opacity: 1; }
            #jellyseerr-search-icon.is-disabled { filter: grayscale(1) opacity(0.4) drop-shadow(2px 2px 6px rgba(0,0,0,0.5)); }
            #jellyseerr-search-icon.is-no-user { filter: drop-shadow(2px 2px 6px rgba(255, 0, 0, 0.8)); }
            #jellyseerr-search-icon.is-filter-active { filter: drop-shadow(2px 2px 6px #3b82f6) brightness(1.2); transform: translateY(-50%) scale(1.1); }
            #jellyseerr-search-icon:hover { transform: translateY(-50%) scale(1.05); transition: transform 0.2s ease; }
            /* CARDS & BADGES */
            .jellyseerr-card { position: relative; }
            .jellyseerr-card .cardScalable { contain: paint; }
            .jellyseerr-icon-on-card { width: 1.2em !important; height: 1.2em !important; filter: drop-shadow(0 1px 2px rgba(0,0,0,0.8)); flex-shrink: 0; }
            .jellyseerr-status-badge { position: absolute; top: 8px; right: 8px; z-index: 100; width: 1.5em; height: 1.5em; border-radius: 50%; display: flex; align-items: center; justify-content: center; border: 1.5px solid rgba(255,255,255,0.3); box-shadow: 0 0 1px rgba(255,255,255,0.4) inset, 0 4px 12px rgba(0,0,0,0.6); }
            .jellyseerr-status-badge svg { width: 1.4em; height: 1.4em; filter: drop-shadow(0 1px 3px rgba(0,0,0,0.6)); }
            .jellyseerr-status-badge.status-available { background-color: rgba(34, 197, 94, 0.7); border-color: rgba(34, 197, 94, 0.3); }
            .jellyseerr-status-badge.status-processing { background-color: rgba(99, 102, 241, 0.7); border-color: rgba(99, 102, 241, 0.3); }
            .jellyseerr-status-badge.status-requested { background-color: rgba(136, 61, 206, 0.7); border-color: rgba(147, 51, 234, 0.3); }
            .jellyseerr-status-badge.status-pending { background-color: rgba(251, 146, 60, 0.7); border-color: rgba(251, 146, 60, 0.3); }
            .jellyseerr-status-badge.status-partially-available { background-color: rgba(34, 197, 94, 0.7); border-color: rgba(34, 197, 94, 0.3); }
            .jellyseerr-status-badge.status-rejected { background-color: rgba(220, 38, 38, 0.7); border-color: rgba(220, 38, 38, 0.3); }
            @keyframes jellyseerr-spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
            .jellyseerr-status-badge.status-processing svg { animation: jellyseerr-spin 1s linear infinite; }
            .jellyseerr-media-badge { position: absolute; top: 8px; left: 8px; z-index: 100; color: #fff; padding: 2px 8px; border-radius: 999px; border: 1px solid rgba(0,0,0,0.2); font-size: 1em; font-weight: 500; text-transform: uppercase; letter-spacing: 1.5px; text-shadow: 1px 1px 3px rgba(0, 0, 0, 0.8); box-shadow: 0 4px 4px -1px rgba(0,0,0,0.1), 0 2px 2px -2px rgba(0,0,0,0.1); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); }
            .layout-mobile .jellyseerr-media-badge { font-size: 0.8em !important; }
            .jellyseerr-media-badge-movie { background-color: rgba(59, 130, 246, .9); box-shadow: 0 0 0 1px rgba(59,130,246,.35), 0 8px 24px rgba(59,130,246,.25); }
            .jellyseerr-media-badge-series { background-color: rgba(243, 51, 214, .9); box-shadow: 0 0 0 1px rgba(236,72,153,.35), 0 8px 24px rgba(236,72,153,.25); }
            .jellyseerr-media-badge-collection { background-color: rgba(16, 185, 129, .9); box-shadow: 0 0 0 1px rgba(16,185,129,.35), 0 8px 24px rgba(16,185,129,.25); }
            .jellyseerr-collection-badge { position: absolute; bottom: 40px; left: 50%; transform: translateX(-50%); z-index: 1000; color: #fff; padding: 6px 16px; border-radius: 999px; border: 1px solid rgba(0,0,0,0.2); font-size: 0.8em; font-weight: 600; display: flex; align-items: center; justify-content: center; gap: 6px; text-transform: none; letter-spacing: .25px; text-shadow: 1px 1px 3px rgba(0, 0, 0, 0.8); background-color: rgba(16, 185, 129, .85); box-shadow: 0 0 0 1px rgba(16,185,129,.35), 0 8px 24px rgba(16,185,129,.25); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); cursor: pointer; transition: all 0.2s ease; max-width: 85%; pointer-events: auto; }
            .cardImageContainer:has(.jellyseerr-elsewhere-icons:not(.has-icons)) .jellyseerr-collection-badge { bottom: 10px; }
            .jellyseerr-collection-badge:hover { transform: translateX(-50%) translateY(-2px); box-shadow: 0 0 0 1px rgba(16,185,129,.5), 0 12px 32px rgba(16,185,129,.35); }
            .jellyseerr-collection-badge .material-icons { font-size: 1.1em; flex-shrink: 0; }
            .jellyseerr-collection-badge span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .jellyseerr-overview { position: absolute; inset: 0; background: linear-gradient(180deg, rgba(0,0,0,0) 30%, rgba(0,0,0,.78) 75%, rgba(0,0,0,.92) 100%); color: #e5e7eb; padding: 12px 12px 14px; line-height: 1.5; opacity: 1; pointer-events: auto; transform: translateY(0); transition: opacity .18s ease, transform .18s ease; overflow: hidden; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; gap: 10px; backdrop-filter: blur(2px); -webkit-backdrop-filter: blur(2px); }
            .jellyseerr-overview .content { width: 100%; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; white-space: normal; }
            /* SHOW OVERVIEW: When card has 'is-touch' class (mobile/click) */
            .jellyseerr-card.is-touch .jellyseerr-overview { opacity: 1; pointer-events: auto; }
            .jellyseerr-card .cardScalable:focus-within .jellyseerr-overview { opacity: 1; pointer-events: auto; }

            /* SHOW OVERVIEW: Desktop Hover (Media Query Handles Desktop vs Touch separation properly) */
            @media (hover: hover) {
                .jellyseerr-card .cardScalable:hover .jellyseerr-overview { opacity: 1; pointer-events: auto; }
            }

            .jellyseerr-overview .title { font-weight: 600; display: block; margin-bottom: .35em; }
            .jellyseerr-elsewhere-icons { display: none; position: absolute; bottom: 0; left:0; right:0; z-index: 3; justify-content: center; gap: 0.6em; pointer-events: none; background: rgba(0,0,0,0.8); border-top-left-radius: 1.5em; border-top-right-radius: 1.5em; padding: 0.5em 0 0.2em 0; }
            .jellyseerr-elsewhere-icons.has-icons {display: flex;}
            .jellyseerr-elsewhere-icons img { width: 1.8em; border-radius: 0.7em; background-color: rgba(255,255,255,0.5); padding: 2px;}
            .jellyseerr-meta { display: flex; justify-content: center; align-items: center; gap: 1em; padding: 0 .75em; }
            .jellyseerr-rating { display: flex; align-items: center; gap: .3em; color: #bdbdbd; }
            .cardText-first > a.jellyseerr-more-info-link { padding: 0 !important; margin: 0 !important; color: inherit; text-decoration: none; }
            /* REQUEST BUTTONS */
            .jellyseerr-request-button { display: flex; justify-content: center; align-items: center; gap: 0.5em; white-space: normal; text-align: center; padding: 0.6em 1.2em; line-height: 1.2; font-size: 0.9em; transition: background .2s, border-color .2s, color .2s, transform .2s; border-radius: 8px; border: none; font-weight: 600; cursor: pointer; position: relative; z-index: 10; }
            .jellyseerr-request-button svg { width: 1.2em; height: 1.2em; flex-shrink: 0; vertical-align: middle; }
            .layout-mobile .jellyseerr-request-button svg { width: 1em; height: 1em; }
            .layout-mobile .jellyseerr-request-button span { font-size: 0.8em !important; }
            .jellyseerr-request-button.jellyseerr-button-offline, .jellyseerr-request-button.jellyseerr-button-no-user { opacity: .6; cursor: not-allowed; }
            .jellyseerr-request-button.jellyseerr-button-request { background-color: #5a3fb8 !important; color: #fff !important; }
            .jellyseerr-request-button.jellyseerr-button-request:hover:not(:disabled) { background-color: #6b4bb5 !important; transform: translateY(-2px); box-shadow: 0 4px 12px rgba(90, 63, 184, 0.4); }
            .jellyseerr-request-button.jellyseerr-button-pending { background-color: #b45309 !important; color: #fff !important; }
            .jellyseerr-request-button.jellyseerr-button-pending:hover:not(:disabled) { background-color: #d97706 !important; transform: translateY(-2px); }
            .jellyseerr-request-button.jellyseerr-button-processing { background-color: #581c87 !important; color: #fff !important; }
            .jellyseerr-request-button.jellyseerr-button-rejected { background-color: #8a1c1c !important; color: #fff !important; }
            .jellyseerr-request-button.jellyseerr-button-partially-available { background-color: #4ca46c !important; color: #fff !important; }
            .jellyseerr-request-button.jellyseerr-button-partially-available:hover:not(:disabled) { background-color: #5bb876 !important; transform: translateY(-2px); }
            .jellyseerr-request-button.jellyseerr-button-available { background-color: #16a34a !important; color: #fff !important; }
            .jellyseerr-request-button.jellyseerr-button-available-updating { background-color: #0d6d30ff !important; color: #fff !important; }
            .jellyseerr-request-button.jellyseerr-button-error { background: #dc3545 !important; color: #fff !important; }
            .jellyseerr-request-button.jellyseerr-button-tv:not(.jellyseerr-button-available):not(.jellyseerr-button-offline):not(.jellyseerr-button-no-user):not(.jellyseerr-button-error)::after { content: '▼'; margin-left: 6px; font-size: 0.7em; opacity: 0.8; }
            .jellyseerr-season-summary { font-size: 0.85em; opacity: 0.9; display: block; margin-top: 2px; }
            /* SPLIT BUTTON FOR 4K */
            /* Allow button group and popup to overflow card footer */
            .jellyseerr-card .cardFooter {
                overflow: visible !important;
            }
            .jellyseerr-card .cardBox { overflow: visible !important; }
            .jellyseerr-section .scrollSlider { overflow: visible !important; }

            /* Library item styling */
            .jellyseerr-card-in-library .cardText-first a {
                color: #00d084;
                font-weight: 500;
            }
            /* SPLIT BUTTON FOR 4K */
            .jellyseerr-button-group {
                display: inline-flex;
                width: auto;
                position: relative;
                gap: 0;
                align-items: stretch;
                border-radius: 8px;
                overflow: hidden;
            }
            .jellyseerr-button-group .jellyseerr-split-main {
                border-top-right-radius: 0px !important;
                border-bottom-right-radius: 0px !important;
                margin: 0 !important;
                flex: 1;
            }
            button.jellyseerr-split-arrow {
                border-top-left-radius: 0px !important;
                border-bottom-left-radius: 0px !important;
                cursor: pointer;
                color: #fff !important;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                transition: background .2s, opacity .2s;
                flex-shrink: 0;
                position: relative;
                z-index: 1;
                margin: 0 !important;
                padding: 0.6em 0.4em !important;
                border-left: 2px solid rgba(0, 0, 0, 0.4);
                border-bottom-width: 0px;
                border-top-width: 0px;
                border-right-width: 0px;
            }
            /* Match arrow button color to main button */
            .jellyseerr-button-group .jellyseerr-button-request ~ .jellyseerr-split-arrow {
                background-color: #5a3fb8 !important;
            }
            .jellyseerr-button-group .jellyseerr-button-pending ~ .jellyseerr-split-arrow {
                background-color: #b45309 !important;
            }
            .jellyseerr-button-group .jellyseerr-button-available ~ .jellyseerr-split-arrow {
                background-color: #16a34a !important;
            }
            .jellyseerr-button-group .jellyseerr-button-available-updating ~ .jellyseerr-split-arrow {
                background-color: #16a34a !important;
            }
            .jellyseerr-button-group .jellyseerr-button-processing ~ .jellyseerr-split-arrow {
                background-color: #581c87 !important;
            }
            .jellyseerr-button-group .jellyseerr-button-rejected ~ .jellyseerr-split-arrow {
                background-color: #8a1c1c !important;
            }
            .jellyseerr-button-group .jellyseerr-button-partially-available ~ .jellyseerr-split-arrow {
                background-color: #4ca46c !important;
            }
            /* Override for 4K specific states */
            .jellyseerr-split-arrow.jellyseerr-4k-available {
                background-color: #16a34a !important;
            }
            .jellyseerr-split-arrow.jellyseerr-4k-pending {
                background-color: #b45309 !important;
            }
            .jellyseerr-split-arrow svg {
                width: 1em;
                height: 1em;
            }
            .jellyseerr-split-arrow:hover:not(:disabled) { opacity: 0.8; }
            .jellyseerr-split-arrow:active:not(:disabled) { opacity: 0.7; }
            .jellyseerr-split-arrow:disabled,
            .jellyseerr-split-arrow.jellyseerr-split-arrow-disabled {
                opacity: 0.5;
                cursor: default;
            }

            /* 4K POPUP MENU */
            .jellyseerr-4k-popup {
                position: absolute;
                top: 100%;
                left: 0;
                right: 0;
                background: rgba(0, 0, 0, 0.5);
                border: 1px solid rgba(148, 163, 184, 0.2);
                border-radius: 8px;
                box-shadow: 0 10px 30px rgba(0,0,0,0.45);
                z-index: 10000;
                opacity: 0;
                pointer-events: none;
                transition: opacity 0.2s ease;
                margin-top: 4px;
                overflow: visible;
            }
            .jellyseerr-4k-popup.show {
                opacity: 1;
                pointer-events: all;
                width: fit-content;
            }
            .jellyseerr-4k-popup-item {
                width: 100%;
                border: none;
                background: transparent;
                color: #f8fafc;
                text-align: left;
                cursor: pointer;
                transition: background 0.2s;
                font-size: 0.95rem;
                display: flex;
                align-items: center;
                justify-content: center;
                border-radius: 8px;
                white-space: nowrap;
                padding: 0.5em 0.75em;
                min-height: 2.5em;
            }
            .jellyseerr-4k-popup-item:not(:disabled):hover {
                background: rgba(59, 130, 246, 0.5);
            }
            .jellyseerr-4k-popup-item:not(:disabled):active {
                background: rgba(59, 130, 246, 0.3);
            }
            .jellyseerr-4k-popup-item:disabled {
                opacity: 0.8;
                cursor: default;
                color: #07e659;
            }
            .jellyseerr-4k-popup-item.jellyseerr-4k-available {
                color: #16a34a;
            }
            /* Status-based popup colors matching button styles */
            .jellyseerr-4k-popup.show { background: #5a3fb8 !important; }
            .jellyseerr-4k-popup.show .jellyseerr-4k-popup-item { color: #fff !important; }
            .jellyseerr-4k-popup-item.chip-requested { background-color: #5a3fb8 !important; color: #fff !important; }
            .jellyseerr-4k-popup-item.chip-pending { background-color: #b45309 !important; color: #fff !important; }
            .jellyseerr-4k-popup-item.chip-processing { background-color: #581c87 !important; color: #fff !important; }
            .jellyseerr-4k-popup-item.chip-available { background-color: #16a34a !important; color: #fff !important; }
            .jellyseerr-4k-popup-item svg {
                flex-shrink: 0;
                width: 18px;
                height: 18px;
            }
            /* SPINNERS & LOADERS */
            .jellyseerr-spinner, .jellyseerr-loading-spinner, .jellyseerr-button-spinner { display: inline-block; border-radius: 50%; animation: jellyseerr-spin 1s linear infinite; }
            .jellyseerr-loading-spinner { width: 20px; height: 20px; border: 3px solid rgba(255,255,255,.3); border-top-color: #fff; margin-left: 10px; vertical-align: middle; }
            .jellyseerr-button-spinner { width: 1em; height: 1em; border: 2px solid currentColor; border-right-color: transparent; margin-left: .5em; flex-shrink: 0; }
            /* HOVER POPOVER STYLES */
            .jellyseerr-hover-popover { position: fixed; min-width: 260px; max-width: 340px; padding: 10px 12px; background: #1f2937; color: #e5e7eb; border-radius: 10px; z-index: 9999; box-shadow: 0 10px 30px rgba(0,0,0,.45), 0 0 0 1px rgba(255,255,252, .06); opacity: 0; pointer-events: none; transition: opacity .12s ease, transform .12s ease; }
            .jellyseerr-hover-popover.show { opacity: 1; }
            .jellyseerr-popover-item { margin-bottom: 10px; }
            .jellyseerr-popover-item:last-child { margin-bottom: 0; }
            .jellyseerr-popover-item:not(:last-child) { padding-bottom: 10px; border-bottom: 1px solid rgba(255,255,255,.08); }
            .jellyseerr-hover-popover .title { font-weight: 600; font-size: .9rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 8px; }
            .jellyseerr-hover-popover .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 6px; }
            .jellyseerr-hover-popover .status { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: .75rem; font-weight: 600; background: #4f46e5; color: #fff; }
            .jellyseerr-hover-popover .jellyseerr-hover-progress { height: 7px; width: 100%; background: rgba(255,255,255,.12); border-radius: 999px; overflow: hidden; }
            .jellyseerr-hover-popover .jellyseerr-hover-progress .bar { height: 100%; background: linear-gradient(90deg, #3b82f6, #8b5cf6); transition: width .2s ease; }
            .jellyseerr-hover-popover .eta { margin-left: auto; font-size: .75rem; color: #cbd5e1; opacity: .9; white-space: nowrap; }
            /* UTILITY CLASSES */
            @keyframes jellyseerr-spin { to { transform: rotate(360deg) } }
            .section-hidden { display: none !important; }
        `;
        document.head.appendChild(style);
    };

    /**
     * Adds enhanced CSS styles for season selection modal.
     */
    ui.addSeasonModalStyles = function() {
        const seasonStyleId = 'jellyseerr-season-styles';
        if (document.getElementById(seasonStyleId)) return;
        const style = document.createElement('style');
        style.id = seasonStyleId;
        style.textContent = `
            /* MODAL STYLES */
            .jellyseerr-season-modal { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 10, 20, 0.85); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); z-index: 10000; display: flex; align-items: center; justify-content: center; opacity: 0; pointer-events: none; transition: opacity 0.3s ease; }
            .jellyseerr-season-modal.show { opacity: 1; pointer-events: all; }
            body.jellyseerr-modal-is-open { overflow: hidden; }
            .jellyseerr-season-content { background: linear-gradient(145deg, #1e293b 0%, #0f172a 100%); border: 1px solid rgba(148, 163, 184, 0.1); border-radius: 16px; padding: 0; max-width: 700px; width: 90%; max-height: 80vh; overflow: hidden; box-shadow: 0 25px 80px rgba(0,0,0,0.8), 0 0 0 1px rgba(148, 163, 184, 0.05), inset 0 1px 0 rgba(148, 163, 184, 0.1); transform: scale(0.95); transition: transform 0.3s ease; display: flex; flex-direction: column; }
            .jellyseerr-season-modal.show .jellyseerr-season-content { transform: scale(1); }
            .jellyseerr-season-header { position: relative; padding: 24px; border-radius: 16px 16px 0 0; overflow: hidden; height: 8em; flex-shrink: 0; }
            .jellyseerr-season-header::before { content: ''; position: absolute; top: 0; left: 0; right: 0; bottom: 0; pointer-events: none; backdrop-filter: blur(2px); background: rgba(0, 0, 0, 0.8); }
            .jellyseerr-season-title { position: relative; font-size: 1.8rem; font-weight: 700; margin-bottom: 6px; background: linear-gradient(45deg, #3b82f6, #8b5cf6); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
            .jellyseerr-season-subtitle { position: relative; font-size: 1.4rem; color: rgba(255,255,255,0.9); font-weight: 500; }
            .jellyseerr-modal-body { padding: 24px; overflow-y: auto; }
            .jellyseerr-advanced-options { margin-top: 1em; padding-top: 1em; border-top: 1px solid rgba(148, 163, 184, 0.1); }
            .jellyseerr-advanced-options h3 { margin-top: 0; }
            .jellyseerr-form-row { display: flex; gap: 1em; margin-bottom: 1em; }
            .jellyseerr-form-group { flex: 1; }
            .jellyseerr-form-group label { display: block; margin-bottom: 0.5em; font-weight: 600; color: #e2e8f0; }
            .jellyseerr-form-group select, .jellyseerr-form-group input, .jellyseerr-form-group textarea { width: 100%; padding: 0.75em 0.875em; border-radius: 6px; border: 1px solid rgba(71, 85, 105, 0.5); background-color: rgba(30, 41, 59, 0.7); color: #e2e8f0; font-size: 0.95rem; transition: border-color 0.2s ease, background-color 0.2s ease; }
            .jellyseerr-form-group select:hover, .jellyseerr-form-group input:hover, .jellyseerr-form-group textarea:hover { border-color: rgba(59, 130, 246, 0.4); background-color: rgba(30, 41, 59, 1); }
            .jellyseerr-form-group select:focus, .jellyseerr-form-group input:focus, .jellyseerr-form-group textarea:focus { outline: none; border-color: rgba(59, 130, 246, 0.8); background-color: rgba(30, 41, 59, 1); box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1); }
            .jellyseerr-form-group textarea { resize: vertical; font-family: inherit; }
            .jellyseerr-form-group select[is="emby-select"] { background-color: rgba(30, 41, 59, 0.7) !important; color: #e2e8f0 !important; border: 1px solid rgba(51, 65, 85, 0.5) !important; border-radius: 8px !important; padding: 12px 16px !important; font-size: 0.95rem !important; -webkit-appearance: none; -moz-appearance: none; appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' fill='%2394a3b8' viewBox='0 0 16 16'%3E%3Cpath fill-rule='evenodd' d='M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708z'/%3E%3C/svg%3E") !important; background-repeat: no-repeat !important; background-position: right 16px center !important; transition: border-color 0.2s ease, background-color 0.2s ease !important; }
            .jellyseerr-form-group select[is="emby-select"]:hover { border-color: rgba(59, 130, 246, 0.4) !important; background-color: rgba(30, 41, 59, 1) !important; }
            .jellyseerr-issue-form { padding: 0; }
            .jellyseerr-issue-select { width: 100%; padding: 0.75em 0.875em; border-radius: 6px; border: 1px solid rgba(71, 85, 105, 0.5); background-color: rgba(30, 41, 59, 0.7); color: #e2e8f0; font-size: 0.95rem; transition: border-color 0.2s ease; }
            .jellyseerr-issue-select:hover { border-color: rgba(59, 130, 246, 0.4); background-color: rgba(30, 41, 59, 1); }
            .jellyseerr-issue-select:focus { outline: none; border-color: rgba(59, 130, 246, 0.8); box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1); }
            .jellyseerr-issue-textarea { width: 100%; padding: 0.75em 0.875em; border-radius: 6px; border: 1px solid rgba(71, 85, 105, 0.5); background-color: rgba(30, 41, 59, 0.7); color: #e2e8f0; font-size: 0.95rem; font-family: inherit; resize: vertical; transition: border-color 0.2s ease; }
            .jellyseerr-issue-textarea:hover { border-color: rgba(59, 130, 246, 0.4); background-color: rgba(30, 41, 59, 1); }
            .jellyseerr-issue-textarea:focus { outline: none; border-color: rgba(59, 130, 246, 0.8); background-color: rgba(30, 41, 59, 1); box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1); }
            .jellyseerr-season-list { display: grid; gap: 4px; margin-bottom: 24px; }
            .jellyseerr-season-header-row { display: grid; grid-template-columns: 40px 1fr auto auto; align-items: center; gap: 16px; padding: 12px 20px; background: rgba(51, 65, 85, 0.3); border: 1px solid rgba(71, 85, 105, 0.4); border-radius: 12px; margin-bottom: 8px; font-weight: 600; color: #e2e8f0; }
            .jellyseerr-season-header-row .jellyseerr-season-checkbox { cursor: pointer; }
            .jellyseerr-season-header-label { font-size: 0.95rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #cbd5e1; }
            .jellyseerr-season-item { display: grid; grid-template-columns: 40px 1fr auto auto; align-items: center; gap: 16px; padding: 16px 20px; background: rgba(30, 41, 59, 0.4); border: 1px solid rgba(51, 65, 85, 0.3); border-radius: 12px; transition: all 0.2s ease; position: relative; }
            .jellyseerr-season-item:hover:not(.disabled) { background: rgba(30, 41, 59, 0.7); border-color: rgba(59, 130, 246, 0.3); transform: translateY(-1px); }
            .jellyseerr-season-item.disabled { background: rgba(15, 23, 42, 0.6); opacity: 0.6; border-color: rgba(51, 65, 85, 0.2); }
            .jellyseerr-season-checkbox { width: 20px; height: 20px; accent-color: #4f46e5; border-radius: 4px; }
            .jellyseerr-season-checkbox:disabled { opacity: 0.4; cursor: not-allowed; }
            .jellyseerr-season-info { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
            .jellyseerr-season-name { font-weight: 600; color: #e2e8f0; font-size: 1rem; }
            .jellyseerr-season-meta { font-size: 0.875rem; color: #94a3b8; }
            .jellyseerr-season-episodes { font-size: 0.875rem; color: #64748b; text-align: right; min-width: 70px; font-weight: 500; }
            .jellyseerr-season-status { padding: 6px 12px; border-radius: 20px; font-size: 0.75rem; font-weight: 700; text-transform: uppercase; min-width: 110px; text-align: center; letter-spacing: 0.5px; border: 1px solid transparent; }
            .jellyseerr-season-status-available { background: rgba(34, 197, 94, 0.15); color: #4ade80; border-color: rgba(34, 197, 94, 0.3); }
            .jellyseerr-season-status-pending { background: rgba(251, 146, 60, 0.15); color: #fb923c; border-color: rgba(251, 146, 60, 0.3); }
            .jellyseerr-season-status-processing { background: rgba(147, 51, 234, 0.15); color: #a855f7; border-color: rgba(147, 51, 234, 0.3); }
            .jellyseerr-season-status-partially-available { background: rgba(34, 197, 94, 0.15); color: #4ade80; border-color: rgba(34, 197, 94, 0.3); }
            .jellyseerr-season-status-not-requested { background: rgba(99, 102, 241, 0.15); color: #818cf8; border-color: rgba(99, 102, 241, 0.3); }
            .jellyseerr-inline-progress { grid-column: 1 / -1; padding: 8px 12px; background: rgba(15, 23, 42, 0.5); border-radius: 8px; border: 1px solid rgba(59, 130, 246, 0.2); }
            .jellyseerr-inline-progress-bar { height: .5rem; background: rgba(255,255,255,0.1); border-radius: 3px; overflow: hidden; margin-bottom: .5rem; }
            .jellyseerr-inline-progress-fill { height: 100%; background: linear-gradient(90deg, #3b82f6, #8b5cf6); transition: width 0.3s ease; border-radius: 3px; }
            .jellyseerr-inline-progress-text { font-size: 0.75rem; color: #94a3b8; font-weight: 500; }
            .jellyseerr-collection-list { display: grid; gap: 4px; }
            .jellyseerr-collection-header-row { display: grid; grid-template-columns: 40px 1fr auto auto; align-items: center; gap: 16px; padding: 12px 20px; background: rgba(51, 65, 85, 0.3); border: 1px solid rgba(71, 85, 105, 0.4); border-radius: 12px; margin-bottom: 8px; font-weight: 600; color: #e2e8f0; }
            .jellyseerr-collection-header-row .jellyseerr-collection-checkbox { cursor: pointer; }
            .jellyseerr-collection-header-label { font-size: 0.95rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #cbd5e1; }
            .jellyseerr-collection-checkbox { width: 20px; height: 20px; accent-color: #4f46e5; border-radius: 4px; cursor: pointer; }
            .jellyseerr-collection-checkbox:disabled { opacity: 0.4; cursor: not-allowed; }
            .jellyseerr-collection-movie-row { display: grid; grid-template-columns: 40px 46px 1fr auto; align-items: center; gap: 16px; padding: 16px 20px; background: rgba(30, 41, 59, 0.4); border: 1px solid rgba(51, 65, 85, 0.3); border-radius: 8px; transition: all 0.2s ease; }
            .jellyseerr-collection-movie-row:hover:not(:has(input:disabled)) { background: rgba(30, 41, 59, 0.7); border-color: rgba(59, 130, 246, 0.3); }
            .jellyseerr-collection-movie-poster { width: 100%; height: 69px; object-fit: cover; border-radius: 4px; }
            .jellyseerr-collection-movie-details { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
            .jellyseerr-collection-movie-details .title { font-weight: 600; color: #e2e8f0; font-size: 0.95rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .jellyseerr-collection-movie-details .year { font-size: 0.85rem; color: #94a3b8; }
            .jellyseerr-modal-footer { padding: 20px 24px; background: rgba(15, 23, 42, 0.3); border-top: 1px solid rgba(51, 65, 85, 0.3); display: flex; gap: 12px; justify-content: flex-end; flex-shrink: 0; }
            .jellyseerr-modal-button { padding: 12px 24px; border-radius: 8px; border: none; cursor: pointer; font-weight: 600; font-size: 0.875rem; transition: all 0.2s ease; min-width: 120px; }
            .jellyseerr-modal-button:disabled { opacity: 0.6; cursor: not-allowed; }
            .jellyseerr-modal-button-primary { background: linear-gradient(135deg, #4f46e5, #7c3aed); color: white; box-shadow: 0 4px 12px rgba(79, 70, 229, 0.3); }
            .jellyseerr-modal-button-primary:hover:not(:disabled) { background: linear-gradient(135deg, #4338ca, #6d28d9); transform: translateY(-1px); box-shadow: 0 6px 20px rgba(79, 70, 229, 0.4); }
            .jellyseerr-modal-button-secondary { background: rgba(71, 85, 105, 0.8); color: #e2e8f0; border: 1px solid rgba(148, 163, 184, 0.2); }
            .jellyseerr-modal-button-secondary:hover { background: rgba(71, 85, 105, 1); border-color: rgba(148, 163, 184, 0.3); }
        `;
        document.head.appendChild(style);
    };

    // ================================
    // UI MANAGEMENT FUNCTIONS
    // ================================

    /**
     * Updates the Jellyseerr icon in the search field based on current state.
     * @param {boolean} isJellyseerrActive - If the server is reachable.
     * @param {boolean} jellyseerrUserFound - If the current user is linked.
     * @param {boolean} isJellyseerrOnlyMode - If the results are filtered.
     * @param {function} onToggleFilter - The function to call to toggle the filter.
     */
    ui.updateJellyseerrIcon = function(isJellyseerrActive, jellyseerrUserFound, isJellyseerrOnlyMode, onToggleFilter) {
        const anchor = document.querySelector('.searchFields .inputContainer') ||
                       document.querySelector('#searchPage .searchFields') ||
                       document.querySelector('#searchPage');
        if (!anchor) return;

        let icon = document.getElementById('jellyseerr-search-icon');
        if (!icon) {
            icon = document.createElement('img');
            icon.id = 'jellyseerr-search-icon';
            icon.className = 'jellyseerr-icon';
            icon.src = 'https://cdn.jsdelivr.net/gh/n00bcodr/jellyfish/logos/favicon.ico';
            icon.alt = 'Jellyseerr';

            let tapCount = 0;
            let tapTimer = null;
            const handleIconInteraction = () => {
                if (!isJellyseerrActive || !jellyseerrUserFound || !onToggleFilter) return;
                tapCount++;
                if (tapCount === 1) {
                    tapTimer = setTimeout(() => { tapCount = 0; }, 300);
                } else if (tapCount === 2) {
                    clearTimeout(tapTimer);
                    tapCount = 0;
                    onToggleFilter();
                }
            };

            icon.addEventListener('click', handleIconInteraction);
            icon.addEventListener('touchend', (e) => { e.preventDefault(); handleIconInteraction(); }, { passive: false });
            icon.setAttribute('tabindex', '0');
            icon.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    if (!isJellyseerrActive || !jellyseerrUserFound || !onToggleFilter) return;
                    onToggleFilter();
                }
            });
            anchor.appendChild(icon);
        }

        icon.classList.remove('is-active', 'is-disabled', 'is-no-user', 'is-filter-active');
        if (isJellyseerrActive && jellyseerrUserFound) {
            icon.title = JE.t(isJellyseerrOnlyMode ? 'jellyseerr_icon_active_filter_tooltip' : 'jellyseerr_icon_active_tooltip');
            icon.classList.add('is-active');
            if (isJellyseerrOnlyMode) icon.classList.add('is-filter-active');
        } else if (isJellyseerrActive && !jellyseerrUserFound) {
            icon.title = JE.t('jellyseerr_icon_no_user_tooltip');
            icon.classList.add('is-no-user');
        } else {
            icon.title = JE.t('jellyseerr_icon_disabled_tooltip');
            icon.classList.add('is-disabled');
        }
    };

    /**
     * Analyzes season statuses to determine overall show status.
     * @param {Array} seasons - Array of season objects with status information.
     * @returns {object} - Analysis result with overall status and summary.
     */
    function analyzeSeasonStatuses(seasons) {
        if (!seasons || seasons.length === 0) return { overallStatus: 1, statusSummary: null, total: 0 };
        const regularSeasons = seasons.filter(s => s.seasonNumber > 0);
        const total = regularSeasons.length;
        if (total === 0) return { overallStatus: 1, statusSummary: null, total: 0 };

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
        let overallStatus, statusSummary = null;

        if (statusCounts.notRequested === 0) {
            overallStatus = (availableCount === total) ? 5 : 7;
            if (overallStatus === 7) statusSummary = JE.t('jellyseerr_seasons_accounted_for', { count: accountedForCount, total });
        } else if (accountedForCount > 0) {
            overallStatus = (availableCount > 0) ? 4 : 3;
            statusSummary = (availableCount > 0) ? JE.t('jellyseerr_seasons_available_count', { count: availableCount, total }) : JE.t('jellyseerr_seasons_requested_count', { count: requestedCount, total });
        } else {
            overallStatus = 1;
        }
        return { overallStatus, statusSummary, total };
    }

    /**
     * Renders Jellyseerr search results into the search page with improved placement logic.
     * @param {Array} results - Array of search result items.
     * @param {string} query - The search query that generated these results.
     * @param {boolean} isJellyseerrOnlyMode - Whether the filter is active.
     * @param {boolean} isJellyseerrActive - If the server is reachable.
     * @param {boolean} jellyseerrUserFound - If the current user is linked.
     */
    ui.renderJellyseerrResults = function(results, query, isJellyseerrOnlyMode, isJellyseerrActive, jellyseerrUserFound) {
        console.log(`${logPrefix} Rendering results for query: "${query}"`);
        const searchPage = document.querySelector('#searchPage');
        if (!searchPage) {
            console.warn(`${logPrefix} #searchPage not found. Cannot render results.`);
            return;
        }

        const oldSection = searchPage.querySelector('.jellyseerr-section');
        if(oldSection) oldSection.remove();

        const sectionToInject = createJellyseerrSection(results, isJellyseerrOnlyMode, isJellyseerrActive, jellyseerrUserFound);

        const primarySectionKeywords = ['movies', 'shows', 'film', 'serier', 'filme', 'serien', 'películas', 'series', 'films', 'séries', 'serie tv'];

        let attempts = 0;
        const maxAttempts = 75; // ~15 seconds

        const injectionInterval = setInterval(() => {
            attempts++;
            const noResultsMessage = searchPage.querySelector('.noItemsMessage');
            const allSections = Array.from(searchPage.querySelectorAll('.verticalSection:not(.jellyseerr-section)'));
            const hasContent = allSections.length > 0;

            if ((hasContent || noResultsMessage) || attempts >= maxAttempts) {
                clearInterval(injectionInterval);

                if (noResultsMessage) {
                    noResultsMessage.textContent = JE.t('jellyseerr_no_results_jellyfin', { query });
                    noResultsMessage.parentElement.insertBefore(sectionToInject, noResultsMessage.nextSibling);
                    return;
                }

                let lastPrimarySection = null;
                for (let i = allSections.length - 1; i >= 0; i--) {
                    const section = allSections[i];
                    const title = section.querySelector('.sectionTitle')?.textContent.trim().toLowerCase();
                    if (title && primarySectionKeywords.some(keyword => title.includes(keyword))) {
                        lastPrimarySection = section;
                        break;
                    }
                }

                if (lastPrimarySection) {
                    lastPrimarySection.after(sectionToInject);
                } else {
                    const resultsContainer = searchPage.querySelector('.searchResults, [class*="searchResults"], .padded-top.padded-bottom-page');
                    if (resultsContainer) {
                        resultsContainer.prepend(sectionToInject);
                    } else {
                        searchPage.appendChild(sectionToInject); // Fallback
                    }
                }
            }
        }, 200);
    };

    /**
     * Creates the main Jellyseerr results section.
     * @param {Array} results - Array of search result items.
     * @param {boolean} isJellyseerrOnlyMode - Whether the filter is active.
     * @param {boolean} isJellyseerrActive - If the server is reachable.
     * @param {boolean} jellyseerrUserFound - If the current user is linked.
     * @returns {HTMLElement} - Section element.
     */
    function createJellyseerrSection(results = [], isJellyseerrOnlyMode, isJellyseerrActive, jellyseerrUserFound) {
        const section = document.createElement('div');
        section.className = 'verticalSection emby-scroller-container jellyseerr-section';
        section.setAttribute('data-jellyseerr-section', 'true');

        const title = document.createElement('h2');
        title.className = 'sectionTitle sectionTitle-cards focuscontainer-x padded-left padded-right';
        title.textContent = isJellyseerrOnlyMode ? JE.t('jellyseerr_results_title') : JE.t('jellyseerr_discover_title');

        // Add a refresh button beside the results heading
        const refreshBtn = document.createElement('button');
        refreshBtn.className = 'jellyseerr-refresh-btn';
        refreshBtn.style.marginLeft = '0.5em';
        refreshBtn.style.verticalAlign = 'middle';
        refreshBtn.style.background = 'none';
        refreshBtn.style.border = 'none';
        refreshBtn.style.cursor = 'pointer';
        refreshBtn.style.display = 'inline-flex';
        refreshBtn.style.alignItems = 'center';
        refreshBtn.style.justifyContent = 'center';
        refreshBtn.style.padding = '0';
        const icon = document.createElement('span');
        icon.className = 'material-icons jellyseerr-refresh-icon';
        icon.textContent = 'refresh';
        icon.style.transition = 'transform 0.5s cubic-bezier(.4,2,.6,1)';
        refreshBtn.appendChild(icon);
        refreshBtn.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            icon.style.transform = 'rotate(360deg)';
            setTimeout(() => { icon.style.transform = ''; }, 500);
            document.dispatchEvent(new CustomEvent('jellyseerr-manual-refresh'));
        });
        title.appendChild(refreshBtn);
    if (!document.getElementById('jellyseerr-refresh-style')) {
        const style = document.createElement('style');
        style.id = 'jellyseerr-refresh-style';
        style.textContent = `
            .jellyseerr-refresh-btn:focus { outline: none; }
            .jellyseerr-refresh-icon { color: #fff; filter: opacity(0.6); }
            .jellyseerr-refresh-btn:hover .jellyseerr-refresh-icon { color: #fff; filter: opacity(0.9); }
        `;
        document.head.appendChild(style);
    }
        section.appendChild(title);

        const scrollerContainer = document.createElement('div');
        scrollerContainer.setAttribute('is', 'emby-scroller');
        scrollerContainer.className = 'padded-top-focusscale padded-bottom-focusscale emby-scroller';
        scrollerContainer.dataset.horizontal = "true";
        scrollerContainer.dataset.centerfocus = "card";

        const itemsContainer = document.createElement('div');
        itemsContainer.setAttribute('is', 'emby-itemscontainer');
        itemsContainer.className = 'focuscontainer-x itemsContainer scrollSlider';

        const isTvMode = document.querySelector('.alphaPicker-tv') !== null;
        if (isTvMode) {
            itemsContainer.classList.add('itemsContainer-tv');
            itemsContainer.classList.add('animatedScrollX');
        }

        results.forEach(item => {
            const card = createJellyseerrCard(item, isJellyseerrActive, jellyseerrUserFound);
            itemsContainer.appendChild(card);
        });

        scrollerContainer.appendChild(itemsContainer);
        section.appendChild(scrollerContainer);
        return section;
    }

    /**
     * Sets the status badge icon based on the item's media status.
     * @param {HTMLElement} card - The card element.
     * @param {Object} item - The search result item.
     */
    function setStatusBadge(card, item) {
        const badge = card.querySelector('.jellyseerr-status-badge');
        if (!badge || !item.mediaInfo) {
            if (badge) badge.style.display = 'none';
            return;
        }

        // Determine status based on media type
        let status;
        if (item.mediaType === 'tv' && item.mediaInfo.seasons) {
            const seasonAnalysis = analyzeSeasonStatuses(item.mediaInfo.seasons);
            status = seasonAnalysis ? seasonAnalysis.overallStatus : item.mediaInfo.status;
        } else {
            status = item.mediaInfo.status || 1;
        }

        // Status codes: 1=Unknown, 2=Pending, 3=Processing/Requested, 4=Partially Available, 5=Available, 6=Rejected/Declined, 7=Requested
        let icon = '';
        let statusClass = '';

        switch (status) {
            case 5: // Available
                icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clip-rule="evenodd" /></svg>`;
                statusClass = 'status-available';
                break;
            case 2: // Pending
                icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M5.25 9a6.75 6.75 0 0113.5 0v.75c0 2.123.8 4.057 2.118 5.52a.75.75 0 01-.297 1.206c-1.544.57-3.16.99-4.831 1.243a3.75 3.75 0 11-7.48 0 24.585 24.585 0 01-4.831-1.244.75.75 0 01-.298-1.205A8.217 8.217 0 005.25 9.75V9zm4.502 8.9a2.25 2.25 0 104.496 0 25.057 25.057 0 01-4.496 0z" clip-rule="evenodd" /></svg>`;
                statusClass = 'status-pending';
                break;
            case 3: // Status 3 can be either Processing (with downloads) or Requested (without downloads)
                // Check if there are active downloads to differentiate
                if (item.mediaInfo?.downloadStatus?.length > 0 || item.mediaInfo?.downloadStatus4k?.length > 0) {
                    // Processing - spinner icon with animation
                    icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10" stroke-opacity="0.25"/><path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round"/></svg>`;
                    statusClass = 'status-processing';
                } else {
                    // Requested - clock icon
                    icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M12 2.25c-5.385 0-9.75 4.365-9.75 9.75s4.365 9.75 9.75 9.75 9.75-4.365 9.75-9.75S17.385 2.25 12 2.25zM12.75 6a.75.75 0 00-1.5 0v6c0 .414.336.75.75.75h4.5a.75.75 0 000-1.5h-3.75V6z" clip-rule="evenodd"></path></svg>`;
                    statusClass = 'status-requested';
                }
                break;
            case 7: // Requested (clock icon)
                icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M12 2.25c-5.385 0-9.75 4.365-9.75 9.75s4.365 9.75 9.75 9.75 9.75-4.365 9.75-9.75S17.385 2.25 12 2.25zM12.75 6a.75.75 0 00-1.5 0v6c0 .414.336.75.75.75h4.5a.75.75 0 000-1.5h-3.75V6z" clip-rule="evenodd"></path></svg>`;
                statusClass = 'status-requested';
                break;
            case 4: // Partially Available
                icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM6.75 9.25a.75.75 0 000 1.5h6.5a.75.75 0 000-1.5h-6.5z" clip-rule="evenodd" /></svg>`;
                statusClass = 'status-partially-available';
                break;
            case 6: // Rejected
                icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z" clip-rule="evenodd" /></svg>`;
                statusClass = 'status-rejected';
                break;
            default:
                // Unknown status - hide badge
                badge.style.display = 'none';
                return;
        }

        badge.innerHTML = icon;
        badge.className = `jellyseerr-status-badge ${statusClass}`;
        badge.style.display = 'flex';

        // Add hover tooltip for Partially Available TV shows with active downloads
        if (status === 4 && item.mediaType === 'tv') {
            const hasDownloads = (item.mediaInfo?.downloadStatus?.length > 0 || item.mediaInfo?.downloadStatus4k?.length > 0);
            if (hasDownloads) {
                badge.style.cursor = 'pointer';
                addDownloadProgressHover(badge, item);
            }
        }
    }

    /**
     * Creates an individual Jellyseerr result card.
     * @param {Object} item - Search result item from Jellyseerr API.
     * @param {boolean} isJellyseerrActive - If the server is reachable.
     * @param {boolean} jellyseerrUserFound - If the current user is linked.
     * @returns {HTMLElement} - Card element.
     */
    function createJellyseerrCard(item, isJellyseerrActive, jellyseerrUserFound) {
        const year = item.releaseDate?.substring(0, 4) || item.firstAirDate?.substring(0, 4) || 'N/A';
        const posterUrl = item.posterPath ? `https://image.tmdb.org/t/p/w400${item.posterPath}` : 'https://i.ibb.co/fdbkXQdP/jellyseerr-poster-not-found.png';
        const rating = item.voteAverage ? item.voteAverage.toFixed(1) : 'N/A';
        const titleText = item.title || item.name;
        // Resolve Jellyseerr URL based on mappings or fallback to base URL
        const base = JE.jellyseerrAPI?.resolveJellyseerrBaseUrl() || '';
        const jellyseerrUrl = base ? `${base}/${item.mediaType}/${item.id}` : null;
        const useMoreInfoModal = !!(JE.pluginConfig && JE.pluginConfig.JellyseerrUseMoreInfoModal);

        // Treat as "in library" only when Jellyfin exposes a media id
        const jellyfinMediaId = item.mediaInfo?.jellyfinMediaId || item.mediaInfo?.jellyfinMediaId4k || null;
        const jellyfinHref = jellyfinMediaId ? `#!/details?id=${jellyfinMediaId}` : null;
        const isAvailable = Boolean(jellyfinMediaId);
        const usesExternalTitleLink = !jellyfinHref && !useMoreInfoModal && !!jellyseerrUrl;
        const titleLinkIsAttribute = usesExternalTitleLink ? '' : 'is="emby-linkbutton"';
        const titleHrefAttribute = jellyfinHref
            ? `href="${jellyfinHref}"`
            : (useMoreInfoModal
                ? 'href="#"'
                : (jellyseerrUrl
                    ? `href="${jellyseerrUrl}" target="_blank" rel="noopener noreferrer"`
                    : 'href="#"'));

        const card = document.createElement('div');
        card.className = `card overflowPortraitCard card-hoverable card-withuserdata jellyseerr-card${isAvailable ? ' jellyseerr-card-in-library' : ''}`;
        card.innerHTML = `
            <div class="cardBox cardBox-bottompadded">
                <div class="cardScalable">
                    <div class="cardPadder cardPadder-overflowPortrait"></div>
                    <div class="cardImageContainer coveredImage cardContent jellyseerr-poster-image" style="background-image: url('${posterUrl}');">
                        <div class="jellyseerr-status-badge"></div>
                        <div class="jellyseerr-elsewhere-icons"></div>
                        <div class="cardIndicators"></div>
                    </div>
                    <div class="cardOverlayContainer" data-action="link"></div>
                </div>
                <div class="cardText cardTextCentered cardText-first">
                    <a ${titleLinkIsAttribute}
                       ${titleHrefAttribute}
                       class="jellyseerr-more-info-link"
                       data-tmdb-id="${item.id}"
                       data-media-type="${item.mediaType}"
                       title="${jellyfinHref ? titleText : (useMoreInfoModal ? titleText : (jellyseerrUrl ? (JE.t('jellyseerr_card_view_on_jellyseerr') || 'View on Jellyseerr') : titleText))}"><bdi>${titleText}</bdi></a>
                </div>
                <div class="cardText cardTextCentered cardText-secondary jellyseerr-meta">
                    <img src="https://cdn.jsdelivr.net/gh/n00bcodr/jellyfish/logos/favicon.ico" class="jellyseerr-icon-on-card" alt="Jellyseerr"/>
                    <bdi>${year}</bdi>
                    <div class="jellyseerr-rating">${icons.star}<span>${rating}</span></div>
                </div>
            </div>`;

        // Set the status badge icon based on the item's status
        setStatusBadge(card, item);

        // Disable default Jellyfin card click behavior so we fully control taps/clicks
        const overlayContainer = card.querySelector('.cardOverlayContainer');
        if (overlayContainer) {
            overlayContainer.removeAttribute('data-action');
            overlayContainer.style.pointerEvents = 'none';
        }

        const imageContainer = card.querySelector('.cardImageContainer');
        const cardScalable = card.querySelector('.cardScalable');

        if (imageContainer && cardScalable) {
            imageContainer.classList.remove('itemAction');

            let overview = null;
            let button = null;

            // Create the overview element
            const createOverview = () => {
                overview = document.createElement('div');
                overview.className = 'jellyseerr-overview';
                overview.style.cursor = 'pointer';
                overview.innerHTML = `
                    <div class="content">${((item.overview || JE.t('jellyseerr_card_no_info')).slice(0, 500))}</div>
                    <button type="button" class="jellyseerr-request-button" data-tmdb-id="${item.id}" data-media-type="${item.mediaType}"></button>
                `;

                cardScalable.appendChild(overview);
                button = overview.querySelector('.jellyseerr-request-button');
                configureRequestButton(button, item, isJellyseerrActive, jellyseerrUserFound);

                // Click handler on overview to open modal
                overview.addEventListener('click', (e) => {
                    if (e.target.closest('.jellyseerr-request-button')) {
                        return;
                    }
                    e.preventDefault();
                    e.stopPropagation();

                    if (item.mediaType === 'collection') {
                        ui.showCollectionRequestModal(item.id, item.name || item.title, item);
                    } else if (useMoreInfoModal && JE.jellyseerrMoreInfo) {
                        const tmdbId = parseInt(item.id);
                        const mediaType = item.mediaType;
                        if (tmdbId && mediaType) {
                            JE.jellyseerrMoreInfo.open(tmdbId, mediaType);
                        }
                    } else if (jellyseerrUrl) {
                        window.open(jellyseerrUrl, '_blank', 'noopener,noreferrer');
                    }
                });
            };

            // Remove the overview element
            const removeOverview = () => {
                if (overview && overview.parentNode) {
                    overview.parentNode.removeChild(overview);
                    overview = null;
                    button = null;
                }
                document.removeEventListener('click', handleOutsideClick);
            };

            // Helper to close overview if clicked outside
            const handleOutsideClick = (evt) => {
                if (!card.contains(evt.target)) {
                    removeOverview();
                }
            };

            // Desktop: hover to show/hide overview
            cardScalable.addEventListener('mouseenter', () => {
                if (!overview) {
                    createOverview();
                }
            });
            cardScalable.addEventListener('mouseleave', () => {
                removeOverview();
            });

            // Mobile/Touch: touchstart to show overview, second tap (click) on overview opens modal
            imageContainer.style.cursor = 'pointer';

            // Use touchstart for mobile to create overview (prevents touchend from immediately opening modal)
            imageContainer.addEventListener('touchstart', (e) => {
                if (e.target.closest('.jellyseerr-overview') || e.target.closest('.jellyseerr-request-button')) {
                    return;
                }

                if (!overview) {
                    e.preventDefault();
                    createOverview();
                    setTimeout(() => {
                        document.addEventListener('click', handleOutsideClick);
                    }, 0);
                }
            }, { passive: false });

            // Desktop: use click event
            imageContainer.addEventListener('click', (e) => {
                // Skip if touch device (touchstart already handled it)
                if (e.type === 'click' && 'ontouchstart' in window) {
                    return;
                }

                if (e.target.closest('.jellyseerr-overview')) {
                    return;
                }

                if (!overview) {
                    e.preventDefault();
                    e.stopPropagation();
                    createOverview();
                    setTimeout(() => {
                        document.addEventListener('click', handleOutsideClick);
                    }, 0);
                }
            });

            imageContainer.setAttribute('tabindex', '0');
            imageContainer.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    if (!overview) {
                        createOverview();
                    } else {
                        removeOverview();
                    }
                }
            });
        }
        addMediaTypeBadge(card, item);
        // If movie belongs to a collection, show a collection badge that opens the modal
        addCollectionMembershipBadge(card, item);

        // Add click handler for the poster image - opens modal
        const posterImage = card.querySelector('.jellyseerr-poster-image');
        if (posterImage && useMoreInfoModal && JE.jellyseerrMoreInfo) {
            posterImage.style.cursor = 'pointer';
            posterImage.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const tmdbId = parseInt(item.id);
                const mediaType = item.mediaType;
                if (tmdbId && mediaType) {
                    JE.jellyseerrMoreInfo.open(tmdbId, mediaType);
                }
            });
        }

        // Add click handler for the title link
        const moreInfoLink = card.querySelector('.jellyseerr-more-info-link');
        if (moreInfoLink) {
            moreInfoLink.addEventListener('click', (e) => {
                // Check if this is a library item (href already set to jellyfin item)
                const href = moreInfoLink.getAttribute('href');
                const isLibraryLink = href && href.startsWith('#!/details?id=');
                const isExternalJellyseerrLink = href && /^https?:\/\//i.test(href);

                if (isLibraryLink) {
                    // Allow default behavior for library links
                    return;
                }

                // If collection, open collection modal
                if (item.mediaType === 'collection') {
                    e.preventDefault();
                    e.stopPropagation();
                    ui.showCollectionRequestModal(item.id, item.name || item.title, item);
                    return;
                }

                // If using modal, prevent default and open modal
                if (useMoreInfoModal && JE.jellyseerrMoreInfo) {
                    e.preventDefault();
                    e.stopPropagation();
                    const tmdbId = parseInt(moreInfoLink.dataset.tmdbId);
                    const mediaType = moreInfoLink.dataset.mediaType;
                    if (tmdbId && mediaType) {
                        JE.jellyseerrMoreInfo.open(tmdbId, mediaType);
                    }
                    return;
                }

                // For plain external links, bypass Jellyfin's hash router and open in a new tab.
                const isPlainLeftClick = e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
                if (isExternalJellyseerrLink && isPlainLeftClick) {
                    e.preventDefault();
                    e.stopPropagation();
                    if (e.stopImmediatePropagation) {
                        e.stopImmediatePropagation();
                    }
                    window.open(href, '_blank', 'noopener,noreferrer');
                }
            }, true);
        }

        if (JE.pluginConfig.ShowElsewhereOnJellyseerr && JE.pluginConfig.TmdbEnabled && item.mediaType !== 'collection') {
            fetchProviderIcons(card.querySelector('.jellyseerr-elsewhere-icons'), item.id, item.mediaType);
        }
        return card;
    }

    /**
     * Fetches streaming provider icons from the TMDB API and adds them to a specified container element on a Jellyseerr poster.
     * This function is called only if the "Show Elsewhere on Jellyseerr" setting is enabled and a TMDB API key is present.
     * It retrieves providers based on the default region and filters configured in the Elsewhere plugin settings.
     *
     * @async
     * @function fetchProviderIcons
     * @param {HTMLElement} container - The DOM element where the provider icons will be appended.
     * @param {string|number} tmdbId - The The Movie Database (TMDB) ID for the movie or TV show.
     * @param {string} mediaType - The type of media, either 'movie' or 'tv'.
     * @returns {Promise<void>} A promise that resolves when the icons have been fetched and added, or if the process fails.
     */
    async function fetchProviderIcons(container, tmdbId, mediaType) {
        if (!container || !tmdbId || !mediaType) return;

        const url = ApiClient.getUrl(`/JellyfinEnhanced/tmdb/${mediaType}/${tmdbId}/watch/providers`);
        const DEFAULT_REGION = JE.pluginConfig.DEFAULT_REGION || 'US';
        const DEFAULT_PROVIDERS = JE.pluginConfig.DEFAULT_PROVIDERS ? JE.pluginConfig.DEFAULT_PROVIDERS.replace(/'/g, '').replace(/\n/g, ',').split(',').map(s => s.trim()).filter(s => s) : [];
        const IGNORE_PROVIDERS = JE.pluginConfig.IGNORE_PROVIDERS ? JE.pluginConfig.IGNORE_PROVIDERS.replace(/'/g, '').replace(/\n/g, ',').split(',').map(s => s.trim()).filter(s => s) : [];

        try {
            const response = await fetch(url, {
                headers: {
                    "X-Emby-Token": ApiClient.accessToken()
                }
            });
            if (!response.ok) return;

            const data = await response.json();
            let providers = data.results?.[DEFAULT_REGION]?.flatrate;

            if (providers && providers.length > 0) {

                // 1. If a default provider list is set, only include providers from that list.
                if (DEFAULT_PROVIDERS.length > 0) {
                    providers = providers.filter(provider => DEFAULT_PROVIDERS.includes(provider.provider_name));
                }

                // 2. If an ignore list is set, exclude any providers that match.
                if (IGNORE_PROVIDERS.length > 0) {
                    try {
                        const ignorePatterns = IGNORE_PROVIDERS.map(pattern => new RegExp(pattern, 'i'));
                        providers = providers.filter(provider =>
                            !ignorePatterns.some(regex => regex.test(provider.provider_name))
                        );
                    } catch (e) {
                        console.error(`${logPrefix} Invalid regex in IGNORE_PROVIDERS setting.`, e);
                    }
                }

                if (providers.length > 0) {
                    providers.slice(0, 4).forEach(provider => { // Limit to max 4 icons to avoid clutter
                        const img = document.createElement('img');
                        img.src = `https://image.tmdb.org/t/p/w92${provider.logo_path}`;
                        img.title = provider.provider_name;
                        container.appendChild(img);
                    });

                    if (container.childElementCount > 0) {
                        container.classList.add('has-icons');
                    }
                }
            }
        } catch (error) {
            console.warn(`${logPrefix} Could not fetch provider icons for TMDB ID ${tmdbId}:`, error);
        }
    }

    /**
     * Configures the request button based on item status and type.
     * @param {HTMLElement} button - Button element to configure.
     * @param {Object} item - Media item data.
     * @param {boolean} isJellyseerrActive - If the server is reachable.
     * @param {boolean} jellyseerrUserFound - If the current user is linked.
     */
    function configureRequestButton(button, item, isJellyseerrActive, jellyseerrUserFound) {
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

        if (item.mediaType === 'collection') {
            configureCollectionButton(button, item);
        } else if (item.mediaType === 'tv') {
            button.dataset.searchResultItem = JSON.stringify(item);
            button.classList.add('jellyseerr-button-tv');
            if (item.mediaInfo) button.dataset.mediaInfo = JSON.stringify(item.mediaInfo);
            const seasonAnalysis = item.mediaInfo?.seasons ? analyzeSeasonStatuses(item.mediaInfo.seasons) : null;
            const overallStatus = seasonAnalysis ? seasonAnalysis.overallStatus : (item.mediaInfo ? item.mediaInfo.status : 1);
            configureTvShowButton(button, overallStatus, seasonAnalysis, item);
        } else {
            configureMovieButton(button, item);
        }
    }

    /**
     * Configures button for collections.
     * @param {HTMLElement} button - Button element.
     * @param {Object} item - Collection item data.
     */
    function configureCollectionButton(button, item) {
        button.dataset.searchResultItem = JSON.stringify(item);
        button.dataset.mediaType = 'collection';
        button.dataset.collectionId = item.id;
        button.innerHTML = `${icons.request}<span>${JE.t('jellyseerr_modal_request_collection')}</span>`;
        button.className = 'jellyseerr-request-button jellyseerr-button-request jellyseerr-button-collection';
        button.disabled = false;
    }

    /**
     * Configures button for TV shows based on season analysis.
     * @param {HTMLElement} button - Button element.
     * @param {number} overallStatus - Calculated overall status.
     * @param {Object|null} seasonAnalysis - Season analysis results.
     * @param {Object} item - Media item data.
     */
    function configureTvShowButton(button, overallStatus, seasonAnalysis, item) {
        const setButton = (text, icon, className, disabled = false, summary = seasonAnalysis?.statusSummary) => {
            button.innerHTML = `${icon || ''}<span>${text}</span>`;
            if (summary) button.innerHTML += `<div class="jellyseerr-season-summary">${summary}</div>`;
            button.disabled = disabled;
            button.className = `jellyseerr-request-button jellyseerr-button-tv ${className}`; // Reset classes
        };
        switch (overallStatus) {
            case 2: setButton(JE.t('jellyseerr_btn_pending'), icons.pending, 'jellyseerr-button-pending'); break;
            case 3: setButton(JE.t('jellyseerr_btn_request_more'), icons.request, 'jellyseerr-button-request'); break;
            case 7: setButton(JE.t('jellyseerr_btn_view_status'), icons.requested, 'jellyseerr-button-pending'); break;
            case 4:
                setButton(JE.t('jellyseerr_btn_request_missing'), icons.request, 'jellyseerr-button-partially-available');
                // Add download progress hover if there are active downloads
                if (item?.mediaInfo?.downloadStatus?.length > 0 || item?.mediaInfo?.downloadStatus4k?.length > 0) {
                    addDownloadProgressHover(button, item);
                }
                break;
            case 5: setButton(JE.t('jellyseerr_btn_available'), icons.available, 'jellyseerr-button-available', true, seasonAnalysis?.total > 1 ? JE.t('jellyseerr_all_seasons', {count: seasonAnalysis.total}) : null); break;
            case 6: setButton(JE.t('jellyseerr_btn_rejected'), icons.cancel, 'jellyseerr-button-rejected', true); break;
            default: setButton(JE.t('jellyseerr_btn_request'), icons.request, 'jellyseerr-button-request', false, seasonAnalysis?.total > 1 ? JE.t('jellyseerr_seasons_available', {count: seasonAnalysis.total}) : null); break;
        }
    }

    /**
     * Configures button for movies.
     * @param {HTMLElement} button - Button element.
     * @param {Object} item - Movie item data.
     */
    function configureMovieButton(button, item) {
        button.dataset.searchResultItem = JSON.stringify(item);
        const status = item.mediaInfo ? item.mediaInfo.status : 1;
        const status4k = item.mediaInfo ? item.mediaInfo.status4k : 1;

        // Show split button when the 4K feature is enabled
        const show4KOption = !!JE.pluginConfig.JellyseerrEnable4KRequests;

        const setButton = (text, icon, className, disabled = false) => {
            button.innerHTML = `${icon || ''}<span>${text}</span>`;
            button.disabled = disabled;
            button.className = `jellyseerr-request-button ${className}`;
        };

        // Create split button with 4K option if enabled
        if (show4KOption && !button.closest('.jellyseerr-button-group')) {
            // Create button group
            const buttonGroup = document.createElement('div');
            buttonGroup.className = 'jellyseerr-button-group';

            // Determine main button state based on status
            let mainButtonText, mainButtonIcon, mainButtonClass, mainButtonDisabled;

            if (status === 5) {
                // Check if item is available but also downloading (upgrading version)
                if (item.mediaInfo?.downloadStatus?.length > 0) {
                    mainButtonText = JE.t('jellyseerr_btn_available');
                    mainButtonIcon = icons.available;
                    mainButtonClass = 'jellyseerr-button-available-updating';
                    mainButtonDisabled = true;
                } else {
                    mainButtonText = JE.t('jellyseerr_btn_available');
                    mainButtonIcon = icons.available;
                    mainButtonClass = 'jellyseerr-button-available';
                    mainButtonDisabled = true;
                }
            } else if (status === 2) {
                mainButtonText = JE.t('jellyseerr_btn_pending');
                mainButtonIcon = icons.pending;
                mainButtonClass = 'jellyseerr-button-pending';
                mainButtonDisabled = true;
            } else if (status === 3) {
                if (item.mediaInfo?.downloadStatus?.length > 0 || item.mediaInfo?.downloadStatus4k?.length > 0) {
                    mainButtonText = JE.t('jellyseerr_btn_processing');
                    mainButtonIcon = '';
                    mainButtonClass = 'jellyseerr-button-processing';
                    mainButtonDisabled = true;
                } else {
                    mainButtonText = JE.t('jellyseerr_btn_requested');
                    mainButtonIcon = icons.requested;
                    mainButtonClass = 'jellyseerr-button-pending';
                    mainButtonDisabled = true;
                }
            } else if (status === 6) {
                mainButtonText = JE.t('jellyseerr_btn_rejected');
                mainButtonIcon = icons.cancel;
                mainButtonClass = 'jellyseerr-button-rejected';
                mainButtonDisabled = true;
            } else {
                mainButtonText = JE.t('jellyseerr_btn_request');
                mainButtonIcon = icons.request;
                mainButtonClass = 'jellyseerr-button-request';
                mainButtonDisabled = false;
            }

            // Main button
            const mainButton = document.createElement('button');
            mainButton.className = `jellyseerr-request-button jellyseerr-split-main ${mainButtonClass}`;
            mainButton.disabled = mainButtonDisabled;
            mainButton.innerHTML = `${mainButtonIcon}<span>${mainButtonText}</span>${(mainButtonClass === 'jellyseerr-button-processing' || mainButtonClass === 'jellyseerr-button-available-updating') ? '<span class="jellyseerr-button-spinner"></span>' : ''}`;
            mainButton.dataset.tmdbId = item.id;
            mainButton.dataset.mediaType = 'movie';
            mainButton.dataset.searchResultItem = JSON.stringify(item);

            // Add download progress hover if processing or available-updating
            if ((status === 3 || status === 5) && (item.mediaInfo?.downloadStatus?.length > 0 || item.mediaInfo?.downloadStatus4k?.length > 0)) {
                addDownloadProgressHover(mainButton, item);
            }

            // Arrow button for 4K dropdown
            const arrowButton = document.createElement('button');
            arrowButton.className = 'jellyseerr-split-arrow';
            arrowButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M12.53 16.28a.75.75 0 01-1.06 0l-7.5-7.5a.75.75 0 011.06-1.06L12 14.69l6.97-6.97a.75.75 0 111.06 1.06l-7.5 7.5z" clip-rule="evenodd" /></svg>';
            arrowButton.dataset.tmdbId = item.id;
            arrowButton.dataset.toggle4k = 'true';

            // Determine arrow button state based on 4K status
            if (status4k === 5) {
                arrowButton.disabled = true;
                arrowButton.classList.add('jellyseerr-split-arrow-disabled');
                arrowButton.classList.add('jellyseerr-4k-available');
                arrowButton.title = '4K Available';
            } else if (status4k === 2 || status4k === 3) {
                arrowButton.classList.add('jellyseerr-4k-pending');
                arrowButton.title = '4K Requested';
            } else {
                arrowButton.title = JE.t('jellyseerr_btn_request_4k');
            }

            buttonGroup.appendChild(mainButton);
            buttonGroup.appendChild(arrowButton);
            button.replaceWith(buttonGroup);

            if (!mainButtonDisabled) {
                mainButton.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    if (JE.pluginConfig.JellyseerrShowAdvanced) {
                        ui.showMovieRequestModal(item.id, item.title || item.name, item, false);
                    } else {
                        mainButton.disabled = true;
                        mainButton.innerHTML = `<span>${JE.t('jellyseerr_btn_requesting')}</span><span class="jellyseerr-button-spinner"></span>`;
                        try {
                            const response = await JE.jellyseerrAPI.requestMedia(item.id, 'movie', {}, false, item);
                            if (!item.mediaInfo) item.mediaInfo = {};
                            item.mediaInfo.status = 3;
                            mainButton.innerHTML = `<span>${JE.t('jellyseerr_btn_requested')}</span>${icons.requested}`;
                            mainButton.classList.remove('jellyseerr-button-request');
                            mainButton.classList.add('jellyseerr-button-pending');
                        } catch (error) {
                            mainButton.disabled = false;
                            let errorMessage = JE.t('jellyseerr_btn_error');
                            if (error.status === 404) {
                                errorMessage = JE.t('jellyseerr_btn_user_not_found');
                            } else if (error.responseJSON?.message) {
                                errorMessage = error.responseJSON.message;
                            }
                            mainButton.innerHTML = `<span>${errorMessage}</span>${icons.error}`;
                            mainButton.classList.add('jellyseerr-button-error');
                        }
                    }
                });
            }

            arrowButton.addEventListener('click', (e) => {
                e.stopPropagation();
                if (active4KPopup && active4KPopup.parentElement === buttonGroup) {
                    hide4KPopup();
                } else {
                    show4KPopup(buttonGroup, item);
                }
            });
            return;
        }

        // Standard button (no 4K option or button in overview)
        switch (status) {
            case 2: setButton(JE.t('jellyseerr_btn_pending'), icons.pending, 'jellyseerr-button-pending', true); break;
            case 3:
                if (item.mediaInfo?.downloadStatus?.length > 0 || item.mediaInfo?.downloadStatus4k?.length > 0) {
                    button.innerHTML = `<span>${JE.t('jellyseerr_btn_processing')}</span><span class="jellyseerr-button-spinner"></span>`;
                    button.disabled = true;
                    button.className = 'jellyseerr-request-button jellyseerr-button-processing';
                    addDownloadProgressHover(button, item);
                } else {
                    setButton(JE.t('jellyseerr_btn_requested'), icons.requested, 'jellyseerr-button-pending', true);
                }
                break;
            case 4: setButton(JE.t('jellyseerr_btn_partially_available'), icons.partially_available, 'jellyseerr-button-partially-available', true); break;
            case 5:
                // Check if item is available but also downloading (upgrading version)
                if (item.mediaInfo?.downloadStatus?.length > 0 || item.mediaInfo?.downloadStatus4k?.length > 0) {
                    button.innerHTML = `${icons.available}<span>${JE.t('jellyseerr_btn_available')}</span><span class="jellyseerr-button-spinner"></span>`;
                    button.disabled = true;
                    button.className = 'jellyseerr-request-button jellyseerr-button-available-updating';
                    addDownloadProgressHover(button, item);
                } else {
                    setButton(JE.t('jellyseerr_btn_available'), icons.available, 'jellyseerr-button-available', true);
                }
                break;
            case 6: setButton(JE.t('jellyseerr_btn_rejected'), icons.cancel, 'jellyseerr-button-rejected', true); break;
            default: setButton(JE.t('jellyseerr_btn_request'), icons.request, 'jellyseerr-button-request'); break;
        }

        // Add click handler for request button (for overview button and standard button)
        if (!button.disabled && !button.closest('.jellyseerr-button-group')) {
            button.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (JE.pluginConfig.JellyseerrShowAdvanced) {
                    ui.showMovieRequestModal(item.id, item.title || item.name, item, false);
                } else {
                    button.disabled = true;
                    button.innerHTML = `<span>${JE.t('jellyseerr_btn_requesting')}</span><span class="jellyseerr-button-spinner"></span>`;
                    try {
                        const response = await JE.jellyseerrAPI.requestMedia(item.id, 'movie', {}, false, item);
                        if (!item.mediaInfo) item.mediaInfo = {};
                        item.mediaInfo.status = 3;
                        button.innerHTML = `<span>${JE.t('jellyseerr_btn_requested')}</span>${icons.requested}`;
                        button.classList.remove('jellyseerr-button-request');
                        button.classList.add('jellyseerr-button-pending');
                    } catch (error) {
                        button.disabled = false;
                        let errorMessage = JE.t('jellyseerr_btn_error');
                        if (error.status === 404) {
                            errorMessage = JE.t('jellyseerr_btn_user_not_found');
                        } else if (error.responseJSON?.message) {
                            errorMessage = error.responseJSON.message;
                        }
                        button.innerHTML = `<span>${errorMessage}</span>${icons.error}`;
                        button.classList.add('jellyseerr-button-error');
                    }
                }
            });
        }
    }

    /**
     * Adds download progress hover functionality to a button.
     * @param {HTMLElement} button - Button element.
     * @param {Object} item - Media item with download status.
     */
    function addDownloadProgressHover(button, item) {
        const showPopover = (e) => {
            const popover = fillHoverPopover(item);
            if (popover) {
                const clientX = e.clientX || (e.target.getBoundingClientRect().right);
                const clientY = e.clientY || (e.target.getBoundingClientRect().top - 8);
                positionHoverPopover(popover, clientX, clientY);
                popover.classList.add('show');
                popover.dataset.tmdbId = item.id;
                popover.dataset.clientX = clientX;
                popover.dataset.clientY = clientY;
            }
        };

        button.addEventListener('mouseenter', showPopover);
        button.addEventListener('mousemove', (e) => {
            if (jellyseerrHoverPopover?.classList.contains('show') && !jellyseerrHoverLock) {
                jellyseerrHoverPopover.dataset.clientX = e.clientX;
                jellyseerrHoverPopover.dataset.clientY = e.clientY;
                positionHoverPopover(jellyseerrHoverPopover, e.clientX, e.clientY);
            }
        });
        button.addEventListener('mouseleave', ui.hideHoverPopover);
        button.addEventListener('focus', showPopover);
        button.addEventListener('blur', () => {
            ui.toggleHoverPopoverLock(false);
            ui.hideHoverPopover();
        });
        button.addEventListener('touchstart', (e) => {
            e.preventDefault();
            const popover = fillHoverPopover(item);
            if (popover) {
                const rect = button.getBoundingClientRect();
                ui.toggleHoverPopoverLock();
                if (jellyseerrHoverLock) {
                    const clientX = rect.left + rect.width / 2;
                    const clientY = rect.top - 8;
                    positionHoverPopover(popover, clientX, clientY);
                    popover.classList.add('show');
                    popover.dataset.tmdbId = item.id;
                    popover.dataset.clientX = clientX;
                    popover.dataset.clientY = clientY;
                } else {
                    popover.classList.remove('show');
                }
            }
        }, { passive: false });
    }

    /**
     * Adds media type badge to card.
     * @param {HTMLElement} card - Card element.
     * @param {Object} item - Media item data.
     */
    function addMediaTypeBadge(card, item) {
        if (item.mediaType === 'movie' || item.mediaType === 'tv' || item.mediaType === 'collection') {
            const imageContainer = card.querySelector('.cardImageContainer');
            if (imageContainer) {
                const badge = document.createElement('div');
                badge.className = 'jellyseerr-media-badge';
                if (item.mediaType === 'movie') {
                    badge.classList.add('jellyseerr-media-badge-movie');
                    badge.textContent = JE.t('jellyseerr_card_badge_movie');
                } else if (item.mediaType === 'tv') {
                    badge.classList.add('jellyseerr-media-badge-series');
                    badge.textContent = JE.t('jellyseerr_card_badge_series');
                } else {
                    badge.classList.add('jellyseerr-media-badge-collection');
                    badge.textContent = JE.t('jellyseerr_card_badge_collection');
                }
                imageContainer.appendChild(badge);
            }
        }
    }

    // Adds a small badge indicating the movie belongs to a collection; clicking opens the request modal
    function addCollectionMembershipBadge(card, item) {
        if (!item.collection || item.mediaType !== 'movie') return;
        const imageContainer = card.querySelector('.cardImageContainer');
        if (!imageContainer) return;
        const badge = document.createElement('div');
        badge.className = 'jellyseerr-collection-badge';
        badge.innerHTML = `<span class="material-icons">collections</span><span>${item.collection.name || JE.t('jellyseerr_card_badge_collection')}</span>`;
        badge.title = `Part of ${item.collection.name || 'collection'}`;
        badge.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            ui.showCollectionRequestModal(item.collection.id, item.collection.name, item);
        });
        imageContainer.appendChild(badge);
    }



    /**
     * Shows the advanced request modal for movies.
     * @param {number} tmdbId - TMDB ID of the movie.
     * @param {string} title - Display title of the movie.
     * @param {Object|null} searchResultItem - Original search result data.
     */
    ui.showMovieRequestModal = async function(tmdbId, title, searchResultItem, is4k = false) {
        const { create, createAdvancedOptionsHTML, populateAdvancedOptions } = JE.jellyseerrModal;
        const { requestMedia, fetchAdvancedRequestData, fetchMovieDetails } = JE.jellyseerrAPI;

        const bodyHtml = createAdvancedOptionsHTML('movie');
        const { modalElement, show, close } = create({
            title: JE.t('jellyseerr_modal_title_movie'),
            subtitle: title,
            bodyHtml,
            backdropPath: searchResultItem?.backdropPath,
            onSave: async (modalEl, requestBtn, closeFn) => {
                const serverSelect = modalEl.querySelector('#movie-server');
                const qualitySelect = modalEl.querySelector('#movie-quality');
                const folderSelect = modalEl.querySelector('#movie-folder');

                if (!serverSelect.value || !qualitySelect.value || !folderSelect.value) {
                    JE.toast(JE.t('jellyseerr_modal_toast_options_missing'), 3000);
                    return;
                }

                requestBtn.disabled = true;
                requestBtn.innerHTML = `${JE.t('jellyseerr_modal_requesting')}<span class="jellyseerr-button-spinner"></span>`;
                const settings = { serverId: parseInt(serverSelect.value), profileId: parseInt(qualitySelect.value), rootFolder: folderSelect.value, tags: [] };

                try {
                    await requestMedia(tmdbId, 'movie', settings, is4k, searchResultItem);
                    // Manually update the original button on the card
                    const originalButton = document.querySelector(`.jellyseerr-request-button[data-tmdb-id="${tmdbId}"]`);
                    if (originalButton) {
                        originalButton.innerHTML = `<span>${JE.t('jellyseerr_btn_requested')}</span>${icons.requested}`;
                        originalButton.classList.remove('jellyseerr-button-request');
                        originalButton.classList.add('jellyseerr-button-pending');
                    }
                    closeFn();
                } catch (error) {
                    JE.toast(JE.t('jellyseerr_modal_toast_request_fail'), 4000);
                    requestBtn.disabled = false;
                    requestBtn.textContent = JE.t('jellyseerr_modal_request');
                }
            }
        });
        show();
        try {
            const data = await fetchAdvancedRequestData('movie');
            populateAdvancedOptions(modalElement, data, 'movie');
        } catch (error) {
            console.error(`${logPrefix} Failed to load advanced options:`, error);
            JE.toast('Failed to load server options', 3000);
        }


    };

    /**
     * Shows the enhanced season selection modal for TV shows.
     * @param {number} tmdbId - TMDB ID of the TV show.
     * @param {string} mediaType - Should be 'tv'.
     * @param {string} showTitle - Display title of the show.
     * @param {Object|null} searchResultItem - Original search result data.
     */
    ui.showSeasonSelectionModal = async function(tmdbId, mediaType, showTitle, searchResultItem = null) {
        if (mediaType !== 'tv') return;
        if (refreshModalInterval) {
            clearInterval(refreshModalInterval);
            refreshModalInterval = null;
        }


        const { create, createAdvancedOptionsHTML, populateAdvancedOptions } = JE.jellyseerrModal;
        const { fetchTvShowDetails, requestTvSeasons, fetchAdvancedRequestData, isPartialRequestsEnabled, requestMedia } = JE.jellyseerrAPI;

        // Check if partial requests are enabled
        let partialRequestsEnabled = false;
        try {
            partialRequestsEnabled = await isPartialRequestsEnabled();
        } catch (e) {
            partialRequestsEnabled = false;
        }

        const tvDetails = await fetchTvShowDetails(tmdbId);
        if (!tvDetails?.seasons) {
            JE.toast(JE.t('jellyseerr_toast_no_season_info'), 4000);
            return;
        }

        const showAdvanced = JE.pluginConfig.JellyseerrShowAdvanced;

        // Show season selection UI with Select All checkbox header
        const bodyHtml = `<div class="jellyseerr-season-list">
            ${partialRequestsEnabled ? '<div class="jellyseerr-season-header-row"><input type="checkbox" class="jellyseerr-season-checkbox" id="jellyseerr-select-all-seasons"><label class="jellyseerr-season-header-label" for="jellyseerr-select-all-seasons">' + JE.t('jellyseerr_select_all_seasons') + '</label><div></div><div></div></div>' : ''}
        </div>${showAdvanced ? createAdvancedOptionsHTML('tv') : ''}`;
        const modalInstance = create({
            title: JE.t('jellyseerr_modal_title'),
            subtitle: showTitle,
            bodyHtml,
            backdropPath: tvDetails.backdropPath,
            onClose: () => {
                if (refreshModalInterval) {
                    clearInterval(refreshModalInterval);
                    refreshModalInterval = null;
                }
            },
            onSave: async (modalEl, requestBtn, closeFn) => {
                requestBtn.disabled = true;
                requestBtn.innerHTML = `${JE.t('jellyseerr_modal_requesting')}<span class="jellyseerr-button-spinner"></span>`;

                let settings = {};
                if (showAdvanced) {
                    const server = modalEl.querySelector('#tv-server').value;
                    const quality = modalEl.querySelector('#tv-quality').value;
                    const folder = modalEl.querySelector('#tv-folder').value;
                    if (!server || !quality || !folder) {
                        JE.toast(JE.t('jellyseerr_modal_toast_options_missing'), 3000);
                        requestBtn.disabled = false;
                        requestBtn.textContent = partialRequestsEnabled ? JE.t('jellyseerr_modal_request_selected') : JE.t('jellyseerr_modal_request');
                        return;
                    }
                    settings = { serverId: parseInt(server), profileId: parseInt(quality), rootFolder: folder, tags: [] };
                }

                try {
                    if (partialRequestsEnabled) {
                        // Partial requests enabled: request selected seasons (exclude the Select All checkbox)
                        const selectedSeasons = Array.from(modalEl.querySelectorAll('.jellyseerr-season-item .jellyseerr-season-checkbox:checked')).map(cb => parseInt(cb.dataset.seasonNumber));
                        if (selectedSeasons.length === 0) {
                            JE.toast(JE.t('jellyseerr_modal_toast_select_season'), 3000);
                            requestBtn.disabled = false;
                            requestBtn.textContent = JE.t('jellyseerr_modal_request_selected');
                            return;
                        }
                        await requestTvSeasons(tmdbId, selectedSeasons, settings, searchResultItem);
                        JE.toast(JE.t('jellyseerr_modal_toast_request_success', { count: selectedSeasons.length, title: showTitle }), 4000);
                    } else {
                        // Partial requests disabled: request all seasons
                        await requestMedia(tmdbId, 'tv', settings, false, searchResultItem);
                        JE.toast(JE.t('jellyseerr_modal_toast_request_success', { count: 'all', title: showTitle }), 4000);
                    }
                    // Notify any listening modals that TV was requested
                    document.dispatchEvent(new CustomEvent('jellyseerr-tv-requested', { detail: { tmdbId, mediaType: 'tv' } }));
                    document.dispatchEvent(new CustomEvent('jellyseerr-media-requested', { detail: { tmdbId, mediaType: 'tv' } }));

                    // Update original card button to pending state
                    markCardRequested(tmdbId, 'tv');

                    closeFn();
                    setTimeout(() => {
                        const query = new URLSearchParams(window.location.hash.split('?')[1])?.get('query');
                        if (query) {
                            const mainController = JE.jellyseerr;
                            if (mainController) {
                                mainController.fetchAndRenderResults(query);
                            }
                        }
                    }, 1000);
                } catch (error) {
                    JE.toast(JE.t('jellyseerr_modal_toast_request_fail'), 4000);
                    requestBtn.disabled = false;
                    requestBtn.textContent = partialRequestsEnabled ? JE.t('jellyseerr_modal_request_selected') : JE.t('jellyseerr_modal_request');
                }
            }
        });

        // Populate season list inside the modal
        const seasonList = modalInstance.modalElement.querySelector('.jellyseerr-season-list');
        updateSeasonList(seasonList, tvDetails, partialRequestsEnabled);
        modalInstance.show();

        // Add Select All checkbox functionality
        if (partialRequestsEnabled) {
            const selectAllCheckbox = modalInstance.modalElement.querySelector('#jellyseerr-select-all-seasons');
            if (selectAllCheckbox) {
                // Update Select All checkbox state when individual checkboxes change
                const updateSelectAllState = () => {
                    const allSeasonCheckboxes = seasonList.querySelectorAll('.jellyseerr-season-item .jellyseerr-season-checkbox:not(:disabled)');
                    const checkedCount = seasonList.querySelectorAll('.jellyseerr-season-item .jellyseerr-season-checkbox:not(:disabled):checked').length;
                    selectAllCheckbox.checked = checkedCount > 0 && checkedCount === allSeasonCheckboxes.length;
                    selectAllCheckbox.indeterminate = checkedCount > 0 && checkedCount < allSeasonCheckboxes.length;
                };

                // Handle Select All checkbox click
                selectAllCheckbox.addEventListener('change', () => {
                    const allSeasonCheckboxes = seasonList.querySelectorAll('.jellyseerr-season-item .jellyseerr-season-checkbox:not(:disabled)');
                    allSeasonCheckboxes.forEach(checkbox => {
                        checkbox.checked = selectAllCheckbox.checked;
                    });
                });

                // Add change listeners to individual season checkboxes
                seasonList.addEventListener('change', (e) => {
                    if (e.target.classList.contains('jellyseerr-season-checkbox') && e.target.id !== 'jellyseerr-select-all-seasons') {
                        updateSelectAllState();
                    }
                });

                // Initialize Select All state
                updateSelectAllState();

                seasonList._updateSelectAllState = updateSelectAllState;
            }
        }


        // Start polling for updates when the modal is shown
        refreshModalInterval = setInterval(async () => {
            const freshTvDetails = await fetchTvShowDetails(tmdbId);
            if (freshTvDetails) {
                updateSeasonList(seasonList, freshTvDetails, partialRequestsEnabled);
                // Update Select All state after refresh
                if (seasonList._updateSelectAllState) {
                    seasonList._updateSelectAllState();
                }
            }
        }, 10000); // Refresh every 10 seconds

        if (showAdvanced) {
            try {
                const data = await fetchAdvancedRequestData('tv');
                populateAdvancedOptions(modalInstance.modalElement, data, 'tv');
            } catch (error) {
                console.error(`${logPrefix} Failed to load TV advanced options:`, error);
                JE.toast('Failed to load server options', 3000);
            }
        }
    };

    function updateSeasonList(seasonListElement, tvDetails, partialRequestsEnabled = true) {
        if (!seasonListElement || !tvDetails) return;

        const seasonStatusMap = {};
        tvDetails.mediaInfo?.seasons?.forEach(s => { seasonStatusMap[s.seasonNumber] = s.status; });
        tvDetails.mediaInfo?.requests?.forEach(r => r.seasons?.forEach(sr => { seasonStatusMap[sr.seasonNumber] = sr.status; }));

        tvDetails.seasons.filter(s => s.seasonNumber > 0).forEach(season => {
            const seasonNumber = season.seasonNumber;
            let seasonItem = seasonListElement.querySelector(`.jellyseerr-season-item[data-season-number="${seasonNumber}"]`);

            // If the season item doesn't exist, create it
            if (!seasonItem) {
                seasonItem = document.createElement('div');
                seasonItem.className = 'jellyseerr-season-item';
                seasonItem.dataset.seasonNumber = seasonNumber;
                seasonListElement.appendChild(seasonItem);
            }

            const apiStatus = seasonStatusMap[seasonNumber];
            const canRequest = !apiStatus || apiStatus === 1 || apiStatus === 7;

            let statusText = JE.t('jellyseerr_season_status_not_requested'), statusClass = 'not-requested';
            switch (apiStatus) {
                case 2:
                case 3: statusText = JE.t('jellyseerr_season_status_requested'); statusClass = 'processing'; break;
                case 4: statusText = JE.t('jellyseerr_season_status_partial'); statusClass = 'partially-available'; break;
                case 5: statusText = JE.t('jellyseerr_season_status_available'); statusClass = 'available'; break;
            }

            if ((apiStatus === 2 || apiStatus === 3) && tvDetails.mediaInfo?.downloadStatus?.some(ds => ds.episode?.seasonNumber === seasonNumber)) {
                statusText = JE.t('jellyseerr_season_status_processing');
            }

            // Update the content but preserve the checkbox state if it exists
            const existingCheckbox = seasonItem.querySelector('.jellyseerr-season-checkbox');
            const isChecked = existingCheckbox ? existingCheckbox.checked : false;

            // Disable checkbox if partial requests are disabled OR if the season can't be requested
            const checkboxDisabled = !partialRequestsEnabled || !canRequest;

            seasonItem.innerHTML = `
                <input type="checkbox" class="jellyseerr-season-checkbox" data-season-number="${seasonNumber}" ${checkboxDisabled ? 'disabled' : ''} style="${!partialRequestsEnabled ? 'cursor: not-allowed;' : ''}">
                <div class="jellyseerr-season-info">
                    <div class="jellyseerr-season-name">${season.name || `Season ${seasonNumber}`}</div>
                    <div class="jellyseerr-season-meta">${season.airDate ? season.airDate.substring(0, 4) : ''}</div>
                </div>
                <div class="jellyseerr-season-episodes">${season.episodeCount || 0} ep</div>
                <div class="jellyseerr-season-status jellyseerr-season-status-${statusClass}">${statusText}</div>
            `;

            if(existingCheckbox) {
                seasonItem.querySelector('.jellyseerr-season-checkbox').checked = isChecked;
            }

            seasonItem.classList.toggle('disabled', !canRequest);

            // Add/Update inline download progress
            const existingProgress = seasonItem.querySelector('.jellyseerr-inline-progress');
            if (existingProgress) existingProgress.remove();

            if ((apiStatus === 2 || apiStatus === 3) && tvDetails.mediaInfo?.downloadStatus?.length > 0) {
                const seasonDownloads = tvDetails.mediaInfo.downloadStatus.filter(ds => ds.episode?.seasonNumber === seasonNumber);
                if (seasonDownloads.length > 0) {
                    const totalSize = seasonDownloads.reduce((sum, ds) => sum + (ds.size || 0), 0);
                    const totalSizeLeft = seasonDownloads.reduce((sum, ds) => sum + (ds.sizeLeft || 0), 0);
                    if (totalSize > 0) {
                        const aggregatedStatus = { size: totalSize, sizeLeft: totalSizeLeft, status: `${seasonDownloads.length} episode(s) downloading` };
                        const progressElement = createInlineProgress(aggregatedStatus);
                        if (progressElement) seasonItem.appendChild(progressElement);
                    }
                }
            }
        });
    }

    /**
     * Shows a modal for requesting a collection (all movies in a TMDB collection).
     * @param {number} collectionId - The TMDB collection ID.
     * @param {string} collectionName - The name of the collection.
     * @param {object} searchResultItem - Optional search result item data.
     */
    ui.showCollectionRequestModal = async function(collectionId, collectionName, searchResultItem = null) {
        const { create, createAdvancedOptionsHTML, populateAdvancedOptions } = JE.jellyseerrModal;
        const { fetchCollectionDetails, requestMedia, fetchAdvancedRequestData } = JE.jellyseerrAPI;

        // Fetch collection details
        let collectionDetails;
        try {
            collectionDetails = await fetchCollectionDetails(collectionId);
        } catch (error) {
            JE.toast(JE.t('jellyseerr_toast_collection_fetch_failed'), 4000);
            return;
        }

        if (!collectionDetails?.parts || collectionDetails.parts.length === 0) {
            JE.toast(JE.t('jellyseerr_toast_no_movies_in_collection'), 4000);
            return;
        }

        const showAdvanced = JE.pluginConfig.JellyseerrShowAdvanced;

        // Create checkbox list of movies in the collection with posters and status badges
        const movieListHtml = collectionDetails.parts.map(movie => {
            const status = movie.mediaInfo?.status || 1; // 1 = not available, 2 = requested, 3 = pending/processing, 4 = partially available, 5 = available
            const downloads = movie.mediaInfo?.downloadStatus || [];
            const hasActiveDownloads = downloads && downloads.length > 0;
            const isAvailable = status === 5;
            const isRequested = status === 2 || status === 3;
            const isDisabled = isAvailable || isRequested;

            let statusClass = 'not-requested';
            let statusText = JE.t('jellyseerr_season_status_not_requested') || 'Not Requested';

            if (status === 5) {
                statusClass = 'available';
                statusText = JE.t('jellyseerr_btn_available') || 'Available';
            } else if (status === 4) {
                statusClass = 'partially-available';
                statusText = JE.t('jellyseerr_btn_partially_available') || 'Partially Available';
            } else if (status === 3) {
                if (hasActiveDownloads) {
                    statusClass = 'processing';
                    statusText = JE.t('jellyseerr_btn_processing') || 'Processing';
                } else {
                    statusClass = 'pending';
                    statusText = JE.t('jellyseerr_btn_requested') || 'Requested';
                }
            } else if (status === 2) {
                statusClass = 'pending';
                statusText = JE.t('jellyseerr_btn_pending') || 'Pending';
            }

            const year = movie.releaseDate ? new Date(movie.releaseDate).getFullYear() : '';
            const poster = movie.posterPath
                ? `https://image.tmdb.org/t/p/w92${movie.posterPath}`
                : 'https://i.ibb.co/fdbkXQdP/jellyseerr-poster-not-found.png';

            return `
                <div class="jellyseerr-collection-movie-row">
                    <input type="checkbox"
                           class="jellyseerr-collection-checkbox"
                           id="movie-${movie.id}"
                           data-tmdb-id="${movie.id}"
                           ${isDisabled ? 'disabled' : 'checked'}>
                    <img src="${poster}" alt="${movie.title}" class="jellyseerr-collection-movie-poster">
                    <div class="jellyseerr-collection-movie-details">
                        <div class="title">${movie.title}</div>
                        <div class="year">${year}</div>
                    </div>
                    <div class="jellyseerr-season-status jellyseerr-season-status-${statusClass}">${statusText}</div>
                </div>
            `;
        }).join('');

        const bodyHtml = `
            <div class="jellyseerr-collection-list" style="max-height: 600px; overflow-y: auto;">
                <div class="jellyseerr-collection-header-row">
                    <input type="checkbox" class="jellyseerr-collection-checkbox" id="jellyseerr-select-all-movies">
                    <label class="jellyseerr-collection-header-label" for="jellyseerr-select-all-movies">${JE.t('jellyseerr_select_all_movies') || 'Select All'}</label>
                    <div></div>
                    <div></div>
                </div>
                ${movieListHtml}
            </div>
            ${showAdvanced ? createAdvancedOptionsHTML('movie') : ''}
        `;

        const modalInstance = create({
            title: JE.t('jellyseerr_modal_request_collection') || 'Request Collection',
            subtitle: collectionName,
            bodyHtml,
            backdropPath: collectionDetails.backdrop_path || collectionDetails.backdropPath,
            buttonText: JE.t('jellyseerr_modal_request_selected_movies') || 'Request Selected Movies',
            onSave: async (modalEl, requestBtn, closeFn) => {
                requestBtn.disabled = true;
                requestBtn.innerHTML = `${JE.t('jellyseerr_modal_requesting') || 'Requesting'}<span class="jellyseerr-button-spinner"></span>`;

                let settings = {};
                if (showAdvanced) {
                    const server = modalEl.querySelector('#movie-server').value;
                    const quality = modalEl.querySelector('#movie-quality').value;
                    const folder = modalEl.querySelector('#movie-folder').value;
                    if (!server || !quality || !folder) {
                        JE.toast(JE.t('jellyseerr_modal_toast_options_missing') || 'Please select all options', 3000);
                        requestBtn.disabled = false;
                        requestBtn.textContent = JE.t('jellyseerr_modal_request_selected_movies') || 'Request Selected Movies';
                        return;
                    }
                    settings = { serverId: parseInt(server), profileId: parseInt(quality), rootFolder: folder, tags: [] };
                }

                try {
                    const selectedMovies = Array.from(modalEl.querySelectorAll('.jellyseerr-collection-movie-row .jellyseerr-collection-checkbox:checked:not(:disabled)'))
                        .map(cb => parseInt(cb.dataset.tmdbId));

                    if (selectedMovies.length === 0) {
                        JE.toast(JE.t('jellyseerr_modal_toast_select_movie') || 'Please select at least one movie', 3000);
                        requestBtn.disabled = false;
                        requestBtn.textContent = JE.t('jellyseerr_modal_request_selected_movies') || 'Request Selected Movies';
                        return;
                    }

                    let successCount = 0;
                    for (const tmdbId of selectedMovies) {
                        try {
                            await requestMedia(tmdbId, 'movie', settings, false, searchResultItem);
                            successCount++;
                        } catch (error) {
                            console.error(`Failed to request movie ${tmdbId}:`, error);
                        }
                    }

                    JE.toast(`${JE.t('jellyseerr_toast_collection_requested') || 'Requested'} ${successCount} of ${selectedMovies.length} ${JE.t('jellyseerr_toast_movies') || 'movies'}`, 4000);
                    closeFn();

                    // Refresh search results
                    setTimeout(() => {
                        const query = new URLSearchParams(window.location.hash.split('?')[1])?.get('query');
                        if (query) {
                            const mainController = JE.jellyseerr;
                            if (mainController) {
                                mainController.fetchAndRenderResults(query);
                            }
                        }
                    }, 1000);
                } catch (error) {
                    JE.toast(JE.t('jellyseerr_modal_toast_request_fail') || 'Request failed', 4000);
                    requestBtn.disabled = false;
                    requestBtn.textContent = JE.t('jellyseerr_modal_request_selected_movies') || 'Request Selected Movies';
                }
            }
        });

        // Populate advanced options if needed
        if (showAdvanced) {
            try {
                const advancedData = await fetchAdvancedRequestData('movie');
                populateAdvancedOptions(modalInstance.modalElement, advancedData, 'movie');
            } catch (error) {
                console.error('Failed to load advanced options:', error);
            }
        }

        modalInstance.show();

        // Add Select All checkbox functionality
        const selectAllCheckbox = modalInstance.modalElement.querySelector('#jellyseerr-select-all-movies');
        const movieList = modalInstance.modalElement.querySelector('.jellyseerr-collection-list');

        if (selectAllCheckbox && movieList) {
            const updateSelectAllState = () => {
                const allCheckboxes = movieList.querySelectorAll('.jellyseerr-collection-movie-row .jellyseerr-collection-checkbox:not(:disabled)');
                const checkedCount = movieList.querySelectorAll('.jellyseerr-collection-movie-row .jellyseerr-collection-checkbox:not(:disabled):checked').length;
                selectAllCheckbox.checked = checkedCount > 0 && checkedCount === allCheckboxes.length;
                selectAllCheckbox.indeterminate = checkedCount > 0 && checkedCount < allCheckboxes.length;
            };

            selectAllCheckbox.addEventListener('change', () => {
                const allCheckboxes = movieList.querySelectorAll('.jellyseerr-collection-movie-row .jellyseerr-collection-checkbox:not(:disabled)');
                allCheckboxes.forEach(checkbox => {
                    checkbox.checked = selectAllCheckbox.checked;
                });
            });

            movieList.addEventListener('change', (e) => {
                if (e.target.classList.contains('jellyseerr-collection-checkbox') && e.target.id !== 'jellyseerr-select-all-movies') {
                    updateSelectAllState();
                }
            });

            updateSelectAllState();
        }
    };

    /**
     * Updates existing Jellyseerr results in the DOM with fresh data.
     * @param {Array} newResults - The new array of result items from the API.
     * @param {boolean} isJellyseerrActive - If the server is reachable.
     * @param {boolean} jellyseerrUserFound - If the current user is linked.
     */
    ui.updateJellyseerrResults = function(newResults, isJellyseerrActive, jellyseerrUserFound) {
        const existingButtons = document.querySelectorAll('.jellyseerr-request-button[data-tmdb-id]');
        if (existingButtons.length === 0) return;

        existingButtons.forEach(button => {
            const tmdbId = button.dataset.tmdbId;
            const newItem = newResults.find(item => item.id.toString() === tmdbId);
            if (!newItem) return;

            const oldItemJSON = button.dataset.searchResultItem;
            if (!oldItemJSON) return;

            // Simple check: compare JSON strings of mediaInfo
            const oldMediaInfo = JSON.parse(oldItemJSON).mediaInfo;
            const newMediaInfo = newItem.mediaInfo;
            if (JSON.stringify(oldMediaInfo) !== JSON.stringify(newMediaInfo)) {
                console.log(`${logPrefix} Status change detected for TMDB ID ${tmdbId}. Updating button.`);
                configureRequestButton(button, newItem, isJellyseerrActive, jellyseerrUserFound);

                // If the popover for this item is currently visible, update it
                if (jellyseerrHoverPopover &&
                    jellyseerrHoverPopover.classList.contains('show') &&
                    jellyseerrHoverPopover.dataset.tmdbId === tmdbId) {

                    console.log(`${logPrefix} Active popover found for TMDB ID ${tmdbId}. Refreshing content.`);
                    const popoverContent = fillHoverPopover(newItem);
                    if (popoverContent) {
                        const { clientX, clientY } = jellyseerrHoverPopover.dataset;
                        positionHoverPopover(popoverContent, parseFloat(clientX), parseFloat(clientY));
                    } else {
                        ui.hideHoverPopover(); // Hide if there's no longer valid download data
                    }
                }
            }
        });
    };
    // Expose the UI module on the global JE object
    ui.icons = icons;
    ui.configureRequestButton = configureRequestButton;
    ui.createJellyseerrCard = createJellyseerrCard;
    ui.formatEtaText = formatEtaText;
    JE.jellyseerrUI = ui;

})(window.JellyfinEnhanced);
