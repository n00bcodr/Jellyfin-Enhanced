import { own } from './ownership';
import { spoilerHost } from './host';
const { JE, internal, host } = spoilerHost();
const owner = own(JE, 'dialog', true);
    const logPrefix = '🪼 Jellyfin Enhanced [SpoilerGuard]:';

    function showConfirmDialog() {
        const token = owner.lease();
        const title = JE.t('spoiler_disable_confirm_title');
        const body = JE.t('spoiler_disable_confirm_body');
        const snoozeLabel = JE.t('spoiler_disable_confirm_snooze');
        const marker = `je-sb-snooze-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
        const escape = typeof JE.escapeHtml === 'function' ? JE.escapeHtml : (value: string) => String(value);
        const html = `<div>${escape(body)}</div>`
            + `<label class="${marker}" style="display:flex;align-items:center;gap:.5em;margin-top:1em;cursor:pointer;">`
            + `<input type="checkbox"><span>${escape(snoozeLabel)}</span></label>`;

        return new Promise<boolean>(function(resolve) {
            if (!host.Dashboard || typeof host.Dashboard.confirm !== 'function') {
                console.warn(`${logPrefix} Dashboard.confirm unavailable; using native confirm without snooze`);
                resolve(token.current() && window.confirm(`${title}\n\n${body}`));
                return;
            }

            if (!token.current()) { resolve(false); return; }
            const cancel = () => { cleanup(); resolve(false); };
            token.signal.addEventListener('abort', cancel, { once: true });
            let snoozeChecked = false;
            function captureChange(event: Event) {
                try {
                    const target = event.target;
                    if (target instanceof HTMLInputElement && target.type === 'checkbox' && target.closest(`.${marker}`)) {
                        snoozeChecked = !!target.checked;
                    }
                } catch (_) { /* never let a stray DOM event break the dialog */ }
            }
            function cleanup() { document.removeEventListener('change', captureChange, true); token.signal.removeEventListener('abort', cancel); }
            document.addEventListener('change', captureChange, true);
            try {
                host.Dashboard.confirm(html, title, function(ok) {
                    try {
                        const checkbox = (
                            document.querySelector<HTMLInputElement>(`.${marker} input[type="checkbox"]`)
                        );
                        if (checkbox) snoozeChecked = !!checkbox.checked;
                    } catch (_) { /* dialog DOM may already be gone */ }
                    cleanup();
                    const confirmed = !!ok && token.current();
                    if (confirmed && snoozeChecked) internal.setDisableSnooze();
                    resolve(confirmed);
                });
            } catch (e) {
                cleanup();
                console.warn(`${logPrefix} Dashboard.confirm failed; using native confirm:`, e);
                resolve(token.current() && window.confirm(`${title}\n\n${body}`));
            }
        });
    }

    internal.confirmDisableSpoiler = function() {
        const token = owner.lease();
        return internal.whenLoaded().then(function() {
            if (!token.current() || !internal.isLoadOk()) return false;
            if (internal.getUserPrefs().SkipDisableConfirm) return true;
            if (internal.isDisableSnoozed()) return true;
            return showConfirmDialog();
        });
    };
