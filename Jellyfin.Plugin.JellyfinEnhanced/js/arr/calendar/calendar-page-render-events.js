(() => {
"use strict";
(() => {
  // client/src/features/calendar/domain.ts
  function releaseDate(value) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const [y = 0, m = 0, d = 0] = value.split("-").map(Number);
      const result = new Date(y, m - 1, d);
      if (result.getFullYear() !== y || result.getMonth() !== m - 1 || result.getDate() !== d) return /* @__PURE__ */ new Date(NaN);
      return result;
    }
    return new Date(value);
  }
  function dateKey(value) {
    const date = releaseDate(value);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  // client/src/host/context.ts
  function sharedModule(id) {
    const namespace = window.JellyfinEnhanced?.core?.sharedModules?.[id];
    if (!namespace) throw new Error(`${id} is not in JE.core.sharedModules: load its provider first (client/shared-modules.json)`);
    return namespace;
  }
  function sharedExport(namespace, name) {
    return namespace[name];
  }

  // client/generated-shared/stub/client/src/features/calendar/host.ts
  var shared = /* @__PURE__ */ sharedModule("features/calendar/host");
  var export0 = /* @__PURE__ */ sharedExport(shared, "calendarHost");

  // client/src/features/calendar/calendar-page-render-events.ts
  (function() {
    "use strict";
    const { JE, host, P } = export0();
    const state = P.state;
    const STATUS_COLORS = P.STATUS_COLORS;
    const escapeHtml = JE.escapeHtml;
    const locale = () => JE.core.mediaLanguage?.uiLocale?.() || void 0;
    const SONARR_ICON_URL = JE.cdn.selfhst("svg/sonarr.svg");
    const RADARR_ICON_URL = JE.cdn.selfhst("svg/radarr-light-hybrid-light.svg");
    const SHOKO_ICON_URL = JE.cdn.selfhst("svg/shoko-server.svg");
    function getRangeForView(anchorDate, viewMode) {
      const start = new Date(
        anchorDate.getFullYear(),
        anchorDate.getMonth(),
        anchorDate.getDate(),
        0,
        0,
        0,
        0
      );
      if (viewMode === "month") {
        start.setDate(1);
        const end = new Date(
          start.getFullYear(),
          start.getMonth() + 1,
          0,
          23,
          59,
          59,
          999
        );
        return { start, end };
      }
      if (viewMode === "week") {
        const daysOfWeek = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
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
    function getDaysInMonth(date) {
      return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    }
    function getFirstDayOfMonth(date) {
      const firstDay = new Date(date.getFullYear(), date.getMonth(), 1);
      const dayOfWeek = firstDay.getDay();
      const daysOfWeek = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
      const firstDayOfWeek = daysOfWeek.indexOf(state.settings.firstDayOfWeek);
      return (dayOfWeek - firstDayOfWeek + 7) % 7;
    }
    function isTodayDate(date) {
      const now = /* @__PURE__ */ new Date();
      return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
    }
    function getEventColor(event) {
      const map = {
        CinemaRelease: STATUS_COLORS.CinemaRelease,
        DigitalRelease: STATUS_COLORS.DigitalRelease,
        PhysicalRelease: STATUS_COLORS.PhysicalRelease,
        Episode: STATUS_COLORS.Episode,
        Anime: STATUS_COLORS.Anime
      };
      const themeVars = JE.themer?.getThemeVariables() || {};
      const primaryAccent = themeVars.primaryAccent || "#00a4dc";
      return map[event.releaseType] || primaryAccent;
    }
    function formatReleaseLabel(event) {
      if (event.releaseType === "CinemaRelease") return JE.t("calendar_cinema_release");
      if (event.releaseType === "DigitalRelease") return JE.t("calendar_digital_release");
      if (event.releaseType === "PhysicalRelease") return JE.t("calendar_physical_release");
      if (event.releaseType === "Episode") return JE.t("calendar_episode");
      if (event.releaseType === "Anime") return JE.t("calendar_anime");
      return "Release";
    }
    function formatEventTime(releaseDate2) {
      if (!releaseDate2) return null;
      const date = releaseDate(releaseDate2);
      if (Number.isNaN(date.getTime())) return null;
      if (date.getHours() === 0 && date.getMinutes() === 0) return null;
      const hour12 = state.settings.timeFormat === "5pm/5:30pm";
      return date.toLocaleTimeString(locale(), { hour: "numeric", minute: "2-digit", hour12 });
    }
    function formatRangeLabel() {
      if (!state.rangeStart || !state.rangeEnd) {
        return new Date(state.currentDate).toLocaleDateString(locale(), { month: "long", year: "numeric" });
      }
      if (state.viewMode === "month") {
        return new Date(state.currentDate).toLocaleDateString(locale(), { month: "long", year: "numeric" });
      }
      const startLabel = state.rangeStart.toLocaleDateString(locale(), { month: "short", day: "numeric" });
      const endLabel = state.rangeEnd.toLocaleDateString(locale(), { month: "short", day: "numeric" });
      if (state.viewMode === "week") {
        return `${startLabel} - ${endLabel}`;
      }
      if (state.viewMode === "day") {
        const dayLabel = JE.t?.("calendar_day") || "Day";
        const relativeLabel = getRelativeDayLabel(state.rangeStart);
        return `${dayLabel} • ${relativeLabel}`;
      }
      return `${JE.t("calendar_agenda")} • ${startLabel} → ${endLabel}`;
    }
    function getRelativeDayLabel(date) {
      const d = new Date(date);
      const today = /* @__PURE__ */ new Date();
      const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      const targetStart = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      const diffDays = Math.round((targetStart.getTime() - todayStart.getTime()) / 864e5);
      if (diffDays === 0) return JE.t?.("calendar_today");
      if (diffDays === -1) return JE.t?.("calendar_yesterday");
      if (diffDays === 1) return JE.t?.("calendar_tomorrow");
      return targetStart.toLocaleDateString(locale(), { month: "short", day: "numeric" });
    }
    function formatHourLabel(hour) {
      const hour12 = state.settings.timeFormat === "5pm/5:30pm";
      const base = new Date(2e3, 0, 1, hour, 0, 0, 0);
      return base.toLocaleTimeString(locale(), { hour: "numeric", minute: "2-digit", hour12 });
    }
    function buildEventTooltip(event) {
      let tooltip = event.title;
      if (event.type === "Series" && event.subtitle) {
        tooltip += ` ${event.subtitle}`;
      }
      return tooltip;
    }
    function renderStatusIcons(event) {
      const userData = state.userDataMap?.get(event.id);
      const watchlistLabel = JE.t?.("calendar_watchlist") || "Watchlist";
      const watchedLabel = JE.t?.("calendar_watched") || "Watched";
      const icons = [];
      if (state.settings.highlightFavorites && userData?.isFavorite) {
        icons.push(`<span class="je-calendar-status-icon je-status-watchlist je-msym-rounded" title="${watchlistLabel}" aria-label="${watchlistLabel}">bookmark</span>`);
      }
      if (state.settings.highlightWatchedSeries && userData?.isWatched) {
        icons.push(`<span class="je-calendar-status-icon je-status-watched je-msym-rounded" title="${watchedLabel}" aria-label="${watchedLabel}">visibility</span>`);
      }
      if (!icons.length) return "";
      return `<span class="je-calendar-status-icons">${icons.join("")}</span>`;
    }
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
      const eventDate = event.releaseDate ? releaseDate(event.releaseDate) : null;
      const releaseTime = eventDate && !Number.isNaN(eventDate.getTime()) ? eventDate.getTime() : null;
      const nowTime = Date.now();
      const isPast = releaseTime !== null && releaseTime <= nowTime;
      const isLate = releaseTime !== null && nowTime - releaseTime >= 24 * 60 * 60 * 1e3;
      const timePillClass = event.hasFile ? "je-calendar-card-time is-available" : isLate ? "je-calendar-card-time is-late is-unavailable" : isPast ? "je-calendar-card-time is-past is-unavailable" : "je-calendar-card-time is-unavailable";
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
      const ApiClient = host.ApiClient;
      if (!defaultUrl) return null;
      if (!urlMappings || urlMappings.length === 0) return defaultUrl.replace(/\/$/, "");
      const serverAddress = typeof ApiClient !== "undefined" && ApiClient.serverAddress ? ApiClient.serverAddress() : window.location.origin;
      const currentUrl = serverAddress.replace(/\/+$/, "").toLowerCase();
      for (const mapping of urlMappings) {
        const normalizedJellyfinUrl = mapping.jellyfinUrl.replace(/\/+$/, "").toLowerCase();
        if (currentUrl === normalizedJellyfinUrl) {
          return mapping.arrUrl.replace(/\/$/, "");
        }
      }
      return defaultUrl.replace(/\/$/, "");
    }
    function getShokoWebUiUrl(event) {
      if (event.source !== "Shoko" || !event.shokoSeriesId) return null;
      const baseUrl = getMappedUrl(
        parseUrlMappings(JE.pluginConfig?.ShokoUrlMappings || ""),
        JE.pluginConfig?.ShokoUrl
      );
      if (!baseUrl) return null;
      return `${baseUrl}/webui/collection/series/${event.shokoSeriesId}`;
    }
    function renderTypeIconHtml(event, typeIcon, iconClass) {
      const img = `<img src="${typeIcon}" alt="${escapeHtml(event.type)}" class="${iconClass}" />`;
      const shokoUrl = getShokoWebUiUrl(event);
      if (!shokoUrl) return img;
      const label = JE.t?.("calendar_open_in_shoko") || "Open in Shoko";
      return `<a href="${escapeHtml(shokoUrl)}" target="_blank" rel="noopener noreferrer" class="je-calendar-shoko-link" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}" onclick="event.stopPropagation();">${img}</a>`;
    }
    function getShokoPosterUrl(event) {
      const ApiClient = host.ApiClient;
      if (event.source !== "Shoko" || typeof ApiClient === "undefined") return null;
      const matchedItemId = event.itemId || event.itemEpisodeId;
      if (!matchedItemId) return null;
      return ApiClient.getImageUrl(matchedItemId, { type: "Primary", quality: 90 });
    }
    function getEventPosterUrl(event) {
      return event.posterUrl || event.backdropUrl || getShokoPosterUrl(event);
    }
    function eventHasTime(event) {
      return !!formatEventTime(event.releaseDate);
    }
    function compareEventsWithinDay(a, b) {
      const aHasTime = eventHasTime(a);
      const bHasTime = eventHasTime(b);
      if (aHasTime !== bHasTime) return aHasTime ? -1 : 1;
      return releaseDate(a.releaseDate).getTime() - releaseDate(b.releaseDate).getTime();
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
    function collapseEpisodes(events) {
      if (!state.settings.collapseEpisodes) return events;
      const keyOf = (e) => e.type === "Series" && e.seasonNumber != null && e.episodeNumber != null ? `${e.title}|${e.seasonNumber}|${dateKey(e.releaseDate)}` : null;
      const buckets = /* @__PURE__ */ new Map();
      events.forEach((e) => {
        const k = keyOf(e);
        if (k) buckets.set(k, [...buckets.get(k) || [], e]);
      });
      const out = [];
      const done = /* @__PURE__ */ new Set();
      events.forEach((e) => {
        const k = keyOf(e);
        const members = k && buckets.get(k);
        if (!members || members.length < 2) {
          out.push(e);
          return;
        }
        if (done.has(k)) return;
        done.add(k);
        const sorted = [...members].sort((a, b) => (a.episodeNumber ?? 0) - (b.episodeNumber ?? 0));
        if (state.expandedGroups.has(k)) {
          sorted.forEach((m, i) => out.push(i === sorted.length - 1 ? { ...m, groupKey: k, groupExpanded: true } : m));
        } else {
          const representative = sorted[0];
          if (representative) out.push({ ...representative, groupKey: k, groupMembers: sorted });
        }
      });
      return out;
    }
    function isFinale(event) {
      const hit = (e) => e.finaleType === "season" || e.finaleType === "series";
      return hit(event) || !!event.groupMembers?.some(hit);
    }
    function withFinale(event, text) {
      if (!isFinale(event)) return text;
      const label = JE.t("calendar_finale");
      return text ? `${text} • ${label}` : label;
    }
    function groupSubtitle(event) {
      const m = event.groupMembers;
      if (!m?.length) return event.subtitle || "";
      const pad = (n) => String(n).padStart(2, "0");
      return `S${pad(event.seasonNumber)}E${pad(m[0]?.episodeNumber)}-${pad(m[m.length - 1]?.episodeNumber)}`;
    }
    function groupToggleHtml(event) {
      if (!event.groupKey) return "";
      const expanded = !!event.groupExpanded;
      return `<button class="je-calendar-group-toggle" data-group-key="${escapeHtml(event.groupKey)}" aria-expanded="${expanded}"><span class="material-icons">${expanded ? "expand_less" : "expand_more"}</span></button>`;
    }
    function renderEvent(event) {
      const color = getEventColor(event);
      const releaseTypeLabel = formatReleaseLabel(event);
      const typeIcon = event.source === "Shoko" ? SHOKO_ICON_URL : event.type === "Series" ? SONARR_ICON_URL : RADARR_ICON_URL;
      const sourceLabelRaw = buildInstanceLabel(event);
      const sourceLabel = escapeHtml(sourceLabelRaw);
      const iconClass = event.source === "Sonarr" ? "je-calendar-sonarr-icon" : event.source === "Shoko" ? "je-calendar-shoko-icon" : "je-calendar-radarr-icon";
      const subText = withFinale(event, event.groupMembers ? groupSubtitle(event) : event.subtitle);
      const subtitle = subText ? `<span class="je-calendar-event-subtitle">${escapeHtml(subText)}</span>` : "";
      const hasFileClass = event.hasFile ? " je-has-file" : "";
      const tooltip = buildEventTooltip(event);
      const hasBackdropClass = state.settings.displayMode === "backdrop" && getEventPosterUrl(event) ? " je-has-backdrop" : "";
      const statusIcons = renderStatusIcons(event);
      const statusTop = statusIcons ? `<div class="je-calendar-event-status-top">${statusIcons}</div>` : "";
      const timeText = formatTimeText(event);
      const playButton = event.hasFile && !event.groupMembers ? `<button class="je-calendar-play-btn" title="${JE.t?.("jellyseerr_btn_available")}" aria-label="${JE.t?.("jellyseerr_btn_available")}" data-event-id="${escapeHtml(event.id)}"><span class="material-icons">play_arrow</span></button>` : "";
      const backgroundStyle = getEventBackgroundStyle(event, color);
      return `
      <div class="je-calendar-event${hasFileClass}${hasBackdropClass}" style="border-left-color: ${color}; ${backgroundStyle}" title="${escapeHtml(tooltip)}" data-event-id="${escapeHtml(event.id)}">
        ${statusTop}
        <span class="je-calendar-event-title">${escapeHtml(event.title)}</span>
        ${subtitle}
        <div class="je-calendar-event-type">
          ${renderTypeIconHtml(event, typeIcon, iconClass)}
          <span>${releaseTypeLabel} • <span class="je-arr-badge" title="${sourceLabel}">${sourceLabel}</span></span>
          ${timeText ? ` • ${timeText}` : ""}${playButton}
        </div>
        ${groupToggleHtml(event)}
      </div>
    `;
    }
    function renderAgendaEvent(event) {
      const color = getEventColor(event);
      const releaseTypeLabel = formatReleaseLabel(event);
      const typeIcon = event.source === "Shoko" ? SHOKO_ICON_URL : event.type === "Series" ? SONARR_ICON_URL : RADARR_ICON_URL;
      const sourceLabelRaw = buildInstanceLabel(event);
      const sourceLabel = escapeHtml(sourceLabelRaw);
      const iconClass = event.source === "Sonarr" ? "je-sonarr-icon" : event.source === "Shoko" ? "je-shoko-icon" : "je-radarr-icon";
      const subtitle = withFinale(event, event.groupMembers ? groupSubtitle(event) : event.subtitle || "");
      const timeLabel = formatEventTime(event.releaseDate);
      const hasFileClass = event.hasFile ? " je-has-file" : "";
      const indicators = [];
      if (event.hasFile && !event.groupMembers) {
        indicators.push(`<button class="je-calendar-play-btn" title="${JE.t("jellyseerr_btn_available")}" aria-label="${JE.t("jellyseerr_btn_available")}" data-event-id="${escapeHtml(event.id)}"><span class="material-icons">play_arrow</span></button>`);
      }
      const statusIcons = renderStatusIcons(event);
      if (statusIcons) {
        indicators.push(statusIcons);
      }
      let materialIcon = "movie";
      if (event.releaseType === "CinemaRelease") materialIcon = "local_movies";
      else if (event.releaseType === "DigitalRelease") materialIcon = "ondemand_video";
      else if (event.releaseType === "PhysicalRelease") materialIcon = "album";
      else if (event.releaseType === "Episode") materialIcon = "tv_guide";
      else if (event.releaseType === "Anime") materialIcon = "animation";
      const subtitleHtml = subtitle ? `<span class="je-calendar-agenda-subtitle">${escapeHtml(subtitle)}</span>` : "";
      return `
      <div class="je-calendar-agenda-event${hasFileClass}" data-event-id="${escapeHtml(event.id)}">
        <div class="je-calendar-agenda-indicators">
          ${indicators.join("")}
        </div>
        <span class="je-msym-rounded" style="font-size: 20px;">${materialIcon}</span>
        <div class="je-calendar-agenda-event-marker" style="background: ${color};"></div>
        <div class="je-calendar-agenda-event-content">
          <div class="je-calendar-agenda-event-title">
            <span class="je-calendar-agenda-title-text">${escapeHtml(event.title)}</span>
            ${subtitleHtml}
          </div>
          <div class="je-calendar-agenda-event-meta">
            ${renderTypeIconHtml(event, typeIcon, iconClass)}
            <span>${releaseTypeLabel}</span>
            <span>•</span>
            <span class="je-arr-badge" title="${sourceLabel}">${sourceLabel}</span>
            ${timeLabel ? `<span>• ${escapeHtml(timeLabel)}</span>` : ""}
          </div>
        </div>
        ${groupToggleHtml(event)}
      </div>
    `;
    }
    function renderCardItems(events) {
      if (!events.length) return "";
      return events.map((event) => {
        const poster = getEventPosterUrl(event);
        const releaseTypeLabel = formatReleaseLabel(event);
        const typeIcon = event.source === "Shoko" ? SHOKO_ICON_URL : event.type === "Series" ? SONARR_ICON_URL : RADARR_ICON_URL;
        const sourceLabelRaw = buildInstanceLabel(event);
        const sourceLabel = escapeHtml(sourceLabelRaw);
        const iconClass = event.source === "Sonarr" ? "je-calendar-sonarr-icon" : event.source === "Shoko" ? "je-calendar-shoko-icon" : "je-calendar-radarr-icon";
        const statusIcons = renderStatusIcons(event);
        const timePill = buildTimePill(event);
        const playButton = event.hasFile && !event.groupMembers ? `<button class="je-calendar-play-btn je-calendar-play-btn-card" title="${JE.t?.("jellyseerr_btn_available")}" aria-label="${JE.t?.("jellyseerr_btn_available")}" data-event-id="${escapeHtml(event.id)}"><span class="material-icons">play_arrow</span></button>` : "";
        const timeRow = timePill || playButton ? `<div class="je-calendar-card-time-row">${timePill}${playButton}</div>` : "";
        const statusTop = statusIcons ? `<div class="je-calendar-card-status-top">${statusIcons}</div>` : "";
        const color = getEventColor(event);
        const cardSubtitle = withFinale(event, event.groupMembers ? groupSubtitle(event) : event.subtitle);
        const toggle = groupToggleHtml(event);
        if (poster) {
          return `
          <div class="je-calendar-card" data-event-id="${escapeHtml(event.id)}" style="border-bottom-color: ${color};">
            <div class="je-calendar-card-image-wrap">
              <img src="${normalizeImageUrl(poster)}" alt="" class="je-calendar-card-image">
              ${statusTop}
              ${toggle}
              <div class="je-calendar-card-overlay">
                ${timeRow}
                <div class="je-calendar-card-title">
                  <span class="je-calendar-card-title-text">${escapeHtml(event.title)}</span>
                </div>
                ${cardSubtitle ? `<div class="je-calendar-card-subtitle">${escapeHtml(cardSubtitle)}</div>` : `<div class="je-calendar-card-subtitle"></div>`}
                <div class="je-calendar-card-meta">
                  ${renderTypeIconHtml(event, typeIcon, iconClass)}
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
          ${toggle}
          ${timeRow}
          <div class="je-calendar-card-title">
            <span class="je-calendar-card-title-text">${escapeHtml(event.title)}</span>
          </div>
          ${cardSubtitle ? `<div class="je-calendar-card-subtitle">${escapeHtml(cardSubtitle)}</div>` : `<div class="je-calendar-card-subtitle"></div>`}
          <div class="je-calendar-card-meta">
            ${renderTypeIconHtml(event, typeIcon, iconClass)}
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
    P.locale = locale;
    P.renderEvent = renderEvent;
    P.renderAgendaEvent = renderAgendaEvent;
    P.renderCardItems = renderCardItems;
    P.collapseEpisodes = collapseEpisodes;
    P.eventHasTime = eventHasTime;
    P.compareEventsWithinDay = compareEventsWithinDay;
  })();
})();
})();
//# sourceMappingURL=calendar-page-render-events.js.map
