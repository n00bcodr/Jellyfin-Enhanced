import { bookmarksHost, findBridge, type BookmarkHost } from './host';
import { createLifetime } from './lifetime';
const { ctx, host, getApi } = bookmarksHost();
/**
 * Bookmarks Library View — initialization / boot.
 * Typed entry retaining the established library DOM and public bridge.
 * Loads last: wires navigation, lifecycle listeners, the CustomTabs body
 * observer, and the optional native tab, then triggers the first render.
 */
function install(JE: BookmarkHost) {
  const lifetime = createLifetime(ctx, 'library-init');
  const setInterval = lifetime.interval;

  
  const internal = ctx.own.bookmarksLibrary = ctx.own.bookmarksLibrary || {};

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

  if (!isPluginPagesActive || !injectNavigation || !setupNavigationWatcher || !handleNavigation || !interceptNavigation || !handleViewShow || !handleNavClick || !renderIfSectionExists || !hookViewEvents) throw new Error('Bookmarks library entry order invalid');
  const logPrefix = '🪼 Jellyfin Enhanced: Bookmarks Library:';

  function getJE() {
    // This window's bridge, else a same-origin parent frame's (host.ts findBridge).
    return findBridge(host);
  }

  /**
   * Initialize
   */
  const init = () => {
    console.log(`${logPrefix} Initializing (build id: ${Date.now()})...`);

    let attempts = 0;
    const checkReady = setInterval(() => {
      attempts += 1;
      if (attempts > 300) { clearInterval(checkReady); return; }
      const je = getJE();
      const ready = !!(je && je.userConfig && je.bookmarks);

      if (attempts % 10 === 0 || attempts <= 5) {
        console.log(`${logPrefix} ready check #${attempts} (JE=${!!je}, userConfig=${!!(je && je.userConfig)}, bookmarks=${!!(je && je.bookmarks)})`);
      }

      if (ready) {
        clearInterval(checkReady);
        // If JE is available only on parent/top, make it accessible locally for this script
        if (!host.JE && je) {
          host.JE = je;
        }
        hookViewEvents();

        // Sidebar navigation (when neither Plugin Pages, Custom Tabs, nor the
        // native tab is handling it)
        if (!isPluginPagesActive() && !JE.pluginConfig?.BookmarksUseCustomTabs && !JE.pluginConfig?.BookmarksUseNativeTab) {
          injectNavigation();
          setupNavigationWatcher();
          
          // The capture-phase intercepts need the raw events (they call
          // stopImmediatePropagation before Jellyfin's router reacts), so they
          // stay real listeners — added via the lifecycle handle so they are
          // tracked and removable.
          lifetime.listen(window, 'hashchange', interceptNavigation, true);
          lifetime.listen(window, 'popstate', interceptNavigation, true);
          lifetime.listen(document, 'click', handleNavClick);
          // handleViewShow inspects the raw viewshow event's target; rawEvent
          // is null for router-internal notifications, matching the old
          // document-level listener which only fired on real events.
          lifetime.keep(JE.core.navigation.onViewPage((view, element, hash, itemPromise, rawEvent) => {
            if (rawEvent) handleViewShow(rawEvent);
          }));
          // Show/hide the standalone page on every nav path — hashchange,
          // popstate AND pushState transitions the raw listeners missed.
          lifetime.keep(JE.core.navigation.onNavigate(handleNavigation));
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
        lifetime.keep(JE.helpers.observeTabContainers('bookmarks-library-custom-tab', '.sections.bookmarks', renderIfSectionExists));

        // Try immediate render in case tab is already visible
        renderIfSectionExists();
        console.log(`${logPrefix} ✓ Ready`);
      }
    }, 100);
  }

  // Initialize
  if (document.readyState === 'loading') {
    lifetime.listen(document, 'DOMContentLoaded', init);
  } else {
    init();
  }

}
install(ctx.core);
