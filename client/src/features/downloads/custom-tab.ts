import type { Dependencies } from "./types";
import { record } from "./validation";
import { runtime } from './runtime';
export function install(deps: Dependencies) {
  const {JE, P, host, ctx, getApi} = deps;
  const life = runtime(deps);
  if(life.installed.has('custom-tab'))return;
  life.installed.add('custom-tab');

  

  if (!JE?.pluginConfig?.DownloadsPageEnabled) {
    return;
  }

  var useCustomTabs = !!JE?.pluginConfig?.DownloadsUseCustomTabs;
  var useNativeTab = !!JE?.pluginConfig?.DownloadsUseNativeTab;

  if (!useCustomTabs && !useNativeTab) {
    return;
  }

  if (useNativeTab) {
    JE.nativeTabs.register('requests', JE.t('requests_requests') || 'Requests', function (panel) {
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
    '.backgroundContainer.withBackdrop:has(~ * #indexPage .tabContent.is-active .jellyfinenhanced.requests) {',
    '  background: rgba(0, 0, 0, 0.7) !important;',
    '  opacity: 1 !important;',
    '}'
  ].join('\n');
  document.head.appendChild(style);

  /** The last DOM node we mounted into. */
  var lastMountedContainer: HTMLElement|null = null;

  /** @returns {boolean} Whether the current URL hash is the home page. */
  function isOnHomePage() {
    var hash = window.location.hash;
    return hash === '' || hash === '#/home' || hash === '#/home.html'
      || hash.indexOf('#/home?') !== -1 || hash.indexOf('#/home.html?') !== -1;
  }

  /** Wait for JE.downloadsPage to be ready before initializing (30s timeout). */
  function waitForDownloads(callback: () => void) {
    var attempts = 0;
    var check = setInterval(function () {
      if (++attempts > 300) { clearInterval(check); return; }
      
      if (ctx.own.downloadsPage) {
        clearInterval(check);
        callback();
      }
    }, 100);
    life.cleanup(()=>clearInterval(check));
  }

  /**
   * Find the requests container inside the active (non-hidden) home page.
   * Returns null if no visible container exists -- never falls back to a
   * stale DOM-cached copy.
   *
   * Requires both the page and its enclosing tab to be active.
   *
   * @returns {HTMLElement|null}
   */
  function findActiveContainer() {
    var all = document.querySelectorAll<HTMLElement>('.jellyfinenhanced.requests');
    for (var i = all.length - 1; i >= 0; i--) {
      var el = all[i];
      if (el && JE.helpers.isActiveTabContainer(el)) return el;
    }
    return null;
  }

  /**
   * Render downloads into the given container using a scoped child element.
   * @param {HTMLElement} container - The active .jellyfinenhanced.requests element.
   * @param {Object} JE - The JellyfinEnhanced global object.
   */
  function renderDownloads(container: HTMLElement) {
    container.classList.remove('hide');
    container.style.display = '';

    var child = document.createElement('div');
    child.id = 'je-downloads-container-tab';
    container.textContent = '';
    container.appendChild(child);

    ctx.own.downloadsPage.renderForCustomTab?.(child);

    lastMountedContainer = container;
  }

  /**
   * Persistent watcher -- observes document.body (via shared observer) for
   * DOM rebuilds and remounts the requests tab when a new active container
   * appears. Suspends checks when not on the home page.
   * @param {Object} JE - The JellyfinEnhanced global object.
   */
  function watchForContainer() {
    /** Whether we were on the home page on the last check. */
    var wasOnHomePage = false;

    function tryMount() {
      var onHome = isOnHomePage();

      // Navigated away — stop polling and clear custom tab mode so the
      // timer's own visibility guard doesn't keep it alive.
      if (!onHome) {
        if (wasOnHomePage) {
          ctx.own.downloadsPage.stopPolling?.();
          if (ctx.own.downloadsPage._state) {
            ctx.own.downloadsPage._state._customTabMode = false;
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
          ctx.own.downloadsPage.stopPolling?.();
          if (ctx.own.downloadsPage._state) {
            ctx.own.downloadsPage._state._customTabMode = false;
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
        renderDownloads(container);
      }
    }

    tryMount();

    // Also react immediately to hash changes so polling stops as soon as the
    // user navigates away, without waiting for a DOM mutation to fire.
    life.listen(window,'hashchange', tryMount);

    // Observe document.body (not .mainAnimatedPages) because Jellyfin replaces
    // .mainAnimatedPages when navigating to the admin dashboard — an observer
    // bound to the old element would become orphaned after returning to home
    // (issue 536). Routes to the shared multiplexed body observer.
    const unsubscribe=JE.helpers.observeTabContainers('arr-requests-custom-tab', '.jellyfinenhanced.requests', tryMount);
    if(typeof unsubscribe==='function')life.cleanup(()=>unsubscribe());
    else if(record(unsubscribe) && typeof unsubscribe.teardown==='function'){const teardown=unsubscribe.teardown;life.cleanup(()=>teardown.call(unsubscribe));}
  }

  waitForDownloads(function () {
    watchForContainer();
  });


}
