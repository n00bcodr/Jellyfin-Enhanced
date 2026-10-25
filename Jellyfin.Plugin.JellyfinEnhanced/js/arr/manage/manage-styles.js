/**
 * @file Requests & downloads, phase 1: styles of the administrator's Manage drawer: a drawer on the
 * right on desktop, a bottom sheet on phones (≤ 600 px), a full panel on TV; explanation card,
 * versions (with phase 3's "Add to {instance}" sheet), timelines and requests. Colour is never the only signal.
 */
(function (JE) {
    'use strict';

    const CSS = `
.je-manage-overlay { position: fixed; inset: 0; z-index: 10500; background: rgba(0,0,0,0.45); display: flex; justify-content: flex-end; }
.je-manage { width: min(30em, 100vw); height: 100%; overflow-y: auto; background: #181a1f; color: #e8eaed; box-shadow: -8px 0 24px rgba(0,0,0,0.5);
  padding: 1em 1.2em 2em; box-sizing: border-box; display: flex; flex-direction: column; gap: 0.9em; outline: none; }
.je-manage-head { display: flex; align-items: center; gap: 0.6em; }
.je-manage-title { flex: 1 1 auto; margin: 0; font-size: 1.15em; font-weight: 600; overflow-wrap: anywhere; }
.je-manage-close { font: inherit; background: none; border: 0; color: inherit; cursor: pointer; padding: 0.3em; border-radius: 50%; min-width: 2.75em; min-height: 2.75em; }
.je-manage-close:hover { background: rgba(255,255,255,0.1); }
.je-manage-chips { display: flex; flex-wrap: wrap; gap: 0.4em; }
.je-manage-chip { display: inline-flex; align-items: center; gap: 0.35em; padding: 0.15em 0.6em; border-radius: 999px; font-size: 0.8em;
  border: 1px solid rgba(255,255,255,0.2); background: rgba(255,255,255,0.05); }
.je-manage-chip-kind { font-weight: 700; display: inline-flex; width: 1.4em; height: 1.4em; align-items: center; justify-content: center; border-radius: 50%; background: rgba(255,255,255,0.15); font-size: 0.85em; }
.je-manage-chip-state { opacity: 0.7; }
.je-manage-live .je-manage-chip-state { color: #4ade80; opacity: 1; }
.je-manage-live .je-manage-chip-state::before { content: '●'; margin-right: 0.25em; }
.je-manage-tabs { display: flex; gap: 1em; border-bottom: 1px solid rgba(255,255,255,0.12); }
.je-manage-tab { padding: 0.4em 0.1em; font-weight: 600; font-size: 0.9em; border-bottom: 2px solid #8b5cf6; }
.je-manage-card { padding: 0.8em; border-radius: 10px; border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.03); }
.je-manage-attention { border-color: rgba(245,158,11,0.6); background: rgba(245,158,11,0.06); }
.je-manage-attention-text { color: #fbbf24; }
.je-manage-card .je-arr-status { margin: 0; }
.je-manage-section-title { margin: 0 0 0.5em; font-size: 0.8em; letter-spacing: 0.06em; text-transform: uppercase; opacity: 0.7; font-weight: 700; }
.je-manage-actions { display: flex; flex-wrap: wrap; gap: 0.5em; margin-top: 0.8em; }
.je-manage-download { margin-top: 0.9em; padding-top: 0.7em; border-top: 1px solid rgba(255,255,255,0.1); }
.je-manage-btn { font: inherit; font-size: 0.9em; font-weight: 600; display: inline-flex; align-items: center; gap: 0.35em; min-height: 2.6em; padding: 0.3em 0.9em;
  border-radius: 8px; border: 1px solid rgba(255,255,255,0.22); background: rgba(255,255,255,0.06); color: inherit; cursor: pointer; text-decoration: none; }
.je-manage-btn:hover { background: rgba(255,255,255,0.12); }
.je-manage-btn[disabled] { opacity: 0.6; cursor: progress; }
.je-manage-btn-primary { background: #5b3fd0; border-color: #7c5ce6; color: #fff; }
.je-manage-btn:focus-visible, .je-manage-close:focus-visible, .layout-tv .je-manage-btn:focus, .layout-tv .je-manage-close:focus { outline: 3px solid #fff; outline-offset: 2px; }
.je-manage-btn .material-icons { font-size: 1.15em; }
.je-manage-result { margin-top: 0.5em; font-size: 0.85em; color: #8ec5ff; }
.je-manage-result:empty { display: none; }
.je-manage-result-failed { color: #fca5a5; }
.je-manage-section { padding-top: 0.2em; }
.je-manage-version { padding: 0.55em 0; border-top: 1px solid rgba(255,255,255,0.08); display: flex; flex-direction: column; gap: 0.25em; }
.je-manage-version:first-of-type { border-top: 0; }
.je-manage-version-name { font-weight: 600; }
.je-manage-role { margin-left: 0.5em; font-size: 0.7em; padding: 0 0.4em; border-radius: 4px; border: 1px solid rgba(255,255,255,0.35); vertical-align: middle; }
.je-manage-version-state { font-size: 0.9em; }
.je-manage-version-facts { font-size: 0.8em; opacity: 0.75; }
.je-manage-version .je-manage-btn { align-self: flex-start; margin-top: 0.2em; }
.je-manage-path { font-family: monospace; font-size: 0.78em; opacity: 0.7; overflow-wrap: anywhere; }
.je-manage-timeline { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.45em; }
.je-manage-event { display: flex; gap: 0.6em; align-items: flex-start; }
.je-manage-event-icon { font-size: 1.15em; opacity: 0.8; margin-top: 0.05em; }
.je-manage-event-body { display: flex; flex-direction: column; gap: 0.1em; min-width: 0; }
.je-manage-event-label { font-weight: 600; font-size: 0.9em; overflow-wrap: anywhere; }
.je-manage-event-time { font-size: 0.75em; opacity: 0.7; }
.je-manage-event-detail { font-size: 0.8em; opacity: 0.85; overflow-wrap: anywhere; }
.je-manage-event-downloadFailed .je-manage-event-icon, .je-manage-event-warn .je-manage-event-icon { color: #f59e0b; }
.je-manage-event-inJellyfin .je-manage-event-icon { color: #52b54b; }
.je-manage-request { font-size: 0.85em; padding: 0.25em 0; }
.je-manage-empty { opacity: 0.7; font-size: 0.9em; padding: 0.5em 0; }
.je-manage-open .material-icons { font-size: 1.6em; }
.je-manage-add { margin-top: 0.4em; padding: 0.8em; border-radius: 10px; border: 1px solid rgba(139,92,246,0.55); background: rgba(139,92,246,0.08); display: flex; flex-direction: column; gap: 0.6em; }
.je-manage-add-title { margin: 0; font-size: 0.95em; font-weight: 700; }
.je-manage-add-field { display: flex; flex-direction: column; gap: 0.25em; font-size: 0.85em; }
.je-manage-add-field > span { font-weight: 600; opacity: 0.85; }
.je-manage-add select { font: inherit; font-size: 0.95em; min-height: 2.6em; padding: 0.3em 0.5em; border-radius: 8px; border: 1px solid rgba(255,255,255,0.25); background: #23262d; color: inherit; max-width: 100%; }
.je-manage-add select:focus-visible, .je-manage-add input:focus-visible { outline: 3px solid #fff; outline-offset: 2px; }
.je-manage-add-seasons { border: 0; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 0.3em 0.9em; font-size: 0.85em; }
.je-manage-add-seasons legend { font-weight: 600; opacity: 0.85; padding: 0; margin-bottom: 0.25em; width: 100%; }
.je-manage-add-season { display: inline-flex; align-items: center; gap: 0.35em; min-height: 2.2em; cursor: pointer; }
.je-manage-add-note { font-size: 0.85em; opacity: 0.9; }
.je-manage-add-warn { color: #fbbf24; }
.je-manage-add-message { font-size: 0.85em; color: #8ec5ff; }
.je-manage-add-message:empty { display: none; }
.je-manage-add-failed { color: #fca5a5; }
.je-manage-add .je-manage-actions { margin-top: 0.2em; }
.je-manage-add-conflict { padding: 0.8em; border: 1px solid #b59cf6; border-radius: 8px; display: flex; flex-direction: column; gap: 0.45em; font-size: 0.9em; overflow-wrap: anywhere; }
.je-manage-add-choice-root { font-family: monospace; }
.je-manage-add-confirm { padding-top: 0.6em; border-top: 1px solid rgba(255,255,255,0.2); display: flex; flex-direction: column; gap: 0.5em; }
.je-manage-add-conflict p { margin: 0; }
.je-manage-add-conflict .je-manage-btn { white-space: normal; text-align: start; max-width: 100%; }
@media (max-width: 600px) {
  .je-manage-overlay { align-items: flex-end; }
  .je-manage { width: 100vw; height: auto; max-height: 88vh; border-radius: 14px 14px 0 0; box-shadow: 0 -8px 24px rgba(0,0,0,0.5); }
  .je-manage-btn, .je-manage-close { min-height: 44px; min-width: 44px; }
  .je-manage-tab { display: inline-flex; align-items: center; min-height: 44px; min-width: 44px; }
  .je-manage-add select, .je-manage-add-season { min-height: 44px; }
}
.layout-tv .je-manage { width: 100vw; font-size: 1.1em; padding: 2em 6vw; }
@media (prefers-reduced-motion: reduce) { .je-manage { transition: none; } }
`;

    /**
     * Adds the drawer styles once.
     * @returns {void}
     */
    function injectManageStyles() {
        if (document.getElementById('je-arr-manage-styles')) return;
        const style = document.createElement('style');
        style.id = 'je-arr-manage-styles';
        style.textContent = CSS;
        document.head.appendChild(style);
    }

    JE.internals = JE.internals || {};
    JE.internals.arrManage = Object.assign(JE.internals.arrManage || {}, { injectStyles: injectManageStyles });
})(window.JellyfinEnhanced);
