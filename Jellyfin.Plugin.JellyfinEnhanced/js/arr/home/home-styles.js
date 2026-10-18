/**
 * @file Requests & downloads, phase 4d: styles of the home rows ("Your requests", "Coming soon for
 * you", "Just arrived for you"), their poster overlays (download ring, one-word state, date pill,
 * "New"), the administrators' ops strip and the decoration of Home Screen Sections' JE sections.
 * The rows reuse jellyfin-web's own section and card classes; this only adds what those lack.
 * Exposes JE.internals.arrHome.injectStyles (injected once, on the first draw).
 */
(function (JE) {
    'use strict';

    const R = (JE.internals = JE.internals || {}).arrHome = JE.internals.arrHome || {};
    const STYLE_ID = 'je-arr-home-styles';

    const CSS = `
.je-home-rows { display: block; }
.je-home-row { position: relative; }
.je-home-row .sectionTitleContainer { display: flex; align-items: center; }
.je-home-row .je-home-title-link { display: inline-flex; align-items: center; min-height: 44px; color: inherit; text-decoration: none; }
.je-home-row .je-home-title-link:focus-visible { outline: 2px solid #fff; outline-offset: 2px; border-radius: 4px; }
.je-home-row .je-home-scroller { overflow-x: auto; overflow-y: hidden; scrollbar-width: none; overscroll-behavior-x: contain; }
.je-home-row .je-home-scroller::-webkit-scrollbar { display: none; }
.je-home-row .je-home-items { white-space: nowrap; padding: 0 8px; }
/* Room for the focus ring and the TV focus scale at both ends, without moving the first card. */
.je-home-row .je-home-scroller { margin-left: -8px; margin-right: -8px; }
.je-home-card { border: 0; padding: 0; margin: 0; background: transparent; color: inherit; font: inherit; text-align: inherit; cursor: pointer; vertical-align: top; white-space: normal; }
.je-home-card .cardScalable { position: relative; border-radius: 0.2em; overflow: hidden; }
.je-home-card .je-home-poster { position: absolute; inset: 0; background-color: #1f1f23; overflow: hidden; }
.je-home-card .je-home-poster-img { width: 100%; height: 100%; object-fit: cover; display: block; }
.je-home-card .je-home-poster-empty { display: flex; align-items: center; justify-content: center; color: rgba(255,255,255,0.45); }
.je-home-card .je-home-poster-empty .material-icons { font-size: 3em; }
.je-home-card:focus { outline: none; }
.je-home-card:focus-visible .cardScalable { box-shadow: 0 0 0 3px #00a4dc, 0 0 0 5px #fff; }
.layout-tv .je-home-card:focus .cardScalable { box-shadow: 0 0 0 4px #00a4dc, 0 0 0 6px #fff; transform: scale(1.04); }
.je-home-card .cardText { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.je-home-overlay { position: absolute; top: 6px; right: 6px; z-index: 3; display: flex; gap: 4px; align-items: center; pointer-events: none; max-width: calc(100% - 12px); }
.je-home-overlay-top-left { right: auto; left: 6px; }
.je-home-overlay-bottom-left { top: auto; bottom: 6px; right: auto; left: 6px; }
.je-home-overlay-bottom-right { top: auto; bottom: 6px; }
.je-home-overlay-raised { bottom: 34px; }
.je-home-overlay .je-arr-badge { position: static; }
.je-home-pill { display: inline-flex; align-items: center; gap: 3px; padding: 1px 7px; border-radius: 999px; font-size: 11px; font-weight: 700; line-height: 18px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #fff; background: rgba(0,0,0,0.72); border: 1px solid rgba(255,255,255,0.25); }
.je-home-pill .material-icons { font-size: 13px; }
.je-home-pill-date { background: #4f46e5; border-color: #6366f1; }
.je-home-pill-new { background: #15803d; border-color: #22c55e; }
.layout-tv .je-home-pill { font-size: 14px; line-height: 22px; }
.je-home-scroll-btn { position: absolute; z-index: 20; display: none; align-items: center; justify-content: center; width: 44px; height: 44px; padding: 0;
  border-radius: 50%; border: 1px solid rgba(255,255,255,0.2); background: rgba(15,23,42,0.8); color: #fff; cursor: pointer; opacity: 0; transition: opacity 0.2s; }
.je-home-scroll-btn.je-home-left { left: 10px; }
.je-home-scroll-btn.je-home-right { right: 10px; }
@media (hover: hover) {
  .je-home-scroll-btn.je-home-show { display: flex; }
  .je-home-row:hover .je-home-scroll-btn.je-home-show { opacity: 1; }
}
.layout-tv .je-home-scroll-btn { display: none !important; }
.je-home-ops { padding: 0.4em max(3.3vw, env(safe-area-inset-left)) 0.2em; }
.je-home-ops-link { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; min-height: 44px; padding: 4px 14px; border-radius: 999px;
  color: #fde68a; background: rgba(245,158,11,0.12); border: 1px solid rgba(245,158,11,0.55); text-decoration: none; font-weight: 600; box-sizing: border-box; max-width: 100%; }
.je-home-ops-link:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
.je-home-ops-part { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
.je-home-ops-part .material-icons { font-size: 18px; }
.je-home-ops-sep { opacity: 0.6; }
.je-home-hss-card .cardScalable > .je-arr-badge { display: none; }
.je-home-hss-card .je-home-replaced { display: none; }
`;

    /**
     * Adds the stylesheet once (and the shared status styles the ring and pills use).
     * @returns {void}
     */
    function injectStyles() {
        JE.internals?.arrStatusStyles?.ensure?.();
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = CSS;
        document.head.appendChild(style);
    }

    R.injectStyles = injectStyles;
})(window.JellyfinEnhanced);
