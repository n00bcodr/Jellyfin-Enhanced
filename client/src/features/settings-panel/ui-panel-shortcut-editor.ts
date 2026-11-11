/**
 * @file Click-to-rebind editor for the shortcut keys shown in the panel's
 * Shortcuts tab (rebind, conflict shake, Backspace-to-reset).
 * Strict TypeScript replacement of the module split from ui.js (same markup, ids and behaviour).
 */
import { panelHost, registry, settingsPanelContext, type PanelBridge } from './host';
import type { PanelContext } from './context';
import { queryElement, queryElements } from '../shared/dom';
import { overrideFor, rejectsBinding } from './shortcut-rules';

type Deps = Pick<PanelBridge, 'internals' | 'pluginConfig' | 'userConfig' | 'state' | 't' | 'saveUserSettings' | 'keyCombo'>;

export function installUiPanelShortcutEditor(JE: Deps, featureCtx = settingsPanelContext(JE)): void {
    const internal = registry(JE);

    /**
     * Wires the shortcut-key rebinding behaviour inside the open panel.
     * @param ctx Shared panel context assembled in ui-panel.ts.
     */
    internal.wireShortcutEditor = function(ctx: Pick<PanelContext, 'help' | 'pluginShortcuts' | 'primaryAccentColor' | 'kbdBackground'>) {
        const { help, pluginShortcuts, primaryAccentColor, kbdBackground } = ctx;

        // --- Shortcut Key Binding Logic ---
        // Overrides that failed to load are unknown: a rebind would be saved over all of them.
        const shortcuts = JE.userConfig.shortcuts;
        if (JE.pluginConfig.DisableAllShortcuts || !shortcuts) return;
        const displayKey = (key: string | undefined) => key || JE.t('panel_shortcuts_disabled') || 'Disabled';
        const keyElementFor = (action: string) => queryElement(help, `.shortcut-key[data-action="${action}"]`);
        const addIndicator = (labelWrapper: Element) => {
            const indicator = document.createElement('span');
            indicator.className = 'modified-indicator';
            indicator.title = 'Modified by user';
            indicator.style.cssText = `color:${primaryAccentColor}; font-size: 20px; line-height: 1;`;
            indicator.textContent = '•';
            labelWrapper.prepend(indicator);
        };

        const applyDisabledVisuals = (action: string) => {
            const keyElement = keyElementFor(action);
            if (!keyElement) return;
            const isDisabled = JE.state.activeShortcuts[action] === '';
            const row = keyElement.closest('div[style*="justify-content: space-between"]');
            if (row instanceof HTMLElement) row.style.opacity = isDisabled ? '0.5' : '';
        };

        const setShortcutDisabled = (action: string, disabled: boolean) => {
            const userShortcuts = shortcuts.Shortcuts;
            const shortcutIndex = userShortcuts.findIndex(s => s.Name === action);
            const existing = userShortcuts[shortcutIndex];

            if (disabled) {
                if (existing) {
                    existing.Key = '';
                } else {
                    userShortcuts.push(overrideFor(action, '', pluginShortcuts));
                }
                JE.state.activeShortcuts[action] = '';
            } else {
                const defaultConfig = pluginShortcuts.find(s => s.Name === action);
                const defaultKey = defaultConfig ? defaultConfig.Key : '';
                if (shortcutIndex > -1) {
                    userShortcuts.splice(shortcutIndex, 1);
                }
                JE.state.activeShortcuts[action] = defaultKey;
            }

            JE.saveUserSettings('shortcuts.json', shortcuts);

            const keyElement = keyElementFor(action);
            if (keyElement && document.activeElement !== keyElement) {
                keyElement.textContent = displayKey(JE.state.activeShortcuts[action]);
            }

            const labelWrapper = keyElement?.parentElement?.nextElementSibling ?? null;
            const indicator = labelWrapper ? labelWrapper.querySelector('.modified-indicator') : null;
            if (disabled) {
                if (labelWrapper && !indicator) addIndicator(labelWrapper);
            } else if (indicator) {
                indicator.remove();
            }

            applyDisabledVisuals(action);
        };

        queryElements(help, '.shortcut-key:not([data-readonly])').forEach(keyElement => {
            const getOriginalKey = () => JE.state.activeShortcuts[keyElement.dataset.action ?? ''];

            keyElement.addEventListener('click', () => keyElement.focus());

            keyElement.addEventListener('focus', () => {
                keyElement.textContent = JE.t('panel_shortcuts_listening');
                // A missing theme colour is an invalid value the legacy assignment ignored.
                if (primaryAccentColor !== undefined) keyElement.style.borderColor = primaryAccentColor;
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

                const action = keyElement.dataset.action ?? '';

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

                const labelWrapper = keyElement.parentElement?.nextElementSibling ?? null;
                const combo = JE.keyCombo(e);
                // Stored bindings may list their modifiers in any order ("Shift+Ctrl+S");
                // compare them the way the key listener does (events.js).
                const canonical = featureCtx.peer('canonicalCombo') || ((value: string) => value);
                if (rejectsBinding(action, combo, JE.state.activeShortcuts, canonical)) {
                    keyElement.style.background = 'rgb(255 0 0 / 60%)';
                    keyElement.classList.add('shake-error');
                    setTimeout(() => {
                        keyElement.classList.remove('shake-error');
                        if (document.activeElement === keyElement && kbdBackground !== undefined) {
                            keyElement.style.background = kbdBackground;
                        }
                    }, 500);
                    // Reject the new keybinding and stop the function
                    return;
                }

                // Update or add the shortcut override
                const userShortcut = shortcuts.Shortcuts.find(s => s.Name === action);
                if (userShortcut) {
                    userShortcut.Key = combo;
                } else {
                    shortcuts.Shortcuts.push(overrideFor(action, combo, pluginShortcuts));
                }
                JE.saveUserSettings('shortcuts.json', shortcuts);

                // Update active shortcuts
                JE.state.activeShortcuts[action] = combo;

                // Update the UI and exit edit mode
                keyElement.textContent = combo;
                if (labelWrapper && !labelWrapper.querySelector('.modified-indicator')) addIndicator(labelWrapper);
                applyDisabledVisuals(action);
                keyElement.blur(); // Triggers the blur event to clean up styles
            });
        });

        queryElements(help, '.shortcut-toggle').forEach(toggleButton => {
            toggleButton.addEventListener('click', (e) => {
                e.stopPropagation();
                const action = toggleButton.dataset.action ?? '';
                const isDisabled = JE.state.activeShortcuts[action] === '';
                setShortcutDisabled(action, !isDisabled);
            });
        });
    };
}

installUiPanelShortcutEditor(panelHost());
