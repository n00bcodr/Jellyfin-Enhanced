// /js/jellyseerr/moreinfo/more-info-modal-actions-tv.js
// TV request buttons: season request split-button, 4K variants and
// the "Request More" button.
(function(JE) {
    'use strict';

    JE.internals = JE.internals || {};
    // Shared state is seeded by more-info-modal-data.js, which plugin.js loads
    // first in this group.
    const internal = JE.internals.moreInfoModal;
    const DisplayStatus = JE.seerrStatus.DISPLAY;

/**
 * Render request/4K actions and download progress inside the modal.
 */
function buildTvActions(data, show4kOption = false) {
    const mediaInfo = data.mediaInfo || {};
    const status = mediaInfo.status ?? 1;
    const status4k = mediaInfo.status4k ?? 1;

    // If Seerr reports Available (5) but the item has no Jellyfin media ID,
    // the library was wiped and Seerr's status is stale — treat as requestable.
    const jellyfinMediaId = mediaInfo.jellyfinMediaId || null;
    const jellyfinMediaId4k = mediaInfo.jellyfinMediaId4k || null;
    const effectiveStatus = JE.seerrStatus.effectiveMediaStatus(status, jellyfinMediaId);
    const effectiveStatus4k = JE.seerrStatus.effectiveMediaStatus(status4k, jellyfinMediaId4k);

    if (!JE.seerrStatus.isRequestable(effectiveStatus)) {
        return null;
    }

    const container = document.createElement('div');
    container.className = 'je-more-info-actions-row';

    if (show4kOption) {
        const buttonGroup = document.createElement('div');
        buttonGroup.className = 'jellyseerr-button-group je-more-info-button-group';

        const mainButton = document.createElement('button');
        mainButton.className = 'jellyseerr-request-button jellyseerr-split-main jellyseerr-button-request';
        mainButton.innerHTML = `${JE.jellyseerrUIIcons?.request || '<span class="material-icons">download</span>'}<span>${JE.t('jellyseerr_btn_request')}</span>`;
        mainButton.dataset.tmdbId = data.id;
        mainButton.dataset.mediaType = 'tv';

        const arrowButton = document.createElement('button');
        arrowButton.className = 'jellyseerr-split-arrow';
        arrowButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M12.53 16.28a.75.75 0 01-1.06 0l-7.5-7.5a.75.75 0 011.06-1.06L12 14.69l6.97-6.97a.75.75 0 111.06 1.06l-7.5 7.5z" clip-rule="evenodd" /></svg>';
        arrowButton.title = JE.t('jellyseerr_btn_request_4k') || 'Request in 4K';
        arrowButton.dataset.tmdbId = data.id;
        arrowButton.dataset.toggle4k = 'true';

        mainButton.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (JE.jellyseerrUI?.showSeasonSelectionModal) {
                JE.jellyseerrUI.showSeasonSelectionModal(data.id, 'tv', data.title || data.name, data, false);
            }
        });

        let open4k = null;
        const close4k = () => {
            if (open4k) {
                open4k.remove();
                open4k = null;
                document.removeEventListener('click', handleDocClick, true);
            }
        };
        const handleDocClick = (ev) => {
            if (!open4k) return;
            if (!open4k.contains(ev.target) && !arrowButton.contains(ev.target)) {
                close4k();
            }
        };

        arrowButton.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (open4k) {
                close4k();
                return;
            }

            const menu = document.createElement('div');
            menu.className = 'je-4k-popup';
            const option = document.createElement('button');
            option.className = 'je-4k-popup-item';

            const tvPopupDs4k = JE.seerrStatus.resolveDisplayStatus(status4k, false);
            if (tvPopupDs4k === DisplayStatus.AVAILABLE) {
                option.textContent = `4K ${JE.t('jellyseerr_btn_available') || 'Available'}`;
                option.disabled = true;
                option.classList.add('je-4k-available');
            } else if (tvPopupDs4k === DisplayStatus.PENDING || tvPopupDs4k === DisplayStatus.REQUESTED || tvPopupDs4k === DisplayStatus.PROCESSING) {
                option.textContent = `4K ${JE.t('jellyseerr_btn_requested') || 'Requested'}`;
                option.disabled = true;
                option.classList.add(tvPopupDs4k === DisplayStatus.PROCESSING ? 'je-4k-processing' : 'je-4k-pending');
            } else if (tvPopupDs4k === DisplayStatus.BLOCKED) {
                option.textContent = `4K ${JE.t('jellyseerr_btn_blocklisted') || 'Blocklisted'}`;
                option.disabled = true;
                option.classList.add('je-4k-blocklisted');
            } else {
                option.textContent = JE.t('jellyseerr_btn_request_4k') || 'Request in 4K';
                option.classList.add('je-4k-request');
                option.addEventListener('click', async (ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    close4k();
                    if (JE.jellyseerrUI?.showSeasonSelectionModal) {
                        JE.jellyseerrUI.showSeasonSelectionModal(data.id, 'tv', data.title || data.name, data, true);
                    }
                });
            }

            menu.appendChild(option);
            document.body.appendChild(menu);
            const rect = arrowButton.getBoundingClientRect();
            menu.style.position = 'fixed';
            menu.style.left = `${rect.left}px`;
            menu.style.top = `${rect.bottom + 6}px`;
            requestAnimationFrame(() => menu.classList.add('show'));
            open4k = menu;
            document.addEventListener('click', handleDocClick, true);
        });

        buttonGroup.appendChild(mainButton);
        buttonGroup.appendChild(arrowButton);
        container.appendChild(buttonGroup);
        return container;
    }

    const requestButton = document.createElement('button');
    requestButton.className = 'jellyseerr-request-button jellyseerr-button-request';
    requestButton.innerHTML = `${JE.jellyseerrUIIcons?.request || '<span class="material-icons">download</span>'}<span>${JE.t('jellyseerr_btn_request')}</span>`;
    requestButton.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();

        // TV always shows season selection modal
        if (JE.jellyseerrUI?.showSeasonSelectionModal) {
            JE.jellyseerrUI.showSeasonSelectionModal(data.id, 'tv', data.title || data.name, data);
        }
    });

    container.appendChild(requestButton);
    return container;
}

function buildSingleTv4kButton(data) {
    const button = document.createElement('button');
    button.className = 'jellyseerr-request-button jellyseerr-button-request';
    button.innerHTML = `${JE.jellyseerrUIIcons?.request || '<span class="material-icons">download</span>'}<span>${JE.t('jellyseerr_btn_request_4k') || 'Request in 4K'}</span>`;
    button.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (JE.jellyseerrUI?.showSeasonSelectionModal) {
            JE.jellyseerrUI.showSeasonSelectionModal(data.id, 'tv', data.title || data.name, data, true);
        }
    });
    return button;
}

/**
 * Build "Request More" button for TV shows with some seasons already requested
 */
function buildTvRequestMoreButton(data, show4kOption = false, canRequest4k = false) {
    const container = document.createElement('div');
    container.className = 'je-more-info-actions-row';

    if (show4kOption) {
        const buttonGroup = document.createElement('div');
        buttonGroup.className = 'jellyseerr-button-group je-more-info-button-group';

        const mainButton = document.createElement('button');
        mainButton.className = 'jellyseerr-request-button jellyseerr-split-main jellyseerr-button-request';
        mainButton.innerHTML = `${JE.jellyseerrUIIcons?.request || '<span class="material-icons">download</span>'}<span>${JE.t('jellyseerr_btn_request_more') || 'Request More'}</span>`;
        mainButton.dataset.tmdbId = data.id;
        mainButton.dataset.mediaType = 'tv';
        mainButton.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (JE.jellyseerrUI?.showSeasonSelectionModal) {
                JE.jellyseerrUI.showSeasonSelectionModal(data.id, 'tv', data.title || data.name, data, false);
            }
        });

        const arrowButton = document.createElement('button');
        arrowButton.className = 'jellyseerr-split-arrow';
        arrowButton.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M12.53 16.28a.75.75 0 01-1.06 0l-7.5-7.5a.75.75 0 011.06-1.06L12 14.69l6.97-6.97a.75.75 0 111.06 1.06l-7.5 7.5z" clip-rule="evenodd" /></svg>';
        arrowButton.title = JE.t('jellyseerr_btn_request_4k') || 'Request in 4K';

        let open4k = null;
        const close4k = () => {
            if (open4k) {
                open4k.remove();
                open4k = null;
                document.removeEventListener('click', handleDocClick, true);
            }
        };
        const handleDocClick = (ev) => {
            if (!open4k) return;
            if (!open4k.contains(ev.target) && !arrowButton.contains(ev.target)) {
                close4k();
            }
        };

        arrowButton.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (open4k) {
                close4k();
                return;
            }

            const menu = document.createElement('div');
            menu.className = 'je-4k-popup';
            const option = document.createElement('button');
            option.className = 'je-4k-popup-item';
            option.textContent = JE.t('jellyseerr_btn_request_4k') || 'Request in 4K';

            if (!canRequest4k) {
                option.disabled = true;
                option.textContent = `4K ${JE.t('jellyseerr_btn_requested') || 'Requested'}`;
                option.classList.add('je-4k-pending');
            } else {
                option.classList.add('je-4k-request');
                option.addEventListener('click', async (ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    close4k();
                    if (JE.jellyseerrUI?.showSeasonSelectionModal) {
                        JE.jellyseerrUI.showSeasonSelectionModal(data.id, 'tv', data.title || data.name, data, true);
                    }
                });
            }

            menu.appendChild(option);
            document.body.appendChild(menu);
            const rect = arrowButton.getBoundingClientRect();
            menu.style.position = 'fixed';
            menu.style.left = `${rect.left}px`;
            menu.style.top = `${rect.bottom + 6}px`;
            requestAnimationFrame(() => menu.classList.add('show'));
            open4k = menu;
            document.addEventListener('click', handleDocClick, true);
        });

        buttonGroup.appendChild(mainButton);
        buttonGroup.appendChild(arrowButton);
        container.appendChild(buttonGroup);
        return container;
    }

    const requestButton = document.createElement('button');
    requestButton.className = 'jellyseerr-request-button jellyseerr-button-request';
    requestButton.innerHTML = `${JE.jellyseerrUIIcons?.request || '<span class="material-icons">download</span>'}<span>${JE.t('jellyseerr_btn_request_more') || 'Request More'}</span>`;
    requestButton.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();

        // Show season selection modal for partially available shows
        if (JE.jellyseerrUI?.showSeasonSelectionModal) {
            JE.jellyseerrUI.showSeasonSelectionModal(data.id, 'tv', data.title || data.name, data);
        }
    });

    container.appendChild(requestButton);
    return container;
}
    internal.buildTvActions = buildTvActions;
    internal.buildSingleTv4kButton = buildSingleTv4kButton;
    internal.buildTvRequestMoreButton = buildTvRequestMoreButton;

})(window.JellyfinEnhanced);
