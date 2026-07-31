/**
 * @file Hidden Content — undo toast and the hide-confirmation dialogs
 * (standard, surface-scoped, and episode-choice variants).
 * Split from hidden-content.js (code motion; bodies verbatim).
 */
(function (JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const internal = JE.internals.hiddenContent = JE.internals.hiddenContent || {};

    const { getSettings, hideItem, unhideItem } = internal;

    /** How long the undo toast stays visible. */
    const UNDO_TOAST_DURATION = 8000;
    /** How long the "don't ask again" suppression lasts (15 minutes). */
    const SUPPRESS_DURATION_MS = 15 * 60 * 1000;
    /** LocalStorage key for "don't ask again" suppression timestamp. */
    const SUPPRESS_STORAGE_KEY = 'je_hide_confirm_suppressed_until';

    // ============================================================
    // Undo toast
    // ============================================================

    /**
     * Shows a slide-in toast with an "Undo" button after hiding an item.
     * Automatically dismisses after {@link UNDO_TOAST_DURATION}.
     * @param {string} itemName Display name of the hidden item.
     * @param {string} itemId Storage key used to unhide if the user clicks Undo.
     */
    function showUndoToast(itemName, itemId) {
        document.querySelectorAll('.je-undo-toast').forEach(el => el.remove());

        const themeVars = JE.themer?.getThemeVariables() || {};
        const toastBg = themeVars.secondaryBg || 'linear-gradient(135deg, rgba(0,0,0,0.9), rgba(40,40,40,0.9))';
        const toastBorder = `1px solid ${themeVars.primaryAccent || 'rgba(255,255,255,0.1)'}`;
        const blurValue = themeVars.blur || '30px';

        const toast = document.createElement('div');
        toast.className = 'je-undo-toast';
        Object.assign(toast.style, {
            background: toastBg,
            border: toastBorder,
            backdropFilter: `blur(${blurValue})`
        });

        const textSpan = document.createElement('span');
        textSpan.className = 'je-undo-toast-text';
        textSpan.textContent = JE.t('hidden_content_item_hidden', { name: itemName });
        toast.appendChild(textSpan);

        const accentColor = themeVars.primaryAccent || 'rgba(255,255,255,0.15)';

        const undoBtn = document.createElement('button');
        undoBtn.className = 'je-undo-btn';
        Object.assign(undoBtn.style, {
            background: `color-mix(in srgb, ${accentColor} 25%, transparent)`,
            borderColor: accentColor
        });
        undoBtn.textContent = JE.t('hidden_content_undo');
        undoBtn.addEventListener('click', () => {
            unhideItem(itemId);
            toast.classList.remove('je-visible');
            setTimeout(() => toast.remove(), 300);
        });
        toast.appendChild(undoBtn);

        document.body.appendChild(toast);
        requestAnimationFrame(() => toast.classList.add('je-visible'));

        setTimeout(() => {
            if (toast.parentNode) {
                toast.classList.remove('je-visible');
                setTimeout(() => toast.remove(), 300);
            }
        }, UNDO_TOAST_DURATION);
    }

    // ============================================================
    // Hide confirmation dialog
    // ============================================================

    /**
     * Checks whether the hide confirmation dialog is currently suppressed
     * (either permanently via settings or temporarily via the 15-minute timer).
     * @returns {boolean} `true` if the confirmation should be skipped.
     */
    function isConfirmationSuppressed() {
        const settings = getSettings();
        if (settings.showHideConfirmation === false) return true;
        const until = localStorage.getItem(SUPPRESS_STORAGE_KEY);
        if (until && new Date(until) > new Date()) return true;
        return false;
    }

    /**
     * Creates a column-layout button container with full-width buttons for
     * surface-specific (Next Up / Continue Watching) confirmation dialogs.
     * @param {Function} closeDialog Closes the overlay.
     * @param {Function} onConfirm Default confirm callback (hide everywhere).
     * @param {Object} dialogOptions Dialog customisation options.
     * @returns {HTMLElement} The buttons container element.
     */
    function createSurfaceDialogButtons(closeDialog, onConfirm, dialogOptions) {
        const choiceButtons = document.createElement('div');
        choiceButtons.className = 'je-hide-confirm-buttons';
        choiceButtons.style.flexDirection = 'column';
        choiceButtons.style.gap = '8px';

        const hasEpisodeChoice = !!dialogOptions.showEpisodeChoice;

        // Surface-specific label: CW hide → "Remove from Continue Watching", Next Up → "Hide from Next Up only".
        const scopedBtn = document.createElement('button');
        scopedBtn.className = 'je-hide-confirm-hide';
        scopedBtn.style.width = '100%';
        scopedBtn.textContent =
            dialogOptions.surface === 'continuewatching'
                ? JE.t('hidden_content_confirm_hide_cw_only')
                : dialogOptions.surface === 'nextup'
                    ? JE.t('hidden_content_confirm_hide_nextup_only')
                    : JE.t('hidden_content_confirm_hide_scoped');
        scopedBtn.addEventListener('click', () => {
            closeDialog();
            if (dialogOptions.onChooseScoped) dialogOptions.onChooseScoped();
        });
        choiceButtons.appendChild(scopedBtn);

        // Option 2: Hide this episode everywhere (only if episode choice available)
        if (hasEpisodeChoice) {
            const episodeBtn = document.createElement('button');
            episodeBtn.className = 'je-hide-confirm-hide';
            episodeBtn.style.width = '100%';
            episodeBtn.style.background = 'rgba(160, 80, 60, 0.6)';
            episodeBtn.style.borderColor = 'rgba(160, 80, 60, 0.7)';
            episodeBtn.textContent = JE.t('hidden_content_confirm_hide_episode');
            episodeBtn.addEventListener('click', () => {
                closeDialog();
                onConfirm();
            });
            choiceButtons.appendChild(episodeBtn);
        }

        // Option 3: Hide entire show (only if episode choice available)
        if (hasEpisodeChoice && dialogOptions.onChooseShow) {
            const showBtn = document.createElement('button');
            showBtn.className = 'je-hide-confirm-hide';
            showBtn.style.width = '100%';
            showBtn.style.background = 'rgba(180, 50, 50, 0.6)';
            showBtn.style.borderColor = 'rgba(180, 50, 50, 0.7)';
            showBtn.textContent = JE.t('hidden_content_confirm_hide_show');
            showBtn.addEventListener('click', () => {
                closeDialog();
                dialogOptions.onChooseShow();
            });
            choiceButtons.appendChild(showBtn);
        }

        // If no episode choice, add a "Hide everywhere" option as alternative to scoped
        if (!hasEpisodeChoice) {
            const everywhereBtn = document.createElement('button');
            everywhereBtn.className = 'je-hide-confirm-hide';
            everywhereBtn.style.width = '100%';
            everywhereBtn.style.background = 'rgba(180, 50, 50, 0.6)';
            everywhereBtn.style.borderColor = 'rgba(180, 50, 50, 0.7)';
            everywhereBtn.textContent = JE.t('hidden_content_confirm_hide');
            everywhereBtn.addEventListener('click', () => {
                closeDialog();
                onConfirm();
            });
            choiceButtons.appendChild(everywhereBtn);
        }

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'je-hide-confirm-cancel';
        cancelBtn.style.width = '100%';
        cancelBtn.textContent = JE.t('hidden_content_confirm_cancel');
        cancelBtn.addEventListener('click', closeDialog);
        choiceButtons.appendChild(cancelBtn);

        return choiceButtons;
    }

    /**
     * Creates a column-layout button container for the episode/show choice
     * dialog (not triggered from a scoped surface).
     * @param {Function} closeDialog Closes the overlay.
     * @param {Function} onConfirm Default confirm callback (hide episode everywhere).
     * @param {Object} dialogOptions Dialog customisation options.
     * @returns {HTMLElement} The buttons container element.
     */
    function createEpisodeChoiceButtons(closeDialog, onConfirm, dialogOptions) {
        const choiceButtons = document.createElement('div');
        choiceButtons.className = 'je-hide-confirm-buttons';
        choiceButtons.style.flexDirection = 'column';
        choiceButtons.style.gap = '8px';

        const episodeBtn = document.createElement('button');
        episodeBtn.className = 'je-hide-confirm-hide';
        episodeBtn.style.width = '100%';
        episodeBtn.textContent = JE.t('hidden_content_confirm_hide_episode');
        episodeBtn.addEventListener('click', () => {
            closeDialog();
            onConfirm();
        });
        choiceButtons.appendChild(episodeBtn);

        if (dialogOptions.onChooseShow) {
            const showBtn = document.createElement('button');
            showBtn.className = 'je-hide-confirm-hide';
            showBtn.style.width = '100%';
            showBtn.style.background = 'rgba(180, 80, 50, 0.6)';
            showBtn.style.borderColor = 'rgba(180, 80, 50, 0.7)';
            showBtn.textContent = JE.t('hidden_content_confirm_hide_show');
            showBtn.addEventListener('click', () => {
                closeDialog();
                dialogOptions.onChooseShow();
            });
            choiceButtons.appendChild(showBtn);
        }

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'je-hide-confirm-cancel';
        cancelBtn.style.width = '100%';
        cancelBtn.textContent = JE.t('hidden_content_confirm_cancel');
        cancelBtn.addEventListener('click', closeDialog);
        choiceButtons.appendChild(cancelBtn);

        return choiceButtons;
    }

    /**
     * Creates the standard confirm/cancel button pair with an optional
     * "don't ask again for 15 minutes" checkbox.
     * @param {Function} closeDialog Closes the overlay.
     * @param {Function} onConfirm Called when the user confirms hiding.
     * @returns {HTMLElement} A document fragment containing the options and buttons.
     */
    function createStandardConfirmButtons(closeDialog, onConfirm) {
        const fragment = document.createDocumentFragment();

        const options = document.createElement('div');
        options.className = 'je-hide-confirm-options';

        const suppress15Label = document.createElement('label');
        const suppress15Check = document.createElement('input');
        suppress15Check.type = 'checkbox';
        suppress15Label.appendChild(suppress15Check);
        suppress15Label.appendChild(document.createTextNode(JE.t('hidden_content_confirm_suppress_15m')));
        options.appendChild(suppress15Label);
        fragment.appendChild(options);

        const buttons = document.createElement('div');
        buttons.className = 'je-hide-confirm-buttons';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'je-hide-confirm-cancel';
        cancelBtn.textContent = JE.t('hidden_content_confirm_cancel');
        cancelBtn.addEventListener('click', closeDialog);
        buttons.appendChild(cancelBtn);

        const hideBtn = document.createElement('button');
        hideBtn.className = 'je-hide-confirm-hide';
        hideBtn.textContent = JE.t('hidden_content_confirm_hide');
        hideBtn.addEventListener('click', () => {
            if (suppress15Check.checked) {
                const until = new Date(Date.now() + SUPPRESS_DURATION_MS).toISOString();
                localStorage.setItem(SUPPRESS_STORAGE_KEY, until);
            }
            closeDialog();
            onConfirm();
        });
        buttons.appendChild(hideBtn);
        fragment.appendChild(buttons);

        return fragment;
    }

    /**
     * Shows the hide confirmation dialog.  The dialog variant depends on the
     * options: surface-scoped, episode-choice, or standard.
     * @param {string} itemName Display name of the item.
     * @param {Function} onConfirm Called when user confirms hiding (episode-level or default).
     * @param {Object} [dialogOptions] Options to customize the dialog.
     * @param {string} [dialogOptions.surface] 'nextup', 'continuewatching', or 'homesections' for scoped wording.
     * @param {boolean} [dialogOptions.showEpisodeChoice] If true, shows "Hide episode" vs "Hide show" choice.
     * @param {Function} [dialogOptions.onChooseShow] Called if user picks "Hide entire show".
     * @param {Function} [dialogOptions.onChooseScoped] Called if user picks "Hide from [surface] only".
     */
    function showHideConfirmation(itemName, onConfirm, dialogOptions = {}) {
        document.querySelector('.je-hide-confirm-overlay')?.remove();

        const overlay = document.createElement('div');
        overlay.className = 'je-hide-confirm-overlay';

        const dialog = document.createElement('div');
        dialog.className = 'je-hide-confirm-dialog';

        const title = document.createElement('h3');
        const body = document.createElement('p');

        const hasSurface = dialogOptions.surface === 'nextup' || dialogOptions.surface === 'continuewatching' || dialogOptions.surface === 'homesections';
        const hasEpisodeChoice = !!dialogOptions.showEpisodeChoice;

        if (hasSurface) {
            title.textContent = JE.t('hidden_content_confirm_surface_title');
            body.textContent = JE.t('hidden_content_confirm_surface_body');
        } else if (hasEpisodeChoice) {
            title.textContent = JE.t('hidden_content_episode_choice_title');
            body.textContent = JE.t('hidden_content_episode_choice_body');
        } else {
            title.textContent = JE.t('hidden_content_confirm_title', { name: itemName });
            body.textContent = JE.t('hidden_content_confirm_body');
        }
        dialog.appendChild(title);
        dialog.appendChild(body);

        const closeDialog = () => {
            overlay.remove();
            document.removeEventListener('keydown', escHandler);
        };

        if (hasSurface) {
            dialog.appendChild(createSurfaceDialogButtons(closeDialog, onConfirm, dialogOptions));
        } else if (hasEpisodeChoice) {
            dialog.appendChild(createEpisodeChoiceButtons(closeDialog, onConfirm, dialogOptions));
        } else {
            dialog.appendChild(createStandardConfirmButtons(closeDialog, onConfirm));
        }

        overlay.appendChild(dialog);

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeDialog();
        });

        const escHandler = (e) => {
            if (e.key === 'Escape') closeDialog();
        };
        document.addEventListener('keydown', escHandler);

        document.body.appendChild(overlay);
    }

    /**
     * Shows confirmation dialog (or skips if suppressed) then hides the item.
     * Episode-choice and surface-scoped dialogs always show (never suppressed).
     * @param {Object} itemData Data for the item to hide.
     * @param {Function} onHidden Callback after hiding.
     * @param {Object} [dialogOptions] Options passed to showHideConfirmation.
     */
    function confirmAndHide(itemData, onHidden, dialogOptions = {}) {
        if (!dialogOptions.showEpisodeChoice && !dialogOptions.surface && isConfirmationSuppressed()) {
            hideItem(itemData);
            if (onHidden) onHidden();
            return;
        }
        showHideConfirmation(itemData.name || 'Item', () => {
            hideItem(itemData);
            if (onHidden) onHidden();
        }, dialogOptions);
    }

    Object.assign(internal, { showUndoToast, confirmAndHide });

})(window.JellyfinEnhanced);
