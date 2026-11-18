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

  // client/src/features/seerr/discovery/filters.ts
  var FEED_FILTERS = ["year", "score", "votes", "runtime", "genres", "withoutGenres", "language", "withoutLanguage", "rating", "services", "keywords", "without"];
  var PERSON_FILTERS = ["role", "year", "score", "votes", "genres", "withoutGenres", "language", "withoutLanguage"];
  var LOADED_FILTERS = ["year", "score", "votes", "genres", "withoutGenres", "language", "withoutLanguage"];
  var FILTER_SWITCHES = Object.freeze({
    role: "JellyseerrFilterRole",
    year: "JellyseerrFilterYear",
    score: "JellyseerrFilterScore",
    votes: "JellyseerrFilterVotes",
    runtime: "JellyseerrFilterRuntime",
    genres: "JellyseerrFilterGenres",
    language: "JellyseerrFilterLanguage",
    rating: "JellyseerrFilterContentRating",
    services: "JellyseerrFilterStreaming",
    keywords: "JellyseerrFilterKeywords",
    without: "JellyseerrFilterKeywords",
    withoutGenres: "JellyseerrFilterGenres",
    withoutLanguage: "JellyseerrFilterLanguage"
  });
  var RANGE_IDS = ["year", "score", "votes", "runtime"];
  var MATCH_DEFAULTS = Object.freeze({ genres: "all", keywords: "all", services: "any" });
  var GENRE_ROUTE = /\/genre\/(\d+)(?:$|[/?])/;
  var KEYWORD_ROUTE = /\/keyword\/\d+(?:$|[/?])/;
  var LIST_IDS = ["role", "genres", "withoutGenres", "language", "withoutLanguage", "rating", "services", "keywords", "without"];
  var RANGE_PARAMS = Object.freeze({ score: "voteAverage", votes: "voteCount", runtime: "withRuntime" });
  var isRecord = (value) => typeof value === "object" && value !== null;
  var isRangeId = (id) => id === "year" || id === "score" || id === "votes" || id === "runtime";
  function offeredFilters(scope, config) {
    const switches = isRecord(config) ? config : null;
    const ids = scope === "person" ? PERSON_FILTERS : scope === "loaded" ? LOADED_FILTERS : FEED_FILTERS;
    return ids.filter((id) => switches?.[FILTER_SWITCHES[id]] !== false);
  }
  var isRangeSet = (range) => !!range && (range[0] !== "" || range[1] !== "");
  function activeFilterCount(selection) {
    const chosen = selection || {};
    return RANGE_IDS.map((id) => chosen[id]).filter(isRangeSet).length + LIST_IDS.map((id) => chosen[id]).filter((list) => !!list && list.length > 0).length;
  }
  function matchOf(selection, id) {
    const chosen = selection?.match?.[id];
    return chosen === "all" || chosen === "any" ? chosen : MATCH_DEFAULTS[id];
  }
  function routeFeed(path, kind, selection, query) {
    let asked = query;
    let keep = null;
    const ownGenre = GENRE_ROUTE.exec(path)?.[1];
    if (ownGenre && matchOf(selection, "genres") === "any") {
      const ticked = (selection?.genres ?? []).map((genre) => genreIdFor(genre, kind)).filter((id) => id !== ownGenre);
      const others = ticked.filter((id) => id !== "");
      if (ticked.length > 0) {
        asked = asked.replace(/&genre=[^&]*/, "");
        if (others.length === 0) asked += `&${kind === "tv" ? "firstAirDate" : "primaryReleaseDate"}Lte=1800-01-01`;
        else keep = (item) => Array.isArray(item?.genreIds) && item.genreIds.some((id) => others.includes(String(id)));
      }
    }
    if (KEYWORD_ROUTE.test(path)) asked = asked.replace(/(&keywords=)([^&]*)/, (_, name, value) => name + value.replace(/%7C/gi, "%2C"));
    const allowed = notExcluded(selection, kind);
    if (allowed) {
      const kept = keep;
      keep = kept ? (item) => kept(item) && allowed(item) : allowed;
    }
    return { query: asked, keep };
  }
  function notExcluded(selection, kind) {
    const genres = selection?.withoutGenres ?? [];
    const languages = new Set((selection?.withoutLanguage ?? []).map((language) => language.id));
    if (genres.length === 0 && languages.size === 0) return null;
    return (item) => {
      const own = Array.isArray(item?.genreIds) ? item.genreIds.map(String) : [];
      const itemKind = kind ?? (item?.mediaType === "tv" ? "tv" : "movie");
      if (genres.some((genre) => {
        const id = genreIdFor(genre, itemKind);
        return id !== "" && own.includes(id);
      })) return false;
      return !(languages.size > 0 && typeof item?.originalLanguage === "string" && languages.has(item.originalLanguage));
    };
  }
  function checkableOnLoaded(selection) {
    const chosen = selection || {};
    return !isRangeSet(chosen.runtime) && [chosen.role, chosen.rating, chosen.services, chosen.keywords, chosen.without].every((list) => !list || list.length === 0);
  }
  function dayOf(text, last) {
    const typed = String(text ?? "").trim();
    if (/^\d{4}$/.test(typed)) return `${typed}-${last ? "12-31" : "01-01"}`;
    const month = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(typed);
    if (month) return `${typed}-${last ? String(new Date(Date.UTC(Number(month[1]), Number(month[2]), 0)).getUTCDate()).padStart(2, "0") : "01"}`;
    return /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(typed) ? typed : null;
  }
  function numberOf(id, text) {
    const typed = String(text ?? "").trim().replace(",", ".");
    if (id === "score") {
      const score = /^\d{1,2}(\.\d)?$/.test(typed) ? Number(typed) : NaN;
      return score >= 0 && score <= 10 ? score : null;
    }
    return /^\d{1,7}$/.test(typed) ? Number(typed) : null;
  }
  function isBound(id, text, upper) {
    return String(text ?? "").trim() === "" || (id === "year" ? dayOf(text, upper) !== null : numberOf(id, text) !== null);
  }
  function isReversed(id, range) {
    const [from, to] = range;
    if (from.trim() === "" || to.trim() === "") return false;
    if (id === "year") {
      const first = dayOf(from, false);
      const last = dayOf(to, true);
      return first !== null && last !== null && first > last;
    }
    const low = numberOf(id, from);
    const high = numberOf(id, to);
    return low !== null && high !== null && low > high;
  }
  var genreIdFor = (genre, kind) => genre.id.split("/")[kind === "movie" ? 0 : 1] ?? "";
  function feedFilterQuery(selection, kind, region) {
    const chosen = selection || {};
    const pairs = [];
    const date = kind === "tv" ? "firstAirDate" : "primaryReleaseDate";
    const anyGenre = matchOf(chosen, "genres") === "any";
    const allGenres = (chosen.genres ?? []).map((genre) => genreIdFor(genre, kind));
    const genres = anyGenre ? allGenres.filter(Boolean) : allGenres;
    if (genres.includes("") || anyGenre && allGenres.length > 0 && genres.length === 0) return `&${date}Lte=1800-01-01`;
    const from = chosen.year ? dayOf(chosen.year[0], false) : null;
    const to = chosen.year ? dayOf(chosen.year[1], true) : null;
    if (from) pairs.push([`${date}Gte`, from]);
    if (to) pairs.push([`${date}Lte`, to]);
    for (const id of ["score", "votes", "runtime"]) {
      const range = chosen[id];
      const low = range ? numberOf(id, range[0]) : null;
      const high = range ? numberOf(id, range[1]) : null;
      if (low !== null) pairs.push([`${RANGE_PARAMS[id]}Gte`, String(low)]);
      if (high !== null) pairs.push([`${RANGE_PARAMS[id]}Lte`, String(high)]);
    }
    const join = (id) => matchOf(chosen, id) === "any" ? "|" : ",";
    if (genres.length > 0) pairs.push(["genre", genres.join(join("genres"))]);
    if (chosen.language?.length) pairs.push(["language", chosen.language.map((language) => language.id).join("|")]);
    const ratings = (chosen.rating ?? []).map((rating) => rating.id.split(":")).filter((parts) => parts[0] === kind && parts.length === 3);
    if (chosen.rating?.length && ratings.length === 0) return `&${date}Lte=1800-01-01`;
    if (ratings.length > 0) {
      pairs.push(["certification", ratings.map((parts) => parts[2] ?? "").join("|")], ["certificationCountry", ratings[0]?.[1] ?? "US"]);
    }
    if (chosen.services?.length) pairs.push(["watchProviders", chosen.services.map((service) => service.id).join(join("services"))], ["watchRegion", region]);
    if (chosen.keywords?.length) pairs.push(["keywords", chosen.keywords.map((keyword) => keyword.id).join(join("keywords"))]);
    if (chosen.without?.length) pairs.push(["excludeKeywords", chosen.without.map((keyword) => keyword.id).join(",")]);
    return pairs.map(([name, value]) => `&${name}=${encodeURIComponent(value)}`).join("");
  }
  function keepByFilters(results, selection) {
    const chosen = selection || {};
    if (activeFilterCount(chosen) === 0) return results;
    const from = chosen.year ? dayOf(chosen.year[0], false) : null;
    const to = chosen.year ? dayOf(chosen.year[1], true) : null;
    const bounds = ["score", "votes"].map((id) => {
      const range = chosen[id];
      return [id, range ? numberOf(id, range[0]) : null, range ? numberOf(id, range[1]) : null];
    });
    const languages = new Set((chosen.language ?? []).map((language) => language.id));
    const allowed = notExcluded(chosen);
    return results.filter((item) => {
      if (allowed && !allowed(item)) return false;
      if (chosen.role?.length && !chosen.role.some((role) => role.id === "cast" ? item.jeCredit?.acted === true : item.jeCredit?.departments?.includes(role.id) === true)) return false;
      if (from || to) {
        const date = (typeof item.releaseDate === "string" && item.releaseDate ? item.releaseDate : typeof item.firstAirDate === "string" ? item.firstAirDate : "").slice(0, 10);
        if (!date || from && date < from || to && date > to) return false;
      }
      for (const [id, low, high] of bounds) {
        const value = Number(id === "score" ? item.voteAverage : item.voteCount) || 0;
        if (low !== null && value < low || high !== null && value > high) return false;
      }
      if (chosen.genres?.length) {
        const own = Array.isArray(item.genreIds) ? item.genreIds.map(String) : [];
        const kind = item.mediaType === "tv" ? "tv" : "movie";
        const has = (genre) => own.includes(genreIdFor(genre, kind)) && genreIdFor(genre, kind) !== "";
        if (!(matchOf(chosen, "genres") === "any" ? chosen.genres.some(has) : chosen.genres.every(has))) return false;
      }
      return languages.size === 0 || typeof item.originalLanguage === "string" && languages.has(item.originalLanguage);
    });
  }
  function rolesOf(results, actingName, nameOf2) {
    const counts = /* @__PURE__ */ new Map();
    let acted = 0;
    for (const item of results || []) {
      if (item.jeCredit?.acted) acted++;
      for (const department of item.jeCredit?.departments ?? []) counts.set(department, (counts.get(department) ?? 0) + 1);
    }
    const crew = Array.from(counts).sort((a, b) => Number(a[0] === "Crew") - Number(b[0] === "Crew") || b[1] - a[1] || a[0].localeCompare(b[0])).map(([id]) => ({ id, name: nameOf2(id) }));
    return acted > 0 ? [{ id: "cast", name: actingName }, ...crew] : crew;
  }

  // client/src/features/seerr/discovery/address.ts
  var TYPE_PARAM = "jeType";
  var SORT_PARAM = "jeSort";
  var CATEGORY_PARAM = "jeCategory";
  var RANGE_PARAMS2 = [["year", "jeReleased"], ["score", "jeScore"], ["votes", "jeVotes"], ["runtime", "jeRuntime"]];
  var LIST_PARAMS = [
    ["role", "jeRole", /^(?:cast|[A-Z][A-Za-z]{0,20}(?:[ &-]{1,3}[A-Za-z]{1,20}){0,3})$/, false],
    ["genres", "jeGenres", /^(?:\d{1,9}\/\d{0,9}|\/\d{1,9})$/, true],
    ["withoutGenres", "jeWithoutGenres", /^(?:\d{1,9}\/\d{0,9}|\/\d{1,9})$/, true],
    ["language", "jeLanguage", /^[a-z]{2}$/, false],
    ["withoutLanguage", "jeWithoutLanguage", /^[a-z]{2}$/, false],
    ["rating", "jeRating", /^(?:movie|tv):[A-Z]{2}:[A-Za-z0-9+\- ]{1,12}$/, false],
    ["services", "jeServices", /^\d{1,9}$/, true],
    ["keywords", "jeKeywords", /^\d{1,9}$/, true],
    ["without", "jeWithout", /^\d{1,9}$/, true]
  ];
  var ANY_PARAM = "jeAny";
  var ALL_PARAM = "jeAll";
  var MATCHED = ["genres", "keywords", "services"];
  var MAX_LIST = 50;
  var MAX_NAME = 80;
  var MAX_BOUND = 10;
  var OWN_PARAMS = /* @__PURE__ */ new Set([
    TYPE_PARAM,
    SORT_PARAM,
    CATEGORY_PARAM,
    ANY_PARAM,
    ALL_PARAM,
    ...RANGE_PARAMS2.map((entry) => entry[1]),
    ...LIST_PARAMS.map((entry) => entry[1])
  ]);
  var HOME_HASH = /^(?:#\/home(?:\.html)?(?:\?[^#]*)?(?:#.*)?)?$/;
  var PAGE_HASH = /^#\/recommendations(?:\?[^#]*)?(?:#.*)?$/;
  var CATEGORY_KEY = /^(?:[a-z]+(?:-[a-z]+)?|(?:studio|network)-\d{1,9}|genre-(?:movie|tv)-\d{1,9})$/;
  function split(hash) {
    const text = String(hash || "");
    const mark = text.indexOf("#", 1);
    const head = mark < 0 ? text : text.slice(0, mark);
    const at = head.indexOf("?");
    return {
      head,
      route: at < 0 ? head : head.slice(0, at),
      pairs: at < 0 ? [] : head.slice(at + 1).split("&").filter(Boolean),
      fragment: mark < 0 ? null : text.slice(mark + 1).split("&").filter(Boolean)
    };
  }
  var nameOf = (pair) => pair.split("=")[0] || "";
  function ownPairs(hash) {
    const { pairs, fragment } = split(hash);
    return (fragment ?? pairs).filter((pair) => OWN_PARAMS.has(nameOf(pair)));
  }
  var decode = (raw) => {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  };
  var rawOf = (pairs, name) => {
    const pair = pairs.find((entry) => nameOf(entry) === name);
    return pair === void 0 ? null : pair.slice(name.length + 1);
  };
  var valueOf = (pairs, name) => {
    const raw = rawOf(pairs, name);
    return raw === null ? null : decode(raw);
  };
  var readable = (text) => encodeURIComponent(text).replace(/%2F/gi, "/").replace(/%3A/gi, ":");
  var isHomeHash = (hash) => HOME_HASH.test(String(hash ?? ""));
  var isRecommendationsHash = (hash) => isHomeHash(hash) || PAGE_HASH.test(String(hash ?? ""));
  function createDiscoveryAddress(JE) {
    const label = (key, fallback) => {
      const text = typeof JE.t === "function" ? JE.t(key) : "";
      return text && text !== key ? text : fallback;
    };
    const matchDefault = (id) => JE.discoveryFilters?.MATCH_DEFAULTS?.[id] ?? MATCH_DEFAULTS[id];
    const isBound2 = (id, text, upper) => typeof JE.discoveryFilters?.isBound === "function" ? JE.discoveryFilters.isBound(id, text, upper) : String(text ?? "").trim() === "";
    const sortValues = () => (JE.discoveryFilter?.SORT_OPTIONS ?? []).map((option) => option.value);
    const roleName = (id) => id === "cast" ? label("discovery_role_acting", "Acting") : label(`discovery_role_${id.toLowerCase().replace(/[^a-z]+/g, "_")}`, id);
    function filtersOfHash(hash, locale) {
      const pairs = ownPairs(hash);
      const type = valueOf(pairs, TYPE_PARAM);
      const mode = type === "movies" ? "movies" : type === "series" ? "tv" : "mixed";
      const selection = {};
      for (const [id, param] of RANGE_PARAMS2) {
        const value = valueOf(pairs, param);
        const at = value ? value.indexOf("..") : -1;
        if (!value || at < 0) continue;
        const bounds = [value.slice(0, at).trim(), value.slice(at + 2).trim()].map((bound, index) => bound.length <= MAX_BOUND && isBound2(id, bound, index === 1) ? bound : "");
        const range = [bounds[0] ?? "", bounds[1] ?? ""];
        if (range[0] || range[1]) selection[id] = range;
      }
      let names = null;
      try {
        names = new Intl.DisplayNames([locale || document.documentElement.lang || "en"], { type: "language" });
      } catch {
        names = null;
      }
      for (const [id, param, shape, named] of LIST_PARAMS) {
        const raw = rawOf(pairs, param);
        if (!raw) continue;
        const items = [];
        for (const entry of raw.split(",").slice(0, MAX_LIST)) {
          const at = named ? entry.indexOf(":") : -1;
          const itemId = decode(at < 0 ? entry : entry.slice(0, at)).trim();
          if (!shape.test(itemId) || items.some((item) => item.id === itemId)) continue;
          let name = at < 0 ? "" : decode(entry.slice(at + 1)).trim().slice(0, MAX_NAME);
          if (id === "role") name = roleName(itemId);
          if (id === "rating") name = itemId.split(":")[2] || itemId;
          if (id === "language" || id === "withoutLanguage") {
            try {
              name = names?.of(itemId) || "";
            } catch {
              name = "";
            }
          }
          items.push({ id: itemId, name: name || itemId });
        }
        if (items.length > 0) selection[id] = items;
      }
      const match = {};
      for (const [param, value] of [[ANY_PARAM, "any"], [ALL_PARAM, "all"]]) {
        for (const id of (valueOf(pairs, param) || "").split(",")) {
          const matched = MATCHED.find((entry) => entry === id);
          if (matched && selection[matched] && value !== matchDefault(matched)) match[matched] = value;
        }
      }
      if (Object.keys(match).length > 0) selection.match = match;
      const sort = valueOf(pairs, SORT_PARAM) || "";
      return { mode, selection, sort: sort && sortValues().includes(sort) ? sort : "" };
    }
    function filterPairs(filters, withSort) {
      const pairs = [];
      const selection = filters.selection || {};
      if (filters.mode === "movies" || filters.mode === "tv") pairs.push(`${TYPE_PARAM}=${filters.mode === "tv" ? "series" : "movies"}`);
      for (const [id, param] of RANGE_PARAMS2) {
        const range = selection[id];
        const [from = "", to = ""] = [String(range?.[0] ?? "").trim(), String(range?.[1] ?? "").trim()].map((bound, index) => isBound2(id, bound, index === 1) ? bound : "");
        if (from || to) pairs.push(`${param}=${readable(from)}..${readable(to)}`);
      }
      for (const [id, param, , named] of LIST_PARAMS) {
        const items = selection[id] ?? [];
        if (items.length === 0) continue;
        pairs.push(`${param}=${items.map((item) => named ? `${readable(String(item.id))}:${encodeURIComponent(String(item.name ?? ""))}` : readable(String(item.id))).join(",")}`);
      }
      const matched = (value) => MATCHED.filter((id) => (selection[id] ?? []).length > 0 && value !== matchDefault(id) && (selection.match?.[id] ?? matchDefault(id)) === value);
      for (const [param, value] of [[ANY_PARAM, "any"], [ALL_PARAM, "all"]]) {
        const ids = matched(value);
        if (ids.length > 0) pairs.push(`${param}=${ids.join(",")}`);
      }
      if (withSort && filters.sort) pairs.push(`${SORT_PARAM}=${encodeURIComponent(filters.sort)}`);
      return pairs;
    }
    function categoryOfHash(hash) {
      if (!isRecommendationsHash(hash)) return null;
      const key = valueOf(ownPairs(hash), CATEGORY_PARAM);
      return key && CATEGORY_KEY.test(key) ? key : null;
    }
    function addressWith(hash, category, filters, withSort) {
      const { head, pairs, fragment } = split(hash);
      const own = category ? [`${CATEGORY_PARAM}=${encodeURIComponent(category)}`] : [];
      own.push(...filterPairs(filters, withSort));
      const inQuery = pairs.filter((pair) => OWN_PARAMS.has(nameOf(pair)));
      if (fragment === null && own.join("&") === inQuery.join("&")) return hash;
      if (own.length === 0 && inQuery.length === 0) return head;
      return `${head || "#/home"}#${own.join("&")}`;
    }
    function withoutOwn(hash) {
      const { route, pairs } = split(hash);
      const kept = pairs.filter((pair) => !OWN_PARAMS.has(nameOf(pair)));
      return kept.length > 0 ? `${route}?${kept.join("&")}` : route;
    }
    function current(filterModule, sortModule) {
      const filter = JE.discoveryFilter;
      return {
        mode: filter?.getFilterMode?.(filterModule) || "mixed",
        selection: JE.discoveryFilters?.selectionOf?.(filterModule) || {},
        sort: sortModule ? filter?.getSortMode?.(sortModule) || "" : ""
      };
    }
    function filtersOf(text, scope = "feed") {
      const source = String(text ?? "");
      const said2 = filtersOfHash(source.startsWith("#") || source.includes("?") ? source : `#?${source}`);
      const offered = JE.discoveryFilters?.offeredFilters?.(scope, JE.pluginConfig) ?? [];
      const selection = {};
      for (const [id, range] of RANGE_PARAMS2.map(([id2]) => [id2, said2.selection[id2]])) {
        if (range && offered.includes(id)) selection[id] = range;
      }
      for (const [id] of LIST_PARAMS) {
        const list = said2.selection[id];
        if (list && offered.includes(id)) selection[id] = list;
      }
      const match = {};
      for (const id of MATCHED) {
        const value = said2.selection.match?.[id];
        if (value && offered.includes(id)) match[id] = value;
      }
      if (Object.keys(match).length > 0) selection.match = match;
      return { mode: said2.mode, selection, sort: said2.sort };
    }
    function adopt(filterModule, sortModule, options = {}) {
      const withType = options.withType !== false;
      const withSort = options.withSort ?? !!sortModule;
      const now = current(filterModule, withSort ? sortModule : null);
      const said2 = filtersOf(window.location.hash, options.scope || "feed");
      const wanted = { mode: withType ? said2.mode : now.mode, selection: said2.selection, sort: withSort ? said2.sort : "" };
      if (filterPairs(wanted, withSort).join("&") === filterPairs(now, withSort).join("&")) return false;
      JE.discoveryFilter?.setFilterMode?.(filterModule, wanted.mode);
      JE.discoveryFilters?.setSelection?.(filterModule, wanted.selection);
      if (withSort && sortModule) {
        if (wanted.sort) JE.discoveryFilter?.setSortMode?.(sortModule, wanted.sort);
        else JE.discoveryFilter?.resetSortMode?.(sortModule);
      }
      return true;
    }
    function go(hash, options = {}) {
      const url = `${window.location.pathname}${window.location.search}${hash}`;
      const push = options.push === true;
      const state = "state" in options ? options.state : push ? null : history.state;
      const navigation = JE.core?.navigation;
      if (typeof navigation?.setAddressQuietly === "function") navigation.setAddressQuietly(state, url, push);
      else if (push) history.pushState(state, "", url);
      else history.replaceState(state, "", url);
    }
    function write(filterModule, sortModule, withSort = !!sortModule) {
      const hash = window.location.hash;
      const next = addressWith(hash, categoryOfHash(hash), current(filterModule, withSort ? sortModule : null), withSort);
      if (next !== hash) go(next);
    }
    return {
      OWN_PARAMS,
      isHomeHash,
      isRecommendationsHash,
      filtersOfHash,
      filtersOf,
      filterPairs,
      categoryOfHash,
      addressWith,
      withoutOwn,
      current,
      adopt,
      write,
      go
    };
  }

  // client/src/features/seerr/discovery/discovery-busy.css
  var discovery_busy_default = `/* Where the open menu covers the list (a phone, a narrow window): a change that takes long shows in the menu's foot that it is still being fetched (the same circle, after the same moment). */
/* (In the middle of the foot: beside "Done" it would read as Done's own, as if closing the menu had to wait.) */
.jellyseerr-sort-menu .jellyseerr-menu-foot { position: relative; }
.jellyseerr-menu-busy { display: none; position: absolute; inset-inline-start: max(50%, calc(var(--jellyseerr-clear-end, 0px) + 1.7em)); top: 50%; transform: translate(-50%, -50%); margin: 0; pointer-events: none; }
html[dir="rtl"] .jellyseerr-menu-busy { transform: translate(50%, -50%); }
.jellyseerr-menu-busy .mdl-spinner { display: block; width: 1.4em; height: 1.4em; }
/* Where the menu stands over the list's own circle (data-over-list: a phone, a TV, a narrow window), its foot shows it instead. On a TV at the foot's end (where the rows' values end; "Clear filters" has the remote's ground). */
html:has(.jellyseerr-discovery-section .itemsContainer[aria-busy="true"]) .jellyseerr-sort-menu[data-over-list] .jellyseerr-menu-busy { display: block; animation: jellyseerr-busy-in 0s linear .8s both; }
html.layout-tv .jellyseerr-menu-busy, html.layout-tv[dir="rtl"] .jellyseerr-menu-busy { inset-inline: auto 1em; transform: translateY(-50%); }

/* A list being replaced (a new order, a filter) stays on screen, dimmed, until the new one is in. (After a moment: a quick answer does not flicker.) */
.jellyseerr-discovery-section .itemsContainer[aria-busy="true"] { opacity: .45; pointer-events: none; transition: opacity .15s linear .2s; }
/* A change that takes long shows that it is still working: Jellyfin's own loading circle over the list, after
   a moment, in sight wherever the section is read. It takes no room and no presses. */
/* (Read mid-list it stands in the middle of the screen, as Jellyfin's own does; at the join it rests on the first row's posters, under their pills, so it is not read as one card's mark.) */
.jellyseerr-busy { display: none; position: sticky; top: calc(50vh - 5.8em); z-index: 2; height: 0; justify-content: center; overflow: visible; pointer-events: none; }
.jellyseerr-discovery-section:has(.itemsContainer[aria-busy="true"]) .jellyseerr-busy { display: flex; animation: jellyseerr-busy-in 0s linear .8s both; }
/* A menu standing over any part of it shows the circle in its own foot instead (discovery-menu.js, data-over-list). */
html:has(.jellyseerr-sort-menu[data-over-list]) .jellyseerr-discovery-section:has(.itemsContainer) .jellyseerr-busy { display: none; }
@keyframes jellyseerr-busy-in { from { visibility: hidden; } to { visibility: visible; } }
.jellyseerr-busy .mdl-spinner { flex: none; width: 2.6em; height: 2.6em; margin-top: 4.5em; }
/* (So does the line that said nothing matched the filters before: it is as old as the list.) */
.jellyseerr-discovery-section .itemsContainer[aria-busy="true"] ~ .jellyseerr-filters-none { opacity: .45; pointer-events: none; transition: opacity .15s linear .2s; }
@media (prefers-reduced-motion: reduce) { .jellyseerr-discovery-section .itemsContainer[aria-busy="true"], .jellyseerr-discovery-section .itemsContainer[aria-busy="true"] ~ .jellyseerr-filters-none { transition: none; } }
`;

  // client/src/features/seerr/discovery/discovery.css
  var discovery_default = `/* ===== Discovery sections: the join with the page =====
   A ruled header where the library's own list ends: the title, then one row with what
   the titles are (not in the library) and the controls. While the section is being read
   that row is held at the top of the screen, under Jellyfin's header: the rule and the
   title scroll on under it, and the row shows the title in the place of its line of words. */
.jellyseerr-discovery-section { margin-top: 1.5em; }
.jellyseerr-discovery-header { --jellyseerr-line: var(--jf-palette-divider, rgba(255,255,255,.12)); position: sticky; top: calc(var(--jellyseerr-sticky-top, 3.5em) - var(--jellyseerr-header-tuck, 0px)); z-index: 3; padding: .8em 0 .5em; border-top: 1px solid transparent; border-bottom: 1px solid transparent; }
/* The rule, and the row of controls, end where the first row of cards does (the script measures it); the title keeps the column's width. */
.jellyseerr-discovery-header::before { content: ''; position: absolute; inset-block-start: -1px; inset-inline: 0 var(--jellyseerr-trim, 0px); height: 1px; background: var(--jellyseerr-line); }
/* The section's lines (the rule, the hairline under a held header, the one beside the sort) are one
   strength: that of the dividers in Jellyfin's toolbar, taken from the text's colour so it follows the theme. */
@supports (color: color-mix(in srgb, red 30%, transparent)) { .jellyseerr-discovery-header { --jellyseerr-line: color-mix(in srgb, currentColor 30%, transparent); } }
/* Held: a hairline under it, and nothing of it behind Jellyfin's bar (a theme's bar may be see-through). */
/* At the join the header has no ground of its own (a theme's page may be a gradient or a backdrop picture).
   Held, it needs one for the cards passing under it, and it is then a bar under Jellyfin's own, flat as
   that one is: the theme's ground across the whole screen with a hairline under it (the line's colour
   on that ground, so it does not change over what passes), and nothing of it behind Jellyfin's bar. */
.jellyseerr-discovery-header { --jellyseerr-ground: var(--jf-palette-background-default, #101010); --jellyseerr-held-line: var(--jellyseerr-line); }
@supports (color: color-mix(in srgb, red 30%, transparent)) { .jellyseerr-discovery-header { --jellyseerr-held-line: color-mix(in srgb, currentColor 30%, var(--jellyseerr-ground)); } }
.jellyseerr-discovery-header[data-stuck] { border-image: linear-gradient(to bottom, var(--jellyseerr-ground) calc(100% - 1px), var(--jellyseerr-held-line) 0) fill 0 / 0 / 0 100vmax; clip-path: inset(var(--jellyseerr-header-tuck, 0px) -100vmax -1em); }
/* A long name takes a second line; it is never cut on the first (the name is the point of the title). */
.jellyseerr-discovery-header > .sectionTitle { margin: 0; padding: 0; overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow-wrap: anywhere; }
/* The title takes focus when the viewer is brought to the section; it is not a control and shows no ring. */
.jellyseerr-discovery-header > .sectionTitle:focus { outline: none; }
/* The name the title is about stays whole when the title takes two lines. */
.jellyseerr-discovery-name { display: inline-block; max-width: 100%; }
/* Held, the title above the row is out of sight (the row says it): nothing of it shows in the air kept above the row. */
.jellyseerr-discovery-header[data-stuck] > .sectionTitle { opacity: 0; }
/* For measuring a held title as the page lays it out; never seen. */
.jellyseerr-discovery-probe { position: absolute; visibility: hidden; font-size: 1.15em; white-space: nowrap; }
/* One row, on one baseline: the line of words (or, held, the title) and the controls at its end. */
/* (The gap is small: the controls bring their own room before their first word, and a held title needs the row's.) */
.jellyseerr-discovery-meta { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: baseline; column-gap: .4em; margin-inline-end: var(--jellyseerr-trim, 0px); }
.jellyseerr-discovery-meta::before, .jellyseerr-discovery-summary { grid-area: 1 / 1; min-width: 0; margin: 0; transition: opacity .15s, visibility .15s; }
.jellyseerr-discovery-summary { padding-block: .15em; color: var(--jf-palette-text-secondary, rgba(255,255,255,.7)); }
.jellyseerr-discovery-meta::before { content: attr(data-title); content: attr(data-title) / ''; font-size: 1.15em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: 0; visibility: hidden; }
.jellyseerr-discovery-header[data-stuck] .jellyseerr-discovery-meta::before { opacity: 1; visibility: visible; }
/* (Out of sight only: a screen reader still reads the line of words, and does not hear the title twice.) */
.jellyseerr-discovery-header[data-stuck] .jellyseerr-discovery-summary { opacity: 0; }
.jellyseerr-discovery-bar { grid-area: 1 / 2; justify-self: end; display: flex; align-items: center; gap: .5em 1em; min-width: 0; }
.jellyseerr-discovery-bar:empty { display: none; }
.jellyseerr-discovery-filter { display: inline-flex; align-items: center; min-width: 0; }
/* Filter and sort are no taller than their words (each keeps 44px to press, the ::after), so the row
   is the same height at the join and held, at every width. */
.jellyseerr-discovery-filter .jellyseerr-filter-btn { padding: .55em .9em; min-height: 2.75em; font-size: inherit; }
/* All three types always show: a theme's rule for a third tab of its own (Zesty hides a library's
   Trailers tab with button.emby-tab-button:nth-child(3)) would otherwise take Series away. */
.jellyseerr-discovery-filter .jellyseerr-filter-btn.emby-tab-button { display: inline-flex; }
.jellyseerr-discovery-header .jellyseerr-filter-btn { position: relative; padding-block: .2em; min-height: 0; overflow: visible; }
.jellyseerr-discovery-header .jellyseerr-filter-btn::after { content: ''; position: absolute; inset: 50% 0 auto; height: 44px; transform: translateY(-50%); }
/* The chosen filter: the theme's accent, as Jellyfin marks the page you are on in its top bar, and a
   line under the word, so it is not told by colour alone. The accent is taken part of the way to
   the text's colour, which keeps it readable on a light theme and brighter than its neighbours on a dark one. */
.jellyseerr-discovery-header, .jellyseerr-join-jump, .jellyseerr-sort-menu { --jellyseerr-accent: var(--jf-palette-primary-main, #00a4dc); }
@supports (color: color-mix(in oklab, red 60%, blue)) { .jellyseerr-discovery-header, .jellyseerr-join-jump, .jellyseerr-sort-menu { --jellyseerr-accent: color-mix(in oklab, var(--jf-palette-primary-main, #00a4dc) 60%, var(--jf-palette-text-primary, #fff)); } }
.jellyseerr-discovery-header .jellyseerr-filter-btn.emby-tab-button-active { color: var(--jellyseerr-accent); text-decoration: underline 2px; text-underline-offset: .32em; }
/* The sort: a quiet text button in the filter tabs' type and weight that names the current order,
   with a small chevron on the text's line; no box, no fill, the page's own text colour (as
   Jellyfin's own sort in its toolbar). At least 44px to press. */
.jellyseerr-sort-btn.emby-tab-button, .jellyseerr-filters-btn.emby-tab-button { position: relative; flex: none; margin-block: 0; margin-inline: .3em -.6em; display: inline-flex; align-items: center; gap: .15em; padding: .55em .6em; min-height: 2.75em; font-size: inherit; overflow: visible; cursor: pointer; }
/* In a section's header it is no taller than its words, and its box ends where the column does (so does its focus ring). */
.jellyseerr-discovery-header .jellyseerr-sort-btn.emby-tab-button, .jellyseerr-discovery-header .jellyseerr-filters-btn.emby-tab-button { margin-inline: .3em 0; padding: .2em .1em .2em .6em; min-height: 0; }
.jellyseerr-sort-btn.emby-tab-button:hover, .jellyseerr-sort-btn.emby-tab-button:focus-visible,
.jellyseerr-filters-btn.emby-tab-button:hover, .jellyseerr-filters-btn.emby-tab-button:focus-visible { color: var(--jf-palette-text-primary, #fff); }
.jellyseerr-sort-btn .material-icons, .jellyseerr-filters-btn .material-icons { font-size: 1.25em; line-height: 1; margin-inline-end: -.2em; }
.jellyseerr-sort-btn::after, .jellyseerr-filters-btn::after { content: ''; position: absolute; inset: 50% 0 auto; height: max(100%, 44px); transform: translateY(-50%); }
.jellyseerr-discovery-header .jellyseerr-sort-btn::after { inset-inline-end: -.5em; }
/* On a phone, held, the tabs' place shows the section's title (below). */
.jellyseerr-filter-held { display: none; }
/* A ring for keyboard focus, and for any focus on a TV (where the remote moves it). A shadow: Jellyfin removes outlines from its buttons. */
.jellyseerr-sort-btn:focus-visible, .layout-tv .jellyseerr-sort-btn:focus, .jellyseerr-filters-btn:focus-visible,
.jellyseerr-filter-btn:focus-visible, .layout-tv .jellyseerr-filter-btn:focus { box-shadow: 0 0 0 .14em var(--jellyseerr-accent, var(--jf-palette-primary-main, #00a4dc)); border-radius: .3em; }
/* On a TV the control the remote is on has a ground in the accent, not a ring (a ringed word reads as a boxed field). */
.layout-tv .jellyseerr-discovery-header .jellyseerr-sort-btn:focus, .layout-tv .jellyseerr-discovery-header .jellyseerr-filter-btn:focus, .layout-tv .jellyseerr-discovery-header .jellyseerr-filters-btn:focus,
.layout-tv .jellyseerr-filters-token:focus-within, .layout-tv .jellyseerr-filters-clear:focus { border-radius: .3em; box-shadow: 0 0 0 .3em var(--jellyseerr-focus-ground), inset 0 0 0 2em var(--jellyseerr-focus-ground); background: none; }
.jellyseerr-discovery-section { --jellyseerr-focus-ground: rgba(0, 164, 220, .3); }
@supports (color: color-mix(in srgb, red 30%, transparent)) { .jellyseerr-discovery-section { --jellyseerr-focus-ground: color-mix(in srgb, var(--jf-palette-primary-main, #00a4dc) 34%, transparent); } }
/* Beside each other, filter and sort are two controls: a hairline between them, of the strength of
   the ones between the groups of Jellyfin's toolbar (a part of the text's own colour, so it follows the theme). */
@media (min-width: 34.01em) {
    .jellyseerr-discovery-header .jellyseerr-discovery-filter::after { content: ''; flex: none; width: 1px; height: 1.6em; margin-inline-start: 1em; background: var(--jellyseerr-line); }
}
/* On a phone filter and sort take the row under the line of words together. Held, that row shows
   the title where the three tabs were and the filter as one button (Jellyfin's filter icon, with
   the choice in words and in the accent when it narrows the list): title, filter, sort, in one row. */
@media (max-width: 34em) {
    .jellyseerr-discovery-meta { row-gap: .25em; }
    .jellyseerr-discovery-bar[data-has-filter] { grid-area: 2 / 1 / 3 / -1; justify-self: stretch; }
    .jellyseerr-discovery-header[data-has-filter] .jellyseerr-discovery-meta::before { display: none; }
    .jellyseerr-discovery-header .jellyseerr-discovery-filter { position: relative; flex: 1 1 auto; }
    .jellyseerr-discovery-filter .jellyseerr-filter-btn { padding-inline: .7em; }
    .jellyseerr-discovery-header .jellyseerr-filter-btn { transition: opacity .15s, visibility .15s; }
    .jellyseerr-discovery-filter .jellyseerr-filter-btn:first-child { padding-inline-start: 0; }
    .jellyseerr-filter-held { position: absolute; inset: 0; display: flex; align-items: center; gap: .6em; opacity: 0; visibility: hidden; transition: opacity .15s, visibility .15s; }
    .jellyseerr-filter-held-title { flex: 1 1 auto; min-width: 0; font-size: 1.15em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    /* A section whose Filters button holds only All / Movies / Series shows it where the tabs are out of sight. */
    .jellyseerr-discovery-header[data-stuck][data-has-filter] .jellyseerr-filters-btn[data-type-only] { display: inline-flex; }
    /* There the button also stands for All / Movies / Series: a choice other than All shows on it as a filter does. */
    .jellyseerr-discovery-header[data-stuck][data-has-filter] .jellyseerr-filters-btn.emby-tab-button[data-type-on] { color: var(--jellyseerr-accent); }
    .jellyseerr-discovery-header[data-stuck][data-has-filter] .jellyseerr-filters-btn[data-type-on] .jellyseerr-filters-type { display: inline; margin-inline-start: .5em; }
    /* (The title's own words come first: where they only fit without it, the script takes the type's word away.) */
    /* (Out of sight, not out of the page: it is still said to a screen reader, where the tabs are not there to say it.) */
    .jellyseerr-discovery-header[data-stuck][data-has-filter][data-type-word-off] .jellyseerr-filters-btn[data-type-on] .jellyseerr-filters-type { position: absolute; width: 1px; height: 1px; margin: 0; overflow: hidden; clip-path: inset(50%); }
    /* Held, the row is the title and two controls: they stand closer than the tabs and the controls do at the join. */
    .jellyseerr-discovery-header[data-stuck][data-has-filter] .jellyseerr-discovery-bar { column-gap: .25em; }
    .jellyseerr-discovery-header[data-stuck][data-has-filter] .jellyseerr-filters-btn[data-type-on] .material-icons::after { content: ''; position: absolute; inset-block-start: -.06em; inset-inline-end: -.24em; width: .36em; height: .36em; border-radius: 50%; background: currentColor; }
    .jellyseerr-discovery-header[data-stuck] .jellyseerr-filter-held { opacity: 1; visibility: visible; }
    .jellyseerr-discovery-header[data-stuck] .jellyseerr-discovery-filter .jellyseerr-filter-btn { opacity: 0; visibility: hidden; }
}
/* A card brought into view by the keyboard or a remote stops below the held header, not under it. */
.jellyseerr-discovery-section .itemsContainer > .card { scroll-margin-top: calc(var(--jellyseerr-sticky-top, 3.5em) + 6.5em); }
/* Themes such as ElegantFin make .detailSection a multi-column grid; without this the section sits in the first column only. */
.detailSection > .jellyseerr-discovery-section { grid-column: 1 / -1; min-width: 0; }
@media (prefers-reduced-motion: reduce) { .jellyseerr-discovery-meta::before, .jellyseerr-discovery-summary, .jellyseerr-filter-held, .jellyseerr-discovery-filter .jellyseerr-filter-btn { transition: none; } }


/* ===== The join with a list page (studio, genre, tag) =====
   On a single page the library's closing paging line only repeats the one above the list, and
   stands between the list and the section: it goes. A list with more pages keeps it. */
:has(> .jellyseerr-discovery-section) > div:has(> .paging):not(.itemsViewSettingsContainer):not(:has(.btnNextPage, .btnPreviousPage)) { display: none; }
/* Jellyfin's A-Z rail belongs to the library's list: it leaves while it would run beside the section. */
.page:has(.jellyseerr-discovery-section[data-jellyseerr-rail="away"]) .alphaPicker-fixed { opacity: 0; visibility: hidden; transition: opacity .2s, visibility .2s; }
@media (prefers-reduced-motion: reduce) { .page:has(.jellyseerr-discovery-section[data-jellyseerr-rail="away"]) .alphaPicker-fixed { transition: none; } }
/* On a list longer than the screen: one line that goes to the section. It belongs to Jellyfin's
   toolbar: on its axis, nearer to it than to the posters, the action in the weight of the
   toolbar's buttons and the rest of the phrase after it. It is as wide as its words. */
.jellyseerr-join-jump { display: block; width: fit-content; max-width: 100%; min-height: 2.75em; margin: -1em auto 1.4em; padding: .3em .7em; border: 0; border-radius: .3em; background: none; color: inherit; font: inherit; text-align: center; text-wrap: balance; cursor: pointer; }
.jellyseerr-join-jump[hidden] { display: none; }
/* On a detail page (a person) there is no toolbar: the line stands at the start of the page's own lists, on their edge. */
.jellyseerr-join-jump-start { margin: 2.4em 0 -.7em -.7em; text-align: start; }
/* Arriving after the list has drawn (a slow answer from Seerr), it opens its room over a moment instead of dropping the list at once. */
@media (prefers-reduced-motion: no-preference) {
    .jellyseerr-join-jump-late { overflow: hidden; animation: jellyseerr-join-arrive .18s ease-out; }
    @keyframes jellyseerr-join-arrive { from { max-height: 0; min-height: 0; margin-bottom: 0; padding-block: 0; opacity: 0; } to { max-height: 6em; } }
}
/* The action and its name stay whole while they fit: a wrap falls after the comma, not inside the name. */
.jellyseerr-join-jump-lead { display: inline-block; max-width: 100%; }
.jellyseerr-join-jump-go { font-weight: 600; }
.jellyseerr-join-jump:hover .jellyseerr-join-jump-go, .jellyseerr-join-jump:focus-visible .jellyseerr-join-jump-go { color: var(--jf-palette-text-primary, #fff); }
.jellyseerr-join-jump:focus-visible, .layout-tv .jellyseerr-join-jump:focus { outline: none; box-shadow: 0 0 0 .14em var(--jellyseerr-accent); }


/* ===== The sort and filter menus =====
   The menu takes the form Jellyfin's own menus have in the layout in use. On a TV that is
   Jellyfin's action sheet, which its own classes draw. Everywhere else it is the small menu of
   Jellyfin's library pages (under their Sort button): the paper colour raised above the page,
   no title, the page not dimmed, rows as close as Jellyfin's, and the choice in use marked at
   the row's end. Every value is the theme's own. (Where Jellyfin's action-sheet rules are
   marked !important, the same mark is needed here to set the small menu's value.) */
html:not(.layout-tv) .jellyseerr-menu-backdrop { background: none; opacity: 0; }
html:not(.layout-tv) .jellyseerr-sort-menu { min-width: 9.5em; padding: 8px 0; border-radius: var(--jf-shape-borderRadius, 4px) !important; background-color: var(--jf-palette-background-paper, #202020); background-image: var(--jf-overlays-8, none); box-shadow: var(--jf-shadows-8, 0 5px 5px -3px rgba(0,0,0,.2), 0 8px 10px 1px rgba(0,0,0,.14), 0 3px 14px 2px rgba(0,0,0,.12)); color: var(--jf-palette-text-primary, #fff); }
html:not(.layout-tv) .jellyseerr-sort-menu .actionSheetContent, html:not(.layout-tv) .jellyseerr-sort-menu .actionSheetScroller { margin: 0 !important; padding: 0 !important; }
/* One part of a menu scrolls (its rows): a TV's title, and the foot of a menu of groups, stay. */
html:not(.layout-tv) .jellyseerr-sort-menu { display: flex; flex-direction: column; overflow: hidden; }
.jellyseerr-sort-menu .actionSheetContent { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; overflow: hidden; }
.jellyseerr-sort-menu .actionSheetScroller { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; scroll-padding-block: var(--jellyseerr-held, 0px) var(--jellyseerr-cut, 0px); }
.jellyseerr-menu-foot { flex: none; }
/* Where rows go on beyond what is in sight the script cuts the list inside a row, through its name; the edge itself is softened over a few pixels only, so that name stays at full strength. */
.jellyseerr-sort-menu .actionSheetContent[data-more] > .actionSheetScroller { -webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - .5em), transparent); mask-image: linear-gradient(to bottom, #000 calc(100% - .5em), transparent); }
/* Rows above what is in sight: the menu's top has an edge too (not on a TV, where the title is the top; nor where an open group's row is held there). */
html:not(.layout-tv) .jellyseerr-sort-menu .actionSheetContent[data-above]::before { content: ''; flex: none; position: relative; z-index: 3; height: 1px; margin-bottom: -1px; background: var(--jf-palette-divider, rgba(255,255,255,.12)); box-shadow: 0 6px 6px -6px rgba(0,0,0,.5); }
/* (And the foot has an upper edge then, wherever the rows happen to be cut.) */
.jellyseerr-sort-menu .actionSheetContent[data-more] > .jellyseerr-menu-foot { box-shadow: 0 -6px 6px -6px rgba(0,0,0,.5); }
.jellyseerr-sort-menu .actionSheetContent[data-above] > .actionSheetScroller { -webkit-mask-image: linear-gradient(to bottom, transparent, #000 .5em); mask-image: linear-gradient(to bottom, transparent, #000 .5em); }
.jellyseerr-sort-menu .actionSheetContent[data-above][data-more] > .actionSheetScroller { -webkit-mask-image: linear-gradient(to bottom, transparent, #000 .5em, #000 calc(100% - .5em), transparent); mask-image: linear-gradient(to bottom, transparent, #000 .5em, #000 calc(100% - .5em), transparent); }
html:not(.layout-tv) .jellyseerr-sort-menu .actionSheetMenuItem { display: flex; align-items: center; width: 100%; min-height: 0; margin: 0; padding: 6px 16px; border-radius: 0; background: none; box-shadow: none; color: inherit; font-size: inherit; font-weight: 400; line-height: 1.5; text-align: start; }
/* (A finger does not hover: on a touch screen a pressed row would keep the ground and read as chosen.) */
@media (hover: hover) { html:not(.layout-tv) .jellyseerr-sort-menu .actionSheetMenuItem:hover { background: var(--jf-palette-action-hover, rgba(255,255,255,.08)); } }
/* The row the keys are on: Jellyfin's focus ground, and a bar in the accent at its start, which the pointer's ground has not. */
html:not(.layout-tv) .jellyseerr-sort-menu .actionSheetMenuItem:focus-visible { background-color: var(--jf-palette-action-focus, rgba(255,255,255,.12)); box-shadow: inset 3px 0 0 var(--jellyseerr-accent); }
html[dir="rtl"]:not(.layout-tv) .jellyseerr-sort-menu .actionSheetMenuItem:focus-visible { box-shadow: inset -3px 0 0 var(--jellyseerr-accent); }
html:not(.layout-tv) .jellyseerr-sort-menu .listItemBody, html:not(.layout-tv) .jellyseerr-sort-menu .actionSheetItemText { flex: 1 1 auto; margin: 0; padding: 0 !important; line-height: 1.5; }
html:not(.layout-tv) .jellyseerr-sort-menu .actionsheetMenuItemIcon { order: 1; width: auto; margin: 0 !important; margin-inline-start: 1.4em !important; padding: 0; font-size: 1.2em; }
/* Groups (the filters): each is a row that names its choice in use and opens to its choices, as the
   sections of Jellyfin's own filter menu open. A group that is narrowing the list says so in the accent. */
html:not(.layout-tv) .jellyseerr-menu-grouped { width: 20em; max-width: calc(100vw - 16px); }
/* On a phone it is as wide as the screen allows: nothing of the page is left as a strip beside it. */
@media (max-width: 600px) { html:not(.layout-tv) .jellyseerr-menu-grouped { width: calc(100vw - 16px); } }
/* On a TV it is one width whatever is open in it, and stays within the screen. */
.layout-tv .jellyseerr-menu-grouped { width: min(34em, 92vw); max-height: 84vh; }
/* The open group's row stays at the top of the menu's scroll, over its own body, and the group ends with a line. */
.jellyseerr-sort-menu .actionSheetScroller { overflow-anchor: none; }
.jellyseerr-sort-menu { --jellyseerr-menu-ground: var(--jf-palette-background-paper, #202020); --jellyseerr-menu-shade: var(--jf-overlays-8, none); --jellyseerr-held-fade: .8; }
.layout-tv .jellyseerr-sort-menu { --jellyseerr-menu-shade: none; }
html .jellyseerr-sort-menu .actionSheetMenuItem.jellyseerr-menu-group[aria-expanded="true"] { position: sticky; top: 0; z-index: 2; overflow: visible; background-color: var(--jellyseerr-menu-ground); background-image: var(--jellyseerr-menu-shade); }
/* Once rows pass under it, it has a lower edge: a rule, and under the rule the menu's ground running on for a few pixels and fading, so no crumb of a row lies on the rule. */
html .jellyseerr-sort-menu .actionSheetMenuItem.jellyseerr-menu-group[data-over]:not(:has(+ .jellyseerr-menu-choices > .jellyseerr-menu-searchbar))::after, .jellyseerr-menu-group[data-over] + .jellyseerr-menu-choices > .jellyseerr-menu-searchbar::after { content: ''; position: absolute; inset-inline: 0; top: 100%; height: calc(var(--jellyseerr-held-fade) * 1em); border-top: 1px solid var(--jf-palette-divider, rgba(255,255,255,.12)); background: var(--jellyseerr-menu-shade), var(--jellyseerr-menu-ground); -webkit-mask-image: linear-gradient(#000 45%, transparent); mask-image: linear-gradient(#000 45%, transparent); pointer-events: none; }
.jellyseerr-menu-choices:not([hidden]) { padding-bottom: 8px; border-bottom: 1px solid var(--jf-palette-divider, rgba(255,255,255,.12)); }
.jellyseerr-menu-groupbox:last-child > .jellyseerr-menu-choices { border-bottom: 0; }
/* (On a TV's dark ground the group's closing rule as strong as the foot's.) */
.layout-tv .jellyseerr-sort-menu .jellyseerr-menu-choices:not([hidden]) { border-bottom-color: rgba(128,128,128,.6); }
@media (hover: hover) { html:not(.layout-tv) .jellyseerr-sort-menu .actionSheetMenuItem.jellyseerr-menu-group[aria-expanded="true"]:hover { background-image: linear-gradient(var(--jf-palette-action-hover, rgba(255,255,255,.08)), var(--jf-palette-action-hover, rgba(255,255,255,.08))), var(--jellyseerr-menu-shade); } }
html:not(.layout-tv) .jellyseerr-sort-menu .actionSheetMenuItem.jellyseerr-menu-group[aria-expanded="true"]:focus-visible { background-image: linear-gradient(var(--jf-palette-action-focus, rgba(255,255,255,.12)), var(--jf-palette-action-focus, rgba(255,255,255,.12))), var(--jellyseerr-menu-shade); }
html .jellyseerr-sort-menu .actionSheetMenuItem.jellyseerr-menu-clear[aria-disabled="true"] { color: var(--jf-palette-text-disabled, rgba(255,255,255,.5)); cursor: default; background: none !important; }
.layout-tv .jellyseerr-sort-menu .actionSheetMenuItem.jellyseerr-menu-group[aria-expanded="true"]:focus { background-image: linear-gradient(var(--jf-palette-action-focus, rgba(255,255,255,.12)), var(--jf-palette-action-focus, rgba(255,255,255,.12))); }
/* The row the remote is on: Jellyfin's ground, and the accent bar at its start that the small menu's rows have under the keys. */
.layout-tv .jellyseerr-sort-menu .actionSheetMenuItem:focus { box-shadow: inset .25em 0 0 var(--jellyseerr-accent); }
html.layout-tv[dir="rtl"] .jellyseerr-sort-menu .actionSheetMenuItem:focus { box-shadow: inset -.25em 0 0 var(--jellyseerr-accent); }
.layout-tv .jellyseerr-menu-range, .layout-tv .jellyseerr-menu-note, .layout-tv .jellyseerr-menu-label, .layout-tv .jellyseerr-menu-searchbar { padding-inline-start: var(--jellyseerr-menu-indent, 32px); }
.layout-tv .jellyseerr-menu-list-rule { margin-inline-start: var(--jellyseerr-menu-indent, 32px); }
/* (On a TV the held strip's rule has the strength of the foot's.) */
html.layout-tv .jellyseerr-sort-menu .actionSheetMenuItem.jellyseerr-menu-group[data-over]:not(:has(+ .jellyseerr-menu-choices > .jellyseerr-menu-searchbar))::after, .layout-tv .jellyseerr-menu-group[data-over] + .jellyseerr-menu-choices > .jellyseerr-menu-searchbar::after { border-top-color: rgba(128,128,128,.6); }
.layout-tv .jellyseerr-menu-foot { margin-top: .3em; padding-top: .3em; border-top: 1px solid rgba(128,128,128,.6); }
/* (On a TV's near-black sheet a shadow does not show: the foot's rule is stronger while rows go on under it.) */
.layout-tv .jellyseerr-sort-menu .actionSheetContent[data-more] > .jellyseerr-menu-foot { border-top-color: rgba(128,128,128,.6); }
/* On a TV's near-black ground a shadow does not show: the rows themselves fade into the foot over the cut row. */
.layout-tv .jellyseerr-sort-menu .actionSheetContent[data-more] > .actionSheetScroller { -webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - 2.2em), transparent); mask-image: linear-gradient(to bottom, #000 calc(100% - 2.2em), transparent); }
.layout-tv .jellyseerr-sort-menu .actionSheetContent[data-above][data-more] > .actionSheetScroller { -webkit-mask-image: linear-gradient(to bottom, transparent, #000 .5em, #000 calc(100% - 2.2em), transparent); mask-image: linear-gradient(to bottom, transparent, #000 .5em, #000 calc(100% - 2.2em), transparent); }
/* (Rows above, on a TV: a rule under the title, as strong as the foot's; the rows themselves keep their strength.) */
.layout-tv .jellyseerr-sort-menu .actionSheetContent[data-rows-above] > .actionSheetTitle { box-shadow: 0 1px 0 rgba(128,128,128,.6); }
/* (Every TV rule in the one grey: the line under Saved filters, and an open row's edge as rows pass under it.) */
html.layout-tv .jellyseerr-sort-menu .jellyseerr-menu-groupbox[data-group="profiles"]:not([data-open]) + .jellyseerr-menu-groupbox > .jellyseerr-menu-group { border-top-color: rgba(128,128,128,.6); }
@media (prefers-reduced-motion: reduce) { .jellyseerr-menu-group .actionsheetMenuItemIcon { transition: none; } }
/* On a phone the rows are as tall as the rows of Jellyfin's menus there. */
@media (max-width: 600px) { html:not(.layout-tv) .jellyseerr-sort-menu .actionSheetMenuItem { min-height: 48px; } }

/* ===== A section's place while it loads, and the line that says Seerr did not answer ===== */
.jellyseerr-card-placeholder { pointer-events: none; }
.jellyseerr-section-message { display: flex; flex-wrap: wrap; align-items: center; gap: .6em 1em; padding: .9em 0; color: var(--jf-palette-text-secondary, rgba(255,255,255,.7)); }
.jellyseerr-section-message-action { margin: 0; flex: none; }
.jellyseerr-section-message-inline { display: inline-flex; flex-direction: column; justify-content: center; vertical-align: middle; white-space: normal; padding: 1em 1.5em; max-width: 14em; text-align: center; }
`;

  // client/src/features/seerr/discovery/discovery-styles.ts
  function injectStyleOnce(id, css) {
    if (typeof document === "undefined" || !document.head || document.getElementById(id)) return;
    const style = document.createElement("style");
    style.id = id;
    style.textContent = css;
    document.head.appendChild(style);
  }
  function injectDiscoveryStyles() {
    injectStyleOnce("jellyseerr-discovery-styles", discovery_default);
  }

  // client/src/features/seerr/discovery/busy.ts
  var HOLD_LIST_MS = 8e3;
  function circle(className) {
    const row = document.createElement("div");
    row.className = className;
    row.setAttribute("aria-hidden", "true");
    const spinner = document.createElement("div");
    spinner.className = "mdl-spinner mdlSpinnerActive";
    for (const layer of [1, 2, 3, 4]) {
      const one = document.createElement("div");
      one.className = `mdl-spinner__layer mdl-spinner__layer-${layer}`;
      for (const [side, part] of [["left", "Left"], ["right", "Right"]]) {
        const clip = document.createElement("div");
        clip.className = `mdl-spinner__circle-clipper mdl-spinner__${side}`;
        const arc = document.createElement("div");
        arc.className = `mdl-spinner__circle mdl-spinner__circle${part}`;
        clip.appendChild(arc);
        one.appendChild(clip);
      }
      spinner.appendChild(one);
    }
    row.appendChild(spinner);
    return row;
  }
  function heldAt(section, header) {
    const bar = parseFloat(section.style.getPropertyValue("--jellyseerr-sticky-top")) || 0;
    const tuck = parseFloat(header.style.getPropertyValue("--jellyseerr-header-tuck")) || 0;
    return section.getBoundingClientRect().top + window.scrollY - bar + tuck + 2;
  }
  function createDiscoveryBusy() {
    const holdTimers = /* @__PURE__ */ new WeakMap();
    function mark(section) {
      const list = section?.querySelector(".itemsContainer");
      if (section && list && !section.querySelector(".jellyseerr-busy")) list.before(circle("jellyseerr-busy"));
    }
    function hold(control) {
      const section = control?.closest?.(".jellyseerr-discovery-section");
      const list = section?.querySelector(".itemsContainer");
      if (!section || !list) return;
      list.style.minHeight = `${list.offsetHeight}px`;
      list.dataset.held = section.querySelector(".jellyseerr-discovery-header")?.hasAttribute("data-stuck") ? "stuck" : "join";
      mark(section);
      window.clearTimeout(holdTimers.get(list));
      holdTimers.set(list, window.setTimeout(() => release(list), HOLD_LIST_MS));
    }
    function release(list) {
      if (!list) return;
      window.clearTimeout(holdTimers.get(list));
      holdTimers.delete(list);
      const held = list.dataset.held;
      if (!held) return;
      delete list.dataset.held;
      const section = list.closest(".jellyseerr-discovery-section");
      const header = section?.querySelector(".jellyseerr-discovery-header");
      if (held === "stuck" && section && header) window.scrollTo({ top: heldAt(section, header) });
      list.style.minHeight = "";
    }
    injectStyleOnce("jellyseerr-discovery-busy-styles", discovery_busy_default);
    return { circle, hold, release, mark, heldAt, HOLD_LIST_MS };
  }

  // client/src/features/seerr/discovery/domain.ts
  var FILTER_MODES = { MIXED: "mixed", MOVIES: "movies", TV: "tv" };
  var SORT_OPTIONS = [
    { value: "", label: "Popular", labelKey: "discovery_sort_popular" },
    { value: "vote_average.desc", label: "Top rated", labelKey: "discovery_sort_top_rated" },
    { value: "vote_count.desc", label: "Most votes", labelKey: "discovery_sort_most_votes" },
    { value: "release_date.desc", label: "Newest", labelKey: "discovery_sort_newest" },
    { value: "release_date.asc", label: "Oldest", labelKey: "discovery_sort_oldest" }
  ];
  function isRecord2(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function isFilterMode(value) {
    return value === FILTER_MODES.MIXED || value === FILTER_MODES.MOVIES || value === FILTER_MODES.TV;
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
  function interleaveArrays(first, second) {
    const result = [];
    const left = first[Symbol.iterator]();
    const right = second[Symbol.iterator]();
    for (; ; ) {
      const a = left.next();
      const b = right.next();
      if (a.done && b.done) return result;
      if (!a.done) result.push(a.value);
      if (!b.done) result.push(b.value);
    }
  }
  function filterByMediaType(results, mode) {
    if (mode === FILTER_MODES.MOVIES) return results.filter((item) => item.mediaType === "movie");
    if (mode === FILTER_MODES.TV) return results.filter((item) => item.mediaType === "tv");
    return results;
  }
  function hasBothTypes(tvResults, movieResults) {
    return !!tvResults && tvResults.length > 0 && !!movieResults && movieResults.length > 0;
  }
  function resultHasBothTypes(results) {
    if (!results) return false;
    return results.some((item) => item.mediaType === "movie") && results.some((item) => item.mediaType === "tv");
  }
  function tvSortValue(sort) {
    return sort.replace("release_date", "first_air_date");
  }
  function mediaInfoOf(item) {
    return isRecord2(item.mediaInfo) ? item.mediaInfo : null;
  }
  var resultKey = (item) => `${String(item.mediaType)}-${String(item.id)}`;
  function selectCardResults(results, policy) {
    const seen = /* @__PURE__ */ new Set();
    const items = [];
    for (const item of results) {
      const key = resultKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      const info = mediaInfoOf(item);
      if (policy.excludeLibrary && info?.jellyfinMediaId) continue;
      if (policy.excludeBlocklisted && policy.blockedStatus !== void 0 && info?.status === policy.blockedStatus) continue;
      items.push(item);
    }
    return items;
  }
  function isGenreEntry(value) {
    return isRecord2(value) && typeof value.id === "number" && typeof value.name === "string";
  }
  function decodeGenreList(value) {
    if (!Array.isArray(value)) throw decodeError("genre list");
    return value.filter(isGenreEntry);
  }

  // client/src/features/seerr/discovery/card-rendering.ts
  var BUILD_SLICE_MS = 8;
  function createYield() {
    if (typeof MessageChannel === "undefined") return () => new Promise((resolve) => setTimeout(resolve, 0));
    const channel = new MessageChannel();
    const waiters = [];
    channel.port1.onmessage = () => waiters.shift()?.();
    return () => new Promise((resolve) => {
      waiters.push(resolve);
      channel.port2.postMessage(null);
    });
  }
  function firstSizedBox(elements) {
    for (const element of elements) {
      const box = element?.getBoundingClientRect();
      if (box && box.width > 0 && box.height > 0) return box;
    }
    return null;
  }
  function createCardRendering(JE) {
    const yieldToBrowser = createYield();
    function filterCardResults(results) {
      const hiddenContent = discoveryContext(JE).peer("hiddenContent");
      const visible = hiddenContent ? hiddenContent.filterJellyseerrResults(results, "discovery") : results;
      return selectCardResults(visible, {
        excludeLibrary: JE.pluginConfig?.JellyseerrExcludeLibraryItems === true,
        excludeBlocklisted: JE.pluginConfig?.JellyseerrExcludeBlocklistedItems === true,
        blockedStatus: JE.seerrStatus?.MEDIA.BLOCKED
      });
    }
    function createDiscoveryCard(item, cardClass) {
      const card = JE.jellyseerrUI?.createJellyseerrCard?.(item, true, true);
      if (!card) return null;
      card.classList.remove("portraitCard", "overflowPortraitCard");
      card.classList.add(cardClass);
      card.setAttribute("data-media-type", String(item.mediaType));
      JE.discoveryRoles?.decorateCard?.(card, item);
      const mediaId = mediaInfoOf(item)?.jellyfinMediaId;
      if (mediaId) {
        const id = String(mediaId);
        card.setAttribute("data-library-item", "true");
        card.setAttribute("data-jellyfin-media-id", id);
        card.classList.add("jellyseerr-card-in-library");
        const titleLink = card.querySelector(".cardText-first a");
        if (titleLink) {
          const name = String(item.title || item.name || "");
          titleLink.textContent = name;
          titleLink.title = name;
          titleLink.href = `#!/details?id=${encodeURIComponent(id)}`;
          titleLink.removeAttribute("target");
          titleLink.removeAttribute("rel");
        }
      }
      return card;
    }
    function createCardsFragment(results, options = {}) {
      const { cardClass = "portraitCard" } = options;
      const fragment = document.createDocumentFragment();
      for (const item of filterCardResults(results)) {
        const card = createDiscoveryCard(item, cardClass);
        if (card) fragment.appendChild(card);
      }
      return fragment;
    }
    function cardsInView(container, options = {}) {
      const scroll = JE.seamlessScroll;
      if (!scroll?.cardsNeeded || !container.isConnected) return 0;
      const rect = container.getBoundingClientRect();
      if (options.horizontal) {
        const row = firstSizedBox([container, container.closest(".emby-scroller"), container.closest(".verticalSection")]);
        if (!row || row.bottom <= 0 || row.top >= window.innerHeight) return 0;
        let last = container.lastElementChild;
        while (last && !last.classList.contains("card")) last = last.previousElementSibling;
        const end = last ? last.getBoundingClientRect().right : rect.left;
        const gapPx2 = window.innerWidth * 1.5 - end;
        return gapPx2 > 0 ? scroll.cardsNeeded(container, { deficitPx: gapPx2, horizontal: true }, Infinity) : 0;
      }
      const gapPx = window.innerHeight * 1.5 - rect.bottom;
      return gapPx > 0 ? scroll.cardsNeeded(container, { deficitPx: gapPx }, Infinity) : 0;
    }
    async function appendInSlices(container, items, createCard, options = {}) {
      const { syncCount = 0, isCurrent = () => true } = options;
      const iterator = items[Symbol.iterator]();
      let next = iterator.next();
      const build = (fragment, minCount, budgetMs) => {
        const start = performance.now();
        let count = 0;
        while (!next.done && (count < minCount || performance.now() - start < budgetMs)) {
          const card = createCard(next.value);
          next = iterator.next();
          if (card) {
            fragment.appendChild(card);
            count++;
          }
        }
        return count;
      };
      let pending = document.createDocumentFragment();
      let syncCards = [];
      let settled = false;
      try {
        let appended = 0;
        if (syncCount > 0) {
          appended = build(pending, syncCount, 0);
          if (appended > 0) {
            syncCards = Array.from(pending.children);
            container.appendChild(pending);
          }
          pending = document.createDocumentFragment();
        }
        let built = build(pending, 0, BUILD_SLICE_MS);
        while (!next.done) {
          await yieldToBrowser();
          if (!isCurrent()) {
            settled = true;
            return appended;
          }
          built += build(pending, 1, BUILD_SLICE_MS);
        }
        if (built > 0) container.appendChild(pending);
        settled = true;
        return appended + built;
      } finally {
        if (pending.firstChild) JE.jellyseerrUI?.releasePosters?.(pending);
        if (!settled && syncCards.length > 0) {
          syncCards.forEach((card) => card.remove());
          JE.jellyseerrUI?.releasePosters?.();
        }
      }
    }
    function appendCards(container, results, options = {}) {
      const { cardClass = "portraitCard", isCurrent } = options;
      const items = filterCardResults(results);
      if (items.length === 0) return Promise.resolve(0);
      return appendInSlices(container, items, (item) => createDiscoveryCard(item, cardClass), {
        syncCount: cardsInView(container),
        isCurrent
      });
    }
    return { createCardsFragment, appendCards, appendInSlices, cardsInView };
  }

  // client/src/features/seerr/discovery/discovery-filter-panel.css
  var discovery_filter_panel_default = `/* The Filters button: Jellyfin's filter icon alone, as wide to press as Jellyfin's own toolbar icons,
   in the accent while anything in its menu is narrowing the list. */
.jellyseerr-discovery-header .jellyseerr-filters-btn.emby-tab-button { margin-inline: 0; padding-inline: .3em; }
.jellyseerr-filters-btn .material-icons { margin-inline-end: 0; }
.jellyseerr-filters-btn::after { inset-inline: -.45em; }
/* On: the accent, kept under the pointer and the keys, and a dot at the icon's corner (as Jellyfin marks
   its own filter button), so it is not told by colour alone. */
.jellyseerr-filters-btn .material-icons { position: relative; }
.jellyseerr-filters-btn.emby-tab-button[data-on], .jellyseerr-filters-btn.emby-tab-button[data-on]:hover, .jellyseerr-filters-btn.emby-tab-button[data-on]:focus-visible, .layout-tv .jellyseerr-filters-btn.emby-tab-button[data-on]:focus { color: var(--jellyseerr-accent); }
.jellyseerr-filters-btn[data-on] .material-icons::after { content: ''; position: absolute; inset-block-start: -.06em; inset-inline-end: -.24em; width: .36em; height: .36em; border-radius: 50%; background: currentColor; }
.jellyseerr-filters-btn[data-type-only] { display: none; }
.jellyseerr-filters-type { display: none; white-space: nowrap; font-weight: 400; }
/* The button's name, for a screen reader (the icon says it to the eye): out of sight, never out of the page. */
.jellyseerr-filters-name { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
/* What is set, in words, on a line under the header (it is not held with it): each piece with the way to
   take it away. The page's quiet text, no boxes; a press area of 44px each. */
.jellyseerr-filters-set { --jellyseerr-accent: var(--jf-palette-primary-main, #00a4dc); display: flex; flex-wrap: wrap; align-items: center; gap: .25em 1.6em; margin: .4em 0 .7em; color: var(--jf-palette-text-secondary, rgba(255,255,255,.7)); }
.jellyseerr-filters-token { display: inline-flex; align-items: center; min-width: 0; max-width: 100%; }
.jellyseerr-filters-token > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.jellyseerr-filters-remove, .jellyseerr-filters-clear { position: relative; flex: none; margin: 0; border: 0; border-radius: .3em; background: none; color: inherit; font: inherit; cursor: pointer; }
.jellyseerr-filters-remove { display: inline-flex; padding: .2em; margin-inline-start: .15em; }
.jellyseerr-filters-remove .material-icons { font-size: 1.1em; line-height: 1; }
/* ("Clear filters" is no heavier and no brighter than the filters it clears: it comes last and needs no pull.) */
.jellyseerr-filters-clear { padding: .2em 0; }
/* (Where the section says nothing matches, the way out is offered there.) */
.jellyseerr-discovery-section:has(.jellyseerr-filters-none) .jellyseerr-filters-clear { display: none; }
/* (On a TV the remote is on the whole piece, words and ×: its ground covers both.) */
.layout-tv .jellyseerr-filters-remove:focus { outline: none; box-shadow: none; color: var(--jf-palette-text-primary, #fff); }
.layout-tv .jellyseerr-filters-token:focus-within { color: var(--jf-palette-text-primary, #fff); }
.jellyseerr-filters-remove::after, .jellyseerr-filters-clear::after { content: ''; position: absolute; inset: 50% -.55em auto; height: 44px; transform: translateY(-50%); }
.jellyseerr-filters-clear::after { inset-inline: 0; }
.jellyseerr-filters-remove:hover, .jellyseerr-filters-remove:focus-visible, .jellyseerr-filters-clear:hover, .jellyseerr-filters-clear:focus-visible { color: var(--jf-palette-text-primary, #fff); }
.jellyseerr-filters-clear:hover { text-decoration: underline; text-underline-offset: .2em; }
.jellyseerr-filters-remove:focus-visible, .jellyseerr-filters-clear:focus-visible { outline: none; box-shadow: 0 0 0 .14em var(--jellyseerr-accent); }
/* A group's own body: two fields to type a range in; a whole list to tick, with a field to narrow
   a long one; a search. The fields are the menu's own ground a shade lighter, ringed in the
   theme's colour while typed in and in its error colour while what is typed cannot be used. */
.jellyseerr-menu-range { display: flex; align-items: center; gap: .5em; padding: 4px 16px 8px 32px; }
.jellyseerr-menu-range-labels { padding-bottom: 0; }
.jellyseerr-menu-bound { flex: 1 1 0; min-width: 0; font-size: .86em; color: var(--jellyseerr-quiet, rgba(255,255,255,.7)); }
.jellyseerr-menu-range-spacer { visibility: hidden; }
.jellyseerr-menu-input { box-sizing: border-box; flex: 1 1 0; width: 100%; min-width: 0; padding: 6px 10px; border: 1px solid var(--jf-palette-divider, rgba(255,255,255,.12)); border-color: color-mix(in srgb, currentColor 45%, transparent); border-radius: var(--jf-shape-borderRadius, 4px); background: var(--jf-palette-action-hover, rgba(255,255,255,.08)); color: inherit; font: inherit; }
.jellyseerr-menu-input::placeholder { color: var(--jellyseerr-quiet, var(--jf-palette-text-secondary, rgba(255,255,255,.7))); opacity: 1; }
.jellyseerr-menu-input:focus { outline: none; border-color: var(--jellyseerr-accent, #00a4dc); box-shadow: 0 0 0 1px var(--jellyseerr-accent, #00a4dc); }
/* (Forced colours drop the box shadow: a field with the keys in it has an outline there.) */
@media (forced-colors: active) { .jellyseerr-menu-input:focus { outline: 2px solid Highlight; outline-offset: 1px; } }
.jellyseerr-sort-menu { --jellyseerr-error: var(--jf-palette-error-light, #e57373); --jellyseerr-quiet: var(--jf-palette-text-secondary, rgba(255,255,255,.7)); }
/* (Quiet on every theme: the text the theme draws, at 70%. A theme's secondary text can be as strong as its text.) */
@supports (color: color-mix(in srgb, red, blue)) { .jellyseerr-sort-menu { --jellyseerr-quiet: color-mix(in srgb, currentColor 70%, transparent); } }
@supports (color: color-mix(in oklab, red 60%, blue)) { .jellyseerr-sort-menu { --jellyseerr-error: color-mix(in oklab, var(--jf-palette-error-main, #f44336) 52%, var(--jf-palette-text-primary, #fff)); } }
.jellyseerr-menu-input[aria-invalid="true"] { border-color: var(--jellyseerr-error); box-shadow: 0 0 0 1px var(--jellyseerr-error); }
/* What cannot be used is also said in words, where the hint was. */
.jellyseerr-menu-note[data-error] { color: var(--jellyseerr-error); }
/* A list's search field stays in sight under its group's row while the list scrolls. */
.jellyseerr-menu-searchbar { position: sticky; top: calc(var(--jellyseerr-menu-head, 36px) - 1px); z-index: 1; padding: 5px 16px 6px 32px; background-color: var(--jellyseerr-menu-ground); background-image: var(--jellyseerr-menu-shade); }
.jellyseerr-menu-search { display: block; width: 100%; }
/* A row to tick has a box, empty until it is ticked (then in the accent); one given by the page itself is dim and cannot be pressed. */
.jellyseerr-sort-menu .jellyseerr-menu-tick .actionsheetMenuItemIcon { color: var(--jellyseerr-quiet, var(--jf-palette-text-secondary, rgba(255,255,255,.7))); }
.jellyseerr-sort-menu .jellyseerr-menu-tick[aria-checked="true"] .actionsheetMenuItemIcon { color: var(--jellyseerr-accent); }
html .jellyseerr-sort-menu .actionSheetMenuItem.jellyseerr-menu-tick[aria-disabled="true"] { color: var(--jellyseerr-quiet, rgba(255,255,255,.7)); cursor: default; background: none !important; }
.jellyseerr-sort-menu .jellyseerr-menu-tick[aria-disabled="true"] .actionsheetMenuItemIcon { color: var(--jf-palette-text-disabled, rgba(255,255,255,.5)); }
/* A long name in a list takes a second line: its end is often what tells two entries apart ("… Amazon Channel"). (Its box stays in the row's middle, as on any list of two-line items.) */
html .jellyseerr-sort-menu .jellyseerr-menu-list .actionSheetItemText { min-width: 0; white-space: normal; overflow-wrap: anywhere; }
/* The letters a search found in a name. */
.jellyseerr-menu-found { font-weight: 700; }
/* Under what is ticked or likeliest wanted at a long list's head, before the rest of it. */
.jellyseerr-menu-list-rule { height: 1px; margin: 4px 16px 4px 32px; background: var(--jf-palette-divider, rgba(255,255,255,.12)); }
.jellyseerr-menu-note, .jellyseerr-menu-label { color: var(--jellyseerr-quiet, var(--jf-palette-text-secondary, rgba(255,255,255,.7))); }
.jellyseerr-menu-note { padding: 2px 16px 8px 32px; font-size: .86em; line-height: 1.4; }
/* All of what is ticked, or any of it: two small choices on the rule's line, the one in use filled. */
/* The theme's own grounds; the choice in use in the accent, as everything set in this menu is. */
.jellyseerr-menu-match { display: flex; flex-flow: row wrap; align-items: center; gap: .35em .6em; }
.jellyseerr-menu-searchbar .jellyseerr-menu-note { padding: 6px 0 0; }
.jellyseerr-menu-match-track { display: inline-flex; gap: 2px; padding: 2px; border-radius: 999px; background: var(--jf-palette-action-hover, rgba(255,255,255,.08)); box-shadow: inset 0 0 0 1px var(--jf-palette-divider, rgba(255,255,255,.12)); }
.jellyseerr-menu-match-btn { display: inline-flex; flex-direction: column; align-items: center; justify-content: center; font: inherit; color: inherit; white-space: nowrap; background: none; border: 0; border-radius: 999px; padding: .3em .65em; cursor: pointer; }
/* The half in use on the sheet's own ground, in the accent with its ring (readable on any theme). */
.jellyseerr-menu-match-btn[aria-checked="true"] { background-color: var(--jellyseerr-menu-ground, transparent); background-image: var(--jellyseerr-menu-shade, none); color: var(--jellyseerr-accent); box-shadow: inset 0 0 0 1px var(--jellyseerr-accent); font-weight: 600; }
/* The other half can be pressed: it answers the pointer. */
.jellyseerr-menu-match-btn:not([aria-checked="true"]):hover { background: var(--jf-palette-action-hover, rgba(255,255,255,.08)); color: var(--jf-palette-text-primary, #fff); }
/* Below two ticks the choice changes nothing: shown, but not in the accent that says the list is narrowed. */
.jellyseerr-menu-match[data-idle] .jellyseerr-menu-match-btn[aria-checked="true"] { color: var(--jf-palette-text-primary, #fff); box-shadow: inset 0 0 0 1px var(--jf-palette-text-disabled, rgba(255,255,255,.5)); box-shadow: inset 0 0 0 1px color-mix(in srgb, currentColor 55%, transparent); font-weight: 500; }
.jellyseerr-menu-match-btn:focus-visible { outline: 2px solid var(--jf-palette-text-primary, #fff); outline-offset: 1px; }
/* (Two equal columns wherever there is room for both at the wider's width; never wider than the line, so the
   choice never moves the list.) */
html:not(.layout-tv) .jellyseerr-menu-match-track { display: grid; grid-template-columns: 1fr 1fr; flex: 1 1 0; }
.jellyseerr-menu-match-reserve { display: block; height: 0; overflow: hidden; visibility: hidden; font-weight: 600; }
@media (forced-colors: active) {
    .jellyseerr-menu-match-track { outline: 1px solid CanvasText; outline-offset: -1px; }
    .jellyseerr-menu-list-rule { forced-color-adjust: none; background: CanvasText; }
    .jellyseerr-sort-menu .jellyseerr-menu-group[data-set] .jellyseerr-menu-group-value { forced-color-adjust: none; color: LinkText; }
    .jellyseerr-menu-match-btn[aria-checked="true"] { outline: 2px solid Highlight; outline-offset: -2px; }
    .jellyseerr-menu-match-btn:focus-visible { outline: 3px solid CanvasText; outline-offset: 1px; }
}
/* On a TV the half the remote is on is the inverted pill the Filters button uses; the half in use keeps its ring. */
.layout-tv .jellyseerr-menu-match-btn:focus { outline: none; background: var(--jf-palette-text-primary, #fff); color: var(--jellyseerr-menu-ground, #101010); }
/* Under the remote, the half in use keeps its mark: an accent ring outside the pill. */
.layout-tv .jellyseerr-menu-match-btn[aria-checked="true"]:focus { box-shadow: 0 0 0 3px var(--jellyseerr-accent); }
/* An open group's list sits in from its row on a TV too. */
.layout-tv .jellyseerr-sort-menu .jellyseerr-menu-choices > .actionSheetMenuItem,
.layout-tv .jellyseerr-sort-menu .jellyseerr-menu-choices .jellyseerr-menu-list > .actionSheetMenuItem { padding-inline-start: 3.5em; }
.layout-tv .jellyseerr-menu-match { font-size: 1rem; }
.layout-tv .jellyseerr-menu-match-btn { padding: .45em 1.1em; }
/* On a touch screen, as wide as the search field above it and a finger's height. */
@media (pointer: coarse), (max-width: 600px) {
    html:not(.layout-tv) .jellyseerr-menu-match-track { display: grid; grid-template-columns: 1fr 1fr; flex: 1 1 12em; }
    html:not(.layout-tv) .jellyseerr-menu-match-btn { flex: 1 1 0; min-height: 44px; }
}
/* Saved filters: each profile a row with its delete button at the end; the form a field and Save. */
.jellyseerr-menu-profile-row { display: flex; align-items: center; }
.jellyseerr-menu-profile-row > .actionSheetMenuItem { flex: 1 1 auto; min-width: 0; }
.jellyseerr-menu-profile-delete { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 44px; height: 44px; margin-inline-end: 2.5px; border: 0; border-radius: 50%; background: none; color: var(--jellyseerr-quiet, var(--jf-palette-text-secondary, rgba(255,255,255,.7))); cursor: pointer; }
.jellyseerr-menu-profile-delete:hover, .jellyseerr-menu-profile-delete:focus-visible { background: var(--jf-palette-action-hover, rgba(255,255,255,.08)); color: var(--jf-palette-text-primary, #fff); outline: none; }
/* The keys on it: ringed as the all / any choice is. */
html:not(.layout-tv) .jellyseerr-menu-profile-delete:focus-visible { outline: 2px solid var(--jf-palette-text-primary, #fff); outline-offset: -2px; }
@media (forced-colors: active) { .jellyseerr-menu-profile-delete:focus-visible { outline: 3px solid CanvasText; } }
/* Saved filters stand apart from the filters under them: a quiet line between, open or not. */
.jellyseerr-menu-groupbox[data-group="profiles"]:not([data-open]) + .jellyseerr-menu-groupbox > .jellyseerr-menu-group { border-top: 1px solid var(--jf-palette-divider, rgba(255,255,255,.12)); }
.layout-tv .jellyseerr-menu-profile-delete:focus { background: var(--jf-palette-text-primary, #fff); color: var(--jellyseerr-menu-ground, #101010); }
.jellyseerr-menu-profile-save { flex: none; align-self: stretch; height: auto; min-height: 0; margin: 0; padding: 0 1em; }
/* A profile not in use keeps no room for the tick it does not show (on a TV the tick is the row's first column: kept). */
html:not(.layout-tv) .jellyseerr-menu-profile .actionsheetMenuItemIcon { display: none !important; }
html:not(.layout-tv) .jellyseerr-menu-profile[aria-current] .actionSheetItemText { color: var(--jellyseerr-accent); font-weight: 500; }
/* (Hung into the row's inset, so the name stays on the column the others and its summary share.) */
/* (Its name is a flex line: the check centred on it.) */
.jellyseerr-menu-profile-mark { font-size: 1em; align-self: center; width: 1em; margin-inline: -1.21em .21em; }
html .jellyseerr-sort-menu .jellyseerr-menu-group[data-toggle="profiles"][data-set] { align-items: flex-start; }
html .jellyseerr-sort-menu .jellyseerr-menu-profile[aria-current] .actionsheetListItemBody,
html .jellyseerr-sort-menu .jellyseerr-menu-profile[aria-current] .actionSheetItemText { overflow: visible; }
.layout-tv .jellyseerr-menu-profile-mark { display: none; }
@media (forced-colors: active) {
    html:not(.layout-tv) .jellyseerr-menu-profile[aria-current] .actionSheetItemText { forced-color-adjust: none; color: LinkText; }
    html .jellyseerr-sort-menu .jellyseerr-menu-profile-save { border: 1px solid ButtonBorder; }
    html .jellyseerr-sort-menu .jellyseerr-menu-profile-save:disabled { opacity: 1; color: GrayText; border-color: GrayText; }
}
.jellyseerr-menu-profile-save:disabled { opacity: .45; cursor: default; box-shadow: none; }
@media (pointer: coarse) { .jellyseerr-menu-profile-undo::after { content: ''; position: absolute; inset: -12px -8px; } }
html .jellyseerr-sort-menu .jellyseerr-menu-profile-says { font-size: .85em; line-height: 1.4; white-space: normal; overflow-wrap: anywhere; color: var(--jellyseerr-quiet, rgba(255,255,255,.7)) !important; opacity: 1; }
.jellyseerr-menu-profile-part { display: inline-block; max-width: 100%; }
.jellyseerr-menu-profile-undo { position: relative; font: inherit; margin: 0 -.2em; padding: .1em .2em; border: 0; border-radius: 4px; background: none; color: var(--jellyseerr-accent); text-decoration: underline; cursor: pointer; }
.jellyseerr-menu-profile-undo:focus-visible { outline: 2px solid var(--jf-palette-text-primary, #fff); outline-offset: 1px; }
.layout-tv .jellyseerr-menu-profile-undo:focus { outline: none; background: var(--jf-palette-text-primary, #fff); color: var(--jellyseerr-menu-ground, #101010); text-decoration: none; }
.jellyseerr-filters-run { display: inline-flex; flex-wrap: wrap; align-items: center; gap: .15em .4em; max-width: 100%; }
.jellyseerr-filters-token > .jellyseerr-filters-join { flex: none; overflow: visible; margin-inline-end: .35em; color: var(--jf-palette-text-secondary, rgba(255,255,255,.7)); }
/* An open group's row reads as the heading of what is under it; a long value is cut with an ellipsis. */
.jellyseerr-menu-group[aria-expanded="true"] .actionSheetItemText { font-weight: 500; }
.jellyseerr-menu-group-value { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
/* (The saved set in use is named whole: its name takes a second line on its row rather than being cut.) */
html .jellyseerr-sort-menu .jellyseerr-menu-group[data-toggle="profiles"][data-set] .jellyseerr-menu-group-value { white-space: normal; text-align: end; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
/* A value said short to the eye is said whole to a screen reader. */
.jellyseerr-menu-whole { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
/* Why the page's own genre is ticked and can't be unticked, under its name. */
.jellyseerr-sort-menu .jellyseerr-menu-given { font-size: .85em; white-space: normal; color: inherit; opacity: 1; }
html .jellyseerr-sort-menu .jellyseerr-menu-elsewhere { color: var(--jellyseerr-quiet, rgba(255,255,255,.7)); }
html .jellyseerr-sort-menu .jellyseerr-menu-tick[aria-disabled="true"] .actionSheetItemText,
html .jellyseerr-sort-menu .jellyseerr-menu-tick[aria-disabled="true"] .jellyseerr-menu-given { color: inherit !important; opacity: 1 !important; }
/* The foot's line when nothing matches: over "Clear filters", the way out. */
.jellyseerr-sort-menu .jellyseerr-menu-outcome { flex: 0 0 calc(100% - 16px); box-sizing: border-box; display: flex; align-items: center; justify-content: space-between; gap: .75em; margin: 8px 8px 4px; padding: 8px 6px 8px calc(var(--jellyseerr-menu-text, 16px) - 8px); border-radius: 8px; color: var(--jf-palette-text-primary, #fff); background: rgba(0,164,220,.14); background: color-mix(in srgb, var(--jellyseerr-accent, #00a4dc) 16%, transparent); }
.jellyseerr-sort-menu .jellyseerr-menu-outcome[hidden] { display: none; }
/* (Undo right after its sentence, as a deleted set's is: the band's words run on, and wrap as words do.) */
.jellyseerr-sort-menu .jellyseerr-menu-outcome { display: block; line-height: 1.6; }
.jellyseerr-menu-outcome > span, .jellyseerr-menu-profile-said { margin-inline-end: .35em; }
.jellyseerr-menu-outcome-undo { display: inline-block; position: relative; margin: 3px -.2em 0; font: inherit; padding: .1em .2em; border: 0; border-radius: 6px; background: none; color: var(--jellyseerr-accent); text-decoration: underline; cursor: pointer; }
.jellyseerr-menu-outcome-undo:focus-visible { outline: 2px solid var(--jf-palette-text-primary, #fff); outline-offset: 0; border-radius: 3px; }
.layout-tv .jellyseerr-menu-outcome-undo:focus { outline: none; background: var(--jf-palette-text-primary, #fff); color: var(--jellyseerr-menu-ground, #101010); text-decoration: none; }
/* (On touch, a 44px target reaching past the band's words without making the band taller.) */
@media (pointer: coarse) { .jellyseerr-menu-outcome-undo::after { content: ''; position: absolute; inset: -12px -8px; } }
@media (forced-colors: active) { .jellyseerr-sort-menu .jellyseerr-menu-outcome { border: 1px solid CanvasText; } }
/* TV: the band's words and a set's summary at the rows' size (read from across the room); Undo a pill the remote lands on. */
.layout-tv .jellyseerr-sort-menu .jellyseerr-menu-outcome { font-size: 1.1rem; padding-block: .5em; }
.layout-tv .jellyseerr-menu-outcome-undo { display: block; width: fit-content; padding: .3em .6em; margin: .2em 0 0 -.6em; border-radius: 999px; }
[dir="rtl"] .layout-tv .jellyseerr-menu-outcome-undo, .layout-tv [dir="rtl"] .jellyseerr-menu-outcome-undo { margin: .2em -.6em 0 0; }
html.layout-tv .jellyseerr-sort-menu .jellyseerr-menu-profile-says { font-size: 1rem; }
/* TV: hints, notes and the given genre's words near the rows' size; the bin as large as the rows' icons. */
html.layout-tv .jellyseerr-sort-menu .jellyseerr-menu-note, html.layout-tv .jellyseerr-sort-menu .jellyseerr-menu-given { font-size: .95em; }
.jellyseerr-menu-profile-delete { font: inherit; }
.layout-tv .jellyseerr-menu-profile-delete .material-icons { font-size: 1.5em; }
.layout-tv .jellyseerr-menu-profile-delete { margin-inline-end: 12px; }
/* What a search has narrowed away is gone (a row's own display would otherwise keep it). */
.jellyseerr-sort-menu .actionSheetMenuItem[hidden], .jellyseerr-menu-note[hidden], .jellyseerr-menu-label[hidden] { display: none !important; }
.jellyseerr-menu-label { padding: 8px 16px 2px 32px; font-size: .86em; }
.jellyseerr-menu-list:empty { display: none; }
/* (A phone's browser zooms into a field whose type is under 16px.) */
@media (max-width: 600px) { .jellyseerr-menu-input { font-size: max(1em, 16px); min-height: 44px; } }
@media (max-width: 600px) { html:not(.layout-tv) .jellyseerr-sort-menu .jellyseerr-menu-note, html:not(.layout-tv) .jellyseerr-sort-menu .jellyseerr-menu-profile-says, html:not(.layout-tv) .jellyseerr-sort-menu .jellyseerr-menu-bound { font-size: .92em; } }
@supports (color: color-mix(in srgb, red, blue)) { .layout-tv .jellyseerr-sort-menu { --jellyseerr-quiet: color-mix(in srgb, currentColor 82%, transparent); } }
.jellyseerr-menu-group .listItemBody { display: flex; flex-direction: row; align-items: baseline; justify-content: space-between; gap: 1.5em; }
/* The filter's name is never cut: a long value gives way, with an ellipsis. */
html .jellyseerr-sort-menu .jellyseerr-menu-group .actionSheetItemText { flex: 0 0 auto; }
html .jellyseerr-sort-menu .jellyseerr-menu-group .jellyseerr-menu-group-value { flex: 0 1 auto; min-width: 0; }
.jellyseerr-menu-group-value { color: var(--jellyseerr-quiet, var(--jf-palette-text-secondary, rgba(255,255,255,.7))); white-space: nowrap; }
.jellyseerr-menu-group[data-set] .jellyseerr-menu-group-value { color: var(--jellyseerr-accent); }
.jellyseerr-menu-group .actionsheetMenuItemIcon { transition: transform .15s; }
.jellyseerr-menu-group[aria-expanded="true"] .actionsheetMenuItemIcon { transform: rotate(180deg); }
html:not(.layout-tv) .jellyseerr-sort-menu .jellyseerr-menu-group .actionsheetMenuItemIcon { margin-inline-start: .6em !important; }
html:not(.layout-tv) .jellyseerr-sort-menu .jellyseerr-menu-choices .actionSheetMenuItem { padding-inline-start: 32px; }
/* "Clear filters" is the menu's foot, always in reach; at full strength only while something is set. */
html:not(.layout-tv) .jellyseerr-sort-menu .jellyseerr-menu-foot { margin-top: 4px; padding-top: 4px; border-top: 1px solid var(--jf-palette-divider, rgba(255,255,255,.12)); }
html:not(.layout-tv) .jellyseerr-sort-menu .jellyseerr-menu-foot { display: flex; flex-wrap: wrap; }
html:not(.layout-tv) .jellyseerr-sort-menu .jellyseerr-menu-foot > .actionSheetMenuItem { width: auto; }
html:not(.layout-tv) .jellyseerr-sort-menu .jellyseerr-menu-clear { flex: 1 1 auto; }
/* On a touch screen the menu can fill the screen: its foot then ends with the way out, said (nothing waits for it; what is set has taken effect). */
.jellyseerr-sort-menu .jellyseerr-menu-done { display: none !important; flex: none; }
.jellyseerr-sort-menu .jellyseerr-menu-done .actionsheetMenuItemIcon { display: none; }
/* On a touch screen "Done" is the way back to the list: the foot's main action, "Clear filters" the quiet one. */
.jellyseerr-sort-menu .jellyseerr-menu-done .actionSheetItemText { font-weight: 500; color: var(--jellyseerr-accent); }
@media (pointer: coarse) { html:not(.layout-tv) .jellyseerr-sort-menu .jellyseerr-menu-done { display: flex !important; } }
`;

  // client/src/features/seerr/discovery/filter-data.ts
  var FILTERS_API = "/JellyfinEnhanced/jellyseerr/filters";
  var isRecord3 = (value) => typeof value === "object" && value !== null;
  var rowsOf = (value) => (Array.isArray(value) ? value : []).filter(isRecord3);
  var byName = (a, b) => a.name.localeCompare(b.name);
  function createFilterData({ region, fetch, fetchGenres }) {
    let genres = null;
    let languages = null;
    let ratings = null;
    let services = null;
    const once = (held, load, forget) => {
      if (held) return held;
      const asked = load();
      asked.catch(forget);
      return asked;
    };
    async function loadGenres() {
      const [movie, tv] = await Promise.all([fetchGenres("movie"), fetchGenres("tv")]);
      const ids = /* @__PURE__ */ new Map();
      for (const [list, kind] of [[movie, "movie"], [tv, "tv"]]) {
        for (const genre of rowsOf(list)) {
          if (typeof genre.name !== "string") continue;
          const entry = ids.get(genre.name.toLowerCase()) ?? { name: genre.name, movie: "", tv: "" };
          entry[kind] = String(genre.id);
          ids.set(genre.name.toLowerCase(), entry);
        }
      }
      return Array.from(ids.values(), (entry) => ({ id: `${entry.movie}/${entry.tv}`, name: entry.name })).sort(byName);
    }
    async function loadLanguages(locale) {
      let names = null;
      try {
        names = new Intl.DisplayNames([locale || "en"], { type: "language" });
      } catch {
        names = null;
      }
      const list = [];
      const taken = /* @__PURE__ */ new Set();
      for (const row of rowsOf(await fetch(`${FILTERS_API}/languages`))) {
        const code = typeof row.iso_639_1 === "string" ? row.iso_639_1 : "";
        if (!/^[a-z]{2}$/.test(code) || code === "xx") continue;
        const english = typeof row.english_name === "string" ? row.english_name.trim() : "";
        let name = "";
        try {
          name = names?.of(code) ?? "";
        } catch {
          name = "";
        }
        if (!name || name === code) name = english;
        if (taken.has(name.toLowerCase())) name = english;
        if (!name || taken.has(name.toLowerCase())) continue;
        taken.add(name.toLowerCase());
        list.push({ id: code, name });
      }
      return list.sort(byName);
    }
    async function loadRatings() {
      const lists = [];
      for (const kind of ["movie", "tv"]) {
        const body = await fetch(`${FILTERS_API}/certifications/${kind}`);
        const all = isRecord3(body) && isRecord3(body.certifications) ? body.certifications : {};
        const country = rowsOf(all[region]).length > 0 ? region : "US";
        const own = rowsOf(all[country]).filter((row) => typeof row.certification === "string" && row.certification !== "").sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0)).map((row) => ({ id: `${kind}:${country}:${String(row.certification)}`, name: String(row.certification) }));
        if (own.length > 0) lists.push({ kind, ratings: own });
      }
      return lists;
    }
    async function loadServices() {
      const found = /* @__PURE__ */ new Map();
      const bodies = await Promise.all(["movie", "tv"].map((kind) => fetch(`${FILTERS_API}/watchproviders/${kind}?watchRegion=${region}`)));
      for (const row of bodies.flatMap(rowsOf)) {
        const id = String(row.id ?? "");
        if (!/^\d+$/.test(id) || typeof row.name !== "string" || found.has(id)) continue;
        found.set(id, { name: row.name.trim(), rank: Number(row.displayPriority) || 0 });
      }
      return Array.from(found, ([id, entry]) => ({ id, ...entry })).sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name)).map(({ id, name }) => ({ id, name }));
    }
    return {
      region,
      genres: () => genres = once(genres, loadGenres, () => {
        genres = null;
      }),
      languages: (locale) => languages = once(languages, () => loadLanguages(locale), () => {
        languages = null;
      }),
      ratings: () => ratings = once(ratings, loadRatings, () => {
        ratings = null;
      }),
      services: () => services = once(services, loadServices, () => {
        services = null;
      }),
      /** The keywords TMDB has for what is typed; `signal` ends the request when a newer search starts. */
      async searchKeywords(query, signal) {
        const body = await fetch(`/JellyfinEnhanced/tmdb/search/keyword?query=${encodeURIComponent(query)}`, { signal });
        return rowsOf(isRecord3(body) ? body.results : null).filter((row) => typeof row.name === "string" && /^\d+$/.test(String(row.id ?? ""))).map((row) => ({ id: String(row.id), name: String(row.name) }));
      }
    };
  }

  // client/src/features/seerr/discovery/filter-groups.ts
  var TYPING_MS = 700;
  var SEARCH_MS = 350;
  var SEARCHABLE_FROM = 15;
  var KEYWORD_RESULTS = 8;
  var hints = 0;
  var NAMES = Object.freeze({
    role: ["discovery_filter_role", "Role"],
    year: ["discovery_filter_released", "Released"],
    score: ["discovery_filter_score", "Score"],
    votes: ["discovery_filter_votes", "Votes"],
    runtime: ["discovery_filter_runtime", "Runtime"],
    genres: ["discovery_filter_genres", "Genres"],
    language: ["discovery_filter_language", "Original language"],
    rating: ["discovery_filter_rating", "Content rating"],
    services: ["discovery_filter_services", "Streaming services"],
    keywords: ["discovery_filter_keywords", "Keywords"],
    without: ["discovery_filter_without", "Without keywords"],
    withoutGenres: ["discovery_filter_without_genres", "Without genres"],
    withoutLanguage: ["discovery_filter_without_language", "Without language"]
  });
  var HINTS = Object.freeze({
    // (The example dates are written with the hyphen and the space that do not break, so a date is never split, nor left alone on a line.)
    year: ["discovery_filter_year_hint", "A year, a month (2015‑06) or a day (2015‑06‑30).", "discovery_filter_year_error", "Type a year (2015), a month (2015‑06) or a day (2015‑06‑30)."],
    score: ["discovery_filter_score_range_hint", "0 to 10, one decimal at most (7.5).", "discovery_filter_score_error", "Type a score from 0 to 10, such as 7.5."],
    votes: ["discovery_filter_votes_hint", "How many people have scored it: a whole number.", "discovery_filter_number_error", "Type a whole number, such as 500."],
    runtime: ["discovery_filter_runtime_hint", "In whole minutes.", "discovery_filter_number_error", "Type a whole number, such as 500."]
  });
  var RULES = Object.freeze({
    role: ["discovery_filter_rule_role", "Any of the roles ticked."],
    genres: ["discovery_filter_rule_genres", "All of the genres ticked."],
    language: ["discovery_filter_rule_language", "Any of the languages ticked."],
    rating: ["discovery_filter_rule_rating", "Any of the ratings ticked."],
    services: ["discovery_filter_rule_services", "Any of the services ticked."],
    keywords: ["discovery_filter_rule_keywords", "All of the keywords ticked."],
    without: ["discovery_filter_rule_without", "None of the keywords ticked."],
    withoutGenres: ["discovery_filter_rule_without_genres", "None of the genres ticked."],
    withoutLanguage: ["discovery_filter_rule_without_language", "None of the languages ticked."]
  });
  var ANY_OF = /* @__PURE__ */ new Set(["role", "language", "rating"]);
  var NONE_OF = /* @__PURE__ */ new Set(["without", "withoutGenres", "withoutLanguage"]);
  var PARTNERS = Object.freeze({
    genres: "withoutGenres",
    withoutGenres: "genres",
    language: "withoutLanguage",
    withoutLanguage: "language",
    keywords: "without",
    without: "keywords"
  });
  var isMatchId = (id) => Object.prototype.hasOwnProperty.call(MATCH_DEFAULTS, id);
  var listRule = (selection, id) => isMatchId(id) ? matchOf(selection, id) : ANY_OF.has(id) ? "any" : NONE_OF.has(id) ? "none" : "";
  function usable(id, range) {
    return !range ? ["", ""] : isReversed(id, range) ? [range[1].trim(), range[0].trim()] : [isBound(id, range[0], false) ? range[0].trim() : "", isBound(id, range[1], true) ? range[1].trim() : ""];
  }
  function sayBound(id, text, locale) {
    if (id !== "votes" && id !== "runtime") return text;
    try {
      return new Intl.NumberFormat(locale || void 0).format(Number(text));
    } catch {
      return text;
    }
  }
  var without = (selection, id) => ({ ...selection, [id]: void 0 });
  var withList = (selection, id, list) => ({ ...selection, [id]: list.length > 0 ? list : void 0 });
  function filterTokens({ offered, label: say, locale, selection, ownGenre }) {
    const tokens = [];
    for (const id of offered) {
      if (isRangeId(id)) {
        const [from, to] = usable(id, selection[id]);
        if (!from && !to) continue;
        const unit = id === "runtime" ? ` ${say("discovery_filter_minutes", "min")}` : "";
        const values = { name: say(NAMES[id][0], NAMES[id][1]), from: `${sayBound(id, from, locale)}${unit}`, to: `${sayBound(id, to, locale)}${unit}` };
        const words = from && to ? say("discovery_filter_set_range", "{name} {from} to {to}", { ...values, from: sayBound(id, from, locale) }) : from ? say("discovery_filter_set_from", "{name} from {from}", values) : say("discovery_filter_set_to", "{name} up to {to}", values);
        tokens.push({ words, without: (now) => without(now, id) });
        continue;
      }
      const rule = listRule(selection, id);
      const own = id === "genres" ? ownGenre?.trim().toLocaleLowerCase() ?? "" : "";
      const isOwn = (item) => own !== "" && item.name.toLocaleLowerCase() === own;
      const items = (selection[id] ?? []).filter((item) => !isOwn(item));
      const alone = (item) => id === "without" ? say("discovery_filter_set_without", "Without {name}", { name: item.name }) : id === "withoutGenres" ? say("discovery_filter_set_not", "Not {name}", { name: item.name }) : id === "withoutLanguage" ? say("discovery_filter_set_not_language", "Not originally in {name}", { name: item.name }) : id === "keywords" ? say("discovery_filter_set_with", "With {name}", { name: item.name }) : id === "language" ? say("discovery_filter_set_language", "Originally in {name}", { name: item.name }) : id === "services" ? say("discovery_filter_set_on", "On {name}", { name: item.name }) : item.name;
      const more = (item) => id === "without" ? say("discovery_filter_set_without_more", "without {name}", { name: item.name }) : id === "withoutLanguage" ? say("discovery_filter_set_not_language_more", "not originally in {name}", { name: item.name }) : say("discovery_filter_set_not_more", "not {name}", { name: item.name });
      for (const [index, item] of items.entries()) {
        const join = rule !== "" && index > 0 ? rule === "any" ? "or" : "and" : void 0;
        tokens.push({
          join,
          or: join === "or",
          list: id,
          // (After the word joining it to the one before, its own name is enough: "With bear or dragon". `alone`:
          // as it is said by itself, for what names one piece: Undo.)
          words: !join ? alone(item) : rule === "none" ? more(item) : item.name,
          alone: alone(item),
          without: (now) => withList(now, id, (now[id] ?? []).filter((entry) => entry.id !== item.id))
        });
      }
    }
    return tokens;
  }
  function filterMenuGroups(JE, options) {
    const { label: say, data, locale } = options;
    const any = say("discovery_filter_any", "Any");
    const anyOf = (id) => NONE_OF.has(id) ? say("discovery_filter_none", "None") : any;
    const nameOf2 = (id) => say(NAMES[id][0], NAMES[id][1]);
    const menuRow2 = (name, iconName, iconHidden) => {
      const menu = JE.discoveryMenu;
      if (!menu) throw new Error("Discovery menu is not loaded");
      return menu.menuRow(name, iconName, iconHidden);
    };
    const field = (group, placeholder, mode) => {
      const input = document.createElement("input");
      input.type = "text";
      input.className = "jellyseerr-menu-input";
      input.inputMode = mode;
      input.autocomplete = "off";
      input.spellcheck = false;
      input.placeholder = placeholder;
      input.setAttribute("aria-label", `${group}: ${placeholder}`);
      return input;
    };
    const note = (words) => {
      const line = document.createElement("div");
      line.className = "jellyseerr-menu-note";
      const text = document.createElement("bdi");
      text.textContent = words;
      line.appendChild(text);
      return line;
    };
    const sayIn = (line, words) => {
      const text = line.firstElementChild ?? line;
      if (text.textContent !== words) text.textContent = words;
    };
    const sayRange = (id, [from, to]) => {
      const unit = id === "runtime" ? ` ${say("discovery_filter_minutes", "min")}` : "";
      const [low, high] = [sayBound(id, from, locale), sayBound(id, to, locale)];
      if (from && to) return `${say("discovery_filter_range", "{from} to {to}", { from: low, to: high })}${unit}`;
      return `${from ? say("discovery_filter_from_value", "From {from}", { from: low }) : say("discovery_filter_to_value", "Up to {to}", { to: high })}${unit}`;
    };
    function rangeGroup(id) {
      const set = usable(id, options.selection()[id]);
      return {
        id,
        name: nameOf2(id),
        any,
        set: set[0] !== "" || set[1] !== "",
        value: sayRange(id, set),
        describe() {
          const now = usable(id, options.selection()[id]);
          return { value: sayRange(id, now), set: now[0] !== "" || now[1] !== "" };
        },
        build(host, handle) {
          const row = document.createElement("div");
          row.className = "jellyseerr-menu-range";
          const mode = id === "score" ? "decimal" : "numeric";
          const from = field(nameOf2(id), say("discovery_filter_from", "From"), mode);
          const to = field(nameOf2(id), say("discovery_filter_to", "To"), mode);
          const now = options.selection()[id];
          from.value = now?.[0] ?? "";
          to.value = now?.[1] ?? "";
          const dash = document.createElement("span");
          dash.setAttribute("aria-hidden", "true");
          dash.textContent = "–";
          row.append(from, dash, to);
          const labels = document.createElement("div");
          labels.className = "jellyseerr-menu-range jellyseerr-menu-range-labels";
          const spacer = document.createElement("span");
          spacer.className = "jellyseerr-menu-range-spacer";
          spacer.setAttribute("aria-hidden", "true");
          spacer.textContent = "–";
          const labelFor = (input, words) => {
            input.id = `jellyseerr-menu-bound-${++hints}`;
            input.placeholder = "";
            const text = document.createElement("label");
            text.className = "jellyseerr-menu-bound";
            text.htmlFor = input.id;
            text.textContent = words;
            return text;
          };
          labels.append(labelFor(from, say("discovery_filter_from", "From")), spacer, labelFor(to, say("discovery_filter_to", "To")));
          host.appendChild(labels);
          const [hintKey, hintWords, errorKey, errorWords] = HINTS[id];
          const hint = note(say(hintKey, hintWords));
          hint.id = `jellyseerr-menu-hint-${++hints}`;
          hint.setAttribute("aria-live", "polite");
          for (const input of [from, to]) input.setAttribute("aria-describedby", hint.id);
          host.append(row, hint);
          let timer = 0;
          const take = () => {
            window.clearTimeout(timer);
            const typed = [from.value, to.value];
            const bad = [!isBound(id, typed[0], false), !isBound(id, typed[1], true)];
            [from, to].forEach((input, index) => {
              if (bad[index]) input.setAttribute("aria-invalid", "true");
              else input.removeAttribute("aria-invalid");
            });
            sayIn(hint, bad[0] || bad[1] ? say(errorKey, errorWords) : say(hintKey, hintWords));
            hint.toggleAttribute("data-error", bad[0] || bad[1]);
            const next = usable(id, typed);
            const before = usable(id, options.selection()[id]);
            if (next[0] === before[0] && next[1] === before[1]) return;
            const isSet = next[0] !== "" || next[1] !== "";
            handle.say(isSet ? sayRange(id, next) : "", isSet);
            options.change({ ...options.selection(), [id]: isSet ? next : void 0 });
          };
          const pageNow = () => {
            const hash = window.location.hash;
            return `${JE.discoveryAddress?.withoutOwn?.(hash) ?? hash}|${JE.discoveryAddress?.categoryOfHash?.(hash) ?? ""}`;
          };
          for (const input of [from, to]) {
            input.addEventListener("input", () => {
              window.clearTimeout(timer);
              const page = pageNow();
              timer = window.setTimeout(() => {
                if (pageNow() === page) take();
              }, TYPING_MS);
            });
            input.addEventListener("change", take);
            input.addEventListener("keydown", (event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                take();
              }
            });
          }
        }
      };
    }
    const othersOf = (ticked, id) => {
      const own = id === "genres" ? options.ownGenre?.trim().toLocaleLowerCase() ?? "" : "";
      return own && ticked.length > 1 ? ticked.filter((item) => item.name.toLocaleLowerCase() !== own) : ticked;
    };
    const sayList = (ticked, id) => {
      const picked = othersOf(ticked, id);
      const rule = listRule(options.selection(), id);
      if (picked.length >= 2 && rule !== "") {
        const anyRule = rule !== "all";
        const names = picked.map((item) => item.name);
        let joined = null;
        try {
          joined = new Intl.ListFormat(locale || "en", { style: "long", type: anyRule ? "disjunction" : "conjunction" }).format(names);
        } catch {
          joined = null;
        }
        if (joined) return joined;
        if (picked.length > 2 && rule === "none") return say("discovery_filter_none_of", "None of {count}", { count: picked.length });
        if (picked.length > 2) return anyRule ? say("discovery_filter_any_of", "Any of {count}", { count: picked.length }) : say("discovery_filter_all_of", "All of {count}", { count: picked.length });
        const two = { first: names[0] ?? "", second: names[1] ?? "" };
        return anyRule ? say("discovery_filter_either", "{first} or {second}", two) : say("discovery_filter_both", "{first} and {second}", two);
      }
      return picked.map((item) => item.name).join(", ");
    };
    const shortList = (ticked, id) => {
      const picked = othersOf(ticked, id);
      if (picked.length < 2) return void 0;
      const rule = listRule(options.selection(), id);
      if (rule === "") return say("discovery_filter_count", "{count} chosen", { count: picked.length });
      if (rule === "none") return say("discovery_filter_none_of", "None of {count}", { count: picked.length });
      return rule === "any" ? say("discovery_filter_any_of", "Any of {count}", { count: picked.length }) : say("discovery_filter_all_of", "All of {count}", { count: picked.length });
    };
    const pickedOf = (id) => options.selection()[id] ?? [];
    const searchWord = (id) => id === "genres" || id === "withoutGenres" ? say("discovery_filter_search_genres", "Search genres") : id === "services" ? say("discovery_filter_search_services", "Search services") : id === "language" || id === "withoutLanguage" ? say("discovery_filter_search_languages", "Search languages") : say("discovery_filter_search", "Search");
    const matchable = (id) => isMatchId(id) && !(options.fixedAll ?? []).includes(id);
    const matchLines = /* @__PURE__ */ new Map();
    const markIdle = (id, ticked) => {
      const own = id === "genres" ? options.ownGenre?.trim().toLocaleLowerCase() ?? "" : "";
      const count = own ? ticked.filter((item) => item.name.toLocaleLowerCase() !== own).length : ticked.length;
      matchLines.get(id)?.toggleAttribute("data-idle", count < 2);
    };
    const ruleOf = (id, handle) => {
      if (!matchable(id)) return note(say(RULES[id][0], RULES[id][1]));
      const line = document.createElement("div");
      line.className = "jellyseerr-menu-note jellyseerr-menu-match";
      const lead = document.createElement("span");
      lead.className = "jellyseerr-menu-match-lead";
      lead.setAttribute("aria-hidden", "true");
      lead.textContent = id === "genres" && options.ownGenre ? say("discovery_filter_match_given", "Titles in {genre} and", { genre: options.ownGenre }) : id === "services" ? say("discovery_filter_match_on", "Titles on") : say("discovery_filter_match", "Titles with");
      const track = document.createElement("div");
      track.className = "jellyseerr-menu-match-track";
      track.setAttribute("role", "radiogroup");
      track.setAttribute("aria-label", say("discovery_filter_match_label", "{filter}: {rule}", { filter: nameOf2(id), rule: lead.textContent }));
      line.append(lead, track);
      const halves = [
        ["all", say("discovery_filter_match_all", "all ticked")],
        ["any", say("discovery_filter_match_any", "any ticked")]
      ];
      const buttons = halves.map(([value, words]) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "jellyseerr-menu-match-btn";
        button.setAttribute("role", "radio");
        button.dataset.match = value;
        const reserve = document.createElement("span");
        reserve.className = "jellyseerr-menu-match-reserve";
        reserve.setAttribute("aria-hidden", "true");
        reserve.textContent = words;
        button.append(words, reserve);
        button.addEventListener("click", () => {
          const now = options.selection();
          if (matchOf(now, id) === value) return;
          const match = { ...now.match ?? {}, [id]: value };
          if (value === MATCH_DEFAULTS[id]) delete match[id];
          paint(value);
          const picked = pickedOf(id);
          options.change({ ...now, match: Object.keys(match).length > 0 ? match : void 0 });
          handle?.say(sayList(picked, id), picked.length > 0, shortList(picked, id));
        });
        return button;
      });
      const paint = (value) => buttons.forEach((button) => {
        const on = button.dataset.match === value;
        button.setAttribute("aria-checked", String(on));
        button.tabIndex = on ? 0 : -1;
      });
      paint(matchOf(options.selection(), id));
      matchLines.set(id, line);
      markIdle(id, pickedOf(id));
      track.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        const focused = document.activeElement;
        const at = focused instanceof HTMLButtonElement ? buttons.indexOf(focused) : -1;
        const forward = event.key === "ArrowRight" !== (getComputedStyle(track).direction === "rtl");
        const next = buttons[at + (forward ? 1 : -1)];
        if (at < 0 || !next) return;
        event.preventDefault();
        event.stopPropagation();
        next.focus({ preventScroll: true });
        if (!document.documentElement.classList.contains("layout-tv")) next.click();
      });
      track.append(...buttons);
      return line;
    };
    function tickRow(id, item, handle, onToggle, given = false) {
      const chosenNow = given || pickedOf(id).some((entry) => entry.id === item.id);
      const box = (chosen) => chosen ? "check_box" : "check_box_outline_blank";
      const { item: row } = menuRow2(item.name, box(chosenNow), false);
      row.classList.add("jellyseerr-menu-tick");
      row.setAttribute("role", "checkbox");
      row.setAttribute("aria-checked", String(chosenNow));
      const partner = PARTNERS[id];
      if (!given && !chosenNow && partner && pickedOf(partner).some((entry) => entry.id === item.id)) {
        const elsewhere = document.createElement("div");
        elsewhere.className = "listItemBodyText secondary jellyseerr-menu-given jellyseerr-menu-elsewhere";
        elsewhere.textContent = say("discovery_filter_ticked_under", "Ticked under {list}", { list: nameOf2(partner) });
        row.querySelector(".actionsheetListItemBody")?.appendChild(elsewhere);
      }
      if (given) {
        row.setAttribute("aria-disabled", "true");
        const why = document.createElement("div");
        why.className = "listItemBodyText secondary jellyseerr-menu-given";
        why.textContent = say("discovery_filter_given", "Included by this page");
        row.querySelector(".actionsheetListItemBody")?.appendChild(why);
        return row;
      }
      row.addEventListener("click", () => {
        const before = pickedOf(id);
        const chosen = !before.some((entry) => entry.id === item.id);
        row.querySelector(".jellyseerr-menu-elsewhere")?.remove();
        const next = chosen ? [...before, item] : before.filter((entry) => entry.id !== item.id);
        row.setAttribute("aria-checked", String(chosen));
        const tick = row.querySelector(".actionsheetMenuItemIcon");
        if (tick) {
          tick.classList.remove(box(!chosen));
          tick.classList.add(box(chosen));
        }
        handle.say(sayList(next, id), next.length > 0, shortList(next, id));
        markIdle(id, next);
        let selection = withList(options.selection(), id, next);
        const other = partner ? pickedOf(partner) : [];
        if (partner && chosen && other.some((entry) => entry.id === item.id)) {
          const rest = other.filter((entry) => entry.id !== item.id);
          selection = withList(selection, partner, rest);
          handle.other?.(partner, sayList(rest, partner), rest.length > 0, shortList(rest, partner));
        }
        options.change(selection);
        onToggle?.(chosen, row);
      });
      return row;
    }
    function showFound(row, name, at, length) {
      const text = row.querySelector(".actionSheetItemText");
      if (!text) return;
      if (at < 0 || length === 0) {
        text.textContent = name;
        return;
      }
      const found = document.createElement("span");
      found.className = "jellyseerr-menu-found";
      found.textContent = name.slice(at, at + length);
      const whole = document.createElement("span");
      whole.append(name.slice(0, at), found, name.slice(at + length));
      text.replaceChildren(whole);
    }
    function listGroup(id, load, first = [], given = () => false) {
      const picked = pickedOf(id);
      return {
        id,
        name: nameOf2(id),
        any: anyOf(id),
        set: picked.length > 0,
        value: sayList(picked, id),
        short: shortList(picked, id),
        describe() {
          const now = pickedOf(id);
          return { value: sayList(now, id), set: now.length > 0, short: shortList(now, id) };
        },
        build(host, handle) {
          const waiting = note(say("discovery_filter_loading", "Loading…"));
          host.appendChild(waiting);
          load().then((sections) => {
            if (!host.isConnected) return;
            waiting.remove();
            const list = document.createElement("div");
            list.className = "jellyseerr-menu-list";
            const none = note(say("discovery_filter_no_match", "No match."));
            none.hidden = true;
            const long = sections.reduce((count, section) => count + section.items.length, 0) > SEARCHABLE_FROM;
            const rows = [];
            const add = (item) => {
              const row = tickRow(id, item, handle, void 0, given(item));
              rows.push({ row, name: item.name });
              list.appendChild(row);
            };
            const listed = new Set(sections.flatMap((section) => section.items.map((item) => item.id)));
            for (const item of pickedOf(id)) if (!listed.has(item.id)) add(item);
            const lifted = new Set(long && sections.length === 1 ? [...pickedOf(id).map((item) => item.id), ...first] : []);
            for (const section of sections) {
              if (section.label) {
                const heading = document.createElement("div");
                heading.className = "jellyseerr-menu-label";
                heading.textContent = section.label;
                list.appendChild(heading);
              }
              const head = [...lifted].map((wanted) => section.items.find((item) => item.id === wanted)).filter((item) => item !== void 0);
              for (const item of head) add(item);
              if (head.length > 0 && head.length < section.items.length) {
                const rule2 = document.createElement("div");
                rule2.className = "jellyseerr-menu-list-rule";
                rule2.setAttribute("role", "separator");
                list.appendChild(rule2);
              }
              for (const item of section.items) if (!lifted.has(item.id)) add(item);
            }
            const rule = ruleOf(id, handle);
            if (long) {
              const whole = Array.from(list.children);
              const search = field(nameOf2(id), searchWord(id), "search");
              search.classList.add("jellyseerr-menu-search");
              const bar = document.createElement("div");
              bar.className = "jellyseerr-menu-searchbar";
              bar.appendChild(search);
              search.addEventListener("input", () => {
                const wanted = search.value.trim().toLocaleLowerCase();
                if (wanted === "") {
                  for (const entry of rows) showFound(entry.row, entry.name, -1, 0);
                  list.replaceChildren(...whole);
                  none.hidden = true;
                  handle.placed();
                  return;
                }
                const found = rows.map((entry, index) => {
                  const at = entry.name.toLocaleLowerCase().indexOf(wanted);
                  const rank = at < 0 ? -1 : at === 0 ? 0 : /[\p{L}\p{N}]/u.test(entry.name[at - 1] ?? "") ? 2 : 1;
                  return { ...entry, index, at, rank };
                }).filter((entry) => entry.rank >= 0).sort((a, b) => a.rank - b.rank || a.index - b.index);
                for (const entry of found) showFound(entry.row, entry.name, entry.at, wanted.length);
                list.replaceChildren(...found.map((entry) => entry.row));
                none.hidden = found.length > 0;
                handle.placed();
              });
              bar.appendChild(rule);
              host.appendChild(bar);
            } else host.appendChild(rule);
            host.append(list, none);
            handle.placed();
          }).catch(() => {
            sayIn(waiting, say("discovery_filter_unavailable", "Could not load these."));
          });
        }
      };
    }
    function keywordGroup(id) {
      const picked = pickedOf(id);
      return {
        id,
        name: nameOf2(id),
        any: anyOf(id),
        set: picked.length > 0,
        value: sayList(picked, id),
        short: shortList(picked, id),
        describe() {
          const now = pickedOf(id);
          return { value: sayList(now, id), set: now.length > 0, short: shortList(now, id) };
        },
        build(host, handle) {
          const chosen = document.createElement("div");
          chosen.className = "jellyseerr-menu-list";
          const rule = ruleOf(id, handle);
          const found = document.createElement("div");
          found.className = "jellyseerr-menu-list";
          const keep = (item) => {
            chosen.appendChild(tickRow(id, item, handle, (isChosen, row) => {
              if (!isChosen) {
                const held = row.contains(document.activeElement);
                const sibling = row.nextElementSibling ?? row.previousElementSibling;
                const next = sibling instanceof HTMLElement ? sibling : null;
                row.remove();
                if (held) (next ?? search).focus();
              }
              rule.hidden = chosen.childElementCount === 0;
              if (!isChosen && search.value.trim() === "") sayStatus(resting());
              handle.placed();
            }));
          };
          const search = field(nameOf2(id), say("discovery_filter_search_keywords", "Search keywords"), "search");
          search.classList.add("jellyseerr-menu-search");
          const bar = document.createElement("div");
          bar.className = "jellyseerr-menu-searchbar";
          bar.appendChild(search);
          rule.hidden = chosen.childElementCount === 0;
          const status = note("");
          status.hidden = true;
          status.setAttribute("aria-live", "polite");
          let timer = 0;
          let asking = null;
          const sayStatus = (words) => {
            sayIn(status, words);
            status.hidden = words === "";
          };
          const hint = id === "without" ? say("discovery_filter_without_hint", "Titles tagged with these words are left out.") : say("discovery_filter_keywords_hint", "Words a title is tagged with, such as “heist” or “time travel”.");
          const resting = () => search.value.trim().length === 1 ? say("discovery_filter_two_letters", "Type two letters or more.") : search.value.trim() === "" && chosen.childElementCount === 0 ? hint : "";
          for (const item of pickedOf(id)) keep(item);
          rule.hidden = chosen.childElementCount === 0;
          const look = () => {
            asking?.abort();
            const wanted = search.value.trim();
            found.replaceChildren();
            if (wanted.length < 2) {
              sayStatus(resting());
              handle.placed();
              return;
            }
            const request = new AbortController();
            asking = request;
            sayStatus(say("discovery_filter_loading", "Loading…"));
            data.searchKeywords(wanted, request.signal).then((results) => {
              if (request.signal.aborted || !host.isConnected) return;
              const fresh = results.filter((item) => !pickedOf(id).some((entry) => entry.id === item.id)).slice(0, KEYWORD_RESULTS);
              for (const item of fresh) {
                const row = found.appendChild(tickRow(id, item, handle, (isChosen, pressed) => {
                  if (isChosen) {
                    pressed.remove();
                    keep(item);
                    window.clearTimeout(timer);
                    asking?.abort();
                    search.value = "";
                    found.replaceChildren();
                    sayStatus(resting());
                    search.focus();
                  }
                  rule.hidden = chosen.childElementCount === 0;
                  handle.placed();
                }));
                showFound(row, item.name, item.name.toLocaleLowerCase().indexOf(wanted.toLocaleLowerCase()), wanted.length);
              }
              rule.hidden = chosen.childElementCount === 0;
              sayStatus(fresh.length === 0 ? say("discovery_filter_no_match", "No match.") : "");
              handle.placed();
            }).catch(() => {
              if (!request.signal.aborted) sayStatus(say("discovery_filter_unavailable", "Could not load these."));
            });
          };
          search.addEventListener("input", () => {
            window.clearTimeout(timer);
            timer = window.setTimeout(look, SEARCH_MS);
          });
          search.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              window.clearTimeout(timer);
              look();
            }
          });
          host.append(chosen, rule, bar, found, status);
          sayStatus(resting());
        }
      };
    }
    const groups = [];
    for (const id of options.offered) {
      if (isRangeId(id)) groups.push(rangeGroup(id));
      else if (id === "role") groups.push(listGroup(id, async () => [{ items: options.roles?.() ?? [] }]));
      else if (id === "genres") {
        const own = options.ownGenre?.trim().toLocaleLowerCase() ?? "";
        groups.push(listGroup(id, async () => [{ items: await data.genres() }], [], (item) => own !== "" && item.name.toLocaleLowerCase() === own));
      } else if (id === "withoutGenres") {
        const own = options.ownGenre?.trim().toLocaleLowerCase() ?? "";
        groups.push(listGroup(id, async () => [{ items: (await data.genres()).filter((item) => own === "" || item.name.toLocaleLowerCase() !== own) }]));
      } else if (id === "language" || id === "withoutLanguage") {
        groups.push(listGroup(id, async () => [{ items: await data.languages(locale) }], [locale.split("-")[0]?.toLowerCase() ?? ""]));
      } else if (id === "services") groups.push(listGroup(id, async () => [{ items: await data.services() }]));
      else if (id === "rating") {
        groups.push(listGroup(id, async () => {
          const lists = (await data.ratings()).filter((list) => !options.kinds || options.kinds.includes(list.kind));
          return lists.map((list) => ({
            label: lists.length < 2 ? void 0 : list.kind === "movie" ? say("jellyseerr_quota_label_movie", "Movies") : say("jellyseerr_quota_label_tv", "Series"),
            items: list.ratings
          }));
        }));
      } else groups.push(keywordGroup(id));
    }
    return groups;
  }
  function undoWords({ offered, label: say, locale, ownGenre, before, now }) {
    const words = (selection) => filterTokens({ offered, label: say, locale, selection, ownGenre }).map((token) => token.alone ?? token.words);
    const had = new Set(words(before));
    const added = words(now).find((word) => !had.has(word));
    if (added) return say("discovery_filters_undo_what", "Undo “{change}”", { change: added });
    const ruled = Object.keys(MATCH_DEFAULTS).find((id) => matchOf(before, id) !== matchOf(now, id));
    if (ruled) {
      const rule = matchOf(now, ruled) === "any" ? say("discovery_filter_match_any", "any ticked") : say("discovery_filter_match_all", "all ticked");
      return say("discovery_filters_undo_rule", "Undo “{rule}” in {filter}", { rule, filter: say(NAMES[ruled][0], NAMES[ruled][1]) });
    }
    const has = new Set(words(now));
    const removed = words(before).find((word) => !has.has(word));
    return removed ? say("discovery_filters_undo_back", "Put back “{piece}”", { piece: removed }) : say("discovery_filters_undo", "Undo");
  }

  // client/src/features/seerr/discovery/profiles.ts
  var PROFILES_API = "discovery-filter-profiles";
  var isRecord4 = (value) => typeof value === "object" && value !== null;
  var isProfile = (value) => isRecord4(value) && typeof value.id === "string" && typeof value.name === "string" && typeof value.filters === "string";
  var withProfile = (list, saved) => {
    const at = list.findIndex((profile) => profile.id === saved.id);
    return at < 0 ? [...list, saved] : list.map((profile, index) => index === at ? saved : profile);
  };
  async function refusal(error) {
    if (!isRecord4(error)) return null;
    const said2 = isRecord4(error.responseJSON) ? error.responseJSON.error : error.error;
    if (said2) return said2;
    if (typeof error.json !== "function") return null;
    try {
      const body = await error.json();
      return isRecord4(body) ? body.error : null;
    } catch {
      return null;
    }
  }
  function createProfiles(JE, api) {
    let held = null;
    const client = () => {
      const found = api();
      const ajax = found?.ajax;
      if (!found || typeof ajax !== "function") return null;
      let user = "";
      try {
        user = found.getCurrentUserId() ?? "";
      } catch {
        user = "";
      }
      if (!user) return null;
      return {
        ajax: (request) => ajax.call(found, request),
        user,
        url: (path = "") => found.getUrl(`/JellyfinEnhanced/user-settings/${user}/${PROFILES_API}${path}`)
      };
    };
    const reachable = () => client() !== null;
    function load() {
      const api2 = client();
      if (!api2) return Promise.reject(new Error("Saved filters are not reachable"));
      const user = api2.user;
      if (held?.user === user) return held.asked;
      const asked = api2.ajax({ type: "GET", url: api2.url(), dataType: "json" }).then((answer) => ({
        max: isRecord4(answer) ? Number(answer.max) || 0 : 0,
        profiles: isRecord4(answer) && Array.isArray(answer.profiles) ? answer.profiles.filter(isProfile) : []
      }));
      const kept = { user, asked, list: null, max: 0 };
      held = kept;
      asked.then((answer) => {
        kept.list = answer.profiles;
        kept.max = answer.max;
      }, () => {
        if (held?.asked === asked) held = null;
      });
      return asked;
    }
    function keep(change) {
      const was = held;
      if (!was || was.user !== client()?.user || !Array.isArray(was.list)) {
        held = null;
        return;
      }
      const list = change(was.list);
      held = { user: was.user, list, max: was.max, asked: Promise.resolve({ max: was.max, profiles: list }) };
    }
    async function save(name, filters) {
      const api2 = client();
      if (!api2) throw new Error("Saved filters are not reachable");
      const answer = await api2.ajax({
        type: "POST",
        url: api2.url(),
        data: JSON.stringify({ name, filters }),
        contentType: "application/json",
        dataType: "json"
      });
      const profile = isRecord4(answer) ? answer.profile : null;
      if (!isProfile(profile)) throw new Error("The saved filters came back in an unknown shape");
      keep((list) => withProfile(list, profile));
      return profile;
    }
    async function remove(id) {
      const api2 = client();
      if (!api2) throw new Error("Saved filters are not reachable");
      await api2.ajax({ type: "DELETE", url: api2.url(`/${encodeURIComponent(id)}`) });
      keep((list) => list.filter((profile) => profile.id !== id));
    }
    JE.session?.onUserChange("discovery-filter-profiles", () => {
      held = null;
    });
    function group({ label: say, host, scope = "feed", offered = [], locale = "en" }) {
      const name = say("discovery_filter_profiles", "Saved filters");
      const none = say("discovery_filter_profiles_none", "None");
      const plain = (text) => {
        const address = JE.discoveryAddress;
        if (!address) return text;
        try {
          return address.filterPairs(address.filtersOf(text, scope), true).join("&");
        } catch {
          return text;
        }
      };
      const isNow = (profile) => plain(profile.filters) === plain(host.read());
      const sayRow = (list) => list.find(isNow)?.name ?? (list.length > 0 ? say("discovery_filter_profiles_count", "{count} saved", { count: list.length }) : none);
      const known = held && held.user === client()?.user ? held.list : null;
      const now = known ? known.find(isNow) : void 0;
      return {
        id: "profiles",
        name,
        any: known ? sayRow(known) : none,
        set: !!now,
        value: now?.name ?? none,
        build(body, handle) {
          const rows = document.createElement("div");
          rows.className = "jellyseerr-menu-list";
          const status = document.createElement("div");
          status.className = "jellyseerr-menu-note";
          status.setAttribute("aria-live", "polite");
          const sayStatus = (words, error = false) => {
            status.textContent = words;
            status.hidden = words === "";
            status.toggleAttribute("data-error", error);
          };
          const form = document.createElement("div");
          form.className = "jellyseerr-menu-range jellyseerr-menu-profile-form";
          const field = document.createElement("input");
          field.type = "text";
          field.className = "jellyseerr-menu-input";
          field.maxLength = 60;
          field.autocomplete = "off";
          field.placeholder = say("discovery_filter_profile_name", "Name these filters");
          field.setAttribute("aria-label", field.placeholder);
          const saveButton = document.createElement("button");
          saveButton.type = "button";
          saveButton.className = "jellyseerr-menu-profile-save emby-button raised";
          saveButton.textContent = say("discovery_filter_profile_save", "Save");
          form.append(field, saveButton);
          let list = [];
          const summaryOf = (filters) => {
            const read = JE.discoveryAddress?.filtersOf(filters, scope);
            if (!read) return [];
            const lists = [];
            const ranges = [];
            for (const token of filterTokens({ offered, label: say, locale, selection: read.selection })) {
              const into = token.list ? lists : ranges;
              if (token.join && into.length > 0) {
                into[into.length - 1] += ` ${token.join === "or" ? say("discovery_filter_or", "or") : say("discovery_filter_and", "and")} ${token.words}`;
              } else into.push(token.words);
            }
            const parts = [...lists, ...ranges];
            if (read.mode === "movies") parts.push(say("jellyseerr_quota_label_movie", "Movies"));
            else if (read.mode === "tv") parts.push(say("jellyseerr_quota_label_tv", "Series"));
            const order = (JE.discoveryFilter?.SORT_OPTIONS ?? []).find((option) => option.value !== "" && option.value === read.sort);
            if (order) parts.push(say(order.labelKey, order.label));
            return parts;
          };
          const sayUndo = (profile) => {
            const undo = document.createElement("button");
            undo.type = "button";
            undo.className = "jellyseerr-menu-profile-undo";
            undo.textContent = say("discovery_filter_profile_undo", "Undo");
            undo.addEventListener("click", () => {
              undo.disabled = true;
              const keyed = document.activeElement === undo;
              save(profile.name, profile.filters).then((saved) => {
                if (!body.isConnected) return;
                list = withProfile(list, saved);
                draw();
                sayStatus(say("discovery_filter_profile_restored", "Restored “{name}”.", { name: saved.name }));
                if (keyed) rows.querySelector(".jellyseerr-menu-profile-row:last-child .jellyseerr-menu-profile")?.focus();
                handle.say(sayRow(list), list.some(isNow));
                handle.placed();
              }).catch(() => {
                undo.disabled = false;
                sayStatus(say("discovery_filter_profile_error", "Could not save that. Try again."), true);
              });
            });
            const sentence = document.createElement("span");
            sentence.className = "jellyseerr-menu-profile-said";
            sentence.textContent = say("discovery_filter_profile_deleted", "Deleted “{name}”.", { name: profile.name });
            status.replaceChildren(sentence, " ", undo);
            status.hidden = false;
            status.removeAttribute("data-error");
          };
          const canSave = () => {
            saveButton.disabled = host.read() === "" || field.value.trim() === "";
          };
          const draw = () => {
            const menu = JE.discoveryMenu;
            if (!menu) return;
            const setNow = host.read();
            rows.replaceChildren(...list.map((profile) => {
              const current = isNow(profile);
              const { item } = menu.menuRow(profile.name, "check", !current);
              item.classList.add("jellyseerr-menu-profile");
              if (current) {
                item.setAttribute("aria-current", "true");
                const mark = document.createElement("span");
                mark.className = "material-icons check jellyseerr-menu-profile-mark";
                mark.setAttribute("aria-hidden", "true");
                item.querySelector(".actionSheetItemText")?.prepend(mark);
              }
              const says = summaryOf(profile.filters);
              if (says.length > 0) {
                const line = document.createElement("div");
                line.className = "listItemBodyText secondary jellyseerr-menu-profile-says";
                line.append(...says.flatMap((part, index) => {
                  const piece = document.createElement("span");
                  piece.className = "jellyseerr-menu-profile-part";
                  piece.textContent = index < says.length - 1 ? `${part} ·` : part;
                  return index < says.length - 1 ? [piece, " "] : [piece];
                }));
                item.querySelector(".actionsheetListItemBody")?.appendChild(line);
              }
              item.addEventListener("click", () => {
                handle.close?.();
                host.apply(profile.filters);
              });
              const removeButton = document.createElement("button");
              removeButton.type = "button";
              removeButton.className = "jellyseerr-menu-profile-delete";
              const removeLabel = say("discovery_filter_profile_delete", "Delete {name}", { name: profile.name });
              removeButton.setAttribute("aria-label", removeLabel);
              removeButton.title = removeLabel;
              const bin = document.createElement("span");
              bin.className = "material-icons delete_outline";
              bin.setAttribute("aria-hidden", "true");
              removeButton.appendChild(bin);
              removeButton.addEventListener("click", (event) => {
                event.stopPropagation();
                removeButton.disabled = true;
                const at = list.indexOf(profile);
                const keyed = document.activeElement === removeButton;
                remove(profile.id).then(() => {
                  list = list.filter((entry) => entry.id !== profile.id);
                  draw();
                  if (keyed) {
                    const deletes = rows.querySelectorAll(".jellyseerr-menu-profile-delete");
                    const head = body.previousElementSibling instanceof HTMLElement ? body.previousElementSibling : null;
                    (deletes[Math.min(at, deletes.length - 1)] ?? (field.disabled ? head : field))?.focus();
                  }
                  sayUndo(profile);
                  handle.say(sayRow(list), list.some(isNow));
                  handle.placed();
                }).catch(() => {
                  removeButton.disabled = false;
                  sayStatus(say("discovery_filter_profile_error", "Could not save that. Try again."), true);
                });
              });
              const wrap = document.createElement("div");
              wrap.className = "jellyseerr-menu-profile-row";
              wrap.append(item, removeButton);
              return wrap;
            }));
            const empty = setNow === "";
            field.disabled = empty;
            canSave();
            if (empty) sayStatus(say("discovery_filter_profile_nothing", "Set a filter to save it here."));
          };
          field.addEventListener("input", canSave);
          const store = async () => {
            const words = field.value.trim();
            if (!words) {
              field.focus();
              return;
            }
            saveButton.disabled = true;
            try {
              const saved = await save(words, host.read());
              list = withProfile(list, saved);
              field.value = "";
              draw();
              sayStatus(say("discovery_filter_profile_saved", "Saved as “{name}”.", { name: saved.name }));
              handle.say(sayRow(list), true);
            } catch (error) {
              const reason = await refusal(error);
              sayStatus(reason === "full" ? say("discovery_filter_profile_full", "Delete a saved one first: you have the most there can be.") : say("discovery_filter_profile_error", "Could not save that. Try again."), true);
            } finally {
              canSave();
              handle.placed();
            }
          };
          saveButton.addEventListener("click", () => {
            void store();
          });
          field.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void store();
            }
          });
          sayStatus(say("discovery_filter_loading", "Loading…"));
          body.append(rows, form, status);
          load().then((answer) => {
            if (!body.isConnected) return;
            list = answer.profiles;
            sayStatus("");
            draw();
            handle.say(sayRow(list), list.some(isNow));
            handle.placed();
          }).catch(() => {
            sayStatus(say("discovery_filter_unavailable", "Could not load these."), true);
            handle.placed();
          });
        }
      };
    }
    return { reachable, load, group };
  }

  // client/src/features/seerr/discovery/filter-panel.ts
  function createFilterPanel(JE, label, api = () => void 0) {
    const moreFilters = /* @__PURE__ */ new Map();
    const selectionOf = (name) => moreFilters.get(name) ?? {};
    const worthKeeping = (selection) => activeFilterCount(selection) > 0 || Object.keys(selection?.match ?? {}).length > 0;
    const fixedAllOf = /* @__PURE__ */ new Map();
    function takenBy(name, selection) {
      const fixed = fixedAllOf.get(name) ?? [];
      const match = selection?.match;
      if (!match || !fixed.some((id) => id in match)) return selection;
      const kept = Object.fromEntries(Object.entries(match).filter(([id]) => !fixed.some((entry) => entry === id)));
      const { match: _dropped, ...rest } = selection;
      return Object.keys(kept).length > 0 ? { ...rest, match: kept } : rest;
    }
    const keepSelection = (name, selection) => {
      const taken = takenBy(name, selection);
      if (worthKeeping(taken)) moreFilters.set(name, taken);
      else moreFilters.delete(name);
    };
    const profiles = createProfiles(JE, api);
    const credits = /* @__PURE__ */ new Map();
    const wiring = /* @__PURE__ */ new WeakMap();
    let filterData = null;
    function adminRegion() {
      if (JE.pluginConfig?.ElsewhereUseSeerrRegion && JE.pluginConfig.JellyseerrEnabled) {
        void JE.jellyseerrAPI?.getStreamingRegion?.();
        const seerrRegion = JE.jellyseerrAPI?.streamingRegion;
        if (seerrRegion) return seerrRegion;
      }
      const region = String(JE.pluginConfig?.DEFAULT_REGION ?? "").trim().toUpperCase();
      return /^[A-Z]{2}$/.test(region) ? region : "US";
    }
    function dataOf() {
      const region = adminRegion();
      if (!filterData || filterData.region !== region) {
        filterData = createFilterData({
          region,
          // The lists the further filters offer are asked for like every other lookup of these sections.
          fetch: (path, options) => JE.discoveryFilter?.fetchWithManagedRequest ? JE.discoveryFilter.fetchWithManagedRequest(path, "filters", options) : Promise.reject(new Error("Discovery requests are not available")),
          fetchGenres: (kind) => JE.discoveryFilter?.fetchTmdbGenreList ? JE.discoveryFilter.fetchTmdbGenreList(kind) : Promise.reject(new Error("Discovery requests are not available"))
        });
      }
      return filterData;
    }
    const MIXED = () => JE.discoveryFilter?.MODES?.MIXED ?? "mixed";
    const filterModeOf = (name) => JE.discoveryFilter?.getFilterMode?.(name) ?? MIXED();
    const isFilterMode2 = (id) => Object.values(JE.discoveryFilter?.MODES ?? { MIXED: "mixed", MOVIES: "movies", TV: "tv" }).includes(id);
    function heldAt2(section, header) {
      if (typeof JE.discoveryBusy?.heldAt === "function") return JE.discoveryBusy.heldAt(section, header);
      const bar = parseFloat(section.style.getPropertyValue("--jellyseerr-sticky-top")) || 0;
      const tuck = parseFloat(header.style.getPropertyValue("--jellyseerr-header-tuck")) || 0;
      return section.getBoundingClientRect().top + window.scrollY - bar + tuck + 2;
    }
    function roomUnderMenu(section, header, open) {
      if (!section) return;
      const bar = parseFloat(section.style.getPropertyValue("--jellyseerr-sticky-top")) || 0;
      const tuck = parseFloat(header.style.getPropertyValue("--jellyseerr-header-tuck")) || 0;
      section.style.minHeight = open ? `${Math.ceil(window.innerHeight - bar + tuck + 4)}px` : "";
    }
    function createFiltersControl(header, moduleName, scope, onChange, ownGenre, place, fixedAll = [], profilesHost = null) {
      injectStyleOnce("jellyseerr-discovery-filter-panel-styles", discovery_filter_panel_default);
      fixedAllOf.set(moduleName, fixedAll);
      if (takenBy(moduleName, selectionOf(moduleName)) !== selectionOf(moduleName)) keepSelection(moduleName, selectionOf(moduleName));
      const filtersLabel = label("discovery_filters", "Filters");
      const clearLabel = label("discovery_filters_clear", "Clear filters");
      const localeOf = () => document.documentElement.lang || "en";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "jellyseerr-filters-btn emby-tab-button emby-button";
      button.setAttribute("aria-haspopup", "dialog");
      button.setAttribute("aria-expanded", "false");
      const icon2 = document.createElement("span");
      icon2.className = "material-icons filter_alt";
      icon2.setAttribute("aria-hidden", "true");
      const typeWord = document.createElement("span");
      typeWord.className = "jellyseerr-filters-type";
      const name = document.createElement("span");
      name.className = "jellyseerr-filters-name";
      button.append(icon2, name, " ", typeWord);
      const offered = offeredFilters(scope, JE.pluginConfig);
      const typeOf = () => {
        const tabs = header.querySelector("[data-type-group]");
        return tabs ? JE.discoveryFilter?.typePickerOf?.(tabs) : void 0;
      };
      const sectionOf = place ?? (() => header.closest(".jellyseerr-discovery-section"));
      const paintSet = (focusAt = -1) => {
        const section = sectionOf();
        let line = section?.querySelector(".jellyseerr-filters-set") ?? null;
        const tokens = filterTokens({ offered, label, locale: localeOf(), selection: selectionOf(moduleName), ownGenre });
        const focused = document.activeElement;
        const keyedAt = line && focusAt < 0 && focused instanceof HTMLButtonElement ? Array.from(line.querySelectorAll("button")).indexOf(focused) : -1;
        if (!section || tokens.length === 0) {
          line?.remove();
          if (focusAt >= 0 || keyedAt >= 0) button.focus();
          return;
        }
        if (!line) {
          line = document.createElement("div");
          line.className = "jellyseerr-filters-set";
          line.setAttribute("role", "group");
          line.setAttribute("aria-label", filtersLabel);
          header.after(line);
        }
        const removes = [];
        const made = tokens.map((token, index) => {
          const piece = document.createElement("span");
          piece.className = "jellyseerr-filters-token";
          const words = document.createElement("span");
          words.dir = "auto";
          words.textContent = token.words;
          const remove = document.createElement("button");
          remove.type = "button";
          remove.className = "jellyseerr-filters-remove";
          const removeLabel = label("discovery_filter_remove", "Remove: {filter}", { filter: token.words });
          remove.setAttribute("aria-label", removeLabel);
          remove.title = removeLabel;
          const cross = document.createElement("span");
          cross.className = "material-icons close";
          cross.setAttribute("aria-hidden", "true");
          remove.appendChild(cross);
          remove.addEventListener("click", () => change(token.without(selectionOf(moduleName)), document.activeElement === remove ? index : -1));
          removes.push(remove);
          piece.append(words, remove);
          if (!token.join) return piece;
          const joined = document.createElement("span");
          joined.className = "jellyseerr-filters-join";
          joined.textContent = token.join === "or" ? label("discovery_filter_or", "or") : label("discovery_filter_and", "and");
          piece.prepend(joined, " ");
          piece.dataset.join = token.join;
          return piece;
        });
        const pieces = [];
        for (const [index, piece] of made.entries()) {
          const before = pieces[pieces.length - 1];
          if (piece.dataset.join === void 0 || !before) {
            pieces.push(piece);
            continue;
          }
          let run = before;
          if (!before.classList.contains("jellyseerr-filters-run")) {
            run = document.createElement("span");
            run.className = "jellyseerr-filters-run";
            run.setAttribute("role", "group");
            const list = tokens[index]?.list;
            if (list) run.setAttribute("aria-label", label(NAMES[list][0], NAMES[list][1]));
            pieces.splice(pieces.length - 1, 1, run);
            run.appendChild(before);
          }
          run.appendChild(piece);
        }
        if (tokens.length > 1) {
          const all = document.createElement("button");
          all.type = "button";
          all.className = "jellyseerr-filters-clear";
          all.textContent = clearLabel;
          all.addEventListener("click", () => change({}, document.activeElement === all ? 0 : -1));
          pieces.push(all);
        }
        line.replaceChildren(...pieces);
        if (focusAt >= 0) (removes[Math.min(focusAt, removes.length - 1)] ?? button).focus();
        else if (keyedAt >= 0) {
          const again = line.querySelectorAll("button");
          (again[Math.min(keyedAt, again.length - 1)] ?? button).focus();
        }
      };
      const paint = (focusAt = -1) => {
        const set = activeFilterCount(selectionOf(moduleName));
        const typed = filterModeOf(moduleName) === MIXED() ? 0 : 1;
        button.toggleAttribute("data-on", set > 0);
        if (place) button.classList.toggle("emby-tab-button-active", set > 0);
        button.toggleAttribute("data-type-on", typed > 0);
        typeWord.textContent = typed > 0 ? typeOf()?.groupOf().choices?.find((choice) => choice.selected)?.name ?? "" : "";
        button.toggleAttribute("data-type-only", offered.length === 0);
        name.textContent = set > 0 ? `${filtersLabel}: ${set}` : filtersLabel;
        const roles = selectionOf(moduleName).role ?? [];
        const section = sectionOf();
        if (section?.classList.contains("jellyseerr-discovery-section")) JE.discoveryBusy?.mark?.(section);
        section?.toggleAttribute("data-jobs-first", roles.length > 0 && !roles.some((role) => role.id === "cast"));
        if (section) {
          section.setAttribute(JE.discoveryRoles?.ROLE_ASKED ?? "data-role-asked", roles.map((role) => role.id).join("|"));
          JE.discoveryRoles?.fitRoleLines?.(section);
        }
        paintSet(focusAt);
      };
      wiring.set(header, { paint: (at = -1) => paint(at), reload: onChange });
      if (profilesHost && profiles.reachable()) profiles.load().catch(() => void 0);
      paint();
      let undoTo = null;
      let undoFrom = null;
      const setNow = () => JSON.stringify([filterModeOf(moduleName), selectionOf(moduleName)]);
      function change(next, focusAt = -1) {
        undoTo = selectionOf(moduleName);
        if (worthKeeping(next)) moreFilters.set(moduleName, next);
        else moreFilters.delete(moduleName);
        undoFrom = setNow();
        paint(focusAt);
        JE.discoveryBusy?.hold?.(button);
        onChange();
      }
      const open = () => {
        const menu = JE.discoveryMenu;
        const type = typeOf();
        const typeInMenu = !!type && !type.tabsShowing();
        const groups = type && typeInMenu ? [{ ...type.groupOf(), open: true }] : [];
        if (profilesHost && profiles.reachable()) groups.push(profiles.group({ label, host: profilesHost, scope, offered, locale: localeOf() }));
        const mode = filterModeOf(moduleName);
        const pageKinds = (header.closest("[data-je-kinds]")?.getAttribute("data-je-kinds") ?? "").split(",").filter((kind) => kind === "movie" || kind === "tv");
        const kinds = mode === "movies" ? ["movie"] : mode === "tv" ? ["tv"] : pageKinds.length > 0 ? pageKinds : null;
        groups.push(...filterMenuGroups(JE, {
          offered,
          data: dataOf(),
          locale: localeOf(),
          label,
          kinds,
          fixedAll,
          selection: () => selectionOf(moduleName),
          change,
          ...ownGenre ? { ownGenre } : {},
          roles: () => rolesOf(
            credits.get(moduleName) ?? [],
            label("discovery_role_acting", "Acting"),
            (department) => label(`discovery_role_${department.toLowerCase().replace(/[^a-z]+/g, "_")}`, department)
          )
        }));
        if (groups.length === 0 || typeof menu?.openMenu !== "function") {
          roomUnderMenu(sectionOf(), header, false);
          return;
        }
        button.setAttribute("aria-expanded", "true");
        menu.openMenu({
          anchor: button,
          title: filtersLabel,
          groups,
          clearLabel,
          doneLabel: label("discovery_filters_done", "Done"),
          noneLabel: label("discovery_filters_none", "Nothing matches these filters."),
          undoLabel: () => undoWords({ offered, label, locale: localeOf(), ownGenre, before: undoTo ?? {}, now: selectionOf(moduleName) }),
          canUndo: () => undoTo !== null && undoFrom === setNow(),
          // (Back to what was set before the last change; the menu then says every group again.)
          onUndo() {
            if (!undoTo || undoFrom !== setNow()) return false;
            change(undoTo);
            undoTo = null;
            return true;
          },
          onClose: () => {
            button.setAttribute("aria-expanded", "false");
            roomUnderMenu(sectionOf(), header, false);
          },
          // The groups that are a list of choices; the others set themselves (filterMenuGroups).
          onPick(id, groupId) {
            if (groupId === "type" && isFilterMode2(id)) type?.choose(id);
          },
          onClear() {
            if (typeInMenu) type?.choose(MIXED());
            if (worthKeeping(selectionOf(moduleName))) change({});
          }
        });
      };
      button.addEventListener("click", () => {
        const section = sectionOf();
        const tv = document.documentElement.classList.contains("layout-tv");
        if (!tv) roomUnderMenu(section, header, true);
        const room = window.innerHeight - button.getBoundingClientRect().bottom - 12;
        const wanted = JE.discoveryMenu?.groupedMenuRoom?.(offered.length + 1) ?? 0;
        const to = section && !tv && room < wanted ? Math.round(heldAt2(section, header)) : 0;
        if (to <= window.scrollY + 1) {
          open();
          return;
        }
        const before = window.scrollY;
        window.scrollTo({ top: to });
        if (Math.abs(window.scrollY - before) < 1) {
          open();
          return;
        }
        requestAnimationFrame(() => requestAnimationFrame(open));
      });
      return button;
    }
    function noteIfEmpty(moduleName, container, hasMore) {
      if (!container) return;
      const section = container.closest(".jellyseerr-discovery-section");
      JE.discoveryBusy?.release?.(container);
      const headerOf = () => section?.querySelector(".jellyseerr-discovery-header") ?? container;
      wiring.get(headerOf())?.paint();
      section?.querySelector(".jellyseerr-filters-none")?.remove();
      const kind = container.classList.contains("filter-movies") ? '[data-media-type="movie"]' : container.classList.contains("filter-tv") ? '[data-media-type="tv"]' : "";
      if (hasMore || activeFilterCount(selectionOf(moduleName)) === 0 || container.querySelector(`.card${kind}`)) return;
      const buildMessageRow2 = JE.discoverySection?.buildMessageRow;
      if (typeof buildMessageRow2 !== "function") return;
      const note = buildMessageRow2({
        message: label("discovery_filters_none", "Nothing matches these filters."),
        actionLabel: label("discovery_filters_clear", "Clear filters"),
        onAction() {
          const wired = wiring.get(headerOf());
          const keyed = note.contains(document.activeElement);
          moreFilters.delete(moduleName);
          wired?.paint(keyed ? 0 : -1);
          wired?.reload();
        }
      });
      note.classList.add("jellyseerr-filters-none");
      container.after(note);
    }
    injectStyleOnce("jellyseerr-discovery-filter-panel-styles", discovery_filter_panel_default);
    return {
      FILTER_SWITCHES,
      MATCH_DEFAULTS,
      offeredFilters,
      activeFilterCount,
      checkableOnLoaded,
      matchOf,
      routeFeed,
      dayOf,
      numberOf,
      isBound,
      isReversed,
      feedFilterQuery,
      keepByFilters,
      rolesOf,
      createFilterData,
      createFiltersControl,
      /** What a feed's request carries for the section's further filters (the sort is the caller's). */
      feedQuery: (name, kind) => feedFilterQuery(selectionOf(name), kind, adminRegion()),
      /** A person's titles the section's filters keep; the titles are also kept as what the Role list is made of. */
      keep(name, results) {
        credits.set(name, results);
        return keepByFilters(results, selectionOf(name));
      },
      /** Whether any further filter is narrowing the section's list. */
      active: (name) => activeFilterCount(selectionOf(name)) > 0,
      /** Sets a module's further filters as a whole (from its page's address); the caller redraws and reloads. */
      setSelection: keepSelection,
      /** A section starts with nothing narrowing it: its further filters and the titles seen go. */
      reset(name) {
        moreFilters.delete(name);
        credits.delete(name);
        fixedAllOf.delete(name);
      },
      /** Redraws a header's Filters button (after All / Movies / Series changed); `element` is the header or inside it. */
      repaint(element) {
        if (!element) return;
        wiring.get(element.closest?.(".jellyseerr-discovery-header") ?? element)?.paint();
      },
      noteIfEmpty,
      roomUnderMenu,
      filterMenuGroups: (options) => filterMenuGroups(JE, options),
      filterTokens,
      undoWords,
      /** The section's selection, for tests and the facade. */
      selectionOf
    };
  }

  // client/src/features/seerr/discovery/menu-parts.ts
  var isBackKey = (event) => event.key === "Escape" || event.key === "BrowserBack" || event.key === "GoBack" || event.keyCode === 10009 || event.keyCode === 461;
  function icon(name, hidden = false) {
    const span = document.createElement("span");
    span.className = `actionsheetMenuItemIcon listItemIcon listItemIcon-transparent material-icons ${name}`;
    span.setAttribute("aria-hidden", "true");
    if (hidden) span.style.visibility = "hidden";
    return span;
  }
  function menuRow(name, iconName, iconHidden) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "listItem listItem-button actionSheetMenuItem emby-button";
    const body = document.createElement("div");
    body.className = "listItemBody actionsheetListItemBody";
    const text = document.createElement("div");
    text.className = "listItemBodyText actionSheetItemText";
    text.textContent = name;
    body.appendChild(text);
    item.append(icon(iconName, iconHidden), body);
    return { item, text, body };
  }
  function choiceRow(choice, groupId) {
    const { item } = menuRow(choice.name, "check", !choice.selected);
    item.dataset.id = choice.id;
    if (groupId !== void 0) item.dataset.group = groupId;
    item.setAttribute("role", groupId === void 0 ? "menuitemradio" : "radio");
    item.setAttribute("aria-checked", String(choice.selected));
    return item;
  }
  function groupedMenuRoom(groupCount) {
    const row = window.matchMedia?.("(max-width: 600px)").matches ? 48 : 36;
    return Math.min((groupCount + 1) * row + 24 + 110, Math.round(window.innerHeight * 0.72));
  }
  function showValue(el, words, short) {
    el.textContent = words;
    el.dataset.whole = words;
    el.dataset.short = short ?? "";
    el.title = "";
    if (short && short !== words && el.isConnected && el.scrollWidth > el.clientWidth + 1) {
      const seen = document.createElement("span");
      seen.setAttribute("aria-hidden", "true");
      seen.textContent = short;
      const whole = document.createElement("span");
      whole.className = "jellyseerr-menu-whole";
      whole.textContent = words;
      el.replaceChildren(seen, whole);
      el.title = words;
    }
  }
  function watchOutcome(options) {
    const { band, anchor, noneLabel, undoLabel, onUndo, canUndo } = options;
    const scope = anchor.closest(".jellyseerr-discovery-section") ?? anchor.closest(".page") ?? document.body;
    const sayOutcome = () => {
      if (options.closed()) return;
      const none = Array.from(scope.querySelectorAll(".jellyseerr-filters-none, .je-reco-filters-none")).some((note) => !note.closest(".hide, [hidden]"));
      const undoable = none && !!(undoLabel && onUndo) && (canUndo?.() ?? true);
      const undoWords2 = undoable ? (typeof undoLabel === "function" ? undoLabel() : undoLabel) ?? "" : "";
      if (band.hidden === !none && (band.dataset.undo ?? "") === undoWords2) return;
      band.dataset.undo = undoWords2;
      const keyed = band.contains(document.activeElement);
      band.toggleAttribute("data-undoable", undoable);
      band.hidden = !none;
      band.replaceChildren();
      if (none) {
        const words = document.createElement("span");
        words.textContent = noneLabel;
        band.appendChild(words);
        if (undoable && onUndo) {
          const undo = document.createElement("button");
          undo.type = "button";
          undo.className = "jellyseerr-menu-outcome-undo";
          undo.textContent = undoWords2;
          undo.addEventListener("click", () => {
            const wasKeyed = document.activeElement === undo;
            if (!onUndo()) return;
            options.renew();
            if (wasKeyed) options.focusHome();
          });
          band.append(" ", undo);
          if (keyed) undo.focus({ preventScroll: true });
        }
      } else if (keyed) options.focusHome();
      options.placed();
    };
    let frame = 0;
    sayOutcome();
    if (typeof MutationObserver !== "function") return () => cancelAnimationFrame(frame);
    const watcher = new MutationObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(sayOutcome);
    });
    watcher.observe(scope, { childList: true, subtree: true });
    return () => {
      watcher.disconnect();
      cancelAnimationFrame(frame);
    };
  }

  // client/src/features/seerr/discovery/menu.ts
  var GROUPED_MIN_ROOM = 260;
  var EDGE = 8;
  var CUT_AT = 0.6;
  function createDiscoveryMenu(JE) {
    let closeOpen = null;
    let bodies = 0;
    function openMenu({ anchor, title, choices = [], groups, clearLabel, doneLabel, noneLabel, undoLabel, onUndo, canUndo, onPick, onClear, onClose }) {
      closeOpen?.();
      const tv = document.documentElement.classList.contains("layout-tv");
      const coarse = !!window.matchMedia?.("(pointer: coarse)").matches;
      const backdrop = document.createElement("div");
      backdrop.className = "dialogBackdrop dialogBackdropOpened jellyseerr-menu-backdrop";
      const container = document.createElement("div");
      container.className = "dialogContainer";
      const sheet = document.createElement("div");
      sheet.className = "focuscontainer dialog actionsheet-not-fullscreen actionSheet centeredDialog opened jellyseerr-sort-menu";
      sheet.setAttribute("role", groups ? "dialog" : "menu");
      sheet.setAttribute("aria-label", title);
      const content = document.createElement("div");
      content.className = "actionSheetContent";
      let outcome = null;
      let stopOutcome = null;
      if (tv) {
        const heading = document.createElement("h1");
        heading.className = "actionSheetTitle";
        heading.textContent = title;
        content.appendChild(heading);
      }
      let fittedWidth = -1;
      const fitValues = () => {
        const width = sheet.offsetWidth;
        if (width === fittedWidth) return;
        fittedWidth = width;
        for (const el of content.querySelectorAll(".jellyseerr-menu-group-value")) {
          showValue(el, el.dataset.whole ?? el.textContent ?? "", el.dataset.short || void 0);
        }
      };
      const scroller = document.createElement("div");
      scroller.className = "actionSheetScroller scrollY";
      for (const choice of choices) scroller.appendChild(choiceRow(choice));
      content.appendChild(scroller);
      let clear = null;
      if (groups) {
        sheet.classList.add("jellyseerr-menu-grouped");
        for (const group of groups) {
          const { item, body } = menuRow(group.name, "expand_more", false);
          item.classList.add("jellyseerr-menu-group");
          item.dataset.toggle = group.id;
          item.setAttribute("aria-expanded", "false");
          const value = document.createElement("div");
          value.className = "jellyseerr-menu-group-value";
          value.dir = "auto";
          const first = group.choices?.[0];
          const current = group.choices?.find((choice) => choice.selected) ?? first;
          const set = group.choices ? !!current && current !== first : group.set === true;
          showValue(value, group.choices ? current?.name ?? "" : (set ? group.value : group.any) ?? "", set ? group.short : void 0);
          item.toggleAttribute("data-set", set);
          body.appendChild(value);
          const list = document.createElement("div");
          list.className = "jellyseerr-menu-choices";
          list.id = `jellyseerr-menu-body-${++bodies}`;
          list.setAttribute("role", group.choices ? "radiogroup" : "group");
          list.setAttribute("aria-label", group.name);
          list.hidden = true;
          item.setAttribute("aria-controls", list.id);
          for (const choice of group.choices ?? []) list.appendChild(choiceRow(choice, group.id));
          const box = document.createElement("div");
          box.className = "jellyseerr-menu-groupbox";
          box.dataset.group = group.id;
          box.append(item, list);
          scroller.appendChild(box);
        }
        if (clearLabel && onClear) {
          if (noneLabel) {
            outcome = document.createElement("div");
            outcome.className = "jellyseerr-menu-note jellyseerr-menu-outcome";
            outcome.setAttribute("role", "status");
            outcome.hidden = true;
          }
          const foot = document.createElement("div");
          foot.className = "jellyseerr-menu-foot";
          if (outcome) foot.appendChild(outcome);
          clear = menuRow(clearLabel, "check", true).item;
          clear.classList.add("jellyseerr-menu-clear");
          clear.dataset.clear = "";
          foot.appendChild(clear);
          if (doneLabel) {
            const circle2 = JE.discoveryBusy?.circle?.("jellyseerr-menu-busy");
            if (circle2) foot.appendChild(circle2);
            const done = menuRow(doneLabel, "check", true).item;
            done.classList.add("jellyseerr-menu-done");
            done.dataset.done = "";
            foot.appendChild(done);
          }
          content.appendChild(foot);
        }
      }
      sheet.appendChild(content);
      container.appendChild(sheet);
      const items = (beside = false) => Array.from(content.querySelectorAll(".actionSheetMenuItem, .jellyseerr-menu-input, .jellyseerr-menu-match-btn, .jellyseerr-menu-profile-delete, .jellyseerr-menu-profile-save, .jellyseerr-menu-profile-undo, .jellyseerr-menu-outcome-undo")).filter((item) => !item.classList.contains("jellyseerr-menu-match-btn") || (item.parentElement?.contains(document.activeElement) ? item === document.activeElement : item.getAttribute("aria-checked") === "true")).filter((item) => beside || !item.classList.contains("jellyseerr-menu-profile-delete") || item === document.activeElement).filter((item) => !item.closest("[hidden]") && !item.hidden && item.getAttribute("aria-disabled") !== "true" && !(item instanceof HTMLButtonElement && item.disabled && !item.classList.contains("actionSheetMenuItem")) && !(item.dataset.done !== void 0 && getComputedStyle(item).display === "none"));
      const heads = () => Array.from(scroller.querySelectorAll(".jellyseerr-menu-group"));
      const headOf = (groupId) => heads().find((item) => item.dataset.toggle === groupId);
      const weighClear = () => {
        const idle = !scroller.querySelector(".jellyseerr-menu-group[data-set]");
        if (idle) clear?.setAttribute("aria-disabled", "true");
        else clear?.removeAttribute("aria-disabled");
      };
      weighClear();
      const built = /* @__PURE__ */ new WeakSet();
      const renew = () => {
        for (const group of groups ?? []) {
          if (typeof group.describe !== "function") continue;
          const { value, set, short } = group.describe();
          const head = headOf(group.id);
          const words = head?.querySelector(".jellyseerr-menu-group-value");
          if (words) showValue(words, set ? value : group.any ?? "", set ? short : void 0);
          head?.toggleAttribute("data-set", set);
          const body = head?.nextElementSibling;
          if (!(body instanceof HTMLElement) || !built.has(body)) continue;
          body.replaceChildren();
          built.delete(body);
          if (head?.getAttribute("aria-expanded") === "true") buildBody(group, body);
        }
        weighClear();
        place(true);
      };
      const buildBody = (group, list) => {
        if (!group.build || built.has(list)) return;
        built.add(list);
        group.build(list, {
          say(value, set, short) {
            const head = headOf(group.id);
            const words = head?.querySelector(".jellyseerr-menu-group-value");
            if (words) showValue(words, set ? value : (value || group.any) ?? "", set ? short : void 0);
            head?.toggleAttribute("data-set", set);
            weighClear();
          },
          // (What a body does to its own size, a search narrowing a list, never makes the menu shorter: what is under the pointer stays there.)
          placed: () => {
            place(true);
            const head = headOf(group.id);
            if (head?.getAttribute("aria-expanded") === "true") reveal(head);
          },
          // (A choice that is done with the menu, such as a saved profile applied.)
          close: () => close(),
          // (Another group's value changed by this one, a genre ticked here leaving its Without list: its row says it,
          // and its body is built anew when next opened.)
          other(groupId, value, set, short) {
            const head = headOf(groupId);
            const words = head?.querySelector(".jellyseerr-menu-group-value");
            const otherGroup = groups?.find((entry) => entry.id === groupId);
            if (words) showValue(words, set ? value : (value || otherGroup?.any) ?? "", set ? short : void 0);
            head?.toggleAttribute("data-set", set);
            const body = head?.nextElementSibling;
            if (body instanceof HTMLElement && built.has(body) && head?.getAttribute("aria-expanded") !== "true") {
              body.replaceChildren();
              built.delete(body);
            }
            weighClear();
          }
        });
      };
      const toggle = (item, opening) => {
        for (const head of heads()) {
          const open = head === item && opening;
          head.setAttribute("aria-expanded", String(open));
          if (!open) head.removeAttribute("data-over");
          const body = head.nextElementSibling;
          if (!(body instanceof HTMLElement)) continue;
          body.hidden = !open;
          head.parentElement?.toggleAttribute("data-open", open);
          if (open) body.style.setProperty("--jellyseerr-menu-head", `${head.offsetHeight}px`);
          const group = open ? groups?.find((entry) => entry.id === head.dataset.toggle) : void 0;
          if (group) buildBody(group, body);
        }
      };
      const reveal = (head) => {
        const body = head.nextElementSibling;
        if (!(body instanceof HTMLElement)) return;
        cutInARow();
        const view = scroller.getBoundingClientRect();
        const top = head.getBoundingClientRect().top - view.top;
        const over = body.getBoundingClientRect().bottom - view.bottom;
        if (over > 0) scroller.scrollTop += Math.min(top, over);
        cutInARow();
        edges();
      };
      let closed = false;
      let pointerAt = null;
      let keyed = false;
      let pointered = false;
      let keyWay = 0;
      let settling = 0;
      let following = 0;
      function close() {
        if (closed) return;
        closed = true;
        closeOpen = null;
        document.removeEventListener("keydown", onKey, true);
        document.removeEventListener("scroll", follow, true);
        cancelAnimationFrame(following);
        window.clearTimeout(settling);
        for (const type of ["popstate", "hashchange"]) window.removeEventListener(type, close);
        window.removeEventListener("resize", resized);
        stopOutcome?.();
        backdrop.remove();
        container.remove();
        onClose?.();
        if (anchor.isConnected) anchor.focus();
      }
      function focusInPlace(target) {
        target?.focus({ preventScroll: heldInSight(target) });
      }
      function heldInSight(target) {
        if (!(target instanceof HTMLElement) || !scroller.contains(target)) return false;
        const held = !!target.closest(".jellyseerr-menu-searchbar") || target.classList.contains("jellyseerr-menu-group") && target.getAttribute("aria-expanded") === "true";
        if (!held) return false;
        const view = scroller.getBoundingClientRect();
        const box = target.getBoundingClientRect();
        return box.top >= view.top - 1 && box.bottom <= view.bottom + 1;
      }
      if (tv && typeof scroller.scrollTo === "function") {
        const scrollTo = scroller.scrollTo.bind(scroller);
        Object.defineProperty(scroller, "scrollTo", {
          configurable: true,
          writable: true,
          value: (first, y) => {
            if (heldInSight(document.activeElement)) return;
            if (typeof first === "number") scrollTo(first, y ?? 0);
            else scrollTo(first);
          }
        });
      }
      function onKey(event) {
        const list = items(event.key === "Tab");
        const focused = document.activeElement;
        const index = focused instanceof HTMLElement ? list.indexOf(focused) : -1;
        const move = (to) => {
          event.preventDefault();
          event.stopPropagation();
          keyed = true;
          keyWay = to >= index ? 1 : -1;
          focusInPlace(list[(to + list.length) % list.length]);
          cutAgain();
        };
        if (focused instanceof HTMLInputElement && (event.key === "Home" || event.key === "End")) return;
        const active = focused instanceof HTMLElement ? focused : null;
        const body = active?.closest(".jellyseerr-menu-choices");
        const previous = body?.previousElementSibling;
        const head = previous instanceof HTMLElement ? previous : active?.classList.contains("jellyseerr-menu-group") && active.getAttribute("aria-expanded") === "true" ? active : null;
        const out = getComputedStyle(sheet).direction === "rtl" ? "ArrowRight" : "ArrowLeft";
        if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && active?.classList.contains("jellyseerr-menu-match-btn")) {
          const forward = event.key === "ArrowRight" !== (getComputedStyle(sheet).direction === "rtl");
          if (forward ? active.nextElementSibling : active.previousElementSibling) return;
        }
        const towardsEnd = out === "ArrowLeft" ? "ArrowRight" : "ArrowLeft";
        const pair = active?.closest(".jellyseerr-menu-profile-row");
        const beside = event.key === towardsEnd && active?.classList.contains("jellyseerr-menu-profile") ? pair?.querySelector(".jellyseerr-menu-profile-delete") : event.key === out && active?.classList.contains("jellyseerr-menu-profile-delete") ? pair?.querySelector(".jellyseerr-menu-profile") : null;
        if (beside instanceof HTMLElement) {
          event.preventDefault();
          event.stopPropagation();
          keyed = true;
          beside.focus();
          return;
        }
        if (event.key === out && body && head && !(active instanceof HTMLInputElement && (active.selectionStart ?? 0) > 0)) {
          event.preventDefault();
          event.stopPropagation();
          keyed = true;
          keyWay = -1;
          focusInPlace(head);
          cutAgain();
          return;
        }
        if (isBackKey(event)) {
          event.preventDefault();
          event.stopImmediatePropagation();
          if (tv && head) {
            toggle(head, false);
            place();
            head.focus();
          } else close();
        } else if (event.key === "ArrowDown") move(index + 1);
        else if (event.key === "ArrowUp") move(index < 0 ? list.length - 1 : index - 1);
        else if (event.key === "Home") move(0);
        else if (event.key === "End") move(list.length - 1);
        else if (event.key === "Tab") move(index + (event.shiftKey ? -1 : 1));
      }
      const mark = (groupId, id) => {
        const rows = Array.from(scroller.querySelectorAll(".actionSheetMenuItem[data-group]")).filter((item) => item.dataset.group === groupId);
        for (const item of rows) {
          const chosen2 = item.dataset.id === id;
          item.setAttribute("aria-checked", String(chosen2));
          const tick = item.querySelector(".actionsheetMenuItemIcon");
          if (tick) tick.style.visibility = chosen2 ? "" : "hidden";
        }
        const head = headOf(groupId);
        const chosen = rows.find((item) => item.dataset.id === id);
        const value = head?.querySelector(".jellyseerr-menu-group-value");
        if (value) showValue(value, chosen?.querySelector(".actionSheetItemText")?.textContent ?? "");
        head?.toggleAttribute("data-set", !!chosen && chosen !== rows[0]);
        weighClear();
      };
      content.addEventListener("click", (event) => {
        const item = event.target instanceof Element ? event.target.closest(".actionSheetMenuItem") : null;
        if (!item) return;
        if (item.dataset.toggle !== void 0) {
          const opening = item.getAttribute("aria-expanded") !== "true";
          toggle(item, opening);
          place();
          if (opening) reveal(item);
          return;
        }
        if (item.dataset.done !== void 0) {
          close();
          return;
        }
        if (item.dataset.clear !== void 0) {
          if (item.getAttribute("aria-disabled") === "true") return;
          onClear?.();
          for (const group of groups ?? []) {
            if (group.choices) {
              mark(group.id, group.choices[0]?.id ?? "");
              continue;
            }
            const head = headOf(group.id);
            const list = head?.nextElementSibling;
            const words = head?.querySelector(".jellyseerr-menu-group-value");
            if (words) showValue(words, group.any ?? "");
            head?.removeAttribute("data-set");
            head?.setAttribute("aria-expanded", "false");
            if (list instanceof HTMLElement) {
              list.hidden = true;
              list.replaceChildren();
              built.delete(list);
            }
          }
          weighClear();
          place(true);
          heads()[0]?.focus();
          return;
        }
        const id = item.dataset.id;
        if (id === void 0) return;
        const groupId = item.dataset.group;
        if (groupId === void 0) {
          close();
          onPick(id);
          return;
        }
        if (item.getAttribute("aria-checked") === "true") return;
        mark(groupId, id);
        onPick(id, groupId);
      });
      const heldFade = () => Math.ceil((parseFloat(getComputedStyle(scroller).fontSize) || 16) * (parseFloat(getComputedStyle(scroller).getPropertyValue?.("--jellyseerr-held-fade") ?? "") || 0));
      scroller.addEventListener("scroll", () => {
        for (const head of heads()) {
          const body = head.nextElementSibling;
          const held = Math.abs(head.getBoundingClientRect().top - scroller.getBoundingClientRect().top) < 2;
          const over = head.getAttribute("aria-expanded") === "true" && body instanceof HTMLElement && held && body.getBoundingClientRect().top < head.getBoundingClientRect().bottom - 1;
          head.toggleAttribute("data-over", over);
          if (!(body instanceof HTMLElement)) continue;
          const strip = over ? (body.querySelector(".jellyseerr-menu-searchbar") ?? head).getBoundingClientRect().bottom : -Infinity;
          const end = strip + heldFade() + 4;
          for (const part of body.querySelectorAll(tv ? ".jellyseerr-menu-list-rule, .jellyseerr-menu-label" : ".jellyseerr-menu-list-rule")) {
            const box = part.getBoundingClientRect();
            const words = part.classList.contains("jellyseerr-menu-label") ? box.top + (parseFloat(getComputedStyle(part).paddingTop) || 0) : box.top;
            part.style.visibility = words <= end ? "hidden" : "";
          }
        }
      }, { passive: true });
      const shownRows = () => Array.from(scroller.querySelectorAll(".actionSheetMenuItem")).filter((row) => !row.closest("[hidden]") && !row.hidden).map((row) => ({ row, box: row.getBoundingClientRect() })).filter((entry) => entry.box.height > 0);
      const below = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      const unrowed = () => {
        const body = heads().find((head) => head.getAttribute("aria-expanded") === "true")?.nextElementSibling;
        if (!(body instanceof HTMLElement)) return [];
        return Array.from(body.querySelectorAll("input, button:not(.actionSheetMenuItem), .jellyseerr-menu-note, .jellyseerr-menu-match")).filter((el) => !el.closest("[hidden]") && !el.closest(".actionSheetMenuItem")).map((el) => el.getBoundingClientRect()).filter((box) => box.height > 0);
      };
      const firstLine = (name) => {
        if (!name || typeof document.createRange !== "function") return void 0;
        const range = document.createRange();
        range.selectNodeContents(name);
        return Array.from(range.getClientRects?.() ?? []).find((rect) => rect.height > 0);
      };
      const topCutOf = ({ row, box }) => {
        const line = firstLine(row.querySelector(".actionSheetItemText"));
        return line ? line.top + line.height * (1 - CUT_AT) : box.top + box.height * (1 - CUT_AT);
      };
      const cutOf = ({ row, box }) => {
        const name = row.querySelector(".actionSheetItemText");
        let line;
        if (name && typeof document.createRange === "function") {
          const range = document.createRange();
          range.selectNodeContents(name);
          line = Array.from(range.getClientRects?.() ?? []).pop();
        }
        return Math.max(line && line.height > 0 ? line.top + line.height * CUT_AT : 0, box.top + box.height * CUT_AT);
      };
      const cutInARow = () => {
        scroller.style.maxHeight = "";
        const sample = shownRows()[0];
        const open = heads().find((head) => head.getAttribute("aria-expanded") === "true");
        const bar = open?.nextElementSibling?.querySelector(".jellyseerr-menu-searchbar");
        if (sample) scroller.style.setProperty("--jellyseerr-cut", `${Math.round(cutOf(sample) - sample.box.top)}px`);
        scroller.style.setProperty("--jellyseerr-held", `${open ? open.offsetHeight + (bar?.offsetHeight ?? 0) + heldFade() : 0}px`);
        const footRow = clear?.parentElement;
        const words = clear?.querySelector(".actionSheetItemText");
        if (footRow && words && typeof document.createRange === "function") {
          const range = document.createRange();
          range.selectNodeContents(words);
          const said2 = range.getBoundingClientRect?.();
          const room = footRow.getBoundingClientRect();
          const rtl2 = getComputedStyle(footRow).direction === "rtl";
          if (said2 && said2.width > 0) footRow.style.setProperty("--jellyseerr-clear-end", `${Math.ceil(rtl2 ? room.right - said2.left : said2.right - room.left)}px`);
        }
        const top = scroller.getBoundingClientRect().top;
        if (scroller.scrollTop > 2 && below() > 2 && !(open && Math.abs(open.getBoundingClientRect().top - top) < 2)) {
          const entries = shownRows();
          const overEntry = entries.filter((entry) => entry.box.top < top - 1).pop();
          const up = overEntry ? Math.round(top - overEntry.box.top - (topCutOf(overEntry) - overEntry.box.top)) : 0;
          const body = open?.nextElementSibling;
          const bottom = scroller.getBoundingClientRect().bottom;
          const fits = body instanceof HTMLElement && !!open && body.getBoundingClientRect().bottom - open.getBoundingClientRect().top <= bottom - top;
          const nextEntry = entries.find((entry) => entry.box.top >= top - 1);
          if (up > 0 && fits && nextEntry && body instanceof HTMLElement && body.getBoundingClientRect().bottom + up > bottom + 1) {
            scroller.scrollTop += Math.round(topCutOf(nextEntry) - top);
          } else if (overEntry) scroller.scrollTop -= up;
        }
        const view = scroller.getBoundingClientRect();
        const rows = shownRows().filter((entry) => entry.box.top > view.top + 1);
        const next = rows.find((entry) => entry.box.bottom > view.bottom - 1);
        const last = rows.filter((entry) => entry.box.bottom <= view.bottom - 1).pop();
        if (next && below() > 1 && below() < next.box.height && open) {
          const rest = below();
          if (open.getBoundingClientRect().top - rest >= view.top - 1) scroller.scrollTop += rest;
          return;
        }
        if (!next || below() < next.box.height) return;
        const own = open ? shownRows().filter((entry) => open.nextElementSibling?.contains(entry.row)) : [];
        const [upper, lower] = own.slice(-2);
        const inView = own.filter((entry) => entry.box.bottom > view.top && entry.box.top < view.bottom);
        const steps = inView.slice(1).map((entry, index) => entry.box.top - (inView[index]?.box.top ?? entry.box.top));
        const firstStep = steps[0] ?? 0;
        const firstHeight = inView[0]?.box.height ?? 0;
        const even = steps.length > 0 && steps.every((step) => Math.abs(step - firstStep) <= 1) && inView.every((entry) => Math.abs(entry.box.height - firstHeight) <= 1);
        const runsOn = (open?.nextElementSibling?.getBoundingClientRect().bottom ?? 0) > view.bottom + 1;
        if (tv && open && upper && lower && even && runsOn && open.getBoundingClientRect().top - view.top < 2) {
          const pitch = lower.box.top - upper.box.top;
          const depth = cutOf(lower) - lower.box.top;
          const heldDeep = open.offsetHeight + (bar?.offsetHeight ?? 0);
          const whole = pitch > 0 ? Math.floor((view.height - heldDeep - depth) / pitch) : 0;
          if (whole >= 1) {
            scroller.style.maxHeight = `${Math.round(heldDeep + whole * pitch + depth)}px`;
            return;
          }
        }
        const cut = view.bottom >= cutOf(next) ? cutOf(next) : last ? cutOf(last) : 0;
        if (cut < view.bottom - 1 && unrowed().some((box) => box.bottom > cut + 1 && box.top < view.bottom)) {
          const by = Math.round(cutOf(next) - view.bottom);
          const headTop = open?.getBoundingClientRect().top ?? view.top;
          if (by > 0 && by < next.box.height && headTop - by >= view.top - 1 && below() >= by) scroller.scrollTop += by;
          return;
        }
        if (coarse && !tv && Math.abs(cut - view.bottom) > 1) {
          const down = view.bottom >= cutOf(next) ? Math.round(view.bottom - cutOf(next)) : 0;
          const up = down === 0 ? Math.round(cutOf(next) - view.bottom) : 0;
          const headTop = open?.getBoundingClientRect().top ?? view.top;
          const topTrue = () => {
            const edge = scroller.getBoundingClientRect().top;
            return !shownRows().some((entry) => entry.box.top < edge - 1 && entry.box.bottom > edge + 1 && topCutOf(entry) < edge - 1 && (entry.row.querySelector(".actionSheetItemText")?.getBoundingClientRect().bottom ?? entry.box.bottom) <= edge + 1);
          };
          const was = scroller.scrollTop;
          if (down > 0 && scroller.scrollTop >= down) scroller.scrollTop -= down;
          else if (up > 0 && up < next.box.height && below() >= up && headTop - up >= view.top - 1) scroller.scrollTop += up;
          if (scroller.scrollTop !== was) {
            if (topTrue()) return;
            scroller.scrollTop = was;
          }
        }
        if (cut > view.top + 40 && Math.abs(cut - view.bottom) > 1) scroller.style.maxHeight = `${Math.round(cut - view.top)}px`;
      };
      const cutAgain = () => {
        const active = document.activeElement;
        if (!(active instanceof HTMLElement) || !scroller.contains(active)) return;
        const view = scroller.getBoundingClientRect();
        const rows = shownRows().filter((entry) => entry.box.top > view.top + 1);
        const at = rows.findIndex((entry) => entry.box.bottom > view.bottom - 1);
        const next = rows[at];
        if (!next || below() < next.box.height) {
          edges();
          return;
        }
        const on = active.getBoundingClientRect();
        const before = at > 0 ? rows[at - 1] : void 0;
        const moves = [cutOf(next) - view.bottom, ...before ? [cutOf(before) - view.bottom] : []].sort((a, b) => Math.abs(a) - Math.abs(b));
        if (Math.abs(moves[0] ?? 0) <= 1) {
          edges();
          return;
        }
        const room = (by) => by < 0 ? scroller.scrollTop >= -by - 1 : below() >= by - 1;
        const can = moves.filter((by) => room(by) && on.top - by >= view.top - 1 && on.bottom - by <= view.bottom + 1);
        const move = can.find((by) => Math.sign(by) === keyWay) ?? can[0];
        const glide = tv && typeof scroller.scrollBy === "function" && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
        if (move !== void 0 && Math.abs(move) > 1) {
          if (glide) scroller.scrollBy({ top: Math.round(move), behavior: "smooth" });
          else scroller.scrollTop += Math.round(move);
        }
        edges();
      };
      const edges = () => {
        const bottom = scroller.getBoundingClientRect().bottom;
        const rowsShown = Array.from(scroller.querySelectorAll(".actionSheetMenuItem")).filter((row) => !row.closest("[hidden]") && row.getBoundingClientRect().height > 0);
        const lastRow = rowsShown[rowsShown.length - 1];
        const hidden = (lastRow?.getBoundingClientRect().bottom ?? 0) > bottom + 4 || unrowed().some((box) => box.bottom > bottom + 4);
        content.toggleAttribute("data-more", scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 2 && hidden);
        const held = heads().find((head) => head.getAttribute("aria-expanded") === "true");
        const top = scroller.getBoundingClientRect().top;
        const heldAtTop = !!held && Math.abs(held.getBoundingClientRect().top - top) < 2;
        const firstRow = rowsShown[0];
        const line = firstLine(firstRow?.querySelector(".actionSheetItemText") ?? null);
        const nameTop = line ? line.top + line.height * 0.3 : firstRow?.getBoundingClientRect().top ?? top;
        const hiddenAbove = nameTop < top - 1;
        content.toggleAttribute("data-above", scroller.scrollTop > 2 && hiddenAbove && !heldAtTop);
        content.toggleAttribute("data-rows-above", scroller.scrollTop > 2 && hiddenAbove);
      };
      scroller.addEventListener("scroll", edges, { passive: true });
      backdrop.addEventListener("click", () => close());
      container.addEventListener("click", (event) => {
        if (event.target === container) close();
      });
      document.body.append(backdrop, container);
      if (tv) {
        const most = parseFloat(getComputedStyle(sheet).maxHeight);
        if (most > 0 && most < window.innerHeight) {
          container.style.alignItems = "flex-start";
          sheet.style.marginTop = `${Math.round((window.innerHeight - most) / 2)}px`;
        }
        sheet.style.setProperty("--jellyseerr-menu-ground", getComputedStyle(sheet).backgroundColor);
      }
      const firstName = scroller.querySelector(".actionSheetItemText");
      const wordsBox = firstName?.getBoundingClientRect();
      const scrollerBox = scroller.getBoundingClientRect();
      const rtl = getComputedStyle(sheet).direction === "rtl";
      if (wordsBox && scrollerBox.width > 0) {
        sheet.style.setProperty("--jellyseerr-menu-indent", `${Math.round(rtl ? scrollerBox.right - wordsBox.right : wordsBox.left - scrollerBox.left)}px`);
      }
      if (firstName && scrollerBox.width > 0 && typeof document.createRange === "function") {
        const range = document.createRange();
        range.selectNodeContents(firstName);
        const letters = range.getBoundingClientRect?.();
        if (letters && letters.width > 0) {
          sheet.style.setProperty("--jellyseerr-menu-text", `${Math.round(rtl ? scrollerBox.right - letters.right : letters.left - scrollerBox.left)}px`);
        }
      }
      for (const group of groups ?? []) {
        const head = group.open ? headOf(group.id) : void 0;
        if (head) toggle(head, true);
      }
      function overList() {
        const section = anchor.closest(".jellyseerr-discovery-section");
        const area = section?.getBoundingClientRect();
        const box = sheet.getBoundingClientRect();
        const x = area && area.width > 0 ? area.left + area.width / 2 : window.innerWidth / 2;
        const y = window.innerHeight / 2;
        const half = 1.3 * (parseFloat(section ? getComputedStyle(section).fontSize : "") || 16);
        sheet.toggleAttribute("data-over-list", box.left < x + half && x - half < box.right && box.top < y + half && y - half < box.bottom);
      }
      function place(keep = false) {
        fitValues();
        if (tv) {
          cutInARow();
          edges();
          overList();
          return;
        }
        const was = sheet.getBoundingClientRect();
        const above = was.height > 0 && was.top < anchor.getBoundingClientRect().top;
        const foot = clear?.parentElement?.getBoundingClientRect().height ?? 0;
        const least = !keep ? 0 : above ? was.height : pointerAt === null ? 0 : Math.min(was.height, pointerAt - was.top + foot + 14);
        const scrolled = scroller.scrollTop;
        scroller.style.maxHeight = "";
        sheet.style.cssText = "position: fixed; margin: 0; left: 0; top: 0;";
        const at = anchor.getBoundingClientRect();
        const size = sheet.getBoundingClientRect();
        const edge = at.right - (parseFloat(getComputedStyle(anchor).paddingRight) || 0);
        const left = Math.min(Math.max(EDGE, edge - size.width), Math.max(EDGE, window.innerWidth - size.width - EDGE));
        const under = at.bottom + 4;
        const roomUnder = window.innerHeight - under - EDGE;
        const roomAbove = at.top - 4 - EDGE;
        const wanted = Math.max(size.height, least);
        let top = under;
        let room = roomUnder;
        if (wanted > roomUnder && (groups ? roomUnder < Math.min(wanted, GROUPED_MIN_ROOM) && roomAbove > roomUnder : true)) {
          room = Math.max(roomAbove, 0);
          top = Math.max(EDGE, at.top - 4 - Math.min(wanted, room));
        }
        const height = least ? `min-height: ${Math.round(Math.min(least, room))}px;` : "";
        sheet.style.cssText = `position: fixed; margin: 0; box-sizing: border-box; left: ${Math.round(left)}px; top: ${Math.round(top)}px; max-height: ${Math.round(Math.max(room, 120))}px; ${height}`;
        scroller.scrollTop = scrolled;
        const active = document.activeElement;
        if (active instanceof HTMLElement && scroller.contains(active)) {
          const view = scroller.getBoundingClientRect();
          const box = active.getBoundingClientRect();
          if (box.top < view.top || box.bottom > view.bottom) active.scrollIntoView?.({ block: "nearest" });
        }
        cutInARow();
        edges();
        overList();
      }
      place();
      if (outcome && noneLabel) {
        stopOutcome = watchOutcome({
          band: outcome,
          anchor,
          noneLabel,
          undoLabel,
          onUndo,
          canUndo,
          renew,
          closed: () => closed,
          focusHome: () => focusInPlace(heads().find((head) => head.getAttribute("aria-expanded") === "true") ?? items()[0]),
          placed: () => place(true)
        });
      }
      sheet.addEventListener("pointermove", (event) => {
        pointerAt = event.clientY;
      });
      sheet.addEventListener("pointerdown", (event) => {
        pointerAt = event.clientY;
        keyed = false;
        pointered = true;
      });
      sheet.addEventListener("wheel", () => {
        keyed = false;
        pointered = true;
      }, { passive: true });
      sheet.addEventListener("keydown", () => {
        pointered = false;
      }, true);
      scroller.addEventListener("scroll", () => {
        window.clearTimeout(settling);
        settling = window.setTimeout(() => {
          if (!closed && (keyed || !pointered)) cutAgain();
        }, 140);
      }, { passive: true });
      sheet.addEventListener("pointerleave", (event) => {
        if (event.pointerType === "mouse") pointerAt = null;
      });
      function follow(event) {
        if (event.target instanceof Node && sheet.contains(event.target)) return;
        following || (following = requestAnimationFrame(() => {
          following = 0;
          if (!closed) place(true);
        }));
      }
      document.addEventListener("scroll", follow, { passive: true, capture: true });
      const openWidth = window.innerWidth;
      function resized() {
        if (window.innerWidth !== openWidth) {
          close();
          return;
        }
        following || (following = requestAnimationFrame(() => {
          following = 0;
          if (!closed) place(true);
        }));
      }
      window.addEventListener("resize", resized);
      for (const type of ["popstate", "hashchange"]) window.addEventListener(type, close);
      document.addEventListener("keydown", onKey, true);
      (items().find((item) => item.getAttribute("aria-checked") === "true") ?? items()[0])?.focus();
      closeOpen = close;
      return close;
    }
    return { openMenu, menuRow, groupedMenuRoom };
  }

  // client/src/features/seerr/discovery/discovery-roles.css
  var discovery_roles_default = "/* On a person's titles: what the person did in each (the part played, the job held), one line under the title. */\n.jellyseerr-discovery-section .jellyseerr-role > bdi { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n/* The part and the jobs are a line each. Where a title of the list has both, every card keeps two lines, so the rows stay level. */\n/* Asked for by a job and not for acting (the Role filter), the jobs come before the part. */\n.jellyseerr-discovery-section[data-jobs-first] .jellyseerr-role-both { display: flex; flex-direction: column-reverse; }\n.jellyseerr-discovery-section .itemsContainer:has(.jellyseerr-role-both) .jellyseerr-role { min-height: 2.7em; min-height: 2lh; }\n";

  // client/src/features/seerr/discovery/roles.ts
  var ROLE_ASKED = "data-role-asked";
  var said = (items, shown) => `${items.slice(0, shown).join(", ")}${shown < items.length ? ` +${items.length - shown}` : ""}`;
  var isStringArray = (value) => Array.isArray(value) && value.every((entry) => typeof entry === "string");
  var isJobList = (value) => Array.isArray(value) && value.every((entry) => Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string");
  function createDiscoveryRoles(label) {
    function decorateCard(card, item) {
      const credit = item?.jeCredit;
      if (!card || !credit) return;
      const characters = Array.isArray(credit.characters) ? credit.characters : [];
      const crew = Array.isArray(credit.crew) ? credit.crew : [];
      const jobs = crew.map(([job, department]) => [job === "Creator" ? label("discovery_role_creator", "Creator") : job, department]);
      const parts = [characters.length ? label("discovery_role_as", "as {role}", { role: characters.join(", ") }) : "", jobs.map(([job]) => job).join(", ")];
      const spoken = parts.filter(Boolean);
      const line = document.createElement("div");
      line.className = "cardText cardTextCentered cardText-secondary jellyseerr-role";
      if (spoken.length > 1) line.classList.add("jellyseerr-role-both");
      if (spoken.length > 0) line.title = spoken.join("\n");
      for (const [index, words] of (spoken.length > 0 ? parts : [" "]).entries()) {
        if (!words) continue;
        const text = document.createElement("bdi");
        text.textContent = words;
        if (index === 1) text.dataset.jobs = JSON.stringify(jobs);
        else {
          const each = characters.flatMap((character) => character.split(" / ")).map((character) => character.trim()).filter(Boolean);
          text.dataset.parts = JSON.stringify(each.filter((character, at) => each.indexOf(character) === at));
          text.dataset.as = label("discovery_role_as", "as {role}", { role: "{role}" });
        }
        line.appendChild(text);
      }
      const title = card.querySelector(".cardText-first");
      if (title) title.after(line);
      else card.appendChild(line);
    }
    function fitRoleLines(section) {
      if (!section) return;
      const asked = new Set((section.getAttribute(ROLE_ASKED) ?? "").split("|").filter(Boolean));
      const lines = Array.from(section.querySelectorAll(".jellyseerr-role > [data-jobs], .jellyseerr-role > [data-parts]")).map((line) => {
        let items = [];
        let wrap = (words) => words;
        try {
          if (line.dataset.jobs !== void 0) {
            const jobs = JSON.parse(line.dataset.jobs);
            const list = isJobList(jobs) ? jobs : [];
            items = [...list.filter((job) => asked.has(job[1])), ...list.filter((job) => !asked.has(job[1]))].map((job) => job[0]);
          } else {
            const parts = JSON.parse(line.dataset.parts ?? "[]");
            items = isStringArray(parts) ? parts : [];
            const as = line.dataset.as ?? "{role}";
            wrap = (words) => as.replace("{role}", words);
          }
        } catch {
          items = [];
        }
        return { line, items, wrap };
      }).filter((entry) => entry.items.length > 0);
      for (const { line, items, wrap } of lines) {
        const whole = wrap(said(items, items.length));
        if (line.textContent !== whole) line.textContent = whole;
      }
      const tight = lines.filter(({ line }) => line.clientWidth > 0 && line.scrollWidth > line.clientWidth + 1);
      for (const { line, items, wrap } of tight) {
        const fits = (words2) => {
          line.textContent = wrap(words2);
          return line.scrollWidth <= line.clientWidth + 1;
        };
        let done = false;
        for (let shown = items.length - 1; shown >= 1 && !done; shown--) done = fits(said(items, shown));
        if (done) continue;
        const more = items.length > 1 ? ` +${items.length - 1}` : "";
        const words = (items[0] ?? "").replace(/\s*[(（].*$/, "").split(/\s+/).filter(Boolean);
        for (let count = words.length; count >= 1 && !done; count--) done = fits(`${words.slice(0, count).join(" ")}…${more}`);
      }
    }
    injectStyleOnce("jellyseerr-discovery-roles-styles", discovery_roles_default);
    return { decorateCard, fitRoleLines, ROLE_ASKED };
  }

  // client/src/features/seerr/discovery/say.ts
  function createSay(JE) {
    return (key, fallback, values) => {
      const text = typeof JE.t === "function" ? JE.t(key, values) : "";
      let said2 = text && text !== key ? text : fallback;
      for (const [name, value] of Object.entries(values ?? {})) said2 = said2.replace(`{${name}}`, () => String(value));
      return said2;
    };
  }

  // client/src/features/seerr/discovery/section.ts
  var PLACEHOLDER_CARDS = 10;
  var RAIL_FLAG = "data-jellyseerr-rail";
  var STUCK_FLAG = "data-stuck";
  var TYPE_WORD_OFF = "data-type-word-off";
  var ROW_AIR = 5;
  var ROW_AIR_TV = 22;
  var LANDING_AIR = 12;
  function buildSection({ key, page, header }) {
    const section = document.createElement("div");
    section.className = `verticalSection jellyseerr-${key}-discovery-section jellyseerr-discovery-section`;
    if (page === "detail") section.classList.add("detailVerticalSection");
    section.setAttribute(`data-jellyseerr-${key}-discovery`, "true");
    section.appendChild(header);
    const itemsContainer = document.createElement("div");
    itemsContainer.setAttribute("is", "emby-itemscontainer");
    itemsContainer.className = "itemsContainer vertical-wrap";
    section.appendChild(itemsContainer);
    return section;
  }
  function buildPlaceholderCards(count, cardClass) {
    const fragment = document.createDocumentFragment();
    const shape = cardClass === "portraitCard" ? "portrait" : "overflowPortrait";
    for (let index = 0; index < count; index++) {
      const card = document.createElement("div");
      card.className = `card ${cardClass} jellyseerr-card-placeholder`;
      card.setAttribute("aria-hidden", "true");
      card.innerHTML = `<div class="cardBox cardBox-bottompadded"><div class="cardScalable"><div class="cardPadder cardPadder-${shape}"></div></div><div class="cardText cardTextCentered cardText-first">&nbsp;</div><div class="cardText cardTextCentered cardText-secondary">&nbsp;</div></div>`;
      fragment.appendChild(card);
    }
    return fragment;
  }
  function clearPlaceholders(container) {
    container.querySelectorAll(".jellyseerr-card-placeholder").forEach((card) => card.remove());
  }
  function buildMessageRow({ message, actionLabel, onAction }) {
    const row = document.createElement("div");
    row.className = "jellyseerr-section-message";
    row.setAttribute("role", "status");
    const text = document.createElement("span");
    text.textContent = message;
    row.appendChild(text);
    if (actionLabel && onAction) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "raised emby-button jellyseerr-section-message-action";
      button.textContent = actionLabel;
      button.addEventListener("click", onAction);
      row.appendChild(button);
    }
    return row;
  }
  function buildRetrySection(key, message, actionLabel, onAction) {
    const section = document.createElement("div");
    section.className = `verticalSection jellyseerr-${key}-discovery-section jellyseerr-discovery-section je-retry-row`;
    section.appendChild(buildMessageRow({ message, actionLabel, onAction }));
    return section;
  }
  function barBottom() {
    for (const selector of [".skinHeader", ".MuiAppBar-root"]) {
      const bar = document.querySelector(selector);
      const box = bar?.getBoundingClientRect();
      if (bar && box && box.height > 0 && getComputedStyle(bar).visibility !== "hidden") return Math.max(0, Math.round(box.bottom));
    }
    return 0;
  }
  function heldWidth(text, row) {
    const probe = document.createElement("span");
    probe.className = "jellyseerr-discovery-probe";
    probe.textContent = text;
    row.appendChild(probe);
    const width = probe.getBoundingClientRect().width;
    probe.remove();
    return width;
  }
  function buildJump(header) {
    const jump = document.createElement("button");
    jump.type = "button";
    jump.className = "jellyseerr-join-jump";
    jump.hidden = true;
    const lead = document.createElement("span");
    lead.className = "jellyseerr-join-jump-lead";
    const go = document.createElement("span");
    go.className = "jellyseerr-join-jump-go";
    go.textContent = header.getAttribute("data-jump-label") || header.querySelector(".sectionTitle")?.textContent || "";
    lead.appendChild(go);
    jump.appendChild(lead);
    const note = header.getAttribute("data-jump-note") ?? "";
    const mark = /^[\s]*[,;:.،؛、，]+/.exec(note)?.[0] ?? "";
    if (mark) lead.append(mark.trim());
    if (note.length > mark.length) jump.append(note.slice(mark.length));
    return jump;
  }
  function createDiscoverySection(JE) {
    const joins = /* @__PURE__ */ new Map();
    function placeSection(anchor, section, page) {
      if (page === "detail") {
        section.style.order = "99";
        const view = anchor.closest(".itemDetailPage") ?? anchor;
        (view.querySelector(".detailPagePrimaryContent .detailSection") ?? anchor).appendChild(section);
        attachJoin(section, false);
        return true;
      }
      const own = anchor.closest(".verticalSection");
      const wrapper = own ? own.parentElement : anchor.parentElement;
      if (!wrapper) return false;
      wrapper.appendChild(section);
      attachJoin(section, true);
      return true;
    }
    function attachJoin(section, onListPage) {
      joins.get(section)?.();
      for (const [other, stopOther] of joins) if (!other.isConnected) stopOther();
      const parent = section.parentElement;
      const header = section.querySelector(".jellyseerr-discovery-header");
      if (!parent || !header) return;
      const page = onListPage ? parent.closest(".page, .libraryPage") : null;
      const meta = header.querySelector(".jellyseerr-discovery-meta");
      const bar = header.querySelector(".jellyseerr-discovery-bar");
      const heading = header.querySelector(".sectionTitle");
      const phone = window.matchMedia?.("(max-width: 34em)");
      const tv = document.documentElement.classList.contains("layout-tv");
      const siblings = Array.from(parent.children).filter((child) => child !== section);
      const jump = buildJump(header);
      const toolbar = siblings.find((child) => child.classList.contains("itemsViewSettingsContainer"));
      if (toolbar) toolbar.after(jump);
      else if (onListPage) parent.insertBefore(jump, siblings.find((child) => child.classList.contains("itemsContainer")) ?? section);
      else {
        const firstList = siblings.find((child) => !child.classList.contains("hide") && child.querySelector(".itemsContainer"));
        jump.classList.add("jellyseerr-join-jump-start");
        if (firstList) parent.insertBefore(jump, firstList);
      }
      let late = onListPage ? siblings.some((child) => child.classList.contains("itemsContainer") && child.childElementCount > 0) : true;
      jump.addEventListener("click", () => {
        const calm = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
        const card = tv ? section.querySelector(".itemsContainer > .card:not(.jellyseerr-card-placeholder)") : null;
        const control = tv ? card?.querySelector(".cardContent, a, button, [tabindex]") ?? header.querySelector("button") : null;
        if (!control && heading) {
          heading.setAttribute("tabindex", "-1");
          heading.addEventListener("blur", () => heading.removeAttribute("tabindex"), { once: true });
        }
        (control ?? heading)?.focus({ preventScroll: true });
        if (tv) return;
        window.scrollTo({ top: section.getBoundingClientRect().top + window.scrollY - barBottom() - LANDING_AIR, behavior: calm ? "auto" : "smooth" });
      });
      const title = heading?.textContent ?? "";
      const fallback = heading?.querySelector(".jellyseerr-discovery-name")?.textContent ?? "";
      let fitted = "";
      const fitTitle = () => {
        if (!meta || !fallback || !title) return;
        const heldTitle = header.querySelector(".jellyseerr-filter-held-title");
        const inFilterRow = !!heldTitle && !!phone?.matches;
        const typeWord = inFilterRow ? header.querySelector(".jellyseerr-filters-type")?.textContent ?? "" : "";
        const roomNow = () => inFilterRow && heldTitle ? heldTitle.clientWidth : meta.clientWidth - (bar ? bar.offsetWidth + (parseFloat(getComputedStyle(meta).columnGap) || 0) : 0);
        const key = `${inFilterRow}|${meta.clientWidth}|${typeWord}|${inFilterRow ? 0 : Math.round(roomNow())}`;
        if (key === fitted) return;
        header.removeAttribute(TYPE_WORD_OFF);
        const wanted = heldWidth(title, meta);
        let room = roomNow();
        if (room <= 0) return;
        fitted = key;
        let words = title;
        if (wanted > room && typeWord) {
          header.setAttribute(TYPE_WORD_OFF, "");
          room = roomNow();
          if (wanted > room) {
            header.removeAttribute(TYPE_WORD_OFF);
            words = fallback;
            if (heldWidth(fallback, meta) > roomNow()) header.setAttribute(TYPE_WORD_OFF, "");
          }
        } else if (wanted > room) words = fallback;
        if (inFilterRow && heldTitle) heldTitle.textContent = words;
        else meta.setAttribute("data-title", words);
      };
      const grid = section.querySelector(".itemsContainer");
      const rtl = !!grid && getComputedStyle(section).direction === "rtl";
      let trimmed = 0;
      const trim = () => {
        if (!grid) return;
        const shown = Array.from(grid.children).find((card2) => card2.classList.contains("card") && card2.getClientRects().length > 0);
        if (!shown) return;
        const card = shown.getBoundingClientRect();
        const room = grid.getBoundingClientRect();
        if (card.width < 1 || room.width < card.width) return;
        const poster = (shown.querySelector(".cardBox") ?? shown).getBoundingClientRect();
        const box = header.getBoundingClientRect();
        const columns = Math.max(1, Math.floor((room.width + 1) / card.width));
        const short = rtl ? room.right - columns * card.width + (poster.left - card.left) - box.left : box.right - (room.left + columns * card.width - (card.right - poster.right));
        const next = Math.min(Math.max(0, Math.round(short)), Math.round(card.width));
        if (next === trimmed) return;
        trimmed = next;
        if (next) header.style.setProperty("--jellyseerr-trim", `${next}px`);
        else header.style.removeProperty("--jellyseerr-trim");
      };
      let under = -1;
      let fittedTo = 0;
      let tucked = 0;
      let frame = 0;
      const update = () => {
        frame = 0;
        if (!section.isConnected) return;
        const barEnd = barBottom();
        if (barEnd !== under) {
          under = barEnd;
          section.style.setProperty("--jellyseerr-sticky-top", `${barEnd}px`);
        }
        trim();
        const wide = grid?.clientWidth ?? 0;
        if (wide !== fittedTo) {
          fittedTo = wide;
          JE.discoveryRoles?.fitRoleLines?.(section);
        }
        const top = section.getBoundingClientRect().top;
        const row = bar && phone?.matches && header.hasAttribute("data-has-filter") ? bar : meta;
        const tuck = row ? Math.max(0, row.offsetTop - (tv ? ROW_AIR_TV : ROW_AIR)) : 0;
        if (tuck !== tucked) {
          tucked = tuck;
          if (tuck > 0) header.style.setProperty("--jellyseerr-header-tuck", `${tuck}px`);
          else header.style.removeProperty("--jellyseerr-header-tuck");
        }
        const stuck = header.getBoundingClientRect().top - top > 1;
        header.toggleAttribute(STUCK_FLAG, stuck);
        if (stuck) fitTitle();
        const rail = page?.querySelector(".alphaPicker-fixed");
        if (rail && top < rail.getBoundingClientRect().bottom) section.setAttribute(RAIL_FLAG, "away");
        else section.removeAttribute(RAIL_FLAG);
        if (!jump.isConnected) return;
        const start = top + window.scrollY - (jump.hidden ? 0 : jump.offsetHeight);
        const place = jump.hidden ? jump.nextElementSibling : jump;
        const lead = onListPage || !place ? 0 : place.getBoundingClientRect().top + window.scrollY;
        const long = start - lead > window.innerHeight;
        if (jump.hidden === long) {
          jump.classList.toggle("jellyseerr-join-jump-late", long && late);
          jump.hidden = !long;
        }
        late = false;
      };
      const schedule = () => {
        frame || (frame = requestAnimationFrame(update));
      };
      document.addEventListener("scroll", schedule, { passive: true, capture: true });
      window.addEventListener("resize", schedule);
      let sizes = null;
      let watcher = null;
      const stop = () => {
        joins.delete(section);
        cancelAnimationFrame(frame);
        document.removeEventListener("scroll", schedule, true);
        window.removeEventListener("resize", schedule);
        sizes?.disconnect();
        watcher?.disconnect();
        jump.remove();
        section.removeAttribute(RAIL_FLAG);
        header.removeAttribute(STUCK_FLAG);
        header.removeAttribute(TYPE_WORD_OFF);
        header.style.removeProperty("--jellyseerr-header-tuck");
        header.style.removeProperty("--jellyseerr-trim");
      };
      if (typeof ResizeObserver === "function") {
        sizes = new ResizeObserver(() => {
          cancelAnimationFrame(frame);
          update();
        });
        for (const sibling of siblings) sizes.observe(sibling);
        sizes.observe(header);
        if (bar) sizes.observe(bar);
        if (grid) sizes.observe(grid);
      }
      if (typeof MutationObserver === "function") {
        watcher = new MutationObserver(() => {
          if (section.parentElement !== parent) stop();
        });
        watcher.observe(parent, { childList: true });
      }
      joins.set(section, stop);
      schedule();
    }
    return {
      buildSection,
      placeSection,
      attachJoin,
      PLACEHOLDER_CARDS,
      buildPlaceholderCards,
      clearPlaceholders,
      buildMessageRow,
      buildRetrySection
    };
  }

  // client/src/features/seerr/discovery/controls.ts
  function createControls(JE) {
    const filterModes = /* @__PURE__ */ new Map();
    const sortModes = /* @__PURE__ */ new Map();
    const typePickers = /* @__PURE__ */ new WeakMap();
    const sortPainters = /* @__PURE__ */ new WeakMap();
    const label = createSay(JE);
    const getFilterMode = (name) => filterModes.get(name) ?? FILTER_MODES.MIXED;
    function setFilterMode(name, mode) {
      if (isFilterMode(mode)) filterModes.set(name, mode);
    }
    const getSortMode = (name) => sortModes.get(name) || "";
    const getTvSortMode = (name) => tvSortValue(getSortMode(name));
    function createFilterControl(moduleName, onFilterChange, heldTitle) {
      const filterLabel = label("discovery_filter_label", "Filter");
      const container = document.createElement("div");
      container.className = "jellyseerr-discovery-filter";
      container.setAttribute("role", "group");
      container.setAttribute("aria-label", filterLabel);
      const buttons = [
        { mode: FILTER_MODES.MIXED, label: label("jellyseerr_discover_all", "All") },
        { mode: FILTER_MODES.MOVIES, label: label("jellyseerr_quota_label_movie", "Movies") },
        { mode: FILTER_MODES.TV, label: label("jellyseerr_quota_label_tv", "Series") }
      ];
      const paint = () => {
        const mode = getFilterMode(moduleName);
        for (const tab of container.querySelectorAll(".jellyseerr-filter-btn")) {
          const active = tab.getAttribute("data-mode") === mode;
          tab.classList.toggle("emby-tab-button-active", active);
          tab.setAttribute("aria-pressed", String(active));
        }
      };
      const choose = (mode) => {
        if (mode === getFilterMode(moduleName) || !isFilterMode(mode)) return;
        setFilterMode(moduleName, mode);
        paint();
        JE.discoveryFilters?.repaint?.(container.closest(".jellyseerr-discovery-header") ?? container);
        onFilterChange?.(mode);
      };
      for (const entry of buttons) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "jellyseerr-filter-btn emby-tab-button emby-button";
        button.setAttribute("data-mode", entry.mode);
        button.textContent = entry.label;
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          choose(entry.mode);
        });
        container.appendChild(button);
      }
      if (heldTitle) {
        const held = document.createElement("span");
        held.className = "jellyseerr-filter-held";
        const title = document.createElement("span");
        title.className = "jellyseerr-filter-held-title";
        title.setAttribute("aria-hidden", "true");
        title.textContent = heldTitle;
        held.appendChild(title);
        container.appendChild(held);
      }
      container.dataset.typeGroup = "";
      typePickers.set(container, {
        groupOf: () => ({
          id: "type",
          name: label("discovery_filter_type", "Type"),
          choices: buttons.map((entry) => ({ id: entry.mode, name: entry.label, selected: entry.mode === getFilterMode(moduleName) }))
        }),
        choose,
        // Redraws the tabs after the type was set from elsewhere (a saved profile).
        paint,
        // (Known from what puts them out of sight, a held header at a phone's width, as the stylesheet has
        // it: their own style is no guide while they are still fading.)
        tabsShowing: () => !(container.closest(".jellyseerr-discovery-header")?.hasAttribute("data-stuck") && window.matchMedia?.("(max-width: 34em)").matches)
      });
      paint();
      return container;
    }
    function typePickerOf(tabs) {
      return tabs ? typePickers.get(tabs) : void 0;
    }
    function createSortControl(moduleName, onSortChange) {
      const sortLabel = label("discovery_sort_label", "Sort");
      const nameOf2 = (value) => {
        const entry = SORT_OPTIONS.find((option) => option.value === value) ?? SORT_OPTIONS[0];
        return entry ? label(entry.labelKey, entry.label) : "";
      };
      const button = document.createElement("button");
      button.type = "button";
      button.className = "jellyseerr-sort-btn emby-tab-button emby-button";
      button.setAttribute("aria-haspopup", "menu");
      button.setAttribute("aria-expanded", "false");
      const text = document.createElement("span");
      const chevron = document.createElement("span");
      chevron.className = "material-icons expand_more";
      chevron.setAttribute("aria-hidden", "true");
      button.append(text, chevron);
      const paint = () => {
        const current = nameOf2(getSortMode(moduleName));
        text.textContent = current;
        button.setAttribute("aria-label", `${sortLabel}: ${current}`);
      };
      paint();
      sortPainters.set(button, paint);
      button.addEventListener("click", () => {
        const current = getSortMode(moduleName);
        button.setAttribute("aria-expanded", "true");
        JE.discoveryMenu?.openMenu({
          anchor: button,
          title: sortLabel,
          onClose: () => button.setAttribute("aria-expanded", "false"),
          choices: SORT_OPTIONS.map((option) => ({ id: option.value, name: label(option.labelKey, option.label), selected: option.value === current })),
          onPick(value) {
            if (value === getSortMode(moduleName)) return;
            sortModes.set(moduleName, value);
            paint();
            JE.discoveryBusy?.hold?.(button);
            onSortChange?.(value);
          }
        });
      });
      return button;
    }
    function addFilterControl(header, moduleName, onFilterChange) {
      const bar = header.querySelector(".jellyseerr-discovery-bar");
      if (!bar || bar.querySelector(".jellyseerr-discovery-filter")) return;
      bar.prepend(createFilterControl(moduleName, onFilterChange, header.querySelector(".sectionTitle")?.textContent || void 0));
      bar.setAttribute("data-has-filter", "");
      header.setAttribute("data-has-filter", "");
    }
    function createSectionHeader(title, moduleName, showFilter, onFilterChange, onSortChange, subject, scope = "feed") {
      const header = document.createElement("div");
      header.className = "jellyseerr-discovery-header";
      const notInLibrary = JE.pluginConfig?.JellyseerrExcludeLibraryItems === true;
      const [lead = "", rest = ""] = (notInLibrary ? label("discovery_go_to_not_in_library", "Go to {title}, not in the library") : label("discovery_go_to", "Go to {title}")).split("{title}");
      header.setAttribute("data-jump-label", `${lead}${title}`);
      if (rest) header.setAttribute("data-jump-note", rest);
      const name = document.createElement("h2");
      name.className = "sectionTitle sectionTitle-cards";
      const at = subject ? title.indexOf(subject) : -1;
      if (subject && at >= 0) {
        const whole = document.createElement("span");
        whole.className = "jellyseerr-discovery-name";
        whole.textContent = subject;
        name.append(title.slice(0, at), whole, title.slice(at + subject.length));
      } else name.textContent = title;
      const meta = document.createElement("div");
      meta.className = "jellyseerr-discovery-meta";
      meta.setAttribute("data-title", title);
      const bar = document.createElement("div");
      bar.className = "jellyseerr-discovery-bar";
      if (notInLibrary) {
        const summary = document.createElement("p");
        summary.className = "jellyseerr-discovery-summary";
        summary.textContent = label("discovery_not_in_library", "Not in the library");
        meta.appendChild(summary);
      }
      if (onSortChange) {
        const filters = JE.discoveryFilters?.createFiltersControl?.(
          header,
          moduleName,
          scope,
          () => onSortChange(getSortMode(moduleName)),
          moduleName === "genre" ? subject : void 0,
          void 0,
          moduleName === "tag" ? ["keywords"] : [],
          sectionProfiles(header, moduleName, scope, onFilterChange, onSortChange)
        );
        if (filters) bar.appendChild(filters);
        bar.appendChild(createSortControl(moduleName, onSortChange));
      }
      meta.appendChild(bar);
      header.append(name, meta);
      if (showFilter) addFilterControl(header, moduleName, onFilterChange);
      return header;
    }
    function sectionProfiles(header, moduleName, scope, onFilterChange, onSortChange) {
      if (!JE.discoveryAddress) return null;
      return {
        read: () => JE.discoveryAddress?.filterPairs(JE.discoveryAddress.current(moduleName, moduleName), true).join("&") ?? "",
        apply(text) {
          const address = JE.discoveryAddress;
          if (!address) return;
          const wanted = address.filtersOf(text, scope);
          const tabs = header.querySelector("[data-type-group]");
          if (tabs) setFilterMode(moduleName, wanted.mode);
          if (wanted.sort) sortModes.set(moduleName, wanted.sort);
          else sortModes.delete(moduleName);
          JE.discoveryFilters?.setSelection?.(moduleName, wanted.selection);
          if (tabs) typePickers.get(tabs)?.paint();
          const sortButton = header.querySelector(".jellyseerr-sort-btn");
          if (sortButton) sortPainters.get(sortButton)?.();
          JE.discoveryFilters?.repaint?.(header);
          onSortChange(getSortMode(moduleName));
          if (tabs) onFilterChange?.(getFilterMode(moduleName));
        }
      };
    }
    function createFiltersButton(header, moduleName, scope, onChange, options = {}) {
      return JE.discoveryFilters?.createFiltersControl?.(
        header,
        moduleName,
        scope,
        onChange,
        options.ownGenre,
        options.place,
        options.fixedAll ?? [],
        options.profiles ?? null
      ) ?? null;
    }
    return {
      getFilterMode,
      setFilterMode,
      getSortMode,
      getTvSortMode,
      createFiltersButton,
      /** The further filters set for a module (beyond All / Movies / Series); {} when nothing is set. */
      getFilters: (moduleName) => JE.discoveryFilters?.selectionOf?.(moduleName) ?? {},
      /** Sets a module's further filters as a whole; the caller redraws its controls and reloads. */
      setFilters: (moduleName, selection) => {
        JE.discoveryFilters?.setSelection?.(moduleName, selection);
      },
      /** Takes a module's further filters away; the caller redraws its controls and reloads. */
      clearFilters: (moduleName) => {
        JE.discoveryFilters?.setSelection?.(moduleName, {});
      },
      /** A section starts with nothing narrowing it: neither the type nor the further filters. */
      resetFilterMode: (name) => {
        filterModes.delete(name);
        JE.discoveryFilters?.reset?.(name);
      },
      setSortMode: (name, sort) => {
        sortModes.set(name, sort);
      },
      resetSortMode: (name) => {
        sortModes.delete(name);
      },
      createFilterControl,
      addFilterControl,
      typePickerOf,
      createSortControl,
      createSectionHeader,
      /** What a feed's request carries after its page: the order, then the further filters. */
      feedQuery(moduleName, kind) {
        const sort = kind === "tv" ? getTvSortMode(moduleName) : getSortMode(moduleName);
        return `${sort ? `&sortBy=${encodeURIComponent(sort)}` : ""}${JE.discoveryFilters?.feedQuery?.(moduleName, kind) ?? ""}`;
      },
      /** A person's titles as the further filters keep them (all of them when none is set). */
      keepByFilters: (moduleName, results) => JE.discoveryFilters?.keep?.(moduleName, results) ?? results,
      /** Whether any further filter is narrowing a section. */
      hasMoreFilters: (moduleName) => !!JE.discoveryFilters?.active?.(moduleName),
      /**
       * The rebuilt list takes its own height, and says so when the further filters leave it empty,
       * with the way out. `hasMore`: Seerr has more to look through, so not yet.
       */
      noteIfEmpty(moduleName, container, hasMore) {
        JE.discoveryBusy?.release?.(container);
        JE.discoveryFilters?.noteIfEmpty?.(moduleName, container, hasMore);
      }
    };
  }
  function applyFilterVisibility(container, mode) {
    if (!container) return;
    container.classList.remove("filter-movies", "filter-tv");
    if (mode === FILTER_MODES.MOVIES) container.classList.add("filter-movies");
    else if (mode === FILTER_MODES.TV) container.classList.add("filter-tv");
  }
  function injectFilterStyles() {
    if (document.getElementById("jellyseerr-filter-styles")) return;
    const style = document.createElement("style");
    style.id = "jellyseerr-filter-styles";
    style.textContent = `
            .filter-movies [data-media-type="tv"] { display: none !important; }
            .filter-tv [data-media-type="movie"] { display: none !important; }
        `;
    document.head.appendChild(style);
  }

  // client/src/features/seerr/discovery/managed-fetch.ts
  var userChanged = () => abortError("User changed during request");
  function currentCheck(JE) {
    const session = JE.session;
    if (!session) return () => true;
    const epoch = session.getEpoch();
    return () => session.isCurrent(epoch);
  }
  function createManagedFetch(JE, client) {
    return async function fetchWithManagedRequest(path, cachePrefix, options = {}) {
      const api = client();
      if (!api) throw new Error("Jellyfin ApiClient is unavailable");
      const url = api.getUrl(path);
      const { signal } = options;
      const manager = JE.requestManager;
      const stillCurrent = currentCheck(JE);
      if (!manager) {
        if (!api.ajax) throw new Error("Jellyfin ApiClient cannot issue requests");
        const data = await api.ajax({
          type: "GET",
          url,
          headers: { "X-Jellyfin-User-Id": api.getCurrentUserId() },
          dataType: "json"
        });
        if (!stillCurrent()) throw userChanged();
        throwIfAborted(signal);
        return data;
      }
      const cacheKey = `${cachePrefix}:${path}`;
      const cached = manager.getCached(cacheKey);
      if (cached) return cached;
      const fetchPage = async () => {
        const requestedAt = manager.cacheStamp?.();
        const token = api.accessToken();
        const response = await manager.fetchWithRetry(url, {
          method: "GET",
          headers: {
            "X-Jellyfin-User-Id": api.getCurrentUserId(),
            Authorization: `MediaBrowser Token="${token}"`,
            "X-Emby-Token": token,
            Accept: "application/json"
          },
          ...signal ? { signal } : {}
        });
        const data = await response.json();
        if (!stillCurrent()) throw userChanged();
        manager.setCache(cacheKey, data, requestedAt);
        return data;
      };
      return manager.deduplicatedFetch(cacheKey, () => manager.withConcurrencyLimit(() => {
        if (!stillCurrent()) return Promise.reject(userChanged());
        const hit = manager.getCached(cacheKey);
        return hit ? Promise.resolve(hit) : fetchPage();
      }), signal);
    };
  }
  var GENRE_LIST_PREFIX = "je-tmdb-genres:";
  var GENRE_LIST_TTL_MS = 30 * 60 * 1e3;
  function readStoredGenreList(deps, key) {
    try {
      const raw = deps.storage().getItem(key);
      if (!raw) return null;
      const entry = JSON.parse(raw);
      if (!isRecord2(entry) || typeof entry.storedAt !== "number") return null;
      const age = deps.now() - entry.storedAt;
      if (!(age >= 0 && age < GENRE_LIST_TTL_MS)) return null;
      const { genres } = entry;
      if (!Array.isArray(genres) || genres.length === 0 || !genres.every(isGenreEntry)) return null;
      return genres;
    } catch {
      return null;
    }
  }
  function createGenreListFetch(JE, deps) {
    return async function fetchTmdbGenreList(mediaType, options = {}) {
      const serverId = JE.session?.getServerId?.();
      const userId = JE.session?.getUserId?.();
      const key = serverId && userId ? `${GENRE_LIST_PREFIX}${serverId}:${userId}:${mediaType}` : null;
      const stored = key ? readStoredGenreList(deps, key) : null;
      if (stored) return stored;
      const stillCurrent = currentCheck(JE);
      const data = await deps.fetchWithManagedRequest(`/JellyfinEnhanced/tmdb/genres/${mediaType}`, "genre", options);
      const genres = decodeGenreList(data);
      if (key && genres.length > 0 && stillCurrent()) {
        try {
          deps.storage().setItem(key, JSON.stringify({ storedAt: deps.now(), genres }));
        } catch {
        }
      }
      return genres;
    };
  }

  // client/src/features/seerr/discovery/page-ready.ts
  var LIST_GRACE_MS = 1500;
  var DETAIL_GRACE_MS = 3e3;
  var OVERALL_WAIT_MS = 3e4;
  var POLL_MS = 100;
  var VISIBLE_DETAIL = ".itemDetailPage:not(.hide)";
  function detailAnchor(page) {
    return page.querySelector(".detailPageContent") ?? page.querySelector(".detailPageSecondaryContainer") ?? page;
  }
  function createPageReady(JE) {
    let sequence = 0;
    function findDetail(options, allowStale) {
      const view = options.getView?.();
      if (view?.matches(VISIBLE_DETAIL)) return detailAnchor(view);
      let staleFallback = null;
      for (const page of document.querySelectorAll(VISIBLE_DETAIL)) {
        if (!options.isStalePage?.(page)) return detailAnchor(page);
        if (allowStale) staleFallback ?? (staleFallback = page);
      }
      return staleFallback && detailAnchor(staleFallback);
    }
    function findList(options, allowStale) {
      const viewContainer = options.getView?.()?.querySelector(".itemsContainer");
      if (viewContainer) return viewContainer;
      const candidates = document.querySelectorAll(".page:not(.hide) .itemsContainer, .libraryPage:not(.hide) .itemsContainer");
      let staleFallback = null;
      for (const candidate of candidates) {
        if (!options.isStalePage?.(candidate.closest(".page, .libraryPage"))) return candidate;
        if (allowStale && candidate.children.length > 0) staleFallback ?? (staleFallback = candidate);
      }
      return staleFallback;
    }
    return function waitForPageReady(signal, options = {}) {
      const type = options.type ?? "list";
      const find = (allowStale) => type === "detail" ? findDetail(options, allowStale) : findList(options, allowStale);
      return new Promise((resolve) => {
        if (signal?.aborted) {
          resolve(null);
          return;
        }
        const immediate = find(false);
        if (immediate) {
          resolve(immediate);
          return;
        }
        let allowStale = false;
        let timeoutId;
        let pollId;
        let subscription;
        let finished = false;
        const finish = (result) => {
          if (finished) return;
          finished = true;
          subscription?.unsubscribe();
          clearInterval(pollId);
          clearTimeout(timeoutId);
          signal?.removeEventListener("abort", abort);
          resolve(result);
        };
        const abort = () => finish(null);
        const recheck = () => {
          const found = find(allowStale);
          if (found) finish(found);
        };
        signal?.addEventListener("abort", abort, { once: true });
        subscription = JE.helpers?.onBodyMutation?.(`jellyseerr-discovery-container-detect-${++sequence}`, recheck);
        pollId = setInterval(recheck, POLL_MS);
        timeoutId = setTimeout(() => {
          allowStale = true;
          recheck();
          if (!finished) timeoutId = setTimeout(() => finish(find(true)), OVERALL_WAIT_MS);
        }, type === "list" ? LIST_GRACE_MS : DETAIL_GRACE_MS);
      });
    };
  }

  // client/src/features/seerr/discovery/session-cache.ts
  var STORAGE_PREFIX = "je-discovery-resolution-v2:";
  var LEGACY_PREFIX = "je-discovery-resolution:";
  var STORAGE_TTL_MS = 30 * 60 * 1e3;
  var MAX_ENTRIES = 200;
  var MEMORY_ONLY_SERVER = "";
  function createSessionCacheFactory(deps) {
    let legacyPurged = false;
    function purgeLegacy() {
      if (legacyPurged) return;
      legacyPurged = true;
      try {
        const storage = deps.storage();
        for (let index = storage.length - 1; index >= 0; index--) {
          const key = storage.key(index);
          if (key?.startsWith(LEGACY_PREFIX)) storage.removeItem(key);
        }
      } catch {
      }
    }
    return function createSessionCache(name, isValid) {
      let memoryKey = null;
      let memoryEntries = null;
      function storageKey() {
        const userId = deps.userId();
        if (!userId) return null;
        return `${STORAGE_PREFIX}${deps.serverId() || MEMORY_ONLY_SERVER}:${userId}:${name}`;
      }
      const persisted = (key) => !key.startsWith(`${STORAGE_PREFIX}${MEMORY_ONLY_SERVER}:`);
      function load(key) {
        const entries = /* @__PURE__ */ new Map();
        if (!persisted(key)) return entries;
        purgeLegacy();
        try {
          const parsed = JSON.parse(deps.storage().getItem(key) || "null");
          const stored = isRecord2(parsed) ? parsed.entries : null;
          if (!isRecord2(stored)) return entries;
          const now = deps.now();
          for (const [entryKey, entry] of Object.entries(stored)) {
            if (!isRecord2(entry)) continue;
            const { storedAt, value } = entry;
            if (typeof storedAt !== "number") continue;
            const age = now - storedAt;
            if (!(age >= 0 && age < STORAGE_TTL_MS) || !isValid(value)) continue;
            entries.set(entryKey, { value, storedAt });
          }
        } catch {
        }
        return entries;
      }
      function entriesFor(key) {
        if (key === memoryKey && memoryEntries) return memoryEntries;
        const entries = load(key);
        if (key === storageKey()) {
          memoryKey = key;
          memoryEntries = entries;
        }
        return entries;
      }
      function fresh(entries, entryKey) {
        const entry = entries.get(entryKey);
        if (!entry) return void 0;
        if (deps.now() - entry.storedAt < STORAGE_TTL_MS) return entry;
        entries.delete(entryKey);
        return void 0;
      }
      function scope() {
        const key = storageKey();
        return {
          has: (entryKey) => !!key && !!fresh(entriesFor(key), String(entryKey)),
          get: (entryKey) => key ? fresh(entriesFor(key), String(entryKey))?.value : void 0,
          set(entryKey, value) {
            if (!key) return;
            const entries = entriesFor(key);
            entries.delete(String(entryKey));
            entries.set(String(entryKey), { value, storedAt: deps.now() });
            for (const oldest of entries.keys()) {
              if (entries.size <= MAX_ENTRIES) break;
              entries.delete(oldest);
            }
            if (!persisted(key) || !isValid(value)) return;
            try {
              const stored = [...entries].filter(([, entry]) => isValid(entry.value));
              deps.storage().setItem(key, JSON.stringify({ entries: Object.fromEntries(stored) }));
            } catch {
            }
          }
        };
      }
      return { scope };
    };
  }

  // client/src/features/seerr/discovery/discovery-filter-utils.ts
  function createDiscoveryFilter(JE, client) {
    const storage = () => window.sessionStorage;
    const now = () => Date.now();
    const fetchWithManagedRequest = createManagedFetch(JE, client);
    return {
      MODES: FILTER_MODES,
      SORT_OPTIONS,
      ...createControls(JE),
      interleaveArrays,
      filterByMediaType,
      hasBothTypes,
      resultHasBothTypes,
      fetchWithManagedRequest,
      fetchTmdbGenreList: createGenreListFetch(JE, { storage, now, fetchWithManagedRequest }),
      createSessionCache: createSessionCacheFactory({
        storage,
        now,
        userId: () => JE.session?.getUserId?.(),
        serverId: () => JE.session?.getServerId?.()
      }),
      ...createCardRendering(JE),
      waitForPageReady: createPageReady(JE),
      setupInfiniteScroll(state, selector, loadMore, hasMore, isLoading, options) {
        JE.seamlessScroll?.setupInfiniteScroll(state, selector, loadMore, hasMore, isLoading, options);
      },
      cleanupScrollObserver(state) {
        JE.seamlessScroll?.cleanupInfiniteScroll(state);
      },
      applyFilterVisibility
    };
  }
  (function() {
    "use strict";
    const { JE, api } = discoveryHost();
    const label = createSay(JE);
    injectDiscoveryStyles();
    JE.discoveryStyles = { inject: injectDiscoveryStyles };
    JE.discoveryBusy = createDiscoveryBusy();
    JE.discoveryMenu = createDiscoveryMenu(JE);
    JE.discoveryRoles = createDiscoveryRoles(label);
    JE.discoverySection = createDiscoverySection(JE);
    JE.discoveryFilters = createFilterPanel(JE, label, api);
    injectFilterStyles();
    JE.discoveryFilter = createDiscoveryFilter(JE, api);
    JE.discoveryAddress = createDiscoveryAddress(JE);
  })();
})();
})();
//# sourceMappingURL=discovery-filter-utils.js.map
