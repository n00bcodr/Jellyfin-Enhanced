/** Pure formatting for the details-page watch-progress / file-size chips. */

export interface WatchProgress { progress: number; totalPlaybackTicks: number; totalRuntimeTicks: number }
export type WatchProgressMode = 'percentage' | 'time' | 'remaining';

/** Bytes as a human-readable size (e.g. "1.5 GB"). */
export function formatSize(bytes: number): string {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    const formattedSize = parseFloat((bytes / Math.pow(k, i)).toFixed(2));
    return `${formattedSize} ${sizes[i]}`;
}

/** Ticks (100 ns) as "1h 5m", or in the "long" format "1y 2mo" / "3d 4h". */
export function timeString(ticks: number, format: string): string {
    const seconds = ticks / 10_000_000;
    const totalMinutes = Math.floor(seconds / 60);
    const totalHours = Math.floor(totalMinutes / 60);
    const totalDays = Math.floor(totalHours / 24);
    const totalMonths = Math.floor(totalDays / 30);
    const totalYears = Math.floor(totalDays / 365);

    let result = '';
    if (format === 'hours') {
        if (totalHours >= 1) {
            result += `${totalHours}h`;
            const minutes = totalMinutes % 60;
            if (minutes > 0) result += ` ${minutes}m`;
        } else if (totalMinutes > 0) {
            result = `${totalMinutes}m`;
        } else {
            result = '0m';
        }
    } else if (totalYears >= 1) {
        result += `${totalYears}y`;
        const months = Math.floor((totalDays % 365) / 30);
        if (months > 0) result += ` ${months}mo`;
    } else if (totalMonths >= 1) {
        result += `${totalMonths}mo`;
        const days = totalDays % 30;
        if (days > 0) result += ` ${days}d`;
    } else if (totalDays >= 1) {
        result += `${totalDays}d`;
        const hours = totalHours % 24;
        if (hours > 0) result += ` ${hours}h`;
    } else if (totalHours >= 1) {
        result += `${totalHours}h`;
        const minutes = totalMinutes % 60;
        if (minutes > 0) result += ` ${minutes}m`;
    } else if (totalMinutes > 0) {
        result = `${totalMinutes}m`;
    } else {
        result = '0m';
    }
    return result;
}

export function watchProgressText(progress: WatchProgress, mode: string, format: string): string {
    const safeTotal = Math.max(0, progress.totalRuntimeTicks || 0);
    const safePlayed = Math.max(0, Math.min(safeTotal, progress.totalPlaybackTicks || 0));
    if (mode === 'time') return `${timeString(safePlayed, format)} / ${timeString(safeTotal, format)}`;
    if (mode === 'remaining') {
        const remaining = Math.max(0, safeTotal - safePlayed);
        return `-${timeString(remaining, format)} / ${timeString(safeTotal, format)}`;
    }
    return `${progress.progress}%`;
}
export function nextWatchProgressMode(mode: string): WatchProgressMode {
    if (mode === 'percentage') return 'time';
    if (mode === 'time') return 'remaining';
    return 'percentage';
}
export function resolveWatchProgressMode(mode: string | undefined): WatchProgressMode {
    return mode === 'time' || mode === 'remaining' ? mode : 'percentage';
}

/** The progress ring (or check circle at 100%) shown before the value. */
export function progressIconSvg(progress: number): string {
    const circumference = 2 * Math.PI * 8; // radius = 8
    const offset = circumference - (progress / 100) * circumference;
    if (progress >= 100) {
        return `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" style="margin-right: 0.3em; display: inline-block; vertical-align: middle;">
                    <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/>
                    <path d="M9.5 15.5l-3-3 1.4-1.4L9.5 12.7l5.6-5.6 1.4 1.4z" fill="currentColor"/>
                </svg>`;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" style="margin-right: 0.3em; display: inline-block; vertical-align: middle;">
                <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2" opacity="0.2"/>
                <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"
                    style="stroke-dasharray: ${circumference}; stroke-dashoffset: ${offset}; transform: rotate(-90deg); transform-origin: 50% 50%; transition: stroke-dashoffset 0.3s ease;"/>
            </svg>`;
}

/** The /item-stats projection; missing or wrong-typed numbers count as 0. */
export interface ItemStats { size: number; progress: number; totalPlaybackTicks: number; totalRuntimeTicks: number }
