(() => {
"use strict";
(() => {
  // client/src/host/context.ts
  function sharedModule(id) {
    const namespace = window.JellyfinEnhanced?.core?.sharedModules?.[id];
    if (!namespace) throw new Error(`${id} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);
    return namespace;
  }
  function sharedExport(namespace, name) {
    return namespace[name];
  }

  // client/generated-shared/stub/client/src/features/spoiler-guard/ownership.ts
  var shared = /* @__PURE__ */ sharedModule("features/spoiler-guard/ownership");
  var export0 = /* @__PURE__ */ sharedExport(shared, "own");

  // client/generated-shared/stub/client/src/features/spoiler-guard/host.ts
  var shared2 = /* @__PURE__ */ sharedModule("features/spoiler-guard/host");
  var export02 = /* @__PURE__ */ sharedExport(shared2, "spoilerHost");

  // client/src/features/spoiler-guard/detail-button.ts
  var { JE, internal, ctx } = export02();
  var owner = export0(JE, "detail-button", true);
  var logPrefix = "🪼 Jellyfin Enhanced [SpoilerGuard]:";
  function renderButton(button, enabled) {
    const label = JE.t(enabled ? "spoiler_blur_button_on" : "spoiler_blur_button_off");
    button.classList.toggle("je-spoiler-blur-on", enabled);
    button.setAttribute("aria-pressed", enabled ? "true" : "false");
    button.title = label;
    button.setAttribute("aria-label", label);
    button.replaceChildren();
    const content = document.createElement("div");
    content.className = "detailButton-content";
    const icon = document.createElement("span");
    icon.className = "material-icons detailButton-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = enabled ? "blur_on" : "blur_off";
    content.appendChild(icon);
    button.appendChild(content);
  }
  function placeButton(button, container) {
    const moreButton = container.querySelector(".btnMoreCommands");
    if (moreButton) {
      if (button.nextElementSibling !== moreButton) container.insertBefore(button, moreButton);
    } else if (button.parentNode !== container) {
      container.appendChild(button);
    }
  }
  function performToggle(button, itemId, kind, page, enable) {
    const token = owner.lease();
    const current = () => token.current() && button.isConnected && button.getAttribute("data-je-item-id") === itemId && button.getAttribute("data-je-spoiler-kind") === kind;
    let displayName = "";
    if ((kind === "movie" || kind === "collection") && page) {
      try {
        const title = page.querySelector("h1.itemName-name, h1.itemName, .itemName, h2.itemName-name");
        displayName = title?.textContent?.trim() || "";
      } catch (e) {
        console.warn(`${logPrefix} ${kind} title lookup failed:`, e);
      }
    }
    let operation;
    if (kind === "movie") operation = enable ? internal.enableForMovie(itemId, displayName) : internal.disableForMovie(itemId);
    else if (kind === "collection") operation = enable ? internal.enableForCollection(itemId, displayName) : internal.disableForCollection(itemId);
    else operation = enable ? internal.enableForSeries(itemId) : internal.disableForSeries(itemId);
    operation.then(function() {
      if (!current()) return;
      renderButton(button, enable);
      button.setAttribute("data-je-spoiler-state", enable ? "on" : "off");
      let key;
      if (enable) {
        key = kind === "movie" ? "spoiler_blur_enabled_movie_toast" : kind === "collection" ? "spoiler_blur_enabled_collection_toast" : "spoiler_blur_enabled_toast";
      } else {
        key = kind === "movie" ? "spoiler_blur_disabled_movie_toast" : kind === "collection" ? "spoiler_blur_disabled_collection_toast" : "spoiler_blur_disabled_toast";
      }
      JE.toast?.(JE.t(key));
      try {
        void ctx.peer("tagPipeline")?.invalidateServerCache?.();
      } catch (e) {
        console.warn(`${logPrefix} tag cache invalidation failed:`, e);
      }
      try {
        if (enable && JE.pluginConfig?.SpoilerStripReviews !== false && internal.getUserPrefs().HideReviews !== false) {
          const reviews = document.querySelector("#itemDetailPage:not(.hide) .tmdb-reviews-section") || document.querySelector(".tmdb-reviews-section");
          reviews?.parentNode?.removeChild(reviews);
        }
      } catch (e) {
        console.warn(`${logPrefix} reviews cleanup failed:`, e);
      }
      try {
        internal.refreshSpoilerableImages();
      } catch (e) {
        console.warn(`${logPrefix} image refresh failed:`, e);
      }
      if (JE.pluginConfig?.SpoilerBlurStrictRefresh === true) internal.scheduleFullReload();
    }).catch(function(err) {
      if (!current()) return;
      console.error(`${logPrefix} toggle failed:`, err);
      JE.toast?.(JE.t("spoiler_blur_error_toast"));
    }).finally(function() {
      if (current()) button.disabled = false;
    });
  }
  function onToggle(button, itemId, kind, page) {
    if (button.disabled || !internal.isLoadOk()) return;
    const token = owner.lease();
    const enable = !internal.isEnabledForKind(kind, itemId);
    button.disabled = true;
    if (enable) {
      performToggle(button, itemId, kind, page, true);
      return;
    }
    internal.confirmDisableSpoiler().then(function(proceed) {
      if (!token.current() || button.getAttribute("data-je-item-id") !== itemId) return;
      if (proceed) performToggle(button, itemId, kind, page, false);
      else button.disabled = false;
    }).catch(function(err) {
      if (!token.current()) return;
      console.warn(`${logPrefix} disable confirmation failed:`, err);
      button.disabled = false;
    });
  }
  internal.addSpoilerBlurButton = function(itemId, visiblePage, itemType) {
    if (JE.pluginConfig?.SpoilerBlurEnabled !== true || !itemId || !visiblePage) return;
    if (!internal.isStateLoaded() || !internal.isLoadOk()) return;
    const kind = internal.kindOf(itemType);
    const container = [".detailButtons", ".itemActionsBottom", ".mainDetailButtons", ".detailButtonsContainer"].map((selector) => visiblePage.querySelector(selector)).find(Boolean);
    if (!container) return;
    const enabled = internal.isEnabledForKind(kind, itemId);
    const state = enabled ? "on" : "off";
    let button = visiblePage.querySelector(".je-spoiler-blur-btn");
    if (!button) {
      button = document.createElement("button");
      button.setAttribute("is", "emby-button");
      button.className = "button-flat detailButton emby-button je-spoiler-blur-btn";
      button.type = "button";
      placeButton(button, container);
      const targetButton = button;
      owner.track(() => targetButton.remove());
      owner.listen(button, "click", function(event) {
        event.preventDefault();
        event.stopPropagation();
        const liveId = targetButton.getAttribute("data-je-item-id") || "";
        const liveKind = targetButton.getAttribute("data-je-spoiler-kind") || "series";
        const livePage = targetButton.closest("#itemDetailPage:not(.hide)") || visiblePage;
        onToggle(targetButton, liveId, liveKind, livePage);
      });
      button.setAttribute("data-je-item-id", itemId);
      button.setAttribute("data-je-spoiler-kind", kind);
      button.setAttribute("data-je-spoiler-state", state);
      renderButton(button, enabled);
      return;
    }
    placeButton(button, container);
    const previousId = button.getAttribute("data-je-item-id");
    const previousKind = button.getAttribute("data-je-spoiler-kind");
    button.setAttribute("data-je-item-id", itemId);
    button.setAttribute("data-je-spoiler-kind", kind);
    if (button.getAttribute("data-je-spoiler-state") !== state || previousId !== itemId || previousKind !== kind) {
      button.setAttribute("data-je-spoiler-state", state);
      renderButton(button, enabled);
    }
  };
})();
})();
//# sourceMappingURL=detail-button.js.map
