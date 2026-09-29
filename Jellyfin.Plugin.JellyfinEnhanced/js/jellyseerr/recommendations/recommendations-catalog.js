// /js/jellyseerr/recommendations/recommendations-catalog.js
// Recommendations Page — the fixed row/studio/network catalogue and the
// category-key resolver (split from recommendations.js).
(function () {
  "use strict";

  const JE = window.JellyfinEnhanced;
  JE.internals = JE.internals || {};
  const P = (JE.internals.recommendationsPage = JE.internals.recommendationsPage || {});

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
  // discovery/network-discovery.js's TV_NETWORKS map for consistency.
  // companyId is the TMDB production company whose movies the network's
  // category page shows beside its series (Seerr filters movies by company
  // and series by network); left out where TMDB has no clean company for
  // the service, in which case the page stays series-only.
  const NETWORKS = [
    { name: 'Netflix', id: 213, companyId: 178464 },
    { name: 'HBO', id: 49, companyId: 3268 },
    { name: 'Disney+', id: 2739 },
    { name: 'Apple TV+', id: 2552, companyId: 194232 },
    { name: 'Amazon Prime Video', id: 1024, companyId: 210099 },
    { name: 'Hulu', id: 453 },
    { name: 'Paramount+', id: 4330 },
    { name: 'FX', id: 88, companyId: 15990 },
    { name: 'BBC', id: 4, companyId: 3324 },
    { name: 'Showtime', id: 67, companyId: 148935 },
    { name: 'Starz', id: 318, companyId: 8034 },
    { name: 'AMC', id: 174, companyId: 122304 },
    { name: 'Adult Swim', id: 80, companyId: 6759 },
    { name: 'Nickelodeon', id: 13, companyId: 2348 },
    { name: 'Crunchyroll', id: 1112, companyId: 198847 },
    { name: 'The CW', id: 71, companyId: 218482 },
  ];

  // Populated by renderInto() before the genre tile rows are built, so
  // resolveCategory can look up a genre's display name by id on click.
  P.MOVIE_GENRES = [];
  P.TV_GENRES = [];

  /**
   * Resolves a category key (row key, "studio-<id>", "network-<id>", or
   * "genre-<movie|tv>-<id>") to its display title and feeds. Each feed is a
   * base fetch path paged via ?page=N. Most categories are one feed; a studio
   * pages its movies beside the series it produced (the plugin's TMDB-backed
   * feed, so only with a TMDB key configured) and a network pages its series
   * beside its production company's movies, so the category page can offer
   * All | Movies | Series.
   * @param {string} categoryKey
   * @returns {{title: string, feeds: Array<{path: string, mediaType?: 'movie'|'tv'}>}|null}
   */
  function resolveCategory(categoryKey) {
    const row = ROWS.find(r => r.key === categoryKey);
    if (row) {
      return { title: JE.t(row.titleKey), feeds: [{ path: row.path }] };
    }

    const studioMatch = categoryKey.match(/^studio-(\d+)$/);
    if (studioMatch) {
      const studio = STUDIOS.find(s => String(s.id) === studioMatch[1]);
      if (studio) {
        const feeds = [{ path: `/JellyfinEnhanced/jellyseerr/discover/movies/studio/${studio.id}`, mediaType: 'movie' }];
        if (JE.pluginConfig?.TmdbEnabled) {
          feeds.push({ path: `/JellyfinEnhanced/jellyseerr/discover/tv/studio/${studio.id}`, mediaType: 'tv' });
        }
        return { title: studio.name, feeds };
      }
    }

    const networkMatch = categoryKey.match(/^network-(\d+)$/);
    if (networkMatch) {
      const network = NETWORKS.find(n => String(n.id) === networkMatch[1]);
      if (network) {
        const feeds = [{ path: `/JellyfinEnhanced/jellyseerr/discover/tv/network/${network.id}`, mediaType: 'tv' }];
        if (network.companyId) {
          feeds.push({ path: `/JellyfinEnhanced/jellyseerr/discover/movies/studio/${network.companyId}`, mediaType: 'movie' });
        }
        return { title: network.name, feeds };
      }
    }

    const genreMatch = categoryKey.match(/^genre-(movie|tv)-(\d+)$/);
    if (genreMatch) {
      const [, kind, genreId] = genreMatch;
      const list = kind === 'movie' ? P.MOVIE_GENRES : P.TV_GENRES;
      const genre = list.find(g => String(g.id) === genreId);
      if (genre) {
        const type = kind === 'movie' ? 'movies' : 'tv';
        return { title: genre.name, feeds: [{ path: `/JellyfinEnhanced/jellyseerr/discover/${type}/genre/${genre.id}` }] };
      }
    }

    return null;
  }

  P.ROWS = ROWS;
  P.STUDIOS = STUDIOS;
  P.NETWORKS = NETWORKS;
  P.resolveCategory = resolveCategory;
})();
