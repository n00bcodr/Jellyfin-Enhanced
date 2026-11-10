import type { SeerrCoreHost } from '../../host-core';
import type { SeerrUiFacade } from '../contract';
import { isUserQuota } from '../decode';
import { formatNextReset, formatQuotaLine } from '../display';
import type { QuotaSide } from '../types';
import { LOG_UI, captureOrigin, classifyFailure, errorBody, escapeWith, firstInstall, groupInternals, uncertainMessage } from '../runtime';

/**
 * Request-quota helpers. Seerr enforces a rolling per-user quota and answers
 * 403 {"message": "Movie Quota exceeded."}; these render a proactive chip and
 * a detailed dialog instead of a vanishing toast.
 */
export function installQuota(host: SeerrCoreHost): void {
    const { JE, document } = host;
    if (!firstInstall(JE, 'ui-quota')) return;
    const ui: Partial<SeerrUiFacade> = JE.jellyseerrUI ||= {};
    const internals = groupInternals(JE);
    const escapeHtml = escapeWith(JE);
    const t = JE.t;
    const quotaEnabled = () => JE.pluginConfig?.JellyseerrShowQuotaInfo !== false;

    /** A 403 quota rejection; false when the admin turned quota info off (the toast is used instead). */
    function isQuotaError(error: unknown): boolean {
        return quotaEnabled() && classifyFailure(error, true) === 'quota';
    }
    const nextReset = (resetAt: unknown) => formatNextReset(resetAt, Date.now(), t);
    const quotaLine = (quota: QuotaSide | null | undefined, type: string) => formatQuotaLine(quota, type, Date.now(), t);

    /** The chip for the relevant side, or null when it is unlimited. */
    function buildQuotaChip(value: unknown, mediaType: string): HTMLElement | null {
        if (!isUserQuota(value)) return null;
        const side = mediaType === 'tv' ? value.tv : value.movie;
        const line = quotaLine(side, mediaType === 'tv' ? 'tv' : 'movie');
        if (!line.text || line.unlimited) return null;
        const chip = document.createElement('div');
        chip.className = 'jellyseerr-quota-chip';
        const remaining = Number(side?.remaining);
        if (line.restricted) chip.classList.add('jellyseerr-quota-chip-restricted');
        else if (remaining > 0 && remaining <= 2) chip.classList.add('jellyseerr-quota-chip-warning');
        chip.textContent = line.text;
        const sub = (text: string) => {
            const element = document.createElement('div');
            element.className = 'jellyseerr-quota-chip-sub';
            element.textContent = text;
            chip.appendChild(element);
        };
        if (line.restricted) sub(t('jellyseerr_quota_restricted_hint'));
        if (line.resetText) sub(line.resetText);
        return chip;
    }

    /** A themed dialog with the quota numbers and reset hint, after a quota rejection. */
    async function showQuotaErrorDialog(error: unknown, mediaType: string): Promise<void> {
        const origin = captureOrigin(host);
        const quota = await JE.jellyseerrAPI?.fetchUserQuota?.({ skipCache: true }) ?? null;
        if (!origin.current()) return;
        const upstreamMessage = errorBody(error).message || '';
        const lines: string[] = [];
        if (upstreamMessage) lines.push(upstreamMessage);
        if (quota) {
            const movie = quotaLine(quota.movie, 'movie');
            const tv = quotaLine(quota.tv, 'tv');
            // The rejected side first; the other is informational.
            const [lead, other] = mediaType === 'tv' ? [tv, movie] : [movie, tv];
            if (lead.text) lines.push(lead.text);
            if (lead.resetText) lines.push(lead.resetText);
            if (other.text) lines.push(other.text);
        }
        lines.push(t('jellyseerr_quota_dialog_hint'));
        const title = t('jellyseerr_quota_dialog_title');
        // Dashboard.alert renders sanitized HTML: escape every line, <br><br> between them.
        const message = lines.map(line => escapeHtml(line)).join('<br><br>');
        // Themes can stub Dashboard with broken functions: fall back to a toast.
        const dashboard = host.window.Dashboard;
        if (typeof dashboard?.alert === 'function') {
            try {
                dashboard.alert({ title, message });
                return;
            } catch (dialogError) {
                console.warn(`${LOG_UI} Dashboard.alert threw, falling back to toast:`, dialogError);
            }
        }
        if (!origin.current()) return;
        JE.toast?.(escapeHtml(`${title}: ${lines.join(' — ')}`), 8000);
    }

    /**
     * A modal's request failed: the quota dialog, the server's message, or — when
     * the request may have been applied — a status-unknown notice. The request
     * button is restored for an explicit retry; nothing is retried automatically.
     */
    async function handleRequestError(error: unknown, mediaType: string, requestBtn: HTMLButtonElement | null, resetLabel: string): Promise<void> {
        const origin = captureOrigin(host);
        const kind = classifyFailure(error, quotaEnabled());
        if (isQuotaError(error)) {
            await showQuotaErrorDialog(error, mediaType);
        } else if (kind === 'uncertain') {
            JE.toast?.(escapeHtml(uncertainMessage(JE)), 6000);
        } else {
            const upstream = errorBody(error).message;
            JE.toast?.(upstream ? escapeHtml(upstream) : t('jellyseerr_modal_toast_request_fail'), 4000);
        }
        if (!origin.current()) return;
        if (requestBtn) {
            requestBtn.disabled = false;
            requestBtn.textContent = resetLabel;
        }
    }

    ui.isQuotaError = isQuotaError;
    ui.showQuotaErrorDialog = showQuotaErrorDialog;
    ui.buildQuotaChip = buildQuotaChip;
    internals.isQuotaError = isQuotaError;
    internals.formatNextReset = nextReset;
    internals.formatQuotaLine = quotaLine;
    internals.buildQuotaChip = buildQuotaChip;
    internals.showQuotaErrorDialog = showQuotaErrorDialog;
    internals.handleRequestError = handleRequestError;
}
