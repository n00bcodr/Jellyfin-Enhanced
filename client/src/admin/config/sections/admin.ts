import type { DefineSections } from '../engine/schema';

export function defineAdmin(define: DefineSections): void {
/* Admin tab sections. Maintenance Mode and Usage Statistics keep their load/save in configPage.html (manual: true) because of
 * side effects (enable/disable calls, jeTouched, jeLoaded, JSON user list); only their markup is rendered here. */
define({
    'analytics': {
        title: 'Usage Statistics',
        icon: 'insights',
        class: 'je-fieldset-wide',
        items: [
            { type: 'note', html: 'Fully opt-in and off by default. No URLs, API keys, usernames, filenames, or media titles are ever collected. Turning this on always includes just an anonymous install ID, plugin version, and Jellyfin version/target, enough to answer "how many installs are on the latest version." Untick all three options to share only that. Use the preview below to see exactly what would be sent, or read <a class="sectionTitle" href="https://n00bcodr.github.io/Jellyfin-Enhanced/advanced/community-analytics/" target="_blank" rel="noopener">what each option collects and why</a>.' },
            { id: 'analyticsEnabled', type: 'toggle', main: true, manual: true, label: 'Share Anonymous Usage Statistics',
              desc: 'Periodically sends an anonymous report to the Jellyfin Enhanced community analytics project. Each install gets a random ID that identifies nothing about you or your server.' },
            { type: 'custom', html: '<div id="analyticsSubOptionsContainer"></div>' },
            { id: 'analyticsShareFeatureFlags', type: 'toggle', manual: true, label: 'Feature toggle states (on/off only)' },
            { id: 'analyticsShareUsageCounts', type: 'toggle', manual: true, label: 'Feature usage counts' },
            { id: 'analyticsShareDataSizes', type: 'toggle', manual: true, label: 'Data file sizes (bytes only, never contents)' },
            { id: 'analyticsReportIntervalDays', type: 'number', manual: true, min: 7, max: 30, step: 1, label: 'Reporting interval (days)',
              desc: 'How often a report is sent, between 7 and 30 days.' },
            { type: 'group', title: 'Preview and status', items: [
                { type: 'custom', html:
                    '<div class="jea-actions"><button type="button" id="analyticsPreviewBtn" class="jea-btn">Preview</button></div>'
                    + '<div id="analyticsPreviewContainer" style="display:none"><div class="fieldDescription">This reflects what would be sent based on the selections above.</div>'
                    + '<pre id="analyticsPreviewJson" class="je-json-preview jea-pre"></pre></div>'
                    + '<div id="analyticsLastSent" class="fieldDescription"></div>' }
            ] }
        ]
    },

    'maintenance': {
        title: 'Maintenance Mode',
        icon: 'construction',
        class: 'je-fieldset-wide',
        items: [
            { id: 'maintenanceModeEnabled', type: 'toggle', manual: true, label: 'Enable Maintenance Mode',
              desc: 'When enabled, the selected action is applied to affected users immediately on save. A banner is shown on the Jellyfin login page. Admins are <strong>never</strong> affected. Disabling restores all users automatically.' },
            { id: 'maintenanceModeDurationMinutes', type: 'number', manual: true, showIf: 'maintenanceModeEnabled', min: 0, max: 525600, step: 1, label: 'Duration (minutes)',
              desc: '0 = stays on until you turn it off. Otherwise maintenance ends itself after this many minutes: the banner shows a live countdown and the toggle above switches off automatically. Changing the number restarts the clock; saving other settings does not.' },
            { type: 'group', showIf: 'maintenanceModeEnabled', title: 'Messages', open: true, items: [
                { id: 'maintenanceModeMessage', type: 'textarea', manual: true, rows: 2, label: 'Login Page Banner Message',
                  placeholder: 'This server is currently undergoing maintenance. Please try again later.',
                  desc: 'Shown as a red banner at the top of every page (login + home). Plain text only. Use <code>{countdown}</code> for the time remaining and <code>{ends_at}</code> for the end time; with a duration set and no token, the time remaining is appended automatically.' },
                { id: 'maintenanceModeNotificationMessage', type: 'textarea', manual: true, rows: 2, label: 'Active Session Notification',
                  placeholder: 'Server maintenance is starting. Please finish up and try again later.',
                  desc: 'Sent as a native Jellyfin popup to anyone currently watching; reaches all clients (web, mobile, TV apps). Same <code>{countdown}</code> / <code>{ends_at}</code> tokens as the banner.' },
                { id: 'maintenanceModeRemindOnPlayback', type: 'toggle', manual: true, label: 'Remind on playback start',
                  desc: 'While maintenance is active, re-send the notification above (with the time remaining) to affected non-admin users each time they start playing something, on any client. At most once every 5 minutes per session. Only useful when accounts are <em>not</em> disabled.' }
            ] },
            { type: 'group', showIf: 'maintenanceModeEnabled', title: 'Action', open: true, items: [
                { id: 'mmAction_accounts', type: 'toggle', manual: true, attrs: { checked: 'checked' }, label: 'Disable user accounts',
                  desc: 'Users cannot log in at all until maintenance ends.' },
                { id: 'mmAction_remote', type: 'toggle', manual: true, label: 'Disable remote connections',
                  desc: 'Blocks connections from outside the local network; LAN access still works.' }
            ] },
            { type: 'group', title: 'Affected users', open: true, items: [
                { type: 'custom', html:
                    '<div class="jea-radio-list">'
                    + '<label class="jea-radio"><input type="radio" name="maintenanceModeUsers" id="mmUsers_all" value="all" checked/><span>All non-admin users</span></label>'
                    + '<label class="jea-radio"><input type="radio" name="maintenanceModeUsers" id="mmUsers_select" value="select"/><span>Select specific users</span></label>'
                    + '</div>'
                    + '<div id="je-mm-user-list" class="jea-userlist" style="display:none">'
                    + '<div class="jea-actions"><button type="button" id="je-mm-select-all" class="jea-btn">Select All</button><button type="button" id="je-mm-deselect-all" class="jea-btn">Deselect All</button></div>'
                    + '<div id="je-mm-users-inner"><div id="je-mm-users-loading" class="fieldDescription">Loading users...</div></div>'
                    + '</div>' }
            ] },
            { type: 'group', title: 'Daily schedule', open: true, items: [
            { id: 'maintenanceScheduleEnabled', type: 'toggle', manual: true, label: 'Enable daily maintenance window',
              desc: 'Turns maintenance mode on and off by itself every day between the times below (server local time), with its own message and action, e.g. for nightly library scans. Uses the <strong>Affected users</strong> selection above. The manual toggle takes precedence while it is on; turning the schedule off ends a running window early.' },
            { type: 'custom', showIf: 'maintenanceScheduleEnabled', html:
                '<div class="jea-timepair">'
                + '<div class="inputContainer jea-row"><label class="inputLabel" for="maintenanceScheduleStart">Start time</label><input id="maintenanceScheduleStart" name="maintenanceScheduleStart" type="time" class="jea-input"/></div>'
                + '<div class="inputContainer jea-row"><label class="inputLabel" for="maintenanceScheduleEnd">End time</label><input id="maintenanceScheduleEnd" name="maintenanceScheduleEnd" type="time" class="jea-input"/></div>'
                + '</div>'
                + '<div id="mmScheduleSameTimeWarning" class="fieldDescription jea-warn-text" style="display:none">Start and end time must differ; the schedule is ignored until they do.</div>'
                + '<div id="mmServerTimeHint" class="fieldDescription"></div>' },
            { id: 'maintenanceScheduleMessage', type: 'textarea', manual: true, showIf: 'maintenanceScheduleEnabled', rows: 2, label: 'Scheduled Banner Message',
              placeholder: 'The library is updating; slowdowns are normal. Time remaining: {countdown}',
              desc: 'Banner shown while the window is active. Same <code>{countdown}</code> / <code>{ends_at}</code> tokens.' },
            { id: 'maintenanceScheduleNotificationMessage', type: 'textarea', manual: true, showIf: 'maintenanceScheduleEnabled', rows: 2, label: 'Scheduled Session Notification',
              placeholder: 'The library is updating; slowdowns are normal.',
              desc: 'Popup sent to active sessions when the window starts, and on playback start when reminders are on.' },
            { type: 'group', showIf: 'maintenanceScheduleEnabled', title: 'Scheduled action (leave both off for a banner-only window)', open: true, items: [
                { id: 'mmSchedAction_accounts', type: 'toggle', manual: true, label: 'Disable user accounts' },
                { id: 'mmSchedAction_remote', type: 'toggle', manual: true, label: 'Disable remote connections' }
            ] }
            ] }
        ]
    },

    'developer': {
        title: 'Developer Settings',
        icon: 'code',
        items: [
            { id: 'devMode', prop: 'DevMode', type: 'toggle', label: 'Dev Mode',
              desc: 'Disables JS caching so scripts are always re-fetched from the server. Default: OFF.' },
            { type: 'note', tone: 'warn', html: 'Do not change this if you do not know why you are changing it.' }
        ]
    }
});
}
