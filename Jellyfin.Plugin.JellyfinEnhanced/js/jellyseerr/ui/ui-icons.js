(() => {
"use strict";
(() => {
  // client/src/host/context.ts
  function featureContext(feature, core, slots) {
    const shared2 = core.core?.featureContext;
    if (typeof shared2 !== "function") {
      throw new Error(`${feature}: JE.core.featureContext is missing; core/ui-kit.js must load before feature scripts`);
    }
    return shared2(feature, core, slots);
  }
  function sharedModule(id) {
    const namespace = window.JellyfinEnhanced?.core?.sharedModules?.[id];
    if (!namespace) throw new Error(`${id} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);
    return namespace;
  }
  function sharedExport(namespace, name) {
    return namespace[name];
  }

  // client/src/features/seerr/host-core.ts
  var coreContexts = /* @__PURE__ */ new WeakMap();
  function seerrCoreContext(JE2) {
    let ctx = coreContexts.get(JE2);
    if (!ctx) {
      ctx = featureContext("seerr", JE2, {
        internalSlots: ["jellyseerrUi"],
        internalsObject: () => JE2.internals || (JE2.internals = {})
      });
      coreContexts.set(JE2, ctx);
    }
    return ctx;
  }
  function seerrCoreHost() {
    const host = window;
    const JE2 = host.JellyfinEnhanced;
    if (!JE2) throw new Error("Jellyfin Enhanced must be initialized before the Seerr core group");
    return { JE: JE2, window: host, document, apiClient: () => host.ApiClient, liveBridge: () => host.JellyfinEnhanced };
  }

  // client/src/features/seerr/core/runtime.ts
  function groupInternals(JE2) {
    const own = seerrCoreContext(JE2).own;
    return own.jellyseerrUi || (own.jellyseerrUi = { state: { jellyseerrHoverPopover: null, jellyseerrHoverLock: false, active4KPopup: null } });
  }
  function firstInstall(JE2, name) {
    const internals2 = groupInternals(JE2);
    const installed = internals2.installed || (internals2.installed = /* @__PURE__ */ new Set());
    if (installed.has(name)) return false;
    installed.add(name);
    return true;
  }

  // client/generated-shared/stub/client/src/features/seerr/core/ui/icon-markup.ts
  var shared = /* @__PURE__ */ sharedModule("features/seerr/core/ui/icon-markup");
  var export0 = /* @__PURE__ */ sharedExport(shared, "ICONS");

  // client/src/features/seerr/core/ui/icons-entry.ts
  var { JE } = seerrCoreHost();
  var internals = groupInternals(JE);
  if (firstInstall(JE, "ui-icons")) {
    const ui = JE.jellyseerrUI || (JE.jellyseerrUI = {});
    internals.icons = export0;
    ui.icons = export0;
  }
})();
})();
//# sourceMappingURL=ui-icons.js.map
