/**
 * @file Requests & downloads, phase 1: styles of the Requests page (#/requests): tabs, request rows,
 * group headings, the agenda of Coming soon, empty and error states. Phone (≤ 600 px) and TV
 * layouts are handled here. Colour is never the only signal (the status pill carries icon and words).
 */
(function (JE) {
    'use strict';

    const CSS = `
body.je-hub-active #fallbackPage { display: none !important; }
.je-hub { padding: 5.5em 3vw 3em; max-width: 72em; margin: 0 auto; }
.je-hub-title { display: flex; align-items: center; gap: 0.4em; margin: 0 0 0.6em; font-size: 1.8em; font-weight: 500; }
.je-hub-title .material-icons { font-size: 1.1em; opacity: 0.85; }
.je-hub-tabs { display: flex; gap: 0.5em; flex-wrap: wrap; margin: 0 0 1.2em; }
.je-hub-tab { font: inherit; font-weight: 600; padding: 0.45em 1.1em; min-height: 2.6em; border-radius: 999px; cursor: pointer;
  border: 1px solid rgba(255,255,255,0.18); background: rgba(255,255,255,0.04); color: inherit; }
.je-hub-tab[aria-selected="true"] { background: #6d4ed8; border-color: #7c5ce6; color: #fff; }
.je-hub-tab:focus-visible, .layout-tv .je-hub-tab:focus { outline: 3px solid #fff; outline-offset: 2px; }
.je-hub-tab-count { margin-left: 0.4em; padding: 0 0.45em; border-radius: 999px; background: rgba(255,255,255,0.16); font-size: 0.85em; }
.je-hub-note { padding: 0.7em 1em; border-radius: 8px; background: rgba(255,255,255,0.05); margin: 0 0 1em; opacity: 0.9; }
.je-hub-note-warn { background: rgba(245,158,11,0.10); border-left: 3px solid #f59e0b; }
.je-hub-empty { padding: 2.5em 1em; text-align: center; opacity: 0.75; }
.je-hub-group { margin: 0 0 1.6em; }
.je-hub-group-title { font-size: 1.05em; font-weight: 600; opacity: 0.85; margin: 0 0 0.6em; }
.je-hub-list { display: flex; flex-direction: column; gap: 0.6em; }
.je-hub-row { display: flex; gap: 1em; align-items: flex-start; padding: 0.7em; border-radius: 10px; background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.06); cursor: pointer; }
.je-hub-row:hover { background: rgba(255,255,255,0.07); }
.je-hub-row:focus-visible, .layout-tv .je-hub-row:focus { outline: 3px solid #fff; outline-offset: 2px; }
.je-hub-poster { width: 4.6em; height: 6.9em; flex: 0 0 auto; border-radius: 6px; object-fit: cover; background: rgba(255,255,255,0.08); }
.je-hub-poster-empty { display: flex; align-items: center; justify-content: center; opacity: 0.5; }
.je-hub-body { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 0.35em; }
.je-hub-name { font-size: 1.1em; font-weight: 600; overflow-wrap: anywhere; }
.je-hub-year { font-weight: 400; opacity: 0.7; }
.je-hub-chip { display: inline-block; margin-left: 0.5em; padding: 0 0.5em; border-radius: 4px; font-size: 0.75em; font-weight: 700;
  border: 1px solid rgba(255,255,255,0.35); vertical-align: middle; }
.je-hub-meta { font-size: 0.85em; opacity: 0.75; }
.je-hub-body .je-arr-status { margin: 0.1em 0 0; }
.je-hub-actions { display: flex; gap: 0.5em; flex: 0 0 auto; align-items: center; flex-wrap: wrap; }
.je-hub-btn { font: inherit; font-weight: 600; display: inline-flex; align-items: center; gap: 0.3em; min-height: 2.5em; padding: 0.3em 0.9em;
  border-radius: 8px; border: 1px solid rgba(255,255,255,0.2); background: rgba(255,255,255,0.06); color: inherit; cursor: pointer; }
.je-hub-btn:hover { background: rgba(255,255,255,0.12); }
.je-hub-btn-primary { background: #2e7d32; border-color: #43a047; color: #fff; }
.je-hub-btn:focus-visible, .layout-tv .je-hub-btn:focus { outline: 3px solid #fff; outline-offset: 2px; }
.je-hub-day { font-weight: 700; margin: 1.2em 0 0.5em; }
.je-hub-day:first-child { margin-top: 0; }
.je-hub-tabpanel-embed { margin: 0 -3vw; }
@media (max-width: 600px) {
  .je-hub { padding: 4.8em 0.8em 2em; }
  .je-hub-title { font-size: 1.4em; }
  .je-hub-tabs { flex-wrap: nowrap; overflow-x: auto; padding-bottom: 0.3em; }
  .je-hub-tab { white-space: nowrap; min-height: 44px; min-width: 44px; flex-shrink: 0; }
  .je-hub-row { gap: 0.7em; }
  .je-hub-poster { width: 3.6em; height: 5.4em; }
  .je-hub-actions { flex-basis: 100%; justify-content: flex-end; }
  .je-hub-row { flex-wrap: wrap; }
  .je-hub-body { flex-basis: calc(100% - 4.4em); }
  .je-hub-btn { min-height: 44px; min-width: 44px; }
}
.layout-tv .je-hub { padding-left: 5vw; padding-right: 5vw; }
.layout-tv .je-hub-tab, .layout-tv .je-hub-btn { min-height: 3em; font-size: 1.05em; }
@media (prefers-reduced-motion: reduce) { .je-hub-row { transition: none; } }
`;

    /**
     * Adds the Requests page styles once.
     * @returns {void}
     */
    function injectHubStyles() {
        if (document.getElementById('je-arr-hub-styles')) return;
        const style = document.createElement('style');
        style.id = 'je-arr-hub-styles';
        style.textContent = CSS;
        document.head.appendChild(style);
    }

    JE.internals = JE.internals || {};
    JE.internals.arrHub = JE.internals.arrHub || {};
    JE.internals.arrHub.injectStyles = injectHubStyles;
})(window.JellyfinEnhanced);
