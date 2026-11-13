(() => {
"use strict";
(() => {
  // client/src/features/shared/panel-host.ts
  function panelHost() {
    const host = window;
    if (!host.JellyfinEnhanced) throw new TypeError("Jellyfin Enhanced must load before the settings panel");
    return host.JellyfinEnhanced;
  }

  // client/src/features/hidden-content/settings/host.ts
  function registry(JE) {
    JE.internals = JE.internals || {};
    return JE.internals.enhancedUi = JE.internals.enhancedUi || {};
  }

  // client/src/features/shared/dom.ts
  function inputById(id) {
    const element = document.getElementById(id);
    return element instanceof HTMLInputElement ? element : null;
  }

  // client/src/features/hidden-content/settings/ui-panel-hidden-content.ts
  var HIDDEN_BUTTON_TOGGLES = [
    ["hiddenShowButtonJellyseerr", "showButtonJellyseerr"],
    ["hiddenShowButtonLibrary", "showButtonLibrary"],
    ["hiddenShowButtonDetails", "showButtonDetails"],
    ["hiddenShowButtonCast", "showButtonCast"]
  ];
  var HIDDEN_SURFACE_TOGGLES = [
    ["hiddenFilterLibrary", "filterLibrary"],
    ["hiddenFilterDiscovery", "filterDiscovery"],
    ["hiddenFilterSearch", "filterSearch"],
    ["hiddenFilterCalendar", "filterCalendar"],
    ["hiddenFilterUpcoming", "filterUpcoming"],
    ["hiddenFilterRecommendations", "filterRecommendations"],
    ["hiddenFilterRequests", "filterRequests"],
    ["hiddenFilterNextUp", "filterNextUp"],
    ["hiddenFilterContinueWatching", "filterContinueWatching"]
  ];
  function installUiPanelHiddenContent(JE) {
    const internal = registry(JE);
    internal.wireHiddenContentListeners = function(ctx) {
      const { resetAutoCloseTimer } = ctx;
      const hidden = JE.hiddenContent;
      if (!hidden) return;
      const onToggle = (id, key, handler = () => {
      }) => {
        const el = inputById(id);
        if (!el) return;
        el.addEventListener("change", () => {
          try {
            hidden.updateSettings({ [key]: el.checked });
          } catch (error) {
            console.warn("🪼 Jellyfin Enhanced: Hidden Content setting not changed", error);
            el.checked = !el.checked;
            resetAutoCloseTimer();
            return;
          }
          handler(el.checked);
        });
      };
      for (const [id, key] of HIDDEN_BUTTON_TOGGLES) {
        onToggle(id, key, (checked) => {
          if (key === "showButtonLibrary" || key === "showButtonCast") {
            if (checked) {
              hidden.addLibraryHideButtons();
            } else {
              hidden.removeLibraryHideButtons();
              hidden.addLibraryHideButtons();
            }
          }
          resetAutoCloseTimer();
        });
      }
      onToggle("hiddenContentEnabledToggle", "enabled", () => {
        resetAutoCloseTimer();
      });
      onToggle("hiddenShowHideButtons", "showHideButtons", (checked) => {
        if (checked) {
          if (hidden.getSettings().showButtonLibrary) {
            hidden.addLibraryHideButtons();
          }
        } else {
          hidden.removeLibraryHideButtons();
        }
        resetAutoCloseTimer();
      });
      for (const [id, key] of HIDDEN_SURFACE_TOGGLES) {
        onToggle(id, key, () => {
          resetAutoCloseTimer();
        });
      }
      onToggle("hiddenShowConfirmation", "showHideConfirmation", () => {
        localStorage.removeItem("je_hide_confirm_suppressed_until");
        resetAutoCloseTimer();
      });
      onToggle("hiddenExperimentalCollections", "experimentalHideCollections", (checked) => {
        if (!checked) {
          hidden.removeLibraryHideButtons();
          hidden.addLibraryHideButtons();
        }
        resetAutoCloseTimer();
      });
      const manageBtn = document.getElementById("manageHiddenContentBtn");
      if (manageBtn) {
        manageBtn.addEventListener("click", () => {
          ctx.closePanel();
          const pageShown = !!(JE.pluginConfig?.HiddenContentEnabled && JE.hiddenContentPage?.showPage());
          if (!pageShown) {
            hidden.showManagementPanel();
          }
        });
      }
    };
  }
  installUiPanelHiddenContent(panelHost());
})();
})();
//# sourceMappingURL=ui-panel-hidden-content.js.map
