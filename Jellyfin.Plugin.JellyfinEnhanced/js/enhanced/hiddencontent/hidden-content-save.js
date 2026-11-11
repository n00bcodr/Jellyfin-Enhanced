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
  function enqueueWrite(JE, operation) {
    const token = lease(JE), queues = runtime(JE).queues;
    const previous = queues.get(token.destination) ?? Promise.resolve();
    const next = previous.catch(() => void 0).then(() => {
      if (!token.current()) throw new Error("Stale hidden-content write");
      return operation(token.api);
    });
    queues.set(token.destination, next);
    const release = () => {
      if (queues.get(token.destination) === next) queues.delete(token.destination);
    };
    void next.then(release, release);
    return next;
  }
  function pendingWrites(JE) {
    const token = lease(JE);
    return runtime(JE).queues.get(token.destination) ?? Promise.resolve();
  }

  // client/generated-shared/stub/client/src/features/hidden-content/model.ts
  var shared = /* @__PURE__ */ sharedModule("features/hidden-content/model");
  var export1 = /* @__PURE__ */ sharedExport(shared, "decodeDocument");
  var export6 = /* @__PURE__ */ sharedExport(shared, "decodeUsers");
  var export11 = /* @__PURE__ */ sharedExport(shared, "record");

  // client/src/features/hidden-content/hidden-content-save.ts
  (function(JE) {
    if (!installOnce(JE, "hidden-content-save")) return;
    "use strict";
    const internal = registry(JE, "hiddenContent");
    const { getHiddenData, assertWritable } = internal;
    function decodeAdded(value) {
      const added = export11(value).added;
      if (typeof added !== "number" || !Number.isInteger(added) || added < 0) throw new Error("Invalid hidden-content mutation response");
      return added;
    }
    let saveTimeout = null;
    const SAVE_DEBOUNCE_MS = 500;
    let saveGeneration = 0;
    function debouncedSave() {
      if (saveTimeout) clearTimeout(saveTimeout);
      const identity = lease(JE);
      const scheduledGeneration = saveGeneration;
      saveTimeout = setTimeout(async () => {
        saveTimeout = null;
        if (scheduledGeneration !== saveGeneration || !identity.current()) return;
        try {
          const sent = await directSaveHiddenContent();
          reconcileAfterSave(sent, scheduledGeneration, identity);
        } catch (e) {
          console.warn("🪼 Jellyfin Enhanced: debouncedSave failed; scheduling background retry", e);
          if (scheduledGeneration === saveGeneration && identity.current() && pendingRetryHandle == null) scheduleFlushRetry(0, scheduledGeneration);
        }
      }, SAVE_DEBOUNCE_MS);
    }
    async function fetchHiddenContentUsers() {
      const token = lease(JE), api = token.api;
      try {
        const res = await api.ajax({
          type: "GET",
          url: api.getUrl("/JellyfinEnhanced/admin/hidden-content-users"),
          dataType: "json"
        });
        return token.current() ? export6(res) : null;
      } catch (e) {
        if (e instanceof Object && "status" in e && e.status === 403) console.warn("🪼 Jellyfin Enhanced: Hidden Content admin user-list denied (not an admin).");
        return null;
      }
    }
    async function fetchUserHiddenItemsForAdmin(targetUserId) {
      const token = lease(JE), api = token.api;
      if (!targetUserId) return [];
      try {
        const res = await api.ajax({
          type: "GET",
          url: api.getUrl(`/JellyfinEnhanced/admin/hidden-content/${targetUserId}`),
          dataType: "json"
        });
        if (!token.current()) return null;
        const hc = export1(export11(res).hiddenContent);
        const items = hc.items;
        return Object.entries(items).map(([key, item]) => ({ ...item, _key: key }));
      } catch (e) {
        if (e instanceof Object && "status" in e && e.status === 403) console.warn("🪼 Jellyfin Enhanced: Hidden Content admin read denied (not an admin).");
        return null;
      }
    }
    async function adminUnhideForUser(targetUserId, keys) {
      if (!targetUserId || !Array.isArray(keys) || keys.length === 0) return false;
      const api = lease(JE).api;
      try {
        await api.ajax({
          type: "POST",
          url: api.getUrl(`/JellyfinEnhanced/admin/hidden-content/${targetUserId}/unhide`),
          data: JSON.stringify(keys),
          contentType: "application/json"
        });
        return true;
      } catch (e) {
        if (e instanceof Object && "status" in e && e.status === 403) console.warn("🪼 Jellyfin Enhanced: Hidden Content admin unhide denied (not an admin).");
        return false;
      }
    }
    async function adminHideForUser(targetUserId, items) {
      if (!targetUserId || !Array.isArray(items) || items.length === 0) return false;
      const api = lease(JE).api;
      try {
        const res = await api.ajax({
          type: "POST",
          url: api.getUrl(`/JellyfinEnhanced/admin/hidden-content/${targetUserId}/hide`),
          data: JSON.stringify(items),
          contentType: "application/json"
        });
        return decodeAdded(res);
      } catch (e) {
        if (e instanceof Object && "status" in e && e.status === 403) console.warn("🪼 Jellyfin Enhanced: Hidden Content admin hide denied (not an admin / disabled).");
        return false;
      }
    }
    function directSaveHiddenContent() {
      return enqueueWrite(JE, async (api) => {
        assertWritable();
        const userId = api.getCurrentUserId();
        if (!userId) throw new Error("no current user");
        const snapshot = JSON.stringify(getHiddenData());
        await api.ajax({
          type: "POST",
          url: api.getUrl(`/JellyfinEnhanced/user-settings/${userId}/hidden-content.json`),
          data: snapshot,
          contentType: "application/json"
        });
        return snapshot;
      });
    }
    function reconcileAfterSave(snapshotSent, generation, identity) {
      if (generation !== saveGeneration || !identity.current()) return;
      if (snapshotSent === JSON.stringify(getHiddenData())) {
        cancelPendingRetry();
      } else {
        debouncedSave();
      }
    }
    const FLUSH_RETRY_DELAYS_MS = [1e3, 5e3, 15e3];
    const RETRY_INFLIGHT = -1;
    let pendingRetryHandle = null;
    function cancelPendingRetry() {
      if (pendingRetryHandle === RETRY_INFLIGHT) return;
      if (pendingRetryHandle != null) clearTimeout(pendingRetryHandle);
      pendingRetryHandle = null;
    }
    function scheduleFlushRetry(attempt, generation) {
      if (generation !== saveGeneration) return;
      if (attempt >= FLUSH_RETRY_DELAYS_MS.length) {
        console.error("🪼 Jellyfin Enhanced: hidden-content save retries exhausted; local change may be lost on reload");
        try {
          if (typeof JE?.toast === "function") {
            JE.toast(JE.t("hidden_content_save_failed_persistent"), 5e3);
          }
        } catch (_) {
        }
        pendingRetryHandle = null;
        return;
      }
      if (generation !== saveGeneration) return;
      const identity = lease(JE);
      pendingRetryHandle = setTimeout(async () => {
        if (generation !== saveGeneration || !identity.current()) {
          pendingRetryHandle = null;
          return;
        }
        pendingRetryHandle = RETRY_INFLIGHT;
        try {
          const sent = await directSaveHiddenContent();
          if (generation === saveGeneration && pendingRetryHandle === RETRY_INFLIGHT) pendingRetryHandle = null;
          reconcileAfterSave(sent, generation, identity);
        } catch (err) {
          console.warn(`🪼 Jellyfin Enhanced: hidden-content save retry ${attempt + 1} failed`, err);
          if (identity.current()) scheduleFlushRetry(attempt + 1, generation);
          else pendingRetryHandle = null;
        }
      }, FLUSH_RETRY_DELAYS_MS[attempt]);
    }
    async function flushPendingSave() {
      if (!saveTimeout) {
        await pendingWrites(JE);
        return;
      }
      clearTimeout(saveTimeout);
      saveTimeout = null;
      const identity = lease(JE), generation = saveGeneration;
      try {
        const sent = await directSaveHiddenContent();
        reconcileAfterSave(sent, generation, identity);
      } catch (e) {
        console.warn("🪼 Jellyfin Enhanced: flushPendingSave failed; scheduling background retry", e);
        if (identity.current() && pendingRetryHandle == null) scheduleFlushRetry(0, generation);
        throw e;
      }
    }
    try {
      window.addEventListener("pagehide", (event) => {
        if ((event.target === window || event.target === document) && !event.persisted) cancelPendingRetry();
      });
    } catch (_) {
    }
    host.JellyfinEnhanced.session?.onUserChange("hidden-content-save", () => {
      saveGeneration++;
      if (saveTimeout) {
        clearTimeout(saveTimeout);
        saveTimeout = null;
      }
      cancelPendingRetry();
      pendingRetryHandle = null;
    });
    Object.assign(internal, {
      debouncedSave,
      flushPendingSave,
      fetchHiddenContentUsers,
      fetchUserHiddenItemsForAdmin,
      adminUnhideForUser,
      adminHideForUser
    });
  })(host.JellyfinEnhanced);
})();
})();
//# sourceMappingURL=hidden-content-save.js.map
