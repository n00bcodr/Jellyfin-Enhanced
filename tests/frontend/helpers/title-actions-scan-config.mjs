import { scanTransport, scanOwners, scanPublications } from './bundle-scan.mjs';

// The whole-bundle scans' configuration (D46 slice 2 review rounds 6 and 7), shared by
// features-title-actions-writes-scan.test.mjs: what is out of scope and why, the pinned forwarders, roots and counts.

/** Modules the action bar cannot reach, each with the reason (anything not listed is in scope). */
export const EXCLUDED_MODULES = {
  'core/api-client.js': 'implements the transport entry points: its own fetch calls are the transport; every caller\'s call is the site',
  'arr/admin/admin-tabs.js': null, // in scope (removeDialog and its helpers); the hub-only functions are excused by site below
  'arr/ask/ask-collection.js': 'a collection page\'s "Get the N missing" block: no details row, never pressed by the bar',
  'arr/calendar/calendar-page-data.js': 'the Calendar page (no title action)',
  'arr/hub/hub-approvals.js': 'the Requests hub\'s approvals tab (no title action)',
  'arr/hub/hub-discover.js': 'the Requests hub\'s Discover cards\' own Request buttons (the bar\'s card sheet opens the bound request sheet instead)',
  'arr/hub/hub-household.js': 'the Requests hub\'s household tab (no title action)',
  'arr/hub/hub-mine-ledger.js': 'the Requests hub\'s "Mine" ledger (no title action)',
  'arr/requests/requests-page-data.js': 'the Requests page (no title action)',
  'elsewhere/reviews.js': 'reviews below a details page: their own write and delete forms, outside the action row',
  'enhanced/bookmarks/bookmarks-library-items.js': 'the bookmarks library (no title action)',
  'enhanced/catchup/catchup-core.js': 'the Catch-up deck (no title action)',
  'enhanced/config.js': 'the settings panel\'s user-settings document save (no title action writes it)',
  'enhanced/homeremoval/features-remove-home.js': 'the home screen\'s Remove from home (no title action)',
  'enhanced/player/playback.js': 'the player (the bar is on details pages)',
  'enhanced/spoilerguard/watched-refresh.js': 'observes jellyfin-web\'s own played/unplayed requests (wraps XMLHttpRequest#open/send to notice them); sends nothing of its own',
  'extras/active-streams.js': 'the administrators\' active streams panel (no title action)',
  'tags/tag-pipeline.js': 'tag overlays: their projection reads are POSTs that change nothing (no title action)',
};
for (const [file, reason] of Object.entries(EXCLUDED_MODULES)) if (reason === null) delete EXCLUDED_MODULES[file];

/** Sites inside in-scope modules that stay unbound, by enclosing function, each with its reason. */
export const EXCLUDED_SITES = {
  'arr/admin/admin-tabs.js': {
    post: 'the hub Activity tab\'s own queue actions; the drawer\'s Remove passes its bound `run` and never reaches it',
    scanNow: 'the hub Activity tab\'s Scan now (no title action)',
    confirmDataDialog: 'the hub Activity tab\'s Remove-with-data confirmation (the drawer offers no delete-with-data)',
  },
  'arr/live/arr-live.js': {
    prime: 'the change feed\'s position read: a POST that changes nothing, scoped to the signed-in identity',
    poll: 'the change feed\'s long poll: a POST that changes nothing, scoped to the signed-in identity',
  },
  'arr/notify/notify-core.js': {
    markRead: 'the bell panel marks its own inbox read; no title action reaches it',
    prefsCall: 'the notification settings page\'s own saves; no title action reaches them',
  },
  'enhanced/helpers.js': { trackUsage: 'the opt-in anonymous usage counter, not a title action\'s write' },
  'core/session.js': { initialize: 'hands jellyfin-web\'s client to the session\'s auth hook, which observes its sign-in calls and sends nothing of its own' },
  'arr/status/status-arrival.js': { listen: 'remembers which client its LibraryChanged subscription is on (a websocket listener, no request)' },
  'enhanced/hiddencontent/hidden-content-save.js': {
    '*': 'the shared, debounced whole-document save: binding it to one operation would drop unrelated edits (r4 Part B exclusion); the operation is checked at the accept',
  },
  'enhanced/itemdetails/features-details-media-info.js': { fetchTagDataItem: 'the tag-data projection read, sent as a POST that changes nothing' },
};

/** Every forwarder the scan finds is pinned: how its member calls are recognised ('local': only its bare calls). */
export const FORWARDERS = {
  'arr/ask/ask-core.js::call': 'local',
  'arr/ask/ask-core.js::ask': /(^|\.)arrAsk\.ask$/,
  'arr/ask/ask-core.js::cancel': /(^|\.)arrAsk\.cancel$/,
  'arr/ask/ask-core.js::adminSearch': /(^|\.)arrAsk\.adminSearch$/,
  'arr/ask/ask-core.js::familySearch': /(^|\.)arrAsk\.familySearch$/,
  'arr/notify/notify-core.js::api': 'local',
  'core/api-client.js::fetchWithRetry': 'local',
  'enhanced/catchup/catchup-core.js::jf': 'local',
  'enhanced/player/pausescreen.js::fetchWithRetry': 'local',
  'enhanced/spoilerguard/state.js::request': 'local',
  'jellyseerr/api.js::managedFetch': 'local',
  'jellyseerr/api.js::post': 'local',
  'jellyseerr/api.js::tmdbGet': 'local',
  'jellyseerr/api.js::get': 'local',
  'jellyseerr/api.js::requestMedia': /(^|\.)(jellyseerrAPI|api)\.requestMedia$/,
  'jellyseerr/api.js::requestTvSeasons': /(^|\.)(jellyseerrAPI|api)\.requestTvSeasons$/,
  'jellyseerr/api.js::fetchUserQuota': /(^|\.)(jellyseerrAPI|api)\.fetchUserQuota$/,
  'jellyseerr/api.js::fetchRelated': 'local',
  'jellyseerr/api.js::fetchSimilarMovies': /(^|\.)(jellyseerrAPI|api)\.fetchSimilarMovies$/,
  'jellyseerr/api.js::fetchRecommendedMovies': /(^|\.)(jellyseerrAPI|api)\.fetchRecommendedMovies$/,
  'jellyseerr/api.js::fetchSimilarTvShows': /(^|\.)(jellyseerrAPI|api)\.fetchSimilarTvShows$/,
  'jellyseerr/api.js::fetchRecommendedTvShows': /(^|\.)(jellyseerrAPI|api)\.fetchRecommendedTvShows$/,
};

/** Transport sites per file (every module with one): a scan that sees fewer or more has stopped seeing them. */
export const SITES = {
  'arr/actions/title-actions.js': 3, 'arr/admin/admin-tabs.js': 4, 'arr/arr-links.js': 3, 'arr/arr-tag-links.js': 1,
  'arr/ask/ask-actions.js': 4, 'arr/ask/ask-collection.js': 1, 'arr/ask/ask-core.js': 9,
  'arr/ask/ask-episodes.js': 6, 'arr/ask/ask-seerr.js': 1, 'arr/ask/ask-sheet.js': 5,
  'arr/calendar/calendar-page-data.js': 4, 'arr/hub/hub-discover.js': 1, 'arr/hub/hub-mine-ledger.js': 2,
  'arr/hub/hub-page.js': 1, 'arr/live/arr-live.js': 2, 'arr/manage/manage-drawer.js': 1,
  'arr/notify/notify-core.js': 9, 'arr/requests/requests-page-data.js': 6,
  'arr/requests/requests-page-render-cards.js': 1, 'arr/status/status-arrival.js': 2, 'arr/status/status-core.js': 2,
  'awards/awards.js': 3, 'core/api-client.js': 3, 'core/navigation.js': 1, 'elsewhere/elsewhere.js': 6,
  'elsewhere/reviews.js': 12, 'enhanced/bookmarks/bookmarks-library-items.js': 3,
  'enhanced/bookmarks/bookmarks-library-replacements.js': 2, 'enhanced/bookmarks/bookmarks.js': 3,
  'enhanced/catchup/catchup-activity.js': 1, 'enhanced/catchup/catchup-core.js': 7, 'enhanced/config.js': 1,
  'enhanced/features-random-button.js': 2, 'enhanced/helpers.js': 3,
  'enhanced/hiddencontent/hidden-content-buttons.js': 4, 'enhanced/hiddencontent/hidden-content-data.js': 2,
  'enhanced/hiddencontent/hidden-content-filter.js': 2, 'enhanced/hiddencontent/hidden-content-page-admin.js': 1,
  'enhanced/hiddencontent/hidden-content-save.js': 5, 'enhanced/homeremoval/features-remove-home.js': 2,
  'enhanced/itemdetails/features-details-media-info.js': 7, 'enhanced/itemdetails/features-details-page.js': 3,
  'enhanced/itemdetails/features-release-dates.js': 3, 'enhanced/native-tabs.js': 1,
  'enhanced/player/auto-skip.js': 2, 'enhanced/player/osd-rating.js': 2, 'enhanced/player/pausescreen.js': 3,
  'enhanced/player/playback-rating-badge.js': 2, 'enhanced/player/playback.js': 4,
  'enhanced/settingspanel/ui-panel-language.js': 3, 'enhanced/settingspanel/ui-panel-settings.js': 4,
  'enhanced/settingspanel/ui-panel.js': 1, 'enhanced/settingspanel/ui-release-notes.js': 1,
  'enhanced/spoilerguard/state.js': 3, 'enhanced/spoilerguard/watched-refresh.js': 6, 'enhanced/translations.js': 8,
  'extras/active-streams.js': 2, 'extras/activity-page.js': 2, 'extras/plugin-icons.js': 1, 'jellyseerr/api.js': 33,
  'jellyseerr/discovery/collection-discovery.js': 1, 'jellyseerr/discovery/discovery-filter-utils.js': 1,
  'jellyseerr/discovery/genre-discovery.js': 1, 'jellyseerr/discovery/network-discovery.js': 1,
  'jellyseerr/discovery/person-discovery.js': 2, 'jellyseerr/issue-reporter.js': 7, 'jellyseerr/item-details.js': 5,
  'jellyseerr/jellyseerr.js': 2, 'jellyseerr/moreinfo/more-info-modal-actions.js': 2,
  'jellyseerr/moreinfo/more-info-modal-data.js': 2, 'jellyseerr/moreinfo/more-info-modal-seasons.js': 3,
  'jellyseerr/nativedetails/native-details.js': 5, 'jellyseerr/seerr-detail-link.js': 1,
  'jellyseerr/ui/ui-badges.js': 1, 'jellyseerr/ui/ui-buttons.js': 2, 'jellyseerr/ui/ui-quota.js': 1,
  'jellyseerr/ui/ui-request-modals.js': 3, 'jellyseerr/ui/ui-season-modal.js': 5, 'others/letterboxd-links.js': 1,
  'others/mdblist-ratings.js': 3, 'plugin.js': 8, 'tags/ageratingtags.js': 1, 'tags/peopletags.js': 3,
  'tags/qualitytags.js': 1, 'tags/tag-pipeline.js': 8, 'tags/tag-styles.js': 1, 'tags/userreviewtags.js': 1, 'core/session.js': 2,
};

/**
 * The owner-taking functions (shape 1): every surface opener the bar can reach and every owned write. `arg` (and `prop`
 * of that object argument) is the owner; a bare call counts only in `file` when given; `forbid`: keys that infer one.
 */
export const OPENERS = [
  { name: 'show', arg: 3, callee: /^(show|A\.show|JE\.titleActions\.show)$/, file: 'arr/actions/title-actions-sheet.js', label: 'title actions sheet' },
  { name: 'showLink', arg: 1, callee: /(^|\.)titleActions\.showLink$|^showLink$/, label: 'Share link sheet' },
  { name: 'open', arg: 1, prop: 'operation', callee: /(^|\.)arrAskSheet\.open$|^open$/, file: 'arr/ask/ask-sheet.js', label: 'request sheet' },
  { name: 'openOrAsk', arg: 1, prop: 'operation', callee: /(^|\.)arrAskSheet\.openOrAsk$|^openOrAsk$/, file: 'arr/ask/ask-sheet.js', label: 'one-tap ask / request sheet' },
  { name: 'open', arg: 1, prop: 'operation', callee: /(^|\.)arrManage\.open$|^open$/, file: 'arr/manage/manage-drawer.js', label: 'Manage drawer' },
  { name: 'create', arg: 0, prop: 'operation', callee: /(^|\.)jellyseerrModal\.create$|^modal\.create$/, label: 'Seerr modal shell' },
  { name: 'open', arg: 3, callee: /(^|\.)(jellyseerrMoreInfo|moreInfoModal)\.open$/, label: 'More Info window' },
  { name: 'showModal', arg: 3, callee: /^showModal$/, file: 'jellyseerr/moreinfo/more-info-modal-init.js', label: 'More Info window (render)' },
  { name: 'showCollectionRequestModal', arg: 3, prop: 'operation', callee: /(^|\.)showCollectionRequestModal$/, label: 'Collection modal' },
  { name: 'showMovieRequestModal', arg: 4, callee: /(^|\.)showMovieRequestModal$/, label: 'advanced movie modal' },
  { name: 'showSeasonSelectionModal', arg: 5, callee: /(^|\.)showSeasonSelectionModal$/, label: 'season modal' },
  { name: 'showReportModal', arg: 5, callee: /(^|\.)showReportModal$/, label: 'Report form' },
  { name: 'openSurface', arg: 2, callee: /(^|\.)openSurface$/, label: 'surface registration (4K popups and every opener)' },
  // r10 (D46S2-R10, audit S1/S6): popups, the search card's 4K popup, a title's page and the Calendar's navigation take their owner too.
  { name: 'openPopup', arg: 1, prop: 'owner', callee: /(^|\.)openPopup$/, label: 'popup (its lifecycle)' },
  { name: 'show4KPopup', arg: 2, callee: /(^|\.)show4KPopup$/, label: 'search card 4K popup' },
  { name: 'open', arg: 3, callee: /(^|\.)titleDetails\??\.open\??$/, label: 'title page (navigation)' },
  { name: 'show', arg: 3, callee: /(^|\.)titleDetails\??\.show\??$/, label: 'title page or its window' },
  { name: 'navigateToJellyfinItem', arg: 1, prop: 'owner', callee: /^navigateToJellyfinItem$/, file: 'arr/calendar/calendar-page-actions.js', label: 'Calendar navigation' },
  { name: 'captureSubmitted', arg: 0, callee: /(^|\.)captureSubmitted$/, label: 'owner capture' },
  { name: 'createSessionAction', arg: 0, prop: 'owner', optional: true, forbid: ['submitted'], callee: /(^|\.)createSessionAction$/, label: 'owned session action' },
  { name: 'removeDialog', arg: 5, callee: /(^|\.)removeDialog$/, label: 'Remove dialog' },
  // r8 (D46S2-R8-1, R8-2): a title opened by key carries its owner to its fallback window; a publication is an owner too.
  { name: 'openKey', arg: 1, prop: 'owner', unless: { modal: false }, callee: /(^|\.)titleDetails\.openKey$/, label: 'title by key (its fallback window)' },
  { name: 'publication', arg: 0, prop: 'owner', callee: /^JE\.publication$/, label: 'publication of a completion' },
  // Host dialogs are openers (D46S2-R7-4).
  { name: 'openHostDialog', arg: 1, callee: /(^|\.)openHostDialog$/, label: 'host dialog (Dashboard.alert/confirm)' },
  { name: 'showQuotaErrorDialog', arg: 2, callee: /(^|\.)showQuotaErrorDialog$/, label: 'quota dialog' },
  { name: 'handleRequestError', arg: 4, callee: /(^|\.)handleRequestError$/, label: 'request refusal (quota dialog or toast)' },
  { name: 'openDialog', arg: 3, callee: /^openDialog$/, file: 'arr/admin/admin-tabs.js', label: 'arr dialog' },
  { name: 'showHideConfirmation', arg: 2, prop: 'owner', callee: /(^|\.)showHideConfirmation$/, label: 'Hide confirmation' },
  { name: 'confirmAndHide', arg: 2, prop: 'owner', callee: /(^|\.)confirmAndHide$/, label: 'Hide confirmation (and hide)' },
  { name: 'confirmDisableSpoiler', arg: 0, callee: /(^|\.)confirmDisableSpoiler$/, label: 'Spoiler Guard confirmation' },
  { name: 'setFollow', arg: 2, callee: /(^|\.)setFollow$/, label: 'Follow (write)' },
  { name: 'remind', arg: 2, callee: /(^|\.)arrNotify\.remind$|^remind$/, file: 'arr/notify/notify-core.js', label: 'Remind (write)' },
  { name: 'reportIssue', arg: 6, callee: /(^|\.)reportIssue$/, label: 'Report (write)' },
  { name: 'saveTitleRule', arg: 2, callee: /(^|\.)saveTitleRule$/, label: 'Hide rule (write)' },
  { name: 'mutateState', arg: 3, callee: /^mutateState$/, file: 'enhanced/spoilerguard/state.js', label: 'Spoiler Guard (write)' },
  ...[['enableForSeries', 1], ['disableForSeries', 1], ['enableForMovie', 2], ['disableForMovie', 1], ['enableForCollection', 2], ['disableForCollection', 1], ['enableForTmdb', 3], ['disableForTmdb', 2], ['setUserPrefs', 1]]
    .map(([name, arg]) => ({ name, arg, callee: new RegExp(`(^|\\.)${name}$`), label: 'Spoiler Guard (write)' })),
];

/**
 * Genuine native roots without a gesture (D46S2-R7-1, R10-2): the only places an owner is the route's own native owner
 * (JE.routeOwner, handed out only for the route the caller recorded). Every other native owner is a gesture's
 * (JE.ownerOf(event) on a trusted event); JE.NATIVE and JE.nativeRoot are gone.
 */
export const NATIVE_ROOTS = {
  'jellyseerr/nativedetails/native-details.js': {
    onView: 'an absent page that cannot load falls back to Seerr\'s window for the route it shows (a navigation, no press)',
    backThenModal: 'Back from an absent page reopening Seerr\'s window on the route Back landed on (a navigation, no press)',
  },
};

/** Owners taken from a node at a genuine root (not a press), each with its reason. Keys: 'function' or 'function: value'. */
export const OWNER_ROOTS = {
  'jellyseerr/moreinfo/more-info-modal-init.js': {
    '(module): owner': 'the Spoiler Guard policy refresh\'s replacement window inherits the replaced window\'s owner, taken before it closes (D46S2-R6-1)',
  },
};

/** Modules whose host dialogs (Dashboard.alert/confirm, alert, confirm) no title action reaches, each with the reason. */
export const HOST_DIALOG_MODULES = {
  'elsewhere/reviews.js': 'reviews below a details page: their own delete confirmation and error alert',
  'enhanced/bookmarks/bookmarks-library-modals.js': 'the bookmarks library\'s own delete confirmation',
  'enhanced/bookmarks/bookmarks-library-render.js': 'the bookmarks library\'s own delete confirmation',
  'enhanced/hiddencontent/hidden-content-panel.js': 'the Hidden Content panel\'s Unhide all confirmation (settings)',
  'enhanced/homeremoval/features-remove-home.js': 'the home screen\'s Remove from home message',
  'extras/theme-selector.js': 'the theme selector\'s own message (settings)',
};

/** Owner sites per file: a scan that sees fewer or more has stopped seeing them. */
export const OWNER_SITES = {
  'arr/actions/title-actions-hosts.js': 2, 'arr/actions/title-actions-sheet.js': 2, 'arr/ask/ask-episodes.js': 11,
  'arr/actions/title-actions.js': 10, 'arr/admin/admin-tabs.js': 5, 'arr/ask/ask-actions.js': 6,
  'arr/calendar/calendar-page-actions.js': 6, 'arr/ask/ask-seerr.js': 11, 'arr/ask/ask-sheet.js': 9, 'arr/hub/hub-discover.js': 5, 'arr/hub/hub-page.js': 4,
  'arr/manage/manage-drawer.js': 4, 'arr/notify/notify-core.js': 2, 'arr/notify/notify-follow.js': 3,
  'arr/requests/requests-page-render.js': 1, 'arr/status/status-modal.js': 1,
  'enhanced/hiddencontent/hidden-content-buttons.js': 5, 'enhanced/hiddencontent/hidden-content-data.js': 8,
  'enhanced/hiddencontent/hidden-content-dialogs.js': 3, 'enhanced/hiddencontent/hidden-content-page-cards.js': 2,
  'enhanced/hiddencontent/hidden-content-panel.js': 2, 'enhanced/itemdetails/features-details-page.js': 4,
  'enhanced/spoilerguard/detail-button.js': 12, 'enhanced/spoilerguard/dialog.js': 3,
  'enhanced/spoilerguard/seerr-toggle.js': 4, 'enhanced/spoilerguard/settings-tab.js': 1,
  'enhanced/spoilerguard/state.js': 10, 'jellyseerr/api.js': 1, 'jellyseerr/hss-discovery-handler.js': 2,
  'jellyseerr/issue-reporter.js': 6, 'jellyseerr/item-details.js': 1, 'jellyseerr/jellyseerr.js': 11,
  'jellyseerr/modal.js': 2, 'jellyseerr/moreinfo/more-info-modal-actions-tv.js': 9,
  'jellyseerr/moreinfo/more-info-modal-actions.js': 16, 'jellyseerr/moreinfo/more-info-modal-init.js': 5,
  'jellyseerr/nativedetails/native-details.js': 9, 'jellyseerr/seerr-detail-link.js': 1,
  'jellyseerr/ui/ui-buttons.js': 10, 'jellyseerr/ui/ui-cards.js': 23, 'jellyseerr/ui/ui-request-modals.js': 10,
  'jellyseerr/ui/ui-season-modal.js': 5, 'jellyseerr/ui/ui-quota.js': 4,
  'core/session-action.js': 1,
  'jellyseerr/ui/ui-popover.js': 2,
  'arr/admin/admin-render.js': 2,
  'arr/requests/requests-page-init.js': 1,
};

/**
 * Custom events (document, window or body) whose listeners change the DOM without a publication, each with the reason:
 * none is a write's answer (D46S2-R8-2: those are completions and go through JE.publication).
 */
export const EVENT_LISTENERS = {
  'jellyseerr-more-info-opened': 'a window opening: the action bar and the status pill mount into it while it is shown (no write\'s answer)',
  'je-hidden-content-changed': 'the viewer\'s Hidden Content rules changed (a whole-document state with its own save): pages re-filter what they show',
  'je:user-data-loaded': 'the signed-in viewer\'s settings loaded: pages draw with them',
  'je-bookmarks-updated': 'the bookmarks library redraws after its own edits (no title action)',
  'je-spoiler-policy-changed': 'the viewer\'s Spoiler Guard policy changed: pages redraw what they blur (the window reopens under its owner, D46S2-R6-1)',
  'jellyseerr-manual-refresh': 'the viewer asked the search results to refresh: a read that redraws them',
};

/**
 * Completion events: none any more (D46S2-R9-5). A completion changes UI only through its publication's handle
 * (JE.publication run/apply/publish, followed through JE.followPublications), so dispatching or listening to one fails.
 */
export const PUBLICATIONS = { completion: /-requested$/, publisher: null, listeners: EVENT_LISTENERS };

const CONFIG = { excludedModules: EXCLUDED_MODULES, excludedSites: EXCLUDED_SITES, forwarders: FORWARDERS };

/** Both scans of `sources`, with the per-file counts checked: {transport, owners, failures}. */
export function scan(sources) {
  const transport = scanTransport(sources, CONFIG);
  const owners = scanOwners(sources, OPENERS, { nativeRoots: NATIVE_ROOTS, ownerRoots: OWNER_ROOTS, hostDialogs: HOST_DIALOG_MODULES });
  const publications = scanPublications(sources, PUBLICATIONS);
  const failures = [...transport.failures, ...owners.failures, ...publications.failures];
  const count = (sites, expected, what) => {
    const counts = {};
    for (const site of sites) counts[site.file] = (counts[site.file] || 0) + 1;
    for (const [file, n] of Object.entries(expected)) if ((counts[file] || 0) !== n) failures.push(`${file}: ${counts[file] || 0} ${what}, expected ${n}`);
    for (const file of Object.keys(counts)) if (!(file in expected)) failures.push(`${file}: ${counts[file]} ${what} not in the expected table`);
  };
  count(transport.sites, SITES, 'transport sites');
  count(owners.sites, OWNER_SITES, 'owner sites');
  for (const file of Object.keys(EXCLUDED_MODULES)) if (!(file in sources)) failures.push(`${file}: an excluded module that does not exist`);
  // Every pinned root is still a site (a stale pin would excuse the next one at that name).
  for (const [roots, what] of [[NATIVE_ROOTS, 'JE.NATIVE'], [OWNER_ROOTS, 'node owner']]) for (const [file, pins] of Object.entries(roots)) for (const key of Object.keys(pins)) {
    const [fn] = key.split(': ');
    if (!owners.sites.some(site => site.file === file && site.fn === fn)) failures.push(`${file}: the pinned ${what} root ${key} is no longer a site`);
  }
  for (const file of Object.keys(HOST_DIALOG_MODULES)) if (!(file in sources)) failures.push(`${file}: a host-dialog module that does not exist`);
  return { transport, owners, publications, failures };
}
