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
