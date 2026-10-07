/**
 * @file Catch Up entry point. Exposes JE.catchUpPage = { injectStyles, renderPage }, used by
 * PluginPages/CatchUpPage.html and the tab.
 */
(function () {
  'use strict';

  const JE = window.JellyfinEnhanced;
  if (!JE?.pluginConfig?.CatchUpEnabled) return;
  const S = JE.internals.catchUp;

  /**
   * Renders the page into `container` (default #je-catchup-container).
   * Calling it again rebuilds the page.
   * @param {HTMLElement} [container]
   */
  function renderPage(container) {
    const host = container || document.getElementById('je-catchup-container');
    if (!host) return;
    S.injectStyles();
    host.replaceChildren();

    const root = S.h('div', 'je-catchup');
    const main = S.h('div', 'je-catchup-main');
    root.append(main);
    host.append(root);

    const deck = S.deck.mount(root, main);
    S.activity.mount(root, deck.headActions).catch((e) => console.warn(`${S.LOG} activity panel unavailable:`, e));
    deck.start();
  }

  JE.catchUpPage = { injectStyles: S.injectStyles, renderPage };
})();
