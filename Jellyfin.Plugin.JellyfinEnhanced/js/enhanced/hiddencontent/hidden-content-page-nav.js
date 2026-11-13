(() => {
"use strict";
(() => {
  // client/src/features/hidden-content/host.ts
  var browser = window;
  if (!browser.JellyfinEnhanced || !browser.ApiClient) throw new Error("Hidden Content host unavailable");
  var host = { JellyfinEnhanced: browser.JellyfinEnhanced, Dashboard: browser.Dashboard, Emby: browser.Emby };
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

  // client/src/features/hidden-content/hidden-content-page-nav.ts
  (function() {
    if (!installOnce(host.JellyfinEnhanced, "hidden-content-page-nav")) return;
    "use strict";
    const JE = host.JellyfinEnhanced;
    const internal = registry(JE, "hiddenContentPage");
    const { state, sidebar, pluginPagesExists, injectStyles } = internal;
    const renderPage = (...args) => internal.renderPage(...args);
    const logPrefix = "🪼 Jellyfin Enhanced: Hidden Content Page:";
    const LOCATION_WATCH_INTERVAL_MS = 150;
    function interceptNavigation(e) {
      const url = "newURL" in e ? new URL(e.newURL) : window.location;
      const hash = url.hash;
      const path = url.pathname;
      const matches = hash.startsWith("#/hidden-content") || path === "/hidden-content";
      if (matches) {
        if (e?.stopImmediatePropagation) e.stopImmediatePropagation();
        if (e?.preventDefault) e.preventDefault();
        showPage();
      }
    }
    function startLocationWatcher() {
      if (state.locationTimer) return;
      state.locationSignature = `${window.location.pathname}${window.location.hash}`;
      state.locationTimer = setInterval(() => {
        const signature = `${window.location.pathname}${window.location.hash}`;
        if (signature !== state.locationSignature) {
          state.locationSignature = signature;
          handleNavigation();
        }
      }, LOCATION_WATCH_INTERVAL_MS);
    }
    function stopLocationWatcher() {
      if (state.locationTimer) {
        clearInterval(state.locationTimer);
        state.locationTimer = null;
      }
    }
    function createPageContainer() {
      let page = document.getElementById("je-hidden-content-page");
      if (!page) {
        page = document.createElement("div");
        page.id = "je-hidden-content-page";
        page.className = "page type-interior mainAnimatedPage hide";
        page.setAttribute("data-title", "Hidden Content");
        page.setAttribute("data-backbutton", "true");
        page.setAttribute("data-url", "#/hidden-content");
        page.setAttribute("data-type", "custom");
        const contentWrapper = document.createElement("div");
        contentWrapper.setAttribute("data-role", "content");
        const contentPrimary = document.createElement("div");
        contentPrimary.className = "content-primary je-hidden-content-page";
        const container = document.createElement("div");
        container.id = "je-hidden-content-container";
        container.style.cssText = "padding-top: 5em; padding-left: 0.5em; padding-right: 0.5em;";
        contentPrimary.appendChild(container);
        contentWrapper.appendChild(contentPrimary);
        page.appendChild(contentWrapper);
        const mainContent = document.querySelector(".mainAnimatedPages");
        if (mainContent) {
          mainContent.appendChild(page);
        } else {
          document.body.appendChild(page);
        }
      }
      return page;
    }
    function showPage() {
      if (state.pageVisible) return true;
      const config = JE.pluginConfig || {};
      if (pluginPagesExists && config.HiddenContentUsePluginPages) return false;
      if (config.HiddenContentUseCustomTabs) return false;
      if (config.HiddenContentUseNativeTab) return false;
      state.pageVisible = true;
      startLocationWatcher();
      injectStyles();
      const page = createPageContainer();
      const expectedHash = "#/hidden-content";
      if (window.location.hash !== expectedHash) {
        history.pushState({ page: "hidden-content" }, "Hidden Content", expectedHash);
      }
      const activePage = document.querySelector(".mainAnimatedPage:not(.hide):not(#je-hidden-content-page)");
      if (activePage) {
        state.previousPage = activePage;
        activePage.classList.add("hide");
        activePage.dispatchEvent(
          new CustomEvent("viewhide", {
            bubbles: true,
            detail: { type: "interior" }
          })
        );
      }
      page.classList.remove("hide");
      page.dispatchEvent(
        new CustomEvent("viewshow", {
          bubbles: true,
          detail: {
            type: "custom",
            isRestored: false,
            options: {}
          }
        })
      );
      page.dispatchEvent(
        new CustomEvent("pageshow", {
          bubbles: true,
          detail: {}
        })
      );
      renderPage();
      return true;
    }
    function hidePage() {
      if (!state.pageVisible) return;
      const page = document.getElementById("je-hidden-content-page");
      if (page) {
        page.classList.add("hide");
        page.dispatchEvent(
          new CustomEvent("viewhide", {
            bubbles: true,
            detail: { type: "custom" }
          })
        );
      }
      if (state.previousPage && !document.querySelector(".mainAnimatedPage:not(.hide):not(#je-hidden-content-page)")) {
        state.previousPage.classList.remove("hide");
        state.previousPage.dispatchEvent(
          new CustomEvent("viewshow", {
            bubbles: true,
            detail: { type: "interior", isRestored: true }
          })
        );
      }
      state.pageVisible = false;
      state.previousPage = null;
      state.searchQuery = "";
      state.adminLoadToken++;
      state.selectedAdminUserId = null;
      state.adminEditMode = false;
      state.adminItems = null;
      state.adminItemsUserId = null;
      state.adminLoadError = false;
      state.adminUserName = "";
      state.scopedOnly = false;
      state.adminUsers = null;
      state.adminUsersLoading = false;
      stopLocationWatcher();
    }
    function handleNavigation() {
      const hash = window.location.hash;
      const path = window.location.pathname;
      if (hash.startsWith("#/hidden-content") || path === "/hidden-content") {
        showPage();
      } else if (state.pageVisible) {
        hidePage();
      }
    }
    function handleViewShow(e) {
      const targetPage = e.target;
      if (!(targetPage instanceof Element) || targetPage.id === "je-hidden-content-page") return;
      if (state.pageVisible) hidePage();
      queueMicrotask(handleNavigation);
    }
    function handleNavClick(e) {
      if (!state.pageVisible) return;
      if (!(e.target instanceof Element)) return;
      const btn = e.target.closest(".headerTabs button, .navMenuOption, .headerButton");
      if (btn && !btn.classList.contains("je-nav-hidden-content-item")) {
        hidePage();
      }
    }
    function renderForCustomTab(targetContainer) {
      state._customTabMode = true;
      injectStyles();
      renderPage(targetContainer);
    }
    function injectNavigation() {
      const config = JE.pluginConfig || {};
      if (!config.HiddenContentEnabled) return;
      if (pluginPagesExists && config.HiddenContentUsePluginPages) return;
      if (config.HiddenContentUseCustomTabs) return;
      if (config.HiddenContentUseNativeTab) return;
      const pluginPageItem = sidebar?.querySelector(
        'a[is="emby-linkbutton"][data-itemid="Jellyfin.Plugin.JellyfinEnhanced.HiddenContentPage"]'
      );
      if (pluginPageItem) {
        pluginPageItem.style.setProperty("display", "none", "important");
      }
      if (document.querySelector(".je-nav-hidden-content-item")) return;
      const jellyfinEnhancedSection = document.querySelector(".jellyfinEnhancedSection");
      if (jellyfinEnhancedSection) {
        const navItem = document.createElement("a");
        navItem.setAttribute("is", "emby-linkbutton");
        navItem.className = "navMenuOption lnkMediaFolder emby-button je-nav-hidden-content-item";
        navItem.href = "#";
        const iconSpan = document.createElement("span");
        iconSpan.className = "navMenuOptionIcon material-icons";
        iconSpan.textContent = "visibility_off";
        navItem.appendChild(iconSpan);
        const textSpan = document.createElement("span");
        textSpan.className = "sectionName navMenuOptionText";
        textSpan.textContent = JE.t("hidden_content_manage_title");
        navItem.appendChild(textSpan);
        navItem.addEventListener("click", (e) => {
          e.preventDefault();
          showPage();
        });
        const calendarNavItem = jellyfinEnhancedSection.querySelector(".je-nav-calendar-item");
        if (calendarNavItem && calendarNavItem.nextSibling) {
          jellyfinEnhancedSection.insertBefore(navItem, calendarNavItem.nextSibling);
        } else if (calendarNavItem) {
          jellyfinEnhancedSection.appendChild(navItem);
        } else {
          jellyfinEnhancedSection.appendChild(navItem);
        }
        console.log(`${logPrefix} Navigation item injected`);
      } else {
        console.log(`${logPrefix} jellyfinEnhancedSection not found, will wait for it`);
      }
    }
    function setupNavigationWatcher() {
      const config = JE.pluginConfig || {};
      if (!config.HiddenContentEnabled) return;
      if (pluginPagesExists && config.HiddenContentUsePluginPages) return;
      if (config.HiddenContentUseCustomTabs) return;
      if (config.HiddenContentUseNativeTab) return;
      JE.helpers.onSidebarRebuilt("hidden-content", ".je-nav-hidden-content-item", () => {
        const currentConfig = JE.pluginConfig || {};
        if (currentConfig.HiddenContentUseCustomTabs) return;
        if (currentConfig.HiddenContentUseNativeTab) return;
        if (pluginPagesExists && currentConfig.HiddenContentUsePluginPages) return;
        console.log(`${logPrefix} Sidebar rebuilt, re-injecting navigation`);
        injectNavigation();
      });
    }
    Object.assign(internal, {
      createPageContainer,
      showPage,
      hidePage,
      interceptNavigation,
      handleNavigation,
      handleViewShow,
      handleNavClick,
      injectNavigation,
      setupNavigationWatcher,
      renderForCustomTab
    });
  })();
})();
})();
//# sourceMappingURL=hidden-content-page-nav.js.map
