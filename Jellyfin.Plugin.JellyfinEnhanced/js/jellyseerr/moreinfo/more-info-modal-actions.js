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
  function translator(JE2) {
    return (key, fallback = "", params) => {
      const text = params ? JE2.t?.(key, params) : JE2.t?.(key);
      return text || fallback;
    };
  }
  function escaper(JE2) {
    return (value) => {
      if (JE2.escapeHtml) return JE2.escapeHtml(value);
      return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
    };
  }
  function identityLease(JE2) {
    const epoch = JE2.session?.getEpoch?.();
    return () => epoch === void 0 || typeof JE2.session?.isCurrent !== "function" || JE2.session.isCurrent(epoch);
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
  function list(value) {
    return Array.isArray(value) ? value : [];
  }
  function records(value) {
    return list(value).filter(isRecord);
  }
  function idText(value) {
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return filled(value);
  }

  // client/src/features/seerr/details/domain/media.ts
  function tmdbIdOf(details) {
    return num(details.id) ?? idText(details.id) ?? "";
  }
  function anyTitle(details) {
    return filled(details.title) ?? filled(details.name) ?? "";
  }
  function mediaState(details) {
    const info = record(details.mediaInfo) ?? {};
    return {
      status: num(info.status) ?? 1,
      status4k: num(info.status4k) ?? 1,
      downloads: Array.isArray(info.downloadStatus) ? info.downloadStatus : [],
      downloads4k: Array.isArray(info.downloadStatus4k) ? info.downloadStatus4k : [],
      jellyfinId: filled(info.jellyfinMediaId),
      jellyfinId4k: filled(info.jellyfinMediaId4k)
    };
  }
  function ownMediaInfo(details) {
    if (isRecord(details.mediaInfo)) return details.mediaInfo;
    const info = {};
    details.mediaInfo = info;
    return info;
  }
  function requesters(info) {
    const seen = /* @__PURE__ */ new Set();
    const entries = [];
    for (const request of records(record(info)?.requests)) {
      const user = record(request.requestedBy);
      const name = filled(user?.displayName) ?? filled(user?.username);
      if (!name) continue;
      const label = request.is4k ? `${name} (4K)` : name;
      if (seen.has(label)) continue;
      seen.add(label);
      entries.push({ label, avatar: filled(user?.avatar) });
    }
    return entries;
  }

  // client/src/features/seerr/details/moreinfo/four-k-popup.ts
  var SPLIT_ARROW_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M12.53 16.28a.75.75 0 01-1.06 0l-7.5-7.5a.75.75 0 011.06-1.06L12 14.69l6.97-6.97a.75.75 0 111.06 1.06l-7.5 7.5z" clip-rule="evenodd" /></svg>';
  function silent(event) {
    event.preventDefault();
    event.stopPropagation();
  }
  function attachFourKPopup(arrow, context, fill) {
    let menu = null;
    const close = () => {
      if (!menu) return;
      menu.remove();
      menu = null;
      document.removeEventListener("click", onDocumentClick, true);
    };
    const onDocumentClick = (event) => {
      if (!menu || !(event.target instanceof Node)) return;
      if (!menu.contains(event.target) && !arrow.contains(event.target)) close();
    };
    context.onDispose(close);
    arrow.addEventListener("click", (event) => {
      silent(event);
      if (!context.current()) return;
      if (menu) {
        close();
        return;
      }
      const opened = document.createElement("div");
      opened.className = "je-4k-popup";
      const option = document.createElement("button");
      option.className = "je-4k-popup-item";
      fill(option, close);
      opened.appendChild(option);
      document.body.appendChild(opened);
      const rect = arrow.getBoundingClientRect();
      opened.style.position = "fixed";
      opened.style.left = `${rect.left}px`;
      opened.style.top = `${rect.bottom + 6}px`;
      requestAnimationFrame(() => {
        if (menu === opened) opened.classList.add("show");
      });
      menu = opened;
      document.addEventListener("click", onDocumentClick, true);
    });
  }
  function splitButton(label, icon, tmdbId, mediaType, arrowTitle, marked = true) {
    const group = document.createElement("div");
    group.className = "jellyseerr-button-group je-more-info-button-group";
    const main = document.createElement("button");
    main.className = "jellyseerr-request-button jellyseerr-split-main jellyseerr-button-request";
    main.innerHTML = `${icon}<span>${label}</span>`;
    main.dataset.tmdbId = tmdbId;
    main.dataset.mediaType = mediaType;
    const arrow = document.createElement("button");
    arrow.className = "jellyseerr-split-arrow";
    arrow.innerHTML = SPLIT_ARROW_SVG;
    arrow.title = arrowTitle;
    if (marked) {
      arrow.dataset.tmdbId = tmdbId;
      arrow.dataset.toggle4k = "true";
    }
    group.appendChild(main);
    group.appendChild(arrow);
    return { group, main, arrow };
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
  function detachedContext() {
    return { live: () => true, current: () => true, signal: new AbortController().signal, onDispose() {
    }, scope: null, modal: null };
  }

  // client/src/features/seerr/details/moreinfo/actions-entry.ts
  var JE = bridge();
  var internal = moreInfoRegistry(JE);
  var { state } = internal;
  var logPrefix = `${SEERR_LOG} Jellyseerr More Info:`;
  var escapeHtml = escaper(JE);
  var t = translator(JE);
  var DOWNLOAD_ICON = '<span class="material-icons">download</span>';
  var requestIcon = () => JE.jellyseerrUI?.icons?.request || DOWNLOAD_ICON;
  var FOUR_K_LABEL = "Request in 4K";
  function errorMessage(error) {
    const message = record(record(error)?.responseJSON)?.message;
    return typeof message === "string" && message ? message : t("jellyseerr_btn_error");
  }
  async function requestMovie(details, is4k, context, view) {
    const api = JE.jellyseerrAPI;
    if (!context.current() || !api) return;
    const id = tmdbIdOf(details);
    if (api.shouldShowAdvanced()) {
      JE.jellyseerrUI?.showMovieRequestModal?.(id, anyTitle(details), details, is4k);
      return;
    }
    view.busy();
    const sameAccount = identityLease(JE);
    const scope = context.scope;
    if (scope) scope.requests++;
    try {
      const response = await api.requestMedia(id, "movie", {}, is4k, details);
      if (!sameAccount()) return;
      mountRequestedChip(details, "movie", is4k, response, context);
      view.done?.();
    } catch (error) {
      if (!sameAccount()) return;
      if (JE.jellyseerrUI?.isQuotaError?.(error)) {
        await JE.jellyseerrUI.showQuotaErrorDialog?.(error, "movie");
        if (context.current()) view.idle();
        return;
      }
      if (context.current()) view.failed(errorMessage(error));
    } finally {
      if (scope) scope.requests--;
    }
  }
  function requestButtonView(button, idleHtml, failureSuffix) {
    return {
      busy() {
        button.disabled = true;
        button.innerHTML = `<span>${escapeHtml(t("jellyseerr_btn_requesting"))}</span><span class="jellyseerr-button-spinner"></span>`;
      },
      idle() {
        button.disabled = false;
        button.innerHTML = idleHtml();
      },
      failed(message) {
        button.disabled = false;
        button.innerHTML = `<span>${escapeHtml(message)}</span>${failureSuffix()}`;
        button.classList.add("jellyseerr-button-error");
      }
    };
  }
  function movieRequestButton(details, label, is4k, context, failureSuffix, existing) {
    const button = existing ?? document.createElement("button");
    const idleHtml = () => `${requestIcon()}<span>${escapeHtml(label)}</span>`;
    if (!existing) {
      button.className = "jellyseerr-request-button jellyseerr-button-request";
      button.innerHTML = idleHtml();
    }
    button.addEventListener("click", (event) => {
      silent(event);
      void requestMovie(details, is4k, context, requestButtonView(button, idleHtml, failureSuffix));
    });
    return button;
  }
  function buildSingle4kButton(rawDetails, context = detachedContext()) {
    return movieRequestButton(record(rawDetails) ?? {}, t("jellyseerr_btn_request_4k", FOUR_K_LABEL), true, context, () => "");
  }
  function fillMovie4kOption(option, details, status4k, context, close) {
    const seerrStatus = JE.seerrStatus;
    if (!seerrStatus) return;
    const display = seerrStatus.resolveDisplayStatus(status4k, false);
    const { AVAILABLE, PENDING, PROCESSING, REQUESTED, BLOCKED } = seerrStatus.DISPLAY;
    option.textContent = FOUR_K_LABEL;
    if (display === AVAILABLE) {
      option.disabled = true;
      option.classList.add("je-4k-available");
    } else if (display === PENDING || display === REQUESTED || display === PROCESSING) {
      option.disabled = true;
      option.classList.add(display === PROCESSING ? "je-4k-processing" : "je-4k-pending");
    } else if (display === BLOCKED) {
      option.disabled = true;
      option.classList.add("je-4k-blocklisted");
    } else {
      option.classList.add("je-4k-request");
      const view = {
        busy() {
          option.disabled = true;
          option.textContent = t("jellyseerr_btn_requesting");
        },
        idle() {
          option.disabled = false;
          option.textContent = FOUR_K_LABEL;
        },
        failed(message) {
          option.disabled = false;
          option.textContent = message;
        },
        done: close
      };
      option.addEventListener("click", (event) => {
        silent(event);
        if (JE.jellyseerrAPI?.shouldShowAdvanced()) close();
        void requestMovie(details, true, context, view);
      });
    }
  }
  function buildMovieActions(rawDetails, _actionMount, _chipMount, show4k, context = detachedContext()) {
    const details = record(rawDetails) ?? {};
    const media = mediaState(details);
    const seerrStatus = JE.seerrStatus;
    if (!seerrStatus?.isRequestable(seerrStatus.effectiveMediaStatus(media.status, media.jellyfinId))) return null;
    const container = document.createElement("div");
    container.className = "je-more-info-actions-row";
    const failureIcon = () => JE.jellyseerrUI?.icons?.error ?? "";
    const label = t("jellyseerr_btn_request");
    if (!show4k) {
      container.appendChild(movieRequestButton(details, label, false, context, failureIcon));
      return container;
    }
    const { group, main, arrow } = splitButton(escapeHtml(label), requestIcon(), idText(details.id) ?? "", "movie", FOUR_K_LABEL);
    movieRequestButton(details, label, false, context, failureIcon, main);
    attachFourKPopup(arrow, context, (option, close) => fillMovie4kOption(option, details, media.status4k, context, close));
    container.appendChild(group);
    return container;
  }
  function mountRequestedChip(rawDetails, mediaType, is4k, response = null, context = detachedContext()) {
    const details = record(rawDetails);
    if (!details) return;
    const info = ownMediaInfo(details);
    const media = record(record(response)?.media);
    if (is4k) info.status4k = num(media?.status4k) || 3;
    else info.status = num(media?.status) || 3;
    document.dispatchEvent(new CustomEvent("jellyseerr-media-requested", { detail: { tmdbId: details.id, mediaType, is4k: !!is4k } }));
    if (context.live()) renderActions(details, mediaType, context.modal ?? void 0);
  }
  var quotaRenderToken = 0;
  async function maybeRenderMoreInfoQuotaChip(mount, mediaType, context = detachedContext()) {
    if (!mount) return;
    const token = String(++quotaRenderToken);
    mount.dataset.quotaRenderToken = token;
    try {
      const quota = await JE.jellyseerrAPI?.fetchUserQuota?.();
      if (!mount.isConnected || !context.current() || mount.dataset.quotaRenderToken !== token) return;
      const chip = JE.jellyseerrUI?.buildQuotaChip?.(quota, mediaType === "tv" ? "tv" : "movie");
      if (chip instanceof Element) {
        chip.classList.add("je-more-info-quota-chip");
        mount.insertBefore(chip, mount.firstChild);
      }
    } catch (error) {
      console.warn(`${logPrefix} quota chip render failed:`, error);
    }
  }
  function requesterAvatar(avatar) {
    if (!avatar) return null;
    return avatar.startsWith("/") ? `/JellyfinEnhanced/proxy/avatar?path=${encodeURIComponent(avatar)}` : avatar;
  }
  function renderRequestedBy(mount, info) {
    if (!mount) return;
    const entries = requesters(info);
    if (entries.length === 0) return;
    const wrapper = document.createElement("div");
    wrapper.className = "je-requested-by-row";
    const label = document.createElement("span");
    label.className = "je-requested-by-label";
    label.textContent = t("jellyseerr_modal_requested_by", "Requested by");
    wrapper.appendChild(label);
    for (const entry of entries) {
      const item = document.createElement("span");
      item.className = "je-requested-by-item";
      const source = requesterAvatar(entry.avatar);
      if (source) {
        const image = document.createElement("img");
        image.className = "je-request-avatar";
        image.setAttribute("data-avatar-src", source);
        image.alt = "";
        image.loading = "lazy";
        image.style.display = "none";
        image.addEventListener("error", () => {
          image.style.display = "none";
        });
        item.appendChild(image);
      }
      const name = document.createElement("span");
      name.className = "je-requested-by-name";
      name.textContent = entry.label;
      item.appendChild(name);
      wrapper.appendChild(item);
    }
    mount.appendChild(wrapper);
    JE.helpers?.hydrateAvatarImages?.(mount);
  }
  function renderChips(mount, media, isMovie) {
    const seerrStatus = JE.seerrStatus;
    if (!mount || !seerrStatus) return;
    const chip = (is4k) => sibling(internal, "buildStatusChip")(media.status, media.status4k, isMovie, media.downloads, media.downloads4k, media.jellyfinId, media.jellyfinId4k, is4k);
    const normal = seerrStatus.hasStatus(media.status);
    if (normal) mount.appendChild(chip(false));
    if (seerrStatus.hasStatus(media.status4k)) {
      const chip4k = chip(true);
      if (normal) chip4k.style.marginLeft = "0.5em";
      mount.appendChild(chip4k);
    }
  }
  var renders = /* @__PURE__ */ new WeakMap();
  function beginRender(modal) {
    const previous = renders.get(modal);
    previous?.dispose();
    const render = createModalScope();
    renders.set(modal, render);
    const scope = modal._scope ?? null;
    if (!previous) scope?.onDispose(() => renders.get(modal)?.dispose());
    const sameAccount = identityLease(JE);
    const live = () => isLive(state, modal) && sameAccount();
    return {
      live,
      current: () => live() && !render.signal.aborted,
      signal: render.signal,
      onDispose: render.onDispose,
      scope,
      modal
    };
  }
  function renderMovieActions(details, media, mount, context) {
    const seerrStatus = JE.seerrStatus;
    if (!seerrStatus) return;
    const show4k = !!JE.pluginConfig?.JellyseerrEnable4KRequests;
    const canRequest = seerrStatus.isRequestable(seerrStatus.effectiveMediaStatus(media.status, media.jellyfinId));
    const canRequest4k = seerrStatus.isRequestable(seerrStatus.effectiveMediaStatus(media.status4k, media.jellyfinId4k));
    if (!canRequest) {
      if (show4k && canRequest4k && mount) {
        mount.appendChild(buildSingle4kButton(details, context));
        void maybeRenderMoreInfoQuotaChip(mount, "movie", context);
      }
      return;
    }
    const actions = buildMovieActions(details, mount, null, show4k, context);
    if (actions && mount) mount.appendChild(actions);
    void maybeRenderMoreInfoQuotaChip(mount, "movie", context);
  }
  function renderTvActions(details, media, mount, context) {
    const seerrStatus = JE.seerrStatus;
    if (!seerrStatus) return;
    const show4k = !!JE.pluginConfig?.JellyseerrEnable4KTvRequests;
    const effective = seerrStatus.effectiveMediaStatus(media.status, media.jellyfinId);
    const effective4k = seerrStatus.effectiveMediaStatus(media.status4k, media.jellyfinId4k);
    const canRequest4k = seerrStatus.isRequestable(effective4k);
    const append = (actions) => {
      if (actions && mount) mount.appendChild(actions);
      void maybeRenderMoreInfoQuotaChip(mount, "tv", context);
    };
    if (seerrStatus.isRequestable(effective)) {
      append(sibling(internal, "buildTvActions")(details, show4k, context));
      return;
    }
    if (!seerrStatus.hasStatus(media.status) && !seerrStatus.hasStatus(media.status4k)) {
      append(sibling(internal, "buildTvActions")(details, false, context));
      return;
    }
    const deleted = seerrStatus.MEDIA.DELETED;
    if ((effective === deleted || effective4k === deleted) && mount) {
      append(sibling(internal, "buildTvRequestMoreButton")(details, show4k, canRequest4k, context));
      return;
    }
    void sibling(internal, "checkForUnrequestedSeasons")(details, context.signal).then((unrequested) => {
      if (!context.current() || !mount) return;
      if (unrequested) append(sibling(internal, "buildTvRequestMoreButton")(details, show4k, canRequest4k, context));
      else if (show4k && canRequest4k) append(sibling(internal, "buildSingleTv4kButton")(details, context));
    });
  }
  function renderActions(rawDetails, mediaType, modal = state.currentModal) {
    if (!isLive(state, modal) || !modal || !isRecord(rawDetails)) return;
    const mountOf = (name) => modal.querySelector(`[data-mount="${name}"]`);
    const actions = mountOf("je-actions");
    const chips = mountOf("je-status-chip");
    const downloads = mountOf("je-downloads");
    const secondary = mountOf("je-secondary-actions");
    const requestedBy = mountOf("je-requested-by");
    for (const mount of [actions, chips, downloads, secondary, requestedBy]) if (mount) mount.innerHTML = "";
    const context = beginRender(modal);
    renderRequestedBy(requestedBy, rawDetails.mediaInfo);
    seerrDetailsContext(JE).peer("spoilerBlur")?.appendSeerrToggle?.(secondary, rawDetails, mediaType);
    const media = mediaState(rawDetails);
    renderChips(chips, media, mediaType === "movie");
    const bars = sibling(internal, "buildDownloadBars")(media.downloads, media.downloads4k);
    if (bars && downloads) downloads.appendChild(bars);
    if (mediaType === "movie") renderMovieActions(rawDetails, media, actions, context);
    else renderTvActions(rawDetails, media, actions, context);
  }
  internal.buildSingle4kButton = buildSingle4kButton;
  internal.buildMovieActions = buildMovieActions;
  internal.mountRequestedChip = mountRequestedChip;
  internal.maybeRenderMoreInfoQuotaChip = maybeRenderMoreInfoQuotaChip;
  internal.renderActions = renderActions;
})();
})();
//# sourceMappingURL=more-info-modal-actions.js.map
