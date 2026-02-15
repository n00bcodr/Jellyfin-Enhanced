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
  };

  const logPrefix = '🪼 Jellyfin Enhanced: Hidden Content Page:';

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

    window.addEventListener('je-hidden-content-changed', () => {
      if (state.pageVisible) {
        renderPage();
      }
    });

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
    if (hasJellyfinId) {
      img.src = `${ApiClient.getUrl('/Items/' + group.seriesId + '/Images/Primary', { maxWidth: POSTER_MAX_WIDTH })}`;
    } else if (group.items[0]?.posterPath) {
      img.src = `https://image.tmdb.org/t/p/w${POSTER_MAX_WIDTH}${group.items[0].posterPath}`;
    } else if (group.items[0]?.itemId) {
      img.src = `${ApiClient.getUrl('/Items/' + group.items[0].itemId + '/Images/Primary', { maxWidth: POSTER_MAX_WIDTH })}`;
    }
    img.alt = '';
    img.loading = 'lazy';
    img.onerror = function() { this.style.display = 'none'; };
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
        badge.textContent = JE.t('hidden_content_scope_badge');
        detailDiv.appendChild(badge);
      }
      fragment.appendChild(detailDiv);
    }

    const unhideBtn = document.createElement('button');
    unhideBtn.className = 'je-hidden-group-unhide';
    unhideBtn.textContent = JE.t('hidden_content_unhide');
    unhideBtn.addEventListener('click', () => {
      const itemLabel = hasEpisodes
        ? (group.seriesName || '') + ' \u2013 ' + formatEpisodeLabel(mainItem)
        : (group.seriesName || mainItem.name || 'this item');
      showUnhideConfirmation(JE.t('hidden_content_unhide_confirm') || 'Unhide this item?', () => {
        unhideBtn.closest('.je-hidden-group-card').style.opacity = '0.3';
        setTimeout(() => {
          JE.hiddenContent.unhideItem(mainItem._key || mainItem.itemId);
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
        badge.textContent = JE.t('hidden_content_scope_badge');
        infoCol.appendChild(badge);
      }

      row.appendChild(infoCol);

      const unhideBtn = document.createElement('button');
      unhideBtn.className = 'je-hidden-group-item-unhide';
      unhideBtn.textContent = JE.t('hidden_content_unhide');
      unhideBtn.addEventListener('click', (e) => {
        e.preventDefault();
        const rowLabel = (group.seriesName || '') + ' \u2013 ' + formatEpisodeLabel(item);
        showUnhideConfirmation(JE.t('hidden_content_unhide_confirm') || 'Unhide this item?', () => {
          row.style.opacity = '0.3';
          setTimeout(() => {
            JE.hiddenContent.unhideItem(item._key || item.itemId);
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
        for (const item of group.items) {
          JE.hiddenContent.unhideItem(item._key || item.itemId);
        }
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

    // Jellyseerr navigation handler for items without Jellyfin ID
    if (!hasJellyfinId && hasTmdbId && JE.jellyseerrMoreInfo) {
      const posterLink = card.querySelector('.je-hidden-group-poster-link');
      const openJellyseerr = (e) => {
        e.preventDefault();
        JE.jellyseerrMoreInfo.open(parseInt(tmdbId, 10), 'tv');
      };
      posterLink.addEventListener('click', openJellyseerr);
      nameEl.addEventListener('click', openJellyseerr);
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
    scopedToggle.textContent = JE.t('hidden_content_scope_badge');
    toolbar.appendChild(scopedToggle);

    const unhideAllBtn = document.createElement("button");
    unhideAllBtn.className = "je-hidden-content-page-unhide-all";
    unhideAllBtn.textContent = JE.t('hidden_content_clear_all');
    toolbar.appendChild(unhideAllBtn);

    return { element: toolbar, searchInput, scopedToggle, unhideAllBtn };
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
          badge.textContent = JE.t('hidden_content_scope_nextup');
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
   */
  function renderPage() {
    const page = createPageContainer();
    const container = document.getElementById("je-hidden-content-container");
    if (!page || !container) return;

    const allItems = JE.hiddenContent.getAllHiddenItems();
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

    container.appendChild(createPageHeader(allItems.length));

    const toolbar = createToolbar();
    container.appendChild(toolbar.element);

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
      emptyDiv.textContent = JE.t('hidden_content_manage_empty');
      container.appendChild(emptyDiv);
    } else {
      const { movies, seriesRelated, scopedMovies, castActors } = partitionItems(filtered);
      renderMoviesSection(movies, scopedMovies, container);
      renderSeriesSection(seriesRelated, container);
      renderCastSection(castActors, container);
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

    // Attach unhide all handler
    toolbar.unhideAllBtn.addEventListener('click', () => {
      showUnhideConfirmation(JE.t('hidden_content_clear_confirm') || 'Unhide all items?', () => {
        JE.hiddenContent.unhideAll();
      });
    });
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
            JE.hiddenContent.unhideItem(item._key || item.itemId);
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
   */
  function renderForCustomTab() {
    state._customTabMode = true;
    injectStyles();
    renderPage();
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

    const observer = new MutationObserver(() => {
      const currentConfig = JE.pluginConfig || {};
      if (currentConfig.HiddenContentUseCustomTabs) return;
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
