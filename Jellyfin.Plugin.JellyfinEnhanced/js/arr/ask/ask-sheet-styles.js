/**
 * @file Requests & downloads, phase 3: styles for the request sheet (a bottom sheet on phones, a
 * centred dialog on desktop, a full-screen panel on TV), the smart actions on details pages (Get
 * Season N, Get missing episodes, More…, Get 4K), the collection-gaps block and the mountable
 * request controls. Targets are at least 44 px on phones and TV, focus rings are always visible,
 * and colour is never the only signal (icon and words). Exposes JE.internals.arrAskSheetStyles.
 */
(function (JE) {
    'use strict';

    const CSS = `
.je-sheet-shell-backdrop, .je-sheet-backdrop { position: fixed; inset: 0; z-index: 12000; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; padding: 1em; }
.je-sheet, .je-sheet-shell { position: relative; background: #202124; color: #eee; border-radius: 14px; width: 100%; max-width: 32em; max-height: 90vh; overflow: auto;
  padding: 1.1em 1.3em 1.2em; box-shadow: 0 10px 40px rgba(0,0,0,0.55); box-sizing: border-box; }
.je-sheet-busy { display: flex; align-items: center; gap: 0.7em; padding: 0.6em 0 0.2em; opacity: 0.8; }
.je-sheet-busy::before { content: ''; width: 1.1em; height: 1.1em; border-radius: 50%; border: 2px solid rgba(127,127,127,0.45); border-top-color: currentColor; animation: je-sheet-spin 0.8s linear infinite; flex: none; }
@keyframes je-sheet-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .je-sheet-busy::before { animation: none; } }
.je-sheet-handle { display: none; width: 3em; height: 4px; border-radius: 2px; background: rgba(255,255,255,0.3); margin: 0 auto 0.9em; }
.je-sheet-head { display: flex; gap: 0.9em; align-items: center; margin-bottom: 1em; }
.je-sheet-poster { width: 3.4em; height: 5.1em; border-radius: 6px; object-fit: cover; background: rgba(127,127,127,0.25); flex: none; }
.je-sheet-title { margin: 0; font-size: 1.35em; line-height: 1.25; overflow-wrap: anywhere; }
.je-sheet-facts { opacity: 0.75; margin-top: 0.2em; }
.je-sheet-variant { display: flex; gap: 0.5em; margin: 0 0 0.9em; }
.je-sheet-variant-label { align-self: center; opacity: 0.75; margin-right: 0.3em; }
.je-sheet-cards { display: flex; flex-direction: column; gap: 0.6em; }
.je-sheet-card { display: flex; align-items: center; gap: 0.8em; width: 100%; text-align: left; font: inherit; color: inherit; cursor: pointer;
  background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.18); border-radius: 12px; padding: 0.75em 1em; min-height: 3.4em; box-sizing: border-box; }
.je-sheet-card:hover { background: rgba(255,255,255,0.08); }
.je-sheet-card[aria-pressed="true"] { border: 2px solid #8b5cf6; background: rgba(139,92,246,0.16); padding: calc(0.75em - 1px) calc(1em - 1px); }
.je-sheet-card-icon { font-size: 1.6em; opacity: 0.9; }
.je-sheet-card-body { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.je-sheet-card-label { font-weight: 700; font-size: 1.05em; }
.je-sheet-card-cost { opacity: 0.8; font-size: 0.9em; margin-top: 0.15em; }
.je-sheet-card-cost.je-sheet-over { color: #f5b041; opacity: 1; }
.je-sheet-card-mark { font-size: 1.4em; opacity: 0.8; }
.je-sheet-panel { margin: 0.2em 0 0.4em; padding: 0.4em 0.2em 0.2em 0.6em; border-left: 2px solid rgba(139,92,246,0.6); }
.je-sheet-panel[hidden] { display: none; }
.je-sheet-check { display: flex; align-items: center; gap: 0.7em; min-height: 44px; cursor: pointer; }
.je-sheet-check input { width: 1.3em; height: 1.3em; margin: 0; accent-color: #8b5cf6; }
.je-sheet-check-facts { opacity: 0.7; font-size: 0.9em; }
.je-sheet-check-disabled { opacity: 0.55; cursor: default; }
.je-sheet-seasons, .je-sheet-episodes { display: flex; flex-wrap: wrap; gap: 0.4em; margin: 0.3em 0 0.5em; }
.je-sheet-toggle { font: inherit; color: inherit; cursor: pointer; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.22); border-radius: 999px;
  min-height: 2.6em; min-width: 2.9em; padding: 0.2em 0.9em; }
.je-sheet-toggle[aria-pressed="true"] { background: #6d4aff; border-color: #8b5cf6; color: #fff; }
.je-sheet-note { display: flex; gap: 0.6em; align-items: flex-start; margin: 1em 0 0; padding: 0.75em 1em; border-radius: 10px; font-weight: 600; line-height: 1.35; }
.je-sheet-note-icon { font-size: 1.3em; }
.je-sheet-note-attention { border: 1px solid rgba(245,158,11,0.6); background: rgba(245,158,11,0.12); color: #f5b041; }
.je-sheet-note-info { border: 1px solid rgba(192,132,252,0.45); background: rgba(192,132,252,0.10); }
.je-sheet-message { margin: 0.8em 0 0; min-height: 1.2em; font-weight: 600; }
.je-sheet-message:empty { display: none; }
.je-sheet-message.je-sheet-message-attention { color: #f5b041; }
.je-sheet-actions { display: flex; flex-direction: column; gap: 0.5em; margin-top: 1em; }
.je-sheet-primary { display: inline-flex; align-items: center; justify-content: center; gap: 0.5em; width: 100%; font: inherit; font-weight: 700; font-size: 1.05em;
  color: #fff; cursor: pointer; border: 0; border-radius: 12px; min-height: 3.1em; padding: 0.4em 1em; background: linear-gradient(90deg, #4f46e5, #7c3aed); }
.je-sheet-primary[disabled] { opacity: 0.7; cursor: progress; }
.je-sheet-primary[hidden] { display: none; }
.je-sheet-secondary { font: inherit; color: inherit; cursor: pointer; background: transparent; border: 0; border-radius: 10px; min-height: 2.9em; padding: 0.3em 1em; font-weight: 600; opacity: 0.85; }
.je-sheet-card:focus-visible, .je-sheet-toggle:focus-visible, .je-sheet-primary:focus-visible, .je-sheet-secondary:focus-visible, .je-sheet-check input:focus-visible,
.layout-tv .je-sheet-card:focus, .layout-tv .je-sheet-toggle:focus, .layout-tv .je-sheet-primary:focus, .layout-tv .je-sheet-secondary:focus, .layout-tv .je-sheet-check input:focus
  { outline: 3px solid #fff; outline-offset: 2px; }
.je-sheet-tv { padding: 0; }
.je-sheet-tv .je-sheet, .je-sheet-tv .je-sheet-shell { max-width: none; width: 100%; height: 100%; max-height: none; border-radius: 0; padding: 2em 4em; font-size: 1.15em; }
.je-sheet-tv .je-sheet-actions { flex-direction: row-reverse; justify-content: flex-start; }
.je-sheet-tv .je-sheet-primary { width: auto; min-width: 16em; }
.je-sheet-light .je-sheet, .je-sheet-light .je-sheet-shell { background: #fff; color: #202124; box-shadow: 0 10px 40px rgba(0,0,0,0.3); }
.je-sheet-light .je-sheet-handle { background: rgba(0,0,0,0.3); }
.je-sheet-light .je-sheet-card { background: rgba(0,0,0,0.03); border-color: rgba(0,0,0,0.22); }
.je-sheet-light .je-sheet-card:hover { background: rgba(0,0,0,0.06); }
.je-sheet-light .je-sheet-card[aria-pressed="true"] { background: rgba(109,74,255,0.10); border-color: #6d4aff; }
.je-sheet-light .je-sheet-toggle { background: rgba(0,0,0,0.04); border-color: rgba(0,0,0,0.25); }
.je-sheet-light .je-sheet-toggle[aria-pressed="true"] { background: #6d4aff; border-color: #6d4aff; color: #fff; }
.je-sheet-light .je-sheet-note-attention, .je-sheet-light .je-sheet-card-cost.je-sheet-over, .je-sheet-light .je-sheet-message.je-sheet-message-attention { color: #8a5a00; }
.je-sheet-light .je-sheet-card:focus-visible, .je-sheet-light .je-sheet-toggle:focus-visible, .je-sheet-light .je-sheet-primary:focus-visible,
.je-sheet-light .je-sheet-secondary:focus-visible, .je-sheet-light .je-sheet-check input:focus-visible { outline-color: #202124; }

.je-ask-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 0.6em; margin: 0 0 1em; }
.je-ask-action { display: inline-flex; align-items: center; gap: 0.4em; font: inherit; font-weight: 700; font-size: 0.95em; cursor: pointer; color: #fff;
  border-radius: 8px; border: 1px solid #7c5cff; background: #6d4aff; min-height: 2.6em; padding: 0.25em 1em; }
.je-ask-action:hover { background: #7d5dff; }
.je-ask-action-secondary { background: transparent; color: inherit; border-color: rgba(255,255,255,0.35); }
.je-ask-action-secondary:hover { background: rgba(255,255,255,0.08); }
.je-ask-action[disabled] { opacity: 0.75; cursor: progress; }
.je-ask-action.je-ask-mount-paused { background: rgba(245,158,11,0.12); border-color: rgba(245,158,11,0.6); color: #f5b041; }
.je-ask-action.je-ask-mount-paused:hover { background: rgba(245,158,11,0.2); }
.je-ask-light .je-ask-action.je-ask-mount-paused { color: #8a5a00; }
.je-ask-action-icon { font-size: 1.2em; }
.je-ask-action:focus-visible, .layout-tv .je-ask-action:focus { outline: 3px solid #fff; outline-offset: 2px; }
.je-ask-action-cost { opacity: 0.75; font-size: 0.85em; }
.je-ask-actions .je-arr-chip { margin-left: 0; min-height: 2.2em; font-size: 0.9em; }
.je-ask-light .je-ask-action-secondary { border-color: rgba(0,0,0,0.4); }
.je-ask-light .je-ask-action-secondary:hover { background: rgba(0,0,0,0.06); }
.je-ask-light .je-ask-action:focus-visible { outline-color: #202124; }

.je-ask-coll { margin: 0 0 1.2em; padding: 0.8em 1em; border-radius: 10px; border: 1px solid rgba(139,92,246,0.45); background: rgba(139,92,246,0.08); max-width: 52em; }
.je-ask-coll-head { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5em 1em; }
.je-ask-coll-have { font-weight: 700; display: inline-flex; align-items: center; gap: 0.4em; }
.je-ask-coll-cost { opacity: 0.8; font-size: 0.9em; }
.je-ask-coll-list { list-style: none; margin: 0.6em 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: 0.4em 0.9em; }
.je-ask-coll-part { display: inline-flex; align-items: center; gap: 0.4em; }
.je-ask-coll-part .je-arr-chip { margin-left: 0; }
.je-ask-coll-summary { margin-top: 0.5em; font-weight: 600; }
.je-ask-coll-summary:empty { display: none; }

.je-ask-mount-row { display: flex; flex-wrap: wrap; align-items: center; gap: 0.6em; }
.je-ask-mount-row .je-notify-modal-actions { margin: 0; }
.je-ask-mount-row .je-arr-chip { margin-left: 0; min-height: 2.2em; font-size: 0.9em; }

@media (max-width: 600px) {
  .je-sheet-backdrop, .je-sheet-shell-backdrop { align-items: flex-end; padding: 0; }
  .je-sheet, .je-sheet-shell { border-radius: 18px 18px 0 0; max-height: 88vh; max-width: none; padding: 0.7em 1em 1.2em; }
  .je-sheet-handle { display: block; }
  .je-sheet-card, .je-sheet-toggle, .je-sheet-secondary { min-height: 44px; }
  .je-sheet-toggle { min-width: 44px; }
  .je-ask-action { min-height: 44px; min-width: 44px; }
  .je-ask-actions .je-ask-action { flex: 1 1 auto; justify-content: center; }
}
.layout-tv .je-ask-action { min-height: 48px; font-size: 1em; padding: 0.3em 1.2em; }
.layout-tv .je-sheet-toggle, .layout-tv .je-sheet-card { min-height: 48px; }
`;

    /**
     * Injects the request-sheet styles once.
     * @returns {void}
     */
    function ensure() {
        if (document.getElementById('je-arr-ask-sheet-styles')) return;
        if (JE.helpers?.addCSS) {
            JE.helpers.addCSS('je-arr-ask-sheet-styles', CSS);
            return;
        }
        const style = document.createElement('style');
        style.id = 'je-arr-ask-sheet-styles';
        style.textContent = CSS;
        document.head.appendChild(style);
    }

    /**
     * True when the page uses a light theme: Jellyfin's themes set the body's text colour, and a
     * light theme writes dark text (no theme class to rely on).
     * @returns {boolean} Light theme.
     */
    function isLight() {
        try {
            const color = getComputedStyle(document.body).color || '';
            const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(color);
            if (!m) return false;
            const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
            return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5;
        } catch {
            return false;
        }
    }

    JE.internals = JE.internals || {};
    JE.internals.arrAskSheetStyles = { ensure, isLight, CSS };
})(window.JellyfinEnhanced);
