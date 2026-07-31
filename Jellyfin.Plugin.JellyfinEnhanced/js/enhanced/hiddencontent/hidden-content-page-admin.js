/**
 * @file Hidden Content Page — admin cross-user view: user resolution, the
 * user filter, theming helpers, unhide routing, and the add-items modal.
 * Split from hidden-content-page.js (code motion; bodies verbatim).
 */
(function () {
  "use strict";

  const JE = window.JellyfinEnhanced;
  JE.internals = JE.internals || {};
  const internal = JE.internals.hiddenContentPage = JE.internals.hiddenContentPage || {};

  const { state, POSTER_MAX_WIDTH } = internal;
  // Late-bound cross-module reference (defined in hidden-content-page-render.js).
  const renderPage = (...args) => internal.renderPage(...args);

  const logPrefix = '🪼 Jellyfin Enhanced: Hidden Content Page:';

  // ============================================================
  // Admin cross-user view
  // ============================================================

  /**
   * Resolves whether the current user is an administrator, caching the result.
   * Prefers values already determined elsewhere (settings.json flag, pre-fetched
   * user) and falls back to a single ApiClient.getCurrentUser() call. This is a
   * UX gate only — the server independently enforces admin access on every
   * admin/* endpoint, so a false positive here cannot leak another user's data.
   * @returns {Promise<boolean>}
   */
  async function resolveIsAdmin() {
    if (state.adminIsAdmin !== null) return state.adminIsAdmin;
    // A positive flag is trustworthy; a falsy one may simply be "not yet resolved",
    // so only short-circuit on an explicit true and otherwise verify authoritatively.
    if (JE.currentSettings && JE.currentSettings.isAdmin === true) {
      state.adminIsAdmin = true;
      return true;
    }
    if (JE.currentUser && JE.currentUser.Policy) {
      state.adminIsAdmin = JE.currentUser.Policy.IsAdministrator === true;
      return state.adminIsAdmin;
    }
    try {
      const user = await ApiClient.getCurrentUser();
      // Authoritative result — cache it even when false.
      state.adminIsAdmin = !!(user && user.Policy && user.Policy.IsAdministrator);
      return state.adminIsAdmin;
    } catch (e) {
      // Transient failure: do NOT cache false, so a later render retries instead of
      // permanently disabling the admin filter for an actual admin.
      return false;
    }
  }

  /**
   * Lazily loads the admin user-filter: resolves admin status and, for admins, the list
   * of users who have hidden content. Re-renders once the dropdown becomes available.
   * Safe to call on every render — it no-ops once the list is cached and re-fetches only
   * after the cache is invalidated (state.adminUsers reset to null). Never throws.
   */
  async function maybeInitAdminFilter() {
    // Respect the admin config toggle: when cross-user access is disabled, never build the filter
    // (and never call the admin endpoints, which the server also refuses).
    if (JE.pluginConfig && JE.pluginConfig.HiddenContentAdmin === false) return;
    if (state.adminUsers !== null || state.adminUsersLoading) return;
    state.adminUsersLoading = true;
    // Capture the load token: if the page is left mid-fetch (hidePage bumps the token), a late
    // completion must NOT repopulate adminUsers — that would defeat the fresh re-init on re-open.
    const token = state.adminLoadToken;
    try {
      const isAdmin = await resolveIsAdmin();
      if (!isAdmin) return; // leave adminUsers null; resolveIsAdmin governs retry semantics
      const list = await JE.hiddenContent.fetchHiddenContentUsers();
      // null = transient failure: leave adminUsers null so a later render retries, and do NOT
      // re-render here (re-rendering would re-enter this function and spin a fetch/render loop).
      if (list === null) return;
      if (token !== state.adminLoadToken) return; // page left during the fetch — discard stale result
      state.adminUsers = list;
      // The dropdown can now be drawn from cache — repaint the current surface.
      renderPage();
    } catch (e) {
      console.warn(`${logPrefix} admin filter init failed`, e);
    } finally {
      state.adminUsersLoading = false;
    }
  }

  /**
   * Handles a change of the admin user-filter dropdown. Empty value returns to the
   * admin's own list; any other value loads that user's hidden content read-only.
   * A monotonically increasing token discards stale responses if the admin switches
   * users quickly, and search/scoped filters reset so they don't leak across views.
   * @param {string} value Selected user id (N format) or '' for own list.
   */
  async function onAdminUserChange(value) {
    const token = ++state.adminLoadToken;
    state.searchQuery = '';
    state.scopedOnly = false;
    state.adminEditMode = false; // always start a freshly-selected user in read-only view
    state.adminLoadError = false;

    if (!value) {
      state.selectedAdminUserId = null;
      state.adminItems = null;
      state.adminItemsUserId = null;
      state.adminUserName = '';
      renderPage();
      return;
    }

    state.selectedAdminUserId = value;
    const match = (state.adminUsers || []).find((u) => u.userId === value);
    state.adminUserName = match ? match.userName : value;
    // Clear any prior user's items and repaint to a loading state until the fetch resolves.
    state.adminItems = null;
    state.adminItemsUserId = null;
    renderPage();

    const items = await JE.hiddenContent.fetchUserHiddenItemsForAdmin(value);
    if (token !== state.adminLoadToken) return; // a newer selection superseded this one
    if (items === null) {
      // Load failed — surface an error (with retry) rather than a misleading empty grid. Leaving
      // adminItemsUserId null keeps adminReady false so the error branch renders.
      state.adminLoadError = true;
    } else {
      state.adminItems = items;
      state.adminItemsUserId = value;
    }
    renderPage();
  }

  /**
   * Converts a colour to an opaque form (drops any alpha) so it is safe as a native <option>
   * background — a translucent colour would let the OS-default white show through. Returns null
   * for gradients / unparseable values so callers fall back to a solid default.
   * @param {string} c A CSS colour (rgb/rgba/hex).
   * @returns {string|null}
   */
  function toOpaqueColor(c) {
    if (typeof c !== 'string') return null;
    const s = c.trim();
    const m = s.match(/^rgba?\(([^)]+)\)$/i);
    if (m) {
      const parts = m[1].split(/[,\s/]+/).filter(Boolean);
      if (parts.length >= 3) return `rgb(${parts[0]}, ${parts[1]}, ${parts[2]})`;
    }
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s)) return s;       // opaque hex
    if (/^#([0-9a-f]{8})$/i.test(s)) return '#' + s.slice(1, 7); // hex8 → drop alpha
    return null;
  }

  /**
   * Publishes the active theme's accent / text / surface colours as CSS custom properties on the
   * page container so the admin controls (dropdown, edit toggle, badges) follow the user's theme
   * (e.g. Purple Haze) instead of hard-coded colours. The CSS carries sensible fallbacks, so this
   * is best-effort — missing theme variables simply leave the defaults in place.
   * @param {HTMLElement} container The rendered content container.
   */
  function applyAdminThemeVars(container) {
    if (!container || !(JE.themer && JE.themer.getThemeVariables)) return;
    let tv;
    try { tv = JE.themer.getThemeVariables() || {}; } catch (e) { return; }
    // Only publish VALID CSS colours. A malformed theme value written to the property would make
    // color-mix() invalid AND defeat the CSS var() fallback (which only applies when the property is
    // unset), so we leave the property unset on anything the browser doesn't accept as a colour.
    if (isCssColor(tv.primaryAccent)) container.style.setProperty('--je-hc-accent', tv.primaryAccent);
    if (isCssColor(tv.textColor)) container.style.setProperty('--je-hc-text', tv.textColor);
  }

  /**
   * Returns true if `v` is a colour the browser accepts (so it's safe inside color-mix() / var()).
   * Falls back to a permissive check where the CSS API is unavailable.
   * @param {*} v
   * @returns {boolean}
   */
  function isCssColor(v) {
    if (typeof v !== 'string' || v.trim() === '') return false;
    if (typeof CSS === 'undefined' || typeof CSS.supports !== 'function') return true;
    return CSS.supports('color', v.trim());
  }

  /**
   * Builds the "Viewing: <user> · read-only" badge shown above the grid while an
   * admin is inspecting another user's hidden content.
   * @returns {HTMLElement}
   */
  function createAdminViewingBadge() {
    const editing = state.adminEditMode;
    // A compact chip that lives INSIDE the always-present page header (right of the title), so
    // entering/leaving admin view never inserts a block that shifts the page down.
    const chip = document.createElement('div');
    chip.className = 'je-hidden-admin-viewing-badge' + (editing ? ' je-hidden-admin-editing' : '');
    // Read-only nuance lives in the eye icon + tooltip (and the Edit button); keeps the chip short.
    if (!editing) chip.title = JE.t('hidden_content_admin_readonly_note');

    const icon = document.createElement('span');
    icon.className = 'material-icons je-hidden-admin-viewing-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = editing ? 'edit' : 'visibility';
    chip.appendChild(icon);

    const who = document.createElement('span');
    who.className = 'je-hidden-admin-viewing-user';
    const displayName = state.adminUserName || state.selectedAdminUserId || '';
    who.textContent = JE.t(editing ? 'hidden_content_admin_editing_user' : 'hidden_content_admin_viewing_user', { userName: displayName });
    chip.appendChild(who);

    return chip;
  }

  /**
   * Routes a single-item unhide to the correct store: the admin endpoint when editing another
   * user, otherwise the current user's own store. No-op in read-only admin view.
   * @param {string} key Item key (item._key || item.itemId).
   */
  function handleUnhide(key) {
    if (state.selectedAdminUserId) {
      if (state.adminEditMode) adminUnhide([key]);
      return; // read-only view: ignore (the control should already be stripped)
    }
    JE.hiddenContent.unhideItem(key);
  }

  /**
   * Routes a bulk unhide (whole show / unhide-all) the same way as {@link handleUnhide}.
   * @param {string[]} keys Item keys to unhide.
   */
  function handleUnhideMany(keys) {
    if (!Array.isArray(keys) || keys.length === 0) return;
    if (state.selectedAdminUserId) {
      if (state.adminEditMode) adminUnhide(keys);
      return;
    }
    keys.forEach((k) => JE.hiddenContent.unhideItem(k));
  }

  /**
   * Performs an admin-side unhide for the currently-viewed user, then prunes the local cache and
   * repaints. Keeps the dropdown count roughly in sync without a full refetch.
   * @param {string[]} keys Item keys to unhide for state.selectedAdminUserId.
   */
  async function adminUnhide(keys) {
    const uid = state.selectedAdminUserId;
    if (!uid) return;
    const ok = await JE.hiddenContent.adminUnhideForUser(uid, keys);
    if (!ok) return;
    const removed = new Set(keys);
    if (Array.isArray(state.adminItems)) {
      state.adminItems = state.adminItems.filter((it) => !removed.has(it._key));
    }
    if (Array.isArray(state.adminUsers)) {
      // Immutable update: replace the entry rather than mutating the cached object in place.
      state.adminUsers = state.adminUsers.map((x) =>
        x.userId === uid ? { ...x, count: Math.max(0, (x.count || 0) - removed.size) } : x);
    }
    renderPage();
  }

  /**
   * Builds a hidden-content item from a Jellyfin search result and hides it for the viewed user
   * (admin adding). Updates the local cache + dropdown count and repaints.
   * @param {string} targetUserId The user to hide the item for.
   * @param {Object} result A normalized search result (library or Seerr).
   * @returns {Promise<boolean>} true on success.
   */
  async function adminAddItem(targetUserId, result) {
    const item = {
      itemId: result.itemId || '',
      name: result.name || '',
      type: result.type || '',
      tmdbId: result.tmdbId ? String(result.tmdbId) : '',
      // Store the TMDB poster path for Seerr-sourced items (not in the library) so the hidden card
      // can render a poster; library items render from their Jellyfin image, so leave it blank.
      posterPath: result.source === 'seerr' ? (result.posterPath || '') : '',
      seriesId: '',
      seriesName: '',
      seasonNumber: null,
      episodeNumber: null,
      hideScope: 'global',
      hiddenAt: new Date().toISOString(),
    };
    const added = await JE.hiddenContent.adminHideForUser(targetUserId, [item]);
    if (added === false) return false;
    // The server returns the number of items it newly added; 0 means the user already had it hidden.
    // Only update the local cache + dropdown count for a real add, so the count can't drift upward.
    const didAdd = typeof added === 'number' ? added > 0 : true;
    const key = item.itemId || ('tmdb-' + item.tmdbId);
    if (didAdd && Array.isArray(state.adminItems) && !state.adminItems.some((i) => (i._key || i.itemId) === key)) {
      state.adminItems = state.adminItems.concat([{ ...item, _key: key }]);
    }
    if (didAdd && Array.isArray(state.adminUsers)) {
      // Immutable update: replace the entry rather than mutating the cached object in place.
      state.adminUsers = state.adminUsers.map((x) =>
        x.userId === targetUserId ? { ...x, count: (x.count || 0) + 1 } : x);
    }
    renderPage();
    return true;
  }

  /**
   * Opens a modal to ADD items to the viewed user's hidden content: searches the Jellyfin library,
   * and hiding a result adds it to that user's hidden list (admin adding). Reuses the
   * management-panel styling.
   */
  function openAdminAddModal() {
    const uid = state.selectedAdminUserId;
    if (!uid) return;
    const userName = state.adminUserName || uid;

    // The open overlay normally blocks re-opening, but if a stale one is somehow present, note it so
    // we don't later "restore" the page overflow to its already-locked 'hidden' value (a perma-lock).
    const hadStaleOverlay = !!document.querySelector('.je-hidden-admin-add-overlay');
    document.querySelector('.je-hidden-admin-add-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.className = 'je-hidden-management-overlay je-hidden-admin-add-overlay';
    const panel = document.createElement('div');
    panel.className = 'je-hidden-management-panel';

    const header = document.createElement('div');
    header.className = 'je-hidden-management-header';
    const h2 = document.createElement('h2');
    h2.textContent = JE.t('hidden_content_admin_add_title', { userName });
    const closeBtn = document.createElement('button');
    closeBtn.className = 'je-hidden-management-close';
    closeBtn.textContent = '×';
    header.appendChild(h2);
    header.appendChild(closeBtn);
    panel.appendChild(header);

    const toolbar = document.createElement('div');
    toolbar.className = 'je-hidden-management-toolbar';
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'je-hidden-management-search';
    searchInput.placeholder = JE.t('hidden_content_admin_add_search');
    toolbar.appendChild(searchInput);
    panel.appendChild(toolbar);

    const grid = document.createElement('div');
    grid.className = 'je-hidden-management-grid';
    const hint = document.createElement('div');
    hint.className = 'je-hidden-management-empty';
    hint.textContent = JE.t('hidden_content_admin_add_hint');
    grid.appendChild(hint);
    panel.appendChild(grid);

    overlay.appendChild(panel);

    // Lock the background scroll so scrolling the modal doesn't move the page behind it (mobile).
    // If a stale modal was already locking it, treat the pre-modal value as default ('') so closing
    // can never re-save and re-apply a 'hidden' that permanently locks the page.
    const prevBodyOverflow = hadStaleOverlay ? '' : document.body.style.overflow;
    const prevHtmlOverflow = hadStaleOverlay ? '' : document.documentElement.style.overflow;
    const close = () => {
      overlay.remove();
      document.removeEventListener('keydown', esc);
      document.body.style.overflow = prevBodyOverflow;
      document.documentElement.style.overflow = prevHtmlOverflow;
    };
    const esc = (e) => { if (e.key === 'Escape') close(); };
    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', esc);

    const buildResultCard = (n) => {
      const key = n.itemId || ('tmdb-' + n.tmdbId);
      const alreadyHidden = (state.adminItems || []).some((i) => (i._key || i.itemId) === key);
      const card = document.createElement('div');
      card.className = 'je-hidden-item-card';

      const posterWrap = document.createElement('div');
      posterWrap.className = 'je-hidden-item-poster-link';
      const img = document.createElement('img');
      img.className = 'je-hidden-item-poster';
      img.loading = 'lazy';
      img.alt = '';
      const tmdbPoster = n.posterPath ? ('https://image.tmdb.org/t/p/w' + POSTER_MAX_WIDTH + n.posterPath) : '';
      if (n.itemId) {
        // Library item → Jellyfin image, falling back to the TMDB poster if available.
        img.src = ApiClient.getUrl('/Items/' + n.itemId + '/Images/Primary', { maxWidth: POSTER_MAX_WIDTH });
        img.onerror = tmdbPoster
          ? function () { this.onerror = function () { this.style.display = 'none'; }; this.src = tmdbPoster; }
          : function () { this.style.display = 'none'; };
      } else if (tmdbPoster) {
        // Seerr-only item → TMDB poster.
        img.src = tmdbPoster;
        img.onerror = function () { this.style.display = 'none'; };
      } else {
        img.style.display = 'none';
      }
      posterWrap.appendChild(img);
      card.appendChild(posterWrap);

      const info = document.createElement('div');
      info.className = 'je-hidden-item-info';
      const name = document.createElement('div');
      name.className = 'je-hidden-item-name';
      name.title = n.name || '';
      name.textContent = n.name || 'Unknown';
      const meta = document.createElement('div');
      meta.className = 'je-hidden-item-meta';
      const sourceLabel = n.source === 'seerr'
        ? JE.t('hidden_content_admin_add_source_seerr')
        : JE.t('hidden_content_admin_add_source_library');
      meta.textContent = [n.type, n.year, sourceLabel].filter(Boolean).join(' · ');
      const btn = document.createElement('button');
      btn.className = 'je-hidden-item-unhide';
      if (alreadyHidden) {
        btn.textContent = JE.t('hidden_content_admin_add_already');
        btn.disabled = true;
      } else {
        btn.textContent = JE.t('hidden_content_admin_add_hide');
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          btn.textContent = JE.t('hidden_content_admin_add_hiding');
          const ok = await adminAddItem(uid, n);
          btn.textContent = ok ? JE.t('hidden_content_admin_add_added') : JE.t('hidden_content_admin_add_hide');
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
      const m = document.createElement('div');
      m.className = 'je-hidden-management-empty';
      m.textContent = text;
      grid.replaceChildren(m);
    };
    const doSearch = async (q) => {
      const token = ++searchToken;
      const term = (q || '').trim();
      if (term.length < 2) { grid.replaceChildren(hint); return; }
      showMessage(JE.t('hidden_content_admin_add_searching'));

      // Search the Jellyfin library AND Seerr (when available) in parallel, so the admin can hide
      // items that aren't in the library too.
      // Routed through the core fetch layer (auth + JSON parse identical to the
      // former ApiClient.ajax call; any failure still resolves to []).
      const libP = JE.core.api.fetch(ApiClient.getUrl('/Items', {
        userId: ApiClient.getCurrentUserId(), searchTerm: term, IncludeItemTypes: 'Movie,Series',
        Recursive: true, Limit: 24, Fields: 'ProviderIds', ImageTypeLimit: 1, EnableImageTypes: 'Primary',
      })).then((res) => (res && res.Items) || []).catch(() => []);
      const seerrP = (JE.jellyseerrAPI && JE.jellyseerrAPI.search)
        ? JE.jellyseerrAPI.search(term).then((res) => (res && res.results) || []).catch(() => [])
        : Promise.resolve([]);

      const [libItems, seerrItems] = await Promise.all([libP, seerrP]);
      if (token !== searchToken) return;

      const normalized = [];
      const seenTmdb = new Set();
      for (const r of libItems) {
        const tmdb = (r.ProviderIds && (r.ProviderIds.Tmdb || r.ProviderIds.tmdb)) || '';
        if (tmdb) seenTmdb.add(String(tmdb));
        normalized.push({ source: 'library', itemId: r.Id, name: r.Name, type: r.Type,
          tmdbId: tmdb ? String(tmdb) : '', posterPath: '', year: r.ProductionYear || '' });
      }
      for (const r of seerrItems) {
        if (r.mediaType !== 'movie' && r.mediaType !== 'tv') continue; // skip people
        const tmdb = String(r.id);
        if (seenTmdb.has(tmdb)) continue; // already shown from the library
        seenTmdb.add(tmdb);
        normalized.push({ source: 'seerr', itemId: '', name: r.title || r.name || '',
          type: r.mediaType === 'tv' ? 'Series' : 'Movie', tmdbId: tmdb,
          posterPath: r.posterPath || r.poster_path || '',
          year: ((r.releaseDate || r.firstAirDate || '') + '').slice(0, 4) });
      }

      if (!normalized.length) { showMessage(JE.t('hidden_content_admin_add_none')); return; }
      const frag = document.createDocumentFragment();
      for (const n of normalized) frag.appendChild(buildResultCard(n));
      grid.replaceChildren(frag);
    };

    searchInput.addEventListener('input', () => {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => doSearch(searchInput.value), 300);
    });

    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
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
    openAdminAddModal,
  });

})();
