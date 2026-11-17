// /js/jellyseerr/recommendations/recommendations-category.js
// Recommendations Page — the "View All" / studio / network category page and
// its infinite-scroll paging (split from recommendations.js). A category is
// one or more feeds paged side by side: a studio or network page reads a
// movie feed and a series feed (interleaved into one list) and offers
// All | Movies | Series once both have answered with results. Its filters are
// the Recommendations page's (P.FILTER_MODULE): it opens with what the page has
// set, and what is set here is the page's too. Opened from the Home tab, its
// address names it (`jeCategory`, see discovery-address.js), so Back and
// Forward move between the tab and its categories, and a link or a reload
// opens it again.
(function () {
  "use strict";

  const JE = window.JellyfinEnhanced;
  JE.internals = JE.internals || {};
  const P = (JE.internals.recommendationsPage = JE.internals.recommendationsPage || {});

  const logPrefix = '🪼 Jellyfin Enhanced: Recommendations:';
  const state = P.state;
  const resolveCategory = P.resolveCategory;
  const hidePage = P.hidePage;

  const SORT_MODULE = P.SORT_MODULE;
  // The Recommendations page's filters (All | Movies | Series shows on a page
  // mixing both media types: Trending, studios, networks).
  const FILTER_MODULE = P.FILTER_MODULE;
  const SCROLL_ROOT = '#je-recommendations-category-page .content-primary';
  // In a category entry's state: the entry below it is the tab it was opened
  // from, so the arrow can go Back to it.
  const BACK_KEY = 'jeCategoryBack';

  /**
   * One page of a category feed, under the page's filters as the feed's kind takes them.
   * @param {{path: string, kind: ('movie'|'tv'|null)}} feed
   * @param {number} page
   * @returns {Promise<any>}
   */
  const fetchFeedPage = (feed, page) => P.feedPage(feed.path, feed.kind, page);

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
      // Spoiler Guard keeps a hidden score here, so a protected title doesn't sink.
      sorted.sort((a, b) => (b.jeSortRating || b.voteAverage || 0) - (a.jeSortRating || a.voteAverage || 0));
    } else if (sortBy === 'vote_count.desc') {
      // Spoiler Guard keeps a hidden vote count here too, for the same reason.
      sorted.sort((a, b) => (Number(b.jeSortVotes || b.voteCount) || 0) - (Number(a.jeSortVotes || a.voteCount) || 0));
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
              <div id="je-recommendations-category-controls" class="je-recommendations-category-controls" style="margin-left:auto;display:flex;align-items:center;gap:0.75em;">
                <div id="je-recommendations-category-filter"></div>
                <div id="je-recommendations-category-filters"></div>
                <div id="je-recommendations-category-sort"></div>
              </div>
            </div>
            <div id="je-recommendations-category-container" is="emby-itemscontainer" class="itemsContainer je-pad-left je-pad-right vertical-wrap"></div>
          </div>
        </div>
      `;

      // With a history entry open, the button goes through Back so the entry is consumed. A page its
      // address opened (a link, a reload) has nothing of the tab's below it: the address goes back to the tab.
      page.querySelector('#je-recommendations-category-back').addEventListener('click', () => {
        if (urlMode && history.state?.[BACK_KEY] === true) history.back();
        else if (urlMode) {
          const address = JE.discoveryAddress;
          address.go(address.addressWith(window.location.hash, null, address.current(FILTER_MODULE, null), false));
          hideCategoryPage();
        } else if (categoryHistoryActive) history.back();
        else hideCategoryPage();
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
   * @param {{feeds: Array<{path: string, mediaType?: string, kind?: string}>}} category
   */
  function newCategoryState(category) {
    return {
      activeScrollObserver: null,
      isLoading: false,
      // Whether the All | Movies | Series control governs this page.
      filtered: false,
      // Per-feed cursor: page is the last page committed (0 = page 1 still
      // owed), seen counts the raw rows the feed has answered with, failing
      // marks a feed whose last fetch failed (it is re-asked one page at a
      // time while the other feed keeps paging, e.g. Seerr down beside TMDB).
      // kind is the kind the filters are asked for (null: Trending takes none,
      // its titles are kept here by what each says of itself).
      feeds: category.feeds.map(f => ({ path: f.path, mediaType: f.mediaType || null, kind: f.kind || null, page: 0, totalPages: 0, hasMore: true, seen: 0, failing: false }))
    };
  }

  /**
   * The titles of a page the filters keep. Seerr filtered a feed that takes
   * filters already; a feed that takes none (Trending) is filtered here.
   * @param {ReturnType<typeof newCategoryState>} st
   * @param {Array} results
   * @returns {Array}
   */
  function keepOnPage(st, results) {
    if (st.feeds.every(feed => feed.kind)) return results;
    return JE.discoveryFilter.keepByFilters(FILTER_MODULE, results);
  }

  /**
   * Whether a filter is set that a feed taking none can't be checked against
   * (runtime, rating, services, keywords): nothing of it can be said to match.
   * @param {ReturnType<typeof newCategoryState>} st
   * @returns {boolean}
   */
  function uncheckable(st) {
    if (st.feeds.every(feed => feed.kind) || !JE.discoveryFilters?.checkableOnLoaded) return false;
    return !JE.discoveryFilters.checkableOnLoaded(JE.discoveryFilter.getFilters?.(FILTER_MODULE) ?? {});
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
      if (!feed.hasMore || (feed.failing && st.feeds.length > 1)) continue;
      const last = feed.totalPages ? Math.min(feed.totalPages, feed.page + count) : feed.page + count;
      for (let p = feed.page + 1; p <= last; p++) {
        fetchFeedPage(feed, p).catch(() => {});
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
      writeAddress();
      JE.discoveryFilter.applyFilterVisibility(container, newMode);
      noteIfNothing(state.categoryState, container);
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
   * @param {ReturnType<typeof newCategoryState>} st - The paging state the calling engine was armed for
   * @param {HTMLElement} container - The category's card container
   * @param {{deficitPx?: number, pageBudget?: number, engaged?: boolean}} [hint] - From the scroll engine
   * @param {() => boolean} [isStale] - True once another category (or Back) took over
   * @returns {Promise<{pages: number, rendered: number}>} Pages consumed and cards appended
   */
  async function loadMoreCategoryItems(st, container, hint, isStale) {
    st.isLoading = true;
    const pageBudget = Number.isFinite(hint?.pageBudget) ? Math.max(0, hint.pageBudget) : Infinity;
    let feeds = activeFeeds(st).filter(f => f.hasMore);
    // With less empty-page budget left than feeds, read fewer feeds so the
    // valve is reached exactly instead of this load planning zero pages
    // (which the engine takes as "no progress" and stops without the button).
    if (pageBudget >= 1 && pageBudget < feeds.length) feeds = feeds.slice(0, pageBudget);
    const cursors = feeds.map(f => f.page);
    try {
      if (feeds.length === 0) return { pages: 0, rendered: 0 };
      const wantCards = JE.seamlessScroll?.cardsNeeded?.(container, hint, 20) || 20;
      const yieldRatio = yieldStats.fetched >= 20 ? Math.min(1, Math.max(0.1, yieldStats.rendered / yieldStats.fetched)) : 0.9;
      // Pages per feed: together the feeds should cover the deficit.
      let count = Math.min(MAX_PAGES_PER_LOAD, Math.max(1, Math.ceil(wantCards / (20 * feeds.length * yieldRatio))));
      count = Math.min(count, Math.floor(pageBudget / feeds.length));
      if (count < 1) return { pages: 0, rendered: 0 }; // out of budget for now; the valve decides, not us
      const plans = feeds.map(feed => {
        const pages = [];
        const ahead = feed.failing && st.feeds.length > 1 ? 1 : count;
        const last = feed.totalPages ? Math.min(feed.totalPages, feed.page + ahead) : feed.page + ahead;
        for (let p = feed.page + 1; p <= last; p++) pages.push(p);
        return { feed, pages };
      });

      const settledPerFeed = await Promise.all(plans.map(({ feed, pages }) =>
        Promise.allSettled(pages.map(p => fetchFeedPage(feed, p)))));
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
          if (s.status !== 'fulfilled') { if (s.reason?.name === 'AbortError') throw s.reason; if (!firstError) firstError = s.reason; feed.failing = true; break; }
          feed.failing = false;
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
      const fragment = JE.discoveryFilter.createCardsFragment(keepOnPage(st, results), { cardClass: 'portraitCard' });
      yieldStats.fetched += results.length;
      const rendered = fragment.childNodes.length;
      yieldStats.rendered += rendered;
      container.appendChild(fragment);
      ensureFilterControl(st, container);
      noteIfNothing(st, container);
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
      // A filter switch re-arms the engine while a load is in flight; that
      // engine's first fill found this load running and stood down, so wake
      // it now (a no-op for the engine that is awaiting this load).
      if (!isStale?.()) queueMicrotask(() => st.fill?.());
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
    container.parentElement?.querySelector('.je-reco-filters-none')?.remove();
    const st = state.categoryState;
    yieldStats.fetched = 0;
    yieldStats.rendered = 0;
    categoryDeduplicator = JE.seamlessScroll?.createDeduplicator?.() || null;
    // A filter Trending's titles can't be checked against: nothing to ask for.
    if (uncheckable(st)) {
      st.feeds.forEach(feed => { feed.hasMore = false; });
      noteIfNothing(st, container);
      return;
    }
    // Page 1 of each feed alone first: extra requests in flight at Seerr slow
    // it down, and the engine's first fill fetches pages 2-3 the moment page 1
    // renders.
    const settled = await Promise.allSettled(st.feeds.map(feed => fetchFeedPage(feed, 1)));
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
      feed.failing = true;
      console.error(`${logPrefix} Failed to load category page 1; it will be retried`, s.reason);
      return [];
    });
    let results = mergeFeedResults(perFeed);
    if (categoryDeduplicator) results = categoryDeduplicator.filter(results);
    const fragment = JE.discoveryFilter.createCardsFragment(keepOnPage(st, results), { cardClass: 'portraitCard' });
    yieldStats.fetched += results.length;
    yieldStats.rendered += fragment.childNodes.length;
    container.appendChild(fragment);
    ensureFilterControl(st, container);
    noteIfNothing(st, container);
  }

  /**
   * When the filters leave the page nothing (every feed it reads has no more
   * pages, and no card of the type shown is on it), it says so, with the way
   * back to everything. Gone again as soon as the page reloads.
   * @param {ReturnType<typeof newCategoryState>} st
   * @param {HTMLElement} container
   */
  function noteIfNothing(st, container) {
    const page = container.parentElement;
    page?.querySelector('.je-reco-filters-none')?.remove();
    if (state.categoryState !== st || !P.isNarrowed() || activeFeeds(st).some(f => f.hasMore)) return;
    const MODES = JE.discoveryFilter.MODES;
    const mode = st.filtered ? JE.discoveryFilter.getFilterMode(FILTER_MODULE) : MODES.MIXED;
    const kind = mode === MODES.MOVIES ? '[data-media-type="movie"]' : mode === MODES.TV ? '[data-media-type="tv"]' : '';
    if (container.querySelector(`.card${kind}`)) return;
    const note = JE.discoverySection?.buildMessageRow?.({
      message: JE.t('discovery_filters_none'),
      actionLabel: JE.t('discovery_filters_clear'),
      onAction() {
        const keyed = note.contains(document.activeElement);
        P.clearFilters();
        writeAddress();
        const open = openCategory;
        if (open) showControls(open.key, open.category, container);
        reload(container);
        // (This note goes with the reload: the keys go to the Filters button.)
        if (keyed) document.querySelector('#je-recommendations-category-filters .jellyseerr-filters-btn')?.focus({ preventScroll: true });
      }
    });
    if (!note) return;
    note.classList.add('je-recommendations-empty', 'je-reco-filters-none', 'je-pad-left', 'je-pad-right');
    container.after(note);
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
      (hint) => loadMoreCategoryItems(st, container, hint, stale),
      () => activeFeeds(st).some(f => f.hasMore),
      () => st.isLoading
    );
  }

  // Stops the sticky-bar tracking (P.trackStickyBar) for the open category page.
  let stopStickyTracking = null;

  // An open category page owns one history entry, so Back (and the Android back
  // button) closes it instead of leaving the page underneath. Off Home it is a
  // copy of the current URL (the same pattern as the More Info modal): pushing a
  // URL of its own made jellyfin-web's router look for a route that does not
  // exist ("not found" flash). On Home the entry's address names the category
  // (urlMode): Home is the router's own route, so the address can carry it.
  let categoryHistoryActive = false;
  // The open category ({key, category}), and whether its address names it.
  let openCategory = null;
  let urlMode = false;
  // Bumped by every open and close: an open still resolving its category (a genre's names) gives up
  // when a newer open or a close came meanwhile.
  let openTicket = 0;
  // Our entry carries { jeCategory: true }, so a pop that lands back on it (the More Info modal
  // above the page closing) leaves the page open, and any other pop closes it. This does not
  // depend on whether the modal's own popstate listener ran first. In urlMode the address
  // leads instead (followUrl).
  window.addEventListener('popstate', (e) => {
    if (!categoryHistoryActive || urlMode || e.state?.jeCategory) return;
    categoryHistoryActive = false;
    hideCategoryPage();
  });

  /**
   * The filters and the order into the address of the page in view, where it holds them: a
   * category named by its address (with its order), or the page it opened over.
   */
  function writeAddress() {
    if (urlMode) JE.discoveryAddress?.write?.(FILTER_MODULE, SORT_MODULE, true);
    else if (P.addressHoldsFilters()) JE.discoveryAddress?.write?.(FILTER_MODULE, null, false);
  }

  /**
   * A new sort or new filters: the page starts again from page 1 as its own
   * operation (page 1 and load-mores of the previous ones must not land in the
   * new list). The type control already on the page keeps governing it.
   * @param {HTMLElement} container
   */
  function reload(container) {
    const previous = state.categoryState;
    JE.discoveryFilter.cleanupScrollObserver(previous);
    const category = openCategory?.category;
    if (!category) return;
    const next = (state.categoryState = newCategoryState(category));
    next.filtered = previous.filtered;
    const stale = () => state.categoryState !== next || !state.categoryPageVisible;
    loadInitialCategoryPage(container, stale).then(() => {
      if (stale()) return;
      armScroll(container);
    }).catch(error => console.error(`${logPrefix} Failed to reload category`, error));
  }

  /**
   * The page's controls: All | Movies | Series (Trending mixes both types from
   * the start; a studio or network page gets it once both of its feeds have
   * answered with results, or at once when the page's filters chose a type),
   * the Filters button, and the sort.
   * @param {string} categoryKey
   * @param {{title: string, feeds: Array}} category
   * @param {HTMLElement} container
   */
  function showControls(categoryKey, category, container) {
    const st = state.categoryState;
    const filter = JE.discoveryFilter;
    const filterContainer = document.getElementById('je-recommendations-category-filter');
    filterContainer.textContent = '';
    const typed = st.feeds.filter(f => f.mediaType).length >= 2;
    if (categoryKey === 'trending' || st.filtered || (typed && filter.getFilterMode(FILTER_MODULE) !== filter.MODES.MIXED)) {
      st.filtered = true;
      filterContainer.appendChild(createFilterControl(container));
    }
    filter.applyFilterVisibility(container, st.filtered ? filter.getFilterMode(FILTER_MODULE) : filter.MODES.MIXED);

    // The page's further filters (the "More from" sections' button and menu). A feed that takes none
    // (Trending) offers the ones its titles can be checked against; a genre's page has its genre given.
    const filtersContainer = document.getElementById('je-recommendations-category-filters');
    const header = document.getElementById('je-recommendations-category-header');
    const scope = st.feeds.some(f => !f.kind) ? 'loaded' : 'feed';
    const button = filter.createFiltersButton?.(header, FILTER_MODULE, scope, () => { writeAddress(); reload(container); }, {
      place: () => document.querySelector('#je-recommendations-category-page .content-primary'),
      ...(categoryKey.startsWith('genre-') ? { ownGenre: category.title } : {})
    });
    filtersContainer.replaceChildren(...(button ? [button] : []));

    const sortContainer = document.getElementById('je-recommendations-category-sort');
    sortContainer.textContent = '';
    sortContainer.appendChild(filter.createSortControl(SORT_MODULE, () => { writeAddress(); reload(container); }));
  }

  /**
   * The category for a key. A genre's page opened by its address (a link, a
   * reload) waits for the genre names it needs.
   * @param {string} categoryKey
   * @returns {Promise<object|null>}
   */
  async function resolve(categoryKey) {
    const found = resolveCategory(categoryKey);
    const genre = /^genre-(movie|tv)-\d+$/.exec(categoryKey)?.[1];
    if (found || !genre) return found;
    const list = await P.fetchGenreSlider(genre);
    if (!list?.length) return null;
    if (genre === 'movie') P.MOVIE_GENRES = list; else P.TV_GENRES = list;
    return resolveCategory(categoryKey);
  }

  /**
   * Marks the page's history entry. On Home its address names the category
   * (with the filters and the order): opened by its address (a link, Back,
   * Forward) the entry is marked as it is, otherwise one is added. Elsewhere a
   * same-URL entry is added, as before.
   * @param {string} categoryKey
   * @param {boolean} fromUrl
   */
  function markHistory(categoryKey, fromUrl) {
    const address = JE.discoveryAddress;
    urlMode = !!address?.isHomeHash(window.location.hash);
    if (urlMode) {
      const target = address.addressWith(window.location.hash, categoryKey,
        address.current(FILTER_MODULE, SORT_MODULE), true);
      categoryHistoryActive = false;
      if (fromUrl || window.location.hash === target) {
        if (window.location.hash !== target || !history.state?.jeCategory) {
          address.go(target, { state: { ...(history.state || {}), jeCategory: true } });
        }
        return;
      }
      address.go(target, { push: true, state: { jeCategory: true, [BACK_KEY]: true } });
      return;
    }
    if (!categoryHistoryActive) {
      history.pushState({ jeCategory: true }, '', location.href);
      categoryHistoryActive = true;
    }
  }

  /**
   * Opens a category page.
   * @param {string} categoryKey
   * @param {boolean} [fromUrl=false] - Opened by its address (a link, a reload, Back, Forward), which names it
   */
  async function showCategoryPage(categoryKey, fromUrl = false) {
    const ticket = ++openTicket;
    // Which page this is (the filters may change meanwhile; the page may not).
    const pageOf = () => JE.discoveryAddress?.withoutOwn?.(window.location.hash) ?? window.location.hash;
    const from = pageOf();
    const category = await resolve(categoryKey);
    // Another open, a close or a navigation came while it resolved: this one is no longer wanted.
    if (!category || ticket !== openTicket || pageOf() !== from) return;

    const config = JE.pluginConfig || {};
    if (!config.RecommendationsPageEnabled) return;

    // Opened by its address: that says what the filters and the order are.
    if (fromUrl) JE.discoveryAddress?.adopt?.(FILTER_MODULE, SORT_MODULE, { withSort: true });

    if (state.pageVisible) hidePage();

    // Disconnect the previous category's scroll observer before replacing
    // categoryState wholesale - otherwise it leaks (nothing else references it).
    JE.discoveryFilter.cleanupScrollObserver(state.categoryState);
    state.categoryPageVisible = true;
    openCategory = { key: categoryKey, category };
    // Back pressed (or another category opened) before page 1 lands must not
    // install an engine on a page nobody is looking at: every step checks
    // this state is still the installed one.
    const st = (state.categoryState = newCategoryState(category));
    const stale = () => state.categoryState !== st || !state.categoryPageVisible;

    const page = createCategoryPageContainer();
    document.getElementById('je-recommendations-category-title').textContent = category.title;

    const container = document.getElementById('je-recommendations-category-container');
    showControls(categoryKey, category, container);

    markHistory(categoryKey, fromUrl);

    const activePage = document.querySelector(".mainAnimatedPage:not(.hide):not(#je-recommendations-category-page)");
    if (activePage) {
      state.categoryPreviousPage = activePage;
      activePage.classList.add("hide");
      activePage.dispatchEvent(new CustomEvent("viewhide", { bubbles: true, detail: { type: "interior" } }));
    }

    page.classList.remove("hide");
    page.dispatchEvent(new CustomEvent("viewshow", { bubbles: true, detail: { type: "custom", isRestored: false, options: {} } }));
    page.dispatchEvent(new CustomEvent("pageshow", { bubbles: true, detail: {} }));
    if (stopStickyTracking) stopStickyTracking();
    stopStickyTracking = P.trackStickyBar(document.getElementById('je-recommendations-category-header'));

    await loadInitialCategoryPage(container, stale);
    if (stale()) return;

    armScroll(container);
  }

  function hideCategoryPage() {
    openTicket++;
    if (!state.categoryPageVisible) return;

    JE.discoveryFilter.cleanupScrollObserver(state.categoryState);
    if (stopStickyTracking) {
      stopStickyTracking();
      stopStickyTracking = null;
    }

    const page = document.getElementById("je-recommendations-category-page");
    JE.jellyseerrUI?.releasePosters?.(page || undefined);
    page?.querySelector('.je-reco-filters-none')?.remove();
    if (page) {
      page.classList.add("hide");
      page.dispatchEvent(new CustomEvent("viewhide", { bubbles: true, detail: { type: "custom" } }));
    }

    if (state.categoryPreviousPage && !document.querySelector(".mainAnimatedPage:not(.hide):not(#je-recommendations-page):not(#je-recommendations-category-page)")) {
      state.categoryPreviousPage.classList.remove("hide");
      // (jeRestored: this page coming back is not the router showing it, which would follow its address.)
      state.categoryPreviousPage.dispatchEvent(new CustomEvent("viewshow", { bubbles: true, detail: { type: "interior", isRestored: true, jeRestored: true } }));
    }

    state.categoryPageVisible = false;
    state.categoryPreviousPage = null;
    // Closed by navigating away: the entry stays in history but is no longer ours to pop.
    categoryHistoryActive = false;
    openCategory = null;
    urlMode = false;
    // The filters are the page's too: a page still on screen shows what was set here.
    P.syncFilters?.();
  }

  /** Whether the Home page is the one showing (a category named by its address opens over it). */
  const homeShowing = () => !!document.querySelector('#indexPage:not(.hide)');

  /**
   * Opens the category an address names.
   * @param {string} key
   */
  function openFromUrl(key) {
    showCategoryPage(key, true).catch(error => console.error(`${logPrefix} Failed to open category`, error));
  }

  /**
   * Follows the address after a navigation, as far as it is a category's on
   * Home: true when it did. A category page its address named goes when the
   * address no longer does (Back to the tab) and gives way to another one named
   * (Back and Forward between categories); one named while Home shows opens over it.
   * @returns {boolean}
   */
  function followUrl() {
    const address = JE.discoveryAddress;
    if (!address) return false;
    const wanted = address.isHomeHash(window.location.hash) ? address.categoryOfHash(window.location.hash) : null;
    if (state.categoryPageVisible && urlMode) {
      // The same page at other filters (a pasted link): it shows them.
      if (wanted === openCategory?.key) {
        if (address.adopt(FILTER_MODULE, SORT_MODULE, { withSort: true })) openFromUrl(wanted);
        return true;
      }
      if (wanted) { openFromUrl(wanted); return true; }
      if (!address.isHomeHash(window.location.hash)) return false;
      // Back to the tab: at the filters its own entry has.
      address.adopt(FILTER_MODULE, null, { withSort: false });
      hideCategoryPage();
      return true;
    }
    if (!wanted || state.categoryPageVisible || !homeShowing()) {
      // The page in view at an address whose filters are other ones (Back, Forward, a pasted link): it shows them.
      if (!state.categoryPageVisible && address.isRecommendationsHash(window.location.hash)
        && address.adopt(FILTER_MODULE, null, { withSort: false })) P.syncFilters?.();
      return false;
    }
    openFromUrl(wanted);
    return true;
  }

  P.createCategoryPageContainer = createCategoryPageContainer;
  P.loadMoreCategoryItems = loadMoreCategoryItems;
  P.showCategoryPage = showCategoryPage;
  P.hideCategoryPage = hideCategoryPage;
  P.followUrl = followUrl;
})();
