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

  // client/src/features/spoiler-guard/index.ts
  var { JE, internal, ctx } = export0();
  var logPrefix = "🪼 Jellyfin Enhanced [SpoilerGuard]:";
  var installed = false;
  function init() {
    if (JE.pluginConfig?.SpoilerBlurEnabled !== true) return;
    internal.setIdentityCookie();
    if (!installed) {
      installed = true;
      internal.injectStyles();
    }
    try {
      internal.installWatchedRefresh();
    } catch (e) {
      console.warn(`${logPrefix} watched-state integration failed:`, e);
    }
    void internal.loadState();
  }
  ctx.own.spoilerBlur = {
    init,
    addSpoilerBlurButton: internal.addSpoilerBlurButton,
    isEnabledFor: internal.isEnabledFor,
    isMovieEnabledFor: internal.isMovieEnabledFor,
    isMovieInScope: internal.isMovieInScope,
    isCollectionEnabledFor: internal.isCollectionEnabledFor,
    enableForSeries: internal.enableForSeries,
    disableForSeries: internal.disableForSeries,
    enableForMovie: internal.enableForMovie,
    disableForMovie: internal.disableForMovie,
    enableForCollection: internal.enableForCollection,
    disableForCollection: internal.disableForCollection,
    isTmdbEnabled: internal.isTmdbEnabled,
    enableForTmdb: internal.enableForTmdb,
    disableForTmdb: internal.disableForTmdb,
    hasAnyState: internal.hasAnyState,
    whenLoaded: internal.whenLoaded,
    isLoadOk: internal.isLoadOk,
    isLoaded: internal.isLoaded,
    confirmDisableSpoiler: internal.confirmDisableSpoiler,
    getUserPrefs: internal.getUserPrefs,
    setUserPrefs: internal.setUserPrefs,
    // For seerr's more-info modal and the settings panel (step C4). Read from the registry on each access, as
    // their `JE.internals.spoilerGuard?.<member>` reads did.
    get appendSeerrToggle() {
      return ctx.own.spoilerGuard?.appendSeerrToggle;
    },
    get buildSettingsHtml() {
      return ctx.own.spoilerGuard?.buildSettingsHtml;
    },
    get wireSettings() {
      return ctx.own.spoilerGuard?.wireSettings;
    }
  };
  init();
})();
})();
//# sourceMappingURL=index.js.map
