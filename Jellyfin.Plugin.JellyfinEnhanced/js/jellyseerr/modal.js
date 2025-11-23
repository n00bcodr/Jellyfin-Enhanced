// /js/jellyseerr/modal.js
(function(JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced: Jellyseerr Modal:';
    const modal = {};

    /**
     * Creates and manages a generic modal for Jellyseerr requests.
     * @param {object} options - Configuration for the modal.
     * @param {string} options.title - The main title of the modal.
     * @param {string} options.subtitle - The subtitle (usually the movie/show name).
     * @param {string} options.bodyHtml - The HTML content for the modal body.
     * @param {string} options.backdropPath - The backdrop image path for the header.
     * @param {function} options.onSave - The callback function to execute when the primary button is clicked.
     * @returns {object} - An object with methods to show and close the modal.
     */
    modal.create = function({ title, subtitle, bodyHtml, backdropPath, onSave }) {
        const modalElement = document.createElement('div');
        modalElement.className = 'jellyseerr-season-modal';
        modalElement.setAttribute('role', 'dialog');
        modalElement.setAttribute('aria-modal', 'true');
        modalElement.setAttribute('tabindex', '-1');

        const backdropImage = backdropPath
            ? `url('https://image.tmdb.org/t/p/w1280${backdropPath}')`
            : 'linear-gradient(45deg, #3b82f6, #8b5cf6)';

        modalElement.innerHTML = `
            <div class="jellyseerr-season-content" role="document" aria-labelledby="jellyseerr-modal-title">
                <div class="jellyseerr-season-header" style="background-image: ${backdropImage}; background-size: cover; background-position: center;">
                    <div id="jellyseerr-modal-title" class="jellyseerr-season-title">${title}</div>
                    <div class="jellyseerr-season-subtitle">${subtitle}</div>
                </div>
                <div class="jellyseerr-modal-body" style="padding: 24px; max-height: calc(80vh - 200px); overflow-y: auto;">
                    ${bodyHtml}
                </div>
                <div class="jellyseerr-modal-footer">
                    <button class="jellyseerr-modal-button jellyseerr-modal-button-secondary" aria-label="${JE.t('jellyseerr_modal_cancel')}">${JE.t('jellyseerr_modal_cancel')}</button>
                    <button class="jellyseerr-modal-button jellyseerr-modal-button-primary" aria-label="${JE.t('jellyseerr_modal_request')}">${JE.t('jellyseerr_modal_request')}</button>
                </div>
            </div>
        `;

        // Handle keyboard navigation
        const handleKeydown = (e) => {
            // Close on Escape
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                history.back();
                return;
            }

            // Tab key focus trap
            if (e.key === 'Tab') {
                const focusableElements = modalElement.querySelectorAll(
                    'button:not([disabled]), select:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
                );
                const focusableArray = Array.from(focusableElements);

                if (focusableArray.length === 0) return;

                const firstElement = focusableArray[0];
                const lastElement = focusableArray[focusableArray.length - 1];

                if (e.shiftKey) {
                    // Shift+Tab: if on first element, wrap to last
                    if (document.activeElement === firstElement || document.activeElement === modalElement) {
                        e.preventDefault();
                        lastElement.focus();
                    }
                } else {
                    // Tab: if on last element, wrap to first
                    if (document.activeElement === lastElement) {
                        e.preventDefault();
                        firstElement.focus();
                    }
                }
            }
        };

        const show = () => {
            document.body.appendChild(modalElement);
            document.body.classList.add('jellyseerr-modal-is-open');
            // Add a state to history to handle back button for closing
            history.pushState(null, '', location.href);
            window.addEventListener('popstate', close);
            document.addEventListener('keydown', handleKeydown);
            setTimeout(() => {
                modalElement.classList.add('show');
                // Focus the first interactive element in the modal
                const firstFocusable = modalElement.querySelector('button:not([disabled]), select:not([disabled]), input:not([disabled]), [tabindex="0"]');
                if (firstFocusable) {
                    firstFocusable.focus();
                } else {
                    modalElement.focus();
                }
            }, 10);
        };

        const close = () => {
            window.removeEventListener('popstate', close);
            document.removeEventListener('keydown', handleKeydown);
            modalElement.classList.remove('show');
            document.body.classList.remove('jellyseerr-modal-is-open');
            setTimeout(() => {
                if (document.body.contains(modalElement)) {
                    document.body.removeChild(modalElement);
                }
            }, 300);
        };

        // Event listeners for closing the modal
        modalElement.querySelector('.jellyseerr-modal-button-secondary').addEventListener('click', () => history.back());
        modalElement.addEventListener('click', (e) => { if (e.target === modalElement) history.back(); });

        // Event listener for the primary action button
        const requestButton = modalElement.querySelector('.jellyseerr-modal-button-primary');
        requestButton.addEventListener('click', () => onSave(modalElement, requestButton, close));

        return { modalElement, show, close };
    };

    /**
     * Generates the HTML string for the advanced request options form.
     * @param {string} idPrefix - A prefix ('movie' or 'tv') to ensure unique element IDs.
     * @returns {string} - The HTML content for the form.
     */
    modal.createAdvancedOptionsHTML = function(idPrefix) {
        return `
            <div class="jellyseerr-advanced-options">
                <h3>${JE.t('jellyseerr_advanced_options')}</h3>
                <div class="jellyseerr-form-row">
                    <div class="jellyseerr-form-group">
                        <label for="${idPrefix}-server">${JE.t('jellyseerr_server_select')}</label>
                        <select is="emby-select" id="${idPrefix}-server" class="emby-select"></select>
                    </div>
                    <div class="jellyseerr-form-group">
                        <label for="${idPrefix}-quality">${JE.t('jellyseerr_quality_select')}</label>
                        <select is="emby-select" id="${idPrefix}-quality" class="emby-select"></select>
                    </div>
                </div>
                <div class="jellyseerr-form-row">
                    <div class="jellyseerr-form-group">
                        <label for="${idPrefix}-folder">${JE.t('jellyseerr_folder_select')}</label>
                        <select is="emby-select" id="${idPrefix}-folder" class="emby-select"></select>
                    </div>
                </div>
            </div>
        `;
    };

    /**
     * Populates the select dropdowns in the advanced options form.
     * @param {HTMLElement} modalElement - The root element of the modal.
     * @param {object} data - The data fetched from the API, containing servers, profiles, and folders.
     * @param {string} idPrefix - The prefix ('movie' or 'tv') used for the element IDs.
     */
    modal.populateAdvancedOptions = function(modalElement, data, idPrefix) {
        // Use a timer to ensure emby-select elements are ready
        let attempts = 0;
        const maxAttempts = 50; // 5 seconds
        const interval = setInterval(() => {
            const serverSelect = modalElement.querySelector(`#${idPrefix}-server`);
            const qualitySelect = modalElement.querySelector(`#${idPrefix}-quality`);
            const folderSelect = modalElement.querySelector(`#${idPrefix}-folder`);

            if (serverSelect && qualitySelect && folderSelect) {
                clearInterval(interval);

                serverSelect.innerHTML = '<option value="">Select Server...</option>';
                qualitySelect.innerHTML = '<option value="">Select Quality...</option>';
                folderSelect.innerHTML = '<option value="">Select Folder...</option>';

                data.servers.forEach(server => {
                    const option = document.createElement('option');
                    option.value = server.id;
                    option.textContent = server.name || `Server ${server.id}`;
                    if (server.isDefault) option.selected = true;
                    serverSelect.appendChild(option);
                });

                function updateServerDependentOptions() {
                    const selectedServer = data.servers.find(s => s.id == serverSelect.value);
                    qualitySelect.innerHTML = '<option value="">Select Quality...</option>';
                    folderSelect.innerHTML = '<option value="">Select Folder...</option>';
                    if (!selectedServer) return;

                    selectedServer.qualityProfiles.forEach(profile => {
                        const option = document.createElement('option');
                        option.value = profile.id;
                        option.textContent = profile.name || `Profile ${profile.id}`;
                        if (profile.id === selectedServer.activeProfileId) option.selected = true;
                        qualitySelect.appendChild(option);
                    });
                    selectedServer.rootFolders.forEach(folder => {
                        const option = document.createElement('option');
                        option.value = folder.path;
                        option.textContent = folder.path;
                        if (folder.path === selectedServer.activeDirectory) option.selected = true;
                        folderSelect.appendChild(option);
                    });
                }

                serverSelect.addEventListener('change', updateServerDependentOptions);
                // Trigger initial population if a default server is selected
                if (serverSelect.value) {
                    updateServerDependentOptions();
                }

            } else {
                attempts++;
                if (attempts > maxAttempts) {
                    clearInterval(interval);
                    console.error(`${logPrefix} Could not find advanced options elements in modal after ${maxAttempts} attempts.`);
                }
            }
        }, 100);
    };

    // Expose the modal module on the global JE object
    JE.jellyseerrModal = modal;

})(window.JellyfinEnhanced);