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
    let registry2 = core.sharedModules;
    if (!registry2) {
      registry2 = /* @__PURE__ */ Object.create(null);
      Object.defineProperty(core, "sharedModules", { value: registry2, configurable: true, writable: true, enumerable: false });
    }
    for (const [id, namespace] of Object.entries(modules)) registry2[id] ?? (registry2[id] = namespace);
  }

  // client/src/features/hidden-content/model.ts
  var model_exports = {};
  __export(model_exports, {
    aliasMetadata: () => aliasMetadata,
    decodeDocument: () => decodeDocument,
    decodeItem: () => decodeItem,
    decodeLibraryItem: () => decodeLibraryItem,
    decodeSeerrItem: () => decodeSeerrItem,
    decodeSeerrSearch: () => decodeSeerrSearch,
    decodeUsers: () => decodeUsers,
    defaults: () => defaults,
    earliestHiddenAt: () => earliestHiddenAt,
    mergeHomeScope: () => mergeHomeScope,
    normalizeId: () => normalizeId,
    record: () => record,
    sameValue: () => sameValue,
    settingsFor: () => settingsFor,
    widestScope: () => widestScope
  });
  var defaults = {
    enabled: true,
    filterLibrary: true,
    filterDiscovery: true,
    filterUpcoming: true,
    filterCalendar: true,
    filterSearch: false,
    filterRecommendations: true,
    filterRequests: true,
    filterNextUp: true,
    filterContinueWatching: true,
    showHideConfirmation: true,
    showHideButtons: true,
    showButtonJellyseerr: true,
    showButtonLibrary: false,
    showButtonDetails: true,
    showButtonCast: false,
    experimentalHideCollections: false
  };
  function record(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid hidden-content object");
    return value;
  }
  function normalizeId(id) {
    return typeof id === "string" || typeof id === "number" || typeof id === "bigint" ? String(id).replace(/-/g, "").toLowerCase() : "";
  }
  var itemStrings = ["itemId", "name", "type", "posterPath", "seriesId", "seriesName", "hiddenAt", "hideScope"];
  function field(source, name) {
    return Object.prototype.hasOwnProperty.call(source, name) ? source[name] : source[name[0]?.toUpperCase() + name.slice(1)];
  }
  function decodeItem(value) {
    const raw = record(value);
    const item = { ...raw };
    for (const key of [...itemStrings, "tmdbId", "seasonNumber", "episodeNumber"]) delete item[key];
    for (const key of itemStrings) {
      const v = field(raw, key);
      if (v !== void 0 && v !== null) {
        if (typeof v !== "string") throw new Error(`Invalid ${key}`);
        item[key] = v;
      }
    }
    const tmdb = field(raw, "tmdbId");
    if (tmdb !== void 0 && tmdb !== null) {
      if (typeof tmdb !== "string" && (typeof tmdb !== "number" || !Number.isFinite(tmdb))) throw new Error("Invalid tmdbId");
      item.tmdbId = tmdb;
    }
    for (const key of ["seasonNumber", "episodeNumber"]) {
      const v = field(raw, key);
      if (v !== void 0) {
        if (v !== null && (typeof v !== "number" || !Number.isFinite(v))) throw new Error(`Invalid ${key}`);
        item[key] = v;
      }
    }
    for (const key of [...itemStrings, "tmdbId", "seasonNumber", "episodeNumber"]) delete item[key[0]?.toUpperCase() + key.slice(1)];
    return item;
  }
  function decodeDocument(value) {
    const raw = record(value);
    const rawItems = record(field(raw, "items"));
    const rawSettings = field(raw, "settings");
    const settings = rawSettings == null ? {} : { ...record(rawSettings) };
    for (const key of Object.keys(defaults)) {
      const v = field(settings, key);
      if (v !== void 0 && typeof v !== "boolean") throw new Error(`Invalid setting ${key}`);
      if (v !== void 0) settings[key] = v;
      delete settings[key[0]?.toUpperCase() + key.slice(1)];
    }
    const items = Object.fromEntries(Object.entries(rawItems).map(([key, item]) => [key, decodeItem(item)]));
    const document2 = { ...raw, items, settings };
    delete document2.Items;
    delete document2.Settings;
    return document2;
  }
  function settingsFor(data) {
    const settings = { ...defaults };
    for (const key of Object.keys(defaults)) {
      const v = data.settings[key];
      if (typeof v === "boolean") settings[key] = v;
    }
    return settings;
  }
  function decodeUsers(value) {
    const users = record(value).users;
    if (!Array.isArray(users)) throw new Error("Invalid admin user list");
    return users.map((value2) => {
      const u = record(value2);
      if (typeof u.userId !== "string" || typeof u.userName !== "string" || typeof u.count !== "number" || !Number.isInteger(u.count) || u.count < 0) throw new Error("Invalid admin user");
      return { userId: u.userId, userName: u.userName, count: u.count };
    });
  }
  function widestScope(a, b) {
    if (!a) return b || "";
    if (!b) return a;
    const left = a.toLowerCase(), right = b.toLowerCase();
    const ranks = { global: 4, homesections: 3, continuewatching: 2, nextup: 2 };
    const ra = ranks[left] ?? 1, rb = ranks[right] ?? 1;
    return ra === 2 && rb === 2 && left !== right ? "homesections" : ra >= rb ? left : right;
  }
  function mergeHomeScope(existing, incoming = "continuewatching") {
    const ex = existing.toLowerCase(), inc = incoming.toLowerCase();
    return !ex ? inc : ex === "global" || ex === "homesections" || ex === inc ? ex : "homesections";
  }
  function decodeLibraryItem(value) {
    const r = record(value);
    const result = {};
    for (const k of ["Id", "Name", "Type", "SeriesId", "SeriesName"]) {
      const v = r[k];
      if (v != null) {
        if (typeof v !== "string") throw new Error(`Invalid item ${k}`);
        result[k] = v;
      }
    }
    for (const k of ["ParentIndexNumber", "IndexNumber", "ProductionYear"]) {
      const v = r[k];
      if (v != null) {
        if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`Invalid item ${k}`);
        result[k] = v;
      }
    }
    if (r.ProviderIds != null) {
      const ids = record(r.ProviderIds);
      result.ProviderIds = {};
      for (const k of ["Tmdb", "tmdb"]) {
        const v = ids[k];
        if (v != null) {
          if (typeof v !== "string") throw new Error("Invalid provider ID");
          result.ProviderIds[k] = v;
        }
      }
    }
    return result;
  }
  function decodeSeerrItem(value) {
    const r = record(value), result = {};
    for (const k of ["mediaType", "posterPath", "poster_path", "title", "name", "releaseDate", "firstAirDate"]) {
      const v = r[k];
      if (v != null) {
        if (typeof v !== "string") throw new Error(`Invalid Seerr ${k}`);
        result[k] = v;
      }
    }
    if (r.id != null) {
      if (typeof r.id !== "number" || !Number.isFinite(r.id)) throw new Error("Invalid Seerr ID");
      result.id = r.id;
    }
    const info = r.mediaInfo && typeof r.mediaInfo === "object" && !Array.isArray(r.mediaInfo) ? record(r.mediaInfo) : {};
    const linked = [info.jellyfinMediaId, info.jellyfinMediaId4k].find((id) => typeof id === "string" && id !== "");
    if (linked) result.jellyfinMediaId = linked;
    return result;
  }
  function decodeSeerrSearch(value) {
    const results = record(value).results;
    if (!Array.isArray(results)) throw new Error("Invalid Seerr results");
    return { results: results.map(decodeSeerrItem) };
  }
  function sameValue(left, right) {
    if (Object.is(left, right)) return true;
    if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
    if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((v, i) => sameValue(v, right[i]));
    const a = record(left), b = record(right), keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => Object.prototype.hasOwnProperty.call(b, k) && sameValue(a[k], b[k]));
  }
  function parsedFraction(stamp, time) {
    const seconds = Math.floor(time / 1e3) * 1e3, millis = time - seconds;
    const probe = millis === 123 ? 456 : 123;
    const decimals = /\.(\d+)/g;
    for (let match = decimals.exec(stamp); match; match = decimals.exec(stamp)) {
      const digits = match[1];
      if (!digits) continue;
      const start = match.index + 1, end = start + digits.length;
      const replace = (value) => stamp.slice(0, start) + value + digits.slice(3) + stamp.slice(end);
      const changed = Date.parse(replace(String(probe).padStart(3, "0")));
      if (changed === seconds + probe) return digits;
      if (seconds + probe > 864e13 && !Number.isFinite(changed) && Date.parse(replace("000")) === seconds) return digits;
    }
    return String(millis).padStart(3, "0");
  }
  function compareHiddenTimes(left, right) {
    const a = Date.parse(left), b = Date.parse(right);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
    const seconds = Math.floor(a / 1e3) - Math.floor(b / 1e3);
    if (seconds !== 0) return seconds;
    const x = parsedFraction(left, a), y = parsedFraction(right, b), width = Math.max(x.length, y.length);
    const ax = x.padEnd(width, "0"), by = y.padEnd(width, "0");
    return ax < by ? -1 : ax > by ? 1 : 0;
  }
  function earliestHiddenAt(items) {
    let selected = "";
    for (const item of items) {
      const stamp = item.hiddenAt;
      if (!stamp) continue;
      if (!selected || compareHiddenTimes(stamp, selected) < 0) selected = stamp;
    }
    return selected || (/* @__PURE__ */ new Date()).toISOString();
  }
  function aliasMetadata(items) {
    const merged = Object.assign({}, ...items.slice().reverse());
    for (const key of ["name", "type", "posterPath", "seriesId", "seriesName"]) {
      const value = items.find((item) => !!item[key])?.[key];
      if (value !== void 0) merged[key] = value;
    }
    const tmdb = items.find((item) => item.tmdbId !== void 0 && item.tmdbId !== "")?.tmdbId;
    if (tmdb !== void 0) merged.tmdbId = tmdb;
    for (const key of ["seasonNumber", "episodeNumber"]) {
      const value = items.find((item) => item[key] != null)?.[key];
      if (value !== void 0) merged[key] = value;
    }
    return merged;
  }

  // client/generated-shared/publish/js/enhanced/homeremoval/features-remove-home.js.ts
  publishSharedModules({ "features/hidden-content/model": model_exports });

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
  function hiddenContentContext(JE) {
    return featureContext("hidden-content", JE, {
      internalSlots: ["hiddenContent", "hiddenContentPage", "hiddenContentRuntime", "features"],
      // Same expression as registry() and runtime() below.
      internalsObject: () => JE.internals ?? (JE.internals = {})
    });
  }
  function homeRemovalFacade(JE) {
    return { get buildNativeActionSheetItem() {
      return JE.internals?.features?.buildNativeActionSheetItem;
    } };
  }
  function runtime(JE) {
    const internals = JE.internals ?? (JE.internals = {});
    if (internals.hiddenContentRuntime) return internals.hiddenContentRuntime;
    const state = { modules: /* @__PURE__ */ new Set(), view: 0, policy: 0, queues: /* @__PURE__ */ new Map(), cleanups: /* @__PURE__ */ new Set(), identityCleanups: /* @__PURE__ */ new Set() };
    internals.hiddenContentRuntime = state;
    let counted = location.href;
    const invalidate = () => {
      counted = location.href;
      state.view++;
      for (const cleanup of [...state.cleanups]) cleanup();
    };
    const navigated = () => {
      if (location.href !== counted) invalidate();
    };
    window.addEventListener("hashchange", navigated);
    window.addEventListener("popstate", navigated);
    document.addEventListener("viewhide", invalidate);
    const invalidateIdentity = () => {
      invalidate();
      for (const cleanup of [...state.identityCleanups]) cleanup();
    };
    window.addEventListener("pagehide", (event) => {
      if ((event.target === window || event.target === document) && !event.persisted) invalidateIdentity();
    });
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
  function enqueueWrite(JE, operation) {
    const token = lease(JE), queues = runtime(JE).queues;
    const previous = queues.get(token.destination) ?? Promise.resolve();
    const next = previous.catch(() => void 0).then(() => {
      if (!token.current()) throw new Error("Stale hidden-content write");
      return operation(token.api);
    });
    queues.set(token.destination, next);
    const release = () => {
      if (queues.get(token.destination) === next) queues.delete(token.destination);
    };
    void next.then(release, release);
    return next;
  }

  // client/src/features/hidden-content/home-model.ts
  function isHomeSurface(value) {
    return value === "continuewatching" || value === "nextup";
  }
  function errorMessage(error, fallback) {
    if (!error || typeof error !== "object") return fallback;
    if ("responseJSON" in error && error.responseJSON && typeof error.responseJSON === "object") {
      const r = error.responseJSON;
      if ("message" in r && typeof r.message === "string") return r.message;
      if ("Message" in r && typeof r.Message === "string") return r.Message;
    }
    return "statusText" in error && typeof error.statusText === "string" ? error.statusText : fallback;
  }

  // client/src/features/hidden-content/features-remove-home.ts
  (function(JE) {
    if (!installOnce(JE, "features-remove-home")) return;
    "use strict";
    const internal = registry(JE, "features");
    const featureCtx = hiddenContentContext(JE);
    const showNotification = (message, type = "info") => {
      try {
        if (host.Dashboard?.alert) {
          host.Dashboard.alert(message);
        } else if (host.Emby?.Notifications) {
          host.Emby.Notifications.show({ title: message, type, timeout: 3e3 });
        } else {
          console.log(`🪼 Jellyfin Enhanced: Notification (${type}): ${message}`);
        }
      } catch (e) {
        console.error("🪼 Jellyfin Enhanced: Failed to show notification", e);
      }
    };
    const REMOVE_SURFACES = {
      continuewatching: { path: "continue-watching", labelKey: "remove_from_continue_watching", nameKey: "remove_surface_continue_watching", successKey: "remove_continue_watching_success" },
      nextup: { path: "next-up", labelKey: "remove_from_next_up", nameKey: "remove_surface_next_up", successKey: "remove_next_up_success" }
    };
    function buildNativeActionSheetItem(scroller, opts) {
      const ref = scroller.querySelector(".actionSheetMenuItem");
      const itemClass = (ref ? ref.getAttribute("class") || "" : "listItem listItem-button actionSheetMenuItem").replace(/\bselected\b/g, "").replace(/\s+/g, " ").trim();
      const tmp = document.createElement("div");
      tmp.innerHTML = `<button is="emby-button" type="button" class="${itemClass}" data-id="${opts.dataId}"><span class="actionsheetMenuItemIcon listItemIcon listItemIcon-transparent material-icons ${opts.icon}" aria-hidden="true"></span><div class="listItemBody actionsheetListItemBody"><div class="listItemBodyText actionSheetItemText"></div></div></button>`;
      const button = tmp.firstElementChild;
      if (!(button instanceof HTMLButtonElement)) throw new Error("Invalid action sheet button");
      button.querySelector(".actionSheetItemText").textContent = opts.text;
      return button;
    }
    function setActionSheetItemIcon(button, iconName) {
      const span = button.querySelector(".actionsheetMenuItemIcon");
      if (span) {
        span.className = `actionsheetMenuItemIcon listItemIcon listItemIcon-transparent material-icons ${iconName}`;
      }
    }
    function fitRemoveItemToMenu(button, scroller) {
      try {
        const dlg = scroller.closest(".dialog, .actionSheet");
        const viewportW = document.documentElement.clientWidth || window.innerWidth || 0;
        if (!dlg || !viewportW) return;
        const left = parseFloat(dlg.style.left);
        if (!Number.isFinite(left)) return;
        const width = dlg.offsetWidth;
        if (width <= viewportW - 20) {
          if (left + width > viewportW - 10) {
            dlg.style.left = Math.max(10, viewportW - width - 10) + "px";
          }
        } else {
          dlg.style.left = "10px";
          button.style.maxWidth = viewportW - 24 + "px";
          const text = button.querySelector(".actionSheetItemText");
          if (text) text.style.whiteSpace = "normal";
        }
      } catch (e) {
      }
    }
    const REMOVE_CONTEXT_TTL_MS = 5e3;
    if (!document.getElementById("je-home-hidden-style")) {
      const style = document.createElement("style");
      style.id = "je-home-hidden-style";
      style.textContent = ".je-hidden{display:none!important}";
      document.head.appendChild(style);
    }
    let sectionSurfaceCache = /* @__PURE__ */ new WeakMap();
    const HSS_ROW_CLASS_SURFACE = {
      continuewatching: "continuewatching",
      nextup: "nextup",
      continuewatchingnextup: "both"
    };
    const HOME_SECTION_DEFAULTS = Object.freeze([
      "smalllibrarytiles",
      "resume",
      "resumeaudio",
      "resumebook",
      "livetv",
      "nextup",
      "latestmedia",
      "none"
    ]);
    const HOME_SECTION_SLOTS = 10;
    const RESUME_SECTION_TYPES = /* @__PURE__ */ new Set(["resume", "resumeaudio", "resumebook"]);
    let homeSectionPrefs = null;
    let homeSectionPrefsUserId = null;
    let homeSectionPrefsInFlight = false;
    let configuredSectionsCache = /* @__PURE__ */ new WeakMap();
    function primeHomeSectionPrefs() {
      const token = lease(JE), api = token.api;
      let userId = null;
      try {
        userId = api.getCurrentUserId() || null;
      } catch (e) {
        return;
      }
      if (!userId) return;
      if (homeSectionPrefsUserId === userId && (homeSectionPrefs || homeSectionPrefsInFlight)) return;
      homeSectionPrefsUserId = userId;
      homeSectionPrefs = null;
      homeSectionPrefsInFlight = true;
      configuredSectionsCache = /* @__PURE__ */ new WeakMap();
      Promise.resolve().then(() => {
        if (!token.current()) throw new Error("Stale home preference request");
        return api.getDisplayPreferences("usersettings", userId, "emby");
      }).then((prefs) => {
        if (!token.current() || homeSectionPrefsUserId !== userId) return;
        homeSectionPrefs = record(record(prefs).CustomPrefs);
        configuredSectionsCache = /* @__PURE__ */ new WeakMap();
        sectionSurfaceCache = /* @__PURE__ */ new WeakMap();
      }).catch((e) => {
        console.warn("🪼 Jellyfin Enhanced: home-section preferences unavailable, falling back to row markup", e);
      }).then(() => {
        if (token.current() && homeSectionPrefsUserId === userId) homeSectionPrefsInFlight = false;
      });
    }
    function sectionSlotIndex(section) {
      for (const cls of section.classList) {
        const match = /^section(\d+)$/.exec(cls);
        if (match) return Number.parseInt(match[1] || "", 10);
      }
      return null;
    }
    function configuredSectionTypes(container) {
      if (!homeSectionPrefs) return null;
      const cached = configuredSectionsCache.get(container);
      if (cached) return cached;
      const types = [];
      for (let i = 0; i < HOME_SECTION_SLOTS; i++) {
        let type = homeSectionPrefs[`homesection${i}`] || HOME_SECTION_DEFAULTS[i] || "";
        if (type === "folders") type = HOME_SECTION_DEFAULTS[0] || "";
        types.push(String(type).toLowerCase());
      }
      if (container.querySelector(":scope > .section10") && !types.includes("smalllibrarytiles") && !types.includes("librarybuttons")) {
        types.unshift("smalllibrarytiles");
      }
      const frozen = Object.freeze(types);
      configuredSectionsCache.set(container, frozen);
      return frozen;
    }
    function nativeRowKindFromPreferences(section) {
      const container = section.closest(".homeSectionsContainer");
      if (!container) return null;
      const index = sectionSlotIndex(section);
      if (index === null) return null;
      primeHomeSectionPrefs();
      const types = configuredSectionTypes(container);
      const type = types ? types[index] : null;
      if (!type || type === "none") return null;
      if (RESUME_SECTION_TYPES.has(type)) return "continuewatching";
      if (type === "nextup") return "nextup";
      return "other";
    }
    function classifyRow(section) {
      for (const cls of section.classList) {
        const hit = HSS_ROW_CLASS_SURFACE[cls.toLowerCase()];
        if (hit) return hit;
      }
      if (section.hasAttribute("data-page")) return null;
      const configured = nativeRowKindFromPreferences(section);
      if (configured === "continuewatching" || configured === "nextup") return configured;
      if (configured === "other") return null;
      if (section.querySelector('a[href*="type=nextup"]')) return "nextup";
      const monitored = section.querySelector(".itemsContainer[data-monitor]");
      if (monitored && /playback/i.test(monitored.getAttribute("data-monitor") || "")) return "both";
      const title = (section.querySelector(".sectionTitle, h2, .headerText, .sectionTitle-sectionTitle")?.textContent || "").toLowerCase().trim();
      if (title.includes("next up")) return "nextup";
      if (title.includes("continue watching")) return "continuewatching";
      return null;
    }
    JE.detectCardRowSurface = function(el) {
      if (!el) return null;
      const card = (typeof el.closest === "function" ? el.closest(".card") : null) || el;
      const section = typeof card.closest === "function" ? card.closest(".section, .verticalSection, .homeSection") : null;
      if (!section) return null;
      let kind;
      if (sectionSurfaceCache.has(section)) {
        kind = sectionSurfaceCache.get(section);
      } else {
        kind = classifyRow(section);
        sectionSurfaceCache.set(section, kind);
      }
      if (!kind) return null;
      if (kind !== "both") return kind;
      const ticks = card.getAttribute && card.getAttribute("data-positionticks") || el.getAttribute && el.getAttribute("data-positionticks");
      return ticks ? "continuewatching" : "nextup";
    };
    JE.detectCardSurface = function(el) {
      if (!el) return null;
      const row = JE.detectCardRowSurface(el);
      if (row) return row;
      const card = (typeof el.closest === "function" ? el.closest(".card") : null) || el;
      const ticks = card.getAttribute && card.getAttribute("data-positionticks") || el.getAttribute && el.getAttribute("data-positionticks");
      return ticks ? "continuewatching" : null;
    };
    function optimisticHideRemovedCard(itemId, surface, card) {
      try {
        if (card && card.isConnected) {
          card.classList.add("je-hidden");
          card.setAttribute("data-je-hidden-direct", "1");
          return;
        }
        document.querySelectorAll(`.card[data-id="${CSS.escape(itemId)}"]`).forEach((c) => {
          if (JE.detectCardSurface(c) === surface) {
            c.classList.add("je-hidden");
            c.setAttribute("data-je-hidden-direct", "1");
          }
        });
      } catch (e) {
        console.warn("🪼 Jellyfin Enhanced: optimistic DOM-hide failed", e);
      }
    }
    async function removeFromHomeSurface(itemId, surface, card) {
      const token = lease(JE);
      const view = lease(JE, true);
      const config = isHomeSurface(surface) ? REMOVE_SURFACES[surface] : void 0;
      const userId = token.api.getCurrentUserId();
      if (!userId || !itemId || !config) {
        showNotification(JE.t("remove_continue_watching_error"), "error");
        return false;
      }
      const intent = featureCtx.own.hiddenContent?.captureItemIntent?.(itemId);
      try {
        await JE.hiddenContent?.flushPendingSave?.();
      } catch (e) {
        showNotification(JE.t("remove_continue_watching_error_api", { error: errorMessage(e, JE.t("unknown_error")) }), "error");
        return false;
      }
      if (!token.current() || intent?.current() === false) return false;
      return enqueueWrite(JE, async (api) => {
        if (intent?.current() === false) return false;
        try {
          const response = await api.ajax({
            type: "POST",
            url: api.getUrl(`/JellyfinEnhanced/${config.path}/hide/${itemId}`),
            data: "{}",
            contentType: "application/json",
            dataType: "json",
            headers: { "Content-Type": "application/json" }
          });
          if (record(response).success !== true) throw new Error("Invalid scoped hide response");
          if (!token.current()) return true;
          const newerLocalIntent = intent?.current() === false;
          if (view.current() && !newerLocalIntent) optimisticHideRemovedCard(itemId, surface, card);
          try {
            if (!newerLocalIntent) JE.hiddenContent?.markScopedHidden?.(itemId, surface);
          } catch (e) {
            console.warn("🪼 Jellyfin Enhanced: markScopedHidden mirror failed", e);
          }
          return true;
        } catch (error) {
          const message = errorMessage(error, JE.t("unknown_error"));
          if (token.current()) showNotification(JE.t("remove_continue_watching_error_api", { error: message }), "error");
          return false;
        }
      }).catch(() => false);
    }
    function closeOpenActionSheet() {
      try {
        const dialogs = document.querySelectorAll("dialog[open]");
        let dispatched = false;
        for (const dlg of dialogs) {
          if (typeof dlg.close === "function") {
            try {
              dlg.close();
              dispatched = true;
            } catch (e) {
            }
          }
        }
        if (dispatched) return true;
        const sheets = [...document.querySelectorAll(".actionSheet, .actionsheet, .dialogContainer .dialog, .dialog.opened")];
        const sheet = sheets.reverse().find((s) => s.offsetParent !== null) || sheets[0];
        if (sheet) {
          sheet.dispatchEvent(new KeyboardEvent("keydown", {
            key: "Escape",
            code: "Escape",
            keyCode: 27,
            which: 27,
            bubbles: true,
            cancelable: true
          }));
        }
        return true;
      } catch (err) {
        console.warn("🪼 Jellyfin Enhanced: action sheet close failed", err);
        return false;
      }
    }
    function hideEmptyHomeSections() {
      try {
        const sections = document.querySelectorAll(".verticalSection, .section, .homeSection");
        for (const section of sections) {
          const titleEl = section.querySelector(".sectionTitle, h2, .headerText, .sectionTitle-sectionTitle");
          const title = (titleEl?.textContent || "").toLowerCase().trim();
          const isCW = title.startsWith("continue watching");
          const isNextUp = title.startsWith("next up");
          if (!isCW && !isNextUp) continue;
          const cards = section.querySelectorAll(".card[data-positionticks], .card[data-id]");
          let visibleCount = 0;
          for (const card of cards) {
            if (card.classList.contains("je-hidden")) continue;
            if (card.style.display === "none") continue;
            visibleCount++;
          }
          if (visibleCount === 0) {
            section.classList.add("je-home-empty");
            section.style.display = "none";
          } else if (section.classList.contains("je-home-empty")) {
            section.classList.remove("je-home-empty");
            section.style.display = "";
          }
        }
      } catch (err) {
        console.warn("🪼 Jellyfin Enhanced: hideEmptyHomeSections failed", err);
      }
    }
    JE.hideEmptyHomeSections = hideEmptyHomeSections;
    function createRemoveButton(scroller, itemId, surface, card) {
      const config = REMOVE_SURFACES[surface] || REMOVE_SURFACES.continuewatching;
      const button = buildNativeActionSheetItem(scroller, {
        dataId: "remove-continue-watching",
        icon: "visibility_off",
        text: JE.t(config.labelKey)
      });
      button.dataset.jeItemId = itemId;
      button.dataset.jeSurface = surface;
      const buttonToken = lease(JE, true);
      button.addEventListener("click", async () => {
        if (!buttonToken.current()) return;
        const success = await removeFromHomeSurface(itemId, surface, card);
        if (success && buttonToken.current()) {
          showNotification(JE.t(config.successKey), "success");
          hideEmptyHomeSections();
        }
      });
      return button;
    }
    function getActiveActionSheetScroller() {
      const scrollers = document.querySelectorAll(".actionSheetScroller");
      for (let i = scrollers.length - 1; i >= 0; i--) {
        const scroller = scrollers[i];
        if (scroller && scroller.offsetParent !== null) return scroller;
      }
      return scrollers[scrollers.length - 1] ?? null;
    }
    JE.addRemoveButton = () => {
      if (!JE.currentSettings.removeContinueWatchingEnabled) return;
      const scroller = getActiveActionSheetScroller();
      if (!scroller) return;
      const existing = scroller.querySelector('[data-id="remove-continue-watching"]');
      const insertionPoint = scroller.querySelector('[data-id="playallfromhere"]') || scroller.querySelector('[data-id="resume"]') || scroller.querySelector('[data-id="play"]');
      if (!insertionPoint) {
        if (existing) existing.remove();
        return;
      }
      const ctx = JE.state.removeContext;
      if (!ctx || !ctx.itemId || Date.now() - (ctx.ts || 0) > REMOVE_CONTEXT_TTL_MS) return;
      const wantSurface = isHomeSurface(ctx.surface) ? ctx.surface : null;
      if (existing) {
        if (wantSurface && existing.dataset.jeItemId === ctx.itemId && existing.dataset.jeSurface === wantSurface) {
          JE.state.removeContext = null;
          return;
        }
        existing.remove();
      }
      if (!wantSurface) {
        JE.state.removeContext = null;
        return;
      }
      const removeButton = createRemoveButton(scroller, ctx.itemId, wantSurface, ctx.card);
      insertionPoint.after(removeButton);
      fitRemoveItemToMenu(removeButton, scroller);
      JE.state.removeContext = null;
    };
    JE.session?.onUserChange("hidden-content-home", () => {
      homeSectionPrefs = null;
      homeSectionPrefsUserId = null;
      homeSectionPrefsInFlight = false;
      configuredSectionsCache = /* @__PURE__ */ new WeakMap();
      sectionSurfaceCache = /* @__PURE__ */ new WeakMap();
      if (JE.state) JE.state.removeContext = null;
      document.querySelectorAll(".je-home-empty").forEach((el) => {
        el.classList.remove("je-home-empty");
        if (el instanceof HTMLElement) el.style.display = "";
      });
      document.querySelectorAll('[data-id="remove-continue-watching"],[data-id="je-multiselect-remove"]').forEach((el) => el.remove());
    });
    internal.showNotification = showNotification;
    internal.REMOVE_SURFACES = REMOVE_SURFACES;
    internal.buildNativeActionSheetItem = buildNativeActionSheetItem;
    JE.homeRemoval = homeRemovalFacade(JE);
    internal.setActionSheetItemIcon = setActionSheetItemIcon;
    internal.fitRemoveItemToMenu = fitRemoveItemToMenu;
    internal.removeFromHomeSurface = removeFromHomeSurface;
    internal.closeOpenActionSheet = closeOpenActionSheet;
    internal.hideEmptyHomeSections = hideEmptyHomeSections;
    internal.getActiveActionSheetScroller = getActiveActionSheetScroller;
  })(host.JellyfinEnhanced);
})();
})();
//# sourceMappingURL=features-remove-home.js.map
