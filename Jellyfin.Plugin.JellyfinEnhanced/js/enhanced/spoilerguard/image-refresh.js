(() => {
"use strict";
(() => {
  // client/src/host/context.ts
  function sharedModule(id) {
    const namespace = window.JellyfinEnhanced?.core?.sharedModules?.[id];
    if (!namespace) throw new Error(`${id} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);
    return namespace;
  }
  function sharedExport(namespace, name) {
    return namespace[name];
  }

  // client/generated-shared/stub/client/src/features/spoiler-guard/ownership.ts
  var shared = /* @__PURE__ */ sharedModule("features/spoiler-guard/ownership");
  var export0 = /* @__PURE__ */ sharedExport(shared, "own");

  // client/generated-shared/stub/client/src/features/spoiler-guard/host.ts
  var shared2 = /* @__PURE__ */ sharedModule("features/spoiler-guard/host");
  var export02 = /* @__PURE__ */ sharedExport(shared2, "spoilerHost");

  // client/src/features/spoiler-guard/image-refresh.ts
  var { JE, internal } = export02();
  var owner = export0(JE, "image-refresh", true);
  var logPrefix = "🪼 Jellyfin Enhanced [SpoilerGuard]:";
  var imagePath = /\/Items\/[a-f0-9-]+\/Images\//i;
  var cancelReload;
  internal.bustSpoilerImageUrl = function(url, cacheBuster) {
    if (typeof url !== "string" || !url || !imagePath.test(url)) return url;
    const cleaned = url.replace(/([?&])_sbcb=\d+&?/g, "$1").replace(/[?&]$/, "");
    return `${cleaned}${cleaned.includes("?") ? "&" : "?"}${cacheBuster}`;
  };
  internal.refreshSpoilerableImages = function() {
    const cacheBuster = `_sbcb=${Date.now()}`;
    const bust = (url) => internal.bustSpoilerImageUrl(url, cacheBuster);
    document.querySelectorAll('img[src*="/Items/"], img[srcset*="/Items/"]').forEach(function(img) {
      const src = img.getAttribute("src") || "";
      if (imagePath.test(src)) img.setAttribute("src", bust(src));
      const srcset = img.getAttribute("srcset");
      if (srcset && imagePath.test(srcset)) {
        img.setAttribute("srcset", srcset.replace(
          /([^\s,]+)(?=\s*[\d.]+[wx]|\s*,|\s*$)/g,
          (url) => imagePath.test(url) ? bust(url) : url
        ));
      }
    });
    document.querySelectorAll('source[srcset*="/Items/"]').forEach(function(source) {
      const srcset = source.getAttribute("srcset") || "";
      if (imagePath.test(srcset)) {
        source.setAttribute("srcset", srcset.replace(
          /([^\s,]+)(?=\s*[\d.]+[wx]|\s*,|\s*$)/g,
          (url) => imagePath.test(url) ? bust(url) : url
        ));
      }
    });
    document.querySelectorAll('[style*="/Items/"]').forEach(function(element) {
      const style = element.getAttribute("style") || "";
      if (!imagePath.test(style)) return;
      const next = style.replace(
        /url\((["']?)([^"')]+)\1\)/gi,
        (_match, quote, url) => `url(${quote}${bust(url)}${quote})`
      );
      if (next !== style) element.setAttribute("style", next);
    });
  };
  internal.scheduleFullReload = function() {
    cancelReload?.();
    cancelReload = owner.later(function() {
      cancelReload = void 0;
      try {
        location.reload();
      } catch (e) {
        console.warn(`${logPrefix} reload failed:`, e);
      }
    }, 600);
  };
})();
})();
//# sourceMappingURL=image-refresh.js.map
