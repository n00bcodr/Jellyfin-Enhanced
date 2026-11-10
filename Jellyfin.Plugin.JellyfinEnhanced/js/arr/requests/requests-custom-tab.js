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

  // client/generated-shared/stub/client/src/features/downloads/host.ts
  var shared = /* @__PURE__ */ sharedModule("features/downloads/host");
  var export0 = /* @__PURE__ */ sharedExport(shared, "downloadsHost");

  // client/src/features/downloads/validation.ts
  function record(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
  }

  // client/generated-shared/stub/client/src/features/downloads/runtime.ts
  var shared2 = /* @__PURE__ */ sharedModule("features/downloads/runtime");
  var export02 = /* @__PURE__ */ sharedExport(shared2, "runtime");

  // client/src/features/downloads/custom-tab.ts
  function install(deps) {
    const { JE, P, host, ctx, getApi } = deps;
    const life = export02(deps);
    if (life.installed.has("custom-tab")) return;
    life.installed.add("custom-tab");
    if (!JE?.pluginConfig?.DownloadsPageEnabled) {
      return;
    }
    var useCustomTabs = !!JE?.pluginConfig?.DownloadsUseCustomTabs;
    var useNativeTab = !!JE?.pluginConfig?.DownloadsUseNativeTab;
    if (!useCustomTabs && !useNativeTab) {
      return;
    }
    if (useNativeTab) {
      JE.nativeTabs.register("requests", JE.t("requests_requests") || "Requests", function(panel) {
        var marker = document.createElement("div");
        marker.className = "jellyfinenhanced requests";
        panel.appendChild(marker);
      }, "download");
    }
    var style = document.createElement("style");
    style.textContent = [
      ".jellyfinenhanced.requests {",
      "  padding: 12px 3vw;",
      "}",
      ".backgroundContainer.withBackdrop:has(~ * #indexPage .tabContent.is-active .jellyfinenhanced.requests) {",
      "  background: rgba(0, 0, 0, 0.7) !important;",
      "  opacity: 1 !important;",
      "}"
    ].join("\n");
    document.head.appendChild(style);
    var lastMountedContainer = null;
    function isOnHomePage() {
      var hash = window.location.hash;
      return hash === "" || hash === "#/home" || hash === "#/home.html" || hash.indexOf("#/home?") !== -1 || hash.indexOf("#/home.html?") !== -1;
    }
    function waitForDownloads(callback) {
      var attempts = 0;
      var check = setInterval(function() {
        if (++attempts > 300) {
          clearInterval(check);
          return;
        }
        if (ctx.own.downloadsPage) {
          clearInterval(check);
          callback();
        }
      }, 100);
      life.cleanup(() => clearInterval(check));
    }
    function findActiveContainer() {
      var all = document.querySelectorAll(".jellyfinenhanced.requests");
      for (var i = all.length - 1; i >= 0; i--) {
        var el = all[i];
        if (el && JE.helpers.isActiveTabContainer(el)) return el;
      }
      return null;
    }
    function renderDownloads(container) {
      container.classList.remove("hide");
      container.style.display = "";
      var child = document.createElement("div");
      child.id = "je-downloads-container-tab";
      container.textContent = "";
      container.appendChild(child);
      ctx.own.downloadsPage.renderForCustomTab?.(child);
      lastMountedContainer = container;
    }
    function watchForContainer() {
      var wasOnHomePage = false;
      function tryMount() {
        var onHome = isOnHomePage();
        if (!onHome) {
          if (wasOnHomePage) {
            ctx.own.downloadsPage.stopPolling?.();
            if (ctx.own.downloadsPage._state) {
              ctx.own.downloadsPage._state._customTabMode = false;
            }
            lastMountedContainer = null;
          }
          wasOnHomePage = false;
          return;
        }
        var justReturned = !wasOnHomePage;
        wasOnHomePage = true;
        var container = findActiveContainer();
        if (!container) {
          if (lastMountedContainer) {
            ctx.own.downloadsPage.stopPolling?.();
            if (ctx.own.downloadsPage._state) {
              ctx.own.downloadsPage._state._customTabMode = false;
            }
          }
          lastMountedContainer = null;
          return;
        }
        var shouldMount = justReturned || container !== lastMountedContainer || !container.hasChildNodes() || lastMountedContainer && !document.contains(lastMountedContainer);
        if (shouldMount) {
          renderDownloads(container);
        }
      }
      tryMount();
      life.listen(window, "hashchange", tryMount);
      const unsubscribe = JE.helpers.observeTabContainers("arr-requests-custom-tab", ".jellyfinenhanced.requests", tryMount);
      if (typeof unsubscribe === "function") life.cleanup(() => unsubscribe());
      else if (record(unsubscribe) && typeof unsubscribe.teardown === "function") {
        const teardown = unsubscribe.teardown;
        life.cleanup(() => teardown.call(unsubscribe));
      }
    }
    waitForDownloads(function() {
      watchForContainer();
    });
  }

  // client/src/features/downloads/custom-tab-entry.ts
  install(export0());
})();
})();
//# sourceMappingURL=requests-custom-tab.js.map
