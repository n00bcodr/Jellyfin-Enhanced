/**
 * @file Requests & downloads, phase 3: styles of the Approvals and Household tabs, the Cancel button
 * of My requests and the home chip bar. Phone-first cards (no wide tables), targets of at least
 * 44 px on phones (≤ 600 px) and TV, visible focus rings, nothing hover-only, colours readable on
 * the dark and the light theme (borders and tints follow the text colour; the green and amber words
 * of the Approvals tab take darker shades on a light theme, .je-approvals-light, for 4.5:1), and
 * colour never the only signal (every chip has an icon and words).
 */
(function (JE) {
    'use strict';

    const CSS = `
.je-approvals, .je-household { display: flex; flex-direction: column; gap: 0.9em; }
.je-approvals-toolbar { display: flex; flex-wrap: wrap; gap: 0.5em; align-items: center; }
.je-approvals-filter { font-weight: 600; }
.je-approvals-limit { font-size: 0.85em; opacity: 0.8; }
.je-approvals-list, .je-household-list { display: flex; flex-direction: column; gap: 0.9em; }
.je-approval, .je-household-person { padding: 0.9em; border-radius: 12px; background: rgba(128,128,128,0.08); border: 1px solid rgba(128,128,128,0.28);
  background: color-mix(in srgb, currentColor 5%, transparent);
  border: 1px solid color-mix(in srgb, currentColor 14%, transparent); display: flex; flex-direction: column; gap: 0.7em; }
.je-approval-stuck { border-color: #f59e0b; }
.je-approval-busy { opacity: 0.75; }
.je-approval-top { display: flex; gap: 0.9em; align-items: flex-start; }
.je-approval-poster { width: 5.2em; height: 7.8em; flex: 0 0 auto; border-radius: 8px; object-fit: cover; background: color-mix(in srgb, currentColor 8%, transparent); }
.je-approval-body { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 0.35em; }
.je-approval-title { margin: 0; font-size: 1.15em; font-weight: 600; overflow-wrap: anywhere; }
.je-approval-meta { font-size: 0.9em; opacity: 0.8; overflow-wrap: anywhere; }
.je-approval-line, .je-approval-rating { display: flex; align-items: center; gap: 0.35em; font-size: 0.9em; }
.je-approval-line .material-icons, .je-approval-rating .material-icons, .je-approval-chip .material-icons { font-size: 1.1em; }
.je-approval-rating { align-self: flex-start; padding: 0.15em 0.6em; border-radius: 999px; font-weight: 600; border: 1px solid currentColor; }
.je-approval-rating-ok { color: #2e9d4f; }
.je-approval-rating-warn { color: #d97706; }
.je-approval-chips { display: flex; flex-wrap: wrap; gap: 0.4em; }
.je-approval-admin { font-size: 0.85em; opacity: 0.8; margin-top: 0.4em; }
.je-approval-admin-summary { cursor: pointer; min-height: 44px; line-height: 44px; width: max-content; }
.je-approval-admin-line { font-family: monospace; overflow-wrap: anywhere; }
.je-approval-chip { display: inline-flex; align-items: center; gap: 0.3em; padding: 0.15em 0.6em; border-radius: 999px; font-size: 0.85em; font-weight: 600;
  border: 1px solid color-mix(in srgb, currentColor 30%, transparent); }
.je-approval-chip-quota, .je-approval-chip-stuck { border-color: #d97706; }
.je-approval-actions { display: flex; gap: 0.6em; flex-wrap: wrap; }
.je-approval-btn { font: inherit; font-weight: 700; flex: 1 1 8em; display: inline-flex; align-items: center; justify-content: center; gap: 0.35em;
  min-height: 2.8em; padding: 0.3em 1em; border-radius: 10px; cursor: pointer; }
.je-approval-approve { background: #2e7d32; border: 1px solid #43a047; color: #fff; }
.je-approval-decline { background: transparent; border: 1px solid #e53935; color: #e53935; }
.je-approval-btn[disabled], .je-hub-btn[disabled], .je-approval-reason[disabled], [aria-disabled="true"] { opacity: 0.6; cursor: default; }
.je-approval-working { font-size: 0.9em; opacity: 0.8; }
.je-approval-btn:focus-visible, .je-approval-reason:focus-visible, .je-approval-check input:focus-visible, .je-approval-option input:focus-visible,
.je-household-select:focus-visible, .je-approval-note input:focus-visible, .je-chipbar-chip:focus-visible,
.layout-tv .je-approval-btn:focus, .layout-tv .je-approval-reason:focus, .layout-tv .je-household-select:focus, .layout-tv .je-chipbar-chip:focus,
.layout-tv .je-approval-check input:focus, .layout-tv .je-approval-option input:focus { outline: 3px solid currentColor; outline-offset: 2px; }
.je-approval-edit { align-self: flex-start; }
.je-approval-reasons, .je-approval-sheet { display: flex; flex-direction: column; gap: 0.55em; padding-top: 0.2em; }
.je-approval-reasons-title { font-size: 0.95em; opacity: 0.85; }
.je-approval-reason-list { display: flex; flex-wrap: wrap; gap: 0.5em; }
.je-approval-reason { font: inherit; font-weight: 600; min-height: 2.6em; padding: 0.3em 1em; border-radius: 999px; cursor: pointer; color: inherit;
  background: rgba(128,128,128,0.1); border: 1px solid rgba(128,128,128,0.35); background: color-mix(in srgb, currentColor 6%, transparent); border: 1px solid color-mix(in srgb, currentColor 25%, transparent); }
.je-approval-note { display: flex; flex-direction: column; gap: 0.3em; }
.je-approval-note-label { font-size: 0.85em; opacity: 0.8; }
.je-approval-note input { font: inherit; min-height: 2.6em; padding: 0.3em 0.7em; border-radius: 8px; color: inherit; background: transparent;
  border: 1px solid color-mix(in srgb, currentColor 30%, transparent); }
.je-approval-fieldset { border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: 10px; padding: 0.4em 0.8em 0.6em; margin: 0;
  display: flex; flex-wrap: wrap; gap: 0.3em 1em; }
.je-approval-option, .je-approval-check { display: inline-flex; align-items: center; gap: 0.4em; min-height: 2.6em; cursor: pointer; }
.je-approval-option input, .je-approval-check input { width: 1.3em; height: 1.3em; }
.je-approval-result { font-size: 0.9em; font-weight: 600; }
.je-approvals-tone-done { color: #2e9d4f; }
.je-approvals-tone-attention { color: #d97706; }
.je-approvals-banner.je-approvals-tone-done { border-left: 3px solid #2e9d4f; }
.je-approvals-banner.je-approvals-tone-attention { border-left: 3px solid #d97706; }
.je-approvals-light .je-approval-rating-ok, .je-approvals-light .je-approvals-tone-done { color: #1a7431; }
.je-approvals-light .je-approval-rating-warn, .je-approvals-light .je-approvals-tone-attention { color: #9a4d00; }
.je-approvals-light .je-approvals-banner.je-approvals-tone-done { border-left-color: #1a7431; }
.je-approvals-light .je-approvals-banner.je-approvals-tone-attention { border-left-color: #9a4d00; }
.je-approval-readonly { font-size: 0.9em; opacity: 0.85; font-style: italic; }
.je-approvals-hint { display: flex; align-items: center; justify-content: center; gap: 0.4em; font-size: 0.9em; opacity: 0.75; }
.je-household-rules { display: flex; flex-direction: column; gap: 0.6em; padding: 0.9em; border-radius: 12px;
  border: 1px solid rgba(128,128,128,0.28); border: 1px solid color-mix(in srgb, currentColor 14%, transparent); }
.je-household-field { display: flex; flex-direction: column; gap: 0.25em; }
.je-household-field-label { font-size: 0.85em; opacity: 0.8; }
.je-household-select { font: inherit; min-height: 2.6em; padding: 0.2em 0.6em; border-radius: 8px; color: inherit; background: transparent;
  border: 1px solid rgba(128,128,128,0.4); border: 1px solid color-mix(in srgb, currentColor 30%, transparent); max-width: 100%; }
.je-household-select option { color: #111; background: #fff; }
.je-household-role-limits { display: flex; flex-wrap: wrap; gap: 0.6em 1.2em; }
.je-household-help { font-size: 0.85em; opacity: 0.75; }
.je-household-head { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5em; }
.je-household-name { margin: 0; font-size: 1.1em; font-weight: 600; overflow-wrap: anywhere; }
.je-household-you { margin-left: 0.4em; font-size: 0.8em; font-weight: 400; opacity: 0.75; }
.je-household-role { display: inline-flex; align-items: center; gap: 0.25em; padding: 0.1em 0.6em; border-radius: 999px; font-size: 0.85em; font-weight: 600;
  border: 1px solid color-mix(in srgb, currentColor 30%, transparent); }
.je-household-role .material-icons { font-size: 1.1em; }
.je-household-requests { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.45em; }
.je-household-request { display: flex; gap: 0.6em; align-items: center; }
.je-household-poster { width: 2.4em; height: 3.6em; flex: 0 0 auto; border-radius: 4px; object-fit: cover; background: color-mix(in srgb, currentColor 8%, transparent); }
.je-household-request-title { font-weight: 600; overflow-wrap: anywhere; }
.je-household-controls { display: flex; flex-wrap: wrap; gap: 0.6em 1.2em; align-items: flex-end; }
.je-household-save { position: sticky; bottom: 0; display: flex; flex-wrap: wrap; gap: 0.6em; align-items: center; padding: 0.8em; border-radius: 12px;
  background: Canvas; background: color-mix(in srgb, currentColor 8%, Canvas); border: 1px solid color-mix(in srgb, currentColor 20%, transparent); }
.je-household-confirm { flex-basis: 100%; font-weight: 600; }
.je-hub-cancel { border-color: #e53935; }
.je-chipbar { display: flex; flex-wrap: wrap; gap: 0.6em; margin: 0.6em 3.3% 0.4em; }
.je-chipbar-chip { display: inline-flex; align-items: center; gap: 0.35em; min-height: 2.4em; padding: 0.2em 0.6em 0.2em 0.9em; border-radius: 999px;
  font-weight: 700; text-decoration: none; color: inherit; border: 1px solid; }
.je-chipbar-ok { border-color: #7c5ce6; background: color-mix(in srgb, #7c5ce6 18%, transparent); }
.je-chipbar-stuck { border-color: #d97706; background: color-mix(in srgb, #d97706 15%, transparent); }
.je-chipbar-chip .material-icons { font-size: 1.15em; }
.je-chipbar-chevron { opacity: 0.7; }
@media (max-width: 600px) {
  .je-approval, .je-household-person { padding: 0.75em; }
  .je-approval-poster { width: 4.2em; height: 6.3em; }
  .je-approval-btn, .je-approval-reason, .je-approval-option, .je-approval-check, .je-household-select, .je-approval-note input, .je-chipbar-chip,
  .je-hub-cancel { min-height: 44px; min-width: 44px; }
  .je-household-field, .je-household-select { width: 100%; }
}
.layout-tv .je-approval-btn, .layout-tv .je-approval-reason, .layout-tv .je-approval-option, .layout-tv .je-approval-check,
.layout-tv .je-household-select, .layout-tv .je-chipbar-chip { min-height: 48px; font-size: 1.05em; }
.layout-tv .je-approval-note { display: none; }
`;

    /**
     * Adds the styles once.
     * @returns {void}
     */
    function injectExtraStyles() {
        if (document.getElementById('je-arr-hub-extra-styles')) return;
        const style = document.createElement('style');
        style.id = 'je-arr-hub-extra-styles';
        style.textContent = CSS;
        document.head.appendChild(style);
    }

    JE.internals = JE.internals || {};
    JE.internals.arrHub = JE.internals.arrHub || {};
    JE.internals.arrHub.injectExtraStyles = injectExtraStyles;
})(window.JellyfinEnhanced);
