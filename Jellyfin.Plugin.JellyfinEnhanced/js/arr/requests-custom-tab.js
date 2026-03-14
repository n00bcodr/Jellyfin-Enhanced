/**
 * Requests Custom Tab
 * Creates <div class="jellyfinenhanced requests"></div> for CustomTabs plugin
 *
 * Uses a persistent observer to remount whenever the home page DOM is rebuilt
 * (e.g. after SPA navigation). Targets the LAST matching container to avoid
 * rendering into a stale DOM-cached copy.
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
   * Find the correct (visible/active) requests container.
   * Jellyfin's DOM caching can leave multiple copies -- find the one
   * inside the active (non-hidden) page, falling back to the last one.
   */
  function findActiveContainer() {
    var all = document.querySelectorAll('.jellyfinenhanced.requests');
    if (all.length === 0) return null;
    for (var i = all.length - 1; i >= 0; i--) {
      var page = all[i].closest('.page');
      if (page && !page.classList.contains('hide')) return all[i];
    }
    return all[all.length - 1];
  }

  /** Render downloads into the given container. */
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

  /** Persistent watcher -- keeps observing so we remount after SPA navigation. */
  function watchForContainer(JE) {
    function tryMount() {
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
    observer.observe(document.body, { childList: true, subtree: true });
  }

  waitForDownloads(function (JE) {
    watchForContainer(JE);
  });

})();
