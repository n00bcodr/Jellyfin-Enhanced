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

  // client/src/features/chrome/host.ts
  function chromeContext(JE2, facades) {
    return featureContext("chrome", JE2, { facades });
  }
  function chromeBridge() {
    const host = window;
    if (!host.JellyfinEnhanced) throw new Error("Jellyfin Enhanced must initialize before chrome modules");
    return host.JellyfinEnhanced;
  }

  // client/src/features/chrome/plugin-revisions.ts
  function revisionVersion(label) {
    return label?.match(/^\s*(\d+(?:\.\d+){1,3})(?=\s|—|$)/)?.[1] ?? null;
  }
  var HIDDEN_CLASS = "je-duplicate-plugin-revision";
  var ROUTE = /^#\/dashboard\/plugins\/[^/?]+/;
  function initializePluginRevisions(JE2) {
    const lifecycle = JE2.core.lifecycle.register("plugin-revisions");
    lifecycle.teardown();
    const style = document.createElement("style");
    style.textContent = `#addPluginPage .${HIDDEN_CLASS} { display: none !important; }`;
    document.head.appendChild(style);
    let frame = 0;
    let stopped = false;
    function update() {
      frame = 0;
      if (stopped) return;
      const page = document.getElementById("addPluginPage");
      if (!page) return;
      const lists = /* @__PURE__ */ new Map();
      for (const row of page.querySelectorAll(".MuiAccordion-root")) {
        const summary = row.querySelector(":scope > .MuiAccordion-heading > .MuiAccordionSummary-root");
        const version = revisionVersion(summary?.querySelector(".MuiAccordionSummary-content")?.textContent);
        if (!version) {
          row.classList.remove(HIDDEN_CLASS);
          continue;
        }
        let seen = lists.get(row.parentElement);
        if (!seen) lists.set(row.parentElement, seen = /* @__PURE__ */ new Set());
        row.classList.toggle(HIDDEN_CLASS, seen.has(version));
        seen.add(version);
      }
    }
    function schedule() {
      if (!stopped && !frame && ROUTE.test(location.hash)) frame = requestAnimationFrame(update);
    }
    lifecycle.track(JE2.core.dom.onBodyMutation("plugin-revisions", schedule));
    lifecycle.track(JE2.core.navigation.onNavigate(schedule));
    lifecycle.track(() => {
      stopped = true;
      cancelAnimationFrame(frame);
      document.querySelectorAll("." + HIDDEN_CLASS).forEach((row) => row.classList.remove(HIDDEN_CLASS));
      style.remove();
    });
    schedule();
  }

  // client/src/features/chrome/plugin-revisions-entry.ts
  var JE = chromeBridge();
  chromeContext(JE, ["initializePluginRevisions"]).own.initializePluginRevisions = () => initializePluginRevisions(JE);
})();
})();
//# sourceMappingURL=plugin-revisions.js.map
