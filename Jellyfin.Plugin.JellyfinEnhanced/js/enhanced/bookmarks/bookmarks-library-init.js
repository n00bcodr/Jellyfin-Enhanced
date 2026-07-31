/**
 * Bookmarks Library View — initialization / boot.
 * Split from bookmarks-library.js (code motion; bodies verbatim).
 * Loads last: wires navigation, lifecycle listeners, the CustomTabs body
 * observer, and the optional native tab, then triggers the first render.
 */
(function (JE) {
  'use strict';

  JE.internals = JE.internals || {};
  const internal = JE.internals.bookmarksLibrary = JE.internals.bookmarksLibrary || {};

  if (!JE?.pluginConfig?.BookmarksEnabled) return;

  // All earlier-loaded module exports (this file loads last).
  const {
    isPluginPagesActive,
    injectNavigation,
    setupNavigationWatcher,
    handleNavigation,
    interceptNavigation,
    handleViewShow,
    handleNavClick,
    renderIfSectionExists,
    hookViewEvents,
  } = internal;

  const logPrefix = '🪼 Jellyfin Enhanced: Bookmarks Library:';

  function getJE() {
    // Try common globals first
    if (window.JE) return window.JE;
    if (window.JellyfinEnhanced) return window.JellyfinEnhanced;

    // Then parent/top frames (CustomTabs may run in a child frame)
    if (window.parent?.JE) return window.parent.JE;
    if (window.parent?.JellyfinEnhanced) return window.parent.JellyfinEnhanced;
    if (window.top?.JE) return window.top.JE;
    if (window.top?.JellyfinEnhanced) return window.top.JellyfinEnhanced;

    return null;
  }

  /**
   * Initialize
   */
  function init() {
    console.log(`${logPrefix} Initializing (build id: ${Date.now()})...`);

    let attempts = 0;
    const checkReady = setInterval(() => {
      attempts += 1;
      const je = getJE();
      const ready = !!(je && je.userConfig && je.bookmarks);

      if (attempts % 10 === 0 || attempts <= 5) {
        console.log(`${logPrefix} ready check #${attempts} (JE=${!!je}, userConfig=${!!(je && je.userConfig)}, bookmarks=${!!(je && je.bookmarks)})`);
      }

      if (ready) {
        clearInterval(checkReady);
        // If JE is available only on parent/top, make it accessible locally for this script
        if (!window.JE && je) {
          window.JE = je;
        }
        hookViewEvents();
        document.addEventListener('je-bookmarks-updated', renderIfSectionExists);

        // Sidebar navigation (when neither Plugin Pages, Custom Tabs, nor the
        // native tab is handling it)
        if (!isPluginPagesActive() && !JE.pluginConfig?.BookmarksUseCustomTabs && !JE.pluginConfig?.BookmarksUseNativeTab) {
          injectNavigation();
          setupNavigationWatcher();
          const lifecycle = JE.core.lifecycle.register('bookmarks-standalone-page');
          // The capture-phase intercepts need the raw events (they call
          // stopImmediatePropagation before Jellyfin's router reacts), so they
          // stay real listeners — added via the lifecycle handle so they are
          // tracked and removable.
          lifecycle.addListener(window, 'hashchange', interceptNavigation, true);
          lifecycle.addListener(window, 'popstate', interceptNavigation, true);
          lifecycle.addListener(document, 'click', handleNavClick);
          // handleViewShow inspects the raw viewshow event's target; rawEvent
          // is null for router-internal notifications, matching the old
          // document-level listener which only fired on real events.
          JE.core.navigation.onViewPage((view, element, hash, itemPromise, rawEvent) => {
            if (rawEvent) handleViewShow(rawEvent);
          });
          // Show/hide the standalone page on every nav path — hashchange,
          // popstate AND pushState transitions the raw listeners missed.
          JE.core.navigation.onNavigate(handleNavigation);
          handleNavigation();
        }

        // Native tab (self-contained, no external Custom Tabs plugin needed -
        // see enhanced/native-tabs.js). The existing Custom Tabs watcher below
        // (findActiveBookmarksContainer / renderIfSectionExists) already treats
        // any ".sections.bookmarks" wrapped in an ".is-active" tabContent as
        // valid, so it picks up our own panel unmodified.
        if (JE.pluginConfig?.BookmarksUseNativeTab) {
          JE.nativeTabs.register('bookmarks', 'Bookmarks', (panel) => {
            const marker = document.createElement('div');
            marker.className = 'sections bookmarks';
            panel.appendChild(marker);
          }, 'location_on');
        }

        // Watch for section being injected by CustomTabs. Observe document.body
        // (not .mainAnimatedPages) because Jellyfin replaces .mainAnimatedPages
        // when navigating to the admin dashboard — an observer bound to the old
        // element would become orphaned after returning to home (issue 536).
        // Routes to the shared multiplexed body observer.
        let mountPending = false;
        JE.helpers.createObserver('bookmarks-library-custom-tab', () => {
          if (!mountPending) {
            mountPending = true;
            requestAnimationFrame(() => {
              mountPending = false;
              renderIfSectionExists();
            });
          }
        }, document.body, { childList: true, subtree: true });

        // Try immediate render in case tab is already visible
        renderIfSectionExists();
        console.log(`${logPrefix} ✓ Ready`);
      }
    }, 100);
  }

  // Initialize
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})(window.JellyfinEnhanced);
