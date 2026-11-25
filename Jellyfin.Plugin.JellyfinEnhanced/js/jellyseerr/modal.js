// /js/jellyseerr/modal.js
(function(JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced: Jellyseerr Modal:';
    const modal = {};

    const escapeHtml = JE.escapeHtml;

    /**
     * Formats a byte count into a human-readable string
     * @param {number} bytes
     * @returns {string}
     */
    function formatBytes(bytes) {
        if (!bytes || bytes <= 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
    }

    /**
     * Builds the label text for a Root Folder <option>, appending the
     * folder's available free space
     * (`{path} ({space})`).
     * @param {object} folder - A rootFolders entry from Seerr's service details response.
     * @returns {string}
     */
    function formatFolderLabel(folder) {
        if (typeof folder.freeSpace === 'number') {
            return `${folder.path} (${formatBytes(folder.freeSpace)})`;
        }
        return folder.path;
    }

    /**
     * Creates and manages a generic modal for Jellyseerr requests.
     * @param {object} options - Configuration for the modal.
     * @param {string} options.title - The main title of the modal.
     * @param {string} options.subtitle - The subtitle (usually the movie/show name).
     * @param {string} options.bodyHtml - The HTML content for the modal body.
     * @param {string} options.backdropPath - TMDB backdrop image path (e.g., '/abc123.jpg').
     * @param {string} options.backdropUrl - Full backdrop image URL (alternative to backdropPath).
     * @param {function} options.onSave - The callback function to execute when the primary button is clicked.
     * @param {function} [options.onClose] - Optional cleanup callback invoked before the modal is removed.
     * @param {string} [options.buttonText] - Optional custom text for the primary button (defaults to localized 'Request').
     * @returns {object} - An object with methods to show and close the modal.
     */
    modal.create = function({ title, subtitle, bodyHtml, backdropPath, backdropUrl, onSave, onClose, buttonText }) {
        const modalElement = document.createElement('div');
        // focuscontainer: Jellyfin's remote navigation stays inside it.
        modalElement.className = 'jellyseerr-season-modal focuscontainer';
        modalElement.setAttribute('role', 'dialog');
        modalElement.setAttribute('aria-modal', 'true');
        modalElement.setAttribute('tabindex', '-1');

        // Support both backdropUrl (full URL) and backdropPath (TMDB path)
        let backdropImage;
        if (backdropUrl) {
            backdropImage = `url('${escapeHtml(backdropUrl)}')`;
        } else if (backdropPath) {
            backdropImage = `url('https://image.tmdb.org/t/p/w1280${escapeHtml(backdropPath)}')`;
        } else {
            backdropImage = 'linear-gradient(45deg, #3b82f6, #8b5cf6)';
        }

        // Build modal structure — bodyHtml is intentionally trusted HTML from internal callers
        const contentEl = document.createElement('div');
        contentEl.className = 'jellyseerr-season-content';
        contentEl.setAttribute('role', 'document');
        contentEl.setAttribute('aria-labelledby', 'jellyseerr-modal-title');

        const headerEl = document.createElement('div');
        headerEl.className = 'jellyseerr-season-header';
        headerEl.style.cssText = `background-image: ${backdropImage}; background-size: cover; background-position: center;`;

        const titleEl = document.createElement('div');
        titleEl.id = 'jellyseerr-modal-title';
        titleEl.className = 'jellyseerr-season-title';
        titleEl.textContent = title;

        const subtitleEl = document.createElement('div');
        subtitleEl.className = 'jellyseerr-season-subtitle';
        subtitleEl.textContent = subtitle;

        headerEl.appendChild(titleEl);
        headerEl.appendChild(subtitleEl);

        const bodyEl = document.createElement('div');
        bodyEl.className = 'jellyseerr-modal-body';
        bodyEl.style.cssText = 'padding: 24px; max-height: calc(80vh - 200px); overflow-y: auto;';
        bodyEl.innerHTML = bodyHtml;

        const footerEl = document.createElement('div');
        footerEl.className = 'jellyseerr-modal-footer';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'jellyseerr-modal-button jellyseerr-modal-button-secondary';
        cancelBtn.setAttribute('aria-label', JE.t('jellyseerr_modal_cancel'));
        cancelBtn.textContent = JE.t('jellyseerr_modal_cancel');

        const primaryBtn = document.createElement('button');
        primaryBtn.className = 'jellyseerr-modal-button jellyseerr-modal-button-primary';
        primaryBtn.setAttribute('aria-label', buttonText || JE.t('jellyseerr_modal_request'));
        primaryBtn.textContent = buttonText || JE.t('jellyseerr_modal_request');

        footerEl.appendChild(cancelBtn);
        footerEl.appendChild(primaryBtn);

        contentEl.appendChild(headerEl);
        contentEl.appendChild(bodyEl);
        contentEl.appendChild(footerEl);

        modalElement.appendChild(contentEl);

        // Handle keyboard navigation
        const handleKeydown = (e) => {
            // Close on Back (Escape or a TV remote's Back)
            if (JE.core.ui.isTvBackKey(e)) {
                e.preventDefault();
                e.stopPropagation();
                JE.core.ui.swallowTvBack();
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

        if (JE.core.ui.isTvLayout()) enableTvSelectPicker(modalElement, bodyEl);

        let restoreFocus = null;

        const show = () => {
            // A Request button disabled by its successful request: its card's poster, or More Info's Close.
            restoreFocus = JE.core.ui.rememberFocus(opener => opener.closest('.jellyseerr-card')?.querySelector('.jellyseerr-poster-image')
                || opener.closest('.je-more-info-modal')?.querySelector('.modal-close'));
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

        let isClosing = false;

        const close = () => {
            if (isClosing) return;
            isClosing = true;

            if (typeof onClose === 'function') {
                try {
                    onClose();
                } catch (err) {
                    console.error(`${logPrefix} onClose handler failed:`, err);
                }
            }

            window.removeEventListener('popstate', close);
            document.removeEventListener('keydown', handleKeydown);
            modalElement.classList.remove('show');
            document.body.classList.remove('jellyseerr-modal-is-open');
            restoreFocus?.();
            setTimeout(() => {
                if (document.body.contains(modalElement)) {
                    document.body.removeChild(modalElement);
                }
                isClosing = false;
            }, 300);
        };

        // Event listeners for closing the modal
        cancelBtn.addEventListener('click', () => history.back());
        modalElement.addEventListener('click', (e) => { if (e.target === modalElement) history.back(); });

        // Event listener for the primary action button
        primaryBtn.addEventListener('click', () => onSave(modalElement, primaryBtn, close));

        return { modalElement, show, close };
    };

    /**
     * Jellyfin's own select list on a TV closes through history.back(), which
     * also closes this dialog. On the TV layout a select opens an in-dialog
     * list of buttons instead, and Back closes that list only.
     * @param {HTMLElement} modalElement
     * @param {HTMLElement} bodyEl
     */
    function enableTvSelectPicker(modalElement, bodyEl) {
        let picker = null;
        let owner = null;

        const closePicker = () => {
            if (!picker) return;
            document.removeEventListener('keydown', onPickerKey, true);
            picker.remove();
            picker = null;
            owner?.focus();
            owner = null;
        };

        const onPickerKey = (e) => {
            if (!JE.core.ui.isTvBackKey(e)) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            JE.core.ui.swallowTvBack();
            closePicker();
        };

        const openPicker = (select) => {
            closePicker();
            owner = select;
            picker = document.createElement('div');
            picker.className = 'jellyseerr-tv-picker';
            picker.setAttribute('role', 'listbox');
            Array.from(select.options).forEach((option) => {
                const item = document.createElement('button');
                item.type = 'button';
                item.className = 'jellyseerr-tv-picker-option focusable';
                item.setAttribute('role', 'option');
                item.setAttribute('aria-selected', String(option.value === select.value));
                item.textContent = option.textContent;
                item.addEventListener('click', () => {
                    select.value = option.value;
                    select.dispatchEvent(new Event('change', { bubbles: true }));
                    closePicker();
                });
                picker.appendChild(item);
            });
            select.insertAdjacentElement('afterend', picker);
            document.addEventListener('keydown', onPickerKey, true);
            (picker.querySelector('[aria-selected="true"]') || picker.firstElementChild)?.focus();
        };

        const intercept = (e) => {
            const select = e.target instanceof Element ? e.target.closest('select') : null;
            if (!select || !bodyEl.contains(select)) return;
            if (e.type === 'keydown' && e.key !== 'Enter') return;
            e.preventDefault();
            e.stopImmediatePropagation();
            if (e.type !== 'mousedown') openPicker(select);
        };

        ['mousedown', 'click', 'keydown'].forEach((type) => modalElement.addEventListener(type, intercept, true));
    }

    /**
     * Generates the HTML string for the advanced request options form.
     * @param {string} idPrefix - A prefix ('movie' or 'tv') to ensure unique element IDs.
     * @returns {string} - The HTML content for the form.
     */
    modal.createAdvancedOptionsHTML = function(idPrefix, { showUser = false } = {}) {
        return `
            <div class="jellyseerr-advanced-options">
                <h3>${JE.t('jellyseerr_advanced_options')}</h3>
                <div class="jellyseerr-form-row">
                    <div class="jellyseerr-form-group">
                        <label for="${idPrefix}-server">${JE.t('jellyseerr_server_select')}</label>
                        <select is="emby-select" id="${idPrefix}-server" class="emby-select"></select>
                    </div>
                </div>
                <div class="jellyseerr-form-row">
                    <div class="jellyseerr-form-group">
                        <label for="${idPrefix}-quality">${JE.t('jellyseerr_quality_select')}</label>
                        <select is="emby-select" id="${idPrefix}-quality" class="emby-select"></select>
                    </div>
                    <div class="jellyseerr-form-group">
                        <label for="${idPrefix}-folder">${JE.t('jellyseerr_folder_select')}</label>
                        <select is="emby-select" id="${idPrefix}-folder" class="emby-select"></select>
                    </div>
                </div>
                <div class="jellyseerr-form-row jellyseerr-tags-group" id="${idPrefix}-tags-group" hidden>
                    <div class="jellyseerr-form-group">
                        <label>${JE.t('jellyseerr_tags_select')}</label>
                        <div class="jellyseerr-tag-list" id="${idPrefix}-tags" role="group"></div>
                    </div>
                </div>
                ${showUser ? `<div class="jellyseerr-form-row">
                    <div class="jellyseerr-form-group">
                        <label for="${idPrefix}-user">${JE.t('jellyseerr_request_as')}</label>
                        <select is="emby-select" id="${idPrefix}-user" class="emby-select"></select>
                    </div>
                </div>` : ''}
            </div>
        `;
    };

    /**
     * A typeable multi-select for tags, like Seerr's: the chosen tags sit in the field as removable chips, typing
     * narrows the list below, Enter or a click adds one, Backspace on an empty box removes the last. The chosen
     * chips carry `.selected` and `data-tag-id`, which readAdvancedOptions reads.
     */
    function buildTagPicker(box, tags, selectedIds) {
        box.textContent = '';
        box.classList.add('jellyseerr-tag-picker');
        const chosen = new Set(selectedIds.filter(id => tags.some(t => t.id === id)));
        const field = document.createElement('div');
        field.className = 'jellyseerr-tag-field';
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'jellyseerr-tag-input';
        input.placeholder = JE.t('jellyseerr_tags_placeholder');
        input.setAttribute('role', 'combobox');
        input.setAttribute('aria-expanded', 'false');
        input.autocomplete = 'off';
        const list = document.createElement('div');
        list.className = 'jellyseerr-tag-options';
        list.setAttribute('role', 'listbox');
        list.hidden = true;
        let active = 0;

        const available = () => {
            const q = input.value.trim().toLowerCase();
            return tags.filter(t => !chosen.has(t.id) && (!q || String(t.label).toLowerCase().includes(q)));
        };
        const closeList = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); };
        const renderChips = () => {
            field.querySelectorAll('.jellyseerr-tag-chip').forEach(c => c.remove());
            tags.filter(t => chosen.has(t.id)).forEach(tag => {
                const chip = document.createElement('span');
                chip.className = 'jellyseerr-tag-chip selected';
                chip.dataset.tagId = tag.id;
                chip.append(document.createTextNode(tag.label));
                const remove = document.createElement('button');
                remove.type = 'button';
                remove.className = 'jellyseerr-tag-remove';
                remove.setAttribute('aria-label', `${JE.t('jellyseerr_tags_remove')} ${tag.label}`);
                remove.textContent = '×';
                remove.addEventListener('click', e => { e.stopPropagation(); chosen.delete(tag.id); renderChips(); renderList(); });
                chip.appendChild(remove);
                field.insertBefore(chip, input);
            });
        };
        const add = tag => { chosen.add(tag.id); input.value = ''; active = 0; renderChips(); renderList(); input.focus(); };
        const renderList = () => {
            list.textContent = '';
            const items = available();
            if (!items.length) { closeList(); return; }
            active = Math.min(active, items.length - 1);
            items.forEach((tag, i) => {
                const option = document.createElement('div');
                option.className = 'jellyseerr-tag-option' + (i === active ? ' active' : '');
                option.setAttribute('role', 'option');
                option.textContent = tag.label;
                // mousedown, so the input keeps focus and the list does not close first.
                option.addEventListener('mousedown', e => { e.preventDefault(); add(tag); });
                list.appendChild(option);
            });
            list.hidden = false;
            input.setAttribute('aria-expanded', 'true');
            list.scrollIntoView({ block: 'nearest' });
        };

        input.addEventListener('input', () => { active = 0; renderList(); });
        input.addEventListener('focus', renderList);
        input.addEventListener('blur', closeList);
        input.addEventListener('keydown', e => {
            const items = available();
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                if (list.hidden) { renderList(); return; }
                active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
                renderList();
                list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
            } else if (e.key === 'Enter') {
                if (!list.hidden && items[active]) { e.preventDefault(); e.stopPropagation(); add(items[active]); }
            } else if (e.key === 'Escape' && !list.hidden) {
                e.stopPropagation();
                closeList();
            } else if (e.key === 'Backspace' && !input.value && chosen.size) {
                chosen.delete([...chosen].pop());
                renderChips();
                renderList();
            }
        });
        field.addEventListener('click', () => input.focus());
        field.appendChild(input);
        box.append(field, list);
        renderChips();
    }

    function userLabel(user) {
        return user.displayName || user.username || `User ${user.id}`;
    }

    /** A round avatar: the user's Jellyfin picture, or their initial when there is none. */
    function userAvatar(user) {
        const wrap = document.createElement('span');
        wrap.className = 'jellyseerr-user-avatar';
        wrap.textContent = userLabel(user).trim().charAt(0).toUpperCase();
        // The Jellyfin picture first, then Seerr's own avatar; the initial stays when neither loads.
        const sources = [];
        if (user.jellyfinUserId && window.ApiClient?.getUrl) {
            sources.push(window.ApiClient.getUrl(`Users/${user.jellyfinUserId}/Images/Primary`, { maxHeight: 64, quality: 90 }));
        }
        const seerrBase = JE.jellyseerrAPI?.resolveJellyseerrBaseUrl?.();
        if (user.avatar && seerrBase) sources.push(/^https?:/i.test(user.avatar) ? user.avatar : `${seerrBase.replace(/\/$/, '')}${user.avatar}`);
        const tryNext = () => {
            const src = sources.shift();
            if (!src) return;
            const img = new Image();
            img.alt = '';
            img.addEventListener('load', () => { wrap.textContent = ''; wrap.appendChild(img); });
            img.addEventListener('error', tryNext);
            img.src = src;
        };
        tryNext();
        return wrap;
    }

    /**
     * Replaces the "Request as" select with a list that shows each person's picture next to their name. The
     * select stays, hidden, as the value the form reads.
     */
    function buildUserPicker(select, users) {
        select.style.display = 'none';
        select.parentElement.querySelector('.jellyseerr-user-picker')?.remove();
        const picker = document.createElement('div');
        picker.className = 'jellyseerr-user-picker';
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'jellyseerr-user-toggle';
        toggle.setAttribute('aria-haspopup', 'listbox');
        toggle.setAttribute('aria-expanded', 'false');
        const list = document.createElement('div');
        list.className = 'jellyseerr-user-list';
        list.setAttribute('role', 'listbox');
        list.hidden = true;

        const byId = new Map(users.map(u => [String(u.id), u]));
        const close = () => { list.hidden = true; toggle.setAttribute('aria-expanded', 'false'); };
        const renderToggle = () => {
            toggle.textContent = '';
            const user = byId.get(select.value);
            if (!user) return;
            const name = document.createElement('span');
            name.textContent = userLabel(user);
            toggle.append(userAvatar(user), name);
        };
        users.forEach(user => {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'jellyseerr-user-item';
            item.setAttribute('role', 'option');
            const name = document.createElement('span');
            name.textContent = userLabel(user);
            item.append(userAvatar(user), name);
            item.addEventListener('click', () => { select.value = String(user.id); renderToggle(); close(); toggle.focus(); });
            list.appendChild(item);
        });
        toggle.addEventListener('click', () => {
            list.hidden = !list.hidden;
            toggle.setAttribute('aria-expanded', String(!list.hidden));
            if (!list.hidden) (list.querySelector(`.jellyseerr-user-item:nth-child(${select.selectedIndex + 1})`) || list.firstElementChild)?.focus();
            if (!list.hidden) list.scrollIntoView({ block: 'nearest' });
        });
        picker.addEventListener('keydown', e => {
            if (e.key === 'Escape' && !list.hidden) { e.stopPropagation(); close(); toggle.focus(); }
        });
        renderToggle();
        picker.append(toggle, list);
        select.after(picker);
    }

    /**
     * Populates the select dropdowns in the advanced options form.
     * @param {HTMLElement} modalElement - The root element of the modal.
     * @param {object} data - The data fetched from the API, containing servers, profiles, and folders.
     * @param {string} idPrefix - The prefix ('movie' or 'tv') used for the element IDs.
     * @param {boolean} [is4k] - The request's 4K mode. When provided, only a
     *   server whose `is4k` matches is auto-selected -- Seerr flags one regular
     *   AND one 4K instance as `isDefault: true` each, so without this the last
     *   `isDefault` instance processed always wins regardless of request mode.
     * @param {{serverId?: number, profileId?: number, rootFolder?: string, tags?: number[], userId?: number}} [preset]
     *   Values to start from instead of the server defaults (editing an existing request).
     *   `data.users` fills the "Request as" list when the form has one.
     */
    modal.populateAdvancedOptions = function(modalElement, data, idPrefix, is4k, preset) {
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

                // Seerr returns instances in its own internal order (e.g. 4K
                // instance first) -- sort alphabetically by name so the list is
                // predictable regardless of how Seerr ordered them.
                const sortedServers = [...data.servers].sort((a, b) =>
                    (a.name || '').localeCompare(b.name || ''));

                sortedServers.forEach(server => {
                    const option = document.createElement('option');
                    option.value = server.id;
                    option.textContent = server.name || `Server ${server.id}`;
                    if (preset?.serverId != null ? server.id === preset.serverId : (server.isDefault && (is4k === undefined || !!server.is4k === !!is4k))) {
                        option.selected = true;
                    }
                    serverSelect.appendChild(option);
                });

                const userSelect = modalElement.querySelector(`#${idPrefix}-user`);
                if (userSelect) {
                    userSelect.innerHTML = '';
                    (data.users || []).forEach(user => {
                        const option = document.createElement('option');
                        option.value = user.id;
                        option.textContent = userLabel(user);
                        if (preset?.userId != null ? user.id === preset.userId : user.id === data.currentUserId) option.selected = true;
                        userSelect.appendChild(option);
                    });
                    buildUserPicker(userSelect, data.users || []);
                }

                let usePreset = !!preset;
                const tagsGroup = modalElement.querySelector(`#${idPrefix}-tags-group`);
                const tagsList = modalElement.querySelector(`#${idPrefix}-tags`);

                function renderTags(selectedServer, selectedIds) {
                    if (!tagsGroup || !tagsList) return;
                    const tags = selectedServer?.tags || [];
                    tagsGroup.hidden = tags.length === 0;
                    buildTagPicker(tagsList, tags, selectedIds);
                }

                function updateServerDependentOptions() {
                    const selectedServer = data.servers.find(s => s.id == serverSelect.value);
                    qualitySelect.innerHTML = '<option value="">Select Quality...</option>';
                    folderSelect.innerHTML = '<option value="">Select Folder...</option>';
                    if (!selectedServer) return;

                    selectedServer.qualityProfiles.forEach(profile => {
                        const option = document.createElement('option');
                        option.value = profile.id;
                        option.textContent = profile.name || `Profile ${profile.id}`;
                        if (usePreset && preset.profileId != null ? profile.id === preset.profileId : profile.id === selectedServer.activeProfileId) option.selected = true;
                        qualitySelect.appendChild(option);
                    });
                    selectedServer.rootFolders.forEach(folder => {
                        const option = document.createElement('option');
                        option.value = folder.path;
                        option.textContent = formatFolderLabel(folder);
                        if (usePreset && preset.rootFolder ? folder.path === preset.rootFolder : folder.path === selectedServer.activeDirectory) option.selected = true;
                        folderSelect.appendChild(option);
                    });
                    renderTags(selectedServer, usePreset && preset.tags ? preset.tags : (selectedServer.activeTags || []));
                    usePreset = false;
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

    /**
     * Reads the advanced options form back into the settings a request takes.
     * @param {HTMLElement} modalElement - The root element of the modal.
     * @param {string} idPrefix - The prefix used when the form was created.
     * @returns {{serverId: number, profileId: number, rootFolder: string, tags: number[], userId?: number}|null}
     *   Null while the server, quality profile or root folder is still unchosen.
     */
    modal.readAdvancedOptions = function(modalElement, idPrefix) {
        const server = modalElement.querySelector(`#${idPrefix}-server`)?.value;
        const quality = modalElement.querySelector(`#${idPrefix}-quality`)?.value;
        const folder = modalElement.querySelector(`#${idPrefix}-folder`)?.value;
        if (!server || !quality || !folder) return null;
        const settings = {
            serverId: parseInt(server),
            profileId: parseInt(quality),
            rootFolder: folder,
            tags: Array.from(modalElement.querySelectorAll(`#${idPrefix}-tags .jellyseerr-tag-chip.selected`)).map(c => parseInt(c.dataset.tagId))
        };
        const user = modalElement.querySelector(`#${idPrefix}-user`)?.value;
        if (user) settings.userId = parseInt(user);
        return settings;
    };

    // Callers outside the Seerr pages await this first: before the group loads it is a stand-in that loads it.
    modal.ensureLoaded = function() { return Promise.resolve(); };

    /**
     * The note a request dialog shows when Seerr approves the request on its own, like Seerr's own dialog.
     * Nothing is shown otherwise: a request waiting for approval is what people expect.
     * @param {'movie'|'tv'} mediaType
     * @param {boolean} [is4k]
     * @returns {string} HTML, empty when the request will not be approved automatically or this is not known.
     */
    modal.autoApproveNoticeHTML = function(mediaType, is4k) {
        if (!JE.jellyseerrAPI?.willAutoApprove?.(mediaType, !!is4k)) return '';
        return `<div class="jellyseerr-auto-approve"><span class="material-icons" aria-hidden="true">check_circle</span><span>${escapeHtml(JE.t('jellyseerr_auto_approve_notice'))}</span></div>`;
    };

    // Expose the modal module on the global JE object
    JE.jellyseerrModal = modal;

})(window.JellyfinEnhanced);