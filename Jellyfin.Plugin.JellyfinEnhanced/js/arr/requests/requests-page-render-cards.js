// /js/arr/requests/requests-page-render-cards.js
// Requests Page — download, request, issue and season-pack card rendering
// (split from requests-page.js).
(function () {
  "use strict";

  const JE = window.JellyfinEnhanced;
  JE.internals = JE.internals || {};
  const P = (JE.internals.requestsPage = JE.internals.requestsPage || {});

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

  const SONARR_ICON_URL = window.JellyfinEnhanced.cdn.selfhst('svg/sonarr.svg');
  const RADARR_ICON_URL = window.JellyfinEnhanced.cdn.selfhst('svg/radarr-light-hybrid-light.svg');
  const SEERR_ICON_URL = window.JellyfinEnhanced.cdn.selfhst('svg/seerr.svg');

  /**
   * Render a download card
   */
  function renderDownloadCard(item) {
    const STATUS_COLORS = getStatusColors();
    const statusColor = STATUS_COLORS[item.status] || STATUS_COLORS.Unknown;
    const sourceIcon = item.source === "Sonarr" ? SONARR_ICON_URL : RADARR_ICON_URL;
    const sourceLabel = escapeHtml(item.instanceName || item.source);

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
              <span class="je-download-badge" style="background: ${statusColor}">${escapeHtml(translateStatus(item.status))}</span>
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
    // Gate on the request's own status (1 = Pending), NOT item.mediaStatus.
    // mediaStatus collapses to the media's availability, so a pending request
    // for a new season of an already-(partially-)available show reports
    // "Partially Available"/"Available" and would otherwise hide the buttons,
    // making the request impossible to approve from the UI.
    if (state.canApproveRequests && item.requestStatus === 1 && item.id) {
      approvalButtons = `
        <button class="je-request-approve-btn" data-request-id="${escapeHtml(String(item.id))}" title="Approve"><span class="material-icons">check</span></button>
        <button class="je-request-decline-btn" data-request-id="${escapeHtml(String(item.id))}" title="Decline"><span class="material-icons">close</span></button>
      `;
    }

    // Handle release date label - check if it contains HTML
    let releaseDateHtml = "";
    if (releaseDateLabel) {
      const dateText = typeof releaseDateLabel === 'object' ? releaseDateLabel.label : releaseDateLabel;
      const icon = typeof releaseDateLabel === 'object' && releaseDateLabel.icon
        ? `<span class="material-icons je-release-date-icon">${escapeHtml(releaseDateLabel.icon)}</span>`
        : '';
      releaseDateHtml = `<span class="je-release-date-chip">${icon}${typeof dateText === 'object' ? dateText.text || '' : escapeHtml(dateText)}</span>`;
    }

    // Seerr renders immediately (no lookup needed); Radarr/Sonarr is filled
    // in asynchronously by hydrateExternalLinks() once the card is mounted.
    let seerrLinkHtml = "";
    const seerrLinksEnabled = JE.pluginConfig?.JellyseerrEnabled !== false
      && JE.pluginConfig?.JellyseerrShowDetailPageLink !== false;
    const seerrBase = JE.jellyseerrAPI?.resolveJellyseerrBaseUrl?.() || '';
    if (item.tmdbId && seerrLinksEnabled && seerrBase) {
      const mediaType = item.type === 'tv' ? 'tv' : 'movie';
      const seerrLabel = JE.t?.('jellyseerr_card_view_on_jellyseerr') || 'View on Seerr';
      seerrLinkHtml = `<a is="emby-linkbutton" class="je-request-external-link" href="${escapeHtml(`${seerrBase}/${mediaType}/${item.tmdbId}`)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(seerrLabel)}" aria-label="${escapeHtml(seerrLabel)}"><img src="${SEERR_ICON_URL}" alt="Seerr"></a>`;
    }

    let externalLinksHtml = "";
    if (item.tmdbId) {
      externalLinksHtml = `<div class="je-request-external-links" data-tmdb-id="${escapeHtml(String(item.tmdbId))}" data-tvdb-id="${escapeHtml(String(item.tvdbId || ""))}" data-media-type="${escapeHtml(item.type || "")}">${seerrLinkHtml}</div>`;
    }

    const titleMediaIdAttr = item.jellyfinMediaId ? ` data-media-id="${escapeHtml(item.jellyfinMediaId)}"` : '';
    const titleClass = item.jellyfinMediaId ? 'je-request-title je-request-title-link' : 'je-request-title';

    return `
            <div class="je-request-card">
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
                    ${(watchButton || approvalButtons) ? `<div class="je-request-actions">${watchButton}${approvalButtons}</div>` : ""}
                </div>
            </div>
        `;
  }

  function getIssueTypeLabel(issueType) {
    const labels = {
      1: JE.t?.("jellyseerr_report_issue_type_video") || "Video",
      2: JE.t?.("jellyseerr_report_issue_type_audio") || "Audio",
      3: JE.t?.("jellyseerr_report_issue_type_subtitles") || "Subtitles",
      4: JE.t?.("jellyseerr_report_issue_type_other") || "Other",
    };
    return labels[issueType] || labels[4];
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
    return media.jellyfinMediaId
      || media.mediaInfo?.jellyfinMediaId
      || media.mediaInfo?.jellyfinMediaId4k
      || media.mediaInfo?.jellyfinMediaId4K
      || null;
  }

  function getIssueReporter(issue) {
    const user = issue?.createdBy || {};
    return user.jellyfinUsername || user.displayName || user.username || user.email || "Unknown";
  }

  function getIssueAvatarUrl(issue) {
    const avatar = issue?.createdBy?.avatar;
    if (!avatar) return "";
    if (avatar.startsWith("/")) {
      return ApiClient.getUrl("/JellyfinEnhanced/proxy/avatar", { path: avatar });
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

    const posterHtml = posterUrl
      ? `<img class="je-request-poster" src="${escapeHtml(posterUrl)}" alt="" loading="lazy" onerror="this.style.display='none'">`
      : `<div class="je-request-poster placeholder"></div>`;

    const avatarHtml = avatarUrl
      ? `<img class="je-request-avatar" data-avatar-src="${escapeHtml(avatarUrl)}" alt="" loading="lazy" style="display:none" onerror="this.style.display='none'">`
      : "";

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

  /**
   * Render a history card (a recently imported or failed-to-import ARR event)
   */
  function renderHistoryCard(item) {
    const sourceIcon = item.source === "Sonarr" ? SONARR_ICON_URL : RADARR_ICON_URL;
    const sourceLabel = escapeHtml(item.instanceName || item.source);
    const isPartial = item.eventType === "partial";
    const isImported = item.eventType === "imported";
    const statusLabel = isPartial
      ? (JE.t?.("downloads_history_partial") || "Partially Imported")
      : isImported
        ? (JE.t?.("downloads_history_imported") || "Imported")
        : (JE.t?.("downloads_history_failed") || "Import Failed");
    const statusClass = isPartial ? "je-chip-partial" : (isImported ? "je-chip-available" : "je-chip-declined");

    const episodeSummary = item.episodeCount
      ? (JE.t?.("downloads_history_partial_summary") || "{imported}/{total} episodes imported")
          .replace("{imported}", item.importedCount ?? 0)
          .replace("{total}", item.episodeCount)
      : null;

    const posterHtml = item.posterUrl
      ? `<img class="je-request-poster" src="${escapeHtml(item.posterUrl)}" alt="" loading="lazy" onerror="this.style.display='none'">`
      : `<div class="je-request-poster placeholder"></div>`;

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
              <span class="je-download-badge" style="background: ${statusColor}">${escapeHtml(translateStatus(item.status))}</span>
              <span class="je-download-badge" style="background: rgba(128,128,128,0.4)">${group.episodeRange}</span>
            </div>
          </div>
        </div>
        ${progressHtml}
      </div>
    `;
  }

  // Mirrors arr-links.js's own URL-mapping logic (reverse-proxy address
  // rewriting) - kept as a small local copy since arr-links.js defines these
  // inside its own per-init closure rather than exposing them on JE.
  function parseUrlMappings(mappingsString) {
    const mappings = [];
    if (!mappingsString) return mappings;
    mappingsString.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const parts = trimmed.split('|').map(p => p.trim());
      if (parts.length === 2 && parts[0] && parts[1]) {
        mappings.push({ jellyfinUrl: parts[0], arrUrl: parts[1] });
      }
    });
    return mappings;
  }

  function getMappedUrl(urlMappings, defaultUrl) {
    if (!defaultUrl) return null;
    if (!urlMappings || urlMappings.length === 0) return defaultUrl;
    const serverAddress = (typeof ApiClient !== 'undefined' && ApiClient.serverAddress)
      ? ApiClient.serverAddress()
      : window.location.origin;
    const currentUrl = serverAddress.replace(/\/+$/, '').toLowerCase();
    for (const mapping of urlMappings) {
      const normalizedJellyfinUrl = mapping.jellyfinUrl.replace(/\/+$/, '').toLowerCase();
      if (currentUrl === normalizedJellyfinUrl) {
        return mapping.arrUrl.replace(/\/$/, '');
      }
    }
    return defaultUrl.replace(/\/$/, '');
  }

  /**
   * Fills in the "Open in Radarr or Sonarr" link for request cards, once
   * they're in the DOM. (The Seerr link needs no lookup and is already
   * rendered synchronously by renderRequestCard - this only appends the arr
   * link once its instance lookup resolves, it never overwrites the slot.)
   * Only attempted for admins with ArrLinksEnabled - matching the same gate
   * arr-links.js uses on item-details pages. The backend endpoints also
   * enforce admin-only regardless.
   * @param {HTMLElement} container
   */
  async function hydrateExternalLinks(container) {
    const arrLinksEnabled = JE.pluginConfig?.ArrLinksEnabled === true;
    if (!arrLinksEnabled || !JE.helpers.isAdmin()) return;

    const slots = container.querySelectorAll('.je-request-external-links[data-tmdb-id]');
    if (!slots.length) return;

    slots.forEach(async (slot) => {
      const tmdbId = slot.getAttribute('data-tmdb-id');
      const tvdbId = slot.getAttribute('data-tvdb-id');
      const mediaType = slot.getAttribute('data-media-type') === 'tv' ? 'tv' : 'movie';
      if (!tmdbId) return;

      let button = null;
      try {
        if (mediaType === 'movie') {
          const data = await JE.core.api.plugin(`/arr/movie-instances?tmdbId=${encodeURIComponent(tmdbId)}`);
          const match = (data?.matches || [])[0];
          const url = match ? getMappedUrl(parseUrlMappings(match.urlMappings || ''), match.instanceUrl) : null;
          if (url) {
            button = `<a is="emby-linkbutton" class="je-request-external-link" href="${escapeHtml(`${url}/movie/${tmdbId}`)}" target="_blank" rel="noopener noreferrer" title="Open in Radarr" aria-label="Open in Radarr"><img src="${RADARR_ICON_URL}" alt="Radarr"></a>`;
          }
        } else if (tvdbId) {
          const data = await JE.core.api.plugin(`/arr/series-slugs?tvdbId=${encodeURIComponent(tvdbId)}`);
          const match = (data?.matches || [])[0];
          const url = match ? getMappedUrl(parseUrlMappings(match.urlMappings || ''), match.instanceUrl) : null;
          if (url && match.titleSlug) {
            button = `<a is="emby-linkbutton" class="je-request-external-link" href="${escapeHtml(`${url}/series/${match.titleSlug}`)}" target="_blank" rel="noopener noreferrer" title="Open in Sonarr" aria-label="Open in Sonarr"><img src="${SONARR_ICON_URL}" alt="Sonarr"></a>`;
          }
        }
      } catch (e) {
        // No link is an acceptable fallback - not yet added to arr, instance
        // unreachable, etc. Silent, same as arr-links.js's own per-item misses.
      }

      if (!slot.isConnected || !button) return;
      slot.insertAdjacentHTML('beforeend', button);
    });
  }

  P.renderDownloadCard = renderDownloadCard;
  P.renderRequestCard = renderRequestCard;
  P.hydrateExternalLinks = hydrateExternalLinks;
  P.renderIssueCard = renderIssueCard;
  P.renderHistoryCard = renderHistoryCard;
  P.renderSeasonPackCard = renderSeasonPackCard;
})();
