import { installOnce, onDispose, selectionLease, enqueueWrite, pendingWrites } from './host';
import { host, registry, type HiddenHost } from './host';
import hiddenContentCss from './hidden-content.css';
/**
 * @file Hidden Content — CSS for hide buttons, undo toast, management panel,
 * and the confirmation dialog.
 * Split from hidden-content.js (code motion; CSS verbatim).
 */
(function (JE: HiddenHost) {
    if(!installOnce(JE,'hidden-content-styles'))return;
    'use strict';
    const internal = registry(JE, 'hiddenContent');

    // ============================================================
    // CSS injection
    // ============================================================

    /**
     * Injects the CSS rules used by hide buttons, undo toast, management panel,
     * and confirmation dialog.  No-ops if the stylesheet is already present.
     */
    function injectCSS() {
        if (!JE.helpers?.addCSS) return;
        JE.helpers.addCSS('je-hidden-content', hiddenContentCss);
    }

    Object.assign(internal, { injectCSS });

})(host.JellyfinEnhanced);
