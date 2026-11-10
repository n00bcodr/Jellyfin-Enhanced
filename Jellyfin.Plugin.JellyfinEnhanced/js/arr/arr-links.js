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
  var export0 = /* @__PURE__ */ sharedExport(shared, "api");
  var export1 = /* @__PURE__ */ sharedExport(shared, "bridge");
  var export7 = /* @__PURE__ */ sharedExport(shared, "hasApi");

  // client/generated-shared/stub/client/src/features/details-providers/page.ts
  var shared2 = /* @__PURE__ */ sharedModule("features/details-providers/page");
  var export3 = /* @__PURE__ */ sharedExport(shared2, "hashItemId");
  var export72 = /* @__PURE__ */ sharedExport(shared2, "lookupDetailsItem");
  var export11 = /* @__PURE__ */ sharedExport(shared2, "visibleDetailPage");

  // client/generated-shared/stub/client/src/features/details-providers/links.ts
  var shared3 = /* @__PURE__ */ sharedModule("features/details-providers/links");
  var export02 = /* @__PURE__ */ sharedExport(shared3, "externalLink");

  // client/generated-shared/stub/client/src/features/details-providers/wire.ts
  var shared4 = /* @__PURE__ */ sharedModule("features/details-providers/wire");
  var export5 = /* @__PURE__ */ sharedExport(shared4, "field");
  var export6 = /* @__PURE__ */ sharedExport(shared4, "int");
  var export73 = /* @__PURE__ */ sharedExport(shared4, "isRecord");
  var export8 = /* @__PURE__ */ sharedExport(shared4, "list");
  var export9 = /* @__PURE__ */ sharedExport(shared4, "num");
  var export112 = /* @__PURE__ */ sharedExport(shared4, "str");

  // client/src/features/details-providers/arr-domain.ts
  function parseUrlMappings(mappingsString) {
    const mappings = [];
    if (!mappingsString) return mappings;
    for (const line of mappingsString.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split("|").map((part) => part.trim());
      const [jellyfinUrl, arrUrl] = parts;
      if (parts.length === 2 && jellyfinUrl && arrUrl) mappings.push({ jellyfinUrl, arrUrl });
    }
    return mappings;
  }
  function mappedUrl(mappings, defaultUrl, serverAddress2) {
    if (!defaultUrl) return null;
    if (mappings.length === 0) return defaultUrl;
    const currentUrl = serverAddress2.replace(/\/+$/, "").toLowerCase();
    for (const mapping of mappings) {
      if (currentUrl === mapping.jellyfinUrl.replace(/\/+$/, "").toLowerCase()) return mapping.arrUrl.replace(/\/$/, "");
    }
    return defaultUrl;
  }
  function enabledInstances(instances, fallbackName, serverAddress2) {
    return (instances || []).filter((instance) => !!instance && instance.Enabled !== false).map((instance) => ({ name: instance.Name || fallbackName, url: mappedUrl(parseUrlMappings(instance.UrlMappings || ""), instance.Url, serverAddress2) })).filter((instance) => !!instance.url);
  }
  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return "";
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(0) + " MB";
    return (bytes / 1073741824).toFixed(1) + " GB";
  }
  function episodeStatus(episodeFileCount, episodeCount) {
    if (episodeFileCount === 0) return "missing";
    if (episodeFileCount >= episodeCount) return "complete";
    return "partial";
  }
  function decodeInstanceErrors(value) {
    const errors = export5(value, "errors");
    if (!Array.isArray(errors)) return void 0;
    return errors.map((error) => ({ instanceName: export112(export5(error, "instanceName")), reason: export112(export5(error, "reason")) }));
  }
  function decodeSonarrMatches(value, serverAddress2) {
    return export8(export5(value, "matches")).filter(export73).map((match) => ({
      instanceName: export112(match.instanceName),
      instanceUrl: mappedUrl(parseUrlMappings(export112(match.urlMappings) || ""), export112(match.instanceUrl), serverAddress2),
      titleSlug: export112(match.titleSlug) ?? "",
      episodeFileCount: export6(match.episodeFileCount) || 0,
      episodeCount: export6(match.episodeCount) || 0,
      sizeOnDisk: export9(match.sizeOnDisk) || 0,
      rootFolderPath: export112(match.rootFolderPath) || ""
    }));
  }
  function decodeRadarrMatches(value, serverAddress2) {
    return export8(export5(value, "matches")).filter(export73).map((match) => ({
      name: export112(match.instanceName),
      url: mappedUrl(parseUrlMappings(export112(match.urlMappings) || ""), export112(match.instanceUrl), serverAddress2),
      hasFile: match.hasFile === true,
      sizeOnDisk: export9(match.sizeOnDisk) || 0,
      rootFolderPath: export112(match.rootFolderPath) || ""
    }));
  }
  var trimSlash = (url) => url.replace(/\/$/, "");
  function sonarrSeriesUrl(match) {
    return `${trimSlash(match.instanceUrl)}/series/${match.titleSlug}`;
  }
  function radarrMovieUrl(match, tmdbId) {
    return `${trimSlash(match.url)}/movie/${tmdbId}`;
  }
  function singleSonarrLink(match, showStatusOnSingle) {
    const haveStats = match.episodeFileCount >= 0;
    const size = formatBytes(match.sizeOnDisk);
    const tipParts = [match.instanceName ?? ""];
    if (haveStats) tipParts.push(`${match.episodeFileCount}/${match.episodeCount} episodes`);
    if (size) tipParts.push(size);
    if (match.rootFolderPath) tipParts.push(match.rootFolderPath);
    return {
      url: sonarrSeriesUrl(match),
      status: showStatusOnSingle && haveStats ? episodeStatus(match.episodeFileCount, match.episodeCount) : null,
      badge: showStatusOnSingle && haveStats ? `${match.episodeFileCount}/${match.episodeCount}` : "",
      tip: tipParts.join("\n")
    };
  }
  function sonarrDropdownItems(matches) {
    return matches.map((match) => {
      const status = match.episodeFileCount < 0 ? null : episodeStatus(match.episodeFileCount, match.episodeCount);
      const badge = match.episodeFileCount < 0 ? "" : `${match.episodeFileCount}/${match.episodeCount}`;
      const size = formatBytes(match.sizeOnDisk);
      const tip = [badge ? `${badge} episodes` : null, size, match.rootFolderPath].filter(Boolean).join(" • ");
      return { name: match.instanceName ?? "", url: sonarrSeriesUrl(match), status, badge, size, tip };
    });
  }
  function singleRadarrLink(match, tmdbId, showStatusOnSingle) {
    const statusValue = match.hasFile ? "complete" : "missing";
    const badgeValue = match.hasFile ? "Downloaded" : "Missing";
    return {
      url: radarrMovieUrl(match, tmdbId),
      status: showStatusOnSingle ? statusValue : null,
      badge: showStatusOnSingle ? badgeValue : "",
      // The tooltip keeps the detail even when the visible badge is hidden.
      tip: [match.name, badgeValue, formatBytes(match.sizeOnDisk), match.rootFolderPath].filter(Boolean).join("\n")
    };
  }
  function radarrDropdownItems(matches, tmdbId) {
    return matches.map((match) => {
      const status = match.hasFile ? "complete" : "missing";
      const badge = match.hasFile ? "Downloaded" : "Missing";
      const size = formatBytes(match.sizeOnDisk);
      return { name: match.name ?? "", url: radarrMovieUrl(match, tmdbId), status, badge, size, tip: [badge, size, match.rootFolderPath].filter(Boolean).join(" • ") };
    });
  }
  function externalTmdbIds(hrefs) {
    const ids = { tmdb: null, hasTmdbLink: false };
    for (const href of hrefs) {
      if (href.includes("themoviedb.org/movie/")) {
        ids.tmdb = href.match(/\/movie\/(\d+)/)?.[1] ?? null;
        ids.hasTmdbLink = true;
      } else if (href.includes("themoviedb.org/tv/")) {
        ids.tmdb = href.match(/\/tv\/(\d+)/)?.[1] ?? null;
        ids.hasTmdbLink = true;
      }
    }
    return ids;
  }

  // client/src/features/details-providers/arr-links.ts
  var JE = export1("Arr links");
  var logPrefix = "🪼 Jellyfin Enhanced: Arr Links:";
  var serverAddress = () => export7() && typeof export0().serverAddress === "function" ? export0().serverAddress?.() ?? window.location.origin : window.location.origin;
  JE.initializeArrLinksScript = async function initializeArrLinksScript() {
    if (!JE.pluginConfig.ArrLinksEnabled) {
      console.log(`${logPrefix} Integration disabled in plugin settings.`);
      return;
    }
    const initEpoch = JE.session ? JE.session.getEpoch() : 0;
    const initIsCurrent = () => !JE.session || JE.session.isCurrent(initEpoch);
    const isAdmin = JE.helpers.isAdmin();
    console.log(`${logPrefix} Admin status: ${isAdmin}`);
    if (!isAdmin) {
      console.log(`${logPrefix} User is not an administrator. Links will not be shown.`);
      return;
    }
    console.log(`${logPrefix} Initializing...`);
    if (JE.pluginConfig.SonarrInstancesCorrupt && typeof JE.toast === "function") {
      JE.toast("⚠ Sonarr instance configuration is corrupt. Open the Jellyfin Enhanced config page to reset it.");
      console.error(`${logPrefix} SonarrInstances stored JSON is corrupt.`);
    }
    if (JE.pluginConfig.RadarrInstancesCorrupt && typeof JE.toast === "function") {
      JE.toast("⚠ Radarr instance configuration is corrupt. Open the Jellyfin Enhanced config page to reset it.");
      console.error(`${logPrefix} RadarrInstances stored JSON is corrupt.`);
    }
    let isAddingLinks = false;
    let debounceTimer = null;
    let observer = null;
    const sonarrCache = /* @__PURE__ */ new Map();
    const radarrCache = /* @__PURE__ */ new Map();
    try {
      let surfaceInstanceErrors2 = function(kind, errors) {
        if (!errors || errors.length === 0) {
          for (const key of [...toastedInstanceErrors]) if (key.startsWith(kind + "|")) toastedInstanceErrors.delete(key);
          return;
        }
        const seenThisTick = /* @__PURE__ */ new Set();
        for (const err of errors) {
          const key = `${kind}|${err.instanceName}|${err.reason}`;
          seenThisTick.add(key);
          if (toastedInstanceErrors.has(key)) continue;
          toastedInstanceErrors.add(key);
          if (typeof JE.toast === "function") {
            JE.toast("⚠ " + esc(kind) + ' instance "' + esc(err.instanceName || "unknown") + '" failed: ' + esc(err.reason));
          }
          console.warn(`${logPrefix} ${kind} instance "${err.instanceName}" error: ${err.reason}`);
        }
        for (const key of [...toastedInstanceErrors]) if (key.startsWith(kind + "|") && !seenThisTick.has(key)) toastedInstanceErrors.delete(key);
      }, surfaceGlobalFailure2 = function(kind, detail) {
        const flag = kind === "Sonarr" ? "sonarr" : "radarr";
        if (toastedGlobalFailure[flag]) return;
        toastedGlobalFailure[flag] = true;
        if (typeof JE.toast === "function") JE.toast("⚠ " + esc(kind) + " lookup failed; links unavailable. See console for details.");
        console.warn(`${logPrefix} ${kind} lookup backend failed:`, detail);
      }, iconImage2 = function(iconClass, alt) {
        const iconUrl = Object.prototype.hasOwnProperty.call(ICON_URLS, iconClass) ? ICON_URLS[iconClass] : void 0;
        if (!iconUrl) return null;
        const img = document.createElement("img");
        img.src = iconUrl;
        img.alt = alt;
        img.className = "arr-link-img";
        const iconSize = JE.helpers.getExternalLinkIconSize();
        img.style.width = `${iconSize}px`;
        img.style.height = `${iconSize}px`;
        return img;
      }, createLinkButton2 = function(label, url, iconClass, status = null, badge = "", tooltip = "") {
        const statusClass = status ? ` arr-link--${status}` : "";
        const button = export02(JE.helpers, url, { title: tooltip || label, className: `button-link emby-button arr-link${statusClass}` });
        if (asText()) {
          button.textContent = label;
          if (badge) {
            const badgeEl = document.createElement("span");
            badgeEl.className = `arr-badge arr-badge--${status || "missing"}`;
            badgeEl.textContent = badge;
            button.appendChild(badgeEl);
          }
        } else {
          const img = iconImage2(iconClass, label);
          if (img) button.appendChild(img);
        }
        return button;
      }, createDropdown2 = function(label, iconClass, items) {
        const wrapper = document.createElement("span");
        wrapper.className = "arr-dropdown";
        const themeVars = JE.themer?.getThemeVariables?.() || {};
        wrapper.style.setProperty("--arr-menu-bg", themeVars.secondaryBg || "rgba(20,20,28,0.98)");
        wrapper.style.setProperty("--arr-menu-text", themeVars.textColor || "#fff");
        wrapper.style.setProperty("--arr-menu-border", "rgba(255,255,255,0.2)");
        wrapper.style.setProperty("--arr-menu-hover", "rgba(255,255,255,0.1)");
        wrapper.style.setProperty("--arr-menu-muted", "rgba(255,255,255,0.55)");
        const toggle = document.createElement("a");
        toggle.setAttribute("is", "emby-linkbutton");
        toggle.className = "button-link emby-button arr-link";
        toggle.href = "#";
        toggle.title = `${label} (${items.length} instances)`;
        if (asText()) {
          toggle.textContent = label;
        } else {
          const img = iconImage2(iconClass, label);
          if (img) toggle.appendChild(img);
        }
        const arrow = document.createElement("span");
        arrow.textContent = "▾";
        arrow.style.cssText = "font-size:0.8em; opacity:0.8; margin-left:2px; line-height:1; vertical-align:middle; color: white;";
        toggle.appendChild(arrow);
        toggle.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          document.querySelectorAll(".arr-dropdown.open").forEach((dropdown) => {
            if (dropdown !== wrapper) dropdown.classList.remove("open");
          });
          wrapper.classList.toggle("open");
        });
        const menu = document.createElement("div");
        menu.className = "arr-dropdown-menu";
        for (const item of items) {
          const link = export02(JE.helpers, item.url, { title: item.tip || item.name, className: "arr-dropdown-item" });
          const dot = document.createElement("span");
          dot.className = `arr-dropdown-dot arr-dropdown-dot--${item.status || "missing"}`;
          link.appendChild(dot);
          const nameSpan = document.createElement("span");
          nameSpan.className = "arr-dropdown-item-name";
          nameSpan.textContent = item.name;
          link.appendChild(nameSpan);
          if (item.badge) {
            const badgeSpan = document.createElement("span");
            badgeSpan.className = `arr-badge arr-badge--${item.status || "missing"}`;
            badgeSpan.textContent = item.badge;
            link.appendChild(badgeSpan);
          }
          if (item.size) {
            const sizeSpan = document.createElement("span");
            sizeSpan.className = "arr-dropdown-item-stats";
            sizeSpan.textContent = item.size;
            link.appendChild(sizeSpan);
          }
          menu.appendChild(link);
        }
        wrapper.append(toggle, menu);
        return wrapper;
      };
      var surfaceInstanceErrors = surfaceInstanceErrors2, surfaceGlobalFailure = surfaceGlobalFailure2, iconImage = iconImage2, createLinkButton = createLinkButton2, createDropdown = createDropdown2;
      const SONARR_ICON_URL = JE.cdn.selfhst("svg/sonarr.svg");
      const RADARR_ICON_URL = JE.cdn.selfhst("svg/radarr-light-hybrid-light.svg");
      const BAZARR_ICON_URL = JE.cdn.selfhst("svg/bazarr.svg");
      const address = serverAddress();
      const config = JE.pluginConfig;
      const sonarrInstances = enabledInstances(config.SonarrInstances, "Sonarr", address);
      const radarrInstances = enabledInstances(config.RadarrInstances, "Radarr", address);
      if (sonarrInstances.length === 0 && config.SonarrUrl) {
        const legacyUrl = mappedUrl(parseUrlMappings(config.SonarrUrlMappings || ""), config.SonarrUrl, address);
        if (legacyUrl) sonarrInstances.push({ name: "Sonarr", url: legacyUrl });
      }
      if (radarrInstances.length === 0 && config.RadarrUrl) {
        const legacyUrl = mappedUrl(parseUrlMappings(config.RadarrUrlMappings || ""), config.RadarrUrl, address);
        if (legacyUrl) radarrInstances.push({ name: "Radarr", url: legacyUrl });
      }
      const bazarrUrl = mappedUrl(parseUrlMappings(config.BazarrUrlMappings || ""), config.BazarrUrl, address);
      const styleId = "arr-links-styles";
      if (!document.getElementById(styleId)) {
        const style = document.createElement("style");
        style.id = styleId;
        style.textContent = ARR_LINKS_CSS;
        document.head.appendChild(style);
      }
      const toastedGlobalFailure = { sonarr: false, radarr: false };
      const toastedInstanceErrors = /* @__PURE__ */ new Set();
      const esc = (value) => {
        const shared5 = JE.helpers.escHtml;
        if (shared5) return shared5(value);
        return String(value == null ? "" : value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
      };
      async function getSonarrSlugs(tvdbId) {
        if (!tvdbId) return [];
        const cached = sonarrCache.get(tvdbId);
        if (cached) return cached;
        try {
          const data = await JE.core.api.plugin(`/arr/series-slugs?tvdbId=${encodeURIComponent(tvdbId)}`);
          toastedGlobalFailure.sonarr = false;
          surfaceInstanceErrors2("Sonarr", decodeInstanceErrors(data));
          const results = decodeSonarrMatches(data, serverAddress());
          sonarrCache.set(tvdbId, results);
          return results;
        } catch (e) {
          surfaceGlobalFailure2("Sonarr", e);
          return [];
        }
      }
      async function getRadarrInstances(tmdbId) {
        if (!tmdbId) return [];
        const cached = radarrCache.get(tmdbId);
        if (cached) return cached;
        try {
          const data = await JE.core.api.plugin(`/arr/movie-instances?tmdbId=${encodeURIComponent(tmdbId)}`);
          toastedGlobalFailure.radarr = false;
          surfaceInstanceErrors2("Radarr", decodeInstanceErrors(data));
          const results = decodeRadarrMatches(data, serverAddress());
          radarrCache.set(tmdbId, results);
          return results;
        } catch (e) {
          surfaceGlobalFailure2("Radarr", e);
          return [];
        }
      }
      const ICON_URLS = {
        "arr-link-sonarr": SONARR_ICON_URL,
        "arr-link-radarr": RADARR_ICON_URL,
        "arr-link-bazarr": BAZARR_ICON_URL
      };
      const asText = () => !!JE.pluginConfig.ShowArrLinksAsText;
      async function addArrLinks() {
        if (isAddingLinks) return;
        const visiblePage = export11();
        if (!visiblePage) return;
        const anchorElement = visiblePage.querySelector(".itemExternalLinks");
        document.querySelectorAll("#itemDetailPage.hide .arr-link").forEach((staleLink) => {
          if (staleLink.previousSibling?.nodeType === Node.TEXT_NODE) staleLink.previousSibling.remove();
          staleLink.remove();
        });
        if (!anchorElement || anchorElement.querySelector(".arr-link")) return;
        const hashAtStart = window.location.hash;
        const isStillValidTarget = () => document.contains(anchorElement) && !anchorElement.closest("#itemDetailPage.hide") && window.location.hash === hashAtStart && initIsCurrent();
        const separator = () => anchorElement.appendChild(document.createTextNode(asText() ? ", " : " "));
        isAddingLinks = true;
        try {
          const itemId = export3();
          if (!itemId) return;
          const item = await export72(JE.helpers, itemId, false);
          if (!isStillValidTarget()) return;
          if (item?.Type !== "Movie" && item?.Type !== "Series") return;
          const ids = externalTmdbIds([...visiblePage.querySelectorAll(".itemExternalLinks a, .externalIdLinks a")].map((link) => link.href));
          if (!ids.hasTmdbLink) return;
          const showStatusOnSingle = JE.pluginConfig.ArrLinksShowStatusSingle === true;
          if (item.Type === "Series" && item.Name && sonarrInstances.length > 0) {
            const slugMatches = await getSonarrSlugs(item.ProviderIds.Tvdb || "");
            if (!isStillValidTarget()) return;
            const valid = slugMatches.filter((match) => !!match.instanceUrl);
            const [single] = valid;
            if (valid.length === 1 && single) {
              const link = singleSonarrLink(single, showStatusOnSingle);
              separator();
              anchorElement.appendChild(createLinkButton2("Sonarr", link.url, "arr-link-sonarr", link.status, link.badge, link.tip));
            } else if (valid.length > 1) {
              separator();
              anchorElement.appendChild(createDropdown2("Sonarr", "arr-link-sonarr", sonarrDropdownItems(valid)));
            }
          }
          const tmdbId = ids.tmdb;
          if (item.Type === "Movie" && tmdbId && radarrInstances.length > 0) {
            const matches = await getRadarrInstances(tmdbId);
            if (!isStillValidTarget()) return;
            const valid = matches.filter((match) => !!match.url);
            const [single] = valid;
            if (valid.length === 1 && single) {
              const link = singleRadarrLink(single, tmdbId, showStatusOnSingle);
              separator();
              anchorElement.appendChild(createLinkButton2("Radarr", link.url, "arr-link-radarr", link.status, link.badge, link.tip));
            } else if (valid.length > 1) {
              separator();
              anchorElement.appendChild(createDropdown2("Radarr", "arr-link-radarr", radarrDropdownItems(valid, tmdbId)));
            }
          }
          if (bazarrUrl && (item.Type === "Series" || item.Type === "Movie")) {
            separator();
            anchorElement.appendChild(createLinkButton2("Bazarr", `${bazarrUrl}/${item.Type === "Series" ? "series" : "movies"}/`, "arr-link-bazarr"));
          }
        } finally {
          isAddingLinks = false;
        }
      }
      if (!JE._arrDropdownCloserInstalled) {
        JE._arrDropdownCloserInstalled = true;
        document.addEventListener("click", (event) => {
          const target = event.target;
          if (!(target instanceof Element) || !target.closest(".arr-dropdown")) {
            document.querySelectorAll(".arr-dropdown.open").forEach((dropdown) => dropdown.classList.remove("open"));
          }
        });
      }
      if (!initIsCurrent()) return;
      observer = JE.helpers.createObserver("arr-links", () => {
        if (JE.session && !JE.session.isCurrent(initEpoch)) {
          if (observer) {
            observer.disconnect();
            console.log(`${logPrefix} Observer disconnected — user changed`);
          }
          return;
        }
        if (!JE.pluginConfig.ArrLinksEnabled) {
          if (observer) {
            observer.disconnect();
            console.log(`${logPrefix} Observer disconnected — feature disabled`);
          }
          return;
        }
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          void addArrLinks();
        }, 100);
      }, document.body, { childList: true, subtree: true }) || null;
      JE._arrLinksObserver = observer;
      console.log(`${logPrefix} Initialized successfully`);
    } catch (err) {
      console.error(`${logPrefix} Failed to initialize`, err);
    }
  };
  document.addEventListener("je:user-data-loaded", () => {
    if (!JE.pluginConfig.ArrLinksEnabled) return;
    try {
      JE._arrLinksObserver?.disconnect();
    } catch {
    }
    void JE.initializeArrLinksScript?.();
  });
  var ARR_LINKS_CSS = `
                    /* Status colors on the link button border */
                    .arr-link--complete { border-left: 3px solid #52b54b !important; }
                    .arr-link--partial  { border-left: 3px solid #e5a00d !important; }
                    .arr-link--missing  { border-left: 3px solid #666 !important; opacity: 0.7; }

                    /* Icon image inside the button */
                    .arr-link-img {
                        width: 25px;
                        height: 25px;
                        display: block;
                        object-fit: contain;
                    }

                    /* Status badge (text-mode only) */
                    .arr-badge {
                        font-size: 0.75em;
                        padding: 1px 5px;
                        border-radius: 3px;
                        margin-left: 6px;
                        vertical-align: middle;
                        font-weight: 600;
                    }
                    .arr-badge--complete { background: rgba(82,181,75,0.2); color: #52b54b; }
                    .arr-badge--partial  { background: rgba(229,160,13,0.2); color: #e5a00d; }
                    .arr-badge--missing  { background: rgba(102,102,102,0.2); color: #999; }

                    /* Dropdown wrapper — sits inline with sibling link buttons */
                    .arr-dropdown {
                        position: relative;
                        display: inline-block;
                    }

                    /* Dropdown menu — colours injected as CSS vars at render time */
                    .arr-dropdown-menu {
                        display: none;
                        position: absolute;
                        top: calc(100% + 6px);
                        left: 0;
                        z-index: 9999;
                        min-width: 240px;
                        background: var(--arr-menu-bg, rgba(20,20,28,0.98));
                        color: var(--arr-menu-text, #fff);
                        border: 1px solid var(--arr-menu-border, rgba(255,255,255,0.2));
                        border-radius: 8px;
                        box-shadow: 0 12px 32px rgba(0,0,0,0.6);
                        padding: 4px 0;
                        backdrop-filter: blur(12px);
                        -webkit-backdrop-filter: blur(12px);
                    }
                    .arr-dropdown.open .arr-dropdown-menu { display: block; }

                    .arr-dropdown-item {
                        display: flex;
                        align-items: center;
                        gap: 10px;
                        padding: 9px 14px;
                        color: var(--arr-menu-text, #fff);
                        text-decoration: none;
                        font-size: 0.9em;
                        white-space: nowrap;
                        transition: background 0.12s;
                    }
                    .arr-dropdown-item:hover {
                        background: var(--arr-menu-hover, rgba(255,255,255,0.1));
                        color: var(--arr-menu-text, #fff);
                    }
                    .arr-dropdown-item-name { flex: 1; font-weight: 500; }
                    .arr-dropdown-item-stats {
                        color: var(--arr-menu-muted, rgba(255,255,255,0.55));
                        font-size: 0.85em;
                    }
                    .arr-dropdown-dot {
                        width: 8px;
                        height: 8px;
                        border-radius: 50%;
                        flex-shrink: 0;
                    }
                    .arr-dropdown-dot--complete { background: #52b54b; }
                    .arr-dropdown-dot--partial  { background: #e5a00d; }
                    .arr-dropdown-dot--missing  { background: #888; }

                    /* Progress bar */
                    .arr-progress {
                        display: block;
                        height: 2px;
                        margin-top: 2px;
                        border-radius: 1px;
                        background: rgba(255,255,255,0.1);
                        overflow: hidden;
                    }
                    .arr-progress-fill { height: 100%; border-radius: 1px; transition: width 0.3s; }
                    .arr-progress-fill--complete { background: #52b54b; }
                    .arr-progress-fill--partial  { background: #e5a00d; }
                    .arr-progress-fill--missing  { background: #666; }
                `;
})();
})();
//# sourceMappingURL=arr-links.js.map
