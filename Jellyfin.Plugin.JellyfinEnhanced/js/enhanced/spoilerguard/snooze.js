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

  // client/generated-shared/stub/client/src/features/spoiler-guard/host.ts
  var shared = /* @__PURE__ */ sharedModule("features/spoiler-guard/host");
  var export0 = /* @__PURE__ */ sharedExport(shared, "spoilerHost");

  // client/src/features/spoiler-guard/snooze.ts
  var { JE, internal, ApiClient } = export0();
  var logPrefix = "🪼 Jellyfin Enhanced [SpoilerGuard]:";
  var snoozeMs = 15 * 60 * 1e3;
  var maxFutureMs = 24 * 60 * 60 * 1e3;
  var emptyUidWarned = false;
  function userId() {
    try {
      const id = typeof ApiClient?.getCurrentUserId === "function" ? ApiClient.getCurrentUserId() : null;
      if (typeof id === "string" && id.length > 0) return id;
    } catch (_) {
    }
    if (!emptyUidWarned) {
      emptyUidWarned = true;
      console.warn(`${logPrefix} user id unavailable; disable-confirm snooze is disabled for this call`);
    }
    return null;
  }
  function key(id) {
    const server = JE.session?.getServerId?.();
    const legacy = `je-spoiler-disable-snooze:${id}`;
    if (!server) return legacy;
    const scoped = `${legacy}:server:${encodeURIComponent(server)}`;
    const old = localStorage.getItem(legacy);
    if (old !== null) {
      if (localStorage.getItem(scoped) === null) localStorage.setItem(scoped, old);
      localStorage.removeItem(legacy);
    }
    return scoped;
  }
  internal.isDisableSnoozed = function() {
    const id = userId();
    if (!id) return false;
    try {
      const storageKey = key(id);
      const raw = localStorage.getItem(storageKey);
      if (!raw) return false;
      const expiry = Number(raw);
      if (Number.isFinite(expiry) && expiry > 0 && expiry <= Date.now() + maxFutureMs && Date.now() < expiry) {
        return true;
      }
      localStorage.removeItem(storageKey);
    } catch (e) {
      console.warn(`${logPrefix} snooze read failed:`, e);
    }
    return false;
  };
  internal.setDisableSnooze = function() {
    const id = userId();
    if (!id) return;
    try {
      localStorage.setItem(key(id), String(Date.now() + snoozeMs));
    } catch (e) {
      console.warn(`${logPrefix} snooze persist failed:`, e);
    }
  };
})();
})();
//# sourceMappingURL=snooze.js.map
