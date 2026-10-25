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
    let dismissUndo = null;
    /** How long the "don't ask again" suppression lasts (15 minutes). */
    const SUPPRESS_DURATION_MS = 15 * 60 * 1000;
    /**
     * LocalStorage key for the "don't ask again" suppression timestamp.
     * Scoped per user (via the shared JE.session.userScopedKey format) — an
     * unscoped key let user A's "don't ask again" carry over to user B after
     * an SPA user switch. The legacy unscoped key is removed on first use;
     * its value is deliberately NOT adopted (a 15-minute convenience window
     * is not worth carrying across an ownership change).
     * @returns {string}
     */
    function suppressStorageKey() {
        try { localStorage.removeItem('je_hide_confirm_suppressed_until'); } catch (_) { /* best effort */ }
        return JE.session
            ? JE.session.userScopedKey('je_hide_confirm_suppressed_until')
            : 'je_hide_confirm_suppressed_until:anonymous';
    }

    // ============================================================
    // Undo toast
    // ============================================================

    /**
     * Shows a slide-in toast with an "Undo" button after hiding an item.
     * Automatically dismisses after {@link UNDO_TOAST_DURATION}.
     * @param {string} itemName Display name of the hidden item.
     * @param {string} itemId Storage key used to unhide if the user clicks Undo.
     * @param {Object} [owner] The owner the Hide was written for. Hidden from inside a window (More Info), the toast is
     *     that window's (D46S2-R13-9): it is shown inside it, so its Undo is live, focusable and pressable while the
     *     window is the topmost surface, covered with it by a newer one, and gone when it closes. Else the page's.
     */
    function showUndoToast(itemName, itemId, owner) {
        // Feedback keeps the Hide's lifetime; the later Undo press supplies its own write authority.
        const action = owner ? JE.createSessionAction({ owner }) : JE.createSessionAction();
        if (!action.current()) return;
        dismissUndo?.();
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
        let dismissTimer;
        let removeTimer;
        let terminal = false;
        let focusedUndo = false;
        const surface = owner ? JE.surfaceOf?.(owner) : null;
        // Remember a deliberate move even if its destination later loses focus too.
        const moved = e => { if (!toast.contains(e.target) && e.target !== document.body) focusedUndo = false; };
        document.addEventListener('focusin', moved, true);
        /** Removes this feedback and repairs only focus lost by its own control disappearing. */
        function remove() {
            const active = document.activeElement;
            const lost = toast.contains(active) || (focusedUndo && (!active || active === document.body));
            clearTimeout(dismissTimer); clearTimeout(removeTimer);
            release();
            document.removeEventListener('focusin', moved, true);
            toast.remove();
            if (dismissUndo === dismiss) dismissUndo = null;
            if (lost && surface?.isConnected && action.current() && JE.isTopmostSurface?.(surface)) {
                for (const node of surface.querySelectorAll('button, [href], input, select, textarea, [tabindex]')) {
                    if (node.disabled || node.closest('[hidden], [inert], .hide, .je-actions-external-original') || node.style.display === 'none') continue;
                    if (JE.focusIn(surface, node)) return;
                }
                JE.focusIn(surface, surface);
            }
        }
        /** Ends activation immediately; normal expiry/success retains the existing fade. */
        function dismiss(animate = false) {
            terminal = true;
            clearTimeout(dismissTimer);
            if (animate) {
                toast.classList.remove('je-visible');
                removeTimer = setTimeout(remove, 300);
            } else remove();
        }
        const release = action.onCancel(() => dismiss());
        dismissUndo = dismiss;
        undoBtn.addEventListener('click', async (e) => {
            // Undo is the press's write (D46S2-R11-4): a click no one made undoes nothing.
            const owner = JE.ownerOf(e);
            if (!owner) return;
            if (terminal || !toast.isConnected || !action.current()) { dismiss(); return; }
            focusedUndo = document.activeElement === undoBtn;
            clearTimeout(dismissTimer);
            undoBtn.disabled = true;
            try {
                if (await unhideItem(itemId, undefined, owner) === false) throw new Error('Undo failed');
                if (!action.current()) return;
                dismiss(true);
            } catch (_) {
                if (!terminal && action.current()) textSpan.textContent = JE.t('hidden_content_save_failed_persistent');
            } finally {
                undoBtn.disabled = false;
            }
        });
        toast.appendChild(undoBtn);

        if (surface) surface.appendChild(toast);
        else document.body.appendChild(toast);
        requestAnimationFrame(() => { if (!terminal && action.current()) toast.classList.add('je-visible'); });

        dismissTimer = setTimeout(() => dismiss(true), UNDO_TOAST_DURATION);
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
        const until = localStorage.getItem(suppressStorageKey());
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
                localStorage.setItem(suppressStorageKey(), until);
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
     * @param {Object|Node|Event} dialogOptions.owner The owner (required, D46S2-R6): the operation a title action pressed
     *     Hide for (the confirmation is in its scope and its accept is refused once it ends), a viewer's native owner, or the node or
     *     press it comes from.
     */
    function showHideConfirmation(itemName, onConfirm, dialogOptions = {}) {
        // Admitted first (D46S2-R12-7): an owner that is not current now (an ended press or operation) opens nothing and
        // leaves the confirmation shown so far alone.
        const admitted = JE.admitSurface(dialogOptions.owner, 'the hide confirmation');
        if (!admitted) return;
        const action = JE.createSessionAction({ owner: admitted });
        if (!action.owner) return;
        onConfirm = action.bind(onConfirm);
        dialogOptions = { ...dialogOptions };
        for (const key of ['onChooseShow', 'onChooseScoped']) {
            if (dialogOptions[key]) dialogOptions[key] = action.bind(dialogOptions[key]);
        }
        document.querySelector('.je-hide-confirm-overlay')?.jeDismiss?.();
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
            release();
            releaseScope?.();
            overlay.remove();
        };
        const release = action.onCancel(closeDialog);
        // Asked for a title action: the confirmation is in that operation's scope and closes once it ends. The stack
        // announces it as a named modal dialog, covers the page and takes its Escape (D46S2-R12-11, -3).
        const releaseScope = JE.openSurface(overlay, closeDialog, action.owner, { dialog });
        overlay.jeDismiss = closeDialog;
        // Also reject detached old buttons, including the suppression checkbox write.
        overlay.addEventListener('click', event => {
            if (!action.current()) { event.stopImmediatePropagation(); closeDialog(); }
        }, true);

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

        document.body.appendChild(overlay);
    }

    /**
     * Shows confirmation dialog (or skips if suppressed) then hides the item.
     * Episode-choice and surface-scoped dialogs always show (never suppressed).
     * @param {Object} itemData Data for the item to hide.
     * @param {Function} onHidden Callback after hiding.
     * @param {Object} dialogOptions Options passed to showHideConfirmation (owner required there).
     */
    function confirmAndHide(itemData, onHidden, dialogOptions = {}) {
        const owner = JE.requireOwner(dialogOptions.owner, 'confirmAndHide');
        if (!owner) return;
        if (!dialogOptions.showEpisodeChoice && !dialogOptions.surface && isConfirmationSuppressed()) {
            Promise.resolve(hideItem(itemData, owner)).then(saved => { if (saved !== false) onHidden?.(); });
            return;
        }
        showHideConfirmation(itemData.name || 'Item', () => {
            Promise.resolve(hideItem(itemData, owner)).then(saved => { if (saved !== false) onHidden?.(); });
        }, { ...dialogOptions, owner });
    }

    Object.assign(internal, { showUndoToast, confirmAndHide, showHideConfirmation, isConfirmationSuppressed });

})(window.JellyfinEnhanced);
