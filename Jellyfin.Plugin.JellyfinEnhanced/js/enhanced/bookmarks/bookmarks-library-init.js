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

  // client/generated-shared/stub/client/src/features/bookmarks/host.ts
  var shared = /* @__PURE__ */ sharedModule("features/bookmarks/host");
  var export1 = /* @__PURE__ */ sharedExport(shared, "bookmarksHost");
  var export2 = /* @__PURE__ */ sharedExport(shared, "findBridge");

  // client/generated-shared/stub/client/src/features/bookmarks/lifetime.ts
  var shared2 = /* @__PURE__ */ sharedModule("features/bookmarks/lifetime");
  var export0 = /* @__PURE__ */ sharedExport(shared2, "createLifetime");

  // client/src/features/bookmarks/library-init.ts
  var { ctx, host, getApi } = export1();
  function install(JE) {
    const lifetime = export0(ctx, "library-init");
    const setInterval = lifetime.interval;
    const internal = ctx.own.bookmarksLibrary = ctx.own.bookmarksLibrary || {};
    if (!JE?.pluginConfig?.BookmarksEnabled) return;
    const {
      isPluginPagesActive,
      injectNavigation,
      setupNavigationWatcher,
      handleNavigation,
      interceptNavigation,
      handleViewShow,
      handleNavClick,
      renderIfSectionExists,
      hookViewEvents
    } = internal;
    if (!isPluginPagesActive || !injectNavigation || !setupNavigationWatcher || !handleNavigation || !interceptNavigation || !handleViewShow || !handleNavClick || !renderIfSectionExists || !hookViewEvents) throw new Error("Bookmarks library entry order invalid");
    const logPrefix = "🪼 Jellyfin Enhanced: Bookmarks Library:";
    function getJE() {
      return export2(host);
    }
    const init = () => {
      console.log(`${logPrefix} Initializing (build id: ${Date.now()})...`);
      let attempts = 0;
      const checkReady = setInterval(() => {
        attempts += 1;
        if (attempts > 300) {
          clearInterval(checkReady);
          return;
        }
        const je = getJE();
        const ready = !!(je && je.userConfig && je.bookmarks);
        if (attempts % 10 === 0 || attempts <= 5) {
          console.log(`${logPrefix} ready check #${attempts} (JE=${!!je}, userConfig=${!!(je && je.userConfig)}, bookmarks=${!!(je && je.bookmarks)})`);
        }
        if (ready) {
          clearInterval(checkReady);
          if (!host.JE && je) {
            host.JE = je;
          }
          hookViewEvents();
          if (!isPluginPagesActive() && !JE.pluginConfig?.BookmarksUseCustomTabs && !JE.pluginConfig?.BookmarksUseNativeTab) {
            injectNavigation();
            setupNavigationWatcher();
            lifetime.listen(window, "hashchange", interceptNavigation, true);
            lifetime.listen(window, "popstate", interceptNavigation, true);
            lifetime.listen(document, "click", handleNavClick);
            lifetime.keep(JE.core.navigation.onViewPage((view, element, hash, itemPromise, rawEvent) => {
              if (rawEvent) handleViewShow(rawEvent);
            }));
            lifetime.keep(JE.core.navigation.onNavigate(handleNavigation));
            handleNavigation();
          }
          if (JE.pluginConfig?.BookmarksUseNativeTab) {
            JE.nativeTabs.register("bookmarks", "Bookmarks", (panel) => {
              const marker = document.createElement("div");
              marker.className = "sections bookmarks";
              panel.appendChild(marker);
            }, "location_on");
          }
          lifetime.keep(JE.helpers.observeTabContainers("bookmarks-library-custom-tab", ".sections.bookmarks", renderIfSectionExists));
          renderIfSectionExists();
          console.log(`${logPrefix} ✓ Ready`);
        }
      }, 100);
    };
    if (document.readyState === "loading") {
      lifetime.listen(document, "DOMContentLoaded", init);
    } else {
      init();
    }
  }
  install(ctx.core);
})();
})();
//# sourceMappingURL=bookmarks-library-init.js.map
