// /js/jellyseerr/recommendations/recommendations-styles.js
// Recommendations Page — tile and category-page styles (split from recommendations.js).
(function () {
  "use strict";

  function injectTileStyles() {
    if (document.getElementById('je-recommendations-tile-styles')) return;
    const style = document.createElement('style');
    style.id = 'je-recommendations-tile-styles';
    style.textContent = `
      [dir="ltr"] .je-pad-left {
        padding-left: max(3.3vw, env(safe-area-inset-left)) !important;
      }
      [dir="rtl"] .je-pad-left {
        padding-right: max(3.3vw, env(safe-area-inset-right)) !important;
      }
      [dir="ltr"] .je-pad-right {
        padding-right: max(3.3vw, env(safe-area-inset-right)) !important;
      }
      [dir="rtl"] .je-pad-right {
        padding-left: max(3.3vw, env(safe-area-inset-left)) !important;
      }
      /* The items container carries the page padding (je-pad-*); once Jellyfin's
         scroller upgrades it adds its own side padding too, which pushed the
         first card ~3.3vw to the right of the section heading. */
      .je-recommendations-section .emby-scroller {
        padding-left: 0 !important;
        padding-right: 0 !important;
      }
      /* Standalone (Plugin Pages) host: Jellyfin's userPluginSettingsContainer is
         padded-left/right, and the rows add je-pad-* on top, which doubled the
         left gap. Cancel the host's padding so ours is the only one (and the
         rows can still scroll out to the viewport edge). */
      .userPluginSettingsContainer .je-recommendations-page {
        margin-left: calc(-1 * max(3.3vw, env(safe-area-inset-left)));
        margin-right: calc(-1 * max(3.3vw, env(safe-area-inset-right)));
      }
      /* The title sticks under Jellyfin's header (offset measured in
         recommendations-render.js) with the same backdrop as the category bar. */
      .je-recommendations-title {
        position: sticky;
        top: var(--je-sticky-top, 0px);
        z-index: 3;
        padding-top: 0.45em;
        padding-bottom: 0.45em;
        display: flex;
        align-items: center;
        gap: 0.6em;
        margin-bottom: 0.25em;
        font-size: 2rem;
        font-weight: 700;
        letter-spacing: -0.01em;
        color: #fff;
      }
      .je-recommendations-title .je-reco-logo {
        height: 1.3em;
        width: auto;
        flex-shrink: 0;
        filter: drop-shadow(0 2px 6px rgba(0, 0, 0, 0.4));
      }

      /* Row edge fades and hover scroll arrows */
      .je-recommendations-section {
        --je-fade: 56px;
      }
      .je-recommendations-section .emby-scroller {
        scrollbar-width: none;
      }
      .je-recommendations-section .emby-scroller::-webkit-scrollbar {
        display: none;
      }
      .je-recommendations-section .emby-scroller.je-fade-r {
        -webkit-mask-image: linear-gradient(90deg, #000 calc(100% - var(--je-fade)), transparent);
        mask-image: linear-gradient(90deg, #000 calc(100% - var(--je-fade)), transparent);
      }
      .je-recommendations-section .emby-scroller.je-fade-l {
        -webkit-mask-image: linear-gradient(90deg, transparent, #000 var(--je-fade));
        mask-image: linear-gradient(90deg, transparent, #000 var(--je-fade));
      }
      .je-recommendations-section .emby-scroller.je-fade-l.je-fade-r {
        -webkit-mask-image: linear-gradient(90deg, transparent, #000 var(--je-fade), #000 calc(100% - var(--je-fade)), transparent);
        mask-image: linear-gradient(90deg, transparent, #000 var(--je-fade), #000 calc(100% - var(--je-fade)), transparent);
      }
      .je-scroll-btn {
        position: absolute;
        z-index: 20;
        display: none;
        align-items: center;
        justify-content: center;
        width: 44px;
        height: 44px;
        padding: 0;
        border-radius: 50%;
        border: 1px solid rgba(255, 255, 255, 0.2);
        background: rgba(15, 23, 42, 0.8);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        color: #fff;
        cursor: pointer;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5);
        opacity: 0;
        transition: opacity 0.2s, background 0.2s, transform 0.2s;
      }
      .je-scroll-btn.left { left: 10px; }
      .je-scroll-btn.right { right: 10px; }
      .je-scroll-btn:hover {
        background: rgba(79, 70, 229, 0.9);
        transform: scale(1.08);
      }
      .je-msym-rounded {
        font-family: 'JE Material Symbols Rounded';
        font-weight: normal;
        font-style: normal;
        font-size: 24px;
        line-height: 1;
        letter-spacing: normal;
        text-transform: none;
        display: inline-block;
        white-space: nowrap;
        word-wrap: normal;
        direction: ltr;
        -webkit-font-feature-settings: 'liga';
        -moz-font-feature-settings: 'liga';
        font-feature-settings: 'liga';
        -webkit-font-smoothing: antialiased;
      }
      .je-scroll-btn .je-msym-rounded { font-size: 28px; }
      @media (hover: hover) {
        .je-scroll-btn.show { display: flex; }
        .je-recommendations-section:hover .je-scroll-btn.show { opacity: 1; }
      }
      .je-tile-image {
        /* Soft off-white rather than pure white, so logo tiles don't glare on dark themes */
        background: linear-gradient(145deg, #f3f5f9, #dfe4ee);
        border-radius: 12px;
        box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.07), 0 4px 14px rgba(0, 0, 0, 0.28);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0.8em;
      }
      .je-tile-logo {
        max-width: 100%;
        max-height: 100%;
        object-fit: contain;
      }
      .je-tile-fallback-text {
        color: #111;
        font-weight: 600;
        text-align: center;
      }
      .je-genre-tile-image {
        overflow: hidden;
        background: #222;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      /* Dark scrim between the backdrop and the title so the label stays
         readable on light genre colours (orange, teal) */
      .je-genre-tile-image::after {
        content: "";
        position: absolute;
        inset: 0;
        pointer-events: none;
        background:
          radial-gradient(ellipse 70% 55% at 50% 50%, rgba(0, 0, 0, 0.5) 0%, rgba(0, 0, 0, 0.22) 60%, rgba(0, 0, 0, 0) 100%),
          linear-gradient(180deg, rgba(0, 0, 0, 0) 45%, rgba(0, 0, 0, 0.3) 100%);
      }
      .je-genre-tile-backdrop {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        object-fit: cover;
        opacity: 0.35;
        mix-blend-mode: luminosity;
      }
      .je-genre-tile-title {
        position: relative;
        z-index: 1;
        color: #fff;
        font-weight: 800;
        text-align: center;
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.75), 0 2px 14px rgba(0, 0, 0, 0.6);
        padding: 0.5em;
        font-size: 2em;
        letter-spacing: 1px;
        min-width: 0;
        max-width: 100%;
        overflow-wrap: break-word;
        box-sizing: border-box;
        line-height: 1.15;
      }
      #je-recommendations-category-page > [data-role="content"],
      #je-recommendations-category-page .content-primary.je-recommendations-category-page,
      .content-primary.je-recommendations-category-page {
        overflow: visible !important;
      }
      /* --je-sticky-top is the measured height of Jellyfin's header (set in
         recommendations-category.js); 5.5em is the fallback if none is found. */
      .je-recommendations-category-header {
        position: sticky;
        top: var(--je-sticky-top, 5.5em);
        z-index: 2;
        display: flex;
        align-items: center;
        gap: 1em;
        padding: 0.8em 1.5em;
        margin-top: calc(var(--je-sticky-top, 5.5em) + 0.5em);
      }
      /* Full-width blur/tint layer behind the bar: it extends past the page's
         side padding, and the tint only shows once the bar is stuck. */
      .je-recommendations-category-header::before,
      .je-recommendations-title::before {
        content: "";
        position: absolute;
        z-index: -1;
        top: 0;
        bottom: 0;
        left: calc(-1 * var(--je-bleed-l, 0px));
        right: calc(-1 * var(--je-bleed-r, 0px));
        background-color: transparent;
        backdrop-filter: blur(16px);
        -webkit-backdrop-filter: blur(16px);
        transition: background-color 0.2s ease;
        pointer-events: none;
      }
      .je-recommendations-category-header.je-stuck::before,
      .je-recommendations-title.je-stuck::before {
        background-color: rgba(8, 14, 20, 0.82);
      }
      .je-recommendations-category-header #je-recommendations-category-back {
        flex: 0 0 auto;
      }
      .je-recommendations-category-header h1 {
        margin: 0;
      }
    `;
    document.head.appendChild(style);
  }

  injectTileStyles();
})();
