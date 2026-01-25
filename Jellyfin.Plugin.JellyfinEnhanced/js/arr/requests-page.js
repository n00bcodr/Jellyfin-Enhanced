// /js/arr/requests-page.js
// Requests Page - Shows active downloads from Sonarr/Radarr and requests from Jellyseerr
(function () {
  "use strict";

  const JE = window.JellyfinEnhanced;

  // State management
  const state = {
    downloads: [],
    requests: [],
    requestsPage: 1,
    requestsTotalPages: 1,
    requestsFilter: "all",
    isLoading: false,
    pollTimer: null,
    navInjected: false,
    pageVisible: false,
    previousPage: null,
  };

  // Status color mapping - using CSS variables with fallbacks
  const STATUS_COLORS = {
    Downloading: "var(--theme-primary-color, #00a4dc)",
    Importing: "#4caf50",
    Queued: "rgba(128,128,128,0.6)",
    Paused: "#ff9800",
    Delayed: "#ff9800",
    Warning: "#ff9800",
    Failed: "#f44336",
    Unknown: "rgba(128,128,128,0.5)",
    Pending: "#ff9800",
    Processing: "var(--theme-primary-color, #00a4dc)",
    Available: "#4caf50",
    Approved: "#4caf50",
    Declined: "#f44336",
  };

  const SONARR_ICON_URL = "https://cdn.jsdelivr.net/gh/selfhst/icons/svg/sonarr.svg";
  const RADARR_ICON_URL = "https://cdn.jsdelivr.net/gh/selfhst/icons/svg/radarr-light-hybrid-light.svg";

  const logPrefix = '🪼 Jellyfin Enhanced: Requests Page:';

  // CSS Styles - minimal styling to fit Jellyfin's theme
  const CSS_STYLES = `
        .je-downloads-page {
            padding: 2em;
            max-width: 85vw;
            margin: 0 auto;
            position: relative;
            z-index: 1;
        }
        .je-downloads-section {
            margin-bottom: 2em;
        }
        .je-downloads-section h2 {
            font-size: 1.5em;
            margin-bottom: 1em;
        }
        .je-downloads-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
          gap: 1.1em;
        }
        .je-download-card, .je-request-card {
            background: rgba(128,128,128,0.1);
            border-radius: 0.25em;
            overflow: hidden;
        }
        .je-download-card-content {
          display: flex;
          gap: 1em;
          padding: 1.15em;
        }
        .je-download-poster, .je-request-poster {
            border-radius: 0.5em;
            object-fit: cover;
            flex-shrink: 0;
        }
        .je-download-poster {
          width: 72px;
          height: fit-content;
        }
        .je-request-poster {
            width: 80px;
            height: fit-content;
        }
        .je-download-poster.placeholder, .je-request-poster.placeholder {
            display: flex;
            align-items: center;
            justify-content: center;
            background: rgba(128,128,128,0.15);
            opacity: 0.5;
        }
        .je-download-info, .je-request-info {
            flex: 1;
            min-width: 0;
            display: flex;
            flex-direction: column;
            gap: 0.3em;
        }
        .je-download-title, .je-request-title {
            font-weight: 600;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .je-download-subtitle, .je-request-year {
            font-size: 0.85em;
            opacity: 0.7;
        }
        .je-download-meta {
            display: flex;
            gap: 0.5em;
            flex-wrap: wrap;
            margin-top: auto;
        }
        .je-download-badge, .je-request-status {
          font-size: 0.95em;
          padding: 0.35em 0.7em;
          border-radius: 999px;
          text-transform: uppercase;
          font-weight: 700;
          color: #fff;
        }
        .je-arr-badge {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 0.25em;
          padding: 0;
          background: transparent;
        }
        .je-arr-badge img {
          width: 18px;
          height: 18px;
          object-fit: contain;
          filter: drop-shadow(0 1px 2px rgba(0,0,0,0.35));
        }
        .je-download-progress-container {
            padding: 0 1em 1em;
        }
        .je-download-progress {
            height: 4px;
            background: rgba(128,128,128,0.2);
            border-radius: 2px;
            overflow: hidden;
        }
        .je-download-progress-bar {
            height: 100%;
            transition: width 0.3s ease;
        }
        .je-download-stats {
          display: flex;
          justify-content: space-between;
          font-size: 1em;
          opacity: 0.95;
          margin-top: 0.6em;
        }
        .je-requests-tabs {
            display: flex;
            gap: 0.5em;
            margin-bottom: 1em;
            flex-wrap: wrap;
        }
        .je-requests-tab.emby-button {
            background: transparent;
            border: 1px solid rgba(255,255,255,0.3);
            color: inherit;
            padding: 0.5em 1em;
            border-radius: 4px;
            cursor: pointer;
            opacity: 0.7;
            transition: all 0.2s;
        }
        .je-requests-tab.emby-button:hover {
            opacity: 1;
            background: rgba(255,255,255,0.1);
        }
        .je-requests-tab.emby-button.active {
            background: var(--theme-primary-color, #00a4dc);
            border-color: var(--theme-primary-color, #00a4dc);
            opacity: 1;
        }
        .je-request-card {
            display: flex;
            gap: 1em;
            padding: 1em;
            overflow: visible;
        }
        .je-request-info {
            overflow: hidden;
            min-width: 0;
        }
        .je-request-header {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            gap: 0.5em;
            margin-bottom: 0.5em;
            min-width: 0;
        }
        .je-request-header > div:first-child {
            min-width: 0;
            flex: 1;
            overflow: hidden;
        }
        .je-request-title {
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            display: block;
        }
        .je-request-status {
            flex-shrink: 0;
        }
        .je-request-meta {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.5em;
          font-size: 0.85em;
          opacity: 0.8;
          margin-top: 0.5em;
        }
        .je-request-meta-left { display: inline-flex; align-items: center; gap: 0.5em; min-width: 0; }
        .je-request-avatar {
            width: 24px;
            height: 24px;
            border-radius: 50%;
            object-fit: cover;
        }
        .je-request-actions {
            margin-top: 1em;
        }
        .je-request-watch-btn {
          background: var(--theme-primary-color, #00a4dc);
          color: inherit;
          border: none;
          padding: 0.45em;
          border-radius: 50%;
          cursor: pointer;
          width: 36px;
          height: 36px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          box-shadow: 0 4px 12px rgba(0,0,0,0.25);
        }
        .je-request-watch-btn:hover { opacity: 0.9; }
        .je-request-watch-btn .material-icons { font-size: 20px; }
        .je-pagination {
            display: flex;
            justify-content: center;
            align-items: center;
            gap: 1em;
            margin-top: 1.5em;
        }
        .je-pagination .emby-button {
            background: transparent;
            border: 1px solid rgba(255,255,255,0.3);
            color: inherit;
            padding: 0.5em 1em;
            border-radius: 4px;
            cursor: pointer;
            opacity: 0.7;
            transition: all 0.2s;
        }
        .je-pagination .emby-button:hover:not(:disabled) {
            opacity: 1;
            background: rgba(255,255,255,0.1);
        }
        .je-pagination .emby-button:disabled { opacity: 0.3; cursor: not-allowed; }
        .je-empty-state {
            text-align: center;
            padding: 3em;
            opacity: 0.5;
        }
        .je-loading {
            display: flex;
            justify-content: center;
            padding: 2em;
        }
        .je-requests-status-chip {
          display: inline-flex;
          align-items: center;
          padding: 0.3rem 0.6rem;
          margin-top: 0.7rem;
          border-radius: 999px;
          font-weight: 700;
          letter-spacing: 0.02em;
          font-size: 0.72rem;
          text-transform: uppercase;
          background: rgba(255, 255, 255, 0.08);
          border: 1px solid rgba(255, 255, 255, 0.12);
        }
        .je-requests-status-chip.je-chip-available { background: rgba(34, 197, 94, 0.25); color: #f0f9ff; border-color: rgba(34, 197, 94, 0.5); }
        .je-requests-status-chip.je-chip-partial { background: rgba(234, 179, 8, 0.25); color: #f0f9ff; border-color: rgba(234, 179, 8, 0.5); }
        .je-requests-status-chip.je-chip-processing { background: rgba(59, 130, 246, 0.25); color: #f0f9ff; border-color: rgba(59, 130, 246, 0.5); }
        .je-requests-status-chip.je-chip-requested { background: rgba(168, 85, 247, 0.25); color: #f0f9ff; border-color: rgba(168, 85, 247, 0.5); }
        .je-requests-status-chip.je-chip-rejected { background: rgba(248, 113, 113, 0.25); color: #f0f9ff; border-color: rgba(248, 113, 113, 0.5); }
    `;

  /**
   * Inject CSS styles
   */
  function injectStyles() {
    if (document.getElementById("je-downloads-styles")) return;
    const style = document.createElement("style");
    style.id = "je-downloads-styles";
    style.textContent = CSS_STYLES;
    document.head.appendChild(style);
  }

  /**
   * Get API authentication headers
   */
  function getAuthHeaders() {
    const token = ApiClient.accessToken ? ApiClient.accessToken() : "";
    return {
      "X-MediaBrowser-Token": token,
      "Content-Type": "application/json",
    };
  }

  /**
   * Fetch download queue from backend
   */
  async function fetchDownloads() {
    try {
      const response = await fetch(
        ApiClient.getUrl("/JellyfinEnhanced/arr/queue"),
        { headers: getAuthHeaders() },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      state.downloads = data.items || [];
      return data;
    } catch (error) {
      console.error(`${logPrefix} Failed to fetch downloads:`, error);
      state.downloads = [];
      return null;
    }
  }

  /**
   * Fetch requests from backend
   */
  async function fetchRequests() {
    try {
      const skip = (state.requestsPage - 1) * 20;
      const filter = state.requestsFilter !== "all" ? state.requestsFilter : "";

      const url = ApiClient.getUrl("/JellyfinEnhanced/arr/requests", {
        take: 20,
        skip: skip,
        filter: filter,
      });

      const response = await fetch(url, {
        headers: getAuthHeaders(),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();

      state.requests = data.requests || [];
      state.requestsTotalPages = data.totalPages || 1;

      return data;
    } catch (error) {
      console.error(`${logPrefix} Failed to fetch requests:`, error);
      state.requests = [];
      return null;
    }
  }

  /**
   * Load all data
   */
  async function loadAllData() {
    state.isLoading = true;
    renderPage();

    await Promise.all([fetchDownloads(), fetchRequests()]);

    state.isLoading = false;
    renderPage();
  }

  /**
   * Format bytes to human readable
   */
  function formatBytes(bytes) {
    if (!bytes || bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  }

  /**
   * Format time remaining
   */
  function formatTimeRemaining(timeStr) {
    if (!timeStr) return "";

    // Handle HH:MM:SS format
    const match = timeStr.match(/^(\d+):(\d+):(\d+)$/);
    if (match) {
      const hours = parseInt(match[1]);
      const minutes = parseInt(match[2]);

      if (hours > 0) return `${hours}h ${minutes}m`;
      return `${minutes}m`;
    }

    // Handle day format like 1.02:30:45
    const dayMatch = timeStr.match(/^(\d+)\.(\d+):(\d+):(\d+)$/);
    if (dayMatch) {
      const days = parseInt(dayMatch[1]);
      const hours = parseInt(dayMatch[2]);
      if (days > 0) return `${days}d ${hours}h`;
      return `${hours}h`;
    }

    return timeStr;
  }

  /**
   * Format relative date
   */
  function formatRelativeDate(dateStr) {
    if (!dateStr) return "";

    const date = new Date(dateStr);

    // Check if date parsing failed
    if (isNaN(date.getTime())) {
      return "";
    }

    const now = new Date();
    const diff = now - date;

    // Handle negative diff (future dates) or invalid dates
    if (diff < 0) return "";

    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 30) return `${days}d ago`;

    // For older dates, show the actual date
    return date.toLocaleDateString();
  }

  /**
   * Format downloaded/total stats with clamping
   */
  function formatDownloadStats(totalSize, sizeRemaining) {
    if (!totalSize || totalSize <= 0) return "";
    const remaining = Math.max(0, Math.min(totalSize, sizeRemaining || 0));
    const downloaded = Math.max(0, Math.min(totalSize, totalSize - remaining));
    return `${formatBytes(downloaded)} / ${formatBytes(totalSize)}`;
  }

  /**
   * Jellyseerr like chips
   */
  function resolveRequestStatus(status) {
    const normalized = (status || "").toLowerCase();
    const labelAvailable = JE.t?.("jellyseerr_btn_available") || "Available";
    const labelPartial = JE.t?.("jellyseerr_btn_partially_available") || "Partially Available";
    const labelProcessing = JE.t?.("jellyseerr_btn_processing") || "Processing";
    const labelPending = JE.t?.("jellyseerr_btn_pending") || "Pending Approval";
    const labelRequested = JE.t?.("jellyseerr_btn_requested") || "Requested";
    const labelRejected = JE.t?.("jellyseerr_btn_rejected") || "Rejected";

    switch (normalized) {
      case "available":
        return { label: labelAvailable, className: "je-chip-available" };
      case "partially available":
        return { label: labelPartial, className: "je-chip-partial" };
      case "processing":
        return { label: labelProcessing, className: "je-chip-processing" };
      case "approved":
        return { label: labelRequested, className: "je-chip-requested" };
      case "pending":
        return { label: labelPending, className: "je-chip-requested" };
      case "declined":
        return { label: labelRejected, className: "je-chip-rejected" };
      default:
        return { label: status || labelRequested, className: "je-chip-requested" };
    }
  }

  /**
   * Render a download card
   */
  function renderDownloadCard(item) {
    const statusColor = STATUS_COLORS[item.status] || STATUS_COLORS.Unknown;
    const sourceIcon = item.source === "sonarr" ? SONARR_ICON_URL : RADARR_ICON_URL;
    const sourceLabel = item.source === "sonarr" ? "Sonarr" : "Radarr";

    const posterHtml = item.posterUrl
      ? `<img class="je-download-poster" src="${item.posterUrl}" alt="" loading="lazy" onerror="this.style.display='none'">`
      : `<div class="je-download-poster placeholder"></div>`;

    const progressHtml = `
      <div class="je-download-progress-container">
        <div class="je-download-progress">
          <div class="je-download-progress-bar" style="width: ${item.progress || 0}%; background: ${statusColor}"></div>
        </div>
        <div class="je-download-stats">
          <span>${item.progress || 0}%</span>
          ${item.timeRemaining ? `<span>ETA: ${formatTimeRemaining(item.timeRemaining)}</span>` : ""}
          ${item.totalSize ? `<span>${formatDownloadStats(item.totalSize, item.sizeRemaining)}</span>` : ""}
        </div>
      </div>
    `;

    return `
      <div class="je-download-card">
        <div class="je-download-card-content">
          ${posterHtml}
          <div class="je-download-info">
            <div class="je-download-title" title="${item.title || ""}">${item.title || "Unknown"}</div>
            ${item.subtitle ? `<div class="je-download-subtitle" title="${item.subtitle}">${item.subtitle}</div>` : ""}
            <div class="je-download-meta">
                <span class="je-download-badge je-arr-badge" title="${sourceLabel}"><img src="${sourceIcon}" alt="${sourceLabel}" loading="lazy"></span>
              <span class="je-download-badge" style="background: ${statusColor}">${item.status}</span>
            </div>
          </div>
        </div>
        ${progressHtml}
      </div>
    `;
  }

  /**
   * Render a request card
   */
  function renderRequestCard(item) {
    const status = resolveRequestStatus(item.mediaStatus);

    let posterHtml = "";
    if (item.posterUrl) {
      posterHtml = `<img class="je-request-poster" src="${item.posterUrl}" alt="" loading="lazy">`;
    } else {
      posterHtml = `<div class="je-request-poster placeholder"></div>`;
    }

    let avatarHtml = "";
    if (item.requestedByAvatar) {
      avatarHtml = `<img class="je-request-avatar" src="${item.requestedByAvatar}" alt="" onerror="this.style.display='none'">`;
    }

    let watchButton = "";
    if (item.jellyfinMediaId && (item.mediaStatus === "Available" || item.mediaStatus === "Partially Available")) {
      const playLabel = JE.t?.("jellyseerr_btn_available") || "Available";
      const playIcon = '<span class="material-icons">play_arrow</span>';
      watchButton = `<button class="je-request-watch-btn" title="${playLabel}" aria-label="${playLabel}" onclick="Emby.Page.showItem('${item.jellyfinMediaId}')">${playIcon}</button>`;
    }

    return `
            <div class="je-request-card">
                ${posterHtml}
                <div class="je-request-info">
                    <div class="je-request-header">
                      <div>
                        <div class="je-request-title-row">
                          <div class="je-request-title">${item.title || "Unknown"}</div>
                          ${item.year ? `<span class="je-request-year">(${item.year})</span>` : ""}
                        </div>
                        <span class="je-requests-status-chip ${status.className}">${status.label}</span>
                      </div>
                    </div>
                    <div class="je-request-meta">
                      <div class="je-request-meta-left">
                        ${avatarHtml}
                        <span>${item.requestedBy || "Unknown"}</span>
                        ${item.createdAt ? `<span>&#8226;</span><span>${formatRelativeDate(item.createdAt)}</span>` : ""}
                      </div>
                    </div>
                    ${watchButton ? `<div class="je-request-actions">${watchButton}</div>` : ""}
                </div>
            </div>
        `;
  }

  /**
   * Group downloads by season pack (same show + season + same progress indicates season pack)
   * Returns array of items where season packs are collapsed into single entries
   */
  function groupDownloads(downloads) {
    const grouped = [];
    const seasonPackMap = new Map(); // key: "title|season|progress" -> episodes[]

    for (const item of downloads) {
      // Only group sonarr items with season numbers
      if (item.source === "sonarr" && item.seasonNumber != null) {
        // Group by show title + season + progress (same progress = likely season pack)
        const key = `${item.title}|${item.seasonNumber}|${item.progress}`;

        if (!seasonPackMap.has(key)) {
          seasonPackMap.set(key, []);
        }
        seasonPackMap.get(key).push(item);
      } else {
        // Movies or items without season info - add directly
        grouped.push({ type: "single", item });
      }
    }

    // Process season groups
    for (const [key, episodes] of seasonPackMap) {
      if (episodes.length >= 3) {
        // 3+ episodes with same progress = season pack, collapse them
        const first = episodes[0];
        const episodeNums = episodes
          .map((e) => e.episodeNumber)
          .sort((a, b) => a - b);
        const minEp = episodeNums[0];
        const maxEp = episodeNums[episodeNums.length - 1];

        grouped.push({
          type: "seasonPack",
          item: first,
          episodes: episodes,
          episodeRange: `E${String(minEp).padStart(2, "0")}-E${String(maxEp).padStart(2, "0")}`,
          episodeCount: episodes.length,
        });
      } else {
        // Few episodes - show individually
        for (const ep of episodes) {
          grouped.push({ type: "single", item: ep });
        }
      }
    }

    return grouped;
  }

  /**
   * Render a season pack card (collapsed view of multiple episodes)
   */
  function renderSeasonPackCard(group) {
    const item = group.item;
    const statusColor = STATUS_COLORS[item.status] || STATUS_COLORS.Unknown;

    const posterHtml = item.posterUrl
      ? `<img class="je-download-poster" src="${item.posterUrl}" alt="" loading="lazy" onerror="this.style.display='none'">`
      : `<div class="je-download-poster placeholder"></div>`;

    // Calculate total size for the pack
    const totalSize = group.episodes.reduce(
      (sum, ep) => sum + (ep.totalSize || 0),
      0,
    );
    const sizeRemaining = group.episodes.reduce(
      (sum, ep) => sum + (ep.sizeRemaining || 0),
      0,
    );

    const progressHtml = `
      <div class="je-download-progress-container">
        <div class="je-download-progress">
          <div class="je-download-progress-bar" style="width: ${item.progress || 0}%; background: ${statusColor}"></div>
        </div>
        <div class="je-download-stats">
          <span>${item.progress || 0}%</span>
          ${item.timeRemaining ? `<span>ETA: ${formatTimeRemaining(item.timeRemaining)}</span>` : ""}
          ${totalSize ? `<span>${formatDownloadStats(totalSize, sizeRemaining)}</span>` : ""}
        </div>
      </div>
    `;

    return `
      <div class="je-download-card je-season-pack">
        <div class="je-download-card-content">
          ${posterHtml}
          <div class="je-download-info">
            <div class="je-download-title" title="${item.title || ""}">${item.title || "Unknown"}</div>
            <div class="je-download-subtitle">Season ${item.seasonNumber} (${group.episodeCount} episodes)</div>
            <div class="je-download-meta">
              <span class="je-download-badge je-arr-badge" title="Sonarr"><img src="${SONARR_ICON_URL}" alt="Sonarr" loading="lazy"></span>
              <span class="je-download-badge" style="background: ${statusColor}">${item.status}</span>
              <span class="je-download-badge" style="background: rgba(128,128,128,0.4)">${group.episodeRange}</span>
            </div>
          </div>
        </div>
        ${progressHtml}
      </div>
    `;
  }

  /**
   * Render the full page
   */
  function renderPage() {
    const container = document.getElementById("je-downloads-container");
    if (!container) return;

    let html = "";

    // Active Downloads Section
    html += `<div class="je-downloads-section" style="margin-top: 2em;">`;
    const labelActiveDownloads = (JE.t && JE.t('jellyseerr_active_downloads')) || 'Active Downloads';
    html += `<h2 style="margin-top: 0.5em;">${labelActiveDownloads}</h2>`;

    if (state.isLoading && state.downloads.length === 0) {
      html += `<div class="je-loading">Loading...</div>`;
    } else if (state.downloads.length === 0) {
      html += `
        <div class="je-empty-state">
          <div>No active downloads</div>
        </div>
      `;
    } else {
      // Group downloads (collapse season packs)
      const groupedDownloads = groupDownloads(state.downloads);

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
    html += `</div>`;

    // Requests Section
    if (JE.pluginConfig?.JellyseerrEnabled) {
      html += `<div class="je-downloads-section">`;
      const labelRequests = (JE.t && JE.t('jellyseerr_requests')) || 'Requests';
      html += `<h2>${labelRequests}</h2>`;

        // Filter tabs
        const labelAll = (JE.t && JE.t('jellyseerr_discover_all')) || 'All';
        const labelPending = (JE.t && JE.t('jellyseerr_btn_pending')) || 'Pending Approval';
        const labelProcessing = (JE.t && JE.t('jellyseerr_btn_processing')) || 'Processing';
        const labelAvailable = (JE.t && JE.t('jellyseerr_btn_available')) || 'Available';

        html += `
            <div class="je-requests-tabs">
              <button is="emby-button" type="button" class="je-requests-tab emby-button ${state.requestsFilter === "all" ? "active" : ""}" onclick="window.JellyfinEnhanced.downloadsPage.filterRequests('all')">${labelAll}</button>
              <button is="emby-button" type="button" class="je-requests-tab emby-button ${state.requestsFilter === "pending" ? "active" : ""}" onclick="window.JellyfinEnhanced.downloadsPage.filterRequests('pending')">${labelPending}</button>
              <button is="emby-button" type="button" class="je-requests-tab emby-button ${state.requestsFilter === "processing" ? "active" : ""}" onclick="window.JellyfinEnhanced.downloadsPage.filterRequests('processing')">${labelProcessing}</button>
              <button is="emby-button" type="button" class="je-requests-tab emby-button ${state.requestsFilter === "available" ? "active" : ""}" onclick="window.JellyfinEnhanced.downloadsPage.filterRequests('available')">${labelAvailable}</button>
            </div>
          `;

      if (state.isLoading && state.requests.length === 0) {
        html += `<div class="je-loading">Loading...</div>`;
      } else if (state.requests.length === 0) {
        html += `
                    <div class="je-empty-state">
                        <div>No requests found</div>
                    </div>
                `;
      } else {
        html += `<div class="je-downloads-grid">`;
        state.requests.forEach((item) => {
          html += renderRequestCard(item);
        });
        html += `</div>`;

        // Pagination
        if (state.requestsTotalPages > 1) {
          html += `
                        <div class="je-pagination">
                            <button is="emby-button" type="button" class="emby-button" onclick="window.JellyfinEnhanced.downloadsPage.prevPage()" ${state.requestsPage <= 1 ? "disabled" : ""}>Previous</button>
                            <span>Page ${state.requestsPage} of ${state.requestsTotalPages}</span>
                            <button is="emby-button" type="button" class="emby-button" onclick="window.JellyfinEnhanced.downloadsPage.nextPage()" ${state.requestsPage >= state.requestsTotalPages ? "disabled" : ""}>Next</button>
                        </div>
                    `;
        }
      }
      html += `</div>`;
    }

    container.innerHTML = html;
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
      page.setAttribute("data-title", "Requests");
      page.setAttribute("data-backbutton", "true");
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

  /**
   * Show the downloads page with proper Jellyfin integration
   */
  function showPage() {
    if (state.pageVisible) return;

    const page = createPageContainer();

    // Hide other Jellyfin pages - but track which one was active so we can restore it
    const activePage = document.querySelector(
      ".mainAnimatedPage:not(.hide):not(#je-downloads-page)",
    );
    if (activePage) {
      state.previousPage = activePage;
      activePage.classList.add("hide");
      // Dispatch viewhide for the page we're leaving
      activePage.dispatchEvent(
        new CustomEvent("viewhide", {
          bubbles: true,
          detail: { type: "interior" },
        }),
      );
    }

    // Show our page
    page.classList.remove("hide");
    state.pageVisible = true;

    // Update URL for back button support
    if (window.location.hash !== "#/downloads") {
      history.pushState({ page: "downloads" }, "Requests", "#/downloads");
    }

    // Dispatch viewshow event so Jellyfin's libraryMenu updates header/back button
    page.dispatchEvent(
      new CustomEvent("viewshow", {
        bubbles: true,
        detail: {
          type: "custom",
          isRestored: false,
          options: {},
        },
      }),
    );

    // Also dispatch pageshow for other integrations
    page.dispatchEvent(
      new CustomEvent("pageshow", {
        bubbles: true,
        detail: {
          type: "custom",
          isRestored: false,
        },
      }),
    );

    loadAllData();
    startPolling();
  }

  /**
   * Hide the downloads page and clean up header state
   */
  function hidePage() {
    if (!state.pageVisible) return;

    const page = document.getElementById("je-downloads-page");
    if (page) {
      page.classList.add("hide");

      // Dispatch viewhide event so Jellyfin knows we're leaving
      page.dispatchEvent(
        new CustomEvent("viewhide", {
          bubbles: true,
          detail: { type: "custom" },
        }),
      );
    }

    // Restore the previous page if Jellyfin's router hasn't already shown another page
    // This handles the case where user clicks browser back button
    // But NOT when clicking header tabs (Jellyfin handles those via viewshow events)
    if (
      state.previousPage &&
      !document.querySelector(
        ".mainAnimatedPage:not(.hide):not(#je-downloads-page)",
      )
    ) {
      state.previousPage.classList.remove("hide");
      // Dispatch viewshow so the page re-initializes properly
      state.previousPage.dispatchEvent(
        new CustomEvent("viewshow", {
          bubbles: true,
          detail: { type: "interior", isRestored: true },
        }),
      );
    }

    state.pageVisible = false;
    state.previousPage = null;
    stopPolling();
  }

  /**
   * Start polling for updates
   */
  function startPolling() {
    stopPolling();
    const config = JE.pluginConfig || {};
    const interval = (config.DownloadsPollIntervalSeconds || 30) * 1000;

    state.pollTimer = setInterval(() => {
      if (state.pageVisible && !state.isLoading) {
        loadAllData();
      }
    }, interval);
  }

  /**
   * Stop polling
   */
  function stopPolling() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  /**
   * Filter requests
   */
  function filterRequests(filter) {
    state.requestsFilter = filter;
    state.requestsPage = 1;
    fetchRequests().then(() => renderPage());
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

  /**
   * Inject navigation item into sidebar
   */
  function injectNavigation() {
    if (state.navInjected) return;

    const config = JE.pluginConfig || {};
    if (!config.DownloadsPageEnabled) return;

    if (document.querySelector(".je-nav-downloads-item")) {
      state.navInjected = true;
      return;
    }

    const jellyfinEnhancedSection = document.querySelector('.jellyfinEnhancedSection');

    if (jellyfinEnhancedSection) {
      const navItem = document.createElement("a");
      navItem.setAttribute('is', 'emby-linkbutton');
      navItem.className =
        "navMenuOption lnkMediaFolder emby-button je-nav-downloads-item";
      navItem.href = "#/downloads";
      navItem.innerHTML = `
        <span class="navMenuOptionIcon material-icons">download</span>
        <span class="sectionName navMenuOptionText">Requests</span>
      `;
      navItem.addEventListener("click", (e) => {
        e.preventDefault();
        showPage();
      });

      jellyfinEnhancedSection.appendChild(navItem);
      state.navInjected = true;
      console.log(`${logPrefix} Navigation item injected`);
    } else {
      setTimeout(injectNavigation, 1000);
    }
  }

  /**
   * Handle URL hash changes
   */
  function handleNavigation() {
    const hash = window.location.hash;
    if (hash === "#/downloads") {
      showPage();
    } else if (state.pageVisible) {
      hidePage();
    }
  }

  /**
   * Initialize the downloads page module
   */
  function initialize() {
    console.log(`${logPrefix} Initializing downloads page module`);

    const config = JE.pluginConfig || {};
    if (!config.DownloadsPageEnabled) {
      console.log(`${logPrefix} Downloads page is disabled`);
      return;
    }

    injectStyles();
    createPageContainer();
    injectNavigation();

    // Listen for hash changes - handles browser back/forward and direct URL changes
    window.addEventListener("hashchange", handleNavigation);
    window.addEventListener("popstate", handleNavigation);

    // Listen for Jellyfin's viewshow events - hide our page when other pages show
    document.addEventListener("viewshow", (e) => {
      const targetPage = e.target;
      if (
        state.pageVisible &&
        targetPage &&
        targetPage.id !== "je-downloads-page"
      ) {
        hidePage();
      }
    });

    // Listen for clicks on header navigation buttons (Home, Favorites, etc.)
    // These buttons use Jellyfin's internal router and may not change the hash immediately
    document.addEventListener(
      "click",
      (e) => {
        if (!state.pageVisible) return;

        const btn = e.target.closest(
          ".headerTabs button, .navMenuOption, .headerButton",
        );
        if (btn && !btn.classList.contains("je-nav-downloads-item")) {
          // Hide our page immediately - don't try to manage other pages
          // Jellyfin's router will handle showing the correct page
          hidePage();
        }
      },
      true,
    );

    // Check current URL on init
    handleNavigation();

    console.log(`${logPrefix} Downloads page module initialized`);
  }

  // Export to JE namespace
  JE.downloadsPage = {
    initialize,
    showPage,
    hidePage,
    refresh: loadAllData,
    filterRequests,
    nextPage,
    prevPage,
  };

  JE.initializeDownloadsPage = initialize;
})();
