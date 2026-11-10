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

  // client/src/features/seerr/host-details.ts
  function bridge() {
    const host = window;
    if (!host.JellyfinEnhanced) throw new Error("Seerr details loaded before Jellyfin Enhanced");
    return host.JellyfinEnhanced;
  }
  var detailsContexts = /* @__PURE__ */ new WeakMap();
  function seerrDetailsContext(JE2) {
    let ctx = detailsContexts.get(JE2);
    if (!ctx) {
      ctx = featureContext("seerr", JE2, {
        internalSlots: ["moreInfoModal"],
        internalsObject: () => JE2.internals ?? (JE2.internals = {})
      });
      detailsContexts.set(JE2, ctx);
    }
    return ctx;
  }
  function moreInfoRegistry(JE2) {
    const own = seerrDetailsContext(JE2).own;
    return own.moreInfoModal ?? (own.moreInfoModal = { state: { currentModal: null } });
  }
  function sibling(registry, key) {
    const value = registry[key];
    if (value === void 0) throw new Error(`More Info loader dependency missing: ${key}`);
    return value;
  }
  var SEERR_LOG = "🪼 Jellyfin Enhanced:";

  // client/src/features/seerr/details/domain/json.ts
  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function record(value) {
    return isRecord(value) ? value : null;
  }
  function filled(value) {
    return typeof value === "string" && value.length > 0 ? value : null;
  }
  function num(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : void 0;
  }
  function idText(value) {
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return filled(value);
  }
  function detailOf(event) {
    return event instanceof CustomEvent ? record(event.detail) : null;
  }

  // client/src/features/seerr/details/domain/media.ts
  function parseMediaType(value) {
    return value === "movie" || value === "tv" ? value : null;
  }
  function tmdbIdOf(details) {
    return num(details.id) ?? idText(details.id) ?? "";
  }
  function ownMediaInfo(details) {
    if (isRecord(details.mediaInfo)) return details.mediaInfo;
    const info = {};
    details.mediaInfo = info;
    return info;
  }
  var CLIENT_FIELDS = /* @__PURE__ */ new Set(["ratings"]);
  function replaceDetails(details, fresh) {
    for (const key of Object.keys(details)) {
      if (!CLIENT_FIELDS.has(key) && !(key in fresh)) delete details[key];
    }
    Object.assign(details, fresh);
  }

  // client/src/features/seerr/details/moreinfo/scope.ts
  function createModalScope() {
    const controller = new AbortController();
    const disposers = /* @__PURE__ */ new Set();
    return {
      signal: controller.signal,
      requests: 0,
      onDispose(callback) {
        if (controller.signal.aborted) callback();
        else disposers.add(callback);
      },
      dispose() {
        controller.abort();
        for (const dispose of [...disposers]) dispose();
        disposers.clear();
      }
    };
  }
  function isLive(state2, modal) {
    return modal !== null && state2.currentModal === modal && modal._isClosing !== true;
  }

  // client/src/features/seerr/details/moreinfo/init-entry.ts
  var JE = bridge();
  var internal = moreInfoRegistry(JE);
  var { state } = internal;
  var logPrefix = `${SEERR_LOG} Jellyseerr More Info:`;
  var moreInfoModal = JE.jellyseerrMoreInfo ?? (JE.jellyseerrMoreInfo = {});
  var FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
  var DIALOG_OPEN_CLASS = "jellyseerr-modal-is-open";
  var EXIT_MS = 300;
  var LOAD_FAILED = "Failed to load media information";
  var openGeneration = 0;
  var historyEntryActive = false;
  var popPending = false;
  var HISTORY_KEY = "jeMoreInfo";
  var historyToken = "";
  var dialogOpen = () => document.body.classList.contains(DIALOG_OPEN_CLASS);
  var keyOf = (event) => "key" in event ? event.key : void 0;
  async function open(tmdbId, rawType) {
    const generation = ++openGeneration;
    const mediaType = parseMediaType(rawType);
    if (!mediaType) {
      console.warn(`${logPrefix} Unknown media type ${rawType} for TMDB ID ${tmdbId}`);
      sibling(internal, "showError")(LOAD_FAILED);
      return;
    }
    try {
      const data = await sibling(internal, "fetchMediaDetails")(tmdbId, mediaType);
      if (generation !== openGeneration) return;
      if (!isRecord(data)) {
        sibling(internal, "showError")(LOAD_FAILED);
        return;
      }
      const modal = showModal(data, mediaType);
      if (mediaType === "tv" && Array.isArray(data.seasons) && data.seasons.some((season) => isRecord(season) && Number(season.episodeCount) > 0 && (!season.airDate || !season.posterPath))) {
        void sibling(internal, "backfillSeasonMetadata")(tmdbId, data);
      }
      sibling(internal, "fetchRatings")(tmdbId, mediaType, data, modal._scope?.signal).then((ratings) => {
        if (!isLive(state, modal)) return;
        if (String(modal.dataset.tmdbId) !== String(data.id) || modal.dataset.mediaType !== mediaType) return;
        data.ratings = ratings;
        const mount = modal.querySelector('[data-mount="ratings"]');
        if (mount) mount.innerHTML = sibling(internal, "buildRatingLogos")(ratings, data, mediaType, tmdbId) || "";
        const facts = modal.querySelector(".je-more-info-media-facts");
        if (facts && ratings && internal.buildMediaFacts) facts.outerHTML = internal.buildMediaFacts(data, mediaType, tmdbId);
      }).catch((error) => console.error(`${logPrefix} Failed to fetch ratings for TMDB ID ${tmdbId}:`, error));
    } catch (error) {
      if (generation !== openGeneration) return;
      console.error("Error opening more info modal:", error);
      sibling(internal, "showError")(LOAD_FAILED);
    }
  }
  async function refreshModalData(data, mediaType, modal, button) {
    if (!isLive(state, modal)) return;
    const idle = () => {
      button.classList.remove("loading");
      button.disabled = false;
    };
    try {
      button.classList.add("loading");
      button.disabled = true;
      const fresh = await sibling(internal, "fetchMediaDetails")(tmdbIdOf(data), mediaType);
      if (!isLive(state, modal)) return;
      if (!isRecord(fresh)) {
        sibling(internal, "showError")("Failed to refresh media information");
        idle();
        return;
      }
      replaceDetails(data, fresh);
      sibling(internal, "renderActions")(data, mediaType, modal);
      if (mediaType === "tv") void sibling(internal, "enrichSeasonCardsWithJellyfinLinks")(data, modal, { refresh: true });
      idle();
    } catch (error) {
      if (!isLive(state, modal)) return;
      console.error("Error refreshing modal data:", error);
      sibling(internal, "showError")("Failed to refresh modal data");
      idle();
    }
  }
  function refreshAfterRequest(data, mediaType, modal) {
    const markRequested = () => {
      const info = ownMediaInfo(data);
      info.status = info.status || 2;
    };
    return async (event) => {
      const detail = detailOf(event);
      if (!detail?.tmdbId || String(detail.tmdbId) !== String(data.id)) return;
      if (mediaType === "movie" && (detail.mediaType !== "movie" || (modal._scope?.requests ?? 0) > 0)) return;
      try {
        const fresh = await sibling(internal, "fetchMediaDetails")(tmdbIdOf(data), mediaType);
        if (!isLive(state, modal)) return;
        if (isRecord(fresh) && fresh.mediaInfo) data.mediaInfo = fresh.mediaInfo;
        else markRequested();
      } catch {
        if (!isLive(state, modal)) return;
        markRequested();
      }
      sibling(internal, "renderActions")(data, mediaType, modal);
      if (mediaType === "tv") void sibling(internal, "enrichSeasonCardsWithJellyfinLinks")(data, modal);
    };
  }
  function wireButtons(modal, data, mediaType) {
    modal.addEventListener("click", (event) => {
      if (event.target === modal || event.target instanceof Element && event.target.classList.contains("modal-overlay")) dismissModal();
    });
    const silent = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    const refreshButton = modal.querySelector(".modal-refresh");
    refreshButton?.addEventListener("click", (event) => {
      silent(event);
      void refreshModalData(data, mediaType, modal, refreshButton);
    });
    modal.querySelector(".modal-close")?.addEventListener("click", (event) => {
      silent(event);
      dismissModal();
    });
    const collectionButton = modal.querySelector(".je-collection-card-button");
    collectionButton?.addEventListener("click", (event) => {
      silent(event);
      if (!isLive(state, modal)) return;
      const id = parseInt(collectionButton.dataset.collectionId ?? "", 10);
      const name = collectionButton.dataset.collectionName;
      if (id && name) JE.jellyseerrUI?.showCollectionRequestModal?.(id, name);
    });
  }
  function listen(scope, type, listener, capture = false) {
    document.addEventListener(type, listener, capture);
    scope.onDispose(() => document.removeEventListener(type, listener, capture));
  }
  function showModal(data, mediaType) {
    closeCurrentModal();
    const modal = document.createElement("div");
    const scope = createModalScope();
    modal._scope = scope;
    modal.className = "je-more-info-modal";
    modal.innerHTML = sibling(internal, "buildModalContent")(data, mediaType);
    modal.dataset.tmdbId = String(data.id ?? "");
    modal.dataset.mediaType = mediaType;
    wireButtons(modal, data, mediaType);
    document.body.appendChild(modal);
    state.currentModal = modal;
    if (!historyEntryActive) {
      historyToken = `${Date.now()}:${openGeneration}`;
      history.pushState({ [HISTORY_KEY]: historyToken }, "", location.href);
      historyEntryActive = true;
    }
    listen(scope, "keydown", (event) => {
      if (keyOf(event) === "Escape" && !dialogOpen()) dismissModal();
    });
    listen(scope, "keydown", (event) => trapDirectionalFocus(event, modal), true);
    sibling(internal, "renderActions")(data, mediaType, modal);
    if (mediaType === "tv") void sibling(internal, "enrichSeasonCardsWithJellyfinLinks")(data, modal);
    const onRequested = refreshAfterRequest(data, mediaType, modal);
    listen(scope, mediaType === "tv" ? "jellyseerr-tv-requested" : "jellyseerr-media-requested", (event) => {
      void onRequested(event);
    });
    setTimeout(() => {
      if (isLive(state, modal)) modal.classList.add("active");
    }, 10);
    if (JE.core?.ui?.isTvLayout?.()) {
      setTimeout(() => {
        if (!isLive(state, modal)) return;
        const first = modal.querySelector(".je-more-info-actions button:not([disabled])") ?? modal.querySelector(".modal-close");
        first?.focus();
      }, 60);
    }
    return modal;
  }
  function dismissModal() {
    if (!historyEntryActive) {
      close();
      return;
    }
    if (popPending) return;
    popPending = true;
    history.back();
  }
  var DIRECTIONS = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
  function trapDirectionalFocus(event, modal) {
    const key = keyOf(event);
    const direction = typeof key === "string" ? DIRECTIONS[key] : void 0;
    if (!direction || !isLive(state, modal)) return;
    if (dialogOpen()) return;
    const active = document.activeElement;
    if (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) return;
    event.preventDefault();
    event.stopPropagation();
    const items = Array.from(modal.querySelectorAll(FOCUSABLE)).filter((element) => element.getClientRects().length > 0);
    if (!items.length) return;
    if (!active || !modal.contains(active)) {
      items[0]?.focus();
      return;
    }
    const from = active.getBoundingClientRect();
    const fromX = from.left + from.width / 2;
    const fromY = from.top + from.height / 2;
    let best = null;
    let bestScore = Infinity;
    for (const element of items) {
      if (element === active) continue;
      const rect = element.getBoundingClientRect();
      const dx = rect.left + rect.width / 2 - fromX;
      const dy = rect.top + rect.height / 2 - fromY;
      const along = direction === "up" ? -dy : direction === "down" ? dy : direction === "left" ? -dx : dx;
      if (along <= 1) continue;
      const across = direction === "up" || direction === "down" ? Math.abs(dx) : Math.abs(dy);
      const score = along + across * 2;
      if (score < bestScore) {
        bestScore = score;
        best = element;
      }
    }
    best?.focus();
  }
  function closeCurrentModal() {
    const closing = state.currentModal;
    if (!closing || closing._isClosing) return;
    closing._isClosing = true;
    closing._scope?.dispose();
    closing.classList.remove("active");
    setTimeout(() => {
      closing.remove();
      if (state.currentModal === closing) state.currentModal = null;
      document.dispatchEvent(new CustomEvent("jellyseerr-more-info-closed"));
    }, EXIT_MS);
  }
  function close() {
    openGeneration++;
    historyEntryActive = false;
    popPending = false;
    closeCurrentModal();
  }
  moreInfoModal.open = open;
  moreInfoModal.close = close;
  window.addEventListener("popstate", (event) => {
    if (!historyEntryActive) return;
    if (dialogOpen()) return;
    const landed = event.state;
    if (isRecord(landed) && landed[HISTORY_KEY] === historyToken) return;
    close();
  });
  JE.session?.onUserChange?.("jellyseerr-more-info", close);
  document.addEventListener("viewshow", close);
  if (internal.checkForUnrequestedSeasons) moreInfoModal.checkForUnrequestedSeasons = internal.checkForUnrequestedSeasons;
})();
})();
//# sourceMappingURL=more-info-modal-init.js.map
