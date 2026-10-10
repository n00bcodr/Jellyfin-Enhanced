// /js/jellyseerr/listplaceholders/listplaceholders-styles.js
// Styles of the list placeholders UI, injected on first use (never while the feature is off).
// Playlist rows reuse jellyfin-web's list classes (listItem-border, listItemBody,
// listItemBodyText, secondary) so they match its rows in every theme; dialogs follow
// JE's dark Seerr modal.
(function (JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const lp = JE.internals.listPlaceholders = JE.internals.listPlaceholders || {};

    const STYLE_ID = 'je-list-placeholders-styles';

    const CSS = `
        .je-lp-row { display: flex; align-items: center; padding: 0.25em 0.25em 0.25em 0.5em; position: relative; content-visibility: auto; contain-intrinsic-block-size: auto 4.75em; }
        .je-lp-row:hover { background-color: var(--jf-palette-action-hover, rgba(128, 128, 128, 0.12)); }
        .je-lp-row .je-lp-drag { cursor: grab; flex-shrink: 0; }
        .je-lp-row-main { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; padding: 0; margin: 0; background: transparent; border: 0; color: inherit; font: inherit; text-align: start; cursor: pointer; }
        .je-lp-row-main:focus-visible { outline: 2px solid var(--jf-palette-primary-main, #00a4dc); outline-offset: -2px; }
        .layout-tv .je-lp-row-main:focus { background-color: var(--jf-palette-action-focus, rgba(128, 128, 128, 0.3)); }
        .je-lp-thumb { width: 4em; height: 4em; flex-shrink: 0; display: flex; align-items: center; justify-content: center; }
        .je-lp-thumb img { height: 100%; width: auto; aspect-ratio: 2 / 3; object-fit: cover; border-radius: 0.2em; opacity: 0.85; background: rgba(128, 128, 128, 0.2); }
        .je-lp-body { min-width: 0; }
        .je-lp-body > span { display: block; }
        .je-lp-title { opacity: 0.92; }
        .je-lp-note { font-style: italic; }
        .je-lp-status { display: flex; align-items: center; gap: 0.5em; flex-shrink: 0; margin: 0 0.5em; }
        .je-lp-badge { display: inline-flex; align-items: center; gap: 0.3em; padding: 0.2em 0.6em; border-radius: 999px; font-size: 0.8em; font-weight: 600; color: #fff; white-space: nowrap; background: rgba(100, 116, 139, 0.8); }
        .je-lp-badge svg { width: 1.1em; height: 1.1em; flex-shrink: 0; }
        .je-lp-badge.status-available { background: rgba(34, 197, 94, 0.85); }
        .je-lp-badge.status-processing { background: rgba(99, 102, 241, 0.85); }
        .je-lp-badge.status-requested { background: rgba(136, 61, 206, 0.85); }
        .je-lp-badge.status-pending { background: rgba(234, 120, 30, 0.9); }
        .je-lp-badge.status-partially-available { background: rgba(34, 197, 94, 0.85); }
        .je-lp-badge.status-blocklisted { background: rgba(120, 53, 15, 0.9); }
        .je-lp-badge.status-deleted { background: rgba(220, 38, 38, 0.85); }
        .je-lp-badge-loading { background: transparent; color: inherit; opacity: 0.6; }
        .je-lp-spinner { display: inline-block; width: 0.9em; height: 0.9em; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: je-lp-spin 0.9s linear infinite; }
        @keyframes je-lp-spin { to { transform: rotate(360deg); } }
        .je-lp-request { display: inline-flex; align-items: center; gap: 0.3em; padding: 0.45em 0.9em; border: 0; border-radius: 8px; background: #5a3fb8; color: #fff; font: inherit; font-size: 0.85em; font-weight: 600; cursor: pointer; white-space: nowrap; }
        .je-lp-request:hover:not(:disabled) { background: #6b4bb5; }
        .je-lp-request:disabled { opacity: 0.65; cursor: default; }
        .je-lp-request .material-icons { font-size: 1.25em; }
        .je-lp-menu-btn { display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; padding: 0.4em; margin: 0 0.25em 0 0; background: transparent; border: 0; border-radius: 50%; color: inherit; cursor: pointer; }
        .je-lp-menu-btn:hover, .je-lp-menu-btn:focus-visible { background: rgba(128, 128, 128, 0.22); }
        @media all and (max-width: 50em) {
            .je-lp-badge-text { display: none; }
            .je-lp-badge { padding: 0.25em; }
            .je-lp-request { padding: 0.45em; }
            .je-lp-request span:not(.material-icons) { display: none; }
            .je-lp-status { margin: 0 0.25em; gap: 0.35em; }
        }
        @media all and (max-width: 40em) {
            .je-lp-thumb { width: 2.9em; height: 3.6em; margin-left: 0.25em; }
        }
        @media (prefers-reduced-motion: reduce) { .je-lp-spinner { animation: none; } }

        .je-lp-toolbar { display: flex; align-items: center; justify-content: flex-end; gap: 1em; margin: 0.25em 0 0.5em; }
        .je-lp-toolbar-label { margin-right: auto; opacity: 0.7; font-size: 0.9em; }
        .je-lp-toolbar-btn { display: inline-flex; align-items: center; gap: 0.35em; padding: 0.4em 1em; border-radius: 999px; border: 1px solid rgba(128, 128, 128, 0.45); background: transparent; color: inherit; font: inherit; font-size: 0.9em; cursor: pointer; }
        .je-lp-toolbar-btn:hover, .je-lp-toolbar-btn:focus-visible { background: rgba(128, 128, 128, 0.18); }
        .je-lp-toolbar-btn .material-icons { font-size: 1.2em; }

        .je-lp-collection-section { margin-top: 1em; }
        .je-lp-collection-section .je-lp-card { content-visibility: auto; contain-intrinsic-block-size: auto 20em; }
        .je-lp-section-head { display: flex; align-items: center; flex-wrap: wrap; gap: 0.5em 1em; }
        .je-lp-section-head h2[hidden] { display: none; }
        .je-lp-section-head .je-lp-toolbar { margin: 0 0 0 auto; padding-right: 3.3%; }
        .je-lp-kind-chip { position: absolute; left: clamp(6px, 4cqw, 10px); top: calc(clamp(6px, 4cqw, 10px) + clamp(1.5rem, 11cqw, 1.8rem) + 4px); z-index: 100; max-width: calc(100% - 20px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0.2em 0.6em; border-radius: 999px; border: 1px solid rgba(255, 255, 255, 0.25); background: rgba(0, 0, 0, 0.72); color: #fff; font-size: clamp(0.65rem, 5.5cqw, 0.85rem); font-weight: 600; pointer-events: none; }
        .je-lp-card-custom .cardScalable { container-type: inline-size; }
        .je-lp-card-custom .je-lp-kind-chip { top: clamp(6px, 4cqw, 10px); }
        .je-lp-card-custom .je-lp-card-image { background-size: cover; background-position: center; position: absolute; inset: 0; opacity: 0.85; }
        .je-lp-card-custom .cardText-first { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .je-lp-card-add, .je-lp-card-menu { display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; width: 1.8em; height: 1.8em; padding: 0; margin: 0; background: transparent; border: 0; border-radius: 50%; color: inherit; opacity: 0.7; cursor: pointer; }
        .je-lp-card-add:hover, .je-lp-card-add:focus-visible, .je-lp-card-menu:hover, .je-lp-card-menu:focus-visible { opacity: 1; background: rgba(128, 128, 128, 0.25); }
        .je-lp-card-add .material-icons, .je-lp-card-menu .material-icons { font-size: 1.25em; }

        .je-more-info-modal .je-lp-modal-add { min-height: 40px; box-sizing: border-box; display: inline-flex; align-items: center; gap: 0.4rem; padding: 0 0.9rem; border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.18); background: rgba(255, 255, 255, 0.08); color: #fff; font: inherit; font-size: 0.85rem; cursor: pointer; }
        .je-more-info-modal .je-lp-modal-add:hover { background: rgba(255, 255, 255, 0.16); }
        .je-more-info-modal .je-lp-modal-add .material-icons { font-size: 1.1rem; }
        @media (max-width: 768px) {
            .je-more-info-modal .je-lp-modal-add { min-height: 34px; width: 34px; padding: 0; justify-content: center; }
            .je-more-info-modal .je-lp-modal-add > span:not(.material-icons) { display: none; }
        }

        .je-lp-menu { position: fixed; z-index: 100000; min-width: 200px; padding: 0.3em 0; border-radius: 8px; border: 1px solid rgba(128, 128, 128, 0.3); background: var(--jf-palette-background-paper, #202020); color: var(--jf-palette-text-primary, #fff); box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45); }
        .je-lp-menu-item { display: flex; align-items: center; gap: 0.75em; width: 100%; padding: 0.65em 1em; background: transparent; border: 0; color: inherit; font: inherit; text-align: start; cursor: pointer; }
        .je-lp-menu-item:hover, .je-lp-menu-item:focus { background: rgba(128, 128, 128, 0.2); outline: none; }
        .je-lp-menu-item .material-icons { font-size: 1.25em; opacity: 0.85; }
        .je-lp-menu-item.je-lp-danger { color: #ef4444; }
        .je-lp-toast-link { color: inherit; text-decoration: underline; }

        .je-lp-add { display: flex; flex-direction: column; gap: 14px; color: #e2e8f0; }
        .je-lp-add [hidden] { display: none !important; }
        .je-lp-tabs { display: flex; gap: 8px; }
        .je-lp-tab { flex: 1; padding: 0.6em; border-radius: 10px; border: 1px solid rgba(71, 85, 105, 0.55); background: rgba(15, 23, 42, 0.6); color: #cbd5e1; font: inherit; font-weight: 600; cursor: pointer; }
        .je-lp-tab-active { background: linear-gradient(135deg, #4f46e5, #7c3aed); border-color: transparent; color: #fff; }
        .je-lp-input, .je-lp-select { width: 100%; min-height: 44px; box-sizing: border-box; padding: 0 14px; border-radius: 10px; border: 1px solid rgba(71, 85, 105, 0.55); background: rgba(15, 23, 42, 0.6); color: #e2e8f0; font: inherit; color-scheme: dark; }
        .je-lp-input:focus, .je-lp-select:focus { outline: none; border-color: #818cf8; box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.25); }
        .je-lp-select option, .je-lp-select optgroup { background: #111a2e; color: #e2e8f0; }
        .je-lp-field { display: flex; flex: 1; flex-direction: column; gap: 0.4rem; min-width: 8em; font-size: 0.9rem; color: #94a3b8; }
        .je-lp-field-row { display: flex; flex-wrap: wrap; gap: 12px; }
        .je-lp-results { display: flex; flex-direction: column; gap: 4px; max-height: 40vh; margin-top: 8px; overflow-y: auto; }
        .je-lp-result { display: flex; align-items: center; gap: 12px; padding: 6px 8px; border-radius: 10px; border: 1px solid transparent; background: transparent; color: #e2e8f0; font: inherit; text-align: start; cursor: pointer; }
        .je-lp-result:hover, .je-lp-result:focus-visible { background: rgba(99, 102, 241, 0.12); }
        .je-lp-result-selected { border-color: #818cf8; background: rgba(99, 102, 241, 0.2); }
        .je-lp-result img { width: 40px; height: 60px; flex-shrink: 0; border-radius: 6px; object-fit: cover; background: #0f172a; }
        .je-lp-result-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .je-lp-result-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
        .je-lp-muted { color: #94a3b8; font-size: 0.85em; }
        .je-lp-inlib { color: #4ade80; }
        .je-lp-selected { display: flex; flex-direction: column; gap: 10px; padding-top: 12px; border-top: 1px solid rgba(148, 163, 184, 0.14); }
        .je-lp-selected-title { font-weight: 700; }
        .je-lp-granularity { display: flex; flex-direction: column; gap: 10px; }
        .je-lp-gran-modes { display: flex; flex-wrap: wrap; gap: 14px; }
        .je-lp-gran-modes label, .je-lp-check { display: inline-flex; align-items: center; gap: 6px; color: #e2e8f0; cursor: pointer; }
        .je-lp-gran-season { display: flex; flex-direction: column; gap: 0.4rem; font-size: 0.9rem; color: #94a3b8; }
        .je-lp-gran-episodes { display: flex; flex-direction: column; gap: 2px; max-height: 30vh; overflow-y: auto; }
        .je-lp-episode { display: grid; grid-template-columns: auto 3em 1fr auto; align-items: center; gap: 8px; padding: 4px 6px; border-radius: 6px; cursor: pointer; }
        .je-lp-episode:hover { background: rgba(99, 102, 241, 0.12); }
        .je-lp-episode-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .je-lp-new-playlist { display: flex; flex-direction: column; gap: 10px; }
        .jellyseerr-season-preselect-note { margin-bottom: 12px; padding: 8px 12px; border-radius: 8px; background: rgba(99, 102, 241, 0.15); color: #c7d2fe; font-size: 0.9em; }
    `;

    /** Injects the styles once. */
    function ensureStyles() {
        if (document.getElementById(STYLE_ID)) return;
        if (JE.core?.ui?.injectCss) {
            JE.core.ui.injectCss(STYLE_ID, CSS);
            return;
        }
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = CSS;
        document.head.appendChild(style);
    }

    lp.ensureStyles = ensureStyles;
    lp.STYLE_ID = STYLE_ID;

})(window.JellyfinEnhanced);
