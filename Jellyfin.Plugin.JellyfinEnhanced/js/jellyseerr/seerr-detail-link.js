(() => {
"use strict";
(() => {
  // client/src/features/seerr/host-details.ts
  function bridge() {
    const host = window;
    if (!host.JellyfinEnhanced) throw new Error("Seerr details loaded before Jellyfin Enhanced");
    return host.JellyfinEnhanced;
  }
  function apiClient() {
    const host = window;
    if (!host.ApiClient) throw new Error("Jellyfin ApiClient unavailable");
    return host.ApiClient;
  }
  function translator(JE2) {
    return (key, fallback = "", params) => {
      const text = params ? JE2.t?.(key, params) : JE2.t?.(key);
      return text || fallback;
    };
  }
  function identityLease(JE2) {
    const epoch = JE2.session?.getEpoch?.();
    return () => epoch === void 0 || typeof JE2.session?.isCurrent !== "function" || JE2.session.isCurrent(epoch);
  }
  var SEERR_LOG = "🪼 Jellyfin Enhanced:";

  // client/src/features/seerr/details/domain/json.ts
  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function record(value) {
    return isRecord(value) ? value : null;
  }

  // client/src/features/seerr/details/domain/links.ts
  function seerrPage(base, mediaType, tmdbId) {
    return `${base}/${mediaType}/${tmdbId}`;
  }

  // client/src/features/seerr/details/seerr-detail-link-entry.ts
  var JE = bridge();
  var t = translator(JE);
  var logPrefix = `${SEERR_LOG} Seerr Detail Link:`;
  var STYLE_ID = "seerr-detail-link-styles";
  function enabled() {
    return !!JE.pluginConfig?.JellyseerrEnabled && !!JE.pluginConfig?.JellyseerrShowDetailPageLink;
  }
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
                .seerr-link-img {
                    width: 25px;
                    height: 25px;
                    display: block;
                    object-fit: contain;
                }
            `;
    document.head.appendChild(style);
  }
  function tmdbIdFromLinks(context) {
    for (const link of context.querySelectorAll(".itemExternalLinks a, .externalIdLinks a")) {
      const { href } = link;
      if (href.includes("themoviedb.org/movie/")) return /\/movie\/(\d+)/.exec(href)?.[1] ?? null;
      if (href.includes("themoviedb.org/tv/")) return /\/tv\/(\d+)/.exec(href)?.[1] ?? null;
    }
    return null;
  }
  function createSeerrLink(tmdbId, mediaType, iconUrl) {
    const useMoreInfoModal = !!JE.pluginConfig?.JellyseerrUseMoreInfoModal || !!JE.core?.ui?.isTvLayout?.();
    const base = JE.jellyseerrAPI?.resolveJellyseerrBaseUrl?.() ?? "";
    const button = document.createElement("a");
    button.setAttribute("is", "emby-linkbutton");
    button.className = "button-link emby-button seerr-link";
    if (JE.pluginConfig?.JellyseerrShowDetailPageLinkAsText) {
      button.textContent = "Seerr";
    } else {
      const image = document.createElement("img");
      image.src = iconUrl;
      image.alt = "Seerr";
      image.className = "seerr-link-img";
      const size = JE.helpers?.getExternalLinkIconSize?.() ?? 18;
      image.style.width = `${size}px`;
      image.style.height = `${size}px`;
      button.appendChild(image);
    }
    const title = t("jellyseerr_card_view_on_jellyseerr", "View on Seerr");
    if (useMoreInfoModal) {
      button.href = "#";
      button.title = title;
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (typeof JE.jellyseerrMoreInfo?.open === "function") void JE.jellyseerrMoreInfo.open(tmdbId, mediaType);
        else console.warn(`${logPrefix} more-info modal not available`);
      });
      return button;
    }
    if (!base) return null;
    button.href = seerrPage(base, mediaType, tmdbId);
    button.target = "_blank";
    button.rel = "noopener noreferrer";
    button.title = title;
    return button;
  }
  function removeStaleLinks() {
    document.querySelectorAll("#itemDetailPage.hide .seerr-link").forEach((stale) => {
      if (stale.previousSibling?.nodeType === Node.TEXT_NODE) stale.previousSibling.remove();
      stale.remove();
    });
  }
  function initializeSeerrDetailLinkScript() {
    if (!enabled()) {
      console.log(`${logPrefix} Disabled in plugin settings.`);
      return;
    }
    console.log(`${logPrefix} Initializing...`);
    const iconUrl = JE.cdn?.selfhst("svg/seerr.svg") ?? "";
    let adding = false;
    let wanted = false;
    let debounceTimer;
    let observer;
    injectStyles();
    async function addSeerrLink() {
      if (adding) {
        wanted = true;
        return;
      }
      const visiblePage = document.querySelector("#itemDetailPage:not(.hide)");
      if (!visiblePage) return;
      const anchor = visiblePage.querySelector(".itemExternalLinks");
      removeStaleLinks();
      if (!anchor || anchor.querySelector(".seerr-link")) return;
      const hashAtStart = window.location.hash;
      const sameAccount = identityLease(JE);
      const stillValid = () => document.contains(anchor) && !anchor.closest("#itemDetailPage.hide") && window.location.hash === hashAtStart && sameAccount();
      adding = true;
      try {
        const itemId = new URLSearchParams(window.location.hash.split("?")[1]).get("id");
        if (!itemId) return;
        const client = apiClient();
        const item = record(JE.helpers?.getItemCached ? await JE.helpers.getItemCached(itemId) : await client.getItem(client.getCurrentUserId() ?? "", itemId));
        if (!stillValid() || anchor.querySelector(".seerr-link")) return;
        if (item?.Type !== "Movie" && item?.Type !== "Series") return;
        const tmdbId = tmdbIdFromLinks(visiblePage);
        if (!tmdbId) return;
        const link = createSeerrLink(tmdbId, item.Type === "Movie" ? "movie" : "tv", iconUrl);
        if (!link) return;
        anchor.appendChild(document.createTextNode(JE.pluginConfig?.JellyseerrShowDetailPageLinkAsText ? ", " : " "));
        anchor.appendChild(link);
      } finally {
        adding = false;
        if (wanted) {
          wanted = false;
          void addSeerrLink();
        }
      }
    }
    observer = JE.helpers?.createObserver?.("seerr-detail-link", () => {
      if (!enabled()) {
        if (observer) {
          observer.disconnect();
          console.log(`${logPrefix} Observer disconnected — feature disabled`);
        }
        return;
      }
      clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => {
        addSeerrLink().catch((error) => console.warn(`${logPrefix} Could not add the link:`, error));
      }, 100);
    }, document.body, { childList: true, subtree: true });
    console.log(`${logPrefix} Initialized successfully`);
  }
  JE.initializeSeerrDetailLinkScript = initializeSeerrDetailLinkScript;
})();
})();
//# sourceMappingURL=seerr-detail-link.js.map
