(() => {
"use strict";
(() => {
  // client/src/features/shared/panel-host.ts
  function panelHost() {
    const host = window;
    if (!host.JellyfinEnhanced) throw new TypeError("Jellyfin Enhanced must load before the settings panel");
    return host.JellyfinEnhanced;
  }
  function optionalApiClient() {
    const host = window;
    return host.ApiClient;
  }
  function currentUserKey() {
    return optionalApiClient()?.getCurrentUserId?.() || "";
  }

  // client/src/features/settings-panel/host.ts
  function registry(JE) {
    JE.internals = JE.internals || {};
    return JE.internals.enhancedUi = JE.internals.enhancedUi || {};
  }

  // client/src/features/shared/dom.ts
  function queryElement(root, selector) {
    const found = root.querySelector(selector);
    return found instanceof HTMLElement ? found : null;
  }
  function queryElements(root, selector) {
    return Array.from(root.querySelectorAll(selector)).filter((node) => node instanceof HTMLElement);
  }

  // client/src/features/settings-panel/panel-size.ts
  var PANEL_SIZE_PRESETS = ["default", "large", "fill"];
  var STORE_PREFIX = "JE_panelSize_";
  var MIN_WIDTH = 720;
  var MIN_HEIGHT = 480;
  var GUTTER = 24;
  var isPreset = (value) => typeof value === "string" && PANEL_SIZE_PRESETS.some((name) => name === value);
  function parseSize(raw) {
    if (!raw) return { preset: "default" };
    try {
      const value = JSON.parse(raw);
      if (value === null || typeof value !== "object") return { preset: "default" };
      const preset = Reflect.get(value, "preset");
      if (isPreset(preset)) return { preset };
      const width = Reflect.get(value, "width");
      const height = Reflect.get(value, "height");
      if (preset === "custom" && typeof width === "number" && typeof height === "number" && Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
        return { preset: "custom", width: Math.round(width), height: Math.round(height) };
      }
    } catch {
    }
    return { preset: "default" };
  }
  function sizeBounds(view) {
    const maxWidth = Math.max(0, view.width - GUTTER * 2);
    const maxHeight = Math.max(0, view.height - GUTTER * 2);
    return { minWidth: Math.min(MIN_WIDTH, maxWidth), minHeight: Math.min(MIN_HEIGHT, maxHeight), maxWidth, maxHeight };
  }
  function clampSize(width, height, view) {
    const b = sizeBounds(view);
    return {
      width: Math.round(Math.min(b.maxWidth, Math.max(b.minWidth, width))),
      height: Math.round(Math.min(b.maxHeight, Math.max(b.minHeight, height)))
    };
  }
  function resolveSize(size, view) {
    if (size.preset === "large") return clampSize(view.width * 0.9, view.height * 0.9, view);
    if (size.preset === "fill") return clampSize(Infinity, Infinity, view);
    if (size.preset === "custom") return clampSize(size.width, size.height, view);
    return clampSize(view.width, view.height, view);
  }
  var KEY_STEPS = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] };

  // client/src/features/settings-panel/ui-panel-resize.ts
  var DESKTOP_QUERY = "(min-width: 900px)";
  var KEY_STEP = 16;
  var KEY_STEP_LARGE = 64;
  var DEFAULT_STYLE = { width: "min(1040px, 94vw)", height: "min(720px, 90vh)", maxWidth: "94vw", maxHeight: "90vh", boxSizing: "" };
  var viewport = () => ({ width: window.innerWidth, height: window.innerHeight });
  var sizeBounds2 = () => sizeBounds(viewport());
  var clampSize2 = (width, height) => clampSize(width, height, viewport());
  var resolveSize2 = (size) => resolveSize(size, viewport());
  var storeKey = () => `${STORE_PREFIX}${currentUserKey()}`;
  function readSize(key) {
    let raw = null;
    try {
      raw = localStorage.getItem(key);
    } catch {
      return { preset: "default" };
    }
    return parseSize(raw);
  }
  function writeSize(size, key) {
    try {
      if (size.preset === "default") localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(size));
    } catch (err) {
      console.warn("🪼 Jellyfin Enhanced: could not save the panel size", err);
    }
  }
  function installUiPanelResize(JE) {
    const internal = registry(JE);
    const escapeHtml = (value) => JE.escapeHtml(value);
    internal.buildPanelSizeControlsHtml = function() {
      const names = { default: JE.t("common_default"), large: JE.t("panel_size_large"), fill: JE.t("aspect_ratio_fill") };
      const preset = (name) => `<button type="button" class="je-panel-size-btn" data-je-panel-size="${name}" aria-pressed="false">${escapeHtml(names[name])}</button>`;
      return `<div class="je-panel-size" role="group" aria-label="${escapeHtml(JE.t("panel_size_label"))}" hidden>` + PANEL_SIZE_PRESETS.map(preset).join("") + `<button type="button" class="je-panel-size-btn je-panel-size-reset" data-je-panel-size-reset hidden>${escapeHtml(JE.t("panel_size_reset"))}</button></div>`;
    };
    internal.buildPanelResizeHandlesHtml = function() {
      return `<div class="je-panel-edge je-panel-edge--y" data-je-resize="y" aria-hidden="true" hidden></div><button type="button" class="je-panel-grip" data-je-resize="both" aria-label="${escapeHtml(JE.t("panel_size_grip"))}" title="${escapeHtml(JE.t("panel_size_grip_hint"))}" aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight" aria-describedby="jePanelSizeStatus" hidden><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><path d="M15 5 5 15M15 9.5 9.5 15M15 13.5 13.5 15" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/></svg></button><span id="jePanelSizeStatus" class="je-panel-size-status" role="status" aria-live="polite" aria-atomic="true"></span>`;
    };
    const RESIZE_CSS = `
        #jellyfin-enhanced-panel .je-panel-size-status { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
        #jellyfin-enhanced-panel .je-panel-size { display: inline-flex; align-self: center; margin: 0 40px 0 auto; padding: 2px; gap: 2px; border-radius: 8px; background: rgba(255,255,255,0.08); }
        #jellyfin-enhanced-panel .je-panel-size[hidden] { display: none; }
        #jellyfin-enhanced-panel .je-panel-size-btn { min-height: 26px; padding: 3px 10px; border: 0; border-radius: 6px; background: transparent; color: rgba(255,255,255,0.75); font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; white-space: nowrap; }
        #jellyfin-enhanced-panel .je-panel-size-btn:hover { background: rgba(255,255,255,0.1); color: #fff; }
        #jellyfin-enhanced-panel .je-panel-size-btn[aria-pressed="true"] { background: rgba(255,255,255,0.2); color: #fff; }
        #jellyfin-enhanced-panel .je-panel-size-btn[hidden] { display: none; }
        #jellyfin-enhanced-panel .je-panel-size-reset { margin-left: 4px; border: 1px dashed rgba(255,255,255,0.35); }
        #jellyfin-enhanced-panel .je-panel-size-btn:focus-visible, #jellyfin-enhanced-panel .je-panel-grip:focus-visible { outline: 2px solid #fff; outline-offset: 1px; }
        #jellyfin-enhanced-panel .je-panel-edge { position: absolute; z-index: 5; touch-action: none; }
        #jellyfin-enhanced-panel .je-panel-edge--y { left: 0; right: 24px; bottom: 0; height: 5px; cursor: ns-resize; }
        #jellyfin-enhanced-panel .je-panel-grip { position: absolute; z-index: 6; right: 4px; bottom: 4px; width: 16px; height: 16px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: rgba(255,255,255,0.55); cursor: nwse-resize; touch-action: none; display: flex; }
        #jellyfin-enhanced-panel .je-panel-grip:hover, #jellyfin-enhanced-panel.je-panel-resizing .je-panel-grip { color: #fff; }
        #jellyfin-enhanced-panel :is(.je-panel-edge, .je-panel-grip)[hidden] { display: none; }
        #jellyfin-enhanced-panel.je-panel-resizing, #jellyfin-enhanced-panel.je-panel-resizing * { user-select: none; -webkit-user-select: none; }
        #jellyfin-enhanced-panel.je-panel-resizing[data-je-resize-axis="both"] * { cursor: nwse-resize !important; }
        #jellyfin-enhanced-panel.je-panel-resizing[data-je-resize-axis="y"] * { cursor: ns-resize !important; }
    `;
    internal.wirePanelResize = function(ctx) {
      const { help } = ctx;
      const controls = queryElement(help, ".je-panel-size");
      const reset = queryElement(help, "[data-je-panel-size-reset]");
      const presetButtons = queryElements(help, "[data-je-panel-size]");
      const handles = queryElements(help, "[data-je-resize]");
      if (!controls && !handles.length) return;
      JE.core.ui?.injectCss?.("je-panel-resize", RESIZE_CSS);
      const desktop = window.matchMedia(DESKTOP_QUERY);
      const key = storeKey();
      let closed = false;
      let size = readSize(key);
      const identityChanged = () => {
        if (!closed) ctx.closePanel();
      };
      const sameIdentity = () => {
        if (closed) return false;
        if (storeKey() === key) return true;
        identityChanged();
        return false;
      };
      document.addEventListener("je:user-changed", identityChanged);
      let drag = null;
      const status = help.querySelector("#jePanelSizeStatus");
      let announcementTimer = null;
      let pendingAnnouncement = "";
      const announce = (box, maximum = false, coalesce = false) => {
        pendingAnnouncement = JE.t("panel_size_status", { width: String(Math.round(box.width)), height: String(Math.round(box.height)) }) + (maximum ? `. ${JE.t("panel_size_maximum")}` : "");
        const publish = () => {
          announcementTimer = null;
          if (status) status.textContent = pendingAnnouncement;
        };
        if (coalesce) {
          if (!announcementTimer) announcementTimer = setTimeout(publish, 250);
        } else {
          if (announcementTimer) clearTimeout(announcementTimer);
          publish();
        }
      };
      const isMoved = () => help.style.transform === "none";
      const keepInView = (width, height) => {
        if (!isMoved()) return;
        const rect = help.getBoundingClientRect();
        const left = Math.max(GUTTER, Math.min(rect.left, window.innerWidth - GUTTER - width));
        const top = Math.max(GUTTER, Math.min(rect.top, window.innerHeight - GUTTER - height));
        help.style.left = `${Math.round(left)}px`;
        help.style.top = `${Math.round(top)}px`;
      };
      const setBox = (box) => {
        Object.assign(help.style, {
          // The measured box includes the border, so the set size must too,
          // or every stored or keyed size would drift by the border width.
          boxSizing: "border-box",
          width: `${box.width}px`,
          height: `${box.height}px`,
          maxWidth: `calc(100vw - ${GUTTER * 2}px)`,
          maxHeight: `calc(100vh - ${GUTTER * 2}px)`
        });
        keepInView(box.width, box.height);
      };
      const syncControls = () => {
        presetButtons.forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.jePanelSize === size.preset)));
        if (reset) reset.hidden = size.preset !== "custom";
      };
      const apply = () => {
        const wide = desktop.matches;
        if (controls) controls.hidden = !wide;
        handles.forEach((handle) => {
          handle.hidden = !wide;
        });
        if (!wide || size.preset === "default") {
          Object.assign(help.style, DEFAULT_STYLE);
          if (!wide) Object.assign(help.style, { top: "50%", left: "50%", transform: "translate(-50%, -50%)" });
          if (wide) {
            const rect = help.getBoundingClientRect();
            keepInView(rect.width, rect.height);
          }
        } else {
          setBox(resolveSize2(size));
        }
        syncControls();
        announce(help.getBoundingClientRect());
      };
      const choose = (next) => {
        if (!sameIdentity()) return;
        size = next;
        writeSize(size, key);
        apply();
        ctx.resetAutoCloseTimer();
      };
      presetButtons.forEach((button) => {
        button.addEventListener("click", () => {
          const preset = button.dataset.jePanelSize;
          if (!isPreset(preset)) return;
          if (isMoved()) Object.assign(help.style, { top: "50%", left: "50%", transform: "translate(-50%, -50%)" });
          choose({ preset });
        });
      });
      reset?.addEventListener("click", () => {
        choose({ preset: "default" });
        presetButtons.find((b) => b.dataset.jePanelSize === "default")?.focus();
      });
      const endDrag = (save = true) => {
        if (!drag) return;
        const { moved, handle, pointerId } = drag;
        drag = null;
        try {
          if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
        } catch {
        }
        help.classList.remove("je-panel-resizing");
        help.removeAttribute("data-je-resize-axis");
        if (moved && save) {
          const rect = help.getBoundingClientRect();
          choose({ preset: "custom", width: Math.round(rect.width), height: Math.round(rect.height) });
        }
      };
      handles.forEach((handle) => {
        handle.addEventListener("pointerdown", (e) => {
          if (!sameIdentity() || drag || e.button !== 0 || !desktop.matches) return;
          e.preventDefault();
          e.stopPropagation();
          const rect = help.getBoundingClientRect();
          drag = {
            handle,
            pointerId: e.pointerId,
            axis: handle.dataset.jeResize || "both",
            x: e.clientX,
            y: e.clientY,
            width: rect.width,
            height: rect.height,
            // A centred panel grows on both sides, so the edge follows the
            // pointer at twice the pointer's distance.
            centred: !isMoved(),
            left: rect.left,
            moved: false
          };
          try {
            handle.setPointerCapture?.(e.pointerId);
          } catch {
          }
          help.classList.add("je-panel-resizing");
          help.dataset.jeResizeAxis = drag.axis;
          ctx.resetAutoCloseTimer();
        });
        handle.addEventListener("pointermove", (e) => {
          if (!sameIdentity() || !desktop.matches || !drag || e.pointerId !== drag.pointerId) return;
          const factor = drag.centred ? 2 : 1;
          let width = drag.axis === "y" ? drag.width : drag.width + (e.clientX - drag.x) * factor;
          const height = drag.axis === "x" ? drag.height : drag.height + (e.clientY - drag.y) * factor;
          if (!drag.centred) width = Math.min(width, window.innerWidth - GUTTER - drag.left);
          drag.moved = true;
          const box = clampSize2(width, height);
          setBox(box);
          announce(box, width > box.width || height > box.height, true);
        });
        const endOwnedDrag = (e) => {
          if (drag && e.pointerId === drag.pointerId) endDrag();
        };
        handle.addEventListener("pointerup", endOwnedDrag);
        handle.addEventListener("pointercancel", endOwnedDrag);
        handle.addEventListener("lostpointercapture", endOwnedDrag);
      });
      const grip = handles.find((handle) => handle.dataset.jeResize === "both");
      grip?.addEventListener("keydown", (e) => {
        const steps = Object.prototype.hasOwnProperty.call(KEY_STEPS, e.key) ? KEY_STEPS[e.key] : void 0;
        if (!sameIdentity() || !steps || !desktop.matches || e.altKey || e.ctrlKey || e.metaKey) return;
        e.preventDefault();
        e.stopPropagation();
        const step = e.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
        const rect = help.getBoundingClientRect();
        const box = clampSize2(rect.width + steps[0] * step, rect.height + steps[1] * step);
        choose({ preset: "custom", width: box.width, height: box.height });
        const bounds = sizeBounds2();
        announce(box, steps[0] > 0 && box.width === bounds.maxWidth || steps[1] > 0 && box.height === bounds.maxHeight);
      });
      const blockSelection = (e) => {
        if (drag) e.preventDefault();
      };
      document.addEventListener("selectstart", blockSelection);
      const handleWindowResize = () => {
        endDrag(false);
        apply();
      };
      window.addEventListener("resize", handleWindowResize);
      desktop.addEventListener("change", handleWindowResize);
      ctx.onClose(() => {
        closed = true;
        if (announcementTimer) clearTimeout(announcementTimer);
        document.removeEventListener("je:user-changed", identityChanged);
        document.removeEventListener("selectstart", blockSelection);
        window.removeEventListener("resize", handleWindowResize);
        desktop.removeEventListener("change", handleWindowResize);
        endDrag(false);
      });
      apply();
    };
  }
  installUiPanelResize(panelHost());
})();
})();
//# sourceMappingURL=ui-panel-resize.js.map
