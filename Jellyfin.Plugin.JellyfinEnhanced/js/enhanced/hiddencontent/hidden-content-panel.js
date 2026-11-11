(() => {
"use strict";
(() => {
  // client/src/host/context.ts
  function featureContext(feature, core, slots) {
    const shared2 = core.core?.featureContext;
    if (typeof shared2 !== "function") {
      throw new Error(`${feature}: JE.core.featureContext is missing; core/ui-kit.js must load before feature scripts`);
    }
    return shared2(feature, core, slots);
  }
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
  function hiddenContentContext(JE) {
    return featureContext("hidden-content", JE, {
      internalSlots: ["hiddenContent", "hiddenContentPage", "hiddenContentRuntime", "features"],
      // Same expression as registry() and runtime() below.
      internalsObject: () => JE.internals ?? (JE.internals = {})
    });
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
  function onDispose(JE, cleanup) {
    const cleanups = runtime(JE).cleanups;
    cleanups.add(cleanup);
    return () => cleanups.delete(cleanup);
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
  var export4 = /* @__PURE__ */ sharedExport(shared, "decodeSeerrItem");
  var export5 = /* @__PURE__ */ sharedExport(shared, "decodeSeerrSearch");

  // client/src/features/hidden-content/hidden-content-panel.ts
  (function(JE) {
    if (!installOnce(JE, "hidden-content-panel")) return;
    "use strict";
    const internal = registry(JE, "hiddenContent");
    const featureCtx = hiddenContentContext(JE);
    const { getHiddenData, unhideItem, unhideAll } = internal;
    const POSTER_MAX_WIDTH = 300;
    function createManagementHeader(count) {
      const header = document.createElement("div");
      header.className = "je-hidden-management-header";
      const h2 = document.createElement("h2");
      h2.textContent = `${JE.t("hidden_content_manage_title")} (${count})`;
      header.appendChild(h2);
      const closeBtn = document.createElement("button");
      closeBtn.className = "je-hidden-management-close";
      closeBtn.textContent = "×";
      header.appendChild(closeBtn);
      return header;
    }
    function createItemCard(item, onNavigate) {
      const imageToken = lease(JE, true);
      const card = document.createElement("div");
      card.className = "je-hidden-item-card";
      card.dataset.itemId = item.itemId || "";
      const hasJellyfinId = !!item.itemId;
      const hasTmdbId = !!item.tmdbId;
      const mediaType = item.type === "Series" ? "tv" : "movie";
      const posterLink = document.createElement("a");
      posterLink.className = "je-hidden-item-poster-link";
      if (hasJellyfinId) {
        posterLink.href = `#/details?id=${item.itemId}`;
      } else if (hasTmdbId) {
        posterLink.href = "#";
        posterLink.dataset.tmdbId = String(item.tmdbId);
        posterLink.dataset.mediaType = mediaType;
      }
      if (item.posterPath) {
        const img = document.createElement("img");
        img.className = "je-hidden-item-poster";
        img.src = `https://image.tmdb.org/t/p/w${POSTER_MAX_WIDTH}${item.posterPath}`;
        img.alt = "";
        img.loading = "lazy";
        posterLink.appendChild(img);
      } else if (hasJellyfinId) {
        const img = document.createElement("img");
        img.className = "je-hidden-item-poster";
        img.src = `${getApi().getUrl("/Items/" + item.itemId + "/Images/Primary", { maxWidth: POSTER_MAX_WIDTH })}`;
        img.alt = "";
        img.loading = "lazy";
        img.onerror = function() {
          const self = img;
          if (hasTmdbId && featureCtx.peer("jellyseerrMoreInfo")) {
            card.dataset.jellyfinRemoved = "1";
          }
          if (hasTmdbId && item.posterPath) {
            self.src = `https://image.tmdb.org/t/p/w${POSTER_MAX_WIDTH}${item.posterPath}`;
            self.onerror = function() {
              img.style.display = "none";
            };
          } else if (hasTmdbId && featureCtx.peer("jellyseerrAPI")) {
            self.onerror = function() {
              img.style.display = "none";
            };
            const fetchFn = mediaType === "tv" ? featureCtx.peer("jellyseerrAPI").fetchTvShowDetails : featureCtx.peer("jellyseerrAPI").fetchMovieDetails;
            fetchFn(parseInt(String(item.tmdbId), 10)).then(export4).then(function(details) {
              if (!imageToken.current() || !img.isConnected) return;
              const path = details && (details.posterPath || details.poster_path);
              if (path) {
                self.src = `https://image.tmdb.org/t/p/w${POSTER_MAX_WIDTH}${path}`;
              } else {
                self.style.display = "none";
              }
            }).catch(function() {
              self.style.display = "none";
            });
          } else if (item.type !== "Person" && item.name && featureCtx.peer("jellyseerrAPI") && featureCtx.peer("jellyseerrMoreInfo")) {
            self.style.display = "none";
            const wantType = item.type === "Series" || item.type === "Episode" || item.type === "Season" ? "tv" : "movie";
            featureCtx.peer("jellyseerrAPI").search(item.name).then(export5).then(function(res) {
              if (!imageToken.current() || !img.isConnected) return;
              const results = res && res.results || [];
              const hit = results.find(function(r) {
                return r.mediaType === wantType;
              }) || results.find(function(r) {
                return r.mediaType === "movie" || r.mediaType === "tv";
              });
              if (hit && hit.id) {
                card.dataset.jellyfinRemoved = "1";
                card.dataset.resolvedTmdbId = String(hit.id);
                card.dataset.resolvedMediaType = hit.mediaType || wantType;
                const p = hit.posterPath || hit.poster_path;
                if (p) {
                  self.src = `https://image.tmdb.org/t/p/w${POSTER_MAX_WIDTH}${p}`;
                  self.style.display = "";
                  self.onerror = function() {
                    img.style.display = "none";
                  };
                }
              }
            }).catch(function() {
            });
          } else {
            self.style.display = "none";
          }
        };
        posterLink.appendChild(img);
      } else {
        const placeholder = document.createElement("div");
        placeholder.className = "je-hidden-item-poster";
        posterLink.appendChild(placeholder);
      }
      card.appendChild(posterLink);
      const info = document.createElement("div");
      info.className = "je-hidden-item-info";
      const nameLink = document.createElement("a");
      nameLink.className = "je-hidden-item-name";
      nameLink.title = item.name || "";
      nameLink.textContent = item.name || "Unknown";
      if (hasJellyfinId) {
        nameLink.href = `#/details?id=${item.itemId}`;
      } else if (hasTmdbId) {
        nameLink.href = "#";
        nameLink.dataset.tmdbId = String(item.tmdbId);
        nameLink.dataset.mediaType = mediaType;
      }
      info.appendChild(nameLink);
      const navigableLinks = [posterLink, nameLink];
      for (const link of navigableLinks) {
        link.addEventListener("click", (e) => {
          const removedId = card.dataset.jellyfinRemoved === "1" ? hasTmdbId ? item.tmdbId : card.dataset.resolvedTmdbId : "";
          if (hasJellyfinId && removedId && featureCtx.peer("jellyseerrMoreInfo")) {
            e.preventDefault();
            featureCtx.peer("jellyseerrMoreInfo").open(parseInt(String(removedId), 10), hasTmdbId ? mediaType : card.dataset.resolvedMediaType || mediaType);
            if (onNavigate) onNavigate();
          } else if (hasJellyfinId) {
            if (onNavigate) onNavigate();
          } else if (hasTmdbId && featureCtx.peer("jellyseerrMoreInfo")) {
            e.preventDefault();
            featureCtx.peer("jellyseerrMoreInfo").open(parseInt(String(item.tmdbId), 10), mediaType);
            if (onNavigate) onNavigate();
          } else if (!hasJellyfinId) {
            e.preventDefault();
          }
        });
      }
      const metaDiv = document.createElement("div");
      metaDiv.className = "je-hidden-item-meta";
      const hiddenDate = item.hiddenAt ? new Date(item.hiddenAt).toLocaleDateString() : "";
      const _scope = (item.hideScope || "global").toLowerCase();
      const _scopeText = _scope === "continuewatching" ? JE.t("hidden_content_scope_cw_label") : _scope === "nextup" ? JE.t("hidden_content_scope_nextup_label") : _scope === "homesections" ? JE.t("hidden_content_scope_homesections_label") : "";
      metaDiv.textContent = [item.type, _scopeText, hiddenDate].filter(Boolean).join(" · ");
      info.appendChild(metaDiv);
      const unhideBtn = document.createElement("button");
      unhideBtn.className = "je-hidden-item-unhide";
      unhideBtn.textContent = _scope === "continuewatching" ? JE.t("hidden_content_add_back_to_cw") : JE.t("hidden_content_unhide");
      info.appendChild(unhideBtn);
      card.appendChild(info);
      return card;
    }
    function showManagementPanel() {
      const token = lease(JE, true);
      document.querySelector(".je-hidden-management-overlay")?.remove();
      const data = getHiddenData();
      const items = Object.entries(data.items || {}).map(([key, item]) => ({ ...item, _key: key }));
      const overlay = document.createElement("div");
      overlay.className = "je-hidden-management-overlay";
      const panel = document.createElement("div");
      panel.className = "je-hidden-management-panel";
      const header = createManagementHeader(items.length);
      const closeOverlay = () => {
        release();
        overlay.remove();
        document.removeEventListener("keydown", escHandler);
      };
      header.querySelector(".je-hidden-management-close")?.addEventListener("click", closeOverlay);
      panel.appendChild(header);
      const toolbar = createManagementToolbar();
      panel.appendChild(toolbar.element);
      const gridContainer = document.createElement("div");
      panel.appendChild(gridContainer);
      function renderGrid(filter) {
        const filtered = filter ? items.filter((i) => i.name?.toLowerCase().includes(filter.toLowerCase())) : items;
        filtered.sort((a, b) => {
          const da = a.hiddenAt ? new Date(a.hiddenAt).getTime() : 0;
          const db = b.hiddenAt ? new Date(b.hiddenAt).getTime() : 0;
          return db - da;
        });
        if (filtered.length === 0) {
          const emptyDiv = document.createElement("div");
          emptyDiv.className = "je-hidden-management-empty";
          emptyDiv.textContent = JE.t("hidden_content_manage_empty");
          gridContainer.replaceChildren(emptyDiv);
          return;
        }
        const grid = document.createElement("div");
        grid.className = "je-hidden-management-grid";
        for (const item of filtered) {
          const card = createItemCard(item, () => overlay.remove());
          card.querySelector(".je-hidden-item-unhide")?.addEventListener("click", () => {
            card.classList.add("je-hidden-item-removing");
            setTimeout(() => {
              if (!token.current() || !overlay.isConnected) return;
              unhideItem(item._key || item.itemId || "");
              card.remove();
              const remaining = gridContainer.querySelectorAll(".je-hidden-item-card").length;
              header.querySelector("h2").textContent = `${JE.t("hidden_content_manage_title")} (${remaining})`;
              if (remaining === 0) {
                const emptyDiv = document.createElement("div");
                emptyDiv.className = "je-hidden-management-empty";
                emptyDiv.textContent = JE.t("hidden_content_manage_empty");
                gridContainer.replaceChildren(emptyDiv);
              }
            }, 300);
          });
          grid.appendChild(card);
        }
        gridContainer.replaceChildren(grid);
      }
      renderGrid();
      toolbar.searchInput.addEventListener("input", () => renderGrid(toolbar.searchInput.value));
      toolbar.unhideAllBtn.addEventListener("click", () => {
        if (!token.current() || !confirm(JE.t("hidden_content_clear_confirm"))) return;
        unhideAll();
        const emptyDiv = document.createElement("div");
        emptyDiv.className = "je-hidden-management-empty";
        emptyDiv.textContent = JE.t("hidden_content_manage_empty");
        gridContainer.replaceChildren(emptyDiv);
        header.querySelector("h2").textContent = `${JE.t("hidden_content_manage_title")} (0)`;
      });
      overlay.appendChild(panel);
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) closeOverlay();
      });
      const escHandler = (e) => {
        if (e.key === "Escape") closeOverlay();
      };
      document.addEventListener("keydown", escHandler);
      const release = onDispose(JE, closeOverlay);
      document.body.appendChild(overlay);
    }
    function createManagementToolbar() {
      const toolbar = document.createElement("div");
      toolbar.className = "je-hidden-management-toolbar";
      const searchInput = document.createElement("input");
      searchInput.type = "text";
      searchInput.className = "je-hidden-management-search";
      searchInput.placeholder = JE.t("hidden_content_manage_search") || "Search hidden items...";
      toolbar.appendChild(searchInput);
      const unhideAllBtn = document.createElement("button");
      unhideAllBtn.className = "je-hidden-management-unhide-all";
      unhideAllBtn.textContent = JE.t("hidden_content_clear_all");
      toolbar.appendChild(unhideAllBtn);
      return { element: toolbar, searchInput, unhideAllBtn };
    }
    JE.session?.onUserChange("hidden-content-panel", () => {
      document.querySelectorAll(".je-hidden-management-overlay").forEach((el) => el.remove());
    });
    Object.assign(internal, { createItemCard, showManagementPanel });
  })(host.JellyfinEnhanced);
})();
})();
//# sourceMappingURL=hidden-content-panel.js.map
