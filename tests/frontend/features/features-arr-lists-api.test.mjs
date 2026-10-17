// Phase 4c1: the client transport of Requests & downloads lists (JE.arrLists). No network on load; one request id per
// action (retries reuse it); list views revalidated with their ETag; answers after a user switch are dropped; every
// mutation's view is announced to listeners; a request confirmation refreshes the shared status.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/harness.mjs';

/** A fetch fixture: answers from `routes` (url suffix -> handler) and records every call. */
function fixture(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    const path = String(url).replace('http://jellyfin.test/JellyfinEnhanced/acquire/lists', '');
    const handler = routes[`${init.method || 'GET'} ${path}`];
    if (!handler) throw new Error(`unexpected ${init.method || 'GET'} ${path}`);
    const { status = 200, body = null, etag = null } = await handler(init);
    return { status, headers: { get: name => (name === 'ETag' ? etag : null) }, text: async () => (body == null ? '' : JSON.stringify(body)) };
  };
  return { fetch, calls };
}

function lists(t, routes, { config = { ArrListsEnabled: true }, JE = {} } = {}) {
  const net = fixture(routes);
  const state = { epoch: 1 };
  const h = createHarness({ fetch: net.fetch, JE: { pluginConfig: config, session: { getEpoch: () => state.epoch }, ...JE } });
  t.after(() => h.close());
  h.load('arr/lists/list-api.js');
  return { ...h, net, state, api: h.JE.arrLists };
}

const view = (rev, extra = {}) => ({ listId: 'l1', listKind: 'playlist', rev, placeholders: [], order: [], actions: [], ...extra });

test('loading makes no request and exposes the transport; enabled follows the server flag', t => {
  const h = lists(t, {});
  assert.equal(h.net.calls.length, 0);
  assert.equal(h.api.enabled(), true);
  const off = lists(t, {}, { config: { ArrListsEnabled: false } });
  assert.equal(off.api.enabled(), false);
});

test('request ids are new per action and valid for the server', t => {
  const h = lists(t, {});
  const a = h.api.newRequestId();
  const b = h.api.newRequestId();
  assert.notEqual(a, b);
  for (const id of [a, b]) assert.match(id, /^[A-Za-z0-9_-]{1,64}$/);
});

test('a view is revalidated with its ETag: an unchanged list returns the cached view', async t => {
  let seen = null;
  const h = lists(t, {
    'GET /l1': init => {
      seen = init.headers['If-None-Match'] ?? null;
      return seen ? { status: 304 } : { body: view(3), etag: '"e1"' };
    },
  });
  const first = await h.api.getList('l1');
  assert.equal(first.body.rev, 3);
  assert.equal(seen, null);
  const second = await h.api.getList('l1');
  assert.equal(seen, '"e1"');
  assert.equal(second.status, 200);
  assert.equal(second.body.rev, 3);
  assert.equal(h.net.calls[0].init.headers.Authorization, 'MediaBrowser Token="test-token"');
});

test('a mutation announces the new view (also a 409 with a fresh view) and forgets the cached one', async t => {
  const h = lists(t, {
    'GET /l1': () => ({ body: view(3), etag: '"e1"' }),
    'POST /l1/items': () => ({ body: { added: ['p1'], addedAsItems: [], skipped: [], view: view(4) } }),
    'PUT /l1/order': () => ({ status: 409, body: { error: true, code: 'rev_conflict', view: view(5) } }),
  });
  const seen = [];
  const off = h.api.onChange((id, v) => seen.push([id, v?.rev]));
  await h.api.getList('l1');
  const added = await h.api.addItems('l1', { requestId: 'r1', placeholders: [{ kind: 'movie', tmdbId: 1, title: 'x' }] });
  assert.deepEqual([...added.body.added], ['p1']);
  assert.equal(JSON.parse(h.net.calls[1].init.body).requestId, 'r1');
  const conflict = await h.api.reorder('l1', { requestId: 'r2', rev: 3, order: [] });
  assert.equal(conflict.status, 409);
  assert.deepEqual(seen, [['l1', 4], ['l1', 5]]);
  off();
  // The cached view was dropped: the next read sends no stale ETag.
  await h.api.getList('l1');
  assert.equal(h.net.calls.at(-1).init.headers['If-None-Match'], undefined);
});

test('remove sends rev and the request id in the query; ids are encoded', async t => {
  const h = lists(t, { 'DELETE /l%201/items/p%2F1?rev=7&requestId=r%261': () => ({ body: view(8) }) });
  const answer = await h.api.removeItem('l 1', 'p/1', { rev: 7, requestId: 'r&1' });
  assert.equal(answer.status, 200);
});

test('an answer that arrives after a user switch is dropped and nobody is told', async t => {
  let release;
  const h = lists(t, { 'POST /l1/apply': () => new Promise(done => { release = () => done({ body: { added: [], addedAsItems: [], skipped: [], view: view(9) } }); }) });
  const seen = [];
  h.api.onChange(() => seen.push(1));
  const pending = h.api.apply('l1', { requestId: 'r1', entries: [] });
  await new Promise(done => setImmediate(done));
  h.state.epoch = 2;
  release();
  await assert.rejects(pending, error => error.stale === true);
  assert.equal(seen.length, 0);
});

test('a request confirmation refreshes the shared status; a preview writes nothing and tells nobody', async t => {
  let refreshed = 0;
  const h = lists(t, {
    'POST /l1/requests/preview': () => ({ body: { items: [], askable: 0, cost: 0, maxBatch: 20 } }),
    'POST /l1/requests': () => ({ body: { operationId: 'op', replayed: false, results: [], view: view(2) } }),
  }, { JE: { arrStatus: { refresh: () => { refreshed++; } } } });
  const seen = [];
  h.api.onChange((id, v) => seen.push(v?.rev));
  const preview = await h.api.previewRequests('l1', { all: true });
  assert.equal(preview.body.maxBatch, 20);
  assert.equal(refreshed, 0);
  assert.deepEqual(seen, []);
  await h.api.requestEntries('l1', { clientId: 'c1', placeholderIds: ['p1'] });
  assert.equal(refreshed, 1);
  assert.deepEqual(seen, [2]);
});
