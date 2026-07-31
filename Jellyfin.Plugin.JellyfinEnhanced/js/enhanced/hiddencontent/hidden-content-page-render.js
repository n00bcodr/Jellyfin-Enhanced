/**
 * @file Hidden Content Page — full page render: header, toolbar (search,
 * scoped filter, admin controls), section rendering, and the read-only
 * strip of unhide controls.
 * Split from hidden-content-page.js (code motion; bodies verbatim).
 */
(function () {
  "use strict";

  const JE = window.JellyfinEnhanced;
  JE.internals = JE.internals || {};
  const internal = JE.internals.hiddenContentPage = JE.internals.hiddenContentPage || {};

  const { state, scopeBadgeText, showUnhideConfirmation,
    handleUnhide, handleUnhideMany, maybeInitAdminFilter, onAdminUserChange,
    toOpaqueColor, applyAdminThemeVars, isCssColor, createAdminViewingBadge,
    openAdminAddModal, createGroupCard, createSection } = internal;
  // Late-bound cross-module reference (defined in hidden-content-page-nav.js).
  const createPageContainer = (...args) => internal.createPageContainer(...args);

  /**
   * Creates the page header with title and item count.
   * @param {number} totalCount Total number of hidden items.
   * @returns {HTMLElement} The header element.
   */
  function createPageHeader(totalCount) {
    const header = document.createElement("div");
    header.className = "je-hidden-content-header";
    const title = document.createElement("h1");
    title.className = "je-hidden-content-title";
    title.textContent = JE.t('hidden_content_manage_title');
    const countSpan = document.createElement("span");
    countSpan.className = "je-hidden-content-count";
    countSpan.textContent = `(${totalCount})`;
    title.appendChild(countSpan);
    header.appendChild(title);
    return header;
  }

  /**
   * Creates the toolbar with search, scoped filter toggle, and unhide-all button.
   * @returns {{ element: HTMLElement, searchInput: HTMLInputElement, scopedToggle: HTMLButtonElement, unhideAllBtn: HTMLButtonElement }}
   */
  function createToolbar() {
    const toolbar = document.createElement("div");
    toolbar.className = "je-hidden-content-toolbar";

    const searchInput = document.createElement("input");
    searchInput.type = "text";
    searchInput.className = "je-hidden-content-page-search";
    searchInput.placeholder = JE.t('hidden_content_manage_search') || 'Search hidden items...';
    searchInput.value = state.searchQuery;
    toolbar.appendChild(searchInput);

    const scopedToggle = document.createElement("button");
    scopedToggle.className = 'je-hidden-scoped-filter' + (state.scopedOnly ? ' active' : '');
    scopedToggle.textContent = JE.t('hidden_content_scope_filter_button');
    toolbar.appendChild(scopedToggle);

    // Admin-only user filter: pick another user to view (and, in edit mode, edit)
    // their hidden content. Only rendered once admin status is confirmed and there is at least one
    // other user with hidden items; the server still gates the underlying data.
    let adminUserSelect = null;
    let adminEditToggle = null;
    let adminAddBtn = null;
    const adminAllowed = !(JE.pluginConfig && JE.pluginConfig.HiddenContentAdmin === false);
    if (adminAllowed && state.adminIsAdmin === true && Array.isArray(state.adminUsers) && state.adminUsers.length > 0) {
      // A plain native <select> styled to match the page's own toolbar controls (search / scoped
      // toggle), so it follows the dark theme instead of the browser default. The option pop-up is
      // themed too — options must be OPAQUE because a translucent colour lets the OS white show through.
      adminUserSelect = document.createElement("select");
      adminUserSelect.className = "je-hidden-admin-user-filter";
      adminUserSelect.setAttribute('aria-label', JE.t('hidden_content_admin_select_user'));

      const tv = (JE.themer && JE.themer.getThemeVariables) ? JE.themer.getThemeVariables() : {};
      const optColor = isCssColor(tv.textColor) ? tv.textColor : '#ffffff';
      const optBg = toOpaqueColor(tv.secondaryBg) || toOpaqueColor(tv.panelBg) || '#1f1f23';
      const styleOption = (opt) => { opt.style.backgroundColor = optBg; opt.style.color = optColor; };

      const ownOption = document.createElement("option");
      ownOption.value = '';
      ownOption.textContent = JE.t('hidden_content_admin_view_own');
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

      // Edit toggle: only while viewing another user (admin access is already allowed at this point).
      if (state.selectedAdminUserId) {
        adminEditToggle = document.createElement("button");
        adminEditToggle.className = 'je-hidden-admin-edit-toggle' + (state.adminEditMode ? ' active' : '');
        adminEditToggle.textContent = state.adminEditMode
          ? JE.t('hidden_content_admin_done')
          : JE.t('hidden_content_admin_edit');
        toolbar.appendChild(adminEditToggle);

        // Add-items button — only while actively editing this user's hidden content.
        if (state.adminEditMode) {
          adminAddBtn = document.createElement("button");
          adminAddBtn.className = 'je-hidden-admin-add-btn';
          adminAddBtn.textContent = JE.t('hidden_content_admin_add');
          toolbar.appendChild(adminAddBtn);
        }
      }
    }

    const unhideAllBtn = document.createElement("button");
    unhideAllBtn.className = "je-hidden-content-page-unhide-all";
    unhideAllBtn.textContent = JE.t('hidden_content_clear_all');
    toolbar.appendChild(unhideAllBtn);

    return { element: toolbar, searchInput, scopedToggle, unhideAllBtn, adminUserSelect, adminEditToggle, adminAddBtn };
  }

  /**
   * Partitions filtered items into movies, series-related, and scoped-movies arrays.
   * @param {Array} filtered Array of filtered hidden items.
   * @returns {{ movies: Array, seriesRelated: Array, scopedMovies: Array }}
   */
  function partitionItems(filtered) {
    const movies = [];
    const seriesRelated = [];
    const scopedMovies = [];
    const castActors = [];

    for (const item of filtered) {
      if (item.type === 'Person') {
        castActors.push(item);
      } else if (item.type === 'Series' || item.type === 'Episode' || item.type === 'Season') {
        seriesRelated.push(item);
      } else if (item.hideScope && item.hideScope !== 'global') {
        scopedMovies.push(item);
      } else {
        movies.push(item);
      }
    }

    return { movies, seriesRelated, scopedMovies, castActors };
  }

  /**
   * Renders the movies section (global + scoped combined, scoped get badges).
   * @param {Array} movies Global movie items.
   * @param {Array} scopedMovies Scoped movie items.
   * @param {HTMLElement} container The parent container to append to.
   */
  function renderMoviesSection(movies, scopedMovies, container) {
    const allMovies = [...movies, ...scopedMovies];
    if (allMovies.length === 0) return;

    const grid = document.createElement('div');
    grid.className = 'je-hidden-content-page-grid';
    for (const item of allMovies) {
      const card = JE.hiddenContent.createItemCard(item);
      if (item.hideScope && item.hideScope !== 'global') {
        const infoDiv = card.querySelector('.je-hidden-item-meta');
        if (infoDiv) {
          const badge = document.createElement('span');
          badge.className = 'je-hidden-scoped-badge';
          badge.style.marginLeft = '6px';
          badge.textContent = scopeBadgeText(item.hideScope);
          infoDiv.appendChild(badge);
        }
      }
      attachUnhideHandler(card, item);
      grid.appendChild(card);
    }
    container.appendChild(createSection('hidden_content_group_movies', grid));
  }

  /**
   * Renders the series section with grouped cards.
   * @param {Array} seriesRelated Array of series-related items.
   * @param {HTMLElement} container The parent container to append to.
   */
  function renderSeriesSection(seriesRelated, container) {
    const showGroups = {};
    for (const item of seriesRelated) {
      let key, groupName, groupId;
      if (item.type === 'Series') {
        key = item.itemId || item.name || 'unknown';
        groupName = item.name || JE.t('hidden_content_unknown_show');
        groupId = item.itemId || '';
      } else {
        key = item.seriesId || item.seriesName || item.name || 'unknown';
        groupName = item.seriesName || item.name || JE.t('hidden_content_unknown_show');
        groupId = item.seriesId || '';
      }

      if (!showGroups[key]) {
        showGroups[key] = { seriesName: groupName, seriesId: groupId, items: [] };
      }
      showGroups[key].items.push(item);
    }

    const groupKeys = Object.keys(showGroups);
    if (groupKeys.length === 0) return;

    const grid = document.createElement('div');
    grid.className = 'je-hidden-content-page-grid';
    for (const key of groupKeys) {
      grid.appendChild(createGroupCard(showGroups[key]));
    }
    container.appendChild(createSection('hidden_content_group_series', grid, { expandable: true }));
  }

  /**
   * Renders the cast/actors section with individual cards.
   * @param {Array} castActors Array of Person-type hidden items.
   * @param {HTMLElement} container The parent container to append to.
   */
  function renderCastSection(castActors, container) {
    if (castActors.length === 0) return;

    const grid = document.createElement('div');
    grid.className = 'je-hidden-content-page-grid';
    for (const item of castActors) {
      const card = JE.hiddenContent.createItemCard(item);
      attachUnhideHandler(card, item);
      grid.appendChild(card);
    }
    container.appendChild(createSection('hidden_content_group_cast', grid));
  }

  /**
   * Renders the full management page with grouped display.
   * Called on page show and whenever hidden content changes.
   * @param {HTMLElement} [targetContainer] - Optional container to render into
   *   (used by custom-tab mode to avoid duplicate-ID conflicts).
   */
  function renderPage(targetContainer) {
    let container;
    if (targetContainer) {
      state._customTabContainer = targetContainer;
      container = targetContainer;
    } else if (state._customTabContainer && document.contains(state._customTabContainer)
      && window.location.hash.indexOf('userpluginsettings') === -1) {
      // Re-use stored custom tab container, but not on Plugin Pages route
      container = state._customTabContainer;
    } else {
      state._customTabContainer = null;
      const page = createPageContainer();
      container = document.getElementById("je-hidden-content-container");
      if (!page || !container) return;
    }

    // Publish theme colours so the admin controls follow the active theme (Purple Haze, etc.).
    applyAdminThemeVars(container);

    // Resolve admin status / load the user list on first render (fire-and-forget; repaints once ready).
    maybeInitAdminFilter();

    // If the selected user dropped out of the (possibly refreshed) list — e.g. they unhid
    // everything — fall back to the admin's own list instead of stranding on an empty grid.
    if (state.selectedAdminUserId && Array.isArray(state.adminUsers)
        && !state.adminUsers.some((u) => u.userId === state.selectedAdminUserId)) {
      state.selectedAdminUserId = null;
      state.adminEditMode = false;
      state.adminItems = null;
      state.adminItemsUserId = null;
      state.adminUserName = '';
    }

    // If admin cross-user access was disabled in config, drop the selected user and edit mode so the
    // page returns to the admin's own list (the server also refuses the admin endpoints when off).
    if (JE.pluginConfig && JE.pluginConfig.HiddenContentAdmin === false) {
      state.adminEditMode = false;
      state.selectedAdminUserId = null;
      state.adminItems = null;
      state.adminItemsUserId = null;
      state.adminUserName = '';
      state.adminLoadError = false;
    }

    // When an admin has selected another user, render that user's items (read-only) instead of own.
    const viewingOther = !!state.selectedAdminUserId;
    // Only surface fetched items once they belong to the currently-selected user, so an in-flight
    // switch never briefly shows the previous user's items under the new user's name/badge.
    const adminReady = viewingOther && state.adminItemsUserId === state.selectedAdminUserId;
    const allItems = viewingOther
      ? (adminReady ? (state.adminItems || []) : [])
      : JE.hiddenContent.getAllHiddenItems();
    const searchQuery = state.searchQuery.toLowerCase();

    let filtered = searchQuery
      ? allItems.filter((i) => {
          const nameMatch = i.name?.toLowerCase().includes(searchQuery);
          const seriesMatch = i.seriesName?.toLowerCase().includes(searchQuery);
          return nameMatch || seriesMatch;
        })
      : [...allItems];

    filtered.sort((a, b) => {
      const da = a.hiddenAt ? new Date(a.hiddenAt).getTime() : 0;
      const db = b.hiddenAt ? new Date(b.hiddenAt).getTime() : 0;
      return db - da;
    });

    container.replaceChildren();

    const header = createPageHeader(allItems.length);
    // Show whose list is displayed as a chip INSIDE the header (not a separate banner), so toggling
    // admin view doesn't push the toolbar/grid up and down — the header is always present.
    if (viewingOther) {
      header.appendChild(createAdminViewingBadge());
    }
    container.appendChild(header);

    const toolbar = createToolbar();
    container.appendChild(toolbar.element);

    // Wire the admin user-filter dropdown.
    // IMPORTANT (Android): onAdminUserChange() re-renders, which rebuilds the toolbar and removes
    // this very <select>. Doing that synchronously inside the 'change' handler — while the native
    // picker is still dismissing — crashes the Jellyfin Android app's webview. Blur the control and
    // defer to the next tick so the native picker fully tears down before the element is replaced.
    if (toolbar.adminUserSelect) {
      toolbar.adminUserSelect.addEventListener('change', (e) => {
        const value = e.target.value;
        try { e.target.blur(); } catch (_) {}
        setTimeout(function () { onAdminUserChange(value); }, 0);
      });
    }

    // Wire the admin edit-mode toggle: flips read-only ↔ editable for the viewed user.
    if (toolbar.adminEditToggle) {
      toolbar.adminEditToggle.addEventListener('click', () => {
        state.adminEditMode = !state.adminEditMode;
        renderPage();
      });
    }

    // Wire the admin "add items" button: opens the library-search modal.
    if (toolbar.adminAddBtn) {
      toolbar.adminAddBtn.addEventListener('click', () => openAdminAddModal());
    }

    // Apply scoped filter — only show items hidden from Next Up / CW
    if (state.scopedOnly) {
      const scopedItems = (searchQuery
        ? allItems.filter((i) => {
            const nameMatch = i.name?.toLowerCase().includes(searchQuery);
            const seriesMatch = i.seriesName?.toLowerCase().includes(searchQuery);
            return nameMatch || seriesMatch;
          })
        : [...allItems]
      ).filter(i => i.hideScope && i.hideScope !== 'global');
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
        // Load failed — show a retry affordance rather than a misleading "empty".
        emptyDiv.textContent = JE.t('hidden_content_admin_load_error');
        emptyDiv.style.cursor = 'pointer';
        emptyDiv.addEventListener('click', () => onAdminUserChange(state.selectedAdminUserId));
      } else if (viewingOther && !adminReady) {
        // Another user's items are still loading — show a loading hint rather than "empty".
        emptyDiv.textContent = JE.t('hidden_content_admin_loading');
      } else {
        emptyDiv.textContent = JE.t('hidden_content_manage_empty');
      }
      container.appendChild(emptyDiv);
    } else {
      const { movies, seriesRelated, scopedMovies, castActors } = partitionItems(filtered);
      renderMoviesSection(movies, scopedMovies, container);
      renderSeriesSection(seriesRelated, container);
      renderCastSection(castActors, container);
      // Read-only invariant: while viewing another user WITHOUT edit mode, no surface
      // may expose an unhide control. Movie/cast cards and the series group cards each build their
      // own buttons — strip every known variant here as the single enforced backstop. In edit mode
      // the buttons stay and route through handleUnhide() to the admin endpoint.
      if (viewingOther && !state.adminEditMode) {
        stripUnhideControls(container);
      }
    }

    // Attach search handler
    toolbar.searchInput.addEventListener('input', () => {
      state.searchQuery = toolbar.searchInput.value;
      renderPage();
    });

    // Restore focus after re-render
    if (state.searchQuery) {
      toolbar.searchInput.focus();
      toolbar.searchInput.setSelectionRange(toolbar.searchInput.value.length, toolbar.searchInput.value.length);
    }

    // Attach scoped filter toggle
    toolbar.scopedToggle.addEventListener('click', () => {
      state.scopedOnly = !state.scopedOnly;
      renderPage();

      if (state.scopedOnly) {
        const expandBtns = container.querySelectorAll('.je-hidden-group-expand');
        expandBtns.forEach((btn) => {
          if (!btn.classList.contains('expanded')) btn.click();
        });
        const expandAllBtn = container.querySelector('.je-hidden-expand-all-btn');
        if (expandAllBtn) {
          expandAllBtn.textContent = JE.t('hidden_content_collapse_all');
        }
      }
    });

    // Unhide-all handler. Own list → clear own; admin edit mode → clear the viewed user's list via
    // the admin endpoint; read-only admin view → button hidden.
    if (viewingOther && !state.adminEditMode) {
      toolbar.unhideAllBtn.style.display = 'none';
    } else {
      toolbar.unhideAllBtn.addEventListener('click', () => {
        showUnhideConfirmation(JE.t('hidden_content_clear_confirm') || 'Unhide all items?', () => {
          if (viewingOther) {
            handleUnhideMany((state.adminItems || []).map((it) => it._key || it.itemId));
          } else {
            JE.hiddenContent.unhideAll();
          }
        });
      });
    }
  }

  /**
   * Removes every unhide control from a rendered container, enforcing the read-only contract
   * while an admin views another user's hidden content. Movie/cast cards use
   * `.je-hidden-item-unhide`; series group cards use `.je-hidden-group-unhide`,
   * `.je-hidden-group-item-unhide`, and `.je-hidden-group-unhide-all`. Clicking any of these would
   * call JE.hiddenContent.unhideItem(), which writes to the CURRENT (admin) user's store — so they
   * must never be operable while inspecting another user.
   * @param {HTMLElement} container The rendered content container.
   */
  function stripUnhideControls(container) {
    container.querySelectorAll(
      '.je-hidden-item-unhide, .je-hidden-group-unhide, .je-hidden-group-item-unhide, .je-hidden-group-unhide-all'
    ).forEach((btn) => btn.remove());
  }

  /**
   * Attaches an unhide click handler to a standard item card.
   * Shows a styled confirmation dialog before unhiding.
   * @param {HTMLElement} card The card element.
   * @param {Object} item The hidden item data.
   */
  function attachUnhideHandler(card, item) {
    const unhideBtn = card.querySelector('.je-hidden-item-unhide');
    if (unhideBtn) {
      unhideBtn.addEventListener('click', () => {
        showUnhideConfirmation(JE.t('hidden_content_unhide_confirm') || 'Unhide this item?', () => {
          card.classList.add('je-hidden-item-removing');
          setTimeout(() => {
            handleUnhide(item._key || item.itemId);
          }, 300);
        }, item.name || 'this item');
      });
    }
  }

  Object.assign(internal, { renderPage });

})();
