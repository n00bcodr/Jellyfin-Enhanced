import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSources, scanTransport, scanOwners } from '../helpers/bundle-scan.mjs';

// D46 slice 2 review round 6 (shapes 1 and 2), replacing round 5's declared-graph write scan.
// Shape 2: the scan fails closed over the whole bundle. Every call of every transport entry point in js/ (JE.core.api.*,
// fetch, ApiClient.*, XMLHttpRequest, navigator.sendBeacon, and their aliases) is a site. A READ only when provably GET;
// options must be an inline literal, a same-function const literal, or a parameter forwarded to the callers (whose calls
// become sites); a write passes only with `bound`; anything else is "unmodelled" and fails. Module scope is the whole
// bundle minus EXCLUDED_MODULES (each with why the action bar cannot reach it); a site inside an in-scope module is
// excused only by EXCLUDED_SITES (by its function, with a reason). Counts are asserted per file.
// Shape 1: ownership is explicit. Every call of an owner-taking function (OPENERS: every surface opener the bar can
// reach, and the owned writes) passes its owner; an owner taken from a parameter makes that function an owner-taker
// too. Runtime behaviour is tested in the title-actions scopes, transport and r6 suites; these scans find the next bypass.

/** Modules the action bar cannot reach, each with the reason (anything not listed is in scope). */
export const EXCLUDED_MODULES = {
  'core/api-client.js': 'implements the transport entry points: its own fetch calls are the transport; every caller\'s call is the site',
  'arr/admin/admin-tabs.js': null, // in scope (removeDialog and its helpers); the hub-only functions are excused by site below
  'arr/ask/ask-actions.js': 'the details page\'s smart actions under the status block (Get Season N, Get 4K, Search): outside the action row, never pressed by the bar',
  'arr/ask/ask-collection.js': 'a collection page\'s "Get the N missing" block: no details row, never pressed by the bar',
  'arr/ask/ask-episodes.js': 'a season page\'s episode rows and their dialog: the request sheet never opens them',
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
  // Play edge only (modules the action-bar branch doesn't have; the integration rebuild owns them). None is reachable
  // from the bar; the three own-fetch modules are also the Q-PLAYD51-3 pendingRebuild exemption in core-session-requests.
  'arr/admin/admin-automation.js': 'the Requests page\'s administrator automation card (phase 4a): its mode and kill-switch POSTs, no title action',
  'arr/adminusers/admin-users-api.js': 'Dashboard → Users → Jellyfin Enhanced tab: the administrator user-settings transport (own fetch, Q-PLAYD51-3), no title action',
  'arr/adminusers/admin-users.js': 'Dashboard → Users → Jellyfin Enhanced tab: its only flagged site is ApiClient.serverVersion(), a local version read, no title action',
  'arr/lists/list-api.js': 'the list pages\' transport (phase 4c, own fetch, Q-PLAYD51-3): list tickets and the session check bind it; the bar never opens a list sheet (it never sets `fixed`)',
  'arr/lists/list-grid.js': 'the list grid\'s summaries read, a POST that changes nothing (phase 4c, own fetch, Q-PLAYD51-3), no title action',
  'arr/ready/ready-settings.js': 'the JE settings panel\'s "Ready to watch" section (phase 4f): the person\'s own Ready settings saves, no title action',
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
  'arr/requests/requests-page-render-cards.js': 1, 'arr/status/status-arrival.js': 1, 'arr/status/status-core.js': 2,
  'awards/awards.js': 3, 'core/api-client.js': 2, 'core/navigation.js': 1, 'elsewhere/elsewhere.js': 6,
  'elsewhere/reviews.js': 12, 'enhanced/bookmarks/bookmarks-library-items.js': 3,
  'enhanced/bookmarks/bookmarks-library-replacements.js': 2, 'enhanced/bookmarks/bookmarks.js': 3,
  'enhanced/catchup/catchup-activity.js': 1, 'enhanced/catchup/catchup-core.js': 7, 'enhanced/config.js': 2,
  'enhanced/features-random-button.js': 2, 'enhanced/helpers.js': 3,
  'enhanced/hiddencontent/hidden-content-buttons.js': 4, 'enhanced/hiddencontent/hidden-content-data.js': 2,
  'enhanced/hiddencontent/hidden-content-filter.js': 2, 'enhanced/hiddencontent/hidden-content-page-admin.js': 1,
  'enhanced/hiddencontent/hidden-content-save.js': 5, 'enhanced/homeremoval/features-remove-home.js': 2,
  'enhanced/itemdetails/features-details-media-info.js': 7, 'enhanced/itemdetails/features-details-page.js': 3,
  'enhanced/itemdetails/features-release-dates.js': 3, 'enhanced/native-tabs.js': 1,
  'enhanced/player/auto-skip.js': 2, 'enhanced/player/osd-rating.js': 2, 'enhanced/player/pausescreen.js': 3,
  'enhanced/player/playback-rating-badge.js': 2, 'enhanced/player/playback.js': 4,
  'enhanced/settingspanel/ui-panel-language.js': 3, 'enhanced/settingspanel/ui-panel-settings.js': 4,
  'enhanced/settingspanel/ui-release-notes.js': 1,
  'enhanced/spoilerguard/state.js': 3, 'enhanced/spoilerguard/watched-refresh.js': 4, 'enhanced/translations.js': 8,
  'extras/active-streams.js': 2, 'extras/activity-page.js': 2, 'extras/plugin-icons.js': 1, 'jellyseerr/api.js': 33,
  'jellyseerr/discovery/collection-discovery.js': 1, 'jellyseerr/discovery/discovery-filter-utils.js': 1,
  'jellyseerr/discovery/genre-discovery.js': 1, 'jellyseerr/discovery/network-discovery.js': 1,
  'jellyseerr/discovery/person-discovery.js': 2, 'jellyseerr/issue-reporter.js': 7, 'jellyseerr/item-details.js': 5,
  'jellyseerr/jellyseerr.js': 2, 'jellyseerr/moreinfo/more-info-modal-actions.js': 6,
  'jellyseerr/moreinfo/more-info-modal-data.js': 2, 'jellyseerr/moreinfo/more-info-modal-seasons.js': 3,
  'jellyseerr/nativedetails/native-details.js': 5, 'jellyseerr/seerr-detail-link.js': 1,
  'jellyseerr/ui/ui-badges.js': 1, 'jellyseerr/ui/ui-buttons.js': 2, 'jellyseerr/ui/ui-quota.js': 1,
  'jellyseerr/ui/ui-request-modals.js': 3, 'jellyseerr/ui/ui-season-modal.js': 5, 'others/letterboxd-links.js': 1,
  'others/mdblist-ratings.js': 3, 'plugin.js': 8, 'tags/ageratingtags.js': 1, 'tags/peopletags.js': 3,
  'tags/qualitytags.js': 1, 'tags/tag-pipeline.js': 8, 'tags/tag-styles.js': 1, 'tags/userreviewtags.js': 1,
  // Play edge only (see EXCLUDED_MODULES): list-pages.js and list-render.js are reads.
  'arr/admin/admin-automation.js': 2, 'arr/adminusers/admin-users-api.js': 1, 'arr/adminusers/admin-users.js': 3,
  'arr/lists/list-api.js': 1, 'arr/lists/list-grid.js': 1, 'arr/lists/list-pages.js': 1, 'arr/lists/list-render.js': 1,
  'arr/ready/ready-settings.js': 1,
  // Integration rebuild (4d home rows, the Does the Dog Die panel): reads only.
  'arr/home/home-rows.js': 1, 'others/doesthedogdie.js': 4,
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
  { name: 'captureSubmitted', arg: 0, callee: /(^|\.)captureSubmitted$/, label: 'owner capture' },
  { name: 'createSessionAction', arg: 0, prop: 'owner', optional: true, forbid: ['submitted'], callee: /(^|\.)createSessionAction$/, label: 'owned session action' },
  { name: 'removeDialog', arg: 5, callee: /(^|\.)removeDialog$/, label: 'Remove dialog' },
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

/** Owner sites per file: a scan that sees fewer or more has stopped seeing them. */
export const OWNER_SITES = {
  'arr/actions/title-actions-hosts.js': 2, 'arr/actions/title-actions-sheet.js': 2,
  'arr/actions/title-actions.js': 8, 'arr/admin/admin-tabs.js': 5, 'arr/ask/ask-actions.js': 2,
  'arr/ask/ask-seerr.js': 10, 'arr/ask/ask-sheet.js': 9, 'arr/hub/hub-discover.js': 3, 'arr/hub/hub-page.js': 2,
  'arr/manage/manage-drawer.js': 4, 'arr/notify/notify-core.js': 2, 'arr/notify/notify-follow.js': 3,
  'arr/requests/requests-page-render.js': 1, 'arr/status/status-modal.js': 1,
  'enhanced/hiddencontent/hidden-content-buttons.js': 5, 'enhanced/hiddencontent/hidden-content-data.js': 8,
  'enhanced/hiddencontent/hidden-content-dialogs.js': 3, 'enhanced/hiddencontent/hidden-content-page-cards.js': 1,
  'enhanced/hiddencontent/hidden-content-panel.js': 1, 'enhanced/itemdetails/features-details-page.js': 4,
  'enhanced/spoilerguard/detail-button.js': 11, 'enhanced/spoilerguard/dialog.js': 3,
  'enhanced/spoilerguard/seerr-toggle.js': 4, 'enhanced/spoilerguard/settings-tab.js': 1,
  'enhanced/spoilerguard/state.js': 10, 'jellyseerr/api.js': 1, 'jellyseerr/hss-discovery-handler.js': 1,
  'jellyseerr/issue-reporter.js': 5, 'jellyseerr/item-details.js': 1, 'jellyseerr/jellyseerr.js': 7,
  'jellyseerr/modal.js': 2, 'jellyseerr/moreinfo/more-info-modal-actions-tv.js': 9,
  'jellyseerr/moreinfo/more-info-modal-actions.js': 13, 'jellyseerr/moreinfo/more-info-modal-init.js': 5,
  'jellyseerr/nativedetails/native-details.js': 8, 'jellyseerr/seerr-detail-link.js': 1,
  'jellyseerr/ui/ui-buttons.js': 5, 'jellyseerr/ui/ui-cards.js': 16, 'jellyseerr/ui/ui-request-modals.js': 5,
  'jellyseerr/ui/ui-results.js': 1, 'jellyseerr/ui/ui-season-modal.js': 5,
  // Play edge only: a list placeholder's request sheet and its More Info fallback, both a native entry point (JE.NATIVE).
  'arr/lists/list-pages.js': 1, 'arr/lists/list-request.js': 1,
  // Integration rebuild: a collection gap's and a home row card's More Info fallback, both native entry points.
  'arr/ask/ask-collection.js': 1, 'arr/home/home-render.js': 1,
};

const CONFIG = { excludedModules: EXCLUDED_MODULES, excludedSites: EXCLUDED_SITES, forwarders: FORWARDERS };

/** Both scans of `sources`, with the per-file counts checked: {transport, owners, failures}. */
export function scan(sources) {
  const transport = scanTransport(sources, CONFIG);
  const owners = scanOwners(sources, OPENERS);
  const failures = [...transport.failures, ...owners.failures];
  const count = (sites, expected, what) => {
    const counts = {};
    for (const site of sites) counts[site.file] = (counts[site.file] || 0) + 1;
    for (const [file, n] of Object.entries(expected)) if ((counts[file] || 0) !== n) failures.push(`${file}: ${counts[file] || 0} ${what}, expected ${n}`);
    for (const file of Object.keys(counts)) if (!(file in expected)) failures.push(`${file}: ${counts[file]} ${what} not in the expected table`);
  };
  count(transport.sites, SITES, 'transport sites');
  count(owners.sites, OWNER_SITES, 'owner sites');
  for (const file of Object.keys(EXCLUDED_MODULES)) if (!(file in sources)) failures.push(`${file}: an excluded module that does not exist`);
  return { transport, owners, failures };
}

const SOURCES = readSources();

test('scope: every excluded module and site exists, each with a reason', () => {
  for (const [file, reason] of Object.entries(EXCLUDED_MODULES)) { assert.ok(SOURCES[file], file); assert.ok(reason?.length > 20, file); }
  for (const [file, sites] of Object.entries(EXCLUDED_SITES)) { assert.ok(SOURCES[file], file); for (const reason of Object.values(sites)) assert.ok(reason.length > 20, file); }
  // admin-tabs.js is in scope: removeDialog (the drawer's Remove) and its helpers are checked.
  assert.ok(!('arr/admin/admin-tabs.js' in EXCLUDED_MODULES));
});

test('whole-bundle transport scan: every site is a read, bound, forwarded or excused (counted per file)', () => {
  const { transport, failures } = scan(SOURCES);
  assert.deepEqual(failures, []);
  assert.ok(transport.sites.length >= 250, `${transport.sites.length} transport sites seen`);
  assert.deepEqual([...transport.forwarders.keys()].sort(), Object.keys(FORWARDERS).sort(), 'the forwarders found are the pinned ones');
  assert.deepEqual([...transport.wrappers].sort(), ['arr/manage/manage-drawer.js::boundApi', 'enhanced/spoilerguard/state.js::mutateState']);
  // Every Seerr request call in the bundle is a site (requestMedia / requestTvSeasons forward their caller's binding).
  assert.equal(transport.sites.filter(s => /^(requestMedia|requestTvSeasons)\(\)$/.test(s.entry)).length, 14);
});

test('owner scan: every opener and owned write the bar can reach passes its owner (counted per file)', () => {
  const { owners, failures } = scan(SOURCES);
  assert.deepEqual(failures, []);
  assert.ok(owners.sites.length >= 180, `${owners.sites.length} owner sites seen`);
  assert.equal(owners.sites.filter(s => s.owner === 'missing' || s.owner === 'inferred').length, 0);
});

/** Each planted bypass, applied to the real sources, must fail the scans with the named site. */
const PLANTED = {
  // r6 (D46S2-R6-2): the More Info Request handler's write with its options in a variable.
  'R6-2: options via a variable in the More Info Request handler': ['jellyseerr/moreinfo/more-info-modal-actions.js',
    s => s.replace("requestButton.disabled = true;\n            requestButton.innerHTML = `<span>${JE.t('jellyseerr_btn_requesting')}</span>",
      "requestButton.disabled = true;\n            const o = { method: 'POST', body: {} }; await JE.core.api.plugin('/jellyseerr/request', o);\n            requestButton.innerHTML = `<span>${JE.t('jellyseerr_btn_requesting')}</span>"),
    /more-info-modal-actions\.js:\d+ write JE\.core\.api\.plugin \(POST without bound\)/],
  'R6-2: options from a call (unmodelled)': ['jellyseerr/moreinfo/more-info-modal-actions.js',
    s => s.replace("requestButton.disabled = true;\n            requestButton.innerHTML", "requestButton.disabled = true;\n            await JE.core.api.plugin('/jellyseerr/request', makeOptions());\n            requestButton.innerHTML"),
    /more-info-modal-actions\.js:\d+ unmodelled JE\.core\.api\.plugin/],
  // r6 (D46S2-R6-5): an unbound plugin DELETE inside the real removeDialog (admin-tabs.js is in scope).
  'R6-5: an unbound DELETE inside admin-tabs removeDialog': ['arr/admin/admin-tabs.js',
    s => s.replace("        const blockLabel = el('label');", "        JE.core.api.plugin('/arr/admin/queue/x', { method: 'DELETE' });\n        const blockLabel = el('label');"),
    /admin-tabs\.js:\d+ write JE\.core\.api\.plugin \(DELETE without bound\)/],
  'a fetch POST in an in-scope module': ['arr/actions/title-actions-hosts.js',
    s => s.replace('function dispose() {', "function dispose() { fetch('/x', { method: 'POST' });"), /title-actions-hosts\.js:\d+ write fetch/],
  'an ApiClient write in an in-scope module': ['arr/actions/title-actions-hosts.js',
    s => s.replace('function dispose() {', 'function dispose() { ApiClient.updateFavoriteStatus(1, 2, true);'), /title-actions-hosts\.js:\d+ write ApiClient\.updateFavoriteStatus/],
  'an aliased ApiClient ajax POST': ['arr/actions/title-actions-hosts.js',
    s => s.replace('function dispose() {', "function dispose() { const ac = window.ApiClient; ac.ajax({ type: 'POST', url: '/x' });"), /title-actions-hosts\.js:\d+ write ApiClient\.ajax/],
  'a sendBeacon': ['arr/actions/title-actions-hosts.js', s => s.replace('function dispose() {', "function dispose() { navigator.sendBeacon('/x');"), /title-actions-hosts\.js:\d+ write navigator\.sendBeacon/],
  'an XMLHttpRequest': ['arr/actions/title-actions-hosts.js', s => s.replace('function dispose() {', 'function dispose() { new XMLHttpRequest();'), /title-actions-hosts\.js:\d+ unmodelled XMLHttpRequest/],
  'a transport method taken as a value': ['arr/actions/title-actions-hosts.js', s => s.replace('function dispose() {', 'function dispose() { const send = JE.core.api.plugin; send;'), /title-actions-hosts\.js:\d+ unmodelled JE\.core\.api\.plugin/],
  'a new module (in scope by default) with an unbound write': ['arr/actions/new-owner.js',
    () => "(function (JE) { JE.x = () => JE.core.api.plugin('/x', { method: 'PUT' }); })(window.JellyfinEnhanced);", /new-owner\.js:\d+ write JE\.core\.api\.plugin \(PUT without bound\)/],
  // r5's nine, on the r6 scan.
  'r5: the 4K popup\'s requestMedia without its binding': ['jellyseerr/moreinfo/more-info-modal-actions.js',
    s => s.replace("{ is4k: true }, false, data, null, { bound: JE.captureSubmitted(option).bound() })", "{ is4k: true }, false, data)"), /more-info-modal-actions\.js:\d+ write requestMedia\(\)/],
  'r5: the Collection loop\'s requestMedia without its binding': ['jellyseerr/ui/ui-request-modals.js',
    s => s.replace("searchResultItem, null, { bound });", 'searchResultItem);'), /ui-request-modals\.js:\d+ write requestMedia\(\)/],
  'r5: a requestMedia on the search page without a binding': ['jellyseerr/jellyseerr.js',
    s => s.replace(", null, { bound: JE.captureSubmitted(button).bound() }); // Pass searchResultItem", '); // Pass searchResultItem'), /jellyseerr\.js:\d+ write requestMedia\(\)/],
  'r5: a new plugin DELETE in the action bar': ['arr/actions/title-actions-hosts.js',
    s => s.replace('function dispose() {', "function dispose() { JE.core.api.plugin('/x', { method: 'DELETE' });"), /title-actions-hosts\.js:\d+ write JE\.core\.api\.plugin \(DELETE/],
  'r5: the drawer wrapper no longer binding its callers': ['arr/manage/manage-drawer.js',
    s => s.replace('{ ...options, bound: state.action.bound(() => current === state && (!owner || owner())) }', '{ ...options }'), /manage-drawer\.js:\d+ write boundApi\(\) \(POST without bound\)/],
  'r5: an unbound Seerr post()': ['jellyseerr/api.js', s => s.replace("const result = await post('/issue', body, submitted.bound());", "const result = await post('/issue', body);"), /api\.js:\d+ write post\(\)/],
  'r5: the JE-mode Collection picker\'s asks without their binding': ['arr/ask/ask-seerr.js', s => s.replace('`), { bound });', '`));'), /ask-seerr\.js:\d+ write ask\(\)/],
  'r5: a Search sent without its binding': ['arr/ask/ask-sheet.js', s => s.replace('instanceId, { bound: submitted.bound() })', 'instanceId)'), /ask-sheet\.js:\d+ write adminSearch\(\)/],
  'r5: Remind without its binding': ['arr/notify/notify-core.js', s => s.replace(', bound: submitted.bound() });\n            return { ok: true, nextAt', ' });\n            return { ok: true, nextAt'), /notify-core\.js:\d+ write api\(\) \(POST without bound\) \/acquire\/remind/],
  'r5: a site the scan stops seeing (count)': ['enhanced/spoilerguard/state.js', s => s.replace('return JE.core.api.plugin(path, options);', 'return Promise.resolve(path, options);'), /state\.js: \d+ transport sites, expected \d+/],
  // Play edge: a list placeholder's request sheet without its owner (r6's ask sheet then opens nothing).
  'play edge: the list request sheet without its owner': ['arr/lists/list-request.js',
    s => s.replace('                    operation: JE.NATIVE,\n', ''), /list-request\.js:\d+ open\(…\) without an owner/],
  // Shape 1: an opener without its owner.
  'R6-1: the spoiler-policy reopen without the replaced window\'s owner': ['jellyseerr/moreinfo/more-info-modal-init.js',
    s => s.replace('void moreInfoModal.open(id, type, modal.jeActionScope, owner);', 'void moreInfoModal.open(id, type, modal.jeActionScope);'), /more-info-modal-init\.js:\d+ open\(…\) without an owner/],
  'R6-4: the Share fallback link sheet without its operation': ['arr/actions/title-actions.js',
    s => s.replace('else JE.titleActions.showLink?.(url, submitted);', 'else JE.titleActions.showLink?.(url);'), /title-actions\.js:\d+ showLink\(…\) without an owner/],
  'an inferred owner ({ submitted: true }) reintroduced': ['enhanced/hiddencontent/hidden-content-dialogs.js',
    s => s.replace('const action = JE.createSessionAction({ owner: dialogOptions.owner });', 'const action = JE.createSessionAction({ submitted: true });'), /hidden-content-dialogs\.js:\d+ createSessionAction\(\{ submitted \}\) infers its owner/],
  'a sheet opened without its host': ['arr/actions/title-actions-hosts.js',
    s => s.replace('if (newest()) A.show({ ...state.c, name: title }, entries, opener, action);', 'if (newest()) A.show({ ...state.c, name: title }, entries, opener);'), /title-actions-hosts\.js:\d+ show\(…\) without an owner/],
  'a Manage drawer opened without its operation': ['arr/actions/title-actions.js',
    s => s.replace('JE.arrManage.open({ key: c.key }, { operation: submitted })', 'JE.arrManage.open({ key: c.key })'), /title-actions\.js:\d+ open\(…\) without an owner/],
  'a native caller dropping its owner (Remove dialog from the hub)': ['arr/admin/admin-tabs.js',
    s => s.replace("        if (action === 'remove') removeDialog(target, busyId, opener, false, undefined, JE.NATIVE);", "        if (action === 'remove') removeDialog(target, busyId, opener, false);"), /admin-tabs\.js:\d+ removeDialog\(…\) without an owner/],
  'a forwarded owner dropped by its caller (Hide confirmation via a parameter)': ['enhanced/hiddencontent/hidden-content-buttons.js',
    s => s.replace('await handleScopedCardHide(card, itemId, cardName, surface, setHiddenState, owner);', 'await handleScopedCardHide(card, itemId, cardName, surface, setHiddenState);'), /hidden-content-buttons\.js:\d+ handleScopedCardHide\(…\) without an owner/],
  'an opener site the scan stops seeing (count)': ['jellyseerr/moreinfo/more-info-modal-actions-tv.js',
    s => s.replace("JE.jellyseerrUI.showSeasonSelectionModal(data.id, 'tv', data.title || data.name, data, false, requestButton);", 'void 0;'), /more-info-modal-actions-tv\.js: \d+ owner sites, expected \d+/],
};
for (const [name, [file, plant, expected]] of Object.entries(PLANTED)) {
  test(`planted bypass fails the scans: ${name}`, () => {
    const planted = plant(SOURCES[file]);
    assert.notEqual(planted, SOURCES[file], 'the bypass was planted');
    const { failures } = scan({ ...SOURCES, [file]: planted });
    assert.ok(failures.some(f => expected.test(f)), `expected a failure matching ${expected}, got ${JSON.stringify(failures)}`);
  });
}
