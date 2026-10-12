/**
 * @file Requests & downloads, phase 2: styles of the administrator's tabs on the Requests page
 * (Overview, Activity, System, Audit) and of the queue-action dialogs. Phone (≤ 600 px: tables
 * become cards) and TV layouts are handled here. Colour is never the only signal (icons and words).
 */
(function (JE) {
    'use strict';

    const CSS = `
.je-ops-banner { padding: 0.7em 1em; border-radius: 8px; margin: 0 0 1em; background: rgba(46,125,50,0.16); border-left: 3px solid #43a047; }
.je-ops-banner.je-ops-banner-error { background: rgba(229,57,53,0.14); border-left-color: #e53935; }
.je-ops-banner.je-ops-banner-unknown { background: rgba(245,158,11,0.12); border-left-color: #f59e0b; }
.je-ops-grid { display: grid; grid-template-columns: minmax(0, 1fr) 20em; gap: 1em; align-items: start; }
.je-ops-main { display: flex; flex-direction: column; gap: 1em; min-width: 0; }
.je-ops-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(15em, 1fr)); gap: 0.8em; }
.je-ops-card, .je-ops-box { border-radius: 10px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); padding: 0.9em 1em; min-width: 0; }
.je-ops-card-head { display: flex; align-items: center; gap: 0.5em; font-weight: 700; }
.je-ops-card-head .je-ops-name { flex: 1 1 auto; overflow-wrap: anywhere; }
.je-ops-kind { display: inline-flex; width: 1.6em; height: 1.6em; border-radius: 50%; align-items: center; justify-content: center; font-size: 0.8em; background: rgba(109,78,216,0.35); }
.je-ops-state { display: inline-flex; align-items: center; gap: 0.25em; padding: 0.05em 0.6em; border-radius: 999px; font-size: 0.8em; font-weight: 700; border: 1px solid currentColor; }
.je-ops-state .material-icons { font-size: 1.1em; }
.je-ops-ok { color: #4caf50; }
.je-ops-warn { color: #f59e0b; }
.je-ops-bad { color: #ef5350; }
.je-ops-muted { opacity: 0.7; }
.je-ops-line { font-size: 0.88em; margin-top: 0.45em; display: flex; flex-wrap: wrap; gap: 0.3em 0.9em; }
.je-ops-disk { margin-top: 0.5em; font-size: 0.85em; }
.je-ops-disk-label { display: flex; justify-content: space-between; gap: 0.5em; }
.je-ops-disk-label span:first-child { overflow-wrap: anywhere; }
.je-ops-bar { height: 0.4em; border-radius: 999px; background: rgba(255,255,255,0.1); overflow: hidden; margin-top: 0.25em; }
.je-ops-bar-fill { height: 100%; background: #7c5ce6; }
.je-ops-bar-fill.je-ops-bar-low { background: linear-gradient(90deg, #f59e0b, #ef5350); }
.je-ops-box-title { display: flex; align-items: center; gap: 0.5em; font-size: 1.1em; font-weight: 700; margin: 0 0 0.6em; }
.je-ops-count { margin-left: auto; min-width: 1.8em; height: 1.8em; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%;
  border: 1px solid #f59e0b; color: #f59e0b; font-size: 0.85em; }
.je-ops-empty { padding: 1em 0.2em; opacity: 0.75; }
.je-ops-item { display: flex; gap: 0.8em; align-items: flex-start; padding: 0.75em 0; border-top: 1px solid rgba(255,255,255,0.07); }
.je-ops-item:first-of-type { border-top: 0; }
.je-ops-icon { flex: 0 0 auto; width: 2.2em; height: 2.2em; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; background: rgba(255,255,255,0.06); }
.je-ops-item-body { flex: 1 1 auto; min-width: 0; }
.je-ops-item-title { font-weight: 700; overflow-wrap: anywhere; }
.je-ops-item-sub { font-size: 0.88em; opacity: 0.8; margin-top: 0.15em; overflow-wrap: anywhere; }
.je-ops-fixes { display: flex; flex-wrap: wrap; gap: 0.4em; justify-content: flex-end; flex: 0 0 auto; max-width: 50%; }
.je-ops-btn { font: inherit; font-size: 0.9em; font-weight: 600; display: inline-flex; align-items: center; gap: 0.3em; min-height: 2.4em; padding: 0.25em 0.8em;
  border-radius: 8px; border: 1px solid rgba(255,255,255,0.22); background: rgba(255,255,255,0.06); color: inherit; cursor: pointer; text-decoration: none; }
.je-ops-btn:hover { background: rgba(255,255,255,0.12); }
.je-ops-btn[aria-disabled="true"], .je-ops-btn:disabled { opacity: 0.55; cursor: default; }
.je-ops-btn .material-icons { font-size: 1.15em; }
.je-ops-btn-primary { background: #6d4ed8; border-color: #7c5ce6; color: #fff; }
.je-ops-btn-danger { background: rgba(229,57,53,0.18); border-color: #e53935; }
.je-ops-btn:focus-visible, .layout-tv .je-ops-btn:focus, .je-ops-link:focus-visible { outline: 3px solid #fff; outline-offset: 2px; }
.je-ops-link { font: inherit; background: none; border: 0; padding: 0; color: #b39ddb; cursor: pointer; text-decoration: underline; font-size: 0.88em; }
.je-ops-side { display: flex; flex-direction: column; gap: 1em; }
.je-ops-upcoming { padding: 0.45em 0; border-top: 1px solid rgba(255,255,255,0.07); font-size: 0.92em; }
.je-ops-upcoming:first-of-type { border-top: 0; }
.je-ops-kv { display: flex; justify-content: space-between; padding: 0.3em 0; font-size: 0.92em; }
.je-ops-spark { display: flex; align-items: center; gap: 1em; flex-wrap: wrap; }
.je-ops-spark svg { max-width: 100%; }
.je-ops-legend { display: flex; gap: 1em; font-size: 0.85em; }
.je-ops-legend span::before { content: ''; display: inline-block; width: 1em; height: 2px; vertical-align: middle; margin-right: 0.35em; background: currentColor; }
.je-ops-grabs { color: #64b5f6; }
.je-ops-imports { color: #f06292; }
.je-ops-dl { display: flex; gap: 0.8em; align-items: flex-start; padding: 0.8em 0; border-top: 1px solid rgba(255,255,255,0.07); }
.je-ops-dl:first-of-type { border-top: 0; }
.je-ops-dl-body { flex: 1 1 auto; min-width: 0; }
.je-ops-dl-actions { display: flex; flex-wrap: wrap; gap: 0.4em; margin-top: 0.5em; }
.je-ops-msg { font-size: 0.85em; color: #ffcc80; margin-top: 0.25em; overflow-wrap: anywhere; }
.je-ops-table { width: 100%; border-collapse: collapse; font-size: 0.9em; }
.je-ops-table th, .je-ops-table td { text-align: left; padding: 0.4em 0.5em; border-top: 1px solid rgba(255,255,255,0.07); vertical-align: top; overflow-wrap: break-word; }
.je-ops-table .je-ops-wrap { overflow-wrap: anywhere; }
.je-ops-table th { font-weight: 600; opacity: 0.75; border-top: 0; }
.je-ops-section { margin: 0 0 1.2em; }
.je-ops-section h3 { font-size: 1.05em; margin: 0 0 0.5em; }
.je-ops-path { font-family: monospace; font-size: 0.9em; overflow-wrap: anywhere; }
.je-ops-dialog-overlay { position: fixed; inset: 0; z-index: 10600; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; padding: 1em; }
.je-ops-dialog { background: #202124; color: #fff; border-radius: 12px; max-width: 34em; width: 100%; padding: 1.2em 1.3em; box-shadow: 0 10px 40px rgba(0,0,0,0.5); max-height: 90vh; overflow: auto; }
.je-ops-dialog h2 { margin: 0 0 0.6em; font-size: 1.2em; }
.je-ops-dialog p { margin: 0.4em 0; line-height: 1.4; }
.je-ops-dialog label { display: flex; gap: 0.5em; align-items: center; margin: 0.5em 0; min-height: 2.4em; }
.je-ops-dialog input[type="text"] { font: inherit; width: 100%; padding: 0.5em; border-radius: 6px; border: 1px solid rgba(255,255,255,0.3); background: rgba(255,255,255,0.06); color: inherit; }
.je-ops-dialog-buttons { display: flex; flex-wrap: wrap; gap: 0.5em; justify-content: flex-end; margin-top: 1em; }
.je-ops-warnbox { padding: 0.6em 0.8em; border-radius: 8px; background: rgba(229,57,53,0.14); border-left: 3px solid #e53935; }
@media (max-width: 900px) { .je-ops-grid { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 600px) {
  .je-ops-item { flex-wrap: wrap; }
  .je-ops-fixes { max-width: 100%; flex-basis: 100%; justify-content: flex-start; }
  .je-ops-btn { min-height: 2.75em; }
  .je-ops-table thead { display: none; }
  .je-ops-table tr { display: block; padding: 0.5em 0; border-top: 1px solid rgba(255,255,255,0.07); }
  .je-ops-table td { display: block; border: 0; padding: 0.1em 0.3em; }
  .je-ops-dialog-overlay { align-items: flex-end; padding: 0; }
  .je-ops-dialog { border-radius: 12px 12px 0 0; }
}
.layout-tv .je-ops-btn { min-height: 3em; font-size: 1em; }
`;

    /**
     * Adds the admin tab styles once.
     * @returns {void}
     */
    function injectAdminStyles() {
        if (document.getElementById('je-arr-ops-styles')) return;
        const style = document.createElement('style');
        style.id = 'je-arr-ops-styles';
        style.textContent = CSS;
        document.head.appendChild(style);
    }

    JE.internals = JE.internals || {};
    JE.internals.arrHub = JE.internals.arrHub || {};
    JE.internals.arrHub.admin = JE.internals.arrHub.admin || {};
    JE.internals.arrHub.admin.injectStyles = injectAdminStyles;
})(window.JellyfinEnhanced);
