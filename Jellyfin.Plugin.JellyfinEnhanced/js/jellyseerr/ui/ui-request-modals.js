// /js/jellyseerr/ui/ui-request-modals.js
// Advanced request modals for movies and collections.
(function(JE) {
    'use strict';

    const ui = JE.jellyseerrUI = JE.jellyseerrUI || {};
    JE.internals = JE.internals || {};
    // Shared state is seeded by ui-icons.js, which plugin.js loads first
    // in this group.
    const internal = JE.internals.jellyseerrUi;
    const MediaStatus = JE.seerrStatus.MEDIA;
    const logPrefix = '🪼 Jellyfin Enhanced: Seerr UI:';
    const escapeHtml = JE.escapeHtml;
    const icons = internal.icons; // requires ui-icons.js to be loaded first

    /**
     * Shows the advanced request modal for movies.
     * @param {number} tmdbId - TMDB ID of the movie.
     * @param {string} title - Display title of the movie.
     * @param {Object|null} searchResultItem - Original search result data.
     */
    ui.showMovieRequestModal = async function(tmdbId, title, searchResultItem, is4k = false) {
        const { create, createAdvancedOptionsHTML, populateAdvancedOptions } = JE.jellyseerrModal;
        const { requestMedia, fetchAdvancedRequestData, fetchUserQuota } = JE.jellyseerrAPI;

        const bodyHtml = createAdvancedOptionsHTML('movie');
        const { modalElement, show } = create({
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
                    await internal.handleRequestError(error, 'movie', requestBtn, JE.t('jellyseerr_modal_request'));
                }
            }
        });
        show();

        // Quota chip — runs in parallel with advanced-options fetch.
        const bodyEl = modalElement.querySelector('.jellyseerr-modal-body');
        if (bodyEl) {
            fetchUserQuota().then(quota => {
                const chip = internal.buildQuotaChip(quota, 'movie');
                if (chip && document.body.contains(modalElement)) {
                    bodyEl.insertBefore(chip, bodyEl.firstChild);
                }
            }).catch(err => console.warn(`${logPrefix} Quota chip render failed:`, err));
        }

        try {
            const data = await fetchAdvancedRequestData('movie');
            populateAdvancedOptions(modalElement, data, 'movie', is4k);
        } catch (error) {
            console.error(`${logPrefix} Failed to load advanced options:`, error);
            JE.toast(JE.t('jellyseerr_err_load_server_options'), 3000);
        }


    };

    /**
     * Shows a modal for requesting a collection (all movies in a TMDB collection).
     * @param {number} collectionId - The TMDB collection IDisplayStatus.
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
            const status = movie.mediaInfo?.status || MediaStatus.UNKNOWN;
            const downloads = movie.mediaInfo?.downloadStatus || [];
            const hasActiveDownloads = downloads && downloads.length > 0;
            const isAvailable = status === MediaStatus.AVAILABLE;
            const isRequested = status === MediaStatus.PENDING || status === MediaStatus.PROCESSING;
            const isDisabled = isAvailable || isRequested;

            let statusClass = 'not-requested';
            let statusText = JE.t('jellyseerr_season_status_not_requested') || 'Not Requested';

            if (status === MediaStatus.AVAILABLE) {
                statusClass = 'available';
                statusText = JE.t('jellyseerr_btn_available') || 'Available';
            } else if (status === MediaStatus.PARTIALLY_AVAILABLE) {
                statusClass = 'partially-available';
                statusText = JE.t('jellyseerr_btn_partially_available') || 'Partially Available';
            } else if (status === MediaStatus.PROCESSING) {
                if (hasActiveDownloads) {
                    statusClass = 'processing';
                    statusText = JE.t('jellyseerr_btn_processing') || 'Processing';
                } else {
                    statusClass = 'pending';
                    statusText = JE.t('jellyseerr_btn_requested') || 'Requested';
                }
            } else if (status === MediaStatus.PENDING) {
                statusClass = 'pending';
                statusText = JE.t('jellyseerr_btn_pending') || 'Pending';
            }

            const year = movie.releaseDate ? new Date(movie.releaseDate).getFullYear() : '';
            const poster = movie.posterPath
                ? `https://image.tmdb.org/t/p/w92${movie.posterPath}`
                : JE.cdn.url('ibb', 'fdbkXQdP/jellyseerr-poster-not-found.png');

            return `
                <div class="jellyseerr-collection-movie-row">
                    <input type="checkbox"
                           class="jellyseerr-collection-checkbox"
                           id="movie-${escapeHtml(movie.id)}"
                           data-tmdb-id="${escapeHtml(movie.id)}"
                           ${isDisabled ? 'disabled' : 'checked'}>
                    <img src="${escapeHtml(poster)}" alt="${escapeHtml(movie.title)}" class="jellyseerr-collection-movie-poster">
                    <div class="jellyseerr-collection-movie-details">
                        <div class="title">${escapeHtml(movie.title)}</div>
                        <div class="year">${escapeHtml(year)}</div>
                    </div>
                    <div class="jellyseerr-season-status jellyseerr-season-status-${escapeHtml(statusClass)}">${escapeHtml(statusText)}</div>
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
                    let otherFailures = 0;
                    let quotaHitError = null;
                    for (const tmdbId of selectedMovies) {
                        try {
                            await requestMedia(tmdbId, 'movie', settings, false, searchResultItem);
                            successCount++;
                        } catch (error) {
                            // Once quota is hit every remaining request will also fail — break.
                            if (ui.isQuotaError && ui.isQuotaError(error)) {
                                quotaHitError = error;
                                break;
                            }
                            otherFailures++;
                            console.error(`Failed to request movie ${tmdbId}:`, error);
                        }
                    }

                    const requestedLabel = JE.t('jellyseerr_toast_collection_requested') || 'Requested';
                    const moviesLabel = JE.t('jellyseerr_toast_movies') || 'movies';
                    const total = selectedMovies.length;
                    let toastText = `${requestedLabel} ${successCount} of ${total} ${moviesLabel}`;
                    if (otherFailures > 0) {
                        toastText += ' ' + JE.t('jellyseerr_toast_collection_failed_count', { count: otherFailures });
                    }
                    JE.toast(toastText, 4000);
                    if (quotaHitError) {
                        await ui.showQuotaErrorDialog(quotaHitError, 'movie');
                    }
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
                populateAdvancedOptions(modalInstance.modalElement, advancedData, 'movie', false);
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

})(window.JellyfinEnhanced);
