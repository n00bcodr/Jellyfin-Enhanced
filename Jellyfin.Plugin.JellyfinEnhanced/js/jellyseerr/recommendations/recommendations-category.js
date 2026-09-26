// /js/jellyseerr/recommendations/recommendations-category.js
// Recommendations Page — the "View All" / studio / network category page and
// its infinite-scroll paging (split from recommendations.js). A category is
// one or more feeds paged side by side: a studio or network page reads a
// movie feed and a series feed (interleaved into one list) and offers
// All | Movies | Series once both have answered with results.
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
  // Filter state shared by every category page that mixes both media types
  // (Trending, studios, networks); the control only appears on those.
  const FILTER_MODULE = 'recommendationsTrending';
  const SCROLL_ROOT = '#je-recommendations-category-page .content-primary';

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

  // Upper bound on pages fetched in parallel per feed by one load-more call.
  const MAX_PAGES_PER_LOAD = 4;
  // TMDB refuses discover pages beyond 500 (Seerr answers HTTP 500).
  const TMDB_MAX_PAGE = 500;
  const clampPages = (totalPages) => Math.min(Number(totalPages) || 1, TMDB_MAX_PAGE);
  // Items fetched vs cards rendered (after in-library/hidden filtering) for
  // the current category; sizes the parallel batches.
  const yieldStats = { fetched: 0, rendered: 0 };
  // TMDB pages overlap as popularity shifts between requests; drop repeats.
  let categoryDeduplicator = null;

  /**
   * Fresh paging state for a category. Each open (and each sort reload) gets
   * its own object: a load that finds another one installed as
   * state.categoryState belongs to a page nobody is looking at any more.
   * @param {{feeds: Array<{path: string, mediaType?: string}>}} category
   */
  function newCategoryState(category) {
    return {
      activeScrollObserver: null,
      isLoading: false,
      // Whether the All | Movies | Series control governs this page.
      filtered: false,
      // Per-feed cursor: page is the last page committed (0 = page 1 still
      // owed), seen counts the raw rows the feed has answered with.
      feeds: category.feeds.map(f => ({ path: f.path, mediaType: f.mediaType || null, page: 0, totalPages: 0, hasMore: true, seen: 0 }))
    };
  }

  /**
   * The feeds the page reads right now: every feed until the filter control
   * is in play, then only the selected media type's (a feed without a media
   * type - Trending, the plain rows - is always read).
   * @param {ReturnType<typeof newCategoryState>} st
   */
  function activeFeeds(st) {
    if (!st.filtered) return st.feeds;
    const mode = JE.discoveryFilter.getFilterMode(FILTER_MODULE);
    const MODES = JE.discoveryFilter.MODES;
    return st.feeds.filter(f => !f.mediaType
      || mode === MODES.MIXED
      || (mode === MODES.MOVIES ? f.mediaType === 'movie' : f.mediaType === 'tv'));
  }

  /**
   * Merges the feeds' page results into one list (interleaved 1:1 when two
   * feeds answered, as the "More from" sections do).
   * @param {Array<Array<any>>} perFeed - Results per feed, in feed order
   */
  function mergeFeedResults(perFeed) {
    if (perFeed.length < 2) return perFeed[0] || [];
    return JE.discoveryFilter.interleaveArrays(perFeed[0], perFeed[1]);
  }

  /**
   * Warms the request cache with the pages after each active feed's cursor.
   * @param {ReturnType<typeof newCategoryState>} st
   * @param {number} count - How many pages ahead to fetch per feed
   */
  function prefetchCategoryPages(st, count) {
    for (const feed of activeFeeds(st)) {
      if (!feed.hasMore) continue;
      const last = feed.totalPages ? Math.min(feed.totalPages, feed.page + count) : feed.page + count;
      for (let p = feed.page + 1; p <= last; p++) {
        fetchWithManagedRequest(`${feed.path}?page=${p}`).catch(() => {});
      }
    }
  }

  /**
   * Commits one fetched page onto its feed's cursor and returns its sorted rows.
   * @param {{page: number, totalPages: number, hasMore: boolean, seen: number}} feed
   * @param {number} pageNumber
   * @param {any} response
   */
  function commitPage(feed, pageNumber, response) {
    const results = response?.results || [];
    console.debug(`${logPrefix} category page ${pageNumber}/${response?.totalPages}: ${results.length} raw result(s)`);
    feed.page = pageNumber;
    feed.totalPages = response?.totalPages ? clampPages(response.totalPages) : (feed.totalPages || 1);
    // An empty page is not the end of the feed: server-side parental filtering
    // removes rows while preserving the upstream page counts, so page 2 of 10
    // can legitimately come back with nothing. Keep committing pages and let
    // the scroll engine's empty-page valve decide when to stop.
    feed.hasMore = pageNumber < feed.totalPages;
    feed.seen += results.length;
    return sortResults(results, JE.discoveryFilter.getSortMode(SORT_MODULE));
  }

  /**
   * Builds the All | Movies | Series control for the category container.
   * Switching hides the other type's cards (CSS) and re-arms the scroll
   * engine, since the selected type's feed may be short or not read yet.
   * @param {HTMLElement} container
   */
  function createFilterControl(container) {
    return JE.discoveryFilter.createFilterControl(FILTER_MODULE, (newMode) => {
      JE.discoveryFilter.applyFilterVisibility(container, newMode);
      armScroll(container);
    });
  }

  /**
   * Adds the filter control once every feed of a multi-feed category has
   * answered with rows (page 1 of one feed may have arrived late or failed);
   * a feed that stays empty leaves the page single-type with no control.
   * @param {ReturnType<typeof newCategoryState>} st
   * @param {HTMLElement} container
   */
  function ensureFilterControl(st, container) {
    if (st.filtered || st.feeds.length < 2 || !st.feeds.every(f => f.seen > 0)) return;
    const filterContainer = document.getElementById('je-recommendations-category-filter');
    if (!filterContainer) return;
    st.filtered = true;
    filterContainer.textContent = '';
    filterContainer.appendChild(createFilterControl(container));
    JE.discoveryFilter.applyFilterVisibility(container, JE.discoveryFilter.getFilterMode(FILTER_MODULE));
  }

  /**
   * Fetches the next batch of pages in parallel from every active feed
   * (sized from the scroll engine's buffer deficit and the observed
   * post-filter yield) and appends their cards. A batch that renders nothing
   * (every item already in the library / hidden) is fine: the scroll engine
   * simply calls again for the pages after it, so heavily-owned categories
   * never stall. The pages after this batch are prefetched into the cache
   * while it renders.
   * @param {HTMLElement} container - The category's card container
   * @param {{deficitPx?: number, pageBudget?: number, engaged?: boolean}} [hint] - From the scroll engine
   * @param {() => boolean} [isStale] - True once another category (or Back) took over
   * @returns {Promise<{pages: number, rendered: number}>} Pages consumed and cards appended
   */
  async function loadMoreCategoryItems(container, hint, isStale) {
    const st = state.categoryState;
    st.isLoading = true;
    const feeds = activeFeeds(st).filter(f => f.hasMore);
    const cursors = feeds.map(f => f.page);
    try {
      if (feeds.length === 0) return { pages: 0, rendered: 0 };
      const wantCards = JE.seamlessScroll?.cardsNeeded?.(container, hint, 20) || 20;
      const yieldRatio = yieldStats.fetched >= 20 ? Math.min(1, Math.max(0.1, yieldStats.rendered / yieldStats.fetched)) : 0.9;
      // Pages per feed: together the feeds should cover the deficit.
      let count = Math.min(MAX_PAGES_PER_LOAD, Math.max(1, Math.ceil(wantCards / (20 * feeds.length * yieldRatio))));
      const pageBudget = Number.isFinite(hint?.pageBudget) ? Math.max(0, hint.pageBudget) : Infinity;
      count = Math.min(count, Math.floor(pageBudget / feeds.length));
      if (count < 1) return { pages: 0, rendered: 0 }; // out of budget for now; the valve decides, not us
      const plans = feeds.map(feed => {
        const pages = [];
        const last = feed.totalPages ? Math.min(feed.totalPages, feed.page + count) : feed.page + count;
        for (let p = feed.page + 1; p <= last; p++) pages.push(p);
        return { feed, pages };
      });

      const settledPerFeed = await Promise.all(plans.map(({ feed, pages }) =>
        Promise.allSettled(pages.map(p => fetchWithManagedRequest(`${feed.path}?page=${p}`)))));
      // Another category (or Back) took over while these pages were in flight:
      // they are cached for later, but this page's DOM and state are not ours.
      if (isStale?.()) return { pages: 0, rendered: 0 };

      // Commit each feed's pages in order up to its first failure (the rest
      // are re-fetched on the next load); throw only if nothing arrived so
      // the engine retries.
      const perFeed = [];
      let firstError = null;
      let committed = 0;
      plans.forEach(({ feed, pages }, i) => {
        const results = [];
        const settled = settledPerFeed[i];
        for (let j = 0; j < settled.length; j++) {
          const s = settled[j];
          if (s.status !== 'fulfilled') { if (s.reason?.name === 'AbortError') throw s.reason; if (!firstError) firstError = s.reason; break; }
          results.push(...commitPage(feed, pages[j], s.value));
          committed++;
        }
        perFeed.push(results);
      });
      if (firstError && committed === 0) throw firstError;

      let results = mergeFeedResults(perFeed);
      if (categoryDeduplicator) results = categoryDeduplicator.filter(results);
      // Filters out already-in-library/hidden items - a raw non-empty API
      // page can still render zero actual cards.
      const fragment = JE.discoveryFilter.createCardsFragment(results, { cardClass: 'portraitCard' });
      yieldStats.fetched += results.length;
      const rendered = fragment.childNodes.length;
      yieldStats.rendered += rendered;
      container.appendChild(fragment);
      ensureFilterControl(st, container);
      const pagesFetched = plans.reduce((n, p) => n + p.pages.length, 0);
      const remainingBudget = pageBudget === Infinity ? Infinity : Math.max(0, pageBudget - pagesFetched);
      const prefetch = rendered > 0 ? count : Math.min(count, Math.floor(remainingBudget / feeds.length));
      if (prefetch > 0) prefetchCategoryPages(st, prefetch);
      return { pages: committed, rendered };
    } catch (error) {
      // Roll back so the retry fetches the same pages.
      feeds.forEach((feed, i) => { feed.page = cursors[i]; });
      throw error;
    } finally {
      st.isLoading = false;
    }
  }

  /**
   * Renders page 1 of every feed of the category into an emptied container.
   * @param {HTMLElement} container
   * @param {() => boolean} [isStale] - True once another category (or Back) took over
   */
  async function loadInitialCategoryPage(container, isStale) {
    JE.jellyseerrUI?.releasePosters?.(container);
    container.textContent = '';
    const st = state.categoryState;
    yieldStats.fetched = 0;
    yieldStats.rendered = 0;
    categoryDeduplicator = JE.seamlessScroll?.createDeduplicator?.() || null;
    // Page 1 of each feed alone first: extra requests in flight at Seerr slow
    // it down, and the engine's first fill fetches pages 2-3 the moment page 1
    // renders.
    const settled = await Promise.allSettled(st.feeds.map(feed => fetchWithManagedRequest(`${feed.path}?page=1`)));
    // A failed request can also settle after navigation or a sort reload.
    // It must not reset the pagination now owned by that newer operation.
    if (isStale?.()) return;
    const perFeed = st.feeds.map((feed, i) => {
      const s = settled[i];
      if (s.status === 'fulfilled') return commitPage(feed, 1, s.value);
      // Page 1 failed (a 504 while the parental lookups warm, or a Seerr hiccup):
      // leave the feed at page 0 with more pages so the engine's first fill asks
      // for page 1 again, rather than silently starting at page 2.
      feed.page = 0;
      feed.hasMore = true;
      console.error(`${logPrefix} Failed to load category page 1; it will be retried`, s.reason);
      return [];
    });
    let results = mergeFeedResults(perFeed);
    if (categoryDeduplicator) results = categoryDeduplicator.filter(results);
    const fragment = JE.discoveryFilter.createCardsFragment(results, { cardClass: 'portraitCard' });
    yieldStats.fetched += results.length;
    yieldStats.rendered += fragment.childNodes.length;
    container.appendChild(fragment);
    ensureFilterControl(st, container);
  }

  /**
   * (Re-)installs the scroll engine for the current category state.
   * @param {HTMLElement} container
   */
  function armScroll(container) {
    const st = state.categoryState;
    const stale = () => state.categoryState !== st || !state.categoryPageVisible;
    JE.discoveryFilter.cleanupScrollObserver(st);
    JE.discoveryFilter.setupInfiniteScroll(
      st,
      SCROLL_ROOT,
      (hint) => loadMoreCategoryItems(container, hint, stale),
      () => activeFeeds(st).some(f => f.hasMore),
      () => st.isLoading
    );
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
    // Back pressed (or another category opened) before page 1 lands must not
    // install an engine on a page nobody is looking at: every step checks
    // this state is still the installed one.
    const st = (state.categoryState = newCategoryState(category));
    const stale = () => state.categoryState !== st || !state.categoryPageVisible;

    const page = createCategoryPageContainer();
    document.getElementById('je-recommendations-category-title').textContent = category.title;

    const container = document.getElementById('je-recommendations-category-container');

    // All | Movies | Series filter - Trending mixes both media types from the
    // start; a studio or network page gets the control once both of its feeds
    // have answered with results (ensureFilterControl).
    const filterContainer = document.getElementById('je-recommendations-category-filter');
    filterContainer.textContent = '';
    if (categoryKey === 'trending') {
      st.filtered = true;
      filterContainer.appendChild(createFilterControl(container));
    }
    JE.discoveryFilter.applyFilterVisibility(container,
      st.filtered ? JE.discoveryFilter.getFilterMode(FILTER_MODULE) : JE.discoveryFilter.MODES.MIXED);

    const sortContainer = document.getElementById('je-recommendations-category-sort');
    sortContainer.textContent = '';
    sortContainer.appendChild(JE.discoveryFilter.createSortControl(SORT_MODULE, () => {
      const previous = state.categoryState;
      JE.discoveryFilter.cleanupScrollObserver(previous);
      // A sort reload is its own operation: page 1 and load-mores of the
      // previous sort must not land in the re-sorted list. The filter control
      // already on the page keeps governing it.
      const sortSt = (state.categoryState = newCategoryState(category));
      sortSt.filtered = previous.filtered;
      const sortStale = () => state.categoryState !== sortSt || !state.categoryPageVisible;
      loadInitialCategoryPage(container, sortStale).then(() => {
        if (sortStale()) return;
        armScroll(container);
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

    await loadInitialCategoryPage(container, stale);
    if (stale()) return;

    armScroll(container);
  }

  function hideCategoryPage() {
    if (!state.categoryPageVisible) return;

    JE.discoveryFilter.cleanupScrollObserver(state.categoryState);

    const page = document.getElementById("je-recommendations-category-page");
    JE.jellyseerrUI?.releasePosters?.(page || undefined);
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
