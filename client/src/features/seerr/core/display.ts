import type { Translate } from '../host-core';
import type { QuotaLine, SeasonAnalysis } from './contract';
import { isNumber, isRecord, isString } from './decode';
import { MEDIA } from './status';
import type { QuotaSide, SeerrMediaItem } from './types';

/** Pure display rules shared by the Seerr UI entries. Time and translation are supplied by the caller. */

/** "Estimated in …" for a download's ETA (English, as before), or null when unknown. */
export function formatEtaText(downloadStatus: unknown, now: number): string | null {
    if (!isRecord(downloadStatus)) return null;
    const rawEta = downloadStatus.estimatedCompletionTime;
    if (!rawEta || !(isString(rawEta) || isNumber(rawEta))) return null;
    const timeUntilMs = new Date(rawEta).getTime() - now;
    if (Number.isNaN(timeUntilMs)) return null;
    if (timeUntilMs <= 0) return 'Estimated soon';
    const minutes = Math.round(timeUntilMs / 60000);
    if (minutes >= 1440) {
        const days = Math.round(minutes / 1440);
        return `Estimated in ${days} day${days !== 1 ? 's' : ''}`;
    }
    if (minutes >= 60) {
        const hours = Math.round(minutes / 60);
        return `Estimated in ${hours} hour${hours !== 1 ? 's' : ''}`;
    }
    return `Estimated in ${minutes} min`;
}
/** Download progress 0–100 from size/sizeLeft, or null without a usable size. */
export function progressPercent(size: unknown, sizeLeft: unknown): number | null {
    if (!isNumber(size) || !isNumber(sizeLeft) || size <= 0) return null;
    return Math.max(0, Math.min(100, Math.round(100 * (1 - sizeLeft / size))));
}
export const capitalize = (value: string): string => value.replace(/^./, c => c.toUpperCase());

/** Overall TV status and summary from a show's season statuses (Specials counted separately). */
export function analyzeSeasonStatuses(seasons: unknown, t: Translate): SeasonAnalysis {
    if (!Array.isArray(seasons) || seasons.length === 0) return { overallStatus: MEDIA.UNKNOWN, statusSummary: null, total: 0 };
    const entries = seasons.filter(isRecord);
    const regular = entries.filter(s => isNumber(s.seasonNumber) && s.seasonNumber > 0);
    const total = regular.length;
    if (total === 0) return { overallStatus: MEDIA.UNKNOWN, statusSummary: null, total: 0 };
    const count = (status: number) => regular.filter(s => s.status === status).length;
    const available = count(MEDIA.AVAILABLE);
    const pending = count(MEDIA.PENDING);
    const processing = count(MEDIA.PROCESSING);
    const partiallyAvailable = count(MEDIA.PARTIALLY_AVAILABLE);
    const notRequested = count(MEDIA.UNKNOWN);
    const requestedCount = pending + processing;
    const availableCount = available + partiallyAvailable;
    const accountedForCount = requestedCount + availableCount;
    let overallStatus: number;
    let statusSummary: string | null = null;
    if (notRequested === 0) {
        overallStatus = availableCount === total ? MEDIA.AVAILABLE : MEDIA.DELETED;
        if (overallStatus === MEDIA.DELETED) statusSummary = t('jellyseerr_seasons_accounted_for', { count: accountedForCount, total });
    } else if (accountedForCount > 0) {
        overallStatus = availableCount > 0 ? MEDIA.PARTIALLY_AVAILABLE : MEDIA.PROCESSING;
        statusSummary = availableCount > 0
            ? t('jellyseerr_seasons_available_count', { count: availableCount, total })
            : t('jellyseerr_seasons_requested_count', { count: requestedCount, total });
    } else {
        overallStatus = MEDIA.UNKNOWN;
    }
    // Every regular season accounted for but Specials never requested: still offer "Request More".
    if (overallStatus === MEDIA.AVAILABLE) {
        const specials = entries.find(s => s.seasonNumber === 0);
        if (specials && specials.status === MEDIA.UNKNOWN) {
            overallStatus = MEDIA.DELETED;
            statusSummary = t('jellyseerr_seasons_accounted_for', { count: accountedForCount, total });
        }
    }
    return { overallStatus, statusSummary, total, availableCount };
}

export function hasDownloads(item: SeerrMediaItem): boolean {
    return (item.mediaInfo?.downloadStatus?.length ?? 0) > 0 || (item.mediaInfo?.downloadStatus4k?.length ?? 0) > 0;
}

/** "You can make another request in about …" for a quota reset time. */
export function formatNextReset(resetAt: unknown, now: number, t: Translate): string {
    if (!resetAt || !(isString(resetAt) || isNumber(resetAt))) return '';
    const ts = new Date(resetAt).getTime();
    if (!Number.isFinite(ts)) return '';
    const deltaMs = ts - now;
    if (deltaMs <= 0) return t('jellyseerr_quota_reset_now');
    const minutes = Math.round(deltaMs / 60_000);
    const hours = Math.round(deltaMs / 3_600_000);
    const days = Math.round(deltaMs / 86_400_000);
    if (minutes < 60) return t('jellyseerr_quota_reset_in_minutes', { minutes: Math.max(1, minutes) });
    if (hours < 36) return t('jellyseerr_quota_reset_in_hours', { hours });
    return t('jellyseerr_quota_reset_in_days', { days });
}
const numberOf = (value: unknown): number => Number(value) || 0;
export function formatQuotaLine(quota: QuotaSide | null | undefined, type: string, now: number, t: Translate): QuotaLine {
    if (!quota) return { text: '', restricted: false, unlimited: true, resetText: '' };
    const limit = numberOf(quota.limit);
    const used = numberOf(quota.used);
    const days = numberOf(quota.days);
    const label = t(type === 'tv' ? 'jellyseerr_quota_label_tv' : 'jellyseerr_quota_label_movie');
    if (limit <= 0) return { text: t('jellyseerr_quota_unlimited', { label }), restricted: false, unlimited: true, resetText: '' };
    return {
        text: days > 0 ? t('jellyseerr_quota_usage_window', { label, used, limit, days }) : t('jellyseerr_quota_usage', { label, used, limit }),
        restricted: !!quota.restricted,
        unlimited: false,
        resetText: formatNextReset(quota.nextResetAt, now, t)
    };
}
