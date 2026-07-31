/**
 * Bookmarks Library View — standalone page + sidebar navigation.
 * Split from bookmarks-library.js (code motion; bodies verbatim).
 */
(function (JE) {
  'use strict';

  JE.internals = JE.internals || {};
  const internal = JE.internals.bookmarksLibrary = JE.internals.bookmarksLibrary || {};

  if (!JE?.pluginConfig?.BookmarksEnabled) return;

  // Late-bound cross-module reference (defined in bookmarks-library-render.js).
  const renderIfSectionExists = (...args) => internal.renderIfSectionExists(...args);

  const logPrefix = '🪼 Jellyfin Enhanced: Bookmarks Library:';

  // Sidebar navigation state
  /** Polling interval for detecting pushState navigations. */
  const LOCATION_WATCH_INTERVAL_MS = 150;

  const pageState = {
    pageVisible: false,
    previousPage: null,
    locationSignature: null,
    locationTimer: null,
  };

  /** Re-evaluated each call so it stays correct even when the sidebar renders late. */
  function isPluginPagesActive() {
    const config = JE?.pluginConfig || {};
    if (!config.BookmarksUsePluginPages) return false;
    const sb = document.querySelector('.mainDrawer-scrollContainer');
    return !!sb?.querySelector('a[is="emby-linkbutton"][data-itemid="Jellyfin.Plugin.JellyfinEnhanced.BookmarksPage"]');
  }

  // ============================================================
  // Standalone page (sidebar navigation, no Plugin Pages / Custom Tabs)
  // ============================================================

  /**
   * Creates or retrieves the bookmarks standalone page container.
   * @returns {HTMLElement}
   */
  function createPageContainer() {
    let page = document.getElementById('je-bookmarks-standalone-page');
    if (!page) {
      page = document.createElement('div');
      page.id = 'je-bookmarks-standalone-page';
      page.className = 'page type-interior mainAnimatedPage hide';
      page.setAttribute('data-title', 'Bookmarks');
      page.setAttribute('data-backbutton', 'true');
      page.setAttribute('data-url', '#/bookmarks');
      page.setAttribute('data-type', 'custom');

      const contentWrapper = document.createElement('div');
      contentWrapper.setAttribute('data-role', 'content');

      const contentPrimary = document.createElement('div');
      contentPrimary.className = 'content-primary je-bookmarks-page';

      const container = document.createElement('div');
      container.className = 'sections bookmarks';

      contentPrimary.appendChild(container);
      contentWrapper.appendChild(contentPrimary);
      page.appendChild(contentWrapper);

      const mainContent = document.querySelector('.mainAnimatedPages');
      if (mainContent) {
        mainContent.appendChild(page);
      } else {
        document.body.appendChild(page);
      }
    }
    return page;
  }

  /**
   * Shows the standalone bookmarks page, hiding the currently active Jellyfin page.
   */
  function showPage() {
    if (pageState.pageVisible) return;
    if (isPluginPagesActive()) return;
    if (JE?.pluginConfig?.BookmarksUseCustomTabs) return;
    if (JE?.pluginConfig?.BookmarksUseNativeTab) return;

    pageState.pageVisible = true;
    startLocationWatcher();
    const page = createPageContainer();

    const expectedHash = '#/bookmarks';
    if (window.location.hash !== expectedHash) {
      history.pushState({ page: 'bookmarks' }, 'Bookmarks', expectedHash);
    }

    const activePage = document.querySelector('.mainAnimatedPage:not(.hide):not(#je-bookmarks-standalone-page)');
    if (activePage) {
      pageState.previousPage = activePage;
      activePage.classList.add('hide');
      activePage.dispatchEvent(
        new CustomEvent('viewhide', {
          bubbles: true,
          detail: { type: 'interior' },
        }),
      );
    }

    page.classList.remove('hide');

    page.dispatchEvent(
      new CustomEvent('viewshow', {
        bubbles: true,
        detail: {
          type: 'custom',
          isRestored: false,
          options: {},
        },
      }),
    );

    page.dispatchEvent(
      new CustomEvent('pageshow', {
        bubbles: true,
        detail: {},
      }),
    );

    // Trigger render into the standalone page's container
    renderIfSectionExists();
  }

  /**
   * Hides the standalone bookmarks page and restores the previous view.
   */
  function hidePage() {
    if (!pageState.pageVisible) return;

    const page = document.getElementById('je-bookmarks-standalone-page');
    if (page) {
      page.classList.add('hide');
      page.dispatchEvent(
        new CustomEvent('viewhide', {
          bubbles: true,
          detail: { type: 'custom' },
        }),
      );
    }

    if (pageState.previousPage && !document.querySelector('.mainAnimatedPage:not(.hide):not(#je-bookmarks-standalone-page)')) {
      pageState.previousPage.classList.remove('hide');
      pageState.previousPage.dispatchEvent(
        new CustomEvent('viewshow', {
          bubbles: true,
          detail: { type: 'interior', isRestored: true },
        }),
      );
    }

    pageState.pageVisible = false;
    pageState.previousPage = null;
    stopLocationWatcher();
  }

  /**
   * Starts polling for pushState-based navigation changes.
   * Jellyfin's router uses pushState which doesn't fire popstate/hashchange.
   */
  function startLocationWatcher() {
    if (pageState.locationTimer) return;
    pageState.locationSignature = `${window.location.pathname}${window.location.hash}`;
    pageState.locationTimer = setInterval(() => {
      const signature = `${window.location.pathname}${window.location.hash}`;
      if (signature !== pageState.locationSignature) {
        pageState.locationSignature = signature;
        handleNavigation();
      }
    }, LOCATION_WATCH_INTERVAL_MS);
  }

  /**
   * Stops the location polling interval.
   */
  function stopLocationWatcher() {
    if (pageState.locationTimer) {
      clearInterval(pageState.locationTimer);
      pageState.locationTimer = null;
    }
  }

  /**
   * Handles navigation events -- shows or hides the page based on the URL.
   */
  function handleNavigation() {
    const hash = window.location.hash;
    const path = window.location.pathname;
    if (hash.startsWith('#/bookmarks') || path === '/bookmarks') {
      showPage();
    } else if (pageState.pageVisible) {
      hidePage();
    }
  }

  /**
   * Intercepts hash/popstate changes for the bookmarks route before
   * Jellyfin's native router can handle them.
   * @param {HashChangeEvent|PopStateEvent} e The navigation event.
   */
  function interceptNavigation(e) {
    const url = e?.newURL ? new URL(e.newURL) : window.location;
    const hash = url.hash;
    const path = url.pathname;
    if (hash.startsWith('#/bookmarks') || path === '/bookmarks') {
      if (e?.stopImmediatePropagation) e.stopImmediatePropagation();
      if (e?.preventDefault) e.preventDefault();
      showPage();
    }
  }

  /**
   * Handles viewshow events from Jellyfin's page system.
   * Hides our page when Jellyfin shows a different page.
   * @param {CustomEvent} e The viewshow event.
   */
  function handleViewShow(e) {
    const targetPage = e.target;
    if (pageState.pageVisible && targetPage && targetPage.id !== 'je-bookmarks-standalone-page') {
      hidePage();
    }
  }

  /**
   * Handles clicks on Jellyfin navigation elements.
   * Hides our page when the user clicks a nav button that isn't ours.
   * @param {MouseEvent} e The click event.
   */
  function handleNavClick(e) {
    if (!pageState.pageVisible) return;
    const btn = e.target.closest('.headerTabs button, .navMenuOption, .headerButton');
    if (btn && !btn.classList.contains('je-nav-bookmarks-item')) {
      hidePage();
    }
  }

  /**
   * Injects the Bookmarks navigation item into the sidebar.
   */
  function injectNavigation() {
    if (!JE?.pluginConfig?.BookmarksEnabled) return;
    if (isPluginPagesActive()) return;
    if (JE?.pluginConfig?.BookmarksUseCustomTabs) return;
    if (JE?.pluginConfig?.BookmarksUseNativeTab) return;

    // Hide plugin page link if it exists
    const sb = document.querySelector('.mainDrawer-scrollContainer');
    const pluginPageItem = sb?.querySelector(
      'a[is="emby-linkbutton"][data-itemid="Jellyfin.Plugin.JellyfinEnhanced.BookmarksPage"]'
    );
    if (pluginPageItem) {
      pluginPageItem.style.setProperty('display', 'none', 'important');
    }

    if (document.querySelector('.je-nav-bookmarks-item')) return;

    const jellyfinEnhancedSection = document.querySelector('.jellyfinEnhancedSection');
    if (jellyfinEnhancedSection) {
      const navItem = document.createElement('a');
      navItem.setAttribute('is', 'emby-linkbutton');
      navItem.className = 'navMenuOption lnkMediaFolder emby-button je-nav-bookmarks-item';
      navItem.href = '#';

      const iconSpan = document.createElement('span');
      iconSpan.className = 'navMenuOptionIcon material-icons';
      iconSpan.textContent = 'bookmarks';
      navItem.appendChild(iconSpan);

      const textSpan = document.createElement('span');
      textSpan.className = 'sectionName navMenuOptionText';
      textSpan.textContent = JE.t('bookmarks_library_title') !== 'bookmarks_library_title'
        ? JE.t('bookmarks_library_title') : 'Bookmarks';
      navItem.appendChild(textSpan);

      navItem.addEventListener('click', (e) => {
        e.preventDefault();
        showPage();
      });

      // Insert after hidden-content, or after calendar, or at end
      const hiddenNav = jellyfinEnhancedSection.querySelector('.je-nav-hidden-content-item');
      const calendarNav = jellyfinEnhancedSection.querySelector('.je-nav-calendar-item');
      const insertAfter = hiddenNav || calendarNav;
      if (insertAfter && insertAfter.nextSibling) {
        jellyfinEnhancedSection.insertBefore(navItem, insertAfter.nextSibling);
      } else {
        jellyfinEnhancedSection.appendChild(navItem);
      }
      console.log(`${logPrefix} Navigation item injected`);
    }
  }

  /**
   * Re-injects the sidebar nav item when Jellyfin rebuilds the drawer.
   */
  function setupNavigationWatcher() {
    if (!JE?.pluginConfig?.BookmarksEnabled) return;
    if (isPluginPagesActive()) return;
    if (JE?.pluginConfig?.BookmarksUseCustomTabs) return;
    if (JE?.pluginConfig?.BookmarksUseNativeTab) return;

    const observer = new MutationObserver(() => {
      if (isPluginPagesActive()) return;
      if (!document.querySelector('.je-nav-bookmarks-item') && document.querySelector('.jellyfinEnhancedSection')) {
        injectNavigation();
      }
    });

    const navDrawer = document.querySelector('.mainDrawer, .navDrawer, body');
    if (navDrawer) {
      observer.observe(navDrawer, { childList: true, subtree: true });
    }
  }

  Object.assign(internal, {
    isPluginPagesActive,
    showPage,
    injectNavigation,
    setupNavigationWatcher,
    handleNavigation,
    interceptNavigation,
    handleViewShow,
    handleNavClick,
  });

})(window.JellyfinEnhanced);
