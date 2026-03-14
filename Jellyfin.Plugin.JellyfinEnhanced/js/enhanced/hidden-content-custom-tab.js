/**
 * Hidden Content Custom Tab
 * Creates <div class="jellyfinenhanced hidden-content"></div> for CustomTabs plugin
 *
 * Uses a persistent observer to remount whenever the home page DOM is rebuilt
 * (e.g. after SPA navigation). Targets the LAST matching container to avoid
 * rendering into a stale DOM-cached copy.
 */

(function () {
  'use strict';

  if (!window.JellyfinEnhanced?.pluginConfig?.HiddenContentEnabled) {
    return;
  }

  if (!window.JellyfinEnhanced?.pluginConfig?.HiddenContentUseCustomTabs) {
    return;
  }

  var style = document.createElement('style');
  style.textContent = [
    '.jellyfinenhanced.hidden-content {',
    '  padding: 12px 3vw;',
    '}',
    '.backgroundContainer.withBackdrop:has(~ .mainAnimatedPages #indexPage .tabContent.is-active .jellyfinenhanced.hidden-content) {',
    '  background: rgba(0, 0, 0, 0.7) !important;',
    '}'
  ].join('\n');
  document.head.appendChild(style);

  /** The last DOM node we mounted into. */
  var lastMountedContainer = null;

  /** Wait for JE.hiddenContentPage and JE.hiddenContent to be ready before initializing. */
  function waitForHiddenContent(callback) {
    var check = setInterval(function () {
      var JE = window.JE || window.JellyfinEnhanced;
      if (JE?.hiddenContentPage && JE?.hiddenContent) {
        clearInterval(check);
        callback(JE);
      }
    }, 100);
  }

  /**
   * Find the correct (visible/active) hidden content container.
   * Jellyfin's DOM caching can leave multiple copies -- find the one
   * inside the active (non-hidden) page, falling back to the last one.
   */
  function findActiveContainer() {
    var all = document.querySelectorAll('.jellyfinenhanced.hidden-content');
    if (all.length === 0) return null;
    for (var i = all.length - 1; i >= 0; i--) {
      var page = all[i].closest('.page');
      if (page && !page.classList.contains('hide')) return all[i];
    }
    return all[all.length - 1];
  }

  /** Render hidden content into the given container. */
  function renderHiddenContent(container, JE) {
    if (!container || !JE.hiddenContentPage) return;

    container.classList.remove('hide');
    container.style.display = '';

    var child = document.createElement('div');
    child.id = 'je-hidden-content-container-tab';
    container.textContent = '';
    container.appendChild(child);

    JE.hiddenContentPage.renderForCustomTab?.(child);

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
        renderHiddenContent(container, JE);
      }
    }

    tryMount();

    var observer = new MutationObserver(function () {
      tryMount();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  waitForHiddenContent(function (JE) {
    watchForContainer(JE);
  });

})();
