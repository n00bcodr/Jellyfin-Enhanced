import { installOnce, onDispose, selectionLease, enqueueWrite, pendingWrites } from './host';
import { host, registry, type HiddenHost } from './host';
import hiddenContentPageCss from './hidden-content-page.css';
/**
 * @file Hidden Content Page — page CSS and its injector.
 * Split from hidden-content-page.js (code motion; CSS verbatim).
 */
(function () {
    if(!installOnce(host.JellyfinEnhanced,'hidden-content-page-styles'))return;
  "use strict";

  const JE = host.JellyfinEnhanced;
  const internal = registry(JE, 'hiddenContentPage');

  // ============================================================
  // CSS Styles
  // ============================================================

  const CSS_STYLES = hiddenContentPageCss;

  /**
   * Injects the page CSS styles into the document head.
   * No-ops if already injected.
   */
  function injectStyles() {
    if (document.getElementById("je-hidden-content-page-styles")) return;
    const style = document.createElement("style");
    style.id = "je-hidden-content-page-styles";
    style.textContent = CSS_STYLES;
    document.head.appendChild(style);
  }

  Object.assign(internal, { injectStyles });

})();
