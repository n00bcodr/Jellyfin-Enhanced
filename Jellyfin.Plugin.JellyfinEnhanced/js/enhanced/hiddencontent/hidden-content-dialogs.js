(() => {
"use strict";
(() => {
  // client/src/features/hidden-content/host.ts
  var browser = window;
  if (!browser.JellyfinEnhanced || !browser.ApiClient) throw new Error("Hidden Content host unavailable");
  var host = { JellyfinEnhanced: browser.JellyfinEnhanced, Dashboard: browser.Dashboard, Emby: browser.Emby };
  function getApi() {
    const api = browser.ApiClient;
    if (!api) throw new Error("Hidden Content API unavailable");
    return api;
  }
  function registry(JE, name) {
    const internals = JE.internals ?? (JE.internals = {});
    if (name === "features") return internals.features ?? (internals.features = {});
    if (name === "hiddenContentPage") return internals.hiddenContentPage ?? (internals.hiddenContentPage = {});
    const surface = internals.hiddenContent ?? (internals.hiddenContent = {});
    return new Proxy(surface, { get(target, key) {
      if (typeof key !== "string") return Reflect.get(target, key);
      const value = Reflect.get(target, key);
      if (value === void 0) throw new Error(`Missing hidden-content loader dependency: ${key}`);
      return value;
    } });
  }
  function runtime(JE) {
    const internals = JE.internals ?? (JE.internals = {});
    if (internals.hiddenContentRuntime) return internals.hiddenContentRuntime;
    const state = { modules: /* @__PURE__ */ new Set(), view: 0, policy: 0, queues: /* @__PURE__ */ new Map(), cleanups: /* @__PURE__ */ new Set(), identityCleanups: /* @__PURE__ */ new Set() };
    internals.hiddenContentRuntime = state;
    let counted = location.href;
    const invalidate = () => {
      counted = location.href;
      state.view++;
      for (const cleanup of [...state.cleanups]) cleanup();
    };
    const navigated = () => {
      if (location.href !== counted) invalidate();
    };
    window.addEventListener("hashchange", navigated);
    window.addEventListener("popstate", navigated);
    document.addEventListener("viewhide", invalidate);
    const invalidateIdentity = () => {
      invalidate();
      for (const cleanup of [...state.identityCleanups]) cleanup();
    };
    window.addEventListener("pagehide", (event) => {
      if ((event.target === window || event.target === document) && !event.persisted) invalidateIdentity();
    });
    JE.session?.onUserChange("hidden-content-runtime", invalidateIdentity);
    return state;
  }
  function installOnce(JE, name) {
    const modules = runtime(JE).modules;
    if (modules.has(name)) return false;
    modules.add(name);
    return true;
  }
  function onDispose(JE, cleanup) {
    const cleanups = runtime(JE).cleanups;
    cleanups.add(cleanup);
    return () => cleanups.delete(cleanup);
  }
  function onIdentityDispose(JE, cleanup) {
    const cleanups = runtime(JE).identityCleanups;
    cleanups.add(cleanup);
    return () => cleanups.delete(cleanup);
  }
  function lease(JE, view = false) {
    JE.session?.checkNow?.("hidden-content-operation");
    const state = runtime(JE), version = state.view, api = getApi();
    const epoch = JE.session?.getEpoch(), userId = api.getCurrentUserId(), root = api.getUrl("/"), token = api.accessToken?.(), route = location.hash;
    return { api, destination: JSON.stringify([root, userId]), current: () => {
      try {
        return browser.ApiClient === api && (epoch === void 0 || JE.session?.isCurrent(epoch) === true) && api.getCurrentUserId() === userId && api.getUrl("/") === root && api.accessToken?.() === token && (!view || location.hash === route && state.view === version);
      } catch {
        return false;
      }
    } };
  }

  // client/src/features/hidden-content/hidden-content-dialogs.ts
  (function(JE) {
    if (!installOnce(JE, "hidden-content-dialogs")) return;
    "use strict";
    const internal = registry(JE, "hiddenContent");
    const { getSettings, hideItem, unhideItem } = internal;
    const UNDO_TOAST_DURATION = 8e3;
    const SUPPRESS_DURATION_MS = 15 * 60 * 1e3;
    let dismissActiveUndo = null;
    function suppressStorageKey() {
      try {
        localStorage.removeItem("je_hide_confirm_suppressed_until");
      } catch (_) {
      }
      return JE.session ? JE.session.userScopedKey("je_hide_confirm_suppressed_until") : "je_hide_confirm_suppressed_until:anonymous";
    }
    function showUndoToast(itemName, itemId, undo) {
      const token = lease(JE);
      dismissActiveUndo?.();
      document.querySelectorAll(".je-undo-toast").forEach((el) => el.remove());
      const themeVars = JE.themer?.getThemeVariables() || {};
      const toastBg = themeVars.secondaryBg || "linear-gradient(135deg, rgba(0,0,0,0.9), rgba(40,40,40,0.9))";
      const toastBorder = `1px solid ${themeVars.primaryAccent || "rgba(255,255,255,0.1)"}`;
      const blurValue = themeVars.blur || "30px";
      const toast = document.createElement("div");
      toast.className = "je-undo-toast";
      Object.assign(toast.style, {
        background: toastBg,
        border: toastBorder,
        backdropFilter: `blur(${blurValue})`
      });
      const textSpan = document.createElement("span");
      textSpan.className = "je-undo-toast-text";
      textSpan.textContent = JE.t("hidden_content_item_hidden", { name: itemName });
      toast.appendChild(textSpan);
      const accentColor = themeVars.primaryAccent || "rgba(255,255,255,0.15)";
      const undoBtn = document.createElement("button");
      undoBtn.className = "je-undo-btn";
      Object.assign(undoBtn.style, {
        background: `color-mix(in srgb, ${accentColor} 25%, transparent)`,
        borderColor: accentColor
      });
      undoBtn.textContent = JE.t("hidden_content_undo");
      let expiry;
      let fade;
      let closing = false;
      let release = () => {
      };
      const dispose = () => {
        closing = true;
        clearTimeout(expiry);
        clearTimeout(fade);
        release();
        toast.remove();
        if (dismissActiveUndo === dispose) dismissActiveUndo = null;
      };
      const dismiss = () => {
        if (closing) return;
        closing = true;
        clearTimeout(expiry);
        toast.classList.remove("je-visible");
        fade = setTimeout(dispose, 300);
      };
      undoBtn.addEventListener("click", () => {
        if (closing) return;
        if (!token.current()) {
          dispose();
          return;
        }
        try {
          if (undo) undo();
          else unhideItem(itemId);
        } finally {
          dismiss();
        }
      });
      toast.appendChild(undoBtn);
      release = onIdentityDispose(JE, dispose);
      dismissActiveUndo = dispose;
      document.body.appendChild(toast);
      requestAnimationFrame(() => {
        if (!token.current()) {
          dispose();
          return;
        }
        if (!closing) toast.classList.add("je-visible");
      });
      expiry = setTimeout(dismiss, UNDO_TOAST_DURATION);
    }
    function isConfirmationSuppressed() {
      const settings = getSettings();
      if (settings.showHideConfirmation === false) return true;
      const until = localStorage.getItem(suppressStorageKey());
      if (until && new Date(until) > /* @__PURE__ */ new Date()) return true;
      return false;
    }
    function createSurfaceDialogButtons(closeDialog, onConfirm, dialogOptions) {
      const choiceButtons = document.createElement("div");
      choiceButtons.className = "je-hide-confirm-buttons";
      choiceButtons.style.flexDirection = "column";
      choiceButtons.style.gap = "8px";
      const hasEpisodeChoice = !!dialogOptions.showEpisodeChoice;
      const scopedBtn = document.createElement("button");
      scopedBtn.className = "je-hide-confirm-hide";
      scopedBtn.style.width = "100%";
      scopedBtn.textContent = dialogOptions.surface === "continuewatching" ? JE.t("hidden_content_confirm_hide_cw_only") : dialogOptions.surface === "nextup" ? JE.t("hidden_content_confirm_hide_nextup_only") : JE.t("hidden_content_confirm_hide_scoped");
      scopedBtn.addEventListener("click", () => {
        closeDialog();
        if (dialogOptions.onChooseScoped) dialogOptions.onChooseScoped();
      });
      choiceButtons.appendChild(scopedBtn);
      if (hasEpisodeChoice) {
        const episodeBtn = document.createElement("button");
        episodeBtn.className = "je-hide-confirm-hide";
        episodeBtn.style.width = "100%";
        episodeBtn.style.background = "rgba(160, 80, 60, 0.6)";
        episodeBtn.style.borderColor = "rgba(160, 80, 60, 0.7)";
        episodeBtn.textContent = JE.t("hidden_content_confirm_hide_episode");
        episodeBtn.addEventListener("click", () => {
          closeDialog();
          onConfirm();
        });
        choiceButtons.appendChild(episodeBtn);
      }
      if (hasEpisodeChoice && dialogOptions.onChooseShow) {
        const showBtn = document.createElement("button");
        showBtn.className = "je-hide-confirm-hide";
        showBtn.style.width = "100%";
        showBtn.style.background = "rgba(180, 50, 50, 0.6)";
        showBtn.style.borderColor = "rgba(180, 50, 50, 0.7)";
        showBtn.textContent = JE.t("hidden_content_confirm_hide_show");
        showBtn.addEventListener("click", () => {
          closeDialog();
          dialogOptions.onChooseShow?.();
        });
        choiceButtons.appendChild(showBtn);
      }
      if (!hasEpisodeChoice) {
        const everywhereBtn = document.createElement("button");
        everywhereBtn.className = "je-hide-confirm-hide";
        everywhereBtn.style.width = "100%";
        everywhereBtn.style.background = "rgba(180, 50, 50, 0.6)";
        everywhereBtn.style.borderColor = "rgba(180, 50, 50, 0.7)";
        everywhereBtn.textContent = JE.t("hidden_content_confirm_hide");
        everywhereBtn.addEventListener("click", () => {
          closeDialog();
          onConfirm();
        });
        choiceButtons.appendChild(everywhereBtn);
      }
      const cancelBtn = document.createElement("button");
      cancelBtn.className = "je-hide-confirm-cancel";
      cancelBtn.style.width = "100%";
      cancelBtn.textContent = JE.t("hidden_content_confirm_cancel");
      cancelBtn.addEventListener("click", closeDialog);
      choiceButtons.appendChild(cancelBtn);
      return choiceButtons;
    }
    function createEpisodeChoiceButtons(closeDialog, onConfirm, dialogOptions) {
      const choiceButtons = document.createElement("div");
      choiceButtons.className = "je-hide-confirm-buttons";
      choiceButtons.style.flexDirection = "column";
      choiceButtons.style.gap = "8px";
      const episodeBtn = document.createElement("button");
      episodeBtn.className = "je-hide-confirm-hide";
      episodeBtn.style.width = "100%";
      episodeBtn.textContent = JE.t("hidden_content_confirm_hide_episode");
      episodeBtn.addEventListener("click", () => {
        closeDialog();
        onConfirm();
      });
      choiceButtons.appendChild(episodeBtn);
      if (dialogOptions.onChooseShow) {
        const showBtn = document.createElement("button");
        showBtn.className = "je-hide-confirm-hide";
        showBtn.style.width = "100%";
        showBtn.style.background = "rgba(180, 80, 50, 0.6)";
        showBtn.style.borderColor = "rgba(180, 80, 50, 0.7)";
        showBtn.textContent = JE.t("hidden_content_confirm_hide_show");
        showBtn.addEventListener("click", () => {
          closeDialog();
          dialogOptions.onChooseShow?.();
        });
        choiceButtons.appendChild(showBtn);
      }
      const cancelBtn = document.createElement("button");
      cancelBtn.className = "je-hide-confirm-cancel";
      cancelBtn.style.width = "100%";
      cancelBtn.textContent = JE.t("hidden_content_confirm_cancel");
      cancelBtn.addEventListener("click", closeDialog);
      choiceButtons.appendChild(cancelBtn);
      return choiceButtons;
    }
    function createStandardConfirmButtons(closeDialog, onConfirm) {
      const fragment = document.createDocumentFragment();
      const options = document.createElement("div");
      options.className = "je-hide-confirm-options";
      const suppress15Label = document.createElement("label");
      const suppress15Check = document.createElement("input");
      suppress15Check.type = "checkbox";
      suppress15Label.appendChild(suppress15Check);
      suppress15Label.appendChild(document.createTextNode(JE.t("hidden_content_confirm_suppress_15m")));
      options.appendChild(suppress15Label);
      fragment.appendChild(options);
      const buttons = document.createElement("div");
      buttons.className = "je-hide-confirm-buttons";
      const cancelBtn = document.createElement("button");
      cancelBtn.className = "je-hide-confirm-cancel";
      cancelBtn.textContent = JE.t("hidden_content_confirm_cancel");
      cancelBtn.addEventListener("click", closeDialog);
      buttons.appendChild(cancelBtn);
      const hideBtn = document.createElement("button");
      hideBtn.className = "je-hide-confirm-hide";
      hideBtn.textContent = JE.t("hidden_content_confirm_hide");
      hideBtn.addEventListener("click", () => {
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
    function showHideConfirmation(itemName, onConfirm, dialogOptions = {}) {
      const token = lease(JE, true);
      const originalConfirm = onConfirm;
      onConfirm = () => {
        if (token.current()) originalConfirm();
      };
      const originalOptions = dialogOptions;
      dialogOptions = { ...originalOptions, onChooseScoped: () => {
        if (token.current()) originalOptions.onChooseScoped?.();
      }, onChooseShow: () => {
        if (token.current()) originalOptions.onChooseShow?.();
      } };
      document.querySelector(".je-hide-confirm-overlay")?.remove();
      const overlay = document.createElement("div");
      overlay.className = "je-hide-confirm-overlay";
      const dialog = document.createElement("div");
      dialog.className = "je-hide-confirm-dialog";
      const title = document.createElement("h3");
      const body = document.createElement("p");
      const hasSurface = dialogOptions.surface === "nextup" || dialogOptions.surface === "continuewatching" || dialogOptions.surface === "homesections";
      const hasEpisodeChoice = !!dialogOptions.showEpisodeChoice;
      if (hasSurface) {
        title.textContent = JE.t("hidden_content_confirm_surface_title");
        body.textContent = JE.t("hidden_content_confirm_surface_body");
      } else if (hasEpisodeChoice) {
        title.textContent = JE.t("hidden_content_episode_choice_title");
        body.textContent = JE.t("hidden_content_episode_choice_body");
      } else {
        title.textContent = JE.t("hidden_content_confirm_title", { name: itemName });
        body.textContent = JE.t("hidden_content_confirm_body");
      }
      dialog.appendChild(title);
      dialog.appendChild(body);
      const closeDialog = () => {
        release();
        overlay.remove();
        document.removeEventListener("keydown", escHandler);
      };
      if (hasSurface) {
        dialog.appendChild(createSurfaceDialogButtons(closeDialog, onConfirm, dialogOptions));
      } else if (hasEpisodeChoice) {
        dialog.appendChild(createEpisodeChoiceButtons(closeDialog, onConfirm, dialogOptions));
      } else {
        dialog.appendChild(createStandardConfirmButtons(closeDialog, onConfirm));
      }
      overlay.appendChild(dialog);
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) closeDialog();
      });
      const escHandler = (e) => {
        if (e.key === "Escape") closeDialog();
      };
      document.addEventListener("keydown", escHandler);
      const release = onDispose(JE, closeDialog);
      document.body.appendChild(overlay);
    }
    function confirmAndHide(itemData, onHidden, dialogOptions = {}) {
      if (internal.refuseEditIfNotLoaded()) return;
      if (!dialogOptions.showEpisodeChoice && !dialogOptions.surface && isConfirmationSuppressed()) {
        hideItem(itemData);
        if (onHidden) onHidden();
        return;
      }
      showHideConfirmation(itemData.name || "Item", () => {
        hideItem(itemData);
        if (onHidden) onHidden();
      }, dialogOptions);
    }
    JE.session?.onUserChange("hidden-content-dialogs", () => {
      document.querySelectorAll(".je-undo-toast,.je-hide-confirm-overlay").forEach((el) => el.remove());
    });
    Object.assign(internal, { showUndoToast, confirmAndHide });
  })(host.JellyfinEnhanced);
})();
})();
//# sourceMappingURL=hidden-content-dialogs.js.map
