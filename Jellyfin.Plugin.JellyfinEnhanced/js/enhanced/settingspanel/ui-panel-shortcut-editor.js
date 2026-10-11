/**
 * @file Click-to-rebind editor for the shortcut keys shown in the panel's
 * Shortcuts tab (rebind, conflict shake, Backspace-to-reset).
 * Split from ui.js (code motion; bodies verbatim).
 */
(function(JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const internal = JE.internals.enhancedUi = JE.internals.enhancedUi || {};

    // Panel saves report a failed request with a visible toast instead of only logging it.
    const PANEL_SAVE_OPTIONS = { notifyOnError: true };

    /**
     * Wires the shortcut-key rebinding behaviour inside the open panel.
     * @param {object} ctx Shared panel context assembled in ui-panel.js.
     */
    // Actions that only fire on the video player page (see JE.keyListener).
    const PLAYER_ACTIONS = new Set([
        'BookmarkCurrentTime', 'CycleAspectRatio', 'ShowPlaybackInfo', 'SubtitleMenu',
        'CycleSubtitleTracks', 'CycleAudioTracks', 'ResetPlaybackSpeed', 'IncreasePlaybackSpeed',
        'DecreasePlaybackSpeed', 'OpenEpisodePreview', 'SkipIntroOutro', 'FrameStepBack',
        'FrameStepForward', 'JumpToLastPosition'
    ]);

    // Keys Jellyfin's built-in player handles natively (combo format matches JE.keyListener).
    const JELLYFIN_PLAYER_KEYS = new Set([
        ' ', 'Enter', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
        'PageUp', 'PageDown', 'Home', 'End', 'K', 'J', 'L', 'M', 'F', 'Shift+N', 'Shift+P'
    ]);

    internal.wireShortcutEditor = function(ctx) {
        const { help, pluginShortcuts, primaryAccentColor, kbdBackground } = ctx;

        // --- Shortcut Key Binding Logic ---
        if (!JE.pluginConfig.DisableAllShortcuts) {
            const displayKey = (key) => key || JE.t('panel_shortcuts_disabled') || 'Disabled';

            const applyDisabledVisuals = (action) => {
                const keyElement = help.querySelector(`.shortcut-key[data-action="${action}"]`);
                if (!keyElement) return;
                const isDisabled = JE.state.activeShortcuts[action] === '';
                const row = keyElement.closest('div[style*="justify-content: space-between"]');
                if (row) row.style.opacity = isDisabled ? '0.5' : '';
            };

            const setShortcutDisabled = (action, disabled) => {
                const shortcutIndex = JE.userConfig.shortcuts.Shortcuts.findIndex(s => s.Name === action);

                if (disabled) {
                    if (shortcutIndex > -1) {
                        JE.userConfig.shortcuts.Shortcuts[shortcutIndex].Key = '';
                    } else {
                        const defaultConfig = pluginShortcuts.find(s => s.Name === action);
                        JE.userConfig.shortcuts.Shortcuts.push({ ...defaultConfig, Key: '' });
                    }
                    JE.state.activeShortcuts[action] = '';
                } else {
                    const defaultConfig = pluginShortcuts.find(s => s.Name === action);
                    const defaultKey = defaultConfig ? defaultConfig.Key : '';
                    if (shortcutIndex > -1) {
                        JE.userConfig.shortcuts.Shortcuts.splice(shortcutIndex, 1);
                    }
                    JE.state.activeShortcuts[action] = defaultKey;
                }

                JE.saveUserSettings('shortcuts.json', JE.userConfig.shortcuts, PANEL_SAVE_OPTIONS);

                const keyElement = help.querySelector(`.shortcut-key[data-action="${action}"]`);
                if (keyElement && !keyElement.hasAttribute('data-listening')) {
                    keyElement.textContent = displayKey(JE.state.activeShortcuts[action]);
                }

                const labelWrapper = keyElement ? keyElement.parentElement.nextElementSibling : null;
                const indicator = labelWrapper ? labelWrapper.querySelector('.modified-indicator') : null;
                if (disabled) {
                    if (labelWrapper && !indicator) {
                        const newIndicator = document.createElement('span');
                        newIndicator.className = 'modified-indicator';
                        newIndicator.title = 'Modified by user';
                        newIndicator.style.cssText = `color:${primaryAccentColor}; font-size: 20px; line-height: 1;`;
                        newIndicator.textContent = '•';
                        labelWrapper.prepend(newIndicator);
                    }
                } else if (indicator) {
                    indicator.remove();
                }

                applyDisabledVisuals(action);
            };

            const shortcutKeys = help.querySelectorAll('.shortcut-key:not([data-readonly])');
            shortcutKeys.forEach(keyElement => {
                const getOriginalKey = () => JE.state.activeShortcuts[keyElement.dataset.action];

                // Capture starts on a click (or Enter/Space on the button), never on focus, so
                // keyboard users can Tab through the list; Tab leaves and Escape cancels a capture.
                /** Puts the key in capture mode ("Waiting…"); a no-op while already capturing. */
                const startListening = () => {
                    if (keyElement.hasAttribute('data-listening')) return;
                    keyElement.setAttribute('data-listening', '');
                    keyElement.textContent = JE.t('panel_shortcuts_listening');
                    keyElement.style.borderColor = primaryAccentColor;
                    keyElement.style.width = '100px';
                };
                /** Leaves capture mode and shows the current binding again. */
                const stopListening = () => {
                    if (!keyElement.hasAttribute('data-listening')) return;
                    keyElement.removeAttribute('data-listening');
                    keyElement.textContent = displayKey(getOriginalKey());
                    keyElement.style.borderColor = 'transparent';
                    keyElement.style.width = 'auto';
                };

                keyElement.addEventListener('click', () => {
                    keyElement.focus();
                    startListening();
                });

                keyElement.addEventListener('blur', stopListening);

                keyElement.addEventListener('keydown', (e) => {
                    if (!keyElement.hasAttribute('data-listening')) {
                        // Not capturing: Enter starts (a <button> also gets a click from it; the
                        // guard in startListening makes that a no-op), every other key behaves
                        // as usual (Tab moves on, Escape and ? close the panel).
                        if (e.key === 'Enter') {
                            e.preventDefault();
                            e.stopPropagation();
                            startListening();
                        }
                        return;
                    }
                    if (e.key === 'Tab') {
                        stopListening();
                        return;
                    }
                    e.preventDefault();
                    e.stopPropagation();
                    if (e.key === 'Escape') {
                        stopListening();
                        return;
                    }

                    const action = keyElement.dataset.action;

                    if (e.key === 'Backspace') {
                        setShortcutDisabled(action, false);
                        stopListening();
                        return;
                    }

                    if (e.key === 'Delete') {
                        setShortcutDisabled(action, true);
                        stopListening();
                        return;
                    }

                    if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) {
                        return; // Don't allow setting only a modifier key
                    }

                    const labelWrapper = keyElement.parentElement.nextElementSibling;
                    const combo = JE.keyCombo(e);
                    // Stored bindings may list their modifiers in any order ("Shift+Ctrl+S");
                    // compare them the way the key listener does (events.js).
                    const canonical = JE.internals.canonicalCombo || (value => value);
                    const existingAction = Object.keys(JE.state.activeShortcuts).find(name => canonical(JE.state.activeShortcuts[name]) === combo);
                    // Player actions can't take keys Jellyfin's own player already handles,
                    // otherwise both would fire on one press.
                    const isReservedPlayerKey = PLAYER_ACTIONS.has(action) && JELLYFIN_PLAYER_KEYS.has(combo);
                    if (isReservedPlayerKey || (existingAction && existingAction !== action)) {
                        keyElement.style.background = 'rgb(255 0 0 / 60%)';
                        keyElement.classList.add('shake-error');
                        setTimeout(() => {
                            keyElement.classList.remove('shake-error');
                            if (document.activeElement === keyElement) {
                                keyElement.style.background = kbdBackground;
                            }
                        }, 500);
                            // Reject the new keybinding and stop the function
                        return;
                    }

                    // Update or add the shortcut override
                    let userShortcut = JE.userConfig.shortcuts.Shortcuts.find(s => s.Name === action);
                    if (userShortcut) {
                        userShortcut.Key = combo;
                    } else {
                        const defaultConfig = pluginShortcuts.find(s => s.Name === action);
                        JE.userConfig.shortcuts.Shortcuts.push({ ...defaultConfig, Key: combo });
                    }
                    JE.saveUserSettings('shortcuts.json', JE.userConfig.shortcuts, PANEL_SAVE_OPTIONS);

                    // Update active shortcuts
                    JE.state.activeShortcuts[action] = combo;

                    // Update the UI and exit edit mode
                    keyElement.textContent = combo;
                    if (labelWrapper && !labelWrapper.querySelector('.modified-indicator')) {
                        const indicator = document.createElement('span');
                        indicator.className = 'modified-indicator';
                        indicator.title = 'Modified by user';
                        indicator.style.cssText = `color:${primaryAccentColor}; font-size: 20px; line-height: 1;`;
                        indicator.textContent = '•';
                        labelWrapper.prepend(indicator);
                    }
                    applyDisabledVisuals(action);
                    stopListening();
                });
            });

            help.querySelectorAll('.shortcut-toggle').forEach(toggleButton => {
                toggleButton.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const action = toggleButton.dataset.action;
                    const isDisabled = JE.state.activeShortcuts[action] === '';
                    setShortcutDisabled(action, !isDisabled);
                });
            });
        }
    };

})(window.JellyfinEnhanced);
