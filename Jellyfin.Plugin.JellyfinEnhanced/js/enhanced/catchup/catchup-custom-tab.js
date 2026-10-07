/**
 * Catch Up tab. Puts <div class="jellyfinenhanced catchup"></div> into a tab panel, either one
 * from the Custom Tabs plugin (CatchUpUseCustomTabs) or one JE makes itself
 * (CatchUpUseNativeTab, see enhanced/native-tabs.js). Both end up as a .tabContent that
 * Jellyfin toggles with .is-active, so the rest of this file treats them the same.
 *
 * It remounts whenever the home page DOM is rebuilt and does nothing on other pages.
 */

(function () {
  'use strict';

  if (!window.JellyfinEnhanced?.pluginConfig?.CatchUpEnabled) {
    return;
  }

  var useCustomTabs = !!window.JellyfinEnhanced?.pluginConfig?.CatchUpUseCustomTabs;
  var useNativeTab = !!window.JellyfinEnhanced?.pluginConfig?.CatchUpUseNativeTab;

  if (!useCustomTabs && !useNativeTab) {
    return;
  }

  if (useNativeTab) {
    window.JellyfinEnhanced.nativeTabs.register('catchup', window.JellyfinEnhanced.t('catchup_title') || 'Catch Up', function (panel) {
      var marker = document.createElement('div');
      marker.className = 'jellyfinenhanced catchup';
      panel.appendChild(marker);
    }, 'style');
  }

  var style = document.createElement('style');
  style.textContent = [
    '.backgroundContainer.withBackdrop:has(~ * #indexPage .tabContent.is-active .jellyfinenhanced.catchup) {',
    '  background: rgba(0, 0, 0, 0.7) !important;',
    '  opacity: 1 !important;',
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

  /** Waits up to 30s for JE.catchUpPage. */
  function waitForCatchUp(callback) {
    var attempts = 0;
    var check = setInterval(function () {
      if (++attempts > 300) { clearInterval(check); return; }
      var JE = window.JE || window.JellyfinEnhanced;
      if (JE?.catchUpPage) {
        clearInterval(check);
        callback(JE);
      }
    }, 100);
  }

  /**
   * Finds the catch up container in the visible home tab, or null.
   * Never returns a stale cached copy.
   *
   * @returns {HTMLElement|null}
   */
  function findActiveContainer() {
    var all = document.querySelectorAll('.jellyfinenhanced.catchup');
    for (var i = all.length - 1; i >= 0; i--) {
      var el = all[i];
      if (window.JellyfinEnhanced.helpers.isActiveTabContainer(el)) return el;
    }
    return null;
  }

  /**
   * Render the catch up page into the given container.
   * @param {HTMLElement} container - The active .jellyfinenhanced.catchup element.
   * @param {Object} JE - The JellyfinEnhanced global object.
   */
  function renderCatchUp(container, JE) {
    container.classList.remove('hide');
    container.style.display = '';

    var child = document.createElement('div');
    child.id = 'je-catchup-container-tab';
    container.textContent = '';
    container.appendChild(child);

    JE.catchUpPage.injectStyles();
    JE.catchUpPage.renderPage(child);

    lastMountedContainer = container;
  }

  /**
   * Watches for DOM rebuilds and remounts when a new active container appears.
   * Skips the work on pages other than home.
   * @param {Object} JE - The JellyfinEnhanced global object.
   */
  function watchForContainer(JE) {
    var wasOnHomePage = false;

    function tryMount() {
      var onHome = isOnHomePage();

      if (!onHome) {
        if (wasOnHomePage) {
          lastMountedContainer = null;
        }
        wasOnHomePage = false;
        return;
      }

      var justReturned = !wasOnHomePage;
      wasOnHomePage = true;

      var container = findActiveContainer();
      if (!container) {
        if (lastMountedContainer) {
        }
        lastMountedContainer = null;
        return;
      }

      var shouldMount = justReturned
        || container !== lastMountedContainer
        || !container.hasChildNodes()
        || (lastMountedContainer && !document.contains(lastMountedContainer));

      if (shouldMount) {
        renderCatchUp(container, JE);
      }
    }

    tryMount();

    window.addEventListener('hashchange', tryMount);

    JE.helpers.observeTabContainers('catchup-custom-tab', '.jellyfinenhanced.catchup', tryMount);
  }

  waitForCatchUp(function (JE) {
    watchForContainer(JE);
  });

})();
