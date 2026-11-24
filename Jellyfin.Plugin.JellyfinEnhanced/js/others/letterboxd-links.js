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

  // client/src/features/shared/url-domain.ts
  function safeExternalUrl(value, base) {
    try {
      const url = new URL(value, base);
      return ["http:", "https:", "mailto:", "tel:", "ftp:", "blob:"].includes(url.protocol) ? value : "#";
    } catch {
      return "#";
    }
  }

  // client/src/features/shared/dom.ts
  function createCustomElement(tag, is) {
    const create = document.createElement;
    const element = create.call(document, tag, is);
    if (element.getAttribute("is") !== is) element.setAttribute("is", is);
    return element;
  }

  // client/src/features/details-providers/links.ts
  function safeHref(url) {
    return safeExternalUrl(url, window.location.href);
  }
  function externalLink(helpers, url, options = {}) {
    const shared4 = helpers?.createExternalLink;
    if (shared4) return shared4(url, options);
    const anchor = createCustomElement("a", "emby-linkbutton");
    anchor.href = safeHref(url);
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    if (options.title) anchor.title = options.title;
    if (options.className) anchor.className = [anchor.className, options.className].filter(Boolean).join(" ");
    if (options.text) anchor.textContent = options.text;
    if (options.resetStyle) anchor.style.cssText = "padding:0;background:none;border-radius:0;min-width:0;";
    if (typeof options.setup === "function") options.setup(anchor);
    return anchor;
  }
  function pathSegment(id) {
    return encodeURIComponent(id);
  }

  // client/generated-shared/stub/client/src/features/details-providers/wire.ts
  var shared3 = /* @__PURE__ */ sharedModule("features/details-providers/wire");
  var export12 = /* @__PURE__ */ sharedExport(shared3, "decodeDetailsItem");

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
      const button = externalLink(JE.helpers, url, { title: label });
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
          letterboxdUrl = `https://letterboxd.com/imdb/${pathSegment(imdbId)}`;
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
