// /js/enhanced/hidden-content-page.js
// Hidden Content Page - Sidebar navigation page for managing hidden items
(function () {
  "use strict";

  const JE = window.JellyfinEnhanced;

  // State management
  const state = {
    pageVisible: false,
    previousPage: null,
    searchQuery: '',
    locationSignature: null,
    locationTimer: null,
  };

  const logPrefix = '\u{1f42c} Jellyfin Enhanced: Hidden Content Page:';

  // CSS Styles
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

  /**
   * Initialize hidden content page
   */
  function initialize() {
    console.log(`${logPrefix} Initializing hidden content page module`);

    const config = JE.pluginConfig || {};
    if (!config.HiddenContentPageEnabled) {
      console.log(`${logPrefix} Hidden content page is disabled`);
      return;
    }

    if (!JE.hiddenContent) {
      console.log(`${logPrefix} Hidden content not initialized, skipping page module`);
      return;
    }

    injectStyles();

    // Inject navigation and set up re-injection on sidebar rebuild
    injectNavigation();
    setupNavigationWatcher();

    // Setup event listeners
    window.addEventListener("hashchange", interceptNavigation, true);
    window.addEventListener("popstate", interceptNavigation, true);
    document.addEventListener("viewshow", handleViewShow);
    document.addEventListener("click", handleNavClick);
    window.addEventListener("hashchange", handleNavigation);
    window.addEventListener("popstate", handleNavigation);

    startLocationWatcher();

    // Listen for hidden content changes to re-render
    window.addEventListener('je-hidden-content-changed', () => {
      if (state.pageVisible) {
        renderPage();
      }
    });

    // Check URL on init
    handleNavigation();

    console.log(`${logPrefix} Hidden content page module initialized`);
  }

  /**
   * Intercept hash/popstate changes for our route before Jellyfin router
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

  // Poll location because Jellyfin's router uses pushState (no popstate/hashchange fired for pushState)
  function startLocationWatcher() {
    if (state.locationTimer) return;
    state.locationSignature = `${window.location.pathname}${window.location.hash}`;
    state.locationTimer = setInterval(() => {
      const signature = `${window.location.pathname}${window.location.hash}`;
      if (signature !== state.locationSignature) {
        state.locationSignature = signature;
        handleNavigation();
      }
    }, 150);
  }

  function stopLocationWatcher() {
    if (state.locationTimer) {
      clearInterval(state.locationTimer);
      state.locationTimer = null;
    }
  }

  // Inject CSS styles into page
  function injectStyles() {
    if (document.getElementById("je-hidden-content-page-styles")) return;
    const style = document.createElement("style");
    style.id = "je-hidden-content-page-styles";
    style.textContent = CSS_STYLES;
    document.head.appendChild(style);
  }

  // Create or get page container element
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
   * Render the full page
   */
  function renderPage() {
    const page = createPageContainer();
    const container = document.getElementById("je-hidden-content-container");
    if (!page || !container) return;

    const allItems = JE.hiddenContent.getAllHiddenItems();
    const searchQuery = state.searchQuery.toLowerCase();

    const filtered = searchQuery
      ? allItems.filter(i => i.name?.toLowerCase().includes(searchQuery))
      : [...allItems];

    // Sort by hiddenAt descending (most recent first)
    filtered.sort((a, b) => {
      const da = a.hiddenAt ? new Date(a.hiddenAt).getTime() : 0;
      const db = b.hiddenAt ? new Date(b.hiddenAt).getTime() : 0;
      return db - da;
    });

    // Clear container
    container.replaceChildren();

    // Build header
    const header = document.createElement("div");
    header.className = "je-hidden-content-header";
    const title = document.createElement("h1");
    title.className = "je-hidden-content-title";
    title.textContent = JE.t('hidden_content_manage_title');
    const countSpan = document.createElement("span");
    countSpan.className = "je-hidden-content-count";
    countSpan.textContent = `(${allItems.length})`;
    title.appendChild(countSpan);
    header.appendChild(title);
    container.appendChild(header);

    // Build toolbar
    const toolbar = document.createElement("div");
    toolbar.className = "je-hidden-content-toolbar";

    const searchInput = document.createElement("input");
    searchInput.type = "text";
    searchInput.className = "je-hidden-content-page-search";
    searchInput.placeholder = JE.t('hidden_content_manage_search') || 'Search hidden items...';
    searchInput.value = state.searchQuery;
    toolbar.appendChild(searchInput);

    const unhideAllBtn = document.createElement("button");
    unhideAllBtn.className = "je-hidden-content-page-unhide-all";
    unhideAllBtn.textContent = JE.t('hidden_content_clear_all');
    toolbar.appendChild(unhideAllBtn);

    container.appendChild(toolbar);

    // Build grid or empty state
    if (filtered.length === 0) {
      const emptyDiv = document.createElement("div");
      emptyDiv.className = "je-hidden-content-page-empty";
      emptyDiv.textContent = JE.t('hidden_content_manage_empty');
      container.appendChild(emptyDiv);
    } else {
      const grid = document.createElement("div");
      grid.className = "je-hidden-content-page-grid";

      for (const item of filtered) {
        const card = JE.hiddenContent.createItemCard(item, () => hidePage());

        const unhideBtn = card.querySelector('.je-hidden-item-unhide');
        if (unhideBtn) {
          unhideBtn.addEventListener('click', () => {
            card.classList.add('je-hidden-item-removing');
            setTimeout(() => {
              JE.hiddenContent.unhideItem(item.itemId);
              // Re-render will happen via je-hidden-content-changed event
            }, 300);
          });
        }

        grid.appendChild(card);
      }

      container.appendChild(grid);
    }

    // Attach search handler
    searchInput.addEventListener('input', () => {
      state.searchQuery = searchInput.value;
      renderPage();
    });

    // Restore focus after re-render
    if (state.searchQuery) {
      searchInput.focus();
      searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length);
    }

    // Attach unhide all handler
    unhideAllBtn.addEventListener('click', () => {
      if (!confirm(JE.t('hidden_content_clear_confirm'))) return;
      JE.hiddenContent.unhideAll();
      // Re-render will happen via je-hidden-content-changed event
    });
  }

  /**
   * Show page
   */
  function showPage() {
    if (state.pageVisible) return;

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
   * Hide page
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

    // Restore the previous page if Jellyfin's router hasn't already shown another page
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

  /**
   * Handle navigation
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
   * Handle viewshow events
   */
  function handleViewShow(e) {
    const targetPage = e.target;
    if (state.pageVisible && targetPage && targetPage.id !== "je-hidden-content-page") {
      hidePage();
    }
  }

  /**
   * Handle nav click
   */
  function handleNavClick(e) {
    if (!state.pageVisible) return;

    const btn = e.target.closest(".headerTabs button, .navMenuOption, .headerButton");
    if (btn && !btn.classList.contains("je-nav-hidden-content-item")) {
      hidePage();
    }
  }

  /**
   * Inject navigation item into sidebar
   */
  function injectNavigation() {
    const config = JE.pluginConfig || {};
    if (!config.HiddenContentPageEnabled) return;

    // Check if already exists
    if (document.querySelector(".je-nav-hidden-content-item")) {
      return;
    }

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

      // Insert after Calendar nav item if it exists, otherwise append at end
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
   * Setup navigation watcher - observes only when link is missing
   */
  function setupNavigationWatcher() {
    const observer = new MutationObserver(() => {
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

  // Export to JE namespace
  JE.hiddenContentPage = {
    initialize,
    showPage,
    hidePage,
    renderPage,
  };

  JE.initializeHiddenContentPage = initialize;
})();
