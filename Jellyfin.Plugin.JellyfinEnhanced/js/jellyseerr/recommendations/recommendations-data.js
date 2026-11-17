// /js/jellyseerr/recommendations/recommendations-data.js
// Recommendations Page — shared state and Seerr fetch helpers (split from
// recommendations.js).
(function () {
  "use strict";

  const JE = window.JellyfinEnhanced;
  JE.internals = JE.internals || {};
  const P = (JE.internals.recommendationsPage = JE.internals.recommendationsPage || {});

  const logPrefix = '🪼 Jellyfin Enhanced: Recommendations:';

  // Resolved once at load, exactly as the pre-split module did: the sidebar
  // node and whether the Plugin Pages link for this page already exists.
  const sidebar = document.querySelector('.mainDrawer-scrollContainer');
  const pluginPagesExists = !!sidebar?.querySelector(
    'a[is="emby-linkbutton"][data-itemid="Jellyfin.Plugin.JellyfinEnhanced.RecommendationsPage"]'
  );

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

  // --- The page's filters ---
  // All | Movies | Series and the further filters of the "More from" sections, kept under one
  // module for the page and every category page opened from it: what is set on one is set on the
  // others. Where the page's address holds them (Home's tab, the page of its own), it says what is
  // set (see discovery-address.js). The category pages' order is kept on its own.
  const FILTER_MODULE = 'recommendations';
  const SORT_MODULE = 'recommendationsCategory';
  // Pages of Trending read for its row while filters narrow it, and the titles that are enough to stop at.
  const TRENDING_FILTERED_PAGES = 3;
  const TRENDING_FILTERED_ENOUGH = 12;

  const filters = () => JE.discoveryFilter;

  /**
   * Today in the viewer's calendar, as Seerr's dates are written.
   * @param {Date} [now]
   * @returns {string}
   */
  function localDay(now = new Date()) {
    const two = value => String(value).padStart(2, '0');
    return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
  }

  /**
   * Whether a row or feed of this kind (none: both kinds) shows under All | Movies | Series.
   * @param {'movie'|'tv'|null|undefined} kind
   * @param {string} mode - 'mixed', 'movies' or 'tv'
   * @returns {boolean}
   */
  function shownForType(kind, mode) {
    return !kind || mode === 'mixed' || (mode === 'movies' ? kind === 'movie' : kind === 'tv');
  }

  /**
   * Seerr's Trending feed takes no filters: its titles are kept as they come, by what each says of itself.
   * @param {string} path
   * @returns {boolean}
   */
  function isTrendingPath(path) {
    return /\/discover\/trending$/.test(path);
  }

  /**
   * The request for one page of a feed with the page's filters (`filterQuery`: the `&name=value` pairs
   * the controls give, '' for none). Seerr takes no filters on its upcoming feeds either, so with filters
   * set an upcoming feed is asked as discover from today, which is what its upcoming titles are; a later
   * lower date in the filters is kept. Trending is asked plainly (see isTrendingPath).
   * @param {string} path - The feed's base path
   * @param {number} page
   * @param {string} filterQuery
   * @param {string} today - YYYY-MM-DD
   * @returns {string}
   */
  function feedRequest(path, page, filterQuery, today) {
    if (!filterQuery || isTrendingPath(path)) return `${path}?page=${page}`;
    const upcoming = /\/discover\/(movies|tv)\/upcoming$/.exec(path);
    if (!upcoming) return `${path}?page=${page}${filterQuery}`;
    const name = upcoming[1] === 'movies' ? 'primaryReleaseDateGte' : 'firstAirDateGte';
    const own = new RegExp(`&${name}=([^&]*)`).exec(filterQuery)?.[1];
    let given = '';
    try { given = own ? decodeURIComponent(own) : ''; } catch (_) { given = ''; }
    const from = given > today ? given : today;
    const rest = filterQuery.replace(new RegExp(`&${name}=[^&]*`, 'g'), '');
    return `${path.replace(/\/upcoming$/, '')}?page=${page}&${name}=${encodeURIComponent(from)}${rest}`;
  }

  /**
   * One page of a feed under the page's filters, asked as the feed's kind takes them.
   * @param {string} path - The feed's base path
   * @param {'movie'|'tv'|null|undefined} kind - The kind its filters are asked for (none: Trending)
   * @param {number} page
   * @param {object} [options] - Fetch options (signal)
   * @returns {Promise<any>}
   */
  function feedPage(path, kind, page, options) {
    const query = kind ? (filters().feedQuery?.(FILTER_MODULE, kind) ?? '') : '';
    // (A genre's category names its genre itself: its genres are asked as all of what is ticked.)
    const filterQuery = JE.discoveryFilters?.forRoute?.(path, query) ?? query;
    return fetchWithManagedRequest(feedRequest(path, page, filterQuery, localDay()), options);
  }

  /**
   * Titles of a feed that takes no filters (Trending), kept by All | Movies | Series and by the filters a
   * title can be checked against; null when a filter is set that it can't be (runtime, rating, services,
   * keywords), so nothing of it can be said to match.
   * @param {Array} results
   * @returns {Array|null}
   */
  function keepLoaded(results) {
    const selection = filters().getFilters?.(FILTER_MODULE) ?? {};
    if (JE.discoveryFilters?.checkableOnLoaded && !JE.discoveryFilters.checkableOnLoaded(selection)) return null;
    return filters().filterByMediaType(filters().keepByFilters(FILTER_MODULE, results), filters().getFilterMode(FILTER_MODULE));
  }

  /** @returns {boolean} Whether anything narrows the page: a type other than All, or a further filter. */
  function isNarrowed() {
    return filters().getFilterMode(FILTER_MODULE) !== filters().MODES.MIXED || !!filters().hasMoreFilters?.(FILTER_MODULE);
  }

  /** @returns {string} What the rows are filled for: All | Movies | Series and the further filters. */
  function filterSignature() {
    return JSON.stringify([filters().getFilterMode(FILTER_MODULE), filters().getFilters?.(FILTER_MODULE) ?? {}]);
  }

  /** Back to everything: All, and no further filter. */
  function clearFilters() {
    filters().clearFilters?.(FILTER_MODULE);
    filters().setFilterMode(FILTER_MODULE, filters().MODES.MIXED);
  }

  /** @returns {boolean} Whether the page's address holds its filters: on Home (its tab) or on its own page. */
  function addressHoldsFilters() {
    return !!JE.discoveryAddress?.isRecommendationsHash?.(window.location.hash);
  }

  /**
   * One media row's titles under the page's filters: its first page, or for Trending while filters
   * narrow it as many of its first pages as give a row.
   * @param {{path: string, kind?: 'movie'|'tv'}} row
   * @param {AbortSignal} signal
   * @returns {Promise<Array>}
   */
  async function fetchRowResults(row, signal) {
    if (!isTrendingPath(row.path) || !isNarrowed()) {
      return (await feedPage(row.path, row.kind, 1, { signal }))?.results || [];
    }
    const kept = [];
    for (let page = 1; page <= TRENDING_FILTERED_PAGES && kept.length < TRENDING_FILTERED_ENOUGH; page++) {
      const answer = await fetchWithManagedRequest(`${row.path}?page=${page}`, { signal });
      const fit = keepLoaded(answer?.results || []);
      if (fit === null) break;
      kept.push(...fit);
      if (page >= (Number(answer?.totalPages) || 1)) break;
    }
    return kept;
  }

  /**
   * Fetches the media rows of the kinds All | Movies | Series shows, in parallel, under the page's
   * filters. One failing/empty category never blanks the whole page - each row is rendered independently.
   * @param {AbortSignal} signal
   * @returns {Promise<Array<{row: Object, results: Array}>>}
   */
  async function fetchAllRows(signal) {
    const mode = filters().getFilterMode?.(FILTER_MODULE) ?? 'mixed';
    const rows = P.ROWS.filter(row => shownForType(row.kind, mode));
    const settled = await Promise.allSettled(rows.map(row => fetchRowResults(row, signal)));

    return settled.map((outcome, i) => ({
      row: rows[i],
      results: outcome.status === 'fulfilled' ? (outcome.value || []) : [],
    }));
  }

  // Cache of the genre slider list per media type, so switching between the
  // standalone page and custom tab doesn't re-fetch.
  const genreSliderCache = new Map();

  /**
   * Fetches (and caches) the genre slider list - {id, name, backdrops[]} per
   * genre - for a media type.
   * @param {'movie'|'tv'} mediaType
   * @returns {Promise<Array<{id: number, name: string, backdrops: string[]}>>}
   */
  function fetchGenreSlider(mediaType) {
    if (genreSliderCache.has(mediaType)) return genreSliderCache.get(mediaType);
    const promise = JE.jellyseerrAPI.fetchGenreSlider(mediaType).catch(() => []);
    genreSliderCache.set(mediaType, promise);
    return promise;
  }

  P.logPrefix = logPrefix;
  P.sidebar = sidebar;
  P.pluginPagesExists = pluginPagesExists;
  P.state = state;
  P.fetchWithManagedRequest = fetchWithManagedRequest;
  P.FILTER_MODULE = FILTER_MODULE;
  P.SORT_MODULE = SORT_MODULE;
  P.localDay = localDay;
  P.shownForType = shownForType;
  P.isTrendingPath = isTrendingPath;
  P.feedRequest = feedRequest;
  P.feedPage = feedPage;
  P.keepLoaded = keepLoaded;
  P.isNarrowed = isNarrowed;
  P.filterSignature = filterSignature;
  P.clearFilters = clearFilters;
  P.addressHoldsFilters = addressHoldsFilters;
  P.fetchAllRows = fetchAllRows;
  P.fetchGenreSlider = fetchGenreSlider;
})();
