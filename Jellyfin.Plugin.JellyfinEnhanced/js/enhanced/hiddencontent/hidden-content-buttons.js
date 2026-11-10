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

  // client/src/features/hidden-content/host.ts
  var browser = window;
  if (!browser.JellyfinEnhanced || !browser.ApiClient) throw new Error("Hidden Content host unavailable");
  var host = { JellyfinEnhanced: browser.JellyfinEnhanced, Dashboard: browser.Dashboard, Emby: browser.Emby };
  function getApi() {
    const api = browser.ApiClient;
    if (!api) throw new Error("Hidden Content API unavailable");
    return api;
  }
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
  function lease(JE, view = false) {
    JE.session?.checkNow?.("hidden-content-operation");
    const state = runtime(JE), version = state.view, api = getApi();
    const epoch = JE.session?.getEpoch(), userId = api.getCurrentUserId(), root = api.getUrl("/"), token = api.accessToken?.(), route = location.hash;
    return { api, destination: JSON.stringify([root, userId]), current: () => {
      try {
        return browser.ApiClient === api && (epoch === void 0 || JE.session?.isCurrent(epoch) === true) && api.getCurrentUserId() === userId && api.getUrl("/") === root && api.accessToken?.() === token && (!view || location.hash === route && state.view === version);
      } catch {
        return false;
      }
    } };
  }

  // client/generated-shared/stub/client/src/features/hidden-content/model.ts
  var shared = /* @__PURE__ */ sharedModule("features/hidden-content/model");
  var export3 = /* @__PURE__ */ sharedExport(shared, "decodeLibraryItem");

  // client/src/features/hidden-content/hidden-content-buttons.ts
  (function(JE) {
    if (!installOnce(JE, "hidden-content-buttons")) return;
    "use strict";
    const internal = registry(JE, "hiddenContent");
    const { hiddenIdSet, getSettings, hideItem, unhideItem, getCardSurface, getCardItemId, confirmAndHide } = internal;
    function createLibraryHideButton(cardBox, card, itemId, isPerson) {
      cardBox.style.position = "relative";
      const btn = document.createElement("button");
      const hideLabel = JE.t("hidden_content_hide_button") !== "hidden_content_hide_button" ? JE.t("hidden_content_hide_button") : "Hide";
      const hiddenLabel = JE.t("hidden_content_already_hidden") !== "hidden_content_already_hidden" ? JE.t("hidden_content_already_hidden") : "Hidden";
      const unhideLabel = JE.t("hidden_content_unhide") !== "hidden_content_unhide" ? JE.t("hidden_content_unhide") : "Unhide";
      function renderIcon(iconName) {
        btn.replaceChildren();
        const icon = document.createElement("span");
        icon.className = "material-icons";
        icon.setAttribute("aria-hidden", "true");
        icon.textContent = iconName || "visibility";
        btn.appendChild(icon);
      }
      function setHiddenState() {
        btn.className = "je-hide-btn je-already-hidden";
        btn.title = hiddenLabel;
        renderIcon("visibility_off");
        btn.onmouseenter = () => {
          btn.title = unhideLabel;
        };
        btn.onmouseleave = () => {
          btn.title = hiddenLabel;
        };
        btn.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          unhideItem(itemId);
          setHideState();
        };
      }
      function setHideState() {
        btn.className = "je-hide-btn";
        btn.title = hideLabel;
        renderIcon("visibility");
        btn.onmouseenter = null;
        btn.onmouseleave = null;
        btn.onclick = async (e) => {
          e.preventDefault();
          e.stopPropagation();
          const cardName = card.querySelector(".cardText")?.textContent || "";
          const surface = getCardSurface(card);
          if (surface === "nextup" || surface === "continuewatching") {
            await handleScopedCardHide(card, itemId, cardName, surface, setHiddenState);
          } else {
            const itemData = { itemId, name: cardName };
            if (isPerson) itemData.type = "Person";
            confirmAndHide(itemData, () => {
              card.classList.add("je-hidden");
            });
          }
        };
      }
      if (hiddenIdSet.has(itemId)) {
        setHiddenState();
      } else {
        setHideState();
      }
      cardBox.appendChild(btn);
    }
    async function handleScopedCardHide(card, itemId, cardName, surface, setHiddenState) {
      const token = lease(JE, true), api = token.api;
      const itemData = { itemId, name: cardName };
      const dialogOpts = { surface };
      try {
        const userId = api.getCurrentUserId();
        const item = export3(JE.helpers?.getItemCached ? await JE.helpers.getItemCached(itemId, { userId }) : await api.getItem(userId, itemId));
        if (!token.current() || !card.isConnected) return;
        const itemType = item?.Type || "";
        const seriesId = item?.SeriesId || "";
        const seriesName = item?.SeriesName || "";
        itemData.type = itemType;
        itemData.name = item?.Name || cardName;
        itemData.seriesId = seriesId;
        itemData.seriesName = seriesName;
        itemData.seasonNumber = item?.ParentIndexNumber != null ? item.ParentIndexNumber : null;
        itemData.episodeNumber = item?.IndexNumber != null ? item.IndexNumber : null;
        itemData.tmdbId = item?.ProviderIds?.Tmdb || "";
        if ((itemType === "Episode" || itemType === "Season") && seriesId) {
          dialogOpts.showEpisodeChoice = true;
          dialogOpts.onChooseScoped = () => {
            hideItem({ ...itemData, hideScope: surface });
            card.classList.add("je-hidden");
          };
          dialogOpts.onChooseShow = async () => {
            if (!token.current() || !card.isConnected) return;
            let seriesTmdbId = "";
            try {
              const series = export3(JE.helpers?.getItemCached ? await JE.helpers.getItemCached(seriesId, { userId }) : await api.getItem(userId, seriesId));
              if (!token.current() || !card.isConnected) return;
              seriesTmdbId = series?.ProviderIds?.Tmdb || "";
            } catch (err) {
              console.warn("🪼 Jellyfin Enhanced: Failed to fetch series TMDB ID", err);
            }
            if (!token.current() || !card.isConnected) return;
            hideItem({
              itemId: seriesId,
              name: seriesName || cardName,
              type: "Series",
              tmdbId: seriesTmdbId
            });
            card.classList.add("je-hidden");
          };
        } else {
          dialogOpts.onChooseScoped = () => {
            hideItem({ ...itemData, hideScope: surface });
            card.classList.add("je-hidden");
          };
        }
      } catch (err) {
        console.warn("🪼 Jellyfin Enhanced: Failed to fetch item data for scoped hide", err);
        dialogOpts.onChooseScoped = () => {
          hideItem({ itemId, name: cardName, hideScope: surface });
          card.classList.add("je-hidden");
        };
      }
      if (!token.current() || !card.isConnected) return;
      confirmAndHide(itemData, () => {
        card.classList.add("je-hidden");
      }, dialogOpts);
    }
    function addLibraryHideButtons() {
      const s = getSettings();
      if (!s.enabled || !s.showHideButtons) return;
      if (!s.showButtonLibrary && !s.showButtonCast) return;
      const skipCollections = !s.experimentalHideCollections;
      const cards = document.querySelectorAll(".card[data-id] .cardBox, .card[data-itemid] .cardBox");
      for (const cardBox of cards) {
        if (cardBox.querySelector(".je-hide-btn")) continue;
        const card = cardBox.closest(".card");
        if (!card) continue;
        if (card.hasAttribute("data-imagetype") || card.closest(".formDialog, .editPageInnerContent")) continue;
        if (card.closest("#itemDetailPage") && card.querySelector(".chapterCardImageContainer")) continue;
        const itemId = getCardItemId(card);
        if (!itemId) continue;
        const cardType = (card.dataset.type || "").toLowerCase();
        const isPerson = cardType === "person" || card.classList.contains("personCard");
        if (isPerson && !s.showButtonCast) continue;
        if (!isPerson && !s.showButtonLibrary) continue;
        if (skipCollections && !isPerson) {
          if (cardType === "collectionfolder" || cardType === "userview" || cardType === "boxset" || cardType === "playlist" || cardType === "channel") continue;
          const section = card.closest(".section, .verticalSection, .homeSection");
          if (section) {
            const sTitle = (section.querySelector(".sectionTitle, h2, .headerText, .sectionTitle-sectionTitle")?.textContent || "").toLowerCase();
            if (sTitle.includes("my media") || sTitle.includes("collections")) continue;
          }
        }
        createLibraryHideButton(cardBox, card, itemId, isPerson);
      }
    }
    function removeLibraryHideButtons() {
      const btns = document.querySelectorAll(".card[data-id] .je-hide-btn, .card[data-itemid] .je-hide-btn");
      for (const btn of btns) {
        btn.remove();
      }
    }
    Object.assign(internal, { addLibraryHideButtons, removeLibraryHideButtons });
  })(host.JellyfinEnhanced);
})();
})();
//# sourceMappingURL=hidden-content-buttons.js.map
