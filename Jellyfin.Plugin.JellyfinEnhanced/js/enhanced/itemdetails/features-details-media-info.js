(() => {
"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };

  // client/src/host/context.ts
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
  function sharedModule(id) {
    const namespace = window.JellyfinEnhanced?.core?.sharedModules?.[id];
    if (!namespace) throw new Error(`${id} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);
    return namespace;
  }
  function sharedExport(namespace, name) {
    return namespace[name];
  }

  // client/src/features/details-providers/links.ts
  var links_exports = {};
  __export(links_exports, {
    externalLink: () => externalLink,
    navigateRoute: () => navigateRoute,
    pathSegment: () => pathSegment,
    safeHref: () => safeHref,
    tagListRoute: () => tagListRoute
  });

  // client/src/features/shared/url-domain.ts
  function safeExternalUrl(value, base) {
    try {
      const url = new URL(value, base);
      return ["http:", "https:", "mailto:", "tel:", "ftp:", "blob:"].includes(url.protocol) ? value : "#";
    } catch {
      return "#";
    }
  }

  // client/generated-shared/stub/client/src/features/details-providers/host.ts
  var shared = /* @__PURE__ */ sharedModule("features/details-providers/host");
  var export0 = /* @__PURE__ */ sharedExport(shared, "api");
  var export1 = /* @__PURE__ */ sharedExport(shared, "bridge");
  var export3 = /* @__PURE__ */ sharedExport(shared, "currentUserId");
  var export4 = /* @__PURE__ */ sharedExport(shared, "dashboard");
  var export5 = /* @__PURE__ */ sharedExport(shared, "detailsContext");
  var export9 = /* @__PURE__ */ sharedExport(shared, "serverId");

  // client/src/features/details-providers/links.ts
  function safeHref(url) {
    return safeExternalUrl(url, window.location.href);
  }
  function externalLink(helpers, url, options = {}) {
    const shared4 = helpers?.createExternalLink;
    if (shared4) return shared4(url, options);
    const anchor = document.createElement("a");
    anchor.setAttribute("is", "emby-linkbutton");
    anchor.href = safeHref(url);
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    if (options.title) anchor.title = options.title;
    if (options.className) anchor.className = options.className;
    if (options.text) anchor.textContent = options.text;
    if (options.resetStyle) anchor.style.cssText = "padding:0;background:none;border-radius:0;min-width:0;";
    if (typeof options.setup === "function") options.setup(anchor);
    return anchor;
  }
  function tagListRoute(tag, serverId) {
    return `list.html?type=tag&tag=${encodeURIComponent(tag)}&serverId=${serverId}`;
  }
  function navigateRoute(route) {
    const host = export4();
    if (host && typeof host.navigate === "function") host.navigate(route);
    else window.location.hash = `!/${route}`;
  }
  function pathSegment(id) {
    return encodeURIComponent(id);
  }

  // client/generated-shared/publish/js/enhanced/itemdetails/features-details-media-info.js.ts
  publishSharedModules({ "features/details-providers/links": links_exports });

  // client/generated-shared/stub/client/src/features/details-providers/page.ts
  var shared2 = /* @__PURE__ */ sharedModule("features/details-providers/page");
  var export8 = /* @__PURE__ */ sharedExport(shared2, "lookupItem");

  // client/generated-shared/stub/client/src/features/details-providers/wire.ts
  var shared3 = /* @__PURE__ */ sharedModule("features/details-providers/wire");
  var export12 = /* @__PURE__ */ sharedExport(shared3, "decodeDetailsItem");
  var export52 = /* @__PURE__ */ sharedExport(shared3, "field");
  var export7 = /* @__PURE__ */ sharedExport(shared3, "isRecord");
  var export82 = /* @__PURE__ */ sharedExport(shared3, "list");
  var export92 = /* @__PURE__ */ sharedExport(shared3, "num");
  var export11 = /* @__PURE__ */ sharedExport(shared3, "str");

  // client/src/features/details-providers/media-info-domain.ts
  function formatSize(bytes) {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB", "TB", "PB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    const formattedSize = parseFloat((bytes / Math.pow(k, i)).toFixed(2));
    return `${formattedSize} ${sizes[i]}`;
  }
  function timeString(ticks, format) {
    const seconds = ticks / 1e7;
    const totalMinutes = Math.floor(seconds / 60);
    const totalHours = Math.floor(totalMinutes / 60);
    const totalDays = Math.floor(totalHours / 24);
    const totalMonths = Math.floor(totalDays / 30);
    const totalYears = Math.floor(totalDays / 365);
    let result = "";
    if (format === "hours") {
      if (totalHours >= 1) {
        result += `${totalHours}h`;
        const minutes = totalMinutes % 60;
        if (minutes > 0) result += ` ${minutes}m`;
      } else if (totalMinutes > 0) {
        result = `${totalMinutes}m`;
      } else {
        result = "0m";
      }
    } else if (totalYears >= 1) {
      result += `${totalYears}y`;
      const months = Math.floor(totalDays % 365 / 30);
      if (months > 0) result += ` ${months}mo`;
    } else if (totalMonths >= 1) {
      result += `${totalMonths}mo`;
      const days = totalDays % 30;
      if (days > 0) result += ` ${days}d`;
    } else if (totalDays >= 1) {
      result += `${totalDays}d`;
      const hours = totalHours % 24;
      if (hours > 0) result += ` ${hours}h`;
    } else if (totalHours >= 1) {
      result += `${totalHours}h`;
      const minutes = totalMinutes % 60;
      if (minutes > 0) result += ` ${minutes}m`;
    } else if (totalMinutes > 0) {
      result = `${totalMinutes}m`;
    } else {
      result = "0m";
    }
    return result;
  }
  function watchProgressText(progress, mode, format) {
    const safeTotal = Math.max(0, progress.totalRuntimeTicks || 0);
    const safePlayed = Math.max(0, Math.min(safeTotal, progress.totalPlaybackTicks || 0));
    if (mode === "time") return `${timeString(safePlayed, format)} / ${timeString(safeTotal, format)}`;
    if (mode === "remaining") {
      const remaining = Math.max(0, safeTotal - safePlayed);
      return `-${timeString(remaining, format)} / ${timeString(safeTotal, format)}`;
    }
    return `${progress.progress}%`;
  }
  function nextWatchProgressMode(mode) {
    if (mode === "percentage") return "time";
    if (mode === "time") return "remaining";
    return "percentage";
  }
  function resolveWatchProgressMode(mode) {
    return mode === "time" || mode === "remaining" ? mode : "percentage";
  }
  function progressIconSvg(progress) {
    const circumference = 2 * Math.PI * 8;
    const offset = circumference - progress / 100 * circumference;
    if (progress >= 100) {
      return `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" style="margin-right: 0.3em; display: inline-block; vertical-align: middle;">
                    <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/>
                    <path d="M9.5 15.5l-3-3 1.4-1.4L9.5 12.7l5.6-5.6 1.4 1.4z" fill="currentColor"/>
                </svg>`;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" style="margin-right: 0.3em; display: inline-block; vertical-align: middle;">
                <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2" opacity="0.2"/>
                <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"
                    style="stroke-dasharray: ${circumference}; stroke-dashoffset: ${offset}; transform: rotate(-90deg); transform-origin: 50% 50%; transition: stroke-dashoffset 0.3s ease;"/>
            </svg>`;
  }

  // client/src/features/details-providers/media-info.ts
  var JE = export1("Media info chips");
  var ctx = export5(JE);
  var _a;
  var internal = (_a = ctx.own).features ?? (_a.features = {});
  var HOUR = 60 * 60 * 1e3;
  var WATCHPROGRESS_CACHE_TTL = HOUR;
  var FILESIZE_CACHE_TTL = HOUR;
  var LANGUAGE_CACHE_TTL = HOUR;
  var ITEMSTATS_CACHE_TTL = HOUR;
  var watchProgressCache = /* @__PURE__ */ new Map();
  var fileSizeCache = /* @__PURE__ */ new Map();
  var audioLanguageCache = /* @__PURE__ */ new Map();
  var itemStatsRequests = /* @__PURE__ */ new Map();
  var epochNow = () => JE.session ? JE.session.getEpoch() : 0;
  var isEpochCurrent = (epoch) => !JE.session || JE.session.isCurrent(epoch);
  JE.session?.onUserChange("details-media-info", () => {
    watchProgressCache.clear();
    fileSizeCache.clear();
    audioLanguageCache.clear();
    for (const entry of itemStatsRequests.values()) {
      if (entry.visit) entry.ctl?.abort();
    }
    itemStatsRequests.clear();
  });
  function decodeStats(value) {
    return {
      size: export92(export52(value, "size")) ?? 0,
      progress: export92(export52(value, "progress")) ?? 0,
      totalPlaybackTicks: export92(export52(value, "totalPlaybackTicks")) ?? 0,
      totalRuntimeTicks: export92(export52(value, "totalRuntimeTicks")) ?? 0
    };
  }
  function fetchItemStats(itemId, mediaSourceId, prefetchVisit = null) {
    const key = `${itemId}|${mediaSourceId || ""}`;
    const now = Date.now();
    const existing = itemStatsRequests.get(key);
    if (existing && now - existing.ts < ITEMSTATS_CACHE_TTL) {
      if (existing.prefetched && !prefetchVisit) {
        existing.visit = null;
        existing.ctl = null;
        const claimEpoch = epochNow();
        return existing.promise.catch((error) => {
          if (!isEpochCurrent(claimEpoch)) throw error;
          return fetchItemStats(itemId, mediaSourceId);
        });
      }
      return existing.promise;
    }
    const path = `/item-stats/${export3()}/${itemId}${mediaSourceId ? `?mediaSourceId=${encodeURIComponent(mediaSourceId)}` : ""}`;
    const ctl = prefetchVisit ? new AbortController() : null;
    const plugin = JE.core?.api?.plugin;
    const promise = plugin ? plugin(path, ctl ? { skipRetry: true, signal: ctl.signal } : { skipRetry: true }) : export0().ajax({ type: "GET", url: export0().getUrl(`/JellyfinEnhanced${path}`), dataType: "json" });
    const entry = { promise, ts: now, prefetched: !!prefetchVisit, visit: prefetchVisit, ctl };
    itemStatsRequests.set(key, entry);
    promise.catch(() => {
      if (itemStatsRequests.get(key) === entry) itemStatsRequests.delete(key);
    });
    return promise;
  }
  function prefetchItemStats(itemId, mediaSourceId, { watchProgress, fileSize }, visit) {
    if (!JE.core?.api?.plugin) return;
    const now = Date.now();
    const progress = watchProgressCache.get(itemId);
    const size = fileSizeCache.get(`${itemId}|${mediaSourceId || ""}`);
    const needed = watchProgress && !(progress && now - progress.ts < WATCHPROGRESS_CACHE_TTL) || fileSize && !(size && now - size.ts < FILESIZE_CACHE_TTL);
    if (needed) fetchItemStats(itemId, mediaSourceId, visit).catch(() => {
    });
  }
  function discardItemStatsPrefetch(visit) {
    for (const [key, entry] of itemStatsRequests) {
      if (entry.visit !== visit) continue;
      entry.ctl?.abort();
      itemStatsRequests.delete(key);
    }
  }
  function nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }
  var LOADING_HTML = `<span class="material-icons" style="font-size: inherit; margin-right: 0.3em;">hourglass_empty</span> ...`;
  var timeFormat = () => JE.currentSettings?.watchProgressTimeFormat || "hours";
  function persistWatchProgressMode(mode) {
    const settings = JE.currentSettings ?? (JE.currentSettings = {});
    settings.watchProgressMode = mode;
    if (typeof JE.saveUserSettings === "function") JE.saveUserSettings("settings.json", settings);
  }
  async function displayWatchProgress(itemId, container, mediaSourceId = null) {
    if (container.classList.contains("hide")) container.classList.remove("hide");
    const existing = container.querySelector(".mediaInfoItem-watchProgress");
    if (existing) {
      if (existing.dataset.itemId === itemId) return;
      existing.remove();
    }
    const now = Date.now();
    const cached = watchProgressCache.get(itemId);
    const placeholder = document.createElement("div");
    placeholder.className = "mediaInfoItem mediaInfoItem-watchProgress";
    placeholder.dataset.itemId = itemId;
    placeholder.title = JE.t("watch_progress_tooltip");
    placeholder.style.display = "flex";
    placeholder.style.verticalAlign = "middle";
    placeholder.style.alignItems = "center";
    placeholder.style.margin = "0 1em 0 0 !important";
    placeholder.style.cursor = "pointer";
    placeholder.addEventListener("click", () => {
      const watchProgress = watchProgressCache.get(itemId);
      if (!watchProgress) return;
      const div = placeholder.querySelector(".mediaInfoItem-watchProgress-value");
      if (!div) return;
      const newMode = nextWatchProgressMode(div.dataset.type || "percentage");
      div.dataset.type = newMode;
      div.innerHTML = watchProgressText(watchProgress, newMode, timeFormat());
      persistWatchProgressMode(newMode);
    });
    placeholder.innerHTML = LOADING_HTML;
    container.appendChild(placeholder);
    const valueElement = (watchProgress) => {
      const valueDiv = document.createElement("div");
      valueDiv.className = "mediaInfoItem-watchProgress-value";
      const mode = resolveWatchProgressMode(JE.currentSettings?.watchProgressMode);
      valueDiv.dataset.type = mode;
      valueDiv.innerHTML = watchProgressText(watchProgress, mode, timeFormat());
      return valueDiv;
    };
    const render = (watchProgress) => {
      placeholder.innerHTML = progressIconSvg(watchProgress.progress);
      placeholder.appendChild(valueElement(watchProgress));
    };
    const renderUnavailable = () => render({ progress: 0, totalPlaybackTicks: 0, totalRuntimeTicks: 0 });
    const useCached = !!(cached && now - cached.ts < WATCHPROGRESS_CACHE_TTL);
    const statsPromise = useCached ? null : fetchItemStats(itemId, mediaSourceId);
    statsPromise?.catch(() => {
    });
    const performFetch = async () => {
      if (cached && useCached) {
        if (!cached.progress) {
          renderUnavailable();
          return;
        }
        render(cached);
        return;
      }
      const requestEpoch = epochNow();
      try {
        const stats = decodeStats(await statsPromise);
        await nextFrame();
        const watchProgress = {
          progress: stats.progress,
          totalPlaybackTicks: stats.totalPlaybackTicks,
          totalRuntimeTicks: stats.totalRuntimeTicks,
          ts: now
        };
        if (!isEpochCurrent(requestEpoch)) return;
        render(watchProgress);
        watchProgressCache.set(itemId, watchProgress);
      } catch (error) {
        console.error("🪼 Jellyfin Enhanced: Error fetching watch progress for ID %s:", itemId, error);
        if (!isEpochCurrent(requestEpoch)) return;
        renderUnavailable();
      }
    };
    void performFetch();
  }
  var SAVE_ICON = `<span class="material-icons" style="font-size: inherit; margin-right: 0.3em;">save</span>`;
  async function displayItemSize(itemId, container, mediaSourceId = null) {
    const requestEpoch = epochNow();
    const isCurrent = () => isEpochCurrent(requestEpoch);
    const cacheKey = `${itemId}|${mediaSourceId || ""}`;
    const existing = container.querySelector(".mediaInfoItem-fileSize");
    if (existing) {
      if (existing.dataset.itemId === itemId && existing.dataset.sourceId === (mediaSourceId || "")) return;
      existing.remove();
    }
    const now = Date.now();
    const cached = fileSizeCache.get(cacheKey);
    const placeholder = document.createElement("div");
    placeholder.className = "mediaInfoItem mediaInfoItem-fileSize";
    placeholder.dataset.itemId = itemId;
    placeholder.dataset.sourceId = mediaSourceId || "";
    placeholder.title = JE.t("file_size_tooltip");
    placeholder.style.display = "flex";
    placeholder.style.alignItems = "center";
    placeholder.style.margin = "0 1em 0 0 !important";
    placeholder.innerHTML = LOADING_HTML;
    container.appendChild(placeholder);
    const renderUnavailable = () => {
      placeholder.innerHTML = `${SAVE_ICON} -`;
    };
    const renderSize = (size) => {
      placeholder.style.verticalAlign = "middle";
      placeholder.innerHTML = `${SAVE_ICON}${formatSize(size)}`;
    };
    const useCached = !!(cached && now - cached.ts < FILESIZE_CACHE_TTL);
    const statsPromise = useCached ? null : fetchItemStats(itemId, mediaSourceId);
    statsPromise?.catch(() => {
    });
    const performFetch = async () => {
      if (cached && useCached) {
        if (cached.unavailable || !cached.size) {
          renderUnavailable();
          return;
        }
        renderSize(cached.size);
        return;
      }
      try {
        const stats = decodeStats(await statsPromise);
        await nextFrame();
        if (!isCurrent()) return;
        if (stats.size > 0) {
          renderSize(stats.size);
          fileSizeCache.set(cacheKey, { size: stats.size, unavailable: false, ts: now });
        } else {
          renderUnavailable();
          fileSizeCache.set(cacheKey, { size: null, unavailable: true, ts: now });
        }
      } catch (error) {
        if (!isCurrent()) return;
        console.error("🪼 Jellyfin Enhanced: Error fetching item size for ID %s:", itemId, error);
        renderUnavailable();
      }
    };
    void performFetch();
  }
  function mediaLanguage() {
    const language = JE.core?.mediaLanguage;
    if (!language) throw new Error("Jellyfin Enhanced media-language module unavailable");
    return language;
  }
  async function fetchTagDataItem(userId, itemId, mediaSourceId = null) {
    try {
      const client = export0();
      const response = await client.ajax({
        type: "POST",
        url: client.getUrl(`/JellyfinEnhanced/tag-data/${userId}`, mediaSourceId ? { mediaSourceId } : {}),
        data: JSON.stringify([itemId]),
        contentType: "application/json",
        dataType: "json"
      });
      return export12(export82(export52(response, "Items"))[0]);
    } catch {
      return null;
    }
  }
  async function fetchFirstEpisodeForLanguage(userId, parentId, firstEpisodeId = null) {
    if (firstEpisodeId) {
      const enriched = await fetchTagDataItem(userId, firstEpisodeId);
      if (enriched) return enriched;
    }
    const client = export0();
    const response = await client.ajax({
      type: "GET",
      url: client.getUrl("/Items", {
        ParentId: parentId,
        IncludeItemTypes: "Episode",
        IsVirtualItem: false,
        Recursive: true,
        SortBy: "PremiereDate",
        SortOrder: "Ascending",
        Limit: 1,
        Fields: "MediaStreams,MediaSources",
        userId: userId ?? ""
      }),
      dataType: "json"
    });
    const episode = export12(export82(export52(response, "Items"))[0]);
    if (!episode?.Id) return episode;
    return await fetchTagDataItem(userId, episode.Id) || episode;
  }
  var languageTagNameCache = /* @__PURE__ */ new Map();
  async function loadLanguageTagMap(itemId, languages) {
    const map = /* @__PURE__ */ new Map();
    const cfg = JE.pluginConfig;
    if (!cfg?.AudioLanguageTagSyncEnabled || !cfg.AudioLanguageTagShowAsLinks) return map;
    try {
      const codes = [...new Set(languages.map((language) => language.code))];
      const unknown = codes.filter((code) => !languageTagNameCache.has(code));
      const client = export0();
      const [item, names] = await Promise.all([
        export8(JE.helpers, itemId, false),
        unknown.length ? client.ajax({ type: "GET", url: client.getUrl("/JellyfinEnhanced/audio-language-tags", { codes: unknown.join(",") }), dataType: "json" }) : Promise.resolve({})
      ]);
      if (export7(names)) {
        for (const [code, tags] of Object.entries(names)) {
          languageTagNameCache.set(code, {
            baseTag: export11(export52(tags, "baseTag")) ?? export11(export52(tags, "BaseTag")) ?? null,
            variantTag: export11(export52(tags, "variantTag")) ?? export11(export52(tags, "VariantTag")) ?? null
          });
        }
      }
      const itemTags = new Map((export12(item)?.Tags ?? []).map((tag) => [tag.toLowerCase(), tag]));
      for (const code of codes) {
        const tags = languageTagNameCache.get(code);
        if (!tags) continue;
        const found = [tags.variantTag, tags.baseTag].filter((tag) => !!tag).map((tag) => itemTags.get(tag.toLowerCase())).find((tag) => !!tag);
        if (found) map.set(code, found);
      }
    } catch {
    }
    return map;
  }
  function createLanguageTagLink(tag) {
    const route = tagListRoute(tag, export9());
    const link = document.createElement("a");
    link.className = "audio-language-link";
    link.href = `#!/${route}`;
    link.title = tag;
    link.style.color = "inherit";
    link.style.textDecoration = "none";
    link.addEventListener("mouseenter", () => {
      link.style.textDecoration = "underline";
    });
    link.addEventListener("mouseleave", () => {
      link.style.textDecoration = "none";
    });
    link.addEventListener("click", (event) => {
      event.preventDefault();
      navigateRoute(route);
    });
    return link;
  }
  function collectLanguages(groups) {
    const languages = /* @__PURE__ */ new Map();
    for (const streams of groups) {
      for (const stream of streams ?? []) {
        if (stream.Type !== "Audio") continue;
        const code = stream.Language;
        if (!code || mediaLanguage().isLanguageless(code)) continue;
        let name;
        try {
          name = mediaLanguage().displayName(code);
        } catch {
          name = code.toUpperCase();
        }
        const language = { name, code };
        const key = JSON.stringify(language);
        if (!languages.has(key)) languages.set(key, language);
      }
    }
    return [...languages.values()];
  }
  async function displayAudioLanguages(itemId, container, mediaSourceId = null) {
    const requestEpoch = epochNow();
    const isCurrent = () => isEpochCurrent(requestEpoch);
    const cacheKey = `${itemId}|${mediaSourceId || ""}`;
    if (container.classList.contains("hide")) container.classList.remove("hide");
    const existing = container.querySelector(".mediaInfoItem-audioLanguage");
    if (existing) {
      if (existing.dataset.itemId === itemId && existing.dataset.sourceId === (mediaSourceId || "")) return;
      existing.remove();
    }
    const placeholder = document.createElement("div");
    placeholder.className = "mediaInfoItem mediaInfoItem-audioLanguage";
    placeholder.dataset.itemId = itemId;
    placeholder.dataset.sourceId = mediaSourceId || "";
    placeholder.title = JE.t("audio_language_tooltip");
    placeholder.style.display = "flex";
    placeholder.style.verticalAlign = "middle";
    placeholder.style.alignItems = "center";
    placeholder.style.margin = "0 1em 0 0 !important";
    placeholder.innerHTML = LOADING_HTML;
    container.appendChild(placeholder);
    const applyLangStyles = (el) => {
      el.title = JE.t("audio_language_tooltip");
      el.style.display = "flex";
      el.style.verticalAlign = "middle";
      el.style.alignItems = "center";
      el.style.flexDirection = "row";
      el.style.justifyContent = "center";
      el.style.flexWrap = "wrap";
      el.style.textAlign = "center";
      el.style.gap = "0.1em";
      try {
        el.style.setProperty("white-space", "normal", "important");
      } catch {
        el.style.whiteSpace = "normal";
      }
    };
    const renderUnavailable = () => {
      applyLangStyles(placeholder);
      placeholder.innerHTML = `<span class="material-icons" style="font-size: inherit; margin-right: 0.3em;">translate</span> -`;
    };
    const renderLanguages = (languages, tagMap = /* @__PURE__ */ new Map()) => {
      placeholder.innerHTML = "";
      placeholder.style.display = "flex";
      placeholder.style.alignItems = "center";
      placeholder.style.gap = "0.5em";
      placeholder.title = JE.t("audio_language_tooltip");
      const icon = document.createElement("span");
      icon.className = "material-icons";
      icon.style.fontSize = "inherit";
      icon.style.flexShrink = "0";
      icon.textContent = "translate";
      placeholder.appendChild(icon);
      const scrollContainer = document.createElement("div");
      scrollContainer.className = "audio-languages-container";
      scrollContainer.style.display = "flex";
      scrollContainer.style.flexWrap = "nowrap";
      scrollContainer.style.gap = "0.1em";
      scrollContainer.style.alignItems = "center";
      scrollContainer.style.overflowY = "hidden";
      if (languages.length > 3) {
        scrollContainer.style.overflowX = "auto";
        scrollContainer.style.scrollBehavior = "smooth";
        scrollContainer.style.whiteSpace = "nowrap";
        scrollContainer.style.maxWidth = "20em";
        scrollContainer.style.paddingBottom = "2px";
        scrollContainer.style.touchAction = "pan-x";
        scrollContainer.style.setProperty("-webkit-overflow-scrolling", "touch");
        scrollContainer.style.setProperty("scrollbar-width", "none");
        scrollContainer.style.setProperty("-ms-overflow-style", "none");
        scrollContainer.style.overflowY = "hidden";
        scrollContainer.addEventListener("wheel", (event) => {
          if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
            scrollContainer.scrollLeft += event.deltaY;
            event.preventDefault();
          }
        }, { passive: false });
        scrollContainer.style.setProperty("::-webkit-scrollbar", "display: none");
        const indicator = document.createElement("span");
        indicator.className = "scroll-indicator";
        indicator.style.display = "inline-block";
        indicator.style.opacity = "0.7";
        indicator.style.fontSize = "0.9em";
        indicator.style.fontFamily = "sans-serif";
        indicator.textContent = "⇆";
        placeholder.appendChild(indicator);
      }
      languages.forEach((language, index) => {
        const langSpan = document.createElement("span");
        langSpan.className = "audio-language-item";
        langSpan.dataset.lang = language.code;
        langSpan.dataset.langName = language.name;
        langSpan.style.whiteSpace = "nowrap";
        const countryCode = mediaLanguage().resolveFlag(language);
        if (countryCode) {
          const flag = document.createElement("img");
          flag.src = mediaLanguage().flagSrc(countryCode);
          flag.alt = `${language.name} flag`;
          flag.style.width = "18px";
          flag.style.marginRight = "0.3em";
          flag.style.borderRadius = "2px";
          flag.onerror = () => flag.remove();
          langSpan.appendChild(flag);
        }
        const languageTag = tagMap.get(language.code);
        if (languageTag) {
          const link = createLanguageTagLink(languageTag);
          link.textContent = language.name;
          langSpan.appendChild(link);
        } else {
          langSpan.appendChild(document.createTextNode(language.name));
        }
        scrollContainer.appendChild(langSpan);
        if (index < languages.length - 1) {
          const separator = document.createElement("span");
          separator.style.margin = "0 0.25em";
          separator.textContent = ", ";
          separator.style.whiteSpace = "nowrap";
          scrollContainer.appendChild(separator);
        }
      });
      placeholder.appendChild(scrollContainer);
    };
    const renderUnavailableInFrame = () => nextFrame().then(() => {
      if (isCurrent() && placeholder.isConnected) renderUnavailable();
    });
    const renderLanguagesInFrame = async (languages) => {
      const tagMap = await loadLanguageTagMap(itemId, languages);
      await nextFrame();
      if (isCurrent() && placeholder.isConnected) renderLanguages(languages, tagMap);
    };
    const cacheUnavailable = () => audioLanguageCache.set(cacheKey, { languages: [], unavailable: true, ts: Date.now() });
    const performFetch = async () => {
      const now = Date.now();
      const cached = audioLanguageCache.get(cacheKey);
      if (cached && now - cached.ts < LANGUAGE_CACHE_TTL) {
        if (cached.unavailable || cached.languages.length === 0) {
          renderUnavailable();
          return;
        }
        const tagMap = await loadLanguageTagMap(itemId, cached.languages);
        if (isCurrent() && placeholder.isConnected) renderLanguages(cached.languages, tagMap);
        return;
      }
      try {
        const userId = export3();
        const item = await fetchTagDataItem(userId, itemId, mediaSourceId) || export12(await export8(JE.helpers, itemId, true, userId));
        if (!isCurrent()) return;
        if (!item) throw new TypeError(`Item ${itemId} is unavailable`);
        let sourceItem = item;
        if (item.Type === "Series" || item.Type === "Season") {
          const episode = item.Id ? await fetchFirstEpisodeForLanguage(userId, item.Id, item.FirstEpisodeId ?? null) : null;
          if (!isCurrent()) return;
          if (!episode) {
            await renderUnavailableInFrame();
            if (!isCurrent()) return;
            cacheUnavailable();
            return;
          }
          sourceItem = episode;
        }
        const mediaSources = sourceItem.MediaSources;
        const selectedSource = mediaSourceId && mediaSources ? mediaSources.find((source) => source.Id === mediaSourceId) : void 0;
        const languages = selectedSource ? collectLanguages([selectedSource.MediaStreams ?? sourceItem.MediaStreams]) : collectLanguages([sourceItem.MediaStreams, ...(mediaSources ?? []).map((source) => source.MediaStreams)]);
        if (languages.length > 0) {
          await renderLanguagesInFrame(languages);
          if (!isCurrent()) return;
          audioLanguageCache.set(cacheKey, { languages, unavailable: false, ts: Date.now() });
        } else {
          await renderUnavailableInFrame();
          if (!isCurrent()) return;
          cacheUnavailable();
        }
      } catch (error) {
        if (!isCurrent()) return;
        console.error("🪼 Jellyfin Enhanced: Error fetching audio languages for %s:", itemId, error);
        await renderUnavailableInFrame();
      }
    };
    void performFetch();
  }
  internal.displayWatchProgress = displayWatchProgress;
  internal.displayItemSize = displayItemSize;
  internal.displayAudioLanguages = displayAudioLanguages;
  internal.prefetchItemStats = prefetchItemStats;
  internal.discardItemStatsPrefetch = discardItemStatsPrefetch;
})();
})();
//# sourceMappingURL=features-details-media-info.js.map
