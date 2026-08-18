// /js/jellyseerr/recommendations/recommendations-render.js
// Recommendations Page — media rows, studio/network tile rows and the
// content renderer shared by the standalone page and the custom tab
// (split from recommendations.js).
(function () {
  "use strict";

  const JE = window.JellyfinEnhanced;
  JE.internals = JE.internals || {};
  const P = (JE.internals.recommendationsPage = JE.internals.recommendationsPage || {});

  const logPrefix = '🪼 Jellyfin Enhanced: Recommendations:';
  const state = P.state;
  const fetchLogoPath = P.fetchLogoPath;
  const fetchAllRows = P.fetchAllRows;
  const fetchGenreSlider = P.fetchGenreSlider;
  const escapeHtml = JE.escapeHtml;

  // recommendations-category.js loads after this module — resolve at call time.
  const showCategoryPage = (categoryKey) => P.showCategoryPage(categoryKey);

  /**
   * Builds a horizontal media row section, mirroring the layout used for the
   * Jellyseerr search-results row (see jellyseerr/ui/ui-results.js
   * createJellyseerrSection).
   * @param {string} title - Section heading text.
   * @param {Array} results - Array of Seerr search-result-shaped items.
   * @param {string} [viewAllKey] - Category key for a "View All" link, if any.
   * @returns {HTMLElement}
   */
  function createMediaRow(title, results, viewAllKey) {
    const section = document.createElement('div');
    section.className = 'verticalSection emby-scroller-container je-recommendations-section';

    if (viewAllKey) {
      const headingLink = document.createElement('a');
      headingLink.setAttribute('is', 'emby-linkbutton');
      // href is intentionally "#", not a real path: emby-linkbutton performs
      // its own internal SPA navigation using the href directly, independent
      // of preventDefault() in our click handler below - a real path here
      // (e.g. "#/recommendations?category=...") gets navigated to for real
      // and 404s against jellyfin-web's React router. Same "#" placeholder
      // pattern the Seerr UI already uses for its own JS-only-handled card links.
      headingLink.href = '#';
      headingLink.className = 'more button-flat button-flat-mini sectionTitleTextButton emby-button padded-left padded-right';

      const heading = document.createElement('h2');
      heading.className = 'sectionTitle sectionTitle-cards';
      heading.textContent = title;
      headingLink.appendChild(heading);

      const chevron = document.createElement('span');
      chevron.className = 'material-icons chevron_right';
      chevron.setAttribute('aria-hidden', 'true');
      headingLink.appendChild(chevron);

      headingLink.addEventListener('click', (e) => {
        e.preventDefault();
        showCategoryPage(viewAllKey);
      });

      section.appendChild(headingLink);
    } else {
      const heading = document.createElement('h2');
      heading.className = 'sectionTitle sectionTitle-cards focuscontainer-x padded-left padded-right';
      heading.textContent = title;
      section.appendChild(heading);
    }

    const scrollerContainer = document.createElement('div');
    scrollerContainer.setAttribute('is', 'emby-scroller');
    scrollerContainer.className = 'padded-top-focusscale padded-bottom-focusscale emby-scroller';
    scrollerContainer.dataset.horizontal = "true";
    scrollerContainer.dataset.centerfocus = "card";

    const itemsContainer = document.createElement('div');
    itemsContainer.setAttribute('is', 'emby-itemscontainer');
    itemsContainer.className = 'focuscontainer-x itemsContainer scrollSlider';

    itemsContainer.appendChild(JE.discoveryFilter.createCardsFragment(results, { cardClass: 'overflowPortraitCard' }));

    scrollerContainer.appendChild(itemsContainer);
    section.appendChild(scrollerContainer);
    return section;
  }

  /**
   * Builds a horizontal row of studio/network tiles that link into the
   * category page for that studio or network. Renders the real TMDB logo
   * when available (matching Seerr's own Studios/Networks rows), falling
   * back to a plain text tile if the logo can't be resolved (e.g. TMDB not
   * configured).
   * @param {string} title
   * @param {Array<{name: string, id: number}>} items
   * @param {'studio'|'network'} kind
   * @returns {HTMLElement}
   */
  function createTileRow(title, items, kind) {
    const section = document.createElement('div');
    section.className = 'verticalSection emby-scroller-container je-recommendations-section';

    const heading = document.createElement('h2');
    heading.className = 'sectionTitle sectionTitle-cards focuscontainer-x padded-left padded-right';
    heading.textContent = title;
    section.appendChild(heading);

    const scrollerContainer = document.createElement('div');
    scrollerContainer.setAttribute('is', 'emby-scroller');
    scrollerContainer.className = 'padded-top-focusscale padded-bottom-focusscale emby-scroller';
    scrollerContainer.dataset.horizontal = "true";
    scrollerContainer.dataset.centerfocus = "card";

    const itemsContainer = document.createElement('div');
    itemsContainer.setAttribute('is', 'emby-itemscontainer');
    itemsContainer.className = 'focuscontainer-x itemsContainer scrollSlider';

    items.forEach(item => {
      const tile = document.createElement('div');
      tile.className = 'card overflowBackdropCard card-hoverable card-withuserdata je-recommendations-tile';
      tile.innerHTML = `
        <div class="cardBox cardBox-bottompadded">
          <div class="cardScalable">
            <div class="cardPadder cardPadder-overflowBackdrop"></div>
            <div class="cardImageContainer cardContent je-tile-image">
              <span class="je-tile-fallback-text">${item.name}</span>
            </div>
            <div class="cardOverlayContainer" data-action="link"></div>
          </div>
        </div>`;

      // Mirrors createJellyseerrCard's click wiring exactly: the overlay is
      // disabled (pointer-events:none, no data-action) so Jellyfin's own
      // emby-itemscontainer click delegation leaves it alone, and the actual
      // click handler lives on the image layer underneath instead.
      const overlayContainer = tile.querySelector('.cardOverlayContainer');
      overlayContainer.removeAttribute('data-action');
      overlayContainer.style.pointerEvents = 'none';

      const imageContainer = tile.querySelector('.je-tile-image');
      imageContainer.style.backgroundColor = '#fff';
      imageContainer.style.cursor = 'pointer';
      imageContainer.addEventListener('click', () => {
        showCategoryPage(`${kind}-${item.id}`);
      });

      itemsContainer.appendChild(tile);

      fetchLogoPath(kind, item.id).then(logoPath => {
        if (!logoPath || !tile.isConnected) return;
        imageContainer.textContent = '';
        const img = document.createElement('img');
        img.src = `https://image.tmdb.org/t/p/w300${logoPath}`;
        img.alt = item.name;
        img.className = 'je-tile-logo';
        img.style.cssText = 'width: auto; height: auto; max-width: 90%; max-height: 90%; object-fit: contain;';
        img.onerror = () => { imageContainer.textContent = item.name; };
        imageContainer.appendChild(img);
      });
    });

    scrollerContainer.appendChild(itemsContainer);
    section.appendChild(scrollerContainer);
    return section;
  }

  // Tile color by genre name, shared across movie/TV since names overlap.
  const GENRE_COLORS = {
    'Action': '#b91c1ccc',
    'Action & Adventure': '#b91c1ccc',
    'Adventure': '#7c3aedcc',
    'Animation': '#0891b2cc',
    'Comedy': '#d97706cc',
    'Crime': '#1d4ed8cc',
    'Documentary': '#059669cc',
    'Drama': '#db2777cc',
    'Family': '#65a30dcc',
    'Fantasy': '#9333eacc',
    'History': '#78716ccc',
    'Horror': '#27272acc',
    'Kids': '#f59e0bcc',
    'Music': '#e11d48cc',
    'Mystery': '#4c1d95cc',
    'News': '#334155cc',
    'Reality': '#c026d3cc',
    'Romance': '#ec4899cc',
    'Sci-Fi & Fantasy': '#2563ebcc',
    'Science Fiction': '#2563ebcc',
    'Soap': '#db2777cc',
    'Talk': '#0d9488cc',
    'Thriller': '#7f1d1dcc',
    'TV Movie': '#6b7280cc',
    'War': '#57534ecc',
    'War & Politics': '#57534ecc',
    'Western': '#b45309cc',
  };
  const GENRE_COLOR_FALLBACK = '#4338ca';

  /**
   * Builds a horizontal row of genre tiles - a color-tinted TMDB backdrop
   * with the genre name overlaid - linking into the category page for that
   * genre.
   * @param {string} title
   * @param {Array<{id: number, name: string, backdrops: string[]}>} genres
   * @param {'movie'|'tv'} mediaType
   * @returns {HTMLElement}
   */
  function createGenreTileRow(title, genres, mediaType) {
    const section = document.createElement('div');
    section.className = 'verticalSection emby-scroller-container je-recommendations-section';

    const heading = document.createElement('h2');
    heading.className = 'sectionTitle sectionTitle-cards focuscontainer-x padded-left padded-right';
    heading.textContent = title;
    section.appendChild(heading);

    const scrollerContainer = document.createElement('div');
    scrollerContainer.setAttribute('is', 'emby-scroller');
    scrollerContainer.className = 'padded-top-focusscale padded-bottom-focusscale emby-scroller';
    scrollerContainer.dataset.horizontal = "true";
    scrollerContainer.dataset.centerfocus = "card";

    const itemsContainer = document.createElement('div');
    itemsContainer.setAttribute('is', 'emby-itemscontainer');
    itemsContainer.className = 'focuscontainer-x itemsContainer scrollSlider';

    // Avoid picking the same backdrop for two tiles in this row.
    const usedBackdrops = new Set();

    genres.forEach(genre => {
      const backdropList = genre.backdrops || [];
      const backdrop = backdropList.find(b => !usedBackdrops.has(b)) || backdropList[0];
      if (backdrop) usedBackdrops.add(backdrop);

      const color = GENRE_COLORS[genre.name] || GENRE_COLOR_FALLBACK;

      const tile = document.createElement('div');
      tile.className = 'card overflowBackdropCard card-hoverable card-withuserdata je-recommendations-tile';
      tile.innerHTML = `
        <div class="cardBox cardBox-bottompadded">
          <div class="cardScalable">
            <div class="cardPadder cardPadder-overflowBackdrop"></div>
            <div class="cardImageContainer cardContent je-genre-tile-image" style="background-color: ${color};">
              ${backdrop ? `<img class="je-genre-tile-backdrop" src="https://image.tmdb.org/t/p/w500${backdrop}" alt="" loading="lazy" onerror="this.remove()">` : ''}
              <span class="je-genre-tile-title">${escapeHtml(genre.name)}</span>
            </div>
            <div class="cardOverlayContainer" data-action="link"></div>
          </div>
        </div>`;

      // Mirrors createTileRow's click wiring: overlay disabled so Jellyfin's
      // own emby-itemscontainer click delegation leaves it alone, the actual
      // click handler lives on the image layer underneath instead.
      const overlayContainer = tile.querySelector('.cardOverlayContainer');
      overlayContainer.removeAttribute('data-action');
      overlayContainer.style.pointerEvents = 'none';

      const imageContainer = tile.querySelector('.je-genre-tile-image');
      imageContainer.style.cursor = 'pointer';
      imageContainer.addEventListener('click', () => {
        showCategoryPage(`genre-${mediaType}-${genre.id}`);
      });

      itemsContainer.appendChild(tile);
    });

    scrollerContainer.appendChild(itemsContainer);
    section.appendChild(scrollerContainer);
    return section;
  }

  /**
   * Renders the recommendations content (title + rows) into container.
   * @param {HTMLElement} container
   */
  async function renderInto(container) {
    if (state.currentAbortController) {
      state.currentAbortController.abort();
    }
    const abortController = new AbortController();
    state.currentAbortController = abortController;

    container.textContent = '';

    const heading = document.createElement('h1');
    heading.className = 'je-recommendations-title';
    heading.style.cssText = 'padding: 0 1.5em; margin-bottom: 0.5em;';
    heading.textContent = JE.t('recommendations_title');
    container.appendChild(heading);

    const loading = document.createElement('div');
    loading.className = 'je-recommendations-loading';
    loading.style.cssText = 'padding: 0 1.5em;';
    loading.textContent = JE.t('recommendations_loading');
    container.appendChild(loading);

    let rows;
    try {
      const [rowsResult, movieGenres, tvGenres] = await Promise.all([
        fetchAllRows(abortController.signal),
        fetchGenreSlider('movie'),
        fetchGenreSlider('tv'),
      ]);
      rows = rowsResult;
      P.MOVIE_GENRES = movieGenres || [];
      P.TV_GENRES = tvGenres || [];
    } catch (error) {
      if (error?.name === 'AbortError') return;
      console.error(`${logPrefix} Failed to load rows`, error);
      rows = [];
    }

    if (abortController.signal.aborted) return;

    loading.remove();

    const nonEmptyRows = rows.filter(entry => entry.results.length > 0);
    if (nonEmptyRows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'je-recommendations-empty';
      empty.style.cssText = 'padding: 0 1.5em;';
      empty.textContent = JE.t('recommendations_empty');
      container.appendChild(empty);
      return;
    }

    nonEmptyRows.forEach(({ row, results }) => {
      container.appendChild(createMediaRow(JE.t(row.titleKey), results, row.key));
    });

    if (P.MOVIE_GENRES.length) {
      container.appendChild(createGenreTileRow(JE.t('recommendations_movie_genres'), P.MOVIE_GENRES, 'movie'));
    }
    if (P.TV_GENRES.length) {
      container.appendChild(createGenreTileRow(JE.t('recommendations_tv_genres'), P.TV_GENRES, 'tv'));
    }

    container.appendChild(createTileRow(JE.t('recommendations_studios'), P.STUDIOS, 'studio'));
    container.appendChild(createTileRow(JE.t('recommendations_networks'), P.NETWORKS, 'network'));
  }

  // --- Custom tab entry point ---

  function renderForCustomTab(el) {
    renderInto(el);
  }

  P.createMediaRow = createMediaRow;
  P.createTileRow = createTileRow;
  P.createGenreTileRow = createGenreTileRow;
  P.renderInto = renderInto;
  P.renderForCustomTab = renderForCustomTab;
})();
