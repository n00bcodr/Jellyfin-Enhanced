/**
 * @file Hidden Content Page — sidebar navigation page for managing hidden items.
 * Provides search, filtering, grouped display, and unhide actions for all hidden content.
 */
(function () {
  "use strict";

  const JE = window.JellyfinEnhanced;
  const sidebar = document.querySelector('.mainDrawer-scrollContainer');
  const pluginPagesExists = !!sidebar?.querySelector(
    'a[is="emby-linkbutton"][data-itemid="Jellyfin.Plugin.JellyfinEnhanced.HiddenContentPage"]'
  );

  // ============================================================
  // State
  // ============================================================

  const state = {
    pageVisible: false,
    previousPage: null,
    searchQuery: '',
    scopedOnly: false,
    locationSignature: null,
    locationTimer: null,
    _customTabContainer: null,
    // Admin cross-user view: an admin can view another user's hidden content
    // read-only via a toolbar dropdown. All of these stay inert/empty for non-admins.
    adminIsAdmin: null,          // tri-state: null = not yet resolved, then true/false (false only when authoritative)
    adminUsers: null,            // cached dropdown list: [{ userId, userName, count }]; null = needs (re)fetch
    adminUsersLoading: false,    // guards against concurrent user-list fetches
    selectedAdminUserId: null,   // null = viewing own list; otherwise the target user's N-id
    adminEditMode: false,        // when viewing another user, allow editing (unhiding) their items
    adminUserName: '',           // display name of the selected user (for the header badge)
    adminItems: null,            // cached hidden items for the selected user
    adminItemsUserId: null,      // which user adminItems belongs to (guards against showing stale items)
    adminLoadError: false,       // true when the selected user's items failed to load (vs genuinely empty)
    adminLoadToken: 0,           // increments per fetch so stale responses are ignored
  };

  const logPrefix = '🪼 Jellyfin Enhanced: Hidden Content Page:';

  function scopeBadgeText(scope) {
    const s = (scope || '').toLowerCase();
    if (s === 'continuewatching') return JE.t('hidden_content_scope_cw_label');
    if (s === 'nextup')           return JE.t('hidden_content_scope_nextup_label');
    if (s === 'homesections')     return JE.t('hidden_content_scope_homesections_label');
    return '';
  }

  function scopeUnhideText(scope) {
    if ((scope || '').toLowerCase() === 'continuewatching') {
      return JE.t('hidden_content_add_back_to_cw');
    }
    return JE.t('hidden_content_unhide');
  }

  /** Polling interval for detecting pushState navigations. */
  const LOCATION_WATCH_INTERVAL_MS = 150;
  /** Delay before removing a card after unhide animation. */
  const UNHIDE_FADE_DELAY_MS = 200;
  /** Max poster width when loading images. */
  const POSTER_MAX_WIDTH = 300;

  // ============================================================
  // CSS Styles
  // ============================================================

  const CSS_STYLES = `
    .je-hidden-content-page {
      padding: 2em;
      max-width: 95vw;
      margin: 0 auto;
      position: relative;
      z-index: 1;
    }

    .je-hidden-content-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 2em;
      padding-top: 2em;
      flex-wrap: wrap;
      gap: 1em;
    }

    .je-hidden-content-title {
      font-size: 2em;
      font-weight: 600;
      margin: 0;
    }

    .je-hidden-content-count {
      font-size: 0.5em;
      font-weight: 400;
      opacity: 0.6;
      margin-left: 0.5em;
    }

    .je-hidden-content-toolbar {
      display: flex;
      align-items: center;
      gap: 12px;
      width: 100%;
      margin-bottom: 1.5em;
    }

    .je-hidden-content-page-search {
      flex: 1;
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 6px;
      color: #fff;
      padding: 10px 14px;
      font-size: 14px;
      outline: none;
      max-width: 400px;
    }

    .je-hidden-content-page-search::placeholder {
      color: rgba(255,255,255,0.4);
    }

    .je-hidden-content-page-search:focus {
      border-color: rgba(255,255,255,0.3);
    }

    .je-hidden-content-page-unhide-all {
      background: rgba(220,50,50,0.3);
      border: 1px solid rgba(220,50,50,0.5);
      color: #fff;
      padding: 10px 20px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      white-space: nowrap;
      transition: background 0.2s ease;
    }

    .je-hidden-content-page-unhide-all:hover {
      background: rgba(220,50,50,0.5);
    }

    .je-hidden-content-page-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
      gap: 16px;
    }

    .je-hidden-content-page-empty {
      text-align: center;
      padding: 60px 24px;
      color: rgba(255,255,255,0.4);
      font-size: 15px;
    }

    /* Group section headers */
    .je-hidden-group-section {
      margin-bottom: 2em;
    }
    .je-hidden-group-section-title {
      font-size: 1.2em;
      font-weight: 600;
      color: rgba(255,255,255,0.8);
      margin-bottom: 1em;
      padding-bottom: 0.5em;
      border-bottom: 1px solid rgba(255,255,255,0.1);
    }

    /* Grouped card for a show — vertical poster layout matching movie cards */
    .je-hidden-group-card {
      background: rgba(255,255,255,0.05);
      border-radius: 8px;
      overflow: hidden;
      border: 1px solid rgba(255,255,255,0.08);
      transition: border-color 0.2s ease;
    }
    .je-hidden-group-card:hover {
      border-color: rgba(255,255,255,0.2);
    }
    .je-hidden-group-poster-link {
      display: block;
      width: 100%;
      aspect-ratio: 2 / 3;
      overflow: hidden;
      background: rgba(255,255,255,0.05);
    }
    .je-hidden-group-poster {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .je-hidden-group-info {
      padding: 8px 10px 4px;
    }
    .je-hidden-group-name {
      font-size: 14px;
      font-weight: 600;
      color: #fff;
      margin-bottom: 2px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    a.je-hidden-group-name:hover {
      text-decoration: underline;
    }
    .je-hidden-group-meta {
      font-size: 11px;
      color: rgba(255,255,255,0.4);
      margin-bottom: 4px;
    }

    /* Expand/collapse toggle */
    .je-hidden-group-expand {
      display: flex;
      align-items: center;
      justify-content: space-between;
      width: calc(100% - 20px);
      margin: 0 10px 6px;
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.1);
      color: rgba(255,255,255,0.6);
      padding: 5px 10px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
      font-weight: 500;
      transition: background 0.15s ease;
    }
    .je-hidden-group-expand:hover {
      background: rgba(255,255,255,0.1);
      color: rgba(255,255,255,0.85);
    }
    .je-hidden-group-expand .material-icons {
      font-size: 16px;
      transition: transform 0.2s ease;
    }
    .je-hidden-group-expand.expanded .material-icons {
      transform: rotate(180deg);
    }

    /* Expandable items panel */
    .je-hidden-group-items {
      padding: 0 10px 6px;
      display: none;
    }
    .je-hidden-group-items.expanded {
      display: block;
    }
    .je-hidden-group-item {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      padding: 5px 0;
      border-bottom: 1px solid rgba(255,255,255,0.04);
      gap: 6px;
    }
    .je-hidden-group-item:last-child {
      border-bottom: none;
    }
    .je-hidden-group-item-info {
      flex: 1;
      min-width: 0;
    }
    .je-hidden-group-item-label {
      font-size: 12px;
      color: rgba(255,255,255,0.7);
      display: block;
      word-break: break-word;
    }
    a.je-hidden-group-item-label:hover {
      color: #fff;
      text-decoration: underline;
    }
    .je-hidden-group-item-unhide {
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.12);
      color: rgba(255,255,255,0.7);
      padding: 2px 8px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 10px;
      font-weight: 500;
      transition: background 0.2s ease;
      flex-shrink: 0;
      margin-top: 1px;
    }
    .je-hidden-group-item-unhide:hover {
      background: rgba(100,200,100,0.3);
      border-color: rgba(100,200,100,0.5);
      color: #fff;
    }
    .je-hidden-group-unhide-all {
      width: calc(100% - 20px);
      margin: 4px 10px 10px;
      background: rgba(220,50,50,0.2);
      border: 1px solid rgba(220,50,50,0.3);
      color: rgba(255,255,255,0.7);
      padding: 5px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
      font-weight: 500;
      transition: background 0.2s ease;
      display: none;
    }
    .je-hidden-group-unhide-all.expanded {
      display: block;
    }
    .je-hidden-group-unhide-all:hover {
      background: rgba(220,50,50,0.4);
      color: #fff;
    }

    /* Scoped hide badge */
    .je-hidden-scoped-badge {
      display: inline-block;
      font-size: 9px;
      font-weight: 600;
      padding: 1px 5px;
      border-radius: 3px;
      background: rgba(100, 149, 237, 0.25);
      color: rgba(180, 210, 255, 0.85);
      border: 1px solid rgba(100, 149, 237, 0.35);
      white-space: nowrap;
      line-height: 1.3;
      margin-top: 2px;
    }

    /* Simple unhide button for series-only cards (matches movie card style) */
    .je-hidden-group-unhide {
      display: block;
      width: calc(100% - 20px);
      margin: 6px 10px 10px;
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.12);
      color: rgba(255,255,255,0.7);
      padding: 6px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 500;
      transition: background 0.2s ease;
      text-align: center;
    }
    .je-hidden-group-unhide:hover {
      background: rgba(100,200,100,0.3);
      border-color: rgba(100,200,100,0.5);
      color: #fff;
    }

    /* Expand/collapse all toggle in section header */
    .je-hidden-section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 1em;
      padding-bottom: 0.5em;
      border-bottom: 1px solid rgba(255,255,255,0.1);
    }
    .je-hidden-section-header-title {
      font-size: 1.2em;
      font-weight: 600;
      color: rgba(255,255,255,0.8);
    }
    .je-hidden-expand-all-btn {
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.12);
      color: rgba(255,255,255,0.6);
      padding: 4px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
      font-weight: 500;
      transition: background 0.15s ease;
    }
    .je-hidden-expand-all-btn:hover {
      background: rgba(255,255,255,0.12);
      color: rgba(255,255,255,0.85);
    }

    /* Scoped filter toggle */
    .je-hidden-scoped-filter {
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.12);
      color: rgba(255,255,255,0.6);
      padding: 10px 16px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      white-space: nowrap;
      transition: background 0.15s ease, border-color 0.15s ease;
    }
    .je-hidden-scoped-filter:hover {
      background: rgba(255,255,255,0.1);
      color: rgba(255,255,255,0.85);
    }
    .je-hidden-scoped-filter.active {
      background: rgba(100, 149, 237, 0.25);
      border-color: rgba(100, 149, 237, 0.5);
      color: rgba(180, 210, 255, 0.95);
    }

    /* Admin cross-user controls. Accent + text colours come from the active theme via the
       --je-hc-accent / --je-hc-text custom properties set in applyAdminThemeVars(); the literal values
       below are fallbacks used when no theme variable is available (option backgrounds are themed inline).
       The control itself stays a neutral translucent surface (matching the sibling search / scoped-toggle
       controls) so it reads on any dark theme. color-mix() needs a modern engine (Chrome 111+/Firefox
       113+/Safari 16.4+); older browsers ignore the rule and fall back to the var() default colour. */
    .je-hidden-admin-user-filter {
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.12);
      color: var(--je-hc-text, rgba(255,255,255,0.85));
      padding: 10px 12px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      max-width: 240px;
      outline: none;
      transition: background 0.15s ease, border-color 0.15s ease;
    }
    .je-hidden-admin-user-filter:hover {
      background: rgba(255,255,255,0.1);
    }
    .je-hidden-admin-user-filter:focus {
      border-color: color-mix(in srgb, var(--je-hc-accent, rgb(150,170,255)) 60%, transparent);
    }
    .je-hidden-admin-edit-toggle {
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.12);
      color: var(--je-hc-text, rgba(255,255,255,0.7));
      padding: 10px 16px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      white-space: nowrap;
      transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
    }
    .je-hidden-admin-edit-toggle:hover {
      background: rgba(255,255,255,0.1);
    }
    .je-hidden-admin-edit-toggle.active {
      background: color-mix(in srgb, var(--je-hc-accent, rgb(100,200,120)) 22%, transparent);
      border-color: color-mix(in srgb, var(--je-hc-accent, rgb(100,200,120)) 50%, transparent);
      color: var(--je-hc-accent, rgb(185,240,200));
    }
    .je-hidden-admin-add-btn {
      background: color-mix(in srgb, var(--je-hc-accent, rgb(100,200,120)) 22%, transparent);
      border: 1px solid color-mix(in srgb, var(--je-hc-accent, rgb(100,200,120)) 50%, transparent);
      color: var(--je-hc-accent, rgb(185,240,200));
      padding: 10px 16px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 600;
      white-space: nowrap;
      transition: background 0.15s ease, border-color 0.15s ease;
    }
    .je-hidden-admin-add-btn:hover {
      background: color-mix(in srgb, var(--je-hc-accent, rgb(100,200,120)) 34%, transparent);
    }
    /* Compact status chip that sits inside the header (right of the title). Inline so it never adds
       a banner row that shifts the page; height stays within the title's line so the header doesn't
       grow when it appears/disappears. */
    .je-hidden-admin-viewing-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-left: auto;
      flex: 0 0 auto;
      padding: 5px 12px;
      border-radius: 999px;
      font-size: 13px;
      line-height: 1.2;
      white-space: nowrap;
      max-width: 100%;
      background: color-mix(in srgb, var(--je-hc-accent, rgb(100,149,237)) 12%, transparent);
      border: 1px solid color-mix(in srgb, var(--je-hc-accent, rgb(100,149,237)) 35%, transparent);
    }
    .je-hidden-admin-viewing-badge.je-hidden-admin-editing {
      background: color-mix(in srgb, var(--je-hc-accent, rgb(100,200,120)) 18%, transparent);
      border-color: color-mix(in srgb, var(--je-hc-accent, rgb(100,200,120)) 50%, transparent);
    }
    .je-hidden-admin-viewing-icon {
      font-size: 16px;
      color: var(--je-hc-accent, rgb(180,210,255));
    }
    .je-hidden-admin-editing .je-hidden-admin-viewing-icon {
      color: var(--je-hc-accent, rgb(185,240,200));
    }
    .je-hidden-admin-viewing-user {
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--je-hc-accent, rgb(180,210,255));
    }
    .je-hidden-admin-editing .je-hidden-admin-viewing-user {
      color: var(--je-hc-accent, rgb(185,240,200));
    }

    /* Add-items modal: the panel fills the viewport and the results grid scrolls inside
       it (the search box stays put); overscroll-behavior stops the scroll reaching the page behind. */
    .je-hidden-admin-add-overlay {
      padding: 24px 16px;
      overscroll-behavior: contain;
    }
    .je-hidden-admin-add-overlay .je-hidden-management-panel {
      display: flex;
      flex-direction: column;
      max-height: calc(100vh - 48px);
      max-height: calc(100dvh - 48px);
      overflow: hidden;
    }
    .je-hidden-admin-add-overlay .je-hidden-management-grid {
      overflow-y: auto;
      overscroll-behavior: contain;
      -webkit-overflow-scrolling: touch;
      flex: 1 1 auto;
      min-height: 0;
      /* The grid has a definite (flex-constrained) height. Without this, its auto rows are sized
         down to each card's min-content to fit that height, and the cards' overflow:hidden then
         clips the poster+info to a ~34px sliver (only visible with many results). Pinning rows to
         max-content keeps every card full height; the grid overflows and scrolls instead. */
      grid-auto-rows: max-content;
      align-content: start;
    }

    @media (max-width: 768px) {
      .je-hidden-content-page {
        padding: 0.5em;
      }

      .je-hidden-content-header {
        padding-top: 1em;
      }

      .je-hidden-content-title {
        font-size: 1.3em;
      }

      .je-hidden-content-toolbar {
        flex-direction: column;
        align-items: stretch;
      }

      .je-hidden-content-page-search {
        max-width: none;
      }

      .je-hidden-content-page-grid {
        grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
        gap: 10px;
      }

      /* Add-items modal: near-fullscreen with small result cards on phones. */
      .je-hidden-admin-add-overlay {
        padding: 8px;
      }
      .je-hidden-admin-add-overlay .je-hidden-management-panel {
        max-height: calc(100vh - 16px);
        max-height: calc(100dvh - 16px);
      }
      .je-hidden-admin-add-overlay .je-hidden-management-grid {
        grid-template-columns: repeat(auto-fill, minmax(92px, 1fr));
        gap: 10px;
        padding: 12px;
      }
      .je-hidden-admin-add-overlay .je-hidden-item-name { font-size: 12px; }
      .je-hidden-admin-add-overlay .je-hidden-item-meta { font-size: 10px; }
      .je-hidden-admin-add-overlay .je-hidden-item-unhide { font-size: 11px; padding: 5px; }
    }
  `;

  // ============================================================
  // Initialization & Setup
  // ============================================================

  /**
   * Initializes the hidden content page module.
   * Injects styles, navigation item, and sets up all event listeners.
   */
  function initialize() {
    console.log(`${logPrefix} Initializing hidden content page module`);

    const config = JE.pluginConfig || {};
    if (!config.HiddenContentEnabled) {
      console.log(`${logPrefix} Hidden content is disabled`);
      return;
    }

    if (!JE.hiddenContent) {
      console.log(`${logPrefix} Hidden content not initialized, skipping page module`);
      return;
    }

    injectStyles();

    // Re-render listener runs in BOTH native and Plugin-Pages modes; gated on container presence (state.pageVisible isn't set in Plugin-Pages mode).
    window.addEventListener('je-hidden-content-changed', () => {
      // This event fires only for the ADMIN's own hidden-content changes. Invalidate the cached
      // admin user list so the dropdown picks up new/emptied users on the next render.
      // Only when on the admin's own view: while viewing another user, nulling the cache would strip
      // the dropdown on the next admin-edit render until it re-fetches (a visible flicker).
      if (state.adminIsAdmin === true && !state.selectedAdminUserId) {
        state.adminUsers = null;
      }
      const container = document.getElementById('je-hidden-content-container');
      // Don't repaint while viewing another user — the admin's own change must not clobber that
      // read-only view with own-list data under the wrong badge.
      if (container && document.contains(container) && !state.selectedAdminUserId) {
        renderPage(container);
      }
    });

    const usingPluginPages = pluginPagesExists && config.HiddenContentUsePluginPages;
    if (usingPluginPages) {
      console.log(`${logPrefix} Hidden content page is injected via Plugin Pages`);
      return;
    }

    injectNavigation();
    setupNavigationWatcher();

    window.addEventListener("hashchange", interceptNavigation, true);
    window.addEventListener("popstate", interceptNavigation, true);
    document.addEventListener("viewshow", handleViewShow);
    document.addEventListener("click", handleNavClick);
    window.addEventListener("hashchange", handleNavigation);
    window.addEventListener("popstate", handleNavigation);

    handleNavigation();

    console.log(`${logPrefix} Hidden content page module initialized`);
  }

  // ============================================================
  // Navigation & Page Management
  // ============================================================

  /**
   * Intercepts hash/popstate changes for the hidden-content route before
   * Jellyfin's native router can handle them.
   * @param {HashChangeEvent|PopStateEvent} e The navigation event.
   */
  function interceptNavigation(e) {
    const url = e?.newURL ? new URL(e.newURL) : window.location;
    const hash = url.hash;
    const path = url.pathname;
    const matches = hash.startsWith("#/hidden-content") || path === "/hidden-content";
    if (matches) {
      if (e?.stopImmediatePropagation) e.stopImmediatePropagation();
      if (e?.preventDefault) e.preventDefault();
      showPage();
    }
  }

  /**
   * Starts polling for pushState-based navigation changes.
   * Jellyfin's router uses pushState which doesn't fire popstate/hashchange.
   */
  function startLocationWatcher() {
    if (state.locationTimer) return;
    state.locationSignature = `${window.location.pathname}${window.location.hash}`;
    state.locationTimer = setInterval(() => {
      const signature = `${window.location.pathname}${window.location.hash}`;
      if (signature !== state.locationSignature) {
        state.locationSignature = signature;
        handleNavigation();
      }
    }, LOCATION_WATCH_INTERVAL_MS);
  }

  /**
   * Stops the location polling interval.
   */
  function stopLocationWatcher() {
    if (state.locationTimer) {
      clearInterval(state.locationTimer);
      state.locationTimer = null;
    }
  }

  /**
   * Injects the page CSS styles into the document head.
   * No-ops if already injected.
   */
  function injectStyles() {
    if (document.getElementById("je-hidden-content-page-styles")) return;
    const style = document.createElement("style");
    style.id = "je-hidden-content-page-styles";
    style.textContent = CSS_STYLES;
    document.head.appendChild(style);
  }

  /**
   * Creates or retrieves the hidden-content page container element.
   * Inserts it into Jellyfin's animated-pages container on first call.
   * @returns {HTMLElement} The page container element.
   */
  function createPageContainer() {
    let page = document.getElementById("je-hidden-content-page");
    if (!page) {
      page = document.createElement("div");
      page.id = "je-hidden-content-page";
      page.className = "page type-interior mainAnimatedPage hide";
      page.setAttribute("data-title", "Hidden Content");
      page.setAttribute("data-backbutton", "true");
      page.setAttribute("data-url", "#/hidden-content");
      page.setAttribute("data-type", "custom");

      const contentWrapper = document.createElement("div");
      contentWrapper.setAttribute("data-role", "content");

      const contentPrimary = document.createElement("div");
      contentPrimary.className = "content-primary je-hidden-content-page";

      const container = document.createElement("div");
      container.id = "je-hidden-content-container";
      container.style.cssText = "padding-top: 5em; padding-left: 0.5em; padding-right: 0.5em;";

      contentPrimary.appendChild(container);
      contentWrapper.appendChild(contentPrimary);
      page.appendChild(contentWrapper);

      const mainContent = document.querySelector(".mainAnimatedPages");
      if (mainContent) {
        mainContent.appendChild(page);
      } else {
        document.body.appendChild(page);
      }
    }

    return page;
  }

  /**
   * Shows a styled confirmation dialog matching the hide-confirm style.
   * Used for unhide confirmations to provide visual consistency.
   * @param {string} message The confirmation heading to display.
   * @param {Function} onConfirm Called when user confirms.
   * @param {string} [itemName] Optional item name to show below the heading.
   */
  function showUnhideConfirmation(message, onConfirm, itemName) {
    document.querySelector('.je-hide-confirm-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.className = 'je-hide-confirm-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'je-hide-confirm-dialog';

    const title = document.createElement('h3');
    title.textContent = message;
    dialog.appendChild(title);

    if (itemName) {
      const body = document.createElement('p');
      body.textContent = itemName;
      dialog.appendChild(body);
    }

    const closeDialog = () => {
      overlay.remove();
      document.removeEventListener('keydown', escHandler);
    };

    const buttons = document.createElement('div');
    buttons.className = 'je-hide-confirm-buttons';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'je-hide-confirm-cancel';
    cancelBtn.textContent = JE.t('hidden_content_confirm_cancel') || 'Cancel';
    cancelBtn.addEventListener('click', closeDialog);
    buttons.appendChild(cancelBtn);

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'je-hide-confirm-hide';
    confirmBtn.textContent = JE.t('hidden_content_unhide') || 'Unhide';
    confirmBtn.addEventListener('click', () => {
      closeDialog();
      onConfirm();
    });
    buttons.appendChild(confirmBtn);

    dialog.appendChild(buttons);
    overlay.appendChild(dialog);

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeDialog();
    });

    const escHandler = (e) => {
      if (e.key === 'Escape') closeDialog();
    };
    document.addEventListener('keydown', escHandler);

    document.body.appendChild(overlay);
  }

  // ============================================================
  // Rendering Functions
  // ============================================================

  /**
   * Creates a formatted episode/season label.
   * @param {Object} item Hidden content item.
   * @returns {string} Formatted label like "S02E05 - Episode Title".
   */
  function formatEpisodeLabel(item) {
    const parts = [];
    if (item.seasonNumber != null && item.episodeNumber != null) {
      const s = String(item.seasonNumber).padStart(2, '0');
      const e = String(item.episodeNumber).padStart(2, '0');
      parts.push(`S${s}E${e}`);
    } else if (item.seasonNumber != null) {
      parts.push(JE.t('hidden_content_season_label', { number: item.seasonNumber }));
    }
    if (item.name) parts.push(item.name);
    return parts.join(' \u2013 ') || item.name || JE.t('hidden_content_unknown_show');
  }

  /**
   * Creates the poster element for a group card.
   * @param {Object} group The show group data.
   * @param {string} tmdbId The TMDB ID for fallback poster lookup.
   * @returns {HTMLElement} The poster link element.
   */
  function createGroupPoster(group, tmdbId) {
    const hasJellyfinId = !!group.seriesId;
    const hasTmdbId = !!tmdbId;

    const posterLink = document.createElement('a');
    posterLink.className = 'je-hidden-group-poster-link';
    if (hasJellyfinId) {
      posterLink.href = `#/details?id=${group.seriesId}`;
    } else if (hasTmdbId) {
      posterLink.href = '#';
    }

    const img = document.createElement('img');
    img.className = 'je-hidden-group-poster';
    const fallbackPosterPath = group.items[0]?.posterPath;
    if (hasJellyfinId) {
      img.src = `${ApiClient.getUrl('/Items/' + group.seriesId + '/Images/Primary', { maxWidth: POSTER_MAX_WIDTH })}`;
      img.onerror = function() {
        var self = this;
        // Signal the card that Jellyfin item is gone
        if (hasTmdbId && JE.jellyseerrMoreInfo) {
          posterLink.dataset.jellyfinRemoved = '1';
        }
        // Item removed from Jellyfin — fall back to TMDB poster
        if (hasTmdbId && fallbackPosterPath) {
          self.src = `https://image.tmdb.org/t/p/w${POSTER_MAX_WIDTH}${fallbackPosterPath}`;
          self.onerror = function() { this.style.display = 'none'; };
        } else if (hasTmdbId && JE.jellyseerrAPI) {
          // No posterPath stored — fetch it from Jellyseerr
          self.onerror = function() { this.style.display = 'none'; };
          var mainItem = group.items[0];
          var mediaType = (mainItem && mainItem.type === 'Series') ? 'tv' : 'movie';
          var fetchFn = mediaType === 'tv'
              ? JE.jellyseerrAPI.fetchTvShowDetails
              : JE.jellyseerrAPI.fetchMovieDetails;
          fetchFn(parseInt(tmdbId, 10)).then(function(details) {
            var path = details && (details.posterPath || details.poster_path);
            if (path) {
              self.src = `https://image.tmdb.org/t/p/w${POSTER_MAX_WIDTH}${path}`;
            } else {
              self.style.display = 'none';
            }
          }).catch(function() { self.style.display = 'none'; });
        } else if (group.seriesName && JE.jellyseerrAPI && JE.jellyseerrMoreInfo) {
          // No TMDB id stored (e.g. an episode hidden from Next Up) and the Jellyfin media is gone.
          // Resolve the show via a Seerr search by name so the card can still open the more-info
          // modal — instead of leaving a blank poster and a dead "#/details" link.
          self.style.display = 'none';
          JE.jellyseerrAPI.search(group.seriesName).then(function(res) {
            var results = (res && res.results) || [];
            var hit = results.find(function(r) { return r.mediaType === 'tv'; }) || results[0];
            if (hit && hit.id) {
              posterLink.dataset.jellyfinRemoved = '1';
              posterLink.dataset.resolvedTmdbId = String(hit.id);
              posterLink.dataset.resolvedMediaType = hit.mediaType || 'tv';
              posterLink.href = '#';
              var p = hit.posterPath || hit.poster_path;
              if (p) {
                self.src = `https://image.tmdb.org/t/p/w${POSTER_MAX_WIDTH}${p}`;
                self.style.display = '';
                self.onerror = function() { this.style.display = 'none'; };
              }
            }
          }).catch(function() {});
        } else {
          self.style.display = 'none';
        }
      };
    } else if (fallbackPosterPath) {
      img.src = `https://image.tmdb.org/t/p/w${POSTER_MAX_WIDTH}${fallbackPosterPath}`;
      img.onerror = function() { this.style.display = 'none'; };
    } else if (group.items[0]?.itemId) {
      img.src = `${ApiClient.getUrl('/Items/' + group.items[0].itemId + '/Images/Primary', { maxWidth: POSTER_MAX_WIDTH })}`;
      img.onerror = function() { this.style.display = 'none'; };
    }
    img.alt = '';
    img.loading = 'lazy';
    posterLink.appendChild(img);
    return posterLink;
  }

  /**
   * Creates the info section (name + meta) for a group card.
   * @param {Object} group The show group data.
   * @param {Object} mainItem The primary item in the group.
   * @param {number} totalItems Total count of items in the group.
   * @param {boolean} hasEpisodes Whether the group contains episode items.
   * @param {string} tmdbId The TMDB ID for navigation.
   * @returns {HTMLElement} The info container element.
   */
  function createGroupInfo(group, mainItem, totalItems, hasEpisodes, tmdbId) {
    const hasJellyfinId = !!group.seriesId;
    const hasTmdbId = !!tmdbId;

    const info = document.createElement('div');
    info.className = 'je-hidden-group-info';

    const nameEl = (hasJellyfinId || hasTmdbId)
      ? document.createElement('a')
      : document.createElement('div');
    nameEl.className = 'je-hidden-group-name';
    nameEl.textContent = group.seriesName || JE.t('hidden_content_unknown_show');
    nameEl.title = group.seriesName || '';
    if (hasJellyfinId) {
      nameEl.href = `#/details?id=${group.seriesId}`;
      nameEl.style.color = '#fff';
      nameEl.style.textDecoration = 'none';
    } else if (hasTmdbId) {
      nameEl.href = '#';
      nameEl.style.color = '#fff';
      nameEl.style.textDecoration = 'none';
    }
    info.appendChild(nameEl);

    const meta = document.createElement('div');
    meta.className = 'je-hidden-group-meta';
    if (totalItems === 1 && !hasEpisodes) {
      const hiddenDate = mainItem.hiddenAt ? new Date(mainItem.hiddenAt).toLocaleDateString() : '';
      meta.textContent = ['Series', hiddenDate].filter(Boolean).join(' \u00B7 ');
    } else if (totalItems === 1) {
      meta.textContent = JE.t('hidden_content_1_hidden_item');
    } else {
      meta.textContent = JE.t('hidden_content_n_hidden_items', { count: totalItems });
    }
    info.appendChild(meta);

    return { info, nameEl };
  }

  /**
   * Creates a single-item display (inline detail + unhide button) for a group card
   * that contains only one item.
   * @param {Object} group The show group data.
   * @param {Object} mainItem The single item in the group.
   * @param {boolean} hasEpisodes Whether the item is an episode/season.
   * @returns {HTMLElement} A document fragment with the detail and unhide button.
   */
  function createSingleItemDisplay(group, mainItem, hasEpisodes) {
    const fragment = document.createDocumentFragment();

    if (hasEpisodes) {
      const detailDiv = document.createElement('div');
      detailDiv.style.cssText = 'padding: 0 10px; font-size: 12px; color: rgba(255,255,255,0.7);';

      const label = document.createElement('a');
      label.className = 'je-hidden-group-item-label';
      label.textContent = formatEpisodeLabel(mainItem);
      label.title = mainItem.name || '';
      if (mainItem.itemId) {
        label.href = `#/details?id=${mainItem.itemId}`;
        label.style.color = 'inherit';
        label.style.textDecoration = 'none';
      }
      detailDiv.appendChild(label);

      if (mainItem.hideScope && mainItem.hideScope !== 'global') {
        const badge = document.createElement('span');
        badge.className = 'je-hidden-scoped-badge';
        badge.style.marginTop = '2px';
        badge.style.display = 'inline-block';
        badge.textContent = scopeBadgeText(mainItem.hideScope);
        detailDiv.appendChild(badge);
      }
      fragment.appendChild(detailDiv);
    }

    const unhideBtn = document.createElement('button');
    unhideBtn.className = 'je-hidden-group-unhide';
    unhideBtn.textContent = scopeUnhideText(mainItem.hideScope);
    unhideBtn.addEventListener('click', () => {
      const itemLabel = hasEpisodes
        ? (group.seriesName || '') + ' \u2013 ' + formatEpisodeLabel(mainItem)
        : (group.seriesName || mainItem.name || 'this item');
      showUnhideConfirmation(JE.t('hidden_content_unhide_confirm') || 'Unhide this item?', () => {
        unhideBtn.closest('.je-hidden-group-card').style.opacity = '0.3';
        setTimeout(() => {
          handleUnhide(mainItem._key || mainItem.itemId);
        }, UNHIDE_FADE_DELAY_MS);
      }, itemLabel);
    });
    fragment.appendChild(unhideBtn);

    return fragment;
  }

  /**
   * Creates an expandable list of items with individual unhide buttons,
   * plus an "Unhide All" button for the entire group.
   * @param {Object} group The show group data.
   * @param {Array} displayItems Sorted array of items with `_label` attached.
   * @param {number} totalItems Total count for the expand button label.
   * @returns {HTMLElement} A document fragment containing expand button, items list, and unhide-all.
   */
  function createExpandableItemsList(group, displayItems, totalItems) {
    const fragment = document.createDocumentFragment();

    // Expand/collapse button
    const expandBtn = document.createElement('button');
    expandBtn.className = 'je-hidden-group-expand';
    const expandLabel = document.createElement('span');
    expandLabel.textContent = totalItems === 1
      ? JE.t('hidden_content_1_hidden_item')
      : JE.t('hidden_content_n_hidden_items', { count: totalItems });
    const expandIcon = document.createElement('span');
    expandIcon.className = 'material-icons';
    expandIcon.setAttribute('aria-hidden', 'true');
    expandIcon.textContent = 'expand_more';
    expandBtn.appendChild(expandLabel);
    expandBtn.appendChild(expandIcon);
    fragment.appendChild(expandBtn);

    // Expandable items list (hidden by default)
    const itemsList = document.createElement('div');
    itemsList.className = 'je-hidden-group-items';

    for (const item of displayItems) {
      const row = document.createElement('div');
      row.className = 'je-hidden-group-item';

      const infoCol = document.createElement('div');
      infoCol.className = 'je-hidden-group-item-info';

      const label = document.createElement('a');
      label.className = 'je-hidden-group-item-label';
      label.textContent = item._label;
      label.title = item.name || '';
      if (item.itemId) {
        label.href = `#/details?id=${item.itemId}`;
        label.style.color = 'inherit';
        label.style.textDecoration = 'none';
      }
      infoCol.appendChild(label);

      if (item.hideScope && item.hideScope !== 'global') {
        const badge = document.createElement('span');
        badge.className = 'je-hidden-scoped-badge';
        badge.textContent = scopeBadgeText(item.hideScope);
        infoCol.appendChild(badge);
      }

      row.appendChild(infoCol);

      const unhideBtn = document.createElement('button');
      unhideBtn.className = 'je-hidden-group-item-unhide';
      unhideBtn.textContent = scopeUnhideText(item.hideScope);
      unhideBtn.addEventListener('click', (e) => {
        e.preventDefault();
        const rowLabel = (group.seriesName || '') + ' \u2013 ' + formatEpisodeLabel(item);
        showUnhideConfirmation(JE.t('hidden_content_unhide_confirm') || 'Unhide this item?', () => {
          row.style.opacity = '0.3';
          setTimeout(() => {
            handleUnhide(item._key || item.itemId);
          }, UNHIDE_FADE_DELAY_MS);
        }, rowLabel);
      });
      row.appendChild(unhideBtn);
      itemsList.appendChild(row);
    }

    fragment.appendChild(itemsList);

    // "Unhide All" button (hidden until expanded)
    const unhideAllBtn = document.createElement('button');
    unhideAllBtn.className = 'je-hidden-group-unhide-all';
    unhideAllBtn.textContent = JE.t('hidden_content_unhide_all_show');
    unhideAllBtn.addEventListener('click', () => {
      showUnhideConfirmation(JE.t('hidden_content_unhide_all_confirm') || 'Unhide all items for this show?', () => {
        handleUnhideMany(group.items.map((item) => item._key || item.itemId));
      }, group.seriesName || 'this show');
    });
    fragment.appendChild(unhideAllBtn);

    // Toggle expand/collapse
    expandBtn.addEventListener('click', () => {
      const isExpanded = itemsList.classList.toggle('expanded');
      expandBtn.classList.toggle('expanded', isExpanded);
      unhideAllBtn.classList.toggle('expanded', isExpanded);
    });

    return fragment;
  }

  /**
   * Creates a grouped card for a show with hidden items (episodes, seasons, or the whole series).
   * @param {Object} group Object with `seriesName`, `seriesId`, and `items` array.
   * @returns {HTMLElement} The group card element.
   */
  function createGroupCard(group) {
    const card = document.createElement('div');
    card.className = 'je-hidden-group-card';

    const seriesItems = group.items.filter(i => i.type === 'Series');
    const episodeItems = group.items.filter(i => i.type !== 'Series');
    const hasEpisodes = episodeItems.length > 0;
    const mainItem = seriesItems[0] || group.items[0];
    const totalItems = group.items.length;
    const tmdbId = mainItem.tmdbId || '';
    const hasJellyfinId = !!group.seriesId;
    const hasTmdbId = !!tmdbId;

    // Poster
    card.appendChild(createGroupPoster(group, tmdbId));

    // Info section
    const { info, nameEl } = createGroupInfo(group, mainItem, totalItems, hasEpisodes, tmdbId);
    card.appendChild(info);

    // Seerr navigation: open the more-info modal when the item has no Jellyfin page (no
    // Jellyfin id) or its Jellyfin media has been deleted. The TMDB id is either stored on the item,
    // or — for an orphan episode whose show is gone — resolved at render time by createGroupPoster
    // and stashed on the poster link's dataset.
    if (JE.jellyseerrMoreInfo) {
      const posterLink = card.querySelector('.je-hidden-group-poster-link');
      const baseMediaType = mainItem.type === 'Series' ? 'tv' : 'movie';
      const openJellyseerr = (e) => {
        const id = tmdbId || (posterLink && posterLink.dataset.resolvedTmdbId);
        if (!id) return;
        const mediaType = tmdbId ? baseMediaType : (posterLink.dataset.resolvedMediaType || 'tv');
        if (e) e.preventDefault();
        JE.jellyseerrMoreInfo.open(parseInt(id, 10), mediaType);
      };
      if (posterLink) {
        if (hasTmdbId && !hasJellyfinId) {
          // No Jellyfin page at all → always open Seerr.
          posterLink.addEventListener('click', openJellyseerr);
          if (nameEl) nameEl.addEventListener('click', openJellyseerr);
        } else {
          // Has a Jellyfin page (or an orphan episode) → divert to Seerr only once the Jellyfin
          // media is gone (createGroupPoster sets data-jellyfin-removed on image failure).
          const guarded = (e) => { if (posterLink.dataset.jellyfinRemoved === '1') openJellyseerr(e); };
          posterLink.addEventListener('click', guarded);
          if (nameEl) nameEl.addEventListener('click', guarded);
        }
      }
    }

    // Single item: inline detail + unhide
    if (totalItems === 1) {
      card.appendChild(createSingleItemDisplay(group, mainItem, hasEpisodes));
      return card;
    }

    // Multi-item: expandable list
    const displayItems = [];
    for (const item of seriesItems) {
      displayItems.push({ ...item, _label: JE.t('hidden_content_entire_show') });
    }
    const sortedEpisodes = [...episodeItems].sort((a, b) => {
      const sa = a.seasonNumber ?? 999;
      const sb = b.seasonNumber ?? 999;
      if (sa !== sb) return sa - sb;
      return (a.episodeNumber ?? 999) - (b.episodeNumber ?? 999);
    });
    for (const item of sortedEpisodes) {
      displayItems.push({ ...item, _label: formatEpisodeLabel(item) });
    }

    card.appendChild(createExpandableItemsList(group, displayItems, totalItems));

    return card;
  }

  /**
   * Creates a section container with a title and optional expand/collapse toggle.
   * @param {string} titleKey Translation key for the section title.
   * @param {HTMLElement} content Content element.
   * @param {Object} [options] Options.
   * @param {boolean} [options.expandable] If true, adds an expand/collapse all button.
   * @returns {HTMLElement} The section element.
   */
  function createSection(titleKey, content, options = {}) {
    const section = document.createElement('div');
    section.className = 'je-hidden-group-section';

    if (options.expandable) {
      const header = document.createElement('div');
      header.className = 'je-hidden-section-header';

      const titleEl = document.createElement('div');
      titleEl.className = 'je-hidden-section-header-title';
      titleEl.textContent = JE.t(titleKey);
      header.appendChild(titleEl);

      const toggleBtn = document.createElement('button');
      toggleBtn.className = 'je-hidden-expand-all-btn';
      toggleBtn.textContent = JE.t('hidden_content_expand_all');
      let allExpanded = false;

      toggleBtn.addEventListener('click', () => {
        allExpanded = !allExpanded;
        toggleBtn.textContent = allExpanded
          ? JE.t('hidden_content_collapse_all')
          : JE.t('hidden_content_expand_all');
        const cards = content.querySelectorAll('.je-hidden-group-card');
        cards.forEach((card) => {
          const items = card.querySelector('.je-hidden-group-items');
          const btn = card.querySelector('.je-hidden-group-expand');
          const unhideAll = card.querySelector('.je-hidden-group-unhide-all');
          if (items) items.classList.toggle('expanded', allExpanded);
          if (btn) btn.classList.toggle('expanded', allExpanded);
          if (unhideAll) unhideAll.classList.toggle('expanded', allExpanded);
        });
      });
      header.appendChild(toggleBtn);
      section.appendChild(header);
    } else {
      const titleEl = document.createElement('div');
      titleEl.className = 'je-hidden-group-section-title';
      titleEl.textContent = JE.t(titleKey);
      section.appendChild(titleEl);
    }

    section.appendChild(content);
    return section;
  }

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
      const libP = ApiClient.ajax({
        type: 'GET',
        url: ApiClient.getUrl('/Items', {
          userId: ApiClient.getCurrentUserId(), searchTerm: term, IncludeItemTypes: 'Movie,Series',
          Recursive: true, Limit: 24, Fields: 'ProviderIds', ImageTypeLimit: 1, EnableImageTypes: 'Primary',
        }),
        dataType: 'json',
      }).then((res) => (res && res.Items) || []).catch(() => []);
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

  // ============================================================
  // Page Show/Hide
  // ============================================================

  /**
   * Shows the hidden content page, hiding the currently active Jellyfin page.
   */
  function showPage() {
    if (state.pageVisible) return;

    const config = JE.pluginConfig || {};
    if (pluginPagesExists && config.HiddenContentUsePluginPages) return;
    if (config.HiddenContentUseCustomTabs) return;
    if (config.HiddenContentUseNativeTab) return;

    state.pageVisible = true;

    startLocationWatcher();
    injectStyles();
    const page = createPageContainer();

    const expectedHash = '#/hidden-content';
    if (window.location.hash !== expectedHash) {
      history.pushState({ page: "hidden-content" }, "Hidden Content", expectedHash);
    }

    const activePage = document.querySelector(".mainAnimatedPage:not(.hide):not(#je-hidden-content-page)");
    if (activePage) {
      state.previousPage = activePage;
      activePage.classList.add("hide");
      activePage.dispatchEvent(
        new CustomEvent("viewhide", {
          bubbles: true,
          detail: { type: "interior" },
        }),
      );
    }

    page.classList.remove("hide");

    page.dispatchEvent(
      new CustomEvent("viewshow", {
        bubbles: true,
        detail: {
          type: "custom",
          isRestored: false,
          options: {},
        },
      }),
    );

    page.dispatchEvent(
      new CustomEvent("pageshow", {
        bubbles: true,
        detail: {},
      }),
    );

    renderPage();
  }

  /**
   * Hides the hidden content page and restores the previous Jellyfin page.
   */
  function hidePage() {
    if (!state.pageVisible) return;

    const page = document.getElementById("je-hidden-content-page");
    if (page) {
      page.classList.add("hide");
      page.dispatchEvent(
        new CustomEvent("viewhide", {
          bubbles: true,
          detail: { type: "custom" },
        }),
      );
    }

    if (state.previousPage && !document.querySelector(".mainAnimatedPage:not(.hide):not(#je-hidden-content-page)")) {
      state.previousPage.classList.remove("hide");
      state.previousPage.dispatchEvent(
        new CustomEvent("viewshow", {
          bubbles: true,
          detail: { type: "interior", isRestored: true },
        }),
      );
    }

    state.pageVisible = false;
    state.previousPage = null;
    state.searchQuery = '';
    // Reset admin cross-user view so re-opening the page starts on the admin's own
    // list rather than a stale "Viewing: <user>" snapshot, and the dropdown re-initialises fresh.
    // Bumping adminLoadToken invalidates any in-flight cross-user fetch so a late completion can't
    // repopulate adminItems after the page has been left.
    state.adminLoadToken++;
    state.selectedAdminUserId = null;
    state.adminEditMode = false;
    state.adminItems = null;
    state.adminItemsUserId = null;
    state.adminLoadError = false;
    state.adminUserName = '';
    state.scopedOnly = false;
    state.adminUsers = null;
    // Clear the loading flag too: an in-flight user-list fetch now discards its result via the token
    // check, so re-opening the page must be free to start a fresh fetch.
    state.adminUsersLoading = false;
    stopLocationWatcher();
  }

  // ============================================================
  // Event Handlers
  // ============================================================

  /**
   * Handles navigation events — shows or hides the page based on the URL.
   */
  function handleNavigation() {
    const hash = window.location.hash;
    const path = window.location.pathname;
    if (hash.startsWith("#/hidden-content") || path === "/hidden-content") {
      showPage();
    } else if (state.pageVisible) {
      hidePage();
    }
  }

  /**
   * Handles viewshow events from Jellyfin's page system.
   * Hides our page when Jellyfin shows a different page.
   * @param {CustomEvent} e The viewshow event.
   */
  function handleViewShow(e) {
    const targetPage = e.target;
    if (state.pageVisible && targetPage && targetPage.id !== "je-hidden-content-page") {
      hidePage();
    }
  }

  /**
   * Handles clicks on Jellyfin navigation elements.
   * Hides our page when the user clicks a nav button that isn't ours.
   * @param {MouseEvent} e The click event.
   */
  function handleNavClick(e) {
    if (!state.pageVisible) return;

    const btn = e.target.closest(".headerTabs button, .navMenuOption, .headerButton");
    if (btn && !btn.classList.contains("je-nav-hidden-content-item")) {
      hidePage();
    }
  }

  /**
   * Render content for custom tabs (without page state management).
   * @param {HTMLElement} [targetContainer] - Optional container element to
   *   render into, avoiding global getElementById lookups.
   */
  function renderForCustomTab(targetContainer) {
    state._customTabMode = true;
    injectStyles();
    renderPage(targetContainer);
  }

  /**
   * Injects the "Hidden Content" navigation item into the sidebar.
   * Inserts after the Calendar nav item if present, otherwise appends at end.
   */
  function injectNavigation() {
    const config = JE.pluginConfig || {};
    if (!config.HiddenContentEnabled) return;
    if (pluginPagesExists && config.HiddenContentUsePluginPages) return;
    if (config.HiddenContentUseCustomTabs) return;
    if (config.HiddenContentUseNativeTab) return;

    const pluginPageItem = sidebar?.querySelector(
      'a[is="emby-linkbutton"][data-itemid="Jellyfin.Plugin.JellyfinEnhanced.HiddenContentPage"]'
    );

    if (pluginPageItem) {
      pluginPageItem.style.setProperty('display', 'none', 'important');
    }

    if (document.querySelector(".je-nav-hidden-content-item")) return;

    const jellyfinEnhancedSection = document.querySelector('.jellyfinEnhancedSection');

    if (jellyfinEnhancedSection) {
      const navItem = document.createElement("a");
      navItem.setAttribute('is', 'emby-linkbutton');
      navItem.className =
        "navMenuOption lnkMediaFolder emby-button je-nav-hidden-content-item";
      navItem.href = "#";

      const iconSpan = document.createElement("span");
      iconSpan.className = "navMenuOptionIcon material-icons";
      iconSpan.textContent = "visibility_off";
      navItem.appendChild(iconSpan);

      const textSpan = document.createElement("span");
      textSpan.className = "sectionName navMenuOptionText";
      textSpan.textContent = JE.t("hidden_content_manage_title");
      navItem.appendChild(textSpan);

      navItem.addEventListener("click", (e) => {
        e.preventDefault();
        showPage();
      });

      const calendarNavItem = jellyfinEnhancedSection.querySelector('.je-nav-calendar-item');
      if (calendarNavItem && calendarNavItem.nextSibling) {
        jellyfinEnhancedSection.insertBefore(navItem, calendarNavItem.nextSibling);
      } else if (calendarNavItem) {
        jellyfinEnhancedSection.appendChild(navItem);
      } else {
        jellyfinEnhancedSection.appendChild(navItem);
      }
      console.log(`${logPrefix} Navigation item injected`);
    } else {
      console.log(`${logPrefix} jellyfinEnhancedSection not found, will wait for it`);
    }
  }

  /**
   * Sets up a MutationObserver to re-inject the navigation item when
   * Jellyfin rebuilds the sidebar.
   */
  function setupNavigationWatcher() {
    const config = JE.pluginConfig || {};
    if (!config.HiddenContentEnabled) return;
    if (pluginPagesExists && config.HiddenContentUsePluginPages) return;
    if (config.HiddenContentUseCustomTabs) return;
    if (config.HiddenContentUseNativeTab) return;

    const observer = new MutationObserver(() => {
      const currentConfig = JE.pluginConfig || {};
      if (currentConfig.HiddenContentUseCustomTabs) return;
      if (currentConfig.HiddenContentUseNativeTab) return;
      if (pluginPagesExists && currentConfig.HiddenContentUsePluginPages) return;

      if (!document.querySelector('.je-nav-hidden-content-item')) {
        const jellyfinEnhancedSection = document.querySelector('.jellyfinEnhancedSection');
        if (jellyfinEnhancedSection) {
          console.log(`${logPrefix} Sidebar rebuilt, re-injecting navigation`);
          injectNavigation();
        }
      }
    });

    const navDrawer = document.querySelector('.mainDrawer, .navDrawer, body');
    if (navDrawer) {
      observer.observe(navDrawer, { childList: true, subtree: true });
    }
  }

  // ============================================================
  // Public API
  // ============================================================

  JE.hiddenContentPage = {
    initialize,
    showPage,
    hidePage,
    renderPage,
    renderForCustomTab,
    injectStyles,
  };

  JE.initializeHiddenContentPage = initialize;
})();
