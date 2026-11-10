import type { Dependencies } from "./types";

import { runtime } from './runtime';
export function install(deps: Dependencies) {
  const {JE, P, host, getApi} = deps;
  const life = runtime(deps);
  if(life.installed.has('actions'))return;
  life.installed.add('actions');

  



  const state = P.state;
  const renderPage = P.renderPage;
  const renderSection = P.renderSection;
  const fetchRequests = () => {const lease=life.capture();return P.fetchRequests().then(()=>lease);};
  const fetchIssues = () => {const lease=life.capture();return P.fetchIssues().then(()=>lease);};
  const fetchHistory = () => {const lease=life.capture();return P.fetchHistory().then(()=>lease);};

  /**
   * Filter downloads by status
   */
  function filterDownloads(status: string) {
    state.downloadsActiveTab = status;
    state.downloadsSearchQuery = "";
    renderPage();
  }

  /**
   * Search downloads
   */
  function searchDownloads(query: string) {
    state.downloadsSearchQuery = query;
    renderPage();
  }

  /**
   * Filter requests
   */
  function filterRequests(filter: string) {
    state.requestsFilter = filter;
    state.requestsPage = 1;
    fetchRequests().then(lease => {if(lease.current())renderSection("requests");});
  }

  function filterIssues(filter: string) {
    if (!filter || (filter !== "open" && filter !== "resolved")) return;
    if (state.issuesFilter === filter) return;
    state.issuesFilter = filter;
    state.issuesPage = 1;
    fetchIssues().then(lease => {if(lease.current())renderSection("issues");});
  }

  /**
   * Next page
   */
  function nextPage() {
    if (state.requestsPage < state.requestsTotalPages) {
      state.requestsPage++;
      fetchRequests().then(lease => {if(lease.current())renderSection("requests");});
    }
  }

  /**
   * Previous page
   */
  function prevPage() {
    if (state.requestsPage > 1) {
      state.requestsPage--;
      fetchRequests().then(lease => {if(lease.current())renderSection("requests");});
    }
  }

  function nextIssuesPage() {
    if (state.issuesPage < state.issuesTotalPages) {
      state.issuesPage++;
      fetchIssues().then(lease => {if(lease.current())renderSection("issues");});
    }
  }

  function prevIssuesPage() {
    if (state.issuesPage > 1) {
      state.issuesPage--;
      fetchIssues().then(lease => {if(lease.current())renderSection("issues");});
    }
  }

  function nextHistoryPage() {
    if (state.historyPage < state.historyTotalPages) {
      state.historyPage++;
      fetchHistory().then(lease => {if(lease.current())renderSection("history");});
    }
  }

  function prevHistoryPage() {
    if (state.historyPage > 1) {
      state.historyPage--;
      fetchHistory().then(lease => {if(lease.current())renderSection("history");});
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

}
