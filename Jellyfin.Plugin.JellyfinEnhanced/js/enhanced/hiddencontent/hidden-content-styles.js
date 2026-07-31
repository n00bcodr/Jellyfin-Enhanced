/**
 * @file Hidden Content — CSS for hide buttons, undo toast, management panel,
 * and the confirmation dialog.
 * Split from hidden-content.js (code motion; CSS verbatim).
 */
(function (JE) {
    'use strict';

    JE.internals = JE.internals || {};
    const internal = JE.internals.hiddenContent = JE.internals.hiddenContent || {};

    // ============================================================
    // CSS injection
    // ============================================================

    /**
     * Injects the CSS rules used by hide buttons, undo toast, management panel,
     * and confirmation dialog.  No-ops if the stylesheet is already present.
     */
    function injectCSS() {
        if (!JE.helpers?.addCSS) return;
        JE.helpers.addCSS('je-hidden-content', `
            .je-hidden { display: none !important; }
            .je-hide-btn {
                --je-danger-rgb: 220, 50, 50;
                position: absolute;
                top: 6px;
                right: 6px;
                z-index: 10;
                width: 28px;
                height: 28px;
                border-radius: 50%;
                background: rgba(0,0,0,0.7);
                border: 1px solid rgba(255,255,255,0.2);
                color: #fff;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                opacity: 0;
                transition: opacity 0.2s ease, background 0.2s ease;
                padding: 0;
                font-size: 16px;
                line-height: 1;
            }
            .je-hide-btn .material-icons {
                font-size: 16px;
            }
            .cardBox:hover .je-hide-btn,
            .je-hide-btn:focus {
                opacity: 1;
            }
            .je-hide-btn:hover {
                background: rgba(var(--je-danger-rgb, 220, 50, 50), 0.85);
                border-color: rgba(255,255,255,0.4);
            }
            .je-hide-btn.je-already-hidden {
                opacity: 0;
                background: rgba(0,0,0,0.7);
                border-color: rgba(255,255,255,0.2);
                cursor: pointer;
                pointer-events: auto;
                font-size: 16px;
                width: 28px;
                border-radius: 50%;
                padding: 0;
                height: 28px;
                line-height: 1;
            }
            .cardBox:hover .je-hide-btn.je-already-hidden {
                opacity: 0.85;
            }
            .je-hide-btn.je-already-hidden:hover {
                background: rgba(0,0,0,0.82);
                border-color: rgba(255,255,255,0.28);
            }
            .je-detail-hide-btn.je-already-hidden {
                opacity: 0.85;
                pointer-events: auto;
                transition: background 0.2s ease, opacity 0.2s ease;
            }
            .je-detail-hide-btn.je-already-hidden:hover {
                opacity: 1;
                background: rgba(255,255,255,0.08);
            }

            .je-undo-toast {
                position: fixed;
                bottom: 20px;
                right: 20px;
                color: #fff;
                padding: 12px 16px;
                border-radius: 8px;
                z-index: 99999;
                font-size: clamp(13px, 2vw, 16px);
                font-weight: 500;
                text-shadow: -1px -1px 10px black;
                box-shadow: 0 4px 20px rgba(0,0,0,0.3);
                display: flex;
                align-items: center;
                gap: 12px;
                transform: translateX(100%);
                transition: transform 0.3s ease-out;
                max-width: 380px;
            }
            .je-undo-toast.je-visible {
                transform: translateX(0);
            }
            .je-undo-toast-text {
                flex: 1;
            }
            .je-undo-btn {
                background: rgba(255,255,255,0.15);
                border: 1px solid rgba(255,255,255,0.25);
                color: #fff;
                padding: 4px 12px;
                border-radius: 4px;
                cursor: pointer;
                font-size: 13px;
                font-weight: 600;
                white-space: nowrap;
                transition: background 0.2s ease, border-color 0.2s ease;
            }
            .je-undo-btn:hover {
                filter: brightness(1.3);
            }

            .je-hidden-management-overlay {
                position: fixed;
                inset: 0;
                z-index: 100000;
                background: rgba(0,0,0,0.85);
                backdrop-filter: blur(10px);
                display: flex;
                flex-direction: column;
                align-items: center;
                padding: 40px 20px;
                overflow-y: auto;
            }
            .je-hidden-management-panel {
                width: 100%;
                max-width: 900px;
                background: linear-gradient(135deg, rgba(30,30,35,0.98), rgba(20,20,25,0.98));
                border-radius: 12px;
                border: 1px solid rgba(255,255,255,0.1);
                overflow: hidden;
            }
            .je-hidden-management-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 20px 24px;
                border-bottom: 1px solid rgba(255,255,255,0.1);
            }
            .je-hidden-management-header h2 {
                margin: 0;
                font-size: 20px;
                font-weight: 600;
                color: #fff;
            }
            .je-hidden-management-close {
                background: rgba(255,255,255,0.1);
                border: 1px solid rgba(255,255,255,0.15);
                color: #fff;
                width: 32px;
                height: 32px;
                border-radius: 50%;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 18px;
                transition: background 0.2s ease;
            }
            .je-hidden-management-close:hover {
                background: rgba(255,80,80,0.4);
            }
            .je-hidden-management-toolbar {
                display: flex;
                align-items: center;
                gap: 12px;
                padding: 16px 24px;
                border-bottom: 1px solid rgba(255,255,255,0.06);
            }
            .je-hidden-management-search {
                flex: 1;
                background: rgba(255,255,255,0.08);
                border: 1px solid rgba(255,255,255,0.12);
                border-radius: 6px;
                color: #fff;
                padding: 8px 12px;
                font-size: 14px;
                outline: none;
            }
            .je-hidden-management-search::placeholder {
                color: rgba(255,255,255,0.4);
            }
            .je-hidden-management-search:focus {
                border-color: rgba(255,255,255,0.3);
            }
            .je-hidden-management-unhide-all {
                background: rgba(220,50,50,0.3);
                border: 1px solid rgba(220,50,50,0.5);
                color: #fff;
                padding: 8px 16px;
                border-radius: 6px;
                cursor: pointer;
                font-size: 13px;
                font-weight: 500;
                white-space: nowrap;
                transition: background 0.2s ease;
            }
            .je-hidden-management-unhide-all:hover {
                background: rgba(220,50,50,0.5);
            }
            .je-hidden-management-grid {
                display: grid;
                grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
                gap: 16px;
                padding: 24px;
            }
            .je-hidden-management-empty {
                text-align: center;
                padding: 60px 24px;
                color: rgba(255,255,255,0.4);
                font-size: 15px;
            }
            .je-hidden-item-card {
                background: rgba(255,255,255,0.05);
                border-radius: 8px;
                overflow: hidden;
                border: 1px solid rgba(255,255,255,0.08);
                transition: border-color 0.2s ease, transform 0.2s ease;
            }
            .je-hidden-item-card:hover {
                border-color: rgba(255,255,255,0.2);
            }
            .je-hidden-item-poster-link {
                display: block;
                cursor: pointer;
                text-decoration: none;
            }
            .je-hidden-item-poster {
                width: 100%;
                aspect-ratio: 2/3;
                object-fit: cover;
                background: rgba(255,255,255,0.05);
                display: block;
                transition: opacity 0.2s ease;
            }
            .je-hidden-item-poster-link:hover .je-hidden-item-poster {
                opacity: 0.8;
            }
            .je-hidden-item-info {
                padding: 10px;
            }
            .je-hidden-item-name {
                font-size: 13px;
                font-weight: 500;
                color: #fff;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                margin-bottom: 4px;
                text-decoration: none;
                display: block;
            }
            .je-hidden-item-name:hover {
                text-decoration: underline;
                color: #fff;
            }
            .je-hidden-item-meta {
                font-size: 11px;
                color: rgba(255,255,255,0.4);
                margin-bottom: 8px;
            }
            .je-hidden-item-unhide {
                width: 100%;
                background: rgba(255,255,255,0.1);
                border: 1px solid rgba(255,255,255,0.15);
                color: #fff;
                padding: 6px;
                border-radius: 4px;
                cursor: pointer;
                font-size: 12px;
                font-weight: 500;
                transition: background 0.2s ease;
            }
            .je-hidden-item-unhide:hover {
                background: rgba(100,200,100,0.3);
                border-color: rgba(100,200,100,0.5);
            }
            .je-hidden-item-removing {
                animation: je-hidden-fadeout 0.3s ease forwards;
            }
            @keyframes je-hidden-fadeout {
                to { opacity: 0; transform: scale(0.9); }
            }

            .je-hide-confirm-overlay {
                position: fixed;
                inset: 0;
                z-index: 100001;
                background: rgba(0,0,0,0.75);
                backdrop-filter: blur(6px);
                display: flex;
                align-items: center;
                justify-content: center;
            }
            .je-hide-confirm-dialog {
                background: linear-gradient(135deg, rgba(30,30,35,0.98), rgba(20,20,25,0.98));
                border: 1px solid rgba(255,255,255,0.12);
                border-radius: 12px;
                padding: 24px;
                max-width: 420px;
                width: 90%;
                color: #fff;
            }
            .je-hide-confirm-dialog h3 {
                margin: 0 0 12px 0;
                font-size: 18px;
                font-weight: 600;
            }
            .je-hide-confirm-dialog p {
                margin: 0 0 16px 0;
                font-size: 14px;
                color: rgba(255,255,255,0.7);
                line-height: 1.5;
            }
            .je-hide-confirm-options {
                display: flex;
                flex-direction: column;
                gap: 8px;
                margin-bottom: 20px;
            }
            .je-hide-confirm-options label {
                display: flex;
                align-items: center;
                gap: 8px;
                font-size: 13px;
                color: rgba(255,255,255,0.6);
                cursor: pointer;
            }
            .je-hide-confirm-options input[type="checkbox"] {
                width: 16px;
                height: 16px;
                accent-color: #e0e0e0;
                cursor: pointer;
            }
            .je-hide-confirm-buttons {
                display: flex;
                justify-content: flex-end;
                gap: 10px;
            }
            .je-hide-confirm-cancel {
                background: rgba(255,255,255,0.1);
                border: 1px solid rgba(255,255,255,0.15);
                color: #fff;
                padding: 8px 20px;
                border-radius: 6px;
                cursor: pointer;
                font-size: 14px;
                font-weight: 500;
                transition: background 0.2s ease;
            }
            .je-hide-confirm-cancel:hover {
                background: rgba(255,255,255,0.2);
            }
            .je-hide-confirm-hide {
                background: rgba(220,50,50,0.6);
                border: 1px solid rgba(220,50,50,0.7);
                color: #fff;
                padding: 8px 20px;
                border-radius: 6px;
                cursor: pointer;
                font-size: 14px;
                font-weight: 600;
                transition: background 0.2s ease;
            }
            .je-hide-confirm-hide:hover {
                background: rgba(220,50,50,0.8);
            }
        `);
    }

    Object.assign(internal, { injectCSS });

})(window.JellyfinEnhanced);
