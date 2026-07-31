/**
 * @file Global CSS injected once for plugin features (JE.injectGlobalStyles).
 * Split from ui.js (code motion; bodies verbatim).
 */
(function(JE) {
    'use strict';

    /**
     * Injects custom CSS for plugin features.
     */
    JE.injectGlobalStyles = () => {
        const styleId = 'jellyfin-enhanced-styles';
        if (document.getElementById(styleId)) return;
        const style = document.createElement('style');
        style.id = styleId;
        style.innerHTML = `
            @keyframes dice { 0%, 100% { transform: rotate(0deg) scale(1); } 10%, 30%, 50% { transform: rotate(-10deg) scale(1.1); } 20%, 40% { transform: rotate(10deg) scale(1.1); } 60% { transform: rotate(360deg) scale(1); } }
            button#randomItemButton:not(.loading):hover .material-icons { animation: dice 1.5s; }
            .layout-desktop #enhancedSettingsBtn { display: none !important; }
            /* Remove menu items render like native action-sheet items; only dim them while the removal is in flight. */
            .actionSheetMenuItem[data-id="remove-continue-watching"]:disabled,
            .actionSheetMenuItem[data-id="je-multiselect-remove"]:disabled { opacity: 0.6; cursor: default; }
            /* Phone layout for the settings/help panel. Keyed on the VIEWPORT
               (@media), not the legacy .layout-mobile html class, so it applies
               on any client whose html classes don't discriminate layouts. The
               .layout-mobile selectors are kept as belt-and-braces for the
               legacy mobile layout. The full-screen sheet itself is declared in
               the panel's own <style> block (max-width: 760px); these rules
               handle the content that has to reflow inside it. */
            .layout-mobile #jellyfin-enhanced-panel .shortcuts-container { flex-direction: column; }
            .layout-mobile #jellyfin-enhanced-panel .je-panel-main { padding: 4px 15px 20px 15px; }
            #jellyfin-enhanced-panel .je-pause-delay-row,
            #jellyfin-enhanced-panel .je-subtitle-color-layout,
            #jellyfin-enhanced-panel .je-subtitle-color-controls,
            #jellyfin-enhanced-panel .je-subtitle-color-control-row {
                min-width: 0;
                box-sizing: border-box;
            }
            #jellyfin-enhanced-panel .je-subtitle-color-control-row > input[type="range"] {
                min-width: 0;
                width: 100%;
            }
            @media (max-width: 768px) {
                /* Shortcuts: stack the two columns and release the 400px min-width
                   inline on each so they fit the narrow panel instead of clipping. */
                #jellyfin-enhanced-panel .shortcuts-container { flex-direction: column; gap: 14px; }
                #jellyfin-enhanced-panel .shortcuts-container > div { min-width: 0 !important; flex: 1 1 auto !important; }
                #jellyfin-enhanced-panel .je-panel-main { padding: 4px 15px 20px 15px; }
            }
            @media (max-width: 420px) {
                /* A 320px viewport leaves roughly 220px inside each settings
                   card. Let the delay label share or wrap that row, and stack
                   the subtitle preview below its colour controls instead of
                   preserving their desktop intrinsic widths. */
                #jellyfin-enhanced-panel .je-pause-delay-row {
                    flex-wrap: wrap;
                    padding-left: 0 !important;
                }
                #jellyfin-enhanced-panel .je-pause-delay-row > label {
                    flex: 1 1 120px;
                    min-width: 0;
                    white-space: normal !important;
                }
                #jellyfin-enhanced-panel .je-pause-delay-row > input {
                    flex: 0 0 60px;
                    width: 60px !important;
                    box-sizing: border-box;
                }
                #jellyfin-enhanced-panel .je-subtitle-color-layout {
                    flex-direction: column;
                }
                #jellyfin-enhanced-panel .je-subtitle-color-controls,
                #jellyfin-enhanced-panel #subtitleColorPreview {
                    width: 100%;
                    max-width: 100%;
                }
                #jellyfin-enhanced-panel #subtitleColorPreview {
                    flex: 0 0 auto !important;
                    align-self: stretch !important;
                    box-sizing: border-box;
                }
            }
            @keyframes longPressGlow { from { box-shadow: 0 0 5px 2px var(--primary-accent-color, #fff); } to { box-shadow: 0 0 8px 15px transparent; } }
            .headerUserButton.long-press-active { animation: longPressGlow 750ms ease-out; }
            #jellyfin-enhanced-panel kbd {
                background-color: rgba(255,255,255,0.1);
                border: 1px solid rgba(255,255,255,0.2);
                border-radius: 4px;
                padding: 2px 6px;
                font-size: 0.9em;
                font-family: inherit;
                box-shadow: 0 1px 1px rgba(0,0,0,0.2);
            }
            @font-face {
              font-family: 'Material Symbols Rounded';
              font-style: normal;
              font-weight: 100 700;
              font-display: block;
              src: url(${JE.cdn.url('gfont', 's/materialsymbolsrounded/v258/syl0-zNym6YjUruM-QrEh7-nyTnjDwKNJ_190FjpZIvDmUSVOK7BDB_Qb9vUSzq3wzLK-P0J-V_Zs-QtQth3-jOcbTCVpeRL2w5rwZu2rIelXxc.woff2')}) format('woff2');
            }
            .mediaInfoItem-fileSize .material-icons,
            .mediaInfoItem-watchProgress .material-icons,
            .mediaInfoItem-audioLanguage .material-icons {
              font-family: 'Material Symbols Rounded' !important;
              line-height: 1;
              letter-spacing: normal;
              text-transform: none;
              display: inline-block;
              white-space: nowrap;
              word-wrap: normal;
              direction: ltr;
              -webkit-font-feature-settings: 'liga';
              -moz-font-feature-settings: 'liga';
              font-feature-settings: 'liga';
              -webkit-font-smoothing: antialiased;
            }
            .jellyseerr-issue-radio-group {
              display: flex;
              justify-content: center;
              flex-wrap: wrap;
              gap: 12px;
              margin-top: 12px;
            }
            .jellyseerr-radio-label {
                display: inline-flex;
                align-items: center;
                gap: 8px;
                cursor: pointer;
                position: relative;
            }
            .jellyseerr-radio-input {
                position: absolute;
                opacity: 0;
                width: 1px;
                height: 1px;
                margin: 0;
                padding: 0;
                clip: rect(0 0 0 0);
                border: 0;
            }
            .jellyseerr-radio-option {
                padding: 8px 12px;
                border-radius: 6px;
                border: 2px solid rgba(255,255,255,0.2);
                background-color: rgba(255,255,255,0.05);
                transition: all 0.2s ease;
                user-select: none;
                font-weight: 500;
                display: inline-flex;
                align-items: center;
            }
            .jellyseerr-radio-input:checked + .jellyseerr-radio-option {
                border-color: var(--primary-accent-color, #1e88e5);
                background-color: var(--primary-accent-color, #1e88e5);
                color: white;
            }
            .jellyseerr-radio-input:focus + .jellyseerr-radio-option {
                box-shadow: 0 0 0 4px rgba(30,136,229,0.12);
                outline: none;
            }
            .jellyseerr-radio-input:hover + .jellyseerr-radio-option {
                border-color: var(--primary-accent-color, #1e88e5);
                background-color: rgba(30,136,229,0.1);
            }
            .jellyseerr-issue-textarea {
              max-width: 96%;
              box-sizing: border-box;
            }
            /* Quality-tag category sub-panel — themed expander + reorderable
               rows. Lives inside the user Settings panel under the master
               Quality Tags toggle. Visual treatment mirrors the rest of the
               panel: subtle borders, accent on hover, material-icon arrows
               that match other JE icon buttons. */
            #jellyfin-enhanced-panel .je-quality-cat-wrap { margin: 8px 0 0 30px; }
            #jellyfin-enhanced-panel .je-quality-cat-expander {
                background: transparent;
                border: none;
                color: rgba(255,255,255,0.7);
                cursor: pointer;
                padding: 4px 0;
                font: inherit;
                font-size: 12px;
                display: flex;
                align-items: center;
                gap: 4px;
                transition: color 0.15s;
            }
            #jellyfin-enhanced-panel .je-quality-cat-expander:hover { color: #fff; }
            #jellyfin-enhanced-panel .je-cat-chevron {
                font-size: 18px !important;
                transition: transform 0.2s ease;
            }
            #jellyfin-enhanced-panel .je-quality-cat-expander[aria-expanded="true"] .je-cat-chevron {
                transform: rotate(90deg);
                color: var(--primary-accent-color, #00a4dc);
            }
            #jellyfin-enhanced-panel .je-quality-cat-list {
                margin: 6px 0 0 30px;
                padding: 8px 10px;
                background: rgba(0,0,0,0.18);
                border: 1px solid rgba(255,255,255,0.08);
                border-radius: 6px;
            }
            #jellyfin-enhanced-panel .je-quality-cat-row {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 4px 2px;
            }
            #jellyfin-enhanced-panel .je-quality-cat-row + .je-quality-cat-row {
                border-top: 1px solid rgba(255,255,255,0.06);
            }
            #jellyfin-enhanced-panel .je-quality-cat-label-wrap {
                flex: 1;
                display: flex;
                align-items: center;
                gap: 8px;
                cursor: pointer;
                min-width: 0;
            }
            #jellyfin-enhanced-panel .je-quality-cat-label-wrap input[type="checkbox"] {
                width: 16px;
                height: 16px;
                flex-shrink: 0;
                cursor: pointer;
            }
            #jellyfin-enhanced-panel .je-quality-cat-label { font-size: 13px; }
            #jellyfin-enhanced-panel .je-cat-btn {
                background: rgba(255,255,255,0.04);
                border: 1px solid rgba(255,255,255,0.15);
                color: rgba(255,255,255,0.85);
                border-radius: 4px;
                padding: 3px 6px;
                cursor: pointer;
                line-height: 1;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                transition: background 0.15s, border-color 0.15s, color 0.15s;
            }
            #jellyfin-enhanced-panel .je-cat-btn .material-icons { font-size: 16px !important; }
            #jellyfin-enhanced-panel .je-cat-btn:not([disabled]):hover {
                background: rgba(255,255,255,0.1);
                border-color: var(--primary-accent-color, rgba(255,255,255,0.35));
                color: #fff;
            }
            #jellyfin-enhanced-panel .je-cat-btn[disabled] {
                opacity: 0.35;
                cursor: not-allowed;
            }
        `;
        document.head.appendChild(style);
    };
})(window.JellyfinEnhanced);
