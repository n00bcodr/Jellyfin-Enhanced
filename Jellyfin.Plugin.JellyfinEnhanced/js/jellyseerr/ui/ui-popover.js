// /js/jellyseerr/ui/ui-popover.js
// Download-progress hover popover and the 4K request popup.
(function(JE) {
    'use strict';

    const ui = JE.jellyseerrUI = JE.jellyseerrUI || {};
    JE.internals = JE.internals || {};
    // Shared state is seeded by ui-icons.js, which plugin.js loads first
    // in this group.
    const internal = JE.internals.jellyseerrUi;
    const logPrefix = '🪼 Jellyfin Enhanced: Seerr UI:';
    const DisplayStatus = JE.seerrStatus.DISPLAY;
    const state = internal.state;
    const escapeHtml = JE.escapeHtml;
    const icons = internal.icons; // requires ui-icons.js to be loaded first
    const addTouchTapListener = JE.core.ui.addTouchTapListener;

    // ================================
    // DOWNLOAD PROGRESS POPOVER SYSTEM
    // ================================

    /**
     * Creates or returns existing hover popover element.
     * Used for showing download progress on hover/focus.
     */
    function ensureHoverPopover() {
        if (!state.jellyseerrHoverPopover) {
            state.jellyseerrHoverPopover = document.createElement('div');
            state.jellyseerrHoverPopover.className = 'jellyseerr-hover-popover';
            document.body.appendChild(state.jellyseerrHoverPopover);
        }
        return state.jellyseerrHoverPopover;
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

        // Download status fields originate from the Jellyseerr API and must be
        // escaped before interpolation into HTML to prevent stored XSS.
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
                        <div class="title">${escapeHtml(downloadStatus.title) || JE.t('jellyseerr_popover_downloading')}</div>
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
                        <div class="title">${escapeHtml(downloadStatus.title) || JE.t('jellyseerr_popover_downloading')}</div>
                        <div class="jellyseerr-hover-progress"><div class="bar" style="width:${percentage}%;"></div></div>
                        <div class="row">
                            <div>${percentage}%</div>
                            <div class="status">${escapeHtml(statusDisplay)}</div>
                            ${etaText ? `<div class="eta">${escapeHtml(etaText)}</div>` : ''}
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
        if (state.jellyseerrHoverPopover && !state.jellyseerrHoverLock) {
            state.jellyseerrHoverPopover.classList.remove('show');
            delete state.jellyseerrHoverPopover.dataset.tmdbId;
            delete state.jellyseerrHoverPopover.dataset.clientX;
            delete state.jellyseerrHoverPopover.dataset.clientY;
        }
    };

    /**
     * Toggles the lock state for the hover popover, used for mobile tap interactions.
     * @param {boolean} [lockState] - Optional state to force lock/unlock. Toggles if omitted.
     */
    ui.toggleHoverPopoverLock = function(lockState) {
        state.jellyseerrHoverLock = typeof lockState === 'boolean' ? lockState : !state.jellyseerrHoverLock;
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
        if (state.active4KPopup) {
            state.active4KPopup.remove();
            state.active4KPopup = null;
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

        const popupDs4k = JE.seerrStatus.resolveDisplayStatus(status4k, false);
        if (popupDs4k === DisplayStatus.AVAILABLE) {
            request4KBtn.innerHTML = `<span>4K Available</span>${icons.available}`;
            request4KBtn.disabled = true;
            request4KBtn.classList.add('jellyseerr-4k-available', 'chip-available');
        } else if (popupDs4k === DisplayStatus.PENDING || popupDs4k === DisplayStatus.REQUESTED || popupDs4k === DisplayStatus.PROCESSING) {
            request4KBtn.innerHTML = `<span>4K Requested</span>${icons.pending}`;
            request4KBtn.disabled = true;
            request4KBtn.classList.add(popupDs4k === DisplayStatus.PROCESSING ? 'chip-processing' : 'chip-pending');
        } else if (popupDs4k === DisplayStatus.BLOCKED) {
            request4KBtn.innerHTML = `<span>${JE.t('jellyseerr_btn_blocklisted')}</span>${icons.cancel}`;
            request4KBtn.disabled = true;
            request4KBtn.classList.add('chip-blocklisted');
        } else {
            request4KBtn.innerHTML = `<span>${JE.t('jellyseerr_btn_request_4k')}</span>`;
            request4KBtn.dataset.tmdbId = item.id;
            request4KBtn.dataset.mediaType = item.mediaType || 'movie';
            request4KBtn.dataset.action = 'request4k';
            request4KBtn.classList.add('chip-requested');
        }

        popup.appendChild(request4KBtn);
        document.body.appendChild(popup);
        state.active4KPopup = popup;

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
            if (state.jellyseerrHoverPopover?.classList.contains('show') && !state.jellyseerrHoverLock) {
                state.jellyseerrHoverPopover.dataset.clientX = e.clientX;
                state.jellyseerrHoverPopover.dataset.clientY = e.clientY;
                positionHoverPopover(state.jellyseerrHoverPopover, e.clientX, e.clientY);
            }
        });
        button.addEventListener('mouseleave', ui.hideHoverPopover);
        button.addEventListener('focus', showPopover);
        button.addEventListener('blur', () => {
            ui.toggleHoverPopoverLock(false);
            ui.hideHoverPopover();
        });
        // Tap (not swipe) toggles the popover; swipes starting on the request
        // button keep scrolling the results row natively.
        addTouchTapListener(button, (e) => {
            e.preventDefault();
            const popover = fillHoverPopover(item);
            if (popover) {
                const rect = button.getBoundingClientRect();
                ui.toggleHoverPopoverLock();
                if (state.jellyseerrHoverLock) {
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
        });
    }
    ui.formatEtaText = formatEtaText;

    internal.ensureHoverPopover = ensureHoverPopover;
    internal.formatEtaText = formatEtaText;
    internal.fillHoverPopover = fillHoverPopover;
    internal.positionHoverPopover = positionHoverPopover;
    internal.createInlineProgress = createInlineProgress;
    internal.hide4KPopup = hide4KPopup;
    internal.show4KPopup = show4KPopup;
    internal.addDownloadProgressHover = addDownloadProgressHover;

})(window.JellyfinEnhanced);
