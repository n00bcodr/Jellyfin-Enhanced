import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settle, setup, mount, INTERRUPTS, press, expireCapabilities, submitReport, sheet, drawer, moreInfo, operationOf, deferred } from '../helpers/title-actions-owners.mjs';

// D46 slice 2 review round 3: the submitted operation reaches every owner the action bar invokes. Each owner
// entry point (the Report modal → reportIssue → reportContext → POST; the Request sheet → me/quota → sheet →
// submit; the one-tap ask; the Manage drawer → feedPosition → overview; Seerr's More Info window and request
// writes) takes the operation it was invoked for, checks it after every await and right before every write or
// open, and behaves exactly as before when invoked natively without one. Every owner here is the REAL module;
// only the server is scripted.

// ---------------------------------------------------------------- Report (D46S2-R3-1)

for (const [name, interrupt] of INTERRUPTS) {
  test(`Report: ${name} while reportIssue awaits reportContext → no POST /jellyseerr/issue`, async t => {
    const h = setup(t); h.a.initialize(); mount(h); await settle();
    await press(h, 'report');
    const context = h.hold('GET', '/jellyseerr/movie/603');
    await submitReport(h);
    interrupt(h);
    context.resolve(); await settle();
    assert.equal(h.sent('POST', '/jellyseerr/issue').length, 0);
  });

  test(`Report: ${name} while the form is open, then submit → no reportContext read, no POST`, async t => {
    const h = setup(t); h.a.initialize(); mount(h); await settle();
    await press(h, 'report');
    interrupt(h); await settle();
    // A remount's own row setup reads the record for the new mount; the form must not read or post.
    const reads = h.sent('GET', '/jellyseerr/movie/603').length;
    if (h.document.querySelector('.jellyseerr-season-modal')) await submitReport(h);
    assert.equal(h.sent('GET', '/jellyseerr/movie/603').length, reads);
    assert.equal(h.sent('POST', '/jellyseerr/issue').length, 0);
  });
}

test('controls: Report submitted on the same session, route and mount posts once', async t => {
  const h = setup(t); h.a.initialize(); mount(h); await settle();
  await press(h, 'report');
  await submitReport(h);
  assert.equal(h.sent('POST', '/jellyseerr/issue').length, 1);
});

test('controls: the native Report form (no operation) still posts after navigating while reportContext is out', async t => {
  const h = setup(t);
  h.JE.jellyseerrIssueReporter.showReportModal('603', 'The Matrix', 'movie', null, null, h.JE.NATIVE); await settle();
  const context = h.hold('GET', '/jellyseerr/movie/603');
  await submitReport(h);
  h.navigate();
  context.resolve(); await settle();
  assert.equal(h.sent('POST', '/jellyseerr/issue').length, 1, 'exactly as before');
});

// ---------------------------------------------------------------- Request sheet (D46S2-R3-2)

for (const [name, interrupt] of INTERRUPTS) {
  test(`Request: ${name} while open() awaits me() → no request sheet`, async t => {
    const h = setup(t); h.a.initialize(); mount(h); await settle();
    const expire = expireCapabilities(h);
    h.row().querySelector('.je-actions-more').click(); await settle();
    expire();
    const me = h.hold('GET', '/acquire/requests/me');
    h.document.querySelector('.je-actions-entry[data-action="request"]').click(); await settle();
    assert.equal(h.sent('GET', '/acquire/requests/me').length >= 2, true, 'open() reads capabilities');
    interrupt(h);
    const quotas = h.sent('GET', '/acquire/requests/quota').length;
    me.resolve(); await settle();
    assert.equal(sheet(h), null);
    assert.equal(h.sent('GET', '/acquire/requests/quota').length, quotas, 'open() stops right after me(): no further reads');
    assert.equal(h.sent('POST', '/acquire/requests').length, 0);
  });

  test(`Request: ${name} while open() awaits the quota → no request sheet`, async t => {
    const h = setup(t); h.a.initialize(); mount(h); await settle();
    const quota = h.hold('GET', '/acquire/requests/quota');
    await press(h, 'request');
    interrupt(h);
    quota.resolve(); await settle();
    assert.equal(sheet(h), null);
  });

  test(`Request: ${name} while the request sheet is open, then submit → no ask`, async t => {
    const h = setup(t); h.a.initialize(); mount(h); await settle();
    await press(h, 'request');
    assert.ok(sheet(h), 'the request sheet is open');
    interrupt(h);
    sheet(h)?.querySelector('.je-sheet-primary')?.click(); await settle();
    assert.equal(h.sent('POST', '/acquire/requests').length, 0);
  });
}

test('controls: Request on the same session, route and mount opens the sheet, and its submit asks once', async t => {
  const h = setup(t); h.a.initialize(); mount(h); await settle();
  await press(h, 'request');
  assert.ok(sheet(h));
  sheet(h).querySelector('.je-sheet-primary').click(); await settle();
  assert.equal(h.sent('POST', '/acquire/requests').length, 1);
});

test('controls: the native request sheet (no operation) still opens after navigating while me() is out', async t => {
  const h = setup(t);
  const me = h.hold('GET', '/acquire/requests/me');
  const opened = h.JE.arrAskSheet.open({ key: 'movie:tmdb:603', kind: 'movie', name: 'The Matrix' }, { operation: h.JE.NATIVE }); await settle();
  h.navigate();
  me.resolve(); await settle();
  assert.ok(sheet(h), 'exactly as before');
  sheet(h).querySelector('.je-sheet-primary').click(); await settle();
  assert.equal(h.sent('POST', '/acquire/requests').length, 1);
  await opened;
});

/** The page's own Request control (the ask mount) as the row's primary, pressed through the compact row. */
async function mountWithAsk(h) {
  h.JE.arrAskSheet.mount(h.row(), { key: 'movie:tmdb:603', kind: 'movie', name: 'The Matrix' }); await settle();
  assert.ok(h.row().querySelector('.je-ask-mount-request'), 'the page offers its own Request');
  mount(h); await settle();
  const primary = h.row().querySelector('.je-actions-row .je-actions-primary');
  assert.ok(primary, 'the compact row shows it as its primary');
  return primary;
}

for (const [name, interrupt] of INTERRUPTS) {
  test(`one-tap ask through the row's primary: ${name} while openOrAsk awaits the quota → no ask`, async t => {
    const h = setup(t); h.a.initialize();
    const primary = await mountWithAsk(h);
    const quota = h.hold('GET', '/acquire/requests/quota');
    primary.click(); await settle();
    interrupt(h);
    quota.resolve(); await settle();
    assert.equal(h.sent('POST', '/acquire/requests').length, 0);
    assert.equal(sheet(h), null);
  });
}

test('controls: the one-tap ask through the row\'s primary asks once on the same route', async t => {
  const h = setup(t); h.a.initialize();
  (await mountWithAsk(h)).click(); await settle();
  assert.equal(h.sent('POST', '/acquire/requests').length, 1);
});

test('controls: the page\'s own Request pressed natively (action bar off) still asks after navigating while the quota is out', async t => {
  const h = setup(t);
  h.JE.arrAskSheet.mount(h.row(), { key: 'movie:tmdb:603', kind: 'movie', name: 'The Matrix' }); await settle();
  const quota = h.hold('GET', '/acquire/requests/quota');
  h.row().querySelector('.je-ask-mount-request').click(); await settle();
  h.navigate();
  quota.resolve(); await settle();
  assert.equal(h.sent('POST', '/acquire/requests').length, 1, 'exactly as before');
});

// ---------------------------------------------------------------- Manage drawer (D46S2-R3-3)

for (const [name, interrupt] of INTERRUPTS) {
  test(`Manage: ${name} while the drawer awaits feedPosition → no overview read, no drawer`, async t => {
    const h = setup(t); h.a.initialize(); mount(h); await settle();
    h.row().querySelector('.je-actions-more').click(); await settle();
    // The sheet has read the status; the drawer's own feed position is held.
    const feed = h.holdFeed();
    h.document.querySelector('.je-actions-entry[data-action="manage"]').click(); await settle();
    assert.ok(drawer(h) || h.sent('GET', '/arr/admin/manage?').length === 0, 'the drawer is opening');
    interrupt(h);
    feed.resolve({ epoch: 'e1', cursor: 1 }); await settle();
    assert.equal(h.sent('GET', '/arr/admin/manage?').length, 0);
    assert.equal(drawer(h), null);
  });

  test(`Manage: ${name} while the overview read is out → the drawer closes, nothing rendered`, async t => {
    const h = setup(t); h.a.initialize(); mount(h); await settle();
    const read = h.hold('GET', '/arr/admin/manage?');
    await press(h, 'manage');
    interrupt(h);
    read.resolve(); await settle();
    assert.equal(drawer(h), null);
  });
}

test('controls: Manage on the same session, route and mount reads the overview once and shows it', async t => {
  const h = setup(t); h.a.initialize(); mount(h); await settle();
  await press(h, 'manage');
  assert.equal(h.sent('GET', '/arr/admin/manage?').length, 1);
  assert.ok(drawer(h));
});

test('controls: the native Manage drawer (no operation) still reads after navigating while feedPosition is out', async t => {
  const h = setup(t);
  const feed = h.holdFeed();
  const opened = h.JE.arrManage.open({ key: 'movie:tmdb:603' }, { operation: h.JE.NATIVE }); await settle();
  h.navigate();
  feed.resolve({ epoch: 'e1', cursor: 1 }); await settle(); await opened;
  assert.equal(h.sent('GET', '/arr/admin/manage?').length, 1, 'exactly as before');
  assert.ok(drawer(h));
});

// ---------------------------------------------------------------- Seerr's own request owners (inventory)

for (const [name, interrupt] of INTERRUPTS) {
  test(`Seerr request (More Info window): ${name} while open() awaits the title's details → no window`, async t => {
    const h = setup(t, { asks: false, seerrMoreInfo: true }); h.a.initialize(); mount(h); await settle();
    const details = h.hold('GET', '/jellyseerr/movie/603');
    await press(h, 'request');
    interrupt(h);
    details.resolve(); await settle();
    assert.equal(moreInfo(h), null);
  });
}

test('controls: Seerr request (More Info window) on the same route opens the window', async t => {
  const h = setup(t, { asks: false, seerrMoreInfo: true }); h.a.initialize(); mount(h); await settle();
  await press(h, 'request');
  assert.ok(moreInfo(h));
});

test('controls: the native More Info window (no operation) still opens after navigating while its details are out', async t => {
  const h = setup(t, { asks: false, seerrMoreInfo: true });
  const details = h.hold('GET', '/jellyseerr/movie/603');
  const opened = h.JE.jellyseerrMoreInfo.open(603, 'movie', undefined, h.JE.NATIVE); await settle();
  h.navigate();
  details.resolve(); await settle(); await opened;
  assert.ok(moreInfo(h), 'exactly as before');
});

for (const [name, end] of [['navigation', (h) => h.navigate()], ['remount/feature-off (the mount ends)', (_h, o) => o.end()], ['session switch', h => h.switchUser()]]) {
  test(`Seerr requestMedia for an operation: ${name} during override-rule evaluation → no POST /jellyseerr/request`, async t => {
    const h = setup(t);
    const o = operationOf(h);
    const rules = h.hold('GET', '/jellyseerr/overrideRule');
    const sent = h.JE.jellyseerrAPI.requestMedia(603, 'movie', {}, false, { id: 603, originalLanguage: 'en' }, null, { bound: h.JE.captureSubmitted(o.op).bound() });
    await settle();
    assert.equal(h.sent('GET', '/jellyseerr/overrideRule').length, 1, 'the rules are read first');
    end(h, o);
    rules.resolve(); await assert.rejects(sent, e => e?.name === 'AbortError'); await settle();
    assert.equal(h.sent('POST', '/jellyseerr/request').length, 0);
  });

  test(`Seerr requestTvSeasons for an operation: ${name} during override-rule evaluation → no POST`, async t => {
    const h = setup(t);
    const o = operationOf(h);
    const rules = h.hold('GET', '/jellyseerr/overrideRule');
    const sent = h.JE.jellyseerrAPI.requestTvSeasons(1399, [1], {}, { id: 1399, originalLanguage: 'en' }, false, null, { bound: h.JE.captureSubmitted(o.op).bound() });
    await settle();
    end(h, o);
    rules.resolve(); await assert.rejects(sent, e => e?.name === 'AbortError'); await settle();
    assert.equal(h.sent('POST', '/jellyseerr/request').length, 0);
  });
}

test('controls: Seerr requestMedia for a current operation, and natively after navigating, posts once each', async t => {
  const h = setup(t);
  const o = operationOf(h);
  await h.JE.jellyseerrAPI.requestMedia(603, 'movie', {}, false, { id: 603, originalLanguage: 'en' }, null, { bound: h.JE.captureSubmitted(o.op).bound() });
  assert.equal(h.sent('POST', '/jellyseerr/request').length, 1);
  const rules = h.hold('GET', '/jellyseerr/overrideRule');
  const native = h.JE.jellyseerrAPI.requestMedia(603, 'movie', {}, false, { id: 603, originalLanguage: 'en' }); await settle();
  h.navigate();
  rules.resolve(); await native;
  assert.equal(h.sent('POST', '/jellyseerr/request').length, 2, 'natively exactly as before');
});

test('the shared Seerr modal opened for an operation: navigation, then its primary button → onSave never runs', async t => {
  const h = setup(t);
  const o = operationOf(h); let saved = 0;
  const modal = h.JE.jellyseerrModal.create({ title: 'x', subtitle: 'y', bodyHtml: '', onSave: () => { saved++; }, operation: o.op });
  modal.show(); await settle();
  h.navigate();
  modal.modalElement.querySelector('.jellyseerr-modal-button-primary').click(); await settle();
  assert.equal(saved, 0);
  const native = h.JE.jellyseerrModal.create({ title: 'x', subtitle: 'y', bodyHtml: '', onSave: () => { saved++; }, operation: h.JE.NATIVE });
  native.show(); await settle();
  native.modalElement.querySelector('.jellyseerr-modal-button-primary').click(); await settle();
  assert.equal(saved, 1, 'a native modal saves as before');
});

/** Seerr's season-selection modal (real, over the real modal shell) with its title reads held by `details`. */
function seasonSetup(t) {
  const h = setup(t);
  for (const file of ['seerr-status.js', 'ui/ui-icons.js', 'ui/ui-quota.js', 'ui/ui-season-modal.js']) h.load(`jellyseerr/${file}`);
  h.JE.internals.jellyseerrUi.markCardRequested = () => {};
  let details = null;
  Object.assign(h.JE.jellyseerrAPI, { fetchRequestSettings: async () => ({ partialRequestsEnabled: true, enableSpecialEpisodes: false }),
    fetchTvShowDetails: async () => { if (details) await details.promise; return { name: 'Show', seasons: [{ seasonNumber: 1, episodeCount: 3, airDate: '2020-01-01' }], externalIds: { tvdbId: 1 } }; },
    fetchSonarrLookup: async () => [], fetchUserQuota: async () => null, fetchTvSeasonDetails: async () => ({}) });
  return { ...h, holdDetails() { details = deferred(); return details; },
    modal: () => h.document.querySelector('.jellyseerr-season-modal'),
    async request() {
      const modal = h.document.querySelector('.jellyseerr-season-modal');
      modal.querySelector('.jellyseerr-season-checkbox[data-season-number="1"]').checked = true;
      modal.querySelector('.jellyseerr-modal-button-primary').click(); await settle();
    } };
}

for (const [name, end] of [['navigation', h => h.navigate()], ['remount/feature-off (the mount ends)', (_h, o) => o.end()], ['session switch', h => h.switchUser()]]) {
  test(`Seerr season modal for an operation: ${name} while the show's details are out → no modal`, async t => {
    const h = seasonSetup(t); const o = operationOf(h);
    const details = h.holdDetails();
    const opened = h.JE.jellyseerrUI.showSeasonSelectionModal(1399, 'tv', 'Show', null, false, o.op);
    await settle(); end(h, o); details.resolve(); await opened; await settle();
    assert.equal(h.modal(), null);
  });

  test(`Seerr season modal for an operation: ${name} while it is open, then Request → no POST`, async t => {
    const h = seasonSetup(t); const o = operationOf(h);
    await h.JE.jellyseerrUI.showSeasonSelectionModal(1399, 'tv', 'Show', null, false, o.op); await settle();
    assert.ok(h.modal(), 'the modal is open');
    end(h, o);
    if (h.modal()?.querySelector('.jellyseerr-season-checkbox[data-season-number="1"]')) await h.request();
    assert.equal(h.sent('POST', '/jellyseerr/request').length, 0);
  });
}

test('controls: the season modal for a current operation, and natively after navigating, requests once each', async t => {
  const h = seasonSetup(t); const o = operationOf(h);
  await h.JE.jellyseerrUI.showSeasonSelectionModal(1399, 'tv', 'Show', null, false, o.op); await settle();
  await h.request();
  assert.equal(h.sent('POST', '/jellyseerr/request').length, 1);
  h.modal()?.remove();
  const details = h.holdDetails();
  const opened = h.JE.jellyseerrUI.showSeasonSelectionModal(1399, 'tv', 'Show', null, false, h.JE.NATIVE); await settle();
  h.navigate(); details.resolve(); await opened; await settle();
  assert.ok(h.modal(), 'natively the modal still opens');
  await h.request();
  assert.equal(h.sent('POST', '/jellyseerr/request').length, 2, 'and requests, exactly as before');
});
