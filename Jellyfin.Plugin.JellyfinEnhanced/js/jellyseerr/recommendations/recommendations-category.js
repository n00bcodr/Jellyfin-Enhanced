(() => {
"use strict";
(() => {
  // client/src/host/context.ts
  function featureContext(feature, core, slots) {
    const shared = core.core?.featureContext;
    if (typeof shared !== "function") {
      throw new Error(`${feature}: JE.core.featureContext is missing; core/ui-kit.js must load before feature scripts`);
    }
    return shared(feature, core, slots);
  }

  // client/src/features/seerr/host-discovery.ts
  function discoveryHost() {
    const host = window;
    const JE = host.JellyfinEnhanced ?? (host.JellyfinEnhanced = {});
    return { JE, api: () => host.ApiClient };
  }
  var discoveryContexts = /* @__PURE__ */ new WeakMap();
  function discoveryContext(JE) {
    let ctx = discoveryContexts.get(JE);
    if (!ctx) {
      ctx = featureContext("seerr", JE, {
        internalSlots: ["recommendationsPage"],
        internalsObject: () => JE.internals ?? (JE.internals = {})
      });
      discoveryContexts.set(JE, ctx);
    }
    return ctx;
  }
  function filterOf(JE) {
    if (!JE.discoveryFilter) throw new Error("Discovery filter utilities are not loaded");
    return JE.discoveryFilter;
  }
  function translate(JE, key, params) {
    return JE.t?.(key, params) ?? key;
  }
  function bindToSession(JE, controller) {
    const lease = JE.session?.createLease?.();
    if (!lease) return;
    if (lease.signal.aborted) {
      controller.abort();
      return;
    }
    lease.signal.addEventListener("abort", () => controller.abort(), { once: true, signal: controller.signal });
  }

  // client/src/features/seerr/discovery/domain.ts
  var TMDB_MAX_PAGE = 500;
  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function isAbortError(error) {
    return isRecord(error) && error.name === "AbortError";
  }
  var text = (value) => typeof value === "string" ? value : "";
  var dateOf = (item) => text(item.releaseDate) || text(item.firstAirDate);
  var ratingOf = (item) => Number(item.jeSortRating) || Number(item.voteAverage) || 0;
  var votesOf = (item) => Number(item.jeSortVotes || item.voteCount) || 0;
  function sortResults(results, sortBy) {
    if (!sortBy) return results;
    const sorted = [...results];
    if (sortBy === "vote_average.desc") {
      sorted.sort((a, b) => ratingOf(b) - ratingOf(a));
    } else if (sortBy === "vote_count.desc") {
      sorted.sort((a, b) => votesOf(b) - votesOf(a));
    } else if (sortBy === "release_date.desc") {
      sorted.sort((a, b) => dateOf(b).localeCompare(dateOf(a)));
    } else if (sortBy === "release_date.asc") {
      sorted.sort((a, b) => dateOf(a).localeCompare(dateOf(b)));
    }
    return sorted;
  }
  function clampPages(totalPages) {
    return Math.min(Number(totalPages) || 1, TMDB_MAX_PAGE);
  }
  function estimateYield(stats, cold, floor) {
    if (stats.fetched < 20) return cold;
    return Math.min(1, Math.max(floor, stats.rendered / stats.fetched));
  }
  var resultKey = (item) => `${String(item.mediaType)}-${String(item.id)}`;
  function unseenResults(results, shown) {
    const batch = /* @__PURE__ */ new Set();
    return results.filter((item) => {
      const key = resultKey(item);
      if (shown.has(key) || batch.has(key)) return false;
      batch.add(key);
      return true;
    });
  }

  // client/src/features/seerr/recommendations/stage.ts
  var LOG_PREFIX = "🪼 Jellyfin Enhanced: Recommendations:";
  var PAGE_ID = "je-recommendations-page";
  var CATEGORY_PAGE_ID = "je-recommendations-category-page";
  var SORT_MODULE = "recommendationsCategory";
  var FILTER_MODULE = "recommendations";
  var OTHER_PAGE = `.mainAnimatedPage:not(.hide):not(#${PAGE_ID}):not(#${CATEGORY_PAGE_ID})`;
  function recommendationsHost() {
    const { JE } = discoveryHost();
    const own = discoveryContext(JE).own;
    return { JE, P: own.recommendationsPage ?? (own.recommendationsPage = {}) };
  }
  function part(P, key) {
    const value = P[key];
    if (value === void 0 || value === null) throw new Error(`Recommendations module "${key}" is not loaded`);
    return value;
  }

  // client/src/features/seerr/recommendations/recommendations-category.ts
  var SCROLL_ROOT = `#${CATEGORY_PAGE_ID} .content-primary`;
  var BACK_KEY = "jeCategoryBack";
  var MAX_PAGES_PER_LOAD = 4;
  var CATEGORY_YIELD_COLD = 0.9;
  var CATEGORY_YIELD_FLOOR = 0.1;
  var FEED_PAGE_SIZE = 20;
  var PAGE_MARKUP = `
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
  var mergeFeedResults = (perFeed, interleave) => {
    const [first = [], second] = perFeed;
    return second ? interleave(first, second) : first;
  };
  var nextPages = (feed, ahead) => {
    const last = feed.totalPages ? Math.min(feed.totalPages, feed.page + ahead) : feed.page + ahead;
    const pages = [];
    for (let page = feed.page + 1; page <= last; page++) pages.push(page);
    return pages;
  };
  (function() {
    "use strict";
    const { JE, P } = recommendationsHost();
    const state = () => part(P, "state");
    const filter = () => filterOf(JE);
    let stopStickyTracking = null;
    function newCategoryState(category) {
      const controller = new AbortController();
      bindToSession(JE, controller);
      return {
        activeScrollObserver: null,
        isLoading: false,
        // Whether the All | Movies | Series control governs this page.
        filtered: false,
        // kind: the kind the filters are asked for (null: Trending takes none, its titles are kept here by what each says of itself).
        feeds: category.feeds.map((feed) => ({
          path: feed.path,
          mediaType: feed.mediaType ?? null,
          kind: feed.kind ?? null,
          page: 0,
          totalPages: 0,
          hasMore: true,
          seen: 0,
          failing: false
        })),
        controller,
        yieldStats: { fetched: 0, rendered: 0 },
        shown: /* @__PURE__ */ new Set()
      };
    }
    function retire(st) {
      st.controller?.abort();
      filter().cleanupScrollObserver(st);
    }
    const fetchPage = (st, feed, page) => part(P, "feedPage")(feed.path, feed.kind, page, st.controller ? { signal: st.controller.signal } : {});
    const keepOnPage = (st, results) => st.feeds.every((feed) => feed.kind) ? results : filter().keepByFilters(FILTER_MODULE, results);
    function uncheckable(st) {
      if (st.feeds.every((feed) => feed.kind) || !JE.discoveryFilters?.checkableOnLoaded) return false;
      return !JE.discoveryFilters.checkableOnLoaded(filter().getFilters(FILTER_MODULE));
    }
    function activeFeeds(st) {
      if (!st.filtered) return st.feeds;
      const mode = filter().getFilterMode(FILTER_MODULE);
      const { MIXED, MOVIES } = filter().MODES;
      return st.feeds.filter((feed) => !feed.mediaType || mode === MIXED || (mode === MOVIES ? feed.mediaType === "movie" : feed.mediaType === "tv"));
    }
    function prefetchCategoryPages(st, count) {
      for (const feed of activeFeeds(st)) {
        if (!feed.hasMore || feed.failing && st.feeds.length > 1) continue;
        for (const page of nextPages(feed, count)) {
          fetchPage(st, feed, page).catch(() => {
          });
        }
      }
    }
    function commitPage(feed, pageNumber, page) {
      console.debug(`${LOG_PREFIX} category page ${pageNumber}/${page.totalPages}: ${page.results.length} raw result(s)`);
      feed.page = pageNumber;
      feed.totalPages = page.totalPages ? clampPages(page.totalPages) : feed.totalPages || 1;
      feed.hasMore = pageNumber < feed.totalPages;
      feed.seen += page.results.length;
      return sortResults(page.results, filter().getSortMode(SORT_MODULE));
    }
    const interleave = (a, b) => filter().interleaveArrays(a, b);
    function renderBatch(st, container, batch) {
      const results = unseenResults(batch, st.shown);
      const fragment = filter().createCardsFragment(keepOnPage(st, results), { cardClass: "portraitCard" });
      for (const item of results) st.shown.add(resultKey(item));
      const rendered = fragment.childNodes.length;
      st.yieldStats.fetched += results.length;
      st.yieldStats.rendered += rendered;
      container.appendChild(fragment);
      ensureFilterControl(st, container);
      noteIfNothing(st, container);
      return rendered;
    }
    function createFilterControl(container) {
      return filter().createFilterControl(FILTER_MODULE, (mode) => {
        writeAddress();
        filter().applyFilterVisibility(container, mode);
        noteIfNothing(state().categoryState, container);
        armScroll(container);
      });
    }
    function noteIfNothing(st, container) {
      const page = container.parentElement;
      page?.querySelector(".je-reco-filters-none")?.remove();
      if (state().categoryState !== st || !part(P, "isNarrowed")() || activeFeeds(st).some((feed) => feed.hasMore)) return;
      const { MODES } = filter();
      const mode = st.filtered ? filter().getFilterMode(FILTER_MODULE) : MODES.MIXED;
      const kind = mode === MODES.MOVIES ? '[data-media-type="movie"]' : mode === MODES.TV ? '[data-media-type="tv"]' : "";
      if (container.querySelector(`.card${kind}`)) return;
      const note = JE.discoverySection?.buildMessageRow?.({
        message: translate(JE, "discovery_filters_none"),
        actionLabel: translate(JE, "discovery_filters_clear"),
        onAction() {
          const keyed = note?.contains(document.activeElement) ?? false;
          part(P, "clearFilters")();
          writeAddress();
          if (openCategory) showControls(openCategory.key, openCategory.category, container);
          reload(container);
          if (keyed) document.querySelector("#je-recommendations-category-filters .jellyseerr-filters-btn")?.focus({ preventScroll: true });
        }
      });
      if (!note) return;
      note.classList.add("je-recommendations-empty", "je-reco-filters-none", "je-pad-left", "je-pad-right");
      container.after(note);
    }
    function ensureFilterControl(st, container) {
      if (st.filtered || st.feeds.length < 2 || !st.feeds.every((feed) => feed.seen > 0)) return;
      const slot = document.getElementById("je-recommendations-category-filter");
      if (!slot) return;
      st.filtered = true;
      slot.replaceChildren(createFilterControl(container));
      filter().applyFilterVisibility(container, filter().getFilterMode(FILTER_MODULE));
    }
    async function loadMoreCategoryItems(st, container, hint, isStale) {
      st.isLoading = true;
      const budget = hint?.pageBudget;
      const pageBudget = budget !== void 0 && Number.isFinite(budget) ? Math.max(0, budget) : Infinity;
      let feeds = activeFeeds(st).filter((feed) => feed.hasMore);
      if (pageBudget >= 1 && pageBudget < feeds.length) feeds = feeds.slice(0, pageBudget);
      const cursors = feeds.map((feed) => ({
        feed,
        restore: { page: feed.page, totalPages: feed.totalPages, hasMore: feed.hasMore, seen: feed.seen }
      }));
      try {
        if (feeds.length === 0) return { pages: 0, rendered: 0 };
        const wantCards = JE.seamlessScroll?.cardsNeeded?.(container, hint, FEED_PAGE_SIZE) || FEED_PAGE_SIZE;
        const yieldRatio = estimateYield(st.yieldStats, CATEGORY_YIELD_COLD, CATEGORY_YIELD_FLOOR);
        let count = Math.min(MAX_PAGES_PER_LOAD, Math.max(1, Math.ceil(wantCards / (FEED_PAGE_SIZE * feeds.length * yieldRatio))));
        count = Math.min(count, Math.floor(pageBudget / feeds.length));
        if (count < 1) return { pages: 0, rendered: 0 };
        const plans = feeds.map((feed) => ({ feed, pages: nextPages(feed, feed.failing && st.feeds.length > 1 ? 1 : count) }));
        const settled = await Promise.all(plans.map(({ feed, pages }) => Promise.allSettled(pages.map((page) => fetchPage(st, feed, page)))));
        if (isStale?.()) return { pages: 0, rendered: 0 };
        const perFeed = [];
        const failures = [];
        let committed = 0;
        for (const [index, { feed, pages }] of plans.entries()) {
          const rows = [];
          for (const [position, outcome] of (settled[index] ?? []).entries()) {
            if (outcome.status !== "fulfilled") {
              if (isAbortError(outcome.reason)) throw outcome.reason;
              failures.push(outcome.reason);
              feed.failing = true;
              break;
            }
            feed.failing = false;
            rows.push(...commitPage(feed, pages[position] ?? feed.page + 1, outcome.value));
            committed++;
          }
          perFeed.push(rows);
        }
        if (failures.length > 0 && committed === 0) throw failures[0];
        const rendered = renderBatch(st, container, mergeFeedResults(perFeed, interleave));
        const pagesFetched = plans.reduce((total, plan) => total + plan.pages.length, 0);
        const remainingBudget = pageBudget === Infinity ? Infinity : Math.max(0, pageBudget - pagesFetched);
        const prefetch = rendered > 0 ? count : Math.min(count, Math.floor(remainingBudget / feeds.length));
        if (prefetch > 0) prefetchCategoryPages(st, prefetch);
        return { pages: committed, rendered };
      } catch (error) {
        cursors.forEach(({ feed, restore }) => {
          Object.assign(feed, restore);
        });
        throw error;
      } finally {
        st.isLoading = false;
        if (!isStale?.()) queueMicrotask(() => st.fill?.());
      }
    }
    async function loadInitialCategoryPage(st, container, isStale) {
      JE.jellyseerrUI?.releasePosters?.(container);
      container.replaceChildren();
      container.parentElement?.querySelector(".je-reco-filters-none")?.remove();
      if (uncheckable(st)) {
        st.feeds.forEach((feed) => {
          feed.hasMore = false;
        });
        noteIfNothing(st, container);
        return;
      }
      const settled = await Promise.allSettled(st.feeds.map((feed) => fetchPage(st, feed, 1)));
      if (isStale()) return;
      const perFeed = st.feeds.map((feed, index) => {
        const outcome = settled[index];
        if (outcome?.status === "fulfilled") return commitPage(feed, 1, outcome.value);
        feed.page = 0;
        feed.hasMore = true;
        feed.failing = true;
        console.error(`${LOG_PREFIX} Failed to load category page 1; it will be retried`, outcome?.reason);
        return [];
      });
      renderBatch(st, container, mergeFeedResults(perFeed, interleave));
    }
    function armScroll(container) {
      const st = state().categoryState;
      const stale = () => state().categoryState !== st || !state().categoryPageVisible;
      filter().cleanupScrollObserver(st);
      filter().setupInfiniteScroll(
        st,
        SCROLL_ROOT,
        (hint) => loadMoreCategoryItems(st, container, hint, stale),
        () => activeFeeds(st).some((feed) => feed.hasMore),
        () => st.isLoading
      );
    }
    function createCategoryPageContainer() {
      const existing = document.getElementById(CATEGORY_PAGE_ID);
      if (existing) return existing;
      const page = document.createElement("div");
      page.id = CATEGORY_PAGE_ID;
      page.className = "page type-interior mainAnimatedPage hide";
      page.setAttribute("data-title", translate(JE, "recommendations_title"));
      page.setAttribute("data-backbutton", "true");
      page.setAttribute("data-type", "custom");
      page.innerHTML = PAGE_MARKUP;
      page.querySelector("#je-recommendations-category-back")?.addEventListener("click", () => {
        const address = JE.discoveryAddress;
        if (urlMode && isRecord(history.state) && history.state[BACK_KEY] === true) history.back();
        else if (urlMode && address) {
          address.go(address.addressWith(window.location.hash, null, address.current(FILTER_MODULE, null), false));
          hideCategoryPage();
        } else if (historyEntryActive) history.back();
        else closeCategoryPage();
      });
      (document.querySelector(".mainAnimatedPages") ?? document.body).appendChild(page);
      return page;
    }
    function closeCategoryPage() {
      const returnToPage = state().categoryReturnsToPage && part(P, "isPageHash")(window.location.hash);
      hideCategoryPage();
      if (returnToPage) part(P, "showPage")();
    }
    let historyEntryActive = false;
    let openCategory = null;
    let urlMode = false;
    let openTicket = 0;
    const isOwnEntry = (entry) => isRecord(entry) && entry.jeCategory === true;
    function onHistoryPop(event) {
      if (!historyEntryActive || urlMode || isOwnEntry(event.state)) return;
      releaseHistoryEntry();
      closeCategoryPage();
    }
    function releaseHistoryEntry() {
      historyEntryActive = false;
      window.removeEventListener("popstate", onHistoryPop);
    }
    function writeAddress() {
      if (urlMode) JE.discoveryAddress?.write(FILTER_MODULE, SORT_MODULE, true);
      else if (part(P, "addressHoldsFilters")()) JE.discoveryAddress?.write(FILTER_MODULE, null, false);
    }
    function reload(container) {
      const pageState = state();
      const category = openCategory?.category;
      if (!category) return;
      const previous = pageState.categoryState;
      retire(previous);
      const next = pageState.categoryState = newCategoryState(category);
      next.filtered = previous.filtered;
      const stale = () => pageState.categoryState !== next || !pageState.categoryPageVisible;
      loadInitialCategoryPage(next, container, stale).then(() => {
        if (!stale()) armScroll(container);
      }).catch((error) => console.error(`${LOG_PREFIX} Failed to reload category`, error));
    }
    function showControls(categoryKey, category, container) {
      const st = state().categoryState;
      const facade = filter();
      const filterSlot = document.getElementById("je-recommendations-category-filter");
      const filtersSlot = document.getElementById("je-recommendations-category-filters");
      const sortSlot = document.getElementById("je-recommendations-category-sort");
      const header = document.getElementById("je-recommendations-category-header");
      if (!filterSlot || !filtersSlot || !sortSlot || !header) return;
      filterSlot.replaceChildren();
      const typed = st.feeds.filter((feed) => feed.mediaType).length >= 2;
      if (categoryKey === "trending" || st.filtered || typed && facade.getFilterMode(FILTER_MODULE) !== facade.MODES.MIXED) {
        st.filtered = true;
        filterSlot.appendChild(createFilterControl(container));
      }
      facade.applyFilterVisibility(container, st.filtered ? facade.getFilterMode(FILTER_MODULE) : facade.MODES.MIXED);
      const kinds = [...new Set(st.feeds.map((feed) => feed.kind).filter(Boolean))];
      if (kinds.length > 0) header.setAttribute("data-je-kinds", kinds.join(","));
      else header.removeAttribute("data-je-kinds");
      const scope = st.feeds.some((feed) => !feed.kind) ? "loaded" : "feed";
      const address = JE.discoveryAddress;
      const profiles = address ? {
        read: () => address.filterPairs(address.current(FILTER_MODULE, SORT_MODULE), true).join("&"),
        apply(filters) {
          const wanted = address.filtersOf(filters, scope);
          facade.setFilterMode(FILTER_MODULE, wanted.mode);
          if (wanted.sort) facade.setSortMode(SORT_MODULE, wanted.sort);
          else facade.resetSortMode(SORT_MODULE);
          facade.setFilters(FILTER_MODULE, wanted.selection);
          showControls(categoryKey, category, container);
          writeAddress();
          reload(container);
        }
      } : void 0;
      const button = facade.createFiltersButton(header, FILTER_MODULE, scope, () => {
        writeAddress();
        reload(container);
      }, {
        place: () => document.querySelector(`#${CATEGORY_PAGE_ID} .content-primary`),
        ...categoryKey.startsWith("genre-") ? { ownGenre: category.title } : {},
        ...profiles ? { profiles } : {}
      });
      filtersSlot.replaceChildren(...button ? [button] : []);
      sortSlot.replaceChildren(facade.createSortControl(SORT_MODULE, () => {
        writeAddress();
        reload(container);
      }));
    }
    async function resolve(categoryKey) {
      const found = part(P, "resolveCategory")(categoryKey);
      const genre = /^genre-(movie|tv)-\d+$/.exec(categoryKey)?.[1];
      if (found || genre !== "movie" && genre !== "tv") return found;
      const list = await part(P, "fetchGenreSlider")(genre);
      if (!list.length) return null;
      if (genre === "movie") P.MOVIE_GENRES = list;
      else P.TV_GENRES = list;
      return part(P, "resolveCategory")(categoryKey);
    }
    function markHistory(categoryKey, fromUrl) {
      const address = JE.discoveryAddress;
      urlMode = !!address?.isHomeHash(window.location.hash);
      if (address && urlMode) {
        const target = address.addressWith(window.location.hash, categoryKey, address.current(FILTER_MODULE, SORT_MODULE), true);
        releaseHistoryEntry();
        if (fromUrl || window.location.hash === target) {
          if (window.location.hash !== target || !isOwnEntry(history.state)) {
            address.go(target, { state: { ...isRecord(history.state) ? history.state : {}, jeCategory: true } });
          }
          return;
        }
        address.go(target, { push: true, state: { jeCategory: true, [BACK_KEY]: true } });
        return;
      }
      if (!historyEntryActive) {
        history.pushState({ jeCategory: true }, "", window.location.href);
        historyEntryActive = true;
        window.addEventListener("popstate", onHistoryPop);
      }
    }
    async function showCategoryPage(categoryKey, fromUrl = false) {
      const ticket = ++openTicket;
      const pageOf = () => JE.discoveryAddress?.withoutOwn(window.location.hash) ?? window.location.hash;
      const from = pageOf();
      const category = await resolve(categoryKey);
      if (!category || ticket !== openTicket || pageOf() !== from) return;
      if (fromUrl && JE.discoveryAddress?.categoryOfHash(window.location.hash) !== categoryKey) return;
      if (!JE.pluginConfig?.RecommendationsPageEnabled) return;
      if (fromUrl) JE.discoveryAddress?.adopt(FILTER_MODULE, SORT_MODULE, { withSort: true });
      const pageState = state();
      const fromPage = pageState.pageVisible;
      if (fromPage) part(P, "hidePage")();
      retire(pageState.categoryState);
      pageState.categoryPageVisible = true;
      pageState.categoryReturnsToPage = fromPage || pageState.categoryReturnsToPage;
      openCategory = { key: categoryKey, category };
      const st = pageState.categoryState = newCategoryState(category);
      const stale = () => pageState.categoryState !== st || !pageState.categoryPageVisible;
      const page = createCategoryPageContainer();
      const title = document.getElementById("je-recommendations-category-title");
      const container = document.getElementById("je-recommendations-category-container");
      if (!title || !container) return;
      title.textContent = category.title;
      showControls(categoryKey, category, container);
      markHistory(categoryKey, fromUrl);
      const activePage = document.querySelector(`.mainAnimatedPage:not(.hide):not(#${CATEGORY_PAGE_ID})`);
      if (activePage) {
        pageState.categoryPreviousPage = activePage;
        activePage.classList.add("hide");
        activePage.dispatchEvent(new CustomEvent("viewhide", { bubbles: true, detail: { type: "interior" } }));
      }
      page.classList.remove("hide");
      page.dispatchEvent(new CustomEvent("viewshow", { bubbles: true, detail: { type: "custom", isRestored: false, options: {} } }));
      page.dispatchEvent(new CustomEvent("pageshow", { bubbles: true, detail: {} }));
      stopStickyTracking?.();
      const header = document.getElementById("je-recommendations-category-header");
      stopStickyTracking = header ? part(P, "trackStickyBar")(header) : null;
      await loadInitialCategoryPage(st, container, stale);
      if (!stale()) armScroll(container);
    }
    function hideCategoryPage() {
      openTicket++;
      const pageState = state();
      if (!pageState.categoryPageVisible) return;
      pageState.categoryPageVisible = false;
      pageState.categoryReturnsToPage = false;
      releaseHistoryEntry();
      retire(pageState.categoryState);
      stopStickyTracking?.();
      stopStickyTracking = null;
      const page = document.getElementById(CATEGORY_PAGE_ID);
      JE.jellyseerrUI?.releasePosters?.(page ?? void 0);
      document.getElementById("je-recommendations-category-container")?.replaceChildren();
      page?.querySelector(".je-reco-filters-none")?.remove();
      if (page) {
        page.classList.add("hide");
        page.dispatchEvent(new CustomEvent("viewhide", { bubbles: true, detail: { type: "custom" } }));
      }
      const previous = pageState.categoryPreviousPage;
      pageState.categoryPreviousPage = null;
      if (previous && !document.querySelector(OTHER_PAGE)) {
        previous.classList.remove("hide");
        previous.dispatchEvent(new CustomEvent("viewshow", { bubbles: true, detail: { type: "interior", isRestored: true, jeRestored: true } }));
      }
      openCategory = null;
      urlMode = false;
      P.syncFilters?.();
    }
    const homeShowing = () => !!document.querySelector("#indexPage:not(.hide)");
    function openFromUrl(key) {
      showCategoryPage(key, true).catch((error) => console.error(`${LOG_PREFIX} Failed to open category`, error));
    }
    function followUrl() {
      const address = JE.discoveryAddress;
      if (!address) return false;
      const hash = window.location.hash;
      const wanted = address.isHomeHash(hash) ? address.categoryOfHash(hash) : null;
      if (state().categoryPageVisible && urlMode) {
        if (wanted === openCategory?.key) {
          if (address.adopt(FILTER_MODULE, SORT_MODULE, { withSort: true })) openFromUrl(wanted);
          return true;
        }
        if (wanted) {
          openFromUrl(wanted);
          return true;
        }
        if (!address.isHomeHash(hash)) return false;
        address.adopt(FILTER_MODULE, null, { withSort: false });
        hideCategoryPage();
        return true;
      }
      if (!wanted || state().categoryPageVisible || !homeShowing()) {
        if (!state().categoryPageVisible && address.isRecommendationsHash(hash) && address.adopt(FILTER_MODULE, null, { withSort: false })) P.syncFilters?.();
        return false;
      }
      openFromUrl(wanted);
      return true;
    }
    P.createCategoryPageContainer = createCategoryPageContainer;
    P.loadMoreCategoryItems = loadMoreCategoryItems;
    P.showCategoryPage = showCategoryPage;
    P.hideCategoryPage = hideCategoryPage;
    P.categoryOnOwnEntry = () => historyEntryActive && isOwnEntry(history.state);
    P.followUrl = followUrl;
  })();
})();
})();
//# sourceMappingURL=recommendations-category.js.map
