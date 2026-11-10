import { groupDownloads } from "./domain";
import type { Dependencies, Item, Group } from "./types";

import { runtime } from './runtime';
export function install(deps: Dependencies) {
  const {JE, P, host, ctx, getApi} = deps;
  const life = runtime(deps);
  if(life.installed.has('render-helpers'))return;
  life.installed.add('render-helpers');

  



  const state = P.state;

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

  /**
   * Translate download status to localized label
   */
  function translateStatus(status: string|undefined) {
    const translations: Record<string,string> = {
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
    return translations[status || "unknown"] || status || "Unknown";
  }

  /**
   * Get unique statuses from downloads
   * Counts season packs as 1 download instead of counting each episode
   */
  function getDownloadStatuses() {
    const statuses = new Map<string,number>();
    const statusOrder = ["Downloading", "Queued", "Paused", "Importing", "Completed", "Warning", "Failed", "Unknown"];

    // Group downloads first so season packs are counted as 1
    const groupedDownloads = groupDownloads(state.downloads);

    for (const group of groupedDownloads) {
      const item = group.type === "seasonPack" ? group.item : group.item;
      const status = item.status || "Unknown";
      if (!statuses.has(status)) {
        statuses.set(status, 0);
      }
      statuses.set(status, (statuses.get(status) || 0) + 1);
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

    // Filter hidden content
    const hiddenContent = ctx.peer('hiddenContent');
    if (hiddenContent) filtered = hiddenContent.filterRequestItems(filtered);

    // Filter by status tab
    if (state.downloadsActiveTab !== "all") {
      filtered = filtered.filter(d => d.status === state.downloadsActiveTab);
    }

    // Filter by search query
    if (state.downloadsSearchQuery.trim()) {
      const query = state.downloadsSearchQuery.toLowerCase();
      filtered = filtered.filter(d =>
        (d.title && d.title.toLowerCase().includes(query)) ||
        (d.subtitle && d.subtitle.toLowerCase().includes(query)) ||
        (d.instanceName && d.instanceName.toLowerCase().includes(query))
      );
    }

    return filtered;
  }


  /**
   * Format bytes to human readable
   */
  function formatBytes(bytes: number) {
    if (!bytes || bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  }

  /**
   * Format time remaining
   */
  function formatTimeRemaining(timeStr: string|null|undefined) {
    if (!timeStr) return "";

    // Handle HH:MM:SS format
    const match = timeStr.match(/^(\d+):(\d+):(\d+)$/);
    if (match) {
      const hours = parseInt(match[1] || "0");
      const minutes = parseInt(match[2] || "0");
      const seconds = parseInt(match[3] || "0");

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
      const days = parseInt(dayMatch[1] || "0");
      const hours = parseInt(dayMatch[2] || "0");
      const minutes = parseInt(dayMatch[3] || "0");
      const seconds = parseInt(dayMatch[4] || "0");

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
  function formatRelativeDate(dateStr: string|undefined) {
    if (!dateStr) return "";

    const date = new Date(dateStr);

    // Check if date parsing failed
    if (isNaN(date.getTime())) {
      return "";
    }

    const now = new Date();
    const diff = now.getTime() - date.getTime();

    // Handle negative diff (future dates) or invalid dates
    if (diff < 0) return "";

    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return JE.t?.("requests_just_now") || "just now";
    if (minutes < 60) return JE.t?.("requests_minutes_ago")?.replace("{minutes}", String(minutes)) || `${minutes}m ago`;
    if (hours < 24) return JE.t?.("requests_hours_ago")?.replace("{hours}", String(hours)) || `${hours}h ago`;
    if (days < 30) return JE.t?.("requests_days_ago")?.replace("{days}", String(days)) || `${days}d ago`;

    // For older dates, show the date in "DD MMM YYYY" format
    return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  /**
   * Format future release date as relative time
   * Examples: "today", "tomorrow", "in 7 days", "on 14th February"
   */
  function formatFutureReleaseDate(dateStr: string|undefined) {
    if (!dateStr) return null;

    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return null;

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const releaseDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());

    const diffMs = releaseDay.getTime() - today.getTime();
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
      return labelInDays.replace("{days}", String(diffDays));
    } else {
      const day = date.getDate();
      const month = date.toLocaleString('default', { month: 'long' });
      const suffix = getOrdinalSuffix(day);
      return {
        isHtml: true,
        text: labelOn.replace("{date}", `${day}${suffix} ${month}`)
      };
    }
  }

  /**
   * Get ordinal suffix for day number as superscript (1st, 2nd, etc.)
   * Returns plain text suffix without HTML tags
   */
  function getOrdinalSuffix(day: number) {
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
  function hasFutureReleaseDate(item: Item) {
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
  function getReleaseDateLabel(item: Item) {
    if (item.type === 'tv') {
      const label = formatFutureReleaseDate(item.nextAirDate);
      return label ? { label, icon: 'tv', isHtml: false } : null;
    }
    if (item.digitalReleaseDate) {
      const label = formatFutureReleaseDate(item.digitalReleaseDate);
      return label ? { label, icon: 'cloud', isHtml: false } : null;
    }
    if (item.theatricalReleaseDate) {
      const label = formatFutureReleaseDate(item.theatricalReleaseDate);
      return label ? { label, icon: 'local_movies', isHtml: false } : null;
    }
    return null;
  }

  /**
   * Format downloaded/total stats with clamping
   */
  function formatDownloadStats(totalSize: number|undefined, sizeRemaining: number|undefined) {
    if (!totalSize || totalSize <= 0) return "";
    const remaining = Math.max(0, Math.min(totalSize, sizeRemaining || 0));
    const downloaded = Math.max(0, Math.min(totalSize, totalSize - remaining));
    return `${formatBytes(downloaded)} / ${formatBytes(totalSize)}`;
  }

  /**
   * Jellyseerr like chips
   */
  function resolveRequestStatus(status: string|undefined, item: Item|null = null) {
    const normalized = (status || "").toLowerCase();
    const labelAvailable = JE.t?.("jellyseerr_btn_available") || "Available";
    const labelPartial = JE.t?.("jellyseerr_btn_partially_available") || "Partially Available";
    const labelProcessing = JE.t?.("jellyseerr_btn_processing") || "Processing";
    const labelPending = JE.t?.("jellyseerr_btn_pending") || "Pending Approval";
    const labelRequested = JE.t?.("jellyseerr_btn_requested") || "Requested";
    const labelDeclined = JE.t?.("jellyseerr_btn_declined") || "Declined";
    const labelBlocklisted = JE.t?.("jellyseerr_btn_blocklisted") || "Blocklisted";
    const labelDeleted = JE.t?.("jellyseerr_btn_deleted") || "Deleted";
    const labelComingSoon = JE.t?.("requests_coming_soon") || "Coming Soon";
    const labelOrphaned = JE.t?.("requests_orphaned") || "Orphaned";

    if (item?.isOrphaned) return { label: labelOrphaned, className: "je-chip-orphaned" };

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
        return { label: labelPending, className: "je-chip-pending" };
      case "declined":
        return { label: labelDeclined, className: "je-chip-declined" };
      case "blocklisted":
        return { label: labelBlocklisted, className: "je-chip-blocklisted" };
      case "deleted":
        return { label: labelDeleted, className: "je-chip-deleted" };
      default:
        return { label: status || labelRequested, className: "je-chip-requested" };
    }
  }

  /**
   * Group downloads by season pack (same show + season + same progress indicates season pack)
   * Returns array of items where season packs are collapsed into single entries
   */

  P.getStatusColors = getStatusColors;
  P.translateStatus = translateStatus;
  P.getDownloadStatuses = getDownloadStatuses;
  P.getFilteredDownloads = getFilteredDownloads;
  P.formatTimeRemaining = formatTimeRemaining;
  P.formatRelativeDate = formatRelativeDate;
  P.getReleaseDateLabel = getReleaseDateLabel;
  P.formatDownloadStats = formatDownloadStats;
  P.resolveRequestStatus = resolveRequestStatus;
  P.groupDownloads = groupDownloads;

}
