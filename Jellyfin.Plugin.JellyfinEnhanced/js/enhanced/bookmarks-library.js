/**
 * Bookmarks Library View
 * Creates <div class="sections bookmarks"></div> for CustomTabs plugin
 */

(function () {
  'use strict';

  if (!window.JellyfinEnhanced?.pluginConfig?.BookmarksEnabled) {
    console.log('🪼 Jellyfin Enhanced: Bookmarks library feature is disabled');
    return;
  }

  // Inject custom styles
  const style = document.createElement('style');
  style.textContent = `
    .je-bookmarks-wrapper {
      display: flex;
      flex-direction: column;
      gap: 0;
      width: 100%;
    }

    .je-bookmark-tabs {
      display: flex;
      justify-content: center;
      gap: 2px;
      padding: 12px 3vw 8px 3vw;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }

    .je-tab {
      padding: 12px 16px;
      background: transparent;
      color: rgba(200, 200, 200, .7);
      border: none;
      border-bottom: 2px solid transparent;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
      transition: all 0.2s;
      border-radius: 10px 10px 0 0;
    }

    .je-tab:hover {
      background: rgba(255, 255, 255, 0.08);
    }

    .je-tab.active {
      color: rgba(200, 200, 200, 1);
      background: rgba(200, 200, 200, 0.1);
      border-bottom-color: #fff;
    }

    .bookmarks-container {
      padding: 12px 3vw;
    }

    .je-bookmarks-empty {
      text-align: center;
      padding: 60px 20px;
      color: #888;
    }

    .je-bookmarks-empty-icon {
      font-size: 32px;
      margin-bottom: 12px;
      opacity: 0.6;
    }

    .je-bookmarks-empty-title {
      font-size: 18px;
      font-weight: 600;
      margin-bottom: 8px;
    }

    .je-bookmarks-empty-hint {
      font-size: 14px;
    }

    .je-bookmarks-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 16px;
      width: 100%;
    }

    .je-bookmark-item {
      background: rgba(0, 0, 0, 0.32);
      border-radius: 10px;
      border: 1px solid rgba(255, 255, 255, 0.06);
      box-shadow: 0 6px 12px rgba(0, 0, 0, 0.35);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .je-bookmark-item-orphaned {
      border: 2px solid rgba(255, 193, 7, 0.5);
      background: rgba(255, 193, 7, 0.03);
    }

    .je-bookmark-item-header {
      display: flex;
      gap: 14px;
      padding: 12px 14px;
      align-items: flex-start;
      position: relative;
    }

    .je-offset-icon {
      position: absolute;
      top: 12px;
      right: 14px;
      background: rgba(33, 150, 243, 0.15);
      border: 1px solid rgba(33, 150, 243, 0.3);
      color: #2196f3;
      border-radius: 50%;
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: all 0.2s;
      font-size: 18px;
    }

    .je-offset-icon:hover {
      background: rgba(33, 150, 243, 0.25);
      border-color: rgba(33, 150, 243, 0.5);
      transform: scale(1.1);
    }

    /* Modal styles */
    .je-bm-library-modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0,0,0,0.85);
      z-index: 10000;
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0;
      transition: opacity 0.2s;
    }

    .je-bm-library-modal-container {
      background: #181818;
      border-radius: 12px;
      padding: 24px;
      position: relative;
      box-shadow: 0 8px 32px rgba(0,0,0,0.8);
    }

    .je-bm-library-modal-close {
      position: absolute;
      top: 16px;
      right: 16px;
      background: transparent;
      border: none;
      color: #fff;
      font-size: 32px;
      cursor: pointer;
      width: 40px;
      height: 40px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
      transition: background 0.2s;
    }

    .je-bm-library-modal-close:hover {
      background: rgba(255,255,255,0.1);
    }

    .je-bookmarks-modal-header {
      display: flex;
      gap: 16px;
      align-items: flex-start;
      margin-bottom: 24px;
    }

    .je-modal-title {
      margin: 0 0 8px 0;
      font-size: 24px;
      font-weight: 700;
      color: #fff;
    }

    .je-modal-subtitle {
      margin: 0;
      font-size: 13px;
      color: #aaa;
    }

    .je-modal-info-box {
      background: rgba(33, 150, 243, 0.08);
      border: 2px solid rgba(33, 150, 243, 0.3);
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 20px;
    }

    .je-modal-info-title {
      font-size: 12px;
      color: #64b5f6;
      margin-bottom: 8px;
    }

    .je-modal-info-text {
      font-size: 12px;
      color: #ccc;
      line-height: 1.4;
    }

    .je-modal-warning-box {
      background: rgba(255,152,0,0.08);
      border: 2px solid rgba(255,152,0,0.3);
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 24px;
    }

    .je-modal-warning-label {
      font-size: 12px;
      font-weight: 700;
      color: #ff9800;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 8px;
    }

    .je-modal-item-name {
      font-size: 16px;
      font-weight: 600;
      color: #fff;
      margin-bottom: 6px;
    }

    .je-modal-item-meta {
      font-size: 12px;
      color: #ccc;
    }

    .je-modal-label {
      display: block;
      margin-bottom: 8px;
      font-weight: 600;
      color: #e0e0e0;
      font-size: 13px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .je-modal-input {
      width: 100%;
      padding: 12px 16px;
      border: 2px solid rgba(33, 150, 243, 0.3);
      border-radius: 8px;
      background: rgba(255,255,255,0.05);
      color: #fff;
      font-family: inherit;
      font-size: 15px;
      transition: all 0.2s;
      box-sizing: border-box;
    }

    .je-modal-input:focus {
      outline: none;
      border-color: rgba(33, 150, 243, 0.5);
    }

    .je-modal-help-text {
      font-size: 12px;
      color: #999;
      margin-top: 6px;
      line-height: 1.4;
    }

    .je-modal-list-container {
      background: rgba(255,255,255,0.03);
      border-radius: 8px;
      padding: 12px;
      max-height: 200px;
      overflow-y: auto;
    }

    .je-modal-list-title {
      font-size: 12px;
      font-weight: 600;
      color: #aaa;
      margin-bottom: 8px;
      text-transform: uppercase;
    }

    .je-modal-list-item {
      font-size: 13px;
      color: #e0e0e0;
      padding: 6px 0;
      border-bottom: 1px solid rgba(255,255,255,0.05);
    }

    .je-modal-list-item-title {
      font-weight: 600;
    }

    .je-modal-list-item-meta {
      font-size: 11px;
      color: #999;
    }

    .je-bookmark-modal-actions {
      display: flex;
      gap: 12px;
      justify-content: flex-end;
      margin-top: 24px;
      padding-top: 16px;
      border-top: 1px solid rgba(255,255,255,0.08);
    }

    .je-bookmark-btn-cancel {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 10px 20px;
      background: rgba(255, 255, 255, 0.05);
      color: #aaa;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
      transition: all 0.2s;
    }

    .je-bookmark-btn-cancel:hover {
      background: rgba(255, 255, 255, 0.08);
    }

    .je-modal-btn-primary {
      padding: 10px 20px;
      background: rgba(33, 150, 243, 0.2);
      color: #2196f3;
      border: 1px solid rgba(33, 150, 243, 0.3);
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .je-modal-btn-primary:hover {
      background: rgba(33, 150, 243, 0.3);
    }

    .je-modal-btn-primary:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .je-btn-find-replacement {
      position: absolute;
      top: 12px;
      right: 14px;
      background: rgba(255, 152, 0, 0.15);
      border: 1px solid rgba(255, 152, 0, 0.3);
      color: #ff9800;
      border-radius: 50%;
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: all 0.2s;
      font-size: 18px;
    }

    .je-btn-find-replacement:hover {
      background: rgba(255, 152, 0, 0.25);
      border-color: rgba(255, 152, 0, 0.5);
      transform: scale(1.1);
    }

    .je-bookmark-item-poster {
      width: 86px;
      height: 129px;
      object-fit: cover;
      border-radius: 6px;
      cursor: pointer;
      flex-shrink: 0;
    }

    .je-bookmark-item-placeholder {
      width: 86px;
      height: 129px;
      background: rgba(255, 255, 255, 0.08);
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #b0bec5;
      font-size: 13px;
      flex-shrink: 0;
    }

    .je-bookmark-item-info {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .je-bookmark-item-title {
      color: #e3f2fd;
      font-size: 18px;
      font-weight: 700;
      text-decoration: none;
      display: block;
    }

    .je-bookmark-item-title:hover {
      color: #fff;
    }

    .je-bookmark-item-meta {
      color: #90a4ae;
      font-size: 13px;
    }

    .je-bookmarks-list {
      display: grid;
      gap: 8px;
      padding: 0 14px 12px 14px;
    }

    .je-bookmark-row {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 10px 12px;
      background: rgba(255, 255, 255, 0.03);
      border-radius: 8px;
      border: 1px solid rgba(255, 255, 255, 0.06);
    }

    .je-bookmark-main {
      display: flex;
      align-items: center;
      gap: 16px;
    }

    .je-bookmark-bar {
      width: 2px;
      height: 32px;
      background: rgb(30, 144, 255);
      border-radius: 2px;
    }

    .je-bookmark-info {
      flex: 1;
    }

    .je-bookmark-label {
      font-size: 15px;
      color: #eceff1;
      font-weight: 600;
    }

    .je-bookmark-time {
      font-size: 13px;
      color: #b0bec5;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }

    .je-bookmark-time:hover {
      color: #ccc;
    }

    .je-bookmark-actions {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }

    .je-btn {
      padding: 6px 10px;
      background: rgba(255, 255, 255, 0.08);
      color: #fff;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 5px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      transition: all 0.2s;
      font-size: 12px;
    }

    .je-btn:hover {
      background: rgba(255, 255, 255, 0.12);
      border-color: rgba(255, 255, 255, 0.2);
    }

    .je-btn-delete {
      background: rgba(200, 40, 40, 0.12);
      color: #ff6b6b;
      border-color: rgba(200, 40, 40, 0.25);
    }

    .je-btn-delete:hover {
      background: rgba(200, 40, 40, 0.18);
      border-color: rgba(200, 40, 40, 0.35);
    }

    .je-btn-edit-row {
      display: none;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
      padding-left: 20px;
    }

    .je-btn-edit-row.show {
      display: flex;
    }

    .je-input {
      padding: 8px 10px;
      border-radius: 6px;
      border: 1px solid rgba(255, 255, 255, 0.14);
      background: rgba(255, 255, 255, 0.04);
      color: #fff;
      font-size: 13px;
    }

    .je-input::placeholder {
      color: #777;
    }

    .je-input-label {
      min-width: 200px;
      flex: 1;
    }

    .je-btn-action {
      padding: 8px 14px;
      background: rgba(255, 255, 255, 0.1);
      color: #fff;
      border: 1px solid rgba(255, 255, 255, 0.2);
      border-radius: 5px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: all 0.2s;
      font-size: 13px;
    }

    .je-btn-action:hover {
      background: rgba(255, 255, 255, 0.15);
      border-color: rgba(255, 255, 255, 0.3);
    }

    .je-btn-cancel {
      background: rgba(255, 255, 255, 0.05);
      color: #aaa;
      border-color: rgba(255, 255, 255, 0.1);
    }

    .je-btn-cancel:hover {
      background: rgba(255, 255, 255, 0.08);
    }

    .je-bookmark-actions-footer {
      display: flex;
      gap: 12px;
      justify-content: center;
      padding: 24px 0 12px 0;
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      margin-top: 24px;
    }

    .je-btn-footer {
      padding: 10px 18px;
      background: rgba(255, 255, 255, 0.08);
      color: #fff;
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 6px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-size: 14px;
      transition: all 0.2s;
    }

    .je-btn-footer:hover {
      background: rgba(255, 255, 255, 0.12);
    }

    .je-btn-footer-delete {
      background: rgba(200, 40, 40, 0.15);
      color: #ff6b6b;
      border-color: rgba(200, 40, 40, 0.3);
    }

    .je-btn-footer-delete:hover {
      background: rgba(200, 40, 40, 0.22);
    }

    /* Replacement modal specific */
    .je-replacement-modal-container {
      max-width: 650px;
      background: linear-gradient(135deg, rgba(20,20,30,0.95) 0%, rgba(25,25,35,0.95) 100%);
      border: 1px solid rgba(76,175,80,0.3);
    }

    .je-replacement-section-title {
      font-size: 13px;
      font-weight: 700;
      color: #4caf50;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 12px;
    }

    .je-replacement-options {
      display: flex;
      flex-direction: column;
      gap: 12px;
      margin-bottom: 24px;
    }

    .replacement-option {
      display: flex;
      gap: 12px;
      background: rgba(76,175,80,0.05);
      border: 2px solid rgba(76,175,80,0.2);
      border-radius: 8px;
      padding: 12px;
      cursor: pointer;
      transition: all 0.2s;
      align-items: center;
    }

    .replacement-option:hover {
      background: rgba(76,175,80,0.1);
      border-color: rgba(76,175,80,0.4);
    }

    .replacement-option.selected {
      background: rgba(76,175,80,0.15);
      border-color: #4caf50;
    }

    .replacement-option img {
      width: 60px;
      height: 90px;
      object-fit: cover;
      border-radius: 6px;
      flex-shrink: 0;
    }

    .replacement-option-placeholder {
      width: 60px;
      height: 90px;
      background: rgba(255,255,255,0.05);
      border-radius: 6px;
      flex-shrink: 0;
    }

    .replacement-option-info {
      flex: 1;
    }

    .replacement-option-name {
      font-weight: 600;
      margin-bottom: 4px;
      color: #fff;
      font-size: 15px;
    }

    .replacement-option-meta {
      font-size: 12px;
      color: #aaa;
    }

    .replacement-option-check {
      color: #4caf50;
      font-size: 28px;
      display: none;
      flex-shrink: 0;
    }

    .replacement-option.selected .replacement-option-check {
      display: block;
    }

    .je-modal-actions-padded {
      padding: 0 28px 28px 28px;
      display: flex;
      gap: 12px;
      justify-content: flex-end;
    }

    .je-modal-btn-submit {
      padding: 10px 24px;
      background: linear-gradient(135deg, #4caf50 0%, #45a049 100%);
      color: #fff;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 700;
      transition: all 0.2s;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .je-modal-btn-submit:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    .je-modal-btn-submit:not(:disabled):hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(76,175,80,0.3);
    }

    .je-modal-btn-cancel-alt {
      padding: 10px 20px;
      background: rgba(255,255,255,0.08);
      color: #fff;
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 6px;
      cursor: pointer;
      font-weight: 600;
      transition: all 0.2s;
    }

    /* Episode title formatting */
    .je-episode-title {
      font-size: 0.85em;
      font-weight: normal;
      color: #b0bec5;
    }

    /* Orphaned results list */
    .je-orphaned-results {
      margin-top: 20px;
      max-height: 400px;
      overflow-y: auto;
    }

    .je-orphaned-result-item {
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 8px;
      padding: 14px;
      margin-bottom: 12px;
    }

    .je-orphaned-result-header {
      display: flex;
      justify-content: space-between;
      align-items: start;
      margin-bottom: 10px;
    }

    .je-orphaned-result-name {
      font-weight: 600;
      color: #ff9800;
      margin-bottom: 4px;
    }

    .je-orphaned-result-count {
      font-size: 12px;
      color: #aaa;
    }

    .je-orphaned-result-meta {
      font-size: 11px;
      color: #666;
      padding: 8px;
      background: rgba(0,0,0,0.3);
      border-radius: 4px;
    }

    .btnMigrateOrphaned {
      background: rgba(76, 175, 80, 0.15);
      border-color: #4caf50;
      color: #4caf50;
    }

    /* Duplicates modal */
    .je-duplicates-modal-container {
      max-width: 700px;
      max-height: 85vh;
      overflow-y: auto;
    }

    .je-duplicate-item {
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 16px;
    }

    .je-duplicate-name {
      font-weight: 600;
      margin-bottom: 12px;
      color: #ff9800;
    }

    .je-duplicate-meta {
      font-size: 12px;
      color: #888;
      margin-bottom: 12px;
    }

    .je-duplicate-version {
      background: rgba(255,255,255,0.02);
      padding: 8px 12px;
      margin-bottom: 8px;
      border-radius: 4px;
    }

    .je-duplicate-version-primary {
      border-left: 3px solid #4caf50;
    }

    .je-duplicate-version-secondary {
      border-left: 3px solid #ff9800;
    }

    .je-duplicate-version-label {
      font-size: 11px;
      font-weight: 600;
      margin-bottom: 4px;
    }

    .je-duplicate-version-primary .je-duplicate-version-label {
      color: #4caf50;
    }

    .je-duplicate-version-secondary .je-duplicate-version-label {
      color: #ff9800;
    }

    .je-duplicate-version-id {
      font-size: 11px;
      color: #999;
    }

    .je-duplicate-version-id code {
      background: rgba(0,0,0,0.3);
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 11px;
    }

    .btnMergeDuplicates {
      margin-top: 8px;
      background: rgba(255, 152, 0, 0.15);
      border-color: #ff9800;
      color: #ff9800;
    }

    .material-icons {
      font-size: 18px;
    }
  `;
  document.head.appendChild(style);

  const logPrefix = '🪼 Jellyfin Enhanced: Bookmarks Library:';
  let sectionObserver = null;
  let isRendering = false;
  let lastRenderTs = 0;

  function getJE() {
    // Try common globals first
    if (window.JE) return window.JE;
    if (window.JellyfinEnhanced) return window.JellyfinEnhanced;

    // Then parent/top frames (CustomTabs may run in a child frame)
    if (window.parent?.JE) return window.parent.JE;
    if (window.parent?.JellyfinEnhanced) return window.parent.JellyfinEnhanced;
    if (window.top?.JE) return window.top.JE;
    if (window.top?.JellyfinEnhanced) return window.top.JellyfinEnhanced;

    return null;
  }

  /**
   * Initialize
   */
  function init() {
    console.log(`${logPrefix} Initializing (build id: ${Date.now()})...`);

    let attempts = 0;
    const checkReady = setInterval(() => {
      attempts += 1;
      const je = getJE();
      const ready = !!(je && je.userConfig && je.bookmarks);

      if (attempts % 10 === 0 || attempts <= 5) {
        console.log(`${logPrefix} ready check #${attempts} (JE=${!!je}, userConfig=${!!(je && je.userConfig)}, bookmarks=${!!(je && je.bookmarks)})`);
      }

      if (ready) {
        clearInterval(checkReady);
        // If JE is available only on parent/top, make it accessible locally for this script
        if (!window.JE && je) {
          window.JE = je;
        }
        hookViewEvents();
        document.addEventListener('je-bookmarks-updated', renderIfSectionExists);

        // Watch for section being injected by CustomTabs
        sectionObserver = new MutationObserver(() => renderIfSectionExists());
        sectionObserver.observe(document.body, { childList: true, subtree: true });

        // Try immediate render in case tab is already visible
        renderIfSectionExists();
        console.log(`${logPrefix} ✓ Ready`);
      }
    }, 100);
  }

  /**
   * Render when section exists or bookmarks updated
   */
  function renderIfSectionExists() {
    // Prevent re-entrant renders triggered by our own DOM mutations
    if (isRendering) return;
    const now = Date.now();
    if (now - lastRenderTs < 150) return;

    const container = document.querySelector('.sections.bookmarks');
    if (container) {
      console.log(`${logPrefix} Section found, rendering...`);
      revealSection(container);
      isRendering = true;
      renderBookmarksLibrary(container).finally(() => {
        isRendering = false;
        lastRenderTs = Date.now();
      });
      // Disconnect observer once section is found to prevent self-triggering loops
      if (sectionObserver) {
        sectionObserver.disconnect();
        sectionObserver = null;
      }
    }
  }

  /**
   * Bind to viewshow so CustomTabs triggers render
   */
  function hookViewEvents() {
    document.addEventListener('viewshow', (e) => {
      // CustomTabs provides a view element on e.detail.view
      const view = e.detail?.view || document;
      const container = view.querySelector?.('.sections.bookmarks');
      if (container) {
        console.log(`${logPrefix} viewshow event: rendering bookmarks section`);
        revealSection(container);
        renderBookmarksLibrary(container);
      }
    });
  }

  /**
   * Remove hidden styles often set by CustomTabs placeholders
   */
  function revealSection(container) {
    container.classList.remove('hide');
    container.style.removeProperty('display');
    container.style.removeProperty('visibility');
  }

  /**
   * Render bookmarks library content
   */
  async function renderBookmarksLibrary(container) {
    console.log(`${logPrefix} Rendering bookmarks library...`);

    const bookmarks = JE.userConfig.bookmark?.bookmarks || {};
    const bookmarkEntries = Object.entries(bookmarks);

    // Group by item
    const groupedByItem = {};
    const typeCounts = {
      tv: { items: 0, bookmarks: 0 },
      movie: { items: 0, bookmarks: 0 }
    };

    for (const [id, bm] of bookmarkEntries) {
      const key = bm.itemId || bm.tmdbId || bm.tvdbId || 'unknown';
      const normalizedType = normalizeMediaType(bm.mediaType);
      if (!groupedByItem[key]) {
        groupedByItem[key] = {
          details: bm,
          bookmarks: [],
          type: normalizedType
        };
        if (typeCounts[normalizedType]) {
          typeCounts[normalizedType].items += 1;
        }
      }
      groupedByItem[key].bookmarks.push({ id, ...bm });
      if (typeCounts[groupedByItem[key].type]) {
        typeCounts[groupedByItem[key].type].bookmarks += 1;
      }
    }

    // Sort bookmarks within each group by timestamp
    Object.values(groupedByItem).forEach(group => {
      group.bookmarks.sort((a, b) => a.timestamp - b.timestamp);
    });

    const totalItems = Object.keys(groupedByItem).length;
    const totalBookmarks = bookmarkEntries.length;
    let currentTab = container.dataset.currentTab || 'movie';
    if (currentTab === 'tv' && typeCounts.tv.items === 0 && typeCounts.movie.items > 0) {
      currentTab = 'movie';
    } else if (currentTab === 'movie' && typeCounts.movie.items === 0 && typeCounts.tv.items > 0) {
      currentTab = 'tv';
    }
    container.dataset.currentTab = currentTab;

    // Create UI
    container.innerHTML = `
      <div class="je-bookmarks-wrapper">
        <div class="je-bookmark-tabs">
          <button class="je-tab ${currentTab === 'movie' ? 'active' : ''}" data-tab="movie">
            ${JE.t('bookmarks_library_tab_movies')}
          </button>
          <button class="je-tab ${currentTab === 'tv' ? 'active' : ''}" data-tab="tv">
            ${JE.t('bookmarks_library_tab_series')}
          </button>
        </div>

        <div class="bookmarks-container">
          ${totalBookmarks === 0 ? `
            <div class="je-bookmarks-empty">
              <div class="je-bookmarks-empty-icon material-icons" aria-hidden="true">bookmark_border</div>
              <div class="je-bookmarks-empty-title">${JE.t('bookmarks_library_empty_title')}</div>
              <div class="je-bookmarks-empty-hint">${JE.t('bookmarks_library_empty_hint')}</div>
            </div>
          ` : `
            <div class="je-bookmarks-grid" id="bookmarks-items-container"></div>
            <div class="je-bookmark-actions-footer">
              <button class="btnFindDuplicates je-btn-footer">
                <span class="material-icons" aria-hidden="true">merge</span>
                <span>${JE.t('bookmarks_library_button_find_duplicates')}</span>
              </button>
              <button class="btnCleanupBookmarks je-btn-footer">
                <span class="material-icons" aria-hidden="true">cleaning_services</span>
                <span>${JE.t('bookmarks_library_button_cleanup')}</span>
              </button>
              <button class="btnDeleteAllBookmarks je-btn-footer je-btn-footer-delete">
                <span class="material-icons" aria-hidden="true">delete</span>
                <span>${JE.t('bookmarks_library_button_delete_all')}</span>
              </button>
            </div>
          `}
        </div>
      </div>
    `;

    // Attach button handlers
    const findDuplicatesBtn = container.querySelector('.btnFindDuplicates');
    const cleanupBtn = container.querySelector('.btnCleanupBookmarks');
    const deleteAllBtn = container.querySelector('.btnDeleteAllBookmarks');

    findDuplicatesBtn?.addEventListener('click', async () => {
      findDuplicatesBtn.disabled = true;
      const label = findDuplicatesBtn.querySelector('span:last-child');
      const origText = label.innerHTML;
      label.innerHTML = '<span class="material-icons" style="animation: spin 1s linear infinite;">refresh</span>';

      // Surface duplicate bookmark groups and offer merging
      showDuplicatesSyncModal(bookmarks);

      findDuplicatesBtn.disabled = false;
      label.innerHTML = origText;
    });

    cleanupBtn?.addEventListener('click', async () => {
      cleanupBtn.disabled = true;
      const label = cleanupBtn.querySelector('span:last-child');
      const origText = label?.innerHTML;
      if (label) label.innerHTML = '<span class="material-icons" style="animation: spin 1s linear infinite;">refresh</span>';

      try {
        const result = await JE.bookmarks.cleanupOrphaned();
        JE.toast(JE.t('bookmark_cleanup_complete').replace('{count}', result.cleaned), 4000);
        renderBookmarksLibrary(container);
      } catch (error) {
        console.error('Cleanup failed:', error);
        JE.toast(JE.t('bookmark_cleanup_failed'), 3000);
      } finally {
        cleanupBtn.disabled = false;
        if (label && origText) label.innerHTML = origText;
      }
    });

    deleteAllBtn?.addEventListener('click', async () => {
      if (!confirm(JE.t('bookmark_delete_all_confirm'))) return;

      deleteAllBtn.disabled = true;
      const label = deleteAllBtn.querySelector('span:last-child');
      const origText = label?.innerHTML;
      if (label) label.innerHTML = '<span class="material-icons" style="animation: spin 1s linear infinite;">refresh</span>';

      try {
        JE.userConfig.bookmark.bookmarks = {};
        await JE.saveUserSettings();
        JE.toast(JE.t('bookmark_deleted_all'), 3000);
        renderBookmarksLibrary(container);
      } catch (error) {
        console.error('Delete failed:', error);
        JE.toast(JE.t('bookmark_delete_failed'), 3000);
      } finally {
        deleteAllBtn.disabled = false;
        if (label && origText) label.innerHTML = origText;
      }
    });

    // Render items with posters
    if (totalBookmarks > 0) {
      const itemsContainer = container.querySelector('#bookmarks-items-container');
      if (itemsContainer) {
        await renderBookmarkItems(itemsContainer, groupedByItem, currentTab);

        // Tab click handlers
        container.querySelectorAll('.je-tab').forEach(btn => {
          btn.addEventListener('click', async () => {
            const tab = btn.dataset.tab;
            container.dataset.currentTab = tab;
            container.querySelectorAll('.je-tab').forEach(b => {
              b.classList.toggle('active', b.dataset.tab === tab);
            });
            await renderBookmarkItems(itemsContainer, groupedByItem, tab);
          });
        });
      }
    }
  }

  /**
   * Render bookmark items with posters
   */
  async function renderBookmarkItems(container, groupedByItem, currentTab) {
    container.innerHTML = '';
    const apiClient = window.ApiClient || window.ConnectionManager?.currentApiClient();
    if (!apiClient) {
      container.innerHTML = '<p>API client not available</p>';
      return;
    }

    const userId = apiClient.getCurrentUserId();
    const itemPromises = [];

    // Fetch all items
    for (const [key, group] of Object.entries(groupedByItem)) {
      const itemId = group.details.itemId;
      if (itemId) {
        itemPromises.push(
          apiClient.getItem(userId, itemId)
            .then(item => ({ key, group, item, orphaned: false }))
            .catch(err => {
              console.warn(`Failed to fetch item ${itemId}:`, err);
              return { key, group, item: null, orphaned: true };
            })
        );
      } else {
        itemPromises.push(Promise.resolve({ key, group, item: null, orphaned: true }));
      }
    }

    const results = await Promise.all(itemPromises);

    // Apply tab filter
    const filtered = results.filter(({ group }) => {
      if (currentTab === 'tv') return group.type === 'tv';
      if (currentTab === 'movie') return group.type === 'movie';
      return true;
    });

    if (filtered.length === 0) {
      const emptyTitle = currentTab === 'tv' ? JE.t('bookmark_empty_tv') : JE.t('bookmark_empty_movie');
      const emptyHint = JE.t('bookmark_empty_hint');
      container.innerHTML = `
        <div class="je-bookmarks-empty">
          <div class="je-bookmarks-empty-icon material-icons" aria-hidden="true">bookmark_border</div>
          <div class="je-bookmarks-empty-title">${emptyTitle}</div>
          <div class="je-bookmarks-empty-hint">${emptyHint}</div>
        </div>`;
      return;
    }

    // Render each item
    for (const { key, group, item, orphaned } of filtered) {
      const itemCard = document.createElement('div');
      itemCard.className = 'je-bookmark-item';
      if (orphaned) {
        itemCard.classList.add('je-bookmark-item-orphaned');
      }

      const posterUrl = item ? apiClient.getImageUrl(item.Id, {
        type: 'Primary',
        maxWidth: 260,
        tag: item.ImageTags?.Primary
      }) : '';

      // Build header content
      let titleDisplay = escapeHtml(group.details.name || 'Unknown Item');
      // For TV episodes, show series name and episode number/name
      if (group.type === 'tv' && item && item.Type === 'Episode' && item.SeriesName) {
        titleDisplay = `${escapeHtml(item.SeriesName)}<br><small class="je-episode-title">S${item.ParentIndexNumber || '?'}:E${item.IndexNumber || '?'} ${item.Name ? escapeHtml(item.Name) : ''}</small>`;
      }

      // Create the card header HTML
      const headerHtml = `
        <div class="je-bookmark-item-header">
          ${posterUrl ? `
            <img src="${posterUrl}"
                 class="je-bookmark-item-poster"
                 data-item-id="${group.details.itemId}">
          ` : `
            <div class="je-bookmark-item-placeholder"><span class="material-icons" style="font-size: 48px; opacity: 0.3;">image_not_supported</span></div>
          `}
          <div class="je-bookmark-item-info">
            <a href="/web/#/details?id=${group.details.itemId || ''}" class="je-bookmark-item-title">${titleDisplay}</a>
            <div class="je-bookmark-item-meta">
              ${JE.t('bookmark_count').replace('{count}', group.bookmarks.length)}
              ${orphaned ? ` • <span style="color: #ff9800;">${JE.t('bookmark_orphaned')}</span>` : ''}
            </div>
          </div>
          ${orphaned && group.details.tmdbId ? `
            <button class="btnFindReplacement je-btn-find-replacement" data-group-key="${key}" title="${JE.t('bookmark_find_replacement')}">
              <span class="material-icons" aria-hidden="true">find_replace</span>
            </button>
          ` : ''}
          ${!orphaned && group.bookmarks.some(bm => bm.syncedFrom) ? `
            <button class="btnAdjustOffset je-offset-icon" data-group-key="${key}" title="${JE.t('bookmark_adjust_offset')}">
              <span class="material-icons" aria-hidden="true">schedule</span>
            </button>
          ` : ''}
        </div>
        <div class="je-bookmarks-list bookmarks-list-${key}"></div>
      `;

      itemCard.innerHTML = headerHtml;
      container.appendChild(itemCard);

      // Add Find Replacement handler
      const findBtn = itemCard.querySelector('.btnFindReplacement');
      if (findBtn) {
        findBtn.addEventListener('click', async () => {
          await findAndOfferReplacement(group, findBtn);
        });
      }

      // Add Offset Adjustment handler
      const offsetBtn = itemCard.querySelector('.btnAdjustOffset');
      if (offsetBtn) {
        offsetBtn.addEventListener('click', () => {
          showOffsetAdjustmentModal(group);
        });
      }

      // Add poster click handler
      const poster = itemCard.querySelector('.bookmark-item-poster');
      if (poster) {
        poster.addEventListener('click', () => {
          const itemId = poster.dataset.itemId;
          if (itemId) {
            window.Emby?.Page?.show(`/details?id=${itemId}`);
          }
        });
      }

      // Render bookmarks for this item
      const bookmarksList = itemCard.querySelector(`.bookmarks-list-${key}`);
      if (bookmarksList) {
        group.bookmarks.forEach(bm => {
          const bmEl = document.createElement('div');
          bmEl.className = 'je-bookmark-row';

          const row = document.createElement('div');
          row.className = 'je-bookmark-main';

          const bar = document.createElement('div');
          bar.className = 'je-bookmark-bar';

          const info = document.createElement('div');
          info.className = 'je-bookmark-info';
          info.innerHTML = `
            ${bm.label ? `<div class="je-bookmark-label">${escapeHtml(bm.label)}</div>` : ''}
            <div class="je-bm-time" data-item-id="${bm.itemId}" data-time="${bm.timestamp}">
              <span>${bm.progress ? `${bm.progress}% • ` : ''}${formatTimestamp(bm.timestamp)}</span>
            </div>
          `;

          const actions = document.createElement('div');
          actions.className = 'je-bookmark-actions';

          const deleteBtn = document.createElement('button');
          deleteBtn.className = 'btnDeleteBookmark je-btn je-btn-delete';
          deleteBtn.innerHTML = '<span class="material-icons" aria-hidden="true">delete</span>';
          deleteBtn.dataset.bookmarkId = bm.id;

          // Only add play and edit buttons if not orphaned
          if (!orphaned) {
            const playBtn = document.createElement('button');
            playBtn.className = 'btnPlayBookmark je-btn';
            playBtn.innerHTML = '<span class="material-icons" aria-hidden="true">play_arrow</span>';
            playBtn.dataset.itemId = bm.itemId;
            playBtn.dataset.time = bm.timestamp;

            const editBtn = document.createElement('button');
            editBtn.className = 'btnEditBookmark je-btn';
            editBtn.innerHTML = '<span class="material-icons" aria-hidden="true">edit</span>';

            actions.appendChild(playBtn);
            actions.appendChild(editBtn);
          }

          actions.appendChild(deleteBtn);

          row.appendChild(bar);
          row.appendChild(info);
          row.appendChild(actions);

          const editRow = document.createElement('div');
          editRow.className = 'je-btn-edit-row';

          const timeInput = document.createElement('input');
          timeInput.type = 'text';
          timeInput.className = 'je-input';
          timeInput.value = formatTimestamp(bm.timestamp);
          timeInput.placeholder = JE.t('bookmark_time_placeholder');

          const labelInput = document.createElement('input');
          labelInput.type = 'text';
          labelInput.className = 'je-input je-input-label';
          labelInput.value = bm.label || '';
          labelInput.placeholder = JE.t('bookmark_label_placeholder');
          labelInput.maxLength = 100;

          const saveBtn = document.createElement('button');
          saveBtn.className = 'je-btn-action';
          saveBtn.innerHTML = '<span class="material-icons" aria-hidden="true">save</span>';

          const cancelBtn = document.createElement('button');
          cancelBtn.className = 'je-btn-action je-btn-cancel';
          cancelBtn.innerHTML = '<span class="material-icons" aria-hidden="true">close</span>';

          editRow.appendChild(timeInput);
          editRow.appendChild(labelInput);
          editRow.appendChild(saveBtn);
          editRow.appendChild(cancelBtn);

          bmEl.appendChild(row);
          bmEl.appendChild(editRow);
          bookmarksList.appendChild(bmEl);

          // Play button handler (only if not orphaned)
          const playBtn = actions.querySelector('.btnPlayBookmark');
          if (playBtn) {
            playBtn.addEventListener('click', async () => {
              const itemId = playBtn.dataset.itemId;
              const time = parseFloat(playBtn.dataset.time);
              await playItemAtTime(itemId, time);
            });
          }

          // Edit button handler (only if not orphaned)
          const editBtn = actions.querySelector('.btnEditBookmark');
          if (editBtn) {
            editBtn.addEventListener('click', () => {
              editRow.classList.toggle('show');
              if (editRow.classList.contains('show')) {
                timeInput.focus();
              }
            });
          }

          cancelBtn.addEventListener('click', () => {
            editRow.classList.remove('show');
            timeInput.value = formatTimestamp(bm.timestamp);
            labelInput.value = bm.label || '';
          });

          saveBtn.addEventListener('click', async () => {
            const parsedTime = parseTimestampInput(timeInput.value);
            if (parsedTime === null) {
              JE.toast(JE.t('bookmark_time_format_hint'), 3000);
              return;
            }

            saveBtn.disabled = true;
            editBtn.disabled = true;
            try {
              const ok = await JE.bookmarks.update(bm.id, {
                timestamp: parsedTime,
                label: labelInput.value.trim()
              });
              if (ok) {
                JE.toast(JE.t('toast_bookmark_updated'), 2000);
                const bookmarksSection = document.querySelector('.sections.bookmarks');
                if (bookmarksSection) {
                  renderBookmarksLibrary(bookmarksSection);
                }
              } else {
                JE.toast(JE.t('toast_bookmark_save_failed'), 3000);
              }
            } catch (err) {
              console.error('Bookmark update failed', err);
              JE.toast(JE.t('toast_bookmark_save_failed'), 3000);
            } finally {
              saveBtn.disabled = false;
              editBtn.disabled = false;
            }
          });

          // Delete button handler
          deleteBtn.addEventListener('click', async () => {
            const bookmarkId = deleteBtn.dataset.bookmarkId;
            await JE.bookmarks.delete(bookmarkId);
            JE.toast(JE.t('toast_bookmark_deleted'), 2000);

            // Re-render
            const bookmarksSection = document.querySelector('.sections.bookmarks');
            if (bookmarksSection) {
              renderBookmarksLibrary(bookmarksSection);
            }
          });

          // Timestamp click-to-play
          const ts = info.querySelector('.je-bm-time');
          ts?.addEventListener('click', async () => {
            const t = parseFloat(ts.dataset.time);
            await playItemAtTime(ts.dataset.itemId, t);
          });
        });
      }
    }
  }

  /**
   * Play item at specific time
   */
  async function playItemAtTime(itemId, startTime) {
    try {
      console.log(`${logPrefix} Attempting playback: itemId=${itemId}, startTime=${startTime}`);

      // Get the API client
      const apiClient = window.ApiClient || window.ConnectionManager?.currentApiClient();
      if (!apiClient) {
        console.warn(`${logPrefix} API client not available`);
        JE.toast(JE.t('toast_api_client_unavailable'), 3000);
        return;
      }

      // Get device ID to find our session
      const deviceId = apiClient._deviceId || apiClient.deviceId();
      console.log(`${logPrefix} Device ID: ${deviceId}`);

      // Query sessions to find our current session
      const sessionsUrl = apiClient.getUrl('Sessions');
      const sessions = await apiClient.ajax({
        type: 'GET',
        url: sessionsUrl,
        dataType: 'json'
      });

      console.log(`${logPrefix} Available sessions:`, sessions);

      // Find our session by device ID
      const currentSession = sessions.find(s => s.DeviceId === deviceId);

      if (!currentSession) {
        console.warn(`${logPrefix} Could not find current session`);
        JE.toast(JE.t('toast_session_not_found'), 3000);
        return;
      }

      const sessionId = currentSession.Id;
      console.log(`${logPrefix} Found session ID: ${sessionId}`);

      // Use Jellyfin Sessions API to start playback with query parameters
      const startTicks = Math.floor(startTime * 10000000);
      const url = `Sessions/${sessionId}/Playing?playCommand=PlayNow&itemIds=${itemId}&startPositionTicks=${startTicks}`;

      console.log(`${logPrefix} Sending playback request:`, url);

      await apiClient.ajax({
        type: 'POST',
        url: apiClient.getUrl(url)
      });

      console.log(`${logPrefix} Playback started successfully`);
      JE.toast(JE.t('toast_playing'), 2000);

      // Wait for navigation to complete, then trigger bookmark marker update
      setTimeout(() => {
        if (window.JE?.isVideoPage?.() && typeof window.JE.bookmarks?.updateMarkers === 'function') {
          console.log(`${logPrefix} Triggering bookmark marker update after playback start`);
          window.JE.bookmarks.updateMarkers();
        }
      }, 1500);

    } catch (e) {
      console.error(`${logPrefix} Failed to play item:`, e);
      JE.toast(JE.t('toast_playback_failed').replace('{error}', e.message || 'Unknown error'), 3000);
    }
  }

  /**
   * Format timestamp (seconds) to HH:MM:SS
   */
  function formatTimestamp(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) {
      return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  /**
   * Format date string
   */
  function formatDate(dateStr) {
    if (!dateStr) return 'Unknown';
    try {
      const date = new Date(dateStr);
      return date.toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch {
      return dateStr;
    }
  }

  /**
   * Escape HTML
   */
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function normalizeMediaType(mediaType) {
    const type = (mediaType || '').toLowerCase();
    if (type === 'series' || type === 'episode' || type === 'tvshow' || type === 'tv') return 'tv';
    if (type === 'movie' || type === 'film') return 'movie';
    return 'other';
  }

  // Parse HH:MM:SS or MM:SS or seconds into numeric seconds
  function parseTimestampInput(value) {
    if (!value && value !== 0) return null;
    const str = String(value).trim();
    if (!str) return null;

    if (!str.includes(':')) {
      const num = parseFloat(str);
      return Number.isFinite(num) && num >= 0 ? num : null;
    }

    const parts = str.split(':').map(p => parseFloat(p));
    if (parts.some(p => Number.isNaN(p) || p < 0)) return null;

    let seconds = 0;
    for (const part of parts) {
      seconds = seconds * 60 + part;
    }
    return seconds;
  }

  /**
   * Search Jellyfin for items matching a TMDB/TVDB ID
   */
  async function searchForReplacementItem(tmdbId, tvdbId, mediaType) {
    const apiClient = window.ApiClient || window.ConnectionManager?.currentApiClient();
    if (!apiClient) return null;

    const userId = apiClient.getCurrentUserId();

    try {
      // Search using Jellyfin's provider ID filtering
      const itemTypes = mediaType === 'tv' ? 'Series,Episode' : 'Movie';

      // Fetch all items of this type and filter by provider ID client-side
      // This is more reliable than relying on AnyProviderIdEquals
      const url = `Users/${userId}/Items?Recursive=true&IncludeItemTypes=${itemTypes}&SortBy=DateCreated&SortOrder=Descending&Limit=500`;

      let response = await apiClient.ajax({
        type: 'GET',
        url: apiClient.getUrl(url),
        dataType: 'json'
      });

      // Handle if response is a string (shouldn't happen but be safe)
      if (typeof response === 'string') {
        response = JSON.parse(response);
      }

      console.log(`🪼 Jellyfin Enhanced: Bookmarks Library: API Response:`, response);

      const items = response?.Items || [];
      console.log(`🪼 Jellyfin Enhanced: Bookmarks Library: Fetched ${items.length} total items of type ${itemTypes}`);

      if (!Array.isArray(items) || items.length === 0) {
        console.warn(`🪼 Jellyfin Enhanced: Bookmarks Library: No items found or items is not an array`);
        return null;
      }

      // Filter items by matching provider IDs
      // Check both ProviderIds and UserData.Key (TMDB ID is often stored there)
      const matches = items.filter(item => {
        const providerIds = item.ProviderIds || {};
        const userData = item.UserData || {};

        if (tmdbId) {
          // Check ProviderIds.Tmdb
          if (providerIds.Tmdb === String(tmdbId)) return true;
          // Check UserData.Key for TMDB ID
          if (userData.Key === String(tmdbId)) return true;
        }

        if (tvdbId) {
          // Check ProviderIds.Tvdb
          if (providerIds.Tvdb === String(tvdbId)) return true;
        }

        return false;
      });

      console.log(`🪼 Jellyfin Enhanced: Bookmarks Library: Found ${matches.length} matches for ${tmdbId ? 'TMDB:'+tmdbId : 'TVDB:'+tvdbId}`, matches);
      return matches.length > 0 ? matches : null;
    } catch (e) {
      console.error('Failed to search for replacement:', e);
      return null;
    }
  }

  /**
   * Show modal to adjust time offset for synced bookmarks
   */
  function showOffsetAdjustmentModal(group) {
    const syncedBookmarks = group.bookmarks.filter(bm => bm.syncedFrom);
    if (syncedBookmarks.length === 0) {
      JE.toast(JE.t('bookmark_no_synced'), 2000);
      return;
    }

    const modal = document.createElement('div');
    modal.className = 'je-bm-library-modal-overlay';
    modal.innerHTML = `
      <div class="je-bm-library-modal-container" style="max-width: 550px;">
        <button class="je-bm-library-modal-close">×</button>
        <div class="je-bm-library-modal-content">
          <div class="je-bookmarks-modal-header">
            <span class="material-icons" aria-hidden="true" style="font-size: 48px; color: #2196f3; flex-shrink: 0;">schedule</span>
            <div style="flex: 1;">
              <h2 class="je-modal-title">${JE.t('bookmark_adjust_offset')}</h2>
              <p class="je-modal-subtitle">${JE.t('bookmark_synced_count').replace('{count}', syncedBookmarks.length)} ${JE.t('bookmark_for_item').replace('{name}', escapeHtml(group.details.name))}</p>
            </div>
          </div>

          <div class="je-modal-info-box">
            <div class="je-modal-info-title"><span class="material-icons" style="font-size: 14px; vertical-align: middle;">info</span> ${JE.t('bookmark_synced_info_title')}</div>
            <div class="je-modal-info-text">${JE.t('bookmark_synced_info_body')}</div>
          </div>

          <div style="margin-bottom: 24px;">
            <label for="offset-adjustment-input" class="je-modal-label"><span class="material-icons" style="font-size: 14px; vertical-align: middle;">schedule</span> ${JE.t('bookmark_offset_label')}</label>
            <input type="number" id="offset-adjustment-input" value="0" step="0.1" placeholder="0" class="je-modal-input">
            <div class="je-modal-help-text">${JE.t('bookmark_offset_help')}</div>
          </div>

          <div class="je-modal-list-container">
            <div class="je-modal-list-title">${JE.t('bookmark_offset_affected')}</div>
            ${syncedBookmarks.map(bm => `
              <div class="je-modal-list-item">
                <div class="je-modal-list-item-title">${bm.label || JE.t('bookmark_unlabeled')}</div>
                <div class="je-modal-list-item-meta">${formatTimestamp(bm.timestamp)} • ${JE.t('bookmark_from').replace('{source}', bm.syncedFrom)}</div>
              </div>
            `).join('')}
          </div>
        </div>

        <div class="je-bookmark-modal-actions">
          <button class="je-bookmark-btn-cancel">
            <span class="material-icons" aria-hidden="true" style="font-size: 18px;">close</span>
            <span>Cancel</span>
          </button>
          <button class="btnApplyOffset je-modal-btn-primary">
            <span class="material-icons" aria-hidden="true" style="font-size: 18px;">check</span>
            <span>${JE.t('bookmark_apply_offset')}</span>
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    const closeDialog = () => {
      modal.style.opacity = '0';
      setTimeout(() => modal.remove(), 200);
    };

    modal.querySelector('.je-bm-library-modal-close').addEventListener('click', closeDialog);
    modal.querySelector('.je-bookmark-btn-cancel').addEventListener('click', closeDialog);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeDialog();
    });

    // Apply offset button handler
    modal.querySelector('.btnApplyOffset').addEventListener('click', async () => {
      const offset = parseFloat(modal.querySelector('#offset-adjustment-input').value) || 0;

      const btn = modal.querySelector('.btnApplyOffset');
      btn.disabled = true;
      btn.querySelector('span:last-child').innerHTML = '<span class="material-icons" style="animation: spin 1s linear infinite; font-size: 18px;">refresh</span>';

      try {
        let updatedCount = 0;

        // Update each synced bookmark
        for (const bm of syncedBookmarks) {
          const newTimestamp = Math.max(0, bm.timestamp + offset);
          const ok = await JE.bookmarks.update(bm.id, {
            timestamp: newTimestamp,
            syncedFrom: '' // Clear syncedFrom to remove the icon
          });
          if (ok) updatedCount++;
        }

        if (updatedCount > 0) {
          const message = offset === 0
            ? JE.t('bookmark_offset_cleared').replace('{count}', updatedCount)
            : JE.t('bookmark_offset_applied').replace('{count}', updatedCount).replace('{offset}', `${offset > 0 ? '+' : ''}${offset}s`);
          JE.toast(message, 3000);
          closeDialog();

          // Refresh the library view
          const container = document.querySelector('.sections.bookmarks');
          if (container) {
            setTimeout(() => renderBookmarksLibrary(container), 300);
          }
        } else {
          JE.toast(JE.t('bookmark_update_failed'), 3000);
          btn.disabled = false;
          btn.querySelector('span:last-child').textContent = JE.t('bookmark_apply_offset');
        }
      } catch (e) {
        console.error('Failed to apply offset:', e);
        JE.toast(JE.t('bookmark_offset_failed'), 3000);
        btn.disabled = false;
        btn.querySelector('span:last-child').textContent = JE.t('bookmark_apply_offset');
      }
    });

    // Fade in
    setTimeout(() => modal.style.opacity = '1', 10);
  }

  /**
   * Find replacement for orphaned item and offer migration
   */
  async function findAndOfferReplacement(group, triggerBtn) {
    triggerBtn.disabled = true;

    const matches = await searchForReplacementItem(
      group.details.tmdbId,
      group.details.tvdbId,
      group.details.mediaType
    );

    if (!matches || matches.length === 0) {
      JE.toast(JE.t('bookmark_no_replacement'), 3000);
      triggerBtn.disabled = false;
      return;
    }

    showReplacementSelectionModal(group, matches);
    triggerBtn.disabled = false;
  }

  /**
   * Show modal to select replacement item and migrate bookmarks
   */
  function showReplacementSelectionModal(oldGroup, replacementItems) {
    const apiClient = window.ApiClient || window.ConnectionManager?.currentApiClient();
    if (!apiClient) return;

    const modal = document.createElement('div');
    modal.className = 'je-bm-library-modal-overlay';
    modal.style.cssText = 'position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.9); z-index: 10000; display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity 0.2s;';
    modal.innerHTML = `
      <div class="je-bm-library-modal-container je-replacement-modal-container">
        <button class="je-bm-library-modal-close">×</button>
        <div class="je-bm-library-modal-content" style="padding: 28px;">
          <div class="je-bookmarks-modal-header">
            <span class="material-icons" aria-hidden="true" style="font-size: 48px; color: #4caf50; flex-shrink: 0;">find_replace</span>
            <div style="flex: 1;">
              <h2 class="je-modal-title">Replacement Found</h2>
              <p class="je-modal-subtitle">Migrate ${oldGroup.bookmarks.length} bookmark(s) from the old item to a new version</p>
            </div>
          </div>

          <div class="je-modal-warning-box">
            <div class="je-modal-warning-label">Old Item (Missing)</div>
            <div class="je-modal-item-name">${escapeHtml(oldGroup.details.name)}</div>
            <div class="je-modal-item-meta">TMDB: ${oldGroup.details.tmdbId || 'N/A'} • Item ID: ${oldGroup.details.itemId.substring(0,16)}...</div>
          </div>

          <div class="je-replacement-section-title">Select Replacement:</div>
          <div class="je-replacement-options">
            ${replacementItems.map((item, idx) => {
              const posterUrl = apiClient.getImageUrl(item.Id, {
                type: 'Primary',
                maxWidth: 120,
                tag: item.ImageTags?.Primary
              });
              return `
                <div class="replacement-option" data-item-index="${idx}" style="display: flex; gap: 12px; background: rgba(76,175,80,0.05); border: 2px solid rgba(76,175,80,0.2); border-radius: 8px; padding: 12px; cursor: pointer; transition: all 0.2s; align-items: center;">
                  ${posterUrl ? `<img src="${posterUrl}" style="width: 60px; height: 90px; object-fit: cover; border-radius: 6px; flex-shrink: 0;">` : '<div style="width: 60px; height: 90px; background: rgba(255,255,255,0.05); border-radius: 6px; flex-shrink: 0;"></div>'}
                  <div style="flex: 1;">
                    <div style="font-weight: 600; margin-bottom: 4px; color: #fff; font-size: 15px;">${escapeHtml(item.Name)}</div>
                    <div style="font-size: 12px; color: #aaa; margin-bottom: 4px;">${item.ProductionYear || ''}</div>
                    <div style="font-size: 11px; color: #888;">Item ID: ${item.Id.substring(0,16)}...</div>
                  </div>
                  <span class="material-icons" aria-hidden="true" style="color: #4caf50; font-size: 28px; display: none; flex-shrink: 0;">check_circle</span>
                </div>
              `;
            }).join('')}
          </div>
        </div>
        <div class="je-modal-actions-padded">
          <button class="je-modal-btn-cancel-alt je-bookmark-btn-cancel">
            <span class="material-icons" aria-hidden="true" style="font-size: 18px;">close</span>
            <span>Cancel</span>
          </button>
          <button class="je-modal-btn-submit je-bookmark-btn-submit" disabled>
            <span class="material-icons" aria-hidden="true" style="font-size: 18px;">swap_horiz</span>
            <span>Migrate Bookmarks</span>
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    let selectedItem = null;

    const closeDialog = () => {
      modal.style.opacity = '0';
      setTimeout(() => modal.remove(), 200);
    };

    modal.querySelector('.je-bm-library-modal-close').addEventListener('click', closeDialog);
    modal.querySelector('.je-bookmark-btn-cancel').addEventListener('click', closeDialog);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeDialog();
    });

    // Selection handlers
    modal.querySelectorAll('.replacement-option').forEach(option => {
      option.addEventListener('click', () => {
        const idx = parseInt(option.dataset.itemIndex);
        selectedItem = replacementItems[idx];

        modal.querySelectorAll('.replacement-option').forEach(opt => {
          opt.style.borderColor = 'rgba(76,175,80,0.2)';
          opt.style.background = 'rgba(76,175,80,0.05)';
          opt.querySelector('.material-icons').style.display = 'none';
        });

        option.style.borderColor = '#4caf50';
        option.style.background = 'rgba(76,175,80,0.15)';
        option.querySelector('.material-icons').style.display = 'block';

        const submitBtn = modal.querySelector('.je-bookmark-btn-submit');
        submitBtn.disabled = false;
        submitBtn.style.opacity = '1';
      });
    });

    // Migrate handler
    modal.querySelector('.je-bookmark-btn-submit').addEventListener('click', async () => {
      if (!selectedItem) return;

      const btn = modal.querySelector('.je-bookmark-btn-submit');
      btn.disabled = true;
      btn.querySelector('span:last-child').textContent = 'Migrating...';

      try {
        // Fetch full details for new item
        const userId = apiClient.getCurrentUserId();
        const fullItem = await apiClient.getItem(userId, selectedItem.Id);

        const newDetails = {
          itemId: fullItem.Id,
          tmdbId: fullItem.ProviderIds?.Tmdb || oldGroup.details.tmdbId,
          tvdbId: fullItem.ProviderIds?.Tvdb || oldGroup.details.tvdbId,
          mediaType: oldGroup.details.mediaType,
          name: fullItem.Name
        };

        // Delete old bookmarks BEFORE syncing to prevent race condition with re-render
        for (const bm of oldGroup.bookmarks) {
          delete JE.userConfig.bookmark.bookmarks[bm.id];
        }

        // Sync bookmarks to new item (no offset)
        const synced = await JE.bookmarks.syncBookmarks(oldGroup.bookmarks, newDetails, 0);

        JE.toast(JE.t('bookmark_migrated').replace('{count}', synced.length).replace('{name}', fullItem.Name), 4000);

        closeDialog();

        // Refresh the library view
        const container = document.querySelector('.sections.bookmarks');
        if (container) {
          setTimeout(() => renderBookmarksLibrary(container), 500);
        }
      } catch (e) {
        console.error('Migration failed:', e);
        JE.toast(JE.t('bookmark_migration_failed'), 3000);
        btn.disabled = false;
        btn.querySelector('span:last-child').textContent = JE.t('bookmark_migrate');
      }
    });

    setTimeout(() => modal.style.opacity = '1', 10);
  }

  /**
   * Find all orphaned bookmarks and offer migration
   */
  async function findAllOrphanedAndOfferMigration(bookmarks) {
    const apiClient = window.ApiClient || window.ConnectionManager?.currentApiClient();
    if (!apiClient) {
      JE.toast(JE.t('toast_api_client_unavailable'), 3000);
      return;
    }

    const userId = apiClient.getCurrentUserId();
    const orphanedGroups = [];

    // Group by item ID
    const byItem = {};
    for (const [id, bm] of Object.entries(bookmarks)) {
      if (!byItem[bm.itemId]) {
        byItem[bm.itemId] = {
          details: bm,
          bookmarks: []
        };
      }
      byItem[bm.itemId].bookmarks.push({ id, ...bm });
    }

    // Check each item
    for (const [itemId, group] of Object.entries(byItem)) {
      try {
        await apiClient.getItem(userId, itemId);
        // Item exists, not orphaned
      } catch (e) {
        // Item doesn't exist, it's orphaned
        if (group.details.tmdbId || group.details.tvdbId) {
          orphanedGroups.push(group);
        }
      }
    }

    if (orphanedGroups.length === 0) {
      JE.toast(JE.t('bookmark_no_orphaned'), 3000);
      return;
    }

    // Search for replacements for all orphaned items
    const replacementResults = [];
    for (const group of orphanedGroups) {
      const matches = await searchForReplacementItem(
        group.details.tmdbId,
        group.details.tvdbId,
        group.details.mediaType
      );
      if (matches && matches.length > 0) {
        replacementResults.push({ group, matches });
      }
    }

    if (replacementResults.length === 0) {
      JE.toast(JE.t('bookmark_orphaned_no_replacement').replace('{count}', orphanedGroups.length), 4000);
      return;
    }

    // Show summary modal
    showOrphanedSummaryModal(replacementResults);
  }

  /**
   * Show summary of all orphaned items with replacements
   */
  function showOrphanedSummaryModal(replacementResults) {
    const modal = document.createElement('div');
    modal.className = 'je-bm-library-modal-overlay';
    modal.style.cssText = 'position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.85); z-index: 10000; display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity 0.2s;';
    modal.innerHTML = `
      <div class="je-bm-library-modal-container" style="max-width: 700px; background: #181818; border-radius: 12px; padding: 24px; position: relative; box-shadow: 0 8px 32px rgba(0,0,0,0.8);">
        <button class="je-bm-library-modal-close" style="position: absolute; top: 16px; right: 16px; background: transparent; border: none; color: #fff; font-size: 32px; cursor: pointer; width: 40px; height: 40px; display: flex; align-items: center; justify-content: center; border-radius: 50%; transition: background 0.2s;">×</button>
        <div class="je-bm-library-modal-content">
          <div class="je-bookmarks-modal-header">
            <span class="material-icons" aria-hidden="true" style="font-size: 32px; color: #4caf50;">search</span>
            <div>
              <h2 style="margin: 0 0 4px 0; font-size: 20px;">Orphaned Bookmarks</h2>
              <p style="margin: 0; font-size: 13px; color: #999;">Found ${replacementResults.length} item(s) with replacements available</p>
            </div>
          </div>
          <div style="margin-top: 20px; max-height: 400px; overflow-y: auto;">
            ${replacementResults.map((result, idx) => `
              <div class="je-orphaned-result-item">
                <div class="je-orphaned-result-header">
                  <div>
                    <div class="je-orphaned-result-name">${escapeHtml(result.group.details.name)}</div>
                    <div class="je-orphaned-result-count">${result.group.bookmarks.length} bookmark(s) • ${result.matches.length} replacement(s) found</div>
                  </div>
                  <button class="btnMigrateOrphaned je-btn" data-result-index="${idx}">
                    <span class="material-icons" aria-hidden="true" style="font-size: 16px;">find_replace</span>
                    <span>Migrate</span>
                  </button>
                </div>
                <div class="je-orphaned-result-meta">
                  TMDB: ${result.group.details.tmdbId || 'N/A'} • Item ID: ${result.group.details.itemId.substring(0,12)}...
                </div>
              </div>
            `).join('')}
          </div>
        </div>
        <div class="je-bookmark-modal-actions">
          <button class="je-bookmark-btn-cancel">
            <span class="material-icons" aria-hidden="true" style="font-size: 18px;">close</span>
            <span>Close</span>
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    const closeDialog = () => {
      modal.style.opacity = '0';
      setTimeout(() => modal.remove(), 200);
    };

    modal.querySelector('.je-bm-library-modal-close').addEventListener('click', closeDialog);
    modal.querySelector('.je-bookmark-btn-cancel').addEventListener('click', closeDialog);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeDialog();
    });

    // Migrate button handlers
    modal.querySelectorAll('.btnMigrateOrphaned').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.resultIndex);
        const result = replacementResults[idx];
        closeDialog();
        setTimeout(() => showReplacementSelectionModal(result.group, result.matches), 300);
      });
    });

    setTimeout(() => modal.style.opacity = '1', 10);
  }

  /**
   * Find duplicate bookmarks (same TMDB/TVDB but different item IDs)
   */
  function findDuplicateBookmarks(bookmarks) {
    const byProvider = {}; // Group by TMDB/TVDB ID
    const duplicateGroups = [];

    for (const [id, bm] of Object.entries(bookmarks)) {
      const tmdbKey = bm.tmdbId ? `tmdb:${bm.tmdbId}` : null;
      const tvdbKey = bm.tvdbId ? `tvdb:${bm.tvdbId}` : null;

      for (const key of [tmdbKey, tvdbKey].filter(Boolean)) {
        if (!byProvider[key]) {
          byProvider[key] = {};
        }
        if (!byProvider[key][bm.itemId]) {
          byProvider[key][bm.itemId] = [];
        }
        byProvider[key][bm.itemId].push({ id, ...bm });
      }
    }

    // Find groups with multiple item IDs
    for (const [providerKey, itemGroups] of Object.entries(byProvider)) {
      const itemIds = Object.keys(itemGroups);
      if (itemIds.length > 1) {
        duplicateGroups.push({
          providerKey,
          itemGroups,
          totalBookmarks: Object.values(itemGroups).flat().length,
          name: Object.values(itemGroups)[0][0].name || 'Unknown'
        });
      }
    }

    return duplicateGroups;
  }

  /**
   * Show modal to sync duplicate bookmarks
   */
  function showDuplicatesSyncModal(bookmarks) {
    const duplicates = findDuplicateBookmarks(bookmarks);

    if (duplicates.length === 0) {
      JE.toast(JE.t('bookmark_no_duplicates'), 3000);
      return;
    }

    const modal = document.createElement('div');
    modal.className = 'je-bm-library-modal-overlay';
    modal.style.cssText = 'position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.85); z-index: 10000; display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity 0.2s;';
    modal.innerHTML = `
      <div class="je-bm-library-modal-container" style="max-width: 700px; background: #181818; border-radius: 12px; padding: 24px; position: relative; box-shadow: 0 8px 32px rgba(0,0,0,0.8); max-height: 85vh; overflow-y: auto;">
        <button class="je-bm-library-modal-close" style="position: absolute; top: 16px; right: 16px; background: transparent; border: none; color: #fff; font-size: 32px; cursor: pointer; width: 40px; height: 40px; display: flex; align-items: center; justify-content: center; border-radius: 50%; transition: background 0.2s;">×</button>
        <div class="je-bm-library-modal-content">
          <div class="je-bookmarks-modal-header" style="display: flex; gap: 16px; align-items: flex-start; margin-bottom: 24px;">
            <span class="material-icons" aria-hidden="true" style="font-size: 48px; color: #ff9800; flex-shrink: 0;">merge</span>
            <div style="flex: 1;">
              <h2 style="margin: 0 0 8px 0; font-size: 24px; font-weight: 700; color: #fff;">${JE.t('bookmark_duplicate_title')}</h2>
              <p style="margin: 0; font-size: 13px; color: #aaa;">${JE.t('bookmark_duplicate_subtitle').replace('{count}', duplicates.length)}</p>
            </div>
          </div>
          <div style="margin-top: 20px;">
            ${duplicates.map((dup, idx) => {
              const itemIds = Object.keys(dup.itemGroups);
              return `
                <div style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 16px; margin-bottom: 16px;">
                  <div style="font-weight: 600; margin-bottom: 12px; color: #ff9800;">${escapeHtml(dup.name)}</div>
                  <div style="font-size: 12px; color: #888; margin-bottom: 12px;">
                    ${JE.t('bookmark_split_versions')
                      .replace('{count}', dup.totalBookmarks)
                      .replace('{versions}', itemIds.length)}
                  </div>
                  ${itemIds.map((itemId, versionIdx) => {
                    const bms = dup.itemGroups[itemId];
                    return `
                      <div style="background: rgba(255,255,255,0.02); border-left: 3px solid ${versionIdx === 0 ? '#4caf50' : '#ff9800'}; padding: 8px 12px; margin-bottom: 8px; border-radius: 4px;">
                        <div style="font-size: 11px; color: ${versionIdx === 0 ? '#4caf50' : '#ff9800'}; font-weight: 600; margin-bottom: 4px;">
                          ${versionIdx === 0 ? JE.t('bookmark_primary_version') : JE.t('bookmark_old_version')}
                        </div>
                        <div style="font-size: 12px; color: #ccc; margin-bottom: 6px;">
                          ${JE.t('bookmark_item_id')}: <code style="background: rgba(0,0,0,0.3); padding: 2px 6px; border-radius: 3px; font-size: 11px;">${itemId.substring(0, 16)}...</code>
                        </div>
                        <div style="font-size: 12px; color: #aaa; margin-bottom: 8px;">
                          ${JE.t('bookmark_bookmark_count').replace('{count}', bms.length)} ${bms.map(b => formatTimestamp(b.timestamp)).join(', ')}
                        </div>
                        <button class="je-btn" data-sync-from="${versionIdx}" data-dup-index="${idx}" style="background: rgba(33, 150, 243, 0.15); border-color: #2196f3; color: #2196f3; font-size: 11px;">
                          <span class="material-icons" aria-hidden="true" style="font-size: 14px;">schedule</span>
                          <span>${JE.t('bookmark_adjust_offset')}</span>
                        </button>
                      </div>
                    `;
                  }).join('')}
                  <button class="je-btn" data-dup-index="${idx}" style="margin-top: 8px; background: rgba(255, 152, 0, 0.15); border-color: #ff9800; color: #ff9800;">
                    <span class="material-icons" aria-hidden="true" style="font-size: 16px;">merge</span>
                    <span>${JE.t('bookmark_merge_primary')}</span>
                  </button>
                </div>
              `;
            }).join('')}
          </div>
        </div>
        <div class="je-bookmark-modal-actions">
          <button class="je-bookmark-btn-cancel">
            <span class="material-icons" aria-hidden="true" style="font-size: 18px;">close</span>
            <span>Close</span>
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    const closeDialog = () => {
      modal.style.opacity = '0';
      setTimeout(() => modal.remove(), 200);
    };

    modal.querySelector('.je-bm-library-modal-close').addEventListener('click', closeDialog);
    modal.querySelector('.je-bookmark-btn-cancel').addEventListener('click', closeDialog);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeDialog();
    });

    // Adjust Offset button handlers
    modal.querySelectorAll('[data-sync-from]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const dupIndex = parseInt(btn.dataset.dupIndex);
        const versionIndex = parseInt(btn.dataset.syncFrom);
        const dup = duplicates[dupIndex];
        const itemIds = Object.keys(dup.itemGroups);
        const targetItemId = itemIds[versionIndex];
        const bookmarksForItem = dup.itemGroups[targetItemId];

        closeDialog();

        // Show offset adjustment modal for these bookmarks
        const groupObj = {
          bookmarks: bookmarksForItem,
          details: { name: dup.name }
        };
        showOffsetAdjustmentModal(groupObj);
      });
    });

    // Merge button handlers
    modal.querySelectorAll('button.je-btn:not([data-sync-from])').forEach(btn => {
      if (!btn.dataset.dupIndex) return;

      btn.addEventListener('click', async () => {
        const dupIndex = parseInt(btn.dataset.dupIndex);
        const dup = duplicates[dupIndex];
        const itemIds = Object.keys(dup.itemGroups);

        if (itemIds.length < 2) return;

        const primaryItemId = itemIds[0]; // First one is primary
        const oldItemIds = itemIds.slice(1);

        const primaryBookmarks = dup.itemGroups[primaryItemId];
        const oldBookmarks = oldItemIds.flatMap(id => dup.itemGroups[id]);

        if (!confirm(JE.t('bookmark_merge_confirm').replace('{count}', oldBookmarks.length))) {
          return;
        }

        btn.disabled = true;
        btn.querySelector('span:last-child').innerHTML = '<span class="material-icons" style="animation: spin 1s linear infinite; font-size: 18px;">refresh</span>';

        try {
          // Get primary item details from first primary bookmark
          const primaryDetails = {
            itemId: primaryItemId,
            tmdbId: primaryBookmarks[0].tmdbId,
            tvdbId: primaryBookmarks[0].tvdbId,
            mediaType: primaryBookmarks[0].mediaType,
            name: primaryBookmarks[0].name
          };

          // Sync old bookmarks to primary
          const synced = await JE.bookmarks.syncBookmarks(oldBookmarks, primaryDetails, 0);
          JE.toast(JE.t('bookmark_merge_success').replace('{count}', synced.length), 3000);

          closeDialog();

          // Refresh the library view
          const container = document.querySelector('.sections.bookmarks');
          if (container) {
            setTimeout(() => renderBookmarksLibrary(container), 500);
          }
        } catch (e) {
          console.error('Merge failed:', e);
          JE.toast(JE.t('bookmark_merge_failed'), 3000);
          btn.disabled = false;
          btn.querySelector('span:last-child').textContent = JE.t('bookmark_merge_primary');
        }
      });
    });

    setTimeout(() => modal.style.opacity = '1', 10);
  }

  // Initialize
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();