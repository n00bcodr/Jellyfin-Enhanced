// /js/jellyseerr/ui/ui-quota.js
// Request-quota helpers: error detection, quota chip and error dialog.
(function(JE) {
    'use strict';

    const ui = JE.jellyseerrUI = JE.jellyseerrUI || {};
    JE.internals = JE.internals || {};
    // Shared state is seeded by ui-icons.js, which plugin.js loads first
    // in this group.
    const internal = JE.internals.jellyseerrUi;
    const logPrefix = '🪼 Jellyfin Enhanced: Seerr UI:';
    const escapeHtml = JE.escapeHtml;



    // QUOTA HELPERS
    // Seerr enforces a per-user rolling-window request quota. When hit it returns
    // 403 with {"message":"Movie Quota exceeded."} — these helpers render a
    // proactive chip and a detailed dialog instead of a vanishing toast.

    // Detect Seerr quota-exceeded errors (403 with "Quota exceeded" message).
    // Returns false when the admin has disabled quota info — falls back to the toast.
    function isQuotaError(error) {
        if (JE.pluginConfig?.JellyseerrShowQuotaInfo === false) return false;
        if (error?.status !== 403) return false;
        return /quota\s+exceeded/i.test(error.responseJSON?.message || '');
    }

    // Format a reset timestamp as "Next slot frees in about X min/h/days".
    function formatNextReset(resetAt) {
        if (!resetAt) return '';
        const ts = new Date(resetAt).getTime();
        if (!Number.isFinite(ts)) return '';

        const deltaMs = ts - Date.now();
        if (deltaMs <= 0) return JE.t('jellyseerr_quota_reset_now');

        const minutes = Math.round(deltaMs / 60_000);
        const hours = Math.round(deltaMs / 3_600_000);
        const days = Math.round(deltaMs / 86_400_000);

        if (minutes < 60) return JE.t('jellyseerr_quota_reset_in_minutes', { minutes: Math.max(1, minutes) });
        if (hours < 36) return JE.t('jellyseerr_quota_reset_in_hours', { hours });
        return JE.t('jellyseerr_quota_reset_in_days', { days });
    }

    function formatQuotaLine(q, type) {
        if (!q) return { text: '', restricted: false, unlimited: true, resetText: '' };
        const limit = Number(q.limit) || 0;
        const used = Number(q.used) || 0;
        const days = Number(q.days) || 0;
        const restricted = !!q.restricted;
        const unlimited = limit <= 0;

        const label = JE.t(type === 'tv' ? 'jellyseerr_quota_label_tv' : 'jellyseerr_quota_label_movie');

        if (unlimited) {
            return {
                text: JE.t('jellyseerr_quota_unlimited', { label }),
                restricted: false,
                unlimited: true,
                resetText: ''
            };
        }

        const usagePart = days > 0
            ? JE.t('jellyseerr_quota_usage_window', { label, used, limit, days })
            : JE.t('jellyseerr_quota_usage', { label, used, limit });

        return {
            text: usagePart,
            restricted,
            unlimited: false,
            resetText: formatNextReset(q.nextResetAt)
        };
    }

    // Returns the chip element for the relevant quota side, or null when unlimited.
    function buildQuotaChip(quota, mediaType) {
        if (!quota) return null;

        const side = mediaType === 'tv' ? quota.tv : quota.movie;
        const line = formatQuotaLine(side, mediaType === 'tv' ? 'tv' : 'movie');
        if (!line.text || line.unlimited) return null;

        const chip = document.createElement('div');
        chip.className = 'jellyseerr-quota-chip';
        if (line.restricted) chip.classList.add('jellyseerr-quota-chip-restricted');
        else if (Number(side?.remaining) > 0 && Number(side?.remaining) <= 2) {
            chip.classList.add('jellyseerr-quota-chip-warning');
        }

        chip.textContent = line.text;

        if (line.restricted) {
            const sub = document.createElement('div');
            sub.className = 'jellyseerr-quota-chip-sub';
            sub.textContent = JE.t('jellyseerr_quota_restricted_hint');
            chip.appendChild(sub);
        }

        if (line.resetText) {
            const reset = document.createElement('div');
            reset.className = 'jellyseerr-quota-chip-sub';
            reset.textContent = line.resetText;
            chip.appendChild(reset);
        }

        return chip;
    }

    // Show a themed dialog with quota numbers + reset hint after a quota error.
    async function showQuotaErrorDialog(error, mediaType) {
        const quota = await JE.jellyseerrAPI?.fetchUserQuota?.({ skipCache: true });
        const upstreamMessage = error?.responseJSON?.message || '';
        const lines = [];
        if (upstreamMessage) lines.push(upstreamMessage);

        if (quota) {
            const movieLine = formatQuotaLine(quota.movie, 'movie');
            const tvLine = formatQuotaLine(quota.tv, 'tv');
            // Lead with the rejected side; the other side is informational.
            if (mediaType === 'tv') {
                if (tvLine.text) lines.push(tvLine.text);
                if (tvLine.resetText) lines.push(tvLine.resetText);
                if (movieLine.text) lines.push(movieLine.text);
            } else {
                if (movieLine.text) lines.push(movieLine.text);
                if (movieLine.resetText) lines.push(movieLine.resetText);
                if (tvLine.text) lines.push(tvLine.text);
            }
        }

        lines.push(JE.t('jellyseerr_quota_dialog_hint'));

        const title = JE.t('jellyseerr_quota_dialog_title');
        // Dashboard.alert sanitizes message as HTML, collapsing \n. Use <br><br>
        // for visible paragraph breaks; escape every line first since the upstream
        // Seerr message could contain HTML metacharacters.
        const message = lines.map(escapeHtml).join('<br><br>');

        // Themes / forks can monkey-patch Dashboard with broken stubs; fall back to toast.
        if (typeof window.Dashboard?.alert === 'function') {
            try {
                window.Dashboard.alert({ title, message });
                return;
            } catch (err) {
                console.warn(`${logPrefix} Dashboard.alert threw, falling back to toast:`, err);
            }
        }
        JE.toast(escapeHtml(`${title}: ${lines.join(' — ')}`), 8000);
    }

    async function handleRequestError(error, mediaType, requestBtn, resetLabel) {
        if (isQuotaError(error)) {
            await showQuotaErrorDialog(error, mediaType);
        } else {
            const upstream = error?.responseJSON?.message;
            JE.toast(upstream ? escapeHtml(upstream) : JE.t('jellyseerr_modal_toast_request_fail'), 4000);
        }
        if (requestBtn) {
            requestBtn.disabled = false;
            requestBtn.textContent = resetLabel;
        }
    }

    // Exposed so jellyseerr.js / more-info/ can use the same dialog + chip.
    ui.isQuotaError = isQuotaError;
    ui.showQuotaErrorDialog = showQuotaErrorDialog;
    ui.buildQuotaChip = buildQuotaChip;
    internal.isQuotaError = isQuotaError;
    internal.formatNextReset = formatNextReset;
    internal.formatQuotaLine = formatQuotaLine;
    internal.buildQuotaChip = buildQuotaChip;
    internal.showQuotaErrorDialog = showQuotaErrorDialog;
    internal.handleRequestError = handleRequestError;

})(window.JellyfinEnhanced);
