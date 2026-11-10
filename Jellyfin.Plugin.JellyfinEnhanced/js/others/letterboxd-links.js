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

  // client/generated-shared/stub/client/src/features/details-providers/page.ts
  var shared2 = /* @__PURE__ */ sharedModule("features/details-providers/page");
  var export3 = /* @__PURE__ */ sharedExport(shared2, "hashItemId");
  var export8 = /* @__PURE__ */ sharedExport(shared2, "lookupItem");
  var export10 = /* @__PURE__ */ sharedExport(shared2, "sessionLease");
  var export11 = /* @__PURE__ */ sharedExport(shared2, "visibleDetailPage");

  // client/generated-shared/stub/client/src/features/details-providers/links.ts
  var shared3 = /* @__PURE__ */ sharedModule("features/details-providers/links");
  var export0 = /* @__PURE__ */ sharedExport(shared3, "externalLink");
  var export2 = /* @__PURE__ */ sharedExport(shared3, "pathSegment");

  // client/generated-shared/stub/client/src/features/details-providers/wire.ts
  var shared4 = /* @__PURE__ */ sharedModule("features/details-providers/wire");
  var export12 = /* @__PURE__ */ sharedExport(shared4, "decodeDetailsItem");

  // client/src/features/details-providers/letterboxd-links.ts
  var JE = export1("Letterboxd links");
  function personSlug(name) {
    if (!name) return null;
    const slug = name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return slug || null;
  }
  JE.initializeLetterboxdLinksScript = async function initializeLetterboxdLinksScript() {
    const logPrefix = "🪼 Jellyfin Enhanced: Letterboxd Links:";
    if (!JE.pluginConfig?.LetterboxdEnabled) {
      console.log(`${logPrefix} Integration disabled in plugin settings.`);
      return;
    }
    console.log(`${logPrefix} Initializing...`);
    let isAddingLinks = false;
    let rescan = false;
    const processedItemIds = /* @__PURE__ */ new Set();
    let lastVisibleItemId = null;
    JE.session?.onUserChange("letterboxd-links", () => {
      processedItemIds.clear();
      lastVisibleItemId = null;
    });
    const LETTERBOXD_ICON_URL = JE.cdn.selfhst("svg/letterboxd.svg");
    const styleId = "letterboxd-links-styles";
    if (!document.getElementById(styleId)) {
      const style = document.createElement("style");
      style.id = styleId;
      style.textContent = `
                .letterboxd-link-icon::before {
                    content: "";
                    display: inline-block;
                    width: var(--je-icon-size, 25px);
                    height: var(--je-icon-size, 25px);
                    background-image: url(${LETTERBOXD_ICON_URL});
                    background-size: contain;
                    background-repeat: no-repeat;
                    vertical-align: middle;
                    margin-right: 5px;
                }
            `;
      document.head.appendChild(style);
    }
    function createLinkButton(label, url) {
      const button = export0(JE.helpers, url, { title: label });
      if (JE.pluginConfig?.ShowLetterboxdLinkAsText) {
        button.textContent = label;
        button.className = "button-link emby-button letterboxd-link";
      } else {
        button.className = "button-link emby-button letterboxd-link letterboxd-link-icon";
        button.style.setProperty("--je-icon-size", `${JE.helpers.getExternalLinkIconSize()}px`);
      }
      return button;
    }
    async function addLetterboxdLinks() {
      if (isAddingLinks) {
        rescan = true;
        return;
      }
      const visiblePage = export11();
      if (!visiblePage) return;
      const itemId = export3();
      if (!itemId) return;
      if (processedItemIds.has(itemId)) return;
      if (lastVisibleItemId && lastVisibleItemId !== itemId) processedItemIds.clear();
      lastVisibleItemId = itemId;
      const anchorElement = visiblePage.querySelector(".itemExternalLinks");
      document.querySelectorAll("#itemDetailPage.hide .letterboxd-link").forEach((staleLink) => {
        if (staleLink.previousSibling?.nodeType === Node.TEXT_NODE) staleLink.previousSibling.remove();
        staleLink.remove();
      });
      if (!anchorElement || anchorElement.querySelector(".letterboxd-link")) return;
      isAddingLinks = true;
      const session = export10(JE.session);
      try {
        const item = export12(await export8(JE.helpers, itemId, false));
        if (export3() !== itemId || !anchorElement.isConnected || export11() !== visiblePage || !session()) return;
        if (!item?.Type) return;
        if (item.Type !== "Movie" && item.Type !== "Person") {
          console.log(`${logPrefix} Skipping ${item.Type} - Letterboxd links not supported.`);
          processedItemIds.add(itemId);
          return;
        }
        let letterboxdUrl;
        if (item.Type === "Person") {
          const slug = personSlug(item.Name);
          if (!slug) {
            console.log(`${logPrefix} Could not derive a Letterboxd slug for ${item.Name}.`);
            processedItemIds.add(itemId);
            return;
          }
          letterboxdUrl = `https://letterboxd.com/actor/${slug}`;
        } else {
          const imdbId = item.ProviderIds.Imdb;
          if (!imdbId) {
            console.log(`${logPrefix} No IMDb ID found for ${item.Type}.`);
            processedItemIds.add(itemId);
            return;
          }
          letterboxdUrl = `https://letterboxd.com/imdb/${export2(imdbId)}`;
        }
        anchorElement.appendChild(document.createTextNode(" "));
        anchorElement.appendChild(createLinkButton("Letterboxd", letterboxdUrl));
      } catch (err) {
        console.error(`${logPrefix} Error adding Letterboxd link:`, err);
      } finally {
        isAddingLinks = false;
        if (rescan) {
          rescan = false;
          scheduleLetterboxdLinks();
        }
      }
    }
    let processingLetterboxd = false;
    let letterboxdObserver;
    function scheduleLetterboxdLinks() {
      if (!JE.pluginConfig?.LetterboxdEnabled) {
        letterboxdObserver?.disconnect();
        console.log(`${logPrefix} Stopped - feature disabled`);
        return;
      }
      if (processingLetterboxd) return;
      processingLetterboxd = true;
      const run = () => {
        void addLetterboxdLinks();
        processingLetterboxd = false;
      };
      if (typeof requestIdleCallback !== "undefined") requestIdleCallback(run, { timeout: 500 });
      else setTimeout(run, 100);
    }
    letterboxdObserver = JE.helpers.createObserver("letterboxd-links", scheduleLetterboxdLinks, document.body, { childList: true, subtree: true });
    JE.helpers.onViewPage(scheduleLetterboxdLinks);
    if (typeof requestIdleCallback !== "undefined") requestIdleCallback(() => addLetterboxdLinks(), { timeout: 1e3 });
    else setTimeout(() => addLetterboxdLinks(), 500);
    console.log(`${logPrefix} Letterboxd links integration initialized successfully.`);
  };
})();
})();
//# sourceMappingURL=letterboxd-links.js.map
