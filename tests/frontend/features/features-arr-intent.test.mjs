// Requests & downloads: intent tokens for remote lists (JE.arrIntent) — the helper itself, and the
// lists that use it: the legacy Requests/Downloads page data layer (the admin Downloads tab) and the
// admin tabs' reads. Every interleaving answers through its own deferred, in the order the test picks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as wait } from 'node:timers/promises';
import { createHarness, deferred, plain } from '../helpers/harness.mjs';

function helper(t, session) {
  const h = createHarness({ JE: session === undefined ? {} : { session } });
  t.after(() => h.close());
  h.load('arr/live/arr-intent.js');
  return h.JE.arrIntent;
}

test('a token is current only while it is the newest of its list', t => {
  const I = helper(t);
  const list = I.create('list');
  const a = list.next({ page: 1 });
  assert.equal(list.current(a), true);
  const b = list.next({ page: 1 });
  assert.equal(list.current(a), false, 'a newer read of the same page wins');
  assert.equal(list.current(b), true);
  list.invalidate();
  assert.equal(list.current(b), false, 'invalidate() makes every outstanding token stale');
  assert.equal(list.current(null), false);
  assert.equal(list.current({}), false);
  // Lists are independent.
  const other = I.create('other');
  const c = other.next();
  list.next();
  assert.equal(other.current(c), true);
  assert.ok(Object.isFrozen(c));
  assert.equal(c.name, 'other');
});

test('with an intent function a token goes stale when what is asked changes, even with no newer read', t => {
  const I = helper(t);
  const asked = { tab: 'history', q: 'dune', filter: 'failed', page: 2 };
  const list = I.create('history', { intent: () => ({ ...asked }) });
  const token = list.next();
  assert.deepEqual(token.parts, asked);
  asked.page = 3;
  assert.equal(list.current(token), false);
  asked.page = 2;
  assert.equal(list.current(token), true, 'asking for the same again makes it current again');
  asked.q = 'dune ';
  assert.equal(list.current(token), false);
});

test('a token goes stale when someone else signs in (session epoch)', t => {
  let epoch = 4;
  const I = helper(t, { getEpoch: () => epoch, isCurrent: e => e === epoch });
  const list = I.create('x');
  const token = list.next();
  assert.equal(token.epoch, 4);
  epoch = 5;
  assert.equal(list.current(token), false);
  // Without isCurrent the epoch is compared directly; without a session every epoch is the same.
  let plainEpoch = 1;
  const I2 = helper(t, { getEpoch: () => plainEpoch });
  const l2 = I2.create('y');
  const t2 = l2.next();
  plainEpoch = 2;
  assert.equal(l2.current(t2), false);
  const I3 = helper(t);
  const l3 = I3.create('z');
  assert.equal(l3.current(l3.next()), true);
});

test('intent keys ignore key order and undefined members but not values or types', t => {
  const I = helper(t);
  assert.equal(I.key({ page: 2, q: 'x' }), I.key({ q: 'x', page: 2 }));
  assert.equal(I.key({ q: 'x', instance: undefined }), I.key({ q: 'x' }));
  assert.equal(I.key({ a: { y: 1, x: 2 } }), I.key({ a: { x: 2, y: 1 } }));
  assert.notEqual(I.key({ page: 2 }), I.key({ page: '2' }));
  assert.notEqual(I.key([1, 2]), I.key([2, 1]));
  assert.equal(I.key(null), '');
  assert.equal(I.key(undefined), '');
  assert.equal(I.create('k').key, I.key);
});

test('the helper loads quietly: no network, no timers, nothing on the page', t => {
  const h = createHarness({ JE: {} });
  t.after(() => h.close());
  const before = h.document.documentElement.outerHTML;
  h.load('arr/live/arr-intent.js');
  assert.equal(typeof h.JE.arrIntent.create, 'function');
  assert.equal(h.document.documentElement.outerHTML, before);
});

// ------------------------------------------------------------------ the Requests/Downloads page data layer

function downloads(t, { ajax } = {}) {
  let epoch = 0;
  const changed = [];
  const waits = [];
  const h = createHarness({
    JE: {
      pluginConfig: { JellyseerrEnabled: true, DownloadsPageShowIssues: true, DownloadsShowHistory: true },
      helpers: {}, t: key => key, toast: () => {},
      session: { getEpoch: () => epoch, isCurrent: e => e === epoch, onUserChange: (_key, fn) => changed.push(fn) },
      core: { api: { plugin: (path) => { const d = deferred(); waits.push({ path, d }); return d.promise; } } }
    },
    apiClient: { ajax: ajax || (() => { const d = deferred(); waits.push({ path: 'ajax', d }); return d.promise; }), getUrl: (path, params) => 'http://jellyfin.test' + path + (params ? '?' + new URLSearchParams(params) : '') }
  });
  t.after(() => h.close());
  h.load('arr/live/arr-intent.js');
  h.load('arr/requests/requests-page-data.js');
  const P = h.JE.internals.requestsPage;
  P.renderPage = () => {};
  return { ...h, P, waits, read: prefix => waits.filter(w => w.path.startsWith(prefix)), switchUser: () => { epoch++; changed.forEach(fn => fn()); } };
}

test('downloads: a read from before a user switch publishes nothing for the next person, on every list', async t => {
  const h = downloads(t);
  const queue = h.P.fetchDownloads();
  const requests = h.P.fetchRequests();
  const history = h.P.fetchHistory();
  h.switchUser();
  h.read('/arr/queue')[0].d.resolve({ items: [{ id: 'old-q' }] });
  h.read('/arr/requests')[0].d.resolve({ requests: [{ id: 'old-r' }], canApproveRequests: true });
  h.read('/arr/history')[0].d.resolve({ items: [{ id: 'old-h' }], visible: true });
  assert.deepEqual([await queue, await requests, await history], [null, null, null]);
  assert.deepEqual([plain(h.P.state.downloads), plain(h.P.state.requests), plain(h.P.state.history)], [[], [], []]);
  assert.equal(h.P.state.canApproveRequests, false);
});

test('downloads: a poll still reading page 1 never overwrites the issues page 2 the user opened, nor a filter its newer filter', async t => {
  const lists = [];
  const h = downloads(t, { ajax: options => { const d = deferred(); lists.push({ url: options.url, d }); return d.promise; } });
  const poll = h.P.fetchIssues();
  h.P.state.issuesPage = 2;
  const next = h.P.fetchIssues();
  lists[1].d.resolve({ results: [], pageInfo: { pages: 4 } });
  await next;
  lists[0].d.resolve({ results: [{ id: 1 }], pageInfo: { pages: 9 } });
  assert.equal(await poll, null);
  assert.equal(h.P.state.issuesTotalPages, 4);
  assert.match(lists[1].url, /skip=/);
  // A filter's late answer never lands on the newer filter.
  const open = h.P.fetchIssues();
  h.P.state.issuesFilter = 'resolved';
  const resolved = h.P.fetchIssues();
  lists[3].d.resolve({ results: [], pageInfo: { pages: 1 } });
  await resolved;
  lists[2].d.resolve({ results: [{ id: 7 }], pageInfo: { pages: 2 } });
  await open;
  assert.deepEqual(plain(h.P.state.issues), []);
  assert.equal(h.P.state.issuesTotalPages, 1);
});

test('downloads: a list switched off while it was read never comes back', async t => {
  const lists = [];
  const h = downloads(t, { ajax: options => { const d = deferred(); lists.push({ url: options.url, d }); return d.promise; } });
  const issues = h.P.fetchIssues();
  const history = h.P.fetchHistory();
  h.JE.pluginConfig.DownloadsPageShowIssues = false;
  h.JE.pluginConfig.DownloadsShowHistory = false;
  assert.equal(await h.P.fetchIssues(), null);
  assert.equal(await h.P.fetchHistory(), null);
  lists[0].d.resolve({ results: [{ id: 3 }], pageInfo: { pages: 2 } });
  h.read('/arr/history')[0].d.resolve({ items: [{ id: 'h' }], visible: true });
  await issues;
  await history;
  assert.deepEqual([plain(h.P.state.issues), plain(h.P.state.history)], [[], []]);
  assert.equal(h.P.state.historyVisible, false);
});

test('downloads: the requests filter changed while a read ran (no newer read) publishes nothing', async t => {
  const h = downloads(t);
  const run = h.P.fetchRequests();
  h.P.state.requestsFilter = 'pending';
  h.read('/arr/requests')[0].d.resolve({ requests: [{ id: 'all-filter' }], totalPages: 2 });
  assert.equal(await run, null);
  assert.deepEqual(plain(h.P.state.requests), []);
});

// ------------------------------------------------------------------ the admin tabs' reads

test('admin tabs: reloads that arrive during a read make exactly one trailing read', async t => {
  const reads = [];
  const h = createHarness({
    html: '<div id="panel"></div>',
    JE: {
      t: key => key,
      session: { getEpoch: () => 0, isCurrent: () => true, onUserChange: () => {} },
      core: { api: { plugin: (path) => { const d = deferred(); reads.push({ path, d }); return d.promise; } } }
    }
  });
  t.after(() => { h.JE.internals.arrHub.admin.leave(); h.close(); });
  for (const m of ['arr/live/arr-intent.js', 'arr/admin/admin-render.js', 'arr/admin/admin-tabs.js']) h.load(m);
  const A = h.JE.internals.arrHub.admin;
  A.renderOverview = (panel, data) => { panel.textContent = data.label; };
  A.render(h.document.getElementById('panel'), 'overview');
  assert.equal(reads.length, 1);
  // Three changes announced while the first read runs (feed, an action's outcome, Try again).
  const done = A.refresh();
  A.refresh();
  A.refresh();
  assert.equal(reads.length, 1, 'no second read at the same time');
  reads[0].d.resolve({ label: 'first' });
  await wait(5);
  assert.equal(reads.length, 2, 'one read after it');
  reads[1].d.resolve({ label: 'second' });
  await done;
  await wait(5);
  assert.equal(reads.length, 2, 'and only one');
  assert.equal(h.document.getElementById('panel').textContent, 'second');
  // With nothing announced during a read, none follows.
  const quiet = A.refresh();
  reads[2].d.resolve({ label: 'third' });
  await quiet;
  await wait(5);
  assert.equal(reads.length, 3);
});

test('admin tabs: leaving the tabs drops the answer of a read under way and its trailing read', async t => {
  const reads = [];
  const h = createHarness({
    html: '<div id="panel"></div>',
    JE: {
      t: key => key,
      session: { getEpoch: () => 0, isCurrent: () => true, onUserChange: () => {} },
      core: { api: { plugin: (path) => { const d = deferred(); reads.push({ path, d }); return d.promise; } } }
    }
  });
  t.after(() => { h.JE.internals.arrHub.admin.leave(); h.close(); });
  for (const m of ['arr/live/arr-intent.js', 'arr/admin/admin-render.js', 'arr/admin/admin-tabs.js']) h.load(m);
  const A = h.JE.internals.arrHub.admin;
  A.renderOverview = (panel, data) => { panel.textContent = data.label; };
  A.render(h.document.getElementById('panel'), 'overview');
  A.refresh();
  A.leave();
  reads[0].d.resolve({ label: 'late' });
  await wait(10);
  assert.equal(reads.length, 1);
  assert.equal(A.state.data.overview, undefined);
});
