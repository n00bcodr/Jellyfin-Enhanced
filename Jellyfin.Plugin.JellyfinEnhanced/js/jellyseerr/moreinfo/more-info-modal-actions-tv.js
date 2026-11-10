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
  function detachedContext() {
    return { live: () => true, current: () => true, signal: new AbortController().signal, onDispose() {
    }, scope: null, modal: null };
  }

  // client/src/features/seerr/details/moreinfo/actions-tv-entry.ts
  var JE = bridge();
  var internal = moreInfoRegistry(JE);
  var t = translator(JE);
  var escapeHtml = escaper(JE);
  var DOWNLOAD_ICON = '<span class="material-icons">download</span>';
  var requestIcon = () => JE.jellyseerrUI?.icons?.request || DOWNLOAD_ICON;
  function openSeasonPicker(details, context, is4k) {
    if (!context.current()) return;
    const media = record(details) ?? {};
    const show = JE.jellyseerrUI?.showSeasonSelectionModal;
    if (!show) return;
    const id = tmdbIdOf(media);
    if (is4k === void 0) show(id, "tv", anyTitle(media), details);
    else show(id, "tv", anyTitle(media), details, is4k);
  }
  function plainButton(labelText, details, context, is4k) {
    const button = document.createElement("button");
    button.className = "jellyseerr-request-button jellyseerr-button-request";
    button.innerHTML = `${requestIcon()}<span>${escapeHtml(labelText)}</span>`;
    button.addEventListener("click", (event) => {
      silent(event);
      openSeasonPicker(details, context, is4k);
    });
    return button;
  }
  function row() {
    const container = document.createElement("div");
    container.className = "je-more-info-actions-row";
    return container;
  }
  function buildTvActions(details, show4k = false, context = detachedContext()) {
    const media = record(details) ?? {};
    const state = mediaState(media);
    const seerrStatus = JE.seerrStatus;
    if (!seerrStatus?.isRequestable(seerrStatus.effectiveMediaStatus(state.status, state.jellyfinId))) return null;
    const container = row();
    const requestLabel = t("jellyseerr_btn_request");
    if (!show4k) {
      container.appendChild(plainButton(requestLabel, details, context));
      return container;
    }
    const { group, main, arrow } = splitButton(escapeHtml(requestLabel), requestIcon(), idText(media.id) ?? "", "tv", t("jellyseerr_btn_request_4k", "Request in 4K"));
    main.addEventListener("click", (event) => {
      silent(event);
      openSeasonPicker(details, context, false);
    });
    attachFourKPopup(arrow, context, (option, close) => {
      const display = seerrStatus.resolveDisplayStatus(state.status4k, false);
      const { AVAILABLE, PENDING, PROCESSING, REQUESTED, BLOCKED } = seerrStatus.DISPLAY;
      if (display === AVAILABLE) {
        option.textContent = `4K ${t("jellyseerr_btn_available", "Available")}`;
        option.disabled = true;
        option.classList.add("je-4k-available");
      } else if (display === PENDING || display === REQUESTED || display === PROCESSING) {
        option.textContent = `4K ${t("jellyseerr_btn_requested", "Requested")}`;
        option.disabled = true;
        option.classList.add(display === PROCESSING ? "je-4k-processing" : "je-4k-pending");
      } else if (display === BLOCKED) {
        option.textContent = `4K ${t("jellyseerr_btn_blocklisted", "Blocklisted")}`;
        option.disabled = true;
        option.classList.add("je-4k-blocklisted");
      } else {
        option.textContent = t("jellyseerr_btn_request_4k", "Request in 4K");
        option.classList.add("je-4k-request");
        option.addEventListener("click", (event) => {
          silent(event);
          close();
          openSeasonPicker(details, context, true);
        });
      }
    });
    container.appendChild(group);
    return container;
  }
  function buildSingleTv4kButton(details, context = detachedContext()) {
    return plainButton(t("jellyseerr_btn_request_4k", "Request in 4K"), details, context, true);
  }
  function buildTvRequestMoreButton(details, show4k = false, canRequest4k = false, context = detachedContext()) {
    const container = row();
    const labelText = t("jellyseerr_btn_request_more", "Request More");
    if (!show4k) {
      container.appendChild(plainButton(labelText, details, context));
      return container;
    }
    const { group, main, arrow } = splitButton(escapeHtml(labelText), requestIcon(), idText(record(details)?.id) ?? "", "tv", t("jellyseerr_btn_request_4k", "Request in 4K"), false);
    main.addEventListener("click", (event) => {
      silent(event);
      openSeasonPicker(details, context, false);
    });
    attachFourKPopup(arrow, context, (option, close) => {
      option.textContent = t("jellyseerr_btn_request_4k", "Request in 4K");
      if (!canRequest4k) {
        option.disabled = true;
        option.textContent = `4K ${t("jellyseerr_btn_requested", "Requested")}`;
        option.classList.add("je-4k-pending");
        return;
      }
      option.classList.add("je-4k-request");
      option.addEventListener("click", (event) => {
        silent(event);
        close();
        openSeasonPicker(details, context, true);
      });
    });
    container.appendChild(group);
    return container;
  }
  internal.buildTvActions = buildTvActions;
  internal.buildSingleTv4kButton = buildSingleTv4kButton;
  internal.buildTvRequestMoreButton = buildTvRequestMoreButton;
})();
})();
//# sourceMappingURL=more-info-modal-actions-tv.js.map
