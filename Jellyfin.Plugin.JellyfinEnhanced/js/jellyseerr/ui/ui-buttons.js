// /js/jellyseerr/ui/ui-buttons.js
// Request-button configuration for movie/TV/collection cards.
(function(JE) {
    'use strict';

    const ui = JE.jellyseerrUI = JE.jellyseerrUI || {};
    JE.internals = JE.internals || {};
    // Shared state is seeded by ui-icons.js, which plugin.js loads first
    // in this group.
    const internal = JE.internals.jellyseerrUi;
    const state = internal.state;
    const escapeHtml = JE.escapeHtml;
    const MediaStatus = JE.seerrStatus.MEDIA;
    const DisplayStatus = JE.seerrStatus.DISPLAY;
    const icons = internal.icons; // requires ui-icons.js to be loaded first

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
            const seasonAnalysis = item.mediaInfo?.seasons ? internal.analyzeSeasonStatuses(item.mediaInfo.seasons) : null;
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
            case MediaStatus.PENDING: setButton(JE.t('jellyseerr_btn_pending'), icons.pending, 'jellyseerr-button-pending'); break;
            case MediaStatus.PROCESSING: setButton(JE.t('jellyseerr_btn_request'), icons.request, 'jellyseerr-button-request'); break;
            case MediaStatus.DELETED: setButton(JE.t(seasonAnalysis?.availableCount > 0 ? 'jellyseerr_btn_request_more' : 'jellyseerr_btn_request'), icons.request, 'jellyseerr-button-request'); break;
            case MediaStatus.PARTIALLY_AVAILABLE:
                setButton(JE.t('jellyseerr_btn_request_missing'), icons.request, 'jellyseerr-button-partially-available');
                if (item?.mediaInfo?.downloadStatus?.length > 0 || item?.mediaInfo?.downloadStatus4k?.length > 0) {
                    internal.addDownloadProgressHover(button, item);
                }
                break;
            case MediaStatus.AVAILABLE: setButton(JE.t('jellyseerr_btn_available'), icons.available, 'jellyseerr-button-available', true, seasonAnalysis?.total > 1 ? JE.t('jellyseerr_all_seasons', {count: seasonAnalysis.total}) : null); break;
            case MediaStatus.BLOCKED: setButton(JE.t('jellyseerr_btn_blocklisted'), icons.cancel, 'jellyseerr-button-blocklisted', true); break;
            default: setButton(JE.t('jellyseerr_btn_request'), icons.request, 'jellyseerr-button-request', false, seasonAnalysis?.total > 1 ? JE.t('jellyseerr_seasons_available', {count: seasonAnalysis.total}) : null); break;
        }

        const show4KOption = !!JE.pluginConfig.JellyseerrEnable4KTvRequests;
        const status4k = item.mediaInfo ? item.mediaInfo.status4k : 1;

        if (show4KOption && !button.closest('.jellyseerr-button-group')) {
            const buttonGroup = document.createElement('div');
            buttonGroup.className = 'jellyseerr-button-group';

            const mainButton = button.cloneNode(true);
            mainButton.classList.add('jellyseerr-split-main');
            mainButton.dataset.tmdbId = item.id;
            mainButton.dataset.mediaType = 'tv';
            mainButton.dataset.searchResultItem = JSON.stringify(item);

            const arrowButton = document.createElement('button');
            arrowButton.className = 'jellyseerr-split-arrow';
            arrowButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M12.53 16.28a.75.75 0 01-1.06 0l-7.5-7.5a.75.75 0 011.06-1.06L12 14.69l6.97-6.97a.75.75 0 111.06 1.06l-7.5 7.5z" clip-rule="evenodd" /></svg>';
            arrowButton.dataset.tmdbId = item.id;
            arrowButton.dataset.toggle4k = 'true';

            const tvDs4k = JE.seerrStatus.resolveDisplayStatus(status4k, false);
            if (tvDs4k === DisplayStatus.AVAILABLE) {
                arrowButton.disabled = true;
                arrowButton.classList.add('jellyseerr-split-arrow-disabled', 'jellyseerr-4k-available');
                arrowButton.title = '4K Available';
            } else if (tvDs4k === DisplayStatus.PENDING || tvDs4k === DisplayStatus.REQUESTED || tvDs4k === DisplayStatus.PROCESSING) {
                arrowButton.classList.add('jellyseerr-4k-pending');
                arrowButton.title = '4K Requested';
            } else {
                arrowButton.title = JE.t('jellyseerr_btn_request_4k');
            }

            buttonGroup.appendChild(mainButton);
            buttonGroup.appendChild(arrowButton);
            button.replaceWith(buttonGroup);

            arrowButton.addEventListener('click', (e) => {
                e.stopPropagation();
                if (state.active4KPopup && state.active4KPopup.parentElement === buttonGroup) {
                    internal.hide4KPopup();
                } else {
                    internal.show4KPopup(buttonGroup, item);
                }
            });
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

            const hasMainDownloads = item.mediaInfo?.downloadStatus?.length > 0 || item.mediaInfo?.downloadStatus4k?.length > 0;
            const mainDisplayStatus = JE.seerrStatus.resolveDisplayStatus(status, hasMainDownloads);
            const { labelKey: mainLabelKey, cssClass: mainButtonClass, disabled: mainButtonDisabled, showSpinner: mainShowSpinner, iconKey } = JE.seerrStatus.getButtonConfig(mainDisplayStatus);
            const mainButtonText = JE.t(mainLabelKey);
            const mainButtonIcon = icons[iconKey] || '';

            // Main button
            const mainButton = document.createElement('button');
            mainButton.className = `jellyseerr-request-button jellyseerr-split-main ${mainButtonClass}`;
            mainButton.disabled = mainButtonDisabled;
            mainButton.innerHTML = `${mainButtonIcon}<span>${mainButtonText}</span>${mainShowSpinner ? '<span class="jellyseerr-button-spinner"></span>' : ''}`;
            mainButton.dataset.tmdbId = item.id;
            mainButton.dataset.mediaType = 'movie';
            mainButton.dataset.searchResultItem = JSON.stringify(item);

            if (hasMainDownloads && mainButtonDisabled) {
                internal.addDownloadProgressHover(mainButton, item);
            }

            const arrowButton = document.createElement('button');
            arrowButton.className = 'jellyseerr-split-arrow';
            arrowButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M12.53 16.28a.75.75 0 01-1.06 0l-7.5-7.5a.75.75 0 011.06-1.06L12 14.69l6.97-6.97a.75.75 0 111.06 1.06l-7.5 7.5z" clip-rule="evenodd" /></svg>';
            arrowButton.dataset.tmdbId = item.id;
            arrowButton.dataset.toggle4k = 'true';

            const ds4k = JE.seerrStatus.resolveDisplayStatus(status4k, false);
            if (ds4k === DisplayStatus.AVAILABLE) {
                arrowButton.disabled = true;
                arrowButton.classList.add('jellyseerr-split-arrow-disabled', 'jellyseerr-4k-available');
                arrowButton.title = '4K Available';
            } else if (ds4k === DisplayStatus.PENDING || ds4k === DisplayStatus.REQUESTED || ds4k === DisplayStatus.PROCESSING) {
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
                            await JE.jellyseerrAPI.requestMedia(item.id, 'movie', {}, false, item);
                            if (!item.mediaInfo) item.mediaInfo = {};
                            item.mediaInfo.status = 3;
                            mainButton.innerHTML = `<span>${JE.t('jellyseerr_btn_requested')}</span>${icons.requested}`;
                            mainButton.classList.remove('jellyseerr-button-request');
                            mainButton.classList.add('jellyseerr-button-pending');
                        } catch (error) {
                            mainButton.disabled = false;
                            // Quota errors get a themed dialog; restore button to idle.
                            if (ui.isQuotaError && ui.isQuotaError(error)) {
                                await ui.showQuotaErrorDialog(error, 'movie');
                                mainButton.innerHTML = `${icons.request}<span>${JE.t('jellyseerr_btn_request')}</span>`;
                                return;
                            }
                            let errorMessage = JE.t('jellyseerr_btn_error');
                            if (error.status === 404) {
                                errorMessage = JE.t('jellyseerr_btn_user_not_found');
                            } else if (error.status === 403) {
                                const code = error.responseJSON?.code;
                                errorMessage = JE.t(code ? `jellyseerr_err_${code}` : 'jellyseerr_err_no_request_permission')
                                    || JE.t('jellyseerr_err_no_request_permission');
                            } else if (error.responseJSON?.message) {
                                errorMessage = error.responseJSON.message;
                            }
                            // Escape API-sourced error message before inserting into HTML
                            mainButton.innerHTML = `<span>${escapeHtml(errorMessage)}</span>${icons.error}`;
                            mainButton.classList.add('jellyseerr-button-error');
                        }
                    }
                });
            }

            arrowButton.addEventListener('click', (e) => {
                e.stopPropagation();
                if (state.active4KPopup && state.active4KPopup.parentElement === buttonGroup) {
                    internal.hide4KPopup();
                } else {
                    internal.show4KPopup(buttonGroup, item);
                }
            });
            return;
        }

        const hasStdDownloads = item.mediaInfo?.downloadStatus?.length > 0 || item.mediaInfo?.downloadStatus4k?.length > 0;
        const stdDisplayStatus = JE.seerrStatus.resolveDisplayStatus(status, hasStdDownloads);
        const { labelKey: stdLabelKey, cssClass: stdClass, disabled: stdDisabled, showSpinner: stdSpinner, iconKey: stdIconKey } = JE.seerrStatus.getButtonConfig(stdDisplayStatus);

        if (stdSpinner) {
            button.innerHTML = `${icons[stdIconKey] || ''}<span>${JE.t(stdLabelKey)}</span><span class="jellyseerr-button-spinner"></span>`;
            button.disabled = true;
            button.className = `jellyseerr-request-button ${stdClass}`;
            if (hasStdDownloads) internal.addDownloadProgressHover(button, item);
        } else {
            setButton(JE.t(stdLabelKey), icons[stdIconKey] || '', stdClass, stdDisabled);
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
                        await JE.jellyseerrAPI.requestMedia(item.id, 'movie', {}, false, item);
                        if (!item.mediaInfo) item.mediaInfo = {};
                        item.mediaInfo.status = 3;
                        button.innerHTML = `<span>${JE.t('jellyseerr_btn_requested')}</span>${icons.requested}`;
                        button.classList.remove('jellyseerr-button-request');
                        button.classList.add('jellyseerr-button-pending');
                    } catch (error) {
                        button.disabled = false;
                        // Quota errors get a themed dialog; restore button to idle.
                        if (ui.isQuotaError && ui.isQuotaError(error)) {
                            await ui.showQuotaErrorDialog(error, 'movie');
                            button.innerHTML = `${icons.request}<span>${JE.t('jellyseerr_btn_request')}</span>`;
                            return;
                        }
                        let errorMessage = JE.t('jellyseerr_btn_error');
                        if (error.status === 404) {
                            errorMessage = JE.t('jellyseerr_btn_user_not_found');
                        } else if (error.status === 403) {
                            const code = error.responseJSON?.code;
                            errorMessage = JE.t(code ? `jellyseerr_err_${code}` : 'jellyseerr_err_no_request_permission')
                                || JE.t('jellyseerr_err_no_request_permission');
                        } else if (error.responseJSON?.message) {
                            errorMessage = error.responseJSON.message;
                        }
                        button.innerHTML = `<span>${escapeHtml(errorMessage)}</span>${icons.error}`;
                        button.classList.add('jellyseerr-button-error');
                    }
                }
            });
        }
    }
    ui.configureRequestButton = configureRequestButton;

    internal.configureRequestButton = configureRequestButton;
    internal.configureCollectionButton = configureCollectionButton;
    internal.configureTvShowButton = configureTvShowButton;
    internal.configureMovieButton = configureMovieButton;

})(window.JellyfinEnhanced);
