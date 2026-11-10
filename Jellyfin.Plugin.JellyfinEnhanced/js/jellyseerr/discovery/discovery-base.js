(() => {
"use strict";
(() => {
  // client/src/features/seerr/host-discovery.ts
  function discoveryHost() {
    const host = window;
    const JE = host.JellyfinEnhanced ?? (host.JellyfinEnhanced = {});
    return { JE, api: () => host.ApiClient };
  }
  function filterOf(JE) {
    if (!JE.discoveryFilter) throw new Error("Discovery filter utilities are not loaded");
    return JE.discoveryFilter;
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
  var FEED_PAGE_SIZE = 20;
  var MAX_PAGES_PER_FEED = 4;
  var MAX_PAGES_PER_FEED_ESCALATED = 8;
  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function isSeerrResult(value) {
    return isRecord(value);
  }
  function isAbortError(error) {
    return isRecord(error) && error.name === "AbortError";
  }
  function abortError(message = "Aborted") {
    const error = new Error(message);
    error.name = "AbortError";
    return error;
  }
  function throwIfAborted(signal) {
    if (signal?.aborted) throw abortError();
  }
  function decodeError(what) {
    const error = new Error(`Unexpected ${what} response`);
    error.name = "DecodeError";
    return error;
  }
  var text = (value) => typeof value === "string" ? value : "";
  var dateOf = (item) => text(item.releaseDate) || text(item.firstAirDate);
  var ratingOf = (item) => Number(item.jeSortRating) || Number(item.voteAverage) || 0;
  function sortResults(results, sortBy) {
    if (!sortBy) return results;
    const sorted = [...results];
    if (sortBy === "vote_average.desc") {
      sorted.sort((a, b) => ratingOf(b) - ratingOf(a));
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
  function pageRange(start, count, total) {
    const pages = [];
    for (let page = start; page < start + count && page <= total; page++) pages.push(page);
    return pages;
  }
  function estimateYield(stats, cold, floor) {
    if (stats.fetched < 20) return cold;
    return Math.min(1, Math.max(floor, stats.rendered / stats.fetched));
  }
  function planPagesPerFeed(input) {
    const { wantCards, feedCount, yieldRatio, lastBatchRendered, lastBatchPages, pageBudget } = input;
    const expectedPerPage = Math.max(1, FEED_PAGE_SIZE * feedCount * yieldRatio);
    let pages = Math.min(MAX_PAGES_PER_FEED, Math.max(1, Math.ceil(wantCards / expectedPerPage)));
    if (lastBatchRendered === 0 && lastBatchPages > 0) {
      pages = Math.min(MAX_PAGES_PER_FEED_ESCALATED, Math.max(pages, MAX_PAGES_PER_FEED, lastBatchPages * 2));
    }
    return Math.max(1, Math.min(pages, Math.floor(pageBudget / feedCount)));
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
  function hashParams(hash) {
    try {
      return new URLSearchParams(hash.split("?")[1]);
    } catch {
      return null;
    }
  }
  function parseDetailId(hash) {
    if (!hash.includes("/details") || !hash.includes("id=")) return null;
    return hashParams(hash)?.get("id") ?? null;
  }
  function parseListParam(hash, param) {
    if (!hash.includes("/list") || !hash.includes(`${param}=`)) return null;
    return hashParams(hash)?.get(param) ?? null;
  }
  function decodeFeedPage(value) {
    if (value === null || value === void 0) return { results: [] };
    if (!isRecord(value)) throw decodeError("feed page");
    const rows = value.results;
    if (rows !== null && rows !== void 0 && !Array.isArray(rows)) throw decodeError("feed page");
    const results = Array.isArray(rows) ? rows.filter(isSeerrResult) : [];
    const total = Number(value.totalPages);
    return total > 0 ? { results, totalPages: total } : { results };
  }

  // client/src/features/seerr/discovery/controller.ts
  var MAX_PREFETCH_PER_FEED = 3;
  var KEEP_ATTACHED_MS = 6e3;
  var LOAD_YIELD_COLD = 0.8;
  var LOAD_YIELD_FLOOR = 0.05;
  var newCursor = () => ({ page: 1, hasMore: true, total: Infinity });
  function resetCursor(cursor) {
    Object.assign(cursor, newCursor());
  }
  function listSignature(page) {
    const container = page?.querySelector(".itemsContainer");
    if (!container) return "";
    const first = container.firstElementChild;
    const label = first?.getAttribute("data-id") || first?.getAttribute("data-index") || first?.textContent?.trim().slice(0, 40) || "";
    return `${container.childElementCount}|${label}`;
  }
  function createDiscoveryController(spec, JE) {
    const { key } = spec;
    const logPrefix = `🪼 Jellyfin Enhanced: ${spec.logLabel}:`;
    const sectionSelector = `.jellyseerr-${key}-discovery-section`;
    const isDualFeed = spec.mode === "dual-feed";
    const isClientPaged = spec.mode === "client-paged";
    const cardClass = isDualFeed ? "portraitCard" : "overflowPortraitCard";
    const pageSize = spec.mode === "client-paged" && spec.pageSize || 40;
    const filter = () => filterOf(JE);
    const processedPages = /* @__PURE__ */ new Set();
    let visibleAtNavigation = null;
    let visibleContentAtNavigation = "";
    let snapshotHash = null;
    let shownView = null;
    let shownViewHash = null;
    let currentAbortController = null;
    let currentRenderingPageKey = null;
    let keepAttachedSequence = 0;
    let initialized = false;
    let disposed = false;
    let pendingFrame = 0;
    const disposers = [];
    let isLoading = false;
    let hasMorePages = true;
    const scrollState = { activeScrollObserver: null };
    const cursors = { tv: newCursor(), movie: newCursor() };
    const yieldStats = { fetched: 0, rendered: 0 };
    let lastBatchPages = 0;
    let lastBatchRendered = -1;
    let loadGeneration = 0;
    let loadingOwner = 0;
    const takeLoading = () => {
      isLoading = true;
      return ++loadingOwner;
    };
    const releaseLoading = (owner) => {
      if (loadingOwner === owner) isLoading = false;
    };
    let currentFeeds = null;
    let cachedTvResults = [];
    let cachedMovieResults = [];
    const shownResults = /* @__PURE__ */ new Set();
    let clientListActive = false;
    let cachedAllResults = [];
    let currentPagedResults = [];
    let renderedCount = 0;
    let renderEpoch = 0;
    const managed = (path, options) => filter().fetchWithManagedRequest(path, key, options);
    const itemsContainerNow = () => document.querySelector(`${sectionSelector} .itemsContainer`);
    function rememberShownView(event) {
      if (!(event.target instanceof HTMLElement)) return;
      shownView = event.target;
      shownViewHash = window.location.hash;
    }
    function currentShownView() {
      return shownView?.isConnected && !shownView.classList.contains("hide") && shownViewHash === window.location.hash ? shownView : null;
    }
    function isEnabled() {
      const value = JE.pluginConfig?.[spec.configKey];
      return spec.defaultEnabled === false ? !!value : value !== false;
    }
    function resetPagination() {
      resetCursor(cursors.tv);
      resetCursor(cursors.movie);
      yieldStats.fetched = 0;
      yieldStats.rendered = 0;
      lastBatchPages = 0;
      lastBatchRendered = -1;
    }
    function endMeasurement() {
      if (JE.requestManager?.metrics?.enabled) JE.requestManager.endMeasurement?.(`${key}-discovery`);
    }
    function markProcessed(pageKey) {
      processedPages.add(pageKey);
      endMeasurement();
    }
    async function fetchFeedPage(kind, feedId, page, signal, tolerant = false) {
      try {
        throwIfAborted(signal);
        if (spec.mode !== "dual-feed" || !currentFeeds) throw abortError();
        const sortBy = kind === "tv" ? filter().getTvSortMode(key) : filter().getSortMode(key);
        let path = `${spec.buildDiscoverPath(kind, feedId, currentFeeds)}?page=${page}`;
        if (sortBy) path += `&sortBy=${encodeURIComponent(sortBy)}`;
        const response = await managed(path, { signal });
        throwIfAborted(signal);
        return decodeFeedPage(response);
      } catch (error) {
        if (isAbortError(error) || !tolerant) throw error;
        return { results: [], failed: true };
      }
    }
    function prefetchAhead(filterMode, pagesPerFeed, signal) {
      const feeds = currentFeeds;
      if (!feeds) return;
      const count = Math.max(1, Math.min(MAX_PREFETCH_PER_FEED, pagesPerFeed));
      const warm = (kind, id) => {
        for (const page of pageRange(cursors[kind].page + 1, count, cursors[kind].total)) {
          void fetchFeedPage(kind, id, page, signal).catch(() => {
          });
        }
      };
      if (feeds.tvId && (filterMode === "mixed" || filterMode === "tv") && cursors.tv.hasMore) warm("tv", feeds.tvId);
      if (feeds.movieId && (filterMode === "mixed" || filterMode === "movies") && cursors.movie.hasMore) warm("movie", feeds.movieId);
    }
    function updateHasMorePages(mode) {
      if (mode === "tv") hasMorePages = cursors.tv.hasMore;
      else if (mode === "movies") hasMorePages = cursors.movie.hasMore;
      else hasMorePages = cursors.tv.hasMore || cursors.movie.hasMore;
    }
    const interleavedResults = () => filter().interleaveArrays(cachedTvResults, cachedMovieResults);
    function pageOneFetches(feeds, signal) {
      const fetches = [];
      if (feeds.tvId) {
        fetches.push(fetchFeedPage("tv", feeds.tvId, 1, signal, true).then((data) => ({ kind: "tv", data })));
      }
      if (feeds.movieId) {
        fetches.push(fetchFeedPage("movie", feeds.movieId, 1, signal, true).then((data) => ({ kind: "movie", data })));
      }
      return fetches;
    }
    function commitPageOne(pages) {
      let anyFailed = false;
      for (const { kind, data } of pages) {
        const cursor = cursors[kind];
        if (kind === "tv") cachedTvResults = data.results;
        else cachedMovieResults = data.results;
        if (data.failed) {
          anyFailed = true;
          cursor.page = 0;
          cursor.hasMore = true;
        } else {
          cursor.total = clampPages(data.totalPages);
          cursor.hasMore = 1 < cursor.total;
        }
      }
      return anyFailed;
    }
    function pagedResults(mode) {
      const facade = filter();
      const sorted = sortResults(cachedAllResults, facade.getSortMode(key));
      if (mode === "movies" || mode === "tv") return facade.filterByMediaType(sorted, mode);
      return facade.interleaveArrays(
        sorted.filter((item) => item.mediaType === "tv"),
        sorted.filter((item) => item.mediaType === "movie")
      );
    }
    function pagedResultsForMode(mode) {
      const results = pagedResults(mode);
      return results.length === 0 && cachedAllResults.length > 0 ? cachedAllResults : results;
    }
    const createCardsFragment = (results) => filter().createCardsFragment(results, { cardClass });
    function markShown(results) {
      for (const item of results) shownResults.add(resultKey(item));
    }
    function restartChunks(itemsContainer, mode) {
      renderEpoch++;
      JE.jellyseerrUI?.releasePosters?.(itemsContainer);
      itemsContainer.replaceChildren();
      renderedCount = 0;
      currentPagedResults = pagedResultsForMode(mode);
      const nextChunk = currentPagedResults.slice(0, pageSize);
      if (nextChunk.length === 0) {
        hasMorePages = false;
        return;
      }
      const fragment = createCardsFragment(nextChunk);
      if (fragment.childNodes.length > 0) itemsContainer.appendChild(fragment);
      renderedCount = nextChunk.length;
      hasMorePages = renderedCount < currentPagedResults.length;
    }
    async function renderChunkInSlices(itemsContainer, mode, chunkSize, signal) {
      if (!itemsContainer) return;
      currentPagedResults = pagedResultsForMode(mode);
      const nextChunk = currentPagedResults.slice(renderedCount, renderedCount + chunkSize);
      if (nextChunk.length === 0) {
        hasMorePages = false;
        return;
      }
      const epoch = renderEpoch;
      const isCurrent = () => epoch === renderEpoch && !signal?.aborted;
      await filter().appendCards(itemsContainer, nextChunk, { cardClass, isCurrent });
      if (!isCurrent()) return;
      renderedCount += nextChunk.length;
      hasMorePages = renderedCount < currentPagedResults.length;
    }
    async function loadMoreClientPaged(hint) {
      if (isLoading || !hasMorePages || !clientListActive) return void 0;
      isLoading = true;
      const epoch = renderEpoch;
      try {
        const itemsContainer = itemsContainerNow();
        const chunk = Math.max(pageSize, JE.seamlessScroll?.cardsNeeded?.(itemsContainer, hint, pageSize) || pageSize);
        const before = renderedCount;
        await renderChunkInSlices(itemsContainer, filter().getFilterMode(key), chunk, currentAbortController?.signal);
        return { pages: 1, rendered: renderedCount - before };
      } catch (error) {
        if (isAbortError(error)) return void 0;
        console.error(`${logPrefix} Error loading more items:`, error);
        throw error;
      } finally {
        isLoading = false;
        if (epoch !== renderEpoch) scrollState.fill?.();
      }
    }
    async function loadMoreDualFeed(hint) {
      var _a, _b;
      const feeds = currentFeeds;
      if (isLoading || !hasMorePages || !feeds || !feeds.tvId && !feeds.movieId) return void 0;
      const filterMode = filter().getFilterMode(key);
      const generation = loadGeneration;
      const owner = takeLoading();
      const previous = {
        tv: { ...cursors.tv },
        movie: { ...cursors.movie },
        tvResults: cachedTvResults,
        movieResults: cachedMovieResults
      };
      try {
        const signal = currentAbortController?.signal;
        const itemsContainer = itemsContainerNow();
        const needTv = !!feeds.tvId && (filterMode === "mixed" || filterMode === "tv") && cursors.tv.hasMore;
        let needMovies = !!feeds.movieId && (filterMode === "mixed" || filterMode === "movies") && cursors.movie.hasMore;
        const pageBudget = Number.isFinite(hint?.pageBudget) ? Math.max(0, hint?.pageBudget ?? 0) : Infinity;
        if (needTv && needMovies && pageBudget < 2) needMovies = false;
        const feedCount = (needTv ? 1 : 0) + (needMovies ? 1 : 0);
        if (feedCount === 0) {
          hasMorePages = false;
          return void 0;
        }
        const wantCards = JE.seamlessScroll?.cardsNeeded?.(itemsContainer, hint, 40) || 40;
        const yieldRatio = estimateYield(yieldStats, LOAD_YIELD_COLD, LOAD_YIELD_FLOOR);
        const pagesPerFeed = planPagesPerFeed({ wantCards, feedCount, yieldRatio, lastBatchRendered, lastBatchPages, pageBudget });
        console.debug(`${logPrefix} load: deficit=${Math.round(hint?.deficitPx || 0)}px want=${wantCards} yield=${yieldRatio.toFixed(2)} pagesPerFeed=${pagesPerFeed} budget=${pageBudget}`);
        const tvPages = needTv ? pageRange(cursors.tv.page + 1, pagesPerFeed, cursors.tv.total) : [];
        const moviePages = needMovies ? pageRange(cursors.movie.page + 1, pagesPerFeed, cursors.movie.total) : [];
        if (tvPages.length === 0 && moviePages.length === 0) {
          (_a = cursors.tv).hasMore && (_a.hasMore = cursors.tv.page < cursors.tv.total);
          (_b = cursors.movie).hasMore && (_b.hasMore = cursors.movie.page < cursors.movie.total);
          updateHasMorePages(filterMode);
          return { pages: 0, rendered: 0 };
        }
        const pagesFetched = tvPages.length + moviePages.length;
        const fetchAll = (kind, id, pages) => Promise.allSettled(id ? pages.map((page) => fetchFeedPage(kind, id, page, signal)) : []);
        const [tvSettled, movieSettled] = await Promise.all([
          fetchAll("tv", feeds.tvId, tvPages),
          fetchAll("movie", feeds.movieId, moviePages)
        ]);
        if (signal?.aborted) return void 0;
        if (generation !== loadGeneration) return void 0;
        const failures = [];
        let committedPages = 0;
        const commit = (kind, settled, pages) => {
          const rows = [];
          const cursor = cursors[kind];
          for (const [index, outcome] of settled.entries()) {
            if (outcome.status !== "fulfilled") {
              if (isAbortError(outcome.reason)) throw outcome.reason;
              failures.push(outcome.reason);
              break;
            }
            rows.push(...outcome.value.results);
            cursor.total = clampPages(outcome.value.totalPages);
            cursor.page = pages[index] ?? cursor.page;
            cursor.hasMore = cursor.page < cursor.total;
            committedPages++;
          }
          return rows;
        };
        const newTvResults = commit("tv", tvSettled, tvPages);
        if (newTvResults.length > 0) cachedTvResults = [...cachedTvResults, ...newTvResults];
        const newMovieResults = commit("movie", movieSettled, moviePages);
        if (newMovieResults.length > 0) cachedMovieResults = [...cachedMovieResults, ...newMovieResults];
        if (failures.length > 0) {
          if (committedPages === 0) throw failures[0];
          console.debug(`${logPrefix} ${committedPages} of ${pagesFetched} page(s) arrived; the rest will be retried on the next load`, failures[0]);
        }
        updateHasMorePages(filterMode);
        lastBatchPages = pagesPerFeed;
        let itemsToAdd = filterMode === "tv" ? newTvResults : filterMode === "movies" ? newMovieResults : filter().interleaveArrays(newTvResults, newMovieResults);
        yieldStats.fetched += itemsToAdd.length;
        lastBatchRendered = 0;
        itemsToAdd = unseenResults(itemsToAdd, shownResults);
        if (itemsContainer && itemsToAdd.length > 0) {
          const rendering = filter().appendCards(itemsContainer, itemsToAdd, {
            cardClass,
            isCurrent: () => !signal?.aborted
          });
          ensureFilterControl(itemsContainer);
          const rendered = await rendering;
          markShown(itemsToAdd);
          if (signal?.aborted) return void 0;
          if (generation !== loadGeneration) return { pages: committedPages, rendered };
          yieldStats.rendered += rendered;
          lastBatchRendered = rendered;
        }
        const remainingBudget = pageBudget === Infinity ? Infinity : Math.max(0, pageBudget - pagesFetched);
        const prefetchPerFeed = lastBatchRendered > 0 ? pagesPerFeed * 2 : Math.min(pagesPerFeed, Math.floor(remainingBudget / feedCount));
        if (prefetchPerFeed > 0) prefetchAhead(filterMode, prefetchPerFeed, signal);
        return { pages: committedPages, rendered: lastBatchRendered };
      } catch (error) {
        if (generation === loadGeneration) {
          Object.assign(cursors.tv, previous.tv);
          Object.assign(cursors.movie, previous.movie);
          cachedTvResults = previous.tvResults;
          cachedMovieResults = previous.movieResults;
          updateHasMorePages(filterMode);
        }
        if (isAbortError(error)) return void 0;
        console.error(`${logPrefix} Error loading more items:`, error);
        throw error;
      } finally {
        releaseLoading(owner);
        if (generation !== loadGeneration) scrollState.fill?.();
      }
    }
    const loadMoreItems = (hint) => isClientPaged ? loadMoreClientPaged(hint) : loadMoreDualFeed(hint);
    function setupInfiniteScroll() {
      filter().setupInfiniteScroll(scrollState, sectionSelector, loadMoreItems, () => hasMorePages, () => isLoading);
    }
    function cleanupScrollObserver() {
      filter().cleanupScrollObserver(scrollState);
    }
    function createSectionContainer(title, showFilter) {
      const section = document.createElement("div");
      section.className = isDualFeed ? `verticalSection jellyseerr-${key}-discovery-section padded-left padded-right` : `verticalSection jellyseerr-${key}-discovery-section`;
      section.setAttribute(`data-jellyseerr-${key}-discovery`, "true");
      section.style.cssText = "margin-top:2em;padding-top:1em;border-top:1px solid rgba(255,255,255,0.1)";
      section.appendChild(filter().createSectionHeader(title, key, showFilter, handleFilterChange, () => {
        void handleSortChange();
      }));
      const itemsContainer = document.createElement("div");
      itemsContainer.setAttribute("is", "emby-itemscontainer");
      itemsContainer.className = isDualFeed ? "vertical-wrap itemsContainer centered" : "itemsContainer padded-right vertical-wrap";
      section.appendChild(itemsContainer);
      return section;
    }
    async function handleSortChange() {
      const itemsContainer = itemsContainerNow();
      if (isClientPaged) {
        if (!itemsContainer) return;
        restartChunks(itemsContainer, filter().getFilterMode(key));
        cleanupScrollObserver();
        if (hasMorePages) setupInfiniteScroll();
        return;
      }
      const feeds = currentFeeds;
      if (!itemsContainer || !feeds || !feeds.tvId && !feeds.movieId) return;
      JE.jellyseerrUI?.releasePosters?.(itemsContainer);
      itemsContainer.replaceChildren();
      cleanupScrollObserver();
      loadGeneration++;
      resetPagination();
      const generation = loadGeneration;
      let owner = 0;
      cachedTvResults = [];
      cachedMovieResults = [];
      shownResults.clear();
      currentAbortController?.abort();
      const controller = new AbortController();
      bindToSession(JE, controller);
      currentAbortController = controller;
      const { signal } = controller;
      const fetches = pageOneFetches(feeds, signal);
      try {
        owner = takeLoading();
        const results = await Promise.all(fetches);
        if (signal.aborted) return;
        const filterMode = filter().getFilterMode(key);
        commitPageOne(results);
        updateHasMorePages(filterMode);
        const displayResults = interleavedResults();
        if (displayResults.length > 0) {
          const fragment = createCardsFragment(displayResults);
          yieldStats.fetched += displayResults.length;
          yieldStats.rendered += fragment.childNodes.length;
          itemsContainer.appendChild(fragment);
          markShown(displayResults);
        }
        filter().applyFilterVisibility(itemsContainer, filterMode);
        if (hasMorePages) setupInfiniteScroll();
      } catch (error) {
        if (!isAbortError(error)) console.error(`${logPrefix} Sort change error:`, error);
      } finally {
        releaseLoading(owner);
        if (generation !== loadGeneration) scrollState.fill?.();
      }
    }
    function handleFilterChange(newMode) {
      const itemsContainer = itemsContainerNow();
      if (!itemsContainer) return;
      if (isClientPaged) {
        restartChunks(itemsContainer, newMode);
        cleanupScrollObserver();
        if (hasMorePages) setupInfiniteScroll();
        return;
      }
      filter().applyFilterVisibility(itemsContainer, newMode);
      loadGeneration++;
      yieldStats.fetched = 0;
      yieldStats.rendered = 0;
      lastBatchPages = 0;
      lastBatchRendered = -1;
      updateHasMorePages(newMode);
      if (hasMorePages) setupInfiniteScroll();
    }
    function waitForPageReady(signal) {
      return filter().waitForPageReady(signal, {
        type: isDualFeed ? "list" : "detail",
        getView: currentShownView,
        isStalePage: (page) => !!page && page === visibleAtNavigation && listSignature(page) === visibleContentAtNavigation
      });
    }
    function ensureFilterControl(itemsContainer) {
      if (!isDualFeed) return;
      const header = itemsContainer.closest(sectionSelector)?.querySelector(".jellyseerr-discovery-header");
      if (!header || header.querySelector(".jellyseerr-discovery-filter")) return;
      if (!filter().hasBothTypes(cachedTvResults, cachedMovieResults)) return;
      header.querySelector(".sectionTitle")?.after(filter().createFilterControl(key, handleFilterChange));
    }
    function keepAttached(section, listPage, signal) {
      const handle = JE.helpers?.onBodyMutation?.(`jellyseerr-${key}-discovery-keepattached-${++keepAttachedSequence}`, () => {
        if (signal.aborted) return;
        const detached = !section.isConnected;
        if (!detached && !section.closest(".page.hide")) return;
        const container = currentShownView()?.querySelector(".itemsContainer") ?? document.querySelector(".page:not(.hide) .itemsContainer") ?? document.querySelector(".libraryPage:not(.hide) .itemsContainer") ?? listPage;
        const parent = container.closest(".verticalSection") ?? container.parentElement;
        if (parent?.parentElement && !parent.parentElement.contains(section)) parent.parentElement.appendChild(section);
      });
      if (!handle) return;
      const stop = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", stop);
        handle.unsubscribe();
      };
      const timer = setTimeout(stop, KEEP_ATTACHED_MS);
      signal.addEventListener("abort", stop, { once: true });
    }
    async function renderDualFeed(id, signal, pageKey) {
      if (spec.mode !== "dual-feed") return;
      const pageReadyAbort = new AbortController();
      const stopPageWait = () => pageReadyAbort.abort();
      signal.addEventListener("abort", stopPageWait, { once: true });
      const pageReadyPromise = waitForPageReady(pageReadyAbort.signal);
      const resolved = await spec.resolveFeeds({ id, signal });
      if (signal.aborted) return;
      if (!resolved || !resolved.tvId && !resolved.movieId) {
        stopPageWait();
        return;
      }
      resetPagination();
      isLoading = false;
      hasMorePages = true;
      loadGeneration++;
      const feeds = { ...resolved, tvId: resolved.tvId || null, movieId: resolved.movieId || null };
      currentFeeds = feeds;
      cachedTvResults = [];
      cachedMovieResults = [];
      shownResults.clear();
      const fetches = pageOneFetches(feeds, signal);
      fetches.forEach((fetch) => {
        fetch.catch(() => {
        });
      });
      const listPage = await pageReadyPromise;
      signal.removeEventListener("abort", stopPageWait);
      if (signal.aborted) return;
      let section = null;
      let itemsContainer = null;
      if (listPage) {
        document.querySelector(sectionSelector)?.remove();
        const built = createSectionContainer(resolved.title, false);
        const parent = (listPage.closest(".verticalSection") ?? listPage.parentElement)?.parentElement;
        if (parent) {
          section = built;
          itemsContainer = built.querySelector(".itemsContainer");
          parent.appendChild(built);
          keepAttached(built, listPage, signal);
        }
      }
      let fetchResults;
      try {
        fetchResults = await Promise.all(fetches);
      } catch (error) {
        if (!signal.aborted) section?.remove();
        throw error;
      }
      if (signal.aborted) return;
      const anyFailed = commitPageOne(fetchResults);
      filter().resetFilterMode(key);
      filter().resetSortMode(key);
      updateHasMorePages(filter().getFilterMode(key));
      const displayResults = interleavedResults();
      if (!section || !itemsContainer) return;
      const fragment = createCardsFragment(displayResults);
      if (fragment.childNodes.length === 0 && !anyFailed && !hasMorePages) {
        section.remove();
        return;
      }
      ensureFilterControl(itemsContainer);
      yieldStats.fetched += displayResults.length;
      yieldStats.rendered += fragment.childNodes.length;
      itemsContainer.appendChild(fragment);
      markShown(displayResults);
      if (hasMorePages) setupInfiniteScroll();
      markProcessed(pageKey);
    }
    async function renderClientPaged(id, signal, pageKey) {
      if (spec.mode !== "client-paged") return;
      const resolved = await spec.resolveItems({ id, signal });
      if (signal.aborted) return;
      if (!resolved || resolved.items.length === 0) return;
      cachedAllResults = resolved.items;
      clientListActive = true;
      const hasBoth = filter().resultHasBothTypes(cachedAllResults);
      filter().resetFilterMode(key);
      filter().resetSortMode(key);
      const displayResults = pagedResultsForMode(filter().getFilterMode(key));
      const detailSection = await waitForPageReady(signal);
      if (signal.aborted) return;
      if (!detailSection) {
        console.debug(`${logPrefix} Could not find detail section to insert into`);
        return;
      }
      document.querySelector(sectionSelector)?.remove();
      const section = createSectionContainer(resolved.title, hasBoth);
      const itemsContainer = section.querySelector(".itemsContainer");
      let consumed = 0;
      let fragment = document.createDocumentFragment();
      while (fragment.childNodes.length === 0 && consumed < displayResults.length) {
        const chunk = displayResults.slice(consumed, consumed + pageSize);
        fragment = createCardsFragment(chunk);
        consumed += chunk.length;
      }
      if (!itemsContainer || fragment.childNodes.length === 0) {
        console.debug(`${logPrefix} No cards created from results`);
        return;
      }
      const cardCount = fragment.childNodes.length;
      itemsContainer.appendChild(fragment);
      currentPagedResults = displayResults;
      renderedCount = consumed;
      hasMorePages = renderedCount < currentPagedResults.length;
      detailSection.appendChild(section);
      console.debug(`${logPrefix} Section added with ${cardCount} cards`);
      if (hasMorePages) setupInfiniteScroll();
      markProcessed(pageKey);
    }
    async function showClientPagedRetry(signal) {
      const detailSection = await waitForPageReady(signal);
      if (signal.aborted || !detailSection) return;
      document.querySelector(sectionSelector)?.remove();
      const section = document.createElement("div");
      section.className = `verticalSection jellyseerr-${key}-discovery-section je-retry-row`;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "raised emby-button";
      button.textContent = "⟳ Tap to retry";
      button.addEventListener("click", () => {
        if (signal.aborted || button.disabled) return;
        button.disabled = true;
        void render().finally(() => section.remove());
      }, { signal });
      section.appendChild(button);
      detailSection.appendChild(section);
      signal.addEventListener("abort", () => section.remove(), { once: true });
    }
    async function render() {
      const id = disposed ? null : spec.getIdFromUrl();
      if (!id) return;
      const pageKey = spec.pageKey ? spec.pageKey(id) : `${key}-${id}-${window.location.hash}`;
      if (processedPages.has(pageKey)) return;
      if (currentRenderingPageKey === pageKey) return;
      if (!isEnabled()) return;
      currentRenderingPageKey = pageKey;
      currentAbortController?.abort();
      const controller = new AbortController();
      bindToSession(JE, controller);
      currentAbortController = controller;
      const { signal } = controller;
      if (JE.requestManager?.metrics?.enabled) JE.requestManager.startMeasurement?.(`${key}-discovery`);
      try {
        if (spec.mode === "dual-feed") {
          await renderDualFeed(id, signal, pageKey);
        } else if (spec.mode === "client-paged") {
          await renderClientPaged(id, signal, pageKey);
        } else {
          const rendered = await spec.renderOneShot({ id, pageKey, signal, waitForPageReady });
          if (signal.aborted) return;
          if (rendered) markProcessed(pageKey);
        }
      } catch (error) {
        if (isAbortError(error)) {
          console.debug(`${logPrefix} Request aborted`);
          return;
        }
        console.error(`${logPrefix} Error rendering ${key} discovery:`, error);
        if (isClientPaged && !signal.aborted) await showClientPagedRetry(signal);
      } finally {
        if (currentAbortController === controller) {
          currentRenderingPageKey = null;
          if (signal.aborted) cleanup();
        }
      }
    }
    function cleanup() {
      loadGeneration++;
      document.querySelectorAll(sectionSelector).forEach((element) => element.remove());
      currentAbortController?.abort();
      currentAbortController = null;
      JE.jellyseerrUI?.releasePosters?.();
      if (spec.mode !== "one-shot") cleanupScrollObserver();
      processedPages.clear();
      isLoading = false;
      hasMorePages = true;
      resetPagination();
      currentFeeds = null;
      clientListActive = false;
      currentPagedResults = [];
      renderedCount = 0;
      currentRenderingPageKey = null;
      cachedTvResults = [];
      cachedMovieResults = [];
      cachedAllResults = [];
      shownResults.clear();
      if (spec.mode !== "one-shot") {
        filter().resetFilterMode(key);
        filter().resetSortMode(key);
      }
      spec.onCleanup?.();
    }
    function handlePageNavigation(_view, element) {
      if (disposed || !spec.getIdFromUrl()) return;
      if (element instanceof HTMLElement) {
        shownView = element;
        shownViewHash = window.location.hash;
      }
      pendingFrame = requestAnimationFrame(() => {
        void render();
      });
    }
    function snapshotVisiblePage() {
      if (window.location.hash === snapshotHash) return;
      snapshotHash = window.location.hash;
      visibleAtNavigation = document.querySelector(".page:not(.hide)");
      visibleContentAtNavigation = listSignature(visibleAtNavigation);
    }
    function initialize() {
      if (initialized || disposed) return;
      const core = JE.core;
      if (!core?.lifecycle || !core.navigation) throw new Error("Discovery needs the core lifecycle and navigation");
      initialized = true;
      const lifecycle = core.lifecycle.register(`jellyseerr-${key}-discovery`);
      lifecycle.onTeardown(cleanup);
      disposers.push(lifecycle.teardownOn("navigate"));
      for (const type of ["je:navigate", "hashchange", "popstate"]) {
        window.addEventListener(type, snapshotVisiblePage, true);
        disposers.push(() => window.removeEventListener(type, snapshotVisiblePage, true));
      }
      document.addEventListener("viewshow", rememberShownView, true);
      disposers.push(() => document.removeEventListener("viewshow", rememberShownView, true));
      const navigated = () => handlePageNavigation();
      disposers.push(core.navigation.onNavigate(navigated));
      handlePageNavigation();
      disposers.push(core.navigation.onViewPage(handlePageNavigation));
    }
    function start() {
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
      else initialize();
    }
    function dispose() {
      if (disposed) return;
      disposed = true;
      document.removeEventListener("DOMContentLoaded", initialize);
      cancelAnimationFrame(pendingFrame);
      disposers.splice(0).forEach((stop) => stop());
      cleanup();
    }
    const stopSession = JE.session?.onUserChange(`discovery-${key}`, cleanup);
    if (stopSession) disposers.push(stopSession);
    return { initialize, cleanup, render, handlePageNavigation, start, dispose };
  }

  // client/src/features/seerr/discovery/discovery-base.ts
  (function() {
    "use strict";
    const { JE } = discoveryHost();
    JE.discoveryBase = {
      createDiscovery: (spec) => createDiscoveryController(spec, JE),
      idFromDetailUrl: () => parseDetailId(window.location.hash),
      idFromListParam: (param) => () => parseListParam(window.location.hash, param)
    };
  })();
})();
})();
//# sourceMappingURL=discovery-base.js.map
