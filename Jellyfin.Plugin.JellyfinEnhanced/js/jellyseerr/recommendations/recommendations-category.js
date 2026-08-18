// /js/jellyseerr/recommendations/recommendations-category.js
// Recommendations Page — the "View All" / studio / network category page and
// its infinite-scroll paging (split from recommendations.js).
(function () {
  "use strict";

  const JE = window.JellyfinEnhanced;
  JE.internals = JE.internals || {};
  const P = (JE.internals.recommendationsPage = JE.internals.recommendationsPage || {});

  const logPrefix = '🪼 Jellyfin Enhanced: Recommendations:';
  const state = P.state;
  const resolveCategory = P.resolveCategory;
  const fetchWithManagedRequest = P.fetchWithManagedRequest;
  const hidePage = P.hidePage;

  const SORT_MODULE = 'recommendationsCategory';
  const FILTER_MODULE = 'recommendationsTrending';

  // Seerr only reads sortBy server-side for its plain /discover/movies and
  // /discover/tv routes - genre, studio, network, upcoming and trending all
  // ignore it. So sorting is done client-side on each fetched page instead,
  // which works everywhere (including the mixed movie/TV Trending feed,
  // since it just checks whichever date field an item actually has) at the
  // cost of only sorting within each already-loaded page, not globally.
  function sortResults(results, sortBy) {
    if (!sortBy) return results;
    const sorted = [...results];
    if (sortBy === 'vote_average.desc') {
      sorted.sort((a, b) => (b.voteAverage || 0) - (a.voteAverage || 0));
    } else if (sortBy === 'release_date.desc' || sortBy === 'release_date.asc') {
      const dir = sortBy.endsWith('.desc') ? -1 : 1;
      sorted.sort((a, b) => {
        const dateA = a.releaseDate || a.firstAirDate || '';
        const dateB = b.releaseDate || b.firstAirDate || '';
        return dir * dateA.localeCompare(dateB);
      });
    }
    return sorted;
  }

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
              <div id="je-recommendations-category-controls" style="margin-left:auto;display:flex;align-items:center;gap:0.75em;">
                <div id="je-recommendations-category-filter"></div>
                <div id="je-recommendations-category-sort"></div>
              </div>
            </div>
            <div id="je-recommendations-category-container" is="emby-itemscontainer" class="itemsContainer je-pad-left je-pad-right vertical-wrap"></div>
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
        let results = response?.results || [];
        console.debug(`${logPrefix} category page ${nextPage}/${response?.totalPages}: ${results.length} raw result(s)`);

        if (results.length === 0) {
          state.categoryState.page = nextPage;
          state.categoryState.hasMore = false;
          return;
        }

        results = sortResults(results, JE.discoveryFilter.getSortMode(SORT_MODULE));

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

  async function loadInitialCategoryPage(category, container) {
    container.textContent = '';
    state.categoryState.page = 1;
    state.categoryState.hasMore = true;
    try {
      const response = await fetchWithManagedRequest(`${category.path}?page=1`);
      const results = sortResults(response?.results || [], JE.discoveryFilter.getSortMode(SORT_MODULE));
      container.appendChild(JE.discoveryFilter.createCardsFragment(results, { cardClass: 'portraitCard' }));
      state.categoryState.hasMore = 1 < (response?.totalPages || 1);
    } catch (error) {
      console.error(`${logPrefix} Failed to load category`, error);
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

    const container = document.getElementById('je-recommendations-category-container');

    // All | Movies | Series filter - only Trending mixes both media types.
    const filterContainer = document.getElementById('je-recommendations-category-filter');
    filterContainer.textContent = '';
    if (categoryKey === 'trending') {
      filterContainer.appendChild(JE.discoveryFilter.createFilterControl(FILTER_MODULE, (newMode) => {
        JE.discoveryFilter.applyFilterVisibility(container, newMode);
      }));
      JE.discoveryFilter.applyFilterVisibility(container, JE.discoveryFilter.getFilterMode(FILTER_MODULE));
    } else {
      JE.discoveryFilter.applyFilterVisibility(container, JE.discoveryFilter.MODES.MIXED);
    }

    const sortContainer = document.getElementById('je-recommendations-category-sort');
    sortContainer.textContent = '';
    sortContainer.appendChild(JE.discoveryFilter.createSortControl(SORT_MODULE, () => {
      JE.discoveryFilter.cleanupScrollObserver(state.categoryState);
      loadInitialCategoryPage(category, container).then(() => {
        JE.discoveryFilter.setupInfiniteScroll(
          state.categoryState,
          '#je-recommendations-category-page .content-primary',
          () => loadMoreCategoryItems(category, container),
          () => state.categoryState.hasMore,
          () => state.categoryState.isLoading
        );
      });
    }));

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

    await loadInitialCategoryPage(category, container);

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

  P.createCategoryPageContainer = createCategoryPageContainer;
  P.loadMoreCategoryItems = loadMoreCategoryItems;
  P.showCategoryPage = showCategoryPage;
  P.hideCategoryPage = hideCategoryPage;
})();
