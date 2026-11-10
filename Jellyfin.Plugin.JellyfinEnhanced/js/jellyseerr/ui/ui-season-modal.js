(() => {
"use strict";
(() => {
  // client/src/host/context.ts
  function featureContext(feature, core, slots) {
    const shared3 = core.core?.featureContext;
    if (typeof shared3 !== "function") {
      throw new Error(`${feature}: JE.core.featureContext is missing; core/ui-kit.js must load before feature scripts`);
    }
    return shared3(feature, core, slots);
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
  var export12 = /* @__PURE__ */ sharedExport(shared, "decodeTvDetails");
  var export18 = /* @__PURE__ */ sharedExport(shared, "isNumber");
  var export19 = /* @__PURE__ */ sharedExport(shared, "isRecord");
  var export22 = /* @__PURE__ */ sharedExport(shared, "isString");

  // client/generated-shared/stub/client/src/features/seerr/core/status.ts
  var shared2 = /* @__PURE__ */ sharedModule("features/seerr/core/status");
  var export1 = /* @__PURE__ */ sharedExport(shared2, "MEDIA");
  var export2 = /* @__PURE__ */ sharedExport(shared2, "REQUEST");
  var export4 = /* @__PURE__ */ sharedExport(shared2, "effectiveMediaStatus");
  var export8 = /* @__PURE__ */ sharedExport(shared2, "getDisplayInfo");
  var export10 = /* @__PURE__ */ sharedExport(shared2, "isRequestable");

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

  // client/src/features/seerr/core/ui/season-modal.ts
  var isValidDate = (value) => export22(value) && /^\d{4}-\d{2}-\d{2}/.test(value);
  function readManualTvdbId(root) {
    const input = root.querySelector("#jellyseerr-tvdb-id");
    const raw = String(input instanceof HTMLInputElement ? input.value : "").trim();
    if (!/^\d+$/.test(raw)) return null;
    const id = parseInt(raw, 10);
    return id > 0 && id <= 2147483647 ? id : null;
  }
  function seasonDisplayName(season, t) {
    const trimmed = (season.name || "").trim();
    const numericOnly = trimmed === String(season.seasonNumber) || /^0*\d+$/.test(trimmed);
    if (trimmed && !numericOnly) return trimmed;
    return season.seasonNumber === 0 ? t("jellyseerr_season_specials") : t("jellyseerr_season_name", { number: season.seasonNumber });
  }
  function installSeasonModal(host) {
    const { JE, document: document2, window: window2 } = host;
    if (!firstInstall(JE, "ui-season-modal")) return;
    const ui = JE.jellyseerrUI || (JE.jellyseerrUI = {});
    const internals = groupInternals(JE);
    const escapeHtml = escapeWith(JE);
    let refreshModalInterval;
    const stopPolling = () => {
      if (refreshModalInterval !== void 0) window2.clearInterval(refreshModalInterval);
      refreshModalInterval = void 0;
    };
    function updateSeasonList(seasonListElement, value, partialRequestsEnabled = true, enableSpecialEpisodes = false, is4kMode = false, jellyfinSeasonMap = null) {
      const details = isTvView(value) ? value : export12(value);
      if (!seasonListElement || !details) return;
      const showJellyfinId = is4kMode ? details.mediaInfo?.jellyfinMediaId4k || null : details.mediaInfo?.jellyfinMediaId || null;
      const statusBySeason = /* @__PURE__ */ new Map();
      for (const season of details.mediaInfo?.seasons || []) {
        const status = is4kMode ? season.status4k : season.status;
        if (status !== void 0 && status !== null && export18(season.seasonNumber)) statusBySeason.set(
          season.seasonNumber,
          export4(status, showJellyfinId, jellyfinSeasonMap, season.seasonNumber)
        );
      }
      for (const request of details.mediaInfo?.requests || []) {
        if (!!request.is4k !== !!is4kMode) continue;
        for (const season of request.seasons || []) {
          if (!export18(season.seasonNumber)) continue;
          const active = season.status === export2.PENDING ? export1.PENDING : season.status === export2.APPROVED ? export1.PROCESSING : null;
          const media = statusBySeason.get(season.seasonNumber);
          if (active !== null && (export10(media) || media === export1.PENDING && active === export1.PROCESSING)) {
            statusBySeason.set(season.seasonNumber, active);
          }
        }
      }
      const seasons = details.seasons.filter((s) => !!s.episodeCount && s.episodeCount > 0).filter((s) => s.seasonNumber !== 0 || enableSpecialEpisodes).slice().sort((a, b) => (a.seasonNumber || 0) - (b.seasonNumber || 0));
      const downloads = (is4kMode ? details.mediaInfo?.downloadStatus4k : details.mediaInfo?.downloadStatus) || [];
      for (const season of seasons) {
        const seasonNumber = season.seasonNumber;
        let item = seasonListElement.querySelector(`.jellyseerr-season-item[data-season-number="${seasonNumber}"]`);
        if (!(item instanceof HTMLElement)) {
          const created = document2.createElement("div");
          created.className = "jellyseerr-season-item";
          created.dataset.seasonNumber = String(seasonNumber);
          seasonListElement.appendChild(created);
          item = created;
        }
        const seasonItem = item;
        const effective = statusBySeason.get(seasonNumber) ?? export1.UNKNOWN;
        const canRequest = export10(effective);
        const seasonDownloads = downloads.filter((download) => download.episode?.seasonNumber === seasonNumber);
        const { labelKey, cssClass } = export8(effective, seasonDownloads.length > 0);
        const existing = seasonItem.querySelector(".jellyseerr-season-checkbox");
        const wasChecked = existing instanceof HTMLInputElement ? existing.checked : false;
        const disabled = !partialRequestsEnabled || !canRequest;
        const episodes = season.episodeCount || 0;
        seasonItem.innerHTML = `
                <input type="checkbox" class="jellyseerr-season-checkbox" data-season-number="${escapeHtml(seasonNumber)}" ${disabled ? "disabled" : ""} style="${!partialRequestsEnabled ? "cursor: not-allowed;" : ""}">
                <div class="jellyseerr-season-info">
                    <div class="jellyseerr-season-name">${escapeHtml(seasonDisplayName(season, JE.t))}</div>
                    <div class="jellyseerr-season-meta">${escapeHtml((season.airDate || season.jeYear || "").substring(0, 4))}<span class="jellyseerr-meta-eps"> &middot; ${escapeHtml(episodes)} ep</span></div>
                </div>
                <div class="jellyseerr-season-episodes">${escapeHtml(episodes)} ep</div>
                <div class="jellyseerr-season-status jellyseerr-season-status-${escapeHtml(cssClass)}">${escapeHtml(JE.t(labelKey))}</div>
            `;
        if (existing instanceof HTMLInputElement) {
          const checkbox = seasonItem.querySelector(".jellyseerr-season-checkbox");
          if (checkbox instanceof HTMLInputElement) checkbox.checked = wasChecked && !disabled;
        }
        seasonItem.classList.toggle("disabled", !canRequest);
        seasonItem.querySelector(".jellyseerr-inline-progress")?.remove();
        if (seasonDownloads.length > 0) {
          const size = seasonDownloads.reduce((sum, d) => sum + (d.size || 0), 0);
          const sizeLeft = seasonDownloads.reduce((sum, d) => sum + (d.sizeLeft || 0), 0);
          if (size > 0) {
            const progress = internals.createInlineProgress?.({ size, sizeLeft, status: `${seasonDownloads.length} episode(s) downloading` });
            if (progress) seasonItem.appendChild(progress);
          }
        }
      }
    }
    function isTvView(value) {
      return export19(value) && Array.isArray(value.seasons) && "externalTvdbId" in value && "mediaInfo" in value;
    }
    function buildTvdbMatchHTML() {
      return `
            <div class="jellyseerr-tvdb-match">
                <div class="jellyseerr-tvdb-match-notice">${JE.t("jellyseerr_tvdb_match_notice")}</div>
                <div class="jellyseerr-tvdb-match-results"><div class="jellyseerr-tvdb-match-hint">${JE.t("jellyseerr_tvdb_match_searching")}</div></div>
                <div class="jellyseerr-form-group">
                    <label for="jellyseerr-tvdb-id">${JE.t("jellyseerr_tvdb_id_label")}</label>
                    <input type="number" id="jellyseerr-tvdb-id" inputmode="numeric" min="1" step="1" autocomplete="off" placeholder="${escapeHtml(JE.t("jellyseerr_tvdb_id_placeholder"))}">
                </div>
            </div>`;
    }
    async function populateTvdbMatches(modalEl, tmdbId) {
      const resultsEl = modalEl.querySelector(".jellyseerr-tvdb-match-results");
      const input = modalEl.querySelector("#jellyseerr-tvdb-id");
      const api = JE.jellyseerrAPI;
      if (!(resultsEl instanceof HTMLElement) || !(input instanceof HTMLInputElement) || !api) return;
      let candidates = [];
      let hintKey = "jellyseerr_tvdb_match_none";
      try {
        candidates = (await api.fetchSonarrLookup(tmdbId)).filter((c) => Number.isInteger(c.tvdbId) && c.tvdbId > 0).slice(0, 6);
      } catch (error) {
        if (errorStatus(error) !== 404) {
          hintKey = "jellyseerr_tvdb_match_failed";
          console.warn(`${LOG_UI} Sonarr lookup failed for TMDB ID ${tmdbId}:`, error);
        }
      }
      if (!document2.body.contains(modalEl)) return;
      if (candidates.length === 0) {
        resultsEl.innerHTML = `<div class="jellyseerr-tvdb-match-hint">${JE.t(hintKey)}</div>`;
        return;
      }
      const fallbackPoster = JE.cdn?.url?.("ibb", "fdbkXQdP/jellyseerr-poster-not-found.png") ?? "";
      resultsEl.innerHTML = candidates.map((c) => {
        const poster = /^https?:\/\//i.test(c.remotePoster || "") && c.remotePoster ? c.remotePoster : fallbackPoster;
        const year = c.year ?? "";
        return `
                <button type="button" class="jellyseerr-tvdb-match-row" data-tvdb-id="${escapeHtml(c.tvdbId)}">
                    <img src="${escapeHtml(poster)}" alt="" loading="lazy">
                    <div>
                        <div class="title">${escapeHtml(c.title || "")}</div>
                        <div class="meta">${escapeHtml(year)}${year ? " · " : ""}TVDB ${escapeHtml(c.tvdbId)}</div>
                        ${c.overview ? `<div class="overview">${escapeHtml(c.overview)}</div>` : ""}
                    </div>
                </button>`;
      }).join("");
      for (const img of resultsEl.querySelectorAll("img")) {
        img.addEventListener("error", () => {
          if (img.getAttribute("src") !== fallbackPoster) img.src = fallbackPoster;
        }, { once: true });
      }
      const syncSelection = () => {
        const current = String(input.value || "").trim();
        for (const row of resultsEl.querySelectorAll(".jellyseerr-tvdb-match-row")) row.classList.toggle("selected", row.dataset.tvdbId === current);
      };
      resultsEl.addEventListener("click", (event) => {
        const row = event.target instanceof Element ? event.target.closest(".jellyseerr-tvdb-match-row") : null;
        if (!(row instanceof HTMLElement)) return;
        input.value = row.dataset.tvdbId || "";
        syncSelection();
      });
      input.addEventListener("input", syncSelection);
      syncSelection();
    }
    async function jellyfinSeasons(seriesId) {
      const client = host.apiClient();
      const userId = client?.getCurrentUserId?.();
      if (!client?.ajax || !export22(userId) || !userId) return null;
      try {
        const response = await client.ajax({
          type: "GET",
          url: client.getUrl(`/Users/${userId}/Items`, { ParentId: seriesId, IncludeItemTypes: "Season", Recursive: false, Fields: "IndexNumber" }),
          dataType: "json"
        });
        const map = {};
        const items = export19(response) && Array.isArray(response.Items) ? response.Items : [];
        for (const season of items) {
          const index = export19(season) ? Number(season.IndexNumber) : NaN;
          if (Number.isFinite(index) && index >= 0) map[index] = true;
        }
        return map;
      } catch {
        return null;
      }
    }
    async function showSeasonSelectionModal(tmdbId, mediaType, showTitle, searchResultItem = null, is4k = false) {
      if (mediaType !== "tv") return;
      stopPolling();
      const modal = JE.jellyseerrModal;
      const api = JE.jellyseerrAPI;
      if (!modal || !api) return;
      const origin = captureOrigin(host);
      let partialRequestsEnabled = false;
      let enableSpecialEpisodes = false;
      try {
        const settings = await api.fetchRequestSettings();
        partialRequestsEnabled = settings.partialRequestsEnabled;
        enableSpecialEpisodes = settings.enableSpecialEpisodes;
      } catch {
      }
      const singleSeasonOnly = partialRequestsEnabled && JE.pluginConfig?.JellyseerrSingleSeasonRequestOnly === true;
      const rawDetails = await api.fetchTvShowDetails(tmdbId, { skipCache: true });
      const tvDetails = export12(rawDetails);
      if (!origin.current()) return;
      if (!tvDetails) {
        JE.toast?.(JE.t("jellyseerr_toast_no_season_info"), 4e3);
        return;
      }
      const seriesId = (is4k ? tvDetails.mediaInfo?.jellyfinMediaId4k : tvDetails.mediaInfo?.jellyfinMediaId) || null;
      const jellyfinSeasonMap = seriesId ? await jellyfinSeasons(seriesId) : null;
      if (!origin.current()) return;
      const normalizedTitle = String(showTitle || "").trim();
      const genericTitle = ["this show", "this movie", "this collection"].includes(normalizedTitle.toLowerCase());
      const fromItem = (key) => export19(searchResultItem) && export22(searchResultItem[key]) && searchResultItem[key] ? String(searchResultItem[key]) : null;
      const resolvedShowTitle = !genericTitle && normalizedTitle || tvDetails.name || tvDetails.title || fromItem("name") || fromItem("title") || fromItem("originalName") || fromItem("originalTitle") || normalizedTitle || "Unknown Show";
      const showAdvanced = api.shouldShowAdvanced();
      const storedTvdbId = export18(tvDetails.mediaInfo?.tvdbId) && Number.isInteger(tvDetails.mediaInfo.tvdbId) && tvDetails.mediaInfo.tvdbId > 0 ? tvDetails.mediaInfo.tvdbId : null;
      const needsTvdbMatch = !tvDetails.externalTvdbId && !storedTvdbId;
      const resetLabel = () => is4k ? JE.t("jellyseerr_btn_request_4k") || "Request in 4K" : partialRequestsEnabled ? JE.t("jellyseerr_modal_request_selected") : JE.t("jellyseerr_modal_request");
      const bodyHtml = `${needsTvdbMatch ? buildTvdbMatchHTML() : ""}<div class="jellyseerr-season-list">
            ${partialRequestsEnabled && !singleSeasonOnly ? '<div class="jellyseerr-season-header-row"><input type="checkbox" class="jellyseerr-season-checkbox" id="jellyseerr-select-all-seasons"><label class="jellyseerr-season-header-label" for="jellyseerr-select-all-seasons">' + JE.t("jellyseerr_select_all_seasons") + "</label><div></div><div></div></div>" : ""}
        </div>${showAdvanced ? modal.createAdvancedOptionsHTML("tv") : ""}`;
      let latestDetails = tvDetails;
      let optionsFailed = false;
      const instance = modal.create({
        title: is4k ? `${JE.t("jellyseerr_modal_title")} - 4K` : JE.t("jellyseerr_modal_title"),
        subtitle: resolvedShowTitle,
        bodyHtml,
        backdropPath: tvDetails.backdropPath,
        buttonText: is4k ? JE.t("jellyseerr_btn_request_4k") || "Request in 4K" : void 0,
        onClose: stopPolling,
        onSave: async (modalEl, requestBtn, closeFn) => {
          if (!origin.current()) {
            closeFn();
            return;
          }
          requestBtn.disabled = true;
          requestBtn.innerHTML = `${JE.t("jellyseerr_modal_requesting")}<span class="jellyseerr-button-spinner"></span>`;
          const restore = () => {
            requestBtn.disabled = false;
            requestBtn.textContent = resetLabel();
          };
          let manualTvdbId = tvDetails.externalTvdbId ? null : storedTvdbId;
          if (needsTvdbMatch) {
            manualTvdbId = readManualTvdbId(modalEl);
            if (!manualTvdbId) {
              JE.toast?.(JE.t("jellyseerr_modal_toast_tvdb_required"), 4e3);
              restore();
              const input = modalEl.querySelector("#jellyseerr-tvdb-id");
              if (input instanceof HTMLElement) input.focus();
              return;
            }
          }
          let settings = {};
          if (showAdvanced && !optionsFailed) {
            const value = (id) => {
              const el = modalEl.querySelector(`#${id}`);
              return el instanceof HTMLSelectElement ? el.value : "";
            };
            const server = value("tv-server");
            const quality = value("tv-quality");
            const folder = value("tv-folder");
            if (!server || !quality || !folder) {
              JE.toast?.(JE.t("jellyseerr_modal_toast_options_missing"), 3e3);
              restore();
              return;
            }
            settings = { serverId: parseInt(server, 10), profileId: parseInt(quality, 10), rootFolder: folder, tags: [] };
          }
          try {
            if (partialRequestsEnabled) {
              const selected = Array.from(modalEl.querySelectorAll(".jellyseerr-season-item .jellyseerr-season-checkbox:checked:not(:disabled)")).map((checkbox) => parseInt(checkbox.dataset.seasonNumber || "", 10));
              if (selected.length === 0) {
                JE.toast?.(JE.t("jellyseerr_modal_toast_select_season"), 3e3);
                requestBtn.disabled = false;
                requestBtn.textContent = is4k ? JE.t("jellyseerr_btn_request_4k") || "Request in 4K" : JE.t("jellyseerr_modal_request_selected");
                return;
              }
              await api.requestTvSeasons(tmdbId, [...new Set(selected)], settings, searchResultItem, is4k, manualTvdbId);
              if (!origin.current()) {
                closeFn();
                return;
              }
              JE.toast?.(JE.t("jellyseerr_modal_toast_request_success", { count: new Set(selected).size, title: escapeHtml(resolvedShowTitle) }), 4e3);
            } else {
              const all = tvDetails.seasons.map((s) => s.seasonNumber).filter((n) => Number.isFinite(n) && n > 0);
              if (all.length > 0) await api.requestTvSeasons(tmdbId, all, settings, searchResultItem, is4k, manualTvdbId);
              else await api.requestMedia(tmdbId, "tv", settings, is4k, searchResultItem, manualTvdbId);
              if (!origin.current()) {
                closeFn();
                return;
              }
              JE.toast?.(JE.t("jellyseerr_modal_toast_request_success", { count: "all", title: escapeHtml(resolvedShowTitle) }), 4e3);
            }
            host.document.dispatchEvent(new CustomEvent("jellyseerr-tv-requested", { detail: { tmdbId, mediaType: "tv", is4k } }));
            host.document.dispatchEvent(new CustomEvent("jellyseerr-media-requested", { detail: { tmdbId, mediaType: "tv", is4k } }));
            internals.markCardRequested?.(String(tmdbId), "tv", is4k);
            closeFn();
            const query = hashQuery(window2.location);
            window2.setTimeout(() => {
              if (query && origin.current()) void JE.jellyseerr?.fetchAndRenderResults(query, { skipCache: true });
            }, 1e3);
          } catch (error) {
            if (!origin.current() || classifyFailure(error, true) === "not-sent") {
              closeFn();
              return;
            }
            await internals.handleRequestError?.(error, "tv", requestBtn, resetLabel());
          }
        }
      });
      const seasonList = instance.modalElement.querySelector(".jellyseerr-season-list");
      updateSeasonList(seasonList, tvDetails, partialRequestsEnabled, enableSpecialEpisodes, is4k, jellyfinSeasonMap);
      instance.show();
      if (needsTvdbMatch) void populateTvdbMatches(instance.modalElement, tmdbId);
      const body = instance.modalElement.querySelector(".jellyseerr-modal-body");
      if (body) {
        api.fetchUserQuota().then((quota) => {
          const chip = internals.buildQuotaChip?.(quota, "tv") ?? null;
          if (chip && document2.body.contains(instance.modalElement)) body.insertBefore(chip, body.firstChild);
        }).catch((error) => console.warn(`${LOG_UI} Quota chip render failed:`, error));
      }
      const airDateCache = /* @__PURE__ */ new Map();
      const seasonNameCache = /* @__PURE__ */ new Map();
      const applyBackfill = (details) => ({
        ...details,
        seasons: details.seasons.map((s) => ({
          ...s,
          airDate: s.airDate || airDateCache.get(s.seasonNumber) || null,
          // Only while protected: without a guard the details carry the real name.
          name: details.jeSpoilerGuard && seasonNameCache.get(s.seasonNumber) || s.name || null
        }))
      });
      const render = (details) => {
        if (!origin.current() || !seasonList?.isConnected) return;
        updateSeasonList(seasonList, applyBackfill(details), partialRequestsEnabled, enableSpecialEpisodes, is4k, jellyfinSeasonMap);
      };
      const followUp = api.followUpOptions(rawDetails);
      const needingDates = tvDetails.seasons.filter((s) => (s.episodeCount ?? 0) > 0 && (!s.airDate && !s.jeYear || tvDetails.jeSpoilerGuard && s.seasonNumber > 1));
      if (needingDates.length > 0) {
        const seasonFetches = needingDates.map((season) => api.fetchTvSeasonDetails(tmdbId, season.seasonNumber, followUp).then((detail) => {
          const first = export19(detail) && Array.isArray(detail.episodes) ? detail.episodes[0] : void 0;
          const date = export19(first) ? isValidDate(first.airDate) ? first.airDate : export22(first.jeYear) ? first.jeYear : null : null;
          if (date) airDateCache.set(season.seasonNumber, date);
          if (tvDetails.jeSpoilerGuard && export19(detail) && export22(detail.name) && detail.name) seasonNameCache.set(season.seasonNumber, detail.name);
        }).catch(() => void 0));
        const tmdbFetch = JE.pluginConfig?.TmdbEnabled ? api.fetchTmdbTvDetails(tmdbId, followUp).then((tmdb) => {
          if (!export19(tmdb) || !Array.isArray(tmdb.seasons)) return;
          for (const s of tmdb.seasons) {
            if (!export19(s) || !export18(s.season_number)) continue;
            const date = isValidDate(s.air_date) ? s.air_date : export22(s.jeYear) ? s.jeYear : null;
            if (date && !airDateCache.has(s.season_number)) airDateCache.set(s.season_number, date);
          }
        }).catch(() => void 0) : Promise.resolve();
        void Promise.all([...seasonFetches, tmdbFetch]).then(() => render(latestDetails));
      }
      if (singleSeasonOnly && seasonList) {
        seasonList.addEventListener("change", (event) => {
          const target = event.target;
          if (!(target instanceof HTMLInputElement) || !target.classList.contains("jellyseerr-season-checkbox") || !target.checked) return;
          for (const box of seasonList.querySelectorAll(".jellyseerr-season-checkbox:checked")) if (box !== target) box.checked = false;
        });
      }
      let updateSelectAllState = null;
      const selectAll = instance.modalElement.querySelector("#jellyseerr-select-all-seasons");
      if (partialRequestsEnabled && seasonList && selectAll instanceof HTMLInputElement) {
        const regular = '.jellyseerr-season-item:not([data-season-number="0"]) .jellyseerr-season-checkbox:not(:disabled)';
        const update = () => {
          const all = seasonList.querySelectorAll(regular).length;
          const checked = seasonList.querySelectorAll(`${regular}:checked`).length;
          selectAll.checked = checked > 0 && checked === all;
          selectAll.indeterminate = checked > 0 && checked < all;
        };
        selectAll.addEventListener("change", () => {
          for (const box of seasonList.querySelectorAll(regular)) box.checked = selectAll.checked;
        });
        seasonList.addEventListener("change", (event) => {
          const target = event.target;
          if (target instanceof HTMLElement && target.classList.contains("jellyseerr-season-checkbox") && target.id !== "jellyseerr-select-all-seasons") update();
        });
        update();
        updateSelectAllState = update;
      }
      refreshModalInterval = window2.setInterval(async () => {
        if (!origin.current()) {
          stopPolling();
          instance.close?.();
          return;
        }
        const fresh = export12(await api.fetchTvShowDetails(tmdbId, { skipCache: true }));
        if (!fresh || !origin.current()) return;
        latestDetails = fresh;
        render(fresh);
        updateSelectAllState?.();
      }, 1e4);
      if (showAdvanced) {
        try {
          const data = await api.fetchAdvancedRequestData("tv");
          if (origin.current()) modal.populateAdvancedOptions(instance.modalElement, data, "tv", is4k);
        } catch (error) {
          optionsFailed = true;
          console.error(`${LOG_UI} Failed to load TV advanced options:`, error);
          JE.toast?.(JE.t("jellyseerr_err_load_server_options"), 3e3);
        }
      }
    }
    ui.showSeasonSelectionModal = showSeasonSelectionModal;
    internals.updateSeasonList = updateSeasonList;
  }

  // client/src/features/seerr/core/ui/season-modal-entry.ts
  installSeasonModal(seerrCoreHost());
})();
})();
//# sourceMappingURL=ui-season-modal.js.map
