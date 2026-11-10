// Jellyfin 12.4's shell around JE's standalone pages, for tests of in-app navigation to them.
// Its router has no route for a JE page and listens on window before JE loads. Chromium runs window
// listeners in the order they were added, so an in-app navigation to a JE page reaches the router too,
// and the router renders its fallback "Page not found" page after JE has shown its own page: the old
// route's page is unmounted and the new Page dispatches viewbeforeshow, pagebeforeshow, viewshow and
// pageshow from one effect. libraryMenu sets the header title from the shown page's data-title.
// Install it before loading JE's modules, as Jellyfin is there first.
export function installJellyfinRouter(h) {
  const { window, document } = h;
  const pages = document.createElement('div');
  pages.className = 'mainAnimatedPages skinBody';
  document.body.appendChild(pages);
  document.addEventListener('pageshow', event => {
    const title = event.target.getAttribute?.('data-title');
    if (title) document.title = title;
  });
  let current = null;
  function render(id, title) {
    current?.remove();
    current = document.createElement('div');
    current.id = id;
    current.className = 'page mainAnimatedPage libraryPage';
    current.setAttribute('data-title', title);
    pages.appendChild(current);
    const detail = { isRestored: false, options: {} };
    for (const type of ['viewbeforeshow', 'pagebeforeshow', 'viewshow', 'pageshow']) {
      current.dispatchEvent(new window.CustomEvent(type, { bubbles: true, cancelable: false, detail }));
    }
    return current;
  }
  render('indexPage', 'Home');
  async function settle(hash) {
    const page = hash === '#/home' ? render('indexPage', 'Home') : render('fallbackPage', 'Page not found');
    await new Promise(resolve => setImmediate(resolve));
    return page;
  }
  return {
    /** A scripted hash change inside the app: popstate and hashchange, then the router renders and JE settles. */
    async go(hash) {
      const oldURL = window.location.href;
      window.history.pushState(null, '', hash);
      window.dispatchEvent(new window.PopStateEvent('popstate', { state: null }));
      window.dispatchEvent(new window.HashChangeEvent('hashchange', { oldURL, newURL: window.location.href }));
      return settle(hash);
    },
    /** A navigation by Jellyfin's router (a link in Jellyfin's UI, Emby.Page.show): pushState only, then it renders. */
    async push(hash) {
      window.history.pushState({ usr: null, key: 'k', idx: 1 }, '', hash);
      return settle(hash);
    },
    /** What the user sees: the visible page ids and the header title. */
    seen() {
      return { visible: [...document.querySelectorAll('.mainAnimatedPage:not(.hide)')].map(page => page.id), title: document.title };
    }
  };
}
