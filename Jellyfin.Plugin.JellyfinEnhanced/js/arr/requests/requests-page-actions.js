// /js/arr/requests/requests-page-actions.js
// Requests Page — user actions: downloads tab filtering/search, request and
// issue filter tabs and pagination (split from requests-page.js).
(function () {
  "use strict";

  const JE = window.JellyfinEnhanced;
  JE.internals = JE.internals || {};
  const P = (JE.internals.requestsPage = JE.internals.requestsPage || {});

  const state = P.state;
  const renderPage = P.renderPage;
  const fetchRequests = P.fetchRequests;
  const fetchIssues = P.fetchIssues;
  const fetchHistory = P.fetchHistory;

  /**
   * Filter downloads by status
   */
  function filterDownloads(status) {
    state.downloadsActiveTab = status;
    state.downloadsSearchQuery = "";
    renderPage();
  }

  /**
   * Search downloads
   */
  function searchDownloads(query) {
    state.downloadsSearchQuery = query;
    renderPage();
  }

  /**
   * Filter requests
   */
  function filterRequests(filter) {
    state.requestsFilter = filter;
    state.requestsPage = 1;
    fetchRequests().then(() => renderPage());
  }

  function filterIssues(filter) {
    if (!filter || (filter !== "open" && filter !== "resolved")) return;
    if (state.issuesFilter === filter) return;
    state.issuesFilter = filter;
    state.issuesPage = 1;
    fetchIssues().then(() => renderPage());
  }

  /**
   * Next page
   */
  function nextPage() {
    if (state.requestsPage < state.requestsTotalPages) {
      state.requestsPage++;
      fetchRequests().then(() => renderPage());
    }
  }

  /**
   * Previous page
   */
  function prevPage() {
    if (state.requestsPage > 1) {
      state.requestsPage--;
      fetchRequests().then(() => renderPage());
    }
  }

  function nextIssuesPage() {
    if (state.issuesPage < state.issuesTotalPages) {
      state.issuesPage++;
      fetchIssues().then(() => renderPage());
    }
  }

  function prevIssuesPage() {
    if (state.issuesPage > 1) {
      state.issuesPage--;
      fetchIssues().then(() => renderPage());
    }
  }

  function nextHistoryPage() {
    if (state.historyPage < state.historyTotalPages) {
      state.historyPage++;
      fetchHistory().then(() => renderPage());
    }
  }

  function prevHistoryPage() {
    if (state.historyPage > 1) {
      state.historyPage--;
      fetchHistory().then(() => renderPage());
    }
  }

  P.filterDownloads = filterDownloads;
  P.searchDownloads = searchDownloads;
  P.filterRequests = filterRequests;
  P.filterIssues = filterIssues;
  P.nextPage = nextPage;
  P.prevPage = prevPage;
  P.nextIssuesPage = nextIssuesPage;
  P.prevIssuesPage = prevIssuesPage;
  P.nextHistoryPage = nextHistoryPage;
  P.prevHistoryPage = prevHistoryPage;
})();
