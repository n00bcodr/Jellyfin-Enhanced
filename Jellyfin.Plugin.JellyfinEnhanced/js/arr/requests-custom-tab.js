/**
 * Requests Custom Tab
 * Creates <div class="jellyfinenhanced requests"></div> for CustomTabs plugin
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

  if (!window.JellyfinEnhanced?.pluginConfig?.DownloadsUseCustomTabs) {
    return;
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
   * @returns {HTMLElement|null}
   */
  function findActiveContainer() {
    var all = document.querySelectorAll('.jellyfinenhanced.requests');
    for (var i = all.length - 1; i >= 0; i--) {
      var page = all[i].closest('.page');
      if (page && !page.classList.contains('hide')) return all[i];
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
   * Persistent watcher -- observes .mainAnimatedPages for DOM rebuilds and
   * remounts the requests tab when a new active container appears. Suspends
   * checks when not on the home page.
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
        renderDownloads(container, JE);
      }
    }

    tryMount();

    var observeTarget = document.querySelector('.mainAnimatedPages') || document.body;
    var mountPending = false;
    var observer = new MutationObserver(function () {
      if (!mountPending) {
        mountPending = true;
        requestAnimationFrame(function () {
          mountPending = false;
          tryMount();
        });
      }
    });
    observer.observe(observeTarget, { childList: true, subtree: true });
  }

  waitForDownloads(function (JE) {
    watchForContainer(JE);
  });

})();
