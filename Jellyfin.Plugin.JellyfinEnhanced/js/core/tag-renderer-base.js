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
    const JE = window.JellyfinEnhanced;
    if (!JE) return;
    const core = JE.core ?? (JE.core = {});
    let registry = core.sharedModules;
    if (!registry) {
      registry = /* @__PURE__ */ Object.create(null);
      Object.defineProperty(core, "sharedModules", { value: registry, configurable: true, writable: true, enumerable: false });
    }
    for (const [id, namespace] of Object.entries(modules)) registry[id] ?? (registry[id] = namespace);
  }

  // client/src/features/media-tags/pipeline/dto.ts
  var dto_exports = {};
  __export(dto_exports, {
    either: () => either,
    errorStatus: () => errorStatus,
    finite: () => finite,
    idText: () => idText,
    isRecord: () => isRecord,
    memberRecord: () => memberRecord,
    memberText: () => memberText,
    members: () => members,
    normalizeItemId: () => normalizeItemId,
    own: () => own,
    record: () => record,
    records: () => records,
    stringList: () => stringList,
    text: () => text
  });
  var EMPTY = Object.freeze({});
  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function record(value) {
    return isRecord(value) ? value : EMPTY;
  }
  function records(value) {
    return Array.isArray(value) ? value.filter(isRecord) : [];
  }
  function stringList(value) {
    return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
  }
  function members(value) {
    if (!value) return [];
    if (!Array.isArray(value)) throw new TypeError("Expected a list");
    return value;
  }
  function memberRecord(value) {
    if (value === null || value === void 0) throw new TypeError("Read a missing list member");
    return record(value);
  }
  function memberText(value) {
    if (typeof value !== "string") throw new TypeError("Read a list member that is not text");
    return value;
  }
  function text(value) {
    return typeof value === "string" && value ? value : null;
  }
  function finite(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }
  function normalizeItemId(id) {
    return String(id).replace(/-/g, "").toLowerCase();
  }
  function idText(value) {
    return typeof value === "string" && value || typeof value === "number" && Number.isFinite(value) ? String(value) : null;
  }
  function either(value, key) {
    return isRecord(value) ? value[key] ?? value[key.charAt(0).toUpperCase() + key.slice(1)] : void 0;
  }
  function errorStatus(error) {
    return isRecord(error) && typeof error.status === "number" ? error.status : 0;
  }
  function own(table, key) {
    return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : void 0;
  }

  // client/src/features/media-tags/host.ts
  var host_exports = {};
  __export(host_exports, {
    apiClient: () => apiClient,
    hasApiClient: () => hasApiClient,
    mediaTagsContext: () => mediaTagsContext,
    settingsUi: () => settingsUi,
    tagRuntimeHost: () => tagRuntimeHost
  });
  function tagRuntimeHost() {
    const host = window;
    const bridge = host.JellyfinEnhanced ?? (host.JellyfinEnhanced = {});
    bridge.core ?? (bridge.core = {});
    return bridge;
  }
  function mediaTagsContext(JE = tagRuntimeHost()) {
    return featureContext("media-tags", JE, {
      internalSlots: ["peopleTags"],
      // Same expression the modules used before (`JE.internals = JE.internals || {}`).
      internalsObject: () => JE.internals = JE.internals || {}
    });
  }
  function settingsUi(JE) {
    return JE.internals?.enhancedUi;
  }
  function hasApiClient() {
    const host = window;
    return host.ApiClient !== void 0 && host.ApiClient !== null;
  }
  function apiClient() {
    const host = window;
    if (!host.ApiClient) throw new Error("Jellyfin ApiClient unavailable");
    return host.ApiClient;
  }

  // client/generated-shared/publish/js/core/tag-renderer-base.js.ts
  publishSharedModules({ "features/media-tags/pipeline/dto": dto_exports, "features/media-tags/host": host_exports });

  // client/src/features/media-tags/pipeline/scopes.ts
  var SCOPE_IDS = ["movies", "series", "seasons", "episodes", "continueWatching", "nextUp"];
  var SCOPED_GROUPS = ["quality", "genre", "language", "ageRating", "status", "awards", "logos", "custom"];
  var TYPE_SCOPES = { Movie: "movies", Series: "series", Season: "seasons", Episode: "episodes" };
  var ROW_SCOPES = { continuewatching: "continueWatching", nextup: "nextUp" };
  var SCOPE_GROUP_ALIASES = { agerating: "ageRating" };
  var RATING_SCOPE_KEYS = { movies: "Movies", series: "Series", seasons: "Seasons", episodes: "Episodes", continueWatching: "ContinueWatching", nextUp: "NextUp" };
  var groupId = (group) => (Object.prototype.hasOwnProperty.call(SCOPE_GROUP_ALIASES, group) ? SCOPE_GROUP_ALIASES[group] : void 0) ?? group;
  var scopedType = (type) => type && Object.prototype.hasOwnProperty.call(TYPE_SCOPES, type) ? TYPE_SCOPES[type] ?? null : null;
  function scopeDefaultOf(group, scope, plugin) {
    if (group === "rating") return plugin?.[`RatingTagsOn${RATING_SCOPE_KEYS[scope]}`] !== false;
    return either(either(plugin?.TagGroupScopes, group), scope) !== false;
  }
  function scopeOwnOf(group, scope, settings) {
    const value = either(either(settings?.tagGroupScopes ?? settings?.TagGroupScopes, group), scope);
    if (typeof value === "boolean") return value;
    if (group === "rating" && settings?.[`ratingTagsOn${RATING_SCOPE_KEYS[scope]}`] === false) return false;
    return null;
  }
  function createTagScopes(host) {
    const scopeDefault = (group, scope, plugin = host.plugin()) => scopeDefaultOf(group, scope, plugin);
    const scopeOwn = (group, scope, settings = host.settings()) => scopeOwnOf(group, scope, settings);
    function allows(groupName, scope, settings = host.settings(), plugin = host.plugin()) {
      const group = groupId(groupName);
      if (group !== "rating" && !SCOPED_GROUPS.includes(group)) return true;
      return scopeOwn(group, scope, settings) ?? scopeDefault(group, scope, plugin);
    }
    function excludes(groupName, el, type) {
      const group = groupId(groupName);
      if (group !== "rating" && !SCOPED_GROUPS.includes(group)) return false;
      const itemType = el?.closest?.("[data-type]")?.getAttribute("data-type") || type || null;
      const typeScope = scopedType(itemType);
      if (typeScope && !allows(group, typeScope)) return true;
      const detect = host.detectRow();
      if (el && detect && ["continueWatching", "nextUp"].some((scope) => !allows(group, scope))) {
        const row = detect(el);
        const rowScope = Object.prototype.hasOwnProperty.call(ROW_SCOPES, row) ? ROW_SCOPES[row] : void 0;
        if (rowScope && !allows(group, rowScope)) return true;
      }
      return false;
    }
    function setOwn(groupName, scope, value, settings = host.settings()) {
      if (!settings) throw new TypeError("A settings document is required");
      const group = groupId(groupName);
      if (group === "rating") settings[`ratingTagsOn${RATING_SCOPE_KEYS[scope]}`] = value !== false;
      const camel = (key) => key.charAt(0).toLowerCase() + key.slice(1);
      const source = isRecord(settings.tagGroupScopes) ? settings.tagGroupScopes : {};
      const scopes = /* @__PURE__ */ new Map();
      for (const [g, values] of Object.entries(source)) {
        if (!isRecord(values)) continue;
        const set2 = /* @__PURE__ */ Object.create(null);
        for (const [s, v] of Object.entries(values)) if (typeof v === "boolean") set2[camel(s)] = v;
        if (Object.keys(set2).length) scopes.set(camel(g), set2);
      }
      const set = Object.assign(/* @__PURE__ */ Object.create(null), scopes.get(group));
      if (value === null) delete set[scope];
      else set[scope] = value;
      if (Object.keys(set).length) scopes.set(group, set);
      else scopes.delete(group);
      settings.tagGroupScopes = scopes.size ? Object.fromEntries([...scopes].map(([key, values]) => [key, { ...values }])) : null;
    }
    function follow(group, settings = host.settings()) {
      for (const scope of SCOPE_IDS) setOwn(group, scope, null, settings);
    }
    return { SCOPE_IDS, SCOPED_GROUPS, TYPE_SCOPES, scopeDefault, scopeOwn, allows, excludes, setOwn, follow };
  }
  var MATRIX_GROUPS = ["quality", "genre", "language", "rating", "ageRating", "status", "awards", "people", "logos", "custom"];
  var reasons = { people: { position: "tag_scope_people_na", limit: "tag_scope_people_na", scopes: "tag_scope_people_na" } };
  var surfaces = { admin: {}, hub: {}, itemEditor: { scopes: "tag_item_editor_scope_note" } };
  var SETTINGS_MATRIX = {
    groups: MATRIX_GROUPS,
    controls: ["enable", "position", "limit", "scopes"],
    // Groups without a control, everywhere, and why.
    except: reasons,
    // Controls a whole surface does not have, and why.
    surfaces
  };
  function createSettingsMatrix(singleChipGroup) {
    function offers(surface, group, control) {
      const groupReasons = group === "people" ? reasons.people : void 0;
      const reason = groupReasons?.[control] || surfaces[surface]?.[control];
      if (reason) return reason;
      if (control === "limit" && singleChipGroup(group)) return "tag_limit_single";
      return true;
    }
    return { ...SETTINGS_MATRIX, offers };
  }

  // client/src/features/media-tags/pipeline/tag-renderer-base.ts
  function isHostList(value) {
    return Array.isArray(value);
  }
  function createTagRenderer(JE) {
    const STANDARD_IGNORE_SELECTORS = [
      "#itemDetailPage .infoWrapper .cardImageContainer",
      "#itemDetailPage #castCollapsible .cardImageContainer",
      "#indexPage .verticalSection.MyMedia .cardImageContainer",
      ".formDialog .cardImageContainer",
      "#itemDetailPage .chapterCardImageContainer",
      // Admin/dashboard pages
      "#pluginsPage .cardImageContainer",
      "#pluginsPage .card",
      "#pluginCatalogPage .cardImageContainer",
      "#pluginCatalogPage .card",
      "#devicesPage .cardImageContainer",
      "#devicesPage .card",
      "#mediaLibraryPage .cardImageContainer",
      "#mediaLibraryPage .card"
    ];
    const tags = /* @__PURE__ */ new Map();
    const styleSpecs = /* @__PURE__ */ new Map();
    const previewStyles = /* @__PURE__ */ new Map();
    let standardIgnoreSelector = null;
    let standardIgnoreSearch = null;
    function isIgnoredContext(el) {
      if (!el) return true;
      const search = JE.pluginConfig?.DisableTagsOnSearchPage === true;
      if (standardIgnoreSelector === null || standardIgnoreSearch !== search) {
        standardIgnoreSearch = search;
        standardIgnoreSelector = STANDARD_IGNORE_SELECTORS.concat(search ? ["#searchPage .cardImageContainer"] : []).join(", ");
      }
      const target = el.closest(".cardImageContainer") || el.closest(".cardScalable")?.querySelector(".cardImageContainer") || el;
      try {
        return target.closest(standardIgnoreSelector) !== null;
      } catch {
        return false;
      }
    }
    function layoutFor(name) {
      const layout = JE.core.tagLayout;
      return layout && layout.normalizeGroup(name) ? layout : null;
    }
    function resolvePosition(userKey, pluginKey, fallback) {
      const configured = JE.currentSettings?.[userKey] || JE.pluginConfig?.[pluginKey] || fallback;
      const pos = typeof configured === "string" ? configured : fallback;
      const isTop = pos.includes("top");
      const isLeft = pos.includes("left");
      return {
        pos,
        isTop,
        isLeft,
        topVal: isTop ? "6px" : "auto",
        bottomVal: isTop ? "auto" : "6px",
        leftVal: isLeft ? "6px" : "auto",
        rightVal: isLeft ? "auto" : "6px",
        needsTopRightOffset: isTop && !isLeft
      };
    }
    function toKebab(camel) {
      return camel.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
    }
    const CORNER_STACK_GAP = 4;
    function applyCornerStacking(hostOrHosts) {
      const hosts = isHostList(hostOrHosts) ? hostOrHosts : [hostOrHosts];
      const stacks = [];
      for (const host of hosts) {
        if (!host) continue;
        const groups = /* @__PURE__ */ new Map();
        for (const child of host.children) {
          if (!(child instanceof HTMLElement)) continue;
          const corner = child.dataset.jeCorner;
          if (!corner) continue;
          const list = groups.get(corner);
          if (list) list.push(child);
          else groups.set(corner, [child]);
        }
        for (const [corner, items] of groups) {
          if (items.length <= 1) {
            if (items[0]) items[0].style.transform = "";
            continue;
          }
          for (const el of items) el.style.transform = "";
          stacks.push({ isTop: corner.indexOf("top") === 0, items });
        }
      }
      if (stacks.length === 0) return;
      const rects = stacks.map((stack) => stack.items.map((el) => el.getBoundingClientRect()));
      stacks.forEach(({ isTop, items }, s) => {
        let boundary = null;
        items.forEach((el, i) => {
          const rect = rects[s]?.[i];
          if (!rect) return;
          if (boundary === null) {
            boundary = isTop ? rect.bottom : rect.top;
            return;
          }
          const naturalEdge = isTop ? rect.top : rect.bottom;
          const delta = isTop ? boundary + CORNER_STACK_GAP - naturalEdge : naturalEdge - (boundary - CORNER_STACK_GAP);
          if (delta > 0) {
            el.style.transform = `translateY(${isTop ? delta : -delta}px)`;
            boundary = isTop ? naturalEdge + delta + rect.height : naturalEdge - delta - rect.height;
          } else {
            boundary = isTop ? rect.bottom : rect.top;
          }
        });
      });
    }
    const pendingStackHosts = /* @__PURE__ */ new Set();
    let stackFrame = 0;
    function scheduleCornerStacking(host) {
      if (!host) return;
      pendingStackHosts.add(host);
      if (stackFrame) return;
      stackFrame = requestAnimationFrame(() => {
        stackFrame = 0;
        const hosts = Array.from(pendingStackHosts).filter((h) => h.isConnected);
        pendingStackHosts.clear();
        applyCornerStacking(hosts);
      });
    }
    const cardByEl = /* @__PURE__ */ new WeakMap();
    function cardOf(el) {
      let card = cardByEl.get(el);
      if (card === void 0) {
        card = el.closest(".card");
        cardByEl.set(el, card);
      }
      return card;
    }
    function createTag(name, spec) {
      const logPrefix = spec.logPrefix;
      const containerClass = spec.containerClass;
      const TAGGED_ATTR = spec.taggedAttr;
      const state = {
        // Persistent (localStorage-backed) cache.
        cache: {},
        // Shared hot cache bucket.
        hot: null,
        localStorageEnabled: false,
        cacheTtl: 30 * 24 * 60 * 60 * 1e3,
        ignoreSelectors: null,
        // ignoreSelectors joined into one selector list.
        ignoreSelector: null,
        saveRegistered: false,
        unloadRegistered: false
      };
      let writeRevision = null;
      const ENVELOPE_VERSION = 1;
      function revision() {
        try {
          return text(JE.tagPipeline?.tagStripRevision?.());
        } catch {
          return null;
        }
      }
      function dirty() {
        JE._cacheManager?.markDirty();
      }
      function discard(itemId) {
        delete state.cache[itemId];
        state.hot?.delete(itemId);
        dirty();
      }
      function valid(entry, stamp) {
        if (!isRecord(entry) || entry.v !== ENVELOPE_VERSION || entry.stripRevision !== stamp || !Object.prototype.hasOwnProperty.call(entry, "payload")) return false;
        const timestamp = finite(entry.timestamp);
        return timestamp !== null && Date.now() - timestamp < state.cacheTtl;
      }
      function readFallback(itemId, persistent) {
        const stamp = revision();
        if (stamp === null) return void 0;
        const entry = persistent ? state.cache[itemId] : state.hot?.get(itemId);
        if (entry === void 0) return void 0;
        if (!valid(entry, stamp) || persistent && stamp !== "none") {
          discard(itemId);
          return void 0;
        }
        return entry.payload;
      }
      function writeFallback(itemId, payload, persistent) {
        if (writeRevision === null || !spec.cache) return;
        const entry = {
          v: ENVELOPE_VERSION,
          stripRevision: writeRevision,
          payload,
          timestamp: (isRecord(payload) ? finite(payload.timestamp) : null) ?? Date.now()
        };
        if (state.hot) state.hot.set(itemId, entry);
        if (writeRevision === "none" && persistent) state.cache[itemId] = entry;
        else if (writeRevision !== "none") delete state.cache[itemId];
        dirty();
      }
      const hot = {
        get: (itemId) => readFallback(itemId, false),
        set(itemId, payload) {
          writeFallback(itemId, payload, false);
          return hot;
        },
        delete(itemId) {
          discard(itemId);
          return true;
        },
        clear() {
          state.hot?.clear();
        },
        get size() {
          return state.hot?.size || 0;
        }
      };
      function invalidateFallback(updatedIds) {
        if (!updatedIds) {
          state.cache = {};
          state.hot?.clear();
          dirty();
        } else for (const id of updatedIds) discard(String(id));
      }
      function buildIgnoreSelectors() {
        const list = [...spec.ignoreSelectors || STANDARD_IGNORE_SELECTORS];
        if (JE.pluginConfig?.DisableTagsOnSearchPage === true) {
          list.push(spec.searchPageIgnoreSelector || "#searchPage .cardImageContainer");
        }
        return list;
      }
      function defaultShouldIgnore(el) {
        const selectors = state.ignoreSelectors ?? (state.ignoreSelectors = buildIgnoreSelectors());
        const selector = state.ignoreSelector ?? (state.ignoreSelector = selectors.join(", "));
        const target = el.closest(".cardImageContainer") || el.closest(".cardScalable")?.querySelector(".cardImageContainer") || el;
        try {
          return target.closest(selector) !== null;
        } catch {
          return selectors.some((selector2) => {
            try {
              if (target.matches(selector2)) return true;
              return target.closest(selector2) !== null;
            } catch {
              return false;
            }
          });
        }
      }
      function shouldIgnore(el) {
        return spec.shouldIgnore ? !!spec.shouldIgnore(el, defaultShouldIgnore) : defaultShouldIgnore(el);
      }
      function isTagged(el) {
        const card = cardOf(el);
        if (!card) return false;
        if (card.dataset?.[TAGGED_ATTR] !== "1") return false;
        const layout = layoutFor(name);
        if (layout) return layout.hasGroup(el, name);
        for (const child of el.children) {
          if (child.classList.contains(containerClass)) return true;
        }
        return !!card.querySelector(`.${containerClass}`);
      }
      function markTagged(el) {
        const card = cardOf(el);
        if (card) card.dataset[TAGGED_ATTR] = "1";
      }
      function enforceCacheOwnership() {
        if (!spec.cache || !state.localStorageEnabled) return;
        try {
          const ownerKey = `${spec.cache.key}:identity-owner`;
          const userId = JE.session?.getUserId() || (hasApiClient() ? apiClient().getCurrentUserId?.() : null) || "";
          const expected = `${JE.session?.getServerId() || ""}:${userId}`;
          if (localStorage.getItem(ownerKey) !== expected) {
            localStorage.removeItem(spec.cache.key);
            localStorage.setItem(ownerKey, expected);
          }
        } catch (e) {
          console.warn(`${logPrefix} cache ownership check failed`, e);
        }
      }
      function loadCacheSettings() {
        state.localStorageEnabled = JE.pluginConfig?.TagCacheServerMode === false || JE.pluginConfig?.EnableTagsLocalStorageFallback === true;
        state.cacheTtl = Number(JE.pluginConfig?.TagsCacheTtlDays || 30) * 24 * 60 * 60 * 1e3;
        if (!spec.cache) return;
        enforceCacheOwnership();
        state.cache = {};
        if (state.localStorageEnabled) {
          try {
            const cached = JSON.parse(localStorage.getItem(spec.cache.key) || "{}");
            if (isRecord(cached)) state.cache = { ...cached };
          } catch (e) {
            console.warn(`${logPrefix} Ignoring unreadable tag cache`, e);
          }
        }
        if (spec.cache.hotBucket) {
          const Hot = JE._hotCache = JE._hotCache || { ttl: state.cacheTtl };
          const bucket = Hot[spec.cache.hotBucket];
          const shared = typeof bucket === "object" ? bucket : /* @__PURE__ */ new Map();
          Hot[spec.cache.hotBucket] = shared;
          state.hot = shared;
        }
      }
      function saveCache() {
        if (!spec.cache || !state.localStorageEnabled) return;
        try {
          {
            for (const [key, entry] of Object.entries(state.cache)) {
              if (!valid(entry, "none")) {
                delete state.cache[key];
              }
            }
          }
          localStorage.setItem(spec.cache.key, JSON.stringify(state.cache));
        } catch (e) {
          console.warn(`${logPrefix} Failed to save cache`, e);
        }
      }
      function cleanupOldCaches() {
        if (!spec.cache || !state.localStorageEnabled) return;
        const CACHE_KEY = spec.cache.key;
        const TIMESTAMP_KEY = `${CACHE_KEY}Timestamp`;
        const currentKeys = [CACHE_KEY, TIMESTAMP_KEY, `${CACHE_KEY}:identity-owner`];
        const legacyStems = typeof spec.cache.legacyPrefix === "string" ? [spec.cache.legacyPrefix] : spec.cache.legacyPrefix;
        const stale = [];
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && legacyStems.some((legacy) => key.startsWith(`${legacy}-`) || key === legacy || key === `${legacy}Timestamp`) && !currentKeys.includes(key)) {
            stale.push(key);
          }
        }
        for (const key of stale) {
          console.log(`${logPrefix} Removing old cache: ${key}`);
          localStorage.removeItem(key);
        }
        const serverClearTimestamp = Number(JE.pluginConfig?.ClearLocalStorageTimestamp || 0);
        const localCacheTimestamp = parseInt(localStorage.getItem(TIMESTAMP_KEY) || "0", 10);
        if (serverClearTimestamp > localCacheTimestamp) {
          console.log(`${logPrefix} Server triggered cache clear (${new Date(serverClearTimestamp).toISOString()})`);
          localStorage.removeItem(CACHE_KEY);
          localStorage.setItem(TIMESTAMP_KEY, serverClearTimestamp.toString());
          state.cache = {};
          if (state.hot) state.hot.clear();
        }
      }
      function injectCss() {
        if (!spec.styleId || typeof spec.buildCss !== "function") return;
        const css = spec.buildCss(ctx);
        const text2 = JE.core.tagLayout?.preserveLegacySizing?.(css) || css;
        const existing = document.getElementById(spec.styleId);
        if (existing && previewStyles.delete(existing)) {
          delete existing.dataset.jeTagPreviewOwned;
          existing.textContent = text2;
        } else {
          JE.core.ui.injectCss(spec.styleId, text2);
        }
      }
      const ctx = {
        name,
        logPrefix,
        containerClass,
        taggedAttr: TAGGED_ATTR,
        /** @returns shared hot cache bucket */
        get hot() {
          return state.hot ? hot : null;
        },
        /** @returns cache TTL in ms */
        get cacheTtl() {
          return state.cacheTtl;
        },
        /** @returns whether localStorage fallback is active */
        get localStorageEnabled() {
          return state.localStorageEnabled;
        },
        /**
         * @returns the validated, module-defined payload
         */
        getPersistent(itemId) {
          return readFallback(itemId, true);
        },
        /** Only called within an authoritative batch render (see writeRevision). */
        setPersistent(itemId, value) {
          writeFallback(itemId, value, true);
        },
        deletePersistent: discard,
        clearPersistent() {
          state.cache = {};
          dirty();
        },
        isTagged,
        markTagged,
        shouldIgnore,
        injectCss,
        /**
         * Remove an existing overlay container from el, if present.
         */
        removeExistingOverlay(el) {
          layoutFor(name)?.removeGroup(el, name);
          const existing = el.querySelector(`.${containerClass}`);
          if (existing) existing.remove();
        },
        /**
         * Hand the overlay to the layout controller (or, for a renderer it
         * does not manage, append it) if it has content, and mark the card
         * tagged. Unmanaged overlays are NOT corner-stacked here: up to 4 renderers can each
         * commit an overlay onto the same host, and re-measuring
         * (getBoundingClientRect) after every single one forces a layout
         * per renderer per card. The pipeline calls
         * JE.core.tagRenderer.applyCornerStacking(host) once after all
         * renderers have committed for a given card instead.
         * @returns true if the overlay was attached
         */
        commitOverlay(el, overlay) {
          const layout = layoutFor(name);
          if (name !== "rating" && JE.core.tagScopes?.excludes(name, el)) {
            if (layout) layout.removeGroup(el, name);
            return false;
          }
          if (layout) {
            if (!layout.commitGroup(el, name, overlay)) return false;
            markTagged(el);
            return true;
          }
          if (spec.position) {
            const p = resolvePosition(spec.position.userKey, spec.position.pluginKey, spec.position.fallback);
            overlay.dataset.jeCorner = p.pos;
          }
          if (overlay.children.length === 0) return false;
          el.appendChild(overlay);
          markTagged(el);
          return true;
        }
      };
      JE.session?.onUserChange(`tag-cache-${name}`, (change) => {
        state.cache = {};
        if (state.hot) state.hot.clear();
        if (!spec.cache) return;
        try {
          localStorage.removeItem(spec.cache.key);
          localStorage.setItem(
            `${spec.cache.key}:identity-owner`,
            `${change.serverId || ""}:${change.userId || ""}`
          );
        } catch (e) {
          console.warn(`${logPrefix} cache clear on user switch failed`, e);
        }
      });
      function initialize() {
        loadCacheSettings();
        state.ignoreSelectors = buildIgnoreSelectors();
        state.ignoreSelector = null;
        cleanupOldCaches();
        if (spec.cache && state.localStorageEnabled) {
          if (JE._cacheManager && !state.saveRegistered) {
            JE._cacheManager.register(saveCache);
            state.saveRegistered = true;
          }
          if (spec.cache.saveOnUnload !== false && !state.unloadRegistered) {
            window.addEventListener("beforeunload", saveCache);
            state.unloadRegistered = true;
          }
        }
        const p = spec.pipeline;
        if (!p) return;
        if (!JE.tagPipeline) {
          console.warn(`${logPrefix} Tag pipeline not available, tags will not render.`);
          return;
        }
        const { renderFromCache: fromCache, renderFromServerCache: fromServer, cleanup } = p;
        const config = {
          render: (el, item, extras) => {
            writeRevision = text(extras?.stripRevision);
            try {
              return p.render(ctx, el, item, extras);
            } finally {
              writeRevision = null;
            }
          },
          renderFromCache: fromCache ? (el, itemId) => fromCache.call(p, ctx, el, itemId) : void 0,
          renderFromServerCache: fromServer ? (el, entry, itemId) => fromServer.call(p, ctx, el, entry, itemId) : void 0,
          onServerCacheRefresh: (updatedIds, info) => {
            invalidateFallback(updatedIds);
            p.onServerCacheRefresh?.(ctx, updatedIds, info);
          },
          cleanup: cleanup ? () => cleanup.call(p, ctx) : void 0,
          isEnabled: () => !!JE.currentSettings?.[spec.settingKey],
          needsFirstEpisode: !!p.needsFirstEpisode,
          needsParentSeries: !!p.needsParentSeries,
          needsLatestEpisode: !!p.needsLatestEpisode,
          injectCss
        };
        JE.tagPipeline.registerRenderer(name, config);
        console.log(`${logPrefix} Registered with unified tag pipeline.`);
      }
      function reinitialize2() {
        console.log(`${logPrefix} Re-initializing...`);
        spec.pipeline?.cleanup?.(ctx);
        const layout = layoutFor(name);
        if (layout) {
          layout.invalidateSettings();
          layout.removeGroupEverywhere(name);
        }
        document.querySelectorAll(`.${containerClass}`).forEach((el) => el.remove());
        document.querySelectorAll(`[data-${toKebab(TAGGED_ATTR)}]`).forEach((el) => {
          delete el.dataset[TAGGED_ATTR];
        });
        const renderer = JE.tagPipeline?.getRenderer?.(name);
        if (renderer?.injectCss) renderer.injectCss();
        else injectCss();
        if (!JE.currentSettings?.[spec.settingKey]) {
          console.log(`${logPrefix} Feature is disabled after reinit.`);
          return;
        }
        JE.tagPipeline?.clearProcessed();
        JE.tagPipeline?.scheduleScan();
      }
      return { ctx, initialize, reinitialize: reinitialize2 };
    }
    function getOrCreate(name, spec) {
      let tag = tags.get(name);
      if (!tag) {
        if (!spec) throw new TypeError(`Tag renderer ${name} needs a spec`);
        tag = createTag(name, spec);
        tags.set(name, tag);
      }
      return tag;
    }
    function register(name, spec) {
      const tag = getOrCreate(name, spec);
      tag.initialize();
      return tag.ctx;
    }
    function reinitialize(name, spec) {
      if (!spec && !tags.has(name)) return;
      getOrCreate(name, spec).reinitialize();
    }
    function registerStyles(spec) {
      styleSpecs.set(spec.settingKey, spec);
    }
    function ensureStyles(settings, owner) {
      for (const [key, spec] of styleSpecs) {
        if (!isRecord(settings) || !settings[key] || !spec.styleId) continue;
        const existing = document.getElementById(spec.styleId);
        if (existing) {
          previewStyles.get(existing)?.add(owner);
          continue;
        }
        if (typeof spec.buildCss !== "function") continue;
        const css = spec.buildCss();
        JE.core.ui.injectCss(spec.styleId, JE.core.tagLayout?.preserveLegacySizing?.(css) || css);
        const sheet = document.getElementById(spec.styleId);
        if (sheet) {
          sheet.dataset.jeTagPreviewOwned = "";
          previewStyles.set(sheet, /* @__PURE__ */ new Set([owner]));
        }
      }
    }
    function releaseStyles(owner) {
      for (const [sheet, owners] of previewStyles) {
        if (!owners.delete(owner) || owners.size) continue;
        sheet.remove();
        previewStyles.delete(sheet);
      }
    }
    function chipBaseCss(selector, code = false) {
      const css = `
                ${selector} {
                    font-weight: bold;
                    border-radius: 5px;
                    padding: calc(2px * var(--je-tag-scale, 1)) calc(${code ? 4 : 10}px * var(--je-tag-scale, 1));
                    font-size: calc(clamp(0.65rem, 2vw, 0.85rem) * var(--je-tag-scale, 1));
                    user-select: none;
                    pointer-events: none;
                    font-variant-caps: small-caps;
                    box-shadow: 0 1px 4px rgba(0,0,0,0.4);
                    border: 1px solid rgba(255,255,255,0.15);
                    /* backdrop-filter removed — blur causes jank during hover animations */
                    opacity: 1;
                    transform: translateY(0);
                    white-space: nowrap;
                    flex-shrink: 0;
                    line-height: 1.2;
                }
                .layout-mobile ${selector} {
                    padding: calc(0px * var(--je-tag-scale, 1)) calc(${code ? 3 : 6}px * var(--je-tag-scale, 1));
                    font-size: calc(0.65rem * var(--je-tag-scale, 1));
                    border-radius: 3px;
                }
                @media (min-width: 1440px) {
                ${selector} {
                        padding: calc(3px * var(--je-tag-scale, 1)) calc(${code ? 4 : 12}px * var(--je-tag-scale, 1));
                        font-size: calc(0.9rem * var(--je-tag-scale, 1));
                        border-radius: 6px;
                    }
                }
                @media (max-width: 768px) {
                ${selector} {
                        padding: calc(0px * var(--je-tag-scale, 1)) calc(${code ? 3 : 6}px * var(--je-tag-scale, 1));
                        font-size: calc(0.65rem * var(--je-tag-scale, 1));
                        border-radius: 3px;
                    }
                }
                @media (max-width: 480px) {
                ${selector} {
                        padding: calc(0px * var(--je-tag-scale, 1)) calc(${code ? 2 : 5}px * var(--je-tag-scale, 1));
                        font-size: calc(0.6rem * var(--je-tag-scale, 1));
                        border-radius: 2px;
                        box-shadow: 0 1px 3px rgba(0,0,0,0.4);
                    }
                }

                @supports (container-type: inline-size) {
                    html:not(.layout-mobile) .je-tag-host ${selector} {
                        font-size: calc(clamp(9px, 6.6cqw, 13.6px) * var(--je-tag-scale, 1));
                        padding: calc(clamp(0px, 0.6cqw, 2px) * var(--je-tag-scale, 1)) calc(clamp(${code ? 2 : 4}px, ${code ? 1.5 : 4.2}cqw, ${code ? 4 : 10}px) * var(--je-tag-scale, 1));
                        border-radius: calc(clamp(2px, 2.4cqw, 5px) * var(--je-tag-scale, 1));
                    }
                }
        `;
      return code ? css.replace(/([^{}]+)\{([^{}]*)\}/g, (_, rule, body) => {
        const padding = body.split(";").filter((declaration) => /^\s*padding\s*:/.test(declaration)).join(";");
        return `${rule}{${padding};}`;
      }) : css;
    }
    JE.core.tagSettingsMatrix = createSettingsMatrix((name) => {
      const layout = JE.core.tagLayout;
      const group = layout?.normalizeGroup(name);
      return group ? layout?.singleChipGroup?.(group) ?? false : false;
    });
    JE.core.tagScopes = createTagScopes({
      settings: () => JE.currentSettings,
      plugin: () => JE.pluginConfig,
      detectRow: () => typeof JE.detectCardRowSurface === "function" ? JE.detectCardRowSurface : null
    });
    const tagRenderer = {
      chipBaseCss,
      registerStyles,
      ensureStyles,
      releaseStyles,
      register,
      reinitialize,
      resolvePosition,
      isIgnoredContext,
      applyCornerStacking,
      scheduleCornerStacking
    };
    JE.core.tagRenderer = tagRenderer;
    console.log("🪼 Jellyfin Enhanced: Tag renderer core initialized");
  }

  // client/src/features/media-tags/pipeline/tag-renderer-base-entry.ts
  createTagRenderer(tagRuntimeHost());
})();
})();
//# sourceMappingURL=tag-renderer-base.js.map
