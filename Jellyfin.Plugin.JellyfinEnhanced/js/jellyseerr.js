// /js/jellyseerr.js
(function(JE) {
    'use strict';

    /**
     * Initializes the Jellyseerr search integration feature.
     */
    JE.initializeJellyseerrScript = function() {
        const logPrefix = '🪼 Jellyfin Enhanced: Jellyseerr Search:';
        if (!JE.pluginConfig.JellyseerrEnabled) {
            console.log(`${logPrefix} Integration is disabled in plugin settings.`);
            return;
        }

        console.log(`${logPrefix} Initializing....`);

        let lastProcessedQuery = null;
        let debounceTimeout = null;
        let isJellyseerrActive = false;
        let jellyseerrUserFound = false;
        let jellyseerrHoverPopover = null,
            jellyseerrHoverLock = false; // lock = mobile toggle
        let isJellyseerrOnlyMode = false; // New state for filter mode
        let hiddenSections = []; // Store hidden sections for restoration
        let jellyseerrOriginalPosition = null; // Store original position marker
        let seasonModalCache = new Map(); // Cache for TV show season data

        // SVG Icons definition
        const icons = {
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
            request: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" role="img" style="margin-right:0.5em;"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"></path></svg>',
            close: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>'
        };


        function ensureHoverPop() {
            if (!jellyseerrHoverPopover) {
                jellyseerrHoverPopover = document.createElement('div');
                jellyseerrHoverPopover.className = 'jellyseerr-hover-popover';
                document.body.appendChild(jellyseerrHoverPopover);
            }
            return jellyseerrHoverPopover;
        }

        function fillHoverPop(item) {
            const ds = item.mediaInfo?.downloadStatus?.[0] || item.mediaInfo?.downloadStatus4k?.[0];
            if (!ds || typeof ds.size !== 'number' || typeof ds.sizeLeft !== 'number' || ds.size <= 0) return null;
            const pct = Math.max(0, Math.min(100, Math.round(100 * (1 - ds.sizeLeft / ds.size))));
            const el = ensureHoverPop();
            el.innerHTML = `
                <div class="title">${ds.title || 'Downloading'}</div>
                 <div class="jellyseerr-hover-progress"><div class="bar" style="width:${pct}%;"></div></div>
                <div class="row"><div>${pct}%</div><div class="status">${(ds.status||'downloading').toString().replace(/^./,c=>c.toUpperCase())}</div></div>
            `;
            return el;
        }

        function positionHoverPop(el, x, y) { // keep on-screen
            const pad = 12,
                rect = el.getBoundingClientRect();
            let nx = Math.min(Math.max(x + 14, pad), window.innerWidth - rect.width - pad);
            let ny = Math.min(Math.max(y - rect.height - 14, pad), window.innerHeight - rect.height - pad);
            el.style.transform = `translate(${nx}px, ${ny}px)`;
        }

        function hideHoverPop() {
            if (jellyseerrHoverPopover && !jellyseerrHoverLock) {
                jellyseerrHoverPopover.classList.remove('show');
            }
        }

        // Season Modal Functions
        function createSeasonModal() {
            const modal = document.createElement('div');
            modal.className = 'jellyseerr-season-modal-overlay';
            modal.innerHTML = `
                <div class="jellyseerr-season-modal">
                    <div class="jellyseerr-season-modal-header">
                        <h2 class="jellyseerr-season-modal-title">Request Series</h2>
                        <button class="jellyseerr-season-modal-close" type="button">
                            ${icons.close}
                        </button>
                    </div>
                    <div class="jellyseerr-season-modal-subtitle"></div>
                    <div class="jellyseerr-season-modal-content">
                        <div class="jellyseerr-season-list-header">
                            <span class="jellyseerr-season-header-text">SEASON</span>
                            <span class="jellyseerr-season-header-text"># OF EPISODES</span>
                            <span class="jellyseerr-season-header-text">STATUS</span>
                        </div>
                        <div class="jellyseerr-season-list"></div>
                    </div>
                    <div class="jellyseerr-season-modal-footer">
                        <button class="jellyseerr-season-modal-cancel" type="button">Cancel</button>
                        <button class="jellyseerr-season-modal-submit" type="button">Select Season(s)</button>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);
            return modal;
        }

        function showSeasonModal(item, originalButton) {
            const modal = createSeasonModal();
            const tmdbId = item.id;

            // Update modal title and subtitle
            const titleEl = modal.querySelector('.jellyseerr-season-modal-title');
            const subtitleEl = modal.querySelector('.jellyseerr-season-modal-subtitle');
            titleEl.textContent = 'Request Series';
            subtitleEl.textContent = item.title || item.name;

            // Show loading state
            const seasonList = modal.querySelector('.jellyseerr-season-list');
            seasonList.innerHTML = '<div class="jellyseerr-season-loading">Loading seasons...</div>';

            // Fetch TV show details including seasons
            fetchTvShowDetails(tmdbId).then(tvDetails => {
                if (tvDetails && tvDetails.seasons) {
                    renderSeasonList(seasonList, tvDetails, originalButton);
                } else {
                    seasonList.innerHTML = '<div class="jellyseerr-season-error">Failed to load seasons</div>';
                }
            }).catch(error => {
                console.error(`${logPrefix} Error fetching TV details:`, error);
                seasonList.innerHTML = '<div class="jellyseerr-season-error">Failed to load seasons</div>';
            });

            // Add event listeners
            const closeBtn = modal.querySelector('.jellyseerr-season-modal-close');
            const cancelBtn = modal.querySelector('.jellyseerr-season-modal-cancel');
            const submitBtn = modal.querySelector('.jellyseerr-season-modal-submit');

            const closeModal = () => {
                document.body.removeChild(modal);
            };

            closeBtn.addEventListener('click', closeModal);
            cancelBtn.addEventListener('click', closeModal);
            modal.addEventListener('click', (e) => {
                if (e.target === modal) closeModal();
            });

            // Handle season submission
            submitBtn.addEventListener('click', () => {
                const selectedSeasons = Array.from(modal.querySelectorAll('.jellyseerr-season-toggle:checked'))
                    .map(checkbox => parseInt(checkbox.dataset.seasonNumber));

                if (selectedSeasons.length === 0) {
                    JE.toast('⚠️ Please select at least one season', 3000);
                    return;
                }

                closeModal();
                requestTvSeasons(tmdbId, selectedSeasons, originalButton);
            });

            // Show modal with animation
            requestAnimationFrame(() => {
                modal.classList.add('show');
            });
        }

        function renderSeasonList(container, tvDetails, originalButton) {
            container.innerHTML = '';

            if (!tvDetails.seasons || tvDetails.seasons.length === 0) {
                container.innerHTML = '<div class="jellyseerr-season-error">No seasons found</div>';
                return;
            }

            // Filter out season 0 (specials) and sort by season number
            const validSeasons = tvDetails.seasons
                .filter(season => season.seasonNumber > 0)
                .sort((a, b) => a.seasonNumber - b.seasonNumber);

            validSeasons.forEach(season => {
                const seasonItem = document.createElement('div');
                seasonItem.className = 'jellyseerr-season-item';

                // Determine season status from existing media info
                const seasonStatus = getSeasonStatus(tvDetails, season.seasonNumber);
                const statusText = getSeasonStatusText(seasonStatus);
                const statusClass = getSeasonStatusClass(seasonStatus);

                seasonItem.innerHTML = `
                    <div class="jellyseerr-season-toggle-container">
                        <label class="jellyseerr-season-toggle-label">
                            <input type="checkbox" class="jellyseerr-season-toggle"
                                   data-season-number="${season.seasonNumber}"
                                   ${seasonStatus === 1 ? 'checked' : ''}
                                   ${seasonStatus !== 1 ? 'disabled' : ''}>
                            <span class="jellyseerr-season-toggle-slider"></span>
                        </label>
                    </div>
                    <div class="jellyseerr-season-info">
                        <span class="jellyseerr-season-name">Season ${season.seasonNumber}</span>
                    </div>
                    <div class="jellyseerr-season-episodes">
                        <span>${season.episodeCount} Episode${season.episodeCount !== 1 ? 's' : ''}</span>
                    </div>
                    <div class="jellyseerr-season-status">
                        <span class="jellyseerr-season-status-badge ${statusClass}">${statusText}</span>
                    </div>
                `;

                container.appendChild(seasonItem);
            });
        }

        function getSeasonStatus(tvDetails, seasonNumber) {
            // Check if we have media info for this specific season
            if (tvDetails.mediaInfo && tvDetails.mediaInfo.seasons) {
                const seasonInfo = tvDetails.mediaInfo.seasons.find(s => s.seasonNumber === seasonNumber);
                if (seasonInfo) {
                    return seasonInfo.status;
                }
            }
            // Default to not requested if no specific season info
            return 1; // Not requested
        }

        function getSeasonStatusText(status) {
            switch (status) {
                case 1: return 'Not Requested';
                case 2: return 'Pending';
                case 3: return 'Requested';
                case 4: return 'Partially Available';
                case 5: return 'Available';
                case 6: return 'Rejected';
                default: return 'Unknown';
            }
        }

        function getSeasonStatusClass(status) {
            switch (status) {
                case 1: return 'not-requested';
                case 2: return 'pending';
                case 3: return 'requested';
                case 4: return 'partially-available';
                case 5: return 'available';
                case 6: return 'rejected';
                default: return 'unknown';
            }
        }

        async function fetchTvShowDetails(tmdbId) {
            try {
                const data = await ApiClient.ajax({
                    type: 'GET',
                    url: ApiClient.getUrl(`/JellyfinEnhanced/jellyseerr/tv/${tmdbId}`),
                    dataType: 'json',
                    headers: {
                        'X-Jellyfin-User-Id': ApiClient.getCurrentUserId()
                    }
                });

                // Cache the result
                seasonModalCache.set(tmdbId, data);
                return data;
            } catch (error) {
                console.error(`${logPrefix} Error fetching TV show details:`, error);
                throw error;
            }
        }

        async function requestTvSeasons(tmdbId, seasonNumbers, button) {
            button.disabled = true;
            button.innerHTML = `<span>Requesting ${seasonNumbers.length} Season${seasonNumbers.length > 1 ? 's' : ''}</span><span class="jellyseerr-button-spinner"></span>`;

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

                const seasonText = seasonNumbers.length === 1 ? `Season ${seasonNumbers[0]}` : `${seasonNumbers.length} Seasons`;
                button.innerHTML = `<span>${seasonText} Requested ${icons.requested}</span>`;
                button.classList.remove('jellyseerr-button-request');
                button.classList.add('jellyseerr-button-pending');

                // Clear cache to force refresh on next request
                seasonModalCache.delete(tmdbId);

            } catch (error) {
                button.disabled = false;
                const userId = ApiClient.getCurrentUserId();
                const errorDetails = error.responseJSON || error;
                console.error(`${logPrefix} Season request failed for user ${userId}. Request Body:`, JSON.stringify(requestBody), 'Error:', errorDetails);

                let errorMessage = 'Error';
                if (error.status === 404) {
                    errorMessage = 'User Not Found';
                } else if (error.responseJSON && error.responseJSON.message) {
                    errorMessage = error.responseJSON.message;
                }

                button.innerHTML = `<span>${errorMessage} ${icons.error}</span>`;
                button.classList.add('jellyseerr-button-error');
            }
        }

        // STYLES
        function addStyles() {
            const styleId = 'jellyseerr-styles';
            if (document.getElementById(styleId)) return;

            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                /* --- Layout & Icons --- */
                .jellyseerr-section { margin-bottom: 2em; }
                .jellyseerr-section .itemsContainer { white-space: nowrap; }
                #jellyseerr-search-icon {
                    position: absolute; right: 10px; top: 68%; transform: translateY(-50%);
                    user-select: none; z-index: 10; transition: filter .2s, opacity .2s, transform .2s;
                }
                .inputContainer { position: relative !important; }
                .jellyseerr-icon { width: 30px; height: 50px; filter: drop-shadow(2px 2px 6px #000); }
                #jellyseerr-search-icon.is-active { filter: drop-shadow(2px 2px 6px #000); opacity: 1; }
                #jellyseerr-search-icon.is-disabled { filter: grayscale(1); opacity: .8; }
                #jellyseerr-search-icon.is-no-user { filter: hue-rotate(125deg) brightness(100%); }
                #jellyseerr-search-icon.is-filter-active {
                    filter: drop-shadow(2px 2px 6px #3b82f6) brightness(1.2);
                    transform: translateY(-50%) scale(1.1);
                }
                #jellyseerr-search-icon:hover {
                    transform: translateY(-50%) scale(1.05);
                    transition: transform 0.2s ease;
                }

                /* --- Cards & Badges --- */
                .jellyseerr-card { position: relative; }
                .jellyseerr-card .cardScalable { contain: paint; }
                .jellyseerr-icon-on-card {
                    position: absolute; top: 8px; right: 8px; width: 18%; height: auto;
                    z-index: 2; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.8));
                }
                .jellyseerr-media-badge {
                    position: absolute; top: 8px; left: 8px; z-index: 100; color: #fff;
                    padding: 2px 8px; border-radius: 999px; border: 1px solid rgba(0,0,0,0.2);
                    font-size: 1em; font-weight: 500; text-transform: uppercase; letter-spacing: 1.5px;
                    text-shadow: 1px 1px 3px rgba(0, 0, 0, 0.8);
                    box-shadow: 0 4px 4px -1px rgba(0,0,0,0.1), 0 2px 2px -2px rgba(0,0,0,0.1);
                    backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
                }
                .layout-mobile .jellyseerr-media-badge {font-size: 0.8em !important;}
                .jellyseerr-media-badge-movie { background-color: rgba(59, 130, 246, .9); box-shadow:0 0 0 1px rgba(59,130,246,.35), 0 8px 24px rgba(59,130,246,.25); }
                .jellyseerr-media-badge-series { background-color: rgba(243, 51, 214, .9); box-shadow:0 0 0 1px rgba(236,72,153,.35), 0 8px 24px rgba(236,72,153,.25); }
                .jellyseerr-overview {
                    position: absolute; inset: 0;
                    background: linear-gradient(180deg, rgba(0,0,0,0) 30%, rgba(0,0,0,.78) 75%, rgba(0,0,0,.92) 100%);
                    color: #e5e7eb; padding: 12px 12px 14px; line-height: 1.5;
                    opacity: 0; transform: translateY(6px); transition: opacity .18s ease, transform .18s ease;
                    overflow: hidden; display: flex; align-items: flex-end;
                    backdrop-filter: blur(2px); -webkit-backdrop-filter: blur(2px);
                }
                .jellyseerr-overview .content {
                    width: 100%; display: -webkit-box; -webkit-line-clamp: 6;
                    -webkit-box-orient: vertical; overflow: hidden; white-space: normal;
                }
                .jellyseerr-card:focus-within .jellyseerr-overview,
                .jellyseerr-card:hover .jellyseerr-overview,
                .jellyseerr-card.is-touch .jellyseerr-overview { opacity: 1; }
                .jellyseerr-overview .title { font-weight: 600; display: block; margin-bottom: .35em; }
                .jellyseerr-meta { display: flex; justify-content: center; align-items: center; gap: 1.5em; padding: 0 .75em; }
                .jellyseerr-rating { display: flex; align-items: center; gap: .3em; color: #bdbdbd; }
                .cardText-first > a[is="emby-linkbutton"] {
                    padding: 0 !important;
                    margin: 0 !important;
                    color: inherit;
                    text-decoration: none;
                }

                /* --- Request Buttons --- */
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
                .layout-mobile .jellyseerr-request-button span{
                    font-size: 0.8em !important;
                }
                .jellyseerr-request-button.jellyseerr-button-offline,
                .jellyseerr-request-button.jellyseerr-button-no-user { opacity: .6; cursor: not-allowed; }
                .jellyseerr-request-button.jellyseerr-button-request { background-color: #4f46e5 !important; color: #fff !important; }
                .jellyseerr-request-button.jellyseerr-button-pending { background-color: #b45309 !important; color: #fff !important; }
                .jellyseerr-request-button.jellyseerr-button-processing { background-color: #581c87 !important; color: #fff !important; }
                .jellyseerr-request-button.jellyseerr-button-rejected { background-color: #8a1c1c !important; color: #fff !important; }
                .jellyseerr-request-button.jellyseerr-button-partially-available { background-color: #4ca46c !important; color: #fff !important; }
                .jellyseerr-request-button.jellyseerr-button-available { background-color: #16a34a !important; color: #fff !important; }
                .jellyseerr-request-button.jellyseerr-button-error { background: #dc3545 !important; color: #fff !important; }

                /* --- Season Modal Styles --- */
                .jellyseerr-season-modal-overlay {
                    position: fixed;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background: rgba(0, 0, 0, 0.75);
                    backdrop-filter: blur(4px);
                    -webkit-backdrop-filter: blur(4px);
                    z-index: 10000;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    opacity: 0;
                    transition: opacity 0.2s ease;
                    padding: 1rem;
                }

                .jellyseerr-season-modal-overlay.show {
                    opacity: 1;
                }

                .jellyseerr-season-modal {
                    background: #1f2937;
                    border-radius: 12px;
                    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
                    width: 100%;
                    max-width: 600px;
                    max-height: 80vh;
                    overflow: hidden;
                    display: flex;
                    flex-direction: column;
                    transform: scale(0.95);
                    transition: transform 0.2s ease;
                }

                .jellyseerr-season-modal-overlay.show .jellyseerr-season-modal {
                    transform: scale(1);
                }

                .jellyseerr-season-modal-header {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    padding: 1.5rem 1.5rem 1rem;
                    border-bottom: 1px solid #374151;
                }

                .jellyseerr-season-modal-title {
                    font-size: 1.5rem;
                    font-weight: 600;
                    color: #f9fafb;
                    margin: 0;
                }

                .jellyseerr-season-modal-subtitle {
                    color: #9ca3af;
                    font-size: 1.1rem;
                    padding: 0 1.5rem 1rem;
                    border-bottom: 1px solid #374151;
                    margin-bottom: 0;
                }

                .jellyseerr-season-modal-close {
                    background: none;
                    border: none;
                    color: #9ca3af;
                    cursor: pointer;
                    padding: 0.5rem;
                    border-radius: 6px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    transition: background 0.2s, color 0.2s;
                }

                .jellyseerr-season-modal-close:hover {
                    background: #374151;
                    color: #f9fafb;
                }

                .jellyseerr-season-modal-content {
                    flex: 1;
                    overflow-y: auto;
                    padding: 0;
                }

                .jellyseerr-season-list-header {
                    display: grid;
                    grid-template-columns: 80px 1fr auto;
                    gap: 1rem;
                    padding: 1rem 1.5rem 0.5rem;
                    color: #9ca3af;
                    font-size: 0.875rem;
                    font-weight: 500;
                    text-transform: uppercase;
                    letter-spacing: 0.05em;
                }

                .jellyseerr-season-list {
                    min-height: 200px;
                }

                .jellyseerr-season-loading,
                .jellyseerr-season-error {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    padding: 3rem 1.5rem;
                    color: #9ca3af;
                    font-size: 1rem;
                }

                .jellyseerr-season-error {
                    color: #ef4444;
                }

                .jellyseerr-season-item {
                    display: grid;
                    grid-template-columns: 80px 1fr auto;
                    gap: 1rem;
                    align-items: center;
                    padding: 0.75rem 1.5rem;
                    border-bottom: 1px solid #374151;
                    transition: background 0.2s;
                }

                .jellyseerr-season-item:hover {
                    background: #374151;
                }

                .jellyseerr-season-item:last-child {
                    border-bottom: none;
                }

                .jellyseerr-season-toggle-container {
                    display: flex;
                    align-items: center;
                }

                .jellyseerr-season-toggle-label {
                    position: relative;
                    display: inline-block;
                    width: 48px;
                    height: 24px;
                    cursor: pointer;
                }

                .jellyseerr-season-toggle {
                    opacity: 0;
                    width: 0;
                    height: 0;
                }

                .jellyseerr-season-toggle-slider {
                    position: absolute;
                    cursor: pointer;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background-color: #6b7280;
                    transition: .3s;
                    border-radius: 24px;
                }

                .jellyseerr-season-toggle-slider:before {
                    position: absolute;
                    content: "";
                    height: 18px;
                    width: 18px;
                    left: 3px;
                    bottom: 3px;
                    background-color: white;
                    transition: .3s;
                    border-radius: 50%;
                }

                .jellyseerr-season-toggle:checked + .jellyseerr-season-toggle-slider {
                    background-color: #3b82f6;
                }

                .jellyseerr-season-toggle:disabled + .jellyseerr-season-toggle-slider {
                    opacity: 0.5;
                    cursor: not-allowed;
                }

                .jellyseerr-season-toggle:checked + .jellyseerr-season-toggle-slider:before {
                    transform: translateX(24px);
                }

                .jellyseerr-season-info {
                    color: #f9fafb;
                    font-weight: 500;
                }

                .jellyseerr-season-episodes {
                    color: #d1d5db;
                    font-size: 0.875rem;
                }

                .jellyseerr-season-status-badge {
                    padding: 0.25rem 0.75rem;
                    border-radius: 9999px;
                    font-size: 0.75rem;
                    font-weight: 600;
                    text-transform: uppercase;
                    letter-spacing: 0.05em;
                }

                .jellyseerr-season-status-badge.not-requested {
                    background: #6b7280;
                    color: #f9fafb;
                }

                .jellyseerr-season-status-badge.pending {
                    background: #b45309;
                    color: #fff;
                }

                .jellyseerr-season-status-badge.requested {
                    background: #7c3aed;
                    color: #fff;
                }

                .jellyseerr-season-status-badge.partially-available {
                    background: #059669;
                    color: #fff;
                }

                .jellyseerr-season-status-badge.available {
                    background: #16a34a;
                    color: #fff;
                }

                .jellyseerr-season-status-badge.rejected {
                    background: #dc2626;
                    color: #fff;
                }

                .jellyseerr-season-modal-footer {
                    display: flex;
                    gap: 0.75rem;
                    padding: 1.5rem;
                    border-top: 1px solid #374151;
                    justify-content: flex-end;
                }

                .jellyseerr-season-modal-cancel,
                .jellyseerr-season-modal-submit {
                    padding: 0.75rem 1.5rem;
                    border-radius: 6px;
                    font-weight: 500;
                    cursor: pointer;
                    transition: background 0.2s, color 0.2s;
                    border: none;
                    font-size: 0.875rem;
                }

                .jellyseerr-season-modal-cancel {
                    background: #374151;
                    color: #f9fafb;
                }

                .jellyseerr-season-modal-cancel:hover {
                    background: #4b5563;
                }

                .jellyseerr-season-modal-submit {
                    background: #3b82f6;
                    color: #fff;
                }

                .jellyseerr-season-modal-submit:hover {
                    background: #2563eb;
                }

                .jellyseerr-season-modal-submit:disabled {
                    background: #6b7280;
                    cursor: not-allowed;
                }

                @media (max-width: 768px) {
                    .jellyseerr-season-modal {
                        margin: 1rem;
                        max-height: 90vh;
                    }

                    .jellyseerr-season-list-header {
                        font-size: 0.75rem;
                        padding: 1rem 1rem 0.5rem;
                    }

                    .jellyseerr-season-item {
                        padding: 0.5rem 1rem;
                    }

                    .jellyseerr-season-modal-footer {
                        flex-direction: column;
                    }

                    .jellyseerr-season-modal-cancel,
                    .jellyseerr-season-modal-submit {
                        width: 100%;
                    }
                }

                /* --- Spinners & Loaders --- */
                .jellyseerr-spinner, .jellyseerr-loading-spinner, .jellyseerr-button-spinner {
                    display: inline-block; border-radius: 50%;
                    animation: jellyseerr-spin 1s linear infinite;
                }
                .jellyseerr-loading-spinner {
                    width: 20px; height: 20px; border: 3px solid rgba(255,255,255,.3);
                    border-top-color: #fff; margin-left: 10px; vertical-align: middle;
                }
                .jellyseerr-button-spinner {
                    width: 1em; height: 1em; border: 2px solid currentColor;
                    border-right-color: transparent; margin-left: .5em; flex-shrink: 0;
                }

                /* --- Hover Popover --- */
                .jellyseerr-hover-popover {
                    position: fixed; min-width: 260px; max-width: 340px; padding: 10px 12px;
                    background: #1f2937; color: #e5e7eb; border-radius: 10px; z-index: 9999;
                    box-shadow: 0 10px 30px rgba(0,0,0,.45), 0 0 0 1px rgba(255,255,255, .06);
                    opacity: 0; pointer-events: none; transition: opacity .12s ease, transform .12s ease;
                }
                .jellyseerr-hover-popover.show { opacity: 1; }
                .jellyseerr-hover-popover .title {
                    font-weight: 600; font-size: .9rem; white-space: nowrap;
                    overflow: hidden; text-overflow: ellipsis; margin-bottom: 8px;
                }
                .jellyseerr-hover-popover .row {
                    display: flex; align-items: center; justify-content: space-between;
                    gap: 8px; margin-top: 6px;
                }
                .jellyseerr-hover-popover .status {
                    display: inline-block; padding: 2px 8px; border-radius: 999px;
                    font-size: .75rem; font-weight: 600; background: #4f46e5; color: #fff;
                }
                .jellyseerr-hover-popover .jellyseerr-hover-progress {
                    height: 7px; width: 100%; background: rgba(255,255,255,.12);
                    border-radius: 999px; overflow: hidden;
                }
                .jellyseerr-hover-popover .jellyseerr-hover-progress .bar {
                    height: 100%; background: linear-gradient(90deg, #3b82f6, #8b5cf6);
                    transition: width .2s ease;
                }

                /* --- Keyframes --- */
                @keyframes jellyseerr-spin { to { transform: rotate(360deg) } }

                .section-hidden {
                    display: none !important;
                }
            `;
            document.head.appendChild(style);
        }

        //helper for container
        async function checkJellyseerrStatus() {
            try {
                const res = await ApiClient.ajax({
                    type: 'GET',
                    url: ApiClient.getUrl('/JellyfinEnhanced/jellyseerr/user-status'),
                    headers: {
                        'X-Jellyfin-User-Id': ApiClient.getCurrentUserId()
                    },
                    dataType: 'json'
                });
                isJellyseerrActive = !!res.active;
                jellyseerrUserFound = !!res.userFound;
                if (isJellyseerrActive && !jellyseerrUserFound) {
                    console.warn(`${logPrefix} Connection successful, but the current Jellyfin user is not linked to a Jellyseerr account.`);
                }
            } catch (e) {
                const userId = ApiClient.getCurrentUserId();
                console.warn(`${logPrefix} Status check failed for user ${userId}:`, e);
                isJellyseerrActive = false;
                jellyseerrUserFound = false;
            }
            updateJellyseerrIcon();
        }

        function toggleJellyseerrOnlyMode() {
            isJellyseerrOnlyMode = !isJellyseerrOnlyMode;

            const searchPage = document.querySelector('#searchPage');
            if (!searchPage) return;

            if (isJellyseerrOnlyMode) {
                // Hide all non-Jellyseerr sections
                const allSections = searchPage.querySelectorAll('.verticalSection:not(.jellyseerr-section)');
                hiddenSections = Array.from(allSections);

                allSections.forEach(section => {
                    section.classList.add('section-hidden');
                });

                // Move Jellyseerr section to top
                const jellyseerrSection = searchPage.querySelector('.jellyseerr-section');
                if (jellyseerrSection) {
                    // Create and insert a placeholder to mark the original spot
                    jellyseerrOriginalPosition = document.createElement('div');
                    jellyseerrOriginalPosition.id = 'jellyseerr-placeholder';
                    jellyseerrSection.parentNode.insertBefore(jellyseerrOriginalPosition, jellyseerrSection);

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

                JE.toast('🪼 Showing results only from Jellyseerr', 3000);
                console.log(`${logPrefix} Switched to Jellyseerr-only mode`);

            } else {
                // Restore all hidden sections
                hiddenSections.forEach(section => {
                    section.classList.remove('section-hidden');
                });

                // Move Jellyseerr section back to its original position
                const jellyseerrSection = searchPage.querySelector('.jellyseerr-section');
                if (jellyseerrSection && jellyseerrOriginalPosition && jellyseerrOriginalPosition.parentNode) {
                    jellyseerrOriginalPosition.parentNode.insertBefore(jellyseerrSection, jellyseerrOriginalPosition);
                    jellyseerrOriginalPosition.remove();
                    jellyseerrOriginalPosition = null;
                }

                // Restore "no results" message if it was hidden
                const noResultsMessage = searchPage.querySelector('.noItemsMessage');
                if (noResultsMessage) {
                    noResultsMessage.classList.remove('section-hidden');
                }

                hiddenSections = [];
                JE.toast('🪼 Showing all search results', 3000);
                console.log(`${logPrefix} Switched back to all results mode`);
            }
            const jellyseerrSection = searchPage.querySelector('.jellyseerr-section');
                if (jellyseerrSection) {
                    const titleElement = jellyseerrSection.querySelector('.sectionTitle');
                    if (titleElement) {
                        titleElement.textContent = isJellyseerrOnlyMode ? 'Jellyseerr Results' : 'Discover on Jellyseerr';
                    }
                }
            updateJellyseerrIcon();
        }

        // UI Injection
        function updateJellyseerrIcon() {
            const anchor = document.querySelector('.searchFields .inputContainer') ||
                document.querySelector('#searchPage .searchFields') ||
                document.querySelector('#searchPage');
            if (!anchor) return;

            let icon = document.getElementById('jellyseerr-search-icon');
            if (!icon) {
                icon = document.createElement('img');
                icon.id = 'jellyseerr-search-icon';
                icon.className = 'jellyseerr-icon';
                icon.src = 'https://cdn.jsdelivr.net/gh/selfhst/icons/svg/jellyseerr.svg';
                icon.alt = 'Jellyseerr';

                // Add double-click/tap functionality
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

                icon.addEventListener('click', handleIconInteraction);
                icon.addEventListener('touchend', (e) => {
                    e.preventDefault();
                    handleIconInteraction();
                }, { passive: false });

                // Add keyboard support
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

            icon.classList.remove('is-active', 'is-disabled', 'is-no-user', 'is-filter-active');

            if (isJellyseerrActive && jellyseerrUserFound) {
                icon.title = isJellyseerrOnlyMode ?
                    'Jellyseerr is active\nDouble-click to show all results' :
                    'Jellyseerr is active\nDouble-click to show only Jellyseerr results';
                icon.classList.add('is-active');
                if (isJellyseerrOnlyMode) {
                    icon.classList.add('is-filter-active');
                }
            } else if (isJellyseerrActive && !jellyseerrUserFound) {
                icon.title = 'User not found on Jellyseerr';
                icon.classList.add('is-no-user');
            } else {
                icon.title = 'Jellyseerr is not connected.';
                icon.classList.add('is-disabled');
            }
        }

        function initializeObserver() {
            const observer = new MutationObserver(() => {
                updateJellyseerrIcon();
                const isSearchPage = window.location.hash.includes('/search.html');
                const currentQuery = isSearchPage ? new URLSearchParams(window.location.hash.split('?')[1]).get('query') : null;

                if (isSearchPage && currentQuery && currentQuery.trim() !== '') {
                    clearTimeout(debounceTimeout);
                    debounceTimeout = setTimeout(() => {
                        if (!isJellyseerrActive) {
                            document.querySelectorAll('.jellyseerr-section').forEach(e => e.remove());
                            return;
                        }
                        const latestQuery = new URLSearchParams(window.location.hash.split('?')[1]).get('query');
                        if (latestQuery === lastProcessedQuery) return;

                        if (isJellyseerrOnlyMode) {
                            console.log(`${logPrefix} New search detected, resetting filter mode.`);
                            isJellyseerrOnlyMode = false;
                            hiddenSections = [];
                            jellyseerrOriginalPosition = null;
                            updateJellyseerrIcon();
                        }

                        lastProcessedQuery = latestQuery;
                        document.querySelectorAll('.jellyseerr-section').forEach(e => e.remove());
                        runJellyseerrSearch(latestQuery);
                    }, 1000);
                } else {
                    // If not on search page, or query is empty, clear results and reset state
                    clearTimeout(debounceTimeout);
                    lastProcessedQuery = null;
                    isJellyseerrOnlyMode = false; // Reset filter mode when leaving search
                    document.querySelectorAll('.jellyseerr-section').forEach(e => e.remove());
                }
            });
            observer.observe(document.body, {
                childList: true,
                subtree: true
            });
        }

        // API - Fetch search results
        async function fetchFromJellyseerr(query) {
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
                    console.debug(`${logPrefix} No results found.`);
                }
            } catch (error) {
                const userId = ApiClient.getCurrentUserId();
                const errorDetails = error.responseJSON || error;
                console.error(`${logPrefix} Error fetching search results for user ${userId}. Query: "${query}". Error:`, errorDetails);
            }
        }

        async function requestMedia(tmdbId, mediaType, button) {
            // For TV shows, show season selection modal
            if (mediaType === 'tv') {
                // Get the original item data to pass to the modal
                const card = button.closest('.jellyseerr-card');
                const titleElement = card.querySelector('.cardText-first a');
                const title = titleElement ? titleElement.textContent.trim() : 'Unknown Series';

                const item = {
                    id: tmdbId,
                    title: title,
                    name: title,
                    mediaType: 'tv'
                };

                showSeasonModal(item, button);
                return;
            }

            // For movies, proceed with original logic
            button.disabled = true;
            button.innerHTML = `<span>Requesting</span><span class="jellyseerr-button-spinner"></span>`;

            const requestBody = {
                mediaType,
                mediaId: parseInt(tmdbId)
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
                button.innerHTML = `<span>Requested ${icons.requested}</span>`;
                button.classList.remove('jellyseerr-button-request');
                button.classList.add('jellyseerr-button-pending');
            } catch (error) {
                button.disabled = false;
                const userId = ApiClient.getCurrentUserId();
                const errorDetails = error.responseJSON || error;
                console.error(`${logPrefix} Request Failed via proxy for user ${userId}. Request Body:`, JSON.stringify(requestBody), 'Error:', errorDetails);

                let errorMessage = 'Error';
                if (error.status === 404) {
                    errorMessage = 'User Not Found';
                } else if (error.responseJSON && error.responseJSON.message) {
                    errorMessage = error.responseJSON.message;
                }

                button.innerHTML = `<span>${errorMessage} ${icons.error}</span>`;
                button.classList.add('jellyseerr-button-error');
            }
        }

        function runJellyseerrSearch(query) {
            fetchFromJellyseerr(query);
        }

        function renderJellyseerrResults(sectionToInject, query) {
            console.log(`${logPrefix} Called with query:`, query);

            const searchPage = document.querySelector('#searchPage');
            if (!searchPage) {
                console.warn(`${logPrefix} #searchPage not found. Exiting.`);
                return;
            }
            console.log(`${logPrefix} Found #searchPage`);

            // Remove any previous injection
            const oldSection = searchPage.querySelector('.jellyseerr-section');
            if (oldSection) {
                console.log(`${logPrefix} Removing old .jellyseerr-section`);
                oldSection.remove();
            }

            // Ensure our injected block is identifiable
            if (!sectionToInject.classList.contains('jellyseerr-section')) {
                sectionToInject.classList.add('jellyseerr-section');
            }

            const primaryTypes = ['movies', 'shows', 'series', 'episodes'];
            const secondaryTypes = ['people', 'artists', 'albums', 'songs', 'videos', 'collections', 'playlists'];
            const allTypes = primaryTypes.concat(secondaryTypes);

            let attempts = 0;
            const maxAttempts = 75; // ~15s @ 200ms

            console.log(`${logPrefix} Waiting for Jellyfin content to load...`);

            const injectionInterval = setInterval(() => {
                attempts++;

                const noResultsMessage = searchPage.querySelector('.noItemsMessage');
                const sections = Array.from(searchPage.querySelectorAll('.verticalSection'));
                const hasTypedSection = sections.some(s => {
                    const title = s.querySelector('.sectionTitle')?.textContent.trim().toLowerCase() || '';
                    return allTypes.some(t => title.includes(t));
                });

                // Keep waiting until we see either a typed section or an explicit "no results" message, or timeout
                if (!(hasTypedSection || noResultsMessage) && attempts < maxAttempts) {
                    return; // Keep waiting
                }

                clearInterval(injectionInterval);
                console.log(`${logPrefix} Proceeding with injection (Reason: ${noResultsMessage ? 'No Items Message' : hasTypedSection ? 'Typed Section Found' : 'Timeout'})`);

                if (noResultsMessage) {
                    console.log(`${logPrefix} Found .noItemsMessage, injecting after it.`);
                    noResultsMessage.textContent = `Sorry! No results found for "${query}" on Jellyfin`;
                    noResultsMessage.parentElement.insertBefore(sectionToInject, noResultsMessage.nextSibling);
                    return;
                }

                // We have at least one typed section → follow the primary/secondary placement rules
                const allSections = Array.from(searchPage.querySelectorAll('.verticalSection:not(.jellyseerr-section)'));
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

                const firstSecondarySection = allSections.find(s => {
                    const title = s.querySelector('.sectionTitle')?.textContent.trim().toLowerCase() || '';
                    return secondaryTypes.some(type => title.includes(type));
                });

                if (firstSecondarySection) {
                    console.log(`${logPrefix} No primary found. Injecting before first secondary section.`);
                    firstSecondarySection.parentElement.insertBefore(sectionToInject, firstSecondarySection);
                    return;
                }

                // Timeout or unexpected DOM: last resort fallbacks
                console.warn(`${logPrefix} No typed sections resolved. Using fallback injection method.`);
                const resultsContainer = searchPage.querySelector('.searchResults, [class*="searchResults"], .padded-top.padded-bottom-page');
                if (resultsContainer) {
                    resultsContainer.appendChild(sectionToInject);
                } else {
                    searchPage.appendChild(sectionToInject);
                }
            }, 200);
        }

        function createJellyseerrSection(isLoading, results = []) {
            const section = document.createElement('div');
            section.className = 'verticalSection emby-scroller-container jellyseerr-section';

            // Add a data attribute to help with filtering
            section.setAttribute('data-jellyseerr-section', 'true');

            const title = document.createElement('h2');
            title.className = 'sectionTitle sectionTitle-cards focuscontainer-x padded-left padded-right';
            title.textContent = isJellyseerrOnlyMode ? 'Jellyseerr Results' : 'Discover on Jellyseerr';

            if (isLoading) {
                const spinner = document.createElement('div');
                spinner.className = 'jellyseerr-loading-spinner';
                title.appendChild(spinner);
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

        function createJellyseerrCard(item) {
            const year = item.releaseDate ? item.releaseDate.substring(0, 4) : (item.firstAirDate ? item.firstAirDate.substring(0, 4) : 'N/A');
            const posterUrl = item.posterPath ? `https://image.tmdb.org/t/p/w400${item.posterPath}` : 'https://i.ibb.co/fdbkXQdP/jellyseerr-poster-not-found.png';
            const rating = item.voteAverage ? item.voteAverage.toFixed(1) : 'N/A';
            const titleText = item.title || item.name;
            const tmdbUrl = `https://www.themoviedb.org/${item.mediaType}/${item.id}`;

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

            const img = card.querySelector('.cardImageContainer');
            if (img) {
                img.addEventListener('touchend', (e) => {
                    e.preventDefault();
                    card.classList.toggle('is-touch');
                }, {
                    passive: false
                });
                img.setAttribute('tabindex', '0'); // focusable
                img.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        card.classList.toggle('is-touch');
                    }
                });
            }

            const button = card.querySelector('.jellyseerr-request-button');
            if (!isJellyseerrActive) {
                button.innerHTML = `<span>Jellyseerr offline</span>${icons.cloud_off}`;
                button.disabled = true;
                button.classList.add('jellyseerr-button-offline');
            } else if (!jellyseerrUserFound) {
                button.innerHTML = `<span>User not found</span>${icons.person_off}`;
                button.disabled = true;
                button.classList.add('jellyseerr-button-no-user');
            } else {
                const status = item.mediaInfo ? item.mediaInfo.status : 1;
                switch (status) {
                    case 2: // Pending Approval
                        button.innerHTML = `<span>Pending</span>${icons.pending}`;
                        button.disabled = true;
                        button.classList.add('button-submit', 'jellyseerr-button-pending');
                        break;
                    case 3: // Processing Or Requested
                        if (item.mediaInfo?.downloadStatus?.length > 0 || item.mediaInfo?.downloadStatus4k?.length > 0) {
                            button.innerHTML = `<span>Processing</span><span class="jellyseerr-button-spinner"></span>`;
                            button.disabled = true;
                            button.classList.add('button-submit', 'jellyseerr-button-processing');
                            // hover/focus (desktop/keyboard)
                            button.addEventListener('mouseenter', (e) => {
                                const pop = fillHoverPop(item);
                                if (!pop) return;
                                positionHoverPop(pop, e.clientX, e.clientY);
                                pop.classList.add('show');
                            });
                            button.addEventListener('mousemove', (e) => {
                                if (jellyseerrHoverPopover && jellyseerrHoverPopover.classList.contains('show') && !jellyseerrHoverLock) positionHoverPop(jellyseerrHoverPopover, e.clientX, e.clientY);
                            });
                            button.addEventListener('mouseleave', hideHoverPop);
                            button.addEventListener('focus', () => {
                                const pop = fillHoverPop(item);
                                if (!pop) return;
                                const r = button.getBoundingClientRect();
                                positionHoverPop(pop, r.right, r.top - 8);
                                pop.classList.add('show');
                            });
                            button.addEventListener('blur', () => {
                                jellyseerrHoverLock = false;
                                hideHoverPop();
                            });

                            // mobile: tap to toggle popover anchored to button
                            button.addEventListener('touchstart', (e) => {
                                e.preventDefault();
                                const pop = fillHoverPop(item);
                                if (!pop) return;
                                const r = button.getBoundingClientRect();
                                jellyseerrHoverLock = !jellyseerrHoverLock; // toggle
                                if (jellyseerrHoverLock) {
                                    positionHoverPop(pop, r.left + r.width / 2, r.top - 8);
                                    pop.classList.add('show');
                                } else {
                                    pop.classList.remove('show');
                                }
                            }, {
                                passive: false
                            });
                        } else {
                            // Treat it like "Requested" until downloads actually begin
                            button.innerHTML = `<span>Requested</span>${icons.requested}`;
                            button.disabled = true;
                            button.classList.add('button-submit', 'jellyseerr-button-pending');
                        }
                        break;
                    case 4: // Partially Available
                        button.innerHTML = `<span>Partially Available</span>${icons.partially_available}`;
                        button.disabled = true;
                        button.classList.add('button-submit', 'jellyseerr-button-partially-available');
                        break;
                    case 5: // Available
                        button.innerHTML = `<span>Available</span>${icons.available}`;
                        button.disabled = true;
                        button.classList.add('button-submit', 'jellyseerr-button-available');
                        break;
                    case 6: // Rejected
                        button.innerHTML = `<span>Rejected</span>${icons.cancel}`;
                        button.disabled = true;
                        button.classList.add('button-submit', 'jellyseerr-button-rejected');
                        break;
                    default:
                        // For TV shows, show "Select Seasons" instead of "Request"
                        if (item.mediaType === 'tv') {
                            button.innerHTML = `${icons.request}<span>Select Seasons</span>`;
                        } else {
                            button.innerHTML = `${icons.request}<span>Request</span>`;
                        }
                        button.disabled = false;
                        button.classList.add('button-submit', 'jellyseerr-button-request');
                }
            }
            if (item.mediaType === 'movie' || item.mediaType === 'tv') {
                const imageContainer = card.querySelector('.cardImageContainer');
                if (imageContainer) {
                    const badge = document.createElement('div');
                    badge.classList.add('jellyseerr-media-badge');
                    if (item.mediaType === 'movie') {
                        badge.classList.add('jellyseerr-media-badge-movie');
                        badge.textContent = 'Movie';
                    } else {
                        badge.classList.add('jellyseerr-media-badge-series');
                        badge.textContent = 'Series';
                    }
                    imageContainer.appendChild(badge);
                }
            }
            return card;
        }

        function waitForUserAndInitialize() {
            const startTime = Date.now();
            const timeout = 20000; // Wait up to 20 seconds for a user session

            const check = () => {
                // Check if the API client has a user ID
                if (ApiClient.getCurrentUserId()) {
                    console.log(`${logPrefix} User session found. Proceeding...`);
                    // User is available, run the status check and then set up the observer
                    checkJellyseerrStatus().then(() => {
                        initializeObserver();
                    });
                } else if (Date.now() - startTime > timeout) {
                    // If we've waited too long, give up and initialize in a degraded state
                    console.warn(`${logPrefix} Timed out waiting for user ID. Features may be limited.`);
                    checkJellyseerrStatus().then(() => {
                        initializeObserver();
                    });
                } else {
                    // If no user yet and we haven't timed out, wait and check again
                    setTimeout(check, 300);
                }
            };

            // Start the check
            check();
        }

        // --- Initialization ---
        addStyles();

        waitForUserAndInitialize();
        document.addEventListener('touchstart', (e) => {
            if (!e.target.closest('.jellyseerr-request-button')) {
                jellyseerrHoverLock = false;
                hideHoverPop();
            }
        }, {
            passive: true
        });
        document.addEventListener('scroll', () => {
            if (!jellyseerrHoverLock) hideHoverPop();
        }, true);
        document.body.addEventListener('touchstart', (e) => {
            if (!e.target.closest('.jellyseerr-card')) {
                document.querySelectorAll('.jellyseerr-card.is-touch').forEach(c => c.classList.remove('is-touch'));
            }
        }, {
            passive: true
        });
        document.body.addEventListener('click', function(event) {
            const button = event.target.closest('.jellyseerr-request-button');
            if (button && !button.disabled) {
                requestMedia(button.dataset.tmdbId, button.dataset.mediaType, button);
            }
        });
    };
})(window.JellyfinEnhanced);