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
  // logo is the entry's TMDB logo_path, kept here (as Seerr's own Studios and
  // Networks sliders do) so the tile rows need no lookups, with or without a
  // TMDB key; a logo TMDB later moves falls back to the text tile.
  const STUDIOS = [
    { name: 'Marvel Studios', id: 420, logo: '/hUzeosd33nzE5MCNsZxCGEKTXaQ.png' },
    { name: 'Pixar', id: 3, logo: '/1TjvGVDMYsj6JBxOAkUHpPEwLf7.png' },
    { name: 'Walt Disney Pictures', id: 2, logo: '/wdrCwmRnLFJhEoH8GSfymY85KHT.png' },
    { name: 'Warner Bros. Pictures', id: 174, logo: '/zhD3hhtKB5qyv7ZeL4uLpNxgMVU.png' },
    { name: 'Universal Pictures', id: 33, logo: '/8lvHyhjr8oUKOOy2dKXoALWKdp0.png' },
    { name: 'Paramount Pictures', id: 4, logo: '/jay6WcMgagAklUt7i9Euwj1pzTF.png' },
    { name: 'Lucasfilm', id: 1, logo: '/tlVSws0RvvtPBwViUyOFAO0vcQS.png' },
    { name: 'Illumination', id: 6704, logo: '/fOG2oY4m1YuYTQh4bMqqZkmgOAI.png' },
    { name: 'DreamWorks Animation', id: 521, logo: '/3BPX5VGBov8SDqTV7wC1L1xShAS.png' },
    { name: 'Sony Pictures', id: 34, logo: '/xAb1o9HrSvKBo9mnXC8fJKDNu00.png' },
    { name: '20th Century Studios', id: 127928, logo: '/h0rjX5vjW5r8yEnUBStFarjcLT4.png' },
    { name: 'Legendary Pictures', id: 923, logo: '/5UQsZrfbfG2dYJbx8DxfoTr2Bvu.png' },
    { name: 'A24', id: 41077, logo: '/1ZXsGaFPgrgS6ZZGS37AqD5uU12.png' },
    { name: 'Blumhouse Productions', id: 3172, logo: '/rzKluDcRkIwHZK2pHsiT667A2Kw.png' },
    { name: 'Metro-Goldwyn-Mayer', id: 21, logo: '/usUnaYV6hQnlVAXP6r4HwrlLFPG.png' },
    { name: 'Columbia Pictures', id: 5, logo: '/71BqEFAF4V3qjjMPCpLuyJFB9A.png' },
  ];

  // Curated TMDB network IDs. Reuses the same IDs already vetted in
  // discovery/network-discovery.js's TV_NETWORKS map for consistency.
  // companyId is the TMDB production company whose movies the network's
  // category page shows beside its series (Seerr filters movies by company
  // and series by network); left out where TMDB has no clean company for
  // the service, in which case the page stays series-only.
  const NETWORKS = [
    { name: 'Netflix', id: 213, companyId: 178464, logo: '/wwemzKWzjKYJFfCeiB57q3r4Bcm.png' },
    { name: 'HBO', id: 49, companyId: 3268, logo: '/tuomPhY2UtuPTqqFnKMVHvSb724.png' },
    { name: 'Disney+', id: 2739, logo: '/1edZOYAfoyZyZ3rklNSiUpXX30Q.png' },
    { name: 'Apple TV+', id: 2552, companyId: 194232, logo: '/bngHRFi794mnMq34gfVcm9nDxN1.png' },
    { name: 'Amazon Prime Video', id: 1024, companyId: 210099, logo: '/w7HfLNm9CWwRmAMU58udl2L7We7.png' },
    { name: 'Hulu', id: 453, logo: '/pqUTCleNUiTLAVlelGxUgWn1ELh.png' },
    { name: 'Paramount+', id: 4330, logo: '/fi83B1oztoS47xxcemFdPMhIzK.png' },
    { name: 'FX', id: 88, companyId: 15990, logo: '/aexGjtcs42DgRtZh7zOxayiry4J.png' },
    { name: 'BBC', id: 4, companyId: 3324, logo: '/uJjcCg3O4DMEjM0xtno9OWFciRP.png' },
    { name: 'Showtime', id: 67, companyId: 148935, logo: '/Allse9kbjiP6ExaQrnSpIhkurEi.png' },
    { name: 'Starz', id: 318, companyId: 8034, logo: '/qx3Y9LCaK4mq1ykFuDIfjshlo3U.png' },
    { name: 'AMC', id: 174, companyId: 122304, logo: '/pmvRmATOCaDykE6JrVoeYxlFHw3.png' },
    { name: 'Adult Swim', id: 80, companyId: 6759, logo: '/tHZPHOLc6iF27G34cAZGPsMtMSy.png' },
    { name: 'Nickelodeon', id: 13, companyId: 2348, logo: '/i0e7qsKhCcB6EJy0qvjhnFB2lgp.png' },
    { name: 'Crunchyroll', id: 1112, companyId: 198847, logo: '/qqyXcZlJQKlRmAD1TCKV7mGLQlt.png' },
    { name: 'The CW', id: 71, companyId: 218482, logo: '/hEpcdJ4O6eitG9ADSnDXNUrlovS.png' },
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
