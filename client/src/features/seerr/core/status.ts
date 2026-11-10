/**
 * Seerr's status enums and every status-driven display decision. Values match
 * Seerr's server/constants/media.ts and server/constants/request.ts. Pure: no
 * browser globals, so all consumers (and other bundles) share one definition.
 */
export const MEDIA = Object.freeze({
    UNKNOWN: 1,
    PENDING: 2,
    PROCESSING: 3,
    PARTIALLY_AVAILABLE: 4,
    AVAILABLE: 5,
    BLOCKED: 6,
    DELETED: 7
});
export const REQUEST = Object.freeze({
    PENDING: 1,
    APPROVED: 2,
    DECLINED: 3,
    FAILED: 4,
    COMPLETED: 5
});
export const DISPLAY = Object.freeze({
    AVAILABLE: 'available',
    AVAILABLE_UPDATING: 'available-updating',
    PENDING: 'pending',
    PROCESSING: 'processing',
    REQUESTED: 'requested',
    PARTIAL: 'partial',
    BLOCKED: 'blocked',
    DELETED: 'deleted',
    NONE: 'none'
});
export type DisplayStatus = typeof DISPLAY[keyof typeof DISPLAY];
export type IconKey = 'available' | 'pending' | 'requested' | 'partially_available' | 'cancel' | 'request' | '';
export interface ButtonConfig { labelKey: string; cssClass: string; disabled: boolean; showSpinner: boolean; iconKey: IconKey }
export interface LabelConfig { labelKey: string; cssClass: string }
export interface BadgeConfig { icon: string; cssClass: string }

/** A status that permits a new request: absent/0, UNKNOWN, or DELETED. */
export function isRequestable(mediaStatus: number | null | undefined): boolean {
    return !mediaStatus || mediaStatus === MEDIA.UNKNOWN || mediaStatus === MEDIA.DELETED;
}
/** Any status other than "never touched". */
export function hasStatus(mediaStatus: number | null | undefined): boolean {
    return !!mediaStatus && mediaStatus !== MEDIA.UNKNOWN;
}
/** Demotes a stale AVAILABLE to DELETED when Jellyfin no longer has the item (or season). */
export function effectiveMediaStatus(rawStatus: number | null | undefined, jellyfinId: unknown,
    jellyfinSeasonMap: Readonly<Record<number, boolean>> | null = null, seasonNumber: number | null = null): number {
    const status = rawStatus ?? MEDIA.UNKNOWN;
    if (status !== MEDIA.AVAILABLE) return status;
    if (jellyfinSeasonMap !== null && seasonNumber !== null) return jellyfinSeasonMap[seasonNumber] ? MEDIA.AVAILABLE : MEDIA.DELETED;
    return jellyfinId ? MEDIA.AVAILABLE : MEDIA.DELETED;
}
export function resolveDisplayStatus(status: number | null | undefined, hasActiveDownloads = false): DisplayStatus {
    switch (status) {
        case MEDIA.AVAILABLE: return hasActiveDownloads ? DISPLAY.AVAILABLE_UPDATING : DISPLAY.AVAILABLE;
        case MEDIA.PENDING: return DISPLAY.PENDING;
        case MEDIA.PROCESSING: return hasActiveDownloads ? DISPLAY.PROCESSING : DISPLAY.REQUESTED;
        case MEDIA.PARTIALLY_AVAILABLE: return DISPLAY.PARTIAL;
        case MEDIA.BLOCKED: return DISPLAY.BLOCKED;
        case MEDIA.DELETED: return DISPLAY.DELETED;
        default: return DISPLAY.NONE;
    }
}
export function getButtonConfig(displayStatus: string): ButtonConfig {
    switch (displayStatus) {
        case DISPLAY.AVAILABLE: return { labelKey: 'jellyseerr_btn_available', cssClass: 'jellyseerr-button-available', disabled: true, showSpinner: false, iconKey: 'available' };
        case DISPLAY.AVAILABLE_UPDATING: return { labelKey: 'jellyseerr_btn_available', cssClass: 'jellyseerr-button-available-updating', disabled: true, showSpinner: true, iconKey: 'available' };
        case DISPLAY.PENDING: return { labelKey: 'jellyseerr_btn_pending', cssClass: 'jellyseerr-button-pending', disabled: true, showSpinner: false, iconKey: 'pending' };
        case DISPLAY.PROCESSING: return { labelKey: 'jellyseerr_btn_processing', cssClass: 'jellyseerr-button-processing', disabled: true, showSpinner: true, iconKey: '' };
        case DISPLAY.REQUESTED: return { labelKey: 'jellyseerr_btn_requested', cssClass: 'jellyseerr-button-pending', disabled: true, showSpinner: false, iconKey: 'requested' };
        case DISPLAY.PARTIAL: return { labelKey: 'jellyseerr_btn_partially_available', cssClass: 'jellyseerr-button-partially-available', disabled: true, showSpinner: false, iconKey: 'partially_available' };
        case DISPLAY.BLOCKED: return { labelKey: 'jellyseerr_btn_blocklisted', cssClass: 'jellyseerr-button-blocklisted', disabled: true, showSpinner: false, iconKey: 'cancel' };
        default: return { labelKey: 'jellyseerr_btn_request', cssClass: 'jellyseerr-button-request', disabled: false, showSpinner: false, iconKey: 'request' };
    }
}

const AVAILABLE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clip-rule="evenodd" /></svg>`;
const BADGE_ICONS: Readonly<Record<string, string>> = {
    [DISPLAY.AVAILABLE]: AVAILABLE_ICON,
    [DISPLAY.AVAILABLE_UPDATING]: AVAILABLE_ICON,
    [DISPLAY.PENDING]: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M5.25 9a6.75 6.75 0 0113.5 0v.75c0 2.123.8 4.057 2.118 5.52a.75.75 0 01-.297 1.206c-1.544.57-3.16.99-4.831 1.243a3.75 3.75 0 11-7.48 0 24.585 24.585 0 01-4.831-1.244.75.75 0 01-.298-1.205A8.217 8.217 0 005.25 9.75V9zm4.502 8.9a2.25 2.25 0 104.496 0 25.057 25.057 0 01-4.496 0z" clip-rule="evenodd" /></svg>`,
    [DISPLAY.PROCESSING]: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10" stroke-opacity="0.25"/><path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round"/></svg>`,
    [DISPLAY.REQUESTED]: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M12 2.25c-5.385 0-9.75 4.365-9.75 9.75s4.365 9.75 9.75 9.75 9.75-4.365 9.75-9.75S17.385 2.25 12 2.25zM12.75 6a.75.75 0 00-1.5 0v6c0 .414.336.75.75.75h4.5a.75.75 0 000-1.5h-3.75V6z" clip-rule="evenodd"></path></svg>`,
    [DISPLAY.PARTIAL]: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM6.75 9.25a.75.75 0 000 1.5h6.5a.75.75 0 000-1.5h-6.5z" clip-rule="evenodd" /></svg>`,
    [DISPLAY.BLOCKED]: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z" clip-rule="evenodd" /></svg>`,
    [DISPLAY.DELETED]: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.52.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4zM8.58 7.72a.75.75 0 00-1.5.06l.3 7.5a.75.75 0 101.5-.06l-.3-7.5zm4.34.06a.75.75 0 10-1.5-.06l-.3 7.5a.75.75 0 101.5.06l.3-7.5z" clip-rule="evenodd" /></svg>`
};
const BADGE_CSS: Readonly<Record<string, string>> = {
    [DISPLAY.AVAILABLE]: 'status-available',
    [DISPLAY.AVAILABLE_UPDATING]: 'status-available',
    [DISPLAY.PENDING]: 'status-pending',
    [DISPLAY.PROCESSING]: 'status-processing',
    [DISPLAY.REQUESTED]: 'status-requested',
    [DISPLAY.PARTIAL]: 'status-partially-available',
    [DISPLAY.BLOCKED]: 'status-blocklisted',
    [DISPLAY.DELETED]: 'status-deleted'
};
/** The card badge for a display state, or null when no badge is shown. */
export function getBadgeConfig(displayStatus: string): BadgeConfig | null {
    const icon = BADGE_ICONS[displayStatus];
    const cssClass = BADGE_CSS[displayStatus];
    if (!icon || !cssClass) return null;
    return { icon, cssClass };
}
/** A season row's label and class; active downloads distinguish processing from requested. */
export function getDisplayInfo(mediaStatus: number | null | undefined, hasActiveDownloads = false): LabelConfig {
    switch (mediaStatus) {
        case MEDIA.PENDING:
        case MEDIA.PROCESSING:
            return { labelKey: hasActiveDownloads ? 'jellyseerr_season_status_processing' : 'jellyseerr_season_status_requested', cssClass: 'processing' };
        case MEDIA.PARTIALLY_AVAILABLE: return { labelKey: 'jellyseerr_season_status_partial', cssClass: 'partially-available' };
        case MEDIA.AVAILABLE: return { labelKey: 'jellyseerr_season_status_available', cssClass: 'available' };
        case MEDIA.BLOCKED: return { labelKey: 'jellyseerr_status_blocked', cssClass: 'blocked' };
        default: return { labelKey: 'jellyseerr_season_status_not_requested', cssClass: 'not-requested' };
    }
}
/** The More Info status chip for a display state. */
export function getChipConfig(displayStatus: string): LabelConfig {
    switch (displayStatus) {
        case DISPLAY.AVAILABLE:
        case DISPLAY.AVAILABLE_UPDATING:
            return { labelKey: 'jellyseerr_btn_available', cssClass: 'chip-available' };
        case DISPLAY.PARTIAL: return { labelKey: 'jellyseerr_btn_partially_available', cssClass: 'chip-partial' };
        case DISPLAY.PROCESSING: return { labelKey: 'jellyseerr_btn_processing', cssClass: 'chip-processing' };
        case DISPLAY.PENDING:
        case DISPLAY.REQUESTED:
            return { labelKey: 'jellyseerr_btn_requested', cssClass: 'chip-requested' };
        case DISPLAY.BLOCKED: return { labelKey: 'jellyseerr_btn_blocklisted', cssClass: 'chip-blocklisted' };
        case DISPLAY.DELETED: return { labelKey: 'jellyseerr_btn_deleted', cssClass: 'chip-deleted' };
        default: return { labelKey: 'jellyseerr_btn_requested', cssClass: 'chip-requested' };
    }
}

export function createStatusFacade() {
    return { MEDIA, REQUEST, DISPLAY, isRequestable, hasStatus, effectiveMediaStatus, resolveDisplayStatus,
        getButtonConfig, getBadgeConfig, getDisplayInfo, getChipConfig };
}
