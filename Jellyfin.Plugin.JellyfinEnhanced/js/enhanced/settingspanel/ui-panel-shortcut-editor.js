(() => {
"use strict";
(() => {
  // client/src/host/context.ts
  function featureContext(feature, core, slots) {
    const shared = core.core?.featureContext;
    if (typeof shared !== "function") {
      throw new Error(`${feature}: JE.core.featureContext is missing; core/ui-kit.js must load before feature scripts`);
    }
    return shared(feature, core, slots);
  }

  // client/src/features/shared/panel-host.ts
  function panelHost() {
    const host = window;
    if (!host.JellyfinEnhanced) throw new TypeError("Jellyfin Enhanced must load before the settings panel");
    return host.JellyfinEnhanced;
  }

  // client/src/features/settings-panel/host.ts
  function settingsPanelContext(JE) {
    return featureContext("settings-panel", JE, {
      internalSlots: ["enhancedUi"],
      internalsObject: () => JE.internals = JE.internals || {}
    });
  }
  function registry(JE) {
    JE.internals = JE.internals || {};
    return JE.internals.enhancedUi = JE.internals.enhancedUi || {};
  }

  // client/src/features/shared/dom.ts
  function queryElement(root, selector) {
    const found = root.querySelector(selector);
    return found instanceof HTMLElement ? found : null;
  }
  function queryElements(root, selector) {
    return Array.from(root.querySelectorAll(selector)).filter((node) => node instanceof HTMLElement);
  }

  // client/src/features/settings-panel/shortcut-rules.ts
  var PLAYER_ACTIONS = /* @__PURE__ */ new Set([
    "BookmarkCurrentTime",
    "CycleAspectRatio",
    "ShowPlaybackInfo",
    "SubtitleMenu",
    "CycleSubtitleTracks",
    "CycleAudioTracks",
    "ResetPlaybackSpeed",
    "IncreasePlaybackSpeed",
    "DecreasePlaybackSpeed",
    "OpenEpisodePreview",
    "SkipIntroOutro",
    "FrameStepBack",
    "FrameStepForward",
    "JumpToLastPosition"
  ]);
  var JELLYFIN_PLAYER_KEYS = /* @__PURE__ */ new Set([
    " ",
    "Enter",
    "Escape",
    "ArrowLeft",
    "ArrowRight",
    "ArrowUp",
    "ArrowDown",
    "PageUp",
    "PageDown",
    "Home",
    "End",
    "K",
    "J",
    "L",
    "M",
    "F",
    "Shift+N",
    "Shift+P"
  ]);
  function rejectsBinding(action, combo, active, canonical) {
    const existingAction = Object.keys(active).find((name) => canonical(active[name] ?? "") === combo);
    const isReservedPlayerKey = PLAYER_ACTIONS.has(action) && JELLYFIN_PLAYER_KEYS.has(combo);
    return isReservedPlayerKey || !!existingAction && existingAction !== action;
  }
  function overrideFor(action, key, defaults) {
    const defaultConfig = defaults.find((s) => s.Name === action);
    return { ...defaultConfig, Name: defaultConfig?.Name ?? action, Key: key };
  }

  // client/src/features/settings-panel/ui-panel-shortcut-editor.ts
  function installUiPanelShortcutEditor(JE, featureCtx = settingsPanelContext(JE)) {
    const internal = registry(JE);
    internal.wireShortcutEditor = function(ctx) {
      const { help, pluginShortcuts, primaryAccentColor, kbdBackground } = ctx;
      if (JE.pluginConfig.DisableAllShortcuts) return;
      const displayKey = (key) => key || JE.t("panel_shortcuts_disabled") || "Disabled";
      const keyElementFor = (action) => queryElement(help, `.shortcut-key[data-action="${action}"]`);
      const addIndicator = (labelWrapper) => {
        const indicator = document.createElement("span");
        indicator.className = "modified-indicator";
        indicator.title = "Modified by user";
        indicator.style.cssText = `color:${primaryAccentColor}; font-size: 20px; line-height: 1;`;
        indicator.textContent = "•";
        labelWrapper.prepend(indicator);
      };
      const applyDisabledVisuals = (action) => {
        const keyElement = keyElementFor(action);
        if (!keyElement) return;
        const isDisabled = JE.state.activeShortcuts[action] === "";
        const row = keyElement.closest('div[style*="justify-content: space-between"]');
        if (row instanceof HTMLElement) row.style.opacity = isDisabled ? "0.5" : "";
      };
      const setShortcutDisabled = (action, disabled) => {
        const userShortcuts = JE.userConfig.shortcuts.Shortcuts;
        const shortcutIndex = userShortcuts.findIndex((s) => s.Name === action);
        const existing = userShortcuts[shortcutIndex];
        if (disabled) {
          if (existing) {
            existing.Key = "";
          } else {
            userShortcuts.push(overrideFor(action, "", pluginShortcuts));
          }
          JE.state.activeShortcuts[action] = "";
        } else {
          const defaultConfig = pluginShortcuts.find((s) => s.Name === action);
          const defaultKey = defaultConfig ? defaultConfig.Key : "";
          if (shortcutIndex > -1) {
            userShortcuts.splice(shortcutIndex, 1);
          }
          JE.state.activeShortcuts[action] = defaultKey;
        }
        JE.saveUserSettings("shortcuts.json", JE.userConfig.shortcuts);
        const keyElement = keyElementFor(action);
        if (keyElement && document.activeElement !== keyElement) {
          keyElement.textContent = displayKey(JE.state.activeShortcuts[action]);
        }
        const labelWrapper = keyElement?.parentElement?.nextElementSibling ?? null;
        const indicator = labelWrapper ? labelWrapper.querySelector(".modified-indicator") : null;
        if (disabled) {
          if (labelWrapper && !indicator) addIndicator(labelWrapper);
        } else if (indicator) {
          indicator.remove();
        }
        applyDisabledVisuals(action);
      };
      queryElements(help, ".shortcut-key:not([data-readonly])").forEach((keyElement) => {
        const getOriginalKey = () => JE.state.activeShortcuts[keyElement.dataset.action ?? ""];
        keyElement.addEventListener("click", () => keyElement.focus());
        keyElement.addEventListener("focus", () => {
          keyElement.textContent = JE.t("panel_shortcuts_listening");
          if (primaryAccentColor !== void 0) keyElement.style.borderColor = primaryAccentColor;
          keyElement.style.width = "100px";
        });
        keyElement.addEventListener("blur", () => {
          keyElement.textContent = displayKey(getOriginalKey());
          keyElement.style.borderColor = "transparent";
          keyElement.style.width = "auto";
        });
        keyElement.addEventListener("keydown", (e) => {
          e.preventDefault();
          e.stopPropagation();
          const action = keyElement.dataset.action ?? "";
          if (e.key === "Backspace") {
            setShortcutDisabled(action, false);
            keyElement.blur();
            return;
          }
          if (e.key === "Delete") {
            setShortcutDisabled(action, true);
            keyElement.blur();
            return;
          }
          if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) {
            return;
          }
          const labelWrapper = keyElement.parentElement?.nextElementSibling ?? null;
          const combo = JE.keyCombo(e);
          const canonical = featureCtx.peer("canonicalCombo") || ((value) => value);
          if (rejectsBinding(action, combo, JE.state.activeShortcuts, canonical)) {
            keyElement.style.background = "rgb(255 0 0 / 60%)";
            keyElement.classList.add("shake-error");
            setTimeout(() => {
              keyElement.classList.remove("shake-error");
              if (document.activeElement === keyElement && kbdBackground !== void 0) {
                keyElement.style.background = kbdBackground;
              }
            }, 500);
            return;
          }
          const userShortcut = JE.userConfig.shortcuts.Shortcuts.find((s) => s.Name === action);
          if (userShortcut) {
            userShortcut.Key = combo;
          } else {
            JE.userConfig.shortcuts.Shortcuts.push(overrideFor(action, combo, pluginShortcuts));
          }
          JE.saveUserSettings("shortcuts.json", JE.userConfig.shortcuts);
          JE.state.activeShortcuts[action] = combo;
          keyElement.textContent = combo;
          if (labelWrapper && !labelWrapper.querySelector(".modified-indicator")) addIndicator(labelWrapper);
          applyDisabledVisuals(action);
          keyElement.blur();
        });
      });
      queryElements(help, ".shortcut-toggle").forEach((toggleButton) => {
        toggleButton.addEventListener("click", (e) => {
          e.stopPropagation();
          const action = toggleButton.dataset.action ?? "";
          const isDisabled = JE.state.activeShortcuts[action] === "";
          setShortcutDisabled(action, !isDisabled);
        });
      });
    };
  }
  installUiPanelShortcutEditor(panelHost());
})();
})();
//# sourceMappingURL=ui-panel-shortcut-editor.js.map
