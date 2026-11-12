(() => {
"use strict";
(() => {
  // client/src/features/seerr/host-discovery.ts
  function discoveryHost() {
    const host = window;
    const JE = host.JellyfinEnhanced ?? (host.JellyfinEnhanced = {});
    return { JE, api: () => host.ApiClient };
  }
  function filterOf(JE) {
    if (!JE.discoveryFilter) throw new Error("Discovery filter utilities are not loaded");
    return JE.discoveryFilter;
  }
  function baseOf(JE) {
    if (!JE.discoveryBase) throw new Error("Discovery base is not loaded");
    return JE.discoveryBase;
  }

  // client/src/features/seerr/discovery/domain.ts
  var MEDIA_AVAILABLE = 5;
  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function isSeerrResult(value) {
    return isRecord(value);
  }
  function isAbortError(error) {
    return isRecord(error) && error.name === "AbortError";
  }
  function abortError(message = "Aborted") {
    const error = new Error(message);
    error.name = "AbortError";
    return error;
  }
  function throwIfAborted(signal) {
    if (signal?.aborted) throw abortError();
  }
  var text = (value) => typeof value === "string" ? value : "";
  function mediaInfoOf(item) {
    return isRecord(item.mediaInfo) ? item.mediaInfo : null;
  }
  function decodeNamedInfo(value) {
    if (!isRecord(value) || typeof value.name !== "string") return null;
    const id = value.tmdbId;
    return { name: value.name, tmdbId: typeof id === "string" ? id : typeof id === "number" ? String(id) : null };
  }
  function positiveInt(value) {
    const parsed = typeof value === "number" ? value : typeof value === "string" ? parseInt(value, 10) : NaN;
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }
  function isUserActive(status) {
    return isRecord(status) && !!status.active;
  }
  function hasItemType(item, type) {
    return isRecord(item) && item.Type === type;
  }
  function decodeCollection(value) {
    if (!isRecord(value) || !Array.isArray(value.parts)) return null;
    const parts = value.parts.filter(isSeerrResult);
    const missing = parts.map((movie) => ({ ...movie, mediaType: movie.mediaType || "movie" })).filter((movie) => (mediaInfoOf(movie)?.status || 1) !== MEDIA_AVAILABLE).sort((a, b) => text(a.releaseDate).localeCompare(text(b.releaseDate)));
    return { parts, missing };
  }

  // client/src/features/seerr/discovery/lookups.ts
  function managedFetch(JE, prefix) {
    return (path, options) => filterOf(JE).fetchWithManagedRequest(path, prefix, options);
  }
  async function isItemType(JE, itemId, type, signal) {
    try {
      throwIfAborted(signal);
      const client = discoveryHost().api();
      const item = JE.helpers?.getItemCached ? await JE.helpers.getItemCached(itemId) : await client?.getItem?.(client.getCurrentUserId(), itemId);
      throwIfAborted(signal);
      return hasItemType(item, type);
    } catch (error) {
      if (isAbortError(error)) throw error;
      return false;
    }
  }
  async function tolerant(signal, fetch) {
    try {
      throwIfAborted(signal);
      const value = await fetch();
      throwIfAborted(signal);
      return value;
    } catch (error) {
      if (isAbortError(error)) throw error;
      return null;
    }
  }

  // client/src/features/seerr/discovery/say.ts
  function createSay(JE) {
    return (key, fallback, values) => {
      const text2 = typeof JE.t === "function" ? JE.t(key, values) : "";
      let said = text2 && text2 !== key ? text2 : fallback;
      for (const [name, value] of Object.entries(values ?? {})) said = said.replace(`{${name}}`, () => String(value));
      return said;
    };
  }

  // client/src/features/seerr/discovery/collection-discovery.ts
  var logPrefix = "🪼 Jellyfin Enhanced: Collection Discovery:";
  var SECTION_CLASS = "jellyseerr-collection-discovery-section";
  function createSectionContainer(JE, title, goTo) {
    const header = document.createElement("div");
    header.className = "jellyseerr-discovery-header";
    header.setAttribute("data-jump-label", goTo);
    const heading = document.createElement("h2");
    heading.className = "sectionTitle sectionTitle-cards";
    heading.textContent = title;
    header.appendChild(heading);
    if (JE.discoverySection?.buildSection) return JE.discoverySection.buildSection({ key: "collection", page: "detail", header });
    const section = document.createElement("div");
    section.className = `verticalSection ${SECTION_CLASS} jellyseerr-discovery-section detailVerticalSection`;
    section.setAttribute("data-jellyseerr-collection-discovery", "true");
    section.appendChild(header);
    const itemsContainer = document.createElement("div");
    itemsContainer.setAttribute("is", "emby-itemscontainer");
    itemsContainer.className = "itemsContainer vertical-wrap";
    section.appendChild(itemsContainer);
    return section;
  }
  function start(JE) {
    const base = baseOf(JE);
    const fetchManaged = managedFetch(JE, "collection");
    const label = createSay(JE);
    const boxsetCache = /* @__PURE__ */ new Map();
    function getBoxSetInfo(boxsetId, signal) {
      const cached = boxsetCache.get(boxsetId);
      if (cached) return Promise.resolve(cached);
      return tolerant(signal, async () => {
        const info = decodeNamedInfo(await fetchManaged(`/JellyfinEnhanced/boxset/${boxsetId}`, { signal }));
        if (info && !signal.aborted) boxsetCache.set(boxsetId, info);
        return info;
      });
    }
    async function renderMissing({ id: itemId, signal, waitForPageReady }, pageWait) {
      const isBoxSet = await isItemType(JE, itemId, "BoxSet", signal);
      if (signal.aborted || !isBoxSet) return void 0;
      const boxsetPromise = getBoxSetInfo(itemId, signal);
      const statusPromise = JE.jellyseerrAPI?.checkUserStatus?.();
      const pageReadyPromise = waitForPageReady(pageWait);
      const [boxset, status] = await Promise.all([boxsetPromise, statusPromise]);
      if (signal.aborted) return void 0;
      if (!isUserActive(status) || !boxset?.tmdbId) {
        if (!boxset?.tmdbId) console.debug(`${logPrefix} No TMDB collection ID for BoxSet ${itemId}`);
        return void 0;
      }
      const collectionId = positiveInt(boxset.tmdbId);
      if (!collectionId) return void 0;
      const collection = decodeCollection(await JE.jellyseerrAPI?.fetchCollectionDetails?.(collectionId));
      if (signal.aborted) return void 0;
      if (!collection || collection.parts.length === 0) {
        console.debug(`${logPrefix} No parts found in collection ${collectionId}`);
        return void 0;
      }
      const { parts, missing } = collection;
      if (missing.length === 0) {
        console.debug(`${logPrefix} All movies in collection ${boxset.name} are available`);
        return void 0;
      }
      const detailSection = await pageReadyPromise;
      if (signal.aborted) return void 0;
      if (!detailSection) {
        console.debug(`${logPrefix} Could not find detail section to insert into`);
        return void 0;
      }
      document.querySelector(`.${SECTION_CLASS}`)?.remove();
      const available = parts.length - missing.length;
      const title = label(
        "discovery_missing_from_collection",
        "Missing from {collection} ({available}/{total})",
        { collection: boxset.name, available, total: parts.length }
      );
      const section = createSectionContainer(JE, title, label("discovery_go_to", "Go to {title}", { title }));
      const fragment = filterOf(JE).createCardsFragment(missing, { cardClass: "overflowPortraitCard" });
      const itemsContainer = section.querySelector(".itemsContainer");
      if (!itemsContainer || fragment.childNodes.length === 0) {
        console.debug(`${logPrefix} No cards created from missing movies`);
        return void 0;
      }
      itemsContainer.appendChild(fragment);
      if (JE.discoverySection?.placeSection) JE.discoverySection.placeSection(detailSection, section, "detail");
      else detailSection.appendChild(section);
      console.debug(`${logPrefix} Section added with ${missing.length} missing movies from ${boxset.name}`);
      return true;
    }
    async function renderCollectionDiscovery(context) {
      const pageWait = new AbortController();
      context.signal.addEventListener("abort", () => pageWait.abort(), { once: true, signal: pageWait.signal });
      try {
        return await renderMissing(context, pageWait.signal);
      } finally {
        pageWait.abort();
      }
    }
    base.createDiscovery({
      key: "collection",
      mode: "one-shot",
      logLabel: "Collection Discovery",
      configKey: "JellyseerrShowCollectionDiscovery",
      getIdFromUrl: base.idFromDetailUrl,
      renderOneShot: renderCollectionDiscovery,
      onCleanup: () => boxsetCache.clear()
    }).start();
  }
  (function() {
    "use strict";
    start(discoveryHost().JE);
  })();
})();
})();
//# sourceMappingURL=collection-discovery.js.map
