(() => {
"use strict";
(() => {
  // client/src/core/ui/tap-tracker.ts
  function createTapTracker(element, onTap, host) {
    const TAP_MOVE_THRESHOLD_PX = 10;
    const SCROLL_QUIET_WINDOW_MS = 100;
    let trackedTouchId = null;
    let startX = 0;
    let startY = 0;
    let moved = false;
    let stoppedFling = false;
    const exceedsThreshold = (touch) => Math.abs(touch.clientX - startX) > TAP_MOVE_THRESHOLD_PX || Math.abs(touch.clientY - startY) > TAP_MOVE_THRESHOLD_PX;
    return {
      start(e) {
        if (trackedTouchId !== null || e.targetTouches.length > 1) {
          trackedTouchId = null;
          return;
        }
        const touch = Array.from(e.changedTouches).find((t) => host.contains(element, t.target)) || e.changedTouches[0];
        if (!touch) return;
        trackedTouchId = touch.identifier;
        moved = false;
        stoppedFling = host.scrolledRecentlyWithin(element, SCROLL_QUIET_WINDOW_MS);
        startX = touch.clientX;
        startY = touch.clientY;
      },
      move(e) {
        if (moved || trackedTouchId === null) return;
        const touch = Array.from(e.touches).find((t) => t.identifier === trackedTouchId);
        if (touch && exceedsThreshold(touch)) {
          moved = true;
        }
      },
      // System gestures (e.g. iOS edge swipes) cancel the touch without a touchend.
      cancel() {
        trackedTouchId = null;
      },
      end(e) {
        const touch = Array.from(e.changedTouches).find((t) => t.identifier === trackedTouchId);
        if (!touch) return;
        trackedTouchId = null;
        if (moved || stoppedFling || e.targetTouches.length > 0 || exceedsThreshold(touch)) {
          e.preventDefault();
          return;
        }
        onTap(e);
      }
    };
  }

  // client/src/core/ui/runtime.ts
  function createUi(host) {
    const document2 = host.document;
    function escapeHtml(str) {
      const s = typeof str === "string" ? str : String(str ?? "");
      return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
    }
    function injectCss(id, css) {
      const existing = document2.getElementById(id);
      if (existing) {
        existing.remove();
      }
      const style = document2.createElement("style");
      style.id = id;
      style.textContent = css;
      document2.head.appendChild(style);
    }
    function removeCss(id) {
      const existing = document2.getElementById(id);
      if (existing) {
        existing.remove();
        host.log(`Removed CSS: ${id}`);
        return true;
      }
      return false;
    }
    function toast(html, duration) {
      const configured = host.toastDuration();
      if (configured === 0) return;
      const ms = duration ?? configured ?? 1500;
      const themeVars = host.themeVariables();
      const toastBg = themeVars.secondaryBg || "linear-gradient(135deg, rgba(0,0,0,0.9), rgba(40,40,40,0.9))";
      const toastBorder = `1px solid ${themeVars.primaryAccent || "rgba(255,255,255,0.1)"}`;
      const blurValue = themeVars.blur || "30px";
      const t = document2.createElement("div");
      t.className = "jellyfin-enhanced-toast";
      Object.assign(t.style, {
        position: "fixed",
        bottom: "20px",
        right: "20px",
        transform: "translateX(100%)",
        background: toastBg,
        color: "#fff",
        padding: "10px 14px",
        borderRadius: "8px",
        zIndex: 99999,
        fontSize: "clamp(13px, 2vw, 16px)",
        textShadow: "-1px -1px 10px black",
        fontWeight: "500",
        boxShadow: "0 4px 20px rgba(0,0,0,0.3)",
        backdropFilter: `blur(${blurValue})`,
        border: toastBorder,
        transition: "transform 0.3s ease-out",
        maxWidth: "clamp(280px, 80vw, 350px)"
      });
      t.innerHTML = html;
      document2.body.appendChild(t);
      host.setTimeout(() => t.style.transform = "translateX(0)", 10);
      host.setTimeout(() => {
        t.style.transform = "translateX(100%)";
        host.setTimeout(() => t.remove(), 300);
      }, ms);
    }
    let lastScrollTs = 0;
    let lastScrollTarget = null;
    document2.addEventListener("scroll", (event) => {
      lastScrollTs = host.now();
      lastScrollTarget = event.target;
    }, { capture: true, passive: true });
    const tapHost = {
      contains: host.contains,
      scrolledRecentlyWithin: (element, quietWindow) => host.now() - lastScrollTs < quietWindow && host.contains(lastScrollTarget, element)
    };
    function addTouchTapListener(element, onTap) {
      const tracker = createTapTracker(element, onTap, tapHost);
      element.addEventListener("touchstart", tracker.start, { passive: true });
      element.addEventListener("touchmove", tracker.move, { passive: true });
      element.addEventListener("touchcancel", tracker.cancel, { passive: true });
      element.addEventListener("touchend", tracker.end, { passive: false });
    }
    function addDelegatedTouchTapListener(root, resolveElement, onTap) {
      const trackers = /* @__PURE__ */ new WeakMap();
      const trackerFor = (e, create) => {
        const target = e.target;
        const element = host.isElement(target) ? resolveElement(target) : null;
        if (!element) return null;
        let tracker = trackers.get(element);
        if (!tracker && create) {
          tracker = createTapTracker(element, (event) => onTap(event, element), tapHost);
          trackers.set(element, tracker);
        }
        return tracker || null;
      };
      root.addEventListener("touchstart", (e) => {
        trackerFor(e, true)?.start(e);
      }, { passive: true });
      root.addEventListener("touchmove", (e) => {
        trackerFor(e, false)?.move(e);
      }, { passive: true });
      root.addEventListener("touchcancel", (e) => {
        trackerFor(e, false)?.cancel();
      }, { passive: true });
      root.addEventListener("touchend", (e) => {
        trackerFor(e, false)?.end(e);
      }, { passive: false });
    }
    function isTvLayout() {
      return document2.documentElement.classList.contains("layout-tv");
    }
    function ensureSkeletonCss() {
      if (document2.getElementById("je-skeleton-css")) return;
      injectCss("je-skeleton-css", `
            .je-skeleton-row { overflow: hidden; }
            .je-skeleton-bar { width: 12em; height: 1.4em; border-radius: 6px; margin-bottom: 0.5em; }
            .je-skeleton-cards { display: flex; padding-top: 0.95em; }
            .je-skeleton-cards > .card { flex: 0 0 auto; }
            .je-skeleton-card { border-radius: 8px; }
            .je-skeleton-text { height: 1.2em; width: 70%; margin: 0.4em auto 0; border-radius: 4px; }
            .je-skeleton-grid { display: grid; gap: 1em; grid-template-columns: repeat(auto-fill, minmax(var(--je-skeleton-min, 340px), 1fr)); }
            .je-skeleton-block { height: var(--je-skeleton-height, 7em); border-radius: 6px; }
            .je-skeleton-bar, .je-skeleton-card, .je-skeleton-text, .je-skeleton-block {
                background: linear-gradient(90deg, rgba(255,255,255,0.06) 25%, rgba(255,255,255,0.14) 50%, rgba(255,255,255,0.06) 75%);
                background-size: 200% 100%;
                animation: je-skeleton-shimmer 1.4s ease-in-out infinite;
            }
            @keyframes je-skeleton-shimmer {
                from { background-position: 200% 0; }
                to { background-position: -200% 0; }
            }
            @media (prefers-reduced-motion: reduce) {
                .je-skeleton-bar, .je-skeleton-card, .je-skeleton-text, .je-skeleton-block { animation: none; }
            }
        `);
    }
    function createSkeletonRows(titles, cards = 10) {
      ensureSkeletonCss();
      const el = document2.createElement("div");
      el.setAttribute("role", "status");
      const card = '<div class="card overflowPortraitCard"><div class="cardBox cardBox-bottompadded"><div class="cardScalable"><div class="cardPadder cardPadder-overflowPortrait je-skeleton-card"></div></div><div class="je-skeleton-text"></div><div class="je-skeleton-text" style="width:45%"></div></div></div>';
      el.innerHTML = titles.map(
        (title) => '<div class="verticalSection je-skeleton-row">' + (title ? `<h2 class="sectionTitle sectionTitle-cards">${escapeHtml(title)}</h2>` : '<div class="je-skeleton-bar"></div>') + '<div class="je-skeleton-cards">' + card.repeat(cards) + "</div></div>"
      ).join("");
      return el;
    }
    function skeletonGridHtml(count, opts = {}) {
      ensureSkeletonCss();
      const { minWidth = "340px", height = "7em", label = "" } = opts;
      return `<div class="je-skeleton-grid" role="status" aria-label="${escapeHtml(label)}" style="--je-skeleton-min:${minWidth};--je-skeleton-height:${height}">` + '<div class="je-skeleton-block"></div>'.repeat(count) + "</div>";
    }
    return {
      escapeHtml,
      toast,
      injectCss,
      removeCss,
      createSkeletonRows,
      skeletonGridHtml,
      addTouchTapListener,
      addDelegatedTouchTapListener,
      isTvLayout
    };
  }

  // client/src/host/context.ts
  function createFeatureContext(feature, core2, slots) {
    const own = {};
    const bind = (keys, target) => {
      for (const key of keys) {
        Object.defineProperty(own, key, {
          enumerable: true,
          get: () => target()[key],
          set: (value) => {
            target()[key] = value;
          }
        });
      }
    };
    bind(slots.facades ?? [], () => core2);
    const internalsObject = slots.internalsObject;
    if (slots.internalSlots?.length) {
      if (!internalsObject) throw new Error(`${feature}: internal slots need the host's internalsObject accessor`);
      bind(slots.internalSlots, internalsObject);
    }
    return {
      feature,
      core: core2,
      own,
      peer: (name) => core2[name]
    };
  }
  function publishFeatureContext(core2) {
    if (typeof core2.featureContext === "function") return;
    Object.defineProperty(core2, "featureContext", { value: createFeatureContext, configurable: true, writable: true, enumerable: false });
  }

  // client/src/host/ui-host.ts
  function uiBridge() {
    const host = window;
    if (!host.JellyfinEnhanced) throw new Error("Jellyfin Enhanced must be initialized before UI core");
    return host.JellyfinEnhanced;
  }
  function browserUiHost(bridge2) {
    return {
      document,
      now: () => Date.now(),
      setTimeout: (callback, delay) => window.setTimeout(callback, delay),
      toastDuration: () => bridge2.CONFIG?.TOAST_DURATION,
      themeVariables: () => bridge2.themer?.getThemeVariables() ?? {},
      contains: (parent, child) => parent instanceof Node && child instanceof Node && parent.contains(child),
      isElement: (target) => target instanceof Element,
      log: (message) => console.log(`🪼 Jellyfin Enhanced: ${message}`)
    };
  }

  // client/src/core/ui/entry.ts
  var bridge = uiBridge();
  var core = bridge.core ?? (bridge.core = {});
  publishFeatureContext(core);
  var ui = core.ui ?? (core.ui = createUi(browserUiHost(bridge)));
  bridge.escapeHtml = ui.escapeHtml;
  bridge.toast = ui.toast;
})();
})();
//# sourceMappingURL=ui-kit.js.map
