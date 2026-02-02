// /js/arr/calendar-page.js
// Calendar Page - Shows upcoming releases from Sonarr and Radarr
(function () {
  "use strict";

  const JE = window.JellyfinEnhanced;
  const sidebar = document.querySelector('.mainDrawer-scrollContainer');
  const pluginPagesExists = !!sidebar?.querySelector(
    'a[is="emby-linkbutton"][data-itemid="Jellyfin.Plugin.JellyfinEnhanced.CalendarPage"]'
  );

  // State management
  const state = {
    events: [],
    isLoading: false,
    pageVisible: false,
    previousPage: null,
    currentDate: new Date(),
    viewMode: getDefaultViewMode(),
    rangeStart: null,
    rangeEnd: null,
    settings: {
      firstDayOfWeek: "Monday",
      timeFormat: "5pm/5:30pm",
      highlightFavorites: false,
      highlightWatchedSeries: false,
    },
    userDataMap: new Map(),
    activeFilters: new Set(), // Track active filters
    filterMatchMode: "any",
    filterInvert: false,
    locationSignature: null,
    locationTimer: null,
  };

  // Status color mapping
  const STATUS_COLORS = {
    CinemaRelease: "#2196f3",
    DigitalRelease: "#9c27b0",
    PhysicalRelease: "#ff5722",
    Episode: "#4caf50",
  };

  const SONARR_ICON_URL = "https://cdn.jsdelivr.net/gh/selfhst/icons/svg/sonarr.svg";
  const RADARR_ICON_URL = "https://cdn.jsdelivr.net/gh/selfhst/icons/svg/radarr-light-hybrid-light.svg";

  // CSS Styles
  const CSS_STYLES = `
    @import url('https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200');

    .je-calendar-page {
      padding: 2em;
      max-width: 95vw;
      margin: 0 auto;
      position: relative;
      z-index: 1;
    }

    #je-calendar-page > [data-role="content"],
    #je-calendar-page .content-primary.je-calendar-page,
    .content-primary.je-calendar-page {
      overflow: visible !important;
    }

    .je-calendar-layout {
      display: flex;
      gap: 1.5em;
      align-items: flex-start;
      position: relative;
      overflow: visible;
    }

    .je-calendar-main {
      flex: 1;
      min-width: 0;
      font-size: 1em;
    }

    .je-calendar-sidebar {
      align-items: center;
      position: sticky;
      top: 6em;
      align-self: flex-start;
      display: flex;
      flex-direction: column;
      gap: 1em;
      height: max-content;
      overflow-y: auto;
      z-index: 2;
    }


    .je-calendar-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 2em;
      padding-top: 2em;
      flex-wrap: wrap;
      gap: 1em;
      position: relative;
    }

    .je-calendar-title {
      font-size: 2em;
      font-weight: 600;
      margin: 0;
    }

    .je-calendar-actions {
      display: flex;
      gap: 1em;
      align-items: center;
      flex-wrap: wrap;
    }

    .je-calendar-actions-center {
      position: absolute;
      left: 50%;
      transform: translateX(-50%);
    }

    .je-calendar-actions-right {
      margin-left: auto;
    }

    .je-calendar-nav {
      display: inline-flex;
      gap: 0.5em;
      align-items: center;
      margin-bottom: 0.1em;
    }

    .je-calendar-nav-group {
      display: inline-flex;
      align-items: center;
      gap: 1em;
    }

    .je-calendar-mode-toggle,
    .je-calendar-filter-toggle {
      display: inline-flex;
      align-items: center;
      gap: 0.15em;
      padding: 0.2em;
      border-radius: 999px;
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.15);
    }

    .je-calendar-mode-toggle.is-disabled,
    .je-calendar-filter-toggle.is-disabled {
      opacity: 0.5;
      pointer-events: none;
    }

    .je-calendar-mode-btn,
    .je-calendar-filter-btn {
      background: transparent;
      border: none;
      color: inherit;
      padding: 0.35em 0.6em;
      border-radius: 999px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      opacity: 0.75;
      transition: all 0.15s ease;
      font-weight: 600;
      font-size: 0.85em;
      letter-spacing: 0.02em;
    }

    .je-calendar-mode-btn:hover,
    .je-calendar-filter-btn:hover {
      opacity: 1;
      background: rgba(255,255,255,0.14);
    }

    .je-calendar-mode-btn.active,
    .je-calendar-filter-btn.active {
      opacity: 1;
      background: rgba(255,255,255,0.14);
    }


    .je-calendar-card {
      cursor: pointer;
      display: flex;
      flex-direction: column;
      height: 100%;
      background: rgba(128,128,128,0.1);
      border-radius: 8px;
      box-sizing: border-box;
      border-bottom: 3px solid transparent;
      min-width: 0;
      max-width: 100%;
      position: relative;
      align-items: center;
      text-align: center;
      gap: 0.35em;
      overflow: hidden;
      transition: transform 0.15s ease, box-shadow 0.15s ease, background 0.15s ease;
    }

    .je-calendar-card:hover {
      transform: translateY(-2px);
      background: rgba(128,128,128,0.18);
      box-shadow: 0 8px 18px rgba(0, 0, 0, 0.25);
    }

    .je-calendar-card-meta {
      font-size: 0.8em;
      opacity: 0.85;
      display: flex;
      flex-wrap: wrap;
      gap: 0.35em;
      align-items: center;
      justify-content: center;
      text-align: center;
      margin-top: auto;
    }

    .je-calendar-card-meta .je-arr-badge {
      font-size: 0.9em;
    }

    .je-calendar-card-meta img {
      width: 12px;
      height: 12px;
      object-fit: contain;
    }

    .je-calendar-day-cards {
      display: grid;
      grid-template-columns: 1fr;
      gap: 0.5em;
      grid-auto-rows: 1fr;
      align-items: stretch;
      min-width: 0;
    }

    .je-calendar-page.je-view-week .je-calendar-day-cards,
    .je-calendar-page.je-view-month .je-calendar-day-cards {
      justify-items: center;
    }

    .je-calendar-page.je-view-week .je-calendar-day-cards > .je-calendar-card,
    .je-calendar-page.je-view-month .je-calendar-day-cards > .je-calendar-card {
      width: 100%;
      max-width: 100%;
    }

    .je-calendar-card-image {
      width: 100%;
      height: auto;
      aspect-ratio: 2 / 3;
      max-height: 18em;
      object-fit: cover;
      border-radius: 0;
      display: block;
      flex-shrink: 0;
      max-width: 100%;
    }

    .je-calendar-card-image-wrap {
      position: relative;
      width: 100%;
    }

    .je-calendar-card-overlay {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      padding: 0.6em;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.2em;
      text-align: center;
      color: #fff;
      background: linear-gradient(to top, rgba(0,0,0,0.9), rgba(0,0,0,0.25))
    }

    .je-calendar-card-overlay .je-calendar-card-title,
    .je-calendar-card-overlay .je-calendar-card-subtitle,
    .je-calendar-card-overlay .je-calendar-card-meta {
      text-shadow: 0 1px 2px rgba(0,0,0,0.8);
    }

    .je-calendar-card-overlay .je-calendar-card-meta {
      font-size: 0.75em;
    }

    .je-calendar-card-title {
      font-weight: 600;
      display: flex;
      align-items: center;
      justify-content: center;
      line-height: 1.15;
      height: 3em;
      padding: 0 0.2em;
      width: 100%;
      overflow: hidden;
    }

    .je-calendar-card-title-text {
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      text-overflow: ellipsis;
      line-height: 1.15;
      max-height: 3em;
      width: 100%;
      font-size: clamp(1.05em, 0.6vw + 0.9em, 1.3em);
      white-space: normal;
      word-break: break-word;
      overflow-wrap: anywhere;
      hyphens: auto;
    }

    .je-calendar-card-subtitle {
      font-size: 0.95em;
      opacity: 0.75;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      line-height: 1.2;
      height: 1.4em;
      max-width: 100%;
    }

    .je-calendar-card-time {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      align-self: center;
      margin-top: 0.35em;
      padding: 0 0.6em;
      border-radius: 999px;
      background: rgba(0,0,0,0.55);
      font-size: 0.9em;
      font-weight: 600;
      letter-spacing: 0.01em;
      line-height: 1;
      height: 1.6em;
      box-sizing: border-box;
    }

    .je-calendar-card-time.is-unavailable {
      padding: 0 0.85em;
    }

    .je-calendar-card-time.is-available {
      background: rgba(76, 175, 80, 0.85);
    }

    .je-calendar-card-time.is-past {
      background: rgba(255, 152, 0, 0.85);
    }

    .je-calendar-card-time.is-late {
      background: rgba(244, 67, 54, 0.85);
    }

    .je-calendar-card-time-row {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.35em;
    }

    .je-calendar-card-status-top {
      position: absolute;
      top: 0.45em;
      right: 0.45em;
      display: inline-flex;
      align-items: center;
      gap: 0.25em;
      z-index: 2;
      padding: 0.2em 0.35em;
      border-radius: 999px;
      background: rgba(0,0,0,0.6);
      box-shadow: 0 2px 6px rgba(0,0,0,0.35);
      backdrop-filter: blur(4px);
    }

    .je-calendar-event-type .je-calendar-card-time,
    .je-calendar-event-type .je-calendar-card-time-row {
      margin-top: 0;
    }

    .je-calendar-day-cards > .je-calendar-card {
      height: 100%;
    }

    .je-calendar-nav-btn,
    .je-calendar-view-btn {
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.15);
      color: inherit;
      padding: 0.45em 0.9em;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.15s ease;
      font-weight: 600;
    }

    .je-calendar-nav-btn {
      height: 2.2em;
      min-width: 2.2em;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      border-radius: 999px;
      font-size: 1em;
    }

    .je-calendar-nav-btn.je-calendar-nav-today {
      padding: 0 1em;
      min-width: auto;
      font-size: 0.95em;
      border-radius: 999px;
    }

    .je-calendar-nav-btn:hover,
    .je-calendar-view-btn:hover {
      background: rgba(255,255,255,0.14);
    }

    .je-calendar-grid {
      display: grid;
      grid-template-columns: repeat(7, minmax(0, 1fr));
      gap: 1em;
      margin-bottom: 2em;
    }

    .je-calendar-weekdays {
      display: grid;
      grid-template-columns: repeat(7, minmax(0, 1fr));
      gap: 1em;
      margin-bottom: 0.5em;
    }

    .je-calendar-weekday {
      text-align: center;
      font-weight: 600;
      padding: 0.5em;
      opacity: 0.8;
    }

    .je-calendar-month-grid {
      display: grid;
      grid-template-columns: repeat(7, minmax(0, 1fr));
      gap: 1em;
      margin-bottom: 2em;
    }

    .je-calendar-dayline {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
      gap: 1em;
      overflow: visible;
      padding-bottom: 0.5em;
    }

    .je-calendar-dayline .je-calendar-event {
      width: 100%;
    }

    .je-calendar-day-hours {
      display: flex;
      flex-direction: column;
      gap: 0.5em;
    }

    .je-calendar-hour-row {
      display: grid;
      grid-template-columns: 90px 1fr;
      gap: 0.75em;
      align-items: flex-start;
    }

    .je-calendar-hour-label {
      font-weight: 600;
      opacity: 0.75;
      text-align: right;
      padding-top: 0.2em;
      font-size: 0.9em;
      white-space: nowrap;
    }

    .je-calendar-hour-events {
      display: flex;
      flex-direction: column;
      gap: 0.5em;
      min-width: 0;
    }

    .je-calendar-hour-events.je-calendar-day-cards {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
      gap: 0.75em;
    }

    .je-calendar-page.je-view-day.je-display-cards .je-calendar-hour-row {
      grid-template-columns: 1fr;
    }

    .je-calendar-page.je-view-day.je-display-cards .je-calendar-hour-label {
      display: none;
    }

    .je-calendar-day {
      background: rgba(128,128,128,0.05);
      border-radius: 0.5em;
      min-height: 150px;
      border: 1px solid rgba(128,128,128,0.2);
      min-width: 0;
    }

    .je-calendar-day.je-calendar-today {
      border-color: rgba(128,128,128,0.2);
      box-shadow: none;
    }

    .je-calendar-day.je-calendar-today .je-calendar-day-number,
    .je-calendar-day.je-calendar-today .je-calendar-day-name {
      color: inherit;
    }

    .je-calendar-day-header {
      font-weight: 600;
      text-align: center;
      padding: 0.5em;
      border-bottom: 1px solid rgba(128,128,128,0.2);
    }

    .je-calendar-day-number {
      display: inline-block;
      font-size: 1.2em;
      font-weight: 700;
    }

    .je-calendar-day-name {
      display: block;
      font-size: 0.85em;
      opacity: 0.7;
      margin-top: 0.25em;
    }

    .je-calendar-month-day-name {
      display: none;
      font-size: 0.75em;
      opacity: 0.7;
      margin-top: 0.2em;
    }

    .je-calendar-events-list {
      display: flex;
      flex-direction: column;
      gap: 0.5em;
    }

    .je-calendar-event {
      padding: 0.5em;
      border-radius: 0.25em;
      font-size: 0.85em;
      cursor: pointer;
      transition: all 0.2s;
      border-left: 3px solid;
      padding-left: 0.7em;
      position: relative;
      color: #f5f5f5;
      text-shadow: 0 1px 2px rgba(0,0,0,0.85);
    }

    .je-calendar-event:hover {
      transform: translateX(2px);
      opacity: 0.9;
    }

    .je-calendar-event.je-has-file:hover {
      box-shadow: 0 0 8px rgba(76, 175, 80, 0.4);
    }

    .je-calendar-status-icons {
      display: inline-flex;
      align-items: center;
      gap: 0.25em;
    }

    .je-calendar-status-icon {
      font-size: 22px;
      line-height: 1;
    }

    .je-calendar-status-icon.je-status-watchlist {
      color: #ffd700;
      font-variation-settings: 'FILL' 1;
    }

    .je-calendar-status-icon.je-status-watched {
      color: #64b5f6;
    }

    .je-calendar-agenda-indicators .je-calendar-status-icon {
      font-size: 22px;
    }

    .je-calendar-play-btn {
      background: #4caf50;
      border: none;
      color: white;
      padding: 0;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      margin-left: 0.35em;
      border-radius: 50%;
      width: 24px;
      height: 24px;
    }

    .je-calendar-play-btn-card {
      width: 24px;
      height: 24px;
    }

    .je-calendar-play-btn .material-icons {
      font-size: 14px;
    }

    .je-calendar-event-status-top {
      position: absolute;
      top: 0.35em;
      right: 0.35em;
      display: inline-flex;
      align-items: center;
      gap: 0.2em;
      z-index: 2;
      padding: 0.12em 0.3em;
      border-radius: 999px;
      background: rgba(0,0,0,0.45);
      backdrop-filter: blur(2px);
    }

    .je-calendar-event-status-top .je-calendar-status-icon {
      font-size: 12px;
    }

    .je-calendar-event-title {
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      display: block;
    }

    .je-calendar-event-subtitle {
      font-size: 0.8em;
      opacity: 0.75;
      display: block;
      margin-top: 0.2em;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .je-calendar-event-type {
      font-size: 0.75em;
      opacity: 0.85;
      margin-top: 0.35em;
      display: flex;
      align-items: center;
      gap: 0.5em;
      flex-wrap: wrap;
      width: fit-content;
    }

    .je-calendar-event-type img {
      width: 12px;
      height: 12px;
      object-fit: contain;
    }

    .je-calendar-legend {
      display: flex;
      flex-wrap: wrap;
      gap: 1.5em;
      margin-top: 2em;
      padding: 1em;
      background: rgba(128,128,128,0.1);
      border-radius: 0.5em;
    }

    .je-calendar-legend.je-calendar-legend-vertical {
      flex-direction: column;
      gap: 0.6em;
      margin-top: 0;
      padding: 0.75em;
    }

    .je-calendar-filter-controls {
      display: flex;
      gap: 0.5em;
      align-items: center;
      flex-wrap: wrap;
      width: 100%;
      justify-content: center;
    }

    .je-calendar-filter-invert {
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.15);
      color: inherit;
      padding: 0.3em 0.7em;
      border-radius: 999px;
      cursor: pointer;
      font-weight: 600;
      font-size: 0.85em;
      opacity: 0.8;
      transition: all 0.15s ease;
    }

    .je-calendar-filter-invert.is-disabled {
      opacity: 0.5;
      pointer-events: none;
    }

    .je-calendar-filter-invert.active {
      opacity: 1;
      background: rgba(255,255,255,0.14);
    }

    .je-calendar-mode-toggle {
      justify-content: center;
    }

    .je-calendar-legend-item {
      display: flex;
      align-items: center;
      gap: 0.5em;
      font-size: 0.9em;
      padding: 0.5em 0.75em;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.2s ease;
      user-select: none;
      border: 2px solid transparent;
    }

    .je-calendar-legend-item:hover {
      background: rgba(255, 255, 255, 0.08);
    }

    .je-calendar-legend-item.active {
      background: rgba(255, 255, 255, 0.12);
    }

    .je-calendar-legend-item.inactive {
      opacity: 0.4;
    }

    .je-calendar-empty {
      text-align: center;
      padding: 2em;
      opacity: 0.7;
    }

    .je-calendar-agenda {
      display: flex;
      flex-direction: column;
      gap: 0;
      padding-left: 1em;
      overflow-x: hidden;
    }

    .je-calendar-agenda-row {
      display: flex;
      border-bottom: 1px solid rgba(128,128,128,0.15);
      padding: 0.75em 0;
      align-items: flex-start;
      gap: 0.5em;
      max-width: 100%;
    }

    .je-calendar-agenda-row:hover {
      background: rgba(128,128,128,0.05);
    }

    .je-calendar-agenda-date {
      min-width: 140px;
      flex-shrink: 0;
      padding: 0.5em;
      font-weight: 600;
      font-size: 0.95em;
      opacity: 0.85;
    }

    .je-calendar-agenda-events {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 0.75em;
    }

    .je-calendar-agenda-event {
      display: flex;
      align-items: center;
      gap: 0.75em;
      cursor: default;
      padding: 0.5em;
      border-radius: 4px;
      box-sizing: border-box;
    }

    .je-calendar-agenda-event.je-has-file {
      cursor: pointer;
    }

    .je-calendar-agenda-event.je-has-file:hover {
      background: rgba(76, 175, 80, 0.1);
    }

    .je-calendar-agenda-indicators {
      display: flex;
      align-items: center;
      gap: 0.25em;
      min-width: 70px;
      justify-content: flex-end;
      flex-shrink: 0;
    }

    .je-calendar-agenda-event.je-has-file .je-available-indicator {
      color: #4caf50;
      font-size: 20px;
    }

    .je-available-indicator {
      font-size: 20px;
    }

    .je-calendar-agenda-event-marker {
      width: 4px;
      height: 36px;
      border-radius: 2px;
      flex-shrink: 0;
    }

    .je-calendar-agenda-event-content {
      flex: 1;
      min-width: 0;
    }

    .je-calendar-agenda-title-text {
      font-weight: 600;
    }

    .je-calendar-agenda-subtitle {
      opacity: 0.8;
    }

    .je-calendar-agenda-event-meta {
      display: flex;
      align-items: center;
      gap: 0.5em;
      margin-top: 0.25em;
      font-size: 0.85em;
      opacity: 0.8;
      flex-wrap: wrap;
    }

    .je-calendar-agenda-event-meta img {
      width: 14px;
      height: 14px;
      object-fit: contain;
    }

    .je-calendar-agenda-event-title {
      display: flex;
      flex-direction: column;
      gap: 0.15em;
      min-width: 0;
    }

    .je-calendar-agenda-title-text,
    .je-calendar-agenda-subtitle {
      display: -webkit-box;
      -webkit-line-clamp: 1;
      -webkit-box-orient: vertical;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: normal;
      line-height: 1.2;
      max-height: 1.2em;
      min-width: 0;
    }

    @media (max-width: 1450px) {
      .je-calendar-page {
        padding: 1em;
      }

      .je-calendar-header {
        flex-direction: column;
        align-items: flex-start;
        margin-bottom: 0.5em;
      }

      .je-calendar-title {
        font-size: 1.5em;
      }

      .je-calendar-actions {
        width: 100%;
        flex-direction: column;
      }

      .je-calendar-nav {
        justify-content: center;
        flex-wrap: wrap;
      }

      .je-calendar-grid {
        gap: 0.5em;
      }

      .je-calendar-day {
        min-height: 120px;
        padding: 0.5em;
      }

      .je-calendar-legend {
        gap: 1em;
      }

      .je-calendar-layout {
        flex-direction: column;
        width: 100%;
      }

      .je-calendar-sidebar {
        position: unset;
        top: 1em;
        width: 100%;
        flex-direction: row;
        flex-wrap: nowrap;
        justify-content: space-between;
        align-items: center;
        order: -1;
      }

      .je-calendar-main {
        width: 100%;
      }

      .je-calendar-sidebar .je-calendar-legend {
        flex: 1 1 auto;
        margin-top: 0;
      }

      .je-calendar-legend.je-calendar-legend-vertical {
        flex-direction: row;
        flex-wrap: wrap;
        gap: 1em;
        width: 100%;
        justify-content: space-around;
      }

      .je-calendar-page.je-view-month .je-calendar-weekdays {
        display: none;
      }

      .je-calendar-page.je-view-month .je-calendar-month-day-name {
        display: block;
      }

      .je-calendar-page.je-view-month .je-calendar-month-grid {
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      }

      .je-calendar-page.je-view-month .je-calendar-day-placeholder {
        display: none;
      }

      .je-calendar-page.je-view-week .je-calendar-grid {
        grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      }
    }

    @media (max-width: 768px) {
      .je-calendar-actions-center {
        position: static;
        transform: none;
      }

      .je-calendar-actions-right {
        margin-left: 0;
      }
      .je-calendar-page {
        padding: 0.25em;
        max-width: 100vw;
      }

      .je-calendar-main {
        overflow-x: hidden;
      }

      .je-calendar-nav-btn,
      .je-calendar-view-btn {
        padding: 0.35em 0.6em;
        font-size: 0.85em;
      }

      .je-calendar-nav-btn {
        height: 1.9em;
        min-width: 1.9em;
        padding: 0;
      }

      .je-calendar-nav-btn.je-calendar-nav-today {
        padding: 0 0.8em;
      }

      .je-calendar-grid {
        grid-template-columns: repeat(7, 1fr);
        gap: 0.15em;
        width: 100%;
        max-width: 100%;
        overflow-x: auto;
      }

      .je-calendar-day {
        min-height: 80px;
        min-width: 0;
        padding: 0.15em;
      }

      .je-calendar-hour-row {
        grid-template-columns: 70px 1fr;
      }

      .je-calendar-hour-label {
        text-align: left;
      }

      .je-calendar-agenda-row {
        flex-direction: column;
        gap: 0.5em;
      }

      .je-calendar-agenda-date {
        min-width: auto;
      }

      .je-calendar-agenda-event {
        gap: 0.5em;
      }

      .je-calendar-legend {
        gap: 0.5em;
        font-size: 0.8em;
        padding: 0.75em;
      }

      .je-calendar-legend-item {
        flex: 1 1 45%;
      }
    }
  `;

  const logPrefix = '🪼 Jellyfin Enhanced: Calendar Page:';

  /**
   * Get default view mode from settings, defaults to agenda
   */
  function getDefaultViewMode() {
    JE.currentSettings = JE.currentSettings || JE.loadSettings?.() || {};
    const configuredDefault = (JE.currentSettings.calendarDefaultViewMode || "agenda").toLowerCase();
    if (configuredDefault === "month" || configuredDefault === "week" || configuredDefault === "agenda" || configuredDefault === "day"){
      return configuredDefault;
    }

    // Default to agenda if no valid setting
    return "agenda";
  }

  /**
   * Initialize calendar page
   */
  function initialize() {
    console.log(`${logPrefix} Initializing calendar page module`);

    const config = JE.pluginConfig || {};
    if (!config.CalendarPageEnabled || (pluginPagesExists && config.CalendarUsePluginPages)) {
      if (pluginPagesExists && config.CalendarUsePluginPages) {
        console.log(`${logPrefix} Calendar page is injected via Plugin Pages`);
      } else {
        console.log(`${logPrefix} Calendar page is disabled`);
      }
      return;
    }

    injectStyles();
    loadSettings();

    // Inject navigation and set up one-time re-injection on sidebar rebuild
    injectNavigation();
    setupNavigationWatcher();

    // Setup event listeners
    window.addEventListener("hashchange", interceptNavigation, true);
    window.addEventListener("popstate", interceptNavigation, true);
    document.addEventListener("viewshow", handleViewShow);
    document.addEventListener("click", handleNavClick);
    document.addEventListener("click", handleEventClick);

    startLocationWatcher();

    // Check location on init
    handleNavigation();

    console.log(`${logPrefix} Calendar page module initialized`);
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

  /**
   * Intercept hash/popstate changes for our route before Jellyfin router
   */
  function interceptNavigation(e) {
    const url = e?.newURL ? new URL(e.newURL) : window.location;
    const hash = url.hash;
    const path = url.pathname;
    const matches = hash.startsWith("#/calendar") || path === "/calendar";
    if (matches) {
      if (e?.stopImmediatePropagation) e.stopImmediatePropagation();
      if (e?.preventDefault) e.preventDefault();
      showPage();
    }
  }

  function stopLocationWatcher() {
    if (state.locationTimer) {
      clearInterval(state.locationTimer);
      state.locationTimer = null;
    }
  }

  // Load calendar settings from plugin config
  function loadSettings() {
    const config = JE.pluginConfig || {};
    JE.currentSettings = JE.currentSettings || JE.loadSettings?.() || {};
    state.settings = {
      firstDayOfWeek: config.CalendarFirstDayOfWeek || "Monday",
      timeFormat: config.CalendarTimeFormat || "5pm/5:30pm",
      highlightFavorites: config.CalendarHighlightFavorites || false,
      highlightWatchedSeries: config.CalendarHighlightWatchedSeries || false,
      displayMode: JE.currentSettings.calendarDisplayMode || "list",
    };
  }

  // Inject CSS styles into page
  function injectStyles() {
    if (document.getElementById("je-calendar-styles")) return;
    const style = document.createElement("style");
    style.id = "je-calendar-styles";
    style.textContent = CSS_STYLES;
    document.head.appendChild(style);

    // Inject dynamic theme colors
    injectThemeColors();
  }

  // Inject dynamic theme colors
  function injectThemeColors() {
    const existingThemeStyle = document.getElementById("je-calendar-theme-colors");
    if (existingThemeStyle) {
      existingThemeStyle.remove();
    }

    const themeVars = JE.themer?.getThemeVariables() || {};
    const primaryAccent = themeVars.primaryAccent || '#00a4dc';

    const themeStyle = document.createElement("style");
    themeStyle.id = "je-calendar-theme-colors";
    themeStyle.textContent = `
      .je-calendar-view-btn.active {
        background: ${primaryAccent} !important;
        border-color: ${primaryAccent} !important;
      }
      .je-calendar-legend-item.active {
        border-color: ${primaryAccent} !important;
      }
      .je-calendar-day.je-calendar-today {
        border-color: rgba(128,128,128,0.2) !important;
        box-shadow: none;
      }
      .je-calendar-day.je-calendar-today .je-calendar-day-number,
      .je-calendar-day.je-calendar-today .je-calendar-day-name {
        color: ${primaryAccent} !important;
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
   * Fetch calendar events from backend
   */
  async function fetchCalendarEvents(startDate, endDate) {
    try {
      const response = await fetch(
        ApiClient.getUrl("/JellyfinEnhanced/arr/calendar", {
          start: startDate.toISOString(),
          end: endDate.toISOString(),
        }),
        { headers: getAuthHeaders() },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      state.events = (data.events || []).filter((evt) => evt && evt.releaseDate);
      return data;
    } catch (error) {
      console.error(`${logPrefix} Failed to fetch calendar events:`, error);
      state.events = [];
      return null;
    }
  }

  /**
   * Fetch user data (favorite/watched status) for calendar events
   * Uses POST endpoint to only check specific calendar events, not entire library
   */
  async function fetchUserData() {
    if (!state.settings.highlightFavorites && !state.settings.highlightWatchedSeries) {
      state.userDataMap = new Map();
      return;
    }

    if (!state.events?.length) {
      state.userDataMap = new Map();
      return;
    }

    try {
      // Send only the events we need to check
      const eventsToCheck = state.events.map((evt) => ({
        id: evt.id,
        type: evt.type,
        title: evt.title,
        tvdbId: evt.tvdbId,
        imdbId: evt.imdbId,
        tmdbId: evt.tmdbId,
        seasonNumber: evt.seasonNumber,
        episodeNumber: evt.episodeNumber,
      }));

      const response = await fetch(
        ApiClient.getUrl("/JellyfinEnhanced/arr/calendar/user-data"),
        {
          method: "POST",
          headers: {
            ...getAuthHeaders(),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ events: eventsToCheck }),
        }
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();

      // Build Map for O(1) lookup by event ID
      state.userDataMap = new Map();
      (data.results || []).forEach((result) => {
        state.userDataMap.set(result.id, {
          isFavorite: result.isFavorite,
          isWatched: result.isWatched,
        });
      });
    } catch (error) {
      // Silently handle error - highlighting is optional
      state.userDataMap = new Map();
    }
  }

  /**
   * Load all data
   */
  async function loadAllData() {
    state.isLoading = true;
    renderPage();

    const { start, end } = getRangeForView(state.currentDate, state.viewMode);
    state.rangeStart = start;
    state.rangeEnd = end;

    // First fetch calendar events
    await fetchCalendarEvents(start, end);

    // Then fetch user data for those specific events
    await fetchUserData();

    state.isLoading = false;
    renderPage();
  }

  /**
   * Filter events based on active filters
   */
  function filterEvents(events) {
    if (state.activeFilters.size == 0) return events;

    const filters = Array.from(state.activeFilters);

      return events.filter((event) => {
        const userData = state.userDataMap?.get(event.id);
        const matchesFilter = (filterType) => {
          if (filterType === 'Watchlist') return !!userData?.isFavorite;
          if (filterType === 'Watched') return !!userData?.isWatched;
          if (filterType === 'Available') return !!event.hasFile;
          return event.releaseType === filterType;
        };

      const matched = state.filterMatchMode === 'all'
        ? filters.every(matchesFilter)
        : filters.some(matchesFilter);

      return state.filterInvert ? !matched : matched;
    });
  }

  /**
   * Group events by date
   */
  function groupEventsByDate(events) {
    const grouped = {};

    events.forEach((event) => {
      if (!event.releaseDate) {
        return;
      }
      // Convert UTC timestamp to user's local date
      const date = new Date(event.releaseDate);
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      const dateKey = `${year}-${month}-${day}`;

      if (!grouped[dateKey]) {
        grouped[dateKey] = [];
      }

      grouped[dateKey].push(event);
    });

    return grouped;
  }

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

  // Switch between month/week/agenda views
  function setViewMode(mode) {
    if (state.viewMode === mode) return;
    state.viewMode = mode;
    syncPageModeClasses();

    JE.currentSettings = JE.currentSettings || JE.loadSettings?.() || {};
    JE.currentSettings.calendarDefaultViewMode = mode;
    if (typeof JE.saveUserSettings === 'function') {
      JE.saveUserSettings('settings.json', JE.currentSettings);
    }

    loadAllData();
  }


  function setDisplayMode(mode) {
    if (!mode || state.settings.displayMode === mode) return;
    state.settings.displayMode = mode;
    syncPageModeClasses();
    JE.currentSettings = JE.currentSettings || JE.loadSettings?.() || {};
    JE.currentSettings.calendarDisplayMode = mode;
    if (typeof JE.saveUserSettings === 'function') {
      JE.saveUserSettings('settings.json', JE.currentSettings);
    }

    if (state.viewMode === "agenda") {
      updateDisplayModeButtons();
      return;
    }

    renderPage();
  }

  function updateDisplayModeButtons() {
    const buttons = document.querySelectorAll(".je-calendar-mode-btn");
    buttons.forEach((btn) => {
      const mode = btn.dataset.mode;
      btn.classList.toggle("active", mode === state.settings.displayMode);
    });
  }

  // Navigate forward or backward
  function shiftPeriod(direction) {
    const delta = direction === "next" ? 1 : -1;
    const current = new Date(state.currentDate);

    if (state.viewMode === "month") {
      current.setDate(1);
      current.setMonth(current.getMonth() + delta);
    } else if (state.viewMode === "week") {
      current.setDate(current.getDate() + delta * 7);
    } else if (state.viewMode === "day") {
      current.setDate(current.getDate() + delta);
    } else {
      current.setDate(current.getDate() + delta * 30);
    }

    state.currentDate = current;
    loadAllData();
  }

  // Jump to today's date
  function goToday() {
    state.currentDate = new Date();
    loadAllData();
  }

  // Toggle filter on/off
  function toggleFilter(filterType) {
    if (state.activeFilters.has(filterType)) {
      state.activeFilters.delete(filterType);
    } else {
      state.activeFilters.add(filterType);
    }
    renderPage();
  }

  function setFilterMatchMode(mode) {
    if (!mode || (mode !== 'any' && mode !== 'all')) return;
    if (state.activeFilters.size < 2) return;
    if (state.filterMatchMode === mode) return;
    state.filterMatchMode = mode;
    renderPage();
  }

  function toggleFilterInvert() {
    if (state.activeFilters.size === 0) return;
    state.filterInvert = !state.filterInvert;
    renderPage();
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

  function getEventBackgroundStyle(event, color) {
    if (state.settings.displayMode !== "backdrop") {
      return `background: ${color}20;`;
    }
    const imageUrl = event.backdropUrl || event.posterUrl;
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
    const typeIcon = event.type === "Series" ? SONARR_ICON_URL : RADARR_ICON_URL;
    const sourceLabel = event.source;
    const iconClass = event.source === "Sonarr" ? "je-calendar-sonarr-icon" : "je-calendar-radarr-icon";
    const subtitle = event.subtitle ? `<span class="je-calendar-event-subtitle">${escapeHtml(event.subtitle)}</span>` : "";
    const hasFileClass = event.hasFile ? " je-has-file" : "";
    const tooltip = buildEventTooltip(event);
    const hasBackdropClass = (state.settings.displayMode === "backdrop" && (event.backdropUrl || event.posterUrl)) ? " je-has-backdrop" : "";
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
          <span>${releaseTypeLabel} • <span class="je-arr-badge" title="${escapeHtml(sourceLabel)}">${sourceLabel}</span></span>
          ${timeText ? ` • ${timeText}` : ""}${playButton}
        </div>
      </div>
    `;
  }

  // Render month grid view
  function renderMonthView() {
    const anchor = new Date(state.currentDate);
    anchor.setHours(0, 0, 0, 0);
    anchor.setDate(1);

    const daysInMonth = getDaysInMonth(anchor);
    const firstDay = getFirstDayOfMonth(anchor);
    const filteredEvents = filterEvents(state.events);
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
      dayEvents.sort((a, b) => new Date(a.releaseDate) - new Date(b.releaseDate));

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
    const filteredEvents = filterEvents(state.events);
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
      dayEvents.sort((a, b) => new Date(a.releaseDate) - new Date(b.releaseDate));

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
    const filteredEvents = filterEvents(state.events);
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
      dayEvents.sort((a, b) => new Date(a.releaseDate) - new Date(b.releaseDate));

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
    dayEvents.sort((a, b) => new Date(a.releaseDate) - new Date(b.releaseDate));

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

    html += "</div>";
    return html;
  }

  // Render single event in agenda view
  function renderAgendaEvent(event) {
    const color = getEventColor(event);
    const releaseTypeLabel = formatReleaseLabel(event);
    const typeIcon = event.type === "Series" ? SONARR_ICON_URL : RADARR_ICON_URL;
    const sourceLabel = event.source;
    const iconClass = event.source === "Sonarr" ? "je-sonarr-icon" : "je-radarr-icon";
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
            <span class="je-arr-badge" title="${escapeHtml(sourceLabel)}">${sourceLabel}</span>
            ${timeLabel ? `<span>• ${escapeHtml(timeLabel)}</span>` : ""}
          </div>
        </div>
      </div>
    `;
  }

  function renderCardItems(events) {
    if (!events.length) return "";

    return events.map((event) => {
      const poster = event.posterUrl || event.backdropUrl;
      const releaseTypeLabel = formatReleaseLabel(event);
      const typeIcon = event.type === "Series" ? SONARR_ICON_URL : RADARR_ICON_URL;
      const sourceLabel = event.source;
      const iconClass = event.source === "Sonarr" ? "je-calendar-sonarr-icon" : "je-calendar-radarr-icon";
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
                  <span class="je-arr-badge" title="${escapeHtml(sourceLabel)}">${sourceLabel}</span>
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
            <span class="je-arr-badge" title="${escapeHtml(sourceLabel)}">${sourceLabel}</span>
          </div>
        </div>
      `;
    }).join("");
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
        <div class="je-calendar-legend-item ${getItemClass('Available')}" onclick="window.JellyfinEnhanced.calendarPage.toggleFilter('Available'); event.stopPropagation();">
          <span class="material-symbols-rounded" style="color: #4caf50; font-size: 18px;">check_circle</span>
          <span>${JE.t?.("jellyseerr_btn_available") || "Available"}</span>
        </div>
        ${watchlistLegend}
        ${watchedLegend}
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
   * Render the full page
   */
  function renderPage() {
    syncPageModeClasses();
    const page = createPageContainer();
    const container = document.getElementById("je-calendar-container");
    if (!page || !container) return;

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
          <aside class="je-calendar-sidebar">
            ${renderLegend().replace('je-calendar-legend"', 'je-calendar-legend je-calendar-legend-vertical"')}
          </aside>
        </div>

      ${
        ""
      }
    `;

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

  /**
   * Show page
   */
  function showPage() {
    if (state.pageVisible) return;

    const config = JE.pluginConfig || {};
    if (!config.CalendarPageEnabled) return;
    if (pluginPagesExists && config.CalendarUsePluginPages) return;

    state.pageVisible = true;

    injectStyles();
    const page = createPageContainer();

    if (window.location.hash !== "#/calendar") {
      history.pushState({ page: "calendar" }, "Calendar", "#/calendar");
    }

    const activePage = document.querySelector(".mainAnimatedPage:not(.hide):not(#je-calendar-page)");
    if (activePage) {
      state.previousPage = activePage;
      activePage.classList.add("hide");
      activePage.dispatchEvent(
        new CustomEvent("viewhide", {
          bubbles: true,
          detail: { type: "interior" },
        }),
      );
    }

    page.classList.remove("hide");

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

    page.dispatchEvent(
      new CustomEvent("pageshow", {
        bubbles: true,
        detail: {},
      }),
    );

    // Only load data once (guard against showPage retries)
    if (!state.isLoading) {
      loadAllData();
    }
  }

  /**
   * Hide page
   */
  function hidePage() {
    if (!state.pageVisible) return;

    const page = document.getElementById("je-calendar-page");
    if (page) {
      page.classList.add("hide");
      page.dispatchEvent(
        new CustomEvent("viewhide", {
          bubbles: true,
          detail: { type: "custom" },
        }),
      );
    }

    // Restore the previous page if Jellyfin's router hasn't already shown another page
    if (state.previousPage && !document.querySelector(".mainAnimatedPage:not(.hide):not(#je-calendar-page)")) {
      state.previousPage.classList.remove("hide");
      state.previousPage.dispatchEvent(
        new CustomEvent("viewshow", {
          bubbles: true,
          detail: { type: "interior", isRestored: true },
        }),
      );
    }

    state.pageVisible = false;
    state.previousPage = null;
    stopLocationWatcher();
  }

  /**
   * Handle navigation
   */
  function handleNavigation() {
    const hash = window.location.hash;
    const path = window.location.pathname;
    if (hash === "#/calendar" || path === "/calendar") {
      showPage();
    } else if (state.pageVisible) {
      hidePage();
    }
  }

  /**
   * Handle viewshow events
   */
  function handleViewShow(e) {
    const targetPage = e.target;
    if (state.pageVisible && targetPage && targetPage.id !== "je-calendar-page") {
      hidePage();
    }
  }

  /**
   * Handle nav click
   */
  function handleNavClick(e) {
    if (!state.pageVisible) return;

    const btn = e.target.closest(".headerTabs button, .navMenuOption, .headerButton");
    if (btn && !btn.classList.contains("je-nav-calendar-item")) {
      hidePage();
    }
  }

  /**
   * Inject navigation item into sidebar
   */
  function injectNavigation() {
    const config = JE.pluginConfig || {};
    if (!config.CalendarPageEnabled) return;
    if (pluginPagesExists && config.CalendarUsePluginPages) return;
    if (config.CalendarUseCustomTabs) return; // Skip if using custom tabs

    // Hide plugin page link if it exists
    const pluginPageItem = sidebar?.querySelector(
      'a[is="emby-linkbutton"][data-itemid="Jellyfin.Plugin.JellyfinEnhanced.CalendarPage"]'
    );

    if (pluginPageItem) {
      pluginPageItem.style.setProperty('display', 'none', 'important');
    }

    // Check if already exists
    if (document.querySelector(".je-nav-calendar-item")) {
      return;
    }

    const jellyfinEnhancedSection = document.querySelector('.jellyfinEnhancedSection');

    if (jellyfinEnhancedSection) {
      const navItem = document.createElement("a");
      navItem.setAttribute('is', 'emby-linkbutton');
      navItem.className =
        "navMenuOption lnkMediaFolder emby-button je-nav-calendar-item";
      navItem.href = "#";
      navItem.innerHTML = `
        <span class="navMenuOptionIcon material-icons">calendar_today</span>
        <span class="sectionName navMenuOptionText">${window.JellyfinEnhanced.t("calendar_title")}</span>
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
    if (!config.CalendarPageEnabled) return;
    if (pluginPagesExists && config.CalendarUsePluginPages) return;
    if (config.CalendarUseCustomTabs) return; // Don't watch if using custom tabs

    // Use MutationObserver to watch for sidebar changes, but disconnect after re-injection
    const observer = new MutationObserver(() => {
      // Re-check config each time to avoid injecting when settings change
      const currentConfig = JE.pluginConfig || {};
      if (currentConfig.CalendarUseCustomTabs) return;
      if (pluginPagesExists && currentConfig.CalendarUsePluginPages) return;

      if (!document.querySelector('.je-nav-calendar-item')) {
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

  // Escape HTML characters
  function escapeHtml(text) {
    if (text === null || text === undefined) {
      return "";
    }
    const map = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    };
    return String(text).replace(/[&<>"']/g, (m) => map[m]);
  }

  /**
   * Search for an item by provider IDs using the server endpoint.
   * @param {Object} event - Calendar event with provider IDs
   * @returns {Promise<string|null>} Item ID or null if not found
   */
  async function searchFromProviders(event, options = {}) {
    const preferSeries = !!options.preferSeries;
    const episodeProviders = {};
    const seriesProviders = {};
    if (event.episodeImdbId) episodeProviders.Imdb = event.episodeImdbId;
    if (event.episodeTvdbId) episodeProviders.Tvdb = String(event.episodeTvdbId);
    if (event.imdbId) seriesProviders.Imdb = event.imdbId;
    if (event.tvdbId) seriesProviders.Tvdb = String(event.tvdbId);
    if (event.tmdbId) seriesProviders.Tmdb = String(event.tmdbId);

    const hasEpisodeProviders = Object.keys(episodeProviders).length > 0;
    const hasSeriesProviders = Object.keys(seriesProviders).length > 0;
    if (!hasEpisodeProviders && !hasSeriesProviders) return null;

    try {
      const lookup = async (providers) => {
        const baseUrl = ApiClient.getUrl("/JellyfinEnhanced/items/by-providers");
        const params = new URLSearchParams();
        Object.entries(providers).forEach(([key, value]) => {
          params.append(`providers[${key}]`, value);
        });
        const url = `${baseUrl}?${params.toString()}`;

        const response = await fetch(url, { headers: getAuthHeaders() });
        if (!response.ok) return null;
        const itemId = await response.json();
        return itemId || null;
      };

      if (hasEpisodeProviders && !preferSeries) {
        const episodeItemId = await lookup(episodeProviders);
        if (episodeItemId) return episodeItemId;
      }

      if (hasSeriesProviders) {
        return await lookup(seriesProviders);
      }

      return null;
    } catch (error) {
      console.error(`${logPrefix} Provider search failed:`, error);
      return null;
    }
  }

  /**
   * Navigate to Jellyfin item by searching title and validating with provider IDs
   * Note: AnyProviderIdEquals parameter does NOT work in Jellyfin (only Emby)
   * See: https://github.com/jellyfin/jellyfin/issues/1990
   */
  async function navigateToJellyfinItem(event, options = {}) {
    const preferSeries = !!options.preferSeries;
    const isMovie = event.type === "Movie";

    if (!event.hasFile && (!preferSeries || isMovie)) return;

    // No need to search if itemId is already provided
    if (event.itemId && (!preferSeries || isMovie)) {
      window.location.hash = `#/details?id=${event.itemId}`;
      return;
    }

    try {
      // Try provider-based lookup
      const providerItemId = await searchFromProviders(event, { preferSeries });
      if (providerItemId) {
        window.location.hash = `#/details?id=${providerItemId}`;
        return;
      }
    } catch (error) {
      console.error(`${logPrefix} Navigation failed:`, error);
    }
  }


  /**
   * Handle click on calendar event
   */
  function handleEventClick(e) {
    const filterModeBtn = e.target.closest(".je-calendar-filter-btn");
    if (filterModeBtn) {
      const mode = filterModeBtn.dataset.filterMode;
      if (mode) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        setFilterMatchMode(mode);
      }
      return;
    }

    const filterInvertBtn = e.target.closest(".je-calendar-filter-invert");
    if (filterInvertBtn) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      toggleFilterInvert();
      return;
    }

    const modeBtn = e.target.closest(".je-calendar-mode-btn");
    if (modeBtn) {
      const mode = modeBtn.dataset.mode;
      if (mode) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        setDisplayMode(mode);
      }
      return;
    }

    const playBtn = e.target.closest(".je-calendar-play-btn");
    if (playBtn) {
      const playEventId = playBtn.dataset.eventId;
      const playEvent = state.events.find((ev) => ev.id === playEventId);
      if (!playEvent) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      navigateToJellyfinItem(playEvent, { preferSeries: false });
      return;
    }

    const eventEl = e.target.closest(".je-calendar-event, .je-calendar-agenda-event, .je-calendar-card");
    if (!eventEl) return;

    const eventId = eventEl.dataset.eventId;
    if (!eventId) return;

    const event = state.events.find((ev) => ev.id === eventId);
    if (!event) return;

    e.preventDefault();
    e.stopPropagation();
    navigateToJellyfinItem(event, { preferSeries: true });
  }

  /**
   * Render content for custom tabs (without page state management)
   */
  function renderForCustomTab() {
    injectStyles();
    loadSettings();
    renderPage();
    loadAllData();
  }

  // Export to JE namespace
  JE.calendarPage = {
    initialize,
    showPage,
    hidePage,
    refresh: loadAllData,
    setViewMode,
    shiftPeriod,
    goToday,
    toggleFilter,
    renderPage,
    renderForCustomTab,
    injectStyles,
    loadSettings,
    handleEventClick,
    setDisplayMode
  };

  JE.initializeCalendarPage = initialize;
})();
