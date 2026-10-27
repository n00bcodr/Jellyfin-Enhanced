/**
 * @file Requests & downloads, phase 3: styles for the request controls (Get it / Get them, the rows JE
 * draws for missing episodes, dimmed thumbnails, the download ring on a thumbnail, the episode status
 * dialog) and JE.initializeArrAsk, which starts the phase-3 surfaces. Targets are at least 44 px on
 * phones and TV; colour is never the only signal (icon and words).
 */
(function (JE) {
    'use strict';

    const CSS = `
.je-ask-get { position: relative; display: inline-flex; align-items: center; gap: 0.25em; margin-left: 0.5em; padding: 0.1em 0.75em;
  min-height: max(1.9em, 24px); border-radius: 999px; border: 1px solid #7c5cff; background: #6d4aff; color: #fff; font: inherit; font-size: 0.8em;
  font-weight: 700; line-height: 1.2; cursor: pointer; white-space: nowrap; vertical-align: middle; }
/* A hit area of at least 44 px around the compact button (rows clip it to their line, so the button
   itself is at least 24 px there; touch screens of any width and the TV layout get a 44 px button
   below). */
.je-ask-get::after { content: ''; position: absolute; left: 50%; top: 50%; width: max(44px, calc(100% + 8px)); height: max(44px, 100%);
  transform: translate(-50%, -50%); }
.je-ask-get:hover { background: #7d5dff; }
.je-ask-get:focus-visible, .layout-tv .je-ask-get:focus { outline: 3px solid #fff; outline-offset: 2px; }
.je-ask-get[disabled] { opacity: 0.75; cursor: progress; }
.je-ask-get-icon { font-size: 1.15em; }
.je-ask-get-large { font-size: 1em; min-height: 2.75em; padding: 0.3em 1.1em; margin-left: 0; }
.je-ask-get-many { font-size: 0.9em; min-height: 2.4em; padding: 0.3em 1em; margin-left: 0; }
.je-arr-chip-row .je-ask-get { margin-left: 0.4em; }
.je-arr-banner { flex-wrap: wrap; }
.je-arr-banner .je-ask-banner-action { margin-left: auto; display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 0.5em; }
.je-ask-banner-action .je-arr-chip { margin-left: 0; }
.je-ask-paused { margin-left: 0.5em; }
.je-arr-chip-row .je-ask-paused, .je-ask-banner-action .je-ask-paused { margin-left: 0.4em; }
.je-ask-paused-note { display: flex; gap: 0.6em; align-items: flex-start; margin: 0.6em 0 0.8em; padding: 0.6em 0.9em; border-radius: 10px;
  border: 1px solid rgba(245,158,11,0.6); background: rgba(245,158,11,0.12); color: #f5b041; line-height: 1.35; }
.je-ask-paused-icon { font-size: 1.3em; }
.je-ask-paused-body { display: flex; flex-direction: column; gap: 0.15em; min-width: 0; }
.je-ask-paused-text { opacity: 0.95; overflow-wrap: anywhere; }
.je-ask-banner-action .je-ask-paused-note { margin: 0; }
/* The JE-mode collection picker's longer state words wrap in their column (phones keep room for the title). */
.jellyseerr-collection-movie-row .je-arr-collection-paused, .jellyseerr-collection-movie-row .je-arr-collection-known { white-space: normal; max-width: 9em; }
.jellyseerr-collection-movie-row .je-arr-collection-paused { color: #f5b041; border-color: rgba(245,158,11,0.6); background: rgba(245,158,11,0.12); }
/* The collection to look at (A1: JE the backend, asking off or not the viewer's): each row a button opening its movie. */
.je-arr-collection-view { display: flex; flex-direction: column; gap: 8px; }
.je-arr-collection-view .je-arr-collection-view-row { display: grid; grid-template-columns: 46px 1fr auto; align-items: center; gap: 16px; width: 100%;
  padding: 12px 16px; margin: 0; text-align: left; color: inherit; font: inherit; cursor: pointer; background: rgba(30, 41, 59, 0.4);
  border: 1px solid rgba(51, 65, 85, 0.3); border-radius: 8px; }
.je-arr-collection-view .je-arr-collection-view-row:hover, .je-arr-collection-view .je-arr-collection-view-row:focus-visible {
  background: rgba(30, 41, 59, 0.7); border-color: rgba(59, 130, 246, 0.5); }
.je-arr-collection-view .jellyseerr-collection-movie-poster { width: 46px; height: auto; border-radius: 4px; }
.je-ask-dim .listItemImage { filter: grayscale(0.85) brightness(0.55); }
.je-ask-dim .listItemImageButton { display: none; }
.je-ask-native-label-off .missingIndicator, .je-ask-native-label-off .unairedIndicator { display: none; }
.je-ask-replaced { display: none !important; }
.listItemImage .je-ask-ring { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 3; pointer-events: none; }
.je-ask-ring .je-arr-ring { width: 52px; height: 52px; }
.je-ask-ring .je-arr-ring-text { font-size: 13px; }
.je-ask-dim .je-ask-ring { filter: none; }
.je-ask-row .listItemImage { background-size: cover; background-position: center; background-color: rgba(127,127,127,0.18); display: flex; align-items: center; justify-content: center; cursor: pointer; }
.je-ask-row-placeholder { font-size: 2.6em; opacity: 0.45; }
.je-ask-row-spoiler { filter: blur(14px) grayscale(0.85) brightness(0.55) !important; }
.je-ask-row-title { all: unset; cursor: pointer; border-radius: 4px; }
.je-ask-row-title:hover bdi { text-decoration: underline; }
.je-ask-row-title:focus-visible, .layout-tv .je-ask-row-title:focus { outline: 3px solid #fff; outline-offset: 2px; }
.je-ask-row-info:focus-visible, .layout-tv .je-ask-row-info:focus { outline: 3px solid #fff; outline-offset: 2px; }
.je-ask-sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); border: 0; white-space: nowrap; }
.je-ask-dialog-backdrop { position: fixed; inset: 0; z-index: 1100; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; padding: 1em; }
.je-ask-dialog { background: #181a1f; color: #e8eaed; border-radius: 12px; max-width: 34em; width: 100%; max-height: 90vh; overflow: auto; padding: 1.2em 1.4em;
  box-shadow: 0 10px 40px rgba(0,0,0,0.5); }
.je-ask-dialog-title { margin: 0 0 0.3em; font-size: 1.3em; }
.je-ask-dialog-facts { opacity: 0.75; margin-bottom: 0.8em; }
.je-ask-dialog .je-arr-status { margin: 0 0 0.8em; }
.je-ask-dialog-overview { line-height: 1.45; opacity: 0.9; }
.je-ask-dialog-note { line-height: 1.45; opacity: 0.85; font-size: 0.9em; margin: 0.6em 0 0; }
.je-ask-dialog-actions { display: flex; flex-wrap: wrap; gap: 0.6em; justify-content: flex-end; margin-top: 1em; }
.je-ask-dialog-close { font: inherit; color: inherit; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.25); border-radius: 8px;
  min-height: 2.75em; min-width: 2.75em; padding: 0.3em 1.1em; cursor: pointer; }
.je-ask-dialog-close:focus-visible, .layout-tv .je-ask-dialog-close:focus { outline: 3px solid #fff; outline-offset: 2px; }
.je-ask-light .je-arr-chip, .je-ask-light .je-arr-pill { color: color-mix(in srgb, var(--je-arr-tone, #5f6368) 72%, #000);
  background: color-mix(in srgb, var(--je-arr-tone, #5f6368) 14%, transparent); }
.je-ask-light .je-arr-banner { background: rgba(229,160,13,0.12); }
.je-ask-light .je-ask-paused-note { color: #8a5a00; }
.je-ask-light .je-ask-get:focus-visible, .je-ask-light .je-ask-row-title:focus-visible, .je-ask-light .je-ask-row-info:focus-visible { outline-color: #202124; }
@media (max-width: 600px) {
  .je-ask-get { min-height: 44px; min-width: 44px; font-size: 0.9em; padding: 0.2em 0.9em; }
  .je-arr-banner .je-ask-banner-action { margin-left: 0; width: 100%; justify-content: flex-start; }
  .je-ask-row-title { display: inline-block; min-height: 44px; line-height: 44px; }
  .je-ask-row-info { min-width: 44px; min-height: 44px; }
  .je-ask-ring .je-arr-ring { width: 36px; height: 36px; }
  .je-ask-ring .je-arr-ring-text { font-size: 11px; }
  .je-ask-dialog-backdrop { align-items: flex-end; padding: 0; }
  .je-ask-dialog { border-radius: 16px 16px 0 0; max-height: 85vh; }
}
@media (any-pointer: coarse) {
  .je-ask-get { min-height: 44px; min-width: 44px; }
}
.layout-tv .je-ask-get { min-height: 48px; min-width: 48px; font-size: 1em; padding: 0.3em 1.1em; }
.layout-tv .je-ask-ring .je-arr-ring { width: 64px; height: 64px; }
.layout-tv .je-ask-dialog-backdrop { padding: 0; }
.layout-tv .je-ask-dialog { max-width: none; width: 100%; height: 100%; max-height: none; border-radius: 0; }
`;

    /**
     * Injects the request-control styles once.
     * @returns {void}
     */
    function ensure() {
        if (document.getElementById('je-arr-ask-styles')) return;
        if (JE.helpers?.addCSS) {
            JE.helpers.addCSS('je-arr-ask-styles', CSS);
            return;
        }
        const style = document.createElement('style');
        style.id = 'je-arr-ask-styles';
        style.textContent = CSS;
        document.head.appendChild(style);
    }

    /**
     * Marks the page when jellyfin-web shows a light theme (dark body text), so the status chips stay
     * readable on it; themes have no class of their own, and a user can switch theme at any time.
     * @returns {boolean} Light theme.
     */
    function syncTheme() {
        let light = false;
        try {
            const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(document.body).color || '');
            light = !!m && (0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3])) / 255 < 0.5;
        } catch {
            light = false;
        }
        document.documentElement.classList.toggle('je-ask-light', light);
        return light;
    }

    /**
     * Starts the phase-3 request controls when the server has them on (no-op otherwise).
     * @returns {void}
     */
    function initializeArrAsk() {
        if (!JE.arrAsk?.enabled()) return;
        ensure();
        syncTheme();
        if (typeof JE.initializeArrAskEpisodes === 'function') JE.initializeArrAskEpisodes();
        // JE-mode "Not in your library" row on the search page (it also starts on the first navigation).
        if (typeof JE.initializeArrAskSearch === 'function') JE.initializeArrAskSearch();
    }

    JE.internals = JE.internals || {};
    JE.internals.arrAskStyles = { ensure, syncTheme, CSS };
    JE.initializeArrAsk = initializeArrAsk;
})(window.JellyfinEnhanced);
