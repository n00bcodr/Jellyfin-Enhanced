/**
 * Calendar Custom Tab
 * Creates <div class="jellyfinenhanced calendar"></div> for CustomTabs plugin
 *
 * Uses a persistent observer to remount whenever the home page DOM is rebuilt
 * (e.g. after SPA navigation). Only runs when on the home page; suspends
 * when navigated away.
 */

(function () {
  'use strict';

  if (!window.JellyfinEnhanced?.pluginConfig?.CalendarPageEnabled) {
    return;
  }

  if (!window.JellyfinEnhanced?.pluginConfig?.CalendarUseCustomTabs) {
    return;
  }

  var style = document.createElement('style');
  style.textContent = [
    '.jellyfinenhanced.calendar {',
    '  padding: 12px 3vw;',
    '}',
    '.backgroundContainer.withBackdrop:has(~ .mainAnimatedPages #indexPage .tabContent.is-active .jellyfinenhanced.calendar) {',
    '  background: rgba(0, 0, 0, 0.7) !important;',
    '}'
  ].join('\n');
  document.head.appendChild(style);

  /** The last DOM node we mounted into. */
  var lastMountedContainer = null;
  var clickHandlerAttached = false;

  /** @returns {boolean} Whether the current URL hash is the home page. */
  function isOnHomePage() {
    var hash = window.location.hash;
    return hash === '' || hash === '#/home' || hash === '#/home.html'
      || hash.indexOf('#/home?') !== -1 || hash.indexOf('#/home.html?') !== -1;
  }

  /** Wait for JE.calendarPage to be ready before initializing (30s timeout). */
  function waitForCalendar(callback) {
    var attempts = 0;
    var check = setInterval(function () {
      if (++attempts > 300) { clearInterval(check); return; }
      var JE = window.JE || window.JellyfinEnhanced;
      if (JE?.calendarPage) {
        clearInterval(check);
        callback(JE);
      }
    }, 100);
  }

  /**
   * Find the calendar container inside the active (non-hidden) home page.
   * Returns null if no visible container exists -- never falls back to a
   * stale DOM-cached copy.
   * @returns {HTMLElement|null}
   */
  function findActiveContainer() {
    var all = document.querySelectorAll('.jellyfinenhanced.calendar');
    for (var i = all.length - 1; i >= 0; i--) {
      var page = all[i].closest('.page');
      if (page && !page.classList.contains('hide')) return all[i];
    }
    return null;
  }

  /**
   * Render calendar into the given container using a scoped child element.
   * @param {HTMLElement} container - The active .jellyfinenhanced.calendar element.
   * @param {Object} JE - The JellyfinEnhanced global object.
   */
  function renderCalendar(container, JE) {
    container.classList.remove('hide');
    container.style.display = '';

    var child = document.createElement('div');
    child.id = 'je-calendar-container-tab';
    container.textContent = '';
    container.appendChild(child);

    JE.calendarPage.renderForCustomTab?.(child);

    if (!clickHandlerAttached && typeof JE.calendarPage.handleEventClick === 'function') {
      document.addEventListener("click", JE.calendarPage.handleEventClick);
      clickHandlerAttached = true;
    }

    lastMountedContainer = container;
  }

  /**
   * Persistent watcher -- observes .mainAnimatedPages for DOM rebuilds and
   * remounts the calendar when a new active container appears. Suspends
   * checks when not on the home page.
   * @param {Object} JE - The JellyfinEnhanced global object.
   */
  function watchForContainer(JE) {
    function tryMount() {
      // Skip work entirely when not on the home page
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
        renderCalendar(container, JE);
      }
    }

    tryMount();

    // Observe the narrowest stable parent available
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

  waitForCalendar(function (JE) {
    watchForContainer(JE);
  });

})();
