// /js/arr/calendar/calendar-page-styles.js
// Calendar Page — CSS and theme-color injection (split from calendar-page.js).
// Owns the single injection site for the feature's styles; all former call
// sites route through P.injectStyles, deduped by style id via JE.core.ui.injectCss.
(function () {
  "use strict";

  const JE = window.JellyfinEnhanced;
  // Private cross-module wiring for the split calendar page (js/arr/calendar/calendar-page-*.js).
  // Not part of the public JE.* surface.
  JE.internals = JE.internals || {};
  const P = (JE.internals.calendarPage = JE.internals.calendarPage || {});

  // CSS Styles
  const CSS_STYLES = `
    @font-face {
      font-family: 'Material Symbols Rounded';
      font-style: normal;
      font-weight: 100 700;
      font-display: block;
      src: url(${window.JellyfinEnhanced.cdn.url('gfont', 's/materialsymbolsrounded/v258/syl0-zNym6YjUruM-QrEh7-nyTnjDwKNJ_190FjpZIvDmUSVOK7BDB_Qb9vUSzq3wzLK-P0J-V_Zs-QtQth3-jOcbTCVpeRL2w5rwZu2rIelXxc.woff2')}) format('woff2');
    }

    .material-symbols-rounded {
      font-family: 'Material Symbols Rounded';
      font-weight: normal;
      font-style: normal;
      font-size: 24px;
      line-height: 1;
      letter-spacing: normal;
      text-transform: none;
      display: inline-block;
      white-space: nowrap;
      word-wrap: normal;
      direction: ltr;
      -webkit-font-feature-settings: 'liga';
      -moz-font-feature-settings: 'liga';
      font-feature-settings: 'liga';
      -webkit-font-smoothing: antialiased;
    }

    .je-calendar-page,
    .jellyfinenhanced.calendar {
      --je-gray: rgba(128,128,128,0.05);
      --je-gray-hover: rgba(128,128,128,0.12);
    }

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

    .je-calendar-sidebar-toggle {
      display: none;
      align-items: center;
      justify-content: center;
      gap: 0.35em;
      width: 100%;
      padding: 0.45em;
      border-radius: 999px;
      background: var(--je-gray);
      border: 1px solid var(--je-gray);
      color: inherit;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s ease, border-color 0.15s ease;
    }

    .je-calendar-sidebar-toggle:hover {
      background: var(--je-gray-hover);
    }

    .je-calendar-sidebar-toggle-icon {
      font-size: 18px;
      transition: transform 0.2s ease;
    }

    .je-calendar-sidebar:not(.is-collapsed) .je-calendar-sidebar-toggle-icon {
      transform: rotate(180deg);
    }

    .je-calendar-sidebar-content {
      width: 100%;
      display: flex;
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
      background: var(--je-gray);
      border: 1px solid var(--je-gray);
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
      background: var(--je-gray-hover);
    }

    .je-calendar-mode-btn.active,
    .je-calendar-filter-btn.active {
      opacity: 1;
      background: var(--je-gray-hover);
    }


    .je-calendar-card {
      cursor: pointer;
      display: flex;
      flex-direction: column;
      height: 100%;
      background: var(--je-gray);
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
      background: var(--je-gray-hover);
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
      cursor: pointer;
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
      background: var(--je-gray);
      border: 1px solid var(--je-gray);
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
      background: var(--je-gray-hover);
    }

    .je-calendar-month-grid,
    .je-calendar-grid,
    .je-calendar-weekdays,
    .je-calendar-dayline {
      display: grid;
      grid-template-columns: repeat(7, minmax(150px, 1fr));
      gap: 1em;
    }

    .je-calendar-weekday {
      text-align: center;
      font-weight: 600;
      padding: 0.5em;
      opacity: 0.8;
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

    .je-calendar-day {
      background: var(--je-gray);
      border-radius: 0.5em;
      min-height: 150px;
      border: 1px solid var(--je-gray);
      min-width: 0;
    }

    .je-calendar-day.je-calendar-today {
      border-color: var(--je-gray);
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
      border-bottom: 1px solid var(--je-gray);
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

    .je-calendar-shoko-link {
      display: inline-flex;
      align-items: center;
      line-height: 0;
    }

    .je-calendar-legend {
      display: flex;
      flex-wrap: wrap;
      gap: 1.5em;
      margin-top: 2em;
      padding: 1em;
      background: var(--je-gray);
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
      background: var(--je-gray);
      border: 1px solid var(--je-gray);
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
      background: var(--je-gray-hover);
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
      background: var(--je-gray-hover);
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
      border-bottom: 1px solid var(--je-gray);
      padding: 0.75em 0;
      align-items: flex-start;
      gap: 0.5em;
      max-width: 100%;
    }

    .je-calendar-agenda-row:hover {
      background: var(--je-gray-hover);
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
      flex-direction: row-reverse;
      flex-shrink: 0;
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

    @media (max-width: 1340px) {
      .je-calendar-month-grid,
      .je-calendar-grid,
      .je-calendar-weekdays,
      .je-calendar-dayline {
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      }
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

      .je-calendar-month-grid,
      .je-calendar-grid,
      .je-calendar-weekdays,
      .je-calendar-dayline {
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

      .je-calendar-month .je-calendar-weekdays {
        display: none;
      }

      .je-calendar-month .je-calendar-month-day-name {
        display: block;
      }

      .je-calendar-month .je-calendar-day-placeholder {
        display: none;
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

      .je-calendar-month .je-calendar-weekdays {
        display: none;
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

      .je-calendar-sidebar {
        width: 100%;
        flex-direction: column;
        align-items: stretch;
        gap: 0.5em;
      }

      .je-calendar-sidebar-toggle {
        display: inline-flex;
        align-self: stretch;
      }

      .je-calendar-sidebar-content {
        max-height: 1000px;
        opacity: 1;
        overflow: hidden;
        transition: max-height 0.25s ease, opacity 0.2s ease;
      }

      .je-calendar-sidebar.is-collapsed .je-calendar-sidebar-content {
        max-height: 0;
        opacity: 0;
        pointer-events: none;
      }

      .je-calendar-sidebar.is-collapsed .je-calendar-legend {
        padding: 0;
        border-width: 0;
      }
    }
  `;

  // Inject CSS styles into page
  function injectStyles() {
    if (document.getElementById("je-calendar-styles")) return;
    JE.core.ui.injectCss("je-calendar-styles", CSS_STYLES);

    // Inject dynamic theme colors
    injectThemeColors();
  }

  // Inject dynamic theme colors
  function injectThemeColors() {
    const themeVars = JE.themer?.getThemeVariables() || {};
    const primaryAccent = themeVars.primaryAccent || '#00a4dc';

    JE.core.ui.injectCss("je-calendar-theme-colors", `
      .je-calendar-view-btn.active {
        background: ${primaryAccent} !important;
        border-color: ${primaryAccent} !important;
      }
      .je-calendar-legend-item.active {
        border-color: ${primaryAccent} !important;
      }
      .je-calendar-day.je-calendar-today {
        border-color: var(--je-gray) !important;
        box-shadow: none;
      }
      .je-calendar-day.je-calendar-today .je-calendar-day-number,
      .je-calendar-day.je-calendar-today .je-calendar-day-name {
        color: ${primaryAccent} !important;
      }
    `);
  }

  P.injectStyles = injectStyles;
})();
