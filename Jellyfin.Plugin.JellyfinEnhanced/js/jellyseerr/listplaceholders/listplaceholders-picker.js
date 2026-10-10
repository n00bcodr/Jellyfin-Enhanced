// /js/jellyseerr/listplaceholders/listplaceholders-picker.js
// "Add to collection or playlist" from any Seerr card (a persistent button on the card)
// and from the Seerr more-info modal: choose a list the user can edit (or create a new
// playlist), the TV granularity and the playlist position, then add. Movies and shows
// only, and never on JE's own placeholder cards (B7).
(function (JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const lp = JE.internals.listPlaceholders = JE.internals.listPlaceholders || {};

    const NEW_PLAYLIST = '__new_playlist__';

    /**
     * Whether a Seerr item may get the action.
     * @param {Object} item - Seerr item / details.
     * @param {string} [mediaType] - Overrides item.mediaType (more-info modal).
     * @returns {boolean}
     */
    function canOffer(item, mediaType) {
        if (!lp.isEnabled() || !item || item.__jeLp) return false;
        const type = mediaType || item.mediaType;
        if (type !== 'movie' && type !== 'tv') return false;
        const id = Number(item.id);
        return Number.isInteger(id) && id > 0;
    }

    /**
     * Options of the list <select>: playlists, collections, then "New playlist…".
     * @param {Object} lists - EditableListsDto.
     * @returns {string}
     */
    function listOptionsHtml(lists) {
        const esc = lp.render.esc;
        const playlists = (lists?.playlists || []).map(p => {
            const label = p.isOwn || !p.ownerName ? p.name : JE.t('listPlaceholders_owned_by', { name: p.name, owner: p.ownerName });
            return `<option value="playlist:${esc(p.id)}">${esc(label)}</option>`;
        }).join('');
        const collections = (lists?.collections || []).map(c => `<option value="collection:${esc(c.id)}">${esc(c.name)}</option>`).join('');
        return (playlists ? `<optgroup label="${esc(JE.t('listPlaceholders_playlists'))}">${playlists}</optgroup>` : '')
            + (collections ? `<optgroup label="${esc(JE.t('listPlaceholders_collections'))}">${collections}</optgroup>` : '')
            + `<option value="${NEW_PLAYLIST}">${esc(JE.t('listPlaceholders_new_playlist'))}</option>`;
    }

    /**
     * Toast after adding, with a link to the list.
     * @param {Object} result - ApplyResultDto.
     * @param {string} listId
     * @param {string} listName
     */
    function reportPicked(result, listId, listName) {
        const esc = lp.render.esc;
        const link = `<a href="#/details?id=${esc(listId)}" class="je-lp-toast-link">${esc(listName)}</a>`;
        if (result?.addedAsItems?.length && result?.added?.length) {
            JE.toast(JE.t('listPlaceholders_picked_partly', { list: link }), 5000);
        } else if (result?.addedAsItems?.length) {
            JE.toast(JE.t('listPlaceholders_picked_as_item', { list: link }), 5000);
        } else if (result?.added?.length) {
            JE.toast(JE.t('listPlaceholders_picked', { list: link }), 5000);
        } else if (result?.skipped?.length) {
            JE.toast(`${esc(lp.skipReasonText(result.skipped[0].reason))} (${link})`, 5000);
        }
    }

    /**
     * Opens the picker.
     * @param {{item: Object, mediaType?: string}} options - Seerr item (id = TMDB id) and its type.
     * @returns {Promise<Object|null>} The modal instance.
     */
    async function openPicker(options) {
        const item = options?.item;
        const mediaType = options?.mediaType || item?.mediaType;
        if (!canOffer(item, mediaType) || !JE.jellyseerrModal?.create) return null;
        lp.ensureStyles?.();
        const esc = lp.render.esc;
        const media = { ...item, mediaType, id: Number(item.id) };
        const title = media.title || media.name || '';

        let lists;
        try {
            lists = await lp.api.getEditableLists();
        } catch (error) {
            JE.toast(lp.errorMessage(error), 4000);
            return null;
        }

        let granularity = null;
        let busy = false;
        // One request id for every "New playlist…" attempt of this picker: a retry after a failure (e.g. the entry
        // didn't apply, or the answer was lost) goes to the playlist the first attempt created (B10).
        const createRequestId = lp.newRequestId();
        const body = `
            <div class="je-lp-add je-lp-picker">
                <label class="je-lp-field"><span>${esc(JE.t('listPlaceholders_pick_list'))}</span>
                    <select class="je-lp-select je-lp-list-select">${listOptionsHtml(lists)}</select></label>
                <div class="je-lp-new-playlist" hidden>
                    <label class="je-lp-field"><span>${esc(JE.t('listPlaceholders_new_playlist_name'))}</span><input type="text" class="je-lp-input je-lp-new-name" maxlength="200"></label>
                    <label class="je-lp-check"><input type="checkbox" class="je-lp-new-public"> ${esc(JE.t('listPlaceholders_new_playlist_public'))}</label>
                </div>
                <div class="je-lp-picker-gran"></div>
                <label class="je-lp-field je-lp-position"><span>${esc(JE.t('listPlaceholders_position'))}</span>
                    <select class="je-lp-select je-lp-position-select">
                        <option value="end">${esc(JE.t('listPlaceholders_position_end'))}</option>
                        <option value="start">${esc(JE.t('listPlaceholders_position_start'))}</option>
                    </select></label>
            </div>`;

        const modal = JE.jellyseerrModal.create({
            title: JE.t('listPlaceholders_add_to_list'),
            subtitle: title,
            bodyHtml: body,
            backdropPath: lp.render.isSafePoster(media.backdropPath) ? media.backdropPath : undefined,
            buttonText: JE.t('listPlaceholders_add_button'),
            onClose: () => granularity?.destroy(),
            onSave: async (modalEl, button) => {
                if (busy) return;
                const choice = modalEl.querySelector('.je-lp-list-select').value;
                const dto = lp.granularity.toPlaceholder(media, granularity ? granularity.getSelection() : undefined, granularity ? granularity.getDetails() : null);
                if (!dto) { JE.toast(esc(JE.t('listPlaceholders_pick_episode')), 3000); return; }
                busy = true;
                button.disabled = true;
                try {
                    if (choice === NEW_PLAYLIST) {
                        const name = modalEl.querySelector('.je-lp-new-name').value.trim();
                        if (!name) {
                            JE.toast(esc(JE.t('listPlaceholders_new_playlist_name_required')), 3000);
                            busy = false;
                            button.disabled = false;
                            return;
                        }
                        const created = await lp.api.createList('playlist', {
                            requestId: createRequestId,
                            name,
                            isPublic: modalEl.querySelector('.je-lp-new-public').checked,
                            entries: [{ type: 'placeholder', placeholder: dto }]
                        });
                        reportPicked(created?.result, created?.listId, created?.name || name);
                    } else {
                        const [kind, listId] = choice.split(':');
                        const value = modalEl.querySelector('.je-lp-position-select').value;
                        const position = kind === 'playlist' && value === 'start' ? { atStart: true } : undefined;
                        const result = await lp.api.addPlaceholders(listId, [dto], position);
                        const list = (kind === 'playlist' ? lists.playlists : lists.collections).find(l => l.id === listId);
                        reportPicked(result, listId, list?.name || '');
                        if (result?.addedAsItems?.length) {
                            // That list's page may be open behind the modal: reload its library rows/cards.
                            const id = lp.normalizeId(listId);
                            lp.forEachController?.((ctrl) => { if (ctrl.listId === id) ctrl.afterRealItemsAdded?.(); });
                        }
                    }
                    history.back();
                } catch (error) {
                    lp.toastError(error);
                    busy = false;
                    button.disabled = false;
                }
            }
        });

        const root = modal.modalElement;
        const select = root.querySelector('.je-lp-list-select');
        /** Shows the new-playlist fields / position for the chosen list. */
        const sync = () => {
            const value = select.value;
            root.querySelector('.je-lp-new-playlist').hidden = value !== NEW_PLAYLIST;
            root.querySelector('.je-lp-position').hidden = !value.startsWith('playlist:');
        };
        select.addEventListener('change', sync);
        sync();
        if (mediaType === 'tv') {
            granularity = lp.granularity.create({ tmdbId: media.id });
            root.querySelector('.je-lp-picker-gran').appendChild(granularity.element);
        }
        modal.show();
        return modal;
    }

    /**
     * Adds the persistent "Add to collection or playlist" button to a Seerr card (B7).
     * Called by createJellyseerrCard; does nothing for collections, placeholders or when off.
     * @param {HTMLElement} card
     * @param {Object} item - The card's Seerr item.
     */
    function appendCardAction(card, item) {
        if (!canOffer(item) || !card) return;
        const mount = card.querySelector('.jellyseerr-meta') || card.querySelector('.cardBox');
        if (!mount || mount.querySelector('.je-lp-card-add')) return;
        lp.ensureStyles?.();
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'je-lp-card-add';
        button.title = JE.t('listPlaceholders_add_to_list');
        button.setAttribute('aria-label', JE.t('listPlaceholders_add_to_list'));
        button.innerHTML = '<span class="material-icons" aria-hidden="true">playlist_add</span>';
        button.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            openPicker({ item });
        });
        mount.appendChild(button);
    }

    /**
     * Adds the action to the more-info modal's secondary actions (rebuilt on every render).
     * @param {HTMLElement} mount - `[data-mount="je-secondary-actions"]`.
     * @param {Object} data - Seerr details.
     * @param {string} mediaType - 'movie' | 'tv'.
     */
    function appendModalAction(mount, data, mediaType) {
        if (!mount || !canOffer(data, mediaType)) return;
        lp.ensureStyles?.();
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'je-lp-modal-add';
        button.title = JE.t('listPlaceholders_add_to_list');
        const icon = document.createElement('span');
        icon.className = 'material-icons';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = 'playlist_add';
        const label = document.createElement('span');
        label.textContent = JE.t('listPlaceholders_add_to_list');
        button.append(icon, label);
        button.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            openPicker({ item: data, mediaType });
        });
        mount.appendChild(button);
    }

    lp.picker = { canOffer, openPicker, appendCardAction, appendModalAction, listOptionsHtml, reportPicked };

})(window.JellyfinEnhanced);
