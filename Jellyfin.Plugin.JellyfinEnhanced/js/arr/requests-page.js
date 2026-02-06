// /js/arr/requests-page.js
// Requests Page - Shows active downloads from Sonarr/Radarr and requests from Jellyseerr
(function () {
  "use strict";

  const JE = window.JellyfinEnhanced;
  const sidebar = document.querySelector('.mainDrawer-scrollContainer');
  const pluginPagesExists = !!sidebar?.querySelector(
    'a[is="emby-linkbutton"][data-itemid="Jellyfin.Plugin.JellyfinEnhanced.DownloadsPage"]',
  );

  // State management
  const state = {
    downloads: [],
    requests: [],
    requestsPage: 1,
    requestsTotalPages: 1,
    requestsFilter: "all",
    isLoading: false,
    pollTimer: null,
    pageVisible: false,
    previousPage: null,
    locationSignature: null,
    locationTimer: null,
    downloadsActiveTab: "all",
    downloadsSearchQuery: "",
    downloadsSearchVisible: false,
    searchDebounceTimer: null,
  };

  // Status color mapping - using theme-aware colors
  const getStatusColors = () => {
    const themeVars = JE.themer?.getThemeVariables() || {};
    const primaryAccent = themeVars.primaryAccent || '#00a4dc';
    return {
      downloading: primaryAccent,
      importing: "#4caf50",
      queued: "rgba(128,128,128,0.6)",
      paused: "#ff9800",
      delayed: "#ff9800",
      warning: "#ff9800", // Stalled
      failed: "#f44336",
      completed: "#4caf50",
      unknown: "rgba(128,128,128,0.5)",
      pending: "#ff9800",
      processing: primaryAccent,
      available: "#4caf50",
      approved: "#4caf50",
      declined: "#f44336",
      downloadclientunavailable: "#f44336",
      fallbackmode: "#ff9800",
      delay: "#ff9800"
    };
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
          height: 108px;
        }
        .je-request-poster {
            width: 80px;
            height: 120px;
            max-height: 120px;
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
        .je-requests-status-chip.je-chip-coming-soon { background: rgba(156, 39, 176, 0.25); color: #f0f9ff; border-color: rgba(156, 39, 176, 0.5); }
        .je-release-date-chip {
          display: inline-flex;
          align-items: center;
          padding: 0.25rem 0.5rem;
          margin-left: 0.5rem;
          border-radius: 999px;
          font-weight: 600;
          letter-spacing: 0.02em;
          font-size: 0.68rem;
          text-transform: uppercase;
          background: rgba(156, 39, 176, 0.25);
          border: 1px solid rgba(156, 39, 176, 0.5);
          color: #f0f9ff;
        }
        .je-release-date-chip sup,
        .je-requests-status-chip sup,
        .je-request-title sup {
          font-size: 0.6em;
          opacity: 0.85;
          margin-bottom: 1em;
          margin-right: 0.25em;
          text-transform: lowercase;
        }
        .je-refresh-btn:hover {
          opacity: 1 !important;
          background: rgba(255,255,255,0.1) !important;
        }
        .je-downloads-controls {
          display: flex;
          flex-direction: column;
          gap: 1em;
          margin-bottom: 1.5em;
        }
        .je-downloads-tabs {
          display: flex;
          gap: 0.5em;
          flex-wrap: wrap;
          align-items: center;
        }
        .je-downloads-tab.emby-button {
          background: transparent;
          border: 1px solid rgba(255,255,255,0.3);
          color: inherit;
          padding: 0.5em 1em;
          border-radius: 4px;
          cursor: pointer;
          opacity: 0.7;
          transition: all 0.2s;
          display: inline-flex;
          align-items: center;
          gap: 0.5em;
        }
        .je-downloads-tab.emby-button:hover {
          opacity: 1;
          background: rgba(255,255,255,0.1);
        }
        .je-downloads-tab.emby-button.active {
          opacity: 1;
        }
        .je-downloads-search-toggle {
          background: transparent;
          border: 1px solid rgba(255,255,255,0.3);
          color: inherit;
          padding: 0.5em;
          border-radius: 4px;
          cursor: pointer;
          opacity: 0.7;
          transition: all 0.2s;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 36px;
          height: 36px;
        }
        .je-downloads-search-toggle:hover {
          opacity: 1;
          background: rgba(255,255,255,0.1);
        }
        .je-downloads-search-toggle.active {
          opacity: 1;
          background: rgba(255,255,255,0.15);
        }
        .je-downloads-search-toggle .material-icons {
          font-size: 20px;
        }
        .je-downloads-tab-count {
          font-size: 0.8em;
          padding: 0.2em 0.5em;
          background: rgba(255,255,255,0.5);
          border-radius: 999px;
          min-width: 20px;
          text-align: center;
        }
        .je-downloads-search-container {
          display: flex;
          align-items: center;
          gap: 0.5em;
          position: relative;
          width: 100%;
          animation: slideDown 0.2s ease-out;
        }
        @keyframes slideDown {
          from {
            opacity: 0;
            transform: translateY(-10px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        .je-downloads-search-icon {
          position: absolute;
          left: 0.7em;
          font-size: 20px;
          opacity: 0.5;
          pointer-events: none;
        }
        .je-downloads-search-input {
          background: rgba(255,255,255,0.08);
          border: 1px solid rgba(255,255,255,0.2);
          color: inherit;
          padding: 0.6em 0.9em 0.6em 2.5em;
          border-radius: 4px;
          font-size: 0.9em;
          flex: 1;
          width: 100%;
          transition: all 0.2s;
        }
        .je-downloads-search-input:focus {
          outline: none;
          border-color: rgba(255,255,255,0.4);
          background: rgba(255,255,255,0.12);
        }
        .je-downloads-search-input:focus + .je-downloads-search-icon {
          opacity: 0.7;
        }
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
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

    // Inject dynamic theme colors
    injectThemeColors();
  }

  /**
   * Inject dynamic theme colors
   */
  function injectThemeColors() {
    const existingThemeStyle = document.getElementById("je-downloads-theme-colors");
    if (existingThemeStyle) {
      existingThemeStyle.remove();
    }

    const themeVars = JE.themer?.getThemeVariables() || {};
    const primaryAccent = themeVars.primaryAccent || '#00a4dc';

    const themeStyle = document.createElement("style");
    themeStyle.id = "je-downloads-theme-colors";
    themeStyle.textContent = `
      .je-requests-tab.emby-button.active,
      .je-downloads-tab.emby-button.active {
        background: ${primaryAccent} !important;
        border-color: ${primaryAccent} !important;
      }
      .je-request-watch-btn {
        background: ${primaryAccent} !important;
      }
    `;
    document.head.appendChild(themeStyle);
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
   * Translate download status to localized label
   */
  function translateStatus(status) {
    const translations = {
      "All": JE.t?.("jellyseerr_discover_all") || "All",
      "downloading": JE.t?.("downloads_status_downloading") || "Downloading",
      "queued": JE.t?.("downloads_status_queued") || "Queued",
      "paused": JE.t?.("downloads_status_paused") || "Paused",
      "importing": JE.t?.("downloads_status_importing") || "Importing",
      "completed": JE.t?.("downloads_status_completed") || "Completed",
      "warning": JE.t?.("downloads_status_warning") || "Warning",
      "failed": JE.t?.("downloads_status_failed") || "Failed",
      "unknown": JE.t?.("downloads_status_unknown") || "Unknown"
    };
    return translations[status] || status;
  }

  /**
   * Get unique statuses from downloads
   * Counts season packs as 1 download instead of counting each episode
   */
  function getDownloadStatuses() {
    const statuses = new Map();
    const statusOrder = ["Downloading", "Queued", "Paused", "Importing", "Completed", "Warning", "Failed", "Unknown"];

    // Group downloads first so season packs are counted as 1
    const groupedDownloads = groupDownloads(state.downloads);

    for (const group of groupedDownloads) {
      const item = group.type === "seasonPack" ? group.item : group.item;
      const status = item.status || "Unknown";
      if (!statuses.has(status)) {
        statuses.set(status, 0);
      }
      statuses.set(status, statuses.get(status) + 1);
    }

    // Sort by defined order (case-insensitive comparison)
    const sorted = Array.from(statuses.entries()).sort((a, b) => {
      const indexA = statusOrder.findIndex(s => s.toLowerCase() === a[0].toLowerCase());
      const indexB = statusOrder.findIndex(s => s.toLowerCase() === b[0].toLowerCase());
      return (indexA === -1 ? statusOrder.length : indexA) - (indexB === -1 ? statusOrder.length : indexB);
    });

    return sorted;
  }

  /**
   * Filter downloads based on active tab and search query
   */
  function getFilteredDownloads() {
    let filtered = state.downloads;

    // Filter by status tab
    if (state.downloadsActiveTab !== "all") {
      filtered = filtered.filter(d => d.status === state.downloadsActiveTab);
    }

    // Filter by search query
    if (state.downloadsSearchQuery.trim()) {
      const query = state.downloadsSearchQuery.toLowerCase();
      filtered = filtered.filter(d =>
        (d.title && d.title.toLowerCase().includes(query)) ||
        (d.subtitle && d.subtitle.toLowerCase().includes(query))
      );
    }

    return filtered;
  }

  /**
   * Calculate pagination info for downloads
   */
  function getDownloadsPaginationInfo() {
    const filtered = getFilteredDownloads();
    const itemsPerPage = 20;
    const totalItems = filtered.length;
    const totalPages = Math.ceil(totalItems / itemsPerPage) || 1;
    return {
      totalItems,
      totalPages,
      itemsPerPage
    };
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
      const seconds = parseInt(match[3]);

      if (hours > 0) {
        return `${hours}h ${minutes}m ${seconds}s`;
      } else if (minutes > 0) {
        return `${minutes}m ${seconds}s`;
      } else {
        return `${seconds}s`;
      }
    }

    // Handle day format like 1.02:30:45
    const dayMatch = timeStr.match(/^(\d+)\.(\d+):(\d+):(\d+)$/);
    if (dayMatch) {
      const days = parseInt(dayMatch[1]);
      const hours = parseInt(dayMatch[2]);
      const minutes = parseInt(dayMatch[3]);
      const seconds = parseInt(dayMatch[4]);

      if (days > 0) {
        return `${days}d ${hours}h ${minutes}m`;
      } else if (hours > 0) {
        return `${hours}h ${minutes}m ${seconds}s`;
      } else if (minutes > 0) {
        return `${minutes}m ${seconds}s`;
      } else {
        return `${seconds}s`;
      }
    }

    return timeStr;
  }

  /**
   * Format relative date (e.g., "2m ago", "5h ago", "3d ago")
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

    if (minutes < 1) return JE.t?.("requests_just_now") || "just now";
    if (minutes < 60) return JE.t?.("requests_minutes_ago")?.replace("{minutes}", minutes) || `${minutes}m ago`;
    if (hours < 24) return JE.t?.("requests_hours_ago")?.replace("{hours}", hours) || `${hours}h ago`;
    if (days < 30) return JE.t?.("requests_days_ago")?.replace("{days}", days) || `${days}d ago`;

    // For older dates, show the date in "DD MMM YYYY" format
    return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  /**
   * Format future release date as relative time
   * Examples: "today", "tomorrow", "in 7 days", "on 28<sup>th</sup> February"
   */
  function formatFutureReleaseDate(dateStr) {
    if (!dateStr) return null;

    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return null;

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const releaseDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());

    const diffMs = releaseDay - today;
    const diffDays = Math.ceil(diffMs / 86400000);

    if (diffDays < 0) return null;

    const labelTomorrow = JE.t?.("requests_tomorrow") || "tomorrow";
    const labelInDays = JE.t?.("requests_in_days") || "in {days} days";
    const labelOn = JE.t?.("requests_on_date") || "on {date}";

    if (diffDays === 0) {
      return JE.t?.("requests_today") || "today";
    } else if (diffDays === 1) {
      return labelTomorrow;
    } else if (diffDays <= 14) {
      return labelInDays.replace("{days}", diffDays);
    } else {
      const day = date.getDate();
      const month = date.toLocaleString('default', { month: 'long' });
      const suffix = getOrdinalSuffix(day);
      return labelOn.replace("{date}", `${day}${suffix} ${month}`);
    }
  }

  /**
   * Get ordinal suffix for day number as superscript (1<sup>st</sup>, 2<sup>nd</sup>, etc.)
   */
  function getOrdinalSuffix(day) {
    if (day > 3 && day < 21) return '<sup>th</sup>';
    switch (day % 10) {
      case 1: return '<sup>st</sup>';
      case 2: return '<sup>nd</sup>';
      case 3: return '<sup>rd</sup>';
      default: return '<sup>th</sup>';
    }
  }

  /**
   * Check if an item has a future release date
   */
  function hasFutureReleaseDate(item) {
    const releaseDate = item.type === 'tv'
      ? item.nextAirDate
      : (item.digitalReleaseDate || item.theatricalReleaseDate);
    if (!releaseDate) return false;

    const date = new Date(releaseDate);
    if (isNaN(date.getTime())) return false;

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const releaseDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());

    return releaseDay > today;
  }

  /**
   * Get release date label for display
   */
  function getReleaseDateLabel(item) {
    const dateStr = item.type === 'tv'
      ? item.nextAirDate
      : (item.digitalReleaseDate || item.theatricalReleaseDate);
    return formatFutureReleaseDate(dateStr);
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
  function resolveRequestStatus(status, item = null) {
    const normalized = (status || "").toLowerCase();
    const labelAvailable = JE.t?.("jellyseerr_btn_available") || "Available";
    const labelPartial = JE.t?.("jellyseerr_btn_partially_available") || "Partially Available";
    const labelProcessing = JE.t?.("jellyseerr_btn_processing") || "Processing";
    const labelPending = JE.t?.("jellyseerr_btn_pending") || "Pending Approval";
    const labelRequested = JE.t?.("jellyseerr_btn_requested") || "Requested";
    const labelRejected = JE.t?.("jellyseerr_btn_rejected") || "Rejected";
    const labelComingSoon = JE.t?.("requests_coming_soon") || "Coming Soon";

    // Check for "Coming Soon" status - items with future release dates
    // For TV shows: can be approved, processing, or partially available with upcoming episodes
    // For movies: only approved or processing
    if (item && hasFutureReleaseDate(item)) {
      const isTV = item.type === 'tv';
      const allowedStatuses = isTV
        ? ['approved', 'processing', 'partially available']
        : ['approved', 'processing'];
      if (allowedStatuses.includes(normalized)) {
        return { label: labelComingSoon, className: "je-chip-coming-soon" };
      }
    }

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
    const STATUS_COLORS = getStatusColors();
    const statusColor = STATUS_COLORS[item.status] || STATUS_COLORS.Unknown;
    const sourceIcon = item.source === "Sonarr" ? SONARR_ICON_URL : RADARR_ICON_URL;
    const sourceLabel = item.source;

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
      <div class="je-download-card" ${item.jellyfinMediaId ? `data-media-id="${item.jellyfinMediaId}"` : ''}>
        <div class="je-download-card-content">
          ${posterHtml}
          <div class="je-download-info">
            <div class="je-download-title" title="${item.title || ""}">${item.title || JE.t?.("requests_unknown") || "Unknown"}</div>
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
    const status = resolveRequestStatus(item.mediaStatus, item);
    const releaseDateLabel = getReleaseDateLabel(item);

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
      watchButton = `<button class="je-request-watch-btn" title="${playLabel}" aria-label="${playLabel}" data-media-id="${item.jellyfinMediaId}">${playIcon}</button>`;
    }

    return `
            <div class="je-request-card" ${item.jellyfinMediaId ? `data-media-id="${item.jellyfinMediaId}"` : ''}>
                ${posterHtml}
                <div class="je-request-info">
                    <div class="je-request-header">
                      <div>
                        <div class="je-request-title-row">
                          <div class="je-request-title">${item.title || "Unknown"}</div>
                          ${item.year ? `<span class="je-request-year">(${item.year})</span>` : ""}
                        </div>
                        <span class="je-requests-status-chip ${status.className}">${status.label}</span>${releaseDateLabel ? `<span class="je-release-date-chip">${releaseDateLabel}</span>` : ""}
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
      if (item.source === "Sonarr" && item.seasonNumber != null) {
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
    const STATUS_COLORS = getStatusColors();
    const item = group.item;
    const statusColor = STATUS_COLORS[item.status] || STATUS_COLORS.Unknown;

    const posterHtml = item.posterUrl
      ? `<img class="je-download-poster" src="${item.posterUrl}" alt="" loading="lazy" onerror="this.style.display='none'">`
      : `<div class="je-download-poster placeholder"></div>`;

    // Calculate total size for the pack
    // Check if all episodes have identical sizes (season pack download)
    const firstSize = group.episodes[0]?.totalSize || 0;
    const firstRemaining = group.episodes[0]?.sizeRemaining || 0;
    const isSeasonPackDownload = group.episodes.every(
      (ep) => ep.totalSize === firstSize && ep.sizeRemaining === firstRemaining
    );

    // If it's a season pack download (same size for all), use the size once
    // Otherwise, sum individual episode sizes
    const totalSize = isSeasonPackDownload
      ? firstSize
      : group.episodes.reduce((sum, ep) => sum + (ep.totalSize || 0), 0);
    const sizeRemaining = isSeasonPackDownload
      ? firstRemaining
      : group.episodes.reduce((sum, ep) => sum + (ep.sizeRemaining || 0), 0);

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
      <div class="je-download-card je-season-pack" ${item.jellyfinMediaId ? `data-media-id="${item.jellyfinMediaId}"` : ''}>
        <div class="je-download-card-content">
          ${posterHtml}
          <div class="je-download-info">
            <div class="je-download-title" title="${item.title || ""}">${item.title || JE.t?.("requests_unknown") || "Unknown"}</div>
            <div class="je-download-subtitle">${JE.t?.("requests_season") || "Season"} ${item.seasonNumber} (${group.episodeCount} ${JE.t?.("requests_episodes") || "episodes"})</div>
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
      const paginationInfo = getDownloadsPaginationInfo();
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
        if (state.requestsFilter === "processing") {
          // Exclude "Partially Available" items from Processing tab
          filteredRequests = state.requests.filter(item => {
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

    container.innerHTML = html;

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

    // Add click handlers for cards and watch buttons
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

      // Handle card clicks to navigate to item
      const card = e.target.closest('.je-download-card, .je-request-card');
      if (card) {
        const mediaId = card.getAttribute('data-media-id');
        if (mediaId && window.Emby?.Page?.showItem) {
          window.Emby.Page.showItem(mediaId);
        }
      }
    });
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

  /**
   * Show the downloads page with proper Jellyfin integration
   */
  function showPage() {
    if (state.pageVisible) return;

    state.pageVisible = true;

    // Ensure page exists first
    const page = createPageContainer();
    if (!page) {
      console.error(`${logPrefix} Failed to create page container`);
      state.pageVisible = false;
      return;
    }

    if (window.location.hash !== "#/downloads") {
      history.pushState({ page: "downloads" }, "Requests", "#/downloads");
    }

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

    // Only load data once (guard against showPage retries)
    if (!state.isLoading) {
      loadAllData();
      startPolling();
    }
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
    stopLocationWatcher();
  }

  /**
   * Start polling for updates
   */
  function startPolling() {
    stopPolling();
    const config = JE.pluginConfig || {};

    // Check if polling is enabled
    if (!config.DownloadsPagePollingEnabled) {
      return;
    }

    const intervalSeconds = config.DownloadsPollIntervalSeconds !== undefined
      ? config.DownloadsPollIntervalSeconds
      : 30;


    // Check visibility across all view modes: normal page, plugin pages, or custom tabs
    const isVisible = state.pageVisible || state._pluginPageVisible || state._customTabMode;
    if (!isVisible) {
      return;
    }

    const interval = intervalSeconds * 1000;
    state.pollTimer = setInterval(() => {
      // Re-check visibility on each interval
      const currentlyVisible = state.pageVisible || state._pluginPageVisible || state._customTabMode;
      if (currentlyVisible && !state.isLoading) {
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
    const config = JE.pluginConfig || {};
    if (!config.DownloadsPageEnabled) return;
    if (pluginPagesExists && config.DownloadsUsePluginPages) return;
    if (config.DownloadsUseCustomTabs) return; // Skip sidebar injection if using custom tabs

    // Hide plugin page link if it exists
    const pluginPageItem = sidebar?.querySelector(
      'a[is="emby-linkbutton"][data-itemid="Jellyfin.Plugin.JellyfinEnhanced.DownloadsPage"]'
    );

    if (pluginPageItem) {
      pluginPageItem.style.setProperty('display', 'none', 'important');
    }

    // Check if already exists
    if (document.querySelector(".je-nav-downloads-item")) {
      return;
    }

    const jellyfinEnhancedSection = document.querySelector('.jellyfinEnhancedSection');

    if (jellyfinEnhancedSection) {
      const navItem = document.createElement("a");
      navItem.setAttribute('is', 'emby-linkbutton');
      navItem.className =
        "navMenuOption lnkMediaFolder emby-button je-nav-downloads-item";
      navItem.href = "#";
      const labelRequests = (JE.t && JE.t('requests_requests')) || 'Requests';
      navItem.innerHTML = `
        <span class="navMenuOptionIcon material-icons">download</span>
        <span class="sectionName navMenuOptionText">${labelRequests}</span>
      `;
      navItem.addEventListener("click", (e) => {
        e.preventDefault();
        showPage();
      });

      jellyfinEnhancedSection.appendChild(navItem);
      console.log(`${logPrefix} Navigation item injected`);
    } else {
      console.log(`${logPrefix} jellyfinEnhancedSection not found, will wait for it`);
    }
  }

  /**
   * Setup navigation watcher - observes only when link is missing
   */
  function setupNavigationWatcher() {
    const config = JE.pluginConfig || {};
    if (!config.DownloadsPageEnabled) return;
    if (pluginPagesExists && config.DownloadsUsePluginPages) return;
    if (config.DownloadsUseCustomTabs) return; // Don't watch if using custom tabs

    // Use MutationObserver to watch for sidebar changes, but disconnect after re-injection
    const observer = new MutationObserver(() => {
      // Re-check config each time to avoid injecting when settings change
      const currentConfig = JE.pluginConfig || {};
      if (currentConfig.DownloadsUseCustomTabs) return;
      if (pluginPagesExists && currentConfig.DownloadsUsePluginPages) return;

      if (!document.querySelector('.je-nav-downloads-item')) {
        const jellyfinEnhancedSection = document.querySelector('.jellyfinEnhancedSection');
        if (jellyfinEnhancedSection) {
          console.log(`${logPrefix} Sidebar rebuilt, re-injecting navigation`);
          injectNavigation();
        }
      }
    });

    // Observe the main drawer
    const navDrawer = document.querySelector('.mainDrawer, .navDrawer, body');
    if (navDrawer) {
      observer.observe(navDrawer, { childList: true, subtree: true });
    }
  }

  /**
   * Handle URL hash changes
   */
  function handleNavigation() {
    const hash = window.location.hash;
    const path = window.location.pathname;
    if (hash === "#/downloads" || path === "/downloads") {
      console.log(`${logPrefix} handleNavigation matched downloads (hash=${hash} path=${path})`);
      // Show page to win races against Jellyfin's router rendering 404
      showPage();
    } else if (state.pageVisible) {
      console.log(`${logPrefix} handleNavigation hiding page (hash=${hash} path=${path})`);
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

    const usingPluginPages = pluginPagesExists && config.DownloadsUsePluginPages;
    if (usingPluginPages) {
      console.log(`${logPrefix} Downloads page is injected via Plugin Pages`);
      return;
    }

    // Page-specific setup for custom tabs or dedicated page mode
    createPageContainer();

    // Inject navigation and set up one-time re-injection on sidebar rebuild
    injectNavigation();
    setupNavigationWatcher();

    // Intercept router changes before Jellyfin handles them
    window.addEventListener("hashchange", interceptNavigation, true);
    window.addEventListener("popstate", interceptNavigation, true);

    // Listen for hash changes - handles browser back/forward and direct URL changes
    window.addEventListener("hashchange", handleNavigation);
    window.addEventListener("popstate", handleNavigation);

    startLocationWatcher();

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

        // Handle play button clicks
        const playBtn = e.target.closest(".je-request-watch-btn");
        if (playBtn) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          const mediaId = playBtn.getAttribute("data-media-id");
          if (mediaId && window.Emby?.Page?.showItem) {
            window.Emby.Page.showItem(mediaId);
          }
          return;
        }

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

  /**
   * Intercept hash/popstate changes for our route before Jellyfin router
   */
  function interceptNavigation(e) {
    const url = e?.newURL ? new URL(e.newURL) : window.location;
    const hash = url.hash;
    const path = url.pathname;
    const matches = hash === "#/downloads" || path === "/downloads";
    if (matches) {
      if (e?.stopImmediatePropagation) e.stopImmediatePropagation();
      if (e?.preventDefault) e.preventDefault();
      showPage();
    }
  }

  // Poll location because Jellyfin's router uses pushState (no popstate/hashchange fired for pushState)
  function startLocationWatcher() {
    if (state.locationTimer) return;

    state.locationSignature = `${window.location.pathname}${window.location.hash}`;

    // Use throttle helper if available for better performance
    const throttledCheck = JE.helpers?.throttle?.(() => {
      const signature = `${window.location.pathname}${window.location.hash}`;
      if (signature !== state.locationSignature) {
        state.locationSignature = signature;
        handleNavigation();
      }
    }, 150) || (() => {
      const signature = `${window.location.pathname}${window.location.hash}`;
      if (signature !== state.locationSignature) {
        state.locationSignature = signature;
        handleNavigation();
      }
    });

    state.locationTimer = setInterval(throttledCheck, 150);
  }

  function stopLocationWatcher() {
    if (state.locationTimer) {
      clearInterval(state.locationTimer);
      state.locationTimer = null;
    }
  }

  /**
   * Render content for custom tabs (without page state management)
   */
  function renderForCustomTab() {
    state._customTabMode = true;
    injectStyles();
    renderPage();
    loadAllData();
    startPolling();
  }

  // Export to JE namespace
  JE.downloadsPage = {
    initialize,
    showPage,
    hidePage,
    refresh: loadAllData,
    startPolling,
    stopPolling,
    filterDownloads,
    searchDownloads,
    filterRequests,
    nextPage,
    prevPage,
    renderPage,
    renderForCustomTab,
    injectStyles
  };

  JE.initializeDownloadsPage = initialize;
})();
