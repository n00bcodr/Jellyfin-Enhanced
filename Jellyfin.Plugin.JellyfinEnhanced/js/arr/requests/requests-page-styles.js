// /js/arr/requests/requests-page-styles.js
// Requests Page — CSS and theme-color injection (split from requests-page.js).
// Owns the single injection site for the feature's styles; all former call
// sites route through P.injectStyles, deduped by style id via JE.core.ui.injectCss.
(function () {
  "use strict";

  const JE = window.JellyfinEnhanced;
  // Private cross-module wiring for the split requests page (js/arr/requests/requests-page-*.js).
  // Not part of the public JE.* surface.
  JE.internals = JE.internals || {};
  const P = (JE.internals.requestsPage = JE.internals.requestsPage || {});

  // CSS Styles - minimal styling to fit Jellyfin's theme
  const CSS_STYLES = `
        .je-downloads-page {
            padding: 2em;
            max-width: 85vw;
            margin: 0 auto;
            position: relative;
            z-index: 1;
        }
        .je-downloads-section {
            margin-bottom: 2em;
        }
        .je-downloads-section h2 {
            font-size: 1.5em;
            margin-bottom: 1em;
        }
        .je-downloads-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
          gap: 1.1em;
        }
        .je-download-card, .je-request-card {
            background: rgba(128,128,128,0.1);
            border-radius: 0.25em;
            overflow: hidden;
        }
        .je-download-card-content {
          display: flex;
          gap: 1em;
          padding: 1.15em;
        }
        .je-download-poster, .je-request-poster {
            border-radius: 0.5em;
            object-fit: cover;
            flex-shrink: 0;
        }
        .je-download-poster {
          width: 72px;
          height: 108px;
        }
        .je-request-poster {
            width: 80px;
            height: 120px;
            max-height: 120px;
        }
        .je-download-poster.placeholder, .je-request-poster.placeholder {
            display: flex;
            align-items: center;
            justify-content: center;
            background: rgba(128,128,128,0.15);
            opacity: 0.5;
        }
        .je-download-info, .je-request-info {
            flex: 1;
            min-width: 0;
            display: flex;
            flex-direction: column;
            gap: 0.3em;
        }
        .je-download-title, .je-request-title {
            font-weight: 600;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .je-download-subtitle, .je-request-year {
            font-size: 0.85em;
            opacity: 0.7;
        }
        .je-download-meta {
            display: flex;
            gap: 0.5em;
            flex-wrap: wrap;
            margin-top: auto;
        }
        .je-download-badge, .je-request-status {
          font-size: 0.95em;
          padding: 0.35em 0.7em;
          border-radius: 999px;
          text-transform: uppercase;
          font-weight: 700;
          color: #fff;
        }
        .je-arr-badge {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 0.25em;
          padding: 0;
          background: transparent;
        }
        .je-arr-badge img {
          width: 18px;
          height: 18px;
          object-fit: contain;
          filter: drop-shadow(0 1px 2px rgba(0,0,0,0.35));
        }
        .je-download-progress-container {
            padding: 0 1em 1em;
        }
        .je-download-progress {
            height: 4px;
            background: rgba(128,128,128,0.2);
            border-radius: 2px;
            overflow: hidden;
        }
        .je-download-progress-bar {
            height: 100%;
            transition: width 0.3s ease;
        }
        .je-download-stats {
          display: flex;
          justify-content: space-between;
          font-size: 1em;
          opacity: 0.95;
          margin-top: 0.6em;
        }
        .je-requests-tabs,
        .je-issues-tabs {
            display: flex;
            gap: 0.5em;
            margin-bottom: 1em;
            flex-wrap: wrap;
        }
        .je-requests-tab.emby-button,
        .je-issues-tab.emby-button {
            background: transparent;
            border: 1px solid rgba(255,255,255,0.3);
            color: inherit;
            padding: 0.5em 1em;
            border-radius: 4px;
            cursor: pointer;
            opacity: 0.7;
            transition: all 0.2s;
        }
        .je-requests-tab.emby-button:hover,
        .je-issues-tab.emby-button:hover {
            opacity: 1;
            background: rgba(255,255,255,0.1);
        }
        .je-requests-tab.emby-button.active,
        .je-issues-tab.emby-button.active {
            opacity: 1;
        }
        .je-request-card {
            display: flex;
            gap: 1em;
            padding: 1em;
            overflow: visible;
        }
        .je-request-info {
            overflow: hidden;
            min-width: 0;
        }
        .je-request-header {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            gap: 0.5em;
            margin-bottom: 0.5em;
            min-width: 0;
        }
        .je-request-header > div:first-child {
            min-width: 0;
            flex: 1;
            overflow: hidden;
        }
        .je-request-title {
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            display: block;
        }
        .je-request-status {
            flex-shrink: 0;
        }
        .je-request-meta {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.5em;
          font-size: 0.85em;
          opacity: 0.8;
          margin-top: 0.5em;
        }
        .je-request-meta-left { display: inline-flex; align-items: center; gap: 0.5em; min-width: 0; }
        .je-request-avatar {
            width: 24px;
            height: 24px;
            border-radius: 50%;
            object-fit: cover;
        }
        .je-request-actions {
            margin-top: 1em;
        }
        .je-request-watch-btn {
          color: inherit;
          border: none;
          padding: 0.45em;
          border-radius: 50%;
          cursor: pointer;
          width: 36px;
          height: 36px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          box-shadow: 0 4px 12px rgba(0,0,0,0.25);
        }
        .je-request-watch-btn:hover { opacity: 0.9; }
        .je-request-watch-btn .material-icons { font-size: 20px; }
        .je-request-approve-btn, .je-request-decline-btn {
          border: none;
          padding: 0.45em;
          border-radius: 50%;
          cursor: pointer;
          width: 36px;
          height: 36px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          box-shadow: 0 4px 12px rgba(0,0,0,0.25);
          margin-left: 6px;
        }
        .je-request-approve-btn { background: #4caf50; color: #fff; }
        .je-request-decline-btn { background: #f44336; color: #fff; }
        .je-request-approve-btn:hover { background: #43a047; }
        .je-request-decline-btn:hover { background: #e53935; }
        .je-request-approve-btn .material-icons,
        .je-request-decline-btn .material-icons { font-size: 20px; }
        .je-request-approve-btn:disabled,
        .je-request-decline-btn:disabled { opacity: 0.5; cursor: default; }
        .je-issues-section h2 {
          font-size: 1.5em;
          margin-bottom: 1em;
        }
        .je-issue-card {
          display: flex;
          gap: 1em;
          padding: 1em;
          background: rgba(128,128,128,0.1);
          border-radius: 0.25em;
          overflow: visible;
        }
        .je-issue-info {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 0.35em;
        }
        .je-issue-title-row {
          display: flex;
          align-items: center;
          flex-wrap: wrap;
          gap: 0.4em;
          min-width: 0;
        }
        .je-issue-title {
          font-weight: 600;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: 100%;
        }
        .je-issue-summary {
          font-size: 0.85em;
          opacity: 0.8;
          display: flex;
          flex-wrap: wrap;
          gap: 0.4em;
          align-items: center;
          width: 100%;
        }
        .je-issue-view-btn {
          background: transparent;
          border: none;
          color: inherit;
          width: 28px;
          height: 28px;
          border-radius: 50%;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          opacity: 0.8;
          margin-left: auto;
          transition: opacity 0.2s;
        }
        .je-issue-view-btn:hover { opacity: 1; }
        .je-issue-view-btn.is-disabled { opacity: 0.35; cursor: not-allowed; }
        .je-issue-view-btn .material-icons { font-size: 18px; }
        .je-issue-message {
          font-size: 0.9em;
          opacity: 0.85;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .je-issue-status-chip {
          font-size: 0.7em;
          font-weight: 700;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          padding: 0.25em 0.6em;
          border-radius: 999px;
          border: 1px solid rgba(255,255,255,0.12);
        }
        .je-issue-status-open { background: rgba(234, 179, 8, 0.25); color: #f0f9ff; border-color: rgba(234, 179, 8, 0.5); }
        .je-issue-status-resolved { background: rgba(34, 197, 94, 0.25); color: #f0f9ff; border-color: rgba(34, 197, 94, 0.5); }
        .je-issue-type-chip {
          font-size: 0.7em;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          padding: 0.25em 0.6em;
          border-radius: 999px;
          background: rgba(59, 130, 246, 0.25);
          border: 1px solid rgba(59, 130, 246, 0.5);
          color: #f0f9ff;
        }
        .je-pagination {
            display: flex;
            justify-content: center;
            align-items: center;
            gap: 1em;
            margin-top: 1.5em;
        }
        .je-pagination .emby-button {
            background: transparent;
            border: 1px solid rgba(255,255,255,0.3);
            color: inherit;
            padding: 0.5em 1em;
            border-radius: 4px;
            cursor: pointer;
            opacity: 0.7;
            transition: all 0.2s;
        }
        .je-pagination .emby-button:hover:not(:disabled) {
            opacity: 1;
            background: rgba(255,255,255,0.1);
        }
        .je-pagination .emby-button:disabled { opacity: 0.3; cursor: not-allowed; }
        .je-empty-state {
            text-align: center;
            padding: 3em;
            opacity: 0.5;
        }
        .je-loading {
            display: flex;
            justify-content: center;
            padding: 2em;
        }
        .je-requests-status-chip {
          display: inline-flex;
          align-items: center;
          padding: 0.3rem 0.6rem;
          margin-top: 0.7rem;
          border-radius: 999px;
          font-weight: 700;
          letter-spacing: 0.02em;
          font-size: 0.72rem;
          text-transform: uppercase;
          background: rgba(255, 255, 255, 0.08);
          border: 1px solid rgba(255, 255, 255, 0.12);
        }
        .je-requests-status-chip.je-chip-available { background: rgba(34, 197, 94, 0.25); color: #f0f9ff; border-color: rgba(34, 197, 94, 0.5); }
        .je-requests-status-chip.je-chip-partial { background: rgba(234, 179, 8, 0.25); color: #f0f9ff; border-color: rgba(234, 179, 8, 0.5); }
        .je-requests-status-chip.je-chip-processing { background: rgba(59, 130, 246, 0.25); color: #f0f9ff; border-color: rgba(59, 130, 246, 0.5); }
        .je-requests-status-chip.je-chip-requested { background: rgba(168, 85, 247, 0.25); color: #f0f9ff; border-color: rgba(168, 85, 247, 0.5); }
        .je-requests-status-chip.je-chip-pending { background: rgba(234, 179, 8, 0.25); color: #f0f9ff; border-color: rgba(234, 179, 8, 0.5); }
        .je-requests-status-chip.je-chip-rejected,
        .je-requests-status-chip.je-chip-declined { background: rgba(248, 113, 113, 0.25); color: #f0f9ff; border-color: rgba(248, 113, 113, 0.5); }
        .je-requests-status-chip.je-chip-blocklisted { background: rgba(245, 158, 11, 0.25); color: #f0f9ff; border-color: rgba(245, 158, 11, 0.5); }
        .je-requests-status-chip.je-chip-deleted { background: rgba(220, 38, 38, 0.22); color: #ffe4e6; border-color: rgba(248, 113, 113, 0.55); }
        .je-requests-status-chip.je-chip-coming-soon { background: rgba(156, 39, 176, 0.25); color: #f0f9ff; border-color: rgba(156, 39, 176, 0.5); }
        .je-release-date-chip {
          display: inline-flex;
          align-items: center;
          padding: 0.25rem 0.5rem;
          margin-left: 0.5rem;
          border-radius: 999px;
          font-weight: 600;
          letter-spacing: 0.02em;
          font-size: 0.68rem;
          text-transform: uppercase;
          background: rgba(156, 39, 176, 0.25);
          border: 1px solid rgba(156, 39, 176, 0.5);
          color: #f0f9ff;
        }
        .je-release-date-icon { font-size: 1em; margin-right: 3px; vertical-align: middle; line-height: 1; }
        .je-release-date-chip sup,
        .je-requests-status-chip sup,
        .je-request-title sup {
          font-size: 0.6em;
          opacity: 0.85;
          margin-bottom: 1em;
          margin-right: 0.25em;
          text-transform: lowercase;
        }
        .je-refresh-btn:hover {
          opacity: 1 !important;
          background: rgba(255,255,255,0.1) !important;
        }
        .je-downloads-controls {
          display: flex;
          flex-direction: column;
          gap: 1em;
          margin-bottom: 1.5em;
        }
        .je-downloads-tabs {
          display: flex;
          gap: 0.5em;
          flex-wrap: wrap;
          align-items: center;
        }
        .je-downloads-tab.emby-button {
          background: transparent;
          border: 1px solid rgba(255,255,255,0.3);
          color: inherit;
          padding: 0.5em 1em;
          border-radius: 4px;
          cursor: pointer;
          opacity: 0.7;
          transition: all 0.2s;
          display: inline-flex;
          align-items: center;
          gap: 0.5em;
        }
        .je-downloads-tab.emby-button:hover {
          opacity: 1;
          background: rgba(255,255,255,0.1);
        }
        .je-downloads-tab.emby-button.active {
          opacity: 1;
        }
        .je-downloads-search-toggle {
          background: transparent;
          border: 1px solid rgba(255,255,255,0.3);
          color: inherit;
          padding: 0.5em;
          border-radius: 4px;
          cursor: pointer;
          opacity: 0.7;
          transition: all 0.2s;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 36px;
          height: 36px;
        }
        .je-downloads-search-toggle:hover {
          opacity: 1;
          background: rgba(255,255,255,0.1);
        }
        .je-downloads-search-toggle.active {
          opacity: 1;
          background: rgba(255,255,255,0.15);
        }
        .je-downloads-search-toggle .material-icons {
          font-size: 20px;
        }
        .je-downloads-tab-count {
          font-size: 0.8em;
          padding: 0.2em 0.5em;
          background: rgba(255,255,255,0.5);
          border-radius: 999px;
          min-width: 20px;
          text-align: center;
        }
        .je-downloads-search-container {
          display: flex;
          align-items: center;
          gap: 0.5em;
          position: relative;
          width: 100%;
          animation: slideDown 0.2s ease-out;
        }
        @keyframes slideDown {
          from {
            opacity: 0;
            transform: translateY(-10px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        .je-downloads-search-icon {
          position: absolute;
          left: 0.7em;
          font-size: 20px;
          opacity: 0.5;
          pointer-events: none;
        }
        .je-downloads-search-input {
          background: rgba(255,255,255,0.08);
          border: 1px solid rgba(255,255,255,0.2);
          color: inherit;
          padding: 0.6em 0.9em 0.6em 2.5em;
          border-radius: 4px;
          font-size: 0.9em;
          flex: 1;
          width: 100%;
          transition: all 0.2s;
        }
        .je-downloads-search-input:focus {
          outline: none;
          border-color: rgba(255,255,255,0.4);
          background: rgba(255,255,255,0.12);
        }
        .je-downloads-search-input:focus + .je-downloads-search-icon {
          opacity: 0.7;
        }
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
    `;

  /**
   * Inject CSS styles
   */
  function injectStyles() {
    if (document.getElementById("je-downloads-styles")) return;
    JE.core.ui.injectCss("je-downloads-styles", CSS_STYLES);

    // Inject dynamic theme colors
    injectThemeColors();
  }

  /**
   * Inject dynamic theme colors
   */
  function injectThemeColors() {
    const themeVars = JE.themer?.getThemeVariables() || {};
    const primaryAccent = themeVars.primaryAccent || '#00a4dc';

    JE.core.ui.injectCss("je-downloads-theme-colors", `
      .je-requests-tab.emby-button.active,
      .je-issues-tab.emby-button.active,
      .je-downloads-tab.emby-button.active {
        background: ${primaryAccent} !important;
        border-color: ${primaryAccent} !important;
      }
      .je-request-watch-btn {
        background: ${primaryAccent} !important;
      }
    `);
  }

  P.injectStyles = injectStyles;
})();
