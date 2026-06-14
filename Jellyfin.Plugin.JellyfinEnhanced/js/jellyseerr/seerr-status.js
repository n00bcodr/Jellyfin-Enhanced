// /js/jellyseerr/seerr-status.js
// Single source of truth for Seerr's status enums and all status-driven display decisions.
// Values match Seerr's TypeScript source (server/constants/media.ts and
// server/constants/request.ts). All consumers reference JE.seerrStatus
// instead of scattering magic integers or display logic across the codebase.
(function(JE) {
    'use strict';

    const seerrStatus = {};

    // ── Seerr API enums ──────────────────────────────────────────────────────

    // Seerr MediaStatus enum (server/constants/media.ts)
    seerrStatus.MEDIA = Object.freeze({
        UNKNOWN:             1,
        PENDING:             2,
        PROCESSING:          3,
        PARTIALLY_AVAILABLE: 4,
        AVAILABLE:           5,
        BLOCKED:             6,
        DELETED:             7
    });

    // Seerr RequestStatus enum (server/constants/request.ts)
    seerrStatus.REQUEST = Object.freeze({
        PENDING:   1,
        APPROVED:  2,
        DECLINED:  3,
        FAILED:    4,
        COMPLETED: 5
    });

    const M = seerrStatus.MEDIA;

    // ── Display state ────────────────────────────────────────────────────────

    // Canonical UI display states. PROCESSING vs REQUESTED distinguishes
    // "actively downloading" from "queued, waiting". AVAILABLE_UPDATING means
    // the item is in the library but a quality upgrade is downloading.
    seerrStatus.DISPLAY = Object.freeze({
        AVAILABLE:          'available',
        AVAILABLE_UPDATING: 'available-updating',
        PENDING:            'pending',
        PROCESSING:         'processing',
        REQUESTED:          'requested',
        PARTIAL:            'partial',
        BLOCKED:            'blocked',
        DELETED:            'deleted',
        NONE:               'none',
    });

    const DisplayStatus = seerrStatus.DISPLAY;

    // ── Status helpers ───────────────────────────────────────────────────────

    /**
     * Returns true when a media status permits a new request.
     * Absent/0 and UNKNOWN (never touched), plus DELETED (prior request removed),
     * are all requestable. Everything else is already in flight or fulfilled.
     * @param {number|undefined} mediaStatus
     * @returns {boolean}
     */
    seerrStatus.isRequestable = function(mediaStatus) {
        return !mediaStatus || mediaStatus === M.UNKNOWN || mediaStatus === M.DELETED;
    };

    /**
     * Returns true when the status indicates any non-trivial Seerr activity
     * (i.e. something other than "never touched").
     * @param {number|undefined} mediaStatus
     * @returns {boolean}
     */
    seerrStatus.hasStatus = function(mediaStatus) {
        return !!mediaStatus && mediaStatus !== M.UNKNOWN;
    };

    /**
     * Resolves the effective media status, demoting stale AVAILABLE (5) to
     * DELETED (7) when Jellyfin's own data confirms the item is no longer in
     * the library.
     *
     * @param {number|undefined} rawStatus
     * @param {string|null}      jellyfinId        — series/movie Jellyfin ID (may be stale)
     * @param {Object|null}      [jellyfinSeasonMap] — presence map { [seasonNum]: true }
     * @param {number|null}      [seasonNumber]      — season to check in the map
     * @returns {number} effective status
     */
    seerrStatus.effectiveMediaStatus = function(rawStatus, jellyfinId, jellyfinSeasonMap = null, seasonNumber = null) {
        const status = rawStatus ?? M.UNKNOWN;
        if (status !== M.AVAILABLE) return status;

        if (jellyfinSeasonMap !== null && seasonNumber !== null) {
            return jellyfinSeasonMap[seasonNumber] ? M.AVAILABLE : M.DELETED;
        }
        return jellyfinId ? M.AVAILABLE : M.DELETED;
    };

    // ── Display resolution ───────────────────────────────────────────────────

    /**
     * Resolves the canonical UI display state for an item, accounting for
     * active downloads to distinguish "downloading now" (PROCESSING) from
     * "queued with no active transfer" (REQUESTED), and "library item being
     * upgraded" (AVAILABLE_UPDATING) from a plain AVAILABLE item.
     *
     * @param {number|undefined} status            — raw Seerr MediaStatus
     * @param {boolean}          [hasActiveDownloads=false]
     * @returns {string} one of seerrStatus.DISPLAY.*
     */
    seerrStatus.resolveDisplayStatus = function(status, hasActiveDownloads = false) {
        switch (status) {
            case M.AVAILABLE:
                return hasActiveDownloads ? DisplayStatus.AVAILABLE_UPDATING : DisplayStatus.AVAILABLE;
            case M.PENDING:
                return DisplayStatus.PENDING;
            case M.PROCESSING:
                return hasActiveDownloads ? DisplayStatus.PROCESSING : DisplayStatus.REQUESTED;
            case M.PARTIALLY_AVAILABLE:
                return DisplayStatus.PARTIAL;
            case M.BLOCKED:
                return DisplayStatus.BLOCKED;
            case M.DELETED:
                return DisplayStatus.DELETED;
            default:
                return DisplayStatus.NONE;
        }
    };

    // ── Button config ────────────────────────────────────────────────────────

    /**
     * Returns button rendering config for a given display state.
     * iconKey maps to the 'icons' object in ui.js; '' means no button icon.
     *
     * @param {string} displayStatus — one of seerrStatus.DISPLAY.*
     * @returns {{ labelKey: string, cssClass: string, disabled: boolean, showSpinner: boolean, iconKey: string }}
     */
    seerrStatus.getButtonConfig = function(displayStatus) {
        switch (displayStatus) {
            case DisplayStatus.AVAILABLE:
                return { labelKey: 'jellyseerr_btn_available',          cssClass: 'jellyseerr-button-available',          disabled: true,  showSpinner: false, iconKey: 'available'          };
            case DisplayStatus.AVAILABLE_UPDATING:
                return { labelKey: 'jellyseerr_btn_available',          cssClass: 'jellyseerr-button-available-updating', disabled: true,  showSpinner: true,  iconKey: 'available'          };
            case DisplayStatus.PENDING:
                return { labelKey: 'jellyseerr_btn_pending',            cssClass: 'jellyseerr-button-pending',            disabled: true,  showSpinner: false, iconKey: 'pending'            };
            case DisplayStatus.PROCESSING:
                return { labelKey: 'jellyseerr_btn_processing',         cssClass: 'jellyseerr-button-processing',         disabled: true,  showSpinner: true,  iconKey: ''                   };
            case DisplayStatus.REQUESTED:
                return { labelKey: 'jellyseerr_btn_requested',          cssClass: 'jellyseerr-button-pending',            disabled: true,  showSpinner: false, iconKey: 'requested'          };
            case DisplayStatus.PARTIAL:
                return { labelKey: 'jellyseerr_btn_partially_available',cssClass: 'jellyseerr-button-partially-available',disabled: true,  showSpinner: false, iconKey: 'partially_available'};
            case DisplayStatus.BLOCKED:
                return { labelKey: 'jellyseerr_btn_blocklisted',        cssClass: 'jellyseerr-button-blocklisted',        disabled: true,  showSpinner: false, iconKey: 'cancel'             };
            default: // DELETED, NONE, unknown — requestable
                return { labelKey: 'jellyseerr_btn_request',            cssClass: 'jellyseerr-button-request',            disabled: false, showSpinner: false, iconKey: 'request'            };
        }
    };

    // ── Badge config ─────────────────────────────────────────────────────────

    // SVG icons used exclusively by the card status badge overlay.
    const BADGE_ICONS = {
        [DisplayStatus.AVAILABLE]:          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clip-rule="evenodd" /></svg>`,
        [DisplayStatus.AVAILABLE_UPDATING]: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clip-rule="evenodd" /></svg>`,
        [DisplayStatus.PENDING]:            `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" d="M5.25 9a6.75 6.75 0 0113.5 0v.75c0 2.123.8 4.057 2.118 5.52a.75.75 0 01-.297 1.206c-1.544.57-3.16.99-4.831 1.243a3.75 3.75 0 11-7.48 0 24.585 24.585 0 01-4.831-1.244.75.75 0 01-.298-1.205A8.217 8.217 0 005.25 9.75V9zm4.502 8.9a2.25 2.25 0 104.496 0 25.057 25.057 0 01-4.496 0z" clip-rule="evenodd" /></svg>`,
        [DisplayStatus.PROCESSING]:         `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10" stroke-opacity="0.25"/><path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round"/></svg>`,
        [DisplayStatus.REQUESTED]:          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M12 2.25c-5.385 0-9.75 4.365-9.75 9.75s4.365 9.75 9.75 9.75 9.75-4.365 9.75-9.75S17.385 2.25 12 2.25zM12.75 6a.75.75 0 00-1.5 0v6c0 .414.336.75.75.75h4.5a.75.75 0 000-1.5h-3.75V6z" clip-rule="evenodd"></path></svg>`,
        [DisplayStatus.PARTIAL]:            `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM6.75 9.25a.75.75 0 000 1.5h6.5a.75.75 0 000-1.5h-6.5z" clip-rule="evenodd" /></svg>`,
        [DisplayStatus.BLOCKED]:            `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z" clip-rule="evenodd" /></svg>`,
        [DisplayStatus.DELETED]:            `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.52.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4zM8.58 7.72a.75.75 0 00-1.5.06l.3 7.5a.75.75 0 101.5-.06l-.3-7.5zm4.34.06a.75.75 0 10-1.5-.06l-.3 7.5a.75.75 0 101.5.06l.3-7.5z" clip-rule="evenodd" /></svg>`,
    };

    const BADGE_CSS = {
        [DisplayStatus.AVAILABLE]:          'status-available',
        [DisplayStatus.AVAILABLE_UPDATING]: 'status-available',
        [DisplayStatus.PENDING]:            'status-pending',
        [DisplayStatus.PROCESSING]:         'status-processing',
        [DisplayStatus.REQUESTED]:          'status-requested',
        [DisplayStatus.PARTIAL]:            'status-partially-available',
        [DisplayStatus.BLOCKED]:            'status-blocklisted',
        [DisplayStatus.DELETED]:            'status-deleted',
    };

    /**
     * Returns the badge icon SVG and CSS class for a given display state,
     * or null when the badge should be hidden.
     * @param {string} displayStatus — one of seerrStatus.DISPLAY.*
     * @returns {{ icon: string, cssClass: string }|null}
     */
    seerrStatus.getBadgeConfig = function(displayStatus) {
        const icon = BADGE_ICONS[displayStatus];
        const cssClass = BADGE_CSS[displayStatus];
        if (!icon || !cssClass) return null;
        return { icon, cssClass };
    };

    // ── Season row display ───────────────────────────────────────────────────

    /**
     * Returns the i18n translation key and CSS class for a season row,
     * accounting for active downloads to differentiate "processing" from
     * "requested" within the PROCESSING media status.
     * @param {number|undefined} mediaStatus
     * @param {boolean}          [hasActiveDownloads=false]
     * @returns {{ labelKey: string, cssClass: string }}
     */
    seerrStatus.getDisplayInfo = function(mediaStatus, hasActiveDownloads = false) {
        switch (mediaStatus) {
            case M.PENDING:
            case M.PROCESSING:
                return {
                    labelKey: hasActiveDownloads ? 'jellyseerr_season_status_processing' : 'jellyseerr_season_status_requested',
                    cssClass: 'processing'
                };
            case M.PARTIALLY_AVAILABLE:
                return { labelKey: 'jellyseerr_season_status_partial',        cssClass: 'partially-available' };
            case M.AVAILABLE:
                return { labelKey: 'jellyseerr_season_status_available',       cssClass: 'available' };
            case M.BLOCKED:
                return { labelKey: 'jellyseerr_status_blocked',                cssClass: 'blocked' };
            default:
                return { labelKey: 'jellyseerr_season_status_not_requested',   cssClass: 'not-requested' };
        }
    };

    // ── Status chip config (more-info modal) ─────────────────────────────────

    /**
     * Returns label key and CSS class for a status chip in the more-info modal.
     * @param {string} displayStatus — one of seerrStatus.DISPLAY.*
     * @returns {{ labelKey: string, cssClass: string }}
     */
    seerrStatus.getChipConfig = function(displayStatus) {
        switch (displayStatus) {
            case DisplayStatus.AVAILABLE:
            case DisplayStatus.AVAILABLE_UPDATING:
                return { labelKey: 'jellyseerr_btn_available',          cssClass: 'chip-available'  };
            case DisplayStatus.PARTIAL:
                return { labelKey: 'jellyseerr_btn_partially_available',cssClass: 'chip-partial'    };
            case DisplayStatus.PROCESSING:
                return { labelKey: 'jellyseerr_btn_processing',         cssClass: 'chip-processing' };
            case DisplayStatus.PENDING:
            case DisplayStatus.REQUESTED:
                return { labelKey: 'jellyseerr_btn_requested',          cssClass: 'chip-requested'  };
            case DisplayStatus.BLOCKED:
                return { labelKey: 'jellyseerr_btn_blocklisted',        cssClass: 'chip-blocklisted'};
            case DisplayStatus.DELETED:
                return { labelKey: 'jellyseerr_btn_deleted',            cssClass: 'chip-deleted'    };
            default:
                return { labelKey: 'jellyseerr_btn_requested',          cssClass: 'chip-requested'  };
        }
    };

    JE.seerrStatus = seerrStatus;

})(window.JellyfinEnhanced);
