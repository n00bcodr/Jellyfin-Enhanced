(() => {
"use strict";
(() => {
  // client/src/host/context.ts
  function featureContext(feature, core, slots) {
    const shared = core.core?.featureContext;
    if (typeof shared !== "function") {
      throw new Error(`${feature}: JE.core.featureContext is missing; core/ui-kit.js must load before feature scripts`);
    }
    return shared(feature, core, slots);
  }

  // client/src/features/catchup/host.ts
  function catchupHost() {
    const host = window, JE = host.JellyfinEnhanced;
    const ctx = JE && featureContext("catchup", JE, {
      facades: ["catchUpPage"],
      internalSlots: ["catchUp"],
      internalsObject: () => JE.internals ?? (JE.internals = {})
    });
    return { host, ctx, getApi: () => host.ApiClient, Emby: host.Emby };
  }

  // client/src/features/catchup/catchup-page.ts
  (function() {
    "use strict";
    const { ctx: context } = catchupHost();
    if (!context) return;
    const ctx = context, JE = ctx.core;
    if (!JE?.pluginConfig?.CatchUpEnabled) return;
    const runtime = ctx.own.catchUp;
    if (!runtime) return;
    const S = runtime;
    const injectStyles = S.injectStyles, deckModule = S.deck, activityModule = S.activity;
    if (!injectStyles || !deckModule || !activityModule) throw Error("Catch Up loader order violated");
    function renderPage(container) {
      const host = container || document.getElementById("je-catchup-container");
      if (!host) return;
      injectStyles();
      host.replaceChildren();
      const root = S.h("div", "je-catchup");
      const main = S.h("div", "je-catchup-main");
      root.append(main);
      host.append(root);
      const deck = deckModule.mount(root, main);
      deck.start();
      activityModule.mount(root, deck.headActions).catch((e) => console.warn(`${S.LOG} activity panel unavailable:`, e));
    }
    ctx.own.catchUpPage = { injectStyles, renderPage };
  })();
})();
})();
//# sourceMappingURL=catchup-page.js.map
