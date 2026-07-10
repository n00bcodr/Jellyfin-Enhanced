/**
 * Requests Custom Tab
 * Creates <div class="jellyfinenhanced requests"></div>, either inside a tab
 * panel managed by the external Custom Tabs plugin (DownloadsUseCustomTabs),
 * or inside a panel JE creates itself via the shared native-tabs registry
 * (DownloadsUseNativeTab, see enhanced/native-tabs.js) -- no external plugin
 * needed for the latter. The rest of this file (finding the active container,
 * rendering into it, polling) doesn't care which one created the wrapping
 * panel, since both end up as a `.tabContent` with `.is-active` toggled by
 * Jellyfin's own tab-switching logic.
 *
 * Uses a persistent observer to remount whenever the home page DOM is rebuilt
 * (e.g. after SPA navigation). Only runs when on the home page; suspends
 * when navigated away.
 */

(function () {
  'use strict';

  if (!window.JellyfinEnhanced?.pluginConfig?.DownloadsPageEnabled) {
    return;
  }

  var useCustomTabs = !!window.JellyfinEnhanced?.pluginConfig?.DownloadsUseCustomTabs;
  var useNativeTab = !!window.JellyfinEnhanced?.pluginConfig?.DownloadsUseNativeTab;

  console.log('🪼 Jellyfin Enhanced: [requests-custom-tab] DownloadsUseCustomTabs=' + useCustomTabs + ', DownloadsUseNativeTab=' + useNativeTab);

  if (!useCustomTabs && !useNativeTab) {
    return;
  }

  if (useNativeTab) {
    window.JellyfinEnhanced.nativeTabs.register('requests', 'Requests', function (panel) {
      var marker = document.createElement('div');
      marker.className = 'jellyfinenhanced requests';
      panel.appendChild(marker);
    }, 'download');
  }

  var style = document.createElement('style');
  style.textContent = [
    '.jellyfinenhanced.requests {',
    '  padding: 12px 3vw;',
    '}',
    '.backgroundContainer.withBackdrop:has(~ .mainAnimatedPages #indexPage .tabContent.is-active .jellyfinenhanced.requests) {',
    '  background: rgba(0, 0, 0, 0.7) !important;',
    '}'
  ].join('\n');
  document.head.appendChild(style);

  /** The last DOM node we mounted into. */
  var lastMountedContainer = null;

  /** @returns {boolean} Whether the current URL hash is the home page. */
  function isOnHomePage() {
    var hash = window.location.hash;
    return hash === '' || hash === '#/home' || hash === '#/home.html'
      || hash.indexOf('#/home?') !== -1 || hash.indexOf('#/home.html?') !== -1;
  }

  /** Wait for JE.downloadsPage to be ready before initializing (30s timeout). */
  function waitForDownloads(callback) {
    var attempts = 0;
    var check = setInterval(function () {
      if (++attempts > 300) { clearInterval(check); return; }
      var JE = window.JE || window.JellyfinEnhanced;
      if (JE?.downloadsPage) {
        clearInterval(check);
        callback(JE);
      }
    }, 100);
  }

  /**
   * Find the requests container inside the active (non-hidden) home page.
   * Returns null if no visible container exists -- never falls back to a
   * stale DOM-cached copy.
   *
   * Tries three anchors in order so the mount works regardless of how the
   * host plugin (Custom Tabs, Plugin Pages, etc.) wraps the content:
   *  1. Nearest `.page` ancestor that doesn't have `.hide`  (standard Jellyfin)
   *  2. Nearest `.tabContent` ancestor that has `.is-active`  (Custom Tabs fallback)
   *  3. Element is itself visible (offsetParent !== null)     (last resort)
   *
   * @returns {HTMLElement|null}
   */
  function findActiveContainer() {
    var all = document.querySelectorAll('.jellyfinenhanced.requests');
    for (var i = all.length - 1; i >= 0; i--) {
      var el = all[i];
      // 1. Standard Jellyfin page structure
      var page = el.closest('.page');
      if (page && !page.classList.contains('hide')) return el;
      // 2. Custom Tabs wraps content in .tabContent.is-active (no .page ancestor)
      var tabContent = el.closest('.tabContent');
      if (tabContent && tabContent.classList.contains('is-active')) return el;
      // 3. Last resort: element is simply visible in the document
      if (!page && !tabContent && el.offsetParent !== null) return el;
    }
    return null;
  }

  /**
   * Render downloads into the given container using a scoped child element.
   * @param {HTMLElement} container - The active .jellyfinenhanced.requests element.
   * @param {Object} JE - The JellyfinEnhanced global object.
   */
  function renderDownloads(container, JE) {
    container.classList.remove('hide');
    container.style.display = '';

    var child = document.createElement('div');
    child.id = 'je-downloads-container-tab';
    container.textContent = '';
    container.appendChild(child);

    JE.downloadsPage.renderForCustomTab?.(child);

    lastMountedContainer = container;
  }

  /**
   * Persistent watcher -- observes document.body (via shared observer) for
   * DOM rebuilds and remounts the requests tab when a new active container
   * appears. Suspends checks when not on the home page.
   * @param {Object} JE - The JellyfinEnhanced global object.
   */
  function watchForContainer(JE) {
    /** Whether we were on the home page on the last check. */
    var wasOnHomePage = false;

    function tryMount() {
      var onHome = isOnHomePage();

      // Navigated away — stop polling and clear custom tab mode so the
      // timer's own visibility guard doesn't keep it alive.
      if (!onHome) {
        if (wasOnHomePage) {
          JE.downloadsPage.stopPolling?.();
          if (JE.downloadsPage._state) {
            JE.downloadsPage._state._customTabMode = false;
          }
          lastMountedContainer = null;
        }
        wasOnHomePage = false;
        return;
      }

      // Returned to home page — force a remount so polling restarts even if
      // the container DOM node was not rebuilt (Jellyfin reuses it).
      var justReturned = !wasOnHomePage;
      wasOnHomePage = true;

      var container = findActiveContainer();
      if (!container) {
        // Still on the home page, but our tab panel isn't the active one
        // (user switched to a sibling tab like Home/Favorites) -- stop
        // polling so it doesn't keep running against a hidden tab.
        if (lastMountedContainer) {
          JE.downloadsPage.stopPolling?.();
          if (JE.downloadsPage._state) {
            JE.downloadsPage._state._customTabMode = false;
          }
        }
        lastMountedContainer = null;
        return;
      }

      var shouldMount = justReturned
        || container !== lastMountedContainer
        || !container.hasChildNodes()
        || (lastMountedContainer && !document.contains(lastMountedContainer));

      if (shouldMount) {
        renderDownloads(container, JE);
      }
    }

    tryMount();

    // Also react immediately to hash changes so polling stops as soon as the
    // user navigates away, without waiting for a DOM mutation to fire.
    window.addEventListener('hashchange', tryMount);

    // Observe document.body (not .mainAnimatedPages) because Jellyfin replaces
    // .mainAnimatedPages when navigating to the admin dashboard — an observer
    // bound to the old element would become orphaned after returning to home
    // (issue 536). Routes to the shared multiplexed body observer.
    var mountPending = false;
    JE.helpers.createObserver('arr-requests-custom-tab', function () {
      if (!mountPending) {
        mountPending = true;
        requestAnimationFrame(function () {
          mountPending = false;
          tryMount();
        });
      }
    }, document.body, { childList: true, subtree: true });
  }

  waitForDownloads(function (JE) {
    watchForContainer(JE);
  });

})();
