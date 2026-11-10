(() => {
"use strict";
(() => {
  // client/src/features/media-tags/admin/dom.ts
  function isDisabled(el) {
    return el instanceof HTMLButtonElement || el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement ? el.disabled : false;
  }
  function find(scope, selector) {
    const el = scope?.querySelector(selector);
    return el instanceof HTMLElement ? el : null;
  }
  function must(scope, selector) {
    const el = find(scope, selector);
    if (!el) throw new Error(`Media Tags admin markup is incomplete: ${selector}`);
    return el;
  }
  function all(scope, selector) {
    return scope ? Array.from(scope.querySelectorAll(selector)).filter((el) => el instanceof HTMLElement) : [];
  }
  function closest(event, selector) {
    const target = event.target;
    const el = target instanceof Element ? target.closest(selector) : null;
    return el instanceof HTMLElement ? el : null;
  }
  function focus(el, options) {
    if (el instanceof HTMLElement) el.focus(options);
  }

  // client/src/features/media-tags/admin/host.ts
  var host = () => window;
  function adminBridge() {
    const JE = host().JellyfinEnhanced;
    if (!JE) throw new TypeError("Jellyfin Enhanced must load before the Media Tags admin tab");
    return JE;
  }
  function adminTagsApi(JE) {
    const facade = JE.adminTags;
    return facade && isCore(facade) ? facade : null;
  }
  function isCore(facade) {
    return typeof facade.registerSection === "function" && typeof facade.fmt === "function" && Array.isArray(facade.sections);
  }

  // client/src/features/media-tags/admin/sections/install.ts
  function installSection(register) {
    const JE = adminBridge();
    const A = adminTagsApi(JE);
    if (A) register(A, JE);
  }

  // client/src/features/media-tags/admin/sections/rating.ts
  /*! Lexical index of this module's declarations, in the order Shared/MediaTags/MediaTagsPageFields.cs (the field
   *  patch's allowlist), Features/Admin/Services/WhatsNewService.cs and scripts/generate_config_flag_groups.py read them
   *  from the generated file. Not code: tests/frontend/features/media-tags/admin/admin-tags-rewrite.test.mjs keeps it equal
   *  to the sections this module registers and to what those readers found in the JavaScript module.
  registerSection({
      tab: 'groups',
      title: 'Rating',
      group: { id: 'rating' },
          { id: 'ratingTagsEnabled', key: 'RatingTagsEnabled', type: 'enable', label: 'Rating tags for new users' },
          { id: 'ratingTagsOnMovies', key: 'RatingTagsOnMovies', type: 'custom', label: 'Show on movies' },
          { id: 'ratingTagsOnSeries', key: 'RatingTagsOnSeries', type: 'custom', label: 'Show on series' },
          { id: 'ratingTagsOnSeasons', key: 'RatingTagsOnSeasons', type: 'custom', label: 'Show on seasons' },
          { id: 'ratingTagsOnEpisodes', key: 'RatingTagsOnEpisodes', type: 'custom', label: 'Show on episodes' },
          { id: 'ratingTagsOnContinueWatching', key: 'RatingTagsOnContinueWatching', type: 'custom', label: 'Show in the Continue Watching row' },
          { id: 'ratingTagsOnNextUp', key: 'RatingTagsOnNextUp', type: 'custom', label: 'Show in the Next Up row' },
          { id: 'ratingTagsSources', key: 'RatingTagsSources', type: 'custom', label: 'Rating sources' },
          { id: 'ratingTagsMinScore', key: 'RatingTagsMinScore', type: 'select', label: 'Minimum score' },
          { id: 'ratingTagsColorByScore', key: 'RatingTagsColorByScore', type: 'switch', label: 'Colour by score' },
          { id: 'showRatingInPlayer', key: 'ShowRatingInPlayer', type: 'switch', label: 'Show the rating in the video player' },
  */
  var SOURCES = ["community", "critic", "imdb", "tmdb", "rtCritic", "rtAudience", "metacritic", "letterboxd", "trakt"];
  var sourceOf = (value) => SOURCES.find((id) => id === value);
  function selectedSources(c) {
    const stored = c.RatingTagsSources;
    if (Array.isArray(stored)) {
      const out = [];
      for (const raw of stored) {
        const id = sourceOf(raw);
        if (id && !out.includes(id)) out.push(id);
      }
      return out;
    }
    return SOURCES.filter((id) => (id === "community" || id === "critic") && c[id === "community" ? "RatingTagsShowCommunity" : "RatingTagsShowCritic"] !== false);
  }
  function collect(list) {
    return all(list, "[data-source]").filter((row) => {
      const box = row.querySelector("input");
      return !!box && box.checked;
    }).map((row) => row.dataset.source || "");
  }
  installSection((A, JE) => {
    const nameOf = (id) => JE.ratingSources ? JE.ratingSources.name(id) : id;
    function rowsHtml(ctx, order, selected) {
      return order.map((id, i) => {
        const name = nameOf(id);
        return `<li data-source="${id}"><span class="je-ta-rank" aria-hidden="true">${i + 1}</span><label><input type="checkbox" ${selected.includes(id) ? "checked" : ""}><span class="je-ta-order-name">${ctx.esc(name)}</span></label><button type="button" class="je-ta-icon-btn" data-step="-1" aria-label="${ctx.esc(A.fmt("Move {source} up", { source: name }))}" ${i === 0 ? "disabled" : ""}><span class="material-icons" aria-hidden="true">arrow_upward</span></button><button type="button" class="je-ta-icon-btn" data-step="1" aria-label="${ctx.esc(A.fmt("Move {source} down", { source: name }))}" ${i === order.length - 1 ? "disabled" : ""}><span class="material-icons" aria-hidden="true">arrow_downward</span></button></li>`;
      }).join("");
    }
    function load(ctx, body) {
      const list = find(body, "#ratingTagsSourceRows");
      if (!list) return;
      const selected = selectedSources(ctx.config);
      list.innerHTML = rowsHtml(ctx, [...new Set(selected.concat(SOURCES))], selected);
    }
    A.registerSection({
      id: "group-rating",
      tab: "groups",
      order: 40,
      title: "Rating",
      hint: "Scores on posters: where they show, which sources and in what order. Users can override these.",
      group: {
        id: "rating",
        summary(ctx) {
          const c = ctx.config;
          const sources = selectedSources(c).map(nameOf);
          const types = ["Movies", "Series", "Seasons", "Episodes"].filter((t) => c[`RatingTagsOn${t}`] !== false).length;
          return [sources.length ? sources.join(", ") : A.fmt("None"), types === 4 ? A.fmt("every item type") : A.fmt("{n} of 4 item types", { n: types })].join(" · ");
        },
        sample: () => [["rating", "★ 8.1"], ["rating", "92%"]]
      },
      fields: [
        { id: "ratingTagsEnabled", key: "RatingTagsEnabled", type: "enable", label: "Rating tags for new users" },
        { id: "ratingTagsOnMovies", key: "RatingTagsOnMovies", type: "custom", label: "Show on movies" },
        { id: "ratingTagsOnSeries", key: "RatingTagsOnSeries", type: "custom", label: "Show on series" },
        { id: "ratingTagsOnSeasons", key: "RatingTagsOnSeasons", type: "custom", label: "Show on seasons" },
        { id: "ratingTagsOnEpisodes", key: "RatingTagsOnEpisodes", type: "custom", label: "Show on episodes", desc: "Off keeps ratings off every episode card, Next Up and Continue Watching included." },
        { id: "ratingTagsOnContinueWatching", key: "RatingTagsOnContinueWatching", type: "custom", label: "Show in the Continue Watching row" },
        { id: "ratingTagsOnNextUp", key: "RatingTagsOnNextUp", type: "custom", label: "Show in the Next Up row" },
        { id: "ratingTagsSources", key: "RatingTagsSources", type: "custom", label: "Rating sources" },
        { id: "ratingTagsMinScore", key: "RatingTagsMinScore", type: "select", label: "Minimum score", desc: "Hide scores below this, on a scale of ten.", options: [["0", "Off"], ["5", "=5"], ["6", "=6"], ["7", "=7"], ["8", "=8"]], read: (v) => String(Number(v) || 0), write: (v) => Number(v) },
        { id: "ratingTagsColorByScore", key: "RatingTagsColorByScore", type: "switch", label: "Colour by score", break: true },
        { id: "showRatingInPlayer", key: "ShowRatingInPlayer", type: "switch", label: "Show the rating in the video player", desc: 'TMDB and Rotten Tomatoes ratings before the "Ends at" time.' }
      ],
      render(ctx, body) {
        body.innerHTML = `<h4 class="je-ta-sub" id="ratingTagsSourcesLabel">${ctx.tx("Rating sources")}</h4>
                <p class="je-ta-hint">${ctx.tx("Source scores use MDBList when an API key is configured. Minimum score compares every source on a scale of ten.")}</p>
                <ol class="je-ta-order" id="ratingTagsSourceRows" aria-labelledby="ratingTagsSourcesLabel"></ol>
                <h4 class="je-ta-sub">${ctx.tx("MDBList")}</h4>
                <div class="je-ta-card" style="margin:0" data-mdblist></div>`;
        const list = must(body, "#ratingTagsSourceRows");
        list.addEventListener("change", () => ctx.set("RatingTagsSources", collect(list)));
        list.addEventListener("click", (e) => {
          const button = closest(e, "[data-step]");
          if (!button || isDisabled(button)) return;
          const row = button.closest("[data-source]");
          if (!(row instanceof HTMLElement)) return;
          const next = Number(button.dataset.step) < 0 ? row.previousElementSibling : row.nextElementSibling;
          if (!next) return;
          if (Number(button.dataset.step) < 0) next.before(row);
          else next.after(row);
          const id = row.dataset.source;
          ctx.set("RatingTagsSources", collect(list));
          const again = find(list, `[data-source="${id}"] [data-step="${button.dataset.step}"]`);
          focus(again && !isDisabled(again) ? again : list.querySelector(`[data-source="${id}"] input`));
        });
        load(ctx, body);
      },
      load,
      refresh(ctx, body) {
        const list = find(body, "#ratingTagsSourceRows");
        if (list) {
          Array.from(list.children).forEach((row, i) => {
            const rank = row.querySelector(".je-ta-rank");
            if (rank) rank.textContent = String(i + 1);
            row.querySelector('[data-step="-1"]')?.toggleAttribute("disabled", i === 0);
            row.querySelector('[data-step="1"]')?.toggleAttribute("disabled", i === list.children.length - 1);
          });
        }
        const box = find(body, "[data-mdblist]");
        if (!box) return;
        const c = ctx.config;
        const key = String(c.MdblistApiKey || "").trim() !== "";
        const on = c.MdblistRatingsEnabled === true;
        if (!box.querySelector("[data-mdblist-state]")) {
          box.innerHTML = `<div class="je-ta-card-head"><span class="je-ta-state" data-mdblist-state></span></div><p class="je-ta-hint" data-mdblist-hint></p><a class="je-ta-link" href="${ctx.esc(ctx.mainPageUrl("mdblistRatingsEnabled"))}"><span class="je-ta-link-text">${ctx.tx("MDBList settings")}</span><span class="material-icons" aria-hidden="true">open_in_new</span></a>`;
        }
        const state = must(box, "[data-mdblist-state]");
        state.dataset.state = on && key ? "on" : on ? "warn" : "off";
        state.textContent = A.fmt(on ? key ? "On" : "On, no API key" : "Off");
        must(box, "[data-mdblist-hint]").textContent = A.fmt("Source scores (IMDb, Metacritic, Letterboxd…) come from MDBList when it is set up. Its key, quota and fetch task live with MDBList Ratings.") + (on && key ? ` ${A.fmt(c.MdblistRatingsFetchEnabled === true ? "The fetch task is on." : "The fetch task is off, so only live lookups fill the scores.")}` : "");
      }
    });
    A.ratingData = { SOURCES, selectedSources };
  });
})();
})();
//# sourceMappingURL=rating.js.map
