// /js/arr/calendar/calendar-page-render-events.js
// Calendar Page — date-range helpers, event formatting and single-event /
// agenda-event / card rendering (split from calendar-page.js).
(function () {
  "use strict";

  const JE = window.JellyfinEnhanced;
  JE.internals = JE.internals || {};
  const P = (JE.internals.calendarPage = JE.internals.calendarPage || {});

  const state = P.state;
  const STATUS_COLORS = P.STATUS_COLORS;

  const escapeHtml = JE.escapeHtml;

  const SONARR_ICON_URL = window.JellyfinEnhanced.cdn.selfhst('svg/sonarr.svg');
  const RADARR_ICON_URL = window.JellyfinEnhanced.cdn.selfhst('svg/radarr-light-hybrid-light.svg');
  const SHOKO_ICON_URL = window.JellyfinEnhanced.cdn.selfhst('svg/shoko.svg');

  // Get start and end dates for current view
  function getRangeForView(anchorDate, viewMode) {
    const start = new Date(
      anchorDate.getFullYear(),
      anchorDate.getMonth(),
      anchorDate.getDate(),
      0, 0, 0, 0
    );

    if (viewMode === "month") {
      start.setDate(1);
      const end = new Date(
        start.getFullYear(),
        start.getMonth() + 1,
        0,
        23, 59, 59, 999
      );
      return { start, end };
    }

    if (viewMode === "week") {
      const daysOfWeek = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
      const firstDayIndex = daysOfWeek.indexOf(state.settings.firstDayOfWeek);
      const currentDayIndex = start.getDay();
      const diff = (currentDayIndex - firstDayIndex + 7) % 7;
      start.setDate(start.getDate() - diff);

      const end = new Date(start);
      end.setDate(start.getDate() + 6);
      end.setHours(23, 59, 59, 999);
      return { start, end };
    }

    if (viewMode === "day") {
      const endDay = new Date(start);
      endDay.setHours(23, 59, 59, 999);
      return { start, end: endDay };
    }

    const endAgenda = new Date(start);
    endAgenda.setDate(start.getDate() + 29);
    endAgenda.setHours(23, 59, 59, 999);
    return { start, end: endAgenda };
  }

  /**
   * Get days in month
   */
  function getDaysInMonth(date) {
    return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  }

  /**
   * Get first day of month
   */
  function getFirstDayOfMonth(date) {
    const firstDay = new Date(date.getFullYear(), date.getMonth(), 1);
    const dayOfWeek = firstDay.getDay();

    // Convert based on first day of week setting
    const daysOfWeek = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const firstDayOfWeek = daysOfWeek.indexOf(state.settings.firstDayOfWeek);

    return (dayOfWeek - firstDayOfWeek + 7) % 7;
  }

  function isTodayDate(date) {
    const now = new Date();
    return date.getFullYear() === now.getFullYear()
      && date.getMonth() === now.getMonth()
      && date.getDate() === now.getDate();
  }

  /**
   * Get event color
   */
  function getEventColor(event) {
    const map = {
      CinemaRelease: STATUS_COLORS.CinemaRelease,
      DigitalRelease: STATUS_COLORS.DigitalRelease,
      PhysicalRelease: STATUS_COLORS.PhysicalRelease,
      Episode: STATUS_COLORS.Episode,
      Anime: STATUS_COLORS.Anime,
    };

    const themeVars = JE.themer?.getThemeVariables() || {};
    const primaryAccent = themeVars.primaryAccent || '#00a4dc';
    return map[event.releaseType] || primaryAccent;
  }

  // Get translated release type label
  function formatReleaseLabel(event) {
    const JE = window.JellyfinEnhanced;
    if (event.releaseType === "CinemaRelease") return JE.t("calendar_cinema_release");
    if (event.releaseType === "DigitalRelease") return JE.t("calendar_digital_release");
    if (event.releaseType === "PhysicalRelease") return JE.t("calendar_physical_release");
    if (event.releaseType === "Episode") return JE.t("calendar_episode");
    if (event.releaseType === "Anime") return JE.t("calendar_anime");
    return "Release";
  }

  // Format event time for display
  function formatEventTime(releaseDate) {
    if (!releaseDate) return null;
    const date = new Date(releaseDate);
    if (Number.isNaN(date.getTime())) return null;

    if (date.getHours() === 0 && date.getMinutes() === 0) return null;

    const hour12 = state.settings.timeFormat === "5pm/5:30pm";
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12 });
  }

  // Format date range label for header
  function formatRangeLabel() {
    if (!state.rangeStart || !state.rangeEnd) {
      return new Date(state.currentDate).toLocaleDateString(undefined, { month: "long", year: "numeric" });
    }

    if (state.viewMode === "month") {
      return new Date(state.currentDate).toLocaleDateString(undefined, { month: "long", year: "numeric" });
    }

    const startLabel = state.rangeStart.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const endLabel = state.rangeEnd.toLocaleDateString(undefined, { month: "short", day: "numeric" });

    if (state.viewMode === "week") {
      return `${startLabel} - ${endLabel}`;
    }

    if (state.viewMode === "day") {
      const dayLabel = window.JellyfinEnhanced.t?.("calendar_day") || "Day";
      const relativeLabel = getRelativeDayLabel(state.rangeStart);
      return `${dayLabel} • ${relativeLabel}`;
    }

    return `${window.JellyfinEnhanced.t("calendar_agenda")} • ${startLabel} → ${endLabel}`;
  }

  function getRelativeDayLabel(date) {
    const d = new Date(date);
    const today = new Date();
    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const targetStart = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diffDays = Math.round((targetStart - todayStart) / 86400000);

    if (diffDays === 0) return window.JellyfinEnhanced.t?.("calendar_today");
    if (diffDays === -1) return window.JellyfinEnhanced.t?.("calendar_yesterday");
    if (diffDays === 1) return window.JellyfinEnhanced.t?.("calendar_tomorrow");
    return targetStart.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function formatHourLabel(hour) {
    const hour12 = state.settings.timeFormat === "5pm/5:30pm";
    const base = new Date(2000, 0, 1, hour, 0, 0, 0);
    return base.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12 });
  }

  /**
   * Build tooltip text for calendar event
   */
  function buildEventTooltip(event) {
    let tooltip = event.title;

    // Add episode info for series (e.g., "S01E05 - Episode Title")
    if (event.type === "Series" && event.subtitle) {
      tooltip += ` ${event.subtitle}`;
    }

    return tooltip;
  }

  function renderStatusIcons(event) {
    const userData = state.userDataMap?.get(event.id);
    const watchlistLabel = window.JellyfinEnhanced.t?.("calendar_watchlist") || "Watchlist";
    const watchedLabel = window.JellyfinEnhanced.t?.("calendar_watched") || "Watched";
    const icons = [];

    if (state.settings.highlightFavorites && userData?.isFavorite) {
      icons.push(`<span class="je-calendar-status-icon je-status-watchlist material-symbols-rounded" title="${watchlistLabel}" aria-label="${watchlistLabel}">bookmark</span>`);
    }
    if (state.settings.highlightWatchedSeries && userData?.isWatched) {
      icons.push(`<span class="je-calendar-status-icon je-status-watched material-symbols-rounded" title="${watchedLabel}" aria-label="${watchedLabel}">visibility</span>`);
    }

    if (!icons.length) return "";
    return `<span class="je-calendar-status-icons">${icons.join("")}</span>`;
  }

  /**
   * Build the display label for the instance badge on a calendar event.
   * Join all instances so the badge reads e.g. "Radarr, Radarr4K" instead of just "Radarr".
   */
  function buildInstanceLabel(event) {
    const primary = event.instanceName || event.source;
    if (!Array.isArray(event.alsoInInstances) || event.alsoInInstances.length === 0) {
      return primary;
    }
    const all = [primary, ...event.alsoInInstances];
    return all.join(", ");
  }

  function buildTimePill(event) {
    const timeLabel = formatEventTime(event.releaseDate);
    if (!timeLabel) return "";

    const releaseDate = event.releaseDate ? new Date(event.releaseDate) : null;
    const releaseTime = releaseDate && !Number.isNaN(releaseDate.getTime()) ? releaseDate.getTime() : null;
    const nowTime = Date.now();
    const isPast = releaseTime !== null && releaseTime <= nowTime;
    const isLate = releaseTime !== null && (nowTime - releaseTime) >= 24 * 60 * 60 * 1000;
    const timePillClass = event.hasFile
      ? "je-calendar-card-time is-available"
      : (isLate ? "je-calendar-card-time is-late is-unavailable" : (isPast ? "je-calendar-card-time is-past is-unavailable" : "je-calendar-card-time is-unavailable"));

    const labelHtml = timeLabel ? `<span class="je-calendar-card-time-label">${escapeHtml(timeLabel)}</span>` : "";
    return `<div class="${timePillClass}">${labelHtml}</div>`;
  }

  function formatTimeText(event) {
    const timeLabel = formatEventTime(event.releaseDate);
    return timeLabel ? `<span style="opacity: 0.85; font-size: 1em;">${escapeHtml(timeLabel)}</span>` : "";
  }

  function normalizeImageUrl(url) {
    return encodeURI(url).replace(/'/g, "%27");
  }

  // Shoko never sends image URLs to the client (no Shoko-authenticated URLs are exposed) — once
  // matched to a Jellyfin item, its poster comes from Jellyfin's own image API instead.
  function getShokoPosterUrl(event) {
    if (event.source !== "Shoko" || typeof ApiClient === "undefined") return null;
    const matchedItemId = event.itemId || event.itemEpisodeId;
    if (!matchedItemId) return null;
    return ApiClient.getImageUrl(matchedItemId, { type: "Primary", quality: 90 });
  }

  function getEventPosterUrl(event) {
    return event.posterUrl || event.backdropUrl || getShokoPosterUrl(event);
  }

  // AniDB only has date-level granularity, so anime events never carry a time-of-day; sort them
  // after time-stamped events landing on the same day instead of at the (misleadingly early)
  // midnight position a plain date sort would give them.
  function eventHasTime(event) {
    return !!formatEventTime(event.releaseDate);
  }

  function compareEventsWithinDay(a, b) {
    const aHasTime = eventHasTime(a);
    const bHasTime = eventHasTime(b);
    if (aHasTime !== bHasTime) return aHasTime ? -1 : 1;
    return new Date(a.releaseDate) - new Date(b.releaseDate);
  }

  function getEventBackgroundStyle(event, color) {
    if (state.settings.displayMode !== "backdrop") {
      return `background: ${color}20;`;
    }
    const imageUrl = event.backdropUrl || getShokoPosterUrl(event) || event.posterUrl;
    if (!imageUrl) {
      return `background: ${color}20;`;
    }

    const overlay = "rgba(0, 0, 0, 0.6)";
    const safeUrl = normalizeImageUrl(imageUrl);
    return `background-image: linear-gradient(${overlay}, ${overlay}), url('${safeUrl}'); background-size: cover; background-position: center; background-repeat: no-repeat;`;
  }

  /**
   * Render calendar event
   */
  function renderEvent(event) {
    const color = getEventColor(event);
    const releaseTypeLabel = formatReleaseLabel(event);
    const typeIcon = event.source === "Shoko" ? SHOKO_ICON_URL : (event.type === "Series" ? SONARR_ICON_URL : RADARR_ICON_URL);
    const sourceLabelRaw = buildInstanceLabel(event);
    const sourceLabel = escapeHtml(sourceLabelRaw);
    const iconClass = event.source === "Sonarr" ? "je-calendar-sonarr-icon" : (event.source === "Shoko" ? "je-calendar-shoko-icon" : "je-calendar-radarr-icon");
    const subtitle = event.subtitle ? `<span class="je-calendar-event-subtitle">${escapeHtml(event.subtitle)}</span>` : "";
    const hasFileClass = event.hasFile ? " je-has-file" : "";
    const tooltip = buildEventTooltip(event);
    const hasBackdropClass = (state.settings.displayMode === "backdrop" && getEventPosterUrl(event)) ? " je-has-backdrop" : "";
    const statusIcons = renderStatusIcons(event);
    const statusTop = statusIcons ? `<div class="je-calendar-event-status-top">${statusIcons}</div>` : "";
    const timeText = formatTimeText(event);
    const playButton = event.hasFile ? `<button class="je-calendar-play-btn" title="${window.JellyfinEnhanced.t?.("jellyseerr_btn_available")}" aria-label="${window.JellyfinEnhanced.t?.("jellyseerr_btn_available")}" data-event-id="${escapeHtml(event.id)}"><span class="material-icons">play_arrow</span></button>` : "";
    const backgroundStyle = getEventBackgroundStyle(event, color);

    return `
      <div class="je-calendar-event${hasFileClass}${hasBackdropClass}" style="border-left-color: ${color}; ${backgroundStyle}" title="${escapeHtml(tooltip)}" data-event-id="${escapeHtml(event.id)}">
        ${statusTop}
        <span class="je-calendar-event-title">${escapeHtml(event.title)}</span>
        ${subtitle}
        <div class="je-calendar-event-type">
          <img src="${typeIcon}" alt="${escapeHtml(event.type)}" class="${iconClass}" />
          <span>${releaseTypeLabel} • <span class="je-arr-badge" title="${sourceLabel}">${sourceLabel}</span></span>
          ${timeText ? ` • ${timeText}` : ""}${playButton}
        </div>
      </div>
    `;
  }

  // Render single event in agenda view
  function renderAgendaEvent(event) {
    const color = getEventColor(event);
    const releaseTypeLabel = formatReleaseLabel(event);
    const typeIcon = event.source === "Shoko" ? SHOKO_ICON_URL : (event.type === "Series" ? SONARR_ICON_URL : RADARR_ICON_URL);
    const sourceLabelRaw = buildInstanceLabel(event);
    const sourceLabel = escapeHtml(sourceLabelRaw);
    const iconClass = event.source === "Sonarr" ? "je-sonarr-icon" : (event.source === "Shoko" ? "je-shoko-icon" : "je-radarr-icon");
    const subtitle = event.subtitle || "";
    const timeLabel = formatEventTime(event.releaseDate);
    const hasFileClass = event.hasFile ? " je-has-file" : "";

    // Build indicators array (only add if they exist)
    const indicators = [];
    if (event.hasFile) {
      indicators.push(`<button class="je-calendar-play-btn" title="${window.JellyfinEnhanced.t("jellyseerr_btn_available")}" aria-label="${window.JellyfinEnhanced.t("jellyseerr_btn_available")}" data-event-id="${escapeHtml(event.id)}"><span class="material-icons">play_arrow</span></button>`);
    }
    const statusIcons = renderStatusIcons(event);
    if (statusIcons) {
      indicators.push(statusIcons);
    }

    // Get material icon based on release type
    let materialIcon = "movie";
    if (event.releaseType === "CinemaRelease") materialIcon = "local_movies";
    else if (event.releaseType === "DigitalRelease") materialIcon = "ondemand_video";
    else if (event.releaseType === "PhysicalRelease") materialIcon = "album";
    else if (event.releaseType === "Episode") materialIcon = "tv_guide";
    else if (event.releaseType === "Anime") materialIcon = "animation";

    const subtitleHtml = subtitle
      ? `<span class="je-calendar-agenda-subtitle">${escapeHtml(subtitle)}</span>`
      : "";

    return `
      <div class="je-calendar-agenda-event${hasFileClass}" data-event-id="${escapeHtml(event.id)}">
        <div class="je-calendar-agenda-indicators">
          ${indicators.join('')}
        </div>
        <span class="material-symbols-rounded" style="font-size: 20px;">${materialIcon}</span>
        <div class="je-calendar-agenda-event-marker" style="background: ${color};"></div>
        <div class="je-calendar-agenda-event-content">
          <div class="je-calendar-agenda-event-title">
            <span class="je-calendar-agenda-title-text">${escapeHtml(event.title)}</span>
            ${subtitleHtml}
          </div>
          <div class="je-calendar-agenda-event-meta">
            <img src="${typeIcon}" alt="${escapeHtml(event.type)}" class="${iconClass}" />
            <span>${releaseTypeLabel}</span>
            <span>•</span>
            <span class="je-arr-badge" title="${sourceLabel}">${sourceLabel}</span>
            ${timeLabel ? `<span>• ${escapeHtml(timeLabel)}</span>` : ""}
          </div>
        </div>
      </div>
    `;
  }

  function renderCardItems(events) {
    if (!events.length) return "";

    return events.map((event) => {
      const poster = getEventPosterUrl(event);
      const releaseTypeLabel = formatReleaseLabel(event);
      const typeIcon = event.source === "Shoko" ? SHOKO_ICON_URL : (event.type === "Series" ? SONARR_ICON_URL : RADARR_ICON_URL);
      const sourceLabelRaw = buildInstanceLabel(event);
      const sourceLabel = escapeHtml(sourceLabelRaw);
      const iconClass = event.source === "Sonarr" ? "je-calendar-sonarr-icon" : (event.source === "Shoko" ? "je-calendar-shoko-icon" : "je-calendar-radarr-icon");
      const statusIcons = renderStatusIcons(event);
      const timePill = buildTimePill(event);
      const playButton = event.hasFile ? `<button class="je-calendar-play-btn je-calendar-play-btn-card" title="${window.JellyfinEnhanced.t?.("jellyseerr_btn_available")}" aria-label="${window.JellyfinEnhanced.t?.("jellyseerr_btn_available")}" data-event-id="${escapeHtml(event.id)}"><span class="material-icons">play_arrow</span></button>` : "";
      const timeRow = timePill || playButton ? `<div class="je-calendar-card-time-row">${timePill}${playButton}</div>` : "";
      const statusTop = statusIcons ? `<div class="je-calendar-card-status-top">${statusIcons}</div>` : "";
      const color = getEventColor(event);
      if (poster) {
        return `
          <div class="je-calendar-card" data-event-id="${escapeHtml(event.id)}" style="border-bottom-color: ${color};">
            <div class="je-calendar-card-image-wrap">
              <img src="${normalizeImageUrl(poster)}" alt="" class="je-calendar-card-image">
              ${statusTop}
              <div class="je-calendar-card-overlay">
                ${timeRow}
                <div class="je-calendar-card-title">
                  <span class="je-calendar-card-title-text">${escapeHtml(event.title)}</span>
                </div>
                ${event.subtitle ? `<div class="je-calendar-card-subtitle">${escapeHtml(event.subtitle)}</div>` : `<div class="je-calendar-card-subtitle"></div>`}
                <div class="je-calendar-card-meta">
                  <img src="${typeIcon}" alt="${escapeHtml(event.type)}" class="${iconClass}" />
                  <span>${releaseTypeLabel}</span>
                  <span>•</span>
                  <span class="je-arr-badge" title="${sourceLabel}">${sourceLabel}</span>
                </div>
              </div>
            </div>
          </div>
        `;
      }

      return `
        <div class="je-calendar-card" data-event-id="${escapeHtml(event.id)}" style="border-bottom-color: ${color};">
          ${statusTop}
          ${timeRow}
          <div class="je-calendar-card-title">
            <span class="je-calendar-card-title-text">${escapeHtml(event.title)}</span>
          </div>
          ${event.subtitle ? `<div class="je-calendar-card-subtitle">${escapeHtml(event.subtitle)}</div>` : `<div class="je-calendar-card-subtitle"></div>`}
          <div class="je-calendar-card-meta">
            <img src="${typeIcon}" alt="${escapeHtml(event.type)}" class="${iconClass}" />
            <span>${releaseTypeLabel}</span>
            <span>•</span>
            <span class="je-arr-badge" title="${sourceLabel}">${sourceLabel}</span>
          </div>
        </div>
      `;
    }).join("");
  }

  P.getRangeForView = getRangeForView;
  P.getDaysInMonth = getDaysInMonth;
  P.getFirstDayOfMonth = getFirstDayOfMonth;
  P.isTodayDate = isTodayDate;
  P.formatRangeLabel = formatRangeLabel;
  P.formatHourLabel = formatHourLabel;
  P.renderEvent = renderEvent;
  P.renderAgendaEvent = renderAgendaEvent;
  P.renderCardItems = renderCardItems;
  P.eventHasTime = eventHasTime;
  P.compareEventsWithinDay = compareEventsWithinDay;
})();
