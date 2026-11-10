(() => {
"use strict";
(() => {
  // client/src/features/shared/url-domain.ts
  function safeExternalUrl(value, base) {
    try {
      const url = new URL(value, base);
      return ["http:", "https:", "mailto:", "tel:", "ftp:", "blob:"].includes(url.protocol) ? value : "#";
    } catch {
      return "#";
    }
  }

  // client/src/features/shared/item-domain.ts
  function decodeItem(value) {
    if (value === null) return null;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Jellyfin item response");
    if ("Id" in value && value.Id !== null && typeof value.Id !== "string") throw new Error("Invalid Jellyfin item Id");
    return Object.fromEntries(Object.entries(value));
  }

  // client/src/features/shared/helpers.ts
  function createHelpers(JE2, api) {
    let muiHeaderButtonCSSInjected = false;
    const drawerAutoCloseContainers = /* @__PURE__ */ new WeakSet();
    function closeMobileDrawerIfOpen() {
      if (window.matchMedia("(min-width: 900px)").matches) return;
      const paper = document.querySelector(".MuiDrawer-paper");
      if (!paper) return;
      if (getComputedStyle(paper).visibility === "hidden" || paper.closest(".MuiModal-hidden") || paper.getBoundingClientRect().right <= 0) return;
      paper.closest(".MuiModal-root")?.querySelector(":scope > .MuiBackdrop-root")?.click();
    }
    function attachDrawerAutoClose(container) {
      if (!container || drawerAutoCloseContainers.has(container)) return;
      drawerAutoCloseContainers.add(container);
      container.addEventListener("click", (event) => {
        if (!(event.target instanceof Element && event.target.closest(".je-header-overflowed"))) closeMobileDrawerIfOpen();
      }, true);
    }
    function isAdmin() {
      return JE2.currentSettings?.isAdmin === true;
    }
    const itemCache = /* @__PURE__ */ new Map();
    let generation = 0;
    let scope = "";
    function identity() {
      const host = api();
      return JSON.stringify([host.getCurrentUserId(), typeof host.serverId === "function" ? host.serverId() : host.serverId, host.accessToken?.()]);
    }
    function invalidate() {
      generation++;
      itemCache.clear();
      clearAvatarObjectUrlCache(true);
    }
    function lease() {
      const current = identity();
      if (scope !== current) {
        scope = current;
        invalidate();
      }
      JE2.session?.checkNow?.("shared-helpers");
      const session = JE2.session?.createLease?.();
      const captured = generation;
      return () => captured === generation && current === identity() && (!session || session.isCurrent());
    }
    const ITEM_CACHE_TTL_MS = 3e4;
    let avatarGeneration = 0;
    const avatarObjectUrlCache = /* @__PURE__ */ new Map();
    const avatarFetchPromises = /* @__PURE__ */ new Map();
    function getAvatarAuthHeaders() {
      const token = api().accessToken?.() || "";
      return {
        "Authorization": 'MediaBrowser Token="' + token + '"',
        "X-MediaBrowser-Token": token
      };
    }
    function isSafeAvatarUrl(url) {
      if (!url || typeof url !== "string") return false;
      if (url.startsWith("/") || url.startsWith("blob:")) return true;
      try {
        const parsed = new URL(url, window.location.origin);
        if (parsed.protocol === "http:" || parsed.protocol === "https:") return true;
        if (parsed.protocol === "data:") return /^data:image\//i.test(url);
      } catch {
        return false;
      }
      return false;
    }
    async function resolveProtectedAvatarUrl(avatarUrl) {
      const current = lease();
      const avatarEpoch = avatarGeneration;
      if (!isSafeAvatarUrl(avatarUrl)) return "";
      if (!avatarUrl.startsWith("/JellyfinEnhanced/proxy/avatar")) return avatarUrl;
      if (avatarObjectUrlCache.has(avatarUrl)) return avatarObjectUrlCache.get(avatarUrl) || "";
      if (avatarFetchPromises.has(avatarUrl)) return avatarFetchPromises.get(avatarUrl) || "";
      const fetchPromise = Promise.resolve().then(async () => {
        try {
          const response = await fetch(api().getUrl(avatarUrl), { headers: getAvatarAuthHeaders() });
          if (!response.ok) return "";
          const blob = await response.blob();
          if (!current() || avatarEpoch !== avatarGeneration) return "";
          const objectUrl = URL.createObjectURL(blob);
          avatarObjectUrlCache.set(avatarUrl, objectUrl);
          return objectUrl;
        } catch {
          return "";
        } finally {
          if (avatarFetchPromises.get(avatarUrl) === fetchPromise) avatarFetchPromises.delete(avatarUrl);
        }
      });
      avatarFetchPromises.set(avatarUrl, fetchPromise);
      return fetchPromise;
    }
    function hydrateAvatarImages(container) {
      const avatarImgs = container.querySelectorAll("img.je-request-avatar[data-avatar-src]");
      avatarImgs.forEach(async (img) => {
        const sourceUrl = img.getAttribute("data-avatar-src");
        if (!sourceUrl) {
          img.style.display = "none";
          return;
        }
        const current = lease();
        const avatarEpoch = avatarGeneration;
        const resolvedUrl = await resolveProtectedAvatarUrl(sourceUrl);
        if (!current() || avatarEpoch !== avatarGeneration || !img.isConnected || img.getAttribute("data-avatar-src") !== sourceUrl) return;
        if (!resolvedUrl || !isSafeAvatarUrl(resolvedUrl)) {
          img.style.display = "none";
          return;
        }
        img.src = resolvedUrl;
        img.style.display = "";
      });
    }
    function clearAvatarObjectUrlCache(includeInFlight = false) {
      if (includeInFlight) {
        avatarGeneration++;
        avatarFetchPromises.clear();
      }
      avatarObjectUrlCache.forEach((objectUrl) => URL.revokeObjectURL(objectUrl));
      avatarObjectUrlCache.clear();
    }
    JE2.session?.onUserChange("helpers", invalidate);
    window.addEventListener("beforeunload", invalidate);
    window.addEventListener("je:spoiler-state-changed", () => {
      generation++;
      itemCache.clear();
    });
    async function getItemCached(itemId, options = {}) {
      if (!itemId) return null;
      const current = lease();
      const ttlMs = typeof options.ttlMs === "number" && Number.isFinite(options.ttlMs) ? options.ttlMs : ITEM_CACHE_TTL_MS;
      const userId = options.userId || api().getCurrentUserId();
      const key = JSON.stringify([scope, userId, itemId]);
      const now = Date.now();
      const entry = itemCache.get(key);
      if (!options.forceRefresh && entry) {
        if (entry.promise) {
          return entry.promise;
        }
        if (entry.item && now - entry.ts < ttlMs) {
          return entry.item;
        }
      }
      const promise = api().getItem(userId, itemId).then((value) => {
        if (!current()) return null;
        const item = decodeItem(value);
        if (itemCache.get(key)?.promise === promise) {
          itemCache.set(key, { item, ts: Date.now(), promise: null });
        }
        return item;
      }).catch((err) => {
        if (itemCache.get(key)?.promise === promise) itemCache.delete(key);
        throw err;
      });
      itemCache.set(key, { item: null, ts: now, promise });
      return promise;
    }
    function debounce(func, wait, options) {
      const maxWait = options?.maxWait !== void 0 && options.maxWait > 0 ? options.maxWait : Infinity;
      let timeout = null;
      let lastCall = 0;
      let firstCall = 0;
      let lastArgs;
      const fire = () => {
        const now = Date.now();
        const remaining = Math.min(wait - (now - lastCall), maxWait - (now - firstCall));
        if (remaining > 0) {
          timeout = setTimeout(fire, remaining);
          return;
        }
        timeout = null;
        func(...lastArgs);
      };
      return function executedFunction(...args) {
        lastArgs = args;
        lastCall = Date.now();
        if (timeout === null) {
          firstCall = lastCall;
          timeout = setTimeout(fire, Math.min(wait, maxWait));
        }
      };
    }
    function throttle(func, limit) {
      let inThrottle = false;
      return function(...args) {
        if (!inThrottle) {
          func.apply(this, args);
          inThrottle = true;
          setTimeout(() => inThrottle = false, limit);
        }
      };
    }
    async function retry(fn, maxAttempts = 5, baseDelay = 1e3) {
      let lastError;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          return await fn();
        } catch (error) {
          lastError = error;
          if (attempt === maxAttempts) {
            console.error(`🪼 Jellyfin Enhanced: Failed after ${maxAttempts} attempts:`, error);
            throw error;
          }
          const delay = baseDelay * Math.pow(2, attempt - 1);
          console.warn(`🪼 Jellyfin Enhanced: Attempt ${attempt}/${maxAttempts} failed, retrying in ${delay}ms...`, error);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
      throw lastError;
    }
    function isElementVisible(element) {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      return rect.top >= 0 && rect.left >= 0 && rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) && rect.right <= (window.innerWidth || document.documentElement.clientWidth);
    }
    function getHeaderRightContainer() {
      const legacy = document.querySelector(".headerRight:not([data-je-header-fallback])");
      if (legacy && legacy.offsetParent !== null) {
        attachDrawerAutoClose(legacy);
        return legacy;
      }
      const userMenuButton = document.querySelector('[aria-controls="app-user-menu"]');
      const toolbar = userMenuButton?.closest(".MuiToolbar-root") || document.querySelector(".MuiAppBar-root .MuiToolbar-root");
      if (!toolbar) return null;
      if (!muiHeaderButtonCSSInjected || !document.getElementById("je-mui-header-button-fix")) {
        addCSS("je-mui-header-button-fix", `
                .MuiToolbar-root .headerButton.paper-icon-button-light {
                    display: inline-flex !important;
                    align-items: center !important;
                    justify-content: center !important;
                    box-sizing: border-box !important;
                    width: 48px !important;
                    height: 48px !important;
                    padding: 0 !important;
                    margin: 0 !important;
                    font-size: 16px !important;
                }
                .MuiToolbar-root .headerButton.paper-icon-button-light > .material-icons {
                    font-size: 24px !important;
                }
            `);
        muiHeaderButtonCSSInjected = true;
      }
      let userMenuBox = userMenuButton;
      while (userMenuBox && userMenuBox.parentElement !== toolbar) {
        userMenuBox = userMenuBox.parentElement;
      }
      let buttonsTray = userMenuBox?.previousElementSibling;
      if (buttonsTray?.hasAttribute("data-je-header-fallback") && buttonsTray.previousElementSibling?.matches(".MuiBox-root")) {
        buttonsTray = buttonsTray.previousElementSibling;
      }
      const isInteractive = buttonsTray?.matches('button, a, [role="button"]');
      if (buttonsTray && !isInteractive) {
        attachDrawerAutoClose(buttonsTray);
        return buttonsTray;
      }
      let container = toolbar.querySelector(":scope > .headerRight");
      if (!container) {
        container = document.createElement("div");
        container.className = "headerRight";
        container.dataset.jeHeaderFallback = "";
        if (userMenuBox) toolbar.insertBefore(container, userMenuBox);
        else toolbar.appendChild(container);
      } else if (userMenuBox && container.nextElementSibling !== userMenuBox && container.compareDocumentPosition(userMenuBox) & Node.DOCUMENT_POSITION_PRECEDING) {
        toolbar.insertBefore(container, userMenuBox);
      }
      attachDrawerAutoClose(container);
      return container;
    }
    function getHeaderButtonTray() {
      return JE2.headerActions?.getTray() || null;
    }
    function getSidebarContainer() {
      const legacy = document.querySelector(".mainDrawer-scrollContainer");
      if (legacy && legacy.offsetParent !== null) return legacy;
      if (document.body.classList.contains("dashboardDocument")) {
        return null;
      }
      const muiDrawerPanel = document.querySelector(".MuiDrawer-paper");
      if (!muiDrawerPanel) return null;
      return muiDrawerPanel.querySelector('[role="presentation"]') || muiDrawerPanel;
    }
    const sidebarNavEntries = /* @__PURE__ */ new Map();
    let sidebarSectionElement = null;
    let sidebarNavSubscribed = false;
    let sidebarUnsubscribe;
    function checkSidebarNavEntries() {
      if (sidebarNavEntries.size === 0) return;
      if (!sidebarSectionElement || !sidebarSectionElement.isConnected) {
        sidebarSectionElement = document.querySelector(".jellyfinEnhancedSection");
        if (!sidebarSectionElement) return;
      }
      for (const entry of sidebarNavEntries.values()) {
        if (entry.element && entry.element.isConnected) continue;
        entry.element = document.querySelector(entry.selector);
        if (entry.element) continue;
        try {
          entry.inject();
        } catch (err) {
          console.error("🪼 Jellyfin Enhanced: Sidebar nav injector failed:", err);
        }
        entry.element = document.querySelector(entry.selector);
      }
    }
    function onSidebarRebuilt(id, selector, inject) {
      const entry = { selector, inject, element: null };
      sidebarNavEntries.set(id, entry);
      if (!sidebarNavSubscribed) {
        sidebarNavSubscribed = true;
        const subscription = JE2.core.dom.onBodyMutation("sidebar-nav-watcher", checkSidebarNavEntries);
        sidebarUnsubscribe = () => subscription.unsubscribe();
      }
      return () => {
        if (sidebarNavEntries.get(id) !== entry) return;
        sidebarNavEntries.delete(id);
        if (!sidebarNavEntries.size) {
          sidebarUnsubscribe?.();
          sidebarNavSubscribed = false;
          sidebarSectionElement = null;
        }
      };
    }
    function getTabAncestors(element) {
      const ancestors = [];
      for (let node = element; node; node = node.parentElement) {
        if (node.matches(".page, .tabContent")) ancestors.push(node);
      }
      return ancestors;
    }
    function isActiveTabContainer(element) {
      if (!element.isConnected) return false;
      const ancestors = getTabAncestors(element);
      for (const ancestor of ancestors) {
        if (ancestor instanceof HTMLElement && ancestor.hidden || ancestor.classList.contains("hide")) return false;
        if (ancestor.classList.contains("tabContent") && !ancestor.classList.contains("is-active")) return false;
      }
      return ancestors.length > 0 || element.offsetParent !== null;
    }
    function observeTabContainers(id, selector, callback) {
      const lifecycle = JE2.core.lifecycle.register(id);
      lifecycle.teardown();
      let pending = false;
      let disposed = false;
      const observed = /* @__PURE__ */ new Set();
      const flush = () => {
        if (disposed || !pending) return;
        pending = false;
        const ancestors = /* @__PURE__ */ new Set();
        document.querySelectorAll(selector).forEach((element) => {
          getTabAncestors(element).forEach((ancestor) => ancestors.add(ancestor));
        });
        if (ancestors.size !== observed.size || [...ancestors].some((el) => !observed.has(el))) {
          observer.disconnect();
          observed.clear();
          ancestors.forEach((el) => {
            observer.observe(el, { attributes: true, attributeFilter: ["class", "hidden"] });
            observed.add(el);
          });
        }
        callback();
      };
      const schedule = () => {
        if (pending || disposed) return;
        pending = true;
        JE2.core.dom.afterNextPaint(flush);
      };
      const observer = lifecycle.track(new MutationObserver(schedule));
      lifecycle.track(JE2.core.dom.onBodyMutation(id, schedule));
      lifecycle.track(JE2.core.navigation.onNavigate(schedule));
      lifecycle.track(() => {
        disposed = true;
        pending = false;
      });
      schedule();
      return lifecycle;
    }
    function waitForCondition(condition, timeout = 5e3, interval = 100) {
      return new Promise((resolve) => {
        const startTime = Date.now();
        const checkCondition = () => {
          if (condition()) {
            resolve(true);
            return;
          }
          if (Date.now() - startTime >= timeout) {
            console.warn("🪼 Jellyfin Enhanced: Timeout waiting for condition");
            resolve(false);
            return;
          }
          setTimeout(checkCondition, interval);
        };
        checkCondition();
      });
    }
    function addCSS(id, css) {
      JE2.core.ui.injectCss(id, css);
    }
    function createExternalLink(url, options = {}) {
      const a = document.createElement("a");
      a.setAttribute("is", "emby-linkbutton");
      a.href = safeExternalUrl(url, window.location.href);
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      if (options.title) a.title = options.title;
      if (options.className) a.className = options.className;
      if (options.text) a.textContent = options.text;
      if (options.resetStyle) {
        a.style.cssText = "padding:0;background:none;border-radius:0;min-width:0;";
      }
      if (typeof options.setup === "function") options.setup(a);
      return a;
    }
    const ownExternalLinkClasses = ["letterboxd-link", "seerr-link", "arr-link", "arr-tag-link"];
    function getExternalLinkIconSize(fallback = 18) {
      const container = document.querySelector("#itemDetailPage:not(.hide) .itemExternalLinks");
      if (!container) return fallback;
      const native = [...container.querySelectorAll("a")].find(
        (a) => !ownExternalLinkClasses.some((cls) => a.classList.contains(cls))
      );
      if (!native) return fallback;
      const rect = native.getBoundingClientRect();
      const cs = getComputedStyle(native);
      const verticalChrome = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
      const contentHeight = rect.height - (Number.isFinite(verticalChrome) ? verticalChrome : 0);
      return Number.isFinite(contentHeight) && contentHeight > 0 ? contentHeight : fallback;
    }
    function getHeaderElement() {
      for (const selector of [".skinHeader", ".MuiAppBar-root"]) {
        const el = document.querySelector(selector);
        if (el && el.getBoundingClientRect().height > 0 && getComputedStyle(el).visibility !== "hidden") return el;
      }
      return null;
    }
    function getHeaderBottom() {
      const header = getHeaderElement();
      return header ? Math.round(header.getBoundingClientRect().bottom) : 0;
    }
    function trackUsage(key) {
      try {
        if (!JE2.pluginConfig?.AnalyticsEnabled || !JE2.pluginConfig?.AnalyticsShareUsageCounts) return;
        api().ajax({
          type: "POST",
          url: api().getUrl("/JellyfinEnhanced/usage/track"),
          data: JSON.stringify({ key }),
          contentType: "application/json"
        }).catch(() => {
        });
      } catch {
      }
    }
    return {
      onViewPage: (...args) => JE2.core.navigation.onViewPage(...args),
      // (core)
      onNavigate: (...args) => JE2.core.navigation.onNavigate(...args),
      // (core)
      getItemCached,
      getCurrentView: () => JE2.core.navigation.getCurrentView(),
      // (core)
      createObserver: (...args) => JE2.core.dom.createObserver(...args),
      // (core)
      onBodyMutation: (...args) => JE2.core.dom.onBodyMutation(...args),
      // (core)
      removeBodySubscriber: (...args) => JE2.core.dom.removeBodySubscriber(...args),
      // (core)
      disconnectObserver: (...args) => JE2.core.dom.disconnectObserver(...args),
      // (core)
      disconnectAllObservers: () => JE2.core.dom.disconnectAllObservers(),
      // (core)
      getHeaderRightContainer,
      getHeaderButtonTray,
      getSidebarContainer,
      onSidebarRebuilt,
      isActiveTabContainer,
      observeTabContainers,
      waitForElement: (...args) => JE2.core.dom.waitForElement(...args),
      // (core)
      waitForCondition,
      debounce,
      throttle,
      retry,
      isElementVisible,
      addCSS,
      // (core)
      removeCSS: (...args) => JE2.core.ui.removeCss(...args),
      // (core)
      escHtml: (...args) => JE2.core.ui.escapeHtml(...args),
      // (core)
      createExternalLink,
      getExternalLinkIconSize,
      getHeaderElement,
      getHeaderBottom,
      isSafeAvatarUrl,
      resolveProtectedAvatarUrl,
      hydrateAvatarImages,
      clearAvatarObjectUrlCache,
      trackUsage,
      getHandlerCount: () => JE2.core.navigation.getViewHandlerCount(),
      // (core)
      getObserverCount: () => JE2.core.dom.getObserverCount(),
      // (core)
      getBodySubscriberCount: () => JE2.core.dom.getBodySubscriberCount(),
      // (core)
      isAdmin
    };
    console.log("🪼 Jellyfin Enhanced: Helpers initialized successfully");
  }

  // client/src/features/shared/host.ts
  function bridge() {
    const host = window;
    if (!host.JellyfinEnhanced) throw new Error("Jellyfin Enhanced must initialize first");
    return host.JellyfinEnhanced;
  }
  function client() {
    const host = window;
    if (!host.ApiClient) throw new Error("Jellyfin ApiClient unavailable");
    return host.ApiClient;
  }

  // client/src/features/shared/helpers-entry.ts
  var JE = bridge();
  if (!JE.helpers) JE.helpers = createHelpers(JE, client);
})();
})();
//# sourceMappingURL=helpers.js.map
