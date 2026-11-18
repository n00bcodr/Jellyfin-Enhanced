(() => {
"use strict";(()=>{var t=`
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
        /* Jellyfin defines emby-scroller lazily, so after a reload straight onto
           the standalone page nothing makes the row scrollable. */
        overflow-x: auto;
        overflow-y: hidden;
      }
      .je-recommendations-section .emby-scroller::-webkit-scrollbar {
        display: none;
      }
      /* Touch screens: Android WebView drops whole rows of posters while scrolling under a mask. */
      @media (hover: hover) {
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
      /* ---- Filters: the page's, at the end of its title bar, and the same on a category page's header.
         All | Movies | Series is one segmented control (a faint track holding the three, the chosen one a
         light chip with dark words); the Filters button (the "More from" sections' button and menu) is a
         pill of the same ground, its word beside Jellyfin's filter icon, filled like a chosen segment while
         anything in it narrows the page ("Filters: 2"). What is set is said under the bar, each with its x. */
      /* (The bar keeps the room above it that the title's own heading had, so it is not stuck until scrolled.) */
      .je-recommendations-title.je-reco-header {
        flex-wrap: wrap;
        row-gap: 0.4em;
        margin-top: 0.67em;
      }
      .je-reco-header .je-reco-heading {
        display: flex;
        align-items: center;
        gap: 0.6em;
        min-width: 0;
        margin: 0;
        font: inherit;
        letter-spacing: inherit;
      }
      .je-reco-tools,
      .je-recommendations-category-controls {
        display: flex;
        align-items: center;
        gap: 0.6em;
        flex: none;
      }
      .je-reco-tools {
        margin-inline-start: auto;
        font-size: 1rem;
        font-weight: 400;
        letter-spacing: normal;
      }
      .je-recommendations-category-controls > :empty { display: none; }
      .je-recommendations-category-header .jellyseerr-discovery-filter,
      .je-reco-tools .jellyseerr-discovery-filter {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        padding: 3px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.08);
        background: color-mix(in srgb, currentColor 8%, transparent);
      }
      .je-recommendations-category-header .jellyseerr-discovery-filter .jellyseerr-filter-btn.emby-tab-button,
      .je-reco-tools .jellyseerr-discovery-filter .jellyseerr-filter-btn.emby-tab-button {
        border-radius: 999px;
        padding: 0 0.95em;
        min-height: 34px;
        margin: 0;
      }
      /* (The one in use inverted, in the theme's own colours: its text for the ground, its page for the words.) */
      .je-recommendations-category-header .jellyseerr-filter-btn.emby-tab-button-active,
      .je-reco-tools .jellyseerr-filter-btn.emby-tab-button-active {
        background: var(--jf-palette-text-primary, #e8e8e8);
        color: var(--jf-palette-background-default, #101010);
      }
      .je-recommendations-category-header .jellyseerr-filter-btn:focus-visible,
      .je-reco-tools .jellyseerr-filter-btn:focus-visible {
        outline: none;
        box-shadow: 0 0 0 2px var(--jf-palette-primary-main, #00a4dc);
      }
      .je-reco-tools .jellyseerr-filters-btn.emby-tab-button,
      .je-recommendations-category-controls .jellyseerr-filters-btn.emby-tab-button {
        display: inline-flex;
        align-items: center;
        gap: 0.4em;
        margin: 0;
        min-height: 40px;
        padding: 0 1.05em 0 0.85em;
        border-radius: 999px;
        color: var(--jf-palette-text-primary, #fff);
        background: rgba(255, 255, 255, 0.08);
        background: color-mix(in srgb, currentColor 8%, transparent);
      }
      .je-reco-tools .jellyseerr-filters-btn.emby-tab-button:hover,
      .je-recommendations-category-controls .jellyseerr-filters-btn.emby-tab-button:hover { background: rgba(255, 255, 255, 0.14); background: color-mix(in srgb, currentColor 14%, transparent); }
      .je-reco-tools .jellyseerr-filters-btn.emby-tab-button[data-on],
      .je-recommendations-category-controls .jellyseerr-filters-btn.emby-tab-button[data-on] {
        background: var(--jf-palette-text-primary, #e8e8e8);
        color: var(--jf-palette-background-default, #101010);
      }
      /* The pill's ::after is only its press area: a theme that draws the chosen tab's bar there (JellyFlix's
         .emby-tab-button-active::after) would draw it through the words while filters are set. */
      .je-reco-tools .jellyseerr-filters-btn.emby-tab-button::after,
      .je-recommendations-category-controls .jellyseerr-filters-btn.emby-tab-button::after { background: none; }
      /* Forced colours: each an edge, the one in use (and Filters while set) in the system's highlight. */
      @media (forced-colors: active) {
        .je-reco-tools .jellyseerr-filters-btn.emby-tab-button,
        .je-recommendations-category-controls .jellyseerr-filters-btn.emby-tab-button,
        .je-reco-tools .jellyseerr-discovery-filter,
        .je-recommendations-category-header .jellyseerr-discovery-filter { border: 1px solid ButtonText; }
        .je-reco-tools .jellyseerr-filters-btn.emby-tab-button[data-on],
        .je-recommendations-category-controls .jellyseerr-filters-btn.emby-tab-button[data-on],
        .je-recommendations-category-header .jellyseerr-filter-btn.emby-tab-button-active,
        .je-reco-tools .jellyseerr-filter-btn.emby-tab-button-active { forced-color-adjust: none; background: Highlight; color: HighlightText; }
      }
      .je-reco-tools .jellyseerr-filters-btn .material-icons,
      .je-recommendations-category-controls .jellyseerr-filters-btn .material-icons { font-size: 1.2em; }
      /* (Its count is in its words: no dot.) */
      .je-reco-tools .jellyseerr-filters-btn[data-on] .material-icons::after,
      .je-recommendations-category-controls .jellyseerr-filters-btn[data-on] .material-icons::after { display: none; }
      .je-reco-tools .jellyseerr-filters-name,
      .je-recommendations-category-controls .jellyseerr-filters-name {
        position: static;
        width: auto;
        height: auto;
        overflow: visible;
        clip-path: none;
      }
      .je-reco-tools .jellyseerr-filters-btn:focus-visible,
      .je-recommendations-category-controls .jellyseerr-filters-btn:focus-visible {
        outline: none;
        box-shadow: 0 0 0 2px var(--jf-palette-primary-main, #00a4dc);
        border-radius: 999px;
      }
      /* What is set: under the page's title bar, and under a category page's header, on the gutter. */
      .je-recommendations-title + .jellyseerr-filters-set,
      .je-recommendations-category-header + .jellyseerr-filters-set {
        margin: 0.2em max(3.3vw, env(safe-area-inset-right)) 0.8em max(3.3vw, env(safe-area-inset-left));
      }
      /* Nothing matches the filters: said where the rows or the cards would be. */
      .je-reco-filters-none { padding-top: 1.5em; }
      /* On a phone the page's filters take their own row under its title; a category page's go under its
         title, the sort at the row's end, and with All | Movies | Series beside them the Filters button is its
         icon alone (its words still name it to a screen reader), with the dot while anything in it is set. */
      @media (max-width: 699px) {
        .je-reco-tools { flex: 1 1 100%; margin-inline-start: 0; }
        .je-recommendations-category-header { flex-wrap: wrap; row-gap: 0.7em; }
        .je-recommendations-category-controls {
          flex: 1 1 100%;
          margin-left: 0 !important;
        }
        .je-recommendations-category-controls > #je-recommendations-category-sort { margin-inline-start: auto; }
        .je-recommendations-category-controls:has(> #je-recommendations-category-filter:not(:empty)) .jellyseerr-filters-btn.emby-tab-button { padding: 0 0.7em; }
        .je-recommendations-category-controls:has(> #je-recommendations-category-filter:not(:empty)) .jellyseerr-discovery-filter .jellyseerr-filter-btn.emby-tab-button { padding: 0 0.75em; }
        .je-recommendations-category-controls:has(> #je-recommendations-category-filter:not(:empty)) .jellyseerr-filters-name {
          position: absolute;
          width: 1px;
          height: 1px;
          overflow: hidden;
          clip-path: inset(50%);
        }
        .je-recommendations-category-controls:has(> #je-recommendations-category-filter:not(:empty)) .jellyseerr-filters-btn[data-on] .material-icons::after { display: block; }
      }
    `;var o=t;(function(){"use strict";if(document.getElementById("je-recommendations-tile-styles"))return;let e=document.createElement("style");e.id="je-recommendations-tile-styles",e.textContent=o,document.head.appendChild(e)})();})();
})();
