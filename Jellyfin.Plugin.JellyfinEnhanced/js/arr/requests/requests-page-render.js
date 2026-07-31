// /js/arr/requests/requests-page-render.js
// Requests Page — full page rendering (downloads/requests/issues sections)
// and the page container shell (split from requests-page.js).
(function () {
  "use strict";

  const JE = window.JellyfinEnhanced;
  JE.internals = JE.internals || {};
  const P = (JE.internals.requestsPage = JE.internals.requestsPage || {});

  const state = P.state;
  const translateStatus = P.translateStatus;
  const getDownloadStatuses = P.getDownloadStatuses;
  const getFilteredDownloads = P.getFilteredDownloads;
  const groupDownloads = P.groupDownloads;
  const renderDownloadCard = P.renderDownloadCard;
  const renderRequestCard = P.renderRequestCard;
  const renderIssueCard = P.renderIssueCard;
  const renderHistoryCard = P.renderHistoryCard;
  const renderSeasonPackCard = P.renderSeasonPackCard;
  const clearAvatarObjectUrlCache = P.clearAvatarObjectUrlCache;
  const hydrateAvatarImages = P.hydrateAvatarImages;
  const loadAllData = P.loadAllData;
  const handleRequestAction = P.handleRequestAction;

  /**
   * Render the full page.
   * @param {HTMLElement} [targetContainer] - Optional container to render into
   *   (used by custom-tab mode to avoid duplicate-ID conflicts).
   */
  function renderPage(targetContainer) {
    let container;
    if (targetContainer) {
      state._customTabContainer = targetContainer;
      container = targetContainer;
    } else if (state._customTabContainer && document.contains(state._customTabContainer)
      && window.location.hash.indexOf('userpluginsettings') === -1) {
      // Re-use stored custom tab container, but not on Plugin Pages route
      container = state._customTabContainer;
    } else {
      state._customTabContainer = null;
      container = document.getElementById("je-downloads-container");
      if (!container) return;
    }

    let html = "";

    // Active Downloads Section - only shows if ShowDownloadsInRequests is enabled
    const showDownloads = JE.pluginConfig?.ShowDownloadsInRequests !== false;

    if (showDownloads) {
      html += `<div class="je-downloads-section je-active-downloads-section" style="margin-top: 2em;">`;
      const labelActiveDownloads = (JE.t && JE.t('requests_downloads')) || 'Downloads';

    html += `
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 1em;">
        <h2 style="margin: 0.5em 0 0 0;">${labelActiveDownloads}</h2>
        <button class="je-refresh-btn emby-button" style="background: transparent; border: 1px solid rgba(255,255,255,0.3); color: inherit; padding: 0.5em; border-radius: 10px; cursor: pointer; display: flex; align-items: center; gap: 0.5em; opacity: 0.8; transition: all 0.2s;">
          <span class="material-icons" style="font-size: 18px;">refresh</span>
        </button>
      </div>
    `;

    if (state.isLoading && state.downloads.length === 0) {
      html += `<div class="je-loading">...</div>`;
    } else if (state.downloads.length === 0) {
      const labelNoActiveDownloads = (JE.t && JE.t('requests_no_active_downloads')) || 'No active downloads';
      html += `
        <div class="je-empty-state">
          <div>${labelNoActiveDownloads}</div>
        </div>
      `;
    } else {
      // Get statuses and pagination info
      const statuses = getDownloadStatuses();
      const showSearchBar = state.downloads.length > 0; // Show search when there are any downloads

      // Render tabs and search
      if (statuses.length > 1 || showSearchBar) {
        html += `<div class="je-downloads-controls">`;

        // Render tabs if there are multiple statuses
        if (statuses.length > 1) {
          // Calculate total count from grouped downloads
          const totalGroupedCount = statuses.reduce((sum, [_, count]) => sum + count, 0);

          html += `<div class="je-downloads-tabs">`;
          html += `<button is="emby-button" type="button" class="je-downloads-tab emby-button ${state.downloadsActiveTab === "all" ? "active" : ""}" data-tab="all">
            <span>${translateStatus("All")}</span>
            <span class="je-downloads-tab-count">${totalGroupedCount}</span>
          </button>`;

          for (const [status, count] of statuses) {
            html += `<button is="emby-button" type="button" class="je-downloads-tab emby-button ${state.downloadsActiveTab === status ? "active" : ""}" data-tab="${status}">
              <span>${translateStatus(status)}</span>
              <span class="je-downloads-tab-count">${count}</span>
            </button>`;
          }

          // Add search icon button after tabs
          if (showSearchBar) {
            html += `<button class="je-downloads-search-toggle ${state.downloadsSearchVisible ? 'active' : ''}">
              <span class="material-icons">search</span>
            </button>`;
          }

          html += `</div>`;
        }

        // Render search input if visible
        if (showSearchBar && state.downloadsSearchVisible) {
          html += `<div class="je-downloads-search-container">
            <span class="material-icons je-downloads-search-icon">search</span>
            <input type="text" class="je-downloads-search-input" value="${state.downloadsSearchQuery}" autofocus>
          </div>`;
        }

        html += `</div>`;
      }

      // Get filtered downloads
      const filteredDownloads = getFilteredDownloads();

      if (filteredDownloads.length === 0) {
        const labelNoMatches = (JE.t && JE.t('requests_no_downloads_found')) || 'No downloads found';
        html += `
          <div class="je-empty-state">
            <div>${labelNoMatches}</div>
          </div>
        `;
      } else {
        // Group downloads (collapse season packs)
        const groupedDownloads = groupDownloads(filteredDownloads);

        html += `<div class="je-downloads-grid">`;
        for (const group of groupedDownloads) {
          if (group.type === "seasonPack") {
            html += renderSeasonPackCard(group);
          } else {
            html += renderDownloadCard(group.item);
          }
        }
        html += `</div>`;
      }
    }

    html += `</div>`;
    }

    // Requests Section
    if (JE.pluginConfig?.JellyseerrEnabled) {
      html += `<div class="je-downloads-section je-requests-section">`;
      const labelRequests = (JE.t && JE.t('requests_requests')) || 'Requests';
      html += `<h2>${labelRequests}</h2>`;

        // Filter tabs
        const labelAll = (JE.t && JE.t('jellyseerr_discover_all')) || 'All';
        const labelPending = (JE.t && JE.t('jellyseerr_btn_pending')) || 'Pending Approval';
        const labelProcessing = (JE.t && JE.t('jellyseerr_btn_processing')) || 'Processing';
        const labelAvailable = (JE.t && JE.t('jellyseerr_btn_available')) || 'Available';
        const labelComingSoon = (JE.t && JE.t('requests_coming_soon')) || 'Coming Soon';

        html += `
            <div class="je-requests-tabs">
              <button is="emby-button" type="button" class="je-requests-tab emby-button ${state.requestsFilter === "all" ? "active" : ""}" onclick="window.JellyfinEnhanced.downloadsPage.filterRequests('all')">${labelAll}</button>
              <button is="emby-button" type="button" class="je-requests-tab emby-button ${state.requestsFilter === "pending" ? "active" : ""}" onclick="window.JellyfinEnhanced.downloadsPage.filterRequests('pending')">${labelPending}</button>
              <button is="emby-button" type="button" class="je-requests-tab emby-button ${state.requestsFilter === "processing" ? "active" : ""}" onclick="window.JellyfinEnhanced.downloadsPage.filterRequests('processing')">${labelProcessing}</button>
              <button is="emby-button" type="button" class="je-requests-tab emby-button ${state.requestsFilter === "comingsoon" ? "active" : ""}" onclick="window.JellyfinEnhanced.downloadsPage.filterRequests('comingsoon')">${labelComingSoon}</button>
              <button is="emby-button" type="button" class="je-requests-tab emby-button ${state.requestsFilter === "available" ? "active" : ""}" onclick="window.JellyfinEnhanced.downloadsPage.filterRequests('available')">${labelAvailable}</button>
            </div>
          `;

      if (state.isLoading && state.requests.length === 0) {
        html += `<div class="je-loading">...</div>`;
      } else if (state.requests.length === 0) {
        html += `
                    <div class="je-empty-state">
                        <div>${JE.t?.("requests_no_requests_found") || "No requests found"}</div>
                    </div>
                `;
      } else {
        // Apply client-side filtering only for Processing tab (exclude Partially Available)
        let filteredRequests = state.requests;
        if (JE.hiddenContent) filteredRequests = JE.hiddenContent.filterRequestItems(filteredRequests);
        if (state.requestsFilter === "processing") {
          // Exclude "Partially Available" items from Processing tab
          filteredRequests = filteredRequests.filter(item => {
            return item.mediaStatus !== "Partially Available";
          });
        }

        if (filteredRequests.length === 0) {
          html += `
                    <div class="je-empty-state">
                        <div>${JE.t?.("requests_no_requests_found") || "No requests found"}</div>
                    </div>
                `;
        } else {
          html += `<div class="je-downloads-grid">`;
          filteredRequests.forEach((item) => {
            html += renderRequestCard(item);
          });
          html += `</div>`;

          // Pagination
          if (state.requestsTotalPages > 1) {
            html += `
                        <div class="je-pagination">
                            <button is="emby-button" type="button" class="emby-button" onclick="window.JellyfinEnhanced.downloadsPage.prevPage()" ${state.requestsPage <= 1 ? "disabled" : ""}><span class="material-icons">chevron_left</span></button>
                            <span>${state.requestsPage} / ${state.requestsTotalPages}</span>
                            <button is="emby-button" type="button" class="emby-button" onclick="window.JellyfinEnhanced.downloadsPage.nextPage()" ${state.requestsPage >= state.requestsTotalPages ? "disabled" : ""}><span class="material-icons">chevron_right</span></button>
                        </div>
                    `;
          }
        }
      }
      html += `</div>`;
    }

    if (JE.pluginConfig?.JellyseerrEnabled && JE.pluginConfig?.DownloadsPageShowIssues) {
      html += `<div class="je-downloads-section je-issues-section">`;
      const labelIssues = (JE.t && JE.t('jellyseerr_existing_issues')) || 'Issues';
      html += `<h2>${labelIssues}</h2>`;

      const labelOpen = (JE.t && JE.t('jellyseerr_issue_open')) || 'Open';
      const labelResolved = (JE.t && JE.t('jellyseerr_issue_resolved')) || 'Resolved';
      html += `
        <div class="je-issues-tabs">
          <button is="emby-button" type="button" class="je-issues-tab emby-button ${state.issuesFilter === "open" ? "active" : ""}" onclick="window.JellyfinEnhanced.downloadsPage.filterIssues('open')">${labelOpen}</button>
          <button is="emby-button" type="button" class="je-issues-tab emby-button ${state.issuesFilter === "resolved" ? "active" : ""}" onclick="window.JellyfinEnhanced.downloadsPage.filterIssues('resolved')">${labelResolved}</button>
        </div>
      `;

      if (state.isLoading && state.issues.length === 0) {
        html += `<div class="je-loading">...</div>`;
      } else if (state.issuesError) {
        html += `
          <div class="je-empty-state">
            <div>${JE.t?.("jellyseerr_load_issues_error") || "Unable to load issues"}</div>
          </div>
        `;
      } else if (state.issues.length === 0) {
        html += `
          <div class="je-empty-state">
            <div>${JE.t?.("jellyseerr_no_issues_yet") || "No issues found"}</div>
          </div>
        `;
      } else {
        html += `<div class="je-downloads-grid">`;
        state.issues.forEach((issue) => {
          html += renderIssueCard(issue);
        });
        html += `</div>`;

        if (state.issuesTotalPages > 1) {
          html += `
            <div class="je-pagination">
              <button is="emby-button" type="button" class="emby-button" onclick="window.JellyfinEnhanced.downloadsPage.prevIssuesPage()" ${state.issuesPage <= 1 ? "disabled" : ""}><span class="material-icons">chevron_left</span></button>
              <span>${state.issuesPage} / ${state.issuesTotalPages}</span>
              <button is="emby-button" type="button" class="emby-button" onclick="window.JellyfinEnhanced.downloadsPage.nextIssuesPage()" ${state.issuesPage >= state.issuesTotalPages ? "disabled" : ""}><span class="material-icons">chevron_right</span></button>
            </div>
          `;
        }
      }

      html += `</div>`;
    }

    // History Section - only shows if enabled and visible to the current user
    if (JE.pluginConfig?.ShowDownloadsInRequests !== false
      && JE.pluginConfig?.DownloadsShowHistory !== false
      && state.historyVisible !== false) {
      html += `<div class="je-downloads-section je-history-section">`;
      const labelHistory = (JE.t && JE.t('requests_history')) || 'History';
      html += `<h2>${labelHistory}</h2>`;

      if (state.isLoading && state.history.length === 0) {
        html += `<div class="je-loading">...</div>`;
      } else if (state.history.length === 0) {
        const labelNoHistory = (JE.t && JE.t('requests_no_history_found')) || 'No history found';
        html += `
          <div class="je-empty-state">
            <div>${labelNoHistory}</div>
          </div>
        `;
      } else {
        html += `<div class="je-downloads-grid">`;
        state.history.forEach((item) => {
          html += renderHistoryCard(item);
        });
        html += `</div>`;

        if (state.historyTotalPages > 1) {
          html += `
            <div class="je-pagination">
              <button is="emby-button" type="button" class="emby-button" onclick="window.JellyfinEnhanced.downloadsPage.prevHistoryPage()" ${state.historyPage <= 1 ? "disabled" : ""}><span class="material-icons">chevron_left</span></button>
              <span>${state.historyPage} / ${state.historyTotalPages}</span>
              <button is="emby-button" type="button" class="emby-button" onclick="window.JellyfinEnhanced.downloadsPage.nextHistoryPage()" ${state.historyPage >= state.historyTotalPages ? "disabled" : ""}><span class="material-icons">chevron_right</span></button>
            </div>
          `;
        }
      }

      html += `</div>`;
    }

    clearAvatarObjectUrlCache();
    container.innerHTML = html; // existing pattern from upstream — html built from escapeHtml'd values
    hydrateAvatarImages(container);

    // Add event listener for refresh button
    const refreshBtn = container.querySelector('.je-refresh-btn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', (e) => {
        e.preventDefault();

        // Add visual feedback
        const icon = refreshBtn.querySelector('.material-icons');
        if (icon) {
          icon.style.animation = 'spin 1s linear';
          setTimeout(() => {
            icon.style.animation = '';
          }, 1000);
        }

        loadAllData();
      });
    }

    // Add event listeners for download tabs
    const downloadTabs = container.querySelectorAll('.je-downloads-tab');
    downloadTabs.forEach(tab => {
      tab.addEventListener('click', (e) => {
        e.preventDefault();
        const tabName = tab.getAttribute('data-tab');
        state.downloadsActiveTab = tabName;
        renderPage();
      });
    });

    // Add event listener for search toggle button
    const searchToggle = container.querySelector('.je-downloads-search-toggle');
    if (searchToggle) {
      searchToggle.addEventListener('click', (e) => {
        e.preventDefault();
        state.downloadsSearchVisible = !state.downloadsSearchVisible;
        if (!state.downloadsSearchVisible) {
          state.downloadsSearchQuery = "";
        }
        renderPage();
      });
    }

    // Add event listener for search input with debouncing
    const searchInput = container.querySelector('.je-downloads-search-input');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        const query = e.target.value;
        state.downloadsSearchQuery = query;

        // Clear existing timer
        if (state.searchDebounceTimer) {
          clearTimeout(state.searchDebounceTimer);
        }

        // Debounce rendering to avoid losing focus
        state.searchDebounceTimer = setTimeout(() => {
          const currentInput = document.querySelector('.je-downloads-search-input');
          const cursorPosition = currentInput ? currentInput.selectionStart : 0;

          renderPage();

          // Restore focus and cursor position
          const newInput = document.querySelector('.je-downloads-search-input');
          if (newInput) {
            newInput.focus();
            newInput.setSelectionRange(cursorPosition, cursorPosition);
          }
        }, 300);
      });
    }

    // Add click handlers for cards and watch buttons.
    // This delegated listener is attached to `container`, which persists across
    // renders (see custom-tab reuse of state._customTabContainer and the
    // container.innerHTML rebuild above). renderPage() runs on initial load, on
    // every poll cycle, on tab switches and on search input, so binding here
    // unconditionally stacks a new listener every render. A single Approve/Decline
    // click would then fire once per accumulated listener, firing N approve POSTs
    // (N duplicate Seerr "Request Approved" notifications) and ultimately failing
    // the request. Bind exactly once per container element instead.
    if (!container._jeRequestsActionsBound) {
      container._jeRequestsActionsBound = true;
      container.addEventListener('click', (e) => {
      // Handle play/watch button clicks
      const playBtn = e.target.closest('.je-request-watch-btn');
      if (playBtn) {
        e.preventDefault();
        e.stopPropagation();
        const mediaId = playBtn.getAttribute('data-media-id');
        if (mediaId && window.Emby?.Page?.showItem) {
          window.Emby.Page.showItem(mediaId);
        }
        return;
      }

      const approveBtn = e.target.closest('.je-request-approve-btn');
      if (approveBtn) {
        e.preventDefault();
        e.stopPropagation();
        handleRequestAction(approveBtn, 'approve');
        return;
      }

      const declineBtn = e.target.closest('.je-request-decline-btn');
      if (declineBtn) {
        e.preventDefault();
        e.stopPropagation();
        handleRequestAction(declineBtn, 'decline');
        return;
      }

      const viewIssueBtn = e.target.closest('.je-issue-view-btn');
      if (viewIssueBtn && !viewIssueBtn.classList.contains('is-disabled')) {
        e.preventDefault();
        e.stopPropagation();
        const tmdbId = viewIssueBtn.getAttribute('data-issue-tmdb-id');
        const mediaType = viewIssueBtn.getAttribute('data-issue-media-type');
        const title = viewIssueBtn.getAttribute('data-issue-title') || '';
        if (tmdbId && mediaType && JE.jellyseerrIssueReporter?.showReportModal) {
          JE.jellyseerrIssueReporter.showReportModal(tmdbId, title, mediaType, null, null);
        }
        return;
      }

      // Handle card clicks to navigate to item
      const card = e.target.closest('.je-download-card, .je-request-card, .je-issue-card');
      if (card) {
        const mediaId = card.getAttribute('data-media-id');
        if (mediaId && window.Emby?.Page?.showItem) {
          window.Emby.Page.showItem(mediaId);
        }
      }
      });
    }
  }

  /**
   * Create the downloads page container with proper Jellyfin page structure
   */
  function createPageContainer() {
    let page = document.getElementById("je-downloads-page");
    if (!page) {
      page = document.createElement("div");
      page.id = "je-downloads-page";
      // Use Jellyfin's page classes for proper integration
      page.className = "page type-interior mainAnimatedPage hide";
      // Data attributes for header/back button integration
      page.setAttribute("data-title", JE.t?.("requests_requests") || "Requests");
      page.setAttribute("data-backbutton", "true");
      page.setAttribute("data-url", "#/downloads");
      page.setAttribute("data-type", "custom");
      page.innerHTML = `
        <div data-role="content">
          <div class="content-primary je-downloads-page">
            <div id="je-downloads-container" style="padding-top: 5em;"></div>
          </div>
        </div>
      `;

      const mainContent = document.querySelector(".mainAnimatedPages");
      if (mainContent) {
        mainContent.appendChild(page);
      } else {
        document.body.appendChild(page);
      }
    }
    return page;
  }

  P.renderPage = renderPage;
  P.createPageContainer = createPageContainer;
})();
