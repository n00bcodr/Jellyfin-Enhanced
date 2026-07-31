// /js/jellyseerr/recommendations/recommendations-data.js
// Recommendations Page — shared state, Seerr/TMDB fetch helpers and the
// studio/network logo cache (split from recommendations.js).
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
   * Fetches all media rows in parallel. One failing/empty category never
   * blanks the whole page - each row is rendered independently.
   * @param {AbortSignal} signal
   * @returns {Promise<Array<{row: Object, results: Array}>>}
   */
  async function fetchAllRows(signal) {
    const settled = await Promise.allSettled(
      P.ROWS.map(row => fetchWithManagedRequest(`${row.path}?page=1`, { signal }))
    );

    return settled.map((outcome, i) => ({
      row: P.ROWS[i],
      results: outcome.status === 'fulfilled' ? (outcome.value?.results || []) : [],
    }));
  }

  P.logPrefix = logPrefix;
  P.sidebar = sidebar;
  P.pluginPagesExists = pluginPagesExists;
  P.state = state;
  P.fetchWithManagedRequest = fetchWithManagedRequest;
  P.fetchLogoPath = fetchLogoPath;
  P.fetchAllRows = fetchAllRows;
})();
