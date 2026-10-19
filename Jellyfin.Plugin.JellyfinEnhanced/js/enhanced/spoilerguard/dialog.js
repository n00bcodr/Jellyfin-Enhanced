// @ts-check
// Disable-confirm dialog and its Jellyfin/native fallback.
(function(JE) {
    'use strict';

    JE.internals = JE.internals || {};
    /** @type {any} Shared cross-file namespace; each module contributes a focused surface. */
    const internal = JE.internals.spoilerGuard = JE.internals.spoilerGuard || {};

    /** Opens an owned dialog so session changes can dismiss it and settle its promise. */
    function showConfirmDialog(action) {
        return new Promise(function(resolve) {
            const dialog = document.createElement('dialog');
            dialog.className = 'je-spoiler-confirm-dialog';
            dialog.setAttribute('aria-labelledby', 'je-spoiler-confirm-title');
            const heading = document.createElement('h3');
            heading.id = 'je-spoiler-confirm-title';
            heading.textContent = JE.t('spoiler_disable_confirm_title');
            const body = document.createElement('p');
            body.textContent = JE.t('spoiler_disable_confirm_body');
            const label = document.createElement('label');
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            label.append(checkbox, document.createTextNode(JE.t('spoiler_disable_confirm_snooze')));
            const buttons = document.createElement('div');
            const cancel = document.createElement('button');
            cancel.textContent = JE.t('hidden_content_confirm_cancel');
            const accept = document.createElement('button');
            accept.className = 'je-spoiler-confirm-accept';
            accept.textContent = JE.t('spoiler_disable_confirm_accept');
            buttons.append(cancel, accept);
            dialog.append(heading, body, label, buttons);
            let settled = false;
            /** Settles once, removes owned UI, and never snoozes the incoming viewer's dialog. */
            function finish(ok) {
                if (settled) return;
                settled = true;
                const confirmed = ok && action.current();
                if (confirmed && checkbox.checked) internal.setDisableSnooze();
                release();
                releaseScope();
                dialog.close?.();
                dialog.remove();
                resolve(confirmed);
            }
            const release = action.onCancel(() => finish(false));
            // Asked for a title action: the dialog is in that operation's scope and closes (declined) once it ends.
            const releaseScope = JE.openSurface(dialog, () => finish(false), action.operation);
            cancel.onclick = () => finish(false);
            accept.onclick = () => finish(true);
            dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false); });
            dialog.addEventListener('close', () => finish(false));
            document.body.appendChild(dialog);
            if (typeof dialog.showModal === 'function') dialog.showModal();
            else dialog.setAttribute('open', '');
            cancel.focus();
        });
    }

    internal.confirmDisableSpoiler = function() {
        const action = JE.createSessionAction({ submitted: true });
        return internal.whenLoaded().then(function() {
            if (!action.current()) return false;
            if (internal.getUserPrefs().SkipDisableConfirm) return true;
            if (internal.isDisableSnoozed()) return true;
            return showConfirmDialog(action);
        });
    };
})(window.JellyfinEnhanced);
