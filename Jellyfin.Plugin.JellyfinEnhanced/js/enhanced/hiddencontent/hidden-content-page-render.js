(() => {
"use strict";
(() => {
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
  function selectionLease(JE, checkEditing = true) {
    const token = lease(JE, true), state = registry(JE, "hiddenContentPage").state;
    const version = state.adminLoadToken, uid = state.selectedAdminUserId, editing = state.adminEditMode;
    return { current: () => token.current() && state.adminLoadToken === version && state.selectedAdminUserId === uid && (!checkEditing || state.adminEditMode === editing) };
  }

  // client/src/features/hidden-content/hidden-content-page-render.ts
  (function() {
    if (!installOnce(host.JellyfinEnhanced, "hidden-content-page-render")) return;
    "use strict";
    const JE = host.JellyfinEnhanced;
    const internal = registry(JE, "hiddenContentPage");
    const {
      state,
      scopeBadgeText,
      showUnhideConfirmation,
      handleUnhide,
      handleUnhideMany,
      maybeInitAdminFilter,
      onAdminUserChange,
      toOpaqueColor,
      applyAdminThemeVars,
      isCssColor,
      createAdminViewingBadge,
      openAdminAddModal,
      createGroupCard,
      createSection
    } = internal;
    const createPageContainer = (...args) => internal.createPageContainer(...args);
    function createPageHeader(totalCount) {
      const header = document.createElement("div");
      header.className = "je-hidden-content-header";
      const title = document.createElement("h1");
      title.className = "je-hidden-content-title";
      title.textContent = JE.t("hidden_content_manage_title");
      const countSpan = document.createElement("span");
      countSpan.className = "je-hidden-content-count";
      countSpan.textContent = `(${totalCount})`;
      title.appendChild(countSpan);
      header.appendChild(title);
      return header;
    }
    function createToolbar() {
      const toolbar = document.createElement("div");
      toolbar.className = "je-hidden-content-toolbar";
      const searchInput = document.createElement("input");
      searchInput.type = "text";
      searchInput.className = "je-hidden-content-page-search";
      searchInput.placeholder = JE.t("hidden_content_manage_search") || "Search hidden items...";
      searchInput.value = state.searchQuery;
      toolbar.appendChild(searchInput);
      const scopedToggle = document.createElement("button");
      scopedToggle.className = "je-hidden-scoped-filter" + (state.scopedOnly ? " active" : "");
      scopedToggle.textContent = JE.t("hidden_content_scope_filter_button");
      toolbar.appendChild(scopedToggle);
      let adminUserSelect = null;
      let adminEditToggle = null;
      let adminAddBtn = null;
      const adminAllowed = !(JE.pluginConfig && JE.pluginConfig.HiddenContentAdmin === false);
      if (adminAllowed && state.adminIsAdmin === true && Array.isArray(state.adminUsers) && state.adminUsers.length > 0) {
        adminUserSelect = document.createElement("select");
        adminUserSelect.className = "je-hidden-admin-user-filter";
        adminUserSelect.setAttribute("aria-label", JE.t("hidden_content_admin_select_user"));
        const tv = JE.themer && JE.themer.getThemeVariables ? JE.themer.getThemeVariables() : {};
        const optColor = isCssColor(tv.textColor) ? tv.textColor : "#ffffff";
        const optBg = toOpaqueColor(tv.secondaryBg) || toOpaqueColor(tv.panelBg) || "#1f1f23";
        const styleOption = (opt) => {
          opt.style.backgroundColor = optBg;
          opt.style.color = optColor;
        };
        const ownOption = document.createElement("option");
        ownOption.value = "";
        ownOption.textContent = JE.t("hidden_content_admin_view_own");
        styleOption(ownOption);
        adminUserSelect.appendChild(ownOption);
        for (const u of state.adminUsers) {
          const opt = document.createElement("option");
          opt.value = u.userId;
          opt.textContent = `${u.userName} (${u.count})`;
          if (u.userId === state.selectedAdminUserId) opt.selected = true;
          styleOption(opt);
          adminUserSelect.appendChild(opt);
        }
        toolbar.appendChild(adminUserSelect);
        if (state.selectedAdminUserId) {
          adminEditToggle = document.createElement("button");
          adminEditToggle.className = "je-hidden-admin-edit-toggle" + (state.adminEditMode ? " active" : "");
          adminEditToggle.textContent = state.adminEditMode ? JE.t("hidden_content_admin_done") : JE.t("hidden_content_admin_edit");
          toolbar.appendChild(adminEditToggle);
          if (state.adminEditMode) {
            adminAddBtn = document.createElement("button");
            adminAddBtn.className = "je-hidden-admin-add-btn";
            adminAddBtn.textContent = JE.t("hidden_content_admin_add");
            toolbar.appendChild(adminAddBtn);
          }
        }
      }
      const unhideAllBtn = document.createElement("button");
      unhideAllBtn.className = "je-hidden-content-page-unhide-all";
      unhideAllBtn.textContent = JE.t("hidden_content_clear_all");
      toolbar.appendChild(unhideAllBtn);
      return { element: toolbar, searchInput, scopedToggle, unhideAllBtn, adminUserSelect, adminEditToggle, adminAddBtn };
    }
    function partitionItems(filtered) {
      const movies = [];
      const seriesRelated = [];
      const scopedMovies = [];
      const castActors = [];
      for (const item of filtered) {
        if (item.type === "Person") {
          castActors.push(item);
        } else if (item.type === "Series" || item.type === "Episode" || item.type === "Season") {
          seriesRelated.push(item);
        } else if (item.hideScope && item.hideScope !== "global") {
          scopedMovies.push(item);
        } else {
          movies.push(item);
        }
      }
      return { movies, seriesRelated, scopedMovies, castActors };
    }
    function renderMoviesSection(movies, scopedMovies, container) {
      const allMovies = [...movies, ...scopedMovies];
      if (allMovies.length === 0) return;
      const grid = document.createElement("div");
      grid.className = "je-hidden-content-page-grid";
      for (const item of allMovies) {
        const card = JE.hiddenContent.createItemCard(item);
        if (item.hideScope && item.hideScope !== "global") {
          const infoDiv = card.querySelector(".je-hidden-item-meta");
          if (infoDiv) {
            const badge = document.createElement("span");
            badge.className = "je-hidden-scoped-badge";
            badge.style.marginLeft = "6px";
            badge.textContent = scopeBadgeText(item.hideScope);
            infoDiv.appendChild(badge);
          }
        }
        attachUnhideHandler(card, item);
        grid.appendChild(card);
      }
      container.appendChild(createSection("hidden_content_group_movies", grid));
    }
    function renderSeriesSection(seriesRelated, container) {
      const showGroups = {};
      for (const item of seriesRelated) {
        let key, groupName, groupId;
        if (item.type === "Series") {
          key = item.itemId || item.name || "unknown";
          groupName = item.name || JE.t("hidden_content_unknown_show");
          groupId = item.itemId || "";
        } else {
          key = item.seriesId || item.seriesName || item.name || "unknown";
          groupName = item.seriesName || item.name || JE.t("hidden_content_unknown_show");
          groupId = item.seriesId || "";
        }
        if (!showGroups[key]) {
          showGroups[key] = { seriesName: groupName, seriesId: groupId, items: [] };
        }
        showGroups[key].items.push(item);
      }
      const groupKeys = Object.keys(showGroups);
      if (groupKeys.length === 0) return;
      const grid = document.createElement("div");
      grid.className = "je-hidden-content-page-grid";
      for (const key of groupKeys) {
        grid.appendChild(createGroupCard(showGroups[key]));
      }
      container.appendChild(createSection("hidden_content_group_series", grid, { expandable: true }));
    }
    function renderCastSection(castActors, container) {
      if (castActors.length === 0) return;
      const grid = document.createElement("div");
      grid.className = "je-hidden-content-page-grid";
      for (const item of castActors) {
        const card = JE.hiddenContent.createItemCard(item);
        attachUnhideHandler(card, item);
        grid.appendChild(card);
      }
      container.appendChild(createSection("hidden_content_group_cast", grid));
    }
    function renderPage(targetContainer) {
      const selection = selectionLease(JE);
      let container;
      if (targetContainer) {
        state._customTabContainer = targetContainer;
        container = targetContainer;
      } else if (state._customTabContainer && document.contains(state._customTabContainer) && window.location.hash.indexOf("userpluginsettings") === -1) {
        container = state._customTabContainer;
      } else {
        state._customTabContainer = null;
        const page = createPageContainer();
        container = document.getElementById("je-hidden-content-container");
        if (!page || !container) return;
      }
      if (!state.selectedAdminUserId && !JE.hiddenContent.isLoadOk()) {
        container.textContent = JE.t("hidden_content_admin_load_error");
        return;
      }
      applyAdminThemeVars(container);
      maybeInitAdminFilter();
      if (state.selectedAdminUserId && Array.isArray(state.adminUsers) && !state.adminUsers.some((u) => u.userId === state.selectedAdminUserId)) {
        if (state.selectedAdminUserId) state.adminLoadToken++;
        state.selectedAdminUserId = null;
        state.adminEditMode = false;
        state.adminItems = null;
        state.adminItemsUserId = null;
        state.adminUserName = "";
      }
      if (JE.pluginConfig && JE.pluginConfig.HiddenContentAdmin === false) {
        state.adminEditMode = false;
        if (state.selectedAdminUserId) state.adminLoadToken++;
        state.selectedAdminUserId = null;
        state.adminItems = null;
        state.adminItemsUserId = null;
        state.adminUserName = "";
        state.adminLoadError = false;
      }
      const viewingOther = !!state.selectedAdminUserId;
      const adminReady = viewingOther && state.adminItemsUserId === state.selectedAdminUserId;
      const allItems = viewingOther ? adminReady ? state.adminItems || [] : [] : JE.hiddenContent.getAllHiddenItems();
      const searchQuery = state.searchQuery.toLowerCase();
      let filtered = searchQuery ? allItems.filter((i) => {
        const nameMatch = i.name?.toLowerCase().includes(searchQuery);
        const seriesMatch = i.seriesName?.toLowerCase().includes(searchQuery);
        return nameMatch || seriesMatch;
      }) : [...allItems];
      filtered.sort((a, b) => {
        const da = a.hiddenAt ? new Date(a.hiddenAt).getTime() : 0;
        const db = b.hiddenAt ? new Date(b.hiddenAt).getTime() : 0;
        return db - da;
      });
      container.replaceChildren();
      const header = createPageHeader(allItems.length);
      if (viewingOther) {
        header.appendChild(createAdminViewingBadge());
      }
      container.appendChild(header);
      const toolbar = createToolbar();
      container.appendChild(toolbar.element);
      if (toolbar.adminUserSelect) {
        toolbar.adminUserSelect.addEventListener("change", (e) => {
          const value = toolbar.adminUserSelect?.value || "";
          try {
            toolbar.adminUserSelect?.blur();
          } catch (_) {
          }
          setTimeout(function() {
            if (selection.current()) onAdminUserChange(value);
          }, 0);
        });
      }
      if (toolbar.adminEditToggle) {
        toolbar.adminEditToggle.addEventListener("click", () => {
          state.adminEditMode = !state.adminEditMode;
          renderPage();
        });
      }
      if (toolbar.adminAddBtn) {
        toolbar.adminAddBtn.addEventListener("click", () => openAdminAddModal());
      }
      if (state.scopedOnly) {
        const scopedItems = (searchQuery ? allItems.filter((i) => {
          const nameMatch = i.name?.toLowerCase().includes(searchQuery);
          const seriesMatch = i.seriesName?.toLowerCase().includes(searchQuery);
          return nameMatch || seriesMatch;
        }) : [...allItems]).filter((i) => i.hideScope && i.hideScope !== "global");
        scopedItems.sort((a, b) => {
          const da = a.hiddenAt ? new Date(a.hiddenAt).getTime() : 0;
          const db = b.hiddenAt ? new Date(b.hiddenAt).getTime() : 0;
          return db - da;
        });
        filtered = scopedItems;
      }
      if (filtered.length === 0) {
        const emptyDiv = document.createElement("div");
        emptyDiv.className = "je-hidden-content-page-empty";
        if (viewingOther && state.adminLoadError) {
          emptyDiv.textContent = JE.t("hidden_content_admin_load_error");
          emptyDiv.style.cursor = "pointer";
          emptyDiv.addEventListener("click", () => onAdminUserChange(state.selectedAdminUserId));
        } else if (viewingOther && !adminReady) {
          emptyDiv.innerHTML = JE.core.ui.skeletonGridHtml(4, { minWidth: "100%", height: "3em", label: JE.t("hidden_content_admin_loading") });
        } else {
          emptyDiv.textContent = JE.t("hidden_content_manage_empty");
        }
        container.appendChild(emptyDiv);
      } else {
        const { movies, seriesRelated, scopedMovies, castActors } = partitionItems(filtered);
        renderMoviesSection(movies, scopedMovies, container);
        renderSeriesSection(seriesRelated, container);
        renderCastSection(castActors, container);
        if (viewingOther && !state.adminEditMode) {
          stripUnhideControls(container);
        }
      }
      toolbar.searchInput.addEventListener("input", () => {
        state.searchQuery = toolbar.searchInput.value;
        renderPage();
      });
      if (state.searchQuery) {
        toolbar.searchInput.focus();
        toolbar.searchInput.setSelectionRange(toolbar.searchInput.value.length, toolbar.searchInput.value.length);
      }
      toolbar.scopedToggle.addEventListener("click", () => {
        state.scopedOnly = !state.scopedOnly;
        renderPage();
        if (state.scopedOnly) {
          const expandBtns = container.querySelectorAll(".je-hidden-group-expand");
          expandBtns.forEach((btn) => {
            if (!btn.classList.contains("expanded")) btn.click();
          });
          const expandAllBtn = container.querySelector(".je-hidden-expand-all-btn");
          if (expandAllBtn) {
            expandAllBtn.textContent = JE.t("hidden_content_collapse_all");
          }
        }
      });
      if (viewingOther && !state.adminEditMode) {
        toolbar.unhideAllBtn.style.display = "none";
      } else {
        toolbar.unhideAllBtn.addEventListener("click", () => {
          showUnhideConfirmation(JE.t("hidden_content_clear_confirm") || "Unhide all items?", () => {
            if (viewingOther) {
              handleUnhideMany((state.adminItems || []).map((it) => it._key || it.itemId || ""));
            } else {
              JE.hiddenContent.unhideAll();
            }
          });
        });
      }
    }
    function stripUnhideControls(container) {
      container.querySelectorAll(
        ".je-hidden-item-unhide, .je-hidden-group-unhide, .je-hidden-group-item-unhide, .je-hidden-group-unhide-all"
      ).forEach((btn) => btn.remove());
    }
    function attachUnhideHandler(card, item) {
      const selection = selectionLease(JE);
      const unhideBtn = card.querySelector(".je-hidden-item-unhide");
      if (unhideBtn) {
        unhideBtn.addEventListener("click", () => {
          showUnhideConfirmation(JE.t("hidden_content_unhide_confirm") || "Unhide this item?", () => {
            card.classList.add("je-hidden-item-removing");
            setTimeout(() => {
              if (!selection.current()) return;
              handleUnhide(item._key || item.itemId || "");
            }, 300);
          }, item.name || "this item");
        });
      }
    }
    Object.assign(internal, { renderPage });
  })();
})();
})();
//# sourceMappingURL=hidden-content-page-render.js.map
