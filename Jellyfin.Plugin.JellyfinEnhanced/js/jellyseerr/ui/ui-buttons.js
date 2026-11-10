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
  var export18 = /* @__PURE__ */ sharedExport(shared, "isNumber");
  var export19 = /* @__PURE__ */ sharedExport(shared, "isRecord");
  var export22 = /* @__PURE__ */ sharedExport(shared, "isString");

  // client/generated-shared/stub/client/src/features/seerr/core/display.ts
  var shared2 = /* @__PURE__ */ sharedModule("features/seerr/core/display");
  var export0 = /* @__PURE__ */ sharedExport(shared2, "analyzeSeasonStatuses");
  var export5 = /* @__PURE__ */ sharedExport(shared2, "hasDownloads");

  // client/generated-shared/stub/client/src/features/seerr/core/status.ts
  var shared3 = /* @__PURE__ */ sharedModule("features/seerr/core/status");
  var export02 = /* @__PURE__ */ sharedExport(shared3, "DISPLAY");
  var export1 = /* @__PURE__ */ sharedExport(shared3, "MEDIA");
  var export6 = /* @__PURE__ */ sharedExport(shared3, "getButtonConfig");
  var export11 = /* @__PURE__ */ sharedExport(shared3, "resolveDisplayStatus");

  // client/src/features/seerr/core/runtime.ts
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
  function translated(JE, key, fallback, params) {
    const text2 = params ? JE.t(key, params) : JE.t(key);
    return text2 && text2 !== key ? text2 : fallback;
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
  function thrownProperty(error, key) {
    if (typeof error !== "object" || error === null) return void 0;
    const value = Reflect.get(error, key);
    return value;
  }
  function errorStatus(error) {
    const status = thrownProperty(error, "status");
    return export18(status) ? status : null;
  }
  function errorBody(error) {
    const body = thrownProperty(error, "responseJSON");
    if (!export19(body)) return { message: null, code: null, requestOutcome: null };
    return {
      message: export22(body.message) && body.message ? body.message : null,
      code: export22(body.code) && body.code ? body.code : null,
      requestOutcome: body.requestOutcome === "unknown" || body.requestOutcome === "rejected" || body.requestOutcome === "not_sent" ? body.requestOutcome : null
    };
  }
  var RequestNotSentError = class extends Error {
    constructor(reason, detail) {
      super(detail);
      this.reason = reason;
      this.name = "SeerrRequestNotSent";
    }
  };
  function classifyFailure(error, quotaEnabled) {
    if (error instanceof RequestNotSentError || error instanceof Error && error.name === "SeerrRequestNotSent") return "not-sent";
    const status = errorStatus(error);
    const { message, requestOutcome } = errorBody(error);
    if (requestOutcome === "unknown") return "uncertain";
    if (requestOutcome === "not_sent") return "not-sent";
    if (status === null || status >= 500 && requestOutcome !== "rejected") return "uncertain";
    if (status === 403 && quotaEnabled && /quota\s+exceeded/i.test(message || "")) return "quota";
    if (status === 404) return "user-not-found";
    if (status === 403) return "permission";
    return "rejected";
  }
  function uncertainMessage(JE) {
    return translated(JE, "jellyseerr_request_outcome_unknown", "Request status unknown. Check Seerr before requesting again.");
  }

  // client/generated-shared/stub/client/src/features/seerr/core/ui/icon-markup.ts
  var shared4 = /* @__PURE__ */ sharedModule("features/seerr/core/ui/icon-markup");
  var export03 = /* @__PURE__ */ sharedExport(shared4, "ICONS");

  // client/src/features/seerr/core/ui/buttons.ts
  var ARROW_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M12.53 16.28a.75.75 0 01-1.06 0l-7.5-7.5a.75.75 0 011.06-1.06L12 14.69l6.97-6.97a.75.75 0 111.06 1.06l-7.5 7.5z" clip-rule="evenodd" /></svg>';
  function installButtons(host) {
    const { JE, document: document2 } = host;
    if (!firstInstall(JE, "ui-buttons")) return;
    const ui = JE.jellyseerrUI || (JE.jellyseerrUI = {});
    const internals = groupInternals(JE);
    const state = internals.state;
    const escapeHtml = escapeWith(JE);
    const icons = () => internals.icons ?? export03;
    const requestHandlers = /* @__PURE__ */ new WeakMap();
    function configureRequestButton(button, value, isJellyseerrActive, jellyseerrUserFound) {
      const previous = requestHandlers.get(button);
      if (previous) {
        button.removeEventListener("click", previous);
        requestHandlers.delete(button);
      }
      internals.clearDownloadProgressHover?.(button);
      if (!isJellyseerrActive) {
        button.innerHTML = `<span>${JE.t("jellyseerr_btn_offline")}</span>${icons().cloud_off}`;
        button.disabled = true;
        button.classList.add("jellyseerr-button-offline");
        return;
      }
      if (!jellyseerrUserFound) {
        button.innerHTML = `<span>${JE.t("jellyseerr_btn_user_not_found")}</span>${icons().person_off}`;
        button.disabled = true;
        button.classList.add("jellyseerr-button-no-user");
        return;
      }
      if (!export16(value)) {
        button.innerHTML = `<span>${JE.t("jellyseerr_btn_error")}</span>${icons().error}`;
        button.disabled = true;
        return;
      }
      const item = value;
      if (item.mediaType === "collection") {
        configureCollectionButton(button, item);
      } else if (item.mediaType === "tv") {
        button.dataset.searchResultItem = JSON.stringify(item);
        button.classList.add("jellyseerr-button-tv");
        if (item.mediaInfo) button.dataset.mediaInfo = JSON.stringify(item.mediaInfo);
        const analysis = item.mediaInfo?.seasons ? export0(item.mediaInfo.seasons, JE.t) : null;
        const overall = analysis ? analysis.overallStatus : item.mediaInfo ? item.mediaInfo.status : 1;
        configureTvShowButton(button, overall, analysis, item);
      } else {
        configureMovieButton(button, item);
      }
    }
    function configureCollectionButton(button, item) {
      bindViewOrigin(host, button);
      button.dataset.searchResultItem = JSON.stringify(item);
      button.dataset.mediaType = "collection";
      button.dataset.collectionId = String(item.id);
      button.innerHTML = `${icons().request}<span>${JE.t("jellyseerr_modal_request_collection")}</span>`;
      button.className = "jellyseerr-request-button jellyseerr-button-request jellyseerr-button-collection";
      button.disabled = false;
    }
    function decorateArrow(arrow, item) {
      const display4k = export11(item.mediaInfo ? item.mediaInfo.status4k : 1, false);
      if (display4k === export02.AVAILABLE) {
        arrow.disabled = true;
        arrow.classList.add("jellyseerr-split-arrow-disabled", "jellyseerr-4k-available");
        arrow.title = "4K Available";
      } else if (display4k === export02.PENDING || display4k === export02.REQUESTED || display4k === export02.PROCESSING) {
        arrow.classList.add("jellyseerr-4k-pending");
        arrow.title = "4K Requested";
      } else {
        arrow.title = JE.t("jellyseerr_btn_request_4k");
      }
    }
    function arrowButton(item, group) {
      const arrow = document2.createElement("button");
      bindViewOrigin(host, arrow);
      arrow.className = "jellyseerr-split-arrow";
      arrow.innerHTML = ARROW_SVG;
      arrow.dataset.tmdbId = String(item.id);
      arrow.dataset.toggle4k = "true";
      decorateArrow(arrow, item);
      arrow.addEventListener("click", (event) => {
        event.stopPropagation();
        if (!isViewCurrent(host, arrow)) return;
        if (state.active4KPopup && state.active4KPopup.parentElement === group) internals.hide4KPopup?.();
        else internals.show4KPopup?.(group, item);
      });
      return arrow;
    }
    function configureTvShowButton(button, overallStatus, seasonAnalysis, item) {
      bindViewOrigin(host, button);
      const setButton = (text2, icon, className, disabled = false, summary = seasonAnalysis?.statusSummary) => {
        button.innerHTML = `${icon || ""}<span>${text2}</span>`;
        if (summary) button.innerHTML += `<div class="jellyseerr-season-summary">${summary}</div>`;
        button.disabled = disabled;
        button.className = `jellyseerr-request-button jellyseerr-button-tv ${className}`;
      };
      const total = seasonAnalysis?.total ?? 0;
      switch (overallStatus) {
        case export1.PENDING:
          setButton(JE.t("jellyseerr_btn_pending"), icons().pending, "jellyseerr-button-pending");
          break;
        case export1.PROCESSING:
          setButton(JE.t("jellyseerr_btn_request"), icons().request, "jellyseerr-button-request");
          break;
        case export1.DELETED:
          setButton(JE.t((seasonAnalysis?.availableCount ?? 0) > 0 ? "jellyseerr_btn_request_more" : "jellyseerr_btn_request"), icons().request, "jellyseerr-button-request");
          break;
        case export1.PARTIALLY_AVAILABLE:
          setButton(JE.t("jellyseerr_btn_request_missing"), icons().request, "jellyseerr-button-partially-available");
          if (export5(item)) internals.addDownloadProgressHover?.(button, item);
          break;
        case export1.AVAILABLE:
          setButton(
            JE.t("jellyseerr_btn_available"),
            icons().available,
            "jellyseerr-button-available",
            true,
            total > 1 ? JE.t("jellyseerr_all_seasons", { count: total }) : null
          );
          break;
        case export1.BLOCKED:
          setButton(JE.t("jellyseerr_btn_blocklisted"), icons().cancel, "jellyseerr-button-blocklisted", true);
          break;
        default:
          setButton(
            JE.t("jellyseerr_btn_request"),
            icons().request,
            "jellyseerr-button-request",
            false,
            total > 1 ? JE.t("jellyseerr_seasons_available", { count: total }) : null
          );
      }
      if (JE.pluginConfig?.JellyseerrEnable4KTvRequests && !button.closest(".jellyseerr-button-group")) {
        const group = document2.createElement("div");
        group.className = "jellyseerr-button-group";
        const main = button.cloneNode(true);
        if (!(main instanceof HTMLButtonElement)) return;
        bindViewOrigin(host, main);
        main.classList.add("jellyseerr-split-main");
        main.dataset.tmdbId = String(item.id);
        main.dataset.mediaType = "tv";
        main.dataset.searchResultItem = JSON.stringify(item);
        group.appendChild(main);
        group.appendChild(arrowButton(item, group));
        button.replaceWith(group);
      }
    }
    const idleRequestHtml = () => `${icons().request}<span>${JE.t("jellyseerr_btn_request")}</span>`;
    function rejectionMessage(error, kind) {
      if (kind === "user-not-found") return JE.t("jellyseerr_btn_user_not_found");
      const { code, message } = errorBody(error);
      if (kind === "permission") {
        return JE.t(code ? `jellyseerr_err_${code}` : "jellyseerr_err_no_request_permission") || JE.t("jellyseerr_err_no_request_permission");
      }
      if (kind === "uncertain") return uncertainMessage(JE);
      return message || JE.t("jellyseerr_btn_error");
    }
    function movieRequestHandler(target, item, preventDefault) {
      const handler = async (event) => {
        if (preventDefault) event.preventDefault();
        event.stopPropagation();
        const api = JE.jellyseerrAPI;
        if (!api || !isViewCurrent(host, target)) return;
        if (api.shouldShowAdvanced()) {
          void ui.showMovieRequestModal?.(item.id, item.title || item.name || "", item, false);
          return;
        }
        const origin = captureOrigin(host);
        target.disabled = true;
        target.innerHTML = `<span>${JE.t("jellyseerr_btn_requesting")}</span><span class="jellyseerr-button-spinner"></span>`;
        const live = () => requestHandlers.get(target) === handler;
        try {
          await api.requestMedia(item.id, "movie", {}, false, item);
          if (!live()) return;
          if (!origin.current()) {
            target.disabled = false;
            target.innerHTML = idleRequestHtml();
            return;
          }
          if (!item.mediaInfo) item.mediaInfo = {};
          item.mediaInfo.status = export1.PROCESSING;
          target.innerHTML = `<span>${JE.t("jellyseerr_btn_requested")}</span>${icons().requested}`;
          target.classList.remove("jellyseerr-button-request");
          target.classList.add("jellyseerr-button-pending");
        } catch (error) {
          if (!live()) return;
          target.disabled = false;
          if (!origin.current()) {
            target.innerHTML = idleRequestHtml();
            return;
          }
          if (ui.isQuotaError?.(error)) {
            await ui.showQuotaErrorDialog?.(error, "movie");
            if (!live()) return;
            target.innerHTML = idleRequestHtml();
            return;
          }
          const kind = classifyFailure(error, JE.pluginConfig?.JellyseerrShowQuotaInfo !== false);
          target.innerHTML = `<span>${escapeHtml(rejectionMessage(error, kind))}</span>${icons().error}`;
          target.classList.add("jellyseerr-button-error");
        }
      };
      return handler;
    }
    function configureMovieButton(button, item) {
      bindViewOrigin(host, button);
      button.dataset.searchResultItem = JSON.stringify(item);
      const status = item.mediaInfo ? item.mediaInfo.status : 1;
      const downloads = export5(item);
      if (JE.pluginConfig?.JellyseerrEnable4KRequests && !button.closest(".jellyseerr-button-group")) {
        const group = document2.createElement("div");
        group.className = "jellyseerr-button-group";
        const config2 = export6(export11(status, downloads));
        const main = document2.createElement("button");
        bindViewOrigin(host, main);
        main.className = `jellyseerr-request-button jellyseerr-split-main ${config2.cssClass}`;
        main.disabled = config2.disabled;
        main.innerHTML = `${config2.iconKey ? icons()[config2.iconKey] : ""}<span>${JE.t(config2.labelKey)}</span>${config2.showSpinner ? '<span class="jellyseerr-button-spinner"></span>' : ""}`;
        main.dataset.tmdbId = String(item.id);
        main.dataset.mediaType = "movie";
        main.dataset.searchResultItem = JSON.stringify(item);
        if (downloads && config2.disabled) internals.addDownloadProgressHover?.(main, item);
        group.appendChild(main);
        group.appendChild(arrowButton(item, group));
        button.replaceWith(group);
        if (!config2.disabled) {
          const handler = movieRequestHandler(main, item, false);
          requestHandlers.set(main, handler);
          main.addEventListener("click", handler);
        }
        return;
      }
      const config = export6(export11(status, downloads));
      const icon = config.iconKey ? icons()[config.iconKey] : "";
      if (config.showSpinner) {
        button.innerHTML = `${icon}<span>${JE.t(config.labelKey)}</span><span class="jellyseerr-button-spinner"></span>`;
        button.disabled = true;
        button.className = `jellyseerr-request-button ${config.cssClass}`;
        if (downloads) internals.addDownloadProgressHover?.(button, item);
      } else {
        button.innerHTML = `${icon}<span>${JE.t(config.labelKey)}</span>`;
        button.disabled = config.disabled;
        button.className = `jellyseerr-request-button ${config.cssClass}`;
      }
      if (!button.disabled && !button.closest(".jellyseerr-button-group")) {
        const handler = movieRequestHandler(button, item, true);
        requestHandlers.set(button, handler);
        button.addEventListener("click", handler);
      }
    }
    ui.configureRequestButton = configureRequestButton;
    internals.configureRequestButton = configureRequestButton;
    internals.configureCollectionButton = configureCollectionButton;
    internals.configureTvShowButton = configureTvShowButton;
    internals.configureMovieButton = configureMovieButton;
  }

  // client/src/features/seerr/core/ui/buttons-entry.ts
  installButtons(seerrCoreHost());
})();
})();
//# sourceMappingURL=ui-buttons.js.map
