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

  // client/generated-shared/stub/client/src/features/spoiler-guard/ownership.ts
  var shared2 = /* @__PURE__ */ sharedModule("features/spoiler-guard/ownership");
  var export02 = /* @__PURE__ */ sharedExport(shared2, "own");

  // client/src/features/spoiler-guard/watched-refresh.ts
  var { JE, internal } = export0();
  var owner = export02(JE, "watched");
  var playedRoute = /\/(?:Users\/[a-f0-9-]+\/PlayedItems|UserPlayedItems)\/[a-f0-9-]+/i;
  var installed = false;
  function refresh(method, url) {
    if (!playedRoute.test(url) || method !== "POST" && method !== "DELETE") return;
    if (internal.isStateLoaded() && internal.isLoadOk() && !internal.hasAnyState()) return;
    owner.later(() => internal.refreshSpoilerableImages(), 200);
  }
  internal.installWatchedRefresh = () => {
    if (installed) return;
    installed = true;
    const originalFetch = window.fetch;
    const wrappedFetch = function(input, init) {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = String(init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
      const token = owner.lease();
      const promise = originalFetch.call(this, input, init);
      if (playedRoute.test(url)) void promise.then((response) => {
        if (response.ok && token.current()) refresh(method, url);
      }).catch(() => {
      });
      return promise;
    };
    if (typeof originalFetch === "function") window.fetch = wrappedFetch;
    const requests = /* @__PURE__ */ new WeakMap();
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    const open = function(method, url, async = true, username, password) {
      requests.set(this, { method: method.toUpperCase(), url: String(url) });
      originalOpen.call(this, method, url, async, username, password);
    };
    const send = function(body) {
      const request = requests.get(this);
      const token = owner.lease();
      if (request && playedRoute.test(request.url)) {
        const xhr = this;
        const completed = () => {
          release();
          if (token.current() && xhr.status >= 200 && xhr.status < 300) refresh(request.method, request.url);
        };
        const release = owner.track(() => xhr.removeEventListener("loadend", completed));
        xhr.addEventListener("loadend", completed, { once: true });
      }
      originalSend.call(this, body);
    };
    XMLHttpRequest.prototype.open = open;
    XMLHttpRequest.prototype.send = send;
    JE.core?.lifecycle?.register("spoiler-guard-watched-installation").onTeardown(() => {
      owner.reset();
      if (window.fetch === wrappedFetch) window.fetch = originalFetch;
      if (XMLHttpRequest.prototype.open === open) XMLHttpRequest.prototype.open = originalOpen;
      if (XMLHttpRequest.prototype.send === send) XMLHttpRequest.prototype.send = originalSend;
      installed = false;
    });
  };
})();
})();
//# sourceMappingURL=watched-refresh.js.map
