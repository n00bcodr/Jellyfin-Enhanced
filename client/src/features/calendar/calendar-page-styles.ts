import { calendarHost } from './host';
import calendarPageCss from './calendar-page.css';
// /js/arr/calendar/calendar-page-styles.js
// Calendar Page — CSS and theme-color injection (split from calendar-page.js).
// Owns the single injection site for the feature's styles; all former call
// sites route through P.injectStyles, deduped by style id via JE.core.ui.injectCss.
(function () {
  "use strict";

  const { JE, P } = calendarHost();

  // CSS Styles
  const CSS_STYLES = calendarPageCss;

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
