// @ts-check
// /js/tags/tag-look-lock.js
//
// "Lock tag look" / "Unlock tag look" on the item detail page, next to the
// other JE detail buttons (enhanced/itemdetails/features-details-page.js
// calls addLockButton on every details run). Locking stores the look the
// item's poster cards get right now (layout, density and the full slot
// profile, see core/tag-look.js); a locked Series also locks its seasons and
// episodes. Shown only while at least one poster tag type is on.
//
// Public surface: JE.tagLookLock { addLockButton, removeLockButton }.
(function (JE) {
    'use strict';

    const logPrefix = '🪼 Jellyfin Enhanced [TagLook]:';
    const TYPES = new Set(['Movie', 'Series', 'Season', 'Episode', 'BoxSet', 'Video']);
    const TAG_TOGGLES = ['qualityTagsEnabled', 'genreTagsEnabled', 'languageTagsEnabled', 'ratingTagsEnabled', 'ageRatingTagsEnabled', 'statusTagsEnabled'];

    /** @returns {boolean} Some poster tag type is on for this user. */
    function anyTagsOn() {
        const s = JE.currentSettings || {};
        return TAG_TOGGLES.some((key) => s[key] === true);
    }

    /**
     * Whether the item has its own lock.
     * @param {string} id - Normalised item id.
     * @returns {boolean}
     */
    function isLocked(id) {
        return JE.core.tagLook.normalizeLocks(JE.currentSettings?.tagLayoutLocks).has(id);
    }

    /**
     * Draw the button for a state.
     * @param {HTMLButtonElement} button
     * @param {boolean} locked
     */
    function renderButton(button, locked) {
        const label = JE.t(locked ? 'tag_look_unlock_button' : 'tag_look_lock_button');
        button.setAttribute('aria-pressed', locked ? 'true' : 'false');
        button.setAttribute('data-je-lock-state', locked ? 'on' : 'off');
        button.title = label;
        button.setAttribute('aria-label', label);
        button.replaceChildren();
        const content = document.createElement('div');
        content.className = 'detailButton-content';
        const icon = document.createElement('span');
        icon.className = 'material-icons detailButton-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = locked ? 'lock' : 'lock_open';
        content.appendChild(icon);
        button.appendChild(content);
    }

    /**
     * Keep Jellyfin's overflow menu the last action button.
     * @param {HTMLElement} button
     * @param {Element} container
     */
    function placeButton(button, container) {
        const moreButton = container.querySelector('.btnMoreCommands');
        if (moreButton) {
            if (button.nextElementSibling !== moreButton) container.insertBefore(button, moreButton);
        } else if (button.parentNode !== container) {
            container.appendChild(button);
        }
    }

    /**
     * What the item's cards are matched on: the server tag-cache entry when
     * it is in memory (it carries the library), else the item itself.
     * @param {string} id
     * @param {string} itemType
     * @returns {Promise<Object>}
     */
    async function itemFacts(id, itemType) {
        const entry = JE.tagPipeline?.peekServerEntry?.(id);
        if (entry) return { ...entry, itemId: id, cardType: itemType };
        const userId = ApiClient.getCurrentUserId();
        const item = JE.helpers?.getItemCached
            ? await JE.helpers.getItemCached(id, { userId })
            : await ApiClient.getItem(userId, id);
        return { ...(item || {}), itemId: id, cardType: itemType };
    }

    /**
     * Toggle the lock of the button's item and say so in a toast.
     * @param {HTMLButtonElement} button
     */
    async function toggle(button) {
        if (button.disabled) return;
        const id = JE.core.tagLook.normalizeId(button.getAttribute('data-je-item-id') || '');
        const itemType = button.getAttribute('data-je-item-type') || '';
        if (!id) return;
        button.disabled = true;
        const wasLocked = isLocked(id);
        let saved = false;
        try {
            if (wasLocked) {
                saved = await JE.core.tagLook.unlockItems([id]);
                if (saved) JE.toast?.(JE.t('tag_look_unlocked_toast'));
            } else {
                // The look the item's cards have now (rule or default; a
                // season/episode of a locked series inherits the series' lock).
                const conf = JE.core.tagLayout.resolveLayout(await itemFacts(id, itemType));
                saved = await JE.core.tagLook.lockItem(id, { layout: conf.layout, density: conf.density, slots: conf.slots });
                if (saved) {
                    JE.toast?.(JE.t('tag_look_locked_toast', { look: JE.t('tag_looks_outcome', {
                        layout: JE.t(`tag_looks_layout_${conf.layout}`),
                        density: JE.t(conf.density === 'compact' ? 'panel_settings_ui_tag_density_compact' : 'panel_settings_ui_tag_density_full'),
                    }) }));
                }
            }
        } catch (err) {
            console.warn(`${logPrefix} lock toggle failed:`, err);
        } finally {
            if (!saved) JE.toast?.(JE.t('tag_look_error_toast'));
            button.disabled = false;
            const locked = isLocked(id);
            button.setAttribute('data-je-lock-state', locked ? 'on' : 'off');
            renderButton(button, locked);
        }
    }

    /**
     * Remove the button from a details page (tags turned off, or an item
     * type that has no poster tags).
     * @param {Element} [page]
     */
    function removeLockButton(page) {
        (page || document).querySelectorAll('.je-tag-look-lock-btn').forEach((b) => b.remove());
    }

    /**
     * Add (or update) the lock button on the visible details page.
     * @param {string} itemId - The page's item id.
     * @param {Element} visiblePage - #itemDetailPage:not(.hide).
     * @param {string|null} itemType - The item's Type.
     */
    function addLockButton(itemId, visiblePage, itemType) {
        if (!visiblePage || !JE.core?.tagLook || !JE.core?.tagLayout) return;
        const id = JE.core.tagLook.normalizeId(String(itemId || ''));
        if (!id || !itemType || !TYPES.has(itemType) || !anyTagsOn()) {
            removeLockButton(visiblePage);
            return;
        }
        const container = ['.detailButtons', '.itemActionsBottom', '.mainDetailButtons', '.detailButtonsContainer']
            .map((selector) => visiblePage.querySelector(selector)).find(Boolean);
        if (!container) return;
        const locked = isLocked(id);
        let button = /** @type {HTMLButtonElement|null} */ (visiblePage.querySelector('.je-tag-look-lock-btn'));
        if (!button) {
            button = /** @type {HTMLButtonElement} */ (document.createElement('button'));
            button.setAttribute('is', 'emby-button');
            button.className = 'button-flat detailButton emby-button je-tag-look-lock-btn';
            button.type = 'button';
            const created = button;
            created.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                toggle(created);
            });
        }
        placeButton(button, container);
        const state = locked ? 'on' : 'off';
        if (button.getAttribute('data-je-item-id') !== id || button.getAttribute('data-je-lock-state') !== state
            || button.getAttribute('data-je-item-type') !== itemType) {
            button.setAttribute('data-je-item-id', id);
            button.setAttribute('data-je-item-type', itemType);
            button.setAttribute('data-je-lock-state', state);
            renderButton(button, locked);
        }
    }

    JE.tagLookLock = { addLockButton, removeLockButton };
})(window.JellyfinEnhanced);
