(() => {
"use strict";
(() => {
  // client/src/host/context.ts
  function sharedModule(id) {
    const namespace = window.JellyfinEnhanced?.core?.sharedModules?.[id];
    if (!namespace) throw new Error(`${id} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);
    return namespace;
  }
  function sharedExport(namespace, name) {
    return namespace[name];
  }

  // client/generated-shared/stub/client/src/features/details-providers/host.ts
  var shared = /* @__PURE__ */ sharedModule("features/details-providers/host");
  var export1 = /* @__PURE__ */ sharedExport(shared, "bridge");
  var export3 = /* @__PURE__ */ sharedExport(shared, "currentUserId");

  // client/generated-shared/stub/client/src/features/details-providers/page.ts
  var shared2 = /* @__PURE__ */ sharedModule("features/details-providers/page");
  var export0 = /* @__PURE__ */ sharedExport(shared2, "detailPageHook");
  var export12 = /* @__PURE__ */ sharedExport(shared2, "detailsLease");
  var export32 = /* @__PURE__ */ sharedExport(shared2, "hashItemId");
  var export7 = /* @__PURE__ */ sharedExport(shared2, "lookupDetailsItem");
  var export9 = /* @__PURE__ */ sharedExport(shared2, "removeFirst");

  // client/generated-shared/stub/client/src/features/details-providers/links.ts
  var shared3 = /* @__PURE__ */ sharedModule("features/details-providers/links");
  var export02 = /* @__PURE__ */ sharedExport(shared3, "externalLink");
  var export2 = /* @__PURE__ */ sharedExport(shared3, "pathSegment");

  // client/generated-shared/stub/client/src/features/details-providers/wire.ts
  var shared4 = /* @__PURE__ */ sharedModule("features/details-providers/wire");
  var export5 = /* @__PURE__ */ sharedExport(shared4, "field");
  var export6 = /* @__PURE__ */ sharedExport(shared4, "int");
  var export72 = /* @__PURE__ */ sharedExport(shared4, "isRecord");
  var export92 = /* @__PURE__ */ sharedExport(shared4, "num");
  var export11 = /* @__PURE__ */ sharedExport(shared4, "str");
  var export13 = /* @__PURE__ */ sharedExport(shared4, "text");

  // client/src/features/details-providers/provider-domain.ts
  async function resolveProviderTarget(item, allowPerson, seriesLookup) {
    const type = item?.Type;
    if (!item) return { target: null, unsupported: true };
    if (type === "Movie") return { target: wrap(item.ProviderIds.Tmdb, "movie"), unsupported: false };
    if (type === "Person" && allowPerson) return { target: wrap(item.ProviderIds.Tmdb, "person"), unsupported: false };
    if (type === "Series" || type === "Season" || type === "Episode") {
      let tmdbId;
      if (type === "Series") tmdbId = item.ProviderIds.Tmdb;
      else if (item.SeriesId) {
        try {
          tmdbId = (await seriesLookup(item.SeriesId))?.ProviderIds.Tmdb;
        } catch {
        }
      }
      return { target: wrap(tmdbId, "tv"), unsupported: false };
    }
    return { target: null, unsupported: true };
  }
  function wrap(tmdbId, mediaType) {
    return tmdbId ? { tmdbId, mediaType } : null;
  }
  function isUnconfirmed(value) {
    return export5(value, "Confirmed") === false;
  }
  function decodeMdblistEntry(value) {
    if (!export72(value) || !value.Found || !Array.isArray(value.Ratings) || value.Ratings.length === 0) return null;
    const ids = {};
    if (export72(value.Ids)) {
      for (const [key, id] of Object.entries(value.Ids)) {
        const decoded = typeof id === "number" && Number.isFinite(id) ? String(id) : export13(id);
        if (decoded !== void 0) ids[key] = decoded;
      }
    }
    return {
      Found: true,
      Ids: ids,
      Ratings: value.Ratings.filter(export72).map((rating) => ({
        Source: export11(rating.Source) ?? "",
        // Rendered into markup: only finite numbers are scores.
        Value: export92(rating.Value) ?? null,
        Score: export92(rating.Score) ?? null,
        Votes: export92(rating.Votes) ?? null,
        Url: export11(rating.Url) ?? null,
        Fresh: export6(rating.Fresh) ?? null
      }))
    };
  }
  var MDBLIST_LABELS = {
    master: "Master",
    imdb: "IMDb",
    tmdb: "TMDB",
    trakt: "Trakt",
    letterboxd: "Letterboxd",
    tomatoes: "RT Critic",
    popcorn: "RT Audience",
    metacritic: "Metascore",
    metacriticuser: "Metacritic User",
    rogerebert: "Roger Ebert",
    myanimelist: "MAL",
    anilist: "AniList"
  };
  var MDBLIST_LOGOS = {
    master: "master.png",
    imdb: "imdb.png",
    tmdb: "tmdb.png",
    trakt: "trakt.png",
    letterboxd: "letterboxd.png",
    tomatoes: "rottentomatoes.png",
    popcorn: "rottentomatoes_audience.png",
    metacritic: "metacritic.png",
    metacriticuser: "metacritic_audience.png",
    rogerebert: "rogerebert.png",
    myanimelist: "myanimelist.png",
    anilist: "anilist.png"
  };
  var TOMATOES_STATUS_LOGOS = { 1: "rottentomatoes_fresh.png", 0: "rottentomatoes_rotten.png" };
  var MDBLIST_DEFAULT_ORDER = ["tmdb", "tomatoes", "popcorn", "imdb", "trakt", "metacritic"];
  var own = (map, key) => Object.prototype.hasOwnProperty.call(map, key) ? map[key] : void 0;
  var localSlug = (value) => (value || "").toLowerCase().replace(/'/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  function mdblistLink(sourceKey, ids, apiUrl, mediaType, title) {
    const sLink = String(apiUrl || "");
    const safeTitle = encodeURIComponent(title || "");
    const safeType = mediaType === "tv" ? "tv" : "movie";
    const id = (key) => own(ids, key);
    const path = (value) => encodeURIComponent(value);
    if (sLink.startsWith("http") && sourceKey !== "metacriticuser" && sourceKey !== "rogerebert") return sLink;
    switch (sourceKey) {
      case "imdb": {
        const v = id("imdb");
        return v ? `https://www.imdb.com/title/${path(v)}/` : null;
      }
      case "tmdb": {
        const v = id("tmdb");
        return v ? `https://www.themoviedb.org/${safeType}/${path(v)}` : null;
      }
      case "trakt": {
        const v = id("trakt");
        return v ? `https://trakt.tv/${safeType === "tv" ? "shows" : "movies"}/${path(v)}` : null;
      }
      case "letterboxd":
        return sLink.includes("/film/") || sLink.includes("/slug/") ? `https://letterboxd.com${sLink.startsWith("/") ? "" : "/"}${sLink}` : null;
      case "metacritic":
      case "metacriticuser":
        return title ? `https://www.metacritic.com/${safeType}/${localSlug(title)}` : null;
      case "tomatoes":
      case "popcorn":
        if (sLink.startsWith("/")) return `https://www.rottentomatoes.com${sLink}`;
        return sLink.length > 2 ? `https://www.rottentomatoes.com/m/${sLink}` : null;
      case "anilist": {
        const v = id("anilist");
        return v ? `https://anilist.co/anime/${path(v)}` : title ? `https://anilist.co/search/anime?search=${safeTitle}` : null;
      }
      case "myanimelist": {
        const v = id("mal");
        return v ? `https://myanimelist.net/anime/${path(v)}` : title ? `https://myanimelist.net/anime.php?q=${safeTitle}` : null;
      }
      case "rogerebert":
        return sLink.length > 2 ? `https://www.rogerebert.com/reviews/${sLink}` : title ? `https://duckduckgo.com/?q=!ducky+site:rogerebert.com/reviews+${safeTitle}` : null;
      default:
        return null;
    }
  }
  function configuredSources(raw) {
    return (raw || "").split(",").map((source) => source.trim().toLowerCase()).filter(Boolean);
  }
  function mdblistBadges(entry, mediaType, title, sources, showPercent) {
    const order = sources.length ? sources : MDBLIST_DEFAULT_ORDER;
    const rank = (rating) => {
      const index = order.indexOf(rating.Source.toLowerCase());
      return index === -1 ? order.length : index;
    };
    return entry.Ratings.filter((rating) => rating.Score !== null || rating.Value !== null).filter((rating) => sources.length === 0 || sources.includes(rating.Source.toLowerCase())).sort((a, b) => rank(a) - rank(b)).map((rating) => {
      const normalized = rating.Score;
      const score = normalized ?? rating.Value ?? 0;
      const sourceKey = rating.Source.toLowerCase();
      const label = own(MDBLIST_LABELS, sourceKey) || rating.Source;
      const freshState = normalized !== null ? normalized >= 60 ? 1 : 0 : rating.Fresh;
      const freshLogo = sourceKey === "tomatoes" && freshState !== null ? own(TOMATOES_STATUS_LOGOS, String(freshState)) : void 0;
      return {
        label,
        logo: freshLogo || own(MDBLIST_LOGOS, sourceKey),
        link: mdblistLink(sourceKey, entry.Ids, rating.Url, mediaType, title),
        // A raw fallback Value keeps its precision (rogerebert's 3.5 stays 3.5).
        scoreText: normalized !== null ? Math.round(normalized) + (showPercent ? "%" : "") : String(score),
        score,
        votes: rating.Votes
      };
    });
  }
  var RUNTIME_PATTERN = /^\d+\s*(?:h(?:ours?)?)?\s*\d*\s*m(?:inutes?)?$/i;

  // client/src/features/details-providers/mdblist-ratings.ts
  var JE = export1("MDBList ratings");
  var enabled = () => !!JE.pluginConfig?.MdblistRatingsEnabled && !!JE.pluginConfig.MdblistRatingsShowOnItemDetails;
  JE.initializeMdblistRatingsScript = function initializeMdblistRatingsScript() {
    if (!enabled()) {
      console.log("🪼 Jellyfin Enhanced: MDBList Ratings feature disabled.");
      return;
    }
    const logPrefix = "🪼 Jellyfin Enhanced: MDBList Ratings:";
    const sectionClass = "je-mdblist-ratings-section";
    const escapeHtml = (value) => typeof JE.escapeHtml === "function" ? JE.escapeHtml(value) : String(value);
    function injectCss() {
      const styleId = "je-mdblist-ratings-styles";
      if (document.getElementById(styleId)) return;
      const style = document.createElement("style");
      style.id = styleId;
      style.textContent = `
                .${sectionClass} {
                    display: flex;
                    flex-wrap: wrap;
                    align-items: center;
                    gap: 5px;
                    margin: 1em 0;
                    font-size: 1.05em;
                }
                .${sectionClass} .je-mdblist-badge {
                    display: inline-flex;
                    align-items: center;
                    gap: 6px;
                    text-decoration: none;
                    color: inherit;
                    font-size: inherit;
                }
                .${sectionClass} a.je-mdblist-badge {
                    cursor: pointer;
                }
                .${sectionClass} a.je-mdblist-badge:hover {
                    text-decoration: underline;
                }
                .${sectionClass} .je-mdblist-badge .je-mdblist-source {
                    opacity: 0.7;
                    font-size: 0.9em;
                }
                .${sectionClass} .je-mdblist-badge .je-mdblist-logo {
                    height: 22px;
                    width: auto;
                    object-fit: contain;
                }
            `;
      document.head.appendChild(style);
    }
    function removeSection(page) {
      try {
        export9(page, `.${sectionClass}`);
      } catch (e) {
        console.warn(`${logPrefix} removeSection failed:`, e);
      }
    }
    function buildSection(entry, mediaType, title) {
      const wrap2 = document.createElement("div");
      wrap2.className = sectionClass;
      const badges = mdblistBadges(
        entry,
        mediaType,
        title,
        configuredSources(JE.pluginConfig?.MdblistRatingsSources),
        !!JE.pluginConfig?.MdblistRatingsShowPercentSymbol
      );
      for (const badge of badges) {
        const votesText = badge.votes ? ` (${JE.t("mdblist_ratings_votes", { count: badge.votes })})` : "";
        const badgeTitle = `${badge.label}: ${badge.score}${votesText}`;
        const iconHtml = badge.logo ? `<img class="je-mdblist-logo" src="${escapeHtml(JE.cdn.url("mdblist-logos", badge.logo))}" alt="${escapeHtml(badge.label)}" loading="lazy">` : `<span class="je-mdblist-source">${escapeHtml(badge.label)}</span>`;
        const badgeHtml = `${iconHtml}<span>${escapeHtml(badge.scoreText)}</span>`;
        const element = badge.link ? export02(JE.helpers, badge.link, { className: "je-mdblist-badge", title: badgeTitle, resetStyle: true, setup: (anchor) => {
          anchor.innerHTML = badgeHtml;
        } }) : Object.assign(document.createElement("span"), { className: "je-mdblist-badge", title: badgeTitle, innerHTML: badgeHtml });
        wrap2.appendChild(element);
      }
      return wrap2;
    }
    function findInsertionTarget(contextPage) {
      const official = contextPage.querySelector("div.mediaInfoItem.mediaInfoOfficialRating");
      if (official) return official;
      for (const element of contextPage.querySelectorAll("div.mediaInfoItem")) {
        if (RUNTIME_PATTERN.test((element.textContent ?? "").trim())) return element;
      }
      return null;
    }
    function insertSection(contextPage, entry, mediaType, title) {
      removeSection(contextPage);
      if (!entry) return;
      const section = buildSection(entry, mediaType, title);
      if (section.children.length === 0) return;
      const target = findInsertionTarget(contextPage);
      const scope = target && (target.closest(".detailRibbon") || target.closest(".mainDetailButtons") || target.closest(".itemMiscInfo")) || target?.parentNode;
      const extLinks = (scope && "querySelector" in scope ? scope.querySelector(".itemExternalLinks") : null) || contextPage.querySelector(".itemExternalLinks");
      if (extLinks?.parentNode) {
        extLinks.insertAdjacentElement("beforebegin", section);
        return;
      }
      if (target?.parentNode) {
        target.insertAdjacentElement("afterend", section);
        return;
      }
      const afterAnchor = contextPage.querySelector(".je-awards-section") || contextPage.querySelector(".tmdb-reviews-section") || contextPage.querySelector(".streaming-lookup-container") || contextPage.querySelector(".tagline");
      if (afterAnchor?.parentNode) {
        afterAnchor.parentNode.insertBefore(section, afterAnchor.nextSibling);
        return;
      }
      const beforeAnchor = contextPage.querySelector("#similarCollapsible");
      if (beforeAnchor?.parentNode) {
        beforeAnchor.parentNode.insertBefore(section, beforeAnchor);
        return;
      }
      console.warn(`${logPrefix} Could not find a suitable anchor to insert the ratings row.`);
    }
    async function fetchRatings(tmdbId, apiMediaType) {
      try {
        const cacheKey = `mdblist-ratings:/${apiMediaType}/${tmdbId}`;
        const data = await JE.core.api.plugin(`/mdblist-ratings/${apiMediaType}/${export2(tmdbId)}`, { cacheKey });
        if (isUnconfirmed(data)) JE.core.api.manager.clearCacheMatching(cacheKey);
        return decodeMdblistEntry(data);
      } catch (e) {
        console.warn(`${logPrefix} Failed to fetch ratings.`, e);
        return null;
      }
    }
    async function processPage(visiblePage) {
      if (!enabled()) {
        removeSection(visiblePage);
        return;
      }
      try {
        const itemId = export32();
        const userId = export3();
        if (!itemId || !userId) return;
        const lease = export12(JE.session, itemId, visiblePage);
        const item = await export7(JE.helpers, itemId, true, userId);
        const { target } = await resolveProviderTarget(item, false, (seriesId) => export7(JE.helpers, seriesId, true, userId));
        if (!lease.current()) return;
        if (!target) {
          if (lease.current()) removeSection(visiblePage);
          return;
        }
        const type = item?.Type;
        const title = type === "Season" || type === "Episode" ? item?.SeriesName || item?.Name : item?.Name;
        const entry = await fetchRatings(target.tmdbId, target.mediaType);
        if (lease.current()) insertSection(visiblePage, entry, target.mediaType, title);
      } catch (error) {
        console.error(`${logPrefix} Error processing page:`, error);
      }
    }
    injectCss();
    const unregister = JE.helpers.onViewPage(
      export0(enabled, () => unregister?.(), (page) => {
        void processPage(page);
      }, true),
      { pages: null, fetchItem: false, immediate: true }
    );
  };
})();
})();
//# sourceMappingURL=mdblist-ratings.js.map
