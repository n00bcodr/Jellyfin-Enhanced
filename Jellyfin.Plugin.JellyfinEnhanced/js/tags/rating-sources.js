(() => {
"use strict";
(() => {
  // client/src/features/media-tags/rules-host.ts
  function tagRulesHost() {
    const host = window;
    if (!host.JellyfinEnhanced)
      throw new Error("Jellyfin Enhanced must load before tag rules");
    return host.JellyfinEnhanced;
  }

  // client/src/features/media-tags/types/ratings/rating-data.ts
  var IDS = ["community", "critic", "imdb", "tmdb", "rtCritic", "rtAudience", "metacritic", "letterboxd", "trakt"];
  var NAMES = { "imdb": "IMDb", "tmdb": "TMDb", "metacritic": "Metacritic", "letterboxd": "Letterboxd", "trakt": "Trakt" };
  var NAME_KEYS = { community: "rating_source_community", critic: "rating_source_critic", rtCritic: "rating_source_rtCritic", rtAudience: "rating_source_rtAudience" };
  var COLORS = { community: "#ffc107", critic: "#ef4135", imdb: "#f5c518", tmdb: "#01b4a4", rtCritic: "#ef4135", rtAudience: "#ffeab0", metacritic: "#ffcc33", letterboxd: "#00e054", trakt: "#ed1c24" };
  var LOGOS = { "imdb": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 16"><path fill="#f5c518" d="M1 2H23V14H1Z"/><path fill="#151515" d="M3 4H5V12H3ZM7 4H10L11 8L12 4H15V12H13V7L12 12H10L9 7V12H7ZM17 4H20L22 6V10L20 12H17ZM19 6V10H20V6Z"/></svg>', "tmdb": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#01b4a4" d="M1 3H15V7H1ZM9 9H23V13H9Z"/></svg>', "rtCritic": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#ef4135" d="M4 7C1 17 9 23 15 20C23 18 23 7 16 6C12 3 7 3 4 7Z"/><path fill="#48a848" d="M12 8L6 2L11 4L14 0L15 5L21 3L17 8Z"/></svg>', "rtAudience": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#ffeab0" d="M4 9C0 6 3 2 6 4C5 0 10 0 12 3C15 0 20 1 18 5C23 4 25 9 20 11Z"/><path fill="#e64b40" d="M4 10H21L18 23H7ZM8 11L10 21H12L11 11ZM15 11L14 21H16L18 11Z"/></svg>', "metacritic": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#ffcc33" d="M1 1H23V23H1Z"/><path fill="#202020" d="M4 7H7V9C9 6 12 6 14 9C18 5 21 7 21 11V18H18V11C18 9 15 9 15 12V18H12V11C12 9 8 9 8 12V18H4Z"/></svg>', "letterboxd": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#ff8000" d="M0 12A5 5 0 1 0 10 12A5 5 0 1 0 0 12"/><path fill="#00e054" d="M7 12A5 5 0 1 0 17 12A5 5 0 1 0 7 12"/><path fill="#40bcf4" d="M14 12A5 5 0 1 0 24 12A5 5 0 1 0 14 12"/></svg>', "trakt": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#ed1c24" d="M1 12A11 11 0 1 0 23 12A11 11 0 1 0 1 12"/><path fill="#ffffff" d="M4 13L10 7L12 9L6 15ZM8 17L15 10L17 12L10 19ZM13 18L18 13L20 15L15 20Z"/></svg>' };
  var LOGO_FILES = { imdb: "imdb.png", tmdb: "tmdb.png", trakt: "trakt.png", letterboxd: "letterboxd.png", metacritic: "metacritic.png", rtAudience: "rottentomatoes_audience.png" };

  // client/src/features/media-tags/types/ratings/rating-view.ts
  function sourceName(id, translate) {
    return NAMES[id] || translate(NAME_KEYS[id] || id);
  }
  function createRatingView(host) {
    const document2 = host.document;
    const logoFile = (id, value) => id === "rtCritic" ? value < 60 ? "rottentomatoes_rotten.png" : "rottentomatoes_fresh.png" : LOGO_FILES[id];
    function logo(id, value) {
      const el = document2.createElement("span");
      el.className = "je-rating-source-logo";
      el.setAttribute("aria-hidden", "true");
      const file = logoFile(id, value);
      if (file && host.assetUrl) {
        const img = document2.createElement("img");
        img.src = host.assetUrl("mdblist-logos", file);
        img.alt = "";
        img.decoding = "async";
        el.appendChild(img);
      } else {
        el.innerHTML = LOGOS[id] || "";
      }
      return el;
    }
    function chip(fact) {
      const el = document2.createElement("div");
      const legacy = fact.id === "community" ? " rating-tag-tmdb" : fact.id === "critic" ? " rating-tag-critic" : " rating-tag--source";
      el.className = "rating-tag" + legacy;
      el.dataset.jeRatingSource = fact.id;
      el.style.setProperty("--je-rating-source-color", COLORS[fact.id] || "");
      if (fact.color)
        el.style.color = fact.color;
      el.title = sourceName(fact.id, host.translate) + ": " + fact.text;
      el.setAttribute("aria-label", el.title);
      const icon = fact.id === "community" || fact.id === "critic" ? document2.createElement("span") : logo(fact.id, fact.value);
      if (fact.id === "community") {
        icon.className = "material-icons rating-star-icon";
        icon.textContent = "star";
      }
      if (fact.id === "critic")
        icon.className = "rating-tomato-icon " + (fact.value < 60 ? "rotten" : "fresh");
      icon.setAttribute("aria-hidden", "true");
      const text = document2.createElement("span");
      text.className = "rating-text";
      text.textContent = fact.text;
      el.append(icon, text);
      return el;
    }
    return { chip };
  }

  // client/src/features/media-tags/types/ratings/rating-sources.ts
  function isRatingSource(value) {
    return typeof value === "string" && IDS.some((id) => id === value);
  }
  function normalizeSources(value) {
    return Array.isArray(value) ? [...new Set(value.filter(isRatingSource))] : null;
  }
  function settings(user = {}, admin = {}) {
    const enabled = (personal, server) => typeof personal === "boolean" ? personal : server !== false;
    const minimum = Number(user.ratingTagsMinScore ?? admin.RatingTagsMinScore ?? 0);
    return {
      sources: normalizeSources(user.ratingTagsSources) ?? ["critic", "community"].filter((id) => id === "community" ? enabled(user.ratingTagsShowCommunity, admin.RatingTagsShowCommunity) : enabled(user.ratingTagsShowCritic, admin.RatingTagsShowCritic)),
      minimum: Number.isFinite(minimum) ? Math.max(0, Math.min(10, minimum)) : 0,
      color: (user.ratingTagsColorByScore ?? admin.RatingTagsColorByScore) === true
    };
  }
  function maximum(id) {
    return id === "community" || id === "imdb" ? 10 : id === "letterboxd" ? 5 : 100;
  }
  function scoreColor(score) {
    if (score < 5)
      return "#ef5350";
    if (score >= 7.5)
      return "#66bb6a";
    const t = (score - 5) / 2.5;
    return "#" + [255 - 153 * t, 179 + 8 * t, 106 * t].map((n) => Math.round(n).toString(16).padStart(2, "0")).join("");
  }
  function valueOf(ratings, id) {
    if (!ratings || typeof ratings !== "object")
      return null;
    const values = Object.fromEntries(Object.entries(ratings));
    return values[id] ?? values[id.charAt(0).toUpperCase() + id.slice(1)] ?? null;
  }
  function resolve(community, critic, ratings, conf, localNumber = String) {
    return conf.sources.flatMap((id) => {
      const raw = id === "community" ? community : id === "critic" ? critic : valueOf(ratings, id);
      if (raw === null || raw === void 0 || raw === "" || !Number.isFinite(Number(raw)))
        return [];
      const value = Math.max(0, Math.min(maximum(id), Number(raw)));
      const score = value * 10 / maximum(id);
      if (score < conf.minimum)
        return [];
      const text = id === "community" && value === 0 ? "—" : localNumber(maximum(id) <= 10 ? value.toFixed(1) : Math.round(value) + (id === "metacritic" ? "" : "%"));
      return [{ id, value, text, color: conf.color ? scoreColor(score) : null }];
    });
  }
  function createRatingSources(host) {
    const policy = (user = host.settings(), admin = host.config()) => settings(user, admin);
    return {
      IDS,
      COLORS,
      normalizeSources,
      settings: policy,
      scoreColor,
      name: (id) => sourceName(id, host.translate),
      resolve: (community, critic, ratings, conf = policy()) => resolve(community, critic, ratings, conf, host.localNumber),
      chip: createRatingView(host).chip
    };
  }

  // client/src/features/media-tags/types/ratings/rating-sources-entry.ts
  var bridge = tagRulesHost();
  bridge.ratingSources = createRatingSources({
    document,
    translate: (key) => bridge.t(key),
    get assetUrl() {
      return bridge.cdn?.url?.bind(bridge.cdn);
    },
    settings: () => bridge.currentSettings || {},
    config: () => bridge.pluginConfig || {},
    localNumber: (text) => bridge.core?.mediaLanguage?.formatNumberText(text) ?? String(text)
  });
})();
})();
//# sourceMappingURL=rating-sources.js.map
