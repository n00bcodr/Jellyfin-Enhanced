// /js/jellyseerr/ui/ui-season-modal.js
// Season-selection request modal for TV shows.
(function(JE) {
    'use strict';

    const ui = JE.jellyseerrUI = JE.jellyseerrUI || {};
    JE.internals = JE.internals || {};
    // Shared state is seeded by ui-icons.js, which plugin.js loads first
    // in this group.
    const internal = JE.internals.jellyseerrUi;
    const logPrefix = '🪼 Jellyfin Enhanced: Seerr UI:';
    const escapeHtml = JE.escapeHtml;
    let refreshModalInterval = null;

    /**
     * Shows the enhanced season selection modal for TV shows.
     * @param {number} tmdbId - TMDB ID of the TV show.
     * @param {string} mediaType - Should be 'tv'.
     * @param {string} showTitle - Display title of the show.
     * @param {Object|null} searchResultItem - Original search result data.
     */
    ui.showSeasonSelectionModal = async function(tmdbId, mediaType, showTitle, searchResultItem = null, is4k = false) {
        if (mediaType !== 'tv') return;
        if (refreshModalInterval) {
            clearInterval(refreshModalInterval);
            refreshModalInterval = null;
        }


        const { create, createAdvancedOptionsHTML, populateAdvancedOptions } = JE.jellyseerrModal;
        const { fetchTvShowDetails, fetchTvSeasonDetails, fetchTmdbTvDetails, requestTvSeasons, fetchAdvancedRequestData, fetchRequestSettings, requestMedia } = JE.jellyseerrAPI;

        // Fetch Seerr request settings (partial requests + special episodes)
        let partialRequestsEnabled = false;
        let enableSpecialEpisodes = false;
        try {
            const settings = await fetchRequestSettings();
            partialRequestsEnabled = settings.partialRequestsEnabled;
            enableSpecialEpisodes = settings.enableSpecialEpisodes;
        } catch (e) {
            partialRequestsEnabled = false;
            enableSpecialEpisodes = false;
        }

        const tvDetails = await fetchTvShowDetails(tmdbId);
        if (!tvDetails?.seasons) {
            JE.toast(JE.t('jellyseerr_toast_no_season_info'), 4000);
            return;
        }

        // Fetch Jellyfin season map to cross-reference Seerr's availability status.
        // Seerr can report a season as status 5 (Available) after it was deleted from
        // the library — the show-level jellyfinMediaId is still set (other seasons exist),
        // so the per-show stale check doesn't fire. Querying Jellyfin directly tells us
        // exactly which seasons are physically present.
        let jellyfinSeasonMap = null;
        const jellyfinSeriesId = tvDetails.mediaInfo?.jellyfinMediaId || null;
        if (jellyfinSeriesId) {
            try {
                const userId = ApiClient.getCurrentUserId?.();
                if (userId) {
                    const resp = await ApiClient.ajax({
                        type: 'GET',
                        url: ApiClient.getUrl(`/Users/${userId}/Items`, {
                            ParentId: jellyfinSeriesId,
                            IncludeItemTypes: 'Season',
                            Recursive: false,
                            Fields: 'IndexNumber'
                        }),
                        dataType: 'json'
                    });
                    jellyfinSeasonMap = {};
                    for (const s of (resp?.Items || [])) {
                        const idx = Number(s?.IndexNumber);
                        if (Number.isFinite(idx) && idx >= 0) jellyfinSeasonMap[idx] = true;
                    }
                }
            } catch (_) {}
        }

        const normalizedTitle = String(showTitle || '').trim();
        const isGenericFallbackTitle = ['this show', 'this movie', 'this collection'].includes(normalizedTitle.toLowerCase());
        const resolvedShowTitle = (!isGenericFallbackTitle && normalizedTitle)
            || tvDetails?.name
            || tvDetails?.title
            || searchResultItem?.name
            || searchResultItem?.title
            || searchResultItem?.originalName
            || searchResultItem?.originalTitle
            || normalizedTitle
            || 'Unknown Show';

        const showAdvanced = JE.pluginConfig.JellyseerrShowAdvanced;

        // Show season selection UI with Select All checkbox header
        const bodyHtml = `<div class="jellyseerr-season-list">
            ${partialRequestsEnabled ? '<div class="jellyseerr-season-header-row"><input type="checkbox" class="jellyseerr-season-checkbox" id="jellyseerr-select-all-seasons"><label class="jellyseerr-season-header-label" for="jellyseerr-select-all-seasons">' + JE.t('jellyseerr_select_all_seasons') + '</label><div></div><div></div></div>' : ''}
        </div>${showAdvanced ? createAdvancedOptionsHTML('tv') : ''}`;
        const modalInstance = create({
            title: is4k ? `${JE.t('jellyseerr_modal_title')} - 4K` : JE.t('jellyseerr_modal_title'),
            subtitle: resolvedShowTitle,
            bodyHtml,
            backdropPath: tvDetails.backdropPath,
            buttonText: is4k ? (JE.t('jellyseerr_btn_request_4k') || 'Request in 4K') : undefined,
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
                        requestBtn.textContent = is4k ? (JE.t('jellyseerr_btn_request_4k') || 'Request in 4K') : (partialRequestsEnabled ? JE.t('jellyseerr_modal_request_selected') : JE.t('jellyseerr_modal_request'));
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
                            requestBtn.textContent = is4k ? (JE.t('jellyseerr_btn_request_4k') || 'Request in 4K') : JE.t('jellyseerr_modal_request_selected');
                            return;
                        }
                        await requestTvSeasons(tmdbId, selectedSeasons, settings, searchResultItem, is4k);
                        JE.toast(JE.t('jellyseerr_modal_toast_request_success', { count: selectedSeasons.length, title: resolvedShowTitle }), 4000);
                    } else {
                        // Partial requests disabled: request all non-special seasons to avoid locking specials
                        const allSeasons = (tvDetails?.seasons || [])
                            .map(season => season.seasonNumber)
                            .filter(seasonNumber => Number.isFinite(seasonNumber) && seasonNumber > 0);

                        if (allSeasons.length > 0) {
                            await requestTvSeasons(tmdbId, allSeasons, settings, searchResultItem, is4k);
                        } else {
                            await requestMedia(tmdbId, 'tv', settings, is4k, searchResultItem);
                        }

                        JE.toast(JE.t('jellyseerr_modal_toast_request_success', { count: 'all', title: resolvedShowTitle }), 4000);
                    }
                    // Notify any listening modals that TV was requested
                    document.dispatchEvent(new CustomEvent('jellyseerr-tv-requested', { detail: { tmdbId, mediaType: 'tv', is4k } }));
                    document.dispatchEvent(new CustomEvent('jellyseerr-media-requested', { detail: { tmdbId, mediaType: 'tv', is4k } }));

                    // Update original card button to pending state
                    internal.markCardRequested(tmdbId, 'tv', is4k);

                    closeFn();
                    setTimeout(() => {
                        const query = new URLSearchParams(window.location.hash.split('?')[1])?.get('query');
                        if (query) {
                            const mainController = JE.jellyseerr;
                            if (mainController) {
                                mainController.fetchAndRenderResults(query, { skipCache: true });
                            }
                        }
                    }, 1000);
                } catch (error) {
                    const resetLabel = is4k
                        ? (JE.t('jellyseerr_btn_request_4k') || 'Request in 4K')
                        : (partialRequestsEnabled ? JE.t('jellyseerr_modal_request_selected') : JE.t('jellyseerr_modal_request'));
                    await internal.handleRequestError(error, 'tv', requestBtn, resetLabel);
                }
            }
        });

        // Populate season list inside the modal (shows immediately, air dates may be empty)
        const seasonList = modalInstance.modalElement.querySelector('.jellyseerr-season-list');
        updateSeasonList(seasonList, tvDetails, partialRequestsEnabled, enableSpecialEpisodes, is4k, jellyfinSeasonMap);
        modalInstance.show();

        // Quota chip — runs async so it doesn't block modal open.
        const tvBodyEl = modalInstance.modalElement.querySelector('.jellyseerr-modal-body');
        if (tvBodyEl) {
            JE.jellyseerrAPI?.fetchUserQuota?.().then(quota => {
                const chip = internal.buildQuotaChip(quota, 'tv');
                if (chip && document.body.contains(modalInstance.modalElement)) {
                    tvBodyEl.insertBefore(chip, tvBodyEl.firstChild);
                }
            }).catch(err => console.warn(`${logPrefix} Quota chip render failed:`, err));
        }

        // Cached air dates — populated once, applied on every render (including polling refreshes)
        const airDateCache = {};

        /**
         * Validates that a string starts with an ISO date format (YYYY-MM-DD).
         * @param {string} d - The date string to validate.
         * @returns {boolean} True if the string matches the date pattern.
         */
        const isValidDate = (d) => /^\d{4}-\d{2}-\d{2}/.test(d);

        /**
         * Merges cached air dates into a Seerr tvDetails object.
         * Seasons without an airDate are backfilled from the cache (immutable per-season).
         * @param {object} details - The Seerr TV show details object.
         */
        function applyAirDateBackfill(details) {
            if (!details?.seasons || Object.keys(airDateCache).length === 0) return;
            details.seasons = details.seasons.map(s => {
                if (!s.airDate && airDateCache[s.seasonNumber]) {
                    return { ...s, airDate: airDateCache[s.seasonNumber] };
                }
                return s;
            });
        }

        // Async backfill: fetch air dates from per-season episode data, with TMDB as fallback
        const seasonsNeedingDates = tvDetails.seasons.filter(s => s.episodeCount > 0 && !s.airDate);
        if (seasonsNeedingDates.length > 0) {
            // Primary: fetch first episode air date from each season (Seerr/TheTVDB has these)
            const seasonFetches = seasonsNeedingDates.map(s =>
                fetchTvSeasonDetails(tmdbId, s.seasonNumber).then(detail => {
                    const firstEp = detail?.episodes?.[0];
                    if (firstEp?.airDate && isValidDate(firstEp.airDate)) {
                        airDateCache[s.seasonNumber] = firstEp.airDate;
                    }
                }).catch(() => {})
            );

            // Fallback: also try TMDB for any gaps (runs in parallel)
            const tmdbFetch = JE.pluginConfig?.TmdbEnabled
                ? fetchTmdbTvDetails(tmdbId).then(tmdbData => {
                    if (!tmdbData?.seasons) return;
                    tmdbData.seasons.forEach(s => {
                        const date = s.air_date || '';
                        if (isValidDate(date) && !airDateCache[s.season_number]) {
                            airDateCache[s.season_number] = date;
                        }
                    });
                }).catch(() => {})
                : Promise.resolve();

            // When all fetches complete, re-render with backfilled dates
            Promise.all([...seasonFetches, tmdbFetch]).then(() => {
                applyAirDateBackfill(tvDetails);
                updateSeasonList(seasonList, tvDetails, partialRequestsEnabled, enableSpecialEpisodes, is4k, jellyfinSeasonMap);
            });
        }

        // Add Select All checkbox functionality
        if (partialRequestsEnabled) {
            const selectAllCheckbox = modalInstance.modalElement.querySelector('#jellyseerr-select-all-seasons');
            if (selectAllCheckbox) {
                // Selector for regular season checkboxes (excludes Season 0 / Specials)
                const regularSeasonSelector = '.jellyseerr-season-item:not([data-season-number="0"]) .jellyseerr-season-checkbox:not(:disabled)';

                // Update Select All checkbox state when individual checkboxes change
                const updateSelectAllState = () => {
                    const allSeasonCheckboxes = seasonList.querySelectorAll(regularSeasonSelector);
                    const checkedCount = seasonList.querySelectorAll(`${regularSeasonSelector}:checked`).length;
                    selectAllCheckbox.checked = checkedCount > 0 && checkedCount === allSeasonCheckboxes.length;
                    selectAllCheckbox.indeterminate = checkedCount > 0 && checkedCount < allSeasonCheckboxes.length;
                };

                // Handle Select All checkbox click — only toggles regular seasons, not Specials
                selectAllCheckbox.addEventListener('change', () => {
                    const allSeasonCheckboxes = seasonList.querySelectorAll(regularSeasonSelector);
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
                applyAirDateBackfill(freshTvDetails);
                updateSeasonList(seasonList, freshTvDetails, partialRequestsEnabled, enableSpecialEpisodes, is4k, jellyfinSeasonMap);
                // Update Select All state after refresh
                if (seasonList._updateSelectAllState) {
                    seasonList._updateSelectAllState();
                }
            }
        }, 10000); // Refresh every 10 seconds

        if (showAdvanced) {
            try {
                const data = await fetchAdvancedRequestData('tv');
                populateAdvancedOptions(modalInstance.modalElement, data, 'tv', is4k);
            } catch (error) {
                console.error(`${logPrefix} Failed to load TV advanced options:`, error);
                JE.toast(JE.t('jellyseerr_err_load_server_options'), 3000);
            }
        }
    };

    function updateSeasonList(seasonListElement, tvDetails, partialRequestsEnabled = true, enableSpecialEpisodes = false, is4kMode = false, jellyfinSeasonMap = null) {
        if (!seasonListElement || !tvDetails) return;

        const seasonStatusMap = {};
        tvDetails.mediaInfo?.seasons?.forEach(s => {
            const modeStatus = is4kMode ? s.status4k : s.status;
            if (modeStatus !== undefined && modeStatus !== null) {
                seasonStatusMap[s.seasonNumber] = modeStatus;
            }
        });
        tvDetails.mediaInfo?.requests?.forEach(r => {
            const requestIs4k = !!r?.is4k;
            if (requestIs4k !== !!is4kMode) return;
            r.seasons?.forEach(sr => { seasonStatusMap[sr.seasonNumber] = sr.status; });
        });

        // Filter out seasons with no episodes, and hide Season 0 (Specials) unless enabled in Seerr
        const seasons = (tvDetails.seasons || [])
            .filter(s => s.episodeCount && s.episodeCount > 0)
            .filter(s => s.seasonNumber !== 0 || enableSpecialEpisodes)
            .slice()
            .sort((a, b) => (a.seasonNumber || 0) - (b.seasonNumber || 0));
        seasons.forEach(season => {
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

            // If Seerr reports Available (5) but neither the show nor this specific season
            // has a Jellyfin media ID, the library entry was deleted and Seerr's status is
            // stale — treat the season as requestable (status 7 = deleted).
            const showJellyfinId = is4kMode
                ? (tvDetails.mediaInfo?.jellyfinMediaId4k || null)
                : (tvDetails.mediaInfo?.jellyfinMediaId || null);
            // Also check per-season Jellyfin IDs from the season info in mediaInfo
            const seasonMediaInfo = tvDetails.mediaInfo?.seasons?.find(s => s.seasonNumber === seasonNumber);
            const seasonJellyfinId = is4kMode
                ? (seasonMediaInfo?.jellyfinMediaId4k || seasonMediaInfo?.jellyfinSeasonId4k || null)
                : (seasonMediaInfo?.jellyfinMediaId || seasonMediaInfo?.jellyfinSeasonId || null);
            const effectiveApiStatus = JE.seerrStatus.effectiveMediaStatus(
                apiStatus, showJellyfinId, jellyfinSeasonMap, seasonNumber
            );
            const canRequest = JE.seerrStatus.isRequestable(effectiveApiStatus);
            const modeDownloads = is4kMode ? (tvDetails.mediaInfo?.downloadStatus4k || []) : (tvDetails.mediaInfo?.downloadStatus || []);
            const hasSeasonDownloads = modeDownloads.some(ds => ds.episode?.seasonNumber === seasonNumber);
            const { labelKey, cssClass: statusClass } = JE.seerrStatus.getDisplayInfo(effectiveApiStatus, hasSeasonDownloads);
            const statusText = JE.t(labelKey);

            // Update the content but preserve the checkbox state if it exists
            const existingCheckbox = seasonItem.querySelector('.jellyseerr-season-checkbox');
            const isChecked = existingCheckbox ? existingCheckbox.checked : false;

            // Disable checkbox if partial requests are disabled OR if the season can't be requested
            const checkboxDisabled = !partialRequestsEnabled || !canRequest;

            // Derive a display name: if the API returns just the number (TheTVDB), generate a proper label.
            // The numeric regex catches bare numbers and zero-padded variants (e.g., "01");
            // this may also match year-named seasons, which is an acceptable tradeoff.
            const trimmedName = (season.name || '').trim();
            const isNumericOnly = trimmedName === String(seasonNumber) || /^0*\d+$/.test(trimmedName);
            const displayName = (trimmedName && !isNumericOnly)
                ? trimmedName
                : (seasonNumber === 0 ? JE.t('jellyseerr_season_specials') : JE.t('jellyseerr_season_name', { number: seasonNumber }));

            // All interpolated values are escaped via escapeHtml() to prevent XSS
            seasonItem.innerHTML = `
                <input type="checkbox" class="jellyseerr-season-checkbox" data-season-number="${escapeHtml(seasonNumber)}" ${checkboxDisabled ? 'disabled' : ''} style="${!partialRequestsEnabled ? 'cursor: not-allowed;' : ''}">
                <div class="jellyseerr-season-info">
                    <div class="jellyseerr-season-name">${escapeHtml(displayName)}</div>
                    <div class="jellyseerr-season-meta">${escapeHtml(season.airDate ? season.airDate.substring(0, 4) : '')}</div>
                </div>
                <div class="jellyseerr-season-episodes">${escapeHtml(season.episodeCount || 0)} ep</div>
                <div class="jellyseerr-season-status jellyseerr-season-status-${escapeHtml(statusClass)}">${escapeHtml(statusText)}</div>
            `;

            if(existingCheckbox) {
                seasonItem.querySelector('.jellyseerr-season-checkbox').checked = isChecked;
            }

            seasonItem.classList.toggle('disabled', !canRequest);

            // Add/Update inline download progress
            const existingProgress = seasonItem.querySelector('.jellyseerr-inline-progress');
            if (existingProgress) existingProgress.remove();

            if (hasSeasonDownloads && modeDownloads.length > 0) {
                const seasonDownloads = modeDownloads.filter(ds => ds.episode?.seasonNumber === seasonNumber);
                if (seasonDownloads.length > 0) {
                    const totalSize = seasonDownloads.reduce((sum, ds) => sum + (ds.size || 0), 0);
                    const totalSizeLeft = seasonDownloads.reduce((sum, ds) => sum + (ds.sizeLeft || 0), 0);
                    if (totalSize > 0) {
                        const aggregatedStatus = { size: totalSize, sizeLeft: totalSizeLeft, status: `${seasonDownloads.length} episode(s) downloading` };
                        const progressElement = internal.createInlineProgress(aggregatedStatus);
                        if (progressElement) seasonItem.appendChild(progressElement);
                    }
                }
            }
        });
    }
    internal.updateSeasonList = updateSeasonList;

})(window.JellyfinEnhanced);
