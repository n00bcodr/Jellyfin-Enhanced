(() => {
"use strict";
(() => {
  // client/src/host/context.ts
  function featureContext(feature, core, slots) {
    const shared4 = core.core?.featureContext;
    if (typeof shared4 !== "function") {
      throw new Error(`${feature}: JE.core.featureContext is missing; core/ui-kit.js must load before feature scripts`);
    }
    return shared4(feature, core, slots);
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
  var export3 = /* @__PURE__ */ sharedExport(shared, "decodeCollectionParts");
  var export18 = /* @__PURE__ */ sharedExport(shared, "isNumber");
  var export19 = /* @__PURE__ */ sharedExport(shared, "isRecord");
  var export20 = /* @__PURE__ */ sharedExport(shared, "isSafeTmdbImagePath");
  var export22 = /* @__PURE__ */ sharedExport(shared, "isString");

  // client/generated-shared/stub/client/src/features/seerr/core/status.ts
  var shared2 = /* @__PURE__ */ sharedModule("features/seerr/core/status");
  var export1 = /* @__PURE__ */ sharedExport(shared2, "MEDIA");

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
  function hashQuery(location) {
    const query = location.hash.split("?")[1];
    return new URLSearchParams(query).get("query");
  }

  // client/generated-shared/stub/client/src/features/seerr/core/ui/icon-markup.ts
  var shared3 = /* @__PURE__ */ sharedModule("features/seerr/core/ui/icon-markup");
  var export0 = /* @__PURE__ */ sharedExport(shared3, "ICONS");

  // client/src/features/seerr/core/ui/request-modals.ts
  var select = (root, id) => {
    const element = root.querySelector(`#${id}`);
    return element instanceof HTMLSelectElement ? element : null;
  };
  function chosenSettings(root, prefix) {
    const server = select(root, `${prefix}-server`)?.value;
    const quality = select(root, `${prefix}-quality`)?.value;
    const folder = select(root, `${prefix}-folder`)?.value;
    if (!server || !quality || !folder) return null;
    return { serverId: parseInt(server, 10), profileId: parseInt(quality, 10), rootFolder: folder, tags: [] };
  }
  function installRequestModals(host) {
    const { JE, document: document2, window: window2 } = host;
    if (!firstInstall(JE, "ui-request-modals")) return;
    const ui = JE.jellyseerrUI || (JE.jellyseerrUI = {});
    const internals = groupInternals(JE);
    const escapeHtml = escapeWith(JE);
    const icons = () => internals.icons ?? export0;
    const posterNotFound = () => JE.cdn?.url?.("ibb", "fdbkXQdP/jellyseerr-poster-not-found.png") ?? "";
    function showMovieRequested(tmdbId) {
      const id = String(tmdbId);
      if (!/^\d+$/.test(id)) return;
      for (const button of document2.querySelectorAll(`.jellyseerr-request-button[data-tmdb-id="${id}"]`)) {
        if (button.dataset.mediaType && button.dataset.mediaType !== "movie") continue;
        button.innerHTML = `<span>${JE.t("jellyseerr_btn_requested")}</span>${icons().requested}`;
        button.classList.remove("jellyseerr-button-request");
        button.classList.add("jellyseerr-button-pending");
      }
    }
    function addQuotaChip(modalElement, mediaType) {
      const body = modalElement.querySelector(".jellyseerr-modal-body");
      const api = JE.jellyseerrAPI;
      if (!body || !api) return;
      api.fetchUserQuota().then((quota) => {
        const chip = internals.buildQuotaChip?.(quota, mediaType) ?? null;
        if (chip && document2.body.contains(modalElement)) body.insertBefore(chip, body.firstChild);
      }).catch((error) => console.warn(`${LOG_UI} Quota chip render failed:`, error));
    }
    async function showMovieRequestModal(tmdbId, title, searchResultItem, is4k = false) {
      const modal = JE.jellyseerrModal;
      const api = JE.jellyseerrAPI;
      if (!modal || !api) return;
      const origin = captureOrigin(host);
      const backdropPath = export19(searchResultItem) && export22(searchResultItem.backdropPath) ? searchResultItem.backdropPath : null;
      let optionsFailed = false;
      const { modalElement, show } = modal.create({
        title: JE.t("jellyseerr_modal_title_movie"),
        subtitle: title,
        bodyHtml: modal.createAdvancedOptionsHTML("movie"),
        backdropPath,
        onSave: async (modalEl, requestBtn, closeFn) => {
          const settings = optionsFailed ? {} : chosenSettings(modalEl, "movie");
          if (!settings) {
            JE.toast?.(JE.t("jellyseerr_modal_toast_options_missing"), 3e3);
            return;
          }
          if (!origin.current()) {
            closeFn();
            return;
          }
          requestBtn.disabled = true;
          requestBtn.innerHTML = `${JE.t("jellyseerr_modal_requesting")}<span class="jellyseerr-button-spinner"></span>`;
          try {
            await api.requestMedia(tmdbId, "movie", settings, is4k, searchResultItem);
            if (!origin.current()) {
              closeFn();
              return;
            }
            showMovieRequested(tmdbId);
            closeFn();
          } catch (error) {
            if (!origin.current() || classifyFailure(error, true) === "not-sent") {
              closeFn();
              return;
            }
            await internals.handleRequestError?.(error, "movie", requestBtn, JE.t("jellyseerr_modal_request"));
          }
        }
      });
      show();
      addQuotaChip(modalElement, "movie");
      try {
        const data = await api.fetchAdvancedRequestData("movie");
        if (origin.current()) modal.populateAdvancedOptions(modalElement, data, "movie", is4k);
      } catch (error) {
        optionsFailed = true;
        console.error(`${LOG_UI} Failed to load advanced options:`, error);
        JE.toast?.(JE.t("jellyseerr_err_load_server_options"), 3e3);
      }
    }
    async function showCollectionRequestModal(collectionId, collectionName, searchResultItem = null) {
      const modal = JE.jellyseerrModal;
      const api = JE.jellyseerrAPI;
      if (!modal || !api) return;
      const origin = captureOrigin(host);
      let details;
      try {
        details = await api.fetchCollectionDetails(collectionId);
      } catch {
        details = null;
      }
      if (!origin.current()) return;
      if (!export19(details)) {
        JE.toast?.(JE.t("jellyseerr_toast_collection_fetch_failed"), 4e3);
        return;
      }
      const parts = export3(details);
      if (parts.length === 0) {
        JE.toast?.(JE.t("jellyseerr_toast_no_movies_in_collection"), 4e3);
        return;
      }
      const showAdvanced = api.shouldShowAdvanced();
      const label = (key, fallback) => JE.t(key) || fallback;
      const rows = parts.map((movie) => {
        const status = movie.mediaInfo?.status || export1.UNKNOWN;
        const hasActiveDownloads = (movie.mediaInfo?.downloadStatus?.length ?? 0) > 0;
        const isDisabled = status === export1.AVAILABLE || status === export1.PENDING || status === export1.PROCESSING;
        let statusClass = "not-requested";
        let statusText = label("jellyseerr_season_status_not_requested", "Not Requested");
        if (status === export1.AVAILABLE) {
          statusClass = "available";
          statusText = label("jellyseerr_btn_available", "Available");
        } else if (status === export1.PARTIALLY_AVAILABLE) {
          statusClass = "partially-available";
          statusText = label("jellyseerr_btn_partially_available", "Partially Available");
        } else if (status === export1.PROCESSING) {
          statusClass = hasActiveDownloads ? "processing" : "pending";
          statusText = hasActiveDownloads ? label("jellyseerr_btn_processing", "Processing") : label("jellyseerr_btn_requested", "Requested");
        } else if (status === export1.PENDING) {
          statusClass = "pending";
          statusText = label("jellyseerr_btn_pending", "Pending");
        }
        const year = movie.releaseDate ? new Date(movie.releaseDate).getFullYear() : NaN;
        const poster = export20(movie.posterPath) ? `https://image.tmdb.org/t/p/w92${movie.posterPath}` : posterNotFound();
        return `
                <div class="jellyseerr-collection-movie-row">
                    <input type="checkbox"
                           class="jellyseerr-collection-checkbox"
                           id="movie-${escapeHtml(movie.id)}"
                           data-tmdb-id="${escapeHtml(movie.id)}"
                           ${isDisabled ? "disabled" : "checked"}>
                    <img src="${escapeHtml(poster)}" alt="${escapeHtml(movie.title ?? "")}" class="jellyseerr-collection-movie-poster">
                    <div class="jellyseerr-collection-movie-details">
                        <div class="title">${escapeHtml(movie.title ?? "")}</div>
                        <div class="year">${escapeHtml(Number.isNaN(year) ? "" : year)}</div>
                    </div>
                    <div class="jellyseerr-season-status jellyseerr-season-status-${escapeHtml(statusClass)}">${escapeHtml(statusText)}</div>
                </div>
            `;
      }).join("");
      const bodyHtml = `
            <div class="jellyseerr-collection-list" style="max-height: 600px; overflow-y: auto;">
                <div class="jellyseerr-collection-header-row">
                    <input type="checkbox" class="jellyseerr-collection-checkbox" id="jellyseerr-select-all-movies">
                    <label class="jellyseerr-collection-header-label" for="jellyseerr-select-all-movies">${label("jellyseerr_select_all_movies", "Select All")}</label>
                    <div></div>
                    <div></div>
                </div>
                ${rows}
            </div>
            ${showAdvanced ? modal.createAdvancedOptionsHTML("movie") : ""}
        `;
      const buttonText = label("jellyseerr_modal_request_selected_movies", "Request Selected Movies");
      let optionsFailed = false;
      const backdrop = export22(details.backdrop_path) && details.backdrop_path ? details.backdrop_path : export22(details.backdropPath) ? details.backdropPath : null;
      const instance = modal.create({
        title: label("jellyseerr_modal_request_collection", "Request Collection"),
        subtitle: collectionName,
        bodyHtml,
        backdropPath: backdrop,
        buttonText,
        onSave: async (modalEl, requestBtn, closeFn) => {
          const restore = () => {
            requestBtn.disabled = false;
            requestBtn.textContent = buttonText;
          };
          if (!origin.current()) {
            closeFn();
            return;
          }
          requestBtn.disabled = true;
          requestBtn.innerHTML = `${label("jellyseerr_modal_requesting", "Requesting")}<span class="jellyseerr-button-spinner"></span>`;
          let settings = {};
          if (showAdvanced && !optionsFailed) {
            const chosen = chosenSettings(modalEl, "movie");
            if (!chosen) {
              JE.toast?.(label("jellyseerr_modal_toast_options_missing", "Please select all options"), 3e3);
              restore();
              return;
            }
            settings = chosen;
          }
          try {
            const selected = [...new Set(Array.from(modalEl.querySelectorAll(".jellyseerr-collection-movie-row .jellyseerr-collection-checkbox:checked:not(:disabled)")).map((checkbox) => parseInt(checkbox.dataset.tmdbId || "", 10)).filter((id) => Number.isInteger(id) && id > 0))];
            if (selected.length === 0) {
              JE.toast?.(label("jellyseerr_modal_toast_select_movie", "Please select at least one movie"), 3e3);
              restore();
              return;
            }
            let successCount = 0;
            let failures = 0;
            let uncertain = 0;
            let quotaHitError = null;
            for (const id of selected) {
              if (!origin.current()) break;
              try {
                await api.requestMedia(id, "movie", settings, false, searchResultItem);
                successCount++;
              } catch (error) {
                if (ui.isQuotaError?.(error)) {
                  quotaHitError = error;
                  break;
                }
                const kind = classifyFailure(error, true);
                if (kind === "not-sent" && !origin.current()) break;
                if (kind === "uncertain") uncertain++;
                else failures++;
                console.error(`Failed to request movie ${id}:`, error);
              }
            }
            if (!origin.current()) {
              closeFn();
              return;
            }
            let toastText = `${label("jellyseerr_toast_collection_requested", "Requested")} ${successCount} of ${selected.length} ${label("jellyseerr_toast_movies", "movies")}`;
            if (failures > 0) toastText += " " + JE.t("jellyseerr_toast_collection_failed_count", { count: failures });
            if (uncertain > 0) {
              toastText += " " + translated(JE, "jellyseerr_toast_collection_uncertain_count", `${uncertain} with unknown status (check Seerr before requesting again)`, { count: uncertain });
            }
            JE.toast?.(toastText, 4e3);
            if (quotaHitError) await ui.showQuotaErrorDialog?.(quotaHitError, "movie");
            closeFn();
            const query = hashQuery(window2.location);
            window2.setTimeout(() => {
              if (query && origin.current()) void JE.jellyseerr?.fetchAndRenderResults(query);
            }, 1e3);
          } catch {
            JE.toast?.(label("jellyseerr_modal_toast_request_fail", "Request failed"), 4e3);
            restore();
          }
        }
      });
      if (showAdvanced) {
        try {
          const data = await api.fetchAdvancedRequestData("movie");
          modal.populateAdvancedOptions(instance.modalElement, data, "movie", false);
        } catch (error) {
          optionsFailed = true;
          console.error("Failed to load advanced options:", error);
          JE.toast?.(JE.t("jellyseerr_err_load_server_options"), 3e3);
        }
      }
      if (!origin.current()) return;
      instance.show();
      const selectAll = instance.modalElement.querySelector("#jellyseerr-select-all-movies");
      const list = instance.modalElement.querySelector(".jellyseerr-collection-list");
      if (!(selectAll instanceof HTMLInputElement) || !list) return;
      const rowBoxes = (checked) => list.querySelectorAll(`.jellyseerr-collection-movie-row .jellyseerr-collection-checkbox:not(:disabled)${checked ? ":checked" : ""}`);
      const updateSelectAllState = () => {
        const all = rowBoxes(false).length;
        const checked = rowBoxes(true).length;
        selectAll.checked = checked > 0 && checked === all;
        selectAll.indeterminate = checked > 0 && checked < all;
      };
      selectAll.addEventListener("change", () => {
        for (const box of rowBoxes(false)) box.checked = selectAll.checked;
      });
      list.addEventListener("change", (event) => {
        const target = event.target;
        if (target instanceof HTMLElement && target.classList.contains("jellyseerr-collection-checkbox") && target.id !== "jellyseerr-select-all-movies") updateSelectAllState();
      });
      updateSelectAllState();
    }
    ui.showMovieRequestModal = showMovieRequestModal;
    ui.showCollectionRequestModal = showCollectionRequestModal;
  }

  // client/src/features/seerr/core/ui/request-modals-entry.ts
  installRequestModals(seerrCoreHost());
})();
})();
//# sourceMappingURL=ui-request-modals.js.map
