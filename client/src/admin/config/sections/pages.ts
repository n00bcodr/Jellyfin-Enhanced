import type { DefineSections, NoteItem, SectionItem, ToggleField } from '../engine/schema';

interface PlacementOptions { p: string; en: string; name: string; ppLabel: string; ppIntro: string; ctLabel: string; noun: string; hint: string; cls: string; text: string }

export function definePages(define: DefineSections): void {
/* Pages tab sections. See jeAdmin.js for the field spec.
 * Every page feature card has the same shape: intro note, master switch, a "Where it appears" group, then options.
 * The placement checkboxes (native tab, Plugin Pages, Custom Tabs, auto-create) are rendered here as markup but are loaded and
 * saved by configPage.html's hand-written code (Custom Tabs sync, plugin detection, v12 hints), so they are not schema fields. */
    const PP = 'https://github.com/IAmParadox27/jellyfin-plugin-pages';
    const CT = 'https://github.com/IAmParadox27/jellyfin-plugin-custom-tabs';
    const ppLink = `<a class="sectionTitle" href="${PP}" target="_blank">Plugin Pages</a>`;
    const PP_NOTE = '<strong>Note:</strong> Plugin Pages 3.0 or newer applies this without a Jellyfin restart. Older versions need one after enabling this option for the first time.';
    const PP_BADGE = '<span class="je-installed-badge" data-plugin="pluginpages"><i class="material-icons" aria-hidden="true">check_circle</i>Plugin Pages detected</span>';
    const CT_BADGE = '<span class="je-installed-badge" data-plugin="customtabs"><i class="material-icons" aria-hidden="true">check_circle</i>Custom Tabs detected</span>';
    const escAttr = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    /* o: p id prefix, en master toggle id, name, ppLabel, ppIntro, ctLabel, noun, hint (v12 hint id suffix), cls (embed div class), text (display text) */
    function placement(o: PlacementOptions): SectionItem {
        const code = `<div class="${o.cls}"></div>`;
        const gate = `${o.p}UseCustomTabs,${o.en}`;
        const guide = `<details class="jea-howto"><summary>Custom Tabs setup guide ${CT_BADGE}</summary>`
            + `<p class="fieldDescription">Display the ${o.noun} in a Custom Tabs tab instead of the sidebar link.</p>`
            + `<p class="fieldDescription je-needs-customtabs">You need the <a class="sectionTitle" href="${CT}" target="_blank">Custom Tabs</a> plugin.</p>`
            + `<ol class="fieldDescription">`
            + `<li class="je-needs-customtabs">Install the <strong>Custom Tabs</strong> plugin and all its prerequisites.</li>`
            + `<li>Navigate to Dashboard &gt; Plugins &gt; Custom Tabs and add a new tab.</li>`
            + `<li>Add "Display Text" according to your preference (e.g., "${o.text}").</li>`
            + `<li>Copy the code below and paste it into the 'HTML Content' field.</li></ol>`
            + `<div class="je-copy-code-wrapper"><button class="je-copy-html-btn jea-btn" data-copy-text='${escAttr(code)}' type="button">`
            + `<i class="material-icons je-copy-icon">content_copy</i><span class="copy-btn-text je-copy-btn-text">Copy</span></button>`
            + `<pre class="je-code-pre"><code>${escAttr(code)}</code></pre></div>`
            + `<div class="fieldDescription">Already have Custom Tabs installed? <a class="sectionTitle je-custom-tabs-link" href="/web/#/configurationpage?name=Custom%20Tabs">Click here to configure it.</a></div>`
            + `</details>`;
        // Placement toggles are rendered here but loaded and saved by configPage.html (Custom Tabs sync, plugin detection, v12 hints).
        return {
            type: 'group', title: 'Where it appears', open: true, items: [
                { id: `${o.p}UseNativeTab`, type: 'toggle', manual: true, label: `Add ${o.name} as a native Home tab`,
                  desc: `Adds ${o.name} as its own tab on the Home page, no external plugin needed.<br/><strong>Recommended on Jellyfin 12's experimental layout</strong> (the default).` },
                { id: `${o.p}UsePluginPages`, type: 'toggle', manual: true, label: o.ppLabel, desc: `${o.ppIntro}<br/>${PP_NOTE} ${PP_BADGE}` },
                { id: `${o.p}UseCustomTabs`, type: 'toggle', manual: true, label: o.ctLabel, desc: guide },
                { type: 'html', html: `<div class="je-note-banner je-v12-tab-hint-banner" id="je-v12-hint-${o.hint}" style="display:none;"><i class="material-icons je-note-icon">info</i>`
                    + `<div>On Jellyfin 12, <strong>"Add ${o.name} as a native Home tab"</strong> is more reliable than Custom Tabs. The two cannot be enabled together.</div></div>` },
                { id: `${o.p}AutoCreateCustomTab`, type: 'toggle', manual: true, label: 'Add the Custom Tabs entry for me',
                  rowClass: 'je-customtabs-automanage', rowAttrs: { 'data-gated-by': gate }, descAttrs: { 'data-gated-by': gate },
                  desc: `Jellyfin Enhanced will create the matching Custom Tabs entry on save. Turning off "${o.ctLabel}" removes the entry; turning it back on re-creates it. Leave unchecked to manage the Custom Tabs entry yourself.` }
            ]
        };
    }

    const note = (html: string, icon?: string): NoteItem => ({ type: 'note', html: icon ? `<i class="material-icons je-info-icon">${icon}</i> ` + html : html });
    const T = (id: string, prop: string, label: string, desc?: string, extra?: Partial<ToggleField>): ToggleField => ({ id, prop, type: 'toggle', label, ...(desc === undefined ? {} : { desc }), ...extra });
    const HC_DEFAULT = (id: string, label: string, desc: string, on?: boolean): ToggleField => T(id, id.charAt(0).toUpperCase() + id.slice(1), label, desc, on ? { default: true } : {});

    define({
        'pages-bookmarks': {
            title: 'Bookmarks', icon: 'bookmark',
            items: [
                note('<strong>How to use:</strong> press <kbd class="je-kbd">B</kbd> or click the bookmark icon during playback to save the current time. Bookmarks show as pins on the progress bar (click one to jump there) and track by TMDB/TVDB ids, so they work across file versions of the same content.'),
                T('bookmarksEnabled', 'BookmarksEnabled', 'Enable Bookmarks Feature',
                    'Save custom bookmarks/timestamps while watching videos to quickly jump back to your favorite scenes or moments.', { main: true, default: true }),
                placement({ p: 'bookmarks', en: 'bookmarksEnabled', name: 'Bookmarks', ppLabel: 'Use Plugin Pages for Bookmarks Library',
                    ppIntro: `Adds a "Bookmarks" link via ${ppLink}.`, ctLabel: 'Use Custom Tabs for Bookmarks', noun: 'Bookmarks library',
                    hint: 'bookmarks', cls: 'sections bookmarks', text: 'Bookmarks' })
            ]
        },
        'pages-hidden-content': {
            title: 'Hidden Content', icon: 'visibility_off',
            items: [
                note('<strong>Hidden Content</strong> lets users hide individual items from Home and Library views and browse them from a dedicated Hidden Content page. Per-user state with a server-wide enable/disable kill switch.'),
                T('hiddenContentEnabled', 'HiddenContentEnabled', 'Enable Hidden Content',
                    'Enable or disable the Hidden Content feature server-wide. When disabled, hide buttons, filtering, sidebar navigation, and settings panel options are all removed. User data is preserved and restored when re-enabled.', { main: true }),
                placement({ p: 'hiddenContent', en: 'hiddenContentEnabled', name: 'Hidden Content', ppLabel: 'Use Plugin Pages for Hidden Content',
                    ppIntro: `Replaces the default Hidden Content page with a ${ppLink} implementation.`, ctLabel: 'Use Custom Tabs for Hidden Content',
                    noun: 'Hidden Content page', hint: 'hiddenContent', cls: 'jellyfinenhanced hidden-content', text: 'Hidden Content' }),
                T('hiddenContentAdmin', 'HiddenContentAdmin', 'Let admins view and manage other users\' hidden content',
                    'Adds a "user filter" dropdown on the Hidden Content page so an admin can see what any user has hidden, with an Edit toggle to unhide items or add new ones from the library or Seerr on that user\'s behalf. Turn this off if you don\'t want to edit/manage other users\' hidden content.', { default: true }),
                {
                    type: 'group', title: 'Defaults for new users', items: [
                        note('<strong>Defaults for new users</strong> and the <em>Apply all plugin settings to every user</em> action in Overview &gt; Quick Actions. Existing users keep their current settings until you apply them.'),
                        HC_DEFAULT('hiddenContentDefaultEnabled', 'Hidden Content enabled by default',
                            'When on, Hidden Content starts active for new users, so they can hide things straight away and the filtering takes effect immediately. When off, users have to turn it on themselves first.', true),
                        {
                            type: 'group', title: 'Hide buttons', open: true, items: [
                                HC_DEFAULT('hiddenContentDefaultShowHideButtons', 'Show "Hide" buttons by default',
                                    'When on, the Hide button shows up across the apps so users can hide things they don\'t want to see. When off, no Hide button appears anywhere, but users can still bring back items they\'ve already hidden from the Hidden Content page.', true),
                                HC_DEFAULT('hiddenContentDefaultShowHideConfirmation', 'Show confirmation dialog before hiding',
                                    'When on, clicking Hide asks "are you sure?" first. Turn off for one-click hiding. Items can always be brought back from the Hidden Content page.', true),
                                HC_DEFAULT('hiddenContentDefaultShowButtonJellyseerr', 'Show "Hide" button on Seerr search results',
                                    'Adds a Hide button to Seerr search and discover results, so users can hide a movie or show even before it\'s been added to their library.', true),
                                HC_DEFAULT('hiddenContentDefaultShowButtonDetails', 'Show "Hide" button on item details pages',
                                    'Adds a Hide button to the row of action buttons on movie, show, and episode detail pages.', true),
                                HC_DEFAULT('hiddenContentDefaultShowButtonLibrary', 'Show "Hide" button on library / home cards',
                                    'Adds a small eye icon to every poster on the home and library pages, so users can hide an item without opening it first. Off by default because some people find the icon on every poster busy.', false),
                                HC_DEFAULT('hiddenContentDefaultShowButtonCast', 'Show "Hide" button on cast / actor cards',
                                    'Adds a Hide button to actor cards. Hiding an actor hides every movie or show they appear in until you bring them back.', false)
                            ]
                        },
                        {
                            type: 'group', title: 'Where hidden items are filtered out', open: true, items: [
                                HC_DEFAULT('hiddenContentDefaultFilterLibrary', 'Filter Library & details pages',
                                    'When on, hidden items don\'t appear when users browse a library (Movies, Shows, etc.) or in the suggestion rows on a details page. Turn off if users still want to see hidden items while browsing.', true),
                                HC_DEFAULT('hiddenContentDefaultFilterSearch', 'Filter Search results',
                                    'When on, hidden items don\'t appear in search results. Off by default because most people still want to be able to search for something they hid in order to bring it back.', false),
                                HC_DEFAULT('hiddenContentDefaultFilterContinueWatching', 'Filter Continue Watching',
                                    'When on, hidden items don\'t appear in the Continue Watching row on the home page. Required for the "Remove from Continue Watching" button to actually do anything.', true),
                                HC_DEFAULT('hiddenContentDefaultFilterNextUp', 'Filter Next Up',
                                    'When on, hidden series don\'t appear in the Next Up row on the home page. Recommended on so a show users have hidden doesn\'t keep being suggested as the next thing to watch.', true),
                                HC_DEFAULT('hiddenContentDefaultFilterUpcoming', 'Filter Upcoming episodes',
                                    'When on, hidden series don\'t appear on the Upcoming Episodes page.', true),
                                HC_DEFAULT('hiddenContentDefaultFilterRecommendations', 'Filter Suggestions / recommendations',
                                    'When on, hidden items don\'t appear in the "Because you watched..." and "Suggested for you" rows on the home and details pages.', true),
                                HC_DEFAULT('hiddenContentDefaultFilterDiscovery', 'Filter Discovery',
                                    'When on, hidden items don\'t appear on the Discovery page (genre, similar, and recommended sections).', true),
                                HC_DEFAULT('hiddenContentDefaultFilterCalendar', 'Filter Calendar',
                                    'When on, hidden series don\'t show up on the Calendar page\'s list of upcoming episodes.', true),
                                HC_DEFAULT('hiddenContentDefaultFilterRequests', 'Filter Requests page',
                                    'When on, hidden items don\'t appear on the Requests page (the combined view of Sonarr, Radarr, and Seerr requests).', true)
                            ]
                        },
                        HC_DEFAULT('hiddenContentDefaultExperimentalHideCollections', 'Allow hiding collections, libraries, and playlists (experimental)',
                            '<strong>Warning:</strong> Extremely not recommended for average users. Will break things. Only turn this on if you 100% know what you want to use it for. Lets users hide whole collections, libraries, or playlists in addition to individual movies and shows.', false)
                    ]
                }
            ]
        },
        'pages-requests': {
            title: 'Requests Page', icon: 'download',
            items: [
                note('<strong>Requests Page</strong> shows a Requests button in the sidebar with a dedicated view of active downloads from Sonarr/Radarr and requests from Seerr.'
                    + '<div id="requestsPageRequirementsLine" style="display: none; margin-top: 10px;"><strong>Requirements:</strong> <span id="requestsPageRequirementsList">Configure Sonarr and/or Radarr, plus Seerr, URLs and API keys.</span></div>'),
                T('downloadsPageEnabled', 'DownloadsPageEnabled', 'Enable Requests Page',
                    'Adds a "Requests" link to the navigation showing active downloads and requests.', { main: true, default: true }),
                placement({ p: 'downloads', en: 'downloadsPageEnabled', name: 'Requests', ppLabel: 'Use Plugin Pages for Requests',
                    ppIntro: `Replaces the default Requests page with a ${ppLink} implementation.`, ctLabel: 'Use Custom Tabs for Requests',
                    noun: 'Requests page', hint: 'downloads', cls: 'jellyfinenhanced requests', text: 'Requests' }),
                T('showDownloadsInRequests', 'ShowDownloadsInRequests', 'Show Downloads in Requests Page',
                    'Shows active downloads from Sonarr/Radarr on the Requests page. (Requires *arr links and API keys to be configured)', { default: true }),
                T('downloadsFilterByUserRequests', 'DownloadsFilterByUserRequests', 'Filter Downloads by User Requests',
                    'When enabled, non-admin users only see downloads and requests they made themselves, regardless of their Seerr permissions. When disabled, all authenticated users can see every item in the download queue, and the request list follows each user\'s Seerr permissions.',
                    { default: true, showIf: 'showDownloadsInRequests' }),
                T('downloadsPageShowIssues', 'DownloadsPageShowIssues', 'Show Seerr Issues Section', 'Shows open/resolved Seerr issues beneath Requests.'),
                T('downloadsShowHistory', 'DownloadsShowHistory', 'Show Download History Section',
                    'Shows a bounded history of recently imported (or failed-to-import) Sonarr/Radarr downloads beneath Requests, so items that vanish from the active queue after finishing are still visible.', { default: true }),
                T('downloadsHistoryAdminOnly', 'DownloadsHistoryAdminOnly', 'Restrict Download History to Admins',
                    'When enabled, only Jellyfin administrators see the Download History section. Regular users won\'t see it at all.', { showIf: 'downloadsShowHistory' }),
                T('downloadsPagePollingEnabled', 'DownloadsPagePollingEnabled', 'Enable Auto-Refresh',
                    'Periodically refresh the Requests page so download progress updates without manual reload.', { default: true }),
                { id: 'downloadsPollIntervalSeconds', prop: 'DownloadsPollIntervalSeconds', type: 'number', min: 30, max: 300, default: 30, label: 'Poll Interval (seconds)',
                  desc: 'How often to refresh download status automatically. Minimum is 30 seconds and applies only when auto-refresh is enabled.',
                  showIf: 'downloadsPagePollingEnabled',
                  toConfig: (v) => { const n = Math.floor(Number(v)); return n >= 30 ? n : 30; } }
            ]
        },
        'pages-calendar': {
            title: 'Calendar Page', icon: 'calendar_today',
            items: [
                note('<strong>Calendar Page</strong> adds a Calendar button in the sidebar with a dedicated view of upcoming releases from Sonarr and Radarr.<br/><strong>Requirements:</strong> Configure Sonarr and/or Radarr URLs and API keys.'),
                T('calendarPageEnabled', 'CalendarPageEnabled', 'Enable Calendar Page',
                    'Adds a "Calendar" link to the navigation showing upcoming releases from Sonarr/Radarr.', { main: true, default: true }),
                placement({ p: 'calendar', en: 'calendarPageEnabled', name: 'Calendar', ppLabel: 'Use Plugin Pages',
                    ppIntro: `Replaces the default Calendar page with a ${ppLink} implementation.`, ctLabel: 'Use Custom Tabs',
                    noun: 'Calendar page', hint: 'calendar', cls: 'jellyfinenhanced calendar', text: 'Calendar' }),
                { id: 'calendarFirstDayOfWeek', prop: 'CalendarFirstDayOfWeek', type: 'select', default: 'Monday', label: 'First Day of Week',
                  options: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((d) => [d, d]),
                  desc: 'Which day appears as the first column of the calendar grid.' },
                { id: 'calendarTimeFormat', prop: 'CalendarTimeFormat', type: 'select', default: '5pm/5:30pm', label: 'Time Format',
                  options: [['5pm/5:30pm', '5pm/5:30pm'], ['17:00/17:30', '17:00/17:30']],
                  desc: 'Whether release times display in 12-hour (5pm) or 24-hour (17:00) format.' },
                T('calendarHighlightFavorites', 'CalendarHighlightFavorites', 'Highlight Favorites/Watchlist', 'Show a golden border on calendar entries for items in your Jellyfin favorites.'),
                T('calendarHighlightWatchedSeries', 'CalendarHighlightWatchedSeries', 'Highlight Watched Series', 'Show a border on calendar entries for series you have watched episodes from.'),
                T('calendarFilterByLibraryAccess', 'CalendarFilterByLibraryAccess', 'Filter by Library Access',
                    'When enabled, the calendar only shows items from libraries the user has access to. Upcoming items not yet in Jellyfin are filtered based on their Sonarr/Radarr root folder.', { default: true }),
                T('calendarShowOnlyRequested', 'CalendarShowOnlyRequested', 'Show Requested Only (Default)',
                    'When enabled, the calendar will load showing only Requested items by default, but users can still change filters.'),
                T('calendarForceOnlyRequested', 'CalendarForceOnlyRequested', 'Force Only Requested Items',
                    'When enabled, the calendar always shows only your requested items and the Requests filter is hidden.')
            ]
        },
        'pages-recommendations': {
            title: 'Seerr Recommendations Page', icon: 'auto_awesome',
            items: [
                note('<strong>Seerr Recommendations Page</strong> adds a dedicated view with Seerr-powered rows: Trending, Popular Movies, Popular TV Shows, Upcoming Movies and Upcoming TV Shows.<br/><strong>Requirements:</strong> Seerr integration must be configured and enabled.'),
                T('recommendationsPageEnabled', 'RecommendationsPageEnabled', 'Enable Recommendations Page',
                    'Adds a "Seerr Recommendations" link to the navigation showing Seerr discover rows.', { main: true }),
                placement({ p: 'recommendations', en: 'recommendationsPageEnabled', name: 'Recommendations', ppLabel: 'Use Plugin Pages',
                    ppIntro: `Replaces the default Recommendations page with a ${ppLink} implementation.`, ctLabel: 'Use Custom Tabs',
                    noun: 'Recommendations page', hint: 'recommendations', cls: 'jellyfinenhanced recommendations', text: 'Recommendations' })
            ]
        },
        'pages-activity': {
            title: 'Activity Feed', icon: 'history',
            items: [
                note('<strong>Activity Feed</strong> shows recently watched, favorited, and reviewed titles across the server. Each viewer only sees activity for items they themselves have library access to.'),
                T('activityFeedEnabled', 'ActivityFeedEnabled', 'Enable Activity Feed', 'Turns the feature on. While it\'s off, no activity is recorded or shown.', { main: true }),
                placement({ p: 'activityFeed', en: 'activityFeedEnabled', name: 'Activity', ppLabel: 'Use Plugin Pages',
                    ppIntro: `Adds an "Activity" link via ${ppLink}.`, ctLabel: 'Use Custom Tabs',
                    noun: 'Activity page', hint: 'activityFeed', cls: 'jellyfinenhanced activity', text: 'Activity' }),
                {
                    type: 'group', title: 'What to show', open: true, items: [
                        T('activityFeedShowWatched', 'ActivityFeedShowWatched', 'Show recently watched', 'Titles users finished watching.', { default: true }),
                        T('activityFeedShowFavorited', 'ActivityFeedShowFavorited', 'Show recently favorited', 'Titles users added to their favorites.', { default: true }),
                        T('activityFeedShowReviewed', 'ActivityFeedShowReviewed', 'Show recently reviewed', 'Titles users reviewed.', { default: true }),
                        T('activityFeedShowActiveStreams', 'ActivityFeedShowActiveStreams', 'Show Active Streams section',
                            'Adds a live "who\'s watching now" section to this page, independent of whether the Active Streams header widget (Extras tab) is shown. Still requires that feature\'s data collection to be enabled there.', { default: true })
                    ]
                },
                T('activityFeedOwnOnlyForNonAdmins', 'ActivityFeedOwnOnlyForNonAdmins', 'Non-admins only see their own activity',
                    'When enabled, regular users only see their own watched, favorited and reviewed entries. Administrators still see everyone.')
            ]
        },
        'pages-catchup': {
            title: 'Catch Up', icon: 'style',
            items: [
                note('<strong>Catch Up</strong> shows unwatched movies and shows as cards. Swipe right to mark watched, left to dismiss, up to add to your watchlist (the Likes flag) and down to open the title. Handy for finding out what people have already seen.'),
                T('catchUpEnabled', 'CatchUpEnabled', 'Enable Catch Up', 'Turns the feature on. Each user only sees titles they have library access to.', { main: true }),
                placement({ p: 'catchUp', en: 'catchUpEnabled', name: 'Catch Up', ppLabel: 'Use Plugin Pages',
                    ppIntro: `Adds a "Catch Up" link via ${ppLink}.`, ctLabel: 'Use Custom Tabs',
                    noun: 'Catch Up page', hint: 'catchUp', cls: 'jellyfinenhanced catchup', text: 'Catch Up' }),
                T('catchUpLogEnabled', 'CatchUpLogEnabled', 'Record Catch Up activity',
                    'Logs who swiped what (user, title, action and time) to <code>catchup-log.jsonl</code> in the plugin\'s configuration folder. Administrators can read it, with a per-user summary, in the Activity panel on the Catch Up page. The log is size-bounded (about 5&nbsp;MB per file, two files kept).', { default: true })
            ]
        }
    });
}
