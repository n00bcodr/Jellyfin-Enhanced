/** The stylesheet of the report dialog, verbatim: it ships with the form it styles. */
const REPORT_STYLES = `
            <style>
                .jellyseerr-issues-container { margin-top: 12px; }
                .jellyseerr-issues-header { font-weight: 700; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px; font-size: 12px; color: #888; }
                .jellyseerr-issue-section { margin-bottom: 14px; }
                .jellyseerr-issue-section-title { display: inline-block; padding: 4px 12px; border-radius: 999px; background: rgba(100, 100, 255, 0.2); color: #b0b0ff; font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.4px; margin: 0 0 10px; }
                .jellyseerr-issue-card { border: 1px solid rgba(255,255,255,0.08); background: rgba(255,255,255,0.03); border-radius: 8px; padding: 10px 12px; margin-bottom: 10px; }
                .jellyseerr-issue-summary { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-weight: 600; color: #e6e6e6; }
                .jellyseerr-issue-reporter { color: #9aa; font-weight: 500; }
                .jellyseerr-issue-date { color: #9aa; font-size: 12px; }
                .jellyseerr-pill { display: inline-block; padding: 2px 8px; border-radius: 999px; background: rgba(0, 150, 255, 0.15); color: #8fd1ff; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.3px; }
                .pill-number-open { background: rgba(0, 150, 255, 0.15); color: #8fd1ff; }
                .pill-status-open { background: rgba(255, 200, 0, 0.18); color: #ffd666; }
                .pill-number-resolved, .pill-status-resolved { background: rgba(0, 180, 60, 0.18); color: #8dffb0; }
                .jellyseerr-issue-message { margin-top: 6px; color: #ddd; white-space: pre-wrap; }
                .jellyseerr-issue-comments { margin-top: 8px; border-top: 1px solid rgba(255,255,255,0.05); padding-top: 6px; display: grid; gap: 6px; }
                .jellyseerr-issue-comment { padding: 6px 8px; border-radius: 6px; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05); }
                .jellyseerr-issue-comment-meta { font-size: 12px; color: #9aa; margin-bottom: 2px; }
                .jellyseerr-issue-comment-body { color: #eaeaea; font-size: 14px; white-space: pre-wrap; }
                .jellyseerr-issues-empty { color: #9aa; padding: 8px 0; }
            </style>`;

export interface IssueType { value: string; label: string; icon: string }

/** Every string arrives escaped; `icon` is trusted markup from the icon kit. */
export function reportFormHtml(types: readonly IssueType[], labels: { type: string; message: string; placeholder: string; existing: string; loading: string }): string {
    return `${REPORT_STYLES}
            <div class="jellyseerr-issue-form">
                <div class="jellyseerr-form-group">
                    <label>${labels.type}</label>
                    <div class="jellyseerr-issue-radio-group">
                        ${types.map(type => `
                            <label class="jellyseerr-radio-label">
                                <input type="radio" name="issue-type" value="${type.value}" class="jellyseerr-radio-input" required>
                                <span class="jellyseerr-radio-option">${type.icon} ${type.label}</span>
                            </label>
                        `).join('')}
                    </div>
                </div>
                <div class="jellyseerr-form-group">
                    <label for="issue-message">${labels.message}</label>
                    <textarea
                        id="issue-message"
                        class="jellyseerr-issue-textarea"
                        placeholder="${labels.placeholder}"
                        rows="4"
                    ></textarea>
                </div>
                <div id="jellyseerr-tv-controls-placeholder"></div>
                <div class="jellyseerr-issues-container" id="jellyseerr-issues-container">
                    <div class="jellyseerr-issues-header">${labels.existing}</div>
                    <div class="jellyseerr-issues-body" id="jellyseerr-issues-body">
                        <div class="jellyseerr-issues-loading" id="jellyseerr-issues-loading">${labels.loading}</div>
                    </div>
                </div>
            </div>
        `;
}

export function tvControlsHtml(season: string, episode: string): string {
    return `
                        <div class="jellyseerr-form-group">
                            <label for="issue-season">${season}</label>
                            <select id="issue-season" class="jellyseerr-select"></select>
                        </div>
                        <div class="jellyseerr-form-group">
                            <label for="issue-episode">${episode}</label>
                            <select id="issue-episode" class="jellyseerr-select"></select>
                        </div>
                    `;
}

/** A Jellyfin toolbar button with one Material icon. */
export function detailButtonContent(icon: string, iconClass = ''): string {
    return `
            <div class="detailButton-content">
                <span class="material-icons detailButton-icon${iconClass}" aria-hidden="true">${icon}</span>
            </div>
        `;
}

export const INDICATOR_CSS = `
                    .jellyseerr-report-issue-icon.has-open-issues .detailButton-icon { color: #f97316 !important; }
                    .jellyseerr-report-issue-icon { position: relative; }
                    .jellyseerr-issue-count-badge {
                        position: absolute; top: 2px; right: 2px;
                        background: #f97316; color: #fff;
                        font-size: 10px; font-weight: 700;
                        border-radius: 999px; min-width: 16px; height: 16px;
                        display: flex; align-items: center; justify-content: center;
                        padding: 0 3px; pointer-events: none; line-height: 1;
                        box-shadow: 0 1px 3px rgba(0,0,0,0.5); z-index: 10;
                    }
                `;
