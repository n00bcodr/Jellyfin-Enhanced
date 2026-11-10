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
    const invalidate = () => {
      state.view++;
      for (const cleanup of [...state.cleanups]) cleanup();
    };
    window.addEventListener("hashchange", invalidate);
    window.addEventListener("popstate", invalidate);
    document.addEventListener("viewhide", invalidate);
    const invalidateIdentity = () => {
      invalidate();
      for (const cleanup of [...state.identityCleanups]) cleanup();
    };
    window.addEventListener("pagehide", invalidateIdentity);
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

  // client/src/features/hidden-content/features-remove-multiselect.ts
  (function(JE) {
    if (!installOnce(JE, "features-remove-multiselect")) return;
    "use strict";
    const internal = registry(JE, "features");
    const {
      showNotification,
      REMOVE_SURFACES,
      buildNativeActionSheetItem,
      fitRemoveItemToMenu,
      removeFromHomeSurface,
      closeOpenActionSheet,
      hideEmptyHomeSections,
      getActiveActionSheetScroller
    } = internal;
    function collectSelectedRemovableCards() {
      const out = [];
      const seen = /* @__PURE__ */ new Set();
      document.querySelectorAll(".chkItemSelect").forEach((chk) => {
        if (!chk.checked) return;
        const card = chk.closest(".card[data-id]") || chk.closest("[data-id]");
        const itemId = card && card.getAttribute("data-id");
        if (!card || !itemId || seen.has(itemId)) return;
        const surface = JE.detectCardSurface(card);
        if (surface === "continuewatching" || surface === "nextup") {
          seen.add(itemId);
          const name = (card.querySelector(".cardText-first, .cardText")?.textContent || "").trim();
          out.push({ itemId, surface, card, name });
        }
      });
      return out;
    }
    function exitSelectionMode() {
      try {
        document.querySelector(".btnCloseSelectionPanel")?.click();
      } catch (e) {
      }
    }
    let activeConfirmClose = null;
    function confirmMultiRemove(targets) {
      const token = lease(JE, true);
      return new Promise((resolve) => {
        if (activeConfirmClose) activeConfirmClose(false);
        const overlay = document.createElement("div");
        overlay.className = "je-remove-confirm-overlay";
        overlay.style.cssText = "position:fixed;inset:0;z-index:1000001;background:rgba(0,0,0,0.75);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:16px;";
        const dialog = document.createElement("div");
        dialog.style.cssText = "background:linear-gradient(135deg,rgba(30,30,35,0.98),rgba(20,20,25,0.98));border:1px solid rgba(255,255,255,0.12);border-radius:12px;padding:24px;max-width:460px;width:100%;color:#fff;max-height:80vh;display:flex;flex-direction:column;";
        const title = document.createElement("h3");
        title.textContent = JE.t("remove_confirm_title");
        title.style.cssText = "margin:0 0 16px 0;font-size:18px;font-weight:600;";
        dialog.appendChild(title);
        const list = document.createElement("div");
        list.style.cssText = "display:flex;flex-direction:column;gap:8px;margin:0 0 20px 0;overflow-y:auto;";
        targets.forEach((t) => {
          const row = document.createElement("div");
          row.style.cssText = "display:flex;justify-content:space-between;align-items:center;gap:12px;font-size:14px;padding:8px 12px;background:rgba(255,255,255,0.05);border-radius:6px;";
          const name = document.createElement("span");
          name.textContent = t.name || "";
          name.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
          const from = document.createElement("span");
          from.textContent = JE.t(REMOVE_SURFACES[t.surface].nameKey);
          from.style.cssText = "flex:0 0 auto;font-size:12px;color:rgba(255,255,255,0.65);background:rgba(255,255,255,0.08);padding:3px 9px;border-radius:10px;white-space:nowrap;";
          row.appendChild(name);
          row.appendChild(from);
          list.appendChild(row);
        });
        dialog.appendChild(list);
        const buttons = document.createElement("div");
        buttons.style.cssText = "display:flex;justify-content:flex-end;gap:10px;";
        const cancel = document.createElement("button");
        cancel.setAttribute("is", "emby-button");
        cancel.type = "button";
        cancel.textContent = JE.t("remove_confirm_cancel");
        cancel.style.cssText = "background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.15);color:#fff;padding:8px 20px;border-radius:6px;cursor:pointer;font-size:14px;font-weight:500;";
        const ok = document.createElement("button");
        ok.setAttribute("is", "emby-button");
        ok.type = "button";
        ok.textContent = JE.t("remove_button_text");
        ok.style.cssText = "background:rgba(220,50,50,0.65);border:1px solid rgba(220,50,50,0.7);color:#fff;padding:8px 20px;border-radius:6px;cursor:pointer;font-size:14px;font-weight:600;";
        buttons.appendChild(cancel);
        buttons.appendChild(ok);
        dialog.appendChild(buttons);
        const close = (result) => {
          if (activeConfirmClose === close) activeConfirmClose = null;
          overlay.remove();
          document.removeEventListener("keydown", escHandler);
          release();
          resolve(result && token.current());
        };
        const release = onDispose(JE, () => close(false));
        activeConfirmClose = close;
        const escHandler = (e) => {
          if (e.key === "Escape") close(false);
        };
        cancel.addEventListener("click", () => close(false));
        ok.addEventListener("click", () => close(true));
        overlay.addEventListener("click", (e) => {
          if (e.target === overlay) close(false);
        });
        document.addEventListener("keydown", escHandler);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
        ok.focus();
      });
    }
    async function performMultiRemove(targets) {
      const token = lease(JE, true);
      let removed = 0;
      for (const t of targets) {
        if (!token.current()) break;
        if (await removeFromHomeSurface(t.itemId, t.surface, t.card)) removed++;
      }
      if (removed > 0 && token.current()) {
        exitSelectionMode();
        showNotification(JE.t("remove_items_success"), "success");
        hideEmptyHomeSections();
      }
      return removed;
    }
    function multiSelectRemoveLabel(targets) {
      const surfaces = new Set(targets.map((t) => t.surface));
      if (surfaces.size === 1 && targets[0]) {
        return JE.t(REMOVE_SURFACES[targets[0].surface].labelKey);
      }
      return JE.t("remove_button_text");
    }
    function createMultiSelectRemoveButton(scroller, targets) {
      const button = buildNativeActionSheetItem(scroller, {
        dataId: "je-multiselect-remove",
        icon: "visibility_off",
        text: multiSelectRemoveLabel(targets)
      });
      button.addEventListener("click", async (e) => {
        const current = collectSelectedRemovableCards();
        if (!current.length) {
          exitSelectionMode();
          return;
        }
        if (current.length > 1) {
          e.preventDefault();
          e.stopPropagation();
          closeOpenActionSheet();
          const confirmed = await confirmMultiRemove(current);
          if (!confirmed) return;
          await performMultiRemove(current);
          return;
        }
        await performMultiRemove(current);
      });
      return button;
    }
    JE.addMultiSelectRemoveButton = () => {
      if (!JE.currentSettings.removeContinueWatchingEnabled) return;
      const scroller = getActiveActionSheetScroller();
      if (!scroller) return;
      if (!scroller.querySelector('[data-id="selectall"]')) return;
      if (scroller.querySelector('[data-id="je-multiselect-remove"]')) return;
      const targets = collectSelectedRemovableCards();
      if (!targets.length) return;
      const removeButton = createMultiSelectRemoveButton(scroller, targets);
      const anchor = scroller.querySelector('[data-id="refresh"]') || scroller.querySelector('[data-id="markunplayed"]') || scroller.querySelector('[data-id="markplayed"]');
      if (anchor) {
        anchor.after(removeButton);
      } else {
        scroller.appendChild(removeButton);
      }
      fitRemoveItemToMenu(removeButton, scroller);
    };
  })(host.JellyfinEnhanced);
})();
})();
//# sourceMappingURL=features-remove-multiselect.js.map
