import tileCss from './recommendation-tiles.css';
// /js/jellyseerr/recommendations/recommendations-styles.js
// Recommendations Page: tile and category-page styles.
const TILE_STYLES = tileCss;

(function () {
    'use strict';
    if (document.getElementById('je-recommendations-tile-styles')) return;
    const style = document.createElement('style');
    style.id = 'je-recommendations-tile-styles';
    style.textContent = TILE_STYLES;
    document.head.appendChild(style);
})();
