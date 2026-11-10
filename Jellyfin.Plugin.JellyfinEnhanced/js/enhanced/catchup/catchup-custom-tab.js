(() => {
"use strict";
(() => {
  // client/src/host/context.ts
  function featureContext(feature, core, slots) {
    const shared = core.core?.featureContext;
    if (typeof shared !== "function") {
      throw new Error(`${feature}: JE.core.featureContext is missing; core/ui-kit.js must load before feature scripts`);
    }
    return shared(feature, core, slots);
  }

  // client/src/features/catchup/host.ts
  function catchupHost() {
    const host = window, JE = host.JellyfinEnhanced;
    const ctx = JE && featureContext("catchup", JE, {
      facades: ["catchUpPage"],
      internalSlots: ["catchUp"],
      internalsObject: () => JE.internals ?? (JE.internals = {})
    });
    return { host, ctx, getApi: () => host.ApiClient, Emby: host.Emby };
  }

  // client/src/features/catchup/catchup-custom-tab.ts
  (function() {
    "use strict";
    const { ctx: context } = catchupHost();
    if (!context) return;
    const ctx = context, JE = ctx.core;
    if (!JE?.pluginConfig?.CatchUpEnabled) {
      return;
    }
    var useCustomTabs = !!JE?.pluginConfig?.CatchUpUseCustomTabs;
    var useNativeTab = !!JE?.pluginConfig?.CatchUpUseNativeTab;
    if (!useCustomTabs && !useNativeTab) {
      return;
    }
    if (useNativeTab) {
      JE.nativeTabs.register("catchup", JE.t("catchup_title") || "Catch Up", function(panel) {
        var marker = document.createElement("div");
        marker.className = "jellyfinenhanced catchup";
        panel.appendChild(marker);
      }, "style");
    }
    var style = document.createElement("style");
    style.textContent = [
      ".backgroundContainer.withBackdrop:has(~ * #indexPage .tabContent.is-active .jellyfinenhanced.catchup) {",
      "  background: rgba(0, 0, 0, 0.7) !important;",
      "  opacity: 1 !important;",
      "}"
    ].join("\n");
    document.head.appendChild(style);
    var lastMountedContainer = null;
    function isOnHomePage() {
      var hash = window.location.hash.replace(/^#!/, "#");
      return hash === "" || hash === "#/home" || hash === "#/home.html" || hash.indexOf("#/home?") !== -1 || hash.indexOf("#/home.html?") !== -1;
    }
    function waitForCatchUp(callback) {
      var attempts = 0;
      var check = setInterval(function() {
        if (++attempts > 300) {
          clearInterval(check);
          return;
        }
        if (ctx.own.catchUpPage) {
          clearInterval(check);
          callback(JE);
        }
      }, 100);
    }
    function findActiveContainer() {
      var all = document.querySelectorAll(".jellyfinenhanced.catchup");
      for (var i = all.length - 1; i >= 0; i--) {
        var el = all[i];
        if (el && JE.helpers.isActiveTabContainer(el)) return el;
      }
      return null;
    }
    function renderCatchUp(container, JE2) {
      container.classList.remove("hide");
      container.style.display = "";
      var child = document.createElement("div");
      child.id = "je-catchup-container-tab";
      container.textContent = "";
      container.appendChild(child);
      ctx.own.catchUpPage?.injectStyles();
      ctx.own.catchUpPage?.renderPage(child);
      lastMountedContainer = container;
    }
    function watchForContainer(JE2) {
      var wasOnHomePage = false;
      function tryMount() {
        var onHome = isOnHomePage();
        if (!onHome) {
          if (wasOnHomePage) {
            ctx.own.catchUp?.deck?.dispose();
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
            ctx.own.catchUp?.deck?.dispose();
          }
          lastMountedContainer = null;
          return;
        }
        var shouldMount = justReturned || container !== lastMountedContainer || !container.hasChildNodes() || lastMountedContainer && !document.contains(lastMountedContainer);
        if (shouldMount) {
          renderCatchUp(container, JE2);
        }
      }
      tryMount();
      window.addEventListener("hashchange", tryMount);
      JE2.helpers.observeTabContainers("catchup-custom-tab", ".jellyfinenhanced.catchup", tryMount);
    }
    waitForCatchUp(function(JE2) {
      watchForContainer(JE2);
    });
  })();
})();
})();
//# sourceMappingURL=catchup-custom-tab.js.map
