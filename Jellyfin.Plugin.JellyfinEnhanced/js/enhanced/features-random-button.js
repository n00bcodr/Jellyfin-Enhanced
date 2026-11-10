(() => {
"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };

  // client/src/host/context.ts
  function featureContext(feature, core, slots) {
    const shared = core.core?.featureContext;
    if (typeof shared !== "function") {
      throw new Error(`${feature}: JE.core.featureContext is missing; core/ui-kit.js must load before feature scripts`);
    }
    return shared(feature, core, slots);
  }
  function publishSharedModules(modules) {
    const JE2 = window.JellyfinEnhanced;
    if (!JE2) return;
    const core = JE2.core ?? (JE2.core = {});
    let registry = core.sharedModules;
    if (!registry) {
      registry = /* @__PURE__ */ Object.create(null);
      Object.defineProperty(core, "sharedModules", { value: registry, configurable: true, writable: true, enumerable: false });
    }
    for (const [id, namespace] of Object.entries(modules)) registry[id] ?? (registry[id] = namespace);
  }

  // client/src/features/details-providers/wire.ts
  var wire_exports = {};
  __export(wire_exports, {
    bool: () => bool,
    decodeDetailsItem: () => decodeDetailsItem,
    decodeItems: () => decodeItems,
    errorMessage: () => errorMessage,
    errorShape: () => errorShape,
    field: () => field,
    int: () => int,
    isRecord: () => isRecord,
    list: () => list,
    num: () => num,
    providerId: () => providerId,
    str: () => str,
    stringList: () => stringList,
    text: () => text
  });
  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function field(value, key) {
    return isRecord(value) ? value[key] : void 0;
  }
  function str(value) {
    return typeof value === "string" ? value : void 0;
  }
  function text(value) {
    return typeof value === "string" && value !== "" ? value : void 0;
  }
  function num(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : void 0;
  }
  function int(value) {
    return typeof value === "number" && Number.isInteger(value) ? value : void 0;
  }
  function bool(value) {
    return typeof value === "boolean" ? value : void 0;
  }
  function list(value) {
    return Array.isArray(value) ? value : [];
  }
  function stringList(value) {
    return list(value).filter((entry) => typeof entry === "string");
  }
  function providerId(value) {
    if (typeof value === "string") return value || void 0;
    if (typeof value === "number" && Number.isFinite(value) && value !== 0) return String(value);
    return void 0;
  }
  function decodeProviderIds(value) {
    const ids = {};
    if (!isRecord(value)) return ids;
    const tmdb = providerId(value.Tmdb), imdb = providerId(value.Imdb), tvdb = providerId(value.Tvdb);
    const aniList = providerId(value.AniList), anilist = providerId(value.Anilist);
    if (tmdb !== void 0) ids.Tmdb = tmdb;
    if (imdb !== void 0) ids.Imdb = imdb;
    if (tvdb !== void 0) ids.Tvdb = tvdb;
    if (aniList !== void 0) ids.AniList = aniList;
    if (anilist !== void 0) ids.Anilist = anilist;
    return ids;
  }
  function decodeStreams(value) {
    if (!Array.isArray(value)) return void 0;
    return value.filter(isRecord).map((stream) => {
      const result = {};
      const type = str(stream.Type), language = str(stream.Language);
      if (type !== void 0) result.Type = type;
      if (language !== void 0) result.Language = language;
      return result;
    });
  }
  function decodeSources(value) {
    if (!Array.isArray(value)) return void 0;
    return value.map((source) => {
      const result = {};
      const id = str(field(source, "Id")), streams = decodeStreams(field(source, "MediaStreams"));
      if (id !== void 0) result.Id = id;
      if (streams !== void 0) result.MediaStreams = streams;
      return result;
    });
  }
  function set(item, key, value) {
    if (value !== void 0) item[key] = value;
  }
  function decodeDetailsItem(value) {
    if (!isRecord(value)) return null;
    const item = { ProviderIds: decodeProviderIds(value.ProviderIds), SeriesProviderIds: decodeProviderIds(value.SeriesProviderIds) };
    set(item, "Id", str(value.Id));
    set(item, "Type", str(value.Type));
    set(item, "Name", str(value.Name));
    set(item, "SeriesId", str(value.SeriesId));
    set(item, "SeriesName", str(value.SeriesName));
    set(item, "IndexNumber", num(value.IndexNumber));
    set(item, "ParentIndexNumber", num(value.ParentIndexNumber));
    set(item, "PremiereDate", str(value.PremiereDate));
    set(item, "DisplayOrder", str(value.DisplayOrder));
    set(item, "MediaSources", decodeSources(value.MediaSources));
    set(item, "MediaStreams", decodeStreams(value.MediaStreams));
    set(item, "FirstEpisodeId", str(field(value.FirstEpisode, "Id")));
    if (Array.isArray(value.Tags)) item.Tags = stringList(value.Tags);
    const userData = value.UserData;
    set(item, "Played", bool(field(userData, "Played")));
    set(item, "UnplayedItemCount", num(field(userData, "UnplayedItemCount")));
    return item;
  }
  function decodeItems(value) {
    return list(field(value, "Items")).map(decodeDetailsItem).filter((item) => item !== null);
  }
  function errorShape(error) {
    const shape = {};
    const status = num(field(error, "status")), message = str(field(error, "message"));
    const json = field(error, "responseJSON");
    const code = str(field(json, "code")), responseMessage = str(field(json, "message"));
    const retry = num(field(json, "retryAfterSeconds"));
    if (status !== void 0) shape.status = status;
    if (message !== void 0) shape.message = message;
    if (code !== void 0) shape.responseCode = code;
    if (responseMessage !== void 0) shape.responseMessage = responseMessage;
    if (retry !== void 0) shape.retryAfterSeconds = retry;
    return shape;
  }
  function errorMessage(error) {
    return errorShape(error).message || "";
  }

  // client/src/features/details-providers/page.ts
  var page_exports = {};
  __export(page_exports, {
    detailPageHook: () => detailPageHook,
    detailsLease: () => detailsLease,
    firstMatch: () => firstMatch,
    hashItemId: () => hashItemId,
    insertAfter: () => insertAfter,
    insertBefore: () => insertBefore,
    isDetailHook: () => isDetailHook,
    lookupDetailsItem: () => lookupDetailsItem,
    lookupItem: () => lookupItem,
    removeFirst: () => removeFirst,
    sessionLease: () => sessionLease,
    visibleDetailPage: () => visibleDetailPage
  });

  // client/src/features/details-providers/host.ts
  var host_exports = {};
  __export(host_exports, {
    api: () => api,
    bridge: () => bridge,
    browserTranslator: () => browserTranslator,
    currentUserId: () => currentUserId,
    dashboard: () => dashboard,
    detailsContext: () => detailsContext,
    embyPage: () => embyPage,
    hasApi: () => hasApi,
    optionalBridge: () => optionalBridge,
    serverId: () => serverId
  });
  function hostWindow() {
    return window;
  }
  function bridge(feature) {
    const host = window;
    const JE2 = host.JellyfinEnhanced;
    if (!JE2) throw new Error(`${feature} loaded before Jellyfin Enhanced`);
    return JE2;
  }
  function optionalBridge() {
    const host = window;
    return host.JellyfinEnhanced;
  }
  function api() {
    const client = hostWindow().ApiClient;
    if (!client) throw new Error("Jellyfin ApiClient unavailable");
    return client;
  }
  function hasApi() {
    return hostWindow().ApiClient !== void 0;
  }
  function currentUserId() {
    const id = hostWindow().ApiClient?.getCurrentUserId();
    return typeof id === "string" && id ? id : null;
  }
  function serverId() {
    const id = api().serverId();
    return typeof id === "string" ? id : "";
  }
  function dashboard() {
    return hostWindow().Dashboard;
  }
  function embyPage() {
    return hostWindow().Emby?.Page;
  }
  function browserTranslator() {
    return hostWindow().Translator;
  }
  function detailsContext(JE2) {
    const holder = JE2;
    return featureContext("details-providers", JE2, {
      internalSlots: ["features"],
      internalsObject: () => holder.internals ?? (holder.internals = {})
    });
  }

  // client/src/features/details-providers/page.ts
  function hashItemId(hash = window.location.hash) {
    try {
      return new URLSearchParams(hash.split("?")[1] ?? "").get("id");
    } catch {
      return null;
    }
  }
  function visibleDetailPage() {
    return document.querySelector("#itemDetailPage:not(.hide)");
  }
  function lookupItem(helpers, itemId, withUser, userId = currentUserId()) {
    if (helpers?.getItemCached) {
      return withUser ? helpers.getItemCached(itemId, { userId }) : helpers.getItemCached(itemId);
    }
    return api().getItem(userId, itemId);
  }
  async function lookupDetailsItem(helpers, itemId, withUser, userId = currentUserId()) {
    return decodeDetailsItem(await lookupItem(helpers, itemId, withUser, userId));
  }
  function detailsLease(session, itemId, page) {
    const sameSession = sessionLease(session);
    return {
      itemId,
      page,
      current: () => sameSession() && hashItemId() === itemId && page.isConnected && visibleDetailPage() === page
    };
  }
  function sessionLease(session) {
    const epoch = session?.getEpoch();
    const userId = currentUserId();
    const client = api();
    const root = client.getUrl("/");
    const token = client.accessToken();
    return () => hasApi() && api() === client && client.getUrl("/") === root && client.accessToken() === token && (!session || epoch === void 0 || session.isCurrent(epoch)) && currentUserId() === userId;
  }
  function isDetailHook(element, hash) {
    const hasItemId = window.location.hash.includes("id=") || typeof hash === "string" && hash.includes("id=");
    const isItemDetailElement = !!element && (element.id === "itemDetailPage" || element.classList.contains("itemDetailPage"));
    return hasItemId || isItemDetailElement;
  }
  function detailPageHook(enabled, unregister, process, retry) {
    return async (_view, element, hash) => {
      if (!enabled()) {
        unregister();
        return;
      }
      if (!isDetailHook(element, hash)) return;
      await new Promise((resolve) => setTimeout(resolve, 150));
      const page = visibleDetailPage();
      if (page) {
        process(page);
      } else if (retry) {
        setTimeout(() => {
          const retryPage = visibleDetailPage();
          if (retryPage) process(retryPage);
        }, 500);
      }
    };
  }
  function insertAfter(anchor, node) {
    const parent = anchor.parentNode;
    if (!parent) return false;
    parent.insertBefore(node, anchor.nextSibling);
    return true;
  }
  function insertBefore(anchor, node) {
    const parent = anchor.parentNode;
    if (!parent) return false;
    parent.insertBefore(node, anchor);
    return true;
  }
  function firstMatch(root, selectors) {
    for (const selector of selectors) {
      const found = root.querySelector(selector);
      if (found) return found;
    }
    return null;
  }
  function removeFirst(page, selector) {
    const root = page || visibleDetailPage() || document;
    const section = root.querySelector(selector);
    section?.parentNode?.removeChild(section);
  }

  // client/generated-shared/publish/js/enhanced/features-random-button.js.ts
  publishSharedModules({ "features/details-providers/wire": wire_exports, "features/details-providers/page": page_exports, "features/details-providers/host": host_exports });

  // client/src/features/details-providers/random-domain.ts
  var DICE_FACES = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="je-dice-icon"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><path d="M12 12h.01"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="je-dice-icon"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><path d="M15 9h.01"/><path d="M9 15h.01"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="je-dice-icon"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><path d="M16 8h.01"/><path d="M12 12h.01"/><path d="M8 16h.01"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="je-dice-icon"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><path d="M16 8h.01"/><path d="M8 8h.01"/><path d="M8 16h.01"/><path d="M16 16h.01"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="je-dice-icon"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><path d="M16 8h.01"/><path d="M8 8h.01"/><path d="M8 16h.01"/><path d="M16 16h.01"/><path d="M12 12h.01"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="je-dice-icon"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><path d="M16 8h.01"/><path d="M16 12h.01"/><path d="M16 16h.01"/><path d="M8 8h.01"/><path d="M8 12h.01"/><path d="M8 16h.01"/></svg>'
  ];
  function randomDiceFace(random2, excludeIndex) {
    let face;
    do {
      face = Math.floor(random2() * DICE_FACES.length);
    } while (face === excludeIndex);
    return face;
  }
  var CONTAINER_TYPES = ["Playlist", "BoxSet"];
  function isContainer(item) {
    return item !== null && item.Type !== void 0 && CONTAINER_TYPES.includes(item.Type);
  }
  function includeItemTypes(settings, inContainer) {
    const types = [];
    if (settings.randomIncludeMovies) types.push("Movie");
    if (settings.randomIncludeShows) types.push("Series", ...inContainer ? ["Episode"] : []);
    return types.join(",");
  }
  function candidatesPath(userId, settings, parentId) {
    const scope = parentId ? `ParentId=${encodeURIComponent(parentId)}` : "Recursive=true";
    return `/Users/${userId}/Items?IncludeItemTypes=${includeItemTypes(settings, !!parentId)}&${scope}&SortBy=Random&Limit=100&Fields=ExternalUrls`;
  }
  function filterUnwatched(settings, items) {
    if (!settings.randomUnwatchedOnly) return items;
    return items.filter((item) => item.Type === "Series" ? (item.UnplayedItemCount ?? 0) > 0 : !item.Played);
  }
  function detailsRoute(itemId, serverId2) {
    return `/details?id=${itemId}${serverId2 ? `&serverId=${serverId2}` : ""}`;
  }

  // client/src/features/details-providers/random-button.ts
  var JE = bridge("Random button");
  var random = () => Math.random();
  var fallbackNotice = null;
  async function fetchItem(itemId) {
    try {
      return await lookupDetailsItem(JE.helpers, itemId, true);
    } catch {
      return null;
    }
  }
  async function resolveSourceContainer() {
    const settings = JE.currentSettings;
    if (settings.randomScopeCurrentContainer && /details/.test(window.location.hash)) {
      const itemId = hashItemId();
      const item = itemId ? await fetchItem(itemId) : null;
      if (isContainer(item)) return item;
    }
    const pinnedId = settings.randomSourceId;
    if (pinnedId) {
      const item = await fetchItem(pinnedId);
      if (isContainer(item)) return item;
      fallbackNotice = JE.t("toast_random_source_missing");
    }
    return null;
  }
  async function fetchCandidates(userId, parentId) {
    const client = api();
    const url = client.getUrl(candidatesPath(userId, JE.currentSettings, parentId));
    return decodeItems(await client.ajax({ type: "GET", url, dataType: "json" }));
  }
  async function getRandomItem() {
    const userId = currentUserId();
    if (!userId) {
      console.error("🪼 Jellyfin Enhanced: User not logged in.");
      return null;
    }
    try {
      const container = await resolveSourceContainer();
      let items = container ? filterUnwatched(JE.currentSettings, await fetchCandidates(userId, container.Id ?? null)) : [];
      if (container && items.length === 0) {
        fallbackNotice = JE.t("toast_random_source_empty", { name: JE.escapeHtml(container.Name ?? "") });
      }
      if (items.length === 0) {
        const libraryItems = await fetchCandidates(userId, null);
        if (libraryItems.length === 0) throw new Error("No items found in selected libraries.");
        items = filterUnwatched(JE.currentSettings, libraryItems);
        if (items.length === 0) throw new Error("No unwatched items found in selected libraries.");
      }
      return items[Math.floor(random() * items.length)] ?? null;
    } catch (error) {
      console.error("🪼 Jellyfin Enhanced: Error fetching random item:", error);
      JE.toast(`${JE.icon(JE.IconName.ERROR)} ${JE.escapeHtml(errorMessage(error) || "Unknown error")}`, 2e3);
      return null;
    }
  }
  function navigateToItem(item) {
    if (item.Id) {
      const page = embyPage();
      if (page && typeof page.show === "function") {
        page.show(detailsRoute(item.Id, serverId()));
      } else {
        const host = dashboard();
        if (host && typeof host.navigate === "function") {
          host.navigate(`details.html?id=${item.Id}`);
        } else {
          window.location.hash = `#!${detailsRoute(item.Id, serverId())}`;
        }
      }
      JE.toast(fallbackNotice || JE.t("toast_random_item_loaded"), fallbackNotice ? 3e3 : 2e3);
      fallbackNotice = null;
    } else {
      console.error("🪼 Jellyfin Enhanced: Invalid item object or ID:", item);
      JE.toast(JE.t("toast_generic_error"), 2e3);
    }
  }
  JE.addRandomButton = () => {
    if (!JE.currentSettings.randomButtonEnabled) {
      document.getElementById("randomItemButtonContainer")?.remove();
      return;
    }
    if (document.getElementById("randomItemButton")) return;
    const headerRight = JE.helpers.getHeaderButtonTray();
    if (!headerRight || document.getElementById("randomItemButton")) return;
    const buttonContainer = document.createElement("div");
    buttonContainer.id = "randomItemButtonContainer";
    const randomButton = document.createElement("button");
    randomButton.id = "randomItemButton";
    randomButton.setAttribute("is", "paper-icon-button-light");
    randomButton.className = "headerButton headerButtonRight paper-icon-button-light";
    randomButton.title = JE.t("random_button_tooltip");
    const headerLabel = JE.t("header_random_item");
    randomButton.dataset.headerLabel = headerLabel === "header_random_item" ? "Random item" : headerLabel;
    const spin = document.createElement("span");
    spin.className = "je-dice-spin";
    const diceFace = document.createElement("span");
    diceFace.className = "je-dice-face";
    spin.appendChild(diceFace);
    randomButton.appendChild(spin);
    let currentFace = randomDiceFace(random);
    diceFace.innerHTML = DICE_FACES[currentFace] ?? "";
    randomButton.addEventListener("click", async () => {
      randomButton.disabled = true;
      randomButton.classList.add("loading");
      fallbackNotice = null;
      const current = sessionLease(JE.session);
      const rollDice = () => {
        currentFace = randomDiceFace(random, currentFace);
        diceFace.innerHTML = DICE_FACES[currentFace] ?? "";
      };
      const rollInterval = setInterval(rollDice, 120);
      try {
        const item = await getRandomItem();
        if (item && current()) navigateToItem(item);
      } finally {
        clearInterval(rollInterval);
        setTimeout(() => {
          if (document.getElementById(randomButton.id)) {
            randomButton.disabled = false;
            randomButton.classList.remove("loading");
            rollDice();
          }
        }, 500);
      }
    });
    buttonContainer.appendChild(randomButton);
    headerRight.prepend(buttonContainer);
  };
})();
})();
//# sourceMappingURL=features-random-button.js.map
