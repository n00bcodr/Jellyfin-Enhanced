/**
 * Recommendations Custom Tab
 * Creates <div class="jellyfinenhanced recommendations"></div>, either inside a tab
 * panel managed by the external Custom Tabs plugin (RecommendationsUseCustomTabs),
 * or inside a panel JE creates itself via the shared native-tabs registry
 * (RecommendationsUseNativeTab, see enhanced/native-tabs.js) -- no external plugin
 * needed for the latter. The rest of this file doesn't care which one
 * created the wrapping panel.
 *
 * Uses a persistent observer to remount whenever the home page DOM is rebuilt
 * (e.g. after SPA navigation). Only runs when on the home page; suspends
 * when navigated away.
 */

(function () {
  'use strict';

  if (!window.JellyfinEnhanced?.pluginConfig?.RecommendationsPageEnabled) {
    return;
  }

  var useCustomTabs = !!window.JellyfinEnhanced?.pluginConfig?.RecommendationsUseCustomTabs;
  var useNativeTab = !!window.JellyfinEnhanced?.pluginConfig?.RecommendationsUseNativeTab;

  if (!useCustomTabs && !useNativeTab) {
    return;
  }

  if (useNativeTab) {
    window.JellyfinEnhanced.nativeTabs.register('recommendations', window.JellyfinEnhanced.t('recommendations_title'), function (panel) {
      var marker = document.createElement('div');
      marker.className = 'jellyfinenhanced recommendations';
      panel.appendChild(marker);
    }, 'auto_awesome');
  }

  var style = document.createElement('style');
  style.textContent = [
    '.backgroundContainer.withBackdrop:has(~ .mainAnimatedPages #indexPage .tabContent.is-active .jellyfinenhanced.recommendations) {',
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

  /** Wait for JE.recommendationsPage to be ready before initializing (30s timeout). */
  function waitForRecommendations(callback) {
    var attempts = 0;
    var check = setInterval(function () {
      if (++attempts > 300) { clearInterval(check); return; }
      var JE = window.JE || window.JellyfinEnhanced;
      if (JE?.recommendationsPage) {
        clearInterval(check);
        callback(JE);
      }
    }, 100);
  }

  /**
   * Find the recommendations container inside the active (non-hidden) home page.
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
    var all = document.querySelectorAll('.jellyfinenhanced.recommendations');
    for (var i = all.length - 1; i >= 0; i--) {
      var el = all[i];
      // 1. Tab-hosted content: the tab's own active state is authoritative.
      //    Checked BEFORE .page because Custom Tabs injects its panels into
      //    #indexPage, which is NOT .hide while the home page is showing. A
      //    .page-first check therefore matches every tab on load and mounts
      //    content for tabs the user never opened.
      var tabContent = el.closest('.tabContent');
      if (tabContent) {
        // `is-active` is the fast path but is not authoritative on its own:
        // not every host sets it, and it can be applied without a DOM
        // mutation for the observers below to notice. An actual visibility
        // check backs it up so the panel still mounts if the class is absent
        // or lands late — a missing mount is far worse than a late one.
        if (tabContent.classList.contains('is-active') || el.offsetParent !== null) return el;
        continue;
      }
      // 2. Standard Jellyfin page structure
      var page = el.closest('.page');
      if (page && !page.classList.contains('hide')) return el;
      // 3. Last resort: element is simply visible in the document
      if (!page && el.offsetParent !== null) return el;
    }
    return null;
  }

  /**
   * Render recommendations into the given container using a scoped child element.
   * @param {HTMLElement} container - The active .jellyfinenhanced.recommendations element.
   * @param {Object} JE - The JellyfinEnhanced global object.
   */
  function renderRecommendations(container, JE) {
    container.classList.remove('hide');
    container.style.display = '';

    var child = document.createElement('div');
    child.id = 'je-recommendations-container-tab';
    container.textContent = '';
    container.appendChild(child);

    JE.recommendationsPage.renderForCustomTab?.(child);

    lastMountedContainer = container;
  }

  /**
   * Persistent watcher -- observes document.body (via shared observer) for
   * DOM rebuilds and remounts recommendations when a new active container
   * appears. Suspends checks when not on the home page.
   * @param {Object} JE - The JellyfinEnhanced global object.
   */
  function watchForContainer(JE) {
    function tryMount() {
      if (!isOnHomePage()) return;

      var container = findActiveContainer();
      if (!container) {
        lastMountedContainer = null;
        return;
      }

      var shouldMount = container !== lastMountedContainer
        || !container.hasChildNodes()
        || (lastMountedContainer && !document.contains(lastMountedContainer));

      if (shouldMount) {
        renderRecommendations(container, JE);
      }
    }

    tryMount();

    var mountPending = false;
    function scheduleMount() {
      if (mountPending) return;
      mountPending = true;
      requestAnimationFrame(function () {
        mountPending = false;
        ensureTabActivationObserver();
        tryMount();
      });
    }

    JE.helpers.createObserver('jellyseerr-recommendations-custom-tab', scheduleMount, document.body,
      { childList: true, subtree: true });

    // A tab becoming active is a class change, and the shared body observer
    // only dispatches for batches containing added/removed nodes — so an
    // activation on its own can go unseen and the panel would never mount.
    // Watch the panels' shared parent for class changes as well, scoped to
    // that subtree so this stays cheap.
    var observedTabsParent = null;
    function ensureTabActivationObserver() {
      var anyPanel = document.querySelector('.tabContent');
      var parent = anyPanel && anyPanel.parentElement;
      if (!parent || parent === observedTabsParent) return;
      observedTabsParent = parent;
      JE.helpers.createObserver('jellyseerr-recommendations-custom-tab-tab-activation', scheduleMount, parent,
        { attributes: true, attributeFilter: ['class'], subtree: true });
    }
    ensureTabActivationObserver();

    // The page module clears per-user state on a user switch, but that relies
    // on a re-render to refresh what is on screen. Content in a tab that is
    // not currently open will not get one, so drop the rendered DOM here too —
    // otherwise the previous user's content stays in the tab until it is
    // opened. Mirrors the reset in enhanced/bookmarks/bookmarks-library-render.js.
    function resetForUserChange() {
      var all = document.querySelectorAll('.jellyfinenhanced.recommendations');
      for (var i = 0; i < all.length; i++) all[i].textContent = '';
      lastMountedContainer = null;
    }
    JE.session?.onUserChange('jellyseerr-recommendations-custom-tab', resetForUserChange);
    document.addEventListener('je:user-data-loaded', function () {
      resetForUserChange();
      tryMount();
    });
  }

  waitForRecommendations(function (JE) {
    watchForContainer(JE);
  });

})();
