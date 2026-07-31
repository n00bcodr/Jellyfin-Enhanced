// @ts-check
// Disable-confirm dialog and its Jellyfin/native fallback.
(function(JE) {
    'use strict';

    JE.internals = JE.internals || {};
    /** @type {any} Shared cross-file namespace; each module contributes a focused surface. */
    const internal = JE.internals.spoilerGuard = JE.internals.spoilerGuard || {};
    const logPrefix = '🪼 Jellyfin Enhanced [SpoilerGuard]:';

    function showConfirmDialog() {
        const title = JE.t('spoiler_disable_confirm_title');
        const body = JE.t('spoiler_disable_confirm_body');
        const snoozeLabel = JE.t('spoiler_disable_confirm_snooze');
        const marker = `je-sb-snooze-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
        const escape = typeof JE.escapeHtml === 'function' ? JE.escapeHtml : value => String(value);
        const html = `<div>${escape(body)}</div>`
            + `<label class="${marker}" style="display:flex;align-items:center;gap:.5em;margin-top:1em;cursor:pointer;">`
            + `<input type="checkbox"><span>${escape(snoozeLabel)}</span></label>`;

        return new Promise(function(resolve) {
            if (!window.Dashboard || typeof window.Dashboard.confirm !== 'function') {
                console.warn(`${logPrefix} Dashboard.confirm unavailable; using native confirm without snooze`);
                resolve(window.confirm(`${title}\n\n${body}`));
                return;
            }

            let snoozeChecked = false;
            function captureChange(event) {
                try {
                    const target = event.target;
                    if (target?.tagName === 'INPUT' && target.type === 'checkbox' && target.closest(`.${marker}`)) {
                        snoozeChecked = !!target.checked;
                    }
                } catch (_) { /* never let a stray DOM event break the dialog */ }
            }
            function cleanup() { document.removeEventListener('change', captureChange, true); }
            document.addEventListener('change', captureChange, true);
            try {
                window.Dashboard.confirm(html, title, function(ok) {
                    try {
                        const checkbox = /** @type {HTMLInputElement|null} */ (
                            document.querySelector(`.${marker} input[type="checkbox"]`)
                        );
                        if (checkbox) snoozeChecked = !!checkbox.checked;
                    } catch (_) { /* dialog DOM may already be gone */ }
                    cleanup();
                    const confirmed = !!ok;
                    if (confirmed && snoozeChecked) internal.setDisableSnooze();
                    resolve(confirmed);
                });
            } catch (e) {
                cleanup();
                console.warn(`${logPrefix} Dashboard.confirm failed; using native confirm:`, e);
                resolve(window.confirm(`${title}\n\n${body}`));
            }
        });
    }

    internal.confirmDisableSpoiler = function() {
        return internal.whenLoaded().then(function() {
            if (internal.getUserPrefs().SkipDisableConfirm) return true;
            if (internal.isDisableSnoozed()) return true;
            return showConfirmDialog();
        });
    };
})(window.JellyfinEnhanced);
