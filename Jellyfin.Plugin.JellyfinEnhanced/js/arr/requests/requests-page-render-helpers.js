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

  // client/src/features/downloads/domain.ts
  function groupDownloads(downloads) {
    const grouped = [];
    const seasonPackMap = /* @__PURE__ */ new Map();
    for (const item of downloads) {
      if (item.source === "Sonarr" && item.seasonNumber != null) {
        const key = JSON.stringify([item.source, item.instanceId ?? item.instanceName, item.title, item.seasonNumber, item.progress]);
        if (!seasonPackMap.has(key)) {
          seasonPackMap.set(key, []);
        }
        const bucket = seasonPackMap.get(key);
        if (bucket) bucket.push(item);
      } else {
        grouped.push({ type: "single", item });
      }
    }
    for (const [, episodes] of seasonPackMap) {
      if (episodes.length >= 3) {
        const first = episodes[0];
        if (!first) continue;
        const episodeNums = episodes.map((e) => e.episodeNumber).sort((a, b) => (a || 0) - (b || 0));
        const minEp = episodeNums[0];
        const maxEp = episodeNums[episodeNums.length - 1];
        grouped.push({
          type: "seasonPack",
          item: first,
          episodes,
          episodeRange: `E${String(minEp).padStart(2, "0")}-E${String(maxEp).padStart(2, "0")}`,
          episodeCount: episodes.length
        });
      } else {
        for (const ep of episodes) {
          grouped.push({ type: "single", item: ep });
        }
      }
    }
    return grouped;
  }

  // client/generated-shared/stub/client/src/features/downloads/runtime.ts
  var shared2 = /* @__PURE__ */ sharedModule("features/downloads/runtime");
  var export02 = /* @__PURE__ */ sharedExport(shared2, "runtime");

  // client/src/features/downloads/render-helpers.ts
  function install(deps) {
    const { JE, P, host, ctx, getApi } = deps;
    const life = export02(deps);
    if (life.installed.has("render-helpers")) return;
    life.installed.add("render-helpers");
    const state = P.state;
    const getStatusColors = () => {
      const themeVars = JE.themer?.getThemeVariables() || {};
      const primaryAccent = themeVars.primaryAccent || "#00a4dc";
      return {
        downloading: primaryAccent,
        importing: "#4caf50",
        queued: "rgba(128,128,128,0.6)",
        paused: "#ff9800",
        delayed: "#ff9800",
        warning: "#ff9800",
        // Stalled
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
      return translations[status || "unknown"] || status || "Unknown";
    }
    function getDownloadStatuses() {
      const statuses = /* @__PURE__ */ new Map();
      const statusOrder = ["Downloading", "Queued", "Paused", "Importing", "Completed", "Warning", "Failed", "Unknown"];
      const groupedDownloads = groupDownloads(state.downloads);
      for (const group of groupedDownloads) {
        const item = group.type === "seasonPack" ? group.item : group.item;
        const status = item.status || "Unknown";
        if (!statuses.has(status)) {
          statuses.set(status, 0);
        }
        statuses.set(status, (statuses.get(status) || 0) + 1);
      }
      const sorted = Array.from(statuses.entries()).sort((a, b) => {
        const indexA = statusOrder.findIndex((s) => s.toLowerCase() === a[0].toLowerCase());
        const indexB = statusOrder.findIndex((s) => s.toLowerCase() === b[0].toLowerCase());
        return (indexA === -1 ? statusOrder.length : indexA) - (indexB === -1 ? statusOrder.length : indexB);
      });
      return sorted;
    }
    function getFilteredDownloads() {
      let filtered = state.downloads;
      const hiddenContent = ctx.peer("hiddenContent");
      if (hiddenContent) filtered = hiddenContent.filterRequestItems(filtered);
      if (state.downloadsActiveTab !== "all") {
        filtered = filtered.filter((d) => d.status === state.downloadsActiveTab);
      }
      if (state.downloadsSearchQuery.trim()) {
        const query = state.downloadsSearchQuery.toLowerCase();
        filtered = filtered.filter(
          (d) => d.title && d.title.toLowerCase().includes(query) || d.subtitle && d.subtitle.toLowerCase().includes(query) || d.instanceName && d.instanceName.toLowerCase().includes(query)
        );
      }
      return filtered;
    }
    function formatBytes(bytes) {
      if (!bytes || bytes === 0) return "0 B";
      const k = 1024;
      const sizes = ["B", "KB", "MB", "GB", "TB"];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
    }
    function formatTimeRemaining(timeStr) {
      if (!timeStr) return "";
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
    function formatRelativeDate(dateStr) {
      if (!dateStr) return "";
      const date = new Date(dateStr);
      if (isNaN(date.getTime())) {
        return "";
      }
      const now = /* @__PURE__ */ new Date();
      const diff = now.getTime() - date.getTime();
      if (diff < 0) return "";
      const minutes = Math.floor(diff / 6e4);
      const hours = Math.floor(diff / 36e5);
      const days = Math.floor(diff / 864e5);
      if (minutes < 1) return JE.t?.("requests_just_now") || "just now";
      if (minutes < 60) return JE.t?.("requests_minutes_ago")?.replace("{minutes}", String(minutes)) || `${minutes}m ago`;
      if (hours < 24) return JE.t?.("requests_hours_ago")?.replace("{hours}", String(hours)) || `${hours}h ago`;
      if (days < 30) return JE.t?.("requests_days_ago")?.replace("{days}", String(days)) || `${days}d ago`;
      return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
    }
    function formatFutureReleaseDate(dateStr) {
      if (!dateStr) return null;
      const date = new Date(dateStr);
      if (isNaN(date.getTime())) return null;
      const now = /* @__PURE__ */ new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const releaseDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
      const diffMs = releaseDay.getTime() - today.getTime();
      const diffDays = Math.ceil(diffMs / 864e5);
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
        const month = date.toLocaleString("default", { month: "long" });
        const suffix = getOrdinalSuffix(day);
        return {
          isHtml: true,
          text: labelOn.replace("{date}", `${day}${suffix} ${month}`)
        };
      }
    }
    function getOrdinalSuffix(day) {
      if (day > 3 && day < 21) return "<sup>th</sup>";
      switch (day % 10) {
        case 1:
          return "<sup>st</sup>";
        case 2:
          return "<sup>nd</sup>";
        case 3:
          return "<sup>rd</sup>";
        default:
          return "<sup>th</sup>";
      }
    }
    function hasFutureReleaseDate(item) {
      const releaseDate = item.type === "tv" ? item.nextAirDate : item.digitalReleaseDate || item.theatricalReleaseDate;
      if (!releaseDate) return false;
      const date = new Date(releaseDate);
      if (isNaN(date.getTime())) return false;
      const now = /* @__PURE__ */ new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const releaseDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
      return releaseDay > today;
    }
    function getReleaseDateLabel(item) {
      if (item.type === "tv") {
        const label = formatFutureReleaseDate(item.nextAirDate);
        return label ? { label, icon: "tv", isHtml: false } : null;
      }
      if (item.digitalReleaseDate) {
        const label = formatFutureReleaseDate(item.digitalReleaseDate);
        return label ? { label, icon: "cloud", isHtml: false } : null;
      }
      if (item.theatricalReleaseDate) {
        const label = formatFutureReleaseDate(item.theatricalReleaseDate);
        return label ? { label, icon: "local_movies", isHtml: false } : null;
      }
      return null;
    }
    function formatDownloadStats(totalSize, sizeRemaining) {
      if (!totalSize || totalSize <= 0) return "";
      const remaining = Math.max(0, Math.min(totalSize, sizeRemaining || 0));
      const downloaded = Math.max(0, Math.min(totalSize, totalSize - remaining));
      return `${formatBytes(downloaded)} / ${formatBytes(totalSize)}`;
    }
    function resolveRequestStatus(status, item = null) {
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
      if (item && hasFutureReleaseDate(item)) {
        const isTV = item.type === "tv";
        const allowedStatuses = isTV ? ["approved", "processing", "partially available"] : ["approved", "processing"];
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

  // client/src/features/downloads/render-helpers-entry.ts
  install(export0());
})();
})();
//# sourceMappingURL=requests-page-render-helpers.js.map
