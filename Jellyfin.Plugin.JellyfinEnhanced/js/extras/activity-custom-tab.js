/**
 * Activity Feed Custom Tab
 * Creates <div class="jellyfinenhanced activity"></div>, either inside a tab
 * panel managed by the external Custom Tabs plugin (ActivityFeedUseCustomTabs),
 * or inside a panel JE creates itself via the shared native-tabs registry
 * (ActivityFeedUseNativeTab, see enhanced/native-tabs.js) -- no external
 * plugin needed for the latter. The rest of this file doesn't care which one
 * created the wrapping panel, since both end up as a `.tabContent` with
 * `.is-active` toggled by Jellyfin's own tab-switching logic.
 *
 * Uses a persistent observer to remount whenever the home page DOM is rebuilt
 * (e.g. after SPA navigation). Only runs when on the home page; suspends
 * when navigated away.
 */

(function () {
  'use strict';

  if (!window.JellyfinEnhanced?.pluginConfig?.ActivityFeedEnabled) {
    return;
  }

  var useCustomTabs = !!window.JellyfinEnhanced?.pluginConfig?.ActivityFeedUseCustomTabs;
  var useNativeTab = !!window.JellyfinEnhanced?.pluginConfig?.ActivityFeedUseNativeTab;

  if (!useCustomTabs && !useNativeTab) {
    return;
  }

  if (useNativeTab) {
    window.JellyfinEnhanced.nativeTabs.register('activity', window.JellyfinEnhanced.t('activity_title') || 'Activity', function (panel) {
      var marker = document.createElement('div');
      marker.className = 'jellyfinenhanced activity';
      panel.appendChild(marker);
    }, 'history');
  }

  var style = document.createElement('style');
  style.textContent = [
    '.backgroundContainer.withBackdrop:has(~ .mainAnimatedPages #indexPage .tabContent.is-active .jellyfinenhanced.activity) {',
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

  /** Wait for JE.activityPage to be ready before initializing (30s timeout). */
  function waitForActivity(callback) {
    var attempts = 0;
    var check = setInterval(function () {
      if (++attempts > 300) { clearInterval(check); return; }
      var JE = window.JE || window.JellyfinEnhanced;
      if (JE?.activityPage) {
        clearInterval(check);
        callback(JE);
      }
    }, 100);
  }

  /**
   * Find the activity container inside the active (non-hidden) home page.
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
    var all = document.querySelectorAll('.jellyfinenhanced.activity');
    for (var i = all.length - 1; i >= 0; i--) {
      var el = all[i];
      var page = el.closest('.page');
      if (page && !page.classList.contains('hide')) return el;
      var tabContent = el.closest('.tabContent');
      if (tabContent && tabContent.classList.contains('is-active')) return el;
      if (!page && !tabContent && el.offsetParent !== null) return el;
    }
    return null;
  }

  /**
   * Render the activity feed into the given container.
   * @param {HTMLElement} container - The active .jellyfinenhanced.activity element.
   * @param {Object} JE - The JellyfinEnhanced global object.
   */
  function renderActivity(container, JE) {
    container.classList.remove('hide');
    container.style.display = '';

    var child = document.createElement('div');
    child.id = 'je-activity-container-tab';
    container.textContent = '';
    container.appendChild(child);

    JE.activityPage.injectStyles();
    JE.activityPage.renderForCustomTab(child);

    lastMountedContainer = container;
  }

  /**
   * Persistent watcher -- observes document.body (via shared observer) for
   * DOM rebuilds and remounts activity when a new active container appears.
   * Suspends checks when not on the home page.
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
        renderActivity(container, JE);
      }
    }

    tryMount();

    window.addEventListener('hashchange', tryMount);

    var mountPending = false;
    JE.helpers.createObserver('activity-custom-tab', function () {
      if (!mountPending) {
        mountPending = true;
        requestAnimationFrame(function () {
          mountPending = false;
          tryMount();
        });
      }
    }, document.body, { childList: true, subtree: true });
  }

  waitForActivity(function (JE) {
    watchForContainer(JE);
  });

})();
