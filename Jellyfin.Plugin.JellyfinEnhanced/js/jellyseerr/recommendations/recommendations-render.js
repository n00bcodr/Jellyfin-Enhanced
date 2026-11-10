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
  function filterOf(JE) {
    if (!JE.discoveryFilter) throw new Error("Discovery filter utilities are not loaded");
    return JE.discoveryFilter;
  }
  function translate(JE, key, params) {
    return JE.t?.(key, params) ?? key;
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
  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function isAbortError(error) {
    return isRecord(error) && error.name === "AbortError";
  }

  // client/src/features/seerr/recommendations/stage.ts
  var LOG_PREFIX = "🪼 Jellyfin Enhanced: Recommendations:";
  var PAGE_ID = "je-recommendations-page";
  var CATEGORY_PAGE_ID = "je-recommendations-category-page";
  var OTHER_PAGE = `.mainAnimatedPage:not(.hide):not(#${PAGE_ID}):not(#${CATEGORY_PAGE_ID})`;
  function recommendationsHost() {
    const { JE } = discoveryHost();
    const own = discoveryContext(JE).own;
    return { JE, P: own.recommendationsPage ?? (own.recommendationsPage = {}) };
  }
  function part(P, key) {
    const value = P[key];
    if (value === void 0 || value === null) throw new Error(`Recommendations module "${key}" is not loaded`);
    return value;
  }

  // client/src/features/seerr/recommendations/recommendations-render.ts
  var GENRE_COLORS = /* @__PURE__ */ new Map([
    ["Action", "#b91c1ccc"],
    ["Action & Adventure", "#b91c1ccc"],
    ["Adventure", "#7c3aedcc"],
    ["Animation", "#0891b2cc"],
    ["Comedy", "#d97706cc"],
    ["Crime", "#1d4ed8cc"],
    ["Documentary", "#059669cc"],
    ["Drama", "#db2777cc"],
    ["Family", "#65a30dcc"],
    ["Fantasy", "#9333eacc"],
    ["History", "#78716ccc"],
    ["Horror", "#27272acc"],
    ["Kids", "#f59e0bcc"],
    ["Music", "#e11d48cc"],
    ["Mystery", "#4c1d95cc"],
    ["News", "#334155cc"],
    ["Reality", "#c026d3cc"],
    ["Romance", "#ec4899cc"],
    ["Sci-Fi & Fantasy", "#2563ebcc"],
    ["Science Fiction", "#2563ebcc"],
    ["Soap", "#db2777cc"],
    ["Talk", "#0d9488cc"],
    ["Thriller", "#7f1d1dcc"],
    ["TV Movie", "#6b7280cc"],
    ["War", "#57534ecc"],
    ["War & Politics", "#57534ecc"],
    ["Western", "#b45309cc"]
  ]);
  var GENRE_COLOR_FALLBACK = "#4338ca";
  function element(tag, className, parent) {
    const node = document.createElement(tag);
    node.className = className;
    parent?.appendChild(node);
    return node;
  }
  function trackStickyBar(JE, bar) {
    let observedHeader = null;
    let resizeObserver = null;
    let frame = 0;
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    function stop() {
      document.removeEventListener("scroll", schedule, { capture: true });
      window.removeEventListener("resize", schedule);
      resizeObserver?.disconnect();
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    }
    function measure() {
      frame = 0;
      if (!bar.isConnected || !bar.parentElement) {
        stop();
        return;
      }
      const header = JE.helpers?.getHeaderElement?.() ?? null;
      if (header !== observedHeader && typeof ResizeObserver !== "undefined") {
        resizeObserver?.disconnect();
        observedHeader = header;
        if (header) {
          resizeObserver = new ResizeObserver(schedule);
          resizeObserver.observe(header);
        }
      }
      const headerBottom = JE.helpers?.getHeaderBottom?.() ?? 0;
      bar.style.setProperty("--je-sticky-top", headerBottom ? `${headerBottom}px` : "");
      const padding = getComputedStyle(bar.parentElement);
      bar.style.setProperty("--je-bleed-l", padding.paddingLeft);
      bar.style.setProperty("--je-bleed-r", padding.paddingRight);
      const stickyTop = parseFloat(getComputedStyle(bar).top) || 0;
      bar.classList.toggle("je-stuck", bar.getBoundingClientRect().top <= stickyTop + 1);
    }
    document.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule);
    measure();
    return stop;
  }
  function enableRowScroll(section, scroller, owner) {
    const makeButton = (direction) => {
      const button = element("button", `je-scroll-btn ${direction}`, section);
      button.type = "button";
      button.tabIndex = -1;
      button.setAttribute("aria-hidden", "true");
      const icon = element("span", "je-msym-rounded", button);
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = `chevron_${direction}`;
      button.addEventListener("click", () => {
        scroller.scrollBy({ left: (direction === "left" ? -1 : 1) * scroller.clientWidth * 0.8, behavior: "smooth" });
      });
      return button;
    };
    const left = makeButton("left");
    const right = makeButton("right");
    const update = () => {
      const canLeft = scroller.scrollLeft > 4;
      const canRight = scroller.scrollLeft < scroller.scrollWidth - scroller.clientWidth - 4;
      scroller.classList.toggle("je-fade-l", canLeft);
      scroller.classList.toggle("je-fade-r", canRight);
      left.classList.toggle("show", canLeft);
      right.classList.toggle("show", canRight);
      const items = scroller.firstElementChild;
      const image = scroller.querySelector(".cardScalable");
      if (items instanceof HTMLElement && image instanceof HTMLElement) {
        const middle = scroller.offsetTop + items.offsetTop + image.offsetTop + image.offsetHeight / 2;
        left.style.top = right.style.top = `${Math.round(middle - 22)}px`;
      }
    };
    scroller.addEventListener("scroll", update, { passive: true });
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(update);
      observer.observe(scroller);
      if (scroller.firstElementChild) observer.observe(scroller.firstElementChild);
      owner?.disposers.push(() => observer.disconnect());
    }
    const frame = requestAnimationFrame(update);
    owner?.disposers.push(() => cancelAnimationFrame(frame));
  }
  function createRowShell() {
    const section = element("div", "verticalSection emby-scroller-container je-recommendations-section");
    const scroller = element("div", "padded-top-focusscale padded-bottom-focusscale emby-scroller");
    scroller.setAttribute("is", "emby-scroller");
    scroller.dataset.horizontal = "true";
    scroller.dataset.centerfocus = "card";
    const items = element("div", "focuscontainer-x itemsContainer scrollSlider je-pad-left je-pad-right", scroller);
    items.setAttribute("is", "emby-itemscontainer");
    return {
      section,
      items,
      finish(owner) {
        section.appendChild(scroller);
        enableRowScroll(section, scroller, owner);
        return section;
      }
    };
  }
  function plainHeading(section, title) {
    const heading = element("h2", "sectionTitle sectionTitle-cards focuscontainer-x je-pad-left je-pad-right", section);
    heading.textContent = title;
  }
  function createTile(items, imageClass) {
    const tile = element("div", "card overflowBackdropCard card-hoverable card-withuserdata je-recommendations-tile", items);
    const box = element("div", "cardBox cardBox-bottompadded", tile);
    const scalable = element("div", "cardScalable", box);
    element("div", "cardPadder cardPadder-overflowBackdrop", scalable);
    const image = element("div", `cardImageContainer cardContent ${imageClass}`, scalable);
    image.style.cursor = "pointer";
    element("div", "cardOverlayContainer", scalable).style.pointerEvents = "none";
    return image;
  }
  function createRows(JE, P) {
    const showCategory = (categoryKey) => {
      part(P, "showCategoryPage")(categoryKey).catch((error) => console.error(`${LOG_PREFIX} Failed to open category`, error));
    };
    function createMediaRow(title, results, viewAllKey, owner) {
      const shell = createRowShell();
      if (viewAllKey) {
        const link = element("a", "more button-flat button-flat-mini sectionTitleTextButton emby-button je-pad-left je-pad-right", shell.section);
        link.setAttribute("is", "emby-linkbutton");
        link.href = "#";
        element("h2", "sectionTitle sectionTitle-cards", link).textContent = title;
        const chevron = element("span", "material-icons chevron_right", link);
        chevron.setAttribute("aria-hidden", "true");
        link.addEventListener("click", (event) => {
          event.preventDefault();
          showCategory(viewAllKey);
        });
      } else {
        plainHeading(shell.section, title);
      }
      shell.items.appendChild(filterOf(JE).createCardsFragment(results, { cardClass: "overflowPortraitCard" }));
      return shell.finish(owner);
    }
    function createTileRow(title, items, kind, owner) {
      const shell = createRowShell();
      plainHeading(shell.section, title);
      for (const item of items) {
        const image = createTile(shell.items, "je-tile-image");
        image.style.backgroundColor = "#fff";
        image.addEventListener("click", () => showCategory(`${kind}-${item.id}`));
        const fallback = element("span", "je-tile-fallback-text", image);
        fallback.textContent = item.name;
        if (item.logo) {
          const logo = element("img", "je-tile-logo");
          logo.src = `https://image.tmdb.org/t/p/w300${item.logo}`;
          logo.alt = item.name;
          logo.loading = "lazy";
          logo.style.cssText = "width: auto; height: auto; max-width: 90%; max-height: 90%; object-fit: contain;";
          logo.onerror = () => {
            image.replaceChildren(fallback);
          };
          image.replaceChildren(logo);
        }
      }
      return shell.finish(owner);
    }
    function createGenreTileRow(title, genres, mediaType, owner) {
      const shell = createRowShell();
      plainHeading(shell.section, title);
      const usedBackdrops = /* @__PURE__ */ new Set();
      for (const genre of genres) {
        const backdrop = genre.backdrops.find((path) => !usedBackdrops.has(path)) ?? genre.backdrops[0];
        if (backdrop) usedBackdrops.add(backdrop);
        const image = createTile(shell.items, "je-genre-tile-image");
        image.style.backgroundColor = GENRE_COLORS.get(genre.name) ?? GENRE_COLOR_FALLBACK;
        image.addEventListener("click", () => showCategory(`genre-${mediaType}-${genre.id}`));
        if (backdrop) {
          const img = element("img", "je-genre-tile-backdrop", image);
          img.src = `https://image.tmdb.org/t/p/w500${backdrop}`;
          img.alt = "";
          img.loading = "lazy";
          img.onerror = () => img.remove();
        }
        element("span", "je-genre-tile-title", image).textContent = genre.name;
      }
      return shell.finish(owner);
    }
    return { createMediaRow, createTileRow, createGenreTileRow };
  }
  (function() {
    "use strict";
    const { JE, P } = recommendationsHost();
    const rows = createRows(JE, P);
    const text = (key) => translate(JE, key);
    const trackBar = (bar) => trackStickyBar(JE, bar);
    function beginRender(container) {
      const state = part(P, "state");
      part(P, "disposeRender")(container);
      part(P, "sweepRenders")();
      const controller = new AbortController();
      bindToSession(JE, controller);
      const owner = { container, controller, disposers: [] };
      state.renders.set(container, owner);
      if (container.closest(`#${PAGE_ID}`)) {
        state.currentAbortController?.abort();
        state.currentAbortController = controller;
      }
      return owner;
    }
    function appendHeading(owner) {
      const heading = element("h1", "je-recommendations-title je-pad-left je-pad-right", owner.container);
      const logo = element("img", "je-reco-logo", heading);
      logo.alt = "";
      logo.src = JE.cdn?.selfhst("svg/seerr.svg") ?? "";
      element("span", "", heading).textContent = text("recommendations_title");
      owner.disposers.push(trackBar(heading));
    }
    function appendRetry(owner) {
      const row = element("div", "je-retry-row je-pad-left je-pad-right", owner.container);
      const button = element("button", "raised emby-button", row);
      button.type = "button";
      button.textContent = "⟳ Tap to retry";
      button.addEventListener("click", () => {
        void renderInto(owner.container);
      }, { once: true, signal: owner.controller.signal });
    }
    function appendEmpty(owner, rowResults) {
      const empty = element("div", "je-recommendations-empty je-pad-left je-pad-right", owner.container);
      empty.textContent = text("recommendations_empty");
      if (rowResults.some((entry) => entry.failed)) appendRetry(owner);
    }
    function appendRows(owner, rowResults) {
      const { container } = owner;
      for (const { row, results } of rowResults) {
        if (results.length > 0) container.appendChild(rows.createMediaRow(text(row.titleKey), results, row.key, owner));
      }
      const movieGenres = part(P, "MOVIE_GENRES");
      const tvGenres = part(P, "TV_GENRES");
      if (movieGenres.length) container.appendChild(rows.createGenreTileRow(text("recommendations_movie_genres"), movieGenres, "movie", owner));
      if (tvGenres.length) container.appendChild(rows.createGenreTileRow(text("recommendations_tv_genres"), tvGenres, "tv", owner));
      container.appendChild(rows.createTileRow(text("recommendations_studios"), part(P, "STUDIOS"), "studio", owner));
      container.appendChild(rows.createTileRow(text("recommendations_networks"), part(P, "NETWORKS"), "network", owner));
    }
    async function renderInto(container) {
      const state = part(P, "state");
      const owner = beginRender(container);
      const { signal } = owner.controller;
      const wasConnected = container.isConnected;
      const superseded = () => signal.aborted || state.renders.get(container) !== owner;
      JE.jellyseerrUI?.releasePosters?.(container);
      container.replaceChildren();
      appendHeading(owner);
      const loading = JE.core?.ui?.createSkeletonRows([
        ...part(P, "ROWS").map((row) => text(row.titleKey)),
        text("recommendations_movie_genres"),
        text("recommendations_tv_genres"),
        text("recommendations_studios"),
        text("recommendations_networks")
      ]);
      if (loading) {
        loading.className = "je-pad-left je-pad-right";
        loading.setAttribute("aria-label", text("recommendations_loading"));
        container.appendChild(loading);
      }
      let rowResults = [];
      let movieGenres = [];
      let tvGenres = [];
      try {
        [rowResults, movieGenres, tvGenres] = await Promise.all([
          part(P, "fetchAllRows")(signal),
          part(P, "fetchGenreSlider")("movie"),
          part(P, "fetchGenreSlider")("tv")
        ]);
      } catch (error) {
        if (isAbortError(error)) return;
        console.error(`${LOG_PREFIX} Failed to load rows`, error);
      }
      if (superseded()) return;
      if (wasConnected && !container.isConnected) {
        part(P, "disposeRender")(container);
        return;
      }
      P.MOVIE_GENRES = movieGenres;
      P.TV_GENRES = tvGenres;
      loading?.remove();
      if (rowResults.some((entry) => entry.results.length > 0)) appendRows(owner, rowResults);
      else appendEmpty(owner, rowResults);
    }
    P.trackStickyBar = trackBar;
    P.createMediaRow = rows.createMediaRow;
    P.createTileRow = rows.createTileRow;
    P.createGenreTileRow = rows.createGenreTileRow;
    P.renderInto = renderInto;
    P.renderForCustomTab = (element2) => {
      if (!element2) return;
      renderInto(element2).catch((error) => console.error(`${LOG_PREFIX} Failed to render`, error));
    };
  })();
})();
})();
//# sourceMappingURL=recommendations-render.js.map
