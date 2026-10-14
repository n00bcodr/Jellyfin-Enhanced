/**
 * @file Requests & downloads, phase 1: styles for the status pill, journey strip, admin lines,
 * poster badges, episode chips and the season banner. Colour is never the only signal: every
 * state also has an icon and words. Phone (≤ 600 px) and TV layouts are handled here.
 */
(function (JE) {
    'use strict';

    const CSS = `
.je-arr-status { margin: 0.2em 0 1em; max-width: 52em; }
.je-arr-status .je-arr-pill { --je-arr-tone: #9aa0a6; }
.je-arr-pill { display: inline-flex; align-items: center; gap: 0.4em; padding: 0.3em 0.9em; border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--je-arr-tone, #9aa0a6) 70%, transparent);
  background: color-mix(in srgb, var(--je-arr-tone, #9aa0a6) 16%, transparent);
  color: color-mix(in srgb, var(--je-arr-tone, #9aa0a6) 60%, #fff); font: inherit; font-weight: 600; font-size: 0.95em;
  line-height: 1.3; min-height: 2.2em; max-width: 100%; text-align: left; cursor: default; }
button.je-arr-pill { cursor: pointer; }
button.je-arr-pill:focus-visible, .layout-tv button.je-arr-pill:focus { outline: 3px solid #fff; outline-offset: 2px; }
.je-arr-pill-icon { font-size: 1.15em; }
.je-arr-pill-caret { font-size: 1.1em; transition: transform 0.15s; }
.je-arr-open .je-arr-pill-caret { transform: rotate(180deg); }
.je-arr-pill-text { overflow-wrap: anywhere; }
.je-arr-pill-small { font-size: 0.85em; min-height: 2em; padding: 0.2em 0.75em; }
.je-arr-summary-row { display: flex; flex-wrap: wrap; gap: 0.5em; }
.je-arr-tone-ready { --je-arr-tone: #52b54b; }
.je-arr-tone-downloading { --je-arr-tone: #4a9eff; }
.je-arr-tone-almostReady { --je-arr-tone: #a78bfa; }
.je-arr-tone-looking { --je-arr-tone: #b8bcc2; }
.je-arr-tone-notOut { --je-arr-tone: #e5a00d; }
.je-arr-tone-asked, .je-arr-tone-approved { --je-arr-tone: #c084fc; }
.je-arr-stale-note { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5em 1em; padding: 0.5em 1em; margin: 0 0 1em;
  border-radius: 8px; background: rgba(245,158,11,0.10); border-left: 3px solid #f59e0b; }
.je-arr-stale-retry { font: inherit; color: inherit; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.25);
  border-radius: 6px; padding: 0.35em 1em; min-height: 2.75em; min-width: 2.75em; cursor: pointer; }
.je-arr-stale-retry:focus-visible, .layout-tv .je-arr-stale-retry:focus { outline: 3px solid #fff; outline-offset: 2px; }
.je-arr-tone-attention { --je-arr-tone: #f59e0b; }
.je-arr-tone-notHere, .je-arr-tone-none { --je-arr-tone: #8a8f96; }
.je-arr-tone-partial { --je-arr-tone: #818cf8; }
.je-arr-progress { height: 3px; max-width: 26em; margin-top: 0.45em; border-radius: 3px; background: rgba(255,255,255,0.15); overflow: hidden; }
.je-arr-progress-fill { height: 100%; background: #4a9eff; transition: width 0.4s ease; }
.je-arr-journey { list-style: none; display: flex; flex-wrap: wrap; gap: 0; margin: 0.8em 0 0; padding: 0; }
.je-arr-journey[hidden] { display: none; }
.je-arr-stop { position: relative; display: flex; flex-direction: column; min-width: 7em; padding: 0 1.2em 0 0; }
.je-arr-stop::before { content: ''; position: absolute; top: 0.4em; left: 0.8em; right: 0; height: 2px; background: rgba(255,255,255,0.18); }
.je-arr-stop:last-child::before { display: none; }
.je-arr-stop-done::before, .je-arr-stop-current::before { background: #8b5cf6; }
.je-arr-stop-current::before { background: linear-gradient(90deg, #8b5cf6, rgba(255,255,255,0.18)); }
.je-arr-dot { position: relative; z-index: 1; width: 0.8em; height: 0.8em; border-radius: 50%; background: #5f6368; margin-bottom: 0.35em; }
.je-arr-stop-done .je-arr-dot { background: #8b5cf6; }
.je-arr-stop-current .je-arr-dot { background: #4a9eff; box-shadow: 0 0 0 3px rgba(74,158,255,0.35); }
.je-arr-stop-label { font-weight: 600; font-size: 0.85em; }
.je-arr-stop-next .je-arr-stop-label { opacity: 0.55; }
.je-arr-stop-current .je-arr-stop-label { color: #8ec5ff; }
.je-arr-stop-date { font-size: 0.75em; opacity: 0.7; }
.je-arr-admin { margin-top: 0.7em; display: flex; flex-direction: column; gap: 0.4em; }
.je-arr-admin-line { display: flex; gap: 0.5em; align-items: flex-start; padding: 0.45em 0.7em; border-radius: 6px;
  background: rgba(255,255,255,0.05); border-left: 3px solid #5f6368; font-size: 0.85em; }
.je-arr-admin-attention { border-left-color: #f59e0b; background: rgba(245,158,11,0.08); }
.je-arr-admin-icon { font-size: 1.2em; opacity: 0.8; }
.je-arr-admin-text { font-weight: 600; }
.je-arr-admin-detail { opacity: 0.8; font-family: monospace; font-size: 0.95em; overflow-wrap: anywhere; }
.je-arr-admin-fix { color: #8ec5ff; }
.je-arr-chip { display: inline-flex; align-items: center; margin-left: 0.6em; padding: 0.05em 0.6em; border-radius: 999px; font-size: 0.8em; font-weight: 600;
  border: 1px solid color-mix(in srgb, var(--je-arr-tone, #9aa0a6) 70%, transparent);
  background: color-mix(in srgb, var(--je-arr-tone, #9aa0a6) 16%, transparent);
  color: color-mix(in srgb, var(--je-arr-tone, #9aa0a6) 60%, #fff); white-space: nowrap; }
.je-arr-chip-row { margin: 0.4em 0 0.2em; }
.je-arr-chip-row .je-arr-chip { margin-left: 0; }
.je-arr-chip-overlay { position: absolute; left: 6px; bottom: 6px; z-index: 3; margin: 0; background: rgba(0,0,0,0.78); pointer-events: none; }
.je-arr-banner { display: flex; gap: 0.7em; align-items: center; margin: 0.5em 0 1em; padding: 0.7em 1em; border-radius: 8px;
  border: 1px solid rgba(229,160,13,0.45); background: rgba(229,160,13,0.07); }
.je-arr-banner-icon { color: #e5a00d; }
.je-arr-banner-body { display: flex; flex-wrap: wrap; gap: 0.4em; align-items: center; }
.je-arr-banner-title { font-weight: 600; margin-right: 0.3em; }
.je-arr-banner .je-arr-chip { margin-left: 0; }
.je-arr-badge { position: absolute; left: 6px; bottom: 6px; z-index: 3; display: flex; gap: 4px; align-items: center; pointer-events: none; }
.je-arr-badge-bottom-right { left: auto; right: 6px; }
.je-arr-badge-top-left { bottom: auto; top: 6px; }
.je-arr-badge-top-right { bottom: auto; top: 6px; left: auto; right: 6px; }
.je-arr-badge-raised { bottom: 34px; }
.je-arr-badge-chip { display: inline-flex; align-items: center; gap: 2px; padding: 1px 6px; border-radius: 999px; font-size: 11px; font-weight: 700;
  background: rgba(0,0,0,0.72); color: color-mix(in srgb, var(--je-arr-tone, #9aa0a6) 55%, #fff);
  border: 1px solid color-mix(in srgb, var(--je-arr-tone, #9aa0a6) 75%, transparent); line-height: 16px; }
.je-arr-badge-icon { font-size: 14px; }
.je-arr-ring { position: relative; width: 28px; height: 28px; display: inline-block; border-radius: 50%; background: rgba(0,0,0,0.72); }
.je-arr-ring svg { width: 100%; height: 100%; transform: rotate(-90deg); }
.je-arr-ring-track { fill: none; stroke: rgba(255,255,255,0.2); stroke-width: 4; }
.je-arr-ring-bar { fill: none; stroke: #4a9eff; stroke-width: 4; stroke-linecap: round; }
.je-arr-ring-text { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 9px; font-weight: 700; color: #fff; }
.je-arr-ring-busy svg { animation: je-arr-spin 1.6s linear infinite; }
@keyframes je-arr-spin { from { transform: rotate(-90deg); } to { transform: rotate(270deg); } }
@media (prefers-reduced-motion: reduce) { .je-arr-ring-busy svg { animation: none; } .je-arr-progress-fill { transition: none; } }
@media (max-width: 600px) {
  .je-arr-journey { flex-direction: column; gap: 0.5em; }
  .je-arr-stop { flex-direction: row; align-items: center; gap: 0.5em; min-width: 0; padding: 0; }
  .je-arr-stop::before { display: none; }
  .je-arr-dot { margin-bottom: 0; flex: none; }
  .je-arr-pill { min-height: 44px; min-width: 44px; }
  .je-arr-stale-retry { min-height: 44px; min-width: 44px; }
  .je-arr-chip { margin-left: 0; margin-top: 0.25em; }
}
.layout-tv .je-arr-pill { font-size: 1.15em; min-height: 2.6em; }
.layout-tv .je-arr-ring { width: 48px; height: 48px; }
.layout-tv .je-arr-ring-text { font-size: 13px; }
.layout-tv .je-arr-badge-chip { font-size: 14px; line-height: 20px; }
.je-arr-modal-status { margin: 0.4em 0 0.8em; }
.je-arr-modal-status .je-arr-status { margin: 0; }
.je-arr-modal-status .je-arr-modal-manage { margin-top: 0.6em; }
`;

    /**
     * Injects the status styles once.
     * @returns {void}
     */
    function ensure() {
        if (document.getElementById('je-arr-status-styles')) return;
        if (JE.helpers?.addCSS) {
            JE.helpers.addCSS('je-arr-status-styles', CSS);
            return;
        }
        const style = document.createElement('style');
        style.id = 'je-arr-status-styles';
        style.textContent = CSS;
        document.head.appendChild(style);
    }

    /**
     * Starts every status surface when "Requests & downloads" phase 1 is on (no-op otherwise).
     * @returns {void}
     */
    function initializeArrStatus() {
        if (!JE.arrStatus?.enabled()) return;
        ensure();
        if (typeof JE.initializeArrStatusDetails === 'function') JE.initializeArrStatusDetails();
        if (typeof JE.initializeArrStatusCards === 'function') JE.initializeArrStatusCards();
        if (typeof JE.initializeArrStatusModal === 'function') JE.initializeArrStatusModal();
        if (typeof JE.initializeArrHub === 'function') JE.initializeArrHub();
        // Phase 2: notifications (bell, Notify me, Remind, "Requests & alerts").
        if (typeof JE.initializeArrNotify === 'function') JE.initializeArrNotify();
    }

    JE.internals = JE.internals || {};
    JE.internals.arrStatusStyles = { ensure, CSS };
    JE.initializeArrStatus = initializeArrStatus;
})(window.JellyfinEnhanced);
