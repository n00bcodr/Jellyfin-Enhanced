(() => {
"use strict";
(() => {
  // client/src/features/hidden-content/host.ts
  var browser = window;
  if (!browser.JellyfinEnhanced || !browser.ApiClient) throw new Error("Hidden Content host unavailable");
  var host = { JellyfinEnhanced: browser.JellyfinEnhanced, Dashboard: browser.Dashboard, Emby: browser.Emby };
  function runtime(JE) {
    const internals = JE.internals ?? (JE.internals = {});
    if (internals.hiddenContentRuntime) return internals.hiddenContentRuntime;
    const state = { modules: /* @__PURE__ */ new Set(), view: 0, policy: 0, queues: /* @__PURE__ */ new Map(), cleanups: /* @__PURE__ */ new Set(), identityCleanups: /* @__PURE__ */ new Set() };
    internals.hiddenContentRuntime = state;
    const invalidate = () => {
      state.view++;
      for (const cleanup of [...state.cleanups]) cleanup();
    };
    window.addEventListener("hashchange", invalidate);
    window.addEventListener("popstate", invalidate);
    document.addEventListener("viewhide", invalidate);
    const invalidateIdentity = () => {
      invalidate();
      for (const cleanup of [...state.identityCleanups]) cleanup();
    };
    window.addEventListener("pagehide", invalidateIdentity);
    JE.session?.onUserChange("hidden-content-runtime", invalidateIdentity);
    return state;
  }
  function installOnce(JE, name) {
    const modules = runtime(JE).modules;
    if (modules.has(name)) return false;
    modules.add(name);
    return true;
  }

  // client/src/features/hidden-content/hidden-content-custom-tab.ts
  (function() {
    "use strict";
    if (!host.JellyfinEnhanced?.pluginConfig?.HiddenContentEnabled) {
      return;
    }
    var useCustomTabs = !!host.JellyfinEnhanced?.pluginConfig?.HiddenContentUseCustomTabs;
    var useNativeTab = !!host.JellyfinEnhanced?.pluginConfig?.HiddenContentUseNativeTab;
    if (!useCustomTabs && !useNativeTab) {
      return;
    }
    if (useNativeTab) {
      host.JellyfinEnhanced.nativeTabs.register("hidden-content", host.JellyfinEnhanced.t("hidden_content_manage_title") || "Hidden Content", function(panel) {
        var marker = document.createElement("div");
        marker.className = "jellyfinenhanced hidden-content";
        panel.appendChild(marker);
      }, "remove_red_eye");
    }
    var style = document.createElement("style");
    style.textContent = [
      ".jellyfinenhanced.hidden-content {",
      "  padding: 12px 3vw;",
      "}",
      ".backgroundContainer.withBackdrop:has(~ * #indexPage .tabContent.is-active .jellyfinenhanced.hidden-content) {",
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
    function waitForHiddenContent(callback) {
      var attempts = 0;
      var check = setInterval(function() {
        if (++attempts > 300) {
          clearInterval(check);
          return;
        }
        var JE = host.JellyfinEnhanced;
        if (JE?.hiddenContentPage && JE?.hiddenContent) {
          clearInterval(check);
          callback(JE);
        }
      }, 100);
    }
    function findActiveContainer() {
      var all = document.querySelectorAll(".jellyfinenhanced.hidden-content");
      for (var i = all.length - 1; i >= 0; i--) {
        var el = all[i];
        if (el && host.JellyfinEnhanced.helpers.isActiveTabContainer(el)) return el;
      }
      return null;
    }
    function renderHiddenContent(container, JE) {
      if (!container || !JE.hiddenContentPage) return;
      container.classList.remove("hide");
      container.style.display = "";
      var child = document.createElement("div");
      child.id = "je-hidden-content-container-tab";
      container.textContent = "";
      container.appendChild(child);
      JE.hiddenContentPage.renderForCustomTab?.(child);
      lastMountedContainer = container;
    }
    function watchForContainer(JE) {
      function tryMount() {
        if (!isOnHomePage()) return;
        var container = findActiveContainer();
        if (!container) {
          lastMountedContainer = null;
          return;
        }
        var shouldMount = container !== lastMountedContainer || !container.hasChildNodes() || lastMountedContainer && !document.contains(lastMountedContainer);
        if (shouldMount) {
          renderHiddenContent(container, JE);
        }
      }
      tryMount();
      JE.helpers.observeTabContainers("hidden-content-custom-tab", ".jellyfinenhanced.hidden-content", tryMount);
    }
    waitForHiddenContent(function(JE) {
      if (!installOnce(JE, "hidden-content-custom-tab")) return;
      watchForContainer(JE);
    });
  })();
})();
})();
//# sourceMappingURL=hidden-content-custom-tab.js.map
