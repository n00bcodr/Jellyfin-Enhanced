import type { Dependencies, Issue, Media, State, List, Page } from "./types";
import { record, readItems, readIssues, readMedia, response, pages } from "./validation";
import { runtime, type Lease } from './runtime';
export function install(deps: Dependencies) {
  const {JE, P, host, getApi} = deps;
  const life = runtime(deps);
  if(life.installed.has('data'))return;
  life.installed.add('data');

  



  // requests-page-render.js loads after this module — resolve renderPage at call
  // time. Forwards arguments: renderPage(targetContainer) is used by custom-tab
  // mode to render into a container other than the standalone page.
  const renderPage = (...args: Parameters<Page["renderPage"]>) => P.renderPage(...args);

  const logPrefix = '🪼 Jellyfin Enhanced: Requests Page:';

  // State management
  let requestsOwner: Lease | undefined;
  /** Whether this account's data has been loaded once; until then a load shows the loading state. */
  let loaded = false;
  const state: State = {
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
  const unsubscribeSession=JE.session?.onUserChange('requests-page', () => {
    life.invalidate();
    requestsOwner=undefined;
    loaded=false;
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
    state.issuesPermissionDenied = false; // sticky 403 gate belongs to the previous user
    state.history = [];
    state.historyPage = 1;
    state.historyTotalPages = 1;
    issueMediaCache.clear();
    state.downloadsError=false;state.requestsError=false;state.historyError=false;
    for(const node of document.querySelectorAll('#je-downloads-container, #je-downloads-container-tab'))node.replaceChildren();
    // Keep an existing poll lifetime: its next tick uses the new account.
    if(P.renderPage && (state.pageVisible || state._customTabMode || state._pluginPageVisible))P.renderPage();
  });

  if(typeof unsubscribeSession==='function')life.cleanup(()=>unsubscribeSession());

  const issueMediaCache = new Map<string, Media|null>();

  /**
   * Fetch download queue from backend
   */
  async function fetchDownloads() {
    const lease=life.capture("downloads");
    if(!lease.current())return null;
    try {
      const data = response(await JE.core.api.plugin("/arr/queue"));
      if (!lease.current()) return null;
      state.downloads = readItems(data.items);state.downloadsError=false;
      // Surface per-instance queue errors so a 401 / timeout / SSRF-reject on one
      // instance doesn't silently produce a "looks empty" downloads page.
      surfaceDownloadsErrors(data.errors);
      return data;
    } catch (error) {
      console.error(`${logPrefix} Failed to fetch downloads:`, error);
      if (lease.current()) {state.downloads = [];state.downloadsError=true;}
      return null;
    }
  }

  // Once-per-session dedup. Self-heals: when an error stops appearing in a subsequent fetch
  // the memo entry is dropped so future occurrences re-toast.
  const _toastedDownloadsErrors = new Set<string>();
  // Alias the shared HTML-escape helper (JE.toast uses innerHTML).
  // The inline fallback is a real escaper so XSS is blocked even if helpers.js
  // hasn't loaded yet (e.g. a load-order race on first init).
  const esc = (s: unknown) => {
    if (JE?.helpers?.escHtml) return JE.helpers.escHtml(s);
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  };
  function surfaceDownloadsErrors(errors: unknown) {
    if (!Array.isArray(errors) || errors.length === 0) {
      _toastedDownloadsErrors.clear();
      return;
    }
    const seenThisTick = new Set<string>();
    errors.forEach(function(value: unknown) {
      const err = response(value);
      const key = (err.source || "") + "|" + (err.instanceName || "") + "|" + (err.reason || "");
      seenThisTick.add(key);
      if (_toastedDownloadsErrors.has(key)) return;
      _toastedDownloadsErrors.add(key);
      if (typeof JE?.toast === "function") {
        JE.toast(
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
   * Epoch captured before a fetch: a response resolving after a user switch
   * must not write the previous user's data (or a stale 403 latch) into the
   * freshly reset state.
   * @returns {number}
   */


  // The three paged lists share one grid layout, so each page holds whole rows.
  // History's endpoint caps a page at 50 cards.
  const PAGED_LISTS = {
    requests: { grid: ".je-requests-grid", sizeKey: "requestsPageSize", max: 200 },
    issues: { grid: ".je-issues-grid", sizeKey: "issuesPageSize", max: 200 },
    history: { grid: ".je-history-grid", sizeKey: "historyPageSize", max: 48 },
  } as const;

  /**
   * Cards per page for a list: whole rows of its grid, so a wide window never
   * ends on a partial row. Uses the live column count when the grid is on
   * screen, otherwise estimates it from the viewport (340px columns, 1.1em gap).
   * @param {"requests"|"issues"|"history"} list
   * @returns {number}
   */
  function getPageSize(list: List) {
    const { grid: selector, max } = PAGED_LISTS[list];
    const grid = document.querySelector(selector);
    const columns = grid
      ? getComputedStyle(grid).gridTemplateColumns.split(" ").length
      : Math.max(1, Math.floor((window.innerWidth * 0.94 + 16) / 356));
    const rows = Math.min(Math.max(4, Math.ceil(12 / columns)), Math.floor(max / columns));
    return Math.min(max, columns * Math.max(1, rows));
  }

  // The window can be resized across a column-count boundary: refetch with the
  // new page size so the last row stays full.
  const refetchers = { requests: () => fetchRequests(), issues: () => fetchIssues(), history: () => fetchHistory() };
  let pageSizeResizeTimer: number | undefined;
  life.cleanup(()=>clearTimeout(pageSizeResizeTimer));
  life.listen(window,"resize", () => {
    const resizeLease=life.capture();
    clearTimeout(pageSizeResizeTimer);
    pageSizeResizeTimer = setTimeout(() => {
      if(!resizeLease.current())return;
      const lease=resizeLease;
      const stale = (["requests", "issues", "history"] as const).filter((list) => {
        const { grid, sizeKey } = PAGED_LISTS[list];
        return state[sizeKey] && document.querySelector(grid) && getPageSize(list) !== state[sizeKey];
      });
      if (stale.length) Promise.all(stale.map((list) => refetchers[list]())).then(() => {if(lease.current())stale.forEach((list) => P.renderSection(list));});
    }, 250);
  });

  /**
   * Fetch requests from backend
   */
  async function fetchRequests() {
    requestsOwner=undefined;
    const identity=life.captureIdentity();
    const lease = life.capture('requests');
    if(!lease.current())return null;
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
        filter: filter,
      });

      const data = response(await JE.core.api.plugin(`/arr/requests?${query.toString()}`));
      if (!lease.current()) return null;

      state.requests = readItems(data.requests);state.requestsError=false;
      state.requestsTotalPages = pages(data.totalPages);
      state.canApproveRequests = data.canApproveRequests === true;
      requestsOwner=identity;

      return data;
    } catch (error) {
      console.error(`${logPrefix} Failed to fetch requests:`, error);
      if (lease.current()) {state.requests = [];state.requestsError=true;state.canApproveRequests=false;}
      return null;
    }
  }

  function getIssueMediaType(issue: Issue) {
    const media = issue?.media || {};
    return (media.mediaType || issue?.mediaType || issue?.type || "").toLowerCase();
  }

  function getIssueTmdbId(issue: Issue) {
    const media = issue?.media || {};
    return media.tmdbId || issue?.tmdbId || null;
  }

  function applyIssueMediaDetails(issue: Issue, details: Media|null|undefined, mediaType: string) {
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

  async function fetchIssueMediaDetails(mediaType: string, tmdbId: number|null) {
    if ((mediaType!=="tv" && mediaType!=="movie") || !tmdbId || !Number.isSafeInteger(tmdbId) || tmdbId<1) return null;
    const cacheKey = `${mediaType}:${tmdbId}`;
    if (issueMediaCache.has(cacheKey)) return issueMediaCache.get(cacheKey);

    const path = mediaType === "tv"
      ? `/JellyfinEnhanced/jellyseerr/tv/${tmdbId}`
      : `/JellyfinEnhanced/jellyseerr/movie/${tmdbId}`;

    // Seerr media details carry per-user request state — don't let a
    // response spanning a user switch repopulate the reset cache.
    const lease = life.capture();
    try {
      const data = response(await getApi().ajax({
        type: "GET",
        url: getApi().getUrl(path),
        dataType: "json",
        headers: { "X-Jellyfin-User-Id": getApi().getCurrentUserId() },
      }));
      const media = readMedia(data);
      if (lease.current()) {
        if(issueMediaCache.size>=200){const oldest=issueMediaCache.keys().next().value;if(oldest!==undefined)issueMediaCache.delete(oldest);}
        issueMediaCache.set(cacheKey, media);
      }
      return media;
    } catch (error) {
      // Not cached: a transient failure must not blank this issue's media until the cache clears,
      // and only answers count against the cache cap. The next load asks again.
      console.warn(`${logPrefix} Failed to fetch issue media details:`, error);
      return null;
    }
  }

  /**
   * Fetch issues from Jellyseerr
   */
  async function fetchIssues() {
    const lease = life.capture('issues');
    if(!lease.current())return null;
    if (!JE.pluginConfig?.JellyseerrEnabled || !JE.pluginConfig?.DownloadsPageShowIssues) {
      state.issues = [];
      state.issuesTotalPages = 1;
      state.issuesError = false;
      return null;
    }
    // Stop trying if we already know the user lacks VIEW_ISSUES permission
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
        skip: skip,
        filter: filter,
        sort: "added",
      });

      const data = response(await getApi().ajax({
        type: "GET",
        url: url,
        dataType: "json",
        headers: { "X-Jellyfin-User-Id": getApi().getCurrentUserId() },
      }));

      if (!lease.current())return null;
      let issues = readIssues(data.results);
      if (issues.length) {
        issues = await Promise.all(
          issues.map(async (issue) => {
            const mediaType = getIssueMediaType(issue);
            const tmdbId = getIssueTmdbId(issue);
            if (!lease.current())return issue;
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
      if (!lease.current()) return null; // stale failure (incl. 403) belongs to the previous user
      state.issues = [];
      state.issuesTotalPages = 1;
      state.issuesError = true;
      // 403 = no VIEW_ISSUES permission — surface once as a toast, then stop polling issues
      if (record(error) && error.status === 403) {
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

    const lease = life.capture('history');
    if(!lease.current())return null;
    try {
      const pageSize = getPageSize("history");
      if (pageSize !== state.historyPageSize) {
        state.historyPageSize = pageSize;
        state.historyPage = 1;
      }
      const skip = (state.historyPage - 1) * pageSize;

      const query = new URLSearchParams({
        take: String(pageSize),
        skip: String(skip),
      });

      const data = response(await JE.core.api.plugin(`/arr/history?${query.toString()}`));
      if (!lease.current()) return null;

      state.history = readItems(data.items);
      // Nothing to show while an instance failed is not "no history".
      state.historyError = state.history.length === 0 && Array.isArray(data.errors) && data.errors.length > 0;
      state.historyVisible = data.visible !== false;
      state.historyTotalPages = pages(data.totalPages);
      return data;
    } catch (error) {
      console.error(`${logPrefix} Failed to fetch history:`, error);
      if (lease.current()) {state.history = [];state.historyError=true;}
      return null;
    }
  }

  /**
   * Load all data
   */
  async function loadAllData() {
    const lease=life.capture("load");
    if(!lease.current())return;
    state.isLoading = true;
    // A poll or refresh keeps the cards on screen; only a page with nothing loaded yet shows the loading state.
    if (!loaded) renderPage();

    await Promise.all([fetchDownloads(), fetchRequests(), fetchIssues(), fetchHistory()]);

    if(!lease.current())return;
    state.isLoading = false;
    loaded = true;
    // A list that moved under a pointer or focus resting on Approve or Decline would take the click to another
    // request: leave the page as it is until the next poll or refresh.
    if (document.querySelector('.je-request-approve-btn:hover, .je-request-decline-btn:hover, .je-request-approve-btn:focus, .je-request-decline-btn:focus')) return;
    renderPage();
  }

  async function handleRequestAction(btn: HTMLButtonElement, action: 'approve'|'decline') {
    const requestId = btn.getAttribute('data-request-id');
    if (!requestId || !/^\d+$/.test(requestId) || !btn.isConnected || btn.disabled || (action!=='approve' && action!=='decline')) return;
    JE.session?.checkNow?.('requests-action');
    const lease=life.capture();
    if(!lease.current() || !requestsOwner?.current())return;
    const selected=state.requests.find(item=>String(item.id)===requestId);
    if(!selected || !state.canApproveRequests || selected.requestStatus!==1)return;
    const mutationKey=JSON.stringify([JE.session?.getEpoch(),host.ApiClient?.serverAddress?.(),host.ApiClient?.getCurrentUserId(),requestId]);
    if(life.mutations.get(mutationKey)==='pending')return;
    for(const [key,outcome] of life.mutations){if(life.mutations.size<100)break;if(outcome!=='pending')life.mutations.delete(key);}
    life.mutations.set(mutationKey,'pending');

    btn.disabled = true;
    const icon = btn.querySelector('.material-icons');
    if (icon) icon.textContent = 'hourglass_empty';

    try {
      // skipRetry: approving/declining is not idempotent — never auto-repeat it.
      await JE.core.api.plugin(`/arr/requests/${requestId}/${action}`, {
        method: 'POST',
        skipRetry: true,
      });
      life.mutations.set(mutationKey,'succeeded');
      if(!lease.current())return;
      await fetchRequests();
      if(lease.current())renderPage();
    } catch (err) {
      console.error(`${logPrefix} Failed to ${action} request ${requestId}:`, err);
      life.mutations.set(mutationKey,record(err) && typeof err.status==='number' && err.status>=400 && err.status<500 ? 'failed' : 'uncertain');
      if(!lease.current() || !btn.isConnected)return;
      JE.toast?.('Request action failed. Refresh to check its current status.');
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

}
