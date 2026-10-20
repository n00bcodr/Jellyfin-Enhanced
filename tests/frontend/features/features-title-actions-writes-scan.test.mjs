import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSources } from '../helpers/bundle-scan.mjs';
import { EXCLUDED_MODULES, EXCLUDED_SITES, FORWARDERS, NATIVE_ROOTS, OWNER_ROOTS, HOST_DIALOG_MODULES, scan } from '../helpers/title-actions-scan-config.mjs';

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
  // r7: the window's five movie request paths share one send (sendMovieRequest), so 14 → 10.
  assert.equal(transport.sites.filter(s => /^(requestMedia|requestTvSeasons)\(\)$/.test(s.entry)).length, 10);
});

test('pinned roots: every native root, node-owner root and host-dialog module has a reason', () => {
  for (const roots of [NATIVE_ROOTS, OWNER_ROOTS]) for (const [file, pins] of Object.entries(roots)) {
    assert.ok(SOURCES[file], file);
    for (const reason of Object.values(pins)) assert.ok(reason.length > 20, file);
  }
  for (const [file, reason] of Object.entries(HOST_DIALOG_MODULES)) { assert.ok(SOURCES[file], file); assert.ok(reason.length > 20, file); }
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
  'R6-2: options via a variable in the More Info Request path': ['jellyseerr/moreinfo/more-info-modal-actions.js',
    s => s.replace("    ui.busy?.();\n", "    ui.busy?.();\n    const o = { method: 'POST', body: {} }; await JE.core.api.plugin('/jellyseerr/request', o);\n"),
    /more-info-modal-actions\.js:\d+ write JE\.core\.api\.plugin \(POST without bound\)/],
  'R6-2: options from a call (unmodelled)': ['jellyseerr/moreinfo/more-info-modal-actions.js',
    s => s.replace("    ui.busy?.();\n", "    ui.busy?.();\n    await JE.core.api.plugin('/jellyseerr/request', makeOptions());\n"),
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
  'r5: the window\'s requestMedia (its 4K popup\'s too) without its binding': ['jellyseerr/moreinfo/more-info-modal-actions.js',
    s => s.replace("is4k ? { is4k: true } : {}, false, data, null, { bound: submitted.bound() })", "is4k ? { is4k: true } : {}, false, data)"), /more-info-modal-actions\.js:\d+ write requestMedia\(\)/],
  'r5: the Collection loop\'s requestMedia without its binding': ['jellyseerr/ui/ui-request-modals.js',
    s => s.replace("searchResultItem, null, { bound });", 'searchResultItem);'), /ui-request-modals\.js:\d+ write requestMedia\(\)/],
  'r5: a requestMedia on the search page without a binding': ['jellyseerr/jellyseerr.js',
    s => s.replace(", null, { bound: JE.captureSubmitted(owner).bound() }); // Pass searchResultItem", '); // Pass searchResultItem'), /jellyseerr\.js:\d+ write requestMedia\(\)/],
  'r5: a new plugin DELETE in the action bar': ['arr/actions/title-actions-hosts.js',
    s => s.replace('function dispose() {', "function dispose() { JE.core.api.plugin('/x', { method: 'DELETE' });"), /title-actions-hosts\.js:\d+ write JE\.core\.api\.plugin \(DELETE/],
  'r5: the drawer wrapper no longer binding its callers': ['arr/manage/manage-drawer.js',
    s => s.replace('{ ...options, bound: state.action.bound(() => current === state && (!owner || owner())) }', '{ ...options }'), /manage-drawer\.js:\d+ write boundApi\(\) \(POST without bound\)/],
  'r5: an unbound Seerr post()': ['jellyseerr/api.js', s => s.replace("const result = await post('/issue', body, submitted.bound());", "const result = await post('/issue', body);"), /api\.js:\d+ write post\(\)/],
  'r5: the JE-mode Collection picker\'s asks without their binding': ['arr/ask/ask-seerr.js', s => s.replace('`), { bound });', '`));'), /ask-seerr\.js:\d+ write ask\(\)/],
  'r5: a Search sent without its binding': ['arr/ask/ask-sheet.js', s => s.replace('instanceId, { bound: submitted.bound() })', 'instanceId)'), /ask-sheet\.js:\d+ write adminSearch\(\)/],
  'r5: Remind without its binding': ['arr/notify/notify-core.js', s => s.replace(', bound: submitted.bound() });\n            return { ok: true, nextAt', ' });\n            return { ok: true, nextAt'), /notify-core\.js:\d+ write api\(\) \(POST without bound\) \/acquire\/remind/],
  'r5: a site the scan stops seeing (count)': ['enhanced/spoilerguard/state.js', s => s.replace('return JE.core.api.plugin(path, options);', 'return Promise.resolve(path, options);'), /state\.js: \d+ transport sites, expected \d+/],
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
    s => s.replace("        // TV always shows season selection modal\n        if (JE.jellyseerrUI?.showSeasonSelectionModal) {\n            JE.jellyseerrUI.showSeasonSelectionModal(data.id, 'tv', data.title || data.name, data, false, JE.ownerOf(e));", '        {'), /more-info-modal-actions-tv\.js: \d+ owner sites, expected \d+/],
  // r7 (D46S2-R7-1): a handler on a control the bar can press takes its owner from its press only.
  'R7-1: the window\'s Request handler takes its owner from its button': ['jellyseerr/moreinfo/more-info-modal-actions.js',
    s => s.replace("            // The press is the owner (D46S2-R7-1): the action bar's operation when the bar pressed it, else the window's.\n            const owner = JE.ownerOf(e);", '            const owner = JE.ownerOf(mainButton);'),
    /more-info-modal-actions\.js:\d+ \w+\(…\) in a handler takes its owner from owner, not its press/],
  'R7-1: the window\'s Request handler captures its button (the r6 form)': ['jellyseerr/moreinfo/more-info-modal-actions.js',
    s => s.replace("            const owner = JE.ownerOf(e);\n            if (JE.jellyseerrAPI.shouldShowAdvanced()) {\n                window.JellyfinEnhanced?.jellyseerrUI?.showMovieRequestModal?.(data.id, data.title || data.name, data, false, owner);\n                return;\n            }\n            await sendMovieRequest(data, false, owner, buttonStates(requestButton",
      "            const owner = JE.captureSubmitted(requestButton).owner;\n            if (JE.jellyseerrAPI.shouldShowAdvanced()) {\n                window.JellyfinEnhanced?.jellyseerrUI?.showMovieRequestModal?.(data.id, data.title || data.name, data, false, owner);\n                return;\n            }\n            await sendMovieRequest(data, false, owner, buttonStates(requestButton"),
    /more-info-modal-actions\.js:\d+ \w+\(…\) in a handler takes its owner from .*requestButton.*, not its press|more-info-modal-actions\.js:\d+ \w+\(…\) in a handler takes its owner from owner, not its press/],
  'R7-1: the window\'s 4K popup registered for the arrow button\'s node': ['jellyseerr/moreinfo/more-info-modal-actions.js',
    s => s.replace("close4k(); }, JE.ownerOf(e));", 'close4k(); }, arrowButton);'), /more-info-modal-actions\.js:\d+ openSurface\(…\) in a handler takes its owner from arrowButton, not its press/],
  'R7-1: the More sheet\'s Request in 4K passing the window instead of its operation': ['arr/actions/title-actions.js',
    s => s.replace('run: (_opener, submitted) => root.jeRequest4k(submitted) });', 'run: () => root.jeRequest4k(root) });'), /title-actions\.js:\d+ jeRequest4k\(…\) in a handler takes its owner from root, not its press/],
  'R7-1: the More sheet\'s Request in 4K dropping its operation': ['arr/actions/title-actions.js',
    s => s.replace('run: (_opener, submitted) => root.jeRequest4k(submitted) });', 'run: () => root.jeRequest4k() });'), /title-actions\.js:\d+ jeRequest4k\(…\) without an owner/],
  'R7-1: a window handler naming itself native': ['jellyseerr/moreinfo/more-info-modal-actions.js',
    s => s.replace("            // The press is the owner (D46S2-R7-1): the action bar's operation when the bar pressed it, else the window's.\n            const owner = JE.ownerOf(e);", '            const owner = JE.NATIVE;'),
    /more-info-modal-actions\.js:\d+ \w+\(JE\.NATIVE\) outside a pinned native root/],
  'R7-1: the window\'s TV Request handler takes its owner from its button': ['jellyseerr/moreinfo/more-info-modal-actions-tv.js',
    s => s.replace("data, false, JE.ownerOf(e));", 'data, false, mainButton);'), /more-info-modal-actions-tv\.js:\d+ showSeasonSelectionModal\(…\) in a handler takes its owner from mainButton, not its press/],
  'R7-1: the window\'s Collection press takes its owner from its button': ['jellyseerr/moreinfo/more-info-modal-init.js',
    s => s.replace('{ operation: JE.ownerOf(e) }', '{ operation: collectionBtn }'), /more-info-modal-init\.js:\d+ showCollectionRequestModal\(…\) in a handler takes its owner from collectionBtn, not its press/],
  'R7-1: a Seerr form\'s Save takes its owner from the form node': ['jellyseerr/ui/ui-season-modal.js',
    s => s.replace('const submitted = JE.captureSubmitted(press);', 'const submitted = JE.captureSubmitted(modalEl);'), /ui-season-modal\.js:\d+ captureSubmitted\(…\) in a handler takes its owner from argument 0, not its press/],
  'R7-1: a Seerr form\'s Save takes the opener\'s owner instead of its press (Report)': ['jellyseerr/issue-reporter.js',
    s => s.replace('const reporter = JE.captureSubmitted(press);', 'const reporter = submitted;'), /issue-reporter\.js:\d+ reportIssue\(…\) in a handler takes its owner from/],
  // Q-PLAYR20-1: a caller outside the action bar (the play edge's list pages) opening the request sheet or the More Info
  // window without an owner opens nothing in production; any module doing so fails the scan here (in scope by default).
  'Q-PLAYR20-1: a list page opening the request sheet without an owner': ['arr/lists/list-request.js',
    () => "(function (JE) { JE.listAsk = (key, opener) => JE.arrAskSheet.open({ key, kind: 'movie', name: '' }, { opener }); })(window.JellyfinEnhanced);",
    /list-request\.js:\d+ open\(…\) without an owner/],
  'Q-PLAYR20-1: a list page opening the More Info window without an owner': ['arr/lists/list-pages.js',
    () => "(function (JE) { JE.listInfo = id => JE.jellyseerrMoreInfo.open(id, 'movie'); })(window.JellyfinEnhanced);",
    /list-pages\.js:\d+ open\(…\) without an owner/],
  'Q-PLAYR20-1: a list page opening them natively (JE.NATIVE) outside a pinned native root': ['arr/lists/list-pages.js',
    () => "(function (JE) { JE.listInfo = id => JE.jellyseerrMoreInfo.open(id, 'movie', undefined, JE.NATIVE); })(window.JellyfinEnhanced);",
    /list-pages\.js:\d+ open\(JE\.NATIVE\) outside a pinned native root/],
  // r7 (D46S2-R7-4): host dialogs are openers.
  'R7-4: the quota dialog opened with Dashboard.alert directly': ['jellyseerr/ui/ui-quota.js',
    s => s.replace('JE.openHostDialog(() => window.Dashboard.alert({ title, message }), submitted.owner);', 'window.Dashboard.alert({ title, message });'), /ui-quota\.js:\d+ Dashboard\.alert\(…\) opens a host dialog outside JE\.openHostDialog/],
  'R7-4: the quota dialog without its owner': ['jellyseerr/moreinfo/more-info-modal-actions.js',
    s => s.replace("showQuotaErrorDialog(error, 'movie', submitted);", "showQuotaErrorDialog(error, 'movie');"), /more-info-modal-actions\.js:\d+ showQuotaErrorDialog\(…\) without an owner/],
  'R7-4: a confirm() in a new module (in scope by default)': ['arr/actions/new-dialog.js',
    () => '(function (JE) { JE.y = () => confirm(\'sure?\'); })(window.JellyfinEnhanced);', /new-dialog\.js:\d+ confirm\(…\) opens a host dialog outside JE\.openHostDialog/],
  // r7 (D46S2-R7-2): the transport scan fails closed on what it cannot resolve (both reviewers' forms and more).
  'R7-2: a computed transport member (JE.core.api[name])': ['arr/actions/title-actions-hosts.js',
    s => s.replace('function dispose() {', "function dispose() { let name = 'plugin'; JE.core.api[name]('/x', { method: 'POST' });"), /title-actions-hosts\.js:\d+ unmodelled .*a computed member of a transport root/],
  'R7-2: a constant computed member (\'plug\' + \'in\') is resolved and classified': ['arr/actions/title-actions-hosts.js',
    s => s.replace('function dispose() {', "function dispose() { JE.core.api['plug' + 'in']('/x', { method: 'POST' });"), /title-actions-hosts\.js:\d+ write JE\.core\.api\.plugin \(POST without bound\)/],
  'R7-2: a computed member on an alias of the api': ['arr/actions/title-actions-hosts.js',
    s => s.replace('function dispose() {', "function dispose() { const api = JE.core.api; const m = ['plugin'][0]; api[m]('/x', { method: 'POST' });"), /title-actions-hosts\.js:\d+ unmodelled .*a computed member of a transport root/],
  'R7-2: a computed member of ApiClient': ['arr/actions/title-actions-hosts.js',
    s => s.replace('function dispose() {', "function dispose() { let verb = 'ajax'; ApiClient[verb]({ type: 'POST', url: '/x' });"), /title-actions-hosts\.js:\d+ unmodelled .*a computed member of a transport root/],
  'R7-2: a computed member of window (\'fet\' + \'ch\') is resolved and classified': ['arr/actions/title-actions-hosts.js',
    s => s.replace('function dispose() {', "function dispose() { window['fet' + 'ch']('/x', { method: 'POST' });"), /title-actions-hosts\.js:\d+ write fetch/],
  'R7-2: a transport method through call()': ['arr/actions/title-actions-hosts.js',
    s => s.replace('function dispose() {', "function dispose() { JE.core.api.plugin.call(null, '/x', { method: 'POST' });"), /title-actions-hosts\.js:\d+ unmodelled .*through call\/apply\/bind/],
  'R7-2: a transport method through apply()': ['arr/actions/title-actions-hosts.js',
    s => s.replace('function dispose() {', "function dispose() { JE.core.api.plugin.apply(null, ['/x', { method: 'POST' }]);"), /title-actions-hosts\.js:\d+ unmodelled .*through call\/apply\/bind/],
  'R7-2: a transport method through Reflect.apply': ['arr/actions/title-actions-hosts.js',
    s => s.replace('function dispose() {', "function dispose() { Reflect.apply(JE.core.api.plugin, null, ['/x', { method: 'POST' }]);"), /title-actions-hosts\.js:\d+ unmodelled JE\.core\.api\.plugin \(a transport method taken as a value\)/],
  'R7-2: the api escaping through Reflect.get': ['arr/actions/title-actions-hosts.js',
    s => s.replace('function dispose() {', "function dispose() { Reflect.get(JE.core.api, 'plugin')('/x', { method: 'POST' });"), /title-actions-hosts\.js:\d+ unmodelled .*a transport value that escapes/],
  'R7-2: a destructured transport method': ['arr/actions/title-actions-hosts.js',
    s => s.replace('function dispose() {', "function dispose() { const { plugin } = JE.core.api; plugin('/x', { method: 'POST' });"), /title-actions-hosts\.js:\d+ write JE\.core\.api\.plugin \(POST without bound\)/],
  'R7-2: the api passed to a helper': ['arr/actions/title-actions-hosts.js',
    s => s.replace('function dispose() {', 'function dispose() { const api = JE.core.api; send(api);'), /title-actions-hosts\.js:\d+ unmodelled .*a transport value that escapes/],
  'R7-2: the api in a let (reassignable) alias': ['arr/actions/title-actions-hosts.js',
    s => s.replace('function dispose() {', "function dispose() { let api = JE.core.api; api.plugin('/x', { method: 'POST' });"), /title-actions-hosts\.js:\d+ unmodelled .*a transport value that escapes/],
  'R7-2: JE under another name in a new module': ['arr/actions/new-alias.js',
    () => "(function (J) { J.x = () => J.core.api.plugin('/x', { method: 'POST' }); })(window.JellyfinEnhanced);", /new-alias\.js:\d+ write JE\.core\.api\.plugin \(POST without bound\)/],
};
for (const [name, [file, plant, expected]] of Object.entries(PLANTED)) {
  test(`planted bypass fails the scans: ${name}`, () => {
    const planted = plant(SOURCES[file]);
    assert.notEqual(planted, SOURCES[file], 'the bypass was planted');
    const { failures } = scan({ ...SOURCES, [file]: planted });
    assert.ok(failures.some(f => expected.test(f)), `expected a failure matching ${expected}, got ${JSON.stringify(failures)}`);
  });
}
