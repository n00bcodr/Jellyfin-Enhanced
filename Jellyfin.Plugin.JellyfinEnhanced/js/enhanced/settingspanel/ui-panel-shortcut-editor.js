/**
 * @file Click-to-rebind editor for the shortcut keys shown in the panel's
 * Shortcuts tab (rebind, conflict shake, Backspace-to-reset).
 * Split from ui.js (code motion; bodies verbatim).
 */
(function(JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const internal = JE.internals.enhancedUi = JE.internals.enhancedUi || {};

    /**
     * Wires the shortcut-key rebinding behaviour inside the open panel.
     * @param {object} ctx Shared panel context assembled in ui-panel.js.
     */
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

                JE.saveUserSettings('shortcuts.json', JE.userConfig.shortcuts);

                const keyElement = help.querySelector(`.shortcut-key[data-action="${action}"]`);
                if (keyElement && document.activeElement !== keyElement) {
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

                keyElement.addEventListener('click', () => keyElement.focus());

                keyElement.addEventListener('focus', () => {
                    keyElement.textContent = JE.t('panel_shortcuts_listening');
                    keyElement.style.borderColor = primaryAccentColor;
                    keyElement.style.width = '100px';
                });

                keyElement.addEventListener('blur', () => {
                    keyElement.textContent = displayKey(getOriginalKey());
                    keyElement.style.borderColor = 'transparent';
                    keyElement.style.width = 'auto';
                });

                keyElement.addEventListener('keydown', (e) => {
                    e.preventDefault();
                    e.stopPropagation();

                    const action = keyElement.dataset.action;

                    if (e.key === 'Backspace') {
                        setShortcutDisabled(action, false);
                        keyElement.blur(); // Exit the "Listening..." mode
                        return;
                    }

                    if (e.key === 'Delete') {
                        setShortcutDisabled(action, true);
                        keyElement.blur(); // Exit the "Listening..." mode
                        return;
                    }

                    if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) {
                        return; // Don't allow setting only a modifier key
                    }

                    const labelWrapper = keyElement.parentElement.nextElementSibling;
                    const combo = (e.metaKey ? 'Meta+' : '') + (e.ctrlKey ? 'Ctrl+' : '') + (e.altKey ? 'Alt+' : '') + (e.shiftKey ? 'Shift+' : '') + (e.key.match(/^[a-zA-Z]$/) ? e.key.toUpperCase() : e.key);
                    const existingAction = Object.keys(JE.state.activeShortcuts).find(name => JE.state.activeShortcuts[name] === combo);
                    if (existingAction && existingAction !== action) {
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
                    JE.saveUserSettings('shortcuts.json', JE.userConfig.shortcuts);

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
                    keyElement.blur(); // Triggers the blur event to clean up styles
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
