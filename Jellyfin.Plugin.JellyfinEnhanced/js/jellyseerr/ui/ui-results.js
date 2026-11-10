(() => {
"use strict";
(() => {
  // client/src/host/context.ts
  function featureContext(feature, core, slots) {
    const shared4 = core.core?.featureContext;
    if (typeof shared4 !== "function") {
      throw new Error(`${feature}: JE.core.featureContext is missing; core/ui-kit.js must load before feature scripts`);
    }
    return shared4(feature, core, slots);
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
  function seerrCoreContext(JE) {
    let ctx = coreContexts.get(JE);
    if (!ctx) {
      ctx = featureContext("seerr", JE, {
        internalSlots: ["jellyseerrUi"],
        internalsObject: () => JE.internals || (JE.internals = {})
      });
      coreContexts.set(JE, ctx);
    }
    return ctx;
  }
  function seerrCoreHost() {
    const host = window;
    const JE = host.JellyfinEnhanced;
    if (!JE) throw new Error("Jellyfin Enhanced must be initialized before the Seerr core group");
    return { JE, window: host, document, apiClient: () => host.ApiClient, liveBridge: () => host.JellyfinEnhanced };
  }

  // client/generated-shared/stub/client/src/features/seerr/core/decode.ts
  var shared = /* @__PURE__ */ sharedModule("features/seerr/core/decode");
  var export19 = /* @__PURE__ */ sharedExport(shared, "isRecord");
  var export22 = /* @__PURE__ */ sharedExport(shared, "isString");

  // client/generated-shared/stub/client/src/features/seerr/core/display.ts
  var shared2 = /* @__PURE__ */ sharedModule("features/seerr/core/display");
  var export0 = /* @__PURE__ */ sharedExport(shared2, "analyzeSeasonStatuses");

  // client/src/features/seerr/core/runtime.ts
  var LOG_UI = "🪼 Jellyfin Enhanced: Seerr UI:";
  function groupInternals(JE) {
    const own = seerrCoreContext(JE).own;
    return own.jellyseerrUi || (own.jellyseerrUi = { state: { jellyseerrHoverPopover: null, jellyseerrHoverLock: false, active4KPopup: null } });
  }
  function firstInstall(JE, name) {
    const internals = groupInternals(JE);
    const installed = internals.installed || (internals.installed = /* @__PURE__ */ new Set());
    if (installed.has(name)) return false;
    installed.add(name);
    return true;
  }

  // client/generated-shared/stub/client/src/features/seerr/core/ui/icon-markup.ts
  var shared3 = /* @__PURE__ */ sharedModule("features/seerr/core/ui/icon-markup");
  var export02 = /* @__PURE__ */ sharedExport(shared3, "ICONS");

  // client/src/features/seerr/core/ui/results.ts
  var PRIMARY_CARD_TYPES = ["movie", "series"];
  var isTmdbId = (value) => /^\d+$/.test(value);
  function installResults(host) {
    const { JE, document: document2, window: window2 } = host;
    if (!firstInstall(JE, "ui-results")) return;
    const ui = JE.jellyseerrUI || (JE.jellyseerrUI = {});
    const internals = groupInternals(JE);
    const state = internals.state;
    const icons = () => internals.icons ?? export02;
    let pendingRepositionObserver = null;
    let pendingRepositionTimeout = null;
    function markCardRequested(tmdbId, mediaType, is4k = false) {
      if (!isTmdbId(tmdbId)) return;
      const type = mediaType.toLowerCase();
      const requestedLabel = JE.t("jellyseerr_btn_requested") || "Requested";
      const buttons = [...document2.querySelectorAll(`.jellyseerr-request-button[data-tmdb-id="${tmdbId}"]`)].filter((button) => !button.dataset.mediaType || button.dataset.mediaType.toLowerCase() === type);
      for (const button of buttons) {
        if (is4k) {
          const arrow = button.parentElement?.querySelector(".jellyseerr-split-arrow");
          if (arrow) {
            arrow.classList.add("jellyseerr-4k-pending");
            arrow.disabled = true;
          }
          continue;
        }
        button.innerHTML = `${icons().requested}<span>${requestedLabel}</span>`;
        button.classList.remove("jellyseerr-button-request");
        button.classList.add("jellyseerr-button-pending");
        button.disabled = true;
        const badge = button.closest(".jellyseerr-card")?.querySelector(".jellyseerr-status-badge");
        if (badge) {
          badge.innerHTML = icons().requested;
          badge.className = "jellyseerr-status-badge status-requested";
          badge.style.display = "flex";
        }
      }
    }
    document2.addEventListener("jellyseerr-media-requested", (event) => {
      const detail = event instanceof CustomEvent ? event.detail : null;
      if (!export19(detail)) return;
      const tmdbId = detail.tmdbId;
      const mediaType = detail.mediaType;
      if (!export22(tmdbId) && typeof tmdbId !== "number" || !tmdbId || !export22(mediaType) || !mediaType) return;
      markCardRequested(String(tmdbId), mediaType, detail.is4k === true);
    });
    let iconState = { active: false, userFound: false, onToggle: null };
    function updateJellyseerrIcon(isJellyseerrActive, jellyseerrUserFound, isJellyseerrOnlyMode, onToggleFilter) {
      iconState = { active: isJellyseerrActive, userFound: jellyseerrUserFound, onToggle: onToggleFilter };
      const anchor = document2.querySelector(".searchFields .inputContainer") || document2.querySelector("#searchPage .searchFields") || document2.querySelector("#searchPage");
      if (!anchor) return;
      let icon = document2.getElementById("jellyseerr-search-icon");
      if (!(icon instanceof HTMLImageElement)) {
        const img = document2.createElement("img");
        img.id = "jellyseerr-search-icon";
        img.className = "jellyseerr-icon";
        img.src = JE.cdn?.selfhst?.("svg/seerr.svg") ?? "";
        img.alt = "Seerr";
        let tapCount = 0;
        let tapTimer = null;
        const toggle = () => iconState.active && iconState.userFound ? iconState.onToggle : null;
        const handleIconInteraction = () => {
          if (!toggle()) return;
          tapCount++;
          if (tapCount === 1) {
            tapTimer = window2.setTimeout(() => {
              tapCount = 0;
            }, 300);
          } else if (tapCount === 2) {
            if (tapTimer !== null) window2.clearTimeout(tapTimer);
            tapCount = 0;
            toggle()?.();
          }
        };
        img.addEventListener("click", handleIconInteraction);
        JE.core?.ui?.addTouchTapListener?.(img, (event) => {
          event.preventDefault();
          handleIconInteraction();
        });
        img.setAttribute("tabindex", "0");
        img.addEventListener("keydown", (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          toggle()?.();
        });
        anchor.appendChild(img);
        icon = img;
      }
      icon.classList.remove("is-active", "is-disabled", "is-no-user", "is-filter-active");
      if (isJellyseerrActive && jellyseerrUserFound) {
        icon.title = JE.t(isJellyseerrOnlyMode ? "jellyseerr_icon_active_filter_tooltip" : "jellyseerr_icon_active_tooltip");
        icon.classList.add("is-active");
        if (isJellyseerrOnlyMode) icon.classList.add("is-filter-active");
      } else if (isJellyseerrActive && !jellyseerrUserFound) {
        icon.title = JE.t("jellyseerr_icon_no_user_tooltip");
        icon.classList.add("is-no-user");
      } else {
        icon.title = JE.t("jellyseerr_icon_disabled_tooltip");
        icon.classList.add("is-disabled");
      }
    }
    function clearInjectedSearchResults() {
      document2.querySelectorAll(".jellyseerr-section, .jellyseerr-no-results-message").forEach((el) => el.remove());
      ui.releasePosters?.();
      document2.querySelectorAll(".jellyseerr-native-message-hidden").forEach((el) => el.classList.remove("jellyseerr-native-message-hidden"));
    }
    function createJellyseerrSection(results, isJellyseerrOnlyMode, isJellyseerrActive, jellyseerrUserFound) {
      const section = document2.createElement("div");
      section.className = "verticalSection emby-scroller-container jellyseerr-section";
      section.setAttribute("data-jellyseerr-section", "true");
      const title = document2.createElement("h2");
      title.className = "sectionTitle sectionTitle-cards focuscontainer-x padded-left padded-right";
      title.textContent = isJellyseerrOnlyMode ? JE.t("jellyseerr_results_title") : JE.t("jellyseerr_discover_title");
      const refreshBtn = document2.createElement("button");
      refreshBtn.className = "jellyseerr-refresh-btn";
      Object.assign(refreshBtn.style, {
        marginLeft: "0.5em",
        verticalAlign: "middle",
        background: "none",
        border: "none",
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "0"
      });
      const icon = document2.createElement("span");
      icon.className = "material-icons jellyseerr-refresh-icon";
      icon.textContent = "refresh";
      icon.style.transition = "transform 0.5s cubic-bezier(.4,2,.6,1)";
      refreshBtn.appendChild(icon);
      refreshBtn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        icon.style.transform = "rotate(360deg)";
        window2.setTimeout(() => {
          icon.style.transform = "";
        }, 500);
        document2.dispatchEvent(new CustomEvent("jellyseerr-manual-refresh"));
      });
      title.appendChild(refreshBtn);
      if (!document2.getElementById("jellyseerr-refresh-style")) {
        const style = document2.createElement("style");
        style.id = "jellyseerr-refresh-style";
        style.textContent = `
            .jellyseerr-refresh-btn:focus { outline: none; }
            .jellyseerr-refresh-icon { color: #fff; filter: opacity(0.6); }
            .jellyseerr-refresh-btn:hover .jellyseerr-refresh-icon { color: #fff; filter: opacity(0.9); }
        `;
        document2.head.appendChild(style);
      }
      section.appendChild(title);
      const scroller = document2.createElement("div");
      scroller.setAttribute("is", "emby-scroller");
      scroller.className = "padded-top-focusscale padded-bottom-focusscale emby-scroller";
      scroller.dataset.horizontal = "true";
      scroller.dataset.centerfocus = "card";
      const items = document2.createElement("div");
      items.setAttribute("is", "emby-itemscontainer");
      items.className = "focuscontainer-x itemsContainer scrollSlider";
      if (document2.querySelector(".alphaPicker-tv") !== null) items.classList.add("itemsContainer-tv", "animatedScrollX");
      for (const item of results) {
        const card = internals.createJellyseerrCard?.(item, isJellyseerrActive, jellyseerrUserFound);
        if (card) items.appendChild(card);
      }
      scroller.appendChild(items);
      section.appendChild(scroller);
      return section;
    }
    function renderJellyseerrResults(results, query, isJellyseerrOnlyMode, isJellyseerrActive, jellyseerrUserFound) {
      console.log(`${LOG_UI} Rendering results for query: "${query}"`);
      const found = document2.querySelector("#searchPage");
      if (!found) {
        console.warn(`${LOG_UI} #searchPage not found. Cannot render results.`);
        return;
      }
      const searchPage = found;
      pendingRepositionObserver?.disconnect();
      pendingRepositionObserver = null;
      if (pendingRepositionTimeout !== null) window2.clearTimeout(pendingRepositionTimeout);
      pendingRepositionTimeout = null;
      searchPage.querySelectorAll(".jellyseerr-section").forEach((section) => section.remove());
      const sectionToInject = createJellyseerrSection(results, isJellyseerrOnlyMode, isJellyseerrActive, jellyseerrUserFound);
      const cardType = (el) => {
        const typed = el?.querySelector("[data-type]");
        return typed instanceof HTMLElement ? typed.dataset.type?.toLowerCase() : void 0;
      };
      const findLastPrimarySection = () => {
        const sections = [...searchPage.querySelectorAll(".verticalSection:not(.jellyseerr-section)")];
        for (let i = sections.length - 1; i >= 0; i--) {
          const type = cardType(sections[i] ?? null);
          if (type && PRIMARY_CARD_TYPES.includes(type)) return sections[i] ?? null;
        }
        return null;
      };
      const isPrimarySection = (el) => {
        if (!el || !el.classList.contains("verticalSection")) return false;
        const type = cardType(el);
        return !!type && PRIMARY_CARD_TYPES.includes(type);
      };
      const isNoResultsMessageShown = (el) => {
        if (el.style.display === "none") return false;
        if (el.classList.contains("jellyseerr-native-message-hidden") || el.classList.contains("section-hidden")) return true;
        return getComputedStyle(el).display !== "none";
      };
      function positionSection() {
        const noResultsMessage = [...searchPage.querySelectorAll(".noItemsMessage:not(.jellyseerr-no-results-message)")].find(isNoResultsMessageShown);
        if (noResultsMessage) {
          noResultsMessage.classList.add("jellyseerr-native-message-hidden");
          let message = searchPage.querySelector(".jellyseerr-no-results-message");
          if (!message) {
            message = document2.createElement("div");
            message.className = "noItemsMessage centerMessage jellyseerr-no-results-message";
          }
          const desiredText = JE.t("jellyseerr_no_results_jellyfin", { query });
          if (message.textContent !== desiredText) message.textContent = desiredText;
          if (message.previousElementSibling !== noResultsMessage) noResultsMessage.parentElement?.insertBefore(message, noResultsMessage.nextSibling);
          if (sectionToInject.previousElementSibling !== message) message.parentElement?.insertBefore(sectionToInject, message.nextSibling);
          return true;
        }
        searchPage.querySelectorAll(".jellyseerr-no-results-message").forEach((el) => el.remove());
        searchPage.querySelectorAll(".jellyseerr-native-message-hidden").forEach((el) => el.classList.remove("jellyseerr-native-message-hidden"));
        const lastPrimary = findLastPrimarySection();
        if (lastPrimary) {
          if (!isPrimarySection(sectionToInject.previousElementSibling)) lastPrimary.after(sectionToInject);
          return true;
        }
        const resultsContainer = searchPage.querySelector('.searchResults, [class*="searchResults"], .padded-top.padded-bottom-page');
        if (resultsContainer) {
          if (sectionToInject.parentElement !== resultsContainer || resultsContainer.lastElementChild !== sectionToInject) resultsContainer.appendChild(sectionToInject);
        } else if (searchPage.lastElementChild !== sectionToInject) {
          searchPage.appendChild(sectionToInject);
        }
        return false;
      }
      positionSection();
      const observer = new MutationObserver((records) => {
        if (!sectionToInject.isConnected) {
          observer.disconnect();
          return;
        }
        if (records.every((record) => sectionToInject.contains(record.target))) return;
        positionSection();
      });
      observer.observe(searchPage, { childList: true, subtree: true });
      pendingRepositionObserver = observer;
      pendingRepositionTimeout = window2.setTimeout(() => observer.disconnect(), 5e3);
    }
    function updateJellyseerrResults(newResults, isJellyseerrActive, jellyseerrUserFound, container = document2) {
      const buttons = container.querySelectorAll(".jellyseerr-request-button[data-tmdb-id]");
      for (const button of buttons) {
        const tmdbId = button.dataset.tmdbId;
        const mediaType = button.dataset.mediaType;
        const newItem = newResults.find((item) => String(item.id) === tmdbId && item.mediaType === mediaType);
        if (!newItem || !tmdbId) continue;
        const oldJson = button.dataset.searchResultItem;
        if (!oldJson) continue;
        let oldMediaInfo;
        try {
          const old = JSON.parse(oldJson);
          oldMediaInfo = export19(old) ? old.mediaInfo : void 0;
        } catch {
          continue;
        }
        if (JSON.stringify(oldMediaInfo) === JSON.stringify(newItem.mediaInfo)) continue;
        console.log(`${LOG_UI} Status change detected for TMDB ID ${tmdbId}. Updating button.`);
        internals.configureRequestButton?.(button, newItem, isJellyseerrActive, jellyseerrUserFound);
        const popover = state.jellyseerrHoverPopover;
        if (popover?.classList.contains("show") && popover.dataset.tmdbId === tmdbId) {
          console.log(`${LOG_UI} Active popover found for TMDB ID ${tmdbId}. Refreshing content.`);
          const content = internals.fillHoverPopover?.(newItem);
          if (content) internals.positionHoverPopover?.(content, parseFloat(popover.dataset.clientX || ""), parseFloat(popover.dataset.clientY || ""));
          else ui.hideHoverPopover?.();
        }
      }
    }
    ui.updateJellyseerrIcon = updateJellyseerrIcon;
    ui.clearInjectedSearchResults = clearInjectedSearchResults;
    ui.renderJellyseerrResults = renderJellyseerrResults;
    ui.updateJellyseerrResults = updateJellyseerrResults;
    internals.markCardRequested = markCardRequested;
    internals.analyzeSeasonStatuses = (seasons) => export0(seasons, JE.t);
    internals.createJellyseerrSection = createJellyseerrSection;
  }

  // client/src/features/seerr/core/ui/results-entry.ts
  installResults(seerrCoreHost());
})();
})();
//# sourceMappingURL=ui-results.js.map
