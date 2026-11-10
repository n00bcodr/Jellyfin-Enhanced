(() => {
"use strict";
(() => {
  // client/src/host/context.ts
  function sharedModule(id) {
    const namespace = window.JellyfinEnhanced?.core?.sharedModules?.[id];
    if (!namespace) throw new Error(`${id} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);
    return namespace;
  }
  function sharedExport(namespace, name) {
    return namespace[name];
  }

  // client/generated-shared/stub/client/src/features/downloads/host.ts
  var shared = /* @__PURE__ */ sharedModule("features/downloads/host");
  var export0 = /* @__PURE__ */ sharedExport(shared, "downloadsHost");

  // client/generated-shared/stub/client/src/features/downloads/runtime.ts
  var shared2 = /* @__PURE__ */ sharedModule("features/downloads/runtime");
  var export02 = /* @__PURE__ */ sharedExport(shared2, "runtime");

  // client/src/features/downloads/actions.ts
  function install(deps) {
    const { JE, P, host, getApi } = deps;
    const life = export02(deps);
    if (life.installed.has("actions")) return;
    life.installed.add("actions");
    const state = P.state;
    const renderPage = P.renderPage;
    const renderSection = P.renderSection;
    const fetchRequests = () => {
      const lease = life.capture();
      return P.fetchRequests().then(() => lease);
    };
    const fetchIssues = () => {
      const lease = life.capture();
      return P.fetchIssues().then(() => lease);
    };
    const fetchHistory = () => {
      const lease = life.capture();
      return P.fetchHistory().then(() => lease);
    };
    function filterDownloads(status) {
      state.downloadsActiveTab = status;
      state.downloadsSearchQuery = "";
      renderPage();
    }
    function searchDownloads(query) {
      state.downloadsSearchQuery = query;
      renderPage();
    }
    function filterRequests(filter) {
      state.requestsFilter = filter;
      state.requestsPage = 1;
      fetchRequests().then((lease) => {
        if (lease.current()) renderSection("requests");
      });
    }
    function filterIssues(filter) {
      if (!filter || filter !== "open" && filter !== "resolved") return;
      if (state.issuesFilter === filter) return;
      state.issuesFilter = filter;
      state.issuesPage = 1;
      fetchIssues().then((lease) => {
        if (lease.current()) renderSection("issues");
      });
    }
    function nextPage() {
      if (state.requestsPage < state.requestsTotalPages) {
        state.requestsPage++;
        fetchRequests().then((lease) => {
          if (lease.current()) renderSection("requests");
        });
      }
    }
    function prevPage() {
      if (state.requestsPage > 1) {
        state.requestsPage--;
        fetchRequests().then((lease) => {
          if (lease.current()) renderSection("requests");
        });
      }
    }
    function nextIssuesPage() {
      if (state.issuesPage < state.issuesTotalPages) {
        state.issuesPage++;
        fetchIssues().then((lease) => {
          if (lease.current()) renderSection("issues");
        });
      }
    }
    function prevIssuesPage() {
      if (state.issuesPage > 1) {
        state.issuesPage--;
        fetchIssues().then((lease) => {
          if (lease.current()) renderSection("issues");
        });
      }
    }
    function nextHistoryPage() {
      if (state.historyPage < state.historyTotalPages) {
        state.historyPage++;
        fetchHistory().then((lease) => {
          if (lease.current()) renderSection("history");
        });
      }
    }
    function prevHistoryPage() {
      if (state.historyPage > 1) {
        state.historyPage--;
        fetchHistory().then((lease) => {
          if (lease.current()) renderSection("history");
        });
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

  // client/src/features/downloads/actions-entry.ts
  install(export0());
})();
})();
//# sourceMappingURL=requests-page-actions.js.map
