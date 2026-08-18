// /js/jellyseerr/recommendations/recommendations-styles.js
// Recommendations Page — tile and category-page styles (split from recommendations.js).
(function () {
  "use strict";

  function injectTileStyles() {
    if (document.getElementById('je-recommendations-tile-styles')) return;
    const style = document.createElement('style');
    style.id = 'je-recommendations-tile-styles';
    style.textContent = `
      .je-tile-image {
        background: #fff;
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
        font-weight: 700;
        text-align: center;
        text-shadow: 0 1px 6px rgba(0, 0, 0, 0.6);
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
      .je-recommendations-category-header {
        position: sticky;
        top: 5.5em;
        z-index: 2;
        display: flex;
        align-items: center;
        gap: 1em;
        padding: 0.8em 1.5em;
        margin-top: 6.5em;
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
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
