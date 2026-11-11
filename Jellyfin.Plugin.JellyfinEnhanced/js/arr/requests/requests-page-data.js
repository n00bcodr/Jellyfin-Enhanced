(() => {
"use strict";
(() => {
  // client/src/host/context.ts
  function sharedModule(id2) {
    const namespace = window.JellyfinEnhanced?.core?.sharedModules?.[id2];
    if (!namespace) throw new Error(`${id2} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);
    return namespace;
  }
  function sharedExport(namespace, name) {
    return namespace[name];
  }

  // client/generated-shared/stub/client/src/features/downloads/host.ts
  var shared = /* @__PURE__ */ sharedModule("features/downloads/host");
  var export0 = /* @__PURE__ */ sharedExport(shared, "downloadsHost");

  // client/src/features/downloads/validation.ts
  function record(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
  }
  function response(v) {
    if (!record(v)) throw new Error("Invalid downloads response");
    return v;
  }
  function text(v) {
    if (v == null) return void 0;
    if (typeof v !== "string") throw new Error("Invalid text");
    return v;
  }
  function number(v) {
    if (v == null) return void 0;
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error("Invalid number");
    return v;
  }
  function id(v) {
    return typeof v === "string" ? v : number(v);
  }
  function boolean(v) {
    if (v == null) return void 0;
    if (typeof v !== "boolean") throw new Error("Invalid boolean");
    return v;
  }
  function readItems(v) {
    if (v == null) return [];
    if (!Array.isArray(v)) throw new Error("Invalid items");
    return v.map((x) => {
      const r = response(x);
      return {
        title: text(r.title),
        subtitle: text(r.subtitle),
        source: text(r.source),
        instanceName: text(r.instanceName),
        status: text(r.status),
        mediaStatus: text(r.mediaStatus),
        requestStatus: number(r.requestStatus),
        posterUrl: text(r.posterUrl),
        jellyfinMediaId: text(r.jellyfinMediaId),
        timeRemaining: text(r.timeRemaining),
        type: text(r.type),
        requestedBy: text(r.requestedBy),
        requestedByAvatar: text(r.requestedByAvatar),
        createdAt: text(r.createdAt),
        date: text(r.date),
        nextAirDate: text(r.nextAirDate),
        digitalReleaseDate: text(r.digitalReleaseDate),
        theatricalReleaseDate: text(r.theatricalReleaseDate),
        eventType: text(r.eventType),
        progress: number(r.progress),
        seasonNumber: number(r.seasonNumber),
        episodeNumber: number(r.episodeNumber),
        totalSize: number(r.totalSize),
        sizeRemaining: number(r.sizeRemaining),
        year: number(r.year),
        tmdbId: number(r.tmdbId),
        tvdbId: number(r.tvdbId),
        episodeCount: number(r.episodeCount),
        importedCount: number(r.importedCount),
        id: id(r.id),
        instanceId: id(r.instanceId),
        isOrphaned: boolean(r.isOrphaned)
      };
    });
  }
  function readMedia(v, depth = 0) {
    const r = response(v);
    return {
      id: number(r.id),
      tmdbId: number(r.tmdbId),
      title: text(r.title),
      name: text(r.name),
      originalTitle: text(r.originalTitle),
      originalName: text(r.originalName),
      posterPath: text(r.posterPath),
      poster_path: text(r.poster_path),
      posterUrl: text(r.posterUrl),
      releaseDate: text(r.releaseDate),
      release_date: text(r.release_date),
      firstAirDate: text(r.firstAirDate),
      first_air_date: text(r.first_air_date),
      mediaType: text(r.mediaType),
      jellyfinMediaId: text(r.jellyfinMediaId),
      jellyfinMediaId4k: text(r.jellyfinMediaId4k),
      jellyfinMediaId4K: text(r.jellyfinMediaId4K),
      mediaInfo: r.mediaInfo != null && depth < 2 ? readMedia(r.mediaInfo, depth + 1) : void 0,
      mediaInfo4k: r.mediaInfo4k != null && depth < 2 ? readMedia(r.mediaInfo4k, depth + 1) : void 0,
      mediaInfo4K: r.mediaInfo4K != null && depth < 2 ? readMedia(r.mediaInfo4K, depth + 1) : void 0
    };
  }
  function readIssues(v) {
    if (v == null) return [];
    if (!Array.isArray(v)) throw new Error("Invalid issues");
    return v.map((x) => {
      const r = response(x);
      const user = r.createdBy == null ? {} : response(r.createdBy);
      return { id: id(r.id), media: r.media == null ? void 0 : readMedia(r.media), mediaType: text(r.mediaType), type: text(r.type), tmdbId: number(r.tmdbId), issueType: number(r.issueType), problemType: number(r.problemType), status: id(r.status), createdAt: text(r.createdAt), message: text(r.message), createdBy: { jellyfinUsername: text(user.jellyfinUsername), displayName: text(user.displayName), username: text(user.username), email: text(user.email), avatar: text(user.avatar) }, comments: Array.isArray(r.comments) ? r.comments.map((c) => ({ message: text(response(c).message) })) : [] };
    });
  }
  function pages(v) {
    const n = number(v);
    return n === void 0 ? 1 : Math.max(1, Math.floor(n));
  }

  // client/generated-shared/stub/client/src/features/downloads/runtime.ts
  var shared2 = /* @__PURE__ */ sharedModule("features/downloads/runtime");
  var export02 = /* @__PURE__ */ sharedExport(shared2, "runtime");

  // client/src/features/downloads/data.ts
  function install(deps) {
    const { JE, P, host, getApi } = deps;
    const life = export02(deps);
    if (life.installed.has("data")) return;
    life.installed.add("data");
    const renderPage = (...args) => P.renderPage(...args);
    const logPrefix = "🪼 Jellyfin Enhanced: Requests Page:";
    let requestsOwner;
    let loaded = false;
    const state = {
      downloads: [],
      requests: [],
      requestsPage: 1,
      requestsTotalPages: 1,
      requestsFilter: "all",
      canApproveRequests: false,
      issues: [],
      issuesPage: 1,
      issuesTotalPages: 1,
      issuesError: false,
      issuesFilter: "open",
      history: [],
      historyVisible: true,
      historyPage: 1,
      historyTotalPages: 1,
      isLoading: false,
      pollTimer: null,
      pageVisible: false,
      previousPage: null,
      locationSignature: null,
      locationUnsubscribe: null,
      downloadsActiveTab: "all",
      downloadsSearchQuery: "",
      downloadsSearchVisible: false,
      searchDebounceTimer: null,
      _customTabContainer: null
    };
    const unsubscribeSession = JE.session?.onUserChange("requests-page", () => {
      life.invalidate();
      requestsOwner = void 0;
      loaded = false;
      _toastedDownloadsErrors.clear();
      state.downloads = [];
      state.requests = [];
      state.requestsPage = 1;
      state.requestsTotalPages = 1;
      state.canApproveRequests = false;
      state.issues = [];
      state.issuesPage = 1;
      state.issuesTotalPages = 1;
      state.issuesError = false;
      state.issuesPermissionDenied = false;
      state.history = [];
      state.historyPage = 1;
      state.historyTotalPages = 1;
      issueMediaCache.clear();
      state.downloadsError = false;
      state.requestsError = false;
      state.historyError = false;
      for (const node of document.querySelectorAll("#je-downloads-container, #je-downloads-container-tab")) node.replaceChildren();
      if (P.renderPage && (state.pageVisible || state._customTabMode || state._pluginPageVisible)) P.renderPage();
    });
    if (typeof unsubscribeSession === "function") life.cleanup(() => unsubscribeSession());
    const issueMediaCache = /* @__PURE__ */ new Map();
    async function fetchDownloads() {
      const lease = life.capture("downloads");
      if (!lease.current()) return null;
      try {
        const data = response(await JE.core.api.plugin("/arr/queue"));
        if (!lease.current()) return null;
        state.downloads = readItems(data.items);
        state.downloadsError = false;
        surfaceDownloadsErrors(data.errors);
        return data;
      } catch (error) {
        console.error(`${logPrefix} Failed to fetch downloads:`, error);
        if (lease.current()) {
          state.downloads = [];
          state.downloadsError = true;
        }
        return null;
      }
    }
    const _toastedDownloadsErrors = /* @__PURE__ */ new Set();
    const esc = (s) => {
      if (JE?.helpers?.escHtml) return JE.helpers.escHtml(s);
      return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    };
    function surfaceDownloadsErrors(errors) {
      if (!Array.isArray(errors) || errors.length === 0) {
        _toastedDownloadsErrors.clear();
        return;
      }
      const seenThisTick = /* @__PURE__ */ new Set();
      errors.forEach(function(value) {
        const err = response(value);
        const key = (err.source || "") + "|" + (err.instanceName || "") + "|" + (err.reason || "");
        seenThisTick.add(key);
        if (_toastedDownloadsErrors.has(key)) return;
        _toastedDownloadsErrors.add(key);
        if (typeof JE?.toast === "function") {
          JE.toast(
            "⚠ " + esc(err.source || "Arr") + ' queue "' + esc(err.instanceName || "unknown") + '" failed: ' + esc(err.reason)
          );
        }
        console.warn(`${logPrefix} ${err.source || "Arr"} queue "${err.instanceName}" error: ${err.reason}`);
      });
      Array.from(_toastedDownloadsErrors).forEach(function(k) {
        if (!seenThisTick.has(k)) _toastedDownloadsErrors.delete(k);
      });
    }
    const PAGED_LISTS = {
      requests: { grid: ".je-requests-grid", sizeKey: "requestsPageSize", max: 200 },
      issues: { grid: ".je-issues-grid", sizeKey: "issuesPageSize", max: 200 },
      history: { grid: ".je-history-grid", sizeKey: "historyPageSize", max: 48 }
    };
    function getPageSize(list) {
      const { grid: selector, max } = PAGED_LISTS[list];
      const grid = document.querySelector(selector);
      const columns = grid ? getComputedStyle(grid).gridTemplateColumns.split(" ").length : Math.max(1, Math.floor((window.innerWidth * 0.94 + 16) / 356));
      const rows = Math.min(Math.max(4, Math.ceil(12 / columns)), Math.floor(max / columns));
      return Math.min(max, columns * Math.max(1, rows));
    }
    const refetchers = { requests: () => fetchRequests(), issues: () => fetchIssues(), history: () => fetchHistory() };
    let pageSizeResizeTimer;
    life.cleanup(() => clearTimeout(pageSizeResizeTimer));
    life.listen(window, "resize", () => {
      const resizeLease = life.capture();
      clearTimeout(pageSizeResizeTimer);
      pageSizeResizeTimer = setTimeout(() => {
        if (!resizeLease.current()) return;
        const lease = resizeLease;
        const stale = ["requests", "issues", "history"].filter((list) => {
          const { grid, sizeKey } = PAGED_LISTS[list];
          return state[sizeKey] && document.querySelector(grid) && getPageSize(list) !== state[sizeKey];
        });
        if (stale.length) Promise.all(stale.map((list) => refetchers[list]())).then(() => {
          if (lease.current()) stale.forEach((list) => P.renderSection(list));
        });
      }, 250);
    });
    async function fetchRequests() {
      requestsOwner = void 0;
      const identity = life.captureIdentity();
      const lease = life.capture("requests");
      if (!lease.current()) return null;
      try {
        const pageSize = getPageSize("requests");
        if (pageSize !== state.requestsPageSize) {
          state.requestsPageSize = pageSize;
          state.requestsPage = 1;
        }
        const skip = (state.requestsPage - 1) * pageSize;
        const filter = state.requestsFilter !== "all" ? state.requestsFilter : "";
        const query = new URLSearchParams({
          take: String(pageSize),
          skip: String(skip),
          filter
        });
        const data = response(await JE.core.api.plugin(`/arr/requests?${query.toString()}`));
        if (!lease.current()) return null;
        state.requests = readItems(data.requests);
        state.requestsError = false;
        state.requestsTotalPages = pages(data.totalPages);
        state.canApproveRequests = data.canApproveRequests === true;
        requestsOwner = identity;
        return data;
      } catch (error) {
        console.error(`${logPrefix} Failed to fetch requests:`, error);
        if (lease.current()) {
          state.requests = [];
          state.requestsError = true;
          state.canApproveRequests = false;
        }
        return null;
      }
    }
    function getIssueMediaType(issue) {
      const media = issue?.media || {};
      return (media.mediaType || issue?.mediaType || issue?.type || "").toLowerCase();
    }
    function getIssueTmdbId(issue) {
      const media = issue?.media || {};
      return media.tmdbId || issue?.tmdbId || null;
    }
    function applyIssueMediaDetails(issue, details, mediaType) {
      if (!details || !issue) return issue;
      const title = details.title || details.name || details.originalTitle || details.originalName;
      const posterPath = details.posterPath || details.poster_path || null;
      const releaseDate = details.releaseDate || details.release_date || null;
      const firstAirDate = details.firstAirDate || details.first_air_date || null;
      const tmdbId = details.id || details.tmdbId || getIssueTmdbId(issue);
      const mediaInfo = details.mediaInfo || details.mediaInfo4k || details.mediaInfo4K || null;
      issue.media = {
        ...issue.media || {},
        title: title || issue.media?.title,
        name: details.name || issue.media?.name,
        originalTitle: details.originalTitle || issue.media?.originalTitle,
        originalName: details.originalName || issue.media?.originalName,
        posterPath: posterPath || issue.media?.posterPath,
        releaseDate: releaseDate || issue.media?.releaseDate,
        firstAirDate: firstAirDate || issue.media?.firstAirDate,
        tmdbId: tmdbId || issue.media?.tmdbId,
        mediaType: mediaType || issue.media?.mediaType,
        mediaInfo: mediaInfo || issue.media?.mediaInfo
      };
      return issue;
    }
    async function fetchIssueMediaDetails(mediaType, tmdbId) {
      if (mediaType !== "tv" && mediaType !== "movie" || !tmdbId || !Number.isSafeInteger(tmdbId) || tmdbId < 1) return null;
      const cacheKey = `${mediaType}:${tmdbId}`;
      if (issueMediaCache.has(cacheKey)) return issueMediaCache.get(cacheKey);
      const path = mediaType === "tv" ? `/JellyfinEnhanced/jellyseerr/tv/${tmdbId}` : `/JellyfinEnhanced/jellyseerr/movie/${tmdbId}`;
      const lease = life.capture();
      try {
        const data = response(await getApi().ajax({
          type: "GET",
          url: getApi().getUrl(path),
          dataType: "json",
          headers: { "X-Jellyfin-User-Id": getApi().getCurrentUserId() }
        }));
        const media = readMedia(data);
        if (lease.current()) {
          if (issueMediaCache.size >= 200) {
            const oldest = issueMediaCache.keys().next().value;
            if (oldest !== void 0) issueMediaCache.delete(oldest);
          }
          issueMediaCache.set(cacheKey, media);
        }
        return media;
      } catch (error) {
        console.warn(`${logPrefix} Failed to fetch issue media details:`, error);
        return null;
      }
    }
    async function fetchIssues() {
      const lease = life.capture("issues");
      if (!lease.current()) return null;
      if (!JE.pluginConfig?.JellyseerrEnabled || !JE.pluginConfig?.DownloadsPageShowIssues) {
        state.issues = [];
        state.issuesTotalPages = 1;
        state.issuesError = false;
        return null;
      }
      if (state.issuesPermissionDenied) return null;
      try {
        const pageSize = getPageSize("issues");
        if (pageSize !== state.issuesPageSize) {
          state.issuesPageSize = pageSize;
          state.issuesPage = 1;
        }
        const skip = (state.issuesPage - 1) * pageSize;
        const filter = state.issuesFilter || "open";
        const url = getApi().getUrl("/JellyfinEnhanced/jellyseerr/issue", {
          take: pageSize,
          skip,
          filter,
          sort: "added"
        });
        const data = response(await getApi().ajax({
          type: "GET",
          url,
          dataType: "json",
          headers: { "X-Jellyfin-User-Id": getApi().getCurrentUserId() }
        }));
        if (!lease.current()) return null;
        let issues = readIssues(data.results);
        if (issues.length) {
          issues = await Promise.all(
            issues.map(async (issue) => {
              const mediaType = getIssueMediaType(issue);
              const tmdbId = getIssueTmdbId(issue);
              if (!lease.current()) return issue;
              const details = await fetchIssueMediaDetails(mediaType, tmdbId);
              return applyIssueMediaDetails(issue, details, mediaType);
            })
          );
        }
        if (!lease.current()) return null;
        state.issues = issues;
        state.issuesTotalPages = pages(record(data.pageInfo) ? data.pageInfo.pages : data.totalPages);
        state.issuesError = false;
        return data;
      } catch (error) {
        console.error(`${logPrefix} Failed to fetch issues:`, error);
        if (!lease.current()) return null;
        state.issues = [];
        state.issuesTotalPages = 1;
        state.issuesError = true;
        if (record(error) && error.status === 403) {
          state.issuesPermissionDenied = true;
          if (typeof JE?.toast === "function") {
            JE.toast(JE.t?.("jellyseerr_err_no_issue_view_permission") || "No permission to view issues", 4e3);
          }
        }
        return null;
      }
    }
    async function fetchHistory() {
      if (!JE.pluginConfig?.DownloadsShowHistory) {
        state.history = [];
        state.historyVisible = false;
        return null;
      }
      const lease = life.capture("history");
      if (!lease.current()) return null;
      try {
        const pageSize = getPageSize("history");
        if (pageSize !== state.historyPageSize) {
          state.historyPageSize = pageSize;
          state.historyPage = 1;
        }
        const skip = (state.historyPage - 1) * pageSize;
        const query = new URLSearchParams({
          take: String(pageSize),
          skip: String(skip)
        });
        const data = response(await JE.core.api.plugin(`/arr/history?${query.toString()}`));
        if (!lease.current()) return null;
        state.history = readItems(data.items);
        state.historyError = state.history.length === 0 && Array.isArray(data.errors) && data.errors.length > 0;
        state.historyVisible = data.visible !== false;
        state.historyTotalPages = pages(data.totalPages);
        return data;
      } catch (error) {
        console.error(`${logPrefix} Failed to fetch history:`, error);
        if (lease.current()) {
          state.history = [];
          state.historyError = true;
        }
        return null;
      }
    }
    async function loadAllData() {
      const lease = life.capture("load");
      if (!lease.current()) return;
      state.isLoading = true;
      if (!loaded) renderPage();
      await Promise.all([fetchDownloads(), fetchRequests(), fetchIssues(), fetchHistory()]);
      if (!lease.current()) return;
      state.isLoading = false;
      loaded = true;
      if (document.querySelector(".je-request-approve-btn:hover, .je-request-decline-btn:hover, .je-request-approve-btn:focus, .je-request-decline-btn:focus")) return;
      renderPage();
    }
    async function handleRequestAction(btn, action) {
      const requestId = btn.getAttribute("data-request-id");
      if (!requestId || !/^\d+$/.test(requestId) || !btn.isConnected || btn.disabled || action !== "approve" && action !== "decline") return;
      JE.session?.checkNow?.("requests-action");
      const lease = life.capture();
      if (!lease.current() || !requestsOwner?.current()) return;
      const selected = state.requests.find((item) => String(item.id) === requestId);
      if (!selected || !state.canApproveRequests || selected.requestStatus !== 1) return;
      const mutationKey = JSON.stringify([JE.session?.getEpoch(), host.ApiClient?.serverAddress?.(), host.ApiClient?.getCurrentUserId(), requestId]);
      if (life.mutations.get(mutationKey) === "pending") return;
      for (const [key, outcome] of life.mutations) {
        if (life.mutations.size < 100) break;
        if (outcome !== "pending") life.mutations.delete(key);
      }
      life.mutations.set(mutationKey, "pending");
      btn.disabled = true;
      const icon = btn.querySelector(".material-icons");
      if (icon) icon.textContent = "hourglass_empty";
      try {
        await JE.core.api.plugin(`/arr/requests/${requestId}/${action}`, {
          method: "POST",
          skipRetry: true
        });
        life.mutations.set(mutationKey, "succeeded");
        if (!lease.current()) return;
        await fetchRequests();
        if (lease.current()) renderPage();
      } catch (err) {
        console.error(`${logPrefix} Failed to ${action} request ${requestId}:`, err);
        life.mutations.set(mutationKey, record(err) && typeof err.status === "number" && err.status >= 400 && err.status < 500 ? "failed" : "uncertain");
        if (!lease.current() || !btn.isConnected) return;
        JE.toast?.("Request action failed. Refresh to check its current status.");
        btn.disabled = false;
        if (icon) icon.textContent = action === "approve" ? "check" : "close";
      }
    }
    P.state = state;
    P.clearAvatarObjectUrlCache = JE.helpers.clearAvatarObjectUrlCache;
    P.hydrateAvatarImages = JE.helpers.hydrateAvatarImages;
    P.fetchRequests = fetchRequests;
    P.fetchIssues = fetchIssues;
    P.fetchHistory = fetchHistory;
    P.getIssueMediaType = getIssueMediaType;
    P.getIssueTmdbId = getIssueTmdbId;
    P.loadAllData = loadAllData;
    P.handleRequestAction = handleRequestAction;
  }

  // client/src/features/downloads/data-entry.ts
  install(export0());
})();
})();
//# sourceMappingURL=requests-page-data.js.map
