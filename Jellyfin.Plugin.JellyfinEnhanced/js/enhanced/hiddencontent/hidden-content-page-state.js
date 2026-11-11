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
  function selectionLease(JE, checkEditing = true) {
    const token = lease(JE, true), state = registry(JE, "hiddenContentPage").state;
    const version = state.adminLoadToken, uid = state.selectedAdminUserId, editing = state.adminEditMode;
    return { current: () => token.current() && state.adminLoadToken === version && state.selectedAdminUserId === uid && (!checkEditing || state.adminEditMode === editing) };
  }

  // client/src/features/hidden-content/hidden-content-page-state.ts
  (function() {
    if (!installOnce(host.JellyfinEnhanced, "hidden-content-page-state")) return;
    "use strict";
    const JE = host.JellyfinEnhanced;
    const internal = registry(JE, "hiddenContentPage");
    const sidebar = document.querySelector(".mainDrawer-scrollContainer");
    const pluginPagesExists = !!sidebar?.querySelector(
      'a[is="emby-linkbutton"][data-itemid="Jellyfin.Plugin.JellyfinEnhanced.HiddenContentPage"]'
    );
    const state = {
      pageVisible: false,
      previousPage: null,
      searchQuery: "",
      scopedOnly: false,
      locationSignature: null,
      locationTimer: null,
      _customTabContainer: null,
      // Admin cross-user view: an admin can view another user's hidden content
      // read-only via a toolbar dropdown. All of these stay inert/empty for non-admins.
      adminIsAdmin: null,
      // tri-state: null = not yet resolved, then true/false (false only when authoritative)
      adminUsers: null,
      // cached dropdown list: [{ userId, userName, count }]; null = needs (re)fetch
      adminUsersLoading: false,
      // guards against concurrent user-list fetches
      selectedAdminUserId: null,
      // null = viewing own list; otherwise the target user's N-id
      adminEditMode: false,
      // when viewing another user, allow editing (unhiding) their items
      adminUserName: "",
      // display name of the selected user (for the header badge)
      adminItems: null,
      // cached hidden items for the selected user
      adminItemsUserId: null,
      // which user adminItems belongs to (guards against showing stale items)
      adminLoadError: false,
      // true when the selected user's items failed to load (vs genuinely empty)
      adminLoadToken: 0
      // increments per fetch so stale responses are ignored
    };
    host.JellyfinEnhanced.session?.onUserChange("hidden-content-page", () => {
      state._customTabContainer?.replaceChildren();
      document.querySelectorAll("#je-hidden-content-container,#je-hidden-content-container-tab").forEach((el) => el.replaceChildren());
      state.searchQuery = "";
      state.scopedOnly = false;
      state.adminIsAdmin = null;
      state.adminUsers = null;
      state.adminUsersLoading = false;
      state.selectedAdminUserId = null;
      state.adminEditMode = false;
      state.adminUserName = "";
      state.adminItems = null;
      state.adminItemsUserId = null;
      state.adminLoadError = false;
      state.adminLoadToken++;
    });
    function scopeBadgeText(scope) {
      const s = (scope || "").toLowerCase();
      if (s === "continuewatching") return JE.t("hidden_content_scope_cw_label");
      if (s === "nextup") return JE.t("hidden_content_scope_nextup_label");
      if (s === "homesections") return JE.t("hidden_content_scope_homesections_label");
      return "";
    }
    function scopeUnhideText(scope) {
      if ((scope || "").toLowerCase() === "continuewatching") {
        return JE.t("hidden_content_add_back_to_cw");
      }
      return JE.t("hidden_content_unhide");
    }
    const POSTER_MAX_WIDTH = 300;
    function showUnhideConfirmation(message, onConfirm, itemName) {
      const token = selectionLease(JE);
      const originalConfirm = onConfirm;
      onConfirm = () => {
        if (token.current()) originalConfirm();
      };
      document.querySelector(".je-hide-confirm-overlay")?.remove();
      const overlay = document.createElement("div");
      overlay.className = "je-hide-confirm-overlay";
      const dialog = document.createElement("div");
      dialog.className = "je-hide-confirm-dialog";
      const title = document.createElement("h3");
      title.textContent = message;
      dialog.appendChild(title);
      if (itemName) {
        const body = document.createElement("p");
        body.textContent = itemName;
        dialog.appendChild(body);
      }
      const closeDialog = () => {
        release();
        overlay.remove();
        document.removeEventListener("keydown", escHandler);
      };
      const buttons = document.createElement("div");
      buttons.className = "je-hide-confirm-buttons";
      const cancelBtn = document.createElement("button");
      cancelBtn.className = "je-hide-confirm-cancel";
      cancelBtn.textContent = JE.t("hidden_content_confirm_cancel") || "Cancel";
      cancelBtn.addEventListener("click", closeDialog);
      buttons.appendChild(cancelBtn);
      const confirmBtn = document.createElement("button");
      confirmBtn.className = "je-hide-confirm-hide";
      confirmBtn.textContent = JE.t("hidden_content_unhide") || "Unhide";
      confirmBtn.addEventListener("click", () => {
        closeDialog();
        onConfirm();
      });
      buttons.appendChild(confirmBtn);
      dialog.appendChild(buttons);
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
    Object.assign(internal, {
      state,
      sidebar,
      pluginPagesExists,
      scopeBadgeText,
      scopeUnhideText,
      POSTER_MAX_WIDTH,
      showUnhideConfirmation
    });
  })();
})();
})();
//# sourceMappingURL=hidden-content-page-state.js.map
