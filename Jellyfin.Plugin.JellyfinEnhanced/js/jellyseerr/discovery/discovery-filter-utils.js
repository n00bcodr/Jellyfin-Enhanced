(() => {
"use strict";
(() => {
  // client/src/host/context.ts
  function featureContext(feature, core, slots) {
    const shared = core.core?.featureContext;
    if (typeof shared !== "function") {
      throw new Error(`${feature}: JE.core.featureContext is missing; core/ui-kit.js must load before feature scripts`);
    }
    return shared(feature, core, slots);
  }

  // client/src/features/seerr/host-discovery.ts
  function discoveryHost() {
    const host = window;
    const JE = host.JellyfinEnhanced ?? (host.JellyfinEnhanced = {});
    return { JE, api: () => host.ApiClient };
  }
  var discoveryContexts = /* @__PURE__ */ new WeakMap();
  function discoveryContext(JE) {
    let ctx = discoveryContexts.get(JE);
    if (!ctx) {
      ctx = featureContext("seerr", JE, {
        internalSlots: ["recommendationsPage"],
        internalsObject: () => JE.internals ?? (JE.internals = {})
      });
      discoveryContexts.set(JE, ctx);
    }
    return ctx;
  }

  // client/src/features/seerr/discovery/domain.ts
  var FILTER_MODES = { MIXED: "mixed", MOVIES: "movies", TV: "tv" };
  var SORT_OPTIONS = [
    { value: "", label: "Popular" },
    { value: "vote_average.desc", label: "Top Rated" },
    { value: "release_date.desc", label: "Newest" },
    { value: "release_date.asc", label: "Oldest" }
  ];
  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function isFilterMode(value) {
    return value === FILTER_MODES.MIXED || value === FILTER_MODES.MOVIES || value === FILTER_MODES.TV;
  }
  function abortError(message = "Aborted") {
    const error = new Error(message);
    error.name = "AbortError";
    return error;
  }
  function throwIfAborted(signal) {
    if (signal?.aborted) throw abortError();
  }
  function decodeError(what) {
    const error = new Error(`Unexpected ${what} response`);
    error.name = "DecodeError";
    return error;
  }
  function interleaveArrays(first, second) {
    const result = [];
    const left = first[Symbol.iterator]();
    const right = second[Symbol.iterator]();
    for (; ; ) {
      const a = left.next();
      const b = right.next();
      if (a.done && b.done) return result;
      if (!a.done) result.push(a.value);
      if (!b.done) result.push(b.value);
    }
  }
  function filterByMediaType(results, mode) {
    if (mode === FILTER_MODES.MOVIES) return results.filter((item) => item.mediaType === "movie");
    if (mode === FILTER_MODES.TV) return results.filter((item) => item.mediaType === "tv");
    return results;
  }
  function hasBothTypes(tvResults, movieResults) {
    return !!tvResults && tvResults.length > 0 && !!movieResults && movieResults.length > 0;
  }
  function resultHasBothTypes(results) {
    if (!results) return false;
    return results.some((item) => item.mediaType === "movie") && results.some((item) => item.mediaType === "tv");
  }
  function tvSortValue(sort) {
    return sort.replace("release_date", "first_air_date");
  }
  function mediaInfoOf(item) {
    return isRecord(item.mediaInfo) ? item.mediaInfo : null;
  }
  var resultKey = (item) => `${String(item.mediaType)}-${String(item.id)}`;
  function selectCardResults(results, policy) {
    const seen = /* @__PURE__ */ new Set();
    const items = [];
    for (const item of results) {
      const key = resultKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      const info = mediaInfoOf(item);
      if (policy.excludeLibrary && info?.jellyfinMediaId) continue;
      if (policy.excludeBlocklisted && policy.blockedStatus !== void 0 && info?.status === policy.blockedStatus) continue;
      items.push(item);
    }
    return items;
  }
  function isGenreEntry(value) {
    return isRecord(value) && typeof value.id === "number" && typeof value.name === "string";
  }
  function decodeGenreList(value) {
    if (!Array.isArray(value)) throw decodeError("genre list");
    return value.filter(isGenreEntry);
  }

  // client/src/features/seerr/discovery/card-rendering.ts
  var BUILD_SLICE_MS = 8;
  function createYield() {
    if (typeof MessageChannel === "undefined") return () => new Promise((resolve) => setTimeout(resolve, 0));
    const channel = new MessageChannel();
    const waiters = [];
    channel.port1.onmessage = () => waiters.shift()?.();
    return () => new Promise((resolve) => {
      waiters.push(resolve);
      channel.port2.postMessage(null);
    });
  }
  function firstSizedBox(elements) {
    for (const element of elements) {
      const box = element?.getBoundingClientRect();
      if (box && box.width > 0 && box.height > 0) return box;
    }
    return null;
  }
  function createCardRendering(JE) {
    const yieldToBrowser = createYield();
    function filterCardResults(results) {
      const hiddenContent = discoveryContext(JE).peer("hiddenContent");
      const visible = hiddenContent ? hiddenContent.filterJellyseerrResults(results, "discovery") : results;
      return selectCardResults(visible, {
        excludeLibrary: JE.pluginConfig?.JellyseerrExcludeLibraryItems === true,
        excludeBlocklisted: JE.pluginConfig?.JellyseerrExcludeBlocklistedItems === true,
        blockedStatus: JE.seerrStatus?.MEDIA.BLOCKED
      });
    }
    function createDiscoveryCard(item, cardClass) {
      const card = JE.jellyseerrUI?.createJellyseerrCard?.(item, true, true);
      if (!card) return null;
      card.classList.remove("portraitCard", "overflowPortraitCard");
      card.classList.add(cardClass);
      card.setAttribute("data-media-type", String(item.mediaType));
      const mediaId = mediaInfoOf(item)?.jellyfinMediaId;
      if (mediaId) {
        const id = String(mediaId);
        card.setAttribute("data-library-item", "true");
        card.setAttribute("data-jellyfin-media-id", id);
        card.classList.add("jellyseerr-card-in-library");
        const titleLink = card.querySelector(".cardText-first a");
        if (titleLink) {
          const name = String(item.title || item.name || "");
          titleLink.textContent = name;
          titleLink.title = name;
          titleLink.href = `#!/details?id=${encodeURIComponent(id)}`;
          titleLink.removeAttribute("target");
          titleLink.removeAttribute("rel");
        }
      }
      return card;
    }
    function createCardsFragment(results, options = {}) {
      const { cardClass = "portraitCard" } = options;
      const fragment = document.createDocumentFragment();
      for (const item of filterCardResults(results)) {
        const card = createDiscoveryCard(item, cardClass);
        if (card) fragment.appendChild(card);
      }
      return fragment;
    }
    function cardsInView(container, options = {}) {
      const scroll = JE.seamlessScroll;
      if (!scroll?.cardsNeeded || !container.isConnected) return 0;
      const rect = container.getBoundingClientRect();
      if (options.horizontal) {
        const row = firstSizedBox([container, container.closest(".emby-scroller"), container.closest(".verticalSection")]);
        if (!row || row.bottom <= 0 || row.top >= window.innerHeight) return 0;
        let last = container.lastElementChild;
        while (last && !last.classList.contains("card")) last = last.previousElementSibling;
        const end = last ? last.getBoundingClientRect().right : rect.left;
        const gapPx2 = window.innerWidth * 1.5 - end;
        return gapPx2 > 0 ? scroll.cardsNeeded(container, { deficitPx: gapPx2, horizontal: true }, Infinity) : 0;
      }
      const gapPx = window.innerHeight * 1.5 - rect.bottom;
      return gapPx > 0 ? scroll.cardsNeeded(container, { deficitPx: gapPx }, Infinity) : 0;
    }
    async function appendInSlices(container, items, createCard, options = {}) {
      const { syncCount = 0, isCurrent = () => true } = options;
      const iterator = items[Symbol.iterator]();
      let next = iterator.next();
      const build = (fragment, minCount, budgetMs) => {
        const start = performance.now();
        let count = 0;
        while (!next.done && (count < minCount || performance.now() - start < budgetMs)) {
          const card = createCard(next.value);
          next = iterator.next();
          if (card) {
            fragment.appendChild(card);
            count++;
          }
        }
        return count;
      };
      let pending = document.createDocumentFragment();
      let syncCards = [];
      let settled = false;
      try {
        let appended = 0;
        if (syncCount > 0) {
          appended = build(pending, syncCount, 0);
          if (appended > 0) {
            syncCards = Array.from(pending.children);
            container.appendChild(pending);
          }
          pending = document.createDocumentFragment();
        }
        let built = build(pending, 0, BUILD_SLICE_MS);
        while (!next.done) {
          await yieldToBrowser();
          if (!isCurrent()) {
            settled = true;
            return appended;
          }
          built += build(pending, 1, BUILD_SLICE_MS);
        }
        if (built > 0) container.appendChild(pending);
        settled = true;
        return appended + built;
      } finally {
        if (pending.firstChild) JE.jellyseerrUI?.releasePosters?.(pending);
        if (!settled && syncCards.length > 0) {
          syncCards.forEach((card) => card.remove());
          JE.jellyseerrUI?.releasePosters?.();
        }
      }
    }
    function appendCards(container, results, options = {}) {
      const { cardClass = "portraitCard", isCurrent } = options;
      const items = filterCardResults(results);
      if (items.length === 0) return Promise.resolve(0);
      return appendInSlices(container, items, (item) => createDiscoveryCard(item, cardClass), {
        syncCount: cardsInView(container),
        isCurrent
      });
    }
    return { createCardsFragment, appendCards, appendInSlices, cardsInView };
  }

  // client/src/features/seerr/discovery/controls.ts
  var ACTIVE_BACKGROUND = "rgba(255,255,255,0.15)";
  var IDLE_BACKGROUND = "rgba(255,255,255,0.05)";
  function createControls(JE) {
    const filterModes = /* @__PURE__ */ new Map();
    const sortModes = /* @__PURE__ */ new Map();
    const getFilterMode = (name) => filterModes.get(name) ?? FILTER_MODES.MIXED;
    function setFilterMode(name, mode) {
      if (isFilterMode(mode)) filterModes.set(name, mode);
    }
    const getSortMode = (name) => sortModes.get(name) || "";
    function createFilterControl(moduleName, onFilterChange) {
      const currentMode = getFilterMode(moduleName);
      const container = document.createElement("div");
      container.className = "jellyseerr-discovery-filter";
      container.style.cssText = "display:inline-flex;gap:0;font-size:0.85em;vertical-align:middle;";
      const label = (key, fallback) => JE.t?.(key) || fallback;
      const buttons = [
        { mode: FILTER_MODES.MIXED, label: label("jellyseerr_discover_all", "All") },
        { mode: FILTER_MODES.MOVIES, label: label("jellyseerr_card_badge_movie", "Movies") },
        { mode: FILTER_MODES.TV, label: label("jellyseerr_card_badge_series", "Series") }
      ];
      buttons.forEach((entry, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "jellyseerr-filter-btn";
        button.setAttribute("data-mode", entry.mode);
        button.textContent = entry.label;
        const radius = index === 0 ? "4px 0 0 4px" : index === buttons.length - 1 ? "0 4px 4px 0" : "0";
        const isActive = currentMode === entry.mode;
        button.style.cssText = `
                padding: 4px 10px;
                border: 1px solid rgba(255,255,255,0.3);
                border-radius: ${radius};
                background: ${isActive ? ACTIVE_BACKGROUND : IDLE_BACKGROUND};
                color: rgba(255,255,255,0.8);
                cursor: pointer;
                font-size: inherit;
                font-family: inherit;
                margin-left: ${index > 0 ? "-1px" : "0"};
                transition: background 0.15s, border-color 0.15s;
                font-weight: ${isActive ? "600" : "400"};
            `;
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (entry.mode === getFilterMode(moduleName)) return;
          setFilterMode(moduleName, entry.mode);
          for (const other of container.querySelectorAll(".jellyseerr-filter-btn")) {
            const nowActive = other.getAttribute("data-mode") === entry.mode;
            other.style.background = nowActive ? ACTIVE_BACKGROUND : IDLE_BACKGROUND;
            other.style.fontWeight = nowActive ? "600" : "400";
          }
          onFilterChange?.(entry.mode);
        });
        button.addEventListener("mouseenter", () => {
          if (getFilterMode(moduleName) !== entry.mode) button.style.background = "rgba(255,255,255,0.1)";
        });
        button.addEventListener("mouseleave", () => {
          button.style.background = getFilterMode(moduleName) === entry.mode ? ACTIVE_BACKGROUND : IDLE_BACKGROUND;
        });
        container.appendChild(button);
      });
      return container;
    }
    function createSortControl(moduleName, onSortChange) {
      const currentSort = getSortMode(moduleName);
      const container = document.createElement("div");
      container.className = "jellyseerr-discovery-sort";
      container.style.cssText = "display:inline-flex;align-items:center;gap:0.4em;font-size:0.85em;margin-left:auto;";
      const label = document.createElement("span");
      label.textContent = "Sort:";
      label.style.cssText = "color:rgba(255,255,255,0.5);";
      container.appendChild(label);
      const select = document.createElement("select");
      select.className = "jellyseerr-sort-select";
      select.style.cssText = `
            background: rgba(255,255,255,0.08);
            color: rgba(255,255,255,0.85);
            border: 1px solid rgba(255,255,255,0.2);
            border-radius: 4px;
            padding: 3px 8px;
            font-size: inherit;
            font-family: inherit;
            cursor: pointer;
            outline: none;
        `;
      for (const entry of SORT_OPTIONS) {
        const option = document.createElement("option");
        option.value = entry.value;
        option.textContent = entry.label;
        option.style.cssText = "background:#1a1a2e;color:#fff;";
        if (currentSort === entry.value) option.selected = true;
        select.appendChild(option);
      }
      select.addEventListener("change", () => {
        sortModes.set(moduleName, select.value);
        onSortChange?.(select.value);
      });
      container.appendChild(select);
      return container;
    }
    function createSectionHeader(title, moduleName, showFilter, onFilterChange, onSortChange) {
      const header = document.createElement("div");
      header.className = "jellyseerr-discovery-header";
      header.style.cssText = "display:flex;align-items:baseline;gap:1em;margin-bottom:1em;flex-wrap:wrap;width:100%;";
      const heading = document.createElement("h2");
      heading.className = "sectionTitle sectionTitle-cards";
      heading.textContent = title;
      heading.style.margin = "0";
      header.appendChild(heading);
      if (showFilter) header.appendChild(createFilterControl(moduleName, onFilterChange));
      if (onSortChange) header.appendChild(createSortControl(moduleName, onSortChange));
      return header;
    }
    return {
      getFilterMode,
      setFilterMode,
      getSortMode,
      resetFilterMode: (name) => {
        filterModes.delete(name);
      },
      getTvSortMode: (name) => tvSortValue(getSortMode(name)),
      setSortMode: (name, sort) => {
        sortModes.set(name, sort);
      },
      resetSortMode: (name) => {
        sortModes.delete(name);
      },
      createFilterControl,
      createSortControl,
      createSectionHeader
    };
  }
  function applyFilterVisibility(container, mode) {
    if (!container) return;
    container.classList.remove("filter-movies", "filter-tv");
    if (mode === FILTER_MODES.MOVIES) container.classList.add("filter-movies");
    else if (mode === FILTER_MODES.TV) container.classList.add("filter-tv");
  }
  function injectFilterStyles() {
    if (document.getElementById("jellyseerr-filter-styles")) return;
    const style = document.createElement("style");
    style.id = "jellyseerr-filter-styles";
    style.textContent = `
            .filter-movies [data-media-type="tv"] { display: none !important; }
            .filter-tv [data-media-type="movie"] { display: none !important; }
        `;
    document.head.appendChild(style);
  }

  // client/src/features/seerr/discovery/managed-fetch.ts
  var userChanged = () => abortError("User changed during request");
  function currentCheck(JE) {
    const session = JE.session;
    if (!session) return () => true;
    const epoch = session.getEpoch();
    return () => session.isCurrent(epoch);
  }
  function createManagedFetch(JE, client) {
    return async function fetchWithManagedRequest(path, cachePrefix, options = {}) {
      const api = client();
      if (!api) throw new Error("Jellyfin ApiClient is unavailable");
      const url = api.getUrl(path);
      const { signal } = options;
      const manager = JE.requestManager;
      const stillCurrent = currentCheck(JE);
      if (!manager) {
        if (!api.ajax) throw new Error("Jellyfin ApiClient cannot issue requests");
        const data = await api.ajax({
          type: "GET",
          url,
          headers: { "X-Jellyfin-User-Id": api.getCurrentUserId() },
          dataType: "json"
        });
        if (!stillCurrent()) throw userChanged();
        throwIfAborted(signal);
        return data;
      }
      const cacheKey = `${cachePrefix}:${path}`;
      const cached = manager.getCached(cacheKey);
      if (cached) return cached;
      const fetchPage = async () => {
        const requestedAt = manager.cacheStamp?.();
        const token = api.accessToken();
        const response = await manager.fetchWithRetry(url, {
          method: "GET",
          headers: {
            "X-Jellyfin-User-Id": api.getCurrentUserId(),
            Authorization: `MediaBrowser Token="${token}"`,
            "X-Emby-Token": token,
            Accept: "application/json"
          },
          ...signal ? { signal } : {}
        });
        const data = await response.json();
        if (!stillCurrent()) throw userChanged();
        manager.setCache(cacheKey, data, requestedAt);
        return data;
      };
      return manager.deduplicatedFetch(cacheKey, () => manager.withConcurrencyLimit(() => {
        if (!stillCurrent()) return Promise.reject(userChanged());
        const hit = manager.getCached(cacheKey);
        return hit ? Promise.resolve(hit) : fetchPage();
      }), signal);
    };
  }
  var GENRE_LIST_PREFIX = "je-tmdb-genres:";
  var GENRE_LIST_TTL_MS = 30 * 60 * 1e3;
  function readStoredGenreList(deps, key) {
    try {
      const raw = deps.storage().getItem(key);
      if (!raw) return null;
      const entry = JSON.parse(raw);
      if (!isRecord(entry) || typeof entry.storedAt !== "number") return null;
      const age = deps.now() - entry.storedAt;
      if (!(age >= 0 && age < GENRE_LIST_TTL_MS)) return null;
      const { genres } = entry;
      if (!Array.isArray(genres) || genres.length === 0 || !genres.every(isGenreEntry)) return null;
      return genres;
    } catch {
      return null;
    }
  }
  function createGenreListFetch(JE, deps) {
    return async function fetchTmdbGenreList(mediaType, options = {}) {
      const serverId = JE.session?.getServerId?.();
      const userId = JE.session?.getUserId?.();
      const key = serverId && userId ? `${GENRE_LIST_PREFIX}${serverId}:${userId}:${mediaType}` : null;
      const stored = key ? readStoredGenreList(deps, key) : null;
      if (stored) return stored;
      const stillCurrent = currentCheck(JE);
      const data = await deps.fetchWithManagedRequest(`/JellyfinEnhanced/tmdb/genres/${mediaType}`, "genre", options);
      const genres = decodeGenreList(data);
      if (key && genres.length > 0 && stillCurrent()) {
        try {
          deps.storage().setItem(key, JSON.stringify({ storedAt: deps.now(), genres }));
        } catch {
        }
      }
      return genres;
    };
  }

  // client/src/features/seerr/discovery/page-ready.ts
  var LIST_GRACE_MS = 1500;
  var DETAIL_GRACE_MS = 3e3;
  var OVERALL_WAIT_MS = 3e4;
  var POLL_MS = 100;
  var VISIBLE_DETAIL = ".itemDetailPage:not(.hide)";
  function detailAnchor(page) {
    return page.querySelector(".detailPageContent") ?? page.querySelector(".detailPageSecondaryContainer") ?? page;
  }
  function createPageReady(JE) {
    let sequence = 0;
    function findDetail(options, allowStale) {
      const view = options.getView?.();
      if (view?.matches(VISIBLE_DETAIL)) return detailAnchor(view);
      let staleFallback = null;
      for (const page of document.querySelectorAll(VISIBLE_DETAIL)) {
        if (!options.isStalePage?.(page)) return detailAnchor(page);
        if (allowStale) staleFallback ?? (staleFallback = page);
      }
      return staleFallback && detailAnchor(staleFallback);
    }
    function findList(options, allowStale) {
      const viewContainer = options.getView?.()?.querySelector(".itemsContainer");
      if (viewContainer) return viewContainer;
      const candidates = document.querySelectorAll(".page:not(.hide) .itemsContainer, .libraryPage:not(.hide) .itemsContainer");
      let staleFallback = null;
      for (const candidate of candidates) {
        if (!options.isStalePage?.(candidate.closest(".page, .libraryPage"))) return candidate;
        if (allowStale && candidate.children.length > 0) staleFallback ?? (staleFallback = candidate);
      }
      return staleFallback;
    }
    return function waitForPageReady(signal, options = {}) {
      const type = options.type ?? "list";
      const find = (allowStale) => type === "detail" ? findDetail(options, allowStale) : findList(options, allowStale);
      return new Promise((resolve) => {
        if (signal?.aborted) {
          resolve(null);
          return;
        }
        const immediate = find(false);
        if (immediate) {
          resolve(immediate);
          return;
        }
        let allowStale = false;
        let timeoutId;
        let pollId;
        let subscription;
        let finished = false;
        const finish = (result) => {
          if (finished) return;
          finished = true;
          subscription?.unsubscribe();
          clearInterval(pollId);
          clearTimeout(timeoutId);
          signal?.removeEventListener("abort", abort);
          resolve(result);
        };
        const abort = () => finish(null);
        const recheck = () => {
          const found = find(allowStale);
          if (found) finish(found);
        };
        signal?.addEventListener("abort", abort, { once: true });
        subscription = JE.helpers?.onBodyMutation?.(`jellyseerr-discovery-container-detect-${++sequence}`, recheck);
        pollId = setInterval(recheck, POLL_MS);
        timeoutId = setTimeout(() => {
          allowStale = true;
          recheck();
          if (!finished) timeoutId = setTimeout(() => finish(find(true)), OVERALL_WAIT_MS);
        }, type === "list" ? LIST_GRACE_MS : DETAIL_GRACE_MS);
      });
    };
  }

  // client/src/features/seerr/discovery/session-cache.ts
  var STORAGE_PREFIX = "je-discovery-resolution-v2:";
  var LEGACY_PREFIX = "je-discovery-resolution:";
  var STORAGE_TTL_MS = 30 * 60 * 1e3;
  var MAX_ENTRIES = 200;
  var MEMORY_ONLY_SERVER = "";
  function createSessionCacheFactory(deps) {
    let legacyPurged = false;
    function purgeLegacy() {
      if (legacyPurged) return;
      legacyPurged = true;
      try {
        const storage = deps.storage();
        for (let index = storage.length - 1; index >= 0; index--) {
          const key = storage.key(index);
          if (key?.startsWith(LEGACY_PREFIX)) storage.removeItem(key);
        }
      } catch {
      }
    }
    return function createSessionCache(name, isValid) {
      let memoryKey = null;
      let memoryEntries = null;
      function storageKey() {
        const userId = deps.userId();
        if (!userId) return null;
        return `${STORAGE_PREFIX}${deps.serverId() || MEMORY_ONLY_SERVER}:${userId}:${name}`;
      }
      const persisted = (key) => !key.startsWith(`${STORAGE_PREFIX}${MEMORY_ONLY_SERVER}:`);
      function load(key) {
        const entries = /* @__PURE__ */ new Map();
        if (!persisted(key)) return entries;
        purgeLegacy();
        try {
          const parsed = JSON.parse(deps.storage().getItem(key) || "null");
          const stored = isRecord(parsed) ? parsed.entries : null;
          if (!isRecord(stored)) return entries;
          const now = deps.now();
          for (const [entryKey, entry] of Object.entries(stored)) {
            if (!isRecord(entry)) continue;
            const { storedAt, value } = entry;
            if (typeof storedAt !== "number") continue;
            const age = now - storedAt;
            if (!(age >= 0 && age < STORAGE_TTL_MS) || !isValid(value)) continue;
            entries.set(entryKey, { value, storedAt });
          }
        } catch {
        }
        return entries;
      }
      function entriesFor(key) {
        if (key === memoryKey && memoryEntries) return memoryEntries;
        const entries = load(key);
        if (key === storageKey()) {
          memoryKey = key;
          memoryEntries = entries;
        }
        return entries;
      }
      function fresh(entries, entryKey) {
        const entry = entries.get(entryKey);
        if (!entry) return void 0;
        if (deps.now() - entry.storedAt < STORAGE_TTL_MS) return entry;
        entries.delete(entryKey);
        return void 0;
      }
      function scope() {
        const key = storageKey();
        return {
          has: (entryKey) => !!key && !!fresh(entriesFor(key), String(entryKey)),
          get: (entryKey) => key ? fresh(entriesFor(key), String(entryKey))?.value : void 0,
          set(entryKey, value) {
            if (!key) return;
            const entries = entriesFor(key);
            entries.delete(String(entryKey));
            entries.set(String(entryKey), { value, storedAt: deps.now() });
            for (const oldest of entries.keys()) {
              if (entries.size <= MAX_ENTRIES) break;
              entries.delete(oldest);
            }
            if (!persisted(key) || !isValid(value)) return;
            try {
              const stored = [...entries].filter(([, entry]) => isValid(entry.value));
              deps.storage().setItem(key, JSON.stringify({ entries: Object.fromEntries(stored) }));
            } catch {
            }
          }
        };
      }
      return { scope };
    };
  }

  // client/src/features/seerr/discovery/discovery-filter-utils.ts
  function createDiscoveryFilter(JE, client) {
    const storage = () => window.sessionStorage;
    const now = () => Date.now();
    const fetchWithManagedRequest = createManagedFetch(JE, client);
    return {
      MODES: FILTER_MODES,
      SORT_OPTIONS,
      ...createControls(JE),
      interleaveArrays,
      filterByMediaType,
      hasBothTypes,
      resultHasBothTypes,
      fetchWithManagedRequest,
      fetchTmdbGenreList: createGenreListFetch(JE, { storage, now, fetchWithManagedRequest }),
      createSessionCache: createSessionCacheFactory({
        storage,
        now,
        userId: () => JE.session?.getUserId?.(),
        serverId: () => JE.session?.getServerId?.()
      }),
      ...createCardRendering(JE),
      waitForPageReady: createPageReady(JE),
      setupInfiniteScroll(state, selector, loadMore, hasMore, isLoading, options) {
        JE.seamlessScroll?.setupInfiniteScroll(state, selector, loadMore, hasMore, isLoading, options);
      },
      cleanupScrollObserver(state) {
        JE.seamlessScroll?.cleanupInfiniteScroll(state);
      },
      applyFilterVisibility
    };
  }
  (function() {
    "use strict";
    const { JE, api } = discoveryHost();
    injectFilterStyles();
    JE.discoveryFilter = createDiscoveryFilter(JE, api);
  })();
})();
})();
//# sourceMappingURL=discovery-filter-utils.js.map
