// /js/jellyseerr/ui/ui-styles.js
// CSS for Seerr search cards, buttons, popovers and the season modal.
(function(JE) {
    'use strict';

    const ui = JE.jellyseerrUI = JE.jellyseerrUI || {};

    // ================================
    // STYLING SYSTEM
    // ================================

    /**
     * Adds main CSS styles for Seerr integration.
     */
    ui.addMainStyles = function() {
        const styleId = 'jellyseerr-styles';
        if (document.getElementById(styleId)) return;
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = `
            /* LAYOUT & ICONS */
            .jellyseerr-section { margin-bottom: 1em; }
            .jellyseerr-section .itemsContainer { }
            #jellyseerr-search-icon { position: absolute; right: 10px; top: 68%; transform: translateY(-50%); user-select: none; z-index: 10; transition: filter .2s, opacity .2s, transform .2s; }
            .inputContainer { position: relative !important; }
            .jellyseerr-icon { width: 30px; height: 50px; filter: drop-shadow(2px 2px 6px #000); }
            #jellyseerr-search-icon.is-active { filter: drop-shadow(2px 2px 6px #000); opacity: 1; }
            #jellyseerr-search-icon.is-disabled { filter: grayscale(1); opacity: .8; }
            #jellyseerr-search-icon.is-no-user { filter: hue-rotate(125deg) brightness(100%); }
            #jellyseerr-search-icon.is-filter-active { filter: drop-shadow(2px 2px 6px #3b82f6) brightness(1.2); transform: translateY(-50%) scale(1.1); }
            #jellyseerr-search-icon:hover { transform: translateY(-50%) scale(1.05); transition: transform 0.2s ease; }
            /* CARDS & BADGES */
            .jellyseerr-card { position: relative; }
            .jellyseerr-card .cardScalable { contain: paint; }
            .jellyseerr-icon-on-card { width: 1.2em !important; height: 1.2em !important; filter: drop-shadow(0 1px 2px rgba(0,0,0,0.6)); flex-shrink: 0; }
            .jellyseerr-status-badge { position: absolute; top: 8px; right: 8px; z-index: 100; width: 1.5em; height: 1.5em; border-radius: 50%; display: flex; align-items: center; justify-content: center; border: 1.5px solid rgba(255,255,255,0.3); box-shadow: 0 0 1px rgba(255,255,255,0.4) inset, 0 4px 12px rgba(0,0,0,0.6); }
            .jellyseerr-status-badge svg { width: 1.4em; height: 1.4em; filter: drop-shadow(0 1px 3px rgba(0,0,0,0.6)); }
            .jellyseerr-status-badge.status-available { background-color: rgba(34, 197, 94, 0.7); border-color: rgba(34, 197, 94, 0.3); }
            .jellyseerr-status-badge.status-processing { background-color: rgba(99, 102, 241, 0.7); border-color: rgba(99, 102, 241, 0.3); }
            .jellyseerr-status-badge.status-requested { background-color: rgba(136, 61, 206, 0.7); border-color: rgba(147, 51, 234, 0.3); }
            .jellyseerr-status-badge.status-pending { background-color: rgba(251, 146, 60, 0.7); border-color: rgba(251, 146, 60, 0.3); }
            .jellyseerr-status-badge.status-partially-available { background-color: rgba(34, 197, 94, 0.7); border-color: rgba(34, 197, 94, 0.3); }
            .jellyseerr-status-badge.status-blocklisted { background-color: rgba(120, 53, 15, 0.7); border-color: rgba(120, 53, 15, 0.3); }
            .jellyseerr-status-badge.status-deleted { background-color: rgba(220, 38, 38, 0.78); border-color: rgba(248, 113, 113, 0.6); }
            @keyframes jellyseerr-spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
            .jellyseerr-status-badge.status-processing svg { animation: jellyseerr-spin 1s linear infinite; }
            .jellyseerr-media-badge { position: absolute; top: 8px; left: 8px; z-index: 100; color: #fff; padding: 2px 8px; border-radius: 999px; border: 1px solid rgba(0,0,0,0.2); font-size: 1em; font-weight: 500; text-transform: uppercase; letter-spacing: 1.5px; text-shadow: 1px 1px 3px rgba(0, 0, 0, 0.8); box-shadow: 0 4px 4px -1px rgba(0,0,0,0.1), 0 2px 2px -2px rgba(0,0,0,0.1); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); }
            .layout-mobile .jellyseerr-media-badge { font-size: 0.8em !important; }
            .jellyseerr-media-badge-movie { background-color: rgba(59, 130, 246, .9); box-shadow: 0 0 0 1px rgba(59,130,246,.35), 0 8px 24px rgba(59,130,246,.25); }
            .jellyseerr-media-badge-series { background-color: rgba(243, 51, 214, .9); box-shadow: 0 0 0 1px rgba(236,72,153,.35), 0 8px 24px rgba(236,72,153,.25); }
            .jellyseerr-media-badge-collection { background-color: rgba(16, 185, 129, .9); box-shadow: 0 0 0 1px rgba(16,185,129,.35), 0 8px 24px rgba(16,185,129,.25); }
            .jellyseerr-collection-badge { position: absolute; bottom: 40px; left: 50%; transform: translateX(-50%); z-index: 1000; color: #fff; padding: 6px 16px; border-radius: 999px; border: 1px solid rgba(0,0,0,0.2); font-size: 0.8em; font-weight: 600; display: flex; align-items: center; justify-content: center; gap: 6px; text-transform: none; letter-spacing: .25px; text-shadow: 1px 1px 3px rgba(0, 0, 0, 0.8); background-color: rgba(16, 185, 129, .85); box-shadow: 0 0 0 1px rgba(16,185,129,.35), 0 8px 24px rgba(16,185,129,.25); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); cursor: pointer; transition: all 0.2s ease; max-width: 85%; pointer-events: auto; }
            .cardImageContainer:has(.jellyseerr-elsewhere-icons:not(.has-icons)) .jellyseerr-collection-badge { bottom: 10px; }
            .jellyseerr-collection-badge:hover { transform: translateX(-50%) translateY(-2px); box-shadow: 0 0 0 1px rgba(16,185,129,.5), 0 12px 32px rgba(16,185,129,.35); }
            .jellyseerr-collection-badge .material-icons { font-size: 1.1em; flex-shrink: 0; }
            .jellyseerr-collection-badge span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .jellyseerr-overview { position: absolute; inset: 0; background: linear-gradient(180deg, rgba(0,0,0,0) 30%, rgba(0,0,0,.78) 75%, rgba(0,0,0,.92) 100%); color: #e5e7eb; padding: 12px 12px 14px; line-height: 1.5; opacity: 1; pointer-events: auto; transform: translateY(0); transition: opacity .18s ease, transform .18s ease; overflow: hidden; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; gap: 10px; backdrop-filter: blur(2px); -webkit-backdrop-filter: blur(2px); }
            .jellyseerr-overview .content { width: 100%; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; white-space: normal; }
            /* SHOW OVERVIEW: When card has 'is-touch' class (mobile/click) */
            .jellyseerr-card.is-touch .jellyseerr-overview { opacity: 1; pointer-events: auto; }
            .jellyseerr-card .cardScalable:focus-within .jellyseerr-overview { opacity: 1; pointer-events: auto; }

            /* SHOW OVERVIEW: Desktop Hover (Media Query Handles Desktop vs Touch separation properly) */
            @media (hover: hover) {
                .jellyseerr-card .cardScalable:hover .jellyseerr-overview { opacity: 1; pointer-events: auto; }
            }

            .jellyseerr-overview .title { font-weight: 600; display: block; margin-bottom: .35em; }
            .jellyseerr-elsewhere-icons { display: none; position: absolute; bottom: 0; left:0; right:0; z-index: 3; justify-content: center; gap: 0.6em; pointer-events: none; background: rgba(0,0,0,0.8); border-top-left-radius: 1.5em; border-top-right-radius: 1.5em; padding: 0.5em 0 0.2em 0; }
            .jellyseerr-elsewhere-icons.has-icons {display: flex;}
            .jellyseerr-elsewhere-icons img { width: 1.8em; border-radius: 0.7em; background-color: rgba(255,255,255,0.5); padding: 2px;}
            .jellyseerr-meta { display: flex; justify-content: center; align-items: center; gap: 1em; padding: 0 .75em; }
            .jellyseerr-rating { display: flex; align-items: center; gap: .3em; color: #bdbdbd; }
            .cardText-first > a.jellyseerr-more-info-link { padding: 0 !important; margin: 0 !important; color: inherit; text-decoration: none; }
            /* REQUEST BUTTONS */
            .jellyseerr-request-button { display: flex; justify-content: center; align-items: center; gap: 0.5em; white-space: normal; text-align: center; padding: 0.6em 1.2em; line-height: 1.2; font-size: 0.9em; transition: background .2s, border-color .2s, color .2s, transform .2s; border-radius: 8px; border: none; font-weight: 600; cursor: pointer; position: relative; z-index: 10; }
            .jellyseerr-request-button svg { width: 1.2em; height: 1.2em; flex-shrink: 0; vertical-align: middle; }
            .layout-mobile .jellyseerr-request-button svg { width: 1em; height: 1em; }
            .layout-mobile .jellyseerr-request-button span { font-size: 0.8em !important; }
            .jellyseerr-request-button.jellyseerr-button-offline, .jellyseerr-request-button.jellyseerr-button-no-user { opacity: .6; cursor: not-allowed; }
            .jellyseerr-request-button.jellyseerr-button-request { background-color: #5a3fb8 !important; color: #fff !important; }
            .jellyseerr-request-button.jellyseerr-button-request:hover:not(:disabled) { background-color: #6b4bb5 !important; transform: translateY(-2px); box-shadow: 0 4px 12px rgba(90, 63, 184, 0.4); }
            .jellyseerr-request-button.jellyseerr-button-pending { background-color: #b45309 !important; color: #fff !important; }
            .jellyseerr-request-button.jellyseerr-button-pending:hover:not(:disabled) { background-color: #d97706 !important; transform: translateY(-2px); }
            .jellyseerr-request-button.jellyseerr-button-processing { background-color: #581c87 !important; color: #fff !important; }
            .jellyseerr-request-button.jellyseerr-button-blocklisted { background-color: #78350f !important; color: #fff !important; }
            .jellyseerr-request-button.jellyseerr-button-deleted { background-color: #dc2626 !important; color: #fff !important; }
            .jellyseerr-request-button.jellyseerr-button-partially-available { background-color: #4ca46c !important; color: #fff !important; }
            .jellyseerr-request-button.jellyseerr-button-partially-available:hover:not(:disabled) { background-color: #5bb876 !important; transform: translateY(-2px); }
            .jellyseerr-request-button.jellyseerr-button-available { background-color: #16a34a !important; color: #fff !important; }
            .jellyseerr-request-button.jellyseerr-button-available-updating { background-color: #0d6d30ff !important; color: #fff !important; }
            .jellyseerr-request-button.jellyseerr-button-error { background: #dc3545 !important; color: #fff !important; }
            .jellyseerr-request-button.jellyseerr-button-tv:not(.jellyseerr-button-available):not(.jellyseerr-button-offline):not(.jellyseerr-button-no-user):not(.jellyseerr-button-error)::after { content: '▼'; margin-left: 6px; font-size: 0.7em; opacity: 0.8; }
            .jellyseerr-season-summary { font-size: 0.85em; opacity: 0.9; display: block; margin-top: 2px; }
            /* SPLIT BUTTON FOR 4K */
            /* Allow button group and popup to overflow card footer */
            .jellyseerr-card .cardFooter {
                overflow: visible !important;
            }
            .jellyseerr-card .cardBox { overflow: visible !important; }
            .jellyseerr-section .vertical-wrap { overflow: visible !important; }

            /* Library item styling */
            .jellyseerr-card-in-library .cardText-first a {
                color: #00d084;
                font-weight: 500;
            }
            /* SPLIT BUTTON FOR 4K */
            .jellyseerr-button-group {
                display: inline-flex;
                width: auto;
                position: relative;
                gap: 0;
                align-items: stretch;
                border-radius: 8px;
                overflow: hidden;
            }
            .jellyseerr-button-group .jellyseerr-split-main {
                border-top-right-radius: 0px !important;
                border-bottom-right-radius: 0px !important;
                margin: 0 !important;
                flex: 1;
            }
            button.jellyseerr-split-arrow {
                border-top-left-radius: 0px !important;
                border-bottom-left-radius: 0px !important;
                cursor: pointer;
                color: #fff !important;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                transition: background .2s, opacity .2s;
                flex-shrink: 0;
                position: relative;
                z-index: 1;
                margin: 0 !important;
                padding: 0.6em 0.4em !important;
                border-left: 2px solid rgba(0, 0, 0, 0.4);
                border-bottom-width: 0px;
                border-top-width: 0px;
                border-right-width: 0px;
            }
            /* Match arrow button color to main button */
            .jellyseerr-button-group .jellyseerr-button-request ~ .jellyseerr-split-arrow {
                background-color: #5a3fb8 !important;
            }
            .jellyseerr-button-group .jellyseerr-button-pending ~ .jellyseerr-split-arrow {
                background-color: #b45309 !important;
            }
            .jellyseerr-button-group .jellyseerr-button-available ~ .jellyseerr-split-arrow {
                background-color: #16a34a !important;
            }
            .jellyseerr-button-group .jellyseerr-button-available-updating ~ .jellyseerr-split-arrow {
                background-color: #16a34a !important;
            }
            .jellyseerr-button-group .jellyseerr-button-processing ~ .jellyseerr-split-arrow {
                background-color: #581c87 !important;
            }
            .jellyseerr-button-group .jellyseerr-button-blocklisted ~ .jellyseerr-split-arrow {
                background-color: #78350f !important;
            }
            .jellyseerr-button-group .jellyseerr-button-deleted ~ .jellyseerr-split-arrow {
                background-color: #dc2626 !important;
            }
            .jellyseerr-button-group .jellyseerr-button-partially-available ~ .jellyseerr-split-arrow {
                background-color: #4ca46c !important;
            }
            /* Override for 4K specific states */
            .jellyseerr-split-arrow.jellyseerr-4k-available {
                background-color: #16a34a !important;
            }
            .jellyseerr-split-arrow.jellyseerr-4k-pending {
                background-color: #b45309 !important;
            }
            .jellyseerr-split-arrow svg {
                width: 1em;
                height: 1em;
            }
            .jellyseerr-split-arrow:hover:not(:disabled) { opacity: 0.8; }
            .jellyseerr-split-arrow:active:not(:disabled) { opacity: 0.7; }
            .jellyseerr-split-arrow:disabled,
            .jellyseerr-split-arrow.jellyseerr-split-arrow-disabled {
                opacity: 0.5;
                cursor: default;
            }

            /* 4K POPUP MENU */
            .jellyseerr-4k-popup {
                position: absolute;
                top: 100%;
                left: 0;
                right: 0;
                background: rgba(0, 0, 0, 0.5);
                border: 1px solid rgba(148, 163, 184, 0.2);
                border-radius: 8px;
                box-shadow: 0 10px 30px rgba(0,0,0,0.45);
                z-index: 10000;
                opacity: 0;
                pointer-events: none;
                transition: opacity 0.2s ease;
                margin-top: 4px;
                overflow: visible;
            }
            .jellyseerr-4k-popup.show {
                opacity: 1;
                pointer-events: all;
                width: fit-content;
            }
            .jellyseerr-4k-popup-item {
                width: 100%;
                border: none;
                background: transparent;
                color: #f8fafc;
                text-align: left;
                cursor: pointer;
                transition: background 0.2s;
                font-size: 0.95rem;
                display: flex;
                align-items: center;
                justify-content: center;
                border-radius: 8px;
                white-space: nowrap;
                padding: 0.5em 0.75em;
                min-height: 2.5em;
            }
            .jellyseerr-4k-popup-item:not(:disabled):hover {
                background: rgba(59, 130, 246, 0.5);
            }
            .jellyseerr-4k-popup-item:not(:disabled):active {
                background: rgba(59, 130, 246, 0.3);
            }
            .jellyseerr-4k-popup-item:disabled {
                opacity: 0.8;
                cursor: default;
                color: #07e659;
            }
            .jellyseerr-4k-popup-item.jellyseerr-4k-available {
                color: #16a34a;
            }
            /* Status-based popup colors matching button styles */
            .jellyseerr-4k-popup.show { background: #5a3fb8 !important; }
            .jellyseerr-4k-popup.show .jellyseerr-4k-popup-item { color: #fff !important; }
            .jellyseerr-4k-popup-item.chip-requested { background-color: #5a3fb8 !important; color: #fff !important; }
            .jellyseerr-4k-popup-item.chip-pending { background-color: #b45309 !important; color: #fff !important; }
            .jellyseerr-4k-popup-item.chip-processing { background-color: #581c87 !important; color: #fff !important; }
            .jellyseerr-4k-popup-item.chip-available { background-color: #16a34a !important; color: #fff !important; }
            .jellyseerr-4k-popup-item svg {
                flex-shrink: 0;
                width: 18px;
                height: 18px;
            }
            /* SPINNERS & LOADERS */
            .jellyseerr-spinner, .jellyseerr-loading-spinner, .jellyseerr-button-spinner { display: inline-block; border-radius: 50%; animation: jellyseerr-spin 1s linear infinite; }
            .jellyseerr-loading-spinner { width: 20px; height: 20px; border: 3px solid rgba(255,255,255,.3); border-top-color: #fff; margin-left: 10px; vertical-align: middle; }
            .jellyseerr-button-spinner { width: 1em; height: 1em; border: 2px solid currentColor; border-right-color: transparent; margin-left: .5em; flex-shrink: 0; }
            /* HOVER POPOVER STYLES */
            .jellyseerr-hover-popover { position: fixed; min-width: 260px; max-width: 340px; padding: 10px 12px; background: #1f2937; color: #e5e7eb; border-radius: 10px; z-index: 9999; box-shadow: 0 10px 30px rgba(0,0,0,.45), 0 0 0 1px rgba(255,255,252, .06); opacity: 0; pointer-events: none; transition: opacity .12s ease, transform .12s ease; }
            .jellyseerr-hover-popover.show { opacity: 1; }
            .jellyseerr-popover-item { margin-bottom: 10px; }
            .jellyseerr-popover-item:last-child { margin-bottom: 0; }
            .jellyseerr-popover-item:not(:last-child) { padding-bottom: 10px; border-bottom: 1px solid rgba(255,255,255,.08); }
            .jellyseerr-hover-popover .title { font-weight: 600; font-size: .9rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 8px; }
            .jellyseerr-hover-popover .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 6px; }
            .jellyseerr-hover-popover .status { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: .75rem; font-weight: 600; background: #4f46e5; color: #fff; }
            .jellyseerr-hover-popover .jellyseerr-hover-progress { height: 7px; width: 100%; background: rgba(255,255,255,.12); border-radius: 999px; overflow: hidden; }
            .jellyseerr-hover-popover .jellyseerr-hover-progress .bar { height: 100%; background: linear-gradient(90deg, #3b82f6, #8b5cf6); transition: width .2s ease; }
            .jellyseerr-hover-popover .eta { margin-left: auto; font-size: .75rem; color: #cbd5e1; opacity: .9; white-space: nowrap; }
            /* UTILITY CLASSES */
            @keyframes jellyseerr-spin { to { transform: rotate(360deg) } }
            .section-hidden { display: none !important; }
        `;
        document.head.appendChild(style);
    };

    /**
     * Adds enhanced CSS styles for season selection modal.
     */
    ui.addSeasonModalStyles = function() {
        const seasonStyleId = 'jellyseerr-season-styles';
        if (document.getElementById(seasonStyleId)) return;
        const style = document.createElement('style');
        style.id = seasonStyleId;
        style.textContent = `
            /* MODAL STYLES */
            .jellyseerr-season-modal { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 10, 20, 0.85); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); z-index: 10000; display: flex; align-items: center; justify-content: center; opacity: 0; pointer-events: none; transition: opacity 0.3s ease; }
            .jellyseerr-season-modal.show { opacity: 1; pointer-events: all; }
            body.jellyseerr-modal-is-open { overflow: hidden; }
            .jellyseerr-season-content { background: linear-gradient(145deg, #1e293b 0%, #0f172a 100%); border: 1px solid rgba(148, 163, 184, 0.1); border-radius: 16px; padding: 0; max-width: 700px; width: 90%; max-height: 80vh; overflow: hidden; box-shadow: 0 25px 80px rgba(0,0,0,0.8), 0 0 0 1px rgba(148, 163, 184, 0.05), inset 0 1px 0 rgba(148, 163, 184, 0.1); transform: scale(0.95); transition: transform 0.3s ease; display: flex; flex-direction: column; }
            .jellyseerr-season-modal.show .jellyseerr-season-content { transform: scale(1); }
            .jellyseerr-season-header { position: relative; padding: 24px; border-radius: 16px 16px 0 0; overflow: hidden; height: 8em; flex-shrink: 0; }
            .jellyseerr-season-header::before { content: ''; position: absolute; top: 0; left: 0; right: 0; bottom: 0; pointer-events: none; backdrop-filter: blur(2px); background: rgba(0, 0, 0, 0.8); }
            .jellyseerr-season-title { position: relative; font-size: 1.8rem; font-weight: 700; margin-bottom: 6px; background: linear-gradient(45deg, #3b82f6, #8b5cf6); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
            .jellyseerr-season-subtitle { position: relative; font-size: 1.4rem; color: rgba(255,255,255,0.9); font-weight: 500; }
            .jellyseerr-modal-body { padding: 24px; overflow-y: auto; }
            .jellyseerr-advanced-options { margin-top: 1em; padding-top: 1em; border-top: 1px solid rgba(148, 163, 184, 0.1); }
            .jellyseerr-advanced-options h3 { margin-top: 0; }
            .jellyseerr-form-row { display: flex; gap: 1em; margin-bottom: 1em; }
            .jellyseerr-form-group { flex: 1; }
            .jellyseerr-form-group label { display: block; margin-bottom: 0.5em; font-weight: 600; color: #e2e8f0; }
            .jellyseerr-form-group select, .jellyseerr-form-group input, .jellyseerr-form-group textarea { width: 100%; padding: 0.75em 0.875em; border-radius: 6px; border: 1px solid rgba(71, 85, 105, 0.5); background-color: rgba(30, 41, 59, 0.7); color: #e2e8f0; font-size: 0.95rem; transition: border-color 0.2s ease, background-color 0.2s ease; }
            .jellyseerr-form-group select:hover, .jellyseerr-form-group input:hover, .jellyseerr-form-group textarea:hover { border-color: rgba(59, 130, 246, 0.4); background-color: rgba(30, 41, 59, 1); }
            .jellyseerr-form-group select:focus, .jellyseerr-form-group input:focus, .jellyseerr-form-group textarea:focus { outline: none; border-color: rgba(59, 130, 246, 0.8); background-color: rgba(30, 41, 59, 1); box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1); }
            .jellyseerr-form-group textarea { resize: vertical; font-family: inherit; }
            .jellyseerr-form-group select[is="emby-select"] { background-color: rgba(30, 41, 59, 0.7) !important; color: #e2e8f0 !important; border: 1px solid rgba(51, 65, 85, 0.5) !important; border-radius: 8px !important; padding: 12px 16px !important; font-size: 0.95rem !important; -webkit-appearance: none; -moz-appearance: none; appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' fill='%2394a3b8' viewBox='0 0 16 16'%3E%3Cpath fill-rule='evenodd' d='M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708z'/%3E%3C/svg%3E") !important; background-repeat: no-repeat !important; background-position: right 16px center !important; transition: border-color 0.2s ease, background-color 0.2s ease !important; }
            .jellyseerr-form-group select[is="emby-select"]:hover { border-color: rgba(59, 130, 246, 0.4) !important; background-color: rgba(30, 41, 59, 1) !important; }
            .jellyseerr-issue-form { padding: 0; }
            .jellyseerr-issue-select { width: 100%; padding: 0.75em 0.875em; border-radius: 6px; border: 1px solid rgba(71, 85, 105, 0.5); background-color: rgba(30, 41, 59, 0.7); color: #e2e8f0; font-size: 0.95rem; transition: border-color 0.2s ease; }
            .jellyseerr-issue-select:hover { border-color: rgba(59, 130, 246, 0.4); background-color: rgba(30, 41, 59, 1); }
            .jellyseerr-issue-select:focus { outline: none; border-color: rgba(59, 130, 246, 0.8); box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1); }
            .jellyseerr-issue-textarea { width: 100%; padding: 0.75em 0.875em; border-radius: 6px; border: 1px solid rgba(71, 85, 105, 0.5); background-color: rgba(30, 41, 59, 0.7); color: #e2e8f0; font-size: 0.95rem; font-family: inherit; resize: vertical; transition: border-color 0.2s ease; }
            .jellyseerr-issue-textarea:hover { border-color: rgba(59, 130, 246, 0.4); background-color: rgba(30, 41, 59, 1); }
            .jellyseerr-issue-textarea:focus { outline: none; border-color: rgba(59, 130, 246, 0.8); background-color: rgba(30, 41, 59, 1); box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1); }
            .jellyseerr-season-list { display: grid; gap: 4px; margin-bottom: 24px; }
            .jellyseerr-season-header-row { display: grid; grid-template-columns: 40px 1fr auto auto; align-items: center; gap: 16px; padding: 12px 20px; background: rgba(51, 65, 85, 0.3); border: 1px solid rgba(71, 85, 105, 0.4); border-radius: 12px; margin-bottom: 8px; font-weight: 600; color: #e2e8f0; }
            .jellyseerr-season-header-row .jellyseerr-season-checkbox { cursor: pointer; }
            .jellyseerr-season-header-label { font-size: 0.95rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #cbd5e1; }
            .jellyseerr-season-item { display: grid; grid-template-columns: 40px 1fr auto auto; align-items: center; gap: 16px; padding: 16px 20px; background: rgba(30, 41, 59, 0.4); border: 1px solid rgba(51, 65, 85, 0.3); border-radius: 12px; transition: all 0.2s ease; position: relative; }
            .jellyseerr-season-item:hover:not(.disabled) { background: rgba(30, 41, 59, 0.7); border-color: rgba(59, 130, 246, 0.3); transform: translateY(-1px); }
            .jellyseerr-season-item.disabled { background: rgba(15, 23, 42, 0.6); opacity: 0.6; border-color: rgba(51, 65, 85, 0.2); }
            .jellyseerr-season-checkbox { appearance: none; -webkit-appearance: none; width: 40px; height: 22px; min-width: 40px; border-radius: 999px; background: rgba(71, 85, 105, 0.6); position: relative; cursor: pointer; transition: background-color 0.2s ease; }
            .jellyseerr-season-checkbox::before { content: ''; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: #fff; transition: transform 0.2s ease; }
            .jellyseerr-season-checkbox:checked { background: #4f46e5; }
            .jellyseerr-season-checkbox:checked::before { transform: translateX(18px); }
            .jellyseerr-season-checkbox:focus-visible { outline: 2px solid rgba(59, 130, 246, 0.8); outline-offset: 2px; }
            .jellyseerr-season-checkbox:disabled { opacity: 0.4; cursor: not-allowed; }
            .jellyseerr-season-info { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
            .jellyseerr-season-name { font-weight: 600; color: #e2e8f0; font-size: 1rem; }
            .jellyseerr-season-meta { font-size: 0.875rem; color: #94a3b8; }
            .jellyseerr-season-episodes { font-size: 0.875rem; color: #64748b; text-align: right; min-width: 70px; font-weight: 500; }
            .jellyseerr-season-status { padding: 6px 12px; border-radius: 20px; font-size: 0.75rem; font-weight: 700; text-transform: uppercase; min-width: 110px; text-align: center; letter-spacing: 0.5px; border: 1px solid transparent; }
            .jellyseerr-season-status-available { background: rgba(34, 197, 94, 0.15); color: #4ade80; border-color: rgba(34, 197, 94, 0.3); }
            .jellyseerr-season-status-pending { background: rgba(251, 146, 60, 0.15); color: #fb923c; border-color: rgba(251, 146, 60, 0.3); }
            .jellyseerr-season-status-processing { background: rgba(147, 51, 234, 0.15); color: #a855f7; border-color: rgba(147, 51, 234, 0.3); }
            .jellyseerr-season-status-partially-available { background: rgba(34, 197, 94, 0.15); color: #4ade80; border-color: rgba(34, 197, 94, 0.3); }
            .jellyseerr-season-status-not-requested { background: rgba(99, 102, 241, 0.15); color: #818cf8; border-color: rgba(99, 102, 241, 0.3); }
            .jellyseerr-inline-progress { grid-column: 1 / -1; padding: 8px 12px; background: rgba(15, 23, 42, 0.5); border-radius: 8px; border: 1px solid rgba(59, 130, 246, 0.2); }
            .jellyseerr-inline-progress-bar { height: .5rem; background: rgba(255,255,255,0.1); border-radius: 3px; overflow: hidden; margin-bottom: .5rem; }
            .jellyseerr-inline-progress-fill { height: 100%; background: linear-gradient(90deg, #3b82f6, #8b5cf6); transition: width 0.3s ease; border-radius: 3px; }
            .jellyseerr-inline-progress-text { font-size: 0.75rem; color: #94a3b8; font-weight: 500; }
            .jellyseerr-collection-list { display: grid; gap: 4px; }
            .jellyseerr-collection-header-row { display: grid; grid-template-columns: 40px 1fr auto auto; align-items: center; gap: 16px; padding: 12px 20px; background: rgba(51, 65, 85, 0.3); border: 1px solid rgba(71, 85, 105, 0.4); border-radius: 12px; margin-bottom: 8px; font-weight: 600; color: #e2e8f0; }
            .jellyseerr-collection-header-row .jellyseerr-collection-checkbox { cursor: pointer; }
            .jellyseerr-collection-header-label { font-size: 0.95rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #cbd5e1; }
            .jellyseerr-collection-checkbox { appearance: none; -webkit-appearance: none; width: 40px; height: 22px; min-width: 40px; border-radius: 999px; background: rgba(71, 85, 105, 0.6); position: relative; cursor: pointer; transition: background-color 0.2s ease; }
            .jellyseerr-collection-checkbox::before { content: ''; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: #fff; transition: transform 0.2s ease; }
            .jellyseerr-collection-checkbox:checked { background: #4f46e5; }
            .jellyseerr-collection-checkbox:checked::before { transform: translateX(18px); }
            .jellyseerr-collection-checkbox:focus-visible { outline: 2px solid rgba(59, 130, 246, 0.8); outline-offset: 2px; }
            .jellyseerr-collection-checkbox:disabled { opacity: 0.4; cursor: not-allowed; }
            .jellyseerr-collection-movie-row { display: grid; grid-template-columns: 40px 46px 1fr auto; align-items: center; gap: 16px; padding: 16px 20px; background: rgba(30, 41, 59, 0.4); border: 1px solid rgba(51, 65, 85, 0.3); border-radius: 8px; transition: all 0.2s ease; }
            .jellyseerr-collection-movie-row:hover:not(:has(input:disabled)) { background: rgba(30, 41, 59, 0.7); border-color: rgba(59, 130, 246, 0.3); }
            .jellyseerr-collection-movie-poster { width: 100%; height: 69px; object-fit: cover; border-radius: 4px; }
            .jellyseerr-collection-movie-details { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
            .jellyseerr-collection-movie-details .title { font-weight: 600; color: #e2e8f0; font-size: 0.95rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .jellyseerr-collection-movie-details .year { font-size: 0.85rem; color: #94a3b8; }
            .jellyseerr-modal-footer { padding: 20px 24px; background: rgba(15, 23, 42, 0.3); border-top: 1px solid rgba(51, 65, 85, 0.3); display: flex; gap: 12px; justify-content: flex-end; flex-shrink: 0; }
            .jellyseerr-modal-button { padding: 12px 24px; border-radius: 8px; border: none; cursor: pointer; font-weight: 600; font-size: 0.875rem; transition: all 0.2s ease; min-width: 120px; }
            .jellyseerr-modal-button:disabled { opacity: 0.6; cursor: not-allowed; }
            .jellyseerr-modal-button-primary { background: linear-gradient(135deg, #4f46e5, #7c3aed); color: white; box-shadow: 0 4px 12px rgba(79, 70, 229, 0.3); }
            .jellyseerr-modal-button-primary:hover:not(:disabled) { background: linear-gradient(135deg, #4338ca, #6d28d9); transform: translateY(-1px); box-shadow: 0 6px 20px rgba(79, 70, 229, 0.4); }
            .jellyseerr-modal-button-secondary { background: rgba(71, 85, 105, 0.8); color: #e2e8f0; border: 1px solid rgba(148, 163, 184, 0.2); }
            .jellyseerr-modal-button-secondary:hover { background: rgba(71, 85, 105, 1); border-color: rgba(148, 163, 184, 0.3); }

            /* Quota chip — shown above request modals when a per-user limit applies. */
            .jellyseerr-quota-chip { padding: 12px 16px; margin-bottom: 16px; background: rgba(30, 41, 59, 0.7); border: 1px solid rgba(99, 102, 241, 0.3); border-radius: 10px; color: #cbd5e1; font-size: 0.9rem; font-weight: 500; line-height: 1.4; display: flex; flex-direction: column; gap: 4px; }
            .jellyseerr-quota-chip-warning { background: rgba(180, 83, 9, 0.18); border-color: rgba(251, 146, 60, 0.45); color: #fdba74; }
            .jellyseerr-quota-chip-restricted { background: rgba(127, 29, 29, 0.25); border-color: rgba(248, 113, 113, 0.55); color: #fca5a5; }
            .jellyseerr-quota-chip-sub { font-size: 0.8rem; opacity: 0.85; font-weight: 400; }
        `;
        document.head.appendChild(style);
    };
    // Inject styles immediately on module load so all self-initializing Jellyseerr
    // sub-modules (item-details, discovery pages, issue reporter, etc.) get CSS
    // regardless of whether the search module is enabled.
    ui.addMainStyles();
    ui.addSeasonModalStyles();

})(window.JellyfinEnhanced);
