// /js/jellyseerr/recommendations.js
// Recommendations Page - Seerr-powered discover rows (Trending, Popular, Upcoming, Studios, Networks)
(function () {
  "use strict";

  const JE = window.JellyfinEnhanced;
  const logPrefix = '🪼 Jellyfin Enhanced: Recommendations:';
  const sidebar = document.querySelector('.mainDrawer-scrollContainer');
  const pluginPagesExists = !!sidebar?.querySelector(
    'a[is="emby-linkbutton"][data-itemid="Jellyfin.Plugin.JellyfinEnhanced.RecommendationsPage"]'
  );

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

  // Fixed set of media rows, in display order. Each maps to one of the new
  // jellyseerr/discover/* proxy endpoints added alongside this feature.
  // "path" is the base path used for both the row preview (page 1) and the
  // "View All" category page (which pages through it via ?page=N).
  const ROWS = [
    { key: 'trending', path: '/JellyfinEnhanced/jellyseerr/discover/trending', titleKey: 'recommendations_trending' },
    { key: 'movies', path: '/JellyfinEnhanced/jellyseerr/discover/movies', titleKey: 'recommendations_popular_movies' },
    { key: 'tv', path: '/JellyfinEnhanced/jellyseerr/discover/tv', titleKey: 'recommendations_popular_tv' },
    { key: 'movies-upcoming', path: '/JellyfinEnhanced/jellyseerr/discover/movies/upcoming', titleKey: 'recommendations_upcoming_movies' },
    { key: 'tv-upcoming', path: '/JellyfinEnhanced/jellyseerr/discover/tv/upcoming', titleKey: 'recommendations_upcoming_tv' },
  ];

  // Best-effort curated list of well-known TMDB studio (company) IDs, used to
  // build a "Studios" browsing row the same way Seerr's own discover page
  // does. Clicking a tile opens the existing discover/movies/studio/{id}
  // endpoint via the category page.
  const STUDIOS = [
    { name: 'Marvel Studios', id: 420 },
    { name: 'Pixar', id: 3 },
    { name: 'Walt Disney Pictures', id: 2 },
    { name: 'Warner Bros. Pictures', id: 174 },
    { name: 'Universal Pictures', id: 33 },
    { name: 'Paramount Pictures', id: 4 },
    { name: 'Lucasfilm', id: 1 },
    { name: 'Illumination', id: 6704 },
    { name: 'DreamWorks Animation', id: 521 },
    { name: 'Sony Pictures', id: 34 },
    { name: '20th Century Studios', id: 127928 },
    { name: 'Legendary Pictures', id: 923 },
    { name: 'A24', id: 41077 },
    { name: 'Blumhouse Productions', id: 3172 },
    { name: 'Metro-Goldwyn-Mayer', id: 21 },
    { name: 'Columbia Pictures', id: 5 },
  ];

  // Curated TMDB network IDs. Reuses the same IDs already vetted in
  // network-discovery.js's TV_NETWORKS map for consistency.
  const NETWORKS = [
    { name: 'Netflix', id: 213 },
    { name: 'HBO', id: 49 },
    { name: 'Disney+', id: 2739 },
    { name: 'Apple TV+', id: 2552 },
    { name: 'Amazon Prime Video', id: 1024 },
    { name: 'Hulu', id: 453 },
    { name: 'Paramount+', id: 4330 },
    { name: 'FX', id: 88 },
    { name: 'BBC', id: 4 },
    { name: 'Showtime', id: 67 },
    { name: 'Starz', id: 318 },
    { name: 'AMC', id: 174 },
    { name: 'Adult Swim', id: 80 },
    { name: 'Nickelodeon', id: 13 },
    { name: 'Crunchyroll', id: 1112 },
    { name: 'The CW', id: 71 },
  ];

  const state = {
    pageVisible: false,
    previousPage: null,
    currentAbortController: null,
    categoryPageVisible: false,
    categoryPreviousPage: null,
    categoryState: { activeScrollObserver: null, page: 1, hasMore: true, isLoading: false },
  };

  const fetchWithManagedRequest = (path, options) =>
    JE.discoveryFilter.fetchWithManagedRequest(path, 'recommendations', options);

  /**
   * Resolves a category key (row key, or "studio-<id>" / "network-<id>") to
   * its base fetch path and display title.
   * @param {string} categoryKey
   * @returns {{path: string, title: string}|null}
   */
  function resolveCategory(categoryKey) {
    const row = ROWS.find(r => r.key === categoryKey);
    if (row) {
      return { path: row.path, title: JE.t(row.titleKey) };
    }

    const studioMatch = categoryKey.match(/^studio-(\d+)$/);
    if (studioMatch) {
      const studio = STUDIOS.find(s => String(s.id) === studioMatch[1]);
      if (studio) {
        return { path: `/JellyfinEnhanced/jellyseerr/discover/movies/studio/${studio.id}`, title: studio.name };
      }
    }

    const networkMatch = categoryKey.match(/^network-(\d+)$/);
    if (networkMatch) {
      const network = NETWORKS.find(n => String(n.id) === networkMatch[1]);
      if (network) {
        return { path: `/JellyfinEnhanced/jellyseerr/discover/tv/network/${network.id}`, title: network.name };
      }
    }

    return null;
  }

  /**
   * Builds a horizontal media row section, mirroring the layout used for the
   * Jellyseerr search-results row (see jellyseerr/ui.js createJellyseerrSection).
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
      // pattern ui.js already uses for its own JS-only-handled card links.
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

  // Cache of resolved TMDB logo_path per "studio-<id>"/"network-<id>" key, so
  // switching between the standalone page and custom tab doesn't re-fetch.
  const logoCache = new Map();

  /**
   * Looks up a studio/network's TMDB logo via the plugin's generic TMDB
   * proxy (raw TMDB fields, e.g. logo_path, unlike Seerr's camelCase shapes).
   * Returns null on failure so callers can fall back to a text tile.
   * @param {'studio'|'network'} kind
   * @param {number} id
   * @returns {Promise<string|null>} logo_path, or null
   */
  async function fetchLogoPath(kind, id) {
    const cacheKey = `${kind}-${id}`;
    if (logoCache.has(cacheKey)) return logoCache.get(cacheKey);

    const tmdbPath = kind === 'studio' ? `/company/${id}` : `/network/${id}`;
    const promise = fetchWithManagedRequest(`/JellyfinEnhanced/tmdb${tmdbPath}`)
      .then(response => response?.logo_path || null)
      .catch(() => null);

    logoCache.set(cacheKey, promise);
    return promise;
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

  /**
   * Fetches all media rows in parallel. One failing/empty category never
   * blanks the whole page - each row is rendered independently.
   * @param {AbortSignal} signal
   * @returns {Promise<Array<{row: Object, results: Array}>>}
   */
  async function fetchAllRows(signal) {
    const settled = await Promise.allSettled(
      ROWS.map(row => fetchWithManagedRequest(`${row.path}?page=1`, { signal }))
    );

    return settled.map((outcome, i) => ({
      row: ROWS[i],
      results: outcome.status === 'fulfilled' ? (outcome.value?.results || []) : [],
    }));
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
      rows = await fetchAllRows(abortController.signal);
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

    container.appendChild(createTileRow(JE.t('recommendations_studios'), STUDIOS, 'studio'));
    container.appendChild(createTileRow(JE.t('recommendations_networks'), NETWORKS, 'network'));
  }

  // --- Custom tab entry point ---

  function renderForCustomTab(el) {
    renderInto(el);
  }

  // --- Standalone page (sidebar-link entry point) ---

  function createPageContainer() {
    let page = document.getElementById("je-recommendations-page");
    if (!page) {
      page = document.createElement("div");
      page.id = "je-recommendations-page";
      page.className = "page type-interior mainAnimatedPage hide";
      page.setAttribute("data-title", JE.t("recommendations_title"));
      page.setAttribute("data-backbutton", "true");
      page.setAttribute("data-url", "#/recommendations");
      page.setAttribute("data-type", "custom");
      page.innerHTML = `
        <div data-role="content">
          <div class="content-primary je-recommendations-page">
            <div id="je-recommendations-container" style="padding-top: 5em; padding-left: 0.5em; padding-right: 0.5em;"></div>
          </div>
        </div>
      `;

      const mainContent = document.querySelector(".mainAnimatedPages");
      if (mainContent) {
        mainContent.appendChild(page);
      } else {
        document.body.appendChild(page);
      }
    }
    return page;
  }

  function showPage() {
    if (state.categoryPageVisible) hideCategoryPage();
    if (state.pageVisible) return;

    const config = JE.pluginConfig || {};
    if (!config.RecommendationsPageEnabled) return;
    if (pluginPagesExists && config.RecommendationsUsePluginPages) return;

    state.pageVisible = true;

    const page = createPageContainer();

    if (window.location.hash !== "#/recommendations") {
      history.pushState({ page: "recommendations" }, JE.t("recommendations_title"), "#/recommendations");
    }

    const activePage = document.querySelector(".mainAnimatedPage:not(.hide):not(#je-recommendations-page)");
    if (activePage) {
      state.previousPage = activePage;
      activePage.classList.add("hide");
      activePage.dispatchEvent(new CustomEvent("viewhide", { bubbles: true, detail: { type: "interior" } }));
    }

    page.classList.remove("hide");
    page.dispatchEvent(new CustomEvent("viewshow", { bubbles: true, detail: { type: "custom", isRestored: false, options: {} } }));
    page.dispatchEvent(new CustomEvent("pageshow", { bubbles: true, detail: {} }));

    const container = document.getElementById("je-recommendations-container");
    if (container) renderInto(container);
  }

  function hidePage() {
    if (!state.pageVisible) return;

    const page = document.getElementById("je-recommendations-page");
    if (page) {
      page.classList.add("hide");
      page.dispatchEvent(new CustomEvent("viewhide", { bubbles: true, detail: { type: "custom" } }));
    }

    if (state.previousPage && !document.querySelector(".mainAnimatedPage:not(.hide):not(#je-recommendations-page):not(#je-recommendations-category-page)")) {
      state.previousPage.classList.remove("hide");
      state.previousPage.dispatchEvent(new CustomEvent("viewshow", { bubbles: true, detail: { type: "interior", isRestored: true } }));
    }

    state.pageVisible = false;
    state.previousPage = null;
    if (state.currentAbortController) {
      state.currentAbortController.abort();
    }
  }

  // --- Category page ("View All" / studio / network - infinite-scroll grid) ---

  function createCategoryPageContainer() {
    let page = document.getElementById("je-recommendations-category-page");
    if (!page) {
      page = document.createElement("div");
      page.id = "je-recommendations-category-page";
      page.className = "page type-interior mainAnimatedPage hide";
      page.setAttribute("data-title", JE.t("recommendations_title"));
      page.setAttribute("data-backbutton", "true");
      page.setAttribute("data-type", "custom");
      page.innerHTML = `
        <div data-role="content">
          <div class="content-primary je-recommendations-category-page">
            <div id="je-recommendations-category-header" class="je-recommendations-category-header">
              <button type="button" id="je-recommendations-category-back" class="paper-icon-button-light">
                <span class="material-icons" aria-hidden="true">arrow_back</span>
              </button>
              <h1 id="je-recommendations-category-title"></h1>
            </div>
            <div id="je-recommendations-category-container" is="emby-itemscontainer" class="itemsContainer padded-left padded-right vertical-wrap"></div>
          </div>
        </div>
      `;

      // No History API involvement for this page (see showCategoryPage) so
      // there's no browser Back-button support - this is the only way out.
      page.querySelector('#je-recommendations-category-back').addEventListener('click', () => {
        hideCategoryPage();
      });

      const mainContent = document.querySelector(".mainAnimatedPages");
      if (mainContent) {
        mainContent.appendChild(page);
      } else {
        document.body.appendChild(page);
      }
    }
    return page;
  }

  // Cap on consecutive fetched pages that render zero visible cards (all
  // filtered out as already-in-library/hidden) before giving up on this
  // load-more call. Without this, a heavily-owned studio/network can come
  // back with real API pages that render nothing, so the scroll sentinel
  // never moves and re-fires the same "load more" instantly forever.
  const MAX_CONSECUTIVE_EMPTY_PAGES = 20;

  async function loadMoreCategoryItems(category, container) {
    state.categoryState.isLoading = true;
    try {
      let nextPage = state.categoryState.page;
      let renderedAnyCards = false;
      let emptyPagesSkipped = 0;

      while (!renderedAnyCards && emptyPagesSkipped < MAX_CONSECUTIVE_EMPTY_PAGES) {
        nextPage += 1;
        const response = await fetchWithManagedRequest(`${category.path}?page=${nextPage}`);
        const results = response?.results || [];
        console.debug(`${logPrefix} category page ${nextPage}/${response?.totalPages}: ${results.length} raw result(s)`);

        if (results.length === 0) {
          state.categoryState.page = nextPage;
          state.categoryState.hasMore = false;
          return;
        }

        // Filters out already-in-library/hidden items - a raw non-empty API
        // page can still render zero actual cards.
        const fragment = JE.discoveryFilter.createCardsFragment(results, { cardClass: 'portraitCard' });
        renderedAnyCards = fragment.childNodes.length > 0;
        container.appendChild(fragment);

        state.categoryState.page = nextPage;
        state.categoryState.hasMore = nextPage < (response?.totalPages || 1);
        if (!state.categoryState.hasMore) return;
        if (!renderedAnyCards) emptyPagesSkipped++;
      }
    } finally {
      state.categoryState.isLoading = false;
    }
  }

  async function showCategoryPage(categoryKey) {
    const category = resolveCategory(categoryKey);
    if (!category) return;

    const config = JE.pluginConfig || {};
    if (!config.RecommendationsPageEnabled) return;

    if (state.pageVisible) hidePage();

    // Disconnect the previous category's scroll observer before replacing
    // categoryState wholesale - otherwise it leaks (nothing else references it).
    JE.discoveryFilter.cleanupScrollObserver(state.categoryState);
    state.categoryPageVisible = true;
    state.categoryState = { activeScrollObserver: null, page: 1, hasMore: true, isLoading: false };

    const page = createCategoryPageContainer();
    document.getElementById('je-recommendations-category-title').textContent = category.title;

    // Deliberately does NOT touch the History API at all (no pushState,
    // no URL change) - jellyfin-web's React router intercepts every
    // history.pushState call and re-resolves its own route table against
    // whatever URL it's given, and this page's URL was never one of its
    // registered routes. That produced a "not found" flash that even a
    // hard refresh couldn't reliably recover from. The category page is
    // shown/hidden purely as in-memory UI state instead; navigating away
    // (sidebar link, another tab, etc.) or the explicit back button below
    // closes it via hideCategoryPage().

    const activePage = document.querySelector(".mainAnimatedPage:not(.hide):not(#je-recommendations-category-page)");
    if (activePage) {
      state.categoryPreviousPage = activePage;
      activePage.classList.add("hide");
      activePage.dispatchEvent(new CustomEvent("viewhide", { bubbles: true, detail: { type: "interior" } }));
    }

    page.classList.remove("hide");
    page.dispatchEvent(new CustomEvent("viewshow", { bubbles: true, detail: { type: "custom", isRestored: false, options: {} } }));
    page.dispatchEvent(new CustomEvent("pageshow", { bubbles: true, detail: {} }));

    const container = document.getElementById('je-recommendations-category-container');
    container.textContent = '';

    try {
      const response = await fetchWithManagedRequest(`${category.path}?page=1`);
      const results = response?.results || [];
      container.appendChild(JE.discoveryFilter.createCardsFragment(results, { cardClass: 'portraitCard' }));
      state.categoryState.hasMore = 1 < (response?.totalPages || 1);
    } catch (error) {
      console.error(`${logPrefix} Failed to load category ${categoryKey}`, error);
    }

    JE.discoveryFilter.setupInfiniteScroll(
      state.categoryState,
      '#je-recommendations-category-page .content-primary',
      () => loadMoreCategoryItems(category, container),
      () => state.categoryState.hasMore,
      () => state.categoryState.isLoading
    );
  }

  function hideCategoryPage() {
    if (!state.categoryPageVisible) return;

    JE.discoveryFilter.cleanupScrollObserver(state.categoryState);

    const page = document.getElementById("je-recommendations-category-page");
    if (page) {
      page.classList.add("hide");
      page.dispatchEvent(new CustomEvent("viewhide", { bubbles: true, detail: { type: "custom" } }));
    }

    if (state.categoryPreviousPage && !document.querySelector(".mainAnimatedPage:not(.hide):not(#je-recommendations-page):not(#je-recommendations-category-page)")) {
      state.categoryPreviousPage.classList.remove("hide");
      state.categoryPreviousPage.dispatchEvent(new CustomEvent("viewshow", { bubbles: true, detail: { type: "interior", isRestored: true } }));
    }

    state.categoryPageVisible = false;
    state.categoryPreviousPage = null;
  }

  // --- Navigation ---

  function handleNavigation() {
    const hash = window.location.hash;

    if (state.categoryPageVisible) hideCategoryPage();

    if (hash === "#/recommendations") {
      showPage();
    } else if (state.pageVisible) {
      hidePage();
    }
  }

  function handleViewShow(e) {
    const targetPage = e.target;
    if (!targetPage) return;
    if (state.pageVisible && targetPage.id !== "je-recommendations-page" && targetPage.id !== "je-recommendations-category-page") {
      hidePage();
    }
    if (state.categoryPageVisible && targetPage.id !== "je-recommendations-category-page" && targetPage.id !== "je-recommendations-page") {
      hideCategoryPage();
    }
  }

  // --- Sidebar link injection ---

  function injectNavigation() {
    const config = JE.pluginConfig || {};
    if (!config.RecommendationsPageEnabled) return;
    if (pluginPagesExists && config.RecommendationsUsePluginPages) return;
    if (config.RecommendationsUseCustomTabs) return;
    if (config.RecommendationsUseNativeTab) return;

    // Hide plugin page link if it exists
    const pluginPageItem = sidebar?.querySelector(
      'a[is="emby-linkbutton"][data-itemid="Jellyfin.Plugin.JellyfinEnhanced.RecommendationsPage"]'
    );
    if (pluginPageItem) {
      pluginPageItem.style.setProperty('display', 'none', 'important');
    }

    if (document.querySelector(".je-nav-recommendations-item")) return;

    const jellyfinEnhancedSection = document.querySelector('.jellyfinEnhancedSection');
    if (!jellyfinEnhancedSection) {
      console.log(`${logPrefix} jellyfinEnhancedSection not found, will wait for it`);
      return;
    }

    const navItem = document.createElement("a");
    navItem.setAttribute('is', 'emby-linkbutton');
    navItem.className = "navMenuOption lnkMediaFolder emby-button je-nav-recommendations-item";
    navItem.href = "#";
    navItem.innerHTML = `
      <span class="navMenuOptionIcon material-icons">auto_awesome</span>
      <span class="sectionName navMenuOptionText">${JE.t("recommendations_title")}</span>
    `;
    navItem.addEventListener("click", (e) => {
      e.preventDefault();
      showPage();
    });

    jellyfinEnhancedSection.appendChild(navItem);
    console.log(`${logPrefix} Navigation item injected`);
  }

  function setupNavigationWatcher() {
    const config = JE.pluginConfig || {};
    if (!config.RecommendationsPageEnabled) return;
    if (pluginPagesExists && config.RecommendationsUsePluginPages) return;
    if (config.RecommendationsUseCustomTabs) return;
    if (config.RecommendationsUseNativeTab) return;

    const observer = new MutationObserver(() => {
      const currentConfig = JE.pluginConfig || {};
      if (pluginPagesExists && currentConfig.RecommendationsUsePluginPages) return;
      if (currentConfig.RecommendationsUseCustomTabs) return;
      if (currentConfig.RecommendationsUseNativeTab) return;

      if (!document.querySelector('.je-nav-recommendations-item')) {
        const jellyfinEnhancedSection = document.querySelector('.jellyfinEnhancedSection');
        if (jellyfinEnhancedSection) {
          console.log(`${logPrefix} Sidebar rebuilt, re-injecting navigation`);
          injectNavigation();
        }
      }
    });

    const navDrawer = document.querySelector('.mainDrawer, .navDrawer, body');
    if (navDrawer) {
      observer.observe(navDrawer, { childList: true, subtree: true });
    }
  }

  function init() {
    const config = JE.pluginConfig || {};
    if (!config.RecommendationsPageEnabled) return;

    injectNavigation();
    setupNavigationWatcher();

    document.addEventListener("viewshow", handleViewShow);
    window.addEventListener("popstate", handleNavigation);
    window.addEventListener("hashchange", handleNavigation);
    handleNavigation();
  }

  window.JellyfinEnhanced.recommendationsPage = {
    renderForCustomTab,
    showPage,
    hidePage,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
