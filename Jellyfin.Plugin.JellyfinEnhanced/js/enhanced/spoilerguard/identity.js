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

  // client/src/features/spoiler-guard/identity.ts
  var { JE, internal, ApiClient } = export02();
  var owner = export0(JE, "identity", false);
  var logPrefix = "🪼 Jellyfin Enhanced [SpoilerGuard]:";
  var primed = false;
  function writeIdentityCookie(userId) {
    if (!userId) {
      document.cookie = "je-spoiler-uid=; path=/; SameSite=Lax; Max-Age=0";
      return;
    }
    const signedFor = /(?:^|;\s*)je-spoiler-uid=([^;.]*)\./.exec(document.cookie)?.[1];
    const plain = (id) => decodeURIComponent(id).replace(/-/g, "").toLowerCase();
    if (signedFor !== void 0 && plain(signedFor) === plain(userId)) return;
    document.cookie = `je-spoiler-uid=${encodeURIComponent(userId)}; path=/; SameSite=Lax`;
  }
  internal.setIdentityCookie = function() {
    try {
      writeIdentityCookie(typeof ApiClient?.getCurrentUserId === "function" ? ApiClient.getCurrentUserId() : null);
    } catch (e) {
      console.warn(`${logPrefix} identity cookie set failed:`, e);
    }
  };
  internal.primeIdentityCookie = function() {
    if (primed) return;
    primed = true;
    internal.setIdentityCookie();
    let tries = 0;
    try {
      const poll = function() {
        const userId = typeof ApiClient?.getCurrentUserId === "function" ? ApiClient.getCurrentUserId() : null;
        if (userId) {
          internal.setIdentityCookie();
          return;
        } else if (++tries >= 20) {
          return;
        }
        owner.later(poll, 250);
      };
      owner.later(poll, 250);
    } catch (_) {
    }
  };
  internal.primeIdentityCookie();
  JE.session?.onUserChange("spoilerguard-identity", (change) => {
    try {
      writeIdentityCookie(change.userId);
    } catch (e) {
      console.warn(`${logPrefix} identity cookie update on user switch failed:`, e);
    }
  });
})();
})();
//# sourceMappingURL=identity.js.map
