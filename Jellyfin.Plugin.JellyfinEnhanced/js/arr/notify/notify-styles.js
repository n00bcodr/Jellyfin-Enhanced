/**
 * @file Requests & downloads, phase 2: styles of the bell, inbox panel, toasts, Notify me / Remind
 * buttons and the "Requests & alerts" settings, and JE.initializeArrNotify, which starts them when
 * notifications are on (called by the status bootstrap, JE.initializeArrStatus).
 */
(function (JE) {
    'use strict';

    const N = (JE.internals = JE.internals || {}).arrNotify = JE.internals.arrNotify || {};

    const CSS = `
.je-notify-bell { position: relative; }
.je-notify-badge { position: absolute; top: 2px; right: 0; min-width: 18px; height: 18px; padding: 0 5px; box-sizing: border-box; border-radius: 9px; background: #6c5ce7; color: #fff; font-size: 11px; font-weight: 700; line-height: 18px; text-align: center; pointer-events: none; }
.je-notify-badge[hidden] { display: none; }
.je-notify-panel { position: fixed; z-index: 10600; width: min(440px, calc(100vw - 16px)); max-height: min(70vh, 640px); display: flex; flex-direction: column; background: var(--jf-palette-background-paper, #202020); color: var(--jf-palette-text-primary, #fff); border: 1px solid rgba(255,255,255,.12); border-radius: 10px; box-shadow: 0 12px 40px rgba(0,0,0,.55); outline: none; }
.je-notify-head { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-bottom: 1px solid rgba(255,255,255,.1); }
.je-notify-title { margin: 0; font-size: 1.05em; font-weight: 700; flex: 1; }
.je-notify-new { padding: 2px 9px; border-radius: 10px; background: rgba(108,92,231,.25); border: 1px solid rgba(108,92,231,.6); color: #cfc8ff; font-size: .8em; font-weight: 600; }
.je-notify-markall, .je-notify-more, .je-notify-settings { background: none; border: none; color: rgba(255,255,255,.75); cursor: pointer; font: inherit; font-size: .85em; padding: 6px 8px; border-radius: 6px; min-height: 32px; }
.je-notify-markall:disabled { opacity: .4; cursor: default; }
.je-notify-markall:not(:disabled):hover, .je-notify-more:hover, .je-notify-settings:hover { background: rgba(255,255,255,.08); color: #fff; }
.je-notify-list { overflow-y: auto; flex: 1; }
.je-notify-item { position: relative; display: flex; align-items: center; gap: 10px; padding: 10px 14px 10px 24px; border-bottom: 1px solid rgba(255,255,255,.06); }
.je-notify-dot { position: absolute; left: 10px; top: 50%; width: 7px; height: 7px; margin-top: -3px; border-radius: 50%; background: transparent; }
.je-notify-unread .je-notify-dot { background: #8f84ff; }
.je-notify-poster { width: 40px; height: 60px; flex: 0 0 40px; border-radius: 4px; object-fit: cover; background: rgba(255,255,255,.06); display: inline-flex; align-items: center; justify-content: center; }
.je-notify-poster-empty .material-icons { font-size: 22px; opacity: .7; }
.je-notify-body { flex: 1; min-width: 0; background: none; border: none; color: inherit; font: inherit; text-align: left; cursor: pointer; padding: 4px; border-radius: 6px; min-height: 44px; }
.je-notify-body:hover { background: rgba(255,255,255,.05); }
.je-notify-text { line-height: 1.35; overflow-wrap: anywhere; }
.je-notify-unread .je-notify-text { color: #fff; }
.je-notify-item:not(.je-notify-unread) .je-notify-text { color: rgba(255,255,255,.75); }
.je-notify-time { margin-top: 3px; font-size: .8em; color: rgba(255,255,255,.55); }
.je-notify-play { display: inline-flex; align-items: center; gap: 4px; padding: 6px 12px; min-height: 36px; border: none; border-radius: 6px; background: #6c5ce7; color: #fff; font: inherit; font-size: .85em; font-weight: 600; cursor: pointer; flex-shrink: 0; }
.je-notify-play .material-icons { font-size: 18px; }
.je-notify-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.je-notify-main .je-notify-body { flex: none; }
.je-notify-digest-actions { display: flex; flex-wrap: wrap; gap: 6px; padding: 2px 4px 0; }
.je-notify-digest-open, .je-notify-digest-toggle { display: inline-flex; align-items: center; gap: 4px; min-height: 36px; padding: 6px 10px; border: 1px solid rgba(255,255,255,.2); border-radius: 6px; background: rgba(255,255,255,.06); color: inherit; font: inherit; font-size: .85em; cursor: pointer; }
.je-notify-digest-open .material-icons { font-size: 16px; }
.je-notify-digest-open:hover, .je-notify-digest-toggle:hover { background: rgba(255,255,255,.12); }
.je-notify-digest-list { margin: 6px 4px 2px; padding: 6px 8px 6px 22px; max-height: 12em; overflow-y: auto; border-radius: 6px; background: rgba(255,255,255,.05); font-size: .85em; line-height: 1.4; color: rgba(255,255,255,.8); overflow-wrap: anywhere; }
.je-notify-digest-list[hidden] { display: none; }
.je-notify-digest-list li + li { margin-top: 3px; }
.je-notify-digest-more { list-style: none; margin-left: -14px; opacity: .75; }
@media (max-width: 600px) { .je-notify-digest-open, .je-notify-digest-toggle { min-height: 44px; } }
.je-notify-empty { padding: 28px 16px; text-align: center; color: rgba(255,255,255,.6); }
.je-notify-more { display: block; width: 100%; padding: 10px; }
.je-notify-foot { display: flex; align-items: center; gap: 8px; padding: 8px 10px 8px 14px; border-top: 1px solid rgba(255,255,255,.1); font-size: .82em; color: rgba(255,255,255,.65); }
.je-notify-foot-text { flex: 1; display: inline-flex; align-items: center; gap: 6px; }
.je-notify-foot-text .material-icons { font-size: 16px; }
.je-notify-settings .material-icons { font-size: 20px; }
.je-notify-toasts { position: fixed; right: 16px; bottom: 16px; z-index: 9999990; display: flex; flex-direction: column; gap: 8px; max-width: min(420px, calc(100vw - 32px)); pointer-events: none; }
.je-notify-toast { pointer-events: auto; display: flex; align-items: center; gap: 8px; padding: 10px 10px 10px 14px; background: var(--jf-palette-background-paper, #262626); color: #fff; border: 1px solid rgba(255,255,255,.14); border-left: 3px solid #6c5ce7; border-radius: 8px; box-shadow: 0 8px 28px rgba(0,0,0,.5); animation: je-notify-in .18s ease-out; }
.je-notify-toast-text { flex: 1; background: none; border: none; color: inherit; font: inherit; text-align: left; cursor: pointer; padding: 2px; line-height: 1.35; }
.je-notify-toast-play { padding: 6px 10px; border: none; border-radius: 6px; background: #6c5ce7; color: #fff; font: inherit; font-size: .85em; font-weight: 600; cursor: pointer; }
.je-notify-toast-close { width: 28px; height: 28px; border: none; border-radius: 50%; background: rgba(255,255,255,.08); color: #fff; cursor: pointer; font-size: 16px; line-height: 1; }
@keyframes je-notify-in { from { transform: translateY(8px); opacity: 0; } to { transform: none; opacity: 1; } }
.je-notify-follow-details.je-notify-following .detailButton-icon { color: #a29bfe; }
.je-notify-chip { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; min-height: 36px; border: 1px solid rgba(255,255,255,.25); border-radius: 18px; background: rgba(255,255,255,.06); color: inherit; font: inherit; font-size: .9em; cursor: pointer; }
.je-notify-chip .material-icons { font-size: 18px; }
.je-notify-chip.je-notify-following { border-color: rgba(108,92,231,.7); background: rgba(108,92,231,.18); }
.je-notify-chip[aria-busy="true"] { opacity: .6; }
.je-notify-modal-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: .5em 0 .2em; }
.je-notify-remind { display: inline-flex; align-items: center; gap: 6px; margin-top: .5em; padding: 6px 12px; min-height: 36px; border: 1px solid rgba(255,183,77,.6); border-radius: 18px; background: rgba(255,183,77,.12); color: inherit; font: inherit; font-size: .9em; cursor: pointer; }
.je-notify-remind[aria-disabled="true"] { cursor: default; opacity: .85; }
.je-notify-remind .material-icons { font-size: 18px; }
.je-arr-alerts h4 { margin: 14px 0 6px; font-size: 1em; }
.je-arr-alerts-intro, .je-arr-alerts-desc { font-size: 12px; color: rgba(255,255,255,.65); margin: 2px 0 6px; }
.je-arr-alerts-check { display: flex; align-items: flex-start; gap: 12px; padding: 8px 0; cursor: pointer; }
.je-arr-alerts-check input { width: 18px; height: 18px; margin-top: 2px; cursor: pointer; }
.je-arr-alerts-label { font-weight: 500; }
.je-arr-alerts-group { padding: 6px 12px 10px; margin-bottom: 10px; background: rgba(255,255,255,.04); border-radius: 6px; }
.je-arr-alerts-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 6px 0; }
.je-arr-alerts-input { padding: 8px 10px; min-height: 36px; box-sizing: border-box; border-radius: 6px; border: 1px solid rgba(255,255,255,.2); background: rgba(0,0,0,.3); color: #fff; font: inherit; min-width: 0; flex: 1 1 180px; }
.je-arr-alerts-time { flex: 0 0 auto; }
.je-arr-alerts-code { flex: 0 0 110px; letter-spacing: .2em; }
.je-arr-alerts-btn { padding: 8px 14px; min-height: 36px; border: none; border-radius: 6px; background: rgba(255,255,255,.12); color: #fff; font: inherit; cursor: pointer; }
.je-arr-alerts-btn:hover { background: rgba(255,255,255,.2); }
.je-arr-alerts-topic { padding: 1px 6px; border-radius: 4px; background: rgba(255,255,255,.1); user-select: all; overflow-wrap: anywhere; }
.je-arr-alerts-link { display: inline-block; margin: 2px 0 6px; color: #a29bfe; }
.je-arr-alerts-note { margin: 8px 0; padding: 8px 10px; border-radius: 6px; background: rgba(108,92,231,.18); font-size: 13px; }
@media (max-width: 600px) {
  .je-notify-panel { left: 0 !important; right: 0 !important; top: auto !important; bottom: 0; width: 100vw; max-height: 85vh; border-radius: 14px 14px 0 0; }
  .je-notify-toasts { left: 8px; right: 8px; bottom: 8px; max-width: none; }
  .je-notify-markall, .je-notify-more, .je-notify-settings, .je-notify-play,
  .je-notify-chip, .je-notify-remind { min-height: 44px; min-width: 44px; }
}
.layout-tv .je-notify-panel button:focus, .layout-tv .je-notify-chip:focus, .layout-tv .je-notify-remind:focus, .je-notify-panel button:focus-visible, .je-notify-chip:focus-visible, .je-notify-remind:focus-visible, .je-notify-toast button:focus-visible { outline: 3px solid #a29bfe; outline-offset: 2px; }
`;

    /**
     * Injects the styles once.
     * @returns {void}
     */
    function ensure() {
        if (document.getElementById('je-arr-notify-styles')) return;
        if (JE.helpers?.addCSS) {
            JE.helpers.addCSS('je-arr-notify-styles', CSS);
            return;
        }
        const style = document.createElement('style');
        style.id = 'je-arr-notify-styles';
        style.textContent = CSS;
        document.head.appendChild(style);
    }

    /**
     * Starts notifications on this page (no-op while they are off).
     * @returns {void}
     */
    function initializeArrNotify() {
        if (!JE.arrNotify?.enabled()) return;
        ensure();
        JE.arrNotify.start();
        N.initializeBell?.();
        N.checkSettingsHash?.();
        JE.core?.navigation?.onNavigate?.(() => N.checkSettingsHash?.());
    }

    JE.session?.onUserChange?.('arr-notify-start', () => {
        // A new user: start again for them once their configuration is known.
        setTimeout(() => { if (JE.arrNotify?.enabled()) { JE.arrNotify.start(); N.initializeBell?.(); } }, 1000);
    });

    N.ensureStyles = ensure;
    N.CSS = CSS;
    JE.initializeArrNotify = initializeArrNotify;
})(window.JellyfinEnhanced);
