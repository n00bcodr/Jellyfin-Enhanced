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

  // Populated by renderInto() before the genre tile rows are built, so
  // resolveCategory can look up a genre's display name by id on click.
  P.MOVIE_GENRES = [];
  P.TV_GENRES = [];

  /**
   * Resolves a category key (row key, "studio-<id>", "network-<id>", or
   * "genre-<movie|tv>-<id>") to its base fetch path and display title.
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

    const genreMatch = categoryKey.match(/^genre-(movie|tv)-(\d+)$/);
    if (genreMatch) {
      const [, kind, genreId] = genreMatch;
      const list = kind === 'movie' ? P.MOVIE_GENRES : P.TV_GENRES;
      const genre = list.find(g => String(g.id) === genreId);
      if (genre) {
        const type = kind === 'movie' ? 'movies' : 'tv';
        return { path: `/JellyfinEnhanced/jellyseerr/discover/${type}/genre/${genre.id}`, title: genre.name };
      }
    }

    return null;
  }

  P.ROWS = ROWS;
  P.STUDIOS = STUDIOS;
  P.NETWORKS = NETWORKS;
  P.resolveCategory = resolveCategory;
})();
