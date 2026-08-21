// /js/arr/calendar/calendar-page-render-views.js
// Calendar Page — month/week/day/agenda view rendering, legend, sidebar
// collapse and the full page shell (split from calendar-page.js).
(function () {
  "use strict";

  const JE = window.JellyfinEnhanced;
  JE.internals = JE.internals || {};
  const P = (JE.internals.calendarPage = JE.internals.calendarPage || {});

  const state = P.state;
  const STATUS_COLORS = P.STATUS_COLORS;
  const filterEvents = P.filterEvents;
  const groupEventsByDate = P.groupEventsByDate;
  const getRangeForView = P.getRangeForView;
  const getDaysInMonth = P.getDaysInMonth;
  const getFirstDayOfMonth = P.getFirstDayOfMonth;
  const isTodayDate = P.isTodayDate;
  const formatRangeLabel = P.formatRangeLabel;
  const formatHourLabel = P.formatHourLabel;
  const renderEvent = P.renderEvent;
  const renderAgendaEvent = P.renderAgendaEvent;
  const renderCardItems = P.renderCardItems;
  const compareEventsWithinDay = P.compareEventsWithinDay;

  function getDefaultSidebarCollapsed() {
    if (window.matchMedia) {
      return window.matchMedia("(max-width: 768px)").matches;
    }

    return false;
  }

  function applySidebarCollapsedState() {
    const sidebar = document.querySelector(".je-calendar-sidebar");
    const toggle = document.querySelector(".je-calendar-sidebar-toggle");
    if (!sidebar || !toggle) return;

    sidebar.classList.toggle("is-collapsed", !!state.sidebarCollapsed);
    toggle.setAttribute("aria-expanded", state.sidebarCollapsed ? "false" : "true");
  }

  function setSidebarCollapsed(collapsed) {
    state.sidebarCollapsed = !!collapsed;
    applySidebarCollapsedState();
  }

  function toggleSidebarCollapsed() {
    if (typeof state.sidebarCollapsed !== "boolean") {
      state.sidebarCollapsed = getDefaultSidebarCollapsed();
    }
    setSidebarCollapsed(!state.sidebarCollapsed);
  }

  function updateDisplayModeButtons() {
    const buttons = document.querySelectorAll(".je-calendar-mode-btn");
    buttons.forEach((btn) => {
      const mode = btn.dataset.mode;
      btn.classList.toggle("active", mode === state.settings.displayMode);
    });
  }

  // Render month grid view
  function renderMonthView() {
    const anchor = new Date(state.currentDate);
    anchor.setHours(0, 0, 0, 0);
    anchor.setDate(1);

    const daysInMonth = getDaysInMonth(anchor);
    const firstDay = getFirstDayOfMonth(anchor);
    let filteredEvents = filterEvents(state.events);
    if (JE.hiddenContent) filteredEvents = JE.hiddenContent.filterCalendarEvents(filteredEvents);
    const groupedEvents = groupEventsByDate(filteredEvents);
    if (filteredEvents.length === 0) {
      return `<div class="je-calendar-empty">${window.JellyfinEnhanced.t("calendar_no_releases")}</div>`;
    }

    const daysOfWeek = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const firstDayOfWeekIndex = daysOfWeek.indexOf(state.settings.firstDayOfWeek);
    const orderedDaysOfWeek = [...daysOfWeek.slice(firstDayOfWeekIndex), ...daysOfWeek.slice(0, firstDayOfWeekIndex)];

    let html = '<div class="je-calendar-month">';
    html += '<div class="je-calendar-weekdays">';
    orderedDaysOfWeek.forEach((day) => {
      html += `<div class="je-calendar-weekday">${day.substring(0, 3)}</div>`;
    });
    html += '</div>';
    html += '<div class="je-calendar-month-grid">';

    for (let i = 0; i < firstDay; i++) {
      html += '<div class="je-calendar-day je-calendar-day-placeholder" style="opacity: 0.3;"></div>';
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const year = anchor.getFullYear();
      const month = String(anchor.getMonth() + 1).padStart(2, '0');
      const dayStr = String(day).padStart(2, '0');
      const dateStr = `${year}-${month}-${dayStr}`;

      const dayEvents = groupedEvents[dateStr] || [];
      dayEvents.sort(compareEventsWithinDay);

      const dayDate = new Date(year, anchor.getMonth(), day);
      const todayClass = isTodayDate(dayDate) ? " je-calendar-today" : "";
      const weekdayLabel = daysOfWeek[dayDate.getDay()].substring(0, 3);
      html += `
        <div class="je-calendar-day${todayClass}">
          <div class="je-calendar-day-header">
            <span class="je-calendar-day-number">${day}</span>
            <span class="je-calendar-month-day-name">${weekdayLabel}</span>
          </div>
          <div class="${state.settings.displayMode === 'cards' ? 'je-calendar-day-cards' : 'je-calendar-events-list'}">
            ${state.settings.displayMode === 'cards' ? renderCardItems(dayEvents) : dayEvents.map((event) => renderEvent(event)).join("")}
          </div>
        </div>
      `;
    }

    html += "</div></div>";
    return html;
  }

  // Render week grid view
  function renderWeekView() {
    const { start } = getRangeForView(state.currentDate, "week");
    const daysOfWeek = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    let filteredEvents = filterEvents(state.events);
    if (JE.hiddenContent) filteredEvents = JE.hiddenContent.filterCalendarEvents(filteredEvents);
    const groupedEvents = groupEventsByDate(filteredEvents);
    if (filteredEvents.length === 0) {
      return `<div class="je-calendar-empty">${window.JellyfinEnhanced.t("calendar_no_releases")}</div>`;
    }

    let html = '<div class="je-calendar-grid">';

    for (let i = 0; i < 7; i++) {
      const day = new Date(start);
      day.setDate(start.getDate() + i);
      const year = day.getFullYear();
      const month = String(day.getMonth() + 1).padStart(2, '0');
      const dayNum = String(day.getDate()).padStart(2, '0');
      const dateKey = `${year}-${month}-${dayNum}`;
      const dayEvents = groupedEvents[dateKey] || [];
      dayEvents.sort(compareEventsWithinDay);

      const todayClass = isTodayDate(day) ? " je-calendar-today" : "";
      html += `
        <div class="je-calendar-day${todayClass}">
          <div class="je-calendar-day-header">
            <span class="je-calendar-day-number">${day.getDate()}</span>
            <span class="je-calendar-day-name">${daysOfWeek[day.getDay()].substring(0, 3)}</span>
          </div>
          <div class="${state.settings.displayMode === 'cards' ? 'je-calendar-day-cards' : 'je-calendar-events-list'}">
            ${state.settings.displayMode === 'cards' ? renderCardItems(dayEvents) : dayEvents.map((event) => renderEvent(event)).join("")}
          </div>
        </div>
      `;
    }

    html += "</div>";
    return html;
  }

  // Render agenda list view
  function renderAgendaView() {
    let filteredEvents = filterEvents(state.events);
    if (JE.hiddenContent) filteredEvents = JE.hiddenContent.filterCalendarEvents(filteredEvents);
    const groupedEvents = groupEventsByDate(filteredEvents);
    const dates = Object.keys(groupedEvents).sort();

    if (dates.length === 0) {
      return `<div class="je-calendar-empty">${window.JellyfinEnhanced.t("calendar_no_releases")}</div>`;
    }

    let html = '<div class="je-calendar-agenda">';
    dates.forEach((dateKey) => {
      const [year, month, day] = dateKey.split('-');
      const dateObj = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
      const weekday = dateObj.toLocaleDateString(undefined, { weekday: 'short' });
      const monthDay = dateObj.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

      const dayEvents = groupedEvents[dateKey] || [];
      dayEvents.sort(compareEventsWithinDay);

      html += `
        <div class="je-calendar-agenda-row">
          <div class="je-calendar-agenda-date">
            <div>${weekday}, ${monthDay}</div>
          </div>
          <div class="je-calendar-agenda-events">
            ${dayEvents.map((event) => renderAgendaEvent(event)).join("")}
          </div>
        </div>
      `;
    });

    html += "</div>";
    return html;
  }

  function renderDayView() {
    const filteredEvents = filterEvents(state.events);
    const groupedEvents = groupEventsByDate(filteredEvents);
    const current = new Date(state.currentDate);
    const dateKey = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, '0')}-${String(current.getDate()).padStart(2, '0')}`;
    const dayEvents = groupedEvents[dateKey] || [];
    dayEvents.sort(compareEventsWithinDay);

    if (dayEvents.length === 0) {
      return `<div class="je-calendar-empty">${window.JellyfinEnhanced.t("calendar_no_releases")}</div>`;
    }

    if (state.settings.displayMode === "cards") {
      return `
        <div class="je-calendar-dayline je-calendar-day-cards">
          ${renderCardItems(dayEvents)}
        </div>
      `;
    }

    const groups = { allDay: [], hours: new Map() };
    dayEvents.forEach((event) => {
      const date = new Date(event.releaseDate);
      if (Number.isNaN(date.getTime())) {
        groups.allDay.push(event);
        return;
      }
      const hasTime = !(date.getHours() === 0 && date.getMinutes() === 0);
      if (!hasTime) {
        groups.allDay.push(event);
        return;
      }
      const hour = date.getHours();
      if (!groups.hours.has(hour)) groups.hours.set(hour, []);
      groups.hours.get(hour).push(event);
    });

    let html = '<div class="je-calendar-day-hours">';

    for (let hour = 0; hour < 24; hour += 1) {
      const hourEvents = groups.hours.get(hour);
      if (!hourEvents || hourEvents.length === 0) continue;
      const hourClass = state.settings.displayMode === 'cards'
        ? 'je-calendar-hour-events je-calendar-day-cards'
        : 'je-calendar-hour-events';
      html += `
        <div class="je-calendar-hour-row">
          <div class="je-calendar-hour-label">${formatHourLabel(hour)}</div>
          <div class="${hourClass}">
            ${state.settings.displayMode === 'cards' ? renderCardItems(hourEvents) : hourEvents.map((event) => renderEvent(event)).join("")}
          </div>
        </div>
      `;
    }

    // Rendered after the timed hour rows — date-only events (anime) sort after
    // time-stamped events landing on the same day.
    const allDayLabel = window.JellyfinEnhanced.t?.("calendar_all_day") || "All day";
    if (groups.allDay.length) {
      const allDayEvents = groups.allDay;
      const allDayClass = state.settings.displayMode === 'cards'
        ? 'je-calendar-hour-events je-calendar-day-cards'
        : 'je-calendar-hour-events';
      html += `
        <div class="je-calendar-hour-row">
          <div class="je-calendar-hour-label">${allDayLabel}</div>
          <div class="${allDayClass}">
            ${state.settings.displayMode === 'cards' ? renderCardItems(allDayEvents) : allDayEvents.map((event) => renderEvent(event)).join("")}
          </div>
        </div>
      `;
    }

    html += "</div>";
    return html;
  }

  // Render calendar based on current view mode
  function renderCalendar() {
    if (state.viewMode === "week") return renderWeekView();
    if (state.viewMode === "agenda") return renderAgendaView();
    if (state.viewMode === "day") return renderDayView();
    return renderMonthView();
  }

  // Render color legend
  function renderLegend() {
    const JE = window.JellyfinEnhanced;
    const hasActiveFilters = state.activeFilters.size > 0;
    const getItemClass = (filterType) => {
      if (!hasActiveFilters) return '';
      return state.activeFilters.has(filterType) ? 'active' : 'inactive';
    };

    const showRequestsFilter = !!JE.pluginConfig?.JellyseerrEnabled && !state.settings.forceOnlyRequested;
    const requestsLabel = JE.t?.("requests_requests") || "Requests";
    const requestsLegend = showRequestsFilter
      ? `<div class="je-calendar-legend-item ${getItemClass('Requests')}" onclick="window.JellyfinEnhanced.calendarPage.toggleFilter('Requests'); event.stopPropagation();">
          <span class="material-symbols-rounded" style="color: #6f63f2; font-size: 18px;">download</span>
          <span>${requestsLabel}</span>
        </div>`
      : "";

    const watchlistLegend = state.settings.highlightFavorites
      ? `<div class="je-calendar-legend-item ${getItemClass('Watchlist')}" onclick="window.JellyfinEnhanced.calendarPage.toggleFilter('Watchlist'); event.stopPropagation();">
          <span class="material-symbols-rounded" style="color: #ffd700; font-size: 18px; font-variation-settings: 'FILL' 1;">bookmark</span>
          <span>${JE.t("calendar_watchlist")}</span>
        </div>`
      : "";

    const watchedLegend = state.settings.highlightWatchedSeries
      ? `<div class="je-calendar-legend-item ${getItemClass('Watched')}" onclick="window.JellyfinEnhanced.calendarPage.toggleFilter('Watched'); event.stopPropagation();">
          <span class="material-symbols-rounded" style="color: #64b5f6; font-size: 18px;">visibility</span>
          <span>${JE.t("calendar_watched")}</span>
        </div>`
      : "";

    const hasTwoFilters = state.activeFilters.size >= 2;
    const unmonitoredLegend = `<div class="je-calendar-legend-item je-calendar-unmonitored-toggle ${state.settings.showUnmonitored ? 'active' : hasActiveFilters ? 'inactive' : ''}" onclick="window.JellyfinEnhanced.calendarPage.toggleShowUnmonitored(); event.stopPropagation();" style="cursor: pointer;">
        <span class="material-symbols-rounded" style="color: #ff9800; font-size: 18px;">${state.settings.showUnmonitored ? 'visibility' : 'visibility_off'}</span>
        <span>${JE.t?.("calendar_include_unmonitored") || "Unmonitored"}</span>
      </div>`;
    const filterControls = `
      <div class="je-calendar-filter-controls">
        <div class="je-calendar-filter-toggle ${hasTwoFilters ? '' : 'is-disabled'}" role="group" aria-label="Filter mode">
          <button type="button" class="je-calendar-filter-btn ${state.filterMatchMode === 'any' ? 'active' : ''}" data-filter-mode="any" ${hasTwoFilters ? '' : 'disabled aria-disabled="true"'}>OR</button>
          <button type="button" class="je-calendar-filter-btn ${state.filterMatchMode === 'all' ? 'active' : ''}" data-filter-mode="all" ${hasTwoFilters ? '' : 'disabled aria-disabled="true"'}>AND</button>
        </div>
        <button type="button" class="je-calendar-filter-invert ${state.filterInvert ? 'active' : ''} ${hasActiveFilters ? '' : 'is-disabled'}" data-filter-invert="true" ${hasActiveFilters ? '' : 'disabled aria-disabled="true"'}>NOT</button>
      </div>`;

    return `
      <div class="je-calendar-legend">
        ${filterControls}
        <div class="je-calendar-legend-item ${getItemClass('CinemaRelease')}" onclick="window.JellyfinEnhanced.calendarPage.toggleFilter('CinemaRelease'); event.stopPropagation();">
          <span class="material-symbols-rounded" style="color: ${STATUS_COLORS.CinemaRelease}; font-size: 18px;">local_movies</span>
          <span>${JE.t("calendar_cinema_release")}</span>
        </div>
        <div class="je-calendar-legend-item ${getItemClass('DigitalRelease')}" onclick="window.JellyfinEnhanced.calendarPage.toggleFilter('DigitalRelease'); event.stopPropagation();">
          <span class="material-symbols-rounded" style="color: ${STATUS_COLORS.DigitalRelease}; font-size: 18px;">ondemand_video</span>
          <span>${JE.t("calendar_digital_release")}</span>
        </div>
        <div class="je-calendar-legend-item ${getItemClass('PhysicalRelease')}" onclick="window.JellyfinEnhanced.calendarPage.toggleFilter('PhysicalRelease'); event.stopPropagation();">
          <span class="material-symbols-rounded" style="color: ${STATUS_COLORS.PhysicalRelease}; font-size: 18px;">album</span>
          <span>${JE.t("calendar_physical_release")}</span>
        </div>
        <div class="je-calendar-legend-item ${getItemClass('Episode')}" onclick="window.JellyfinEnhanced.calendarPage.toggleFilter('Episode'); event.stopPropagation();">
          <span class="material-symbols-rounded" style="color: ${STATUS_COLORS.Episode}; font-size: 18px;">tv_guide</span>
          <span>${JE.t("calendar_episode")}</span>
        </div>
        <div class="je-calendar-legend-item ${getItemClass('Anime')}" onclick="window.JellyfinEnhanced.calendarPage.toggleFilter('Anime'); event.stopPropagation();">
          <span class="material-symbols-rounded" style="color: ${STATUS_COLORS.Anime}; font-size: 18px;">animation</span>
          <span>${JE.t("calendar_anime")}</span>
        </div>
        <div class="je-calendar-legend-item ${getItemClass('Available')}" onclick="window.JellyfinEnhanced.calendarPage.toggleFilter('Available'); event.stopPropagation();">
          <span class="material-symbols-rounded" style="color: #4caf50; font-size: 18px;">check_circle</span>
          <span>${JE.t?.("jellyseerr_btn_available") || "Available"}</span>
        </div>
        ${requestsLegend}
        ${watchlistLegend}
        ${watchedLegend}
        ${unmonitoredLegend}
      </div>
    `;
  }

  // Create or get page container element
  function createPageContainer() {
    let page = document.getElementById("je-calendar-page");
    if (!page) {
      page = document.createElement("div");
      page.id = "je-calendar-page";
      page.className = "page type-interior mainAnimatedPage hide";
      page.setAttribute("data-title", "Calendar");
      page.setAttribute("data-backbutton", "true");
      page.setAttribute("data-url", "#/calendar");
      page.setAttribute("data-type", "custom");
      page.innerHTML = `
        <div data-role="content">
          <div class="content-primary je-calendar-page">
            <div id="je-calendar-container" style="padding-top: 5em; padding-left: 0.5em; padding-right: 0.5em;"></div>
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
   * Render the full page.
   * @param {HTMLElement} [targetContainer] - Optional container to render into
   *   (used by custom-tab mode to avoid duplicate-ID conflicts).
   */
  function renderPage(targetContainer) {
    syncPageModeClasses();
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
      const page = createPageContainer();
      container = document.getElementById("je-calendar-container");
      if (!page || !container) return;
    }

    if (typeof state.sidebarCollapsed !== "boolean") {
      state.sidebarCollapsed = getDefaultSidebarCollapsed();
    }

    container.innerHTML = `
      <div class="je-calendar-header">
        <h1 class="je-calendar-title">${formatRangeLabel()}</h1>
        <div class="je-calendar-actions je-calendar-actions-center">
          <div class="je-calendar-nav">
            <div class="je-calendar-nav-group">
              <button class="je-calendar-nav-btn" onclick="window.JellyfinEnhanced.calendarPage.shiftPeriod('prev'); event.stopPropagation();" aria-label="${window.JellyfinEnhanced.t?.("prev") || "Previous"}">‹</button>
              <button class="je-calendar-nav-btn je-calendar-nav-today" onclick="window.JellyfinEnhanced.calendarPage.goToday(); event.stopPropagation();">${window.JellyfinEnhanced.t("calendar_today")}</button>
              <button class="je-calendar-nav-btn" onclick="window.JellyfinEnhanced.calendarPage.shiftPeriod('next'); event.stopPropagation();" aria-label="${window.JellyfinEnhanced.t?.("next") || "Next"}">›</button>
            </div>
          </div>
        </div>
        <div class="je-calendar-actions je-calendar-actions-right">
          <div class="je-calendar-nav">
            <button class="je-calendar-view-btn ${state.viewMode === 'day' ? 'active' : ''}" onclick="window.JellyfinEnhanced.calendarPage.setViewMode('day'); event.stopPropagation();">${window.JellyfinEnhanced.t?.("calendar_day") || "Day"}</button>
            <button class="je-calendar-view-btn ${state.viewMode === 'week' ? 'active' : ''}" onclick="window.JellyfinEnhanced.calendarPage.setViewMode('week'); event.stopPropagation();">${window.JellyfinEnhanced.t("calendar_week")}</button>
            <button class="je-calendar-view-btn ${state.viewMode === 'month' ? 'active' : ''}" onclick="window.JellyfinEnhanced.calendarPage.setViewMode('month'); event.stopPropagation();">${window.JellyfinEnhanced.t("calendar_month")}</button>
            <button class="je-calendar-view-btn ${state.viewMode === 'agenda' ? 'active' : ''}" onclick="window.JellyfinEnhanced.calendarPage.setViewMode('agenda'); event.stopPropagation();">${window.JellyfinEnhanced.t("calendar_agenda")}</button>
            <div class="je-calendar-mode-toggle ${state.viewMode === 'agenda' ? 'is-disabled' : ''}" role="group" aria-label="Display mode">
              <button type="button" class="je-calendar-mode-btn ${state.settings.displayMode === 'list' ? 'active' : ''}" title="List" aria-label="List" data-mode="list" ${state.viewMode === 'agenda' ? 'disabled aria-disabled="true"' : ''}>
                <span class="material-icons">view_list</span>
              </button>
              <button type="button" class="je-calendar-mode-btn ${state.settings.displayMode === 'backdrop' ? 'active' : ''}" title="Backdrop" aria-label="Backdrop" data-mode="backdrop" ${state.viewMode === 'agenda' ? 'disabled aria-disabled="true"' : ''}>
                <span class="material-icons">image</span>
              </button>
              <button type="button" class="je-calendar-mode-btn ${state.settings.displayMode === 'cards' ? 'active' : ''}" title="Cards" aria-label="Cards" data-mode="cards" ${state.viewMode === 'agenda' ? 'disabled aria-disabled="true"' : ''}>
                <span class="material-icons">view_module</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      ${state.isLoading ? `<div class="je-calendar-empty">${window.JellyfinEnhanced.t("calendar_loading")}</div>` : ""}

        <div class="je-calendar-layout">
          <div class="je-calendar-main">
            ${!state.isLoading ? renderCalendar() : ""}
          </div>
          <aside class="je-calendar-sidebar${state.sidebarCollapsed ? " is-collapsed" : ""}">
            <button type="button" class="je-calendar-sidebar-toggle" aria-expanded="${state.sidebarCollapsed ? "false" : "true"}" aria-controls="je-calendar-sidebar-content">
              <span class="material-icons je-calendar-sidebar-toggle-icon">expand_more</span>
            </button>
            <div class="je-calendar-sidebar-content" id="je-calendar-sidebar-content">
              ${renderLegend().replace('je-calendar-legend"', 'je-calendar-legend je-calendar-legend-vertical"')}
            </div>
          </aside>
        </div>

      ${
        ""
      }
    `;

    applySidebarCollapsedState();
  }

  function syncPageModeClasses() {
    const nodes = document.querySelectorAll(".je-calendar-page, .content-primary.je-calendar-page");
    if (!nodes.length) return;
    nodes.forEach((node) => {
      node.classList.remove("je-view-day", "je-view-week", "je-view-month", "je-view-agenda");
      node.classList.remove("je-display-list", "je-display-backdrop", "je-display-cards");
      if (state.viewMode) {
        node.classList.add(`je-view-${state.viewMode}`);
      }
      if (state.settings.displayMode) {
        node.classList.add(`je-display-${state.settings.displayMode}`);
      }
    });
  }

  P.updateDisplayModeButtons = updateDisplayModeButtons;
  P.toggleSidebarCollapsed = toggleSidebarCollapsed;
  P.renderPage = renderPage;
  P.syncPageModeClasses = syncPageModeClasses;
  P.createPageContainer = createPageContainer;
})();
