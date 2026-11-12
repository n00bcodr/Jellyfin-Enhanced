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
  function selectionLease(JE, checkEditing = true) {
    const token = lease(JE, true), state = registry(JE, "hiddenContentPage").state;
    const version = state.adminLoadToken, uid = state.selectedAdminUserId, editing = state.adminEditMode;
    return { current: () => token.current() && state.adminLoadToken === version && state.selectedAdminUserId === uid && (!checkEditing || state.adminEditMode === editing) };
  }

  // client/generated-shared/stub/client/src/features/hidden-content/model.ts
  var shared = /* @__PURE__ */ sharedModule("features/hidden-content/model");
  var export3 = /* @__PURE__ */ sharedExport(shared, "decodeLibraryItem");
  var export5 = /* @__PURE__ */ sharedExport(shared, "decodeSeerrSearch");
  var export11 = /* @__PURE__ */ sharedExport(shared, "record");

  // client/src/features/hidden-content/hidden-content-page-admin.ts
  (function() {
    if (!installOnce(host.JellyfinEnhanced, "hidden-content-page-admin")) return;
    "use strict";
    const JE = host.JellyfinEnhanced;
    const internal = registry(JE, "hiddenContentPage");
    const featureCtx = hiddenContentContext(JE);
    const { state, POSTER_MAX_WIDTH } = internal;
    const renderPage = (...args) => internal.renderPage(...args);
    const logPrefix = "🪼 Jellyfin Enhanced: Hidden Content Page:";
    function resolveIsAdmin() {
      if (state.adminIsAdmin === null) {
        state.adminIsAdmin = JE.helpers.isAdmin();
      }
      return state.adminIsAdmin;
    }
    async function maybeInitAdminFilter() {
      const view = lease(JE, true);
      if (JE.pluginConfig && JE.pluginConfig.HiddenContentAdmin === false) return;
      if (state.adminUsers !== null || state.adminUsersLoading) return;
      state.adminUsersLoading = true;
      const token = state.adminLoadToken;
      try {
        const isAdmin = resolveIsAdmin();
        if (!isAdmin) return;
        const list = await JE.hiddenContent.fetchHiddenContentUsers();
        if (list === null) return;
        if (!view.current() || token !== state.adminLoadToken) return;
        state.adminUsers = list;
        renderPage();
      } catch (e) {
        console.warn(`${logPrefix} admin filter init failed`, e);
      } finally {
        if (token === state.adminLoadToken) state.adminUsersLoading = false;
      }
    }
    async function onAdminUserChange(value) {
      const view = lease(JE, true);
      const token = ++state.adminLoadToken;
      state.searchQuery = "";
      state.scopedOnly = false;
      state.adminEditMode = false;
      state.adminLoadError = false;
      if (!value) {
        state.selectedAdminUserId = null;
        state.adminItems = null;
        state.adminItemsUserId = null;
        state.adminUserName = "";
        renderPage();
        return;
      }
      state.selectedAdminUserId = value;
      const match = (state.adminUsers || []).find((u) => u.userId === value);
      state.adminUserName = match ? match.userName : value;
      state.adminItems = null;
      state.adminItemsUserId = null;
      renderPage();
      const items = await JE.hiddenContent.fetchUserHiddenItemsForAdmin(value);
      if (!view.current() || token !== state.adminLoadToken) return;
      if (items === null) {
        state.adminLoadError = true;
      } else {
        state.adminItems = items;
        state.adminItemsUserId = value;
      }
      renderPage();
    }
    function toOpaqueColor(c) {
      if (typeof c !== "string") return null;
      const s = c.trim();
      const m = s.match(/^rgba?\(([^)]+)\)$/i);
      if (m) {
        const parts = m[1]?.split(/[,\s/]+/).filter(Boolean) || [];
        if (parts.length >= 3) return `rgb(${parts[0]}, ${parts[1]}, ${parts[2]})`;
      }
      if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s)) return s;
      if (/^#([0-9a-f]{8})$/i.test(s)) return "#" + s.slice(1, 7);
      return null;
    }
    function applyAdminThemeVars(container) {
      if (!container || !(JE.themer && JE.themer.getThemeVariables)) return;
      let tv;
      try {
        tv = JE.themer.getThemeVariables() || {};
      } catch (e) {
        return;
      }
      if (isCssColor(tv.primaryAccent)) container.style.setProperty("--je-hc-accent", tv.primaryAccent);
      if (isCssColor(tv.textColor)) container.style.setProperty("--je-hc-text", tv.textColor);
    }
    function isCssColor(v) {
      if (typeof v !== "string" || v.trim() === "") return false;
      if (typeof CSS === "undefined" || typeof CSS.supports !== "function") return true;
      return CSS.supports("color", v.trim());
    }
    function createAdminViewingBadge() {
      const editing = state.adminEditMode;
      const chip = document.createElement("div");
      chip.className = "je-hidden-admin-viewing-badge" + (editing ? " je-hidden-admin-editing" : "");
      if (!editing) chip.title = JE.t("hidden_content_admin_readonly_note");
      const icon = document.createElement("span");
      icon.className = "material-icons je-hidden-admin-viewing-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = editing ? "edit" : "visibility";
      chip.appendChild(icon);
      const who = document.createElement("span");
      who.className = "je-hidden-admin-viewing-user";
      const displayName = state.adminUserName || state.selectedAdminUserId || "";
      who.textContent = JE.t(editing ? "hidden_content_admin_editing_user" : "hidden_content_admin_viewing_user", { userName: displayName });
      chip.appendChild(who);
      return chip;
    }
    function handleUnhide(key) {
      if (state.selectedAdminUserId) {
        if (state.adminEditMode) adminUnhide([key]);
        return;
      }
      JE.hiddenContent.unhideItem(key);
    }
    function handleUnhideMany(keys) {
      if (!Array.isArray(keys) || keys.length === 0) return;
      if (state.selectedAdminUserId) {
        if (state.adminEditMode) adminUnhide(keys);
        return;
      }
      keys.forEach((k) => JE.hiddenContent.unhideItem(k));
    }
    async function adminUnhide(keys) {
      const token = selectionLease(JE, false);
      const uid = state.selectedAdminUserId;
      if (!uid) return;
      const ok = await JE.hiddenContent.adminUnhideForUser(uid, keys);
      if (!ok || !token.current()) return;
      const removed = new Set(keys);
      if (Array.isArray(state.adminItems)) {
        state.adminItems = state.adminItems.filter((it) => !removed.has(it._key));
      }
      if (Array.isArray(state.adminUsers)) {
        state.adminUsers = state.adminUsers.map((x) => x.userId === uid ? { ...x, count: Math.max(0, (x.count || 0) - removed.size) } : x);
      }
      renderPage();
    }
    async function adminAddItem(targetUserId, result) {
      const token = selectionLease(JE, false);
      if (state.selectedAdminUserId !== targetUserId || !state.adminEditMode) return false;
      const item = {
        itemId: result.itemId || "",
        name: result.name || "",
        type: result.type || "",
        tmdbId: result.tmdbId ? String(result.tmdbId) : "",
        // Store the TMDB poster path for Seerr-sourced items (not in the library) so the hidden card
        // can render a poster; library items render from their Jellyfin image, so leave it blank.
        posterPath: result.source === "seerr" ? result.posterPath || "" : "",
        seriesId: "",
        seriesName: "",
        seasonNumber: null,
        episodeNumber: null,
        hideScope: "global",
        hiddenAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      const added = await JE.hiddenContent.adminHideForUser(targetUserId, [item]);
      if (added === false) return false;
      if (!token.current()) return true;
      const didAdd = typeof added === "number" ? added > 0 : true;
      const key = item.itemId || "tmdb-" + item.tmdbId;
      if (didAdd && Array.isArray(state.adminItems) && !state.adminItems.some((i) => (i._key || i.itemId) === key)) {
        state.adminItems = state.adminItems.concat([{ ...item, _key: key }]);
      }
      if (didAdd && Array.isArray(state.adminUsers)) {
        state.adminUsers = state.adminUsers.map((x) => x.userId === targetUserId ? { ...x, count: (x.count || 0) + 1 } : x);
      }
      renderPage();
      return true;
    }
    function openAdminAddModal() {
      const selection = selectionLease(JE);
      const uid = state.selectedAdminUserId;
      if (!uid) return;
      const userName = state.adminUserName || uid;
      const hadStaleOverlay = !!document.querySelector(".je-hidden-admin-add-overlay");
      document.querySelector(".je-hidden-admin-add-overlay")?.remove();
      const overlay = document.createElement("div");
      overlay.className = "je-hidden-management-overlay je-hidden-admin-add-overlay";
      const panel = document.createElement("div");
      panel.className = "je-hidden-management-panel";
      const header = document.createElement("div");
      header.className = "je-hidden-management-header";
      const h2 = document.createElement("h2");
      h2.textContent = JE.t("hidden_content_admin_add_title", { userName });
      const closeBtn = document.createElement("button");
      closeBtn.className = "je-hidden-management-close";
      closeBtn.textContent = "×";
      header.appendChild(h2);
      header.appendChild(closeBtn);
      panel.appendChild(header);
      const toolbar = document.createElement("div");
      toolbar.className = "je-hidden-management-toolbar";
      const searchInput = document.createElement("input");
      searchInput.type = "text";
      searchInput.className = "je-hidden-management-search";
      searchInput.placeholder = JE.t("hidden_content_admin_add_search");
      toolbar.appendChild(searchInput);
      panel.appendChild(toolbar);
      const grid = document.createElement("div");
      grid.className = "je-hidden-management-grid";
      const hint = document.createElement("div");
      hint.className = "je-hidden-management-empty";
      hint.textContent = JE.t("hidden_content_admin_add_hint");
      grid.appendChild(hint);
      panel.appendChild(grid);
      overlay.appendChild(panel);
      const prevBodyOverflow = hadStaleOverlay ? "" : document.body.style.overflow;
      const prevHtmlOverflow = hadStaleOverlay ? "" : document.documentElement.style.overflow;
      const close = () => {
        release();
        if (searchTimer) clearTimeout(searchTimer);
        searchToken++;
        overlay.remove();
        document.removeEventListener("keydown", esc);
        document.body.style.overflow = prevBodyOverflow;
        document.documentElement.style.overflow = prevHtmlOverflow;
      };
      const esc = (e) => {
        if (e.key === "Escape") close();
      };
      closeBtn.addEventListener("click", close);
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) close();
      });
      document.addEventListener("keydown", esc);
      const buildResultCard = (n) => {
        const key = n.itemId || "tmdb-" + n.tmdbId;
        const alreadyHidden = (state.adminItems || []).some((i) => (i._key || i.itemId) === key);
        const card = document.createElement("div");
        card.className = "je-hidden-item-card";
        const posterWrap = document.createElement("div");
        posterWrap.className = "je-hidden-item-poster-link";
        const img = document.createElement("img");
        img.className = "je-hidden-item-poster";
        img.loading = "lazy";
        img.alt = "";
        const tmdbPoster = n.posterPath ? "https://image.tmdb.org/t/p/w" + POSTER_MAX_WIDTH + n.posterPath : "";
        if (n.itemId) {
          img.src = getApi().getUrl("/Items/" + n.itemId + "/Images/Primary", { maxWidth: POSTER_MAX_WIDTH });
          img.onerror = tmdbPoster ? function() {
            img.onerror = function() {
              img.style.display = "none";
            };
            img.src = tmdbPoster;
          } : function() {
            img.style.display = "none";
          };
        } else if (tmdbPoster) {
          img.src = tmdbPoster;
          img.onerror = function() {
            img.style.display = "none";
          };
        } else {
          img.style.display = "none";
        }
        posterWrap.appendChild(img);
        card.appendChild(posterWrap);
        const info = document.createElement("div");
        info.className = "je-hidden-item-info";
        const name = document.createElement("div");
        name.className = "je-hidden-item-name";
        name.title = n.name || "";
        name.textContent = n.name || "Unknown";
        const meta = document.createElement("div");
        meta.className = "je-hidden-item-meta";
        const sourceLabel = n.source === "seerr" ? JE.t("hidden_content_admin_add_source_seerr") : JE.t("hidden_content_admin_add_source_library");
        meta.textContent = [n.type, n.year, sourceLabel].filter(Boolean).join(" · ");
        const btn = document.createElement("button");
        btn.className = "je-hidden-item-unhide";
        if (alreadyHidden) {
          btn.textContent = JE.t("hidden_content_admin_add_already");
          btn.disabled = true;
        } else {
          btn.textContent = JE.t("hidden_content_admin_add_hide");
          btn.addEventListener("click", async () => {
            btn.disabled = true;
            btn.textContent = JE.t("hidden_content_admin_add_hiding");
            if (!selection.current() || !overlay.isConnected) return;
            const ok = await adminAddItem(uid, n);
            if (!selection.current() || !overlay.isConnected) return;
            btn.textContent = ok ? JE.t("hidden_content_admin_add_added") : JE.t("hidden_content_admin_add_hide");
            if (!ok) btn.disabled = false;
          });
        }
        info.appendChild(name);
        info.appendChild(meta);
        info.appendChild(btn);
        card.appendChild(info);
        return card;
      };
      let searchTimer = null;
      let searchToken = 0;
      const showMessage = (text) => {
        const m = document.createElement("div");
        m.className = "je-hidden-management-empty";
        m.textContent = text;
        grid.replaceChildren(m);
      };
      const doSearch = async (q) => {
        const token = ++searchToken;
        const term = (q || "").trim();
        if (term.length < 2) {
          grid.replaceChildren(hint);
          return;
        }
        showMessage(JE.t("hidden_content_admin_add_searching"));
        const searchFailed = (source) => (error) => {
          console.warn(`${logPrefix} Admin add search (${source}) failed:`, error);
          return null;
        };
        const libP = JE.core.api.fetch(getApi().getUrl("/Items", {
          userId: getApi().getCurrentUserId(),
          searchTerm: term,
          IncludeItemTypes: "Movie,Series",
          Recursive: true,
          Limit: 24,
          Fields: "ProviderIds",
          ImageTypeLimit: 1,
          EnableImageTypes: "Primary"
        })).then((res) => {
          const items = export11(res).Items;
          if (!Array.isArray(items)) throw new Error("Invalid item list");
          return items.map(export3);
        }).catch(searchFailed("library"));
        const seerrApi = JE.pluginConfig?.JellyseerrEnabled ? featureCtx.peer("jellyseerrAPI") : void 0;
        const seerrP = seerrApi && seerrApi.search ? seerrApi.search(term, 1, { throwOnError: true }).then(export5).then((res) => res.results).catch(searchFailed("Seerr")) : Promise.resolve([]);
        const [libResult, seerrResult] = await Promise.all([libP, seerrP]);
        if (token !== searchToken || !selection.current() || !overlay.isConnected) return;
        const libItems = libResult ?? [], seerrItems = seerrResult ?? [];
        const failures = [libResult ? "" : JE.t("hidden_content_admin_add_failed"), seerrResult ? "" : JE.t("hidden_content_admin_add_seerr_failed")].filter(Boolean);
        const normalized = [];
        const seenTmdb = /* @__PURE__ */ new Set();
        for (const r of libItems) {
          const tmdb = r.ProviderIds && (r.ProviderIds.Tmdb || r.ProviderIds.tmdb) || "";
          if (tmdb) seenTmdb.add(String(tmdb));
          normalized.push({
            source: "library",
            itemId: r.Id || "",
            name: r.Name || "",
            type: r.Type || "",
            tmdbId: tmdb ? String(tmdb) : "",
            posterPath: "",
            year: r.ProductionYear || ""
          });
        }
        for (const r of seerrItems) {
          if (r.mediaType !== "movie" && r.mediaType !== "tv") continue;
          const tmdb = String(r.id);
          if (seenTmdb.has(tmdb)) continue;
          if (r.jellyfinMediaId) continue;
          seenTmdb.add(tmdb);
          normalized.push({
            source: "seerr",
            itemId: "",
            name: r.title || r.name || "",
            type: r.mediaType === "tv" ? "Series" : "Movie",
            tmdbId: tmdb,
            posterPath: r.posterPath || r.poster_path || "",
            year: ((r.releaseDate || r.firstAirDate || "") + "").slice(0, 4)
          });
        }
        if (!normalized.length) {
          showMessage(failures.length ? failures.join(" ") : JE.t("hidden_content_admin_add_none"));
          return;
        }
        const frag = document.createDocumentFragment();
        for (const text of failures) frag.appendChild(Object.assign(document.createElement("div"), { className: "je-hidden-management-empty", textContent: text }));
        for (const n of normalized) frag.appendChild(buildResultCard(n));
        grid.replaceChildren(frag);
      };
      searchInput.addEventListener("input", () => {
        if (searchTimer) clearTimeout(searchTimer);
        searchTimer = setTimeout(() => doSearch(searchInput.value), 300);
      });
      const release = onDispose(JE, close);
      document.body.style.overflow = "hidden";
      document.documentElement.style.overflow = "hidden";
      document.body.appendChild(overlay);
      searchInput.focus();
    }
    Object.assign(internal, {
      maybeInitAdminFilter,
      onAdminUserChange,
      toOpaqueColor,
      applyAdminThemeVars,
      isCssColor,
      createAdminViewingBadge,
      handleUnhide,
      handleUnhideMany,
      openAdminAddModal
    });
  })();
})();
})();
//# sourceMappingURL=hidden-content-page-admin.js.map
