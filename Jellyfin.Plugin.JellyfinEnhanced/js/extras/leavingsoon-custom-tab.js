/**
 * Leaving Soon Custom Tab
 * Creates <div class="jellyfinenhanced leavingsoon"></div>, either inside a tab panel managed by the external
 * Custom Tabs plugin (LeavingSoonPageUseCustomTabs), or inside a panel JE creates itself via the shared
 * native-tabs registry (LeavingSoonPageUseNativeTab, see enhanced/native-tabs.js). The rest of this file doesn't
 * care which one created the wrapping panel. Same mounting pattern as activity-custom-tab.js: a persistent
 * observer remounts when the home page DOM is rebuilt, and it suspends while navigated away.
 */

(function () {
  'use strict';

  var cfg = window.JellyfinEnhanced?.pluginConfig;
  if (!cfg?.LeavingSoonPageEnabled) return;

  var useCustomTabs = !!cfg.LeavingSoonPageUseCustomTabs;
  var useNativeTab = !!cfg.LeavingSoonPageUseNativeTab;
  if (!useCustomTabs && !useNativeTab) return;

  if (useNativeTab) {
    window.JellyfinEnhanced.nativeTabs.register('leavingsoon', window.JellyfinEnhanced.t('leavingsoon_title') || 'Leaving Soon', function (panel) {
      var marker = document.createElement('div');
      marker.className = 'jellyfinenhanced leavingsoon';
      panel.appendChild(marker);
    }, 'auto_delete');
  }

  var style = document.createElement('style');
  style.textContent = [
    '.backgroundContainer.withBackdrop:has(~ * #indexPage .tabContent.is-active .jellyfinenhanced.leavingsoon) {',
    '  background: rgba(0, 0, 0, 0.7) !important;',
    '  opacity: 1 !important;',
    '}'
  ].join('\n');
  document.head.appendChild(style);

  var lastMountedContainer = null;

  function isOnHomePage() {
    var hash = window.location.hash;
    return hash === '' || hash === '#/home' || hash === '#/home.html'
      || hash.indexOf('#/home?') !== -1 || hash.indexOf('#/home.html?') !== -1;
  }

  /** Wait for JE.leavingSoonPage (30s timeout). */
  function waitForPage(callback) {
    var attempts = 0;
    var check = setInterval(function () {
      if (++attempts > 300) { clearInterval(check); return; }
      var JE = window.JE || window.JellyfinEnhanced;
      if (JE?.leavingSoonPage) { clearInterval(check); callback(JE); }
    }, 100);
  }

  /** The container inside the active (non-hidden) home page, never a stale cached copy. */
  function findActiveContainer() {
    var all = document.querySelectorAll('.jellyfinenhanced.leavingsoon');
    for (var i = all.length - 1; i >= 0; i--) {
      if (window.JellyfinEnhanced.helpers.isActiveTabContainer(all[i])) return all[i];
    }
    return null;
  }

  function render(container, JE) {
    container.classList.remove('hide');
    container.style.display = '';
    var child = document.createElement('div');
    child.id = 'je-leavingsoon-container-tab';
    container.textContent = '';
    container.appendChild(child);
    JE.leavingSoonPage.injectStyles();
    JE.leavingSoonPage.renderForCustomTab(child);
    lastMountedContainer = container;
  }

  function watchForContainer(JE) {
    var wasOnHomePage = false;

    function tryMount() {
      var onHome = isOnHomePage();
      if (!onHome) {
        if (wasOnHomePage) { JE.leavingSoonPage.stopPolling?.(); lastMountedContainer = null; }
        wasOnHomePage = false;
        return;
      }
      var justReturned = !wasOnHomePage;
      wasOnHomePage = true;

      var container = findActiveContainer();
      if (!container) {
        if (lastMountedContainer) JE.leavingSoonPage.stopPolling?.();
        lastMountedContainer = null;
        return;
      }
      var shouldMount = justReturned
        || container !== lastMountedContainer
        || !container.hasChildNodes()
        || (lastMountedContainer && !document.contains(lastMountedContainer));
      if (shouldMount) render(container, JE);
    }

    tryMount();
    window.addEventListener('hashchange', tryMount);
    JE.helpers.observeTabContainers('leavingsoon-custom-tab', '.jellyfinenhanced.leavingsoon', tryMount);
  }

  waitForPage(function (JE) { watchForContainer(JE); });
})();
