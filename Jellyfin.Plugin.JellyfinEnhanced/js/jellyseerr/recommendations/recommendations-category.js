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

  // Upper bound on pages fetched in parallel by one load-more call.
  const MAX_PAGES_PER_LOAD = 4;
  // TMDB refuses discover pages beyond 500 (Seerr answers HTTP 500).
  const TMDB_MAX_PAGE = 500;
  const clampPages = (totalPages) => Math.min(Number(totalPages) || 1, TMDB_MAX_PAGE);
  // Items fetched vs cards rendered (after in-library/hidden filtering) for
  // the current category; sizes the parallel batches.
  const yieldStats = { fetched: 0, rendered: 0 };

  function prefetchCategoryPages(category, count) {
    const st = state.categoryState;
    if (!st.hasMore) return;
    const last = st.totalPages ? Math.min(st.totalPages, st.page + count) : st.page + count;
    for (let p = st.page + 1; p <= last; p++) {
      fetchWithManagedRequest(`${category.path}?page=${p}`).catch(() => {});
    }
  }

  // Fetches the next batch of pages in parallel (sized from the scroll
  // engine's buffer deficit and the observed post-filter yield) and appends
  // their cards. A batch that renders nothing (every item already in the
  // library / hidden) is fine: the scroll engine simply calls again for the
  // pages after it, so heavily-owned categories never stall. The pages after
  // this batch are prefetched into the cache while it renders.
  async function loadMoreCategoryItems(category, container, hint) {
    const st = state.categoryState;
    st.isLoading = true;
    const firstPage = st.page + 1;
    try {
      const wantCards = JE.seamlessScroll?.cardsNeeded?.(container, hint, 20) || 20;
      const yieldRatio = yieldStats.fetched >= 20 ? Math.min(1, Math.max(0.1, yieldStats.rendered / yieldStats.fetched)) : 0.9;
      let count = Math.min(MAX_PAGES_PER_LOAD, Math.max(1, Math.ceil(wantCards / (20 * yieldRatio))));
      if (st.totalPages) count = Math.min(count, st.totalPages - st.page);
      const pageBudget = Number.isFinite(hint?.pageBudget) ? Math.max(0, hint.pageBudget) : Infinity;
      count = Math.min(count, pageBudget);
      if (count < 1) return { pages: 0, rendered: 0 }; // out of budget for now; the valve decides, not us
      const pages = [];
      for (let p = firstPage; p < firstPage + count; p++) pages.push(p);

      const responses = await Promise.all(pages.map(p => fetchWithManagedRequest(`${category.path}?page=${p}`)));

      const fragment = document.createDocumentFragment();
      for (let i = 0; i < responses.length; i++) {
        const response = responses[i];
        let results = response?.results || [];
        console.debug(`${logPrefix} category page ${pages[i]}/${response?.totalPages}: ${results.length} raw result(s)`);
        st.page = pages[i];
        if (response?.totalPages) st.totalPages = clampPages(response.totalPages);
        if (results.length === 0) {
          st.hasMore = false;
          break;
        }
        results = sortResults(results, JE.discoveryFilter.getSortMode(SORT_MODULE));
        // Filters out already-in-library/hidden items - a raw non-empty API
        // page can still render zero actual cards.
        fragment.appendChild(JE.discoveryFilter.createCardsFragment(results, { cardClass: 'portraitCard' }));
        yieldStats.fetched += results.length;
        st.hasMore = pages[i] < clampPages(response?.totalPages);
      }
      const rendered = fragment.childNodes.length;
      yieldStats.rendered += rendered;
      container.appendChild(fragment);
      const remainingBudget = pageBudget === Infinity ? Infinity : Math.max(0, pageBudget - pages.length);
      const prefetch = rendered > 0 ? count : Math.min(count, remainingBudget);
      if (prefetch > 0) prefetchCategoryPages(category, prefetch);
      return { pages: pages.length, rendered };
    } catch (error) {
      // Roll back so the retry fetches the same pages.
      st.page = firstPage - 1;
      throw error;
    } finally {
      st.isLoading = false;
    }
  }

  async function loadInitialCategoryPage(category, container) {
    container.textContent = '';
    state.categoryState.page = 1;
    state.categoryState.hasMore = true;
    state.categoryState.totalPages = 0;
    yieldStats.fetched = 0;
    yieldStats.rendered = 0;
    try {
      // Warm pages 2-3 while page 1 is in flight.
      for (let p = 2; p <= 3; p++) fetchWithManagedRequest(`${category.path}?page=${p}`).catch(() => {});
      const response = await fetchWithManagedRequest(`${category.path}?page=1`);
      const results = sortResults(response?.results || [], JE.discoveryFilter.getSortMode(SORT_MODULE));
      const fragment = JE.discoveryFilter.createCardsFragment(results, { cardClass: 'portraitCard' });
      yieldStats.fetched += results.length;
      yieldStats.rendered += fragment.childNodes.length;
      container.appendChild(fragment);
      state.categoryState.totalPages = clampPages(response?.totalPages);
      state.categoryState.hasMore = 1 < clampPages(response?.totalPages);
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
    // Generation token: Back pressed (or another category opened) before page 1
    // lands must not install an engine on a page nobody is looking at.
    const generation = (state.categoryGeneration = (state.categoryGeneration || 0) + 1);
    const stale = () => generation !== state.categoryGeneration || !state.categoryPageVisible;
    state.categoryState = { activeScrollObserver: null, page: 1, totalPages: 0, hasMore: true, isLoading: false };

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
        if (stale()) return;
        JE.discoveryFilter.setupInfiniteScroll(
          state.categoryState,
          '#je-recommendations-category-page .content-primary',
          (hint) => loadMoreCategoryItems(category, container, hint),
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
    if (stale()) return;

    JE.discoveryFilter.setupInfiniteScroll(
      state.categoryState,
      '#je-recommendations-category-page .content-primary',
      (hint) => loadMoreCategoryItems(category, container, hint),
      () => state.categoryState.hasMore,
      () => state.categoryState.isLoading
    );
  }

  function hideCategoryPage() {
    if (!state.categoryPageVisible) return;

    JE.discoveryFilter.cleanupScrollObserver(state.categoryState);
    JE.jellyseerrUI?.releasePosters?.();

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
