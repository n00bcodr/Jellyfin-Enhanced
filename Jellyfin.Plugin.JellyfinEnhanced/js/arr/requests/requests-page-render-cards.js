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

  // client/src/features/downloads/validation.ts
  function record(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
  }
  function response(v) {
    if (!record(v)) throw new Error("Invalid downloads response");
    return v;
  }
  function text(v) {
    if (v == null) return void 0;
    if (typeof v !== "string") throw new Error("Invalid text");
    return v;
  }
  function readLinks(v) {
    const r = response(v);
    const result = {};
    for (const key of ["movies", "series"]) {
      if (r[key] == null) continue;
      const entries = response(r[key]);
      const out = {};
      for (const [id, v2] of Object.entries(entries)) {
        const entry = response(v2);
        out[id] = { matches: Array.isArray(entry.matches) ? entry.matches.map((m) => {
          const r2 = response(m);
          return { urlMappings: text(r2.urlMappings) || "", instanceUrl: text(r2.instanceUrl) || "", titleSlug: text(r2.titleSlug) || "" };
        }) : [] };
      }
      result[key] = out;
    }
    return result;
  }
  function safeUrl(value, base) {
    if (!value) return "";
    try {
      const url = new URL(value, base);
      return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
    } catch {
      return "";
    }
  }
  function serviceUrl(value, path, base) {
    const validated = safeUrl(value, base);
    if (!validated) return "";
    const url = new URL(validated);
    url.pathname = url.pathname.replace(/\/+$/, "") + "/" + path;
    return url.href;
  }

  // client/generated-shared/stub/client/src/features/downloads/runtime.ts
  var shared2 = /* @__PURE__ */ sharedModule("features/downloads/runtime");
  var export02 = /* @__PURE__ */ sharedExport(shared2, "runtime");

  // client/src/features/downloads/render-cards.ts
  function install(deps) {
    const { JE, P, host, ctx } = deps;
    const life = export02(deps);
    if (life.installed.has("render-cards")) return;
    life.installed.add("render-cards");
    const state = P.state;
    const getStatusColors = P.getStatusColors;
    const formatTimeRemaining = P.formatTimeRemaining;
    const formatRelativeDate = P.formatRelativeDate;
    const getReleaseDateLabel = P.getReleaseDateLabel;
    const formatDownloadStats = P.formatDownloadStats;
    const resolveRequestStatus = P.resolveRequestStatus;
    const getIssueMediaType = P.getIssueMediaType;
    const getIssueTmdbId = P.getIssueTmdbId;
    const translateStatus = P.translateStatus;
    const escapeHtml = JE.escapeHtml;
    const SONARR_ICON_URL = JE.cdn.selfhst("svg/sonarr.svg");
    const RADARR_ICON_URL = JE.cdn.selfhst("svg/radarr-light-hybrid-light.svg");
    const SEERR_ICON_URL = JE.cdn.selfhst("svg/seerr.svg");
    function renderDownloadCard(item) {
      const STATUS_COLORS = getStatusColors();
      const statusColor = STATUS_COLORS[(item.status || "unknown").toLowerCase()] || STATUS_COLORS.unknown;
      const sourceIcon = item.source === "Sonarr" ? SONARR_ICON_URL : RADARR_ICON_URL;
      const sourceLabel = escapeHtml(item.instanceName || item.source);
      const posterHtml = item.posterUrl ? `<img class="je-download-poster" src="${escapeHtml(item.posterUrl)}" alt="" loading="lazy" onerror="this.style.display='none'">` : `<div class="je-download-poster placeholder"></div>`;
      const progressHtml = `
      <div class="je-download-progress-container">
        <div class="je-download-progress">
          <div class="je-download-progress-bar" style="width: ${Math.max(0, Math.min(100, item.progress || 0))}%; background: ${statusColor}"></div>
        </div>
        <div class="je-download-stats">
          <span>${Math.max(0, Math.min(100, item.progress || 0))}%</span>
          ${item.timeRemaining ? `<span>ETA: ${escapeHtml(formatTimeRemaining(item.timeRemaining))}</span>` : ""}
          ${item.totalSize ? `<span>${formatDownloadStats(item.totalSize, item.sizeRemaining)}</span>` : ""}
        </div>
      </div>
    `;
      return `
      <div class="je-download-card" ${item.jellyfinMediaId ? `data-media-id="${escapeHtml(item.jellyfinMediaId)}"` : ""}>
        <div class="je-download-card-content">
          ${posterHtml}
          <div class="je-download-info">
            <div class="je-download-title" title="${escapeHtml(item.title || "")}">${escapeHtml(item.title || JE.t?.("requests_unknown") || "Unknown")}</div>
            ${item.subtitle ? `<div class="je-download-subtitle" title="${escapeHtml(item.subtitle)}">${escapeHtml(item.subtitle)}</div>` : ""}
            <div class="je-download-meta">
                <span class="je-download-badge je-arr-badge" title="${sourceLabel}"><img src="${sourceIcon}" alt="${sourceLabel}" loading="lazy"></span>
              <span class="je-download-badge" style="background: ${statusColor}">${escapeHtml(translateStatus(item.status))}</span>
            </div>
          </div>
        </div>
        ${progressHtml}
      </div>
    `;
    }
    function renderRequestCard(item) {
      const status = resolveRequestStatus(item.mediaStatus, item);
      const releaseDateLabel = getReleaseDateLabel(item);
      let posterHtml = "";
      if (item.posterUrl) {
        posterHtml = `<img class="je-request-poster" src="${escapeHtml(item.posterUrl)}" alt="" loading="lazy">`;
      } else {
        posterHtml = `<div class="je-request-poster placeholder"></div>`;
      }
      let avatarHtml = "";
      if (item.requestedByAvatar) {
        avatarHtml = `<img class="je-request-avatar" data-avatar-src="${escapeHtml(item.requestedByAvatar)}" alt="" loading="lazy" style="display:none" onerror="this.style.display='none'">`;
      }
      let watchButton = "";
      if (item.jellyfinMediaId && (item.mediaStatus === "Available" || item.mediaStatus === "Partially Available")) {
        const playLabel = JE.t?.("jellyseerr_btn_available") || "Available";
        const playIcon = '<span class="material-icons">play_arrow</span>';
        watchButton = `<button class="je-request-watch-btn" title="${escapeHtml(playLabel)}" aria-label="${escapeHtml(playLabel)}" data-media-id="${escapeHtml(item.jellyfinMediaId)}">${playIcon}</button>`;
      }
      let approvalButtons = "";
      if (state.canApproveRequests && item.requestStatus === 1 && item.id) {
        approvalButtons = `
        <button class="je-request-approve-btn" data-request-id="${escapeHtml(String(item.id))}" title="Approve"><span class="material-icons">check</span></button>
        <button class="je-request-decline-btn" data-request-id="${escapeHtml(String(item.id))}" title="Decline"><span class="material-icons">close</span></button>
      `;
      }
      let releaseDateHtml = "";
      if (releaseDateLabel) {
        const dateText = typeof releaseDateLabel === "object" ? releaseDateLabel.label : releaseDateLabel;
        const icon = typeof releaseDateLabel === "object" && releaseDateLabel.icon ? `<span class="material-icons je-release-date-icon">${escapeHtml(releaseDateLabel.icon)}</span>` : "";
        releaseDateHtml = `<span class="je-release-date-chip">${icon}${typeof dateText === "object" ? dateText.text || "" : escapeHtml(dateText)}</span>`;
      }
      let seerrLinkHtml = "";
      const seerrLinksEnabled = JE.pluginConfig?.JellyseerrEnabled !== false && JE.pluginConfig?.JellyseerrShowDetailPageLink !== false;
      const seerrBase = safeUrl(ctx.peer("jellyseerrAPI")?.resolveJellyseerrBaseUrl?.() || "", host.location.href);
      if (item.tmdbId && seerrLinksEnabled && seerrBase) {
        const mediaType = item.type === "tv" ? "tv" : "movie";
        const seerrLabel = JE.t?.("jellyseerr_card_view_on_jellyseerr") || "View on Seerr";
        seerrLinkHtml = `<a is="emby-linkbutton" class="je-request-external-link" href="${escapeHtml(serviceUrl(seerrBase, `${mediaType}/${item.tmdbId}`, host.location.href))}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(seerrLabel)}" aria-label="${escapeHtml(seerrLabel)}"><img src="${SEERR_ICON_URL}" alt="Seerr"></a>`;
      }
      let externalLinksHtml = "";
      if (item.tmdbId) {
        externalLinksHtml = `<div class="je-request-external-links" data-tmdb-id="${escapeHtml(String(item.tmdbId))}" data-tvdb-id="${escapeHtml(String(item.tvdbId || ""))}" data-media-type="${escapeHtml(item.type || "")}">${seerrLinkHtml}</div>`;
      }
      const titleMediaIdAttr = item.jellyfinMediaId ? ` data-media-id="${escapeHtml(item.jellyfinMediaId)}"` : "";
      const titleClass = item.jellyfinMediaId ? "je-request-title je-request-title-link" : "je-request-title";
      return `
            <div class="je-request-card${item.isOrphaned ? " je-request-card-orphaned" : ""}">
                <div class="je-request-poster-col">
                    ${posterHtml}
                    ${externalLinksHtml}
                </div>
                <div class="je-request-info">
                    <div class="je-request-header">
                      <div>
                        <div class="je-request-title-row">
                          <div class="${titleClass}"${titleMediaIdAttr}>${escapeHtml(item.title || "Unknown")}</div>
                          ${item.year ? `<span class="je-request-year">(${escapeHtml(item.year)})</span>` : ""}
                        </div>
                        <span class="je-requests-status-chip ${escapeHtml(status.className)}">${escapeHtml(status.label)}</span>${releaseDateHtml}
                      </div>
                    </div>
                    <div class="je-request-meta">
                      <div class="je-request-meta-left">
                        ${avatarHtml}
                        <span>${escapeHtml(item.requestedBy || "Unknown")}</span>
                        ${item.createdAt ? `<span>&#8226;</span><span>${escapeHtml(formatRelativeDate(item.createdAt))}</span>` : ""}
                      </div>
                    </div>
                    ${watchButton || approvalButtons ? `<div class="je-request-actions">${watchButton}${approvalButtons}</div>` : ""}
                </div>
            </div>
        `;
    }
    function getIssueTypeLabel(issueType) {
      const labels = {
        1: JE.t?.("jellyseerr_report_issue_type_video") || "Video",
        2: JE.t?.("jellyseerr_report_issue_type_audio") || "Audio",
        3: JE.t?.("jellyseerr_report_issue_type_subtitles") || "Subtitles",
        4: JE.t?.("jellyseerr_report_issue_type_other") || "Other"
      };
      return labels[issueType || 4] || "Other";
    }
    function getIssueStatusLabel(status) {
      const normalized = String(status || "").toLowerCase();
      const labelResolved = JE.t?.("jellyseerr_issue_resolved") || "Resolved";
      const labelOpen = JE.t?.("jellyseerr_issue_open") || "Open";
      if (normalized === "2" || normalized === "resolved") {
        return { label: labelResolved, className: "je-issue-status-resolved" };
      }
      return { label: labelOpen, className: "je-issue-status-open" };
    }
    function getIssueMediaTitle(issue) {
      const media = issue?.media || {};
      return media.title || media.name || media.originalTitle || media.originalName || "Unknown";
    }
    function getIssueMediaYear(issue) {
      const media = issue?.media || {};
      const dateStr = media.releaseDate || media.firstAirDate || "";
      if (!dateStr || dateStr.length < 4) return "";
      return dateStr.substring(0, 4);
    }
    function getIssuePosterUrl(issue) {
      const media = issue?.media || {};
      if (media.mediaInfo?.posterPath) return `https://image.tmdb.org/t/p/w300${media.mediaInfo.posterPath}`;
      if (media.mediaInfo?.poster_path) return `https://image.tmdb.org/t/p/w300${media.mediaInfo.poster_path}`;
      if (media.posterUrl) return media.posterUrl;
      if (media.posterPath) return `https://image.tmdb.org/t/p/w300${media.posterPath}`;
      return "";
    }
    function getIssueJellyfinMediaId(issue) {
      const media = issue?.media || {};
      return media.jellyfinMediaId || media.mediaInfo?.jellyfinMediaId || media.mediaInfo?.jellyfinMediaId4k || media.mediaInfo?.jellyfinMediaId4K || null;
    }
    function getIssueReporter(issue) {
      const user = issue?.createdBy || {};
      return user.jellyfinUsername || user.displayName || user.username || user.email || "Unknown";
    }
    function getIssueAvatarUrl(issue) {
      const avatar = issue?.createdBy?.avatar;
      if (!avatar) return "";
      if (avatar.startsWith("/")) {
        return `/JellyfinEnhanced/proxy/avatar?path=${encodeURIComponent(avatar)}`;
      }
      return avatar;
    }
    function getIssueMessage(issue) {
      if (issue?.message) return issue.message;
      const firstComment = Array.isArray(issue?.comments) ? issue.comments[0] : null;
      return firstComment?.message || "";
    }
    function renderIssueCard(issue) {
      const posterUrl = getIssuePosterUrl(issue);
      const title = getIssueMediaTitle(issue);
      const year = getIssueMediaYear(issue);
      const typeLabel = getIssueTypeLabel(issue?.issueType || issue?.problemType);
      const status = getIssueStatusLabel(issue?.status);
      const reporter = getIssueReporter(issue);
      const avatarUrl = getIssueAvatarUrl(issue);
      const message = getIssueMessage(issue);
      const mediaType = getIssueMediaType(issue);
      const tmdbId = getIssueTmdbId(issue);
      const canView = !!(tmdbId && mediaType);
      const jellyfinMediaId = getIssueJellyfinMediaId(issue);
      const posterHtml = posterUrl ? `<img class="je-request-poster" src="${escapeHtml(posterUrl)}" alt="" loading="lazy" onerror="this.style.display='none'">` : `<div class="je-request-poster placeholder"></div>`;
      const avatarHtml = avatarUrl ? `<img class="je-request-avatar" data-avatar-src="${escapeHtml(avatarUrl)}" alt="" loading="lazy" style="display:none" onerror="this.style.display='none'">` : "";
      return `
      <div class="je-issue-card" ${jellyfinMediaId ? `data-media-id="${escapeHtml(jellyfinMediaId)}"` : ""}>
        ${posterHtml}
        <div class="je-issue-info">
          <div class="je-issue-title-row">
            <div class="je-issue-title">${escapeHtml(title)}${year ? ` <span class="je-request-year">(${escapeHtml(year)})</span>` : ""}</div>
            <span class="je-issue-status-chip ${status.className}">${escapeHtml(status.label)}</span>
            <span class="je-issue-type-chip">${escapeHtml(typeLabel)}</span>
          </div>
          ${message ? `<div class="je-issue-message">${escapeHtml(message)}</div>` : ""}
          <div class="je-issue-summary">
            ${avatarHtml}
            <span>${escapeHtml(reporter)}</span>
            ${issue?.createdAt ? `<span>&#8226;</span><span>${escapeHtml(formatRelativeDate(issue.createdAt))}</span>` : ""}
            <button class="je-issue-view-btn ${canView ? "" : "is-disabled"}" type="button" aria-label="View issue" ${canView ? `data-issue-tmdb-id="${escapeHtml(tmdbId)}" data-issue-media-type="${escapeHtml(mediaType)}" data-issue-title="${escapeHtml(title)}"` : "disabled"}>
              <span class="material-icons">visibility</span>
            </button>
          </div>
        </div>
      </div>
    `;
    }
    function renderHistoryCard(item) {
      const sourceIcon = item.source === "Sonarr" ? SONARR_ICON_URL : RADARR_ICON_URL;
      const sourceLabel = escapeHtml(item.instanceName || item.source);
      const isPartial = item.eventType === "partial";
      const isImported = item.eventType === "imported";
      const statusLabel = isPartial ? JE.t?.("downloads_history_partial") || "Partially Imported" : isImported ? JE.t?.("downloads_history_imported") || "Imported" : JE.t?.("downloads_history_failed") || "Import Failed";
      const statusClass = isPartial ? "je-chip-partial" : isImported ? "je-chip-available" : "je-chip-declined";
      const episodeSummary = item.episodeCount ? (JE.t?.("downloads_history_partial_summary") || "{imported}/{total} episodes imported").replace("{imported}", String(item.importedCount ?? 0)).replace("{total}", String(item.episodeCount)) : null;
      const posterHtml = item.posterUrl ? `<img class="je-request-poster" src="${escapeHtml(item.posterUrl)}" alt="" loading="lazy" onerror="this.style.display='none'">` : `<div class="je-request-poster placeholder"></div>`;
      return `
      <div class="je-request-card">
        ${posterHtml}
        <div class="je-request-info">
          <div class="je-request-header">
            <div>
              <div class="je-request-title-row">
                <div class="je-request-title">${escapeHtml(item.title || JE.t?.("requests_unknown") || "Unknown")}</div>
                ${item.subtitle ? `<span class="je-request-year">${escapeHtml(item.subtitle)}</span>` : ""}
              </div>
              <span class="je-requests-status-chip ${statusClass}">${escapeHtml(statusLabel)}</span>
              ${episodeSummary ? `<span class="je-download-subtitle">${escapeHtml(episodeSummary)}</span>` : ""}
            </div>
          </div>
          <div class="je-request-meta">
            <div class="je-request-meta-left">
              <span class="je-download-badge je-arr-badge" title="${sourceLabel}"><img src="${sourceIcon}" alt="${sourceLabel}" loading="lazy"></span>
              <span>${escapeHtml(sourceLabel)}</span>
              ${item.date ? `<span>&#8226;</span><span>${escapeHtml(formatRelativeDate(item.date))}</span>` : ""}
            </div>
          </div>
        </div>
      </div>
    `;
    }
    function renderSeasonPackCard(group) {
      const STATUS_COLORS = getStatusColors();
      const item = group.item;
      const statusColor = STATUS_COLORS[(item.status || "unknown").toLowerCase()] || STATUS_COLORS.unknown;
      const posterHtml = item.posterUrl ? `<img class="je-download-poster" src="${escapeHtml(item.posterUrl)}" alt="" loading="lazy" onerror="this.style.display='none'">` : `<div class="je-download-poster placeholder"></div>`;
      const firstSize = group.episodes[0]?.totalSize || 0;
      const firstRemaining = group.episodes[0]?.sizeRemaining || 0;
      const isSeasonPackDownload = group.episodes.every(
        (ep) => ep.totalSize === firstSize && ep.sizeRemaining === firstRemaining
      );
      const totalSize = isSeasonPackDownload ? firstSize : group.episodes.reduce((sum, ep) => sum + (ep.totalSize || 0), 0);
      const sizeRemaining = isSeasonPackDownload ? firstRemaining : group.episodes.reduce((sum, ep) => sum + (ep.sizeRemaining || 0), 0);
      const progressHtml = `
      <div class="je-download-progress-container">
        <div class="je-download-progress">
          <div class="je-download-progress-bar" style="width: ${Math.max(0, Math.min(100, item.progress || 0))}%; background: ${statusColor}"></div>
        </div>
        <div class="je-download-stats">
          <span>${Math.max(0, Math.min(100, item.progress || 0))}%</span>
          ${item.timeRemaining ? `<span>ETA: ${escapeHtml(formatTimeRemaining(item.timeRemaining))}</span>` : ""}
          ${totalSize ? `<span>${formatDownloadStats(totalSize, sizeRemaining)}</span>` : ""}
        </div>
      </div>
    `;
      return `
      <div class="je-download-card je-season-pack" ${item.jellyfinMediaId ? `data-media-id="${escapeHtml(item.jellyfinMediaId)}"` : ""}>
        <div class="je-download-card-content">
          ${posterHtml}
          <div class="je-download-info">
            <div class="je-download-title" title="${escapeHtml(item.title || "")}">${escapeHtml(item.title || JE.t?.("requests_unknown") || "Unknown")}</div>
            <div class="je-download-subtitle">${JE.t?.("requests_season") || "Season"} ${item.seasonNumber} (${group.episodeCount} ${JE.t?.("requests_episodes") || "episodes"})</div>
            <div class="je-download-meta">
              <span class="je-download-badge je-arr-badge" title="Sonarr"><img src="${SONARR_ICON_URL}" alt="Sonarr" loading="lazy"></span>
              <span class="je-download-badge" style="background: ${statusColor}">${escapeHtml(translateStatus(item.status))}</span>
              <span class="je-download-badge" style="background: rgba(128,128,128,0.4)">${group.episodeRange}</span>
            </div>
          </div>
        </div>
        ${progressHtml}
      </div>
    `;
    }
    function parseUrlMappings(mappingsString) {
      const mappings = [];
      if (!mappingsString) return mappings;
      mappingsString.split("\n").forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        const parts = trimmed.split("|").map((p) => p.trim());
        if (parts.length === 2 && parts[0] && parts[1]) {
          mappings.push({ jellyfinUrl: parts[0], arrUrl: parts[1] });
        }
      });
      return mappings;
    }
    function getMappedUrl(urlMappings, defaultUrl) {
      if (!defaultUrl) return null;
      if (!urlMappings || urlMappings.length === 0) return defaultUrl;
      const serverAddress = host.ApiClient?.serverAddress?.() || window.location.origin;
      const currentUrl = serverAddress.replace(/\/+$/, "").toLowerCase();
      for (const mapping of urlMappings) {
        const normalizedJellyfinUrl = mapping.jellyfinUrl.replace(/\/+$/, "").toLowerCase();
        if (currentUrl === normalizedJellyfinUrl) {
          return mapping.arrUrl.replace(/\/$/, "");
        }
      }
      return defaultUrl.replace(/\/$/, "");
    }
    const ARR_LINKS_BATCH_MAX_IDS = 100;
    const ARR_LINKS_FIRST_CHUNK = 6;
    let externalLinksLookup = null;
    function buildArrLinkButton(mediaType, tmdbId, data) {
      const match = (data?.matches || [])[0];
      const mappedUrl = match ? getMappedUrl(parseUrlMappings(match.urlMappings || ""), match.instanceUrl) : null;
      const url = safeUrl(mappedUrl || "", host.location.href);
      if (mediaType === "movie") {
        if (!url) return null;
        return `<a is="emby-linkbutton" class="je-request-external-link" href="${escapeHtml(serviceUrl(url, `movie/${encodeURIComponent(tmdbId)}`, host.location.href))}" target="_blank" rel="noopener noreferrer" title="Open in Radarr" aria-label="Open in Radarr"><img src="${RADARR_ICON_URL}" alt="Radarr"></a>`;
      }
      if (!url || !match?.titleSlug) return null;
      return `<a is="emby-linkbutton" class="je-request-external-link" href="${escapeHtml(serviceUrl(url, `series/${encodeURIComponent(match.titleSlug)}`, host.location.href))}" target="_blank" rel="noopener noreferrer" title="Open in Sonarr" aria-label="Open in Sonarr"><img src="${SONARR_ICON_URL}" alt="Sonarr"></a>`;
    }
    async function hydrateExternalLinks(container) {
      const lease = life.capture();
      if (!lease.current()) return;
      const arrLinksEnabled = JE.pluginConfig?.ArrLinksEnabled === true;
      if (!arrLinksEnabled || !JE.helpers.isAdmin()) return;
      const slots = container.querySelectorAll(".je-request-external-links[data-tmdb-id]");
      if (!slots.length) return;
      const cards = [];
      slots.forEach((slot) => {
        const tmdbId = slot.getAttribute("data-tmdb-id");
        const tvdbId = slot.getAttribute("data-tvdb-id");
        const mediaType = slot.getAttribute("data-media-type") === "tv" ? "tv" : "movie";
        if (!tmdbId) return;
        const rawId = (mediaType === "movie" ? tmdbId : tvdbId || "").trim();
        if (!/^\d+$/.test(rawId) || !(Number(rawId) > 0) || Number(rawId) > 2147483647) return;
        cards.push({ slot, mediaType, tmdbId, id: String(Number(rawId)) });
      });
      if (!cards.length) return;
      const firstRequests = [];
      const restRequests = [];
      for (const [mediaType, param, field] of [["movie", "tmdbIds", "movies"], ["tv", "tvdbIds", "series"]]) {
        const ids = [...new Set(cards.filter((c) => c.mediaType === mediaType).map((c) => c.id))];
        const toRequest = (chunk) => ({ param, field, query: `${param}=${chunk.join(",")}` });
        if (!ids.length) continue;
        firstRequests.push(toRequest(ids.slice(0, ARR_LINKS_FIRST_CHUNK)));
        for (let i = ARR_LINKS_FIRST_CHUNK; i < ids.length; i += ARR_LINKS_BATCH_MAX_IDS) {
          restRequests.push(toRequest(ids.slice(i, i + ARR_LINKS_BATCH_MAX_IDS)));
        }
      }
      const requests = [...firstRequests, ...restRequests];
      const key = JSON.stringify([JE.session?.getEpoch(), host.ApiClient?.getCurrentUserId(), host.ApiClient?.serverAddress?.(), requests.map((r) => r.query)]);
      let lookup = externalLinksLookup;
      if (!lookup || lookup.key !== key || lookup.controller.signal.aborted) {
        if (lookup) lookup.controller.abort();
        const controller2 = new AbortController();
        const lifecycle = JE.core.lifecycle?.register("arr-requests-page");
        lifecycle?.track(controller2);
        const chunks2 = requests.map((r) => ({
          field: r.field,
          promise: JE.core.api.plugin(`/arr/links?${r.query}`, { signal: controller2.signal, priority: "low" }).then(readLinks).catch(() => null)
        }));
        const current = { key, controller: controller2, chunks: chunks2 };
        Promise.all(chunks2.map((c) => c.promise)).then(() => {
          lifecycle?.untrack(controller2);
          if (externalLinksLookup === current) externalLinksLookup = null;
        });
        lookup = current;
        externalLinksLookup = current;
      }
      const { controller, chunks } = lookup;
      await Promise.all(chunks.map(async ({ field, promise }) => {
        const data = await promise;
        const entries = data?.[field];
        if (!lease.current() || !JE.helpers.isAdmin() || JE.pluginConfig?.ArrLinksEnabled !== true || controller.signal.aborted || !entries || typeof entries !== "object") return;
        const mediaType = field === "movies" ? "movie" : "tv";
        for (const card of cards) {
          if (card.mediaType !== mediaType || !card.slot.isConnected) continue;
          if (!Object.prototype.hasOwnProperty.call(entries, card.id)) continue;
          const button = buildArrLinkButton(mediaType, card.tmdbId, entries[card.id]);
          if (button) card.slot.insertAdjacentHTML("beforeend", button);
        }
      }));
    }
    P.renderDownloadCard = renderDownloadCard;
    P.renderRequestCard = renderRequestCard;
    P.hydrateExternalLinks = hydrateExternalLinks;
    P.renderIssueCard = renderIssueCard;
    P.renderHistoryCard = renderHistoryCard;
    P.renderSeasonPackCard = renderSeasonPackCard;
  }

  // client/src/features/downloads/render-cards-entry.ts
  install(export0());
})();
})();
//# sourceMappingURL=requests-page-render-cards.js.map
