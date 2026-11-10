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

  // client/generated-shared/stub/client/src/features/details-providers/host.ts
  var shared = /* @__PURE__ */ sharedModule("features/details-providers/host");
  var export1 = /* @__PURE__ */ sharedExport(shared, "bridge");

  // client/src/features/details-providers/rating-domain.ts
  var RATING_MAPPINGS = {
    "NOT RATED": "NR",
    "NOT-RATED": "NR",
    "UNRATED": "NR",
    "NO RATING": "NR",
    "DE-0": "FSK-0",
    "DE-6": "FSK-6",
    "DE-12": "FSK-12",
    "DE-16": "FSK-16",
    "DE-18": "FSK-18",
    "FSK0": "FSK-0",
    "FSK6": "FSK-6",
    "FSK12": "FSK-12",
    "FSK16": "FSK-16",
    "FSK18": "FSK-18",
    "FSK 0": "FSK-0",
    "FSK 6": "FSK-6",
    "FSK 12": "FSK-12",
    "FSK 16": "FSK-16",
    "FSK 18": "FSK-18",
    "APPROVED": "APPROVED",
    "PASSED": "PASSED"
  };
  function normalizeRating(rating) {
    if (!rating) return "";
    const normalized = rating.replace(/\s+/g, " ").trim().toUpperCase();
    const mapped = Object.prototype.hasOwnProperty.call(RATING_MAPPINGS, normalized) ? RATING_MAPPINGS[normalized] : void 0;
    return mapped || rating.trim();
  }

  // client/src/features/details-providers/colored-ratings.ts
  var JE = export1("Colored ratings");
  var CONFIG = {
    targetSelector: ".mediaInfoOfficialRating",
    attributeName: "rating",
    debounceDelay: 100,
    cssUrl: JE.cdn.url("je-css", "ratings.css"),
    cssId: "jellyfin-ratings-style"
  };
  var observer = null;
  var navigationUnsubscribers = [];
  var debounceTimer = null;
  var processedElements = /* @__PURE__ */ new WeakSet();
  function isFeatureEnabled() {
    return Boolean(JE.pluginConfig?.ColoredRatingsEnabled);
  }
  function injectCSS() {
    if (document.getElementById(CONFIG.cssId)) return;
    try {
      const linkElement = document.createElement("link");
      linkElement.id = CONFIG.cssId;
      linkElement.rel = "stylesheet";
      linkElement.type = "text/css";
      linkElement.href = CONFIG.cssUrl;
      document.head.appendChild(linkElement);
    } catch (error) {
      console.error("🪼 Jellyfin Enhanced: Failed to inject ratings CSS", error);
    }
  }
  function processRatingElements() {
    try {
      document.querySelectorAll(CONFIG.targetSelector).forEach((element) => {
        if (processedElements.has(element) && element.textContent?.trim() === element.getAttribute(CONFIG.attributeName)) return;
        const ratingText = element.textContent?.trim();
        if (!ratingText) return;
        const normalizedRating = normalizeRating(ratingText);
        if (element.getAttribute(CONFIG.attributeName) === normalizedRating) return;
        element.setAttribute(CONFIG.attributeName, normalizedRating);
        if (normalizedRating.startsWith("FSK-")) element.textContent = normalizedRating;
        processedElements.add(element);
        if (!element.getAttribute("aria-label")) element.setAttribute("aria-label", `Content rated ${normalizedRating}`);
        if (!element.getAttribute("title")) element.setAttribute("title", `Rating: ${normalizedRating}`);
      });
    } catch (error) {
      console.error("🪼 Jellyfin Enhanced: Error processing rating elements", error);
    }
  }
  function debouncedProcess() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(processRatingElements, CONFIG.debounceDelay);
  }
  function setupMutationObserver() {
    if (!window.MutationObserver) return false;
    try {
      const callback = (mutations) => {
        for (const mutation of mutations) {
          if (mutation.type !== "childList") continue;
          for (const added of mutation.addedNodes) {
            if (added.nodeType === Node.ELEMENT_NODE) {
              debouncedProcess();
              return;
            }
          }
          const target = mutation.target;
          if (target instanceof Element && (target.matches(CONFIG.targetSelector) || target.closest(CONFIG.targetSelector))) {
            debouncedProcess();
            return;
          }
        }
      };
      const createObserver = JE.helpers?.createObserver;
      if (createObserver) {
        observer = createObserver.call(JE.helpers, "colored-ratings", callback, document.body, { childList: true, subtree: true }) || null;
      } else {
        const native = new MutationObserver(callback);
        native.observe(document.body, { childList: true, subtree: true });
        observer = native;
      }
      return true;
    } catch (error) {
      console.error("🪼 Jellyfin Enhanced: Failed to setup ratings observer", error);
      return false;
    }
  }
  function setupNavigationTriggers() {
    const helpers = JE.helpers;
    if (!helpers?.onNavigate) return;
    navigationUnsubscribers.push(helpers.onNavigate(() => {
      if (!isFeatureEnabled()) return;
      setTimeout(processRatingElements, 500);
    }));
    navigationUnsubscribers.push(helpers.onViewPage?.(() => {
      if (isFeatureEnabled()) debouncedProcess();
    }));
  }
  function pausePolling() {
  }
  function resumePolling() {
    if (isFeatureEnabled()) debouncedProcess();
  }
  function cleanup() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    for (const unsubscribe of navigationUnsubscribers) {
      try {
        if (typeof unsubscribe === "function") unsubscribe();
      } catch {
      }
    }
    navigationUnsubscribers = [];
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    processedElements = /* @__PURE__ */ new WeakSet();
  }
  function initialize() {
    cleanup();
    if (!isFeatureEnabled()) return;
    injectCSS();
    processRatingElements();
    setupMutationObserver();
    setupNavigationTriggers();
  }
  if (typeof document.visibilityState !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && isFeatureEnabled()) setTimeout(processRatingElements, 100);
    });
  }
  window.addEventListener("beforeunload", cleanup);
  JE.initializeColoredRatings = initialize;
  JE.normalizeOfficialRating = normalizeRating;
  JE.pauseRatingsPolling = pausePolling;
  JE.resumeRatingsPolling = resumePolling;
})();
})();
//# sourceMappingURL=colored-ratings.js.map
