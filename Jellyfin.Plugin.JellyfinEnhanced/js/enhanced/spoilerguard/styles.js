// @ts-check
// Stable Spoiler Guard styling for detail and Seerr toggle surfaces.
(function(JE) {
    'use strict';

    JE.internals = JE.internals || {};
    /** @type {any} Shared cross-file namespace; each module contributes a focused surface. */
    const internal = JE.internals.spoilerGuard = JE.internals.spoilerGuard || {};

    internal.injectStyles = function() {
        JE.core.ui.injectCss('je-spoiler-guard-styles', `
            .je-spoiler-blur-btn.je-spoiler-blur-on .detailButton-icon {
                color: #d6c8ff;
            }
            .je-more-info-modal .je-more-info-secondary-actions {
                display: flex;
                flex-wrap: wrap;
                gap: 0.5rem;
                margin-top: 0.75rem;
            }
            .je-more-info-modal .je-more-info-secondary-actions:empty {
                display: none;
            }
            .je-spoiler-pending-btn {
                display: inline-flex;
                align-items: center;
                gap: 0.4em;
                padding: 0.45em 0.9em;
                font-size: 0.85em;
                font-weight: 500;
                line-height: 1.2;
                background: rgba(255, 255, 255, 0.06);
                color: rgba(255, 255, 255, 0.85);
                border: 1px solid rgba(255, 255, 255, 0.14);
                border-radius: 999px;
                cursor: pointer;
                transition: background 0.2s, border-color 0.2s, color 0.2s;
            }
            .je-spoiler-pending-btn:hover:not(:disabled) {
                background: rgba(255, 255, 255, 0.1);
                border-color: rgba(255, 255, 255, 0.25);
                color: #fff;
            }
            .je-spoiler-pending-btn:disabled {
                opacity: 0.55;
                cursor: progress;
            }
            .je-spoiler-pending-btn.je-spoiler-pending-on {
                background: rgba(90, 63, 184, 0.22);
                color: #d6c8ff;
                border-color: rgba(90, 63, 184, 0.55);
            }
            .je-spoiler-pending-btn.je-spoiler-pending-on:hover:not(:disabled) {
                background: rgba(90, 63, 184, 0.32);
                border-color: rgba(90, 63, 184, 0.75);
                color: #fff;
            }
            .je-spoiler-pending-btn .material-icons { font-size: 1.1em; }
        `);
    };
})(window.JellyfinEnhanced);
