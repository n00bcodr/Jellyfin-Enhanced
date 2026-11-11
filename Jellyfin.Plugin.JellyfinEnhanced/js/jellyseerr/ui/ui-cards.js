(() => {
"use strict";
(() => {
  // client/src/host/context.ts
  function featureContext(feature, core, slots) {
    const shared5 = core.core?.featureContext;
    if (typeof shared5 !== "function") {
      throw new Error(`${feature}: JE.core.featureContext is missing; core/ui-kit.js must load before feature scripts`);
    }
    return shared5(feature, core, slots);
  }
  function sharedModule(id) {
    const namespace = window.JellyfinEnhanced?.core?.sharedModules?.[id];
    if (!namespace) throw new Error(`${id} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);
    return namespace;
  }
  function sharedExport(namespace, name) {
    return namespace[name];
  }

  // client/src/features/seerr/host-core.ts
  var coreContexts = /* @__PURE__ */ new WeakMap();
  function seerrCoreContext(JE) {
    let ctx = coreContexts.get(JE);
    if (!ctx) {
      ctx = featureContext("seerr", JE, {
        internalSlots: ["jellyseerrUi"],
        internalsObject: () => JE.internals || (JE.internals = {})
      });
      coreContexts.set(JE, ctx);
    }
    return ctx;
  }
  function seerrCoreHost() {
    const host = window;
    const JE = host.JellyfinEnhanced;
    if (!JE) throw new Error("Jellyfin Enhanced must be initialized before the Seerr core group");
    return { JE, window: host, document, apiClient: () => host.ApiClient, liveBridge: () => host.JellyfinEnhanced };
  }

  // client/generated-shared/stub/client/src/features/seerr/core/decode.ts
  var shared = /* @__PURE__ */ sharedModule("features/seerr/core/decode");
  var export16 = /* @__PURE__ */ sharedExport(shared, "isMediaItem");
  var export20 = /* @__PURE__ */ sharedExport(shared, "isSafeTmdbImagePath");
  var export22 = /* @__PURE__ */ sharedExport(shared, "isString");

  // client/generated-shared/stub/client/src/features/seerr/core/display.ts
  var shared2 = /* @__PURE__ */ sharedModule("features/seerr/core/display");
  var export0 = /* @__PURE__ */ sharedExport(shared2, "analyzeSeasonStatuses");

  // client/generated-shared/stub/client/src/features/seerr/core/status.ts
  var shared3 = /* @__PURE__ */ sharedModule("features/seerr/core/status");
  var export1 = /* @__PURE__ */ sharedExport(shared3, "MEDIA");
  var export4 = /* @__PURE__ */ sharedExport(shared3, "effectiveMediaStatus");

  // client/src/features/seerr/core/runtime.ts
  var LOG_UI = "🪼 Jellyfin Enhanced: Seerr UI:";
  function groupInternals(JE) {
    const own = seerrCoreContext(JE).own;
    return own.jellyseerrUi || (own.jellyseerrUi = { state: { jellyseerrHoverPopover: null, jellyseerrHoverLock: false, active4KPopup: null } });
  }
  function firstInstall(JE, name) {
    const internals = groupInternals(JE);
    const installed = internals.installed || (internals.installed = /* @__PURE__ */ new Set());
    if (installed.has(name)) return false;
    installed.add(name);
    return true;
  }
  var ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };
  function escapeWith(JE) {
    return (value) => {
      const escape = JE.escapeHtml;
      if (typeof escape === "function") return escape(value);
      return String(value ?? "").replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);
    };
  }
  function text(read) {
    try {
      const value = read();
      return export22(value) && value ? value : null;
    } catch {
      return null;
    }
  }
  function captureOrigin(host) {
    const session = host.JE.session;
    const epoch = session ? session.getEpoch() : null;
    const user = () => text(() => host.apiClient()?.getCurrentUserId?.());
    const server = () => text(() => {
      const client = host.apiClient();
      const id = client?.serverId;
      return typeof id === "function" ? Reflect.apply(id, client, []) : id;
    });
    const startClient = host.apiClient();
    const root = () => text(() => host.apiClient()?.getUrl("/"));
    const token = () => text(() => host.apiClient()?.accessToken?.());
    const startRoot = root();
    const startToken = token();
    const startUser = user();
    const startServer = server();
    return {
      epoch,
      current: () => host.apiClient() === startClient && root() === startRoot && token() === startToken && (!session || epoch === null || session.isCurrent(epoch)) && user() === startUser && server() === startServer
    };
  }
  function bindViewOrigin(host, element) {
    const internals = groupInternals(host.JE);
    const owners = internals.viewOrigins || (internals.viewOrigins = /* @__PURE__ */ new WeakMap());
    owners.set(element, captureOrigin(host));
  }
  function isViewCurrent(host, element) {
    const owners = groupInternals(host.JE).viewOrigins;
    for (let node = element; node; node = node.parentElement) {
      if (owners?.get(node)?.current() === false) return false;
    }
    return true;
  }

  // client/generated-shared/stub/client/src/features/seerr/core/ui/icon-markup.ts
  var shared4 = /* @__PURE__ */ sharedModule("features/seerr/core/ui/icon-markup");
  var export02 = /* @__PURE__ */ sharedExport(shared4, "ICONS");

  // client/src/features/seerr/core/ui/cards.ts
  var linkableBase = (base) => /^https?:\/\//i.test(base) || base.startsWith("/") ? base : "";
  function part(parent, index) {
    const element = parent?.children[index];
    if (!(element instanceof HTMLElement)) throw new Error("Seerr card template is missing a part");
    return element;
  }
  function installCards(host) {
    const { JE, document: document2, window: window2 } = host;
    if (!firstInstall(JE, "ui-cards")) return;
    const ui = JE.jellyseerrUI || (JE.jellyseerrUI = {});
    const internals = groupInternals(JE);
    const seerr = seerrCoreContext(JE);
    const escapeHtml = escapeWith(JE);
    const isTvLayout = () => JE.core?.ui?.isTvLayout?.() === true;
    const POSTER_DATA_KEY = "jePoster";
    let posterObserver = null;
    const observedPosters = /* @__PURE__ */ new Set();
    const posterReadiness = /* @__PURE__ */ new WeakMap();
    function getPosterReadiness(el) {
      let record = posterReadiness.get(el);
      if (!record) {
        let resolve = () => void 0;
        const promise = new Promise((r) => {
          resolve = r;
        });
        record = { promise, resolve: () => resolve() };
        posterReadiness.set(el, record);
      }
      return record;
    }
    function applyPoster(el) {
      const url = el.dataset[POSTER_DATA_KEY];
      try {
        posterObserver?.unobserve(el);
      } catch {
      }
      observedPosters.delete(el);
      if (!url) return;
      delete el.dataset[POSTER_DATA_KEY];
      el.style.backgroundImage = `url("${url.replace(/["\\]/g, "\\$&")}")`;
      const probe = new Image();
      probe.onload = probe.onerror = () => getPosterReadiness(el).resolve();
      probe.src = url;
    }
    function getPosterObserver() {
      if (posterObserver) return posterObserver;
      if (typeof IntersectionObserver === "undefined") return null;
      try {
        posterObserver = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            if ((entry.isIntersecting || entry.intersectionRatio > 0) && entry.target instanceof HTMLElement) applyPoster(entry.target);
          }
        }, { root: null, rootMargin: "800px", threshold: 0 });
      } catch {
        posterObserver = null;
      }
      return posterObserver;
    }
    function observePoster(el, url) {
      el.dataset[POSTER_DATA_KEY] = url;
      const observer = getPosterObserver();
      if (!observer) {
        applyPoster(el);
        return;
      }
      try {
        observer.observe(el);
        observedPosters.add(el);
      } catch {
        applyPoster(el);
      }
    }
    const ICON_POSTER_WAIT_MS = 3e3;
    const ICON_IDLE_TIMEOUT_MS = 1e3;
    let iconObserver = null;
    const iconJobs = /* @__PURE__ */ new Map();
    function runWhenIdle(fn) {
      if (typeof window2.requestIdleCallback === "function") {
        const id2 = window2.requestIdleCallback(() => fn(), { timeout: ICON_IDLE_TIMEOUT_MS });
        return () => window2.cancelIdleCallback(id2);
      }
      const id = window2.setTimeout(fn, 0);
      return () => window2.clearTimeout(id);
    }
    function cancelIconJob(el, job) {
      job.cancelled = true;
      if (job.timer !== null) window2.clearTimeout(job.timer);
      job.cancelIdle?.();
      job.controller?.abort();
      try {
        iconObserver?.unobserve(el);
      } catch {
      }
      iconJobs.delete(el);
    }
    function startProviderIcons(el, job) {
      job.started = true;
      const bound = new Promise((resolve) => {
        job.timer = window2.setTimeout(resolve, ICON_POSTER_WAIT_MS);
      });
      void Promise.race([getPosterReadiness(el).promise, bound]).then(() => {
        if (job.timer !== null) window2.clearTimeout(job.timer);
        if (job.cancelled) return;
        job.cancelIdle = runWhenIdle(() => {
          job.cancelIdle = null;
          if (job.cancelled) return;
          if (!job.visible || !job.container.isConnected) {
            job.started = false;
            return;
          }
          try {
            iconObserver?.unobserve(el);
          } catch {
          }
          const controller = new AbortController();
          job.controller = controller;
          const lookup = internals.fetchProviderIcons?.(job.container, job.tmdbId, job.mediaType, controller.signal) ?? Promise.resolve();
          void lookup.finally(() => {
            if (iconJobs.get(el) === job) iconJobs.delete(el);
          });
        });
      });
    }
    function getIconObserver() {
      if (iconObserver) return iconObserver;
      if (typeof IntersectionObserver === "undefined") return null;
      try {
        iconObserver = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            if (!(entry.target instanceof HTMLElement)) continue;
            const job = iconJobs.get(entry.target);
            if (!job || job.controller) continue;
            job.visible = entry.isIntersecting || entry.intersectionRatio > 0;
            if (job.visible && !job.started) startProviderIcons(entry.target, job);
          }
        }, { root: null, rootMargin: "0px", threshold: 0 });
      } catch {
        iconObserver = null;
      }
      return iconObserver;
    }
    function observeProviderIcons(el, container, tmdbId, mediaType) {
      const observer = getIconObserver();
      if (!observer) {
        void internals.fetchProviderIcons?.(container, tmdbId, mediaType);
        return;
      }
      iconJobs.set(el, { container, tmdbId, mediaType, visible: false, started: false, cancelled: false, timer: null, cancelIdle: null, controller: null });
      try {
        observer.observe(el);
      } catch {
        iconJobs.delete(el);
        void internals.fetchProviderIcons?.(container, tmdbId, mediaType);
      }
    }
    function releasePosters(root) {
      const isReleased = (el) => !!root && root.contains(el) || !el.isConnected && !(el.getRootNode() instanceof DocumentFragment);
      if (posterObserver) {
        for (const el of [...observedPosters]) {
          if (!isReleased(el)) continue;
          try {
            posterObserver.unobserve(el);
          } catch {
          }
          observedPosters.delete(el);
        }
      }
      for (const [el, job] of [...iconJobs]) if (isReleased(el)) cancelIconJob(el, job);
    }
    function getLibraryAvailability(item, seasonAnalysis) {
      const info = item.mediaInfo;
      const jellyfinMediaId = info?.jellyfinMediaId || info?.jellyfinMediaId4k || null;
      let effective;
      if (item.mediaType === "tv" && info?.seasons?.length) {
        const analysis = seasonAnalysis || export0(info.seasons, JE.t);
        effective = analysis.overallStatus;
      } else {
        effective = export4(info?.status, jellyfinMediaId);
      }
      const isAvailable = !!jellyfinMediaId && (effective === export1.AVAILABLE || effective === export1.PARTIALLY_AVAILABLE);
      return { isAvailable, jellyfinMediaId };
    }
    const cardStates = /* @__PURE__ */ new WeakMap();
    const boundContainers = /* @__PURE__ */ new WeakSet();
    let cardTemplate = null;
    let cardTemplateIconUrl = null;
    function getCardTemplate(seerrIconUrl) {
      if (cardTemplate && cardTemplateIconUrl === seerrIconUrl) return cardTemplate;
      const template = document2.createElement("template");
      template.innerHTML = `<div class="card overflowPortraitCard card-hoverable card-withuserdata jellyseerr-card"><div class="cardBox cardBox-bottompadded"><div class="cardScalable"><div class="cardPadder cardPadder-overflowPortrait"></div><div class="cardImageContainer coveredImage cardContent jellyseerr-poster-image focusable" style="cursor: pointer;" tabindex="0"><div class="jellyseerr-status-badge"></div><div class="jellyseerr-elsewhere-icons"></div><div class="cardIndicators"></div></div><div class="cardOverlayContainer" style="pointer-events: none;"></div></div><div class="cardText cardTextCentered cardText-first"><a is="emby-linkbutton" class="jellyseerr-more-info-link"><bdi></bdi></a></div><div class="cardText cardTextCentered cardText-secondary jellyseerr-meta"><img class="jellyseerr-icon-on-card" alt="Seerr"><bdi></bdi><div class="jellyseerr-rating">${(internals.icons ?? export02).star}<span></span></div></div></div></div>`;
      const root = template.content.firstElementChild;
      if (!(root instanceof HTMLElement)) throw new Error("Seerr card template did not parse");
      root.querySelector(".jellyseerr-icon-on-card")?.setAttribute("src", seerrIconUrl);
      cardTemplate = root;
      cardTemplateIconUrl = seerrIconUrl;
      return root;
    }
    let batchContext = null;
    function getBatchContext() {
      if (batchContext) return batchContext;
      const config = JE.pluginConfig;
      const hiddenSettings = seerr.peer("hiddenContent")?.getSettings?.() ?? null;
      const showHideButtons = !!(hiddenSettings && hiddenSettings.enabled && hiddenSettings.showHideButtons !== false && hiddenSettings.showButtonJellyseerr !== false);
      const translatedOr = (key, fallback) => JE.t(key) !== key ? JE.t(key) : fallback;
      const mediaBadgeKeys = { movie: "jellyseerr_card_badge_movie", tv: "jellyseerr_card_badge_series", collection: "jellyseerr_card_badge_collection" };
      const mediaBadgeLabels = /* @__PURE__ */ new Map();
      let viewLabel = null;
      const ctx = {
        seerrBase: JE.jellyseerrAPI?.resolveJellyseerrBaseUrl() || "",
        // A TV app has no new window to open Seerr in, so it always uses the modal.
        useMoreInfoModal: !!config?.JellyseerrUseMoreInfoModal || isTvLayout(),
        moreInfoLoaded: !!JE.jellyseerrMoreInfo,
        availablePostersLinkToJellyfin: !!config?.JellyseerrAvailablePosterLinksToJellyfin,
        showProviderIcons: !!(config?.ShowElsewhereOnJellyseerr && config.TmdbEnabled),
        posterNotFoundUrl: JE.cdn?.url?.("ibb", "fdbkXQdP/jellyseerr-poster-not-found.png") ?? "",
        seerrIconUrl: JE.cdn?.selfhst?.("svg/seerr.svg") ?? "",
        showHideButtons,
        hiddenLabel: showHideButtons ? translatedOr("hidden_content_already_hidden", "Hidden") : null,
        unhideLabel: showHideButtons ? translatedOr("hidden_content_unhide", "Unhide") : null,
        hideLabel: showHideButtons ? translatedOr("hidden_content_hide_button", "Hide") : null,
        viewOnJellyseerrLabel() {
          if (viewLabel === null) viewLabel = JE.t("jellyseerr_card_view_on_jellyseerr") || "View on Jellyseerr";
          return viewLabel;
        },
        mediaBadgeLabel(mediaType) {
          const key = mediaBadgeKeys[mediaType];
          if (!key) return void 0;
          let label = mediaBadgeLabels.get(mediaType);
          if (label === void 0) {
            label = JE.t(key);
            mediaBadgeLabels.set(mediaType, label);
          }
          return label;
        }
      };
      batchContext = ctx;
      queueMicrotask(() => {
        if (batchContext === ctx) batchContext = null;
      });
      return ctx;
    }
    function cardItemInputs(item) {
      const info = item.mediaInfo;
      return [
        item.id,
        item.mediaType,
        item.title,
        item.name,
        item.posterPath,
        item.voteAverage,
        item.releaseDate,
        item.firstAirDate,
        item.collection ? [item.collection.name] : null,
        info ? [
          info.status,
          info.jellyfinMediaId,
          info.jellyfinMediaId4k,
          Array.isArray(info.seasons) ? info.seasons.map((s) => [s?.seasonNumber, s?.status]) : !!info.seasons,
          info.downloadStatus?.length,
          info.downloadStatus4k?.length
        ] : null
      ];
    }
    function cardInputsKey(items) {
      const ctx = getBatchContext();
      return JSON.stringify([
        ctx.seerrBase,
        ctx.useMoreInfoModal,
        ctx.moreInfoLoaded,
        ctx.availablePostersLinkToJellyfin,
        ctx.showProviderIcons,
        ctx.posterNotFoundUrl,
        ctx.seerrIconUrl,
        ctx.showHideButtons,
        ctx.hiddenLabel,
        ctx.unhideLabel,
        ctx.hideLabel,
        ctx.viewOnJellyseerrLabel(),
        ctx.mediaBadgeLabel("movie"),
        ctx.mediaBadgeLabel("tv"),
        ctx.mediaBadgeLabel("collection"),
        items.map((item) => export16(item) ? cardItemInputs(item) : null),
        ctx.showHideButtons ? items.map((item) => export16(item) ? seerr.peer("hiddenContent")?.isHiddenByTmdbId?.(item.id) ?? false : null) : null
      ]);
    }
    function setHideButtonState(hideBtn, hidden, ctx) {
      hideBtn.className = hidden ? "je-hide-btn je-already-hidden" : "je-hide-btn";
      hideBtn.title = (hidden ? ctx.hiddenLabel : ctx.hideLabel) ?? "";
      hideBtn.replaceChildren();
      const icon = document2.createElement("span");
      icon.className = "material-icons";
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = hidden ? "visibility_off" : "visibility";
      hideBtn.appendChild(icon);
    }
    function createJellyseerrCard(value, isJellyseerrActive, jellyseerrUserFound) {
      if (!export16(value)) {
        console.debug(`${LOG_UI} Skipped a malformed Seerr result`, value);
        return null;
      }
      const item = value;
      const ctx = getBatchContext();
      const isCollection = item.mediaType === "collection";
      const year = item.releaseDate?.substring(0, 4) || item.firstAirDate?.substring(0, 4) || (isCollection ? "" : "N/A");
      const posterUrl = export20(item.posterPath) ? `https://image.tmdb.org/t/p/w400${item.posterPath}` : ctx.posterNotFoundUrl;
      const rating = item.voteAverage ? item.voteAverage.toFixed(1) : isCollection ? "" : "N/A";
      const title = String((item.title || item.name) ?? "");
      const base = linkableBase(ctx.seerrBase);
      const jellyseerrUrl = base ? `${base}/${encodeURIComponent(item.mediaType)}/${item.id}` : null;
      const useMoreInfoModal = ctx.useMoreInfoModal;
      const seasons = item.mediaType === "tv" ? item.mediaInfo?.seasons : null;
      const seasonAnalysis = seasons ? export0(seasons, JE.t) : null;
      const { isAvailable, jellyfinMediaId } = getLibraryAvailability(item, seasonAnalysis);
      const jellyfinHref = isAvailable ? `#!/details?id=${jellyfinMediaId}` : null;
      const linksAvailableToJellyfin = isAvailable && item.mediaType !== "collection" && ctx.availablePostersLinkToJellyfin;
      const card = document2.importNode(getCardTemplate(ctx.seerrIconUrl), true);
      bindViewOrigin(host, card);
      if (isAvailable) card.classList.add("jellyseerr-card-in-library");
      const cardBox = part(card, 0);
      const cardScalable = part(cardBox, 0);
      const imageContainer = part(cardScalable, 1);
      const titleLink = part(part(cardBox, 1), 0);
      const meta = part(cardBox, 2);
      if (jellyfinHref) {
        titleLink.setAttribute("href", jellyfinHref);
      } else if (useMoreInfoModal || !jellyseerrUrl) {
        titleLink.setAttribute("href", "#");
      } else {
        titleLink.setAttribute("href", jellyseerrUrl);
        titleLink.setAttribute("target", "_blank");
        titleLink.setAttribute("rel", "noopener noreferrer");
      }
      titleLink.setAttribute("data-tmdb-id", String(item.id));
      titleLink.setAttribute("data-media-type", item.mediaType);
      titleLink.setAttribute("title", jellyfinHref || useMoreInfoModal || !jellyseerrUrl ? title : ctx.viewOnJellyseerrLabel());
      const titleText = titleLink.firstElementChild;
      if (titleText) titleText.textContent = title;
      titleLink.addEventListener("click", onTitleLinkCaptureClick, true);
      const ratingElement = part(meta, 2);
      if (rating) {
        const value2 = ratingElement.lastElementChild;
        if (value2) value2.textContent = rating;
      } else ratingElement.remove();
      const yearElement = part(meta, 1);
      if (year) yearElement.textContent = year;
      else yearElement.remove();
      observePoster(imageContainer, posterUrl);
      internals.setStatusBadge?.(card, item, seasonAnalysis);
      internals.addMediaTypeBadge?.(card, item, imageContainer, ctx.mediaBadgeLabel(item.mediaType));
      internals.addCollectionMembershipBadge?.(card, item, imageContainer);
      if (ctx.showProviderIcons && item.mediaType !== "collection") observeProviderIcons(imageContainer, part(imageContainer, 1), item.id, item.mediaType);
      if (ctx.showHideButtons) {
        const hideBtn = document2.createElement("button");
        setHideButtonState(hideBtn, seerr.peer("hiddenContent")?.isHiddenByTmdbId?.(item.id) ?? false, ctx);
        cardBox.style.position = "relative";
        cardBox.appendChild(hideBtn);
      }
      cardStates.set(card, {
        item,
        isJellyseerrActive,
        jellyseerrUserFound,
        ctx,
        useMoreInfoModal,
        jellyseerrUrl,
        jellyfinMediaId,
        jellyfinHref,
        linksAvailableToJellyfin,
        posterOpensModal: useMoreInfoModal && ctx.moreInfoLoaded,
        // Without the modal, an item outside the library links its overview text to Seerr.
        navigatesExternally: !useMoreInfoModal && !jellyfinMediaId && !!jellyseerrUrl && item.mediaType !== "collection",
        cardScalable,
        imageContainer,
        overview: null,
        button: null,
        outsideClick: null,
        tapNavigatedAt: 0
      });
      return card;
    }
    function goToJellyfinItem(state) {
      try {
        const page = host.window.Emby?.Page;
        if (page?.showItem && state.jellyfinMediaId) {
          page.showItem(state.jellyfinMediaId);
          return;
        }
      } catch {
      }
      if (state.jellyfinHref) window2.location.hash = state.jellyfinHref;
    }
    const openMoreInfo = (tmdbId, mediaType) => {
      if (tmdbId && mediaType) void JE.jellyseerrMoreInfo?.open(tmdbId, mediaType);
    };
    function createOverview(state) {
      const item = state.item;
      const overview = document2.createElement("div");
      overview.className = "jellyseerr-overview";
      overview.style.cursor = "pointer";
      const text2 = escapeHtml((item.overview || JE.t("jellyseerr_card_no_info")).slice(0, 500));
      const contentHtml = state.navigatesExternally && state.jellyseerrUrl ? `<a is="emby-linkbutton" href="${escapeHtml(state.jellyseerrUrl)}" target="_blank" rel="noopener noreferrer" class="content jellyseerr-overview-link" style="text-decoration:none;color:inherit;">${text2}</a>` : `<div class="content">${text2}</div>`;
      overview.innerHTML = `
                    ${contentHtml}
                    <button type="button" class="jellyseerr-request-button" data-tmdb-id="${item.id}" data-media-type="${escapeHtml(item.mediaType)}"></button>
                `;
      state.overview = overview;
      state.cardScalable.appendChild(overview);
      const button = overview.querySelector(".jellyseerr-request-button");
      state.button = button instanceof HTMLButtonElement ? button : null;
      if (state.button) internals.configureRequestButton?.(state.button, item, state.isJellyseerrActive, state.jellyseerrUserFound);
      return overview;
    }
    function removeOverview(state) {
      const overview = state.overview;
      if (overview?.parentNode) {
        overview.parentNode.removeChild(overview);
        state.overview = null;
        state.button = null;
      }
      if (state.outsideClick) document2.removeEventListener("click", state.outsideClick);
    }
    function closeOverviewOnOutsideClick(card, state) {
      const handler = state.outsideClick || (state.outsideClick = (event) => {
        if (!(event.target instanceof Node) || !card.contains(event.target)) removeOverview(state);
      });
      window2.setTimeout(() => {
        if (state.overview) document2.addEventListener("click", handler);
      }, 0);
    }
    function cardEventTarget(container, event) {
      const target = event.target;
      if (!(target instanceof Element)) return null;
      const card = target.closest(".jellyseerr-card");
      if (!(card instanceof HTMLElement) || card.parentElement !== container || !isViewCurrent(host, card)) return null;
      const state = cardStates.get(card);
      return state ? { card, state, target } : null;
    }
    function inCard(card, target, selector) {
      const el = target.closest(selector);
      return el instanceof HTMLElement && card.contains(el) ? el : null;
    }
    function onTitleLinkCaptureClick(event) {
      const link = event.currentTarget instanceof HTMLElement ? event.currentTarget : this;
      const card = link.closest(".jellyseerr-card");
      const state = card instanceof HTMLElement ? cardStates.get(card) : void 0;
      if (!state || !card || !isViewCurrent(host, card)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const item = state.item;
      const href = link.getAttribute("href");
      if (href && href.startsWith("#!/details?id=")) return;
      if (item.mediaType === "collection") {
        event.preventDefault();
        event.stopPropagation();
        void ui.showCollectionRequestModal?.(item.id, item.name || item.title || "", item);
        return;
      }
      if (state.useMoreInfoModal && JE.jellyseerrMoreInfo) {
        event.preventDefault();
        event.stopPropagation();
        openMoreInfo(parseInt(link.dataset.tmdbId || "", 10), link.dataset.mediaType || "");
      }
    }
    function onHideButtonClick(event, hideBtn, card, state) {
      const item = state.item;
      event.preventDefault();
      event.stopPropagation();
      if (hideBtn.classList.contains("je-already-hidden")) {
        seerr.peer("hiddenContent")?.unhideItem?.(state.jellyfinMediaId || `tmdb-${item.id}`);
        setHideButtonState(hideBtn, false, state.ctx);
        return;
      }
      seerr.peer("hiddenContent")?.confirmAndHide?.({
        itemId: state.jellyfinMediaId || "",
        name: item.title || item.name || "",
        type: item.mediaType === "tv" ? "Series" : "Movie",
        tmdbId: item.id,
        posterPath: item.posterPath || ""
      }, () => {
        card.style.display = "none";
      });
    }
    function onOverviewClick(event, state) {
      const item = state.item;
      const target = event.target;
      if (target instanceof Element && (target.closest(".jellyseerr-request-button") || target.closest(".jellyseerr-overview-link"))) return;
      event.preventDefault();
      event.stopPropagation();
      if (state.linksAvailableToJellyfin) goToJellyfinItem(state);
      else if (item.mediaType === "collection") void ui.showCollectionRequestModal?.(item.id, item.name || item.title || "", item);
      else if (state.useMoreInfoModal && JE.jellyseerrMoreInfo) openMoreInfo(item.id, item.mediaType);
    }
    const TAP_CLICK_FOLLOW_MS = 1e3;
    function onPosterClick(event, card, state) {
      if (!("ontouchstart" in window2)) {
        if (state.linksAvailableToJellyfin) {
          event.preventDefault();
          event.stopPropagation();
          goToJellyfinItem(state);
          return;
        } else if (!state.overview) {
          event.preventDefault();
          event.stopPropagation();
          createOverview(state);
          closeOverviewOnOutsideClick(card, state);
        }
      }
      if (state.linksAvailableToJellyfin) {
        event.preventDefault();
        event.stopPropagation();
        const followsTap = state.tapNavigatedAt > 0 && performance.now() - state.tapNavigatedAt < TAP_CLICK_FOLLOW_MS;
        state.tapNavigatedAt = 0;
        if (!followsTap) goToJellyfinItem(state);
      } else if (state.posterOpensModal) {
        event.preventDefault();
        event.stopPropagation();
        openMoreInfo(state.item.id, state.item.mediaType);
      }
    }
    function onCardClick(container, event) {
      const hit = cardEventTarget(container, event);
      if (!hit) return;
      const { card, state, target } = hit;
      const hideBtn = inCard(card, target, ".je-hide-btn");
      if (hideBtn instanceof HTMLButtonElement) {
        onHideButtonClick(event, hideBtn, card, state);
        return;
      }
      if (inCard(card, target, ".jellyseerr-collection-badge")) {
        const collection = state.item.collection;
        event.preventDefault();
        event.stopPropagation();
        if (collection?.id) void ui.showCollectionRequestModal?.(collection.id, collection.name || "", state.item);
        return;
      }
      if (inCard(card, target, ".jellyseerr-overview")) {
        onOverviewClick(event, state);
        return;
      }
      if (inCard(card, target, ".jellyseerr-poster-image") === state.imageContainer) onPosterClick(event, card, state);
    }
    function onCardKeydown(container, event) {
      if (event.key !== "Enter" && event.key !== " ") return;
      const hit = cardEventTarget(container, event);
      if (!hit || inCard(hit.card, hit.target, ".jellyseerr-poster-image") !== hit.state.imageContainer) return;
      const state = hit.state;
      event.preventDefault();
      if (state.linksAvailableToJellyfin) {
        goToJellyfinItem(state);
      } else if (!state.overview) {
        const overview = createOverview(state);
        if (isTvLayout()) overview.querySelector(".jellyseerr-request-button")?.focus();
      } else {
        removeOverview(state);
      }
    }
    function onCardHoverBoundary(container, event, entering) {
      const hit = cardEventTarget(container, event);
      if (!hit) return;
      const { state, target } = hit;
      const related = event.relatedTarget instanceof Node ? event.relatedTarget : null;
      const crosses = (element) => !!element && element.contains(target) && !(related && element.contains(related));
      if (crosses(state.cardScalable)) {
        if (!entering) removeOverview(state);
        else if (!state.overview && !state.linksAvailableToJellyfin) createOverview(state);
      }
      const hideButton = inCard(hit.card, target, ".je-hide-btn");
      if (crosses(hideButton) && hideButton.classList.contains("je-already-hidden")) {
        hideButton.title = (entering ? state.ctx.unhideLabel : state.ctx.hiddenLabel) ?? "";
      }
    }
    function onPosterTap(event, imageContainer) {
      const card = imageContainer.closest(".jellyseerr-card");
      const state = card instanceof HTMLElement ? cardStates.get(card) : void 0;
      if (!card || !(card instanceof HTMLElement) || !state) return;
      const target = event.target;
      if (target instanceof Element && (target.closest(".jellyseerr-overview") || target.closest(".jellyseerr-request-button"))) return;
      if (state.linksAvailableToJellyfin) {
        goToJellyfinItem(state);
        state.tapNavigatedAt = performance.now();
        return;
      }
      if (!state.overview) {
        event.preventDefault();
        createOverview(state);
        closeOverviewOnOutsideClick(card, state);
      }
    }
    function bindCardContainer(container) {
      if (boundContainers.has(container)) return;
      boundContainers.add(container);
      container.addEventListener("click", (event) => onCardClick(container, event));
      container.addEventListener("keydown", (event) => onCardKeydown(container, event));
      container.addEventListener("mouseover", (event) => onCardHoverBoundary(container, event, true));
      container.addEventListener("mouseout", (event) => onCardHoverBoundary(container, event, false));
      JE.core?.ui?.addDelegatedTouchTapListener?.(container, (el) => {
        const card = el.closest(".jellyseerr-card");
        const state = card instanceof HTMLElement && card.parentElement === container ? cardStates.get(card) : void 0;
        return state && state.imageContainer.contains(el) ? state.imageContainer : null;
      }, onPosterTap);
    }
    function bindCardContainersFrom(event) {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const card = target.closest(".jellyseerr-card");
      const container = card?.parentElement;
      if (card instanceof HTMLElement && container instanceof HTMLElement && !boundContainers.has(container) && cardStates.has(card)) {
        bindCardContainer(container);
      }
    }
    for (const type of ["mouseover", "touchstart", "focusin", "keydown", "click"]) {
      document2.addEventListener(type, bindCardContainersFrom, { capture: true, passive: true });
    }
    ui.releasePosters = releasePosters;
    ui.isInLibrary = (item) => export16(item) && getLibraryAvailability(item).isAvailable;
    ui.cardInputsKey = cardInputsKey;
    ui.createJellyseerrCard = createJellyseerrCard;
    internals.createJellyseerrCard = createJellyseerrCard;
  }

  // client/src/features/seerr/core/ui/cards-entry.ts
  installCards(seerrCoreHost());
})();
})();
//# sourceMappingURL=ui-cards.js.map
