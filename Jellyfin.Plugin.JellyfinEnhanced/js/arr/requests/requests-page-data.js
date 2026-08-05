// /js/arr/requests/requests-page-data.js
// Requests Page — state and data access (split from requests-page.js).
// JSON calls use JE.core.api.plugin; shared authenticated avatar handling
// lives in JE.helpers so the More Info modal can reuse the same blob cache.
(function () {
  "use strict";

  const JE = window.JellyfinEnhanced;
  JE.internals = JE.internals || {};
  const P = (JE.internals.requestsPage = JE.internals.requestsPage || {});

  // requests-page-render.js loads after this module — resolve renderPage at call
  // time. Forwards arguments: renderPage(targetContainer) is used by custom-tab
  // mode to render into a container other than the standalone page.
  const renderPage = (...args) => P.renderPage(...args);

  const logPrefix = '🪼 Jellyfin Enhanced: Requests Page:';

  // State management
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
    _customTabContainer: null,
  };

  // Requests/issues/history and the approve permission all belong to the
  // signed-in Seerr-linked user — wipe them on a user switch so the page
  // re-fetches as the new user instead of rendering the previous user's data.
  JE.session?.onUserChange('requests-page', () => {
    state.downloads = [];
    state.requests = [];
    state.requestsPage = 1;
    state.requestsTotalPages = 1;
    state.canApproveRequests = false;
    state.issues = [];
    state.issuesPage = 1;
    state.issuesTotalPages = 1;
    state.issuesError = false;
    state.history = [];
    state.historyPage = 1;
    state.historyTotalPages = 1;
    issueMediaCache.clear();
  });

  const issueMediaCache = new Map();

  /**
   * Fetch download queue from backend
   */
  async function fetchDownloads() {
    try {
      const data = await JE.core.api.plugin("/arr/queue");
      state.downloads = data.items || [];
      // Surface per-instance queue errors so a 401 / timeout / SSRF-reject on one
      // instance doesn't silently produce a "looks empty" downloads page.
      surfaceDownloadsErrors(data.errors);
      return data;
    } catch (error) {
      console.error(`${logPrefix} Failed to fetch downloads:`, error);
      state.downloads = [];
      return null;
    }
  }

  // Once-per-session dedup. Self-heals: when an error stops appearing in a subsequent fetch
  // the memo entry is dropped so future occurrences re-toast.
  const _toastedDownloadsErrors = new Set();
  // Alias the shared HTML-escape helper (JE.toast uses innerHTML).
  // The inline fallback is a real escaper so XSS is blocked even if helpers.js
  // hasn't loaded yet (e.g. a load-order race on first init).
  const esc = (s) => {
    if (window.JellyfinEnhanced?.helpers?.escHtml) return window.JellyfinEnhanced.helpers.escHtml(s);
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  };
  function surfaceDownloadsErrors(errors) {
    if (!Array.isArray(errors) || errors.length === 0) {
      _toastedDownloadsErrors.clear();
      return;
    }
    const seenThisTick = new Set();
    errors.forEach(function(err) {
      const key = (err.source || "") + "|" + (err.instanceName || "") + "|" + (err.reason || "");
      seenThisTick.add(key);
      if (_toastedDownloadsErrors.has(key)) return;
      _toastedDownloadsErrors.add(key);
      if (typeof window.JellyfinEnhanced?.toast === "function") {
        window.JellyfinEnhanced.toast(
          "⚠ " + esc(err.source || "Arr") + " queue \"" +
          esc(err.instanceName || "unknown") + "\" failed: " + esc(err.reason)
        );
      }
      console.warn(`${logPrefix} ${err.source || "Arr"} queue "${err.instanceName}" error: ${err.reason}`);
    });
    Array.from(_toastedDownloadsErrors).forEach(function(k) {
      if (!seenThisTick.has(k)) _toastedDownloadsErrors.delete(k);
    });
  }

  /**
   * Fetch requests from backend
   */
  async function fetchRequests() {
    try {
      const skip = (state.requestsPage - 1) * 20;
      const filter = state.requestsFilter !== "all" ? state.requestsFilter : "";

      const query = new URLSearchParams({
        take: "20",
        skip: String(skip),
        filter: filter,
      });

      const data = await JE.core.api.plugin(`/arr/requests?${query.toString()}`);

      state.requests = data.requests || [];
      state.requestsTotalPages = data.totalPages || 1;
      state.canApproveRequests = data.canApproveRequests === true;

      return data;
    } catch (error) {
      console.error(`${logPrefix} Failed to fetch requests:`, error);
      state.requests = [];
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
      ...(issue.media || {}),
      title: title || issue.media?.title,
      name: details.name || issue.media?.name,
      originalTitle: details.originalTitle || issue.media?.originalTitle,
      originalName: details.originalName || issue.media?.originalName,
      posterPath: posterPath || issue.media?.posterPath,
      releaseDate: releaseDate || issue.media?.releaseDate,
      firstAirDate: firstAirDate || issue.media?.firstAirDate,
      tmdbId: tmdbId || issue.media?.tmdbId,
      mediaType: mediaType || issue.media?.mediaType,
      mediaInfo: mediaInfo || issue.media?.mediaInfo,
    };

    return issue;
  }

  async function fetchIssueMediaDetails(mediaType, tmdbId) {
    if (!mediaType || !tmdbId) return null;
    const cacheKey = `${mediaType}:${tmdbId}`;
    if (issueMediaCache.has(cacheKey)) return issueMediaCache.get(cacheKey);

    const path = mediaType === "tv"
      ? `/JellyfinEnhanced/jellyseerr/tv/${tmdbId}`
      : `/JellyfinEnhanced/jellyseerr/movie/${tmdbId}`;

    try {
      const data = await ApiClient.ajax({
        type: "GET",
        url: ApiClient.getUrl(path),
        dataType: "json",
        headers: { "X-Jellyfin-User-Id": ApiClient.getCurrentUserId() },
      });
      issueMediaCache.set(cacheKey, data || null);
      return data || null;
    } catch (error) {
      issueMediaCache.set(cacheKey, null);
      return null;
    }
  }

  /**
   * Fetch issues from Jellyseerr
   */
  async function fetchIssues() {
    if (!JE.pluginConfig?.JellyseerrEnabled || !JE.pluginConfig?.DownloadsPageShowIssues) {
      state.issues = [];
      state.issuesTotalPages = 1;
      state.issuesError = false;
      return null;
    }
    // Stop trying if we already know the user lacks VIEW_ISSUES permission
    if (state.issuesPermissionDenied) return null;

    try {
      const skip = (state.issuesPage - 1) * 20;
      const filter = state.issuesFilter || "open";
      const url = ApiClient.getUrl("/JellyfinEnhanced/jellyseerr/issue", {
        take: 20,
        skip: skip,
        filter: filter,
        sort: "added",
      });

      const data = await ApiClient.ajax({
        type: "GET",
        url: url,
        dataType: "json",
        headers: { "X-Jellyfin-User-Id": ApiClient.getCurrentUserId() },
      });

      let issues = data?.results || [];
      if (issues.length) {
        issues = await Promise.all(
          issues.map(async (issue) => {
            const mediaType = getIssueMediaType(issue);
            const tmdbId = getIssueTmdbId(issue);
            const details = await fetchIssueMediaDetails(mediaType, tmdbId);
            return applyIssueMediaDetails(issue, details, mediaType);
          })
        );
      }

      state.issues = issues;
      state.issuesTotalPages = data?.pageInfo?.pages || data?.totalPages || 1;
      state.issuesError = false;
      return data;
    } catch (error) {
      console.error(`${logPrefix} Failed to fetch issues:`, error);
      state.issues = [];
      state.issuesTotalPages = 1;
      state.issuesError = true;
      // 403 = no VIEW_ISSUES permission — surface once as a toast, then stop polling issues
      if (error?.status === 403) {
        state.issuesPermissionDenied = true;
        if (typeof JE?.toast === 'function') {
          JE.toast(JE.t?.('jellyseerr_err_no_issue_view_permission') || 'No permission to view issues', 4000);
        }
      }
      return null;
    }
  }

  /**
   * Fetch bounded ARR download history (recently imported/failed items) from backend
   */
  async function fetchHistory() {
    if (!JE.pluginConfig?.DownloadsShowHistory) {
      state.history = [];
      state.historyVisible = false;
      return null;
    }

    try {
      const skip = (state.historyPage - 1) * 20;

      const query = new URLSearchParams({
        take: "20",
        skip: String(skip),
      });

      const data = await JE.core.api.plugin(`/arr/history?${query.toString()}`);

      state.history = data.items || [];
      state.historyVisible = data.visible !== false;
      state.historyTotalPages = data.totalPages || 1;
      return data;
    } catch (error) {
      console.error(`${logPrefix} Failed to fetch history:`, error);
      state.history = [];
      return null;
    }
  }

  /**
   * Load all data
   */
  async function loadAllData() {
    state.isLoading = true;
    renderPage();

    await Promise.all([fetchDownloads(), fetchRequests(), fetchIssues(), fetchHistory()]);

    state.isLoading = false;
    renderPage();
  }

  async function handleRequestAction(btn, action) {
    const requestId = btn.getAttribute('data-request-id');
    if (!requestId) return;

    btn.disabled = true;
    const icon = btn.querySelector('.material-icons');
    if (icon) icon.textContent = 'hourglass_empty';

    try {
      // skipRetry: approving/declining is not idempotent — never auto-repeat it.
      await JE.core.api.plugin(`/arr/requests/${requestId}/${action}`, {
        method: 'POST',
        skipRetry: true,
      });
      await fetchRequests();
      renderPage();
    } catch (err) {
      console.error(`${logPrefix} Failed to ${action} request ${requestId}:`, err);
      btn.disabled = false;
      if (icon) icon.textContent = action === 'approve' ? 'check' : 'close';
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
})();
