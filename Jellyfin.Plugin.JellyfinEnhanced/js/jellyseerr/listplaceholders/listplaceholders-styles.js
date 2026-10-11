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
        a.je-lp-adding { text-decoration: none; cursor: pointer; }
        a.je-lp-adding:hover, a.je-lp-adding:focus-visible { filter: brightness(1.1); text-decoration: underline; }
        .je-lp-adding .material-icons { font-size: 1.15em; }
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

        .je-lp-toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 0.4em 1em; margin: 0.25em 0 0.5em; }
        .je-lp-toolbar-label { margin-right: auto; opacity: 0.7; font-size: 0.9em; }
        .je-lp-toolbar-label:empty { display: none; }
        .je-lp-toolbar-auto { opacity: 0.7; font-size: 0.85em; white-space: nowrap; }
        /* Source chip + buttons: one unit that wraps as a whole; the chip gives up width (ellipsis) before it wraps. */
        .je-lp-toolbar-end { display: flex; align-items: center; justify-content: flex-end; gap: 1em; min-width: 0; max-width: 100%; }
        .je-lp-toolbar-end:has(.je-lp-source-chip) { flex: 1 1 26em; max-width: max-content; }
        .je-lp-toolbar-end > .je-lp-toolbar-btn { flex: none; }
        .je-lp-toolbar-btn { display: inline-flex; align-items: center; gap: 0.35em; padding: 0.4em 1em; border-radius: 999px; border: 1px solid rgba(128, 128, 128, 0.45); background: transparent; color: inherit; font: inherit; font-size: 0.9em; cursor: pointer; }
        .je-lp-toolbar-btn:hover, .je-lp-toolbar-btn:focus-visible { background: rgba(128, 128, 128, 0.18); }
        .je-lp-toolbar-btn .material-icons { font-size: 1.2em; }

        .je-lp-collection-section { margin-top: 1em; }
        .je-lp-collection-section .je-lp-card { content-visibility: auto; contain-intrinsic-block-size: auto 20em; }
        .je-lp-section-head { display: flex; align-items: center; flex-wrap: wrap; gap: 0.5em 1em; }
        .je-lp-section-head h2[hidden] { display: none; }
        .je-lp-section-head .je-lp-toolbar { margin: 0 0 0 auto; padding-right: 3.3%; min-width: 0; }
        .je-lp-kind-chip { position: absolute; left: clamp(6px, 4cqw, 10px); top: calc(clamp(6px, 4cqw, 10px) + clamp(1.5rem, 11cqw, 1.8rem) + 4px); z-index: 100; max-width: calc(100% - 20px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0.2em 0.6em; border-radius: 999px; border: 1px solid rgba(255, 255, 255, 0.25); background: rgba(0, 0, 0, 0.72); color: #fff; font-size: clamp(0.65rem, 5.5cqw, 0.85rem); font-weight: 600; pointer-events: none; }
        .je-lp-progress-chip { position: absolute; left: clamp(6px, 4cqw, 10px); bottom: clamp(6px, 4cqw, 10px); z-index: 100; max-width: calc(100% - 20px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0.2em 0.6em; border-radius: 999px; border: 1px solid rgba(255, 255, 255, 0.25); background: rgba(0, 0, 0, 0.72); color: #fff; font-size: clamp(0.65rem, 5.5cqw, 0.85rem); font-weight: 600; pointer-events: none; }
        .je-lp-progress-chip.je-lp-adding { background: rgba(34, 197, 94, 0.9); border-color: transparent; }
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
        .je-lp-results-group, .je-lp-results-body { display: flex; flex-direction: column; gap: 4px; }
        .je-lp-results-heading { margin: 8px 0 2px; font-size: 0.78em; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: #94a3b8; }
        .je-lp-arr-result { display: flex; align-items: center; gap: 6px; }
        .je-lp-arr-result .je-lp-result { flex: 1 1 auto; min-width: 0; }
        .je-lp-arr-result-add { flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; padding: 0.5em; border: 0; border-radius: 50%; background: transparent; color: #a5b4fc; cursor: pointer; }
        .je-lp-arr-result-add:hover, .je-lp-arr-result-add:focus-visible { background: rgba(99, 102, 241, 0.22); }
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

        .je-lp-source-chip { display: inline-flex; align-items: center; gap: 0.45em; flex: 0 1 auto; min-width: 0; max-width: 28em; padding: 0.3em 0.8em; border-radius: 999px; border: 1px solid rgba(99, 102, 241, 0.55); background: rgba(99, 102, 241, 0.12); color: inherit; font: inherit; font-size: 0.85em; text-align: start; cursor: pointer; }
        .je-lp-source-chip:hover, .je-lp-source-chip:focus-visible { background: rgba(99, 102, 241, 0.24); }
        .je-lp-source-chip .material-icons { font-size: 1.3em; flex-shrink: 0; }
        .je-lp-source-chip.je-lp-source-paused { border-color: rgba(234, 120, 30, 0.7); background: rgba(234, 120, 30, 0.14); }
        .je-lp-source-chip.je-lp-source-off { border-color: rgba(128, 128, 128, 0.45); background: transparent; }
        .je-lp-source-chip.je-lp-source-busy .material-icons { animation: je-lp-spin 1.2s linear infinite; }
        .je-lp-source-text { display: flex; flex-direction: column; min-width: 0; line-height: 1.25; }
        .je-lp-source-name, .je-lp-source-status { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .je-lp-source-status { opacity: 0.7; font-size: 0.9em; }
        @media all and (max-width: 50em) { .je-lp-toolbar-btn > span:not(.material-icons) { display: none; } .je-lp-toolbar-btn { padding: 0.4em 0.6em; } }
        .je-lp-import-global { display: inline-flex; align-items: center; gap: 0.4em; margin-left: 8px; padding: 4px 10px; min-height: 30px; box-sizing: border-box; border-radius: 4px; border: 1px solid currentColor; background: transparent; color: var(--jf-palette-primary-main, #00a4dc); font: inherit; font-size: 0.8125rem; font-weight: 500; letter-spacing: 0.02857em; cursor: pointer; white-space: nowrap; }
        .je-lp-import-global:hover, .je-lp-import-global:focus-visible { background: rgba(0, 164, 220, 0.1); }
        .je-lp-import-global .material-icons { font-size: 1.25em; }
        @media all and (max-width: 600px) { .je-lp-import-global-text { display: none; } .je-lp-import-global { padding: 4px 6px; } }

        .je-lp-import-modal .jellyseerr-season-content { max-width: 1040px; width: 95%; max-height: 92vh; }
        .je-lp-import-modal .jellyseerr-modal-body { max-height: calc(92vh - 190px) !important; padding: 18px 20px !important; }
        .je-lp-import-modal .jellyseerr-season-header { min-height: 0; }
        .je-lp-import .je-lp-pane { display: flex; flex-direction: column; gap: 10px; }
        .je-lp-import-text { min-height: 12em; padding: 10px 14px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.85rem; line-height: 1.4; }
        .je-lp-import-parse { display: flex; flex-direction: column; gap: 8px; font-size: 0.9rem; }
        .je-lp-import-sections { display: flex; flex-wrap: wrap; gap: 6px 16px; margin: 0; padding: 8px 12px; border: 1px solid rgba(71, 85, 105, 0.55); border-radius: 10px; }
        .je-lp-import-sections legend { padding: 0 6px; color: #94a3b8; font-size: 0.85rem; }
        .je-lp-warn { color: #fbbf24; }
        .je-lp-import-url-error { color: #fca5a5; font-size: 0.9rem; }
        .je-lp-import-url-error:empty { display: none; }
        .je-lp-link-btn { display: inline-flex; align-items: center; gap: 6px; align-self: flex-start; padding: 4px 6px; border: 0; border-radius: 6px; background: transparent; color: #a5b4fc; font: inherit; font-size: 0.9rem; cursor: pointer; }
        .je-lp-link-btn:hover, .je-lp-link-btn:focus-visible { background: rgba(99, 102, 241, 0.15); }
        .je-lp-link-btn .material-icons { font-size: 1.15em; }
        .je-lp-import-review { display: flex; flex-direction: column; gap: 10px; }
        .je-lp-import-head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 16px; }
        .je-lp-import-progress { display: flex; align-items: center; gap: 12px; font-size: 0.9rem; }
        .je-lp-import-bar { flex: 1; height: 8px; accent-color: #7c3aed; }
        .je-lp-import-tools { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 14px; }
        .je-lp-import-tools .je-lp-toolbar-btn { color: #e2e8f0; }
        .je-lp-import-summary { font-weight: 600; }
        .je-lp-import-summary:empty { display: none; }
        .je-lp-import-rows { display: flex; flex-direction: column; border-top: 1px solid rgba(148, 163, 184, 0.14); }
        .je-lp-irow { display: grid; grid-template-columns: 2.2em 40px minmax(0, 1fr) auto; align-items: center; gap: 4px 12px; padding: 6px 4px; border-bottom: 1px solid rgba(148, 163, 184, 0.1); content-visibility: auto; contain-intrinsic-block-size: auto 76px; }
        .je-lp-irow-skip .je-lp-irow-main, .je-lp-irow-skip .je-lp-irow-poster { opacity: 0.5; }
        .je-lp-only-review .je-lp-irow:not(.je-lp-irow-review) { display: none; }
        .je-lp-irow-num { color: #64748b; font-size: 0.8rem; text-align: end; font-variant-numeric: tabular-nums; }
        .je-lp-irow-poster { width: 40px; height: 60px; display: flex; align-items: center; justify-content: center; border-radius: 6px; overflow: hidden; background: #0f172a; color: #475569; }
        .je-lp-irow-poster img { width: 100%; height: 100%; object-fit: cover; }
        .je-lp-irow-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .je-lp-irow-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .je-lp-irow-meta { font-size: 0.82rem; color: #cbd5e1; }
        .je-lp-irow-hint { font-size: 0.8rem; color: #fbbf24; }
        .je-lp-irow-line { font-size: 0.78rem; color: #64748b; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .je-lp-irow-controls { display: flex; align-items: center; gap: 6px; }
        .je-lp-irow-controls .je-lp-select { width: auto; min-width: 9.5em; min-height: 38px; }
        .je-lp-irow-edit { display: inline-flex; align-items: center; justify-content: center; width: 38px; height: 38px; padding: 0; border-radius: 10px; border: 1px solid rgba(71, 85, 105, 0.55); background: rgba(15, 23, 42, 0.6); color: #cbd5e1; cursor: pointer; }
        .je-lp-irow-edit:hover, .je-lp-irow-edit:focus-visible, .je-lp-irow-edit[aria-expanded="true"] { border-color: #818cf8; color: #fff; }
        .je-lp-chip { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 0.75rem; font-weight: 600; background: rgba(100, 116, 139, 0.35); color: #e2e8f0; white-space: nowrap; }
        .je-lp-conf-high { background: rgba(34, 197, 94, 0.25); color: #86efac; }
        .je-lp-conf-medium { background: rgba(234, 179, 8, 0.22); color: #fde047; }
        .je-lp-conf-low { background: rgba(249, 115, 22, 0.25); color: #fdba74; }
        .je-lp-conf-none { background: rgba(220, 38, 38, 0.25); color: #fca5a5; }
        .je-lp-chip-lib { background: rgba(14, 165, 233, 0.25); color: #7dd3fc; }
        .je-lp-ieditor { display: flex; flex-direction: column; gap: 10px; margin: 4px 0 10px 2.6em; padding: 12px; border-radius: 12px; border: 1px solid rgba(129, 140, 248, 0.45); background: rgba(15, 23, 42, 0.75); }
        .je-lp-ieditor-cands { display: flex; flex-direction: column; gap: 4px; max-height: 40vh; overflow-y: auto; }
        .je-lp-ieditor-cand { display: flex; align-items: center; gap: 10px; padding: 4px 6px; border-radius: 8px; cursor: pointer; }
        .je-lp-ieditor-cand:hover { background: rgba(99, 102, 241, 0.12); }
        .je-lp-ieditor-cand img { width: 32px; height: 48px; border-radius: 4px; object-fit: cover; background: #0f172a; flex-shrink: 0; }
        .je-lp-ieditor-actions { display: flex; justify-content: flex-end; gap: 10px; }
        .je-lp-ieditor-actions .jellyseerr-modal-button { min-height: 36px; padding: 0 16px; }
        .je-lp-import-options { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 12px 24px; padding-top: 10px; border-top: 1px solid rgba(148, 163, 184, 0.14); }
        .je-lp-import-options:not(:has(> :not([hidden]))) { display: none; }
        .je-lp-import-sync { display: flex; flex-direction: column; gap: 6px; }
        .je-lp-import-options .je-lp-new-playlist { flex: 1; min-width: 14em; }
        .je-lp-import-options .je-lp-position { flex: 0 1 14em; }
        @media all and (max-width: 640px) {
            .je-lp-irow { grid-template-columns: 34px minmax(0, 1fr); }
            .je-lp-irow-num { display: none; }
            .je-lp-irow-controls { grid-column: 1 / -1; }
            .je-lp-irow-controls .je-lp-select { flex: 1; }
            .je-lp-ieditor { margin-left: 0; }
        }
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
